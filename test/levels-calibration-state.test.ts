import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DATA_STRUCTURE_SIGNATURES,
  mapCodingSignalsToLevel
} from "../src/pipelines/coding";
import {
  LevelsCalibrationStateError,
  acquireLevelsLabelLock,
  assessCalibrationCompleteness,
  assertCalibrationLabelUnused,
  buildLevelsExperimentFingerprint,
  buildLevelsReportRunConfiguration,
  buildLevelsRunConfiguration,
  checkpointUrl,
  completeCalibrationRows,
  loadCalibrationCheckpoint,
  preflightCalibrationDocuments,
  writeCalibrationCheckpoint,
  writeJsonAtomically,
  type CalibrationDatasetItem,
  type CalibrationFailureCount,
  type CalibrationProgress
} from "../experiments/lib/levels-calibration-state";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeDirectoryUrl(): URL {
  const directory = mkdtempSync(`${tmpdir()}${sep}fermata-levels-`);
  temporaryDirectories.push(directory);
  return pathToFileURL(`${directory}${sep}`);
}

function item(
  overrides: Partial<CalibrationDatasetItem> = {}
): CalibrationDatasetItem {
  return {
    contestId: 1000,
    index: "A",
    rating: 1200,
    statement: "题面正文",
    editorial: "标准题解",
    ...overrides
  };
}

function progress(
  source: CalibrationDatasetItem,
  overrides: Partial<CalibrationProgress> = {}
): CalibrationProgress {
  return {
    contestId: source.contestId,
    index: source.index,
    rating: source.rating,
    thinking: {
      level: 2,
      signals: {
        solved: true,
        approachSimilarity: 0.8,
        selfCorrections: 0,
        keyInsightCount: 1
      }
    },
    coding: {
      level: 2,
      signals: {
        effectiveLineCount: 30,
        maxNestingDepth: 2,
        detectedDataStructures: [],
        maxDataStructureWeight: 0
      }
    },
    ...overrides
  };
}

const noFailures: readonly CalibrationFailureCount[] = [];

function fingerprint(
  dataset: readonly CalibrationDatasetItem[],
  currentRunConfiguration = runConfiguration()
) {
  return buildLevelsExperimentFingerprint({
    dataset,
    experimentVersion: "experiment-test",
    profileName: "review-balanced",
    profile: {
      thinking: { solver: { model: "solver-a" }, analyst: { model: "analyst-a" } },
      coding: { model: "coding-a" }
    },
    runConfiguration: currentRunConfiguration,
    pipelineSources: {
      thinking: "thinking-source-v1",
      coding: "coding-source-v1",
      shared: "shared-source-v1"
    },
    calibrationProtocol: { bandBoundaries: [1400, 2200] }
  });
}

type TestRunConfiguration = ReturnType<typeof buildLevelsRunConfiguration>;
type TestRunConfigurationOverrides =
  Partial<Omit<TestRunConfiguration, "providerBaseUrls">> & {
    readonly providerBaseUrls?: Partial<TestRunConfiguration["providerBaseUrls"]>;
  };

function runConfiguration(overrides: TestRunConfigurationOverrides = {}) {
  const base = buildLevelsRunConfiguration({
    solverBaseUrl: "https://solver.example/v1/",
    analystBaseUrl: "https://analyst.example/v1/",
    codingBaseUrl: "https://coding.example/v1/",
    outputIdleTimeoutMs: 600_000,
    firstOutputTimeoutMs: 1_800_000,
    maximumDurationMs: 14_400_000,
    maxAttempts: 3,
    baseDelayMs: 1_000,
    concurrency: 4
  });
  return {
    ...base,
    ...overrides,
    providerBaseUrls: {
      ...base.providerBaseUrls,
      ...overrides.providerBaseUrls
    }
  };
}

function captureStateError(action: () => unknown): LevelsCalibrationStateError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(LevelsCalibrationStateError);
    return error as LevelsCalibrationStateError;
  }
  throw new Error("预期操作失败，但操作成功了。");
}

