import { describe, expect, it, vi } from "vitest";
import {
  extractHighestDuplicateSimilarity,
  runVerdictPipeline,
  shouldForceRejectAsDuplicate
} from "../src/pipelines/verdict";
import type { ReviewTaskItem, ReviewTaskProblem } from "../src/pipelines/types";

describe("shouldForceRejectAsDuplicate", () => {
  it("相似度超过阈值且模型确认同题时才强制拒绝", () => {
    expect(shouldForceRejectAsDuplicate(0.95, true, 0.9)).toBe(true);
  });

  it("相似度超过阈值但模型不确认同题时不强制拒绝", () => {
    expect(shouldForceRejectAsDuplicate(0.95, false, 0.9)).toBe(false);
  });

  it("模型确认同题但相似度没超过阈值时不强制拒绝", () => {
    expect(shouldForceRejectAsDuplicate(0.5, true, 0.9)).toBe(false);
  });

  it("正好等于阈值时不触发（严格大于）", () => {
    expect(shouldForceRejectAsDuplicate(0.9, true, 0.9)).toBe(false);
  });

  it("读取调用方的阈值，而不是隐含使用 0.9", () => {
    expect(shouldForceRejectAsDuplicate(0.95, true, 0.94)).toBe(true);
    expect(shouldForceRejectAsDuplicate(0.95, true, 0.95)).toBe(false);
    expect(shouldForceRejectAsDuplicate(0.95, true, 0.96)).toBe(false);
  });
});

function reviewItem(overrides: Partial<ReviewTaskItem>): ReviewTaskItem {
  return {
    id: "item-1",
    type: "anklang.duplicate_check",
    summary: "查重结果",
    data: undefined,
    contentHash: "a".repeat(64),
    createdAt: "2026-07-26T00:00:00.000Z",
    ...overrides
  };
}

describe("extractHighestDuplicateSimilarity", () => {
  it("能从 data.similarity 直接读取", () => {
    const items = [reviewItem({ data: { similarity: 0.42 } })];
    expect(extractHighestDuplicateSimilarity(items)).toBe(0.42);
  });

  it("能从 data.topSimilarity 读取", () => {
    const items = [reviewItem({ data: { topSimilarity: 0.77 } })];
    expect(extractHighestDuplicateSimilarity(items)).toBe(0.77);
  });

  it("能从 data.candidates[].similarity 里取最大值", () => {
    const items = [
      reviewItem({ data: { candidates: [{ similarity: 0.3 }, { similarity: 0.88 }, { similarity: 0.1 }] } })
    ];
    expect(extractHighestDuplicateSimilarity(items)).toBe(0.88);
  });

  it("多条 reviewItem 时取全局最大值", () => {
    const items = [
      reviewItem({ id: "a", data: { similarity: 0.2 } }),
      reviewItem({ id: "b", data: { similarity: 0.6 } })
    ];
    expect(extractHighestDuplicateSimilarity(items)).toBe(0.6);
  });

  it("data 是无法识别的形状或没有相似度信息时返回 0，不报错", () => {
    const items = [
      reviewItem({ data: undefined }),
      reviewItem({ data: { unrelatedField: "x" } }),
      reviewItem({ data: "just a string" }),
      reviewItem({ data: 123 })
    ];
    expect(extractHighestDuplicateSimilarity(items)).toBe(0);
  });

  it("没有 reviewItem 时返回 0", () => {
    expect(extractHighestDuplicateSimilarity([])).toBe(0);
  });
});

const problem: ReviewTaskProblem = {
  id: "problem-1",
  revision: 3,
  reviewRound: 2,
  contentHash: "a".repeat(64),
  title: "测试题目",
  type: "traditional",
  tagIds: ["dp"],
  basicStatement: "题面……",
  basicSolution: "题解……"
};

