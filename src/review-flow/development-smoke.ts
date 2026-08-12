import { z } from "zod";
import {
  LlmRequestError,
  LlmRequestStartGate
} from "../llm";
import {
  FairLlmRequestScheduler,
  type LlmStageFailureKind
} from "../llm-scheduler";
import type { PipelineModelConfig } from "../pipelines/types";
import { hashCanonicalValue } from "./evidence";
import {
  reviewFlowStageJsonSchemas,
  reviewFlowStageOutputBudgets,
  type FourCallDagResult,
  type FourCallRequest,
  type FourCallReviewSource,
  type ReviewFlowCompletedStage,
  type ReviewFlowCompletedStages,
  type ReviewFlowDagStage
} from "./four-call";
import {
  runProductionFourCallReviewDag,
  type FourCallRequestLifecycle,
  type FourCallRuntimeModels,
  type FourCallSafeRequestFailure,
  type FourCallSafeRequestTiming
} from "./four-call-runtime";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const anonymousSlotSchema = z.enum([
  "slot-01",
  "slot-02",
  "slot-03",
  "slot-04",
  "slot-05",
  "slot-06"
]);
const difficultyTruthSchema = z.enum(["low", "middle", "high"]);
const verdictTruthSchema = z.enum(["pass", "reject"]);
const priorFailureSchema = z.enum(["output_limit", "schema_invalid"]);

export const developmentSmokeProfileSchema = z
  .object({
    name: z.literal("development-smoke-6x4-v1"),
    anonymousSlotCount: z.literal(6),
    phase0SlotCount: z.literal(2),
    phase1SlotCount: z.literal(4),
    semanticRequestsPerSlot: z.literal(4),
    maximumFormatterRequestsPerSlot: z.literal(1),
    maximumAttemptsPerLogicalRequest: z.literal(1),
    maximumAttemptsPerCase: z.literal(5),
    maximumWholeCaseRetries: z.literal(0),
    maximumTotalLogicalRequests: z.literal(30),
    maximumTotalExternalAttempts: z.literal(30),
    maximumConcurrency: z.literal(12),
    firstValidOutputTimeoutMs: z.literal(600_000),
    outputIdleTimeoutMs: z.literal(600_000),
    healthyStreamWallClockTimeoutMs: z.null(),
    preFirstOutputFallbackMs: z.literal(1_800_000),
    phase0CheckpointMs: z.literal(15 * 60_000),
    reestimateCheckpointMs: z.literal(60 * 60_000),
    closeNewStagesAfterMs: z.literal(180 * 60_000),
    allowedExternalService: z.literal("configured_aether_deepseek"),
    allowYuantiji: z.literal(false),
    allowCodeforces: z.literal(false),
    allowWeb: z.literal(false),
    legacy31MinuteObservationUnit: z.literal("UNKNOWN"),
    includeInFinalCalibration: z.literal(false)
  })
  .strict();

export type DevelopmentSmokeProfile = z.infer<
  typeof developmentSmokeProfileSchema
>;

export const developmentSmokeProfile: DevelopmentSmokeProfile = Object.freeze({
  name: "development-smoke-6x4-v1",
  anonymousSlotCount: 6,
  phase0SlotCount: 2,
  phase1SlotCount: 4,
  semanticRequestsPerSlot: 4,
  maximumFormatterRequestsPerSlot: 1,
  maximumAttemptsPerLogicalRequest: 1,
  maximumAttemptsPerCase: 5,
  maximumWholeCaseRetries: 0,
  maximumTotalLogicalRequests: 30,
  maximumTotalExternalAttempts: 30,
  maximumConcurrency: 12,
  firstValidOutputTimeoutMs: 600_000,
  outputIdleTimeoutMs: 600_000,
  healthyStreamWallClockTimeoutMs: null,
  preFirstOutputFallbackMs: 1_800_000,
  phase0CheckpointMs: 15 * 60_000,
  reestimateCheckpointMs: 60 * 60_000,
  closeNewStagesAfterMs: 180 * 60_000,
  allowedExternalService: "configured_aether_deepseek",
  allowYuantiji: false,
  allowCodeforces: false,
  allowWeb: false,
  legacy31MinuteObservationUnit: "UNKNOWN",
  includeInFinalCalibration: false
});

