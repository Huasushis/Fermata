import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  continueVerdictEvaluationUnlessContaminated,
  VerdictEvaluationCheckpoint,
  type VerdictCheckpointCaseBinding
} from "../experiments/lib/verdict-evaluation-checkpoint";

describe("verdict 私有 prediction-only 检查点", () => {
  let workspace: string;
  let privateRoot: string;
  const digest = "a".repeat(64);
  const cases: readonly VerdictCheckpointCaseBinding[] = [
    { sampleId: "sample-a:normal", contentHash: digest },
    { sampleId: "sample-a:fabricated_duplicate", contentHash: digest },
    { sampleId: "sample-b:normal", contentHash: "b".repeat(64) }
  ];

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "fermata-verdict-checkpoint-"));
    chmodSync(workspace, 0o700);
    const repository = join(workspace, "Fermata");
    mkdirSync(repository, { mode: 0o700 });
    privateRoot = join(repository, "private");
    mkdirSync(privateRoot, { mode: 0o700 });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function open(configurationFingerprint = digest): VerdictEvaluationCheckpoint {
    return new VerdictEvaluationCheckpoint({
      label: "baseline",
      reportRunId: "baseline-2026-08-02T00-00-00-000Z-12345678",
      contentDatasetFingerprint: digest,
      configurationFingerprint,
      expectedCases: cases,
      privateRoot,
      containingWorkspace: workspace,
      now: () => new Date("2026-08-02T00:00:00.000Z")
    });
  }

  const prediction = {
    verdict: "approve" as const,
    forcedDuplicateReject: false,
    highestKnownSimilarity: 0,
    appliedDuplicateSimilarityRejectThreshold: 0.9
  };

  it("创建 0600 检查点和排他锁，同标签并发打开失败", () => {
    const first = open();
    const statePath = join(
      privateRoot,
      "evaluation-state",
      "verdict-baseline.checkpoint.private.json"
    );
    const lockPath = join(
      privateRoot,
      "evaluation-state",
      "verdict-baseline.lock.private"
    );
    expect(lstatSync(statePath).mode & 0o777).toBe(0o600);
    expect(lstatSync(lockPath).mode & 0o777).toBe(0o600);
    expect(() => open()).toThrow("VERDICT_CHECKPOINT_LOCKED_OR_UNAVAILABLE");
    first.close();
    const resumed = open();
    expect(resumed.openedExistingCheckpoint()).toBe(true);
    resumed.close();
  });

  it("active 在请求前保存，重启后成为永久失败且失败链不再调用模型", async () => {
    let checkpoint = open();
    checkpoint.markActive(cases[0]!.sampleId);
    checkpoint.close();

    checkpoint = open();
    const modelCall = vi.fn(async () => undefined);
    const result = await continueVerdictEvaluationUnlessContaminated({
      checkpoint,
      expectedSampleIds: cases.map((entry) => entry.sampleId),
      continueClean: modelCall
    });
    expect(modelCall).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "contaminated",
      integrity: { expected: 3, succeeded: 0, complete: false }
    });
    if (result.kind === "contaminated") {
      expect(result.integrity.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({
          sampleId: cases[0]!.sampleId,
          code: "EVALUATION_ACTIVE_FROM_INTERRUPTED_RUN"
        }),
        expect.objectContaining({ code: "EVALUATION_SAMPLE_MISSING" })
      ]));
    }
    checkpoint.close();
  });

  it("成功只保存 case/contentHash/预测，不保存 rating、expected 或 expectationMet", () => {
    const checkpoint = open();
    checkpoint.markActive(cases[0]!.sampleId);
    checkpoint.markSucceeded(cases[0]!.sampleId, prediction);
    const serialized = readFileSync(
      join(
        privateRoot,
        "evaluation-state",
        "verdict-baseline.checkpoint.private.json"
      ),
      "utf8"
    );
    for (const forbidden of [
      "rating",
      "expectedVerdict",
      "expectedForcedDuplicateReject",
      "expectationMet",
      "31337"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(checkpoint.succeededPredictions()).toEqual([{
      sampleId: cases[0]!.sampleId,
      contentHash: digest,
      prediction
    }]);
    checkpoint.close();
  });

  it("clean resume 只返回 pending，已成功 case 不重复付费", async () => {
    let checkpoint = open();
    checkpoint.markActive(cases[0]!.sampleId);
    checkpoint.markSucceeded(cases[0]!.sampleId, prediction);
    checkpoint.close();

    checkpoint = open();
    const modelCall = vi.fn(async () => "continued");
    const result = await continueVerdictEvaluationUnlessContaminated({
      checkpoint,
      expectedSampleIds: cases.map((entry) => entry.sampleId),
      continueClean: modelCall
    });
    expect(result).toEqual({ kind: "continued", value: "continued" });
    expect(modelCall).toHaveBeenCalledOnce();
    expect(checkpoint.pendingCases().map((entry) => entry.sampleId)).toEqual([
      cases[1]!.sampleId,
      cases[2]!.sampleId
    ]);
    checkpoint.close();
  });

  it("明确失败污染链；pending 保持缺失且 resume 不再付费", async () => {
    let checkpoint = open();
    checkpoint.markActive(cases[0]!.sampleId);
    checkpoint.markFailed(cases[0]!.sampleId, {
      sampleId: cases[0]!.sampleId,
      phase: "execution",
      code: "LLM_CANCELLED"
    });
    checkpoint.close();

    checkpoint = open();
    const modelCall = vi.fn(async () => undefined);
    const result = await continueVerdictEvaluationUnlessContaminated({
      checkpoint,
      expectedSampleIds: cases.map((entry) => entry.sampleId),
      continueClean: modelCall
    });
    expect(modelCall).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "contaminated" });
    checkpoint.close();
  });

  it("只有全部 succeeded 才能封存，封存身份在 resume 后保留", () => {
    let checkpoint = open();
    expect(() => checkpoint.markCompleteReportPublished("run-a", digest)).toThrow(
      "VERDICT_CHECKPOINT_REPORT_NOT_PUBLISHABLE"
    );
    for (const entry of cases) {
      checkpoint.markActive(entry.sampleId);
      checkpoint.markSucceeded(entry.sampleId, prediction);
    }
    const chainRunId = checkpoint.snapshot().chainRunId;
    checkpoint.markCompleteReportPublished("run-a", digest);
    checkpoint.close();

    checkpoint = open();
    expect(checkpoint.hasPublishedCompleteReport()).toBe(true);
    expect(checkpoint.snapshot()).toMatchObject({
      chainRunId,
      publishedReport: {
        executionRunId: "run-a",
        completionFingerprint: digest
      }
    });
    checkpoint.close();
  });

  it("配置、case contentHash 和 schema 版本变化都拒绝续跑", () => {
    let checkpoint = open();
    checkpoint.close();
    expect(() => open("c".repeat(64))).toThrow(
      "VERDICT_CHECKPOINT_FINGERPRINT_MISMATCH"
    );
    expect(() => new VerdictEvaluationCheckpoint({
      label: "baseline",
      reportRunId: "baseline-2026-08-02T00-00-00-000Z-12345678",
      contentDatasetFingerprint: digest,
      configurationFingerprint: digest,
      expectedCases: [{ ...cases[0]!, contentHash: "d".repeat(64) }, ...cases.slice(1)],
      privateRoot,
      containingWorkspace: workspace
    })).toThrow("VERDICT_CHECKPOINT_FINGERPRINT_MISMATCH");

    const statePath = join(
      privateRoot,
      "evaluation-state",
      "verdict-baseline.checkpoint.private.json"
    );
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { schemaVersion: number };
    state.schemaVersion = 2;
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    expect(() => open()).toThrow("VERDICT_CHECKPOINT_VERSION_UNSUPPORTED");
  });
});
