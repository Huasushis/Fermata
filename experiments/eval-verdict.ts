/**
 * 综合评审（verdict）流水线的判定实验。
 *
 * 正常组不注入相似度警告，期望结论不是 reject；构造原题组注入一条高于
 * config/models.yaml#thresholds.duplicateSimilarityReject 的合成 Anklang 记录，
 * 期望“模型确认同题 + 超阈值”强制不通过。
 *
 * 所有数据文件先严格预检，再固定两组 expected 样本。任一数据文件损坏、
 * 499、取消、请求失败或结果缺失都会使 complete=false；执行完整但任一合成
 * 预期不满足则 diagnosticPassed=false。两种失败都非零退出，且互不混淆。
 * 报告使用唯一 runId 排他创建，绝不覆盖旧实验。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getProviderCredentials, loadConfig, type AppConfig, type ProfileConfig } from "../src/config";
import { logError, logInfo } from "../src/logger";
import { runVerdictPipeline } from "../src/pipelines/verdict";
import type { PipelineModelConfig } from "../src/pipelines/types";
import {
  type BlindContentDataset,
  type BlindProblemContentSample
} from "./lib/blind-evaluation";
import {
  completedEvaluationChainMarkerExists,
  createEvaluationRunId,
  executionFailure,
  hasUnknownPrefixedEnvironmentKeys,
  parseBoundedPositiveInteger,
  parseEvaluationCodeVersion,
  parseEvaluationLabel,
  reconcileEvaluation,
  writeEvaluationReportArtifactGroup,
  type EvaluationReportArtifactGroup,
  type EvaluationCompleteness,
  type EvaluationFailure
} from "./lib/evaluation-integrity";
import {
  loadEvaluationCodeIdentity,
  verdictEvaluationCodePaths,
  type EvaluationCodeIdentity
} from "./lib/evaluation-code-identity";
import {
  LevelsCalibrationStateError,
  loadCalibrationDatasetDirectory,
  type CalibrationDatasetBundle
} from "./lib/levels-calibration-state";
import { buildLevelsBlindContent } from "./lib/levels-calibration-runner";
import { difficultyProviderIdentityFingerprint } from "./lib/difficulty-evaluation-eligibility";
import {
  assessVerdictSyntheticDiagnostic,
  buildFabricatedSimilarityItem,
  buildPairedVerdictCasePlan,
  buildVerdictCaseGoldDataset,
  runVerdictBlindCaseBatch,
  scoreVerdictBlindPredictions,
  selectVerdictContentOnlyItems,
  verdictCaseFingerprint,
  verdictInferenceConfigurationFingerprint,
  verdictPredictionLogFields,
  verdictReportConfigurationFingerprint,
  type PairedVerdictCase,
  type PairedVerdictCasePlan,
  type VerdictBlindPrediction,
  type VerdictBlindPredictionRecord,
  type VerdictCaseGoldDataset,
  type VerdictDiagnosticCaseKind
} from "./lib/verdict-evaluation-design";
import {
  continueVerdictEvaluationUnlessContaminated,
  VerdictEvaluationCheckpoint,
  type VerdictCheckpointCaseBinding
} from "./lib/verdict-evaluation-checkpoint";

const DATA_DIR = new URL("./data/levels/", import.meta.url);
const RESULTS_DIR = new URL("./results/", import.meta.url);
const RAW_DIR = new URL("./results/raw/", import.meta.url);
const MODELS_CONFIG_FILE = new URL("../config/models.yaml", import.meta.url);
const REPOSITORY_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const RUNNER_REPOSITORY_PATH = "experiments/eval-verdict.ts";

const SYNTHETIC_UPSTREAM_DIFFICULTY = 1800;
const VERDICT_CONTENT_SELECTION_SEED = "verdict-content-selection-v1";

interface CaseResult {
  readonly sampleId: string;
  readonly caseKind: VerdictDiagnosticCaseKind;
  readonly problemLabel: string;
  readonly rating: number;
  readonly verdict: string;
  readonly forcedDuplicateReject: boolean;
  readonly highestKnownSimilarity: number;
  readonly appliedDuplicateSimilarityRejectThreshold: number;
  readonly expectationMet: boolean;
}

interface VerdictReport {
  readonly schemaVersion: 4;
  readonly runId: string;
  readonly label: string;
  readonly generatedAt: string;
  readonly codeVersion: string | null;
  readonly runnerSha256: string | null;
  readonly dependencyCodeSha256: string | null;
  readonly dependencyFileCount: number | null;
  readonly modelsConfigSha256: string | null;
  readonly configuration: null | {
    readonly experimentVersion: string;
    readonly modelProfileName: string;
    readonly duplicateSimilarityRejectThreshold: number;
    readonly fabricatedSimilarity: number;
    readonly concurrency: number;
    readonly casesPerGroup: number;
    readonly providerIdentityFingerprint: string;
    readonly contentSelectionSeed: string;
    readonly caseFingerprint: string;
    readonly caseGoldFingerprint: string;
    /** prediction-only 私有检查点绑定这一项；它不含 gold 或源 manifest 指纹。 */
    readonly inferenceFingerprint: string;
    /** 完成推理后才把 gold 指纹并入的报告身份。 */
    readonly fingerprint: string;
  };
  readonly chain: {
    readonly chainRunId: string | null;
    readonly originalReportRunId: string | null;
    readonly createdAt: string | null;
    readonly executionKind: "preflight" | "new" | "resume" | "replay_blocked";
  };
  readonly dataset: {
    readonly purpose: "development";
    readonly verifiedFiles: number;
    readonly manifestFingerprint: string | null;
    readonly selectedPairedProblems: number;
  };
  readonly integrity: EvaluationCompleteness;
  /** 与执行完整性分开：只有两组全部按预期贯通才为 true。 */
  readonly diagnosticPassed: boolean;
  /** 这里只验证合成审核条目是否按预期贯通，不是阈值或模型准确性标定。 */
  readonly syntheticDiagnostics: {
    readonly normal: { readonly total: number; readonly metExpectation: number };
    readonly fabricatedDuplicate: { readonly total: number; readonly metExpectation: number };
  };
  readonly results: readonly Omit<CaseResult, "sampleId">[];
}

