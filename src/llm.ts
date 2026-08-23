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
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { AsyncLocalStorage } from "node:async_hooks";
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

/** 只记录安全的传输完成事实，不包含服务商正文、请求或响应标识。 */
export type LlmResponseMode = "sse" | "json";

export type LlmSseRejectedShape =
  | "json_invalid"
  | "non_object"
  | "error_object"
  | "choices_missing_or_non_array"
  | "choice_non_object"
  | "delta_missing_or_non_object"
  | "delta_field_type"
  | "finish_reason_type_or_unknown";
export type LlmSafeJsonType =
  | "missing"
  | "null"
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "other";
export type LlmSseChoicesLengthBucket = "0" | "1" | "many";
export type LlmSsePayloadSource = "delta" | "message" | "both" | "neither";
export type LlmSseFinishReasonClass =
  | "missing"
  | "null"
  | "stop"
  | "length"
  | "content_filter"
  | "unknown_string"
  | "non_string";
export interface LlmSsePayloadFieldTypeAudit {
  readonly content: LlmSafeJsonType;
  readonly reasoningContent: LlmSafeJsonType;
  readonly reasoning: LlmSafeJsonType;
  readonly role: LlmSafeJsonType;
  readonly functionCall: LlmSafeJsonType;
  readonly refusal: LlmSafeJsonType;
  readonly toolCalls: LlmSafeJsonType;
}
export interface LlmSseFieldTypeAudit {
  readonly choices: LlmSafeJsonType;
  readonly created: LlmSafeJsonType;
  readonly id: LlmSafeJsonType;
  readonly model: LlmSafeJsonType;
  readonly object: LlmSafeJsonType;
  readonly serviceTier: LlmSafeJsonType;
  readonly systemFingerprint: LlmSafeJsonType;
  readonly usage: LlmSafeJsonType;
  readonly error: LlmSafeJsonType;
  readonly control: LlmSafeJsonType;
  readonly choice: LlmSafeJsonType;
  readonly delta: LlmSafeJsonType;
  readonly message: LlmSafeJsonType;
  readonly finishReason: LlmSafeJsonType;
  readonly index: LlmSafeJsonType;
  readonly logprobs: LlmSafeJsonType;
  readonly deltaFields: LlmSsePayloadFieldTypeAudit;
  readonly messageFields: LlmSsePayloadFieldTypeAudit;
}
export interface LlmSseStructuralAudit {
  readonly fieldTypes: LlmSseFieldTypeAudit;
  readonly choicesLength: LlmSseChoicesLengthBucket | null;
  readonly payloadSource: LlmSsePayloadSource;
  readonly finishReasonClass: LlmSseFinishReasonClass;
  readonly finishReasonIsNull: boolean;
  readonly finishReasonUnknownStringHash: string | null;
  readonly hasUsageField: boolean;
  readonly hasErrorField: boolean;
  readonly hasControlField: boolean;
  readonly unknownTopLevelKeyCount: number;
  readonly unknownTopLevelKeysFingerprint: string;
  readonly unknownChoiceKeyCount: number;
  readonly unknownChoiceKeysFingerprint: string;
  readonly unknownPayloadKeyCount: number;
  readonly unknownPayloadKeysFingerprint: string;
  readonly unknownKeysFingerprint: string;
}
export type LlmSseAcceptedShapeCategory =
  | "done"
  | "usage"
  | "content"
  | "reasoning"
  | "content_reasoning"
  | "role"
  | "finish"
  | "metadata";
export interface LlmSseAcceptedShapeAudit {
  readonly category: LlmSseAcceptedShapeCategory;
  readonly shapeFingerprint: string;
  readonly count: number;
}

/**
 * 错误信封的安全分类闭集。不依赖任何负载值、message 或 code 内容；
 * 只从键名是否存在和字段类型推导。所有 error 事件永久拒绝，不进入任何接受路径。
 */
export type LlmSseErrorEnvelopeClassification =
  | "known_fields_only"
  | "unknown_fields_present"
  | "non_object";

/** 已知错误信封字段名的闭集。只有这些字段名会被原样持久化。 */
const errorEnvelopeAllowlist = new Set([
  "code",
  "message",
  "type",
  "param",
  "detail",
  "status",
  "instance",
  "title",
  "error",
  "errors",
  "reason",
  "request_id"
]);

/** 允许持久化嵌套对象键名的闭集。只有这些嵌套键名会被原样记录。 */
const errorEnvelopeNestedAllowlist = new Set([
  "error",
  "errors",
  "detail"
]);

/** 安全的错误信封字段审计：只记录 allowlist 字段名和类型，绝不记录字段值。 */
export interface LlmSseErrorEnvelopeFieldAudit {
  readonly key: string;
  readonly type: LlmSafeJsonType;
}

/**
 * provider/gateway `error` 信封的安全形状指纹。闭集只记录 allowlist 字段名、
 * 字段类型和安全分类；未知字段名只记录计数和域分离不可逆指纹，绝不原样持久化。
 * 不记录 message、code 值或任何原始负载文本。所有 error 事件永久拒绝。
 */
export interface LlmSseErrorEnvelopeAudit {
  readonly present: true;
  readonly classification: LlmSseErrorEnvelopeClassification;
  readonly fieldCount: number;
  readonly allowedFields: readonly LlmSseErrorEnvelopeFieldAudit[];
  readonly allowedNestedObjectKeys: readonly string[];
  readonly unknownFieldCount: number;
  readonly unknownKeysFingerprint: string;
  readonly envelopeFingerprint: string;
}

export interface LlmSseRejectedEventAudit {
  readonly eventOrdinal: number;
  readonly completedEventCount: number;
  readonly dataFieldCount: number;
  readonly eventUtf8Bytes: number;
  readonly topLevelKeys: readonly string[];
  readonly unknownTopLevelKeyCount: number;
  readonly unknownTopLevelKeysFingerprint: string;
  readonly choiceKeys: readonly string[];
  readonly unknownChoiceKeyCount: number;
  readonly unknownChoiceKeysFingerprint: string;
  readonly deltaKeys: readonly string[];
  readonly unknownPayloadKeyCount: number;
  readonly unknownPayloadKeysFingerprint: string;
  readonly shape: LlmSseRejectedShape;
  readonly structure: LlmSseStructuralAudit;
  readonly errorEnvelope: LlmSseErrorEnvelopeAudit | null;
  readonly shapeFingerprint: string;
}

export interface LlmTransportReceipt {
  readonly schemaVersion: 2;
  /** 同一逻辑请求中实际进行的 HTTP 尝试数；只有明确 429 才可能大于 1。 */
  readonly transportAttemptCount: number;
  /** 只有读到真实 HTTP 正文 EOF 并通过终止状态机后才会生成 receipt。 */
  readonly eofVerified: true;
  /** 区分真正的 SSE 流与兼容网关退回的单个 JSON 正文。 */
  readonly responseMode: LlmResponseMode;
  /** SSE 必须明确观察到 finish_reason=stop；JSON 回退也做同样校验。 */
  readonly finishReasonStopVerified: true;
  /** JSON 没有 `[DONE]`；SSE 则如实记录服务端是否发送了协议终止标记。 */
  readonly acceptedEventShapes: readonly LlmSseAcceptedShapeAudit[];
  readonly sseDoneObserved: boolean | null;
}

export interface ChatCompletionWithReceipt extends ChatCompletionResult {
  readonly receipt: LlmTransportReceipt;
}

export interface LlmJsonCompletionReceipt {
  readonly schemaVersion: 2;
  /**
   * 请求次数：1 = 首轮直接成功；2 = 触发修复轮或两轮设计（语义+格式）的第二轮；
   * 3 = 两轮设计中格式轮再触发修复，或三段式（探索+综合+格式）无修复；
   * 4 = 三段式中格式轮再触发修复。
   */
  readonly requestCount: 1 | 2 | 3 | 4;
  readonly transportAttemptCount: number;
  readonly eofVerified: true;
  readonly jsonSchemaValidated: true;
  /** 每一轮生成各自的传输完成证据；长度必须等于 requestCount。 */
  readonly responses:
    | readonly [LlmTransportReceipt]
    | readonly [LlmTransportReceipt, LlmTransportReceipt]
    | readonly [LlmTransportReceipt, LlmTransportReceipt, LlmTransportReceipt]
    | readonly [
        LlmTransportReceipt,
        LlmTransportReceipt,
        LlmTransportReceipt,
        LlmTransportReceipt
      ];
}

/**
 * 抢救传输 receipt：当 finish_reason="length" 且 reasoning 非空、content 为空
 * 时，salvage 路径接受此传输作为可抢救的分析结果。不包含原始 reasoning 内容，
 * 只记录安全计数（salvagedReasoningLength），供审计和最终化阶段使用。
 * finishReasonStopVerified 为 false（因为不是正常 stop），finishReason 为 "length"。
 */
export interface LlmSalvageTransportReceipt {
  readonly schemaVersion: 2;
  readonly transportAttemptCount: number;
  readonly eofVerified: true;
  readonly responseMode: LlmResponseMode;
  readonly finishReasonStopVerified: false;
  readonly finishReasonLengthSalvaged: true;
  readonly salvagedReasoningLength: number;
  readonly acceptedEventShapes: readonly LlmSseAcceptedShapeAudit[];
  readonly sseDoneObserved: boolean | null;
}

/**
 * chatCompleteSalvageableWithReceipt 的返回值。salvaged 为 true 时 content 为空、
 * reasoning 为非空分析文本（仅在内存中传递给 finalizer，不写入 receipt、日志或磁盘）；
 * salvaged 为 false 时等价于正常 ChatCompletionWithReceipt。
 */
export type ChatCompletionSalvageableResult =
  | {
      readonly content: string;
      readonly reasoning: string | null;
      readonly salvaged: false;
      readonly receipt: LlmTransportReceipt;
    }
  | {
      readonly content: "";
      readonly reasoning: string;
      readonly salvaged: true;
      readonly receipt: LlmSalvageTransportReceipt;
    };

/**
 * reasoning salvage → JSON finalizer 完整流程的 receipt。
 * analysisSalvaged 为 true 表示分析轮在 finish_reason="length" 后被抢救，
 * 并通过独立 finalizer 阶段提取结构化结论。
 * 不包含原始 reasoning；analysisReceipt 是抢救传输的安全摘要，
 * finalizationReceipt 是 finalizer 轮的正常传输 receipt。
 */
export interface LlmReasoningSalvageJsonReceipt {
  readonly schemaVersion: 2;
  readonly analysisSalvaged: true;
  readonly requestCount: 2 | 3;
  readonly transportAttemptCount: number;
  readonly eofVerified: true;
  readonly jsonSchemaValidated: true;
  readonly responses:
    | readonly [LlmSalvageTransportReceipt, LlmTransportReceipt]
    | readonly [LlmSalvageTransportReceipt, LlmTransportReceipt, LlmTransportReceipt];
}

/**
 * 失败路径的安全审计摘要。它只含协议状态与计数，绝不保存请求、题面、
 * 响应正文、服务商错误说明或响应标识。WeakMap 绑定保证这些字段不会因
 * 序列化 Error 意外进入普通日志。
 */
export type SafeSchemaDiagnosticPath =
  | "/originalityLevel"
  | "/sameProblemAsExisting"
  | "/highestSimilarity"
  | "/evidenceIds"
  | "/evidenceIds/*"
  | "/rationale"
  | "/";
export type SafeSchemaDiagnosticCategory =
  | "level_1_5"
  | "boolean"
  | "number_0_1"
  | "safe_id_array"
  | "short_text"
  | "exact_key_set";
export interface SafeSchemaDiagnostic {
  readonly code: string;
  readonly path: SafeSchemaDiagnosticPath;
  readonly expectedCategory: SafeSchemaDiagnosticCategory;
}

export interface LlmTransportAudit {
  readonly providerRequestCount: number;
  readonly retryCount: number;
  readonly responseByteCount: number;
  readonly usageTotalTokens: number | null;
  readonly usageComplete: boolean;
  readonly maxOutputTokens: number | null;
  readonly finishReason: LlmSseFinishReasonClass | null;
  readonly eofObserved: boolean;
  readonly finishReasonStopObserved: boolean;
  readonly sseDoneObserved: boolean | null;
}

export interface LlmCompletionAudit {
  readonly logicalRequestCount: number;
  readonly transportAttemptCount: number;
  readonly providerRequestCount: number;
  readonly retryCount: number;
  readonly responseByteCount: number;
  readonly usageTotalTokens: number | null;
  readonly usageComplete: boolean;
  readonly maxOutputTokens: number | null;
  readonly finishReason: LlmSseFinishReasonClass | null;
  readonly eofObserved: boolean;
  readonly finishReasonStopObserved: boolean;
  readonly sseDoneObserved: boolean | null;
}

export interface LlmFailureAudit {
  readonly schemaVersion: 1;
  readonly requestCount: 1 | 2 | 3 | 4;
  readonly transportAttemptCount: number;
  readonly providerRequestCount: number;
  readonly retryCount: number;
  readonly maxOutputTokens: number | null;
  readonly responseByteCount: number;
  readonly usageTotalTokens: number | null;
  readonly usageComplete: boolean;
  readonly completedResponses: readonly LlmTransportReceipt[];
  readonly terminal: {
    readonly status: number | null;
    readonly responseMode: LlmResponseMode | null;
    readonly eofObserved: boolean;
    readonly finishReason: LlmSseFinishReasonClass | null;
    readonly finishReasonStopObserved: boolean;
    readonly sseDoneObserved: boolean | null;
  };
  readonly stream: {
    readonly eventCount: number;
    readonly utf8Bytes: number;
    readonly chunkCount: number;
    readonly usageEventCount: number;
    readonly usageTotalTokens: number | null;
    readonly acceptedEventShapes: readonly LlmSseAcceptedShapeAudit[];
    readonly firstRejectedEvent: LlmSseRejectedEventAudit | null;
  };
  /** null 表示尚未走到结构化 JSON 校验；false 表示校验未成功。 */
  readonly jsonSchemaValidated: false | null;
  readonly schemaDiagnostic?: SafeSchemaDiagnostic;
}

const llmTransportAudits = new WeakMap<object, LlmTransportAudit>();
const llmCompletionAudits = new WeakMap<object, LlmCompletionAudit>();
const llmFailureAudits = new WeakMap<object, LlmFailureAudit>();

export function getLlmTransportAudit(value: unknown): LlmTransportAudit | null {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return null;
  }
  return llmTransportAudits.get(value) ?? null;
}

export function getLlmCompletionAudit(value: unknown): LlmCompletionAudit | null {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return null;
  }
  const existing = llmCompletionAudits.get(value);
  if (existing !== undefined) return existing;
  const responseValues = (value as { readonly responses?: unknown }).responses;
  if (!Array.isArray(responseValues) || responseValues.length === 0) return null;
  const audits = responseValues.map(getLlmTransportAudit);
  if (audits.some((audit) => audit === null)) return null;
  const entries = audits as LlmTransportAudit[];
  const logicalRequestCount = Number.isSafeInteger(
    (value as { readonly requestCount?: unknown }).requestCount
  )
    ? (value as { readonly requestCount: number }).requestCount
    : entries.length;
  const providerRequestCount = entries.reduce(
    (sum, audit) => sum + audit.providerRequestCount,
    0
  );
  const sseEntries = entries.filter((audit) => audit.sseDoneObserved !== null);
  const maxOutputTokens = entries[0]?.maxOutputTokens ?? null;
  const usageValues = entries.flatMap((audit) =>
    audit.usageTotalTokens === null ? [] : [audit.usageTotalTokens]
  );
  const audit = Object.freeze({
    logicalRequestCount,
    transportAttemptCount: providerRequestCount,
    providerRequestCount,
    retryCount: entries.reduce((sum, entry) => sum + entry.retryCount, 0),
    responseByteCount: entries.reduce(
      (sum, entry) => sum + entry.responseByteCount,
      0
    ),
    usageTotalTokens: usageValues.length === 0
      ? null
      : usageValues.reduce((sum, value) => sum + value, 0),
    usageComplete: entries.every((entry) => entry.usageComplete),
    maxOutputTokens: entries.every(
      (entry) => entry.maxOutputTokens === maxOutputTokens
    )
      ? maxOutputTokens
      : null,
    finishReason: entries.at(-1)?.finishReason ?? null,
    eofObserved: entries.every((entry) => entry.eofObserved),
    finishReasonStopObserved: entries.every(
      (entry) => entry.finishReasonStopObserved
    ),
    sseDoneObserved: sseEntries.length === 0
      ? null
      : sseEntries.every((entry) => entry.sseDoneObserved === true)
  });
  llmCompletionAudits.set(value, audit);
  return audit;
}

export function copyLlmCompletionAudit(source: unknown, target: unknown): void {
  if ((typeof target !== "object" && typeof target !== "function") || target === null) {
    return;
  }
  const audit = getLlmCompletionAudit(source);
  if (audit !== null) llmCompletionAudits.set(target, audit);
}

function rememberLlmTransportAudit(
  receipt: object,
  audit: LlmTransportAudit
): void {
  llmTransportAudits.set(receipt, Object.freeze({ ...audit }));
}

