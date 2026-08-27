/**
 * review-flow 标定的私有、可恢复检查点。
 *
 * 检查点始终从已经验证的目录描述符读取；0600、当前用户、普通文件、nlink=1
 * 任一不满足即拒绝。active/failed/终止信号都是不可洗白的污染状态，resume 不
 * 会再次付费。执行封存时间用于确定性生成报告，崩溃恢复时不得重新取时钟。
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { z } from "zod";
import {
  anchoredPrivatePath,
  closePrivateDirectory,
  openExistingPrivateDirectory,
  preparePrivateDirectory,
  projectPrivateRoot,
  workspaceRoot,
  type PrivateDirectoryHandle
} from "../../scripts/private-runtime.mjs";
import {
  reviewFlowAuditErrorCodeSchema,
  reviewFlowCalibrationProjectionSchema,
  reviewFlowFailureKindAllowlist,
  reviewFlowRoleAttemptsSchema,
  reviewFlowRoleStage,
  type ReviewFlowRoleAttemptAudit
} from "../../src/review-flow/orchestrator";
import { deepFreeze, hashCanonicalValue } from "../../src/review-flow/evidence";
import { reviewFlowRoleSchema } from "../../src/review-flow/schemas";
import type { LlmSafeStreamTelemetryEvent } from "../../src/llm";
import {
  readPrivateArtifactBytes
} from "./private-artifact-io";
import {
  reviewFlowEvaluationCaseSelectionSchema,
  isReviewFlowEvaluationRepresentative3Selection,
  reviewFlowEvaluationDigestSchema,
  reviewFlowEvaluationLabelSchema,
  reviewFlowEvaluationOrderedSelectionSha256,
  reviewFlowEvaluationPurposeSchema,
  reviewFlowEvaluationSafeIdSchema,
  reviewFlowEvaluationSubjectIdSchema
} from "./review-flow-evaluation-dataset";
import { PhysicalBlindArtifactError } from "./physical-blind-common";
import { reviewFlowRuntimeIdentitySchema } from "./review-flow-runtime-attestation";

const digestSchema = reviewFlowEvaluationDigestSchema;
export { reviewFlowEvaluationLabelSchema };
const timestampSchema = z.string().datetime();
const roleProviderSummarySchema = z
  .object({
    role: reviewFlowRoleSchema,
    provider: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u),
    model: z.string().trim().min(1).max(200)
  })
  .strict();

export const reviewFlowSafeStreamCheckpointRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    role: reviewFlowRoleSchema,
    stage: z.enum([
      "headers",
      "first_chunk",
      "progress",
      "pending",
      "done",
      "eof",
      "reader_error",
      "abort"
    ]),
    statusClass: z.enum(["1xx", "2xx", "3xx", "4xx", "5xx"]).nullable(),
    elapsedMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    lastDataMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    done: z.boolean(),
    eof: z.boolean(),
    readerPending: z.boolean(),
    abort: z.boolean()
  })
  .strict();

export type ReviewFlowSafeStreamCheckpointRecord = z.infer<
  typeof reviewFlowSafeStreamCheckpointRecordSchema
>;

export const reviewFlowEvaluationBaselineBindingSchema = z
  .object({
    schemaVersion: z.literal(2),
    label: reviewFlowEvaluationLabelSchema,
    runId: z.string().uuid(),
    datasetFingerprint: digestSchema,
    summarySha256: digestSchema,
    markdownSha256: digestSchema,
    reportSetSha256: digestSchema,
    labelClaimSha256: digestSchema,
    publicationReceiptSha256: digestSchema,
    executionCompletionFingerprint: digestSchema,
    codeVersion: z.string().regex(/^[0-9a-f]{40}$/u),
    configurationFingerprint: digestSchema,
    runnerIdentity: digestSchema
  })
  .strict();
export type ReviewFlowEvaluationBaselineBinding = z.infer<
  typeof reviewFlowEvaluationBaselineBindingSchema
>;

export const reviewFlowEvaluationIdentitySchema = z
  .object({
    schemaVersion: z.literal(2),
    protocolVersion: z.literal("review-flow-evaluation-v2"),
    datasetFingerprint: digestSchema,
    manifestSha256: digestSchema,
    purpose: reviewFlowEvaluationPurposeSchema,
    codeIdentity: z
      .object({
        codeVersion: z.string().regex(/^[0-9a-f]{40}$/u),
        runnerSha256: digestSchema,
        dependencyCodeSha256: digestSchema,
        dependencyFileCount: z.number().int().positive(),
        productionDependencyCodeSha256: digestSchema,
        productionDependencyFileCount: z.number().int().positive()
      })
      .strict(),
    runtime: reviewFlowRuntimeIdentitySchema
      .superRefine((runtime, context) => {
        const major = Number.parseInt(runtime.nodeVersion.split(".")[0] ?? "", 10);
        if (!Number.isSafeInteger(major) || major < 24) {
          context.addIssue({
            code: "custom",
            path: ["nodeVersion"],
            message: "review-flow 标定必须绑定 Node.js 24 或更高版本。"
          });
        }
      }),
    configurationFingerprint: digestSchema,
    configurationSummary: z
      .object({
        llmFirstOutputMs: z.number().int().positive(),
        llmOutputIdleMs: z.number().int().positive(),
        llmMaximumDurationMs: z.number().int().positive(),
        maxAttempts: z.number().int().min(1).max(10),
        baseDelayMs: z.number().int().positive(),
        maxEventShapeRetries: z.number().int().min(0).max(4).nullable().optional(),
        concurrency: z.number().int().min(1).max(20),
        caseAttempts: z.number().int().min(1).max(8),
        proxyEnvironmentFingerprint: digestSchema,
        proxyEnvironmentKeys: z
          .array(z.enum([
            "ALL_PROXY",
            "HTTPS_PROXY",
            "HTTP_PROXY",
            "NO_PROXY",
            "all_proxy",
            "http_proxy",
            "https_proxy",
            "no_proxy"
          ]))
          .max(8),
        duplicateSimilarityReject: z.number().finite().min(0).max(1),
        difficultyAnchorsFingerprint: digestSchema,
        difficultyAnchorsProvisional: z.boolean()
      })
      .strict(),
    experimentVersion: z.string().trim().min(1).max(120),
    profileName: z.string().trim().min(1).max(120),
    runnerIdentity: digestSchema,
    transportMode: z.literal("production_undici"),
    providerSummary: z.array(roleProviderSummarySchema).length(11),
    caseSelection: reviewFlowEvaluationCaseSelectionSchema.optional()
  })
  .strict()
  .superRefine((identity, context) => {
    const roles = identity.providerSummary.map((entry) => entry.role);
    if (
      new Set(roles).size !== reviewFlowRoleSchema.options.length ||
      reviewFlowRoleSchema.options.some(
        (role, index) => roles[index] !== role
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["providerSummary"],
        message: "必须按固定顺序绑定全部 11 个角色。"
      });
    }
    if (
      identity.caseSelection !== undefined &&
      (
        identity.purpose !== "development" ||
        identity.caseSelection.parentDatasetFingerprint !==
          identity.datasetFingerprint ||
        identity.caseSelection.parentManifestSha256 !== identity.manifestSha256 ||
        identity.caseSelection.selectedCaseCount >
          identity.caseSelection.parentCaseCount ||
        identity.caseSelection.selector === "private-file-v1" &&
          identity.caseSelection.selectedCaseSetSha256 !==
            identity.caseSelection.orderedSelectionSha256 ||
        identity.configurationSummary.caseAttempts !== 1
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["caseSelection"],
        message: isReviewFlowEvaluationRepresentative3Selection(
          identity.caseSelection
        )
          ? "representative3 只能绑定 development frozen32 与单次案例尝试。"
          : "私有子集只能绑定 development 数据集与单次案例尝试。"
      });
    }
  });
export type ReviewFlowEvaluationIdentity = z.infer<
  typeof reviewFlowEvaluationIdentitySchema
>;

/**
 * development -> holdout 必须冻结所有会参与一次预测运行的登记代码，而不只是
 * 正式 prompt/pipeline 子集。这里故意绑定完整 46-file evaluation identity；在
 * 尚未有经审阅的更窄语义清单前，不允许把 adapter/dataset/runner 当成纯 harness。
 */
export const reviewFlowEvaluationPredictionIdentitySchema = z
  .object({
    codeVersion: z.string().regex(/^[0-9a-f]{40}$/u),
    dependencyCodeSha256: digestSchema,
    dependencyFileCount: z.number().int().positive(),
    productionDependencyCodeSha256: digestSchema,
    productionDependencyFileCount: z.number().int().positive(),
    configurationFingerprint: digestSchema,
    runnerIdentity: digestSchema,
    experimentVersion: z.string().trim().min(1).max(120),
    profileName: z.string().trim().min(1).max(120),
    transportMode: z.literal("production_undici"),
    runtime: reviewFlowEvaluationIdentitySchema.shape.runtime,
    providerSummary: z.array(roleProviderSummarySchema).length(11)
  })
  .strict();
export type ReviewFlowEvaluationPredictionIdentity = z.infer<
  typeof reviewFlowEvaluationPredictionIdentitySchema
>;

export function reviewFlowEvaluationPredictionIdentity(
  identity: ReviewFlowEvaluationIdentity
): ReviewFlowEvaluationPredictionIdentity {
  return reviewFlowEvaluationPredictionIdentitySchema.parse({
    codeVersion: identity.codeIdentity.codeVersion,
    dependencyCodeSha256: identity.codeIdentity.dependencyCodeSha256,
    dependencyFileCount: identity.codeIdentity.dependencyFileCount,
    productionDependencyCodeSha256:
      identity.codeIdentity.productionDependencyCodeSha256,
    productionDependencyFileCount:
      identity.codeIdentity.productionDependencyFileCount,
    configurationFingerprint: identity.configurationFingerprint,
    runnerIdentity: identity.runnerIdentity,
    experimentVersion: identity.experimentVersion,
    profileName: identity.profileName,
    transportMode: identity.transportMode,
    runtime: identity.runtime,
    providerSummary: identity.providerSummary
  });
}

