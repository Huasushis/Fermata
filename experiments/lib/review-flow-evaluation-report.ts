/** 只生成聚合计分与不透明 case 编号；绝不序列化题面、题解、理由文本或模型文本。 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  reviewFlowCalibrationProjectionSchema,
  type ReviewFlowCalibrationProjection
} from "../../src/review-flow/orchestrator";
import { reviewVerdictSchema } from "../../src/urmotiv-schemas";
import {
  reviewFlowEvaluationDatasetSummarySchema,
  reviewFlowEvaluationDigestSchema,
  reviewFlowEvaluationLabelSchema,
  reviewFlowEvaluationSafeIdSchema,
  reviewFlowEvaluationTechnicalReasonSchema,
  type ReviewFlowEvaluationDatasetBundle,
  type ReviewFlowEvaluationDatasetCase,
  type ReviewFlowEvaluationGold,
  type ReviewFlowEvaluationTechnicalReason
} from "./review-flow-evaluation-dataset";
import {
  reviewFlowEvaluationBaselineBindingSchema,
  reviewFlowEvaluationIdentitySchema,
  type ReviewFlowEvaluationCheckpointState,
  type ReviewFlowEvaluationEntry
} from "./review-flow-evaluation-state";
import {
  parsePhysicalBlindJson,
  parseVersionedStrictArtifact,
  serializePhysicalBlindArtifact
} from "./physical-blind-common";

const verdicts = reviewVerdictSchema.options;
type Verdict = (typeof verdicts)[number];
const digestSchema = reviewFlowEvaluationDigestSchema;
const timestampSchema = z.string().datetime();
const nullableRateSchema = z.number().finite().min(0).max(1).nullable();

export const reviewFlowEvaluationSetMetricsSchema = z
  .object({
    scoredCaseCount: z.number().int().nonnegative(),
    truePositive: z.number().int().nonnegative(),
    falsePositive: z.number().int().nonnegative(),
    falseNegative: z.number().int().nonnegative(),
    exactSetMatches: z.number().int().nonnegative(),
    exactSetRate: nullableRateSchema,
    precision: nullableRateSchema,
    recall: nullableRateSchema,
    f1: nullableRateSchema
  })
  .strict();
export type SetMetrics = z.infer<typeof reviewFlowEvaluationSetMetricsSchema>;

const threeWayMatrixSchema = z
  .object({
    approve: z
      .object({
        approve: z.number().int().nonnegative(),
        request_changes: z.number().int().nonnegative(),
        reject: z.number().int().nonnegative()
      })
      .strict(),
    request_changes: z
      .object({
        approve: z.number().int().nonnegative(),
        request_changes: z.number().int().nonnegative(),
        reject: z.number().int().nonnegative()
      })
      .strict(),
    reject: z
      .object({
        approve: z.number().int().nonnegative(),
        request_changes: z.number().int().nonnegative(),
        reject: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();

const binaryOutcomeMetricSchema = z
  .object({
    scoredCaseCount: z.number().int().nonnegative(),
    confusionMatrix: z
      .object({
        accepted: z
          .object({
            accepted: z.number().int().nonnegative(),
            not_accepted: z.number().int().nonnegative()
          })
          .strict(),
        rejected: z
          .object({
            accepted: z.number().int().nonnegative(),
            not_accepted: z.number().int().nonnegative()
          })
          .strict()
      })
      .strict(),
    exactMatches: z.number().int().nonnegative(),
    accuracy: nullableRateSchema
  })
  .strict();

const independentVerdictMetricSchema = z
  .object({
    scoredCaseCount: z.number().int().nonnegative(),
    confusionMatrix: threeWayMatrixSchema,
    exactMatches: z.number().int().nonnegative(),
    accuracy: nullableRateSchema
  })
  .strict();

const sparseRecallMetricSchema = z
  .object({
    scoredCaseCount: z.number().int().nonnegative(),
    observedReasonCount: z.number().int().nonnegative(),
    matchedReasonCount: z.number().int().nonnegative(),
    recall: nullableRateSchema
  })
  .strict();

const originalityMetricSchema = z
  .object({
    scoredCaseCount: z.number().int().nonnegative(),
    exactMatches: z.number().int().nonnegative(),
    accuracy: nullableRateSchema,
    truePositive: z.number().int().nonnegative(),
    falsePositive: z.number().int().nonnegative(),
    falseNegative: z.number().int().nonnegative(),
    trueNegative: z.number().int().nonnegative()
  })
  .strict();

const difficultyMetricSchema = z
  .object({
    scoredCaseCount: z.number().int().nonnegative(),
    codeforcesMae: z.number().finite().nonnegative().nullable(),
    withinTwoHundredRate: nullableRateSchema,
    thinkingExactRate: nullableRateSchema,
    codingExactRate: nullableRateSchema
  })
  .strict();

const contestUseStratumSchema = z
  .object({
    scoredCaseCount: z.number().int().nonnegative(),
    exactMatches: z.number().int().nonnegative(),
    accuracy: nullableRateSchema
  })
  .strict();

const contestUseMetricSchema = z
  .object({
    predictionRule: z.literal("icpc_fit_strong_or_acceptable"),
    coverage: z
      .object({
        used: z.number().int().nonnegative(),
        not_used: z.number().int().nonnegative(),
        unknown: z.number().int().nonnegative(),
        historicalAccepted: z.number().int().nonnegative(),
        historicalRejected: z.number().int().nonnegative(),
        usedAndAccepted: z.number().int().nonnegative(),
        usedAndRejected: z.number().int().nonnegative(),
        notUsedAndAccepted: z.number().int().nonnegative(),
        notUsedAndRejected: z.number().int().nonnegative()
      })
      .strict(),
    knownUseBinary: z
      .object({
        scoredCaseCount: z.number().int().nonnegative(),
        confusionMatrix: z
          .object({
            used: z
              .object({
                used: z.number().int().nonnegative(),
                not_used: z.number().int().nonnegative()
              })
              .strict(),
            not_used: z
              .object({
                used: z.number().int().nonnegative(),
                not_used: z.number().int().nonnegative()
              })
              .strict()
          })
          .strict(),
        exactMatches: z.number().int().nonnegative(),
        accuracy: nullableRateSchema
      })
      .strict(),
    byHistoricalOutcome: z
      .object({
        accepted: contestUseStratumSchema,
        rejected: contestUseStratumSchema
      })
      .strict()
  })
  .strict();

const caseCountsSchema = z
  .object({
    expected: z.number().int().positive(),
    pending: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    notStarted: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    http499: z.number().int().nonnegative(),
    unaccounted: z.number().int().nonnegative(),
    expectedEqualsTerminal: z.boolean()
  })
  .strict();

/** 全部案例/角色/尝试的耐久账本；任一字段缺失都必须让摘要不完整。 */
const accountingSchema = z
  .object({
    logicalRequests: z.number().int().nonnegative(),
    transportAttempts: z.number().int().nonnegative(),
    receivedByteResponses: z.number().int().nonnegative(),
    retries: z.number().int().nonnegative(),
    schemaErrors: z.number().int().nonnegative(),
    formatterCorrections: z.number().int().nonnegative(),
    repairCount: z.number().int().nonnegative()
  })
  .strict();

