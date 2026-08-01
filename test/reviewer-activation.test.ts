import { describe, expect, it } from "vitest";
import type { ModelsConfig } from "../src/config";
import {
  createDefaultReviewerSettings,
  resolveReviewerActivation
} from "../src/reviewer-activation";
import type { FermataPublicSettings } from "../src/urmotiv-schemas";

const models: ModelsConfig = {
  experimentVersion: "experiment-current",
  defaults: {
    modelProfileName: "review-balanced",
    pollingIntervalSeconds: 30,
    maximumConcurrentTasks: 2
  },
  profiles: {
    "review-balanced": {
      difficulty: { provider: "aether", model: "flash", temperature: 0.2, thinking: false },
      thinking: {
        solver: { provider: "aether", model: "solver", temperature: 0.4, thinking: true },
        analyst: { provider: "aether", model: "flash", temperature: 0.1, thinking: false }
      },
      coding: { provider: "aether", model: "flash", temperature: 0.3, thinking: false },
      verdict: { provider: "aether", model: "verdict", temperature: 0.1, thinking: false }
    }
  },
  retry: { maxAttempts: 1, baseDelayMs: 1 },
  timeouts: {
    llmFirstOutputMs: 1_800_000,
    llmOutputIdleMs: 600_000,
    llmMaximumDurationMs: 14_400_000,
    codeforcesRequestMs: 5_000
  },
  codeforces: { minimumRequestIntervalMs: 0 },
  thresholds: { duplicateSimilarityReject: 0.9 }
};

const enabledSettings: FermataPublicSettings = {
  enabled: true,
  pollingIntervalSeconds: 30,
  maximumConcurrentTasks: 2,
  modelProfileName: "review-balanced",
  experimentVersion: "experiment-current"
};

describe("正式领取任务启动门", () => {
  it("首次创建的公开设置固定为关闭，不能由 models.yaml 默认值自动领取", () => {
    expect(createDefaultReviewerSettings(models)).toEqual({
      ...enabledSettings,
      enabled: false
    });
  });

  it("只有明确开启、版本精确一致且档位存在时才放行", () => {
    expect(resolveReviewerActivation(enabledSettings, models, () => ({
      eligible: true,
      evidenceFingerprint: "a".repeat(64)
    }))).toEqual({
      active: true,
      profile: models.profiles["review-balanced"]
    });
  });

  it("设置完全匹配但生产资格证据缺失时仍固定拒绝", () => {
    expect(resolveReviewerActivation(enabledSettings, models, () => ({
      eligible: false,
      reason: "production_evidence_verifier_unimplemented"
    }))).toEqual({ active: false, reason: "production_evidence_rejected" });
  });

  it.each([
    [{ ...enabledSettings, enabled: false }, "disabled"],
    [{ ...enabledSettings, experimentVersion: "experiment-old" }, "experiment_version_mismatch"],
    [{ ...enabledSettings, modelProfileName: "missing" }, "profile_missing"]
  ] as const)("设置不满足门槛时关闭：%s", (settings, reason) => {
    expect(resolveReviewerActivation(settings, models, () => ({
      eligible: true,
      evidenceFingerprint: "a".repeat(64)
    }))).toEqual({ active: false, reason });
  });
});
