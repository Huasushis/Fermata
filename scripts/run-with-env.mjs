#!/usr/bin/env node
/**
 * 用法：node scripts/run-with-env.mjs <env文件> <命令> [参数...]
 *       node scripts/run-with-env.mjs --review-flow-evaluation <env文件> [评测参数...]
 *       node scripts/run-with-env.mjs --development-diagnostic <env文件> --state-dir <绝对目录> [--authorize-plan <fingerprint>]
 * env 文件必须放在 Fermata/private/ 内。脚本不经过 shell，只向子进程传递
 * Fermata、实验、基本运行时与代理所需的明确白名单变量；已登记的 Fermata/
 * 实验变量由文件覆盖父环境，基本运行时和代理只从父环境继承。
 */
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertNoUnknownPrefixedEnvironmentKeys,
  assertSafeNodeEnvironment,
  parseEnvFile,
  selectEnvironment
} from "./env-file.mjs";
import { readProtectedEnvFile } from "./private-runtime.mjs";

const usage =
  "用法：node scripts/run-with-env.mjs <env文件> <命令> [参数...]\n" +
  "      node scripts/run-with-env.mjs --review-flow-evaluation <env文件> [评测参数...]\n" +
  "      node scripts/run-with-env.mjs --development-smoke <env文件> [--preflight|--preflight-phase1 --resume=<runId>|--network-phase0 [--resume=<runId>]|--network-phase1 --resume=<runId> --release-phase1]\n" +
  "      node scripts/run-with-env.mjs --difficulty-evaluation <env文件> --public-difficulty-smoke\n" +
  "      node scripts/run-with-env.mjs --development-diagnostic <env文件> --state-dir <绝对目录> [--authorize-plan <fingerprint>]\n";

export const reviewFlowEvaluationModeFlag = "--review-flow-evaluation";
export const developmentSmokeModeFlag = "--development-smoke";
export const developmentDiagnosticModeFlag = "--development-diagnostic";
export const difficultyEvaluationModeFlag = "--difficulty-evaluation";
export const reviewFlowEvaluationBootstrapPath = fileURLToPath(
  new URL("./review-flow-evaluation-bootstrap.mjs", import.meta.url)
);
export const developmentSmokeEntrypointPath = fileURLToPath(
  new URL("../experiments/run-development-smoke.ts", import.meta.url)
);
export const developmentSmokeTsxPath = fileURLToPath(
  new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)
);
export const developmentDiagnosticEntrypointPath = fileURLToPath(
  new URL("../experiments/run-development-diagnostic.ts", import.meta.url)
);
export const developmentDiagnosticTsxPath = fileURLToPath(
  new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)
);
export const difficultyEvaluationEntrypointPath = fileURLToPath(
  new URL("../experiments/eval-difficulty.ts", import.meta.url)
);
const forwardedSignals = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);

const allowedFermataEnvironmentKeys = [
  "AETHER_API_KEY",
  "AETHER_BASE_URL",
  "ANCHOR_COUNT",
  "CODEFORCES_KEY",
  "CODEFORCES_SECRET",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_BASE_URL",
  "DATA_SUBDIR",
  "EVAL_CODE_VERSION",
  "EVAL_CONCURRENCY",
  "EVAL_DATASET_MANIFEST_PATH",
  "EVAL_REQUIRE_DATASET_MANIFEST",
  "EVAL_SAMPLE_LIMIT",
  "EVAL_SAMPLE_IDS",
  "EVAL_ATTEMPT_CEILING",
  "FERMATA_MANAGEMENT_TOKEN",
  "FERMATA_PORT",
  "FERMATA_SETTINGS_PATH",
  "HF_PARQUET_URL",
  "LEVELS_LLM_FIRST_OUTPUT_MS",
  "LEVELS_LLM_MAX_ATTEMPTS",
  "LEVELS_LLM_MAX_DURATION_MS",
  "LEVELS_LLM_OUTPUT_IDLE_MS",
  "LEVELS_LLM_TIMEOUT_MS",
  "SAMPLE_SIZE_PER_BUCKET",
  "URMOTIV_BASE_URL",
  "URMOTIV_ROBOT_TOKEN",
  "VERDICT_CASES_PER_GROUP"
];
const allowedProxyEnvironmentKeys = [
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy"
];
const allowedBasicEnvironmentKeys = [
  "CI",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER"
];
export const allowedRunEnvironmentKeys = [
  ...allowedFermataEnvironmentKeys,
  ...allowedProxyEnvironmentKeys,
  ...allowedBasicEnvironmentKeys
];
const allowedRunFileEnvironmentKeys = [
  ...allowedFermataEnvironmentKeys
];
const protectedRunEnvironmentPrefixes = [
  "AETHER_",
  "CODEFORCES_",
  "DASHSCOPE_",
  "EVAL_",
  "FERMATA_",
  "LEVELS_",
  "URMOTIV_"
];

