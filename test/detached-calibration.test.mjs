import { EventEmitter } from "node:events";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizeCalibrationStart,
  buildChildEnvironment,
  cleanupFailedDetachedChild,
  launchDetachedCalibration,
  openPrivateFile,
  parseArguments,
  spawnDetachedWorker,
  terminateDetachedChild,
  waitUntilSpawned,
  writePrivateJsonAtomically
} from "../scripts/start-detached-calibration.mjs";
import {
  readStartAuthorization,
  runDetachedCalibrationWorker,
  validateStartAuthorization
} from "../scripts/detached-calibration-worker.mjs";
import {
  closePrivateDirectory,
  preparePrivateDirectory
} from "../scripts/private-runtime.mjs";

describe("后台标定参数与环境", () => {
  it("只接受完整、安全的同标签新跑或续跑参数", () => {
    expect(
      parseArguments([
        "--environment-file=/project/private/fermata.env",
        "--private-dir=/project/private/runs",
        "--label=after-v2",
        "--resume"
      ])
    ).toMatchObject({
      label: "after-v2",
      resume: true
    });
    expect(() =>
      parseArguments([
        "--environment-file=/project/private/fermata.env",
        "--private-dir=/project/private/runs",
        "--label=x",
        "--resume-from=y"
      ])
    ).toThrow("不支持");
    expect(() =>
      parseArguments([
        "--environment-file=relative.env",
        "--private-dir=/project/private/runs",
        "--label=x"
      ])
    ).toThrow("必须使用服务器绝对路径");
  });

  it("env 文件覆盖父实验值，仅保留白名单运行时和代理变量", () => {
    const environment = buildChildEnvironment(
      "EVAL_CONCURRENCY=2\nAETHER_API_KEY=file-secret\n",
      {
        PATH: "/safe/bin",
        http_proxy: "http://127.0.0.1:10808",
        EVAL_CONCURRENCY: "31",
        AETHER_API_KEY: "parent-secret",
        RANDOM_PARENT_VALUE: "drop-me"
      }
    );
    expect(environment.EVAL_CONCURRENCY).toBe("2");
    expect(environment.AETHER_API_KEY).toBe("file-secret");
    expect(environment.http_proxy).toBe("http://127.0.0.1:10808");
    expect(environment.PATH).toBe("/safe/bin");
    expect(environment.RANDOM_PARENT_VALUE).toBeUndefined();
    expect(environment.NODE_OPTIONS).toBe("");
  });

  it("父环境或 env 文件关闭 TLS/注入 Node/拼错实验键时拒绝", () => {
    expect(() =>
      buildChildEnvironment("EVAL_CONCURRENCY=2\n", {
        NODE_TLS_REJECT_UNAUTHORIZED: "0"
      })
    ).toThrow("TLS_VERIFICATION_DISABLED");
    expect(() =>
      buildChildEnvironment("NODE_OPTIONS=--inspect\n", { PATH: "/bin" })
    ).toThrow("DANGEROUS_NODE_ENVIRONMENT");
    expect(() =>
      buildChildEnvironment("EVAL_CONCURRENCY=2\n", {
        PATH: "/bin",
        LD_PRELOAD: "/tmp/inject.so"
      })
    ).toThrow("DANGEROUS_NODE_ENVIRONMENT");
    expect(() =>
      buildChildEnvironment("LEVELS_LLM_MAX_DURATON_MS=14400000\n", {
        PATH: "/bin"
      })
    ).toThrow("UNKNOWN_PROTECTED_ENVIRONMENT_KEY");
  });

  it("spawn 同步异常只保留固定码", () => {
    const marker = "detached-spawn-secret-must-not-appear";
    expect(() =>
      spawnDetachedWorker("node", [], {}, () => {
        throw new Error(marker);
      })
    ).toThrow("DETACHED_PROCESS_SPAWN_THROWN");
    try {
      spawnDetachedWorker("node", [], {}, () => {
        throw new Error(marker);
      });
    } catch (error) {
      expect(String(error)).not.toContain(marker);
    }
  });
});

