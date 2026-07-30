export const defaultLevelsRequestTimeoutMs = 600_000;

export interface LevelsCalibrationOptions {
  readonly label: string;
  readonly resumeFromLabel: string | null;
  readonly requestTimeoutMs: number;
  readonly maxAttempts: number;
}

interface ResolveLevelsCalibrationOptionsInput {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly configuredTimeoutMs: number;
  readonly configuredMaxAttempts: number;
}

/**
 * 标定会连续运行较慢的推理请求，不能沿用面向普通短请求的等待上限。
 * 环境变量只影响离线实验；正式服务仍读取 config/models.yaml。
 */
export function resolveLevelsCalibrationOptions(
  input: ResolveLevelsCalibrationOptionsInput
): LevelsCalibrationOptions {
  const rawLabel =
    input.argv.find((value) => value.startsWith("--label="))?.slice("--label=".length) ??
    "v1";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(rawLabel)) {
    throw new Error("--label 只能包含字母、数字、点、下划线和短横线，且不能超过 80 个字符。");
  }

  const resumeFromArgument = input.argv
    .find((value) => value.startsWith("--resume-from="))
    ?.slice("--resume-from=".length);
  if (input.argv.includes("--resume") && resumeFromArgument !== undefined) {
    throw new Error("--resume 和 --resume-from 不能同时使用。");
  }
  const resumeFromLabel = resumeFromArgument ?? (input.argv.includes("--resume") ? rawLabel : null);
  if (
    resumeFromLabel !== null &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(resumeFromLabel)
  ) {
    throw new Error("--resume-from 只能填写已有报告的安全标签。");
  }

  return {
    label: rawLabel,
    resumeFromLabel,
    requestTimeoutMs: parseBoundedInteger(
      input.env.LEVELS_LLM_TIMEOUT_MS,
      Math.max(input.configuredTimeoutMs, defaultLevelsRequestTimeoutMs),
      1_000,
      600_000,
      "LEVELS_LLM_TIMEOUT_MS"
    ),
    maxAttempts: parseBoundedInteger(
      input.env.LEVELS_LLM_MAX_ATTEMPTS,
      input.configuredMaxAttempts,
      1,
      10,
      "LEVELS_LLM_MAX_ATTEMPTS"
    )
  };
}

function parseBoundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return value;
}
