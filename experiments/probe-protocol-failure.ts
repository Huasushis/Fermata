/**
 * 安全协议探测：确认 thinking+streaming 与 SSE 解析的兼容性。
 *
 * 只发送公开合成提示词（非私有题面），只输出安全元数据：
 *   - HTTP 状态码
 *   - LlmResponseFormatFailureStage / Substage（闭集枚举）
 *   - content 是否非空、reasoning_content 是否非空
 *   - content 字节长度（不含正文）
 *   - finish_reason
 *   - 请求是否发送了 thinking / reasoning_effort / response_format
 *   - 请求 URL 和 method（不含 baseUrl）
 *
 * 绝不输出请求正文、模型响应正文、题面、凭据或环境变量值。
 */
import { z } from "zod";
import {
  loadConfig,
  getProviderCredentials,
  type ProviderCredentials,
  type ModelSpec
} from "../src/config.js";
import {
  chatCompleteWithReceipt,
  chatCompleteJsonWithReceipt,
  LlmResponseFormatError,
  LlmJsonOutputError,
  LlmRequestError,
  getLlmFailureAudit,
  type LlmResponseFormatFailureStage,
  type LlmResponseFormatFailureSubstage,
  type LlmRuntimeOptions
} from "../src/llm.js";

// 两条独立探测路径，各发一个请求：
// 1) chatCompleteWithReceipt（纯文本，非 JSON）
// 2) chatCompleteJsonWithReceipt（JSON schema 约束，prompt-only）
// 用 deepseek-v4-pro + thinking:true + max，复刻 reviewFlow solver 角色的配置。

const probeSpec: ModelSpec = {
  provider: "aether",
  model: "deepseek-v4-pro",
  temperature: 0.4,
  thinking: true,
  thinkingRequest: "enabled",
  reasoningEffort: "max"
};

const jsonProbeSpec: ModelSpec = {
  provider: "aether",
  model: "deepseek-v4-pro",
  temperature: 0.4,
  thinking: true,
  thinkingRequest: "enabled",
  reasoningEffort: "max"
};

const probeRuntime: Omit<LlmRuntimeOptions, "fetch"> = {
  firstOutputTimeoutMs: 1_800_000,
  outputIdleTimeoutMs: 600_000,
  maximumDurationMs: 3_600_000,
  maxAttempts: 1,
  baseDelayMs: 500
};

// 合成公开提示词——不是题面，不包含任何私有信息。
const plainMessages = [
  {
    role: "user" as const,
    content: "请用一句话回答：1+1 等于几？只输出答案数字。"
  }
];

const jsonSchema = z.object({
  answer: z.string().min(1).max(100)
});

const jsonMessages = [
  {
    role: "user" as const,
    content: "请输出一个 JSON 对象，包含字段 answer，值为 1+1 的结果。只输出 JSON 对象本身。"
  }
];

// 复杂公开提示词——模拟审稿流程的复杂度，但不包含任何私有题面。
const complexMessages = [
  {
    role: "user" as const,
    content: "你是一个算法题目审稿人。请分析以下公开题目并给出判断。\n\n题目：给定一个正整数 n，判断它是否为偶数。\n输入：一个正整数 n (1 ≤ n ≤ 10^9)。\n输出：如果是偶数输出 YES，否则输出 NO。\n\n请分析：1) 题目难度（easy/medium/hard）2) 是否适合作为竞赛题目 3) 数据范围是否合理\n\n请用中文详细回答。"
  }
];

interface SafeProbeResult {
  readonly probe: string;
  readonly httpStatus: number | null;
  readonly formatFailureStage: LlmResponseFormatFailureStage | null;
  readonly formatFailureSubstage: LlmResponseFormatFailureSubstage | null;
  readonly errorCode: string | null;
  readonly errorName: string | null;
  readonly contentLength: number | null;
  readonly reasoningLength: number | null;
  readonly finishReason: string | null;
  readonly eofVerified: boolean | null;
  readonly transportAttemptCount: number | null;
  readonly requestCount: number | null;
  readonly jsonSchemaValidated: boolean | null;
  readonly failureAuditStage: string | null;
  readonly failureAuditHttpStatus: number | null;
}

function describeError(error: unknown): SafeProbeResult {
  const base: SafeProbeResult = {
    probe: "",
    httpStatus: null,
    formatFailureStage: null,
    formatFailureSubstage: null,
    errorCode: null,
    errorName: null,
    contentLength: null,
    reasoningLength: null,
    finishReason: null,
    eofVerified: null,
    transportAttemptCount: null,
    requestCount: null,
    jsonSchemaValidated: null,
    failureAuditStage: null,
    failureAuditHttpStatus: null
  };

  if (error instanceof LlmResponseFormatError) {
    const audit = getLlmFailureAudit(error);
    return {
      ...base,
      formatFailureStage: error.formatFailureStage,
      formatFailureSubstage: error.formatFailureSubstage ?? null,
      errorCode: error.code,
      errorName: error.name,
      httpStatus: audit?.terminal.status ?? null,
      transportAttemptCount: audit?.transportAttemptCount ?? null
    };
  }

  if (error instanceof LlmJsonOutputError) {
    const audit = getLlmFailureAudit(error);
    return {
      ...base,
      errorCode: error.code,
      errorName: error.name,
      httpStatus: audit?.terminal.status ?? null,
      requestCount: audit?.requestCount ?? null,
      transportAttemptCount: audit?.transportAttemptCount ?? null,
      jsonSchemaValidated: audit?.jsonSchemaValidated ?? null
    };
  }

  if (error instanceof LlmRequestError) {
    return {
      ...base,
      errorCode: error.code,
      errorName: error.name,
      httpStatus: error.status ?? null
    };
  }

  if (error instanceof Error) {
    const code =
      typeof (error as unknown as { code?: unknown }).code === "string"
        ? String((error as unknown as { code: string }).code)
        : null;
    return {
      ...base,
      errorCode: code,
      errorName: error.name
    };
  }

  return { ...base, errorName: "unknown" };
}

