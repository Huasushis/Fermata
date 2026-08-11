import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config";
import {
  getReviewFlowEvaluationProviderCredentials,
  loadReviewFlowEvaluationConfig
} from "../experiments/lib/review-flow-evaluation-config";

const modelsYamlSource = readFileSync(
  new URL("../config/models.yaml", import.meta.url),
  "utf8"
);

const aetherEnvironment = {
  AETHER_BASE_URL: "https://model.example/v1",
  AETHER_API_KEY: "aether-private-key"
};

describe("review-flow 评估专用配置", () => {
  it("只返回 11 角色配置和实际使用的 provider，不构造生产/CF 配置", () => {
    const config = loadReviewFlowEvaluationConfig({
      env: {
        ...aetherEnvironment,
        DASHSCOPE_BASE_URL: "https://unused.example/v1",
        DASHSCOPE_API_KEY: "unused-private-key"
      },
      modelsYamlSource
    });

    expect(config.profileName).toBe("review-balanced");
    expect(Object.keys(config.profile.reviewFlow)).toHaveLength(11);
    expect(
      getReviewFlowEvaluationProviderCredentials(config, "aether")
    ).toEqual({
      baseUrl: aetherEnvironment.AETHER_BASE_URL,
      apiKey: aetherEnvironment.AETHER_API_KEY
    });
    expect(
      getReviewFlowEvaluationProviderCredentials(config, "dashscope")
    ).toBeUndefined();
    expect(config).not.toHaveProperty("urmotiv");
    expect(config).not.toHaveProperty("server");
    expect(config).not.toHaveProperty("codeforces");
    expect(config.models.timeouts).not.toHaveProperty("codeforcesRequestMs");
    expect(config.profile).not.toHaveProperty("difficulty");
    expect(config.profile).not.toHaveProperty("thinking");
  });

  it("不要求同档位旧流水线使用、但 11 角色未使用的 provider", () => {
    const sourceWithLegacyDashscope = modelsYamlSource
      .replace(
        "    thinking:\n      solver:\n        provider: aether",
        "    thinking:\n      solver:\n        provider: dashscope"
      )
      .replace(
        "        thinkingRequest: enabled\n        reasoningEffort: max\n      analyst:",
        "      analyst:"
      );
    expect(sourceWithLegacyDashscope).not.toBe(modelsYamlSource);

    const config = loadReviewFlowEvaluationConfig({
      env: aetherEnvironment,
      modelsYamlSource: sourceWithLegacyDashscope
    });
    expect(Object.keys(config.providers)).toEqual(["aether"]);
  });

  it("11 角色实际使用的每个 provider 都必须有合法成对凭据", () => {
    const sourceWithReviewDashscope = modelsYamlSource
      .replace(
        "    reviewFlow:\n      solver:\n        provider: aether",
        "    reviewFlow:\n      solver:\n        provider: dashscope"
      )
      .replace(
        "        thinkingRequest: enabled\n        reasoningEffort: max\n      solutionAnalyst:",
        "      solutionAnalyst:"
      );
    expect(sourceWithReviewDashscope).not.toBe(modelsYamlSource);

    expect(() =>
      loadReviewFlowEvaluationConfig({
        env: aetherEnvironment,
        modelsYamlSource: sourceWithReviewDashscope
      })
    ).toThrow(ConfigError);

    const config = loadReviewFlowEvaluationConfig({
      env: {
        ...aetherEnvironment,
        DASHSCOPE_BASE_URL: "https://dashscope.example/v1",
        DASHSCOPE_API_KEY: "dashscope-private-key"
      },
      modelsYamlSource: sourceWithReviewDashscope
    });
    expect(Object.keys(config.providers).sort()).toEqual([
      "aether",
      "dashscope"
    ]);
  });

  it.each([
    ["URMOTIV_ROBOT_TOKEN", "robot-secret"],
    ["URMOTIV_BASE_URL", "https://urmotiv.example"],
    ["FERMATA_MANAGEMENT_TOKEN", "management-secret"],
    ["FERMATA_SETTINGS_PATH", "/private/settings.json"],
    ["CODEFORCES_KEY", "cf-key"],
    ["CODEFORCES_SECRET", "cf-secret"],
    ["EVAL_UNREGISTERED", "unexpected"]
  ])("拒绝无关或未登记的受保护环境变量 %s", (key, value) => {
    expect(() =>
      loadReviewFlowEvaluationConfig({
        env: { ...aetherEnvironment, [key]: value },
        modelsYamlSource
      })
    ).toThrow(ConfigError);
  });

  it("失败信息不回显凭据值", () => {
    const marker = "secret-must-not-appear";
    try {
      loadReviewFlowEvaluationConfig({
        env: {
          ...aetherEnvironment,
          URMOTIV_ROBOT_TOKEN: marker
        },
        modelsYamlSource
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(String(error)).not.toContain(marker);
    }
  });

  it("允许启动约定标记，但不把它当作凭据或配置输出", () => {
    const config = loadReviewFlowEvaluationConfig({
      env: { ...aetherEnvironment, FERMATA_RUN_WITH_ENV: "1" },
      modelsYamlSource
    });
    expect(config).not.toHaveProperty("runWithEnvMarker");
  });

  it("显式档位不存在时固定失败", () => {
    expect(() =>
      loadReviewFlowEvaluationConfig({
        env: aetherEnvironment,
        modelsYamlSource,
        profileName: "missing-profile"
      })
    ).toThrow("review-flow 实验指定的模型档位不存在");
  });
});
