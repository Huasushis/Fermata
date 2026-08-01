#!/usr/bin/env node
/**
 * 在服务器上脱离当前 SSH 会话启动思维/代码难度标定。
 *
 * 本脚本只负责安全地固定启动 calibrate-levels；不会接受任意命令，也不会让
 * shell 解释参数。env 文件使用和 run-with-env.mjs 相同的规则读取，密钥不会
 * 写入本脚本的日志或元数据。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertNoUnknownPrefixedEnvironmentKeys,
  assertSafeNodeEnvironment,
  parseEnvFile,
  selectEnvironment
} from "./env-file.mjs";
import {
  anchoredPrivatePath,
  closePrivateDirectory,
  preparePrivateDirectory as prepareProtectedPrivateDirectory,
  readProtectedEnvFile,
  repositoryRoot
} from "./private-runtime.mjs";

const usage =
  "用法：npm run experiment:calibrate-levels:detached -- " +
  "--environment-file=<服务器私有 env 文件绝对路径> " +
  "--private-dir=<服务器私有运行目录绝对路径> " +
  "--label=<标签> [--resume]\n";
const safeLabelPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const allowedCalibrationEnvironmentKeys = [
  "AETHER_API_KEY",
  "AETHER_BASE_URL",
  "CODEFORCES_KEY",
  "CODEFORCES_SECRET",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_BASE_URL",
  "EVAL_CONCURRENCY",
  "FERMATA_MANAGEMENT_TOKEN",
  "FERMATA_PORT",
  "FERMATA_SETTINGS_PATH",
  "LEVELS_LLM_FIRST_OUTPUT_MS",
  "LEVELS_LLM_MAX_ATTEMPTS",
  "LEVELS_LLM_MAX_DURATION_MS",
  "LEVELS_LLM_OUTPUT_IDLE_MS",
  "LEVELS_LLM_TIMEOUT_MS",
  "URMOTIV_BASE_URL",
  "URMOTIV_ROBOT_TOKEN"
];
const allowedInheritedEnvironmentKeys = [
  ...allowedCalibrationEnvironmentKeys,
  "ALL_PROXY",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_COLOR",
  "NO_PROXY",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy"
];
const protectedCalibrationEnvironmentPrefixes = [
  "AETHER_",
  "CODEFORCES_",
  "DASHSCOPE_",
  "EVAL_",
  "FERMATA_",
  "LEVELS_",
  "URMOTIV_"
];
const calibrationWorkerPath = resolve(
  repositoryRoot,
  "scripts",
  "detached-calibration-worker.mjs"
);

class LauncherInputError extends Error {}

function failInput(message) {
  throw new LauncherInputError(message);
}

export function parseArguments(argv) {
  const values = new Map();
  let resume = false;

  for (const argument of argv) {
    if (argument === "--resume") {
      if (resume) {
        failInput("--resume 不能重复填写。");
      }
      resume = true;
      continue;
    }

    const separatorIndex = argument.indexOf("=");
    if (separatorIndex < 3) {
      failInput("存在不支持或格式错误的参数。");
    }
    const name = argument.slice(0, separatorIndex);
    const value = argument.slice(separatorIndex + 1);
    if (
      ![
        "--environment-file",
        "--private-dir",
        "--label"
      ].includes(name) ||
      value === "" ||
      values.has(name)
    ) {
      failInput("存在不支持、缺少值或重复的参数。");
    }
    values.set(name, value);
  }

  const envFile = values.get("--environment-file");
  const privateDirectory = values.get("--private-dir");
  const label = values.get("--label");
  if (
    envFile === undefined ||
    privateDirectory === undefined ||
    label === undefined
  ) {
    failInput("--environment-file、--private-dir 和 --label 都必须填写。");
  }
  if (!isAbsolute(envFile) || !isAbsolute(privateDirectory)) {
    failInput("env 文件和私有运行目录都必须使用服务器绝对路径。");
  }
  if (!safeLabelPattern.test(label)) {
    failInput(
      "--label 只能包含字母、数字、点、下划线和短横线，且不能超过 80 个字符。"
    );
  }
  return {
    envFile: resolve(envFile),
    privateDirectory: resolve(privateDirectory),
    label,
    resume
  };
}

export function preparePrivateDirectory(privateDirectory, options) {
  try {
    return prepareProtectedPrivateDirectory(privateDirectory, options);
  } catch (error) {
    if (error instanceof LauncherInputError) {
      throw error;
    }
    failInput(
      "私有运行目录必须位于 Fermata/private 内，且目录链均为当前用户所有的 0700 普通目录。"
    );
  }
}

export function readPrivateEnvFile(envFile, options) {
  try {
    return readProtectedEnvFile(envFile, options);
  } catch (error) {
    if (error instanceof LauncherInputError) {
      throw error;
    }
    failInput(
      "env 文件必须位于 Fermata/private 内，且是当前用户所有、没有组或其他用户权限的普通文件。"
    );
  }
}

export function openPrivateFile(path) {
  const descriptor = openSync(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0),
    0o600
  );
  fchmodSync(descriptor, 0o600);
  return descriptor;
}

function writeAll(descriptor, text, position = null) {
  const content = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < content.length) {
    const bytesWritten = writeSync(
      descriptor,
      content,
      offset,
      content.length - offset,
      position === null ? null : position + offset
    );
    if (bytesWritten <= 0) {
      throw new Error("PRIVATE_FILE_WRITE_FAILED");
    }
    offset += bytesWritten;
  }
}

function syncPrivateDirectory(privateDirectory, privateDirectoryHandle) {
  if (privateDirectoryHandle !== undefined) {
    fsyncSync(privateDirectoryHandle.descriptor);
    return;
  }
  let descriptor;
  try {
    descriptor = openSync(
      privateDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY
    );
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

export function writePrivateJsonAtomically(
  privateDirectory,
  fileName,
  value,
  privateDirectoryHandle
) {
  const temporaryFileName =
    `.${fileName}.tmp-${randomBytes(8).toString("hex")}`;
  const targetPath =
    privateDirectoryHandle === undefined
      ? resolve(privateDirectory, fileName)
      : anchoredPrivatePath(privateDirectoryHandle, fileName);
  const temporaryPath =
    privateDirectoryHandle === undefined
      ? resolve(privateDirectory, temporaryFileName)
      : anchoredPrivatePath(privateDirectoryHandle, temporaryFileName);
  let descriptor;
  try {
    descriptor = openPrivateFile(temporaryPath);
    writeAll(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, targetPath);
    syncPrivateDirectory(privateDirectory, privateDirectoryHandle);
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 临时文件仍会在下面按固定路径清理。
      }
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // 文件可能已经完成原子替换；不输出底层路径或错误。
    }
    throw new Error("PRIVATE_METADATA_WRITE_FAILED");
  }
}

export function waitUntilSpawned(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    const handleSpawn = () => {
      child.off("error", handleError);
      resolvePromise();
    };
    const handleError = () => {
      child.off("spawn", handleSpawn);
      rejectPromise(new Error("DETACHED_PROCESS_START_FAILED"));
    };
    child.once("spawn", handleSpawn);
    child.once("error", handleError);
  });
}

export function authorizeCalibrationStart(child) {
  const gate = child.stdin;
  if (gate === null || typeof gate.end !== "function") {
    return Promise.reject(new Error("DETACHED_PROCESS_GATE_MISSING"));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const handleError = () => {
      if (!settled) {
        settled = true;
        rejectPromise(new Error("DETACHED_PROCESS_GATE_FAILED"));
      }
    };
    const handleClose = () => {
      gate.off("error", handleError);
    };
    gate.on("error", handleError);
    gate.once("close", handleClose);
    try {
      gate.end("START\n", () => {
        if (!settled) {
          settled = true;
          resolvePromise();
        }
      });
    } catch {
      gate.off("error", handleError);
      gate.off("close", handleClose);
      settled = true;
      rejectPromise(new Error("DETACHED_PROCESS_GATE_FAILED"));
    }
  });
}

export function terminateDetachedChild(child, killProcessGroup = process.kill) {
  // 生产调用只接受本启动器刚用固定 executable/worker/cwd 创建的 ChildProcess；
  // 不接收外部 PID，也不按 node/python 等进程名做批量终止。
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    return;
  }
  try {
    killProcessGroup(-child.pid, "SIGTERM");
  } catch {
    // 进程可能已经自行退出；这里不能把底层错误或命令信息写到终端。
  }
}

function createChildExitWaiter(child) {
  let exited =
    Number.isInteger(child.exitCode) || typeof child.signalCode === "string";
  let resolveExit;
  const exitPromise = new Promise((resolvePromise) => {
    resolveExit = resolvePromise;
  });
  const handleExit = () => {
    exited = true;
    resolveExit(true);
  };
  if (!exited && typeof child.once === "function") {
    child.once("exit", handleExit);
    child.once("close", handleExit);
  }
  return {
    hasExited: () => exited,
    async wait(timeoutMs) {
      if (exited) {
        return true;
      }
      let timeout;
      try {
        return await Promise.race([
          exitPromise,
          new Promise((resolvePromise) => {
            timeout = setTimeout(() => resolvePromise(false), timeoutMs);
          })
        ]);
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      }
    },
    dispose() {
      if (typeof child.off === "function") {
        child.off("exit", handleExit);
        child.off("close", handleExit);
      }
    }
  };
}

export async function cleanupFailedDetachedChild(
  child,
  {
    killProcessGroup = process.kill,
    terminationGraceMs = 5_000,
    forceKillGraceMs = 1_000
  } = {}
) {
  const exitWaiter = createChildExitWaiter(child);
  try {
    child.stdin?.destroy();
  } catch {
    // 关闭启动门失败也不能回显底层管道信息；下面仍尝试终止进程组。
  }
  if (!exitWaiter.hasExited()) {
    terminateDetachedChild(child, killProcessGroup);
  }
  let exited = await exitWaiter.wait(terminationGraceMs);
  if (!exited && Number.isSafeInteger(child.pid) && child.pid > 0) {
    try {
      killProcessGroup(-child.pid, "SIGKILL");
    } catch {
      // 后续仍会把清理状态记为未确认，不能回显底层进程信息。
    }
    exited = await exitWaiter.wait(forceKillGraceMs);
  }
  exitWaiter.dispose();
  try {
    child.unref();
  } catch {
    // 清理路径必须保持固定错误输出。
  }
  return exited || !Number.isSafeInteger(child.pid) || child.pid <= 0;
}

export function buildChildEnvironment(
  envFileContent,
  parentEnvironment = process.env
) {
  assertSafeNodeEnvironment(parentEnvironment);
  const fileEnvironment = parseEnvFile(envFileContent);
  assertSafeNodeEnvironment(fileEnvironment);
  assertNoUnknownPrefixedEnvironmentKeys(
    parentEnvironment,
    allowedInheritedEnvironmentKeys,
    protectedCalibrationEnvironmentPrefixes
  );
  assertNoUnknownPrefixedEnvironmentKeys(
    fileEnvironment,
    allowedCalibrationEnvironmentKeys,
    [""]
  );
  // 父环境只继承明确列出的基本运行时、代理和 Fermata 变量；env 文件随后覆盖
  // 同名项。这样既保留服务器代理，也不会把 LD_PRELOAD、任意 Node 参数或一次
  // 旧实验的同名值整包带入后台进程。
  const environment = {
    ...selectEnvironment(parentEnvironment, allowedInheritedEnvironmentKeys),
    ...selectEnvironment(fileEnvironment, allowedCalibrationEnvironmentKeys)
  };
  return {
    ...environment,
    NODE_DEBUG: "",
    NODE_DEBUG_NATIVE: "",
    NODE_DISABLE_COMPILE_CACHE: "1",
    NODE_OPTIONS: "",
    NODE_PATH: "",
    NODE_REDIRECT_WARNINGS: "",
    NODE_V8_COVERAGE: ""
  };
}

export function spawnDetachedWorker(
  executable,
  argumentsList,
  options,
  spawnProcess = spawn
) {
  try {
    return spawnProcess(executable, argumentsList, options);
  } catch {
    throw new Error("DETACHED_PROCESS_SPAWN_THROWN");
  }
}

export async function launchDetachedCalibration(
  options,
  {
    privateDirectoryHandle,
    tsxLoaderPath,
    childEnvironment,
    spawnProcess = spawn,
    waitForSpawn = waitUntilSpawned,
    authorizeStart = authorizeCalibrationStart,
    cleanupChild = cleanupFailedDetachedChild,
    writeMetadata = writePrivateJsonAtomically,
    now = () => new Date(),
    randomRunSuffix = () => randomBytes(6).toString("hex")
  }
) {
  const privateDirectory = privateDirectoryHandle.path;
  const startedAt = now().toISOString();
  const timestamp = startedAt.replace(/[:.]/g, "-");
  const runId = `${timestamp}-${randomRunSuffix()}`;
  const logFileName = `levels-${options.label}-${runId}.log`;
  const metadataFileName = `levels-${options.label}-${runId}.json`;
  const logPath = anchoredPrivatePath(
    privateDirectoryHandle,
    logFileName
  );
  let logDescriptor;
  let child;
  let spawnedPid = null;
  let startMayHaveBeenAuthorized = false;

  const persistMetadata = (value) =>
    writeMetadata(
      privateDirectory,
      metadataFileName,
      value,
      privateDirectoryHandle
    );

  try {
    logDescriptor = openPrivateFile(logPath);
    const safeMetadata = {
      schemaVersion: 1,
      kind: "levels-calibration",
      runId,
      label: options.label,
      resume: options.resume,
      startedAt,
      logFile: logFileName,
      launchState: "starting"
    };
    persistMetadata(safeMetadata);
    writeAll(
      logDescriptor,
      `[${startedAt}] 长期标定任务正在启动；标签=${options.label}。\n`
    );
    fsyncSync(logDescriptor);

    const calibrationArguments = [`--label=${options.label}`];
    if (options.resume) {
      calibrationArguments.push("--resume");
    }

    child = spawnDetachedWorker(
      process.execPath,
      [
        "--import",
        tsxLoaderPath,
        calibrationWorkerPath,
        ...calibrationArguments
      ],
      {
        cwd: repositoryRoot,
        detached: true,
        env: childEnvironment,
        shell: false,
        stdio: ["pipe", logDescriptor, logDescriptor]
      },
      spawnProcess
    );
    await waitForSpawn(child);
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
      throw new Error("DETACHED_PROCESS_PID_MISSING");
    }
    spawnedPid = child.pid;
    persistMetadata({
      ...safeMetadata,
      pid: spawnedPid,
      processGroupId: spawnedPid,
      launchState: "ready"
    });
    // `ready`（含 PID/进程组）已经持久化后才触碰启动门。从这一刻起 START
    // 可能已经完整送达，任何后续错误都不得再发送信号取消潜在付费请求。
    startMayHaveBeenAuthorized = true;
    await authorizeStart(child);
    try {
      child.unref();
    } catch {
      // START 后只允许固定的非破坏性收尾；不能因此取消已经开始的请求。
    }
  } catch {
    if (child !== undefined && startMayHaveBeenAuthorized) {
      try {
        child.stdin?.destroy();
      } catch {
        // START 可能已送达，只关闭父侧句柄，不向子进程发送终止信号。
      }
      try {
        child.unref();
      } catch {
        // 同上。
      }
      throw new Error("DETACHED_CALIBRATION_AUTHORIZATION_UNCERTAIN");
    }
    const cleanupConfirmed =
      child === undefined ? true : await cleanupChild(child);
    try {
      persistMetadata({
        schemaVersion: 1,
        kind: "levels-calibration",
        runId,
        label: options.label,
        resume: options.resume,
        startedAt,
        logFile: logFileName,
        pid: spawnedPid ?? undefined,
        processGroupId: spawnedPid ?? undefined,
        launchState: cleanupConfirmed ? "failed" : "cleanup-unconfirmed"
      });
    } catch {
      // 不能输出底层错误；最后一个完整元数据版本仍会保留。
    }
    throw new Error("DETACHED_CALIBRATION_LAUNCH_FAILED");
  } finally {
    if (logDescriptor !== undefined) {
      try {
        closeSync(logDescriptor);
      } catch {
        // 同上；不输出可能包含文件系统细节的底层错误。
      }
    }
  }

  return {
    runId,
    spawnedPid,
    logFileName,
    metadataFileName
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (process.platform !== "linux") {
    failInput("长期标定后台启动器只支持 Linux 服务器。");
  }
  try {
    assertSafeNodeEnvironment(process.env);
  } catch {
    failInput(
      "启动长期标定前必须清除危险的 Node 调试、注入或 TLS 关闭变量。"
    );
  }

  let tsxLoaderPath;
  try {
    tsxLoaderPath = fileURLToPath(import.meta.resolve("tsx"));
  } catch {
    failInput("找不到标定脚本所需的 tsx，请先在服务器安装项目依赖。");
  }
  const envFileContent = readPrivateEnvFile(options.envFile);
  let childEnvironment;
  try {
    childEnvironment = buildChildEnvironment(envFileContent);
  } catch {
    failInput(
      "env 文件含有不安全、重复、未知或无法安全传递的变量。"
    );
  }

  const privateDirectoryHandle = preparePrivateDirectory(
    options.privateDirectory
  );
  let launchResult;
  try {
    launchResult = await launchDetachedCalibration(options, {
      privateDirectoryHandle,
      tsxLoaderPath,
      childEnvironment
    });
  } finally {
    closePrivateDirectory(privateDirectoryHandle);
  }

  process.stdout.write(
    `长期标定任务已脱离当前 SSH 会话。\n` +
      `任务编号：${launchResult.runId}\n` +
      `进程 ID：${launchResult.spawnedPid}\n` +
      `进程组 ID：${launchResult.spawnedPid}\n` +
      `日志文件：${launchResult.logFileName}\n` +
      `元数据文件：${launchResult.metadataFileName}\n` +
      "日志和元数据均位于传入的私有运行目录。\n"
  );
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
  main().catch((error) => {
    if (error instanceof LauncherInputError) {
      process.stderr.write(`${error.message}\n${usage}`);
      process.exitCode = 2;
    } else if (
      error instanceof Error &&
      error.message === "DETACHED_CALIBRATION_AUTHORIZATION_UNCERTAIN"
    ) {
      process.stderr.write(
        "长期标定启动门结果不确定；不得重复启动，请先按已登记 PID 核对进程和日志。\n"
      );
      process.exitCode = 1;
    } else {
      process.stderr.write(
        "长期标定任务启动失败；请检查传入的私有目录中的 0600 日志和元数据文件。\n"
      );
      process.exitCode = 1;
    }
  });
}
