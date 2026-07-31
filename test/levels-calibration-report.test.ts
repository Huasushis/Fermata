import { describe, expect, it } from "vitest";
import { buildLevelsCalibrationReport } from "../experiments/lib/levels-calibration-report";
import {
  buildLevelsExperimentFingerprint,
  buildLevelsReportRunConfiguration,
  buildLevelsRunConfiguration,
  type CalibrationDatasetItem,
  type CalibrationProgress
} from "../experiments/lib/levels-calibration-state";

const generatedAt = "2026-07-31T12:34:56.789Z";

function item(
  contestId: number,
  index: string,
  rating: number
): CalibrationDatasetItem {
  return {
    contestId,
    index,
    rating,
    statement: `题面-${contestId}`,
    editorial: `题解-${contestId}`
  };
}

function thinkingOnly(source: CalibrationDatasetItem): CalibrationProgress {
  return {
    contestId: source.contestId,
    index: source.index,
    rating: source.rating,
    thinking: {
      level: 2,
      signals: {
        solved: true,
        approachSimilarity: 0.8,
        selfCorrections: 0,
        keyInsightCount: 1
      }
    }
  };
}

function complete(source: CalibrationDatasetItem): CalibrationProgress {
  return {
    ...thinkingOnly(source),
    coding: {
      level: 3,
      signals: {
        effectiveLineCount: 50,
        maxNestingDepth: 3,
        detectedDataStructures: ["并查集"],
        maxDataStructureWeight: 0.5
      }
    }
  };
}

function reportInput(
  progress: readonly CalibrationProgress[],
  expectedProblemCount: number
) {
  const secret = "REPORT_SECRET_SENTINEL";
  const runConfiguration = buildLevelsRunConfiguration({
    solverBaseUrl: "https://solver.private.example/internal/gateway",
    analystBaseUrl: "https://analyst.private.example/internal/gateway",
    codingBaseUrl: "https://coding.private.example/internal/gateway",
    outputIdleTimeoutMs: 600_000,
    firstOutputTimeoutMs: 1_800_000,
    maximumDurationMs: 14_400_000,
    maxAttempts: 3,
    baseDelayMs: 1_000,
    concurrency: 2
  });
  const dataset = [
    {
      ...item(1, "A", 1200),
      statement: secret,
      editorial: secret
    },
    item(2, "B", 1800),
    item(3, "C", 2400)
  ];
  return {
    secret,
    input: {
      label: "safe-label",
      profileName: "review-balanced",
      fingerprint: buildLevelsExperimentFingerprint({
        dataset,
        experimentVersion: "test",
        profileName: "review-balanced",
        profile: { model: "test" },
        runConfiguration,
        pipelineSources: { runner: "source" },
        calibrationProtocol: { bandBoundaries: [1400, 2200] }
      }),
      runConfiguration: buildLevelsReportRunConfiguration({
        runConfiguration,
        providerNames: {
          solver: "aether",
          analyst: "aether",
          coding: "dashscope"
        }
      }),
      progress,
      failureCounts: [
        {
          stage: "thinking" as const,
          errorCode: "LLM_HTTP_ERROR" as const,
          status: 499,
          count: 3
        },
        {
          stage: "coding" as const,
          errorCode: "LLM_OUTPUT_IDLE_TIMEOUT" as const,
          status: null,
          count: 2
        }
      ],
      expectedProblemCount,
      resumedThinkingProblemCount: 0,
      resumedCompleteProblemCount: 0,
      completedProblemsThisRun: 0,
      generatedAt
    }
  };
}

