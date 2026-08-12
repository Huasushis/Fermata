import { hashCanonicalValue } from "../../src/review-flow/evidence";
import type { ReviewFlowStageReceipt } from "../../src/review-flow/four-call";

export type CheckpointSemanticStage = "A" | "B" | "C" | "D";
export type CheckpointStage = CheckpointSemanticStage | "formatter";
export type CheckpointCaseStatus =
  | "pending"
  | "active"
  | "completed"
  | "failed"
  | "orphaned_unknown";

export type StageCheckpointEntry =
  | { stage: CheckpointStage; status: "pending" }
  | { stage: CheckpointStage; status: "active"; workerId: string }
  | { stage: CheckpointStage; status: "completed"; output: string; receipt: ReviewFlowStageReceipt }
  | { stage: CheckpointStage; status: "failed"; failureKind: string }
  | { stage: CheckpointStage; status: "orphaned_unknown"; formerWorkerId: string };

export interface StageCheckpointCase {
  caseId: string;
  status: CheckpointCaseStatus;
  stages: StageCheckpointEntry[];
}

export interface StageCheckpoint {
  schemaVersion: 1;
  expectedCaseIds: string[];
  cases: StageCheckpointCase[];
}

export interface StageCheckpointCompleteness {
  readonly complete: boolean;
  readonly counts: {
    readonly pending: number;
    readonly active: number;
    readonly orphanedUnknown: number;
    readonly failed: number;
    readonly missing: number;
  };
  readonly duplicateReceiptCount: number;
  readonly invalidReceiptCount: number;
}

const requiredSemanticStages: readonly CheckpointSemanticStage[] = Object.freeze(["A", "B", "C", "D"]);

/**
 * 生成新的派生状态；调用方负责把它写入新 checkpoint。输入对象及旧文件字节均不修改。
 */
export function deriveCheckpointAfterWorkerLoss(
  checkpoint: StageCheckpoint,
  liveWorkerIds: ReadonlySet<string>
): StageCheckpoint {
  const cases = checkpoint.cases.map((checkpointCase) => {
    let orphaned = false;
    const stages = checkpointCase.stages.map((stage): StageCheckpointEntry => {
      if (stage.status !== "active" || liveWorkerIds.has(stage.workerId)) return structuredClone(stage);
      orphaned = true;
      return {
        stage: stage.stage,
        status: "orphaned_unknown",
        formerWorkerId: stage.workerId
      };
    });
    return {
      caseId: checkpointCase.caseId,
      status: orphaned ? "orphaned_unknown" as const : checkpointCase.status,
      stages
    };
  });
  return {
    schemaVersion: 1,
    expectedCaseIds: [...checkpoint.expectedCaseIds],
    cases
  };
}

export function evaluateStageCheckpointCompleteness(
  checkpoint: StageCheckpoint
): StageCheckpointCompleteness {
  const counts = {
    pending: 0,
    active: 0,
    orphanedUnknown: 0,
    failed: 0,
    missing: 0
  };
  let duplicateReceiptCount = 0;
  let invalidReceiptCount = 0;
  const receiptHashes = new Set<string>();
  const casesById = new Map(checkpoint.cases.map((entry) => [entry.caseId, entry]));

  for (const caseId of checkpoint.expectedCaseIds) {
    const checkpointCase = casesById.get(caseId);
    if (checkpointCase === undefined) {
      counts.missing += requiredSemanticStages.length;
      continue;
    }
    const stageEntries = new Map<CheckpointStage, StageCheckpointEntry>();
    for (const stage of checkpointCase.stages) {
      if (stageEntries.has(stage.stage)) {
        duplicateReceiptCount += 1;
        continue;
      }
      stageEntries.set(stage.stage, stage);
      if (stage.status === "pending") counts.pending += 1;
      if (stage.status === "active") counts.active += 1;
      if (stage.status === "orphaned_unknown") counts.orphanedUnknown += 1;
      if (stage.status === "failed") counts.failed += 1;
      if (stage.status === "completed") {
        if (!receiptIsValidForStage(stage.receipt, stage.stage, stage.output)) {
          invalidReceiptCount += 1;
        } else if (receiptHashes.has(stage.receipt.receiptHash)) {
          duplicateReceiptCount += 1;
        } else {
          receiptHashes.add(stage.receipt.receiptHash);
        }
      }
    }
    for (const required of requiredSemanticStages) {
      if (stageEntries.get(required)?.status !== "completed") counts.missing += 1;
    }
    const formatter = stageEntries.get("formatter");
    if (formatter !== undefined && formatter.status !== "completed") counts.missing += 1;
  }

  const unexpectedCaseCount = checkpoint.cases.filter(
    (checkpointCase) => !checkpoint.expectedCaseIds.includes(checkpointCase.caseId)
  ).length;
  counts.missing += unexpectedCaseCount;
  const complete =
    counts.pending === 0 &&
    counts.active === 0 &&
    counts.orphanedUnknown === 0 &&
    counts.failed === 0 &&
    counts.missing === 0 &&
    duplicateReceiptCount === 0 &&
    invalidReceiptCount === 0;
  return Object.freeze({
    complete,
    counts: Object.freeze(counts),
    duplicateReceiptCount,
    invalidReceiptCount
  });
}