export function getLlmFailureAudit(error: unknown): LlmFailureAudit | null {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return null;
  }
  return llmFailureAudits.get(error) ?? null;
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
   * 显式发送经配置层限定的深度思考请求。Aether deepseek-v4-flash 和
   * deepseek-v4-pro 必须配置 enabled + max；其它模型/网关不允许配置。
   * 未配置时不发送 `thinking` 请求字段，保持原有请求行为。
   */
  readonly thinkingRequest?: "enabled" | "disabled";
  readonly reasoningEffort?: "max";
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
  /**
   * 标定专用的直接结构化模式。默认关闭时保留语义轮+格式化轮；开启后，两轮
   * JSON 角色在一个请求中完成判断和严格 JSON，staged solver 保留探索轮并把
   * 综合轮直接结构化。JSON 修复仍可按原协议追加一次请求。
   */
  readonly directStructuredOutput?: boolean;
  readonly fetch?: FetchLike;
  /** 任务已经丢失或被明确拒绝时，由上层用它停止仍在运行的付费请求。 */
  readonly signal?: AbortSignal;
  /**
   * 有效 content/reasoning 事件的安全活动通知。回调不接收响应正文；仅供
   * development smoke 在进程内测首个有效输出与事件速率。
   */
  readonly onSafeOutputActivity?: () => void;
  /** 首个非空 HTTP 正文字节的安全通知；不接收、不保留正文。 */
  readonly onResponseBodyByte?: () => void;
  /**
   * 在每次实际外部传输（fetch）前同步调用。如果回调抛出异常，
   * fetch 不会发生，失败按确定性 fail-closed 处理。
   * 不计数逻辑请求——每个传输尝试（含 429 重试）各调用一次。
   */
  readonly onTransportDispatch?: (attempt: number) => void | Promise<void>;
  /**
   * 可选的传输级异步调度器。调度回调包住一次完整外部请求：取得并发槽位后才启动
   * 传输前检查、watchdog 与 fetch，并持有槽位直到响应正文完成或失败。拒绝排队
   * 不消耗外部传输配额，也不会让排队时间消耗首段输出时限。
   */
  readonly dispatchTransport?: <T>(execute: () => Promise<T>) => Promise<T>;
}

/**
 * 离线付费标定共用的“只阻止下一次请求”闸门。关闭它绝不会 abort 已经发出的
 * HTTP 流；它只在新的逻辑请求、JSON 修复轮或 429 重试真正调用 fetch 前拒绝。
 */
export class LlmRequestStartGate {
  #open = true;

  public canStartRequest(): boolean {
    return this.#open;
  }

  public close(): void {
    this.#open = false;
  }
}

const llmRequestStartGateContext = new AsyncLocalStorage<LlmRequestStartGate>();

export function isLlmRequestStartGate(value: unknown): value is LlmRequestStartGate {
  return value instanceof LlmRequestStartGate;
}

export function withLlmRequestStartGate<Result>(
  gate: LlmRequestStartGate,
  callback: () => Result
): Result {
  if (!isLlmRequestStartGate(gate)) {
    throw new Error("LLM_REQUEST_START_GATE_INVALID");
  }
  const active = llmRequestStartGateContext.getStore();
  if (active !== undefined && active !== gate) {
    throw new Error("LLM_REQUEST_START_GATE_INVALID");
  }
  return llmRequestStartGateContext.run(gate, callback);
}

function assertLlmRequestMayStart(): void {
  const gate = llmRequestStartGateContext.getStore();
  if (gate !== undefined && !gate.canStartRequest()) {
    throw new LlmRequestError("LLM_REQUEST_START_BLOCKED");
  }
}

export interface ChatCompletionOptions {
  readonly requestJson?: boolean;
  /**
   * 交给 OpenAI compatible 接口的输出 token 硬上限。未设置时不发送
   * `max_tokens`，保持既有调用行为。
   */
  readonly maxOutputTokens?: number;
  /** 完整 JSON Schema 强制输出；与旧 requestJson 互斥。 */
  readonly responseJsonSchema?: {
    readonly name: string;
    readonly schema: Readonly<Record<string, unknown>>;
  };
}

export interface ChatCompletionJsonOptions {
  /** 首轮和唯一一次 JSON 修复轮共用同一个输出 token 硬上限。 */
  readonly maxOutputTokens?: number;
  /** Opt-in, value-free Zod metadata for the originality formatter probe only. */
  readonly safeSchemaDiagnostic?: "originality";
}

/**
 * 修改 EOF/终止状态机或 receipt 语义时必须显式递增并重新标定。
 *
 * v10：新增 opt-in reasoning-length salvage 路径。当 salvageOnLengthLimit 启用时，
 * finish_reason="length" 且 reasoning 非空、content 为空的 SSE 流不再抛
 * LLM_OUTPUT_LENGTH_LIMIT，而是标记为 salvaged 并返回 reasoning，交由独立
 * finalizer 阶段提取结构化结论。正常 finish_reason="stop" 路径完全不受影响。
 * v9：删除固定 4 MiB 响应正文总上限。流式路径本按增量解析，原始正文只计数
 * 不保留；现在长 reasoning=max 响应可以流式读完并正常结束（见
 * maximumRetainedLlmTextLength 的防御性护栏）。DONE 后尾部分类、分块上限、
 * 看门狗与失败语义不变。
 */
export const llmTransportProtocolVersion =
  "llm-stream-eof-v10-receipt-v2-failure-audit-v1" as const;
const maximumLlmResponseChunks = 65_536;
/**
 * 显式输出 token 上限按提供商硬上限设置：DeepSeek V4 全系（deepseek-v4-pro /
 * deepseek-v4-flash）文档化最大输出为 384000 token；若字段缺失，提供商默认
 * max_tokens=4096（更小）。因此每次请求都显式请求 384000，不再保留任何项目自设的
 * 32k/64k 人工输出上限。唯一剩余的输出终止边界是提供商自身的硬上限，到达后按
 * LLM_OUTPUT_LENGTH_LIMIT 终态处理（不重试、fail closed）。
 */
export const maximumExplicitLlmOutputTokens = 384_000;
/**
 * 解析后保留文本的防御性上限，单位是 UTF-16 长度（value.length），按提供商硬
 * 上限推导：384000 token × 64 单位/token = 24576000。真实提供商在硬上限内
 * 远达不到（DeepSeek 实际约 8–10 单位/token），所以它永远不会限制合法输出；
 * 它只是针对恶意或损坏上游的堆内存护栏。原始响应正文（SSE 线格式）不再有
 * 任何总字节上限：流式路径逐增量解析，正文按字节只计数不保留。
 */
export const maximumRetainedLlmTextLength =
  maximumExplicitLlmOutputTokens * 64;
export const defaultLlmFirstOutputTimeoutMs = 30 * 60 * 1_000;
export const defaultLlmMaximumDurationMs = 30 * 60 * 1_000;

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
    | "LLM_REQUEST_START_BLOCKED"
    | "LLM_TRANSPORT_DENIED"
    | "LLM_OUTPUT_LENGTH_LIMIT"
    | "LLM_OUTPUT_CONTENT_FILTERED";
  public readonly status: number | undefined;
  /** 排空格式首错时若被超时、取消或断流覆盖，保留安全的最初协议阶段。 */
  public readonly formatFailureStage: LlmResponseFormatFailureStage | undefined;
  /** `trailing_data` 的封闭分类；不包含响应正文、字段名、长度或其它服务商数据。 */
  public readonly formatFailureSubstage:
    | LlmResponseFormatFailureSubstage
    | undefined;
  /** 只保留已限幅的 Retry-After 毫秒数，不保留原始响应头。 */
  public readonly retryAfterMs: number | null;

  public constructor(
    code: LlmRequestError["code"],
    status?: number,
    formatFailureStage?: LlmResponseFormatFailureStage,
    formatFailureSubstage?: LlmResponseFormatFailureSubstage,
    retryAfterMs?: number | null
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
      LLM_REQUEST_START_BLOCKED: "模型请求启动闸门已关闭。",
      LLM_TRANSPORT_DENIED: "传输前派发钩子拒绝了本次外部传输。",
      LLM_OUTPUT_LENGTH_LIMIT: "模型服务因输出长度限制而停止。",
      LLM_OUTPUT_CONTENT_FILTERED: "模型服务因内容过滤而停止。"
    };
    super(messages[code]);
    this.name = "LlmRequestError";
    this.code = code;
    this.status = status;
    this.formatFailureStage = formatFailureStage;
    this.formatFailureSubstage = formatFailureSubstage;
    this.retryAfterMs = retryAfterMs === undefined || retryAfterMs === null
      ? null
      : Math.max(0, Math.min(Math.floor(retryAfterMs), 60 * 60 * 1_000));
  }
}

/**
 * 解析后保留文本超过防御性上限（LLM_RETAINED_TEXT_TOO_LARGE）。
 * 异常只带固定说明，不保留任何正文片段；按永久错误处理，不重试。
 */
export class LlmRetainedTextTooLargeError extends Error {
  public readonly code = "LLM_RETAINED_TEXT_TOO_LARGE";

  public constructor() {
    super("模型响应解析后保留文本超过防御性上限。");
    this.name = "LlmRetainedTextTooLargeError";
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
  /** v5/d 的历史粗分类；v6/e 不再产生，但保留类型兼容。 */
  | "data_after_done"
  | "data_after_done_usage_metadata_only"
  /** v7/f 的闭集分类：空 data、重复 DONE 与严格元数据可以任意混合。 */
  | "data_after_done_benign_controls_only"
  | "data_after_done_json_syntax_invalid"
  | "data_after_done_json_non_object"
  | "data_after_done_error_object"
  | "data_after_done_unknown_object_or_scan_limit"
  | "data_after_done_choices_present"
  | "data_after_done_content_or_tool_present"
  | "data_after_done_other_or_unclassifiable"
  | "data_after_done_tail_incomplete"
  | "choice_after_stop";

const safeFormatFailureSubstageValues = new Set<
  LlmResponseFormatFailureSubstage
>([
  "duplicate_done",
  "data_after_done",
  "data_after_done_usage_metadata_only",
  "data_after_done_benign_controls_only",
  "data_after_done_json_syntax_invalid",
  "data_after_done_json_non_object",
  "data_after_done_error_object",
  "data_after_done_unknown_object_or_scan_limit",
  "data_after_done_choices_present",
  "data_after_done_content_or_tool_present",
  "data_after_done_other_or_unclassifiable",
  "data_after_done_tail_incomplete",
  "choice_after_stop"
]);

function assertSafeFormatFailureSubstage(
  formatFailureStage?: LlmResponseFormatFailureStage,
  formatFailureSubstage?: LlmResponseFormatFailureSubstage
): void {
  const knownSubstage =
    formatFailureSubstage !== undefined &&
    safeFormatFailureSubstageValues.has(formatFailureSubstage);
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
  const { receipt: _receipt, ...result } = await chatCompleteWithReceipt(
    provider,
    spec,
    messages,
    runtime,
    options
  );
  return result;
}

/** 与 chatComplete 相同，但额外返回只能在真实 EOF 后产生的安全 receipt。 */
export async function chatCompleteWithReceipt(
  provider: ProviderCredentialsLike,
  spec: ModelCallSpec,
  messages: ChatMessage[],
  runtime: LlmRuntimeOptions,
  options: ChatCompletionOptions = {}
): Promise<ChatCompletionWithReceipt> {
  validateThinkingRequest(spec);
  const fetchImpl = runtime.fetch ?? productionLlmFetch;
  const url = new URL("chat/completions", ensureTrailingSlash(provider.baseUrl));
  const body: Record<string, unknown> = {
    model: spec.model,
    temperature: spec.temperature,
    stream: true,
    messages
  };
  if (options.requestJson === true && options.responseJsonSchema !== undefined) {
    throw new Error("LLM_RESPONSE_FORMAT_CONFLICT");
  }
  if (options.responseJsonSchema !== undefined) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(options.responseJsonSchema.name)) {
      throw new Error("LLM_RESPONSE_SCHEMA_NAME_INVALID");
    }
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: options.responseJsonSchema.name,
        strict: true,
        schema: options.responseJsonSchema.schema
      }
    };
  } else if (options.requestJson === true) {
    body.response_format = { type: "json_object" };
  }
  if (spec.thinkingRequest !== undefined) {
    body.thinking = { type: spec.thinkingRequest };
  }
  if (spec.reasoningEffort !== undefined) {
    body.reasoning_effort = spec.reasoningEffort;
  }
  const maxOutputTokens = options.maxOutputTokens === undefined
    ? null
    : validateMaxOutputTokens(options.maxOutputTokens);
  if (maxOutputTokens !== null) {
    body.max_tokens = maxOutputTokens;
  }

  const requestAudit = createMutableLlmRequestAudit(maxOutputTokens);
  let response: Awaited<ReturnType<typeof requestWithRetry>>;
  try {
    response = await requestWithRetry(
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
      runtime,
      requestAudit
    );
  } catch (error) {
    rememberLlmFailureAudit(error, {
      requestCount: 1,
      requestAudit,
      jsonSchemaValidated: null
    });
    throw error;
  }

  if (!response.ok) {
    // 服务商的 error.message 可能回显请求内容，不能放进异常或日志。
    const error = new LlmRequestError(
      "LLM_HTTP_ERROR",
      response.status,
      undefined,
      undefined,
      response.retryAfterMs
    );
    rememberLlmFailureAudit(error, {
      requestCount: 1,
      requestAudit,
      jsonSchemaValidated: null
    });
    throw error;
  }
  if (response.responseMode === null || !response.finishReasonStopVerified) {
    const error = new LlmResponseFormatError("response_shape");
    rememberLlmFailureAudit(error, {
      requestCount: 1,
      requestAudit,
      jsonSchemaValidated: null
    });
    throw error;
  }

  const extracted = extractChatCompletion(response.raw);
  const result = spec.thinking
    ? extracted
    : { content: extracted.content, reasoning: null };
  const receipt: LlmTransportReceipt = Object.freeze({
    schemaVersion: 2,
    transportAttemptCount: response.attemptCount,
    eofVerified: true,
    responseMode: response.responseMode,
    finishReasonStopVerified: true,
    acceptedEventShapes: acceptedShapeAudit(requestAudit),
    sseDoneObserved: response.sseDoneObserved
  });
  rememberLlmTransportAudit(receipt, mutableLlmTransportAudit(requestAudit));
  return {
    ...result,
    receipt
  };
}

/**
 * 与 chatCompleteWithReceipt 相同，但启用 reasoning-length salvage：当
 * finish_reason="length" 且 reasoning 非空、content 为空时，不抛
 * LLM_OUTPUT_LENGTH_LIMIT，而是返回 salvaged=true 和完整 reasoning 文本。
 * reasoning 仅在内存中返回给调用方用于 finalizer 阶段，不写入 receipt。
 * 正常 finish_reason="stop" 路径完全不受影响（salvaged=false）。
 */
export async function chatCompleteSalvageableWithReceipt(
  provider: ProviderCredentialsLike,
  spec: ModelCallSpec,
  messages: ChatMessage[],
  runtime: LlmRuntimeOptions,
  options: ChatCompletionOptions = {}
): Promise<ChatCompletionSalvageableResult> {
  validateThinkingRequest(spec);
  const fetchImpl = runtime.fetch ?? productionLlmFetch;
  const url = new URL("chat/completions", ensureTrailingSlash(provider.baseUrl));
  const body: Record<string, unknown> = {
    model: spec.model,
    temperature: spec.temperature,
    stream: true,
    messages
  };
  if (options.requestJson === true && options.responseJsonSchema !== undefined) {
    throw new Error("LLM_RESPONSE_FORMAT_CONFLICT");
  }
  if (options.responseJsonSchema !== undefined) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(options.responseJsonSchema.name)) {
      throw new Error("LLM_RESPONSE_SCHEMA_NAME_INVALID");
    }
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: options.responseJsonSchema.name,
        strict: true,
        schema: options.responseJsonSchema.schema
      }
    };
  } else if (options.requestJson === true) {
    body.response_format = { type: "json_object" };
  }
  if (spec.thinkingRequest !== undefined) {
    body.thinking = { type: spec.thinkingRequest };
  }
  if (spec.reasoningEffort !== undefined) {
    body.reasoning_effort = spec.reasoningEffort;
  }
  const maxOutputTokens = options.maxOutputTokens === undefined
    ? null
    : validateMaxOutputTokens(options.maxOutputTokens);
  if (maxOutputTokens !== null) {
    body.max_tokens = maxOutputTokens;
  }

  const requestAudit = createMutableLlmRequestAudit(maxOutputTokens);
  let response: Awaited<ReturnType<typeof requestWithRetry>>;
  try {
    response = await requestWithRetry(
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
      runtime,
      requestAudit,
      true
    );
  } catch (error) {
    rememberLlmFailureAudit(error, {
      requestCount: 1,
      requestAudit,
      jsonSchemaValidated: null
    });
    throw error;
  }

  if (!response.ok) {
    const error = new LlmRequestError(
      "LLM_HTTP_ERROR",
      response.status,
      undefined,
      undefined,
      response.retryAfterMs
    );
    rememberLlmFailureAudit(error, {
      requestCount: 1,
      requestAudit,
      jsonSchemaValidated: null
    });
    throw error;
  }
  if (response.salvaged) {
    // 抢救路径：从 raw stream result 提取 reasoning，不提取 content（content 为空）。
    const reasoning = extractSalvagedReasoning(response.raw);
    const receipt: LlmSalvageTransportReceipt = Object.freeze({
      schemaVersion: 2,
      transportAttemptCount: response.attemptCount,
      eofVerified: true,
      responseMode: response.responseMode as LlmResponseMode,
      finishReasonStopVerified: false,
      finishReasonLengthSalvaged: true,
      salvagedReasoningLength: reasoning.length,
      acceptedEventShapes: acceptedShapeAudit(requestAudit),
      sseDoneObserved: response.sseDoneObserved
    });
    rememberLlmTransportAudit(receipt, mutableLlmTransportAudit(requestAudit));
    return {
      content: "",
      reasoning,
      salvaged: true,
      receipt
    };
  }
  if (response.responseMode === null || !response.finishReasonStopVerified) {
    const error = new LlmResponseFormatError("response_shape");
    rememberLlmFailureAudit(error, {
      requestCount: 1,
      requestAudit,
      jsonSchemaValidated: null
    });
    throw error;
  }
  const extracted = extractChatCompletion(response.raw);
  const result = spec.thinking
    ? extracted
    : { content: extracted.content, reasoning: null };
  const receipt: LlmTransportReceipt = Object.freeze({
    schemaVersion: 2,
    transportAttemptCount: response.attemptCount,
    eofVerified: true,
    responseMode: response.responseMode,
    finishReasonStopVerified: true,
    acceptedEventShapes: acceptedShapeAudit(requestAudit),
    sseDoneObserved: response.sseDoneObserved
  });
  rememberLlmTransportAudit(receipt, mutableLlmTransportAudit(requestAudit));
  return {
    ...result,
    salvaged: false,
    receipt
  };
}

