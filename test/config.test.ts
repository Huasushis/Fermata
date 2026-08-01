import { describe, expect, it } from "vitest";
import {
  ConfigError,
  getProviderCredentials,
  loadConfig,
  missingProvidersForProfile,
  providersUsedByProfile
} from "../src/config";

const validYaml = `
experimentVersion: "exp-test"
defaults:
  modelProfileName: test-profile
  pollingIntervalSeconds: 30
  maximumConcurrentTasks: 2
profiles:
  test-profile:
    difficulty:
      provider: dashscope
      model: qwen-plus
      temperature: 0.2
      thinking: false
    thinking:
      solver:
        provider: aether
        model: claude-sonnet-5
        temperature: 0.4
        thinking: true
      analyst:
        provider: aether
        model: claude-sonnet-5
        temperature: 0.1
        thinking: false
    coding:
      provider: aether
      model: claude-sonnet-5
      temperature: 0.3
      thinking: false
    verdict:
      provider: dashscope
      model: qwen-max
      temperature: 0.1
      thinking: false
retry:
  maxAttempts: 3
  baseDelayMs: 500
timeouts:
  llmFirstOutputMs: 1800000
  llmOutputIdleMs: 600000
  llmMaximumDurationMs: 14400000
  codeforcesRequestMs: 15000
codeforces:
  minimumRequestIntervalMs: 2100
thresholds:
  duplicateSimilarityReject: 0.9
`;

const validEnv = {
  URMOTIV_BASE_URL: "https://urmotiv.example.test",
  URMOTIV_ROBOT_TOKEN: "urv_test_token_1234567890",
  FERMATA_PORT: "8720",
  FERMATA_MANAGEMENT_TOKEN: "fermata-management-token-please-be-long-enough",
  FERMATA_SETTINGS_PATH: "./data/settings.json",
  AETHER_BASE_URL: "https://aether.example.test",
  AETHER_API_KEY: "aether-secret-key",
  DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  DASHSCOPE_API_KEY: "dashscope-secret-key",
  CODEFORCES_KEY: "cf-key",
  CODEFORCES_SECRET: "cf-secret"
};

describe("loadConfig：正常路径", () => {
  it("在环境变量和 YAML 都合法时返回完整的 AppConfig", () => {
    const config = loadConfig({ env: validEnv, modelsYamlSource: validYaml });
    expect(config.urmotiv.baseUrl).toBe(validEnv.URMOTIV_BASE_URL);
    expect(config.urmotiv.robotToken).toBe(validEnv.URMOTIV_ROBOT_TOKEN);
    expect(config.server.port).toBe(8720);
    expect(config.providers.aether).toEqual({
      baseUrl: validEnv.AETHER_BASE_URL,
      apiKey: validEnv.AETHER_API_KEY
    });
    expect(config.providers.dashscope).toEqual({
      baseUrl: validEnv.DASHSCOPE_BASE_URL,
      apiKey: validEnv.DASHSCOPE_API_KEY
    });
    expect(config.codeforces).toEqual({ key: "cf-key", secret: "cf-secret" });
    expect(config.models.defaults.modelProfileName).toBe("test-profile");
    expect(config.models.thresholds.duplicateSimilarityReject).toBe(0.9);
  });

  it("CODEFORCES_KEY/SECRET 都留空时 codeforces 为 null（可选凭据）", () => {
    const { CODEFORCES_KEY, CODEFORCES_SECRET, ...rest } = validEnv;
    const config = loadConfig({ env: rest, modelsYamlSource: validYaml });
    expect(config.codeforces).toBeNull();
  });

  it("FERMATA_PORT 缺省时使用默认值 8720", () => {
    const { FERMATA_PORT, ...rest } = validEnv;
    const config = loadConfig({ env: rest, modelsYamlSource: validYaml });
    expect(config.server.port).toBe(8720);
  });
});

