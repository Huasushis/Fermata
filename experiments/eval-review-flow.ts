#!/usr/bin/env node
/**
 * 正式 11 角色审题流的离线准确性实验入口。
 *
 * run：development 直接计分；holdout 只保存预测链，绝不读取 Gold。
 * reveal：两条已封存 holdout 链都完整后，一次性揭盲并同时生成前后报告。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertNoUnknownPrefixedEnvironmentKeys,
  assertSafeNodeEnvironment
} from "../scripts/env-file.mjs";
import {
  allowedReviewFlowEvaluationRunEnvironmentKeys
} from "../scripts/run-with-env.mjs";
import { hashCanonicalValue } from "../src/review-flow/evidence";
import { loadDifficultyAnchorsStrict } from "./lib/difficulty-anchors-strict";
import {
  hashEvaluationCodeBundle,
  type EvaluationCodeIdentity
} from "./lib/evaluation-code-identity";
import {
  parseBoundedPositiveInteger,
  parseEvaluationCodeVersion
} from "./lib/evaluation-integrity";
import {
  createReviewFlowEvaluationAdapter
} from "./lib/review-flow-evaluation-adapter";
import {
  assertNarrowReviewFlowEvaluationEnvironment,
  loadReviewFlowEvaluationConfig
} from "./lib/review-flow-evaluation-config";
import {
  loadReviewFlowEvaluationDataset,
  loadReviewFlowEvaluationPrivateCaseSelector,
  reviewFlowEvaluationCaseSelectorSchema,
  reviewFlowEvaluationLabelSchema,
  reviewFlowEvaluationPurposeSchema,
  reviewFlowEvaluationSafeIdSchema,
  selectReviewFlowEvaluationPrivateSubset,
  selectReviewFlowEvaluationRepresentative3,
  selectReviewFlowEvaluationRepresentative3V2,
  selectReviewFlowEvaluationRepresentative3V3,
  type ReviewFlowEvaluationCaseSelector,
  type ReviewFlowEvaluationPurpose
} from "./lib/review-flow-evaluation-dataset";
import {
  ReviewFlowEvaluationGlobalRegistry,
  type ReviewFlowEvaluationPublishedReport
} from "./lib/review-flow-evaluation-registry";
import {
  buildReviewFlowEvaluationComparison,
  buildReviewFlowEvaluationReport,
  parseReviewFlowEvaluationReportSummary
} from "./lib/review-flow-evaluation-report";
import {
  installReviewFlowEvaluationSignalHandlers,
  maxReviewFlowEvaluationCaseAttempts,
  ReviewFlowEvaluationStartGate,
  runReviewFlowEvaluationCases
} from "./lib/review-flow-evaluation-runner";
import {
  loadReviewFlowEvaluationCheckpointForReveal,
  loadReviewFlowEvaluationCheckpointStateFromPath,
  openReviewFlowSafeStreamCheckpoint,
  ReviewFlowEvaluationCheckpoint,
  reviewFlowEvaluationBaselineBindingSchema,
  type ReviewFlowEvaluationBaselineBinding,
  type ReviewFlowSafeStreamCheckpoint
} from "./lib/review-flow-evaluation-state";
import {
  loadReviewFlowRuntimeAttestation,
  reviewFlowRuntimeIdentitySchema,
  type ReviewFlowRuntimeAttestation
} from "./lib/review-flow-runtime-attestation";

const repositoryDirectory = fileURLToPath(new URL("../", import.meta.url));
const anchorsFile = new URL("../config/anchors/difficulty.json", import.meta.url);
const protectedEvaluationEnvironmentPrefixes = [
  "AETHER_",
  "CODEFORCES_",
  "DASHSCOPE_",
  "EVAL_",
  "FERMATA_",
  "LEVELS_",
  "URMOTIV_"
] as const;

export interface ReviewFlowEvaluationRunCliOptions {
  readonly action: "run";
  readonly manifestPath: string;
  readonly revealDescriptorPath: string | null;
  readonly datasetPrivateRoot: string;
  readonly privateDirectory: string;
  readonly purpose: ReviewFlowEvaluationPurpose;
  readonly label: string;
  readonly variant: "baseline" | "candidate";
  readonly baselineLabel: string | null;
  readonly developmentBaselineLabel: string | null;
  readonly developmentCandidateLabel: string | null;
  readonly resume: boolean;
  readonly failedOnly: boolean;
  readonly failedOnlySourcePath: string | null;
  readonly failedOnlyCaseIds: readonly string[] | null;
  readonly caseSelector: ReviewFlowEvaluationCaseSelector | null;
  readonly caseSelectorFilePath: string | null;
  readonly maxCaseAttempts: number;
  readonly maxEventShapeRetries: number | null;
  readonly streamCheckpoints: boolean;
}

export interface ReviewFlowEvaluationRevealCliOptions {
  readonly action: "reveal";
  readonly manifestPath: string;
  readonly revealDescriptorPath: string;
  readonly datasetPrivateRoot: string;
  readonly baselinePrivateDirectory: string;
  readonly candidatePrivateDirectory: string;
  readonly resume: boolean;
}

export type ReviewFlowEvaluationCliOptions =
  | ReviewFlowEvaluationRunCliOptions
  | ReviewFlowEvaluationRevealCliOptions;

export function resolveReviewFlowEvaluationCliOptions(
  argv: readonly string[]
): ReviewFlowEvaluationCliOptions {
  const values = new Map<string, string>();
  let resume = false;
  let failedOnly = false;
  let streamCheckpoints = false;
  for (const argument of argv) {
    if (
      argument === "--resume" ||
      argument === "--failed-only" ||
      argument === "--stream-checkpoints"
    ) {
      if (argument === "--resume") {
        if (resume) throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
        resume = true;
      } else if (argument === "--failed-only") {
        if (failedOnly) throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
        failedOnly = true;
      } else {
        if (streamCheckpoints) {
          throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
        }
        streamCheckpoints = true;
      }
      continue;
    }
    const match = /^--([a-z-]+)=(.*)$/u.exec(argument);
    if (match === null || values.has(match[1]!)) {
      throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
    }
    values.set(match[1]!, match[2]!);
  }
  const action = values.get("action") ?? "run";
  if (action === "reveal") {
    if (failedOnly || streamCheckpoints) {
      throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
    }
    const allowed = new Set([
      "action",
      "manifest",
      "reveal-descriptor",
      "dataset-private-root",
      "baseline-private-dir",
      "candidate-private-dir"
    ]);
    if ([...values.keys()].some((key) => !allowed.has(key))) {
      throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
    }
    const manifestPath = values.get("manifest");
    const revealDescriptorPath = values.get("reveal-descriptor");
    const datasetPrivateRoot = values.get("dataset-private-root");
    const baselinePrivateDirectory = values.get("baseline-private-dir");
    const candidatePrivateDirectory = values.get("candidate-private-dir");
    if (
      manifestPath === undefined || !isAbsolute(manifestPath) ||
      revealDescriptorPath === undefined || !isAbsolute(revealDescriptorPath) ||
      revealDescriptorPath === manifestPath ||
      datasetPrivateRoot === undefined || !isAbsolute(datasetPrivateRoot) ||
      baselinePrivateDirectory === undefined || baselinePrivateDirectory.length === 0 ||
      candidatePrivateDirectory === undefined || candidatePrivateDirectory.length === 0 ||
      baselinePrivateDirectory === candidatePrivateDirectory
    ) {
      throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
    }
    return {
      action: "reveal",
      manifestPath,
      revealDescriptorPath,
      datasetPrivateRoot,
      baselinePrivateDirectory,
      candidatePrivateDirectory,
      resume
    };
  }
  if (action !== "run") {
    throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
  }
  const allowed = new Set([
    "action",
    "manifest",
    "reveal-descriptor",
    "dataset-private-root",
    "private-dir",
    "partition",
    "label",
    "variant",
    "baseline-label",
    "development-baseline-label",
    "development-candidate-label",
    "case-selector",
    "case-selector-file",
    "max-case-attempts",
    "max-event-shape-retries",
    "failed-only-source",
    "failed-only-case-ids"
  ]);
  if ([...values.keys()].some((key) => !allowed.has(key))) {
    throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
  }
  const manifestPath = values.get("manifest");
  const revealDescriptorPathRaw = values.get("reveal-descriptor");
  const datasetPrivateRoot = values.get("dataset-private-root");
  const privateDirectory = values.get("private-dir");
  const label = values.get("label");
  const variant = values.get("variant");
  const purpose = reviewFlowEvaluationPurposeSchema.safeParse(
    values.get("partition")
  );
  if (
    manifestPath === undefined || !isAbsolute(manifestPath) ||
    datasetPrivateRoot === undefined || !isAbsolute(datasetPrivateRoot) ||
    privateDirectory === undefined || privateDirectory.length === 0 ||
    label === undefined ||
    !reviewFlowEvaluationLabelSchema.safeParse(label).success ||
    !purpose.success ||
    (variant !== "baseline" && variant !== "candidate")
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
  }
  const revealDescriptorPath = revealDescriptorPathRaw ?? null;
  if (
    (purpose.data === "development" &&
      (revealDescriptorPath === null || !isAbsolute(revealDescriptorPath))) ||
    (purpose.data === "holdout" && revealDescriptorPath !== null) ||
    revealDescriptorPath === manifestPath
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
  }
  const maxCaseAttemptsRaw = values.get("max-case-attempts");
  const maxCaseAttempts = maxCaseAttemptsRaw === undefined
    ? 3
    : Number(maxCaseAttemptsRaw);
  let maxEventShapeRetries: number | null = null;
  const maxEventShapeRetriesRaw = values.get("max-event-shape-retries");
  if (maxEventShapeRetriesRaw !== undefined) {
    if (maxEventShapeRetriesRaw.length === 0) {
      throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
    }
    maxEventShapeRetries = Number(maxEventShapeRetriesRaw);
  }
  const caseSelectorRaw = values.get("case-selector");
  const caseSelector = caseSelectorRaw === undefined
    ? null
    : reviewFlowEvaluationCaseSelectorSchema.safeParse(caseSelectorRaw);
  if (caseSelector !== null && !caseSelector.success) {
    throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
  }
  const caseSelectorFilePathRaw = values.get("case-selector-file");
  const caseSelectorFilePath = caseSelectorFilePathRaw ?? null;
  if (
    caseSelectorFilePath !== null &&
    (!isAbsolute(caseSelectorFilePath) || caseSelectorFilePath.length === 0)
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
  }
  const failedOnlySourcePathRaw = values.get("failed-only-source");
  const failedOnlySourcePath = failedOnlySourcePathRaw ?? null;
  const failedOnlyCaseIdsRaw = values.get("failed-only-case-ids");
  const failedOnlyCaseIds = failedOnlyCaseIdsRaw === undefined
    ? null
    : failedOnlyCaseIdsRaw.split(",").map((safeId) => {
        if (!reviewFlowEvaluationSafeIdSchema.safeParse(safeId).success) {
          throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
        }
        return safeId;
      });
  if (
    failedOnlySourcePath !== null &&
    !isAbsolute(failedOnlySourcePath)
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
  }
  if (
    failedOnlyCaseIds !== null &&
    new Set(failedOnlyCaseIds).size !== failedOnlyCaseIds.length
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
  }


  if (
    !Number.isSafeInteger(maxCaseAttempts) ||
    maxCaseAttempts < 1 ||
    maxCaseAttempts > maxReviewFlowEvaluationCaseAttempts
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
  }
  if (
    maxEventShapeRetries !== null &&
    (!Number.isSafeInteger(maxEventShapeRetries) ||
      maxEventShapeRetries < 0 ||
      maxEventShapeRetries > 4)
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
  }
  const baselineLabelRaw = values.get("baseline-label");
  const baselineLabel = baselineLabelRaw === undefined ? null : baselineLabelRaw;
  const developmentBaselineLabel =
    values.get("development-baseline-label") ?? null;
  const developmentCandidateLabel =
    values.get("development-candidate-label") ?? null;
  const hasCaseSelection =
    caseSelector !== null || caseSelectorFilePath !== null;
  if (
    (variant === "baseline" && baselineLabel !== null) ||
    (variant === "candidate" &&
      (baselineLabel === null ||
        !reviewFlowEvaluationLabelSchema.safeParse(baselineLabel).success ||
        baselineLabel === label)) ||
    (purpose.data === "development" &&
      (developmentBaselineLabel !== null || developmentCandidateLabel !== null)) ||
    (purpose.data === "holdout" &&
      (developmentBaselineLabel === null ||
        developmentCandidateLabel === null ||
        developmentBaselineLabel === developmentCandidateLabel ||
        !reviewFlowEvaluationLabelSchema.safeParse(developmentBaselineLabel).success ||
        !reviewFlowEvaluationLabelSchema.safeParse(developmentCandidateLabel).success)) ||
    (hasCaseSelection &&
      (
        purpose.data !== "development" ||
        resume ||
        maxCaseAttempts !== 1
      )) ||
    (caseSelector !== null && caseSelectorFilePath !== null) ||
    (!failedOnly &&
      (failedOnlySourcePath !== null || failedOnlyCaseIds !== null)) ||
    (failedOnly &&
      (
        hasCaseSelection ||
        maxCaseAttempts !== 1 ||
        (resume && failedOnlySourcePath !== null) ||
        (!resume && failedOnlySourcePath === null)
      ))
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
  }
  return {
    action: "run",
    manifestPath,
    revealDescriptorPath,
    datasetPrivateRoot,
    privateDirectory,
    purpose: purpose.data,
    label,
    variant,
    baselineLabel,
    developmentBaselineLabel,
    developmentCandidateLabel,
    resume,
    failedOnly,
    failedOnlySourcePath,
    failedOnlyCaseIds,
    maxCaseAttempts,
    maxEventShapeRetries,
    streamCheckpoints,
    caseSelector: caseSelector === null ? null : caseSelector.data,
    caseSelectorFilePath
  };
}

export async function runReviewFlowEvaluationCli(input: {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly dependencies?: {
    readonly directScoringRuntimeAttestation?: ReviewFlowRuntimeAttestation;
    readonly runPredictionOrDevelopment?: typeof runPredictionOrDevelopment;
  };
}): Promise<void> {
  const directScoringArguments = input.argv.filter(
    (argument) => argument === "--direct-scoring"
  );
  if (directScoringArguments.length > 1) {
    throw new Error("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
  }
  const directScoring = directScoringArguments.length === 1;
  const argv = directScoring
    ? input.argv.filter((argument) => argument !== "--direct-scoring")
    : input.argv;
  if (directScoring) {
    assertDirectScoringEnvironment(input.env);
  } else {
    assertReviewFlowEvaluationRuntime(input.env);
  }
  const options = resolveReviewFlowEvaluationCliOptions(argv);
  if (directScoring) {
    assertDirectScoringOptions(options);
  }
  const codeVersion = parseEvaluationCodeVersion(input.env.EVAL_CODE_VERSION);
  const runtimeAttestation = directScoring
    ? input.dependencies?.directScoringRuntimeAttestation ??
      createDirectScoringRuntimeAttestation(options, codeVersion)
    : loadReviewFlowRuntimeAttestation({
        environment: input.env,
        currentRepositoryRoot: repositoryDirectory,
        currentExecutable: process.execPath
      });
  const codeIdentity = runtimeAttestation.codeIdentity;
  if (codeIdentity.codeVersion !== codeVersion) {
    throw new Error("REVIEW_FLOW_EVALUATION_CODE_IDENTITY_INVALID");
  }
  if (options.action === "reveal") {
    if (directScoring) {
      throw new Error("REVIEW_FLOW_EVALUATION_DIRECT_SCORING_SCOPE_INVALID");
    }
    await runReveal({
      options,
      codeIdentity,
      runtimeAttestation
    });
    return;
  }
  await (
    input.dependencies?.runPredictionOrDevelopment ??
    runPredictionOrDevelopment
  )({
    options,
    env: input.env,
    codeIdentity,
    runtimeAttestation,
    now: input.now
  });
}

/** development 必须先以无 Gold 身份视图占用永久用途，再允许打开独立 reveal。 */
export function loadDevelopmentDatasetAfterUsageRegistration(input: {
  readonly manifestPath: string;
  readonly revealDescriptorPath: string;
  readonly datasetPrivateRoot: string;
  readonly containingWorkspace?: string;
  readonly registry: ReviewFlowEvaluationGlobalRegistry;
  readonly caseSelector?: ReviewFlowEvaluationCaseSelector | null;
  readonly caseSelectorFilePath?: string | null;
}) {
  const identityDataset = loadReviewFlowEvaluationDataset({
    manifestPath: input.manifestPath,
    privateRoot: input.datasetPrivateRoot,
    containingWorkspace: input.containingWorkspace,
    mode: "development_identity"
  });
  const caseSelectorFilePath = input.caseSelectorFilePath ?? null;
  if (input.caseSelector !== undefined && input.caseSelector !== null &&
      caseSelectorFilePath !== null) {
    throw new Error("REVIEW_FLOW_EVALUATION_CASE_SELECTOR_CONFLICT");
  }
  const privateSelectorBinding = caseSelectorFilePath === null
    ? null
    : loadReviewFlowEvaluationPrivateCaseSelector({
        selectorPath: caseSelectorFilePath,
        dataset: identityDataset,
        privateRoot: input.datasetPrivateRoot,
        containingWorkspace: input.containingWorkspace
      });
  if (
    input.caseSelector !== undefined &&
    input.caseSelector !== null &&
    identityDataset.cases.length !== 32
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_PARENT_INVALID");
  }
  input.registry.registerDevelopmentUse(identityDataset);
  const scoredDataset = loadReviewFlowEvaluationDataset({
    manifestPath: input.manifestPath,
    revealDescriptorPath: input.revealDescriptorPath,
    privateRoot: input.datasetPrivateRoot,
    containingWorkspace: input.containingWorkspace,
    mode: "development_scored"
  });
  if (
    scoredDataset.datasetFingerprint !== identityDataset.datasetFingerprint ||
    scoredDataset.manifestSha256 !== identityDataset.manifestSha256 ||
    scoredDataset.bridgeCompletionSha256 !==
      identityDataset.bridgeCompletionSha256 ||
    scoredDataset.summary === null ||
    scoredDataset.cases.length !== identityDataset.cases.length ||
    scoredDataset.cases.some((entry, index) => {
      const identity = identityDataset.cases[index];
      return identity === undefined ||
        entry.safeId !== identity.safeId ||
        entry.subjectId !== identity.subjectId ||
        entry.sourceLineageSha256 !== identity.sourceLineageSha256 ||
        entry.contentSha256 !== identity.contentSha256;
    })
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_DEVELOPMENT_DATASET_CHANGED");
  }
  if (privateSelectorBinding !== null) {
    return selectReviewFlowEvaluationPrivateSubset({
      dataset: scoredDataset,
      binding: privateSelectorBinding
    });
  }
  if (input.caseSelector === "representative3-v1") {
    return selectReviewFlowEvaluationRepresentative3(scoredDataset);
  }
  if (input.caseSelector === "representative3-v2") {
    return selectReviewFlowEvaluationRepresentative3V2(scoredDataset);
  }
  if (input.caseSelector === "representative3-v3") {
    return selectReviewFlowEvaluationRepresentative3V3(scoredDataset);
  }
  return scoredDataset;
}

