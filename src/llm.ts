/**
 * 一个很薄的 OpenAI 兼容 Chat Completions 客户端。生产请求使用显式
 * 配置的 Undici 传输层，不使用 Node global fetch 隐藏的 300 秒响应头/
 * 正文超时。支持：
 *   - baseUrl + apiKey 的服务商组合（aether、阿里云百炼 compatible-mode 等，
 *     调用方负责传对应的 baseUrl/apiKey，这个模块本身不知道"provider"这个
 *     概念）；
 *   - 读取思考模型的 reasoning_content（如果响应里有的话）；
 *   - 结构化 JSON 输出：用提示词要求只输出 JSON；解析或校验失败时重新带着
 *     固定校验说明请求一次（这会产生第二次模型调用，和 429 重试是两回事）；
 *   - 只对服务端明确返回的 429 做退避重试；连接中断和超时不自动重发，
 *     避免同一道题在模型已经开始生成后被重复计费。
 *
 * 使用流式响应持续接收推理与最终答案。这里的流式不是为了边生成边展示，
 * 而是为了确认模型仍在工作：只有通过格式检查的非空白 content/
 * reasoning 事件才会续时，心跳、用量和 role-only 事件都不会。
 */
import { Readable } from "node:stream";
import {
  type Dispatcher,
  EnvHttpProxyAgent,
  request as undiciRequest
} from "undici";
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
  /** 只在显式配置推理请求时必须提供，用于请求前再次限定服务商。 */
  readonly provider?: "aether" | "dashscope";
  readonly model: string;
  readonly temperature: number;
  /**
   * 是否保留响应里的思考过程；它不控制模型是否进行深度思考。
   */
  readonly thinking: boolean;
  /**
   * 显式发送经配置层限定的深度思考请求。当前只放行
   * Aether deepseek-v4-flash；enabled 必须带 low，disabled 不能带 effort。
   * 未配置时不发送 `thinking` 请求字段，保持原有请求行为。
   */
  readonly thinkingRequest?: "enabled" | "disabled";
  readonly reasoningEffort?: "low";
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LlmRuntimeOptions {
  /** 收到首个有效模型事件后，连续多久没有新有效事件才认为连接停住。 */
  readonly outputIdleTimeoutMs: number;
  /** 等待第一个有效模型事件的时间；深度推理通常需要明显长于普通请求。 */
  readonly firstOutputTimeoutMs?: number;
  /** 首个有效事件前（包括 429 等待）的最终保护；有效输出开始后不是绝对总时限。 */
  readonly maximumDurationMs?: number;
  /** 总尝试次数；只有收到 429 时才会使用后续尝试。 */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly fetch?: FetchLike;
  /** 任务已经丢失或被明确拒绝时，由上层用它停止仍在运行的付费请求。 */
  readonly signal?: AbortSignal;
}

export interface ChatCompletionOptions {
  readonly requestJson?: boolean;
  /**
   * 交给 OpenAI compatible 接口的输出 token 硬上限。未设置时不发送
   * `max_tokens`，保持既有调用行为。
   */
  readonly maxOutputTokens?: number;
}

export interface ChatCompletionJsonOptions {
  /** 首轮和唯一一次 JSON 修复轮共用同一个输出 token 硬上限。 */
  readonly maxOutputTokens?: number;
}

/** 模型响应正文的固定上限，按 UTF-8 原始字节计算。 */
export const maximumLlmResponseBodyBytes = 4 * 1024 * 1024;
/** 显式输出 token 上限本身也必须有界，避免错误配置变成近似无限输出。 */
export const maximumExplicitLlmOutputTokens = 131_072;
export const defaultLlmFirstOutputTimeoutMs = 30 * 60 * 1_000;
export const defaultLlmMaximumDurationMs = 4 * 60 * 60 * 1_000;

let productionDispatcher: EnvHttpProxyAgent | undefined;

function getProductionDispatcher(): EnvHttpProxyAgent {
  productionDispatcher ??= new EnvHttpProxyAgent({
    // 连接、响应头和正文都只由下面的业务看门狗管理。Undici 的
    // 隐含默认值会在深度推理仍正常运行时提前切断请求。
    connectTimeout: 0,
    headersTimeout: 0,
    bodyTimeout: 0
  });
  return productionDispatcher;
}

const productionLlmFetch: FetchLike = (input, init) =>
  requestWithUndici(getProductionDispatcher(), input, init);

/**
 * 使用指定 Dispatcher 创建与生产路径完全相同的请求适配器。主要供本地
 * HTTP 集成测试注入短超时 Agent；正常运行使用上面支持代理环境变量的
 * EnvHttpProxyAgent。
 */
export function createUndiciLlmFetch(dispatcher: Dispatcher): FetchLike {
  return (input, init) => requestWithUndici(dispatcher, input, init);
}

async function requestWithUndici(
  dispatcher: Dispatcher,
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  if (input instanceof Request) {
    throw new TypeError("LLM 传输层不接受 Request 对象。");
  }
  if (init?.method?.toUpperCase() !== "POST" || typeof init.body !== "string") {
    throw new TypeError("LLM 传输层只接受带文本正文的 POST 请求。");
  }
  const requestHeaders: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    requestHeaders[name] = value;
  });

  const response = await undiciRequest(input, {
    dispatcher,
    method: "POST",
    headers: requestHeaders,
    body: init.body,
    signal: init.signal,
    // 这两项必须在每次请求上明确禁用，不依赖 Dispatcher 的默认
    // 值；这样即使代理 Agent 或测试 Agent 带有较短默认值也不会回归。
    headersTimeout: 0,
    bodyTimeout: 0
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    // 错误正文可能很大、迟迟不结束，也可能回显请求里的私有题面。不要把
    // BodyReadable 转成 Web ReadableStream：在 Node 的适配器边界取消这类
    // 流会让 Undici 在稍后的回调里再次关闭 controller，进而抛出未捕获的
    // ERR_INVALID_STATE。先在原始 Node 流上安装错误处理，再立即销毁；上层
    // 只会看到状态码，不会读取正文、服务商错误头或自定义状态文字。
    destroyUndiciErrorBodyWithoutReading(response.body);
    return new Response(null, { status: response.statusCode });
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.append(name, value);
    }
  }

  if ([204, 205].includes(response.statusCode)) {
    await response.body.dump();
    return new Response(null, {
      status: response.statusCode,
      statusText: response.statusText,
      headers
    });
  }
  const body = Readable.toWeb(response.body) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: response.statusCode,
    statusText: response.statusText,
    headers
  });
}

