/** 并发执行器：单题失败不阻止其它题目启动；最终封存仍要求 32 题全部完成。 */
import { performance } from "node:perf_hooks";
import type {
  ReviewFlowCalibrationProjection,
  ReviewFlowFailureKind
} from "../../src/review-flow/orchestrator";
import { LlmRequestStartGate } from "../../src/llm";
import type {
  ReviewFlowEvaluationExecutionOutcome
} from "./review-flow-evaluation-adapter";
import type {
  ReviewFlowEvaluationCaseTiming,
  ReviewFlowEvaluationCheckpoint,
  ReviewFlowEvaluationCheckpointState,
  ReviewFlowEvaluationFailure,
  ReviewFlowEvaluationPilotTimingReceipt
} from "./review-flow-evaluation-state";
import { ReviewFlowEvaluationCheckpointError } from "./review-flow-evaluation-state";

export interface ReviewFlowEvaluationPreparedCase<TPrepared> {
  readonly safeId: string;
  readonly prepared: TPrepared;
}

export interface ReviewFlowEvaluationExecutor<TPrepared> {
  execute(
    prepared: TPrepared,
    runId: string,
    requestStartGate: LlmRequestStartGate
  ): Promise<ReviewFlowEvaluationExecutionOutcome>;
}

/**
 * 单案例允许的执行次数。超出次数的失败按终态记录，绝不为任何策略无限重试。
 */
export const maxReviewFlowEvaluationCaseAttempts = 8;

/**
 * 可重试失败类别：模型输出长度超限、JSON 结构噪声、瞬态传输/HTTP/超时与
 * 取消。它们不表明题目语义上无法完成——本轮样本在 v8 与 v8b 中出现过同题
 * 一次通过、一次超限的随机摆动（max 推理在 1M 上限附近），完整重试能吸收。
 * 业务校验失败（validation）与方法内部错误（role_internal）不可重试。
 */
export function isRetryableReviewFlowEvaluationFailureKind(
  kind: ReviewFlowFailureKind | null
): boolean {
  switch (kind) {
    case "output_limit":
    case "schema_output":
    case "service_http":
    case "transport":
    case "timeout":
    case "content_filtered":
    case "protocol":
    case "cancelled":
      return true;
    case "validation":
    case "role_internal":
    case null:
      return false;
    default:
      // 新失败类别默认不可重试，避免未知语义被盲目重跑烧钱。
      return false;
  }
}

function isRetryableReviewFlowEvaluationFailure(
  failure: ReviewFlowEvaluationFailure
): boolean {
  return isRetryableReviewFlowEvaluationFailureKind(failure.failureKind);
}

export type ReviewFlowEvaluationTerminationSignal =
  | "SIGINT"
  | "SIGTERM"
  | "SIGHUP";

/** 信号只关闭新请求闸门；从不创建 AbortSignal，也不取消已经付费的流。 */
export class ReviewFlowEvaluationStartGate {
  readonly #checkpoint: ReviewFlowEvaluationCheckpoint;
  #closed = false;
  #persistenceFailed = false;
  /**
   * 已创建但尚未在案例清理时释放的每案例请求闸门登记表。终止时逐一关闭，
   * 使任何尚未开始的角色/修复/重试请求被拒绝；已发出的流不受影响，跑到
   * 自然 EOF。登记表仅在案例生命周期内持有引用，案例清理时移除，避免泄漏。
   */
  readonly #caseGates = new Set<LlmRequestStartGate>();

  public constructor(
    checkpoint: ReviewFlowEvaluationCheckpoint
  ) {
    this.#checkpoint = checkpoint;
  }

  public canStart(): boolean {
    return !this.#closed &&
      this.#checkpoint.startGateOpen();
  }

