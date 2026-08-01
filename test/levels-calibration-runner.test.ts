import { describe, expect, it, vi } from "vitest";
import {
  runLevelsCalibrationStages,
  selectCodingCalibrationResult,
  selectThinkingCalibrationResult
} from "../experiments/lib/levels-calibration-runner";
import {
  LevelsCalibrationStateError,
  type CalibrationCheckpointState,
  type CalibrationCodingResult,
  type CalibrationDatasetItem,
  type CalibrationFailureCode,
  type CalibrationProgress,
  type CalibrationThinkingResult
} from "../experiments/lib/levels-calibration-state";

function item(
  contestId: number,
  index = "A",
  rating = 1200
): CalibrationDatasetItem {
  return {
    safeId: `sample-${contestId}-${index}`,
    contestId,
    index,
    rating,
    humanThinkingLevel: 2,
    humanCodingLevel: 2,
    statement: `题面-${contestId}`,
    editorial: `题解-${contestId}`
  };
}

function thinkingResult(level = 2): CalibrationThinkingResult {
  const signals =
    level === 2
      ? {
          solved: true,
          approachSimilarity: 0.8,
          selfCorrections: 0,
          keyInsightCount: 1
        }
      : level === 3
        ? {
            solved: true,
            approachSimilarity: 0.5,
            selfCorrections: 0,
            keyInsightCount: 1
          }
        : level === 5
          ? {
              solved: false,
              approachSimilarity: 0,
              selfCorrections: 0,
              keyInsightCount: 1
            }
          : (() => {
              throw new Error("测试没有为这个思维等级准备信号");
            })();
  return {
    level,
    signals
  };
}

function codingResult(level = 2): CalibrationCodingResult {
  const signals =
    level === 2
      ? {
          effectiveLineCount: 30,
          maxNestingDepth: 2,
          detectedDataStructures: [],
          maxDataStructureWeight: 0
        }
      : level === 4
        ? {
            effectiveLineCount: 90,
            maxNestingDepth: 3,
            detectedDataStructures: [],
            maxDataStructureWeight: 0
          }
        : (() => {
            throw new Error("测试没有为这个代码等级准备信号");
          })();
  return {
    level,
    signals
  };
}

function completeProgress(source: CalibrationDatasetItem): CalibrationProgress {
  return {
    safeId: source.safeId,
    contestId: source.contestId,
    index: source.index,
    rating: source.rating,
    humanThinkingLevel: source.humanThinkingLevel,
    humanCodingLevel: source.humanCodingLevel,
    thinking: thinkingResult(),
    coding: codingResult()
  };
}

function copyState(state: CalibrationCheckpointState): CalibrationCheckpointState {
  return JSON.parse(JSON.stringify(state)) as CalibrationCheckpointState;
}