function destroyUndiciErrorBodyWithoutReading(body: Readable): void {
  const ignoreDestroyError = (): void => undefined;
  const removeDestroyErrorHandler = (): void => {
    body.removeListener("error", ignoreDestroyError);
  };

  // Undici 会把尚未读完的 BodyReadable.destroy() 转成一次异步
  // RequestAbortedError。监听器必须在 destroy() 前就位，并保留到 close，
  // 否则这个仅用于清理的错误可能变成进程级未捕获异常。
  body.on("error", ignoreDestroyError);
  body.once("close", removeDestroyErrorHandler);
  body.destroy();
}

/** 模型请求未完成；只包含固定分类和状态码，不带服务商错误正文。 */
export class LlmRequestError extends Error {
  public readonly code:
    | "LLM_HTTP_ERROR"
    | "LLM_NETWORK_FAILED"
    | "LLM_FIRST_OUTPUT_TIMEOUT"
    | "LLM_OUTPUT_IDLE_TIMEOUT"
    | "LLM_TOTAL_TIMEOUT"
    | "LLM_STREAM_INTERRUPTED"
    | "LLM_CANCELLED"
    | "LLM_OUTPUT_LENGTH_LIMIT"
    | "LLM_OUTPUT_CONTENT_FILTERED";
  public readonly status: number | undefined;
  /** 排空格式首错时若被超时、取消或断流覆盖，保留安全的最初协议阶段。 */
  public readonly formatFailureStage: LlmResponseFormatFailureStage | undefined;
  /** `trailing_data` 的封闭分类；不包含响应正文、字段名、长度或其它服务商数据。 */
  public readonly formatFailureSubstage:
    | LlmResponseFormatFailureSubstage
    | undefined;

  public constructor(
    code: LlmRequestError["code"],
    status?: number,
    formatFailureStage?: LlmResponseFormatFailureStage,
    formatFailureSubstage?: LlmResponseFormatFailureSubstage
  ) {
    assertSafeFormatFailureSubstage(
      formatFailureStage,
      formatFailureSubstage
    );
    const messages: Record<LlmRequestError["code"], string> = {
      LLM_HTTP_ERROR: "模型服务返回了错误状态。",
      LLM_NETWORK_FAILED: "模型服务连接未能完成。",
      LLM_FIRST_OUTPUT_TIMEOUT: "模型服务长时间没有返回第一段输出。",
      LLM_OUTPUT_IDLE_TIMEOUT: "模型服务的输出长时间没有继续。",
      LLM_TOTAL_TIMEOUT: "模型服务在有效输出前超过最终保护时长。",
      LLM_STREAM_INTERRUPTED: "模型服务的输出在完成前中断。",
      LLM_CANCELLED: "模型请求已按任务状态停止。",
      LLM_OUTPUT_LENGTH_LIMIT: "模型服务因输出长度限制而停止。",
      LLM_OUTPUT_CONTENT_FILTERED: "模型服务因内容过滤而停止。"
    };
    super(messages[code]);
    this.name = "LlmRequestError";
    this.code = code;
    this.status = status;
    this.formatFailureStage = formatFailureStage;
    this.formatFailureSubstage = formatFailureSubstage;
  }
}

/** 响应正文超过固定上限。异常只带固定说明，不保留任何正文片段。 */
export class LlmResponseBodyTooLargeError extends Error {
  public readonly code = "LLM_RESPONSE_BODY_TOO_LARGE";
  public readonly formatFailureStage: LlmResponseFormatFailureStage | undefined;
  public readonly formatFailureSubstage:
    | LlmResponseFormatFailureSubstage
    | undefined;

  public constructor(
    formatFailureStage?: LlmResponseFormatFailureStage,
    formatFailureSubstage?: LlmResponseFormatFailureSubstage
  ) {
    super("模型服务响应正文超过大小限制。");
    this.name = "LlmResponseBodyTooLargeError";
    assertSafeFormatFailureSubstage(
      formatFailureStage,
      formatFailureSubstage
    );
    this.formatFailureStage = formatFailureStage;
    this.formatFailureSubstage = formatFailureSubstage;
  }
}

/**
 * 2xx 响应的安全格式失败阶段。闭集只描述协议层位置，不包含服务商正文、
 * 字段值或其它可能泄露模型输出的信息。
 */
export type LlmResponseFormatFailureStage =
  | "missing_body"
  | "content_type"
  | "json_utf8"
  | "json_parse"
  | "response_shape"
  | "sse_utf8"
  | "event_json"
  | "event_shape"
  | "delta_shape"
  | "finish_shape"
  | "trailing_data";

/**
 * `trailing_data` 的安全子阶段。闭集只说明终止状态机的分支，不记录事件
 * 正文、字段名、字段值、字节数或文本摘要。
 */
export type LlmResponseFormatFailureSubstage =
  | "duplicate_done"
  | "data_after_done"
  | "choice_after_stop";

