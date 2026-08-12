import type { PipelineModelConfig } from "../pipelines/types";
import {
  chatCompleteWithReceipt,
  LlmRequestError,
  type ChatMessage,
  type ChatCompletionWithReceipt
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
import { FairLlmRequestScheduler, LlmStageRequestError } from "../llm-scheduler";
import { hashCanonicalValue } from "./evidence";
import type { ReviewFlowModelConfigs } from "./llm-roles";

export interface FourCallRuntimeModels {
  readonly A: PipelineModelConfig;
  readonly B: PipelineModelConfig;
  readonly C: PipelineModelConfig;
  readonly D: PipelineModelConfig;
  readonly formatter: PipelineModelConfig;
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
    call: async (request) => executeProductionCall(request, input.models[request.stage])
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
  config: PipelineModelConfig
): Promise<FourCallResponse> {
  assertRequestMatchesConfig(request.model, config);
  let completion: ChatCompletionWithReceipt;
  try {
    completion = await chatCompleteWithReceipt(
      config.credentials,
      config.spec,
      request.messages as ChatMessage[],
      {
        ...config.runtime,
        // 逐阶段逻辑重试由 FairLlmRequestScheduler 统一计数，传输层不得再暗中重试。
        maxAttempts: 1
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
    throw classifyTransportFailure(error);
  }
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
