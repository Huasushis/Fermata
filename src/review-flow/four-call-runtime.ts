import type { PipelineModelConfig } from "../pipelines/types";
import {
  chatCompleteTwoRoundJsonWithReceipt,
  chatCompleteWithReceipt,
  chatCompleteSalvageableWithReceipt,
  chatCompleteReasoningSalvageJsonWithReceipt,
  getLlmFailureAudit,
  LlmJsonOutputError,
  LlmRequestError,
  LlmRetainedTextTooLargeError,
  LlmResponseFormatError,
  serializeTargetJsonSchema,
  type ChatMessage,
  type ChatCompletionWithReceipt,
  type ChatCompletionSalvageableResult,
  type LlmJsonCompletionReceipt,
  type LlmReasoningSalvageJsonReceipt,
  type LlmRuntimeOptions,
  type LlmSseAcceptedShapeAudit,
  type LlmSalvageTransportReceipt,
  type LlmTransportReceipt,
  type LlmResponseFormatFailureStage,
  type LlmResponseFormatFailureSubstage,
  type LlmSseRejectedEventAudit
} from "../llm";
import {
  reviewFlowStageAZodSchema,
  runFourCallReviewDag,
  type FourCallDagResult,
  type FourCallModelBinding,
  type FourCallReviewSource,
  type FourCallModelBindings,
  type FourCallRequest,
  type FourCallResponse,
  type ReviewFlowStageAPayload
} from "./four-call";
import {
  FairLlmRequestScheduler,
  LlmStageRequestError,
  type LlmStageFailureKind
} from "../llm-scheduler";
import { hashCanonicalValue } from "./evidence";
import type { ReviewFlowModelConfigs } from "./llm-roles";

export interface FourCallRuntimeModels {
  readonly A: PipelineModelConfig;
  readonly B: PipelineModelConfig;
  readonly C: PipelineModelConfig;
  readonly D: PipelineModelConfig;
  readonly formatter: PipelineModelConfig;
}
export type FourCallSafeRoundName = "semantic" | "format" | "format_repair" | "salvage_finalization" | "salvage_finalization_repair";

/** 两轮（语义→格式）A 阶段中单个轮次的消毒观测；只含协议状态与计数。 */
export interface FourCallSafeRoundReceipt {
  readonly round: FourCallSafeRoundName;
  readonly firstValidOutputMs: number | null;
  readonly endToEndMs: number;
  readonly validOutputEventCount: number;
  readonly transportAttemptCount: number;
  readonly eofVerified: true;
  readonly acceptedEventShapes: readonly LlmSseAcceptedShapeAudit[];
}

export interface FourCallSafeRequestTiming {
  readonly firstValidOutputMs: number;
  readonly endToEndMs: number;
  readonly validOutputEventCount: number;
  readonly outputUtf8Bytes: number;
  readonly acceptedEventShapes: readonly LlmSseAcceptedShapeAudit[];
  /**
   * 该逻辑请求实际消耗的外部传输次数（每轮一次，含修复轮）。单轮阶段固定为 1；
   * A 阶段等于两个轮次的 transportAttemptCount 之和。旧调用方可能不写该字段。
   */
  readonly externalTransportAttemptsUsed?: number;
  /** 仅两轮 A 阶段写入：语义→格式（→格式修复）的逐轮观测。 */
  readonly rounds?: readonly FourCallSafeRoundReceipt[];
}
export interface FourCallSafeRequestFailure {
  readonly kind: LlmStageFailureKind;
  readonly code:
    | LlmRequestError["code"]
    | "LLM_RETAINED_TEXT_TOO_LARGE"
    | "LLM_RESPONSE_FORMAT_INVALID"
    | "LLM_JSON_OUTPUT_INVALID"
    | "unknown";
  readonly httpStatus: number | null;
  readonly requestCount: 0 | 1 | 2 | 3 | 4;
  readonly transportAttemptCount: number;
  readonly completedResponseCount: number;
  readonly terminalResponseMode: "sse" | "json" | null;
  readonly terminalEofObserved: boolean;
  readonly terminalFinishReasonStopObserved: boolean;
  readonly terminalSseDoneObserved: boolean | null;
  readonly jsonSchemaValidated: false | null;
  readonly formatFailureStage: LlmResponseFormatFailureStage | null;
  readonly formatFailureSubstage: LlmResponseFormatFailureSubstage | null;
  readonly streamEventCount: number;
  readonly streamUtf8Bytes: number;
  readonly streamChunkCount: number;
  readonly usageEventCount: number;
  readonly usageTotalTokens: number | null;
  readonly acceptedEventShapes: readonly LlmSseAcceptedShapeAudit[];
  readonly firstRejectedEvent: LlmSseRejectedEventAudit | null;
}


