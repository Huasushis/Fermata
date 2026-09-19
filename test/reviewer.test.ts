import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewerWorker } from "../src/reviewer";
import { scoreReviewTask } from "../src/scorer";
import { UrmotivApiError, UrmotivNetworkError } from "../src/urmotiv-client";
import type { ClaimRobotReviewTasksResponse } from "../src/urmotiv-schemas";
import { appConfig, review, settings, task } from "./helpers/scorer-fixture";

vi.mock("../src/scorer", () => ({ scoreReviewTask: vi.fn() }));
const score = vi.mocked(scoreReviewTask);
let worker: ReviewerWorker | undefined;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup(change = {}) {
  const current = { ...settings, ...change };
  const client = {
    requestTimeoutMs: 30000,
    claim: vi.fn(async (): Promise<ClaimRobotReviewTasksResponse> => ({ items: [] })),
    renew: vi.fn(async (assignmentId: string) => ({ assignmentId, leaseExpiresAt: new Date(Date.now() + 300000).toISOString() })),
    complete: vi.fn(async (assignmentId: string) => ({ assignmentId, accepted: true as const, problemStatus: "pending_review" as const }))
  };
  worker = new ReviewerWorker({ urmotivClient: client, settingsStore: { get: () => ({ settings: current, revision: 1 }), update: () => { throw new Error("unused"); } }, appConfig, anchors: [] });
  return { client, current, worker };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-19T00:00:00Z"));
  score.mockReset().mockResolvedValue(review);
});
afterEach(async () => { await worker?.stop(); worker = undefined; vi.useRealTimers(); });

describe("机器人任务运行和交付", () => {
  it("没有查重条目也能领取并提交，绑定当前修订、目录及轮次", async () => {
    const { client, worker } = setup();
    const input = task();
    client.claim.mockResolvedValueOnce({ items: [input] });
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(score).toHaveBeenCalledOnce();
    expect(client.complete).toHaveBeenCalledWith(input.assignmentId, expect.objectContaining({ expectedProblemRevision: 3, expectedTagCatalogVersion: 4, expectedLeaseExpiresAt: input.leaseExpiresAt, review }));
    expect(worker.getStatus().activeTasks).toBe(0);
  });
  it.each([{ enabled: false }, { experimentVersion: "old" }, { modelProfileName: "missing" }])("未启用或设置失配时不领取 %j", async (change) => {
    const { client, worker } = setup(change);
    worker.start(); await vi.advanceTimersByTimeAsync(0);
    expect(client.claim).not.toHaveBeenCalled();
  });
  it("每批领取不超过空闲并发数，重复任务不重复启动", async () => {
    const { client, worker } = setup({ maximumConcurrentTasks: 2 });
    const pending = deferred<typeof review>();
    score.mockReturnValue(pending.promise);
    const input = task();
    client.claim.mockResolvedValue({ items: [input, input] });
    worker.start(); await vi.advanceTimersByTimeAsync(0);
    expect(client.claim).toHaveBeenLastCalledWith({ maximumTasks: 2, leaseSeconds: 300 });
    await vi.advanceTimersByTimeAsync(30000);
    expect(client.claim).toHaveBeenLastCalledWith({ maximumTasks: 1, leaseSeconds: 300 });
    expect(score).toHaveBeenCalledOnce();
    pending.resolve(review); await vi.advanceTimersByTimeAsync(0);
    expect(client.complete).toHaveBeenCalledOnce();
  });
  it("达到并发上限时等待空位，多题可以同时审题", async () => {
    const { client, worker } = setup();
    const pending = deferred<typeof review>(); score.mockReturnValue(pending.promise);
    client.claim.mockResolvedValueOnce({ items: [task(), task("22222222-2222-4222-8222-222222222222")] });
    worker.start(); await vi.advanceTimersByTimeAsync(30000);
    expect(score).toHaveBeenCalledTimes(2); expect(client.claim).toHaveBeenCalledOnce();
    pending.resolve(review); await vi.advanceTimersByTimeAsync(0);
    expect(client.complete).toHaveBeenCalledTimes(2);
  });
  it("过期任务不调用模型", async () => {
    const { client, worker } = setup();
    client.claim.mockResolvedValueOnce({ items: [{ ...task(), leaseExpiresAt: new Date().toISOString() }] });
    worker.start(); await vi.advanceTimersByTimeAsync(0);
    expect(score).not.toHaveBeenCalled(); expect(client.complete).not.toHaveBeenCalled();
  });
  it("模型失败不提交虚假意见，释放并发并继续轮询", async () => {
    const { client, worker } = setup(); score.mockRejectedValueOnce(new Error("SYNTHETIC_INVALID_JSON"));
    client.claim.mockResolvedValueOnce({ items: [task()] });
    worker.start(); await vi.advanceTimersByTimeAsync(30000);
    expect(client.complete).not.toHaveBeenCalled(); expect(client.claim).toHaveBeenCalledTimes(2); expect(worker.getStatus().activeTasks).toBe(0);
  });
  it.each([401, 403, 404, 409, 500])("完成请求失败 %s 不在当前链重复提交", async (status) => {
    const { client, worker } = setup(); client.claim.mockResolvedValueOnce({ items: [task()] });
    client.complete.mockRejectedValueOnce(new UrmotivApiError(status, "合成错误", { code: "SYNTHETIC" }));
    worker.start(); await vi.advanceTimersByTimeAsync(0);
    expect(client.complete).toHaveBeenCalledOnce(); expect(worker.getStatus().activeTasks).toBe(0);
  });
  it("领取失败后下一轮恢复，wake 可提前轮询", async () => {
    const { client, worker } = setup(); client.claim.mockRejectedValueOnce(new Error("SYNTHETIC_NETWORK"));
    worker.start(); await vi.advanceTimersByTimeAsync(0); worker.wake(); await vi.advanceTimersByTimeAsync(0);
    expect(client.claim).toHaveBeenCalledTimes(2);
  });
});

