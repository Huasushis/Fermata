import { describe, expect, it } from "vitest";
import {
  assessDifficultyEvaluationEligibility,
  difficultyEvaluationConfigurationFingerprint,
  difficultyProviderIdentityFingerprint
} from "../experiments/lib/difficulty-evaluation-eligibility";

describe("public83 难度评测资格", () => {
  it("完整且同时达到 MAE 与命中率门槛时才 eligible", () => {
    expect(
      assessDifficultyEvaluationEligibility({
        integrityComplete: true,
        expected: 83,
        summaryCount: 83,
        meanAbsoluteError: 200,
        hitRateWithin200: 0.75,
        manifestVerified: true,
        anchorsProvisional: false
      })
    ).toEqual({
      executionComplete: true,
      accuracyPassed: true,
      anchorsEligible: true,
      eligible: true
    });
  });

  it.each([
    { integrityComplete: false, expected: 83, summaryCount: 83, meanAbsoluteError: 100, hitRateWithin200: 1 },
    { integrityComplete: true, expected: 83, summaryCount: 82, meanAbsoluteError: 100, hitRateWithin200: 1 },
    { integrityComplete: true, expected: 83, summaryCount: 83, meanAbsoluteError: 201, hitRateWithin200: 1 },
    { integrityComplete: true, expected: 83, summaryCount: 83, meanAbsoluteError: 100, hitRateWithin200: 0.74 }
  ])("不完整、缺样本或任一准确性门槛失败时不可用：%o", (input) => {
    const result = assessDifficultyEvaluationEligibility({
      ...input,
      manifestVerified: true,
      anchorsProvisional: false
    });
    expect(result.accuracyPassed).toBe(false);
    expect(result.eligible).toBe(false);
  });

  it("manifest 未验证时即使执行与准确性都通过也不可用", () => {
    expect(
      assessDifficultyEvaluationEligibility({
        integrityComplete: true,
        expected: 83,
        summaryCount: 83,
        meanAbsoluteError: 100,
        hitRateWithin200: 0.9,
        manifestVerified: false,
        anchorsProvisional: false
      })
    ).toEqual({
      executionComplete: true,
      accuracyPassed: true,
      anchorsEligible: true,
      eligible: false
    });
  });

  it("provisional 锚点可保留准确性指标判断，但永远不能 eligible", () => {
    expect(assessDifficultyEvaluationEligibility({
      integrityComplete: true,
      expected: 83,
      summaryCount: 83,
      meanAbsoluteError: 100,
      hitRateWithin200: 0.9,
      manifestVerified: true,
      anchorsProvisional: true
    })).toEqual({
      executionComplete: true,
      accuracyPassed: true,
      anchorsEligible: false,
      eligible: false
    });
  });

  it.each([82, 84])("样本数为 %i 时即使指标达标也不能 accuracyPassed", (sampleCount) => {
    expect(assessDifficultyEvaluationEligibility({
      integrityComplete: true,
      expected: sampleCount,
      summaryCount: sampleCount,
      meanAbsoluteError: 100,
      hitRateWithin200: 0.9,
      manifestVerified: true,
      anchorsProvisional: false
    })).toEqual({
      executionComplete: false,
      accuracyPassed: false,
      anchorsEligible: true,
      eligible: false
    });
  });
});

describe("public83 provider 身份指纹", () => {
  it("绑定 provider、网关和密钥，但产物不含原值", () => {
    const credentials = { baseUrl: "https://private-gateway.invalid/v1", apiKey: "private-key" };
    const fingerprint = difficultyProviderIdentityFingerprint("aether", credentials);

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify({ providerIdentityFingerprint: fingerprint })).not.toContain(credentials.baseUrl);
    expect(JSON.stringify({ providerIdentityFingerprint: fingerprint })).not.toContain(credentials.apiKey);
    expect(difficultyProviderIdentityFingerprint("aether", { ...credentials, apiKey: "another-key" })).not.toBe(
      fingerprint
    );
    expect(
      difficultyProviderIdentityFingerprint("aether", {
        ...credentials,
        baseUrl: "https://another-gateway.invalid/v1"
      })
    ).not.toBe(fingerprint);

    const codeVersion = "a".repeat(40);
    const configuration = {
      modelsConfigSha256: "1".repeat(64),
      runnerSha256: "2".repeat(64),
      dependencyCodeSha256: "3".repeat(64),
      dependencyFileCount: 18,
      experimentVersion: "test",
      model: { name: "flash" }
    };
    const configurationFingerprint = difficultyEvaluationConfigurationFingerprint(
      codeVersion,
      configuration,
      fingerprint
    );
    expect(configurationFingerprint).not.toBe(
      difficultyEvaluationConfigurationFingerprint(
        codeVersion,
        configuration,
        difficultyProviderIdentityFingerprint("aether", { ...credentials, apiKey: "another-key" })
      )
    );
    expect(configurationFingerprint).not.toBe(
      difficultyEvaluationConfigurationFingerprint(
        codeVersion,
        { ...configuration, modelsConfigSha256: "4".repeat(64) },
        fingerprint
      )
    );
    expect(configurationFingerprint).not.toBe(
      difficultyEvaluationConfigurationFingerprint(
        codeVersion,
        { ...configuration, runnerSha256: "5".repeat(64) },
        fingerprint
      )
    );
    expect(configurationFingerprint).not.toBe(
      difficultyEvaluationConfigurationFingerprint(
        codeVersion,
        { ...configuration, dependencyCodeSha256: "6".repeat(64) },
        fingerprint
      )
    );
    expect(configurationFingerprint).not.toBe(
      difficultyEvaluationConfigurationFingerprint(
        codeVersion,
        { ...configuration, dependencyFileCount: 19 },
        fingerprint
      )
    );
  });
});
