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

/**
 * 公开 difficulty smoke 的选择器：只在完整 83 归档校验通过之后，把本次付费
 * 运行限定到恰好 4 个公开样本。选择器解析是纯函数、没有 I/O；解析失败与
 * 样本不在已验证 dataset 内一律 fail closed，默认（未设置对应 env）完全不变。
 */
export const publicDifficultySmokeSampleLimit = 4;
export const publicDifficultySmokeIdPattern = /^[1-9][0-9]*[A-Z][0-9]{0,7}$/;

export interface PublicDifficultyBoundedSelection {
  readonly enabled: boolean;
  readonly selection: readonly { readonly contestId: number; readonly index: string }[] | null;
  readonly failures: readonly EvaluationFailure[];
}

function parsePublicDifficultySampleId(id: string): { contestId: number; index: string } | null {
  const match = publicDifficultySmokeIdPattern.exec(id);
  if (match === null) return null;
  const digits = id.match(/^[0-9]+/)!;
  return {
    contestId: Number(digits[0]),
    index: id.slice(digits[0].length)
  };
}

export function parsePublicDifficultyBoundedSelection(input: {
  readonly rawLimit: string | undefined;
  readonly rawIds: string | undefined;
  readonly availableSamples: readonly { readonly contestId: number; readonly index: string }[];
}): PublicDifficultyBoundedSelection {
  const { rawLimit, rawIds, availableSamples } = input;
  if (rawLimit === undefined && rawIds === undefined) {
    return { enabled: false, selection: null, failures: [] };
  }
  if (rawLimit === undefined || rawIds === undefined) {
    return {
      enabled: false,
      selection: null,
      failures: [{
        sampleId: "public-sample-selector",
        phase: "setup",
        code: "PUBLIC_SAMPLE_SELECTOR_PARTIAL"
      }]
    };
  }
  const limit = Number.parseInt(rawLimit, 10);
  if (!Number.isInteger(limit) || limit !== publicDifficultySmokeSampleLimit) {
    return {
      enabled: false,
      selection: null,
      failures: [{
        sampleId: "public-sample-selector",
        phase: "setup",
        code: "PUBLIC_SAMPLE_LIMIT_INVALID"
      }]
    };
  }
  const tokens = rawIds.split(",").map((token) => token.trim()).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return {
      enabled: false,
      selection: null,
      failures: [{
        sampleId: "public-sample-selector",
        phase: "setup",
        code: "PUBLIC_SAMPLE_IDS_EMPTY"
      }]
    };
  }
  const parsed: { contestId: number; index: string }[] = [];
  const invalidTokens: string[] = [];
  for (const token of tokens) {
    const parsedId = parsePublicDifficultySampleId(token);
    if (parsedId === null) {
      invalidTokens.push(token);
      continue;
    }
    parsed.push(parsedId);
  }
  if (invalidTokens.length > 0) {
    return {
      enabled: false,
      selection: null,
      failures: invalidTokens.map((token) => ({
        sampleId: `public-sample-${token}`,
        phase: "setup",
        code: "PUBLIC_SAMPLE_ID_INVALID"
      }))
    };
  }
  const uniqueKeys = new Set(parsed.map((entry) => `${entry.contestId}#${entry.index}`));
  if (uniqueKeys.size !== parsed.length) {
    return {
      enabled: false,
      selection: null,
      failures: [{
        sampleId: "public-sample-selector",
        phase: "setup",
        code: "PUBLIC_SAMPLE_DUPLICATE"
      }]
    };
  }
  if (parsed.length !== publicDifficultySmokeSampleLimit) {
    return {
      enabled: false,
      selection: null,
      failures: [{
        sampleId: "public-sample-selector",
        phase: "setup",
        code: "PUBLIC_SAMPLE_COUNT_MISMATCH"
      }]
    };
  }
  const availableKeys = new Set(
    availableSamples.map((sample) => problemKey(sample.contestId, sample.index))
  );
  const missing = parsed.filter(
    (entry) => !availableKeys.has(problemKey(entry.contestId, entry.index))
  );
  if (missing.length > 0) {
    return {
      enabled: false,
      selection: null,
      failures: missing.map((entry) => ({
        sampleId: problemKey(entry.contestId, entry.index),
        phase: "setup",
        code: "PUBLIC_SAMPLE_NOT_IN_VERIFIED_DATASET"
      }))
    };
  }
  return { enabled: true, selection: parsed, failures: [] };
}

