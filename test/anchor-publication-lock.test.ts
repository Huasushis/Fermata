import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireAnchorPublicationLock,
  anchorPublicationLockRecordSchema
} from "../experiments/lib/anchor-publication-lock";

describe("正式锚点全局发布锁", () => {
  let workspace: string;
  let privateRoot: string;
  const digest = "a".repeat(64);

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "fermata-anchor-lock-"));
    chmodSync(workspace, 0o700);
    const repository = join(workspace, "Fermata");
    mkdirSync(repository, { mode: 0o700 });
    privateRoot = join(repository, "private");
    mkdirSync(privateRoot, { mode: 0o700 });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function acquire(runId: string) {
    return acquireAnchorPublicationLock({
      runId,
      targetFingerprint: digest,
      privateRoot,
      containingWorkspace: workspace,
      now: () => new Date("2026-08-01T00:00:00.000Z")
    });
  }

  it("不同标签共用同一正式目标锁，持锁期间第二轮失败，释放后才能继续", () => {
    const first = acquire("anchor-first-label");
    const lockDirectory = join(privateRoot, "anchor-publication");
    const lockPath = join(
      lockDirectory,
      "difficulty-anchors-publication.lock.private"
    );
    const record = anchorPublicationLockRecordSchema.parse(
      JSON.parse(readFileSync(lockPath, "utf8")) as unknown
    );
    expect(record).toMatchObject({
      processId: process.pid,
      runId: "anchor-first-label",
      targetFingerprint: digest,
      expectedCommandKind: "FERMATA_CALIBRATE_ANCHORS",
      recoveryRule: "VERIFY_PID_START_TIME_FULL_COMMAND_AND_CWD_BEFORE_MANUAL_REMOVAL"
    });
    expect(record.processStartTimeTicks).toMatch(/^[1-9][0-9]*$/);
    expect(record.processCommandFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(record.expectedWorkingDirectoryFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(lstatSync(lockDirectory).mode & 0o777).toBe(0o700);
    expect(lstatSync(lockPath).mode & 0o777).toBe(0o600);

    expect(() => acquire("anchor-second-label")).toThrow(
      "ANCHOR_PUBLICATION_LOCKED_OR_UNAVAILABLE"
    );
    first.assertHeld();
    expect(first.release()).toBe(true);
    expect(first.release()).toBe(true);

    const second = acquire("anchor-second-label");
    second.assertHeld();
    expect(second.release()).toBe(true);
  });

  it("无效的既有锁也 fail-closed，绝不自动清理或改写", () => {
    const lockDirectory = join(privateRoot, "anchor-publication");
    mkdirSync(lockDirectory, { mode: 0o700 });
    const lockPath = join(
      lockDirectory,
      "difficulty-anchors-publication.lock.private"
    );
    writeFileSync(lockPath, "legacy-lock-must-remain\n", { mode: 0o600 });

    expect(() => acquire("anchor-blocked")).toThrow(
      "ANCHOR_PUBLICATION_LOCKED_OR_UNAVAILABLE"
    );
    expect(readFileSync(lockPath, "utf8")).toBe("legacy-lock-must-remain\n");
  });

  it("锁路径被替换后拒绝发布和释放，且不误删替代文件", () => {
    const lock = acquire("anchor-ownership-check");
    const lockPath = join(
      privateRoot,
      "anchor-publication",
      "difficulty-anchors-publication.lock.private"
    );
    unlinkSync(lockPath);
    writeFileSync(lockPath, "replacement-lock-must-remain\n", { mode: 0o600 });

    expect(() => lock.assertHeld()).toThrow(
      "ANCHOR_PUBLICATION_LOCK_OWNERSHIP_LOST"
    );
    expect(lock.release()).toBe(false);
    expect(readFileSync(lockPath, "utf8")).toBe("replacement-lock-must-remain\n");
  });

  it("真实 SIGKILL 遗留锁必须人工核验并精确移除", () => {
    const fixture = fileURLToPath(
      new URL("./fixtures/anchor-publication-lock-crash.ts", import.meta.url)
    );
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", fixture, workspace, privateRoot],
      { encoding: "utf8" }
    );
    expect(child.signal).toBe("SIGKILL");
    expect(child.stdout).toBe("ANCHOR_LOCK_ACQUIRED\n");

    const lockPath = join(
      privateRoot,
      "anchor-publication",
      "difficulty-anchors-publication.lock.private"
    );
    const record = anchorPublicationLockRecordSchema.parse(
      JSON.parse(readFileSync(lockPath, "utf8")) as unknown
    );
    expect(record.processId).toBe(child.pid);
    expect(record.runId).toBe("anchor-crash-case");
    expect(() => acquire("anchor-after-crash")).toThrow(
      "ANCHOR_PUBLICATION_LOCKED_OR_UNAVAILABLE"
    );

    // spawnSync 已确认并回收这个确切 PID 的 SIGKILL 退出；模拟运维完整核验后，
    // 只移除这一把固定锁，不触碰任何检查点、报告或其他进程。
    unlinkSync(lockPath);
    const recovered = acquire("anchor-after-crash");
    expect(recovered.release()).toBe(true);
  });
});
