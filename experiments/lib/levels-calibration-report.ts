import { z } from "zod";
import {
  LevelsCalibrationStateError,
  assessCalibrationCompleteness,
  calibrationFailureCountKey,
  calibrationFailureCountSchema,
  calibrationProgressSchema,
  calibrationRowKey,
  completeCalibrationRows,
  levelBandOf,
  levelsExperimentFingerprintSchema,
  type CalibrationFailureCount,
  type CalibrationProgress,
  type CalibrationRow,
  type LevelsExperimentFingerprint,
  type LevelsReportRunConfiguration
} from "./levels-calibration-state";

/** 报告直接读取这里的等级说明；修改后必须用新标签重跑实验。 */
export const levelAnchorDefinitions = {
  thinking: [
    "1：看到题面即可直接写出做法，没有需要发现的性质。",
    "2：需要一次简单观察或套用一个标准结论。",
    "3：需要组合两个以上常见想法，或发现一条不显然的性质。",
    "4：关键洞察隐藏较深，多数熟练选手需要多次尝试与自我否定。",
    "5：需要罕见的构造或多层推理链，赛场上仅极少数人能想出。"
  ],
  coding: [
    "1：三十行以内的直接实现，无边界陷阱。",
    "2：常规模拟或标准算法模板，少量边界处理。",
    "3：需要仔细组织的中等实现，或一个板子数据结构的正确使用。",
    "4：多组件配合、复杂数据结构定制（如线段树节点设计）或大量分类讨论。",
    "5：实现本身就是主要难点，容错空间极小。"
  ]
} as const;

const reportRunConfigurationSchema = z
  .object({
    providers: z
      .object({
        solver: providerReportSchema(),
        analyst: providerReportSchema(),
        coding: providerReportSchema()
      })
      .strict(),
    outputIdleTimeoutMs: z
      .number()
      .int()
      .min(10 * 60 * 1_000)
      .max(24 * 60 * 60 * 1_000),
    firstOutputTimeoutMs: z
      .number()
      .int()
      .min(30 * 60 * 1_000)
      .max(24 * 60 * 60 * 1_000),
    maximumDurationMs: z
      .number()
      .int()
      .min(4 * 60 * 60 * 1_000)
      .max(24 * 60 * 60 * 1_000),
    maxAttempts: z.number().int().min(1).max(10),
    baseDelayMs: z.number().int().min(1).max(60_000),
    concurrency: z.number().int().min(1).max(32)
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.maximumDurationMs < value.outputIdleTimeoutMs ||
      value.maximumDurationMs < value.firstOutputTimeoutMs
    ) {
      context.addIssue({
        code: "custom",
        message: "每次向模型服务发出请求的最长时间不能小于另外两项等待时间。"
      });
    }
  });

export interface LevelsCalibrationReportInput {
  readonly label: string;
  readonly profileName: string;
  readonly fingerprint: LevelsExperimentFingerprint;
  readonly runConfiguration: LevelsReportRunConfiguration;
  readonly progress: readonly CalibrationProgress[];
  readonly failureCounts: readonly CalibrationFailureCount[];
  readonly expectedProblemCount: number;
  readonly resumedThinkingProblemCount: number;
  readonly resumedCompleteProblemCount: number;
  readonly completedProblemsThisRun: number;
  readonly generatedAt: string;
}

export interface LevelsCalibrationSummary {
  readonly label: string;
  readonly profileName: string;
  readonly experimentFingerprint: LevelsExperimentFingerprint;
  readonly runConfiguration: LevelsReportRunConfiguration;
  readonly problemCount: number;
  readonly thinkingCompletedProblemCount: number;
  readonly expectedProblemCount: number;
  readonly resumedThinkingProblemCount: number;
  readonly resumedProblemCount: number;
  readonly completedThisRun: number;
  readonly incompleteProblemCount: number;
  readonly allProblemsCompleted: boolean;
  readonly allBandsPresent: boolean;
  readonly missingBands: readonly string[];
  readonly complete: boolean;
  readonly failureCounts: readonly CalibrationFailureCount[];
  readonly bandSummaries: readonly {
    readonly band: string;
    readonly count: number;
    readonly averageThinking: number;
    readonly averageCoding: number;
  }[];
  readonly monotonicThinking: boolean;
  readonly monotonicCoding: boolean;
  readonly generatedAt: string;
}

export interface LevelsCalibrationReportOutput {
  readonly rows: readonly CalibrationRow[];
  readonly summary: LevelsCalibrationSummary;
  readonly markdown: string;
}