export const developmentSmokeProfileFingerprint = hashCanonicalValue(
  developmentSmokeProfile
);
export const developmentSmokeAggregateBudgetReceipt = Object.freeze({
  schemaVersion: 1 as const,
  profileName: developmentSmokeProfile.name,
  profileFingerprint: developmentSmokeProfileFingerprint,
  semanticLogicalRequestCeiling: 24 as const,
  formatterLogicalRequestCeiling: 6 as const,
  totalLogicalRequestCeiling: 30 as const,
  semanticOutputTokenCeiling: 456_000 as const,
  formatterOutputTokenCeiling: 48_000 as const,
  totalOutputTokenCeiling: 504_000 as const
});


const manifestSlotSchema = z
  .object({
    slot: anonymousSlotSchema,
    slotBindingHash: digestSchema,
    truthBindingHash: digestSchema,
    difficultyTruth: difficultyTruthSchema,
    verdictTruth: verdictTruthSchema,
    priorFailures: z.array(priorFailureSchema).max(2)
  })
  .strict();

export const developmentSmokeManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    profileName: z.literal(developmentSmokeProfile.name),
    slots: z.array(manifestSlotSchema).length(6)
  })
  .strict();

export type DevelopmentSmokeManifest = z.infer<
  typeof developmentSmokeManifestSchema
>;
export type DevelopmentSmokeAnonymousSlot = z.infer<typeof anonymousSlotSchema>;

export interface DevelopmentSmokeManifestSummary {
  readonly slotCount: 6;
  readonly difficultyCounts: Readonly<Record<"low" | "middle" | "high", number>>;
  readonly verdictCounts: Readonly<Record<"pass" | "reject", number>>;
  readonly priorFailureCounts: Readonly<Record<"output_limit" | "schema_invalid", number>>;
  readonly slotsWithBothTruthAxes: 6;
  readonly manifestFingerprint: string;
}

export interface DevelopmentSmokeSafeRequestReceipt {
  readonly schemaVersion: 1;
  readonly profileName: typeof developmentSmokeProfile.name;
  readonly profileFingerprint: string;
  readonly manifestFingerprint: string;
  readonly runBindingHash: string;
  readonly anonymousSlot: DevelopmentSmokeAnonymousSlot;
  readonly phase: "phase0" | "phase1";
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
  readonly logicalRequestCeiling: 30;
  readonly externalAttemptsUsed: number;
  readonly externalAttemptCeiling: 30;
}

export interface DevelopmentSmokePhase0ForecastReceipt {
  readonly basis: "phase0_measured_per_logical_request";
  readonly legacy31MinuteObservationUnit: "UNKNOWN";
  readonly durationEstimator: "nearest_rank_empirical_p90";
  readonly measuredLogicalRequestCount: number;
  readonly measurementFingerprint: string;
  readonly estimatorFingerprint: string;
  readonly observedLogicalRequestP90Ms: number;
  readonly observedFirstValidOutputP90Ms: number;
  readonly observedValidOutputEventsPerMinuteFloor: number;
  readonly remainingCriticalWaveCount: 3 | 4;
  readonly projectedAllSixP90Ms: number;
}

export interface DevelopmentSmokeCheckpoint {
  readonly schemaVersion: 1;
  readonly profileFingerprint: string;
  readonly manifestFingerprint: string;
  readonly runBindingHash: string;
  readonly phase: "phase0" | "phase1";
  readonly logicalRequestsUsed: number;
  readonly externalAttemptsUsed: number;
  readonly completedRequestCount: number;
  readonly completedSlotCount: number;
  readonly stopped: boolean;
  readonly stopReason: DevelopmentSmokeStopReason | null;
  readonly status: "PIPELINE_SMOKE" | "INCOMPLETE";
  readonly accuracyClaim: null;
  readonly includedInFinalCalibration: false;
}

export type DevelopmentSmokeStopReason =
  | "output_limit"
  | "schema_invalid"
  | "final_failure"
  | "repeated_system_error"
  | "p90_over_three_hours"
  | "three_hour_gate"
  | "manual";

type SystemFailureKind = Exclude<
  LlmStageFailureKind,
  "output_limit" | "schema_invalid" | "permanent"
>;

const expectedSlots: readonly DevelopmentSmokeAnonymousSlot[] = Object.freeze([
  "slot-01",
  "slot-02",
  "slot-03",
  "slot-04",
  "slot-05",
  "slot-06"
]);
const phase0Slots = new Set<DevelopmentSmokeAnonymousSlot>(expectedSlots.slice(0, 2));
const phase1Slots = new Set<DevelopmentSmokeAnonymousSlot>(expectedSlots.slice(2));
const expectedModels: Readonly<
  Record<ReviewFlowDagStage, "deepseek-v4-pro" | "deepseek-v4-flash">
