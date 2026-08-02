import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  DATA_STRUCTURE_SIGNATURES,
  mapCodingSignalsToLevel
} from "../../src/pipelines/coding";
import { mapThinkingSignalsToLevel } from "../../src/pipelines/thinking";
import {
  assertBlindContentDataset,
  assertBlindContentGoldBinding,
  type BlindContentDataset,
  type BlindGoldDataset
} from "./blind-evaluation";

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
export const calibrationSafeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
export const calibrationRunIdSchema = z
  .string()
  .uuid()
  .refine((value) => value !== "00000000-0000-0000-0000-000000000000");
const humanLevelSchema = z.number().int().min(1).max(5);

export const calibrationDatasetItemSchema = z
  .object({
    safeId: calibrationSafeIdSchema,
    contestId: z.number().int().positive(),
    index: codeforcesProblemIndexSchema,
    rating: z.number().int().positive(),
    humanThinkingLevel: humanLevelSchema,
    humanCodingLevel: humanLevelSchema,
    statement: z.string().min(1),
    editorial: z.string().min(1)
  })
  .strict();
export type CalibrationDatasetItem = z.infer<typeof calibrationDatasetItemSchema>;

export const calibrationBlindGoldSchema = z
  .object({
    contestId: z.number().int().positive(),
    index: codeforcesProblemIndexSchema,
    rating: z.number().int().positive(),
    humanThinkingLevel: humanLevelSchema,
    humanCodingLevel: humanLevelSchema
  })
  .strict();
export type CalibrationBlindGold = z.infer<typeof calibrationBlindGoldSchema>;

const calibrationDatasetCandidateSchema = z
  .object({
    safeId: calibrationSafeIdSchema.optional(),
    contestId: z.number().int().positive(),
    index: codeforcesProblemIndexSchema,
    rating: z.number().int().positive(),
    humanThinkingLevel: humanLevelSchema,
    humanCodingLevel: humanLevelSchema,
    statement: z.string().min(1),
    editorial: z.unknown().optional()
  })
  .strict();

const calibrationDatasetManifestEntrySchema = z
  .object({
    safeId: calibrationSafeIdSchema,
    fileName: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/),
    sha256: digestSchema
  })
  .strict();

export const calibrationDatasetManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    datasetId: calibrationSafeIdSchema,
    entries: z
      .array(calibrationDatasetManifestEntrySchema)
      .min(1)
      .max(10_000)
  })
  .strict()
  .superRefine((value, context) => {
    const safeIds = value.entries.map((entry) => entry.safeId);
    const fileNames = value.entries.map((entry) => entry.fileName);
    if (new Set(safeIds).size !== safeIds.length) {
      context.addIssue({
        code: "custom",
        message: "标定集清单中的安全编号不能重复。"
      });
    }
    if (new Set(fileNames).size !== fileNames.length) {
      context.addIssue({
        code: "custom",
        message: "标定集清单中的文件不能重复。"
      });
    }
  });
export type CalibrationDatasetManifest = z.infer<
  typeof calibrationDatasetManifestSchema
>;

export interface CalibrationDatasetFile {
  readonly fileName: string;
  readonly content: Uint8Array;
}

export interface CalibrationDatasetBundle {
  readonly datasetId: string;
  readonly manifestHash: string;
  readonly items: readonly CalibrationDatasetItem[];
}

export interface CalibrationDatasetDirectoryLoadHooks {
  /** 仅供合成竞态测试；生产调用不得传入。 */
  readonly afterInitialDirectoryCheck?: () => void;
  /** 仅供合成竞态测试；生产调用不得传入。 */
  readonly beforeFinalDirectoryCheck?: () => void;
}

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

export const blindCalibrationProgressSchema = z
  .object({
    safeId: calibrationSafeIdSchema,
    contentHash: digestSchema,
    thinking: calibrationThinkingResultSchema.optional(),
    coding: calibrationCodingResultSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.thinking === undefined && value.coding === undefined) {
      context.addIssue({
        code: "custom",
        message: "盲标定检查点只保存至少完成一个阶段的题目。"
      });
    }
    if (value.coding !== undefined && value.thinking === undefined) {
      context.addIssue({
        code: "custom",
        message: "代码阶段结果不能脱离思维阶段结果保存。"
      });
    }
  });