export interface FourCallRequestLifecycle {
  /** 在任何可能计费的 fetch 前同步执行；抛错即 fail closed。 */
  readonly beforeRequest: (request: FourCallRequest) => void;
  /**
   * 在每一次可能计费的外部传输真正发起前执行（两轮 A 阶段每轮一次）；
   * 抛错即 fail closed，由传输层转换为 LLM_TRANSPORT_DENIED，不会发起 fetch。
   */
  readonly beforeTransport?: (request: FourCallRequest) => void;
  readonly requestCompleted: (
    request: FourCallRequest,
    timing: FourCallSafeRequestTiming
  ) => void;
  readonly requestFailed: (
    request: FourCallRequest,
    failure: FourCallSafeRequestFailure
  ) => void;
}


export function fourCallRuntimeModelsFromLegacySlots(
  models: ReviewFlowModelConfigs
): FourCallRuntimeModels {
  return Object.freeze({
    A: models.solver,
    B: models.difficulty,
    C: models.editorial_judge,
    D: models.adjudicator,
    formatter: models.tags
  });
}

/**
 * 生产适配层。调用者显式传入共享 scheduler，因此不同样本、不同模型档位绝不会各建
 * 一套并发计数。此函数不读取环境文件，也不会自行启动任何请求。
 */
export async function runProductionFourCallReviewDag(input: {
  readonly caseId: string;
  readonly sourceBinding: string;
  readonly source: FourCallReviewSource;
  readonly models: FourCallRuntimeModels;
  readonly nativeSchemaCompatible: boolean;
  readonly scheduler: FairLlmRequestScheduler;
  readonly reusableStages?: Parameters<typeof runFourCallReviewDag>[0]["reusableStages"];
  readonly onStageCompleted?: Parameters<
    typeof runFourCallReviewDag
  >[0]["onStageCompleted"];
  readonly lifecycle?: FourCallRequestLifecycle;
}): Promise<FourCallDagResult> {
  const bindings: FourCallModelBindings = Object.freeze({
    A: modelBinding(input.models.A),
    B: modelBinding(input.models.B),
    C: modelBinding(input.models.C),
    D: modelBinding(input.models.D),
    formatter: modelBinding(input.models.formatter)
  });
  return runFourCallReviewDag({
    caseId: input.caseId,
    sourceBinding: input.sourceBinding,
    source: input.source,
    model: bindings,
    nativeSchemaCompatible: input.nativeSchemaCompatible,
    scheduler: input.scheduler,
    reusableStages: input.reusableStages,
    onStageCompleted: input.onStageCompleted,
    call: async (request) => {
      input.lifecycle?.beforeRequest(request);
      return executeProductionCall(
        request,
        input.models[request.stage],
        input.models.formatter,
        input.lifecycle
      );
    }
  });
}

