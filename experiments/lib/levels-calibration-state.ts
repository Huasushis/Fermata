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
import {
  DATA_STRUCTURE_SIGNATURES,
  mapCodingSignalsToLevel
} from "../../src/pipelines/coding";
import { mapThinkingSignalsToLevel } from "../../src/pipelines/thinking";

export const LEVEL_BAND_BOUNDARIES = [1400, 2200] as const;
export type LevelBand = "低" | "中" | "高";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const codeforcesProblemIndexSchema = z
  .string()
  .regex(/^[A-Z][0-9]{0,7}$/);
const calibrationLabelSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
const calibrationProfileNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/);

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

export const calibrationThinkingSignalsSchema = z
  .object({
    solved: z.boolean(),
    approachSimilarity: z.number().finite().min(0).max(1),
    selfCorrections: z.number().int().nonnegative().max(50),
    keyInsightCount: z.number().int().nonnegative().max(50)
  })
  .strict();
export type CalibrationThinkingSignals = z.infer<
  typeof calibrationThinkingSignalsSchema
>;

const codingSignalWeights = new Map(
  DATA_STRUCTURE_SIGNATURES.map(
    (signature) => [signature.label, signature.weight] as const
  )
);

export const calibrationCodingSignalsSchema = z
  .object({
    effectiveLineCount: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    maxNestingDepth: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    detectedDataStructures: z
      .array(z.string().trim().min(1).max(100))
      .max(DATA_STRUCTURE_SIGNATURES.length),
    maxDataStructureWeight: z.number().finite().nonnegative().max(100)
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.detectedDataStructures).size !==
      value.detectedDataStructures.length
    ) {
      context.addIssue({
        code: "custom",
        message: "代码信号中的数据结构名称不能重复。"
      });
    }
    const expectedMaximum = value.detectedDataStructures.reduce(
      (maximum, label) => {
        const weight = codingSignalWeights.get(label);
        if (weight === undefined) {
          context.addIssue({
            code: "custom",
            message: "代码信号中包含未知的数据结构名称。"
          });
          return maximum;
        }
        return Math.max(maximum, weight);
      },
      0
    );
    if (value.maxDataStructureWeight !== expectedMaximum) {
      context.addIssue({
        code: "custom",
        message: "代码信号中的最高权重与数据结构列表不一致。"
      });
    }
  });
export type CalibrationCodingSignals = z.infer<
  typeof calibrationCodingSignalsSchema
>;

export const calibrationThinkingResultSchema = z
  .object({
    level: z.number().int().min(1).max(5),
    signals: calibrationThinkingSignalsSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (mapThinkingSignalsToLevel(value.signals) !== value.level) {
      context.addIssue({
        code: "custom",
        message: "思维等级与结构化信号不一致。"
      });
    }
  });
export type CalibrationThinkingResult = z.infer<
  typeof calibrationThinkingResultSchema
>;

export const calibrationCodingResultSchema = z
  .object({
    level: z.number().int().min(1).max(5),
    signals: calibrationCodingSignalsSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (mapCodingSignalsToLevel(value.signals) !== value.level) {
      context.addIssue({
        code: "custom",
        message: "代码等级与结构化信号不一致。"
      });
    }
  });
export type CalibrationCodingResult = z.infer<
  typeof calibrationCodingResultSchema
>;

export const calibrationProgressSchema = z
  .object({
    contestId: z.number().int().positive(),
    index: codeforcesProblemIndexSchema,
    rating: z.number().int().positive(),
    thinking: calibrationThinkingResultSchema.optional(),
    coding: calibrationCodingResultSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.thinking === undefined && value.coding === undefined) {
      context.addIssue({
        code: "custom",
        message: "检查点只保存至少完成一个阶段的题目。"
      });
    }
    if (value.coding !== undefined && value.thinking === undefined) {
      context.addIssue({
        code: "custom",
        message: "代码阶段结果不能脱离思维阶段结果保存。"
      });
    }
  });
export type CalibrationProgress = z.infer<typeof calibrationProgressSchema>;