const failureRowSchema = z
  .object({
    code: z.string().regex(/^[A-Z0-9_]{1,120}$/u),
    failureKind: z.string().regex(/^[a-z_]{1,120}$/u).nullable(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    count: z.number().int().positive()
  })
  .strict();

const caseResultSchema = z
  .object({
    safeId: reviewFlowEvaluationSafeIdSchema,
    scope: z.enum(["verdict_and_taste", "originality_only"]),
    status: z.enum(["not_started", "interrupted", "failed", "completed"]),
    historicalOutcome: z.enum(["accepted", "rejected"]).nullable(),
    predictedHistoricalOutcome: z.enum(["accepted", "not_accepted"]).nullable(),
    independentVerdict: reviewVerdictSchema.nullable(),
    predictedVerdict: reviewVerdictSchema.nullable(),
    contestUse: z.enum(["used", "not_used", "unknown"]).nullable(),
    predictedContestUse: z.enum(["used", "not_used"]).nullable(),
    independentlyLabeledDuplicate: z.boolean().nullable(),
    predictedDuplicate: z.boolean().nullable(),
    failureCode: z.string().regex(/^[A-Z0-9_]{1,120}$/u).nullable()
  })
  .strict();

export const reviewFlowEvaluationReportSummarySchema = z
  .object({
    schemaVersion: z.literal(2),
    protocolVersion: z.literal("review-flow-evaluation-v2"),
    label: reviewFlowEvaluationLabelSchema,
    variant: z.enum(["baseline", "candidate"]),
    baselineLabel: reviewFlowEvaluationLabelSchema.nullable(),
    baselineBinding: reviewFlowEvaluationBaselineBindingSchema.nullable(),
    runId: z.string().uuid(),
    dataset: z
      .object({
        safeId: z.string().regex(/^dataset-[0-9a-f]{16}$/u),
        purpose: z.enum(["development", "holdout"]),
        fingerprint: digestSchema,
        manifestSha256: digestSchema,
        bridgeCompletionSha256: digestSchema,
        holdoutIdentity: digestSchema.nullable(),
        tagCatalogSha256: digestSchema,
        tagCatalogVersion: z.number().int().positive(),
        goldSummary: reviewFlowEvaluationDatasetSummarySchema
      })
      .strict(),
    executionIdentity: reviewFlowEvaluationIdentitySchema,
    executionCompletionFingerprint: digestSchema,
    caseCounts: caseCountsSchema,
    accounting: accountingSchema,
    terminationSignal: z.enum(["SIGINT", "SIGTERM", "SIGHUP"]).nullable(),
    receiptCoverage: z
      .object({
        completedCaseCount: z.number().int().nonnegative(),
        completeElevenRoleReceiptCaseCount: z.number().int().nonnegative(),
        totalReceiptCount: z.number().int().nonnegative()
      })
      .strict(),
    failures: z.array(failureRowSchema),
    caseResults: z.array(caseResultSchema).min(1).max(1_000),
    scoring: z
      .object({
        valid: z.boolean(),
        historicalOutcomeBinary: binaryOutcomeMetricSchema,
        independentThreeWayVerdict: independentVerdictMetricSchema,
        exhaustiveIndependentTasteReasons: reviewFlowEvaluationSetMetricsSchema,
        observedHistoricalTasteReasons: sparseRecallMetricSchema,
        observedHistoricalTechnicalReasons: sparseRecallMetricSchema,
        originality: originalityMetricSchema,
        independentDifficulty: difficultyMetricSchema,
        tags: reviewFlowEvaluationSetMetricsSchema,
        contestUse: contestUseMetricSchema
      })
      .strict(),
    complete: z.boolean(),
    eligible: z.literal(false),
    eligibilityReason: z.enum([
      "evaluation_incomplete",
      "accuracy_threshold_policy_not_approved"
    ]),
    generatedAt: timestampSchema
  })
  .strict()
  .superRefine((summary, context) => {
    if (
      summary.scoring.valid !== summary.complete ||
      summary.eligibilityReason !==
        (summary.complete
          ? "accuracy_threshold_policy_not_approved"
          : "evaluation_incomplete") ||
      summary.receiptCoverage.completedCaseCount !== summary.caseCounts.completed ||
      summary.caseResults.length !== summary.caseCounts.expected ||
      summary.caseCounts.expectedEqualsTerminal !== true ||
      summary.caseCounts.unaccounted !== 0 ||
      summary.accounting.logicalRequests <
        summary.accounting.receivedByteResponses ||
      summary.accounting.transportAttempts <
        summary.accounting.receivedByteResponses ||
      (summary.dataset.purpose === "development" &&
        summary.dataset.holdoutIdentity !== null) ||
      (summary.dataset.purpose === "holdout" &&
        summary.dataset.holdoutIdentity === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["complete"],
        message: "报告完整性、收据覆盖或资格状态不一致。"
      });
    }
  });
export type ReviewFlowEvaluationReportSummary = z.infer<
  typeof reviewFlowEvaluationReportSummarySchema
>;

const comparisonMetricSnapshotSchema = z
  .object({
    historicalOutcomeAccuracy: nullableRateSchema,
    independentVerdictAccuracy: nullableRateSchema,
    exhaustiveTasteF1: nullableRateSchema,
    observedTasteRecall: nullableRateSchema,
    observedTechnicalRecall: nullableRateSchema,
    originalityAccuracy: nullableRateSchema,
    contestUseAccuracy: nullableRateSchema,
    codeforcesMae: z.number().finite().nonnegative().nullable(),
    tagsF1: nullableRateSchema
  })
  .strict();

