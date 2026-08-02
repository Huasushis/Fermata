import { z } from "zod";
import {
  getLlmFailureAudit,
  isLlmRequestStartGate,
  LlmRequestError,
  llmTransportProtocolVersion,
  withLlmRequestStartGate,
  type LlmFailureAudit,
  type LlmRequestStartGate
} from "../llm";
import {
  codeforcesDifficultySchema,
  difficultyLevelSchema,
  reviewInputSchema,
  reviewVerdictSchema,
  type ReviewInput
} from "../urmotiv-schemas";
import {
  deepFreeze,
  hashCanonicalValue,
  sealEvidenceArtifact,
  type EvidenceExecutionBinding,
  type EvidenceArtifact
} from "./evidence";
import {
  adjudicatorPayloadSchema,
  adversaryPayloadSchema,
  contestFitPayloadSchema,
  criticPayloadSchema,
  difficultyPayloadSchema,
  digestSchema,
  editorialPayloadSchema,
  editorialDimensionSchema,
  hardBlockerCodeSchema,
  originalityPayloadSchema,
  reviewFlowRoleSchema,
  reviewFlowAssignmentContextSchema,
  reviewFlowExecutionContextSchema,
  roleIdentitySchema,
  solutionAnalystPayloadSchema,
  solverPayloadSchema,
  tagsPayloadSchema,
  technicalCheckStatusSchema,
  technicalAuditPayloadSchema,
  trustedRoleExecutionResultSchema,
  type AdjudicatorPayload,
  type AdversaryPayload,
  type ContestFitPayload,
  type CriticPayload,
  type DifficultyPayload,
  type EditorialPayload,
  type HardBlockerCode,
  type OriginalityPayload,
  type ReviewFlowRole,
  type RoleCompletionReceipt,
  type RoleIdentity,
  type ReviewFlowExecutionContext,
  type SolutionAnalystPayload,
  type SolverPayload,
  type TagsPayload,
  type TechnicalAuditPayload
} from "./schemas";
import {
  historicalReviewRubricDigest,
  historicalReviewRubricPromptDigest
} from "./historical-rubric";
import {
  isProductionEligibleReviewFlowLlmBundle,
  isTrustedReviewFlowLlmBundle,
  type ReviewFlowLlmBundle
} from "./llm-roles";
import {
  isBuiltReviewFlowTaskSourceResult,
  type ReviewFlowTaskSourceResult
} from "./task-source";
import {
  buildAdjudicatorView,
  buildAdversaryView,
  buildContestFitView,
  buildCriticView,
  buildDifficultyView,
  buildEditorialJudgeView,
  buildOriginalityView,
  buildSolutionAnalystView,
  buildStatementOnlyView,
  buildTagsView,
  buildTechnicalAuditorView,
  freezeReviewFlowSource,
  type AdjudicatorView,
  type AdversaryView,
  type ContestFitView,
  type CriticView,
  type DifficultyView,
  type EditorialJudgeView,
  type OriginalityView,
  type SolutionAnalystView,
  type TagsView,
  type TechnicalAuditorView
} from "./views";

/** 任一视图、证据封装、裁决或传输 receipt 语义变化时都必须重新绑定。 */
export const reviewFlowRuntimeImplementationVersion =
  "review-flow-runtime-v3-process-local-evidence" as const;

export const reviewFlowInternalErrorCodeAllowlist = Object.freeze([
  "REVIEW_FLOW_SOURCE_INVALID",
  "REVIEW_FLOW_SUBMISSION_INVALID",
  "REVIEW_FLOW_SUBMISSION_NOT_CREATED",
  "REVIEW_FLOW_ROLE_FAILED",
  "REVIEW_FLOW_EXECUTION_CONTEXT_INVALID",
  "REVIEW_FLOW_TASK_SOURCE_UNTRUSTED",
  "REVIEW_FLOW_TRUSTED_RUNNER_INVALID",
  "REVIEW_FLOW_RUNNER_INVALID",
  "REVIEW_FLOW_IDENTITY_INVALID",
  "REVIEW_FLOW_TAG_SELECTION_INVALID",
  "REVIEW_FLOW_REFERENCE_STATE_INVALID",
  "REVIEW_FLOW_EVIDENCE_REFERENCE_INVALID"
] as const);

export type ReviewFlowInternalErrorCode =
  (typeof reviewFlowInternalErrorCodeAllowlist)[number];

export const reviewFlowFailureKindAllowlist = Object.freeze([
  "input_invalid",
  "validation",
  "service_http",
  "transport",
  "timeout",
  "cancelled",
  "output_limit",
  "content_filtered",
  "protocol",
  "schema_output",
  "role_internal"
] as const);

export type ReviewFlowFailureKind =
  (typeof reviewFlowFailureKindAllowlist)[number];

export type ReviewFlowOutcomeErrorCode =
  | ReviewFlowInternalErrorCode
  | "REVIEW_FLOW_UNEXPECTED_FAILURE";

const privateReviewFlowErrorFields = new WeakMap<object, {
  readonly code: unknown;
  readonly failureKind: unknown;
}>();

export class ReviewFlowError extends Error {
  readonly code: ReviewFlowInternalErrorCode;
  readonly role: ReviewFlowRole | null;
  readonly failureKind: ReviewFlowFailureKind;

  constructor(
    code: ReviewFlowInternalErrorCode,
    role: ReviewFlowRole | null = null,
    failureKind: ReviewFlowFailureKind = "validation"
  ) {
    super(code);
    this.name = "ReviewFlowError";
    this.code = code;
    this.role = role;
    this.failureKind = failureKind;
    privateReviewFlowErrorFields.set(this, Object.freeze({ code, failureKind }));
  }
}

export interface ReviewFlowRoles {
  readonly solver: (view: ReturnType<typeof buildStatementOnlyView>) => Promise<unknown>;
  readonly solutionAnalyst: (view: SolutionAnalystView) => Promise<unknown>;
  readonly technicalAuditor: (view: TechnicalAuditorView) => Promise<unknown>;
  readonly difficulty: (view: DifficultyView) => Promise<unknown>;
  readonly editorialJudge: (view: EditorialJudgeView) => Promise<unknown>;
  readonly contestFit: (view: ContestFitView) => Promise<unknown>;
  readonly originality: (view: OriginalityView) => Promise<unknown>;
  readonly tags: (view: TagsView) => Promise<unknown>;
  readonly critic: (view: CriticView) => Promise<unknown>;
  readonly adversary: (view: AdversaryView) => Promise<unknown>;
  readonly adjudicator: (view: AdjudicatorView) => Promise<unknown>;
}

export interface ReviewFlowArtifacts {
  readonly solver: EvidenceArtifact<SolverPayload>;
  readonly solutionAnalyst: EvidenceArtifact<SolutionAnalystPayload>;
  readonly technicalAudit: EvidenceArtifact<TechnicalAuditPayload>;
  readonly difficulty: EvidenceArtifact<DifficultyPayload>;
  readonly editorial: EvidenceArtifact<EditorialPayload>;
  readonly contestFit: EvidenceArtifact<ContestFitPayload>;
  readonly originality: EvidenceArtifact<OriginalityPayload>;
  readonly tags: EvidenceArtifact<TagsPayload>;
  readonly critic: EvidenceArtifact<CriticPayload>;
  readonly adversary: EvidenceArtifact<AdversaryPayload>;
  readonly adjudicator: EvidenceArtifact<AdjudicatorPayload>;
}

