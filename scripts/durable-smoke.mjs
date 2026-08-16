#!/usr/bin/env node
/**
 * durable-smoke.mjs — 脱离调用方的长实验运行器。
 *
 * 用法：
 *   node scripts/durable-smoke.mjs launch <env文件> --network-phase0 [--resume=<runId>]
 *   node scripts/durable-smoke.mjs launch <env文件> --public-difficulty-smoke
 *   node scripts/durable-smoke.mjs launch <env文件> --network-phase1 --resume=<runId> --release-phase1
 *   node scripts/durable-smoke.mjs status <run目录或runId>
 *   node scripts/durable-smoke.mjs stop-scheduling <run目录或runId>
 *   node scripts/durable-smoke.mjs recover <run目录或runId>
 * 通过 run-with-env.mjs --development-smoke / --difficulty-evaluation 启动子进程；子进程以 detached
 * 方式运行，调用方退出后继续。秘密仅在 env 文件中，不进 argv 或日志。
 * stop-scheduling 写入标志文件；运行进程轮询后调用 softStop，不取消已在
 * 流式的请求。status/recover 只读检查点和锁，不重放或重新启动。
 */

import { spawn } from "node:child_process";
import {
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  isAbsolute,
  resolve,
  dirname,
} from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { selectEnvironment } from "./env-file.mjs";
import {
  allowedRunEnvironmentKeys,
  difficultyEvaluationModeFlag
} from "./run-with-env.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const runWithEnvPath = resolve(scriptDir, "run-with-env.mjs");
const defaultPrivateRuntimeRoot = resolve(repoRoot, "private/development-smoke-6x4-v1/runtime");

// 运行目录可注入：仅测试用 DURABLE_SMOKE_RUNTIME_ROOT 指向临时目录，
// 生产默认指向私有 runtime 根目录。包装器路径同样可注入（test-only）。
function runtimeRoot() {
  const override = process.env.DURABLE_SMOKE_RUNTIME_ROOT;
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) {
      throw new Error("DURABLE_SMOKE_RUNTIME_ROOT_MUST_BE_ABSOLUTE");
    }
    return override;
  }
  return defaultPrivateRuntimeRoot;
}
function wrapperPath() {
  const override = process.env.DURABLE_SMOKE_WRAPPER_PATH;
  return override !== undefined && override !== "" ? override : runWithEnvPath;
}

const STOP_SCHEDULING_FLAG = "stop-scheduling.private.json";
const LAUNCH_GRACE_MS = 2_000;

// ── 辅助函数 ──