async function runPredictionOrDevelopment(input: {
  readonly options: ReviewFlowEvaluationRunCliOptions;
  readonly env: NodeJS.ProcessEnv;
  readonly codeIdentity: EvaluationCodeIdentity;
  readonly runtimeAttestation: ReviewFlowRuntimeAttestation;
  readonly now?: () => Date;
}): Promise<void> {
  const options = input.options;
  const concurrency = parseBoundedPositiveInteger(
    input.env.EVAL_CONCURRENCY,
    16,
    20,
    "EVAL_CONCURRENCY"
  );
  // CLI 永远使用固定的项目私有全局 registry；没有可覆盖目录的命令行或 API
  // 参数。测试若需临时根目录，只能直接测试 registry 类本身。
  const registry = new ReviewFlowEvaluationGlobalRegistry({
    privateRoot: input.runtimeAttestation.originPrivateRoot,
    containingWorkspace: input.runtimeAttestation.originWorkspaceRoot,
    now: input.now
  });
  let checkpoint: ReviewFlowEvaluationCheckpoint | undefined;
  let removeSignalHandlers: (() => void) | undefined;
  let streamCheckpoint: ReviewFlowSafeStreamCheckpoint | undefined;
  let terminalReceiptWritten = false;
  try {
    const dataset = options.purpose === "development"
      ? loadDevelopmentDatasetAfterUsageRegistration({
          manifestPath: options.manifestPath,
          revealDescriptorPath: options.revealDescriptorPath!,
          datasetPrivateRoot: options.datasetPrivateRoot,
          containingWorkspace: input.runtimeAttestation.originWorkspaceRoot,
          registry,
          caseSelector: options.caseSelector,
          caseSelectorFilePath: options.caseSelectorFilePath
        })
      : loadReviewFlowEvaluationDataset({
          manifestPath: options.manifestPath,
          privateRoot: options.datasetPrivateRoot,
          containingWorkspace: input.runtimeAttestation.originWorkspaceRoot,
          mode: "holdout_prediction"
        });
    const holdout = options.purpose === "holdout"
      ? requireHoldoutDatasetBindings(dataset)
      : null;
    assertPreregisteredRunLabels(options, dataset);
    const failedOnlySource = options.failedOnlySourcePath === null
      ? undefined
      : loadReviewFlowEvaluationCheckpointStateFromPath({
          checkpointPath: options.failedOnlySourcePath,
          privateRoot: input.runtimeAttestation.originPrivateRoot,
          containingWorkspace: input.runtimeAttestation.originWorkspaceRoot
        });
    const holdoutPlan = options.purpose === "holdout"
      ? registry.registerHoldoutPlan(dataset).plan
      : null;
    const holdoutSelection = holdoutPlan === null
      ? null
      : registry.nominateHoldoutSelection({
          plan: holdoutPlan,
          developmentBaselineLabel: options.developmentBaselineLabel!,
          developmentCandidateLabel: options.developmentCandidateLabel!
        });
    const config = loadReviewFlowEvaluationConfig({
      env: input.env,
      maxEventShapeRetries: options.maxEventShapeRetries ?? undefined
    });
    const difficultyAnchors = loadDifficultyAnchorsStrict(anchorsFile);
    streamCheckpoint = openReviewFlowSafeStreamCheckpoint({
      enabled: options.streamCheckpoints,
      privateDirectory: options.privateDirectory,
      privateRoot: input.runtimeAttestation.originPrivateRoot,
      containingWorkspace: input.runtimeAttestation.originWorkspaceRoot
    });
    const adapter = createReviewFlowEvaluationAdapter({
      config,
      codeIdentity: input.codeIdentity,
      runtimeIdentity: input.runtimeAttestation.runtimeIdentity,
      difficultyAnchors,
      datasetFingerprint: dataset.datasetFingerprint,
      manifestSha256: dataset.manifestSha256,
      anklangInputPolicy: dataset.anklangInputPolicy,
      placeholderTagIds: dataset.placeholderTagIds,
      purpose: dataset.purpose,
      concurrency,
      maxCaseAttempts: options.maxCaseAttempts,
      proxyEnvironment: input.env,
      safeStreamTelemetry:
        streamCheckpoint === undefined
          ? undefined
          : (event) => {
              streamCheckpoint!.append(event);
            }
    });
    const caseSelection = dataset.caseSelection;
    const checkpointIdentity = caseSelection === undefined
      ? adapter.identity
      : { ...adapter.identity, caseSelection };
    // 全量 taskSource 预检发生在 checkpoint/claim 与任何模型调用之前。
    const preparedCases = dataset.cases.map((evaluationCase) => ({
      safeId: evaluationCase.safeId,
      prepared: adapter.prepare({
        safeId: evaluationCase.safeId,
        task: evaluationCase.task
      })
    }));
    const baselineBinding =
      options.variant === "candidate" && options.purpose === "development"
        ? assertUsableReviewFlowEvaluationBaseline(
            options.baselineLabel!,
            dataset.datasetFingerprint,
            registry
          )
        : null;
    if (holdout !== null && options.variant === "candidate") {
      // 候选链建立 checkpoint 前就必须确认完整基线 phase，避免误占候选槽。
      registry.readPredictionCompletion(holdout.identity, "baseline");
    }
    checkpoint = new ReviewFlowEvaluationCheckpoint({
      privateDirectory: options.privateDirectory,
      label: options.label,
      variant: options.variant,
      baselineLabel: options.baselineLabel,
      baselineBinding,
      identity: checkpointIdentity,
      holdoutIdentity:
        holdout?.identity ?? null,
      thresholdPolicySha256:
        holdout?.registration.thresholdPolicySha256 ?? null,
      expectedCases: dataset.cases.map((evaluationCase) => ({
        safeId: evaluationCase.safeId,
        subjectId: evaluationCase.subjectId,
        sourceLineageSha256: evaluationCase.sourceLineageSha256,
        contentSha256: evaluationCase.contentSha256
      })),
      failedOnlySource,
      failedOnlyCaseIds: options.failedOnlyCaseIds ?? undefined,
      resume: options.resume,
      privateRoot: input.runtimeAttestation.originPrivateRoot,
      containingWorkspace: input.runtimeAttestation.originWorkspaceRoot,
      now: input.now
    });
    if (options.failedOnly && options.resume) {
      checkpoint.prepareFailedOnlySelection(
        options.failedOnlyCaseIds ?? undefined
      );
    }
    const genesis = checkpoint.genesisBinding();
    const labelClaim = registry.claimLabel({
      genesis,
      datasetFingerprint: dataset.datasetFingerprint,
      holdoutIdentity:
        holdout?.identity ?? null,
      thresholdPolicySha256:
        holdout?.registration.thresholdPolicySha256 ?? null,
      ...(caseSelection === undefined ? {} : { caseSelection }),
      resume: options.resume
    });
    checkpoint.bindGlobalClaim(labelClaim.sha256);
    registry.assertLabelClaim({
      genesis,
      datasetFingerprint: dataset.datasetFingerprint,
      holdoutIdentity:
        holdout?.identity ?? null,
      thresholdPolicySha256:
        holdout?.registration.thresholdPolicySha256 ?? null,
      ...(caseSelection === undefined ? {} : { caseSelection }),
      expectedSha256: labelClaim.sha256
    });
    const holdoutSlot = holdoutPlan === null
      ? null
      : registry.claimHoldoutSlot({
          plan: holdoutPlan,
          genesis,
          labelClaimSha256: labelClaim.sha256,
          selectionClaimSha256: holdoutSelection!.sha256,
          resume: options.resume
        });

    const gate = new ReviewFlowEvaluationStartGate(checkpoint);
    removeSignalHandlers = installReviewFlowEvaluationSignalHandlers({ gate });
    const state = await runReviewFlowEvaluationCases({
      checkpoint,
      cases: preparedCases,
      executor: adapter,
      concurrency,
      startGate: gate,
      maxCaseAttempts: options.maxCaseAttempts,
      failedOnly: options.failedOnly
    });
    if (options.failedOnly && state.executionSeal === null) {
      removeSignalHandlers();
      removeSignalHandlers = undefined;
      process.stdout.write(
        `failed-only continuation checkpoint persisted: ${options.label}\n`
      );
      return;
    }
    checkpoint.writeTerminalReceipt();
    terminalReceiptWritten = true;
    removeSignalHandlers();
    removeSignalHandlers = undefined;

    if (options.purpose === "development") {
      const report = buildReviewFlowEvaluationReport({ dataset, checkpoint: state });
      const publication = registry.publishScoredReport({
        state,
        summaryJson: report.json,
        markdown: report.markdown
      });
      checkpoint.acknowledgePublication({
        kind: "scored_report",
        artifactSetSha256: publication.markerSha256,
        registryReceiptSha256: publication.receiptSha256,
        complete: report.summary.complete
      });
      process.stdout.write(
        `11 角色 development 实验已私有封存：标签 ${options.label}，完成 ${report.summary.caseCounts.completed}/${report.summary.caseCounts.expected}，完整=${report.summary.complete ? "是" : "否"}，可用资格=否。\n`
      );
      if (!report.summary.complete) {
        // 不完整链永久封存不等于成功：账本缺失/失败/未启动都必须让 CLI 以非零退出。
        process.exitCode = 1;
      }
    } else if (state.executionSeal?.complete === true && holdoutSlot !== null) {
      const completion = registry.completeHoldoutPrediction({
        state,
        slotClaimSha256: holdoutSlot.sha256
      });
      checkpoint.acknowledgePublication({
        kind: "holdout_prediction",
        artifactSetSha256: completion.completion.projectionSetSha256,
        registryReceiptSha256: completion.sha256,
        complete: true
      });
      process.stdout.write(
        `11 角色 holdout 预测链已私有封存：标签 ${options.label}，完成 ${state.entries.length}/${state.entries.length}；尚未读取 Gold、尚未计分、可用资格=否。\n`
      );
    } else {
      process.stdout.write(
        `11 角色 holdout 预测链不完整并已永久封存：标签 ${options.label}；未读取 Gold、不可 reveal、可用资格=否。\n`
      );
      // 不完整 holdout 链同样必须以非零退出，避免 CLI"干净成功"掩盖不完整
      // （与 development 分支一致，fail-closed 退出契约）。
      process.exitCode = 1;
    }
    if (state.termination !== null) {
      throw new Error("REVIEW_FLOW_EVALUATION_TERMINATED_AFTER_SEAL");
    }
  } finally {
    removeSignalHandlers?.();
    let terminalReceiptFailure: unknown;
    if (checkpoint !== undefined && !terminalReceiptWritten) {
      try {
        checkpoint.sealExecution();
        checkpoint.writeTerminalReceipt();
        terminalReceiptWritten = true;
      } catch (error) {
        terminalReceiptFailure = error;
      }
    }
    if (checkpoint === undefined || terminalReceiptWritten) {
      checkpoint?.close();
    }
    streamCheckpoint?.close();
    registry.close();
    if (terminalReceiptFailure !== undefined) {
      throw terminalReceiptFailure;
    }
  }
}

