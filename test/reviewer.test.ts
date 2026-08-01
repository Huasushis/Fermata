import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import { ReviewerWorker, type ReviewerWorkerOptions } from "../src/reviewer";
import { SettingsConflictError, type SettingsStoreLike } from "../src/settings-store";
import {
  UrmotivApiError,
  UrmotivNetworkError,
  type UrmotivClientLike
} from "../src/urmotiv-client";
import type { FermataPublicSettings, RobotReviewTask } from "../src/urmotiv-schemas";

function createFakeSettingsStore(initial: FermataPublicSettings): SettingsStoreLike {
  let revision = 1;
  let settings = initial;
  return {
    get: () => ({ settings, revision }),
    update: (expectedRevision, next) => {
      if (expectedRevision !== revision) {
        throw new SettingsConflictError(expectedRevision, revision);
      }
      settings = next;
      revision += 1;
      return { settings, revision };
    }
  };
}

const appConfig: AppConfig = {
  urmotiv: { baseUrl: "https://urmotiv.example.test", robotToken: "urv_test_token_1234567890" },
  server: { port: 8720, managementToken: "management-token-1234567890", settingsPath: "./data/settings.json" },
  providers: { aether: { baseUrl: "https://llm.example.test/v1", apiKey: "sk-test" } },
  codeforces: null,
  models: {
    experimentVersion: "exp-test",
    defaults: { modelProfileName: "test-profile", pollingIntervalSeconds: 30, maximumConcurrentTasks: 2 },
    profiles: {
      "test-profile": {
        difficulty: { provider: "aether", model: "m", temperature: 0.2, thinking: false },
        thinking: {
          solver: { provider: "aether", model: "m", temperature: 0.4, thinking: true },
          analyst: { provider: "aether", model: "m", temperature: 0.1, thinking: false }
        },
        coding: { provider: "aether", model: "m", temperature: 0.3, thinking: false },
        verdict: { provider: "aether", model: "m", temperature: 0.1, thinking: false }
      }
    },
    retry: { maxAttempts: 1, baseDelayMs: 1 },
    timeouts: {
      llmFirstOutputMs: 120_000,
      llmOutputIdleMs: 120_000,
      llmMaximumDurationMs: 300_000,
      codeforcesRequestMs: 5_000
    },
    codeforces: { minimumRequestIntervalMs: 0 },
    thresholds: { duplicateSimilarityReject: 0.9 }
  }
};

function sampleTask(assignmentId: string): RobotReviewTask {
  return {
    assignmentId,
    leaseExpiresAt: "2026-07-26T00:05:00.000Z",
    problem: {
      id: "problem-1",
      revision: 3,
      reviewRound: 1,
      contentHash: "a".repeat(64),
      title: "样例题目",
      type: "traditional",
      tagIds: ["dp"],
      basicStatement: "题面……",
      basicSolution: "题解……"
    },
    reviewItems: []
  };
}

// 一个 JSON 对象同时包含 difficulty / thinking-analyst / verdict 三条流水线的结构化
// 输出需要的全部字段——三个 schema 都不是 strict 的，多余字段会被各自忽略，
// 这样一个 fetch mock 就能满足全部五次 LLM 调用（difficulty、thinking 的 solver
// 和 analyst、coding、verdict），不需要按 URL/内容区分请求。
const COMBINED_LLM_JSON = JSON.stringify({
  rating: 1500,
  confidence: 0.7,
  rationale: "评估理由",
  solved: true,
  approachSimilarity: 0.6,
  selfCorrections: 1,
  keyInsightCount: 1,
  verdict: "approve",
  qualityLevel: 3,
  mainImprovement: "建议补充说明",
  sameProblemAsExisting: false,
  privateNote: ""
});

