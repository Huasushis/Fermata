import { describe, expect, it } from "vitest";
import { extractHighestDuplicateSimilarity } from "../src/pipelines/verdict";
import {
  assessVerdictSyntheticDiagnostic,
  buildFabricatedSimilarityItem,
  buildPairedVerdictCasePlan
} from "../experiments/lib/verdict-evaluation-design";
import type { ReviewTaskProblem } from "../src/pipelines/types";

describe("verdict 合成接线诊断设计", () => {
  it("同一个可信样本成对生成 normal/duplicate expected id", () => {
    const items = [{ safeId: "sample-a", marker: 1 }, { safeId: "sample-b", marker: 2 }];
    const plan = buildPairedVerdictCasePlan(items, 2);
    expect(plan.expectedSampleIds).toEqual([
      "sample-a:normal",
      "sample-a:fabricated_duplicate",
      "sample-b:normal",
      "sample-b:fabricated_duplicate"
    ]);
    expect(plan.normal.map((entry) => entry.item)).toEqual(items);
    expect(plan.fabricatedDuplicate.map((entry) => entry.item)).toEqual(items);
    expect(new Set(plan.expectedSampleIds).size).toBe(4);
  });

  it("缺样本或重复安全编号在任何请求前失败", () => {
    expect(() => buildPairedVerdictCasePlan([{ safeId: "only" }], 2)).toThrow(
      "VERDICT_PAIRED_CASES_UNAVAILABLE"
    );
    expect(() =>
      buildPairedVerdictCasePlan([{ safeId: "same" }, { safeId: "same" }], 2)
    ).toThrow("VERDICT_PAIRED_CASE_IDS_INVALID");
  });

  it("执行即使完整，只要一条合成预期不满足也不能通过诊断", () => {
    const assessment = assessVerdictSyntheticDiagnostic([
      { caseKind: "normal", expectationMet: true },
      { caseKind: "normal", expectationMet: false },
      { caseKind: "fabricated_duplicate", expectationMet: true },
      { caseKind: "fabricated_duplicate", expectationMet: true }
    ], 2);
    expect(assessment.syntheticDiagnostics).toEqual({
      normal: { total: 2, metExpectation: 1 },
      fabricatedDuplicate: { total: 2, metExpectation: 2 }
    });
    expect(assessment.diagnosticPassed).toBe(false);
  });

  it("只有两组数量准确且逐例满足预期才通过诊断", () => {
    expect(assessVerdictSyntheticDiagnostic([
      { caseKind: "normal", expectationMet: true },
      { caseKind: "fabricated_duplicate", expectationMet: true }
    ], 1).diagnosticPassed).toBe(true);
    expect(assessVerdictSyntheticDiagnostic([
      { caseKind: "normal", expectationMet: true }
    ], 1).diagnosticPassed).toBe(false);
  });

  it("模型可见 summary 含同题证据，data 中的相似度仍能驱动阈值纯逻辑", () => {
    const problem: ReviewTaskProblem = {
      id: "synthetic",
      revision: 1,
      reviewRound: 1,
      contentHash: "0".repeat(64),
      title: "synthetic-safe-title",
      type: "traditional",
      tagIds: [],
      basicStatement: "synthetic statement",
      basicSolution: "synthetic solution"
    };
    const item = buildFabricatedSimilarityItem(
      problem,
      0.95,
      new Date("2026-08-01T00:00:00.000Z")
    );
    expect(item.summary).toContain("题面叙述、输入输出格式和数据范围均完全一致");
    expect(item.summary).toContain("95.0%");
    expect(extractHighestDuplicateSimilarity([item])).toBe(0.95);
    expect(item.createdAt).toBe("2026-08-01T00:00:00.000Z");
  });
});
