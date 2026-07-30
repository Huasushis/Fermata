/**
 * 一个很薄的 OpenAI 兼容 Chat Completions 客户端，直接用 fetch 调用，不装任何
 * SDK。支持：
 *   - baseUrl + apiKey 的服务商组合（aether、阿里云百炼 compatible-mode 等，
 *     调用方负责传对应的 baseUrl/apiKey，这个模块本身不知道"provider"这个
 *     概念）；
 *   - 读取思考模型的 reasoning_content（如果响应里有的话）；
 *   - 结构化 JSON 输出：优先用 response_format，同时在提示词里也要求只输出
 *     JSON；解析或校验失败时重新带着错误信息请求一次（只重试这一次，和网络层
 *     的重试是两回事）；
 *   - 网络超时与 429/5xx 的指数退避重试。
 *
 * 不支持流式响应（stream 恒为 false），这是有意简化：审题任务不需要边生成边
 * 展示，等完整结果一次性返回即可，省掉手写 SSE 解析的复杂度和风险。
 */
import { z } from "zod";

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ChatCompletionResult {
  readonly content: string;
  readonly reasoning: string | null;
}

export interface ProviderCredentialsLike {
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface ModelCallSpec {
  readonly model: string;
  readonly temperature: number;
  /** 目前只影响调用方怎么使用 reasoning，请求本身不需要因为这个字段变化。 */
  readonly thinking: boolean;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LlmRuntimeOptions {
  /** 单次 HTTP 请求（含每次重试）的超时时间。 */
  readonly timeoutMs: number;
  /** 总尝试次数，包含第一次，即"最多重试 maxAttempts-1 次"。 */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly fetch?: FetchLike;
}

/** 发出请求但没能拿到成功响应：网络错误、超时、或者重试耗尽后仍然是错误状态码。 */
export class LlmRequestError extends Error {
  public readonly status: number | undefined;

  public constructor(message: string, status?: number) {
    super(message);
    this.name = "LlmRequestError";
    this.status = status;
  }
}

/** 拿到了 2xx 响应，但结构不符合 OpenAI 兼容格式的基本假设（choices/message/content）。 */
export class LlmResponseFormatError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LlmResponseFormatError";
  }
}

/** 请求 JSON 结构化输出，模型给了内容，但两次尝试后仍然不是满足 schema 的 JSON。 */
export class LlmJsonOutputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LlmJsonOutputError";
  }
}

export async function chatComplete(
  provider: ProviderCredentialsLike,
  spec: ModelCallSpec,
  messages: ChatMessage[],
  runtime: LlmRuntimeOptions,
  options: { readonly requestJson?: boolean } = {}
): Promise<ChatCompletionResult> {
  const fetchImpl = runtime.fetch ?? globalThis.fetch;
  const url = new URL("chat/completions", ensureTrailingSlash(provider.baseUrl));
  const body: Record<string, unknown> = {
    model: spec.model,
    temperature: spec.temperature,
    stream: false,
    messages
  };
  if (options.requestJson === true) {
    body.response_format = { type: "json_object" };
  }

  const response = await requestWithRetry(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify(body)
    },
    runtime
  );

  const raw = await parseJsonBodyLeniently(response);

  if (!response.ok) {
    const message = extractProviderErrorMessage(raw) ?? `模型服务返回状态码 ${response.status}`;
    throw new LlmRequestError(message, response.status);
  }

  return extractChatCompletion(raw);
}

/**
 * 请求模型输出满足 `schema` 的 JSON。第一次失败（不是合法 JSON，或者不满足
 * schema）时，会把模型上一次的原始输出和校验错误一起发回去，再请求一次；
 * 两次都失败就抛出 LlmJsonOutputError。返回值里的 reasoning 取自最后一次
 * 成功产生内容的那次调用。
 */
