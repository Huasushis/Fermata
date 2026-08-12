import {
  FairLlmRequestScheduler,
  LlmStageRequestError
} from "../llm-scheduler";
import { hashCanonicalValue } from "./evidence";

export type ReviewFlowSemanticStage = "A" | "B" | "C" | "D";
export type ReviewFlowDagStage = ReviewFlowSemanticStage | "formatter";

export const reviewFlowStageOutputBudgets = Object.freeze({
  A: 32_000,
  B: 8_000,
  C: 24_000,
  D: 12_000,
  formatter: 8_000
} satisfies Readonly<Record<ReviewFlowDagStage, number>>);

export interface ReviewFlowUnifiedResult {
  readonly schemaVersion: 1;
  readonly a: {
    readonly solvable: boolean;
    readonly blindSolution: string;
    readonly positiveSignals: readonly string[];
    readonly negativeSignals: readonly string[];
  };
  readonly b: {
    readonly codeforcesDifficulty: number | null;
    readonly thinkingLevel: number;
    readonly codingLevel: number;
    readonly rationale: string;
  };
  readonly c: {
    readonly solutionAnalysis: string;
    readonly technicalQuality: string;
    readonly editorialQuality: string;
    readonly contestFit: "strong" | "acceptable" | "weak";
    readonly originalityLevel: number;
    readonly tagIds: readonly string[];
    readonly positiveSignals: readonly string[];
    readonly negativeSignals: readonly string[];
    readonly hardBlockers: readonly string[];
  };
  readonly d: {
    readonly verdict: "approve" | "request_changes" | "reject";
    readonly qualityLevel: number;
    readonly acceptedSignals: readonly string[];
    readonly rejectedSignals: readonly string[];
    readonly hardBlockers: readonly string[];
    readonly improvements: string;
    readonly publicComment: string;
    readonly privateNote: string;
  };
}

type MachinePrimitiveType = "object" | "array" | "string" | "boolean" | "integer" | "number" | "null";

export interface MachineJsonSchema {
  readonly type?: MachinePrimitiveType | readonly MachinePrimitiveType[];
  readonly const?: string | number | boolean | null;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly properties?: Readonly<Record<string, MachineJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: MachineJsonSchema;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
}

const signalArraySchema = Object.freeze({
  type: "array",
  items: Object.freeze({ type: "string", minLength: 1, maxLength: 4_000 }),
  maxItems: 100
} satisfies MachineJsonSchema);

/** A/B/C/D 与末尾 formatter 共用的唯一机器 schema 定义。 */
export const reviewFlowUnifiedJsonSchema = Object.freeze({
  type: "object",
  required: ["schemaVersion", "a", "b", "c", "d"],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    a: {
      type: "object",
      required: ["solvable", "blindSolution", "positiveSignals", "negativeSignals"],
      additionalProperties: false,
      properties: {
        solvable: { type: "boolean" },
        blindSolution: { type: "string", minLength: 1, maxLength: 500_000 },
        positiveSignals: signalArraySchema,
        negativeSignals: signalArraySchema
      }
    },
    b: {
      type: "object",
      required: ["codeforcesDifficulty", "thinkingLevel", "codingLevel", "rationale"],
      additionalProperties: false,
      properties: {
        codeforcesDifficulty: { type: ["integer", "null"], minimum: 800, maximum: 3500 },
        thinkingLevel: { type: "integer", minimum: 1, maximum: 5 },
        codingLevel: { type: "integer", minimum: 1, maximum: 5 },
        rationale: { type: "string", minLength: 1, maxLength: 20_000 }
      }
    },
    c: {
      type: "object",
      required: [
        "solutionAnalysis",
        "technicalQuality",
        "editorialQuality",
        "contestFit",
        "originalityLevel",
        "tagIds",
        "positiveSignals",
        "negativeSignals",
        "hardBlockers"
      ],
      additionalProperties: false,
      properties: {
        solutionAnalysis: { type: "string", minLength: 1, maxLength: 200_000 },
        technicalQuality: { type: "string", minLength: 1, maxLength: 100_000 },
        editorialQuality: { type: "string", minLength: 1, maxLength: 100_000 },
        contestFit: { type: "string", enum: ["strong", "acceptable", "weak"] },
        originalityLevel: { type: "integer", minimum: 1, maximum: 5 },
        tagIds: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 30
        },
        positiveSignals: signalArraySchema,
        negativeSignals: signalArraySchema,
        hardBlockers: signalArraySchema
      }
    },
    d: {
      type: "object",
      required: [
        "verdict",
        "qualityLevel",
        "acceptedSignals",
        "rejectedSignals",
        "hardBlockers",
        "improvements",
        "publicComment",
        "privateNote"
      ],
      additionalProperties: false,
      properties: {
        verdict: { type: "string", enum: ["approve", "request_changes", "reject"] },
        qualityLevel: { type: "integer", minimum: 1, maximum: 5 },
        acceptedSignals: signalArraySchema,
        rejectedSignals: signalArraySchema,
        hardBlockers: signalArraySchema,
        improvements: { type: "string", maxLength: 100_000 },
        publicComment: { type: "string", maxLength: 100_000 },
        privateNote: { type: "string", maxLength: 100_000 }
      }
    }
  }
} as const satisfies MachineJsonSchema);

