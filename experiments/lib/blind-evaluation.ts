import { createHash } from "node:crypto";
import { z } from "zod";
import { robotReviewTaskSchema } from "../../src/urmotiv-schemas";
import { mapWithConcurrency } from "./concurrency";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const safeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/);

export const blindDatasetPurposeSchema = z.enum(["development", "holdout"]);
export type BlindDatasetPurpose = z.infer<typeof blindDatasetPurposeSchema>;

const blindProblemContentSampleSchema = z
  .object({
    safeId: safeIdSchema,
    problem: robotReviewTaskSchema.shape.problem
  })
  .strict();
export type BlindProblemContentSample = z.infer<
  typeof blindProblemContentSampleSchema
>;

const blindContentDocumentShape = {
  schemaVersion: z.literal(1),
  datasetId: safeIdSchema,
  purpose: blindDatasetPurposeSchema,
  samples: z.array(blindProblemContentSampleSchema).min(1).max(10_000)
} as const;

const blindContentDocumentSchema = z
  .object(blindContentDocumentShape)
  .strict()
  .superRefine((value, context) => {
    const safeIds = value.samples.map((sample) => sample.safeId);
    if (new Set(safeIds).size !== safeIds.length) {
      context.addIssue({
        code: "custom",
        path: ["samples"],
        message: "盲测内容的安全编号不能重复。"
      });
    }
  });

const blindContentDatasetSchema = z
  .object({
    ...blindContentDocumentShape,
    contentFingerprint: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    const safeIds = value.samples.map((sample) => sample.safeId);
    if (new Set(safeIds).size !== safeIds.length) {
      context.addIssue({
        code: "custom",
        path: ["samples"],
        message: "盲测内容的安全编号不能重复。"
      });
    }
  });

export interface BlindContentDataset {
  readonly schemaVersion: 1;
  readonly datasetId: string;
  readonly purpose: BlindDatasetPurpose;
  readonly contentFingerprint: string;
  readonly samples: readonly BlindProblemContentSample[];
}

export interface BlindGoldSample<TGold> {
  readonly safeId: string;
  readonly contentHash: string;
  readonly gold: TGold;
}

export interface BlindGoldDataset<TGold> {
  readonly schemaVersion: 1;
  readonly datasetId: string;
  readonly purpose: BlindDatasetPurpose;
  readonly contentFingerprint: string;
  readonly samples: readonly BlindGoldSample<TGold>[];
}

export interface BlindPrediction<TPrediction> {
  readonly safeId: string;
  readonly contentHash: string;
  readonly prediction: TPrediction;
}

export interface JoinedBlindEvaluationRow<TPrediction, TGold>
  extends BlindPrediction<TPrediction> {
  readonly gold: TGold;
}

export class BlindEvaluationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "BlindEvaluationError";
    this.code = code;
  }
}

/**
 * 内容文档必须独立于答案文档。strict schema 会在任何推理请求前拒绝把 rating、
 * 人工等级或预期结论等额外字段混进内容样本。
 */
export function loadBlindContentDocument(document: string): BlindContentDataset {
  try {
    const parsed = blindContentDocumentSchema.parse(
      JSON.parse(document) as unknown
    );
    return assertBlindContentDataset({
      ...parsed,
      contentFingerprint: hashCanonicalValue(parsed)
    });
  } catch {
    throw new BlindEvaluationError("BLIND_CONTENT_DOCUMENT_INVALID");
  }
}

/** 每次执行推理前都从完整容器重算指纹，禁止用对象 spread 偷换 samples。 */
export function assertBlindContentDataset(
  candidate: BlindContentDataset
): BlindContentDataset {
  let parsed: z.infer<typeof blindContentDatasetSchema>;
  try {
    parsed = blindContentDatasetSchema.parse(candidate);
  } catch {
    throw new BlindEvaluationError("BLIND_CONTENT_CONTAINER_INVALID");
  }
  const expectedFingerprint = hashCanonicalValue({
    schemaVersion: parsed.schemaVersion,
    datasetId: parsed.datasetId,
    purpose: parsed.purpose,
    samples: parsed.samples
  });
  if (parsed.contentFingerprint !== expectedFingerprint) {
    throw new BlindEvaluationError("BLIND_CONTENT_CONTAINER_IDENTITY_MISMATCH");
  }
  return deepFreeze(parsed);
}