describe("标定集预检", () => {
  it("JSON 损坏、必需字段缺失和题解缺失都会让整批输入失败", () => {
    const error = captureStateError(() =>
      preflightCalibrationDocuments([
        "{not-json",
        JSON.stringify({ contestId: 1, index: "A", rating: 1200, editorial: "题解" }),
        JSON.stringify({ ...item({ contestId: 2 }), editorial: null })
      ])
    );
    expect(error.code).toBe("LEVELS_DATA_PRECHECK_FAILED");
    expect(error.message).toBe("标定集预检失败。");
    expect(error.message).not.toContain("not-json");
    expect(error.issues).toEqual([
      { code: "LEVELS_DATA_EDITORIAL_MISSING", count: 1 },
      { code: "LEVELS_DATA_FIELDS_INVALID", count: 1 },
      { code: "LEVELS_DATA_JSON_INVALID", count: 1 }
    ]);
  });

  it("重复题号会让整批输入失败", () => {
    const duplicate = item();
    const error = captureStateError(() =>
      preflightCalibrationDocuments([
        JSON.stringify(duplicate),
        JSON.stringify({ ...duplicate, statement: "另一份题面" })
      ])
    );
    expect(error.code).toBe("LEVELS_DATA_PRECHECK_FAILED");
    expect(error.issues).toEqual([{ code: "LEVELS_DATA_DUPLICATE", count: 1 }]);
  });

  it("题号只接受一个大写字母及其后的数字，不接受空白、换行或 Markdown", () => {
    const invalidIndexes = [" A", "A ", "A\n", "[A]", "A|B", "a", "AA", "A12345678"];
    const documents = invalidIndexes.map((index, offset) =>
      JSON.stringify(item({ contestId: 100 + offset, index }))
    );
    documents.push(
      JSON.stringify(item({ contestId: 201, index: "A1", rating: 1200 })),
      JSON.stringify(item({ contestId: 202, index: "B2", rating: 1800 })),
      JSON.stringify(item({ contestId: 203, index: "C3", rating: 2400 }))
    );
    const error = captureStateError(() => preflightCalibrationDocuments(documents));
    expect(error.issues).toEqual([
      { code: "LEVELS_DATA_FIELDS_INVALID", count: invalidIndexes.length }
    ]);
  });

  it("比赛编号和官方 rating 必须是正整数", () => {
    const error = captureStateError(() =>
      preflightCalibrationDocuments([
        JSON.stringify(item({ contestId: 0 })),
        JSON.stringify(item({ contestId: 2, rating: -100 })),
        JSON.stringify(item({ contestId: 3, index: "B", rating: 1800 })),
        JSON.stringify(item({ contestId: 4, index: "C", rating: 2400 }))
      ])
    );
    expect(error.issues).toEqual([
      { code: "LEVELS_DATA_FIELDS_INVALID", count: 2 }
    ]);
  });

  it("缺少低、中、高任一分段时在模型调用前的预检阶段失败", () => {
    const error = captureStateError(() =>
      preflightCalibrationDocuments([
        JSON.stringify(item({ contestId: 1, index: "A", rating: 1000 })),
        JSON.stringify(item({ contestId: 2, index: "B", rating: 1800 }))
      ])
    );
    expect(error.code).toBe("LEVELS_DATA_PRECHECK_FAILED");
    expect(error.issues).toEqual([{ code: "LEVELS_DATA_BAND_MISSING", count: 1 }]);
  });

  it("没有任何输入时明确失败", () => {
    expect(captureStateError(() => preflightCalibrationDocuments([])).code).toBe(
      "LEVELS_DATASET_EMPTY"
    );
  });

  it("全部合法时返回稳定排序后的完整集合", () => {
    const high = item({ contestId: 3, index: "C", rating: 2400 });
    const low = item({ contestId: 1, index: "A", rating: 1000 });
    const middle = item({ contestId: 2, index: "B", rating: 1800 });
    expect(
      preflightCalibrationDocuments(
        [high, low, middle].map((value) => JSON.stringify(value))
      ).map((value) => value.contestId)
    ).toEqual([1, 2, 3]);
  });
});

