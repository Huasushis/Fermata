import { z } from "zod";
import {
  codeforcesDifficultySchema,
  difficultyLevelSchema,
  problemTypeSchema,
  reviewVerdictSchema
} from "../urmotiv-schemas";

export const reviewFlowRoleSchema = z.enum([
  "solver",
  "solution_analyst",
  "technical_auditor",
  "difficulty",
  "editorial_judge",
  "contest_fit",
  "originality",
  "tags",
  "critic",
  "adversary",
  "adjudicator"
]);
export type ReviewFlowRole = z.infer<typeof reviewFlowRoleSchema>;

export const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const evidenceIdSchema = z.string().regex(/^ev-[0-9a-f]{32}$/u);
const safeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u);
const boundedTextSchema = z.string().max(2_000_000);
const shortTextSchema = z.string().trim().min(1).max(4_000);
export const maximumReviewFlowSourceBytes = 8 * 1024 * 1024;

export const reviewFlowAssignmentContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().uuid(),
    assignmentId: z.string().uuid(),
    expectedRound: z.number().int().positive()
  })
  .strict();
export type ReviewFlowAssignmentContext = z.infer<typeof reviewFlowAssignmentContextSchema>;

export const reviewFlowExecutionContextSchema = reviewFlowAssignmentContextSchema
  .extend({
    runnerIdentity: digestSchema,
    engineBuildFingerprint: digestSchema,
    accuracyEvidenceFingerprint: digestSchema.nullable()
  })
  .strict();
export type ReviewFlowExecutionContext = z.infer<typeof reviewFlowExecutionContextSchema>;

export const roleAcceptedEventShapeSchema = z.object({
  category: z.enum([
    "done",
    "usage",
    "content",
    "reasoning",
    "content_reasoning",
    "role",
    "finish",
    "metadata"
  ]),
  shapeFingerprint: digestSchema,
  count: z.number().int().positive()
}).strict();

const roleTransportReceiptSchema = z
  .object({
    schemaVersion: z.literal(2),
    transportAttemptCount: z.number().int().positive().max(1_000),
    eofVerified: z.literal(true),
    responseMode: z.enum(["sse", "json"]),
    finishReasonStopVerified: z.literal(true),
    acceptedEventShapes: z.array(roleAcceptedEventShapeSchema).max(64).readonly(),
    sseDoneObserved: z.boolean().nullable()
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      (receipt.responseMode === "sse" && receipt.sseDoneObserved !== true) ||
      (receipt.responseMode === "json" && receipt.sseDoneObserved !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sseDoneObserved"],
        message: "可信审题调用必须完整观察 SSE DONE；JSON 回退不得伪造 DONE。"
      });
    }
  });

/** 由 llm.ts 在真实 EOF、JSON schema 校验成功后生成的封闭安全 receipt。 */
export const roleCompletionReceiptSchema = z
  .object({
    schemaVersion: z.literal(2),
    requestCount: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4)
    ]),
    transportAttemptCount: z.number().int().positive().max(2_000),
    eofVerified: z.literal(true),
    jsonSchemaValidated: z.literal(true),
    responses: z.union([
      z.tuple([roleTransportReceiptSchema]),
      z.tuple([roleTransportReceiptSchema, roleTransportReceiptSchema]),
      z.tuple([
        roleTransportReceiptSchema,
        roleTransportReceiptSchema,
        roleTransportReceiptSchema
      ]),
      z.tuple([
        roleTransportReceiptSchema,
        roleTransportReceiptSchema,
        roleTransportReceiptSchema,
        roleTransportReceiptSchema
      ])
    ])
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.responses.length !== receipt.requestCount) {
      context.addIssue({
        code: "custom",
        path: ["responses"],
        message: "生成轮数必须与逐轮传输证据数量一致。"
      });
    }
    const summedAttempts = receipt.responses.reduce(
      (sum, response) => sum + response.transportAttemptCount,
      0
    );
    if (
      receipt.transportAttemptCount < receipt.requestCount ||
      receipt.transportAttemptCount !== summedAttempts
    ) {
      context.addIssue({
        code: "custom",
        path: ["transportAttemptCount"],
        message: "HTTP 尝试数必须等于各生成轮传输尝试数之和。"
      });
    }
  });
