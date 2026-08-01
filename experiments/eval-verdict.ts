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
import { mkdirSync } from "node:fs";
import { getProviderCredentials, loadConfig, type AppConfig, type ProfileConfig } from "../src/config";
import { logError, logInfo } from "../src/logger";
import { runVerdictPipeline } from "../src/pipelines/verdict";
import type { PipelineModelConfig, ReviewTaskProblem } from "../src/pipelines/types";
import { mapWithConcurrency } from "./lib/concurrency";
import {
  createEvaluationRunId,
  evaluationConfigurationFingerprint,
  executionFailure,
  hasUnknownPrefixedEnvironmentKeys,
  parseBoundedPositiveInteger,
  parseEvaluationLabel,
  reconcileEvaluation,
  writeNewEvaluationFile,
  type EvaluationCompleteness,
  type EvaluationFailure
} from "./lib/evaluation-integrity";
import {
  LevelsCalibrationStateError,
  loadCalibrationDatasetDirectory,
  type CalibrationDatasetBundle,
  type CalibrationDatasetItem
} from "./lib/levels-calibration-state";
import {
  assessVerdictSyntheticDiagnostic,
  buildFabricatedSimilarityItem,
  buildPairedVerdictCasePlan,
  type PairedVerdictCase,
  type VerdictDiagnosticCaseKind
} from "./lib/verdict-evaluation-design";

