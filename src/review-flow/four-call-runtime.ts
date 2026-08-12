import type { PipelineModelConfig } from "../pipelines/types";
import {
  chatCompleteWithReceipt,
  getLlmFailureAudit,
  LlmJsonOutputError,
  LlmRequestError,
  LlmResponseBodyTooLargeError,
  LlmResponseFormatError,
  type ChatMessage,
  type ChatCompletionWithReceipt,
  type LlmResponseFormatFailureStage,
  type LlmResponseFormatFailureSubstage
} from "../llm";
import {
  runFourCallReviewDag,
  type FourCallDagResult,
  type FourCallModelBinding,
  type FourCallReviewSource,
  type FourCallModelBindings,
  type FourCallRequest,
  type FourCallResponse
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
export interface FourCallSafeRequestTiming {
  readonly firstValidOutputMs: number;
  readonly endToEndMs: number;
  readonly validOutputEventCount: number;
  readonly outputUtf8Bytes: number;
}
export interface FourCallSafeRequestFailure {
  readonly kind: LlmStageFailureKind;
  readonly code:
    | LlmRequestError["code"]
    | "LLM_RESPONSE_BODY_TOO_LARGE"
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
}


export interface FourCallRequestLifecycle {
  /** 在任何可能计费的 fetch 前同步执行；抛错即 fail closed。 */
  readonly beforeRequest: (request: FourCallRequest) => void;
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
  lifecycle?: FourCallRequestLifecycle
): Promise<FourCallResponse> {
  assertRequestMatchesConfig(request.model, config);
  const startedAt = Date.now();
  let firstValidOutputMs: number | null = null;
  let validOutputEventCount = 0;
  let completion: ChatCompletionWithReceipt;
  try {
    completion = await chatCompleteWithReceipt(
      config.credentials,
      config.spec,
      request.messages as ChatMessage[],
      {
        ...config.runtime,
        // 逐阶段逻辑重试由 FairLlmRequestScheduler 统一计数，传输层不得再暗中重试。
        maxAttempts: 1,
        onSafeOutputActivity: () => {
          config.runtime.onSafeOutputActivity?.();
          validOutputEventCount += 1;
          firstValidOutputMs ??= Date.now() - startedAt;
        }
      },
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
  lifecycle?.requestCompleted(request, Object.freeze({
    firstValidOutputMs,
    endToEndMs: Date.now() - startedAt,
    validOutputEventCount,
    outputUtf8Bytes: Buffer.byteLength(completion.content, "utf8")
  }));
  return {
    output: completion.content,
    eofVerified: completion.receipt.eofVerified
  };
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
    error instanceof LlmResponseBodyTooLargeError ||
    error instanceof LlmResponseFormatError ||
    error instanceof LlmJsonOutputError;
  const hasFormatFailure = error instanceof LlmRequestError ||
    error instanceof LlmResponseBodyTooLargeError ||
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
    formatFailureStage: hasFormatFailure
      ? error.formatFailureStage ?? null
      : null,
    formatFailureSubstage: hasFormatFailure
      ? error.formatFailureSubstage ?? null
      : null
  });
}
