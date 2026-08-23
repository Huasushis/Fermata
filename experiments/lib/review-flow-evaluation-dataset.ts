/**
 * 11 角色审题准确性实验的数据边界。
 *
 * development 在运行前读取本分区 Gold；holdout prediction 绝不打开 Gold，只有
 * 独立 reveal 阶段才读取。manifest 只登记不透明主体/来源与字节摘要，不携带
 * 任何分区标签分布。
 */
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import {
  closePrivateDirectory,
  openExistingPrivateDirectory,
  projectPrivateRoot,
  workspaceRoot,
  type PrivateDirectoryHandle
} from "../../scripts/private-runtime.mjs";
import { hashCanonicalValue } from "../../src/review-flow/evidence";
import { editorialDimensionSchema } from "../../src/review-flow/schemas";
import {
  codeforcesDifficultySchema,
  difficultyLevelSchema,
  reviewVerdictSchema,
  robotReviewTaskSchema,
  type RobotReviewTask
} from "../../src/urmotiv-schemas";
import { readPrivateArtifactBytes } from "./private-artifact-io";
import { historicalRepositoryPreparationSetSchema } from "./review-flow-bridge-repositories";
import {
  deepFreezePhysicalBlind,
  parsePhysicalBlindJson,
  parseVersionedStrictArtifact
} from "./physical-blind-common";

export const reviewFlowEvaluationDigestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u);
export const reviewFlowEvaluationGeneratorDependencyFileCount = 46 as const;
export const reviewFlowEvaluationSafeIdSchema = z
  .string()
  .regex(/^case-[0-9]{4}$/u);
export const reviewFlowEvaluationSubjectIdSchema = z
  .string()
  .regex(/^subject-[A-Za-z0-9][A-Za-z0-9._-]{7,95}$/u);
export const reviewFlowEvaluationDatasetIdSchema = z
  .string()
  .regex(/^dataset-[0-9a-f]{16}$/u);
export const reviewFlowEvaluationLabelSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const privateFileNameSchema = z
  .string()
  .min(1)
  .max(180)
  .refine(
    (value) =>
      basename(value) === value &&
      value !== "." &&
      value !== ".." &&
      !value.includes("\0"),
    "只能引用 manifest 同目录内的普通文件。"
  );

export const reviewFlowEvaluationPurposeSchema = z.enum([
  "development",
  "holdout"
]);
export type ReviewFlowEvaluationPurpose = z.infer<
  typeof reviewFlowEvaluationPurposeSchema
>;

export const reviewFlowEvaluationCaseSelectorSchema = z.enum([
  "representative3-v1",
  "representative3-v2",
  "representative3-v3"
]);
export type ReviewFlowEvaluationCaseSelector = z.infer<
  typeof reviewFlowEvaluationCaseSelectorSchema
>;

const reviewFlowEvaluationCaseSelectionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    selector: z.literal("representative3-v1"),
    parentDatasetFingerprint: reviewFlowEvaluationDigestSchema,
    parentManifestSha256: reviewFlowEvaluationDigestSchema,
    parentBridgeCompletionSha256: reviewFlowEvaluationDigestSchema,
    parentCaseCount: z.literal(32),
    orderedSelectionSha256: reviewFlowEvaluationDigestSchema,
    selectedCaseCount: z.literal(3)
  })
  .strict();

export const reviewFlowEvaluationRepresentative3V2AuditedStrataCounts = {
  acceptedInteractive: 1,
  rejectedSubmitAnswerTasteConcernNoTechnical: 8,
  rejectedTraditionalNoObservedReasons: 3
} as const;

const reviewFlowEvaluationCaseSelectionV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    selector: z.literal("representative3-v2"),
    selectorIdentity: z.literal(
      "review-flow-evaluation-representative3-v2"
    ),
    tieBreakProtocol: z.literal(
      "review-flow-representative3-v2-tiebreak"
    ),
    parentDatasetFingerprint: reviewFlowEvaluationDigestSchema,
    parentManifestSha256: reviewFlowEvaluationDigestSchema,
    parentBridgeCompletionSha256: reviewFlowEvaluationDigestSchema,
    parentCaseCount: z.literal(32),
    auditedStrataCounts: z
      .object({
        acceptedInteractive: z.literal(1),
        rejectedSubmitAnswerTasteConcernNoTechnical: z.literal(8),
        rejectedTraditionalNoObservedReasons: z.literal(3)
      })
      .strict(),
    orderedSelectionSha256: reviewFlowEvaluationDigestSchema,
    selectedCaseCount: z.literal(3)
  })
  .strict();

const reviewFlowEvaluationCaseSelectionV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    selector: z.literal("representative3-v3"),
    selectorIdentity: z.literal(
      "review-flow-evaluation-representative3-v3"
    ),
    tieBreakProtocol: z.literal(
      "review-flow-representative3-v3-tiebreak"
    ),
    parentDatasetFingerprint: reviewFlowEvaluationDigestSchema,
    parentManifestSha256: reviewFlowEvaluationDigestSchema,
    parentBridgeCompletionSha256: reviewFlowEvaluationDigestSchema,
    parentCaseCount: z.literal(32),
    categoryPattern: z.literal("accepted_any_first_rejected_two_distinct"),
    orderedSelectionSha256: reviewFlowEvaluationDigestSchema,
    selectedCaseCount: z.literal(3)
  })
  .strict();

export const reviewFlowEvaluationCaseSelectionSchema =
  z.discriminatedUnion("selector", [
    reviewFlowEvaluationCaseSelectionV1Schema,
    reviewFlowEvaluationCaseSelectionV2Schema,
    reviewFlowEvaluationCaseSelectionV3Schema
  ]);
export type ReviewFlowEvaluationCaseSelection = z.infer<
  typeof reviewFlowEvaluationCaseSelectionSchema
>;

/**
 * 历史通过/否决结果发生在题目进入当前 Anklang 语料之前。校准时必须统一排除
 * 当前语料，避免赛后同题自匹配把历史结果泄漏给 originality/裁决角色。
 */
export const reviewFlowEvaluationAnklangInputPolicySchema = z.literal(
  "exclude_current_corpus_for_historical_outcome"
);
export type ReviewFlowEvaluationAnklangInputPolicy = z.infer<
  typeof reviewFlowEvaluationAnklangInputPolicySchema
>;

/** 全批历史校准统一使用的非 Gold 标签占位；顺序也是输入身份的一部分。 */
export const reviewFlowEvaluationPlaceholderTagIdsSchema = z
  .array(z.string().min(1).max(120))
  .min(1)
  .max(30)
  .refine((tagIds) => new Set(tagIds).size === tagIds.length, {
    message: "PLACEHOLDER_TAG_IDS_DUPLICATE"
  });
export type ReviewFlowEvaluationPlaceholderTagIds = z.infer<
  typeof reviewFlowEvaluationPlaceholderTagIdsSchema
>;

export const reviewFlowEvaluationLoadModeSchema = z.enum([
  "development_identity",
  "development_scored",
  "holdout_prediction",
  "holdout_reveal"
]);
export type ReviewFlowEvaluationLoadMode = z.infer<
  typeof reviewFlowEvaluationLoadModeSchema
>;

const fileBindingSchema = z
  .object({
    fileName: privateFileNameSchema,
    sha256: reviewFlowEvaluationDigestSchema
  })
  .strict();

export const reviewFlowEvaluationTasteReasonSchema = z
  .object({
    dimension: editorialDimensionSchema,
    direction: z.enum(["strength", "concern"])
  })
  .strict();

/** 只允许由正式审题投影直接判定的、XML 确有对应含义的技术枚举。 */
export const reviewFlowEvaluationTechnicalReasonSchema = z.enum([
  "statement_solution_inconsistency",
  "judgeability_concern",
  "sample_mismatch",
  "constraint_insufficiency",
  "official_solution_incorrect",
  "complexity_unacceptable",
  "reference_implementation_incorrect"
]);
export type ReviewFlowEvaluationTechnicalReason = z.infer<
  typeof reviewFlowEvaluationTechnicalReasonSchema
>;

const upstreamEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    sealedEvidenceSha256: reviewFlowEvaluationDigestSchema,
    rowEvidenceSha256: reviewFlowEvaluationDigestSchema,
    sourceLineageSha256: reviewFlowEvaluationDigestSchema,
    originalAnklangResponseSha256: reviewFlowEvaluationDigestSchema,
    bridgeEvidence: z
      .object({
        bridgeVersion: z.literal("urmotiv-review-flow-bridge-v5"),
        historicalInputPreparationCompletionSha256:
          reviewFlowEvaluationDigestSchema,
        verificationAttestationSha256: reviewFlowEvaluationDigestSchema,
        bridgePlanSha256: reviewFlowEvaluationDigestSchema,
        reviewGoldEvidenceSha256: reviewFlowEvaluationDigestSchema,
        sourceBindingsSha256: reviewFlowEvaluationDigestSchema,
        upstreamGoldSha256: reviewFlowEvaluationDigestSchema,
        worksheetSha256: reviewFlowEvaluationDigestSchema,
        inspectionSha256: reviewFlowEvaluationDigestSchema,
        layoutSha256: reviewFlowEvaluationDigestSchema,
        reviewInputSetSha256: reviewFlowEvaluationDigestSchema,
        sourceMappingSha256: reviewFlowEvaluationDigestSchema,
        anklangCaptureAttestationSha256: reviewFlowEvaluationDigestSchema,
        anklangCaptureCompletionSha256: reviewFlowEvaluationDigestSchema,
        anklangRequestSha256: reviewFlowEvaluationDigestSchema,
        anklangResponseSha256: reviewFlowEvaluationDigestSchema,
        anklangCorpusEvidenceKind: z.enum([
          "reproducible_snapshot",
          "remote_corpus_unverifiable"
        ])
      })
      .strict()
  })
  .strict();

