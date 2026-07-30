import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const LEVEL_BAND_BOUNDARIES = [1400, 2200] as const;
export type LevelBand = "低" | "中" | "高";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const codeforcesProblemIndexSchema = z
  .string()
  .regex(/^[A-Z][0-9]{0,7}$/);

export const calibrationDatasetItemSchema = z
  .object({
    contestId: z.number().int().positive(),
    index: codeforcesProblemIndexSchema,
    rating: z.number().int().positive(),
    statement: z.string().min(1),
    editorial: z.string().min(1)
  })
  .strict();
export type CalibrationDatasetItem = z.infer<typeof calibrationDatasetItemSchema>;

const calibrationDatasetCandidateSchema = z
  .object({
    contestId: z.number().int().positive(),
    index: codeforcesProblemIndexSchema,
    rating: z.number().int().positive(),
    statement: z.string().min(1),
    editorial: z.unknown().optional()
  })
  .strict();

export const calibrationRowSchema = z
  .object({
    contestId: z.number().int().positive(),
    index: codeforcesProblemIndexSchema,
    rating: z.number().int().positive(),
    thinkingLevel: z.number().int().min(1).max(5),
    thinkingSignals: z.record(z.string(), z.unknown()),
    codingLevel: z.number().int().min(1).max(5),
    codingSignals: z.record(z.string(), z.unknown())
  })
  .strict();
export type CalibrationRow = z.infer<typeof calibrationRowSchema>;

export const levelsExperimentFingerprintSchema = z
  .object({
    schemaVersion: z.literal(1),
    datasetHash: digestSchema,
    modelConfigurationHash: digestSchema,
    pipelineSourceHash: digestSchema,
    combinedHash: digestSchema
  })
  .strict();
export type LevelsExperimentFingerprint = z.infer<typeof levelsExperimentFingerprintSchema>;

export interface LevelsRunConfiguration {
  readonly providerBaseUrls: {
    readonly solver: string;
    readonly analyst: string;
    readonly coding: string;
  };
  readonly requestTimeoutMs: number;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly concurrency: number;
}

export interface LevelsReportRunConfiguration {
  readonly providers: {
    readonly solver: {
      readonly name: string;
      readonly addressCheck: string;
    };
    readonly analyst: {
      readonly name: string;
      readonly addressCheck: string;
    };
    readonly coding: {
      readonly name: string;
      readonly addressCheck: string;
    };
  };
  readonly requestTimeoutMs: number;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly concurrency: number;
}

const savedRowsSchema = z
  .object({
    schemaVersion: z.literal(2),
    label: z.string().min(1),
    profileName: z.string().min(1),
    fingerprint: levelsExperimentFingerprintSchema,
    rows: z.array(calibrationRowSchema)
  })
  .strict();

export type LevelsDataIssueCode =
  | "LEVELS_DATA_JSON_INVALID"
  | "LEVELS_DATA_FIELDS_INVALID"
  | "LEVELS_DATA_EDITORIAL_MISSING"
  | "LEVELS_DATA_DUPLICATE"
  | "LEVELS_DATA_BAND_MISSING";

export interface LevelsDataIssue {
  readonly code: LevelsDataIssueCode;
  readonly count: number;
}

export type LevelsCalibrationStateErrorCode =
  | "LEVELS_DATA_DIRECTORY_UNREADABLE"
  | "LEVELS_DATA_READ_FAILED"
  | "LEVELS_DATASET_EMPTY"
  | "LEVELS_DATA_PRECHECK_FAILED"
  | "LEVELS_FINGERPRINT_BUILD_FAILED"
  | "LEVELS_PIPELINE_SOURCE_READ_FAILED"
  | "LEVELS_CHECKPOINT_MISSING"
  | "LEVELS_CHECKPOINT_READ_FAILED"
  | "LEVELS_CHECKPOINT_INVALID"
  | "LEVELS_CHECKPOINT_METADATA_MISMATCH"
  | "LEVELS_FINGERPRINT_MISMATCH"
  | "LEVELS_LABEL_ALREADY_USED"
  | "LEVELS_LABEL_CHECK_FAILED"
  | "LEVELS_OUTPUT_DIRECTORY_FAILED"
  | "LEVELS_ATOMIC_WRITE_FAILED"
  | "LEVELS_LABEL_LOCKED"
  | "LEVELS_LOCK_FAILED";