describe("标定汇总与报告", () => {
  it("零道完整成功时仍生成安全的不完整汇总和报告", () => {
    const { input, secret } = reportInput([], 3);
    const output = buildLevelsCalibrationReport(input);
    expect(output.rows).toEqual([]);
    expect(output.summary).toMatchObject({
      problemCount: 0,
      thinkingCompletedProblemCount: 0,
      expectedProblemCount: 3,
      incompleteProblemCount: 3,
      allProblemsCompleted: false,
      allBandsPresent: false,
      complete: false,
      monotonicThinking: false,
      monotonicCoding: false
    });
    expect(output.summary.bandSummaries).toEqual([
      { band: "低", count: 0, averageThinking: 0, averageCoding: 0 },
      { band: "中", count: 0, averageThinking: 0, averageCoding: 0 },
      { band: "高", count: 0, averageThinking: 0, averageCoding: 0 }
    ]);
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("private.example");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("NaN");
    expect(serialized).not.toContain("Infinity");
    expect(output.markdown).toContain("暂无完整结果");
    expect(output.markdown).toContain("结果不完整，不能判断");
    expect(output.summary.runConfiguration).toMatchObject({
      outputIdleTimeoutMs: 600_000,
      firstOutputTimeoutMs: 1_800_000,
      maximumDurationMs: 14_400_000
    });
    expect(output.markdown).toContain(
      "连续没有新数据的等待上限：600000 毫秒"
    );
    expect(output.markdown).toContain(
      "等待第一段输出的上限：1800000 毫秒"
    );
    expect(output.markdown).toContain(
      "每次向模型服务发出请求的最长时间：14400000 毫秒"
    );
  });

  it("仅保存思维结果时显示阶段进度，但完整题数仍为零", () => {
    const source = item(1, "A", 1200);
    const { input } = reportInput([thinkingOnly(source)], 3);
    const output = buildLevelsCalibrationReport({
      ...input,
      resumedThinkingProblemCount: 1
    });
    expect(output.summary.thinkingCompletedProblemCount).toBe(1);
    expect(output.summary.problemCount).toBe(0);
    expect(output.summary.resumedThinkingProblemCount).toBe(1);
    expect(output.summary.complete).toBe(false);
  });

  it("三个分段全部完成后才计算趋势", () => {
    const progress = [
      complete(item(1, "A", 1200)),
      complete(item(2, "B", 1800)),
      complete(item(3, "C", 2400))
    ];
    const { input } = reportInput(progress, 3);
    const output = buildLevelsCalibrationReport({
      ...input,
      completedProblemsThisRun: 3
    });
    expect(output.summary.complete).toBe(true);
    expect(output.summary.monotonicThinking).toBe(true);
    expect(output.summary.monotonicCoding).toBe(true);
    expect(output.rows.map((row) => row.rating)).toEqual([
      1200,
      1800,
      2400
    ]);
  });

  it("三个分段都有结果但仍有题目未完成时不判断趋势", () => {
    const progress = [
      complete(item(1, "A", 1200)),
      complete(item(2, "B", 1800)),
      complete(item(3, "C", 2400))
    ];
    const { input } = reportInput(progress, 4);
    const output = buildLevelsCalibrationReport({
      ...input,
      completedProblemsThisRun: 3
    });
    expect(output.summary).toMatchObject({
      allProblemsCompleted: false,
      allBandsPresent: true,
      complete: false,
      monotonicThinking: false,
      monotonicCoding: false
    });
    expect(output.markdown).toContain("结果不完整，不能判断");
  });

  it("报告生成前严格拒绝进度中的题面或其它未知字段", () => {
    const source = item(1, "A", 1200);
    const { input } = reportInput(
      [
        {
          ...thinkingOnly(source),
          statement: "不能进入报告的题面"
        } as unknown as CalibrationProgress
      ],
      3
    );
    expect(() => buildLevelsCalibrationReport(input)).toThrow();
  });

  it("报告层拒绝旧等待字段和彼此矛盾的等待时间", () => {
    const { input } = reportInput([], 3);
    expect(() =>
      buildLevelsCalibrationReport({
        ...input,
        runConfiguration: {
          ...input.runConfiguration,
          requestTimeoutMs: 600_000
        } as unknown as typeof input.runConfiguration
      })
    ).toThrow();
    expect(() =>
      buildLevelsCalibrationReport({
        ...input,
        runConfiguration: {
          ...input.runConfiguration,
          outputIdleTimeoutMs: 18_000_000,
          maximumDurationMs: 14_400_000
        }
      })
    ).toThrow();
  });

  it("报告拒绝失败统计中的旧错误码和外部错误正文", () => {
    const { input, secret } = reportInput([], 3);
    let caught: unknown;
    try {
      buildLevelsCalibrationReport({
        ...input,
        failureCounts: [
          {
            stage: "coding",
            errorCode: "LLM_REQUEST_FAILED",
            status: null,
            count: 1,
            message: secret
          }
        ] as unknown as typeof input.failureCounts
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(String(caught)).not.toContain(secret);
  });
});
