/**
 * difficulty 评测路径的每样本传输可观测性（脱敏）测试。
 *
 * 契约：
 *   - 4 样本 × 上限 2 的 fail-closed 边界：总传输尝试数封顶 8，永不出现第 9 次
 *     （难度路径不经过 FairLlmRequestScheduler，上限来自 model.runtime.maxAttempts）。
 *   - 429 重试递增每次真实尝试；重试数 = 尝试数 - 1。
 *   - 流式/JSON 成功时记录首字节（首个有效输出事件）与端到端延迟，EOF 观测为真。
 *   - cancelled / missing / in-flight 都让聚合判为不完整。
 *   - 聚合只包含脱敏计数与时间戳，绝不含题面、正文、回文、密钥或端点。
 */
import { describe, expect, it, vi } from "vitest";
import type { ReviewTaskProblem } from "../src/pipelines/types";
import {
  aggregateDifficultyTransport,
  attachDifficultyTransportObservability,
  DifficultyTransportObserver,
  isDifficultyTransportComplete
} from "../experiments/lib/difficulty-transport-observability";
import { runDifficultyPipeline } from "../src/pipelines/difficulty";

const problem: ReviewTaskProblem = {
  id: "problem-1",
  revision: 1,
  reviewRound: 1,
  contentHash: "f".repeat(64),
  title: "测试题目",
  type: "traditional",
  tagIds: ["dp"],
  basicStatement: "题面……",
  basicSolution: "题解……"
};

function jsonCompletionResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content } }]
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function eventStreamChunk(content: string): Uint8Array {
  const event = JSON.stringify({
    choices: [{ delta: { content }, finish_reason: null }]
  });
  return new TextEncoder().encode(`data: ${event}\n\n`);
}

function stopEventStreamChunk(): Uint8Array {
  return new TextEncoder().encode(
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  );
}

function buildModel(runtimeOverrides: Record<string, unknown> = {}) {
  return {
    spec: {
      provider: "aether" as const,
      model: "deepseek-v4-flash",
      temperature: 0.2,
      thinking: false,
      thinkingRequest: "enabled" as const,
      reasoningEffort: "max" as const
    },
    credentials: { baseUrl: "https://llm.example.test/v1", apiKey: "sk-test" },
    runtime: {
      outputIdleTimeoutMs: 5_000,
      maxAttempts: 2,
      baseDelayMs: 1,
      ...runtimeOverrides
    }
  };
}