const comparisonMetricDeltaSchema = z
  .object({
    historicalOutcomeAccuracy: z.number().finite().nullable(),
    independentVerdictAccuracy: z.number().finite().nullable(),
    exhaustiveTasteF1: z.number().finite().nullable(),
    observedTasteRecall: z.number().finite().nullable(),
    observedTechnicalRecall: z.number().finite().nullable(),
    originalityAccuracy: z.number().finite().nullable(),
    contestUseAccuracy: z.number().finite().nullable(),
    codeforcesMae: z.number().finite().nullable(),
    tagsF1: z.number().finite().nullable()
  })
  .strict();

export const reviewFlowEvaluationComparisonSchema = z
  .object({
    schemaVersion: z.literal(2),
    protocolVersion: z.literal("review-flow-evaluation-v2"),
    holdoutIdentity: digestSchema,
    thresholdPolicySha256: digestSchema,
    baseline: z
      .object({
        label: reviewFlowEvaluationLabelSchema,
        runId: z.string().uuid(),
        reportSha256: digestSchema,
        metrics: comparisonMetricSnapshotSchema
      })
      .strict(),
    candidate: z
      .object({
        label: reviewFlowEvaluationLabelSchema,
        runId: z.string().uuid(),
        reportSha256: digestSchema,
        metrics: comparisonMetricSnapshotSchema
      })
      .strict(),
    candidateMinusBaseline: comparisonMetricDeltaSchema,
    complete: z.literal(true),
    eligible: z.literal(false),
    eligibilityReason: z.literal("accuracy_threshold_policy_not_approved"),
    generatedAt: timestampSchema
  })
  .strict();
export type ReviewFlowEvaluationComparison = z.infer<
  typeof reviewFlowEvaluationComparisonSchema
>;

export function buildReviewFlowEvaluationReport(input: {
  readonly dataset: ReviewFlowEvaluationDatasetBundle;
  readonly checkpoint: ReviewFlowEvaluationCheckpointState;
  /** 兼容旧调用；若提供也必须精确等于 checkpoint.executionSeal.sealedAt。 */
  readonly generatedAt?: string;
}): {
  readonly summary: ReviewFlowEvaluationReportSummary;
  readonly json: string;
  readonly markdown: string;
  readonly sha256: string;
} {
  assertReportBindings(input.dataset, input.checkpoint);
  const generatedAt = input.checkpoint.executionSeal!.sealedAt;
  if (input.generatedAt !== undefined && input.generatedAt !== generatedAt) {
    throw new Error("REVIEW_FLOW_EVALUATION_REPORT_TIME_INVALID");
  }
  const entries = new Map(
    input.checkpoint.entries.map((entry) => [entry.safeId, entry])
  );
  const caseResults = input.dataset.cases.map((evaluationCase) =>
    buildCaseResult(
      evaluationCase,
      revealedGold(evaluationCase),
      entries.get(evaluationCase.safeId)!
    )
  );
  const terminalStatusCounts = {
    pending: 0,
    active: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    http499: 0
  };
  const accounting = {
    logicalRequests: 0,
    transportAttempts: 0,
    receivedByteResponses: 0,
    retries: 0,
    schemaErrors: 0,
    formatterCorrections: 0,
    repairCount: 0
  };
  for (const entry of input.checkpoint.entries) {
    if (entry.status === "completed") {
      terminalStatusCounts.completed += 1;
      for (const receipt of entry.projection.roleReceipts) {
        accounting.logicalRequests += receipt.requestCount;
        accounting.transportAttempts += receipt.transportAttemptCount;
        accounting.receivedByteResponses += receipt.responses.length;
      }
      continue;
    }
    if (entry.status === "failed") {
      terminalStatusCounts.failed += 1;
      const httpStatus = entry.failure.httpStatus;
      if (httpStatus === 499) terminalStatusCounts.http499 += 1;
      if (entry.failure.failureKind === "cancelled") {
        terminalStatusCounts.cancelled += 1;
      }
      for (const roleFailure of entry.failure.failedRoles) {
        accounting.logicalRequests += roleFailure.requestCount;
        accounting.transportAttempts += roleFailure.transportAttemptCount;
        accounting.receivedByteResponses += roleFailure.completedResponseCount;
        accounting.retries += Math.max(
          0,
          roleFailure.transportAttemptCount - roleFailure.requestCount
        );
        if (roleFailure.failureKind === "schema_output") {
          accounting.schemaErrors += 1;
        }
      }
      continue;
    }
    if (entry.status === "active") terminalStatusCounts.active += 1;
    if (entry.status === "pending") terminalStatusCounts.pending += 1;
  }
  const counts = {
    expected: input.checkpoint.entries.length,
    pending: terminalStatusCounts.pending,
    active: terminalStatusCounts.active,
    completed: terminalStatusCounts.completed,
    failed: terminalStatusCounts.failed,
    notStarted: terminalStatusCounts.pending,
    skipped: 0,
    cancelled: terminalStatusCounts.cancelled,
    http499: terminalStatusCounts.http499,
    unaccounted: Math.max(
      0,
      input.checkpoint.entries.length -
        (terminalStatusCounts.pending +
          terminalStatusCounts.active +
          terminalStatusCounts.completed +
          terminalStatusCounts.failed)
    ),
    expectedEqualsTerminal:
      terminalStatusCounts.pending +
        terminalStatusCounts.active +
        terminalStatusCounts.completed +
        terminalStatusCounts.failed ===
      input.checkpoint.entries.length
  };
  const complete = input.checkpoint.executionSeal!.complete;
  const completed = completedProjectionMap(input.checkpoint.entries);
  const summary = reviewFlowEvaluationReportSummarySchema.parse({
    schemaVersion: 2,
    protocolVersion: "review-flow-evaluation-v2",
    label: input.checkpoint.label,
    variant: input.checkpoint.variant,
    baselineLabel: input.checkpoint.baselineLabel,
    baselineBinding: input.checkpoint.baselineBinding,
    runId: input.checkpoint.runId,
    dataset: {
      safeId: input.dataset.datasetId,
      purpose: input.dataset.purpose,
      fingerprint: input.dataset.datasetFingerprint,
      manifestSha256: input.dataset.manifestSha256,
      bridgeCompletionSha256: input.dataset.bridgeCompletionSha256,
      holdoutIdentity: input.dataset.holdoutIdentity,
      tagCatalogSha256: input.dataset.tagCatalogSha256,
      tagCatalogVersion: input.dataset.tagCatalogVersion,
      goldSummary: input.dataset.summary
    },
    executionIdentity: input.checkpoint.identity,
    executionCompletionFingerprint:
      input.checkpoint.executionSeal!.completionFingerprint,
    caseCounts: counts,
    accounting,
    terminationSignal: input.checkpoint.termination?.signal ?? null,
    receiptCoverage: {
      completedCaseCount: counts.completed,
      completeElevenRoleReceiptCaseCount: input.checkpoint.entries.filter(
        (entry) =>
          entry.status === "completed" &&
          reviewFlowCalibrationProjectionSchema.safeParse(entry.projection).success &&
          entry.projection.roleReceipts.length === 11
      ).length,
      totalReceiptCount: input.checkpoint.entries.reduce(
        (sum, entry) =>
          entry.status === "completed"
            ? sum + entry.projection.roleReceipts.length
            : sum,
        0
      )
    },
    failures: aggregateFailures(input.checkpoint.entries, input.checkpoint.termination),
    caseResults,
    scoring: {
      valid: complete,
      historicalOutcomeBinary: scoreHistoricalOutcomes(
        input.dataset.cases,
        completed,
        complete
      ),
      independentThreeWayVerdict: scoreIndependentVerdicts(
        input.dataset.cases,
        completed,
        complete
      ),
      exhaustiveIndependentTasteReasons: scoreExhaustiveTasteReasons(
        input.dataset.cases,
        completed,
        complete
      ),
      observedHistoricalTasteReasons: scoreObservedHistoricalTasteReasons(
        input.dataset.cases,
        completed,
        complete
      ),
      observedHistoricalTechnicalReasons: scoreObservedHistoricalTechnicalReasons(
        input.dataset.cases,
        completed,
        complete
      ),
      originality: scoreOriginality(input.dataset.cases, completed, complete),
      independentDifficulty: scoreIndependentDifficulty(
        input.dataset.cases,
        completed,
        complete
      ),
      tags: scoreTags(input.dataset.cases, completed, complete),
      contestUse: scoreContestUse(input.dataset.cases, completed, complete)
    },
    complete,
    eligible: false,
    eligibilityReason: complete
      ? "accuracy_threshold_policy_not_approved"
      : "evaluation_incomplete",
    generatedAt
  });
  const json = serializePhysicalBlindArtifact(summary);
  return {
    summary,
    json,
    markdown: buildMarkdown(summary),
    sha256: sha256(json)
  };
}