async function runReveal(input: {
  readonly options: ReviewFlowEvaluationRevealCliOptions;
  readonly codeIdentity: EvaluationCodeIdentity;
  readonly runtimeAttestation: ReviewFlowRuntimeAttestation;
}): Promise<void> {
  // 第一遍只读 manifest/tag/content；Gold 文件不会被 open。
  const blindDataset = loadReviewFlowEvaluationDataset({
    manifestPath: input.options.manifestPath,
    privateRoot: input.options.datasetPrivateRoot,
    containingWorkspace: input.runtimeAttestation.originWorkspaceRoot,
    mode: "holdout_prediction"
  });
  const blindHoldout = requireHoldoutDatasetBindings(blindDataset);
  const registry = new ReviewFlowEvaluationGlobalRegistry({
    privateRoot: input.runtimeAttestation.originPrivateRoot,
    containingWorkspace: input.runtimeAttestation.originWorkspaceRoot
  });
  try {
    registry.registerHoldoutPlan(blindDataset);
    const baselineSnapshot = loadReviewFlowEvaluationCheckpointForReveal({
      privateDirectory: input.options.baselinePrivateDirectory,
      label: blindHoldout.registration.baselineLabel,
      privateRoot: input.runtimeAttestation.originPrivateRoot,
      containingWorkspace: input.runtimeAttestation.originWorkspaceRoot
    });
    const candidateSnapshot = loadReviewFlowEvaluationCheckpointForReveal({
      privateDirectory: input.options.candidatePrivateDirectory,
      label: blindHoldout.registration.candidateLabel,
      privateRoot: input.runtimeAttestation.originPrivateRoot,
      containingWorkspace: input.runtimeAttestation.originWorkspaceRoot
    });
    // claimReveal 会先严格验证两条完整 phase/slot/label claim，并以 O_EXCL
    // 永久占用揭盲权；至此之前仍未读取 Gold。
    const revealClaim = registry.claimReveal({
      dataset: blindDataset,
      baselineSnapshot,
      candidateSnapshot,
      scoringCodeIdentity: input.codeIdentity,
      resume: input.options.resume
    });

    // 唯一打开 holdout Gold 的位置；一次构建同一数据快照下的前后两份报告。
    const revealedDataset = loadReviewFlowEvaluationDataset({
      manifestPath: input.options.manifestPath,
      revealDescriptorPath: input.options.revealDescriptorPath,
      privateRoot: input.options.datasetPrivateRoot,
      containingWorkspace: input.runtimeAttestation.originWorkspaceRoot,
      mode: "holdout_reveal"
    });
    const revealedHoldout = requireHoldoutDatasetBindings(revealedDataset);
    if (
      revealedDataset.datasetFingerprint !== blindDataset.datasetFingerprint ||
      revealedHoldout.identity !== blindHoldout.identity
    ) {
      throw new Error("REVIEW_FLOW_EVALUATION_REVEAL_DATASET_CHANGED");
    }
    const baselineReport = buildReviewFlowEvaluationReport({
      dataset: revealedDataset,
      checkpoint: baselineSnapshot.state
    });
    const candidateReport = buildReviewFlowEvaluationReport({
      dataset: revealedDataset,
      checkpoint: candidateSnapshot.state
    });
    const baselinePublication = registry.publishScoredReport({
      state: baselineSnapshot.state,
      summaryJson: baselineReport.json,
      markdown: baselineReport.markdown
    });
    const candidatePublication = registry.publishScoredReport({
      state: candidateSnapshot.state,
      summaryJson: candidateReport.json,
      markdown: candidateReport.markdown
    });
    const comparison = buildReviewFlowEvaluationComparison({
      holdoutIdentity: revealedHoldout.identity,
      thresholdPolicySha256: revealedHoldout.registration.thresholdPolicySha256,
      baseline: baselineReport.summary,
      candidate: candidateReport.summary,
      baselineReportSha256: baselineReport.sha256,
      candidateReportSha256: candidateReport.sha256
    });
    registry.publishHoldoutComparison({
      dataset: revealedDataset,
      revealClaimSha256: revealClaim.sha256,
      baselineReportSetSha256: baselinePublication.markerSha256,
      candidateReportSetSha256: candidatePublication.markerSha256,
      comparisonJson: comparison.json
    });
    process.stdout.write(
      `holdout 已一次性揭盲并私有封存基线、候选和对比报告：${baselineReport.summary.caseCounts.expected} 个样本，报告完整=是，可用资格=否。\n`
    );
  } finally {
    registry.close();
  }
}

