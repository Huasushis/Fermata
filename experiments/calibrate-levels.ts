/**
 * 思维难度 / 代码难度的标定实验。
 *
 * 背景：CF 难度有官方 rating 当基准，但思维难度、代码难度（1-5 级）没有外部
 * 标准答案。本脚本用一个跨难度的标定集做两件事：
 *   1. 把每一级的文字锚点定义固化进报告（评审时人人按同一把尺子）；
 *   2. 在标定集上真实跑 thinking / coding 两条流水线，检验“官方 rating 越高，
 *      两个等级的输出趋势是否单调上升”，并给出映射表是否需要调整的结论。
 *
 * 数据要求：experiments/data/levels/ 下的题目 JSON 必须带 editorial（标准题解），
 * 思维流水线要用它对比模型的解题思路。用下面命令抽标定集：
 *   DATA_SUBDIR=levels SAMPLE_SIZE_PER_BUCKET=1 npm run experiment:fetch-hf-dataset
 *
 * 用法：
 *   npm run experiment:calibrate-levels -- --label=v1
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getProviderCredentials, loadConfig, type ProfileConfig } from "../src/config";
import { logError, logInfo, logWarn } from "../src/logger";
import { runCodingPipeline } from "../src/pipelines/coding";
import { runThinkingPipeline } from "../src/pipelines/thinking";
import type { PipelineModelConfig, ReviewTaskProblem } from "../src/pipelines/types";
import { mapWithConcurrency } from "./lib/concurrency";
import { resolveLevelsCalibrationOptions } from "./lib/levels-calibration-options";

const DATA_DIR = new URL("./data/levels/", import.meta.url);
const RESULTS_DIR = new URL("./results/", import.meta.url);
const RAW_DIR = new URL("./results/raw/", import.meta.url);
/** 标定集按 rating 分成低/中/高三段，用于趋势判断。 */
const BAND_BOUNDARIES = [1400, 2200] as const;

const datasetItemSchema = z.object({
  contestId: z.number().int(),
  index: z.string().min(1),
  rating: z.number().int(),
  statement: z.string().min(1),
  editorial: z.string().min(1).nullable()
});