  /**
   * 为单个案例创建独立的请求闸门，并登记到注册表。一个案例内某角色失败时
   * 只会关闭该案例自己的闸门，阻止同案例后续角色启动；不会影响其它并发
   * 案例。若终止已发生，新创建的闸门立即关闭，确保终止后新案例也无法
   * 启动任何请求。案例执行结束后必须调用 releaseCaseRequestStartGate
   * 释放登记，避免注册表无限增长。
   */
  public createCaseRequestStartGate(): LlmRequestStartGate {
    const gate = new LlmRequestStartGate();
    if (this.#closed) {
      gate.close();
    }
    this.#caseGates.add(gate);
    return gate;
  }

  /**
   * 案例清理时从注册表移除其请求闸门。幂等：重复释放或释放未登记闸门无副作用。
   * 已关闭的闸门移除后不再被后续终止批量关闭，但 canStartRequest() 行为不变。
   */
  public releaseCaseRequestStartGate(gate: LlmRequestStartGate): void {
    this.#caseGates.delete(gate);
  }

  /**
   * 关闭外层闸门并同步关闭所有已登记的每案例闸门。已发出的 HTTP 流不会被
   * 取消；只阻止尚未发起的角色/修复/重试请求。关闭后清空注册表，因为所有
   * 已登记闸门均已关闭，无需再保留引用。
   */
  public closeForTermination(): void {
    this.#closed = true;
    for (const gate of this.#caseGates) {
      gate.close();
    }
    this.#caseGates.clear();
  }

  public requestTermination(signal: ReviewFlowEvaluationTerminationSignal): void {
    this.closeForTermination();
    try {
      this.#checkpoint.markTerminationRequested(signal);
    } catch {
      this.#persistenceFailed = true;
    }
  }

  public assertHealthy(): void {
    if (this.#persistenceFailed) {
      throw new Error("REVIEW_FLOW_EVALUATION_TERMINATION_PERSIST_FAILED");
    }
  }
}
export interface ReviewFlowEvaluationSignalSource {
  on(
    signal: ReviewFlowEvaluationTerminationSignal,
    listener: () => void
  ): unknown;
  off(
    signal: ReviewFlowEvaluationTerminationSignal,
    listener: () => void
  ): unknown;
}

export function installReviewFlowEvaluationSignalHandlers(input: {
  readonly gate: ReviewFlowEvaluationStartGate;
  readonly source?: ReviewFlowEvaluationSignalSource;
}): () => void {
  const source = input.source ?? process;
  const registrations = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(
    (signal) => {
      const listener = () => input.gate.requestTermination(signal);
      source.on(signal, listener);
      return { signal, listener };
    }
  );
  return () => {
    for (const registration of registrations) {
      source.off(registration.signal, registration.listener);
    }
  };
}