/**
 * 为 resume 的 pending 样本显式建立新容器；派生 datasetId 同时绑定父指纹与
 * 精确样本集合，不能沿用父容器指纹却替换 samples。
 */
export function deriveBlindContentSubset(
  parentCandidate: BlindContentDataset,
  selectedSafeIds: readonly string[]
): BlindContentDataset {
  const parent = assertBlindContentDataset(parentCandidate);
  const selected = uniqueStringSet(selectedSafeIds);
  if (selected.size === 0) {
    throw new BlindEvaluationError("BLIND_CONTENT_SUBSET_EMPTY");
  }
  const samples = parent.samples.filter((sample) => selected.has(sample.safeId));
  if (samples.length !== selected.size) {
    throw new BlindEvaluationError("BLIND_CONTENT_SUBSET_MISMATCH");
  }
  const derivationFingerprint = createHash("sha256")
    .update(parent.contentFingerprint, "utf8")
    .update("\0", "utf8")
    .update([...selected].sort().join("\0"), "utf8")
    .digest("hex");
  return buildBlindContentDataset({
    datasetId: `subset-${derivationFingerprint.slice(0, 32)}`,
    purpose: parent.purpose,
    samples
  });
}

/**
 * gold 使用另一个文档和调用方提供的严格 schema；contentFingerprint/contentHash
 * 把两边绑定起来，但推理执行器从不接收这个返回值。
 */
export function loadBlindGoldDocument<TGold>(
  document: string,
  goldSchema: z.ZodType<TGold>
): BlindGoldDataset<TGold> {
  const schema = z
    .object({
      schemaVersion: z.literal(1),
      datasetId: safeIdSchema,
      purpose: blindDatasetPurposeSchema,
      contentFingerprint: digestSchema,
      samples: z
        .array(
          z
            .object({
              safeId: safeIdSchema,
              contentHash: digestSchema,
              gold: goldSchema
            })
            .strict()
        )
        .min(1)
        .max(10_000)
    })
    .strict()
    .superRefine((value, context) => {
      const safeIds = value.samples.map((sample) => sample.safeId);
      if (new Set(safeIds).size !== safeIds.length) {
        context.addIssue({
          code: "custom",
          path: ["samples"],
          message: "盲测答案的安全编号不能重复。"
        });
      }
  });
  try {
    return deepFreeze(schema.parse(JSON.parse(document) as unknown));
  } catch {
    throw new BlindEvaluationError("BLIND_GOLD_DOCUMENT_INVALID");
  }
}

/** 从现有数据源建立只含题目内容的内存视图，供旧实验逐步迁移。 */
export function buildBlindContentDataset(input: {
  readonly datasetId: string;
  readonly purpose: BlindDatasetPurpose;
  readonly samples: readonly BlindProblemContentSample[];
}): BlindContentDataset {
  return loadBlindContentDocument(
    JSON.stringify({
      schemaVersion: 1,
      datasetId: input.datasetId,
      purpose: input.purpose,
      samples: input.samples
    })
  );
}

/** 建立只供推理结束后评分使用的答案视图。 */
export function buildBlindGoldDataset<TGold>(input: {
  readonly content: BlindContentDataset;
  readonly samples: readonly BlindGoldSample<TGold>[];
  readonly goldSchema: z.ZodType<TGold>;
}): BlindGoldDataset<TGold> {
  const gold = loadBlindGoldDocument(
    JSON.stringify({
      schemaVersion: 1,
      datasetId: input.content.datasetId,
      purpose: input.content.purpose,
      contentFingerprint: input.content.contentFingerprint,
      samples: input.samples
    }),
    input.goldSchema
  );
  assertBlindContentGoldBinding(input.content, gold);
  return gold;
}