export interface ReviewFlowDecision {
  readonly submissionHash: string;
  readonly tagCatalogVersion: number;
  readonly duplicateSimilarityRejectThreshold: number;
  readonly policyHash: string;
  readonly decisionId: string;
  readonly sourceSnapshotHash: string;
  readonly runContextHash: string | null;
  readonly runBinding: ReviewFlowSafeRunBinding;
  readonly executionTransportMode: ReviewFlowLlmBundle["transportMode"] | null;
  /** 只有生产传输层和 verifier 提供的准确性指纹同时绑定时才可能为 true。 */
  readonly executionEligible: boolean;
  readonly accuracyEvidenceFingerprint: string | null;
  readonly hardBlockers: readonly HardBlockerCode[];
  readonly evidenceIds: readonly string[];
  readonly roleCompletions: readonly ReviewFlowRoleCompletionSummary[];
}

export interface ReviewFlowSafeRunBinding {
  readonly schemaVersion: 1;
  readonly problemContentHash: string;
  readonly problemId: string | null;
  readonly problemRevision: number;
  readonly expectedRound: number;
  readonly tagCatalogVersion: number;
  readonly taskProvenanceHash: string | null;
  readonly anklangEvidenceExpiresAt: string | null;
  readonly engineBuildFingerprint: string | null;
  readonly accuracyEvidenceFingerprint: string | null;
  readonly runId: string | null;
  readonly assignmentId: string | null;
  readonly runnerIdentity: string | null;
}

export interface ReviewFlowRoleCompletionSummary {
  readonly role: ReviewFlowRole;
  readonly evidenceId: string;
  readonly receiptHash: string | null;
  readonly requestCount: 0 | 1 | 2;
  readonly transportAttemptCount: number;
  readonly responseModes: readonly ("sse" | "json")[];
  readonly responses: readonly {
    readonly responseMode: "sse" | "json";
    readonly transportAttemptCount: number;
    readonly eofVerified: true;
    readonly finishReasonStopVerified: true;
    readonly sseDoneObserved: true | null;
  }[];
}

export interface ReviewFlowRoleFailureSummary {
  readonly role: ReviewFlowRole;
  readonly failureKind: ReviewFlowFailureKind;
  readonly httpStatus: number | null;
  readonly requestCount: 0 | 1 | 2;
  readonly transportAttemptCount: number;
  readonly completedResponseCount: number;
  readonly terminalResponseMode: "sse" | "json" | null;
  readonly terminalEofObserved: boolean;
  readonly terminalFinishReasonStopObserved: boolean;
  readonly terminalSseDoneObserved: boolean | null;
}

export interface ReviewFlowIncompleteFailure {
  readonly schemaVersion: 1;
  readonly failureId: string;
  readonly code: ReviewFlowOutcomeErrorCode;
  readonly failureKind: ReviewFlowFailureKind;
  readonly sourceSnapshotHash: string | null;
  readonly runBinding: ReviewFlowSafeRunBinding | null;
  readonly failedRoles: readonly ReviewFlowRoleFailureSummary[];
  readonly completedRoles: readonly ReviewFlowRoleCompletionSummary[];
}

export type ReviewFlowOutcome =
  | { readonly status: "complete"; readonly decision: ReviewFlowDecision }
  | { readonly status: "incomplete"; readonly failure: ReviewFlowIncompleteFailure };

const reviewFlowCalibrationEvidenceSchema = z
  .object({
    dimension: editorialDimensionSchema,
    direction: z.enum(["strength", "concern"]),
    severity: z.enum(["note", "minor", "major", "fundamental"]),
    confidence: z.number().finite().min(0).max(1)
  })
  .strict();

const reviewFlowCalibrationEvidenceCoverageSchema = z
  .object({
    strengths: z.enum(["found", "none_found"]),
    concerns: z.enum(["found", "none_found"])
  })
  .strict();

const reviewFlowCalibrationReceiptResponseSchema = z
  .object({
    responseMode: z.enum(["sse", "json"]),
    transportAttemptCount: z.number().int().positive().max(1_000),
    eofVerified: z.literal(true),
    finishReasonStopVerified: z.literal(true),
    sseDoneObserved: z.union([z.literal(true), z.null()])
  })
  .strict()
  .superRefine((response, context) => {
    if (
      (response.responseMode === "sse" && response.sseDoneObserved !== true) ||
      (response.responseMode === "json" && response.sseDoneObserved !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sseDoneObserved"],
        message: "SSE 必须观察 DONE；JSON 回退不得伪造 DONE。"
      });
    }
  });

export const reviewFlowCalibrationRoleReceiptSchema = z
  .object({
    role: reviewFlowRoleSchema,
    receiptHash: digestSchema,
    requestCount: z.union([z.literal(1), z.literal(2)]),
    transportAttemptCount: z.number().int().positive().max(2_000),
    responses: z
      .array(reviewFlowCalibrationReceiptResponseSchema)
      .min(1)
      .max(2)
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.responses.length !== receipt.requestCount ||
      receipt.responses.reduce(
        (sum, response) => sum + response.transportAttemptCount,
        0
      ) !== receipt.transportAttemptCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["responses"],
        message: "逐响应收据必须与请求数和传输尝试数一致。"
      });
    }
  });

/**
 * 离线标定唯一可见的完整结果。这里只保留可计分的数值和枚举；模型生成的
 * 解释、评论、改进建议、证据摘要以及题目材料都不属于该边界。
 */
export const reviewFlowCalibrationProjectionSchema = z
  .object({
    schemaVersion: z.literal(2),
    verdict: reviewVerdictSchema,
    codeforcesDifficulty: codeforcesDifficultySchema,
    qualityLevel: difficultyLevelSchema,
    originalityLevel: difficultyLevelSchema,
    thinkingLevel: difficultyLevelSchema,
    codingLevel: difficultyLevelSchema,
    tagIds: z.array(z.string().min(1).max(120)).min(1).max(30),
    hardBlockers: z.array(hardBlockerCodeSchema),
    difficultyConfidence: z.number().finite().min(0).max(1),
    technical: z
      .object({
        officialSolutionCorrect: z.boolean(),
        statementSolutionConsistency: technicalCheckStatusSchema,
        judgeability: technicalCheckStatusSchema,
        sampleConsistency: technicalCheckStatusSchema,
        constraintSufficiency: technicalCheckStatusSchema,
        referenceImplementation: z
          .object({
            provided: z.boolean(),
            status: z.enum([
              "verified",
              "invalid",
              "not_executed",
              "unavailable"
            ]),
            complexityAcceptable: z.boolean().nullable()
          })
          .strict()
      })
      .strict(),
    editorial: z
      .object({
        qualityLevel: difficultyLevelSchema,
        noveltyLevel: difficultyLevelSchema,
        ideaDepthLevel: difficultyLevelSchema,
        naturalnessLevel: difficultyLevelSchema,
        contestantExperienceLevel: difficultyLevelSchema,
        evidenceCoverage: reviewFlowCalibrationEvidenceCoverageSchema,
        evidence: z.array(reviewFlowCalibrationEvidenceSchema).min(1).max(100)
      })
      .strict(),
    contestFit: z
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
        evidenceCoverage: reviewFlowCalibrationEvidenceCoverageSchema,
        evidence: z.array(reviewFlowCalibrationEvidenceSchema).min(1).max(100)
      })
      .strict(),
    originality: z
      .object({
        originalityLevel: difficultyLevelSchema,
        sameProblemAsExisting: z.boolean(),
        highestSimilarity: z.number().finite().min(0).max(1)
      })
      .strict(),
    roleReceipts: z.array(reviewFlowCalibrationRoleReceiptSchema).length(11),
    receiptSetHash: digestSchema
  })
  .strict()
  .superRefine((projection, context) => {
    const expectedRoles = reviewFlowRoleSchema.options;
    if (
      projection.roleReceipts.some(
        (receipt, index) =>
          receipt.role !== expectedRoles[index] ||
          receipt.receiptHash !== hashCanonicalValue({
            schemaVersion: 2,
            requestCount: receipt.requestCount,
            transportAttemptCount: receipt.transportAttemptCount,
            eofVerified: true,
            jsonSchemaValidated: true,
            responses: receipt.responses.map((response) => ({
              schemaVersion: 2,
              transportAttemptCount: response.transportAttemptCount,
              eofVerified: response.eofVerified,
              responseMode: response.responseMode,
              finishReasonStopVerified: response.finishReasonStopVerified,
              sseDoneObserved: response.sseDoneObserved
            }))
          })
      ) ||
      projection.receiptSetHash !== hashCanonicalValue(projection.roleReceipts)
    ) {
      context.addIssue({
        code: "custom",
        path: ["roleReceipts"],
        message: "必须按固定顺序绑定完整 11 角色传输收据。"
      });
    }
  });