export type BlindCalibrationProgress = z.infer<
  typeof blindCalibrationProgressSchema
>;

export const calibrationProgressSchema = z
  .object({
    safeId: calibrationSafeIdSchema,
    contestId: z.number().int().positive(),
    index: codeforcesProblemIndexSchema,
    rating: z.number().int().positive(),
    humanThinkingLevel: humanLevelSchema,
    humanCodingLevel: humanLevelSchema,
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
    safeId: calibrationSafeIdSchema,
    contestId: z.number().int().positive(),
    index: codeforcesProblemIndexSchema,
    rating: z.number().int().positive(),
    humanThinkingLevel: humanLevelSchema,
    humanCodingLevel: humanLevelSchema,
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
  "LLM_CANCELLED",
  "LLM_OUTPUT_LENGTH_LIMIT",
  "LLM_OUTPUT_CONTENT_FILTERED",
  "LLM_RESPONSE_BODY_TOO_LARGE",
  "LLM_RESPONSE_FORMAT_INVALID",
  "LLM_JSON_OUTPUT_INVALID",
  "PARSE_ERROR",
  "VALIDATION_ERROR",
  "REQUEST_ABORTED",
  "HISTORICAL_SKIP",
  "STALE_IN_FLIGHT",
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

export const calibrationActiveStageSchema = z
  .object({
    safeId: calibrationSafeIdSchema,
    stage: calibrationFailureStageSchema
  })
  .strict();
export type CalibrationActiveStage = z.infer<
  typeof calibrationActiveStageSchema
>;

export interface CalibrationCheckpointState {
  readonly progress: readonly BlindCalibrationProgress[];
  readonly failureCounts: readonly CalibrationFailureCount[];
  readonly activeStages: readonly CalibrationActiveStage[];
}

export interface LoadedCalibrationCheckpoint
  extends CalibrationCheckpointState {
  readonly chainRunId: string;
  readonly activeStages: readonly CalibrationActiveStage[];
}

export const levelsExperimentFingerprintSchema = z
  .object({
    schemaVersion: z.literal(2),
    datasetManifestHash: digestSchema,
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
  /** 首个有效输出前（含明确 429 的重试等待）的最终保护；开始有效输出后清除。 */
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
  /** 首个有效输出前（含明确 429 的重试等待）的最终保护；不是持续输出的总时限。 */
  readonly maximumDurationMs: number;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly concurrency: number;
}

const savedCheckpointSchema = z
  .object({
    schemaVersion: z.literal(5),
    label: calibrationLabelSchema,
    profileName: calibrationProfileNameSchema,
    chainRunId: calibrationRunIdSchema,
    fingerprint: levelsExperimentFingerprintSchema,
    progress: z.array(blindCalibrationProgressSchema),
    activeStages: z.array(calibrationActiveStageSchema),
    failureCounts: z.array(calibrationFailureCountSchema)
  })
  .strict();

export type LevelsDataIssueCode =
  | "LEVELS_DATA_MANIFEST_INVALID"
  | "LEVELS_DATA_MANIFEST_MISMATCH"
  | "LEVELS_DATA_HASH_MISMATCH"
  | "LEVELS_DATA_MINIMUM_NOT_MET"
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
  | "LEVELS_BLIND_CONTENT_MISMATCH"
  | "LEVELS_BLIND_GOLD_MISMATCH"
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
  | "LEVELS_LOCK_FAILED"
  | "LEVELS_RESUME_SOURCE_LOCKED"
  | "LEVELS_CROSS_LABEL_RESUME_UNSUPPORTED"
  | "LEVELS_REPORT_RUN_ALREADY_USED";

const safeErrorMessages: Readonly<Record<LevelsCalibrationStateErrorCode, string>> = {
  LEVELS_DATA_DIRECTORY_UNREADABLE: "无法读取标定集目录。",
  LEVELS_DATA_READ_FAILED: "无法读取标定集文件。",
  LEVELS_DATASET_EMPTY: "标定集为空。",
  LEVELS_DATA_PRECHECK_FAILED: "标定集预检失败。",
  LEVELS_BLIND_CONTENT_MISMATCH: "标定推理内容与评分样本身份不一致。",
  LEVELS_BLIND_GOLD_MISMATCH: "标定推理结果与独立评分答案不一致。",
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
  LEVELS_LOCK_FAILED: "无法创建标定任务运行锁。",
  LEVELS_RESUME_SOURCE_LOCKED: "续跑来源仍有标定任务在运行。",
  LEVELS_CROSS_LABEL_RESUME_UNSUPPORTED:
    "跨标签复制检查点已停用；只能续跑当前标签。",
  LEVELS_REPORT_RUN_ALREADY_USED: "本次报告编号已经存在结果文件。"
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
 * 只允许同标签沿唯一检查点继续。跨标签复制会让同一祖先产生多个分支，其中一个
 * 分支的失败证据可能被另一个分支绕开，因此在读取数据或发起模型请求前一律拒绝。
 */
export function assertLevelsResumeModeSupported(input: {
  readonly label: string;
  readonly resumeFromLabel: string | null;
}): void {
  if (
    input.resumeFromLabel !== null &&
    input.resumeFromLabel !== input.label
  ) {
    throw new LevelsCalibrationStateError(
      "LEVELS_CROSS_LABEL_RESUME_UNSUPPORTED"
    );
  }
}

/**
 * 在任何模型请求发出前一次性检查全部输入。错误只按种类计数，不保留文件名、
 * JSON 片段或字段内容，避免错误信息带出题面和题解。
 */
export function parseCalibrationDatasetManifest(
  document: string
): CalibrationDatasetManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(document) as unknown;
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_DATA_PRECHECK_FAILED", [
      { code: "LEVELS_DATA_MANIFEST_INVALID", count: 1 }
    ]);
  }
  const parsed = calibrationDatasetManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LevelsCalibrationStateError("LEVELS_DATA_PRECHECK_FAILED", [
      { code: "LEVELS_DATA_MANIFEST_INVALID", count: 1 }
    ]);
  }
  if (parsed.data.entries.length < 60) {
    throw new LevelsCalibrationStateError("LEVELS_DATA_PRECHECK_FAILED", [
      { code: "LEVELS_DATA_MINIMUM_NOT_MET", count: 60 - parsed.data.entries.length }
    ]);
  }
  return parsed.data;
}

