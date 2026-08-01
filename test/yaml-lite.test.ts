import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseYamlLite, YamlLiteError } from "../src/yaml-lite";

describe("parseYamlLite：基本标量与嵌套映射", () => {
  it("解析字符串、数字、布尔、null 标量", () => {
    const source = [
      "name: qwen-max",
      "temperature: 0.2",
      "count: 3",
      "negative: -5",
      "enabled: true",
      "disabled: false",
      "empty:",
      "tilde: ~",
      'quoted: "hello world"',
      "singleQuoted: 'it''s fine'"
    ].join("\n");

    expect(parseYamlLite(source)).toEqual({
      name: "qwen-max",
      temperature: 0.2,
      count: 3,
      negative: -5,
      enabled: true,
      disabled: false,
      empty: null,
      tilde: null,
      quoted: "hello world",
      singleQuoted: "it's fine"
    });
  });

  it("解析多层嵌套映射，且能在兄弟键之间正确切换层级", () => {
    const source = [
      "profiles:",
      "  review-balanced:",
      "    difficulty:",
      "      provider: dashscope",
      "      temperature: 0.2",
      "    coding:",
      "      provider: aether",
      "retry:",
      "  maxAttempts: 3"
    ].join("\n");

    expect(parseYamlLite(source)).toEqual({
      profiles: {
        "review-balanced": {
          difficulty: { provider: "dashscope", temperature: 0.2 },
          coding: { provider: "aether" }
        }
      },
      retry: { maxAttempts: 3 }
    });
  });

  it("解析平铺的标量列表，并能在列表结束后回到同级映射", () => {
    const source = ["tags:", "  - alpha", "  - beta", "next: value"].join("\n");

    expect(parseYamlLite(source)).toEqual({
      tags: ["alpha", "beta"],
      next: "value"
    });
  });

  it("忽略注释行和行内注释，且引号内的 # 不被当作注释", () => {
    const source = [
      "# 这是一整行注释",
      "name: qwen-max # 行内注释",
      'withHash: "a#b"'
    ].join("\n");

    expect(parseYamlLite(source)).toEqual({
      name: "qwen-max",
      withHash: "a#b"
    });
  });

  it("空行不影响解析", () => {
    const source = ["a: 1", "", "", "b: 2"].join("\n");
    expect(parseYamlLite(source)).toEqual({ a: 1, b: 2 });
  });
});

describe("parseYamlLite：错误输入", () => {
  it("拒绝 Tab 缩进", () => {
    const source = "a:\n\tb: 1";
    expect(() => parseYamlLite(source)).toThrow(YamlLiteError);
  });

  it("拒绝没有闭合的双引号字符串", () => {
    expect(() => parseYamlLite('name: "unterminated')).toThrow(YamlLiteError);
  });

  it("拒绝没有对应父级键的缩进", () => {
    const source = ["a: 1", "  b: 2"].join("\n");
    expect(() => parseYamlLite(source)).toThrow(YamlLiteError);
  });

  it("拒绝列表项出现在期望映射条目的位置", () => {
    const source = ["a:", "  - 1", "  b: 2"].join("\n");
    expect(() => parseYamlLite(source)).toThrow(YamlLiteError);
  });

  it("拒绝不合法的键名", () => {
    expect(() => parseYamlLite("1invalid: value")).toThrow(YamlLiteError);
  });

  it("拒绝既不是 key: value 也不是 - value 的行", () => {
    expect(() => parseYamlLite("just some text without colon")).toThrow(YamlLiteError);
  });
});

describe("parseYamlLite：解析真实的 config/models.yaml", () => {
  it("能无误解析，且顶层结构符合预期", () => {
    const filePath = new URL("../config/models.yaml", import.meta.url);
    const source = readFileSync(filePath, "utf8");
    const parsed = parseYamlLite(source);

    expect(typeof parsed.experimentVersion).toBe("string");
    expect(parsed.defaults).toMatchObject({
      modelProfileName: expect.any(String),
      pollingIntervalSeconds: expect.any(Number),
      maximumConcurrentTasks: expect.any(Number)
    });

    const profiles = parsed.profiles as Record<string, unknown>;
    expect(Object.keys(profiles).length).toBeGreaterThan(0);

    const defaultProfileName = (parsed.defaults as Record<string, unknown>).modelProfileName as string;
    const defaultProfile = profiles[defaultProfileName] as Record<string, unknown>;
    expect(defaultProfile).toBeTruthy();
    expect(defaultProfile.difficulty).toBeTruthy();
    expect(defaultProfile.difficulty).toMatchObject({
      provider: "aether",
      model: "deepseek-v4-flash",
      temperature: 0.2,
      thinking: false,
      thinkingRequest: "disabled"
    });
    expect(defaultProfile.difficulty).not.toHaveProperty("reasoningEffort");
    expect(defaultProfile.thinking).toMatchObject({
      solver: expect.any(Object),
      analyst: expect.any(Object)
    });
    expect(defaultProfile.coding).toBeTruthy();
    expect(defaultProfile.verdict).toBeTruthy();
    expect(parsed.timeouts).toMatchObject({
      llmFirstOutputMs: 1_800_000,
      llmOutputIdleMs: 600_000,
      llmMaximumDurationMs: 14_400_000
    });
    expect(parsed.experimentVersion).toBe(
      "experiment-2026-08-difficulty-candidate-c-restored-v2"
    );
  });
});
