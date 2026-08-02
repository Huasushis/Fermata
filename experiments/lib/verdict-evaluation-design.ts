import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ReviewTaskItem, ReviewTaskProblem } from "../../src/pipelines/types";
import {
  assertBlindContentDataset,
  type BlindContentDataset,
  type BlindProblemContentSample
} from "./blind-evaluation";
import { mapWithConcurrency } from "./concurrency";
import { evaluationConfigurationFingerprint } from "./evaluation-integrity";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const contentSafeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/);
const caseSampleIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
export const verdictDiagnosticCaseKindSchema = z.enum([
  "normal",
  "fabricated_duplicate"
]);
export type VerdictDiagnosticCaseKind = z.infer<
  typeof verdictDiagnosticCaseKindSchema
>;

export const verdictBlindPredictionSchema = z
  .object({
    verdict: z.enum(["approve", "request_changes", "reject"]),
    forcedDuplicateReject: z.boolean(),
    highestKnownSimilarity: z.number().finite().min(0).max(1),
    appliedDuplicateSimilarityRejectThreshold: z.number().finite().min(0).max(1)
  })
  .strict();
export type VerdictBlindPrediction = z.infer<
  typeof verdictBlindPredictionSchema
>;

/** 推理阶段日志只能使用这些已校验预测字段。 */
export function verdictPredictionLogFields(
  candidate: VerdictBlindPrediction
): Pick<
  VerdictBlindPrediction,
  "verdict" | "forcedDuplicateReject" | "highestKnownSimilarity"
> {
  const prediction = verdictBlindPredictionSchema.parse(candidate);
  return {
    verdict: prediction.verdict,
    forcedDuplicateReject: prediction.forcedDuplicateReject,
    highestKnownSimilarity: prediction.highestKnownSimilarity
  };
}

export const verdictBlindPredictionRecordSchema = z
  .object({
    sampleId: caseSampleIdSchema,
    contentHash: digestSchema,
    prediction: verdictBlindPredictionSchema
  })
  .strict();
export type VerdictBlindPredictionRecord = z.infer<
  typeof verdictBlindPredictionRecordSchema
>;

export const verdictCaseGoldValueSchema = z
  .object({
    rating: z.number().int().positive(),
    expectedVerdict: z.enum(["not_reject", "reject"]),
    expectedForcedDuplicateReject: z.boolean()
  })
  .strict();
export type VerdictCaseGoldValue = z.infer<typeof verdictCaseGoldValueSchema>;

const verdictCaseGoldSampleSchema = z
  .object({
    sampleId: caseSampleIdSchema,
    contentSafeId: contentSafeIdSchema,
    contentHash: digestSchema,
    caseKind: verdictDiagnosticCaseKindSchema,
    gold: verdictCaseGoldValueSchema
  })
  .strict()
  .superRefine((sample, context) => {
    const expected = sample.caseKind === "normal"
      ? { expectedVerdict: "not_reject", expectedForcedDuplicateReject: false }
      : { expectedVerdict: "reject", expectedForcedDuplicateReject: true };
    if (
      sample.gold.expectedVerdict !== expected.expectedVerdict ||
      sample.gold.expectedForcedDuplicateReject !== expected.expectedForcedDuplicateReject
    ) {
      context.addIssue({
        code: "custom",
        path: ["gold"],
        message: "case gold 与诊断组身份不一致。"
      });
    }
  });
export type VerdictCaseGoldSample = z.infer<
  typeof verdictCaseGoldSampleSchema
>;

const verdictCaseGoldDatasetSchema = z
  .object({
    schemaVersion: z.literal(1),
    datasetId: contentSafeIdSchema,
    purpose: z.enum(["development", "holdout"]),
    contentFingerprint: digestSchema,
    caseFingerprint: digestSchema,
    goldFingerprint: digestSchema,
    samples: z.array(verdictCaseGoldSampleSchema).min(1).max(20_000)
  })
  .strict()
  .superRefine((dataset, context) => {
    if (
      new Set(dataset.samples.map((sample) => sample.sampleId)).size !==
      dataset.samples.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["samples"],
        message: "case gold 的样本身份不能重复。"
      });
    }
  });
export type VerdictCaseGoldDataset = z.infer<
  typeof verdictCaseGoldDatasetSchema
>;

export interface ScoredVerdictBlindPrediction
  extends VerdictBlindPrediction {
  readonly sampleId: string;
  readonly contentSafeId: string;
  readonly contentHash: string;
  readonly caseKind: VerdictDiagnosticCaseKind;
  readonly rating: number;
  readonly expectationMet: boolean;
}