const CALIBRATION_DATASET_MANIFEST_FILE_NAME = "manifest.private.json";

/**
 * 从固定目录描述符读取完整数据集，避免“先检查路径、后沿路径读取”时文件被换成
 * 符号链接。两次精确目录扫描夹住全部读取；真正发送给模型的是这里固定到内存的
 * 字节，不会在付费阶段重新按路径读取。
 */
export function loadCalibrationDatasetDirectory(
  directory: URL,
  hooks: CalibrationDatasetDirectoryLoadHooks = {}
): CalibrationDatasetBundle {
  let directoryDescriptor: number;
  try {
    directoryDescriptor = openSync(
      fileURLToPath(directory),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    if (!fstatSync(directoryDescriptor).isDirectory()) {
      throw new Error("not-directory");
    }
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_DATA_DIRECTORY_UNREADABLE");
  }

  try {
    let manifestContent: Uint8Array;
    let manifestDocument: string;
    try {
      manifestContent = readPinnedDatasetFile(
        directoryDescriptor,
        CALIBRATION_DATASET_MANIFEST_FILE_NAME
      );
      manifestDocument = new TextDecoder("utf-8", { fatal: true }).decode(
        manifestContent
      );
    } catch {
      throw new LevelsCalibrationStateError("LEVELS_DATA_PRECHECK_FAILED", [
        { code: "LEVELS_DATA_MANIFEST_MISMATCH", count: 1 }
      ]);
    }
    const manifest = parseCalibrationDatasetManifest(manifestDocument);
    const expectedNames = new Set([
      CALIBRATION_DATASET_MANIFEST_FILE_NAME,
      ...manifest.entries.map((entry) => entry.fileName)
    ]);
    assertExactDatasetDirectory(directoryDescriptor, expectedNames);
    runDatasetLoadHook(hooks.afterInitialDirectoryCheck);

    let files: CalibrationDatasetFile[];
    try {
      files = manifest.entries.map((entry) => ({
        fileName: entry.fileName,
        content: readPinnedDatasetFile(directoryDescriptor, entry.fileName)
      }));
    } catch {
      throw new LevelsCalibrationStateError("LEVELS_DATA_READ_FAILED");
    }

    runDatasetLoadHook(hooks.beforeFinalDirectoryCheck);
    assertExactDatasetDirectory(directoryDescriptor, expectedNames);
    for (const [index, entry] of manifest.entries.entries()) {
      let finalContent: Uint8Array;
      try {
        finalContent = readPinnedDatasetFile(
          directoryDescriptor,
          entry.fileName
        );
      } catch {
        throw new LevelsCalibrationStateError("LEVELS_DATA_READ_FAILED");
      }
      if (!bytesEqual(files[index]!.content, finalContent)) {
        throw new LevelsCalibrationStateError("LEVELS_DATA_PRECHECK_FAILED", [
          { code: "LEVELS_DATA_MANIFEST_MISMATCH", count: 1 }
        ]);
      }
    }
    let finalManifestContent: Uint8Array;
    try {
      finalManifestContent = readPinnedDatasetFile(
        directoryDescriptor,
        CALIBRATION_DATASET_MANIFEST_FILE_NAME
      );
    } catch {
      throw new LevelsCalibrationStateError("LEVELS_DATA_PRECHECK_FAILED", [
        { code: "LEVELS_DATA_MANIFEST_MISMATCH", count: 1 }
      ]);
    }
    if (!bytesEqual(manifestContent, finalManifestContent)) {
      throw new LevelsCalibrationStateError("LEVELS_DATA_PRECHECK_FAILED", [
        { code: "LEVELS_DATA_MANIFEST_MISMATCH", count: 1 }
      ]);
    }
    return preflightCalibrationDatasetBundle({
      manifestDocument,
      manifestContent,
      files
    });
  } finally {
    try {
      closeSync(directoryDescriptor);
    } catch {
      // 所有数据已固定在内存；关闭失败不能把文件系统原始信息带进日志。
    }
  }
}

/**
 * 按预登记清单逐字节绑定数据文件。清单外文件、缺失文件、改名或内容变更都会
 * 在调用模型前整体失败；错误只带固定码和数量，不带私有文件名。
 */
export function preflightCalibrationDatasetBundle(input: {
  readonly manifestDocument: string;
  readonly manifestContent?: Uint8Array;
  readonly files: readonly CalibrationDatasetFile[];
}): CalibrationDatasetBundle {
  const manifest = parseCalibrationDatasetManifest(input.manifestDocument);
  const expectedNames = manifest.entries.map((entry) => entry.fileName).sort();
  const actualNames = input.files.map((entry) => entry.fileName).sort();
  if (
    new Set(actualNames).size !== actualNames.length ||
    expectedNames.length !== actualNames.length ||
    expectedNames.some((name, index) => name !== actualNames[index])
  ) {
    throw new LevelsCalibrationStateError("LEVELS_DATA_PRECHECK_FAILED", [
      { code: "LEVELS_DATA_MANIFEST_MISMATCH", count: 1 }
    ]);
  }

  const filesByName = new Map(
    input.files.map((entry) => [entry.fileName, entry.content] as const)
  );
  let mismatchedHashes = 0;
  const contents: Uint8Array[] = [];
  const safeIds: string[] = [];
  for (const entry of manifest.entries) {
    const content = filesByName.get(entry.fileName);
    if (content === undefined) {
      throw new LevelsCalibrationStateError("LEVELS_DATA_PRECHECK_FAILED", [
        { code: "LEVELS_DATA_MANIFEST_MISMATCH", count: 1 }
      ]);
    }
    const actualHash = createHash("sha256")
      .update(content)
      .digest("hex");
    if (actualHash !== entry.sha256) {
      mismatchedHashes += 1;
    }
    contents.push(content);
    safeIds.push(entry.safeId);
  }
  if (mismatchedHashes > 0) {
    throw new LevelsCalibrationStateError("LEVELS_DATA_PRECHECK_FAILED", [
      { code: "LEVELS_DATA_HASH_MISMATCH", count: mismatchedHashes }
    ]);
  }
  let documents: string[];
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    documents = contents.map((content) => decoder.decode(content));
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_DATA_PRECHECK_FAILED", [
      { code: "LEVELS_DATA_JSON_INVALID", count: 1 }
    ]);
  }

  return {
    datasetId: manifest.datasetId,
    manifestHash: createHash("sha256")
      .update(input.manifestContent ?? input.manifestDocument)
      .digest("hex"),
    items: preflightCalibrationDocuments(documents, safeIds)
  };
}

