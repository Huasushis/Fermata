/**
 * Urmotiv 历史审核 Gold -> Fermata review-flow v3 数据集的可信桥接器。
 *
 * 这个模块不解析或猜测题面/题解边界，也不调用 Anklang。人工必须先准备
 * bridge plan、逐题 task draft 与 mapping evidence；本模块只验证完整的上游
 * 哈希链、原始 XML/XLSX 输入、物化源、Gold、人工映射和原始 Anklang v2
 * complete 响应，然后以 marker-last 方式发布物理隔离的数据集。
 */
import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import {
  closePrivateDirectory,
  openExistingPrivateDirectory,
  preparePrivateDirectory,
  type PrivateDirectoryHandle
} from "../../scripts/private-runtime.mjs";
import { hashCanonicalValue } from "../../src/review-flow/evidence";
import { editorialDimensionSchema } from "../../src/review-flow/schemas";
import {
  anklangV2RequestSchema,
  anklangSimilarityReviewItemType,
  completeAnklangV2ResultSchema
} from "../../src/review-flow/task-source";
import {
  codeforcesDifficultySchema,
  difficultyLevelSchema,
  reviewVerdictSchema,
  robotAnklangPluginId,
  robotReviewTaskSchema,
  type RobotReviewTask
} from "../../src/urmotiv-schemas";
import {
  reviewFlowEvaluationBridgeCompletionFileName,
  reviewFlowEvaluationBridgeCompletionSchema,
  reviewFlowEvaluationDatasetIdSchema,
  reviewFlowEvaluationDevelopmentPredictionBindingSha256,
  reviewFlowEvaluationDigestSchema,
  reviewFlowEvaluationGoldSchema,
  reviewFlowEvaluationGeneratorDependencyFileCount,
  reviewFlowEvaluationHoldoutPredictionBindingSha256,
  reviewFlowEvaluationHoldoutRegistrationSchema,
  reviewFlowEvaluationManifestSchema,
  reviewFlowEvaluationRevealDescriptorSchema,
  reviewFlowEvaluationSafeIdSchema,
  reviewFlowEvaluationSourceLineageSetSha256,
  reviewFlowEvaluationSubjectIdSchema,
  reviewFlowEvaluationTasteReasonSchema,
  reviewFlowEvaluationTechnicalReasonSchema,
  type ReviewFlowEvaluationGold,
  type ReviewFlowEvaluationManifest,
  type ReviewFlowEvaluationPurpose
} from "./review-flow-evaluation-dataset";
import {
  readPrivateArtifactBytes,
  writePrivateArtifactExclusive
} from "./private-artifact-io";
import { reviewFlowEvaluationCodePaths } from "./review-flow-evaluation-adapter";
import {
  parsePhysicalBlindJson
} from "./physical-blind-common";
import {
  loadEvaluationCodeIdentity,
  type EvaluationCodeIdentity
} from "./evaluation-code-identity";

const bridgeVersion = "urmotiv-review-flow-bridge-v3" as const;
const manifestFileName = "manifest.private.json" as const;
const tagCatalogFileName = "tag-catalog.private.json" as const;
const revealDescriptorFileName = "reveal.private.json" as const;
const upstreamCompletionFileName = "REVIEW_GOLD_COMPLETE" as const;
const upstreamEvidenceFileName = "review-gold-evidence.private.json" as const;
const upstreamBindingsFileName = "source-bindings.private.json" as const;
const upstreamTuningAdditionsFileName =
  "tuning-history-additions.private.json" as const;
const upstreamVerifierRunnerPath =
  "scripts/migrate-hist/prepare-review-gold.py" as const;
const bridgeGeneratorRunnerPath =
  "experiments/prepare-review-flow-dataset.ts" as const;
const upstreamVerifierDependencyPaths = [
  upstreamVerifierRunnerPath,
  "scripts/migrate-hist/parse-metadata.py"
] as const;
const anklangCaptureRunnerPath =
  "scripts/capture-review-flow-calibration.py" as const;
const anklangCaptureDependencyPaths = [
  anklangCaptureRunnerPath,
  "anklang/__init__.py",
  "anklang/review_flow_capture.py",
  "anklang/contracts.py"
] as const;

const upstreamCaseIdSchema = z
  .string()
  .regex(/^case-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u);
const upstreamSubjectIdSchema = z
  .string()
  .regex(/^subject-[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$/u);
const upstreamRowIdSchema = z.string().regex(/^review-row-[0-9]{6}$/u);
const upstreamSourceIdSchema = z.string().regex(/^source-[0-9]{6}$/u);
const upstreamInputIdSchema = z.string().regex(/^input-[0-9]{6}$/u);
const upstreamWorksheetIdSchema = z.string().regex(/^worksheet-[0-9]{6}$/u);
const upstreamSourcePathSchema = z
  .string()
  .regex(/^source-[0-9]{6}\.(?:md|txt)$/iu);
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
    "PRIVATE_FILE_NAME_INVALID"
  );
const fileBindingSchema = z
  .object({
    fileName: privateFileNameSchema,
    sha256: reviewFlowEvaluationDigestSchema
  })
  .strict();

const captureIdSchema = z.string().regex(/^capture-[0-9a-f]{16}$/u);
const captureTimestampSchema = z
  .string()
  .datetime({ offset: false })
  .refine((value) => value.endsWith("Z"), "CAPTURE_TIME_MUST_BE_UTC");
const anklangCaptureCaseSchema = z
  .object({
    caseId: upstreamCaseIdSchema,
    requestId: z.string().uuid(),
    requestSha256: reviewFlowEvaluationDigestSchema,
    responseSha256: reviewFlowEvaluationDigestSchema,
    httpStatus: z.literal(200),
    attempt: z.literal(1),
    responseCompletionStatus: z.literal("complete")
  })
  .strict();
const anklangCaptureCorpusSchema = z.discriminatedUnion("evidenceKind", [
  z
    .object({
      evidenceKind: z.literal("reproducible_snapshot"),
      corpusId: z.string().min(1).max(160),
      manifestSha256: reviewFlowEvaluationDigestSchema,
      snapshotSha256: reviewFlowEvaluationDigestSchema,
      corpusRevisionSha256: reviewFlowEvaluationDigestSchema,
      problemCount: z.number().int().positive().max(100_000_000)
    })
    .strict(),
  z
    .object({
      evidenceKind: z.literal("remote_corpus_unverifiable"),
      serviceOriginSha256: reviewFlowEvaluationDigestSchema,
      declarationSha256: reviewFlowEvaluationDigestSchema
    })
    .strict()
]);
const anklangCaptureAttestationWithoutFingerprintSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal("anklang_review_flow_capture_attestation"),
    protocolVersion: z.literal("anklang-review-flow-capture-v1"),
    captureStatus: z.literal("complete"),
    captureId: captureIdSchema,
    capturedAt: captureTimestampSchema,
    capturer: z
      .object({
        repository: z.literal("Anklang"),
        codeVersion: z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/u),
        runnerPath: z.literal(anklangCaptureRunnerPath),
        runnerSha256: reviewFlowEvaluationDigestSchema,
        dependencyCodeSha256: reviewFlowEvaluationDigestSchema,
        dependencyFileCount: z.literal(4)
      })
      .strict(),
    configuration: z
      .object({
        apiVersion: z.literal("2"),
        endpointPath: z.literal("/api/v2/checks/similarity"),
        baseUrlSha256: reviewFlowEvaluationDigestSchema,
        timeoutMs: z.number().int().min(1_000).max(600_000),
        authentication: z.enum(["bearer_redacted", "none"]),
        secretsExcluded: z.literal(true)
      })
      .strict(),
    backend: z
      .object({
        kind: z.enum(["local_engine", "reverse_proxy"]),
        configurationSha256: reviewFlowEvaluationDigestSchema,
        secretsExcluded: z.literal(true)
      })
      .strict(),
    corpus: anklangCaptureCorpusSchema,
    cases: z.array(anklangCaptureCaseSchema).min(1).max(2_000),
    counts: z
      .object({
        caseCount: z.number().int().positive().max(2_000),
        requestCount: z.number().int().positive().max(2_000),
        responseCount: z.number().int().positive().max(2_000),
        http200Count: z.number().int().positive().max(2_000),
        attemptCount: z.number().int().positive().max(2_000),
        completeResponseCount: z.number().int().positive().max(2_000),
        failureCount: z.literal(0)
      })
      .strict()
  })
  .strict()
  .superRefine((attestation, context) => {
    const expectedEvidence = attestation.backend.kind === "local_engine"
      ? "reproducible_snapshot"
      : "remote_corpus_unverifiable";
    if (attestation.corpus.evidenceKind !== expectedEvidence) {
      context.addIssue({
        code: "custom",
        path: ["corpus", "evidenceKind"],
        message: "ANKLANG_CAPTURE_CORPUS_BACKEND_MISMATCH"
      });
    }
  });
export const reviewFlowEvaluationAnklangCaptureAttestationSchema =
  anklangCaptureAttestationWithoutFingerprintSchema
    .extend({ captureFingerprint: reviewFlowEvaluationDigestSchema })
    .strict();
export const reviewFlowEvaluationAnklangCaptureCompletionSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal("anklang_review_flow_capture_completion"),
    protocolVersion: z.literal("anklang-review-flow-capture-v1"),
    captureId: captureIdSchema,
    attestationSha256: reviewFlowEvaluationDigestSchema,
    captureSetSha256: reviewFlowEvaluationDigestSchema,
    caseCount: z.number().int().positive().max(2_000),
    requestCount: z.number().int().positive().max(2_000),
    responseCount: z.number().int().positive().max(2_000),
    http200Count: z.number().int().positive().max(2_000),
    attemptCount: z.number().int().positive().max(2_000),
    completeResponseCount: z.number().int().positive().max(2_000),
    failureCount: z.literal(0),
    complete: z.literal(true)
  })
  .strict();

const upstreamCompletionSchema = z
  .object({
    version: z.literal(1),
    phase: z.literal("historical_review_gold_evidence"),
    evidenceSha256: reviewFlowEvaluationDigestSchema,
    sourceBindingsSha256: reviewFlowEvaluationDigestSchema,
    tuningHistorySha256: reviewFlowEvaluationDigestSchema,
    tuningHistoryAdditionsSha256: reviewFlowEvaluationDigestSchema,
    planSha256: reviewFlowEvaluationDigestSchema,
    goldSetSha256: reviewFlowEvaluationDigestSchema,
    caseCount: z.number().int().positive().max(10_000),
    developmentCount: z.number().int().positive().max(10_000),
    holdoutCount: z.number().int().nonnegative().max(10_000),
    verdictAndTasteCount: z.number().int().nonnegative().max(10_000),
    originalityOnlyCount: z.number().int().nonnegative().max(10_000)
  })
  .strict();

const upstreamEvidenceEntrySchema = z
  .object({
    caseId: upstreamCaseIdSchema,
    purpose: z.enum(["development", "holdout"]),
    evaluationScope: z.enum(["verdict_and_taste", "originality_only"]),
    materializedSourceSha256: reviewFlowEvaluationDigestSchema,
    goldFile: z
      .string()
      .regex(/^gold\/case-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?\.json$/u),
    goldSha256: reviewFlowEvaluationDigestSchema
  })
  .strict();
const upstreamEvidenceSchema = z
  .object({
    version: z.literal(1),
    artifactKind: z.literal("historical_review_gold_evidence"),
    datasetId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
    entries: z.array(upstreamEvidenceEntrySchema).min(1).max(10_000)
  })
  .strict();

const upstreamBindingCaseSchema = z
  .object({
    caseId: upstreamCaseIdSchema,
    subjectId: upstreamSubjectIdSchema,
    sourceId: upstreamSourceIdSchema,
    sourcePath: upstreamSourcePathSchema,
    sourceSha256: reviewFlowEvaluationDigestSchema,
    rowEvidenceSha256: reviewFlowEvaluationDigestSchema
  })
  .strict();
const upstreamBindingsSchema = z
  .object({
    version: z.literal(1),
    sourceConfirmationSha256: reviewFlowEvaluationDigestSchema,
    materializationCompleteSha256: reviewFlowEvaluationDigestSchema,
    worksheetSha256: reviewFlowEvaluationDigestSchema,
    cases: z.array(upstreamBindingCaseSchema).min(1).max(10_000)
  })
  .strict();

const upstreamGoldCommon = {
  version: z.literal(2),
  artifactKind: z.literal("historical_review_gold"),
  caseId: upstreamCaseIdSchema,
  reviewCommentPresent: z.boolean()
} as const;
const upstreamGoldSchema = z.discriminatedUnion("evaluationScope", [
  z
    .object({
      ...upstreamGoldCommon,
      evaluationScope: z.literal("verdict_and_taste"),
      verdict: z.enum(["accepted", "rejected"]),
      contestUse: z.enum(["used", "not_used", "unknown"])
    })
    .strict(),
  z
    .object({
      ...upstreamGoldCommon,
      evaluationScope: z.literal("originality_only"),
      sameProblemAsExisting: z.literal(true)
    })
    .strict()
]);

