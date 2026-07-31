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
  chmodSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeEnvFile } from "./env-file.mjs";

const usage =
  "用法：npm run experiment:calibrate-levels:detached -- " +
  "--environment-file=<服务器私有 env 文件绝对路径> " +
  "--private-dir=<服务器私有运行目录绝对路径> " +
  "--label=<标签> [--resume | --resume-from=<旧标签>]\n";
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
const repositoryRoot = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..")
);
const calibrationWorkerPath = resolve(
  repositoryRoot,
  "scripts",
  "detached-calibration-worker.mjs"
);

class LauncherInputError extends Error {}

function failInput(message) {
  throw new LauncherInputError(message);
}

function parseArguments(argv) {
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
        "--label",
        "--resume-from"
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
  const resumeFrom = values.get("--resume-from") ?? null;
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
  if (resumeFrom !== null && !safeLabelPattern.test(resumeFrom)) {
    failInput("--resume-from 只能填写已有报告的安全标签。");
  }
  if (resume && resumeFrom !== null) {
    failInput("--resume 和 --resume-from 不能同时使用。");
  }
  if (resumeFrom === label) {
    failInput("--resume-from 不能和 --label 相同；续跑当前标签请使用 --resume。");
  }

  return {
    envFile: resolve(envFile),
    privateDirectory: resolve(privateDirectory),
    label,
    resume,
    resumeFrom
  };
}

function isInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}

function preparePrivateDirectory(privateDirectory) {
  if (isInside(repositoryRoot, privateDirectory)) {
    failInput("私有运行目录必须位于 Fermata 仓库之外。");
  }

  try {
    let directoryAlreadyExisted = true;
    try {
      lstatSync(privateDirectory);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      directoryAlreadyExisted = false;
    }
    if (!directoryAlreadyExisted) {
      // 只创建最后一级；父目录必须预先存在，避免异常 umask 在递归创建的中间
      // 目录上去掉 owner execute 后留下无法进入的残缺目录。
      mkdirSync(privateDirectory, { recursive: false, mode: 0o700 });
      // mkdir 的 mode 会受 umask 影响；新建目录由本进程立即收紧到准确的 0700。
      chmodSync(privateDirectory, 0o700);
    }
    const linkStatus = lstatSync(privateDirectory);
    if (!linkStatus.isDirectory() || linkStatus.isSymbolicLink()) {
      failInput("私有运行目录必须是普通目录，不能是符号链接。");
    }
    const canonicalDirectory = realpathSync(privateDirectory);
    if (isInside(repositoryRoot, canonicalDirectory)) {
      failInput("私有运行目录必须位于 Fermata 仓库之外。");
    }
    const status = statSync(canonicalDirectory);
    if ((status.mode & 0o777) !== 0o700) {
      failInput("私有运行目录的权限必须已经是 0700。");
    }
    if (
      typeof process.getuid === "function" &&
      status.uid !== process.getuid()
    ) {
      failInput("私有运行目录必须属于启动标定的当前用户。");
    }
    return canonicalDirectory;
  } catch (error) {
    if (error instanceof LauncherInputError) {
      throw error;
    }
    failInput("无法创建或保护指定的私有运行目录。");
  }
}

function readPrivateEnvFile(envFile) {
  if (isInside(repositoryRoot, envFile)) {
    failInput("env 文件必须位于 Fermata 仓库之外。");
  }

  let descriptor;
  try {
    const linkStatus = lstatSync(envFile);
    if (linkStatus.isSymbolicLink()) {
      failInput("env 文件不能是符号链接。");
    }
    const canonicalEnvFile = realpathSync(envFile);
    if (isInside(repositoryRoot, canonicalEnvFile)) {
      failInput("env 文件必须位于 Fermata 仓库之外。");
    }
    descriptor = openSync(
      canonicalEnvFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    );
    const status = fstatSync(descriptor);
    if (!status.isFile()) {
      failInput("指定的 env 路径不是普通文件。");
    }
    if ((status.mode & 0o077) !== 0) {
      failInput("env 文件不能向同组用户或其他用户开放任何权限。");
    }
    if (
      typeof process.getuid === "function" &&
      status.uid !== process.getuid()
    ) {
      failInput("env 文件必须属于启动标定的当前用户。");
    }
    return readFileSync(descriptor, "utf8");
  } catch (error) {
    if (error instanceof LauncherInputError) {
      throw error;
    }
    failInput("无法读取指定的 env 文件。");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 不输出可能包含服务器私有路径的底层错误。
      }
    }
  }
}

