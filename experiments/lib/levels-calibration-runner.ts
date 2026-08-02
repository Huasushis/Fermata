import { createHash } from "node:crypto";
import { describeError } from "../../src/logger";
import {
  assertBlindContentDataset,
  buildBlindContentDataset,
  buildBlindGoldDataset,
  type BlindContentDataset,
  type BlindDatasetPurpose,
  type BlindGoldDataset,
  type BlindProblemContentSample
} from "./blind-evaluation";
import { mapWithConcurrency } from "./concurrency";
import {
  LevelsCalibrationStateError,
  calibrationActiveStageSchema,
  calibrationCodingResultSchema,
  calibrationFailureCodeSchema,
  calibrationFailureCountKey,
  calibrationFailureCountSchema,
  blindCalibrationProgressSchema,
  calibrationBlindGoldSchema,
  calibrationThinkingResultSchema,
  type CalibrationCheckpointState,
  type CalibrationActiveStage,
  type CalibrationBlindGold,
  type CalibrationCodingResult,
  type CalibrationDatasetItem,
  type CalibrationFailureCode,
  type CalibrationFailureCount,
  type CalibrationFailureStage,
  type BlindCalibrationProgress,
  type CalibrationThinkingResult
} from "./levels-calibration-state";

export interface CalibrationItemIdentity {
  readonly safeId: string;
}

export interface CalibrationStageCompletedEvent
  extends CalibrationItemIdentity {
  readonly stage: CalibrationFailureStage;
  readonly level: number;
  readonly fullyCompletedProblemCount: number;
  readonly expectedProblemCount: number;
}

export interface CalibrationStageFailedEvent extends CalibrationItemIdentity {
  readonly stage: CalibrationFailureStage;
  readonly errorCode: CalibrationFailureCode;
  readonly status: number | null;
  readonly fullyCompletedProblemCount: number;
  readonly expectedProblemCount: number;
}

export interface LevelsCalibrationRunnerInput {
  readonly blindContent: BlindContentDataset;
  readonly concurrency: number;
  readonly initialState?: CalibrationCheckpointState;
  readonly runThinking: (
    item: Readonly<BlindProblemContentSample>
  ) => Promise<unknown>;
  readonly runCoding: (
    item: Readonly<BlindProblemContentSample>
  ) => Promise<unknown>;
  readonly saveCheckpoint: (
    state: CalibrationCheckpointState
  ) => void | Promise<void>;
  readonly onStageCompleted?: (
    event: CalibrationStageCompletedEvent
  ) => void;
  readonly onStageFailed?: (event: CalibrationStageFailedEvent) => void;
}

export interface LevelsCalibrationRunnerResult
  extends CalibrationCheckpointState {
  readonly thinkingCompletedThisRun: number;
  readonly codingCompletedThisRun: number;
  readonly completedProblemsThisRun: number;
}

export function selectThinkingCalibrationResult(input: {
  readonly level: number;
  readonly signals: unknown;
}): CalibrationThinkingResult {
  return calibrationThinkingResultSchema.parse({
    level: input.level,
    signals: input.signals
  });
}

export function selectCodingCalibrationResult(input: {
  readonly level: number;
  readonly signals: unknown;
}): CalibrationCodingResult {
  return calibrationCodingResultSchema.parse({
    level: input.level,
    signals: input.signals
  });
}

/** 把标定源一次性投影成不含 rating、人工等级和预期结论的推理内容。 */
export function buildLevelsBlindContent(input: {
  readonly datasetId: string;
  readonly purpose: BlindDatasetPurpose;
  readonly items: readonly CalibrationDatasetItem[];
}): BlindContentDataset {
  return buildBlindContentDataset({
    datasetId: input.datasetId,
    purpose: input.purpose,
    samples: input.items.map((item) => {
      const contentHash = createHash("sha256")
        .update(item.statement, "utf8")
        .update("\0", "utf8")
        .update(item.editorial, "utf8")
        .digest("hex");
      const opaqueIdentity = createHash("sha256")
        .update("levels-blind-problem-v1", "utf8")
        .update("\0", "utf8")
        .update(item.safeId, "utf8")
        .update("\0", "utf8")
        .update(contentHash, "utf8")
        .digest("hex")
        .slice(0, 24);
      return {
        safeId: item.safeId,
        problem: {
          id: `calibration-${opaqueIdentity}`,
          revision: 1,
          reviewRound: 1,
          contentHash,
          title: `标定样本-${opaqueIdentity}`,
          type: "traditional",
          tagIds: ["calibration.sample"],
          basicStatement: item.statement,
          basicSolution: item.editorial
        }
      };
    })
  });
}

