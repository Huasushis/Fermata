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
   * 为单个案例创建独立的请求闸门。一个案例内某角色失败时只会关闭该案例
   * 自己的闸门，阻止同案例后续角色启动；不会影响其它并发案例。
   */
  public createCaseRequestStartGate(): LlmRequestStartGate {
    return new LlmRequestStartGate();
  }

  public closeForTermination(): void {
    this.#closed = true;
  }

  public requestTermination(signal: ReviewFlowEvaluationTerminationSignal): void {
    this.#closed = true;
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
      selection.selector !== "representative3-v1" ||
      maxCaseAttempts !== 3 ||
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
          const pilotStartedAt = pilot ? monotonicNow() : null;

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
          const pilotReceipt = (succeeded: boolean) =>
            pilot && pilotStartedAt !== null
              ? buildRepresentative3PilotTimingReceipt({
                  monotonicLatencyMs: conservativeMonotonicElapsed(
                    pilotStartedAt,
                    monotonicNow()
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
                    pilotReceipt(false)
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
            try {
              latestThrown = false;
              latestIncomplete = null;
              outcome = await input.executor.execute(
                evaluationCase.prepared,
                initial.runId,
                startGate.createCaseRequestStartGate()
              );
            } catch {
              latestThrown = true;
              continue;
            }

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
                  pilotReceipt(false)
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
                pilotReceipt(true)
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
    await runBatch(input.checkpoint.pendingSafeIds(), input.concurrency, false);
  } else {
    await runBatch(pending, input.concurrency, false);
  }
  return input.checkpoint.sealExecution();
}

export const representative3MaximumTotalDurationMs = 90 * 60 * 1_000;

export function buildRepresentative3PilotTimingReceipt(input: {
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
    schemaVersion: 1,
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
  pilotTiming?: ReviewFlowEvaluationPilotTimingReceipt
): void {
  try {
    checkpoint.markCompleted(safeId, projection, pilotTiming);
  } catch (error) {
    // 检查点 I/O 失败时不能猜测磁盘终态，更不能把同一请求重发成另一条链。
    throw error;
  }
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
