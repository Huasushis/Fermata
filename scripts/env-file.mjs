/**
 * 解析 Fermata 使用的简单 env 文件，并合并到已有环境。
 *
 * 已有环境变量优先，行为与之前的 run-with-env.mjs 保持一致。这里不执行变量
 * 展开，也不让 shell 解释任何值。
 */
export function mergeEnvFile(content, baseEnvironment) {
  const environment = { ...baseEnvironment };
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      continue;
    }
    let value = trimmed.slice(separatorIndex + 1);
    if (
      (value.startsWith('"') &&
        value.endsWith('"') &&
        value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in environment)) {
      environment[key] = value;
    }
  }
  return environment;
}
