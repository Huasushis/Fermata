import { describe, expect, it, vi } from "vitest";
import { clampAndRoundDifficultyRating, runDifficultyPipeline } from "../src/pipelines/difficulty";
import type { ReviewTaskProblem } from "../src/pipelines/types";

describe("clampAndRoundDifficultyRating", () => {
  it.each([
    [750, 800],
    [800, 800],
    [1549, 1500],
    [1550, 1600], // Math.round 对 .5 向正无穷取整
    [3500, 3500],
    [3600, 3500],
    [-100, 800],
    [2001, 2000]
  ])("clampAndRoundDifficultyRating(%i) -> %i", (input, expected) => {
    expect(clampAndRoundDifficultyRating(input)).toBe(expected);
  });

  it("结果永远是 [800,3500] 内的整百数", () => {
    for (const value of [0, 799, 801, 1234, 5000, -9999]) {
      const result = clampAndRoundDifficultyRating(value);
      expect(result).toBeGreaterThanOrEqual(800);
      expect(result).toBeLessThanOrEqual(3500);
      expect(result % 100).toBe(0);
    }
  });
});

const problem: ReviewTaskProblem = {
  id: "problem-1",
  revision: 1,
  reviewRound: 1,
  contentHash: "a".repeat(64),
  title: "测试题目",
  type: "traditional",
  tagIds: ["dp"],
  basicStatement: "题面……",
  basicSolution: "题解……"
};

function completionResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content } }]
    }),
    { status: 200 }
  );
}

describe("runDifficultyPipeline：整体接线", () => {
  it("把 LLM 的原始 rating 夹到整百范围内再返回", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ max_tokens: 2_048 });
      return completionResponse('{"rating": 1730, "confidence": 0.8, "rationale": "中等题"}');
    });
    const result = await runDifficultyPipeline({
      problem,
      anchors: [{ contestId: 4, index: "A", rating: 800, summary: "入门题" }],
      model: {
        spec: { provider: "aether" as const, model: "test-model", temperature: 0.2, thinking: false },
        credentials: { baseUrl: "https://llm.example.test/v1", apiKey: "sk-test" },
        runtime: { outputIdleTimeoutMs: 5_000, maxAttempts: 1, baseDelayMs: 1, fetch: fetchMock }
      }
    });
    expect(result.rating).toBe(1700);
    expect(result.confidence).toBe(0.8);
    expect(result.rationale).toBe("中等题");
  });

  it("没有锚点时也能正常工作（只是提示词里不带锚点）", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.max_tokens).toBe(2_048);
      const joined = body.messages.map((m: { content: string }) => m.content).join("\n");
      expect(joined).not.toContain("参考锚点");
      return completionResponse('{"rating": 900, "confidence": 0.5, "rationale": "简单"}');
    });
    const result = await runDifficultyPipeline({
      problem,
      anchors: [],
      model: {
        spec: { provider: "aether" as const, model: "test-model", temperature: 0.2, thinking: false },
        credentials: { baseUrl: "https://llm.example.test/v1", apiKey: "sk-test" },
        runtime: { outputIdleTimeoutMs: 5_000, maxAttempts: 1, baseDelayMs: 1, fetch: fetchMock }
      }
    });
    expect(result.rating).toBe(900);
  });

  it("JSON 首轮失败后的修复轮仍使用同一个 difficulty 输出上限", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return completionResponse(
        requestBodies.length === 1
          ? "不是 JSON"
          : '{"rating": 2100, "confidence": 0.7, "rationale": "修复成功"}'
      );
    });

    const result = await runDifficultyPipeline({
      problem,
      anchors: [],
      model: {
        spec: { provider: "aether" as const, model: "test-model", temperature: 0.2, thinking: false },
        credentials: { baseUrl: "https://llm.example.test/v1", apiKey: "sk-test" },
        runtime: { outputIdleTimeoutMs: 5_000, maxAttempts: 1, baseDelayMs: 1, fetch: fetchMock }
      }
    });

    expect(result.rating).toBe(2_100);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies.map((body) => body.max_tokens)).toEqual([2_048, 2_048]);
  });
});
