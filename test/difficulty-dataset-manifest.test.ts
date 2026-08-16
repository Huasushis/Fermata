import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  difficultyDatasetManifestSchema,
  knownPublicDifficultyArchiveProfile,
  loadDifficultyDatasetManifest,
  parsePublicDifficultyBoundedSelection,
  publicDifficultySmokeSampleLimit,
  verifyDifficultyDatasetManifest,
  verifyKnownPublicDifficultyArchiveProfile,
  type DifficultyDatasetManifest,
  type DifficultyDatasetItemForManifest
} from "../experiments/lib/difficulty-dataset-manifest";
import type { DatasetSource } from "../experiments/lib/evaluation-integrity";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function source(
  sourceId: string,
  item: DifficultyDatasetItemForManifest,
  fileContents = JSON.stringify(item)
): DatasetSource<DifficultyDatasetItemForManifest> {
  return { sourceId, fileSha256: sha256(fileContents), item };
}

function manifestFor(
  sources: readonly DatasetSource<DifficultyDatasetItemForManifest>[]
): DifficultyDatasetManifest {
  return difficultyDatasetManifestSchema.parse({
    schemaVersion: 1,
    dataset: "cf-difficulty",
    expectedFileCount: sources.length,
    samples: sources.map((entry, index) => ({
      safeId: `public-${index + 1}`,
      contestId: entry.item.contestId,
      index: entry.item.index,
      rating: entry.item.rating,
      fileSha256: entry.fileSha256,
      statementSha256: sha256(entry.item.statement)
    }))
  });
}