export type RoleCompletionReceipt = z.infer<typeof roleCompletionReceiptSchema>;

export const trustedRoleExecutionResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    payload: z.unknown(),
    receipt: roleCompletionReceiptSchema
  })
  .strict();
export type TrustedRoleExecutionResult = z.infer<typeof trustedRoleExecutionResultSchema>;

export const reviewFlowSampleSchema = z
  .object({
    safeId: safeIdSchema,
    input: z.string().max(100_000),
    output: z.string().max(100_000),
    explanation: z.string().max(500_000).default("")
  })
  .strict();

export const reviewFlowLimitsSchema = z
  .object({
    timeMs: z.number().int().positive().max(600_000),
    memoryMiB: z.number().int().positive().max(262_144)
  })
  .strict();

export const reviewFlowReferenceImplementationSchema = z
  .object({
    language: z.string().trim().min(1).max(40),
    source: z.string().min(1).max(1_000_000)
  })
  .strict();

export const reviewFlowTagSchema = z
  .object({
    id: z.string().min(1).max(120),
    categoryId: z.string().min(1).max(120),
    categoryName: z.string().min(1).max(80),
    name: z.string().min(1).max(80),
    description: z.string().max(2_000),
    aliases: z.array(z.string().min(1).max(160)).max(100),
    active: z.literal(true)
  })
  .strict();

export const reviewFlowDuplicateEvidenceSchema = z
  .object({
    evidenceId: safeIdSchema,
    source: z.string().min(1).max(80),
    externalId: z.string().min(1).max(200),
    similarity: z.number().finite().min(0).max(1),
    sameProblemSuggestion: z.boolean(),
    summary: z.string().max(2_000)
  })
  .strict();

/** 完整输入只存在于编排器边界；各角色只能拿到后面定义的最小视图。 */
export const reviewFlowSourceSchema = z
  .object({
    schemaVersion: z.literal(1),
    problemContentHash: digestSchema,
    problemRevision: z.number().int().positive(),
    expectedRound: z.number().int().positive(),
    type: problemTypeSchema,
    statement: boundedTextSchema.min(1),
    solution: boundedTextSchema.min(1),
    constraints: boundedTextSchema.default(""),
    samples: z.array(reviewFlowSampleSchema).max(50),
    limits: reviewFlowLimitsSchema.nullable().default(null),
    referenceImplementation: reviewFlowReferenceImplementationSchema.nullable(),
    tagCatalogVersion: z.number().int().positive(),
    tagCatalog: z.array(reviewFlowTagSchema).min(1).max(10_000),
    duplicateEvidence: z.array(reviewFlowDuplicateEvidenceSchema).max(1_000),
    duplicateSimilarityRejectThreshold: z.number().finite().min(0).max(1)
  })
  .strict()
  .superRefine((source, context) => {
    const sampleIds = source.samples.map((sample) => sample.safeId);
    const tagIds = source.tagCatalog.map((tag) => tag.id);
    const duplicateIds = source.duplicateEvidence.map((item) => item.evidenceId);
    if (new Set(sampleIds).size !== sampleIds.length) {
      context.addIssue({ code: "custom", path: ["samples"], message: "样例编号不能重复。" });
    }
    if (new Set(tagIds).size !== tagIds.length) {
      context.addIssue({ code: "custom", path: ["tagCatalog"], message: "标签编号不能重复。" });
    }
    if (new Set(duplicateIds).size !== duplicateIds.length) {
      context.addIssue({ code: "custom", path: ["duplicateEvidence"], message: "查重证据编号不能重复。" });
    }
    if (
      new TextEncoder().encode(JSON.stringify(source)).byteLength > maximumReviewFlowSourceBytes
    ) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "审题输入总大小超过安全上限；工作流不会截断题面、题解或证据。"
      });
    }
  });
