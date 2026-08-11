/**
 * 离线实验与正式 11 角色实现之间的唯一 adapter。
 *
 * 这里故意不走 source+roles+identities 的宽松测试入口：每个 content 必须先经
 * 历史结果排除策略专用 builder 得到进程内 branded taskSource，runner 必须由
 * createReviewFlowLlmBundle(productionGrant:null) 创建，最后只读取编排器提供的
 * calibration projection。测试在更外层注入假 executor，不会伪造此 adapter。
 */
import runtimeManifestDocument from "../../config/review-flow-runtime.json" with { type: "json" };
import type { ModelSpec } from "../../src/config";
import type { LlmRequestStartGate } from "../../src/llm";
import type { PipelineModelConfig } from "../../src/pipelines/types";
import {
  runReviewEvidenceFlowCalibrationOutcome,
  type ReviewFlowCalibrationProjection
} from "../../src/review-flow/orchestrator";
import {
  createReviewFlowLlmBundle,
  type ReviewFlowModelConfigs
} from "../../src/review-flow/llm-roles";
import {
  buildHistoricalCalibrationReviewFlowTaskSource,
  type ReviewFlowTaskSourceResult
} from "../../src/review-flow/task-source";
import { reviewFlowRoleSchema } from "../../src/review-flow/schemas";
import { deepFreeze, hashCanonicalValue } from "../../src/review-flow/evidence";
import type { RobotReviewTask } from "../../src/urmotiv-schemas";
import type { StrictDifficultyAnchors } from "./difficulty-anchors-strict";
import {
  reviewFlowEvaluationPlaceholderTagIdsSchema,
  type ReviewFlowEvaluationAnklangInputPolicy,
  type ReviewFlowEvaluationPlaceholderTagIds
} from "./review-flow-evaluation-dataset";
import type { EvaluationCodeIdentity } from "./evaluation-code-identity";
import {
  getReviewFlowEvaluationProviderCredentials,
  type ReviewFlowEvaluationConfig
} from "./review-flow-evaluation-config";
import type {
  ReviewFlowEvaluationFailure,
  ReviewFlowEvaluationIdentity
} from "./review-flow-evaluation-state";
import type { ReviewFlowRuntimeIdentity } from "./review-flow-runtime-attestation";

export const reviewFlowEvaluationProxyEnvironmentKeys = [
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy"
] as const;

/**
 * 与正式 11 角色判断、提示词、传输和证据策略直接相关的较窄字节集合，仅用于
 * runner 的 engineBuildFingerprint。development -> holdout 另行绑定完整 codePaths，
 * 不允许 adapter/dataset/runner/checkpoint/report/CLI 在两个阶段间变化。
 */
export const reviewFlowProductionCodePaths: readonly string[] =
  Object.freeze([...runtimeManifestDocument.productionCodePaths]);

export interface PreparedReviewFlowEvaluationCase {
  readonly safeId: string;
  readonly taskSource: ReviewFlowTaskSourceResult;
}

export type ReviewFlowEvaluationExecutionOutcome =
  | {
      readonly status: "complete";
      readonly projection: ReviewFlowCalibrationProjection;
    }
  | {
      readonly status: "incomplete";
      readonly failure: ReviewFlowEvaluationFailure;
    };

export interface ReviewFlowEvaluationAdapter {
  readonly identity: ReviewFlowEvaluationIdentity;
  prepare(input: {
    readonly safeId: string;
    readonly task: RobotReviewTask;
  }): PreparedReviewFlowEvaluationCase;
  execute(
    prepared: PreparedReviewFlowEvaluationCase,
    runId: string,
    requestStartGate: LlmRequestStartGate
  ): Promise<ReviewFlowEvaluationExecutionOutcome>;
}

