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
  readonly model: string;
  readonly temperature: number;
  /**
   * 是否保留响应里的思考过程；它不控制模型是否进行深度思考。
   */
  readonly thinking: boolean;
  /**
   * 显式发送经配置层限定的深度思考请求。当前只放行关闭。
   * 未配置时不发送 `thinking` 请求字段，保持原有请求行为。
   */
  readonly thinkingRequest?: "disabled";
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

  public constructor(
    code: LlmRequestError["code"],
    status?: number
  ) {
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
  }
}

/** 响应正文超过固定上限。异常只带固定说明，不保留任何正文片段。 */
export class LlmResponseBodyTooLargeError extends Error {
  public readonly code = "LLM_RESPONSE_BODY_TOO_LARGE";

  public constructor() {
    super("模型服务响应正文超过大小限制。");
    this.name = "LlmResponseBodyTooLargeError";
  }
}

/** 拿到了 2xx 响应，但结构不符合 OpenAI 兼容格式的基本假设（choices/message/content）。 */
export class LlmResponseFormatError extends Error {
  public readonly code = "LLM_RESPONSE_FORMAT_INVALID";

  public constructor() {
    super("模型服务响应格式不正确。");
    this.name = "LlmResponseFormatError";
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
        const raw = await parseResponseBody(response, controller, () => {
          watchdog.receivedValidOutput();
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
        throw new LlmRequestError("LLM_CANCELLED");
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
        responseReceived ? "LLM_STREAM_INTERRUPTED" : "LLM_NETWORK_FAILED"
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

  public error(): LlmRequestError | undefined {
    return this.#timeoutCode === null
      ? undefined
      : new LlmRequestError(this.#timeoutCode);
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

async function parseResponseBody(
  response: Response,
  requestController: AbortController,
  onValidOutput: () => void
): Promise<unknown> {
  const mediaType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (response.ok && mediaType.includes("text/event-stream")) {
    return readChatCompletionEventStream(
      response,
      requestController,
      onValidOutput
    );
  }
  const text = await readResponseTextWithLimit(response, requestController);
  if (text.length === 0) {
    throw new LlmResponseFormatError();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new LlmResponseFormatError();
  }
  // JSON 回退没有可靠的逐事件边界，只在 HTTP EOF 后验证整个响应。
  // 它必须明确 finish_reason=stop 且最终 content 非空白，然后才算
  // 收到有效模型输出。reasoning-only 不会被暗中升格为最终答案。
  extractChatCompletion(raw, true);
  onValidOutput();
  return raw;
}

async function readResponseTextWithLimit(
  response: Response,
  requestController: AbortController
): Promise<string> {
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  let bytes = new Uint8Array(0);
  let totalBytes = 0;
  let readerFinished = false;
  try {
    for (;;) {
      const chunk = await waitForOrAbort(
        reader.read(),
        requestController.signal
      );
      if (chunk.done) {
        readerFinished = true;
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, totalBytes)
          );
        } catch {
          throw new LlmResponseFormatError();
        }
      }
      if (chunk.value.byteLength > maximumLlmResponseBodyBytes - totalBytes) {
        try {
          const cancellation = reader.cancel();
          void cancellation.catch(() => undefined);
        } catch {
          // 取消失败不能替换固定异常，也不能把底层错误原文带出去。
        }
        requestController.abort();
        throw new LlmResponseBodyTooLargeError();
      }
      const requiredBytes = totalBytes + chunk.value.byteLength;
      if (requiredBytes > bytes.byteLength) {
        const nextCapacity = Math.min(
          maximumLlmResponseBodyBytes,
          Math.max(requiredBytes, Math.max(64 * 1024, bytes.byteLength * 2))
        );
        const expanded = new Uint8Array(nextCapacity);
        expanded.set(bytes.subarray(0, totalBytes));
        bytes = expanded;
      }
      bytes.set(chunk.value, totalBytes);
      totalBytes += chunk.value.byteLength;
    }
  } finally {
    if (!readerFinished) {
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
  onValidOutput: () => void
): Promise<unknown> {
  if (response.body === null) {
    throw new LlmRequestError("LLM_STREAM_INTERRUPTED");
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

  try {
    for (;;) {
      const chunk = await waitForOrAbort(
        reader.read(),
        requestController.signal
      );
      if (chunk.done) {
        readerFinished = true;
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
          if (consumeChatCompletionEvent(event, state)) onValidOutput();
        }
        if (pending.trim().length > 0) {
          if (consumeChatCompletionEvent(pending, state)) onValidOutput();
        }
        if (!state.sawChoice || (!state.sawStop && !state.sawDone)) {
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
        reader,
        requestController
      );
      if (chunk.value.byteLength === 0) continue;
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
        if (consumeChatCompletionEvent(event, state)) onValidOutput();
      }
    }
  } finally {
    if (!readerFinished) {
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

function decodeEventStreamText(
  decoder: TextDecoder,
  bytes?: Uint8Array
): string {
  try {
    return bytes === undefined
      ? decoder.decode()
      : decoder.decode(bytes, { stream: true });
  } catch {
    throw new LlmResponseFormatError();
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
    throw new LlmResponseFormatError();
  }
  if (data === "[DONE]") {
    state.sawDone = true;
    return false;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(data) as unknown;
  } catch {
    throw new LlmResponseFormatError();
  }
  if (typeof raw !== "object" || raw === null) {
    throw new LlmResponseFormatError();
  }
  const rawRecord = raw as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rawRecord, "error")) {
    throw new LlmResponseFormatError();
  }
  const choices = rawRecord.choices;
  if (!Array.isArray(choices)) {
    throw new LlmResponseFormatError();
  }
  if (choices.length === 0) {
    // 部分服务商会在答案后发送只含用量的事件。
    return false;
  }
  if (state.sawStop) {
    // finish_reason=stop 之后只允许用量事件或 [DONE]。继续出现答案片段说明
    // 服务端的流不完整或次序异常，不能把前半段误当成完整结果。
    throw new LlmResponseFormatError();
  }
  const choice = choices[0];
  if (typeof choice !== "object" || choice === null) {
    throw new LlmResponseFormatError();
  }
  state.sawChoice = true;
  const choiceRecord = choice as Record<string, unknown>;
  assertSafeFinishReason(choiceRecord.finish_reason);
  const deltaOrMessage =
    typeof choiceRecord.delta === "object" && choiceRecord.delta !== null
      ? choiceRecord.delta
      : choiceRecord.message;
  if (typeof deltaOrMessage !== "object" || deltaOrMessage === null) {
    throw new LlmResponseFormatError();
  }
  const part = deltaOrMessage as Record<string, unknown>;
  for (const field of ["reasoning_content", "reasoning", "content"] as const) {
    const value = part[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new LlmResponseFormatError();
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

function assertSafeFinishReason(finishReason: unknown): void {
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
  throw new LlmResponseFormatError();
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
  reader: ReadableStreamDefaultReader<Uint8Array>,
  requestController: AbortController
): number {
  if (nextBytes > maximumLlmResponseBodyBytes - totalBytes) {
    cancelReaderWithoutReplacingResult(reader);
    requestController.abort();
    throw new LlmResponseBodyTooLargeError();
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
    throw new LlmResponseFormatError();
  }
  const choices = (raw as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmResponseFormatError();
  }
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) {
    throw new LlmResponseFormatError();
  }
  const firstRecord = first as Record<string, unknown>;
  if (requireStop) {
    assertSafeFinishReason(firstRecord.finish_reason);
    if (firstRecord.finish_reason !== "stop") {
      throw new LlmResponseFormatError();
    }
  }
  const message = firstRecord.message;
  if (typeof message !== "object" || message === null) {
    throw new LlmResponseFormatError();
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new LlmResponseFormatError();
  }
  const reasoningRaw = (message as Record<string, unknown>).reasoning_content;
  const reasoning = typeof reasoningRaw === "string" ? reasoningRaw : null;
  return { content, reasoning };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