function parseLabelArg(): string {
  const arg = process.argv.find((value) => value.startsWith("--label="));
  return parseEvaluationLabel(arg?.slice("--label=".length) ?? "", "v1");
}

async function inferVerdictBlindCase(input: {
  readonly diagnosticCase: PairedVerdictCase<BlindProblemContentSample>;
  readonly fabricatedSimilarity: number;
  readonly threshold: number;
  readonly model: PipelineModelConfig;
}): Promise<VerdictBlindPrediction> {
  const problem = input.diagnosticCase.item.problem;
  const reviewItems =
    input.diagnosticCase.caseKind === "fabricated_duplicate"
      ? [buildFabricatedSimilarityItem(problem, input.fabricatedSimilarity)]
      : [];
  const output = await runVerdictPipeline({
    problem,
    reviewItems,
    // verdict 接线诊断不评估难度；固定中性输入，绝不把官方 rating 当上游结果喂给模型。
    difficulty: {
      rating: SYNTHETIC_UPSTREAM_DIFFICULTY,
      confidence: 0.5,
      rationale: "合成接线诊断的固定输入，不使用数据集难度答案。"
    },
    thinking: {
      level: 3,
      signals: {
        solved: true,
        approachSimilarity: 0.6,
        selfCorrections: 1,
        keyInsightCount: 2
      },
      solverNarrativeLength: 600,
      rationale: "实验固定输入。"
    },
    coding: {
      level: 3,
      signals: {
        effectiveLineCount: 60,
        maxNestingDepth: 3,
        detectedDataStructures: [],
        maxDataStructureWeight: 0
      },
      referenceCodeLength: 1500
    },
    expectedRound: 1,
    duplicateSimilarityRejectThreshold: input.threshold,
    model: input.model
  });
  return {
    verdict: output.review.verdict,
    forcedDuplicateReject: output.forcedDuplicateReject,
    highestKnownSimilarity: output.highestKnownSimilarity,
    appliedDuplicateSimilarityRejectThreshold:
      output.duplicateSimilarityRejectThreshold
  };
}

function emptyDiagnostics(): VerdictReport["syntheticDiagnostics"] {
  return {
    normal: { total: 0, metExpectation: 0 },
    fabricatedDuplicate: { total: 0, metExpectation: 0 }
  };
}

