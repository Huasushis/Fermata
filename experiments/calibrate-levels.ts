/**
 * 思维难度 / 代码难度的标定实验。
 *
 * 背景：CF 难度有官方 rating 当基准，但思维难度、代码难度（1-5 级）没有外部
 * 标准答案。本脚本用一个跨难度的标定集做两件事：
 *   1. 把每一级的文字锚点定义固化进报告（评审时人人按同一把尺子）；
 *   2. 在标定集上真实跑 thinking / coding 两条流水线，检验“官方 rating 越高，
 *      两个等级的输出趋势是否单调上升”，并给出映射表是否需要调整的结论。
 *
 * 数据要求：experiments/data/levels/ 下的题目 JSON 必须带 editorial（标准题解）、
 * 人工确认的 humanThinkingLevel 和 humanCodingLevel。下面命令只能抓取候选题目，
 * 不会产生这两项人工标准，也不会生成 manifest.private.json：
 *   DATA_SUBDIR=levels SAMPLE_SIZE_PER_BUCKET=1 npm run experiment:fetch-hf-dataset
 * 抓取后必须人工标注至少 60 题并生成逐文件哈希清单，预检通过后才能付费标定。
 *
 * 用法：
 *   npm run experiment:calibrate-levels -- --label=v1
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { getProviderCredentials, loadConfig, type ProfileConfig } from "../src/config";
import { logError, logInfo, logWarn } from "../src/logger";
import { runCodingPipeline } from "../src/pipelines/coding";
import { runThinkingPipeline } from "../src/pipelines/thinking";
import type { PipelineModelConfig } from "../src/pipelines/types";
import { resolveLevelsCalibrationOptions } from "./lib/levels-calibration-options";
import {
  buildLevelsCalibrationReport,
  levelAnchorDefinitions
} from "./lib/levels-calibration-report";
import {
  buildLevelsBlindGold,
  buildLevelsBlindContent,
  runLevelsCalibrationStages,
  selectCodingCalibrationResult,
  selectThinkingCalibrationResult
} from "./lib/levels-calibration-runner";
import {
  LEVEL_BAND_BOUNDARIES,
  LevelsCalibrationStateError,
  acquireLevelsLabelLock,
  assertLevelsResumeModeSupported,
  assertCalibrationLabelUnused,
  buildLevelsExperimentFingerprint,
  buildLevelsReportRunConfiguration,
  buildLevelsRunConfiguration,
  checkpointUrl,
  countCompleteBlindCalibrationProgress,
  joinBlindCalibrationProgressWithGold,
  loadCalibrationDatasetDirectory,
  loadCalibrationCheckpoint,
  writeCalibrationCheckpoint,
  writeCalibrationReportArtifacts,
  type CalibrationCheckpointState,
  type CalibrationDatasetBundle,
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
  urmotivSchemas: new URL("../src/urmotiv-schemas.ts", import.meta.url),
  llmClient: new URL("../src/llm.ts", import.meta.url),
  logger: new URL("../src/logger.ts", import.meta.url),
  concurrency: new URL("./lib/concurrency.ts", import.meta.url),
  blindEvaluation: new URL("./lib/blind-evaluation.ts", import.meta.url),
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

function loadCalibrationSet(): CalibrationDatasetBundle {
  return loadCalibrationDatasetDirectory(DATA_DIR);
}

function writeCheckpoint(
  label: string,
  profileName: string,
  chainRunId: string,
  fingerprint: LevelsExperimentFingerprint,
  state: CalibrationCheckpointState
): void {
  writeCalibrationCheckpoint({
    target: checkpointUrl(RAW_DIR, label),
    label,
    profileName,
    chainRunId,
    fingerprint,
    progress: state.progress,
    activeStages: state.activeStages,
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
  assertLevelsResumeModeSupported({
    label: options.label,
    resumeFromLabel: options.resumeFromLabel
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

  const calibrationBundle = loadCalibrationSet();
  const calibrationSet = calibrationBundle.items;
  // 当前 levels 集已经参与过调参，只能作为 development 使用。先投影成内容侧，
  // 后续 runThinking/runCoding 的函数参数不再含 rating 或人工等级。
  const blindContent = buildLevelsBlindContent({
    datasetId: calibrationBundle.datasetId,
    purpose: "development",
    items: calibrationSet
  });
  const blindGold = buildLevelsBlindGold({
    content: blindContent,
    items: calibrationSet
  });
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
    datasetManifestHash: calibrationBundle.manifestHash,
    experimentVersion: config.models.experimentVersion,
    profileName,
    profile,
    runConfiguration,
    pipelineSources,
    calibrationProtocol: {
      datasetPurpose: blindContent.purpose,
      blindContentFingerprint: blindContent.contentFingerprint,
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
    const resumedState =
      options.resumeFromLabel === null
        ? {
            chainRunId: randomUUID(),
            progress: [],
            failureCounts: [],
            activeStages: []
          }
        : loadCalibrationCheckpoint({
            source: checkpointUrl(RAW_DIR, options.resumeFromLabel),
            expectedLabel: options.resumeFromLabel,
            expectedProfileName: profileName,
            expectedFingerprint: fingerprint,
            expectedContent: blindContent
          });
    const resumedCompleteProblemCount = countCompleteBlindCalibrationProgress(
      resumedState.progress
    );
    const resumedThinkingProblemCount = resumedState.progress.filter(
      (progress) => progress.thinking !== undefined
    ).length;
    const pendingProblemCount =
      calibrationSet.length - resumedCompleteProblemCount;
    writeCheckpoint(
      label,
      profileName,
      resumedState.chainRunId,
      fingerprint,
      resumedState
    );

    logInfo("开始标定", {
      label,
      problems: calibrationSet.length,
      reusedProblems: resumedCompleteProblemCount,
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
      blindContent,
      concurrency: runConfiguration.concurrency,
      initialState: resumedState,
      runThinking: async (item) => {
        const thinking = await runThinkingPipeline({
          problem: item.problem,
          solverModel,
          analystModel
        });
        return selectThinkingCalibrationResult(thinking);
      },
      runCoding: async (item) => {
        const coding = await runCodingPipeline({
          problem: item.problem,
          model: codingModel
        });
        return selectCodingCalibrationResult(coding);
      },
      saveCheckpoint: (state) => {
        writeCheckpoint(
          label,
          profileName,
          resumedState.chainRunId,
          fingerprint,
          state
        );
      },
      onStageCompleted: (event) => {
        logInfo("标定阶段完成", {
          safeId: event.safeId,
          stage: event.stage,
          level: event.level,
          progress: `${event.fullyCompletedProblemCount}/${event.expectedProblemCount}`
        });
      },
      onStageFailed: (event) => {
        logWarn("标定阶段失败，本链停止发起新的付费阶段", {
          safeId: event.safeId,
          stage: event.stage,
          errorCode: event.errorCode,
          status: event.status,
          progress: `${event.fullyCompletedProblemCount}/${event.expectedProblemCount}`
        });
      }
    });

    const generatedAt = new Date().toISOString();
    const executionRunId = randomUUID();
    writeCalibrationCheckpoint({
      target: new URL(
        `levels-${label}-${executionRunId}-snapshot.json`,
        RAW_DIR
      ),
      label,
      profileName,
      chainRunId: resumedState.chainRunId,
      fingerprint,
      progress: runResult.progress,
      activeStages: runResult.activeStages,
      failureCounts: runResult.failureCounts
    });
    // runLevelsCalibrationStages 已等待全部在途阶段收束；从这一行开始才允许连接 gold。
    const scoredProgress = joinBlindCalibrationProgressWithGold({
      content: blindContent,
      gold: blindGold,
      progress: runResult.progress
    });
    const report = buildLevelsCalibrationReport({
      label,
      datasetId: calibrationBundle.datasetId,
      chainRunId: resumedState.chainRunId,
      executionRunId,
      profileName,
      fingerprint,
      runConfiguration: reportRunConfiguration,
      progress: scoredProgress,
      failureCounts: runResult.failureCounts,
      activeStages: runResult.activeStages,
      expectedProblemCount: calibrationSet.length,
      resumedThinkingProblemCount,
      resumedCompleteProblemCount,
      completedProblemsThisRun: runResult.completedProblemsThisRun,
      generatedAt
    });
    writeCalibrationReportArtifacts({
      resultsDirectory: RESULTS_DIR,
      label,
      executionRunId,
      markdown: report.markdown,
      summary: report.summary
    });

    if (!report.summary.eligible) {
      logWarn("标定结果不合格，报告只作为本次实验的保留证据", {
        label,
        problems: report.summary.problemCount,
        thinkingProblems: report.summary.thinkingCompletedProblemCount,
        expectedProblems: calibrationSet.length,
        incompleteProblemCount: report.summary.incompleteProblemCount,
        missingBands: report.summary.missingBands.join(","),
        operationalComplete: report.summary.operationalComplete,
        integrityClean: report.summary.integrityClean,
        accuracyPassed: report.summary.accuracyPassed
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