const DATA_DIR = new URL("./data/levels/", import.meta.url);
const RESULTS_DIR = new URL("./results/", import.meta.url);
const RAW_DIR = new URL("./results/raw/", import.meta.url);

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
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly label: string;
  readonly generatedAt: string;
  readonly configuration: null | {
    readonly experimentVersion: string;
    readonly modelProfileName: string;
    readonly duplicateSimilarityRejectThreshold: number;
    readonly fabricatedSimilarity: number;
    readonly fingerprint: string;
  };
  readonly dataset: {
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

function toProblem(item: CalibrationDatasetItem): ReviewTaskProblem {
  return {
    id: `verdict-${item.contestId}${item.index}`,
    revision: 1,
    reviewRound: 1,
    contentHash: createHash("sha256").update(item.statement, "utf8").digest("hex"),
    title: `CF${item.contestId}${item.index}`,
    type: "traditional",
    tagIds: ["calibration.sample"],
    basicStatement: item.statement,
    basicSolution: item.editorial ?? ""
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
    `- 生成时间：${report.generatedAt}`,
    `- expected：${report.integrity.expected}`,
    `- succeeded：${report.integrity.succeeded}`,
    `- failed：${report.integrity.failed}`,
    `- complete：${report.integrity.complete ? "true" : "false"}`,
    `- diagnosticPassed：${report.diagnosticPassed ? "true" : "false"}`,
    `- 查重强制拒绝阈值：${threshold ?? "未能建立"}`,
    `- 构造相似度：${fabricatedSimilarity ?? "未能建立"}`,
    `- 配置指纹：${report.configuration?.fingerprint ?? "未能建立"}`,
    `- 数据清单指纹：${report.dataset.manifestFingerprint ?? "未能建立"}`,
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

function writeReports(report: VerdictReport, rawResults: readonly CaseResult[]): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(RAW_DIR, { recursive: true });
  writeNewEvaluationFile(
    new URL(`verdict-${report.runId}-raw.json`, RAW_DIR),
    JSON.stringify({ report, rawResults }, null, 2)
  );
  writeNewEvaluationFile(
    new URL(`verdict-${report.runId}-summary.json`, RESULTS_DIR),
    JSON.stringify(report, null, 2)
  );
  writeNewEvaluationFile(
    new URL(`verdict-${report.runId}.md`, RESULTS_DIR),
    renderMarkdown(report)
  );
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
      schemaVersion: 1,
      runId: input.runId,
      label: input.label,
      generatedAt: input.generatedAt,
      configuration: null,
      dataset: {
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

async function main(): Promise<void> {
  const label = parseLabelArg();
  const runId = createEvaluationRunId(label);
  const generatedAt = new Date().toISOString();
  if (
    hasUnknownPrefixedEnvironmentKeys(process.env, "EVAL_", ["EVAL_CONCURRENCY"]) ||
    hasUnknownPrefixedEnvironmentKeys(process.env, "VERDICT_", ["VERDICT_CASES_PER_GROUP"])
  ) {
    writePreflightFailure({
      runId,
      label,
      generatedAt,
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

  let calibrationBundle: CalibrationDatasetBundle;
  try {
    // 复用 levels v4 的清单绑定和目录描述符预检。manifest.private.json 不是
    // 样本文件；目录缺失/多出文件、题解缺失或逐字节哈希不符都会整体失败。
    calibrationBundle = loadCalibrationDatasetDirectory(DATA_DIR);
  } catch (error) {
    logError("verdict 诊断数据集预检失败，不发起模型请求", error);
    writePreflightFailure({
      runId,
      label,
      generatedAt,
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
  const eligible = [...calibrationBundle.items]
    .sort((left, right) => left.rating - right.rating || left.safeId.localeCompare(right.safeId));

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
      verifiedFiles: eligible.length,
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

  if (eligible.length < casesPerGroup) {
    const expectedIds = Array.from(
      { length: casesPerGroup },
      (_, index) => `unbound-pair-${index + 1}`
    );
    writePreflightFailure({
      runId,
      label,
      generatedAt,
      verifiedFiles: eligible.length,
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
  const casePlan = buildPairedVerdictCasePlan(eligible, casesPerGroup);
  const pairedCases = casePlan.selectedItems;
  const expectedIds = casePlan.expectedSampleIds;

  let config: AppConfig;
  try {
    config = loadConfig({ env: process.env });
  } catch (error) {
    logError("实验配置校验失败，不发起模型请求", error);
    writePreflightFailure({
      runId,
      label,
      generatedAt,
      verifiedFiles: eligible.length,
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
      verifiedFiles: eligible.length,
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
      verifiedFiles: eligible.length,
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
      verifiedFiles: eligible.length,
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
  const configurationSnapshot = {
    experimentVersion: config.models.experimentVersion,
    modelProfileName: profileName,
    model: profile.verdict,
    retry: config.models.retry,
    timeouts: config.models.timeouts,
    duplicateSimilarityRejectThreshold: threshold,
    fabricatedSimilarity,
    datasetManifestFingerprint: calibrationBundle.manifestHash,
    selectedSafeIds: pairedCases.map((item) => item.safeId),
    caseConstructionVersion: "paired-synthetic-visible-summary-v1"
  };
  const configuration = {
    experimentVersion: config.models.experimentVersion,
    modelProfileName: profileName,
    duplicateSimilarityRejectThreshold: threshold,
    fabricatedSimilarity,
    fingerprint: evaluationConfigurationFingerprint(configurationSnapshot)
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

  logInfo("开始 verdict 判定实验", {
    label,
    expected: expectedIds.length,
    normal: pairedCases.length,
    fabricatedDuplicate: pairedCases.length,
    duplicateSimilarityRejectThreshold: threshold
  });

  const results: CaseResult[] = [];
  const failures: EvaluationFailure[] = [];
  const runCase = async (
    diagnosticCase: PairedVerdictCase<CalibrationDatasetItem>,
    caseNumber: number
  ): Promise<void> => {
    const { sampleId, caseKind, item } = diagnosticCase;
    const problem = toProblem(item);
    const reviewItems =
      caseKind === "fabricated_duplicate"
        ? [buildFabricatedSimilarityItem(problem, fabricatedSimilarity)]
        : [];
    try {
      const output = await runVerdictPipeline({
        problem,
        reviewItems,
        difficulty: {
          rating: item.rating,
          confidence: 0.8,
          rationale: "实验输入：直接采用官方难度。"
        },
        thinking: {
          level: 3,
          signals: { solved: true, approachSimilarity: 0.6, selfCorrections: 1, keyInsightCount: 2 },
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
        duplicateSimilarityRejectThreshold: threshold,
        model
      });
      const expectationMet =
        caseKind === "fabricated_duplicate"
          ? output.forcedDuplicateReject && output.review.verdict === "reject"
          : output.review.verdict !== "reject";
      results.push({
        sampleId,
        caseKind,
        problemLabel: problem.title,
        rating: item.rating,
        verdict: output.review.verdict,
        forcedDuplicateReject: output.forcedDuplicateReject,
        highestKnownSimilarity: output.highestKnownSimilarity,
        appliedDuplicateSimilarityRejectThreshold: output.duplicateSimilarityRejectThreshold,
        expectationMet
      });
      logInfo("完成一例", {
        caseKind,
        caseNumber,
        verdict: output.review.verdict,
        forcedDuplicateReject: output.forcedDuplicateReject,
        expectationMet
      });
    } catch (error) {
      failures.push(executionFailure(sampleId, error));
      logError("这一例判定失败", error, { caseKind, caseNumber });
    }
  };

  await mapWithConcurrency(casePlan.normal, concurrency, (diagnosticCase, index) =>
    runCase(diagnosticCase, index + 1)
  );
  await mapWithConcurrency(casePlan.fabricatedDuplicate, concurrency, (diagnosticCase, index) =>
    runCase(diagnosticCase, index + 1)
  );

  const integrity = reconcileEvaluation({
    expectedSampleIds: expectedIds,
    succeededSampleIds: results.map((result) => result.sampleId),
    failures
  });
  const { syntheticDiagnostics, diagnosticPassed } =
    assessVerdictSyntheticDiagnostic(results, casesPerGroup);
  const publicResults = results.map(({ sampleId: _sampleId, ...result }) => result);
  const report: VerdictReport = {
    schemaVersion: 1,
    runId,
    label,
    generatedAt,
    configuration,
    dataset: {
      verifiedFiles: eligible.length,
      manifestFingerprint: calibrationBundle.manifestHash,
      selectedPairedProblems: pairedCases.length
    },
    integrity,
    diagnosticPassed,
    syntheticDiagnostics,
    results: publicResults
  };
  writeReports(report, results);
  logInfo("verdict 实验收束", {
    label,
    expected: integrity.expected,
    succeeded: integrity.succeeded,
    failed: integrity.failed,
    complete: integrity.complete,
    diagnosticPassed,
    normalMet: `${syntheticDiagnostics.normal.metExpectation}/${syntheticDiagnostics.normal.total}`,
    duplicateMet: `${syntheticDiagnostics.fabricatedDuplicate.metExpectation}/${syntheticDiagnostics.fabricatedDuplicate.total}`
  });
  if (!integrity.complete || !diagnosticPassed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  logError("experiments/eval-verdict.ts 执行失败", error);
  process.exitCode = 1;
});