const upstreamPlanCommon = {
  caseId: upstreamCaseIdSchema,
  subjectId: upstreamSubjectIdSchema,
  rowId: upstreamRowIdSchema,
  sourceId: upstreamSourceIdSchema,
  sourceSha256: reviewFlowEvaluationDigestSchema,
  purpose: z.enum(["development", "holdout"]),
  confirmed: z.literal(true)
} as const;
const upstreamPlanCaseSchema = z.discriminatedUnion("evaluationScope", [
  z
    .object({
      ...upstreamPlanCommon,
      evaluationScope: z.literal("verdict_and_taste"),
      verdict: z.enum(["accepted", "rejected"]),
      contestUse: z.enum(["used", "not_used", "unknown"])
    })
    .strict(),
  z
    .object({
      ...upstreamPlanCommon,
      evaluationScope: z.literal("originality_only"),
      sameProblemAsExisting: z.literal(true)
    })
    .strict()
]);
const upstreamPlanSchema = z
  .object({
    version: z.literal(3),
    confirmed: z.literal(true),
    submitterDifficultyColumnsExcludedReconfirmed: z.literal(true),
    datasetId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
    worksheetSha256: reviewFlowEvaluationDigestSchema,
    sourceConfirmationSha256: reviewFlowEvaluationDigestSchema,
    cases: z.array(upstreamPlanCaseSchema).min(1).max(10_000)
  })
  .strict();

const upstreamTuningHistorySchema = z
  .object({
    version: z.literal(1),
    confirmedComplete: z.literal(true),
    developmentSamples: z
      .array(
        z
          .object({
            subjectId: upstreamSubjectIdSchema,
            contentSha256: reviewFlowEvaluationDigestSchema
          })
          .strict()
      )
      .max(100_000)
  })
  .strict();
const upstreamTuningAdditionsSchema = z
  .object({
    version: z.literal(1),
    priorTuningHistorySha256: reviewFlowEvaluationDigestSchema,
    developmentSamples: z
      .array(
        z
          .object({
            subjectId: upstreamSubjectIdSchema,
            contentSha256: reviewFlowEvaluationDigestSchema
          })
          .strict()
      )
      .max(10_000)
  })
  .strict();

const inspectionWorksheetSchema = z
  .object({
    worksheetId: upstreamWorksheetIdSchema,
    presentRowCount: z.number().int().positive().max(10_000),
    maximumRowNumber: z.number().int().positive().max(10_000),
    maximumColumnNumber: z.number().int().nonnegative().max(512)
  })
  .strict();
const inspectionInputSchema = z
  .object({
    inputId: upstreamInputIdSchema,
    inputSha256: reviewFlowEvaluationDigestSchema,
    format: z.enum(["xlsx", "spreadsheetml_xml"]),
    worksheets: z.array(inspectionWorksheetSchema).length(1)
  })
  .strict();
const upstreamInspectionSchema = z
  .object({
    version: z.literal(1),
    inputSetSha256: reviewFlowEvaluationDigestSchema,
    inputs: z.array(inspectionInputSchema).min(1).max(2)
  })
  .strict();

const worksheetRowSchema = z
  .object({
    rowId: upstreamRowIdSchema,
    inputId: upstreamInputIdSchema,
    worksheetId: upstreamWorksheetIdSchema,
    sourceRowNumber: z.number().int().positive().max(10_000),
    metadataNumber: z.string().max(2_000),
    identityValues: z.array(z.string().max(2_000)).min(1).max(8),
    finalDecisionText: z.string().max(2_000),
    contestUseText: z.string().max(2_000),
    reviewComments: z.array(z.string().max(100_000)).min(1).max(32),
    reviewCommentPresent: z.boolean(),
    rowEvidenceSha256: reviewFlowEvaluationDigestSchema
  })
  .strict();
const worksheetSourceSchema = z
  .object({
    sourceId: upstreamSourceIdSchema,
    sourcePath: upstreamSourcePathSchema,
    sourceSha256: reviewFlowEvaluationDigestSchema,
    metadataNumber: z.string().max(2_000)
  })
  .strict();
const upstreamWorksheetSchema = z
  .object({
    version: z.literal(1),
    inputSetSha256: reviewFlowEvaluationDigestSchema,
    inspectionFileSha256: reviewFlowEvaluationDigestSchema,
    layoutFileSha256: reviewFlowEvaluationDigestSchema,
    sourceConfirmationSha256: reviewFlowEvaluationDigestSchema,
    materializationCompleteSha256: reviewFlowEvaluationDigestSchema,
    rows: z.array(worksheetRowSchema).min(1).max(10_000),
    sources: z.array(worksheetSourceSchema).min(1).max(10_000)
  })
  .strict();

const materializationConfirmationSchema = z
  .object({
    version: z.literal(1),
    confirmed: z.literal(true),
    metadataFileSha256: reviewFlowEvaluationDigestSchema,
    mappings: z
      .array(
        z
          .object({
            sourcePath: upstreamSourcePathSchema,
            sourceSha256: reviewFlowEvaluationDigestSchema,
            metadataNumber: z.string().min(1).max(2_000)
          })
          .strict()
      )
      .min(1)
      .max(10_000)
  })
  .strict();
const materializationCompletionSchema = z
  .object({
    version: z.literal(2),
    phase: z.literal("materialize"),
    reportSha256: reviewFlowEvaluationDigestSchema,
    sourceConfirmationSha256: reviewFlowEvaluationDigestSchema,
    sourceSetSha256: reviewFlowEvaluationDigestSchema,
    groupingBatchSha256: reviewFlowEvaluationDigestSchema,
    sourceCount: z.number().int().positive().max(10_000),
    fragmentCount: z.number().int().nonnegative(),
    unresolvedItemCount: z.literal(0)
  })
  .strict();

const materializationReportSourceSchema = z
  .object({
    groupId: z.string().regex(/^group-[0-9]{6}$/u),
    sourceId: upstreamSourceIdSchema,
    sourceSha256: reviewFlowEvaluationDigestSchema,
    fragmentCount: z.number().int().positive(),
    byteLength: z.number().int().positive().max(2_000_000),
    characterCount: z.number().int().positive().max(500_000),
    status: z.literal("ready_for_prepare")
  })
  .strict();
const materializationReportSchema = z
  .object({
    version: z.literal(2),
    phase: z.literal("materialize"),
    sourceInventorySha256: reviewFlowEvaluationDigestSchema,
    groupingBatchSha256: reviewFlowEvaluationDigestSchema,
    fragmentCount: z.number().int().nonnegative(),
    sourceCount: z.number().int().positive().max(10_000),
    unresolvedItemCount: z.literal(0),
    sources: z.array(materializationReportSourceSchema).min(1).max(10_000)
  })
  .strict();

const reviewWorksheetCompletionSchema = z
  .object({
    version: z.literal(1),
    phase: z.literal("review_gold_worksheet"),
    worksheetSha256: reviewFlowEvaluationDigestSchema,
    planSkeletonSha256: reviewFlowEvaluationDigestSchema,
    tuningHistorySkeletonSha256: reviewFlowEvaluationDigestSchema,
    rowCount: z.number().int().positive().max(10_000),
    sourceCount: z.number().int().positive().max(10_000),
    reviewCommentRowCount: z.number().int().nonnegative().max(10_000)
  })
  .strict();

const judgeScoringModeSchema = z.enum(["sum", "min", "max"]);
const problemFilePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path.split("/").every(
        (segment) => segment.length > 0 && segment !== "." && segment !== ".."
      ),
    "PROBLEM_FILE_PATH_INVALID"
  );
const judgeProgramSchema = z.object({ source: problemFilePathSchema }).strict();
const judgeCheckerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("standard") }).strict(),
  z
    .object({ type: z.literal("special"), source: problemFilePathSchema })
    .strict()
]);
const storedJudgeConfigSchema = z
  .object({
    version: z.literal(1),
    limits: z
      .object({
        timeMs: z.number().int().positive().max(600_000),
        memoryMiB: z.number().int().positive().max(262_144)
      })
      .strict(),
    scoring: z
      .object({
        total: z.number().int().positive().max(100_000),
        subtaskMode: judgeScoringModeSchema
      })
      .strict(),
    subtasks: z
      .array(
        z
          .object({
            id: z.number().int().nonnegative(),
            score: z.number().int().nonnegative(),
            method: judgeScoringModeSchema,
            dependsOn: z.array(z.number().int().nonnegative()).max(1_000)
          })
          .strict()
      )
      .max(1_000),
    testcases: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(120),
            input: problemFilePathSchema,
            output: problemFilePathSchema.optional(),
            subtaskId: z.number().int().nonnegative().optional(),
            score: z.number().int().nonnegative(),
            timeMs: z.number().int().positive().max(600_000).optional(),
            memoryMiB: z.number().int().positive().max(262_144).optional()
          })
          .strict()
      )
      .max(10_000),
    checker: judgeCheckerSchema.optional(),
    interactor: judgeProgramSchema.optional(),
    answerChecker: judgeProgramSchema.optional()
  })
  .strict();
export const reviewFlowEvaluationProblemHashInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal("urmotiv_problem_content_hash_input"),
    title: robotReviewTaskSchema.shape.problem.shape.title,
    type: robotReviewTaskSchema.shape.problem.shape.type,
    tagIds: robotReviewTaskSchema.shape.problem.shape.tagIds,
    codeforcesDifficulty: codeforcesDifficultySchema.nullable(),
    thinkingLevel: difficultyLevelSchema.nullable(),
    codingLevel: difficultyLevelSchema.nullable(),
    content: robotReviewTaskSchema.shape.problem.shape.content,
    samples: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            input: z.string().max(100_000),
            output: z.string().max(100_000),
            explanation: z.string().max(500_000)
          })
          .strict()
      )
      .max(50),
    judgeConfig: storedJudgeConfigSchema.nullable(),
    status: z.literal("pending_review")
  })
  .strict();

const attestationReviewInputSchema = z
  .object({
    inputId: upstreamInputIdSchema,
    format: z.enum(["xlsx", "spreadsheetml_xml"]),
    inputSha256: reviewFlowEvaluationDigestSchema
  })
  .strict();
const attestationCaseSchema = z
  .object({
    caseId: upstreamCaseIdSchema,
    subjectId: upstreamSubjectIdSchema,
    purpose: z.enum(["development", "holdout"]),
    evaluationScope: z.enum(["verdict_and_taste", "originality_only"]),
    sourceId: upstreamSourceIdSchema,
    sourcePath: upstreamSourcePathSchema,
    sourceSha256: reviewFlowEvaluationDigestSchema,
    rowEvidenceSha256: reviewFlowEvaluationDigestSchema,
    goldSha256: reviewFlowEvaluationDigestSchema
  })
  .strict();
const attestationVerifierSchema = z
  .object({
    repository: z.literal("Urmotiv"),
    codeVersion: z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/u),
    runnerPath: z.literal(upstreamVerifierRunnerPath),
    runnerSha256: reviewFlowEvaluationDigestSchema,
    dependencyCodeSha256: reviewFlowEvaluationDigestSchema,
    dependencyFileCount: z.literal(2)
  })
  .strict();
const attestationArtifactSchema = z
  .object({
    reviewGoldCompleteSha256: reviewFlowEvaluationDigestSchema,
    evidenceSha256: reviewFlowEvaluationDigestSchema,
    sourceBindingsSha256: reviewFlowEvaluationDigestSchema,
    tuningHistorySha256: reviewFlowEvaluationDigestSchema,
    tuningHistoryAdditionsSha256: reviewFlowEvaluationDigestSchema,
    planSha256: reviewFlowEvaluationDigestSchema,
    worksheetSha256: reviewFlowEvaluationDigestSchema,
    worksheetCompletionSha256: reviewFlowEvaluationDigestSchema,
    inspectionSha256: reviewFlowEvaluationDigestSchema,
    layoutSha256: reviewFlowEvaluationDigestSchema,
    inputSetSha256: reviewFlowEvaluationDigestSchema,
    sourceConfirmationCanonicalSha256: reviewFlowEvaluationDigestSchema,
    materializationCompleteSha256: reviewFlowEvaluationDigestSchema,
    materializationReportCanonicalSha256: reviewFlowEvaluationDigestSchema,
    materializationSourceSetSha256: reviewFlowEvaluationDigestSchema
  })
  .strict();
const attestationCountsSchema = z
  .object({
    caseCount: z.number().int().positive().max(10_000),
    developmentCount: z.number().int().positive().max(10_000),
    holdoutCount: z.number().int().nonnegative().max(10_000),
    verdictAndTasteCount: z.number().int().nonnegative().max(10_000),
    originalityOnlyCount: z.number().int().nonnegative().max(10_000),
    reviewInputCount: z.number().int().positive().max(2),
    materializedSourceCount: z.number().int().positive().max(10_000)
  })
  .strict();
const attestationWithoutFingerprintSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal("urmotiv_review_gold_verification_attestation"),
    protocolVersion: z.literal("urmotiv-review-gold-verify-sealed-v1"),
    verificationStatus: z.literal("complete"),
    upstreamDatasetId: upstreamEvidenceSchema.shape.datasetId,
    verifier: attestationVerifierSchema,
    artifacts: attestationArtifactSchema,
    reviewInputs: z.array(attestationReviewInputSchema).min(1).max(2),
    cases: z.array(attestationCaseSchema).min(1).max(10_000),
    counts: attestationCountsSchema
  })
  .strict();
