import { describeError } from "../../src/logger";
import { mapWithConcurrency } from "./concurrency";
import {
  LevelsCalibrationStateError,
  calibrationCodingResultSchema,
  calibrationFailureCodeSchema,
  calibrationFailureCountKey,
  calibrationFailureCountSchema,
  calibrationProgressSchema,
  calibrationRowKey,
  calibrationThinkingResultSchema,
  completeCalibrationRows,
  type CalibrationCheckpointState,
  type CalibrationCodingResult,
  type CalibrationDatasetItem,
  type CalibrationFailureCode,
  type CalibrationFailureCount,
  type CalibrationFailureStage,
  type CalibrationProgress,
  type CalibrationRow,
  type CalibrationThinkingResult
} from "./levels-calibration-state";

export interface CalibrationItemIdentity {
  readonly contestId: number;
  readonly index: string;
  readonly rating: number;
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
  readonly items: readonly CalibrationDatasetItem[];
  readonly concurrency: number;
  readonly initialState?: CalibrationCheckpointState;
  readonly runThinking: (
    item: CalibrationDatasetItem
  ) => Promise<unknown>;
  readonly runCoding: (
    item: CalibrationDatasetItem
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
  readonly rows: readonly CalibrationRow[];
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

/**
 * 每道题各自依次运行两个阶段。阶段结果只在结构校验通过后写入共享
 * 进度表；所有检查点按调用顺序逐次写入，因此多个并发任务不会拿旧快照互相覆盖。
 */
export async function runLevelsCalibrationStages(
  input: LevelsCalibrationRunnerInput
): Promise<LevelsCalibrationRunnerResult> {
  const progressByKey = validateInitialProgress(
    input.items,
    input.initialState?.progress ?? []
  );
  const failureCountsByKey = validateInitialFailureCounts(
    input.initialState?.failureCounts ?? []
  );
  const initialCompletedKeys = new Set(
    completeCalibrationRows([...progressByKey.values()]).map(calibrationRowKey)
  );
  let thinkingCompletedThisRun = 0;
  let codingCompletedThisRun = 0;

  const snapshot = (): CalibrationCheckpointState => ({
    progress: [...progressByKey.values()].sort(compareProgress),
    failureCounts: [...failureCountsByKey.values()].sort(compareFailureCounts)
  });
  let checkpointWriteQueue = Promise.resolve();
  const saveCheckpoint = async (): Promise<void> => {
    const state = snapshot();
    const write = checkpointWriteQueue.then(async () => {
      await input.saveCheckpoint(state);
    });
    checkpointWriteQueue = write;
    await write;
  };
  const fullyCompletedProblemCount = (): number =>
    [...progressByKey.values()].filter(
      (progress) =>
        progress.thinking !== undefined && progress.coding !== undefined
    ).length;

  await mapWithConcurrency(input.items, input.concurrency, async (item) => {
    const key = calibrationRowKey(item);
    let progress = progressByKey.get(key);
    if (progress?.thinking === undefined) {
      const thinking = await runStage({
        stage: "thinking",
        execute: () => input.runThinking(item),
        schema: calibrationThinkingResultSchema,
        onFailure: async (failure) => {
          mergeFailureCount(failureCountsByKey, failure);
          await saveCheckpoint();
          input.onStageFailed?.({
            ...identityOf(item),
            stage: failure.stage,
            errorCode: failure.errorCode,
            status: failure.status,
            fullyCompletedProblemCount: fullyCompletedProblemCount(),
            expectedProblemCount: input.items.length
          });
        }
      });
      if (thinking === null) {
        return;
      }
      progress = {
        contestId: item.contestId,
        index: item.index,
        rating: item.rating,
        thinking
      };
      progressByKey.set(key, progress);
      await saveCheckpoint();
      thinkingCompletedThisRun += 1;
      input.onStageCompleted?.({
        ...identityOf(item),
        stage: "thinking",
        level: thinking.level,
        fullyCompletedProblemCount: fullyCompletedProblemCount(),
        expectedProblemCount: input.items.length
      });
    }

    if (progress === undefined) {
      throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
    }
    if (progress.coding !== undefined) {
      return;
    }
    const coding = await runStage({
      stage: "coding",
      execute: () => input.runCoding(item),
      schema: calibrationCodingResultSchema,
      onFailure: async (failure) => {
        mergeFailureCount(failureCountsByKey, failure);
        await saveCheckpoint();
        input.onStageFailed?.({
          ...identityOf(item),
          stage: failure.stage,
          errorCode: failure.errorCode,
          status: failure.status,
          fullyCompletedProblemCount: fullyCompletedProblemCount(),
          expectedProblemCount: input.items.length
        });
      }
    });
    if (coding === null) {
      return;
    }
    progress = {
      ...progress,
      coding
    };
    progressByKey.set(key, progress);
    await saveCheckpoint();
    codingCompletedThisRun += 1;
    input.onStageCompleted?.({
      ...identityOf(item),
      stage: "coding",
      level: coding.level,
      fullyCompletedProblemCount: fullyCompletedProblemCount(),
      expectedProblemCount: input.items.length
    });
  });

  const finalState = snapshot();
  const rows = completeCalibrationRows(finalState.progress).sort(compareRows);
  const completedProblemsThisRun = rows.filter(
    (row) => !initialCompletedKeys.has(calibrationRowKey(row))
  ).length;
  return {
    ...finalState,
    rows,
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
  items: readonly CalibrationDatasetItem[],
  initialProgress: readonly CalibrationProgress[]
): Map<string, CalibrationProgress> {
  const expectedRatings = new Map(
    items.map((item) => [calibrationRowKey(item), item.rating] as const)
  );
  if (expectedRatings.size !== items.length) {
    throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
  }
  const progressByKey = new Map<string, CalibrationProgress>();
  for (const candidate of initialProgress) {
    const parsed = calibrationProgressSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
    }
    const key = calibrationRowKey(parsed.data);
    if (
      progressByKey.has(key) ||
      expectedRatings.get(key) !== parsed.data.rating
    ) {
      throw new LevelsCalibrationStateError("LEVELS_CHECKPOINT_INVALID");
    }
    progressByKey.set(key, parsed.data);
  }
  return progressByKey;
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

function identityOf(item: CalibrationDatasetItem): CalibrationItemIdentity {
  return {
    contestId: item.contestId,
    index: item.index,
    rating: item.rating
  };
}

function compareProgress(
  left: CalibrationProgress,
  right: CalibrationProgress
): number {
  return (
    left.rating - right.rating ||
    left.contestId - right.contestId ||
    left.index.localeCompare(right.index)
  );
}

function compareRows(left: CalibrationRow, right: CalibrationRow): number {
  return (
    left.rating - right.rating ||
    left.contestId - right.contestId ||
    left.index.localeCompare(right.index)
  );
}

function compareFailureCounts(
  left: CalibrationFailureCount,
  right: CalibrationFailureCount
): number {
  return calibrationFailureCountKey(left).localeCompare(
    calibrationFailureCountKey(right)
  );
}
