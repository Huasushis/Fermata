import { describe, expect, it } from "vitest";
import {
  defaultLevelsConcurrency,
  defaultLevelsRequestTimeoutMs,
  resolveLevelsCalibrationOptions
} from "../experiments/lib/levels-calibration-options";

describe("思维和代码难度标定参数", () => {
  it("离线标定默认至少等待十分钟", () => {
    expect(
      resolveLevelsCalibrationOptions({
        argv: ["--label=baseline-24"],
        env: {},
        configuredTimeoutMs: 90_000,
        configuredMaxAttempts: 3
      })
    ).toEqual({
      label: "baseline-24",
      resumeFromLabel: null,
      requestTimeoutMs: defaultLevelsRequestTimeoutMs,
      maxAttempts: 3,
      concurrency: defaultLevelsConcurrency
    });
  });

  it("允许明确覆盖等待时间、尝试次数并开启续跑", () => {
    expect(
      resolveLevelsCalibrationOptions({
        argv: ["--label=v3.1", "--resume-from=baseline-24"],
        env: {
          LEVELS_LLM_TIMEOUT_MS: "480000",
          LEVELS_LLM_MAX_ATTEMPTS: "2",
          EVAL_CONCURRENCY: "6"
        },
        configuredTimeoutMs: 90_000,
        configuredMaxAttempts: 3
      })
    ).toEqual({
      label: "v3.1",
      resumeFromLabel: "baseline-24",
      requestTimeoutMs: 480_000,
      maxAttempts: 2,
      concurrency: 6
    });
  });

  it("--resume 只指向当前标签，且不能和 --resume-from 同时使用", () => {
    expect(
      resolveLevelsCalibrationOptions({
        argv: ["--label=current", "--resume"],
        env: {},
        configuredTimeoutMs: 600_000,
        configuredMaxAttempts: 2
      }).resumeFromLabel
    ).toBe("current");
    expect(() =>
      resolveLevelsCalibrationOptions({
        argv: ["--label=current", "--resume", "--resume-from=old"],
        env: {},
        configuredTimeoutMs: 600_000,
        configuredMaxAttempts: 2
      })
    ).toThrow("--resume 和 --resume-from 不能同时使用");
    expect(() =>
      resolveLevelsCalibrationOptions({
        argv: ["--label=current", "--resume-from=current"],
        env: {},
        configuredTimeoutMs: 600_000,
        configuredMaxAttempts: 2
      })
    ).toThrow("--resume-from 不能和 --label 相同");
  });

  it("拒绝可能写出目录外文件的标签", () => {
    expect(() =>
      resolveLevelsCalibrationOptions({
        argv: ["--label=../outside"],
        env: {},
        configuredTimeoutMs: 90_000,
        configuredMaxAttempts: 3
      })
    ).toThrow("--label 只能包含");
    expect(() =>
      resolveLevelsCalibrationOptions({
        argv: ["--label=safe", "--resume-from=../outside"],
        env: {},
        configuredTimeoutMs: 90_000,
        configuredMaxAttempts: 3
      })
    ).toThrow("--resume-from");
  });

  it("拒绝超出范围的实验参数", () => {
    expect(() =>
      resolveLevelsCalibrationOptions({
        argv: [],
        env: { LEVELS_LLM_TIMEOUT_MS: "600001" },
        configuredTimeoutMs: 90_000,
        configuredMaxAttempts: 3
      })
    ).toThrow("LEVELS_LLM_TIMEOUT_MS");
    expect(() =>
      resolveLevelsCalibrationOptions({
        argv: [],
        env: { LEVELS_LLM_MAX_ATTEMPTS: "0" },
        configuredTimeoutMs: 90_000,
        configuredMaxAttempts: 3
      })
    ).toThrow("LEVELS_LLM_MAX_ATTEMPTS");
    expect(() =>
      resolveLevelsCalibrationOptions({
        argv: [],
        env: { EVAL_CONCURRENCY: "not-a-number" },
        configuredTimeoutMs: 90_000,
        configuredMaxAttempts: 3
      })
    ).toThrow("EVAL_CONCURRENCY");
    expect(() =>
      resolveLevelsCalibrationOptions({
        argv: [],
        env: { EVAL_CONCURRENCY: "33" },
        configuredTimeoutMs: 90_000,
        configuredMaxAttempts: 3
      })
    ).toThrow("EVAL_CONCURRENCY");
  });
});
