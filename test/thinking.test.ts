import { describe, expect, it, vi } from "vitest";
import { mapThinkingSignalsToLevel, runThinkingPipeline, type ThinkingSignals } from "../src/pipelines/thinking";
import type { ReviewTaskProblem } from "../src/pipelines/types";

describe("mapThinkingSignalsToLevel", () => {
  const base: ThinkingSignals = {
    solved: true,
    approachSimilarity: 1,
    selfCorrections: 0,
    keyInsightCount: 0
  };

  it("解出来了、思路和标准题解完全一致、没有波折 -> 最低等级", () => {
    expect(mapThinkingSignalsToLevel(base)).toBe(1);
  });

  it("没解出来、思路差异很大、试错和洞察都很多 -> 最高等级", () => {
    const signals: ThinkingSignals = {
      solved: false,
      approachSimilarity: 0.1,
      selfCorrections: 5,
      keyInsightCount: 4
    };
    expect(mapThinkingSignalsToLevel(signals)).toBe(5);
  });

  it("没解出来总是比解出来（其它信号相同）等级更高或相等", () => {
    const solved: ThinkingSignals = { solved: true, approachSimilarity: 0.5, selfCorrections: 1, keyInsightCount: 1 };
    const notSolved: ThinkingSignals = { ...solved, solved: false };
    expect(mapThinkingSignalsToLevel(notSolved)).toBeGreaterThanOrEqual(mapThinkingSignalsToLevel(solved));
  });

  it("思路相似度越高，等级越低或相等（其它信号相同）", () => {
    const lowSimilarity: ThinkingSignals = { solved: true, approachSimilarity: 0.1, selfCorrections: 0, keyInsightCount: 0 };
    const highSimilarity: ThinkingSignals = { ...lowSimilarity, approachSimilarity: 0.9 };
    expect(mapThinkingSignalsToLevel(highSimilarity)).toBeLessThanOrEqual(mapThinkingSignalsToLevel(lowSimilarity));
  });

  it("结果永远落在 [1,5] 内的整数", () => {
    const extreme: ThinkingSignals = { solved: false, approachSimilarity: 0, selfCorrections: 50, keyInsightCount: 50 };
    const result = mapThinkingSignalsToLevel(extreme);
    expect(Number.isInteger(result)).toBe(true);
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThanOrEqual(5);
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

function textResponse(content: string, reasoning?: string): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content,
            ...(reasoning === undefined ? {} : { reasoning_content: reasoning })
          }
        }
      ]
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("runThinkingPipeline：整体接线", () => {
  it("solver 步骤不把题解发给模型，analyst 步骤会同时收到题解和 solver 的叙述", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      call += 1;
      const body = JSON.parse(String(init?.body));
      const joined = body.messages.map((m: { content: string }) => m.content).join("\n");
      if (call === 1) {
        expect(joined).not.toContain("题解……");
        return textResponse("我的解题过程：先尝试暴力……", "推理：先尝试暴力，然后优化");
      }
      expect(joined).toContain("推理：先尝试暴力，然后优化");
      expect(joined).toContain("题解……");
      return textResponse(
        '{"solved": true, "approachSimilarity": 0.7, "selfCorrections": 1, "keyInsightCount": 2, "rationale": "基本一致"}'
      );
    });

    const modelConfig = {
      spec: { provider: "aether" as const, model: "test-model", temperature: 0.2, thinking: true },
      credentials: { baseUrl: "https://llm.example.test/v1", apiKey: "sk-test" },
      runtime: { outputIdleTimeoutMs: 5_000, maxAttempts: 1, baseDelayMs: 1, fetch: fetchMock }
    };

    const result = await runThinkingPipeline({
      problem,
      solverModel: modelConfig,
      analystModel: modelConfig
    });

    expect(result.signals).toEqual({
      solved: true,
      approachSimilarity: 0.7,
      selfCorrections: 1,
      keyInsightCount: 2
    });
    expect(result.level).toBe(mapThinkingSignalsToLevel(result.signals));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("solver 没有 reasoning_content 时退化为用 content 本身作为解题过程", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        return textResponse("纯 content，没有单独的 reasoning");
      }
      const body = JSON.parse(String(init?.body));
      const joined = body.messages.map((m: { content: string }) => m.content).join("\n");
      expect(joined).toContain("纯 content，没有单独的 reasoning");
      return textResponse('{"solved": false, "approachSimilarity": 0.2, "selfCorrections": 0, "keyInsightCount": 0, "rationale": "没解出来"}');
    });
    const modelConfig = {
      spec: { provider: "aether" as const, model: "test-model", temperature: 0.2, thinking: true },
      credentials: { baseUrl: "https://llm.example.test/v1", apiKey: "sk-test" },
      runtime: { outputIdleTimeoutMs: 5_000, maxAttempts: 1, baseDelayMs: 1, fetch: fetchMock }
    };
    await runThinkingPipeline({ problem, solverModel: modelConfig, analystModel: modelConfig });
  });
});