describe("loadConfig：必需项缺失或格式错误时快速失败", () => {
  it("缺少 URMOTIV_BASE_URL 时抛出 ConfigError", () => {
    const { URMOTIV_BASE_URL, ...rest } = validEnv;
    expect(() => loadConfig({ env: rest, modelsYamlSource: validYaml })).toThrow(ConfigError);
  });

  it("URMOTIV_BASE_URL 带账号密码时抛出 ConfigError", () => {
    const env = { ...validEnv, URMOTIV_BASE_URL: "https://user:pass@urmotiv.example.test" };
    expect(() => loadConfig({ env, modelsYamlSource: validYaml })).toThrow(ConfigError);
  });

  it("模型服务地址带查询参数或片段时抛出 ConfigError", () => {
    for (const AETHER_BASE_URL of [
      "https://aether.example.test/v1?api_key=secret",
      "https://aether.example.test/v1#secret"
    ]) {
      expect(() =>
        loadConfig({
          env: { ...validEnv, AETHER_BASE_URL },
          modelsYamlSource: validYaml
        })
      ).toThrow(ConfigError);
    }
  });

  it("FERMATA_MANAGEMENT_TOKEN 太短时抛出 ConfigError", () => {
    const env = { ...validEnv, FERMATA_MANAGEMENT_TOKEN: "short" };
    expect(() => loadConfig({ env, modelsYamlSource: validYaml })).toThrow(ConfigError);
  });

  it("只设置了 AETHER_API_KEY 没设置 AETHER_BASE_URL 时抛出 ConfigError", () => {
    const { AETHER_BASE_URL, ...rest } = validEnv;
    expect(() => loadConfig({ env: rest, modelsYamlSource: validYaml })).toThrow(ConfigError);
  });

  it("默认模型档位引用的 provider 没有配置密钥时抛出 ConfigError", () => {
    const { DASHSCOPE_BASE_URL, DASHSCOPE_API_KEY, ...rest } = validEnv;
    expect(() => loadConfig({ env: rest, modelsYamlSource: validYaml })).toThrow(ConfigError);
  });

  it("YAML 结构不合法（缺字段）时抛出 ConfigError", () => {
    const brokenYaml = `
experimentVersion: "exp-test"
defaults:
  modelProfileName: test-profile
  pollingIntervalSeconds: 30
  maximumConcurrentTasks: 2
profiles:
  test-profile:
    difficulty:
      provider: dashscope
      model: qwen-plus
      temperature: 0.2
`;
    expect(() => loadConfig({ env: validEnv, modelsYamlSource: brokenYaml })).toThrow(ConfigError);
  });

  it("查重强制拒绝阈值必须在 0-1 内", () => {
    for (const invalidThreshold of ["-0.1", "1.1"]) {
      const brokenYaml = validYaml.replace(
        "duplicateSimilarityReject: 0.9",
        `duplicateSimilarityReject: ${invalidThreshold}`
      );
      expect(() => loadConfig({ env: validEnv, modelsYamlSource: brokenYaml })).toThrow(ConfigError);
    }
  });

  it("defaults.modelProfileName 在 profiles 中不存在时抛出 ConfigError", () => {
    const brokenYaml = validYaml.replace("modelProfileName: test-profile", "modelProfileName: not-there");
    expect(() => loadConfig({ env: validEnv, modelsYamlSource: brokenYaml })).toThrow(ConfigError);
  });

  it("拒绝把模型输出停顿时间降回 120 秒", () => {
    const brokenYaml = validYaml.replace(
      "llmOutputIdleMs: 600000",
      "llmOutputIdleMs: 120000"
    );
    expect(() =>
      loadConfig({ env: validEnv, modelsYamlSource: brokenYaml })
    ).toThrow(ConfigError);
  });

  it("最终保护时长不能短于等待第一段输出的时间", () => {
    const brokenYaml = validYaml.replace(
      "llmFirstOutputMs: 1800000",
      "llmFirstOutputMs: 20000000"
    );
    expect(() =>
      loadConfig({ env: validEnv, modelsYamlSource: brokenYaml })
    ).toThrow(ConfigError);
  });

  it("YAML 解析本身失败（比如 Tab 缩进）时抛出 ConfigError", () => {
    expect(() => loadConfig({ env: validEnv, modelsYamlSource: "a:\n\tb: 1" })).toThrow(ConfigError);
  });
});

