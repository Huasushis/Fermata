/**
 * 拉取一个 Codeforces 数据集，供 eval-difficulty.ts（难度评定误差评测）和
 * calibrate-anchors.ts（锚点标定）使用。
 *
 * 规则：只取最近 24 个月内开始的比赛，按 rating 800-3500 每 200 一档，每档
 * 随机抽 SAMPLE_SIZE_PER_BUCKET 道（默认 3），抓题面存成
 * experiments/data/cf/{contestId}{index}.json。
 *
 * 这些数据文件不入库（见 .gitignore 和 AGENTS.md）：里面是完整题面，属于公开
 * 数据，但报告和代码里都只应该引用题号（contestId+index），不应该把题面原文
 * 提交进版本库。
 *
 * 用法：
 *   npm run experiment:fetch-cf-dataset
 *   SAMPLE_SIZE_PER_BUCKET=5 npm run experiment:fetch-cf-dataset
 *
 * 需要的环境变量都是可选的：配置了 CODEFORCES_KEY/CODEFORCES_SECRET 就走签名
 * 请求，没配置就走匿名请求（更容易被限流，抓取会更慢）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { CodeforcesClient, type CodeforcesCredentials } from "../src/codeforces";
import { logError, logInfo, logWarn } from "../src/logger";

const RATING_MIN = 800;
const RATING_MAX = 3500;
const RATING_STEP = 100;
const MONTHS_BACK = 24;
const SAMPLE_SIZE_PER_BUCKET = Number.parseInt(process.env.SAMPLE_SIZE_PER_BUCKET ?? "3", 10);
const MINIMUM_REQUEST_INTERVAL_MS = 2_100;
const OUTPUT_DIR = new URL("./data/cf/", import.meta.url);

const contestListItemSchema = z.object({
  id: z.number().int(),
  phase: z.string(),
  startTimeSeconds: z.number().int().optional()
});
const contestListResultSchema = z.array(contestListItemSchema);

function readCodeforcesCredentials(): CodeforcesCredentials | undefined {
  const key = process.env.CODEFORCES_KEY;
  const secret = process.env.CODEFORCES_SECRET;
  if (key === undefined || secret === undefined || key.length === 0 || secret.length === 0) {
    return undefined;
  }
  return { key, secret };
}

async function fetchRecentContestIds(client: CodeforcesClient, cutoffSeconds: number): Promise<Set<number>> {
  const contests = await client.callMethod("contest.list", { gym: "false" }, contestListResultSchema);
  const recent = contests.filter(
    (contest) => contest.phase === "FINISHED" && (contest.startTimeSeconds ?? 0) >= cutoffSeconds
  );
  return new Set(recent.map((contest) => contest.id));
}

function pickRandomSample<T>(items: readonly T[], size: number): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = shuffled[i];
    const b = shuffled[j];
    if (a !== undefined && b !== undefined) {
      shuffled[i] = b;
      shuffled[j] = a;
    }
  }
  return shuffled.slice(0, size);
}

function bucketFor(rating: number): number {
  return Math.min(RATING_MAX, Math.max(RATING_MIN, Math.round(rating / RATING_STEP) * RATING_STEP));
}

async function main(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const client = new CodeforcesClient({
    credentials: readCodeforcesCredentials(),
    minimumRequestIntervalMs: MINIMUM_REQUEST_INTERVAL_MS,
    requestTimeoutMs: 15_000
  });

  const cutoffSeconds = Math.floor(Date.now() / 1000) - MONTHS_BACK * 30 * 24 * 60 * 60;

  logInfo("拉取比赛列表以确定最近 24 个月的范围");
  let recentContestIds: Set<number>;
  try {
    recentContestIds = await fetchRecentContestIds(client, cutoffSeconds);
  } catch (error) {
    logWarn("拉取比赛列表失败，退化为不按时间筛选（所有比赛都算在内）", { reason: describeError(error) });
    recentContestIds = new Set();
  }
  const filterByRecency = recentContestIds.size > 0;

  logInfo("拉取题目列表");
  const problems = await client.fetchProblemsetProblems();

  const buckets = new Map<number, { contestId: number; index: string; rating: number }[]>();
  for (const problem of problems) {
    if (problem.contestId === undefined || problem.rating === undefined) {
      continue;
    }
    if (problem.rating < RATING_MIN || problem.rating > RATING_MAX) {
      continue;
    }
    if (filterByRecency && !recentContestIds.has(problem.contestId)) {
      continue;
    }
    const bucket = bucketFor(problem.rating);
    const list = buckets.get(bucket) ?? [];
    list.push({ contestId: problem.contestId, index: problem.index, rating: problem.rating });
    buckets.set(bucket, list);
  }

  let fetched = 0;
  let failed = 0;
  for (let rating = RATING_MIN; rating <= RATING_MAX; rating += RATING_STEP) {
    const candidates = buckets.get(rating) ?? [];
    if (candidates.length === 0) {
      logWarn("这一档没有找到候选题目，跳过", { rating });
      continue;
    }
    const sample = pickRandomSample(candidates, SAMPLE_SIZE_PER_BUCKET);
    for (const problem of sample) {
      try {
        const statement = await client.fetchProblemStatement(problem.contestId, problem.index);
        const record = {
          contestId: problem.contestId,
          index: problem.index,
          rating: problem.rating,
          statement
        };
        const fileName = `${problem.contestId}${problem.index}.json`;
        writeFileSync(new URL(fileName, OUTPUT_DIR), JSON.stringify(record, null, 2), "utf8");
        fetched += 1;
        logInfo("已抓取题面", { contestId: problem.contestId, index: problem.index, rating: problem.rating });
      } catch (error) {
        failed += 1;
        logError("抓取题面失败，跳过这一题", error, { contestId: problem.contestId, index: problem.index });
      }
    }
  }

  logInfo("抓取完成", { fetched, failed, outputDir: OUTPUT_DIR.pathname });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  logError("experiments/fetch-cf-dataset.ts 执行失败", error);
  process.exitCode = 1;
});
