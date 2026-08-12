import { describe, expect, it } from "vitest";
import {
  buildDualAxisCalibrationSummary,
  buildStageCalibrationReport,
  deriveCheckpointAfterWorkerLoss,
  evaluateStageCheckpointCompleteness,
  reusableStagesFromCheckpointCase,
  type StageCheckpoint
} from "../experiments/lib/review-flow-stage-state";
import { hashCanonicalValue } from "../src/review-flow/evidence";

const binding = "a".repeat(64);
const completedStage = (stage: "A" | "B" | "C" | "D" | "formatter", suffix: string) => {
  const output = `${stage}-${suffix}`;
  const bound = {
    stage,
    inputHash: binding,
    promptHash: "b".repeat(64),
    schemaFingerprint: stage === "formatter" ? "c".repeat(64) : null,
    modelFingerprint: "d".repeat(64),
    attemptCount: 1,
    eofVerified: true as const,
    outputHash: hashCanonicalValue(output)
  };
  return {
    stage,
    status: "completed" as const,
    output,
    receipt: { ...bound, receiptHash: hashCanonicalValue(bound) }
  };
};

function completeCheckpoint(): StageCheckpoint {
  return {
    schemaVersion: 1,
    expectedCaseIds: ["case-1"],
    cases: [{
      caseId: "case-1",
      status: "completed",
      stages: [
        completedStage("A", "1"),
        completedStage("B", "2"),
        completedStage("C", "3"),
        completedStage("D", "4")
      ]
    }]
  };
}

describe("逐阶段 checkpoint 与完整性", () => {
  it("derives dead active as orphaned_unknown without mutating old checkpoint bytes", () => {
    const old: StageCheckpoint = {
      schemaVersion: 1,
      expectedCaseIds: ["case-1"],
      cases: [{
        caseId: "case-1",
        status: "active",
        stages: [
          completedStage("A", "1"),
          { stage: "B", status: "active", workerId: "dead-worker" },
          { stage: "C", status: "pending" },
          { stage: "D", status: "pending" }
        ]
      }]
    };
    const before = JSON.stringify(old);
    const derived = deriveCheckpointAfterWorkerLoss(old, new Set());
    expect(JSON.stringify(old)).toBe(before);
    expect(derived).not.toBe(old);
    expect(derived.cases[0]!.status).toBe("orphaned_unknown");
    expect(derived.cases[0]!.stages[1]).toEqual({
      stage: "B",
      status: "orphaned_unknown",
      formerWorkerId: "dead-worker"
    });
  });

  it("requires zero pending/active/orphaned/failed/missing and one unique receipt per required stage", () => {
    expect(evaluateStageCheckpointCompleteness(completeCheckpoint())).toEqual({
      complete: true,
      counts: { pending: 0, active: 0, orphanedUnknown: 0, failed: 0, missing: 0 },
      duplicateReceiptCount: 0,
      invalidReceiptCount: 0
    });
    expect(Object.keys(reusableStagesFromCheckpointCase(completeCheckpoint().cases[0]!))).toEqual([
      "A", "B", "C", "D"
    ]);
    const incomplete = completeCheckpoint();
    incomplete.cases[0]!.stages[3] = { stage: "D", status: "failed", failureKind: "stream_interrupted" };
    const gate = evaluateStageCheckpointCompleteness(incomplete);
    expect(gate.complete).toBe(false);
    expect(gate.counts.failed).toBe(1);
    expect(gate.counts.missing).toBe(1);
    expect(buildStageCalibrationReport(incomplete, [])).toMatchObject({
      status: "INCOMPLETE",
      metrics: null
    });
  });
});

describe("双轴标定摘要", () => {
  it("scores verdict only against independent human truth and difficulty only against frozen CF reference", () => {
    const cases = [
      {
        predictedVerdict: "approve" as const,
        humanVerdict: "reject" as const,
        predictedCodeforcesDifficulty: 1700,
        frozenCodeforcesDifficulty: 1800
      },
      {
        predictedVerdict: "reject" as const,
        humanVerdict: "reject" as const,
        predictedCodeforcesDifficulty: null,
        frozenCodeforcesDifficulty: null
      },
      {
        predictedVerdict: "request_changes" as const,
        humanVerdict: "approve" as const,
        predictedCodeforcesDifficulty: 2200,
        frozenCodeforcesDifficulty: 2400
      }
    ];
    const summary = buildDualAxisCalibrationSummary(cases);
    expect(summary.verdict.predictedClassCounts).toEqual({ approve: 1, request_changes: 1, reject: 1 });
    expect(summary.verdict.humanClassCounts).toEqual({ approve: 1, request_changes: 0, reject: 2 });
    expect(summary.verdict.confusion.reject.approve).toBe(1);
    expect(summary.verdict.falseAcceptCount).toBe(1);
    expect(summary.verdict.falseRejectCount).toBe(1);
    expect(summary.difficulty.scoredCaseCount).toBe(2);
    expect(summary.difficulty.mae).toBe(150);
    expect(summary.difficulty.strata).toEqual({
      "800-1399": { referenceCount: 0, predictionCount: 0 },
      "1400-1999": { referenceCount: 1, predictionCount: 1 },
      "2000-2599": { referenceCount: 1, predictionCount: 1 },
      "2600-3500": { referenceCount: 0, predictionCount: 0 }
    });
    expect(buildStageCalibrationReport(completeCheckpoint(), cases)).toMatchObject({
      status: "COMPLETE",
      metrics: summary
    });
  });
});