export const reviewFlowEvaluationUpstreamAttestationSchema =
  attestationWithoutFingerprintSchema
    .extend({
      verificationFingerprint: reviewFlowEvaluationDigestSchema
    })
    .strict();

const tagCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.number().int().positive(),
    tags: robotReviewTaskSchema.shape.tagCatalog.shape.tags
  })
  .strict();

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
const independentDifficultySchema = z
  .object({
    annotation: z.literal("independent_human_without_submitter_metadata"),
    codeforcesDifficulty: codeforcesDifficultySchema,
    thinkingLevel: difficultyLevelSchema,
    codingLevel: difficultyLevelSchema
  })
  .strict();

const mappingCommon = {
  schemaVersion: z.literal(1),
  artifactKind: z.literal("review_flow_evaluation_human_mapping"),
  confirmed: z.literal(true),
  caseId: upstreamCaseIdSchema,
  safeId: reviewFlowEvaluationSafeIdSchema,
  subjectId: reviewFlowEvaluationSubjectIdSchema,
  purpose: z.enum(["development", "holdout"]),
  sourceId: upstreamSourceIdSchema,
  sourceSha256: reviewFlowEvaluationDigestSchema,
  rowEvidenceSha256: reviewFlowEvaluationDigestSchema,
  reviewInputId: upstreamInputIdSchema,
  worksheetId: upstreamWorksheetIdSchema,
  sourceRowNumber: z.number().int().positive().max(10_000),
  taskDraftSha256: reviewFlowEvaluationDigestSchema,
  problemHashInputSha256: reviewFlowEvaluationDigestSchema,
  problemContentHash: reviewFlowEvaluationDigestSchema,
  statementSolutionBoundary: z.literal(
    "independently_human_confirmed_from_materialized_source"
  )
} as const;
export const reviewFlowEvaluationHumanMappingSchema = z.discriminatedUnion(
  "evaluationScope",
  [
    z
      .object({
        ...mappingCommon,
        evaluationScope: z.literal("verdict_and_taste"),
        historicalReviewReasonMapping: z.literal(
          "independently_human_confirmed_from_bound_review_row"
        ),
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
        independentDifficulty: independentDifficultySchema.optional()
      })
      .strict(),
    z
      .object({
        ...mappingCommon,
        evaluationScope: z.literal("originality_only"),
        originalityAnnotation: z.literal("confirmed_duplicate_evidence"),
        confirmedDuplicate: z.literal(true)
      })
      .strict()
  ]
);

const bridgePlanCaseSchema = z
  .object({
    caseId: upstreamCaseIdSchema,
    safeId: reviewFlowEvaluationSafeIdSchema,
    subjectId: reviewFlowEvaluationSubjectIdSchema,
    purpose: z.enum(["development", "holdout"]),
    sourceId: upstreamSourceIdSchema,
    sourceSha256: reviewFlowEvaluationDigestSchema,
    rowEvidenceSha256: reviewFlowEvaluationDigestSchema,
    taskDraft: fileBindingSchema,
    problemHashInput: fileBindingSchema,
    originalAnklangRequest: fileBindingSchema,
    originalAnklangResponse: fileBindingSchema,
    humanMapping: fileBindingSchema
  })
  .strict();
export const reviewFlowEvaluationBridgePlanSchema = z
  .object({
    schemaVersion: z.literal(3),
    artifactKind: z.literal("review_flow_evaluation_bridge_plan"),
    bridgeVersion: z.literal(bridgeVersion),
    confirmed: z.literal(true),
    upstreamDatasetId: upstreamEvidenceSchema.shape.datasetId,
    datasetId: reviewFlowEvaluationDatasetIdSchema,
    tagCatalog: fileBindingSchema,
    upstreamVerificationAttestation: fileBindingSchema,
    anklangCaptureAttestation: fileBindingSchema,
    anklangCaptureCompletion: fileBindingSchema,
    holdoutRegistration: reviewFlowEvaluationHoldoutRegistrationSchema.nullable(),
    cases: z.array(bridgePlanCaseSchema).min(1).max(2_000)
  })
  .strict()
  .superRefine((plan, context) => {
    const developmentCount = plan.cases.filter(
      (entry) => entry.purpose === "development"
    ).length;
    const holdoutCount = plan.cases.length - developmentCount;
    if (developmentCount === 0) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "BRIDGE_DEVELOPMENT_EMPTY"
      });
    }
    if ((holdoutCount > 0) !== (plan.holdoutRegistration !== null)) {
      context.addIssue({
        code: "custom",
        path: ["holdoutRegistration"],
        message: "BRIDGE_HOLDOUT_REGISTRATION_MISMATCH"
      });
    }
    for (const selector of [
      (entry: z.infer<typeof bridgePlanCaseSchema>) => entry.caseId,
      (entry: z.infer<typeof bridgePlanCaseSchema>) => entry.safeId,
      (entry: z.infer<typeof bridgePlanCaseSchema>) => entry.subjectId,
      (entry: z.infer<typeof bridgePlanCaseSchema>) => entry.sourceId,
      (entry: z.infer<typeof bridgePlanCaseSchema>) => entry.sourceSha256,
      (entry: z.infer<typeof bridgePlanCaseSchema>) => entry.rowEvidenceSha256,
      (entry: z.infer<typeof bridgePlanCaseSchema>) => entry.taskDraft.sha256,
      (entry: z.infer<typeof bridgePlanCaseSchema>) =>
        entry.problemHashInput.sha256,
      (entry: z.infer<typeof bridgePlanCaseSchema>) =>
        entry.originalAnklangRequest.sha256,
      (entry: z.infer<typeof bridgePlanCaseSchema>) =>
        entry.originalAnklangResponse.sha256,
      (entry: z.infer<typeof bridgePlanCaseSchema>) => entry.humanMapping.sha256
    ]) {
      if (new Set(plan.cases.map(selector)).size !== plan.cases.length) {
        context.addIssue({
          code: "custom",
          path: ["cases"],
          message: "BRIDGE_CASE_IDENTITY_DUPLICATE"
        });
      }
    }
  });

export type ReviewFlowEvaluationBridgePlan = z.infer<
  typeof reviewFlowEvaluationBridgePlanSchema
>;

export type ReviewFlowEvaluationBridgeStage =
  | "development_gold"
  | "development_reveal"
  | "holdout_gold"
  | "holdout_reveal"
  | "tag_catalog"
  | "content"
  | "manifest"
  | "completion";

export interface ReviewFlowEvaluationBridgeHooks {
  readonly afterArtifactWrite?: (
    stage: ReviewFlowEvaluationBridgeStage,
    fileName: string
  ) => void;
  readonly beforeCompletionMarker?: () => void;
}

export interface PrepareReviewFlowEvaluationBridgeInput {
  readonly privateRoot: string;
  readonly containingWorkspace: string;
  readonly fermataCodeVersion: string;
  readonly bridgePlanPath: string;
  readonly upstreamGoldDirectory: string;
  readonly materializedDirectory: string;
  readonly worksheetPath: string;
  readonly worksheetCompletionPath: string;
  readonly inspectionPath: string;
  readonly layoutPath: string;
  readonly upstreamPlanPath: string;
  readonly tuningHistoryPath: string;
  readonly reviewInputPaths: readonly string[];
  readonly outputDirectory: string;
  readonly developmentRevealDirectory: string;
  readonly holdoutRevealDirectory?: string;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly hooks?: ReviewFlowEvaluationBridgeHooks;
}

export interface PreparedReviewFlowEvaluationBridge {
  readonly datasetId: string;
  readonly manifestPath: string;
  readonly developmentRevealDescriptorPath: string;
  readonly holdoutRevealDescriptorPath: string | null;
  readonly caseCount: number;
  readonly developmentCount: number;
  readonly holdoutCount: number;
}

export class ReviewFlowEvaluationBridgeError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(code);
    this.name = "ReviewFlowEvaluationBridgeError";
    this.code = code;
  }
}

interface LoadedAbsoluteFile<T> {
  readonly bytes: Buffer;
  readonly value: T;
  readonly sha256: string;
}

type BridgeGeneratorIdentity = Readonly<Pick<
  EvaluationCodeIdentity,
  | "codeVersion"
  | "runnerSha256"
  | "dependencyCodeSha256"
  | "dependencyFileCount"
>>;

interface ValidatedUpstreamCase {
  readonly plan: z.infer<typeof upstreamPlanCaseSchema>;
  readonly evidence: z.infer<typeof upstreamEvidenceEntrySchema>;
  readonly binding: z.infer<typeof upstreamBindingCaseSchema>;
  readonly gold: z.infer<typeof upstreamGoldSchema>;
  readonly goldSha256: string;
  readonly row: z.infer<typeof worksheetRowSchema>;
  readonly source: z.infer<typeof worksheetSourceSchema>;
  readonly sourceBytes: Buffer;
}

interface ValidatedUpstream {
  readonly markerSha256: string;
  readonly evidenceSha256: string;
  readonly bindingsSha256: string;
  readonly tuningHistoryAdditionsSha256: string;
  readonly planSha256: string;
  readonly tuningHistorySha256: string;
  readonly worksheetSha256: string;
  readonly worksheetCompletionSha256: string;
  readonly inspectionSha256: string;
  readonly layoutSha256: string;
  readonly inputSetSha256: string;
  readonly reviewInputs: readonly {
    readonly inputId: string;
    readonly format: "xlsx" | "spreadsheetml_xml";
    readonly sha256: string;
  }[];
  readonly sourceConfirmationSha256: string;
  readonly materializationCompleteSha256: string;
  readonly materializationReportCanonicalSha256: string;
  readonly materializationSourceSetSha256: string;
  readonly materializedSourceCount: number;
  readonly counts: z.infer<typeof attestationCountsSchema>;
  readonly datasetId: string;
  readonly cases: readonly ValidatedUpstreamCase[];
}

interface PreparedCase {
  readonly purpose: ReviewFlowEvaluationPurpose;
  readonly safeId: string;
  readonly subjectId: string;
  readonly sourceLineageSha256: string;
  readonly originalAnklangResponseSha256: string;
  readonly contentFileName: string;
  readonly contentBytes: Buffer;
  readonly contentSha256: string;
  readonly originalAnklangRequestSha256: string;
  readonly goldFileName: string;
  readonly goldBytes: Buffer;
  readonly goldSha256: string;
  readonly rowEvidenceSha256: string;
  readonly sealedEvidenceSha256: string;
  readonly bridgeEvidence: ReviewFlowEvaluationGold["upstreamEvidence"]["bridgeEvidence"];
}

interface ValidatedAnklangCapture {
  readonly attestationSha256: string;
  readonly completionSha256: string;
  readonly corpusEvidenceKind:
    | "reproducible_snapshot"
    | "remote_corpus_unverifiable";
  readonly cases: ReadonlyMap<
    string,
    z.infer<typeof anklangCaptureCaseSchema>
  >;
}

/**
 * 完整验证所有既有输入后才创建输出目录。失败目录不续写、不覆盖；完成标记永远最后写。
 */
export function prepareReviewFlowEvaluationDatasetBridge(
  input: PrepareReviewFlowEvaluationBridgeInput
): PreparedReviewFlowEvaluationBridge {
  try {
    return prepareBridge(input);
  } catch (error) {
    if (error instanceof ReviewFlowEvaluationBridgeError) throw error;
    throw new ReviewFlowEvaluationBridgeError(
      "REVIEW_FLOW_EVALUATION_BRIDGE_INPUT_INVALID"
    );
  }
}