export function parseReviewFlowEvaluationReportSummary(
  bytes: Buffer
): ReviewFlowEvaluationReportSummary {
  try {
    return parseVersionedStrictArtifact({
      value: parsePhysicalBlindJson(bytes.toString("utf8")),
      schema: reviewFlowEvaluationReportSummarySchema,
      supportedVersions: [2]
    });
  } catch {
    throw new Error("REVIEW_FLOW_EVALUATION_REPORT_SUMMARY_INVALID");
  }
}

export function buildReviewFlowEvaluationComparison(input: {
  readonly holdoutIdentity: string;
  readonly thresholdPolicySha256: string;
  readonly baseline: ReviewFlowEvaluationReportSummary;
  readonly candidate: ReviewFlowEvaluationReportSummary;
  readonly baselineReportSha256: string;
  readonly candidateReportSha256: string;
}): { readonly comparison: ReviewFlowEvaluationComparison; readonly json: string } {
  if (
    input.baseline.dataset.purpose !== "holdout" ||
    input.candidate.dataset.purpose !== "holdout" ||
    input.baseline.dataset.holdoutIdentity !== input.holdoutIdentity ||
    input.candidate.dataset.holdoutIdentity !== input.holdoutIdentity ||
    !input.baseline.complete ||
    !input.candidate.complete
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_COMPARISON_INVALID");
  }
  const baselineMetrics = comparisonMetrics(input.baseline);
  const candidateMetrics = comparisonMetrics(input.candidate);
  const comparison = reviewFlowEvaluationComparisonSchema.parse({
    schemaVersion: 2,
    protocolVersion: "review-flow-evaluation-v2",
    holdoutIdentity: input.holdoutIdentity,
    thresholdPolicySha256: input.thresholdPolicySha256,
    baseline: {
      label: input.baseline.label,
      runId: input.baseline.runId,
      reportSha256: input.baselineReportSha256,
      metrics: baselineMetrics
    },
    candidate: {
      label: input.candidate.label,
      runId: input.candidate.runId,
      reportSha256: input.candidateReportSha256,
      metrics: candidateMetrics
    },
    candidateMinusBaseline: Object.fromEntries(
      Object.keys(baselineMetrics).map((key) => {
        const metric = key as keyof typeof baselineMetrics;
        const before = baselineMetrics[metric];
        const after = candidateMetrics[metric];
        return [metric, before === null || after === null ? null : round(after - before)];
      })
    ),
    complete: true,
    eligible: false,
    eligibilityReason: "accuracy_threshold_policy_not_approved",
    generatedAt: input.candidate.generatedAt
  });
  return {
    comparison,
    json: serializePhysicalBlindArtifact(comparison)
  };
}

function assertReportBindings(
  dataset: ReviewFlowEvaluationDatasetBundle,
  checkpoint: ReviewFlowEvaluationCheckpointState
): void {
  if (
    dataset.summary === null ||
    dataset.cases.some((entry) => entry.gold === null) ||
    checkpoint.executionSeal === null ||
    checkpoint.identity.datasetFingerprint !== dataset.datasetFingerprint ||
    checkpoint.identity.manifestSha256 !== dataset.manifestSha256 ||
    checkpoint.identity.purpose !== dataset.purpose ||
    checkpoint.expectedCases.length !== dataset.cases.length ||
    checkpoint.expectedCases.some((expected, index) => {
      const actual = dataset.cases[index];
      return actual === undefined ||
        expected.safeId !== actual.safeId ||
        expected.subjectId !== actual.subjectId ||
        expected.sourceLineageSha256 !== actual.sourceLineageSha256 ||
        expected.contentSha256 !== actual.contentSha256;
    })
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_REPORT_BINDING_INVALID");
  }
}

