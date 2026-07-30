/**
 * 从 experiments/fetch-cf-dataset.ts 抓下来的数据集里，按难度均匀挑一批锚点题，
 * 用 LLM 生成简短摘要（不逐字照抄题面），写出 config/anchors/difficulty.json，
 * 供 difficulty 流水线做少样本参照。
 *
 * 会覆盖 config/anchors/difficulty.json 里现有的手工占位数据，并把 provisional
 * 改成 false（因为这次是从真实数据集生成的）。
 *
 * 用法：
 *   npm run experiment:calibrate-anchors
 *   ANCHOR_COUNT=8 npm run experiment:calibrate-anchors
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { getProviderCredentials, loadConfig, type ProfileConfig, type ProviderCredentials } from "../src/config";
import { chatComplete, type ChatMessage } from "../src/llm";
import { logError, logInfo, logWarn } from "../src/logger";

// 锚点应来自独立于评估集的数据（DATA_SUBDIR=levels），避免 few-shot 里
// 出现评估题本身；eval-difficulty 里还有按锚点排除的双保险。
const DATA_SUBDIR = process.env.DATA_SUBDIR ?? "cf";
const DATA_DIR = new URL(`./data/${DATA_SUBDIR}/`, import.meta.url);
const ANCHORS_FILE = new URL("../config/anchors/difficulty.json", import.meta.url);
const ANCHOR_COUNT = Number.parseInt(process.env.ANCHOR_COUNT ?? "7", 10);
const RATING_MIN = 800;
const RATING_MAX = 3500;

const datasetItemSchema = z.object({
  contestId: z.number().int(),
  index: z.string().min(1),
  rating: z.number().int(),
  statement: z.string().min(1)
});

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
      logError("跳过一个无法解析的数据集文件", error);
    }
  }
  return items;
}

/** 在 [RATING_MIN, RATING_MAX] 里均匀选 count 个目标难度点。 */
function pickTargetRatings(count: number): number[] {
  if (count <= 1) {
    return [RATING_MIN];
  }
  const step = (RATING_MAX - RATING_MIN) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round((RATING_MIN + i * step) / 100) * 100);
}

/** 为每个目标难度点，从数据集里选一道 rating 最接近它的题（选过的不会重复选）。 */
function selectAnchorCandidates(
  dataset: readonly z.infer<typeof datasetItemSchema>[],
  targetRatings: readonly number[]
): Array<z.infer<typeof datasetItemSchema>> {
  const used = new Set<string>();
  const selected: Array<z.infer<typeof datasetItemSchema>> = [];
  for (const target of targetRatings) {
    let best: z.infer<typeof datasetItemSchema> | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const item of dataset) {
      const key = `${item.contestId}${item.index}`;
      if (used.has(key)) {
        continue;
      }
      const distance = Math.abs(item.rating - target);
      if (distance < bestDistance) {
        best = item;
        bestDistance = distance;
      }
    }
    if (best !== undefined) {
      used.add(`${best.contestId}${best.index}`);
      selected.push(best);
    } else {
      logWarn("这个目标难度附近没有找到还没被选过的候选题", { target });
    }
  }
  return selected;
}

async function summarize(
  statement: string,
  profile: ProfileConfig,
  credentials: ProviderCredentials,
  runtime: { timeoutMs: number; maxAttempts: number; baseDelayMs: number }
): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "请用一句中文话概括下面这道算法竞赛题目在考什么、大致的解法方向，不要逐字复述题面原文，" +
        "不要超过 80 个字，只输出这一句话本身。"
    },
    { role: "user", content: statement }
  ];
  const result = await chatComplete(credentials, profile.difficulty, messages, runtime);
  return result.content.trim();
}

async function main(): Promise<void> {
  const config = loadConfig();
  const dataset = loadDataset();
  if (dataset.length === 0) {
    logError("没有找到数据集，先运行 npm run experiment:fetch-cf-dataset", undefined, {
      dataDir: DATA_DIR.pathname
    });
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

  const targetRatings = pickTargetRatings(ANCHOR_COUNT);
  const candidates = selectAnchorCandidates(dataset, targetRatings);

  const runtime = {
    timeoutMs: config.models.timeouts.llmRequestMs,
    maxAttempts: config.models.retry.maxAttempts,
    baseDelayMs: config.models.retry.baseDelayMs
  };

  const anchors: Array<{ contestId: number; index: string; rating: number; summary: string }> = [];
  for (const candidate of candidates) {
    try {
      const summary = await summarize(candidate.statement, profile, credentials, runtime);
      anchors.push({ contestId: candidate.contestId, index: candidate.index, rating: candidate.rating, summary });
      logInfo("生成一条锚点", { contestId: candidate.contestId, index: candidate.index, rating: candidate.rating });
    } catch (error) {
      logError("生成锚点摘要失败，跳过这一题", error, { contestId: candidate.contestId, index: candidate.index });
    }
  }

  if (anchors.length === 0) {
    logError("没有成功生成任何锚点，不覆盖现有文件", undefined);
    process.exitCode = 1;
    return;
  }

  const payload = {
    provisional: false,
    note:
      `由 experiments/calibrate-anchors.ts 于 ${new Date().toISOString()} 从 ${dataset.length} 道题的数据集中` +
      "生成，摘要由 LLM 概括。数据集本身会随实际抓取时间/样本变化，如果难度评定表现明显偏离预期，" +
      "应该重新跑一遍生成脚本。",
    anchors
  };
  writeFileSync(ANCHORS_FILE, JSON.stringify(payload, null, 2) + "\n", "utf8");
  logInfo("已写入锚点文件", { count: anchors.length, path: ANCHORS_FILE.pathname });
}

main().catch((error: unknown) => {
  logError("experiments/calibrate-anchors.ts 执行失败", error);
  process.exitCode = 1;
});