export interface PairedVerdictCase<T> {
  readonly sampleId: string;
  readonly caseKind: VerdictDiagnosticCaseKind;
  readonly item: T;
}

export interface PairedVerdictCasePlan<T> {
  readonly selectedItems: readonly T[];
  readonly normal: readonly PairedVerdictCase<T>[];
  readonly fabricatedDuplicate: readonly PairedVerdictCase<T>[];
  readonly expectedSampleIds: readonly string[];
}

export interface VerdictDiagnosticObservation {
  readonly caseKind: VerdictDiagnosticCaseKind;
  readonly expectationMet: boolean;
}

export interface VerdictSyntheticDiagnosticAssessment {
  readonly diagnosticPassed: boolean;
  readonly syntheticDiagnostics: {
    readonly normal: { readonly total: number; readonly metExpectation: number };
    readonly fabricatedDuplicate: { readonly total: number; readonly metExpectation: number };
  };
}

/**
 * 检查点只能绑定内容侧配置；gold 指纹只在全部推理收束后的报告指纹中加入。
 * 两个名字刻意分开，避免调用方把报告指纹误用于 prediction-only 检查点。
 */
export function verdictInferenceConfigurationFingerprint(
  inferenceConfiguration: unknown
): string {
  return evaluationConfigurationFingerprint(inferenceConfiguration);
}

export function verdictReportConfigurationFingerprint(input: {
  readonly inferenceConfigurationFingerprint: string;
  readonly caseGoldFingerprint: string;
}): string {
  return evaluationConfigurationFingerprint({
    inferenceConfigurationFingerprint: digestSchema.parse(
      input.inferenceConfigurationFingerprint
    ),
    caseGoldFingerprint: digestSchema.parse(input.caseGoldFingerprint)
  });
}

/** 固定 seed 的内容侧排序；rating 和人工标签不参与抽样。 */
export function selectVerdictContentOnlyItems<T extends {
  readonly safeId: string;
  readonly problem: { readonly contentHash: string };
}>(input: {
  readonly items: readonly T[];
  readonly count: number;
  readonly seed: string;
}): T[] {
  if (
    !Number.isSafeInteger(input.count) ||
    input.count < 1 ||
    input.items.length < input.count ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.seed)
  ) {
    throw new Error("VERDICT_CONTENT_SELECTION_INVALID");
  }
  const seen = new Set<string>();
  const ranked = input.items.map((item) => {
    if (
      seen.has(item.safeId) ||
      !contentSafeIdSchema.safeParse(item.safeId).success ||
      !digestSchema.safeParse(item.problem.contentHash).success
    ) {
      throw new Error("VERDICT_CONTENT_SELECTION_INVALID");
    }
    seen.add(item.safeId);
    return {
      item,
      rank: createHash("sha256")
        .update(input.seed, "utf8")
        .update("\0", "utf8")
        .update(item.safeId, "utf8")
        .update("\0", "utf8")
        .update(item.problem.contentHash, "utf8")
        .digest("hex")
    };
  });
  return ranked
    .sort((left, right) =>
      left.rank.localeCompare(right.rank) ||
      left.item.safeId.localeCompare(right.item.safeId)
    )
    .slice(0, input.count)
    .map(({ item }) => item);
}

export function buildVerdictCaseGoldDataset(input: {
  readonly content: BlindContentDataset;
  readonly plan: PairedVerdictCasePlan<BlindProblemContentSample>;
  readonly samples: readonly VerdictCaseGoldSample[];
}): VerdictCaseGoldDataset {
  const content = assertBlindContentDataset(input.content);
  const caseFingerprint = verdictCaseFingerprint(content, input.plan);
  const withoutGoldFingerprint = {
    schemaVersion: 1 as const,
    datasetId: content.datasetId,
    purpose: content.purpose,
    contentFingerprint: content.contentFingerprint,
    caseFingerprint,
    samples: [...input.samples]
  };
  return assertVerdictCaseGoldBinding({
    content,
    plan: input.plan,
    gold: {
      ...withoutGoldFingerprint,
      goldFingerprint: evaluationConfigurationFingerprint(withoutGoldFingerprint)
    }
  });
}