describe("实验校验摘要与续跑", () => {
  it("题面、题解、rating、模型配置和流水线来源变化都会改变摘要", () => {
    const dataset = [item()];
    const base = fingerprint(dataset);
    expect(fingerprint(dataset)).toEqual(base);
    expect(fingerprint([item({ statement: "新题面" })]).combinedHash).not.toBe(
      base.combinedHash
    );
    expect(fingerprint([item({ editorial: "新题解" })]).combinedHash).not.toBe(
      base.combinedHash
    );
    expect(fingerprint([item({ rating: 1300 })]).combinedHash).not.toBe(
      base.combinedHash
    );

    const modelChanged = buildLevelsExperimentFingerprint({
      dataset,
      experimentVersion: "experiment-test",
      profileName: "review-balanced",
      profile: { coding: { model: "coding-b" } },
      runConfiguration: runConfiguration(),
      pipelineSources: {
        thinking: "thinking-source-v1",
        coding: "coding-source-v1",
        shared: "shared-source-v1"
      },
      calibrationProtocol: { bandBoundaries: [1400, 2200] }
    });
    expect(modelChanged.combinedHash).not.toBe(base.combinedHash);

    const pipelineChanged = buildLevelsExperimentFingerprint({
      dataset,
      experimentVersion: "experiment-test",
      profileName: "review-balanced",
      profile: {
        thinking: { solver: { model: "solver-a" }, analyst: { model: "analyst-a" } },
        coding: { model: "coding-a" }
      },
      runConfiguration: runConfiguration(),
      pipelineSources: {
        thinking: "thinking-source-v2",
        coding: "coding-source-v1",
        shared: "shared-source-v1"
      },
      calibrationProtocol: { bandBoundaries: [1400, 2200] }
    });
    expect(pipelineChanged.combinedHash).not.toBe(base.combinedHash);
  });

  it("实际服务地址、三项等待时间、重试和并发参数变化都会改变摘要", () => {
    const dataset = [item()];
    const base = fingerprint(dataset);
    const changedConfigurations = [
      runConfiguration({
        providerBaseUrls: { solver: "https://solver-2.example/v1/" }
      }),
      runConfiguration({ outputIdleTimeoutMs: 600_001 }),
      runConfiguration({ firstOutputTimeoutMs: 1_800_001 }),
      runConfiguration({ maximumDurationMs: 14_400_001 }),
      runConfiguration({ maxAttempts: 2 }),
      runConfiguration({ baseDelayMs: 2_000 }),
      runConfiguration({ concurrency: 2 })
    ];
    for (const changed of changedConfigurations) {
      expect(fingerprint(dataset, changed).combinedHash).not.toBe(base.combinedHash);
    }
  });

  it("模型服务地址拒绝账号、密码、查询参数和片段", () => {
    const unsafeAddresses = [
      "https://user:password@private.example/v1",
      "https://private.example/v1?api_key=secret",
      "https://private.example/v1#secret"
    ];
    for (const solverBaseUrl of unsafeAddresses) {
      expect(
        captureStateError(() =>
          buildLevelsRunConfiguration({
            solverBaseUrl,
            analystBaseUrl: "https://analyst.example/v1/",
            codingBaseUrl: "https://coding.example/v1/",
            outputIdleTimeoutMs: 600_000,
            firstOutputTimeoutMs: 1_800_000,
            maximumDurationMs: 14_400_000,
            maxAttempts: 3,
            baseDelayMs: 1_000,
            concurrency: 4
          })
        ).code
      ).toBe("LEVELS_FINGERPRINT_BUILD_FAILED");
      expect(
        captureStateError(() =>
          fingerprint(
            [item()],
            runConfiguration({
              providerBaseUrls: { solver: solverBaseUrl }
            })
          )
        ).code
      ).toBe("LEVELS_FINGERPRINT_BUILD_FAILED");
    }
  });

  it("三项等待时间都使用安全范围，且最长时间不能短于另外两项", () => {
    const safeInput = {
      solverBaseUrl: "https://solver.example/v1/",
      analystBaseUrl: "https://analyst.example/v1/",
      codingBaseUrl: "https://coding.example/v1/",
      outputIdleTimeoutMs: 600_000,
      firstOutputTimeoutMs: 1_800_000,
      maximumDurationMs: 14_400_000,
      maxAttempts: 3,
      baseDelayMs: 1_000,
      concurrency: 4
    };
    const invalidChanges = [
      { outputIdleTimeoutMs: 599_999 },
      { outputIdleTimeoutMs: 86_400_001 },
      { outputIdleTimeoutMs: 600_000.5 },
      { firstOutputTimeoutMs: 1_799_999 },
      { firstOutputTimeoutMs: 86_400_001 },
      { maximumDurationMs: 14_399_999 },
      { maximumDurationMs: 86_400_001 },
      {
        outputIdleTimeoutMs: 18_000_000,
        maximumDurationMs: 14_400_000
      },
      {
        firstOutputTimeoutMs: 18_000_000,
        maximumDurationMs: 14_400_000
      }
    ];
    for (const change of invalidChanges) {
      expect(
        captureStateError(() =>
          buildLevelsRunConfiguration({ ...safeInput, ...change })
        ).code
      ).toBe("LEVELS_FINGERPRINT_BUILD_FAILED");
    }
  });

  it("公开运行参数只保留服务名称、地址校验值和数值，不输出完整地址", () => {
    const privateConfiguration = buildLevelsRunConfiguration({
      solverBaseUrl: "https://solver.private.example/internal/gateway",
      analystBaseUrl: "https://analyst.private.example/internal/gateway",
      codingBaseUrl: "https://coding.private.example/internal/gateway",
      outputIdleTimeoutMs: 600_000,
      firstOutputTimeoutMs: 1_800_000,
      maximumDurationMs: 14_400_000,
      maxAttempts: 3,
      baseDelayMs: 1_000,
      concurrency: 4
    });
    const reportConfiguration = buildLevelsReportRunConfiguration({
      runConfiguration: privateConfiguration,
      providerNames: {
        solver: "aether",
        analyst: "aether",
        coding: "dashscope"
      }
    });
    const serialized = JSON.stringify(reportConfiguration);
    expect(serialized).not.toContain("/internal/gateway");
    expect(serialized).not.toContain("private.example");
    expect(serialized).toContain("aether");
    expect(reportConfiguration).toMatchObject({
      outputIdleTimeoutMs: 600_000,
      firstOutputTimeoutMs: 1_800_000,
      maximumDurationMs: 14_400_000
    });
    expect(reportConfiguration.providers.solver.addressCheck).toMatch(
      /^[a-f0-9]{16}$/
    );
  });

  it("只读取明确指定的 checkpoint，不扫描或合并历史快照", () => {
    const directory = makeDirectoryUrl();
    const dataset = [item()];
    const currentFingerprint = fingerprint(dataset);
    writeCalibrationCheckpoint({
      target: new URL("levels-source-2026-01-01.json", directory),
      label: "source",
      profileName: "review-balanced",
      fingerprint: currentFingerprint,
      progress: [progress(dataset[0]!)],
      failureCounts: noFailures
    });

    const error = captureStateError(() =>
      loadCalibrationCheckpoint({
        source: checkpointUrl(directory, "source"),
        expectedLabel: "source",
        expectedProfileName: "review-balanced",
        expectedFingerprint: currentFingerprint,
        expectedItems: dataset
      })
    );
    expect(error.code).toBe("LEVELS_CHECKPOINT_MISSING");
  });

  it("第 3 版检查点可以只保存思维阶段，并在恢复后继续保留严格信号", () => {
    const directory = makeDirectoryUrl();
    const dataset = [item()];
    const currentFingerprint = fingerprint(dataset);
    const complete = progress(dataset[0]!);
    const thinkingOnly: CalibrationProgress = {
      contestId: complete.contestId,
      index: complete.index,
      rating: complete.rating,
      thinking: complete.thinking
    };
    const target = checkpointUrl(directory, "source");
    writeCalibrationCheckpoint({
      target,
      label: "source",
      profileName: "review-balanced",
      fingerprint: currentFingerprint,
      progress: [thinkingOnly],
      failureCounts: [
        {
          stage: "coding",
          errorCode: "LLM_HTTP_ERROR",
          status: 499,
          count: 2
        }
      ]
    });

    const checkpointText = readFileSync(target, "utf8");
    expect(checkpointText).not.toContain(dataset[0]!.statement);
    expect(checkpointText).not.toContain(dataset[0]!.editorial);
    const serialized = JSON.parse(checkpointText) as {
      readonly schemaVersion: unknown;
    };
    expect(serialized.schemaVersion).toBe(3);
    const restored = loadCalibrationCheckpoint({
      source: target,
      expectedLabel: "source",
      expectedProfileName: "review-balanced",
      expectedFingerprint: currentFingerprint,
      expectedItems: dataset
    });
    expect(restored).toEqual({
      progress: [thinkingOnly],
      failureCounts: [
        {
          stage: "coding",
          errorCode: "LLM_HTTP_ERROR",
          status: 499,
          count: 2
        }
      ]
    });
    expect(completeCalibrationRows(restored.progress)).toEqual([]);
  });

  it("旧检查点的笼统模型错误码只在读取时兼容，并归入未知错误", () => {
    const directory = makeDirectoryUrl();
    const dataset = [item()];
    const currentFingerprint = fingerprint(dataset);
    const target = checkpointUrl(directory, "legacy-errors");
    writeCalibrationCheckpoint({
      target,
      label: "legacy-errors",
      profileName: "review-balanced",
      fingerprint: currentFingerprint,
      progress: [],
      failureCounts: []
    });
    const saved = JSON.parse(readFileSync(target, "utf8")) as {
      failureCounts: unknown[];
    };
    saved.failureCounts = [
      {
        stage: "coding",
        errorCode: "LLM_REQUEST_FAILED",
        status: null,
        count: 2
      },
      {
        stage: "coding",
        errorCode: "UNEXPECTED_ERROR",
        status: null,
        count: 3
      }
    ];
    writeFileSync(target, JSON.stringify(saved), "utf8");

    const restored = loadCalibrationCheckpoint({
      source: target,
      expectedLabel: "legacy-errors",
      expectedProfileName: "review-balanced",
      expectedFingerprint: currentFingerprint,
      expectedItems: dataset
    });
    expect(restored.failureCounts).toEqual([
      {
        stage: "coding",
        errorCode: "UNEXPECTED_ERROR",
        status: null,
        count: 5
      }
    ]);

    const rewritten = new URL("levels-rewritten-checkpoint.json", directory);
    writeCalibrationCheckpoint({
      target: rewritten,
      label: "legacy-errors",
      profileName: "review-balanced",
      fingerprint: currentFingerprint,
      progress: restored.progress,
      failureCounts: restored.failureCounts
    });
    expect(readFileSync(rewritten, "utf8")).not.toContain(
      "LLM_REQUEST_FAILED"
    );
  });

  it("第 2 版和其它数字版本都明确拒绝续跑，缺失版本仍按格式错误处理", () => {
    const directory = makeDirectoryUrl();
    const dataset = [item()];
    const currentFingerprint = fingerprint(dataset);
    const target = checkpointUrl(directory, "legacy");
    const load = () =>
      loadCalibrationCheckpoint({
        source: target,
        expectedLabel: "legacy",
        expectedProfileName: "review-balanced",
        expectedFingerprint: currentFingerprint,
        expectedItems: dataset
      });
    for (const schemaVersion of [2, 4]) {
      writeFileSync(
        target,
        JSON.stringify({
          schemaVersion,
          label: "legacy",
          profileName: "review-balanced",
          fingerprint: currentFingerprint,
          progress: [],
          failureCounts: []
        }),
        "utf8"
      );
      expect(captureStateError(load).code).toBe(
        "LEVELS_CHECKPOINT_VERSION_UNSUPPORTED"
      );
    }
    writeFileSync(
      target,
      JSON.stringify({
        schemaVersion: "3",
        label: "legacy",
        profileName: "review-balanced",
        fingerprint: currentFingerprint,
        progress: [],
        failureCounts: []
      }),
      "utf8"
    );
    expect(captureStateError(load).code).toBe(
      "LEVELS_CHECKPOINT_INVALID"
    );
    writeFileSync(
      target,
      JSON.stringify({
        label: "legacy",
        profileName: "review-balanced",
        fingerprint: currentFingerprint,
        progress: [],
        failureCounts: []
      }),
      "utf8"
    );
    expect(captureStateError(load).code).toBe(
      "LEVELS_CHECKPOINT_INVALID"
    );
  });

  it("摘要不一致时拒绝复用检查点", () => {
    const directory = makeDirectoryUrl();
    const dataset = [item()];
    const oldFingerprint = fingerprint(dataset);
    writeCalibrationCheckpoint({
      target: checkpointUrl(directory, "source"),
      label: "source",
      profileName: "review-balanced",
      fingerprint: oldFingerprint,
      progress: [progress(dataset[0]!)],
      failureCounts: noFailures
    });

    const changedDataset = [item({ editorial: "修改后的题解" })];
    const error = captureStateError(() =>
      loadCalibrationCheckpoint({
        source: checkpointUrl(directory, "source"),
        expectedLabel: "source",
        expectedProfileName: "review-balanced",
        expectedFingerprint: fingerprint(changedDataset),
        expectedItems: changedDataset
      })
    );
    expect(error.code).toBe("LEVELS_FINGERPRINT_MISMATCH");
  });

  it("任一等待时间变化后都不能复用旧检查点", () => {
    const directory = makeDirectoryUrl();
    const dataset = [item()];
    const target = checkpointUrl(directory, "source");
    writeCalibrationCheckpoint({
      target,
      label: "source",
      profileName: "review-balanced",
      fingerprint: fingerprint(dataset),
      progress: [progress(dataset[0]!)],
      failureCounts: noFailures
    });
    const changedConfigurations = [
      runConfiguration({ outputIdleTimeoutMs: 600_001 }),
      runConfiguration({ firstOutputTimeoutMs: 1_800_001 }),
      runConfiguration({ maximumDurationMs: 14_400_001 })
    ];
    for (const changedConfiguration of changedConfigurations) {
      const error = captureStateError(() =>
        loadCalibrationCheckpoint({
          source: target,
          expectedLabel: "source",
          expectedProfileName: "review-balanced",
          expectedFingerprint: fingerprint(dataset, changedConfiguration),
          expectedItems: dataset
        })
      );
      expect(error.code).toBe("LEVELS_FINGERPRINT_MISMATCH");
    }
  });

  it("没有实验校验摘要的旧格式检查点会被拒绝", () => {
    const directory = makeDirectoryUrl();
    const dataset = [item()];
    const target = checkpointUrl(directory, "legacy");
    writeFileSync(
      target,
      JSON.stringify({
        label: "legacy",
        profileName: "review-balanced",
        rows: []
      }),
      "utf8"
    );
    const error = captureStateError(() =>
      loadCalibrationCheckpoint({
        source: target,
        expectedLabel: "legacy",
        expectedProfileName: "review-balanced",
        expectedFingerprint: fingerprint(dataset),
        expectedItems: dataset
      })
    );
    expect(error.code).toBe("LEVELS_CHECKPOINT_INVALID");
  });

  it("写入前拒绝空进度、脱离思维的代码结果和任何未知信号字段", () => {
    const directory = makeDirectoryUrl();
    const dataset = [item()];
    const currentFingerprint = fingerprint(dataset);
    const write = (candidate: CalibrationProgress) =>
      writeCalibrationCheckpoint({
        target: checkpointUrl(directory, "invalid"),
        label: "invalid",
        profileName: "review-balanced",
        fingerprint: currentFingerprint,
        progress: [candidate],
        failureCounts: noFailures
      });
    expect(
      captureStateError(() =>
        write({
          contestId: dataset[0]!.contestId,
          index: dataset[0]!.index,
          rating: dataset[0]!.rating
        })
      ).code
    ).toBe("LEVELS_CHECKPOINT_INVALID");
    const complete = progress(dataset[0]!);
    expect(
      captureStateError(() =>
        write({
          contestId: complete.contestId,
          index: complete.index,
          rating: complete.rating,
          coding: complete.coding
        })
      ).code
    ).toBe("LEVELS_CHECKPOINT_INVALID");
    expect(
      captureStateError(() =>
        write({
          ...complete,
          thinking: {
            ...complete.thinking!,
            signals: {
              ...complete.thinking!.signals,
              leakedText: "不能保存"
            }
          }
        } as unknown as CalibrationProgress)
      ).code
    ).toBe("LEVELS_CHECKPOINT_INVALID");
  });

  it("写入和读取时都拒绝与信号计算结果不一致的等级", () => {
    const directory = makeDirectoryUrl();
    const dataset = [item()];
    const currentFingerprint = fingerprint(dataset);
    const target = checkpointUrl(directory, "levels");
    const complete = progress(dataset[0]!);
    expect(
      captureStateError(() =>
        writeCalibrationCheckpoint({
          target,
          label: "levels",
          profileName: "review-balanced",
          fingerprint: currentFingerprint,
          progress: [
            {
              ...complete,
              thinking: {
                ...complete.thinking!,
                level: 5
              }
            }
          ],
          failureCounts: noFailures
        })
      ).code
    ).toBe("LEVELS_CHECKPOINT_INVALID");
    expect(
      captureStateError(() =>
        writeCalibrationCheckpoint({
          target,
          label: "levels",
          profileName: "review-balanced",
          fingerprint: currentFingerprint,
          progress: [
            {
              ...complete,
              coding: {
                ...complete.coding!,
                level: 5
              }
            }
          ],
          failureCounts: noFailures
        })
      ).code
    ).toBe("LEVELS_CHECKPOINT_INVALID");

    writeCalibrationCheckpoint({
      target,
      label: "levels",
      profileName: "review-balanced",
      fingerprint: currentFingerprint,
      progress: [complete],
      failureCounts: noFailures
    });
    const saved = JSON.parse(readFileSync(target, "utf8")) as {
      progress: Array<{
        thinking: { level: number };
      }>;
    };
    saved.progress[0]!.thinking.level = 5;
    writeFileSync(target, JSON.stringify(saved), "utf8");
    expect(
      captureStateError(() =>
        loadCalibrationCheckpoint({
          source: target,
          expectedLabel: "levels",
          expectedProfileName: "review-balanced",
          expectedFingerprint: currentFingerprint,
          expectedItems: dataset
        })
      ).code
    ).toBe("LEVELS_CHECKPOINT_INVALID");
  });

  it("代码信号拒绝未知、重复或与最高权重不一致的数据结构名称", () => {
    const directory = makeDirectoryUrl();
    const dataset = [item()];
    const currentFingerprint = fingerprint(dataset);
    const writeSignals = (signals: unknown, level = 2) =>
      writeCalibrationCheckpoint({
        target: checkpointUrl(directory, "signals"),
        label: "signals",
        profileName: "review-balanced",
        fingerprint: currentFingerprint,
        progress: [
          {
            ...progress(dataset[0]!),
            coding: { level, signals }
          } as unknown as CalibrationProgress
        ],
        failureCounts: noFailures
      });
    const allSignals = {
      effectiveLineCount: 10,
      maxNestingDepth: 1,
      detectedDataStructures: DATA_STRUCTURE_SIGNATURES.map(
        (signature) => signature.label
      ),
      maxDataStructureWeight: Math.max(
        ...DATA_STRUCTURE_SIGNATURES.map((signature) => signature.weight)
      )
    };
    expect(() =>
      writeSignals(allSignals, mapCodingSignalsToLevel(allSignals))
    ).not.toThrow();
    for (const signature of DATA_STRUCTURE_SIGNATURES) {
      const signals = {
        effectiveLineCount: 10,
        maxNestingDepth: 1,
        detectedDataStructures: [signature.label],
        maxDataStructureWeight: signature.weight
      };
      expect(() =>
        writeSignals(signals, mapCodingSignalsToLevel(signals))
      ).not.toThrow();
    }
    for (const signals of [
      {
        effectiveLineCount: 10,
        maxNestingDepth: 1,
        detectedDataStructures: ["模型返回的任意文字"],
        maxDataStructureWeight: 0
      },
      {
        effectiveLineCount: 10,
        maxNestingDepth: 1,
        detectedDataStructures: ["网络流", "网络流"],
        maxDataStructureWeight: 2.5
      },
      {
        effectiveLineCount: 10,
        maxNestingDepth: 1,
        detectedDataStructures: ["网络流"],
        maxDataStructureWeight: 1
      }
    ]) {
      expect(captureStateError(() => writeSignals(signals)).code).toBe(
        "LEVELS_CHECKPOINT_INVALID"
      );
    }
  });

  it("失败统计只接受固定阶段、固定错误码和安全状态码，并拒绝重复项", () => {
    const directory = makeDirectoryUrl();
    const dataset = [item()];
    const currentFingerprint = fingerprint(dataset);
    const writeFailures = (failureCounts: readonly CalibrationFailureCount[]) =>
      writeCalibrationCheckpoint({
        target: checkpointUrl(directory, "failures"),
        label: "failures",
        profileName: "review-balanced",
        fingerprint: currentFingerprint,
        progress: [],
        failureCounts
      });
    const httpFailure = {
      stage: "coding",
      errorCode: "LLM_HTTP_ERROR",
      status: 429,
      count: 1
    } as const;
    const currentLlmFailures = [
      "LLM_NETWORK_FAILED",
      "LLM_FIRST_OUTPUT_TIMEOUT",
      "LLM_OUTPUT_IDLE_TIMEOUT",
      "LLM_TOTAL_TIMEOUT",
      "LLM_STREAM_INTERRUPTED"
    ].map(
      (errorCode) =>
        ({
          stage: "thinking",
          errorCode,
          status: null,
          count: 1
        }) as CalibrationFailureCount
    );
    expect(() =>
      writeFailures([httpFailure, ...currentLlmFailures])
    ).not.toThrow();
    for (const failureCounts of [
      [{ ...httpFailure, status: 99 }],
      [{ ...httpFailure, status: 200 }],
      [{ ...httpFailure, status: 204 }],
      [{ ...httpFailure, status: 600 }],
      [{ ...httpFailure, count: 0 }],
      [
        {
          stage: "thinking",
          errorCode: "LLM_NETWORK_FAILED",
          status: 503,
          count: 1
        }
      ],
      [
        {
          stage: "thinking",
          errorCode: "LLM_REQUEST_FAILED",
          status: null,
          count: 1
        }
      ],
      [
        {
          stage: "thinking",
          errorCode: "LLM_NETWORK_FAILED",
          status: null,
          count: 1,
          message: "不能写入检查点的外部错误正文"
        }
      ],
      [httpFailure, httpFailure]
    ]) {
      expect(
        captureStateError(() =>
          writeFailures(
            failureCounts as readonly CalibrationFailureCount[]
          )
        ).code
      ).toBe("LEVELS_CHECKPOINT_INVALID");
    }
  });

  it("新实验不能覆盖同标签的检查点、快照、报告、汇总或残留临时文件", () => {
    const artifacts = [
      ["checkpoint", "raw", "levels-checkpoint-checkpoint.json"],
      ["snapshot", "raw", "levels-snapshot-2026-07-31T12-34-56-789Z.json"],
      ["report", "results", "levels-report-report.md"],
      ["summary", "results", "levels-summary-summary.json"],
      ["temporary", "results", "levels-temporary-summary.json.tmp-123-abc-def"],
      ["legacy-temp", "results", "levels-legacy-temp-report.md.tmp"]
    ] as const;
    for (const [label, location, fileName] of artifacts) {
      const rawDirectory = makeDirectoryUrl();
      const resultsDirectory = makeDirectoryUrl();
      const targetDirectory =
        location === "raw" ? rawDirectory : resultsDirectory;
      writeFileSync(new URL(fileName, targetDirectory), "occupied", "utf8");
      const error = captureStateError(() =>
        assertCalibrationLabelUnused({
          label,
          rawDirectory,
          resultsDirectory
        })
      );
      expect(error.code).toBe("LEVELS_LABEL_ALREADY_USED");
    }
  });

  it("标签检查使用完整文件名，不把带点标签或更长标签误判成当前标签", () => {
    const rawDirectory = makeDirectoryUrl();
    const resultsDirectory = makeDirectoryUrl();
    writeFileSync(
      new URL("levels-v1.2-next-summary.json", resultsDirectory),
      "other label",
      "utf8"
    );
    writeFileSync(new URL("levels-v1.2.lock", rawDirectory), "current lock", "utf8");
    expect(() =>
      assertCalibrationLabelUnused({
        label: "v1.2",
        rawDirectory,
        resultsDirectory
      })
    ).not.toThrow();
    writeFileSync(
      new URL("levels-v1.2-report.md", resultsDirectory),
      "occupied",
      "utf8"
    );
    expect(
      captureStateError(() =>
        assertCalibrationLabelUnused({
          label: "v1.2",
          rawDirectory,
          resultsDirectory
        })
      ).code
    ).toBe("LEVELS_LABEL_ALREADY_USED");
  });

  it("检查点中的未知题目、重复题目或不同 rating 会被拒绝", () => {
    const directory = makeDirectoryUrl();
    const dataset = [item()];
    const currentFingerprint = fingerprint(dataset);
    const target = checkpointUrl(directory, "source");
    writeCalibrationCheckpoint({
      target,
      label: "source",
      profileName: "review-balanced",
      fingerprint: currentFingerprint,
      progress: [progress(dataset[0]!)],
      failureCounts: noFailures
    });
    const saved = JSON.parse(readFileSync(target, "utf8")) as Record<
      string,
      unknown
    > & {
      progress: CalibrationProgress[];
    };
    const validProgress = saved.progress[0]!;
    const invalidProgressSets: readonly CalibrationProgress[][] = [
      [{ ...validProgress, contestId: validProgress.contestId + 1 }],
      [validProgress, validProgress],
      [{ ...validProgress, rating: validProgress.rating + 100 }]
    ];
    for (const invalidProgress of invalidProgressSets) {
      writeFileSync(
        target,
        JSON.stringify({ ...saved, progress: invalidProgress }),
        "utf8"
      );
      expect(
        captureStateError(() =>
          loadCalibrationCheckpoint({
            source: target,
            expectedLabel: "source",
            expectedProfileName: "review-balanced",
            expectedFingerprint: currentFingerprint,
            expectedItems: dataset
          })
        ).code
      ).toBe("LEVELS_CHECKPOINT_INVALID");
    }
  });
});