export const calibrationRowSchema = z
  .object({
    contestId: z.number().int().positive(),
    index: codeforcesProblemIndexSchema,
    rating: z.number().int().positive(),
    thinkingLevel: z.number().int().min(1).max(5),
    thinkingSignals: calibrationThinkingSignalsSchema,
    codingLevel: z.number().int().min(1).max(5),
    codingSignals: calibrationCodingSignalsSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (mapThinkingSignalsToLevel(value.thinkingSignals) !== value.thinkingLevel) {
      context.addIssue({
        code: "custom",
        message: "思维等级与结构化信号不一致。"
      });
    }
    if (mapCodingSignalsToLevel(value.codingSignals) !== value.codingLevel) {
      context.addIssue({
        code: "custom",
        message: "代码等级与结构化信号不一致。"
      });
    }
  });
export type CalibrationRow = z.infer<typeof calibrationRowSchema>;

export const calibrationFailureStageSchema = z.enum(["thinking", "coding"]);
export type CalibrationFailureStage = z.infer<
  typeof calibrationFailureStageSchema
>;

export const calibrationFailureCodeSchema = z.enum([
  "LLM_HTTP_ERROR",
  "LLM_NETWORK_FAILED",
  "LLM_FIRST_OUTPUT_TIMEOUT",
  "LLM_OUTPUT_IDLE_TIMEOUT",
  "LLM_TOTAL_TIMEOUT",
  "LLM_STREAM_INTERRUPTED",
  "LLM_RESPONSE_BODY_TOO_LARGE",
  "LLM_RESPONSE_FORMAT_INVALID",
  "LLM_JSON_OUTPUT_INVALID",
  "PARSE_ERROR",
  "VALIDATION_ERROR",
  "REQUEST_ABORTED",
  "UNEXPECTED_ERROR"
]);
export type CalibrationFailureCode = z.infer<
  typeof calibrationFailureCodeSchema
>;

export const calibrationFailureCountSchema = z
  .object({
    stage: calibrationFailureStageSchema,
    errorCode: calibrationFailureCodeSchema,
    status: z.number().int().min(100).max(599).nullable(),
    count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.errorCode === "LLM_HTTP_ERROR" &&
      value.status !== null &&
      value.status >= 200 &&
      value.status <= 299
    ) {
      context.addIssue({
        code: "custom",
        message: "模型服务的 HTTP 错误不能使用成功状态码。"
      });
    }
    if (value.errorCode !== "LLM_HTTP_ERROR" && value.status !== null) {
      context.addIssue({
        code: "custom",
        message: "只有模型服务的 HTTP 错误可以保存状态码。"
      });
    }
  });
export type CalibrationFailureCount = z.infer<
  typeof calibrationFailureCountSchema
>;