function llmSuccessResponse(overrides: Readonly<Record<string, unknown>> = {}): Response {
  const combined = {
    ...(JSON.parse(COMBINED_LLM_JSON) as Record<string, unknown>),
    ...overrides
  };
  return new Response(
    JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(combined) } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * 反复推进 0ms 假时钟若干次，让一条很深的 await 链（fetch -> JSON 解析 ->
 * schema 校验 -> 下一步 fetch -> ... -> complete）逐个 microtask 地跑完。
 * 不用 vi.waitFor，避免依赖它和假时钟具体怎么交互这一点没法在这里跑起来验证。
 * rounds 给得比估算需要的多一些，多跑几轮的开销很小（不涉及真实等待）。
 */
async function flushAsync(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

interface FakeUrmotivClient extends UrmotivClientLike {
  readonly claimMock: ReturnType<typeof vi.fn>;
  readonly renewMock: ReturnType<typeof vi.fn>;
  readonly completeMock: ReturnType<typeof vi.fn>;
}

function createFakeUrmotivClient(requestTimeoutMs = 30_000): FakeUrmotivClient {
  const claimMock = vi.fn(async () => ({ items: [] }));
  const renewMock = vi.fn(async (assignmentId: string) => ({
    assignmentId,
    leaseExpiresAt: "2026-07-26T00:10:00.000Z"
  }));
  const completeMock = vi.fn(async (assignmentId: string) => ({
    assignmentId,
    accepted: true as const,
    problemStatus: "approved" as const
  }));
  return {
    requestTimeoutMs,
    claimMock,
    renewMock,
    completeMock,
    claim: claimMock,
    renew: renewMock,
    complete: completeMock
  };
}

function createReviewer(options: ReviewerWorkerOptions): ReviewerWorker {
  return new ReviewerWorker({
    ...options,
    productionEligibility: options.productionEligibility ?? (() => ({
      eligible: true,
      evidenceFingerprint: "a".repeat(64)
    }))
  });
}

let worker: ReviewerWorker | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-26T00:00:00.000Z"));
});

afterEach(async () => {
  // 每个测试结束前都应该已经让所有任务 promise 落地（settings/complete 或者
  // 主动 flush 过），避免 afterEach 永久等待测试自己遗留的在途任务。
  if (worker !== null) {
    await worker.stop();
    worker = null;
  }
  vi.useRealTimers();
});