export function createFourCallScheduler(input: {
  readonly maximumConcurrency?: 12 | 16 | 20;
  readonly twentyConcurrencyProbeAccepted?: boolean;
} = {}): FairLlmRequestScheduler {
  return new FairLlmRequestScheduler({
    maximumConcurrency: input.maximumConcurrency ?? 12,
    twentyConcurrencyProbeAccepted: input.twentyConcurrencyProbeAccepted
  });
}
async function executeProductionCall(
  request: FourCallRequest,
  config: PipelineModelConfig,
  formatterConfig: PipelineModelConfig,
  lifecycle?: FourCallRequestLifecycle
): Promise<FourCallResponse> {
  assertRequestMatchesConfig(request.model, config);
  if (request.stage === "A") {
    return executeProductionStageATwoRound(request, config, formatterConfig, lifecycle);
  }
  const startedAt = Date.now();
  let firstValidOutputMs: number | null = null;
  let validOutputEventCount = 0;
  let completion: ChatCompletionWithReceipt | { content: string; receipt: LlmTransportReceipt | LlmSalvageTransportReceipt; salvagedContent: true };
  try {
    const salvageable = await chatCompleteSalvageableWithReceipt(
      config.credentials,
      config.spec,
      request.messages as ChatMessage[],
      buildCallRuntime(request, config, lifecycle, startedAt, () => {
        validOutputEventCount += 1;
        firstValidOutputMs ??= Date.now() - startedAt;
      }),
      {
        maxOutputTokens: request.maxOutputTokens,
        responseJsonSchema: request.schema === null
          ? undefined
          : {
              name: `fermata_review_flow_${request.stage.toLowerCase()}_v1`,
              schema: request.schema as Readonly<Record<string, unknown>>
            }
      }
    );
    if (!salvageable.salvaged) {
      completion = salvageable;
    } else {
      // 抢救路径：C/D 的 Pro 分析轮 finish_reason="length"，reasoning 非空。
      // 用 formatter（Flash）做 finalizer 提取结构化 JSON。
      const finalizerOutput = await executeSalvageFinalizer(
        request,
        config,
        formatterConfig,
        salvageable.reasoning,
        salvageable.receipt,
        lifecycle,
        startedAt,
        () => {
          validOutputEventCount += 1;
        }
      );
      completion = {
        content: finalizerOutput.content,
        receipt: finalizerOutput.receipt,
        salvagedContent: true
      };
    }
  } catch (error) {
    const classified = classifyTransportFailure(error);
    lifecycle?.requestFailed(
      request,
      safeRequestFailure(error, classified.kind)
    );
    throw classified;
  }
  if (firstValidOutputMs === null || validOutputEventCount < 1) {
    const classified = new LlmStageRequestError("stream_interrupted");
    lifecycle?.requestFailed(
      request,
      safeRequestFailure(classified, classified.kind)
    );
    throw classified;
  }
  const transportReceipt = "salvagedContent" in completion
    ? completion.receipt
    : completion.receipt;
  lifecycle?.requestCompleted(request, Object.freeze({
    firstValidOutputMs,
    endToEndMs: Date.now() - startedAt,
    validOutputEventCount,
    outputUtf8Bytes: Buffer.byteLength(completion.content, "utf8"),
    acceptedEventShapes: transportReceipt.acceptedEventShapes,
    externalTransportAttemptsUsed: transportReceipt.transportAttemptCount
  }));
  return {
    output: completion.content,
    eofVerified: transportReceipt.eofVerified
  };
}

/**
 * C/D 抢救 finalizer：把 Pro 分析轮的 reasoning 传给 Flash，
 * 由 Flash 提取满足 schema 的 JSON。不含原始 reasoning 的 receipt。
 */
async function executeSalvageFinalizer(
  request: FourCallRequest,
  config: PipelineModelConfig,
  formatterConfig: PipelineModelConfig,
  analysisReasoning: string,
  analysisReceipt: LlmSalvageTransportReceipt,
  lifecycle: FourCallRequestLifecycle | undefined,
  startedAt: number,
  onValidOutput: () => void
): Promise<{ content: string; receipt: LlmTransportReceipt }> {
  const schemaDescription = request.schema === null
    ? "一个 JSON 对象"
    : JSON.stringify(request.schema, null, 2);
  const finalizerMessages: ChatMessage[] = [
    {
      role: "system",
      content: "只输出一个满足要求的 JSON 对象本身，不要输出任何解释、前后缀文字，也不要用 Markdown 代码块包裹。"
    },
    {
      role: "user",
      content: [
        "以下是一段分析推理文本。请从中提取最终结论，转换为符合要求的 JSON。不要重新推理，只做信息提取和格式转换：",
        analysisReasoning
      ].join("\n")
    },
    {
      role: "user",
      content: `目标 JSON Schema：\n${schemaDescription}`
    }
  ];
  const firstFinal = await chatCompleteWithReceipt(
    formatterConfig.credentials,
    formatterConfig.spec,
    finalizerMessages,
    buildCallRuntime(request, formatterConfig, lifecycle, startedAt, onValidOutput),
    {
      requestJson: true,
      maxOutputTokens: request.maxOutputTokens
    }
  );
  // 验证 finalizer 输出是合法 JSON
  try {
    JSON.parse(firstFinal.content);
  } catch {
    // finalizer 输出不是合法 JSON，修复轮
    const repairMessages: ChatMessage[] = [
      ...finalizerMessages,
      { role: "assistant", content: firstFinal.content },
      {
        role: "user",
        content: "上一条回复不是合法 JSON。请只重新输出一个满足要求的 JSON 对象，不要包含任何其它文字或代码块标记。"
      }
    ];
    const secondFinal = await chatCompleteWithReceipt(
      formatterConfig.credentials,
      formatterConfig.spec,
      repairMessages,
      buildCallRuntime(request, formatterConfig, lifecycle, startedAt, onValidOutput),
      {
        requestJson: true,
        maxOutputTokens: request.maxOutputTokens
      }
    );
    JSON.parse(secondFinal.content);
    return { content: secondFinal.content, receipt: secondFinal.receipt };
  }
  return { content: firstFinal.content, receipt: firstFinal.receipt };
}