const reviewFlowEvaluationGoldCommonShape = {
  schemaVersion: z.literal(2),
  safeId: reviewFlowEvaluationSafeIdSchema,
  subjectId: reviewFlowEvaluationSubjectIdSchema,
  sourceLineageSha256: reviewFlowEvaluationDigestSchema,
  contentSha256: reviewFlowEvaluationDigestSchema,
  upstreamEvidence: upstreamEvidenceSchema
} as const;

const independentVerdictSchema = z
  .object({
    annotation: z.literal("independent_human_three_way"),
    verdict: reviewVerdictSchema
  })
  .strict();

const independentTasteSchema = z
  .object({
    annotation: z.literal("exhaustive_independent_human"),
    reasons: z.array(reviewFlowEvaluationTasteReasonSchema).max(48)
  })
  .strict();

const independentOriginalitySchema = z
  .object({
    annotation: z.literal("independent_human_originality"),
    confirmedDuplicate: z.boolean()
  })
  .strict();

export const reviewFlowEvaluationIndependentDifficultySchema = z
  .object({
    annotation: z.literal("independent_human_without_submitter_metadata"),
    codeforcesDifficulty: codeforcesDifficultySchema,
    thinkingLevel: difficultyLevelSchema,
    codingLevel: difficultyLevelSchema
  })
  .strict();

export const reviewFlowEvaluationMetricApplicabilitySchema = z
  .object({
    historicalOutcome: z.boolean().default(true),
    contestUse: z.boolean().default(true),
    independentDifficulty: z.boolean().optional()
  })
  .strict()
  .optional();

const verdictAndTasteGoldSchema = z
  .object({
    ...reviewFlowEvaluationGoldCommonShape,
    evaluationScope: z.literal("verdict_and_taste"),
    metricApplicability: reviewFlowEvaluationMetricApplicabilitySchema,
    historicalOutcome: z.enum(["accepted", "rejected"]).optional(),
    contestUse: z.enum(["used", "not_used", "unknown"]).optional(),
    // XML 意见是稀疏观察：缺席不构成负例，只计算召回。
    observedHistoricalTasteReasons: z
      .array(reviewFlowEvaluationTasteReasonSchema)
      .max(48),
    observedHistoricalTechnicalReasons: z
      .array(reviewFlowEvaluationTechnicalReasonSchema)
      .max(32),
    independentVerdict: independentVerdictSchema.optional(),
    independentTaste: independentTasteSchema.optional(),
    independentOriginality: independentOriginalitySchema.optional(),
    expectedTagIds: z
      .array(z.string().min(1).max(120))
      .min(1)
      .max(30)
      .optional(),
    independentDifficulty:
      reviewFlowEvaluationIndependentDifficultySchema.optional()
  })
  .strict()
  .superRefine((gold, context) => {
    const applicability = gold.metricApplicability ?? {
      historicalOutcome: true,
      contestUse: true
    };
    const historicalOutcomeApplicable = applicability.historicalOutcome;
    const contestUseApplicable = applicability.contestUse;
    const difficultyApplicability = applicability.independentDifficulty;
    if (contestUseApplicable && !historicalOutcomeApplicable) {
      context.addIssue({
        code: "custom",
        path: ["metricApplicability", "contestUse"],
        message: "contestUse 必须依附于历史通过/否决指标。"
      });
    }
    if (
      historicalOutcomeApplicable !==
      (gold.historicalOutcome !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["historicalOutcome"],
        message: "历史通过/否决字段必须与适用范围一致。"
      });
    }
    if (contestUseApplicable !== (gold.contestUse !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["contestUse"],
        message: "contestUse 字段必须与适用范围一致。"
      });
    }
    if (
      difficultyApplicability === true &&
      gold.independentDifficulty === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["independentDifficulty"],
        message: "独立难度适用时必须提供独立难度真值。"
      });
    }
    if (
      difficultyApplicability === false &&
      gold.independentDifficulty !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["independentDifficulty"],
        message: "独立难度不适用时不能提供独立难度真值。"
      });
    }
    assertUniqueReasons(
      gold.observedHistoricalTasteReasons,
      context,
      "observedHistoricalTasteReasons"
    );
    if (gold.independentTaste !== undefined) {
      assertUniqueReasons(
        gold.independentTaste.reasons,
        context,
        "independentTaste"
      );
    }
    if (
      new Set(gold.observedHistoricalTechnicalReasons).size !==
      gold.observedHistoricalTechnicalReasons.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["observedHistoricalTechnicalReasons"],
        message: "历史技术原因不能重复。"
      });
    }
    if (
      gold.expectedTagIds !== undefined &&
      new Set(gold.expectedTagIds).size !== gold.expectedTagIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["expectedTagIds"],
        message: "标签真值不能重复。"
      });
    }
  });

const originalityOnlyGoldSchema = z
  .object({
    ...reviewFlowEvaluationGoldCommonShape,
    evaluationScope: z.literal("originality_only"),
    originalityAnnotation: z.literal("confirmed_duplicate_evidence"),
    confirmedDuplicate: z.literal(true)
  })
  .strict();

export const reviewFlowEvaluationGoldSchema = z.discriminatedUnion(
  "evaluationScope",
  [verdictAndTasteGoldSchema, originalityOnlyGoldSchema]
);
export type ReviewFlowEvaluationGold = z.infer<
  typeof reviewFlowEvaluationGoldSchema
>;
export type ReviewFlowEvaluationMetric =
  | "historicalOutcome"
  | "contestUse"
  | "independentDifficulty";

export function reviewFlowEvaluationMetricIsApplicable(
  gold: ReviewFlowEvaluationGold,
  metric: ReviewFlowEvaluationMetric
): boolean {
  if (gold.evaluationScope !== "verdict_and_taste") return false;
  const applicability = gold.metricApplicability;
  if (metric === "historicalOutcome") {
    return applicability?.historicalOutcome ?? true;
  }
  if (metric === "contestUse") {
    return applicability?.contestUse ?? true;
  }
  return applicability?.independentDifficulty ??
    gold.independentDifficulty !== undefined;
}


const verdictCountsSchema = z
  .object({
    approve: z.number().int().nonnegative(),
    request_changes: z.number().int().nonnegative(),
    reject: z.number().int().nonnegative()
  })
  .strict();

const tasteDimensionCountsSchema = z.record(
  editorialDimensionSchema,
  z.number().int().nonnegative()
);
const technicalReasonCountsSchema = z.record(
  reviewFlowEvaluationTechnicalReasonSchema,
  z.number().int().nonnegative()
);

/** 该摘要仅在本分区 Gold 已实际加载后生成，不出现在 manifest。 */
export const reviewFlowEvaluationDatasetSummarySchema = z
  .object({
    caseCount: z.number().int().positive().max(1_000),
    scopeCounts: z
      .object({
        verdict_and_taste: z.number().int().nonnegative(),
        originality_only: z.number().int().nonnegative()
      })
      .strict(),
    historicalOutcomeCounts: z
      .object({
        accepted: z.number().int().nonnegative(),
        rejected: z.number().int().nonnegative()
      })
      .strict(),
    contestUseCounts: z
      .object({
        used: z.number().int().nonnegative(),
        not_used: z.number().int().nonnegative(),
        unknown: z.number().int().nonnegative()
      })
      .strict(),
    independentVerdictLabeledCaseCount: z.number().int().nonnegative(),
    independentVerdictCounts: verdictCountsSchema,
    independentTasteLabeledCaseCount: z.number().int().nonnegative(),
    independentOriginalityLabeledCaseCount: z.number().int().nonnegative(),
    confirmedDuplicatePositiveCount: z.number().int().nonnegative(),
    observedHistoricalTasteDimensionCounts: tasteDimensionCountsSchema,
    observedHistoricalTechnicalReasonCounts: technicalReasonCountsSchema,
    tagLabeledCaseCount: z.number().int().nonnegative(),
    difficultyLabeledCaseCount: z.number().int().nonnegative()
  })
  .strict();
export type ReviewFlowEvaluationDatasetSummary = z.infer<
  typeof reviewFlowEvaluationDatasetSummarySchema
>;