function renderMarkdown(report: VerdictReport): string {
  const threshold = report.configuration?.duplicateSimilarityRejectThreshold;
  const fabricatedSimilarity = report.configuration?.fabricatedSimilarity;
  const lines = [
    `# 综合评审合成接线诊断（${report.label}）`,
    "",
    `- 运行标识：${report.runId}`,
    `- 实验链标识：${report.chain.chainRunId ?? "预检阶段尚未建立"}`,
    `- 原始报告标识：${report.chain.originalReportRunId ?? "预检阶段尚未建立"}`,
    `- 执行性质：${report.chain.executionKind}`,
    `- 生成时间：${report.generatedAt}`,
    `- 代码版本：${report.codeVersion ?? "未验证"}`,
    `- runner 字节指纹：${report.runnerSha256 ?? "未验证"}`,
    `- 依赖代码指纹：${report.dependencyCodeSha256 ?? "未验证"}`,
    `- models.yaml 原始字节指纹：${report.modelsConfigSha256 ?? "未验证"}`,
    `- expected：${report.integrity.expected}`,
    `- succeeded：${report.integrity.succeeded}`,
    `- failed：${report.integrity.failed}`,
    `- complete：${report.integrity.complete ? "true" : "false"}`,
    `- diagnosticPassed：${report.diagnosticPassed ? "true" : "false"}`,
    `- 查重强制拒绝阈值：${threshold ?? "未能建立"}`,
    `- 构造相似度：${fabricatedSimilarity ?? "未能建立"}`,
    `- 推理配置指纹：${report.configuration?.inferenceFingerprint ?? "未能建立"}`,
    `- 报告配置指纹：${report.configuration?.fingerprint ?? "未能建立"}`,
    `- 内容侧选择 seed：${report.configuration?.contentSelectionSeed ?? "未能建立"}`,
    `- case 身份指纹：${report.configuration?.caseFingerprint ?? "未能建立"}`,
    `- case gold 指纹：${report.configuration?.caseGoldFingerprint ?? "未能建立"}`,
    `- 模型服务身份指纹：${report.configuration?.providerIdentityFingerprint ?? "未能建立"}`,
    `- 数据清单指纹：${report.dataset.manifestFingerprint ?? "未能建立"}`,
    `- 数据集用途：${report.dataset.purpose}（已参与实验设计，不是最终盲测集）`,
    `- 正常组：${report.syntheticDiagnostics.normal.metExpectation}/${report.syntheticDiagnostics.normal.total} 符合预期`,
    `- 构造原题组：${report.syntheticDiagnostics.fabricatedDuplicate.metExpectation}/${report.syntheticDiagnostics.fabricatedDuplicate.total} 符合预期`,
    ""
  ];
  lines.push(
    "> 这是同一批题在“无审核条目/注入合成同题证据”两种输入下的接线诊断，只能验证证据可见性和强制拒绝链路；不能证明真实查重阈值或模型准确率。",
    ""
  );
  if (!report.integrity.complete) {
    lines.push(
      "> 本次运行不完整，不得用它宣布阈值或模型的准确率。固定错误码见同 runId 的 JSON 报告。",
      ""
    );
  }
  if (!report.diagnosticPassed) {
    lines.push(
      "> 合成接线诊断未通过：至少一组数量不完整或有样本不符合预期；即使 complete=true，也必须失败退出，不能宣布接线可靠。",
      ""
    );
  }
  lines.push(
    "| 组别 | 题目 | rating | 结论 | 强制不通过 | 已知相似度 | 符合预期 |",
    "| --- | --- | --- | --- | --- | --- | --- |"
  );
  for (const row of report.results) {
    lines.push(
      `| ${row.caseKind === "normal" ? "正常" : "构造原题"} | ${row.problemLabel} | ${row.rating} | ${row.verdict} | ${row.forcedDuplicateReject ? "是" : "否"} | ${row.highestKnownSimilarity.toFixed(3)} | ${row.expectationMet ? "✓" : "✗"} |`
    );
  }
  return lines.join("\n");
}

function writeReports(
  report: VerdictReport,
  rawResults: readonly CaseResult[]
): EvaluationReportArtifactGroup {
  return writeEvaluationReportArtifactGroup({
    resultsDirectory: RESULTS_DIR,
    rawDirectory: RAW_DIR,
    prefix: "verdict",
    executionRunId: report.runId,
    chainRunId: report.chain.chainRunId,
    experimentComplete: report.integrity.complete,
    rawJson: `${JSON.stringify({ report, rawResults }, null, 2)}\n`,
    summaryJson: `${JSON.stringify(report, null, 2)}\n`,
    markdown: `${renderMarkdown(report)}\n`
  });
}

