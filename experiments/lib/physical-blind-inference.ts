import { z } from "zod";
import {
  runBlindInference,
  type BlindPrediction,
  type BlindProblemContentSample
} from "./blind-evaluation";
import {
  assertUniquePhysicalBlindSampleIds,
  deepFreezePhysicalBlind,
  failPhysicalBlind,
  hashPhysicalBlindValue,
  parsePhysicalBlindJson,
  parseVersionedStrictArtifact,
  physicalBlindDigestSchema,
  physicalBlindPurposeSchema,
  physicalBlindRunIdSchema,
  physicalBlindSafeIdSchema,
  serializePhysicalBlindArtifact,
  type PhysicalBlindPurpose
} from "./physical-blind-common";
import {
  loadPhysicalBlindContentArtifact,
  physicalBlindSourceIneligibilityReasonCode,
  physicalBlindContentToLogicalDataset,
  type PhysicalBlindContentArtifact
} from "./physical-blind-content";

export const physicalBlindInferenceFailureCodeSchema = z.enum([
  "HTTP_499",
  "REQUEST_CANCELLED",
  "INFERENCE_FAILED",
  "PREDICTION_INVALID"
]);
export type PhysicalBlindInferenceFailureCode = z.infer<
  typeof physicalBlindInferenceFailureCodeSchema
>;

export interface PhysicalBlindInferenceFailure {
  readonly safeId: string;
  readonly contentHash: string;
  readonly code: PhysicalBlindInferenceFailureCode;
  readonly httpStatus?: 499;
}

export interface PhysicalBlindPredictionCompleteness {
  readonly expected: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly missing: number;
  readonly complete: boolean;
}

export interface PhysicalBlindPredictionArtifact<TPrediction> {
  readonly schemaVersion: 1;
  readonly artifactKind: "blind-predictions";
  readonly runId: string;
  readonly datasetId: string;
  readonly purpose: PhysicalBlindPurpose;
  readonly sourceSchemaVersion: 1 | 2;
  readonly productionEligible: false;
  readonly sourceIneligibilityReasonCode: typeof physicalBlindSourceIneligibilityReasonCode;
  readonly contentIdentityFingerprint: string;
  readonly contentFingerprint: string;
  readonly predictions: readonly BlindPrediction<TPrediction>[];
  readonly failures: readonly PhysicalBlindInferenceFailure[];
  readonly completeness: PhysicalBlindPredictionCompleteness;
  readonly executionEvidence: {
    readonly schemaVersion: 1;
    readonly evidenceKind: "unverified-callback";
    readonly trustedCheckpointBound: false;
    readonly eofVerified: false;
    readonly productionEligible: false;
    readonly reasonCode: "BLIND_TRUSTED_EXECUTION_ADAPTER_REQUIRED";
  };
  readonly predictionFingerprint: string;
}