/**
 * 公开 difficulty smoke 的运行时策略：仅在 bounded 选择器激活（恰好 4 个已核验
 * 公开样本）后启用。并发必须恰好 4；总外部尝试（初次 + 429 重试）上限必须恰好
 * 8，每样本 attemptsPerSample = 8/4 = 2，保证任何样本分布下都不会发出第 9 次
 * 外部尝试。缺失、非整数、带多余空白或前导零、除不尽一律 fail closed；未启用
 * （默认全量 83 路径）返回 null，行为完全不变。
 */
export const publicDifficultySmokeConcurrency = 4;
export const publicDifficultySmokeAttemptCeiling = 8;

export interface PublicDifficultySmokeRuntimePolicy {
  readonly concurrency: number;
  readonly attemptCeiling: number;
  readonly attemptsPerSample: number;
  readonly sampleCount: number;
}

export function parsePublicDifficultySmokeRuntimePolicy(input: {
  readonly enabled: boolean;
  readonly rawConcurrency: string | undefined;
  readonly rawAttemptCeiling: string | undefined;
  readonly sampleCount: number;
}): {
  readonly policy: PublicDifficultySmokeRuntimePolicy | null;
  readonly failures: readonly EvaluationFailure[];
} {
  if (!input.enabled) {
    return { policy: null, failures: [] };
  }
  const failures: EvaluationFailure[] = [];
  const concurrencyToken = input.rawConcurrency?.trim();
  const concurrency = Number.parseInt(concurrencyToken ?? "", 10);
  if (
    concurrencyToken === undefined ||
    concurrencyToken === "" ||
    !Number.isInteger(concurrency) ||
    String(concurrency) !== concurrencyToken ||
    concurrency !== publicDifficultySmokeConcurrency
  ) {
    failures.push({
      sampleId: "public-smoke-runtime",
      phase: "setup",
      code: "PUBLIC_SMOKE_CONCURRENCY_INVALID"
    });
  }
  const ceilingToken = input.rawAttemptCeiling?.trim();
  const ceiling = Number.parseInt(ceilingToken ?? "", 10);
  if (
    ceilingToken === undefined ||
    ceilingToken === "" ||
    !Number.isInteger(ceiling) ||
    String(ceiling) !== ceilingToken ||
    ceiling !== publicDifficultySmokeAttemptCeiling
  ) {
    failures.push({
      sampleId: "public-smoke-runtime",
      phase: "setup",
      code: "PUBLIC_SMOKE_ATTEMPT_CEILING_INVALID"
    });
  }
  if (!Number.isInteger(input.sampleCount) || input.sampleCount !== publicDifficultySmokeSampleLimit) {
    failures.push({
      sampleId: "public-smoke-runtime",
      phase: "setup",
      code: "PUBLIC_SMOKE_SAMPLE_COUNT_INVALID"
    });
  }
  if (
    failures.length === 0 &&
    (publicDifficultySmokeAttemptCeiling % input.sampleCount !== 0 ||
      Math.floor(publicDifficultySmokeAttemptCeiling / input.sampleCount) < 1)
  ) {
    failures.push({
      sampleId: "public-smoke-runtime",
      phase: "setup",
      code: "PUBLIC_SMOKE_ATTEMPT_BUDGET_INVALID"
    });
  }
  if (failures.length > 0) {
    return { policy: null, failures };
  }
  return {
    policy: {
      concurrency: publicDifficultySmokeConcurrency,
      attemptCeiling: publicDifficultySmokeAttemptCeiling,
      attemptsPerSample: publicDifficultySmokeAttemptCeiling / input.sampleCount,
      sampleCount: input.sampleCount
    },
    failures: []
  };
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