/**
 * 从抢救路径的 raw stream result 提取 reasoning 文本。
 * chatCompletionStreamResult 产生的结构是 { choices: [{ message: { content, reasoning_content? } }] }。
 * 抢救路径保证 content 为空、reasoning_content 非空。
 */
function extractSalvagedReasoning(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) {
    throw new LlmResponseFormatError("response_shape");
  }
  const choices = (raw as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmResponseFormatError("response_shape");
  }
  const first = choices[0];
  if (typeof first !== "object" || first === null) {
    throw new LlmResponseFormatError("response_shape");
  }
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) {
    throw new LlmResponseFormatError("response_shape");
  }
  const reasoning = (message as Record<string, unknown>).reasoning_content;
  if (typeof reasoning !== "string" || reasoning.trim().length === 0) {
    throw new LlmResponseFormatError("response_shape");
  }
  return reasoning;
}

/**
 * 配置加载不是唯一入口；实验和测试也可以直接调用 chatComplete。
 * 因此在发起任何可能计费的请求前重新检查组合，不依赖 TypeScript
 * 类型或 config/models.yaml 已经跑过。
 */
function validateThinkingRequest(spec: ModelCallSpec): void {
  const isAetherV4 =
    spec.provider === "aether" &&
    (spec.model === "deepseek-v4-flash" || spec.model === "deepseek-v4-pro");
  if (isAetherV4) {
    if (spec.thinkingRequest !== "enabled") {
      throw new TypeError("Aether deepseek-v4-flash/pro 必须配置 thinkingRequest: enabled。");
    }
    if (spec.reasoningEffort !== "max") {
      throw new TypeError("Aether deepseek-v4-flash/pro 必须配置 reasoningEffort: max。");
    }
  } else {
    if (spec.thinkingRequest !== undefined) {
      throw new TypeError("当前模型不允许显式配置深度思考。");
    }
    if (spec.reasoningEffort !== undefined) {
      throw new TypeError("当前模型不允许配置推理强度。");
    }
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
  const { receipt: _receipt, ...result } = await chatCompleteJsonWithReceipt(
    provider,
    spec,
    messages,
    schema,
    runtime,
    options
  );
  return result;
}

/** JSON 输出的可信变体；receipt 同时绑定修复轮数、HTTP 尝试数和 schema 成功。 */
export async function chatCompleteJsonWithReceipt<T>(
  provider: ProviderCredentialsLike,
  spec: ModelCallSpec,
  messages: ChatMessage[],
  schema: z.ZodType<T>,
  runtime: LlmRuntimeOptions,
  options: ChatCompletionJsonOptions = {}
): Promise<{ data: T; reasoning: string | null; receipt: LlmJsonCompletionReceipt }> {
  const jsonInstruction: ChatMessage = {
    role: "system",
    content: "只输出一个满足要求的 JSON 对象本身，不要输出任何解释、前后缀文字，也不要用 Markdown 代码块包裹。"
  };
  const roleMessages = runtime.directStructuredOutput === true
    ? directStructuredMessages(messages, schema)
    : messages;
  const firstMessages: ChatMessage[] = [jsonInstruction, ...roleMessages];
  // 当前接入的网关并不都正确支持 response_format。直接用提示词约束 JSON，
  // 避免先付费生成一次空 content，再为了探测兼容性重复发送完整题目。
  let first: ChatCompletionWithReceipt;
  try {
    first = await chatCompleteWithReceipt(provider, spec, firstMessages, runtime, {
      requestJson: false,
      maxOutputTokens: options.maxOutputTokens
    });
    assertStructuredCompletionTransport(first.receipt);
  } catch (error) {
    promoteJsonFailureAudit(error, 1, [], 0);
    throw error;
  }
  const firstAttempt = tryParseAndValidate(first.content, schema, options.safeSchemaDiagnostic);
  if (firstAttempt.success) {
    return {
      data: firstAttempt.data,
      reasoning: first.reasoning,
      receipt: {
        schemaVersion: 2,
        requestCount: 1,
        transportAttemptCount: first.receipt.transportAttemptCount,
        eofVerified: true,
        jsonSchemaValidated: true,
        responses: [first.receipt]
      }
    };
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
  let second: ChatCompletionWithReceipt;
  try {
    second = await chatCompleteWithReceipt(provider, spec, repairMessages, runtime, {
      requestJson: false,
      maxOutputTokens: options.maxOutputTokens
    });
    assertStructuredCompletionTransport(second.receipt);
  } catch (error) {
    promoteJsonFailureAudit(
      error,
      2,
      [first.receipt],
      first.receipt.transportAttemptCount
    );
    throw error;
  }
  const secondAttempt = tryParseAndValidate(second.content, schema, options.safeSchemaDiagnostic);
  if (secondAttempt.success) {
    return {
      data: secondAttempt.data,
      reasoning: second.reasoning ?? first.reasoning,
      receipt: {
        schemaVersion: 2,
        requestCount: 2,
        transportAttemptCount:
          first.receipt.transportAttemptCount + second.receipt.transportAttemptCount,
        eofVerified: true,
        jsonSchemaValidated: true,
        responses: [first.receipt, second.receipt]
      }
    };
  }

  const error = new LlmJsonOutputError();
  rememberLlmFailureAudit(error, {
    requestCount: 2,
    requestAudit: mutableAuditFromReceipt(second.receipt),
    completedResponses: [first.receipt, second.receipt],
    priorTransportAttemptCount: first.receipt.transportAttemptCount,
    jsonSchemaValidated: false,
    schemaDiagnostic: secondAttempt.schemaDiagnostic
  });
  throw error;
}

function stableJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonSchema);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJsonSchema(entry)])
  );
}

export function serializeTargetJsonSchema<T>(schema: z.ZodType<T>): string {
  return JSON.stringify(stableJsonSchema(z.toJSONSchema(schema)), null, 2);
}

function directStructuredMessages<T>(
  semanticMessages: readonly ChatMessage[],
  schema: z.ZodType<T>
): ChatMessage[] {
  const withoutContradictions = semanticMessages.map((message) => ({
    ...message,
    content: message.content
      .replace(
        /(?:先完整判断，)?(?:不(?:要)?输出|不需要)\s*JSON(?:\s*格式)?[。；;]?/giu,
        ""
      )
      .replace(/Do not output JSON[.!;]?/giu, "")
      .trim()
  }));
  return [
    ...withoutContradictions,
    {
      role: "system",
      content: [
        "在保留上述角色审题要求的同时，本次调用直接生成结构化结论。",
        "只输出一个满足下列完整 JSON Schema 的 JSON 对象本身；不要输出解释、前后缀或 Markdown 代码块。",
        "完整 JSON Schema：",
        serializeTargetJsonSchema(schema)
      ].join("\n")
    }
  ];
}

/**
 * 为 phase2 结构化提取/修复轮派生专用规格：清除 max-thinking 请求字段，
 * 让格式轮以兼容模式输出满足 schema 的 JSON，避免推理链与强制 JSON 争用
 * 同一调用的输出预算。provider 凭据经由独立的 provider 参数传入，因此清空
 * spec.provider 只改变请求校验分支，不改变传输目标。
 */
function derivedStructuredExtractionSpec(spec: ModelCallSpec): ModelCallSpec {
  return {
    ...spec,
    provider: undefined,
    thinking: false,
    thinkingRequest: undefined,
    reasoningEffort: undefined
  };
}
function strictSchemaOutputOption<T>(schema: z.ZodType<T>): ChatCompletionOptions {
  return {
    responseJsonSchema: {
      name: "fermata_review_flow_role_v1",
      schema: z.toJSONSchema(schema) as Readonly<Record<string, unknown>>
    }
  };
}


/**
 * 两轮 JSON 设计的可选轮次审计回调。只用于透明观测（例如为每个轮次单独记录
 * 首次有效输出时间与传输证据），不改变提示词、模型配置、schema 或失败语义。
 */
export interface TwoRoundJsonRoundAudit {
  /** 每一轮（语义 / 格式 / 格式修复）真正发起传输前调用。 */
  readonly onRoundStart: (round: "semantic" | "format" | "format_repair") => void;
  /** 该轮传输完成且通过传输级校验后调用；轮次失败时不调用。 */
  readonly onRoundSettled: (
    round: "semantic" | "format" | "format_repair",
    receipt: LlmTransportReceipt
  ) => void;
}

/**
 * 两轮 JSON 设计：第一轮让模型用自然语言完成语义判断（不强制 JSON），
 * 第二轮只做格式化——把第一轮的文本转换为满足 schema 的 JSON，不重新判断。
 * 两轮都使用相同的模型配置（含 thinking/reasoning_effort）。
 * 适用于 thinking=max 时模型推理 token 量大、与 JSON 输出争用 max_tokens 的情况。
 */
export async function chatCompleteTwoRoundJsonWithReceipt<T>(
  provider: ProviderCredentialsLike,
  spec: ModelCallSpec,
  semanticMessages: ChatMessage[],
  formatterMessages: (semanticOutput: string, semanticReasoning: string | null) => ChatMessage[],
  schema: z.ZodType<T>,
  runtime: LlmRuntimeOptions,
  options: ChatCompletionJsonOptions = {},
  roundAudit?: TwoRoundJsonRoundAudit
): Promise<{ data: T; reasoning: string | null; receipt: LlmJsonCompletionReceipt }> {
  if (runtime.directStructuredOutput === true) {
    return chatCompleteJsonWithReceipt(
      provider,
      spec,
      semanticMessages,
      schema,
      runtime,
      options
    );
  }
  let semantic: ChatCompletionWithReceipt;
  roundAudit?.onRoundStart("semantic");
  try {
    semantic = await chatCompleteWithReceipt(provider, spec, semanticMessages, runtime, {
      requestJson: false,
      maxOutputTokens: options.maxOutputTokens
    });
    assertStructuredCompletionTransport(semantic.receipt);
  } catch (error) {
    promoteJsonFailureAudit(error, 1, [], 0);
    throw error;
  }
  roundAudit?.onRoundSettled("semantic", semantic.receipt);

  const formatMessages = formatterMessages(semantic.content, semantic.reasoning);
  const jsonInstruction: ChatMessage = {
    role: "system",
    content: "只输出一个满足要求的 JSON 对象本身，不要输出任何解释、前后缀文字，也不要用 Markdown 代码块包裹。"
  };
  const firstFormatMessages: ChatMessage[] = [jsonInstruction, ...formatMessages];
  let firstFormat: ChatCompletionWithReceipt;
  roundAudit?.onRoundStart("format");
  const extractionSpec = derivedStructuredExtractionSpec(spec);
  try {
    firstFormat = await chatCompleteWithReceipt(provider, extractionSpec, firstFormatMessages, runtime, {
      ...strictSchemaOutputOption(schema),
      maxOutputTokens: options.maxOutputTokens
    });
    assertStructuredCompletionTransport(firstFormat.receipt);
  } catch (error) {
    promoteJsonFailureAudit(error, 2, [semantic.receipt], semantic.receipt.transportAttemptCount);
    throw error;
  }
  roundAudit?.onRoundSettled("format", firstFormat.receipt);
  const firstAttempt = tryParseAndValidate(firstFormat.content, schema, options.safeSchemaDiagnostic);
  if (firstAttempt.success) {
    return {
      data: firstAttempt.data,
      reasoning: semantic.reasoning ?? firstFormat.reasoning,
      receipt: {
        schemaVersion: 2,
        requestCount: 2,
        transportAttemptCount:
          semantic.receipt.transportAttemptCount + firstFormat.receipt.transportAttemptCount,
        eofVerified: true,
        jsonSchemaValidated: true,
        responses: [semantic.receipt, firstFormat.receipt]
      }
    };
  }

  const repairMessages: ChatMessage[] = [
    ...firstFormatMessages,
    { role: "assistant", content: firstFormat.content },
    {
      role: "user",
      content: `上一条回复不满足要求：${firstAttempt.error}。请只重新输出一个满足要求的 JSON 对象，不要包含任何其它文字或代码块标记。`
    }
  ];
  let secondFormat: ChatCompletionWithReceipt;
  roundAudit?.onRoundStart("format_repair");
  try {
    secondFormat = await chatCompleteWithReceipt(provider, extractionSpec, repairMessages, runtime, {
      ...strictSchemaOutputOption(schema),
      maxOutputTokens: options.maxOutputTokens
    });
    assertStructuredCompletionTransport(secondFormat.receipt);
  } catch (error) {
    promoteJsonFailureAudit(
      error, 3,
      [semantic.receipt, firstFormat.receipt],
      semantic.receipt.transportAttemptCount + firstFormat.receipt.transportAttemptCount
    );
    throw error;
  }
  roundAudit?.onRoundSettled("format_repair", secondFormat.receipt);
  const secondAttempt = tryParseAndValidate(secondFormat.content, schema, options.safeSchemaDiagnostic);
  if (secondAttempt.success) {
    return {
      data: secondAttempt.data,
      reasoning: semantic.reasoning ?? firstFormat.reasoning ?? secondFormat.reasoning,
      receipt: {
        schemaVersion: 2,
        requestCount: 3,
        transportAttemptCount:
          semantic.receipt.transportAttemptCount +
          firstFormat.receipt.transportAttemptCount +
          secondFormat.receipt.transportAttemptCount,
        eofVerified: true,
        jsonSchemaValidated: true,
        responses: [semantic.receipt, firstFormat.receipt, secondFormat.receipt]
      }
    };
  }

  const error = new LlmJsonOutputError();
  rememberLlmFailureAudit(error, {
    requestCount: 3,
    requestAudit: mutableAuditFromReceipt(secondFormat.receipt),
    completedResponses: [semantic.receipt, firstFormat.receipt, secondFormat.receipt],
    priorTransportAttemptCount:
      semantic.receipt.transportAttemptCount + firstFormat.receipt.transportAttemptCount,
    jsonSchemaValidated: false,
    schemaDiagnostic: secondAttempt.schemaDiagnostic
  });
  throw error;
}

/**
 * reasoning salvage JSON 设计：分析轮使用 Pro 模型（salvage 启用），
 * 如果 finish_reason="length" 且 reasoning 非空、content 为空，则把完整
 * reasoning 传给独立 finalizer 阶段（finalizationSpec，通常为 Flash），
 * 由 finalizer 提取满足 schema 的结构化 JSON。finalizer 不会重新推理，
 * 只做信息提取和格式转换。如果分析轮正常完成（finish_reason="stop"），
 * 则走原有两轮路径（语义→格式），salvage 不生效。
 *
 * 该函数返回的 receipt 是 LlmJsonCompletionReceipt（正常路径）或
 * LlmReasoningSalvageJsonReceipt（抢救路径）的联合类型。调用方通过
 * `"analysisSalvaged" in result.receipt` 区分两条路径。
 *
 * 隐私保证：原始 reasoning 仅在内存中从分析轮传递给 finalizer，
 * 不写入 receipt、日志、错误消息或磁盘。receipt 只含安全计数。
 */