export function assertUsableReviewFlowEvaluationBaseline(
  label: string,
  expectedDatasetFingerprint: string,
  existingRegistry?: ReviewFlowEvaluationGlobalRegistry
): ReviewFlowEvaluationBaselineBinding {
  const registry = existingRegistry ?? new ReviewFlowEvaluationGlobalRegistry();
  try {
    const published = registry.loadPublishedReport(label);
    return baselineBindingFromPublishedReport(
      label,
      expectedDatasetFingerprint,
      published
    );
  } finally {
    if (existingRegistry === undefined) registry.close();
  }
}

function baselineBindingFromPublishedReport(
  label: string,
  expectedDatasetFingerprint: string,
  published: ReviewFlowEvaluationPublishedReport
): ReviewFlowEvaluationBaselineBinding {
  try {
    const summary = parseReviewFlowEvaluationReportSummary(
      published.summaryBytes
    );
    if (
      summary.label !== label ||
      summary.variant !== "baseline" ||
      summary.baselineLabel !== null ||
      summary.baselineBinding !== null ||
      summary.complete !== true ||
      summary.scoring.valid !== true ||
      summary.dataset.purpose !== "development" ||
      summary.dataset.fingerprint !== expectedDatasetFingerprint ||
      summary.runId !== published.marker.runId ||
      summary.runId !== published.receipt.runId ||
      summary.runId !== published.labelClaim.runId ||
      published.marker.complete !== summary.complete ||
      published.receipt.complete !== summary.complete ||
      summary.caseCounts.completed !== summary.caseCounts.expected ||
      summary.receiptCoverage.completeElevenRoleReceiptCaseCount !==
        summary.caseCounts.expected ||
      published.marker.executionCompletionFingerprint !==
        summary.executionCompletionFingerprint ||
      published.receipt.executionCompletionFingerprint !==
        summary.executionCompletionFingerprint ||
      published.labelClaim.variant !== "baseline" ||
      published.labelClaim.purpose !== "development" ||
      published.labelClaim.datasetFingerprint !== expectedDatasetFingerprint ||
      published.labelClaim.identityFingerprint !==
        hashCanonicalValue(summary.executionIdentity)
    ) {
      throw new Error("invalid");
    }
    return reviewFlowEvaluationBaselineBindingSchema.parse({
      schemaVersion: 2,
      label,
      runId: summary.runId,
      datasetFingerprint: expectedDatasetFingerprint,
      summarySha256: sha256(published.summaryBytes),
      markdownSha256: sha256(published.markdownBytes),
      reportSetSha256: sha256(published.markerBytes),
      labelClaimSha256: sha256(published.labelClaimBytes),
      publicationReceiptSha256: sha256(published.receiptBytes),
      executionCompletionFingerprint: summary.executionCompletionFingerprint,
      codeVersion: summary.executionIdentity.codeIdentity.codeVersion,
      configurationFingerprint:
        summary.executionIdentity.configurationFingerprint,
      runnerIdentity: summary.executionIdentity.runnerIdentity
    });
  } catch {
    throw new Error("REVIEW_FLOW_EVALUATION_BASELINE_INVALID");
  }
}

