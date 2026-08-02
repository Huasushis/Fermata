import { describe, expect, it } from "vitest";
import { hashCanonicalValue } from "../src/review-flow/evidence";
import {
  historicalReviewRubric,
  historicalReviewRubricDigest,
  historicalReviewRubricPromptDigest,
  historicalReviewRubricPromptText,
  historicalReviewRubricSchema
} from "../src/review-flow/historical-rubric";

const expectedRubricDigest = "35a1753e60f96674a0bdd3b5c1f06f51fd44093a1d5c9ff814ff9f8fdf316ed0";
const expectedPromptDigest = "585de4618d1dcebbc5c962adbf230a0049fa53aff1d0719edbae17f6b920e50f";

describe("历史人工审核安全规范", () => {
  it("冻结版本、来源、隔离规则和材料边界", () => {
    expect(historicalReviewRubric).toMatchObject({
      schemaVersion: 1,
      rubricVersion: "ustc-historical-human-review-rubric-v1",
      sourceBasis: "来自两版历史人工审核中通过侧与否决侧的安全聚合对照。",
      tasteLearningScope: {
        confirmedPriorProblemOrDuplicateCases: "excluded",
        submitterReportedDifficulty: "fully_excluded"
      },
      coreMaterials: {
        statement: "required_core",
        solution: "required_core",
        referenceImplementation: "optional_nonblocking"
      }
    });
    expect(Object.isFrozen(historicalReviewRubric)).toBe(true);
    expect(Object.isFrozen(historicalReviewRubric.approvalEvidenceAxes)).toBe(true);
    expect(Object.isFrozen(historicalReviewRubric.rejectionEvidenceAxes)).toBe(true);
    expect(historicalReviewRubricSchema.safeParse({
      ...historicalReviewRubric,
      unexpected: true
    }).success).toBe(false);
    expect(historicalReviewRubricSchema.safeParse({
      ...historicalReviewRubric,
      rubricVersion: "unversioned"
    }).success).toBe(false);
  });

  it("固定通过侧、否决侧和难度用途，不把正确性清单当作命题品味", () => {
    expect(historicalReviewRubric.approvalEvidenceAxes.map((axis) => axis.id)).toEqual([
      "fun_and_contestant_experience",
      "overall_preference",
      "material_preparation"
    ]);
    expect(historicalReviewRubric.rejectionEvidenceAxes.map((axis) => axis.id)).toEqual([
      "template_novelty_and_depth",
      "icpc_fit",
      "implementation_balance",
      "fairness_judgeability_naturalness"
    ]);
    expect(historicalReviewRubric.difficultyPolicy).toMatchObject({
      observedOnBothSides: true,
      verdictUse: "problemset_role_only"
    });
    expect(historicalReviewRubric.evidencePolicy).toEqual({
      correctnessRole: "baseline_not_taste",
      requirePositiveAndNegativeEvidence: true,
      hiddenMaterialInference: "forbidden"
    });
  });

  it("canonical digest 可复算，并以固定值阻止静默漂移", () => {
    expect(hashCanonicalValue(historicalReviewRubric)).toBe(historicalReviewRubricDigest);
    expect(hashCanonicalValue(historicalReviewRubricPromptText)).toBe(
      historicalReviewRubricPromptDigest
    );
    expect(historicalReviewRubricDigest).toBe(expectedRubricDigest);
    expect(historicalReviewRubricPromptDigest).toBe(expectedPromptDigest);
  });

  it("prompt 明确安全聚合标准且不含人员、题号、样本计数或逐字评语", () => {
    for (const phrase of [
      "两版历史人工审核",
      "确认原题或重复题只进入原创性核验",
      "投题者自报难度完全排除",
      "题面与题解",
      "参考实现可选",
      "趣味与选手体验",
      "整体偏好",
      "题面、题解与数据准备",
      "模板化、新意与深度",
      "ICPC 比赛适配",
      "实现负担平衡",
      "公平性、可判定性与自然性",
      "难度只用于判断题组角色"
    ]) {
      expect(historicalReviewRubricPromptText).toContain(phrase);
    }

    const textWithoutVersion = historicalReviewRubricPromptText.replace(
      historicalReviewRubric.rubricVersion,
      ""
    );
    const rubricWithoutVersionMetadata = JSON.stringify({
      sourceBasis: historicalReviewRubric.sourceBasis,
      tasteLearningScope: historicalReviewRubric.tasteLearningScope,
      coreMaterials: historicalReviewRubric.coreMaterials,
      approvalEvidenceAxes: historicalReviewRubric.approvalEvidenceAxes,
      rejectionEvidenceAxes: historicalReviewRubric.rejectionEvidenceAxes,
      difficultyPolicy: historicalReviewRubric.difficultyPolicy,
      evidencePolicy: historicalReviewRubric.evidencePolicy
    });
    const safeAggregateText = `${rubricWithoutVersionMetadata}\n${textWithoutVersion}`;
    expect(safeAggregateText).not.toMatch(/[0-9]/u);
    expect(safeAggregateText).not.toMatch(
      /(?:题号|人员姓名|投稿者姓名|审核者姓名|原始评语|逐字评语|样本数量|通过数量|否决数量|合计数量)/u
    );
    expect(safeAggregateText).not.toMatch(
      /\b(?:problemId|contestId|externalId|authorId|reviewerId|positiveCount|negativeCount|totalCount)\b/iu
    );
    expect(safeAggregateText).not.toMatch(/[“”「」『』]/u);
  });
});