function assertSafeFormatFailureSubstage(
  formatFailureStage?: LlmResponseFormatFailureStage,
  formatFailureSubstage?: LlmResponseFormatFailureSubstage
): void {
  const knownSubstage =
    formatFailureSubstage === "duplicate_done" ||
    formatFailureSubstage === "data_after_done" ||
    formatFailureSubstage === "choice_after_stop";
  if (
    (formatFailureStage === "trailing_data" && !knownSubstage) ||
    (formatFailureStage !== "trailing_data" && formatFailureSubstage !== undefined)
  ) {
    throw new TypeError("模型服务响应格式失败分类不完整。");
  }
}

/** 拿到了 2xx 响应，但结构不符合 OpenAI 兼容格式的基本假设。 */
export class LlmResponseFormatError extends Error {
  public readonly code = "LLM_RESPONSE_FORMAT_INVALID";
  public readonly formatFailureStage: LlmResponseFormatFailureStage;
  public readonly formatFailureSubstage:
    | LlmResponseFormatFailureSubstage
    | undefined;

  public constructor(
    formatFailureStage: LlmResponseFormatFailureStage,
    formatFailureSubstage?: LlmResponseFormatFailureSubstage
  ) {
    super("模型服务响应格式不正确。");
    this.name = "LlmResponseFormatError";
    assertSafeFormatFailureSubstage(
      formatFailureStage,
      formatFailureSubstage
    );
    this.formatFailureStage = formatFailureStage;
    this.formatFailureSubstage = formatFailureSubstage;
  }
}

/** 请求 JSON 结构化输出，模型给了内容，但两次尝试后仍然不是满足 schema 的 JSON。 */
export class LlmJsonOutputError extends Error {
  public readonly code = "LLM_JSON_OUTPUT_INVALID";

  public constructor() {
    super("模型两次输出都不符合要求。");
    this.name = "LlmJsonOutputError";
  }
}

export async function chatComplete(
  provider: ProviderCredentialsLike,
  spec: ModelCallSpec,
  messages: ChatMessage[],
  runtime: LlmRuntimeOptions,
  options: ChatCompletionOptions = {}
): Promise<ChatCompletionResult> {
  validateThinkingRequest(spec);
  const fetchImpl = runtime.fetch ?? productionLlmFetch;
  const url = new URL("chat/completions", ensureTrailingSlash(provider.baseUrl));
  const body: Record<string, unknown> = {
    model: spec.model,
    temperature: spec.temperature,
    stream: true,
    messages
  };
  if (options.requestJson === true) {
    body.response_format = { type: "json_object" };
  }
  if (spec.thinkingRequest !== undefined) {
    body.thinking = { type: spec.thinkingRequest };
  }
  if (spec.reasoningEffort !== undefined) {
    body.reasoning_effort = spec.reasoningEffort;
  }
  if (options.maxOutputTokens !== undefined) {
    body.max_tokens = validateMaxOutputTokens(options.maxOutputTokens);
  }

  const response = await requestWithRetry(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
        Authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify(body)
    },
    runtime
  );

  if (!response.ok) {
    // 服务商的 error.message 可能回显请求内容，不能放进异常或日志。
    throw new LlmRequestError("LLM_HTTP_ERROR", response.status);
  }

  const result = extractChatCompletion(response.raw);
  return spec.thinking
    ? result
    : { content: result.content, reasoning: null };
}

/**
 * 配置加载不是唯一入口；实验和测试也可以直接调用 chatComplete。
 * 因此在发起任何可能计费的请求前重新检查组合，不依赖 TypeScript
 * 类型或 config/models.yaml 已经跑过。
 */
