import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { getLlmFailureAudit, LlmRequestStartGate } from "../llm";
import {
  FairLlmRequestScheduler,
  type LlmStageFailureKind
} from "../llm-scheduler";
import { hashCanonicalValue } from "./evidence";
import {
  reviewFlowStageJsonSchemas,
  reviewFlowStageOutputBudgets,
  type FourCallRequest,
  type ReviewFlowCompletedStage,
  type ReviewFlowCompletedStages,
  type ReviewFlowDagStage
} from "./four-call";
import {
  runProductionFourCallReviewDag,
  type FourCallRequestLifecycle,
  type FourCallSafeRequestFailure,
  type FourCallSafeRequestTiming
} from "./four-call-runtime";
import {
  reviewFlowCalibrationOutcomeSchema,
  type ReviewFlowCalibrationOutcome,
  type ReviewFlowFailureKind
} from "./orchestrator";
import {
  reviewFlowRoleSchema,
  type ReviewFlowRole
} from "./schemas";
import type { DifficultyAnchor } from "../pipelines/difficulty";
import {
  legacyDevelopmentDiagnosticPlannedRunContract,
  parseDevelopmentDiagnosticPlannedRunContract,
  type DevelopmentDiagnosticPlannedRunContract
} from "./development-diagnostic-run-contract";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const diagnosticSlotSchema = z.enum(["slot-01", "slot-02"]);

export type DevelopmentDiagnosticSlot = z.infer<typeof diagnosticSlotSchema>;

export const expectedDiagnosticSlots: readonly DevelopmentDiagnosticSlot[] = Object.freeze([
  "slot-01",
  "slot-02"
]);
const diagnosticSlotSet = new Set<DevelopmentDiagnosticSlot>(expectedDiagnosticSlots);

const expectedDiagnosticModels: Readonly<
  Record<ReviewFlowDagStage, "deepseek-v4-pro" | "deepseek-v4-flash">
> = Object.freeze({
  A: "deepseek-v4-pro",
  B: "deepseek-v4-pro",
  C: "deepseek-v4-pro",
  D: "deepseek-v4-pro",
  formatter: "deepseek-v4-flash"
});


/**
 * 将 11 角色映射到 A/B/C/D 四阶段。
 * A=solver; B=difficulty; C=solution_analyst+technical_auditor+editorial_judge+
 * contest_fit+originality+tags+critic+adversary; D=adjudicator。
 */
const roleToStageMap: Readonly<Record<ReviewFlowRole, ReviewFlowDagStage>> = Object.freeze({
  solver: "A",
  difficulty: "B",
  solution_analyst: "C",
  technical_auditor: "C",
  editorial_judge: "C",
  contest_fit: "C",
  originality: "C",
  tags: "C",
  critic: "C",
  adversary: "C",
  adjudicator: "D"
});

function roleToStage(role: ReviewFlowRole): ReviewFlowDagStage {
  return roleToStageMap[role];
}

/**
 * 将编排器的 ReviewFlowFailureKind 映射为调度器的 LlmStageFailureKind，
 * 使 recordFailure 的 soft-stop 逻辑能复用已有的分类原语。
 */
function mapFailureKind(kind: ReviewFlowFailureKind): LlmStageFailureKind {
  switch (kind) {
    case "service_http": return "server_error";
    case "transport": return "connect";
    case "timeout": return "first_byte_timeout";
    case "output_limit": return "output_limit";
    case "schema_output": return "schema_invalid";
    case "cancelled":
    case "content_filtered":
    case "protocol":
    case "role_internal":
    case "input_invalid":
    case "validation":
      return "permanent";
    default:
      return "permanent";
  }
}

function classifyTerminalRoleFailure(
  failureKind: ReviewFlowFailureKind,
  error: unknown
): LlmStageFailureKind {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : "";
  const auditStatus = getLlmFailureAudit(error)?.terminal.status;
  const errorStatus = typeof error === "object" && error !== null && "status" in error &&
      typeof (error as { readonly status?: unknown }).status === "number"
    ? (error as { readonly status: number }).status
    : null;
  const status = auditStatus ?? errorStatus;
  if (code === "LLM_HTTP_ERROR") {
    return status === 429 ? "rate_limited" : "server_error";
  }
  if (code === "LLM_NETWORK_FAILED") return "connect";
  if (code === "LLM_FIRST_OUTPUT_TIMEOUT") return "first_byte_timeout";
  if (code === "LLM_OUTPUT_IDLE_TIMEOUT" || code === "LLM_TOTAL_TIMEOUT") {
    return "no_progress_timeout";
  }
  if (code === "LLM_STREAM_INTERRUPTED") return "stream_interrupted";
  return mapFailureKind(failureKind);
}
/**
 * 2×4 诊断配置：恰好 2 个固定槽位、每个槽位 A/B/C/D 四阶段（格式化器仅按需），
 * 不参与最终准确率标定，不含 Phase1 概念。
 */
export const developmentDiagnosticProfileSchema = z
  .object({
    name: z.literal("development-diagnostic-2x4-v1"),
    anonymousSlotCount: z.literal(2),
    semanticRequestsPerSlot: z.literal(4),
    maximumFormatterRequestsPerSlot: z.literal(1),
    maximumAttemptsPerLogicalRequest: z.literal(1),
    maximumAttemptsPerCase: z.literal(5),
    maximumWholeCaseRetries: z.literal(0),
    maximumTotalLogicalRequests: z.literal(10),
    maximumTotalExternalAttempts: z.literal(52),
    maximumConcurrency: z.literal(4),
    firstValidOutputTimeoutMs: z.literal(600_000),
    outputIdleTimeoutMs: z.literal(600_000),
    healthyStreamWallClockTimeoutMs: z.null(),
    preFirstOutputFallbackMs: z.literal(1_800_000),
    softStopBudgetMs: z.literal(60 * 60_000),
    allowedExternalService: z.literal("configured_aether_deepseek"),
    allowYuantiji: z.literal(false),
    allowCodeforces: z.literal(false),
    allowWeb: z.literal(false),
    legacy31MinuteObservationUnit: z.literal("UNKNOWN"),
    includeInFinalCalibration: z.literal(false)
  })
  .strict();