function prepareBridge(
  input: PrepareReviewFlowEvaluationBridgeInput
): PreparedReviewFlowEvaluationBridge {
  assertBridgePaths(input);
  const generatorIdentity = loadBridgeGeneratorIdentity(input);
  const generator = bridgeGeneratorBinding(generatorIdentity);
  const bridgePlanFile = readAbsoluteJson(
    input.bridgePlanPath,
    reviewFlowEvaluationBridgePlanSchema,
    input,
    4 * 1024 * 1024,
    "REVIEW_FLOW_EVALUATION_BRIDGE_PLAN_INVALID"
  );
  const bridgePlan = bridgePlanFile.value;
  const upstream = validateUpstream(input);
  if (bridgePlan.upstreamDatasetId !== upstream.datasetId) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_UPSTREAM_MISMATCH");
  }

  const bridgeInputDirectory = openExistingPrivateDirectory(
    dirname(input.bridgePlanPath),
    runtimeOptions(input)
  );
  let output: PrivateDirectoryHandle | undefined;
  let developmentReveal: PrivateDirectoryHandle | undefined;
  let holdoutReveal: PrivateDirectoryHandle | undefined;
  try {
    const attestationBytes = readBoundInput(
      bridgeInputDirectory,
      bridgePlan.upstreamVerificationAttestation,
      10 * 1024 * 1024,
      "REVIEW_FLOW_EVALUATION_BRIDGE_ATTESTATION_INVALID"
    );
    const attestation = parseStrict(
      attestationBytes,
      reviewFlowEvaluationUpstreamAttestationSchema,
      "REVIEW_FLOW_EVALUATION_BRIDGE_ATTESTATION_INVALID"
    );
    validateUpstreamAttestation({
      attestation,
      attestationBytes,
      upstream,
      input,
      verifierRepositoryDirectory: resolve(
        input.containingWorkspace,
        "Urmotiv"
      )
    });
    const tagCatalogBytes = readBoundInput(
      bridgeInputDirectory,
      bridgePlan.tagCatalog,
      4 * 1024 * 1024,
      "REVIEW_FLOW_EVALUATION_BRIDGE_TAG_CATALOG_INVALID"
    );
    const tagCatalog = parseStrict(
      tagCatalogBytes,
      tagCatalogSchema,
      "REVIEW_FLOW_EVALUATION_BRIDGE_TAG_CATALOG_INVALID"
    );
    const anklangCapture = loadAnklangCapture({
      plan: bridgePlan,
      inputDirectory: bridgeInputDirectory,
      input
    });
    const upstreamByCase = uniqueMap(
      upstream.cases,
      (entry) => entry.plan.caseId,
      "REVIEW_FLOW_EVALUATION_BRIDGE_UPSTREAM_MISMATCH"
    );
    if (
      upstreamByCase.size !== bridgePlan.cases.length ||
      bridgePlan.cases.some((entry) => !upstreamByCase.has(entry.caseId))
    ) {
      fail("REVIEW_FLOW_EVALUATION_BRIDGE_UPSTREAM_MISMATCH");
    }

    const preparedCases = bridgePlan.cases.map((entry) =>
      prepareCase({
        planCase: entry,
        upstream: requireMapEntry(upstreamByCase, entry.caseId),
        upstreamSet: upstream,
        bridgePlanSha256: bridgePlanFile.sha256,
        attestationSha256:
          bridgePlan.upstreamVerificationAttestation.sha256,
        anklangCapture,
        generator,
        inputDirectory: bridgeInputDirectory,
        tagCatalog
      })
    );
    assertPreparedCaseSeparation(preparedCases);

    const development = preparedCases.filter(
      (entry) => entry.purpose === "development"
    );
    const holdout = preparedCases.filter((entry) => entry.purpose === "holdout");
    if (development.length === 0) {
      fail("REVIEW_FLOW_EVALUATION_BRIDGE_DEVELOPMENT_EMPTY");
    }
    if (
      (holdout.length > 0) !== (bridgePlan.holdoutRegistration !== null) ||
      (holdout.length > 0) !== (input.holdoutRevealDirectory !== undefined)
    ) {
      fail("REVIEW_FLOW_EVALUATION_BRIDGE_HOLDOUT_MISMATCH");
    }

    const predictionCases = (cases: readonly PreparedCase[]) =>
      cases.map((entry) => ({
        safeId: entry.safeId,
        subjectId: entry.subjectId,
        sourceLineageSha256: entry.sourceLineageSha256,
        originalAnklangResponseSha256: entry.originalAnklangResponseSha256,
        content: {
          fileName: entry.contentFileName,
          sha256: entry.contentSha256
        }
      }));
    const bindingManifest = reviewFlowEvaluationManifestSchema.parse({
      schemaVersion: 3,
      datasetId: bridgePlan.datasetId,
      tagCatalog: {
        fileName: tagCatalogFileName,
        sha256: sha256(tagCatalogBytes),
        version: tagCatalog.version
      },
      holdoutRegistration: bridgePlan.holdoutRegistration,
      developmentRevealCommitmentSha256: "0".repeat(64),
      holdoutRevealCommitmentSha256:
        holdout.length === 0 ? null : "1".repeat(64),
      partitions: {
        development: { cases: predictionCases(development) },
        holdout: { cases: predictionCases(holdout) }
      }
    });

    const nonce = input.randomBytes ?? cryptoRandomBytes;
    const developmentNonce = readNonce(nonce);
    const holdoutNonce = holdout.length === 0 ? null : readNonce(nonce);
    if (holdoutNonce !== null && holdoutNonce === developmentNonce) {
      fail("REVIEW_FLOW_EVALUATION_BRIDGE_NONCE_REUSE");
    }
    const developmentRevealValue = buildRevealDescriptor(
      bindingManifest,
      "development",
      development,
      developmentNonce
    );
    const developmentRevealBytes = prettyJsonBytes(developmentRevealValue);
    const holdoutRevealValue = holdoutNonce === null
      ? null
      : buildRevealDescriptor(
          bindingManifest,
          "holdout",
          holdout,
          holdoutNonce
        );
    const holdoutRevealBytes = holdoutRevealValue === null
      ? null
      : prettyJsonBytes(holdoutRevealValue);

    const manifest = reviewFlowEvaluationManifestSchema.parse({
      ...bindingManifest,
      developmentRevealCommitmentSha256: sha256(developmentRevealBytes),
      holdoutRevealCommitmentSha256:
        holdoutRevealBytes === null ? null : sha256(holdoutRevealBytes)
    });
    const manifestBytes = prettyJsonBytes(manifest);
    const completion = reviewFlowEvaluationBridgeCompletionSchema.parse({
      schemaVersion: 3,
      artifactKind: "review_flow_evaluation_dataset_bridge_completion",
      bridgeVersion,
      datasetId: manifest.datasetId,
      manifestFileName,
      manifestSha256: sha256(manifestBytes),
      generator,
      tagCatalogSha256: manifest.tagCatalog.sha256,
      sourceLineageSetSha256:
        reviewFlowEvaluationSourceLineageSetSha256(manifest),
      developmentPredictionBindingSha256:
        reviewFlowEvaluationDevelopmentPredictionBindingSha256(manifest),
      developmentRevealCommitmentSha256:
        manifest.developmentRevealCommitmentSha256,
      holdoutPredictionBindingSha256: holdout.length === 0
        ? null
        : reviewFlowEvaluationHoldoutPredictionBindingSha256(manifest),
      holdoutRevealCommitmentSha256:
        manifest.holdoutRevealCommitmentSha256,
      caseCount: preparedCases.length,
      developmentCount: development.length,
      holdoutCount: holdout.length
    });
    const completionBytes = prettyJsonBytes(completion);

    output = prepareNewOutputDirectory(input.outputDirectory, input);
    developmentReveal = prepareNewOutputDirectory(
      input.developmentRevealDirectory,
      input
    );
    if (input.holdoutRevealDirectory !== undefined) {
      holdoutReveal = prepareNewOutputDirectory(
        input.holdoutRevealDirectory,
        input
      );
    }

    for (const entry of development) {
      publish(
        developmentReveal,
        entry.goldFileName,
        entry.goldBytes,
        "development_gold",
        input.hooks
      );
    }
    publish(
      developmentReveal,
      revealDescriptorFileName,
      developmentRevealBytes,
      "development_reveal",
      input.hooks
    );
    if (holdoutReveal !== undefined && holdoutRevealBytes !== null) {
      for (const entry of holdout) {
        publish(
          holdoutReveal,
          entry.goldFileName,
          entry.goldBytes,
          "holdout_gold",
          input.hooks
        );
      }
      publish(
        holdoutReveal,
        revealDescriptorFileName,
        holdoutRevealBytes,
        "holdout_reveal",
        input.hooks
      );
    }
    publish(
      output,
      tagCatalogFileName,
      tagCatalogBytes,
      "tag_catalog",
      input.hooks
    );
    for (const entry of preparedCases) {
      publish(
        output,
        entry.contentFileName,
        entry.contentBytes,
        "content",
        input.hooks
      );
    }
    publish(output, manifestFileName, manifestBytes, "manifest", input.hooks);

    assertExactDirectoryInventory(
      developmentReveal,
      new Set([
        ...development.map((entry) => entry.goldFileName),
        revealDescriptorFileName
      ])
    );
    if (holdoutReveal !== undefined) {
      assertExactDirectoryInventory(
        holdoutReveal,
        new Set([
          ...holdout.map((entry) => entry.goldFileName),
          revealDescriptorFileName
        ])
      );
    }
    const outputNamesBeforeMarker = new Set([
      tagCatalogFileName,
      manifestFileName,
      ...preparedCases.map((entry) => entry.contentFileName)
    ]);
    assertExactDirectoryInventory(output, outputNamesBeforeMarker);
    input.hooks?.beforeCompletionMarker?.();
    const finalAnklangCapture = loadAnklangCapture({
      plan: bridgePlan,
      inputDirectory: bridgeInputDirectory,
      input
    });
    if (
      anklangCaptureBindingFingerprint(finalAnklangCapture) !==
        anklangCaptureBindingFingerprint(anklangCapture)
    ) {
      fail("REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_CAPTURE_CHANGED");
    }
    const finalGeneratorIdentity = loadBridgeGeneratorIdentity(
      input,
      "REVIEW_FLOW_EVALUATION_BRIDGE_GENERATOR_IDENTITY_CHANGED"
    );
    if (JSON.stringify(finalGeneratorIdentity) !== JSON.stringify(generatorIdentity)) {
      fail("REVIEW_FLOW_EVALUATION_BRIDGE_GENERATOR_IDENTITY_CHANGED");
    }
    publish(
      output,
      reviewFlowEvaluationBridgeCompletionFileName,
      completionBytes,
      "completion",
      input.hooks
    );
    assertExactDirectoryInventory(
      output,
      new Set([
        ...outputNamesBeforeMarker,
        reviewFlowEvaluationBridgeCompletionFileName
      ])
    );

    return {
      datasetId: manifest.datasetId,
      manifestPath: resolve(input.outputDirectory, manifestFileName),
      developmentRevealDescriptorPath: resolve(
        input.developmentRevealDirectory,
        revealDescriptorFileName
      ),
      holdoutRevealDescriptorPath: input.holdoutRevealDirectory === undefined
        ? null
        : resolve(input.holdoutRevealDirectory, revealDescriptorFileName),
      caseCount: preparedCases.length,
      developmentCount: development.length,
      holdoutCount: holdout.length
    };
  } finally {
    if (holdoutReveal !== undefined) closePrivateDirectory(holdoutReveal);
    if (developmentReveal !== undefined) closePrivateDirectory(developmentReveal);
    if (output !== undefined) closePrivateDirectory(output);
    closePrivateDirectory(bridgeInputDirectory);
  }
}

function anklangCaptureBindingFingerprint(
  capture: ValidatedAnklangCapture
): string {
  return hashCanonicalValue({
    attestationSha256: capture.attestationSha256,
    completionSha256: capture.completionSha256,
    corpusEvidenceKind: capture.corpusEvidenceKind,
    cases: [...capture.cases.values()]
  });
}

