import { describe, expect, it, vi } from "vitest";
import {
  codeforcesDatasetFileName,
  fetchCodeforcesDatasetBatchFailClosed,
  parseCodeforcesDatasetSampleSize,
  requireCompleteCodeforcesRatingBuckets,
  requireRecentContestIds
} from "../experiments/lib/recent-contest-policy";

describe("Codeforces 年代筛选失败关闭", () => {
  it("有最近比赛身份时原样使用", () => {
    const ids = new Set([1, 2]);
    expect(requireRecentContestIds(ids)).toBe(ids);
  });

  it("比赛列表抓取失败形成空集合时拒绝，不能退化成全部年代", () => {
    expect(() => requireRecentContestIds(new Set())).toThrow(
      "RECENT_CONTEST_FILTER_UNAVAILABLE"
    );
  });
});

describe("Codeforces 数据集文件名边界", () => {
  it("只把严格题号转换成不含路径分隔符的文件名", () => {
    const fileName = codeforcesDatasetFileName(2048, "A1");
    expect(fileName).toBe("2048A1.json");
    expect(fileName).not.toMatch(/[\\/]/);
    const output = new URL("file:///tmp/fermata-cf/");
    expect(new URL(fileName, output).href).toBe("file:///tmp/fermata-cf/2048A1.json");
  });

  it.each([
    "../A",
    "A/../../escape",
    "A\\..\\escape",
    "%2fescape",
    "a",
    "A-1",
    "",
    "A12345678"
  ])("拒绝带路径或超出白名单的 index：%s", (index) => {
    expect(() => codeforcesDatasetFileName(2048, index)).toThrow(
      "CODEFORCES_DATASET_PROBLEM_IDENTITY_INVALID"
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "拒绝非法 contestId：%s",
    (contestId) => {
      expect(() => codeforcesDatasetFileName(contestId, "A")).toThrow(
        "CODEFORCES_DATASET_PROBLEM_IDENTITY_INVALID"
      );
    }
  );
});

describe("Codeforces 数据集完整性失败关闭", () => {
  it("样本数必须是严格正整数", () => {
    expect(parseCodeforcesDatasetSampleSize(undefined)).toBe(3);
    expect(parseCodeforcesDatasetSampleSize("5")).toBe(5);
    for (const raw of ["", "0", "-1", "1x", "101"]) {
      expect(() => parseCodeforcesDatasetSampleSize(raw)).toThrow(
        "CODEFORCES_DATASET_SAMPLE_SIZE_INVALID"
      );
    }
  });

  it("任一预定难度档为空或候选不足时整批失败", () => {
    expect(() => requireCompleteCodeforcesRatingBuckets({
      candidateCounts: new Map([[800, 2], [900, 2]]),
      expectedRatings: [800, 900],
      sampleSizePerBucket: 2
    })).not.toThrow();
    expect(() => requireCompleteCodeforcesRatingBuckets({
      candidateCounts: new Map([[800, 2]]),
      expectedRatings: [800, 900],
      sampleSizePerBucket: 2
    })).toThrow("CODEFORCES_DATASET_BUCKET_INCOMPLETE");
    expect(() => requireCompleteCodeforcesRatingBuckets({
      candidateCounts: new Map([[800, 1], [900, 2]]),
      expectedRatings: [800, 900],
      sampleSizePerBucket: 2
    })).toThrow("CODEFORCES_DATASET_BUCKET_INCOMPLETE");
  });

  it("任一题面抓取失败就不返回部分记录，也不继续请求后续题", async () => {
    const fetchOne = vi.fn(async (item: number) => {
      if (item === 2) {
        throw new Error("external payload must be discarded");
      }
      return `value-${item}`;
    });
    await expect(fetchCodeforcesDatasetBatchFailClosed({
      items: [1, 2, 3],
      fetchOne
    })).rejects.toMatchObject({ code: "CODEFORCES_DATASET_FETCH_INCOMPLETE" });
    expect(fetchOne).toHaveBeenCalledTimes(2);
    expect(fetchOne).not.toHaveBeenCalledWith(3, 2);
  });
});