describe("续租和停机", () => {
  it("处理期间持续续租，提交使用最新租期", async () => {
    const { client, worker } = setup(); const pending = deferred<typeof review>(); score.mockReturnValue(pending.promise);
    client.claim.mockResolvedValueOnce({ items: [task()] });
    worker.start(); await vi.advanceTimersByTimeAsync(100000);
    expect(client.renew).toHaveBeenCalledOnce();
    pending.resolve(review); await vi.advanceTimersByTimeAsync(0);
    expect(client.complete).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedLeaseExpiresAt: new Date(Date.now() + 300000).toISOString() }));
  });
  it("续租在途时等待响应后才提交", async () => {
    const { client, worker } = setup(); const pending = deferred<typeof review>(); score.mockReturnValue(pending.promise);
    const renewal = deferred<{ assignmentId: string; leaseExpiresAt: string }>(); client.renew.mockReturnValueOnce(renewal.promise);
    const input = task(); client.claim.mockResolvedValueOnce({ items: [input] });
    worker.start(); await vi.advanceTimersByTimeAsync(100000); pending.resolve(review); await vi.advanceTimersByTimeAsync(0);
    expect(client.complete).not.toHaveBeenCalled();
    const renewed = new Date(Date.now() + 600000).toISOString(); renewal.resolve({ assignmentId: input.assignmentId, leaseExpiresAt: renewed });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.complete).toHaveBeenCalledWith(input.assignmentId, expect.objectContaining({ expectedLeaseExpiresAt: renewed }));
  });
  it.each([401, 403, 404, 409])("续租被拒 %s 后取消模型且不提交", async (status) => {
    const { client, worker } = setup(); const pending = deferred<typeof review>(); score.mockReturnValue(pending.promise);
    client.claim.mockResolvedValueOnce({ items: [task()] }); client.renew.mockRejectedValueOnce(new UrmotivApiError(status, "合成错误", { code: "SYNTHETIC" }));
    worker.start(); await vi.advanceTimersByTimeAsync(100000);
    expect(score.mock.calls[0]?.[1].runtime.signal?.aborted).toBe(true);
    pending.resolve(review); await vi.advanceTimersByTimeAsync(0);
    expect(client.complete).not.toHaveBeenCalled();
  });
  it("续租网络故障重试复用请求标识", async () => {
    const { client, worker } = setup(); const pending = deferred<typeof review>(); score.mockReturnValue(pending.promise);
    client.claim.mockResolvedValueOnce({ items: [task()] }); client.renew.mockRejectedValueOnce(new UrmotivNetworkError("network"));
    worker.start(); await vi.advanceTimersByTimeAsync(130000);
    expect(client.renew).toHaveBeenCalledTimes(2); expect(client.renew.mock.calls[0]).toEqual(client.renew.mock.calls[1]);
    pending.resolve(review); await vi.advanceTimersByTimeAsync(0);
  });
  it("停机等当前任务完成并停止领取新任务", async () => {
    const { client, worker } = setup(); const pending = deferred<typeof review>(); score.mockReturnValue(pending.promise);
    client.claim.mockResolvedValueOnce({ items: [task()] }); worker.start(); await vi.advanceTimersByTimeAsync(0);
    let stopped = false; const stopping = worker.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(100000); expect(stopped).toBe(false); expect(client.renew).toHaveBeenCalledOnce();
    pending.resolve(review); await stopping; await vi.advanceTimersByTimeAsync(30000);
    expect(client.claim).toHaveBeenCalledOnce(); expect(client.complete).toHaveBeenCalledOnce();
  });
});