export type ReviewFlowSource = z.infer<typeof reviewFlowSourceSchema>;

export const statementOnlyViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    problemContentHash: digestSchema,
    type: problemTypeSchema,
    statement: boundedTextSchema.min(1),
    constraints: boundedTextSchema,
    samples: z.array(reviewFlowSampleSchema).max(50),
    limits: reviewFlowLimitsSchema.nullable()
  })
  .strict();
export type StatementOnlyView = z.infer<typeof statementOnlyViewSchema>;

export const solverPayloadSchema = z
  .object({
    solved: z.boolean(),
    narrative: z.string().trim().min(1).max(200_000),
    approach: z.string().trim().min(1).max(20_000),
    claimedComplexity: z.string().trim().min(1).max(2_000),
    uncertainties: z.array(z.string().trim().min(1).max(2_000)).max(50)
  })
  .strict();
export type SolverPayload = z.infer<typeof solverPayloadSchema>;

export const solutionAnalystPayloadSchema = z
  .object({
    solverCorrect: z.boolean(),
    officialSolutionCorrect: z.boolean(),
    approachRelation: z.enum(["equivalent", "compatible", "different", "contradictory"]),
    keyInsights: z.array(z.string().trim().min(1).max(2_000)).max(50),
    issues: z.array(z.string().trim().min(1).max(2_000)).max(50),
    rationale: shortTextSchema
  })
  .strict();
export type SolutionAnalystPayload = z.infer<typeof solutionAnalystPayloadSchema>;

export const hardBlockerCodeSchema = z.enum([
  "SOLUTION_INCORRECT",
  "REFERENCE_IMPLEMENTATION_INCORRECT",
  "SAMPLE_MISMATCH",
  "COMPLEXITY_UNACCEPTABLE",
  "CONFIRMED_DUPLICATE",
  "EVIDENCE_MISSING",
  "UNRESOLVED_CONFLICT"
]);
export type HardBlockerCode = z.infer<typeof hardBlockerCodeSchema>;

export const technicalCheckStatusSchema = z.enum(["verified", "concern", "not_assessed"]);

/**
 * 技术核验以题面和题解为核心；参考实现只是有则检查的旁路。
 * unavailable/not_executed 不代表题目质量问题，也不会自行阻断通过。
 */