describe("ReviewerWorker：基本轮询与处理", () => {
  it("start 后立即轮询、领取任务、跑完流水线并提交，之后 activeTasks 归零", async () => {
    const client = createFakeUrmotivClient();
    client.claimMock.mockResolvedValueOnce({ items: [sampleTask("3fa85f64-5717-4562-b3fc-2c963f66afa6")] });

    const settingsStore = createFakeSettingsStore({
      enabled: true,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 2,
      modelProfileName: "test-profile",
      experimentVersion: "exp-test"
    });

    worker = createReviewer({
      urmotivClient: client,
      settingsStore,
      appConfig,
      anchors: [],
      fetch: vi.fn(async () => llmSuccessResponse())
    });
    worker.start();
    await flushAsync();

    expect(client.claimMock).toHaveBeenCalledTimes(1);
    expect(client.completeMock).toHaveBeenCalledTimes(1);
    expect(client.completeMock).toHaveBeenCalledWith(
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      expect.objectContaining({
        requestId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        ),
        modelProfileName: "test-profile",
        experimentVersion: "exp-test"
      })
    );
    expect(worker.getStatus().activeTasks).toBe(0);
  });

  it("不同任务的完成操作生成不同 UUID", async () => {
    const client = createFakeUrmotivClient();
    client.claimMock.mockResolvedValueOnce({
      items: [
        sampleTask("3fa85f64-5717-4562-b3fc-2c963f66afa6"),
        sampleTask("3fa85f64-5717-4562-b3fc-2c963f66afa7")
      ]
    });
    const settingsStore = createFakeSettingsStore({
      enabled: true,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 2,
      modelProfileName: "test-profile",
      experimentVersion: "exp-test"
    });
    worker = createReviewer({
      urmotivClient: client,
      settingsStore,
      appConfig,
      anchors: [],
      fetch: vi.fn(async () => llmSuccessResponse())
    });
    worker.start();
    await flushAsync(100);

    expect(client.completeMock).toHaveBeenCalledTimes(2);
    const requestIds = client.completeMock.mock.calls.map((call) => call[1]?.requestId);
    expect(requestIds).toEqual([
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      expect.stringMatching(/^[0-9a-f-]{36}$/)
    ]);
    expect(new Set(requestIds).size).toBe(2);
  });

  it("完成交付重试耗尽后当前任务路径不会更换 UUID 再提交", async () => {
    const client = createFakeUrmotivClient();
    const assignmentId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    client.claimMock.mockResolvedValueOnce({ items: [sampleTask(assignmentId)] });
    client.completeMock.mockRejectedValueOnce(new UrmotivNetworkError("响应状态不确定"));
    const settingsStore = createFakeSettingsStore({
      enabled: true,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 1,
      modelProfileName: "test-profile",
      experimentVersion: "exp-test"
    });
    worker = createReviewer({
      urmotivClient: client,
      settingsStore,
      appConfig,
      anchors: [],
      fetch: vi.fn(async () => llmSuccessResponse())
    });
    worker.start();
    await flushAsync(100);
    await vi.advanceTimersByTimeAsync(60_000);
    await flushAsync();

    expect(client.completeMock).toHaveBeenCalledTimes(1);
    expect(client.completeMock.mock.calls[0]?.[1]?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("verdict 使用 config/models.yaml 快照中的查重阈值", async () => {
    const client = createFakeUrmotivClient();
    const assignmentId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const task = sampleTask(assignmentId);
    client.claimMock.mockResolvedValueOnce({
      items: [
        {
          ...task,
          reviewItems: [
            {
              id: "3fa85f64-5717-4562-b3fc-2c963f66afa7",
              type: "org.ustc.urmotiv.anklang.similarity",
              summary: "合成查重记录",
              data: { similarity: 0.95 },
              contentHash: task.problem.contentHash,
              createdAt: "2026-07-26T00:00:00.000Z"
            }
          ]
        }
      ]
    });
    const highThresholdConfig: AppConfig = {
      ...appConfig,
      models: {
        ...appConfig.models,
        thresholds: { duplicateSimilarityReject: 0.99 }
      }
    };
    const settingsStore = createFakeSettingsStore({
      enabled: true,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 2,
      modelProfileName: "test-profile",
      experimentVersion: "exp-test"
    });

    worker = createReviewer({
      urmotivClient: client,
      settingsStore,
      appConfig: highThresholdConfig,
      anchors: [],
      fetch: vi.fn(async () => llmSuccessResponse({ sameProblemAsExisting: true }))
    });
    worker.start();
    await flushAsync();

    expect(client.completeMock).toHaveBeenCalledWith(
      assignmentId,
      expect.objectContaining({ review: expect.objectContaining({ verdict: "approve" }) })
    );
  });

  it("claim 的 maximumTasks 不超过 maximumConcurrentTasks", async () => {
    const client = createFakeUrmotivClient();
    const settingsStore = createFakeSettingsStore({
      enabled: true,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 2,
      modelProfileName: "test-profile",
      experimentVersion: "exp-test"
    });
    worker = createReviewer({ urmotivClient: client, settingsStore, appConfig, anchors: [] });
    worker.start();
    await flushAsync();

    expect(client.claimMock).toHaveBeenCalledWith(expect.objectContaining({ maximumTasks: 2 }));
  });

  it("enabled 为 false 时不领取任务", async () => {
    const client = createFakeUrmotivClient();
    const settingsStore = createFakeSettingsStore({
      enabled: false,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 2,
      modelProfileName: "test-profile",
      experimentVersion: "exp-test"
    });
    worker = createReviewer({ urmotivClient: client, settingsStore, appConfig, anchors: [] });
    worker.start();
    await flushAsync();

    expect(client.claimMock).not.toHaveBeenCalled();
  });

  it("enabled 为 true 但 experimentVersion 仍是旧值时也拒绝领取任务", async () => {
    const client = createFakeUrmotivClient();
    const settingsStore = createFakeSettingsStore({
      enabled: true,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 2,
      modelProfileName: "test-profile",
      experimentVersion: "exp-old"
    });
    worker = createReviewer({ urmotivClient: client, settingsStore, appConfig, anchors: [] });
    worker.start();
    await flushAsync();

    expect(client.claimMock).not.toHaveBeenCalled();
  });

  it("enabled 与 experimentVersion 都匹配但没有生产资格证据时仍不领取任务", async () => {
    const client = createFakeUrmotivClient();
    const settingsStore = createFakeSettingsStore({
      enabled: true,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 2,
      modelProfileName: "test-profile",
      experimentVersion: "exp-test"
    });
    // 故意不用测试 helper 注入合格证据；生产门遗漏装配时也必须 fail-closed。
    worker = new ReviewerWorker({ urmotivClient: client, settingsStore, appConfig, anchors: [] });
    worker.start();
    await flushAsync();

    expect(client.claimMock).not.toHaveBeenCalled();
  });

  it("modelProfileName 在 config 里不存在时跳过轮询，不报错", async () => {
    const client = createFakeUrmotivClient();
    const settingsStore = createFakeSettingsStore({
      enabled: true,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 2,
      modelProfileName: "not-a-real-profile",
      experimentVersion: "exp-test"
    });
    worker = createReviewer({ urmotivClient: client, settingsStore, appConfig, anchors: [] });
    worker.start();
    await flushAsync();

    expect(client.claimMock).not.toHaveBeenCalled();
  });

  it("wake() 跳过当前的等待，立即触发下一轮轮询", async () => {
    const client = createFakeUrmotivClient();
    const settingsStore = createFakeSettingsStore({
      enabled: true,
      pollingIntervalSeconds: 3_600, // 很长的轮询间隔，不 wake 的话短时间内不会再轮询
      maximumConcurrentTasks: 2,
      modelProfileName: "test-profile",
      experimentVersion: "exp-test"
    });
    worker = createReviewer({ urmotivClient: client, settingsStore, appConfig, anchors: [] });
    worker.start();
    await flushAsync();
    expect(client.claimMock).toHaveBeenCalledTimes(1);

    worker.wake();
    await flushAsync();
    expect(client.claimMock).toHaveBeenCalledTimes(2);
  });

  it("提交时遇到 409（任务已丢失）不会崩溃，会正常清理 activeTasks", async () => {
    const client = createFakeUrmotivClient();
    client.claimMock.mockResolvedValueOnce({ items: [sampleTask("3fa85f64-5717-4562-b3fc-2c963f66afa6")] });
    client.completeMock.mockRejectedValueOnce(new UrmotivApiError(409, "版本已变化"));

    const settingsStore = createFakeSettingsStore({
      enabled: true,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 2,
      modelProfileName: "test-profile",
      experimentVersion: "exp-test"
    });
    worker = createReviewer({
      urmotivClient: client,
      settingsStore,
      appConfig,
      anchors: [],
      fetch: vi.fn(async () => llmSuccessResponse())
    });
    worker.start();
    await flushAsync();

    expect(client.completeMock).toHaveBeenCalledTimes(1);
    expect(worker.getStatus().activeTasks).toBe(0);
  });
});

describe("ReviewerWorker：续租", () => {
  it("一条付费流水线先失败时仍等待其余请求并继续续租", async () => {
    const client = createFakeUrmotivClient();
    const assignmentId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    client.claimMock.mockResolvedValueOnce({
      items: [sampleTask(assignmentId)]
    });
    const remainingRequests = createDeferred<Response>();
    let requestNumber = 0;
    const fetchMock = vi.fn(async () => {
      requestNumber += 1;
      if (requestNumber === 1) {
        return new Response("", { status: 503 });
      }
      await remainingRequests.promise;
      return llmSuccessResponse();
    });
    const settingsStore = createFakeSettingsStore({
      enabled: true,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 2,
      modelProfileName: "test-profile",
      experimentVersion: "exp-test"
    });
    worker = createReviewer({
      urmotivClient: client,
      settingsStore,
      appConfig,
      anchors: [],
      leaseSeconds: 10,
      fetch: fetchMock
    });
    worker.start();
    await flushAsync();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(worker.getStatus().activeTasks).toBe(1);
    let stopFinished = false;
    const stopPromise = worker.stop().then(() => {
      stopFinished = true;
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await flushAsync();
    expect(client.renewMock).toHaveBeenCalled();
    expect(stopFinished).toBe(false);
    expect(worker.getStatus().activeTasks).toBe(1);

    remainingRequests.resolve(llmSuccessResponse());
    await flushAsync(100);
    await stopPromise;

    expect(stopFinished).toBe(true);
    expect(client.completeMock).not.toHaveBeenCalled();
    expect(worker.getStatus().activeTasks).toBe(0);
    worker = null;
  });

  it("租约过半后自动续租，用续租时任务当时的 leaseExpiresAt 作为 expectedLeaseExpiresAt", async () => {
    const client = createFakeUrmotivClient();
    const assignmentId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    client.claimMock.mockResolvedValueOnce({ items: [sampleTask(assignmentId)] });
    client.renewMock.mockResolvedValueOnce({ assignmentId, leaseExpiresAt: "2026-07-26T00:20:00.000Z" });

    // 用一个不会自动 resolve 的 fetch，让流水线永远卡在"进行中"，这样才能在
    // 任务还活着的时候把时钟拨到续租时间点去验证续租确实发生了。
    const deferred = createDeferred<Response>();
    const settingsStore = createFakeSettingsStore({
      enabled: true,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 2,
      modelProfileName: "test-profile",
      experimentVersion: "exp-test"
    });
    worker = createReviewer({
      urmotivClient: client,
      settingsStore,
      appConfig,
      anchors: [],
      leaseSeconds: 10, // 续租间隔 = max(5000, 10000/3) = 5000ms
      fetch: vi.fn(async () => {
        // 每次调用都要返回一个新的 Response：同一个 Response 的正文只能读一次，
        // 流水线会发起多次 LLM 请求，复用同一实例会在第二次 json() 时失败。
        await deferred.promise;
        return llmSuccessResponse();
      })
    });
    worker.start();
    await flushAsync();
    expect(client.claimMock).toHaveBeenCalledTimes(1);
    expect(worker.getStatus().activeTasks).toBe(1); // 流水线还卡在 fetch 上，任务还在处理中

    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.renewMock).toHaveBeenCalledWith(
      assignmentId,
      expect.objectContaining({ expectedLeaseExpiresAt: "2026-07-26T00:05:00.000Z" })
    );

    // 放开卡住的 fetch，让任务能正常结束，避免 afterEach 永久等待测试自己
    // 遗留的在途任务。
    deferred.resolve(llmSuccessResponse());
    await flushAsync();
    expect(client.completeMock).toHaveBeenCalledTimes(1);
    expect(worker.getStatus().activeTasks).toBe(0);
  });

  it("流水线完成时若续租仍在途，等待续租响应后用最新租约提交", async () => {
    const client = createFakeUrmotivClient();
    const assignmentId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const nextLeaseExpiresAt = "2026-07-26T00:20:00.000Z";
    client.claimMock.mockResolvedValueOnce({
      items: [sampleTask(assignmentId)]
    });
    const renewal = createDeferred<{
      assignmentId: string;
      leaseExpiresAt: string;
    }>();
    client.renewMock.mockImplementationOnce(async () => renewal.promise);
    const modelRequests = createDeferred<Response>();
    const settingsStore = createFakeSettingsStore({
      enabled: true,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 2,
      modelProfileName: "test-profile",
      experimentVersion: "exp-test"
    });
    worker = createReviewer({
      urmotivClient: client,
      settingsStore,
      appConfig,
      anchors: [],
      leaseSeconds: 10,
      fetch: vi.fn(async () => {
        await modelRequests.promise;
        return llmSuccessResponse();
      })
    });
    worker.start();
    await flushAsync();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.renewMock).toHaveBeenCalledTimes(1);

    modelRequests.resolve(llmSuccessResponse());
    await flushAsync(100);
    expect(client.completeMock).not.toHaveBeenCalled();
    expect(worker.getStatus().activeTasks).toBe(1);

    renewal.resolve({ assignmentId, leaseExpiresAt: nextLeaseExpiresAt });
    await flushAsync(100);

    expect(client.completeMock).toHaveBeenCalledWith(
      assignmentId,
      expect.objectContaining({
        expectedLeaseExpiresAt: nextLeaseExpiresAt
      })
    );
    expect(worker.getStatus().activeTasks).toBe(0);
  });

  it("续租遇到 409 时把任务标记为放弃，流水线跑完后不再提交", async () => {
    const client = createFakeUrmotivClient();
    const assignmentId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    client.claimMock.mockResolvedValueOnce({ items: [sampleTask(assignmentId)] });
    client.renewMock.mockRejectedValueOnce(new UrmotivApiError(409, "任务已被抢"));

    const deferred = createDeferred<Response>();
    const settingsStore = createFakeSettingsStore({
      enabled: true,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 2,
      modelProfileName: "test-profile",
      experimentVersion: "exp-test"
    });
    worker = createReviewer({
      urmotivClient: client,
      settingsStore,
      appConfig,
      anchors: [],
      leaseSeconds: 10,
      fetch: vi.fn(async () => {
        // 每次调用都要返回一个新的 Response：同一个 Response 的正文只能读一次，
        // 流水线会发起多次 LLM 请求，复用同一实例会在第二次 json() 时失败。
        await deferred.promise;
        return llmSuccessResponse();
      })
    });
    worker.start();
    await flushAsync();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.renewMock).toHaveBeenCalledTimes(1);
    await flushAsync();

    expect(worker.getStatus().activeTasks).toBe(0);
    expect(client.completeMock).not.toHaveBeenCalled();
    // 清理测试里故意不理会 AbortSignal 的假 fetch；真实 fetch 会被请求信号停止。
    deferred.resolve(llmSuccessResponse());
    await flushAsync();

    expect(worker.getStatus().activeTasks).toBe(0);
    expect(client.completeMock).not.toHaveBeenCalled();
  });

  it.each([401, 403])(
    "续租收到 %i 时停止当前付费请求且不按网络故障重试",
    async (status) => {
      const client = createFakeUrmotivClient();
      const assignmentId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
      client.claimMock.mockResolvedValueOnce({
        items: [sampleTask(assignmentId)]
      });
      client.renewMock.mockRejectedValueOnce(
        new UrmotivApiError(status, "固定拒绝")
      );

      const deferred = createDeferred<Response>();
      const settingsStore = createFakeSettingsStore({
        enabled: true,
        pollingIntervalSeconds: 30,
        maximumConcurrentTasks: 2,
        modelProfileName: "test-profile",
        experimentVersion: "exp-test"
      });
      worker = createReviewer({
        urmotivClient: client,
        settingsStore,
        appConfig,
        anchors: [],
        leaseSeconds: 10,
        fetch: vi.fn(async () => {
          await deferred.promise;
          return llmSuccessResponse();
        })
      });
      worker.start();
      await flushAsync();

      await vi.advanceTimersByTimeAsync(5_000);
      await flushAsync();
      expect(worker.getStatus().activeTasks).toBe(0);
      expect(client.completeMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.renewMock).toHaveBeenCalledTimes(1);
      deferred.resolve(llmSuccessResponse());
    }
  );

  it("续租网络结果不确定时短间隔重试复用同一 UUID，成功后的新一轮改用新 UUID", async () => {
    const client = createFakeUrmotivClient();
    const assignmentId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    client.claimMock.mockResolvedValueOnce({ items: [sampleTask(assignmentId)] });
    client.renewMock
      .mockRejectedValueOnce(new UrmotivNetworkError("临时网络故障"))
      .mockResolvedValueOnce({
        assignmentId,
        leaseExpiresAt: "2026-07-26T00:20:00.000Z"
      })
      .mockResolvedValueOnce({
        assignmentId,
        leaseExpiresAt: "2026-07-26T00:25:00.000Z"
      });

    const deferred = createDeferred<Response>();
    const settingsStore = createFakeSettingsStore({
      enabled: true,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 2,
      modelProfileName: "test-profile",
      experimentVersion: "exp-test"
    });
    worker = createReviewer({
      urmotivClient: client,
      settingsStore,
      appConfig,
      anchors: [],
      leaseSeconds: 10,
      fetch: vi.fn(async () => {
        await deferred.promise;
        return llmSuccessResponse();
      })
    });
    worker.start();
    await flushAsync();

    await vi.advanceTimersByTimeAsync(5_000);
    await flushAsync();
    expect(client.renewMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsync();
    expect(client.renewMock).toHaveBeenCalledTimes(2);
    const firstInput = client.renewMock.mock.calls[0]?.[1];
    const retryInput = client.renewMock.mock.calls[1]?.[1];
    expect(firstInput).toEqual(retryInput);
    expect(firstInput).toEqual(expect.objectContaining({
      requestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      ),
      expectedLeaseExpiresAt: "2026-07-26T00:05:00.000Z",
      leaseSeconds: 10
    }));

    await vi.advanceTimersByTimeAsync(5_000);
    await flushAsync();
    expect(client.renewMock).toHaveBeenCalledTimes(3);
    const nextCycleInput = client.renewMock.mock.calls[2]?.[1];
    expect(nextCycleInput).toEqual(expect.objectContaining({
      expectedLeaseExpiresAt: "2026-07-26T00:20:00.000Z"
    }));
    expect(nextCycleInput?.requestId).not.toBe(firstInput?.requestId);

    deferred.resolve(llmSuccessResponse());
    await flushAsync();
    expect(client.completeMock).toHaveBeenCalledTimes(1);
    expect(worker.getStatus().activeTasks).toBe(0);
  });

  it.each([429, 500])(
    "续租收到可重试的 HTTP %i 时跨短间隔仍复用同一 UUID 和载荷",
    async (status) => {
      const client = createFakeUrmotivClient();
      const assignmentId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
      client.claimMock.mockResolvedValueOnce({ items: [sampleTask(assignmentId)] });
      client.renewMock
        .mockRejectedValueOnce(new UrmotivApiError(status, "暂时不可用"))
        .mockResolvedValueOnce({
          assignmentId,
          leaseExpiresAt: "2026-07-26T00:20:00.000Z"
        });

      const deferred = createDeferred<Response>();
      const settingsStore = createFakeSettingsStore({
        enabled: true,
        pollingIntervalSeconds: 30,
        maximumConcurrentTasks: 2,
        modelProfileName: "test-profile",
        experimentVersion: "exp-test"
      });
      worker = createReviewer({
        urmotivClient: client,
        settingsStore,
        appConfig,
        anchors: [],
        leaseSeconds: 10,
        fetch: vi.fn(async () => {
          await deferred.promise;
          return llmSuccessResponse();
        })
      });
      worker.start();
      await flushAsync();

      await vi.advanceTimersByTimeAsync(5_000);
      await flushAsync();
      await vi.advanceTimersByTimeAsync(1_000);
      await flushAsync();

      expect(client.renewMock).toHaveBeenCalledTimes(2);
      expect(client.renewMock.mock.calls[1]?.[1]).toEqual(
        client.renewMock.mock.calls[0]?.[1]
      );

      deferred.resolve(llmSuccessResponse());
      await flushAsync();
    }
  );

  it("续租重试预算使用客户端实际 120 秒超时，预算不足时不启动越界请求", async () => {
    const client = createFakeUrmotivClient(120_000);
    const assignmentId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const task = sampleTask(assignmentId);
    client.claimMock.mockResolvedValueOnce({
      items: [{ ...task, leaseExpiresAt: "2026-07-26T00:01:00.000Z" }]
    });
    client.renewMock.mockRejectedValueOnce(new UrmotivNetworkError("响应状态不确定"));
    const deferred = createDeferred<Response>();
    const settingsStore = createFakeSettingsStore({
      enabled: true,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 1,
      modelProfileName: "test-profile",
      experimentVersion: "exp-test"
    });
    worker = createReviewer({
      urmotivClient: client,
      settingsStore,
      appConfig,
      anchors: [],
      leaseSeconds: 10,
      fetch: vi.fn(async () => {
        await deferred.promise;
        return llmSuccessResponse();
      })
    });
    worker.start();
    await flushAsync();

    await vi.advanceTimersByTimeAsync(5_000);
    await flushAsync();
    expect(client.renewMock).toHaveBeenCalledTimes(1);
    expect(worker.getStatus().activeTasks).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.renewMock).toHaveBeenCalledTimes(1);
    expect(client.completeMock).not.toHaveBeenCalled();

    deferred.resolve(llmSuccessResponse());
    await flushAsync();
  });
});