export const reviewFlowUnifiedSchemaFingerprint = hashCanonicalValue(reviewFlowUnifiedJsonSchema);

export const reviewFlowStageJsonSchemas = Object.freeze({
  A: reviewFlowUnifiedJsonSchema.properties.a,
  B: reviewFlowUnifiedJsonSchema.properties.b,
  C: reviewFlowUnifiedJsonSchema.properties.c,
  D: reviewFlowUnifiedJsonSchema.properties.d,
  formatter: reviewFlowUnifiedJsonSchema
} satisfies Readonly<Record<ReviewFlowDagStage, MachineJsonSchema>>);

export interface ReviewFlowStageReceipt {
  readonly stage: ReviewFlowDagStage;
  readonly inputHash: string;
  readonly promptHash: string;
  readonly schemaFingerprint: string | null;
  readonly modelFingerprint: string;
  readonly attemptCount: number;
  readonly eofVerified: true;
  readonly outputHash: string;
  readonly receiptHash: string;
}

export interface ReviewFlowCompletedStage {
  readonly output: string;
  readonly receipt: ReviewFlowStageReceipt;
}

export type ReviewFlowCompletedStages = Readonly<
  Partial<Record<ReviewFlowDagStage, ReviewFlowCompletedStage>>
>;

export interface FourCallModelBinding {
  readonly provider: string;
  readonly model: string;
  readonly thinkingRequest: "enabled";
  readonly reasoningEffort: "max";
  readonly fingerprint: string;
}

export type FourCallModelBindings = Readonly<Record<ReviewFlowDagStage, FourCallModelBinding>>;

export interface FourCallReviewSource {
  readonly statement: unknown;
  readonly referenceSolution: unknown;
  readonly technicalContext: unknown;
  readonly historicalTasteRubric: unknown;
  readonly difficultyAnchors: unknown;
  readonly labelCatalog: unknown;
  readonly hardRules: unknown;
}

export interface FourCallRequest {
  readonly caseId: string;
  readonly stage: ReviewFlowDagStage;
  readonly input: string;
  readonly model: FourCallModelBinding;
  readonly messages: readonly {
    readonly role: "system" | "user";
    readonly content: string;
  }[];
  readonly maxOutputTokens: number;
  readonly thinkingRequest: "enabled";
  readonly reasoningEffort: "max";
  readonly schema: MachineJsonSchema | null;
  readonly schemaFingerprint: string | null;
  readonly attempt: number;
}

export interface FourCallResponse {
  readonly output: string;
  readonly eofVerified: boolean;
}

export interface FourCallDagResult {
  readonly output: ReviewFlowUnifiedResult;
  readonly stages: Readonly<Record<ReviewFlowSemanticStage, ReviewFlowCompletedStage>> &
    Readonly<Partial<Record<"formatter", ReviewFlowCompletedStage>>>;
  readonly reusedStages: readonly ReviewFlowSemanticStage[];
  readonly semanticRequestCount: number;
  readonly formatterRequestCount: 0 | 1;
  readonly criticalPathSemanticRequests: 3;
}

