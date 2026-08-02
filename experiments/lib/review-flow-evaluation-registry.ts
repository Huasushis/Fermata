/** 固定项目私有目录中的永久 label 注册表、holdout 一次性账本与报告发布器。 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  closePrivateDirectory,
  preparePrivateDirectory,
  projectPrivateRoot,
  workspaceRoot,
  type PrivateDirectoryHandle
} from "../../scripts/private-runtime.mjs";
import { hashCanonicalValue } from "../../src/review-flow/evidence";
import {
  ensurePrivateArtifactExact,
  readPrivateArtifactBytes as readPrivateArtifactBytesStrict,
  readPrivateArtifactBytesIfPresent as readPrivateArtifactBytesIfPresentStrict,
  recoverPrivateArtifactExclusiveOrphan,
  writePrivateArtifactExclusive
} from "./private-artifact-io";
import {
  reviewFlowEvaluationDigestSchema,
  reviewFlowEvaluationHoldoutRegistrationSchema,
  reviewFlowEvaluationLabelSchema,
  reviewFlowEvaluationPurposeSchema,
  reviewFlowEvaluationSubjectIdSchema,
  type ReviewFlowEvaluationDatasetBundle
} from "./review-flow-evaluation-dataset";
import {
  reviewFlowEvaluationBaselineBindingSchema,
  reviewFlowEvaluationPredictionIdentity,
  reviewFlowEvaluationPredictionIdentityFingerprint,
  reviewFlowEvaluationPredictionIdentitySchema,
  type ReviewFlowEvaluationBaselineBinding,
  ReviewFlowEvaluationCheckpointGenesisBinding,
  ReviewFlowEvaluationCheckpointRevealSnapshot,
  ReviewFlowEvaluationCheckpointState
} from "./review-flow-evaluation-state";
import {
  parsePhysicalBlindJson,
  parseVersionedStrictArtifact,
  PhysicalBlindArtifactError,
  serializePhysicalBlindArtifact
} from "./physical-blind-common";
import type { EvaluationCodeIdentity } from "./evaluation-code-identity";
import {
  buildReviewFlowEvaluationComparison,
  parseReviewFlowEvaluationReportSummary
} from "./review-flow-evaluation-report";

const digestSchema = reviewFlowEvaluationDigestSchema;
const timestampSchema = z.string().datetime();
const decimalSchema = z.string().regex(/^(0|[1-9][0-9]*)$/u);

const usagePurposeSchema = z.enum(["development", "holdout"]);
const usageClaimCommonShape = {
  schemaVersion: z.literal(2),
  artifactKind: z.literal("review_flow_evaluation_subject_usage_claim"),
  purpose: usagePurposeSchema,
  subjectId: reviewFlowEvaluationSubjectIdSchema
} as const;

const subjectUsageClaimSchema = z
  .object({
    ...usageClaimCommonShape,
    keyKind: z.literal("subject")
  })
  .strict();
const sourceLineageUsageClaimSchema = z
  .object({
    ...usageClaimCommonShape,
    keyKind: z.literal("source_lineage"),
    valueSha256: digestSchema
  })
  .strict();
const contentUsageClaimSchema = z
  .object({
    ...usageClaimCommonShape,
    keyKind: z.literal("content"),
    valueSha256: digestSchema
  })
  .strict();
const problemContentUsageClaimSchema = z
  .object({
    ...usageClaimCommonShape,
    keyKind: z.literal("problem_content"),
    valueSha256: digestSchema
  })
  .strict();
const anklangResponseUsageClaimSchema = z
  .object({
    ...usageClaimCommonShape,
    keyKind: z.literal("anklang_response"),
    valueSha256: digestSchema
  })
  .strict();

export const reviewFlowEvaluationSubjectUsageClaimSchema =
  z.discriminatedUnion("keyKind", [
    subjectUsageClaimSchema,
    sourceLineageUsageClaimSchema,
    contentUsageClaimSchema,
    problemContentUsageClaimSchema,
    anklangResponseUsageClaimSchema
  ]);
export type ReviewFlowEvaluationSubjectUsageClaim = z.infer<
  typeof reviewFlowEvaluationSubjectUsageClaimSchema
>;

const developmentUseObservationSchema = z
  .object({
    subjectId: reviewFlowEvaluationSubjectIdSchema,
    sourceLineageSha256: digestSchema,
    contentSha256: digestSchema,
    problemContentSha256: digestSchema,
    originalAnklangResponseSha256: digestSchema
  })
  .strict();

export const reviewFlowEvaluationDevelopmentUsePlanSchema = z
  .object({
    schemaVersion: z.literal(2),
    artifactKind: z.literal("review_flow_evaluation_development_use_plan"),
    datasetId: z.string().regex(/^dataset-[0-9a-f]{16}$/u),
    datasetFingerprint: digestSchema,
    manifestSha256: digestSchema,
    bridgeCompletionSha256: digestSchema,
    observations: z.array(developmentUseObservationSchema).min(1).max(1_000)
  })
  .strict();
export type ReviewFlowEvaluationDevelopmentUsePlan = z.infer<
  typeof reviewFlowEvaluationDevelopmentUsePlanSchema
>;

export const reviewFlowEvaluationLabelClaimSchema = z
  .object({
    schemaVersion: z.literal(2),
    artifactKind: z.literal("review_flow_evaluation_label_claim"),
    label: reviewFlowEvaluationLabelSchema,
    runId: z.string().uuid(),
    variant: z.enum(["baseline", "candidate"]),
    purpose: reviewFlowEvaluationPurposeSchema,
    identityFingerprint: digestSchema,
    datasetFingerprint: digestSchema,
    expectedCasesFingerprint: digestSchema,
    checkpointGenesisFingerprint: digestSchema,
    stateDirectory: z
      .object({ device: decimalSchema, inode: decimalSchema })
      .strict(),
    holdoutIdentity: digestSchema.nullable(),
    thresholdPolicySha256: digestSchema.nullable(),
    claimedAt: timestampSchema
  })
  .strict();
export type ReviewFlowEvaluationLabelClaim = z.infer<
  typeof reviewFlowEvaluationLabelClaimSchema
>;

export const reviewFlowEvaluationRunClaimSchema = z
  .object({
    schemaVersion: z.literal(2),
    artifactKind: z.literal("review_flow_evaluation_run_claim"),
    runId: z.string().uuid(),
    label: reviewFlowEvaluationLabelSchema,
    purpose: reviewFlowEvaluationPurposeSchema,
    identityFingerprint: digestSchema,
    checkpointGenesisFingerprint: digestSchema
  })
  .strict();
export type ReviewFlowEvaluationRunClaim = z.infer<
  typeof reviewFlowEvaluationRunClaimSchema
>;

const holdoutSubjectSchema = z
  .object({
    subjectId: reviewFlowEvaluationSubjectIdSchema,
    sourceLineageSha256: digestSchema,
    contentSha256: digestSchema,
    problemContentSha256: digestSchema,
    originalAnklangResponseSha256: digestSchema
  })
  .strict();

export const reviewFlowEvaluationHoldoutPlanSchema = z
  .object({
    schemaVersion: z.literal(2),
    artifactKind: z.literal("review_flow_evaluation_holdout_plan"),
    holdoutIdentity: digestSchema,
    datasetId: z.string().regex(/^dataset-[0-9a-f]{16}$/u),
    manifestSha256: digestSchema,
    datasetFingerprint: digestSchema,
    registration: reviewFlowEvaluationHoldoutRegistrationSchema,
    subjects: z.array(holdoutSubjectSchema).min(1).max(1_000)
  })
  .strict();
export type ReviewFlowEvaluationHoldoutPlan = z.infer<
  typeof reviewFlowEvaluationHoldoutPlanSchema
>;

const developmentNominationReportSchema = z
  .object({
    label: reviewFlowEvaluationLabelSchema,
    runId: z.string().uuid(),
    datasetFingerprint: digestSchema,
    manifestSha256: digestSchema,
    summarySha256: digestSchema,
    markdownSha256: digestSchema,
    reportSetSha256: digestSchema,
    labelClaimSha256: digestSchema,
    publicationReceiptSha256: digestSchema,
    executionCompletionFingerprint: digestSchema,
    predictionIdentity: reviewFlowEvaluationPredictionIdentitySchema,
    predictionIdentityFingerprint: digestSchema
  })
  .strict();

export const reviewFlowEvaluationHoldoutSelectionSchema = z
  .object({
    schemaVersion: z.literal(2),
    artifactKind: z.literal("review_flow_evaluation_holdout_selection"),
    holdoutIdentity: digestSchema,
    datasetId: z.string().regex(/^dataset-[0-9a-f]{16}$/u),
    manifestSha256: digestSchema,
    holdoutPlanSha256: digestSchema,
    developmentUsePlanSha256: digestSchema,
    developmentBaseline: developmentNominationReportSchema,
    developmentCandidate: developmentNominationReportSchema,
    candidateBaselineBindingSha256: digestSchema,
    selectedAt: timestampSchema
  })
  .strict();
export type ReviewFlowEvaluationHoldoutSelection = z.infer<
  typeof reviewFlowEvaluationHoldoutSelectionSchema
>;

const holdoutSubjectClaimSchema = z
  .object({
    schemaVersion: z.literal(2),
    artifactKind: z.literal("review_flow_evaluation_holdout_subject_claim"),
    subjectId: reviewFlowEvaluationSubjectIdSchema,
    sourceLineageSha256: digestSchema,
    holdoutIdentity: digestSchema
  })
  .strict();

export const reviewFlowEvaluationHoldoutSlotSchema = z
  .object({
    schemaVersion: z.literal(2),
    artifactKind: z.literal("review_flow_evaluation_holdout_slot"),
    holdoutIdentity: digestSchema,
    slot: z.enum(["baseline", "candidate"]),
    label: reviewFlowEvaluationLabelSchema,
    runId: z.string().uuid(),
    identityFingerprint: digestSchema,
    checkpointGenesisFingerprint: digestSchema,
    labelClaimSha256: digestSchema,
    selectionClaimSha256: digestSchema,
    predictionIdentityFingerprint: digestSchema,
    stateDirectory: z
      .object({ device: decimalSchema, inode: decimalSchema })
      .strict()
  })
  .strict();
export type ReviewFlowEvaluationHoldoutSlot = z.infer<
  typeof reviewFlowEvaluationHoldoutSlotSchema
>;

export const reviewFlowEvaluationPredictionCompletionSchema = z
  .object({
    schemaVersion: z.literal(2),
    artifactKind: z.literal("review_flow_evaluation_holdout_prediction_completion"),
    holdoutIdentity: digestSchema,
    slot: z.enum(["baseline", "candidate"]),
    label: reviewFlowEvaluationLabelSchema,
    runId: z.string().uuid(),
    slotClaimSha256: digestSchema,
    labelClaimSha256: digestSchema,
    executionCompletionFingerprint: digestSchema,
    projectionSetSha256: digestSchema,
    complete: z.literal(true),
    sealedAt: timestampSchema
  })
  .strict();
export type ReviewFlowEvaluationPredictionCompletion = z.infer<
  typeof reviewFlowEvaluationPredictionCompletionSchema
>;

export const reviewFlowEvaluationReportSetMarkerSchema = z
  .object({
    schemaVersion: z.literal(2),
    protocolVersion: z.literal("review-flow-evaluation-v2"),
    label: reviewFlowEvaluationLabelSchema,
    runId: z.string().uuid(),
    summarySha256: digestSchema,
    markdownSha256: digestSchema,
    complete: z.boolean(),
    executionCompletionFingerprint: digestSchema,
    labelClaimSha256: digestSchema
  })
  .strict();
export type ReviewFlowEvaluationReportSetMarker = z.infer<
  typeof reviewFlowEvaluationReportSetMarkerSchema
>;

export const reviewFlowEvaluationPublicationReceiptSchema = z
  .object({
    schemaVersion: z.literal(2),
    artifactKind: z.literal("review_flow_evaluation_report_publication"),
    label: reviewFlowEvaluationLabelSchema,
    runId: z.string().uuid(),
    labelClaimSha256: digestSchema,
    executionCompletionFingerprint: digestSchema,
    summarySha256: digestSchema,
    markdownSha256: digestSchema,
    reportSetSha256: digestSchema,
    complete: z.boolean()
  })
  .strict();
export type ReviewFlowEvaluationPublicationReceipt = z.infer<
  typeof reviewFlowEvaluationPublicationReceiptSchema
>;

export const reviewFlowEvaluationRevealClaimSchema = z
  .object({
    schemaVersion: z.literal(2),
    artifactKind: z.literal("review_flow_evaluation_holdout_reveal_claim"),
    holdoutIdentity: digestSchema,
    thresholdPolicySha256: digestSchema,
    baselineLabel: reviewFlowEvaluationLabelSchema,
    candidateLabel: reviewFlowEvaluationLabelSchema,
    baselineCompletionSha256: digestSchema,
    candidateCompletionSha256: digestSchema,
    baselineExecutionCompletionFingerprint: digestSchema,
    candidateExecutionCompletionFingerprint: digestSchema,
    selectionClaimSha256: digestSchema,
    scoringCodeVersion: z.string().regex(/^[0-9a-f]{40}$/u),
    scoringDependencyCodeSha256: digestSchema
  })
  .strict();
export type ReviewFlowEvaluationRevealClaim = z.infer<
  typeof reviewFlowEvaluationRevealClaimSchema
>;

export const reviewFlowEvaluationComparisonMarkerSchema = z
  .object({
    schemaVersion: z.literal(2),
    artifactKind: z.literal("review_flow_evaluation_holdout_comparison"),
    holdoutIdentity: digestSchema,
    revealClaimSha256: digestSchema,
    baselineLabel: reviewFlowEvaluationLabelSchema,
    candidateLabel: reviewFlowEvaluationLabelSchema,
    baselineReportSetSha256: digestSchema,
    candidateReportSetSha256: digestSchema,
    comparisonSha256: digestSchema
  })
  .strict();

export interface ReviewFlowEvaluationPublishedReport {
  readonly summaryBytes: Buffer;
  readonly markdownBytes: Buffer;
  readonly markerBytes: Buffer;
  readonly marker: ReviewFlowEvaluationReportSetMarker;
  readonly receiptBytes: Buffer;
  readonly receipt: ReviewFlowEvaluationPublicationReceipt;
  readonly labelClaimBytes: Buffer;
  readonly labelClaim: ReviewFlowEvaluationLabelClaim;
}

export class ReviewFlowEvaluationRegistryError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(code);
    this.name = "ReviewFlowEvaluationRegistryError";
    this.code = code;
  }
}

export class ReviewFlowEvaluationGlobalRegistry {
  readonly #directory: PrivateDirectoryHandle;
  readonly #now: () => Date;
  #closed = false;

  public constructor(options: {
    readonly registryDirectory?: string;
    readonly privateRoot?: string;
    readonly containingWorkspace?: string;
    readonly now?: () => Date;
  } = {}) {
    const privateRoot = options.privateRoot ?? projectPrivateRoot;
    const containingWorkspace = options.containingWorkspace ?? workspaceRoot;
    const registryDirectory = options.registryDirectory ??
      join(privateRoot, "review-flow-evaluation-registry");
    this.#directory = preparePrivateDirectory(registryDirectory, {
      privateRoot,
      containingWorkspace
    });
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * 永久占用一个 label。fresh 看到 claim 或任何半套报告即拒绝；resume 只接纳
   * 同一 run/identity/state-dir inode，或在 claim 尚未写入的崩溃窗收养 orphan。
   */
  public claimLabel(input: {
    readonly genesis: ReviewFlowEvaluationCheckpointGenesisBinding;
    readonly datasetFingerprint: string;
    readonly holdoutIdentity: string | null;
    readonly thresholdPolicySha256: string | null;
    readonly resume: boolean;
  }): { readonly claim: ReviewFlowEvaluationLabelClaim; readonly sha256: string } {
    this.assertOpen();
    const fileName = labelClaimFileName(input.genesis.label);
    recoverPrivateArtifactExclusiveOrphan(this.#directory, fileName, 1024 * 1024);
    const existing = readPrivateArtifactBytesIfPresent(
      this.#directory,
      fileName,
      1024 * 1024
    );
    if (existing !== null) {
      if (!input.resume) {
        throw new ReviewFlowEvaluationRegistryError(
          "REVIEW_FLOW_EVALUATION_LABEL_ALREADY_CLAIMED"
        );
      }
      const claim = parseArtifact(
        existing,
        reviewFlowEvaluationLabelClaimSchema,
        "REVIEW_FLOW_EVALUATION_LABEL_CLAIM_INVALID"
      );
      assertLabelClaimMatches(claim, input);
      this.claimRunIdentity(input.genesis, input.resume);
      return { claim, sha256: sha256(existing) };
    }
    if (
      reportArtifactNames(input.genesis.label).some((name) =>
        readPrivateArtifactBytesIfPresent(this.#directory, name, 32 * 1024 * 1024) !== null
      )
    ) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_PARTIAL_REPORT_EXISTS"
      );
    }
    const claim = reviewFlowEvaluationLabelClaimSchema.parse({
      schemaVersion: 2,
      artifactKind: "review_flow_evaluation_label_claim",
      label: input.genesis.label,
      runId: input.genesis.runId,
      variant: input.genesis.variant,
      purpose: input.genesis.purpose,
      identityFingerprint: input.genesis.identityFingerprint,
      datasetFingerprint: digestSchema.parse(input.datasetFingerprint),
      expectedCasesFingerprint: input.genesis.expectedCasesFingerprint,
      checkpointGenesisFingerprint: input.genesis.checkpointGenesisFingerprint,
      stateDirectory: input.genesis.stateDirectory,
      holdoutIdentity: input.holdoutIdentity,
      thresholdPolicySha256: input.thresholdPolicySha256,
      claimedAt: this.#now().toISOString()
    });
    this.claimRunIdentity(input.genesis, input.resume);
    const text = serializePhysicalBlindArtifact(claim);
    try {
      writePrivateArtifactExclusive(this.#directory, fileName, text);
    } catch {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_LABEL_CLAIM_RACE"
      );
    }
    const bytes = readPrivateArtifactBytes(this.#directory, fileName, 1024 * 1024);
    if (!bytes.equals(Buffer.from(text, "utf8"))) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_LABEL_CLAIM_INVALID"
      );
    }
    return { claim, sha256: sha256(bytes) };
  }

  private claimRunIdentity(
    genesis: ReviewFlowEvaluationCheckpointGenesisBinding,
    resume: boolean
  ): void {
    const fileName = runClaimFileName(genesis.runId);
    const claim = reviewFlowEvaluationRunClaimSchema.parse({
      schemaVersion: 2,
      artifactKind: "review_flow_evaluation_run_claim",
      runId: genesis.runId,
      label: genesis.label,
      purpose: genesis.purpose,
      identityFingerprint: genesis.identityFingerprint,
      checkpointGenesisFingerprint: genesis.checkpointGenesisFingerprint
    });
    const text = serializePhysicalBlindArtifact(claim);
    const existing = readPrivateArtifactBytesIfPresent(
      this.#directory,
      fileName,
      1024 * 1024
    );
    if (existing !== null) {
      if (!resume || !existing.equals(Buffer.from(text, "utf8"))) {
        throw new ReviewFlowEvaluationRegistryError(
          "REVIEW_FLOW_EVALUATION_RUN_ALREADY_CLAIMED"
        );
      }
      return;
    }
    try {
      writePrivateArtifactExclusive(this.#directory, fileName, text);
    } catch {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_RUN_CLAIM_RACE"
      );
    }
    const bytes = readPrivateArtifactBytes(
      this.#directory,
      fileName,
      1024 * 1024
    );
    if (!bytes.equals(Buffer.from(text, "utf8"))) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_RUN_CLAIM_INVALID"
      );
    }
  }

  public assertLabelClaim(input: {
    readonly genesis: ReviewFlowEvaluationCheckpointGenesisBinding;
    readonly datasetFingerprint: string;
    readonly holdoutIdentity: string | null;
    readonly thresholdPolicySha256: string | null;
    readonly expectedSha256: string;
  }): ReviewFlowEvaluationLabelClaim {
    const bytes = readPrivateArtifactBytes(
      this.#directory,
      labelClaimFileName(input.genesis.label),
      1024 * 1024
    );
    if (sha256(bytes) !== input.expectedSha256) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_LABEL_CLAIM_MISMATCH"
      );
    }
    const claim = parseArtifact(
      bytes,
      reviewFlowEvaluationLabelClaimSchema,
      "REVIEW_FLOW_EVALUATION_LABEL_CLAIM_INVALID"
    );
    assertLabelClaimMatches(claim, input);
    return claim;
  }

  /**
   * 在任何 development 付费请求前永久登记主体用途。主体可在后续 development
   * 数据集中出现新版本，但每个已见来源谱系/内容摘要都不能改绑主体或进入 holdout。
   */
  public registerDevelopmentUse(
    dataset: ReviewFlowEvaluationDatasetBundle
  ): { readonly plan: ReviewFlowEvaluationDevelopmentUsePlan; readonly sha256: string } {
    this.assertOpen();
    if (
      dataset.purpose !== "development" ||
      dataset.loadMode !== "development_identity" ||
      dataset.summary !== null
    ) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_DEVELOPMENT_USE_INPUT_INVALID"
      );
    }
    const observations = sortedUsageObservations(dataset);
    this.claimSubjectUsage(observations, "development");
    const plan = reviewFlowEvaluationDevelopmentUsePlanSchema.parse({
      schemaVersion: 2,
      artifactKind: "review_flow_evaluation_development_use_plan",
      datasetId: dataset.datasetId,
      datasetFingerprint: dataset.datasetFingerprint,
      manifestSha256: dataset.manifestSha256,
      bridgeCompletionSha256: dataset.bridgeCompletionSha256,
      observations
    });
    const bytes = ensureExactArtifact(
      this.#directory,
      developmentUsePlanFileName(dataset.datasetFingerprint),
      serializePhysicalBlindArtifact(plan)
    );
    return { plan, sha256: sha256(bytes) };
  }

  public registerHoldoutPlan(
    dataset: ReviewFlowEvaluationDatasetBundle
  ): { readonly plan: ReviewFlowEvaluationHoldoutPlan; readonly sha256: string } {
    this.assertOpen();
    const holdoutIdentity = dataset.holdoutIdentity;
    const registration = dataset.holdoutRegistration;
    if (
      dataset.purpose !== "holdout" ||
      dataset.summary !== null ||
      dataset.loadMode !== "holdout_prediction" ||
      holdoutIdentity === null ||
      registration === null
    ) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_HOLDOUT_PLAN_INPUT_INVALID"
      );
    }
    const subjects = [...dataset.cases]
      .sort((left, right) => left.subjectId.localeCompare(right.subjectId))
      .map((entry) => ({
        subjectId: entry.subjectId,
        sourceLineageSha256: entry.sourceLineageSha256,
        contentSha256: entry.contentSha256,
        problemContentSha256: entry.task.problem.contentHash,
        originalAnklangResponseSha256:
          entry.originalAnklangResponseSha256
      }));
    this.claimSubjectUsage(subjects, "holdout");
    const plan = reviewFlowEvaluationHoldoutPlanSchema.parse({
      schemaVersion: 2,
      artifactKind: "review_flow_evaluation_holdout_plan",
      holdoutIdentity,
      datasetId: dataset.datasetId,
      manifestSha256: dataset.manifestSha256,
      datasetFingerprint: dataset.datasetFingerprint,
      registration,
      subjects
    });
    for (const subject of subjects) {
      const subjectClaim = holdoutSubjectClaimSchema.parse({
        schemaVersion: 2,
        artifactKind: "review_flow_evaluation_holdout_subject_claim",
        subjectId: subject.subjectId,
        sourceLineageSha256: subject.sourceLineageSha256,
        holdoutIdentity
      });
      ensureExactArtifact(
        this.#directory,
        `holdout-subject-${sha256(subject.subjectId).slice(0, 32)}.private.json`,
        serializePhysicalBlindArtifact(subjectClaim)
      );
    }
    const fileName = holdoutPlanFileName(holdoutIdentity);
    const bytes = ensureExactArtifact(
      this.#directory,
      fileName,
      serializePhysicalBlindArtifact(plan)
    );
    return { plan, sha256: sha256(bytes) };
  }

  /**
   * 在第一条 holdout 请求前，把已经完整发布的 development baseline 与人工选定
   * candidate 永久冻结。之后 holdout 两个槽位只能使用各自完全相同的生产身份。
   */
  public nominateHoldoutSelection(input: {
    readonly plan: ReviewFlowEvaluationHoldoutPlan;
    readonly developmentBaselineLabel: string;
    readonly developmentCandidateLabel: string;
  }): {
    readonly selection: ReviewFlowEvaluationHoldoutSelection;
    readonly sha256: string;
  } {
    this.assertOpen();
    const baselineLabel = reviewFlowEvaluationLabelSchema.parse(
      input.developmentBaselineLabel
    );
    const candidateLabel = reviewFlowEvaluationLabelSchema.parse(
      input.developmentCandidateLabel
    );
    if (baselineLabel === candidateLabel) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_HOLDOUT_SELECTION_INVALID"
      );
    }
    const planBytes = readPrivateArtifactBytes(
      this.#directory,
      holdoutPlanFileName(input.plan.holdoutIdentity),
      32 * 1024 * 1024
    );
    if (!planBytes.equals(Buffer.from(
      serializePhysicalBlindArtifact(input.plan),
      "utf8"
    ))) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_HOLDOUT_SELECTION_INVALID"
      );
    }
    const baselinePublished = this.loadPublishedReport(baselineLabel);
    const candidatePublished = this.loadPublishedReport(candidateLabel);
    const baseline = developmentNominationReport(
      baselinePublished,
      baselineLabel,
      "baseline",
      input.plan
    );
    const baselineBinding = baselineBindingForNomination(
      baselinePublished,
      baseline.summary
    );
    const candidate = developmentNominationReport(
      candidatePublished,
      candidateLabel,
      "candidate",
      input.plan
    );
    if (
      candidate.summary.dataset.fingerprint !==
        baseline.summary.dataset.fingerprint ||
      candidate.summary.baselineLabel !== baselineLabel ||
      candidate.summary.baselineBinding === null ||
      hashCanonicalValue(candidate.summary.baselineBinding) !==
        hashCanonicalValue(baselineBinding)
    ) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_HOLDOUT_SELECTION_INVALID"
      );
    }
    const developmentUsePlanBytes = readPrivateArtifactBytes(
      this.#directory,
      developmentUsePlanFileName(baseline.summary.dataset.fingerprint),
      32 * 1024 * 1024
    );
    const developmentUsePlan = parseArtifact(
      developmentUsePlanBytes,
      reviewFlowEvaluationDevelopmentUsePlanSchema,
      "REVIEW_FLOW_EVALUATION_HOLDOUT_SELECTION_INVALID"
    );
    if (
      developmentUsePlan.datasetId !== input.plan.datasetId ||
      developmentUsePlan.manifestSha256 !== input.plan.manifestSha256 ||
      developmentUsePlan.datasetFingerprint !==
        baseline.summary.dataset.fingerprint
    ) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_HOLDOUT_SELECTION_INVALID"
      );
    }
    const base = {
      schemaVersion: 2 as const,
      artifactKind: "review_flow_evaluation_holdout_selection" as const,
      holdoutIdentity: input.plan.holdoutIdentity,
      datasetId: input.plan.datasetId,
      manifestSha256: input.plan.manifestSha256,
      holdoutPlanSha256: sha256(planBytes),
      developmentUsePlanSha256: sha256(developmentUsePlanBytes),
      developmentBaseline: baseline.binding,
      developmentCandidate: candidate.binding,
      candidateBaselineBindingSha256: hashCanonicalValue(baselineBinding)
    };
    const fileName = holdoutSelectionFileName(input.plan.holdoutIdentity);
    recoverPrivateArtifactExclusiveOrphan(this.#directory, fileName, 4 * 1024 * 1024);
    const existing = readPrivateArtifactBytesIfPresent(
      this.#directory,
      fileName,
      4 * 1024 * 1024
    );
    if (existing !== null) {
      const selection = parseArtifact(
        existing,
        reviewFlowEvaluationHoldoutSelectionSchema,
        "REVIEW_FLOW_EVALUATION_HOLDOUT_SELECTION_INVALID"
      );
      const { selectedAt: _selectedAt, ...existingBase } = selection;
      if (hashCanonicalValue(existingBase) !== hashCanonicalValue(base)) {
        throw new ReviewFlowEvaluationRegistryError(
          "REVIEW_FLOW_EVALUATION_HOLDOUT_SELECTION_ALREADY_FROZEN"
        );
      }
      return { selection, sha256: sha256(existing) };
    }
    const selection = reviewFlowEvaluationHoldoutSelectionSchema.parse({
      ...base,
      selectedAt: this.#now().toISOString()
    });
    const text = serializePhysicalBlindArtifact(selection);
    try {
      writePrivateArtifactExclusive(this.#directory, fileName, text);
    } catch {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_HOLDOUT_SELECTION_RACE"
      );
    }
    const bytes = ensureExactArtifact(this.#directory, fileName, text);
    return { selection, sha256: sha256(bytes) };
  }

  public claimHoldoutSlot(input: {
    readonly plan: ReviewFlowEvaluationHoldoutPlan;
    readonly genesis: ReviewFlowEvaluationCheckpointGenesisBinding;
    readonly labelClaimSha256: string;
    readonly selectionClaimSha256: string;
    readonly resume: boolean;
  }): { readonly slot: ReviewFlowEvaluationHoldoutSlot; readonly sha256: string } {
    this.assertOpen();
    const expectedLabel = input.genesis.variant === "baseline"
      ? input.plan.registration.baselineLabel
      : input.plan.registration.candidateLabel;
    if (
      input.genesis.purpose !== "holdout" ||
      input.genesis.label !== expectedLabel
    ) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_HOLDOUT_LABEL_NOT_PREREGISTERED"
      );
    }
    const selection = this.readHoldoutSelection(
      input.plan,
      input.selectionClaimSha256
    );
    const expectedPredictionIdentity = input.genesis.variant === "baseline"
      ? selection.developmentBaseline.predictionIdentityFingerprint
      : selection.developmentCandidate.predictionIdentityFingerprint;
    if (input.genesis.predictionIdentityFingerprint !== expectedPredictionIdentity) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_HOLDOUT_PREDICTION_IDENTITY_MISMATCH"
      );
    }
    const labelClaimBytes = readPrivateArtifactBytes(
      this.#directory,
      labelClaimFileName(input.genesis.label),
      1024 * 1024
    );
    const labelClaim = parseArtifact(
      labelClaimBytes,
      reviewFlowEvaluationLabelClaimSchema,
      "REVIEW_FLOW_EVALUATION_LABEL_CLAIM_INVALID"
    );
    if (
      sha256(labelClaimBytes) !== input.labelClaimSha256 ||
      labelClaim.runId !== input.genesis.runId ||
      labelClaim.identityFingerprint !== input.genesis.identityFingerprint ||
      labelClaim.checkpointGenesisFingerprint !==
        input.genesis.checkpointGenesisFingerprint ||
      labelClaim.stateDirectory.device !== input.genesis.stateDirectory.device ||
      labelClaim.stateDirectory.inode !== input.genesis.stateDirectory.inode ||
      labelClaim.datasetFingerprint !== input.plan.datasetFingerprint ||
      labelClaim.holdoutIdentity !== input.plan.holdoutIdentity ||
      labelClaim.thresholdPolicySha256 !==
        input.plan.registration.thresholdPolicySha256
    ) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_LABEL_CLAIM_MISMATCH"
      );
    }
    if (input.genesis.variant === "candidate") {
      this.readPredictionCompletion(input.plan.holdoutIdentity, "baseline");
    }
    const slot = reviewFlowEvaluationHoldoutSlotSchema.parse({
      schemaVersion: 2,
      artifactKind: "review_flow_evaluation_holdout_slot",
      holdoutIdentity: input.plan.holdoutIdentity,
      slot: input.genesis.variant,
      label: input.genesis.label,
      runId: input.genesis.runId,
      identityFingerprint: input.genesis.identityFingerprint,
      checkpointGenesisFingerprint: input.genesis.checkpointGenesisFingerprint,
      labelClaimSha256: input.labelClaimSha256,
      selectionClaimSha256: input.selectionClaimSha256,
      predictionIdentityFingerprint: input.genesis.predictionIdentityFingerprint,
      stateDirectory: input.genesis.stateDirectory
    });
    const fileName = holdoutSlotFileName(
      input.plan.holdoutIdentity,
      input.genesis.variant
    );
    recoverPrivateArtifactExclusiveOrphan(this.#directory, fileName, 1024 * 1024);
    const existing = readPrivateArtifactBytesIfPresent(
      this.#directory,
      fileName,
      1024 * 1024
    );
    if (existing !== null && !input.resume) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_HOLDOUT_SLOT_ALREADY_USED"
      );
    }
    const slotText = serializePhysicalBlindArtifact(slot);
    if (existing === null && !input.resume) {
      try {
        writePrivateArtifactExclusive(this.#directory, fileName, slotText);
      } catch {
        throw new ReviewFlowEvaluationRegistryError(
          "REVIEW_FLOW_EVALUATION_HOLDOUT_SLOT_CLAIM_RACE"
        );
      }
    }
    const bytes = ensureExactArtifact(this.#directory, fileName, slotText);
    return { slot, sha256: sha256(bytes) };
  }

  private readHoldoutSelection(
    plan: ReviewFlowEvaluationHoldoutPlan,
    expectedSha256?: string
  ): ReviewFlowEvaluationHoldoutSelection {
    const bytes = readPrivateArtifactBytes(
      this.#directory,
      holdoutSelectionFileName(plan.holdoutIdentity),
      4 * 1024 * 1024
    );
    const selection = parseArtifact(
      bytes,
      reviewFlowEvaluationHoldoutSelectionSchema,
      "REVIEW_FLOW_EVALUATION_HOLDOUT_SELECTION_INVALID"
    );
    const planBytes = readPrivateArtifactBytes(
      this.#directory,
      holdoutPlanFileName(plan.holdoutIdentity),
      32 * 1024 * 1024
    );
    const developmentUsePlanBytes = readPrivateArtifactBytes(
      this.#directory,
      developmentUsePlanFileName(
        selection.developmentBaseline.datasetFingerprint
      ),
      32 * 1024 * 1024
    );
    if (
      (expectedSha256 !== undefined && sha256(bytes) !== expectedSha256) ||
      selection.holdoutIdentity !== plan.holdoutIdentity ||
      selection.datasetId !== plan.datasetId ||
      selection.manifestSha256 !== plan.manifestSha256 ||
      selection.holdoutPlanSha256 !== sha256(planBytes) ||
      selection.developmentUsePlanSha256 !== sha256(developmentUsePlanBytes)
    ) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_HOLDOUT_SELECTION_INVALID"
      );
    }
    return selection;
  }

  public completeHoldoutPrediction(input: {
    readonly state: ReviewFlowEvaluationCheckpointState;
    readonly slotClaimSha256: string;
  }): { readonly completion: ReviewFlowEvaluationPredictionCompletion; readonly sha256: string } {
    this.assertOpen();
    const seal = input.state.executionSeal;
    if (
      input.state.identity.purpose !== "holdout" ||
      input.state.holdoutIdentity === null ||
      input.state.globalClaimSha256 === null ||
      seal === null ||
      !seal.complete ||
      input.state.entries.some((entry) => entry.status !== "completed")
    ) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_HOLDOUT_PREDICTION_INCOMPLETE"
      );
    }
    assertRegistryLabelClaimForState(this.#directory, input.state);
    const slotBytes = readPrivateArtifactBytes(
      this.#directory,
      holdoutSlotFileName(input.state.holdoutIdentity, input.state.variant),
      1024 * 1024
    );
    const slot = parseArtifact(
      slotBytes,
      reviewFlowEvaluationHoldoutSlotSchema,
      "REVIEW_FLOW_EVALUATION_HOLDOUT_SLOT_INVALID"
    );
    const planBytes = readPrivateArtifactBytes(
      this.#directory,
      holdoutPlanFileName(input.state.holdoutIdentity),
      32 * 1024 * 1024
    );
    const plan = parseArtifact(
      planBytes,
      reviewFlowEvaluationHoldoutPlanSchema,
      "REVIEW_FLOW_EVALUATION_HOLDOUT_PLAN_INVALID"
    );
    const selection = this.readHoldoutSelection(plan);
    const selectionBytes = readPrivateArtifactBytes(
      this.#directory,
      holdoutSelectionFileName(input.state.holdoutIdentity),
      4 * 1024 * 1024
    );
    const expectedPredictionIdentity = input.state.variant === "baseline"
      ? selection.developmentBaseline.predictionIdentityFingerprint
      : selection.developmentCandidate.predictionIdentityFingerprint;
    if (
      sha256(slotBytes) !== input.slotClaimSha256 ||
      slot.label !== input.state.label ||
      slot.runId !== input.state.runId ||
      slot.labelClaimSha256 !== input.state.globalClaimSha256 ||
      slot.identityFingerprint !== input.state.identityFingerprint ||
      slot.selectionClaimSha256 !== sha256(selectionBytes) ||
      slot.predictionIdentityFingerprint !==
        reviewFlowEvaluationPredictionIdentityFingerprint(input.state.identity) ||
      slot.predictionIdentityFingerprint !== expectedPredictionIdentity
    ) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_HOLDOUT_SLOT_INVALID"
      );
    }
    const completion = reviewFlowEvaluationPredictionCompletionSchema.parse({
      schemaVersion: 2,
      artifactKind: "review_flow_evaluation_holdout_prediction_completion",
      holdoutIdentity: input.state.holdoutIdentity,
      slot: input.state.variant,
      label: input.state.label,
      runId: input.state.runId,
      slotClaimSha256: digestSchema.parse(input.slotClaimSha256),
      labelClaimSha256: input.state.globalClaimSha256,
      executionCompletionFingerprint: seal.completionFingerprint,
      projectionSetSha256: hashCanonicalValue(
        input.state.entries.map((entry) =>
          entry.status === "completed"
            ? { safeId: entry.safeId, projection: entry.projection }
            : { safeId: entry.safeId, status: entry.status }
        )
      ),
      complete: true,
      sealedAt: seal.sealedAt
    });
    const bytes = ensureExactArtifact(
      this.#directory,
      predictionCompletionFileName(
        input.state.holdoutIdentity,
        input.state.variant
      ),
      serializePhysicalBlindArtifact(completion)
    );
    return { completion, sha256: sha256(bytes) };
  }

  public readPredictionCompletion(
    holdoutIdentity: string,
    slot: "baseline" | "candidate"
  ): { readonly completion: ReviewFlowEvaluationPredictionCompletion; readonly sha256: string } {
    const bytes = readPrivateArtifactBytes(
      this.#directory,
      predictionCompletionFileName(holdoutIdentity, slot),
      1024 * 1024
    );
    const completion = parseArtifact(
      bytes,
      reviewFlowEvaluationPredictionCompletionSchema,
      "REVIEW_FLOW_EVALUATION_HOLDOUT_COMPLETION_INVALID"
    );
    if (completion.holdoutIdentity !== holdoutIdentity || completion.slot !== slot) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_HOLDOUT_COMPLETION_INVALID"
      );
    }
    return { completion, sha256: sha256(bytes) };
  }

  public claimReveal(input: {
    readonly dataset: ReviewFlowEvaluationDatasetBundle;
    readonly baselineSnapshot: ReviewFlowEvaluationCheckpointRevealSnapshot;
    readonly candidateSnapshot: ReviewFlowEvaluationCheckpointRevealSnapshot;
    readonly scoringCodeIdentity: EvaluationCodeIdentity;
    readonly resume: boolean;
  }): { readonly claim: ReviewFlowEvaluationRevealClaim; readonly sha256: string } {
    this.assertOpen();
    const holdoutIdentity = input.dataset.holdoutIdentity;
    const registration = input.dataset.holdoutRegistration;
    if (
      input.dataset.loadMode !== "holdout_prediction" ||
      input.dataset.summary !== null ||
      input.dataset.purpose !== "holdout" ||
      holdoutIdentity === null ||
      registration === null
    ) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_REVEAL_DATASET_INVALID"
      );
    }
    assertRevealState(
      input.baselineSnapshot.state,
      input.dataset,
      "baseline",
      registration.baselineLabel
    );
    assertRevealState(
      input.candidateSnapshot.state,
      input.dataset,
      "candidate",
      registration.candidateLabel
    );
    const baselineCompletion = this.readPredictionCompletion(
      holdoutIdentity,
      "baseline"
    );
    const candidateCompletion = this.readPredictionCompletion(
      holdoutIdentity,
      "candidate"
    );
    const baselineState = input.baselineSnapshot.state;
    const candidateState = input.candidateSnapshot.state;
    const planBytes = readPrivateArtifactBytes(
      this.#directory,
      holdoutPlanFileName(holdoutIdentity),
      32 * 1024 * 1024
    );
    const plan = parseArtifact(
      planBytes,
      reviewFlowEvaluationHoldoutPlanSchema,
      "REVIEW_FLOW_EVALUATION_HOLDOUT_PLAN_INVALID"
    );
    if (
      plan.holdoutIdentity !== holdoutIdentity ||
      plan.datasetId !== input.dataset.datasetId ||
      plan.manifestSha256 !== input.dataset.manifestSha256 ||
      plan.datasetFingerprint !== input.dataset.datasetFingerprint ||
      hashCanonicalValue(plan.registration) !== hashCanonicalValue(registration)
    ) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_HOLDOUT_PLAN_INVALID"
      );
    }
    const selection = this.readHoldoutSelection(plan);
    const selectionBytes = readPrivateArtifactBytes(
      this.#directory,
      holdoutSelectionFileName(holdoutIdentity),
      4 * 1024 * 1024
    );
    const selectionClaimSha256 = sha256(selectionBytes);
    if (
      baselineCompletion.completion.runId !== baselineState.runId ||
      candidateCompletion.completion.runId !== candidateState.runId ||
      baselineState.globalClaimSha256 === null ||
      candidateState.globalClaimSha256 === null
    ) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_REVEAL_CHAIN_MISMATCH"
      );
    }
    if (
      input.baselineSnapshot.genesis.predictionIdentityFingerprint !==
        selection.developmentBaseline.predictionIdentityFingerprint ||
      input.candidateSnapshot.genesis.predictionIdentityFingerprint !==
        selection.developmentCandidate.predictionIdentityFingerprint
    ) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_REVEAL_CHAIN_MISMATCH"
      );
    }
    if (
      baselineState.publication?.kind !== "holdout_prediction" ||
      candidateState.publication?.kind !== "holdout_prediction" ||
      baselineState.publication.registryReceiptSha256 !==
        baselineCompletion.sha256 ||
      candidateState.publication.registryReceiptSha256 !==
        candidateCompletion.sha256 ||
      baselineState.publication.artifactSetSha256 !==
        baselineCompletion.completion.projectionSetSha256 ||
      candidateState.publication.artifactSetSha256 !==
        candidateCompletion.completion.projectionSetSha256
    ) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_REVEAL_CHAIN_MISMATCH"
      );
    }
    this.assertLabelClaim({
      genesis: input.baselineSnapshot.genesis,
      datasetFingerprint: input.dataset.datasetFingerprint,
      holdoutIdentity,
      thresholdPolicySha256: registration.thresholdPolicySha256,
      expectedSha256: baselineState.globalClaimSha256
    });
    this.assertLabelClaim({
      genesis: input.candidateSnapshot.genesis,
      datasetFingerprint: input.dataset.datasetFingerprint,
      holdoutIdentity,
      thresholdPolicySha256: registration.thresholdPolicySha256,
      expectedSha256: candidateState.globalClaimSha256
    });
    assertSlotForReveal(
      this.#directory,
      holdoutIdentity,
      "baseline",
      input.baselineSnapshot.genesis,
      baselineCompletion.completion,
      selectionClaimSha256,
      selection.developmentBaseline.predictionIdentityFingerprint
    );
    assertSlotForReveal(
      this.#directory,
      holdoutIdentity,
      "candidate",
      input.candidateSnapshot.genesis,
      candidateCompletion.completion,
      selectionClaimSha256,
      selection.developmentCandidate.predictionIdentityFingerprint
    );
    const claim = reviewFlowEvaluationRevealClaimSchema.parse({
      schemaVersion: 2,
      artifactKind: "review_flow_evaluation_holdout_reveal_claim",
      holdoutIdentity,
      thresholdPolicySha256: registration.thresholdPolicySha256,
      baselineLabel: registration.baselineLabel,
      candidateLabel: registration.candidateLabel,
      baselineCompletionSha256: baselineCompletion.sha256,
      candidateCompletionSha256: candidateCompletion.sha256,
      baselineExecutionCompletionFingerprint:
        baselineState.executionSeal!.completionFingerprint,
      candidateExecutionCompletionFingerprint:
        candidateState.executionSeal!.completionFingerprint,
      selectionClaimSha256,
      scoringCodeVersion: input.scoringCodeIdentity.codeVersion,
      scoringDependencyCodeSha256:
        input.scoringCodeIdentity.dependencyCodeSha256
    });
    const fileName = revealClaimFileName(holdoutIdentity);
    recoverPrivateArtifactExclusiveOrphan(this.#directory, fileName, 1024 * 1024);
    const existing = readPrivateArtifactBytesIfPresent(
      this.#directory,
      fileName,
      1024 * 1024
    );
    if (existing !== null && !input.resume) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_HOLDOUT_ALREADY_REVEALED"
      );
    }
    if (
      existing === null &&
      [
        ...reportArtifactNames(registration.baselineLabel),
        ...reportArtifactNames(registration.candidateLabel),
        `holdout-${holdoutIdentity}-comparison.private.json`,
        `holdout-${holdoutIdentity}-comparison-set.private.json`
      ].some((name) =>
        readPrivateArtifactBytesIfPresent(
          this.#directory,
          name,
          32 * 1024 * 1024
        ) !== null
      )
    ) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_REVEAL_PARTIAL_ARTIFACT_EXISTS"
      );
    }
    const claimText = serializePhysicalBlindArtifact(claim);
    if (existing === null && !input.resume) {
      try {
        writePrivateArtifactExclusive(this.#directory, fileName, claimText);
      } catch {
        throw new ReviewFlowEvaluationRegistryError(
          "REVIEW_FLOW_EVALUATION_HOLDOUT_REVEAL_CLAIM_RACE"
        );
      }
    }
    const bytes = ensureExactArtifact(this.#directory, fileName, claimText);
    return { claim, sha256: sha256(bytes) };
  }

  /** summary -> markdown -> registry receipt -> marker（最终发布点），可逐步崩溃恢复。 */
  public publishScoredReport(input: {
    readonly state: ReviewFlowEvaluationCheckpointState;
    readonly summaryJson: string;
    readonly markdown: string;
  }): {
    readonly marker: ReviewFlowEvaluationReportSetMarker;
    readonly markerSha256: string;
    readonly receipt: ReviewFlowEvaluationPublicationReceipt;
    readonly receiptSha256: string;
  } {
    this.assertOpen();
    const seal = input.state.executionSeal;
    if (seal === null || input.state.globalClaimSha256 === null) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_REPORT_STATE_INVALID"
      );
    }
    assertRegistryLabelClaimForState(this.#directory, input.state);
    const parsedSummary = parseReviewFlowEvaluationReportSummary(
      Buffer.from(input.summaryJson, "utf8")
    );
    if (
      parsedSummary.label !== input.state.label ||
      parsedSummary.runId !== input.state.runId ||
      parsedSummary.variant !== input.state.variant ||
      parsedSummary.complete !== seal.complete ||
      parsedSummary.generatedAt !== seal.sealedAt ||
      parsedSummary.executionCompletionFingerprint !==
        seal.completionFingerprint ||
      parsedSummary.dataset.fingerprint !==
        input.state.identity.datasetFingerprint ||
      hashCanonicalValue(parsedSummary.executionIdentity) !==
        input.state.identityFingerprint
    ) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_REPORT_STATE_INVALID"
      );
    }
    const summarySha256 = sha256(input.summaryJson);
    const markdownSha256 = sha256(input.markdown);
    const marker = reviewFlowEvaluationReportSetMarkerSchema.parse({
      schemaVersion: 2,
      protocolVersion: "review-flow-evaluation-v2",
      label: input.state.label,
      runId: input.state.runId,
      summarySha256,
      markdownSha256,
      complete: seal.complete,
      executionCompletionFingerprint: seal.completionFingerprint,
      labelClaimSha256: input.state.globalClaimSha256
    });
    const markerText = serializePhysicalBlindArtifact(marker);
    const names = reportArtifactNames(input.state.label);
    ensureExactArtifact(this.#directory, names[0]!, input.summaryJson);
    ensureExactArtifact(this.#directory, names[1]!, input.markdown);
    const markerBytes = Buffer.from(markerText, "utf8");
    const receipt = reviewFlowEvaluationPublicationReceiptSchema.parse({
      schemaVersion: 2,
      artifactKind: "review_flow_evaluation_report_publication",
      label: input.state.label,
      runId: input.state.runId,
      labelClaimSha256: input.state.globalClaimSha256,
      executionCompletionFingerprint: seal.completionFingerprint,
      summarySha256,
      markdownSha256,
      reportSetSha256: sha256(markerBytes),
      complete: seal.complete
    });
    const receiptBytes = ensureExactArtifact(
      this.#directory,
      names[2]!,
      serializePhysicalBlindArtifact(receipt)
    );
    // report-set marker 是唯一最终发布点；receipt 存在但 marker 缺失仍是 partial。
    ensureExactArtifact(this.#directory, names[3]!, markerText);
    return {
      marker,
      markerSha256: sha256(markerBytes),
      receipt,
      receiptSha256: sha256(receiptBytes)
    };
  }

  public loadPublishedReport(label: string): ReviewFlowEvaluationPublishedReport {
    this.assertOpen();
    const parsedLabel = reviewFlowEvaluationLabelSchema.parse(label);
    const names = reportArtifactNames(parsedLabel);
    try {
      const summaryBytes = readPrivateArtifactBytes(
        this.#directory,
        names[0]!,
        32 * 1024 * 1024
      );
      const markdownBytes = readPrivateArtifactBytes(
        this.#directory,
        names[1]!,
        32 * 1024 * 1024
      );
      const markerBytes = readPrivateArtifactBytes(
        this.#directory,
        names[3]!,
        1024 * 1024
      );
      const receiptBytes = readPrivateArtifactBytes(
        this.#directory,
        names[2]!,
        1024 * 1024
      );
      const labelClaimBytes = readPrivateArtifactBytes(
        this.#directory,
        labelClaimFileName(parsedLabel),
        1024 * 1024
      );
      const marker = parseArtifact(
        markerBytes,
        reviewFlowEvaluationReportSetMarkerSchema,
        "REVIEW_FLOW_EVALUATION_REPORT_MARKER_INVALID"
      );
      const receipt = parseArtifact(
        receiptBytes,
        reviewFlowEvaluationPublicationReceiptSchema,
        "REVIEW_FLOW_EVALUATION_PUBLICATION_RECEIPT_INVALID"
      );
      const labelClaim = parseArtifact(
        labelClaimBytes,
        reviewFlowEvaluationLabelClaimSchema,
        "REVIEW_FLOW_EVALUATION_LABEL_CLAIM_INVALID"
      );
      if (
        marker.label !== parsedLabel ||
        receipt.label !== parsedLabel ||
        labelClaim.label !== parsedLabel ||
        marker.runId !== receipt.runId ||
        marker.runId !== labelClaim.runId ||
        marker.summarySha256 !== sha256(summaryBytes) ||
        marker.markdownSha256 !== sha256(markdownBytes) ||
        receipt.reportSetSha256 !== sha256(markerBytes) ||
        marker.labelClaimSha256 !== sha256(labelClaimBytes) ||
        receipt.labelClaimSha256 !== sha256(labelClaimBytes) ||
        marker.executionCompletionFingerprint !==
          receipt.executionCompletionFingerprint ||
        marker.complete !== receipt.complete
      ) {
        throw new Error("invalid");
      }
      return {
        summaryBytes,
        markdownBytes,
        markerBytes,
        marker,
        receiptBytes,
        receipt,
        labelClaimBytes,
        labelClaim
      };
    } catch {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_PUBLISHED_REPORT_INVALID"
      );
    }
  }

  public publishHoldoutComparison(input: {
    readonly dataset: ReviewFlowEvaluationDatasetBundle;
    readonly revealClaimSha256: string;
    readonly baselineReportSetSha256: string;
    readonly candidateReportSetSha256: string;
    readonly comparisonJson: string;
  }): { readonly markerSha256: string } {
    this.assertOpen();
    const holdoutIdentity = input.dataset.holdoutIdentity;
    const registration = input.dataset.holdoutRegistration;
    if (
      input.dataset.loadMode !== "holdout_reveal" ||
      input.dataset.purpose !== "holdout" ||
      input.dataset.summary === null ||
      holdoutIdentity === null ||
      registration === null
    ) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_COMPARISON_INVALID"
      );
    }
    try {
      const revealClaimBytes = readPrivateArtifactBytes(
        this.#directory,
        revealClaimFileName(holdoutIdentity),
        1024 * 1024
      );
      const revealClaim = parseArtifact(
        revealClaimBytes,
        reviewFlowEvaluationRevealClaimSchema,
        "REVIEW_FLOW_EVALUATION_REVEAL_CLAIM_INVALID"
      );
      if (
        sha256(revealClaimBytes) !== input.revealClaimSha256 ||
        revealClaim.holdoutIdentity !== holdoutIdentity ||
        revealClaim.thresholdPolicySha256 !== registration.thresholdPolicySha256 ||
        revealClaim.baselineLabel !== registration.baselineLabel ||
        revealClaim.candidateLabel !== registration.candidateLabel
      ) {
        throw new Error("invalid reveal claim");
      }
      const baselineReport = this.loadPublishedReport(revealClaim.baselineLabel);
      const candidateReport = this.loadPublishedReport(revealClaim.candidateLabel);
      const baselineSummary = parseReviewFlowEvaluationReportSummary(
        baselineReport.summaryBytes
      );
      const candidateSummary = parseReviewFlowEvaluationReportSummary(
        candidateReport.summaryBytes
      );
      if (
        sha256(baselineReport.markerBytes) !== input.baselineReportSetSha256 ||
        sha256(candidateReport.markerBytes) !== input.candidateReportSetSha256 ||
        baselineReport.marker.executionCompletionFingerprint !==
          revealClaim.baselineExecutionCompletionFingerprint ||
        candidateReport.marker.executionCompletionFingerprint !==
          revealClaim.candidateExecutionCompletionFingerprint ||
        baselineSummary.label !== revealClaim.baselineLabel ||
        candidateSummary.label !== revealClaim.candidateLabel ||
        baselineSummary.runId !== baselineReport.marker.runId ||
        candidateSummary.runId !== candidateReport.marker.runId ||
        baselineSummary.dataset.fingerprint !== input.dataset.datasetFingerprint ||
        candidateSummary.dataset.fingerprint !== input.dataset.datasetFingerprint ||
        baselineSummary.dataset.holdoutIdentity !== holdoutIdentity ||
        candidateSummary.dataset.holdoutIdentity !== holdoutIdentity
      ) {
        throw new Error("invalid report chain");
      }
      const expectedComparison = buildReviewFlowEvaluationComparison({
        holdoutIdentity,
        thresholdPolicySha256: registration.thresholdPolicySha256,
        baseline: baselineSummary,
        candidate: candidateSummary,
        baselineReportSha256: sha256(baselineReport.summaryBytes),
        candidateReportSha256: sha256(candidateReport.summaryBytes)
      });
      if (expectedComparison.json !== input.comparisonJson) {
        throw new Error("invalid comparison");
      }
    } catch (error) {
      if (
        error instanceof ReviewFlowEvaluationRegistryError &&
        error.code === "REVIEW_FLOW_EVALUATION_COMPARISON_INVALID"
      ) {
        throw error;
      }
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_COMPARISON_INVALID"
      );
    }
    const comparisonSha256 = sha256(input.comparisonJson);
    const marker = reviewFlowEvaluationComparisonMarkerSchema.parse({
      schemaVersion: 2,
      artifactKind: "review_flow_evaluation_holdout_comparison",
      holdoutIdentity,
      revealClaimSha256: input.revealClaimSha256,
      baselineLabel: registration.baselineLabel,
      candidateLabel: registration.candidateLabel,
      baselineReportSetSha256: input.baselineReportSetSha256,
      candidateReportSetSha256: input.candidateReportSetSha256,
      comparisonSha256
    });
    ensureExactArtifact(
      this.#directory,
      `holdout-${holdoutIdentity}-comparison.private.json`,
      input.comparisonJson
    );
    const markerBytes = ensureExactArtifact(
      this.#directory,
      `holdout-${holdoutIdentity}-comparison-set.private.json`,
      serializePhysicalBlindArtifact(marker)
    );
    return { markerSha256: sha256(markerBytes) };
  }

  private claimSubjectUsage(
    observations: readonly z.infer<typeof developmentUseObservationSchema>[],
    purpose: z.infer<typeof usagePurposeSchema>
  ): void {
    const claims = observations.flatMap((observation) => [
      {
        fileName: subjectUsageClaimFileName(observation.subjectId),
        claim: reviewFlowEvaluationSubjectUsageClaimSchema.parse({
          schemaVersion: 2,
          artifactKind: "review_flow_evaluation_subject_usage_claim",
          keyKind: "subject",
          purpose,
          subjectId: observation.subjectId
        })
      },
      {
        fileName: sourceLineageUsageClaimFileName(
          observation.sourceLineageSha256
        ),
        claim: reviewFlowEvaluationSubjectUsageClaimSchema.parse({
          schemaVersion: 2,
          artifactKind: "review_flow_evaluation_subject_usage_claim",
          keyKind: "source_lineage",
          purpose,
          subjectId: observation.subjectId,
          valueSha256: observation.sourceLineageSha256
        })
      },
      {
        fileName: contentUsageClaimFileName(observation.contentSha256),
        claim: reviewFlowEvaluationSubjectUsageClaimSchema.parse({
          schemaVersion: 2,
          artifactKind: "review_flow_evaluation_subject_usage_claim",
          keyKind: "content",
          purpose,
          subjectId: observation.subjectId,
          valueSha256: observation.contentSha256
        })
      },
      {
        fileName: problemContentUsageClaimFileName(
          observation.problemContentSha256
        ),
        claim: reviewFlowEvaluationSubjectUsageClaimSchema.parse({
          schemaVersion: 2,
          artifactKind: "review_flow_evaluation_subject_usage_claim",
          keyKind: "problem_content",
          purpose,
          subjectId: observation.subjectId,
          valueSha256: observation.problemContentSha256
        })
      },
      {
        fileName: anklangResponseUsageClaimFileName(
          observation.originalAnklangResponseSha256
        ),
        claim: reviewFlowEvaluationSubjectUsageClaimSchema.parse({
          schemaVersion: 2,
          artifactKind: "review_flow_evaluation_subject_usage_claim",
          keyKind: "anklang_response",
          purpose,
          subjectId: observation.subjectId,
          valueSha256: observation.originalAnklangResponseSha256
        })
      }
    ]).sort((left, right) => left.fileName.localeCompare(right.fileName));

    // 先检查全部既有索引，避免已知冲突时再留下更多 partial；随后仍依靠
    // O_EXCL 抵御两个进程在预检后同时竞争同一索引。
    for (const entry of claims) {
      const existing = readPrivateArtifactBytesIfPresent(
        this.#directory,
        entry.fileName,
        1024 * 1024
      );
      if (
        existing !== null &&
        !existing.equals(
          Buffer.from(serializePhysicalBlindArtifact(entry.claim), "utf8")
        )
      ) {
        throw new ReviewFlowEvaluationRegistryError(
          "REVIEW_FLOW_EVALUATION_SUBJECT_USAGE_CONFLICT"
        );
      }
    }
    for (const entry of claims) {
      try {
        ensureExactArtifact(
          this.#directory,
          entry.fileName,
          serializePhysicalBlindArtifact(entry.claim)
        );
      } catch {
        throw new ReviewFlowEvaluationRegistryError(
          "REVIEW_FLOW_EVALUATION_SUBJECT_USAGE_CONFLICT"
        );
      }
    }
  }

  public close(): void {
    if (!this.#closed) {
      this.#closed = true;
      closePrivateDirectory(this.#directory);
    }
  }

  private assertOpen(): void {
    if (this.#closed) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_REGISTRY_CLOSED"
      );
    }
  }
}