describe("ReviewerWorker：停机", () => {
  it("stop() 在任务未完成时持续等待，任务完成后才结束", async () => {
    const client = createFakeUrmotivClient();
    const assignmentId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    client.claimMock.mockResolvedValueOnce({ items: [sampleTask(assignmentId)] });

    const deferred = createDeferred<Response>();
    const settingsStore = createFakeSettingsStore({
      enabled: true,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 2,
      modelProfileName: "test-profile",
      experimentVersion: "exp-test"
    });
    worker = createReviewer({
      urmotivClient: client,
      settingsStore,
      appConfig,
      anchors: [],
      leaseSeconds: 10,
      fetch: vi.fn(async () => {
        await deferred.promise;
        return llmSuccessResponse();
      })
    });
    worker.start();
    await flushAsync();
    expect(worker.getStatus().activeTasks).toBe(1);

    let stopFinished = false;
    const stopPromise = worker.stop().then(() => {
      stopFinished = true;
    });
    // 停机尚未完成时调用 start() 必须被忽略，不能启动一代新的轮询和续租。
    worker.start();

    // 跨过旧实现的 30 秒停机时限；任务还没完成时 stop 仍不能返回，而且续租
    // 必须继续，不能因为进入停机流程就让昂贵的模型请求失去租约。
    await vi.advanceTimersByTimeAsync(30_001);
    expect(stopFinished).toBe(false);
    expect(client.completeMock).not.toHaveBeenCalled();
    expect(client.renewMock).toHaveBeenCalled();
    expect(client.claimMock).toHaveBeenCalledTimes(1);

    deferred.resolve(llmSuccessResponse());
    await flushAsync();
    await stopPromise;

    expect(stopFinished).toBe(true);
    expect(client.completeMock).toHaveBeenCalledTimes(1);
    expect(worker.getStatus().activeTasks).toBe(0);

    const renewalCountAfterStop = client.renewMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.renewMock).toHaveBeenCalledTimes(renewalCountAfterStop);

    worker = null; // 已经手动 stop 过了，避免 afterEach 重复调用
  });

  it("stop() 之后不会再触发新的轮询", async () => {
    const client = createFakeUrmotivClient();
    const settingsStore = createFakeSettingsStore({
      enabled: true,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 2,
      modelProfileName: "test-profile",
      experimentVersion: "exp-test"
    });
    worker = createReviewer({ urmotivClient: client, settingsStore, appConfig, anchors: [] });
    worker.start();
    await flushAsync();
    expect(client.claimMock).toHaveBeenCalledTimes(1);

    await worker.stop();
    expect(worker.getStatus().workerRunning).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.claimMock).toHaveBeenCalledTimes(1); // 没有新增调用

    worker = null; // 已经手动 stop 过了，避免 afterEach 重复调用
  });
});
