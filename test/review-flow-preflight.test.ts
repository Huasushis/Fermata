import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DifficultyAnchor } from "../src/pipelines/difficulty";
import type { PipelineModelConfig } from "../src/pipelines/types";
import type {
  ProductionReviewGrant,
  ProductionReviewGrantClaims
} from "../src/production-eligibility";
import {
  createReviewFlowLlmBundle,
  isProductionEligibleReviewFlowLlmBundle,
  preflightReviewFlowProductionGrant,
  type ReviewFlowModelConfigs
} from "../src/review-flow/llm-roles";
import { reviewFlowRoleSchema } from "../src/review-flow/schemas";

const grantState = vi.hoisted(() => ({
  claims: new WeakMap<object, {
    readonly profileName: string;
    readonly experimentVersion: string;
    readonly expectedRunnerIdentity: string;
    readonly engineBuildFingerprint: string;
    readonly evidenceFingerprint: string;
  }>(),
  expectations: [] as Array<{
    readonly profileName: string;
    readonly experimentVersion: string;
    readonly expectedRunnerIdentity?: string;
    readonly engineBuildFingerprint?: string;
  }>
}));

vi.mock("../src/production-eligibility", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/production-eligibility")>();
  return {
    ...actual,
    inspectProductionReviewGrant: (candidate: unknown, expected: {
      readonly profileName: string;
      readonly experimentVersion: string;
      readonly expectedRunnerIdentity?: string;
      readonly engineBuildFingerprint?: string;
    }) => {
      grantState.expectations.push({ ...expected });
      if (typeof candidate !== "object" || candidate === null) return null;
      const claims = grantState.claims.get(candidate);
      return claims?.profileName === expected.profileName &&
        claims.experimentVersion === expected.experimentVersion &&
        (expected.expectedRunnerIdentity === undefined ||
          claims.expectedRunnerIdentity === expected.expectedRunnerIdentity) &&
        (expected.engineBuildFingerprint === undefined ||
          claims.engineBuildFingerprint === expected.engineBuildFingerprint)
        ? Object.freeze({ ...claims })
        : null;
    }
  };
});

const profileName = "synthetic-profile";
const experimentVersion = "synthetic-experiment";
const currentBuild = "c".repeat(64);

function modelConfig(model = "synthetic-model"): PipelineModelConfig {
  return {
    spec: { provider: "aether", model, temperature: 0.2, thinking: true },
    credentials: {
      baseUrl: "https://llm.example.test/v1",
      apiKey: "synthetic-key"
    },
    runtime: {
      outputIdleTimeoutMs: 600_000,
      firstOutputTimeoutMs: 1_800_000,
      maximumDurationMs: 14_400_000,
      maxAttempts: 1,
      baseDelayMs: 1
    }
  };
}

function modelConfigs(): ReviewFlowModelConfigs {
  return Object.fromEntries(reviewFlowRoleSchema.options.map((role) => [
    role,
    modelConfig(`synthetic-${role}`)
  ])) as ReviewFlowModelConfigs;
}

function unqualifiedBundle(
  models: ReviewFlowModelConfigs,
  difficultyAnchors: readonly DifficultyAnchor[] = [],
  engineBuildFingerprint = currentBuild
) {
  return createReviewFlowLlmBundle({
    models,
    difficultyAnchors,
    profileName,
    experimentVersion,
    engineBuildFingerprint,
    productionGrant: null
  });
}

function registerGrant(
  claims: ProductionReviewGrantClaims
): ProductionReviewGrant {
  const grant = Object.freeze({}) as ProductionReviewGrant;
  grantState.claims.set(grant, claims);
  return grant;
}

beforeEach(() => {
  grantState.expectations.length = 0;
});