function validateUpstreamAttestation(input: {
  readonly attestation: z.infer<
    typeof reviewFlowEvaluationUpstreamAttestationSchema
  >;
  readonly attestationBytes: Buffer;
  readonly upstream: ValidatedUpstream;
  readonly input: PrepareReviewFlowEvaluationBridgeInput;
  readonly verifierRepositoryDirectory: string;
}): void {
  const { verificationFingerprint: _fingerprint, ...withoutFingerprint } =
    input.attestation;
  if (
    input.attestation.verificationFingerprint !==
      hashCanonicalValue(withoutFingerprint) ||
    !input.attestationBytes.equals(prettyJsonBytes(input.attestation))
  ) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_ATTESTATION_INVALID");
  }
  const expectedCases = input.upstream.cases.map((entry) => ({
    caseId: entry.plan.caseId,
    subjectId: entry.plan.subjectId,
    purpose: entry.plan.purpose,
    evaluationScope: entry.plan.evaluationScope,
    sourceId: entry.plan.sourceId,
    sourcePath: entry.source.sourcePath,
    sourceSha256: entry.plan.sourceSha256,
    rowEvidenceSha256: entry.binding.rowEvidenceSha256,
    goldSha256: entry.goldSha256
  }));
  const expectedReviewInputs = input.upstream.reviewInputs.map((entry) => ({
    inputId: entry.inputId,
    format: entry.format,
    inputSha256: entry.sha256
  }));
  const artifacts = input.attestation.artifacts;
  if (
    input.attestation.upstreamDatasetId !== input.upstream.datasetId ||
    artifacts.reviewGoldCompleteSha256 !== input.upstream.markerSha256 ||
    artifacts.evidenceSha256 !== input.upstream.evidenceSha256 ||
    artifacts.sourceBindingsSha256 !== input.upstream.bindingsSha256 ||
    artifacts.tuningHistorySha256 !== input.upstream.tuningHistorySha256 ||
    artifacts.tuningHistoryAdditionsSha256 !==
      input.upstream.tuningHistoryAdditionsSha256 ||
    artifacts.planSha256 !== input.upstream.planSha256 ||
    artifacts.worksheetSha256 !== input.upstream.worksheetSha256 ||
    artifacts.worksheetCompletionSha256 !==
      input.upstream.worksheetCompletionSha256 ||
    artifacts.inspectionSha256 !== input.upstream.inspectionSha256 ||
    artifacts.layoutSha256 !== input.upstream.layoutSha256 ||
    artifacts.inputSetSha256 !== input.upstream.inputSetSha256 ||
    artifacts.sourceConfirmationCanonicalSha256 !==
      input.upstream.sourceConfirmationSha256 ||
    artifacts.materializationCompleteSha256 !==
      input.upstream.materializationCompleteSha256 ||
    artifacts.materializationReportCanonicalSha256 !==
      input.upstream.materializationReportCanonicalSha256 ||
    artifacts.materializationSourceSetSha256 !==
      input.upstream.materializationSourceSetSha256 ||
    JSON.stringify(input.attestation.reviewInputs) !==
      JSON.stringify(expectedReviewInputs) ||
    JSON.stringify(input.attestation.cases) !== JSON.stringify(expectedCases) ||
    JSON.stringify(input.attestation.counts) !==
      JSON.stringify(input.upstream.counts)
  ) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_ATTESTATION_MISMATCH");
  }

  const verifier = input.attestation.verifier;
  const identity = loadEvaluationCodeIdentity({
    repositoryDirectory: input.verifierRepositoryDirectory,
    expectedCodeVersion: verifier.codeVersion,
    runnerPath: upstreamVerifierRunnerPath,
    dependencyPaths: upstreamVerifierDependencyPaths
  });
  if (
    identity.runnerSha256 !== verifier.runnerSha256 ||
    identity.dependencyCodeSha256 !== verifier.dependencyCodeSha256 ||
    identity.dependencyFileCount !== verifier.dependencyFileCount
  ) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_VERIFIER_IDENTITY_INVALID");
  }
  assertTrustedPythonExecutable();
  let verifierOutput: Buffer;
  try {
    verifierOutput = execFileSync(
      "/usr/bin/python3",
      [
        resolve(input.verifierRepositoryDirectory, upstreamVerifierRunnerPath),
        "verify-sealed",
        "--private-root",
        input.input.privateRoot,
        ...input.input.reviewInputPaths.flatMap((path) => ["--input", path]),
        "--inspection",
        input.input.inspectionPath,
        "--layout",
        input.input.layoutPath,
        "--materialized",
        input.input.materializedDirectory,
        "--worksheet",
        dirname(input.input.worksheetPath),
        "--plan",
        input.input.upstreamPlanPath,
        "--tuning-history",
        input.input.tuningHistoryPath,
        "--sealed",
        input.input.upstreamGoldDirectory,
        "--verifier-code-version",
        verifier.codeVersion,
        "--verifier-runner-sha256",
        verifier.runnerSha256,
        "--verifier-dependency-code-sha256",
        verifier.dependencyCodeSha256
      ],
      {
        cwd: input.verifierRepositoryDirectory,
        env: {
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: "/usr/bin:/bin",
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONHASHSEED: "0",
          PYTHONNOUSERSITE: "1",
          PYTHONSAFEPATH: "1"
        },
        encoding: "buffer",
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
  } catch {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_VERIFIER_EXECUTION_FAILED");
  }
  if (!verifierOutput.equals(input.attestationBytes)) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_ATTESTATION_MISMATCH");
  }
  const afterIdentity = loadEvaluationCodeIdentity({
    repositoryDirectory: input.verifierRepositoryDirectory,
    expectedCodeVersion: verifier.codeVersion,
    runnerPath: upstreamVerifierRunnerPath,
    dependencyPaths: upstreamVerifierDependencyPaths
  });
  if (JSON.stringify(afterIdentity) !== JSON.stringify(identity)) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_VERIFIER_IDENTITY_INVALID");
  }
}

export function reviewFlowEvaluationAnklangCaptureSetSha256(
  cases: readonly z.infer<typeof anklangCaptureCaseSchema>[]
): string {
  return hashCanonicalValue({
    protocol: "anklang-review-flow-capture-set-v1",
    cases
  });
}

function loadAnklangCapture(input: {
  readonly plan: ReviewFlowEvaluationBridgePlan;
  readonly inputDirectory: PrivateDirectoryHandle;
  readonly input: Pick<PrepareReviewFlowEvaluationBridgeInput,
    "containingWorkspace">;
}): ValidatedAnklangCapture {
  const attestationBytes = readBoundInput(
    input.inputDirectory,
    input.plan.anklangCaptureAttestation,
    16 * 1024 * 1024,
    "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_CAPTURE_ATTESTATION_INVALID"
  );
  const attestation = parseStrict(
    attestationBytes,
    reviewFlowEvaluationAnklangCaptureAttestationSchema,
    "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_CAPTURE_ATTESTATION_INVALID"
  );
  const { captureFingerprint: _fingerprint, ...withoutFingerprint } = attestation;
  if (
    attestation.captureFingerprint !== hashCanonicalValue(withoutFingerprint) ||
    !attestationBytes.equals(prettyJsonBytes(attestation))
  ) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_CAPTURE_ATTESTATION_INVALID");
  }
  const completionBytes = readBoundInput(
    input.inputDirectory,
    input.plan.anklangCaptureCompletion,
    1024 * 1024,
    "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_CAPTURE_COMPLETION_INVALID"
  );
  const completion = parseStrict(
    completionBytes,
    reviewFlowEvaluationAnklangCaptureCompletionSchema,
    "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_CAPTURE_COMPLETION_INVALID"
  );
  if (!completionBytes.equals(prettyJsonBytes(completion))) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_CAPTURE_COMPLETION_INVALID");
  }
  const count = attestation.cases.length;
  const expectedCaseIds = input.plan.cases.map((entry) => entry.caseId);
  const actualCaseIds = attestation.cases.map((entry) => entry.caseId);
  const counts = attestation.counts;
  const attestationSha256 = sha256(attestationBytes);
  const captureSetSha256 = reviewFlowEvaluationAnklangCaptureSetSha256(
    attestation.cases
  );
  if (
    JSON.stringify(actualCaseIds) !== JSON.stringify(expectedCaseIds) ||
    new Set(attestation.cases.map((entry) => entry.requestId)).size !== count ||
    new Set(attestation.cases.map((entry) => entry.requestSha256)).size !== count ||
    new Set(attestation.cases.map((entry) => entry.responseSha256)).size !== count ||
    counts.caseCount !== count ||
    counts.requestCount !== count ||
    counts.responseCount !== count ||
    counts.http200Count !== count ||
    counts.attemptCount !== count ||
    counts.completeResponseCount !== count ||
    completion.captureId !== attestation.captureId ||
    completion.attestationSha256 !== attestationSha256 ||
    completion.captureSetSha256 !== captureSetSha256 ||
    completion.caseCount !== count ||
    completion.requestCount !== count ||
    completion.responseCount !== count ||
    completion.http200Count !== count ||
    completion.attemptCount !== count ||
    completion.completeResponseCount !== count ||
    completion.failureCount !== counts.failureCount
  ) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_CAPTURE_MISMATCH");
  }
  const capturer = attestation.capturer;
  let identity: EvaluationCodeIdentity;
  try {
    identity = loadEvaluationCodeIdentity({
      repositoryDirectory: resolve(input.input.containingWorkspace, "Anklang"),
      expectedCodeVersion: capturer.codeVersion,
      runnerPath: anklangCaptureRunnerPath,
      dependencyPaths: anklangCaptureDependencyPaths
    });
  } catch {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_CAPTURER_IDENTITY_INVALID");
  }
  if (
    identity.runnerSha256 !== capturer.runnerSha256 ||
    identity.dependencyCodeSha256 !== capturer.dependencyCodeSha256 ||
    identity.dependencyFileCount !== capturer.dependencyFileCount
  ) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_CAPTURER_IDENTITY_INVALID");
  }
  return {
    attestationSha256,
    completionSha256: sha256(completionBytes),
    corpusEvidenceKind: attestation.corpus.evidenceKind,
    cases: new Map(attestation.cases.map((entry) => [entry.caseId, entry]))
  };
}

function loadBridgeGeneratorIdentity(
  input: Pick<PrepareReviewFlowEvaluationBridgeInput,
    "containingWorkspace" | "fermataCodeVersion">,
  errorCode = "REVIEW_FLOW_EVALUATION_BRIDGE_GENERATOR_IDENTITY_INVALID"
): EvaluationCodeIdentity {
  try {
    if (
      reviewFlowEvaluationCodePaths.length !==
        reviewFlowEvaluationGeneratorDependencyFileCount
    ) {
      fail(errorCode);
    }
    return loadEvaluationCodeIdentity({
      repositoryDirectory: resolve(input.containingWorkspace, "Fermata"),
      expectedCodeVersion: input.fermataCodeVersion,
      runnerPath: bridgeGeneratorRunnerPath,
      dependencyPaths: reviewFlowEvaluationCodePaths
    });
  } catch {
    fail(errorCode);
  }
}

function bridgeGeneratorBinding(
  identity: EvaluationCodeIdentity
): BridgeGeneratorIdentity {
  return {
    codeVersion: identity.codeVersion,
    runnerSha256: identity.runnerSha256,
    dependencyCodeSha256: identity.dependencyCodeSha256,
    dependencyFileCount: identity.dependencyFileCount
  };
}

function assertTrustedPythonExecutable(): void {
  try {
    const resolved = realpathSync("/usr/bin/python3");
    const status = statSync(resolved);
    if (
      !status.isFile() ||
      status.uid !== 0 ||
      (status.mode & 0o022) !== 0 ||
      (status.mode & 0o111) === 0 ||
      !resolved.startsWith("/usr/bin/python3")
    ) {
      fail("REVIEW_FLOW_EVALUATION_BRIDGE_PYTHON_UNTRUSTED");
    }
  } catch (error) {
    if (error instanceof ReviewFlowEvaluationBridgeError) throw error;
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_PYTHON_UNTRUSTED");
  }
}

