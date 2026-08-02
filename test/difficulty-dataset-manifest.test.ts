import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  difficultyDatasetManifestSchema,
  knownPublicDifficultyArchiveProfile,
  loadDifficultyDatasetManifest,
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