/** 在任何推理请求前验证两个逻辑文档是一一对应的同一数据集。 */
export function assertBlindContentGoldBinding<TGold>(
  contentCandidate: BlindContentDataset,
  gold: BlindGoldDataset<TGold>
): BlindContentDataset {
  const content = assertBlindContentDataset(contentCandidate);
  if (
    gold.datasetId !== content.datasetId ||
    gold.purpose !== content.purpose ||
    gold.contentFingerprint !== content.contentFingerprint
  ) {
    throw new BlindEvaluationError("BLIND_CONTENT_GOLD_IDENTITY_MISMATCH");
  }
  const goldBySafeId = uniqueBySafeId(gold.samples);
  if (goldBySafeId.size !== content.samples.length) {
    throw new BlindEvaluationError("BLIND_EVALUATION_SAMPLE_SET_MISMATCH");
  }
  for (const sample of content.samples) {
    const expected = goldBySafeId.get(sample.safeId);
    if (
      expected === undefined ||
      expected.contentHash !== sample.problem.contentHash
    ) {
      throw new BlindEvaluationError("BLIND_EVALUATION_SAMPLE_SET_MISMATCH");
    }
  }
  return content;
}

/**
 * 唯一允许发起推理的通用执行器。infer 回调拿到的是结构化克隆并递归冻结后的
 * content sample；gold、数据集用途和预期结论都不在参数对象中。
 */
export async function runBlindInference<TPrediction>(input: {
  readonly content: BlindContentDataset;
  readonly concurrency: number;
  readonly beforeInference?: (
    sample: Readonly<BlindProblemContentSample>,
    index: number
  ) => void | Promise<void>;
  readonly infer: (
    sample: Readonly<BlindProblemContentSample>,
    index: number
  ) => Promise<TPrediction>;
  readonly afterInference?: (
    prediction: BlindPrediction<TPrediction>,
    index: number
  ) => void | Promise<void>;
  readonly onInferenceError?: (
    sample: Readonly<BlindProblemContentSample>,
    error: unknown,
    index: number
  ) => void | Promise<void>;
}): Promise<BlindPrediction<TPrediction>[]> {
  // 这一行必须先于 beforeInference/infer/afterInference/onInferenceError 的任何调用。
  const verifiedContent = assertBlindContentDataset(input.content);
  const isolatedSamples = verifiedContent.samples.map((sample) =>
    deepFreeze(structuredClone(sample))
  );
  // mapWithConcurrency 只有在 worker 真正 reject 后才停止分配；错误回调可能需要
  // 异步持久化。在这段窗口内必须由本地闸门阻止其他 worker 发起新的付费请求。
  let stopStartingInference = false;
  return mapWithConcurrency(
    isolatedSamples,
    input.concurrency,
    async (sample, index) => {
      if (stopStartingInference) {
        throw new BlindEvaluationError("BLIND_INFERENCE_STOPPED");
      }
      try {
        await input.beforeInference?.(sample, index);
      } catch (error) {
        stopStartingInference = true;
        throw error;
      }
      // beforeInference 可以是异步的；等待期间另一条请求可能已经失败并关闸。
      if (stopStartingInference) {
        throw new BlindEvaluationError("BLIND_INFERENCE_STOPPED");
      }
      let prediction: TPrediction;
      try {
        prediction = await input.infer(sample, index);
      } catch (error) {
        // 必须先关闸，再等待可能异步的失败持久化回调。
        stopStartingInference = true;
        await input.onInferenceError?.(sample, error, index);
        throw error;
      }
      const row = {
        safeId: sample.safeId,
        contentHash: sample.problem.contentHash,
        prediction
      };
      try {
        await input.afterInference?.(row, index);
      } catch (error) {
        stopStartingInference = true;
        throw error;
      }
      return row;
    }
  );
}

/** 只有全部推理返回后，评分进程才把预测与答案对账。 */
export function joinBlindPredictionsWithGold<TPrediction, TGold>(input: {
  readonly content: BlindContentDataset;
  readonly gold: BlindGoldDataset<TGold>;
  readonly predictions: readonly BlindPrediction<TPrediction>[];
}): JoinedBlindEvaluationRow<TPrediction, TGold>[] {
  return joinPredictionsWithGold(input, true);
}