function validateUpstream(
  input: PrepareReviewFlowEvaluationBridgeInput
): ValidatedUpstream {
  const upstreamDirectory = openExistingPrivateDirectory(
    input.upstreamGoldDirectory,
    runtimeOptions(input)
  );
  let goldDirectory: PrivateDirectoryHandle | undefined;
  let materializedSources: PrivateDirectoryHandle | undefined;
  try {
    goldDirectory = openExistingPrivateDirectory(
      resolve(input.upstreamGoldDirectory, "gold"),
      runtimeOptions(input)
    );
    materializedSources = openExistingPrivateDirectory(
      resolve(input.materializedDirectory, "sources"),
      runtimeOptions(input)
    );
    const marker = readDirectoryJson(
      upstreamDirectory,
      upstreamCompletionFileName,
      upstreamCompletionSchema,
      1024 * 1024,
      "REVIEW_FLOW_EVALUATION_BRIDGE_UPSTREAM_MARKER_INVALID"
    );
    const evidence = readDirectoryJson(
      upstreamDirectory,
      upstreamEvidenceFileName,
      upstreamEvidenceSchema,
      10 * 1024 * 1024,
      "REVIEW_FLOW_EVALUATION_BRIDGE_UPSTREAM_EVIDENCE_INVALID"
    );
    const bindings = readDirectoryJson(
      upstreamDirectory,
      upstreamBindingsFileName,
      upstreamBindingsSchema,
      10 * 1024 * 1024,
      "REVIEW_FLOW_EVALUATION_BRIDGE_UPSTREAM_BINDINGS_INVALID"
    );
    const additions = readDirectoryJson(
      upstreamDirectory,
      upstreamTuningAdditionsFileName,
      upstreamTuningAdditionsSchema,
      10 * 1024 * 1024,
      "REVIEW_FLOW_EVALUATION_BRIDGE_UPSTREAM_TUNING_INVALID"
    );
    const plan = readAbsoluteJson(
      input.upstreamPlanPath,
      upstreamPlanSchema,
      input,
      10 * 1024 * 1024,
      "REVIEW_FLOW_EVALUATION_BRIDGE_UPSTREAM_PLAN_INVALID"
    );
    const tuning = readAbsoluteJson(
      input.tuningHistoryPath,
      upstreamTuningHistorySchema,
      input,
      10 * 1024 * 1024,
      "REVIEW_FLOW_EVALUATION_BRIDGE_UPSTREAM_TUNING_INVALID"
    );
    const inspection = readAbsoluteJson(
      input.inspectionPath,
      upstreamInspectionSchema,
      input,
      10 * 1024 * 1024,
      "REVIEW_FLOW_EVALUATION_BRIDGE_INSPECTION_INVALID"
    );
    const worksheet = readAbsoluteJson(
      input.worksheetPath,
      upstreamWorksheetSchema,
      input,
      10 * 1024 * 1024,
      "REVIEW_FLOW_EVALUATION_BRIDGE_WORKSHEET_INVALID"
    );
    const worksheetCompletion = readAbsoluteJson(
      input.worksheetCompletionPath,
      reviewWorksheetCompletionSchema,
      input,
      1024 * 1024,
      "REVIEW_FLOW_EVALUATION_BRIDGE_WORKSHEET_INVALID"
    );
    const layoutBytes = readAbsoluteBytes(
      input.layoutPath,
      input,
      10 * 1024 * 1024
    );
    const sourceConfirmation = readAbsoluteJson(
      resolve(input.materializedDirectory, "source-confirmation.private.json"),
      materializationConfirmationSchema,
      input,
      10 * 1024 * 1024,
      "REVIEW_FLOW_EVALUATION_BRIDGE_MATERIALIZATION_INVALID"
    );
    const materializationMarker = readAbsoluteJson(
      resolve(input.materializedDirectory, "MATERIALIZE_COMPLETE"),
      materializationCompletionSchema,
      input,
      1024 * 1024,
      "REVIEW_FLOW_EVALUATION_BRIDGE_MATERIALIZATION_INVALID"
    );
    const materializationReport = readAbsoluteJson(
      resolve(input.materializedDirectory, "report.json"),
      materializationReportSchema,
      input,
      10 * 1024 * 1024,
      "REVIEW_FLOW_EVALUATION_BRIDGE_MATERIALIZATION_INVALID"
    );

    if (
      marker.value.evidenceSha256 !== evidence.sha256 ||
      marker.value.sourceBindingsSha256 !== bindings.sha256 ||
      marker.value.tuningHistorySha256 !== tuning.sha256 ||
      marker.value.tuningHistoryAdditionsSha256 !== additions.sha256 ||
      marker.value.planSha256 !== plan.sha256 ||
      bindings.value.worksheetSha256 !== worksheet.sha256 ||
      plan.value.worksheetSha256 !== worksheet.sha256 ||
      worksheet.value.inspectionFileSha256 !== inspection.sha256 ||
      worksheet.value.layoutFileSha256 !== sha256(layoutBytes) ||
      worksheet.value.inputSetSha256 !== inspection.value.inputSetSha256 ||
      inspection.value.inputSetSha256 !==
        compactSha256({ version: 1, inputs: inspection.value.inputs }) ||
      bindings.value.sourceConfirmationSha256 !==
        compactSha256(sourceConfirmation.value) ||
      plan.value.sourceConfirmationSha256 !==
        bindings.value.sourceConfirmationSha256 ||
      worksheet.value.sourceConfirmationSha256 !==
        bindings.value.sourceConfirmationSha256 ||
      materializationMarker.value.sourceConfirmationSha256 !==
        bindings.value.sourceConfirmationSha256 ||
      bindings.value.materializationCompleteSha256 !==
        materializationMarker.sha256 ||
      worksheet.value.materializationCompleteSha256 !==
        materializationMarker.sha256 ||
      worksheetCompletion.value.worksheetSha256 !== worksheet.sha256 ||
      worksheetCompletion.value.rowCount !== worksheet.value.rows.length ||
      worksheetCompletion.value.sourceCount !== worksheet.value.sources.length ||
      worksheetCompletion.value.reviewCommentRowCount !==
        worksheet.value.rows.filter((entry) => entry.reviewCommentPresent).length ||
      additions.value.priorTuningHistorySha256 !== tuning.sha256 ||
      plan.value.datasetId !== evidence.value.datasetId ||
      materializationMarker.value.reportSha256 !==
        compactSha256(materializationReport.value) ||
      materializationMarker.value.groupingBatchSha256 !==
        materializationReport.value.groupingBatchSha256 ||
      materializationMarker.value.sourceCount !==
        materializationReport.value.sourceCount ||
      materializationMarker.value.fragmentCount !==
        materializationReport.value.fragmentCount ||
      materializationReport.value.sourceCount !==
        materializationReport.value.sources.length ||
      sourceConfirmation.value.mappings.length !==
        materializationReport.value.sources.length
    ) {
      fail("REVIEW_FLOW_EVALUATION_BRIDGE_UPSTREAM_MISMATCH");
    }

    const materializedSourceBytesByPath = new Map<string, Buffer>();
    const sourceSet: {
      sourceId: string;
      sourceSha256: string;
      byteLength: number;
    }[] = [];
    for (const [index, mapping] of sourceConfirmation.value.mappings.entries()) {
      const reportSource = materializationReport.value.sources[index];
      if (reportSource === undefined) {
        fail("REVIEW_FLOW_EVALUATION_BRIDGE_MATERIALIZATION_INVALID");
      }
      const expectedSourceId = `source-${String(index + 1).padStart(6, "0")}`;
      const sourceBytes = readPrivateArtifactBytes(
        materializedSources,
        mapping.sourcePath,
        2 * 1024 * 1024
      );
      const sourceText = decodeStrictUtf8(sourceBytes);
      if (
        reportSource.sourceId !== expectedSourceId ||
        reportSource.sourceSha256 !== mapping.sourceSha256 ||
        sha256(sourceBytes) !== mapping.sourceSha256 ||
        reportSource.byteLength !== sourceBytes.byteLength ||
        reportSource.characterCount !== sourceText.length ||
        sourceText.trim().length === 0
      ) {
        fail("REVIEW_FLOW_EVALUATION_BRIDGE_MATERIALIZATION_INVALID");
      }
      materializedSourceBytesByPath.set(
        mapping.sourcePath.toLocaleLowerCase("en-US"),
        sourceBytes
      );
      sourceSet.push({
        sourceId: expectedSourceId,
        sourceSha256: mapping.sourceSha256,
        byteLength: sourceBytes.byteLength
      });
    }
    if (
      materializationMarker.value.sourceSetSha256 !==
        compactSha256({ version: 1, sources: sourceSet })
    ) {
      fail("REVIEW_FLOW_EVALUATION_BRIDGE_MATERIALIZATION_INVALID");
    }
    assertExactDirectoryInventory(
      materializedSources,
      new Set(sourceConfirmation.value.mappings.map((entry) => entry.sourcePath))
    );

    if (input.reviewInputPaths.length !== inspection.value.inputs.length) {
      fail("REVIEW_FLOW_EVALUATION_BRIDGE_REVIEW_INPUT_SET_MISMATCH");
    }
    const reviewInputs = inspection.value.inputs.map((entry, index) => {
      const path = input.reviewInputPaths[index];
      if (path === undefined) {
        fail("REVIEW_FLOW_EVALUATION_BRIDGE_REVIEW_INPUT_SET_MISMATCH");
      }
      const bytes = readAbsoluteBytes(path, input, 64 * 1024 * 1024);
      if (sha256(bytes) !== entry.inputSha256) {
        fail("REVIEW_FLOW_EVALUATION_BRIDGE_REVIEW_INPUT_SET_MISMATCH");
      }
      return {
        inputId: entry.inputId,
        format: entry.format,
        sha256: entry.inputSha256
      };
    });
    assertUnique(reviewInputs.map((entry) => entry.inputId));
    assertUnique(reviewInputs.map((entry) => entry.sha256));

    const evidenceByCase = uniqueMap(
      evidence.value.entries,
      (entry) => entry.caseId,
      "REVIEW_FLOW_EVALUATION_BRIDGE_UPSTREAM_MISMATCH"
    );
    const bindingByCase = uniqueMap(
      bindings.value.cases,
      (entry) => entry.caseId,
      "REVIEW_FLOW_EVALUATION_BRIDGE_UPSTREAM_MISMATCH"
    );
    const rowById = uniqueMap(
      worksheet.value.rows,
      (entry) => entry.rowId,
      "REVIEW_FLOW_EVALUATION_BRIDGE_WORKSHEET_INVALID"
    );
    const sourceById = uniqueMap(
      worksheet.value.sources,
      (entry) => entry.sourceId,
      "REVIEW_FLOW_EVALUATION_BRIDGE_WORKSHEET_INVALID"
    );
    const confirmationByPath = uniqueMap(
      sourceConfirmation.value.mappings,
      (entry) => entry.sourcePath.toLocaleLowerCase("en-US"),
      "REVIEW_FLOW_EVALUATION_BRIDGE_MATERIALIZATION_INVALID"
    );
    if (
      evidenceByCase.size !== plan.value.cases.length ||
      bindingByCase.size !== plan.value.cases.length
    ) {
      fail("REVIEW_FLOW_EVALUATION_BRIDGE_UPSTREAM_MISMATCH");
    }

    const validatedCases = plan.value.cases.map((planCase) => {
      const evidenceEntry = requireMapEntry(evidenceByCase, planCase.caseId);
      const binding = requireMapEntry(bindingByCase, planCase.caseId);
      const row = requireMapEntry(rowById, planCase.rowId);
      const source = requireMapEntry(sourceById, planCase.sourceId);
      const confirmation = requireMapEntry(
        confirmationByPath,
        source.sourcePath.toLocaleLowerCase("en-US")
      );
      const expectedGoldFile = `gold/${planCase.caseId}.json`;
      if (
        evidenceEntry.purpose !== planCase.purpose ||
        evidenceEntry.evaluationScope !== planCase.evaluationScope ||
        evidenceEntry.materializedSourceSha256 !== planCase.sourceSha256 ||
        evidenceEntry.goldFile !== expectedGoldFile ||
        binding.subjectId !== planCase.subjectId ||
        binding.sourceId !== planCase.sourceId ||
        binding.sourceSha256 !== planCase.sourceSha256 ||
        binding.rowEvidenceSha256 !== row.rowEvidenceSha256 ||
        source.sourceSha256 !== planCase.sourceSha256 ||
        source.sourcePath !== binding.sourcePath ||
        source.metadataNumber !== row.metadataNumber ||
        confirmation.sourcePath !== source.sourcePath ||
        confirmation.sourceSha256 !== source.sourceSha256 ||
        confirmation.metadataNumber !== source.metadataNumber ||
        row.rowEvidenceSha256 !== rowEvidenceSha256(row)
      ) {
        fail("REVIEW_FLOW_EVALUATION_BRIDGE_CASE_BINDING_MISMATCH");
      }
      const goldFileName = `${planCase.caseId}.json`;
      const goldFile = readDirectoryJson(
        goldDirectory!,
        goldFileName,
        upstreamGoldSchema,
        1024 * 1024,
        "REVIEW_FLOW_EVALUATION_BRIDGE_UPSTREAM_GOLD_INVALID"
      );
      if (
        goldFile.sha256 !== evidenceEntry.goldSha256 ||
        goldFile.value.caseId !== planCase.caseId ||
        goldFile.value.evaluationScope !== planCase.evaluationScope ||
        goldFile.value.reviewCommentPresent !== row.reviewCommentPresent ||
        !upstreamGoldMatchesPlan(goldFile.value, planCase)
      ) {
        fail("REVIEW_FLOW_EVALUATION_BRIDGE_UPSTREAM_GOLD_MISMATCH");
      }
      const sourceBytes = materializedSourceBytesByPath.get(
        source.sourcePath.toLocaleLowerCase("en-US")
      );
      if (sourceBytes === undefined) {
        fail("REVIEW_FLOW_EVALUATION_BRIDGE_SOURCE_MISMATCH");
      }
      if (sha256(sourceBytes) !== source.sourceSha256) {
        fail("REVIEW_FLOW_EVALUATION_BRIDGE_SOURCE_MISMATCH");
      }
      return {
        plan: planCase,
        evidence: evidenceEntry,
        binding,
        gold: goldFile.value,
        goldSha256: goldFile.sha256,
        row,
        source,
        sourceBytes
      };
    });

    const expectedGoldSetSha256 = compactSha256({
      version: 1,
      gold: evidence.value.entries.map((entry) => ({
        caseId: entry.caseId,
        goldSha256: entry.goldSha256
      }))
    });
    const developmentCases = validatedCases.filter(
      (entry) => entry.plan.purpose === "development"
    );
    const expectedAdditions = developmentCases.map((entry) => ({
      subjectId: entry.plan.subjectId,
      contentSha256: entry.plan.sourceSha256
    }));
    if (
      marker.value.goldSetSha256 !== expectedGoldSetSha256 ||
      marker.value.caseCount !== validatedCases.length ||
      marker.value.developmentCount !== developmentCases.length ||
      marker.value.holdoutCount !==
        validatedCases.length - developmentCases.length ||
      marker.value.verdictAndTasteCount !==
        validatedCases.filter(
          (entry) => entry.plan.evaluationScope === "verdict_and_taste"
        ).length ||
      marker.value.originalityOnlyCount !==
        validatedCases.filter(
          (entry) => entry.plan.evaluationScope === "originality_only"
        ).length ||
      JSON.stringify(additions.value.developmentSamples) !==
        JSON.stringify(expectedAdditions)
    ) {
      fail("REVIEW_FLOW_EVALUATION_BRIDGE_UPSTREAM_MISMATCH");
    }
    assertExactDirectoryInventory(
      goldDirectory,
      new Set(validatedCases.map((entry) => `${entry.plan.caseId}.json`))
    );
    assertExactDirectoryInventory(
      upstreamDirectory,
      new Set([
        upstreamCompletionFileName,
        upstreamEvidenceFileName,
        upstreamBindingsFileName,
        upstreamTuningAdditionsFileName
      ]),
      new Set(["gold"])
    );

    return {
      markerSha256: marker.sha256,
      evidenceSha256: evidence.sha256,
      bindingsSha256: bindings.sha256,
      tuningHistoryAdditionsSha256: additions.sha256,
      planSha256: plan.sha256,
      tuningHistorySha256: tuning.sha256,
      worksheetSha256: worksheet.sha256,
      worksheetCompletionSha256: worksheetCompletion.sha256,
      inspectionSha256: inspection.sha256,
      layoutSha256: sha256(layoutBytes),
      inputSetSha256: inspection.value.inputSetSha256,
      reviewInputs,
      sourceConfirmationSha256: bindings.value.sourceConfirmationSha256,
      materializationCompleteSha256: materializationMarker.sha256,
      materializationReportCanonicalSha256:
        compactSha256(materializationReport.value),
      materializationSourceSetSha256:
        materializationMarker.value.sourceSetSha256,
      materializedSourceCount: materializationReport.value.sourceCount,
      counts: {
        caseCount: marker.value.caseCount,
        developmentCount: marker.value.developmentCount,
        holdoutCount: marker.value.holdoutCount,
        verdictAndTasteCount: marker.value.verdictAndTasteCount,
        originalityOnlyCount: marker.value.originalityOnlyCount,
        reviewInputCount: reviewInputs.length,
        materializedSourceCount: materializationReport.value.sourceCount
      },
      datasetId: evidence.value.datasetId,
      cases: validatedCases
    };
  } finally {
    if (materializedSources !== undefined) {
      closePrivateDirectory(materializedSources);
    }
    if (goldDirectory !== undefined) closePrivateDirectory(goldDirectory);
    closePrivateDirectory(upstreamDirectory);
  }
}