export type DevelopmentDiagnosticProfile = z.infer<
  typeof developmentDiagnosticProfileSchema
>;

export const developmentDiagnosticProfile: DevelopmentDiagnosticProfile = Object.freeze({
  name: "development-diagnostic-2x4-v1",
  anonymousSlotCount: 2,
  semanticRequestsPerSlot: 4,
  maximumFormatterRequestsPerSlot: 1,
  maximumAttemptsPerLogicalRequest: 1,
  maximumAttemptsPerCase: 5,
  maximumWholeCaseRetries: 0,
  maximumTotalLogicalRequests: 10,
  maximumTotalExternalAttempts: 52,
  maximumConcurrency: 4,
  firstValidOutputTimeoutMs: 600_000,
  outputIdleTimeoutMs: 600_000,
  healthyStreamWallClockTimeoutMs: null,
  preFirstOutputFallbackMs: 1_800_000,
  softStopBudgetMs: 60 * 60_000,
  allowedExternalService: "configured_aether_deepseek",
  allowYuantiji: false,
  allowCodeforces: false,
  allowWeb: false,
  legacy31MinuteObservationUnit: "UNKNOWN",
  includeInFinalCalibration: false
});

export const developmentDiagnosticProfileFingerprint = hashCanonicalValue(
  developmentDiagnosticProfile
);

export const developmentDiagnosticAggregateBudgetReceipt = Object.freeze({
  schemaVersion: 1 as const,
  profileName: developmentDiagnosticProfile.name,
  profileFingerprint: developmentDiagnosticProfileFingerprint,
  semanticLogicalRequestCeiling: 8 as const,
  formatterLogicalRequestCeiling: 2 as const,
  totalLogicalRequestCeiling: 10 as const,
  providerTransportCeiling: 52 as const,
  semanticOutputTokenCeiling: 456_000 as const,
  formatterOutputTokenCeiling: 16_000 as const,
  totalOutputTokenCeiling: 472_000 as const
});

const manifestSlotSchema = z
  .object({
    slot: diagnosticSlotSchema,
    sourceBinding: digestSchema,
    truthBindingHash: digestSchema
  })
  .strict();

export const developmentDiagnosticManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    profileName: z.literal("development-diagnostic-2x4-v1"),
    profileFingerprint: z.literal(developmentDiagnosticProfileFingerprint),
    slots: z.array(manifestSlotSchema).min(1).max(2)
  })
  .strict()
  .superRefine((value, context) => {
    const canonicalSlots = [...value.slots]
      .map((entry) => entry.slot)
      .sort(
        (left, right) =>
          expectedDiagnosticSlots.indexOf(left) - expectedDiagnosticSlots.indexOf(right)
      );
    if (
      new Set(value.slots.map((entry) => entry.slot)).size !== value.slots.length ||
      value.slots.some((entry, index) => entry.slot !== canonicalSlots[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["slots"],
        message: "manifest slots must be unique and canonical"
      });
    }
  });

export type DevelopmentDiagnosticManifest = z.infer<
  typeof developmentDiagnosticManifestSchema
>;

export interface DevelopmentDiagnosticManifestSummary {
  readonly manifestFingerprint: string;
  readonly slotCount: number;
  readonly slotBindings: Readonly<Record<DevelopmentDiagnosticSlot, {
    readonly sourceBinding: string;
    readonly truthBindingHash: string;
  }>>;
}

export function parseDevelopmentDiagnosticProfile(
  candidate: unknown
): DevelopmentDiagnosticProfile {
  return developmentDiagnosticProfileSchema.parse(candidate);
}

export function parseDevelopmentDiagnosticManifest(
  candidate: unknown
): DevelopmentDiagnosticManifest {
  return developmentDiagnosticManifestSchema.parse(candidate);
}

export function summarizeDevelopmentDiagnosticManifest(
  manifest: DevelopmentDiagnosticManifest
): DevelopmentDiagnosticManifestSummary {
  const slotBindings: Record<string, { sourceBinding: string; truthBindingHash: string }> = {};
  for (const entry of manifest.slots) {
    slotBindings[entry.slot] = {
      sourceBinding: entry.sourceBinding,
      truthBindingHash: entry.truthBindingHash
    };
  }
  return Object.freeze({
    manifestFingerprint: hashCanonicalValue(manifest),
    slotCount: manifest.slots.length,
    slotBindings: Object.freeze(slotBindings)
  });
}


export interface DevelopmentDiagnosticSafeRequestReceipt {
  readonly schemaVersion: 1;
  readonly profileName: "development-diagnostic-2x4-v1";
  readonly profileFingerprint: string;
  readonly manifestFingerprint: string;
  readonly runBindingHash: string;
  readonly anonymousSlot: DevelopmentDiagnosticSlot;
  readonly stage: ReviewFlowDagStage;
  readonly provider: "aether";
  readonly model: "deepseek-v4-pro" | "deepseek-v4-flash";
  readonly modelFingerprint: string;
  readonly schemaFingerprint: string;
  readonly maxOutputTokens: 32_000 | 8_000 | 24_000 | 12_000;
  readonly thinkingRequest: "enabled";
  readonly reasoningEffort: "max";
  readonly logicalAttempt: 1;
  readonly logicalRequestsUsed: number;
  readonly logicalRequestCeiling: number;
  readonly externalAttemptsUsed: number;
  readonly externalAttemptCeiling: number;
}

export type DevelopmentDiagnosticStopReason =
  | "output_limit"
  | "schema_invalid"
  | "final_failure"
  | "repeated_system_error"
  | "soft_stop_budget"
  | "attempt_ceiling"
  | "manual";