const allowedReviewFlowEvaluationFileEnvironmentKeys = [
  "AETHER_API_KEY",
  "AETHER_BASE_URL",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_BASE_URL",
  "EVAL_CODE_VERSION",
  "EVAL_CONCURRENCY"
];
const allowedDevelopmentSmokeFileEnvironmentKeys = [
  "AETHER_API_KEY",
  "AETHER_BASE_URL"
];
const allowedDifficultyEvaluationFileEnvironmentKeys = [
  "AETHER_API_KEY",
  "AETHER_BASE_URL",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_BASE_URL",
  "EVAL_CODE_VERSION",
  "EVAL_CONCURRENCY",
  "EVAL_DATASET_MANIFEST_PATH",
  "EVAL_REQUIRE_DATASET_MANIFEST",
  "EVAL_SAMPLE_LIMIT",
  "EVAL_SAMPLE_IDS",
  "EVAL_ATTEMPT_CEILING"
];
const allowedDevelopmentDiagnosticFileEnvironmentKeys = [
  "AETHER_API_KEY",
  "AETHER_BASE_URL",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_BASE_URL",
  "FERMATA_DEVELOPMENT_DIAGNOSTIC_MANIFEST"
];


/**
 * review-flow CLI 可用它对自己的最终进程环境做同一套白名单检查。标记和空值
 * NODE_* 是包装器的启动约定/清理结果，不构成不可伪造的安全证明。
 */
export const allowedReviewFlowEvaluationRunEnvironmentKeys = [
  ...allowedReviewFlowEvaluationFileEnvironmentKeys,
  ...allowedProxyEnvironmentKeys,
  ...allowedBasicEnvironmentKeys,
  "FERMATA_RUN_WITH_ENV",
  "FERMATA_REVIEW_FLOW_RUNTIME_ATTESTATION",
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
  "NODE_DISABLE_COMPILE_CACHE",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REDIRECT_WARNINGS",
  "NODE_V8_COVERAGE"
];

export function buildRunEnvironment(envFileContent, parentEnvironment) {
  assertSafeNodeEnvironment(parentEnvironment);
  const fileEnvironment = parseEnvFile(envFileContent);
  assertSafeNodeEnvironment(fileEnvironment);
  assertNoUnknownPrefixedEnvironmentKeys(
    parentEnvironment,
    allowedRunEnvironmentKeys,
    protectedRunEnvironmentPrefixes
  );
  assertNoUnknownPrefixedEnvironmentKeys(
    fileEnvironment,
    allowedRunFileEnvironmentKeys,
    [""]
  );
  return {
    ...selectEnvironment(parentEnvironment, allowedRunEnvironmentKeys),
    ...selectEnvironment(fileEnvironment, allowedRunFileEnvironmentKeys),
    // 只由本包装器在白名单过滤后注入，作为受控启动方式的约定标记。它不是
    // 不可伪造的安全证明；子进程仍须自行校验完整环境和运行时。
    FERMATA_RUN_WITH_ENV: "1",
    NODE_DEBUG: "",
    NODE_DEBUG_NATIVE: "",
    NODE_DISABLE_COMPILE_CACHE: "1",
    NODE_OPTIONS: "",
    NODE_PATH: "",
    NODE_REDIRECT_WARNINGS: "",
    NODE_V8_COVERAGE: ""
  };
}