const safeErrorMessages: Readonly<Record<LevelsCalibrationStateErrorCode, string>> = {
  LEVELS_DATA_DIRECTORY_UNREADABLE: "无法读取标定集目录。",
  LEVELS_DATA_READ_FAILED: "无法读取标定集文件。",
  LEVELS_DATASET_EMPTY: "标定集为空。",
  LEVELS_DATA_PRECHECK_FAILED: "标定集预检失败。",
  LEVELS_FINGERPRINT_BUILD_FAILED: "无法生成本次实验的校验摘要。",
  LEVELS_PIPELINE_SOURCE_READ_FAILED: "无法读取标定所需的流水线代码。",
  LEVELS_CHECKPOINT_MISSING: "没有找到指定的标定检查点。",
  LEVELS_CHECKPOINT_READ_FAILED: "无法读取指定的标定检查点。",
  LEVELS_CHECKPOINT_INVALID: "指定的标定检查点格式不正确。",
  LEVELS_CHECKPOINT_METADATA_MISMATCH: "指定的标定检查点不属于当前标签或模型档位。",
  LEVELS_FINGERPRINT_MISMATCH: "检查点与当前数据、模型配置、运行参数或代码不一致。",
  LEVELS_LABEL_ALREADY_USED: "当前实验标签已经有结果或中间文件。",
  LEVELS_LABEL_CHECK_FAILED: "无法检查当前实验标签是否已被使用。",
  LEVELS_OUTPUT_DIRECTORY_FAILED: "无法准备标定结果目录。",
  LEVELS_ATOMIC_WRITE_FAILED: "无法安全写入标定结果。",
  LEVELS_LABEL_LOCKED: "同一标签已有标定任务在运行。",
  LEVELS_LOCK_FAILED: "无法创建标定任务运行锁。"
};

export class LevelsCalibrationStateError extends Error {
  public readonly code: LevelsCalibrationStateErrorCode;
  public readonly issues: readonly LevelsDataIssue[];

  public constructor(
    code: LevelsCalibrationStateErrorCode,
    issues: readonly LevelsDataIssue[] = []
  ) {
    super(safeErrorMessages[code]);
    this.name = "LevelsCalibrationStateError";
    this.code = code;
    this.issues = issues;
  }
}

/**
 * 在任何模型请求发出前一次性检查全部输入。错误只按种类计数，不保留文件名、
 * JSON 片段或字段内容，避免错误信息带出题面和题解。
 */
export function preflightCalibrationDocuments(
  documents: readonly string[]
): CalibrationDatasetItem[] {
  if (documents.length === 0) {
    throw new LevelsCalibrationStateError("LEVELS_DATASET_EMPTY");
  }

  const issueCounts = new Map<LevelsDataIssueCode, number>();
  const items: CalibrationDatasetItem[] = [];
  const seenKeys = new Set<string>();

  const recordIssue = (code: LevelsDataIssueCode): void => {
    issueCounts.set(code, (issueCounts.get(code) ?? 0) + 1);
  };

  for (const document of documents) {
    let raw: unknown;
    try {
      raw = JSON.parse(document) as unknown;
    } catch {
      recordIssue("LEVELS_DATA_JSON_INVALID");
      continue;
    }

    const candidate = calibrationDatasetCandidateSchema.safeParse(raw);
    if (!candidate.success) {
      recordIssue("LEVELS_DATA_FIELDS_INVALID");
      continue;
    }
    if (candidate.data.statement.trim().length === 0) {
      recordIssue("LEVELS_DATA_FIELDS_INVALID");
      continue;
    }
    if (
      typeof candidate.data.editorial !== "string" ||
      candidate.data.editorial.trim().length === 0
    ) {
      recordIssue("LEVELS_DATA_EDITORIAL_MISSING");
      continue;
    }

    const item = calibrationDatasetItemSchema.parse({
      ...candidate.data,
      editorial: candidate.data.editorial
    });
    const key = calibrationRowKey(item);
    if (seenKeys.has(key)) {
      recordIssue("LEVELS_DATA_DUPLICATE");
      continue;
    }
    seenKeys.add(key);
    items.push(item);
  }

  if (issueCounts.size === 0) {
    const presentBands = new Set(items.map((item) => levelBandOf(item.rating)));
    const missingBandCount = (["低", "中", "高"] as const).filter(
      (band) => !presentBands.has(band)
    ).length;
    if (missingBandCount > 0) {
      issueCounts.set("LEVELS_DATA_BAND_MISSING", missingBandCount);
    }
  }

  if (issueCounts.size > 0) {
    const issues = [...issueCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));
    throw new LevelsCalibrationStateError("LEVELS_DATA_PRECHECK_FAILED", issues);
  }
  return items.sort(
    (left, right) =>
      left.rating - right.rating ||
      left.contestId - right.contestId ||
      left.index.localeCompare(right.index)
  );
}