export function buildLevelsCalibrationReport(
  input: LevelsCalibrationReportInput
): LevelsCalibrationReportOutput {
  assertSafeReportInput(input);
  const progress = input.progress.map((entry) =>
    calibrationProgressSchema.parse(entry)
  );
  const failureCounts = input.failureCounts
    .map((entry) => calibrationFailureCountSchema.parse(entry))
    .sort((left, right) =>
      calibrationFailureCountKey(left).localeCompare(
        calibrationFailureCountKey(right)
      )
    );
  assertNoDuplicateKeys(progress, failureCounts);
  const runConfiguration = reportRunConfigurationSchema.parse(
    input.runConfiguration
  );
  const fingerprint = levelsExperimentFingerprintSchema.parse(
    input.fingerprint
  );
  const rows = completeCalibrationRows(progress).sort(compareRows);
  const bands = new Map<string, CalibrationRow[]>();
  for (const row of rows) {
    const band = levelBandOf(row.rating);
    bands.set(band, [...(bands.get(band) ?? []), row]);
  }
  const bandSummaries = ["低", "中", "高"].map((band) => {
    const bandRows = bands.get(band) ?? [];
    return {
      band,
      count: bandRows.length,
      averageThinking: roundedAverage(
        bandRows.map((row) => row.thinkingLevel)
      ),
      averageCoding: roundedAverage(
        bandRows.map((row) => row.codingLevel)
      )
    };
  });
  const completeness = assessCalibrationCompleteness(
    rows,
    input.expectedProblemCount
  );
  const monotonicThinking =
    completeness.complete &&
    isNonDecreasing(
      bandSummaries.map((summary) => summary.averageThinking)
    );
  const monotonicCoding =
    completeness.complete &&
    isNonDecreasing(bandSummaries.map((summary) => summary.averageCoding));
  const incompleteProblemCount = input.expectedProblemCount - rows.length;
  const thinkingCompletedProblemCount = progress.filter(
    (entry) => entry.thinking !== undefined
  ).length;
  if (
    progress.length > input.expectedProblemCount ||
    input.resumedThinkingProblemCount > thinkingCompletedProblemCount ||
    input.resumedCompleteProblemCount > rows.length ||
    input.completedProblemsThisRun !==
      rows.length - input.resumedCompleteProblemCount
  ) {
    throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
  }

  const summary: LevelsCalibrationSummary = {
    label: input.label,
    profileName: input.profileName,
    experimentFingerprint: fingerprint,
    runConfiguration,
    problemCount: rows.length,
    thinkingCompletedProblemCount,
    expectedProblemCount: input.expectedProblemCount,
    resumedThinkingProblemCount: input.resumedThinkingProblemCount,
    resumedProblemCount: input.resumedCompleteProblemCount,
    completedThisRun: input.completedProblemsThisRun,
    incompleteProblemCount,
    allProblemsCompleted: completeness.allProblemsCompleted,
    allBandsPresent: completeness.allBandsPresent,
    missingBands: completeness.missingBands,
    complete: completeness.complete,
    failureCounts,
    bandSummaries,
    monotonicThinking,
    monotonicCoding,
    generatedAt: input.generatedAt
  };

  return {
    rows,
    summary,
    markdown: buildMarkdown(summary, rows)
  };
}