function validateThinkingRequest(spec: ModelCallSpec): void {
  const thinkingRequest: unknown = spec.thinkingRequest;
  const reasoningEffort: unknown = spec.reasoningEffort;

  if (
    thinkingRequest !== undefined &&
    thinkingRequest !== "enabled" &&
    thinkingRequest !== "disabled"
  ) {
    throw new TypeError("模型深度思考请求配置无效。");
  }
  if (reasoningEffort !== undefined && reasoningEffort !== "low") {
    throw new TypeError("模型推理强度配置无效。");
  }
  if (thinkingRequest === undefined) {
    if (reasoningEffort !== undefined) {
      throw new TypeError("未开启深度思考时不能配置推理强度。");
    }
    return;
  }
  if (spec.provider !== "aether" || spec.model !== "deepseek-v4-flash") {
    throw new TypeError("当前模型不允许显式配置深度思考。");
  }
  if (thinkingRequest === "enabled" && reasoningEffort !== "low") {
    throw new TypeError("开启深度思考时必须使用 low 推理强度。");
  }
  if (thinkingRequest === "disabled" && reasoningEffort !== undefined) {
    throw new TypeError("关闭深度思考时不能配置推理强度。");
  }
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
  runtime: LlmRuntimeOptions,
  options: ChatCompletionJsonOptions = {}
): Promise<{ data: T; reasoning: string | null }> {
  const jsonInstruction: ChatMessage = {
    role: "system",
    content: "只输出一个满足要求的 JSON 对象本身，不要输出任何解释、前后缀文字，也不要用 Markdown 代码块包裹。"
  };
  const firstMessages: ChatMessage[] = [jsonInstruction, ...messages];
  // 当前接入的网关并不都正确支持 response_format。直接用提示词约束 JSON，
  // 避免先付费生成一次空 content，再为了探测兼容性重复发送完整题目。
  const first = await chatComplete(provider, spec, firstMessages, runtime, {
    requestJson: false,
    maxOutputTokens: options.maxOutputTokens
  });
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
  const second = await chatComplete(provider, spec, repairMessages, runtime, {
    requestJson: false,
    maxOutputTokens: options.maxOutputTokens
  });
  const secondAttempt = tryParseAndValidate(second.content, schema);
  if (secondAttempt.success) {
    return { data: secondAttempt.data, reasoning: second.reasoning ?? first.reasoning };
  }

  throw new LlmJsonOutputError();
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
  } catch {
    return { success: false, error: "JSON 解析失败" };
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
): Promise<{ readonly ok: boolean; readonly status: number; readonly raw: unknown }> {
  const durations = resolveLlmRequestDurations(runtime);
  const deadline = Date.now() + durations.maximumDurationMs;
  let attempt = 1;
  for (;;) {
    if (runtime.signal?.aborted) {
      throw new LlmRequestError("LLM_CANCELLED");
    }
    const remainingDurationMs = deadline - Date.now();
    if (remainingDurationMs <= 0) {
      throw new LlmRequestError("LLM_TOTAL_TIMEOUT");
    }
    const controller = new AbortController();
    const watchdog = new LlmRequestWatchdog(
      controller,
      durations,
      remainingDurationMs
    );
    const cancelForTaskState = (): void => {
      controller.abort();
    };
    runtime.signal?.addEventListener("abort", cancelForTaskState, {
      once: true
    });
    let responseReceived = false;
    try {
      const response = await waitForOrAbort(
        fetchImpl(url, { ...init, signal: controller.signal }),
        controller.signal
      );
      responseReceived = true;
      if (!response.ok) {
        cancelResponseBodyWithoutReading(response, controller);
        const timeoutError = watchdog.error();
        if (timeoutError !== undefined) {
          throw timeoutError;
        }
        if (Date.now() >= deadline) {
          throw new LlmRequestError("LLM_TOTAL_TIMEOUT");
        }
        if (response.status !== 429 || attempt >= runtime.maxAttempts) {
          return { ok: false, status: response.status, raw: undefined };
        }
      } else {
        const raw = await parseResponseBody(response, controller, {
          onValidOutput: () => {
            watchdog.receivedValidOutput();
          },
          onInvalidResponseDrainStarted: (
            formatFailureStage,
            formatFailureSubstage
          ) => {
            watchdog.invalidResponseDrainStarted(
              formatFailureStage,
              formatFailureSubstage
            );
          },
          onInvalidResponseDrainActivity: () => {
            watchdog.receivedInvalidResponseDrainActivity();
          }
        });
        const timeoutError = watchdog.error();
        if (timeoutError !== undefined) {
          throw timeoutError;
        }
        // 首个有效模型事件会清除绝对保护计时。正常持续输出后只看
        // 有效事件间的停顿，因此不能在这里再用初始 deadline 拒绝结果。
        return { ok: true, status: response.status, raw };
      }
    } catch (error) {
      const timeoutError = watchdog.error();
      if (timeoutError !== undefined) {
        throw timeoutError;
      }
      if (runtime.signal?.aborted) {
        throw new LlmRequestError(
          "LLM_CANCELLED",
          undefined,
          watchdog.formatFailureStage(),
          watchdog.formatFailureSubstage()
        );
      }
      if (
        error instanceof LlmResponseBodyTooLargeError ||
        error instanceof LlmResponseFormatError ||
        error instanceof LlmRequestError
      ) {
        throw error;
      }
      // fetch 无法证明请求是否已经到达模型服务。自动重发可能让同一题重复计费，
      // 因此只有服务端明确返回“请求过多”(429)时才自动重试。
      throw new LlmRequestError(
        responseReceived ? "LLM_STREAM_INTERRUPTED" : "LLM_NETWORK_FAILED",
        undefined,
        watchdog.formatFailureStage(),
        watchdog.formatFailureSubstage()
      );
    } finally {
      runtime.signal?.removeEventListener("abort", cancelForTaskState);
      watchdog.close();
    }
    await delayBeforeRetry(
      backoffMs(runtime.baseDelayMs, attempt),
      deadline,
      runtime.signal
    );
    attempt += 1;
  }
}

function cancelResponseBodyWithoutReading(
  response: Response,
  fallbackController: AbortController
): void {
  if (response.body === null) return;
  try {
    const cancellation = response.body.cancel();
    void cancellation.catch(() => {
      fallbackController.abort();
    });
  } catch {
    fallbackController.abort();
  }
}

type LlmTimeoutCode =
  | "LLM_FIRST_OUTPUT_TIMEOUT"
  | "LLM_OUTPUT_IDLE_TIMEOUT"
  | "LLM_TOTAL_TIMEOUT";

interface LlmRequestDurations {
  readonly firstOutputTimeoutMs: number;
  readonly outputIdleTimeoutMs: number;
  readonly maximumDurationMs: number;
}

class LlmRequestWatchdog {
  readonly #controller: AbortController;
  readonly #firstOutputTimeoutMs: number;
  readonly #outputIdleTimeoutMs: number;
  readonly #maximumDurationMs: number;
  #firstOutputTimer: NodeJS.Timeout | null = null;
  #outputIdleTimer: NodeJS.Timeout | null = null;
  #maximumDurationTimer: NodeJS.Timeout | null = null;
  #timeoutCode: LlmTimeoutCode | null = null;
  #receivedValidOutput = false;
  #drainingInvalidResponse = false;
  #formatFailureStage: LlmResponseFormatFailureStage | undefined;
  #formatFailureSubstage: LlmResponseFormatFailureSubstage | undefined;