export type ReviewFlowCalibrationProjection = z.infer<
  typeof reviewFlowCalibrationProjectionSchema
>;

export interface ReviewFlowCalibrationInput {
  readonly taskSource: unknown;
  readonly trustedRunner: unknown;
  readonly executionContext: unknown;
  readonly requestStartGate: unknown;
}

export type ReviewFlowCalibrationOutcome =
  | {
      readonly status: "complete";
      readonly projection: ReviewFlowCalibrationProjection;
    }
  | Extract<ReviewFlowOutcome, { readonly status: "incomplete" }>;

const privateArtifacts = new WeakMap<ReviewFlowDecision, ReviewFlowArtifacts>();
const privateSubmissions = new WeakMap<
  ReviewFlowDecision,
  {
    readonly review: ReviewInput;
    readonly taskSource: ReviewFlowTaskSourceResult | null;
    consumed: boolean;
  }
>();

/**
 * 仅供单元测试核对隔离边界；生产 decision 不含可枚举 artifact/payload 字段。
 * 原始/结构化模型内容不能因 JSON.stringify(decision) 进入日志或报告。
 */
export function inspectReviewFlowArtifactsForTest(
  decision: ReviewFlowDecision
): ReviewFlowArtifacts {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("REVIEW_FLOW_PRIVATE_ARTIFACT_ACCESS_FORBIDDEN");
  }
  const artifacts = privateArtifacts.get(decision);
  if (artifacts === undefined) {
    throw new Error("REVIEW_FLOW_PRIVATE_ARTIFACTS_UNAVAILABLE");
  }
  return artifacts;
}

/** 仅供单元测试核对提交载荷；普通 decision/outcome 永远不公开模型评论。 */
export function inspectReviewFlowSubmissionForTest(
  decision: ReviewFlowDecision
): ReviewInput {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("REVIEW_FLOW_PRIVATE_SUBMISSION_ACCESS_FORBIDDEN");
  }
  const submission = privateSubmissions.get(decision);
  if (submission === undefined) {
    throw new Error("REVIEW_FLOW_PRIVATE_SUBMISSION_UNAVAILABLE");
  }
  return submission.review;
}

export interface ReviewFlowSubmissionExpectation {
  /** 必须是本次运行实际使用、且仍带进程内品牌的原始 task source。 */
  readonly taskSource: unknown;
  readonly assignmentId: string;
  readonly problemContentHash: string;
  readonly problemRevision: number;
  readonly expectedRound: number;
  readonly tagCatalogVersion: number;
  readonly accuracyEvidenceFingerprint: string;
}

/**
 * 在真正向 Urmotiv 提交前一次性取出私有载荷。对象品牌、生产资格和任务绑定
 * 任一不符都统一拒绝，避免伪造 decision 或跨任务复用评价。
 */
export function consumeReviewFlowSubmission(
  decision: ReviewFlowDecision,
  expected: ReviewFlowSubmissionExpectation
): ReviewInput {
  const submission = privateSubmissions.get(decision);
  const taskSource = isBuiltReviewFlowTaskSourceResult(expected.taskSource)
    ? expected.taskSource
    : null;
  const sourceSnapshotHash = taskSource === null
    ? null
    : hashCanonicalValue(taskSource);
  const taskProvenanceHash = taskSource === null
    ? null
    : hashCanonicalValue(taskSource.provenance);
  const evidenceExpiresAt = submission === undefined
    ? null
    : decision.runBinding.anklangEvidenceExpiresAt;
  if (
    submission === undefined ||
    submission.consumed ||
    taskSource === null ||
    submission.taskSource !== taskSource ||
    !decision.executionEligible ||
    decision.sourceSnapshotHash !== sourceSnapshotHash ||
    decision.runBinding.taskProvenanceHash !== taskProvenanceHash ||
    taskSource.provenance.anklang.reviewItemExpiresAt !== evidenceExpiresAt ||
    (evidenceExpiresAt !== null && Date.parse(evidenceExpiresAt) <= Date.now()) ||
    decision.runBinding.assignmentId !== expected.assignmentId ||
    decision.runBinding.problemContentHash !== expected.problemContentHash ||
    decision.runBinding.problemRevision !== expected.problemRevision ||
    decision.runBinding.expectedRound !== expected.expectedRound ||
    decision.runBinding.tagCatalogVersion !== expected.tagCatalogVersion ||
    decision.runBinding.accuracyEvidenceFingerprint !== expected.accuracyEvidenceFingerprint ||
    decision.accuracyEvidenceFingerprint !== expected.accuracyEvidenceFingerprint ||
    taskSource.taskBinding.assignmentId !== expected.assignmentId ||
    taskSource.taskBinding.problemContentHash !== expected.problemContentHash ||
    taskSource.taskBinding.problemRevision !== expected.problemRevision ||
    taskSource.taskBinding.expectedRound !== expected.expectedRound ||
    taskSource.taskBinding.tagCatalogVersion !== expected.tagCatalogVersion ||
    hashCanonicalValue(submission.review) !== decision.submissionHash
  ) {
    throw new Error("REVIEW_FLOW_SUBMISSION_FORBIDDEN");
  }
  submission.consumed = true;
  return submission.review;
}

interface RoleSpec<TPayload> {
  readonly role: ReviewFlowRole;
  readonly schema: z.ZodType<TPayload>;
  readonly inputHash: string;
  readonly run: () => Promise<unknown>;
  postValidate?(artifact: EvidenceArtifact<TPayload>): void;
}

interface ReviewFlowRunBinding {
  readonly problemContentHash: string;
  readonly sourceSnapshotHash: string;
  readonly runContextHash: string | null;
  readonly safeBinding: ReviewFlowSafeRunBinding;
}

interface ReviewFlowRunTracker {
  sourceSnapshotHash: string | null;
  runBinding: ReviewFlowSafeRunBinding | null;
  readonly completions: Map<ReviewFlowRole, ReviewFlowRoleCompletionSummary>;
  readonly failures: Map<ReviewFlowRole, ReviewFlowRoleFailureSummary>;
}

function createReviewFlowRunTracker(): ReviewFlowRunTracker {
  return {
    sourceSnapshotHash: null,
    runBinding: null,
    completions: new Map(),
    failures: new Map()
  };
}

interface ResolvedReviewFlowRunner {
  readonly roles: ReviewFlowRoles;
  readonly identities: Readonly<Record<ReviewFlowRole, RoleIdentity>>;
  readonly trustedRunner: ReviewFlowLlmBundle | null;
}

export type ReviewFlowInput =
  | {
      readonly source: unknown;
      readonly identities: Readonly<Record<ReviewFlowRole, RoleIdentity>>;
      readonly roles: ReviewFlowRoles;
      readonly trustedRunner?: never;
      readonly executionContext?: never;
    }
  | {
      readonly taskSource: unknown;
      readonly trustedRunner: unknown;
      readonly executionContext: unknown;
      readonly requestStartGate?: unknown;
      readonly source?: never;
      readonly identities?: never;
      readonly roles?: never;
    };

export async function runReviewEvidenceFlow(
  input: ReviewFlowInput
): Promise<ReviewFlowDecision> {
  return runReviewEvidenceFlowTracked(input, createReviewFlowRunTracker());
}

/**
 * 生产与标定入口：任何失败都返回显式 incomplete，且只包含安全计数与协议
 * 状态。调用方不能把异常、取消、499、缺失角色或部分成功误记成完整样本。
 */