function writePrivateFileAtomic(path, bytes) {
  const dir = resolve(path, "..");
  const tmp = resolve(dir, `.${randomBytes(12).toString("hex")}.tmp`);
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
    unlinkSync(tmp);
    const dirFd = openSync(dir, constants.O_RDONLY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

function resolveRunDirectory(arg) {
  if (/^[a-f0-9]{64}$/.test(arg)) {
    return resolve(runtimeRoot(), `run-${arg}`);
  }
  if (isAbsolute(arg)) return arg;
  return resolve(process.cwd(), arg);
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function findLatestCheckpoint(runDir) {
  if (!existsSync(runDir)) return null;
  const files = readdirSync(runDir)
    .filter((f) => /^checkpoint-\d{6}\.private\.json$/.test(f))
    .sort();
  if (files.length === 0) return null;
  return {
    path: resolve(runDir, files[files.length - 1]),
    name: files[files.length - 1],
    data: readJsonSafe(resolve(runDir, files[files.length - 1])),
  };
}

function isProcessAlive(pid) {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function redactEnvPath(envPath) {
  // 不暴露 env 文件内容或路径片段；只返回是否存在
  if (!isAbsolute(envPath)) {
    throw new Error("DURABLE_SMOKE_ENV_PATH_MUST_BE_ABSOLUTE");
  }
  if (!existsSync(envPath)) {
    throw new Error("DURABLE_SMOKE_ENV_FILE_NOT_FOUND");
  }
  return envPath;
}

// ── launch ──

function commandLaunch(args) {
  if (args.length < 2) {
    throw new Error("DURABLE_SMOKE_LAUNCH_ARGS: <envFile> --network-phase0|--network-phase1|--public-difficulty-smoke ...");
  }
  const envPath = redactEnvPath(args[0]);
  const smokeArgs = args.slice(1);

  // 验证参数是合法的 development-smoke 或公开 difficulty-smoke 参数
  const validModes = [
    "--preflight",
    "--preflight-phase1",
    "--network-phase0",
    "--network-phase1",
    "--public-difficulty-smoke"
  ];
  const hasMode = smokeArgs.some((a) => validModes.includes(a));
  if (!hasMode) {
    throw new Error("DURABLE_SMOKE_LAUNCH_MODE_REQUIRED");
  }
  const isPublicDifficulty = smokeArgs.includes("--public-difficulty-smoke");
  if (isPublicDifficulty) {
    // 公开 difficulty smoke 的样本选择/并发/尝试上限全部由 env 文件传入并在
    // eval-difficulty 内强制；这里只接受单模式参数，拒绝与 6×4 模式混用。
    if (smokeArgs.length !== 1) {
      throw new Error("DURABLE_SMOKE_PUBLIC_DIFFICULTY_ARGS");
    }
  } else {
    // 不允许 preflight（不启动网络请求的模式无需 detached）
    if (smokeArgs.includes("--preflight") || smokeArgs.includes("--preflight-phase1")) {
      throw new Error("DURABLE_SMOKE_PREFLIGHT_NOT_DETACHED");
    }
  }

  // 构造 run-with-env.mjs 参数
  const childArgv = isPublicDifficulty
    ? [difficultyEvaluationModeFlag, envPath, ...smokeArgs]
    : ["--development-smoke", envPath, ...smokeArgs];

  // 提取 resume runId 用于确定运行目录（difficulty smoke 由 eval-difficulty
  // 自身检查点恢复，不传 durable resume）
  const resumeMatch = smokeArgs.find((a) => /^--resume=[a-f0-9]{64}$/.test(a));
  const runId = resumeMatch ? resumeMatch.split("=")[1] : null;

  // 以 detached 方式启动子进程
  const child = spawn(process.execPath, [wrapperPath(), ...childArgv], {
    stdio: "ignore",
    detached: true,
    shell: false,
    cwd: repoRoot,
    env: selectEnvironment(process.env, allowedRunEnvironmentKeys),
  });

  const startedAt = new Date().toISOString();
  const pid = child.pid;

  return new Promise((promiseResolve) => {
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      // detached 子进程可能长时间存活；父进程（launcher）不应被其拖住。
      child.unref();
      promiseResolve(outcome);
    };

    // 成功握手：只有 spawn 后观察到启动错误（error 事件，或宽限期内提前
    // 非零退出）都未发生时，才写 receipt 并报告成功。绝不提前伪成功。
    const reportFailure = (code, message) => {
      const failure = {
        action: "launch",
        ok: false,
        failureCode: code,
        message,
        startedAt,
      };
      process.stdout.write(`${JSON.stringify(failure)}\n`);
      process.exitCode = 1;
      settle(failure);
    };

    const reportSuccess = () => {
      const envOverride = process.env.DURABLE_SMOKE_RUNTIME_ROOT;
      const receiptDir = envOverride !== undefined && envOverride !== ""
        ? envOverride
        : defaultPrivateRuntimeRoot;
      if (!existsSync(receiptDir)) {
        mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
      }
      const receipt = {
        schemaVersion: 1,
        pid,
        ppid: process.pid,
        cwd: repoRoot,
        commandRedacted: isPublicDifficulty
          ? "run-with-env.mjs --difficulty-evaluation [REDACTED]"
          : "run-with-env.mjs --development-smoke [REDACTED]",
        smokeArgs: smokeArgs.filter((a) => !/^--resume=/.test(a)),
        startedAt,
        runId,
      };
      const receiptPath = resolve(receiptDir, `durable-pid-${pid}.private.json`);
      try {
        writePrivateFileAtomic(receiptPath, Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8"));
      } catch (err) {
        reportFailure("RECEIPT_WRITE_FAILED", String(err?.message ?? err));
        return;
      }
      const output = {
        action: "launch",
        ok: true,
        pid,
        startedAt,
        runId,
        smokeArgs: receipt.smokeArgs,
        receiptPath: receiptPath.replace(repoRoot + "/", ""),
      };
      process.stdout.write(`${JSON.stringify(output)}\n`);
      settle(output);
    };

    let spawnObserved = false;
    let graceTimer = null;

    child.once("error", (err) => {
      reportFailure("SPAWN_FAILED", String(err?.message ?? err));
    });

    child.once("spawn", () => {
      // 启动成功，但还要等待宽限期，观察启动期是否提前失败退出。
      spawnObserved = true;
      graceTimer = setTimeout(() => {
        graceTimer = null;
        reportSuccess();
      }, LAUNCH_GRACE_MS);
    });

    child.once("exit", (code, signal) => {
      if (!spawnObserved) {
        // 尚未观察到 spawn（理论上 spawn 先于 exit），保守失败。
        reportFailure("EXITED_BEFORE_SPAWN", `code=${code} signal=${signal ?? ""}`);
        return;
      }
      if (graceTimer !== null) {
        // 宽限期内提前退出 = 启动失败可观测，不得伪成功。
        clearTimeout(graceTimer);
        graceTimer = null;
        reportFailure("STARTUP_EXITED_EARLY", `code=${code} signal=${signal ?? ""}`);
        return;
      }
      // 宽限期后退出：启动已成功；正常。
    });
  });
}

// ── status ──

function commandStatus(args) {
  if (args.length < 1) {
    throw new Error("DURABLE_SMOKE_STATUS_ARGS: <runDir|runId>");
  }
  const runDir = resolveRunDirectory(args[0]);

  if (!existsSync(runDir)) {
    process.stdout.write(`${JSON.stringify({
      action: "status",
      runDir: runDir.replace(repoRoot + "/", ""),
      found: false,
      classification: "NOT_FOUND",
    })}\n`);
    return;
  }

  const checkpoint = findLatestCheckpoint(runDir);
  const lockPath = resolve(runDir, "active.lock.private.json");
  const lock = readJsonSafe(lockPath);
  const lockPid = lock?.pid;
  const lockAlive = isProcessAlive(lockPid);

  // 分类
  let classification;
  if (!checkpoint) {
    classification = lockAlive ? "ACTIVE_NO_CHECKPOINT" : "STALE_NO_CHECKPOINT";
  } else {
    const state = checkpoint.data?.state;
    if (state === "phase0_complete" || state === "complete") {
      classification = "COMPLETE";
    } else if (state === "incomplete") {
      classification = lockAlive ? "INCOMPLETE_ACTIVE" : "INCOMPLETE_CRASHED";
    } else if (state === "running") {
      classification = lockAlive ? "ACTIVE_RUNNING" : "CRASHED_RUNNING";
    } else {
      classification = "UNKNOWN";
    }
  }

  // 安全摘要（无题面、无密钥、无原始响应）
  const summary = {
    action: "status",
    runDir: runDir.replace(repoRoot + "/", ""),
    found: true,
    classification,
    lockPid: lockPid ?? null,
    lockAlive,
    checkpoint: checkpoint ? {
      name: checkpoint.name,
      state: checkpoint.data?.state ?? null,
      phase: checkpoint.data?.phase ?? null,
      requestCount: checkpoint.data?.requests?.length ?? 0,
      stopReason: checkpoint.data?.stopReason ?? null,
      failureCode: checkpoint.data?.failureCode ?? null,
    } : null,
    // 基于 checkpoint 中请求的累计传输尝试数
    externalAttemptsUsed: checkpoint?.data?.requests?.reduce(
      (sum, r) => sum + (r?.receipt?.externalAttemptsUsed ?? 0), 0
    ) ?? null,
    externalAttemptCeiling: checkpoint?.data?.requests?.[0]?.receipt?.externalAttemptCeiling ?? null,
  };

  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

// ── stop-scheduling ──

function commandStopScheduling(args) {
  if (args.length < 1) {
    throw new Error("DURABLE_SMOKE_STOP_ARGS: <runDir|runId>");
  }
  const runDir = resolveRunDirectory(args[0]);

  if (!existsSync(runDir)) {
    throw new Error("DURABLE_SMOKE_RUN_DIR_NOT_FOUND");
  }

  const flagPath = resolve(runDir, STOP_SCHEDULING_FLAG);
  if (existsSync(flagPath)) {
    process.stdout.write(`${JSON.stringify({
      action: "stop-scheduling",
      alreadyRequested: true,
      runDir: runDir.replace(repoRoot + "/", ""),
    })}\n`);
    return;
  }

  const flagContent = {
    schemaVersion: 1,
    requestedAt: new Date().toISOString(),
    requestedByPid: process.pid,
  };
  writePrivateFileAtomic(flagPath, Buffer.from(`${JSON.stringify(flagContent)}\n`, "utf8"));

  process.stdout.write(`${JSON.stringify({
    action: "stop-scheduling",
    requested: true,
    runDir: runDir.replace(repoRoot + "/", ""),
    note: "已在流式的请求不受影响；仅阻止新请求调度。",
  })}\n`);
}

// ── recover ──

function commandRecover(args) {
  if (args.length < 1) {
    throw new Error("DURABLE_SMOKE_RECOVER_ARGS: <runDir|runId>");
  }
  const runDir = resolveRunDirectory(args[0]);

  if (!existsSync(runDir)) {
    throw new Error("DURABLE_SMOKE_RUN_DIR_NOT_FOUND");
  }

  const lockPath = resolve(runDir, "active.lock.private.json");
  const lock = readJsonSafe(lockPath);
  const lockPid = lock?.pid;
  const lockAlive = isProcessAlive(lockPid);

  const checkpoint = findLatestCheckpoint(runDir);

  let action;
  if (lockAlive) {
    action = "NO_ACTION_PROCESS_ALIVE";
  } else if (lock && !lockAlive) {
    // 过时锁：重命名为 stale
    const stalePath = resolve(runDir, `stale-lock-${randomBytes(8).toString("hex")}.private.json`);
    try {
      renameSync(lockPath, stalePath);
      action = "STALE_LOCK_REMOVED";
    } catch {
      action = "STALE_LOCK_REMOVE_FAILED";
    }
  } else {
    action = "NO_LOCK";
  }

  const classification = checkpoint
    ? (checkpoint.data?.state === "phase0_complete" || checkpoint.data?.state === "complete"
      ? "COMPLETE"
      : checkpoint.data?.state === "incomplete"
        ? "INCOMPLETE_CRASHED"
        : "CRASHED_RUNNING")
    : "NO_CHECKPOINT";

  process.stdout.write(`${JSON.stringify({
    action: "recover",
    runDir: runDir.replace(repoRoot + "/", ""),
    lockPid: lockPid ?? null,
    lockAlive,
    lockAction: action,
    classification,
    checkpoint: checkpoint ? {
      name: checkpoint.name,
      state: checkpoint.data?.state ?? null,
      requestCount: checkpoint.data?.requests?.length ?? 0,
    } : null,
    note: "recover 不重新启动运行；只清理过时锁并分类状态。如需继续，使用 launch --resume=<runId>。",
  })}\n`);
}

// ── 入口 ──

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);

  switch (subcommand) {
    case "launch":
      await commandLaunch(rest);
      break;
    case "status":
      commandStatus(rest);
      break;
    case "stop-scheduling":
      commandStopScheduling(rest);
      break;
    case "recover":
      commandRecover(rest);
      break;
    default:
      process.stderr.write(
        "用法：node scripts/durable-smoke.mjs <launch|status|stop-scheduling|recover> ...\n"
      );
      process.exitCode = 1;
  }
}

await main();
