import { z } from "zod";
import {
  LevelsCalibrationStateError,
  assessCalibrationCompleteness,
  calibrationActiveStageSchema,
  calibrationFailureCountKey,
  calibrationFailureCountSchema,
  calibrationProgressSchema,
  calibrationRunIdSchema,
  calibrationRowKey,
  calibrationSafeIdSchema,
  completeCalibrationRows,
  levelBandOf,
  levelsExperimentFingerprintSchema,
  type CalibrationFailureCount,
  type CalibrationActiveStage,
  type CalibrationProgress,
  type CalibrationRow,
  type LevelsExperimentFingerprint,
  type LevelsReportRunConfiguration
} from "./levels-calibration-state";

export const LEVEL_ACCURACY_THRESHOLDS = {
  minimumProblemCount: 60,
  exactRate: 0.6,
  withinOneRate: 0.9,
  maximumMae: 0.6
} as const;

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
        message: "首个有效输出前的最终保护配置值不能小于另外两项等待配置值。"
      });
    }
  });

export interface LevelsCalibrationReportInput {
  readonly label: string;
  readonly datasetId: string;
  readonly chainRunId: string;
  readonly executionRunId: string;
  readonly profileName: string;
  readonly fingerprint: LevelsExperimentFingerprint;
  readonly runConfiguration: LevelsReportRunConfiguration;
  readonly progress: readonly CalibrationProgress[];
  readonly failureCounts: readonly CalibrationFailureCount[];
  readonly activeStages: readonly CalibrationActiveStage[];
  readonly expectedProblemCount: number;
  readonly resumedThinkingProblemCount: number;
  readonly resumedCompleteProblemCount: number;
  readonly completedProblemsThisRun: number;
  readonly generatedAt: string;
}

export interface LevelAccuracyMetrics {
  readonly count: number;
  readonly exactMatches: number;
  readonly exactRate: number;
  readonly withinOneMatches: number;
  readonly withinOneRate: number;
  readonly mae: number;
  readonly passed: boolean;
}

export interface LevelsCalibrationSummary {
  readonly label: string;
  readonly datasetId: string;
  readonly chainRunId: string;
  readonly executionRunId: string;
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
  readonly activeStageCount: number;
  readonly minimumSampleSizeMet: boolean;
  readonly integrityClean: boolean;
  readonly operationalComplete: boolean;
  readonly complete: boolean;
  readonly thinkingAccuracy: LevelAccuracyMetrics;
  readonly codingAccuracy: LevelAccuracyMetrics;
  readonly accuracyPassed: boolean;
  readonly eligible: boolean;
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
  const activeStages = input.activeStages.map((entry) =>
    calibrationActiveStageSchema.parse(entry)
  );
  assertNoDuplicateKeys(progress, failureCounts, activeStages);
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
  const operationalComplete =
    completeness.complete && activeStages.length === 0;
  const minimumSampleSizeMet =
    input.expectedProblemCount >= LEVEL_ACCURACY_THRESHOLDS.minimumProblemCount;
  const integrityClean = failureCounts.length === 0;
  const complete = operationalComplete && integrityClean;
  const thinkingAccuracy = buildAccuracyMetrics(
    rows.map((row) => ({
      predicted: row.thinkingLevel,
      expected: row.humanThinkingLevel
    })),
    operationalComplete
  );
  const codingAccuracy = buildAccuracyMetrics(
    rows.map((row) => ({
      predicted: row.codingLevel,
      expected: row.humanCodingLevel
    })),
    operationalComplete
  );
  const accuracyPassed =
    operationalComplete &&
    minimumSampleSizeMet &&
    thinkingAccuracy.passed &&
    codingAccuracy.passed;
  const eligible = complete && accuracyPassed;
  const monotonicThinking =
    operationalComplete &&
    isNonDecreasing(
      bandSummaries.map((summary) => summary.averageThinking)
    );
  const monotonicCoding =
    operationalComplete &&
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
    datasetId: input.datasetId,
    chainRunId: input.chainRunId,
    executionRunId: input.executionRunId,
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
    activeStageCount: activeStages.length,
    minimumSampleSizeMet,
    integrityClean,
    operationalComplete,
    complete,
    thinkingAccuracy,
    codingAccuracy,
    accuracyPassed,
    eligible,
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
      ? ["| 暂无完整结果 | - | - | - | - | - |"]
      : rows.map(
          (row) =>
            `| ${row.safeId} | ${row.rating} | ${row.humanThinkingLevel} | ${row.thinkingLevel} | ${row.humanCodingLevel} | ${row.codingLevel} |`
        );

