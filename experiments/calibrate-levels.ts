/**
 * 思维难度 / 代码难度的标定实验。
 *
 * 背景：CF 难度有官方 rating 当基准，但思维难度、代码难度（1-5 级）没有外部
 * 标准答案。本脚本用一个跨难度的标定集做两件事：
 *   1. 把每一级的文字锚点定义固化进报告（评审时人人按同一把尺子）；
 *   2. 在标定集上真实跑 thinking / coding 两条流水线，检验“官方 rating 越高，
 *      两个等级的输出趋势是否单调上升”，并给出映射表是否需要调整的结论。
 *
 * 数据要求：experiments/data/levels/ 下的题目 JSON 必须带 editorial（标准题解），
 * 思维流水线要用它对比模型的解题思路。用下面命令抽标定集：
 *   DATA_SUBDIR=levels SAMPLE_SIZE_PER_BUCKET=1 npm run experiment:fetch-hf-dataset
 *
 * 用法：
 *   npm run experiment:calibrate-levels -- --label=v1
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { getProviderCredentials, loadConfig, type ProfileConfig } from "../src/config";
import { logError, logInfo, logWarn } from "../src/logger";
import { runCodingPipeline } from "../src/pipelines/coding";
import { runThinkingPipeline } from "../src/pipelines/thinking";
import type { PipelineModelConfig, ReviewTaskProblem } from "../src/pipelines/types";
import { resolveLevelsCalibrationOptions } from "./lib/levels-calibration-options";
import {
  buildLevelsCalibrationReport,
  levelAnchorDefinitions
} from "./lib/levels-calibration-report";
import {
  runLevelsCalibrationStages,
  selectCodingCalibrationResult,
  selectThinkingCalibrationResult
} from "./lib/levels-calibration-runner";
import {
  LEVEL_BAND_BOUNDARIES,
  LevelsCalibrationStateError,
  acquireLevelsLabelLock,
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
  writeTextAtomically,
  type CalibrationCheckpointState,
  type CalibrationDatasetItem,
  type LevelsExperimentFingerprint
} from "./lib/levels-calibration-state";

const DATA_DIR = new URL("./data/levels/", import.meta.url);
const RESULTS_DIR = new URL("./results/", import.meta.url);
const RAW_DIR = new URL("./results/raw/", import.meta.url);
const PIPELINE_SOURCE_FILES = {
  calibrationEntry: new URL("./calibrate-levels.ts", import.meta.url),
  configLoader: new URL("../src/config.ts", import.meta.url),
  yamlParser: new URL("../src/yaml-lite.ts", import.meta.url),
  thinking: new URL("../src/pipelines/thinking.ts", import.meta.url),
  coding: new URL("../src/pipelines/coding.ts", import.meta.url),
  sharedTypes: new URL("../src/pipelines/types.ts", import.meta.url),
  llmClient: new URL("../src/llm.ts", import.meta.url),
  logger: new URL("../src/logger.ts", import.meta.url),
  concurrency: new URL("./lib/concurrency.ts", import.meta.url),
  calibrationOptions: new URL("./lib/levels-calibration-options.ts", import.meta.url),
  calibrationState: new URL("./lib/levels-calibration-state.ts", import.meta.url),
  calibrationRunner: new URL(
    "./lib/levels-calibration-runner.ts",
    import.meta.url
  ),
  calibrationReport: new URL(
    "./lib/levels-calibration-report.ts",
    import.meta.url
  )
} as const;

function loadCalibrationSet(): CalibrationDatasetItem[] {
  let fileNames: string[];
  try {
    fileNames = readdirSync(DATA_DIR)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_DATA_DIRECTORY_UNREADABLE");
  }
  let documents: string[];
  try {
    documents = fileNames.map((fileName) =>
      readFileSync(new URL(fileName, DATA_DIR), "utf8")
    );
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_DATA_READ_FAILED");
  }
  return preflightCalibrationDocuments(documents);
}

function toProblem(item: CalibrationDatasetItem): ReviewTaskProblem {
  return {
    id: `calibration-${item.contestId}${item.index}`,
    revision: 1,
    reviewRound: 1,
    contentHash: createHash("sha256").update(item.statement, "utf8").digest("hex"),
    title: `CF${item.contestId}${item.index}`,
    type: "traditional",
    tagIds: ["calibration.sample"],
    basicStatement: item.statement,
    basicSolution: item.editorial
  };
}

function writeCheckpoint(
  label: string,
  profileName: string,
  fingerprint: LevelsExperimentFingerprint,
  state: CalibrationCheckpointState
): void {
  writeCalibrationCheckpoint({
    target: checkpointUrl(RAW_DIR, label),
    label,
    profileName,
    fingerprint,
    progress: state.progress,
    failureCounts: state.failureCounts
  });
}

async function main(): Promise<void> {
  const config = loadConfig({ env: process.env });
  const options = resolveLevelsCalibrationOptions({
    argv: process.argv.slice(2),
    env: process.env,
    configuredOutputIdleTimeoutMs:
      config.models.timeouts.llmOutputIdleMs,
    configuredFirstOutputTimeoutMs:
      config.models.timeouts.llmFirstOutputMs,
    configuredMaximumDurationMs:
      config.models.timeouts.llmMaximumDurationMs,
    configuredMaxAttempts: config.models.retry.maxAttempts
  });
  const label = options.label;
  const profileName = config.models.defaults.modelProfileName;
  const profiles: Record<string, ProfileConfig | undefined> = config.models.profiles;
  const profile = profiles[profileName];
  if (profile === undefined) {
    logError("默认模型档位不存在", undefined, { profileName });
    process.exitCode = 1;
    return;
  }

  const modelFor = (part: "solver" | "analyst" | "coding"): PipelineModelConfig | undefined => {
    const spec =
      part === "coding" ? profile.coding : part === "solver" ? profile.thinking.solver : profile.thinking.analyst;
    const credentials = getProviderCredentials(config, spec.provider);
    if (credentials === undefined) {
      logError("流水线的服务商没有配置密钥", undefined, { part, provider: spec.provider });
      return undefined;
    }
    return {
      spec,
      credentials,
      runtime: {
        outputIdleTimeoutMs: options.outputIdleTimeoutMs,
        firstOutputTimeoutMs: options.firstOutputTimeoutMs,
        maximumDurationMs: options.maximumDurationMs,
        maxAttempts: options.maxAttempts,
        baseDelayMs: config.models.retry.baseDelayMs
      }
    };
  };
  const solverModel = modelFor("solver");
  const analystModel = modelFor("analyst");
  const codingModel = modelFor("coding");
  if (solverModel === undefined || analystModel === undefined || codingModel === undefined) {
    process.exitCode = 1;
    return;
  }
  const runConfiguration = buildLevelsRunConfiguration({
    solverBaseUrl: solverModel.credentials.baseUrl,
    analystBaseUrl: analystModel.credentials.baseUrl,
    codingBaseUrl: codingModel.credentials.baseUrl,
    outputIdleTimeoutMs: options.outputIdleTimeoutMs,
    firstOutputTimeoutMs: options.firstOutputTimeoutMs,
    maximumDurationMs: options.maximumDurationMs,
    maxAttempts: options.maxAttempts,
    baseDelayMs: config.models.retry.baseDelayMs,
    concurrency: options.concurrency
  });
  const reportRunConfiguration = buildLevelsReportRunConfiguration({
    runConfiguration,
    providerNames: {
      solver: solverModel.spec.provider,
      analyst: analystModel.spec.provider,
      coding: codingModel.spec.provider
    }
  });

  const calibrationSet = loadCalibrationSet();
  let pipelineSources: Record<string, string>;
  try {
    pipelineSources = Object.fromEntries(
      Object.entries(PIPELINE_SOURCE_FILES).map(([name, source]) => [
        name,
        readFileSync(source, "utf8")
      ] as const)
    );
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_PIPELINE_SOURCE_READ_FAILED");
  }
  const fingerprint = buildLevelsExperimentFingerprint({
    dataset: calibrationSet,
    experimentVersion: config.models.experimentVersion,
    profileName,
    profile,
    runConfiguration,
    pipelineSources,
    calibrationProtocol: {
      bandBoundaries: LEVEL_BAND_BOUNDARIES,
      levelAnchorDefinitions
    }
  });
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    mkdirSync(RAW_DIR, { recursive: true });
  } catch {
    throw new LevelsCalibrationStateError("LEVELS_OUTPUT_DIRECTORY_FAILED");
  }

  const labelLock = acquireLevelsLabelLock(RAW_DIR, label);
  try {
    if (options.resumeFromLabel !== label) {
      assertCalibrationLabelUnused({
        label,
        rawDirectory: RAW_DIR,
        resultsDirectory: RESULTS_DIR
      });
    }
    const resumedState: CalibrationCheckpointState =
      options.resumeFromLabel === null
        ? { progress: [], failureCounts: [] }
        : loadCalibrationCheckpoint({
            source: checkpointUrl(RAW_DIR, options.resumeFromLabel),
            expectedLabel: options.resumeFromLabel,
            expectedProfileName: profileName,
            expectedFingerprint: fingerprint,
            expectedItems: calibrationSet
          });
    const resumedRows = completeCalibrationRows(resumedState.progress);
    const resumedThinkingProblemCount = resumedState.progress.filter(
      (progress) => progress.thinking !== undefined
    ).length;
    const pendingProblemCount =
      calibrationSet.length - resumedRows.length;
    writeCheckpoint(label, profileName, fingerprint, resumedState);

    logInfo("开始标定", {
      label,
      problems: calibrationSet.length,
      reusedProblems: resumedRows.length,
      reusedThinkingProblems: resumedThinkingProblemCount,
      pendingProblems: pendingProblemCount,
      profileName,
      outputIdleTimeoutMs: runConfiguration.outputIdleTimeoutMs,
      firstOutputTimeoutMs: runConfiguration.firstOutputTimeoutMs,
      maximumDurationMs: runConfiguration.maximumDurationMs,
      maxAttempts: runConfiguration.maxAttempts,
      baseDelayMs: runConfiguration.baseDelayMs,
      concurrency: runConfiguration.concurrency
    });

    const runResult = await runLevelsCalibrationStages({
      items: calibrationSet,
      concurrency: runConfiguration.concurrency,
      initialState: resumedState,
      runThinking: async (item) => {
        const problem = toProblem(item);
        const thinking = await runThinkingPipeline({
          problem,
          solverModel,
          analystModel
        });
        return selectThinkingCalibrationResult(thinking);
      },
      runCoding: async (item) => {
        const problem = toProblem(item);
        const coding = await runCodingPipeline({
          problem,
          model: codingModel
        });
        return selectCodingCalibrationResult(coding);
      },
      saveCheckpoint: (state) => {
        writeCheckpoint(label, profileName, fingerprint, state);
      },
      onStageCompleted: (event) => {
        logInfo("标定阶段完成", {
          contestId: event.contestId,
          index: event.index,
          rating: event.rating,
          stage: event.stage,
          level: event.level,
          progress: `${event.fullyCompletedProblemCount}/${event.expectedProblemCount}`
        });
      },
      onStageFailed: (event) => {
        logWarn("标定阶段失败，稍后可续跑", {
          contestId: event.contestId,
          index: event.index,
          rating: event.rating,
          stage: event.stage,
          errorCode: event.errorCode,
          status: event.status,
          progress: `${event.fullyCompletedProblemCount}/${event.expectedProblemCount}`
        });
      }
    });

    const generatedAt = new Date().toISOString();
    const stamp = generatedAt.replace(/[:.]/g, "-");
    writeCalibrationCheckpoint({
      target: new URL(`levels-${label}-${stamp}.json`, RAW_DIR),
      label,
      profileName,
      fingerprint,
      progress: runResult.progress,
      failureCounts: runResult.failureCounts
    });
    const report = buildLevelsCalibrationReport({
      label,
      profileName,
      fingerprint,
      runConfiguration: reportRunConfiguration,
      progress: runResult.progress,
      failureCounts: runResult.failureCounts,
      expectedProblemCount: calibrationSet.length,
      resumedThinkingProblemCount,
      resumedCompleteProblemCount: resumedRows.length,
      completedProblemsThisRun: runResult.completedProblemsThisRun,
      generatedAt
    });
    writeTextAtomically(
      new URL(`levels-${label}-report.md`, RESULTS_DIR),
      report.markdown
    );
    writeJsonAtomically(
      new URL(`levels-${label}-summary.json`, RESULTS_DIR),
      report.summary
    );

    if (!report.summary.complete) {
      logWarn("标定结果不完整，报告仅供续跑定位，不能用于调整算法", {
        label,
        problems: report.summary.problemCount,
        thinkingProblems: report.summary.thinkingCompletedProblemCount,
        expectedProblems: calibrationSet.length,
        incompleteProblemCount: report.summary.incompleteProblemCount,
        missingBands: report.summary.missingBands.join(",")
      });
      process.exitCode = 1;
      return;
    }
    logInfo("标定完成", {
      label,
      problems: report.summary.problemCount,
      monotonicThinking: report.summary.monotonicThinking,
      monotonicCoding: report.summary.monotonicCoding
    });
  } finally {
    if (!labelLock.release()) {
      logError("标定任务运行锁清理失败", {
        code: "LEVELS_LOCK_FAILED"
      });
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  const inputIssues =
    error instanceof LevelsCalibrationStateError && error.issues.length > 0
      ? error.issues.map((issue) => `${issue.code}:${issue.count}`).join(",")
      : undefined;
  logError("experiments/calibrate-levels.ts 执行失败", error, { inputIssues });
  process.exitCode = 1;
});
