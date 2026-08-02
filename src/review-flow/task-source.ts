import { z } from "zod";
import {
  robotAnklangPluginId,
  robotReviewTaskSchema,
  type RobotReviewTask
} from "../urmotiv-schemas";
import { deepFreeze, hashCanonicalValue } from "./evidence";
import {
  digestSchema,
  reviewFlowSourceSchema,
  type ReviewFlowSource
} from "./schemas";

/**
 * Anklang data schema mirrored from Urmotiv/plugins/anklang/src/index.ts on
 * 2026-08-02. Fermata is deployed independently and cannot import that package;
 * changes to the plugin v2 contract must update this strict boundary and tests.
 */
export const anklangSimilarityReviewItemType =
  "org.ustc.urmotiv.anklang.similarity" as const;

export type ReviewFlowTaskSourceErrorCode =
  | "REVIEW_FLOW_TASK_INVALID"
  | "REVIEW_FLOW_TASK_MATERIAL_INCOMPLETE"
  | "REVIEW_FLOW_TASK_TAG_CATALOG_MISMATCH"
  | "REVIEW_FLOW_TASK_ANKLANG_ITEM_MISSING"
  | "REVIEW_FLOW_TASK_ANKLANG_ITEM_AMBIGUOUS"
  | "REVIEW_FLOW_TASK_ANKLANG_SOURCE_UNTRUSTED"
  | "REVIEW_FLOW_TASK_ANKLANG_ITEM_EXPIRED"
  | "REVIEW_FLOW_TASK_ANKLANG_EXPIRY_MISMATCH"
  | "REVIEW_FLOW_TASK_ANKLANG_VERSION_UNSUPPORTED"
  | "REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID"
  | "REVIEW_FLOW_TASK_ANKLANG_RESULT_INCOMPLETE"
  | "REVIEW_FLOW_TASK_ANKLANG_CONTENT_HASH_MISMATCH"
  | "REVIEW_FLOW_TASK_SOURCE_INVALID";

/** 固定错误码不携带题面、题解、候选详情或 zod 的原始校验输入。 */
export class ReviewFlowTaskSourceError extends Error {
  public readonly code: ReviewFlowTaskSourceErrorCode;

  public constructor(code: ReviewFlowTaskSourceErrorCode) {
    super(code);
    this.name = "ReviewFlowTaskSourceError";
    this.code = code;
  }
}

const utcDateTimeSchema = z
  .string()
  .datetime({ offset: false })
  .refine((value) => value.endsWith("Z"), "时间必须是 UTC。");

const boundedCanonicalText = (maximum: number): z.ZodType<string> =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value === value.trim(), "文本两端不能有空白字符。");

/**
 * Anklang v2 原始请求边界。桥接器用它核对采集时真正发送的正文，而不是
 * 只相信响应里的 contentHash。字段集合与 Urmotiv 内置插件保持严格一致。
 */
export const anklangV2RequestSchema = z
  .object({
    apiVersion: z.literal("2"),
    requestId: z.string().uuid(),
    contentHash: digestSchema,
    problem: z
      .object({
        title: boundedCanonicalText(200),
        type: z.enum(["traditional", "interactive", "submit_answer"]),
        tagIds: z.array(z.string().min(1).max(120)).min(1).max(30),
        basicStatement: z.string().min(1).max(500_000)
      })
      .strict()
  })
  .strict();
export type AnklangV2Request = z.infer<typeof anklangV2RequestSchema>;

const safeCandidateUrlSchema = z
  .string()
  .url()
  .max(2_000)
  .refine((value) => {
    if (value !== value.trim() || /[\\\s\u0000-\u001f]/u.test(value)) return false;
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.username.length === 0 &&
        url.password.length === 0
      );
    } catch {
      return false;
    }
  }, "候选地址必须是不含认证信息的 HTTP(S) URL。");

const anklangCandidateSchema = z
  .object({
    source: boundedCanonicalText(80),
    externalId: boundedCanonicalText(200),
    title: boundedCanonicalText(200),
    url: safeCandidateUrlSchema.optional(),
    similarity: z.number().finite().min(0).max(1),
    sameProblemSuggestion: z.boolean().optional(),
    explanation: boundedCanonicalText(2_000).optional()
  })
  .strict();

const recommendationSchema = z
  .object({
    blockSubmission: z.boolean(),
    message: boundedCanonicalText(2_000)
  })
  .strict();