export async function chatCompleteReasoningSalvageJsonWithReceipt<T>(
  provider: ProviderCredentialsLike,
  analysisSpec: ModelCallSpec,
  finalizationSpec: ModelCallSpec,
  analysisMessages: ChatMessage[],
  finalizationMessages: (text: string, reasoning: string | null) => ChatMessage[],
  schema: z.ZodType<T>,
  runtime: LlmRuntimeOptions,
  options: ChatCompletionJsonOptions = {},
  roundAudit?: TwoRoundJsonRoundAudit & {
    readonly onSalvageFinalizationStart?: () => void;
    readonly onSalvageFinalizationSettled?: (receipt: LlmTransportReceipt) => void;
    readonly onSalvageFinalizationRepairStart?: () => void;
    readonly onSalvageFinalizationRepairSettled?: (receipt: LlmTransportReceipt) => void;
  }
): Promise<{
  data: T;
  reasoning: string | null;
  receipt: LlmJsonCompletionReceipt | LlmReasoningSalvageJsonReceipt;
}> {
  if (runtime.directStructuredOutput === true) {
    return chatCompleteTwoRoundJsonWithReceipt(
      provider,
      analysisSpec,
      analysisMessages,
      finalizationMessages,
      schema,
      runtime,
      options,
      roundAudit
    );
  }
  // 分析轮：启用 salvage，自由文本，不强制 JSON。
  roundAudit?.onRoundStart("semantic");
  const analysis = await chatCompleteSalvageableWithReceipt(
    provider,
    analysisSpec,
    analysisMessages,
    runtime,
    {
      requestJson: false,
      maxOutputTokens: options.maxOutputTokens
    }
  );
  if (!analysis.salvaged) {
    // 正常路径：分析轮以 finish_reason="stop" 完成，走原有两轮格式化。
    // 复用 chatCompleteTwoRoundJsonWithReceipt 的格式轮逻辑，但跳过语义轮。
    // 为保持与两轮 receipt 一致，这里直接内联格式轮 + 修复轮。
    if (analysis.receipt.finishReasonStopVerified !== true) {
      const error = new LlmResponseFormatError("response_shape");
      rememberLlmFailureAudit(error, {
        requestCount: 1,
        requestAudit: mutableAuditFromReceipt(analysis.receipt),
        jsonSchemaValidated: false
      });
      throw error;
    }
    roundAudit?.onRoundSettled("semantic", analysis.receipt);
    return runTwoRoundFormatPath(
      provider,
      analysisSpec,
      analysis.content,
      analysis.reasoning,
      finalizationMessages,
      schema,
      runtime,
      options,
      analysis.receipt,
      roundAudit
    );
  }
  // 抢救路径：分析轮 finish_reason="length"，reasoning 非空，content 为空。
  // 把完整 reasoning 传给 finalizer（Flash），由它提取结构化 JSON。
  // 不调用 roundAudit.onRoundSettled("semantic", ...)，因为 analysis receipt
  // 是 LlmSalvageTransportReceipt 而非 LlmTransportReceipt。
  const finalizationInput = finalizationMessages(analysis.reasoning, null);
  const jsonInstruction: ChatMessage = {
    role: "system",
    content: "只输出一个满足要求的 JSON 对象本身，不要输出任何解释、前后缀文字，也不要用 Markdown 代码块包裹。"
  };
  const firstFinalMessages: ChatMessage[] = [jsonInstruction, ...finalizationInput];
  let firstFinal: ChatCompletionWithReceipt;
  roundAudit?.onSalvageFinalizationStart?.();
  try {
    firstFinal = await chatCompleteWithReceipt(
      provider,
      finalizationSpec,
      firstFinalMessages,
      runtime,
      {
        ...strictSchemaOutputOption(schema),
        maxOutputTokens: options.maxOutputTokens
      }
    );
    assertStructuredCompletionTransport(firstFinal.receipt);
  } catch (error) {
    promoteJsonFailureAudit(
      error,
      2,
      [],
      0
    );
    throw error;
  }
  roundAudit?.onSalvageFinalizationSettled?.(firstFinal.receipt);
  const firstAttempt = tryParseAndValidate(firstFinal.content, schema);
  if (firstAttempt.success) {
    return {
      data: firstAttempt.data,
      reasoning: null,
      receipt: {
        schemaVersion: 2,
        analysisSalvaged: true,
        requestCount: 2,
        transportAttemptCount:
          analysis.receipt.transportAttemptCount + firstFinal.receipt.transportAttemptCount,
        eofVerified: true,
        jsonSchemaValidated: true,
        responses: [analysis.receipt, firstFinal.receipt]
      }
    };
  }
  // finalizer 修复轮
  const repairMessages: ChatMessage[] = [
    ...firstFinalMessages,
    { role: "assistant", content: firstFinal.content },
    {
      role: "user",
      content: `上一条回复不满足要求：${firstAttempt.error}。请只重新输出一个满足要求的 JSON 对象，不要包含任何其它文字或代码块标记。`
    }
  ];
  let secondFinal: ChatCompletionWithReceipt;
  roundAudit?.onSalvageFinalizationRepairStart?.();
  try {
    secondFinal = await chatCompleteWithReceipt(
      provider,
      finalizationSpec,
      repairMessages,
      runtime,
      {
        ...strictSchemaOutputOption(schema),
        maxOutputTokens: options.maxOutputTokens
      }
    );
    assertStructuredCompletionTransport(secondFinal.receipt);
  } catch (error) {
    promoteJsonFailureAudit(
      error,
      3,
      [firstFinal.receipt],
      firstFinal.receipt.transportAttemptCount
    );
    throw error;
  }
  roundAudit?.onSalvageFinalizationRepairSettled?.(secondFinal.receipt);
  const secondAttempt = tryParseAndValidate(secondFinal.content, schema);
  if (secondAttempt.success) {
    return {
      data: secondAttempt.data,
      reasoning: null,
      receipt: {
        schemaVersion: 2,
        analysisSalvaged: true,
        requestCount: 3,
        transportAttemptCount:
          analysis.receipt.transportAttemptCount +
          firstFinal.receipt.transportAttemptCount +
          secondFinal.receipt.transportAttemptCount,
        eofVerified: true,
        jsonSchemaValidated: true,
        responses: [analysis.receipt, firstFinal.receipt, secondFinal.receipt]
      }
    };
  }
  const error = new LlmJsonOutputError();
  rememberLlmFailureAudit(error, {
    requestCount: 3,
    requestAudit: mutableAuditFromReceipt(secondFinal.receipt),
    completedResponses: [firstFinal.receipt, secondFinal.receipt],
    priorTransportAttemptCount: firstFinal.receipt.transportAttemptCount,
    jsonSchemaValidated: false
  });
  throw error;
}

/**
 * 正常两轮路径的格式轮 + 修复轮，从已完成的语义轮结果继续。
 * 与 chatCompleteTwoRoundJsonWithReceipt 的格式部分逻辑一致，
 * 但跳过语义轮（已完成），直接用 semanticOutput/semanticReasoning 构造格式轮消息。
 */
async function runTwoRoundFormatPath<T>(
  provider: ProviderCredentialsLike,
  spec: ModelCallSpec,
  semanticOutput: string,
  semanticReasoning: string | null,
  formatterMessages: (semanticOutput: string, semanticReasoning: string | null) => ChatMessage[],
  schema: z.ZodType<T>,
  runtime: LlmRuntimeOptions,
  options: ChatCompletionJsonOptions,
  semanticReceipt: LlmTransportReceipt,
  roundAudit?: TwoRoundJsonRoundAudit
): Promise<{ data: T; reasoning: string | null; receipt: LlmJsonCompletionReceipt }> {
  const formatMessages = formatterMessages(semanticOutput, semanticReasoning);
  const jsonInstruction: ChatMessage = {
    role: "system",
    content: "只输出一个满足要求的 JSON 对象本身，不要输出任何解释、前后缀文字，也不要用 Markdown 代码块包裹。"
  };
  const firstFormatMessages: ChatMessage[] = [jsonInstruction, ...formatMessages];
  let firstFormat: ChatCompletionWithReceipt;
  roundAudit?.onRoundStart("format");
  const extractionSpec = derivedStructuredExtractionSpec(spec);
  try {
    firstFormat = await chatCompleteWithReceipt(provider, extractionSpec, firstFormatMessages, runtime, {
      ...strictSchemaOutputOption(schema),
      maxOutputTokens: options.maxOutputTokens
    });
    assertStructuredCompletionTransport(firstFormat.receipt);
  } catch (error) {
    promoteJsonFailureAudit(error, 2, [semanticReceipt], semanticReceipt.transportAttemptCount);
    throw error;
  }
  roundAudit?.onRoundSettled("format", firstFormat.receipt);
  const firstAttempt = tryParseAndValidate(firstFormat.content, schema);
  if (firstAttempt.success) {
    return {
      data: firstAttempt.data,
      reasoning: semanticReasoning ?? firstFormat.reasoning,
      receipt: {
        schemaVersion: 2,
        requestCount: 2,
        transportAttemptCount:
          semanticReceipt.transportAttemptCount + firstFormat.receipt.transportAttemptCount,
        eofVerified: true,
        jsonSchemaValidated: true,
        responses: [semanticReceipt, firstFormat.receipt]
      }
    };
  }
  const repairMessages: ChatMessage[] = [
    ...firstFormatMessages,
    { role: "assistant", content: firstFormat.content },
    {
      role: "user",
      content: `上一条回复不满足要求：${firstAttempt.error}。请只重新输出一个满足要求的 JSON 对象，不要包含任何其它文字或代码块标记。`
    }
  ];
  let secondFormat: ChatCompletionWithReceipt;
  roundAudit?.onRoundStart("format_repair");
  try {
    secondFormat = await chatCompleteWithReceipt(provider, extractionSpec, repairMessages, runtime, {
      ...strictSchemaOutputOption(schema),
      maxOutputTokens: options.maxOutputTokens
    });
    assertStructuredCompletionTransport(secondFormat.receipt);
  } catch (error) {
    promoteJsonFailureAudit(
      error, 3,
      [semanticReceipt, firstFormat.receipt],
      semanticReceipt.transportAttemptCount + firstFormat.receipt.transportAttemptCount
    );
    throw error;
  }
  roundAudit?.onRoundSettled("format_repair", secondFormat.receipt);
  const secondAttempt = tryParseAndValidate(secondFormat.content, schema);
  if (secondAttempt.success) {
    return {
      data: secondAttempt.data,
      reasoning: semanticReasoning ?? firstFormat.reasoning ?? secondFormat.reasoning,
      receipt: {
        schemaVersion: 2,
        requestCount: 3,
        transportAttemptCount:
          semanticReceipt.transportAttemptCount +
          firstFormat.receipt.transportAttemptCount +
          secondFormat.receipt.transportAttemptCount,
        eofVerified: true,
        jsonSchemaValidated: true,
        responses: [semanticReceipt, firstFormat.receipt, secondFormat.receipt]
      }
    };
  }
  const error = new LlmJsonOutputError();
  rememberLlmFailureAudit(error, {
    requestCount: 3,
    requestAudit: mutableAuditFromReceipt(secondFormat.receipt),
    completedResponses: [semanticReceipt, firstFormat.receipt, secondFormat.receipt],
    priorTransportAttemptCount:
      semanticReceipt.transportAttemptCount + firstFormat.receipt.transportAttemptCount,
    jsonSchemaValidated: false
  });
  throw error;
}

/**
 * 三段式 solver：探索轮（只识别问题结构并锁定一条方向，不求解）、综合轮（沿给定方向
 * 推导完整解法，不重新探索）、格式化轮（只做 schema 转换，不重新判断）。每轮都是独立
 * 调用，因此 thinking=max 的推理 token 预算按轮分配，避免单个调用同时容纳超长推理链
 * 与结构化输出而触顶 max_tokens。失败路径与两轮设计一致：任一前轮失败即按已发生轮次
 * 升级审计；格式化轮可触发一轮修复。
 */