export function buildReviewFlowEvaluationRunEnvironment(
  envFileContent,
  parentEnvironment
) {
  assertSafeNodeEnvironment(parentEnvironment);
  const fileEnvironment = parseEnvFile(envFileContent);
  assertSafeNodeEnvironment(fileEnvironment);
  const validatedParentKeys = [
    ...allowedReviewFlowEvaluationFileEnvironmentKeys,
    ...allowedProxyEnvironmentKeys,
    ...allowedBasicEnvironmentKeys
  ];
  assertNoUnknownPrefixedEnvironmentKeys(
    parentEnvironment,
    validatedParentKeys,
    protectedRunEnvironmentPrefixes
  );
  // 专用 env 文件只允许模型服务和这次评估的两个非密钥参数；机器人、管理端、
  // Codeforces、其它实验路径即使拼写正确也一律失败关闭。
  assertNoUnknownPrefixedEnvironmentKeys(
    fileEnvironment,
    allowedReviewFlowEvaluationFileEnvironmentKeys,
    [""]
  );
  for (const requiredKey of ["EVAL_CODE_VERSION", "EVAL_CONCURRENCY"]) {
    if (!Object.hasOwn(fileEnvironment, requiredKey)) {
      throw new Error("REVIEW_FLOW_EVALUATION_ENV_FILE_INCOMPLETE");
    }
  }
  if (
    !/^(?!0{40}$)[0-9a-f]{40}$/u.test(fileEnvironment.EVAL_CODE_VERSION) ||
    !/^(?:[1-4])$/u.test(fileEnvironment.EVAL_CONCURRENCY)
  ) {
    throw new Error("REVIEW_FLOW_EVALUATION_ENV_FILE_INCOMPLETE");
  }
  let configuredProviderCount = 0;
  for (const [baseUrlKey, apiKeyKey] of [
    ["AETHER_BASE_URL", "AETHER_API_KEY"],
    ["DASHSCOPE_BASE_URL", "DASHSCOPE_API_KEY"]
  ]) {
    const hasBaseUrl = Object.hasOwn(fileEnvironment, baseUrlKey);
    const hasApiKey = Object.hasOwn(fileEnvironment, apiKeyKey);
    if (hasBaseUrl !== hasApiKey) {
      throw new Error("REVIEW_FLOW_EVALUATION_ENV_FILE_INCOMPLETE");
    }
    if (hasBaseUrl) configuredProviderCount += 1;
  }
  if (configuredProviderCount === 0) {
    throw new Error("REVIEW_FLOW_EVALUATION_ENV_FILE_INCOMPLETE");
  }
  return {
    // 模型服务与本次实验参数只能来自专用文件。即使启动终端遗留同名值，
    // 也只做未知键检查，不继承、不补缺、更不能覆盖文件值。
    ...selectEnvironment(parentEnvironment, [
      ...allowedProxyEnvironmentKeys,
      ...allowedBasicEnvironmentKeys
    ]),
    ...selectEnvironment(
      fileEnvironment,
      allowedReviewFlowEvaluationFileEnvironmentKeys
    ),
    FERMATA_RUN_WITH_ENV: "1",
    NODE_DEBUG: "",
    NODE_DEBUG_NATIVE: "",
    NODE_DISABLE_COMPILE_CACHE: "1",
    NODE_OPTIONS: "",
    NODE_PATH: "",
    NODE_REDIRECT_WARNINGS: "",
    NODE_V8_COVERAGE: ""
  };
}
export function buildDevelopmentSmokeRunEnvironment(
  envFileContent,
  parentEnvironment
) {
  assertSafeNodeEnvironment(parentEnvironment);
  const fileEnvironment = parseEnvFile(envFileContent);
  assertSafeNodeEnvironment(fileEnvironment);
  assertNoUnknownPrefixedEnvironmentKeys(
    parentEnvironment,
    [
      ...allowedDevelopmentSmokeFileEnvironmentKeys,
      ...allowedProxyEnvironmentKeys,
      ...allowedBasicEnvironmentKeys
    ],
    protectedRunEnvironmentPrefixes
  );
  assertNoUnknownPrefixedEnvironmentKeys(
    fileEnvironment,
    allowedDevelopmentSmokeFileEnvironmentKeys,
    [""]
  );
  for (const requiredKey of allowedDevelopmentSmokeFileEnvironmentKeys) {
    if (!Object.hasOwn(fileEnvironment, requiredKey)) {
      throw new Error("DEVELOPMENT_SMOKE_ENV_FILE_INCOMPLETE");
    }
  }
  return {
    ...selectEnvironment(parentEnvironment, [
      ...allowedProxyEnvironmentKeys,
      ...allowedBasicEnvironmentKeys
    ]),
    ...selectEnvironment(
      fileEnvironment,
      allowedDevelopmentSmokeFileEnvironmentKeys
    ),
    FERMATA_RUN_WITH_ENV: "1",
    NODE_DEBUG: "",
    NODE_DEBUG_NATIVE: "",
    NODE_DISABLE_COMPILE_CACHE: "1",
    NODE_OPTIONS: "",
    NODE_PATH: "",
    NODE_REDIRECT_WARNINGS: "",
    NODE_V8_COVERAGE: ""
  };
}