describe("思维和代码标定的分阶段执行", () => {
  it("只选取等级和严格信号，不保存流水线返回中的说明文字", () => {
    const secret = "SENSITIVE_MODEL_RESPONSE_SENTINEL";
    const fullThinkingResult = {
      ...thinkingResult(),
      rationale: secret,
      solverNarrativeLength: 999
    };
    const fullCodingResult = {
      ...codingResult(),
      referenceCodeLength: 999,
      rawCode: secret
    };
    const thinking = selectThinkingCalibrationResult(fullThinkingResult);
    const coding = selectCodingCalibrationResult(fullCodingResult);
    const serialized = JSON.stringify({ thinking, coding });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("rationale");
    expect(serialized).not.toContain("referenceCodeLength");
  });

  it("思维阶段保存完成后才运行代码阶段", async () => {
    const source = item(1);
    const events: string[] = [];
    const result = await runLevelsCalibrationStages({
      items: [source],
      concurrency: 1,
      runThinking: async () => {
        events.push("thinking");
        return thinkingResult();
      },
      runCoding: async () => {
        events.push("coding");
        return codingResult();
      },
      saveCheckpoint: (state) => {
        const activeStage = state.activeStages?.[0]?.stage;
        events.push(
          activeStage === "thinking"
            ? "save-active-thinking"
            : activeStage === "coding"
              ? "save-active-coding"
              : state.progress[0]?.coding === undefined
                ? "save-thinking"
                : "save-coding"
        );
      }
    });
    expect(events).toEqual([
      "save-active-thinking",
      "thinking",
      "save-thinking",
      "save-active-coding",
      "coding",
      "save-coding"
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.completedProblemsThisRun).toBe(1);
    expect(JSON.stringify(result)).not.toContain(source.statement);
    expect(JSON.stringify(result)).not.toContain(source.editorial);
  });

  it("思维失败时不运行代码，只保存固定失败信息", async () => {
    const secret = "SECRET_RESPONSE_BODY";
    const coding = vi.fn(async () => codingResult());
    const snapshots: CalibrationCheckpointState[] = [];
    const failedEvents: unknown[] = [];
    const error = Object.assign(new Error(secret), {
      code: "LLM_HTTP_ERROR",
      status: 499,
      responseBody: secret,
      address: `https://${secret}.example`
    });
    const result = await runLevelsCalibrationStages({
      items: [item(1)],
      concurrency: 1,
      runThinking: async () => {
        throw error;
      },
      runCoding: coding,
      saveCheckpoint: (state) => {
        snapshots.push(copyState(state));
      },
      onStageFailed: (event) => failedEvents.push(event)
    });

    expect(coding).not.toHaveBeenCalled();
    expect(result.progress).toEqual([]);
    expect(result.failureCounts).toEqual([
      {
        stage: "thinking",
        errorCode: "LLM_HTTP_ERROR",
        status: 499,
        count: 1
      }
    ]);
    expect(snapshots[0]?.activeStages).toEqual([
      { safeId: "sample-1-A", stage: "thinking" }
    ]);
    expect(snapshots.at(-1)?.activeStages).toEqual([]);
    expect(JSON.stringify({ snapshots, failedEvents })).not.toContain(secret);
  });

  it.each(
    [
      "LLM_NETWORK_FAILED",
      "LLM_FIRST_OUTPUT_TIMEOUT",
      "LLM_OUTPUT_IDLE_TIMEOUT",
      "LLM_TOTAL_TIMEOUT",
      "LLM_STREAM_INTERRUPTED",
      "LLM_CANCELLED"
    ] satisfies readonly CalibrationFailureCode[]
  )("保留当前模型错误码 %s，且不保存外部错误正文", async (errorCode) => {
    const secret = "MODEL_PROVIDER_ERROR_BODY_MUST_NOT_PERSIST";
    const result = await runLevelsCalibrationStages({
      items: [item(1)],
      concurrency: 1,
      runThinking: async () => {
        throw Object.assign(new Error(secret), {
          code: errorCode,
          responseBody: secret
        });
      },
      runCoding: async () => codingResult(),
      saveCheckpoint: () => undefined
    });
    expect(result.failureCounts).toEqual([
      {
        stage: "thinking",
        errorCode,
        status: null,
        count: 1
      }
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("付费阶段若被内部状态错误中断，最后检查点保留 active 供下次续跑判为陈旧在途", async () => {
    const snapshots: CalibrationCheckpointState[] = [];
    await expect(
      runLevelsCalibrationStages({
        items: [item(1)],
        concurrency: 1,
        runThinking: async () => {
          throw new LevelsCalibrationStateError("LEVELS_ATOMIC_WRITE_FAILED");
        },
        runCoding: async () => codingResult(),
        saveCheckpoint: (state) => {
          snapshots.push(copyState(state));
        }
      })
    ).rejects.toMatchObject({ code: "LEVELS_ATOMIC_WRITE_FAILED" });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      progress: [],
      failureCounts: [],
      activeStages: [{ safeId: "sample-1-A", stage: "thinking" }]
    });
  });

  it("当前运行不会继续产生旧的笼统模型错误码", async () => {
    const result = await runLevelsCalibrationStages({
      items: [item(1)],
      concurrency: 1,
      runThinking: async () => {
        throw Object.assign(new Error("不能保存的异常说明"), {
          code: "LLM_REQUEST_FAILED"
        });
      },
      runCoding: async () => codingResult(),
      saveCheckpoint: () => undefined
    });
    expect(result.failureCounts).toEqual([
      {
        stage: "thinking",
        errorCode: "UNEXPECTED_ERROR",
        status: null,
        count: 1
      }
    ]);
  });

  it("代码失败后保留思维结果，但受污染实验链续跑不再产生付费请求", async () => {
    const source = item(1);
    const firstThinking = vi.fn(async () => thinkingResult(3));
    const first = await runLevelsCalibrationStages({
      items: [source],
      concurrency: 1,
      runThinking: firstThinking,
      runCoding: async () => {
        throw Object.assign(new Error("不能保存的异常说明"), {
          code: "LLM_OUTPUT_IDLE_TIMEOUT",
          status: 503
        });
      },
      saveCheckpoint: () => undefined
    });
    expect(firstThinking).toHaveBeenCalledOnce();
    expect(first.progress[0]?.thinking?.level).toBe(3);
    expect(first.progress[0]?.coding).toBeUndefined();
    expect(first.failureCounts).toEqual([
      {
        stage: "coding",
        errorCode: "LLM_OUTPUT_IDLE_TIMEOUT",
        status: null,
        count: 1
      }
    ]);

    const contaminatedThinking = vi.fn(async () => thinkingResult(5));
    const contaminatedCoding = vi.fn(async () => codingResult(4));
    const contaminated = await runLevelsCalibrationStages({
      items: [source],
      concurrency: 1,
      initialState: first,
      runThinking: contaminatedThinking,
      runCoding: contaminatedCoding,
      saveCheckpoint: () => undefined
    });
    expect(contaminatedThinking).not.toHaveBeenCalled();
    expect(contaminatedCoding).not.toHaveBeenCalled();
    expect(contaminated.rows).toEqual([]);
    expect(contaminated.failureCounts).toEqual(first.failureCounts);

    const resumedThinking = vi.fn(async () => thinkingResult(5));
    const resumedCoding = vi.fn(async () => codingResult(4));
    const resumed = await runLevelsCalibrationStages({
      items: [source],
      concurrency: 1,
      initialState: {
        progress: first.progress,
        failureCounts: [],
        activeStages: []
      },
      runThinking: resumedThinking,
      runCoding: resumedCoding,
      saveCheckpoint: () => undefined
    });
    expect(resumedThinking).not.toHaveBeenCalled();
    expect(resumedCoding).toHaveBeenCalledOnce();
    expect(resumed.rows[0]).toMatchObject({
      thinkingLevel: 3,
      codingLevel: 4
    });
    expect(resumed.failureCounts).toEqual([]);
  });

  it("已经完整的题目不会再次运行任何阶段", async () => {
    const source = item(1);
    const runThinking = vi.fn(async () => thinkingResult());
    const runCoding = vi.fn(async () => codingResult());
    const saveCheckpoint = vi.fn();
    const result = await runLevelsCalibrationStages({
      items: [source],
      concurrency: 1,
      initialState: {
        progress: [completeProgress(source)],
        failureCounts: [],
        activeStages: []
      },
      runThinking,
      runCoding,
      saveCheckpoint
    });
    expect(runThinking).not.toHaveBeenCalled();
    expect(runCoding).not.toHaveBeenCalled();
    expect(saveCheckpoint).not.toHaveBeenCalled();
    expect(result.completedProblemsThisRun).toBe(0);
    expect(result.rows).toHaveLength(1);
  });

  it("运行器自身拒绝重复题目标识", async () => {
    const source = item(1);
    const runThinking = vi.fn(async () => thinkingResult());
    await expect(
      runLevelsCalibrationStages({
        items: [source, { ...source }],
        concurrency: 2,
        runThinking,
        runCoding: async () => codingResult(),
        saveCheckpoint: () => undefined
      })
    ).rejects.toMatchObject({ code: "LEVELS_CHECKPOINT_INVALID" });
    expect(runThinking).not.toHaveBeenCalled();
  });

  it("模型错误携带成功状态码时不会把该状态码写入检查点", async () => {
    const result = await runLevelsCalibrationStages({
      items: [item(1)],
      concurrency: 1,
      runThinking: async () => {
        throw Object.assign(new Error("不能保存的异常说明"), {
          code: "LLM_HTTP_ERROR",
          status: 200
        });
      },
      runCoding: async () => codingResult(),
      saveCheckpoint: () => undefined
    });
    expect(result.failureCounts).toEqual([
      {
        stage: "thinking",
        errorCode: "LLM_HTTP_ERROR",
        status: null,
        count: 1
      }
    ]);
  });

  it("阶段返回结构不正确时按固定校验错误记录，不让未知字段进入检查点", async () => {
    const secret = "MODEL_RATIONALE_MUST_NOT_PERSIST";
    const coding = vi.fn(async () => codingResult());
    const result = await runLevelsCalibrationStages({
      items: [item(1)],
      concurrency: 1,
      runThinking: async () => ({
        ...thinkingResult(),
        unknownModelText: secret
      }),
      runCoding: coding,
      saveCheckpoint: () => undefined
    });
    expect(coding).not.toHaveBeenCalled();
    expect(result.failureCounts).toEqual([
      {
        stage: "thinking",
        errorCode: "VALIDATION_ERROR",
        status: null,
        count: 1
      }
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("并发题目乱序完成时检查点只增加不丢失，相同失败也会准确累加", async () => {
    const items = [item(1), item(2, "B", 1800), item(3, "C", 2400)];
    let arrived = 0;
    let releaseThinking = (): void => undefined;
    const thinkingBarrier = new Promise<void>((resolve) => {
      releaseThinking = () => resolve();
    });
    const snapshots: CalibrationCheckpointState[] = [];
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    let codingArrived = 0;
    let releaseCoding = (): void => undefined;
    const codingBarrier = new Promise<void>((resolve) => {
      releaseCoding = () => resolve();
    });
    const result = await runLevelsCalibrationStages({
      items,
      concurrency: 3,
      runThinking: async () => {
        arrived += 1;
        if (arrived === items.length) {
          releaseThinking();
        }
        await thinkingBarrier;
        return thinkingResult();
      },
      runCoding: async () => {
        codingArrived += 1;
        if (codingArrived === items.length) {
          releaseCoding();
        }
        await codingBarrier;
        throw Object.assign(new Error("服务商原文"), {
          code: "LLM_HTTP_ERROR",
          status: 503
        });
      },
      saveCheckpoint: async (state) => {
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        await Promise.resolve();
        snapshots.push(copyState(state));
        activeWrites -= 1;
      }
    });

    for (let index = 1; index < snapshots.length; index += 1) {
      const previousKeys = new Set(
        snapshots[index - 1]!.progress.map(
          (entry) => `${entry.contestId}:${entry.index}`
        )
      );
      const currentKeys = new Set(
        snapshots[index]!.progress.map(
          (entry) => `${entry.contestId}:${entry.index}`
        )
      );
      expect([...previousKeys].every((key) => currentKeys.has(key))).toBe(true);
    }
    expect(result.progress).toHaveLength(3);
    expect(result.rows).toHaveLength(0);
    expect(maximumActiveWrites).toBe(1);
    expect(result.failureCounts).toEqual([
      {
        stage: "coding",
        errorCode: "LLM_HTTP_ERROR",
        status: 503,
        count: 3
      }
    ]);
  });

  it("首个普通失败后不启动排队题目或下一付费阶段，只等待在途请求落盘", async () => {
    const sources = [
      item(1),
      item(2, "B", 1800),
      item(3, "C", 2400)
    ];
    let notifySecondStarted = (): void => undefined;
    const secondStarted = new Promise<void>((resolve) => {
      notifySecondStarted = () => resolve();
    });
    let releaseSecond = (): void => undefined;
    const secondCanFinish = new Promise<void>((resolve) => {
      releaseSecond = () => resolve();
    });
    const runThinking = vi.fn(async (source: CalibrationDatasetItem) => {
      if (source.safeId === sources[0]!.safeId) {
        await secondStarted;
        throw Object.assign(new Error("不能保存的取消说明"), {
          code: "LLM_CANCELLED"
        });
      }
      notifySecondStarted();
      await secondCanFinish;
      return thinkingResult();
    });
    const runCoding = vi.fn(async () => codingResult());
    let settled = false;
    const observed = runLevelsCalibrationStages({
      items: sources,
      concurrency: 2,
      runThinking,
      runCoding,
      saveCheckpoint: async () => {
        await Promise.resolve();
      }
    }).then((value) => {
      settled = true;
      return value;
    });

    await secondStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseSecond();
    const result = await observed;

    expect(runThinking).toHaveBeenCalledTimes(2);
    expect(runThinking).not.toHaveBeenCalledWith(sources[2]);
    expect(runCoding).not.toHaveBeenCalled();
    expect(result.progress).toEqual([
      expect.objectContaining({
        safeId: sources[1]!.safeId,
        thinking: thinkingResult()
      })
    ]);
    expect(result.progress[0]?.coding).toBeUndefined();
    expect(result.failureCounts).toEqual([
      {
        stage: "thinking",
        errorCode: "LLM_CANCELLED",
        status: null,
        count: 1
      }
    ]);
  });

  it("最后一次停发检查与同步启动请求之间没有可被另一 worker 插入的微任务间隙", async () => {
    const sources = [item(1), item(2, "B", 1800)];
    let notifySecondStarted = (): void => undefined;
    const secondStarted = new Promise<void>((resolve) => {
      notifySecondStarted = () => resolve();
    });
    let rejectSecond = (_error: Error): void => undefined;
    const secondResult = new Promise<never>((_resolve, reject) => {
      rejectSecond = (error) => reject(error);
    });
    let failureClassified = false;
    const failure = new Error("不能保存的取消说明");
    Object.defineProperty(failure, "code", {
      configurable: false,
      enumerable: true,
      get: () => {
        failureClassified = true;
        return "LLM_CANCELLED";
      }
    });
    let rejectionScheduled = false;
    let failureWasClassifiedWhenCodingStarted: boolean | undefined;
    const runCoding = vi.fn(async () => {
      failureWasClassifiedWhenCodingStarted = failureClassified;
      return codingResult();
    });

    const result = await runLevelsCalibrationStages({
      items: sources,
      concurrency: 2,
      runThinking: async (source) => {
        if (source.safeId === sources[0]!.safeId) {
          await secondStarted;
          return thinkingResult();
        }
        notifySecondStarted();
        return secondResult;
      },
      runCoding,
      saveCheckpoint: (state) => {
        if (
          !rejectionScheduled &&
          state.activeStages.some(
            (active) =>
              active.safeId === sources[0]!.safeId &&
              active.stage === "coding"
          )
        ) {
          rejectionScheduled = true;
          queueMicrotask(() => {
            queueMicrotask(() => {
              queueMicrotask(() => rejectSecond(failure));
            });
          });
        }
      }
    });

    expect(rejectionScheduled).toBe(true);
    expect(runCoding).toHaveBeenCalledOnce();
    expect(failureWasClassifiedWhenCodingStarted).toBe(false);
    expect(failureClassified).toBe(true);
    expect(result.failureCounts).toEqual([
      {
        stage: "thinking",
        errorCode: "LLM_CANCELLED",
        status: null,
        count: 1
      }
    ]);
  });

  it("思维阶段的检查点保存失败时不继续运行代码", async () => {
    const runCoding = vi.fn(async () => codingResult());
    await expect(
      runLevelsCalibrationStages({
        items: [item(1)],
        concurrency: 1,
        runThinking: async () => thinkingResult(),
        runCoding,
        saveCheckpoint: () => {
          throw new LevelsCalibrationStateError(
            "LEVELS_ATOMIC_WRITE_FAILED"
          );
        }
      })
    ).rejects.toMatchObject({ code: "LEVELS_ATOMIC_WRITE_FAILED" });
    expect(runCoding).not.toHaveBeenCalled();
  });

  it("异步保存失败时也不继续运行代码", async () => {
    const runCoding = vi.fn(async () => codingResult());
    await expect(
      runLevelsCalibrationStages({
        items: [item(1)],
        concurrency: 1,
        runThinking: async () => thinkingResult(),
        runCoding,
        saveCheckpoint: async () => {
          throw new LevelsCalibrationStateError(
            "LEVELS_ATOMIC_WRITE_FAILED"
          );
        }
      })
    ).rejects.toMatchObject({ code: "LEVELS_ATOMIC_WRITE_FAILED" });
    expect(runCoding).not.toHaveBeenCalled();
  });

  it("并发排队时首个保存失败会阻止后续保存和代码阶段", async () => {
    const sources = [item(1), item(2, "B", 1800)];
    let arrived = 0;
    let releaseThinking = (): void => undefined;
    const thinkingBarrier = new Promise<void>((resolve) => {
      releaseThinking = () => resolve();
    });
    const runCoding = vi.fn(async () => codingResult());
    const saveCheckpoint = vi.fn(async () => {
      await Promise.resolve();
      throw new LevelsCalibrationStateError(
        "LEVELS_ATOMIC_WRITE_FAILED"
      );
    });
    await expect(
      runLevelsCalibrationStages({
        items: sources,
        concurrency: 2,
        runThinking: async () => {
          arrived += 1;
          if (arrived === sources.length) {
            releaseThinking();
          }
          await thinkingBarrier;
          return thinkingResult();
        },
        runCoding,
        saveCheckpoint
      })
    ).rejects.toMatchObject({ code: "LEVELS_ATOMIC_WRITE_FAILED" });
    expect(arrived).toBe(0);
    expect(saveCheckpoint).toHaveBeenCalledOnce();
    expect(runCoding).not.toHaveBeenCalled();
  });

  it("一个并发 worker 致命失败后会等待其他在途 worker 和检查点写入真正结束", async () => {
    const sources = [
      item(1),
      item(2, "B", 1800),
      item(3, "C", 2400)
    ];
    const snapshots: CalibrationCheckpointState[] = [];
    let notifySecondStarted = (): void => undefined;
    const secondStarted = new Promise<void>((resolve) => {
      notifySecondStarted = () => resolve();
    });
    let notifyFatalThrown = (): void => undefined;
    const fatalThrown = new Promise<void>((resolve) => {
      notifyFatalThrown = () => resolve();
    });
    let releaseSecond = (): void => undefined;
    const secondCanFinish = new Promise<void>((resolve) => {
      releaseSecond = () => resolve();
    });
    const runCoding = vi.fn(async () => codingResult());
    const runThinking = vi.fn(async (source: CalibrationDatasetItem) => {
      if (source.safeId === sources[0]!.safeId) {
        await secondStarted;
        notifyFatalThrown();
        throw new LevelsCalibrationStateError(
          "LEVELS_ATOMIC_WRITE_FAILED"
        );
      }
      notifySecondStarted();
      await secondCanFinish;
      return thinkingResult();
    });
    let settled = false;

    const observed = runLevelsCalibrationStages({
      items: sources,
      concurrency: 2,
      runThinking,
      runCoding,
      saveCheckpoint: async (state) => {
        await Promise.resolve();
        snapshots.push(copyState(state));
      }
    }).then(
      (value) => ({ succeeded: true as const, value }),
      (error: unknown) => ({ succeeded: false as const, error })
    );
    void observed.then(() => {
      settled = true;
    });

    await fatalThrown;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(runCoding).not.toHaveBeenCalled();

    releaseSecond();
    const outcome = await observed;
    expect(outcome.succeeded).toBe(false);
    if (!outcome.succeeded) {
      expect(outcome.error).toMatchObject({
        code: "LEVELS_ATOMIC_WRITE_FAILED"
      });
    }
    expect(runCoding).not.toHaveBeenCalled();
    expect(runThinking).toHaveBeenCalledTimes(2);
    expect(runThinking).not.toHaveBeenCalledWith(sources[2]);
    expect(snapshots.at(-1)).toMatchObject({
      progress: [
        {
          safeId: sources[1]!.safeId,
          thinking: thinkingResult()
        }
      ],
      activeStages: [
        { safeId: sources[0]!.safeId, stage: "thinking" }
      ]
    });
    const writesAtRejection = snapshots.length;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(snapshots).toHaveLength(writesAtRejection);
  });

  it("等待异步保存思维检查点完成后才运行代码阶段", async () => {
    const runCoding = vi.fn(async () => codingResult());
    let notifySaveStarted = (): void => undefined;
    const saveStarted = new Promise<void>((resolve) => {
      notifySaveStarted = () => resolve();
    });
    let releaseThinkingSave = (): void => undefined;
    const thinkingSaveCanFinish = new Promise<void>((resolve) => {
      releaseThinkingSave = () => resolve();
    });
    const run = runLevelsCalibrationStages({
      items: [item(1)],
      concurrency: 1,
      runThinking: async () => thinkingResult(),
      runCoding,
      saveCheckpoint: async (state) => {
        if (state.progress[0]?.coding === undefined) {
          notifySaveStarted();
          await thinkingSaveCanFinish;
        }
      }
    });
    await saveStarted;
    expect(runCoding).not.toHaveBeenCalled();
    releaseThinkingSave();
    const result = await run;
    expect(runCoding).toHaveBeenCalledOnce();
    expect(result.rows).toHaveLength(1);
  });
});