const evidenceBindingSchema = z
  .object({
    sealedEvidenceSha256: reviewFlowEvaluationDigestSchema,
    rowEvidenceSha256: reviewFlowEvaluationDigestSchema,
    originalAnklangResponseSha256: reviewFlowEvaluationDigestSchema,
    bridgeEvidence: upstreamEvidenceSchema.shape.bridgeEvidence
  })
  .strict();

export const reviewFlowEvaluationCaseDescriptorSchema = z
  .object({
    safeId: reviewFlowEvaluationSafeIdSchema,
    subjectId: reviewFlowEvaluationSubjectIdSchema,
    sourceLineageSha256: reviewFlowEvaluationDigestSchema,
    // 原始 Anklang 响应不含人工结论，可以绑定预测输入；其摘要必须全局唯一。
    originalAnklangResponseSha256: reviewFlowEvaluationDigestSchema,
    content: fileBindingSchema
  })
  .strict();
export type ReviewFlowEvaluationCaseDescriptor = z.infer<
  typeof reviewFlowEvaluationCaseDescriptorSchema
>;

const holdoutPartitionSchema = z
  .object({
    cases: z.array(reviewFlowEvaluationCaseDescriptorSchema).max(1_000)
  })
  .strict();

const developmentPartitionSchema = z
  .object({
    cases: z
      .array(reviewFlowEvaluationCaseDescriptorSchema)
      .max(1_000)
  })
  .strict()
  .superRefine(
  (partition, context) => {
    if (partition.cases.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "development 分区不能为空。"
      });
    }
  });

const tagCatalogFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.number().int().positive(),
    tags: robotReviewTaskSchema.shape.tagCatalog.shape.tags
  })
  .strict()
  .superRefine((catalog, context) => {
    if (new Set(catalog.tags.map((tag) => tag.id)).size !== catalog.tags.length) {
      context.addIssue({
        code: "custom",
        path: ["tags"],
        message: "标签编号不能重复。"
      });
    }
  });

export const reviewFlowEvaluationHoldoutRegistrationSchema = z
  .object({
    baselineLabel: reviewFlowEvaluationLabelSchema,
    candidateLabel: reviewFlowEvaluationLabelSchema,
    thresholdPolicySha256: reviewFlowEvaluationDigestSchema
  })
  .strict()
  .refine((value) => value.baselineLabel !== value.candidateLabel, {
    message: "holdout 基线与候选标签必须不同。",
    path: ["candidateLabel"]
  });

export const reviewFlowEvaluationManifestSchema = z
  .object({
    schemaVersion: z.literal(4),
    datasetId: reviewFlowEvaluationDatasetIdSchema,
    // 全数据集统一策略，不记录逐题 scope，因而不会从 prediction manifest
    // 泄漏某一题的 Gold 类型。
    anklangInputPolicy: reviewFlowEvaluationAnklangInputPolicySchema,
    placeholderTagIds: reviewFlowEvaluationPlaceholderTagIdsSchema,
    tagCatalog: fileBindingSchema
      .extend({ version: z.number().int().positive() })
      .strict(),
    holdoutRegistration: reviewFlowEvaluationHoldoutRegistrationSchema.nullable(),
    // 这是带 256-bit 随机 nonce 的独立 reveal descriptor 原始字节摘要；
    // prediction manifest 不记录其文件名或任何逐题 Gold 摘要。
    developmentRevealCommitmentSha256: reviewFlowEvaluationDigestSchema,
    holdoutRevealCommitmentSha256:
      reviewFlowEvaluationDigestSchema.nullable(),
    partitions: z
      .object({
        development: developmentPartitionSchema,
        holdout: holdoutPartitionSchema
      })
      .strict()
  })
  .strict()
  .superRefine((manifest, context) => {
    const hasHoldout = manifest.partitions.holdout.cases.length > 0;
    if (
      hasHoldout !== (manifest.holdoutRegistration !== null) ||
      hasHoldout !== (manifest.holdoutRevealCommitmentSha256 !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["holdoutRevealCommitmentSha256"],
        message: "holdout、注册信息与不可枚举 reveal commitment 必须同时存在或同时为空。"
      });
    }
  });
export type ReviewFlowEvaluationManifest = z.infer<
  typeof reviewFlowEvaluationManifestSchema
>;

const revealCaseSchema = z
  .object({
    safeId: reviewFlowEvaluationSafeIdSchema,
    subjectId: reviewFlowEvaluationSubjectIdSchema,
    sourceLineageSha256: reviewFlowEvaluationDigestSchema,
    contentSha256: reviewFlowEvaluationDigestSchema,
    upstreamEvidence: evidenceBindingSchema,
    gold: fileBindingSchema
  })
  .strict();

/**
 * 只在 one-shot reveal 时显式传入的独立材料。随机 nonce 令整个文件承诺无法通过
 * 枚举低熵 verdict/originality 标签反推出；预测清单只保存这个文件的整体摘要。
 */
export const reviewFlowEvaluationRevealDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal("review_flow_evaluation_reveal_descriptor"),
    protocolVersion: z.literal("review-flow-evaluation-reveal-v1"),
    datasetId: reviewFlowEvaluationDatasetIdSchema,
    purpose: reviewFlowEvaluationPurposeSchema,
    predictionBindingSha256: reviewFlowEvaluationDigestSchema,
    commitmentNonce: z.string().regex(/^[0-9a-f]{64}$/u),
    cases: z.array(revealCaseSchema).min(1).max(1_000)
  })
  .strict();
export type ReviewFlowEvaluationRevealDescriptor = z.infer<
  typeof reviewFlowEvaluationRevealDescriptorSchema
>;

export const reviewFlowEvaluationBridgeCompletionSchema = z
  .object({
    schemaVersion: z.literal(5),
    artifactKind: z.literal("review_flow_evaluation_dataset_bridge_completion"),
    bridgeVersion: z.literal("urmotiv-review-flow-bridge-v5"),
    datasetId: reviewFlowEvaluationDatasetIdSchema,
    manifestFileName: privateFileNameSchema,
    manifestSha256: reviewFlowEvaluationDigestSchema,
    generator: z
      .object({
        codeVersion: z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/u),
        runnerSha256: reviewFlowEvaluationDigestSchema,
        dependencyCodeSha256: reviewFlowEvaluationDigestSchema,
        dependencyFileCount: z.literal(
          reviewFlowEvaluationGeneratorDependencyFileCount
        )
      })
      .strict(),
    historicalInputPreparationCompletionSha256:
      reviewFlowEvaluationDigestSchema,
    repositories: historicalRepositoryPreparationSetSchema,
    tagCatalogSha256: reviewFlowEvaluationDigestSchema,
    placeholderTagIds: reviewFlowEvaluationPlaceholderTagIdsSchema,
    sourceLineageSetSha256: reviewFlowEvaluationDigestSchema,
    developmentPredictionBindingSha256: reviewFlowEvaluationDigestSchema,
    developmentRevealCommitmentSha256: reviewFlowEvaluationDigestSchema,
    holdoutPredictionBindingSha256:
      reviewFlowEvaluationDigestSchema.nullable(),
    holdoutRevealCommitmentSha256:
      reviewFlowEvaluationDigestSchema.nullable(),
    caseCount: z.number().int().positive().max(2_000),
    developmentCount: z.number().int().positive().max(1_000),
    holdoutCount: z.number().int().nonnegative().max(1_000)
  })
  .strict()
  .superRefine((completion, context) => {
    if (
      completion.caseCount !==
      completion.developmentCount + completion.holdoutCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["caseCount"],
        message: "bridge 完成标记计数不一致。"
      });
    }
    const hasHoldout = completion.holdoutCount > 0;
    if (
      hasHoldout !== (completion.holdoutPredictionBindingSha256 !== null) ||
      hasHoldout !== (completion.holdoutRevealCommitmentSha256 !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["holdoutRevealCommitmentSha256"],
        message: "bridge 必须同时绑定 holdout prediction 与独立 reveal 材料。"
      });
    }
  });
export type ReviewFlowEvaluationBridgeCompletion = z.infer<
  typeof reviewFlowEvaluationBridgeCompletionSchema
>;

export const reviewFlowEvaluationBridgeCompletionFileName =
  "REVIEW_FLOW_DATASET_COMPLETE" as const;

export interface ReviewFlowEvaluationDatasetCase {
  readonly safeId: string;
  readonly subjectId: string;
  readonly sourceLineageSha256: string;
  readonly contentSha256: string;
  readonly originalAnklangResponseSha256: string;
  readonly task: RobotReviewTask;
  readonly gold: ReviewFlowEvaluationGold | null;
}