/** 构造本次实验唯一 runner；不会在本函数中发送模型请求。 */
export function createReviewFlowEvaluationAdapter(input: {
  readonly config: ReviewFlowEvaluationConfig;
  readonly codeIdentity: EvaluationCodeIdentity;
  readonly runtimeIdentity: ReviewFlowRuntimeIdentity;
  readonly difficultyAnchors: StrictDifficultyAnchors;
  readonly datasetFingerprint: string;
  readonly manifestSha256: string;
  readonly anklangInputPolicy: ReviewFlowEvaluationAnklangInputPolicy;
  readonly placeholderTagIds: ReviewFlowEvaluationPlaceholderTagIds;
  readonly purpose: "development" | "holdout";
  readonly concurrency: number;
  readonly proxyEnvironment: NodeJS.ProcessEnv;
}): ReviewFlowEvaluationAdapter {
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 4) {
    throw new Error("REVIEW_FLOW_EVALUATION_CONCURRENCY_INVALID");
  }
  const proxyEnvironmentSummary = summarizeReviewFlowEvaluationProxyEnvironment(
    input.proxyEnvironment
  );
  const placeholderTagIds = Object.freeze([
    ...reviewFlowEvaluationPlaceholderTagIdsSchema.parse(
      input.placeholderTagIds
    )
  ]);
  const models = resolveModels(input.config);
  const engineBuildFingerprint =
    input.codeIdentity.productionDependencyCodeSha256;
  const bundle = createReviewFlowLlmBundle({
    models,
    difficultyAnchors: input.difficultyAnchors.anchors,
    profileName: input.config.profileName,
    experimentVersion: input.config.models.experimentVersion,
    engineBuildFingerprint,
    productionGrant: null
  });
  if (
    bundle.transportMode !== "production_undici" ||
    bundle.accuracyEvidenceFingerprint !== null
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_RUNNER_INVALID");
  }

  const providerSummary = reviewFlowRoleSchema.options.map((role) => ({
    role,
    provider: models[role].spec.provider,
    model: models[role].spec.model
  }));
  const configurationFingerprint = hashCanonicalValue({
    protocolVersion: "review-flow-evaluation-v2",
    experimentVersion: input.config.models.experimentVersion,
    profileName: input.config.profileName,
    roleIdentities: bundle.identities,
    runnerIdentity: bundle.runnerIdentity,
    transportMode: bundle.transportMode,
    thresholds: input.config.models.thresholds,
    timeouts: input.config.models.timeouts,
    retry: input.config.models.retry,
    concurrency: input.concurrency,
    anklangInputPolicy: input.anklangInputPolicy,
    placeholderTagIds,
    proxyEnvironmentFingerprint: proxyEnvironmentSummary.fingerprint,
    proxyEnvironmentKeys: [...proxyEnvironmentSummary.keys],
    difficultyAnchorsFingerprint: input.difficultyAnchors.fingerprint,
    difficultyAnchorsProvisional: input.difficultyAnchors.provisional
  });
  const configurationSummary = {
    llmFirstOutputMs: input.config.models.timeouts.llmFirstOutputMs,
    llmOutputIdleMs: input.config.models.timeouts.llmOutputIdleMs,
    llmMaximumDurationMs: input.config.models.timeouts.llmMaximumDurationMs,
    maxAttempts: input.config.models.retry.maxAttempts,
    baseDelayMs: input.config.models.retry.baseDelayMs,
    concurrency: input.concurrency,
    proxyEnvironmentFingerprint: proxyEnvironmentSummary.fingerprint,
    proxyEnvironmentKeys: [...proxyEnvironmentSummary.keys],
    duplicateSimilarityReject:
      input.config.models.thresholds.duplicateSimilarityReject,
    difficultyAnchorsFingerprint: input.difficultyAnchors.fingerprint,
    difficultyAnchorsProvisional: input.difficultyAnchors.provisional
  };
  const identity: ReviewFlowEvaluationIdentity = deepFreeze({
    schemaVersion: 2,
    protocolVersion: "review-flow-evaluation-v2",
    datasetFingerprint: input.datasetFingerprint,
    manifestSha256: input.manifestSha256,
    purpose: input.purpose,
    codeIdentity: input.codeIdentity,
    runtime: input.runtimeIdentity,
    configurationFingerprint,
    configurationSummary,
    experimentVersion: input.config.models.experimentVersion,
    profileName: input.config.profileName,
    runnerIdentity: bundle.runnerIdentity,
    transportMode: "production_undici",
    providerSummary
  });
  const preparedCases = new WeakSet<object>();

  return Object.freeze({
    identity,
    prepare(preparationInput) {
      if (
        input.anklangInputPolicy !==
          "exclude_current_corpus_for_historical_outcome"
      ) {
        throw new Error("REVIEW_FLOW_EVALUATION_ANKLANG_INPUT_POLICY_INVALID");
      }
      if (
        preparationInput.task.problem.tagIds.length !==
          placeholderTagIds.length ||
        preparationInput.task.problem.tagIds.some(
          (tagId, index) => tagId !== placeholderTagIds[index]
        )
      ) {
        throw new Error("REVIEW_FLOW_EVALUATION_PLACEHOLDER_TAGS_MISMATCH");
      }
      const taskSource = buildHistoricalCalibrationReviewFlowTaskSource(
        preparationInput.task,
        {
          duplicateSimilarityRejectThreshold:
            input.config.models.thresholds.duplicateSimilarityReject
        }
      );
      // 历史结果策略不注入当前语料，因而不存在可在长实验中跨期的证据。
      if (taskSource.provenance.anklang.reviewItemExpiresAt !== null) {
        throw new Error("REVIEW_FLOW_EVALUATION_EXPIRING_SOURCE_FORBIDDEN");
      }
      const prepared = Object.freeze({
        safeId: preparationInput.safeId,
        taskSource
      });
      preparedCases.add(prepared);
      return prepared;
    },
    async execute(prepared, runId, requestStartGate) {
      if (!preparedCases.has(prepared)) {
        throw new Error("REVIEW_FLOW_EVALUATION_PREPARED_CASE_INVALID");
      }
      const outcome = await runReviewEvidenceFlowCalibrationOutcome({
        taskSource: prepared.taskSource,
        trustedRunner: bundle,
        executionContext: {
          schemaVersion: 1,
          runId,
          assignmentId: prepared.taskSource.taskBinding.assignmentId,
          expectedRound: prepared.taskSource.taskBinding.expectedRound
        },
        requestStartGate
      });
      if (outcome.status === "complete") {
        return { status: "complete" as const, projection: outcome.projection };
      }
      requestStartGate.close();
      return {
        status: "incomplete" as const,
        failure: normalizeIncompleteFailure(outcome.failure)
      };
    }
  } satisfies ReviewFlowEvaluationAdapter);
}