> = Object.freeze({
  A: "deepseek-v4-pro",
  B: "deepseek-v4-flash",
  C: "deepseek-v4-pro",
  D: "deepseek-v4-pro",
  formatter: "deepseek-v4-flash"
});
const systemFailureKinds = new Set<SystemFailureKind>([
  "rate_limited",
  "server_error",
  "connect",
  "first_byte_timeout",
  "no_progress_timeout",
  "stream_interrupted"
]);

export function parseDevelopmentSmokeProfile(
  candidate: unknown
): DevelopmentSmokeProfile {
  const parsed = developmentSmokeProfileSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("DEVELOPMENT_SMOKE_PROFILE_INVALID");
  if (hashCanonicalValue(parsed.data) !== developmentSmokeProfileFingerprint) {
    throw new Error("DEVELOPMENT_SMOKE_PROFILE_INVALID");
  }
  return Object.freeze(parsed.data);
}

export function parseDevelopmentSmokeManifest(
  candidate: unknown
): DevelopmentSmokeManifest {
  const parsed = developmentSmokeManifestSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("DEVELOPMENT_SMOKE_MANIFEST_INVALID");
  const slots = parsed.data.slots;
  if (slots.some((slot, index) => slot.slot !== expectedSlots[index])) {
    throw new Error("DEVELOPMENT_SMOKE_MANIFEST_SLOT_ORDER_INVALID");
  }
  if (new Set(slots.map((slot) => slot.slotBindingHash)).size !== 6) {
    throw new Error("DEVELOPMENT_SMOKE_MANIFEST_BINDING_INVALID");
  }
  if (new Set(slots.map((slot) => slot.truthBindingHash)).size !== 6) {
    throw new Error("DEVELOPMENT_SMOKE_MANIFEST_TRUTH_BINDING_INVALID");
  }
  const summary = summarizeDevelopmentSmokeManifest(parsed.data);
  if (
    summary.difficultyCounts.low < 1 ||
    summary.difficultyCounts.middle < 1 ||
    summary.difficultyCounts.high < 1 ||
    summary.verdictCounts.pass !== 3 ||
    summary.verdictCounts.reject !== 3 ||
    summary.priorFailureCounts.output_limit < 1 ||
    summary.priorFailureCounts.schema_invalid < 1
  ) {
    throw new Error("DEVELOPMENT_SMOKE_MANIFEST_COVERAGE_INVALID");
  }
  return deepFreeze(parsed.data);
}

export function summarizeDevelopmentSmokeManifest(
  manifest: DevelopmentSmokeManifest
): DevelopmentSmokeManifestSummary {
  const difficultyCounts = { low: 0, middle: 0, high: 0 };
  const verdictCounts = { pass: 0, reject: 0 };
  const priorFailureCounts = { output_limit: 0, schema_invalid: 0 };
  for (const slot of manifest.slots) {
    difficultyCounts[slot.difficultyTruth] += 1;
    verdictCounts[slot.verdictTruth] += 1;
    for (const failure of slot.priorFailures) priorFailureCounts[failure] += 1;
  }
  return deepFreeze({
    slotCount: 6 as const,
    difficultyCounts,
    verdictCounts,
    priorFailureCounts,
    slotsWithBothTruthAxes: 6 as const,
    manifestFingerprint: hashCanonicalValue(manifest)
  });
}

export function bindDevelopmentSmokeModels(
  models: FourCallRuntimeModels
): FourCallRuntimeModels {
  const bound = Object.fromEntries(
    (Object.keys(expectedModels) as ReviewFlowDagStage[]).map((stage) => {
      const config = models[stage];
      assertDevelopmentSmokeModel(stage, config);
      return [stage, Object.freeze({
        ...config,
        runtime: Object.freeze({
          ...config.runtime,
          firstOutputTimeoutMs: developmentSmokeProfile.firstValidOutputTimeoutMs,
          outputIdleTimeoutMs: developmentSmokeProfile.outputIdleTimeoutMs,
          maximumDurationMs: developmentSmokeProfile.preFirstOutputFallbackMs,
          maxAttempts: developmentSmokeProfile.maximumAttemptsPerLogicalRequest
        })
      })];
    })
  ) as unknown as FourCallRuntimeModels;
  return Object.freeze(bound);
}

