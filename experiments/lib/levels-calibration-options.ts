export const defaultLevelsOutputIdleTimeoutMs = 10 * 60 * 1_000;
export const defaultLevelsFirstOutputTimeoutMs = 30 * 60 * 1_000;
export const defaultLevelsMaximumDurationMs = 4 * 60 * 60 * 1_000;
export const defaultLevelsConcurrency = 4;

export interface LevelsCalibrationOptions {
  readonly label: string;
  readonly resumeFromLabel: string | null;
  readonly outputIdleTimeoutMs: number;
  readonly firstOutputTimeoutMs: number;
  readonly maximumDurationMs: number;
  readonly maxAttempts: number;
  readonly concurrency: number;
}

interface ResolveLevelsCalibrationOptionsInput {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly configuredOutputIdleTimeoutMs: number;
  readonly configuredFirstOutputTimeoutMs: number;
  readonly configuredMaximumDurationMs: number;
  readonly configuredMaxAttempts: number;
}

/**
 * 标定会连续运行较慢的推理请求，不能沿用面向普通短请求的等待上限。
 * 环境变量只影响离线实验；正式服务仍读取 config/models.yaml。
 */
export function resolveLevelsCalibrationOptions(
  input: ResolveLevelsCalibrationOptionsInput
): LevelsCalibrationOptions {
  if (input.env.LEVELS_LLM_TIMEOUT_MS !== undefined) {
    throw new Error(
      "LEVELS_LLM_TIMEOUT_MS 已不再支持；请分别使用 LEVELS_LLM_OUTPUT_IDLE_MS、LEVELS_LLM_FIRST_OUTPUT_MS 和 LEVELS_LLM_MAX_DURATION_MS。"
    );
  }
  const argumentsResult = parseCalibrationArguments(input.argv);
  const rawLabel = argumentsResult.label ?? "v1";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(rawLabel)) {
    throw new Error("--label 只能包含字母、数字、点、下划线和短横线，且不能超过 80 个字符。");
  }

  const resumeFromLabel = argumentsResult.resume ? rawLabel : null;

  const outputIdleTimeoutMs = parseBoundedInteger(
    input.env.LEVELS_LLM_OUTPUT_IDLE_MS,
    Math.max(
      input.configuredOutputIdleTimeoutMs,
      defaultLevelsOutputIdleTimeoutMs
    ),
    defaultLevelsOutputIdleTimeoutMs,
    24 * 60 * 60 * 1_000,
    "LEVELS_LLM_OUTPUT_IDLE_MS"
  );
  const firstOutputTimeoutMs = parseBoundedInteger(
    input.env.LEVELS_LLM_FIRST_OUTPUT_MS,
    Math.max(
      input.configuredFirstOutputTimeoutMs,
      defaultLevelsFirstOutputTimeoutMs
    ),
    defaultLevelsFirstOutputTimeoutMs,
    24 * 60 * 60 * 1_000,
    "LEVELS_LLM_FIRST_OUTPUT_MS"
  );
  const maximumDurationMs = parseBoundedInteger(
    input.env.LEVELS_LLM_MAX_DURATION_MS,
    Math.max(
      input.configuredMaximumDurationMs,
      defaultLevelsMaximumDurationMs
    ),
    defaultLevelsMaximumDurationMs,
    24 * 60 * 60 * 1_000,
    "LEVELS_LLM_MAX_DURATION_MS"
  );
  if (
    maximumDurationMs < outputIdleTimeoutMs ||
    maximumDurationMs < firstOutputTimeoutMs
  ) {
    throw new Error(
      "LEVELS_LLM_MAX_DURATION_MS 不能小于 LEVELS_LLM_OUTPUT_IDLE_MS 或 LEVELS_LLM_FIRST_OUTPUT_MS。"
    );
  }

  return {
    label: rawLabel,
    resumeFromLabel,
    outputIdleTimeoutMs,
    firstOutputTimeoutMs,
    maximumDurationMs,
    maxAttempts: parseBoundedInteger(
      input.env.LEVELS_LLM_MAX_ATTEMPTS,
      input.configuredMaxAttempts,
      1,
      10,
      "LEVELS_LLM_MAX_ATTEMPTS"
    ),
    concurrency: parseBoundedInteger(
      input.env.EVAL_CONCURRENCY,
      defaultLevelsConcurrency,
      1,
      32,
      "EVAL_CONCURRENCY"
    )
  };
}

function parseCalibrationArguments(argv: readonly string[]): {
  readonly label: string | undefined;
  readonly resume: boolean;
} {
  let label: string | undefined;
  let resume = false;
  for (const argument of argv) {
    if (argument === "--resume") {
      if (resume) {
        throw new Error("--resume 不能重复填写。");
      }
      resume = true;
      continue;
    }
    if (argument.startsWith("--label=")) {
      if (label !== undefined) {
        throw new Error("--label 不能重复填写。");
      }
      label = argument.slice("--label=".length);
      continue;
    }
    throw new Error("存在不支持的标定参数。");
  }
  return { label, resume };
}

function parseBoundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  const trimmed = raw?.trim();
  if (
    trimmed !== undefined &&
    trimmed !== "" &&
    !/^\d+$/.test(trimmed)
  ) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  const value =
    trimmed === undefined || trimmed === "" ? fallback : Number(trimmed);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return value;
}