describe("后台启动门与失败清理", () => {
  it("只在收到 spawn 事件后继续，并把异步错误变成固定码", async () => {
    const spawned = new EventEmitter();
    const ready = waitUntilSpawned(spawned);
    spawned.emit("spawn");
    await expect(ready).resolves.toBeUndefined();

    const failed = new EventEmitter();
    const rejected = waitUntilSpawned(failed);
    failed.emit("error", new Error("private marker"));
    await expect(rejected).rejects.toThrow("DETACHED_PROCESS_START_FAILED");
  });

  it("父启动器只能写入精确 START 启动门", async () => {
    const gate = new EventEmitter();
    let written = null;
    gate.end = (value, callback) => {
      written = value;
      callback();
    };
    await expect(
      authorizeCalibrationStart({ stdin: gate })
    ).resolves.toBeUndefined();
    expect(written).toBe("START\n");
    expect(() => gate.emit("error", new Error("late synthetic error"))).not.toThrow();
    gate.emit("close");
    expect(gate.listenerCount("error")).toBe(0);
    await expect(authorizeCalibrationStart({ stdin: null })).rejects.toThrow(
      "DETACHED_PROCESS_GATE_MISSING"
    );
  });

  it("终止函数只使用已核对的独立进程组", () => {
    const kill = vi.fn();
    terminateDetachedChild({ pid: 12345 }, kill);
    expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");
    terminateDetachedChild({ pid: null }, kill);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(() =>
      terminateDetachedChild({ pid: 54321 }, () => {
        throw new Error("private process error");
      })
    ).not.toThrow();
  });

  it("失败清理关闭门、发 SIGTERM、确认退出后才解除引用", async () => {
    const order = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 24680,
      stdin: { destroy: () => order.push("gate-destroyed") },
      unref: () => order.push("unref")
    });
    const cleanupConfirmed = await cleanupFailedDetachedChild(child, {
      killProcessGroup: (pid, signal) => {
        order.push(`kill:${pid}:${signal}`);
        queueMicrotask(() => child.emit("exit", null, signal));
      },
      terminationGraceMs: 50,
      forceKillGraceMs: 50
    });
    expect(cleanupConfirmed).toBe(true);
    expect(order).toEqual([
      "gate-destroyed",
      "kill:-24680:SIGTERM",
      "unref"
    ]);
  });

  it("SIGTERM 未确认时升级 SIGKILL；仍未退出就返回未确认", async () => {
    const signals = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 13579,
      stdin: { destroy: vi.fn() },
      unref: vi.fn()
    });
    await expect(
      cleanupFailedDetachedChild(child, {
        killProcessGroup: (_pid, signal) => signals.push(signal),
        terminationGraceMs: 0,
        forceKillGraceMs: 0
      })
    ).resolves.toBe(false);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.unref).toHaveBeenCalledOnce();
  });
});