export function buildLevelsBlindGold(input: {
  readonly content: BlindContentDataset;
  readonly items: readonly CalibrationDatasetItem[];
}): BlindGoldDataset<CalibrationBlindGold> {
  let content: BlindContentDataset;
  try {
    content = assertBlindContentDataset(input.content);
    const independentlyProjected = buildLevelsBlindContent({
      datasetId: content.datasetId,
      purpose: content.purpose,
      items: input.items
    });
    if (independentlyProjected.contentFingerprint !== content.contentFingerprint) {
      throw new Error("content-changed");
    }
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_BLIND_GOLD_MISMATCH");
  }
  const contentBySafeId = new Map(
    content.samples.map((sample) => [sample.safeId, sample] as const)
  );
  return buildBlindGoldDataset({
    content,
    goldSchema: calibrationBlindGoldSchema,
    samples: input.items.map((item) => {
      const content = contentBySafeId.get(item.safeId);
      if (content === undefined) {
        throw new LevelsCalibrationStateError("LEVELS_BLIND_GOLD_MISMATCH");
      }
      return {
        safeId: item.safeId,
        contentHash: content.problem.contentHash,
        gold: {
          contestId: item.contestId,
          index: item.index,
          rating: item.rating,
          humanThinkingLevel: item.humanThinkingLevel,
          humanCodingLevel: item.humanCodingLevel
        }
      };
    })
  });
}

/**
 * 每道题各自依次运行两个阶段。阶段结果只在结构校验通过后写入共享
 * 进度表；所有检查点按调用顺序逐次写入，因此多个并发任务不会拿旧快照互相覆盖。
 */
