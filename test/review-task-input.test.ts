import { describe, expect, it } from "vitest";
import { toLegacyPipelineProblem } from "../src/review-task-input";
import type { RobotReviewTask } from "../src/urmotiv-schemas";

function problem(): RobotReviewTask["problem"] {
  return {
    id: "synthetic-problem",
    revision: 3,
    reviewRound: 2,
    contentHash: "a".repeat(64),
    title: "合成题目",
    type: "traditional",
    tagIds: ["basic.simulation"],
    content: {
      basicStatement: "合成基础题面",
      basicSolution: "合成基础题解",
      background: "合成背景",
      statement: "合成正式描述",
      inputFormat: "合成输入格式",
      outputFormat: "合成输出格式",
      constraints: "合成约束",
      solution: "合成详细题解",
      hints: "合成提示"
    },
    samples: [{
      safeId: "sample-001",
      input: "1\n",
      output: "1\n",
      explanation: "合成样例说明"
    }],
    limits: { timeMs: 1_000, memoryMiB: 256 }
  };
}

describe("机器人完整快照到旧流水线视图", () => {
  it("保留全部题面、样例、资源限制和两部分题解，不静默截断", () => {
    const converted = toLegacyPipelineProblem(problem());
    for (const expected of [
      "合成基础题面",
      "合成背景",
      "合成正式描述",
      "合成输入格式",
      "合成输出格式",
      "合成约束",
      "合成提示",
      "sample-001",
      "合成样例说明",
      "1000 ms",
      "256 MiB"
    ]) {
      expect(converted.basicStatement).toContain(expected);
    }
    expect(converted.basicSolution).toContain("合成基础题解");
    expect(converted.basicSolution).toContain("合成详细题解");
  });

  it("组装结果超过旧流水线安全上限时明确失败", () => {
    const oversized = problem();
    oversized.content.statement = "甲".repeat(2_000_000);
    expect(() => toLegacyPipelineProblem(oversized)).toThrow();
  });
});