export async function runFourCallReviewDag(input: {
  readonly caseId: string;
  readonly sourceBinding: string;
  readonly source?: FourCallReviewSource;
  readonly model: FourCallModelBinding | FourCallModelBindings;
  readonly nativeSchemaCompatible: boolean;
  readonly scheduler: FairLlmRequestScheduler;
  readonly reusableStages?: ReviewFlowCompletedStages;
  readonly onStageCompleted?: (
    completed: ReviewFlowCompletedStage
  ) => void;
  readonly call: (request: FourCallRequest) => Promise<FourCallResponse>;
}): Promise<FourCallDagResult> {
  assertDigest(input.sourceBinding, "REVIEW_FLOW_SOURCE_BINDING_INVALID");
  const modelForStage = (stage: ReviewFlowDagStage): FourCallModelBinding =>
    "fingerprint" in input.model ? input.model : input.model[stage];
  for (const stage of ["A", "B", "C", "D", "formatter"] as const) {
    const stageModel = modelForStage(stage);
    assertDigest(stageModel.fingerprint, "REVIEW_FLOW_MODEL_FINGERPRINT_INVALID");
    if (stageModel.thinkingRequest !== "enabled" || stageModel.reasoningEffort !== "max") {
      throw new Error("REVIEW_FLOW_NATIVE_MAX_REQUIRED");
    }
  }
  const reusedStages: ReviewFlowSemanticStage[] = [];
  let semanticRequestCount = 0;
  const source: FourCallReviewSource = input.source ?? {
    statement: null,
    referenceSolution: null,
    technicalContext: null,
    historicalTasteRubric: null,
    difficultyAnchors: null,
    labelCatalog: null,
    hardRules: null
  };
  const aInput = canonicalStageInput({
    sourceBinding: input.sourceBinding,
    statement: source.statement
  });
  const bInput = canonicalStageInput({
    sourceBinding: input.sourceBinding,
    statement: source.statement,
    difficultyAnchors: source.difficultyAnchors
  });

  const execute = async (
    stage: ReviewFlowDagStage,
    stageInput: string,
    schema: MachineJsonSchema | null
  ): Promise<ReviewFlowCompletedStage> => {
    const messages = buildStageMessages(stage, stageInput);
    const stageModel = modelForStage(stage);
    const schemaFingerprint = schema === null ? null : hashCanonicalValue(schema);
    const expected = {
      stage,
      inputHash: hashCanonicalValue(stageInput),
      promptHash: hashCanonicalValue(messages),
      schemaFingerprint,
      modelFingerprint: stageModel.fingerprint
    };
    const reusable = input.reusableStages?.[stage];
    if (reusable !== undefined && reusableStageMatches(reusable, expected)) {
      if (stage !== "formatter") reusedStages.push(stage);
      return reusable;
    }
    if (stage !== "formatter") semanticRequestCount += 1;
    const scheduled = await input.scheduler.runLogicalRequest({
      caseId: input.caseId,
      requestId: stage,
      execute: async (attempt) => {
        const response = await input.call({
          caseId: input.caseId,
          stage,
          model: stageModel,
          input: stageInput,
          messages,
          maxOutputTokens: reviewFlowStageOutputBudgets[stage],
          thinkingRequest: "enabled",
          reasoningEffort: "max",
          schema,
          schemaFingerprint,
          attempt
        });
        if (!response.eofVerified) {
          throw new LlmStageRequestError("stream_interrupted");
        }
        if (typeof response.output !== "string" || response.output.length === 0) {
          throw new LlmStageRequestError("schema_invalid");
        }
        return response.output;
      }
    });
    const completed = sealCompletedStage({
      ...expected,
      attemptCount: scheduled.attemptCount,
      output: scheduled.value
    });
    input.onStageCompleted?.(completed);
    return completed;
  };

  const semanticSchema = (stage: ReviewFlowSemanticStage): MachineJsonSchema | null =>
    input.nativeSchemaCompatible ? reviewFlowStageJsonSchemas[stage] : null;
  const settle = async <T>(promise: Promise<T>): Promise<
    { readonly ok: true; readonly value: T } |
    { readonly ok: false; readonly error: unknown }
  > => promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
  const aOutcomePromise = settle(execute("A", aInput, semanticSchema("A")));
  const bOutcomePromise = settle(execute("B", bInput, semanticSchema("B")));
  const aOutcome = await aOutcomePromise;
  if (!aOutcome.ok) {
    await bOutcomePromise;
    throw aOutcome.error;
  }
  const a = aOutcome.value;
  const cInput = canonicalStageInput({
    sourceBinding: input.sourceBinding,
    statement: source.statement,
    referenceSolution: source.referenceSolution,
    technicalContext: source.technicalContext,
    historicalTasteRubric: source.historicalTasteRubric,
    labelCatalog: source.labelCatalog,
    a: a.output
  });
  const [bOutcome, cOutcome] = await Promise.all([
    bOutcomePromise,
    settle(execute("C", cInput, semanticSchema("C")))
  ]);
  if (!bOutcome.ok) throw bOutcome.error;
  if (!cOutcome.ok) throw cOutcome.error;
  const b = bOutcome.value;
  const c = cOutcome.value;
  const dInput = canonicalStageInput({
    sourceBinding: input.sourceBinding,
    hardRules: source.hardRules,
    b: b.output,
    c: c.output
  });
  const d = await execute("D", dInput, semanticSchema("D"));

  let output: ReviewFlowUnifiedResult;
  let formatter: ReviewFlowCompletedStage | undefined;
  if (input.nativeSchemaCompatible) {
    try {
      const candidate = {
        schemaVersion: 1,
        a: parseStageJson("A", a.output),
        b: parseStageJson("B", b.output),
        c: parseStageJson("C", c.output),
        d: parseStageJson("D", d.output)
      };
      output = parseReviewFlowUnifiedResult(candidate);
    } catch {
      const formatterInput = canonicalStageInput({
        a: a.output,
        b: b.output,
        c: c.output,
        d: d.output
      });
      formatter = await execute("formatter", formatterInput, reviewFlowUnifiedJsonSchema);
      output = parseReviewFlowUnifiedResult(parseJsonObject(formatter.output));
    }
  } else {
    const formatterInput = canonicalStageInput({
      a: a.output,
      b: b.output,
      c: c.output,
      d: d.output
    });
    formatter = await execute("formatter", formatterInput, reviewFlowUnifiedJsonSchema);
    output = parseReviewFlowUnifiedResult(parseJsonObject(formatter.output));
  }

  const stages = formatter === undefined
    ? Object.freeze({ A: a, B: b, C: c, D: d })
    : Object.freeze({ A: a, B: b, C: c, D: d, formatter });
  return Object.freeze({
    output,
    stages,
    reusedStages: Object.freeze(reusedStages),
    semanticRequestCount,
    formatterRequestCount: formatter === undefined ? 0 : 1,
    criticalPathSemanticRequests: 3
  });
}