describe("后台启动完整顺序（全合成子进程）", () => {
  let workspace;
  let privateDirectoryHandle;

  function createPrivateDirectoryHandle() {
    workspace = mkdtempSync(join(tmpdir(), "fermata-launch-order-"));
    chmodSync(workspace, 0o700);
    const repository = join(workspace, "Fermata");
    mkdirSync(repository, { mode: 0o700 });
    const privateRoot = join(repository, "private");
    mkdirSync(privateRoot, { mode: 0o700 });
    privateDirectoryHandle = preparePrivateDirectory(
      join(privateRoot, "runs"),
      { privateRoot, containingWorkspace: workspace }
    );
    return privateDirectoryHandle;
  }

  function readOnlyMetadata(handle) {
    const metadataName = readdirSync(handle.path).find((name) =>
      name.endsWith(".json")
    );
    return JSON.parse(
      readFileSync(join(handle.path, metadataName), "utf8")
    );
  }

  afterEach(() => {
    if (privateDirectoryHandle !== undefined) {
      closePrivateDirectory(privateDirectoryHandle);
      privateDirectoryHandle = undefined;
    }
    if (workspace !== undefined) {
      rmSync(workspace, { recursive: true, force: true });
      workspace = undefined;
    }
  });

  it("先持久化含 PID 的 ready，再发送 START；START 后不再写元数据", async () => {
    const handle = createPrivateDirectoryHandle();
    const order = [];
    let spawnOptions;
    const gate = Object.assign(new EventEmitter(), {
      end: (value, callback) => {
        order.push(`gate:${readOnlyMetadata(handle).launchState}:${value}`);
        callback();
      }
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 42420,
      stdin: gate,
      unref: () => order.push("unref")
    });

    const result = await launchDetachedCalibration(
      { label: "safe-test", resume: false },
      {
        privateDirectoryHandle: handle,
        tsxLoaderPath: "/synthetic/tsx-loader.mjs",
        childEnvironment: { PATH: "/safe/bin" },
        spawnProcess: (_executable, _arguments, options) => {
          spawnOptions = options;
          queueMicrotask(() => child.emit("spawn"));
          return child;
        },
        now: () => new Date("2026-08-01T00:00:00.000Z"),
        randomRunSuffix: () => "abcdef123456"
      }
    );

    expect(result.spawnedPid).toBe(42420);
    expect(order).toEqual(["gate:ready:START\n", "unref"]);
    expect(spawnOptions).toMatchObject({
      detached: true,
      shell: false,
      cwd: "/home/ubuntu/codex-urmotiv/Fermata"
    });
    expect(spawnOptions.stdio[0]).toBe("pipe");
    expect(readOnlyMetadata(handle)).toMatchObject({
      launchState: "ready",
      pid: 42420,
      processGroupId: 42420
    });
  });

  it("ready 写盘失败时不触发 START，并在确认清理后记为 failed", async () => {
    const handle = createPrivateDirectoryHandle();
    const authorizeStart = vi.fn();
    const cleanupChild = vi.fn(async () => true);
    const child = Object.assign(new EventEmitter(), {
      pid: 31337,
      stdin: { destroy: vi.fn() },
      unref: vi.fn()
    });
    let writeCount = 0;
    const writeMetadata = (...argumentsList) => {
      writeCount += 1;
      if (writeCount === 2) {
        throw new Error("synthetic ready write failure");
      }
      return writePrivateJsonAtomically(...argumentsList);
    };

    await expect(
      launchDetachedCalibration(
        { label: "failure-test", resume: false },
        {
          privateDirectoryHandle: handle,
          tsxLoaderPath: "/synthetic/tsx-loader.mjs",
          childEnvironment: { PATH: "/safe/bin" },
          spawnProcess: () => child,
          waitForSpawn: async () => undefined,
          authorizeStart,
          cleanupChild,
          writeMetadata,
          now: () => new Date("2026-08-01T00:00:00.000Z"),
          randomRunSuffix: () => "readyfail123"
        }
      )
    ).rejects.toThrow("DETACHED_CALIBRATION_LAUNCH_FAILED");
    expect(cleanupChild).toHaveBeenCalledOnce();
    expect(authorizeStart).not.toHaveBeenCalled();
    expect(readOnlyMetadata(handle).launchState).toBe("failed");
  });

  it("授权前清理未确认时明确记为 cleanup-unconfirmed", async () => {
    const handle = createPrivateDirectoryHandle();
    const child = Object.assign(new EventEmitter(), {
      pid: 16180,
      stdin: { destroy: vi.fn() },
      unref: vi.fn()
    });
    let writeCount = 0;
    const writeMetadata = (...argumentsList) => {
      writeCount += 1;
      if (writeCount === 2) {
        throw new Error("synthetic ready write failure");
      }
      return writePrivateJsonAtomically(...argumentsList);
    };

    await expect(
      launchDetachedCalibration(
        { label: "unclean-test", resume: false },
        {
          privateDirectoryHandle: handle,
          tsxLoaderPath: "/synthetic/tsx-loader.mjs",
          childEnvironment: { PATH: "/safe/bin" },
          spawnProcess: () => child,
          waitForSpawn: async () => undefined,
          authorizeStart: vi.fn(),
          cleanupChild: async () => false,
          writeMetadata,
          now: () => new Date("2026-08-01T00:00:00.000Z"),
          randomRunSuffix: () => "unclean123"
        }
      )
    ).rejects.toThrow("DETACHED_CALIBRATION_LAUNCH_FAILED");
    expect(readOnlyMetadata(handle).launchState).toBe("cleanup-unconfirmed");
  });

  it("START 结果不确定时绝不终止，也不把 ready 改成 failed", async () => {
    const handle = createPrivateDirectoryHandle();
    const cleanupChild = vi.fn(async () => true);
    const destroy = vi.fn();
    const unref = vi.fn();
    const child = Object.assign(new EventEmitter(), {
      pid: 27182,
      stdin: { destroy },
      unref
    });

    await expect(
      launchDetachedCalibration(
        { label: "uncertain-test", resume: false },
        {
          privateDirectoryHandle: handle,
          tsxLoaderPath: "/synthetic/tsx-loader.mjs",
          childEnvironment: { PATH: "/safe/bin" },
          spawnProcess: () => child,
          waitForSpawn: async () => undefined,
          authorizeStart: async () => {
            throw new Error("synthetic ambiguous gate error");
          },
          cleanupChild,
          now: () => new Date("2026-08-01T00:00:00.000Z"),
          randomRunSuffix: () => "uncertain123"
        }
      )
    ).rejects.toThrow("DETACHED_CALIBRATION_AUTHORIZATION_UNCERTAIN");
    expect(cleanupChild).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();
    expect(readOnlyMetadata(handle).launchState).toBe("ready");
  });
});