export async function runReviewEvidenceFlowOutcome(
  input: ReviewFlowInput
): Promise<ReviewFlowOutcome> {
  const tracker = createReviewFlowRunTracker();
  try {
    const decision = await runReviewEvidenceFlowTracked(input, tracker);
    return deepFreeze({ status: "complete" as const, decision });
  } catch (error) {
    const normalizedError = normalizeReviewFlowOutcomeError(error);
    const failureBase = {
      schemaVersion: 1 as const,
      code: normalizedError.code,
      failureKind: normalizedError.failureKind,
      sourceSnapshotHash: tracker.sourceSnapshotHash,
      runBinding: tracker.runBinding,
      failedRoles: orderedRoleValues(tracker.failures).map(
        normalizeReviewFlowRoleFailureSummary
      ),
      completedRoles: orderedRoleValues(tracker.completions)
    };
    const failure: ReviewFlowIncompleteFailure = deepFreeze({
      ...failureBase,
      failureId: hashCanonicalValue(failureBase)
    });
    return deepFreeze({ status: "incomplete" as const, failure });
  }
}

/**
 * 运行与正式审题完全相同的 11 角色编排，但只为离线准确性标定返回窄投影。
 *
 * 生产合格 bundle 在发出任何请求前就被拒绝；完整结果不暴露 decision，也会
 * 主动销毁本次运行的私有提交引用，因此这个入口不能成为生产提交旁路。
 * 底层 incomplete 已经是封闭安全摘要，这里保持同一对象原样返回。
 */
export async function runReviewEvidenceFlowCalibrationOutcome(
  input: ReviewFlowCalibrationInput
): Promise<ReviewFlowCalibrationOutcome> {
  if (
    !isBuiltReviewFlowTaskSourceResult(input.taskSource) ||
    !isTrustedReviewFlowLlmBundle(input.trustedRunner) ||
    isProductionEligibleReviewFlowLlmBundle(input.trustedRunner) ||
    !isLlmRequestStartGate(input.requestStartGate)
  ) {
    throw new Error("REVIEW_FLOW_CALIBRATION_INPUT_FORBIDDEN");
  }

  const outcome = await withLlmRequestStartGate(
    input.requestStartGate,
    () => runReviewEvidenceFlowOutcome(input)
  );
  if (outcome.status === "incomplete") return outcome;

  const { decision } = outcome;
  const artifacts = privateArtifacts.get(decision);
  const submission = privateSubmissions.get(decision);
  try {
    if (
      artifacts === undefined ||
      submission === undefined ||
      decision.executionEligible ||
      isProductionEligibleReviewFlowLlmBundle(input.trustedRunner)
    ) {
      throw new Error("REVIEW_FLOW_CALIBRATION_INPUT_FORBIDDEN");
    }

    const review = submission.review;
    const editorial = artifacts.editorial.payload;
    const contestFit = artifacts.contestFit.payload;
    const originality = artifacts.originality.payload;
    const projection = reviewFlowCalibrationProjectionSchema.parse({
      schemaVersion: 2,
      verdict: review.verdict,
      codeforcesDifficulty: review.codeforcesDifficulty,
      qualityLevel: review.qualityLevel,
      originalityLevel: originality.originalityLevel,
      thinkingLevel: review.thinkingLevel,
      codingLevel: review.codingLevel,
      tagIds: review.tagIds,
      hardBlockers: decision.hardBlockers,
      difficultyConfidence: artifacts.difficulty.payload.confidence,
      technical: {
        officialSolutionCorrect:
          artifacts.solutionAnalyst.payload.officialSolutionCorrect,
        statementSolutionConsistency:
          artifacts.technicalAudit.payload.statementSolutionConsistency,
        judgeability: artifacts.technicalAudit.payload.judgeability,
        sampleConsistency: artifacts.technicalAudit.payload.sampleConsistency,
        constraintSufficiency:
          artifacts.technicalAudit.payload.constraintSufficiency,
        referenceImplementation: {
          provided:
            artifacts.technicalAudit.payload.referenceImplementation.provided,
          status: artifacts.technicalAudit.payload.referenceImplementation.status,
          complexityAcceptable:
            artifacts.technicalAudit.payload.referenceImplementation
              .complexityAcceptable
        }
      },
      editorial: {
        qualityLevel: editorial.qualityLevel,
        noveltyLevel: editorial.noveltyLevel,
        ideaDepthLevel: editorial.ideaDepthLevel,
        naturalnessLevel: editorial.naturalnessLevel,
        contestantExperienceLevel: editorial.contestantExperienceLevel,
        evidenceCoverage: editorial.evidenceCoverage,
        evidence: editorial.evidence.map((item) => ({
          dimension: item.dimension,
          direction: item.direction,
          severity: item.severity,
          confidence: item.confidence
        }))
      },
      contestFit: {
        icpcFit: contestFit.icpcFit,
        implementationBurden: contestFit.implementationBurden,
        thinkingImplementationBalance: contestFit.thinkingImplementationBalance,
        knowledgeFairness: contestFit.knowledgeFairness,
        problemsetRole: contestFit.problemsetRole,
        roleConfidence: contestFit.roleConfidence,
        evidenceCoverage: contestFit.evidenceCoverage,
        evidence: contestFit.evidence.map((item) => ({
          dimension: item.dimension,
          direction: item.direction,
          severity: item.severity,
          confidence: item.confidence
        }))
      },
      originality: {
        originalityLevel: originality.originalityLevel,
        sameProblemAsExisting: originality.sameProblemAsExisting,
        highestSimilarity: originality.highestSimilarity
      },
      roleReceipts: decision.roleCompletions.map((completion) => ({
        role: completion.role,
        receiptHash: completion.receiptHash,
        requestCount: completion.requestCount,
        transportAttemptCount: completion.transportAttemptCount,
        responses: completion.responses
      })),
      receiptSetHash: hashCanonicalValue(
        decision.roleCompletions.map((completion) => ({
          role: completion.role,
          receiptHash: completion.receiptHash,
          requestCount: completion.requestCount,
          transportAttemptCount: completion.transportAttemptCount,
          responses: completion.responses
        }))
      )
    });
    return deepFreeze({ status: "complete" as const, projection });
  } catch {
    throw new Error("REVIEW_FLOW_CALIBRATION_INPUT_FORBIDDEN");
  } finally {
    privateArtifacts.delete(decision);
    privateSubmissions.delete(decision);
  }
}

