import { LlmRequestError } from "./llm";

export type LlmStageFailureKind =
  | "rate_limited"
  | "server_error"
  | "connect"
  | "first_byte_timeout"
  | "no_progress_timeout"
  | "stream_interrupted"
  | "output_limit"
  | "schema_invalid"
  | "permanent";

export class LlmStageRequestError extends Error {
  readonly kind: LlmStageFailureKind;
  readonly retryAfterMs: number | null;

  constructor(
    kind: LlmStageFailureKind,
    options: { readonly retryAfterMs?: number | null; readonly cause?: unknown } = {}
  ) {
    super(`LLM_STAGE_${kind.toUpperCase()}`, { cause: options.cause });
    this.name = "LlmStageRequestError";
    this.kind = kind;
    this.retryAfterMs = normalizeRetryAfter(options.retryAfterMs);
  }
}

export interface FairLlmRequestSchedulerOptions {
  readonly maximumConcurrency?: number;
  /** 只有完成并记录 16 并发探针后才能显式打开 20。 */
  readonly twentyConcurrencyProbeAccepted?: boolean;
  readonly maximumAttemptsPerLogicalRequest?: number;
  readonly maximumAttemptsPerCase?: number;
  readonly baseRetryDelayMs?: number;
  readonly jitter?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface LogicalLlmRequestResult<T> {
  readonly value: T;
  readonly attemptCount: number;
}

export interface FairLlmRequestSchedulerSnapshot {
  readonly maximumConcurrency: number;
  readonly maximumAttemptsPerLogicalRequest: number;
  readonly maximumAttemptsPerCase: number;
  readonly active: number;
  readonly queued: number;
  readonly peakConcurrency: number;
  readonly softStopped: boolean;
  readonly attemptsByCase: Readonly<Record<string, number>>;
}

interface QueuedJob<T> {
  readonly run: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

const retryableFailureKinds: Readonly<Record<LlmStageFailureKind, boolean>> = Object.freeze({
  rate_limited: true,
  server_error: true,
  connect: true,
  first_byte_timeout: true,
  no_progress_timeout: true,
  stream_interrupted: true,
  output_limit: false,
  schema_invalid: false,
  permanent: false
});

/**
 * 请求级公平调度器。所有模型档位共用同一个全局并发计数；队列按 caseId 轮转，
 * 同一题不能靠一次性入队大量阶段挤占其它题。逻辑请求失败只影响自己的 Promise。
 */
export class FairLlmRequestScheduler {
  readonly maximumConcurrency: number;

  private readonly maximumAttemptsPerLogicalRequest: number;
  private readonly maximumAttemptsPerCase: number;
  private readonly baseRetryDelayMs: number;
  private readonly jitter: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly queues = new Map<string, QueuedJob<unknown>[]>();
  private readonly caseOrder: string[] = [];
  private readonly attemptsByCase = new Map<string, number>();
  private active = 0;
  private queued = 0;
  private peakConcurrency = 0;
  private stopped = false;
  private pumpQueued = false;

  constructor(options: FairLlmRequestSchedulerOptions = {}) {
    this.maximumConcurrency = boundedInteger(
      options.maximumConcurrency ?? 12,
      "LLM_SCHEDULER_MAXIMUM_CONCURRENCY",
      1,
      20
    );
    if (this.maximumConcurrency > 16 && options.twentyConcurrencyProbeAccepted !== true) {
      throw new Error("LLM_SCHEDULER_TWENTY_REQUIRES_ACCEPTED_PROBE");
    }
    this.maximumAttemptsPerLogicalRequest = boundedInteger(
      options.maximumAttemptsPerLogicalRequest ?? 3,
      "LLM_LOGICAL_REQUEST_ATTEMPT_LIMIT",
      1,
      3
    );
    this.maximumAttemptsPerCase = boundedInteger(
      options.maximumAttemptsPerCase ?? 8,
      "LLM_CASE_ATTEMPT_LIMIT",
      1,
      64
    );
    this.baseRetryDelayMs = boundedInteger(
      options.baseRetryDelayMs ?? 500,
      "LLM_RETRY_BASE_DELAY",
      1,
      60_000
    );
    this.jitter = options.jitter ?? Math.random;
    this.sleep = options.sleep ?? ((milliseconds) => {
      const waiter = Promise.withResolvers<void>();
      setTimeout(waiter.resolve, milliseconds);
      return waiter.promise;
    });
  }

  async runLogicalRequest<T>(input: {
    readonly caseId: string;
    readonly requestId: string;
    readonly execute: (attempt: number) => Promise<T>;
  }): Promise<LogicalLlmRequestResult<T>> {
    assertSafeQueueKey(input.caseId, "caseId");
    assertSafeQueueKey(input.requestId, "requestId");
    if (this.stopped) throw new Error("LLM_SCHEDULER_SOFT_STOPPED");

    let logicalAttempt = 0;
    for (;;) {
      try {
        const value = await this.enqueue(input.caseId, () => {
          logicalAttempt += 1;
          this.consumeCaseAttempt(input.caseId);
          return input.execute(logicalAttempt);
        });
        return Object.freeze({ value, attemptCount: logicalAttempt });
      } catch (error) {
        const classified = classifyStageRequestError(error);
        if (
          classified === null ||
          !retryableFailureKinds[classified.kind] ||
          logicalAttempt >= this.maximumAttemptsPerLogicalRequest
        ) {
          throw error;
        }
        if (this.stopped) throw new Error("LLM_SCHEDULER_SOFT_STOPPED", { cause: error });
        const delayMs = retryDelayMilliseconds({
          baseDelayMs: this.baseRetryDelayMs,
          failedAttempt: logicalAttempt,
          retryAfterMs: classified.retryAfterMs,
          jitterUnit: this.jitter()
        });
        await this.sleep(delayMs);
      }
    }
  }