export function buildDifficultyEvaluationRunEnvironment(
  envFileContent,
  parentEnvironment
) {
  assertSafeNodeEnvironment(parentEnvironment);
  const fileEnvironment = parseEnvFile(envFileContent);
  assertSafeNodeEnvironment(fileEnvironment);
  assertNoUnknownPrefixedEnvironmentKeys(
    parentEnvironment,
    [
      ...allowedDifficultyEvaluationFileEnvironmentKeys,
      ...allowedProxyEnvironmentKeys,
      ...allowedBasicEnvironmentKeys
    ],
    protectedRunEnvironmentPrefixes
  );
  assertNoUnknownPrefixedEnvironmentKeys(
    fileEnvironment,
    allowedDifficultyEvaluationFileEnvironmentKeys,
    [""]
  );
  for (const requiredKey of [
    "EVAL_CODE_VERSION",
    "EVAL_CONCURRENCY",
    "EVAL_SAMPLE_LIMIT",
    "EVAL_SAMPLE_IDS",
    "EVAL_ATTEMPT_CEILING"
  ]) {
    if (!Object.hasOwn(fileEnvironment, requiredKey)) {
      throw new Error("DIFFICULTY_EVALUATION_ENV_FILE_INCOMPLETE");
    }
  }
  if (!/^(?!0{40}$)[0-9a-f]{40}$/u.test(fileEnvironment.EVAL_CODE_VERSION)) {
    throw new Error("DIFFICULTY_EVALUATION_ENV_FILE_INCOMPLETE");
  }
  if (
    fileEnvironment.EVAL_CONCURRENCY.trim() !== "4" ||
    fileEnvironment.EVAL_SAMPLE_LIMIT.trim() !== "4" ||
    fileEnvironment.EVAL_ATTEMPT_CEILING.trim() !== "8"
  ) {
    throw new Error("DIFFICULTY_EVALUATION_ENV_FILE_INCOMPLETE");
  }
  const sampleIds = fileEnvironment.EVAL_SAMPLE_IDS.split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (
    sampleIds.length !== 4 ||
    new Set(sampleIds).size !== sampleIds.length ||
    sampleIds.some((id) => !/^[1-9][0-9]*[A-Z][0-9]{0,7}$/u.test(id))
  ) {
    throw new Error("DIFFICULTY_EVALUATION_ENV_FILE_INCOMPLETE");
  }
  let configuredProviderCount = 0;
  for (const [baseUrlKey, apiKeyKey] of [
    ["AETHER_BASE_URL", "AETHER_API_KEY"],
    ["DASHSCOPE_BASE_URL", "DASHSCOPE_API_KEY"]
  ]) {
    const hasBaseUrl = Object.hasOwn(fileEnvironment, baseUrlKey);
    const hasApiKey = Object.hasOwn(fileEnvironment, apiKeyKey);
    if (hasBaseUrl !== hasApiKey) {
      throw new Error("DIFFICULTY_EVALUATION_ENV_FILE_INCOMPLETE");
    }
    if (hasBaseUrl) configuredProviderCount += 1;
  }
  if (configuredProviderCount === 0) {
    throw new Error("DIFFICULTY_EVALUATION_ENV_FILE_INCOMPLETE");
  }
  return {
    ...selectEnvironment(parentEnvironment, [
      ...allowedProxyEnvironmentKeys,
      ...allowedBasicEnvironmentKeys
    ]),
    ...selectEnvironment(
      fileEnvironment,
      allowedDifficultyEvaluationFileEnvironmentKeys
    ),
    FERMATA_RUN_WITH_ENV: "1",
    NODE_DEBUG: "",
    NODE_DEBUG_NATIVE: "",
    NODE_DISABLE_COMPILE_CACHE: "1",
    NODE_OPTIONS: "",
    NODE_PATH: "",
    NODE_REDIRECT_WARNINGS: "",
    NODE_V8_COVERAGE: ""
  };
}

