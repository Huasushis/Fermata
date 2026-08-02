import { describe, expect, it, vi } from "vitest";
import { extractHighestDuplicateSimilarity } from "../src/pipelines/verdict";
import {
  assertVerdictCaseGoldBinding,
  assessVerdictSyntheticDiagnostic,
  buildVerdictCaseGoldDataset,
  buildFabricatedSimilarityItem,
  buildPairedVerdictCasePlan,
  runVerdictBlindCaseBatch,
  scoreVerdictBlindPredictions,
  selectVerdictContentOnlyItems,
  verdictInferenceConfigurationFingerprint,
  verdictPredictionLogFields,
  verdictReportConfigurationFingerprint
} from "../experiments/lib/verdict-evaluation-design";
import type { ReviewTaskProblem } from "../src/pipelines/types";
import { buildBlindContentDataset } from "../experiments/lib/blind-evaluation";

function blindProblem(id: string): ReviewTaskProblem {
  return {
    id: `opaque-${id}`,
    revision: 1,
    reviewRound: 1,
    contentHash: id.padEnd(64, "0").slice(0, 64),
    title: `opaque-${id}`,
    type: "traditional",
    tagIds: ["synthetic"],
    basicStatement: `statement-${id}`,
    basicSolution: `solution-${id}`
  };
}