/**
 * 构造传输层运行时：逐阶段逻辑重试统一交由 FairLlmRequestScheduler 计数，
 * 传输层不再暗中重试；活动回调先通知调用方再累计；若调用方注册了 transport
 * 前置校验点，则在每次可能计费的 fetch 前执行（抛错即 fail closed）。
 */
function buildCallRuntime(
  request: FourCallRequest,
  config: PipelineModelConfig,
  lifecycle: FourCallRequestLifecycle | undefined,
  startedAt: number,
  onActivity: () => void
): LlmRuntimeOptions {
  const configuredDispatch = config.runtime.onTransportDispatch;
  const beforeTransport = lifecycle?.beforeTransport;
  return Object.freeze({
    ...config.runtime,
    maxAttempts: 1,
    onSafeOutputActivity: () => {
      config.runtime.onSafeOutputActivity?.();
      onActivity();
    },
    ...(configuredDispatch !== undefined || beforeTransport !== undefined
      ? {
          onTransportDispatch: async (attempt: number) => {
            try {
              await configuredDispatch?.(attempt);
            } finally {
              beforeTransport?.(request);
            }
          }
        }
      : {})
  });
}

/** A 阶段（盲解）两轮路径：语义轮自由文本 → 格式轮只做 JSON Schema 转换。
 * 启用 reasoning salvage：当语义轮因 finish_reason="length" 截断且 reasoning
 * 非空时，改由 formatter（Flash）做 finalizer 提取结构化 JSON，避免重新发起
 * ~81 分钟的 Pro 语义轮。正常 finish_reason="stop" 路径完全不受影响。 */