export function createDevelopmentSmokeScheduler(
  candidate: unknown = developmentSmokeProfile
): FairLlmRequestScheduler {
  const profile = parseDevelopmentSmokeProfile(candidate);
  return new FairLlmRequestScheduler({
    maximumConcurrency: profile.maximumConcurrency,
    maximumAttemptsPerLogicalRequest: profile.maximumAttemptsPerLogicalRequest,
    maximumAttemptsPerCase: profile.maximumAttemptsPerCase
  });
}

export class DevelopmentSmokeRunController {
  readonly profile = developmentSmokeProfile;
  readonly manifest: DevelopmentSmokeManifest;
  readonly manifestSummary: DevelopmentSmokeManifestSummary;
  readonly requestStartGate = new LlmRequestStartGate();

  readonly #runBindingHash: string;
  readonly #scheduler: FairLlmRequestScheduler;
  readonly #safeReceiptSink: (receipt: DevelopmentSmokeSafeRequestReceipt) => void;
  readonly #safeCompletionSink: (
    slot: DevelopmentSmokeAnonymousSlot,
    stage: ReviewFlowDagStage,
    timing: FourCallSafeRequestTiming
  ) => void;
  readonly #safeFailureSink: (
    slot: DevelopmentSmokeAnonymousSlot,
    stage: ReviewFlowDagStage,
    failure: FourCallSafeRequestFailure
  ) => void;
  readonly #authorized = new Map<string, DevelopmentSmokeSafeRequestReceipt>();
  readonly #completed = new Map<string, FourCallSafeRequestTiming>();
  readonly #completedSlots = new Set<DevelopmentSmokeAnonymousSlot>();
  #consecutiveSystemFailures = 0;
  readonly #startedAtMs: number;
  readonly #clock: () => number;
  #phase: "phase0" | "phase1";
  #stopped = false;
  #stopReason: DevelopmentSmokeStopReason | null = null;

  public constructor(input: {
    readonly profile: unknown;
    readonly manifest: unknown;
    readonly runBindingHash: string;
    readonly scheduler: FairLlmRequestScheduler;
    readonly safeReceiptSink?: (receipt: DevelopmentSmokeSafeRequestReceipt) => void;
    readonly safeCompletionSink?: (
      slot: DevelopmentSmokeAnonymousSlot,
      stage: ReviewFlowDagStage,
      timing: FourCallSafeRequestTiming
    ) => void;
    readonly safeFailureSink?: (
      slot: DevelopmentSmokeAnonymousSlot,
      stage: ReviewFlowDagStage,
      failure: FourCallSafeRequestFailure
    ) => void;
    readonly startedAtMs: number;
    readonly initialPhase?: "phase0" | "phase1";
    readonly clock?: () => number;
  }) {
    parseDevelopmentSmokeProfile(input.profile);
    this.manifest = parseDevelopmentSmokeManifest(input.manifest);
    this.manifestSummary = summarizeDevelopmentSmokeManifest(this.manifest);
    this.#runBindingHash = digestSchema.parse(input.runBindingHash);
    this.#scheduler = input.scheduler;
    this.#safeReceiptSink = input.safeReceiptSink ?? (() => undefined);
    if (!Number.isSafeInteger(input.startedAtMs) || input.startedAtMs < 0) {
      throw new Error("DEVELOPMENT_SMOKE_STARTED_AT_INVALID");
    }
    this.#startedAtMs = input.startedAtMs;
    this.#phase = input.initialPhase ?? "phase0";
    this.#safeFailureSink = input.safeFailureSink ?? (() => undefined);
    this.#clock = input.clock ?? Date.now;
    this.#safeCompletionSink = input.safeCompletionSink ?? (() => undefined);
    if (this.#clock() < this.#startedAtMs) {
      throw new Error("DEVELOPMENT_SMOKE_CLOCK_INVALID");
    }
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
          anonymousSlotSchema.parse(request.caseId),
          request.stage,
          failure
        );
        this.recordFailure(failure.kind);
      }
    });
  }

  public authorizeRequest(
    request: FourCallRequest
  ): DevelopmentSmokeSafeRequestReceipt {
    this.applyElapsedGate(this.elapsedMs());
    this.#assertSchedulerProfile();
    if (this.#stopped || !this.requestStartGate.canStartRequest()) {
      throw new Error("DEVELOPMENT_SMOKE_NEW_REQUESTS_CLOSED");
    }
    const slot = anonymousSlotSchema.parse(request.caseId);
    if (this.#phase === "phase0" ? !phase0Slots.has(slot) : !phase1Slots.has(slot)) {
      throw new Error("DEVELOPMENT_SMOKE_PHASE_SLOT_INVALID");
    }
    if (request.attempt !== 1) throw new Error("DEVELOPMENT_SMOKE_RETRY_FORBIDDEN");
    const requestKey = `${slot}:${request.stage}`;
    if (this.#authorized.has(requestKey)) {
      throw new Error("DEVELOPMENT_SMOKE_WHOLE_CASE_RETRY_FORBIDDEN");
    }
    const attemptsForSlot = [...this.#authorized.keys()].filter((key) =>
      key.startsWith(`${slot}:`)
    ).length;
    if (attemptsForSlot >= this.profile.maximumAttemptsPerCase) {
      throw new Error("DEVELOPMENT_SMOKE_CASE_ATTEMPT_LIMIT");
    }
    if (this.#authorized.size >= this.profile.maximumTotalLogicalRequests) {
      throw new Error("DEVELOPMENT_SMOKE_TOTAL_REQUEST_LIMIT");
    }
    this.#assertRequestContract(request);
    const schemaFingerprint = request.schemaFingerprint!;
    const receipt: DevelopmentSmokeSafeRequestReceipt = deepFreeze({
      schemaVersion: 1 as const,
      profileName: this.profile.name,
      profileFingerprint: developmentSmokeProfileFingerprint,
      manifestFingerprint: this.manifestSummary.manifestFingerprint,
      runBindingHash: this.#runBindingHash,
      anonymousSlot: slot,
      phase: this.#phase,
      stage: request.stage,
      provider: "aether" as const,
      model: expectedModels[request.stage],
      modelFingerprint: request.model.fingerprint,
      schemaFingerprint,
      maxOutputTokens: request.maxOutputTokens as DevelopmentSmokeSafeRequestReceipt["maxOutputTokens"],
      thinkingRequest: "enabled" as const,
      reasoningEffort: "max" as const,
      logicalAttempt: 1 as const,
      logicalRequestsUsed: this.#authorized.size + 1,
      logicalRequestCeiling: 30 as const,
      externalAttemptsUsed: this.#authorized.size + 1,
      externalAttemptCeiling: 30 as const
    });
    this.#safeReceiptSink(receipt);
    this.#authorized.set(requestKey, receipt);
    return receipt;
  }

  public restoreCompletedRequest(
    receipt: DevelopmentSmokeSafeRequestReceipt,
    timing: FourCallSafeRequestTiming
  ): void {
    const slot = anonymousSlotSchema.parse(receipt.anonymousSlot);
    const key = `${slot}:${receipt.stage}`;
    const expectedSchemaFingerprint = hashCanonicalValue(
      reviewFlowStageJsonSchemas[receipt.stage]
    );
    if (
      this.#authorized.has(key) ||
      this.#completed.has(key) ||
      receipt.schemaVersion !== 1 ||
      receipt.profileName !== this.profile.name ||
      !(
        (receipt.phase === "phase0" && phase0Slots.has(slot)) ||
        (receipt.phase === "phase1" && phase1Slots.has(slot))
      ) ||
      receipt.provider !== "aether" ||
      receipt.model !== expectedModels[receipt.stage] ||
      receipt.schemaFingerprint !== expectedSchemaFingerprint ||
      receipt.maxOutputTokens !== reviewFlowStageOutputBudgets[receipt.stage] ||
      receipt.thinkingRequest !== "enabled" ||
      receipt.reasoningEffort !== "max" ||
      receipt.logicalAttempt !== 1 ||
      receipt.logicalRequestsUsed !== this.#authorized.size + 1 ||
      receipt.externalAttemptsUsed !== this.#authorized.size + 1 ||
      receipt.logicalRequestCeiling !== 30 ||
      receipt.externalAttemptCeiling !== 30
    ) {
      throw new Error("DEVELOPMENT_SMOKE_RESTORED_REQUEST_INVALID");
    }
    assertSafeTiming(timing);
    this.#authorized.set(key, deepFreeze({ ...receipt }));
    this.#completed.set(key, deepFreeze({ ...timing }));
  }

  public recordRequestCompleted(
    request: FourCallRequest,
    timing: FourCallSafeRequestTiming
  ): void {
    const key = `${request.caseId}:${request.stage}`;
    if (!this.#authorized.has(key)) {
      throw new Error("DEVELOPMENT_SMOKE_REQUEST_NOT_AUTHORIZED");
    }
    if (this.#completed.has(key)) {
      throw new Error("DEVELOPMENT_SMOKE_REQUEST_COMPLETION_DUPLICATE");
    }
    this.#safeCompletionSink(
      anonymousSlotSchema.parse(request.caseId),
      request.stage,
      timing
    );
    this.#completed.set(key, deepFreeze({ ...timing }));
    this.#consecutiveSystemFailures = 0;
  }

  public markSlotComplete(slotCandidate: string): void {
    const slot = anonymousSlotSchema.parse(slotCandidate);
    const required = ["A", "B", "C", "D"] as const;
    if (required.some((stage) => !this.#completed.has(`${slot}:${stage}`))) {
      throw new Error("DEVELOPMENT_SMOKE_SLOT_NOT_TERMINAL");
    }
    this.#completedSlots.add(slot);
  }

  public releasePhase1(): DevelopmentSmokePhase0ForecastReceipt {
    const elapsedMs = this.elapsedMs();
    if (this.#phase !== "phase0" || this.#stopped) {
      throw new Error("DEVELOPMENT_SMOKE_PHASE1_RELEASE_FORBIDDEN");
    }
    if (elapsedMs < this.profile.phase0CheckpointMs) {
      throw new Error("DEVELOPMENT_SMOKE_PHASE0_CHECKPOINT_EARLY");
    }
    if ([...phase0Slots].some((slot) => !this.#completedSlots.has(slot))) {
      throw new Error("DEVELOPMENT_SMOKE_PHASE0_INCOMPLETE");
    }
    const forecast = this.phase0Forecast(elapsedMs);
    if (forecast.projectedAllSixP90Ms > this.profile.closeNewStagesAfterMs) {
      this.softStop("p90_over_three_hours");
      throw new Error("DEVELOPMENT_SMOKE_P90_OVER_THREE_HOURS");
    }
    this.#phase = "phase1";
    return forecast;
  }

  public phase0Forecast(elapsedMs: number): DevelopmentSmokePhase0ForecastReceipt {
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
      throw new Error("DEVELOPMENT_SMOKE_ELAPSED_INVALID");
    }
    const measurements = [...this.#completed.entries()]
      .filter(([key]) => key.startsWith("slot-01:") || key.startsWith("slot-02:"))
      .sort(([left], [right]) => left.localeCompare(right));
    if (measurements.length < 8) {
      throw new Error("DEVELOPMENT_SMOKE_PHASE0_MEASUREMENTS_INCOMPLETE");
    }
    const timings = measurements.map(([, timing]) => timing);
    const observedLogicalRequestP90Ms = nearestRankP90(
      timings.map((timing) => timing.endToEndMs)
    );
    const observedFirstValidOutputP90Ms = nearestRankP90(
      timings.map((timing) => timing.firstValidOutputMs)
    );
    const observedValidOutputEventsPerMinuteFloor = Math.min(
      ...timings.map((timing) => Math.floor(
        timing.validOutputEventCount * 60_000 /
          Math.max(1, timing.endToEndMs - timing.firstValidOutputMs)
      ))
    );
    const remainingCriticalWaveCount = measurements.some(([key]) =>
      key.endsWith(":formatter")
    ) ? 4 as const : 3 as const;
    const measurementFingerprint = this.phase0MeasurementFingerprint();
    const estimatorFingerprint = hashCanonicalValue({
      schemaVersion: 1,
      name: "nearest-rank-p90-times-remaining-critical-waves",
      unit: "per_logical_request",
      measurementFingerprint,
      remainingCriticalWaveCount
    });
    return deepFreeze({
      basis: "phase0_measured_per_logical_request" as const,
      legacy31MinuteObservationUnit: "UNKNOWN" as const,
      durationEstimator: "nearest_rank_empirical_p90" as const,
      measuredLogicalRequestCount: measurements.length,
      measurementFingerprint,
      estimatorFingerprint,
      observedLogicalRequestP90Ms,
      observedFirstValidOutputP90Ms,
      observedValidOutputEventsPerMinuteFloor,
      remainingCriticalWaveCount,
      projectedAllSixP90Ms:
        elapsedMs + observedLogicalRequestP90Ms * remainingCriticalWaveCount
    });
  }

  public reestimate(): DevelopmentSmokePhase0ForecastReceipt {
    const elapsedMs = this.elapsedMs();
    if (elapsedMs >= this.profile.closeNewStagesAfterMs) {
      this.softStop("three_hour_gate");
      return this.phase0Forecast(elapsedMs);
    }
    const forecast = this.phase0Forecast(elapsedMs);
    if (forecast.projectedAllSixP90Ms > this.profile.closeNewStagesAfterMs) {
      this.softStop("p90_over_three_hours");
    }
    return forecast;
  }

  public applyElapsedGate(elapsedMs: number): void {
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
      throw new Error("DEVELOPMENT_SMOKE_ELAPSED_INVALID");
    }
    if (elapsedMs >= this.profile.closeNewStagesAfterMs) {
      this.softStop("three_hour_gate");
    }
  }

  public recordFailure(kind: LlmStageFailureKind): void {
    if (kind === "output_limit") this.softStop("output_limit");
    if (kind === "schema_invalid") this.softStop("schema_invalid");
    if (kind === "permanent") this.softStop("final_failure");
    if (systemFailureKinds.has(kind as SystemFailureKind)) {
      this.#consecutiveSystemFailures += 1;
      if (this.#consecutiveSystemFailures >= 2) {
        this.softStop("repeated_system_error");
      }
    }
  }

  public recordFinalFailure(): void {
    this.softStop("final_failure");
  }

  public softStop(reason: DevelopmentSmokeStopReason = "manual"): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#stopReason = reason;
    this.requestStartGate.close();
    this.#scheduler.softStop();
  }

  public phase0MeasurementFingerprint(): string {
    const phase0Measurements = [...this.#completed.entries()]
      .filter(([key]) => key.startsWith("slot-01:") || key.startsWith("slot-02:"))
      .sort(([left], [right]) => left.localeCompare(right));
    return hashCanonicalValue({
      schemaVersion: 1,
      unit: "per_logical_request",
      measurements: phase0Measurements
    });
  }

  public elapsedMs(): number {
    const elapsedMs = this.#clock() - this.#startedAtMs;
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
      throw new Error("DEVELOPMENT_SMOKE_CLOCK_INVALID");
    }
    return elapsedMs;
  }

  public assertSlotBindings(
    slotCandidate: string,
    sourceBinding: string,
    truthBindingHash: string
  ): void {
    const slot = anonymousSlotSchema.parse(slotCandidate);
    const registered = this.manifest.slots.find((entry) => entry.slot === slot);
    if (
      registered?.slotBindingHash !== sourceBinding ||
      registered.truthBindingHash !== truthBindingHash
    ) {
      throw new Error("DEVELOPMENT_SMOKE_SLOT_BINDING_INVALID");
    }
  }

  public checkpoint(): DevelopmentSmokeCheckpoint {
    const incomplete =
      this.#stopped ||
      this.#completedSlots.size !== this.profile.anonymousSlotCount;
    return deepFreeze({
      schemaVersion: 1 as const,
      profileFingerprint: developmentSmokeProfileFingerprint,
      manifestFingerprint: this.manifestSummary.manifestFingerprint,
      runBindingHash: this.#runBindingHash,
      phase: this.#phase,
      logicalRequestsUsed: this.#authorized.size,
      externalAttemptsUsed: this.#authorized.size,
      completedRequestCount: this.#completed.size,
      completedSlotCount: this.#completedSlots.size,
      stopped: this.#stopped,
      stopReason: this.#stopReason,
      status: incomplete ? "INCOMPLETE" as const : "PIPELINE_SMOKE" as const,
      accuracyClaim: null,
      includedInFinalCalibration: false as const
    });
  }

  #assertSchedulerProfile(): void {
    const snapshot = this.#scheduler.snapshot();
    if (
      snapshot.maximumConcurrency !== this.profile.maximumConcurrency ||
      snapshot.maximumAttemptsPerLogicalRequest !==
        this.profile.maximumAttemptsPerLogicalRequest ||
      snapshot.maximumAttemptsPerCase !== this.profile.maximumAttemptsPerCase
    ) {
      throw new Error("DEVELOPMENT_SMOKE_SCHEDULER_INVALID");
    }
  }

  #assertRequestContract(request: FourCallRequest): void {
    const expectedModel = expectedModels[request.stage];
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
      throw new Error("DEVELOPMENT_SMOKE_REQUEST_RECEIPT_INVALID");
    }
  }
}