function buildMarkdown(
  summary: LevelsCalibrationSummary,
  rows: readonly CalibrationRow[]
): string {
  const failureRows =
    summary.failureCounts.length === 0
      ? ["| 无 | 无 | 无 | 0 |"]
      : summary.failureCounts.map(
          (failure) =>
            `| ${failure.stage === "thinking" ? "思维" : "代码"} | ${failure.errorCode} | ${failure.status ?? "无"} | ${failure.count} |`
        );
  const resultRows =
    rows.length === 0
      ? ["| 暂无完整结果 | - | - | - |"]
      : rows.map(
          (row) =>
            `| CF${row.contestId}${row.index} | ${row.rating} | ${row.thinkingLevel} | ${row.codingLevel} |`
        );

  return [
    `# 思维/代码难度标定报告（${summary.label}）`,
    "",
    `- 模型档位：${summary.profileName}`,
    `- 实验校验摘要：${summary.experimentFingerprint.combinedHash}`,
    `- 已完成题数：${summary.problemCount} / ${summary.expectedProblemCount}（按官方 rating 升序）`,
    `- 已保存思维阶段：${summary.thinkingCompletedProblemCount} / ${summary.expectedProblemCount}`,
    `- 从已有中间结果复用完整题目：${summary.resumedProblemCount}`,
    `- 从已有中间结果复用思维阶段：${summary.resumedThinkingProblemCount}`,
    `- 本次仍未完成：${summary.incompleteProblemCount}`,
    `- 缺少的 rating 段：${summary.missingBands.length === 0 ? "无" : summary.missingBands.join("、")}`,
    `- 生成时间：${summary.generatedAt}`,
    "",
    "## 本次运行参数",
    "",
    "- 地址校验值只用于判断两次实验是否连接到同一服务，不会显示服务地址、路径或查询参数。",
    `- 解题模型服务：${summary.runConfiguration.providers.solver.name}（地址校验值 ${summary.runConfiguration.providers.solver.addressCheck}）`,
    `- 分析模型服务：${summary.runConfiguration.providers.analyst.name}（地址校验值 ${summary.runConfiguration.providers.analyst.addressCheck}）`,
    `- 代码模型服务：${summary.runConfiguration.providers.coding.name}（地址校验值 ${summary.runConfiguration.providers.coding.addressCheck}）`,
    `- 收到第一段输出后，连续没有新数据的等待上限：${summary.runConfiguration.outputIdleTimeoutMs} 毫秒`,
    `- 等待第一段输出的上限：${summary.runConfiguration.firstOutputTimeoutMs} 毫秒`,
    `- 每次向模型服务发出请求的最长时间：${summary.runConfiguration.maximumDurationMs} 毫秒`,
    `- 最多尝试次数：${summary.runConfiguration.maxAttempts}（只有模型服务明确返回请求过多时才会再次尝试）`,
    `- 首次重试前等待：${summary.runConfiguration.baseDelayMs} 毫秒`,
    `- 同时处理题数：${summary.runConfiguration.concurrency}`,
    "",
    "## 等级锚点定义",
    "",
    "### 思维难度",
    ...levelAnchorDefinitions.thinking.map((line) => `- ${line}`),
    "",
    "### 代码难度",
    ...levelAnchorDefinitions.coding.map((line) => `- ${line}`),
    "",
    "## 分段趋势",
    "",
    "| rating 段 | 题数 | 思维难度均值 | 代码难度均值 |",
    "| --- | --- | --- | --- |",
    ...summary.bandSummaries.map(
      (band) =>
        `| ${band.band} | ${band.count} | ${band.averageThinking} | ${band.averageCoding} |`
    ),
    "",
    `- 思维难度随 rating 分段单调不降：${summary.complete ? (summary.monotonicThinking ? "是" : "否") : "结果不完整，不能判断"}`,
    `- 代码难度随 rating 分段单调不降：${summary.complete ? (summary.monotonicCoding ? "是" : "否") : "结果不完整，不能判断"}`,
    "",
    "## 阶段失败次数",
    "",
    "- 这里只记录固定错误码、阶段、HTTP 状态码和次数，不保存服务商返回文字或异常说明。",
    "",
    "| 阶段 | 错误码 | HTTP 状态码 | 次数 |",
    "| --- | --- | --- | --- |",
    ...failureRows,
    "",
    "## 逐题结果",
    "",
    "| 题目 | rating | 思维 | 代码 |",
    "| --- | --- | --- | --- |",
    ...resultRows,
    "",
    "## 结论与后续",
    "",
    !summary.allProblemsCompleted
      ? "- 本次有题目尚未完成，不能据此调整提示词、工作流或数值映射；请用 --resume 继续补齐。"
      : !summary.allBandsPresent
        ? "- 标定集没有同时覆盖低、中、高三个 rating 段，不能判断趋势，也不能据此调整提示词、工作流或数值映射。"
        : summary.monotonicThinking && summary.monotonicCoding
          ? "- 当前映射表在标定集上呈单调趋势，可作为初始标准启用；扩大样本后再复核。"
          : "- 当前映射表在完整标定集上出现非单调段，需要先分析逐题误差，再调整对应流水线并重跑实验。",
    "- 修改任何映射常量后，必须以新的 --label 重跑本脚本并保留两份报告做对比。"
  ].join("\n");
}

function providerReportSchema() {
  return z
    .object({
      name: z.enum(["aether", "dashscope"]),
      addressCheck: z.string().regex(/^[a-f0-9]{16}$/)
    })
    .strict();
}

function assertSafeReportInput(input: LevelsCalibrationReportInput): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.label) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(input.profileName) ||
    !Number.isSafeInteger(input.expectedProblemCount) ||
    input.expectedProblemCount < 1 ||
    !isSafeCount(input.resumedThinkingProblemCount, input.expectedProblemCount) ||
    !isSafeCount(input.resumedCompleteProblemCount, input.expectedProblemCount) ||
    !isSafeCount(input.completedProblemsThisRun, input.expectedProblemCount) ||
    input.resumedCompleteProblemCount > input.resumedThinkingProblemCount ||
    input.resumedCompleteProblemCount + input.completedProblemsThisRun >
      input.expectedProblemCount ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      input.generatedAt
    ) ||
    !Number.isFinite(Date.parse(input.generatedAt))
  ) {
    throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
  }
}

function isSafeCount(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function assertNoDuplicateKeys(
  progress: readonly CalibrationProgress[],
  failureCounts: readonly CalibrationFailureCount[]
): void {
  const progressKeys = progress.map(calibrationRowKey);
  const failureKeys = failureCounts.map(calibrationFailureCountKey);
  if (
    new Set(progressKeys).size !== progressKeys.length ||
    new Set(failureKeys).size !== failureKeys.length
  ) {
    throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
  }
}

function roundedAverage(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const average =
    values.reduce((sum, value) => sum + value, 0) / values.length;
  return Number(average.toFixed(2));
}

function isNonDecreasing(values: readonly number[]): boolean {
  const present = values.filter((value) => value > 0);
  for (let index = 1; index < present.length; index += 1) {
    if (present[index]! < present[index - 1]!) {
      return false;
    }
  }
  return true;
}

function compareRows(left: CalibrationRow, right: CalibrationRow): number {
  return (
    left.rating - right.rating ||
    left.contestId - right.contestId ||
    left.index.localeCompare(right.index)
  );
}