/** 不完整失败链只评分已经冻结的预测，但仍先核对完整父 content/gold 身份。 */
export function joinBlindPredictionSubsetWithGold<TPrediction, TGold>(input: {
  readonly content: BlindContentDataset;
  readonly gold: BlindGoldDataset<TGold>;
  readonly predictions: readonly BlindPrediction<TPrediction>[];
}): JoinedBlindEvaluationRow<TPrediction, TGold>[] {
  return joinPredictionsWithGold(input, false);
}

function joinPredictionsWithGold<TPrediction, TGold>(input: {
  readonly content: BlindContentDataset;
  readonly gold: BlindGoldDataset<TGold>;
  readonly predictions: readonly BlindPrediction<TPrediction>[];
}, requireComplete: boolean): JoinedBlindEvaluationRow<TPrediction, TGold>[] {
  const content = assertBlindContentGoldBinding(input.content, input.gold);
  const goldBySafeId = uniqueBySafeId(input.gold.samples);
  const predictionsBySafeId = uniqueBySafeId(input.predictions);
  const contentSafeIds = new Set(content.samples.map((sample) => sample.safeId));
  if (
    goldBySafeId.size !== content.samples.length ||
    (requireComplete && predictionsBySafeId.size !== content.samples.length) ||
    [...predictionsBySafeId.keys()].some((safeId) => !contentSafeIds.has(safeId))
  ) {
    throw new BlindEvaluationError("BLIND_EVALUATION_SAMPLE_SET_MISMATCH");
  }
  return content.samples.flatMap((sample) => {
    const gold = goldBySafeId.get(sample.safeId);
    const prediction = predictionsBySafeId.get(sample.safeId);
    if (!requireComplete && prediction === undefined) {
      return [];
    }
    if (
      gold === undefined ||
      prediction === undefined ||
      gold.contentHash !== sample.problem.contentHash ||
      prediction.contentHash !== sample.problem.contentHash
    ) {
      throw new BlindEvaluationError("BLIND_EVALUATION_SAMPLE_SET_MISMATCH");
    }
    return [{ ...prediction, gold: gold.gold }];
  });
}

export interface BlindDatasetIdentity {
  readonly datasetId: string;
  readonly purpose: BlindDatasetPurpose;
  /** 不透明样本身份；公开题可使用题号，私有题必须先哈希。 */
  readonly sampleKeys: readonly string[];
}

/**
 * 开发集、真正盲测集和锚点必须是不同身份且样本无交集。这样 public83 之类
 * 反复调参使用的数据不会被误报成 holdout（未参与调参的最终盲测集）。
 */
export function assertBlindDatasetSeparation(input: {
  readonly development: BlindDatasetIdentity;
  readonly holdout: BlindDatasetIdentity;
  readonly anchorKeys: readonly string[];
}): void {
  if (
    input.development.purpose !== "development" ||
    input.holdout.purpose !== "holdout" ||
    input.development.datasetId === input.holdout.datasetId
  ) {
    throw new BlindEvaluationError("BLIND_DATASET_ROLE_MISMATCH");
  }
  const development = uniqueStringSet(input.development.sampleKeys);
  const holdout = uniqueStringSet(input.holdout.sampleKeys);
  const anchors = uniqueStringSet(input.anchorKeys);
  if (
    intersects(development, holdout) ||
    intersects(development, anchors) ||
    intersects(holdout, anchors)
  ) {
    throw new BlindEvaluationError("BLIND_DATASET_SAMPLE_OVERLAP");
  }
}

function uniqueBySafeId<T extends { readonly safeId: string }>(
  samples: readonly T[]
): Map<string, T> {
  const result = new Map<string, T>();
  for (const sample of samples) {
    if (result.has(sample.safeId)) {
      throw new BlindEvaluationError("BLIND_EVALUATION_SAMPLE_SET_MISMATCH");
    }
    result.set(sample.safeId, sample);
  }
  return result;
}

function uniqueStringSet(values: readonly string[]): Set<string> {
  const result = new Set(values);
  if (result.size !== values.length || values.some((value) => value.length === 0)) {
    throw new BlindEvaluationError("BLIND_DATASET_IDENTITY_INVALID");
  }
  return result;
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

function hashCanonicalValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