function assertPreregisteredRunLabels(
  options: ReviewFlowEvaluationRunCliOptions,
  dataset: ReturnType<typeof loadReviewFlowEvaluationDataset>
): void {
  if (options.purpose !== "holdout") return;
  const registration = requireHoldoutDatasetBindings(dataset).registration;
  if (
    (options.variant === "baseline" &&
      (options.label !== registration.baselineLabel ||
        options.baselineLabel !== null)) ||
    (options.variant === "candidate" &&
      (options.label !== registration.candidateLabel ||
        options.baselineLabel !== registration.baselineLabel))
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_HOLDOUT_LABEL_NOT_PREREGISTERED");
  }
}

function requireHoldoutDatasetBindings(
  dataset: ReturnType<typeof loadReviewFlowEvaluationDataset>
): {
  readonly identity: string;
  readonly registration: NonNullable<
    ReturnType<typeof loadReviewFlowEvaluationDataset>["holdoutRegistration"]
  >;
} {
  if (
    dataset.purpose !== "holdout" ||
    dataset.holdoutIdentity === null ||
    dataset.holdoutRegistration === null
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_HOLDOUT_DATASET_INVALID");
  }
  return {
    identity: dataset.holdoutIdentity,
    registration: dataset.holdoutRegistration
  };
}