export async function chatCompleteStagedSolverJsonWithReceipt<T>(
  provider: ProviderCredentialsLike,
  spec: ModelCallSpec,
  explorationMessages: ChatMessage[],
  synthesisMessages: (
    explorationOutput: string,
    explorationReasoning: string | null
  ) => ChatMessage[],
  formatterMessages: (
    synthesisOutput: string,
    synthesisReasoning: string | null
  ) => ChatMessage[],
  schema: z.ZodType<T>,
  runtime: LlmRuntimeOptions,
  options: ChatCompletionJsonOptions = {}
): Promise<{ data: T; reasoning: string | null; receipt: LlmJsonCompletionReceipt }> {
  if (runtime.directStructuredOutput === true) {
    let exploration: ChatCompletionWithReceipt;
    try {
      exploration = await chatCompleteWithReceipt(
        provider, spec, explorationMessages, runtime, {
          requestJson: false,
          maxOutputTokens: options.maxOutputTokens
        }
      );
      assertStructuredCompletionTransport(exploration.receipt);
    } catch (error) {
      promoteJsonFailureAudit(error, 1, [], 0);
      throw error;
    }
    try {
      const synthesis = await chatCompleteJsonWithReceipt(
        provider,
        spec,
        synthesisMessages(exploration.content, exploration.reasoning),
        schema,
        runtime,
        options
      );
      const responses = synthesis.receipt.responses.length === 1
        ? [exploration.receipt, synthesis.receipt.responses[0]] as const
        : [
            exploration.receipt,
            synthesis.receipt.responses[0],
            synthesis.receipt.responses[1]
          ] as const;
      return {
        data: synthesis.data,
        reasoning: exploration.reasoning ?? synthesis.reasoning,
        receipt: {
          schemaVersion: 2,
          requestCount: responses.length,
          transportAttemptCount:
            exploration.receipt.transportAttemptCount +
            synthesis.receipt.transportAttemptCount,
          eofVerified: true,
          jsonSchemaValidated: true,
          responses
        }
      };
    } catch (error) {
      const audit = getLlmFailureAudit(error);
      const completedResponses = [
        exploration.receipt,
        ...(audit?.completedResponses ?? [])
      ];
      const nestedCompletedTransportAttemptCount =
        audit?.completedResponses.reduce(
          (sum, receipt) => sum + receipt.transportAttemptCount,
          0
        ) ?? 0;
      promoteJsonFailureAudit(
        error,
        audit?.requestCount === 2 ? 3 : 2,
        completedResponses,
        exploration.receipt.transportAttemptCount +
          nestedCompletedTransportAttemptCount
      );
      throw error;
    }
  }
  const semanticRunOptions = {
    requestJson: false,
    maxOutputTokens: options.maxOutputTokens
  };

  let exploration: ChatCompletionWithReceipt;
  try {
    exploration = await chatCompleteWithReceipt(
      provider, spec, explorationMessages, runtime, semanticRunOptions
    );
    assertStructuredCompletionTransport(exploration.receipt);
  } catch (error) {
    promoteJsonFailureAudit(error, 1, [], 0);
    throw error;
  }

  let synthesis: ChatCompletionWithReceipt;
  try {
    synthesis = await chatCompleteWithReceipt(
      provider,
      spec,
      synthesisMessages(exploration.content, exploration.reasoning),
      runtime,
      semanticRunOptions
    );
    assertStructuredCompletionTransport(synthesis.receipt);
  } catch (error) {
    promoteJsonFailureAudit(
      error, 2,
      [exploration.receipt],
      exploration.receipt.transportAttemptCount
    );
    throw error;
  }

  const formatMessages = formatterMessages(synthesis.content, synthesis.reasoning);
  const jsonInstruction: ChatMessage = {
    role: "system",
    content: "只输出一个满足要求的 JSON 对象本身，不要输出任何解释、前后缀文字，也不要用 Markdown 代码块包裹。"
  };
  const firstFormatMessages: ChatMessage[] = [jsonInstruction, ...formatMessages];
  let firstFormat: ChatCompletionWithReceipt;
  try {
    firstFormat = await chatCompleteWithReceipt(
      provider, spec, firstFormatMessages, runtime, {
        ...strictSchemaOutputOption(schema),
        maxOutputTokens: options.maxOutputTokens
      }
    );
    assertStructuredCompletionTransport(firstFormat.receipt);
  } catch (error) {
    promoteJsonFailureAudit(
      error, 3,
      [exploration.receipt, synthesis.receipt],
      exploration.receipt.transportAttemptCount + synthesis.receipt.transportAttemptCount
    );
    throw error;
  }
  const firstAttempt = tryParseAndValidate(firstFormat.content, schema);
  if (firstAttempt.success) {
    return {
      data: firstAttempt.data,
      reasoning: exploration.reasoning ?? synthesis.reasoning ?? firstFormat.reasoning,
      receipt: {
        schemaVersion: 2,
        requestCount: 3,
        transportAttemptCount:
          exploration.receipt.transportAttemptCount +
          synthesis.receipt.transportAttemptCount +
          firstFormat.receipt.transportAttemptCount,
        eofVerified: true,
        jsonSchemaValidated: true,
        responses: [exploration.receipt, synthesis.receipt, firstFormat.receipt]
      }
    };
  }

  const repairMessages: ChatMessage[] = [
    ...firstFormatMessages,
    { role: "assistant", content: firstFormat.content },
    {
      role: "user",
      content: `上一条回复不满足要求：${firstAttempt.error}。请只重新输出一个满足要求的 JSON 对象，不要包含任何其它文字或代码块标记。`
    }
  ];
  let secondFormat: ChatCompletionWithReceipt;
  try {
    secondFormat = await chatCompleteWithReceipt(
      provider, spec, repairMessages, runtime, {
        ...strictSchemaOutputOption(schema),
        maxOutputTokens: options.maxOutputTokens
      }
    );
    assertStructuredCompletionTransport(secondFormat.receipt);
  } catch (error) {
    promoteJsonFailureAudit(
      error, 4,
      [exploration.receipt, synthesis.receipt, firstFormat.receipt],
      exploration.receipt.transportAttemptCount +
        synthesis.receipt.transportAttemptCount +
        firstFormat.receipt.transportAttemptCount
    );
    throw error;
  }
  const secondAttempt = tryParseAndValidate(secondFormat.content, schema);
  if (secondAttempt.success) {
    return {
      data: secondAttempt.data,
      reasoning:
        exploration.reasoning ??
        synthesis.reasoning ??
        firstFormat.reasoning ??
        secondFormat.reasoning,
      receipt: {
        schemaVersion: 2,
        requestCount: 4,
        transportAttemptCount:
          exploration.receipt.transportAttemptCount +
          synthesis.receipt.transportAttemptCount +
          firstFormat.receipt.transportAttemptCount +
          secondFormat.receipt.transportAttemptCount,
        eofVerified: true,
        jsonSchemaValidated: true,
        responses: [
          exploration.receipt,
          synthesis.receipt,
          firstFormat.receipt,
          secondFormat.receipt
        ]
      }
    };
  }

  const error = new LlmJsonOutputError();
  rememberLlmFailureAudit(error, {
    requestCount: 4,
    requestAudit: mutableAuditFromReceipt(secondFormat.receipt),
    completedResponses: [
      exploration.receipt,
      synthesis.receipt,
      firstFormat.receipt,
      secondFormat.receipt
    ],
    priorTransportAttemptCount:
      exploration.receipt.transportAttemptCount +
      synthesis.receipt.transportAttemptCount +
      firstFormat.receipt.transportAttemptCount,
    jsonSchemaValidated: false
  });
  throw error;
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

type ParseResult<T> =
  | { readonly success: true; readonly data: T }
  | {
      readonly success: false;
      readonly error: string;
      readonly schemaDiagnostic?: SafeSchemaDiagnostic;
    };

function normalizeOriginalitySchemaIssue(issue: z.ZodIssue): SafeSchemaDiagnostic {
  const firstPathSegment = issue.path[0];
  let path: SafeSchemaDiagnosticPath = "/";
  let expectedCategory: SafeSchemaDiagnosticCategory = "exact_key_set";
  if (issue.path.length === 1 && firstPathSegment === "originalityLevel") {
    path = "/originalityLevel";
    expectedCategory = "level_1_5";
  } else if (issue.path.length === 1 && firstPathSegment === "sameProblemAsExisting") {
    path = "/sameProblemAsExisting";
    expectedCategory = "boolean";
  } else if (issue.path.length === 1 && firstPathSegment === "highestSimilarity") {
    path = "/highestSimilarity";
    expectedCategory = "number_0_1";
  } else if (firstPathSegment === "evidenceIds") {
    path = issue.path.length === 1 ? "/evidenceIds" : "/evidenceIds/*";
    expectedCategory = "safe_id_array";
  } else if (issue.path.length === 1 && firstPathSegment === "rationale") {
    path = "/rationale";
    expectedCategory = "short_text";
  }
  return Object.freeze({ code: issue.code, path, expectedCategory });
}

function tryParseAndValidate<T>(
  content: string,
  schema: z.ZodType<T>,
  safeSchemaDiagnostic?: ChatCompletionJsonOptions["safeSchemaDiagnostic"]
): ParseResult<T> {
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
    const issue = parsed.error.issues[0];
    const schemaDiagnostic =
      safeSchemaDiagnostic === "originality" && issue !== undefined
        ? normalizeOriginalitySchemaIssue(issue)
        : undefined;
    return {
      success: false,
      error: parsed.error.message,
      ...(schemaDiagnostic === undefined ? {} : { schemaDiagnostic })
    };
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

interface MutableLlmRequestAudit {
  attemptCount: number;
  status: number | null;
  responseMode: LlmResponseMode | null;
  eofObserved: boolean;
  finishReason: LlmSseFinishReasonClass | null;
  finishReasonStopObserved: boolean;
  sseDoneObserved: boolean | null;
  streamEventCount: number;
  acceptedEventShapeCounts: Map<string, {
    readonly category: LlmSseAcceptedShapeCategory;
    readonly shapeFingerprint: string;
    count: number;
  }>;
  streamUtf8Bytes: number;
  streamChunkCount: number;
  usageEventCount: number;
  usageTotalTokens: number | null;
  firstRejectedEvent: LlmSseRejectedEventAudit | null;
  maxOutputTokens: number | null;
}

function createMutableLlmRequestAudit(
  maxOutputTokens: number | null = null
): MutableLlmRequestAudit {
  return {
    attemptCount: 0,
    status: null,
    responseMode: null,
    eofObserved: false,
    finishReason: null,
    finishReasonStopObserved: false,
    sseDoneObserved: null,
    streamEventCount: 0,
    acceptedEventShapeCounts: new Map(),
    streamUtf8Bytes: 0,
    streamChunkCount: 0,
    usageEventCount: 0,
    usageTotalTokens: null,
    firstRejectedEvent: null,
    maxOutputTokens
  };
}

function resetMutableLlmRequestAuditForAttempt(
  audit: MutableLlmRequestAudit
): void {
  audit.status = null;
  audit.responseMode = null;
  audit.eofObserved = false;
  audit.finishReason = null;
  audit.finishReasonStopObserved = false;
  audit.sseDoneObserved = null;
  audit.streamEventCount = 0;
  audit.streamUtf8Bytes = 0;
  audit.acceptedEventShapeCounts.clear();
  audit.streamChunkCount = 0;
  audit.usageEventCount = 0;
  audit.usageTotalTokens = null;
  audit.firstRejectedEvent = null;
}

function mutableLlmTransportAudit(
  audit: MutableLlmRequestAudit
): LlmTransportAudit {
  return {
    providerRequestCount: audit.attemptCount,
    retryCount: Math.max(0, audit.attemptCount - 1),
    responseByteCount: audit.streamUtf8Bytes,
    usageTotalTokens: audit.usageTotalTokens,
    usageComplete: audit.usageEventCount > 0,
    maxOutputTokens: audit.maxOutputTokens,
    finishReason: audit.finishReason,
    eofObserved: audit.eofObserved,
    finishReasonStopObserved: audit.finishReasonStopObserved,
    sseDoneObserved: audit.sseDoneObserved
  };
}

function rememberLlmFailureAudit(
  error: unknown,
  input: {
    readonly requestCount: 1 | 2 | 3 | 4;
    readonly requestAudit: MutableLlmRequestAudit;
    readonly completedResponses?: readonly LlmTransportReceipt[];
    readonly priorTransportAttemptCount?: number;
    readonly jsonSchemaValidated: false | null;
    readonly schemaDiagnostic?: SafeSchemaDiagnostic;
  }
): void {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return;
  }
  const sourceResponses = input.completedResponses ?? [];
  const completedAudits = sourceResponses.map(getLlmTransportAudit);
  const completedAuditsKnown = completedAudits.every((audit) => audit !== null);
  const terminalAudit = mutableLlmTransportAudit(input.requestAudit);
  const terminalAlreadyCompleted = sourceResponses.length === input.requestCount;
  const aggregateAudits = completedAuditsKnown
    ? [
        ...(completedAudits as LlmTransportAudit[]),
        ...(terminalAlreadyCompleted ? [] : [terminalAudit])
      ]
    : [terminalAudit];
  const usageValues = aggregateAudits.flatMap((audit) =>
    audit.usageTotalTokens === null ? [] : [audit.usageTotalTokens]
  );
  const maxOutputTokens = aggregateAudits[0]?.maxOutputTokens ?? null;
  const completedResponses = sourceResponses.map((receipt) =>
    Object.freeze({ ...receipt })
  );
  const terminal = Object.freeze({
    status: input.requestAudit.status,
    responseMode: input.requestAudit.responseMode,
    eofObserved: input.requestAudit.eofObserved,
    finishReason: input.requestAudit.finishReason,
    finishReasonStopObserved: input.requestAudit.finishReasonStopObserved,
    sseDoneObserved: input.requestAudit.sseDoneObserved
  });
  const stream = Object.freeze({
    eventCount: input.requestAudit.streamEventCount,
    utf8Bytes: input.requestAudit.streamUtf8Bytes,
    chunkCount: input.requestAudit.streamChunkCount,
    usageEventCount: input.requestAudit.usageEventCount,
    usageTotalTokens: input.requestAudit.usageTotalTokens,
    acceptedEventShapes: acceptedShapeAudit(input.requestAudit),
    firstRejectedEvent: input.requestAudit.firstRejectedEvent
  });
  const safeSchemaDiagnostic = input.schemaDiagnostic === undefined
    ? undefined
    : Object.freeze({ ...input.schemaDiagnostic });
  const transportAttemptCount =
    (input.priorTransportAttemptCount ?? 0) + input.requestAudit.attemptCount;
  llmFailureAudits.set(error, Object.freeze({
    schemaVersion: 1,
    requestCount: input.requestCount,
    transportAttemptCount,
    providerRequestCount: transportAttemptCount,
    retryCount: aggregateAudits.reduce(
      (sum, audit) => sum + audit.retryCount,
      0
    ),
    maxOutputTokens: aggregateAudits.every(
      (audit) => audit.maxOutputTokens === maxOutputTokens
    )
      ? maxOutputTokens
      : null,
    responseByteCount: aggregateAudits.reduce(
      (sum, audit) => sum + audit.responseByteCount,
      0
    ),
    usageTotalTokens: usageValues.length === 0
      ? null
      : usageValues.reduce((sum, value) => sum + value, 0),
    usageComplete:
      aggregateAudits.length === input.requestCount &&
      aggregateAudits.every((audit) => audit.usageComplete),
    completedResponses: Object.freeze(completedResponses),
    terminal,
    stream,
    jsonSchemaValidated: input.jsonSchemaValidated,
    ...(safeSchemaDiagnostic === undefined
      ? {}
      : { schemaDiagnostic: safeSchemaDiagnostic })
  }));
}

function mutableAuditFromReceipt(
  receipt: LlmTransportReceipt | LlmSalvageTransportReceipt,
  maxOutputTokens: number | null = null
): MutableLlmRequestAudit {
  const transportAudit = getLlmTransportAudit(receipt);
  return {
    attemptCount: receipt.transportAttemptCount,
    status: 200,
    responseMode: receipt.responseMode,
    eofObserved: true,
    finishReason:
      transportAudit?.finishReason ??
      ("finishReasonLengthSalvaged" in receipt && receipt.finishReasonLengthSalvaged
        ? "length"
        : "stop"),
    finishReasonStopObserved:
      "finishReasonStopVerified" in receipt && receipt.finishReasonStopVerified,
    sseDoneObserved: receipt.sseDoneObserved,
    streamEventCount: 0,
    acceptedEventShapeCounts: new Map(
      receipt.acceptedEventShapes.map((entry) => [
        `${entry.category}:${entry.shapeFingerprint}`,
        { ...entry }
      ])
    ),
    streamUtf8Bytes: transportAudit?.responseByteCount ?? 0,
    streamChunkCount: 0,
    usageEventCount: transportAudit?.usageComplete ? 1 : 0,
    usageTotalTokens: transportAudit?.usageTotalTokens ?? null,
    firstRejectedEvent: null,
    maxOutputTokens: transportAudit?.maxOutputTokens ?? maxOutputTokens
  };
}

function assertStructuredCompletionTransport(
  receipt: LlmTransportReceipt
): void {
  if (receipt.responseMode !== "sse" || receipt.sseDoneObserved === true) return;
  const error = new LlmResponseFormatError("response_shape");
  rememberLlmFailureAudit(error, {
    requestCount: 1,
    requestAudit: mutableAuditFromReceipt(receipt),
    jsonSchemaValidated: false
  });
  throw error;
}

function promoteJsonFailureAudit(
  error: unknown,
  requestCount: 1 | 2 | 3 | 4,
  completedResponses: readonly LlmTransportReceipt[],
  priorTransportAttemptCount: number
): void {
  const existing = getLlmFailureAudit(error);
  if (existing === null) return;
  rememberLlmFailureAudit(error, {
    requestCount,
    requestAudit: {
      attemptCount:
        existing.transportAttemptCount -
        existing.completedResponses.reduce(
          (sum, receipt) => sum + receipt.transportAttemptCount,
          0
        ),
      status: existing.terminal.status,
      responseMode: existing.terminal.responseMode,
      eofObserved: existing.terminal.eofObserved,
      finishReason: existing.terminal.finishReason,
      finishReasonStopObserved: existing.terminal.finishReasonStopObserved,
      sseDoneObserved: existing.terminal.sseDoneObserved,
      streamEventCount: existing.stream.eventCount,
      acceptedEventShapeCounts: new Map(
        existing.stream.acceptedEventShapes.map((entry) => [
          `${entry.category}:${entry.shapeFingerprint}`,
          { ...entry }
        ])
      ),
      streamUtf8Bytes: existing.stream.utf8Bytes,
      streamChunkCount: existing.stream.chunkCount,
      usageEventCount: existing.stream.usageEventCount,
      usageTotalTokens: existing.stream.usageTotalTokens,
      firstRejectedEvent: existing.stream.firstRejectedEvent,
      maxOutputTokens: existing.maxOutputTokens
    },
    completedResponses,
    priorTransportAttemptCount,
    jsonSchemaValidated: false,
    schemaDiagnostic: existing.schemaDiagnostic
  });
}

async function requestWithRetry(
  fetchImpl: FetchLike,
  url: URL,
  init: RequestInit,
  runtime: LlmRuntimeOptions,
  audit: MutableLlmRequestAudit,
  salvageOnLengthLimit = false
): Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly raw: unknown;
  readonly attemptCount: number;
  readonly responseMode: LlmResponseMode | null;
  readonly finishReasonStopVerified: boolean;
  readonly sseDoneObserved: boolean | null;
  readonly retryAfterMs: number | null;
  readonly salvaged: boolean;
}> {
  const durations = resolveLlmRequestDurations(runtime);
  const deadline = Date.now() + durations.maximumDurationMs;
  let attempt = 1;
  let retryAfterMs: number | null = null;
  for (;;) {
    resetMutableLlmRequestAuditForAttempt(audit);
    assertLlmRequestMayStart();
    if (runtime.signal?.aborted) {
      throw new LlmRequestError("LLM_CANCELLED");
    }
    const executeAttempt = async (): Promise<{
      readonly ok: boolean;
      readonly status: number;
      readonly raw: unknown;
      readonly attemptCount: number;
      readonly responseMode: LlmResponseMode | null;
      readonly finishReasonStopVerified: boolean;
      readonly sseDoneObserved: boolean | null;
      readonly retryAfterMs: number | null;
      readonly salvaged: boolean;
    } | null> => {
      // 排队结束后重新检查；soft-stop 期间排队的任务不能跨过调度边界发起请求。
      assertLlmRequestMayStart();
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
        // 在并发槽位内紧邻 fetch 执行付费前检查。拒绝不会调用 fetch，也不计尝试。
        if (runtime.onTransportDispatch !== undefined) {
          try {
            await runtime.onTransportDispatch(attempt);
          } catch {
            throw new LlmRequestError("LLM_TRANSPORT_DENIED");
          }
        }
        // The dispatch hook may await durable reservation/start checkpoints. A stop can close the
        // ambient payment gate while that flush is pending, so re-check after the final await and
        // immediately before recording/fetching the transport.
        assertLlmRequestMayStart();
        if (runtime.signal?.aborted) {
          throw new LlmRequestError("LLM_CANCELLED");
        }
        audit.attemptCount += 1;
        const response = await waitForOrAbort(
          fetchImpl(url, { ...init, signal: controller.signal }),
          controller.signal
        );
        responseReceived = true;
        audit.status = response.status;
        retryAfterMs = parseRetryAfterMilliseconds(
          response.headers.get("retry-after"),
          Date.now()
        );
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
            return {
              ok: false,
              status: response.status,
              raw: undefined,
              attemptCount: audit.attemptCount,
              responseMode: null,
              finishReasonStopVerified: false,
              sseDoneObserved: null,
              retryAfterMs,
              salvaged: false
            };
          }
          return null;
        }
        const parsed = await parseResponseBody(
          response,
          controller,
          {
            onValidOutput: () => {
              watchdog.receivedValidOutput();
              runtime.onSafeOutputActivity?.();
            },
            onResponseByte: () => {
              runtime.onResponseBodyByte?.();
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
          },
          audit,
          salvageOnLengthLimit
        );
        const timeoutError = watchdog.error();
        if (timeoutError !== undefined) {
          throw timeoutError;
        }
        // 首个有效模型事件会清除绝对保护计时。正常持续输出后只看
        // 有效事件间的停顿，因此不能在这里再用初始 deadline 拒绝结果。
        return {
          ok: true,
          status: response.status,
          raw: parsed.raw,
          attemptCount: audit.attemptCount,
          responseMode: parsed.responseMode,
          finishReasonStopVerified: !parsed.salvaged,
          sseDoneObserved: parsed.sseDoneObserved,
          retryAfterMs: null,
          salvaged: parsed.salvaged
        };
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
          error instanceof LlmRetainedTextTooLargeError ||
          error instanceof LlmResponseFormatError ||
          error instanceof LlmRequestError
        ) {
          throw error;
        }
        // 这里只处理没有任何已收模型字节的纯传输失败。重试判定：
        // - 服务端明确返回“请求过多”(429)时自动重试（上面非 2xx 分支已处理）；
        // - 连接/流失败且零响应字节（fetch 未得到响应，或 2xx 流在收到任何字节
        //   前中断）也允许重试，但上限受 maxAttempts 约束；
        // - 一旦收到任何响应字节（audit.streamUtf8Bytes > 0），请求已经到达服务端，
        //   绝不能把局部/不确定输出重放成新的付费请求。
        if (audit.streamUtf8Bytes > 0) {
          throw new LlmRequestError(
            "LLM_STREAM_INTERRUPTED",
            undefined,
            watchdog.formatFailureStage(),
            watchdog.formatFailureSubstage()
          );
        }
        if (attempt >= runtime.maxAttempts) {
          throw new LlmRequestError(
            "LLM_NETWORK_FAILED",
            undefined,
            watchdog.formatFailureStage(),
            watchdog.formatFailureSubstage()
          );
        }
        return null;
      } finally {
        runtime.signal?.removeEventListener("abort", cancelForTaskState);
        watchdog.close();
      }
    };
    const result = await (
      runtime.dispatchTransport === undefined
        ? executeAttempt()
        : runtime.dispatchTransport(executeAttempt)
    );
    if (result !== null) {
      return result;
    }
    assertLlmRequestMayStart();
    await delayBeforeRetry(
      Math.max(backoffMs(runtime.baseDelayMs, attempt), retryAfterMs ?? 0),
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
    // DONE 后的诊断只有在真实 EOF 才能落最终结构分类。读取期间统一保留
    // tail-incomplete；超时、取消或断流不能带走一个尚未收口的暂态判断。
    this.#formatFailureStage = formatFailureStage;
    this.#formatFailureSubstage = formatFailureSubstage;
    if (this.#timeoutCode !== null) return;
    if (this.#drainingInvalidResponse) return;
    this.#drainingInvalidResponse = true;
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

function parseRetryAfterMilliseconds(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds)
      ? Math.min(Math.ceil(seconds * 1_000), 60 * 60 * 1_000)
      : null;
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(Math.max(0, timestamp - nowMs), 60 * 60 * 1_000);
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
  readonly onResponseByte: () => void;
  readonly onInvalidResponseDrainStarted: (
    formatFailureStage?: LlmResponseFormatFailureStage,
    formatFailureSubstage?: LlmResponseFormatFailureSubstage
  ) => void;
  readonly onInvalidResponseDrainActivity: () => void;
}

interface ParsedResponseBody {
  readonly raw: unknown;
  readonly responseMode: LlmResponseMode;
  readonly sseDoneObserved: boolean | null;
  readonly salvaged: boolean;
}

async function parseResponseBody(
  response: Response,
  requestController: AbortController,
  observer: ResponseBodyActivityObserver,
  audit: MutableLlmRequestAudit,
  salvageOnLengthLimit = false
): Promise<ParsedResponseBody> {
  if (response.body === null) {
    throw new LlmResponseFormatError("missing_body");
  }
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType === "text/event-stream") {
    audit.responseMode = "sse";
    audit.sseDoneObserved = false;
    const stream = await readChatCompletionEventStream(
      response,
      requestController,
      observer,
      audit,
      salvageOnLengthLimit
    );
    return {
      raw: stream.raw,
      responseMode: "sse",
      sseDoneObserved: stream.sseDoneObserved,
      salvaged: stream.salvaged
    };
  }
  audit.responseMode = "json";
  audit.sseDoneObserved = null;
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
      new LlmResponseFormatError("content_type"),
      audit
    );
  }
  const text = await readResponseTextWithLimit(
    response,
    requestController,
    observer,
    audit
  );
  audit.eofObserved = true;
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
  audit.finishReason = "stop";
  audit.finishReasonStopObserved = true;
  observer.onValidOutput();
  return {
    raw,
    responseMode: "json",
    sseDoneObserved: null,
    salvaged: false
  };
}