async function runReviewEvidenceFlowTracked(
  input: ReviewFlowInput,
  tracker: ReviewFlowRunTracker
): Promise<ReviewFlowDecision> {
  const taskSource = resolveBuiltTaskSource(input);
  const source = (() => {
    try {
      return freezeReviewFlowSource(
        taskSource === null
          ? ("source" in input ? input.source : undefined)
          : taskSource.source
      );
    } catch {
      throw new ReviewFlowError("REVIEW_FLOW_SOURCE_INVALID", null, "input_invalid");
    }
  })();
  const resolvedRunner = resolveRunner(input);
  const { roles, identities } = resolvedRunner;
  const requestStartGate = resolveRequestStartGate(input, resolvedRunner);
  const sourceSnapshotHash = hashCanonicalValue(taskSource ?? source);
  tracker.sourceSnapshotHash = sourceSnapshotHash;
  const executionContext = parseExecutionContext(
    input.executionContext,
    source.expectedRound,
    resolvedRunner.trustedRunner,
    taskSource
  );
  const runContextHash = executionContext === null
    ? null
    : hashCanonicalValue(executionContext);
  const safeBinding: ReviewFlowSafeRunBinding = deepFreeze({
    schemaVersion: 1,
    problemContentHash: source.problemContentHash,
    problemId: taskSource?.taskBinding.problemId ?? null,
    problemRevision: source.problemRevision,
    expectedRound: source.expectedRound,
    tagCatalogVersion: source.tagCatalogVersion,
    taskProvenanceHash: taskSource === null
      ? null
      : hashCanonicalValue(taskSource.provenance),
    anklangEvidenceExpiresAt:
      taskSource?.provenance.anklang.reviewItemExpiresAt ?? null,
    engineBuildFingerprint: resolvedRunner.trustedRunner?.engineBuildFingerprint ?? null,
    accuracyEvidenceFingerprint:
      resolvedRunner.trustedRunner?.accuracyEvidenceFingerprint ?? null,
    runId: executionContext?.runId ?? null,
    assignmentId: executionContext?.assignmentId ?? null,
    runnerIdentity: executionContext?.runnerIdentity ?? null
  });
  tracker.runBinding = safeBinding;
  const binding: ReviewFlowRunBinding = {
    problemContentHash: source.problemContentHash,
    sourceSnapshotHash,
    runContextHash,
    safeBinding
  };
  assertAllRoleIdentities(identities);
  const statement = buildStatementOnlyView(source);

  // 题解在 solver artifact 已经 strict 校验、哈希并递归冻结后才进入任何视图。
  const solver = await runAndSeal({
    binding,
    tracker,
    identities,
    requestStartGate,
    spec: {
      role: "solver",
      schema: solverPayloadSchema,
      inputHash: hashCanonicalValue(statement),
      run: () => roles.solver(statement)
    }
  });
  const solutionAnalystView = buildSolutionAnalystView(source, statement, solver);
  const solutionAnalyst = await runAndSeal({
    binding,
    tracker,
    identities,
    requestStartGate,
    spec: {
      role: "solution_analyst",
      schema: solutionAnalystPayloadSchema,
      inputHash: hashCanonicalValue(solutionAnalystView),
      run: () => roles.solutionAnalyst(solutionAnalystView)
    }
  });
  const technicalAuditorView = buildTechnicalAuditorView({
    source,
    statement,
    solver,
    solutionAnalyst
  });
  const technicalAudit = await runAndSeal({
    binding,
    tracker,
    identities,
    requestStartGate,
    spec: {
      role: "technical_auditor",
      schema: technicalAuditPayloadSchema,
      inputHash: hashCanonicalValue(technicalAuditorView),
      run: () => roles.technicalAuditor(technicalAuditorView),
      postValidate: (artifact) => assertTechnicalAuditReference(
        source.referenceImplementation !== null,
        source.samples.length,
        artifact.payload
      )
    }
  });

  const difficultyView = buildDifficultyView({
    statement,
    solver,
    solutionAnalyst,
    technicalAudit
  });
  const editorialView = buildEditorialJudgeView({
    source,
    statement,
    solver,
    solutionAnalyst,
    technicalAudit
  });
  const contestFitView = buildContestFitView({
    source,
    statement,
    solver,
    solutionAnalyst,
    technicalAudit
  });
  const originalityView = buildOriginalityView(source, statement);
  const tagsView = buildTagsView(source, statement);

  // 品味、ICPC 适配、难度、原创性和标签相互隔离；任一失败时仍等待
  // 其它在途请求收束，避免把某一角色的先验判断泄漏给另一角色。
  const [difficulty, editorial, contestFit, originality, tags] = await runIndependentRoles({
    binding,
    tracker,
    identities,
    requestStartGate,
    specs: [
      {
        role: "difficulty",
        schema: difficultyPayloadSchema,
        inputHash: hashCanonicalValue(difficultyView),
        run: () => roles.difficulty(difficultyView)
      },
      {
        role: "editorial_judge",
        schema: editorialPayloadSchema,
        inputHash: hashCanonicalValue(editorialView),
        run: () => roles.editorialJudge(editorialView)
      },
      {
        role: "contest_fit",
        schema: contestFitPayloadSchema,
        inputHash: hashCanonicalValue(contestFitView),
        run: () => roles.contestFit(contestFitView)
      },
      {
        role: "originality",
        schema: originalityPayloadSchema,
        inputHash: hashCanonicalValue(originalityView),
        run: () => roles.originality(originalityView),
        postValidate: (artifact: EvidenceArtifact<OriginalityPayload>) => assertOriginalityEvidence(
          source.duplicateEvidence,
          artifact.payload
        )
      },
      {
        role: "tags",
        schema: tagsPayloadSchema,
        inputHash: hashCanonicalValue(tagsView),
        run: () => roles.tags(tagsView),
        postValidate: (artifact: EvidenceArtifact<TagsPayload>) => assertTagSelection(
          source.tagCatalog,
          artifact.payload
        )
      }
    ] as const
  });
  const coreEvidence: EvidenceArtifact<unknown>[] = [
    solver,
    solutionAnalyst,
    technicalAudit,
    difficulty,
    editorial,
    contestFit,
    originality,
    tags
  ];
  const criticView = buildCriticView(source.problemContentHash, coreEvidence);
  const adversaryView = buildAdversaryView(criticView);
  const [critic, adversary] = await runIndependentRoles({
    binding,
    tracker,
    identities,
    requestStartGate,
    specs: [
      {
        role: "critic",
        schema: criticPayloadSchema,
        inputHash: hashCanonicalValue(criticView),
        run: () => roles.critic(criticView),
        postValidate: (artifact: EvidenceArtifact<CriticPayload>) => assertCriticReferences(
          coreEvidence,
          artifact.payload
        )
      },
      {
        role: "adversary",
        schema: adversaryPayloadSchema,
        inputHash: hashCanonicalValue(adversaryView),
        run: () => roles.adversary(adversaryView),
        postValidate: (artifact: EvidenceArtifact<AdversaryPayload>) => assertAdversaryReferences(
          coreEvidence,
          artifact.payload
        )
      }
    ] as const
  });
  const preAdjudicationEvidence: EvidenceArtifact<unknown>[] = [
    ...coreEvidence,
    critic,
    adversary
  ];
  const hardBlockers = collectHardBlockers({
    solutionAnalyst: solutionAnalyst.payload,
    technicalAudit: technicalAudit.payload,
    originality: originality.payload,
    duplicateEvidence: source.duplicateEvidence,
    duplicateSimilarityRejectThreshold: source.duplicateSimilarityRejectThreshold
  });
  let review: ReviewInput | null = null;
  const adjudicatorView = buildAdjudicatorView(criticView, critic, adversary);
  const adjudicator = await runAndSeal({
    binding,
    tracker,
    identities,
    requestStartGate,
    spec: {
      role: "adjudicator",
      schema: adjudicatorPayloadSchema,
      inputHash: hashCanonicalValue(adjudicatorView),
      run: () => roles.adjudicator(adjudicatorView),
      postValidate: (artifact) => {
        assertAdjudicatorReferences(preAdjudicationEvidence, artifact.payload);
        const verdict = applyDeterministicPolicy(artifact.payload.verdict, hardBlockers);
        const improvements = hardBlockers.length === 0
          ? artifact.payload.improvements
          : `存在尚未解决的硬性审题证据（${hardBlockers.map(blockerLabel).join("、")}）。` +
            artifact.payload.improvements;
        try {
          review = deepFreeze(reviewInputSchema.parse({
            verdict,
            codeforcesDifficulty: difficulty.payload.codeforcesDifficulty,
            qualityLevel: artifact.payload.qualityLevel,
            originalityLevel: originality.payload.originalityLevel,
            thinkingLevel: difficulty.payload.thinkingLevel,
            codingLevel: difficulty.payload.codingLevel,
            tagIds: tags.payload.tagIds,
            improvements,
            publicComment: artifact.payload.publicComment,
            privateNote: artifact.payload.privateNote,
            expectedRound: source.expectedRound
          }));
        } catch {
          throw new ReviewFlowError(
            "REVIEW_FLOW_SUBMISSION_INVALID",
            "adjudicator",
            "validation"
          );
        }
      }
    }
  });
  if (review === null) {
    throw new ReviewFlowError(
      "REVIEW_FLOW_SUBMISSION_NOT_CREATED",
      "adjudicator",
      "role_internal"
    );
  }
  const artifacts: ReviewFlowArtifacts = {
    solver,
    solutionAnalyst,
    technicalAudit,
    difficulty,
    editorial,
    contestFit,
    originality,
    tags,
    critic,
    adversary,
    adjudicator
  };
  const evidenceIds = Object.values(artifacts).map((artifact) => artifact.evidenceId);
  const roleCompletions = orderedRoleValues(tracker.completions);
  const policyHash = hashCanonicalValue({
    policyVersion: "historical-rubric-policy-v3",
    reviewFlowRuntimeImplementationVersion,
    llmTransportProtocolVersion,
    evidenceSchemaVersion: 2,
    roleReceiptSchemaVersion: 2,
    roleIdentities: identities,
    historicalReviewRubricDigest,
    historicalReviewRubricPromptDigest,
    duplicateSimilarityRejectThreshold: source.duplicateSimilarityRejectThreshold
  });
  const decisionBase = {
    submissionHash: hashCanonicalValue(review),
    tagCatalogVersion: source.tagCatalogVersion,
    duplicateSimilarityRejectThreshold: source.duplicateSimilarityRejectThreshold,
    policyHash,
    sourceSnapshotHash,
    runContextHash,
    runBinding: safeBinding,
    executionTransportMode: resolvedRunner.trustedRunner?.transportMode ?? null,
    executionEligible:
      executionContext !== null &&
      isProductionEligibleReviewFlowLlmBundle(resolvedRunner.trustedRunner),
    accuracyEvidenceFingerprint:
      resolvedRunner.trustedRunner?.accuracyEvidenceFingerprint ?? null,
    hardBlockers,
    evidenceIds,
    roleCompletions
  };
  const decision: ReviewFlowDecision = deepFreeze({
    ...decisionBase,
    decisionId: hashCanonicalValue({
      decisionVersion: 1,
      policyHash,
      sourceSnapshotHash,
      runBinding: safeBinding,
      submissionHash: hashCanonicalValue(review),
      evidenceIds,
      roleCompletions,
      tagCatalogVersion: source.tagCatalogVersion
    })
  });
  privateArtifacts.set(decision, artifacts);
  privateSubmissions.set(decision, { review, taskSource, consumed: false });
  return decision;
}

