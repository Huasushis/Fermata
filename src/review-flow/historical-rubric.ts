import { z } from "zod";
import { deepFreeze, hashCanonicalValue } from "./evidence";

const normalizedAxisSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u),
    label: z.string().trim().min(1).max(80),
    guidance: z.string().trim().min(1).max(500)
  })
  .strict();

/**
 * 只保存历史人工审核的安全聚合结论，不包含题目、人员、计数、题号或逐字评语。
 * 两版历史记录只用于归纳下列证据轴；投题者自报字段从未进入本规范。
 */
export const historicalReviewRubricSchema = z
  .object({
    schemaVersion: z.literal(1),
    rubricVersion: z.literal("ustc-historical-human-review-rubric-v1"),
    sourceBasis: z.literal(
      "来自两版历史人工审核中通过侧与否决侧的安全聚合对照。"
    ),
    tasteLearningScope: z
      .object({
        confirmedPriorProblemOrDuplicateCases: z.literal("excluded"),
        submitterReportedDifficulty: z.literal("fully_excluded")
      })
      .strict(),
    coreMaterials: z
      .object({
        statement: z.literal("required_core"),
        solution: z.literal("required_core"),
        referenceImplementation: z.literal("optional_nonblocking")
      })
      .strict(),
    approvalEvidenceAxes: z.tuple([
      normalizedAxisSchema.extend({ id: z.literal("fun_and_contestant_experience") }),
      normalizedAxisSchema.extend({ id: z.literal("overall_preference") }),
      normalizedAxisSchema.extend({ id: z.literal("material_preparation") })
    ]),
    rejectionEvidenceAxes: z.tuple([
      normalizedAxisSchema.extend({ id: z.literal("template_novelty_and_depth") }),
      normalizedAxisSchema.extend({ id: z.literal("icpc_fit") }),
      normalizedAxisSchema.extend({ id: z.literal("implementation_balance") }),
      normalizedAxisSchema.extend({ id: z.literal("fairness_judgeability_naturalness") })
    ]),
    difficultyPolicy: z
      .object({
        observedOnBothSides: z.literal(true),
        verdictUse: z.literal("problemset_role_only"),
        guidance: z.string().trim().min(1).max(500)
      })
      .strict(),
    evidencePolicy: z
      .object({
        correctnessRole: z.literal("baseline_not_taste"),
        requirePositiveAndNegativeEvidence: z.literal(true),
        hiddenMaterialInference: z.literal("forbidden")
      })
      .strict()
  })
  .strict();

export type HistoricalReviewRubric = z.infer<typeof historicalReviewRubricSchema>;

const rubricCandidate = {
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
  },
  approvalEvidenceAxes: [
    {
      id: "fun_and_contestant_experience",
      label: "趣味与选手体验",
      guidance: "判断关键发现过程是否有趣，选手完成题目后是否获得与投入相称的体验。"
    },
    {
      id: "overall_preference",
      label: "整体偏好",
      guidance: "综合判断核心创意、表达和比赛体验是否形成值得保留的整体命题价值。"
    },
    {
      id: "material_preparation",
      label: "题面、题解与数据准备",
      guidance: "检查可见材料中的题面表达、题解阐释和数据准备说明；不得臆测未提供的隐藏材料。"
    }
  ],
  rejectionEvidenceAxes: [
    {
      id: "template_novelty_and_depth",
      label: "模板化、新意与深度",
      guidance: "区分合理使用常见算法与仅套模板，检查核心转化是否缺少新意或必要深度。"
    },
    {
      id: "icpc_fit",
      label: "ICPC 比赛适配",
      guidance: "判断题目是否适合现场团队赛的发现、讨论、实现和反馈节奏。"
    },
    {
      id: "implementation_balance",
      label: "实现负担平衡",
      guidance: "判断实现量、机械细节和易错成本是否与思维收益相称，不能把代码长短直接当作质量。"
    },
    {
      id: "fairness_judgeability_naturalness",
      label: "公平性、可判定性与自然性",
      guidance: "检查知识要求是否公平、规则能否稳定判定，以及叙述与解法联系是否自然。"
    }
  ],
  difficultyPolicy: {
    observedOnBothSides: true,
    verdictUse: "problemset_role_only",
    guidance: "历史通过侧与否决侧都出现难度意见；难度只用于判断题组角色，不能单独推出通过或否决。"
  },
  evidencePolicy: {
    correctnessRole: "baseline_not_taste",
    requirePositiveAndNegativeEvidence: true,
    hiddenMaterialInference: "forbidden"
  }
} as const;

/** 冻结且经过 strict schema 校验的公开安全规范。 */
export const historicalReviewRubric: Readonly<HistoricalReviewRubric> = deepFreeze(
  historicalReviewRubricSchema.parse(rubricCandidate)
);

/** 规范内容的 canonical SHA-256；调用方可用 hashCanonicalValue 复算。 */
export const historicalReviewRubricDigest = hashCanonicalValue(historicalReviewRubric);

/** 可直接嵌入 system prompt 的安全聚合文本，不含历史题目或逐字评语。 */
export const historicalReviewRubricPromptText = renderPromptText(historicalReviewRubric);

/** prompt 文本单独绑定，避免只改渲染方式却沿用旧实验身份。 */
export const historicalReviewRubricPromptDigest = hashCanonicalValue(
  historicalReviewRubricPromptText
);

function renderPromptText(rubric: HistoricalReviewRubric): string {
  return [
    `历史人工审核安全规范：${rubric.rubricVersion}`,
    `来源：${rubric.sourceBasis}`,
    "隔离规则：确认原题或重复题只进入原创性核验，不用于学习命题品味；投题者自报难度完全排除。",
    "核心材料：题面与题解。参考实现可选；缺少或尚未隔离执行都不能自行成为质量缺陷。",
    "正确性是底线核验，不等于命题品味，也不能因为技术无错就默认通过。",
    "通过侧证据轴：",
    ...rubric.approvalEvidenceAxes.map(
      (axis) => `- ${axis.label}：${axis.guidance}`
    ),
    "否决侧证据轴：",
    ...rubric.rejectionEvidenceAxes.map(
      (axis) => `- ${axis.label}：${axis.guidance}`
    ),
    `难度使用：${rubric.difficultyPolicy.guidance}`,
    "审核必须分别记录正向与负向证据；对不可见的数据、附件或执行结果保持未评估，不得补写。"
  ].join("\n");
}