export function buildPhysicalBlindPredictionArtifact<TPrediction>(input: {
  readonly content: PhysicalBlindContentArtifact;
  readonly runId: string;
  readonly predictions: readonly BlindPrediction<TPrediction>[];
  readonly failures: readonly PhysicalBlindInferenceFailure[];
  readonly predictionSchema: z.ZodType<TPrediction>;
}): PhysicalBlindPredictionArtifact<TPrediction> {
  const content = loadPhysicalBlindContentArtifact(
    serializePhysicalBlindArtifact(input.content)
  );
  const expected = new Map(
    content.samples.map((sample) => [sample.safeId, sample.problem.contentHash])
  );
  assertUniquePhysicalBlindSampleIds(input.predictions);
  assertUniquePhysicalBlindSampleIds(input.failures);
  const predictions = input.predictions.map((entry) => ({
    safeId: physicalBlindSafeIdSchema.parse(entry.safeId),
    contentHash: physicalBlindDigestSchema.parse(entry.contentHash),
    prediction: parsePrediction(entry.prediction, input.predictionSchema)
  }));
  const failures = input.failures.map((entry) =>
    parseInferenceFailure(entry)
  );
  const predictionIds = new Set(predictions.map((entry) => entry.safeId));
  const failureIds = new Set(failures.map((entry) => entry.safeId));
  for (const entry of [...predictions, ...failures]) {
    if (expected.get(entry.safeId) !== entry.contentHash) {
      failPhysicalBlind("BLIND_ARTIFACT_SAMPLE_SET_MISMATCH");
    }
  }
  if ([...predictionIds].some((safeId) => failureIds.has(safeId))) {
    failPhysicalBlind("BLIND_ARTIFACT_SAMPLE_SET_MISMATCH");
  }
  const completeness = {
    expected: content.samples.length,
    succeeded: predictions.length,
    failed: failures.length,
    missing: content.samples.length - predictions.length - failures.length,
    complete:
      predictions.length === content.samples.length && failures.length === 0
  };
  if (completeness.missing < 0) {
    failPhysicalBlind("BLIND_ARTIFACT_SAMPLE_SET_MISMATCH");
  }
  const withoutFingerprint = {
    schemaVersion: 1 as const,
    artifactKind: "blind-predictions" as const,
    runId: physicalBlindRunIdSchema.parse(input.runId),
    datasetId: content.datasetId,
    purpose: content.purpose,
    sourceSchemaVersion: content.sourceSchemaVersion,
    productionEligible: content.productionEligible,
    sourceIneligibilityReasonCode: content.sourceIneligibilityReasonCode,
    contentIdentityFingerprint: content.contentIdentityFingerprint,
    contentFingerprint: content.contentFingerprint,
    predictions: orderByContent(content, predictions),
    failures: orderByContent(content, failures),
    completeness,
    executionEvidence: {
      schemaVersion: 1 as const,
      evidenceKind: "unverified-callback" as const,
      trustedCheckpointBound: false as const,
      eofVerified: false as const,
      productionEligible: false as const,
      reasonCode: "BLIND_TRUSTED_EXECUTION_ADAPTER_REQUIRED" as const
    }
  };
  return deepFreezePhysicalBlind({
    ...withoutFingerprint,
    predictionFingerprint: hashPhysicalBlindValue(withoutFingerprint)
  });
}