export function reviewFlowEvaluationPredictionIdentityFingerprint(
  identity: ReviewFlowEvaluationIdentity
): string {
  return hashCanonicalValue(reviewFlowEvaluationPredictionIdentity(identity));
}

const expectedCaseSchema = z
  .object({
    safeId: reviewFlowEvaluationSafeIdSchema,
    subjectId: reviewFlowEvaluationSubjectIdSchema,
    sourceLineageSha256: digestSchema,
    contentSha256: digestSchema
  })
  .strict();
export type ReviewFlowEvaluationExpectedCase = z.infer<
  typeof expectedCaseSchema
>;

const roleFailureSchema = z
  .object({
    role: z.string().min(1).max(64),
    failureKind: z.enum(reviewFlowFailureKindAllowlist).nullable(),
    requestCount: z.number().int().min(0).max(4),
    transportAttemptCount: z.number().int().min(0).max(64),
    completedResponseCount: z.number().int().min(0).max(4)
  })
  .strict();

const failureSchema = z
  .object({
    code: z.string().regex(/^[A-Z0-9_]{1,120}$/u),
    failureKind: z.enum(reviewFlowFailureKindAllowlist).nullable(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    completedRoleCount: z.number().int().min(0).max(11),
    failedRoleCount: z.number().int().min(0).max(11),
    failedRoles: z.array(roleFailureSchema),
    roleAttempts: reviewFlowRoleAttemptsSchema.optional(),
    caseAttempts: z.number().int().min(1).max(8).default(1)
  })
  .strict();
export type ReviewFlowEvaluationFailure = z.infer<typeof failureSchema>;
export const reviewFlowEvaluationCaseErrorCodeSchema = z.enum([
  ...reviewFlowAuditErrorCodeSchema.options,
  "REVIEW_FLOW_EVALUATION_TIMING_RECEIPT_MISSING",
  "REVIEW_FLOW_EVALUATION_EXECUTION_THROWN"
]);
export type ReviewFlowEvaluationCaseErrorCode = z.infer<
  typeof reviewFlowEvaluationCaseErrorCodeSchema
>;


export const reviewFlowEvaluationCaseAttemptSchema = z
  .object({
    schemaVersion: z.literal(1),
    attempt: z.number().int().min(1).max(8),
    outcome: z.enum(["completed", "failed"]),
    accountingComplete: z.boolean(),
    errorCategory: z.enum(reviewFlowFailureKindAllowlist).nullable(),
    errorCode: reviewFlowEvaluationCaseErrorCodeSchema.nullable(),
    roleAttempts: reviewFlowRoleAttemptsSchema
  })
  .strict()
  .superRefine((attempt, context) => {
    const completedRoles = attempt.roleAttempts.filter(
      (role) => role.outcome === "completed"
    ).length;
    if (
      attempt.outcome === "completed" &&
      completedRoles !== reviewFlowRoleSchema.options.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["roleAttempts"],
        message: "完成案例尝试必须完成全部角色。"
      });
    }
  });
export type ReviewFlowEvaluationCaseAttempt = z.infer<
  typeof reviewFlowEvaluationCaseAttemptSchema
>;

export const reviewFlowEvaluationAuditLedgerSchema = z
  .object({
    schemaVersion: z.literal(1),
    cases: z.array(
      z
        .object({
          caseOrdinal: z.number().int().positive().max(1_000),
          attempts: z
            .array(reviewFlowEvaluationCaseAttemptSchema)
            .max(8)
        })
        .strict()
        .superRefine((entry, context) => {
          for (let index = 0; index < entry.attempts.length; index++) {
            if (entry.attempts[index]?.attempt !== index + 1) {
              context.addIssue({
                code: "custom",
                path: ["attempts", index, "attempt"],
                message: "案例尝试编号必须从 1 连续递增。"
              });
            }
          }
        })
    ).min(1).max(1_000)
  })
  .strict();
export type ReviewFlowEvaluationAuditLedger = z.infer<
  typeof reviewFlowEvaluationAuditLedgerSchema
>;
const nullableAuditCountSchema = z.number().int().nonnegative().nullable();

export const reviewFlowEvaluationAuditAccountingSchema = z
  .object({
    exact: z.boolean(),
    caseAttempts: nullableAuditCountSchema,
    logicalRequests: nullableAuditCountSchema,
    transportAttempts: nullableAuditCountSchema,
    providerRequests: nullableAuditCountSchema,
    retries: nullableAuditCountSchema,
    usageTotalTokens: nullableAuditCountSchema,
    unknownUsageRoleCount: nullableAuditCountSchema,
    responseBytes: nullableAuditCountSchema,
    unknownResponseByteRoleCount: nullableAuditCountSchema,
    dependencyBlockedRoleCount: nullableAuditCountSchema
  })
  .strict();
export type ReviewFlowEvaluationAuditAccounting = z.infer<
  typeof reviewFlowEvaluationAuditAccountingSchema
>;

export function summarizeReviewFlowEvaluationAuditLedger(
  ledger: ReviewFlowEvaluationAuditLedger | null
): ReviewFlowEvaluationAuditAccounting {
  if (ledger === null) {
    return reviewFlowEvaluationAuditAccountingSchema.parse({
      exact: false,
      caseAttempts: null,
      logicalRequests: null,
      transportAttempts: null,
      providerRequests: null,
      retries: null,
      usageTotalTokens: null,
      unknownUsageRoleCount: null,
      responseBytes: null,
      unknownResponseByteRoleCount: null,
      dependencyBlockedRoleCount: null
    });
  }
  const attempts = ledger.cases.flatMap((entry) => entry.attempts);
  const roles = attempts.flatMap((attempt) => attempt.roleAttempts);
  const countedRoles = roles.filter((role) => !role.dependencyBlocked);
  const usageValues = countedRoles.flatMap((role) =>
    role.usageTotalTokens === null ? [] : [role.usageTotalTokens]
  );
  const byteValues = countedRoles.flatMap((role) =>
    role.responseByteCount === null ? [] : [role.responseByteCount]
  );
  return reviewFlowEvaluationAuditAccountingSchema.parse({
    exact: attempts.every((attempt) => attempt.accountingComplete),
    caseAttempts: attempts.length,
    logicalRequests: roles.reduce(
      (sum, role) => sum + role.logicalRequestCount,
      0
    ),
    transportAttempts: roles.reduce(
      (sum, role) => sum + role.transportAttemptCount,
      0
    ),
    providerRequests: roles.reduce(
      (sum, role) => sum + role.providerRequestCount,
      0
    ),
    retries: roles.reduce((sum, role) => sum + role.retryCount, 0),
    usageTotalTokens: usageValues.length === 0
      ? null
      : usageValues.reduce((sum, value) => sum + value, 0),
    unknownUsageRoleCount: countedRoles.filter(
      (role) => role.usageTotalTokens === null
    ).length,
    responseBytes: byteValues.length === 0
      ? null
      : byteValues.reduce((sum, value) => sum + value, 0),
    unknownResponseByteRoleCount: countedRoles.filter(
      (role) => role.responseByteCount === null
    ).length,
    dependencyBlockedRoleCount: roles.filter(
      (role) => role.dependencyBlocked
    ).length
  });
}

export const reviewFlowEvaluationTerminalReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["complete", "incomplete"]),
    caseCount: z.number().int().positive().max(1_000),
    caseAttempts: z
      .array(
        z
          .object({
            caseOrdinal: z.number().int().positive().max(1_000),
            attempts: z.array(reviewFlowEvaluationCaseAttemptSchema).max(8)
          })
          .strict()
      )
      .nullable(),
    accounting: reviewFlowEvaluationAuditAccountingSchema
  })
  .strict();
export type ReviewFlowEvaluationTerminalReceipt = z.infer<
  typeof reviewFlowEvaluationTerminalReceiptSchema
>;

export const reviewFlowEvaluationCaseTimingSchema = z
  .object({
    schemaVersion: z.literal(1),
    firstByteMs: z.number().int().nonnegative(),
    endToEndMs: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.firstByteMs > receipt.endToEndMs) {
      context.addIssue({
        code: "custom",
        message: "案例首字节时延不得晚于案例结束。"
      });
    }
  });
export type ReviewFlowEvaluationCaseTiming = z.infer<
  typeof reviewFlowEvaluationCaseTimingSchema
>;

export const reviewFlowEvaluationPilotTimingReceiptSchema = z
  .object({
    schemaVersion: z.literal(2),
    firstByteMs: z.number().int().nonnegative(),
    endToEndMs: z.number().int().nonnegative(),
    monotonicLatencyMs: z.number().int().nonnegative(),
    remainingTwoBoundMs: z.number().int().nonnegative(),
    projectedTotalDurationMs: z.number().int().nonnegative(),
    maximumTotalDurationMs: z.literal(180 * 60 * 1_000),
    projectedWithinLimit: z.boolean(),
    remainingCasesAdmitted: z.boolean()
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.endToEndMs !== receipt.monotonicLatencyMs ||
      receipt.firstByteMs > receipt.endToEndMs ||
      receipt.projectedWithinLimit !==
        (receipt.projectedTotalDurationMs <= receipt.maximumTotalDurationMs) ||
      (receipt.remainingCasesAdmitted && !receipt.projectedWithinLimit)
    ) {
      context.addIssue({
        code: "custom",
        message: "pilot 时延收据与真实时序或 90 分钟准入决定不一致。"
      });
    }
  });
export type ReviewFlowEvaluationPilotTimingReceipt = z.infer<
  typeof reviewFlowEvaluationPilotTimingReceiptSchema
>;

export const reviewFlowEvaluationRepresentative3TimingSchema = z
  .object({
    schemaVersion: z.literal(1),
    firstByteMs: z.number().int().nonnegative(),
    stage2LatencyMs: z.number().int().nonnegative(),
    endToEndMs: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.firstByteMs > receipt.endToEndMs ||
      receipt.stage2LatencyMs > receipt.endToEndMs
    ) {
      context.addIssue({
        code: "custom",
        message: "representative3 时延收据顺序无效。"
      });
    }
  });