export const technicalAuditPayloadSchema = z
  .object({
    statementSolutionConsistency: technicalCheckStatusSchema,
    judgeability: technicalCheckStatusSchema,
    sampleConsistency: technicalCheckStatusSchema,
    constraintSufficiency: technicalCheckStatusSchema,
    referenceImplementation: z
      .object({
        provided: z.boolean(),
        status: z.enum(["verified", "invalid", "not_executed", "unavailable"]),
        executionMode: z.enum(["sandbox", "not_executed"]),
        compileStatus: z.enum(["passed", "failed", "not_run"]),
        sampleCount: z.number().int().nonnegative(),
        samplePassed: z.number().int().nonnegative().nullable(),
        algorithmEquivalent: z.boolean().nullable(),
        complexityAcceptable: z.boolean().nullable()
      })
      .strict(),
    concerns: z.array(z.string().trim().min(1).max(2_000)).max(100),
    rationale: shortTextSchema
  })
  .strict()
  .superRefine((payload, context) => {
    const reference = payload.referenceImplementation;
    if (
      reference.executionMode === "not_executed" &&
      (reference.status === "verified" ||
        reference.samplePassed !== null ||
        reference.compileStatus !== "not_run")
    ) {
      context.addIssue({
        code: "custom",
        path: ["referenceImplementation", "status"],
        message: "未执行时不能声称编译、样例或整体验证通过。"
      });
    }
    if (
      reference.executionMode === "sandbox" &&
      reference.samplePassed !== null &&
      reference.samplePassed > reference.sampleCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["referenceImplementation", "samplePassed"],
        message: "样例通过数不能超过总数。"
      });
    }
    if (
      (reference.provided && reference.status === "unavailable") ||
      (!reference.provided && reference.executionMode === "sandbox") ||
      (reference.executionMode === "sandbox" && reference.status === "not_executed")
    ) {
      context.addIssue({
        code: "custom",
        path: ["referenceImplementation", "status"],
        message: "参考实现状态与是否提供、是否执行不一致。"
      });
    }
    if (
      reference.status === "verified" &&
      (reference.executionMode !== "sandbox" ||
        reference.compileStatus !== "passed" ||
        reference.samplePassed !== reference.sampleCount ||
        reference.algorithmEquivalent !== true ||
        reference.complexityAcceptable !== true)
    ) {
      context.addIssue({
        code: "custom",
        path: ["referenceImplementation", "status"],
        message: "只有完整隔离验证通过时才能标记参考实现已验证。"
      });
    }
    if (reference.compileStatus === "failed" && reference.status !== "invalid") {
      context.addIssue({
        code: "custom",
        path: ["referenceImplementation", "compileStatus"],
        message: "编译失败的参考实现必须标记为无效。"
      });
    }
    if (
      !reference.provided &&
      (reference.status !== "unavailable" ||
        reference.executionMode !== "not_executed" ||
        reference.compileStatus !== "not_run" ||
        reference.sampleCount !== 0 ||
        reference.samplePassed !== null ||
        reference.algorithmEquivalent !== null ||
        reference.complexityAcceptable !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["referenceImplementation"],
        message: "未提供参考实现时只能记录为未评估。"
      });
    }
    if (
      reference.executionMode === "not_executed" &&
      reference.status === "invalid"
    ) {
      context.addIssue({
        code: "custom",
        path: ["referenceImplementation", "status"],
        message: "未执行的参考实现不能标记为无效。"
      });
    }
  });
export type TechnicalAuditPayload = z.infer<typeof technicalAuditPayloadSchema>;

export const difficultyPayloadSchema = z
  .object({
    codeforcesDifficulty: codeforcesDifficultySchema,
    thinkingLevel: difficultyLevelSchema,
    codingLevel: difficultyLevelSchema,
    confidence: z.number().finite().min(0).max(1),
    rationale: shortTextSchema
  })
  .strict();
export type DifficultyPayload = z.infer<typeof difficultyPayloadSchema>;

export const editorialDimensionSchema = z.enum([
  "novelty",
  "idea_depth",
  "naturalness",
  "contestant_experience",
  "icpc_fit",
  "implementation_balance",
  "difficulty_role",
  "fairness",
  "judgeability",
  "statement_expression",
  "solution_exposition",
  "data_preparation"
]);
export type EditorialDimension = z.infer<typeof editorialDimensionSchema>;

export const editorialEvidenceSchema = z
  .object({
    dimension: editorialDimensionSchema,
    direction: z.enum(["strength", "concern"]),
    severity: z.enum(["note", "minor", "major", "fundamental"]),
    confidence: z.number().finite().min(0).max(1),
    summary: z.string().trim().min(1).max(2_000)
  })
  .strict();

const bidirectionalEvidenceCoverageSchema = z
  .object({
    strengths: z.enum(["found", "none_found"]),
    concerns: z.enum(["found", "none_found"])
  })
  .strict();

function requireBidirectionalEvidenceCoverage(
  payload: {
    readonly evidence: readonly { readonly direction: "strength" | "concern" }[];
    readonly evidenceCoverage: z.infer<typeof bidirectionalEvidenceCoverageSchema>;
  },
  context: z.RefinementCtx
): void {
  for (const [field, direction] of [
    ["strengths", "strength"],
    ["concerns", "concern"]
  ] as const) {
    const found = payload.evidence.some((item) => item.direction === direction);
    if ((payload.evidenceCoverage[field] === "found") !== found) {
      context.addIssue({
        code: "custom",
        path: ["evidenceCoverage", field],
        message: "证据覆盖声明与实际证据方向不一致。"
      });
    }
  }
}