export function loadPhysicalBlindPredictionArtifact<TPrediction>(input: {
  readonly document: string;
  readonly content: PhysicalBlindContentArtifact;
  readonly predictionSchema: z.ZodType<TPrediction>;
}): PhysicalBlindPredictionArtifact<TPrediction> {
  const predictionRecordSchema = z
    .object({
      safeId: physicalBlindSafeIdSchema,
      contentHash: physicalBlindDigestSchema,
      prediction: input.predictionSchema
    })
    .strict();
  const failureSchema = z
    .object({
      safeId: physicalBlindSafeIdSchema,
      contentHash: physicalBlindDigestSchema,
      code: physicalBlindInferenceFailureCodeSchema,
      httpStatus: z.literal(499).optional()
    })
    .strict()
    .superRefine((failure, context) => {
      if (
        (failure.code === "HTTP_499") !== (failure.httpStatus === 499)
      ) {
        context.addIssue({
          code: "custom",
          path: ["httpStatus"],
          message: "499 状态与固定失败码必须同时出现。"
        });
      }
    });
  const completenessSchema = z
    .object({
      expected: z.number().int().min(1).max(10_000),
      succeeded: z.number().int().nonnegative().max(10_000),
      failed: z.number().int().nonnegative().max(10_000),
      missing: z.number().int().nonnegative().max(10_000),
      complete: z.boolean()
    })
    .strict();
  const schema = z
    .object({
      schemaVersion: z.literal(1),
      artifactKind: z.literal("blind-predictions"),
      runId: physicalBlindRunIdSchema,
      datasetId: physicalBlindSafeIdSchema,
      purpose: physicalBlindPurposeSchema,
      sourceSchemaVersion: z.union([z.literal(1), z.literal(2)]),
      productionEligible: z.literal(false),
      sourceIneligibilityReasonCode: z.literal(
        physicalBlindSourceIneligibilityReasonCode
      ),
      contentIdentityFingerprint: physicalBlindDigestSchema,
      contentFingerprint: physicalBlindDigestSchema,
      predictions: z.array(predictionRecordSchema).max(10_000),
      failures: z.array(failureSchema).max(10_000),
      completeness: completenessSchema,
      executionEvidence: z
        .object({
          schemaVersion: z.literal(1),
          evidenceKind: z.literal("unverified-callback"),
          trustedCheckpointBound: z.literal(false),
          eofVerified: z.literal(false),
          productionEligible: z.literal(false),
          reasonCode: z.literal("BLIND_TRUSTED_EXECUTION_ADAPTER_REQUIRED")
        })
        .strict(),
      predictionFingerprint: physicalBlindDigestSchema
    })
    .strict();
  const parsed = parseVersionedStrictArtifact({
    value: parsePhysicalBlindJson(input.document),
    schema
  });
  const content = loadPhysicalBlindContentArtifact(
    serializePhysicalBlindArtifact(input.content)
  );
  if (
    parsed.datasetId !== content.datasetId ||
    parsed.purpose !== content.purpose ||
    parsed.sourceSchemaVersion !== content.sourceSchemaVersion ||
    parsed.productionEligible !== content.productionEligible ||
    parsed.sourceIneligibilityReasonCode !==
      content.sourceIneligibilityReasonCode ||
    parsed.contentIdentityFingerprint !==
      content.contentIdentityFingerprint ||
    parsed.contentFingerprint !== content.contentFingerprint
  ) {
    failPhysicalBlind("BLIND_ARTIFACT_IDENTITY_MISMATCH");
  }
  const rebuilt = buildPhysicalBlindPredictionArtifact({
    content,
    runId: parsed.runId,
    predictions: parsed.predictions,
    failures: parsed.failures,
    predictionSchema: input.predictionSchema
  });
  if (
    parsed.predictionFingerprint !== rebuilt.predictionFingerprint ||
    hashPhysicalBlindValue(parsed.completeness) !==
      hashPhysicalBlindValue(rebuilt.completeness) ||
    hashPhysicalBlindValue(parsed.executionEvidence) !==
      hashPhysicalBlindValue(rebuilt.executionEvidence)
  ) {
    failPhysicalBlind("BLIND_ARTIFACT_HASH_MISMATCH");
  }
  return rebuilt;
}

export function serializePhysicalBlindPredictionArtifact<TPrediction>(input: {
  readonly artifact: PhysicalBlindPredictionArtifact<TPrediction>;
  readonly content: PhysicalBlindContentArtifact;
  readonly predictionSchema: z.ZodType<TPrediction>;
}): string {
  const verified = loadPhysicalBlindPredictionArtifact({
    document: serializePhysicalBlindArtifact(input.artifact),
    content: input.content,
    predictionSchema: input.predictionSchema
  });
  return serializePhysicalBlindArtifact(verified);
}

/**
 * 推理 API 只接受 content 文档。回调和检查点都只能看到冻结的题目内容或
 * prediction-only artifact；失败只记录固定码，不保存异常消息或模型原文。
 */