export async function runLevelsCalibrationStages(
  input: LevelsCalibrationRunnerInput
): Promise<LevelsCalibrationRunnerResult> {
  let blindContent: BlindContentDataset;
  try {
    blindContent = assertBlindContentDataset(input.blindContent);
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_BLIND_CONTENT_MISMATCH");
  }
  const progressByKey = validateInitialProgress(
    blindContent,
    input.initialState?.progress ?? []
  );
  const failureCountsByKey = validateInitialFailureCounts(
    input.initialState?.failureCounts ?? []
  );
  const activeStagesByKey = validateInitialActiveStages(
    blindContent,
    input.initialState?.activeStages ?? []
  );
  for (const active of activeStagesByKey.values()) {
    mergeFailureCount(failureCountsByKey, {
      stage: active.stage,
      errorCode: "STALE_IN_FLIGHT",
      status: null,
      count: 1
    });
  }
  activeStagesByKey.clear();
  const initialCompletedKeys = new Set(
    [...progressByKey.values()]
      .filter((progress) =>
        progress.thinking !== undefined && progress.coding !== undefined
      )
      .map((progress) => progress.safeId)
  );
  let thinkingCompletedThisRun = 0;
  let codingCompletedThisRun = 0;
  let stopStartingStages = failureCountsByKey.size > 0;

  const snapshot = (): CalibrationCheckpointState => ({
    progress: [...progressByKey.values()].sort(compareProgress),
    failureCounts: [...failureCountsByKey.values()].sort(compareFailureCounts),
    activeStages: [...activeStagesByKey.values()].sort(compareActiveStages)
  });
  let checkpointWriteQueue = Promise.resolve();
  const saveCheckpoint = async (): Promise<void> => {
    const state = snapshot();
    const write = checkpointWriteQueue.then(async () => {
      await input.saveCheckpoint(state);
    });
    checkpointWriteQueue = write;
    try {
      await write;
    } catch (error) {
      stopStartingStages = true;
      throw error;
    }
  };
  const runPaidStage = async <T>(stageInput: {
    readonly safeId: string;
    readonly stage: CalibrationFailureStage;
    readonly execute: () => Promise<unknown>;
    readonly schema: {
      safeParse: (
        value: unknown
      ) =>
        | { readonly success: true; readonly data: T }
        | { readonly success: false };
    };
    readonly onFailure: (
      failure: CalibrationFailureCount
    ) => void | Promise<void>;
  }): Promise<
    | { readonly started: false }
    | { readonly started: true; readonly result: T | null }
  > => {
    if (stopStartingStages) {
      return { started: false };
    }
    activeStagesByKey.set(
      activeStageKey(stageInput.safeId, stageInput.stage),
      {
        safeId: stageInput.safeId,
        stage: stageInput.stage
      }
    );
    await saveCheckpoint();
    if (stopStartingStages) {
      activeStagesByKey.delete(
        activeStageKey(stageInput.safeId, stageInput.stage)
      );
      await saveCheckpoint();
      return { started: false };
    }

    // runStage 会在返回 Promise 前同步调用 execute。最后一次 stop 检查与实际发起
    // 请求之间没有 await/Promise 交接，另一 worker 无法在这条窄缝里关闸后仍新增请求。
    const running = runStage({
      stage: stageInput.stage,
      execute: stageInput.execute,
      schema: stageInput.schema,
      onFailure: stageInput.onFailure
    });
    return { started: true, result: await running };
  };
  const fullyCompletedProblemCount = (): number =>
    [...progressByKey.values()].filter(
      (progress) =>
        progress.thinking !== undefined && progress.coding !== undefined
    ).length;

  await mapWithConcurrency(blindContent.samples, input.concurrency, async (blindItem) => {
    try {
      if (stopStartingStages) {
        return;
      }
      const key = blindItem.safeId;
      let progress = progressByKey.get(key);
      if (progress?.thinking === undefined) {
        const thinkingStage = await runPaidStage({
          safeId: blindItem.safeId,
          stage: "thinking",
          execute: () => input.runThinking(blindItem),
          schema: calibrationThinkingResultSchema,
          onFailure: async (failure) => {
            stopStartingStages = true;
            mergeFailureCount(failureCountsByKey, failure);
            activeStagesByKey.delete(activeStageKey(blindItem.safeId, "thinking"));
            await saveCheckpoint();
            input.onStageFailed?.({
              safeId: blindItem.safeId,
              stage: failure.stage,
              errorCode: failure.errorCode,
              status: failure.status,
              fullyCompletedProblemCount: fullyCompletedProblemCount(),
              expectedProblemCount: blindContent.samples.length
            });
          }
        });
        if (!thinkingStage.started || thinkingStage.result === null) {
          return;
        }
        const thinking = thinkingStage.result;
        progress = {
          safeId: blindItem.safeId,
          contentHash: blindItem.problem.contentHash,
          thinking
        };
        progressByKey.set(key, progress);
        activeStagesByKey.delete(activeStageKey(blindItem.safeId, "thinking"));
        await saveCheckpoint();
        thinkingCompletedThisRun += 1;
        input.onStageCompleted?.({
          safeId: blindItem.safeId,
          stage: "thinking",
          level: thinking.level,
          fullyCompletedProblemCount: fullyCompletedProblemCount(),
          expectedProblemCount: blindContent.samples.length
        });
      }

      if (progress === undefined) {
        throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
      }
      if (progress.coding !== undefined) {
        return;
      }
      const codingStage = await runPaidStage({
        safeId: blindItem.safeId,
        stage: "coding",
        execute: () => input.runCoding(blindItem),
        schema: calibrationCodingResultSchema,
        onFailure: async (failure) => {
          stopStartingStages = true;
          mergeFailureCount(failureCountsByKey, failure);
          activeStagesByKey.delete(activeStageKey(blindItem.safeId, "coding"));
          await saveCheckpoint();
          input.onStageFailed?.({
            safeId: blindItem.safeId,
            stage: failure.stage,
            errorCode: failure.errorCode,
            status: failure.status,
            fullyCompletedProblemCount: fullyCompletedProblemCount(),
            expectedProblemCount: blindContent.samples.length
          });
        }
      });
      if (!codingStage.started || codingStage.result === null) {
        return;
      }
      const coding = codingStage.result;
      progress = {
        ...progress,
        coding
      };
      progressByKey.set(key, progress);
      activeStagesByKey.delete(activeStageKey(blindItem.safeId, "coding"));
      await saveCheckpoint();
      codingCompletedThisRun += 1;
      input.onStageCompleted?.({
        safeId: blindItem.safeId,
        stage: "coding",
        level: coding.level,
        fullyCompletedProblemCount: fullyCompletedProblemCount(),
        expectedProblemCount: blindContent.samples.length
      });
    } catch (error) {
      stopStartingStages = true;
      throw error;
    }
  });

  const finalState = snapshot();
  const completedProblemsThisRun = finalState.progress.filter(
    (progress) =>
      progress.thinking !== undefined &&
      progress.coding !== undefined &&
      !initialCompletedKeys.has(progress.safeId)
  ).length;
  return {
    ...finalState,
    thinkingCompletedThisRun,
    codingCompletedThisRun,
    completedProblemsThisRun
  };
}

async function runStage<T>(input: {
  readonly stage: CalibrationFailureStage;
  readonly execute: () => Promise<unknown>;
  readonly schema: {
    safeParse: (
      value: unknown
    ) =>
      | { readonly success: true; readonly data: T }
      | { readonly success: false };
  };
  readonly onFailure: (
    failure: CalibrationFailureCount
  ) => void | Promise<void>;
}): Promise<T | null> {
  let raw: unknown;
  try {
    raw = await input.execute();
  } catch (error) {
    if (error instanceof LevelsCalibrationStateError) {
      throw error;
    }
    await input.onFailure(classifyStageFailure(input.stage, error));
    return null;
  }
  const parsed = input.schema.safeParse(raw);
  if (!parsed.success) {
    await input.onFailure({
      stage: input.stage,
      errorCode: "VALIDATION_ERROR",
      status: null,
      count: 1
    });
    return null;
  }
  return parsed.data;
}