export async function runReviewFlowEvaluationCases<TPrepared>(input: {
  readonly checkpoint: ReviewFlowEvaluationCheckpoint;
  readonly cases: readonly ReviewFlowEvaluationPreparedCase<TPrepared>[];
  readonly executor: ReviewFlowEvaluationExecutor<TPrepared>;
  readonly concurrency: number;
  readonly startGate?: ReviewFlowEvaluationStartGate;
  readonly maxCaseAttempts?: number;
  readonly monotonicNow?: () => number;
}): Promise<ReviewFlowEvaluationCheckpointState> {
  if (
    !Number.isSafeInteger(input.concurrency) ||
    input.concurrency < 1 ||
    input.concurrency > 20
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_CONCURRENCY_INVALID");
  }
  const maxCaseAttempts = input.maxCaseAttempts ?? 1;
  if (
    !Number.isSafeInteger(maxCaseAttempts) ||
    maxCaseAttempts < 1 ||
    maxCaseAttempts > maxReviewFlowEvaluationCaseAttempts
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_CASE_ATTEMPTS_INVALID");
  }
  const initial = input.checkpoint.snapshot();
  const startGate = input.startGate ??
    new ReviewFlowEvaluationStartGate(input.checkpoint);
  const caseById = new Map(input.cases.map((entry) => [entry.safeId, entry]));
  if (
    caseById.size !== input.cases.length ||
    initial.expectedCases.some((entry) => !caseById.has(entry.safeId)) ||
    input.cases.length !== initial.expectedCases.length
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_CASE_SET_MISMATCH");
  }

  // active/failed 是不可恢复终态。resume 只对账，不为 pending 再花钱。
  if (input.checkpoint.terminallyContaminated()) {
    return input.checkpoint.sealExecution();
  }

  const selection = initial.identity.caseSelection;
  if (
    selection !== undefined &&
    (
      (
        selection.selector !== "representative3-v1" &&
        selection.selector !== "representative3-v2"
      ) ||
      maxCaseAttempts !== 1 ||
      initial.entries.length !== 3 ||
      initial.entries.some((entry) => entry.status !== "pending") ||
      initial.expectedCases.some(
        (entry, index) => input.cases[index]?.safeId !== entry.safeId
      )
    )
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_RUN_INVALID");
  }
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const representative3StartedAt =
    selection === undefined ? null : monotonicNow();

  const runBatch = async (
    pending: readonly string[],
    concurrency: number,
    pilot: boolean
  ): Promise<void> => {
    let nextIndex = 0;
    let stopStarting = false;
    let localFatal = false;
    const workerCount = Math.min(concurrency, pending.length);
    const workers = Array.from({ length: workerCount }, async () => {
      try {
        while (!stopStarting && !localFatal && startGate.canStart()) {
          const index = nextIndex;
          nextIndex += 1;
          const safeId = pending[index];
          if (safeId === undefined) return;
          const evaluationCase = caseById.get(safeId);
          if (evaluationCase === undefined) {
            throw new Error("REVIEW_FLOW_EVALUATION_CASE_SET_MISMATCH");
          }
          const pilotStartedAt = pilot ? representative3StartedAt : null;

          // active 必须在任何模型调用前同步、原子地落盘。
          try {
            input.checkpoint.markActive(safeId);
          } catch (error) {
            if (
              error instanceof ReviewFlowEvaluationCheckpointError &&
              error.code === "REVIEW_FLOW_EVALUATION_START_GATE_CLOSED" &&
              !startGate.canStart()
            ) {
              return;
            }
            throw error;
          }
          const pilotReceipt = (
            succeeded: boolean,
            timing: ReviewFlowEvaluationCaseTiming | undefined
          ) =>
            pilot &&
            pilotStartedAt !== null &&
            validCaseTiming(timing)
              ? buildRepresentative3PilotTimingReceipt({
                  firstByteMs: timing.firstByteMs,
                  monotonicLatencyMs: Math.max(
                    timing.endToEndMs,
                    conservativeMonotonicElapsed(
                      pilotStartedAt,
                      monotonicNow()
                    )
                  ),
                  succeeded,
                  concurrency: input.concurrency,
                  maxCaseAttempts,
                  configuration: initial.identity.configurationSummary
                })
              : undefined;

          // 同一案例允许在可重试失败类别下完整重跑（每次独立闸门与独立 token
          // 预算）。闸门关闭或预算耗尽时，已发生的最新失败立即落地。
          let caseAttempts = 0;
          let latestIncomplete: ReviewFlowEvaluationFailure | null = null;
          let latestThrown = false;
          let finalized = false;
          while (!finalized && !localFatal) {
            if (!startGate.canStart() || caseAttempts >= maxCaseAttempts) {
              if (latestIncomplete !== null || latestThrown) {
                const failure = latestThrown
                  ? { ...unexpectedFailure(), caseAttempts }
                  : { ...latestIncomplete!, caseAttempts };
                try {
                  input.checkpoint.markFailed(
                    safeId,
                    failure,
                    pilotReceipt(false, undefined)
                  );
                } catch {
                  localFatal = true;
                }
              }
              finalized = true;
              continue;
            }
            caseAttempts += 1;
            let outcome: ReviewFlowEvaluationExecutionOutcome;
            const caseRequestStartGate = startGate.createCaseRequestStartGate();
            try {
              latestThrown = false;
              latestIncomplete = null;
              outcome = await input.executor.execute(
                evaluationCase.prepared,
                initial.runId,
                caseRequestStartGate
              );
            } catch {
              startGate.releaseCaseRequestStartGate(caseRequestStartGate);
              latestThrown = true;
              continue;
            }
            startGate.releaseCaseRequestStartGate(caseRequestStartGate);

            if (outcome.status === "incomplete") {
              latestIncomplete = outcome.failure;
              if (
                isRetryableReviewFlowEvaluationFailure(outcome.failure) &&
                caseAttempts < maxCaseAttempts &&
                startGate.canStart()
              ) {
                continue;
              }
              try {
                input.checkpoint.markFailed(
                  safeId,
                  { ...latestIncomplete, caseAttempts },
                  pilotReceipt(false, outcome.timing)
                );
              } catch {
                localFatal = true;
              }
              finalized = true;
              continue;
            }
            if (selection !== undefined && !validCaseTiming(outcome.timing)) {
              try {
                input.checkpoint.markFailed(
                  safeId,
                  timingReceiptMissingFailure(caseAttempts)
                );
              } catch {
                localFatal = true;
              }
              finalized = true;
              continue;
            }
            try {
              markCompleted(
                input.checkpoint,
                safeId,
                outcome.projection,
                pilotReceipt(true, outcome.timing),
                outcome.timing
              );
            } catch {
              throw new Error("REVIEW_FLOW_EVALUATION_LOCAL_STATE_FAILURE");
            }
            finalized = true;
          }
        }
      } catch {
        // 本地故障只阻止新请求；不取消任何已经付费且正在流式输出的 worker。
        stopStarting = true;
        startGate.closeForTermination();
        localFatal = true;
      }
    });
    await Promise.allSettled(workers);
    startGate.assertHealthy();
    if (localFatal) {
      throw new Error("REVIEW_FLOW_EVALUATION_LOCAL_STATE_FAILURE");
    }
  };

  const pending = input.checkpoint.pendingSafeIds();
  if (selection !== undefined) {
    await runBatch(pending.slice(0, 1), 1, true);
    const pilotEntry = input.checkpoint.snapshot().entries[0];
    if (
      pilotEntry?.status !== "completed" ||
      pilotEntry.pilotTiming?.remainingCasesAdmitted !== true
    ) {
      startGate.closeForTermination();
      return input.checkpoint.sealExecution();
    }
    // pilot 收据落盘且通过 90 分钟准入后，才同时放行剩余两题。
    const stage2StartedAt = monotonicNow();
    await runBatch(input.checkpoint.pendingSafeIds(), input.concurrency, false);
    const stage2EndedAt = monotonicNow();
    const completed = input.checkpoint.snapshot();
    const pilotCaseTiming = completed.entries[0]?.status === "completed"
      ? completed.entries[0].caseTiming
      : undefined;
    if (
      completed.entries.every((entry) => entry.status === "completed") &&
      pilotCaseTiming !== undefined &&
      representative3StartedAt !== null
    ) {
      input.checkpoint.bindRepresentative3Timing({
        schemaVersion: 1,
        firstByteMs: pilotCaseTiming.firstByteMs,
        stage2LatencyMs: conservativeMonotonicElapsed(
          stage2StartedAt,
          stage2EndedAt
        ),
        endToEndMs: conservativeMonotonicElapsed(
          representative3StartedAt,
          stage2EndedAt
        )
      });
    }
  } else {
    await runBatch(pending, input.concurrency, false);
  }
  return input.checkpoint.sealExecution();
}

