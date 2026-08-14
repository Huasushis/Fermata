/**
 * 极简日志封装。硬性规则（见 AGENTS.md）：
 *   - 绝不打印 API 密钥、机器人令牌、管理令牌等任何密钥；
 *   - 绝不打印题面/题解全文，只打印题目编号和文本长度。
 *
 * 这里不是一个通用日志框架，只是几个帮助函数 + 一个把结构化字段和消息拼在一起
 * 输出到 stdout/stderr 的小工具，避免每个调用点各自拼字符串、各自决定要不要
 * 打印敏感字段。
 */
import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

const allowedErrorCodes = new Set([
  "CONFIG_INVALID",
  "LLM_HTTP_ERROR",
  "LLM_NETWORK_FAILED",
  "LLM_FIRST_OUTPUT_TIMEOUT",
  "LLM_OUTPUT_IDLE_TIMEOUT",
  "LLM_TOTAL_TIMEOUT",
  "LLM_STREAM_INTERRUPTED",
  "LLM_CANCELLED",
  "LLM_OUTPUT_LENGTH_LIMIT",
  "LLM_OUTPUT_CONTENT_FILTERED",
  "LLM_RETAINED_TEXT_TOO_LARGE",
  "LLM_RESPONSE_FORMAT_INVALID",
  "LLM_JSON_OUTPUT_INVALID",
  "LEVELS_DATA_DIRECTORY_UNREADABLE",
  "LEVELS_DATA_READ_FAILED",
  "LEVELS_DATASET_EMPTY",
  "LEVELS_DATA_PRECHECK_FAILED",
  "LEVELS_FINGERPRINT_BUILD_FAILED",
  "LEVELS_PIPELINE_SOURCE_READ_FAILED",
  "LEVELS_CHECKPOINT_MISSING",
  "LEVELS_CHECKPOINT_READ_FAILED",
  "LEVELS_CHECKPOINT_INVALID",
  "LEVELS_CHECKPOINT_VERSION_UNSUPPORTED",
  "LEVELS_CHECKPOINT_METADATA_MISMATCH",
  "LEVELS_FINGERPRINT_MISMATCH",
  "LEVELS_LABEL_ALREADY_USED",
  "LEVELS_LABEL_CHECK_FAILED",
  "LEVELS_OUTPUT_DIRECTORY_FAILED",
  "LEVELS_ATOMIC_WRITE_FAILED",
  "LEVELS_LABEL_LOCKED",
  "LEVELS_LOCK_FAILED",
  "LEVELS_BLIND_CONTENT_MISMATCH",
  "LEVELS_BLIND_GOLD_MISMATCH",
  "LEVELS_RESUME_SOURCE_LOCKED",
  "LEVELS_CROSS_LABEL_RESUME_UNSUPPORTED",
  "LEVELS_REPORT_RUN_ALREADY_USED",
  "BLIND_CONTENT_DOCUMENT_INVALID",
  "BLIND_GOLD_DOCUMENT_INVALID",
  "BLIND_CONTENT_CONTAINER_INVALID",
  "BLIND_CONTENT_CONTAINER_IDENTITY_MISMATCH",
  "BLIND_CONTENT_GOLD_IDENTITY_MISMATCH",
  "BLIND_EVALUATION_SAMPLE_SET_MISMATCH",
  "BLIND_CONTENT_SUBSET_EMPTY",
  "BLIND_CONTENT_SUBSET_MISMATCH",
  "BLIND_DATASET_ROLE_MISMATCH",
  "BLIND_DATASET_SAMPLE_OVERLAP",
  "BLIND_DATASET_IDENTITY_INVALID",
  "BLIND_DATASET_PRECHECK_FAILED",
  "BLIND_INFERENCE_STOPPED",
  "RECENT_CONTEST_FILTER_UNAVAILABLE",
  "CODEFORCES_DATASET_PROBLEM_IDENTITY_INVALID",
  "CODEFORCES_DATASET_SAMPLE_SIZE_INVALID",
  "CODEFORCES_DATASET_BUCKET_INCOMPLETE",
  "CODEFORCES_DATASET_FETCH_INCOMPLETE",
  "DIFFICULTY_CHECKPOINT_VERSION_UNSUPPORTED",
  "VERDICT_BLIND_GOLD_MISSING",
  "VERDICT_CHECKPOINT_LOCKED_OR_UNAVAILABLE",
  "VERDICT_CHECKPOINT_LOCK_NOT_HELD",
  "VERDICT_CHECKPOINT_LOCK_OWNERSHIP_LOST",
  "VERDICT_CHECKPOINT_INVALID",
  "VERDICT_CHECKPOINT_VERSION_UNSUPPORTED",
  "VERDICT_CHECKPOINT_FINGERPRINT_MISMATCH",
  "VERDICT_CHECKPOINT_LOCK_WRITE_FAILED",
  "VERDICT_CHECKPOINT_WRITE_FAILED",
  "VERDICT_CHECKPOINT_PROCESS_IDENTITY_UNAVAILABLE",
  "VERDICT_CHECKPOINT_CASE_SET_INVALID",
  "VERDICT_CHECKPOINT_SAMPLE_NOT_PENDING",
  "VERDICT_CHECKPOINT_SAMPLE_NOT_ACTIVE",
  "VERDICT_CHECKPOINT_SAMPLE_UNKNOWN",
  "VERDICT_CHECKPOINT_REPORT_NOT_PUBLISHABLE",
  "VERDICT_CHECKPOINT_CLOSED"
]);

