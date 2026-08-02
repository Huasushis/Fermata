import { describe, expect, it, vi } from "vitest";
import type { ModelsConfig } from "../src/config";
import type {
  ProductionEligibilityDecision,
  ProductionReviewGrant,
  ProductionReviewGrantClaims
} from "../src/production-eligibility";
import {
  createDefaultReviewerSettings,
  resolveReviewerActivation
} from "../src/reviewer-activation";
import type { FermataPublicSettings } from "../src/urmotiv-schemas";

const grantState = vi.hoisted(() => ({
  claims: new WeakMap<object, ProductionReviewGrantClaims>()
}));

vi.mock("../src/production-eligibility", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/production-eligibility")>();
  return {
    ...actual,
    inspectProductionReviewGrant: (candidate: unknown, expected: {
      readonly profileName: string;
      readonly experimentVersion: string;
    }) => {
      if (typeof candidate !== "object" || candidate === null) return null;
      const claims = grantState.claims.get(candidate);
      return claims?.profileName === expected.profileName &&
        claims.experimentVersion === expected.experimentVersion
        ? claims
        : null;
    }
  };
});

function eligibleDecision(): ProductionEligibilityDecision {
  const grant = Object.freeze({}) as ProductionReviewGrant;
  grantState.claims.set(grant, {
    profileName: "review-balanced",
    experimentVersion: "experiment-current",
    expectedRunnerIdentity: "a".repeat(64),
    engineBuildFingerprint: "b".repeat(64),
    evidenceFingerprint: "c".repeat(64)
  });
  return { eligible: true, grant };
}

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
      verdict: { provider: "aether", model: "verdict", temperature: 0.1, thinking: false },
      reviewFlow: Object.fromEntries([
        "solver", "solutionAnalyst", "technicalAuditor", "difficulty",
        "editorialJudge", "contestFit", "originality", "tags", "critic",
        "adversary", "adjudicator"
      ].map((role) => [role, {
        provider: "aether",
        model: `review-${role}`,
        temperature: 0.1,
        thinking: false
      }])) as ModelsConfig["profiles"][string]["reviewFlow"]
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
    const eligibility = eligibleDecision();
    expect(resolveReviewerActivation(enabledSettings, models, () => eligibility)).toEqual({
      active: true,
      profile: models.profiles["review-balanced"],
      productionGrant: eligibility.eligible ? eligibility.grant : undefined,
      productionClaims: {
        profileName: "review-balanced",
        experimentVersion: "experiment-current",
        expectedRunnerIdentity: "a".repeat(64),
        engineBuildFingerprint: "b".repeat(64),
        evidenceFingerprint: "c".repeat(64)
      }
    });
  });

  it("设置完全匹配但生产资格证据缺失时仍固定拒绝", () => {
    expect(resolveReviewerActivation(enabledSettings, models, () => ({
      eligible: false,
      reason: "production_evidence_verifier_unimplemented"
    }))).toEqual({ active: false, reason: "production_evidence_rejected" });
  });

  it("手写 eligible=true 和同形 grant 仍不能越过领取任务启动门", () => {
    expect(resolveReviewerActivation(enabledSettings, models, () => ({
      eligible: true,
      grant: Object.freeze({}) as ProductionReviewGrant
    }))).toEqual({ active: false, reason: "production_evidence_rejected" });
  });

  it.each([
    [{ ...enabledSettings, enabled: false }, "disabled"],
    [{ ...enabledSettings, experimentVersion: "experiment-old" }, "experiment_version_mismatch"],
    [{ ...enabledSettings, modelProfileName: "missing" }, "profile_missing"]
  ] as const)("设置不满足门槛时关闭：%s", (settings, reason) => {
    expect(resolveReviewerActivation(settings, models, eligibleDecision)).toEqual({
      active: false,
      reason
    });
  });
});