async function runAndSeal<TPayload>(input: {
  readonly binding: ReviewFlowRunBinding;
  readonly tracker: ReviewFlowRunTracker;
  readonly identities: Readonly<Record<ReviewFlowRole, RoleIdentity>>;
  readonly requestStartGate: LlmRequestStartGate | null;
  readonly spec: RoleSpec<TPayload>;
}): Promise<EvidenceArtifact<TPayload>> {
  let completedReceipt: RoleCompletionReceipt | null = null;
  try {
    if (input.requestStartGate !== null && !input.requestStartGate.canStartRequest()) {
      throw new LlmRequestError("LLM_REQUEST_START_BLOCKED");
    }
    const rawResult = await input.spec.run();
    const trustedResult = input.binding.runContextHash === null
      ? null
      : trustedRoleExecutionResultSchema.parse(rawResult);
    const execution: EvidenceExecutionBinding = input.binding.runContextHash === null
      ? {
          trust: "untrusted_local",
          runContextHash: null,
          completionReceipt: null
        }
      : (() => {
          return {
            trust: "trusted_llm" as const,
            runContextHash: input.binding.runContextHash,
            completionReceipt: trustedResult!.receipt
          };
        })();
    const payload = input.binding.runContextHash === null
      ? rawResult
      : trustedResult!.payload;
    completedReceipt = trustedResult?.receipt ?? null;
    const artifact = sealEvidenceArtifact({
      role: input.spec.role,
      problemContentHash: input.binding.problemContentHash,
      inputHash: input.spec.inputHash,
      sourceSnapshotHash: input.binding.sourceSnapshotHash,
      execution,
      identity: input.identities[input.spec.role],
      payloadSchema: input.spec.schema,
      payload
    });
    input.spec.postValidate?.(artifact);
    const receipt = completedReceipt;
    input.tracker.completions.set(input.spec.role, deepFreeze({
      role: input.spec.role,
      evidenceId: artifact.evidenceId,
      receiptHash: receipt === null ? null : hashCanonicalValue(receipt),
      requestCount: receipt?.requestCount ?? 0,
      transportAttemptCount: receipt?.transportAttemptCount ?? 0,
      responseModes: receipt?.responses.map((response) => response.responseMode) ?? [],
      responses: receipt?.responses.map((response) => ({
        responseMode: response.responseMode,
        transportAttemptCount: response.transportAttemptCount,
        eofVerified: response.eofVerified,
        finishReasonStopVerified: response.finishReasonStopVerified,
        // roleCompletionReceiptSchema 已在进入此分支前验证 SSE=true/JSON=null；
        // 这里收窄为标定投影允许的安全字面量。
        sseDoneObserved: response.responseMode === "sse" ? true : null
      })) ?? []
    }));
    return artifact;
  } catch (error) {
    input.requestStartGate?.close();
    const failureKind = classifyRoleFailure(error);
    input.tracker.completions.delete(input.spec.role);
    const llmAudit = getLlmFailureAudit(error);
    input.tracker.failures.set(
      input.spec.role,
      llmAudit !== null
        ? summarizeRoleFailure(input.spec.role, failureKind, llmAudit)
        : summarizeCompletedReceiptFailure(
            input.spec.role,
            failureKind,
            completedReceipt
          )
    );
    if (error instanceof ReviewFlowError) throw error;
    throw new ReviewFlowError("REVIEW_FLOW_ROLE_FAILED", input.spec.role, failureKind);
  }
}

async function runIndependentRoles<
  TSpecs extends readonly RoleSpec<unknown>[]
>(input: {
  readonly binding: ReviewFlowRunBinding;
  readonly tracker: ReviewFlowRunTracker;
  readonly identities: Readonly<Record<ReviewFlowRole, RoleIdentity>>;
  readonly requestStartGate: LlmRequestStartGate | null;
  readonly specs: TSpecs;
}): Promise<{ [K in keyof TSpecs]: TSpecs[K] extends RoleSpec<infer P> ? EvidenceArtifact<P> : never }> {
  const settled = await Promise.allSettled(
    input.specs.map((spec) => runAndSeal({
      binding: input.binding,
      tracker: input.tracker,
      identities: input.identities,
      requestStartGate: input.requestStartGate,
      spec
    }))
  );
  const failedIndex = settled.findIndex((entry) => entry.status === "rejected");
  if (failedIndex >= 0) {
    const failed = settled[failedIndex] as PromiseRejectedResult;
    if (failed.reason instanceof ReviewFlowError) throw failed.reason;
    const role = input.specs[failedIndex]?.role ?? null;
    throw new ReviewFlowError("REVIEW_FLOW_ROLE_FAILED", role, "role_internal");
  }
  return settled.map((entry) =>
    (entry as PromiseFulfilledResult<EvidenceArtifact<unknown>>).value
  ) as { [K in keyof TSpecs]: TSpecs[K] extends RoleSpec<infer P> ? EvidenceArtifact<P> : never };
}