  softStop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const error = new Error("LLM_SCHEDULER_SOFT_STOPPED");
    for (const queue of this.queues.values()) {
      for (const job of queue) job.reject(error);
    }
    this.queues.clear();
    this.caseOrder.splice(0);
    this.queued = 0;
  }

  snapshot(): FairLlmRequestSchedulerSnapshot {
    return Object.freeze({
      maximumConcurrency: this.maximumConcurrency,
      maximumAttemptsPerLogicalRequest: this.maximumAttemptsPerLogicalRequest,
      maximumAttemptsPerCase: this.maximumAttemptsPerCase,
      active: this.active,
      queued: this.queued,
      peakConcurrency: this.peakConcurrency,
      softStopped: this.stopped,
      attemptsByCase: Object.freeze(Object.fromEntries(this.attemptsByCase))
    });
  }

  private consumeCaseAttempt(caseId: string): void {
    const used = this.attemptsByCase.get(caseId) ?? 0;
    if (used >= this.maximumAttemptsPerCase) {
      throw new Error("LLM_CASE_ATTEMPT_LIMIT");
    }
    this.attemptsByCase.set(caseId, used + 1);
  }

  private enqueue<T>(caseId: string, run: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("LLM_SCHEDULER_SOFT_STOPPED"));
    const waiter = Promise.withResolvers<T>();
    const existing = this.queues.get(caseId);
    const job: QueuedJob<T> = { run, resolve: waiter.resolve, reject: waiter.reject };
    if (existing === undefined) {
      this.queues.set(caseId, [job as QueuedJob<unknown>]);
      this.caseOrder.push(caseId);
    } else {
      existing.push(job as QueuedJob<unknown>);
    }
    this.queued += 1;
    this.queuePump();
    return waiter.promise;
  }

  private queuePump(): void {
    if (this.pumpQueued) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.maximumConcurrency && this.caseOrder.length > 0) {
      const caseId = this.caseOrder.shift()!;
      const caseQueue = this.queues.get(caseId);
      if (caseQueue === undefined || caseQueue.length === 0) {
        this.queues.delete(caseId);
        continue;
      }
      const job = caseQueue.shift()!;
      if (caseQueue.length === 0) {
        this.queues.delete(caseId);
      } else {
        this.caseOrder.push(caseId);
      }
      this.queued -= 1;
      this.active += 1;
      this.peakConcurrency = Math.max(this.peakConcurrency, this.active);
      void Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active -= 1;
          this.queuePump();
        });
    }
  }
}

export function classifyTransportFailure(error: unknown): LlmStageRequestError {
  if (!(error instanceof LlmRequestError)) {
    return new LlmStageRequestError("permanent", { cause: error });
  }
  if (error.code === "LLM_HTTP_ERROR") {
    if (error.status === 429) {
      return new LlmStageRequestError("rate_limited", {
        retryAfterMs: error.retryAfterMs,
        cause: error
      });
    }
    if (error.status !== undefined && error.status >= 500 && error.status <= 599) {
      return new LlmStageRequestError("server_error", { cause: error });
    }
    return new LlmStageRequestError("permanent", { cause: error });
  }
  const byCode: Partial<
    Record<LlmRequestError["code"], LlmStageFailureKind>
  > = {
    LLM_NETWORK_FAILED: "connect",
    LLM_FIRST_OUTPUT_TIMEOUT: "first_byte_timeout",
    LLM_OUTPUT_IDLE_TIMEOUT: "no_progress_timeout",
    LLM_STREAM_INTERRUPTED: "stream_interrupted",
    LLM_OUTPUT_LENGTH_LIMIT: "output_limit"
  };
  return new LlmStageRequestError(byCode[error.code] ?? "permanent", {
    cause: error
  });
}

export function classifyStageRequestError(error: unknown): LlmStageRequestError | null {
  return error instanceof LlmStageRequestError ? error : null;
}

export function retryDelayMilliseconds(input: {
  readonly baseDelayMs: number;
  readonly failedAttempt: number;
  readonly retryAfterMs: number | null;
  readonly jitterUnit: number;
}): number {
  const exponential = input.baseDelayMs * 2 ** (input.failedAttempt - 1);
  const retryAfter = input.retryAfterMs ?? 0;
  const boundedJitter = Number.isFinite(input.jitterUnit)
    ? Math.max(0, Math.min(1, input.jitterUnit))
    : 0;
  const jitter = Math.floor(exponential * 0.2 * boundedJitter);
  return Math.min(60 * 60 * 1_000, Math.max(exponential + jitter, retryAfter));
}

function normalizeRetryAfter(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.floor(value), 60 * 60 * 1_000);
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(name);
  }
  return value;
}

function assertSafeQueueKey(value: string, name: string): void {
  if (value.length < 1 || value.length > 200 || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new Error(`LLM_SCHEDULER_${name.toUpperCase()}_INVALID`);
  }
}