describe("后台私有元数据与 worker", () => {
  let directory;

  afterEach(() => {
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it("日志和原子元数据固定为 0600", () => {
    directory = mkdtempSync(join(tmpdir(), "fermata-detached-files-"));
    chmodSync(directory, 0o700);
    const logPath = join(directory, "run.log");
    const descriptor = openPrivateFile(logPath);
    closeSync(descriptor);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);

    writePrivateJsonAtomically(directory, "run.json", {
      schemaVersion: 1,
      launchState: "ready"
    });
    expect(statSync(join(directory, "run.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(directory, "run.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      launchState: "ready"
    });
  });

  it("worker 启动门读取严格限制为授权长度加一字节", () => {
    const source = Buffer.from("START\nEXTRA", "utf8");
    let sourceOffset = 0;
    const authorization = readStartAuthorization(
      0,
      (_descriptor, target, targetOffset, length) => {
        const bytes = Math.min(2, length, source.length - sourceOffset);
        if (bytes <= 0) {
          return 0;
        }
        source.copy(target, targetOffset, sourceOffset, sourceOffset + bytes);
        sourceOffset += bytes;
        return bytes;
      }
    );
    expect(Buffer.byteLength(authorization)).toBe(7);
    expect(() => validateStartAuthorization(authorization)).toThrow(
      "DETACHED_WORKER_NOT_AUTHORIZED"
    );
  });

  it("worker 在精确授权前绝不载入标定入口", async () => {
    expect(() => validateStartAuthorization("START\r\n")).toThrow(
      "DETACHED_WORKER_NOT_AUTHORIZED"
    );
    const loadCalibration = vi.fn();
    const closeAuthorization = vi.fn();
    await expect(
      runDetachedCalibrationWorker({
        readAuthorization: () => "not-start\n",
        closeAuthorization,
        loadCalibration
      })
    ).rejects.toThrow("DETACHED_WORKER_NOT_AUTHORIZED");
    expect(closeAuthorization).toHaveBeenCalledOnce();
    expect(loadCalibration).not.toHaveBeenCalled();
  });

  it("worker 读取失败仍关闭门，精确授权才调用合成 loader", async () => {
    const closeFailedGate = vi.fn();
    await expect(
      runDetachedCalibrationWorker({
        readAuthorization: () => {
          throw new Error("private gate error");
        },
        closeAuthorization: closeFailedGate,
        loadCalibration: vi.fn()
      })
    ).rejects.toThrow("DETACHED_WORKER_GATE_READ_FAILED");
    expect(closeFailedGate).toHaveBeenCalledOnce();

    const order = [];
    await expect(
      runDetachedCalibrationWorker({
        readAuthorization: () => "START\n",
        closeAuthorization: () => order.push("closed"),
        loadCalibration: async () => order.push("loaded")
      })
    ).resolves.toBeUndefined();
    expect(order).toEqual(["closed", "loaded"]);
  });
});