export function buildLevelsRunConfiguration(input: {
  readonly solverBaseUrl: string;
  readonly analystBaseUrl: string;
  readonly codingBaseUrl: string;
  readonly requestTimeoutMs: number;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly concurrency: number;
}): LevelsRunConfiguration {
  return {
    providerBaseUrls: {
      solver: input.solverBaseUrl,
      analyst: input.analystBaseUrl,
      coding: input.codingBaseUrl
    },
    requestTimeoutMs: input.requestTimeoutMs,
    maxAttempts: input.maxAttempts,
    baseDelayMs: input.baseDelayMs,
    concurrency: input.concurrency
  };
}

export function buildLevelsReportRunConfiguration(input: {
  readonly runConfiguration: LevelsRunConfiguration;
  readonly providerNames: {
    readonly solver: string;
    readonly analyst: string;
    readonly coding: string;
  };
}): LevelsReportRunConfiguration {
  const provider = (
    name: string,
    baseUrl: string
  ): { readonly name: string; readonly addressCheck: string } => ({
    name,
    addressCheck: createHash("sha256")
      .update(baseUrl, "utf8")
      .digest("hex")
      .slice(0, 16)
  });
  return {
    providers: {
      solver: provider(
        input.providerNames.solver,
        input.runConfiguration.providerBaseUrls.solver
      ),
      analyst: provider(
        input.providerNames.analyst,
        input.runConfiguration.providerBaseUrls.analyst
      ),
      coding: provider(
        input.providerNames.coding,
        input.runConfiguration.providerBaseUrls.coding
      )
    },
    requestTimeoutMs: input.runConfiguration.requestTimeoutMs,
    maxAttempts: input.runConfiguration.maxAttempts,
    baseDelayMs: input.runConfiguration.baseDelayMs,
    concurrency: input.runConfiguration.concurrency
  };
}

export function buildLevelsExperimentFingerprint(input: {
  readonly dataset: readonly CalibrationDatasetItem[];
  readonly experimentVersion: string;
  readonly profileName: string;
  readonly profile: unknown;
  readonly runConfiguration: LevelsRunConfiguration;
  readonly pipelineSources: Readonly<Record<string, string>>;
  readonly calibrationProtocol: unknown;
}): LevelsExperimentFingerprint {
  try {
    const datasetHash = hashCanonicalValue(input.dataset);
    const modelConfigurationHash = hashCanonicalValue({
      experimentVersion: input.experimentVersion,
      profileName: input.profileName,
      profile: input.profile,
      runConfiguration: input.runConfiguration
    });
    const pipelineSourceHash = hashCanonicalValue({
      pipelineSources: input.pipelineSources,
      calibrationProtocol: input.calibrationProtocol
    });
    const combinedHash = hashCanonicalValue({
      schemaVersion: 1,
      datasetHash,
      modelConfigurationHash,
      pipelineSourceHash
    });
    return {
      schemaVersion: 1,
      datasetHash,
      modelConfigurationHash,
      pipelineSourceHash,
      combinedHash
    };
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_FINGERPRINT_BUILD_FAILED");
  }
}