describe("DifficultyTransportObserver 记录", () => {
  it("只有 settle 一次；重复 settle 抛错", () => {
    const observer = new DifficultyTransportObserver("sample-x");
    observer.recordDispatch(1);
    observer.recordDispatch(2);
    observer.recordFirstActivity();
    const first = observer.settle("succeeded", true);
    expect(() => observer.settle("succeeded", true)).toThrow(
      "DIFFICULTY_TRANSPORT_OBSERVER_ALREADY_SETTLED"
    );
    expect(first.attemptCount).toBe(2);
    expect(first.retryCount).toBe(1);
    expect(first.eofObserved).toBe(true);
    expect(first.endToEndLatencyMs).toBeGreaterThanOrEqual(0);
    expect(first.firstByteLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("单次成功请求记录 1 次尝试、0 次重试、EOF 为真", async () => {
    const fetchMock = vi.fn(async () => jsonCompletionResponse(
      '{"rating": 1700, "confidence": 0.8, "rationale": "中等"}'
    ));
    const observer = new DifficultyTransportObserver("success-sample");
    const result = await runDifficultyPipeline({
      problem,
      anchors: [{ contestId: 4, index: "A", rating: 800, summary: "入门题" }],
      model: attachDifficultyTransportObservability(
        buildModel({ fetch: fetchMock as typeof fetch }),
        observer
      )
    });
    expect(result.rating).toBe(1700);
    const snapshot = observer.settle("succeeded", true);
    expect(snapshot.attemptCount).toBe(1);
    expect(snapshot.retryCount).toBe(0);
    expect(snapshot.eofObserved).toBe(true);
    expect(snapshot.endToEndLatencyMs).not.toBeNull();
    expect(snapshot.firstByteLatencyMs).not.toBeNull();
  });
});

describe("传输尝试上限：4 样本 × 上限 2，永不第 9 次", () => {
  it("并发始终 429 时总尝试数封顶 8，每个样本恰好 2 次，绝不出现第 9 次", async () => {
    let totalFetchCalls = 0;
    const always429 = vi.fn(async () => {
      totalFetchCalls += 1;
      // fail-closed 探针断言本身：不允许第 9 次 fetch 被调度。
      if (totalFetchCalls > 8) {
        throw new Error("NINTH_ATTEMPT_SCHEDULED");
      }
      return new Response("{}", { status: 429 });
    });
    const samples = ["s1", "s2", "s3", "s4"];

    const runOne = async (id: string) => {
      const observer = new DifficultyTransportObserver(id);
      const model = attachDifficultyTransportObservability(
        buildModel({ fetch: always429 as typeof fetch }),
        observer
      );
      try {
        await runDifficultyPipeline({
          problem,
          anchors: [{ contestId: 1, index: "B", rating: 1200, summary: "中等" }],
          model
        });
      } catch (error) {
        // onInferenceError 路径：最终失败时结算观测器。
        observer.failed(error);
      }
      return observer;
    };

    const settled = await Promise.all(samples.map(runOne));
    // 4 × 上限 2 = 8；永不第 9 次（NINTH_ATTEMPT 未抛出即通过）。
    expect(always429).toHaveBeenCalledTimes(8);
    expect(totalFetchCalls).toBe(8);
    for (const observer of settled) {
      const snapshot = observer.snapshot();
      expect(snapshot.status).toBe("failed");
      expect(snapshot.attemptCount).toBe(2);
      expect(snapshot.retryCount).toBe(1);
    }
  });

  it("single fetch always 429 (cap 3) 时尝试数精确为 3、重试数 2", async () => {
    const always429 = vi.fn(async () => new Response("{}", { status: 429 }));
    const observer = new DifficultyTransportObserver("cap-three");
    try {
      await runDifficultyPipeline({
        problem,
        anchors: [],
        model: attachDifficultyTransportObservability(
          buildModel({
            maxAttempts: 3,
            fetch: always429 as typeof fetch
          }),
          observer
        )
      });
    } catch (error) {
      // onInferenceError 路径：最终失败时结算观测器。
      observer.failed(error);
    }
    const snapshot = observer.snapshot();
    expect(snapshot.status).toBe("failed");
    expect(snapshot.attemptCount).toBe(3);
    expect(snapshot.retryCount).toBe(2);
    expect(always429).toHaveBeenCalledTimes(3);
  });

  it("流式成功时首字节在停止事件前记录，停止/EOF 后才结算；EOF 观测为真", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(eventStreamChunk('{"rating": 2'));
        }
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    ));
    const observer = new DifficultyTransportObserver("stream-sample");
    const pending = runDifficultyPipeline({
      problem,
      anchors: [],
      model: attachDifficultyTransportObservability(
        buildModel({ fetch: fetchMock as typeof fetch }),
        observer
      )
    });
    // 首个有效输出事件到达：首字节必须已被记录且样本仍处于在途状态。
    await vi.waitFor(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return observer.snapshot().firstByteLatencyMs !== null;
    });
    expect(observer.snapshot().status).toBe("in-flight");
    // 补齐正文并正常结束流（stop + DONE + EOF）。
    streamController.enqueue(eventStreamChunk('300, "confidence": 0.9, "rationale": "中"}'));
    streamController.enqueue(stopEventStreamChunk());
    streamController.close();
    const result = await pending;
    expect(result.rating).toBe(2300);
    observer.settle("succeeded", true);
    const snapshot = observer.snapshot();
    expect(snapshot.firstByteLatencyMs).not.toBeNull();
    expect(snapshot.endToEndLatencyMs).not.toBeNull();
    expect(snapshot.eofObserved).toBe(true);
    expect(snapshot.attemptCount).toBe(1);
  });
});

