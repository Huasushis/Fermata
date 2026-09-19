import { describe, expect, it, vi } from "vitest";
import { scoreReviewTask } from "../src/scorer";
import type { PipelineModelConfig } from "../src/pipelines/types";
import { appConfig, review, settings, task } from "./helpers/scorer-fixture";
import { resolveRuntimeModel } from "../src/runtime-settings";

function response(content: string, finish = "stop") {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }), { headers: { "content-type": "application/json" } });
}
function setup(output: unknown) {
  const fetch = vi.fn().mockImplementationOnce(async () => response("合成审核结论，不代表准确性标定。"))
    .mockImplementation(async () => response(JSON.stringify(output)));
  const model: PipelineModelConfig = {
    credentials: { baseUrl: "https://llm.example.test/v1", apiKey: "synthetic" },
    spec: { provider: "aether", model: "deepseek-v4-flash", temperature: 0.1, thinking: true, thinkingRequest: "enabled", reasoningEffort: "max" },
    runtime: { fetch, firstOutputTimeoutMs: 600000, outputIdleTimeoutMs: 600000, maximumDurationMs: 600000, maxAttempts: 1, baseDelayMs: 1 }
  };
  return { fetch, model };
}
const { expectedRound: _round, ...modelReview } = review;

describe("正式评分器", () => {
  it("网页模型配置实际进入两轮 HTTP 请求，DeepSeek 使用 enabled/max", async () => {
    const { fetch, model } = setup(modelReview);
    const resolved = resolveRuntimeModel(appConfig, { ...settings, model: {
      baseUrl: "https://configured.example.test/v1", model: "deepseek-v4-flash", temperature: 0.3, thinking: true
    } }, { modelApiKey: "configured-synthetic-key" });
    expect(resolved).toBeDefined();
    await scoreReviewTask(task(), { ...model, ...resolved! }, []);
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url)).toBe("https://configured.example.test/v1/chat/completions");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer configured-synthetic-key");
      expect(JSON.parse(init.body).model).toBe("deepseek-v4-flash");
    }
    const semantic = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(semantic.temperature).toBe(0.3);
    expect(semantic.thinking).toEqual({ type: "enabled" });
    expect(semantic.reasoning_effort).toBe("max");
    expect(JSON.parse(fetch.mock.calls[1]![1].body).thinking).toEqual({ type: "disabled" });
  });

  it("两轮处理：深度思考 max 审题，再使用 JSON Schema 格式化；不需要查重资料", async () => {
    const { model, fetch } = setup(modelReview);
    const result = await scoreReviewTask(task(), model, []);
    expect(result).toEqual(review);
    expect(fetch).toHaveBeenCalledTimes(2);
    const semantic = JSON.parse(fetch.mock.calls[0]![1].body);
    const format = JSON.parse(fetch.mock.calls[1]![1].body);
    expect(semantic.model).toBe("deepseek-v4-flash");
    expect(semantic.thinking).toEqual({ type: "enabled" });
    expect(semantic.reasoning_effort).toBe("max");
    expect(semantic.response_format).toBeUndefined();
    expect(format.thinking).toEqual({ type: "disabled" });
    expect(format.reasoning_effort).toBeUndefined();
    expect(format.response_format).toEqual({ type: "json_object" });
    const target = JSON.parse(format.messages[0].content.split("完整 JSON Schema：\n")[1]);
    expect(target.properties.tagIds.items.enum).toEqual(["math"]);
    expect(JSON.stringify(semantic)).toContain("难度不能决定通过与否");
    expect(format.messages.at(-1).content).toBe("合成审核结论，不代表准确性标定。");
  });
  it.each([
    { tagIds: ["outside"] }, { tagIds: [] }, { tagIds: ["math", "math"] },
    { codeforcesDifficulty: 999 }, { thinkingLevel: 6 }, { expectedRound: 999 },
    { verdict: "maybe" }
  ])("不提交格式错误或目录外结果 %j", async (change) => {
    const { model } = setup({ ...modelReview, ...change });
    await expect(scoreReviewTask(task(), model, [])).rejects.toThrow();
  });
  it("第一次格式化失败后只修复一次", async () => {
    const { model, fetch } = setup(modelReview);
    fetch.mockReset().mockResolvedValueOnce(response("审核结论"))
      .mockResolvedValueOnce(response("invalid json"))
      .mockResolvedValueOnce(response(JSON.stringify(modelReview)));
    expect(await scoreReviewTask(task(), model, [])).toEqual(review);
    expect(fetch).toHaveBeenCalledTimes(3);
    const repair = JSON.parse(fetch.mock.calls[2]![1].body);
    expect(repair.response_format).toEqual({ type: "json_object" });
    expect(repair.thinking).toEqual({ type: "disabled" });
  });
  it("服务失败或生成被截断时不把残缺结果当成意见", async () => {
    const { model, fetch } = setup(modelReview);
    fetch.mockReset().mockResolvedValue(response("partial", "length"));
    await expect(scoreReviewTask(task(), model, [])).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("题目快照错误时不发送模型请求", async () => {
    const { model, fetch } = setup(modelReview);
    await expect(scoreReviewTask({ ...task(), assignmentId: "invalid" }, model, [])).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("不使用失效或属于旧题面版本的附加资料", async () => {
    const { model, fetch } = setup(modelReview);
    const input = task();
    const item = { id: "item", type: "note", source: "human" as const, sourcePluginId: null, visibility: "reviewer" as const, summary: "合成资料", data: {}, contentHash: input.problem.contentHash, createdAt: new Date().toISOString(), expiresAt: null };
    input.reviewItems.push(item, { ...item, id: "old", contentHash: "b".repeat(64) }, { ...item, id: "expired", expiresAt: new Date(0).toISOString() });
    await scoreReviewTask(input, model, []);
    const request = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(JSON.parse(request.messages.at(-1).content).reviewItems.map((entry: { id: string }) => entry.id)).toEqual(["item"]);
  });
});