function revealedGold(
  evaluationCase: ReviewFlowEvaluationDatasetCase
): ReviewFlowEvaluationGold {
  if (evaluationCase.gold === null) {
    throw new Error("REVIEW_FLOW_EVALUATION_GOLD_NOT_REVEALED");
  }
  return evaluationCase.gold;
}

function completedProjectionMap(
  entries: readonly ReviewFlowEvaluationEntry[]
): ReadonlyMap<string, ReviewFlowCalibrationProjection> {
  return new Map(
    entries.flatMap((entry) =>
      entry.status === "completed"
        ? [[entry.safeId, entry.projection] as const]
        : []
    )
  );
}

function scoreIndependentVerdicts(
  cases: readonly ReviewFlowEvaluationDatasetCase[],
  completed: ReadonlyMap<string, ReviewFlowCalibrationProjection>,
  valid: boolean
): z.infer<typeof independentVerdictMetricSchema> {
  const matrix = makeThreeWayMatrix();
  let exactMatches = 0;
  let scoredCaseCount = 0;
  for (const evaluationCase of cases) {
    const gold = revealedGold(evaluationCase);
    if (
      gold.evaluationScope !== "verdict_and_taste" ||
      gold.independentVerdict === undefined
    ) continue;
    const projection = completed.get(evaluationCase.safeId);
    if (projection === undefined) continue;
    const expected = gold.independentVerdict.verdict;
    scoredCaseCount += 1;
    matrix[expected][projection.verdict] += 1;
    if (expected === projection.verdict) exactMatches += 1;
  }
  return {
    scoredCaseCount,
    confusionMatrix: matrix,
    exactMatches,
    accuracy: valid && scoredCaseCount > 0
      ? ratio(exactMatches, scoredCaseCount)
      : null
  };
}

function scoreHistoricalOutcomes(
  cases: readonly ReviewFlowEvaluationDatasetCase[],
  completed: ReadonlyMap<string, ReviewFlowCalibrationProjection>,
  valid: boolean
): z.infer<typeof binaryOutcomeMetricSchema> {
  const matrix = {
    accepted: { accepted: 0, not_accepted: 0 },
    rejected: { accepted: 0, not_accepted: 0 }
  };
  let exactMatches = 0;
  let scoredCaseCount = 0;
  for (const evaluationCase of cases) {
    const gold = revealedGold(evaluationCase);
    if (gold.evaluationScope !== "verdict_and_taste") continue;
    const projection = completed.get(evaluationCase.safeId);
    if (projection === undefined) continue;
    const predicted = predictHistoricalOutcome(projection);
    const expected = gold.historicalOutcome;
    matrix[expected][predicted] += 1;
    scoredCaseCount += 1;
    if (
      (expected === "accepted" && predicted === "accepted") ||
      (expected === "rejected" && predicted === "not_accepted")
    ) exactMatches += 1;
  }
  return {
    scoredCaseCount,
    confusionMatrix: matrix,
    exactMatches,
    accuracy: valid && scoredCaseCount > 0
      ? ratio(exactMatches, scoredCaseCount)
      : null
  };
}

function scoreExhaustiveTasteReasons(
  cases: readonly ReviewFlowEvaluationDatasetCase[],
  completed: ReadonlyMap<string, ReviewFlowCalibrationProjection>,
  valid: boolean
): SetMetrics {
  const values: { expected: Set<string>; predicted: Set<string> }[] = [];
  for (const evaluationCase of cases) {
    const gold = revealedGold(evaluationCase);
    if (
      gold.evaluationScope !== "verdict_and_taste" ||
      gold.independentTaste === undefined
    ) continue;
    const projection = completed.get(evaluationCase.safeId);
    if (projection === undefined) continue;
    values.push({
      expected: new Set(gold.independentTaste.reasons.map(reasonKey)),
      predicted: predictedTasteReasons(projection)
    });
  }
  return scoreSets(values, valid);
}

function scoreObservedHistoricalTasteReasons(
  cases: readonly ReviewFlowEvaluationDatasetCase[],
  completed: ReadonlyMap<string, ReviewFlowCalibrationProjection>,
  valid: boolean
): z.infer<typeof sparseRecallMetricSchema> {
  let scoredCaseCount = 0;
  let observedReasonCount = 0;
  let matchedReasonCount = 0;
  for (const evaluationCase of cases) {
    const gold = revealedGold(evaluationCase);
    if (
      gold.evaluationScope !== "verdict_and_taste" ||
      gold.observedHistoricalTasteReasons.length === 0
    ) continue;
    const projection = completed.get(evaluationCase.safeId);
    if (projection === undefined) continue;
    scoredCaseCount += 1;
    const predicted = predictedTasteReasons(projection);
    for (const observed of gold.observedHistoricalTasteReasons) {
      observedReasonCount += 1;
      if (predicted.has(reasonKey(observed))) matchedReasonCount += 1;
    }
  }
  return {
    scoredCaseCount,
    observedReasonCount,
    matchedReasonCount,
    recall: valid && observedReasonCount > 0
      ? ratio(matchedReasonCount, observedReasonCount)
      : null
  };
}

function scoreObservedHistoricalTechnicalReasons(
  cases: readonly ReviewFlowEvaluationDatasetCase[],
  completed: ReadonlyMap<string, ReviewFlowCalibrationProjection>,
  valid: boolean
): z.infer<typeof sparseRecallMetricSchema> {
  let scoredCaseCount = 0;
  let observedReasonCount = 0;
  let matchedReasonCount = 0;
  for (const evaluationCase of cases) {
    const gold = revealedGold(evaluationCase);
    if (
      gold.evaluationScope !== "verdict_and_taste" ||
      gold.observedHistoricalTechnicalReasons.length === 0
    ) continue;
    const projection = completed.get(evaluationCase.safeId);
    if (projection === undefined) continue;
    scoredCaseCount += 1;
    const predicted = predictedTechnicalReasons(projection);
    for (const observed of gold.observedHistoricalTechnicalReasons) {
      observedReasonCount += 1;
      if (predicted.has(observed)) matchedReasonCount += 1;
    }
  }
  return {
    scoredCaseCount,
    observedReasonCount,
    matchedReasonCount,
    recall: valid && observedReasonCount > 0
      ? ratio(matchedReasonCount, observedReasonCount)
      : null
  };
}