function openPrivateFile(path) {
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

function syncPrivateDirectory(privateDirectory) {
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

function writePrivateJsonAtomically(privateDirectory, fileName, value) {
  const targetPath = resolve(privateDirectory, fileName);
  const temporaryPath = resolve(
    privateDirectory,
    `.${fileName}.tmp-${randomBytes(8).toString("hex")}`
  );
  let descriptor;
  try {
    descriptor = openPrivateFile(temporaryPath);
    writeAll(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, targetPath);
    syncPrivateDirectory(privateDirectory);
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

function waitUntilSpawned(child) {
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

function authorizeCalibrationStart(child) {
  const gate = child.stdin;
  if (gate === null || typeof gate.end !== "function") {
    return Promise.reject(new Error("DETACHED_PROCESS_GATE_MISSING"));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const handleError = () => {
      rejectPromise(new Error("DETACHED_PROCESS_GATE_FAILED"));
    };
    gate.once("error", handleError);
    gate.end("START\n", () => {
      gate.off("error", handleError);
      resolvePromise();
    });
  });
}

function terminateDetachedChild(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // 进程可能已经自行退出；这里不能把底层错误或命令信息写到终端。
  }
}

function buildChildEnvironment(envFileContent) {
  const fileEnvironment = mergeEnvFile(envFileContent, {});
  const environment = { ...process.env };
  for (const key of allowedCalibrationEnvironmentKeys) {
    if (!(key in environment) && key in fileEnvironment) {
      environment[key] = fileEnvironment[key];
    }
  }
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

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (process.platform !== "linux") {
    failInput("长期标定后台启动器只支持 Linux 服务器。");
  }
  if (
    process.env.NODE_DEBUG?.trim() ||
    process.env.NODE_DEBUG_NATIVE?.trim()
  ) {
    failInput(
      "启动长期标定前必须清除 NODE_DEBUG 和 NODE_DEBUG_NATIVE，防止 Node 把子进程环境写到终端。"
    );
  }
  const privateDirectory = preparePrivateDirectory(options.privateDirectory);

  let tsxLoaderPath;
  try {
    tsxLoaderPath = fileURLToPath(import.meta.resolve("tsx"));
  } catch {
    failInput("找不到标定脚本所需的 tsx，请先在服务器安装项目依赖。");
  }
  const envFileContent = readPrivateEnvFile(options.envFile);

  const startedAt = new Date().toISOString();
  const timestamp = startedAt.replace(/[:.]/g, "-");
  const runId = `${timestamp}-${randomBytes(6).toString("hex")}`;
  const logFileName = `levels-${options.label}-${runId}.log`;
  const metadataFileName = `levels-${options.label}-${runId}.json`;
  const logPath = resolve(privateDirectory, logFileName);
  let logDescriptor;
  let child;
  let spawnedPid = null;

  try {
    logDescriptor = openPrivateFile(logPath);
    const safeMetadata = {
      schemaVersion: 1,
      kind: "levels-calibration",
      runId,
      label: options.label,
      resume: options.resume,
      resumeFrom: options.resumeFrom,
      startedAt,
      logFile: logFileName,
      launchState: "starting"
    };
    writePrivateJsonAtomically(
      privateDirectory,
      metadataFileName,
      safeMetadata
    );
    writeAll(
      logDescriptor,
      `[${startedAt}] 长期标定任务正在启动；标签=${options.label}。\n`
    );
    fsyncSync(logDescriptor);

    const calibrationArguments = [`--label=${options.label}`];
    if (options.resume) {
      calibrationArguments.push("--resume");
    } else if (options.resumeFrom !== null) {
      calibrationArguments.push(`--resume-from=${options.resumeFrom}`);
    }

    child = spawn(
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
        env: buildChildEnvironment(envFileContent),
        shell: false,
        stdio: ["pipe", logDescriptor, logDescriptor]
      }
    );
    await waitUntilSpawned(child);
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
      throw new Error("DETACHED_PROCESS_PID_MISSING");
    }
    spawnedPid = child.pid;
    writePrivateJsonAtomically(privateDirectory, metadataFileName, {
      ...safeMetadata,
      pid: spawnedPid,
      processGroupId: spawnedPid,
      launchState: "ready"
    });
    await authorizeCalibrationStart(child);
    writePrivateJsonAtomically(privateDirectory, metadataFileName, {
      ...safeMetadata,
      pid: spawnedPid,
      processGroupId: spawnedPid,
      launchState: "detached"
    });
    child.unref();
  } catch {
    if (child !== undefined && spawnedPid !== null) {
      terminateDetachedChild(child);
    }
    try {
      writePrivateJsonAtomically(privateDirectory, metadataFileName, {
        schemaVersion: 1,
        kind: "levels-calibration",
        runId,
        label: options.label,
        resume: options.resume,
        resumeFrom: options.resumeFrom,
        startedAt,
        logFile: logFileName,
        pid: spawnedPid ?? undefined,
        processGroupId: spawnedPid ?? undefined,
        launchState: "failed"
      });
    } catch {
      // 不能输出底层错误；最后一个完整元数据版本仍会保留。
    }
    if (child !== undefined) {
      child.unref();
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

  process.stdout.write(
    `长期标定任务已脱离当前 SSH 会话。\n` +
      `任务编号：${runId}\n` +
      `进程 ID：${spawnedPid}\n` +
      `进程组 ID：${spawnedPid}\n` +
      `日志文件：${logFileName}\n` +
      `元数据文件：${metadataFileName}\n` +
      "日志和元数据均位于传入的私有运行目录。\n"
  );
}

main().catch((error) => {
  if (error instanceof LauncherInputError) {
    process.stderr.write(`${error.message}\n${usage}`);
    process.exitCode = 2;
  } else {
    process.stderr.write(
      "长期标定任务启动失败；请检查传入的私有目录中的 0600 日志和元数据文件。\n"
    );
    process.exitCode = 1;
  }
});