export function calibrationRowKey(
  value: Pick<CalibrationRow, "contestId" | "index">
): string {
  return `${value.contestId}:${value.index}`;
}

export function checkpointUrl(directory: URL, label: string): URL {
  return new URL(`levels-${label}-checkpoint.json`, directory);
}

export function assertCalibrationLabelUnused(input: {
  readonly label: string;
  readonly rawDirectory: URL;
  readonly resultsDirectory: URL;
}): void {
  let rawFileNames: string[];
  let resultFileNames: string[];
  try {
    rawFileNames = readdirSync(input.rawDirectory);
    resultFileNames = readdirSync(input.resultsDirectory);
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_LABEL_CHECK_FAILED");
  }

  const escapedLabel = escapeRegularExpression(input.label);
  const temporarySuffix = String.raw`(?:\.tmp(?:-[A-Za-z0-9-]+)?)?`;
  const timestamp =
    String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z`;
  const rawArtifact = new RegExp(
    `^levels-${escapedLabel}-(?:checkpoint|${timestamp})\\.json${temporarySuffix}$`
  );
  const resultArtifact = new RegExp(
    `^levels-${escapedLabel}-(?:summary\\.json|report\\.md)${temporarySuffix}$`
  );
  if (
    rawFileNames.some((fileName) => rawArtifact.test(fileName)) ||
    resultFileNames.some((fileName) => resultArtifact.test(fileName))
  ) {
    throw new LevelsCalibrationStateError("LEVELS_LABEL_ALREADY_USED");
  }
}

export function loadCalibrationCheckpoint(input: {
  readonly source: URL;
  readonly expectedLabel: string;
  readonly expectedProfileName: string;
  readonly expectedFingerprint: LevelsExperimentFingerprint;
  readonly expectedItems: readonly CalibrationDatasetItem[];
}): CalibrationRow[] {
  let sourceText: string;
  try {
    sourceText = readFileSync(input.source, "utf8");
  } catch (error) {
    const code =
      errnoCode(error) === "ENOENT"
        ? "LEVELS_CHECKPOINT_MISSING"
        : "LEVELS_CHECKPOINT_READ_FAILED";
    throw new LevelsCalibrationStateError(code);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(sourceText) as unknown;
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
  }
  const parsed = savedRowsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
  }
  if (
    parsed.data.label !== input.expectedLabel ||
    parsed.data.profileName !== input.expectedProfileName
  ) {
    throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_METADATA_MISMATCH");
  }
  if (!fingerprintsEqual(parsed.data.fingerprint, input.expectedFingerprint)) {
    throw new LevelsCalibrationStateError("LEVELS_FINGERPRINT_MISMATCH");
  }

  const expectedRatings = new Map<string, number>(
    input.expectedItems.map(
      (item) => [calibrationRowKey(item), item.rating] as const
    )
  );
  const seenKeys = new Set<string>();
  for (const row of parsed.data.rows) {
    const key = calibrationRowKey(row);
    if (
      seenKeys.has(key) ||
      expectedRatings.get(key) !== row.rating
    ) {
      throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
    }
    seenKeys.add(key);
  }
  return parsed.data.rows;
}

export function writeCalibrationCheckpoint(input: {
  readonly target: URL;
  readonly label: string;
  readonly profileName: string;
  readonly fingerprint: LevelsExperimentFingerprint;
  readonly rows: readonly CalibrationRow[];
}): void {
  writeJsonAtomically(input.target, {
    schemaVersion: 2,
    label: input.label,
    profileName: input.profileName,
    fingerprint: input.fingerprint,
    rows: input.rows
  });
}

export function writeJsonAtomically(target: URL, value: unknown): void {
  let serialized: string;
  try {
    const candidate = JSON.stringify(value, null, 2);
    if (candidate === undefined) {
      throw new Error("无法序列化标定结果。");
    }
    serialized = candidate;
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_ATOMIC_WRITE_FAILED");
  }
  writeTextAtomically(target, serialized);
}

export function writeTextAtomically(target: URL, value: string): void {
  const targetPath = fileURLToPath(target);
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | null = null;
  let temporaryExists = false;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    writeFileSync(descriptor, value, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, targetPath);
    temporaryExists = false;
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_ATOMIC_WRITE_FAILED");
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // 错误已经转换成固定错误码；这里只做尽力清理。
      }
    }
    if (temporaryExists) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // 临时文件名不进入日志，避免路径信息泄露。
      }
    }
  }
}

export interface LevelsLabelLock {
  /** 返回 false 表示锁文件清理失败，调用方应以失败状态结束。 */
  readonly release: () => boolean;
}

export function acquireLevelsLabelLock(directory: URL, label: string): LevelsLabelLock {
  const lockPath = fileURLToPath(new URL(`levels-${label}.lock`, directory));
  const ownershipMarker = `${process.pid}:${randomUUID()}\n`;
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      throw new LevelsCalibrationStateError("LEVELS_LABEL_LOCKED");
    }
    throw new LevelsCalibrationStateError("LEVELS_LOCK_FAILED");
  }

  try {
    writeFileSync(descriptor, ownershipMarker, "utf8");
    fsyncSync(descriptor);
  } catch {
    const stillOwned = lockFileIsOwned(lockPath, descriptor, ownershipMarker);
    if (stillOwned) {
      try {
        unlinkSync(lockPath);
      } catch {
        // 写锁失败时宁可留下旧锁，也不能误删另一进程刚建立的锁。
      }
    }
    try {
      closeSync(descriptor);
    } catch {
      // 只返回固定错误码，不记录文件系统原始错误。
    }
    throw new LevelsCalibrationStateError("LEVELS_LOCK_FAILED");
  }

  let releaseResult: boolean | undefined;
  return {
    release: () => {
      if (releaseResult !== undefined) {
        return releaseResult;
      }
      let succeeded = true;
      const stillOwned = lockFileIsOwned(lockPath, descriptor, ownershipMarker);
      if (!stillOwned) {
        succeeded = false;
      } else {
        try {
          unlinkSync(lockPath);
        } catch {
          succeeded = false;
        }
      }
      try {
        closeSync(descriptor);
      } catch {
        succeeded = false;
      }
      releaseResult = succeeded;
      return releaseResult;
    }
  };
}

export function levelBandOf(rating: number): LevelBand {
  if (rating < LEVEL_BAND_BOUNDARIES[0]) {
    return "低";
  }
  return rating < LEVEL_BAND_BOUNDARIES[1] ? "中" : "高";
}

export function assessCalibrationCompleteness(
  rows: readonly Pick<CalibrationRow, "rating">[],
  expectedProblemCount: number
): {
  readonly allProblemsCompleted: boolean;
  readonly allBandsPresent: boolean;
  readonly missingBands: readonly LevelBand[];
  readonly complete: boolean;
} {
  const presentBands = new Set(rows.map((row) => levelBandOf(row.rating)));
  const missingBands = (["低", "中", "高"] as const).filter(
    (band) => !presentBands.has(band)
  );
  const allProblemsCompleted = rows.length === expectedProblemCount;
  const allBandsPresent = missingBands.length === 0;
  return {
    allProblemsCompleted,
    allBandsPresent,
    missingBands,
    complete: allProblemsCompleted && allBandsPresent
  };
}

function fingerprintsEqual(
  left: LevelsExperimentFingerprint,
  right: LevelsExperimentFingerprint
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.datasetHash === right.datasetHash &&
    left.modelConfigurationHash === right.modelConfigurationHash &&
    left.pipelineSourceHash === right.pipelineSourceHash &&
    left.combinedHash === right.combinedHash
  );
}

function hashCanonicalValue(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value), "utf8").digest("hex");
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value) as string;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("不支持非有限数字。");
    }
    return JSON.stringify(value) as string;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("无法生成稳定摘要。");
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lockFileIsOwned(
  lockPath: string,
  descriptor: number,
  ownershipMarker: string
): boolean {
  try {
    const openedFile = fstatSync(descriptor);
    const currentPath = statSync(lockPath);
    return (
      openedFile.dev === currentPath.dev &&
      openedFile.ino === currentPath.ino &&
      readFileSync(lockPath, "utf8") === ownershipMarker
    );
  } catch {
    return false;
  }
}
