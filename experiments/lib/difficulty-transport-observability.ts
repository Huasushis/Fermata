/**
 * difficulty 评测路径的每样本传输可观测性（脱敏）。
 *
 * 通过现有 LlmRuntimeOptions 钩子（onTransportDispatch / onSafeOutputActivity）
 * 采集，不修改 src/llm.ts 传输内部控制流：
 *   - onTransportDispatch(attempt) 在每次真实 fetch 前调用，一次 fetch 计一次；
 *     钩子自身不抛异常、不影响传输。
 *   - onSafeOutputActivity() 在首个有效输出事件时触发，作为“首字节”的代理：
 *     它发生在响应正文已到达并解析出第一个有效事件之后，不是裸 TCP 首字节，
 *     但已是 llm.ts 对外暴露的最早输出时机。
 *
 * 每条记录只保存安全计数与时间戳，绝不保存题面、响应正文、模型回文、密钥
 * 或端点。聚合交给 eval-difficulty 与 writeReports 的报告路径写入。
 */
import { getLlmFailureAudit, type LlmRuntimeOptions } from "../../src/llm";
import type { PipelineModelConfig } from "../../src/pipelines/types";

export type DifficultyTransportSampleStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "missing"
  | "in-flight";

/** 单样本脱敏传输观测：只含计数与时间戳，不含任何原文或密钥。 */
export interface DifficultySampleTransportObservability {
  readonly sampleId: string;
  readonly status: DifficultyTransportSampleStatus;
  /** 精确实传尝试次数：每次真实 fetch（含 429 重试）计一次。 */
  readonly attemptCount: number;
  readonly retryCount: number;
  /** 开始（样本推理提交）→ 首次有效输出事件 的毫秒数；无任何输出活动时为 null。 */
  readonly firstByteLatencyMs: number | null;
  /** 开始 → 样本结算（成功返回或最终失败）的毫秒数。 */
  readonly endToEndLatencyMs: number | null;
  /** 是否观测到 HTTP EOF。 */
  readonly eofObserved: boolean | null;
}

/** 全样本聚合；所有字段都可由 report 安全落盘。 */
export interface DifficultyTransportAggregate {
  readonly attempted: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly missing: number;
  readonly inFlight: number;
  readonly totalAttempts: number;
  readonly totalRetries: number;
  readonly samples: readonly DifficultySampleTransportObservability[];
}

const cancelledLlmRequestCodes = new Set([
  "LLM_CANCELLED",
  "LLM_TOTAL_TIMEOUT",
  "LLM_FIRST_OUTPUT_TIMEOUT",
  "LLM_OUTPUT_IDLE_TIMEOUT"
]);

/** 从任意错误对象提取安全的 EOF 观察结论；非 LlmFailureAudit 时返回 null。 */
export function eofObservedFromFailure(error: unknown): boolean | null {
  const audit = getLlmFailureAudit(error);
  return audit === null ? null : audit.terminal.eofObserved;
}

function classifyLlmError(error: unknown): {
  readonly status: DifficultyTransportSampleStatus;
  readonly eofObserved: boolean | null;
} {
  const audit = getLlmFailureAudit(error);
  const code =
    typeof (error as { code?: unknown }).code === "string"
      ? ((error as { code: string }).code)
      : "LLM_UNCLASSIFIED";
  if (cancelledLlmRequestCodes.has(code)) {
    return { status: "cancelled", eofObserved: audit?.terminal.eofObserved ?? null };
  }
  return { status: "failed", eofObserved: audit?.terminal.eofObserved ?? null };
}

/**
 * 每个样本一个观测器。在样本推理提交前调用 begin()，把到货的活动回调绑定到
 * observability，结算时调用 settle()。
 */
export class DifficultyTransportObserver {
  readonly #sampleId: string;
  readonly #beganAtMs: number;
  #attemptCount = 0;
  #firstActivityAtMs: number | null = null;
  #settledAtMs: number | null = null;
  #status: DifficultyTransportSampleStatus = "in-flight";
  #eofObserved: boolean | null = null;

  public constructor(sampleId: string, beganAtMs: number = Date.now()) {
    this.#sampleId = sampleId;
    this.#beganAtMs = beganAtMs;
  }

  /** 每次真实传输尝试（fetch 及 429 重试）前调用；不抛异常、不影响传输。 */
  public recordDispatch(_attempt: number): void {
    this.#attemptCount += 1;
  }

  /** 首次有效输出事件；之后的调用忽略。 */
  public recordFirstActivity(): void {
    if (this.#firstActivityAtMs === null) {
      this.#firstActivityAtMs = Date.now();
    }
  }

