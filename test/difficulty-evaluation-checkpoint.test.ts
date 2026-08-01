import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  continueDifficultyEvaluationUnlessContaminated,
  DifficultyEvaluationCheckpoint,
  difficultyCheckpointLockRecordSchema
} from "../experiments/lib/difficulty-evaluation-checkpoint";

describe("difficulty 私有检查点", () => {
  let workspace: string;
  let privateRoot: string;
  const digest = "a".repeat(64);

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "fermata-difficulty-checkpoint-"));
    chmodSync(workspace, 0o700);
    const repository = join(workspace, "Fermata");
    mkdirSync(repository, { mode: 0o700 });
    privateRoot = join(repository, "private");
    mkdirSync(privateRoot, { mode: 0o700 });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function open(configurationFingerprint = digest): DifficultyEvaluationCheckpoint {
    return new DifficultyEvaluationCheckpoint({
      label: "baseline",
      reportRunId: "baseline-2026-08-01T00-00-00-000Z-12345678",
      datasetManifestFingerprint: digest,
      configurationFingerprint,
      expectedSampleIds: ["source-a", "source-b"],
      privateRoot,
      containingWorkspace: workspace,
      now: () => new Date("2026-08-01T00:00:00.000Z")
    });
  }

  function openCrashCase(): DifficultyEvaluationCheckpoint {
    return new DifficultyEvaluationCheckpoint({
      label: "crash-case",
      reportRunId: "crash-case-2026-08-01T00-00-00-000Z-12345678",
      datasetManifestFingerprint: digest,
      configurationFingerprint: digest,
      expectedSampleIds: ["source-a", "source-b"],
      privateRoot,
      containingWorkspace: workspace,
      now: () => new Date("2026-08-01T00:00:00.000Z")
    });
  }

  function openResumeGateCase(): DifficultyEvaluationCheckpoint {
    return new DifficultyEvaluationCheckpoint({
      label: "resume-gate",
      reportRunId: "resume-gate-2026-08-01T00-00-00-000Z-12345678",
      datasetManifestFingerprint: digest,
      configurationFingerprint: digest,
      expectedSampleIds: ["source-a", "source-b", "source-c", "source-d"],
      privateRoot,
      containingWorkspace: workspace,
      now: () => new Date("2026-08-01T00:00:00.000Z")
    });
  }

  it("首次运行在 0700 目录中创建 0600 检查点", () => {
    const checkpoint = open();
    expect(checkpoint.pendingSampleIds()).toEqual(["source-a", "source-b"]);
    checkpoint.close();
    const stateDirectory = join(privateRoot, "evaluation-state");
    expect(lstatSync(stateDirectory).mode & 0o777).toBe(0o700);
    const files = readdirSync(stateDirectory);
    expect(files).toEqual(["difficulty-baseline.checkpoint.private.json"]);
    expect(lstatSync(join(stateDirectory, files[0]!)).mode & 0o777).toBe(0o600);
  });

  it("active 在模型请求前持久化，崩溃后重载为永久不完整", () => {
    let checkpoint = open();
    checkpoint.markActive("source-a");
    checkpoint.close();

    checkpoint = open();
    expect(checkpoint.terminalFailures()).toEqual([
      expect.objectContaining({ sampleId: "source-a", code: "EVALUATION_ACTIVE_FROM_INTERRUPTED_RUN" })
    ]);
    expect(checkpoint.pendingSampleIds()).toEqual(["source-b"]);
    checkpoint.close();
  });

  it("成功数值结果原子保存，resume 只返回剩余 pending", () => {
    let checkpoint = open();
    checkpoint.markActive("source-a");
    checkpoint.markSucceeded("source-a", {
      contestId: 1,
      index: "A",
      actualRating: 800,
      predictedRating: 900,
      error: 100,
      confidence: 0.75
    });
    checkpoint.close();

    checkpoint = open();
    expect(checkpoint.pendingSampleIds()).toEqual(["source-b"]);
    expect(checkpoint.succeededRows()).toEqual([
      expect.objectContaining({ sampleId: "source-a", predictedRating: 900 })
    ]);
    expect(checkpoint.terminalFailures()).toEqual([]);
    checkpoint.close();
  });

  it("明确失败不自动重试，指纹变化也不沿用旧链", () => {
    let checkpoint = open();
    checkpoint.markActive("source-a");
    checkpoint.markFailed("source-a", {
      sampleId: "source-a",
      phase: "execution",
      code: "LLM_HTTP_ERROR",
      httpStatus: 499
    });
    checkpoint.close();

    checkpoint = open();
    expect(checkpoint.terminalFailures()).toEqual([
      expect.objectContaining({ code: "LLM_HTTP_ERROR", httpStatus: 499 })
    ]);
    checkpoint.close();
    expect(() => open("b".repeat(64))).toThrow("DIFFICULTY_CHECKPOINT_FINGERPRINT_MISMATCH");
  });

  it("污染 resume 在模型调用门前收束，pending 保持不变并显式记为缺失", async () => {
    let checkpoint = openResumeGateCase();
    checkpoint.markActive("source-a");
    checkpoint.markSucceeded("source-a", {
      contestId: 1,
      index: "A",
      actualRating: 800,
      predictedRating: 900,
      error: 100,
      confidence: 0.75
    });
    checkpoint.markActive("source-b");
    checkpoint.markFailed("source-b", {
      sampleId: "source-b",
      phase: "execution",
      code: "LLM_HTTP_ERROR",
      httpStatus: 499
    });
    checkpoint.markActive("source-c");
    checkpoint.close();

    checkpoint = openResumeGateCase();
    const modelCall = vi.fn(async () => undefined);
    const continueClean = vi.fn(async () => {
      checkpoint.markActive("source-d");
      await modelCall();
      return null;
    });
    const result = await continueDifficultyEvaluationUnlessContaminated({
      checkpoint,
      expectedSampleIds: ["source-a", "source-b", "source-c", "source-d"],
      continueClean
    });

    expect(result.kind).toBe("contaminated");
    expect(continueClean).not.toHaveBeenCalled();
    expect(modelCall).not.toHaveBeenCalled();
    expect(checkpoint.pendingSampleIds()).toEqual(["source-d"]);
    if (result.kind === "contaminated") {
      expect(result.persistedRows.map((row) => row.sampleId)).toEqual(["source-a"]);
      expect(result.integrity).toMatchObject({
        expected: 4,
        succeeded: 1,
        failed: 3,
        complete: false
      });
      expect(result.integrity.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ sampleId: "source-b", code: "LLM_HTTP_ERROR" }),
        expect.objectContaining({
          sampleId: "source-c",
          code: "EVALUATION_ACTIVE_FROM_INTERRUPTED_RUN"
        }),
        expect.objectContaining({
          sampleId: "source-d",
          code: "EVALUATION_SAMPLE_MISSING"
        })
      ]));
    }
    checkpoint.close();
  });

  it("新建 clean checkpoint 仍进入模型调用路径", async () => {
    const checkpoint = open();
    const modelCall = vi.fn(async () => "finished");
    const result = await continueDifficultyEvaluationUnlessContaminated({
      checkpoint,
      expectedSampleIds: ["source-a", "source-b"],
      continueClean: async () => {
        checkpoint.markActive("source-a");
        const value = await modelCall();
        checkpoint.markSucceeded("source-a", {
          contestId: 1,
          index: "A",
          actualRating: 800,
          predictedRating: 800,
          error: 0,
          confidence: 0.5
        });
        return value;
      }
    });

    expect(result).toEqual({ kind: "continued", value: "finished" });
    expect(modelCall).toHaveBeenCalledTimes(1);
    expect(checkpoint.pendingSampleIds()).toEqual(["source-b"]);
    checkpoint.close();
  });

  it("同一标签只允许一个进程持有检查点，释放后才能安全续跑", () => {
    const firstCheckpoint = open();
    const lockRecord = difficultyCheckpointLockRecordSchema.parse(
      JSON.parse(
        readFileSync(
          join(privateRoot, "evaluation-state", "difficulty-baseline.lock.private"),
          "utf8"
        )
      ) as unknown
    );
    expect(lockRecord).toMatchObject({
      processId: process.pid,
      chainRunId: firstCheckpoint.snapshot().chainRunId,
      originalReportRunId: firstCheckpoint.snapshot().reportRunId,
      chainIdentityStatus: "checkpoint_bound"
    });
    expect(() => open()).toThrow("DIFFICULTY_CHECKPOINT_LOCKED_OR_UNAVAILABLE");
    firstCheckpoint.close();

    const resumed = open();
    expect(resumed.pendingSampleIds()).toEqual(["source-a", "source-b"]);
    resumed.close();
  });

  it("真实 SIGKILL 遗留锁只允许人工核验后移除，恢复后不再调度 pending", async () => {
    const fixture = fileURLToPath(
      new URL("./fixtures/difficulty-checkpoint-crash.ts", import.meta.url)
    );
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", fixture, workspace, privateRoot],
      { encoding: "utf8" }
    );
    expect(child.signal).toBe("SIGKILL");
    expect(child.stdout).toBe("ACTIVE_PERSISTED\n");

    const lockPath = join(
      privateRoot,
      "evaluation-state",
      "difficulty-crash-case.lock.private"
    );
    const lockRecord = difficultyCheckpointLockRecordSchema.parse(
      JSON.parse(readFileSync(lockPath, "utf8")) as unknown
    );
    expect(lockRecord.processId).toBe(child.pid);
    expect(lockRecord.processStartTimeTicks).toMatch(/^[1-9][0-9]*$/);
    expect(lockRecord.chainIdentityStatus).toBe("checkpoint_bound");
    expect(() => openCrashCase()).toThrow("DIFFICULTY_CHECKPOINT_LOCKED_OR_UNAVAILABLE");

    // spawnSync 已确认并回收这个确切 PID 的 SIGKILL 退出；模拟运维按文档核验后，
    // 只删除这一把精确标签锁，不删除或改写检查点。
    unlinkSync(lockPath);
    const resumed = openCrashCase();
    expect(resumed.terminalFailures()).toEqual([
      expect.objectContaining({
        sampleId: "source-a",
        code: "EVALUATION_ACTIVE_FROM_INTERRUPTED_RUN"
      })
    ]);
    expect(resumed.pendingSampleIds()).toEqual(["source-b"]);
    const continueClean = vi.fn(async () => undefined);
    const result = await continueDifficultyEvaluationUnlessContaminated({
      checkpoint: resumed,
      expectedSampleIds: ["source-a", "source-b"],
      continueClean
    });
    expect(continueClean).not.toHaveBeenCalled();
    expect(resumed.pendingSampleIds()).toEqual(["source-b"]);
    expect(result).toMatchObject({
      kind: "contaminated",
      integrity: { expected: 2, succeeded: 0, failed: 2, complete: false }
    });
    if (result.kind === "contaminated") {
      expect(result.integrity.failures).toContainEqual(expect.objectContaining({
        sampleId: "source-b",
        code: "EVALUATION_SAMPLE_MISSING"
      }));
    }
    resumed.close();
  });

  it("完整报告封存绑定原始链身份，且只有全成功链可以封存", () => {
    let checkpoint = open();
    expect(() => checkpoint.markCompleteReportPublished("run-a", digest)).toThrow(
      "DIFFICULTY_CHECKPOINT_REPORT_NOT_PUBLISHABLE"
    );
    for (const [sampleId, contestId, index, rating] of [
      ["source-a", 1, "A", 800],
      ["source-b", 2, "B", 1600]
    ] as const) {
      checkpoint.markActive(sampleId);
      checkpoint.markSucceeded(sampleId, {
        contestId,
        index,
        actualRating: rating,
        predictedRating: rating,
        error: 0,
        confidence: 0.5
      });
    }
    const originalIdentity = checkpoint.snapshot();
    checkpoint.markCompleteReportPublished("run-a", digest);
    expect(checkpoint.hasPublishedCompleteReport()).toBe(true);
    checkpoint.close();

    checkpoint = open();
    expect(checkpoint.openedExistingCheckpoint()).toBe(true);
    expect(checkpoint.snapshot()).toMatchObject({
      chainRunId: originalIdentity.chainRunId,
      reportRunId: originalIdentity.reportRunId,
      publishedReport: { executionRunId: "run-a", completionFingerprint: digest }
    });
    checkpoint.close();
  });
});