/** 在任何请求前严格绑定内容、case treatment 和独立 gold 文档。 */
export function assertVerdictCaseGoldBinding(input: {
  readonly content: BlindContentDataset;
  readonly plan: PairedVerdictCasePlan<BlindProblemContentSample>;
  readonly gold: VerdictCaseGoldDataset;
}): VerdictCaseGoldDataset {
  const content = assertBlindContentDataset(input.content);
  let gold: VerdictCaseGoldDataset;
  try {
    gold = verdictCaseGoldDatasetSchema.parse(input.gold);
  } catch {
    throw new Error("VERDICT_CASE_GOLD_INVALID");
  }
  const bindings = verdictCaseBindings(content, input.plan);
  const expectedCaseFingerprint = evaluationConfigurationFingerprint({
    datasetId: content.datasetId,
    purpose: content.purpose,
    contentFingerprint: content.contentFingerprint,
    cases: bindings
  });
  const { goldFingerprint: _goldFingerprint, ...withoutGoldFingerprint } = gold;
  if (
    gold.datasetId !== content.datasetId ||
    gold.purpose !== content.purpose ||
    gold.contentFingerprint !== content.contentFingerprint ||
    gold.caseFingerprint !== expectedCaseFingerprint ||
    gold.goldFingerprint !== evaluationConfigurationFingerprint(withoutGoldFingerprint) ||
    gold.samples.length !== bindings.length
  ) {
    throw new Error("VERDICT_CASE_GOLD_MISMATCH");
  }
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index]!;
    const sample = gold.samples[index]!;
    if (
      sample.sampleId !== binding.sampleId ||
      sample.contentSafeId !== binding.contentSafeId ||
      sample.contentHash !== binding.contentHash ||
      sample.caseKind !== binding.caseKind
    ) {
      throw new Error("VERDICT_CASE_GOLD_MISMATCH");
    }
  }
  return deepFreeze(gold);
}

export function verdictCaseFingerprint(
  content: BlindContentDataset,
  plan: PairedVerdictCasePlan<BlindProblemContentSample>
): string {
  const verifiedContent = assertBlindContentDataset(content);
  return evaluationConfigurationFingerprint({
    datasetId: verifiedContent.datasetId,
    purpose: verifiedContent.purpose,
    contentFingerprint: verifiedContent.contentFingerprint,
    cases: verdictCaseBindings(verifiedContent, plan)
  });
}

/** 仅在所有在途推理收束后调用；这里是唯一计算 expectationMet 的位置。 */
export function scoreVerdictBlindPredictions(input: {
  readonly content: BlindContentDataset;
  readonly plan: PairedVerdictCasePlan<BlindProblemContentSample>;
  readonly gold: VerdictCaseGoldDataset;
  readonly predictions: readonly VerdictBlindPredictionRecord[];
  readonly requireComplete: boolean;
}): ScoredVerdictBlindPrediction[] {
  const gold = assertVerdictCaseGoldBinding(input);
  const predictions = new Map<string, VerdictBlindPredictionRecord>();
  for (const candidate of input.predictions) {
    const parsed = verdictBlindPredictionRecordSchema.safeParse(candidate);
    if (!parsed.success || predictions.has(parsed.data.sampleId)) {
      throw new Error("VERDICT_BLIND_PREDICTION_INVALID");
    }
    predictions.set(parsed.data.sampleId, parsed.data);
  }
  const goldIds = new Set(gold.samples.map((sample) => sample.sampleId));
  if (
    [...predictions.keys()].some((sampleId) => !goldIds.has(sampleId)) ||
    (input.requireComplete && predictions.size !== gold.samples.length)
  ) {
    throw new Error("VERDICT_BLIND_PREDICTION_SET_MISMATCH");
  }
  return gold.samples.flatMap((sample): ScoredVerdictBlindPrediction[] => {
    const record = predictions.get(sample.sampleId);
    if (record === undefined) {
      return [];
    }
    if (record.contentHash !== sample.contentHash) {
      throw new Error("VERDICT_BLIND_PREDICTION_SET_MISMATCH");
    }
    const verdictMatches = sample.gold.expectedVerdict === "reject"
      ? record.prediction.verdict === "reject"
      : record.prediction.verdict !== "reject";
    return [{
      sampleId: sample.sampleId,
      contentSafeId: sample.contentSafeId,
      contentHash: sample.contentHash,
      caseKind: sample.caseKind,
      rating: sample.gold.rating,
      ...record.prediction,
      expectationMet:
        verdictMatches &&
        record.prediction.forcedDuplicateReject ===
          sample.gold.expectedForcedDuplicateReject
    }];
  });
}