function assertLabelClaimMatches(
  claim: ReviewFlowEvaluationLabelClaim,
  input: {
    readonly genesis: ReviewFlowEvaluationCheckpointGenesisBinding;
    readonly datasetFingerprint: string;
    readonly holdoutIdentity: string | null;
    readonly thresholdPolicySha256: string | null;
  }
): void {
  const genesis = input.genesis;
  if (
    claim.label !== genesis.label ||
    claim.runId !== genesis.runId ||
    claim.variant !== genesis.variant ||
    claim.purpose !== genesis.purpose ||
    claim.identityFingerprint !== genesis.identityFingerprint ||
    claim.datasetFingerprint !== input.datasetFingerprint ||
    claim.expectedCasesFingerprint !== genesis.expectedCasesFingerprint ||
    claim.checkpointGenesisFingerprint !== genesis.checkpointGenesisFingerprint ||
    claim.stateDirectory.device !== genesis.stateDirectory.device ||
    claim.stateDirectory.inode !== genesis.stateDirectory.inode ||
    claim.holdoutIdentity !== input.holdoutIdentity ||
    claim.thresholdPolicySha256 !== input.thresholdPolicySha256
  ) {
    throw new ReviewFlowEvaluationRegistryError(
      "REVIEW_FLOW_EVALUATION_LABEL_CLAIM_MISMATCH"
    );
  }
}