export function buildDevelopmentDiagnosticRunEnvironment(
  envFileContent,
  parentEnvironment
) {
  assertSafeNodeEnvironment(parentEnvironment);
  const fileEnvironment = parseEnvFile(envFileContent);
  assertSafeNodeEnvironment(fileEnvironment);
  assertNoUnknownPrefixedEnvironmentKeys(
    parentEnvironment,
    [
      ...allowedDevelopmentDiagnosticFileEnvironmentKeys,
      ...allowedProxyEnvironmentKeys,
      ...allowedBasicEnvironmentKeys,
      "FERMATA_DEVELOPMENT_DIAGNOSTIC_STARTUP_CONTRACT",
      "FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS",
      "FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS_ATTESTATION"
    ],
    protectedRunEnvironmentPrefixes
  );
  assertNoUnknownPrefixedEnvironmentKeys(
    fileEnvironment,
    allowedDevelopmentDiagnosticFileEnvironmentKeys,
    [""]
  );
  for (const [baseUrlKey, apiKeyKey] of [
    ["AETHER_BASE_URL", "AETHER_API_KEY"],
    ["DASHSCOPE_BASE_URL", "DASHSCOPE_API_KEY"]
  ]) {
    if (
      Object.hasOwn(fileEnvironment, baseUrlKey) !==
      Object.hasOwn(fileEnvironment, apiKeyKey)
    ) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_ENV_FILE_INCOMPLETE");
    }
  }
  return {
    ...selectEnvironment(parentEnvironment, [
      ...allowedProxyEnvironmentKeys,
      ...allowedBasicEnvironmentKeys
    ]),
    ...selectEnvironment(
      fileEnvironment,
      allowedDevelopmentDiagnosticFileEnvironmentKeys
    ),
    ...selectEnvironment(parentEnvironment, [
      "FERMATA_DEVELOPMENT_DIAGNOSTIC_STARTUP_CONTRACT",
      "FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS",
      "FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS_ATTESTATION"
    ]),
    FERMATA_RUN_WITH_ENV: "1",
    NODE_DEBUG: "",
    NODE_DEBUG_NATIVE: "",
    NODE_DISABLE_COMPILE_CACHE: "1",
    NODE_OPTIONS: "",
    NODE_PATH: "",
    NODE_REDIRECT_WARNINGS: "",
    NODE_V8_COVERAGE: ""
  };
}


export function createRunWithEnvSignalController() {
  let child;
  let requestedSignal = null;
  let forwarded = false;
  const forwardOnce = () => {
    if (child === undefined || requestedSignal === null || forwarded) return;
    forwarded = true;
    try {
      child.kill(requestedSignal);
    } catch {
      // 不把底层异常或命令路径带到终端；包装进程仍等待直接子进程收口。
    }
  };
  return {
    get closed() {
      return requestedSignal !== null;
    },
    request(signal) {
      if (!forwardedSignals.includes(signal) || requestedSignal !== null) return;
      requestedSignal = signal;
      forwardOnce();
    },
    attach(attachedChild) {
      if (child !== undefined) {
        throw new Error("RUN_WITH_ENV_CHILD_ALREADY_ATTACHED");
      }
      child = attachedChild;
      forwardOnce();
    }
  };
}

export function installRunWithEnvSignalHandlers(
  controller,
  processTarget = process
) {
  const handlers = new Map(
    forwardedSignals.map((signal) => [signal, () => controller.request(signal)])
  );
  for (const [signal, handler] of handlers) processTarget.on(signal, handler);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    for (const [signal, handler] of handlers) {
      processTarget.off(signal, handler);
    }
  };
}