function parseExecutionContext(
  raw: unknown,
  expectedRound: number,
  trustedRunner: ReviewFlowLlmBundle | null,
  taskSource: ReviewFlowTaskSourceResult | null
): ReviewFlowExecutionContext | null {
  if (trustedRunner === null) {
    if (raw === undefined) return null;
    throw new ReviewFlowError(
      "REVIEW_FLOW_EXECUTION_CONTEXT_INVALID",
      null,
      "input_invalid"
    );
  }
  try {
    const assignment = reviewFlowAssignmentContextSchema.parse(structuredClone(raw));
    if (
      taskSource === null ||
      assignment.expectedRound !== expectedRound ||
      assignment.assignmentId !== taskSource.taskBinding.assignmentId ||
      taskSource.taskBinding.expectedRound !== expectedRound ||
      taskSource.taskBinding.problemRevision !== taskSource.source.problemRevision ||
      taskSource.taskBinding.problemContentHash !== taskSource.source.problemContentHash ||
      taskSource.taskBinding.tagCatalogVersion !== taskSource.source.tagCatalogVersion
    ) {
      throw new Error("round_mismatch");
    }
    const context = reviewFlowExecutionContextSchema.parse({
      ...assignment,
      runnerIdentity: deriveReviewFlowRuntimeIdentity(trustedRunner),
      engineBuildFingerprint: trustedRunner.engineBuildFingerprint,
      accuracyEvidenceFingerprint: trustedRunner.accuracyEvidenceFingerprint
    });
    return deepFreeze(context);
  } catch {
    throw new ReviewFlowError(
      "REVIEW_FLOW_EXECUTION_CONTEXT_INVALID",
      null,
      "input_invalid"
    );
  }
}

function resolveBuiltTaskSource(
  input: ReviewFlowInput
): ReviewFlowTaskSourceResult | null {
  if (!("taskSource" in input)) return null;
  if (!isBuiltReviewFlowTaskSourceResult(input.taskSource)) {
    throw new ReviewFlowError(
      "REVIEW_FLOW_TASK_SOURCE_UNTRUSTED",
      null,
      "input_invalid"
    );
  }
  return input.taskSource;
}

function deriveReviewFlowRuntimeIdentity(
  trustedRunner: ReviewFlowLlmBundle
): string {
  return trustedRunner.runnerIdentity;
}

function resolveRunner(input: ReviewFlowInput): ResolvedReviewFlowRunner {
  if ("trustedRunner" in input) {
    if (!isTrustedReviewFlowLlmBundle(input.trustedRunner)) {
      throw new ReviewFlowError(
        "REVIEW_FLOW_TRUSTED_RUNNER_INVALID",
        null,
        "input_invalid"
      );
    }
    return {
      roles: input.trustedRunner.roles,
      identities: input.trustedRunner.identities,
      trustedRunner: input.trustedRunner
    };
  }
  if (input.roles === undefined || input.identities === undefined) {
    throw new ReviewFlowError(
      "REVIEW_FLOW_RUNNER_INVALID",
      null,
      "input_invalid"
    );
  }
  return {
    roles: input.roles,
    identities: input.identities,
    trustedRunner: null
  };
}

function resolveRequestStartGate(
  input: ReviewFlowInput,
  runner: ResolvedReviewFlowRunner
): LlmRequestStartGate | null {
  if (!("requestStartGate" in input) || input.requestStartGate === undefined) {
    return null;
  }
  if (
    !isLlmRequestStartGate(input.requestStartGate) ||
    runner.trustedRunner === null ||
    isProductionEligibleReviewFlowLlmBundle(runner.trustedRunner)
  ) {
    throw new ReviewFlowError(
      "REVIEW_FLOW_TRUSTED_RUNNER_INVALID",
      null,
      "input_invalid"
    );
  }
  return input.requestStartGate;
}

function normalizeReviewFlowOutcomeError(error: unknown): {
  readonly code: ReviewFlowOutcomeErrorCode;
  readonly failureKind: ReviewFlowFailureKind;
} {
  try {
    const privateFields = typeof error === "object" && error !== null
      ? privateReviewFlowErrorFields.get(error)
      : undefined;
    if (
      error instanceof ReviewFlowError &&
      privateFields !== undefined &&
      error.code === privateFields.code &&
      error.failureKind === privateFields.failureKind &&
      isReviewFlowInternalErrorCode(privateFields.code) &&
      isReviewFlowFailureKind(privateFields.failureKind)
    ) {
      return {
        code: privateFields.code,
        failureKind: privateFields.failureKind
      };
    }
  } catch {
    // 运行时伪造的属性访问器也只能落入固定的安全失败分类。
  }
  return {
    code: "REVIEW_FLOW_UNEXPECTED_FAILURE",
    failureKind: "role_internal"
  };
}

function isReviewFlowInternalErrorCode(
  value: unknown
): value is ReviewFlowInternalErrorCode {
  return typeof value === "string" &&
    (reviewFlowInternalErrorCodeAllowlist as readonly string[]).includes(value);
}

function isReviewFlowFailureKind(value: unknown): value is ReviewFlowFailureKind {
  return typeof value === "string" &&
    (reviewFlowFailureKindAllowlist as readonly string[]).includes(value);
}

function normalizeReviewFlowRoleFailureSummary(
  summary: ReviewFlowRoleFailureSummary
): ReviewFlowRoleFailureSummary {
  let failureKind: ReviewFlowFailureKind = "role_internal";
  try {
    if (isReviewFlowFailureKind(summary.failureKind)) {
      failureKind = summary.failureKind;
    }
  } catch {
    // 只保留固定枚举，绝不序列化运行时注入的任意值。
  }
  return failureKind === summary.failureKind
    ? summary
    : deepFreeze({ ...summary, failureKind });
}

function classifyRoleFailure(error: unknown): ReviewFlowFailureKind {
  if (error instanceof ReviewFlowError) {
    return normalizeReviewFlowOutcomeError(error).failureKind;
  }
  if (error instanceof z.ZodError) return "schema_output";
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
  if (code === "LLM_HTTP_ERROR") return "service_http";
  if (["LLM_NETWORK_FAILED", "LLM_STREAM_INTERRUPTED"].includes(String(code))) {
    return "transport";
  }
  if ([
    "LLM_FIRST_OUTPUT_TIMEOUT",
    "LLM_OUTPUT_IDLE_TIMEOUT",
    "LLM_TOTAL_TIMEOUT"
  ].includes(String(code))) {
    return "timeout";
  }
  if (["LLM_CANCELLED", "LLM_REQUEST_START_BLOCKED"].includes(String(code))) {
    return "cancelled";
  }
  if (["LLM_OUTPUT_LENGTH_LIMIT", "LLM_RESPONSE_BODY_TOO_LARGE"].includes(String(code))) {
    return "output_limit";
  }
  if (code === "LLM_OUTPUT_CONTENT_FILTERED") return "content_filtered";
  if (code === "LLM_RESPONSE_FORMAT_INVALID") return "protocol";
  if (code === "LLM_JSON_OUTPUT_INVALID") return "schema_output";
  if (
    error instanceof Error &&
    error.message === "REVIEW_FLOW_PROMPT_CONTEXT_TOO_LARGE"
  ) {
    return "output_limit";
  }
  return "role_internal";
}

function summarizeCompletedReceiptFailure(
  role: ReviewFlowRole,
  failureKind: ReviewFlowFailureKind,
  receipt: RoleCompletionReceipt | null
): ReviewFlowRoleFailureSummary {
  const terminal = receipt?.responses.at(-1);
  return deepFreeze({
    role,
    failureKind,
    httpStatus: null,
    requestCount: receipt?.requestCount ?? 0,
    transportAttemptCount: receipt?.transportAttemptCount ?? 0,
    completedResponseCount: receipt?.responses.length ?? 0,
    terminalResponseMode: terminal?.responseMode ?? null,
    terminalEofObserved: terminal?.eofVerified ?? false,
    terminalFinishReasonStopObserved: terminal?.finishReasonStopVerified ?? false,
    terminalSseDoneObserved: terminal?.sseDoneObserved ?? null
  });
}