  public constructor(
    controller: AbortController,
    durations: LlmRequestDurations,
    remainingDurationMs: number
  ) {
    this.#controller = controller;
    this.#outputIdleTimeoutMs = durations.outputIdleTimeoutMs;
    this.#firstOutputTimeoutMs = durations.firstOutputTimeoutMs;
    this.#maximumDurationMs = remainingDurationMs;
    this.#firstOutputTimer = setTimeout(() => {
      this.#abort("LLM_FIRST_OUTPUT_TIMEOUT");
    }, this.#firstOutputTimeoutMs);
    this.#maximumDurationTimer = setTimeout(() => {
      this.#abort("LLM_TOTAL_TIMEOUT");
    }, this.#maximumDurationMs);
  }

  public receivedValidOutput(): void {
    if (this.#timeoutCode !== null) return;
    if (!this.#receivedValidOutput) {
      this.#receivedValidOutput = true;
      if (this.#firstOutputTimer !== null) {
        clearTimeout(this.#firstOutputTimer);
        this.#firstOutputTimer = null;
      }
      // maximumDurationMs 只约束首个有效事件前的阶段，不得把正在
      // 持续产生有效输出的付费请求当作超时取消。
      if (this.#maximumDurationTimer !== null) {
        clearTimeout(this.#maximumDurationTimer);
        this.#maximumDurationTimer = null;
      }
    }
    if (this.#outputIdleTimer !== null) {
      clearTimeout(this.#outputIdleTimer);
    }
    this.#outputIdleTimer = setTimeout(() => {
      this.#abort("LLM_OUTPUT_IDLE_TIMEOUT");
    }, this.#outputIdleTimeoutMs);
  }

  /**
   * 协议首错并不证明 HTTP 正文已经结束。进入排空阶段后，首输出等待改为
   * 对原始分块的连续停顿保护；若此前已有合法输出并清除了最终保护，则从
   * 排空开始重新用同一 maximumDurationMs 建立最终边界。它不是 120 秒之类
   * 的隐藏短时限，也不会因持续收到分块而无限延长。
   */
  public invalidResponseDrainStarted(
    formatFailureStage?: LlmResponseFormatFailureStage,
    formatFailureSubstage?: LlmResponseFormatFailureSubstage
  ): void {
    if (this.#timeoutCode !== null || this.#drainingInvalidResponse) return;
    this.#drainingInvalidResponse = true;
    this.#formatFailureStage = formatFailureStage;
    this.#formatFailureSubstage = formatFailureSubstage;
    if (this.#firstOutputTimer !== null) {
      clearTimeout(this.#firstOutputTimer);
      this.#firstOutputTimer = null;
    }
    if (this.#maximumDurationTimer === null) {
      this.#maximumDurationTimer = setTimeout(() => {
        this.#abort("LLM_TOTAL_TIMEOUT");
      }, this.#maximumDurationMs);
    }
    this.receivedInvalidResponseDrainActivity();
  }

  public receivedInvalidResponseDrainActivity(): void {
    if (this.#timeoutCode !== null || !this.#drainingInvalidResponse) return;
    if (this.#outputIdleTimer !== null) {
      clearTimeout(this.#outputIdleTimer);
    }
    this.#outputIdleTimer = setTimeout(() => {
      this.#abort("LLM_OUTPUT_IDLE_TIMEOUT");
    }, this.#outputIdleTimeoutMs);
  }

  public error(): LlmRequestError | undefined {
    return this.#timeoutCode === null
      ? undefined
      : new LlmRequestError(
        this.#timeoutCode,
        undefined,
        this.#formatFailureStage,
        this.#formatFailureSubstage
      );
  }

  public formatFailureStage(): LlmResponseFormatFailureStage | undefined {
    return this.#formatFailureStage;
  }

  public formatFailureSubstage():
    | LlmResponseFormatFailureSubstage
    | undefined {
    return this.#formatFailureSubstage;
  }

  public close(): void {
    for (const timer of [
      this.#firstOutputTimer,
      this.#outputIdleTimer,
      this.#maximumDurationTimer
    ]) {
      if (timer !== null) clearTimeout(timer);
    }
    this.#firstOutputTimer = null;
    this.#outputIdleTimer = null;
    this.#maximumDurationTimer = null;
  }

  #abort(code: LlmTimeoutCode): void {
    if (this.#timeoutCode !== null) return;
    this.#timeoutCode = code;
    this.#controller.abort();
  }
}

function resolveLlmRequestDurations(
  runtime: LlmRuntimeOptions
): LlmRequestDurations {
  const outputIdleTimeoutMs = positiveDuration(
    runtime.outputIdleTimeoutMs,
    "outputIdleTimeoutMs"
  );
  const firstOutputTimeoutMs = positiveDuration(
    runtime.firstOutputTimeoutMs ??
      Math.max(defaultLlmFirstOutputTimeoutMs, outputIdleTimeoutMs),
    "firstOutputTimeoutMs"
  );
  const maximumDurationMs = positiveDuration(
    runtime.maximumDurationMs ??
      Math.max(
        defaultLlmMaximumDurationMs,
        firstOutputTimeoutMs,
        outputIdleTimeoutMs
      ),
    "maximumDurationMs"
  );
  if (
    maximumDurationMs < firstOutputTimeoutMs ||
    maximumDurationMs < outputIdleTimeoutMs
  ) {
    throw new TypeError(
      "maximumDurationMs 不能小于第一段输出或输出停顿的等待时间。"
    );
  }
  return {
    firstOutputTimeoutMs,
    outputIdleTimeoutMs,
    maximumDurationMs
  };
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60 * 60 * 1_000) {
    throw new TypeError(`${name} 必须是 1 到 86400000 之间的整数。`);
  }
  return value;
}

function validateMaxOutputTokens(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximumExplicitLlmOutputTokens
  ) {
    throw new RangeError(
      `maxOutputTokens 必须是 1 到 ${maximumExplicitLlmOutputTokens} 之间的整数。`
    );
  }
  return value;
}

function backoffMs(baseDelayMs: number, attempt: number): number {
  return baseDelayMs * 2 ** (attempt - 1);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function waitForOrAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("请求已结束。", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("请求已结束。", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function delayBeforeRetry(
  ms: number,
  deadline: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    throw new LlmRequestError("LLM_CANCELLED");
  }
  const remainingDurationMs = deadline - Date.now();
  if (remainingDurationMs <= 0) {
    throw new LlmRequestError("LLM_TOTAL_TIMEOUT");
  }
  if (ms >= remainingDurationMs) {
    try {
      await (signal === undefined
        ? delay(remainingDurationMs)
        : waitForOrAbort(delay(remainingDurationMs), signal));
    } catch {
      if (signal?.aborted) {
        throw new LlmRequestError("LLM_CANCELLED");
      }
      throw new LlmRequestError("LLM_TOTAL_TIMEOUT");
    }
    throw new LlmRequestError("LLM_TOTAL_TIMEOUT");
  }
  try {
    await (signal === undefined
      ? delay(ms)
      : waitForOrAbort(delay(ms), signal));
  } catch {
    if (signal?.aborted) {
      throw new LlmRequestError("LLM_CANCELLED");
    }
    throw new LlmRequestError("LLM_NETWORK_FAILED");
  }
}

interface ResponseBodyActivityObserver {
  readonly onValidOutput: () => void;
  readonly onInvalidResponseDrainStarted: (
    formatFailureStage?: LlmResponseFormatFailureStage,
    formatFailureSubstage?: LlmResponseFormatFailureSubstage
  ) => void;
  readonly onInvalidResponseDrainActivity: () => void;
}

async function parseResponseBody(
  response: Response,
  requestController: AbortController,
  observer: ResponseBodyActivityObserver
): Promise<unknown> {
  if (response.body === null) {
    throw new LlmResponseFormatError("missing_body");
  }
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType === "text/event-stream") {
    return readChatCompletionEventStream(
      response,
      requestController,
      observer
    );
  }
  if (
    mediaType !== undefined &&
    mediaType.length > 0 &&
    mediaType !== "application/json" &&
    !mediaType.endsWith("+json")
  ) {
    return drainResponseAfterProtocolError(
      response,
      requestController,
      observer,
      new LlmResponseFormatError("content_type")
    );
  }
  const text = await readResponseTextWithLimit(
    response,
    requestController,
    observer
  );
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new LlmResponseFormatError("json_parse");
  }
  // JSON 回退没有可靠的逐事件边界，只在 HTTP EOF 后验证整个响应。
  // 它必须明确 finish_reason=stop 且最终 content 非空白，然后才算
  // 收到有效模型输出。reasoning-only 不会被暗中升格为最终答案。
  extractChatCompletion(raw, true);
  observer.onValidOutput();
  return raw;
}

async function readResponseTextWithLimit(
  response: Response,
  requestController: AbortController,
  observer: ResponseBodyActivityObserver
): Promise<string> {
  if (response.body === null) throw new LlmResponseFormatError("missing_body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let totalBytes = 0;
  let readerFinished = false;
  let readerErrored = false;
  let firstProtocolError: LlmResponseFormatError | undefined;
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await waitForOrAbort(reader.read(), requestController.signal);
      } catch (error) {
        readerErrored = !requestController.signal.aborted;
        throw error;
      }
      if (chunk.done) {
        readerFinished = true;
        if (firstProtocolError !== undefined) throw firstProtocolError;
        try {
          text += decoder.decode();
          return text;
        } catch {
          throw new LlmResponseFormatError("json_utf8");
        }
      }
      totalBytes = addResponseChunkSize(
        totalBytes,
        chunk.value.byteLength,
        firstProtocolError?.formatFailureStage,
        firstProtocolError?.formatFailureSubstage
      );
      if (firstProtocolError !== undefined) {
        if (chunk.value.byteLength > 0) {
          observer.onInvalidResponseDrainActivity();
        }
        continue;
      }
      try {
        text += decoder.decode(chunk.value, { stream: true });
      } catch {
        firstProtocolError = new LlmResponseFormatError("json_utf8");
        // 首错后的正文不再解码或拼接；清除已收内容，只保留固定阶段。
        text = "";
        observer.onInvalidResponseDrainStarted(
          firstProtocolError.formatFailureStage,
          firstProtocolError.formatFailureSubstage
        );
      }
    }
  } finally {
    if (!readerFinished && !readerErrored) {
      cancelReaderWithoutReplacingResult(reader);
      requestController.abort();
    }
    try {
      reader.releaseLock();
    } catch {
      // 读取结果或固定错误已经确定，不再用流清理错误覆盖它。
    }
  }
}