  public settle(
    status: Exclude<DifficultyTransportSampleStatus, "in-flight" | "missing">,
    eofObserved: boolean | null = null
  ): DifficultySampleTransportObservability {
    this.#status = status;
    return this.#doSettle(eofObserved);
  }

  public failed(error: unknown): DifficultySampleTransportObservability {
    const { status, eofObserved } = classifyLlmError(error);
    this.#status = status;
    return this.#doSettle(eofObserved);
  }

  #doSettle(eofObserved: boolean | null): DifficultySampleTransportObservability {
    if (this.#settledAtMs !== null) {
      throw new Error("DIFFICULTY_TRANSPORT_OBSERVER_ALREADY_SETTLED");
    }
    this.#settledAtMs = Date.now();
    this.#eofObserved = eofObserved;
    return this.snapshot();
  }

  public snapshot(): DifficultySampleTransportObservability {
    const endToEndLatencyMs =
      this.#settledAtMs === null ? null : this.#settledAtMs - this.#beganAtMs;
    const firstByteLatencyMs =
      this.#firstActivityAtMs === null ? null : this.#firstActivityAtMs - this.#beganAtMs;
    return {
      sampleId: this.#sampleId,
      status: this.#status,
      attemptCount: this.#attemptCount,
      retryCount: Math.max(0, this.#attemptCount - 1),
      firstByteLatencyMs,
      endToEndLatencyMs,
      eofObserved: this.#eofObserved
    };
  }
}

/**
 * 把观测钩子克隆进样本模型，返回安全的克隆模型；原模型 runtime 不被修改。
 * 克隆只追加 onTransportDispatch/onSafeOutputActivity，其余选项原样保留。
 */
export function attachDifficultyTransportObservability(
  model: PipelineModelConfig,
  observer: DifficultyTransportObserver
): PipelineModelConfig {
  const runtime: LlmRuntimeOptions = {
    ...model.runtime,
    onTransportDispatch: (attempt: number) => {
      observer.recordDispatch(attempt);
    },
    onSafeOutputActivity: () => {
      observer.recordFirstActivity();
    }
  };
  return { ...model, runtime };
}

function emptyTransportObservability(): DifficultySampleTransportObservability {
  return {
    sampleId: "",
    status: "missing",
    attemptCount: 0,
    retryCount: 0,
    firstByteLatencyMs: null,
    endToEndLatencyMs: null,
    eofObserved: null
  };
}

/** 从观测器 map 与 expected 集合构建聚合；缺失样本按 not-started 计入。 */
export function aggregateDifficultyTransport(input: {
  readonly expectedSampleIds: readonly string[];
  readonly observers: ReadonlyMap<string, DifficultyTransportObserver>;
}): DifficultyTransportAggregate {
  const bySampleId = new Map<string, DifficultySampleTransportObservability>();
  for (const [sampleId, observer] of input.observers) {
    if (!input.expectedSampleIds.includes(sampleId)) continue;
    bySampleId.set(sampleId, observer.snapshot());
  }
  for (const sampleId of input.expectedSampleIds) {
    if (!bySampleId.has(sampleId)) {
      bySampleId.set(sampleId, {
        sampleId,
        status: "missing",
        attemptCount: 0,
        retryCount: 0,
        firstByteLatencyMs: null,
        endToEndLatencyMs: null,
        eofObserved: null
      });
    }
  }

  const samples = [...bySampleId.values()].sort((left, right) =>
    left.sampleId.localeCompare(right.sampleId)
  );
  const attempted = samples.filter(
    (sample) => sample.status !== "missing"
  ).length;
  const completed = samples.filter(
    (sample) => sample.status === "succeeded"
  ).length;
  const failed = samples.filter(
    (sample) => sample.status === "failed" || sample.status === "cancelled"
  ).length;
  const cancelled = samples.filter(
    (sample) => sample.status === "cancelled"
  ).length;
  const missing = samples.filter(
    (sample) => sample.status === "missing"
  ).length;
  const inFlight = samples.filter(
    (sample) => sample.status === "in-flight"
  ).length;
  const totalAttempts = samples.reduce(
    (sum, sample) => sum + sample.attemptCount,
    0
  );
  const totalRetries = samples.reduce(
    (sum, sample) => sum + sample.retryCount,
    0
  );
  return {
    attempted,
    completed,
    failed,
    cancelled,
    missing,
    inFlight,
    totalAttempts,
    totalRetries,
    samples
  };
}

/** 聚合是否完整：没有 missing/in-flight/cancelled，且 attempted == expected。 */
export function isDifficultyTransportComplete(
  aggregate: DifficultyTransportAggregate
): boolean {
  return (
    aggregate.inFlight === 0 &&
    aggregate.missing === 0 &&
    aggregate.cancelled === 0 &&
    aggregate.attempted === aggregate.samples.length
  );
}