function developmentNominationReport(
  published: ReviewFlowEvaluationPublishedReport,
  label: string,
  variant: "baseline" | "candidate",
  plan: ReviewFlowEvaluationHoldoutPlan
): {
  readonly summary: ReturnType<typeof parseReviewFlowEvaluationReportSummary>;
  readonly binding: z.infer<typeof developmentNominationReportSchema>;
} {
  try {
    const summary = parseReviewFlowEvaluationReportSummary(published.summaryBytes);
    const predictionIdentity = reviewFlowEvaluationPredictionIdentity(
      summary.executionIdentity
    );
    if (
      summary.label !== label ||
      summary.variant !== variant ||
      summary.complete !== true ||
      summary.scoring.valid !== true ||
      summary.dataset.purpose !== "development" ||
      summary.dataset.safeId !== plan.datasetId ||
      summary.dataset.manifestSha256 !== plan.manifestSha256 ||
      summary.executionIdentity.manifestSha256 !== plan.manifestSha256 ||
      summary.runId !== published.marker.runId ||
      summary.runId !== published.receipt.runId ||
      summary.runId !== published.labelClaim.runId ||
      published.marker.complete !== true ||
      published.receipt.complete !== true ||
      summary.caseCounts.completed !== summary.caseCounts.expected ||
      summary.receiptCoverage.completeElevenRoleReceiptCaseCount !==
        summary.caseCounts.expected ||
      published.labelClaim.variant !== variant ||
      published.labelClaim.purpose !== "development" ||
      published.labelClaim.datasetFingerprint !== summary.dataset.fingerprint ||
      published.labelClaim.identityFingerprint !==
        hashCanonicalValue(summary.executionIdentity) ||
      (variant === "baseline" &&
        (summary.baselineLabel !== null || summary.baselineBinding !== null)) ||
      (variant === "candidate" &&
        (summary.baselineLabel === null || summary.baselineBinding === null))
    ) {
      throw new Error("invalid");
    }
    const binding = developmentNominationReportSchema.parse({
      label,
      runId: summary.runId,
      datasetFingerprint: summary.dataset.fingerprint,
      manifestSha256: summary.dataset.manifestSha256,
      summarySha256: sha256(published.summaryBytes),
      markdownSha256: sha256(published.markdownBytes),
      reportSetSha256: sha256(published.markerBytes),
      labelClaimSha256: sha256(published.labelClaimBytes),
      publicationReceiptSha256: sha256(published.receiptBytes),
      executionCompletionFingerprint: summary.executionCompletionFingerprint,
      predictionIdentity,
      predictionIdentityFingerprint:
        reviewFlowEvaluationPredictionIdentityFingerprint(
          summary.executionIdentity
        )
    });
    return { summary, binding };
  } catch {
    throw new ReviewFlowEvaluationRegistryError(
      "REVIEW_FLOW_EVALUATION_HOLDOUT_SELECTION_INVALID"
    );
  }
}