function assertDirectScoringOptions(
  options: ReviewFlowEvaluationCliOptions
): asserts options is ReviewFlowEvaluationRunCliOptions {
  const failedOnlyContinuation =
    options.action === "run" &&
    options.failedOnly &&
    options.failedOnlySourcePath !== null &&
    options.caseSelector === null &&
    options.caseSelectorFilePath === null;
  const freshPrivateSelection =
    options.action === "run" &&
    !options.failedOnly &&
    options.failedOnlySourcePath === null &&
    options.failedOnlyCaseIds === null &&
    options.caseSelector === null &&
    options.caseSelectorFilePath !== null;
  if (
    options.action !== "run" ||
    options.resume ||
    failedOnlyContinuation === freshPrivateSelection
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_DIRECT_SCORING_SCOPE_INVALID");
  }
}

function assertDirectScoringEnvironment(env: NodeJS.ProcessEnv): void {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (!Number.isSafeInteger(major) || major < 24) {
    throw new Error("REVIEW_FLOW_EVALUATION_NODE_VERSION_UNSUPPORTED");
  }
  assertSafeNodeEnvironment(env);
  assertNoUnknownPrefixedEnvironmentKeys(
    env,
    allowedReviewFlowEvaluationRunEnvironmentKeys,
    protectedEvaluationEnvironmentPrefixes
  );
  assertNarrowReviewFlowEvaluationEnvironment(env);
}