async function drainResponseAfterProtocolError(
  response: Response,
  requestController: AbortController,
  observer: ResponseBodyActivityObserver,
  firstProtocolError: LlmResponseFormatError
): Promise<never> {
  if (response.body === null) throw firstProtocolError;
  const reader = response.body.getReader();
  let readerFinished = false;
  let readerErrored = false;
  let totalBytes = 0;
  observer.onInvalidResponseDrainStarted(
    firstProtocolError.formatFailureStage,
    firstProtocolError.formatFailureSubstage
  );
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await waitForOrAbort(reader.read(), requestController.signal);
      } catch (error) {
        readerErrored = !requestController.signal.aborted;
        throw error;
      }
      if (chunk.done) {
        readerFinished = true;
        throw firstProtocolError;
      }
      totalBytes = addResponseChunkSize(
        totalBytes,
        chunk.value.byteLength,
        firstProtocolError.formatFailureStage,
        firstProtocolError.formatFailureSubstage
      );
      // 排空阶段不解码、不拼接、不解析，也不保留任何响应字节。
      if (chunk.value.byteLength > 0) {
        observer.onInvalidResponseDrainActivity();
      }
    }
  } finally {
    if (!readerFinished && !readerErrored) {
      cancelReaderWithoutReplacingResult(reader);
      requestController.abort();
    }
    try {
      reader.releaseLock();
    } catch {
      // 读取结果或固定错误已经确定，不再用流清理错误覆盖它。
    }
  }
}