async function readResponseTextWithLimit(
  response: Response,
  requestController: AbortController,
  observer: ResponseBodyActivityObserver,
  audit: MutableLlmRequestAudit
): Promise<string> {
  if (response.body === null) throw new LlmResponseFormatError("missing_body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
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
          assertRetainedLlmTextLength(text.length);
          return text;
        } catch {
          throw new LlmResponseFormatError("json_utf8");
        }
      }
      if (chunk.value.byteLength > 0) {
        audit.streamUtf8Bytes = addResponseChunkSize(
          audit.streamUtf8Bytes,
          chunk.value.byteLength
        );
        audit.streamChunkCount += 1;
        observer.onResponseByte();
      }
      if (firstProtocolError !== undefined) {
        if (chunk.value.byteLength > 0) {
          observer.onInvalidResponseDrainActivity();
        }
        continue;
      }
      try {
        text += decoder.decode(chunk.value, { stream: true });
        assertRetainedLlmTextLength(text.length);
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
  firstProtocolError: LlmResponseFormatError,
  audit: MutableLlmRequestAudit
): Promise<never> {
  if (response.body === null) throw firstProtocolError;
  const reader = response.body.getReader();
  let readerFinished = false;
  let readerErrored = false;
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
        audit.eofObserved = true;
        throw firstProtocolError;
      }
      if (chunk.value.byteLength > 0) {
        audit.streamUtf8Bytes = addResponseChunkSize(
          audit.streamUtf8Bytes,
          chunk.value.byteLength
        );
        audit.streamChunkCount += 1;
        observer.onResponseByte();
      }
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

type PostDoneTailShape =
  | "benign_controls_only"
  | "json_syntax_invalid"
  | "json_non_object"
  | "error_object"
  | "unknown_object_or_scan_limit"
  | "choices_present"
  | "content_or_tool_present";

/**
 * DONE 后尾部只保留一个固定枚举。数字越大表示越需要优先调查的协议形状；
 * 合并多个事件时只取最高级别，不保存每类出现次数或事件组合。
 */
const postDoneTailShapePriority: Readonly<Record<PostDoneTailShape, number>> = {
  benign_controls_only: 0,
  json_syntax_invalid: 1,
  json_non_object: 2,
  error_object: 3,
  unknown_object_or_scan_limit: 4,
  choices_present: 5,
  content_or_tool_present: 6
};

const postDoneMetadataKeys = new Set([
  "choices",
  "usage",
  "id",
  "object",
  "created",
  "model",
  "system_fingerprint",
  "service_tier"
]);
const postDoneContentOrToolKeys = new Set([
  "content",
  "reasoning",
  "reasoning_content",
  "delta",
  "message",
  "tool_calls",
  "tool_call",
  "tools",
  "function_call",
  "function",
  "arguments",
  "refusal",
  "audio"
]);
const maximumPostDoneShapeNodes = 256;
const maximumPostDoneShapeDepth = 8;
const maximumUsageCounterDepth = 4;
const maximumUsageCounterKeys = 64;
const maximumMetadataStringLength = 1_024;

function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function scanPostDonePayloadShape(value: unknown): {
  readonly contentOrToolPresent: boolean;
  readonly choicesPresent: boolean;
  readonly unclassifiable: boolean;
} {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value, depth: 0 }
  ];
  let visited = 0;
  let choicesPresent = false;
  let unclassifiable = false;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    visited += 1;
    if (
      visited > maximumPostDoneShapeNodes ||
      current.depth > maximumPostDoneShapeDepth
    ) {
      return {
        contentOrToolPresent: false,
        choicesPresent,
        unclassifiable: true
      };
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > maximumPostDoneShapeNodes - visited) {
        return {
          contentOrToolPresent: false,
          choicesPresent,
          unclassifiable: true
        };
      }
      for (const item of current.value) {
        visited += 1;
        if (typeof item === "object" && item !== null) {
          pending.push({ value: item, depth: current.depth + 1 });
        }
      }
      continue;
    }
    if (!isPlainJsonRecord(current.value)) continue;
    const entries = Object.entries(current.value);
    // 在节点预算判断前先检查当前对象本身的危险键。这样即使对象还有
    // 大量无关兄弟字段，正文/工具和非空 choices 也不会降级成普通的
    // “未知对象或扫描上限”。正文/工具仍保持最高优先级。
    for (const [key, child] of entries) {
      if (postDoneContentOrToolKeys.has(key)) {
        return {
          contentOrToolPresent: true,
          choicesPresent,
          unclassifiable: false
        };
      }
      if (key === "choices") {
        if (Array.isArray(child)) {
          choicesPresent ||= child.length > 0;
        } else {
          unclassifiable = true;
        }
      }
    }
    if (entries.length > maximumPostDoneShapeNodes - visited) {
      return {
        contentOrToolPresent: false,
        choicesPresent,
        unclassifiable: true
      };
    }
    for (const [key, child] of entries) {
      visited += 1;
      if (key === "choices") {
        if (Array.isArray(child)) {
          choicesPresent ||= child.length > 0;
        } else {
          // 畸形 choices 使当前事件无法归为严格元数据，但仍要在有界
          // 范围内继续扫描其它兄弟节点；正文/工具字段的危险级别更高。
          unclassifiable = true;
        }
      }
      // 顶层 error 有自己的闭集分类。服务商通常把说明放在 error.message；
      // 不遍历这个子树，避免把已知错误信封误报成模型正文。error 之外的
      // content/tool/choices 兄弟字段仍会按更高危险级别优先。
      if (current.depth === 0 && key === "error") continue;
      if (typeof child === "object" && child !== null) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return {
    contentOrToolPresent: false,
    choicesPresent,
    unclassifiable
  };
}

function isBoundedUsageCounterStructure(
  value: unknown
): boolean {
  if (!isPlainJsonRecord(value)) return false;
  const result = scanBoundedUsageCounter(value, 0, {
    remaining: maximumPostDoneShapeNodes
  });
  return result.valid && result.hasNumericCounter;
}

function scanBoundedUsageCounter(
  value: unknown,
  depth: number,
  budget: { remaining: number }
): { readonly valid: boolean; readonly hasNumericCounter: boolean } {
  if (typeof value === "number") {
    return {
      valid: Number.isSafeInteger(value) && value >= 0,
      hasNumericCounter: Number.isSafeInteger(value) && value >= 0
    };
  }
  if (!isPlainJsonRecord(value) || depth >= maximumUsageCounterDepth) {
    return { valid: false, hasNumericCounter: false };
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > maximumUsageCounterKeys) {
    return { valid: false, hasNumericCounter: false };
  }
  let hasNumericCounter = false;
  for (const [key, child] of entries) {
    budget.remaining -= 1;
    if (budget.remaining < 0 || !/^[A-Za-z0-9_]{1,64}$/u.test(key)) {
      return { valid: false, hasNumericCounter: false };
    }
    if (child === null) continue;
    const childResult = scanBoundedUsageCounter(
      child,
      depth + 1,
      budget
    );
    if (!childResult.valid) {
      return { valid: false, hasNumericCounter: false };
    }
    hasNumericCounter ||= childResult.hasNumericCounter;
  }
  return { valid: true, hasNumericCounter };
}

function isBoundedMetadataString(value: unknown, nullable = false): boolean {
  return (
    (nullable && value === null) ||
    (typeof value === "string" &&
      value.length <= maximumMetadataStringLength &&
      value.trim().length > 0 &&
      !/[\u0000-\u001f\u007f]/u.test(value))
  );
}

function isStrictPostDoneUsageMetadata(raw: unknown): boolean {
  if (!isPlainJsonRecord(raw)) return false;
  const entries = Object.entries(raw);
  if (
    entries.length === 0 ||
    entries.some(([key]) => !postDoneMetadataKeys.has(key))
  ) {
    return false;
  }
  if (
    Object.hasOwn(raw, "choices") &&
    (!Array.isArray(raw.choices) || raw.choices.length !== 0)
  ) {
    return false;
  }
  if (
    Object.hasOwn(raw, "usage") &&
    !isBoundedUsageCounterStructure(raw.usage)
  ) {
    return false;
  }
  let hasMetadataEvidence =
    (Object.hasOwn(raw, "choices") &&
      Array.isArray(raw.choices) &&
      raw.choices.length === 0) ||
    Object.hasOwn(raw, "usage");
  for (const key of ["id", "object", "model"] as const) {
    if (Object.hasOwn(raw, key) && !isBoundedMetadataString(raw[key])) {
      return false;
    }
    hasMetadataEvidence ||= Object.hasOwn(raw, key);
  }
  for (const key of ["system_fingerprint", "service_tier"] as const) {
    if (
      Object.hasOwn(raw, key) &&
      !isBoundedMetadataString(raw[key], true)
    ) {
      return false;
    }
    hasMetadataEvidence ||=
      Object.hasOwn(raw, key) && typeof raw[key] === "string";
  }
  if (Object.hasOwn(raw, "created")) {
    if (
      !Number.isSafeInteger(raw.created) ||
      typeof raw.created !== "number" ||
      raw.created < 0
    ) {
      return false;
    }
    hasMetadataEvidence = true;
  }
  return hasMetadataEvidence;
}

function classifyPostDoneData(data: string): PostDoneTailShape {
  // 空 data、重复 DONE 和严格元数据都是已知控制形状；任意组合仍只落
  // 一个 benign 枚举，但协议接受条件不变，真实 EOF 后照样失败。
  if (data.length === 0 || data === "[DONE]") {
    return "benign_controls_only";
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data) as unknown;
  } catch {
    return "json_syntax_invalid";
  }
  const scan = scanPostDonePayloadShape(raw);
  if (scan.contentOrToolPresent) return "content_or_tool_present";
  if (scan.choicesPresent) return "choices_present";
  if (!isPlainJsonRecord(raw)) return "json_non_object";
  if (Object.hasOwn(raw, "error")) return "error_object";
  if (scan.unclassifiable) {
    return "unknown_object_or_scan_limit";
  }
  return isStrictPostDoneUsageMetadata(raw)
    ? "benign_controls_only"
    : "unknown_object_or_scan_limit";
}

function mergePostDoneTailShape(
  current: PostDoneTailShape | undefined,
  next: PostDoneTailShape
): PostDoneTailShape {
  if (current === undefined || current === next) return next;
  return postDoneTailShapePriority[next] > postDoneTailShapePriority[current]
    ? next
    : current;
}

function postDoneFailureSubstage(
  shape: PostDoneTailShape,
  tailComplete: boolean
): LlmResponseFormatFailureSubstage {
  // 只有真实 HTTP EOF 才能把尾部最终归类；任何超时、取消、中断、正文
  // 上限或分块上限都只能说明尾部未完整，不能泄露已经看到的暂态形状。
  if (!tailComplete) return "data_after_done_tail_incomplete";
  if (shape === "content_or_tool_present") {
    return "data_after_done_content_or_tool_present";
  }
  if (shape === "choices_present") {
    return "data_after_done_choices_present";
  }
  if (shape === "unknown_object_or_scan_limit") {
    return "data_after_done_unknown_object_or_scan_limit";
  }
  if (shape === "error_object") {
    return "data_after_done_error_object";
  }
  if (shape === "json_non_object") {
    return "data_after_done_json_non_object";
  }
  if (shape === "json_syntax_invalid") {
    return "data_after_done_json_syntax_invalid";
  }
  return "data_after_done_benign_controls_only";
}

interface ChatCompletionStreamState {
  content: string;
  reasoning: string;
  sawChoice: boolean;
  sawStop: boolean;
  sawDone: boolean;
  postDoneTailShape: PostDoneTailShape | undefined;
  postDoneTailHasUnresolvedData: boolean;
  /**
   * 当 salvageOnLengthLimit 启用且 finish_reason="length" 到达时置为 true，
   * 表示推理流可被抢救到独立的 finalizer 阶段。不调用 assertSafeFinishReason
   * （该函数会抛 LLM_OUTPUT_LENGTH_LIMIT），也不置 sawStop（避免触发 post-stop
   * 尾部校验拒绝后续 reasoning 分片）。
   */
  sawLengthSalvage: boolean;
  /**
   * 由 readChatCompletionEventStream 传入，consumeEvent 闭包读取。
   * 只在显式启用时才接受 finish_reason="length" 作为可抢救终止。
   */
  salvageOnLengthLimit: boolean;
}

interface PostDonePendingDataScan {
  confirmedDataField: boolean;
  currentLineMayBeData: boolean;
  currentLinePrefix: string;
}

