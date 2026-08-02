/**
 * difficulty 基线数据的私有 manifest 契约。manifest 只保存公开题号、难度和哈希，
 * 不保存题面；它可以在付费请求前证明“应有的文件全部在场、没有多出文件，
 * 文件和题面都没变”。错误结构只含不透明 id 和固定错误码。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  readProtectedEnvFile,
  type PrivateRuntimeReadOptions
} from "../../scripts/private-runtime.mjs";
import {
  evaluationConfigurationFingerprint,
  type DatasetSource,
  type EvaluationFailure
} from "./evaluation-integrity";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const difficultyDatasetManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    dataset: z.literal("cf-difficulty"),
    expectedFileCount: z.number().int().positive(),
    samples: z
      .array(
        z
          .object({
            safeId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/),
            contestId: z.number().int().positive(),
            index: z.string().regex(/^[A-Z][0-9]{0,7}$/),
            rating: z.number().int().min(800).max(3500).multipleOf(100),
            fileSha256: sha256Schema,
            statementSha256: sha256Schema
          })
          .strict()
      )
      .min(1)
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.expectedFileCount !== manifest.samples.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedFileCount"],
        message: "expectedFileCount 必须等于 samples 长度。"
      });
    }
    if (new Set(manifest.samples.map((sample) => sample.safeId)).size !== manifest.samples.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["samples"], message: "safeId 不能重复。" });
    }
    if (
      new Set(manifest.samples.map((sample) => `${sample.contestId}#${sample.index}`)).size !==
      manifest.samples.length
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["samples"], message: "题号不能重复。" });
    }
  });

export type DifficultyDatasetManifest = z.infer<typeof difficultyDatasetManifestSchema>;

export interface DifficultyDatasetItemForManifest {
  readonly contestId: number;
  readonly index: string;
  readonly rating: number;
  readonly statement: string;
  readonly editorial?: string | null;
}

export const knownPublicDifficultyArchiveProfile = {
  datasetId: "cf-public83",
  /** public83 已被反复用于基线与调参，只能作为开发集，不能充当最终盲测集。 */
  purpose: "development",
  expectedFileCount: 83,
  expectedEditorialCount: 24,
  expectedRatingBands: { low: 18, middle: 24, high: 41 }
} as const;

export interface LoadedDifficultyDatasetManifest {
  readonly manifest: DifficultyDatasetManifest | null;
  readonly fingerprint: string | null;
  readonly failures: readonly EvaluationFailure[];
}

export function loadDifficultyDatasetManifest(
  filePath: string,
  privateRuntimeOptions: Omit<PrivateRuntimeReadOptions, "maximumBytes"> = {}
): LoadedDifficultyDatasetManifest {
  try {
    // 复用含密钥实验的私有输入边界：绝对路径、Fermata/private 内、
    // 目录 0700、文件 owner/模式/大小/读取前后快照全部验证，且不跟随符号链接。
    const raw = JSON.parse(
      readProtectedEnvFile(filePath, {
        ...privateRuntimeOptions,
        maximumBytes: 1024 * 1024
      })
    ) as unknown;
    const manifest = difficultyDatasetManifestSchema.parse(raw);
    return {
      manifest,
      fingerprint: evaluationConfigurationFingerprint(manifest),
      failures: []
    };
  } catch {
    return manifestLoadFailure("DATASET_MANIFEST_INVALID");
  }
}

