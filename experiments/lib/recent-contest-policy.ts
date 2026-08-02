/**
 * 年代过滤依赖比赛列表。列表抓取失败或筛选结果为空时绝不能退化成“全部年代”，
 * 否则实验会在操作者不知情时换掉目标总体。
 */
export function requireRecentContestIds(
  contestIds: ReadonlySet<number>
): ReadonlySet<number> {
  if (contestIds.size === 0) {
    throw new RecentContestFilterError();
  }
  return contestIds;
}

export class RecentContestFilterError extends Error {
  readonly code = "RECENT_CONTEST_FILTER_UNAVAILABLE";

  constructor() {
    super("RECENT_CONTEST_FILTER_UNAVAILABLE");
    this.name = "RecentContestFilterError";
  }
}

export class CodeforcesDatasetIdentityError extends Error {
  readonly code = "CODEFORCES_DATASET_PROBLEM_IDENTITY_INVALID";

  constructor() {
    super("CODEFORCES_DATASET_PROBLEM_IDENTITY_INVALID");
    this.name = "CodeforcesDatasetIdentityError";
  }
}

export class CodeforcesDatasetCoverageError extends Error {
  readonly code: string;

  constructor(code: "CODEFORCES_DATASET_SAMPLE_SIZE_INVALID" | "CODEFORCES_DATASET_BUCKET_INCOMPLETE") {
    super(code);
    this.name = "CodeforcesDatasetCoverageError";
    this.code = code;
  }
}

export class CodeforcesDatasetFetchError extends Error {
  readonly code = "CODEFORCES_DATASET_FETCH_INCOMPLETE";

  constructor() {
    super("CODEFORCES_DATASET_FETCH_INCOMPLETE");
    this.name = "CodeforcesDatasetFetchError";
  }
}

/** 任一远端读取失败就不返回任何可写记录，并停止后续请求。 */
export async function fetchCodeforcesDatasetBatchFailClosed<TItem, TValue>(input: {
  readonly items: readonly TItem[];
  readonly fetchOne: (item: TItem, index: number) => Promise<TValue>;
}): Promise<Array<{ readonly item: TItem; readonly value: TValue }>> {
  const records: Array<{ readonly item: TItem; readonly value: TValue }> = [];
  for (let index = 0; index < input.items.length; index += 1) {
    const item = input.items[index]!;
    try {
      records.push({ item, value: await input.fetchOne(item, index) });
    } catch {
      throw new CodeforcesDatasetFetchError();
    }
  }
  return records;
}

export function parseCodeforcesDatasetSampleSize(
  raw: string | undefined,
  fallback = 3
): number {
  const source = raw ?? String(fallback);
  if (!/^[1-9][0-9]*$/.test(source)) {
    throw new CodeforcesDatasetCoverageError(
      "CODEFORCES_DATASET_SAMPLE_SIZE_INVALID"
    );
  }
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value > 100) {
    throw new CodeforcesDatasetCoverageError(
      "CODEFORCES_DATASET_SAMPLE_SIZE_INVALID"
    );
  }
  return value;
}

/** 缺任一预定难度档或候选数不足时整批失败，禁止生成部分数据集。 */
export function requireCompleteCodeforcesRatingBuckets(input: {
  readonly candidateCounts: ReadonlyMap<number, number>;
  readonly expectedRatings: readonly number[];
  readonly sampleSizePerBucket: number;
}): void {
  if (
    !Number.isSafeInteger(input.sampleSizePerBucket) ||
    input.sampleSizePerBucket < 1 ||
    new Set(input.expectedRatings).size !== input.expectedRatings.length ||
    input.expectedRatings.length === 0 ||
    input.expectedRatings.some((rating) =>
      !Number.isSafeInteger(rating) || rating < 1
    )
  ) {
    throw new CodeforcesDatasetCoverageError(
      "CODEFORCES_DATASET_BUCKET_INCOMPLETE"
    );
  }
  if (input.expectedRatings.some(
    (rating) => (input.candidateCounts.get(rating) ?? 0) < input.sampleSizePerBucket
  )) {
    throw new CodeforcesDatasetCoverageError(
      "CODEFORCES_DATASET_BUCKET_INCOMPLETE"
    );
  }
}

/**
 * 外部 API 返回的题号会进入本地文件名，必须先收窄为不含任何路径语义的格式。
 * 这里返回唯一允许传给 OUTPUT_DIR URL 的文件名。
 */
export function codeforcesDatasetFileName(
  contestId: number,
  index: string
): string {
  if (
    !Number.isSafeInteger(contestId) ||
    contestId <= 0 ||
    contestId > 2_147_483_647 ||
    !/^[A-Z][0-9]{0,7}$/.test(index)
  ) {
    throw new CodeforcesDatasetIdentityError();
  }
  return `${contestId}${index}.json`;
}