const legacyCalibrationFailureCountSchema = z
  .object({
    stage: calibrationFailureStageSchema,
    errorCode: z.literal("LLM_REQUEST_FAILED"),
    status: z.null(),
    count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .strict();
type LegacyCalibrationFailureCount = z.infer<
  typeof legacyCalibrationFailureCountSchema
>;

export interface CalibrationCheckpointState {
  readonly progress: readonly CalibrationProgress[];
  readonly failureCounts: readonly CalibrationFailureCount[];
}

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
  readonly outputIdleTimeoutMs: number;
  readonly firstOutputTimeoutMs: number;
  readonly maximumDurationMs: number;
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
  readonly outputIdleTimeoutMs: number;
  readonly firstOutputTimeoutMs: number;
  readonly maximumDurationMs: number;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly concurrency: number;
}

const savedCheckpointSchema = z
  .object({
    schemaVersion: z.literal(3),
    label: calibrationLabelSchema,
    profileName: calibrationProfileNameSchema,
    fingerprint: levelsExperimentFingerprintSchema,
    progress: z.array(calibrationProgressSchema),
    failureCounts: z.array(calibrationFailureCountSchema)
  })
  .strict();

const savedCheckpointReadSchema = z
  .object({
    schemaVersion: z.literal(3),
    label: calibrationLabelSchema,
    profileName: calibrationProfileNameSchema,
    fingerprint: levelsExperimentFingerprintSchema,
    progress: z.array(calibrationProgressSchema),
    failureCounts: z.array(
      z.union([
        calibrationFailureCountSchema,
        legacyCalibrationFailureCountSchema
      ])
    )
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
  | "LEVELS_CHECKPOINT_VERSION_UNSUPPORTED"
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
  LEVELS_CHECKPOINT_VERSION_UNSUPPORTED: "指定的标定检查点版本不再支持续跑。",
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
  readonly outputIdleTimeoutMs: number;
  readonly firstOutputTimeoutMs: number;
  readonly maximumDurationMs: number;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly concurrency: number;
}): LevelsRunConfiguration {
  const configuration = {
    providerBaseUrls: {
      solver: input.solverBaseUrl,
      analyst: input.analystBaseUrl,
      coding: input.codingBaseUrl
    },
    outputIdleTimeoutMs: input.outputIdleTimeoutMs,
    firstOutputTimeoutMs: input.firstOutputTimeoutMs,
    maximumDurationMs: input.maximumDurationMs,
    maxAttempts: input.maxAttempts,
    baseDelayMs: input.baseDelayMs,
    concurrency: input.concurrency
  };
  assertSafeLevelsRunConfiguration(configuration);
  return configuration;
}

export function buildLevelsReportRunConfiguration(input: {
  readonly runConfiguration: LevelsRunConfiguration;
  readonly providerNames: {
    readonly solver: string;
    readonly analyst: string;
    readonly coding: string;
  };
}): LevelsReportRunConfiguration {
  assertSafeLevelsRunConfiguration(input.runConfiguration);
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
    outputIdleTimeoutMs: input.runConfiguration.outputIdleTimeoutMs,
    firstOutputTimeoutMs: input.runConfiguration.firstOutputTimeoutMs,
    maximumDurationMs: input.runConfiguration.maximumDurationMs,
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
    assertSafeLevelsRunConfiguration(input.runConfiguration);
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
  value: { readonly contestId: number; readonly index: string }
): string {
  return `${value.contestId}:${value.index}`;
}

export function calibrationFailureCountKey(
  value: {
    readonly stage: CalibrationFailureStage;
    readonly errorCode: string;
    readonly status: number | null;
  }
): string {
  return `${value.stage}:${value.errorCode}:${value.status ?? "none"}`;
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
}): CalibrationCheckpointState {
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
  const parsedSchemaVersion =
    typeof parsedJson === "object" &&
    parsedJson !== null &&
    "schemaVersion" in parsedJson
      ? (parsedJson as { readonly schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (
    typeof parsedSchemaVersion === "number" &&
    Number.isInteger(parsedSchemaVersion) &&
    parsedSchemaVersion !== 3
  ) {
    throw new LevelsCalibrationStateError(
      "LEVELS_CHECKPOINT_VERSION_UNSUPPORTED"
    );
  }
  const parsed = savedCheckpointReadSchema.safeParse(parsedJson);
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
  if (expectedRatings.size !== input.expectedItems.length) {
    throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
  }
  const seenKeys = new Set<string>();
  for (const progress of parsed.data.progress) {
    const key = calibrationRowKey(progress);
    if (
      seenKeys.has(key) ||
      expectedRatings.get(key) !== progress.rating
    ) {
      throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
    }
    seenKeys.add(key);
  }
  assertUniqueLoadedFailureCounts(parsed.data.failureCounts);
  const failureCounts = normalizeLoadedFailureCounts(
    parsed.data.failureCounts
  );
  return {
    progress: parsed.data.progress,
    failureCounts
  };
}

export function writeCalibrationCheckpoint(input: {
  readonly target: URL;
  readonly label: string;
  readonly profileName: string;
  readonly fingerprint: LevelsExperimentFingerprint;
  readonly progress: readonly CalibrationProgress[];
  readonly failureCounts: readonly CalibrationFailureCount[];
}): void {
  const candidate = {
    schemaVersion: 3,
    label: input.label,
    profileName: input.profileName,
    fingerprint: input.fingerprint,
    progress: input.progress,
    failureCounts: input.failureCounts
  } as const;
  const parsed = savedCheckpointSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
  }
  assertUniqueProgress(parsed.data.progress);
  assertUniqueFailureCounts(parsed.data.failureCounts);
  writeJsonAtomically(input.target, parsed.data);
}

export function completeCalibrationRows(
  progressEntries: readonly CalibrationProgress[]
): CalibrationRow[] {
  const rows: CalibrationRow[] = [];
  for (const entry of progressEntries) {
    if (entry.thinking === undefined || entry.coding === undefined) {
      continue;
    }
    rows.push(
      calibrationRowSchema.parse({
        contestId: entry.contestId,
        index: entry.index,
        rating: entry.rating,
        thinkingLevel: entry.thinking.level,
        thinkingSignals: entry.thinking.signals,
        codingLevel: entry.coding.level,
        codingSignals: entry.coding.signals
      })
    );
  }
  return rows;
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

function assertUniqueProgress(
  progressEntries: readonly CalibrationProgress[]
): void {
  const seenKeys = new Set<string>();
  for (const progress of progressEntries) {
    const key = calibrationRowKey(progress);
    if (seenKeys.has(key)) {
      throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
    }
    seenKeys.add(key);
  }
}

function assertUniqueFailureCounts(
  failureCounts: readonly CalibrationFailureCount[]
): void {
  const seenKeys = new Set<string>();
  for (const failure of failureCounts) {
    const key = calibrationFailureCountKey(failure);
    if (seenKeys.has(key)) {
      throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
    }
    seenKeys.add(key);
  }
}

function assertUniqueLoadedFailureCounts(
  failureCounts: readonly (
    | CalibrationFailureCount
    | LegacyCalibrationFailureCount
  )[]
): void {
  const keys = failureCounts.map(calibrationFailureCountKey);
  if (new Set(keys).size !== keys.length) {
    throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
  }
}

/**
 * 旧检查点的笼统错误码无法可靠区分网络失败和各类等待超时。读取时将它归入
 * 未知错误并合并计数；新检查点和报告不再允许写回旧码。
 */
function normalizeLoadedFailureCounts(
  failureCounts: readonly (
    | CalibrationFailureCount
    | LegacyCalibrationFailureCount
  )[]
): CalibrationFailureCount[] {
  const normalizedByKey = new Map<string, CalibrationFailureCount>();
  for (const failure of failureCounts) {
    const normalized = calibrationFailureCountSchema.safeParse({
      ...failure,
      errorCode:
        failure.errorCode === "LLM_REQUEST_FAILED"
          ? "UNEXPECTED_ERROR"
          : failure.errorCode
    });
    if (!normalized.success) {
      throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
    }
    const key = calibrationFailureCountKey(normalized.data);
    const count = (normalizedByKey.get(key)?.count ?? 0) + normalized.data.count;
    const merged = calibrationFailureCountSchema.safeParse({
      ...normalized.data,
      count
    });
    if (!merged.success) {
      throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
    }
    normalizedByKey.set(key, merged.data);
  }
  return [...normalizedByKey.values()].sort((left, right) =>
    calibrationFailureCountKey(left).localeCompare(
      calibrationFailureCountKey(right)
    )
  );
}

function assertSafeLevelsRunConfiguration(
  configuration: LevelsRunConfiguration
): void {
  const baseUrls = Object.values(configuration.providerBaseUrls);
  const addressesAreSafe = baseUrls.every((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.username.length === 0 &&
        parsed.password.length === 0 &&
        parsed.search.length === 0 &&
        parsed.hash.length === 0
      );
    } catch {
      return false;
    }
  });
  if (
    !addressesAreSafe ||
    !Number.isSafeInteger(configuration.outputIdleTimeoutMs) ||
    configuration.outputIdleTimeoutMs < 10 * 60 * 1_000 ||
    configuration.outputIdleTimeoutMs > 24 * 60 * 60 * 1_000 ||
    !Number.isSafeInteger(configuration.firstOutputTimeoutMs) ||
    configuration.firstOutputTimeoutMs < 30 * 60 * 1_000 ||
    configuration.firstOutputTimeoutMs > 24 * 60 * 60 * 1_000 ||
    !Number.isSafeInteger(configuration.maximumDurationMs) ||
    configuration.maximumDurationMs < 4 * 60 * 60 * 1_000 ||
    configuration.maximumDurationMs > 24 * 60 * 60 * 1_000 ||
    configuration.maximumDurationMs < configuration.outputIdleTimeoutMs ||
    configuration.maximumDurationMs < configuration.firstOutputTimeoutMs ||
    !Number.isSafeInteger(configuration.maxAttempts) ||
    configuration.maxAttempts < 1 ||
    configuration.maxAttempts > 10 ||
    !Number.isSafeInteger(configuration.baseDelayMs) ||
    configuration.baseDelayMs < 1 ||
    configuration.baseDelayMs > 60_000 ||
    !Number.isSafeInteger(configuration.concurrency) ||
    configuration.concurrency < 1 ||
    configuration.concurrency > 32
  ) {
    throw new LevelsCalibrationStateError(
      "LEVELS_FINGERPRINT_BUILD_FAILED"
    );
  }
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