const noncompleteReasonCodeSchema = z.enum([
  "search_timeout",
  "search_rate_limited",
  "search_backend_unavailable",
  "search_backend_invalid",
  "search_partial",
  "review_unavailable",
  "service_unavailable",
  "service_invalid_response",
  "internal_error"
]);

const completeCompletionSchema = z
  .object({
    status: z.literal("complete"),
    reasonCode: z.literal("complete"),
    retryable: z.literal(false)
  })
  .strict();

function noncompleteCompletionSchema<TStatus extends "partial" | "unavailable">(
  status: TStatus
) {
  return z
    .object({
      status: z.literal(status),
      reasonCode: noncompleteReasonCodeSchema,
      retryable: z.boolean(),
      retryAfterSeconds: z.number().int().min(1).max(86_400).optional()
    })
    .strict()
    .superRefine((completion, context) => {
      if (completion.retryAfterSeconds !== undefined && !completion.retryable) {
        context.addIssue({
          code: "custom",
          path: ["retryAfterSeconds"],
          message: "不可重试结果不能带重试时间。"
        });
      }
    });
}

const noStoreReuseSchema = z.object({ policy: z.literal("no-store") }).strict();
const maximumReuseMs = 7 * 24 * 60 * 60_000;
const allowedReuseSchema = z
  .object({
    policy: z.literal("allowed"),
    expiresAt: utcDateTimeSchema
  })
  .strict();

const anklangV2Common = {
  apiVersion: z.literal("2"),
  contentHash: digestSchema,
  checkedAt: utcDateTimeSchema,
  candidates: z.array(anklangCandidateSchema).max(50),
  recommendation: recommendationSchema
} as const;

export const completeAnklangV2ResultSchema = z
  .object({
    ...anklangV2Common,
    completion: completeCompletionSchema,
    reuse: z.union([allowedReuseSchema, noStoreReuseSchema])
  })
  .strict()
  .superRefine((result, context) => {
    if (result.reuse.policy !== "allowed") return;
    const checkedAtMs = Date.parse(result.checkedAt);
    const expiresAtMs = Date.parse(result.reuse.expiresAt);
    if (expiresAtMs <= checkedAtMs || expiresAtMs - checkedAtMs > maximumReuseMs) {
      context.addIssue({
        code: "custom",
        path: ["reuse", "expiresAt"],
        message: "复用期限无效。"
      });
    }
  });
export type CompleteAnklangV2Result = z.infer<
  typeof completeAnklangV2ResultSchema
>;

const partialAnklangV2ResultSchema = z
  .object({
    ...anklangV2Common,
    completion: noncompleteCompletionSchema("partial"),
    reuse: noStoreReuseSchema
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.recommendation.blockSubmission &&
      !result.candidates.some((candidate) => candidate.sameProblemSuggestion === true)
    ) {
      context.addIssue({
        code: "custom",
        path: ["recommendation", "blockSubmission"],
        message: "部分结果缺少同题建议。"
      });
    }
  });

const unavailableAnklangV2ResultSchema = z
  .object({
    ...anklangV2Common,
    completion: noncompleteCompletionSchema("unavailable"),
    candidates: z.array(anklangCandidateSchema).length(0),
    recommendation: z
      .object({
        blockSubmission: z.literal(false),
        message: boundedCanonicalText(2_000)
      })
      .strict(),
    reuse: noStoreReuseSchema
  })
  .strict();

const anklangV2ResultSchema = z.union([
  completeAnklangV2ResultSchema,
  partialAnklangV2ResultSchema,
  unavailableAnklangV2ResultSchema
]);

const safeEvidenceIdSchema = z.string().regex(/^anklang-[0-9a-f]{32}$/u);
const taskBindingSchema = z
  .object({
    assignmentId: z.string().uuid(),
    leaseExpiresAt: z.string().datetime(),
    problemId: z.string().min(1).max(200),
    problemRevision: z.number().int().positive(),
    expectedRound: z.number().int().positive(),
    problemContentHash: digestSchema,
    tagCatalogVersion: z.number().int().positive(),
    currentTagIds: z.array(z.string().min(1).max(120)).min(1).max(30)
  })
  .strict();

