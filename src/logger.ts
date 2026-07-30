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
  const errorFields: LogFields = error === undefined ? {} : { error: describeError(error) };
  write(process.stderr, "ERROR", message, { ...errorFields, ...fields });
}

/**
 * 把任意文本变成"安全打日志"的摘要：只留长度，不留内容。用于题面、题解、
 * LLM 原始输出等任何可能很长或包含题目内容的字符串。
 */
export function describeText(text: string): { length: number } {
  return { length: text.length };
}

/**
 * 把 Error 转成安全的字符串：只取 name + message，不取 stack（stack 有时会
 * 意外包含请求参数），调用方如果需要 stack 用于内部排查，应自己决定是否打印，
 * 本函数的默认行为偏保守。
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
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