export interface ReviewFlowEvaluationDatasetBundle {
  readonly schemaVersion: 4;
  readonly datasetId: string;
  readonly anklangInputPolicy: ReviewFlowEvaluationAnklangInputPolicy;
  readonly placeholderTagIds: ReviewFlowEvaluationPlaceholderTagIds;
  readonly purpose: ReviewFlowEvaluationPurpose;
  readonly loadMode: ReviewFlowEvaluationLoadMode;
  readonly manifestSha256: string;
  readonly bridgeCompletionSha256: string;
  readonly datasetFingerprint: string;
  readonly holdoutIdentity: string | null;
  readonly holdoutRegistration: z.infer<
    typeof reviewFlowEvaluationHoldoutRegistrationSchema
  > | null;
  readonly tagCatalogSha256: string;
  readonly tagCatalogVersion: number;
  readonly summary: ReviewFlowEvaluationDatasetSummary | null;
  readonly cases: readonly ReviewFlowEvaluationDatasetCase[];
  readonly caseSelection?: ReviewFlowEvaluationCaseSelection;
}

export interface ReviewFlowEvaluationSelectedDatasetBundle
  extends ReviewFlowEvaluationDatasetBundle {
  readonly caseSelection: ReviewFlowEvaluationCaseSelection;
}

/**
 * frozen32 已完整验真并登记 development 用途后，才可基于已揭示 Gold 选取
 * 固定三层 smoke。排序只使用绑定摘要；不接受调用方提供的 ID、路径或顺序。
 */
export function selectReviewFlowEvaluationRepresentative3(
  dataset: ReviewFlowEvaluationDatasetBundle
): ReviewFlowEvaluationSelectedDatasetBundle {
  if (
    dataset.purpose !== "development" ||
    dataset.loadMode !== "development_scored" ||
    dataset.summary?.caseCount !== 32 ||
    dataset.cases.length !== 32 ||
    dataset.cases.some(
      (entry) =>
        entry.gold === null ||
        entry.gold.evaluationScope !== "verdict_and_taste"
    )
  ) {
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_PARENT_INVALID"
    );
  }
  const strata = [
    {
      name: "accepted",
      accepts: (entry: ReviewFlowEvaluationDatasetCase) =>
        entry.gold?.evaluationScope === "verdict_and_taste" &&
        entry.gold.historicalOutcome === "accepted"
    },
    {
      name: "rejected_technical",
      accepts: (entry: ReviewFlowEvaluationDatasetCase) =>
        entry.gold?.evaluationScope === "verdict_and_taste" &&
        entry.gold.historicalOutcome === "rejected" &&
        entry.gold.observedHistoricalTechnicalReasons.length > 0 &&
        entry.gold.observedHistoricalTasteReasons.length === 0
    },
    {
      name: "rejected_taste_or_mixed",
      accepts: (entry: ReviewFlowEvaluationDatasetCase) =>
        entry.gold?.evaluationScope === "verdict_and_taste" &&
        entry.gold.historicalOutcome === "rejected" &&
        entry.gold.observedHistoricalTasteReasons.length > 0
    }
  ] as const;
  const selected = strata.map((stratum) => {
    const ranked = dataset.cases
      .filter(stratum.accepts)
      .map((entry) => ({
        entry,
        rank: hashCanonicalValue({
          protocol: "review-flow-representative3-v1-tiebreak",
          stratum: stratum.name,
          parentDatasetFingerprint: dataset.datasetFingerprint,
          parentManifestSha256: dataset.manifestSha256,
          parentBridgeCompletionSha256: dataset.bridgeCompletionSha256,
          sourceLineageSha256: entry.sourceLineageSha256,
          contentSha256: entry.contentSha256,
          originalAnklangResponseSha256:
            entry.originalAnklangResponseSha256
        })
      }))
      .sort((left, right) =>
        left.rank.localeCompare(right.rank) ||
        left.entry.sourceLineageSha256.localeCompare(
          right.entry.sourceLineageSha256
        )
      );
    const winner = ranked[0]?.entry;
    if (winner === undefined) {
      throw new ReviewFlowEvaluationDatasetError(
        "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_STRATUM_EMPTY"
      );
    }
    return winner;
  });
  if (new Set(selected.map((entry) => entry.safeId)).size !== 3) {
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_NOT_DISTINCT"
    );
  }
  const caseSelection = reviewFlowEvaluationCaseSelectionSchema.parse({
    schemaVersion: 1,
    selector: "representative3-v1",
    parentDatasetFingerprint: dataset.datasetFingerprint,
    parentManifestSha256: dataset.manifestSha256,
    parentBridgeCompletionSha256: dataset.bridgeCompletionSha256,
    parentCaseCount: 32,
    orderedSelectionSha256:
      reviewFlowEvaluationOrderedSelectionSha256(selected),
    selectedCaseCount: 3
  });
  return deepFreezePhysicalBlind({
    ...dataset,
    caseSelection,
    cases: selected
  });
}

/**
 * frozen32 当前已审计形状的 successor smoke。三层规则与计数都是 selector
 * 身份的一部分；任何 Gold/类型分布变化都失败，不回退为“看起来相近”的样本。
 */
export function selectReviewFlowEvaluationRepresentative3V2(
  dataset: ReviewFlowEvaluationDatasetBundle
): ReviewFlowEvaluationSelectedDatasetBundle {
  if (
    dataset.purpose !== "development" ||
    dataset.loadMode !== "development_scored" ||
    dataset.summary?.caseCount !== 32 ||
    dataset.cases.length !== 32 ||
    dataset.cases.some(
      (entry) =>
        entry.gold === null ||
        entry.gold.evaluationScope !== "verdict_and_taste"
    )
  ) {
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_V2_PARENT_INVALID"
    );
  }
  const strata = [
    {
      name: "accepted_interactive",
      expectedCount:
        reviewFlowEvaluationRepresentative3V2AuditedStrataCounts
          .acceptedInteractive,
      accepts: (entry: ReviewFlowEvaluationDatasetCase) =>
        entry.task.problem.type === "interactive" &&
        entry.gold?.evaluationScope === "verdict_and_taste" &&
        entry.gold.historicalOutcome === "accepted"
    },
    {
      name: "rejected_submit_answer_taste_concern_no_technical",
      expectedCount:
        reviewFlowEvaluationRepresentative3V2AuditedStrataCounts
          .rejectedSubmitAnswerTasteConcernNoTechnical,
      accepts: (entry: ReviewFlowEvaluationDatasetCase) =>
        entry.task.problem.type === "submit_answer" &&
        entry.gold?.evaluationScope === "verdict_and_taste" &&
        entry.gold.historicalOutcome === "rejected" &&
        entry.gold.observedHistoricalTechnicalReasons.length === 0 &&
        entry.gold.observedHistoricalTasteReasons.some(
          (reason) => reason.direction === "concern"
        )
    },
    {
      name: "rejected_traditional_no_observed_reasons",
      expectedCount:
        reviewFlowEvaluationRepresentative3V2AuditedStrataCounts
          .rejectedTraditionalNoObservedReasons,
      accepts: (entry: ReviewFlowEvaluationDatasetCase) =>
        entry.task.problem.type === "traditional" &&
        entry.gold?.evaluationScope === "verdict_and_taste" &&
        entry.gold.historicalOutcome === "rejected" &&
        entry.gold.observedHistoricalTechnicalReasons.length === 0 &&
        entry.gold.observedHistoricalTasteReasons.length === 0
    }
  ] as const;
  if (
    dataset.cases.some(
      (entry) =>
        strata.filter((stratum) => stratum.accepts(entry)).length > 1
    )
  ) {
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_V2_STRATA_OVERLAP"
    );
  }
  const rankedStrata = strata.map((stratum) => {
    const ranked = dataset.cases
      .filter(stratum.accepts)
      .map((entry) => ({
        entry,
        rank: hashCanonicalValue({
          selectorIdentity:
            "review-flow-evaluation-representative3-v2",
          stratum: stratum.name,
          parentDatasetFingerprint: dataset.datasetFingerprint,
          committedCaseSha256: hashCanonicalValue({
            safeId: entry.safeId,
            subjectId: entry.subjectId,
            originalAnklangResponseSha256:
              entry.originalAnklangResponseSha256
          }),
          committedSourceSha256: entry.sourceLineageSha256,
          committedContentSha256: entry.contentSha256
        })
      }))
      .sort((left, right) => left.rank.localeCompare(right.rank));
    if (ranked.length !== stratum.expectedCount) {
      throw new ReviewFlowEvaluationDatasetError(
        "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_V2_AUDITED_COUNTS_CHANGED"
      );
    }
    return ranked;
  });
  const allTieDigests = rankedStrata.flatMap((ranked) =>
    ranked.map((candidate) => candidate.rank)
  );
  if (new Set(allTieDigests).size !== allTieDigests.length) {
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_V2_TIE_DIGEST_COLLISION"
    );
  }
  const selected = rankedStrata.map((ranked) => ranked[0]!.entry);
  const selectedOutcomes = selected.map((entry) =>
    entry.gold?.evaluationScope === "verdict_and_taste"
      ? entry.gold.historicalOutcome
      : null
  );
  if (
    new Set(selected.map((entry) => entry.safeId)).size !== 3 ||
    new Set(selected.map((entry) => entry.task.problem.type)).size !== 3 ||
    selected[0]?.task.problem.type !== "interactive" ||
    selected[1]?.task.problem.type !== "submit_answer" ||
    selected[2]?.task.problem.type !== "traditional" ||
    selectedOutcomes[0] !== "accepted" ||
    selectedOutcomes[1] !== "rejected" ||
    selectedOutcomes[2] !== "rejected"
  ) {
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_V2_SELECTION_INVALID"
    );
  }
  const caseSelection = reviewFlowEvaluationCaseSelectionSchema.parse({
    schemaVersion: 2,
    selector: "representative3-v2",
    selectorIdentity: "review-flow-evaluation-representative3-v2",
    tieBreakProtocol: "review-flow-representative3-v2-tiebreak",
    parentDatasetFingerprint: dataset.datasetFingerprint,
    parentManifestSha256: dataset.manifestSha256,
    parentBridgeCompletionSha256: dataset.bridgeCompletionSha256,
    parentCaseCount: 32,
    auditedStrataCounts:
      reviewFlowEvaluationRepresentative3V2AuditedStrataCounts,
    orderedSelectionSha256:
      reviewFlowEvaluationOrderedSelectionSha256(selected),
    selectedCaseCount: 3
  });
  return deepFreezePhysicalBlind({
    ...dataset,
    caseSelection,
    cases: selected
  });
}