const anklangEvidenceProvenanceSchema = z
  .object({
    evidenceId: safeEvidenceIdSchema,
    source: boundedCanonicalText(80),
    externalId: boundedCanonicalText(200),
    candidateIndex: z.number().int().nonnegative().max(49),
    similarity: z.number().finite().min(0).max(1),
    serviceReviewSuggestion: z.boolean().optional(),
    authenticationStatus: z.literal("authenticated_builtin_anklang_plugin"),
    deterministicConfirmationAllowed: z.literal(true)
  })
  .strict();

const taskSourceProvenanceSchema = z
  .object({
    anklang: z
      .object({
        reviewItemType: z.literal(anklangSimilarityReviewItemType),
        reviewItemId: z.string().min(1).max(200),
        reviewItemCreatedAt: z.string().datetime(),
        reviewItemSource: z.literal("anklang"),
        sourcePluginId: z.literal(robotAnklangPluginId),
        reviewItemVisibility: z.enum(["author", "reviewer", "administrator"]),
        reviewItemExpiresAt: z.string().datetime({ offset: true }).nullable(),
        apiVersion: z.literal("2"),
        checkedAt: utcDateTimeSchema,
        completionStatus: z.literal("complete"),
        contentHash: digestSchema,
        resultHash: digestSchema,
        contentHashBinding: z.literal("matched"),
        authenticationStatus: z.literal("authenticated_builtin_anklang_plugin"),
        reportedBlockSubmission: z.boolean(),
        deterministicConfirmationAllowed: z.literal(true),
        evidence: z.array(anklangEvidenceProvenanceSchema).max(50)
      })
      .strict(),
    referenceImplementation: z
      .object({
        status: z.literal("not_provided_by_robot_task_contract")
      })
      .strict()
  })
  .strict();

const taskSourceResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskBinding: taskBindingSchema,
    source: reviewFlowSourceSchema,
    provenance: taskSourceProvenanceSchema
  })
  .strict();

export type ReviewFlowTaskBinding = z.infer<typeof taskBindingSchema>;
export type ReviewFlowTaskSourceProvenance = z.infer<typeof taskSourceProvenanceSchema>;
export type ReviewFlowTaskSourceResult = z.infer<typeof taskSourceResultSchema>;
const builtTaskSourceResults = new WeakSet<object>();

/** 生产编排只接收由本模块完成所有严格校验并登记的进程内结果。 */
export function isBuiltReviewFlowTaskSourceResult(
  value: unknown
): value is ReviewFlowTaskSourceResult {
  return typeof value === "object" && value !== null && builtTaskSourceResults.has(value);
}

export interface BuildReviewFlowTaskSourceOptions {
  readonly duplicateSimilarityRejectThreshold: number;
  /** 测试可冻结认证证据的判定时刻；生产默认读取当前服务器时间。 */
  readonly now?: () => Date;
}

/**
 * 把 Urmotiv 已严格解析的完整机器人任务重新在本边界校验并构造成审题快照。
 * Anklang 条目缺失、歧义、来源不可信、过期、旧版、不完整或 contentHash
 * 不一致时绝不降级为空查重。
 */