export interface DevelopmentDiagnosticBudgetReceipt {
  readonly schemaVersion: 1;
  readonly profileName: "development-diagnostic-2x4-v1";
  readonly profileFingerprint: string;
  readonly observedBaselineMs: 286_749;
  readonly observedP90Ms: 587_463;
  readonly conservativeMs: 1_150_315;
  readonly expectedUtcStart: string;
  readonly expectedUtcEnd: string;
  readonly logicalRequestCeiling: number;
  readonly providerTransportCeiling: number;
  readonly plannedPeakConcurrency: number;
  readonly plannedWaves: readonly { readonly wave: number; readonly maxConcurrency: number }[];
  readonly completedByStage: Readonly<Record<string, number>>;
  readonly inflightByStage: Readonly<Record<string, number>>;
  readonly failedByStage: Readonly<Record<string, number>>;
  readonly notStartedByStage: Readonly<Record<string, number>>;
  readonly avgConcurrency: number;
  readonly peakConcurrency: number;
}

export interface DevelopmentDiagnosticCheckpoint {
  readonly schemaVersion: 1;
  readonly profileFingerprint: string;
  readonly manifestFingerprint: string;
  readonly runBindingHash: string;
  readonly logicalRequestsUsed: number;
  readonly externalAttemptsUsed: number;
  readonly completedRequestCount: number;
  readonly completedSlotCount: number;
  readonly stopped: boolean;
  readonly stopReason: DevelopmentDiagnosticStopReason | null;
  readonly firstFailureKind: LlmStageFailureKind | null;
  readonly status: "INCOMPLETE" | "DIAGNOSTIC";
  readonly accuracyClaim: null;
  readonly includedInFinalCalibration: false;
}

export type DevelopmentDiagnosticLifecycleErrorCategory =
  | "connect"
  | "first_byte_timeout"
  | "no_progress_timeout"
  | "output_limit"
  | "stream_interrupted"
  | "schema_invalid"
  | "rate_limited"
  | "server_error"
  | "permanent";

export type DevelopmentDiagnosticLifecycleEvent =
  | {
      readonly type: "transport_intent" | "transport_reserved";
      readonly sequence: number;
      readonly role: ReviewFlowRole;
      readonly modelFingerprint: string;
      readonly attempt: 1 | 2;
    }
  | {
      readonly type: "transport_started" | "transport_first_output";
      readonly sequence: number;
    }
  | {
      readonly type: "transport_settled";
      readonly sequence: number;
      readonly outcome: "succeeded" | "retryable_failed" | "failed";
      readonly errorCategory: DevelopmentDiagnosticLifecycleErrorCategory | null;
    }
  | {
      readonly type: "role_completed" | "role_failed";
      readonly slot: DevelopmentDiagnosticSlot;
      readonly role: ReviewFlowRole;
      readonly errorCategory?: DevelopmentDiagnosticLifecycleErrorCategory;
    }
  | {
      readonly type: "stage_completed" | "stage_failed";
      readonly slot: DevelopmentDiagnosticSlot;
      readonly stage: ReviewFlowDagStage;
    }
  | {
      readonly type: "slot_outcome";
      readonly slot: DevelopmentDiagnosticSlot;
      readonly status: "complete" | "incomplete";
    };

/**
 * 真正的传输前派发门：作为 `onTransportDispatch` 钩子接入生产 LLM 传输路径，
 * 在 `requestWithRetry` 每次实际 fetch 前同步调用。已达上限或已关闭时抛出
 * `Error("TRANSPORT_GATE_DENIED")`，由 `requestWithRetry` 的 try/catch 转为
 * `LlmRequestError("LLM_TRANSPORT_DENIED")`，fail closed 且不发起 fetch。
 * 与逻辑收据计数分离——一次逻辑请求可能产生多次传输（例如内部重试）。
 */
export class TransportPreDispatchGate {
  #used = 0;
  readonly ceiling: number;
  readonly #startGate: LlmRequestStartGate;
  #closed = false;

  public constructor(ceiling: number, startGate: LlmRequestStartGate) {
    if (!Number.isSafeInteger(ceiling) || ceiling < 1) {
      throw new Error("TRANSPORT_GATE_CEILING_INVALID");
    }
    this.ceiling = ceiling;
    this.#startGate = startGate;
  }

  /**
   * 作为 `onTransportDispatch` 钩子：在任何可能计费的 fetch 前同步调用。
   * 成功时无返回值（已预留），已达上限或已关闭时抛出 `Error("TRANSPORT_GATE_DENIED")`。
   * 语义与 `LlmRuntimeOptions.onTransportDispatch` 的拒绝契约一致：
   * 抛错即阻止本次 fetch，由 `requestWithRetry` 转为 `LlmRequestError("LLM_TRANSPORT_DENIED")`。
   */
  public reserveOrThrow(): void {
    if (this.#closed || !this.#startGate.canStartRequest()) {
      throw new Error("TRANSPORT_GATE_DENIED");
    }
    if (this.#used >= this.ceiling) {
      throw new Error("TRANSPORT_GATE_DENIED");
    }
    this.#used += 1;
  }

  /** 返回当前已预留的传输次数。 */
  public get used(): number {
    return this.#used;
  }

  /** 关闭门：后续 `reserveOrThrow` 一律抛错。 */
  public close(): void {
    this.#closed = true;
  }
}

export class DevelopmentDiagnosticRunController {
  readonly profile = developmentDiagnosticProfile;
  readonly manifest: DevelopmentDiagnosticManifest;
  readonly plannedRun: DevelopmentDiagnosticPlannedRunContract;
  readonly manifestSummary: DevelopmentDiagnosticManifestSummary;
  readonly requestStartGate = new LlmRequestStartGate();
  readonly transportGate: TransportPreDispatchGate;