export function reviewFlowEvaluationOrderedSelectionSha256(
  cases: readonly Pick<
    ReviewFlowEvaluationDatasetCase,
    "safeId" | "subjectId" | "sourceLineageSha256" | "contentSha256"
  >[]
): string {
  return hashCanonicalValue(cases.map((entry) => ({
    safeId: entry.safeId,
    subjectId: entry.subjectId,
    sourceLineageSha256: entry.sourceLineageSha256,
    contentSha256: entry.contentSha256
  })));
}

/**
 * representative3-v3：与 v1/v2 完全不相交的 successor 冒烟选择。
 * 只在 frozen32 development_scored 上运行，并先由同一数据集确定性重算旧 v1+v2
 * 全集（不引用任何私有题号），再做三槽选择：1 个任意类型的 accepted 控制 +
 * 2 个 rejected（submit_answer 品味关切无技术理由、traditional 无观察理由）。
 * 任一槽不足、重叠、平局碰撞或类别/数量不符都 fail closed；不保存、不输出
 * 候选题面或私有标识。
 */
export function selectReviewFlowEvaluationRepresentative3V3(
  dataset: ReviewFlowEvaluationDatasetBundle
): ReviewFlowEvaluationSelectedDatasetBundle {
  const oldUnionV2 = selectReviewFlowEvaluationRepresentative3V2(dataset);
  const excluded = new Set(
    oldUnionV2.cases.map((entry) => entry.safeId)
  );
  const strata = [
    {
      name: "accepted_any",
      expectedCount: 1,
      accepts: (entry: ReviewFlowEvaluationDatasetCase) =>
        entry.gold?.evaluationScope === "verdict_and_taste" &&
        entry.gold.historicalOutcome === "accepted"
    },
    {
      name: "rejected_submit_answer_taste_no_technical",
      expectedCount: 1,
      accepts: (entry: ReviewFlowEvaluationDatasetCase) =>
        entry.task.problem.type === "submit_answer" &&
        entry.gold?.evaluationScope === "verdict_and_taste" &&
        entry.gold.historicalOutcome === "rejected" &&
        entry.gold.observedHistoricalTechnicalReasons.length === 0 &&
        entry.gold.observedHistoricalTasteReasons.some(
          (reason) => reason.direction === "concern"
        )
    },
    {
      name: "rejected_traditional_no_observed_reasons",
      expectedCount: 1,
      accepts: (entry: ReviewFlowEvaluationDatasetCase) =>
        entry.task.problem.type === "traditional" &&
        entry.gold?.evaluationScope === "verdict_and_taste" &&
        entry.gold.historicalOutcome === "rejected" &&
        entry.gold.observedHistoricalTechnicalReasons.length === 0 &&
        entry.gold.observedHistoricalTasteReasons.length === 0
    }
  ] as const;
  if (
    dataset.cases.some(
      (entry) =>
        strata.filter((stratum) => stratum.accepts(entry) && !excluded.has(entry.safeId)).length > 1
    )
  ) {
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_V3_STRATA_OVERLAP"
    );
  }
  const rankedStrata = strata.map((stratum) => {
    const ranked = dataset.cases
      .filter((entry) => !excluded.has(entry.safeId) && stratum.accepts(entry))
      .map((entry) => ({
        entry,
        rank: hashCanonicalValue({
          selectorIdentity: "review-flow-evaluation-representative3-v3",
          stratum: stratum.name,
          parentDatasetFingerprint: dataset.datasetFingerprint,
          committedCaseSha256: hashCanonicalValue({
            safeId: entry.safeId,
            subjectId: entry.subjectId,
            originalAnklangResponseSha256:
              entry.originalAnklangResponseSha256
          }),
          committedSourceSha256: entry.sourceLineageSha256,
          committedContentSha256: entry.contentSha256
        })
      }))
      .sort((left, right) => left.rank.localeCompare(right.rank));
    if (ranked.length < stratum.expectedCount) {
      throw new ReviewFlowEvaluationDatasetError(
        "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_V3_AUDITED_COUNTS_CHANGED"
      );
    }
    return ranked;
  });
  const allTieDigests = rankedStrata.flatMap((ranked) =>
    ranked.map((candidate) => candidate.rank)
  );
  if (new Set(allTieDigests).size !== allTieDigests.length) {
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_V3_TIE_DIGEST_COLLISION"
    );
  }
  const selectedFromEach = rankedStrata.map((ranked) => ranked[0]!.entry);
  const selected = [...selectedFromEach]
    .map((entry) => entry)
    .sort((left, right) => left.safeId.localeCompare(right.safeId));
  const outcomes = selected.map((entry) =>
    entry.gold?.evaluationScope === "verdict_and_taste"
      ? entry.gold.historicalOutcome
      : null
  );
  if (
    new Set(selected.map((entry) => entry.safeId)).size !== 3 ||
    new Set(selected.map((entry) => entry.task.problem.type)).size < 2 ||
    outcomes.filter((value) => value === "accepted").length !== 1 ||
    outcomes.filter((value) => value === "rejected").length !== 2
  ) {
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_V3_SELECTION_INVALID"
    );
  }
  for (const entry of oldUnionV2.cases) {
    if (selected.some((candidate) => candidate.safeId === entry.safeId)) {
      throw new ReviewFlowEvaluationDatasetError(
        "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_V3_OLD_INTERSECTION"
      );
    }
  }
  const caseSelection = reviewFlowEvaluationCaseSelectionSchema.parse({
    schemaVersion: 3,
    selector: "representative3-v3",
    selectorIdentity: "review-flow-evaluation-representative3-v3",
    tieBreakProtocol: "review-flow-representative3-v3-tiebreak",
    parentDatasetFingerprint: dataset.datasetFingerprint,
    parentManifestSha256: dataset.manifestSha256,
    parentBridgeCompletionSha256: dataset.bridgeCompletionSha256,
    parentCaseCount: 32,
    categoryPattern: "accepted_any_first_rejected_two_distinct",
    orderedSelectionSha256:
      reviewFlowEvaluationOrderedSelectionSha256(selected),
    selectedCaseCount: 3
  });
  return deepFreezePhysicalBlind({
    ...dataset,
    caseSelection,
    cases: selected
  });
}

export class ReviewFlowEvaluationDatasetError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(code);
    this.name = "ReviewFlowEvaluationDatasetError";
    this.code = code;
  }
}