function baselineBindingForNomination(
  published: ReviewFlowEvaluationPublishedReport,
  summary: ReturnType<typeof parseReviewFlowEvaluationReportSummary>
): ReviewFlowEvaluationBaselineBinding {
  return reviewFlowEvaluationBaselineBindingSchema.parse({
    schemaVersion: 2,
    label: summary.label,
    runId: summary.runId,
    datasetFingerprint: summary.dataset.fingerprint,
    summarySha256: sha256(published.summaryBytes),
    markdownSha256: sha256(published.markdownBytes),
    reportSetSha256: sha256(published.markerBytes),
    labelClaimSha256: sha256(published.labelClaimBytes),
    publicationReceiptSha256: sha256(published.receiptBytes),
    executionCompletionFingerprint: summary.executionCompletionFingerprint,
    codeVersion: summary.executionIdentity.codeIdentity.codeVersion,
    configurationFingerprint: summary.executionIdentity.configurationFingerprint,
    runnerIdentity: summary.executionIdentity.runnerIdentity
  });
}

function assertRevealState(
  state: ReviewFlowEvaluationCheckpointState,
  dataset: ReviewFlowEvaluationDatasetBundle,
  variant: "baseline" | "candidate",
  label: string
): void {
  const holdoutIdentity = dataset.holdoutIdentity;
  const registration = dataset.holdoutRegistration;
  if (
    holdoutIdentity === null ||
    registration === null ||
    state.variant !== variant ||
    state.label !== label ||
    state.identity.purpose !== "holdout" ||
    state.identity.datasetFingerprint !== dataset.datasetFingerprint ||
    state.identity.manifestSha256 !== dataset.manifestSha256 ||
    state.holdoutIdentity !== holdoutIdentity ||
    state.thresholdPolicySha256 !== registration.thresholdPolicySha256 ||
    state.executionSeal?.complete !== true ||
    state.termination !== null ||
    state.entries.some((entry) => entry.status !== "completed") ||
    state.expectedCases.length !== dataset.cases.length ||
    state.expectedCases.some((expected, index) => {
      const actual = dataset.cases[index];
      return actual === undefined ||
        expected.safeId !== actual.safeId ||
        expected.subjectId !== actual.subjectId ||
        expected.sourceLineageSha256 !== actual.sourceLineageSha256 ||
        expected.contentSha256 !== actual.contentSha256;
    })
  ) {
    throw new ReviewFlowEvaluationRegistryError(
      "REVIEW_FLOW_EVALUATION_REVEAL_CHAIN_MISMATCH"
    );
  }
}