export function developmentSmokePhaseSlots(
  phase: "phase0" | "phase1"
): readonly DevelopmentSmokeAnonymousSlot[] {
  return Object.freeze(
    phase === "phase0" ? [...phase0Slots] : [...phase1Slots]
  );
}

export async function runDevelopmentSmokePhase(input: {
  readonly phase: "phase0" | "phase1";
  readonly controller: DevelopmentSmokeRunController;
  readonly models: FourCallRuntimeModels;
  readonly nativeSchemaCompatible: boolean;
  readonly cases: readonly {
    readonly slot: DevelopmentSmokeAnonymousSlot;
    readonly sourceBinding: string;
    readonly source: FourCallReviewSource;
    readonly truthBindingHash: string;
    readonly reusableStages?: ReviewFlowCompletedStages;
  }[];
  readonly onStageCompleted?: (
    slot: DevelopmentSmokeAnonymousSlot,
    completed: ReviewFlowCompletedStage
  ) => void;
}): Promise<readonly PromiseSettledResult<FourCallDagResult>[]> {
  const requiredSlots = developmentSmokePhaseSlots(input.phase);
  if (
    input.cases.length !== requiredSlots.length ||
    input.cases.some((entry, index) => entry.slot !== requiredSlots[index])
  ) {
    throw new Error("DEVELOPMENT_SMOKE_PHASE_BATCH_INVALID");
  }
  for (const entry of input.cases) {
    input.controller.assertSlotBindings(
      entry.slot,
      entry.sourceBinding,
      entry.truthBindingHash
    );
  }
  const models = bindDevelopmentSmokeModels(input.models);
  const outcomes = await Promise.allSettled(
    input.cases.map(async (entry) => {
      const result = await runProductionFourCallReviewDag({
        caseId: entry.slot,
        sourceBinding: entry.sourceBinding,
        source: entry.source,
        models,
        nativeSchemaCompatible: input.nativeSchemaCompatible,
        scheduler: input.controller.scheduler(),
        reusableStages: entry.reusableStages,
        onStageCompleted: (completed) => {
          input.onStageCompleted?.(entry.slot, completed);
        },
        lifecycle: input.controller.lifecycle()
      });
      input.controller.markSlotComplete(entry.slot);
      return result;
    })
  );
  if (outcomes.some((outcome) => outcome.status === "rejected")) {
    input.controller.recordFinalFailure();
  }
  return Object.freeze(outcomes);
}