describe("生产 runner 的领取前预检", () => {
  it("与 bundle 共用 runner 身份，并把 runner 与构建摘要完整交给 opaque grant 验真", () => {
    const models = modelConfigs();
    const baseline = unqualifiedBundle(models);
    const claims: ProductionReviewGrantClaims = {
      profileName,
      experimentVersion,
      expectedRunnerIdentity: baseline.runnerIdentity,
      engineBuildFingerprint: currentBuild,
      evidenceFingerprint: "e".repeat(64)
    };
    const productionGrant = registerGrant(claims);

    expect(preflightReviewFlowProductionGrant({
      models,
      difficultyAnchors: [],
      profileName,
      experimentVersion,
      engineBuildFingerprint: currentBuild,
      productionGrant
    })).toEqual(claims);
    expect(grantState.expectations).toEqual([{
      profileName,
      experimentVersion,
      expectedRunnerIdentity: baseline.runnerIdentity,
      engineBuildFingerprint: currentBuild
    }]);

    const qualified = createReviewFlowLlmBundle({
      models,
      difficultyAnchors: [],
      profileName,
      experimentVersion,
      engineBuildFingerprint: currentBuild,
      productionGrant
    });
    expect(qualified.runnerIdentity).toBe(baseline.runnerIdentity);
    expect(qualified.accuracyEvidenceFingerprint).toBe(claims.evidenceFingerprint);
    expect(isProductionEligibleReviewFlowLlmBundle(qualified)).toBe(true);
    expect(grantState.expectations.at(-1)).toEqual({
      profileName,
      experimentVersion,
      expectedRunnerIdentity: baseline.runnerIdentity,
      engineBuildFingerprint: currentBuild
    });
  });

  it("任一模型槽、provider 凭据、anchors 或构建变化都会使旧 runner grant 失效", () => {
    const baselineModels = modelConfigs();
    const baseline = unqualifiedBundle(baselineModels);
    const productionGrant = registerGrant({
      profileName,
      experimentVersion,
      expectedRunnerIdentity: baseline.runnerIdentity,
      engineBuildFingerprint: currentBuild,
      evidenceFingerprint: "e".repeat(64)
    });
    const changedSlotModels = modelConfigs() as Record<string, PipelineModelConfig>;
    changedSlotModels.adjudicator = modelConfig("changed-adjudicator");
    const changedCredentialModels = modelConfigs() as Record<string, PipelineModelConfig>;
    changedCredentialModels.solver = {
      ...changedCredentialModels.solver!,
      credentials: {
        ...changedCredentialModels.solver!.credentials,
        apiKey: "changed-synthetic-key"
      }
    };
    const changedAnchors: readonly DifficultyAnchor[] = [{
      contestId: 1,
      index: "A",
      rating: 800,
      summary: "合成难度锚点。"
    }];

    for (const input of [
      {
        models: changedSlotModels as ReviewFlowModelConfigs,
        difficultyAnchors: [] as readonly DifficultyAnchor[],
        engineBuildFingerprint: currentBuild
      },
      {
        models: changedCredentialModels as ReviewFlowModelConfigs,
        difficultyAnchors: [] as readonly DifficultyAnchor[],
        engineBuildFingerprint: currentBuild
      },
      {
        models: baselineModels,
        difficultyAnchors: changedAnchors,
        engineBuildFingerprint: currentBuild
      },
      {
        models: baselineModels,
        difficultyAnchors: [] as readonly DifficultyAnchor[],
        engineBuildFingerprint: "d".repeat(64)
      }
    ]) {
      expect(preflightReviewFlowProductionGrant({
        ...input,
        profileName,
        experimentVersion,
        productionGrant
      })).toBeNull();
      expect(grantState.expectations.at(-1)?.expectedRunnerIdentity)
        .not.toBe(baseline.runnerIdentity);
    }
  });

  it("injected fetch 即使持有同 runner 形状的 grant 也不能取得生产资格", () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const injectedModels = Object.fromEntries(
      reviewFlowRoleSchema.options.map((role) => {
        const config = modelConfig(`synthetic-${role}`);
        return [role, {
          ...config,
          runtime: { ...config.runtime, fetch: fetchImpl }
        }];
      })
    ) as unknown as ReviewFlowModelConfigs;
    const injected = unqualifiedBundle(injectedModels);
    const productionGrant = registerGrant({
      profileName,
      experimentVersion,
      expectedRunnerIdentity: injected.runnerIdentity,
      engineBuildFingerprint: currentBuild,
      evidenceFingerprint: "e".repeat(64)
    });

    expect(preflightReviewFlowProductionGrant({
      models: injectedModels,
      difficultyAnchors: [],
      profileName,
      experimentVersion,
      engineBuildFingerprint: currentBuild,
      productionGrant
    })).toBeNull();
    expect(grantState.expectations).toHaveLength(0);
    expect(() => createReviewFlowLlmBundle({
      models: injectedModels,
      difficultyAnchors: [],
      profileName,
      experimentVersion,
      engineBuildFingerprint: currentBuild,
      productionGrant
    })).toThrow("REVIEW_FLOW_PRODUCTION_GRANT_INVALID");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