describe("difficulty 私有 manifest 对账", () => {
  const first = source("source-a", { contestId: 1, index: "A", rating: 800, statement: "synthetic-a" });
  const second = source("source-b", { contestId: 2, index: "B", rating: 1600, statement: "synthetic-b" });

  it("public83 明确登记为开发集，不能作为最终 holdout", () => {
    expect(knownPublicDifficultyArchiveProfile.datasetId).toBe("cf-public83");
    expect(knownPublicDifficultyArchiveProfile.purpose).toBe("development");
  });

  it("文件数、题号、难度、文件哈希和题面哈希全部一致时通过", () => {
    expect(verifyDifficultyDatasetManifest([first, second], manifestFor([first, second]))).toEqual({
      expectedSampleIds: ["source-a", "source-b"],
      failures: []
    });
  });

  it("缺文件、多文件和哈希变化都在付费请求前失败", () => {
    const manifest = manifestFor([first, second]);
    const changedFirst = source("source-a", { ...first.item, statement: "changed" });
    const extra = source("source-extra", { contestId: 3, index: "C", rating: 2400, statement: "synthetic-c" });
    const result = verifyDifficultyDatasetManifest([changedFirst, extra], manifest);
    expect(result.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining([
        "DATASET_MANIFEST_HASH_MISMATCH",
        "DATASET_MANIFEST_SAMPLE_MISSING",
        "DATASET_MANIFEST_SAMPLE_UNEXPECTED"
      ])
    );
  });

  it("manifest 自身的计数或唯一性不一致时拒绝", () => {
    const manifest = manifestFor([first, second]);
    expect(() =>
      difficultyDatasetManifestSchema.parse({ ...manifest, expectedFileCount: 83 })
    ).toThrow();
    expect(() =>
      difficultyDatasetManifestSchema.parse({
        ...manifest,
        samples: [manifest.samples[0], manifest.samples[0]]
      })
    ).toThrow();
  });

  it("正式公开归档还必须匹配已登记的 83 题、三档计数和 24 份题解", () => {
    const ratings = [
      ...Array.from({ length: 18 }, (_, index) => 800 + (index % 6) * 100),
      ...Array.from({ length: 24 }, (_, index) => 1400 + (index % 8) * 100),
      ...Array.from({ length: 41 }, (_, index) => 2200 + (index % 14) * 100)
    ];
    const archive = ratings.map((rating, index) =>
      source(`source-${index + 1}`, {
        contestId: index + 1,
        index: "A",
        rating,
        statement: `synthetic-${index + 1}`,
        editorial: index < knownPublicDifficultyArchiveProfile.expectedEditorialCount
          ? `editorial-${index + 1}`
          : null
      })
    );
    const manifest = manifestFor(archive);
    expect(verifyKnownPublicDifficultyArchiveProfile(archive, manifest)).toEqual([]);

    const wrongBands = archive.map((entry, index) =>
      index === 0 ? { ...entry, item: { ...entry.item, rating: 2200 } } : entry
    );
    expect(
      verifyKnownPublicDifficultyArchiveProfile(wrongBands, manifest).map((failure) => failure.code)
    ).toContain("DATASET_PROFILE_RATING_BANDS_MISMATCH");

    const missingEditorial = archive.map((entry, index) =>
      index === 0 ? { ...entry, item: { ...entry.item, editorial: null } } : entry
    );
    expect(
      verifyKnownPublicDifficultyArchiveProfile(missingEditorial, manifest).map((failure) => failure.code)
    ).toContain("DATASET_PROFILE_EDITORIAL_COUNT_MISMATCH");
    expect(
      verifyKnownPublicDifficultyArchiveProfile([first, second], manifestFor([first, second]))
        .map((failure) => failure.code)
    ).toContain("DATASET_PROFILE_EXPECTED_COUNT_MISMATCH");
  });

  it("只从项目私有根内的受保护普通文件读取 manifest", () => {
    const workspace = mkdtempSync(join(tmpdir(), "fermata-manifest-private-"));
    temporaryDirectories.push(workspace);
    chmodSync(workspace, 0o700);
    const repository = join(workspace, "Fermata");
    mkdirSync(repository, { mode: 0o700 });
    const privateRoot = join(repository, "private");
    mkdirSync(privateRoot, { mode: 0o700 });
    const manifestPath = join(privateRoot, "difficulty-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifestFor([first, second])), { mode: 0o600 });
    const options = { privateRoot, containingWorkspace: workspace };

    expect(loadDifficultyDatasetManifest(manifestPath, options)).toMatchObject({
      manifest: { expectedFileCount: 2 },
      failures: []
    });
    chmodSync(manifestPath, 0o644);
    expect(loadDifficultyDatasetManifest(manifestPath, options)).toMatchObject({
      manifest: null,
      failures: [{ code: "DATASET_MANIFEST_INVALID" }]
    });

    const outsidePath = join(workspace, "outside.json");
    writeFileSync(outsidePath, JSON.stringify(manifestFor([first, second])), { mode: 0o600 });
    expect(loadDifficultyDatasetManifest(outsidePath, options)).toMatchObject({
      manifest: null,
      failures: [{ code: "DATASET_MANIFEST_INVALID" }]
    });
  });
});
describe("公开 difficulty smoke bounded selector", () => {
  it("未设置 env 时默认关闭，保持全量行为不变", () => {
    expect(parsePublicDifficultyBoundedSelection({
      rawLimit: undefined,
      rawIds: undefined,
      availableSamples: [{ contestId: 1, index: "A" }]
    })).toEqual({ enabled: false, selection: null, failures: [] });
  });

  it("只在恰好 4 个唯一、格式合法且在已验证 dataset 内的公开 ID 上启用", () => {
    const available = [
      { contestId: 1862, index: "A" },
      { contestId: 1866, index: "E" },
      { contestId: 1776, index: "J" },
      { contestId: 2065, index: "C1" }
    ];
    const result = parsePublicDifficultyBoundedSelection({
      rawLimit: "4",
      rawIds: "1862A,1866E,1776J,2065C1",
      availableSamples: available
    });
    expect(result).toEqual({
      enabled: true,
      selection: available,
      failures: []
    });
  });

  it("只设置一个 env 而缺另一个时 fail closed", () => {
    const available = [{ contestId: 1862, index: "A" }];
    expect(parsePublicDifficultyBoundedSelection({
      rawLimit: "4",
      rawIds: undefined,
      availableSamples: available
    }).failures.map((f) => f.code)).toEqual(["PUBLIC_SAMPLE_SELECTOR_PARTIAL"]);
    expect(parsePublicDifficultyBoundedSelection({
      rawLimit: undefined,
      rawIds: "1862A",
      availableSamples: available
    }).failures.map((f) => f.code)).toEqual(["PUBLIC_SAMPLE_SELECTOR_PARTIAL"]);
  });

  it("limit 非 4 或非整数时 fail closed", () => {
    const available = [{ contestId: 1, index: "A" }];
    for (const bad of ["3", "5", "abc", ""]) {
      expect(parsePublicDifficultyBoundedSelection({
        rawLimit: bad,
        rawIds: "1A,2B,3C,4D",
        availableSamples: available
      }).failures.map((f) => f.code)).toEqual(["PUBLIC_SAMPLE_LIMIT_INVALID"]);
    }
  });

  it("IDs 为空或纯空白时 fail closed", () => {
    const available = [{ contestId: 1, index: "A" }];
    for (const bad of ["", "   ", ",,,,"]) {
      expect(parsePublicDifficultyBoundedSelection({
        rawLimit: "4",
        rawIds: bad,
        availableSamples: available
      }).failures.map((f) => f.code)).toEqual(["PUBLIC_SAMPLE_IDS_EMPTY"]);
    }
  });

  it("ID 格式非法（含路径/特殊字符/非公开题号格式）时 fail closed", () => {
    const available = [{ contestId: 1, index: "A" }];
    const result = parsePublicDifficultyBoundedSelection({
      rawLimit: "4",
      rawIds: "1A,../etc/passwd,2B,3C",
      availableSamples: available
    });
    expect(result.enabled).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain("PUBLIC_SAMPLE_ID_INVALID");
    expect(result.failures.some((f) => f.sampleId.includes("passwd"))).toBe(true);
  });

  it("4 个 ID 中有重复时 fail closed", () => {
    const available = [{ contestId: 1, index: "A" }, { contestId: 2, index: "B" }];
    expect(parsePublicDifficultyBoundedSelection({
      rawLimit: "4",
      rawIds: "1A,1A,2B,2B",
      availableSamples: available
    }).failures.map((f) => f.code)).toEqual(["PUBLIC_SAMPLE_DUPLICATE"]);
  });

  it("ID 数量不等于 4 时 fail closed（过少或过多）", () => {
    const available = [
      { contestId: 1, index: "A" }, { contestId: 2, index: "B" },
      { contestId: 3, index: "C" }, { contestId: 4, index: "D" }, { contestId: 5, index: "E" }
    ];
    expect(parsePublicDifficultyBoundedSelection({
      rawLimit: "4",
      rawIds: "1A,2B,3C",
      availableSamples: available
    }).failures.map((f) => f.code)).toEqual(["PUBLIC_SAMPLE_COUNT_MISMATCH"]);
    expect(parsePublicDifficultyBoundedSelection({
      rawLimit: "4",
      rawIds: "1A,2B,3C,4D,5E",
      availableSamples: available
    }).failures.map((f) => f.code)).toEqual(["PUBLIC_SAMPLE_COUNT_MISMATCH"]);
  });

  it("合法 4 个 ID 但部分不在已验证 dataset 内时 fail closed", () => {
    const available = [
      { contestId: 1862, index: "A" }, { contestId: 1866, index: "E" }
    ];
    const result = parsePublicDifficultyBoundedSelection({
      rawLimit: "4",
      rawIds: "1862A,1866E,9999Z,8888Y",
      availableSamples: available
    });
    expect(result.enabled).toBe(false);
    expect(result.failures.map((f) => f.code)).toEqual([
      "PUBLIC_SAMPLE_NOT_IN_VERIFIED_DATASET",
      "PUBLIC_SAMPLE_NOT_IN_VERIFIED_DATASET"
    ]);
    expect(result.failures.map((f) => f.sampleId)).toEqual(["9999#Z", "8888#Y"]);
  });

  it("选择器不读取任何文件路径，只做纯字符串解析", () => {
    const available = [{ contestId: 1, index: "A" }];
    const result = parsePublicDifficultyBoundedSelection({
      rawLimit: "4",
      rawIds: "/home/ubuntu/secrets.env,1A,2B,3C",
      availableSamples: available
    });
    expect(result.enabled).toBe(false);
    expect(result.failures.some((f) => f.code === "PUBLIC_SAMPLE_ID_INVALID")).toBe(true);
  });
});