export function assertDevelopmentSmokeArguments(args) {
  const resumeCount = args.filter((value) =>
    /^--resume=[a-f0-9]{64}$/u.test(value)
  ).length;
  const knownFlags = new Set([
    "--preflight",
    "--preflight-phase1",
    "--network-phase0",
    "--network-phase1",
    "--release-phase1"
  ]);
  const modeCount = [
    args.includes("--preflight"),
    args.includes("--preflight-phase1"),
    args.includes("--network-phase0"),
    args.includes("--network-phase1")
  ].filter(Boolean).length;
  if (
    args.length === 0 ||
    modeCount !== 1 ||
    resumeCount > 1 ||
    args.some((value) =>
      !knownFlags.has(value) && !/^--resume=[a-f0-9]{64}$/u.test(value)
    ) ||
    (args.includes("--preflight") && args.length !== 1) ||
    (args.includes("--preflight-phase1") &&
      (args.length !== 2 || resumeCount !== 1)) ||
    (args.includes("--network-phase0") &&
      (args.includes("--release-phase1") ||
        args.length !== 1 + resumeCount)) ||
    (args.includes("--network-phase1") &&
      (args.length !== 3 ||
        resumeCount !== 1 ||
        !args.includes("--release-phase1")))
  ) {
    throw new Error("RUN_WITH_ENV_INVALID_ARGUMENTS");
  }
}

export function assertDifficultyEvaluationArguments(args) {
  if (args.length !== 1 || args[0] !== "--public-difficulty-smoke") {
    throw new Error("RUN_WITH_ENV_INVALID_ARGUMENTS");
  }
}

