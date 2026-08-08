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

export const historicalInputPreparationCodePaths: readonly string[] =
  Object.freeze([
    ...reviewFlowEvaluationCodePaths,
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