function createDirectScoringRuntimeAttestation(
  options: ReviewFlowEvaluationCliOptions,
  codeVersion: string
): ReviewFlowRuntimeAttestation {
  assertDirectScoringOptions(options);
  const originWorkspaceRoot = resolve(repositoryDirectory, "..");
  const originPrivateRoot = resolve(repositoryDirectory, "private");
  const source = options.failedOnlySourcePath === null
    ? null
    : loadReviewFlowEvaluationCheckpointStateFromPath({
        checkpointPath: options.failedOnlySourcePath,
        privateRoot: originPrivateRoot,
        containingWorkspace: originWorkspaceRoot
      });
  const manifest = JSON.parse(
    readFileSync(
      resolve(repositoryDirectory, "config/review-flow-runtime.json"),
      "utf8"
    )
  ) as {
    readonly runnerPath?: unknown;
    readonly codePaths?: unknown;
    readonly productionCodePaths?: unknown;
    readonly runtime?: unknown;
  };
  if (
    manifest.runnerPath !== "experiments/eval-review-flow.ts" ||
    !Array.isArray(manifest.codePaths) ||
    !Array.isArray(manifest.productionCodePaths) ||
    manifest.codePaths.length === 0 ||
    manifest.productionCodePaths.length === 0 ||
    manifest.codePaths.some((path) => typeof path !== "string") ||
    manifest.productionCodePaths.some((path) => typeof path !== "string") ||
    !manifest.codePaths.includes(manifest.runnerPath)
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_DIRECT_SCORING_IDENTITY_INVALID");
  }
  const codePaths = manifest.codePaths as string[];
  const productionCodePaths = manifest.productionCodePaths as string[];
  if (productionCodePaths.some((path) => !codePaths.includes(path))) {
    throw new Error("REVIEW_FLOW_EVALUATION_DIRECT_SCORING_IDENTITY_INVALID");
  }
  const files = codePaths.map((path) => ({
    path,
    bytes: readFileSync(resolve(repositoryDirectory, path))
  }));
  const runner = files.find((file) => file.path === manifest.runnerPath);
  const packageLock = files.find((file) => file.path === "package-lock.json");
  if (runner === undefined || packageLock === undefined) {
    throw new Error("REVIEW_FLOW_EVALUATION_DIRECT_SCORING_IDENTITY_INVALID");
  }
  const productionFiles = files.filter((file) =>
    productionCodePaths.includes(file.path)
  );
  const codeIdentity: EvaluationCodeIdentity = {
    codeVersion,
    runnerSha256: sha256(runner.bytes),
    dependencyCodeSha256: hashEvaluationCodeBundle(files),
    dependencyFileCount: files.length,
    productionDependencyCodeSha256:
      hashEvaluationCodeBundle(productionFiles),
    productionDependencyFileCount: productionFiles.length
  };
  const declaredRuntime = manifest.runtime as {
    readonly node: {
      readonly version: string;
      readonly platform: string;
      readonly arch: string;
      readonly sha256: string;
      readonly byteLength: number;
    };
    readonly dependencyBundleSha256: string;
    readonly dependencyFileCount: number;
    readonly dependencyByteLength: number;
    readonly packages: readonly {
      readonly name: string;
      readonly version: string;
      readonly sha256: string;
      readonly fileCount: number;
      readonly byteLength: number;
    }[];
  };
  const runtimeIdentity = source?.identity.runtime ??
    reviewFlowRuntimeIdentitySchema.parse({
      nodeVersion: declaredRuntime.node.version,
      platform: declaredRuntime.node.platform,
      arch: declaredRuntime.node.arch,
      packageLockSha256: sha256(packageLock.bytes),
      nodeExecutableSha256: declaredRuntime.node.sha256,
      nodeExecutableByteLength: declaredRuntime.node.byteLength,
      dependencyBundleSha256: declaredRuntime.dependencyBundleSha256,
      dependencyFileCount: declaredRuntime.dependencyFileCount,
      dependencyByteLength: declaredRuntime.dependencyByteLength,
      snapshotSha256: hashCanonicalValue({
        codeIdentity,
        runtime: declaredRuntime
      }),
      snapshotFileCount:
        declaredRuntime.dependencyFileCount + files.length + 1,
      packages: declaredRuntime.packages.map((package_) => ({
        name: package_.name,
        version: package_.version,
        sha256: package_.sha256,
        fileCount: package_.fileCount,
        byteLength: package_.byteLength
      })),
      trustModel:
        "trusted_bootstrap_same_uid_non_adversarial_trusted_host_system_runtime_unbound_v1"
    });
  return Object.freeze({
    codeIdentity: Object.freeze(codeIdentity),
    runtimeIdentity: Object.freeze(runtimeIdentity),
    originRepositoryRoot: repositoryDirectory,
    originWorkspaceRoot,
    originPrivateRoot
  });
}