/** pending/resume 执行器只接收 case treatment 与内容，不接收 gold。 */
export async function runVerdictBlindCaseBatch(input: {
  readonly content: BlindContentDataset;
  readonly cases: readonly PairedVerdictCase<BlindProblemContentSample>[];
  readonly concurrency: number;
  readonly beforeInference?: (
    diagnosticCase: Readonly<PairedVerdictCase<BlindProblemContentSample>>,
    index: number
  ) => void;
  readonly infer: (
    diagnosticCase: Readonly<PairedVerdictCase<BlindProblemContentSample>>,
    index: number
  ) => Promise<unknown>;
  readonly afterInference?: (
    prediction: VerdictBlindPredictionRecord,
    index: number
  ) => void;
  readonly onInferenceError?: (
    diagnosticCase: Readonly<PairedVerdictCase<BlindProblemContentSample>>,
    error: unknown,
    index: number
  ) => void | Promise<void>;
}): Promise<VerdictBlindPredictionRecord[]> {
  const content = assertBlindContentDataset(input.content);
  const contentBySafeId = new Map(
    content.samples.map((sample) => [sample.safeId, sample] as const)
  );
  const seen = new Set<string>();
  const verifiedCases = input.cases.map((candidate) => {
    const item = contentBySafeId.get(candidate.item.safeId);
    if (
      item === undefined ||
      seen.has(candidate.sampleId) ||
      !verdictDiagnosticCaseKindSchema.safeParse(candidate.caseKind).success ||
      candidate.sampleId !== `${item.safeId}:${candidate.caseKind}` ||
      candidate.item.problem.contentHash !== item.problem.contentHash
    ) {
      throw new Error("VERDICT_CASE_PLAN_INVALID");
    }
    seen.add(candidate.sampleId);
    return deepFreeze({
      sampleId: candidate.sampleId,
      caseKind: candidate.caseKind,
      item
    });
  });
  let stopStartingInference = false;
  return mapWithConcurrency(
    verifiedCases,
    input.concurrency,
    async (diagnosticCase, index) => {
      if (stopStartingInference) {
        throw new Error("VERDICT_EVALUATION_STOPPED");
      }
      // checkpoint 写入与 infer 的同步调用之间没有 await；失败 worker 关闸后，
      // 排队 case 即使被 concurrency worker 取到，也不能再发起请求。
      input.beforeInference?.(diagnosticCase, index);
      let prediction: VerdictBlindPrediction;
      try {
        const running = input.infer(diagnosticCase, index);
        const raw = await running;
        prediction = verdictBlindPredictionSchema.parse(raw);
      } catch (error) {
        stopStartingInference = true;
        await input.onInferenceError?.(diagnosticCase, error, index);
        throw error;
      }
      const record = verdictBlindPredictionRecordSchema.parse({
        sampleId: diagnosticCase.sampleId,
        contentHash: diagnosticCase.item.problem.contentHash,
        prediction
      });
      input.afterInference?.(record, index);
      return record;
    }
  );
}

/**
 * complete 只回答“预期调用是否都收束”；这个纯函数另外回答两组接线预期
 * 是否逐例成立。少例、多例或任一反例都会让 diagnosticPassed=false。
 */
export function assessVerdictSyntheticDiagnostic(
  observations: readonly VerdictDiagnosticObservation[],
  expectedPerGroup: number
): VerdictSyntheticDiagnosticAssessment {
  if (!Number.isSafeInteger(expectedPerGroup) || expectedPerGroup < 1) {
    throw new Error("VERDICT_DIAGNOSTIC_EXPECTED_COUNT_INVALID");
  }
  const summarize = (caseKind: VerdictDiagnosticCaseKind) => {
    const rows = observations.filter((observation) => observation.caseKind === caseKind);
    return {
      total: rows.length,
      metExpectation: rows.filter((observation) => observation.expectationMet).length
    };
  };
  const normal = summarize("normal");
  const fabricatedDuplicate = summarize("fabricated_duplicate");
  return {
    diagnosticPassed:
      normal.total === expectedPerGroup &&
      normal.metExpectation === expectedPerGroup &&
      fabricatedDuplicate.total === expectedPerGroup &&
      fabricatedDuplicate.metExpectation === expectedPerGroup,
    syntheticDiagnostics: { normal, fabricatedDuplicate }
  };
}