function scoreTags(
  cases: readonly ReviewFlowEvaluationDatasetCase[],
  completed: ReadonlyMap<string, ReviewFlowCalibrationProjection>,
  valid: boolean
): SetMetrics {
  const values: { expected: Set<string>; predicted: Set<string> }[] = [];
  for (const evaluationCase of cases) {
    const gold = revealedGold(evaluationCase);
    if (
      gold.evaluationScope !== "verdict_and_taste" ||
      gold.expectedTagIds === undefined
    ) continue;
    const projection = completed.get(evaluationCase.safeId);
    if (projection === undefined) continue;
    values.push({
      expected: new Set(gold.expectedTagIds),
      predicted: new Set(projection.tagIds)
    });
  }
  return scoreSets(values, valid);
}

function scoreOriginality(
  cases: readonly ReviewFlowEvaluationDatasetCase[],
  completed: ReadonlyMap<string, ReviewFlowCalibrationProjection>,
  valid: boolean
): z.infer<typeof originalityMetricSchema> {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  for (const evaluationCase of cases) {
    const gold = revealedGold(evaluationCase);
    const expected = gold.evaluationScope === "originality_only"
      ? true
      : gold.independentOriginality?.confirmedDuplicate;
    if (expected === undefined) continue;
    const projection = completed.get(evaluationCase.safeId);
    if (projection === undefined) continue;
    const predicted = projection.originality.sameProblemAsExisting;
    if (expected && predicted) truePositive += 1;
    else if (!expected && predicted) falsePositive += 1;
    else if (expected) falseNegative += 1;
    else trueNegative += 1;
  }
  const scoredCaseCount = truePositive + falsePositive + falseNegative + trueNegative;
  const exactMatches = truePositive + trueNegative;
  return {
    scoredCaseCount,
    exactMatches,
    accuracy: valid && scoredCaseCount > 0
      ? ratio(exactMatches, scoredCaseCount)
      : null,
    truePositive,
    falsePositive,
    falseNegative,
    trueNegative
  };
}

function scoreIndependentDifficulty(
  cases: readonly ReviewFlowEvaluationDatasetCase[],
  completed: ReadonlyMap<string, ReviewFlowCalibrationProjection>,
  valid: boolean
): z.infer<typeof difficultyMetricSchema> {
  const rows: {
    gold: NonNullable<Extract<ReviewFlowEvaluationGold, {
      evaluationScope: "verdict_and_taste";
    }>["independentDifficulty"]>;
    projection: ReviewFlowCalibrationProjection;
  }[] = [];
  for (const evaluationCase of cases) {
    const gold = revealedGold(evaluationCase);
    if (
      gold.evaluationScope !== "verdict_and_taste" ||
      gold.independentDifficulty === undefined
    ) continue;
    const projection = completed.get(evaluationCase.safeId);
    if (projection !== undefined) {
      rows.push({ gold: gold.independentDifficulty, projection });
    }
  }
  const scoreValid = valid && rows.length > 0;
  const absoluteErrors = rows.map((row) =>
    Math.abs(row.gold.codeforcesDifficulty - row.projection.codeforcesDifficulty)
  );
  return {
    scoredCaseCount: rows.length,
    codeforcesMae: scoreValid
      ? round(absoluteErrors.reduce((sum, value) => sum + value, 0) / rows.length)
      : null,
    withinTwoHundredRate: scoreValid
      ? ratio(absoluteErrors.filter((value) => value <= 200).length, rows.length)
      : null,
    thinkingExactRate: scoreValid
      ? ratio(
          rows.filter((row) =>
            row.gold.thinkingLevel === row.projection.thinkingLevel
          ).length,
          rows.length
        )
      : null,
    codingExactRate: scoreValid
      ? ratio(
          rows.filter((row) =>
            row.gold.codingLevel === row.projection.codingLevel
          ).length,
          rows.length
        )
      : null
  };
}

function scoreContestUse(
  cases: readonly ReviewFlowEvaluationDatasetCase[],
  completed: ReadonlyMap<string, ReviewFlowCalibrationProjection>,
  valid: boolean
): z.infer<typeof contestUseMetricSchema> {
  const coverage = {
    used: 0,
    not_used: 0,
    unknown: 0,
    historicalAccepted: 0,
    historicalRejected: 0,
    usedAndAccepted: 0,
    usedAndRejected: 0,
    notUsedAndAccepted: 0,
    notUsedAndRejected: 0
  };
  const matrix = {
    used: { used: 0, not_used: 0 },
    not_used: { used: 0, not_used: 0 }
  };
  const strata = {
    accepted: { scoredCaseCount: 0, exactMatches: 0, accuracy: null as number | null },
    rejected: { scoredCaseCount: 0, exactMatches: 0, accuracy: null as number | null }
  };
  let scoredCaseCount = 0;
  let exactMatches = 0;
  for (const evaluationCase of cases) {
    const gold = revealedGold(evaluationCase);
    if (gold.evaluationScope !== "verdict_and_taste") continue;
    coverage[gold.contestUse] += 1;
    if (gold.historicalOutcome === "accepted") coverage.historicalAccepted += 1;
    else coverage.historicalRejected += 1;
    if (gold.contestUse === "used" && gold.historicalOutcome === "accepted") {
      coverage.usedAndAccepted += 1;
    } else if (gold.contestUse === "used") {
      coverage.usedAndRejected += 1;
    } else if (gold.contestUse === "not_used" && gold.historicalOutcome === "accepted") {
      coverage.notUsedAndAccepted += 1;
    } else if (gold.contestUse === "not_used") {
      coverage.notUsedAndRejected += 1;
    }
    if (gold.contestUse === "unknown") continue;
    const projection = completed.get(evaluationCase.safeId);
    if (projection === undefined) continue;
    const predicted = predictContestUse(projection);
    matrix[gold.contestUse][predicted] += 1;
    scoredCaseCount += 1;
    strata[gold.historicalOutcome].scoredCaseCount += 1;
    if (predicted === gold.contestUse) {
      exactMatches += 1;
      strata[gold.historicalOutcome].exactMatches += 1;
    }
  }
  for (const stratum of Object.values(strata)) {
    stratum.accuracy = valid && stratum.scoredCaseCount > 0
      ? ratio(stratum.exactMatches, stratum.scoredCaseCount)
      : null;
  }
  return {
    predictionRule: "icpc_fit_strong_or_acceptable",
    coverage,
    knownUseBinary: {
      scoredCaseCount,
      confusionMatrix: matrix,
      exactMatches,
      accuracy: valid && scoredCaseCount > 0
        ? ratio(exactMatches, scoredCaseCount)
        : null
    },
    byHistoricalOutcome: strata
  };
}

