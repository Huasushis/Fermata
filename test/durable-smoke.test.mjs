/**
 * durable-smoke.test.mjs — 合成测试：脱离运行器的生命周期管理。
 *
 * 不调用任何外部模型或私有题目；仅测试文件系统锁/状态/标志/恢复逻辑。
 * 使用临时目录和合成的检查点结构。
 */

import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const testFileDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testFileDir, "..");
const durableScript = resolve(repoRoot, "scripts/durable-smoke.mjs");
const nodeBin = process.execPath;

let tempRoots = [];
function makeTempDir() {
  const dir = resolve(testFileDir, `.durable-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  tempRoots.push(dir);
  return dir;
}

function runDurable(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [durableScript, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: repoRoot,
      env: { ...process.env, ...opts.env },
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    child.on("error", reject);
  });
}

function writeAtomicFile(path, content) {
  const dir = resolve(path, "..");
  const tmp = resolve(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

function makeFakeRunDir(parent, runId) {
  const runDir = resolve(parent, `run-${runId}`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  return runDir;
}

function writeFakeCheckpoint(runDir, revision, state, extra = {}) {
  const name = `checkpoint-${String(revision).padStart(6, "0")}.private.json`;
  const data = {
    schemaVersion: 10,
    state,
    phase: "phase0",
    createdAt: new Date().toISOString(),
    requests: [],
    ...extra,
  };
  writeAtomicFile(resolve(runDir, name), `${JSON.stringify(data)}\n`);
  return data;
}

function writeFakeLock(runDir, pid) {
  const data = {
    schemaVersion: 1,
    runId: "test",
    pid,
  };
  writeAtomicFile(resolve(runDir, "active.lock.private.json"), `${JSON.stringify(data)}\n`);
  return data;
}

// ── 测试用例 ──

const tests = [];

// 1. status 对不存在的 run 目录返回 NOT_FOUND
tests.push(async () => {
  const result = await runDurable(["status", "/tmp/durable-nonexistent-12345"]);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.classification, "NOT_FOUND");
  assert.equal(output.found, false);
  assert.equal(result.code, 0);
});

// 2. status 对有完整检查点的 run 返回 COMPLETE
tests.push(async () => {
  const parent = makeTempDir();
  const runId = randomBytes(32).toString("hex");
  const runDir = makeFakeRunDir(parent, runId);
  writeFakeCheckpoint(runDir, 0, "phase0_complete");
  const result = await runDurable(["status", runDir]);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.classification, "COMPLETE");
  assert.equal(output.found, true);
  assert.equal(output.checkpoint.state, "phase0_complete");
});

// 3. status 对有 running 检查点但锁进程存活的情况返回 ACTIVE_RUNNING
tests.push(async () => {
  const parent = makeTempDir();
  const runId = randomBytes(32).toString("hex");
  const runDir = makeFakeRunDir(parent, runId);
  writeFakeCheckpoint(runDir, 0, "running");
  writeFakeLock(runDir, process.pid);
  const result = await runDurable(["status", runDir]);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.classification, "ACTIVE_RUNNING");
  assert.equal(output.lockAlive, true);
});

// 4. status 对有 running 检查点但锁进程死亡的情况返回 CRASHED_RUNNING
tests.push(async () => {
  const parent = makeTempDir();
  const runId = randomBytes(32).toString("hex");
  const runDir = makeFakeRunDir(parent, runId);
  writeFakeCheckpoint(runDir, 0, "running");
  writeFakeLock(runDir, 999999);
  const result = await runDurable(["status", runDir]);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.classification, "CRASHED_RUNNING");
  assert.equal(output.lockAlive, false);
});

// 5. stop-scheduling 写入标志文件
tests.push(async () => {
  const parent = makeTempDir();
  const runId = randomBytes(32).toString("hex");
  const runDir = makeFakeRunDir(parent, runId);
  const result = await runDurable(["stop-scheduling", runDir]);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.requested, true);
  assert.ok(existsSync(resolve(runDir, "stop-scheduling.private.json")));
});

// 6. stop-scheduling 幂等
tests.push(async () => {
  const parent = makeTempDir();
  const runId = randomBytes(32).toString("hex");
  const runDir = makeFakeRunDir(parent, runId);
  await runDurable(["stop-scheduling", runDir]);
  const result = await runDurable(["stop-scheduling", runDir]);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.alreadyRequested, true);
  assert.equal(result.code, 0);
});

// 7. recover 清理过时锁
tests.push(async () => {
  const parent = makeTempDir();
  const runId = randomBytes(32).toString("hex");
  const runDir = makeFakeRunDir(parent, runId);
  writeFakeCheckpoint(runDir, 0, "running");
  writeFakeLock(runDir, 999999);
  const result = await runDurable(["recover", runDir]);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.lockAction, "STALE_LOCK_REMOVED");
  assert.equal(output.classification, "CRASHED_RUNNING");
  assert.ok(!existsSync(resolve(runDir, "active.lock.private.json")));
});

// 8. recover 对存活进程的锁不做操作
tests.push(async () => {
  const parent = makeTempDir();
  const runId = randomBytes(32).toString("hex");
  const runDir = makeFakeRunDir(parent, runId);
  writeFakeCheckpoint(runDir, 0, "running");
  writeFakeLock(runDir, process.pid);
  const result = await runDurable(["recover", runDir]);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.lockAction, "NO_ACTION_PROCESS_ALIVE");
  assert.ok(existsSync(resolve(runDir, "active.lock.private.json")));
});

// 9. launch 拒绝非绝对路径的 env 文件
tests.push(async () => {
  const result = await runDurable(["launch", "relative/path.env", "--network-phase0"]);
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes("ABSOLUTE") || result.stderr.includes("NOT_FOUND"));
});

// 10. launch 拒绝 preflight 模式
tests.push(async () => {
  const parent = makeTempDir();
  const envPath = resolve(parent, "test.env");
  writeFileSync(envPath, "# fake\n", { mode: 0o600 });
  const result = await runDurable(["launch", envPath, "--preflight"]);
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes("PREFLIGHT"));
});

// 11. 输出中不包含 env 文件路径或内容（秘密脱敏）
tests.push(async () => {
  const parent = makeTempDir();
  const runId = randomBytes(32).toString("hex");
  const runDir = makeFakeRunDir(parent, runId);
  writeFakeCheckpoint(runDir, 0, "phase0_complete");
  const secretEnvPath = resolve(parent, "SECRET_KEY_FILE.env");
  writeFileSync(secretEnvPath, "# fake\n", { mode: 0o600 });
  const result = await runDurable(["status", runDir]);
  assert.ok(!result.stdout.includes("SECRET_KEY_FILE"));
  assert.ok(!result.stdout.includes(secretEnvPath));
});

// 12. status 报告 externalAttemptsUsed 和 ceiling
tests.push(async () => {
  const parent = makeTempDir();
  const runId = randomBytes(32).toString("hex");
  const runDir = makeFakeRunDir(parent, runId);
  writeFakeCheckpoint(runDir, 0, "running", {
    requests: [
      {
        receipt: { externalAttemptsUsed: 3, externalAttemptCeiling: 52, anonymousSlot: "slot-01", stage: "a" },
      },
      {
        receipt: { externalAttemptsUsed: 2, externalAttemptCeiling: 52, anonymousSlot: "slot-02", stage: "a" },
      },
    ],
  });
  const result = await runDurable(["status", runDir]);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.externalAttemptsUsed, 5);
  assert.equal(output.externalAttemptCeiling, 52);
});

// 13. 负向握手：子进程在宽限期内退出 → 判定启动失败，不写成功 receipt
tests.push(async () => {
  const parent = makeTempDir();
  const runtimeRoot = resolve(parent, "runtime-root");
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const envPath = resolve(parent, "test.env");
  writeFileSync(envPath, "# fake\n", { mode: 0o600 });
  // 合成 fail-wrapper：spawn 后 100ms 内退出（仍处于 2s 宽限期）
  const wrapperPath = resolve(parent, "fail-wrapper.mjs");
  writeFileSync(wrapperPath, "setTimeout(() => process.exit(3), 100);\n", { mode: 0o700 });
  const result = await runDurable(["launch", envPath, "--network-phase0"], {
    env: {
      DURABLE_SMOKE_WRAPPER_PATH: wrapperPath,
      DURABLE_SMOKE_RUNTIME_ROOT: runtimeRoot,
    },
  });
  assert.equal(result.code, 1);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.ok, false);
  assert.equal(output.failureCode, "STARTUP_EXITED_EARLY");
  // 失败路径不得留下成功/active receipt
  assert.equal(readdirSync(runtimeRoot).filter((f) => f.startsWith("durable-pid-")).length, 0);
  assert.ok(!result.stdout.includes("test.env"));
});

// 14. 正向握手：子进程持续存活过宽限期 → 成功 + receipt 仅在注入的 runtime root
tests.push(async () => {
  const parent = makeTempDir();
  const runtimeRoot = resolve(parent, "runtime-root");
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const envPath = resolve(parent, "test.env");
  writeFileSync(envPath, "# fake\n", { mode: 0o600 });
  // 合成 live-wrapper：无限存活，验证宽限期后仍被判定为成功
  const wrapperPath = resolve(parent, "live-wrapper.mjs");
  writeFileSync(wrapperPath, "setInterval(() => {}, 1000);\n", { mode: 0o700 });
  let livePid = null;
  try {
    const result = await runDurable(["launch", envPath, "--network-phase0"], {
      env: {
        DURABLE_SMOKE_WRAPPER_PATH: wrapperPath,
        DURABLE_SMOKE_RUNTIME_ROOT: runtimeRoot,
      },
    });
    // 尽早记录 pid，确保任何断言失败时 finally 也能清理测试自有子进程
    let output = null;
    try {
      output = JSON.parse(result.stdout.trim());
    } catch { /* 保留 null，失败断言会给出明确信息 */ }
    if (output !== null && Number.isInteger(output.pid)) {
      livePid = output.pid;
    }
    assert.equal(result.code, 0);
    assert.equal(output?.ok, true);
    assert.ok(livePid > 0);
    assert.ok(output?.startedAt);
    assert.equal(output?.smokeArgs?.[0], "--network-phase0");
    assert.ok(!result.stdout.includes("test.env"));
    // receipt 必须落在注入的 runtime root，且指向同一 pid
    const receipts = readdirSync(runtimeRoot).filter((f) => f.startsWith("durable-pid-"));
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0], `durable-pid-${livePid}.private.json`);
    const receipt = JSON.parse(
      readFileSync(resolve(runtimeRoot, receipts[0]), "utf8")
    );
    assert.equal(receipt.pid, livePid);
    assert.equal(receipt.schemaVersion, 1);
  } finally {
    // 清理本测试创建的 live-wrapper 子进程（测试自有工件）
    if (livePid !== null) {
      try { process.kill(livePid, "SIGKILL"); } catch { /* 已退出 */ }
    }
  }
});

// 15. launch 接受 --public-difficulty-smoke 单模式参数并写 difficulty 专用脱敏 receipt
tests.push(async () => {
  const parent = makeTempDir();
  const runtimeRoot = resolve(parent, "runtime-root");
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const envPath = resolve(parent, "test.env");
  writeFileSync(envPath, "# fake\n", { mode: 0o600 });
  // 合成 live-wrapper：无限存活，验证宽限期后仍被判定为成功
  const wrapperPath = resolve(parent, "live-wrapper.mjs");
  writeFileSync(wrapperPath, "setInterval(() => {}, 1000);\n", { mode: 0o700 });
  let livePid = null;
  try {
    const result = await runDurable(
      ["launch", envPath, "--public-difficulty-smoke"],
      {
        env: {
          DURABLE_SMOKE_WRAPPER_PATH: wrapperPath,
          DURABLE_SMOKE_RUNTIME_ROOT: runtimeRoot,
        },
      }
    );
    let output = null;
    try {
      output = JSON.parse(result.stdout.trim());
    } catch { /* 保留 null，失败断言会给出明确信息 */ }
    if (output !== null && Number.isInteger(output.pid)) {
      livePid = output.pid;
    }
    assert.equal(result.code, 0);
    assert.equal(output?.ok, true);
    assert.deepEqual(output?.smokeArgs, ["--public-difficulty-smoke"]);
    assert.ok(!result.stdout.includes("test.env"));
    const receipts = readdirSync(runtimeRoot).filter((f) => f.startsWith("durable-pid-"));
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0], `durable-pid-${livePid}.private.json`);
    const receipt = JSON.parse(
      readFileSync(resolve(runtimeRoot, receipts[0]), "utf8")
    );
    assert.equal(
      receipt.commandRedacted,
      "run-with-env.mjs --difficulty-evaluation [REDACTED]"
    );
  } finally {
    // 清理本测试创建的 live-wrapper 子进程（测试自有工件）
    if (livePid !== null) {
      try { process.kill(livePid, "SIGKILL"); } catch { /* 已退出 */ }
    }
  }
});

// 16. launch 拒绝 difficulty 模式与其他参数混用，未知模式也 fail closed
tests.push(async () => {
  const parent = makeTempDir();
  const envPath = resolve(parent, "test.env");
  writeFileSync(envPath, "# fake\n", { mode: 0o600 });
  for (const extra of ["--network-phase0", "--preflight"]) {
    const result = await runDurable(
      ["launch", envPath, "--public-difficulty-smoke", extra]
    );
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes("PUBLIC_DIFFICULTY_ARGS"));
  }
  const unknown = await runDurable(["launch", envPath, "--public-difficulty-smok"]);
  assert.notEqual(unknown.code, 0);
  assert.ok(unknown.stderr.includes("LAUNCH_MODE_REQUIRED"));
});

// ── 运行测试 ──

let passed = 0;
let failed = 0;
const failures = [];

for (let i = 0; i < tests.length; i++) {
  try {
    await tests[i]();
    passed++;
  } catch (err) {
    failed++;
    failures.push({ test: i + 1, error: err.message });
  }
}

// 清理
for (const dir of tempRoots) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(`\ndurable-smoke: ${passed}/${tests.length} passed, ${failed} failed`);
if (failures.length > 0) {
  for (const f of failures) {
    console.error(`  FAIL test ${f.test}: ${f.error}`);
  }
  process.exit(1);
}
