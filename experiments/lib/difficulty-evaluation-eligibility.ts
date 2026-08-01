/**
 * public83 难度评测的可用性判定与 provider 身份绑定。
 *
 * “执行完整”“准确性达标”“可作为候选证据”是三件不同的事。任何缺失、失败、
 * 取消或 499 都必须先让 executionComplete=false，并因此永远不能 eligible。
 */
import { createHash } from "node:crypto";
import type { ProviderCredentials, ProviderName } from "../../src/config";
import { evaluationConfigurationFingerprintWithCodeVersion } from "./evaluation-integrity";

export const difficultyAccuracyThresholds = {
  maximumMeanAbsoluteError: 200,
  minimumHitRateWithin200: 0.75
} as const;

export interface DifficultyEvaluationEligibilityInput {
  readonly integrityComplete: boolean;
  readonly expected: number;
  readonly summaryCount: number;
  readonly meanAbsoluteError: number;
  readonly hitRateWithin200: number;
  readonly manifestVerified: boolean;
  readonly anchorsProvisional: boolean;
}

export interface DifficultyEvaluationEligibility {
  readonly executionComplete: boolean;
  readonly accuracyPassed: boolean;
  readonly anchorsEligible: boolean;
  readonly eligible: boolean;
}

export interface DifficultyEvaluationBoundConfiguration {
  readonly modelsConfigSha256: string;
  readonly runnerSha256: string;
  readonly dependencyCodeSha256: string;
  readonly dependencyFileCount: number;
  readonly [key: string]: unknown;
}

export function assessDifficultyEvaluationEligibility(
  input: DifficultyEvaluationEligibilityInput
): DifficultyEvaluationEligibility {
  const executionComplete =
    input.integrityComplete && input.expected === 83 && input.summaryCount === 83;
  const accuracyPassed =
    executionComplete &&
    Number.isFinite(input.meanAbsoluteError) &&
    input.meanAbsoluteError <= difficultyAccuracyThresholds.maximumMeanAbsoluteError &&
    Number.isFinite(input.hitRateWithin200) &&
    input.hitRateWithin200 >= difficultyAccuracyThresholds.minimumHitRateWithin200;
  const anchorsEligible = !input.anchorsProvisional;
  return {
    executionComplete,
    accuracyPassed,
    anchorsEligible,
    eligible:
      executionComplete &&
      accuracyPassed &&
      input.manifestVerified &&
      anchorsEligible
  };
}

/**
 * 报告只保存这个 SHA-256，不保存 baseUrl 或 apiKey。把它纳入配置指纹后，换网关
 * 或换密钥都必须形成一条新实验链，不能沿用旧报告身份。
 */
export function difficultyProviderIdentityFingerprint(
  provider: ProviderName,
  credentials: ProviderCredentials
): string {
  const identity = JSON.stringify({
    schemaVersion: 1,
    provider,
    baseUrl: credentials.baseUrl,
    apiKey: credentials.apiKey
  });
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

/** public83 的配置身份必须显式包含 provider 身份摘要，调用方不能忘记绑定。 */
export function difficultyEvaluationConfigurationFingerprint(
  codeVersion: string,
  configuration: DifficultyEvaluationBoundConfiguration,
  providerIdentityFingerprint: string
): string {
  const sha256Pattern = /^[0-9a-f]{64}$/u;
  if (
    !sha256Pattern.test(configuration.modelsConfigSha256) ||
    !sha256Pattern.test(configuration.runnerSha256) ||
    !sha256Pattern.test(configuration.dependencyCodeSha256) ||
    !Number.isSafeInteger(configuration.dependencyFileCount) ||
    configuration.dependencyFileCount <= 0 ||
    !sha256Pattern.test(providerIdentityFingerprint)
  ) {
    throw new Error("DIFFICULTY_EVALUATION_IDENTITY_INVALID");
  }
  return evaluationConfigurationFingerprintWithCodeVersion(codeVersion, {
    ...configuration,
    providerIdentityFingerprint
  });
}