async function runPlainProbe(
  credentials: ProviderCredentials
): Promise<SafeProbeResult> {
  const base: SafeProbeResult = {
    probe: "plain-text",
    httpStatus: null,
    formatFailureStage: null,
    formatFailureSubstage: null,
    errorCode: null,
    errorName: null,
    contentLength: null,
    reasoningLength: null,
    finishReason: null,
    eofVerified: null,
    transportAttemptCount: null,
    requestCount: null,
    jsonSchemaValidated: null,
    failureAuditStage: null,
    failureAuditHttpStatus: null
  };

  try {
    const result = await chatCompleteWithReceipt(
      credentials,
      probeSpec,
      plainMessages,
      { ...probeRuntime, fetch: undefined as never } as LlmRuntimeOptions,
      { requestJson: false, maxOutputTokens: 4096 }
    );
    return {
      ...base,
      contentLength: result.content.length,
      reasoningLength: result.reasoning?.length ?? null,
      eofVerified: result.receipt.eofVerified,
      transportAttemptCount: result.receipt.transportAttemptCount
    };
  } catch (error) {
    return { ...describeError(error), probe: "plain-text" };
  }
}


async function runJsonProbe(
  credentials: ProviderCredentials
): Promise<SafeProbeResult> {
  const base: SafeProbeResult = {
    probe: "json-schema",
    httpStatus: null,
    formatFailureStage: null,
    formatFailureSubstage: null,
    errorCode: null,
    errorName: null,
    contentLength: null,
    reasoningLength: null,
    finishReason: null,
    eofVerified: null,
    transportAttemptCount: null,
    requestCount: null,
    jsonSchemaValidated: null,
    failureAuditStage: null,
    failureAuditHttpStatus: null
  };

  try {
    const result = await chatCompleteJsonWithReceipt(
      credentials,
      jsonProbeSpec,
      jsonMessages,
      jsonSchema,
      { ...probeRuntime, fetch: undefined as never } as LlmRuntimeOptions,
      { maxOutputTokens: 4096 }
    );
    return {
      ...base,
      contentLength: null,
      reasoningLength: result.reasoning?.length ?? null,
      eofVerified: result.receipt.eofVerified,
      transportAttemptCount: result.receipt.transportAttemptCount,
      requestCount: result.receipt.requestCount,
      jsonSchemaValidated: result.receipt.jsonSchemaValidated
    };
  } catch (error) {
    return { ...describeError(error), probe: "json-schema" };
  }
}

async function runComplexProbe(
  credentials: ProviderCredentials
): Promise<SafeProbeResult> {
  const base: SafeProbeResult = {
    probe: "complex-text",
    httpStatus: null,
    formatFailureStage: null,
    formatFailureSubstage: null,
    errorCode: null,
    errorName: null,
    contentLength: null,
    reasoningLength: null,
    finishReason: null,
    eofVerified: null,
    transportAttemptCount: null,
    requestCount: null,
    jsonSchemaValidated: null,
    failureAuditStage: null,
    failureAuditHttpStatus: null
  };

  try {
    const result = await chatCompleteWithReceipt(
      credentials,
      probeSpec,
      complexMessages,
      { ...probeRuntime, fetch: undefined as never } as LlmRuntimeOptions,
      { requestJson: false, maxOutputTokens: 8192 }
    );
    return {
      ...base,
      contentLength: result.content.length,
      reasoningLength: result.reasoning?.length ?? null,
      eofVerified: result.receipt.eofVerified,
      transportAttemptCount: result.receipt.transportAttemptCount
    };
  } catch (error) {
    return { ...describeError(error), probe: "complex-text" };
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const profile =
    config.models.profiles[config.models.defaults.modelProfileName];
  const reviewSolver = profile?.reviewFlow?.solver;
  if (!reviewSolver) {
    throw new Error("PROBE_CONFIG_MISSING_REVIEW_SOLVER");
  }
  // 确认实际配置与探测预期一致（安全：只比较枚举值，不含密钥）
  console.log("config-check:", JSON.stringify({
    model: reviewSolver.model,
    provider: reviewSolver.provider,
    thinking: reviewSolver.thinking,
    thinkingRequest: reviewSolver.thinkingRequest,
    reasoningEffort: reviewSolver.reasoningEffort,
    temperature: reviewSolver.temperature
  }));

  const credentials = getProviderCredentials(config, reviewSolver.provider);
  if (!credentials) {
    throw new Error("PROBE_CONFIG_MISSING_CREDENTIALS");
  }

  console.log("--- starting plain-text probe ---");
  const plain = await runPlainProbe(credentials);
  console.log("plain-result:", JSON.stringify(plain));

  console.log("--- starting json-schema probe ---");
  const json = await runJsonProbe(credentials);
  console.log("json-result:", JSON.stringify(json));

  console.log("--- starting complex-text probe ---");
  const complex = await runComplexProbe(credentials);
  console.log("complex-result:", JSON.stringify(complex));
}

main().catch((error) => {
  console.error("probe-fatal:", error instanceof Error ? error.name : "unknown");
  process.exit(1);
});
