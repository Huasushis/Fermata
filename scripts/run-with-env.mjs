#!/usr/bin/env node
/**
 * 用法：node scripts/run-with-env.mjs <env文件> <命令> [参数...]
 *
 * env 文件必须放在 Fermata/private/ 内。脚本不经过 shell，只向子进程传递
 * Fermata、实验、基本运行时与代理所需的明确白名单变量；已登记的 Fermata/
 * 实验变量由文件覆盖父环境，基本运行时和代理只从父环境继承。
 */
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoUnknownPrefixedEnvironmentKeys,
  assertSafeNodeEnvironment,
  parseEnvFile,
  selectEnvironment
} from "./env-file.mjs";
import { readProtectedEnvFile } from "./private-runtime.mjs";

const usage =
  "用法：node scripts/run-with-env.mjs <env文件> <命令> [参数...]\n";

const allowedFermataEnvironmentKeys = [
  "AETHER_API_KEY",
  "AETHER_BASE_URL",
  "ANCHOR_COUNT",
  "CODEFORCES_KEY",
  "CODEFORCES_SECRET",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_BASE_URL",
  "DATA_SUBDIR",
  "EVAL_CONCURRENCY",
  "EVAL_DATASET_MANIFEST_PATH",
  "EVAL_REQUIRE_DATASET_MANIFEST",
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
export const allowedRunEnvironmentKeys = [
  ...allowedFermataEnvironmentKeys,
  ...allowedProxyEnvironmentKeys,
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
    NODE_DEBUG: "",
    NODE_DEBUG_NATIVE: "",
    NODE_DISABLE_COMPILE_CACHE: "1",
    NODE_OPTIONS: "",
    NODE_PATH: "",
    NODE_REDIRECT_WARNINGS: "",
    NODE_V8_COVERAGE: ""
  };
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
    spawnProcess = spawn
  } = {}
) {
  const [envPath, ...command] = argv;
  if (
    envPath === undefined ||
    command.length === 0 ||
    !isAbsolute(envPath)
  ) {
    throw new Error("RUN_WITH_ENV_INVALID_ARGUMENTS");
  }
  // 在接触可能含密钥的文件之前先拒绝会让 Node 回显或注入环境的父设置。
  assertSafeNodeEnvironment(parentEnvironment);
  const childEnvironment = buildRunEnvironment(
    readEnvFile(resolve(envPath)),
    parentEnvironment
  );
  return spawnRunCommand(command, childEnvironment, spawnProcess);
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

if (isDirectEntry()) {
  let child;
  try {
    child = runWithEnv(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(formatRunWithEnvFailure(error));
    process.exitCode = 2;
  }

  if (child !== undefined) {
    child.once("error", () => {
      process.stderr.write("子进程启动失败。\n");
      process.exitCode = 1;
    });
    child.once("exit", (code) => {
      process.exitCode = code ?? 1;
    });
  }
}
