import { describe, expect, it } from "vitest";
import { createDefaultReviewerSettings, resolveReviewerActivation } from "../src/reviewer-activation";
import { appConfig, settings } from "./helpers/scorer-fixture";

describe("审核启用条件", () => {
  it("首次安装关闭，管理员明确开启后无需实验资格证书", () => {
    expect(createDefaultReviewerSettings(appConfig.models).enabled).toBe(false);
    expect(resolveReviewerActivation(settings, appConfig.models)).toEqual({ active: true, profile: appConfig.models.profiles["test-profile"] });
  });
  it.each([
    [{ enabled: false }, "disabled"],
    [{ experimentVersion: "old" }, "experiment_version_mismatch"],
    [{ modelProfileName: "missing" }, "profile_missing"]
  ] as const)("设置不满足启用条件时不运行 %j", (change, reason) => {
    expect(resolveReviewerActivation({ ...settings, ...change }, appConfig.models)).toEqual({ active: false, reason });
  });
});