function resolveModels(
  config: ReviewFlowEvaluationConfig
): ReviewFlowModelConfigs {
  const specs = config.profile.reviewFlow;
  return {
    solver: modelConfig(config, specs.solver),
    solution_analyst: modelConfig(config, specs.solutionAnalyst),
    technical_auditor: modelConfig(config, specs.technicalAuditor),
    difficulty: modelConfig(config, specs.difficulty),
    editorial_judge: modelConfig(config, specs.editorialJudge),
    contest_fit: modelConfig(config, specs.contestFit),
    originality: modelConfig(config, specs.originality),
    tags: modelConfig(config, specs.tags),
    critic: modelConfig(config, specs.critic),
    adversary: modelConfig(config, specs.adversary),
    adjudicator: modelConfig(config, specs.adjudicator)
  };
}

function modelConfig(
  config: ReviewFlowEvaluationConfig,
  spec: ModelSpec
): PipelineModelConfig {
  const credentials = getReviewFlowEvaluationProviderCredentials(
    config,
    spec.provider
  );
  if (credentials === undefined) {
    throw new Error("REVIEW_FLOW_EVALUATION_PROVIDER_MISSING");
  }
  return {
    spec,
    credentials,
    runtime: {
      firstOutputTimeoutMs: config.models.timeouts.llmFirstOutputMs,
      outputIdleTimeoutMs: config.models.timeouts.llmOutputIdleMs,
      maximumDurationMs: config.models.timeouts.llmMaximumDurationMs,
      maxAttempts: config.models.retry.maxAttempts,
      baseDelayMs: config.models.retry.baseDelayMs
    }
  };
}

export function summarizeReviewFlowEvaluationProxyEnvironment(
  environment: NodeJS.ProcessEnv
): { readonly keys: readonly (typeof reviewFlowEvaluationProxyEnvironmentKeys)[number][]; readonly fingerprint: string } {
  const entries = reviewFlowEvaluationProxyEnvironmentKeys.map((key) => ({
    key,
    value: environment[key] ?? null
  }));
  return Object.freeze({
    keys: Object.freeze(entries.flatMap((entry) => entry.value === null ? [] : [entry.key])),
    fingerprint: hashCanonicalValue({
      schemaVersion: 1,
      variables: entries
    })
  });
}

function normalizeIncompleteFailure(
  failure: Awaited<
    ReturnType<typeof runReviewEvidenceFlowCalibrationOutcome>
  > extends infer T
    ? T extends { readonly status: "incomplete"; readonly failure: infer F }
      ? F
      : never
    : never
): ReviewFlowEvaluationFailure {
  const statuses = failure.failedRoles.flatMap((role) =>
    role.httpStatus === null ? [] : [role.httpStatus]
  );
  const httpStatus = statuses.includes(499) ? 499 : (statuses[0] ?? null);
  return {
    code: httpStatus === 499 ? "REVIEW_FLOW_HTTP_499" : failure.code,
    failureKind: failure.failureKind,
    httpStatus,
    completedRoleCount: failure.completedRoles.length,
    failedRoleCount: failure.failedRoles.length,
    failedRoles: failure.failedRoles.map((role) => ({
      role: role.role,
      failureKind: role.failureKind,
      requestCount: role.requestCount,
      transportAttemptCount: role.transportAttemptCount,
      completedResponseCount: role.completedResponseCount
    }))
  };
}