function scoreSets(
  values: readonly {
    readonly expected: ReadonlySet<string>;
    readonly predicted: ReadonlySet<string>;
  }[],
  valid: boolean
): SetMetrics {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let exactSetMatches = 0;
  for (const value of values) {
    for (const predicted of value.predicted) {
      if (value.expected.has(predicted)) truePositive += 1;
      else falsePositive += 1;
    }
    for (const expected of value.expected) {
      if (!value.predicted.has(expected)) falseNegative += 1;
    }
    if (
      value.expected.size === value.predicted.size &&
      [...value.expected].every((entry) => value.predicted.has(entry))
    ) exactSetMatches += 1;
  }
  const scoreValid = valid && values.length > 0;
  const precision = scoreValid
    ? ratio(truePositive, truePositive + falsePositive)
    : null;
  const recall = scoreValid
    ? ratio(truePositive, truePositive + falseNegative)
    : null;
  return {
    scoredCaseCount: values.length,
    truePositive,
    falsePositive,
    falseNegative,
    exactSetMatches,
    exactSetRate: scoreValid ? ratio(exactSetMatches, values.length) : null,
    precision,
    recall,
    f1:
      scoreValid && precision !== null && recall !== null && precision + recall > 0
        ? round((2 * precision * recall) / (precision + recall))
        : scoreValid
          ? 0
          : null
  };
}

function buildCaseResult(
  evaluationCase: ReviewFlowEvaluationDatasetCase,
  gold: ReviewFlowEvaluationGold,
  entry: ReviewFlowEvaluationEntry
): z.infer<typeof caseResultSchema> {
  const projection = entry.status === "completed" ? entry.projection : null;
  const verdictGold = gold.evaluationScope === "verdict_and_taste" ? gold : null;
  const expectedDuplicate = gold.evaluationScope === "originality_only"
    ? true
    : gold.independentOriginality?.confirmedDuplicate ?? null;
  return {
    safeId: evaluationCase.safeId,
    scope: gold.evaluationScope,
    status:
      entry.status === "pending"
        ? "not_started"
        : entry.status === "active"
          ? "interrupted"
          : entry.status,
    historicalOutcome: verdictGold?.historicalOutcome ?? null,
    predictedHistoricalOutcome:
      verdictGold !== null && projection !== null
        ? predictHistoricalOutcome(projection)
        : null,
    independentVerdict: verdictGold?.independentVerdict?.verdict ?? null,
    predictedVerdict: verdictGold !== null ? projection?.verdict ?? null : null,
    contestUse: verdictGold?.contestUse ?? null,
    predictedContestUse:
      verdictGold !== null && projection !== null
        ? predictContestUse(projection)
        : null,
    independentlyLabeledDuplicate: expectedDuplicate,
    predictedDuplicate:
      expectedDuplicate !== null
        ? projection?.originality.sameProblemAsExisting ?? null
        : null,
    failureCode: entry.status === "failed" ? entry.failure.code : null
  };
}

function aggregateFailures(
  entries: readonly ReviewFlowEvaluationEntry[],
  termination: ReviewFlowEvaluationCheckpointState["termination"]
): z.infer<typeof failureRowSchema>[] {
  const counts = new Map<string, z.infer<typeof failureRowSchema>>();
  for (const entry of entries) {
    if (entry.status !== "failed") continue;
    const failure = entry.failure;
    const key = `${failure.code}:${failure.failureKind ?? "none"}:${failure.httpStatus ?? "none"}`;
    const previous = counts.get(key);
    counts.set(key, {
      code: failure.code,
      failureKind: failure.failureKind,
      httpStatus: failure.httpStatus,
      count: (previous?.count ?? 0) + 1
    });
  }
  addSyntheticFailure(
    counts,
    entries.filter((entry) => entry.status === "active").length,
    "REVIEW_FLOW_EVALUATION_INTERRUPTED_ACTIVE"
  );
  addSyntheticFailure(
    counts,
    entries.filter((entry) => entry.status === "pending").length,
    termination === null
      ? "REVIEW_FLOW_EVALUATION_NOT_STARTED_AFTER_FAILURE"
      : "REVIEW_FLOW_EVALUATION_NOT_STARTED_AFTER_SIGNAL"
  );
  if (termination !== null) {
    addSyntheticFailure(
      counts,
      1,
      `REVIEW_FLOW_EVALUATION_${termination.signal}_REQUESTED`
    );
  }
  return [...counts.values()].sort((left, right) =>
    `${left.code}:${left.httpStatus ?? 0}`.localeCompare(
      `${right.code}:${right.httpStatus ?? 0}`
    )
  );
}

function addSyntheticFailure(
  counts: Map<string, z.infer<typeof failureRowSchema>>,
  count: number,
  code: string
): void {
  if (count === 0) return;
  counts.set(code, {
    code,
    failureKind: null,
    httpStatus: null,
    count
  });
}

function predictedTasteReasons(
  projection: ReviewFlowCalibrationProjection
): Set<string> {
  return new Set([
    ...projection.editorial.evidence.map(reasonKey),
    ...projection.contestFit.evidence.map(reasonKey)
  ]);
}