/** 历史审核中实际区分通过/否决的“命题品味”证据，而非技术正确性汇总。 */
export const editorialPayloadSchema = z
  .object({
    qualityLevel: difficultyLevelSchema,
    noveltyLevel: difficultyLevelSchema,
    ideaDepthLevel: difficultyLevelSchema,
    naturalnessLevel: difficultyLevelSchema,
    contestantExperienceLevel: difficultyLevelSchema,
    evidenceCoverage: bidirectionalEvidenceCoverageSchema,
    evidence: z.array(editorialEvidenceSchema).min(1).max(100),
    rationale: shortTextSchema
  })
  .strict()
  .superRefine(requireBidirectionalEvidenceCoverage);
export type EditorialPayload = z.infer<typeof editorialPayloadSchema>;

/** ICPC 适配、实现负担、公平性和题组角色独立于“是否正确”单独判断。 */
export const contestFitPayloadSchema = z
  .object({
    icpcFit: z.enum(["strong", "acceptable", "weak", "unsuitable"]),
    implementationBurden: difficultyLevelSchema,
    thinkingImplementationBalance: z.enum(["strong", "acceptable", "weak"]),
    knowledgeFairness: z.enum(["fair", "questionable", "unfair"]),
    problemsetRole: z.enum([
      "introductory",
      "standard",
      "challenging",
      "specialized",
      "unclear"
    ]),
    roleConfidence: z.number().finite().min(0).max(1),
    evidenceCoverage: bidirectionalEvidenceCoverageSchema,
    evidence: z.array(editorialEvidenceSchema).min(1).max(100),
    rationale: shortTextSchema
  })
  .strict()
  .superRefine(requireBidirectionalEvidenceCoverage);
export type ContestFitPayload = z.infer<typeof contestFitPayloadSchema>;

export const originalityPayloadSchema = z
  .object({
    originalityLevel: difficultyLevelSchema,
    sameProblemAsExisting: z.boolean(),
    highestSimilarity: z.number().finite().min(0).max(1),
    evidenceIds: z.array(safeIdSchema).max(1_000),
    rationale: shortTextSchema
  })
  .strict();
export type OriginalityPayload = z.infer<typeof originalityPayloadSchema>;

function rejectDuplicateTagIds(
  payload: { readonly tagIds: readonly string[] },
  context: z.RefinementCtx
): void {
  if (new Set(payload.tagIds).size !== payload.tagIds.length) {
    context.addIssue({ code: "custom", path: ["tagIds"], message: "标签不能重复。" });
  }
}

export const tagsPayloadSchema = z
  .object({
    tagIds: z.array(z.string().min(1).max(120)).min(1).max(30),
    rationale: shortTextSchema
  })
  .strict()
  .superRefine(rejectDuplicateTagIds);

export function createTagsPayloadSchema(
  activeTagIds: readonly string[]
): z.ZodType<TagsPayload> {
  const canonicalTagIds = [...new Set(activeTagIds)];
  if (canonicalTagIds.length === 0) {
    throw new Error("REVIEW_FLOW_TAG_CATALOG_EMPTY");
  }
  return z
    .object({
      tagIds: z
        .array(z.enum(canonicalTagIds as [string, ...string[]]))
        .min(1)
        .max(Math.min(30, canonicalTagIds.length)),
      rationale: shortTextSchema
    })
    .strict()
    .superRefine(rejectDuplicateTagIds);
}
export type TagsPayload = z.infer<typeof tagsPayloadSchema>;