function classifyStageFailure(
  stage: CalibrationFailureStage,
  error: unknown
): CalibrationFailureCount {
  const described = describeError(error);
  const parsedCode = calibrationFailureCodeSchema.safeParse(described);
  const errorCode = parsedCode.success
    ? parsedCode.data
    : "UNEXPECTED_ERROR";
  const possibleStatus =
    errorCode === "LLM_HTTP_ERROR" &&
    typeof error === "object" &&
    error !== null &&
    "status" in error
      ? (error as { readonly status?: unknown }).status
      : undefined;
  const status =
    typeof possibleStatus === "number" &&
    Number.isInteger(possibleStatus) &&
    possibleStatus >= 100 &&
    possibleStatus <= 599 &&
    (possibleStatus < 200 || possibleStatus > 299)
      ? possibleStatus
      : null;
  return {
    stage,
    errorCode,
    status,
    count: 1
  };
}

function mergeFailureCount(
  failureCountsByKey: Map<string, CalibrationFailureCount>,
  failure: CalibrationFailureCount
): void {
  const parsed = calibrationFailureCountSchema.safeParse(failure);
  if (!parsed.success) {
    throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
  }
  const key = calibrationFailureCountKey(parsed.data);
  const existing = failureCountsByKey.get(key);
  const nextCount = (existing?.count ?? 0) + parsed.data.count;
  const merged = calibrationFailureCountSchema.safeParse({
    ...parsed.data,
    count: nextCount
  });
  if (!merged.success) {
    throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
  }
  failureCountsByKey.set(key, merged.data);
}

function validateInitialProgress(
  content: BlindContentDataset,
  initialProgress: readonly BlindCalibrationProgress[]
): Map<string, BlindCalibrationProgress> {
  const expectedContentHashes = new Map(
    content.samples.map(
      (sample) => [sample.safeId, sample.problem.contentHash] as const
    )
  );
  if (expectedContentHashes.size !== content.samples.length) {
    throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
  }
  const progressByKey = new Map<string, BlindCalibrationProgress>();
  for (const candidate of initialProgress) {
    const parsed = blindCalibrationProgressSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
    }
    const key = parsed.data.safeId;
    const expectedContentHash = expectedContentHashes.get(key);
    if (
      progressByKey.has(key) ||
      expectedContentHash === undefined ||
      expectedContentHash !== parsed.data.contentHash
    ) {
      throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
    }
    progressByKey.set(key, parsed.data);
  }
  return progressByKey;
}

function validateInitialActiveStages(
  content: BlindContentDataset,
  initialActiveStages: readonly CalibrationActiveStage[]
): Map<string, CalibrationActiveStage> {
  const expectedSafeIds = new Set(content.samples.map((item) => item.safeId));
  if (expectedSafeIds.size !== content.samples.length) {
    throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
  }
  const activeStagesByKey = new Map<string, CalibrationActiveStage>();
  for (const candidate of initialActiveStages) {
    const parsed = calibrationActiveStageSchema.safeParse(candidate);
    if (!parsed.success || !expectedSafeIds.has(parsed.data.safeId)) {
      throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
    }
    const key = activeStageKey(parsed.data.safeId, parsed.data.stage);
    if (activeStagesByKey.has(key)) {
      throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
    }
    activeStagesByKey.set(key, parsed.data);
  }
  return activeStagesByKey;
}

function validateInitialFailureCounts(
  initialFailureCounts: readonly CalibrationFailureCount[]
): Map<string, CalibrationFailureCount> {
  const failureCountsByKey = new Map<string, CalibrationFailureCount>();
  for (const candidate of initialFailureCounts) {
    const parsed = calibrationFailureCountSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
    }
    const key = calibrationFailureCountKey(parsed.data);
    if (failureCountsByKey.has(key)) {
      throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
    }
    failureCountsByKey.set(key, parsed.data);
  }
  return failureCountsByKey;
}

function activeStageKey(
  safeId: string,
  stage: CalibrationFailureStage
): string {
  return `${safeId}:${stage}`;
}

function compareActiveStages(
  left: CalibrationActiveStage,
  right: CalibrationActiveStage
): number {
  return activeStageKey(left.safeId, left.stage).localeCompare(
    activeStageKey(right.safeId, right.stage)
  );
}

function compareProgress(
  left: BlindCalibrationProgress,
  right: BlindCalibrationProgress
): number {
  return left.safeId.localeCompare(right.safeId);
}

function compareFailureCounts(
  left: CalibrationFailureCount,
  right: CalibrationFailureCount
): number {
  return calibrationFailureCountKey(left).localeCompare(
    calibrationFailureCountKey(right)
  );
}