export function buildReviewFlowTaskSource(
  taskCandidate: unknown,
  options: BuildReviewFlowTaskSourceOptions
): ReviewFlowTaskSourceResult {
  const task = parseTask(taskCandidate);
  assertCoreMaterials(task.problem);
  assertProblemTagsExist(task);
  const anklang = parseCompleteAnklangItem(task, readNowMs(options.now));
  const anklangResultHash = hashCanonicalValue(anklang.result);
  const duplicateEvidence = anklang.result.candidates.map((candidate, index) => {
    const evidenceId = `anklang-${hashCanonicalValue({
      reviewItemId: anklang.item.id,
      problemContentHash: task.problem.contentHash,
      anklangResultHash,
      index,
      source: candidate.source,
      externalId: candidate.externalId,
      similarity: candidate.similarity
    }).slice(0, 32)}`;
    return {
      evidence: {
        evidenceId,
        source: candidate.source,
        externalId: candidate.externalId,
        similarity: candidate.similarity,
        sameProblemSuggestion: candidate.sameProblemSuggestion === true,
        summary: candidate.explanation ?? `公开候选题：${candidate.title}`
      },
      provenance: {
        evidenceId,
        source: candidate.source,
        externalId: candidate.externalId,
        candidateIndex: index,
        similarity: candidate.similarity,
        ...(candidate.sameProblemSuggestion === undefined
          ? {}
          : { serviceReviewSuggestion: candidate.sameProblemSuggestion }),
        authenticationStatus: "authenticated_builtin_anklang_plugin" as const,
        deterministicConfirmationAllowed: true as const
      }
    };
  });

  let source: ReviewFlowSource;
  try {
    source = reviewFlowSourceSchema.parse({
      schemaVersion: 1,
      problemContentHash: task.problem.contentHash,
      problemRevision: task.problem.revision,
      expectedRound: task.problem.reviewRound,
      type: task.problem.type,
      statement: buildCompleteStatement(task.problem),
      solution: buildCompleteSolution(task.problem),
      constraints: task.problem.content.constraints,
      samples: task.problem.samples,
      limits: task.problem.limits,
      // 当前正式 robot task 契约没有参考实现字段；不能把模型生成代码或题解
      // 冒充投稿者提供的标程。
      referenceImplementation: null,
      tagCatalogVersion: task.tagCatalog.version,
      tagCatalog: task.tagCatalog.tags,
      duplicateEvidence: duplicateEvidence.map((entry) => entry.evidence),
      duplicateSimilarityRejectThreshold: options.duplicateSimilarityRejectThreshold
    });
  } catch {
    throw new ReviewFlowTaskSourceError("REVIEW_FLOW_TASK_SOURCE_INVALID");
  }

  try {
    const result = deepFreeze(taskSourceResultSchema.parse({
      schemaVersion: 1,
      taskBinding: {
        assignmentId: task.assignmentId,
        leaseExpiresAt: task.leaseExpiresAt,
        problemId: task.problem.id,
        problemRevision: task.problem.revision,
        expectedRound: task.problem.reviewRound,
        problemContentHash: task.problem.contentHash,
        tagCatalogVersion: task.tagCatalog.version,
        currentTagIds: task.problem.tagIds
      },
      source,
      provenance: {
        anklang: {
          reviewItemType: anklangSimilarityReviewItemType,
          reviewItemId: anklang.item.id,
          reviewItemCreatedAt: anklang.item.createdAt,
          reviewItemSource: anklang.item.source,
          sourcePluginId: anklang.item.sourcePluginId,
          reviewItemVisibility: anklang.item.visibility,
          reviewItemExpiresAt: anklang.item.expiresAt,
          apiVersion: "2",
          checkedAt: anklang.result.checkedAt,
          completionStatus: "complete",
          contentHash: anklang.result.contentHash,
          resultHash: anklangResultHash,
          contentHashBinding: "matched",
          authenticationStatus: "authenticated_builtin_anklang_plugin",
          reportedBlockSubmission: anklang.result.recommendation.blockSubmission,
          deterministicConfirmationAllowed: true,
          evidence: duplicateEvidence.map((entry) => entry.provenance)
        },
        referenceImplementation: {
          status: "not_provided_by_robot_task_contract"
        }
      }
    }));
    builtTaskSourceResults.add(result);
    return result;
  } catch {
    throw new ReviewFlowTaskSourceError("REVIEW_FLOW_TASK_SOURCE_INVALID");
  }
}

function parseTask(taskCandidate: unknown): RobotReviewTask {
  try {
    return robotReviewTaskSchema.parse(structuredClone(taskCandidate));
  } catch {
    throw new ReviewFlowTaskSourceError("REVIEW_FLOW_TASK_INVALID");
  }
}

function assertCoreMaterials(problem: RobotReviewTask["problem"]): void {
  const hasStatement =
    problem.content.basicStatement.trim().length > 0 ||
    problem.content.statement.trim().length > 0;
  const hasSolution =
    problem.content.basicSolution.trim().length > 0 ||
    problem.content.solution.trim().length > 0;
  if (!hasStatement || !hasSolution) {
    throw new ReviewFlowTaskSourceError("REVIEW_FLOW_TASK_MATERIAL_INCOMPLETE");
  }
}

function assertProblemTagsExist(task: RobotReviewTask): void {
  const catalogIds = new Set(task.tagCatalog.tags.map((tag) => tag.id));
  if (
    new Set(task.problem.tagIds).size !== task.problem.tagIds.length ||
    task.problem.tagIds.some((tagId) => !catalogIds.has(tagId))
  ) {
    throw new ReviewFlowTaskSourceError("REVIEW_FLOW_TASK_TAG_CATALOG_MISMATCH");
  }
}