async function readChatCompletionEventStream(
  response: Response,
  requestController: AbortController,
  observer: ResponseBodyActivityObserver,
  audit: MutableLlmRequestAudit,
  salvageOnLengthLimit = false
): Promise<{
  readonly raw: unknown;
  readonly sseDoneObserved: boolean;
  readonly salvaged: boolean;
}> {
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
    sawDone: false,
    postDoneTailShape: undefined,
    postDoneTailHasUnresolvedData: false,
    sawLengthSalvage: false,
    salvageOnLengthLimit
  };
  let trailingCarriageReturn = false;
  const eventBuffer = createEventStreamEventBuffer();
  const postDonePendingDataScan: PostDonePendingDataScan = {
    confirmedDataField: false,
    currentLineMayBeData: true,
    currentLinePrefix: ""
  };
  const consumeEvent = (event: string): void => {
    audit.streamEventCount += 1;
    observeSseUsage(event, audit);
    try {
      const hasValidOutput = consumeObservedChatCompletionEvent(
        event,
        state,
        observer,
        audit
      );
      recordAcceptedSseEvent(event, audit);
      audit.sseDoneObserved = state.sawDone;
      audit.finishReasonStopObserved = state.sawStop;
      resetPostDonePendingDataScan(postDonePendingDataScan, state);
      if (hasValidOutput) observer.onValidOutput();
    } catch (error) {
      audit.firstRejectedEvent ??= describeRejectedSseEvent(
        event,
        audit.streamEventCount
      );
      throw error;
    }
  };
  const observePartialEventText = (text: string): void => {
    scanUnresolvedPostDoneData(
      text,
      postDonePendingDataScan,
      state,
      observer
    );
  };
  let totalBytes = 0;
  let responseChunkCount = 0;
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
        if (state.sawDone && state.postDoneTailHasUnresolvedData) {
          publishUnresolvedPostDoneData(state, observer);
        }
        throw error;
      }
      if (chunk.done) {
        readerFinished = true;
        audit.eofObserved = true;
        audit.sseDoneObserved = state.sawDone;
        audit.finishReasonStopObserved = state.sawStop;
        if (firstProtocolError !== undefined) {
          if (state.postDoneTailShape !== undefined) {
            throw new LlmResponseFormatError(
              "trailing_data",
              postDoneFailureSubstage(state.postDoneTailShape, true)
            );
          }
          throw firstProtocolError;
        }
        try {
          const normalized = normalizeEventStreamText(
            trailingCarriageReturn,
            decodeEventStreamText(decoder),
            true
          );
          trailingCarriageReturn = normalized.trailingCarriageReturn;
          consumeEventStreamText(
            normalized.text,
            eventBuffer,
            consumeEvent,
            observePartialEventText
          );
          finishEventStreamEvents(eventBuffer, consumeEvent);
        } catch (error) {
          if (!state.sawDone || !isDrainableResponseProtocolError(error)) {
            throw error;
          }
          updatePostDoneTailShape(
            state,
            "unknown_object_or_scan_limit",
            observer
          );
        }
        if (state.postDoneTailShape !== undefined) {
          throw new LlmResponseFormatError(
            "trailing_data",
            postDoneFailureSubstage(state.postDoneTailShape, true)
          );
        }
        if (state.sawLengthSalvage && !state.sawStop) {
          // 抢救路径：finish_reason="length" 已由 consumeChatCompletionEvent
          // 接受为可抢救终止。必须 reasoning 非空且 content 为空——有 content
          // 说明 content 被截断，仍然不可抢救。不调用 extractChatCompletion
          // （它要求非空 content），直接返回原始 reasoning。
          // 如果 sawStop 也为 true，说明流后续给出了正常终止，优先走正常路径。
          if (state.reasoning.trim().length === 0 || state.content.trim().length !== 0) {
            throw new LlmRequestError("LLM_OUTPUT_LENGTH_LIMIT");
          }
          return {
            raw: chatCompletionStreamResult(state),
            sseDoneObserved: state.sawDone,
            salvaged: true
          };
        }
        if (!state.sawChoice || !state.sawStop) {
          throw new LlmRequestError("LLM_STREAM_INTERRUPTED");
        }
        const raw = chatCompletionStreamResult(state);
        // 思考内容是辅助信息，不是最终回答。即使 thinking=true，
        // reasoning-only 或空白 content 也是不完整响应。
        extractChatCompletion(raw);
        return { raw, sseDoneObserved: state.sawDone, salvaged: false };
      }
      if (
        (state.postDoneTailShape !== undefined ||
          state.postDoneTailHasUnresolvedData) &&
        chunk.value.byteLength > 0
      ) {
        observer.onInvalidResponseDrainActivity();
      }
      totalBytes = addResponseChunkSize(totalBytes, chunk.value.byteLength);
      if (chunk.value.byteLength > 0) observer.onResponseByte();
      audit.streamUtf8Bytes = totalBytes;
      if (chunk.value.byteLength > 0) {
        responseChunkCount += 1;
        audit.streamChunkCount = responseChunkCount;
        if (responseChunkCount > maximumLlmResponseChunks) {
          if (firstProtocolError !== undefined) throw firstProtocolError;
          if (state.sawDone) {
            updatePostDoneTailShape(
              state,
              "unknown_object_or_scan_limit",
              observer
            );
            throw new LlmResponseFormatError(
              "trailing_data",
              "data_after_done_tail_incomplete"
            );
          }
          throw new LlmResponseFormatError("event_shape");
        }
      }
      if (firstProtocolError !== undefined) {
        if (chunk.value.byteLength > 0) {
          observer.onInvalidResponseDrainActivity();
        }
        continue;
      }
      if (chunk.value.byteLength === 0) continue;
      try {
        const normalized = normalizeEventStreamText(
          trailingCarriageReturn,
          decodeEventStreamText(decoder, chunk.value),
          false
        );
        trailingCarriageReturn = normalized.trailingCarriageReturn;
        consumeEventStreamText(
          normalized.text,
          eventBuffer,
          consumeEvent,
          observePartialEventText
        );
      } catch (error) {
        if (!isDrainableResponseProtocolError(error)) throw error;
        if (state.sawDone) {
          updatePostDoneTailShape(
            state,
            "unknown_object_or_scan_limit",
            observer
          );
          firstProtocolError = new LlmResponseFormatError(
            "trailing_data",
            postDoneFailureSubstage(
              state.postDoneTailShape ?? "unknown_object_or_scan_limit",
              false
            )
          );
        } else {
          firstProtocolError = error;
        }
        // 首错后不再保留、解码或解析模型正文，避免后续字段替换首错。
        clearEventStreamEventBuffer(eventBuffer);
        resetPostDonePendingDataScan(postDonePendingDataScan, state);
        state.content = "";
        state.reasoning = "";
        observer.onInvalidResponseDrainStarted(
          firstProtocolError instanceof LlmResponseFormatError
            ? firstProtocolError.formatFailureStage
            : undefined,
          firstProtocolError instanceof LlmResponseFormatError
            ? firstProtocolError.formatFailureSubstage
            : undefined
        );
      }
    }
  } catch (error) {
    if (
      firstProtocolError === undefined &&
      (state.postDoneTailShape !== undefined ||
        state.postDoneTailHasUnresolvedData)
    ) {
      publishUnresolvedPostDoneData(state, observer);
    }
    throw error;
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

function observeSseUsage(event: string, audit: MutableLlmRequestAudit): void {
  const raw = parseSseEventData(event);
  if (typeof raw !== "object" || raw === null) return;
  const usage = (raw as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return;
  audit.usageEventCount += 1;
  const totalTokens = (usage as Record<string, unknown>).total_tokens;
  if (Number.isSafeInteger(totalTokens) && (totalTokens as number) >= 0) {
    audit.usageTotalTokens = totalTokens as number;
  }
}

export function describeRejectedSseEvent(
  event: string,
  ordinal: number
): LlmSseRejectedEventAudit {
  const dataFields = sseDataFields(event);
  const raw = parseSseEventData(event);
  let shape: LlmSseRejectedShape = "json_invalid";
  let topLevelKeys: readonly string[] = [];
  let unknownTopLevelKeys: readonly string[] = [];
  let choiceKeys: readonly string[] = [];
  let unknownChoiceKeys: readonly string[] = [];
  let deltaKeys: readonly string[] = [];
  let unknownPayloadKeys: readonly string[] = [];
  if (raw !== undefined) {
    if (typeof raw !== "object" || raw === null) {
      shape = "non_object";
    } else {
      const record = raw as Record<string, unknown>;
      ({ known: topLevelKeys, unknown: unknownTopLevelKeys } = splitKnownKeys(record, knownTopLevelSseKeys));
      if (Object.hasOwn(record, "error")) {
        shape = "error_object";
      } else if (!Array.isArray(record.choices)) {
        shape = "choices_missing_or_non_array";
      } else {
        const choice = record.choices[0];
        if (typeof choice !== "object" || choice === null) {
          shape = "choice_non_object";
        } else {
          const choiceRecord = choice as Record<string, unknown>;
          ({ known: choiceKeys, unknown: unknownChoiceKeys } = splitKnownKeys(choiceRecord, knownChoiceSseKeys));
          const payload = choiceRecord.delta ?? choiceRecord.message;
          if (typeof payload !== "object" || payload === null) {
            shape = "delta_missing_or_non_object";
          } else {
            const payloadRecord = payload as Record<string, unknown>;
            ({ known: deltaKeys, unknown: unknownPayloadKeys } = splitKnownKeys(payloadRecord, knownPayloadSseKeys));
            shape = ["reasoning_content", "reasoning", "content"].some((key) => {
              const value = payloadRecord[key];
              return value !== undefined && value !== null &&
                typeof value !== "string";
            })
              ? "delta_field_type"
              : "finish_reason_type_or_unknown";
          }
        }
      }
    }
  }
  const errorEnvelope = shape === "error_object" && raw !== undefined &&
    typeof raw === "object" && raw !== null && !Array.isArray(raw) &&
    Object.hasOwn(raw as Record<string, unknown>, "error")
    ? describeSseErrorEnvelope((raw as Record<string, unknown>).error)
    : null;
  const structure = describeSseStructure(raw);
  const topLevelSummary = unknownKeysSummary(unknownTopLevelKeys, "sse-rejected-unknown-top-level-keys");
  const choiceSummary = unknownKeysSummary(unknownChoiceKeys, "sse-rejected-unknown-choice-keys");
  const payloadSummary = unknownKeysSummary(unknownPayloadKeys, "sse-rejected-unknown-payload-keys");
  const shapeFingerprint = safeAuditFingerprint({
    topLevelKeys,
    unknownTopLevelKeyCount: topLevelSummary.count,
    unknownTopLevelKeysFingerprint: topLevelSummary.fingerprint,
    choiceKeys,
    unknownChoiceKeyCount: choiceSummary.count,
    unknownChoiceKeysFingerprint: choiceSummary.fingerprint,
    deltaKeys,
    unknownPayloadKeyCount: payloadSummary.count,
    unknownPayloadKeysFingerprint: payloadSummary.fingerprint,
    shape,
    structure,
    errorEnvelope
  });
  return Object.freeze({
    eventOrdinal: ordinal,
    completedEventCount: ordinal - 1,
    dataFieldCount: dataFields.length,
    eventUtf8Bytes: Buffer.byteLength(event, "utf8"),
    topLevelKeys,
    unknownTopLevelKeyCount: topLevelSummary.count,
    unknownTopLevelKeysFingerprint: topLevelSummary.fingerprint,
    choiceKeys,
    unknownChoiceKeyCount: choiceSummary.count,
    unknownChoiceKeysFingerprint: choiceSummary.fingerprint,
    deltaKeys,
    unknownPayloadKeyCount: payloadSummary.count,
    unknownPayloadKeysFingerprint: payloadSummary.fingerprint,
    shape,
    structure,
    errorEnvelope,
    shapeFingerprint
  });
}

const maximumErrorEnvelopeFields = 32;

function describeSseErrorEnvelope(
  errorValue: unknown
): LlmSseErrorEnvelopeAudit {
  if (!isRecordForAudit(errorValue)) {
    return Object.freeze({
      present: true as const,
      classification: "non_object" as const,
      fieldCount: 0,
      allowedFields: Object.freeze([]),
      allowedNestedObjectKeys: Object.freeze([]),
      unknownFieldCount: 0,
      unknownKeysFingerprint: safeAuditFingerprint({
        domain: "sse-error-envelope",
        nonObject: true
      }),
      envelopeFingerprint: safeAuditFingerprint({
        domain: "sse-error-envelope",
        nonObject: true
      })
    });
  }
  const record = errorValue as Record<string, unknown>;
  const keys = safeShapeKeys(record);
  const allowedFields: LlmSseErrorEnvelopeFieldAudit[] = [];
  const allowedNestedObjectKeys: string[] = [];
  const unknownKeys: string[] = [];
  for (const key of keys) {
    if (errorEnvelopeAllowlist.has(key)) {
      if (allowedFields.length < maximumErrorEnvelopeFields) {
        allowedFields.push(Object.freeze({ key, type: safeJsonType(record[key]) }));
      }
      if (isRecordForAudit(record[key]) && errorEnvelopeNestedAllowlist.has(key)) {
        allowedNestedObjectKeys.push(key);
      }
    } else {
      unknownKeys.push(key);
    }
  }
  const classification: LlmSseErrorEnvelopeClassification =
    unknownKeys.length > 0 ? "unknown_fields_present" : "known_fields_only";
  const unknownKeysFingerprint = safeAuditFingerprint({
    domain: "sse-error-envelope-unknown-keys",
    unknownKeyCount: unknownKeys.length,
    unknownKeyHashes: unknownKeys.map((k) => createHash("sha256").update(k, "utf8").digest("hex"))
  });
  const envelopeFingerprint = safeAuditFingerprint({
    domain: "sse-error-envelope",
    classification,
    fieldCount: keys.length,
    allowedFieldCount: allowedFields.length,
    allowedFields,
    allowedNestedObjectKeys: Object.freeze([...allowedNestedObjectKeys].sort()),
    unknownFieldCount: unknownKeys.length,
    unknownKeysFingerprint
  });
  return Object.freeze({
    present: true as const,
    classification,
    fieldCount: keys.length,
    allowedFields: Object.freeze(allowedFields),
    allowedNestedObjectKeys: Object.freeze([...allowedNestedObjectKeys].sort()),
    unknownFieldCount: unknownKeys.length,
    unknownKeysFingerprint,
    envelopeFingerprint
  });
}

const knownTopLevelSseKeys = new Set([
  "choices",
  "created",
  "error",
  "id",
  "model",
  "object",
  "service_tier",
  "system_fingerprint",
  "usage",
  "control"
]);
const knownChoiceSseKeys = new Set([
  "delta",
  "finish_reason",
  "index",
  "logprobs",
  "message"
]);
const knownPayloadSseKeys = new Set([
  "content",
  "function_call",
  "reasoning",
  "reasoning_content",
  "refusal",
  "role",
  "tool_calls"
]);

function describeSseStructure(raw: unknown): LlmSseStructuralAudit {
  const top = isRecordForAudit(raw) ? raw : undefined;
  const choices = top?.choices;
  const choice = Array.isArray(choices) && choices.length > 0
    ? choices[0]
    : undefined;
  const choiceRecord = isRecordForAudit(choice) ? choice : undefined;
  const hasDelta = choiceRecord !== undefined && Object.hasOwn(choiceRecord, "delta");
  const hasMessage =
    choiceRecord !== undefined && Object.hasOwn(choiceRecord, "message");
  const payloadSource: LlmSsePayloadSource =
    hasDelta && hasMessage ? "both"
      : hasDelta ? "delta"
        : hasMessage ? "message"
          : "neither";
  const deltaRecord = isRecordForAudit(choiceRecord?.delta)
    ? choiceRecord.delta
    : undefined;
  const messageRecord = isRecordForAudit(choiceRecord?.message)
    ? choiceRecord.message
    : undefined;
  const payloadRecord = deltaRecord ?? messageRecord;
  const finishReason = fieldValue(choiceRecord, "finish_reason");
  const finishReasonClass = classifyFinishReason(finishReason);
  const unknownTopLevelKeys = unknownShapeKeys(top, knownTopLevelSseKeys);
  const unknownChoiceKeys = unknownShapeKeys(choiceRecord, knownChoiceSseKeys);
  const unknownPayloadKeys = Object.freeze(
    [...new Set([
      ...unknownShapeKeys(deltaRecord, knownPayloadSseKeys),
      ...unknownShapeKeys(messageRecord, knownPayloadSseKeys)
    ])].sort()
  );
  const topLevelSummary = unknownKeysSummary(unknownTopLevelKeys, "sse-structure-unknown-top-level-keys");
  const choiceSummary = unknownKeysSummary(unknownChoiceKeys, "sse-structure-unknown-choice-keys");
  const payloadSummary = unknownKeysSummary(unknownPayloadKeys, "sse-structure-unknown-payload-keys");
  const unknownKeysFingerprint = safeAuditFingerprint({
    domain: "sse-structure-unknown-keys",
    topLevel: topLevelSummary,
    choice: choiceSummary,
    payload: payloadSummary
  });
  return Object.freeze({
    fieldTypes: Object.freeze({
      choices: fieldType(top, "choices"),
      created: fieldType(top, "created"),
      id: fieldType(top, "id"),
      model: fieldType(top, "model"),
      object: fieldType(top, "object"),
      serviceTier: fieldType(top, "service_tier"),
      systemFingerprint: fieldType(top, "system_fingerprint"),
      usage: fieldType(top, "usage"),
      error: fieldType(top, "error"),
      control: fieldType(top, "control"),
      choice: safeJsonType(choice, Array.isArray(choices) && choices.length > 0),
      delta: fieldType(choiceRecord, "delta"),
      message: fieldType(choiceRecord, "message"),
      finishReason: fieldType(choiceRecord, "finish_reason"),
      index: fieldType(choiceRecord, "index"),
      logprobs: fieldType(choiceRecord, "logprobs"),
      deltaFields: payloadFieldTypes(deltaRecord),
      messageFields: payloadFieldTypes(messageRecord)
    }),
    choicesLength: Array.isArray(choices)
      ? choices.length === 0 ? "0" : choices.length === 1 ? "1" : "many"
      : null,
    payloadSource,
    finishReasonClass,
    finishReasonIsNull: finishReason.present && finishReason.value === null,
    finishReasonUnknownStringHash:
      finishReasonClass === "unknown_string"
        ? safeValueHash(finishReason.value as string)
        : null,
    hasUsageField: top !== undefined && Object.hasOwn(top, "usage"),
    hasErrorField: top !== undefined && Object.hasOwn(top, "error"),
    hasControlField: top !== undefined && Object.hasOwn(top, "control"),
    unknownTopLevelKeyCount: topLevelSummary.count,
    unknownTopLevelKeysFingerprint: topLevelSummary.fingerprint,
    unknownChoiceKeyCount: choiceSummary.count,
    unknownChoiceKeysFingerprint: choiceSummary.fingerprint,
    unknownPayloadKeyCount: payloadSummary.count,
    unknownPayloadKeysFingerprint: payloadSummary.fingerprint,
    unknownKeysFingerprint
  });
}

function recordAcceptedSseEvent(
  event: string,
  audit: MutableLlmRequestAudit
): void {
  const raw = parseSseEventData(event);
  const structure = describeSseStructure(raw);
  const category = acceptedShapeCategory(event, raw, structure);
  const fingerprint = safeAuditFingerprint({
    dataFieldCount: sseDataFields(event).length,
    topLevelKeys: isRecordForAudit(raw) ? safeShapeKeys(raw) : [],
    choiceKeys: acceptedChoiceKeys(raw),
    payloadKeys: acceptedPayloadKeys(raw),
    structure
  });
  const key = `${category}:${fingerprint}`;
  const existing = audit.acceptedEventShapeCounts.get(key);
  if (existing === undefined) {
    audit.acceptedEventShapeCounts.set(key, {
      category,
      shapeFingerprint: fingerprint,
      count: 1
    });
  } else {
    existing.count += 1;
  }
}

function acceptedShapeAudit(
  audit: MutableLlmRequestAudit
): readonly LlmSseAcceptedShapeAudit[] {
  return Object.freeze(
    [...audit.acceptedEventShapeCounts.values()]
      .sort((left, right) =>
        left.category.localeCompare(right.category) ||
        left.shapeFingerprint.localeCompare(right.shapeFingerprint)
      )
      .map((entry) => Object.freeze({ ...entry }))
  );
}

function acceptedShapeCategory(
  event: string,
  raw: unknown,
  structure: LlmSseStructuralAudit
): LlmSseAcceptedShapeCategory {
  if (sseDataFields(event).join("\n") === "[DONE]") return "done";
  if (structure.hasUsageField && structure.choicesLength === "0") return "usage";
  const payload = acceptedPayloadRecord(raw);
  const content = fieldType(payload, "content") === "string";
  const reasoning =
    fieldType(payload, "reasoning_content") === "string" ||
    fieldType(payload, "reasoning") === "string";
  if (content && reasoning) return "content_reasoning";
  if (content) return "content";
  if (reasoning) return "reasoning";
  if (fieldType(payload, "role") !== "missing") return "role";
  if (structure.finishReasonClass !== "missing") return "finish";
  return "metadata";
}

function acceptedChoiceRecord(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecordForAudit(raw) || !Array.isArray(raw.choices)) return undefined;
  return isRecordForAudit(raw.choices[0]) ? raw.choices[0] : undefined;
}

function acceptedPayloadRecord(raw: unknown): Record<string, unknown> | undefined {
  const choice = acceptedChoiceRecord(raw);
  if (choice === undefined) return undefined;
  const payload = choice.delta ?? choice.message;
  return isRecordForAudit(payload) ? payload : undefined;
}

function acceptedChoiceKeys(raw: unknown): readonly string[] {
  const choice = acceptedChoiceRecord(raw);
  return choice === undefined ? [] : safeShapeKeys(choice);
}

function acceptedPayloadKeys(raw: unknown): readonly string[] {
  const payload = acceptedPayloadRecord(raw);
  return payload === undefined ? [] : safeShapeKeys(payload);
}

function payloadFieldTypes(
  record: Record<string, unknown> | undefined
): LlmSsePayloadFieldTypeAudit {
  return Object.freeze({
    content: fieldType(record, "content"),
    reasoningContent: fieldType(record, "reasoning_content"),
    reasoning: fieldType(record, "reasoning"),
    role: fieldType(record, "role"),
    functionCall: fieldType(record, "function_call"),
    refusal: fieldType(record, "refusal"),
    toolCalls: fieldType(record, "tool_calls")
  });
}

function classifyFinishReason(
  field: { readonly present: boolean; readonly value: unknown }
): LlmSseFinishReasonClass {
  if (!field.present) return "missing";
  if (field.value === null) return "null";
  if (field.value === "stop") return "stop";
  if (field.value === "length") return "length";
  if (field.value === "content_filter") return "content_filter";
  return typeof field.value === "string" ? "unknown_string" : "non_string";
}

function fieldValue(
  record: Record<string, unknown> | undefined,
  key: string
): { readonly present: boolean; readonly value: unknown } {
  return record !== undefined && Object.hasOwn(record, key)
    ? { present: true, value: record[key] }
    : { present: false, value: undefined };
}

function fieldType(
  record: Record<string, unknown> | undefined,
  key: string
): LlmSafeJsonType {
  const field = fieldValue(record, key);
  return safeJsonType(field.value, field.present);
}

function safeJsonType(value: unknown, present = true): LlmSafeJsonType {
  if (!present) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";
  return "other";
}

function isRecordForAudit(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownShapeKeys(
  record: Record<string, unknown> | undefined,
  known: ReadonlySet<string>
): readonly string[] {
  return Object.freeze(
    record === undefined
      ? []
      : safeShapeKeys(record).filter((key) => !known.has(key))
  );
}

/**
 * 将 record 的安全键名分为已知和未知两组，仅保留已知键名；
 * 未知键名不序列化，只用于计数和域分隔指纹。
 */
function splitKnownKeys(
  record: Record<string, unknown>,
  known: ReadonlySet<string>
): { readonly known: readonly string[]; readonly unknown: readonly string[] } {
  const keys = safeShapeKeys(record);
  const knownKeys: string[] = [];
  const unknownKeys: string[] = [];
  for (const key of keys) {
    if (known.has(key)) knownKeys.push(key);
    else unknownKeys.push(key);
  }
  return Object.freeze({
    known: Object.freeze(knownKeys),
    unknown: Object.freeze(unknownKeys)
  });
}

/**
 * 对未知键名做域分隔不可逆摘要：只保留计数和指纹，永不序列化原始键名。
 * 指纹 = SHA-256(domain + 逐键 SHA-256(key))，与 error-envelope 未知键摘要模式一致。
 */
function unknownKeysSummary(
  keys: readonly string[],
  domain: string
): { readonly count: number; readonly fingerprint: string } {
  return Object.freeze({
    count: keys.length,
    fingerprint: safeAuditFingerprint({
      domain,
      unknownKeyCount: keys.length,
      unknownKeyHashes: keys.map((k) =>
        createHash("sha256").update(k, "utf8").digest("hex")
      )
    })
  });
}

function safeAuditFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeValueHash(value: string): string {
  return createHash("sha256")
    .update("fermata-sse-unknown-finish-v1\0")
    .update(value)
    .digest("hex");
}

function parseSseEventData(event: string): unknown {
  const data = sseDataFields(event).join("\n");
  if (data.length === 0 || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

function sseDataFields(event: string): readonly string[] {
  return event.split("\n").flatMap((line) =>
    line === "data"
      ? [""]
      : line.startsWith("data:")
        ? [line.slice("data:".length).trimStart()]
        : []
  );
}

function safeShapeKeys(record: Record<string, unknown>): readonly string[] {
  return Object.freeze(
    Object.keys(record)
      .filter((key) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key))
      .sort()
      .slice(0, 32)
  );
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

function normalizeEventStreamText(
  trailingCarriageReturn: boolean,
  next: string,
  final: boolean
): {
  readonly text: string;
  readonly trailingCarriageReturn: boolean;
} {
  let text = next;
  let carried = trailingCarriageReturn;
  let prefix = "";
  if (carried && text.length > 0) {
    prefix = "\n";
    if (text.startsWith("\n")) {
      text = text.slice(1);
    }
    carried = false;
  }
  if (!final && text.endsWith("\r")) {
    text = text.slice(0, -1);
    carried = true;
  }
  const normalized = text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  let suffix = "";
  if (final && carried) {
    suffix = "\n";
    carried = false;
  }
  return {
    text: prefix + normalized + suffix,
    trailingCarriageReturn: carried
  };
}

interface EventStreamEventBuffer {
  readonly blocks: string[];
  readonly fragments: string[];
  length: number;
  pendingLineBreak: boolean;
}

const maximumEventStreamFragmentsPerBlock = 1_024;

function createEventStreamEventBuffer(): EventStreamEventBuffer {
  return {
    blocks: [],
    fragments: [],
    length: 0,
    pendingLineBreak: false
  };
}

function appendEventStreamEventText(
  buffer: EventStreamEventBuffer,
  text: string
): void {
  if (text.length === 0) return;
  buffer.fragments.push(text);
  buffer.length += text.length;
  assertRetainedLlmTextLength(buffer.length);
  if (buffer.fragments.length >= maximumEventStreamFragmentsPerBlock) {
    buffer.blocks.push(buffer.fragments.join(""));
    buffer.fragments.length = 0;
  }
}

function takeEventStreamEvent(buffer: EventStreamEventBuffer): string {
  if (buffer.fragments.length > 0) {
    buffer.blocks.push(buffer.fragments.join(""));
  }
  const event =
    buffer.blocks.length === 1 ? buffer.blocks[0]! : buffer.blocks.join("");
  buffer.blocks.length = 0;
  buffer.fragments.length = 0;
  buffer.length = 0;
  return event;
}

function clearEventStreamEventBuffer(buffer: EventStreamEventBuffer): void {
  buffer.blocks.length = 0;
  buffer.fragments.length = 0;
  buffer.length = 0;
  buffer.pendingLineBreak = false;
}

function consumeEventStreamText(
  text: string,
  buffer: EventStreamEventBuffer,
  consumeEvent: (event: string) => void,
  observePartialText: (text: string) => void
): void {
  let offset = 0;
  while (offset < text.length) {
    const lineBreak = text.indexOf("\n", offset);
    const end = lineBreak < 0 ? text.length : lineBreak;
    const part = text.slice(offset, end);
    if (part.length > 0) {
      if (buffer.pendingLineBreak) {
        appendEventStreamEventText(buffer, "\n");
        observePartialText("\n");
        buffer.pendingLineBreak = false;
      }
      appendEventStreamEventText(buffer, part);
      observePartialText(part);
    }
    if (lineBreak < 0) break;
    if (buffer.pendingLineBreak) {
      const event = takeEventStreamEvent(buffer);
      buffer.pendingLineBreak = false;
      consumeEvent(event);
    } else {
      buffer.pendingLineBreak = true;
    }
    offset = lineBreak + 1;
  }
}

function finishEventStreamEvents(
  buffer: EventStreamEventBuffer,
  consumeEvent: (event: string) => void
): void {
  buffer.pendingLineBreak = false;
  if (buffer.length > 0) {
    consumeEvent(takeEventStreamEvent(buffer));
  }
}

function updatePostDoneTailShape(
  state: ChatCompletionStreamState,
  next: PostDoneTailShape,
  observer: ResponseBodyActivityObserver
): void {
  const previous = state.postDoneTailShape;
  const merged = mergePostDoneTailShape(previous, next);
  if (previous === merged) return;
  state.postDoneTailShape = merged;
  if (previous === undefined) {
    // 一旦 DONE 后出现协议数据，先前答案不能再作为成功结果保留。
    state.content = "";
    state.reasoning = "";
  }
  observer.onInvalidResponseDrainStarted(
    "trailing_data",
    postDoneFailureSubstage(merged, false)
  );
}

function scanUnresolvedPostDoneData(
  appendedText: string,
  scan: PostDonePendingDataScan,
  state: ChatCompletionStreamState,
  observer: ResponseBodyActivityObserver
): void {
  if (!state.sawDone) {
    state.postDoneTailHasUnresolvedData = false;
    return;
  }
  for (const character of appendedText) {
    if (character === "\n") {
      if (
        scan.currentLineMayBeData &&
        scan.currentLinePrefix === "data"
      ) {
        scan.confirmedDataField = true;
      }
      scan.currentLineMayBeData = true;
      scan.currentLinePrefix = "";
      continue;
    }
    if (!scan.currentLineMayBeData) continue;
    const nextPrefix = scan.currentLinePrefix + character;
    if (nextPrefix === "data:") {
      scan.confirmedDataField = true;
      scan.currentLineMayBeData = false;
      scan.currentLinePrefix = "";
    } else if ("data".startsWith(nextPrefix)) {
      scan.currentLinePrefix = nextPrefix;
    } else {
      scan.currentLineMayBeData = false;
      scan.currentLinePrefix = "";
    }
  }
  state.postDoneTailHasUnresolvedData =
    scan.confirmedDataField ||
    (scan.currentLineMayBeData &&
      scan.currentLinePrefix.length > 0 &&
      "data".startsWith(scan.currentLinePrefix));
  if (scan.confirmedDataField) {
    publishUnresolvedPostDoneData(state, observer);
  }
}

function resetPostDonePendingDataScan(
  scan: PostDonePendingDataScan,
  state: ChatCompletionStreamState
): void {
  scan.confirmedDataField = false;
  scan.currentLineMayBeData = true;
  scan.currentLinePrefix = "";
  state.postDoneTailHasUnresolvedData = false;
}

function publishUnresolvedPostDoneData(
  state: ChatCompletionStreamState,
  observer: ResponseBodyActivityObserver
): void {
  // 事件未收齐时不猜它的字段。若在收齐前中断或取消，
  // 只能留下封闭的 tail-incomplete；后续收齐后再用真实形状升级。
  state.content = "";
  state.reasoning = "";
  observer.onInvalidResponseDrainStarted(
    "trailing_data",
    "data_after_done_tail_incomplete"
  );
}

function consumeObservedChatCompletionEvent(
  event: string,
  state: ChatCompletionStreamState,
  observer: ResponseBodyActivityObserver,
  audit: MutableLlmRequestAudit
): boolean {
  return consumeChatCompletionEvent(
    event,
    state,
    (shape) => updatePostDoneTailShape(state, shape, observer),
    audit
  );
}

function consumeChatCompletionEvent(
  event: string,
  state: ChatCompletionStreamState,
  observePostDoneShape: (shape: PostDoneTailShape) => void,
  audit: MutableLlmRequestAudit
): boolean {
  const dataFields = event
    .split("\n")
    .flatMap((line) =>
      line === "data"
        ? [""]
        : line.startsWith("data:")
          ? [line.slice("data:".length).trimStart()]
          : []
    );
  if (dataFields.length === 0) return false;
  const data = dataFields.join("\n").trim();
  if (state.sawDone) {
    // f 只记录封闭形状并继续解析整个尾部；无论形状如何都在 EOF 后失败。
    observePostDoneShape(classifyPostDoneData(data));
    return false;
  }
  if (data.length === 0) return false;
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
    // finish_reason=stop 之后，部分网关会继续发送只含空 delta 的事件
    // （重复 stop 信号或带 usage 的空 choice）。只有不含实际内容
    // （content / reasoning_content / reasoning 全部为空或不存在）的
    // 空 delta 事件可以安全忽略；任何带实际答案片段的 post-stop 事件
    // 仍然说明流不完整，必须拒绝。
    const postStopChoice = choices[0];
    if (typeof postStopChoice !== "object" || postStopChoice === null) {
      throw new LlmResponseFormatError("trailing_data", "choice_after_stop");
    }
    const postStopDeltaOrMessage =
      typeof (postStopChoice as Record<string, unknown>).delta === "object" &&
      (postStopChoice as Record<string, unknown>).delta !== null
        ? (postStopChoice as Record<string, unknown>).delta
        : (postStopChoice as Record<string, unknown>).message;
    if (typeof postStopDeltaOrMessage !== "object" || postStopDeltaOrMessage === null) {
      throw new LlmResponseFormatError("trailing_data", "choice_after_stop");
    }
    const postStopPart = postStopDeltaOrMessage as Record<string, unknown>;
    const hasPostStopContent =
      (typeof postStopPart.content === "string" && postStopPart.content.length > 0) ||
      (typeof postStopPart.reasoning_content === "string" && postStopPart.reasoning_content.length > 0) ||
      (typeof postStopPart.reasoning === "string" && postStopPart.reasoning.length > 0);
    if (hasPostStopContent) {
      throw new LlmResponseFormatError("trailing_data", "choice_after_stop");
    }
    return false;
  }
  const choice = choices[0];
  if (typeof choice !== "object" || choice === null) {
    throw new LlmResponseFormatError("event_shape");
  }
  state.sawChoice = true;
  const choiceRecord = choice as Record<string, unknown>;
  audit.finishReason = classifyFinishReason(
    fieldValue(choiceRecord, "finish_reason")
  );
  if (
    state.salvageOnLengthLimit &&
    choiceRecord.finish_reason === "length"
  ) {
    // 抢救路径：接受 finish_reason="length" 作为可抢救终止。
    // 先累积本事件的 reasoning/content，再在 EOF 校验完整性。
    // 不调用 assertSafeFinishReason（它会对 "length" 抛 LLM_OUTPUT_LENGTH_LIMIT）。
    // 不置 sawStop（避免触发 post-stop 尾部校验拒绝后续 reasoning 分片）。
    state.sawLengthSalvage = true;
  } else {
    assertSafeFinishReason(choiceRecord.finish_reason, "finish_shape");
  }
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
  assertRetainedLlmTextLength(state.reasoning.length + state.content.length);
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

/**
 * 被动计数：累计响应正文已读字节，只用于审计字段，不再做任何大小检查。
 * 原始正文总量没有固定上限；流式路径逐增量解析，正文从不在内存中整体保留。
 */
function addResponseChunkSize(totalBytes: number, nextBytes: number): number {
  return totalBytes + nextBytes;
}

/** 解析后保留文本（事件缓冲、抽取出的 reasoning/content、非流 JSON 正文）
 * 的每个唯一逐步累加点都必须经过这个护栏。正常提供商输出不可能触达。 */
function assertRetainedLlmTextLength(length: number): void {
  if (length > maximumRetainedLlmTextLength) {
    throw new LlmRetainedTextTooLargeError();
  }
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