describe("provider 辅助函数", () => {
  it("providersUsedByProfile 去重并返回全部用到的 provider", () => {
    const config = loadConfig({ env: validEnv, modelsYamlSource: validYaml });
    const profile = config.models.profiles["test-profile"];
    expect(profile).toBeDefined();
    const providers = providersUsedByProfile(profile!).sort();
    expect(providers).toEqual(["aether", "dashscope"]);
  });

  it("missingProvidersForProfile 在全部配置齐全时返回空数组", () => {
    const config = loadConfig({ env: validEnv, modelsYamlSource: validYaml });
    const profile = config.models.profiles["test-profile"];
    expect(missingProvidersForProfile(config, profile!)).toEqual([]);
  });

  it("getProviderCredentials 对没配置的 provider 返回 undefined", () => {
    const { CODEFORCES_KEY, CODEFORCES_SECRET, ...rest } = validEnv;
    const config = loadConfig({ env: rest, modelsYamlSource: validYaml });
    expect(getProviderCredentials(config, "aether")).toBeDefined();
  });

  it("非默认档位缺少 provider 密钥时不影响启动，只反映在辅助函数上", () => {
    // 默认档位 only-aether-profile 只用 aether，所以即使环境变量里完全没有配置
    // dashscope，loadConfig 也能成功；但是文件里另一个档位 only-dashscope-profile
    // 引用了 dashscope，这时 missingProvidersForProfile/getProviderCredentials
    // 应该如实反映"这个档位缺 dashscope 的密钥"，而不是让整个进程启动失败——
    // 只有*当前生效*的档位缺密钥才是致命错误。
    const yaml = `
experimentVersion: "exp-test"
defaults:
  modelProfileName: only-aether-profile
  pollingIntervalSeconds: 30
  maximumConcurrentTasks: 2
profiles:
  only-aether-profile:
    difficulty:
      provider: aether
      model: claude-sonnet-5
      temperature: 0.2
      thinking: false
    thinking:
      solver:
        provider: aether
        model: claude-sonnet-5
        temperature: 0.4
        thinking: true
      analyst:
        provider: aether
        model: claude-sonnet-5
        temperature: 0.1
        thinking: false
    coding:
      provider: aether
      model: claude-sonnet-5
      temperature: 0.3
      thinking: false
    verdict:
      provider: aether
      model: claude-sonnet-5
      temperature: 0.1
      thinking: false
  only-dashscope-profile:
    difficulty:
      provider: dashscope
      model: qwen-plus
      temperature: 0.2
      thinking: false
    thinking:
      solver:
        provider: dashscope
        model: qwen-max
        temperature: 0.4
        thinking: true
      analyst:
        provider: dashscope
        model: qwen-max
        temperature: 0.1
        thinking: false
    coding:
      provider: dashscope
      model: qwen-max
      temperature: 0.3
      thinking: false
    verdict:
      provider: dashscope
      model: qwen-max
      temperature: 0.1
      thinking: false
retry:
  maxAttempts: 3
  baseDelayMs: 500
timeouts:
  llmFirstOutputMs: 1800000
  llmOutputIdleMs: 600000
  llmMaximumDurationMs: 14400000
  codeforcesRequestMs: 15000
codeforces:
  minimumRequestIntervalMs: 2100
thresholds:
  duplicateSimilarityReject: 0.9
`;
    const { DASHSCOPE_BASE_URL, DASHSCOPE_API_KEY, ...envWithoutDashscope } = validEnv;

    const config = loadConfig({ env: envWithoutDashscope, modelsYamlSource: yaml });
    expect(getProviderCredentials(config, "dashscope")).toBeUndefined();

    const inactiveProfile = config.models.profiles["only-dashscope-profile"];
    expect(inactiveProfile).toBeDefined();
    expect(missingProvidersForProfile(config, inactiveProfile!)).toEqual(["dashscope"]);
  });
});
