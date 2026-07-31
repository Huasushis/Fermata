import { describe, expect, it, vi } from "vitest";
import {
  computeEffectiveLineCount,
  computeMaxBraceDepth,
  detectDataStructures,
  mapCodingSignalsToLevel,
  runCodingPipeline,
  type CodingSignals
} from "../src/pipelines/coding";
import type { ReviewTaskProblem } from "../src/pipelines/types";

describe("computeEffectiveLineCount", () => {
  it("跳过空行、纯注释行，行内注释和字符串不影响计数本身", () => {
    const code = [
      "#include <bits/stdc++.h>",
      "// 这是一整行注释，应该被跳过",
      "",
      "int main() {",
      "  int n; // 行内注释",
      '  std::cout << "// 这不是注释，只是字符串";',
      "  return 0;",
      "}"
    ].join("\n");
    // 8 行里：整行注释和空行各去掉 1 行，剩下 6 行有效代码。
    expect(computeEffectiveLineCount(code)).toBe(6);
  });

  it("块注释跨越多行时整体不计入有效行数", () => {
    const code = ["int main() {", "/*", "这一段", "都是注释", "*/", "  return 0;", "}"].join("\n");
    expect(computeEffectiveLineCount(code)).toBe(3);
  });
});

describe("computeMaxBraceDepth", () => {
  it("正确计算最大嵌套深度，字符串/注释里的花括号不计数", () => {
    const code = 'int main() { if (1) { for (;;) { std::cout << "{not a brace}"; } } }';
    expect(computeMaxBraceDepth(code)).toBe(3);
  });

  it("没有花括号时返回 0", () => {
    expect(computeMaxBraceDepth("print(1)")).toBe(0);
  });
});

describe("detectDataStructures", () => {
  it("命中清单里的关键词并返回最高权重", () => {
    const code = "struct SegmentTree { void build() {} }; DSU dsu;";
    const { labels, maxWeight } = detectDataStructures(code);
    expect(labels).toContain("线段树");
    expect(labels).toContain("并查集");
    expect(maxWeight).toBeGreaterThan(0);
  });

  it("什么都没命中时返回空数组和权重 0", () => {
    const { labels, maxWeight } = detectDataStructures("int main() { return 0; }");
    expect(labels).toEqual([]);
    expect(maxWeight).toBe(0);
  });
});

describe("mapCodingSignalsToLevel", () => {
  it("代码越短、嵌套越浅、没有特殊数据结构 -> 等级越低", () => {
    const trivial: CodingSignals = {
      effectiveLineCount: 5,
      maxNestingDepth: 1,
      detectedDataStructures: [],
      maxDataStructureWeight: 0
    };
    expect(mapCodingSignalsToLevel(trivial)).toBeLessThanOrEqual(2);
  });

  it("代码越长、嵌套越深、命中高权重数据结构 -> 等级越高", () => {
    const heavy: CodingSignals = {
      effectiveLineCount: 150,
      maxNestingDepth: 6,
      detectedDataStructures: ["网络流"],
      maxDataStructureWeight: 2.5
    };
    expect(mapCodingSignalsToLevel(heavy)).toBe(5);
  });

  it("结果永远落在 [1,5] 内的整数", () => {
    const result = mapCodingSignalsToLevel({
      effectiveLineCount: 0,
      maxNestingDepth: 0,
      detectedDataStructures: [],
      maxDataStructureWeight: 0
    });
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

const CODE_INSIDE_FENCE = ["int main() {", "  int dsu[100];", "  return 0;", "}"].join("\n");
const FULL_MODEL_REPLY = ["这是参考实现：", "```cpp", CODE_INSIDE_FENCE, "```"].join("\n");

describe("runCodingPipeline：整体接线", () => {
  it("从代码块里提取代码（不包含代码块外的说明文字）并统计信号", async () => {
    const fetchMock = vi.fn(async () => {
      const body = { choices: [{ message: { role: "assistant", content: FULL_MODEL_REPLY } }] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const result = await runCodingPipeline({
      problem,
      model: {
        spec: { provider: "aether" as const, model: "test-model", temperature: 0.3, thinking: false },
        credentials: { baseUrl: "https://llm.example.test/v1", apiKey: "sk-test" },
        runtime: { outputIdleTimeoutMs: 5_000, maxAttempts: 1, baseDelayMs: 1, fetch: fetchMock }
      }
    });
    expect(result.signals.effectiveLineCount).toBeGreaterThan(0);
    expect(result.signals.detectedDataStructures).toContain("并查集");
    // 提取出来的代码长度应该正好是代码块内部的长度，说明围栏外的说明文字被排除了。
    expect(result.referenceCodeLength).toBe(CODE_INSIDE_FENCE.length);
    expect(result.referenceCodeLength).toBeLessThan(FULL_MODEL_REPLY.length);
  });
});