function summarizeRoleFailure(
  role: ReviewFlowRole,
  failureKind: ReviewFlowFailureKind,
  audit: LlmFailureAudit | null
): ReviewFlowRoleFailureSummary {
  return deepFreeze({
    role,
    failureKind,
    httpStatus: audit?.terminal.status ?? null,
    requestCount: audit?.requestCount ?? 0,
    transportAttemptCount: audit?.transportAttemptCount ?? 0,
    completedResponseCount: audit?.completedResponses.length ?? 0,
    terminalResponseMode: audit?.terminal.responseMode ?? null,
    terminalEofObserved: audit?.terminal.eofObserved ?? false,
    terminalFinishReasonStopObserved:
      audit?.terminal.finishReasonStopObserved ?? false,
    terminalSseDoneObserved: audit?.terminal.sseDoneObserved ?? null
  });
}

function orderedRoleValues<T>(map: ReadonlyMap<ReviewFlowRole, T>): T[] {
  return reviewFlowRoleSchema.options.flatMap((role) => {
    const value = map.get(role);
    return value === undefined ? [] : [value];
  });
}

function assertAllRoleIdentities(
  identities: Readonly<Record<ReviewFlowRole, RoleIdentity>>
): void {
  try {
    for (const role of reviewFlowRoleSchema.options) {
      roleIdentitySchema.parse(identities[role]);
    }
  } catch {
    throw new ReviewFlowError("REVIEW_FLOW_IDENTITY_INVALID");
  }
}

function assertTagSelection(
  catalog: readonly { readonly id: string; readonly active: true }[],
  tags: TagsPayload
): void {
  const activeIds = new Set(catalog.map((tag) => tag.id));
  if (tags.tagIds.some((tagId) => !activeIds.has(tagId))) {
    throw new ReviewFlowError("REVIEW_FLOW_TAG_SELECTION_INVALID", "tags");
  }
}

function assertTechnicalAuditReference(
  implementationProvided: boolean,
  publicSampleCount: number,
  audit: TechnicalAuditPayload
): void {
  const expectedSampleCount = implementationProvided ? publicSampleCount : 0;
  if (
    audit.referenceImplementation.provided !== implementationProvided ||
    audit.referenceImplementation.sampleCount !== expectedSampleCount
  ) {
    throw new ReviewFlowError("REVIEW_FLOW_REFERENCE_STATE_INVALID", "technical_auditor");
  }
}

function assertOriginalityEvidence(
  available: readonly {
    readonly evidenceId: string;
    readonly similarity: number;
    readonly sameProblemSuggestion: boolean;
  }[],
  originality: OriginalityPayload
): void {
  const byId = new Map(available.map((item) => [item.evidenceId, item]));
  const highestAvailable = available.reduce(
    (highest, item) => Math.max(highest, item.similarity),
    0
  );
  const cited = originality.evidenceIds.map((id) => byId.get(id));
  if (
    new Set(originality.evidenceIds).size !== originality.evidenceIds.length ||
    cited.some((item) => item === undefined) ||
    originality.highestSimilarity !== highestAvailable ||
    (originality.sameProblemAsExisting &&
      (cited.length === 0 || !cited.some((item) => item?.sameProblemSuggestion === true)))
  ) {
    throw new ReviewFlowError("REVIEW_FLOW_EVIDENCE_REFERENCE_INVALID", "originality");
  }
}

function assertCriticReferences(
  evidence: readonly EvidenceArtifact<unknown>[],
  critic: CriticPayload
): void {
  const ids = new Set(evidence.map((artifact) => artifact.evidenceId));
  if (
    critic.missingRoles.length > 0 ||
    critic.conflicts.some((conflict) =>
      conflict.leftEvidenceId === conflict.rightEvidenceId ||
      !ids.has(conflict.leftEvidenceId) ||
      !ids.has(conflict.rightEvidenceId)
    )
  ) {
    throw new ReviewFlowError("REVIEW_FLOW_EVIDENCE_REFERENCE_INVALID", "critic");
  }
}

function assertAdversaryReferences(
  evidence: readonly EvidenceArtifact<unknown>[],
  adversary: AdversaryPayload
): void {
  const ids = new Set(evidence.map((artifact) => artifact.evidenceId));
  if (adversary.counterexamples.some((counterexample) => !ids.has(counterexample.targetEvidenceId))) {
    throw new ReviewFlowError("REVIEW_FLOW_EVIDENCE_REFERENCE_INVALID", "adversary");
  }
}

function assertAdjudicatorReferences(
  evidence: readonly EvidenceArtifact<unknown>[],
  adjudicator: AdjudicatorPayload
): void {
  const ids = new Set(evidence.map((artifact) => artifact.evidenceId));
  if (
    new Set(adjudicator.citedEvidenceIds).size !== adjudicator.citedEvidenceIds.length ||
    adjudicator.citedEvidenceIds.some((id) => !ids.has(id))
  ) {
    throw new ReviewFlowError("REVIEW_FLOW_EVIDENCE_REFERENCE_INVALID", "adjudicator");
  }
}

function collectHardBlockers(input: {
  readonly solutionAnalyst: SolutionAnalystPayload;
  readonly technicalAudit: TechnicalAuditPayload;
  readonly originality: OriginalityPayload;
  readonly duplicateEvidence: readonly {
    readonly evidenceId: string;
    readonly similarity: number;
    readonly sameProblemSuggestion: boolean;
  }[];
  readonly duplicateSimilarityRejectThreshold: number;
}): HardBlockerCode[] {
  const blockers: HardBlockerCode[] = [];
  // 单个分析角色的怀疑只是可供裁决的 evidence，不能自动升格为硬阻断。
  // 只有独立技术核验也确认题面—题解存在问题时才做确定性保守处理。
  if (
    !input.solutionAnalyst.officialSolutionCorrect &&
    input.technicalAudit.statementSolutionConsistency === "concern"
  ) {
    blockers.push("SOLUTION_INCORRECT");
  }
  // 题面和题解是正式审核的核心材料。没有另附标程、或未执行可选标程，
  // 都不能自动判为材料缺失；只有已经确认所附实现错误才形成阻塞项。
  if (input.technicalAudit.referenceImplementation.status === "invalid") {
    blockers.push("REFERENCE_IMPLEMENTATION_INCORRECT");
  }
  const evidenceById = new Map(
    input.duplicateEvidence.map((evidence) => [evidence.evidenceId, evidence] as const)
  );
  const confirmedDuplicate = input.originality.sameProblemAsExisting &&
    input.originality.evidenceIds.some((evidenceId) => {
      const evidence = evidenceById.get(evidenceId);
      return evidence?.sameProblemSuggestion === true &&
        evidence.similarity > input.duplicateSimilarityRejectThreshold;
    });
  if (confirmedDuplicate) {
    blockers.push("CONFIRMED_DUPLICATE");
  }
  return [...new Set(blockers)].map((blocker) => hardBlockerCodeSchema.parse(blocker));
}

function applyDeterministicPolicy(
  proposed: AdjudicatorPayload["verdict"],
  blockers: readonly HardBlockerCode[]
): AdjudicatorPayload["verdict"] {
  // 只有确认原题能由确定性规则直接拒绝。题解、样例、复杂度或可选标程
  // 问题可能可以修改，因此只禁止直接 approve；退修或否决仍由综合审核
  // 根据题目价值、比赛适配和可修复性决定。
  if (blockers.includes("CONFIRMED_DUPLICATE")) return "reject";
  if (blockers.length > 0 && proposed === "approve") return "request_changes";
  return proposed;
}

function blockerLabel(blocker: HardBlockerCode): string {
  const labels: Readonly<Record<HardBlockerCode, string>> = {
    SOLUTION_INCORRECT: "题解正确性",
    REFERENCE_IMPLEMENTATION_INCORRECT: "参考实现不正确",
    SAMPLE_MISMATCH: "样例不一致",
    COMPLEXITY_UNACCEPTABLE: "复杂度不符合约束",
    CONFIRMED_DUPLICATE: "确认重复题",
    EVIDENCE_MISSING: "必要证据缺失",
    UNRESOLVED_CONFLICT: "证据冲突未解决"
  };
  return labels[blocker];
}
