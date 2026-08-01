/**
 * 解析 Fermata 使用的简单 env 文件。
 *
 * 不执行变量展开，也不让 shell 解释任何值。env 文件中的值明确覆盖父环境中
 * 的同名值，避免启动终端里遗留的实验参数静默改变一次已登记的实验。
 */

const dangerousNodeEnvironmentKeys = new Set([
  "NODE_CHANNEL_FD",
  "NODE_COMPILE_CACHE",
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
  "NODE_EXTRA_CA_CERTS",
  "NODE_ICU_DATA",
  "NODE_INSPECT_RESUME_ON_START",
  "NODE_OPENSSL_CONF",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REDIRECT_WARNINGS",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_UNIQUE_ID",
  "NODE_V8_COVERAGE",
  "OPENSSL_CONF"
]);

export class EnvironmentInputError extends Error {
  constructor(code) {
    super(code);
    this.name = "EnvironmentInputError";
    this.code = code;
  }
}

function failEnvironment(code) {
  throw new EnvironmentInputError(code);
}

export function parseEnvFile(content) {
  if (typeof content !== "string") {
    failEnvironment("ENV_FILE_NOT_TEXT");
  }
  // Node 的 spawn 会在环境值含 NUL 时同步抛错。必须在创建子进程前用固定错误
  // 拒绝，不能让底层异常把带密钥的值拼进终端或日志。
  if (content.includes("\0")) {
    failEnvironment("ENV_FILE_CONTAINS_NUL");
  }

  const fileEnvironment = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      failEnvironment("ENV_FILE_MALFORMED_LINE");
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      failEnvironment("ENV_FILE_MALFORMED_KEY");
    }
    if (Object.hasOwn(fileEnvironment, key)) {
      failEnvironment("ENV_FILE_DUPLICATE_KEY");
    }
    let value = trimmed.slice(separatorIndex + 1);
    if (
      (value.startsWith('"') || value.endsWith('"')) &&
      !(value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    ) {
      failEnvironment("ENV_FILE_UNBALANCED_QUOTE");
    }
    if (
      (value.startsWith("'") || value.endsWith("'")) &&
      !(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      failEnvironment("ENV_FILE_UNBALANCED_QUOTE");
    }
    if (
      (value.startsWith('"') &&
        value.endsWith('"') &&
        value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    fileEnvironment[key] = value;
  }
  return fileEnvironment;
}

/**
 * env 文件明确优先；父环境只给文件没有设置的变量提供默认值。
 */
export function mergeEnvFile(content, baseEnvironment) {
  return {
    ...baseEnvironment,
    ...parseEnvFile(content)
  };
}

/**
 * 拒绝能注入 Node 启动参数、调试输出、模块路径、信任根或输出文件的变量。
 * 空字符串没有效果，可以安全保留；TLS 的特殊开关只有值为 0 时危险。
 */
export function assertSafeNodeEnvironment(environment) {
  for (const key of dangerousNodeEnvironmentKeys) {
    const value = environment[key];
    if (typeof value === "string" && value.trim() !== "") {
      failEnvironment("DANGEROUS_NODE_ENVIRONMENT");
    }
  }
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED?.trim() === "0") {
    failEnvironment("TLS_VERIFICATION_DISABLED");
  }
}

export function selectEnvironment(environment, allowedKeys) {
  const selected = {};
  for (const key of allowedKeys) {
    const value = environment[key];
    if (typeof value === "string") {
      if (value.includes("\0")) {
        failEnvironment("PARENT_ENVIRONMENT_CONTAINS_NUL");
      }
      selected[key] = value;
    }
  }
  return selected;
}

export function assertNoUnknownPrefixedEnvironmentKeys(
  environment,
  allowedKeys,
  protectedPrefixes
) {
  const allowed = new Set(allowedKeys);
  for (const [key, value] of Object.entries(environment)) {
    if (
      typeof value === "string" &&
      protectedPrefixes.some((prefix) => key.startsWith(prefix)) &&
      !allowed.has(key)
    ) {
      failEnvironment("UNKNOWN_PROTECTED_ENVIRONMENT_KEY");
    }
  }
}