async function executeProductionStageATwoRound(
  request: FourCallRequest,
  config: PipelineModelConfig,
  formatterConfig: PipelineModelConfig,
  lifecycle?: FourCallRequestLifecycle
): Promise<FourCallResponse> {
  const startedAt = Date.now();
  let firstValidOutputMs: number | null = null;
  let validOutputEventCount = 0;
  let currentRoundAcc: MutableRoundAccumulator | null = null;
  const rounds: FourCallSafeRoundReceipt[] = [];
  let result: {
    data: ReviewFlowStageAPayload;
    reasoning: string | null;
    receipt: LlmJsonCompletionReceipt | LlmReasoningSalvageJsonReceipt;
  };
  try {
    result = await chatCompleteReasoningSalvageJsonWithReceipt(
      config.credentials,
      config.spec,
      formatterConfig.spec,
      request.messages as ChatMessage[],
      reviewFlowStageAFormatterMessages,
      reviewFlowStageAZodSchema,
      buildCallRuntime(request, config, lifecycle, startedAt, () => {
        validOutputEventCount += 1;
        firstValidOutputMs ??= Date.now() - startedAt;
        if (currentRoundAcc !== null) {
          currentRoundAcc.validOutputEventCount += 1;
          currentRoundAcc.firstValidOutputMs ??=
            Date.now() - currentRoundAcc.startedAtMs;
        }
      }),
      {
        maxOutputTokens: request.maxOutputTokens
      },
      {
        onRoundStart: (round) => {
          if (round === "semantic" || round === "format" || round === "format_repair") {
            currentRoundAcc = {
              round,
              startedAtMs: Date.now(),
              firstValidOutputMs: null,
              validOutputEventCount: 0
            };
          }
        },
        onRoundSettled: (round, transport) => {
          if (currentRoundAcc !== null && currentRoundAcc.round === round) {
            rounds.push(reviewFlowSafeRoundReceipt(currentRoundAcc, transport));
          }
          currentRoundAcc = null;
        },
        onSalvageFinalizationStart: () => {
          currentRoundAcc = {
            round: "salvage_finalization",
            startedAtMs: Date.now(),
            firstValidOutputMs: null,
            validOutputEventCount: 0
          };
        },
        onSalvageFinalizationSettled: (transport) => {
          if (currentRoundAcc !== null && currentRoundAcc.round === "salvage_finalization") {
            rounds.push(reviewFlowSafeRoundReceipt(currentRoundAcc, transport));
          }
          currentRoundAcc = null;
        },
        onSalvageFinalizationRepairStart: () => {
          currentRoundAcc = {
            round: "salvage_finalization_repair",
            startedAtMs: Date.now(),
            firstValidOutputMs: null,
            validOutputEventCount: 0
          };
        },
        onSalvageFinalizationRepairSettled: (transport) => {
          if (currentRoundAcc !== null && currentRoundAcc.round === "salvage_finalization_repair") {
            rounds.push(reviewFlowSafeRoundReceipt(currentRoundAcc, transport));
          }
          currentRoundAcc = null;
        }
      }
    );
  } catch (error) {
    const classified = classifyTransportFailure(error);
    lifecycle?.requestFailed(
      request,
      safeRequestFailure(error, classified.kind)
    );
    throw classified;
  }
  if (firstValidOutputMs === null || validOutputEventCount < 1) {
    const classified = new LlmStageRequestError("stream_interrupted");
    lifecycle?.requestFailed(
      request,
      safeRequestFailure(classified, classified.kind)
    );
    throw classified;
  }
  const output = JSON.stringify(result.data);
  lifecycle?.requestCompleted(request, Object.freeze({
    firstValidOutputMs,
    endToEndMs: Date.now() - startedAt,
    validOutputEventCount,
    outputUtf8Bytes: Buffer.byteLength(output, "utf8"),
    acceptedEventShapes: result.receipt.responses.flatMap(
      (transport) => transport.acceptedEventShapes
    ),
    externalTransportAttemptsUsed: result.receipt.transportAttemptCount,
    rounds: Object.freeze([...rounds])
  }));
  return { output, eofVerified: true };
}

interface MutableRoundAccumulator {
  readonly round: FourCallSafeRoundName;
  readonly startedAtMs: number;
  firstValidOutputMs: number | null;
  validOutputEventCount: number;
}

function reviewFlowSafeRoundReceipt(
  acc: MutableRoundAccumulator,
  transport: ChatCompletionWithReceipt["receipt"]
): FourCallSafeRoundReceipt {
  return Object.freeze({
    round: acc.round,
    firstValidOutputMs: acc.firstValidOutputMs,
    endToEndMs: Date.now() - acc.startedAtMs,
    validOutputEventCount: acc.validOutputEventCount,
    transportAttemptCount: transport.transportAttemptCount,
    // 结算钩子在 assertStructuredCompletionTransport 之后才触发，
    // 因此此处 eofVerified 恒为 true。
    eofVerified: transport.eofVerified as true,
    acceptedEventShapes: transport.acceptedEventShapes
  });
}

/**
 * A 阶段格式轮消息：把语义轮的自由文本转换为满足 A schema 的 JSON。
 * 明确指示"只做格式转换、不重新判断"，与两轮帮助器契约一致。
 */
function reviewFlowStageAFormatterMessages(
  semanticOutput: string,
  semanticReasoning: string | null
): ChatMessage[] {
  return [
    {
      role: "user",
      content: [
        "以下内容是第一阶段盲解判断的文字（目标与思路）。请只把这段内容转换为符合要求的 JSON，不得重新判断、补充或删除任何信息：",
        semanticOutput
      ].join("\n")
    },
    ...(semanticReasoning === null || semanticReasoning.trim() === ""
      ? []
      : [{
          role: "user" as const,
          content: [
            "以下是第一阶段判断的理由，仅用于理解原判断，不得据此重新判断或改写内容：",
            semanticReasoning
          ].join("\n")
        }]),
    {
      role: "user",
      content: [
        "目标 JSON Schema：",
        serializeTargetJsonSchema(reviewFlowStageAZodSchema)
      ].join("\n")
    }
  ];
}