function predictedTechnicalReasons(
  projection: ReviewFlowCalibrationProjection
): Set<ReviewFlowEvaluationTechnicalReason> {
  const reasons = new Set<ReviewFlowEvaluationTechnicalReason>();
  if (projection.technical.statementSolutionConsistency === "concern") {
    reasons.add("statement_solution_inconsistency");
  }
  if (projection.technical.judgeability === "concern") {
    reasons.add("judgeability_concern");
  }
  if (
    projection.technical.sampleConsistency === "concern" ||
    projection.hardBlockers.includes("SAMPLE_MISMATCH")
  ) {
    reasons.add("sample_mismatch");
  }
  if (projection.technical.constraintSufficiency === "concern") {
    reasons.add("constraint_insufficiency");
  }
  if (!projection.technical.officialSolutionCorrect) {
    reasons.add("official_solution_incorrect");
  }
  if (
    projection.technical.referenceImplementation.complexityAcceptable === false ||
    projection.hardBlockers.includes("COMPLEXITY_UNACCEPTABLE")
  ) {
    reasons.add("complexity_unacceptable");
  }
  if (
    projection.technical.referenceImplementation.status === "invalid" ||
    projection.hardBlockers.includes("REFERENCE_IMPLEMENTATION_INCORRECT")
  ) {
    reasons.add("reference_implementation_incorrect");
  }
  return reasons;
}

function predictHistoricalOutcome(
  projection: ReviewFlowCalibrationProjection
): "accepted" | "not_accepted" {
  return projection.verdict === "reject" ? "not_accepted" : "accepted";
}

function predictContestUse(
  projection: ReviewFlowCalibrationProjection
): "used" | "not_used" {
  return projection.contestFit.icpcFit === "strong" ||
    projection.contestFit.icpcFit === "acceptable"
    ? "used"
    : "not_used";
}

function makeThreeWayMatrix(): Record<Verdict, Record<Verdict, number>> {
  return Object.fromEntries(
    verdicts.map((expected) => [
      expected,
      Object.fromEntries(
        verdicts.map((predicted) => [predicted, 0])
      ) as Record<Verdict, number>
    ])
  ) as Record<Verdict, Record<Verdict, number>>;
}

function comparisonMetrics(
  summary: ReviewFlowEvaluationReportSummary
): z.infer<typeof comparisonMetricSnapshotSchema> {
  return {
    historicalOutcomeAccuracy:
      summary.scoring.historicalOutcomeBinary.accuracy,
    independentVerdictAccuracy:
      summary.scoring.independentThreeWayVerdict.accuracy,
    exhaustiveTasteF1:
      summary.scoring.exhaustiveIndependentTasteReasons.f1,
    observedTasteRecall:
      summary.scoring.observedHistoricalTasteReasons.recall,
    observedTechnicalRecall:
      summary.scoring.observedHistoricalTechnicalReasons.recall,
    originalityAccuracy: summary.scoring.originality.accuracy,
    contestUseAccuracy: summary.scoring.contestUse.knownUseBinary.accuracy,
    codeforcesMae: summary.scoring.independentDifficulty.codeforcesMae,
    tagsF1: summary.scoring.tags.f1
  };
}

function buildMarkdown(summary: ReviewFlowEvaluationReportSummary): string {
  const failureRows = summary.failures.length === 0
    ? ["| 无 | 无 | 无 | 0 |"]
    : summary.failures.map(
        (failure) =>
          `| ${failure.code} | ${failure.failureKind ?? "无"} | ${failure.httpStatus ?? "无"} | ${failure.count} |`
      );
  return [
    `# 11 角色审题准确性报告（${summary.label}）`,
    "",
    `- 运行 UUID：${summary.runId}`,
    `- 数据集安全编号：${summary.dataset.safeId}`,
    `- 分区：${summary.dataset.purpose}`,
    `- 变体：${summary.variant}`,
    `- 基线标签：${summary.baselineLabel ?? "无"}`,
    `- 完整：${summary.complete ? "是" : "否"}`,
    `- 11 角色收据完整题数：${summary.receiptCoverage.completeElevenRoleReceiptCaseCount}/${summary.caseCounts.expected}`,
    `- 可作为生产资格证据：否（${summary.eligibilityReason}）`,
    "",
    "## 样本完整性",
    "",
    `预期 ${summary.caseCounts.expected}，完成 ${summary.caseCounts.completed}，失败 ${summary.caseCounts.failed}，中断 ${summary.caseCounts.active}，未启动 ${summary.caseCounts.pending}。`,
    "",
    "## 计分摘要",
    "",
    `- 历史最终结论二元准确率：${formatMetric(summary.scoring.historicalOutcomeBinary.accuracy)}`,
    `- 独立人工三态裁决准确率：${formatMetric(summary.scoring.independentThreeWayVerdict.accuracy)}`,
    `- 独立人工穷尽品味原因 F1：${formatMetric(summary.scoring.exhaustiveIndependentTasteReasons.f1)}`,
    `- 稀疏历史品味理由召回率：${formatMetric(summary.scoring.observedHistoricalTasteReasons.recall)}`,
    `- 稀疏历史技术理由召回率：${formatMetric(summary.scoring.observedHistoricalTechnicalReasons.recall)}`,
    `- 有独立标注样本的原创性准确率：${formatMetric(summary.scoring.originality.accuracy)}`,
    `- 比赛使用情况准确率（映射规则：ICPC 适配 strong/acceptable → used）：${formatMetric(summary.scoring.contestUse.knownUseBinary.accuracy)}`,
    `- 独立人工 CF 难度 MAE：${summary.scoring.independentDifficulty.codeforcesMae ?? "报告不完整或无独立标注，不计"}`,
    `- 标签 F1：${formatMetric(summary.scoring.tags.f1)}`,
    "",
    "## 比赛使用分层覆盖",
    "",
    `used=${summary.scoring.contestUse.coverage.used}，not_used=${summary.scoring.contestUse.coverage.not_used}，unknown=${summary.scoring.contestUse.coverage.unknown}；历史通过=${summary.scoring.contestUse.coverage.historicalAccepted}，历史否决=${summary.scoring.contestUse.coverage.historicalRejected}。`,
    "",
    "## 固定失败摘要",
    "",
    "| 错误码 | 类型 | HTTP | 数量 |",
    "| --- | --- | ---: | ---: |",
    ...failureRows,
    ""
  ].join("\n");
}

function reasonKey(reason: {
  readonly dimension: string;
  readonly direction: string;
}): string {
  return `${reason.dimension}:${reason.direction}`;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatMetric(value: number | null): string {
  return value === null ? "报告不完整或无适用独立标注，不计" : `${(value * 100).toFixed(2)}%`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