export function verifyDifficultyDatasetManifest(
  sources: readonly DatasetSource<DifficultyDatasetItemForManifest>[],
  manifest: DifficultyDatasetManifest
): { readonly expectedSampleIds: readonly string[]; readonly failures: readonly EvaluationFailure[] } {
  const actualByProblem = new Map<string, DatasetSource<DifficultyDatasetItemForManifest>[]>();
  for (const source of sources) {
    const key = problemKey(source.item.contestId, source.item.index);
    const list = actualByProblem.get(key) ?? [];
    list.push(source);
    actualByProblem.set(key, list);
  }

  const expectedSampleIds: string[] = [];
  const failures: EvaluationFailure[] = [];
  const matchedSourceIds = new Set<string>();
  for (const expected of manifest.samples) {
    const candidates = actualByProblem.get(problemKey(expected.contestId, expected.index)) ?? [];
    const missingId = opaqueManifestSampleId(expected.safeId);
    if (candidates.length === 0) {
      expectedSampleIds.push(missingId);
      failures.push({ sampleId: missingId, phase: "dataset", code: "DATASET_MANIFEST_SAMPLE_MISSING" });
      continue;
    }
    if (candidates.length > 1) {
      for (const candidate of candidates) {
        expectedSampleIds.push(candidate.sourceId);
        matchedSourceIds.add(candidate.sourceId);
        failures.push({
          sampleId: candidate.sourceId,
          phase: "dataset",
          code: "DATASET_MANIFEST_SAMPLE_DUPLICATED"
        });
      }
      continue;
    }

    const actual = candidates[0]!;
    expectedSampleIds.push(actual.sourceId);
    matchedSourceIds.add(actual.sourceId);
    const statementSha256 = createHash("sha256")
      .update(actual.item.statement, "utf8")
      .digest("hex");
    if (
      actual.fileSha256 !== expected.fileSha256 ||
      statementSha256 !== expected.statementSha256 ||
      actual.item.rating !== expected.rating
    ) {
      failures.push({
        sampleId: actual.sourceId,
        phase: "dataset",
        code: "DATASET_MANIFEST_HASH_MISMATCH"
      });
    }
  }

  for (const source of sources) {
    if (!matchedSourceIds.has(source.sourceId)) {
      expectedSampleIds.push(source.sourceId);
      failures.push({
        sampleId: source.sourceId,
        phase: "dataset",
        code: "DATASET_MANIFEST_SAMPLE_UNEXPECTED"
      });
    }
  }
  if (sources.length !== manifest.expectedFileCount) {
    failures.push({
      sampleId: "dataset-manifest-count",
      phase: "dataset",
      code: "DATASET_MANIFEST_COUNT_MISMATCH"
    });
  }

  return { expectedSampleIds, failures };
}

/**
 * 迁移前已登记的公开 CF 归档只有这一份安全摘要。正式基线必须逐项通过私有
 * manifest 后，再与这个计数轮廓一致；少题、多题或换成另一批数据都不能付费。
 */
export function verifyKnownPublicDifficultyArchiveProfile(
  sources: readonly DatasetSource<DifficultyDatasetItemForManifest>[],
  manifest: DifficultyDatasetManifest
): EvaluationFailure[] {
  const failures: EvaluationFailure[] = [];
  if (manifest.expectedFileCount !== knownPublicDifficultyArchiveProfile.expectedFileCount) {
    failures.push({
      sampleId: "dataset-profile-count",
      phase: "dataset",
      code: "DATASET_PROFILE_EXPECTED_COUNT_MISMATCH"
    });
  }

  const ratingBands = { low: 0, middle: 0, high: 0 };
  let editorialCount = 0;
  for (const source of sources) {
    if (source.item.rating < 1400) {
      ratingBands.low += 1;
    } else if (source.item.rating < 2200) {
      ratingBands.middle += 1;
    } else {
      ratingBands.high += 1;
    }
    if (typeof source.item.editorial === "string" && source.item.editorial.length > 0) {
      editorialCount += 1;
    }
  }
  const expectedBands = knownPublicDifficultyArchiveProfile.expectedRatingBands;
  if (
    ratingBands.low !== expectedBands.low ||
    ratingBands.middle !== expectedBands.middle ||
    ratingBands.high !== expectedBands.high
  ) {
    failures.push({
      sampleId: "dataset-profile-rating-bands",
      phase: "dataset",
      code: "DATASET_PROFILE_RATING_BANDS_MISMATCH"
    });
  }
  if (editorialCount !== knownPublicDifficultyArchiveProfile.expectedEditorialCount) {
    failures.push({
      sampleId: "dataset-profile-editorials",
      phase: "dataset",
      code: "DATASET_PROFILE_EDITORIAL_COUNT_MISMATCH"
    });
  }
  return failures;
}

function manifestLoadFailure(code: string): LoadedDifficultyDatasetManifest {
  return {
    manifest: null,
    fingerprint: null,
    failures: [{ sampleId: "dataset-manifest", phase: "setup", code }]
  };
}

function problemKey(contestId: number, index: string): string {
  return `${contestId}#${index}`;
}

function opaqueManifestSampleId(safeId: string): string {
  return `manifest-${createHash("sha256").update(safeId, "utf8").digest("hex").slice(0, 16)}`;
}