export function loadReviewFlowEvaluationDataset(input: {
  readonly manifestPath: string;
  readonly revealDescriptorPath?: string;
  readonly purpose?: ReviewFlowEvaluationPurpose;
  readonly mode?: ReviewFlowEvaluationLoadMode;
  readonly privateRoot?: string;
  readonly containingWorkspace?: string;
}): ReviewFlowEvaluationDatasetBundle {
  const privateRoot = input.privateRoot ?? projectPrivateRoot;
  const containingWorkspace = input.containingWorkspace ?? workspaceRoot;
  if (!isAbsolute(input.manifestPath)) {
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_MANIFEST_PATH_INVALID"
    );
  }
  const mode = resolveLoadMode(input);
  const opensGold = mode === "development_scored" || mode === "holdout_reveal";
  if (
    (opensGold &&
      (input.revealDescriptorPath === undefined ||
        !isAbsolute(input.revealDescriptorPath) ||
        dirname(resolve(input.revealDescriptorPath)) ===
          dirname(resolve(input.manifestPath)))) ||
    (!opensGold && input.revealDescriptorPath !== undefined)
  ) {
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_REVEAL_DESCRIPTOR_PATH_INVALID"
    );
  }
  const purpose: ReviewFlowEvaluationPurpose = mode === "development_identity" ||
      mode === "development_scored"
    ? "development"
    : "holdout";
  const directory = openExistingPrivateDirectory(dirname(input.manifestPath), {
    privateRoot,
    containingWorkspace
  });
  let revealDirectory: PrivateDirectoryHandle | undefined;
  try {
    const manifestBytes = readPrivateArtifactBytes(
      directory,
      basename(input.manifestPath),
      4 * 1024 * 1024
    );
    const manifest = parseStrictDocument(
      manifestBytes,
      reviewFlowEvaluationManifestSchema,
      "REVIEW_FLOW_EVALUATION_MANIFEST_INVALID"
    );
    assertManifestDescriptorSeparation(manifest);
    const manifestSha256 = sha256(manifestBytes);
    const bridgeCompletionBytes = readPrivateArtifactBytes(
      directory,
      reviewFlowEvaluationBridgeCompletionFileName,
      1024 * 1024
    );
    const bridgeCompletion = parseStrictDocument(
      bridgeCompletionBytes,
      reviewFlowEvaluationBridgeCompletionSchema,
      "REVIEW_FLOW_EVALUATION_BRIDGE_COMPLETION_INVALID"
    );
    const bridgeCompletionSha256 = sha256(bridgeCompletionBytes);
    if (
      bridgeCompletion.datasetId !== manifest.datasetId ||
      bridgeCompletion.manifestFileName !== basename(input.manifestPath) ||
      bridgeCompletion.manifestSha256 !== manifestSha256 ||
      bridgeCompletion.tagCatalogSha256 !== manifest.tagCatalog.sha256 ||
      JSON.stringify(bridgeCompletion.placeholderTagIds) !==
        JSON.stringify(manifest.placeholderTagIds) ||
      bridgeCompletion.developmentCount !==
        manifest.partitions.development.cases.length ||
      bridgeCompletion.holdoutCount !== manifest.partitions.holdout.cases.length ||
      bridgeCompletion.sourceLineageSetSha256 !==
        sourceLineageSetSha256(manifest) ||
      bridgeCompletion.developmentPredictionBindingSha256 !==
        partitionPredictionBindingSha256(manifest, "development") ||
      bridgeCompletion.developmentRevealCommitmentSha256 !==
        manifest.developmentRevealCommitmentSha256 ||
      bridgeCompletion.holdoutPredictionBindingSha256 !==
        holdoutPredictionBindingSha256OrNull(manifest) ||
      bridgeCompletion.holdoutRevealCommitmentSha256 !==
        manifest.holdoutRevealCommitmentSha256
    ) {
      throw new ReviewFlowEvaluationDatasetError(
        "REVIEW_FLOW_EVALUATION_BRIDGE_COMPLETION_MISMATCH"
      );
    }
    const byteBudget = { remaining: 256 * 1024 * 1024 };
    const tagCatalogBytes = readBoundFile(
      directory,
      manifest.tagCatalog,
      4 * 1024 * 1024,
      byteBudget
    );
    const tagCatalog = parseStrictDocument(
      tagCatalogBytes,
      tagCatalogFileSchema,
      "REVIEW_FLOW_EVALUATION_TAG_CATALOG_INVALID"
    );
    if (tagCatalog.version !== manifest.tagCatalog.version) {
      throw new ReviewFlowEvaluationDatasetError(
        "REVIEW_FLOW_EVALUATION_TAG_CATALOG_MISMATCH"
      );
    }
    const catalogTagIds = new Set(tagCatalog.tags.map((tag) => tag.id));
    if (
      manifest.placeholderTagIds.some((tagId) => !catalogTagIds.has(tagId))
    ) {
      throw new ReviewFlowEvaluationDatasetError(
        "REVIEW_FLOW_EVALUATION_PLACEHOLDER_TAGS_INVALID"
      );
    }

    const descriptors = manifest.partitions[purpose].cases;
    if (descriptors.length === 0) {
      throw new ReviewFlowEvaluationDatasetError(
        "REVIEW_FLOW_EVALUATION_PARTITION_EMPTY"
      );
    }
    if (purpose === "holdout" && manifest.holdoutRegistration === null) {
      throw new ReviewFlowEvaluationDatasetError(
        "REVIEW_FLOW_EVALUATION_HOLDOUT_REGISTRATION_MISSING"
      );
    }
    const goldSource = opensGold
        ? (() => {
            const source = loadRevealDescriptor({
              path: input.revealDescriptorPath!,
              privateRoot,
              containingWorkspace,
              manifest,
              purpose
            });
            revealDirectory = source.directory;
            return source;
          })()
        : null;
    const cases = loadSelectedPartition(
      directory,
      descriptors,
      tagCatalog,
      manifest.placeholderTagIds,
      byteBudget,
      goldSource
    );
    if (
      goldSource !== null &&
      manifest.anklangInputPolicy ===
        "exclude_current_corpus_for_historical_outcome" &&
      cases.some(
        (entry) => entry.gold?.evaluationScope !== "verdict_and_taste"
      )
    ) {
      throw new ReviewFlowEvaluationDatasetError(
        "REVIEW_FLOW_EVALUATION_ANKLANG_INPUT_POLICY_SCOPE_INVALID"
      );
    }
    const summary = goldSource !== null
      ? summarizeGold(cases.map((entry) => {
          if (entry.gold === null) {
            throw new ReviewFlowEvaluationDatasetError(
              "REVIEW_FLOW_EVALUATION_GOLD_NOT_REVEALED"
            );
          }
          return entry.gold;
        }))
      : null;
    const holdoutIdentity = purpose === "holdout"
      ? hashCanonicalValue({
          protocol: "review-flow-evaluation-holdout-subjects-v4",
          datasetId: manifest.datasetId,
          anklangInputPolicy: manifest.anklangInputPolicy,
          placeholderTagIds: manifest.placeholderTagIds,
          tagCatalogSha256: manifest.tagCatalog.sha256,
          tagCatalogVersion: manifest.tagCatalog.version,
          predictionBindingSha256:
            partitionPredictionBindingSha256(manifest, "holdout"),
          revealCommitmentSha256: manifest.holdoutRevealCommitmentSha256,
          cases: [...manifest.partitions.holdout.cases]
            .sort((left, right) => left.subjectId.localeCompare(right.subjectId))
            .map((entry) => ({
              subjectId: entry.subjectId,
              sourceLineageSha256: entry.sourceLineageSha256,
              contentSha256: entry.content.sha256,
              originalAnklangResponseSha256:
                entry.originalAnklangResponseSha256
            }))
        })
      : null;
    return deepFreezePhysicalBlind({
      schemaVersion: 4 as const,
      datasetId: manifest.datasetId,
      anklangInputPolicy: manifest.anklangInputPolicy,
      placeholderTagIds: manifest.placeholderTagIds,
      purpose,
      loadMode: mode,
      manifestSha256,
      bridgeCompletionSha256,
      datasetFingerprint: hashCanonicalValue({
        protocol: "review-flow-evaluation-dataset-v4",
        datasetId: manifest.datasetId,
        anklangInputPolicy: manifest.anklangInputPolicy,
        placeholderTagIds: manifest.placeholderTagIds,
        purpose,
        manifestSha256,
        bridgeCompletionSha256,
        tagCatalogSha256: manifest.tagCatalog.sha256,
        tagCatalogVersion: tagCatalog.version,
        cases: descriptors.map(datasetCaseIdentity)
      }),
      holdoutIdentity,
      // development 进程不需要、也不携带 holdout 注册元数据。
      holdoutRegistration:
        purpose === "holdout" ? manifest.holdoutRegistration : null,
      tagCatalogSha256: manifest.tagCatalog.sha256,
      tagCatalogVersion: tagCatalog.version,
      summary,
      cases
    });
  } catch (error) {
    if (error instanceof ReviewFlowEvaluationDatasetError) throw error;
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_DATASET_INVALID"
    );
  } finally {
    if (revealDirectory !== undefined) {
      closePrivateDirectory(revealDirectory);
    }
    closePrivateDirectory(directory);
  }
}

function resolveLoadMode(input: {
  readonly purpose?: ReviewFlowEvaluationPurpose;
  readonly mode?: ReviewFlowEvaluationLoadMode;
}): ReviewFlowEvaluationLoadMode {
  if (input.mode !== undefined) {
    const mode = reviewFlowEvaluationLoadModeSchema.parse(input.mode);
    if (
      input.purpose !== undefined &&
      input.purpose !== (
        mode === "development_identity" || mode === "development_scored"
          ? "development"
          : "holdout"
      )
    ) {
      throw new ReviewFlowEvaluationDatasetError(
        "REVIEW_FLOW_EVALUATION_LOAD_MODE_INVALID"
      );
    }
    return mode;
  }
  const purpose = reviewFlowEvaluationPurposeSchema.parse(input.purpose);
  return purpose === "development"
    ? "development_identity"
    : "holdout_prediction";
}

interface GoldSource {
  readonly directory: PrivateDirectoryHandle;
  readonly entries: readonly {
    readonly gold: z.infer<typeof fileBindingSchema>;
    readonly upstreamEvidence: z.infer<typeof evidenceBindingSchema>;
  }[];
}

