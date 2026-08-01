import { describe, expect, it } from "vitest";
import {
  defaultLevelsConcurrency,
  defaultLevelsFirstOutputTimeoutMs,
  defaultLevelsMaximumDurationMs,
  defaultLevelsOutputIdleTimeoutMs,
  resolveLevelsCalibrationOptions
} from "../experiments/lib/levels-calibration-options";

const configuredDefaults = {
  configuredOutputIdleTimeoutMs: defaultLevelsOutputIdleTimeoutMs,
  configuredFirstOutputTimeoutMs: defaultLevelsFirstOutputTimeoutMs,
  configuredMaximumDurationMs: defaultLevelsMaximumDurationMs,
  configuredMaxAttempts: 3
} as const;

function resolve(input: {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly configuredOutputIdleTimeoutMs?: number;
  readonly configuredFirstOutputTimeoutMs?: number;
  readonly configuredMaximumDurationMs?: number;
  readonly configuredMaxAttempts?: number;
} = {}) {
  return resolveLevelsCalibrationOptions({
    argv: input.argv ?? [],
    env: input.env ?? {},
    configuredOutputIdleTimeoutMs:
      input.configuredOutputIdleTimeoutMs ??
      configuredDefaults.configuredOutputIdleTimeoutMs,
    configuredFirstOutputTimeoutMs:
      input.configuredFirstOutputTimeoutMs ??
      configuredDefaults.configuredFirstOutputTimeoutMs,
    configuredMaximumDurationMs:
      input.configuredMaximumDurationMs ??
      configuredDefaults.configuredMaximumDurationMs,
    configuredMaxAttempts:
      input.configuredMaxAttempts ?? configuredDefaults.configuredMaxAttempts
  });
}

describe("思维和代码难度标定参数", () => {
  it("使用十分钟、三十分钟和四小时的安全默认值", () => {
    expect(
      resolve({
        argv: ["--label=baseline-24"],
        configuredOutputIdleTimeoutMs: 90_000,
        configuredFirstOutputTimeoutMs: 90_000,
        configuredMaximumDurationMs: 90_000
      })
    ).toEqual({
      label: "baseline-24",
      resumeFromLabel: null,
      outputIdleTimeoutMs: defaultLevelsOutputIdleTimeoutMs,
      firstOutputTimeoutMs: defaultLevelsFirstOutputTimeoutMs,
      maximumDurationMs: defaultLevelsMaximumDurationMs,
      maxAttempts: 3,
      concurrency: defaultLevelsConcurrency
    });
  });

  it("配置文件较长的等待时间会成为实验默认值", () => {
    expect(
      resolve({
        configuredOutputIdleTimeoutMs: 15 * 60 * 1_000,
        configuredFirstOutputTimeoutMs: 45 * 60 * 1_000,
        configuredMaximumDurationMs: 5 * 60 * 60 * 1_000
      })
    ).toMatchObject({
      outputIdleTimeoutMs: 15 * 60 * 1_000,
      firstOutputTimeoutMs: 45 * 60 * 1_000,
      maximumDurationMs: 5 * 60 * 60 * 1_000
    });
  });

  it("允许分别覆盖三项等待时间、尝试次数并开启同标签续跑", () => {
    expect(
      resolve({
        argv: ["--label=v3.1", "--resume"],
        env: {
          LEVELS_LLM_OUTPUT_IDLE_MS: "720000",
          LEVELS_LLM_FIRST_OUTPUT_MS: "2400000",
          LEVELS_LLM_MAX_DURATION_MS: "18000000",
          LEVELS_LLM_MAX_ATTEMPTS: "2",
          EVAL_CONCURRENCY: "6"
        }
      })
    ).toEqual({
      label: "v3.1",
      resumeFromLabel: "v3.1",
      outputIdleTimeoutMs: 720_000,
      firstOutputTimeoutMs: 2_400_000,
      maximumDurationMs: 18_000_000,
      maxAttempts: 2,
      concurrency: 6
    });
  });

  it("明确拒绝含义不清的旧等待变量，即使值为空", () => {
    for (const value of ["480000", ""]) {
      expect(() =>
        resolve({ env: { LEVELS_LLM_TIMEOUT_MS: value } })
      ).toThrow(
        "LEVELS_LLM_TIMEOUT_MS 已不再支持"
      );
    }
  });

  it("--resume 只指向当前标签，跨标签续跑参数直接视为不支持", () => {
    expect(
      resolve({ argv: ["--label=current", "--resume"] }).resumeFromLabel
    ).toBe("current");
    expect(() =>
      resolve({
        argv: ["--label=current", "--resume-from=old"]
      })
    ).toThrow("不支持的标定参数");
  });

  it("拒绝可能写出目录外文件的标签", () => {
    expect(() => resolve({ argv: ["--label=../outside"] })).toThrow(
      "--label 只能包含"
    );
  });

  it("拒绝未知或重复参数，避免拼错后意外启动付费实验", () => {
    expect(() => resolve({ argv: ["--resmue"] })).toThrow(
      "不支持的标定参数"
    );
    expect(() =>
      resolve({ argv: ["--label=first", "--label=second"] })
    ).toThrow("--label 不能重复");
    expect(() =>
      resolve({ argv: ["--resume", "--resume"] })
    ).toThrow("--resume 不能重复");
    expect(() =>
      resolve({
        argv: ["--resume-from=first", "--resume-from=second"]
      })
    ).toThrow("不支持的标定参数");
  });

  it("拒绝低于安全下限、超过一天或彼此矛盾的等待时间", () => {
    const invalidEnvironments: readonly NodeJS.ProcessEnv[] = [
      { LEVELS_LLM_OUTPUT_IDLE_MS: "599999" },
      { LEVELS_LLM_OUTPUT_IDLE_MS: "600000.5" },
      { LEVELS_LLM_FIRST_OUTPUT_MS: "1799999" },
      { LEVELS_LLM_MAX_DURATION_MS: "14399999" },
      { LEVELS_LLM_OUTPUT_IDLE_MS: "86400001" },
      { LEVELS_LLM_FIRST_OUTPUT_MS: "86400001" },
      { LEVELS_LLM_MAX_DURATION_MS: "86400001" }
    ];
    for (const env of invalidEnvironments) {
      expect(() => resolve({ env })).toThrow("LEVELS_LLM_");
    }
    expect(() =>
      resolve({
        env: {
          LEVELS_LLM_OUTPUT_IDLE_MS: "18000000",
          LEVELS_LLM_MAX_DURATION_MS: "14400000"
        }
      })
    ).toThrow("LEVELS_LLM_MAX_DURATION_MS 不能小于");
  });

  it("拒绝超出范围的其它实验参数", () => {
    expect(() =>
      resolve({ env: { LEVELS_LLM_MAX_ATTEMPTS: "0" } })
    ).toThrow("LEVELS_LLM_MAX_ATTEMPTS");
    expect(() =>
      resolve({ env: { EVAL_CONCURRENCY: "not-a-number" } })
    ).toThrow("EVAL_CONCURRENCY");
    expect(() => resolve({ env: { EVAL_CONCURRENCY: "33" } })).toThrow(
      "EVAL_CONCURRENCY"
    );
  });
});