  readonly #runBindingHash: string;
  readonly #scheduler: FairLlmRequestScheduler;
  readonly #safeReceiptSink: (receipt: DevelopmentDiagnosticSafeRequestReceipt) => void;
  readonly #safeCompletionSink: (
    slot: DevelopmentDiagnosticSlot,
    stage: ReviewFlowDagStage,
    timing: FourCallSafeRequestTiming
  ) => void;
  readonly #safeFailureSink: (
    slot: DevelopmentDiagnosticSlot,
    stage: ReviewFlowDagStage,
    failure: FourCallSafeRequestFailure
  ) => void;
  readonly #authorized = new Map<string, DevelopmentDiagnosticSafeRequestReceipt>();
  readonly #completed = new Map<string, FourCallSafeRequestTiming>();
  readonly #completedStages = new Set<string>();
  readonly #completedSlots = new Set<DevelopmentDiagnosticSlot>();
  readonly #failedStages = new Set<string>();
  #transportSequence = 0;
  #firstFailureKind: LlmStageFailureKind | null = null;
  readonly #startedAtMs: number;
  readonly #clock: () => number;
  #stopped = false;
  #stopReason: DevelopmentDiagnosticStopReason | null = null;
  // 角色级审计：从标定 outcome 收集 11 角色的完成/失败摘要。
  readonly #roleCompletions = new Map<DevelopmentDiagnosticSlot, Set<ReviewFlowRole>>();
  readonly #lifecycleSink:
    | ((event: DevelopmentDiagnosticLifecycleEvent) => Promise<void>)
    | undefined;
  #lifecycleTail: Promise<void> = Promise.resolve();
  #lifecycleError: unknown;
  readonly #transportContext = new AsyncLocalStorage<number>();
  readonly #firstOutputSequences = new Set<number>();
  readonly #roleFailures = new Map<DevelopmentDiagnosticSlot, Set<ReviewFlowRole>>();

  public constructor(input: {
    readonly profile: unknown;
    readonly manifest: unknown;
    readonly runBindingHash: string;
    readonly scheduler: FairLlmRequestScheduler;
    readonly safeReceiptSink?: (receipt: DevelopmentDiagnosticSafeRequestReceipt) => void;
    readonly safeCompletionSink?: (
      slot: DevelopmentDiagnosticSlot,
      stage: ReviewFlowDagStage,
      timing: FourCallSafeRequestTiming
    ) => void;
    readonly safeFailureSink?: (
      slot: DevelopmentDiagnosticSlot,
      stage: ReviewFlowDagStage,
      failure: FourCallSafeRequestFailure
    ) => void;
    readonly plannedRun?: unknown;
    readonly startedAtMs: number;
    readonly lifecycleSink?: (
      event: DevelopmentDiagnosticLifecycleEvent
    ) => Promise<void>;
    readonly clock?: () => number;
  }) {
    const parsedProfile = parseDevelopmentDiagnosticProfile(input.profile);
    if (hashCanonicalValue(parsedProfile) !== developmentDiagnosticProfileFingerprint) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_PROFILE_MISMATCH");
    }
    this.plannedRun = parseDevelopmentDiagnosticPlannedRunContract(
      input.plannedRun ?? legacyDevelopmentDiagnosticPlannedRunContract
    );
    this.manifest = parseDevelopmentDiagnosticManifest(input.manifest);
    this.manifestSummary = summarizeDevelopmentDiagnosticManifest(this.manifest);
    this.#runBindingHash = digestSchema.parse(input.runBindingHash);
    this.#scheduler = input.scheduler;
    this.#safeReceiptSink = input.safeReceiptSink ?? (() => undefined);
    if (!Number.isSafeInteger(input.startedAtMs) || input.startedAtMs < 0) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_STARTED_AT_INVALID");
    }
    this.#startedAtMs = input.startedAtMs;
    this.#safeFailureSink = input.safeFailureSink ?? (() => undefined);
    this.#clock = input.clock ?? Date.now;
    this.#safeCompletionSink = input.safeCompletionSink ?? (() => undefined);
    this.#lifecycleSink = input.lifecycleSink;
    if (this.#clock() < this.#startedAtMs) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_CLOCK_INVALID");
    }
    this.transportGate = new TransportPreDispatchGate(
      this.plannedRun.globalTransportAttemptCeiling,
      this.requestStartGate
    );
    this.#assertSchedulerProfile();
  }

  public scheduler(): FairLlmRequestScheduler {
    return this.#scheduler;
  }

  public lifecycle(): FourCallRequestLifecycle {
    return Object.freeze({
      beforeRequest: (request: FourCallRequest) => {
        this.authorizeRequest(request);
      },
      requestCompleted: (
        request: FourCallRequest,
        timing: FourCallSafeRequestTiming
      ) => {
        this.recordRequestCompleted(request, timing);
      },
      requestFailed: (
        request: FourCallRequest,
        failure: FourCallSafeRequestFailure
      ) => {
        this.#safeFailureSink(
          diagnosticSlotSchema.parse(request.caseId),
          request.stage,
          failure
        );
        this.recordFailure(failure.kind, request);
      }
    });
  }

  /**
   * 授权逻辑请求：检查阶段绑定、重试禁令、逻辑上限，并签发安全收据。
   * 与传输计数分离——authorizeRequest 签发逻辑收据，transportGate 计传输。
   */
  public authorizeRequest(
    request: FourCallRequest
  ): DevelopmentDiagnosticSafeRequestReceipt {
    this.applySoftStopGate(this.elapsedMs());
    this.#assertSchedulerProfile();
    if (this.#stopped || !this.requestStartGate.canStartRequest()) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_NEW_REQUESTS_CLOSED");
    }
    const slot = diagnosticSlotSchema.parse(request.caseId);
    if (!this.plannedRun.selectedSlots.includes(slot)) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_SLOT_INVALID");
    }
    if (request.attempt !== 1) throw new Error("DEVELOPMENT_DIAGNOSTIC_RETRY_FORBIDDEN");
    const requestKey = `${slot}:${request.stage}`;
    if (this.#authorized.has(requestKey)) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_DUPLICATE_REQUEST");
    }
    // 首次失败关闭全部新阶段：任意槽位任一阶段失败后，不再授权任何新阶段（含同槽位）。
    // 已启动的阶段/流自然排空，不中断。
    if (this.#failedStages.size > 0) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_FAILURE_GATE_CLOSED");
    }
    const attemptsForSlot = [...this.#authorized.keys()].filter((key) =>
      key.startsWith(`${slot}:`)
    ).length;
    const logicalRequestCeiling = this.plannedRun.selectedSlots.length * 5;
    if (attemptsForSlot >= this.profile.maximumAttemptsPerCase) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_CASE_ATTEMPT_LIMIT");
    }
    if (this.#authorized.size >= logicalRequestCeiling) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_TOTAL_REQUEST_LIMIT");
    }
    this.#assertRequestContract(request);
    const schemaFingerprint = request.schemaFingerprint!;
    const receipt: DevelopmentDiagnosticSafeRequestReceipt = deepFreeze({
      schemaVersion: 1 as const,
      profileName: this.profile.name,
      profileFingerprint: developmentDiagnosticProfileFingerprint,
      manifestFingerprint: this.manifestSummary.manifestFingerprint,
      runBindingHash: this.#runBindingHash,
      anonymousSlot: slot,
      stage: request.stage,
      provider: "aether" as const,
      model: expectedDiagnosticModels[request.stage],
      modelFingerprint: request.model.fingerprint,
      schemaFingerprint,
      maxOutputTokens: request.maxOutputTokens as DevelopmentDiagnosticSafeRequestReceipt["maxOutputTokens"],
      thinkingRequest: "enabled" as const,
      reasoningEffort: "max" as const,
      logicalAttempt: 1 as const,
      logicalRequestsUsed: this.#authorized.size + 1,
      logicalRequestCeiling,
      externalAttemptsUsed: this.transportGate.used + 1,
      externalAttemptCeiling: this.plannedRun.globalTransportAttemptCeiling
    });
    this.#safeReceiptSink(receipt);
    this.#authorized.set(requestKey, receipt);
    return receipt;
  }

  /**
   * Registers a transport intent and reservation synchronously. The durable lifecycle sink is
   * serialized and is awaited by dispatchTransport before the fetch closure can run.
   */
  public reserveTransportOrThrow(): void {
    this.applySoftStopGate(this.elapsedMs());
    this.transportGate.reserveOrThrow();
  }
  public async beforeTransport(input: {
    readonly role: ReviewFlowRole;
    readonly modelFingerprint: string;
    readonly attempt?: number;
  }): Promise<void> {
    return this.prepareTransportOrThrow(input);
  }

  public async prepareTransportOrThrow(input: {
    readonly role: ReviewFlowRole;
    readonly modelFingerprint: string;
    readonly attempt?: number;
  }): Promise<void> {
    this.reserveTransportOrThrow();
    const sequence = this.#transportContext.getStore();
    if (sequence === undefined) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_TRANSPORT_CONTEXT_MISSING");
    }
    const role = reviewFlowRoleSchema.parse(input.role);
    const modelFingerprint = digestSchema.parse(input.modelFingerprint);
    const requestedAttempt = input.attempt ?? 1;
    if (
      !Number.isSafeInteger(requestedAttempt) ||
      requestedAttempt < 1 ||
      requestedAttempt > this.plannedRun.maximumTransportAttemptsPerRequest
    ) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_TRANSPORT_RETRY_LIMIT");
    }
    const attempt = requestedAttempt as 1 | 2;
    this.#emitLifecycle({
      type: "transport_intent",
      sequence,
      role,
      modelFingerprint,
      attempt
    });
    this.#emitLifecycle({
      type: "transport_reserved",
      sequence,
      role,
      modelFingerprint,
      attempt
    });
    this.#emitLifecycle({ type: "transport_started", sequence });
    await this.flushLifecycleEvents();
  }

  /**
   * Holds the shared scheduler slot until the response body settles. All earlier lifecycle events,
   * including the durable dispatch-start checkpoint, must succeed before execute can reach fetch.
   */
  public async dispatchTransport<T>(execute: () => Promise<T>): Promise<T> {
    const sequence = ++this.#transportSequence;
    const transportId = sequence.toString().padStart(6, "0");
    const result = await this.#scheduler.runLogicalRequest({
      caseId: `diagnostic-transport-${transportId}`,
      requestId: "fetch",
      execute: async (attempt) => {
        if (attempt !== 1) {
          throw new Error("DEVELOPMENT_DIAGNOSTIC_RETRY_FORBIDDEN");
        }
        return this.#transportContext.run(sequence, async () => {
          try {
            const value = await execute();
            this.#emitLifecycle({
              type: "transport_settled",
              sequence,
              outcome: value === null ? "retryable_failed" : "succeeded",
              errorCategory: null
            });
            await this.flushLifecycleEvents();
            if (
              this.plannedRun.softStopPolicy === "stop_new_and_drain_in_flight" &&
              this.transportGate.used === this.transportGate.ceiling
            ) {
              this.softStop("attempt_ceiling");
            }
            return value;
          } catch (error) {
            this.#emitLifecycle({
              type: "transport_settled",
              sequence,
              outcome: "failed",
              errorCategory: classifyTerminalRoleFailure("transport", error)
            });
            await this.flushLifecycleEvents();
            if (
              this.plannedRun.softStopPolicy === "stop_new_and_drain_in_flight" &&
              this.transportGate.used === this.transportGate.ceiling
            ) {
              this.softStop("attempt_ceiling");
            }
            throw error;
          }
        });
      }
    });
    return result.value;
  }

  public markTransportFirstOutput(): void {
    const sequence = this.#transportContext.getStore();
    if (sequence !== undefined && !this.#firstOutputSequences.has(sequence)) {
      this.#firstOutputSequences.add(sequence);
      this.#emitLifecycle({ type: "transport_first_output", sequence });
    }
  }

  public async flushLifecycleEvents(): Promise<void> {
    await this.#lifecycleTail;
    if (this.#lifecycleError !== undefined) {
      throw this.#lifecycleError;
    }
  }

  public restoreCompletedRequest(
    receipt: DevelopmentDiagnosticSafeRequestReceipt,
    timing: FourCallSafeRequestTiming
  ): void {
    const slot = diagnosticSlotSchema.parse(receipt.anonymousSlot);
    const key = `${slot}:${receipt.stage}`;
    const expectedSchemaFingerprint = hashCanonicalValue(
      reviewFlowStageJsonSchemas[receipt.stage]
    );
    if (
      this.#authorized.has(key) ||
      this.#completed.has(key) ||
      receipt.schemaVersion !== 1 ||
      receipt.profileName !== this.profile.name ||
      !diagnosticSlotSet.has(slot) ||
      receipt.provider !== "aether" ||
      receipt.model !== expectedDiagnosticModels[receipt.stage] ||
      receipt.schemaFingerprint !== expectedSchemaFingerprint ||
      receipt.maxOutputTokens !== reviewFlowStageOutputBudgets[receipt.stage] ||
      receipt.thinkingRequest !== "enabled" ||
      receipt.reasoningEffort !== "max" ||
      receipt.logicalAttempt !== 1 ||
      receipt.logicalRequestCeiling !== this.plannedRun.selectedSlots.length * 5 ||
      receipt.externalAttemptCeiling !== this.plannedRun.globalTransportAttemptCeiling
    ) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_RESTORED_REQUEST_INVALID");
    }
    assertSafeTiming(timing);
    this.#authorized.set(key, deepFreeze({ ...receipt }));
    this.#completedStages.add(key);
    this.#completed.set(key, deepFreeze({ ...timing }));
  }

  public recordRequestCompleted(
    request: FourCallRequest,
    timing: FourCallSafeRequestTiming
  ): void {
    const key = `${request.caseId}:${request.stage}`;
    if (!this.#authorized.has(key)) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_REQUEST_NOT_AUTHORIZED");
    }
    if (this.#completed.has(key)) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_REQUEST_COMPLETION_DUPLICATE");
    }
    this.#safeCompletionSink(
      diagnosticSlotSchema.parse(request.caseId),
      request.stage,
      timing
    );
    this.#completed.set(key, deepFreeze({ ...timing }));
    this.#completedStages.add(key);
  }

  public markSlotComplete(slotCandidate: string): void {
    const slot = diagnosticSlotSchema.parse(slotCandidate);
    const required = ["A", "B", "C", "D"] as const;
    if (required.some((stage) => !this.#completedStages.has(`${slot}:${stage}`))) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_SLOT_NOT_TERMINAL");
    }
    this.#completedSlots.add(slot);
  }

  /**
   * 原子性地应用标定 outcome 到控制器审计：先预校验整个快照，
   * 通过后才更新 A/B/C/D 阶段审计和终态槽位。
   * A=solver; B=difficulty; C=solution_analyst+technical_auditor+editorial_judge+
   * contest_fit+originality+tags+critic+adversary; D=adjudicator; F 始终未开始。
   * 完整 outcome 要求 11 角色收据全部存在；不完整 outcome 如实记录失败分组。
   */
  public applySlotOutcome(
    slot: DevelopmentDiagnosticSlot,
    outcome: ReviewFlowCalibrationOutcome
  ): void {
    diagnosticSlotSchema.parse(slot);
    const validated = reviewFlowCalibrationOutcomeSchema.parse(outcome);
    const newCompletedRoles = new Set<ReviewFlowRole>();
    const newFailedRoles = new Set<ReviewFlowRole>();
    const newStageComplete = new Set<string>();
    const newStageFailed = new Set<string>();

    if (validated.status === "complete") {
      for (const role of reviewFlowRoleSchema.options) {
        newCompletedRoles.add(role);
        newStageComplete.add(`${slot}:${roleToStage(role)}`);
      }
    } else {
      for (const summary of validated.failure.completedRoles) {
        newCompletedRoles.add(summary.role);
        newStageComplete.add(`${slot}:${roleToStage(summary.role)}`);
      }
      for (const summary of validated.failure.failedRoles) {
        newFailedRoles.add(summary.role);
        newStageFailed.add(`${slot}:${roleToStage(summary.role)}`);
      }
    }

    const cRoles = reviewFlowRoleSchema.options.filter((role) => roleToStage(role) === "C");
    if (cRoles.some((role) => newFailedRoles.has(role))) {
      newStageComplete.delete(`${slot}:C`);
      newStageFailed.add(`${slot}:C`);
    } else if (!cRoles.every((role) => newCompletedRoles.has(role))) {
      newStageComplete.delete(`${slot}:C`);
    }
    if (!newCompletedRoles.has("adjudicator") && !newFailedRoles.has("adjudicator")) {
      newStageComplete.delete(`${slot}:D`);
    }
    newStageComplete.delete(`${slot}:formatter`);
    newStageFailed.delete(`${slot}:formatter`);

    for (const stage of ["A", "B", "C", "D", "formatter"] as const) {
      const key = `${slot}:${stage}`;
      this.#completedStages.delete(key);
      this.#failedStages.delete(key);
    }
    for (const key of newStageComplete) this.#completedStages.add(key);
    for (const key of newStageFailed) this.#failedStages.add(key);
    this.#roleCompletions.set(slot, newCompletedRoles);
    this.#roleFailures.set(slot, newFailedRoles);

    const allStagesComplete = (["A", "B", "C", "D"] as const).every((stage) =>
      this.#completedStages.has(`${slot}:${stage}`)
    );
    if (validated.status === "complete" && allStagesComplete) {
      this.#completedSlots.add(slot);
    } else {
      this.#completedSlots.delete(slot);
    }
    for (const role of newCompletedRoles) {
      this.#emitLifecycle({ type: "role_completed", slot, role });
    }
    for (const role of newFailedRoles) {
      this.#emitLifecycle({
        type: "role_failed",
        slot,
        role,
        errorCategory: this.#firstFailureKind ?? "permanent"
      });
    }
    for (const key of newStageComplete) {
      const stage = key.slice(key.lastIndexOf(":") + 1) as ReviewFlowDagStage;
      this.#emitLifecycle({ type: "stage_completed", slot, stage });
    }
    for (const key of newStageFailed) {
      const stage = key.slice(key.lastIndexOf(":") + 1) as ReviewFlowDagStage;
      this.#emitLifecycle({ type: "stage_failed", slot, stage });
    }
    this.#emitLifecycle({
      type: "slot_outcome",
      slot,
      status: validated.status === "complete" && allStagesComplete
        ? "complete"
        : "incomplete"
    });
  }


  public recordFailure(
    kind: LlmStageFailureKind,
    request?: FourCallRequest
  ): void {
    this.#firstFailureKind ??= kind;
    if (request) {
      const slot = diagnosticSlotSchema.parse(request.caseId);
      this.#failedStages.add(`${slot}:${request.stage}`);
    }
    this.softStop(
      kind === "output_limit"
        ? "output_limit"
        : kind === "schema_invalid"
          ? "schema_invalid"
          : "final_failure"
    );
  }

  public recordFinalFailure(): void {
    this.recordFailure("permanent");
  }

  public recordTerminalRoleFailure(
    slot: DevelopmentDiagnosticSlot,
    role: ReviewFlowRole,
    failureKind: ReviewFlowFailureKind,
    error: unknown
  ): void {
    diagnosticSlotSchema.parse(slot);
    const stage = roleToStage(role);
    const errorCategory = classifyTerminalRoleFailure(failureKind, error);
    this.#failedStages.add(`${slot}:${stage}`);
    const failures = this.#roleFailures.get(slot) ?? new Set<ReviewFlowRole>();
    failures.add(role);
    this.#roleFailures.set(slot, failures);
    this.#emitLifecycle({ type: "role_failed", slot, role, errorCategory });
    this.#emitLifecycle({ type: "stage_failed", slot, stage });
    this.recordFailure(errorCategory);
  }

  public applySoftStopGate(elapsedMs: number): void {
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_ELAPSED_INVALID");
    }
    if (elapsedMs >= this.plannedRun.phaseSchedulingBudgetMs) {
      this.softStop("soft_stop_budget");
    }
  }

  public softStop(reason: DevelopmentDiagnosticStopReason = "manual"): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#stopReason = reason;
    this.requestStartGate.close();
    this.transportGate.close();
    this.#scheduler.softStop();
  }

  public elapsedMs(): number {
    const elapsedMs = this.#clock() - this.#startedAtMs;
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_CLOCK_INVALID");
    }
    return elapsedMs;
  }

  public assertSlotBindings(
    slotCandidate: string,
    sourceBinding: string,
    truthBindingHash: string
  ): void {
    const slot = diagnosticSlotSchema.parse(slotCandidate);
    const registered = this.manifest.slots.find((entry) => entry.slot === slot);
    if (
      registered?.sourceBinding !== sourceBinding ||
      registered?.truthBindingHash !== truthBindingHash
    ) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_SLOT_BINDING_INVALID");
    }
  }

  /** 返回指定槽位已完成的角色集合（测试用）。 */
  public getRoleCompletions(slot: DevelopmentDiagnosticSlot): readonly ReviewFlowRole[] {
    const roles = this.#roleCompletions.get(slot);
    return roles ? Array.from(roles) : [];
  }

  /** 返回指定槽位失败的角色集合（测试用）。 */
  public getRoleFailures(slot: DevelopmentDiagnosticSlot): readonly ReviewFlowRole[] {
    const roles = this.#roleFailures.get(slot);
    return roles ? Array.from(roles) : [];
  }

  /**
   * 返回可观察的阶段快照（测试用）：每个槽位每个阶段的完成/失败/未开始状态。
   * A/B/C/D/F 各阶段：complete | failed | not_started。
   */
  public getStageSnapshot(slot: DevelopmentDiagnosticSlot): Readonly<Record<"A" | "B" | "C" | "D" | "F", "complete" | "failed" | "not_started">> {
    diagnosticSlotSchema.parse(slot);
    const completedRoles = this.#roleCompletions.get(slot) ?? new Set<ReviewFlowRole>();
    const failedRoles = this.#roleFailures.get(slot) ?? new Set<ReviewFlowRole>();
    const stages: ("A" | "B" | "C" | "D" | "F")[] = ["A", "B", "C", "D", "F"];
    const result: Record<"A" | "B" | "C" | "D" | "F", "complete" | "failed" | "not_started"> = {
      A: "not_started", B: "not_started", C: "not_started", D: "not_started", F: "not_started"
    };
    for (const stage of stages) {
      const rolesInStage = reviewFlowRoleSchema.options.filter((r) => roleToStage(r) === stage);
      if (stage === "F") {
        result[stage] = "not_started";
        continue;
      }
      const completed = rolesInStage.filter((role) => completedRoles.has(role));
      const failed = rolesInStage.filter((role) => failedRoles.has(role));
      if (failed.length > 0) {
        result[stage] = "failed";
      } else if (completed.length === rolesInStage.length && rolesInStage.length > 0) {
        result[stage] = "complete";
      } else {
        result[stage] = "not_started";
      }
    }
    return Object.freeze(result);
  }

  public checkpoint(): DevelopmentDiagnosticCheckpoint {
    const incomplete =
      this.#stopped ||
      this.#completedSlots.size !== this.plannedRun.selectedSlots.length;
    return deepFreeze({
      schemaVersion: 1 as const,
      profileFingerprint: developmentDiagnosticProfileFingerprint,
      manifestFingerprint: this.manifestSummary.manifestFingerprint,
      runBindingHash: this.#runBindingHash,
      logicalRequestsUsed: this.#authorized.size,
      externalAttemptsUsed: this.transportGate.used,
      completedRequestCount: this.#completedStages.size,
      completedSlotCount: this.#completedSlots.size,
      stopped: this.#stopped,
      stopReason: this.#stopReason,
      firstFailureKind: this.#firstFailureKind,
      status: incomplete ? "INCOMPLETE" as const : "DIAGNOSTIC" as const,
      accuracyClaim: null,
      includedInFinalCalibration: false as const
    });
  }

  public budgetReceipt(t0: Date): DevelopmentDiagnosticBudgetReceipt {
    const startMs = t0.getTime();
    const expectedEnd = new Date(startMs + 1_150_315);
    const stages = ["A", "B", "C", "D", "formatter"] as const;
    const completedByStage: Record<string, number> = {};
    const inflightByStage: Record<string, number> = {};
    const failedByStage: Record<string, number> = {};
    const notStartedByStage: Record<string, number> = {};
    for (const stage of stages) {
      completedByStage[stage] = 0;
      inflightByStage[stage] = 0;
      failedByStage[stage] = 0;
      notStartedByStage[stage] = 0;
    }
    for (const slot of this.plannedRun.selectedSlots) {
      for (const stage of stages) {
        const key = `${slot}:${stage}`;
        if (this.#completedStages.has(key)) completedByStage[stage] += 1;
        else if (this.#failedStages.has(key)) failedByStage[stage] += 1;
        else if (this.#authorized.has(key)) inflightByStage[stage] += 1;
        else notStartedByStage[stage] += 1;
      }
    }
    const snapshot = this.#scheduler.snapshot();
    return deepFreeze({
      schemaVersion: 1 as const,
      profileName: "development-diagnostic-2x4-v1" as const,
      profileFingerprint: developmentDiagnosticProfileFingerprint,
      observedBaselineMs: 286_749 as const,
      observedP90Ms: 587_463 as const,
      conservativeMs: 1_150_315 as const,
      expectedUtcStart: t0.toISOString(),
      expectedUtcEnd: expectedEnd.toISOString(),
      logicalRequestCeiling: this.plannedRun.selectedSlots.length * 5,
      providerTransportCeiling: this.plannedRun.globalTransportAttemptCeiling,
      plannedPeakConcurrency: this.plannedRun.maximumConcurrency,
      plannedWaves: Object.freeze([
        { wave: 1, maxConcurrency: this.plannedRun.maximumConcurrency }
      ]),
      completedByStage: Object.freeze(completedByStage),
      inflightByStage: Object.freeze(inflightByStage),
      failedByStage: Object.freeze(failedByStage),
      notStartedByStage: Object.freeze(notStartedByStage),
      avgConcurrency: this.#authorized.size > 0
        ? Math.round((this.#completedStages.size / Math.max(1, this.elapsedMs() / 1000)) * 100) / 100
        : 0,
      peakConcurrency: snapshot.peakConcurrency
    });
  }

  #emitLifecycle(event: DevelopmentDiagnosticLifecycleEvent): void {
    if (this.#lifecycleSink === undefined || this.#lifecycleError !== undefined) return;
    this.#lifecycleTail = this.#lifecycleTail
      .then(() => this.#lifecycleSink?.(event))
      .catch((error: unknown) => {
        this.#lifecycleError = error;
        this.softStop("manual");
      });
  }

  #assertSchedulerProfile(): void {
    const snapshot = this.#scheduler.snapshot();
    if (
      snapshot.maximumConcurrency !== this.plannedRun.maximumConcurrency ||
      snapshot.maximumAttemptsPerLogicalRequest !==
        this.profile.maximumAttemptsPerLogicalRequest ||
      snapshot.maximumAttemptsPerCase !== this.profile.maximumAttemptsPerCase
    ) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_SCHEDULER_INVALID");
    }
  }

  #assertRequestContract(request: FourCallRequest): void {
    const expectedModel = expectedDiagnosticModels[request.stage];
    const expectedSchemaFingerprint = hashCanonicalValue(
      reviewFlowStageJsonSchemas[request.stage]
    );
    if (
      request.model.provider !== "aether" ||
      request.model.model !== expectedModel ||
      request.model.thinkingRequest !== "enabled" ||
      request.model.reasoningEffort !== "max" ||
      !digestSchema.safeParse(request.model.fingerprint).success ||
      request.thinkingRequest !== "enabled" ||
      request.reasoningEffort !== "max" ||
      request.maxOutputTokens !== reviewFlowStageOutputBudgets[request.stage] ||
      request.schema === null ||
      request.schemaFingerprint !== expectedSchemaFingerprint
    ) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_REQUEST_RECEIPT_INVALID");
    }
  }
}

export function createDevelopmentDiagnosticScheduler(
  candidate: unknown = developmentDiagnosticProfile,
  plannedRunCandidate: unknown = legacyDevelopmentDiagnosticPlannedRunContract
): FairLlmRequestScheduler {
  const profile = parseDevelopmentDiagnosticProfile(candidate);
  const plannedRun = parseDevelopmentDiagnosticPlannedRunContract(plannedRunCandidate);
  return new FairLlmRequestScheduler({
    maximumConcurrency: plannedRun.maximumConcurrency,
    maximumAttemptsPerLogicalRequest: profile.maximumAttemptsPerLogicalRequest,
    maximumAttemptsPerCase: profile.maximumAttemptsPerCase
  });
}


function assertSafeTiming(timing: FourCallSafeRequestTiming): void {
  if (
    !Number.isSafeInteger(timing.firstValidOutputMs) ||
    timing.firstValidOutputMs < 0 ||
    !Number.isSafeInteger(timing.endToEndMs) ||
    timing.endToEndMs < timing.firstValidOutputMs ||
    !Number.isSafeInteger(timing.validOutputEventCount) ||
    timing.validOutputEventCount < 0 ||
    !Number.isSafeInteger(timing.outputUtf8Bytes) ||
    timing.outputUtf8Bytes < 0
  ) {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_TIMING_INVALID");
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    Object.freeze(value);
    for (const item of value) deepFreeze(item);
  } else {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
    Object.freeze(value);
  }
  return value;
}