export function reusableStagesFromCheckpointCase(
  checkpointCase: StageCheckpointCase
): Readonly<Partial<Record<CheckpointStage, {
  readonly output: string;
  readonly receipt: ReviewFlowStageReceipt;
}>>> {
  const reusable: Partial<Record<CheckpointStage, {
    readonly output: string;
    readonly receipt: ReviewFlowStageReceipt;
  }>> = {};
  for (const stage of checkpointCase.stages) {
    if (
      stage.status === "completed" &&
      receiptIsValidForStage(stage.receipt, stage.stage, stage.output)
    ) {
      reusable[stage.stage] = Object.freeze({
        output: stage.output,
        receipt: stage.receipt
      });
    }
  }
  return Object.freeze(reusable);
}

export type CalibrationVerdict = "approve" | "request_changes" | "reject";

export interface DualAxisCalibrationCase {
  readonly predictedVerdict: CalibrationVerdict;
  readonly humanVerdict: CalibrationVerdict;
  readonly predictedCodeforcesDifficulty: number | null;
  readonly frozenCodeforcesDifficulty: number | null;
}

interface DifficultyStratumCoverage {
  readonly referenceCount: number;
  readonly predictionCount: number;
}

export interface DualAxisCalibrationSummary {
  readonly verdict: {
    readonly predictedClassCounts: Readonly<Record<CalibrationVerdict, number>>;
    readonly humanClassCounts: Readonly<Record<CalibrationVerdict, number>>;
    readonly confusion: Readonly<Record<CalibrationVerdict, Readonly<Record<CalibrationVerdict, number>>>>;
    readonly falseAcceptCount: number;
    readonly falseRejectCount: number;
  };
  readonly difficulty: {
    readonly scoredCaseCount: number;
    readonly mae: number | null;
    readonly strata: Readonly<Record<"800-1399" | "1400-1999" | "2000-2599" | "2600-3500", DifficultyStratumCoverage>>;
  };
}