const createCriticConflictSchema = (evidenceId: z.ZodType<string>) => z
  .object({
    leftEvidenceId: evidenceId,
    rightEvidenceId: evidenceId,
    code: z.string().regex(/^[A-Z0-9_]{1,120}$/u),
    severity: z.enum(["note", "warning", "blocker"]),
    rationale: z.string().trim().min(1).max(2_000)
  })
  .strict();

function rejectInvalidCriticReferences(
  payload: {
    readonly conflicts: readonly {
      readonly leftEvidenceId: string;
      readonly rightEvidenceId: string;
    }[];
    readonly missingRoles: readonly string[];
  },
  context: z.RefinementCtx
): void {
  payload.missingRoles.forEach((_, index) => {
    context.addIssue({
      code: "custom",
      path: ["missingRoles", index],
      message: "完整证据视图不允许缺失角色。"
    });
  });
  payload.conflicts.forEach((conflict, index) => {
    if (conflict.leftEvidenceId === conflict.rightEvidenceId) {
      context.addIssue({
        code: "custom",
        path: ["conflicts", index, "rightEvidenceId"],
        message: "冲突必须引用两个不同的证据。"
      });
    }
  });
}

function criticPayloadSchemaForEvidenceId(
  evidenceId: z.ZodType<string>
) {
  return z
    .object({
      conflicts: z.array(createCriticConflictSchema(evidenceId)).max(200),
      missingRoles: z.array(reviewFlowRoleSchema).max(20),
      rationale: shortTextSchema
    })
    .strict()
    .superRefine(rejectInvalidCriticReferences);
}

export const criticPayloadSchema = criticPayloadSchemaForEvidenceId(evidenceIdSchema);
export type CriticPayload = z.infer<typeof criticPayloadSchema>;

export function createCriticPayloadSchema(allowedEvidenceIds: readonly string[]) {
  const canonicalEvidenceIds = [...new Set(allowedEvidenceIds)];
  if (canonicalEvidenceIds.length === 0) {
    throw new Error("REVIEW_FLOW_CRITIC_EVIDENCE_EMPTY");
  }
  const evidenceId = z.enum(canonicalEvidenceIds as [string, ...string[]]);
  return criticPayloadSchemaForEvidenceId(evidenceId);
}

export const adversaryPayloadSchema = z
  .object({
    counterexamples: z
      .array(
        z
          .object({
            targetEvidenceId: evidenceIdSchema,
            scenario: z.string().trim().min(1).max(4_000),
            impact: z.enum(["none", "minor", "major", "fatal"])
          })
          .strict()
      )
      .max(200),
    rationale: shortTextSchema
  })
  .strict();
export type AdversaryPayload = z.infer<typeof adversaryPayloadSchema>;

export const adjudicatorPayloadSchema = z
  .object({
    verdict: reviewVerdictSchema,
    qualityLevel: difficultyLevelSchema,
    fixability: z.enum(["none", "minor", "major", "fundamental"]),
    strengths: z.array(z.string().trim().min(1).max(2_000)).max(50),
    improvements: z.string().trim().min(1).max(20_000),
    publicComment: z.string().trim().max(20_000).default(""),
    privateNote: z.string().trim().max(20_000).default(""),
    citedEvidenceIds: z.array(evidenceIdSchema).min(1).max(100)
  })
  .strict()
  .superRefine((payload, context) => {
    const invalid =
      (payload.verdict === "approve" && ["major", "fundamental"].includes(payload.fixability)) ||
      (payload.verdict === "request_changes" && !["minor", "major"].includes(payload.fixability)) ||
      (payload.verdict === "reject" && payload.fixability !== "fundamental");
    if (invalid) {
      context.addIssue({
        code: "custom",
        path: ["fixability"],
        message: "裁决与可修改性不一致。"
      });
    }
  });
export type AdjudicatorPayload = z.infer<typeof adjudicatorPayloadSchema>;

export const roleIdentitySchema = z
  .object({
    promptVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u),
    modelIdentity: digestSchema
  })
  .strict();
export type RoleIdentity = z.infer<typeof roleIdentitySchema>;