export type ReviewFlowEvaluationRepresentative3Timing = z.infer<
  typeof reviewFlowEvaluationRepresentative3TimingSchema
>;

const pendingEntrySchema = z
  .object({ safeId: reviewFlowEvaluationSafeIdSchema, status: z.literal("pending") })
  .strict();
const activeEntrySchema = z
  .object({
    safeId: reviewFlowEvaluationSafeIdSchema,
    status: z.literal("active"),
    startedAt: timestampSchema
  })
  .strict();
const completedEntrySchema = z
  .object({
    safeId: reviewFlowEvaluationSafeIdSchema,
    status: z.literal("completed"),
    completedAt: timestampSchema,
    projection: reviewFlowCalibrationProjectionSchema,
    pilotTiming: reviewFlowEvaluationPilotTimingReceiptSchema.optional(),
    caseTiming: reviewFlowEvaluationCaseTimingSchema.optional()
  })
  .strict();
const failedEntrySchema = z
  .object({
    safeId: reviewFlowEvaluationSafeIdSchema,
    status: z.literal("failed"),
    failedAt: timestampSchema,
    failure: failureSchema,
    pilotTiming: reviewFlowEvaluationPilotTimingReceiptSchema.optional()
  })
  .strict();
export const reviewFlowEvaluationEntrySchema = z.discriminatedUnion("status", [
  pendingEntrySchema,
  activeEntrySchema,
  completedEntrySchema,
  failedEntrySchema
]);
export type ReviewFlowEvaluationEntry = z.infer<
  typeof reviewFlowEvaluationEntrySchema
>;

const terminationSchema = z
  .object({
    signal: z.enum(["SIGINT", "SIGTERM", "SIGHUP"]),
    observedAt: timestampSchema
  })
  .strict();

const executionSealSchema = z
  .object({
    sealedAt: timestampSchema,
    complete: z.boolean(),
    completionFingerprint: digestSchema
  })
  .strict();
const failedOnlyContinuationSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal("failed-only"),
    sourceLabel: reviewFlowEvaluationLabelSchema,
    sourceRunId: z.string().uuid(),
    sourceIdentityFingerprint: digestSchema,
    continuationIdentityFingerprint: digestSchema,
    sourceStateFingerprint: digestSchema,
    sourceExecutionCompletionFingerprint: digestSchema,
    sourceFailedCaseIds: z.array(reviewFlowEvaluationSafeIdSchema).min(1).max(1_000),
    selectedFailedCaseIds: z.array(reviewFlowEvaluationSafeIdSchema).min(1).max(1_000),
    caseAttempts: z.literal(1)
  })
  .strict();
export type ReviewFlowEvaluationFailedOnlyContinuation = z.infer<
  typeof failedOnlyContinuationSchema
>;


export const reviewFlowEvaluationPublicationBindingSchema = z
  .object({
    kind: z.enum(["scored_report", "holdout_prediction"]),
    artifactSetSha256: digestSchema,
    registryReceiptSha256: digestSchema,
    complete: z.boolean(),
    acknowledgedAt: timestampSchema
  })
  .strict();
export type ReviewFlowEvaluationPublicationBinding = z.infer<
  typeof reviewFlowEvaluationPublicationBindingSchema
>;

export const reviewFlowEvaluationCheckpointSchema = z
  .object({
    schemaVersion: z.literal(2),
    label: reviewFlowEvaluationLabelSchema,
    variant: z.enum(["baseline", "candidate"]),
    baselineLabel: reviewFlowEvaluationLabelSchema.nullable(),
    baselineBinding: reviewFlowEvaluationBaselineBindingSchema.nullable(),
    runId: z.string().uuid(),
    identity: reviewFlowEvaluationIdentitySchema,
    identityFingerprint: digestSchema,
    holdoutIdentity: digestSchema.nullable(),
    thresholdPolicySha256: digestSchema.nullable(),
    expectedCases: z.array(expectedCaseSchema).min(1).max(1_000),
    entries: z.array(reviewFlowEvaluationEntrySchema).min(1).max(1_000),
    auditLedger: reviewFlowEvaluationAuditLedgerSchema.nullable().default(null),
    globalClaimSha256: digestSchema.nullable(),
    termination: terminationSchema.nullable(),
    executionSeal: executionSealSchema.nullable(),
    publication: reviewFlowEvaluationPublicationBindingSchema.nullable(),
    failedOnlyContinuation: failedOnlyContinuationSchema.optional(),
    representative3Timing:
      reviewFlowEvaluationRepresentative3TimingSchema.optional(),
    revision: z.number().int().positive(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema
  })
  .strict()
  .superRefine((state, context) => {
    if (
      state.auditLedger !== null &&
      (state.auditLedger.cases.length !== state.expectedCases.length ||
        state.auditLedger.cases.some(
          (entry, index) => entry.caseOrdinal !== index + 1
        ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["auditLedger"],
        message: "审计账本必须与预期案例一一对应并按序编号。"
      });
    }
    const candidateDevelopment =
      state.variant === "candidate" && state.identity.purpose === "development";
    const candidateHoldout =
      state.variant === "candidate" && state.identity.purpose === "holdout";
    if (
      (state.variant === "baseline" &&
        (state.baselineLabel !== null || state.baselineBinding !== null)) ||
      (candidateDevelopment &&
        (state.baselineLabel === null ||
          state.baselineLabel === state.label ||
          state.baselineBinding === null ||
          state.baselineBinding.label !== state.baselineLabel)) ||
      (candidateHoldout &&
        (state.baselineLabel === null ||
          state.baselineLabel === state.label ||
          state.baselineBinding !== null))
    ) {
      context.addIssue({
        code: "custom",
        path: ["baselineLabel"],
        message: "基线/候选绑定与分区不一致。"
      });
    }
    if (
      (state.identity.purpose === "holdout" &&
        (state.holdoutIdentity === null || state.thresholdPolicySha256 === null)) ||
      (state.identity.purpose === "development" &&
        (state.holdoutIdentity !== null || state.thresholdPolicySha256 !== null))
    ) {
      context.addIssue({
        code: "custom",
        path: ["holdoutIdentity"],
        message: "holdout 身份只能出现在 holdout 检查点。"
      });
    }
    const expectedIds = state.expectedCases.map((entry) => entry.safeId);
    const entryIds = state.entries.map((entry) => entry.safeId);
    if (
      new Set(expectedIds).size !== expectedIds.length ||
      new Set(state.expectedCases.map((entry) => entry.subjectId)).size !==
        state.expectedCases.length ||
      new Set(entryIds).size !== entryIds.length ||
      expectedIds.length !== entryIds.length ||
      expectedIds.some((safeId, index) => safeId !== entryIds[index]) ||
      state.identityFingerprint !== hashCanonicalValue(state.identity)
    ) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "检查点身份或样本集合不一致。"
      });
    }
    if (
      state.identity.caseSelection !== undefined &&
      (
        state.expectedCases.length !==
          state.identity.caseSelection.selectedCaseCount ||
        state.identity.caseSelection.orderedSelectionSha256 !==
          reviewFlowEvaluationOrderedSelectionSha256(state.expectedCases) ||
        state.identity.caseSelection.selector === "private-file-v1" &&
          state.identity.caseSelection.selectedCaseSetSha256 !==
            state.identity.caseSelection.orderedSelectionSha256
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["expectedCases"],
        message: isReviewFlowEvaluationRepresentative3Selection(
          state.identity.caseSelection
        )
          ? "representative3 检查点未绑定固定三题有序集合。"
          : "私有子集检查点未绑定声明的有序案例集合。"
      });
    }
    if (
      state.representative3Timing !== undefined &&
      (
        !isReviewFlowEvaluationRepresentative3Selection(
          state.identity.caseSelection
        ) ||
        state.entries.some((entry) => entry.status !== "completed")
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["representative3Timing"],
        message: "representative3 总时延只能绑定三题完成终态。"
      });
    }
    if (
      isReviewFlowEvaluationRepresentative3Selection(
        state.identity.caseSelection
      ) &&
      state.entries.some(
        (entry) =>
          entry.status === "completed" && entry.caseTiming === undefined
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "representative3 完成案例缺少真实请求时延收据。"
      });
    }
    if (state.executionSeal !== null) {
      const expectedFingerprint = executionCompletionFingerprint(state);
      const receiptSeal = buildExecutionReceiptSeal(
        state.expectedCases,
        state.identity.caseSelection,
        state.entries
      );
      const actuallyComplete =
        state.termination === null && receiptSeal.complete;
      if (
        state.executionSeal.completionFingerprint !== expectedFingerprint ||
        state.executionSeal.complete !== actuallyComplete
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["executionSeal"],
          message: "执行封存摘要与检查点终态不一致。"
        });
      }
    }
    if (
      state.publication !== null &&
      (state.executionSeal === null ||
        state.publication.complete !== state.executionSeal.complete)
    ) {
      context.addIssue({
        code: "custom",
        path: ["publication"],
        message: "发布确认必须绑定已封存执行终态。"
      });
    }
    const failedOnly = state.failedOnlyContinuation;
    if (failedOnly !== undefined) {
      const expectedIds = new Set(state.expectedCases.map((entry) => entry.safeId));
      const sourceIds = new Set(failedOnly.sourceFailedCaseIds);
      const selectedIds = new Set(failedOnly.selectedFailedCaseIds);
      if (
        state.identity.configurationSummary.caseAttempts !== 1 ||
        failedOnly.continuationIdentityFingerprint !==
          state.identityFingerprint ||
        sourceIds.size !== failedOnly.sourceFailedCaseIds.length ||
        selectedIds.size !== failedOnly.selectedFailedCaseIds.length ||
        failedOnly.selectedFailedCaseIds.some((safeId) => !sourceIds.has(safeId)) ||
        failedOnly.sourceFailedCaseIds.some((safeId) => !expectedIds.has(safeId))
      ) {
        context.addIssue({
          code: "custom",
          path: ["failedOnlyContinuation"],
          message: "failed-only continuation binding is invalid."
        });
      }
    }

  });
export type ReviewFlowEvaluationCheckpointState = z.infer<
  typeof reviewFlowEvaluationCheckpointSchema
>;

