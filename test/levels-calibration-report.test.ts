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
const chainRunId = "11111111-1111-4111-8111-111111111111";
const executionRunId = "22222222-2222-4222-8222-222222222222";
const datasetManifestHash = "a".repeat(64);

function item(
  contestId: number,
  index: string,
  rating: number
): CalibrationDatasetItem {
  return {
    safeId: `sample-${contestId}-${index}`,
    contestId,
    index,
    rating,
    humanThinkingLevel: 2,
    humanCodingLevel: 3,
    statement: `题面-${contestId}`,
    editorial: `题解-${contestId}`
  };
}

function thinkingOnly(source: CalibrationDatasetItem): CalibrationProgress {
  return {
    safeId: source.safeId,
    contestId: source.contestId,
    index: source.index,
    rating: source.rating,
    humanThinkingLevel: source.humanThinkingLevel,
    humanCodingLevel: source.humanCodingLevel,
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
      datasetId: "safe-dataset",
      chainRunId,
      executionRunId,
      profileName: "review-balanced",
      fingerprint: buildLevelsExperimentFingerprint({
        dataset,
        datasetManifestHash,
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
      activeStages: [],
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
      "连续没有新有效内容的等待上限：600000 毫秒"
    );
    expect(output.markdown).toContain(
      "等待首个有效输出事件的上限：1800000 毫秒"
    );
    expect(output.markdown).toContain(
      "首个有效输出事件到达前（包括明确 429 的重试等待）的最终保护：14400000 毫秒"
    );
    expect(output.markdown).toContain("它不是持续输出请求的总时限");
    expect(output.markdown).not.toContain("每次向模型服务发出请求的最长时间");
    expect(output.markdown).toContain("本链只保留为失败报告");
    expect(output.markdown).not.toContain("请用同标签 --resume");
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
      failureCounts: [],
      completedProblemsThisRun: 3
    });
    expect(output.summary.complete).toBe(true);
    expect(output.summary.operationalComplete).toBe(true);
    expect(output.summary.minimumSampleSizeMet).toBe(false);
    expect(output.summary.accuracyPassed).toBe(false);
    expect(output.summary.eligible).toBe(false);
    expect(output.summary.monotonicThinking).toBe(true);
    expect(output.summary.monotonicCoding).toBe(true);
    expect(output.rows.map((row) => row.rating)).toEqual([
      1200,
      1800,
      2400
    ]);
  });

  it("失败或 499 的历史即使续跑补齐也永久让 complete 和 eligible 为 false", () => {
    const progress = Array.from({ length: 60 }, (_, offset) =>
      complete(
        item(
          offset + 100,
          "A",
          offset % 3 === 0 ? 1200 : offset % 3 === 1 ? 1800 : 2400
        )
      )
    );
    const { input } = reportInput(progress, progress.length);
    const output = buildLevelsCalibrationReport({
      ...input,
      resumedThinkingProblemCount: progress.length,
      resumedCompleteProblemCount: progress.length,
      completedProblemsThisRun: 0
    });
    expect(output.summary).toMatchObject({
      operationalComplete: true,
      integrityClean: false,
      complete: false,
      accuracyPassed: true,
      eligible: false
    });
    expect(output.markdown).toContain("必须使用全新标签从零运行");
  });

  it("按人工等级计算完全一致、±1 和 MAE，并在 HANDOFF 边界上通过", () => {
    const humanThinkingLevels = Array.from({ length: 60 }, (_, offset) =>
      offset < 36 ? 2 : offset < 54 ? 3 : 4
    );
    const sources = humanThinkingLevels.map((humanThinkingLevel, offset) => ({
      ...item(
        offset + 10,
        "A",
        offset % 3 === 0 ? 1200 : offset % 3 === 1 ? 1800 : 2400
      ),
      humanThinkingLevel,
      humanCodingLevel: 3
    }));
    const progress = sources.map(complete);
    const { input } = reportInput(progress, progress.length);
    const output = buildLevelsCalibrationReport({
      ...input,
      failureCounts: [],
      completedProblemsThisRun: progress.length
    });
    expect(output.summary.thinkingAccuracy).toEqual({
      count: 60,
      exactMatches: 36,
      exactRate: 0.6,
      withinOneMatches: 54,
      withinOneRate: 0.9,
      mae: 0.5,
      passed: true
    });
    expect(output.summary.codingAccuracy).toMatchObject({
      exactRate: 1,
      withinOneRate: 1,
      mae: 0,
      passed: true
    });
    expect(output.summary.accuracyPassed).toBe(true);
    expect(output.summary.eligible).toBe(true);
  });

  it("准确性未达到阈值时即使操作完整且无失败也不可作为合格证据", () => {
    const humanThinkingLevels = Array.from({ length: 60 }, (_, offset) =>
      offset < 36 ? 2 : offset < 48 ? 3 : 5
    );
    const progress = humanThinkingLevels.map((humanThinkingLevel, offset) =>
      complete({
        ...item(
          offset + 30,
          "A",
          offset % 3 === 0 ? 1200 : offset % 3 === 1 ? 1800 : 2400
        ),
        humanThinkingLevel,
        humanCodingLevel: 3
      })
    );
    const { input } = reportInput(progress, progress.length);
    const output = buildLevelsCalibrationReport({
      ...input,
      failureCounts: [],
      completedProblemsThisRun: progress.length
    });
    expect(output.summary.operationalComplete).toBe(true);
    expect(output.summary.integrityClean).toBe(true);
    expect(output.summary.complete).toBe(true);
    expect(output.summary.thinkingAccuracy.passed).toBe(false);
    expect(output.summary.accuracyPassed).toBe(false);
    expect(output.summary.eligible).toBe(false);
  });

  it("报告中仍有 active 阶段时 operationalComplete 为 false", () => {
    const progress = [
      complete(item(1, "A", 1200)),
      complete(item(2, "B", 1800)),
      complete(item(3, "C", 2400))
    ];
    const { input } = reportInput(progress, 3);
    const output = buildLevelsCalibrationReport({
      ...input,
      failureCounts: [],
      activeStages: [{ safeId: progress[0]!.safeId, stage: "coding" }],
      completedProblemsThisRun: 3
    });
    expect(output.summary).toMatchObject({
      activeStageCount: 1,
      operationalComplete: false,
      complete: false,
      accuracyPassed: false,
      eligible: false
    });
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

  it("报告严格拒绝缺失语义的实验链或执行 UUID", () => {
    const { input } = reportInput([], 3);
    expect(() =>
      buildLevelsCalibrationReport({
        ...input,
        chainRunId: "not-a-uuid"
      })
    ).toThrow();
    expect(() =>
      buildLevelsCalibrationReport({
        ...input,
        executionRunId: "00000000-0000-0000-0000-000000000000"
      })
    ).toThrow();
  });
});