export function preflightCalibrationDocuments(
  documents: readonly string[],
  safeIds?: readonly string[]
): CalibrationDatasetItem[] {
  if (documents.length === 0) {
    throw new LevelsCalibrationStateError("LEVELS_DATASET_EMPTY");
  }
  if (safeIds !== undefined && safeIds.length !== documents.length) {
    throw new LevelsCalibrationStateError("LEVELS_DATA_PRECHECK_FAILED", [
      { code: "LEVELS_DATA_MANIFEST_MISMATCH", count: 1 }
    ]);
  }

  const issueCounts = new Map<LevelsDataIssueCode, number>();
  const items: CalibrationDatasetItem[] = [];
  const seenKeys = new Set<string>();

  const recordIssue = (code: LevelsDataIssueCode): void => {
    issueCounts.set(code, (issueCounts.get(code) ?? 0) + 1);
  };

  for (const [documentIndex, document] of documents.entries()) {
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
    if (
      safeIds?.[documentIndex] !== undefined &&
      candidate.data.safeId !== undefined &&
      candidate.data.safeId !== safeIds[documentIndex]
    ) {
      recordIssue("LEVELS_DATA_MANIFEST_MISMATCH");
      continue;
    }

    const item = calibrationDatasetItemSchema.parse({
      ...candidate.data,
      safeId:
        safeIds?.[documentIndex] ??
        candidate.data.safeId ??
        `unregistered-${String(documentIndex + 1).padStart(6, "0")}`,
      editorial: candidate.data.editorial
    });
    const key = `${item.contestId}:${item.index}`;
    if (seenKeys.has(key)) {
      recordIssue("LEVELS_DATA_DUPLICATE");
      continue;
    }
    seenKeys.add(key);
    items.push(item);
  }

  if (new Set(items.map((item) => item.safeId)).size !== items.length) {
    recordIssue("LEVELS_DATA_DUPLICATE");
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
  readonly datasetManifestHash: string;
  readonly experimentVersion: string;
  readonly profileName: string;
  readonly profile: unknown;
  readonly runConfiguration: LevelsRunConfiguration;
  readonly pipelineSources: Readonly<Record<string, string>>;
  readonly calibrationProtocol: unknown;
}): LevelsExperimentFingerprint {
  try {
    assertSafeLevelsRunConfiguration(input.runConfiguration);
    const datasetManifestHash = input.datasetManifestHash;
    if (!digestSchema.safeParse(datasetManifestHash).success) {
      throw new Error("标定集清单摘要格式无效。");
    }
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
      schemaVersion: 2,
      datasetManifestHash,
      datasetHash,
      modelConfigurationHash,
      pipelineSourceHash
    });
    return {
      schemaVersion: 2,
      datasetManifestHash,
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
  value: {
    readonly safeId?: string;
    readonly contestId: number;
    readonly index: string;
  }
): string {
  return value.safeId === undefined
    ? `${value.contestId}:${value.index}`
    : `safe:${value.safeId}`;
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
  const runId =
    String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`;
  const rawArtifact = new RegExp(
    `^levels-${escapedLabel}-(?:checkpoint|${timestamp}|${runId}-snapshot)\\.json${temporarySuffix}$`
  );
  const resultArtifact = new RegExp(
    `^levels-${escapedLabel}-(?:summary\\.json|report\\.md|${runId}-(?:summary\\.json|report\\.md|completion\\.json))${temporarySuffix}$`
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
  readonly expectedContent: BlindContentDataset;
}): LoadedCalibrationCheckpoint {
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
    parsedSchemaVersion !== 5
  ) {
    throw new LevelsCalibrationStateError(
      "LEVELS_CHECKPOINT_VERSION_UNSUPPORTED"
    );
  }
  const parsed = savedCheckpointSchema.safeParse(parsedJson);
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

  let expectedContent: BlindContentDataset;
  try {
    expectedContent = assertBlindContentDataset(input.expectedContent);
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_BLIND_CONTENT_MISMATCH");
  }
  const expectedContentHashes = new Map(
    expectedContent.samples.map(
      (sample) => [sample.safeId, sample.problem.contentHash] as const
    )
  );
  if (expectedContentHashes.size !== expectedContent.samples.length) {
    throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
  }
  const seenKeys = new Set<string>();
  for (const progress of parsed.data.progress) {
    const key = progress.safeId;
    const expectedContentHash = expectedContentHashes.get(key);
    if (
      seenKeys.has(key) ||
      expectedContentHash === undefined ||
      expectedContentHash !== progress.contentHash
    ) {
      throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
    }
    seenKeys.add(key);
  }
  assertUniqueFailureCounts(parsed.data.failureCounts);
  assertUniqueActiveStages(parsed.data.activeStages);
  const failureCountsByKey = new Map(
    parsed.data.failureCounts.map(
      (failure) => [calibrationFailureCountKey(failure), failure] as const
    )
  );
  for (const active of parsed.data.activeStages) {
    if (!expectedContentHashes.has(active.safeId)) {
      throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
    }
    const stale: CalibrationFailureCount = {
      stage: active.stage,
      errorCode: "STALE_IN_FLIGHT",
      status: null,
      count: 1
    };
    const key = calibrationFailureCountKey(stale);
    const existing = failureCountsByKey.get(key);
    const merged = calibrationFailureCountSchema.safeParse({
      ...stale,
      count: (existing?.count ?? 0) + 1
    });
    if (!merged.success) {
      throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
    }
    failureCountsByKey.set(key, merged.data);
  }
  const failureCounts = [...failureCountsByKey.values()].sort((left, right) =>
    calibrationFailureCountKey(left).localeCompare(
      calibrationFailureCountKey(right)
    )
  );
  return {
    chainRunId: parsed.data.chainRunId,
    progress: parsed.data.progress,
    failureCounts,
    activeStages: []
  };
}

export function writeCalibrationCheckpoint(input: {
  readonly target: URL;
  readonly label: string;
  readonly profileName: string;
  readonly chainRunId: string;
  readonly fingerprint: LevelsExperimentFingerprint;
  readonly progress: readonly BlindCalibrationProgress[];
  readonly activeStages: readonly CalibrationActiveStage[];
  readonly failureCounts: readonly CalibrationFailureCount[];
}): void {
  const candidate = {
    schemaVersion: 5,
    label: input.label,
    profileName: input.profileName,
    chainRunId: input.chainRunId,
    fingerprint: input.fingerprint,
    progress: input.progress,
    activeStages: input.activeStages,
    failureCounts: input.failureCounts
  } as const;
  const parsed = savedCheckpointSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
  }
  assertUniqueProgress(parsed.data.progress);
  assertUniqueActiveStages(parsed.data.activeStages);
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
        safeId: entry.safeId,
        contestId: entry.contestId,
        index: entry.index,
        rating: entry.rating,
        humanThinkingLevel: entry.humanThinkingLevel,
        humanCodingLevel: entry.humanCodingLevel,
        thinkingLevel: entry.thinking.level,
        thinkingSignals: entry.thinking.signals,
        codingLevel: entry.coding.level,
        codingSignals: entry.coding.signals
      })
    );
  }
  return rows;
}

/**
 * 只有整批推理已经收束后，调用方才可用这个函数把盲检查点与 gold 连接成
 * 旧报告所需的评分进度。检查点、阶段事件和在途日志永远不接触返回值。
 */
export function joinBlindCalibrationProgressWithGold(input: {
  readonly content: BlindContentDataset;
  readonly gold: BlindGoldDataset<CalibrationBlindGold>;
  readonly progress: readonly BlindCalibrationProgress[];
}): CalibrationProgress[] {
  let content: BlindContentDataset;
  try {
    content = assertBlindContentGoldBinding(input.content, input.gold);
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_BLIND_GOLD_MISMATCH");
  }
  const contentHashes = new Map(
    content.samples.map(
      (sample) => [sample.safeId, sample.problem.contentHash] as const
    )
  );
  const goldBySafeId = new Map(
    input.gold.samples.map((sample) => [sample.safeId, sample.gold] as const)
  );
  const seen = new Set<string>();
  return input.progress.map((entry) => {
    const parsed = blindCalibrationProgressSchema.safeParse(entry);
    const expectedContentHash = contentHashes.get(entry.safeId);
    const gold = goldBySafeId.get(entry.safeId);
    if (
      !parsed.success ||
      seen.has(entry.safeId) ||
      expectedContentHash === undefined ||
      expectedContentHash !== entry.contentHash ||
      gold === undefined
    ) {
      throw new LevelsCalibrationStateError("LEVELS_BLIND_GOLD_MISMATCH");
    }
    seen.add(entry.safeId);
    return calibrationProgressSchema.parse({
      safeId: entry.safeId,
      ...gold,
      thinking: entry.thinking,
      coding: entry.coding
    });
  });
}

export function countCompleteBlindCalibrationProgress(
  progress: readonly BlindCalibrationProgress[]
): number {
  return progress.filter(
    (entry) => entry.thinking !== undefined && entry.coding !== undefined
  ).length;
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
    fsyncParentDirectory(targetPath);
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

export interface CalibrationReportArtifacts {
  readonly reportFileName: string;
  readonly summaryFileName: string;
  readonly completionFileName: string;
}

/**
 * 每次执行都以新的编号写一对报告；完成标记最后落盘并绑定两份文件的摘要。
 * 即使同标签续跑，也不会覆盖此前的成功或失败证据。
 */
export function writeCalibrationReportArtifacts(input: {
  readonly resultsDirectory: URL;
  readonly label: string;
  readonly executionRunId: string;
  readonly markdown: string;
  readonly summary: unknown;
}): CalibrationReportArtifacts {
  if (
    !calibrationLabelSchema.safeParse(input.label).success ||
    !calibrationRunIdSchema.safeParse(input.executionRunId).success
  ) {
    throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
  }
  const prefix = `levels-${input.label}-${input.executionRunId}`;
  const artifacts = {
    reportFileName: `${prefix}-report.md`,
    summaryFileName: `${prefix}-summary.json`,
    completionFileName: `${prefix}-completion.json`
  } as const;
  let existingNames: string[];
  try {
    existingNames = readdirSync(input.resultsDirectory);
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_OUTPUT_DIRECTORY_FAILED");
  }
  if (Object.values(artifacts).some((name) => existingNames.includes(name))) {
    throw new LevelsCalibrationStateError("LEVELS_REPORT_RUN_ALREADY_USED");
  }

  let summaryText: string;
  try {
    summaryText = JSON.stringify(input.summary, null, 2);
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_ATOMIC_WRITE_FAILED");
  }
  writeTextAtomically(
    new URL(artifacts.reportFileName, input.resultsDirectory),
    input.markdown
  );
  writeTextAtomically(
    new URL(artifacts.summaryFileName, input.resultsDirectory),
    summaryText
  );
  writeJsonAtomically(
    new URL(artifacts.completionFileName, input.resultsDirectory),
    {
      schemaVersion: 1,
      label: input.label,
      executionRunId: input.executionRunId,
      report: {
        fileName: artifacts.reportFileName,
        sha256: createHash("sha256")
          .update(input.markdown, "utf8")
          .digest("hex")
      },
      summary: {
        fileName: artifacts.summaryFileName,
        sha256: createHash("sha256")
          .update(summaryText, "utf8")
          .digest("hex")
      }
    }
  );
  return artifacts;
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

export function acquireLevelsResumeSourceLock(
  directory: URL,
  label: string
): LevelsLabelLock {
  try {
    return acquireLevelsLabelLock(directory, label);
  } catch (error) {
    if (
      error instanceof LevelsCalibrationStateError &&
      error.code === "LEVELS_LABEL_LOCKED"
    ) {
      throw new LevelsCalibrationStateError("LEVELS_RESUME_SOURCE_LOCKED");
    }
    throw error;
  }
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
  progressEntries: readonly BlindCalibrationProgress[]
): void {
  const seenKeys = new Set<string>();
  for (const progress of progressEntries) {
    const key = progress.safeId;
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

function assertUniqueActiveStages(
  activeStages: readonly CalibrationActiveStage[]
): void {
  const keys = activeStages.map(
    (active) => `${active.safeId}:${active.stage}`
  );
  if (new Set(keys).size !== keys.length) {
    throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
  }
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
    left.datasetManifestHash === right.datasetManifestHash &&
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

function readPinnedDatasetFile(
  directoryDescriptor: number,
  fileName: string
): Uint8Array {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/.test(fileName)) {
    throw new LevelsCalibrationStateError("LEVELS_DATA_READ_FAILED");
  }
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      datasetDescriptorPath(directoryDescriptor, fileName),
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new Error("not-regular");
    }
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(content.byteLength) !== after.size
    ) {
      throw new Error("file-changed");
    }
    return content;
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_DATA_READ_FAILED");
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // 只向调用方返回固定码，不包含路径或操作系统错误。
      }
    }
  }
}

function assertExactDatasetDirectory(
  directoryDescriptor: number,
  expectedNames: ReadonlySet<string>
): void {
  try {
    const directoryPath = datasetDescriptorPath(directoryDescriptor);
    const entries = readdirSync(directoryPath, { withFileTypes: true });
    if (
      entries.length !== expectedNames.size ||
      entries.some(
        (entry) => !entry.isFile() || !expectedNames.has(entry.name)
      )
    ) {
      throw new Error("directory-mismatch");
    }
    for (const name of expectedNames) {
      const metadata = lstatSync(
        datasetDescriptorPath(directoryDescriptor, name),
        { bigint: true }
      );
      if (!metadata.isFile()) {
        throw new Error("not-regular");
      }
    }
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_DATA_PRECHECK_FAILED", [
      { code: "LEVELS_DATA_MANIFEST_MISMATCH", count: 1 }
    ]);
  }
}

function datasetDescriptorPath(
  directoryDescriptor: number,
  fileName?: string
): string {
  const base = `/proc/self/fd/${directoryDescriptor}`;
  return fileName === undefined ? base : `${base}/${fileName}`;
}

function runDatasetLoadHook(hook: (() => void) | undefined): void {
  if (hook === undefined) {
    return;
  }
  try {
    hook();
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_DATA_PRECHECK_FAILED", [
      { code: "LEVELS_DATA_MANIFEST_MISMATCH", count: 1 }
    ]);
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function fsyncParentDirectory(targetPath: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      dirname(targetPath),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // 调用方会把同步失败转换成固定错误码；这里仅避免泄露路径信息。
      }
    }
  }
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
