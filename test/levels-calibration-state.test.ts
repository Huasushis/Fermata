import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DATA_STRUCTURE_SIGNATURES,
  mapCodingSignalsToLevel
} from "../src/pipelines/coding";
import {
  LevelsCalibrationStateError,
  acquireLevelsLabelLock,
  acquireLevelsResumeSourceLock,
  assessCalibrationCompleteness,
  assertCalibrationLabelUnused,
  assertLevelsResumeModeSupported,
  buildLevelsExperimentFingerprint,
  buildLevelsReportRunConfiguration,
  buildLevelsRunConfiguration,
  checkpointUrl,
  completeCalibrationRows,
  loadCalibrationCheckpoint,
  loadCalibrationDatasetDirectory,
  preflightCalibrationDatasetBundle,
  preflightCalibrationDocuments,
  writeCalibrationReportArtifacts,
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
  const contestId = overrides.contestId ?? 1000;
  const index = overrides.index ?? "A";
  return {
    safeId: `sample-${contestId}-${index}`,
    contestId,
    index,
    rating: 1200,
    humanThinkingLevel: 2,
    humanCodingLevel: 2,
    statement: "题面正文",
    editorial: "标准题解",
    ...overrides
  };
}

function registeredDataset(size = 60) {
  const files = Array.from({ length: size }, (_, offset) => {
    const band = offset % 3;
    const document = JSON.stringify(
      item({
        safeId: `registered-${String(offset + 1).padStart(3, "0")}`,
        contestId: offset + 1,
        index: "A",
        rating: band === 0 ? 1200 : band === 1 ? 1800 : 2400,
        humanThinkingLevel: band + 1,
        humanCodingLevel: band + 1
      })
    );
    return {
      fileName: `sample-${String(offset + 1).padStart(3, "0")}.json`,
      content: Buffer.from(document, "utf8")
    };
  });
  const manifest = {
    schemaVersion: 1,
    datasetId: "registered-levels-v1",
    entries: files.map((file, offset) => ({
      safeId: `registered-${String(offset + 1).padStart(3, "0")}`,
      fileName: file.fileName,
      sha256: createHash("sha256")
        .update(file.content)
        .digest("hex")
    }))
  } as const;
  return {
    files,
    manifest,
    manifestDocument: JSON.stringify(manifest)
  };
}

function materializeRegisteredDataset(
  directory: URL,
  registered = registeredDataset()
) {
  writeFileSync(
    new URL("manifest.private.json", directory),
    registered.manifestDocument,
    "utf8"
  );
  for (const file of registered.files) {
    writeFileSync(new URL(file.fileName, directory), file.content);
  }
  return registered;
}