function modelBinding(config: PipelineModelConfig): FourCallModelBinding {
  if (config.spec.thinkingRequest !== "enabled" || config.spec.reasoningEffort !== "max") {
    throw new Error("REVIEW_FLOW_NATIVE_MAX_REQUIRED");
  }
  return Object.freeze({
    provider: config.spec.provider ?? "unknown",
    model: config.spec.model,
    thinkingRequest: "enabled",
    reasoningEffort: "max",
    fingerprint: hashCanonicalValue({
      provider: config.spec.provider ?? "unknown",
      model: config.spec.model,
      thinkingRequest: config.spec.thinkingRequest,
      reasoningEffort: config.spec.reasoningEffort,
      temperature: config.spec.temperature
    })
  });
}

function assertRequestMatchesConfig(
  binding: FourCallModelBinding,
  config: PipelineModelConfig
): void {
  const actual = modelBinding(config);
  if (
    actual.provider !== binding.provider ||
    actual.model !== binding.model ||
    actual.fingerprint !== binding.fingerprint
  ) {
    throw new Error("REVIEW_FLOW_MODEL_BINDING_CHANGED");
  }
}

export function classifyTransportFailure(error: unknown): LlmStageRequestError {
  if (!(error instanceof LlmRequestError)) {
    return new LlmStageRequestError("permanent", { cause: error });
  }
  if (error.code === "LLM_HTTP_ERROR") {
    if (error.status === 429) {
      return new LlmStageRequestError("rate_limited", {

        retryAfterMs: error.retryAfterMs,
        cause: error
      });
    }
    if (error.status !== undefined && error.status >= 500 && error.status <= 599) {
      return new LlmStageRequestError("server_error", { cause: error });
    }
    return new LlmStageRequestError("permanent", { cause: error });
  }
  const byCode: Partial<Record<LlmRequestError["code"], ConstructorParameters<typeof LlmStageRequestError>[0]>> = {
    LLM_NETWORK_FAILED: "connect",
    LLM_FIRST_OUTPUT_TIMEOUT: "first_byte_timeout",
    LLM_OUTPUT_IDLE_TIMEOUT: "no_progress_timeout",
    LLM_STREAM_INTERRUPTED: "stream_interrupted",
    LLM_OUTPUT_LENGTH_LIMIT: "output_limit"
  };
  return new LlmStageRequestError(byCode[error.code] ?? "permanent", { cause: error });
}
function safeRequestFailure(
  error: unknown,
  kind: LlmStageFailureKind
): FourCallSafeRequestFailure {
  const audit = getLlmFailureAudit(error);
  const recognized = error instanceof LlmRequestError ||
    error instanceof LlmRetainedTextTooLargeError ||
    error instanceof LlmResponseFormatError ||
    error instanceof LlmJsonOutputError;
  // 保留文本护栏错误不带格式阶段字段（它不是协议层位置）。
  const hasFormatFailure = error instanceof LlmRequestError ||
    error instanceof LlmResponseFormatError;
  return Object.freeze({
    kind,
    code: recognized ? error.code : "unknown",
    httpStatus: audit?.terminal.status ?? null,
    requestCount: audit?.requestCount ?? 0,
    transportAttemptCount: audit?.transportAttemptCount ?? 0,
    completedResponseCount: audit?.completedResponses.length ?? 0,
    terminalResponseMode: audit?.terminal.responseMode ?? null,
    terminalEofObserved: audit?.terminal.eofObserved ?? false,
    terminalFinishReasonStopObserved:
      audit?.terminal.finishReasonStopObserved ?? false,
    terminalSseDoneObserved: audit?.terminal.sseDoneObserved ?? null,
    jsonSchemaValidated: audit?.jsonSchemaValidated ?? null,
    streamEventCount: audit?.stream.eventCount ?? 0,
    streamUtf8Bytes: audit?.stream.utf8Bytes ?? 0,
    streamChunkCount: audit?.stream.chunkCount ?? 0,
    usageEventCount: audit?.stream.usageEventCount ?? 0,
    usageTotalTokens: audit?.stream.usageTotalTokens ?? null,
    acceptedEventShapes: audit?.stream.acceptedEventShapes ?? [],
    firstRejectedEvent: audit?.stream.firstRejectedEvent ?? null,
    formatFailureStage: hasFormatFailure
      ? error.formatFailureStage ?? null
      : null,
    formatFailureSubstage: hasFormatFailure
      ? error.formatFailureSubstage ?? null
      : null
  });
}