export async function chatCompleteJson<T>(
  provider: ProviderCredentialsLike,
  spec: ModelCallSpec,
  messages: ChatMessage[],
  schema: z.ZodType<T>,
  runtime: LlmRuntimeOptions
): Promise<{ data: T; reasoning: string | null }> {
  const jsonInstruction: ChatMessage = {
    role: "system",
    content: "只输出一个满足要求的 JSON 对象本身，不要输出任何解释、前后缀文字，也不要用 Markdown 代码块包裹。"
  };
  const firstMessages: ChatMessage[] = [jsonInstruction, ...messages];
  let first: ChatCompletionResult;
  try {
    first = await chatComplete(provider, spec, firstMessages, runtime, { requestJson: true });
  } catch (error) {
    if (!(error instanceof LlmResponseFormatError)) {
      throw error;
    }
    // 部分网关在 response_format=json_object 时会把 message.content 置空
    // （实测 aether 网关的 deepseek 系列如此）。降级成纯提示词方式再试一次。
    first = await chatComplete(provider, spec, firstMessages, runtime, { requestJson: false });
  }
  const firstAttempt = tryParseAndValidate(first.content, schema);
  if (firstAttempt.success) {
    return { data: firstAttempt.data, reasoning: first.reasoning };
  }

  const repairMessages: ChatMessage[] = [
    ...firstMessages,
    { role: "assistant", content: first.content },
    {
      role: "user",
      content: `上一条回复不满足要求：${firstAttempt.error}。请只重新输出一个满足要求的 JSON 对象，不要包含任何其它文字或代码块标记。`
    }
  ];
  // 修复轮固定用纯提示词方式，避免再次踩到 response_format 的空内容问题。
  const second = await chatComplete(provider, spec, repairMessages, runtime, { requestJson: false });
  const secondAttempt = tryParseAndValidate(second.content, schema);
  if (secondAttempt.success) {
    return { data: secondAttempt.data, reasoning: second.reasoning ?? first.reasoning };
  }

  throw new LlmJsonOutputError(
    `模型两次输出都不满足 schema。第一次：${firstAttempt.error}；重试一次后：${secondAttempt.error}`
  );
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

type ParseResult<T> = { readonly success: true; readonly data: T } | { readonly success: false; readonly error: string };

function tryParseAndValidate<T>(content: string, schema: z.ZodType<T>): ParseResult<T> {
  const extracted = extractJsonObject(content);
  if (extracted === null) {
    return { success: false, error: "回复里找不到看起来像 JSON 对象的内容" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(extracted);
  } catch (error) {
    return { success: false, error: `JSON.parse 失败：${describeErrorMessage(error)}` };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { success: false, error: parsed.error.message };
  }
  return { success: true, data: parsed.data };
}

/** 从模型输出里尽力抠出一个 JSON 对象：优先看整体、其次看代码块、最后退化成取第一个 { 到最后一个 }。 */
function extractJsonObject(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim();
  if (candidate !== undefined && candidate.startsWith("{") && candidate.endsWith("}")) {
    return candidate;
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return null;
}

async function requestWithRetry(
  fetchImpl: FetchLike,
  url: URL,
  init: RequestInit,
  runtime: LlmRuntimeOptions
): Promise<Response> {
  let attempt = 1;
  for (;;) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), runtime.timeoutMs);
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      const isRetryableStatus = response.status === 429 || response.status >= 500;
      if (!isRetryableStatus || attempt >= runtime.maxAttempts) {
        return response;
      }
    } catch (error) {
      if (attempt >= runtime.maxAttempts) {
        throw new LlmRequestError(`请求模型服务失败（已尝试 ${attempt} 次）：${describeErrorMessage(error)}`);
      }
    } finally {
      clearTimeout(timeout);
    }
    await delay(backoffMs(runtime.baseDelayMs, attempt));
    attempt += 1;
  }
}

function backoffMs(baseDelayMs: number, attempt: number): number {
  return baseDelayMs * 2 ** (attempt - 1);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function parseJsonBodyLeniently(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function extractChatCompletion(raw: unknown): ChatCompletionResult {
  if (typeof raw !== "object" || raw === null) {
    throw new LlmResponseFormatError("模型服务响应不是一个 JSON 对象。");
  }
  const choices = (raw as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmResponseFormatError("模型服务响应里没有 choices。");
  }
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) {
    throw new LlmResponseFormatError("模型服务响应的 choices[0] 不是对象。");
  }
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) {
    throw new LlmResponseFormatError("模型服务响应缺少 choices[0].message。");
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string") {
    throw new LlmResponseFormatError("模型服务响应的 message.content 不是字符串。");
  }
  const reasoningRaw = (message as Record<string, unknown>).reasoning_content;
  const reasoning = typeof reasoningRaw === "string" ? reasoningRaw : null;
  return { content, reasoning };
}

function extractProviderErrorMessage(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || !("error" in raw)) {
    return undefined;
  }
  const errorValue = (raw as { error: unknown }).error;
  if (typeof errorValue === "string") {
    return errorValue;
  }
  if (typeof errorValue === "object" && errorValue !== null) {
    const message = (errorValue as Record<string, unknown>).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return undefined;
}

function describeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