function loadRevealDescriptor(input: {
  readonly path: string;
  readonly privateRoot: string;
  readonly containingWorkspace: string;
  readonly manifest: ReviewFlowEvaluationManifest;
  readonly purpose: ReviewFlowEvaluationPurpose;
}): GoldSource {
  const directory = openExistingPrivateDirectory(dirname(input.path), {
    privateRoot: input.privateRoot,
    containingWorkspace: input.containingWorkspace
  });
  try {
    const bytes = readPrivateArtifactBytes(
      directory,
      basename(input.path),
      4 * 1024 * 1024
    );
    const expectedCommitment = input.purpose === "development"
      ? input.manifest.developmentRevealCommitmentSha256
      : input.manifest.holdoutRevealCommitmentSha256;
    if (sha256(bytes) !== expectedCommitment) {
      throw new ReviewFlowEvaluationDatasetError(
        "REVIEW_FLOW_EVALUATION_REVEAL_COMMITMENT_MISMATCH"
      );
    }
    const reveal = parseStrictDocument(
      bytes,
      reviewFlowEvaluationRevealDescriptorSchema,
      "REVIEW_FLOW_EVALUATION_REVEAL_DESCRIPTOR_INVALID"
    );
    const expected = input.manifest.partitions[input.purpose].cases;
    if (
      reveal.datasetId !== input.manifest.datasetId ||
      reveal.purpose !== input.purpose ||
      reveal.predictionBindingSha256 !==
        partitionPredictionBindingSha256(input.manifest, input.purpose) ||
      reveal.cases.length !== expected.length ||
      reveal.cases.some((entry, index) => {
        const prediction = expected[index];
        return prediction === undefined ||
          entry.safeId !== prediction.safeId ||
          entry.subjectId !== prediction.subjectId ||
          entry.sourceLineageSha256 !== prediction.sourceLineageSha256 ||
          entry.contentSha256 !== prediction.content.sha256 ||
          entry.upstreamEvidence.originalAnklangResponseSha256 !==
            prediction.originalAnklangResponseSha256;
      }) ||
      new Set(reveal.cases.map((entry) => entry.gold.fileName)).size !==
        reveal.cases.length ||
      new Set(reveal.cases.map((entry) => entry.gold.sha256)).size !==
        reveal.cases.length ||
      new Set(
        reveal.cases.map((entry) => entry.upstreamEvidence.rowEvidenceSha256)
      ).size !== reveal.cases.length
    ) {
      throw new ReviewFlowEvaluationDatasetError(
        "REVIEW_FLOW_EVALUATION_REVEAL_DESCRIPTOR_MISMATCH"
      );
    }
    return {
      directory,
      entries: reveal.cases.map((entry) => ({
        gold: entry.gold,
        upstreamEvidence: entry.upstreamEvidence
      }))
    };
  } catch (error) {
    closePrivateDirectory(directory);
    if (error instanceof ReviewFlowEvaluationDatasetError) throw error;
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_REVEAL_DESCRIPTOR_INVALID"
    );
  }
}

function loadSelectedPartition(
  directory: PrivateDirectoryHandle,
  descriptors: readonly ReviewFlowEvaluationCaseDescriptor[],
  tagCatalog: z.infer<typeof tagCatalogFileSchema>,
  placeholderTagIds: ReviewFlowEvaluationPlaceholderTagIds,
  byteBudget: { remaining: number },
  goldSource: GoldSource | null
): readonly ReviewFlowEvaluationDatasetCase[] {
  const catalogHash = hashCanonicalValue({
    version: tagCatalog.version,
    tags: tagCatalog.tags
  });
  const catalogIds = new Set(tagCatalog.tags.map((tag) => tag.id));
  const cases = descriptors.map((descriptor, index) => {
    const contentBytes = readBoundFile(
      directory,
      descriptor.content,
      12 * 1024 * 1024,
      byteBudget
    );
    const task = parseStrictRobotTask(contentBytes);
    if (
      hashCanonicalValue(task.tagCatalog) !== catalogHash ||
      JSON.stringify(task.problem.tagIds) !==
        JSON.stringify(placeholderTagIds)
    ) {
      throw new ReviewFlowEvaluationDatasetError(
        "REVIEW_FLOW_EVALUATION_CASE_BINDING_MISMATCH"
      );
    }
    let gold: ReviewFlowEvaluationGold | null = null;
    if (goldSource !== null) {
      const goldEntry = goldSource.entries[index];
      if (goldEntry === undefined) {
        throw new ReviewFlowEvaluationDatasetError(
          "REVIEW_FLOW_EVALUATION_REVEAL_DESCRIPTOR_MISMATCH"
        );
      }
      const goldBytes = readBoundFile(
        goldSource.directory,
        goldEntry.gold,
        1024 * 1024,
        byteBudget
      );
      gold = parseStrictDocument(
        goldBytes,
        reviewFlowEvaluationGoldSchema,
        "REVIEW_FLOW_EVALUATION_GOLD_INVALID"
      );
      assertGoldBinding(
        gold,
        descriptor,
        goldEntry.upstreamEvidence,
        catalogIds
      );
    }
    return {
      safeId: descriptor.safeId,
      subjectId: descriptor.subjectId,
      sourceLineageSha256: descriptor.sourceLineageSha256,
      contentSha256: descriptor.content.sha256,
      originalAnklangResponseSha256:
        descriptor.originalAnklangResponseSha256,
      task,
      gold
    };
  });
  for (const selector of [
    (entry: ReviewFlowEvaluationDatasetCase) => entry.safeId,
    (entry: ReviewFlowEvaluationDatasetCase) => entry.subjectId,
    (entry: ReviewFlowEvaluationDatasetCase) => entry.sourceLineageSha256,
    (entry: ReviewFlowEvaluationDatasetCase) => entry.contentSha256,
    (entry: ReviewFlowEvaluationDatasetCase) => entry.task.assignmentId,
    (entry: ReviewFlowEvaluationDatasetCase) => entry.task.problem.id,
    (entry: ReviewFlowEvaluationDatasetCase) => entry.task.problem.contentHash
  ]) {
    if (new Set(cases.map(selector)).size !== cases.length) {
      throw new ReviewFlowEvaluationDatasetError(
        "REVIEW_FLOW_EVALUATION_DUPLICATE_CASE"
      );
    }
  }
  return cases;
}

function assertGoldBinding(
  gold: ReviewFlowEvaluationGold,
  descriptor: ReviewFlowEvaluationCaseDescriptor,
  evidence: z.infer<typeof evidenceBindingSchema>,
  catalogIds: ReadonlySet<string>
): void {
  if (
    gold.safeId !== descriptor.safeId ||
    gold.subjectId !== descriptor.subjectId ||
    gold.sourceLineageSha256 !== descriptor.sourceLineageSha256 ||
    gold.upstreamEvidence.sourceLineageSha256 !== descriptor.sourceLineageSha256 ||
    gold.upstreamEvidence.sealedEvidenceSha256 !==
      evidence.sealedEvidenceSha256 ||
    gold.upstreamEvidence.rowEvidenceSha256 !==
      evidence.rowEvidenceSha256 ||
    gold.upstreamEvidence.originalAnklangResponseSha256 !==
      evidence.originalAnklangResponseSha256 ||
    hashCanonicalValue(gold.upstreamEvidence.bridgeEvidence) !==
      hashCanonicalValue(evidence.bridgeEvidence) ||
    evidence.originalAnklangResponseSha256 !==
      descriptor.originalAnklangResponseSha256 ||
    gold.contentSha256 !== descriptor.content.sha256
  ) {
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_CASE_BINDING_MISMATCH"
    );
  }
  if (
    gold.evaluationScope === "verdict_and_taste" &&
    gold.expectedTagIds?.some((tagId) => !catalogIds.has(tagId))
  ) {
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_GOLD_TAG_INVALID"
    );
  }
}

function assertManifestDescriptorSeparation(
  manifest: ReviewFlowEvaluationManifest
): void {
  const development = manifest.partitions.development.cases;
  const holdout = manifest.partitions.holdout.cases;
  for (const selector of [
    (entry: ReviewFlowEvaluationCaseDescriptor) => entry.safeId,
    (entry: ReviewFlowEvaluationCaseDescriptor) => entry.subjectId,
    (entry: ReviewFlowEvaluationCaseDescriptor) => entry.sourceLineageSha256,
    (entry: ReviewFlowEvaluationCaseDescriptor) => entry.content.sha256,
    (entry: ReviewFlowEvaluationCaseDescriptor) =>
      entry.originalAnklangResponseSha256
  ]) {
    if (
      new Set(development.map(selector)).size !== development.length ||
      new Set(holdout.map(selector)).size !== holdout.length
    ) {
      throw new ReviewFlowEvaluationDatasetError(
        "REVIEW_FLOW_EVALUATION_DUPLICATE_CASE"
      );
    }
    const developmentValues = new Set(development.map(selector));
    if (holdout.some((entry) => developmentValues.has(selector(entry)))) {
      throw new ReviewFlowEvaluationDatasetError(
        "REVIEW_FLOW_EVALUATION_PARTITION_OVERLAP"
      );
    }
  }
}