export function assertDevelopmentDiagnosticArguments(args) {
  const seen = new Set();
  let hasStateDirectory = false;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      value === undefined ||
      (flag !== "--state-dir" && flag !== "--authorize-plan") ||
      seen.has(flag) ||
      value === "--" ||
      value.includes("\0")
    ) {
      throw new Error("RUN_WITH_ENV_INVALID_ARGUMENTS");
    }
    seen.add(flag);
    if (flag === "--state-dir") {
      if (!isAbsolute(value) || /[;&|`$<>\\\r\n]/u.test(value)) {
        throw new Error("RUN_WITH_ENV_INVALID_ARGUMENTS");
      }
      hasStateDirectory = true;
    } else if (!/^[0-9a-f]{64}$/u.test(value)) {
      throw new Error("RUN_WITH_ENV_INVALID_ARGUMENTS");
    }
  }
  if (!hasStateDirectory) throw new Error("RUN_WITH_ENV_INVALID_ARGUMENTS");
}

export function spawnRunCommand(command, environment, spawnProcess = spawn) {
  try {
    return spawnProcess(command[0], command.slice(1), {
      stdio: "inherit",
      env: environment,
      shell: false
    });
  } catch {
    throw new Error("CHILD_PROCESS_SPAWN_THROWN");
  }
}

export function runWithEnv(
  argv,
  {
    parentEnvironment = process.env,
    readEnvFile = (envPath) => readProtectedEnvFile(envPath),
    spawnProcess = spawn,
    signalController
  } = {}
) {
  if (signalController?.closed === true) return undefined;
  const dedicatedReviewFlowEvaluation =
    argv[0] === reviewFlowEvaluationModeFlag;
  const dedicatedDevelopmentSmoke =
    argv[0] === developmentSmokeModeFlag;
  const dedicatedDevelopmentDiagnostic =
    argv[0] === developmentDiagnosticModeFlag;
  const dedicatedDifficultyEvaluation =
    argv[0] === difficultyEvaluationModeFlag;
  const effectiveArguments =
    dedicatedReviewFlowEvaluation ||
    dedicatedDevelopmentSmoke ||
    dedicatedDevelopmentDiagnostic ||
    dedicatedDifficultyEvaluation
      ? argv.slice(1)
      : argv;
  const [envPath, ...remainingArguments] = effectiveArguments;
  if (
    envPath === undefined ||
    (!dedicatedReviewFlowEvaluation &&
      !dedicatedDevelopmentSmoke &&
      !dedicatedDevelopmentDiagnostic &&
      !dedicatedDifficultyEvaluation &&
      remainingArguments.length === 0) ||
    !isAbsolute(envPath)
  ) {
    throw new Error("RUN_WITH_ENV_INVALID_ARGUMENTS");
  }
  if (dedicatedDevelopmentSmoke) {
    assertDevelopmentSmokeArguments(remainingArguments);
  }
  if (dedicatedDifficultyEvaluation) {
    assertDifficultyEvaluationArguments(remainingArguments);
  }
  if (dedicatedDevelopmentDiagnostic) {
    assertDevelopmentDiagnosticArguments(remainingArguments);
  }
  if (
    !dedicatedDevelopmentDiagnostic &&
    remainingArguments.some((value) => {
      try {
        return resolve(value) === developmentDiagnosticEntrypointPath;
      } catch {
        return false;
      }
    })
  ) {
    throw new Error("RUN_WITH_ENV_INVALID_ARGUMENTS");
  }
  // 在接触可能含密钥的文件之前先拒绝会让 Node 回显或注入环境的父设置。
  assertSafeNodeEnvironment(parentEnvironment);
  const envFileContent = readEnvFile(resolve(envPath));
  const childEnvironment = dedicatedReviewFlowEvaluation
    ? buildReviewFlowEvaluationRunEnvironment(
        envFileContent,
        parentEnvironment
      )
    : dedicatedDevelopmentSmoke
      ? buildDevelopmentSmokeRunEnvironment(
          envFileContent,
          parentEnvironment
        )
      : dedicatedDevelopmentDiagnostic
        ? buildDevelopmentDiagnosticRunEnvironment(
            envFileContent,
            parentEnvironment
          )
        : dedicatedDifficultyEvaluation
          ? buildDifficultyEvaluationRunEnvironment(
              envFileContent,
              parentEnvironment
            )
          : buildRunEnvironment(envFileContent, parentEnvironment);
  // 付费 review-flow/development-smoke/difficulty-evaluation 模式不能经 PATH 解析 npm/tsx 或接受任意命令。
  // 包装器固定使用当前 Node 和仓库内绝对入口；其余参数只能是对应入口的参数。
  const command = dedicatedReviewFlowEvaluation
    ? [process.execPath, reviewFlowEvaluationBootstrapPath, ...remainingArguments]
    : dedicatedDevelopmentSmoke
      ? [
          process.execPath,
          developmentSmokeTsxPath,
          developmentSmokeEntrypointPath,
          ...remainingArguments
        ]
      : dedicatedDevelopmentDiagnostic
        ? [
            process.execPath,
            developmentDiagnosticTsxPath,
            developmentDiagnosticEntrypointPath,
            ...remainingArguments
          ]
        : dedicatedDifficultyEvaluation
          ? [
              process.execPath,
              developmentSmokeTsxPath,
              difficultyEvaluationEntrypointPath,
              ...remainingArguments
            ]
          : remainingArguments;
  if (signalController?.closed === true) return undefined;
  const child = spawnRunCommand(command, childEnvironment, spawnProcess);
  signalController?.attach(child);
  return child;
}

export function formatRunWithEnvFailure(error) {
  return error instanceof Error &&
    error.message === "RUN_WITH_ENV_INVALID_ARGUMENTS"
    ? usage
    : "无法安全启动指定命令。\n";
}

function isDirectEntry() {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

async function runDirectEntry() {
  const signalController = createRunWithEnvSignalController();
  const removeSignalHandlers = installRunWithEnvSignalHandlers(
    signalController
  );
  // 先让已经送达外层 PID 的信号有机会关闭启动闸门，再接触 env 文件。
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  let child;
  try {
    child = runWithEnv(process.argv.slice(2), { signalController });
  } catch (error) {
    removeSignalHandlers();
    process.stderr.write(formatRunWithEnvFailure(error));
    process.exitCode = 2;
  }

  if (child === undefined) {
    removeSignalHandlers();
    if (process.exitCode === undefined) process.exitCode = 1;
  } else {
    let settled = false;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      removeSignalHandlers();
      process.exitCode = code;
    };
    child.once("error", () => {
      process.stderr.write("子进程启动失败。\n");
      settle(1);
    });
    child.once("exit", (code) => {
      settle(code ?? 1);
    });
  }
}

if (isDirectEntry()) void runDirectEntry();