function write(stream: NodeJS.WriteStream, level: string, message: string, fields?: LogFields): void {
  const timestamp = new Date().toISOString();
  const suffix = fields === undefined ? "" : " " + formatFields(fields);
  stream.write(`${timestamp} [${level}] ${message}${suffix}\n`);
}

function formatFields(fields: LogFields): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
}

export function logInfo(message: string, fields?: LogFields): void {
  write(process.stdout, "INFO", message, fields);
}

export function logWarn(message: string, fields?: LogFields): void {
  write(process.stderr, "WARN", message, fields);
}

export function logError(message: string, error?: unknown, fields?: LogFields): void {
  const errorFields: LogFields =
    error === undefined ? {} : { errorCode: describeError(error) };
  write(process.stderr, "ERROR", message, { ...fields, ...errorFields });
}

/**
 * 把任意文本变成"安全打日志"的摘要：只留长度，不留内容。用于题面、题解、
 * LLM 原始输出等任何可能很长或包含题目内容的字符串。
 */
export function describeText(text: string): { length: number } {
  return { length: text.length };
}

/**
 * 把未知错误转成固定错误码。Error.message 可能来自模型服务、损坏的 JSON 或
 * 文件系统，其中可能夹带题面、题解、模型输出或路径，因此日志一律不记录 message。
 */
export function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && allowedErrorCodes.has(code)) {
      return code;
    }
  }
  if (error instanceof SyntaxError) {
    return "PARSE_ERROR";
  }
  if (error instanceof Error && error.name === "ZodError") {
    return "VALIDATION_ERROR";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "REQUEST_ABORTED";
  }
  return "UNEXPECTED_ERROR";
}

/**
 * 常量时间字符串比较，用于校验 Bearer 令牌，避免时序攻击泄露令牌前缀信息。
 * 长度不同时直接返回 false（长度差异本身不构成有意义的时序信息，因为攻击者
 * 大多已经知道目标令牌的长度约定或可以先用固定长度探测）。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a, "utf8");
  const bBytes = Buffer.from(b, "utf8");
  // node:crypto 的 timingSafeEqual 要求两个 buffer 长度相同，否则直接抛异常；
  // 长度不同本身就意味着不相等，在这里提前返回不会泄露有意义的时序信息
  // （请求方在此之前既不知道也无法用这一个 false 反推出令牌的具体长度差）。
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  return nodeTimingSafeEqual(aBytes, bBytes);
}