interface ChatCompletionStreamState {
  content: string;
  reasoning: string;
  sawChoice: boolean;
  sawStop: boolean;
  sawDone: boolean;
}

async function readChatCompletionEventStream(
  response: Response,
  requestController: AbortController,
  observer: ResponseBodyActivityObserver
): Promise<unknown> {
  if (response.body === null) {
    throw new LlmResponseFormatError("missing_body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const state: ChatCompletionStreamState = {
    content: "",
    reasoning: "",
    sawChoice: false,
    sawStop: false,
    sawDone: false
  };
  let pending = "";
  let trailingCarriageReturn = false;
  let totalBytes = 0;
  let readerFinished = false;
  let readerErrored = false;
  let firstProtocolError:
    | LlmResponseFormatError
    | LlmRequestError
    | undefined;

  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await waitForOrAbort(reader.read(), requestController.signal);
      } catch (error) {
        readerErrored = !requestController.signal.aborted;
        throw error;
      }
      if (chunk.done) {
        readerFinished = true;
        if (firstProtocolError !== undefined) throw firstProtocolError;
        ({ pending, trailingCarriageReturn } = appendEventStreamText(
          pending,
          trailingCarriageReturn,
          decodeEventStreamText(decoder),
          true
        ));
        for (;;) {
          const boundary = pending.indexOf("\n\n");
          if (boundary < 0) break;
          const event = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          if (consumeChatCompletionEvent(event, state)) {
            observer.onValidOutput();
          }
        }
        if (pending.trim().length > 0) {
          if (consumeChatCompletionEvent(pending, state)) {
            observer.onValidOutput();
          }
        }
        if (!state.sawChoice || !state.sawStop) {
          throw new LlmRequestError("LLM_STREAM_INTERRUPTED");
        }
        const raw = chatCompletionStreamResult(state);
        // 思考内容是辅助信息，不是最终回答。即使 thinking=true，
        // reasoning-only 或空白 content 也是不完整响应。
        extractChatCompletion(raw);
        return raw;
      }
      totalBytes = addResponseChunkSize(
        totalBytes,
        chunk.value.byteLength,
        firstProtocolError instanceof LlmResponseFormatError
          ? firstProtocolError.formatFailureStage
          : undefined,
        firstProtocolError instanceof LlmResponseFormatError
          ? firstProtocolError.formatFailureSubstage
          : undefined
      );
      if (firstProtocolError !== undefined) {
        if (chunk.value.byteLength > 0) {
          observer.onInvalidResponseDrainActivity();
        }
        continue;
      }
      if (chunk.value.byteLength === 0) continue;
      try {
        ({ pending, trailingCarriageReturn } = appendEventStreamText(
          pending,
          trailingCarriageReturn,
          decodeEventStreamText(decoder, chunk.value),
          false
        ));

        for (;;) {
          const boundary = pending.indexOf("\n\n");
          if (boundary < 0) break;
          const event = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          if (consumeChatCompletionEvent(event, state)) {
            observer.onValidOutput();
          }
        }
      } catch (error) {
        if (!isDrainableResponseProtocolError(error)) throw error;
        firstProtocolError = error;
        // 首错后不再保留、解码或解析模型正文，避免后续字段替换首错。
        pending = "";
        state.content = "";
        state.reasoning = "";
        observer.onInvalidResponseDrainStarted(
          error instanceof LlmResponseFormatError
            ? error.formatFailureStage
            : undefined,
          error instanceof LlmResponseFormatError
            ? error.formatFailureSubstage
            : undefined
        );
      }
    }
  } finally {
    if (!readerFinished && !readerErrored) {
      cancelReaderWithoutReplacingResult(reader);
      requestController.abort();
    }
    try {
      reader.releaseLock();
    } catch {
      // 读取结果或固定错误已经确定，不再用流清理错误覆盖它。
    }
  }
}

function isDrainableResponseProtocolError(
  error: unknown
): error is LlmResponseFormatError | LlmRequestError {
  return (
    error instanceof LlmResponseFormatError ||
    (error instanceof LlmRequestError &&
      (error.code === "LLM_OUTPUT_LENGTH_LIMIT" ||
        error.code === "LLM_OUTPUT_CONTENT_FILTERED"))
  );
}

function decodeEventStreamText(
  decoder: TextDecoder,
  bytes?: Uint8Array
): string {
  try {
    return bytes === undefined
      ? decoder.decode()
      : decoder.decode(bytes, { stream: true });
  } catch {
    throw new LlmResponseFormatError("sse_utf8");
  }
}

function appendEventStreamText(
  pending: string,
  trailingCarriageReturn: boolean,
  next: string,
  final: boolean
): { readonly pending: string; readonly trailingCarriageReturn: boolean } {
  let text = next;
  let carried = trailingCarriageReturn;
  if (carried && text.length > 0) {
    pending += "\n";
    if (text.startsWith("\n")) {
      text = text.slice(1);
    }
    carried = false;
  }
  if (!final && text.endsWith("\r")) {
    text = text.slice(0, -1);
    carried = true;
  }
  pending += text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  if (final && carried) {
    pending += "\n";
    carried = false;
  }
  return { pending, trailingCarriageReturn: carried };
}