function writePreflightFailure(input: {
  readonly runId: string;
  readonly label: string;
  readonly generatedAt: string;
  readonly verifiedFiles: number;
  readonly manifestFingerprint: string | null;
  readonly selectedPairedProblems?: number;
  readonly expectedIds: readonly string[];
  readonly failures: readonly EvaluationFailure[];
  readonly codeVersion?: string | null;
  readonly runnerSha256?: string | null;
  readonly dependencyCodeSha256?: string | null;
  readonly dependencyFileCount?: number | null;
  readonly modelsConfigSha256?: string | null;
}): void {
  const failureIds = new Set(input.failures.map((failure) => failure.sampleId));
  const blocked = input.expectedIds
    .filter((sampleId) => !failureIds.has(sampleId))
    .map((sampleId): EvaluationFailure => ({
      sampleId,
      phase: "setup",
      code: "EVALUATION_BLOCKED_BY_PREFLIGHT"
    }));
  const integrity = reconcileEvaluation({
    expectedSampleIds: input.expectedIds,
    succeededSampleIds: [],
    failures: [...input.failures, ...blocked]
  });
  writeReports(
    {
      schemaVersion: 4,
      runId: input.runId,
      label: input.label,
      generatedAt: input.generatedAt,
      codeVersion: input.codeVersion ?? null,
      runnerSha256: input.runnerSha256 ?? null,
      dependencyCodeSha256: input.dependencyCodeSha256 ?? null,
      dependencyFileCount: input.dependencyFileCount ?? null,
      modelsConfigSha256: input.modelsConfigSha256 ?? null,
      configuration: null,
      chain: {
        chainRunId: null,
        originalReportRunId: null,
        createdAt: null,
        executionKind: "preflight"
      },
      dataset: {
        purpose: "development",
        verifiedFiles: input.verifiedFiles,
        manifestFingerprint: input.manifestFingerprint,
        selectedPairedProblems: input.selectedPairedProblems ?? 0
      },
      integrity,
      diagnosticPassed: false,
      syntheticDiagnostics: emptyDiagnostics(),
      results: []
    },
    []
  );
  process.exitCode = 1;
}

function scoreFrozenVerdictPredictions(input: {
  readonly content: BlindContentDataset;
  readonly plan: PairedVerdictCasePlan<BlindProblemContentSample>;
  readonly gold: VerdictCaseGoldDataset;
  readonly predictions: readonly VerdictBlindPredictionRecord[];
  readonly requireComplete: boolean;
}): CaseResult[] {
  const contentBySafeId = new Map(
    input.content.samples.map((sample) => [sample.safeId, sample] as const)
  );
  return scoreVerdictBlindPredictions(input).map((scored) => {
    const content = contentBySafeId.get(scored.contentSafeId);
    if (content === undefined) {
      throw new Error("VERDICT_BLIND_CONTENT_MISSING");
    }
    return {
      sampleId: scored.sampleId,
      caseKind: scored.caseKind,
      problemLabel: content.problem.title,
      rating: scored.rating,
      verdict: scored.verdict,
      forcedDuplicateReject: scored.forcedDuplicateReject,
      highestKnownSimilarity: scored.highestKnownSimilarity,
      appliedDuplicateSimilarityRejectThreshold:
        scored.appliedDuplicateSimilarityRejectThreshold,
      expectationMet: scored.expectationMet
    };
  });
}

