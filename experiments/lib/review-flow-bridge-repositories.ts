import { z } from "zod";
import runtimeManifestDocument from "../../config/review-flow-runtime.json" with { type: "json" };

/**
 * 生成器/验证器/捕获器三个仓库的身份形状与路径清单。
 * 独立成模块，供桥完成标记（dataset）与历史输入准备完成标记（bridge）共用，
 * 避免两套 schema 定义漂移。
 */

/** 与正式 11 角色判断、提示词、传输和证据策略直接相关的代码路径清单。 */
export const reviewFlowEvaluationCodePaths: readonly string[] =
  Object.freeze([...runtimeManifestDocument.codePaths]);

export const upstreamVerifierRunnerPath =
  "scripts/migrate-hist/prepare-review-gold.py" as const;

export const upstreamVerifierDependencyPaths = [
  upstreamVerifierRunnerPath,
  "scripts/migrate-hist/parse-metadata.py"
] as const;

export const anklangCaptureRunnerPath =
  "scripts/capture-review-flow-calibration.py" as const;

export const anklangCaptureDependencyPaths = [
  anklangCaptureRunnerPath,
  "anklang/__init__.py",
  "anklang/review_flow_capture.py",
  "anklang/contracts.py"
] as const;

export const bridgeGeneratorRunnerPath =
  "experiments/prepare-review-flow-dataset.ts" as const;

/**
 * 冻结的 v1 历史输入准备基础代码路径清单（46 条），独立于可变的 runtime manifest
 * codePaths —— 新增/删除/重命名都不会静默改变 supposedly frozen v1 provenance。
 */
const sealedHistoricalInputPreparationBaseCodePaths = [
  "config/anchors/difficulty.json",
  "config/models.yaml",
  "config/review-flow-runtime.json",
  "experiments/eval-review-flow.ts",
  "experiments/prepare-review-flow-dataset.ts",
  "experiments/lib/difficulty-anchors-strict.ts",
  "experiments/lib/evaluation-code-identity.ts",
  "experiments/lib/evaluation-integrity.ts",
  "experiments/lib/physical-blind-common.ts",
  "experiments/lib/private-artifact-io.ts",
  "experiments/lib/review-flow-evaluation-adapter.ts",
  "experiments/lib/review-flow-evaluation-bridge.ts",
  "experiments/lib/review-flow-evaluation-config.ts",
  "experiments/lib/review-flow-evaluation-dataset.ts",
  "experiments/lib/review-flow-evaluation-registry.ts",
  "experiments/lib/review-flow-evaluation-report.ts",
  "experiments/lib/review-flow-evaluation-runner.ts",
  "experiments/lib/review-flow-evaluation-state.ts",
  "experiments/lib/review-flow-runtime-attestation.ts",
  "package-lock.json",
  "package.json",
  "scripts/env-file.d.mts",
  "scripts/env-file.mjs",
  "scripts/private-runtime.d.mts",
  "scripts/private-runtime.mjs",
  "scripts/review-flow-evaluation-bootstrap.mjs",
  "scripts/run-with-env.d.mts",
  "scripts/run-with-env.mjs",
  "scripts/trusted-git-state.d.mts",
  "scripts/trusted-git-state.mjs",
  "src/config.ts",
  "src/llm.ts",
  "src/logger.ts",
  "src/pipelines/difficulty.ts",
  "src/pipelines/types.ts",
  "src/production-eligibility.ts",
  "src/review-flow/evidence.ts",
  "src/review-flow/historical-rubric.ts",
  "src/review-flow/llm-roles.ts",
  "src/review-flow/orchestrator.ts",
  "src/review-flow/schemas.ts",
  "src/review-flow/task-source.ts",
  "src/review-flow/views.ts",
  "src/urmotiv-schemas.ts",
  "src/yaml-lite.ts",
  "tsconfig.json"
] as const;

export const historicalInputPreparationCodePaths: readonly string[] =
  Object.freeze([
    ...sealedHistoricalInputPreparationBaseCodePaths,
    "experiments/prepare-review-flow-historical-inputs.ts",
    "experiments/lib/review-flow-historical-input-preparer.ts"
  ]);

export const repositoryPreparationIdentitySchema = z
  .object({
    repository: z.enum(["Fermata", "Urmotiv", "Anklang"]),
    codeVersion: z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/u),
    runnerPath: z.string().min(1).max(240),
    runnerSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    dependencyCodeSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    dependencyFileCount: z.number().int().positive().max(1_000)
  })
  .strict();

export const historicalRepositoryPreparationSetSchema = z
  .object({
    fermata: repositoryPreparationIdentitySchema.extend({
      repository: z.literal("Fermata"),
      runnerPath: z.literal(
        "experiments/prepare-review-flow-historical-inputs.ts"
      ),
      dependencyFileCount: z.literal(
        historicalInputPreparationCodePaths.length
      )
    }).strict(),
    urmotiv: repositoryPreparationIdentitySchema.extend({
      repository: z.literal("Urmotiv"),
      runnerPath: z.literal(upstreamVerifierRunnerPath),
      dependencyFileCount: z.literal(
        upstreamVerifierDependencyPaths.length
      )
    }).strict(),
    anklang: repositoryPreparationIdentitySchema.extend({
      repository: z.literal("Anklang"),
      runnerPath: z.literal(anklangCaptureRunnerPath),
      dependencyFileCount: z.literal(
        anklangCaptureDependencyPaths.length
      )
    }).strict()
  })
  .strict();