export function parseReviewFlowUnifiedResult(value: unknown): ReviewFlowUnifiedResult {
  if (!validateMachineJsonValue(reviewFlowUnifiedJsonSchema, value)) {
    throw new Error("REVIEW_FLOW_UNIFIED_SCHEMA_INVALID");
  }
  return deepFreeze(value) as ReviewFlowUnifiedResult;
}

export function validateMachineJsonValue(schema: MachineJsonSchema, value: unknown): boolean {
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum !== undefined && !schema.enum.some((candidate) => candidate === value)) return false;
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((type) => machineTypeMatches(type, value))) return false;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return false;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items !== undefined && !value.every((item) => validateMachineJsonValue(schema.items!, item))) {
      return false;
    }
  }
  if (isPlainObject(value) && schema.properties !== undefined) {
    const required = schema.required ?? [];
    if (required.some((property) => !Object.hasOwn(value, property))) return false;
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties));
      if (Object.keys(value).some((property) => !allowed.has(property))) return false;
    }
    for (const [property, propertySchema] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, property) && !validateMachineJsonValue(propertySchema, value[property])) {
        return false;
      }
    }
  }
  return true;
}

function reusableStageMatches(
  completed: ReviewFlowCompletedStage,
  expected: Omit<ReviewFlowStageReceipt, "attemptCount" | "eofVerified" | "outputHash" | "receiptHash">
): boolean {
  const receipt = completed.receipt;
  if (
    receipt.stage !== expected.stage ||
    receipt.inputHash !== expected.inputHash ||
    receipt.promptHash !== expected.promptHash ||
    receipt.schemaFingerprint !== expected.schemaFingerprint ||
    receipt.modelFingerprint !== expected.modelFingerprint ||
    receipt.eofVerified !== true ||
    receipt.attemptCount < 1 ||
    receipt.attemptCount > 3 ||
    receipt.outputHash !== hashCanonicalValue(completed.output)
  ) {
    return false;
  }
  return receipt.receiptHash === hashCanonicalValue({
    stage: receipt.stage,
    inputHash: receipt.inputHash,
    promptHash: receipt.promptHash,
    schemaFingerprint: receipt.schemaFingerprint,
    modelFingerprint: receipt.modelFingerprint,
    attemptCount: receipt.attemptCount,
    eofVerified: receipt.eofVerified,
    outputHash: receipt.outputHash
  });
}