function datasetCaseIdentity(entry: ReviewFlowEvaluationCaseDescriptor) {
  return {
    safeId: entry.safeId,
    subjectId: entry.subjectId,
    sourceLineageSha256: entry.sourceLineageSha256,
    contentSha256: entry.content.sha256,
    originalAnklangResponseSha256:
      entry.originalAnklangResponseSha256
  };
}

export function reviewFlowEvaluationSourceLineageSetSha256(
  manifest: ReviewFlowEvaluationManifest
): string {
  return sourceLineageSetSha256(manifest);
}

export function reviewFlowEvaluationHoldoutPredictionBindingSha256(
  manifest: ReviewFlowEvaluationManifest
): string {
  return partitionPredictionBindingSha256(manifest, "holdout");
}

export function reviewFlowEvaluationDevelopmentPredictionBindingSha256(
  manifest: ReviewFlowEvaluationManifest
): string {
  return partitionPredictionBindingSha256(manifest, "development");
}

function holdoutPredictionBindingSha256OrNull(
  manifest: ReviewFlowEvaluationManifest
): string | null {
  return manifest.partitions.holdout.cases.length === 0
    ? null
    : partitionPredictionBindingSha256(manifest, "holdout");
}

function partitionPredictionBindingSha256(
  manifest: ReviewFlowEvaluationManifest,
  purpose: ReviewFlowEvaluationPurpose
): string {
  return hashCanonicalValue({
    protocol: "review-flow-evaluation-prediction-binding-v3",
    datasetId: manifest.datasetId,
    anklangInputPolicy: manifest.anklangInputPolicy,
    placeholderTagIds: manifest.placeholderTagIds,
    purpose,
    tagCatalog: manifest.tagCatalog,
    registration: purpose === "holdout" ? manifest.holdoutRegistration : null,
    cases: manifest.partitions[purpose].cases.map(datasetCaseIdentity)
  });
}

function sourceLineageSetSha256(
  manifest: ReviewFlowEvaluationManifest
): string {
  return hashCanonicalValue({
    protocol: "review-flow-evaluation-source-lineage-set-v4",
    datasetId: manifest.datasetId,
    anklangInputPolicy: manifest.anklangInputPolicy,
    placeholderTagIds: manifest.placeholderTagIds,
    cases: ([
      ...manifest.partitions.development.cases.map((entry) => ({
        purpose: "development" as const,
        ...datasetCaseIdentity(entry)
      })),
      ...manifest.partitions.holdout.cases.map((entry) => ({
        purpose: "holdout" as const,
        ...datasetCaseIdentity(entry)
      }))
    ]).sort((left, right) => left.subjectId.localeCompare(right.subjectId))
  });
}

export function summarizeReviewFlowEvaluationGold(
  gold: readonly ReviewFlowEvaluationGold[]
): ReviewFlowEvaluationDatasetSummary {
  return summarizeGold(gold);
}

function summarizeGold(
  gold: readonly ReviewFlowEvaluationGold[]
): ReviewFlowEvaluationDatasetSummary {
  if (gold.length === 0) {
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_EMPTY_GOLD"
    );
  }
  const observedHistoricalTasteDimensionCounts = Object.fromEntries(
    editorialDimensionSchema.options.map((dimension) => [dimension, 0])
  ) as Record<z.infer<typeof editorialDimensionSchema>, number>;
  const observedHistoricalTechnicalReasonCounts = Object.fromEntries(
    reviewFlowEvaluationTechnicalReasonSchema.options.map((reason) => [reason, 0])
  ) as Record<ReviewFlowEvaluationTechnicalReason, number>;
  const independentVerdictCounts = {
    approve: 0,
    request_changes: 0,
    reject: 0
  };
  const historicalOutcomeCounts = { accepted: 0, rejected: 0 };
  const contestUseCounts = { used: 0, not_used: 0, unknown: 0 };
  for (const item of gold) {
    if (item.evaluationScope !== "verdict_and_taste") continue;
    if (
      reviewFlowEvaluationMetricIsApplicable(item, "historicalOutcome") &&
      item.historicalOutcome !== undefined
    ) {
      historicalOutcomeCounts[item.historicalOutcome] += 1;
      for (const reason of item.observedHistoricalTasteReasons) {
        observedHistoricalTasteDimensionCounts[reason.dimension] += 1;
      }
      for (const reason of item.observedHistoricalTechnicalReasons) {
        observedHistoricalTechnicalReasonCounts[reason] += 1;
      }
    }
    if (
      reviewFlowEvaluationMetricIsApplicable(item, "contestUse") &&
      item.contestUse !== undefined
    ) {
      contestUseCounts[item.contestUse] += 1;
    }
    if (item.independentVerdict !== undefined) {
      independentVerdictCounts[item.independentVerdict.verdict] += 1;
    }
  }
  return reviewFlowEvaluationDatasetSummarySchema.parse({
    caseCount: gold.length,
    scopeCounts: {
      verdict_and_taste: gold.filter(
        (item) => item.evaluationScope === "verdict_and_taste"
      ).length,
      originality_only: gold.filter(
        (item) => item.evaluationScope === "originality_only"
      ).length
    },
    historicalOutcomeCounts,
    contestUseCounts,
    independentVerdictLabeledCaseCount: gold.filter(
      (item) =>
        item.evaluationScope === "verdict_and_taste" &&
        item.independentVerdict !== undefined
    ).length,
    independentVerdictCounts,
    independentTasteLabeledCaseCount: gold.filter(
      (item) =>
        item.evaluationScope === "verdict_and_taste" &&
        item.independentTaste !== undefined
    ).length,
    independentOriginalityLabeledCaseCount: gold.filter(
      (item) =>
        item.evaluationScope === "verdict_and_taste" &&
        item.independentOriginality !== undefined
    ).length,
    confirmedDuplicatePositiveCount: gold.filter(
      (item) =>
        item.evaluationScope === "originality_only" ||
        item.independentOriginality?.confirmedDuplicate === true
    ).length,
    observedHistoricalTasteDimensionCounts,
    observedHistoricalTechnicalReasonCounts,
    tagLabeledCaseCount: gold.filter(
      (item) =>
        item.evaluationScope === "verdict_and_taste" &&
        item.expectedTagIds !== undefined
    ).length,
    difficultyLabeledCaseCount: gold.filter(
      (item) =>
        item.evaluationScope === "verdict_and_taste" &&
        reviewFlowEvaluationMetricIsApplicable(item, "independentDifficulty") &&
        item.independentDifficulty !== undefined
    ).length
  });
}

function assertUniqueReasons(
  reasons: readonly z.infer<typeof reviewFlowEvaluationTasteReasonSchema>[],
  context: z.RefinementCtx,
  path: string
): void {
  const keys = reasons.map(
    (reason) => `${reason.dimension}:${reason.direction}`
  );
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: "custom",
      path: [path],
      message: "品味原因轴不能重复。"
    });
  }
}

function readBoundFile(
  directory: Parameters<typeof readPrivateArtifactBytes>[0],
  binding: z.infer<typeof fileBindingSchema>,
  maximumBytes: number,
  byteBudget: { remaining: number }
): Buffer {
  const bytes = readPrivateArtifactBytes(directory, binding.fileName, maximumBytes);
  byteBudget.remaining -= bytes.byteLength;
  if (byteBudget.remaining < 0) {
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_DATASET_TOO_LARGE"
    );
  }
  if (sha256(bytes) !== binding.sha256) {
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_FILE_HASH_MISMATCH"
    );
  }
  return bytes;
}

function parseStrictRobotTask(bytes: Buffer): RobotReviewTask {
  const value = parseJsonBytes(bytes, "REVIEW_FLOW_EVALUATION_CONTENT_INVALID");
  const parsed = robotReviewTaskSchema.safeParse(value);
  if (!parsed.success) {
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_CONTENT_INVALID"
    );
  }
  return parsed.data;
}

function parseStrictDocument<T>(
  bytes: Buffer,
  schema: z.ZodType<T>,
  code: string
): T {
  try {
    return parseVersionedStrictArtifact({
      value: parsePhysicalBlindJson(decodeUtf8(bytes)),
      schema,
      // 具体 schema 仍精确限定各自版本；这里只允许当前材料使用的版本集合。
      supportedVersions: [1, 2, 3, 4, 5]
    });
  } catch {
    throw new ReviewFlowEvaluationDatasetError(code);
  }
}

function parseJsonBytes(bytes: Buffer, code: string): unknown {
  try {
    return parsePhysicalBlindJson(decodeUtf8(bytes));
  } catch {
    throw new ReviewFlowEvaluationDatasetError(code);
  }
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ReviewFlowEvaluationDatasetError(
      "REVIEW_FLOW_EVALUATION_FILE_INVALID_UTF8"
    );
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