function prepareCase(input: {
  readonly planCase: z.infer<typeof bridgePlanCaseSchema>;
  readonly upstream: ValidatedUpstreamCase;
  readonly upstreamSet: ValidatedUpstream;
  readonly bridgePlanSha256: string;
  readonly attestationSha256: string;
  readonly anklangCapture: ValidatedAnklangCapture;
  readonly generator: BridgeGeneratorIdentity;
  readonly inputDirectory: PrivateDirectoryHandle;
  readonly tagCatalog: z.infer<typeof tagCatalogSchema>;
}): PreparedCase {
  const planCase = input.planCase;
  const upstream = input.upstream;
  if (
    planCase.subjectId !== upstream.binding.subjectId ||
    planCase.purpose !== upstream.plan.purpose ||
    planCase.sourceId !== upstream.plan.sourceId ||
    planCase.sourceSha256 !== upstream.plan.sourceSha256 ||
    planCase.rowEvidenceSha256 !== upstream.binding.rowEvidenceSha256
  ) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_CASE_BINDING_MISMATCH");
  }
  const taskDraftBytes = readBoundInput(
    input.inputDirectory,
    planCase.taskDraft,
    12 * 1024 * 1024,
    "REVIEW_FLOW_EVALUATION_BRIDGE_TASK_INVALID"
  );
  const taskDraft = parseStrict(
    taskDraftBytes,
    robotReviewTaskSchema,
    "REVIEW_FLOW_EVALUATION_BRIDGE_TASK_INVALID"
  );
  const problemHashInputBytes = readBoundInput(
    input.inputDirectory,
    planCase.problemHashInput,
    16 * 1024 * 1024,
    "REVIEW_FLOW_EVALUATION_BRIDGE_PROBLEM_HASH_INPUT_INVALID"
  );
  const problemHashInput = parseStrict(
    problemHashInputBytes,
    reviewFlowEvaluationProblemHashInputSchema,
    "REVIEW_FLOW_EVALUATION_BRIDGE_PROBLEM_HASH_INPUT_INVALID"
  );
  const computedProblemContentHash = computeUrmotivProblemContentHash(
    problemHashInput
  );
  const anklangRequestBytes = readBoundInput(
    input.inputDirectory,
    planCase.originalAnklangRequest,
    4 * 1024 * 1024,
    "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_REQUEST_INVALID"
  );
  const anklangRequest = parseStrict(
    anklangRequestBytes,
    anklangV2RequestSchema,
    "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_REQUEST_INVALID"
  );
  const anklangBytes = readBoundInput(
    input.inputDirectory,
    planCase.originalAnklangResponse,
    4 * 1024 * 1024,
    "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_INVALID"
  );
  const anklang = parseStrict(
    anklangBytes,
    completeAnklangV2ResultSchema,
    "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_INVALID"
  );
  const mappingBytes = readBoundInput(
    input.inputDirectory,
    planCase.humanMapping,
    4 * 1024 * 1024,
    "REVIEW_FLOW_EVALUATION_BRIDGE_MAPPING_INVALID"
  );
  const mapping = parseStrict(
    mappingBytes,
    reviewFlowEvaluationHumanMappingSchema,
    "REVIEW_FLOW_EVALUATION_BRIDGE_MAPPING_INVALID"
  );
  if (
    taskDraft.reviewItems.length !== 0 ||
    taskDraft.problem.contentHash !== computedProblemContentHash ||
    taskDraft.problem.contentHash !== anklang.contentHash ||
    !taskMatchesProblemHashInput(taskDraft, problemHashInput) ||
    mapping.caseId !== planCase.caseId ||
    mapping.safeId !== planCase.safeId ||
    mapping.subjectId !== planCase.subjectId ||
    mapping.purpose !== planCase.purpose ||
    mapping.sourceId !== planCase.sourceId ||
    mapping.sourceSha256 !== planCase.sourceSha256 ||
    mapping.rowEvidenceSha256 !== planCase.rowEvidenceSha256 ||
    mapping.reviewInputId !== upstream.row.inputId ||
    mapping.worksheetId !== upstream.row.worksheetId ||
    mapping.sourceRowNumber !== upstream.row.sourceRowNumber ||
    mapping.taskDraftSha256 !== planCase.taskDraft.sha256 ||
    mapping.problemHashInputSha256 !== planCase.problemHashInput.sha256 ||
    mapping.problemContentHash !== taskDraft.problem.contentHash ||
    mapping.evaluationScope !== upstream.plan.evaluationScope ||
    anklangRequest.contentHash !== computedProblemContentHash ||
    anklangRequest.contentHash !== taskDraft.problem.contentHash ||
    JSON.stringify(anklangRequest.problem) !== JSON.stringify({
      title: taskDraft.problem.title,
      type: taskDraft.problem.type,
      tagIds: taskDraft.problem.tagIds,
      basicStatement: taskDraft.problem.content.basicStatement
    }) ||
    hashCanonicalValue(taskDraft.tagCatalog) !==
      hashCanonicalValue({
        version: input.tagCatalog.version,
        tags: input.tagCatalog.tags
      })
  ) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_CASE_BINDING_MISMATCH");
  }
  const captureCase = input.anklangCapture.cases.get(planCase.caseId);
  if (
    captureCase === undefined ||
    captureCase.requestId !== anklangRequest.requestId ||
    captureCase.requestSha256 !== planCase.originalAnklangRequest.sha256 ||
    captureCase.requestSha256 !== sha256(anklangRequestBytes) ||
    captureCase.responseSha256 !== planCase.originalAnklangResponse.sha256 ||
    captureCase.responseSha256 !== sha256(anklangBytes)
  ) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_CAPTURE_CASE_MISMATCH");
  }
  if (
    mapping.evaluationScope === "verdict_and_taste" &&
    !upstream.row.reviewCommentPresent &&
    (mapping.observedHistoricalTasteReasons.length > 0 ||
      mapping.observedHistoricalTechnicalReasons.length > 0)
  ) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_MAPPING_INVALID");
  }

  const normalizedAnklang = {
    ...anklang,
    reuse: { policy: "no-store" as const }
  };
  const task: RobotReviewTask = robotReviewTaskSchema.parse({
    ...taskDraft,
    reviewItems: [
      {
        id: `anklang-${planCase.originalAnklangResponse.sha256.slice(0, 32)}`,
        type: anklangSimilarityReviewItemType,
        source: "anklang",
        sourcePluginId: robotAnklangPluginId,
        visibility: "reviewer",
        summary: input.anklangCapture.corpusEvidenceKind ===
            "reproducible_snapshot"
          ? "离线完整查重快照（语料已绑定）"
          : "离线完整查重响应（远端语料不可复核）",
        data: normalizedAnklang,
        contentHash: taskDraft.problem.contentHash,
        expiresAt: null,
        createdAt: anklang.checkedAt
      }
    ]
  });
  const generatedAnklang = task.reviewItems[0]?.data as Record<string, unknown>;
  if (
    JSON.stringify(generatedAnklang.candidates) !==
      JSON.stringify(anklang.candidates) ||
    JSON.stringify(generatedAnklang.recommendation) !==
      JSON.stringify(anklang.recommendation) ||
    generatedAnklang.contentHash !== anklang.contentHash ||
    (generatedAnklang.completion as { status?: unknown } | undefined)?.status !==
      "complete"
  ) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_PRESERVATION_FAILED");
  }
  const contentBytes = prettyJsonBytes(task);
  const contentSha256 = sha256(contentBytes);
  const sourceLineageSha256 = hashCanonicalValue({
    protocol: "review-flow-evaluation-source-lineage-v4",
    bridgeVersion,
    generator: input.generator,
    identity: {
      upstreamCaseId: planCase.caseId,
      subjectId: planCase.subjectId
    },
    source: {
      sourceId: planCase.sourceId,
      sourcePath: upstream.source.sourcePath,
      materializedSourceSha256: planCase.sourceSha256
    },
    task: {
      taskDraftSha256: planCase.taskDraft.sha256,
      problemHashInputSha256: planCase.problemHashInput.sha256,
      problemContentHash: task.problem.contentHash,
      outputContentSha256: contentSha256,
      originalAnklangRequestSha256:
        planCase.originalAnklangRequest.sha256,
      originalAnklangResponseSha256:
        planCase.originalAnklangResponse.sha256
    },
    anklangCapture: {
      attestationSha256: input.anklangCapture.attestationSha256,
      completionSha256: input.anklangCapture.completionSha256,
      corpusEvidenceKind: input.anklangCapture.corpusEvidenceKind
    }
  });
  const bridgeEvidence = {
    bridgeVersion,
    verificationAttestationSha256: input.attestationSha256,
    bridgePlanSha256: input.bridgePlanSha256,
    reviewGoldEvidenceSha256: input.upstreamSet.evidenceSha256,
    sourceBindingsSha256: input.upstreamSet.bindingsSha256,
    upstreamGoldSha256: upstream.goldSha256,
    worksheetSha256: input.upstreamSet.worksheetSha256,
    inspectionSha256: input.upstreamSet.inspectionSha256,
    layoutSha256: input.upstreamSet.layoutSha256,
    reviewInputSetSha256: input.upstreamSet.inputSetSha256,
    humanMappingSha256: planCase.humanMapping.sha256,
    anklangCaptureAttestationSha256:
      input.anklangCapture.attestationSha256,
    anklangCaptureCompletionSha256:
      input.anklangCapture.completionSha256,
    anklangRequestSha256: planCase.originalAnklangRequest.sha256,
    anklangResponseSha256: planCase.originalAnklangResponse.sha256,
    anklangCorpusEvidenceKind: input.anklangCapture.corpusEvidenceKind
  } as const;
  const gold = buildGold({
    safeId: planCase.safeId,
    subjectId: planCase.subjectId,
    sourceLineageSha256,
    contentSha256,
    originalAnklangResponseSha256:
      planCase.originalAnklangResponse.sha256,
    sealedEvidenceSha256: input.upstreamSet.markerSha256,
    rowEvidenceSha256: planCase.rowEvidenceSha256,
    bridgeEvidence,
    upstreamGold: upstream.gold,
    mapping
  });
  const goldBytes = prettyJsonBytes(gold);
  return {
    purpose: planCase.purpose,
    safeId: planCase.safeId,
    subjectId: planCase.subjectId,
    sourceLineageSha256,
    originalAnklangResponseSha256:
      planCase.originalAnklangResponse.sha256,
    contentFileName: `${planCase.purpose}-${planCase.safeId}.content.private.json`,
    contentBytes,
    contentSha256,
    originalAnklangRequestSha256:
      planCase.originalAnklangRequest.sha256,
    goldFileName: `${planCase.purpose}-${planCase.safeId}.gold.private.json`,
    goldBytes,
    goldSha256: sha256(goldBytes),
    rowEvidenceSha256: planCase.rowEvidenceSha256,
    sealedEvidenceSha256: input.upstreamSet.markerSha256,
    bridgeEvidence
  };
}