const modelConfig = (fetchMock: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) => ({
  spec: { provider: "aether" as const, model: "test-model", temperature: 0.1, thinking: false },
  credentials: { baseUrl: "https://llm.example.test/v1", apiKey: "sk-test" },
  runtime: { outputIdleTimeoutMs: 5_000, maxAttempts: 1, baseDelayMs: 1, fetch: fetchMock }
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(payload) } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

describe("runVerdictPipeline：整体接线", () => {
  it("付费请求前拒绝超出 0-1 的阈值快照", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    await expect(
      runVerdictPipeline({
        problem,
        reviewItems: [],
        difficulty: { rating: 1500, confidence: 0.8, rationale: "中等" },
        thinking: {
          level: 3,
          signals: { solved: true, approachSimilarity: 0.5, selfCorrections: 1, keyInsightCount: 1 },
          solverNarrativeLength: 100,
          rationale: "还行"
        },
        coding: {
          level: 2,
          signals: {
            effectiveLineCount: 20,
            maxNestingDepth: 2,
            detectedDataStructures: [],
            maxDataStructureWeight: 0
          },
          referenceCodeLength: 200
        },
        expectedRound: 2,
        duplicateSimilarityRejectThreshold: 1.1,
        model: modelConfig(fetchMock)
      })
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("正常情况下透传模型的 verdict，并产出满足 reviewInputSchema 的 review", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        verdict: "approve",
        qualityLevel: 4,
        mainImprovement: "建议补充边界数据范围说明。",
        sameProblemAsExisting: false,
        privateNote: "内部备注"
      })
    );
    const result = await runVerdictPipeline({
      problem,
      reviewItems: [],
      difficulty: { rating: 1500, confidence: 0.8, rationale: "中等" },
      thinking: { level: 3, signals: { solved: true, approachSimilarity: 0.5, selfCorrections: 1, keyInsightCount: 1 }, solverNarrativeLength: 100, rationale: "还行" },
      coding: { level: 2, signals: { effectiveLineCount: 20, maxNestingDepth: 2, detectedDataStructures: [], maxDataStructureWeight: 0 }, referenceCodeLength: 200 },
      expectedRound: 2,
      duplicateSimilarityRejectThreshold: 0.9,
      model: modelConfig(fetchMock)
    });

    expect(result.forcedDuplicateReject).toBe(false);
    expect(result.review).toEqual({
      verdict: "approve",
      codeforcesDifficulty: 1500,
      qualityLevel: 4,
      thinkingLevel: 3,
      codingLevel: 2,
      tagIds: [],
      improvements: "建议补充边界数据范围说明。",
      privateNote: "内部备注",
      expectedRound: 2
    });
  });

  it("已有审核条目相似度超过阈值且模型确认同题时，不管模型给的 verdict 是什么都强制改判为 reject", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        verdict: "approve", // 模型自己觉得可以过，但阈值规则应该覆盖它
        qualityLevel: 5,
        mainImprovement: "无",
        sameProblemAsExisting: true,
        privateNote: ""
      })
    );
    const result = await runVerdictPipeline({
      problem,
      reviewItems: [reviewItem({ data: { similarity: 0.97 } })],
      difficulty: { rating: 1200, confidence: 0.9, rationale: "简单" },
      thinking: { level: 2, signals: { solved: true, approachSimilarity: 0.9, selfCorrections: 0, keyInsightCount: 0 }, solverNarrativeLength: 50, rationale: "容易" },
      coding: { level: 1, signals: { effectiveLineCount: 10, maxNestingDepth: 1, detectedDataStructures: [], maxDataStructureWeight: 0 }, referenceCodeLength: 100 },
      expectedRound: 1,
      duplicateSimilarityRejectThreshold: 0.9,
      model: modelConfig(fetchMock)
    });

    expect(result.forcedDuplicateReject).toBe(true);
    expect(result.duplicateSimilarityRejectThreshold).toBe(0.9);
    expect(result.review.verdict).toBe("reject");
    expect(result.review.improvements).toContain("疑似重复题目");
  });

  it("相似度高但模型不认为是同一道题时，不强制改判", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        verdict: "approve",
        qualityLevel: 4,
        mainImprovement: "无",
        sameProblemAsExisting: false,
        privateNote: ""
      })
    );
    const result = await runVerdictPipeline({
      problem,
      reviewItems: [reviewItem({ data: { similarity: 0.97 } })],
      difficulty: { rating: 1200, confidence: 0.9, rationale: "简单" },
      thinking: { level: 2, signals: { solved: true, approachSimilarity: 0.9, selfCorrections: 0, keyInsightCount: 0 }, solverNarrativeLength: 50, rationale: "容易" },
      coding: { level: 1, signals: { effectiveLineCount: 10, maxNestingDepth: 1, detectedDataStructures: [], maxDataStructureWeight: 0 }, referenceCodeLength: 100 },
      expectedRound: 1,
      duplicateSimilarityRejectThreshold: 0.9,
      model: modelConfig(fetchMock)
    });

    expect(result.forcedDuplicateReject).toBe(false);
    expect(result.review.verdict).toBe("approve");
  });
});