export interface ReviewFlowEvaluationCheckpointGenesisBinding {
  readonly schemaVersion: 2;
  readonly label: string;
  readonly variant: "baseline" | "candidate";
  readonly purpose: "development" | "holdout";
  readonly runId: string;
  readonly identityFingerprint: string;
  readonly predictionIdentityFingerprint: string;
  readonly expectedCasesFingerprint: string;
  readonly checkpointGenesisFingerprint: string;
  readonly stateDirectory: { readonly device: string; readonly inode: string };
}

export interface ReviewFlowEvaluationCheckpointRevealSnapshot {
  readonly state: ReviewFlowEvaluationCheckpointState;
  readonly genesis: ReviewFlowEvaluationCheckpointGenesisBinding;
}

/**
 * reveal 只读已封存链，不重建旧模型配置。读取仍锚定已验证 dirfd，并返回目录
 * dev/ino 供全局 claim 对账；未封存状态由 reveal ledger 后续拒绝。
 */
export function loadReviewFlowEvaluationCheckpointForReveal(input: {
  readonly privateDirectory: string;
  readonly label: string;
  readonly privateRoot?: string;
  readonly containingWorkspace?: string;
}): ReviewFlowEvaluationCheckpointRevealSnapshot {
  if (!isAbsolute(input.privateDirectory)) {
    throw new ReviewFlowEvaluationCheckpointError(
      "REVIEW_FLOW_EVALUATION_PRIVATE_DIRECTORY_INVALID"
    );
  }
  const label = reviewFlowEvaluationLabelSchema.parse(input.label);
  const directory = openExistingPrivateDirectory(input.privateDirectory, {
    privateRoot: input.privateRoot ?? projectPrivateRoot,
    containingWorkspace: input.containingWorkspace ?? workspaceRoot
  });
  try {
    const bytes = readPrivateArtifactBytes(
      directory,
      `review-flow-${label}.checkpoint.private.json`,
      128 * 1024 * 1024
    );
    const state = reviewFlowEvaluationCheckpointSchema.parse(
      JSON.parse(bytes.toString("utf8")) as unknown
    );
    if (state.label !== label) {
      throw new Error("mismatch");
    }
    return {
      state,
      genesis: checkpointGenesisBinding(state, directory)
    };
  } catch {
    throw new ReviewFlowEvaluationCheckpointError(
      "REVIEW_FLOW_EVALUATION_REVEAL_CHECKPOINT_INVALID"
    );
  } finally {
    closePrivateDirectory(directory);
  }
}
export function loadReviewFlowEvaluationCheckpointStateFromPath(input: {
  readonly checkpointPath: string;
  readonly privateRoot?: string;
  readonly containingWorkspace?: string;
}): ReviewFlowEvaluationCheckpointState {
  if (!isAbsolute(input.checkpointPath)) {
    throw new ReviewFlowEvaluationCheckpointError(
      "REVIEW_FLOW_EVALUATION_PRIVATE_DIRECTORY_INVALID"
    );
  }
  const directoryPath = dirname(input.checkpointPath);
  const fileName = basename(input.checkpointPath);
  if (fileName.length === 0 || fileName === "." || fileName === "..") {
    throw new ReviewFlowEvaluationCheckpointError(
      "REVIEW_FLOW_EVALUATION_CHECKPOINT_INVALID"
    );
  }
  const directory = openExistingPrivateDirectory(directoryPath, {
    privateRoot: input.privateRoot ?? projectPrivateRoot,
    containingWorkspace: input.containingWorkspace ?? workspaceRoot
  });
  try {
    return reviewFlowEvaluationCheckpointSchema.parse(
      JSON.parse(
        readPrivateArtifactBytes(directory, fileName, 128 * 1024 * 1024)
          .toString("utf8")
      ) as unknown
    );
  } catch {
    throw new ReviewFlowEvaluationCheckpointError(
      "REVIEW_FLOW_EVALUATION_CHECKPOINT_INVALID"
    );
  } finally {
    closePrivateDirectory(directory);
  }
}

function failedOnlyIdentityProjection(
  identity: ReviewFlowEvaluationIdentity
): unknown {
  const {
    snapshotSha256: _snapshotSha256,
    snapshotFileCount: _snapshotFileCount,
    ...stableRuntime
  } = identity.runtime;
  return {
    ...identity,
    codeIdentity: {
      productionDependencyCodeSha256:
        identity.codeIdentity.productionDependencyCodeSha256,
      productionDependencyFileCount:
        identity.codeIdentity.productionDependencyFileCount
    },
    runtime: {
      ...stableRuntime,
      snapshotSha256: null,
      snapshotFileCount: null
    },
    configurationFingerprint: null,
    configurationSummary: {
      ...identity.configurationSummary,
      caseAttempts: 1
    }
  };
}

export function assertFailedOnlyContinuationIdentityCompatible(
  source: ReviewFlowEvaluationIdentity,
  continuation: ReviewFlowEvaluationIdentity
): void {
  let parsedSource: ReviewFlowEvaluationIdentity;
  let parsedContinuation: ReviewFlowEvaluationIdentity;
  try {
    parsedSource = reviewFlowEvaluationIdentitySchema.parse(source);
    parsedContinuation = reviewFlowEvaluationIdentitySchema.parse(continuation);
  } catch {
    throw new ReviewFlowEvaluationCheckpointError(
      "REVIEW_FLOW_EVALUATION_FAILED_ONLY_IDENTITY_MISMATCH"
    );
  }
  if (
    parsedContinuation.configurationSummary.caseAttempts !== 1 ||
    parsedSource.codeIdentity.productionDependencyCodeSha256 !==
      parsedContinuation.codeIdentity.productionDependencyCodeSha256 ||
    parsedSource.codeIdentity.productionDependencyFileCount !==
      parsedContinuation.codeIdentity.productionDependencyFileCount ||
    parsedSource.configurationSummary.caseAttempts < 1 ||
    (
      parsedSource.configurationSummary.caseAttempts ===
        parsedContinuation.configurationSummary.caseAttempts &&
      parsedSource.configurationFingerprint !==
        parsedContinuation.configurationFingerprint
    ) ||
    hashCanonicalValue(failedOnlyIdentityProjection(parsedSource)) !==
      hashCanonicalValue(failedOnlyIdentityProjection(parsedContinuation))
  ) {
    throw new ReviewFlowEvaluationCheckpointError(
      "REVIEW_FLOW_EVALUATION_FAILED_ONLY_IDENTITY_MISMATCH"
    );
  }
}


export class ReviewFlowEvaluationCheckpointError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(code);
    this.name = "ReviewFlowEvaluationCheckpointError";
    this.code = code;
  }
}
function buildFailedOnlyContinuationState(input: {
  readonly label: string;
  readonly variant: "baseline" | "candidate";
  readonly baselineLabel: string | null;
  readonly baselineBinding: ReviewFlowEvaluationBaselineBinding | null;
  readonly runId: string;
  readonly identity: ReviewFlowEvaluationIdentity;
  readonly holdoutIdentity: string | null;
  readonly thresholdPolicySha256: string | null;
  readonly expectedCases: readonly ReviewFlowEvaluationExpectedCase[];
  readonly source: ReviewFlowEvaluationCheckpointState;
  readonly selectedFailedCaseIds: readonly string[] | undefined;
  readonly now: string;
}): ReviewFlowEvaluationCheckpointState {
  const source = input.source;
  if (
    source.executionSeal === null ||
    source.executionSeal.complete ||
    source.auditLedger === null ||
    source.entries.some((entry) => entry.status === "active" || entry.status === "pending") ||
    hashCanonicalValue(source.expectedCases) !==
      hashCanonicalValue(input.expectedCases) ||
    source.entries.length !== input.expectedCases.length
  ) {
    throw new ReviewFlowEvaluationCheckpointError(
      "REVIEW_FLOW_EVALUATION_FAILED_ONLY_SOURCE_INVALID"
    );
  }
  if (
    source.variant !== input.variant ||
    source.baselineLabel !== input.baselineLabel ||
    hashCanonicalValue(source.baselineBinding) !==
      hashCanonicalValue(input.baselineBinding) ||
    source.holdoutIdentity !== input.holdoutIdentity ||
    source.thresholdPolicySha256 !== input.thresholdPolicySha256
  ) {
    throw new ReviewFlowEvaluationCheckpointError(
      "REVIEW_FLOW_EVALUATION_FAILED_ONLY_IDENTITY_MISMATCH"
    );
  }
  assertFailedOnlyContinuationIdentityCompatible(
    source.identity,
    input.identity
  );
  const sourceFailedCaseIds = source.entries.flatMap((entry) =>
    entry.status === "failed" ? [entry.safeId] : []
  );
  if (sourceFailedCaseIds.length === 0) {
    throw new ReviewFlowEvaluationCheckpointError(
      "REVIEW_FLOW_EVALUATION_FAILED_ONLY_SOURCE_EMPTY"
    );
  }
  const selectedFailedCaseIds = input.selectedFailedCaseIds === undefined
    ? sourceFailedCaseIds
    : [...input.selectedFailedCaseIds];
  const expectedIds = new Set(input.expectedCases.map((entry) => entry.safeId));
  const sourceFailedIds = new Set(sourceFailedCaseIds);
  const selectedIds = new Set(selectedFailedCaseIds);
  if (
    selectedFailedCaseIds.length === 0 ||
    selectedIds.size !== selectedFailedCaseIds.length ||
    selectedFailedCaseIds.some(
      (safeId) => !expectedIds.has(safeId) || !sourceFailedIds.has(safeId)
    )
  ) {
    throw new ReviewFlowEvaluationCheckpointError(
      "REVIEW_FLOW_EVALUATION_FAILED_ONLY_SELECTION_INVALID"
    );
  }
  const selected = new Set(selectedFailedCaseIds);
  const now = input.now;
  const continuationEntries = source.entries.map((entry) =>
    entry.status === "failed" && selected.has(entry.safeId)
      ? { safeId: entry.safeId, status: "pending" as const }
      : entry
  );
  if (
    hashCanonicalValue(
      source.entries.filter((entry) => !selected.has(entry.safeId))
    ) !==
    hashCanonicalValue(
      continuationEntries.filter((entry) => !selected.has(entry.safeId))
    )
  ) {
    throw new ReviewFlowEvaluationCheckpointError(
      "REVIEW_FLOW_EVALUATION_FAILED_ONLY_COMPLETED_CASE_MUTATION"
    );
  }
  const identityFingerprint = hashCanonicalValue(input.identity);
  return reviewFlowEvaluationCheckpointSchema.parse({
    schemaVersion: 2,
    label: input.label,
    variant: input.variant,
    baselineLabel: input.baselineLabel,
    baselineBinding: input.baselineBinding,
    runId: input.runId,
    identity: input.identity,
    identityFingerprint,
    holdoutIdentity: input.holdoutIdentity,
    thresholdPolicySha256: input.thresholdPolicySha256,
    expectedCases: input.expectedCases,
    entries: continuationEntries,
    auditLedger: source.auditLedger,
    globalClaimSha256: null,
    termination: null,
    executionSeal: null,
    publication: null,
    failedOnlyContinuation: {
      schemaVersion: 1,
      mode: "failed-only",
      sourceLabel: source.label,
      sourceRunId: source.runId,
      sourceIdentityFingerprint: source.identityFingerprint,
      continuationIdentityFingerprint: identityFingerprint,
      sourceStateFingerprint: hashCanonicalValue(source),
      sourceExecutionCompletionFingerprint:
        source.executionSeal.completionFingerprint,
      sourceFailedCaseIds,
      selectedFailedCaseIds,
      caseAttempts: 1
    },
    revision: 1,
    createdAt: now,
    updatedAt: now
  });
}