describe("完整性、原子写和同标签互斥", () => {
  it("缺少任一低、中、高分段时 complete 为 false", () => {
    const result = assessCalibrationCompleteness(
      [{ rating: 1000 }, { rating: 1800 }],
      2
    );
    expect(result).toEqual({
      allProblemsCompleted: true,
      allBandsPresent: false,
      missingBands: ["高"],
      complete: false
    });
  });

  it("只有题目全部完成且三个分段都有样本时才完整", () => {
    expect(
      assessCalibrationCompleteness(
        [{ rating: 1000 }, { rating: 1800 }, { rating: 2400 }],
        3
      )
    ).toEqual({
      allProblemsCompleted: true,
      allBandsPresent: true,
      missingBands: [],
      complete: true
    });
  });

  it("原子写可以覆盖目标且不会留下固定或随机临时文件", () => {
    const directory = makeDirectoryUrl();
    const target = new URL("summary.json", directory);
    writeJsonAtomically(target, { version: 1 });
    writeJsonAtomically(target, { version: 2 });
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ version: 2 });
    expect(readdirSync(directory).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("同一标签只能由一个进程持有运行锁", () => {
    const directory = makeDirectoryUrl();
    const first = acquireLevelsLabelLock(directory, "same-label");
    const lockFile = new URL("levels-same-label.lock", directory);
    const firstMarker = readFileSync(lockFile, "utf8");
    try {
      expect(
        captureStateError(() => acquireLevelsLabelLock(directory, "same-label")).code
      ).toBe("LEVELS_LABEL_LOCKED");
    } finally {
      expect(first.release()).toBe(true);
    }
    const second = acquireLevelsLabelLock(directory, "same-label");
    const secondMarker = readFileSync(lockFile, "utf8");
    expect(secondMarker).not.toBe(firstMarker);
    expect(second.release()).toBe(true);
  });

  it("旧任务不会删除已被替换的新锁，重复 release 也保持失败结果", () => {
    const directory = makeDirectoryUrl();
    const lock = acquireLevelsLabelLock(directory, "replaced");
    const lockFile = new URL("levels-replaced.lock", directory);
    unlinkSync(lockFile);
    writeFileSync(lockFile, "another-process:new-random-owner\n", "utf8");
    expect(lock.release()).toBe(false);
    expect(lock.release()).toBe(false);
    expect(readFileSync(lockFile, "utf8")).toBe(
      "another-process:new-random-owner\n"
    );
  });
});