function buildGold(input: {
  readonly safeId: string;
  readonly subjectId: string;
  readonly sourceLineageSha256: string;
  readonly contentSha256: string;
  readonly originalAnklangResponseSha256: string;
  readonly sealedEvidenceSha256: string;
  readonly rowEvidenceSha256: string;
  readonly bridgeEvidence: ReviewFlowEvaluationGold["upstreamEvidence"]["bridgeEvidence"];
  readonly upstreamGold: z.infer<typeof upstreamGoldSchema>;
  readonly mapping: z.infer<typeof reviewFlowEvaluationHumanMappingSchema>;
}): ReviewFlowEvaluationGold {
  const common = {
    schemaVersion: 2 as const,
    safeId: input.safeId,
    subjectId: input.subjectId,
    sourceLineageSha256: input.sourceLineageSha256,
    contentSha256: input.contentSha256,
    upstreamEvidence: {
      schemaVersion: 1 as const,
      sealedEvidenceSha256: input.sealedEvidenceSha256,
      rowEvidenceSha256: input.rowEvidenceSha256,
      sourceLineageSha256: input.sourceLineageSha256,
      originalAnklangResponseSha256:
        input.originalAnklangResponseSha256,
      bridgeEvidence: input.bridgeEvidence
    }
  };
  if (
    input.upstreamGold.evaluationScope === "originality_only" &&
    input.mapping.evaluationScope === "originality_only"
  ) {
    return reviewFlowEvaluationGoldSchema.parse({
      ...common,
      evaluationScope: "originality_only",
      originalityAnnotation: "confirmed_duplicate_evidence",
      confirmedDuplicate: true
    });
  }
  if (
    input.upstreamGold.evaluationScope !== "verdict_and_taste" ||
    input.mapping.evaluationScope !== "verdict_and_taste"
  ) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_MAPPING_INVALID");
  }
  return reviewFlowEvaluationGoldSchema.parse({
    ...common,
    evaluationScope: "verdict_and_taste",
    historicalOutcome: input.upstreamGold.verdict,
    contestUse: input.upstreamGold.contestUse,
    observedHistoricalTasteReasons:
      input.mapping.observedHistoricalTasteReasons,
    observedHistoricalTechnicalReasons:
      input.mapping.observedHistoricalTechnicalReasons,
    ...(input.mapping.independentVerdict === undefined
      ? {}
      : { independentVerdict: input.mapping.independentVerdict }),
    ...(input.mapping.independentTaste === undefined
      ? {}
      : { independentTaste: input.mapping.independentTaste }),
    ...(input.mapping.independentOriginality === undefined
      ? {}
      : { independentOriginality: input.mapping.independentOriginality }),
    ...(input.mapping.expectedTagIds === undefined
      ? {}
      : { expectedTagIds: input.mapping.expectedTagIds }),
    ...(input.mapping.independentDifficulty === undefined
      ? {}
      : { independentDifficulty: input.mapping.independentDifficulty })
  });
}

function buildRevealDescriptor(
  manifest: ReviewFlowEvaluationManifest,
  purpose: ReviewFlowEvaluationPurpose,
  cases: readonly PreparedCase[],
  commitmentNonce: string
) {
  return reviewFlowEvaluationRevealDescriptorSchema.parse({
    schemaVersion: 1,
    artifactKind: "review_flow_evaluation_reveal_descriptor",
    protocolVersion: "review-flow-evaluation-reveal-v1",
    datasetId: manifest.datasetId,
    purpose,
    predictionBindingSha256: purpose === "development"
      ? reviewFlowEvaluationDevelopmentPredictionBindingSha256(manifest)
      : reviewFlowEvaluationHoldoutPredictionBindingSha256(manifest),
    commitmentNonce,
    cases: cases.map((entry) => ({
      safeId: entry.safeId,
      subjectId: entry.subjectId,
      sourceLineageSha256: entry.sourceLineageSha256,
      contentSha256: entry.contentSha256,
      upstreamEvidence: {
        sealedEvidenceSha256: entry.sealedEvidenceSha256,
        rowEvidenceSha256: entry.rowEvidenceSha256,
        originalAnklangResponseSha256:
          entry.originalAnklangResponseSha256,
        bridgeEvidence: entry.bridgeEvidence
      },
      gold: {
        fileName: entry.goldFileName,
        sha256: entry.goldSha256
      }
    }))
  });
}

function upstreamGoldMatchesPlan(
  gold: z.infer<typeof upstreamGoldSchema>,
  plan: z.infer<typeof upstreamPlanCaseSchema>
): boolean {
  if (
    gold.evaluationScope === "originality_only" &&
    plan.evaluationScope === "originality_only"
  ) {
    return gold.sameProblemAsExisting === plan.sameProblemAsExisting;
  }
  return gold.evaluationScope === "verdict_and_taste" &&
    plan.evaluationScope === "verdict_and_taste" &&
    gold.verdict === plan.verdict &&
    gold.contestUse === plan.contestUse;
}

function rowEvidenceSha256(row: z.infer<typeof worksheetRowSchema>): string {
  return compactSha256({
    version: 1,
    inputId: row.inputId,
    worksheetId: row.worksheetId,
    sourceRowNumber: row.sourceRowNumber,
    metadataNumber: row.metadataNumber,
    identityValues: row.identityValues,
    finalDecisionText: row.finalDecisionText,
    contestUseText: row.contestUseText,
    reviewComments: row.reviewComments,
    reviewCommentPresent: row.reviewCommentPresent
  });
}

/** 与 Urmotiv apps/api/src/database-store.ts 的字段顺序逐项一致。 */
export function computeUrmotivProblemContentHash(
  input: z.infer<typeof reviewFlowEvaluationProblemHashInputSchema>
): string {
  return sha256(Buffer.from(JSON.stringify({
    title: input.title,
    type: input.type,
    tagIds: input.tagIds,
    codeforcesDifficulty: input.codeforcesDifficulty,
    thinkingLevel: input.thinkingLevel,
    codingLevel: input.codingLevel,
    content: input.content,
    samples: input.samples,
    judgeConfig: input.judgeConfig ?? null,
    status: input.status
  }), "utf8"));
}

function taskMatchesProblemHashInput(
  task: RobotReviewTask,
  input: z.infer<typeof reviewFlowEvaluationProblemHashInputSchema>
): boolean {
  return task.problem.title === input.title &&
    task.problem.type === input.type &&
    JSON.stringify(task.problem.tagIds) === JSON.stringify(input.tagIds) &&
    JSON.stringify(task.problem.content) === JSON.stringify(input.content) &&
    JSON.stringify(task.problem.samples) === JSON.stringify(
      input.samples.map((sample, index) => ({
        safeId: `sample-${String(index + 1).padStart(3, "0")}`,
        input: sample.input,
        output: sample.output,
        explanation: sample.explanation
      }))
    ) &&
    JSON.stringify(task.problem.limits) === JSON.stringify(
      input.judgeConfig?.limits ?? null
    );
}

function assertBridgePaths(input: PrepareReviewFlowEvaluationBridgeInput): void {
  const paths = [
    input.bridgePlanPath,
    input.upstreamGoldDirectory,
    input.materializedDirectory,
    input.worksheetPath,
    input.worksheetCompletionPath,
    input.inspectionPath,
    input.layoutPath,
    input.upstreamPlanPath,
    input.tuningHistoryPath,
    ...input.reviewInputPaths,
    input.outputDirectory,
    input.developmentRevealDirectory,
    ...(input.holdoutRevealDirectory === undefined
      ? []
      : [input.holdoutRevealDirectory])
  ];
  if (paths.some((path) => !isAbsolute(path))) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_PATH_INVALID");
  }
  const outputs = [
    resolve(input.outputDirectory),
    resolve(input.developmentRevealDirectory),
    ...(input.holdoutRevealDirectory === undefined
      ? []
      : [resolve(input.holdoutRevealDirectory)])
  ];
  if (new Set(outputs).size !== outputs.length) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_OUTPUT_OVERLAP");
  }
}

function readAbsoluteJson<T>(
  path: string,
  schema: z.ZodType<T>,
  input: Pick<PrepareReviewFlowEvaluationBridgeInput,
    "privateRoot" | "containingWorkspace">,
  maximumBytes: number,
  errorCode: string
): LoadedAbsoluteFile<T> {
  const bytes = readAbsoluteBytes(path, input, maximumBytes);
  return {
    bytes,
    value: parseStrict(bytes, schema, errorCode),
    sha256: sha256(bytes)
  };
}

function readAbsoluteBytes(
  path: string,
  input: Pick<PrepareReviewFlowEvaluationBridgeInput,
    "privateRoot" | "containingWorkspace">,
  maximumBytes: number
): Buffer {
  if (!isAbsolute(path)) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_PATH_INVALID");
  }
  const directory = openExistingPrivateDirectory(dirname(path), runtimeOptions(input));
  try {
    return readPrivateArtifactBytes(directory, basename(path), maximumBytes);
  } finally {
    closePrivateDirectory(directory);
  }
}

function readDirectoryJson<T>(
  directory: PrivateDirectoryHandle,
  fileName: string,
  schema: z.ZodType<T>,
  maximumBytes: number,
  errorCode: string
): LoadedAbsoluteFile<T> {
  const bytes = readPrivateArtifactBytes(directory, fileName, maximumBytes);
  return {
    bytes,
    value: parseStrict(bytes, schema, errorCode),
    sha256: sha256(bytes)
  };
}

function readBoundInput(
  directory: PrivateDirectoryHandle,
  binding: z.infer<typeof fileBindingSchema>,
  maximumBytes: number,
  errorCode: string
): Buffer {
  const bytes = readPrivateArtifactBytes(
    directory,
    binding.fileName,
    maximumBytes
  );
  if (sha256(bytes) !== binding.sha256) fail(errorCode);
  return bytes;
}

function parseStrict<T>(
  bytes: Buffer,
  schema: z.ZodType<T>,
  errorCode: string
): T {
  try {
    const parsed = schema.safeParse(
      parsePhysicalBlindJson(bytes.toString("utf8"))
    );
    if (!parsed.success) fail(errorCode);
    return parsed.data;
  } catch {
    fail(errorCode);
  }
}

function prepareNewOutputDirectory(
  path: string,
  input: Pick<PrepareReviewFlowEvaluationBridgeInput,
    "privateRoot" | "containingWorkspace">
): PrivateDirectoryHandle {
  const directory = preparePrivateDirectory(path, runtimeOptions(input));
  if (!directory.created) {
    closePrivateDirectory(directory);
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_OUTPUT_EXISTS");
  }
  assertExactDirectoryInventory(directory, new Set());
  return directory;
}

function publish(
  directory: PrivateDirectoryHandle,
  fileName: string,
  bytes: Buffer,
  stage: ReviewFlowEvaluationBridgeStage,
  hooks: ReviewFlowEvaluationBridgeHooks | undefined
): void {
  writePrivateArtifactExclusive(directory, fileName, bytes.toString("utf8"));
  const readBack = readPrivateArtifactBytes(
    directory,
    fileName,
    Math.max(1, bytes.byteLength)
  );
  if (!readBack.equals(bytes)) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_PUBLICATION_MISMATCH");
  }
  hooks?.afterArtifactWrite?.(stage, fileName);
}

function assertExactDirectoryInventory(
  directory: PrivateDirectoryHandle,
  expectedFiles: ReadonlySet<string>,
  expectedDirectories: ReadonlySet<string> = new Set()
): void {
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const entry of readdirSync(`/proc/self/fd/${directory.descriptor}`, {
    withFileTypes: true
  })) {
    if (entry.isFile()) files.add(entry.name);
    else if (entry.isDirectory()) directories.add(entry.name);
    else fail("REVIEW_FLOW_EVALUATION_BRIDGE_DIRECTORY_INVENTORY_INVALID");
  }
  if (
    !setEquals(files, expectedFiles) ||
    !setEquals(directories, expectedDirectories)
  ) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_DIRECTORY_INVENTORY_INVALID");
  }
}

function assertPreparedCaseSeparation(cases: readonly PreparedCase[]): void {
  for (const selector of [
    (entry: PreparedCase) => entry.safeId,
    (entry: PreparedCase) => entry.subjectId,
    (entry: PreparedCase) => entry.sourceLineageSha256,
    (entry: PreparedCase) => entry.originalAnklangRequestSha256,
    (entry: PreparedCase) => entry.originalAnklangResponseSha256,
    (entry: PreparedCase) => entry.contentSha256,
    (entry: PreparedCase) => entry.contentFileName,
    (entry: PreparedCase) => entry.goldFileName
  ]) {
    assertUnique(cases.map(selector));
  }
}

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_IDENTITY_DUPLICATE");
  }
}

function uniqueMap<T>(
  values: readonly T[],
  key: (value: T) => string,
  errorCode: string
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const identity = key(value);
    if (result.has(identity)) fail(errorCode);
    result.set(identity, value);
  }
  return result;
}

function requireMapEntry<T>(map: ReadonlyMap<string, T>, key: string): T {
  const value = map.get(key);
  if (value === undefined) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_CASE_BINDING_MISMATCH");
  }
  return value;
}

function readNonce(random: (size: number) => Uint8Array): string {
  let bytes: Uint8Array;
  try {
    bytes = random(32);
  } catch {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_RANDOMNESS_INVALID");
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_RANDOMNESS_INVALID");
  }
  return Buffer.from(bytes).toString("hex");
}

function prettyJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function compactSha256(value: unknown): string {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

function decodeStrictUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("REVIEW_FLOW_EVALUATION_BRIDGE_MATERIALIZATION_INVALID");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function runtimeOptions(input: Pick<PrepareReviewFlowEvaluationBridgeInput,
  "privateRoot" | "containingWorkspace">) {
  return {
    privateRoot: input.privateRoot,
    containingWorkspace: input.containingWorkspace
  };
}

function setEquals<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function fail(code: string): never {
  throw new ReviewFlowEvaluationBridgeError(code);
}
