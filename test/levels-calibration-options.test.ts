import { describe, expect, it } from "vitest";
import {
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
      maxAttempts: 3
    });
  });

  it("允许明确覆盖等待时间、尝试次数并开启续跑", () => {
    expect(
      resolveLevelsCalibrationOptions({
        argv: ["--label=v3.1", "--resume-from=baseline-24"],
        env: {
          LEVELS_LLM_TIMEOUT_MS: "480000",
          LEVELS_LLM_MAX_ATTEMPTS: "2"
        },
        configuredTimeoutMs: 90_000,
        configuredMaxAttempts: 3
      })
    ).toEqual({
      label: "v3.1",
      resumeFromLabel: "baseline-24",
      requestTimeoutMs: 480_000,
      maxAttempts: 2
    });
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
  });
});