describe("聚合与完整性", () => {
  it("missing/in-flight/cancelled 样本都让聚合判为 incomplete", () => {
    const inFlight = new DifficultyTransportObserver("in-flight");
    // 不 settle，保持 in-flight。
    const cancelled = new DifficultyTransportObserver("cancelled");
    cancelled.failed(Object.assign(new Error("cancelled request"), { code: "LLM_CANCELLED" }));
    const done = new DifficultyTransportObserver("done");
    done.recordDispatch(1);
    done.settle("succeeded", true);
    const aggregate = aggregateDifficultyTransport({
      expectedSampleIds: ["done", "never-started", "in-flight", "cancelled"],
      observers: new Map([
        ["done", done],
        ["in-flight", inFlight],
        ["cancelled", cancelled]
      ])
    });
    expect(isDifficultyTransportComplete(aggregate)).toBe(false);
    expect(aggregate.completed).toBe(1);
    expect(aggregate.missing).toBe(1);
    expect(aggregate.inFlight).toBe(1);
    expect(aggregate.cancelled).toBe(1);
    expect(aggregate.attempted).toBe(3);
    expect(aggregate.totalAttempts).toBe(1);
    expect(aggregate.totalRetries).toBe(0);
    expect(aggregate.samples).toHaveLength(4);

    // 未生成的样本以 missing 计入。
    const neverStarted = aggregate.samples.find(
      (sample) => sample.sampleId === "never-started"
    );
    expect(neverStarted?.status).toBe("missing");
  });

  it("failed(cancelled) 在 cancelled 样本时保留尝试计数且 EOF 为空", () => {
    const observer = new DifficultyTransportObserver("cancelled-sample");
    observer.recordDispatch(1);
    observer.recordDispatch(2);
    const cancelledError = Object.assign(new Error("cancelled request"), {
      code: "LLM_CANCELLED"
    });
    const snapshot = observer.failed(cancelledError);
    expect(snapshot.status).toBe("cancelled");
    expect(snapshot.attemptCount).toBe(2);
    expect(snapshot.retryCount).toBe(1);
    expect(snapshot.eofObserved).toBeNull();
  });

  it("全部成功且无缺失/在途时，聚合判为完整", () => {
    const observers = new Map<string, DifficultyTransportObserver>();
    for (const id of ["a", "b"]) {
      const o = new DifficultyTransportObserver(id);
      o.recordDispatch(1);
      o.settle("succeeded", true);
      observers.set(id, o);
    }
    const aggregate = aggregateDifficultyTransport({
      expectedSampleIds: ["a", "b"],
      observers
    });
    expect(isDifficultyTransportComplete(aggregate)).toBe(true);
    expect(aggregate.completed).toBe(2);
    expect(aggregate.attempted).toBe(2);
    expect(aggregate.totalAttempts).toBe(2);
  });

  it("聚合 JSON 序列化不含题面、响应正文或密钥（白名单字段）", () => {
    const observer = new DifficultyTransportObserver("safe-sample");
    observer.recordDispatch(1);
    observer.settle("succeeded", true);
    const aggregate = aggregateDifficultyTransport({
      expectedSampleIds: ["safe-sample"],
      observers: new Map([["safe-sample", observer]])
    });
    const sampleKeys = Object.keys(aggregate.samples[0] as object).sort();
    const expectedSafeKeys = [
      "attemptCount",
      "endToEndLatencyMs",
      "eofObserved",
      "firstByteLatencyMs",
      "retryCount",
      "sampleId",
      "status"
    ];
    expect(sampleKeys).toEqual(expectedSafeKeys);
    for (const rawMarker of ["题面", "statement", "secret", "Bearer", "apiKey", "sk-test"]) {
      expect(JSON.stringify(aggregate)).not.toContain(rawMarker);
    }
  });

  it("aggregate 从不包含未在 expected 中的观察器", () => {
    const stray = new DifficultyTransportObserver("stray");
    stray.recordDispatch(1);
    stray.settle("succeeded", true);
    const aggregate = aggregateDifficultyTransport({
      expectedSampleIds: ["only"],
      observers: new Map([["stray", stray]])
    });
    expect(aggregate.samples).toHaveLength(1);
    expect(aggregate.samples[0]?.sampleId).toBe("only");
    expect(aggregate.samples[0]?.status).toBe("missing");
    expect(aggregate.attempted).toBe(0);
    expect(aggregate.totalAttempts).toBe(0);
  });
});