function sealCompletedStage(input: {
  readonly stage: ReviewFlowDagStage;
  readonly inputHash: string;
  readonly promptHash: string;
  readonly schemaFingerprint: string | null;
  readonly modelFingerprint: string;
  readonly attemptCount: number;
  readonly output: string;
}): ReviewFlowCompletedStage {
  const receiptWithoutHash = {
    stage: input.stage,
    inputHash: input.inputHash,
    promptHash: input.promptHash,
    schemaFingerprint: input.schemaFingerprint,
    modelFingerprint: input.modelFingerprint,
    attemptCount: input.attemptCount,
    eofVerified: true as const,
    outputHash: hashCanonicalValue(input.output)
  };
  return Object.freeze({
    output: input.output,
    receipt: Object.freeze({
      ...receiptWithoutHash,
      receiptHash: hashCanonicalValue(receiptWithoutHash)
    })
  });
}

function buildStageMessages(stage: ReviewFlowDagStage, input: string): FourCallRequest["messages"] {
  const stageInstruction: Readonly<Record<ReviewFlowDagStage, string>> = {
    A: "A：只看题面盲解；给出可验证解法，并分别保留支持与反对信号。不得读取难度或历史裁决。",
    B: "B：只按冻结 Codeforces 参考锚点独立估计难度。不得读取 A、其它评价或人工裁决。",
    C: "C：基于题目与 A 盲解，综合核验题解、技术质量、命题质量、比赛适配、原创性和标签；保留独立正反信号。不得读取 B。",
    D: "D：只基于 B 与 C 做独立反证和硬规则裁决。难度与通过结论不得互相推出。若允许结构化输出，必须完整填充统一 schema。",
    formatter: "统一 formatter：逐字段转写 A/B/C/D 已有语义到给定 JSON Schema。禁止增加、删除、纠正或重新判断任何结论。"
  };
  return Object.freeze([
    Object.freeze({
      role: "system" as const,
      content: `${stageInstruction[stage]} 所有语义请求必须保持服务商原生 thinking=max。`
    }),
    Object.freeze({ role: "user" as const, content: input })
  ]);
}

function canonicalStageInput(value: unknown): string {
  return JSON.stringify(value);
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new LlmStageRequestError("schema_invalid", { cause: error });
  }
}

function parseStageJson(stage: ReviewFlowSemanticStage, value: string): unknown {
  const parsed = parseJsonObject(value);
  if (!validateMachineJsonValue(reviewFlowStageJsonSchemas[stage], parsed)) {
    throw new LlmStageRequestError("schema_invalid");
  }
  return parsed;
}

function machineTypeMatches(type: MachinePrimitiveType, value: unknown): boolean {
  switch (type) {
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return isPlainObject(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function assertDigest(value: string, errorCode: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(errorCode);
}