export class ReviewFlowSafeStreamCheckpoint {
  readonly #directory: PrivateDirectoryHandle;
  readonly #descriptor: number;
  #closed = false;

  public constructor(options: {
    readonly privateDirectory: string;
    readonly privateRoot?: string;
    readonly containingWorkspace?: string;
  }) {
    if (!isAbsolute(options.privateDirectory)) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_STREAM_CHECKPOINT_DIRECTORY_INVALID"
      );
    }
    this.#directory = preparePrivateDirectory(options.privateDirectory, {
      privateRoot: options.privateRoot ?? projectPrivateRoot,
      containingWorkspace: options.containingWorkspace ?? workspaceRoot
    });
    let descriptor: number | undefined;
    try {
      const target = anchoredPrivatePath(
        this.#directory,
        "review-flow-stream.checkpoint.private.jsonl"
      );
      descriptor = openSync(
        target,
        constants.O_APPEND |
          constants.O_CREAT |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      const before = fstatSync(descriptor, { bigint: true });
      const currentUid = typeof process.getuid === "function"
        ? BigInt(process.getuid())
        : before.uid;
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.uid !== currentUid
      ) {
        throw new ReviewFlowEvaluationCheckpointError(
          "REVIEW_FLOW_STREAM_CHECKPOINT_FILE_INVALID"
        );
      }
      fchmodSync(descriptor, 0o600);
      const after = fstatSync(descriptor, { bigint: true });
      if ((after.mode & 0o777n) !== 0o600n) {
        throw new ReviewFlowEvaluationCheckpointError(
          "REVIEW_FLOW_STREAM_CHECKPOINT_MODE_INVALID"
        );
      }
      fsyncSync(this.#directory.descriptor);
      this.#descriptor = descriptor;
      descriptor = undefined;
    } catch (error) {
      if (descriptor !== undefined) closeQuietly(descriptor);
      closePrivateDirectory(this.#directory);
      throw error;
    }
  }

  public append(event: LlmSafeStreamTelemetryEvent): void {
    if (this.#closed) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_STREAM_CHECKPOINT_CLOSED"
      );
    }
    const record = reviewFlowSafeStreamCheckpointRecordSchema.parse(event);
    const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    writeAll(this.#descriptor, line);
    fsyncSync(this.#descriptor);
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    closeQuietly(this.#descriptor);
    closePrivateDirectory(this.#directory);
  }
}

export function openReviewFlowSafeStreamCheckpoint(options: {
  readonly enabled: boolean;
  readonly privateDirectory: string;
  readonly privateRoot?: string;
  readonly containingWorkspace?: string;
}): ReviewFlowSafeStreamCheckpoint | undefined {
  if (!options.enabled) return undefined;
  return new ReviewFlowSafeStreamCheckpoint(options);
}

export class ReviewFlowEvaluationCheckpoint {
  readonly #directory: PrivateDirectoryHandle;
  readonly #stateFileName: string;
  readonly #lockFileName: string;
  readonly #now: () => Date;
  #lockDescriptor: number | undefined;
  #state: ReviewFlowEvaluationCheckpointState;
  #openedExisting = false;
  #closed = false;

  public constructor(options: {
    readonly privateDirectory: string;
    readonly label: string;
    readonly variant: "baseline" | "candidate";
    readonly baselineLabel: string | null;
    readonly failedOnlySource?: ReviewFlowEvaluationCheckpointState;
    readonly failedOnlyCaseIds?: readonly string[];
    readonly baselineBinding: ReviewFlowEvaluationBaselineBinding | null;
    readonly identity: ReviewFlowEvaluationIdentity;
    readonly holdoutIdentity?: string | null;
    readonly thresholdPolicySha256?: string | null;
    readonly expectedCases: readonly ReviewFlowEvaluationExpectedCase[];
    readonly resume: boolean;
    readonly privateRoot?: string;
    readonly containingWorkspace?: string;
    readonly now?: () => Date;
    readonly randomId?: () => string;
  }) {
    if (!isAbsolute(options.privateDirectory)) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_PRIVATE_DIRECTORY_INVALID"
      );
    }
    const label = reviewFlowEvaluationLabelSchema.parse(options.label);
    const identity = reviewFlowEvaluationIdentitySchema.parse(options.identity);
    const expectedCases = z
      .array(expectedCaseSchema)
      .min(1)
      .max(1_000)
      .parse(options.expectedCases);
    if (options.failedOnlySource !== undefined && options.resume) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_FAILED_ONLY_ARGUMENT_INVALID"
      );
    }

    if (identity.caseSelection !== undefined) {
      const representative3Selection =
        isReviewFlowEvaluationRepresentative3Selection(
          identity.caseSelection
        );
      if (options.resume) {
        throw new ReviewFlowEvaluationCheckpointError(
          representative3Selection
            ? "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_FRESH_ONLY"
            : "REVIEW_FLOW_EVALUATION_PRIVATE_SUBSET_FRESH_ONLY"
        );
      }
      if (
        expectedCases.length !== identity.caseSelection.selectedCaseCount ||
        identity.caseSelection.orderedSelectionSha256 !==
          reviewFlowEvaluationOrderedSelectionSha256(expectedCases) ||
        identity.caseSelection.selector === "private-file-v1" &&
          identity.caseSelection.selectedCaseSetSha256 !==
            identity.caseSelection.orderedSelectionSha256
      ) {
        throw new ReviewFlowEvaluationCheckpointError(
          representative3Selection
            ? "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_CASE_SET_MISMATCH"
            : "REVIEW_FLOW_EVALUATION_PRIVATE_SUBSET_CASE_SET_MISMATCH"
        );
      }
    }
    const holdoutIdentity = options.holdoutIdentity ?? null;
    const thresholdPolicySha256 = options.thresholdPolicySha256 ?? null;
    const privateRoot = options.privateRoot ?? projectPrivateRoot;
    const containingWorkspace = options.containingWorkspace ?? workspaceRoot;
    this.#directory = preparePrivateDirectory(options.privateDirectory, {
      privateRoot,
      containingWorkspace
    });
    this.#stateFileName = `review-flow-${label}.checkpoint.private.json`;
    this.#lockFileName = `review-flow-${label}.lock.private`;
    this.#now = options.now ?? (() => new Date());
    try {
      this.acquireLock();
      const existing = this.loadStateIfPresent();
      if (existing !== null && !options.resume) {
        throw new ReviewFlowEvaluationCheckpointError(
          "REVIEW_FLOW_EVALUATION_LABEL_ALREADY_USED"
        );
      }
      if (existing === null && options.resume) {
        throw new ReviewFlowEvaluationCheckpointError(
          "REVIEW_FLOW_EVALUATION_RESUME_NOT_FOUND"
        );
      }
      if (existing !== null) {
        this.#state = existing;
        this.#openedExisting = true;
        if (
          this.#state.label !== label ||
          this.#state.variant !== options.variant ||
          this.#state.baselineLabel !== options.baselineLabel ||
          hashCanonicalValue(this.#state.baselineBinding) !==
            hashCanonicalValue(options.baselineBinding) ||
          this.#state.identityFingerprint !== hashCanonicalValue(identity) ||
          this.#state.holdoutIdentity !== holdoutIdentity ||
          this.#state.thresholdPolicySha256 !== thresholdPolicySha256 ||
          hashCanonicalValue(this.#state.expectedCases) !==
            hashCanonicalValue(expectedCases)
        ) {
          throw new ReviewFlowEvaluationCheckpointError(
            "REVIEW_FLOW_EVALUATION_RESUME_IDENTITY_MISMATCH"
          );
        }
        return;
      }

      const now = this.#now().toISOString();
      const runId = (options.randomId ?? randomUUID)();
      this.#state = options.failedOnlySource === undefined
        ? reviewFlowEvaluationCheckpointSchema.parse({
            schemaVersion: 2,
            label,
            variant: options.variant,
            baselineLabel: options.baselineLabel,
            baselineBinding: options.baselineBinding,
            runId,
            identity,
            identityFingerprint: hashCanonicalValue(identity),
            holdoutIdentity,
            thresholdPolicySha256,
            expectedCases,
            entries: expectedCases.map((entry) => ({
              safeId: entry.safeId,
              status: "pending" as const
            })),
            auditLedger: {
              schemaVersion: 1,
              cases: expectedCases.map((_, index) => ({
                caseOrdinal: index + 1,
                attempts: []
              }))
            },
            globalClaimSha256: null,
            termination: null,
            executionSeal: null,
            publication: null,
            revision: 1,
            createdAt: now,
            updatedAt: now
          })
        : buildFailedOnlyContinuationState({
            label,
            variant: options.variant,
            baselineLabel: options.baselineLabel,
            baselineBinding: options.baselineBinding,
            runId,
            identity,
            holdoutIdentity,
            thresholdPolicySha256,
            expectedCases,
            source: options.failedOnlySource,
            selectedFailedCaseIds: options.failedOnlyCaseIds,
            now
          });
      this.persist();
    } catch (error) {
      this.releaseResources();
      if (error instanceof ReviewFlowEvaluationCheckpointError) throw error;
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_CHECKPOINT_UNAVAILABLE"
      );
    }
  }

  public snapshot(): ReviewFlowEvaluationCheckpointState {
    return reviewFlowEvaluationCheckpointSchema.parse(this.#state);
  }

  public openedExistingCheckpoint(): boolean {
    return this.#openedExisting;
  }

  public genesisBinding(): ReviewFlowEvaluationCheckpointGenesisBinding {
    this.assertOpen();
    return checkpointGenesisBinding(this.#state, this.#directory);
  }

  public bindGlobalClaim(claimSha256: string): void {
    this.assertOpen();
    const parsed = digestSchema.parse(claimSha256);
    if (this.#state.globalClaimSha256 === parsed) return;
    const failedOnlyOpen =
      this.#state.failedOnlyContinuation !== undefined &&
      this.#state.executionSeal === null &&
      !this.#state.entries.some((entry) => entry.status === "active");
    if (
      this.#state.globalClaimSha256 !== null ||
      (
        this.#state.entries.some((entry) => entry.status !== "pending") &&
        !failedOnlyOpen
      ) ||
      this.#state.executionSeal !== null
    ) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_GLOBAL_CLAIM_MISMATCH"
      );
    }
    this.update({ globalClaimSha256: parsed });
  }

  public pendingSafeIds(): string[] {
    return this.#state.entries.flatMap((entry) =>
      entry.status === "pending" ? [entry.safeId] : []
    );
  }

  public failedOnlyContinuationOpen(): boolean {
    return this.#state.failedOnlyContinuation !== undefined &&
      this.#state.executionSeal === null &&
      this.#state.publication === null &&
      !this.#state.entries.some((entry) => entry.status === "active");
  }

  public prepareFailedOnlySelection(
    safeIds?: readonly string[]
  ): void {
    this.assertOpen();
    if (!this.failedOnlyContinuationOpen()) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_FAILED_ONLY_NOT_RESUMABLE"
      );
    }
    const failedIds = this.#state.entries.flatMap((entry) =>
      entry.status === "failed" ? [entry.safeId] : []
    );
    const selectedIds = safeIds === undefined ? failedIds : [...safeIds];
    const failedIdSet = new Set(failedIds);
    const selectedIdSet = new Set(selectedIds);
    if (
      selectedIds.length === 0 ||
      selectedIdSet.size !== selectedIds.length ||
      selectedIds.some((safeId) => !failedIdSet.has(safeId))
    ) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_FAILED_ONLY_SELECTION_INVALID"
      );
    }
    this.update({
      entries: this.#state.entries.map((entry) =>
        entry.status === "failed" && selectedIdSet.has(entry.safeId)
          ? { safeId: entry.safeId, status: "pending" as const }
          : entry
      ),
      termination: null
    });
  }

  public hasFailedEntries(): boolean {
    return this.#state.entries.some((entry) => entry.status === "failed");
  }

  public existingCaseAttemptCount(safeId: string): number {
    const caseIndex = this.#state.entries.findIndex(
      (entry) => entry.safeId === safeId
    );
    const ledger = caseIndex < 0 || this.#state.auditLedger === null
      ? undefined
      : this.#state.auditLedger.cases[caseIndex];
    if (ledger === undefined) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_AUDIT_LEDGER_UNAVAILABLE"
      );
    }
    return ledger.attempts.length;
  }


  public terminallyContaminated(): boolean {
    return this.#state.termination !== null || this.#state.entries.some(
      (entry) => entry.status === "active" || entry.status === "failed"
    );
  }

  public startGateOpen(): boolean {
    return this.#state.termination === null && this.#state.executionSeal === null;
  }

  public markTerminationRequested(
    signal: "SIGINT" | "SIGTERM" | "SIGHUP"
  ): void {
    this.assertOpen();
    if (this.#state.termination !== null) return;
    if (this.#state.executionSeal !== null) return;
    this.update({
      termination: {
        signal,
        observedAt: this.#now().toISOString()
      }
    });
  }

  public markActive(safeId: string): void {
    if (
      this.#state.globalClaimSha256 === null ||
      !this.startGateOpen()
    ) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_START_GATE_CLOSED"
      );
    }
    this.replaceEntry(safeId, (entry) => {
      if (entry.status !== "pending") {
        throw new ReviewFlowEvaluationCheckpointError(
          "REVIEW_FLOW_EVALUATION_CASE_NOT_PENDING"
        );
      }
      return {
        safeId,
        status: "active",
        startedAt: this.#now().toISOString()
      };
    });
  }
  public recordCaseAttempt(
    safeId: string,
    attempt: ReviewFlowEvaluationCaseAttempt
  ): void {
    this.assertOpen();
    const parsed = reviewFlowEvaluationCaseAttemptSchema.parse(attempt);
    const caseIndex = this.#state.entries.findIndex(
      (entry) => entry.safeId === safeId
    );
    if (
      caseIndex < 0 ||
      this.#state.entries[caseIndex]?.status !== "active" ||
      this.#state.auditLedger === null
    ) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_AUDIT_LEDGER_UNAVAILABLE"
      );
    }
    const caseLedger = this.#state.auditLedger.cases[caseIndex];
    if (
      caseLedger === undefined ||
      parsed.attempt !== caseLedger.attempts.length + 1
    ) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_CASE_ATTEMPT_OUT_OF_ORDER"
      );
    }
    this.update({
      auditLedger: {
        schemaVersion: 1,
        cases: this.#state.auditLedger.cases.map((entry, index) =>
          index === caseIndex
            ? {
                ...entry,
                attempts: [...entry.attempts, parsed]
              }
            : entry
        )
      }
    });
  }
  public recordUnknownCaseAttempt(
    safeId: string,
    attempt: number,
    errorCode: ReviewFlowEvaluationCaseErrorCode
  ): void {
    this.recordCaseAttempt(
      safeId,
      legacyFailedCaseAttempt(attempt, {
        code: errorCode,
        failureKind: null,
        httpStatus: null,
        completedRoleCount: 0,
        failedRoleCount: 0,
        failedRoles: [],
        caseAttempts: attempt
      })
    );
  }



  public markCompleted(
    safeId: string,
    projection: z.infer<typeof reviewFlowCalibrationProjectionSchema>,
    pilotTiming?: ReviewFlowEvaluationPilotTimingReceipt,
    caseTiming?: ReviewFlowEvaluationCaseTiming
  ): void {
    const parsed = reviewFlowCalibrationProjectionSchema.parse(projection);
    this.ensureTerminalCaseAttempt(
      safeId,
      "completed",
      parsed,
      undefined
    );
    const parsedPilotTiming = pilotTiming === undefined
      ? undefined
      : reviewFlowEvaluationPilotTimingReceiptSchema.parse(pilotTiming);
    this.replaceEntry(safeId, (entry) => {
      if (entry.status !== "active") {
        throw new ReviewFlowEvaluationCheckpointError(
          "REVIEW_FLOW_EVALUATION_CASE_NOT_ACTIVE"
        );
      }
      return {
        safeId,
        status: "completed",
        completedAt: this.#now().toISOString(),
        projection: parsed,
        ...(parsedPilotTiming === undefined
          ? {}
          : { pilotTiming: parsedPilotTiming }),
        ...(caseTiming === undefined
          ? {}
          : {
              caseTiming:
                reviewFlowEvaluationCaseTimingSchema.parse(caseTiming)
            })
      };
    });
  }

  public markFailed(
    safeId: string,
    failure: ReviewFlowEvaluationFailure,
    pilotTiming?: ReviewFlowEvaluationPilotTimingReceipt
  ): void {
    const parsed = failureSchema.parse(failure);
    this.ensureTerminalCaseAttempt(
      safeId,
      "failed",
      undefined,
      parsed
    );
    const parsedPilotTiming = pilotTiming === undefined
      ? undefined
      : reviewFlowEvaluationPilotTimingReceiptSchema.parse(pilotTiming);
    this.replaceEntry(safeId, (entry) => {
      if (entry.status !== "active") {
        throw new ReviewFlowEvaluationCheckpointError(
          "REVIEW_FLOW_EVALUATION_CASE_NOT_ACTIVE"
        );
      }
      return {
        safeId,
        status: "failed",
        failedAt: this.#now().toISOString(),
        failure: parsed,
        ...(parsedPilotTiming === undefined
          ? {}
          : { pilotTiming: parsedPilotTiming })
      };
    });
  }

  public bindRepresentative3Timing(
    receipt: ReviewFlowEvaluationRepresentative3Timing
  ): void {
    this.assertOpen();
    const parsed =
      reviewFlowEvaluationRepresentative3TimingSchema.parse(receipt);
    if (
      !isReviewFlowEvaluationRepresentative3Selection(
        this.#state.identity.caseSelection
      ) ||
      this.#state.entries.some((entry) => entry.status !== "completed") ||
      this.#state.executionSeal !== null ||
      this.#state.representative3Timing !== undefined
    ) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_TIMING_INVALID"
      );
    }
    this.update({ representative3Timing: parsed });
  }

  public sealExecution(): ReviewFlowEvaluationCheckpointState {
    this.assertOpen();
    if (this.#state.globalClaimSha256 === null) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_GLOBAL_CLAIM_MISSING"
      );
    }
    if (this.#state.executionSeal !== null) return this.snapshot();
    const sealedAt = this.#now().toISOString();
    const receiptSeal = buildExecutionReceiptSeal(
      this.#state.expectedCases,
      this.#state.identity.caseSelection,
      this.#state.entries
    );
    const complete =
      this.#state.termination === null && receiptSeal.complete;
    const draft = {
      ...this.#state,
      executionSeal: {
        sealedAt,
        complete,
        completionFingerprint: executionCompletionFingerprint(this.#state)
      },
      revision: this.#state.revision + 1,
      updatedAt: sealedAt
    };
    this.#state = reviewFlowEvaluationCheckpointSchema.parse(draft);
    this.persist();
    return this.snapshot();
  }
  public writeTerminalReceipt(): ReviewFlowEvaluationTerminalReceipt {
    this.assertOpen();
    if (this.#state.executionSeal === null) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_EXECUTION_NOT_SEALED"
      );
    }
    const accounting = summarizeReviewFlowEvaluationAuditLedger(
      this.#state.auditLedger
    );
    const terminalCases = this.#state.auditLedger?.cases ?? null;
    const complete =
      this.#state.executionSeal.complete &&
      accounting.exact &&
      terminalCases !== null &&
      terminalCases.length === this.#state.expectedCases.length &&
      terminalCases.every(
        (entry) => entry.attempts.at(-1)?.outcome === "completed"
      );
    const receipt = reviewFlowEvaluationTerminalReceiptSchema.parse({
      schemaVersion: 1,
      status: complete ? "complete" : "incomplete",
      caseCount: this.#state.expectedCases.length,
      caseAttempts: terminalCases,
      accounting
    });
    const fileName = "terminal-receipt.private.json";
    const temporaryName = `${fileName}.tmp-${process.pid}-${randomUUID()}`;
    const temporaryPath = anchoredPrivatePath(this.#directory, temporaryName);
    const targetPath = anchoredPrivatePath(this.#directory, fileName);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, targetPath);
      fsyncSync(this.#directory.descriptor);
      const finalStat = lstatSync(targetPath, { bigint: true });
      const currentUid = typeof process.getuid === "function"
        ? BigInt(process.getuid())
        : finalStat.uid;
      if (
        !finalStat.isFile() ||
        finalStat.nlink !== 1n ||
        (finalStat.mode & 0o777n) !== 0o600n ||
        finalStat.uid !== currentUid
      ) {
        throw new Error("terminal receipt mode");
      }
    } catch {
      if (descriptor !== undefined) closeQuietly(descriptor);
      try {
        unlinkSync(temporaryPath);
      } catch {
        // 只清理本次随机命名的临时文件。
      }
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_TERMINAL_RECEIPT_WRITE_FAILED"
      );
    }
    return deepFreeze(receipt);
  }


  public acknowledgePublication(
    publication: Omit<ReviewFlowEvaluationPublicationBinding, "acknowledgedAt">
  ): void {
    this.assertOpen();
    if (this.#state.executionSeal === null) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_EXECUTION_NOT_SEALED"
      );
    }
    if (this.#state.publication !== null) {
      const expected = {
        ...publication,
        acknowledgedAt: this.#state.publication.acknowledgedAt
      };
      if (hashCanonicalValue(expected) === hashCanonicalValue(this.#state.publication)) {
        return;
      }
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_PUBLICATION_MISMATCH"
      );
    }
    this.update({
      publication: reviewFlowEvaluationPublicationBindingSchema.parse({
        ...publication,
        acknowledgedAt: this.#now().toISOString()
      })
    });
  }

  public close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.releaseResources();
    }
  }

  private loadStateIfPresent(): ReviewFlowEvaluationCheckpointState | null {
    try {
      const bytes = readPrivateArtifactBytes(
        this.#directory,
        this.#stateFileName,
        128 * 1024 * 1024
      );
      return reviewFlowEvaluationCheckpointSchema.parse(
        JSON.parse(bytes.toString("utf8")) as unknown
      );
    } catch (error) {
      if (
        error instanceof PhysicalBlindArtifactError &&
        error.code === "BLIND_ARTIFACT_FILE_MISSING"
      ) {
        return null;
      }
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_CHECKPOINT_INVALID"
      );
    }
  }

  private ensureTerminalCaseAttempt(
    safeId: string,
    outcome: "completed" | "failed",
    projection:
      | z.infer<typeof reviewFlowCalibrationProjectionSchema>
      | undefined,
    failure: ReviewFlowEvaluationFailure | undefined
  ): void {
    const caseIndex = this.#state.entries.findIndex(
      (entry) => entry.safeId === safeId
    );
    const caseLedger = caseIndex < 0 || this.#state.auditLedger === null
      ? undefined
      : this.#state.auditLedger.cases[caseIndex];
    if (caseLedger === undefined) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_AUDIT_LEDGER_UNAVAILABLE"
      );
    }
    const lastAttempt = caseLedger.attempts.at(-1);
    if (lastAttempt?.outcome === outcome) return;
    if (outcome === "completed" && projection !== undefined) {
      this.recordCaseAttempt(
        safeId,
        legacyCompletedCaseAttempt(caseLedger.attempts.length + 1, projection)
      );
      return;
    }
    if (outcome === "failed" && failure !== undefined) {
      this.recordCaseAttempt(
        safeId,
        legacyFailedCaseAttempt(caseLedger.attempts.length + 1, failure)
      );
      return;
    }
    throw new ReviewFlowEvaluationCheckpointError(
      "REVIEW_FLOW_EVALUATION_CASE_ATTEMPT_MISSING"
    );
  }

  private replaceEntry(
    safeId: string,
    replacement: (entry: ReviewFlowEvaluationEntry) => ReviewFlowEvaluationEntry
  ): void {
    this.assertOpen();
    if (this.#state.executionSeal !== null) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_EXECUTION_ALREADY_SEALED"
      );
    }
    const index = this.#state.entries.findIndex((entry) => entry.safeId === safeId);
    if (index < 0) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_CASE_UNKNOWN"
      );
    }
    const entries = [...this.#state.entries];
    entries[index] = replacement(entries[index]!);
    this.update({ entries });
  }

  private update(
    patch: Partial<ReviewFlowEvaluationCheckpointState>
  ): void {
    const now = this.#now().toISOString();
    this.#state = reviewFlowEvaluationCheckpointSchema.parse({
      ...this.#state,
      ...patch,
      revision: this.#state.revision + 1,
      updatedAt: now
    });
    this.persist();
  }

  private persist(): void {
    this.assertOpen();
    const temporaryName = `${this.#stateFileName}.tmp-${process.pid}-${randomUUID()}`;
    const temporaryPath = anchoredPrivatePath(this.#directory, temporaryName);
    const targetPath = anchoredPrivatePath(this.#directory, this.#stateFileName);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, `${JSON.stringify(this.#state, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, targetPath);
      fsyncSync(this.#directory.descriptor);
    } catch {
      if (descriptor !== undefined) closeQuietly(descriptor);
      try {
        unlinkSync(temporaryPath);
      } catch {
        // 只清理本次随机命名的临时文件。
      }
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_CHECKPOINT_WRITE_FAILED"
      );
    }
  }

  private acquireLock(): void {
    const temporaryName = `${this.#lockFileName}.tmp-${process.pid}-${randomUUID()}`;
    const temporaryPath = anchoredPrivatePath(this.#directory, temporaryName);
    const lockPath = anchoredPrivatePath(this.#directory, this.#lockFileName);
    let descriptor: number | undefined;
    let temporaryExists = false;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      temporaryExists = true;
      fchmodSync(descriptor, 0o600);
      const lockDocument = Buffer.from(
        `${JSON.stringify({
          schemaVersion: 1,
          processId: process.pid,
          processStartTimeTicks: readCurrentProcessStartTimeTicks(),
          acquiredAt: this.#now().toISOString(),
          recoveryRule:
            "VERIFY_PID_START_TIME_AND_PROJECT_PROCESS_BEFORE_MANUAL_REMOVAL"
        }, null, 2)}\n`,
        "utf8"
      );
      writeAll(descriptor, lockDocument);
      fsyncSync(descriptor);
      linkSync(temporaryPath, lockPath);
      this.#lockDescriptor = descriptor;
      descriptor = undefined;
      unlinkSync(temporaryPath);
      temporaryExists = false;
      fsyncSync(this.#directory.descriptor);
    } catch {
      if (descriptor !== undefined) closeQuietly(descriptor);
      if (temporaryExists) {
        try {
          unlinkSync(temporaryPath);
        } catch {
          // 不接触固定锁文件。
        }
      }
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_LOCKED_OR_UNAVAILABLE"
      );
    }
  }

  private assertOpen(): void {
    if (this.#closed) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_CHECKPOINT_CLOSED"
      );
    }
  }

  private releaseResources(): void {
    if (this.#lockDescriptor !== undefined) {
      const lockPath = anchoredPrivatePath(this.#directory, this.#lockFileName);
      try {
        const held = fstatSync(this.#lockDescriptor, { bigint: true });
        const linked = lstatSync(lockPath, { bigint: true });
        if (held.dev === linked.dev && held.ino === linked.ino && linked.isFile()) {
          unlinkSync(lockPath);
          fsyncSync(this.#directory.descriptor);
        }
      } catch {
        // 无法证明锁归属时保留锁，禁止误删另一进程的新锁。
      }
      closeQuietly(this.#lockDescriptor);
      this.#lockDescriptor = undefined;
    }
    closePrivateDirectory(this.#directory);
  }
}

function legacyCompletedCaseAttempt(
  attempt: number,
  projection: z.infer<typeof reviewFlowCalibrationProjectionSchema>
): ReviewFlowEvaluationCaseAttempt {
  const receipts = new Map(
    projection.roleReceipts.map((receipt) => [receipt.role, receipt])
  );
  const roleAttempts = reviewFlowRoleSchema.options.map((role) => {
    const receipt = receipts.get(role);
    if (receipt === undefined) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_COMPLETION_AUDIT_MISSING"
      );
    }
    const sseResponses = receipt.responses.filter(
      (response) => response.responseMode === "sse"
    );
    return {
      schemaVersion: 1 as const,
      role,
      roleStage: reviewFlowRoleStage(role),
      outcome: "completed" as const,
      errorCategory: null,
      errorCode: null,
      failureStage: null,
      failureSubstage: null,
      httpStatus: null,
      finishReason: "stop" as const,
      maxTokens: null,
      usageTotalTokens: null,
      usageComplete: false,
      responseByteCount: null,
      eofObserved: true,
      stopObserved: true,
      doneObserved: sseResponses.length === 0
        ? null
        : sseResponses.every((response) => response.sseDoneObserved === true),
      logicalRequestCount: receipt.requestCount,
      transportAttemptCount: receipt.transportAttemptCount,
      providerRequestCount: receipt.transportAttemptCount,
      retryCount: Math.max(
        0,
        receipt.transportAttemptCount - receipt.requestCount
      ),
      dependencyBlocked: false
    };
  });
  return reviewFlowEvaluationCaseAttemptSchema.parse({
    schemaVersion: 1,
    attempt,
    outcome: "completed",
    accountingComplete: false,
    errorCategory: null,
    errorCode: null,
    roleAttempts
  });
}

function legacyFailedCaseAttempt(
  attempt: number,
  failure: ReviewFlowEvaluationFailure
): ReviewFlowEvaluationCaseAttempt {
  const safeErrorCode =
    reviewFlowEvaluationCaseErrorCodeSchema.safeParse(failure.code);
  if (failure.roleAttempts !== undefined) {
    return reviewFlowEvaluationCaseAttemptSchema.parse({
      schemaVersion: 1,
      attempt,
      outcome: "failed",
      accountingComplete: true,
      errorCategory: failure.failureKind,
      errorCode: safeErrorCode.success ? safeErrorCode.data : null,
      roleAttempts: failure.roleAttempts
    });
  }
  const failures = new Map(
    failure.failedRoles.flatMap((entry) => {
      const role = reviewFlowRoleSchema.safeParse(entry.role);
      return role.success ? [[role.data, entry] as const] : [];
    })
  );
  const roleAttempts = reviewFlowRoleSchema.options.map((role) => {
    const failed = failures.get(role);
    if (failed === undefined) {
      return {
        schemaVersion: 1 as const,
        role,
        roleStage: reviewFlowRoleStage(role),
        outcome: "dependency_blocked" as const,
        errorCategory: null,
        errorCode: null,
        failureStage: null,
        failureSubstage: null,
        httpStatus: null,
        finishReason: null,
        maxTokens: null,
        usageTotalTokens: null,
        usageComplete: false,
        responseByteCount: 0,
        eofObserved: null,
        stopObserved: null,
        doneObserved: null,
        logicalRequestCount: 0,
        transportAttemptCount: 0,
        providerRequestCount: 0,
        retryCount: 0,
        dependencyBlocked: true
      };
    }
    return {
      schemaVersion: 1 as const,
      role,
      roleStage: reviewFlowRoleStage(role),
      outcome: "failed" as const,
      errorCategory: failed.failureKind,
      errorCode: null,
      failureStage: null,
      failureSubstage: null,
      httpStatus: failure.httpStatus,
      finishReason: null,
      maxTokens: null,
      usageTotalTokens: null,
      usageComplete: false,
      responseByteCount: null,
      eofObserved: null,
      stopObserved: null,
      doneObserved: null,
      logicalRequestCount: failed.requestCount,
      transportAttemptCount: failed.transportAttemptCount,
      providerRequestCount: failed.transportAttemptCount,
      retryCount: Math.max(
        0,
        failed.transportAttemptCount - failed.requestCount
      ),
      dependencyBlocked: false
    };
  });
  return reviewFlowEvaluationCaseAttemptSchema.parse({
    schemaVersion: 1,
    attempt,
    outcome: "failed",
    accountingComplete: false,
    errorCategory: failure.failureKind,
    errorCode: safeErrorCode.success ? safeErrorCode.data : null,
    roleAttempts
  });
}

function executionCompletionFingerprint(
  state: Pick<
    ReviewFlowEvaluationCheckpointState,
    | "runId"
    | "identity"
    | "identityFingerprint"
    | "expectedCases"
    | "entries"
    | "auditLedger"
    | "globalClaimSha256"
    | "termination"
    | "representative3Timing"
  >
): string {
  const receiptSeal = buildExecutionReceiptSeal(
    state.expectedCases,
    state.identity.caseSelection,
    state.entries
  );
  return hashCanonicalValue({
    protocol: "review-flow-evaluation-execution-completion-v4",
    runId: state.runId,
    identityFingerprint: state.identityFingerprint,
    expectedCases: state.expectedCases,
    entries: state.entries,
    auditLedger: state.auditLedger,
    receiptSeal,
    globalClaimSha256: state.globalClaimSha256,
    termination: state.termination,
    ...(state.representative3Timing === undefined
      ? {}
      : { representative3Timing: state.representative3Timing })
  });
}

/**
 * 封存当前 immutable case set 与固定 11-role topology 的收据摘要。
 * full32 默认 profile 仍要求 32 cases/352 receipts；selected profile 使用
 * identity 中的 selector 与 orderedSelectionSha256 绑定已选 case set。
 */
export function buildExecutionReceiptSeal(
  expectedCases: readonly ReviewFlowEvaluationExpectedCase[],
  caseSelection: ReviewFlowEvaluationIdentity["caseSelection"],
  entries: readonly ReviewFlowEvaluationEntry[]
) {
  const expectedCaseIds = expectedCases.map((entry) => entry.safeId);
  const expectedCaseCount = expectedCaseIds.length;
  const expectedRoleCountPerCase = reviewFlowRoleSchema.options.length;
  const expectedReceiptCount = expectedCaseCount * expectedRoleCountPerCase;
  const expectedRoles = reviewFlowRoleSchema.options;
  const orderedSelectionSha256 =
    reviewFlowEvaluationOrderedSelectionSha256(expectedCases);
  const selectionProfile = caseSelection === undefined
    ? { kind: "full32" as const }
    : caseSelection.selector === "private-file-v1"
      ? {
          kind: "privateSubset" as const,
          selector: caseSelection.selector,
          selectorSha256: caseSelection.selectorSha256,
          selectedCaseSetSha256: caseSelection.selectedCaseSetSha256
        }
      : {
          kind: "representative3" as const,
          selector: caseSelection.selector
        };
  const expectedIdsAreUnique =
    new Set(expectedCaseIds).size === expectedCaseIds.length;
  const selectionIsBound =
    caseSelection === undefined
      ? expectedCaseCount === 32
      : expectedCaseCount === caseSelection.selectedCaseCount &&
        caseSelection.orderedSelectionSha256 === orderedSelectionSha256 &&
        (caseSelection.selector !== "private-file-v1" ||
          caseSelection.selectedCaseSetSha256 === orderedSelectionSha256);
  const entriesMatchExpectedCases =
    entries.length === expectedCaseCount &&
    entries.every(
      (entry, index) => entry.safeId === expectedCaseIds[index]
    );
  const allEntriesCompleted = entries.every(
    (entry) => entry.status === "completed"
  );
  const receiptTuples: {
    safeId: string;
    role: string;
    receiptHash: string;
  }[] = [];
  for (const entry of entries) {
    if (entry.status !== "completed") continue;
    for (const receipt of entry.projection.roleReceipts) {
      receiptTuples.push({
        safeId: entry.safeId,
        role: receipt.role,
        receiptHash: receipt.receiptHash
      });
    }
  }
  const rolesMatchExpected = entries.every((entry) => {
    if (entry.status !== "completed") return false;
    return entry.projection.roleReceipts.length === expectedRoleCountPerCase &&
      entry.projection.roleReceipts.every(
        (receipt, index) => receipt.role === expectedRoles[index]
      );
  });
  const tuplesAreUnique =
    new Set(
      receiptTuples.map(
        (tuple) => `${tuple.safeId}|${tuple.role}|${tuple.receiptHash}`
      )
    ).size === receiptTuples.length;
  const complete =
    selectionIsBound &&
    expectedIdsAreUnique &&
    entriesMatchExpectedCases &&
    allEntriesCompleted &&
    rolesMatchExpected &&
    receiptTuples.length === expectedReceiptCount &&
    tuplesAreUnique;
  return {
    selectionProfile,
    orderedSelectionSha256,
    expectedCaseIds,
    expectedCaseCount,
    expectedRoleCountPerCase,
    expectedReceiptCount,
    actualCaseCount: entries.filter((entry) => entry.status === "completed").length,
    actualReceiptCount: receiptTuples.length,
    complete,
    receiptTuples: complete ? receiptTuples : []
  };
}

function checkpointGenesisBinding(
  state: ReviewFlowEvaluationCheckpointState,
  directory: PrivateDirectoryHandle
): ReviewFlowEvaluationCheckpointGenesisBinding {
  const status = fstatSync(directory.descriptor, { bigint: true });
  const base = {
    schemaVersion: 2 as const,
    label: state.label,
    variant: state.variant,
    purpose: state.identity.purpose,
    runId: state.runId,
    identityFingerprint: state.identityFingerprint,
    predictionIdentityFingerprint:
      reviewFlowEvaluationPredictionIdentityFingerprint(state.identity),
    expectedCasesFingerprint: hashCanonicalValue(state.expectedCases),
    stateDirectory: {
      device: status.dev.toString(10),
      inode: status.ino.toString(10)
    }
  };
  return {
    ...base,
    checkpointGenesisFingerprint: hashCanonicalValue(base)
  };
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(
      descriptor,
      bytes,
      offset,
      bytes.byteLength - offset,
      offset
    );
    if (written <= 0) {
      throw new ReviewFlowEvaluationCheckpointError(
        "REVIEW_FLOW_EVALUATION_LOCK_WRITE_FAILED"
      );
    }
    offset += written;
  }
}

function closeQuietly(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // 固定错误码，不记录路径。
  }
}

function readCurrentProcessStartTimeTicks(): string {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    const commandEnd = stat.lastIndexOf(")");
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/u);
    const value = fields[19];
    if (commandEnd < 0 || value === undefined || !/^[1-9][0-9]*$/u.test(value)) {
      throw new Error("invalid");
    }
    return value;
  } catch {
    throw new ReviewFlowEvaluationCheckpointError(
      "REVIEW_FLOW_EVALUATION_PROCESS_IDENTITY_UNAVAILABLE"
    );
  }
}