function assertRegistryLabelClaimForState(
  directory: PrivateDirectoryHandle,
  state: ReviewFlowEvaluationCheckpointState
): void {
  if (state.globalClaimSha256 === null) {
    throw new ReviewFlowEvaluationRegistryError(
      "REVIEW_FLOW_EVALUATION_LABEL_CLAIM_MISMATCH"
    );
  }
  try {
    const bytes = readPrivateArtifactBytes(
      directory,
      labelClaimFileName(state.label),
      1024 * 1024
    );
    const claim = parseArtifact(
      bytes,
      reviewFlowEvaluationLabelClaimSchema,
      "REVIEW_FLOW_EVALUATION_LABEL_CLAIM_INVALID"
    );
    if (
      sha256(bytes) !== state.globalClaimSha256 ||
      claim.label !== state.label ||
      claim.runId !== state.runId ||
      claim.variant !== state.variant ||
      claim.purpose !== state.identity.purpose ||
      claim.identityFingerprint !== state.identityFingerprint ||
      claim.datasetFingerprint !== state.identity.datasetFingerprint ||
      claim.expectedCasesFingerprint !== hashCanonicalValue(state.expectedCases) ||
      claim.holdoutIdentity !== state.holdoutIdentity ||
      claim.thresholdPolicySha256 !== state.thresholdPolicySha256
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new ReviewFlowEvaluationRegistryError(
      "REVIEW_FLOW_EVALUATION_LABEL_CLAIM_MISMATCH"
    );
  }
}

function assertSlotForReveal(
  directory: PrivateDirectoryHandle,
  holdoutIdentity: string,
  variant: "baseline" | "candidate",
  genesis: ReviewFlowEvaluationCheckpointGenesisBinding,
  completion: ReviewFlowEvaluationPredictionCompletion,
  selectionClaimSha256: string,
  predictionIdentityFingerprint: string
): void {
  try {
    const bytes = readPrivateArtifactBytes(
      directory,
      holdoutSlotFileName(holdoutIdentity, variant),
      1024 * 1024
    );
    const slot = parseArtifact(
      bytes,
      reviewFlowEvaluationHoldoutSlotSchema,
      "REVIEW_FLOW_EVALUATION_HOLDOUT_SLOT_INVALID"
    );
    if (
      sha256(bytes) !== completion.slotClaimSha256 ||
      slot.holdoutIdentity !== holdoutIdentity ||
      slot.slot !== variant ||
      slot.label !== genesis.label ||
      slot.runId !== genesis.runId ||
      slot.identityFingerprint !== genesis.identityFingerprint ||
      slot.checkpointGenesisFingerprint !== genesis.checkpointGenesisFingerprint ||
      slot.labelClaimSha256 !== completion.labelClaimSha256 ||
      slot.selectionClaimSha256 !== selectionClaimSha256 ||
      slot.predictionIdentityFingerprint !== predictionIdentityFingerprint ||
      slot.predictionIdentityFingerprint !== genesis.predictionIdentityFingerprint ||
      slot.stateDirectory.device !== genesis.stateDirectory.device ||
      slot.stateDirectory.inode !== genesis.stateDirectory.inode
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new ReviewFlowEvaluationRegistryError(
      "REVIEW_FLOW_EVALUATION_HOLDOUT_SLOT_INVALID"
    );
  }
}

function parseArtifact<T>(
  bytes: Buffer,
  schema: z.ZodType<T>,
  code: string
): T {
  try {
    return parseVersionedStrictArtifact({
      value: parsePhysicalBlindJson(bytes.toString("utf8")),
      schema,
      supportedVersions: [2]
    });
  } catch {
    throw new ReviewFlowEvaluationRegistryError(code);
  }
}

function ensureExactArtifact(
  directory: PrivateDirectoryHandle,
  fileName: string,
  text: string
): Buffer {
  try {
    return ensurePrivateArtifactExact(directory, fileName, text, 32 * 1024 * 1024);
  } catch (error) {
    if (error instanceof PhysicalBlindArtifactError) {
      throw new ReviewFlowEvaluationRegistryError(
        "REVIEW_FLOW_EVALUATION_ARTIFACT_CONFLICT"
      );
    }
    throw error;
  }
}

function readPrivateArtifactBytes(
  directory: PrivateDirectoryHandle,
  fileName: string,
  maximumBytes: number
): Buffer {
  recoverPrivateArtifactExclusiveOrphan(directory, fileName, maximumBytes);
  return readPrivateArtifactBytesStrict(directory, fileName, maximumBytes);
}

function readPrivateArtifactBytesIfPresent(
  directory: PrivateDirectoryHandle,
  fileName: string,
  maximumBytes: number
): Buffer | null {
  recoverPrivateArtifactExclusiveOrphan(directory, fileName, maximumBytes);
  return readPrivateArtifactBytesIfPresentStrict(
    directory,
    fileName,
    maximumBytes
  );
}

function labelClaimFileName(label: string): string {
  return `label-${label}.claim.private.json`;
}

function runClaimFileName(runId: string): string {
  return `run-${runId}.claim.private.json`;
}

function sortedUsageObservations(
  dataset: ReviewFlowEvaluationDatasetBundle
): z.infer<typeof developmentUseObservationSchema>[] {
  return dataset.cases
    .map((entry) => ({
      subjectId: entry.subjectId,
      sourceLineageSha256: entry.sourceLineageSha256,
      contentSha256: entry.contentSha256,
      problemContentSha256: entry.task.problem.contentHash,
      originalAnklangResponseSha256:
        entry.originalAnklangResponseSha256
    }))
    .sort((left, right) =>
      `${left.subjectId}:${left.sourceLineageSha256}:${left.contentSha256}:${left.problemContentSha256}:${left.originalAnklangResponseSha256}`
        .localeCompare(
          `${right.subjectId}:${right.sourceLineageSha256}:${right.contentSha256}:${right.problemContentSha256}:${right.originalAnklangResponseSha256}`
        )
    );
}

function subjectUsageClaimFileName(subjectId: string): string {
  return `usage-subject-${sha256(subjectId)}.private.json`;
}

function sourceLineageUsageClaimFileName(sourceLineageSha256: string): string {
  return `usage-source-lineage-${sourceLineageSha256}.private.json`;
}

function contentUsageClaimFileName(contentSha256: string): string {
  return `usage-content-${contentSha256}.private.json`;
}

function problemContentUsageClaimFileName(problemContentSha256: string): string {
  return `usage-problem-content-${problemContentSha256}.private.json`;
}

function anklangResponseUsageClaimFileName(responseSha256: string): string {
  return `usage-anklang-response-${responseSha256}.private.json`;
}

function developmentUsePlanFileName(datasetFingerprint: string): string {
  return `development-${datasetFingerprint}.use.private.json`;
}

function reportArtifactNames(label: string): readonly [string, string, string, string] {
  return [
    `review-flow-${label}-summary.private.json`,
    `review-flow-${label}.private.md`,
    `label-${label}.published.private.json`,
    `review-flow-${label}-report-set.private.json`
  ];
}

function holdoutPlanFileName(holdoutIdentity: string): string {
  return `holdout-${holdoutIdentity}.plan.private.json`;
}

function holdoutSelectionFileName(holdoutIdentity: string): string {
  return `holdout-${holdoutIdentity}.selection.private.json`;
}

function holdoutSlotFileName(
  holdoutIdentity: string,
  slot: "baseline" | "candidate"
): string {
  return `holdout-${holdoutIdentity}-${slot}.slot.private.json`;
}

function predictionCompletionFileName(
  holdoutIdentity: string,
  slot: "baseline" | "candidate"
): string {
  return `holdout-${holdoutIdentity}-${slot}.complete.private.json`;
}

function revealClaimFileName(holdoutIdentity: string): string {
  return `holdout-${holdoutIdentity}.reveal.private.json`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