async function main(): Promise<void> {
  const label = parseLabelArg();
  const runId = createEvaluationRunId(label);
  const generatedAt = new Date().toISOString();
  const rawCodeVersion = process.env.EVAL_CODE_VERSION;
  let codeVersion: string | null = null;
  try {
    codeVersion = parseEvaluationCodeVersion(rawCodeVersion);
  } catch {
    // 非法原值不得进入报告。
  }
  if (codeVersion === null) {
    writePreflightFailure({
      runId,
      label,
      generatedAt,
      verifiedFiles: 0,
      manifestFingerprint: null,
      expectedIds: ["evaluation-code-version"],
      failures: [{
        sampleId: "evaluation-code-version",
        phase: "setup",
        code: rawCodeVersion === undefined
          ? "EVALUATION_CODE_VERSION_REQUIRED"
          : "EVALUATION_CODE_VERSION_INVALID"
      }]
    });
    return;
  }
  if (
    hasUnknownPrefixedEnvironmentKeys(process.env, "EVAL_", [
      "EVAL_CODE_VERSION",
      "EVAL_CONCURRENCY"
    ]) ||
    hasUnknownPrefixedEnvironmentKeys(process.env, "VERDICT_", ["VERDICT_CASES_PER_GROUP"])
  ) {
    writePreflightFailure({
      runId,
      label,
      generatedAt,
      codeVersion,
      verifiedFiles: 0,
      manifestFingerprint: null,
      expectedIds: ["evaluation-environment"],
      failures: [{
        sampleId: "evaluation-environment",
        phase: "setup",
        code: "EVALUATION_UNKNOWN_ENVIRONMENT_KEY"
      }]
    });
    return;
  }

  let codeIdentity: EvaluationCodeIdentity;
  try {
    codeIdentity = loadEvaluationCodeIdentity({
      repositoryDirectory: REPOSITORY_DIRECTORY,
      expectedCodeVersion: codeVersion,
      runnerPath: RUNNER_REPOSITORY_PATH,
      dependencyPaths: verdictEvaluationCodePaths
    });
  } catch {
    writePreflightFailure({
      runId,
      label,
      generatedAt,
      codeVersion,
      verifiedFiles: 0,
      manifestFingerprint: null,
      expectedIds: ["evaluation-code-identity"],
      failures: [{
        sampleId: "evaluation-code-identity",
        phase: "setup",
        code: "EVALUATION_CODE_IDENTITY_INVALID"
      }]
    });
    return;
  }
  const codeEvidence = {
    codeVersion,
    runnerSha256: codeIdentity.runnerSha256,
    dependencyCodeSha256: codeIdentity.dependencyCodeSha256,
    dependencyFileCount: codeIdentity.dependencyFileCount
  } as const;

  let calibrationBundle: CalibrationDatasetBundle;
  try {
    // 复用 levels v5 的清单绑定和目录描述符预检。manifest.private.json 不是
    // 样本文件；目录缺失/多出文件、题解缺失或逐字节哈希不符都会整体失败。
    calibrationBundle = loadCalibrationDatasetDirectory(DATA_DIR);
  } catch (error) {
    logError("verdict 诊断数据集预检失败，不发起模型请求", error);
    writePreflightFailure({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      verifiedFiles: 0,
      manifestFingerprint: null,
      expectedIds: ["levels-dataset"],
      failures: [{
        sampleId: "levels-dataset",
        phase: "dataset",
        code: error instanceof LevelsCalibrationStateError
          ? error.code
          : "LEVELS_DATA_PRECHECK_FAILED"
      }]
    });
    return;
  }
  const registeredItems = [...calibrationBundle.items];
  let blindContent: BlindContentDataset;
  try {
    // 只按 manifest 预登记数据建立内容视图；rating 不参与排序或抽样。
    blindContent = buildLevelsBlindContent({
      datasetId: calibrationBundle.datasetId,
      purpose: "development",
      items: registeredItems
    });
  } catch {
    writePreflightFailure({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      verifiedFiles: registeredItems.length,
      manifestFingerprint: calibrationBundle.manifestHash,
      expectedIds: registeredItems.map((item) => item.safeId),
      failures: [{
        sampleId: "verdict-blind-dataset",
        phase: "setup",
        code: "BLIND_DATASET_PRECHECK_FAILED"
      }]
    });
    return;
  }

  let casesPerGroup: number;
  let concurrency: number;
  try {
    casesPerGroup = parseBoundedPositiveInteger(
      process.env.VERDICT_CASES_PER_GROUP,
      3,
      100,
      "VERDICT_CASES_PER_GROUP"
    );
    concurrency = parseBoundedPositiveInteger(
      process.env.EVAL_CONCURRENCY,
      4,
      32,
      "EVAL_CONCURRENCY"
    );
  } catch {
    writePreflightFailure({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      verifiedFiles: registeredItems.length,
      manifestFingerprint: calibrationBundle.manifestHash,
      expectedIds: ["evaluation-numeric-settings"],
      failures: [{
        sampleId: "evaluation-numeric-settings",
        phase: "setup",
        code: "EVALUATION_NUMERIC_SETTING_INVALID"
      }]
    });
    return;
  }

  if (registeredItems.length < casesPerGroup) {
    const expectedIds = Array.from(
      { length: casesPerGroup },
      (_, index) => `unbound-pair-${index + 1}`
    );
    writePreflightFailure({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      verifiedFiles: registeredItems.length,
      manifestFingerprint: calibrationBundle.manifestHash,
      expectedIds,
      failures: expectedIds.map((sampleId) => ({
        sampleId,
        phase: "dataset",
        code: "DATASET_EXPECTED_SAMPLE_UNAVAILABLE"
      }))
    });
    return;
  }

  // 同一道可信题分别跑 normal 与 fabricated_duplicate，才能把差异归因于
  // 注入的合成审核条目，而不是两个题目本身不同。
  const selectedContent = selectVerdictContentOnlyItems({
    items: blindContent.samples,
    count: casesPerGroup,
    seed: VERDICT_CONTENT_SELECTION_SEED
  });
  const casePlan = buildPairedVerdictCasePlan(selectedContent, casesPerGroup);
  const pairedCases = casePlan.selectedItems;
  const expectedIds = casePlan.expectedSampleIds;
  const allCases = [...casePlan.normal, ...casePlan.fabricatedDuplicate];
  const caseBySampleId = new Map(
    allCases.map((diagnosticCase) => [diagnosticCase.sampleId, diagnosticCase] as const)
  );
  let caseGold: VerdictCaseGoldDataset;
  try {
    const sourceBySafeId = new Map(
      registeredItems.map((item) => [item.safeId, item] as const)
    );
    caseGold = buildVerdictCaseGoldDataset({
      content: blindContent,
      plan: casePlan,
      samples: expectedIds.map((sampleId) => {
        const diagnosticCase = caseBySampleId.get(sampleId);
        const source = diagnosticCase === undefined
          ? undefined
          : sourceBySafeId.get(diagnosticCase.item.safeId);
        if (diagnosticCase === undefined || source === undefined) {
          throw new Error("VERDICT_CASE_GOLD_MISMATCH");
        }
        return {
          sampleId,
          contentSafeId: diagnosticCase.item.safeId,
          contentHash: diagnosticCase.item.problem.contentHash,
          caseKind: diagnosticCase.caseKind,
          gold: diagnosticCase.caseKind === "normal"
            ? {
                rating: source.rating,
                expectedVerdict: "not_reject" as const,
                expectedForcedDuplicateReject: false
              }
            : {
                rating: source.rating,
                expectedVerdict: "reject" as const,
                expectedForcedDuplicateReject: true
              }
        };
      })
    });
  } catch {
    writePreflightFailure({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      verifiedFiles: registeredItems.length,
      manifestFingerprint: calibrationBundle.manifestHash,
      selectedPairedProblems: pairedCases.length,
      expectedIds,
      failures: [{
        sampleId: "verdict-case-gold",
        phase: "setup",
        code: "VERDICT_CASE_GOLD_INVALID"
      }]
    });
    return;
  }

  let config: AppConfig;
  let modelsConfigSha256: string | null = null;
  try {
    const modelsConfigBytes = readFileSync(MODELS_CONFIG_FILE);
    modelsConfigSha256 = createHash("sha256")
      .update(modelsConfigBytes)
      .digest("hex");
    config = loadConfig({
      env: process.env,
      modelsYamlSource: modelsConfigBytes.toString("utf8")
    });
  } catch (error) {
    logError("实验配置校验失败，不发起模型请求", error);
    writePreflightFailure({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      modelsConfigSha256,
      verifiedFiles: registeredItems.length,
      manifestFingerprint: calibrationBundle.manifestHash,
      selectedPairedProblems: pairedCases.length,
      expectedIds,
      failures: [{ sampleId: "evaluation-config", phase: "setup", code: "EVALUATION_CONFIG_INVALID" }]
    });
    return;
  }
  const profileName = config.models.defaults.modelProfileName;
  const profiles: Record<string, ProfileConfig | undefined> = config.models.profiles;
  const profile = profiles[profileName];
  if (profile === undefined) {
    writePreflightFailure({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      modelsConfigSha256,
      verifiedFiles: registeredItems.length,
      manifestFingerprint: calibrationBundle.manifestHash,
      selectedPairedProblems: pairedCases.length,
      expectedIds,
      failures: [{ sampleId: "evaluation-profile", phase: "setup", code: "EVALUATION_PROFILE_MISSING" }]
    });
    return;
  }
  const credentials = getProviderCredentials(config, profile.verdict.provider);
  if (credentials === undefined) {
    writePreflightFailure({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      modelsConfigSha256,
      verifiedFiles: registeredItems.length,
      manifestFingerprint: calibrationBundle.manifestHash,
      selectedPairedProblems: pairedCases.length,
      expectedIds,
      failures: [{ sampleId: "evaluation-provider", phase: "setup", code: "EVALUATION_PROVIDER_MISSING" }]
    });
    return;
  }
  const threshold = config.models.thresholds.duplicateSimilarityReject;
  if (threshold >= 1) {
    writePreflightFailure({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      modelsConfigSha256,
      verifiedFiles: registeredItems.length,
      manifestFingerprint: calibrationBundle.manifestHash,
      selectedPairedProblems: pairedCases.length,
      expectedIds,
      failures: expectedIds.map((sampleId) => ({
        sampleId,
        phase: "setup",
        code: "DUPLICATE_THRESHOLD_NOT_TESTABLE"
      }))
    });
    return;
  }
  const fabricatedSimilarity = threshold + (1 - threshold) / 2;
  const caseFingerprint = verdictCaseFingerprint(blindContent, casePlan);
  const providerIdentityFingerprint = difficultyProviderIdentityFingerprint(
    profile.verdict.provider,
    credentials
  );
  const inferenceConfigurationSnapshot = {
    codeVersion,
    runnerSha256: codeIdentity.runnerSha256,
    dependencyCodeSha256: codeIdentity.dependencyCodeSha256,
    dependencyFileCount: codeIdentity.dependencyFileCount,
    modelsConfigSha256,
    experimentVersion: config.models.experimentVersion,
    modelProfileName: profileName,
    model: profile.verdict,
    retry: config.models.retry,
    timeouts: config.models.timeouts,
    duplicateSimilarityRejectThreshold: threshold,
    fabricatedSimilarity,
    concurrency,
    casesPerGroup,
    providerIdentityFingerprint,
    datasetPurpose: blindContent.purpose,
    datasetId: blindContent.datasetId,
    blindContentFingerprint: blindContent.contentFingerprint,
    selectedSafeIds: pairedCases.map((item) => item.safeId),
    contentSelectionSeed: VERDICT_CONTENT_SELECTION_SEED,
    caseFingerprint,
    caseConstructionVersion: "paired-synthetic-blind-content-v3"
  };
  const inferenceConfigurationFingerprint =
    verdictInferenceConfigurationFingerprint(inferenceConfigurationSnapshot);
  const configuration = {
    experimentVersion: config.models.experimentVersion,
    modelProfileName: profileName,
    duplicateSimilarityRejectThreshold: threshold,
    fabricatedSimilarity,
    concurrency,
    casesPerGroup,
    providerIdentityFingerprint,
    contentSelectionSeed: VERDICT_CONTENT_SELECTION_SEED,
    caseFingerprint,
    caseGoldFingerprint: caseGold.goldFingerprint,
    inferenceFingerprint: inferenceConfigurationFingerprint,
    fingerprint: verdictReportConfigurationFingerprint({
      inferenceConfigurationFingerprint,
      caseGoldFingerprint: caseGold.goldFingerprint
    })
  };
  const model: PipelineModelConfig = {
    spec: profile.verdict,
    credentials,
    runtime: {
      firstOutputTimeoutMs: config.models.timeouts.llmFirstOutputMs,
      outputIdleTimeoutMs: config.models.timeouts.llmOutputIdleMs,
      maximumDurationMs: config.models.timeouts.llmMaximumDurationMs,
      maxAttempts: config.models.retry.maxAttempts,
      baseDelayMs: config.models.retry.baseDelayMs
    }
  };

  const expectedCases: VerdictCheckpointCaseBinding[] = expectedIds.map((sampleId) => {
    const diagnosticCase = caseBySampleId.get(sampleId);
    if (diagnosticCase === undefined) {
      throw new Error("VERDICT_CASE_PLAN_INVALID");
    }
    return {
      sampleId,
      contentHash: diagnosticCase.item.problem.contentHash
    };
  });
  let checkpoint: VerdictEvaluationCheckpoint;
  try {
    checkpoint = new VerdictEvaluationCheckpoint({
      label,
      reportRunId: runId,
      contentDatasetFingerprint: blindContent.contentFingerprint,
      configurationFingerprint: inferenceConfigurationFingerprint,
      expectedCases
    });
  } catch (error) {
    logError("verdict 检查点不可用，不发起模型请求", error);
    writePreflightFailure({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      modelsConfigSha256,
      verifiedFiles: registeredItems.length,
      manifestFingerprint: calibrationBundle.manifestHash,
      selectedPairedProblems: pairedCases.length,
      expectedIds,
      failures: [{
        sampleId: "verdict-checkpoint",
        phase: "setup",
        code: "VERDICT_CHECKPOINT_UNAVAILABLE"
      }]
    });
    return;
  }

  try {
    const checkpointState = checkpoint.snapshot();
    const baseChain: VerdictReport["chain"] = {
      chainRunId: checkpointState.chainRunId,
      originalReportRunId: checkpointState.reportRunId,
      createdAt: checkpointState.createdAt,
      executionKind: checkpoint.openedExistingCheckpoint() ? "resume" : "new"
    };
    const makeReport = (
      results: readonly CaseResult[],
      integrity: EvaluationCompleteness,
      executionKind: VerdictReport["chain"]["executionKind"] = baseChain.executionKind
    ): VerdictReport => {
      const assessment = assessVerdictSyntheticDiagnostic(results, casesPerGroup);
      return {
        schemaVersion: 4,
        runId,
        label,
        generatedAt,
        ...codeEvidence,
        modelsConfigSha256,
        configuration,
        chain: { ...baseChain, executionKind },
        dataset: {
          purpose: "development",
          verifiedFiles: registeredItems.length,
          manifestFingerprint: calibrationBundle.manifestHash,
          selectedPairedProblems: pairedCases.length
        },
        integrity,
        diagnosticPassed: integrity.complete && assessment.diagnosticPassed,
        syntheticDiagnostics: assessment.syntheticDiagnostics,
        results: results.map(({ sampleId: _sampleId, ...result }) => result)
      };
    };

    if (
      checkpoint.hasPublishedCompleteReport() ||
      completedEvaluationChainMarkerExists(
        RESULTS_DIR,
        "verdict",
        checkpointState.chainRunId
      )
    ) {
      const predictions = checkpoint.succeededPredictions();
      const results = scoreFrozenVerdictPredictions({
        content: blindContent,
        plan: casePlan,
        gold: caseGold,
        predictions,
        requireComplete: false
      });
      const integrity = reconcileEvaluation({
        expectedSampleIds: expectedIds,
        succeededSampleIds: predictions.map((prediction) => prediction.sampleId),
        failures: [{
          sampleId: "verdict-complete-chain-replay",
          phase: "setup",
          code: "EVALUATION_COMPLETE_CHAIN_REPLAY_BLOCKED"
        }]
      });
      const report = makeReport(results, integrity, "replay_blocked");
      writeReports(report, results);
      process.exitCode = 1;
      return;
    }

    logInfo("开始 verdict 判定实验", {
      label,
      expected: expectedIds.length,
      pending: checkpoint.pendingCases().length,
      concurrency
    });

    const continuation = await continueVerdictEvaluationUnlessContaminated({
      checkpoint,
      expectedSampleIds: expectedIds,
      continueClean: async (): Promise<EvaluationFailure | null> => {
        const pendingBindings = checkpoint.pendingCases();
        if (pendingBindings.length === 0) {
          return null;
        }
        const pendingCases = pendingBindings.map((binding) => {
          const diagnosticCase = caseBySampleId.get(binding.sampleId);
          if (
            diagnosticCase === undefined ||
            diagnosticCase.item.problem.contentHash !== binding.contentHash
          ) {
            throw new Error("VERDICT_CHECKPOINT_CASE_SET_INVALID");
          }
          return diagnosticCase;
        });
        let done = expectedIds.length - pendingCases.length;
        try {
          await runVerdictBlindCaseBatch({
            content: blindContent,
            cases: pendingCases,
            concurrency,
            beforeInference: (diagnosticCase) => {
              checkpoint.markActive(diagnosticCase.sampleId);
            },
            infer: (diagnosticCase) => inferVerdictBlindCase({
              diagnosticCase,
              fabricatedSimilarity,
              threshold,
              model
            }),
            afterInference: (record, index) => {
              checkpoint.markSucceeded(record.sampleId, record.prediction);
              done += 1;
              logInfo("完成一例 verdict 盲推理", {
                caseNumber: index + 1,
                ...verdictPredictionLogFields(record.prediction),
                progress: `${done}/${expectedIds.length}`
              });
            },
            onInferenceError: (diagnosticCase, error, index) => {
              done += 1;
              const failure = executionFailure(diagnosticCase.sampleId, error);
              checkpoint.markFailed(diagnosticCase.sampleId, failure);
              logError("这一例 verdict 盲推理失败", error, {
                caseNumber: index + 1,
                progress: `${done}/${expectedIds.length}`
              });
            }
          });
          return null;
        } catch (error) {
          logError("verdict 评测已安全停止，不再发起后续请求", error);
          return {
            sampleId: "verdict-evaluation-orchestration",
            phase: "setup",
            code: "VERDICT_EVALUATION_STOPPED"
          };
        }
      }
    });

    let predictions: readonly VerdictBlindPredictionRecord[];
    let integrity: EvaluationCompleteness;
    if (continuation.kind === "contaminated") {
      predictions = continuation.persistedPredictions;
      integrity = continuation.integrity;
    } else {
      predictions = checkpoint.succeededPredictions();
      const orchestrationFailure = continuation.value;
      integrity = reconcileEvaluation({
        expectedSampleIds: expectedIds,
        succeededSampleIds: predictions.map((prediction) => prediction.sampleId),
        failures: [
          ...checkpoint.terminalFailures(),
          ...(orchestrationFailure === null ? [] : [orchestrationFailure])
        ]
      });
    }

    // 所有在途请求已经收束，且预测已冻结进 checkpoint；从这里才首次读取 case gold。
    const results = scoreFrozenVerdictPredictions({
      content: blindContent,
      plan: casePlan,
      gold: caseGold,
      predictions,
      requireComplete: integrity.complete
    });
    const report = makeReport(results, integrity);
    const artifacts = writeReports(report, results);
    if (integrity.complete) {
      checkpoint.markCompleteReportPublished(
        runId,
        artifacts.completionFingerprint
      );
    }
    logInfo("verdict 实验收束", {
      label,
      expected: integrity.expected,
      succeeded: integrity.succeeded,
      failed: integrity.failed,
      complete: integrity.complete,
      diagnosticPassed: report.diagnosticPassed,
      normalMet:
        `${report.syntheticDiagnostics.normal.metExpectation}/${report.syntheticDiagnostics.normal.total}`,
      duplicateMet:
        `${report.syntheticDiagnostics.fabricatedDuplicate.metExpectation}/${report.syntheticDiagnostics.fabricatedDuplicate.total}`
    });
    if (!integrity.complete || !report.diagnosticPassed) {
      process.exitCode = 1;
    }
  } finally {
    checkpoint.close();
  }
}

main().catch((error: unknown) => {
  logError("experiments/eval-verdict.ts 执行失败", error);
  process.exitCode = 1;
});