export const representative3MaximumTotalDurationMs = 90 * 60 * 1_000;

export function buildRepresentative3PilotTimingReceipt(input: {
  readonly firstByteMs: number;
  readonly monotonicLatencyMs: number;
  readonly succeeded: boolean;
  readonly concurrency: number;
  readonly maxCaseAttempts: number;
  readonly configuration:
    ReviewFlowEvaluationCheckpointState["identity"]["configurationSummary"];
}): ReviewFlowEvaluationPilotTimingReceipt {
  const latencyMs = boundedDuration(input.monotonicLatencyMs);
  const retryBackoffMs = boundedProduct(
    input.configuration.baseDelayMs,
    (2 ** Math.max(0, input.configuration.maxAttempts - 1)) - 1
  );
  const watchdogMs = Math.max(
    input.configuration.llmFirstOutputMs,
    input.configuration.llmOutputIdleMs,
    input.configuration.llmMaximumDurationMs
  );
  const perCaseBoundMs = boundedSum([
    boundedProduct(latencyMs, input.maxCaseAttempts),
    boundedProduct(watchdogMs, Math.max(0, input.maxCaseAttempts - 1)),
    boundedProduct(retryBackoffMs, input.maxCaseAttempts)
  ]);
  const parallelWaves = Math.ceil(2 / Math.max(1, input.concurrency));
  const remainingTwoBoundMs = boundedProduct(perCaseBoundMs, parallelWaves);
  const projectedTotalDurationMs = boundedSum([
    latencyMs,
    remainingTwoBoundMs
  ]);
  const projectedWithinLimit =
    projectedTotalDurationMs <= representative3MaximumTotalDurationMs;
  return {
    schemaVersion: 2,
    firstByteMs: Math.min(latencyMs, boundedDuration(input.firstByteMs)),
    endToEndMs: latencyMs,
    monotonicLatencyMs: latencyMs,
    remainingTwoBoundMs,
    projectedTotalDurationMs,
    maximumTotalDurationMs: representative3MaximumTotalDurationMs,
    projectedWithinLimit,
    remainingCasesAdmitted: input.succeeded && projectedWithinLimit
  };
}