/** 各等级的文字锚点。修改这里必须同步修改 README 的“数值标准”一节并重跑本实验。 */
const levelAnchorDefinitions = {
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

const calibrationRowSchema = z.object({
  contestId: z.number().int(),
  index: z.string().min(1),
  rating: z.number().int(),
  thinkingLevel: z.number().int().min(1).max(5),
  thinkingSignals: z.record(z.string(), z.unknown()),
  codingLevel: z.number().int().min(1).max(5),
  codingSignals: z.record(z.string(), z.unknown())
});
type CalibrationRow = z.infer<typeof calibrationRowSchema>;

const savedRowsSchema = z.object({
  label: z.string(),
  profileName: z.string(),
  rows: z.array(calibrationRowSchema)
});

function loadCalibrationSet(): Array<z.infer<typeof datasetItemSchema>> {
  let fileNames: string[] = [];
  try {
    fileNames = readdirSync(DATA_DIR).filter((name) => name.endsWith(".json"));
  } catch {
    // 目录不存在时按空集处理，下面统一报错。
  }
  const items: Array<z.infer<typeof datasetItemSchema>> = [];
  for (const fileName of fileNames) {
    try {
      const raw = JSON.parse(readFileSync(new URL(fileName, DATA_DIR), "utf8")) as unknown;
      const parsed = datasetItemSchema.parse(raw);
      if (parsed.editorial !== null) {
        items.push(parsed);
      }
    } catch (error) {
      logWarn("跳过一个无法解析或缺少题解的标定文件", { fileName, reason: String(error).slice(0, 120) });
    }
  }
  return items.sort((left, right) => left.rating - right.rating);
}

function toProblem(item: z.infer<typeof datasetItemSchema>): ReviewTaskProblem {
  return {
    id: `calibration-${item.contestId}${item.index}`,
    revision: 1,
    reviewRound: 1,
    contentHash: createHash("sha256").update(item.statement, "utf8").digest("hex"),
    title: `CF${item.contestId}${item.index}`,
    type: "traditional",
    tagIds: ["calibration.sample"],
    basicStatement: item.statement,
    basicSolution: item.editorial ?? ""
  };
}

function bandOf(rating: number): "低" | "中" | "高" {
  if (rating < BAND_BOUNDARIES[0]) {
    return "低";
  }
  return rating < BAND_BOUNDARIES[1] ? "中" : "高";
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rowKey(value: Pick<CalibrationRow, "contestId" | "index">): string {
  return `${value.contestId}:${value.index}`;
}

function loadResumedRows(
  sourceLabel: string,
  profileName: string,
  allowedKeys: ReadonlySet<string>
): CalibrationRow[] {
  let fileNames: string[] = [];
  try {
    fileNames = readdirSync(RAW_DIR)
      .filter((name) => name.startsWith(`levels-${sourceLabel}-`) && name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }

  const rows = new Map<string, CalibrationRow>();
  for (const fileName of fileNames) {
    try {
      const saved = savedRowsSchema.parse(
        JSON.parse(readFileSync(new URL(fileName, RAW_DIR), "utf8")) as unknown
      );
      if (saved.label !== sourceLabel || saved.profileName !== profileName) {
        continue;
      }
      for (const row of saved.rows) {
        const key = rowKey(row);
        if (allowedKeys.has(key)) {
          rows.set(key, row);
        }
      }
    } catch (error) {
      logWarn("跳过一个无法复用的标定中间结果", {
        fileName,
        reason: String(error).slice(0, 120)
      });
    }
  }
  return [...rows.values()];
}

function writeJsonAtomically(target: URL, value: unknown): void {
  const targetPath = fileURLToPath(target);
  const temporaryPath = `${targetPath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  renameSync(temporaryPath, targetPath);
}

function writeCheckpoint(
  label: string,
  profileName: string,
  rows: readonly CalibrationRow[]
): void {
  writeJsonAtomically(new URL(`levels-${label}-checkpoint.json`, RAW_DIR), {
    label,
    profileName,
    rows
  });
}

async function main(): Promise<void> {
  const config = loadConfig({ env: process.env });
  const options = resolveLevelsCalibrationOptions({
    argv: process.argv.slice(2),
    env: process.env,
    configuredTimeoutMs: config.models.timeouts.llmRequestMs,
    configuredMaxAttempts: config.models.retry.maxAttempts
  });
  const label = options.label;
  const profileName = config.models.defaults.modelProfileName;
  const profiles: Record<string, ProfileConfig | undefined> = config.models.profiles;
  const profile = profiles[profileName];
  if (profile === undefined) {
    logError("默认模型档位不存在", undefined, { profileName });
    process.exitCode = 1;
    return;
  }

  const modelFor = (part: "solver" | "analyst" | "coding"): PipelineModelConfig | undefined => {
    const spec =
      part === "coding" ? profile.coding : part === "solver" ? profile.thinking.solver : profile.thinking.analyst;
    const credentials = getProviderCredentials(config, spec.provider);
    if (credentials === undefined) {
      logError("流水线的服务商没有配置密钥", undefined, { part, provider: spec.provider });
      return undefined;
    }
    return {
      spec,
      credentials,
      runtime: {
        timeoutMs: options.requestTimeoutMs,
        maxAttempts: options.maxAttempts,
        baseDelayMs: config.models.retry.baseDelayMs
      }
    };
  };
  const solverModel = modelFor("solver");
  const analystModel = modelFor("analyst");
  const codingModel = modelFor("coding");
  if (solverModel === undefined || analystModel === undefined || codingModel === undefined) {
    process.exitCode = 1;
    return;
  }

  const calibrationSet = loadCalibrationSet();
  if (calibrationSet.length === 0) {
    logError(
      "标定集为空。请先运行：DATA_SUBDIR=levels SAMPLE_SIZE_PER_BUCKET=1 npm run experiment:fetch-hf-dataset",
      undefined
    );
    process.exitCode = 1;
    return;
  }
  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(RAW_DIR, { recursive: true });
  const allowedKeys = new Set(calibrationSet.map(rowKey));
  const resumedRows =
    options.resumeFromLabel === null
      ? []
      : loadResumedRows(options.resumeFromLabel, profileName, allowedKeys);
  const rowsByKey = new Map(resumedRows.map((row) => [rowKey(row), row]));
  const pendingItems = calibrationSet.filter((item) => !rowsByKey.has(rowKey(item)));
  writeCheckpoint(label, profileName, [...rowsByKey.values()]);

  logInfo("开始标定", {
    label,
    problems: calibrationSet.length,
    reusedProblems: resumedRows.length,
    pendingProblems: pendingItems.length,
    profileName,
    requestTimeoutMs: options.requestTimeoutMs,
    maxAttempts: options.maxAttempts
  });

  const concurrency = Number.parseInt(process.env.EVAL_CONCURRENCY ?? "4", 10);
  let done = resumedRows.length;
  const settled = await mapWithConcurrency(pendingItems, concurrency, async (item) => {
    const problem = toProblem(item);
    try {
      const thinking = await runThinkingPipeline({ problem, solverModel, analystModel });
      const coding = await runCodingPipeline({ problem, model: codingModel });
      const row = {
        contestId: item.contestId,
        index: item.index,
        rating: item.rating,
        thinkingLevel: thinking.level,
        thinkingSignals: thinking.signals as unknown as Record<string, unknown>,
        codingLevel: coding.level,
        codingSignals: coding.signals as unknown as Record<string, unknown>
      } satisfies CalibrationRow;
      rowsByKey.set(rowKey(row), row);
      writeCheckpoint(label, profileName, [...rowsByKey.values()]);
      done += 1;
      logInfo("已完成一题", {
        contestId: item.contestId,
        index: item.index,
        rating: item.rating,
        thinkingLevel: thinking.level,
        codingLevel: coding.level,
        progress: `${done}/${calibrationSet.length}`
      });
      return row;
    } catch (error) {
      done += 1;
      logError("这一题标定失败，跳过", error, {
        contestId: item.contestId,
        index: item.index,
        progress: `${done}/${calibrationSet.length}`
      });
      return null;
    }
  });
  const completedThisRun = settled.filter(
    (value): value is CalibrationRow => value !== null
  );
  const rows = [...rowsByKey.values()].sort((left, right) => left.rating - right.rating);

  if (rows.length === 0) {
    logError("没有任何题目完成标定。", undefined);
    process.exitCode = 1;
    return;
  }

  const bands = new Map<string, CalibrationRow[]>();
  for (const row of rows) {
    const band = bandOf(row.rating);
    bands.set(band, [...(bands.get(band) ?? []), row]);
  }
  const bandSummaries = ["低", "中", "高"].map((band) => {
    const bandRows = bands.get(band) ?? [];
    return {
      band,
      count: bandRows.length,
      averageThinking: Number(average(bandRows.map((row) => row.thinkingLevel)).toFixed(2)),
      averageCoding: Number(average(bandRows.map((row) => row.codingLevel)).toFixed(2))
    };
  });
  const allBandsPresent = bandSummaries.every((summary) => summary.count > 0);
  const monotonicThinking =
    allBandsPresent && isNonDecreasing(bandSummaries.map((summary) => summary.averageThinking));
  const monotonicCoding =
    allBandsPresent && isNonDecreasing(bandSummaries.map((summary) => summary.averageCoding));
  const incompleteProblemCount = calibrationSet.length - rows.length;
  const complete = incompleteProblemCount === 0;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeJsonAtomically(new URL(`levels-${label}-${stamp}.json`, RAW_DIR), {
    label,
    profileName,
    rows
  });

  const summary = {
    label,
    profileName,
    problemCount: rows.length,
    expectedProblemCount: calibrationSet.length,
    resumedProblemCount: resumedRows.length,
    completedThisRun: completedThisRun.length,
    incompleteProblemCount,
    complete,
    bandSummaries,
    monotonicThinking,
    monotonicCoding,
    generatedAt: new Date().toISOString()
  };
  writeJsonAtomically(new URL(`levels-${label}-summary.json`, RESULTS_DIR), summary);

  const markdown = [
    `# 思维/代码难度标定报告（${label}）`,
    "",
    `- 模型档位：${profileName}`,
    `- 已完成题数：${rows.length} / ${calibrationSet.length}（按官方 rating 升序）`,
    `- 从已有中间结果复用：${resumedRows.length}`,
    `- 本次仍未完成：${incompleteProblemCount}`,
    `- 生成时间：${summary.generatedAt}`,
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
    ...bandSummaries.map(
      (band) => `| ${band.band} | ${band.count} | ${band.averageThinking} | ${band.averageCoding} |`
    ),
    "",
    `- 思维难度随 rating 分段单调不降：${complete && allBandsPresent ? (monotonicThinking ? "是" : "否") : "结果不完整，不能判断"}`,
    `- 代码难度随 rating 分段单调不降：${complete && allBandsPresent ? (monotonicCoding ? "是" : "否") : "结果不完整，不能判断"}`,
    "",
    "## 逐题结果",
    "",
    "| 题目 | rating | 思维 | 代码 |",
    "| --- | --- | --- | --- |",
    ...rows.map(
      (row) => `| CF${row.contestId}${row.index} | ${row.rating} | ${row.thinkingLevel} | ${row.codingLevel} |`
    ),
    "",
    "## 结论与后续",
    "",
    !complete
      ? "- 本次结果不完整，不能据此调整提示词、工作流或数值映射；请用 --resume 继续补齐。"
      : monotonicThinking && monotonicCoding
        ? "- 当前映射表在标定集上呈单调趋势，可作为初始标准启用；扩大样本后再复核。"
        : "- 当前映射表在完整标定集上出现非单调段，需要先分析逐题误差，再调整对应流水线并重跑实验。",
    "- 修改任何映射常量后，必须以新的 --label 重跑本脚本并保留两份报告做对比。"
  ].join("\n");
  const reportPath = new URL(`levels-${label}-report.md`, RESULTS_DIR);
  const reportTemporaryPath = `${fileURLToPath(reportPath)}.tmp`;
  writeFileSync(reportTemporaryPath, markdown, "utf8");
  renameSync(reportTemporaryPath, fileURLToPath(reportPath));
  if (!complete) {
    logWarn("标定结果不完整，报告仅供续跑定位，不能用于调整算法", {
      label,
      problems: rows.length,
      expectedProblems: calibrationSet.length,
      incompleteProblemCount
    });
    process.exitCode = 1;
    return;
  }
  logInfo("标定完成", {
    label,
    problems: rows.length,
    monotonicThinking,
    monotonicCoding
  });
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

main().catch((error) => {
  logError("experiments/calibrate-levels.ts 执行失败", error);
  process.exitCode = 1;
});