/** 同一可信样本一对二，避免把题目差异误当成合成审核条目的效果。 */
export function buildPairedVerdictCasePlan<T extends { readonly safeId: string }>(
  orderedItems: readonly T[],
  casesPerGroup: number
): PairedVerdictCasePlan<T> {
  if (!Number.isSafeInteger(casesPerGroup) || casesPerGroup < 1 || orderedItems.length < casesPerGroup) {
    throw new Error("VERDICT_PAIRED_CASES_UNAVAILABLE");
  }
  const selectedItems = orderedItems.slice(0, casesPerGroup);
  const safeIds = selectedItems.map((item) => item.safeId);
  if (
    new Set(safeIds).size !== safeIds.length ||
    safeIds.some((safeId) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(safeId))
  ) {
    throw new Error("VERDICT_PAIRED_CASE_IDS_INVALID");
  }
  const normal = selectedItems.map((item): PairedVerdictCase<T> => ({
    sampleId: `${item.safeId}:normal`,
    caseKind: "normal",
    item
  }));
  const fabricatedDuplicate = selectedItems.map((item): PairedVerdictCase<T> => ({
    sampleId: `${item.safeId}:fabricated_duplicate`,
    caseKind: "fabricated_duplicate",
    item
  }));
  return {
    selectedItems,
    normal,
    fabricatedDuplicate,
    expectedSampleIds: selectedItems.flatMap((item) => [
      `${item.safeId}:normal`,
      `${item.safeId}:fabricated_duplicate`
    ])
  };
}

function verdictCaseBindings(
  content: BlindContentDataset,
  plan: PairedVerdictCasePlan<BlindProblemContentSample>
): Array<{
  readonly sampleId: string;
  readonly contentSafeId: string;
  readonly contentHash: string;
  readonly caseKind: VerdictDiagnosticCaseKind;
}> {
  const contentBySafeId = new Map(
    content.samples.map((sample) => [sample.safeId, sample] as const)
  );
  const cases = [...plan.normal, ...plan.fabricatedDuplicate];
  const bySampleId = new Map(cases.map((entry) => [entry.sampleId, entry] as const));
  if (
    bySampleId.size !== cases.length ||
    plan.expectedSampleIds.length !== cases.length ||
    new Set(plan.expectedSampleIds).size !== plan.expectedSampleIds.length
  ) {
    throw new Error("VERDICT_CASE_PLAN_INVALID");
  }
  return plan.expectedSampleIds.map((sampleId) => {
    const diagnosticCase = bySampleId.get(sampleId);
    const contentSample = diagnosticCase === undefined
      ? undefined
      : contentBySafeId.get(diagnosticCase.item.safeId);
    if (
      diagnosticCase === undefined ||
      contentSample === undefined ||
      diagnosticCase.sampleId !== `${contentSample.safeId}:${diagnosticCase.caseKind}` ||
      diagnosticCase.item.problem.contentHash !== contentSample.problem.contentHash
    ) {
      throw new Error("VERDICT_CASE_PLAN_INVALID");
    }
    return {
      sampleId,
      contentSafeId: contentSample.safeId,
      contentHash: contentSample.problem.contentHash,
      caseKind: diagnosticCase.caseKind
    };
  });
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

/**
 * verdict 的模型上下文只包含 ReviewTaskItem.summary；因此合成证据必须写入 summary，
 * data 只用于本地提取数值阈值。该记录只可用于接线诊断，不是真实查重标注。
 */
export function buildFabricatedSimilarityItem(
  problem: ReviewTaskProblem,
  similarity: number,
  now: Date = new Date()
): ReviewTaskItem {
  if (!Number.isFinite(similarity) || similarity < 0 || similarity > 1) {
    throw new Error("VERDICT_FABRICATED_SIMILARITY_INVALID");
  }
  const timestamp = now.toISOString();
  return {
    id: randomUUID(),
    type: "org.ustc.urmotiv.anklang.similarity",
    source: "human",
    sourcePluginId: null,
    visibility: "reviewer",
    summary:
      `合成诊断记录：候选题《${problem.title}》与当前题的题面叙述、输入输出格式和数据范围均完全一致，` +
      `仅变量命名不同；最高相似度为 ${(similarity * 100).toFixed(1)}%，请独立判断是否同一道题。`,
    data: {
      apiVersion: "1",
      contentHash: problem.contentHash,
      checkedAt: timestamp,
      candidates: [
        {
          source: "yuantiji",
          externalId: "public-archive-synthetic",
          title: problem.title,
          url: "https://example.test/problem/public-archive-synthetic",
          similarity,
          sameProblemSuggestion: true,
          explanation: "题面叙述、输入输出格式与数据范围与该公开题完全一致，仅变量命名不同。"
        }
      ],
      recommendation: {
        blockSubmission: true,
        message: "候选题与本题几乎完全一致，疑似同一道公开题。"
      }
    },
    contentHash: problem.contentHash,
    expiresAt: null,
    createdAt: timestamp
  };
}