function parseCompleteAnklangItem(task: RobotReviewTask, nowMs: number): {
  readonly item: RobotReviewTask["reviewItems"][number];
  readonly result: z.infer<typeof completeAnklangV2ResultSchema>;
} {
  const items = task.reviewItems.filter(
    (item) => item.type === anklangSimilarityReviewItemType
  );
  if (items.length === 0) {
    throw new ReviewFlowTaskSourceError("REVIEW_FLOW_TASK_ANKLANG_ITEM_MISSING");
  }
  if (items.length !== 1) {
    throw new ReviewFlowTaskSourceError("REVIEW_FLOW_TASK_ANKLANG_ITEM_AMBIGUOUS");
  }
  const item = items[0]!;
  if (
    item.source !== "anklang" ||
    item.sourcePluginId !== robotAnklangPluginId
  ) {
    throw new ReviewFlowTaskSourceError(
      "REVIEW_FLOW_TASK_ANKLANG_SOURCE_UNTRUSTED"
    );
  }
  if (item.expiresAt !== null && Date.parse(item.expiresAt) <= nowMs) {
    throw new ReviewFlowTaskSourceError("REVIEW_FLOW_TASK_ANKLANG_ITEM_EXPIRED");
  }
  const apiVersion = readApiVersion(item.data);
  if (apiVersion === "1") {
    throw new ReviewFlowTaskSourceError(
      "REVIEW_FLOW_TASK_ANKLANG_VERSION_UNSUPPORTED"
    );
  }
  if (apiVersion !== "2") {
    throw new ReviewFlowTaskSourceError("REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID");
  }
  const parsed = anklangV2ResultSchema.safeParse(item.data);
  if (!parsed.success) {
    throw new ReviewFlowTaskSourceError("REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID");
  }
  if (parsed.data.completion.status !== "complete") {
    throw new ReviewFlowTaskSourceError("REVIEW_FLOW_TASK_ANKLANG_RESULT_INCOMPLETE");
  }
  const complete = completeAnklangV2ResultSchema.safeParse(parsed.data);
  if (!complete.success) {
    throw new ReviewFlowTaskSourceError("REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID");
  }
  const resultExpiresAt = complete.data.reuse.policy === "allowed"
    ? complete.data.reuse.expiresAt
    : null;
  if (item.expiresAt !== resultExpiresAt) {
    throw new ReviewFlowTaskSourceError(
      "REVIEW_FLOW_TASK_ANKLANG_EXPIRY_MISMATCH"
    );
  }
  if (
    item.contentHash !== task.problem.contentHash ||
    complete.data.contentHash !== task.problem.contentHash
  ) {
    throw new ReviewFlowTaskSourceError(
      "REVIEW_FLOW_TASK_ANKLANG_CONTENT_HASH_MISMATCH"
    );
  }
  return { item, result: complete.data };
}

function readNowMs(now: (() => Date) | undefined): number {
  try {
    const value = (now ?? (() => new Date()))().getTime();
    if (Number.isFinite(value)) return value;
  } catch {
    // 对无效或抛错时钟统一使用固定安全错误，不能把异常内容写进日志。
  }
  throw new ReviewFlowTaskSourceError("REVIEW_FLOW_TASK_SOURCE_INVALID");
}

function readApiVersion(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>).apiVersion;
}

function buildCompleteStatement(problem: RobotReviewTask["problem"]): string {
  return joinMarkdownSections([
    ["题目标题", problem.title],
    ["基础题面", problem.content.basicStatement],
    ["背景", problem.content.background],
    ["题目描述", problem.content.statement],
    ["输入格式", problem.content.inputFormat],
    ["输出格式", problem.content.outputFormat],
    ["提示", problem.content.hints]
  ]);
}

function buildCompleteSolution(problem: RobotReviewTask["problem"]): string {
  return joinMarkdownSections([
    ["基础题解", problem.content.basicSolution],
    ["详细题解", problem.content.solution]
  ]);
}

function joinMarkdownSections(sections: readonly (readonly [string, string])[]): string {
  return sections
    .filter(([, content]) => content.trim().length > 0)
    .map(([heading, content]) => `## ${heading}\n\n${content}`)
    .join("\n\n");
}