export function buildDualAxisCalibrationSummary(
  cases: readonly DualAxisCalibrationCase[]
): DualAxisCalibrationSummary {
  const verdicts: readonly CalibrationVerdict[] = ["approve", "request_changes", "reject"];
  const predictedClassCounts: Record<CalibrationVerdict, number> = {
    approve: 0,
    request_changes: 0,
    reject: 0
  };
  const humanClassCounts: Record<CalibrationVerdict, number> = {
    approve: 0,
    request_changes: 0,
    reject: 0
  };
  const confusion: Record<CalibrationVerdict, Record<CalibrationVerdict, number>> = {
    approve: { approve: 0, request_changes: 0, reject: 0 },
    request_changes: { approve: 0, request_changes: 0, reject: 0 },
    reject: { approve: 0, request_changes: 0, reject: 0 }
  };
  const strata: Record<"800-1399" | "1400-1999" | "2000-2599" | "2600-3500", {
    referenceCount: number;
    predictionCount: number;
  }> = {
    "800-1399": { referenceCount: 0, predictionCount: 0 },
    "1400-1999": { referenceCount: 0, predictionCount: 0 },
    "2000-2599": { referenceCount: 0, predictionCount: 0 },
    "2600-3500": { referenceCount: 0, predictionCount: 0 }
  };
  let falseAcceptCount = 0;
  let falseRejectCount = 0;
  let absoluteError = 0;
  let scoredCaseCount = 0;

  for (const calibrationCase of cases) {
    if (!verdicts.includes(calibrationCase.predictedVerdict) || !verdicts.includes(calibrationCase.humanVerdict)) {
      throw new Error("REVIEW_FLOW_CALIBRATION_VERDICT_INVALID");
    }
    predictedClassCounts[calibrationCase.predictedVerdict] += 1;
    humanClassCounts[calibrationCase.humanVerdict] += 1;
    confusion[calibrationCase.humanVerdict][calibrationCase.predictedVerdict] += 1;
    if (calibrationCase.predictedVerdict === "approve" && calibrationCase.humanVerdict !== "approve") {
      falseAcceptCount += 1;
    }
    if (calibrationCase.predictedVerdict !== "approve" && calibrationCase.humanVerdict === "approve") {
      falseRejectCount += 1;
    }
    const predicted = calibrationCase.predictedCodeforcesDifficulty;
    const reference = calibrationCase.frozenCodeforcesDifficulty;
    if (predicted === null || reference === null) continue;
    assertCodeforcesDifficulty(predicted);
    assertCodeforcesDifficulty(reference);
    scoredCaseCount += 1;
    absoluteError += Math.abs(predicted - reference);
    strata[difficultyStratum(reference)].referenceCount += 1;
    strata[difficultyStratum(predicted)].predictionCount += 1;
  }

  return Object.freeze({
    verdict: Object.freeze({
      predictedClassCounts: Object.freeze(predictedClassCounts),
      humanClassCounts: Object.freeze(humanClassCounts),
      confusion: Object.freeze({
        approve: Object.freeze(confusion.approve),
        request_changes: Object.freeze(confusion.request_changes),
        reject: Object.freeze(confusion.reject)
      }),
      falseAcceptCount,
      falseRejectCount
    }),
    difficulty: Object.freeze({
      scoredCaseCount,
      mae: scoredCaseCount === 0 ? null : absoluteError / scoredCaseCount,
      strata: Object.freeze({
        "800-1399": Object.freeze(strata["800-1399"]),
        "1400-1999": Object.freeze(strata["1400-1999"]),
        "2000-2599": Object.freeze(strata["2000-2599"]),
        "2600-3500": Object.freeze(strata["2600-3500"])
      })
    })
  });
}

export function buildStageCalibrationReport(
  checkpoint: StageCheckpoint,
  cases: readonly DualAxisCalibrationCase[]
): {
  readonly status: "COMPLETE" | "INCOMPLETE";
  readonly completeness: StageCheckpointCompleteness;
  readonly metrics: DualAxisCalibrationSummary | null;
} {
  const completeness = evaluateStageCheckpointCompleteness(checkpoint);
  return Object.freeze({
    status: completeness.complete ? "COMPLETE" : "INCOMPLETE",
    completeness,
    metrics: completeness.complete ? buildDualAxisCalibrationSummary(cases) : null
  });
}

function receiptIsValidForStage(
  receipt: ReviewFlowStageReceipt,
  stage: CheckpointStage,
  output: string
): boolean {
  if (
    receipt.stage !== stage ||
    !/^[0-9a-f]{64}$/u.test(receipt.inputHash) ||
    !/^[0-9a-f]{64}$/u.test(receipt.promptHash) ||
    (receipt.schemaFingerprint !== null && !/^[0-9a-f]{64}$/u.test(receipt.schemaFingerprint)) ||
    !/^[0-9a-f]{64}$/u.test(receipt.modelFingerprint) ||
    !/^[0-9a-f]{64}$/u.test(receipt.outputHash) ||
    hashCanonicalValue(output) !== receipt.outputHash ||
    !/^[0-9a-f]{64}$/u.test(receipt.receiptHash) ||
    !Number.isInteger(receipt.attemptCount) ||
    receipt.attemptCount < 1 ||
    receipt.attemptCount > 3 ||
    receipt.eofVerified !== true
  ) {
    return false;
  }
  return receipt.receiptHash === hashCanonicalValue({
    stage: receipt.stage,
    inputHash: receipt.inputHash,
    promptHash: receipt.promptHash,
    schemaFingerprint: receipt.schemaFingerprint,
    modelFingerprint: receipt.modelFingerprint,
    attemptCount: receipt.attemptCount,
    eofVerified: receipt.eofVerified,
    outputHash: receipt.outputHash
  });
}

function difficultyStratum(value: number): keyof DualAxisCalibrationSummary["difficulty"]["strata"] {
  if (value < 1_400) return "800-1399";
  if (value < 2_000) return "1400-1999";
  if (value < 2_600) return "2000-2599";
  return "2600-3500";
}

function assertCodeforcesDifficulty(value: number): void {
  if (!Number.isInteger(value) || value < 800 || value > 3500 || value % 100 !== 0) {
    throw new Error("REVIEW_FLOW_CALIBRATION_DIFFICULTY_INVALID");
  }
}