function assertReviewFlowEvaluationRuntime(env: NodeJS.ProcessEnv): void {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (!Number.isSafeInteger(major) || major < 24) {
    throw new Error("REVIEW_FLOW_EVALUATION_NODE_VERSION_UNSUPPORTED");
  }
  // 包装器标记只是启动约定；真正安全边界是下面三组独立检查。
  if (env.FERMATA_RUN_WITH_ENV !== "1") {
    throw new Error("REVIEW_FLOW_EVALUATION_SAFE_LAUNCH_REQUIRED");
  }
  assertSafeNodeEnvironment(env);
  assertNoUnknownPrefixedEnvironmentKeys(
    env,
    allowedReviewFlowEvaluationRunEnvironmentKeys,
    protectedEvaluationEnvironmentPrefixes
  );
  assertNarrowReviewFlowEvaluationEnvironment(env);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const directScoringStartupErrorClasses: Readonly<Record<string, string>> = {
  REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID:
    "DIRECT_SCORING_ARGUMENT_INVALID",
  REVIEW_FLOW_EVALUATION_DIRECT_SCORING_SCOPE_INVALID:
    "DIRECT_SCORING_SCOPE_INVALID",
  REVIEW_FLOW_EVALUATION_DIRECT_SCORING_IDENTITY_INVALID:
    "DIRECT_SCORING_CODE_IDENTITY_INVALID",
  REVIEW_FLOW_EVALUATION_CODE_IDENTITY_INVALID:
    "DIRECT_SCORING_CODE_VERSION_INVALID",
  REVIEW_FLOW_EVALUATION_CHECKPOINT_INVALID:
    "DIRECT_SCORING_SOURCE_CHECKPOINT_INVALID",
  REVIEW_FLOW_EVALUATION_FAILED_ONLY_IDENTITY_MISMATCH:
    "DIRECT_SCORING_CONTINUATION_IDENTITY_MISMATCH",
  REVIEW_FLOW_EVALUATION_NODE_VERSION_UNSUPPORTED:
    "DIRECT_SCORING_NODE_VERSION_UNSUPPORTED",
  DANGEROUS_NODE_ENVIRONMENT:
    "DIRECT_SCORING_ENVIRONMENT_INVALID"
};

export function classifyDirectScoringStartupError(error: unknown): string {
  return error instanceof Error
    ? directScoringStartupErrorClasses[error.message] ??
      "DIRECT_SCORING_PRECHECK_FAILED"
    : "DIRECT_SCORING_PRECHECK_FAILED";
}

function isDirectEntry(): boolean {
  return process.argv[1] !== undefined &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectEntry()) {
  const argv = process.argv.slice(2);
  const directScoring = argv.includes("--direct-scoring");
  runReviewFlowEvaluationCli({
    argv,
    env: process.env
  }).catch((error: unknown) => {
    if (directScoring) {
      process.stderr.write(`${classifyDirectScoringStartupError(error)}\n`);
    } else {
      // 默认入口继续折叠所有内部错误、私有路径和 provider 细节。
      process.stderr.write("11 角色审题实验未能安全完成。\n");
    }
    process.exitCode = 1;
  });
}