export function classifyDevelopmentSmokeFailure(
  error: unknown
): LlmStageFailureKind {
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    isStageFailureKind(error.kind)
  ) {
    return error.kind;
  }
  const code = error instanceof LlmRequestError ? error.code : null;
  if (code === "LLM_FIRST_OUTPUT_TIMEOUT") return "first_byte_timeout";
  if (code === "LLM_OUTPUT_IDLE_TIMEOUT") return "no_progress_timeout";
  if (code === "LLM_OUTPUT_LENGTH_LIMIT") return "output_limit";
  if (code === "LLM_STREAM_INTERRUPTED") return "stream_interrupted";
  return "permanent";
}

function assertDevelopmentSmokeModel(
  stage: ReviewFlowDagStage,
  config: PipelineModelConfig
): void {
  if (
    config.spec.provider !== "aether" ||
    config.spec.model !== expectedModels[stage] ||
    config.spec.thinkingRequest !== "enabled" ||
    config.spec.reasoningEffort !== "max"
  ) {
    throw new Error("DEVELOPMENT_SMOKE_MODEL_INVALID");
  }
}

function isStageFailureKind(value: unknown): value is LlmStageFailureKind {
  return typeof value === "string" && [
    "rate_limited",
    "server_error",
    "connect",
    "first_byte_timeout",
    "no_progress_timeout",
    "stream_interrupted",
    "output_limit",
    "schema_invalid",
    "permanent"
  ].includes(value);
}

function nearestRankP90(values: readonly number[]): number {
  if (
    values.length === 0 ||
    values.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new Error("DEVELOPMENT_SMOKE_TIMING_INVALID");
  }
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.9) - 1]!;
}

function assertSafeTiming(timing: FourCallSafeRequestTiming): void {
  if (
    !Number.isSafeInteger(timing.firstValidOutputMs) ||
    timing.firstValidOutputMs < 0 ||
    !Number.isSafeInteger(timing.endToEndMs) ||
    timing.endToEndMs < timing.firstValidOutputMs ||
    !Number.isSafeInteger(timing.validOutputEventCount) ||
    timing.validOutputEventCount < 1 ||
    !Number.isSafeInteger(timing.outputUtf8Bytes) ||
    timing.outputUtf8Bytes < 1
  ) {
    throw new Error("DEVELOPMENT_SMOKE_TIMING_INVALID");
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