function consumeChatCompletionEvent(
  event: string,
  state: ChatCompletionStreamState
): boolean {
  const data = event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();
  if (data.length === 0) return false;
  if (state.sawDone) {
    // [DONE] 后只能是 HTTP 正常收尾；继续出现非空事件说明响应次序损坏。
    throw new LlmResponseFormatError(
      "trailing_data",
      data === "[DONE]" ? "duplicate_done" : "data_after_done"
    );
  }
  if (data === "[DONE]") {
    state.sawDone = true;
    return false;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(data) as unknown;
  } catch {
    throw new LlmResponseFormatError("event_json");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new LlmResponseFormatError("event_shape");
  }
  const rawRecord = raw as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rawRecord, "error")) {
    throw new LlmResponseFormatError("event_shape");
  }
  const choices = rawRecord.choices;
  if (!Array.isArray(choices)) {
    throw new LlmResponseFormatError("event_shape");
  }
  if (choices.length === 0) {
    // 部分服务商会在答案后发送只含用量的事件。
    return false;
  }
  if (state.sawStop) {
    // finish_reason=stop 之后只允许用量事件或 [DONE]。继续出现答案片段说明
    // 服务端的流不完整或次序异常，不能把前半段误当成完整结果。
    throw new LlmResponseFormatError("trailing_data", "choice_after_stop");
  }
  const choice = choices[0];
  if (typeof choice !== "object" || choice === null) {
    throw new LlmResponseFormatError("event_shape");
  }
  state.sawChoice = true;
  const choiceRecord = choice as Record<string, unknown>;
  assertSafeFinishReason(choiceRecord.finish_reason, "finish_shape");
  const deltaOrMessage =
    typeof choiceRecord.delta === "object" && choiceRecord.delta !== null
      ? choiceRecord.delta
      : choiceRecord.message;
  if (typeof deltaOrMessage !== "object" || deltaOrMessage === null) {
    throw new LlmResponseFormatError("delta_shape");
  }
  const part = deltaOrMessage as Record<string, unknown>;
  for (const field of ["reasoning_content", "reasoning", "content"] as const) {
    const value = part[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new LlmResponseFormatError("delta_shape");
    }
  }
  let hasValidOutput = false;
  if (typeof part.reasoning_content === "string") {
    state.reasoning += part.reasoning_content;
    hasValidOutput ||= /\S/u.test(part.reasoning_content);
  } else if (typeof part.reasoning === "string") {
    state.reasoning += part.reasoning;
    hasValidOutput ||= /\S/u.test(part.reasoning);
  }
  if (typeof part.content === "string") {
    state.content += part.content;
    hasValidOutput ||= /\S/u.test(part.content);
  }
  if (choiceRecord.finish_reason === "stop") {
    state.sawStop = true;
  }
  return hasValidOutput;
}

function assertSafeFinishReason(
  finishReason: unknown,
  failureStage: LlmResponseFormatFailureStage
): void {
  if (
    finishReason === undefined ||
    finishReason === null ||
    finishReason === "stop"
  ) {
    return;
  }
  if (finishReason === "length") {
    throw new LlmRequestError("LLM_OUTPUT_LENGTH_LIMIT");
  }
  if (finishReason === "content_filter") {
    throw new LlmRequestError("LLM_OUTPUT_CONTENT_FILTERED");
  }
  // 未知终止原因（包括工具调用）不能被当作完整文本，也不能把服务商
  // 返回的原始字符串放进异常或日志。
  throw new LlmResponseFormatError(failureStage);
}

function chatCompletionStreamResult(state: ChatCompletionStreamState): unknown {
  return {
    choices: [
      {
        message: {
          content: state.content,
          ...(state.reasoning.length === 0
            ? {}
            : { reasoning_content: state.reasoning })
        }
      }
    ]
  };
}

function addResponseChunkSize(
  totalBytes: number,
  nextBytes: number,
  formatFailureStage?: LlmResponseFormatFailureStage,
  formatFailureSubstage?: LlmResponseFormatFailureSubstage
): number {
  if (nextBytes > maximumLlmResponseBodyBytes - totalBytes) {
    throw new LlmResponseBodyTooLargeError(
      formatFailureStage,
      formatFailureSubstage
    );
  }
  return totalBytes + nextBytes;
}

function cancelReaderWithoutReplacingResult(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  fallbackController?: AbortController
): void {
  try {
    const cancellation = reader.cancel();
    void cancellation.catch(() => {
      fallbackController?.abort();
    });
  } catch {
    // 取消失败不能替换已经确定的结果或固定异常。
    fallbackController?.abort();
  }
}

function extractChatCompletion(
  raw: unknown,
  requireStop = false
): ChatCompletionResult {
  if (typeof raw !== "object" || raw === null) {
    throw new LlmResponseFormatError("response_shape");
  }
  const choices = (raw as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmResponseFormatError("response_shape");
  }
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) {
    throw new LlmResponseFormatError("response_shape");
  }
  const firstRecord = first as Record<string, unknown>;
  if (requireStop) {
    assertSafeFinishReason(firstRecord.finish_reason, "finish_shape");
    if (firstRecord.finish_reason !== "stop") {
      throw new LlmResponseFormatError("finish_shape");
    }
  }
  const message = firstRecord.message;
  if (typeof message !== "object" || message === null) {
    throw new LlmResponseFormatError("response_shape");
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new LlmResponseFormatError("response_shape");
  }
  const reasoningRaw = (message as Record<string, unknown>).reasoning_content;
  const reasoning = typeof reasoningRaw === "string" ? reasoningRaw : null;
  return { content, reasoning };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