function progress(
  source: CalibrationDatasetItem,
  overrides: Partial<CalibrationProgress> = {}
): CalibrationProgress {
  return {
    safeId: source.safeId,
    contestId: source.contestId,
    index: source.index,
    rating: source.rating,
    humanThinkingLevel: source.humanThinkingLevel,
    humanCodingLevel: source.humanCodingLevel,
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
const checkpointChainRunId = "33333333-3333-4333-8333-333333333333";
const datasetManifestHash = createHash("sha256")
  .update("test-levels-manifest", "utf8")
  .digest("hex");

function fingerprint(
  dataset: readonly CalibrationDatasetItem[],
  currentRunConfiguration = runConfiguration()
) {
  return buildLevelsExperimentFingerprint({
    dataset,
    datasetManifestHash,
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
  it("从固定目录描述符读取清单登记的完整数据集", () => {
    const directory = makeDirectoryUrl();
    materializeRegisteredDataset(directory);

    const bundle = loadCalibrationDatasetDirectory(directory);

    expect(bundle.datasetId).toBe("registered-levels-v1");
    expect(bundle.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.items).toHaveLength(60);
  });

  it("数据集中的符号链接在任何题面进入内存前按固定码整体失败", () => {
    const directory = makeDirectoryUrl();
    const registered = materializeRegisteredDataset(directory);
    const outsideDirectory = makeDirectoryUrl();
    const outsideFile = new URL("outside.json", outsideDirectory);
    writeFileSync(outsideFile, registered.files[0]!.content);
    const linkedFile = new URL(registered.files[0]!.fileName, directory);
    unlinkSync(linkedFile);
    symlinkSync(fileURLToPath(outsideFile), fileURLToPath(linkedFile));

    const error = captureStateError(() =>
      loadCalibrationDatasetDirectory(directory)
    );

    expect(error.code).toBe("LEVELS_DATA_PRECHECK_FAILED");
    expect(error.issues).toEqual([
      { code: "LEVELS_DATA_MANIFEST_MISMATCH", count: 1 }
    ]);
    expect(error.message).not.toContain("outside.json");
  });

  it("初次目录检查后替换成另一个普通文件也不能绕过逐字节清单绑定", () => {
    const directory = makeDirectoryUrl();
    const registered = materializeRegisteredDataset(directory);
    const replacementDirectory = makeDirectoryUrl();
    const replacement = new URL("replacement.json", replacementDirectory);
    writeFileSync(replacement, Buffer.from("synthetic replacement", "utf8"));
    const target = new URL(registered.files[0]!.fileName, directory);

    const error = captureStateError(() =>
      loadCalibrationDatasetDirectory(directory, {
        afterInitialDirectoryCheck: () => {
          renameSync(replacement, target);
        }
      })
    );

    expect(error.code).toBe("LEVELS_DATA_PRECHECK_FAILED");
    expect(error.issues).toEqual([
      { code: "LEVELS_DATA_HASH_MISMATCH", count: 1 }
    ]);
    expect(error.message).not.toContain("synthetic replacement");
  });

  it("读取完成后临时加入清单外文件会被第二次精确目录检查拒绝", () => {
    const directory = makeDirectoryUrl();
    materializeRegisteredDataset(directory);

    const error = captureStateError(() =>
      loadCalibrationDatasetDirectory(directory, {
        beforeFinalDirectoryCheck: () => {
          writeFileSync(
            new URL("unregistered.json", directory),
            "synthetic extra file",
            "utf8"
          );
        }
      })
    );

    expect(error.code).toBe("LEVELS_DATA_PRECHECK_FAILED");
    expect(error.issues).toEqual([
      { code: "LEVELS_DATA_MANIFEST_MISMATCH", count: 1 }
    ]);
    expect(error.message).not.toContain("unregistered.json");
  });

  it("读取完成后把路径换成另一个普通文件也会被最终逐字节复核拒绝", () => {
    const directory = makeDirectoryUrl();
    const registered = materializeRegisteredDataset(directory);
    const replacementDirectory = makeDirectoryUrl();
    const replacement = new URL("replacement.json", replacementDirectory);
    writeFileSync(replacement, Buffer.from("late synthetic replacement", "utf8"));
    const target = new URL(registered.files[0]!.fileName, directory);

    const error = captureStateError(() =>
      loadCalibrationDatasetDirectory(directory, {
        beforeFinalDirectoryCheck: () => {
          renameSync(replacement, target);
        }
      })
    );

    expect(error.code).toBe("LEVELS_DATA_PRECHECK_FAILED");
    expect(error.issues).toEqual([
      { code: "LEVELS_DATA_MANIFEST_MISMATCH", count: 1 }
    ]);
    expect(error.message).not.toContain("late synthetic replacement");
  });

  it("预登记清单精确绑定至少 60 题的文件、安全编号、摘要和人工等级", () => {
    const registered = registeredDataset();
    const bundle = preflightCalibrationDatasetBundle({
      manifestDocument: registered.manifestDocument,
      files: registered.files
    });
    expect(bundle.datasetId).toBe("registered-levels-v1");
    expect(bundle.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.items).toHaveLength(60);
    expect(bundle.items[0]).toMatchObject({
      safeId: "registered-001",
      humanThinkingLevel: 1,
      humanCodingLevel: 1
    });
  });

  it("清单漏文件、额外文件或改后缀都在读取题面前按固定码整体失败", () => {
    const registered = registeredDataset();
    const variants = [
      registered.files.slice(1),
      [
        ...registered.files,
        {
          fileName: "unregistered.json",
          content: Buffer.from("不能泄露的额外内容", "utf8")
        }
      ],
      registered.files.map((file, index) =>
        index === 0
          ? { ...file, fileName: file.fileName.replace(/\.json$/, ".txt") }
          : file
      )
    ];
    for (const files of variants) {
      const error = captureStateError(() =>
        preflightCalibrationDatasetBundle({
          manifestDocument: registered.manifestDocument,
          files
        })
      );
      expect(error.issues).toEqual([
        { code: "LEVELS_DATA_MANIFEST_MISMATCH", count: 1 }
      ]);
      expect(error.message).not.toContain("unregistered.json");
      expect(error.message).not.toContain("额外内容");
    }
  });

  it("文件内容或清单安全编号变化都不能绕过预登记绑定", () => {
    const registered = registeredDataset();
    const changedFiles = registered.files.map((file, index) =>
      index === 0
        ? { ...file, content: Buffer.concat([file.content, Buffer.from(" ")]) }
        : file
    );
    const hashError = captureStateError(() =>
      preflightCalibrationDatasetBundle({
        manifestDocument: registered.manifestDocument,
        files: changedFiles
      })
    );
    expect(hashError.issues).toEqual([
      { code: "LEVELS_DATA_HASH_MISMATCH", count: 1 }
    ]);

    const changedManifest = {
      ...registered.manifest,
      entries: registered.manifest.entries.map((entry, index) =>
        index === 0 ? { ...entry, safeId: "different-safe-id" } : entry
      )
    };
    const idError = captureStateError(() =>
      preflightCalibrationDatasetBundle({
        manifestDocument: JSON.stringify(changedManifest),
        files: registered.files
      })
    );
    expect(idError.issues).toEqual([
      { code: "LEVELS_DATA_MANIFEST_MISMATCH", count: 1 }
    ]);
  });

  it("少于 60 题的预登记清单在任何付费阶段前失败", () => {
    const registered = registeredDataset(59);
    const error = captureStateError(() =>
      preflightCalibrationDatasetBundle({
        manifestDocument: registered.manifestDocument,
        files: registered.files
      })
    );
    expect(error.issues).toEqual([
      { code: "LEVELS_DATA_MINIMUM_NOT_MET", count: 1 }
    ]);
  });

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
  it("同一来源不能派生 A、B 两个标签，跨标签检查点复制在开始前一律拒绝", () => {
    const createModels = vi.fn();
    const copyCheckpoint = vi.fn();
    const runThinking = vi.fn();
    const runCoding = vi.fn();
    const attemptBranch = (label: string): LevelsCalibrationStateError =>
      captureStateError(() => {
        assertLevelsResumeModeSupported({
          label,
          resumeFromLabel: "clean-ancestor"
        });
        createModels();
        copyCheckpoint();
        runThinking();
        runCoding();
      });
    for (const label of ["branch-a", "branch-b"]) {
      expect(attemptBranch(label).code).toBe(
        "LEVELS_CROSS_LABEL_RESUME_UNSUPPORTED"
      );
    }
    expect(createModels).not.toHaveBeenCalled();
    expect(copyCheckpoint).not.toHaveBeenCalled();
    expect(runThinking).not.toHaveBeenCalled();
    expect(runCoding).not.toHaveBeenCalled();
    expect(() =>
      assertLevelsResumeModeSupported({
        label: "same-chain",
        resumeFromLabel: "same-chain"
      })
    ).not.toThrow();
    expect(() =>
      assertLevelsResumeModeSupported({
        label: "fresh-chain",
        resumeFromLabel: null
      })
    ).not.toThrow();
  });

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
      datasetManifestHash,
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
      datasetManifestHash,
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

  it("实验摘要缺少预登记清单哈希时关闭失败，不退化为只哈希题目内容", () => {
    const error = captureStateError(() =>
      buildLevelsExperimentFingerprint({
        dataset: [item()],
        datasetManifestHash: undefined as unknown as string,
        experimentVersion: "experiment-test",
        profileName: "review-balanced",
        profile: { model: "test" },
        runConfiguration: runConfiguration(),
        pipelineSources: { runner: "source" },
        calibrationProtocol: { bandBoundaries: [1400, 2200] }
      })
    );
    expect(error.code).toBe("LEVELS_FINGERPRINT_BUILD_FAILED");
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
      chainRunId: checkpointChainRunId,
      fingerprint: currentFingerprint,
      progress: [progress(dataset[0]!)],
      activeStages: [],
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

  it("第 4 版检查点可以只保存思维阶段，并在恢复后继续保留严格信号", () => {
    const directory = makeDirectoryUrl();
    const dataset = [item()];
    const currentFingerprint = fingerprint(dataset);
    const complete = progress(dataset[0]!);
    const thinkingOnly: CalibrationProgress = {
      safeId: complete.safeId,
      contestId: complete.contestId,
      index: complete.index,
      rating: complete.rating,
      humanThinkingLevel: complete.humanThinkingLevel,
      humanCodingLevel: complete.humanCodingLevel,
      thinking: complete.thinking
    };
    const target = checkpointUrl(directory, "source");
    writeCalibrationCheckpoint({
      target,
      label: "source",
      profileName: "review-balanced",
      chainRunId: checkpointChainRunId,
      fingerprint: currentFingerprint,
      progress: [thinkingOnly],
      activeStages: [],
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
      readonly chainRunId: string;
    };
    expect(serialized.schemaVersion).toBe(4);
    const restored = loadCalibrationCheckpoint({
      source: target,
      expectedLabel: "source",
      expectedProfileName: "review-balanced",
      expectedFingerprint: currentFingerprint,
      expectedItems: dataset
    });
    expect(restored).toEqual({
      chainRunId: serialized.chainRunId,
      progress: [thinkingOnly],
      activeStages: [],
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

  it("检查点写入不能省略实验链 UUID 或 activeStages", () => {
    const directory = makeDirectoryUrl();
    const dataset = [item()];
    const currentFingerprint = fingerprint(dataset);
    const base = {
      target: checkpointUrl(directory, "required-metadata"),
      label: "required-metadata",
      profileName: "review-balanced",
      chainRunId: checkpointChainRunId,
      fingerprint: currentFingerprint,
      progress: [],
      activeStages: [],
      failureCounts: []
    };
    const { chainRunId: _missingChainRunId, ...withoutChainRunId } = base;
    const { activeStages: _missingActiveStages, ...withoutActiveStages } = base;
    for (const candidate of [withoutChainRunId, withoutActiveStages]) {
      expect(
        captureStateError(() =>
          writeCalibrationCheckpoint(
            candidate as unknown as Parameters<
              typeof writeCalibrationCheckpoint
            >[0]
          )
        ).code
      ).toBe("LEVELS_CHECKPOINT_INVALID");
    }
  });

  it("续跑把异常退出遗留的 active 阶段固化为 STALE_IN_FLIGHT 且不再保留在途状态", () => {
    const directory = makeDirectoryUrl();
    const dataset = [item()];
    const currentFingerprint = fingerprint(dataset);
    const target = checkpointUrl(directory, "stale");
    writeCalibrationCheckpoint({
      target,
      label: "stale",
      profileName: "review-balanced",
      chainRunId: checkpointChainRunId,
      fingerprint: currentFingerprint,
      progress: [],
      activeStages: [
        { safeId: dataset[0]!.safeId, stage: "thinking" }
      ],
      failureCounts: []
    });
    const restored = loadCalibrationCheckpoint({
      source: target,
      expectedLabel: "stale",
      expectedProfileName: "review-balanced",
      expectedFingerprint: currentFingerprint,
      expectedItems: dataset
    });
    expect(restored.activeStages).toEqual([]);
    expect(restored.failureCounts).toEqual([
      {
        stage: "thinking",
        errorCode: "STALE_IN_FLIGHT",
        status: null,
        count: 1
      }
    ]);
  });

  it("第 4 版检查点不再接受旧的笼统模型错误码", () => {
    const directory = makeDirectoryUrl();
    const dataset = [item()];
    const currentFingerprint = fingerprint(dataset);
    const target = checkpointUrl(directory, "legacy-errors");
    writeCalibrationCheckpoint({
      target,
      label: "legacy-errors",
      profileName: "review-balanced",
      chainRunId: checkpointChainRunId,
      fingerprint: currentFingerprint,
      progress: [],
      activeStages: [],
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

    expect(
      captureStateError(() =>
        loadCalibrationCheckpoint({
          source: target,
          expectedLabel: "legacy-errors",
          expectedProfileName: "review-balanced",
          expectedFingerprint: currentFingerprint,
          expectedItems: dataset
        })
      ).code
    ).toBe("LEVELS_CHECKPOINT_INVALID");
  });

  it("第 3 版和其它旧数字版本都明确拒绝续跑，缺失版本仍按格式错误处理", () => {
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
    for (const schemaVersion of [2, 3, 5]) {
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
        schemaVersion: "4",
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
      chainRunId: checkpointChainRunId,
      fingerprint: oldFingerprint,
      progress: [progress(dataset[0]!)],
      activeStages: [],
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
      chainRunId: checkpointChainRunId,
      fingerprint: fingerprint(dataset),
      progress: [progress(dataset[0]!)],
      activeStages: [],
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
        chainRunId: checkpointChainRunId,
        fingerprint: currentFingerprint,
        progress: [candidate],
        activeStages: [],
        failureCounts: noFailures
      });
    expect(
      captureStateError(() =>
        write({
          safeId: dataset[0]!.safeId,
          contestId: dataset[0]!.contestId,
          index: dataset[0]!.index,
          rating: dataset[0]!.rating,
          humanThinkingLevel: dataset[0]!.humanThinkingLevel,
          humanCodingLevel: dataset[0]!.humanCodingLevel
        })
      ).code
    ).toBe("LEVELS_CHECKPOINT_INVALID");
    const complete = progress(dataset[0]!);
    expect(
      captureStateError(() =>
        write({
          safeId: complete.safeId,
          contestId: complete.contestId,
          index: complete.index,
          rating: complete.rating,
          humanThinkingLevel: complete.humanThinkingLevel,
          humanCodingLevel: complete.humanCodingLevel,
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
          chainRunId: checkpointChainRunId,
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
          activeStages: [],
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
          chainRunId: checkpointChainRunId,
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
          activeStages: [],
          failureCounts: noFailures
        })
      ).code
    ).toBe("LEVELS_CHECKPOINT_INVALID");

    writeCalibrationCheckpoint({
      target,
      label: "levels",
      profileName: "review-balanced",
      chainRunId: checkpointChainRunId,
      fingerprint: currentFingerprint,
      progress: [complete],
      activeStages: [],
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
        chainRunId: checkpointChainRunId,
        fingerprint: currentFingerprint,
        progress: [
          {
            ...progress(dataset[0]!),
            coding: { level, signals }
          } as unknown as CalibrationProgress
        ],
        activeStages: [],
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
        chainRunId: checkpointChainRunId,
        fingerprint: currentFingerprint,
        progress: [],
        activeStages: [],
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
      "LLM_STREAM_INTERRUPTED",
      "LLM_CANCELLED",
      "LLM_OUTPUT_LENGTH_LIMIT",
      "LLM_OUTPUT_CONTENT_FILTERED",
      "HISTORICAL_SKIP",
      "STALE_IN_FLIGHT"
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
      chainRunId: checkpointChainRunId,
      fingerprint: currentFingerprint,
      progress: [progress(dataset[0]!)],
      activeStages: [],
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

  it("同标签每次执行用唯一编号保留报告、摘要和最后写入的成对完成标记", () => {
    const directory = makeDirectoryUrl();
    const executionRunId = "11111111-1111-4111-8111-111111111111";
    const artifacts = writeCalibrationReportArtifacts({
      resultsDirectory: directory,
      label: "same-label",
      executionRunId,
      markdown: "安全报告\n",
      summary: { complete: false }
    });
    const completion = JSON.parse(
      readFileSync(new URL(artifacts.completionFileName, directory), "utf8")
    ) as {
      report: { fileName: string; sha256: string };
      summary: { fileName: string; sha256: string };
    };
    expect(completion.report.fileName).toBe(artifacts.reportFileName);
    expect(completion.summary.fileName).toBe(artifacts.summaryFileName);
    expect(completion.report.sha256).toBe(
      createHash("sha256").update("安全报告\n", "utf8").digest("hex")
    );
    expect(
      captureStateError(() =>
        writeCalibrationReportArtifacts({
          resultsDirectory: directory,
          label: "same-label",
          executionRunId,
          markdown: "不得覆盖",
          summary: { complete: true }
        })
      ).code
    ).toBe("LEVELS_REPORT_RUN_ALREADY_USED");
    expect(
      readFileSync(new URL(artifacts.reportFileName, directory), "utf8")
    ).toBe("安全报告\n");
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

  it("resume-from 来源仍在运行时使用独立固定错误码阻断", () => {
    const directory = makeDirectoryUrl();
    const source = acquireLevelsLabelLock(directory, "source-running");
    try {
      expect(
        captureStateError(() =>
          acquireLevelsResumeSourceLock(directory, "source-running")
        ).code
      ).toBe("LEVELS_RESUME_SOURCE_LOCKED");
    } finally {
      expect(source.release()).toBe(true);
    }
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
import { createHash } from "node:crypto";
