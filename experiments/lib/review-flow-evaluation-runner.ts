/** 并发执行器：首个不完整样本后不再启动新样本，但等待所有已发请求真正结束。 */
import type { ReviewFlowCalibrationProjection } from "../../src/review-flow/orchestrator";
import { LlmRequestStartGate } from "../../src/llm";
import type {
  ReviewFlowEvaluationExecutionOutcome
} from "./review-flow-evaluation-adapter";
import type {
  ReviewFlowEvaluationCheckpoint,
  ReviewFlowEvaluationCheckpointState,
  ReviewFlowEvaluationFailure
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

export type ReviewFlowEvaluationTerminationSignal =
  | "SIGINT"
  | "SIGTERM"
  | "SIGHUP";

/** 信号只关闭新请求闸门；从不创建 AbortSignal，也不取消已经付费的流。 */
export class ReviewFlowEvaluationStartGate {
  readonly #checkpoint: ReviewFlowEvaluationCheckpoint;
  readonly #requestStartGate: LlmRequestStartGate;
  #closed = false;
  #persistenceFailed = false;

  public constructor(
    checkpoint: ReviewFlowEvaluationCheckpoint,
    requestStartGate = new LlmRequestStartGate()
  ) {
    this.#checkpoint = checkpoint;
    this.#requestStartGate = requestStartGate;
  }

  public canStart(): boolean {
    return !this.#closed &&
      this.#requestStartGate.canStartRequest() &&
      this.#checkpoint.startGateOpen();
  }

  public requestStartGate(): LlmRequestStartGate {
    return this.#requestStartGate;
  }

  public closeForFailure(): void {
    this.#closed = true;
    this.#requestStartGate.close();
  }

  public requestTermination(signal: ReviewFlowEvaluationTerminationSignal): void {
    this.#closed = true;
    this.#requestStartGate.close();
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
}): Promise<ReviewFlowEvaluationCheckpointState> {
  if (
    !Number.isSafeInteger(input.concurrency) ||
    input.concurrency < 1 ||
    input.concurrency > 32
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_CONCURRENCY_INVALID");
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

  const pending = input.checkpoint.pendingSafeIds();
  let nextIndex = 0;
  let stopStarting = false;
  let localFatal = false;
  const workerCount = Math.min(input.concurrency, pending.length);
  const workers = Array.from({ length: workerCount }, async () => {
    try {
      while (!stopStarting && startGate.canStart()) {
        const index = nextIndex;
        nextIndex += 1;
        const safeId = pending[index];
        if (safeId === undefined) return;
        const evaluationCase = caseById.get(safeId);
        if (evaluationCase === undefined) {
          throw new Error("REVIEW_FLOW_EVALUATION_CASE_SET_MISMATCH");
        }

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
        let outcome: ReviewFlowEvaluationExecutionOutcome;
        try {
          outcome = await input.executor.execute(
            evaluationCase.prepared,
            initial.runId,
            startGate.requestStartGate()
          );
        } catch {
          startGate.closeForFailure();
          const failure = unexpectedFailure();
          try {
            input.checkpoint.markFailed(safeId, failure);
          } catch {
            localFatal = true;
          }
          stopStarting = true;
          return;
        }

        if (outcome.status === "incomplete") {
          startGate.closeForFailure();
          try {
            input.checkpoint.markFailed(safeId, outcome.failure);
          } catch {
            localFatal = true;
          }
          stopStarting = true;
          return;
        }
        try {
          markCompleted(input.checkpoint, safeId, outcome.projection);
        } catch {
          startGate.closeForFailure();
          throw new Error("REVIEW_FLOW_EVALUATION_LOCAL_STATE_FAILURE");
        }
      }
    } catch {
      // 本地检查点/校验故障不能取消其它已经付费的 worker。只阻止继续启动，
      // 等全部 worker 收口后再向 CLI 抛一个固定错误。
      stopStarting = true;
      startGate.closeForFailure();
      localFatal = true;
    }
  });

  // 不向其它 worker 发送 AbortSignal。即使其中一题先失败，已经付费并在持续
  // 输出的请求仍由各自的真实流式读取路径等到服务端 EOF/明确失败。
  await Promise.allSettled(workers);
  startGate.assertHealthy();
  if (localFatal) {
    throw new Error("REVIEW_FLOW_EVALUATION_LOCAL_STATE_FAILURE");
  }
  return input.checkpoint.sealExecution();
}

function markCompleted(
  checkpoint: ReviewFlowEvaluationCheckpoint,
  safeId: string,
  projection: ReviewFlowCalibrationProjection
): void {
  try {
    checkpoint.markCompleted(safeId, projection);
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
    failedRoleCount: 0
  };
}
