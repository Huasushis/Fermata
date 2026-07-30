/**
 * 对 experiments/fetch-cf-dataset.ts 抓下来的数据集跑一遍 difficulty 流水线，
 * 输出每题的预测难度、真实难度、误差，并汇总 MAE、±200 命中率、分档统计。
 *
 * 已知的局限：Codeforces 官方题解（editorial）通常是单独的论坛帖子，没有稳定
 * 好抓的结构化格式，所以这里没有单独抓官方题解——每道题的"题解"字段是一句
 * 说明性占位文字，评测出来的是"只看题面"这种情况下的难度评定表现，比正式
 * 使用（投稿人会同时提供题面和题解）更难一些。这个差异应该写进调优报告里，
 * 不要直接拿这个数字当成正式使用时的准确率。
 *
 * 输出两份东西：
 *   - experiments/results/raw/difficulty-{标签}-{时间戳}.json：每题详细信息，
 *     含 LLM 给出的 rationale 全文——不入库（results/raw 整个被 .gitignore）。
 *   - experiments/results/difficulty-{标签}-summary.json 和 .md：汇总统计 +
 *     每题的题号/预测/真实/误差/置信度，不含题面或 rationale 全文——这两份
 *     入库，供调优报告引用。
 *
 * 用法：
 *   npm run experiment:eval-difficulty -- --label=baseline
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { getProviderCredentials, loadConfig, type ProfileConfig } from "../src/config";
import { logError, logInfo } from "../src/logger";
import { clampAndRoundDifficultyRating, loadDifficultyAnchors, runDifficultyPipeline } from "../src/pipelines/difficulty";
import { mapWithConcurrency } from "./lib/concurrency";

import type { ReviewTaskProblem } from "../src/pipelines/types";

const DATA_DIR = new URL("./data/cf/", import.meta.url);
const RESULTS_DIR = new URL("./results/", import.meta.url);
const RAW_RESULTS_DIR = new URL("./results/raw/", import.meta.url);

const NO_SOLUTION_PLACEHOLDER =
  "（实验数据集没有单独抓取官方题解——Codeforces 编辑注解通常是独立论坛帖子，没有稳定的结构化格式可抓。" +
  "这次评测只依据题面本身判断难度，比正式使用时更难，结果仅供参考。）";

const datasetItemSchema = z.object({
  contestId: z.number().int(),
  index: z.string().min(1),
  rating: z.number().int(),
  statement: z.string().min(1)
});

interface EvalRow {
  readonly contestId: number;
  readonly index: string;
  readonly actualRating: number;
  readonly predictedRating: number;
  readonly error: number;
  readonly confidence: number;
}

function parseLabelArg(): string {
  const arg = process.argv.find((value) => value.startsWith("--label="));
  return arg?.slice("--label=".length) ?? "baseline";
}

function loadDataset(): Array<z.infer<typeof datasetItemSchema>> {
  let fileNames: string[];
  try {
    fileNames = readdirSync(DATA_DIR).filter((name) => name.endsWith(".json"));
  } catch {
    fileNames = [];
  }
  const items: Array<z.infer<typeof datasetItemSchema>> = [];
  for (const fileName of fileNames) {
    try {
      const raw = JSON.parse(readFileSync(new URL(fileName, DATA_DIR), "utf8")) as unknown;
      items.push(datasetItemSchema.parse(raw));
    } catch (error) {
      logError("跳过一个无法解析的数据集文件", error, { fileName });
    }
  }
  return items;
}

function toReviewTaskProblem(item: z.infer<typeof datasetItemSchema>): ReviewTaskProblem {
  return {
    id: `cf-${item.contestId}${item.index}`,
    revision: 1,
    reviewRound: 1,
    contentHash: "0".repeat(64),
    title: `CF ${item.contestId}${item.index}`,
    type: "traditional",
    tagIds: ["experiment"],
    basicStatement: item.statement,
    basicSolution: NO_SOLUTION_PLACEHOLDER
  };
}

function summarize(rows: readonly EvalRow[]): {
  readonly count: number;
  readonly meanAbsoluteError: number;
  readonly hitRateWithin200: number;
  readonly byBucket: Record<number, { count: number; meanAbsoluteError: number }>;
} {
  if (rows.length === 0) {
    return { count: 0, meanAbsoluteError: 0, hitRateWithin200: 0, byBucket: {} };
  }
  const absoluteErrors = rows.map((row) => Math.abs(row.error));
  const meanAbsoluteError = absoluteErrors.reduce((sum, value) => sum + value, 0) / rows.length;
  const within200 = rows.filter((row) => Math.abs(row.error) <= 200).length;
  const hitRateWithin200 = within200 / rows.length;

  const byBucket: Record<number, { count: number; meanAbsoluteError: number }> = {};
  const grouped = new Map<number, EvalRow[]>();
  for (const row of rows) {
    const bucket = Math.round(row.actualRating / 100) * 100;
    const list = grouped.get(bucket) ?? [];
    list.push(row);
    grouped.set(bucket, list);
  }
  for (const [bucket, list] of grouped) {
    const bucketErrors = list.map((row) => Math.abs(row.error));
    byBucket[bucket] = {
      count: list.length,
      meanAbsoluteError: bucketErrors.reduce((sum, value) => sum + value, 0) / list.length
    };
  }

  return { count: rows.length, meanAbsoluteError, hitRateWithin200, byBucket };
}

function renderMarkdown(label: string, summary: ReturnType<typeof summarize>, rows: readonly EvalRow[]): string {
  const lines: string[] = [];
  lines.push(`# 难度评定误差评测：${label}`);
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push("");
  lines.push(`- 样本数：${summary.count}`);
  lines.push(`- MAE（平均绝对误差）：${summary.meanAbsoluteError.toFixed(1)}`);
  lines.push(`- ±200 命中率：${(summary.hitRateWithin200 * 100).toFixed(1)}%`);
  lines.push("");
  lines.push("## 分档统计");
  lines.push("");
  lines.push("| 难度档 | 样本数 | MAE |");
  lines.push("| --- | --- | --- |");
  for (const bucket of Object.keys(summary.byBucket).map(Number).sort((a, b) => a - b)) {
    const stats = summary.byBucket[bucket];
    if (stats !== undefined) {
      lines.push(`| ${bucket} | ${stats.count} | ${stats.meanAbsoluteError.toFixed(1)} |`);
    }
  }
  lines.push("");
  lines.push("## 逐题结果");
  lines.push("");
  lines.push("| 题号 | 真实难度 | 预测难度 | 误差 | 置信度 |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const row of rows) {
    lines.push(
      `| CF ${row.contestId}${row.index} | ${row.actualRating} | ${row.predictedRating} | ${row.error} | ${row.confidence.toFixed(2)} |`
    );
  }
  lines.push("");
  lines.push(
    "> 注意：本次评测的题解字段是占位文字（见脚本头部说明），比正式使用时（有真实题解）更难，结果仅供参考。"
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const label = parseLabelArg();
  const config = loadConfig();
  const anchors = loadDifficultyAnchors();
  // 锚点题绝不能同时出现在评估集里：few-shot 里已经见过原题和真实难度，
  // 评出来的误差会虚假地偏低。这里按 contestId+index 精确排除。
  const anchorKeys = new Set(anchors.map((anchor) => `${anchor.contestId}#${anchor.index}`));
  const rawDataset = loadDataset();
  const dataset = rawDataset.filter(
    (item) => !anchorKeys.has(`${item.contestId}#${item.index}`)
  );
  if (dataset.length < rawDataset.length) {
    logInfo("已从评估集中排除锚点题", { excluded: rawDataset.length - dataset.length });
  }

  if (dataset.length === 0) {
    logError(
      "没有找到数据集，先运行 npm run experiment:fetch-cf-dataset",
      undefined,
      { dataDir: DATA_DIR.pathname }
    );
    process.exitCode = 1;
    return;
  }

  const profileName = config.models.defaults.modelProfileName;
  const profiles: Record<string, ProfileConfig | undefined> = config.models.profiles;
  const profile = profiles[profileName];
  if (profile === undefined) {
    logError("默认模型档位不存在，检查 config/models.yaml", undefined, { profileName });
    process.exitCode = 1;
    return;
  }
  const credentials = getProviderCredentials(config, profile.difficulty.provider);
  if (credentials === undefined) {
    logError("difficulty 流水线的 provider 没有配置密钥", undefined, { provider: profile.difficulty.provider });
    process.exitCode = 1;
    return;
  }

  const concurrency = Number.parseInt(process.env.EVAL_CONCURRENCY ?? "6", 10);
  const model = {
    spec: profile.difficulty,
    credentials,
    runtime: {
      timeoutMs: config.models.timeouts.llmRequestMs,
      maxAttempts: config.models.retry.maxAttempts,
      baseDelayMs: config.models.retry.baseDelayMs
    }
  };
  let done = 0;
  const settled = await mapWithConcurrency(dataset, concurrency, async (item) => {
    const problem = toReviewTaskProblem(item);
    try {
      const result = await runDifficultyPipeline({ problem, anchors, model });
      const predictedRating = clampAndRoundDifficultyRating(result.rating);
      const row: EvalRow = {
        contestId: item.contestId,
        index: item.index,
        actualRating: item.rating,
        predictedRating,
        error: predictedRating - item.rating,
        confidence: result.confidence
      };
      done += 1;
      logInfo("完成一题的难度评定", {
        contestId: item.contestId,
        index: item.index,
        error: row.error,
        progress: `${done}/${dataset.length}`
      });
      return { ...row, rationale: result.rationale };
    } catch (error) {
      done += 1;
      logError("这一题的难度评定失败，跳过", error, {
        contestId: item.contestId,
        index: item.index,
        progress: `${done}/${dataset.length}`
      });
      return null;
    }
  });
  const rawRows: Array<EvalRow & { rationale: string }> = settled.filter(
    (value): value is EvalRow & { rationale: string } => value !== null
  );
  const rows: EvalRow[] = rawRows.map(({ rationale: _rationale, ...row }) => row);

  const summary = summarize(rows);

  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(RAW_RESULTS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(new URL(`difficulty-${label}-${timestamp}.json`, RAW_RESULTS_DIR), JSON.stringify(rawRows, null, 2), "utf8");
  writeFileSync(new URL(`difficulty-${label}-summary.json`, RESULTS_DIR), JSON.stringify({ label, summary, rows }, null, 2), "utf8");
  writeFileSync(new URL(`difficulty-${label}.md`, RESULTS_DIR), renderMarkdown(label, summary, rows), "utf8");

  logInfo("评测完成", {
    label,
    count: summary.count,
    meanAbsoluteError: summary.meanAbsoluteError,
    hitRateWithin200: summary.hitRateWithin200
  });
}

main().catch((error: unknown) => {
  logError("experiments/eval-difficulty.ts 执行失败", error);
  process.exitCode = 1;
});
