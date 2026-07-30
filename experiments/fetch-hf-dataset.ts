/**
 * 从 HuggingFace 公开数据集 open-r1/codeforces（CC-BY-4.0）抽样构建难度评定数据集。
 *
 * 背景：服务器网络可以访问 Codeforces 的 API，但题面网页被 Cloudflare 拦截，
 * 逐页抓取行不通。该公开数据集包含题面文本与官方 rating，通过 hf-mirror.com
 * 镜像下载，read 时用 HTTP Range 只取需要的列，不必下载整个分片。
 *
 * 输出与 fetch-cf-dataset.ts 完全相同的格式（experiments/data/cf/{id}.json：
 * contestId/index/rating/statement），eval-difficulty.ts 不需要任何改动。
 *
 * 用法：
 *   SAMPLE_SIZE_PER_BUCKET=3 npm run experiment:fetch-hf-dataset
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { asyncBufferFromUrl, parquetReadObjects } from "hyparquet";
import { z } from "zod";
import { logError, logInfo, logWarn } from "../src/logger";

const RATING_MIN = 800;
const RATING_MAX = 3500;
const RATING_STEP = 100;
const MINIMUM_CONTEST_YEAR = 2023;
const SAMPLE_SIZE_PER_BUCKET = Number.parseInt(process.env.SAMPLE_SIZE_PER_BUCKET ?? "3", 10);
const PARQUET_URL =
  process.env.HF_PARQUET_URL ??
  "https://hf-mirror.com/datasets/open-r1/codeforces/resolve/main/data/test-00000-of-00001.parquet";
// DATA_SUBDIR 允许把不同用途的抽样分开存（评估集 cf、难度等级标定集 levels 等），
// 避免一次重抽覆盖掉正在使用的评估集。
const DATA_SUBDIR = process.env.DATA_SUBDIR ?? "cf";
const OUTPUT_DIR = new URL(`./data/${DATA_SUBDIR}/`, import.meta.url);

const rowSchema = z.object({
  contest_id: z.coerce.number().int().positive(),
  index: z.string().min(1).max(8),
  contest_start_year: z.coerce.number().int().nullable().optional(),
  rating: z.coerce.number().int().nullable().optional(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  input_format: z.string().nullable().optional(),
  output_format: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  editorial: z.string().nullable().optional()
});

interface Candidate {
  readonly contestId: number;
  readonly index: string;
  readonly rating: number;
  readonly statement: string;
  readonly editorial: string | null;
}

function buildStatement(row: z.infer<typeof rowSchema>): string {
  const sections: string[] = [];
  if (row.title) {
    sections.push(`# ${row.title}`);
  }
  if (row.description) {
    sections.push(row.description);
  }
  if (row.input_format) {
    sections.push(`## 输入格式\n${row.input_format}`);
  }
  if (row.output_format) {
    sections.push(`## 输出格式\n${row.output_format}`);
  }
  if (row.note) {
    sections.push(`## 说明\n${row.note}`);
  }
  return sections.join("\n\n").trim();
}

function pickRandomSample<T>(items: readonly T[], count: number): T[] {
  const pool = [...items];
  const selected: T[] = [];
  while (pool.length > 0 && selected.length < count) {
    const index = Math.floor(Math.random() * pool.length);
    selected.push(pool.splice(index, 1)[0]!);
  }
  return selected;
}

async function main(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  logInfo("开始从 HuggingFace 数据集抽样", { url: PARQUET_URL });

  const file = await asyncBufferFromUrl({ url: PARQUET_URL });
  const rows = await parquetReadObjects({
    file,
    columns: [
      "contest_id",
      "index",
      "contest_start_year",
      "rating",
      "title",
      "description",
      "input_format",
      "output_format",
      "note",
      "editorial"
    ]
  });
  logInfo("数据集读取完成", { totalRows: rows.length });

  const buckets = new Map<number, Candidate[]>();
  let usable = 0;
  for (const raw of rows) {
    const parsed = rowSchema.safeParse(raw);
    if (!parsed.success) {
      continue;
    }
    const row = parsed.data;
    const rating = row.rating ?? null;
    if (
      rating === null ||
      rating < RATING_MIN ||
      rating > RATING_MAX ||
      rating % RATING_STEP !== 0
    ) {
      continue;
    }
    if ((row.contest_start_year ?? 0) < MINIMUM_CONTEST_YEAR) {
      continue;
    }
    const statement = buildStatement(row);
    if (statement.length < 80) {
      continue;
    }
    usable += 1;
    const bucket = buckets.get(rating) ?? [];
    bucket.push({
      contestId: row.contest_id,
      index: row.index,
      rating,
      statement,
      editorial: row.editorial ? row.editorial.slice(0, 30_000) : null
    });
    buckets.set(rating, bucket);
  }
  logInfo("过滤完成", {
    usable,
    buckets: buckets.size,
    minimumYear: MINIMUM_CONTEST_YEAR
  });

  let written = 0;
  for (let rating = RATING_MIN; rating <= RATING_MAX; rating += RATING_STEP) {
    const candidates = buckets.get(rating) ?? [];
    if (candidates.length === 0) {
      logWarn("这一档没有候选题目，跳过", { rating });
      continue;
    }
    for (const candidate of pickRandomSample(candidates, SAMPLE_SIZE_PER_BUCKET)) {
      const record = {
        contestId: candidate.contestId,
        index: candidate.index,
        rating: candidate.rating,
        statement: candidate.statement,
        editorial: candidate.editorial
      };
      const fileName = `${candidate.contestId}${candidate.index}.json`;
      writeFileSync(new URL(fileName, OUTPUT_DIR), JSON.stringify(record, null, 2), "utf8");
      written += 1;
    }
  }
  logInfo("抽样完成", { written, outputDir: OUTPUT_DIR.pathname });
}

main().catch((error) => {
  logError("HuggingFace 数据集抽样失败", error);
  process.exitCode = 1;
});