  return [
    `# 思维/代码难度标定报告（${summary.label}）`,
    "",
    `- 数据集安全编号：${summary.datasetId}`,
    `- 实验链编号：${summary.chainRunId}`,
    `- 本次执行编号：${summary.executionRunId}`,
    `- 模型档位：${summary.profileName}`,
    `- 实验校验摘要：${summary.experimentFingerprint.combinedHash}`,
    `- 已完成题数：${summary.problemCount} / ${summary.expectedProblemCount}（按官方 rating 升序）`,
    `- 已保存思维阶段：${summary.thinkingCompletedProblemCount} / ${summary.expectedProblemCount}`,
    `- 从已有中间结果复用完整题目：${summary.resumedProblemCount}`,
    `- 从已有中间结果复用思维阶段：${summary.resumedThinkingProblemCount}`,
    `- 本次仍未完成：${summary.incompleteProblemCount}`,
    `- 缺少的 rating 段：${summary.missingBands.length === 0 ? "无" : summary.missingBands.join("、")}`,
    `- 当前是否跑完全部预登记阶段：${summary.operationalComplete ? "是" : "否"}`,
    `- 是否达到至少 ${LEVEL_ACCURACY_THRESHOLDS.minimumProblemCount} 题：${summary.minimumSampleSizeMet ? "是" : "否"}`,
    `- 实验链是否没有失败、取消、中断、跳过或陈旧在途证据：${summary.integrityClean ? "是" : "否"}`,
    `- 完整性是否合格：${summary.complete ? "是" : "否"}`,
    `- 准确性是否达到最低指标：${summary.accuracyPassed ? "是" : "否"}`,
    `- 是否可作为合格标定证据：${summary.eligible ? "是" : "否"}`,
    `- 生成时间：${summary.generatedAt}`,
    "",
    "## 本次运行参数",
    "",
    "- 地址校验值只用于判断两次实验是否连接到同一服务，不会显示服务地址、路径或查询参数。",
    `- 解题模型服务：${summary.runConfiguration.providers.solver.name}（地址校验值 ${summary.runConfiguration.providers.solver.addressCheck}）`,
    `- 分析模型服务：${summary.runConfiguration.providers.analyst.name}（地址校验值 ${summary.runConfiguration.providers.analyst.addressCheck}）`,
    `- 代码模型服务：${summary.runConfiguration.providers.coding.name}（地址校验值 ${summary.runConfiguration.providers.coding.addressCheck}）`,
    `- 收到首个有效输出事件后，连续没有新有效内容的等待上限：${summary.runConfiguration.outputIdleTimeoutMs} 毫秒`,
    `- 等待首个有效输出事件的上限：${summary.runConfiguration.firstOutputTimeoutMs} 毫秒`,
    `- 首个有效输出事件到达前（包括明确 429 的重试等待）的最终保护：${summary.runConfiguration.maximumDurationMs} 毫秒；有效输出开始后会清除此保护，它不是持续输出请求的总时限。`,
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
    `- 思维难度随 rating 分段单调不降：${summary.operationalComplete ? (summary.monotonicThinking ? "是" : "否") : "结果不完整，不能判断"}`,
    `- 代码难度随 rating 分段单调不降：${summary.operationalComplete ? (summary.monotonicCoding ? "是" : "否") : "结果不完整，不能判断"}`,
    "",
    "## 人工标准准确性",
    "",
    `- 最低指标：至少 ${LEVEL_ACCURACY_THRESHOLDS.minimumProblemCount} 题；完全一致率至少 ${formatPercent(LEVEL_ACCURACY_THRESHOLDS.exactRate)}，相差不超过 1 级至少 ${formatPercent(LEVEL_ACCURACY_THRESHOLDS.withinOneRate)}，平均绝对误差不超过 ${LEVEL_ACCURACY_THRESHOLDS.maximumMae}。`,
    `- 思维难度：完全一致 ${formatPercent(summary.thinkingAccuracy.exactRate)}，相差不超过 1 级 ${formatPercent(summary.thinkingAccuracy.withinOneRate)}，平均绝对误差 ${summary.thinkingAccuracy.mae}，${summary.thinkingAccuracy.passed ? "达标" : "未达标"}。`,
    `- 代码难度：完全一致 ${formatPercent(summary.codingAccuracy.exactRate)}，相差不超过 1 级 ${formatPercent(summary.codingAccuracy.withinOneRate)}，平均绝对误差 ${summary.codingAccuracy.mae}，${summary.codingAccuracy.passed ? "达标" : "未达标"}。`,
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
    "| 安全编号 | rating | 人工思维 | 模型思维 | 人工代码 | 模型代码 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...resultRows,
    "",
    "## 结论与后续",
    "",
    !summary.integrityClean
      ? "- 本实验链留下失败、取消、中断、跳过或陈旧在途证据；本链只保留为失败报告，不会继续发起新的付费阶段；合格标定必须使用全新标签从零运行。"
      : !summary.operationalComplete
        ? "- 本次有题目尚未完成，但实验链尚无失败证据；不能据此调整提示词、工作流或数值映射，请用同标签 --resume 继续。"
        : !summary.accuracyPassed
          ? "- 完整运行的准确性没有达到最低指标，需要调整提示词或处理步骤，并用全新标签重跑。"
          : "- 本次运行完整、实验链干净且达到人工标准最低指标，可以作为候选标定证据。",
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
    !calibrationSafeIdSchema.safeParse(input.datasetId).success ||
    !calibrationRunIdSchema.safeParse(input.chainRunId).success ||
    !calibrationRunIdSchema.safeParse(input.executionRunId).success ||
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
  failureCounts: readonly CalibrationFailureCount[],
  activeStages: readonly CalibrationActiveStage[]
): void {
  const progressKeys = progress.map(calibrationRowKey);
  const failureKeys = failureCounts.map(calibrationFailureCountKey);
  const activeKeys = activeStages.map(
    (active) => `${active.safeId}:${active.stage}`
  );
  if (
    new Set(progressKeys).size !== progressKeys.length ||
    new Set(failureKeys).size !== failureKeys.length ||
    new Set(activeKeys).size !== activeKeys.length
  ) {
    throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
  }
}

function buildAccuracyMetrics(
  values: readonly {
    readonly predicted: number;
    readonly expected: number;
  }[],
  canPass: boolean
): LevelAccuracyMetrics {
  if (values.length === 0) {
    return {
      count: 0,
      exactMatches: 0,
      exactRate: 0,
      withinOneMatches: 0,
      withinOneRate: 0,
      mae: 0,
      passed: false
    };
  }
  const errors = values.map((value) =>
    Math.abs(value.predicted - value.expected)
  );
  const exactMatches = errors.filter((error) => error === 0).length;
  const withinOneMatches = errors.filter((error) => error <= 1).length;
  const exactRate = exactMatches / values.length;
  const withinOneRate = withinOneMatches / values.length;
  const mae = errors.reduce((sum, error) => sum + error, 0) / values.length;
  return {
    count: values.length,
    exactMatches,
    exactRate: roundedMetric(exactRate),
    withinOneMatches,
    withinOneRate: roundedMetric(withinOneRate),
    mae: roundedMetric(mae),
    passed:
      canPass &&
      exactRate >= LEVEL_ACCURACY_THRESHOLDS.exactRate &&
      withinOneRate >= LEVEL_ACCURACY_THRESHOLDS.withinOneRate &&
      mae <= LEVEL_ACCURACY_THRESHOLDS.maximumMae
  };
}

function roundedMetric(value: number): number {
  return Number(value.toFixed(4));
}

function formatPercent(value: number): string {
  return `${Number((value * 100).toFixed(2))}%`;
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