function conservativeMonotonicElapsed(start: number, end: number): number {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start
  ) {
    return representative3MaximumTotalDurationMs + 1;
  }
  return boundedDuration(Math.ceil(end - start));
}

function boundedDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) return Number.MAX_SAFE_INTEGER;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(value));
}

function boundedProduct(left: number, right: number): number {
  return boundedDuration(left * right);
}

function boundedSum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (value > Number.MAX_SAFE_INTEGER - total) return Number.MAX_SAFE_INTEGER;
    total += value;
  }
  return total;
}

function markCompleted(
  checkpoint: ReviewFlowEvaluationCheckpoint,
  safeId: string,
  projection: ReviewFlowCalibrationProjection,
  pilotTiming?: ReviewFlowEvaluationPilotTimingReceipt,
  caseTiming?: ReviewFlowEvaluationCaseTiming
): void {
  try {
    checkpoint.markCompleted(safeId, projection, pilotTiming, caseTiming);
  } catch (error) {
    // 检查点 I/O 失败时不能猜测磁盘终态，更不能把同一请求重发成另一条链。
    throw error;
  }
}

function validCaseTiming(
  timing: ReviewFlowEvaluationCaseTiming | undefined
): timing is ReviewFlowEvaluationCaseTiming {
  return (
    timing?.schemaVersion === 1 &&
    Number.isSafeInteger(timing.firstByteMs) &&
    timing.firstByteMs >= 0 &&
    Number.isSafeInteger(timing.endToEndMs) &&
    timing.endToEndMs >= timing.firstByteMs
  );
}

function timingReceiptMissingFailure(
  caseAttempts: number
): ReviewFlowEvaluationFailure {
  return {
    code: "REVIEW_FLOW_EVALUATION_TIMING_RECEIPT_MISSING",
    failureKind: null,
    httpStatus: null,
    completedRoleCount: 11,
    failedRoleCount: 0,
    failedRoles: [],
    caseAttempts
  };
}

function unexpectedFailure(): ReviewFlowEvaluationFailure {
  return {
    code: "REVIEW_FLOW_EVALUATION_EXECUTION_THROWN",
    failureKind: null,
    httpStatus: null,
    completedRoleCount: 0,
    failedRoleCount: 0,
    failedRoles: [],
    caseAttempts: 1
  };
}
