import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config";
import {
  createProductionEligibilityVerifier,
  inspectProductionReviewGrant,
  productionEligibilityBlocked
} from "../src/production-eligibility";

const syntheticConfig = {
  models: {
    experimentVersion: "arbitrary-future-version",
    profiles: {}
  }
} as unknown as AppConfig;

describe("正式审题资格总门", () => {
  it("当前没有可信源证据聚合器，所有版本和 profile 都恒定 fail-closed", () => {
    const verifier = createProductionEligibilityVerifier(syntheticConfig);
    expect(verifier.verify("review-balanced")).toEqual({
      eligible: false,
      reason: "production_evidence_verifier_unimplemented"
    });
    expect(verifier.verify("任意其它档位")).toEqual({
      eligible: false,
      reason: "production_evidence_verifier_unimplemented"
    });
  });

  it("最小默认门没有 eligible=true 分支", () => {
    expect(productionEligibilityBlocked()).toEqual({
      eligible: false,
      reason: "production_evidence_verifier_unimplemented"
    });
  });

  it("裸对象、同形对象和任意摘要都不能仿造进程内生产能力", () => {
    const expected = {
      profileName: "review-balanced",
      experimentVersion: "experiment-current"
    };
    expect(inspectProductionReviewGrant({}, expected)).toBeNull();
    expect(inspectProductionReviewGrant({
      evidenceFingerprint: "a".repeat(64),
      expectedRunnerIdentity: "b".repeat(64),
      engineBuildFingerprint: "c".repeat(64)
    }, expected)).toBeNull();

    const frozenLookalike = Object.freeze({
      profileName: expected.profileName,
      experimentVersion: expected.experimentVersion,
      evidenceFingerprint: "a".repeat(64),
      expectedRunnerIdentity: "b".repeat(64),
      engineBuildFingerprint: "c".repeat(64)
    });
    expect(inspectProductionReviewGrant(frozenLookalike, expected)).toBeNull();
    expect(
      inspectProductionReviewGrant({ ...frozenLookalike }, expected)
    ).toBeNull();
  });
});