export async function runPhysicalBlindInference<TPrediction>(input: {
  readonly contentDocument: string;
  readonly runId: string;
  readonly concurrency: number;
  readonly predictionSchema: z.ZodType<TPrediction>;
  readonly infer: (
    sample: Readonly<BlindProblemContentSample>,
    index: number
  ) => Promise<TPrediction>;
  readonly onCheckpoint?: (
    artifact: PhysicalBlindPredictionArtifact<TPrediction>
  ) => void | Promise<void>;
}): Promise<PhysicalBlindPredictionArtifact<TPrediction>> {
  if (
    !Number.isSafeInteger(input.concurrency) ||
    input.concurrency < 1 ||
    input.concurrency > 32
  ) {
    failPhysicalBlind("BLIND_INFERENCE_CONCURRENCY_INVALID");
  }
  const content = loadPhysicalBlindContentArtifact(input.contentDocument);
  const logicalContent = physicalBlindContentToLogicalDataset(content);
  const predictions: BlindPrediction<TPrediction>[] = [];
  const failures: PhysicalBlindInferenceFailure[] = [];
  let checkpointTail = Promise.resolve();
  const emitCheckpoint = (): Promise<void> => {
    const checkpoint = buildPhysicalBlindPredictionArtifact({
      content,
      runId: input.runId,
      predictions: [...predictions],
      failures: [...failures],
      predictionSchema: input.predictionSchema
    });
    checkpointTail = checkpointTail.then(async () => {
      await input.onCheckpoint?.(checkpoint);
    });
    return checkpointTail;
  };
  await emitCheckpoint();
  try {
    await runBlindInference({
      content: logicalContent,
      concurrency: input.concurrency,
      infer: async (sample, index) =>
        parsePrediction(await input.infer(sample, index), input.predictionSchema),
      afterInference: async (prediction) => {
        predictions.push(prediction);
        await emitCheckpoint();
      },
      onInferenceError: async (sample, error) => {
        failures.push(classifyInferenceFailure(sample, error));
        await emitCheckpoint();
      }
    });
  } catch {
    // 首个失败会关闸并等待同批在途请求；完整性由成功、失败和缺失数统一决定。
  }
  await checkpointTail;
  const artifact = buildPhysicalBlindPredictionArtifact({
    content,
    runId: input.runId,
    predictions,
    failures,
    predictionSchema: input.predictionSchema
  });
  return artifact;
}

function classifyInferenceFailure(
  sample: Readonly<BlindProblemContentSample>,
  error: unknown
): PhysicalBlindInferenceFailure {
  const status = readNumericProperty(error, "status") ??
    readNumericProperty(error, "statusCode");
  if (status === 499) {
    return {
      safeId: sample.safeId,
      contentHash: sample.problem.contentHash,
      code: "HTTP_499",
      httpStatus: 499
    };
  }
  const name = readStringProperty(error, "name");
  const code = readStringProperty(error, "code");
  if (
    name === "AbortError" ||
    code === "ABORT_ERR" ||
    code === "UND_ERR_ABORTED"
  ) {
    return {
      safeId: sample.safeId,
      contentHash: sample.problem.contentHash,
      code: "REQUEST_CANCELLED"
    };
  }
  return {
    safeId: sample.safeId,
    contentHash: sample.problem.contentHash,
    code:
      code === "BLIND_PREDICTION_INVALID"
        ? "PREDICTION_INVALID"
        : "INFERENCE_FAILED"
  };
}

function parsePrediction<TPrediction>(
  value: unknown,
  schema: z.ZodType<TPrediction>
): TPrediction {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    failPhysicalBlind("BLIND_PREDICTION_INVALID");
  }
  return deepFreezePhysicalBlind(structuredClone(parsed.data));
}

function parseInferenceFailure(
  failure: PhysicalBlindInferenceFailure
): PhysicalBlindInferenceFailure {
  const parsed = z
    .object({
      safeId: physicalBlindSafeIdSchema,
      contentHash: physicalBlindDigestSchema,
      code: physicalBlindInferenceFailureCodeSchema,
      httpStatus: z.literal(499).optional()
    })
    .strict()
    .safeParse(failure);
  if (
    !parsed.success ||
    ((parsed.data.code === "HTTP_499") !==
      (parsed.data.httpStatus === 499))
  ) {
    failPhysicalBlind("BLIND_ARTIFACT_DOCUMENT_INVALID");
  }
  return parsed.data;
}

function orderByContent<T extends { readonly safeId: string }>(
  content: PhysicalBlindContentArtifact,
  entries: readonly T[]
): T[] {
  const order = new Map(
    content.samples.map((sample, index) => [sample.safeId, index])
  );
  return [...entries].sort(
    (left, right) =>
      (order.get(left.safeId) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.safeId) ?? Number.MAX_SAFE_INTEGER)
  );
}

function readStringProperty(error: unknown, key: string): string | undefined {
  if (typeof error !== "object" || error === null || !(key in error)) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function readNumericProperty(error: unknown, key: string): number | undefined {
  if (typeof error !== "object" || error === null || !(key in error)) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}
