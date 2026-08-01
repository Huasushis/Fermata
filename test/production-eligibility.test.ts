import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config";
import {
  createProductionEligibilityVerifier,
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
});