function verdictFixture() {
  const content = buildBlindContentDataset({
    datasetId: "verdict-development",
    purpose: "development",
    samples: [
      { safeId: "sample-a", problem: blindProblem("a") },
      { safeId: "sample-b", problem: blindProblem("b") },
      { safeId: "sample-c", problem: blindProblem("c") }
    ]
  });
  const selected = selectVerdictContentOnlyItems({
    items: content.samples,
    count: 2,
    seed: "fixed-selection-v1"
  });
  const plan = buildPairedVerdictCasePlan(selected, 2);
  const cases = [...plan.normal, ...plan.fabricatedDuplicate];
  const caseById = new Map(cases.map((entry) => [entry.sampleId, entry] as const));
  const ratingSentinel = 31_337;
  const gold = buildVerdictCaseGoldDataset({
    content,
    plan,
    samples: plan.expectedSampleIds.map((sampleId, index) => {
      const diagnosticCase = caseById.get(sampleId)!;
      return {
        sampleId,
        contentSafeId: diagnosticCase.item.safeId,
        contentHash: diagnosticCase.item.problem.contentHash,
        caseKind: diagnosticCase.caseKind,
        gold: diagnosticCase.caseKind === "normal"
          ? {
              rating: ratingSentinel + index,
              expectedVerdict: "not_reject" as const,
              expectedForcedDuplicateReject: false
            }
          : {
              rating: ratingSentinel + index,
              expectedVerdict: "reject" as const,
              expectedForcedDuplicateReject: true
            }
      };
    })
  });
  return { content, plan, cases, gold, ratingSentinel };
}

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

  it("固定 seed 只按 content 身份选择，不读取 rating 或人工标签", () => {
    const { content } = verdictFixture();
    const first = selectVerdictContentOnlyItems({
      items: content.samples,
      count: 2,
      seed: "fixed-selection-v1"
    });
    const second = selectVerdictContentOnlyItems({
      items: [...content.samples].reverse(),
      count: 2,
      seed: "fixed-selection-v1"
    });
    expect(first.map((entry) => entry.safeId)).toEqual(
      second.map((entry) => entry.safeId)
    );
    expect(JSON.stringify(first)).not.toContain("rating");
  });

  it("检查点指纹只绑定推理配置；gold 只改变收束后的报告指纹", () => {
    const inferenceFingerprint = verdictInferenceConfigurationFingerprint({
      contentFingerprint: "a".repeat(64),
      modelFingerprint: "b".repeat(64)
    });
    const firstReport = verdictReportConfigurationFingerprint({
      inferenceConfigurationFingerprint: inferenceFingerprint,
      caseGoldFingerprint: "c".repeat(64)
    });
    const secondReport = verdictReportConfigurationFingerprint({
      inferenceConfigurationFingerprint: inferenceFingerprint,
      caseGoldFingerprint: "d".repeat(64)
    });
    expect(firstReport).not.toBe(secondReport);
    expect(inferenceFingerprint).toBe(verdictInferenceConfigurationFingerprint({
      contentFingerprint: "a".repeat(64),
      modelFingerprint: "b".repeat(64)
    }));
  });

  it("两组所有推理结束并冻结预测后才连接 strict case gold", async () => {
    const { content, plan, cases, gold, ratingSentinel } = verdictFixture();
    let releaseLast = (): void => undefined;
    const lastCanFinish = new Promise<void>((resolve) => {
      releaseLast = resolve;
    });
    let notifyAllStarted = (): void => undefined;
    const allStarted = new Promise<void>((resolve) => {
      notifyAllStarted = resolve;
    });
    let started = 0;
    const scoreAfterAll = vi.fn((predictions) =>
      scoreVerdictBlindPredictions({
        content,
        plan,
        gold,
        predictions,
        requireComplete: true
      })
    );
    const observed = runVerdictBlindCaseBatch({
      content,
      cases,
      concurrency: cases.length,
      infer: async (diagnosticCase) => {
        started += 1;
        if (started === cases.length) {
          notifyAllStarted();
        }
        if (diagnosticCase.sampleId === cases.at(-1)!.sampleId) {
          await lastCanFinish;
        }
        return diagnosticCase.caseKind === "normal"
          ? {
              verdict: "approve",
              forcedDuplicateReject: false,
              highestKnownSimilarity: 0,
              appliedDuplicateSimilarityRejectThreshold: 0.9
            }
          : {
              verdict: "reject",
              forcedDuplicateReject: true,
              highestKnownSimilarity: 0.95,
              appliedDuplicateSimilarityRejectThreshold: 0.9
            };
      }
    }).then(scoreAfterAll);

    await allStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(scoreAfterAll).not.toHaveBeenCalled();
    releaseLast();
    const scored = await observed;
    expect(scoreAfterAll).toHaveBeenCalledOnce();
    const frozenPredictions = scoreAfterAll.mock.calls[0]![0];
    const serialized = JSON.stringify(frozenPredictions);
    expect(serialized).not.toContain("expectedVerdict");
    expect(serialized).not.toContain("expectationMet");
    expect(serialized).not.toContain("rating");
    expect(serialized).not.toContain(String(ratingSentinel));
    expect(scored.every((entry) => entry.expectationMet)).toBe(true);
    expect(scored.some((entry) => entry.rating >= ratingSentinel)).toBe(true);
    expect(JSON.stringify(verdictPredictionLogFields(
      frozenPredictions[0]!.prediction
    ))).not.toMatch(/rating|expected|expectation/i);
  });

  it("gold 的预期结论、case 身份或指纹被替换时严格拒绝", () => {
    const { content, plan, gold } = verdictFixture();
    expect(() => assertVerdictCaseGoldBinding({
      content,
      plan,
      gold: {
        ...gold,
        samples: gold.samples.map((sample, index) =>
          index === 0
            ? {
                ...sample,
                gold: { ...sample.gold, expectedVerdict: "reject" as const }
              }
            : sample
        )
      }
    })).toThrow();
    expect(() => assertVerdictCaseGoldBinding({
      content,
      plan,
      gold: { ...gold, caseFingerprint: "f".repeat(64) }
    })).toThrow("VERDICT_CASE_GOLD_MISMATCH");
  });

  it("首个失败后不启动排队 case，并等待已经在途的 case 收束", async () => {
    const { content, cases } = verdictFixture();
    let notifySecondStarted = (): void => undefined;
    const secondStarted = new Promise<void>((resolve) => {
      notifySecondStarted = resolve;
    });
    let releaseSecond = (): void => undefined;
    const secondCanFinish = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let settled = false;
    const infer = vi.fn(async (_diagnosticCase, index: number) => {
      if (index === 0) {
        await secondStarted;
        throw Object.assign(new Error("fixed failure"), { code: "LLM_CANCELLED" });
      }
      notifySecondStarted();
      await secondCanFinish;
      return {
        verdict: "approve",
        forcedDuplicateReject: false,
        highestKnownSimilarity: 0,
        appliedDuplicateSimilarityRejectThreshold: 0.9
      };
    });
    const observed = runVerdictBlindCaseBatch({
      content,
      cases,
      concurrency: 2,
      infer,
      onInferenceError: () => undefined
    }).then(
      () => ({ succeeded: true as const }),
      () => ({ succeeded: false as const })
    );
    void observed.then(() => {
      settled = true;
    });

    await secondStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(infer).toHaveBeenCalledTimes(2);
    releaseSecond();
    expect(await observed).toEqual({ succeeded: false });
    expect(infer).toHaveBeenCalledTimes(2);
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
      tagIds: ["synthetic.tag"],
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
