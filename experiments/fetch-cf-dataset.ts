/**
 * 拉取一个 Codeforces 数据集，供 eval-difficulty.ts（难度评定误差评测）和
 * calibrate-anchors.ts（锚点标定）使用。
 *
 * 规则：只取最近 24 个月内开始的比赛，按 rating 800-3500 每 100 一档，每档
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
import { logError, logInfo } from "../src/logger";
import {
  codeforcesDatasetFileName,
  fetchCodeforcesDatasetBatchFailClosed,
  parseCodeforcesDatasetSampleSize,
  requireCompleteCodeforcesRatingBuckets,
  requireRecentContestIds
} from "./lib/recent-contest-policy";

const RATING_MIN = 800;
const RATING_MAX = 3500;
const RATING_STEP = 100;
const MONTHS_BACK = 24;
const DEFAULT_SAMPLE_SIZE_PER_BUCKET = 3;
const MINIMUM_REQUEST_INTERVAL_MS = 2_100;
const OUTPUT_DIR = new URL("./data/cf/", import.meta.url);

const contestListItemSchema = z.object({
  id: z.number().int().positive().max(2_147_483_647),
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
  const sampleSizePerBucket = parseCodeforcesDatasetSampleSize(
    process.env.SAMPLE_SIZE_PER_BUCKET,
    DEFAULT_SAMPLE_SIZE_PER_BUCKET
  );
  const client = new CodeforcesClient({
    credentials: readCodeforcesCredentials(),
    minimumRequestIntervalMs: MINIMUM_REQUEST_INTERVAL_MS,
    requestTimeoutMs: 15_000
  });

  const cutoffSeconds = Math.floor(Date.now() / 1000) - MONTHS_BACK * 30 * 24 * 60 * 60;

  logInfo("拉取比赛列表以确定最近 24 个月的范围");
  let recentContestIds: ReadonlySet<number>;
  try {
    recentContestIds = requireRecentContestIds(
      await fetchRecentContestIds(client, cutoffSeconds)
    );
  } catch (error) {
    logError("最近比赛范围不可用，停止抓取，不会退化为全部年代", error);
    process.exitCode = 1;
    return;
  }

  logInfo("拉取题目列表");
  const problems = await client.fetchProblemsetProblems();

  // 在任何题面请求、建目录或写文件之前，一次性验证所有可能进入文件名的外部身份。
  // 发现一条异常身份就整批失败，绝不跳过后继续生成一个看似完整的数据集。
  const validatedProblems = problems.map((problem) => ({
    problem,
    fileName:
      problem.contestId === undefined
        ? undefined
        : codeforcesDatasetFileName(problem.contestId, problem.index)
  }));

  const buckets = new Map<
    number,
    { contestId: number; index: string; rating: number; fileName: string }[]
  >();
  for (const { problem, fileName } of validatedProblems) {
    if (problem.contestId === undefined || problem.rating === undefined) {
      continue;
    }
    const verifiedFileName =
      fileName ?? codeforcesDatasetFileName(problem.contestId, problem.index);
    if (problem.rating < RATING_MIN || problem.rating > RATING_MAX) {
      continue;
    }
    if (!recentContestIds.has(problem.contestId)) {
      continue;
    }
    const bucket = bucketFor(problem.rating);
    const list = buckets.get(bucket) ?? [];
    list.push({
      contestId: problem.contestId,
      index: problem.index,
      rating: problem.rating,
      fileName: verifiedFileName
    });
    buckets.set(bucket, list);
  }

  const expectedRatings = Array.from(
    { length: Math.floor((RATING_MAX - RATING_MIN) / RATING_STEP) + 1 },
    (_, index) => RATING_MIN + index * RATING_STEP
  );
  requireCompleteCodeforcesRatingBuckets({
    candidateCounts: new Map(
      [...buckets].map(([rating, candidates]) => [rating, candidates.length] as const)
    ),
    expectedRatings,
    sampleSizePerBucket
  });
  const selected = expectedRatings.flatMap((rating) =>
    pickRandomSample(buckets.get(rating)!, sampleSizePerBucket)
  );
  const records = await fetchCodeforcesDatasetBatchFailClosed({
    items: selected,
    fetchOne: (problem) =>
      client.fetchProblemStatement(problem.contestId, problem.index)
  });

  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const { item: problem, value: statement } of records) {
    const record = {
      contestId: problem.contestId,
      index: problem.index,
      rating: problem.rating,
      statement
    };
    writeFileSync(
      new URL(problem.fileName, OUTPUT_DIR),
      JSON.stringify(record, null, 2),
      "utf8"
    );
  }
  logInfo("抓取完成", { fetched: records.length, expected: selected.length });
}

main().catch((error: unknown) => {
  logError("experiments/fetch-cf-dataset.ts 执行失败", error);
  process.exitCode = 1;
});
