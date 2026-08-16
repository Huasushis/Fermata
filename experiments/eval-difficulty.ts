/**
 * 对 experiments/data/cf/ 的公开 Codeforces 样本跑 difficulty 流水线，
 * 输出每题误差、MAE、±200 命中率和分档统计。
 *
 * 数据集没有稳定可抓取的官方题解，因此本实验只评估“只看题面”的表现，
 * 不能当作正式审题（题面+题解）的准确率。
 *
 * 完整性规则：所有 JSON 在付费请求前严格预检并锁定 expected 集合；
 * 损坏文件、499、取消、请求失败或缺失结果都会使 complete=false 且进程非零退出。
 * 每次运行使用唯一 runId 和排他创建，不覆盖旧报告。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getProviderCredentials, loadConfig, type AppConfig, type ProfileConfig } from "../src/config";
import { logError, logInfo } from "../src/logger";
import {
  clampAndRoundDifficultyRating,
  runDifficultyPipeline,
  type DifficultyAnchor
} from "../src/pipelines/difficulty";
import type { PipelineModelConfig, ReviewTaskProblem } from "../src/pipelines/types";
import {
  buildBlindContentDataset,
  buildBlindGoldDataset,
  deriveBlindContentSubset,
  joinBlindPredictionSubsetWithGold,
  runBlindInference,
  type BlindContentDataset,
  type BlindGoldDataset,
  type BlindPrediction,
  type BlindProblemContentSample
} from "./lib/blind-evaluation";
import { loadDifficultyAnchorsStrict } from "./lib/difficulty-anchors-strict";
import {
  assessDifficultyEvaluationEligibility,
  difficultyAccuracyThresholds,
  difficultyEvaluationConfigurationFingerprint,
  difficultyProviderIdentityFingerprint
} from "./lib/difficulty-evaluation-eligibility";
import {
  loadDifficultyDatasetManifest,
  knownPublicDifficultyArchiveProfile,
  parsePublicDifficultyBoundedSelection,
  verifyDifficultyDatasetManifest,
  verifyKnownPublicDifficultyArchiveProfile
} from "./lib/difficulty-dataset-manifest";
import {
  continueDifficultyEvaluationUnlessContaminated,
  DifficultyEvaluationCheckpoint,
  type DifficultyCheckpointPrediction
} from "./lib/difficulty-evaluation-checkpoint";
import {
  difficultyEvaluationCodePaths,
  loadEvaluationCodeIdentity,
  type EvaluationCodeIdentity
} from "./lib/evaluation-code-identity";
import {
  createEvaluationRunId,
  completedEvaluationChainMarkerExists,
  executionFailure,
  hasUnknownPrefixedEnvironmentKeys,
  parseBoundedPositiveInteger,
  parseEvaluationCodeVersion,
  parseEvaluationLabel,
  preflightJsonDataset,
  reconcileEvaluation,
  writeEvaluationReportArtifactGroup,
  type EvaluationReportArtifactGroup,
  type EvaluationCompleteness,
  type EvaluationFailure
} from "./lib/evaluation-integrity";

const DATA_DIR = new URL("./data/cf/", import.meta.url);
const RESULTS_DIR = new URL("./results/", import.meta.url);
const RAW_RESULTS_DIR = new URL("./results/raw/", import.meta.url);
const ANCHORS_FILE = new URL("../config/anchors/difficulty.json", import.meta.url);
const MODELS_CONFIG_FILE = new URL("../config/models.yaml", import.meta.url);
const REPOSITORY_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const RUNNER_REPOSITORY_PATH = "experiments/eval-difficulty.ts";

const NO_SOLUTION_PLACEHOLDER =
  "（实验数据集没有单独抓取官方题解——Codeforces 编辑注解通常是独立论坛帖子，没有稳定的结构化格式可抓。" +
  "这次评测只依据题面本身判断难度，比正式使用时更难，结果仅供参考。）";

const datasetItemSchema = z.object({
  contestId: z.number().int().positive(),
  index: z.string().regex(/^[A-Z][0-9]{0,7}$/),
  rating: z.number().int().min(800).max(3500).multipleOf(100),
  statement: z.string().min(1).max(500_000),
  // fetch-hf-dataset 会额外保存 editorial；difficulty 实验不使用它，
  // 但要明确允许该已知字段，而不能靠非 strict schema 吞掉任意元数据。
  editorial: z.string().min(1).max(500_000).nullable().optional()
}).strict();
type DatasetItem = z.infer<typeof datasetItemSchema>;

const difficultyBlindGoldSchema = z
  .object({
    contestId: z.number().int().positive(),
    index: z.string().regex(/^[A-Z][0-9]{0,7}$/),
    actualRating: z.number().int().min(800).max(3500).multipleOf(100)
  })
  .strict();
type DifficultyBlindGold = z.infer<typeof difficultyBlindGoldSchema>;

interface DifficultyBlindPrediction {
  readonly predictedRating: number;
  readonly confidence: number;
}

type PersistedDifficultyBlindPrediction = DifficultyCheckpointPrediction & {
  readonly sampleId: string;
};

interface EvalRow {
  readonly contestId: number;
  readonly index: string;
  readonly actualRating: number;
  readonly predictedRating: number;
  readonly error: number;
  readonly confidence: number;
}

interface PersistedEvalRow extends EvalRow {
  readonly sampleId: string;
}

interface DifficultyReport {
  readonly schemaVersion: 4;
  readonly runId: string;
  readonly label: string;
  readonly generatedAt: string;
  readonly codeVersion: string | null;
  readonly runnerSha256: string | null;
  readonly dependencyCodeSha256: string | null;
  readonly dependencyFileCount: number | null;
  readonly modelsConfigSha256: string | null;
  readonly configurationFingerprint: string | null;
  /** 只保存 provider/baseUrl/apiKey 的不可逆摘要，不保存任何原值。 */
  readonly providerIdentityFingerprint: string | null;
  readonly executionComplete: boolean;
  readonly accuracyPassed: boolean;
  readonly anchorsProvisional: boolean | null;
  readonly anchorsEligible: boolean;
  readonly eligible: boolean;
  readonly chain: {
    readonly chainRunId: string | null;
    readonly originalReportRunId: string | null;
    readonly createdAt: string | null;
    readonly executionKind: "preflight" | "new" | "resume" | "replay_blocked";
  };
  readonly dataset: {
    readonly purpose: "development";
    readonly discoveredFiles: number;
    readonly excludedAnchors: number;
    readonly manifest: {
      readonly enabled: boolean;
      readonly expectedFiles: number | null;
      readonly fingerprint: string | null;
      readonly verified: boolean;
    };
  };
  readonly integrity: EvaluationCompleteness;
  readonly summary: ReturnType<typeof summarize>;
  readonly rows: readonly EvalRow[];
}

function parseLabelArg(): string {
  const arg = process.argv.find((value) => value.startsWith("--label="));
  return parseEvaluationLabel(arg?.slice("--label=".length) ?? "", "baseline");
}

function toReviewTaskProblem(
  safeId: string,
  item: Pick<DatasetItem, "statement">
): ReviewTaskProblem {
  const contentHash = createHash("sha256")
    .update(item.statement, "utf8")
    .update("\0", "utf8")
    .update(NO_SOLUTION_PLACEHOLDER, "utf8")
    .digest("hex");
  return {
    id: `difficulty-${safeId}`,
    revision: 1,
    reviewRound: 1,
    contentHash,
    title: `公开开发集样本-${safeId}`,
    type: "traditional",
    tagIds: ["experiment"],
    basicStatement: item.statement,
    basicSolution: NO_SOLUTION_PLACEHOLDER
  };
}

/** 这个函数是付费推理边界：参数中没有官方 rating、人工标签或预期结论。 */
async function inferDifficultyBlindSample(input: {
  readonly sample: Readonly<BlindProblemContentSample>;
  readonly anchors: readonly DifficultyAnchor[];
  readonly model: PipelineModelConfig;
}): Promise<DifficultyBlindPrediction> {
  const result = await runDifficultyPipeline({
    problem: input.sample.problem,
    anchors: input.anchors,
    model: input.model
  });
  return {
    predictedRating: clampAndRoundDifficultyRating(result.rating),
    confidence: result.confidence
  };
}

function scoreDifficultyPredictions(
  content: BlindContentDataset,
  gold: BlindGoldDataset<DifficultyBlindGold>,
  predictions: readonly PersistedDifficultyBlindPrediction[]
): PersistedEvalRow[] {
  const blindPredictions: BlindPrediction<DifficultyBlindPrediction>[] =
    predictions.map((prediction) => ({
      safeId: prediction.sampleId,
      contentHash: prediction.contentHash,
      prediction: {
        predictedRating: prediction.predictedRating,
        confidence: prediction.confidence
      }
    }));
  return joinBlindPredictionSubsetWithGold({
    content,
    gold,
    predictions: blindPredictions
  }).map((joined) => ({
    sampleId: joined.safeId,
    contestId: joined.gold.contestId,
    index: joined.gold.index,
    actualRating: joined.gold.actualRating,
    predictedRating: joined.prediction.predictedRating,
    error: joined.prediction.predictedRating - joined.gold.actualRating,
    confidence: joined.prediction.confidence
  }));
}

function summarize(rows: readonly EvalRow[]): {
  readonly count: number;
  readonly meanAbsoluteError: number;
  readonly hitRateWithin200: number;
  readonly byBucket: Record<number, { count: number; meanAbsoluteError: number }>;
} {
  if (rows.length === 0) {
    return { count: 0, meanAbsoluteError: 0, hitRateWithin200: 0, byBucket: {} };
  }
  const absoluteErrors = rows.map((row) => Math.abs(row.error));
  const meanAbsoluteError = absoluteErrors.reduce((sum, value) => sum + value, 0) / rows.length;
  const within200 = rows.filter((row) => Math.abs(row.error) <= 200).length;
  const hitRateWithin200 = within200 / rows.length;

  const byBucket: Record<number, { count: number; meanAbsoluteError: number }> = {};
  const grouped = new Map<number, EvalRow[]>();
  for (const row of rows) {
    const bucket = Math.round(row.actualRating / 100) * 100;
    const list = grouped.get(bucket) ?? [];
    list.push(row);
    grouped.set(bucket, list);
  }
  for (const [bucket, list] of grouped) {
    const bucketErrors = list.map((row) => Math.abs(row.error));
    byBucket[bucket] = {
      count: list.length,
      meanAbsoluteError: bucketErrors.reduce((sum, value) => sum + value, 0) / list.length
    };
  }
  return { count: rows.length, meanAbsoluteError, hitRateWithin200, byBucket };
}

function renderMarkdown(report: DifficultyReport): string {
  const lines = [
    `# 难度评定误差评测：${report.label}`,
    "",
    `- 运行标识：${report.runId}`,
    `- 实验链标识：${report.chain.chainRunId ?? "预检阶段尚未建立"}`,
    `- 原始报告标识：${report.chain.originalReportRunId ?? "预检阶段尚未建立"}`,
    `- 执行性质：${report.chain.executionKind}`,
    `- 生成时间：${report.generatedAt}`,
    `- 代码版本：${report.codeVersion ?? "未验证"}`,
    `- runner 指纹：${report.runnerSha256 ?? "未验证"}`,
    `- 依赖代码指纹：${report.dependencyCodeSha256 ?? "未验证"}`,
    `- 依赖文件数：${report.dependencyFileCount ?? "未验证"}`,
    `- models.yaml 原始字节指纹：${report.modelsConfigSha256 ?? "未验证"}`,
    `- expected：${report.integrity.expected}`,
    `- succeeded：${report.integrity.succeeded}`,
    `- failed：${report.integrity.failed}`,
    `- executionComplete：${report.executionComplete ? "true" : "false"}`,
    `- accuracyPassed：${report.accuracyPassed ? "true" : "false"}`,
    `- anchorsProvisional：${report.anchorsProvisional === null ? "未验证" : String(report.anchorsProvisional)}`,
    `- anchorsEligible：${report.anchorsEligible ? "true" : "false"}`,
    `- eligible：${report.eligible ? "true" : "false"}`,
    `- 配置指纹：${report.configurationFingerprint ?? "未能建立"}`,
    `- 模型服务身份指纹：${report.providerIdentityFingerprint ?? "未能建立"}`,
    `- 数据集用途：${report.dataset.purpose}（public83 已参与调参，不是最终盲测集）`,
    `- MAE（平均绝对误差）：${report.summary.meanAbsoluteError.toFixed(1)}`,
    `- ±200 命中率：${(report.summary.hitRateWithin200 * 100).toFixed(1)}%`,
    `- 准确性门槛：MAE ≤ ${difficultyAccuracyThresholds.maximumMeanAbsoluteError}，±200 命中率 ≥ ${(difficultyAccuracyThresholds.minimumHitRateWithin200 * 100).toFixed(0)}%`,
    ""
  ];
  if (!report.executionComplete) {
    lines.push(
      "> 本次运行不完整，不得用它宣布准确率或调优提升。固定错误码见同 runId 的 JSON 报告。",
      ""
    );
  }
  lines.push(
    "## 分档统计",
    "",
    "| 难度档 | 样本数 | MAE |",
    "| --- | --- | --- |"
  );
  for (const bucket of Object.keys(report.summary.byBucket).map(Number).sort((a, b) => a - b)) {
    const stats = report.summary.byBucket[bucket];
    if (stats !== undefined) {
      lines.push(`| ${bucket} | ${stats.count} | ${stats.meanAbsoluteError.toFixed(1)} |`);
    }
  }
  lines.push(
    "",
    "## 逐题结果",
    "",
    "| 题号 | 真实难度 | 预测难度 | 误差 | 置信度 |",
    "| --- | --- | --- | --- | --- |"
  );
  for (const row of report.rows) {
    lines.push(
      `| CF ${row.contestId}${row.index} | ${row.actualRating} | ${row.predictedRating} | ${row.error} | ${row.confidence.toFixed(2)} |`
    );
  }
  lines.push(
    "",
    "> 注意：本次评测的题解字段是占位文字，比正式使用时（有真实题解）更难，结果仅供参考。"
  );
  return lines.join("\n");
}

function writeReports(
  report: DifficultyReport,
  persistedRows: readonly PersistedEvalRow[]
): EvaluationReportArtifactGroup {
  return writeEvaluationReportArtifactGroup({
    resultsDirectory: RESULTS_DIR,
    rawDirectory: RAW_RESULTS_DIR,
    prefix: "difficulty",
    executionRunId: report.runId,
    chainRunId: report.chain.chainRunId,
    experimentComplete: report.executionComplete,
    // 只保存可复核的数值结果；模型原始理由不进入报告或检查点。
    rawJson: `${JSON.stringify({ report, rows: persistedRows }, null, 2)}\n`,
    summaryJson: `${JSON.stringify(report, null, 2)}\n`,
    markdown: `${renderMarkdown(report)}\n`
  });
}

function incompleteBeforeCalls(input: {
  readonly runId: string;
  readonly label: string;
  readonly generatedAt: string;
  readonly fileCount: number;
  readonly expectedIds: readonly string[];
  readonly failures: readonly EvaluationFailure[];
  readonly codeVersion?: string | null;
  readonly codeIdentity?: EvaluationCodeIdentity | null;
  readonly modelsConfigSha256?: string | null;
  readonly manifest?: DifficultyReport["dataset"]["manifest"];
  readonly configurationFingerprint?: string | null;
  readonly providerIdentityFingerprint?: string | null;
  readonly anchorsProvisional?: boolean;
  readonly excludedAnchors?: number;
  readonly persistedRows?: readonly PersistedEvalRow[];
  readonly chain?: DifficultyReport["chain"];
}): void {
  const failureIds = new Set(input.failures.map((failure) => failure.sampleId));
  const succeededSampleIds = (input.persistedRows ?? []).map((row) => row.sampleId);
  const succeededIds = new Set(succeededSampleIds);
  const blocked = input.expectedIds
    .filter((sampleId) => !failureIds.has(sampleId) && !succeededIds.has(sampleId))
    .map((sampleId): EvaluationFailure => ({
      sampleId,
      phase: "setup",
      code: "EVALUATION_BLOCKED_BY_PREFLIGHT"
    }));
  const integrity = reconcileEvaluation({
    expectedSampleIds: input.expectedIds,
    succeededSampleIds,
    failures: [...input.failures, ...blocked]
  });
  const rows: EvalRow[] = (input.persistedRows ?? []).map(
    ({ sampleId: _sampleId, ...row }) => row
  );
  const summary = summarize(rows);
  const eligibility = assessDifficultyEvaluationEligibility({
    integrityComplete: integrity.complete,
    expected: integrity.expected,
    summaryCount: summary.count,
    meanAbsoluteError: summary.meanAbsoluteError,
    hitRateWithin200: summary.hitRateWithin200,
    manifestVerified: input.manifest?.verified ?? false,
    anchorsProvisional: input.anchorsProvisional ?? true
  });
  const report: DifficultyReport = {
    schemaVersion: 4,
    runId: input.runId,
    label: input.label,
    generatedAt: input.generatedAt,
    codeVersion: input.codeVersion ?? null,
    runnerSha256: input.codeIdentity?.runnerSha256 ?? null,
    dependencyCodeSha256: input.codeIdentity?.dependencyCodeSha256 ?? null,
    dependencyFileCount: input.codeIdentity?.dependencyFileCount ?? null,
    modelsConfigSha256: input.modelsConfigSha256 ?? null,
    configurationFingerprint: input.configurationFingerprint ?? null,
    providerIdentityFingerprint: input.providerIdentityFingerprint ?? null,
    anchorsProvisional: input.anchorsProvisional ?? null,
    ...eligibility,
    chain: input.chain ?? {
      chainRunId: null,
      originalReportRunId: null,
      createdAt: null,
      executionKind: "preflight"
    },
    dataset: {
      purpose: knownPublicDifficultyArchiveProfile.purpose,
      discoveredFiles: input.fileCount,
      excludedAnchors: input.excludedAnchors ?? 0,
      manifest: input.manifest ?? {
        enabled: false,
        expectedFiles: null,
        fingerprint: null,
        verified: false
      }
    },
    integrity,
    summary,
    rows
  };
  writeReports(report, input.persistedRows ?? []);
  process.exitCode = 1;
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
    // 固定失败码在完成数据目录的安全计数后写入报告；非法原值永不进入报告。
  }
  const preflight = preflightJsonDataset(DATA_DIR, datasetItemSchema);
  const allSourceIds = [
    ...preflight.sources.map((source) => source.sourceId),
    ...preflight.failures.filter((failure) => failure.phase === "dataset").map((failure) => failure.sampleId)
  ];
  if (codeVersion === null) {
    incompleteBeforeCalls({
      runId,
      label,
      generatedAt,
      fileCount: preflight.fileCount,
      expectedIds: allSourceIds,
      failures: [{
        sampleId: "evaluation-code-version",
        phase: "setup",
        code: rawCodeVersion === undefined
          ? "EVALUATION_CODE_VERSION_REQUIRED"
          : "EVALUATION_CODE_VERSION_INVALID"
      }],
      codeVersion: null
    });
    return;
  }
  let codeIdentity: EvaluationCodeIdentity;
  try {
    codeIdentity = loadEvaluationCodeIdentity({
      repositoryDirectory: REPOSITORY_DIRECTORY,
      expectedCodeVersion: codeVersion,
      runnerPath: RUNNER_REPOSITORY_PATH,
      dependencyPaths: difficultyEvaluationCodePaths
    });
  } catch {
    incompleteBeforeCalls({
      runId,
      label,
      generatedAt,
      fileCount: preflight.fileCount,
      expectedIds: allSourceIds,
      failures: [{
        sampleId: "evaluation-code-identity",
        phase: "setup",
        code: "EVALUATION_CODE_IDENTITY_INVALID"
      }],
      codeVersion
    });
    return;
  }
  const codeEvidence = { codeVersion, codeIdentity } as const;
  if (preflight.failures.length > 0 || preflight.fileCount === 0) {
    const failures = preflight.fileCount === 0 && preflight.failures.length === 0
      ? [{ sampleId: "dataset-empty", phase: "setup" as const, code: "DATASET_EMPTY" }]
      : preflight.failures;
    incompleteBeforeCalls({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      fileCount: preflight.fileCount,
      expectedIds: allSourceIds,
      failures
    });
    return;
  }

  if (
    hasUnknownPrefixedEnvironmentKeys(process.env, "EVAL_", [
      "EVAL_CODE_VERSION",
      "EVAL_CONCURRENCY",
      "EVAL_DATASET_MANIFEST_PATH",
      "EVAL_REQUIRE_DATASET_MANIFEST",
      "EVAL_SAMPLE_LIMIT",
      "EVAL_SAMPLE_IDS"
    ])
  ) {
    incompleteBeforeCalls({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      fileCount: preflight.fileCount,
      expectedIds: preflight.sources.map((source) => source.sourceId),
      failures: [{
        sampleId: "evaluation-environment",
        phase: "setup",
        code: "EVALUATION_UNKNOWN_ENVIRONMENT_KEY"
      }]
    });
    return;
  }

  // 正式基线可通过 EVAL_DATASET_MANIFEST_PATH 指向服务器上的私有 manifest。
  // 不使用 source 加载，不记录路径；manifest 不进 Git，报告只保存计数和指纹。
  const manifestPath = process.env.EVAL_DATASET_MANIFEST_PATH;
  // 准确性报告必须有可信 expected 集合；缺省就强制 manifest，
  // 防止在运行前删掉合法 JSON 后又从剩余文件重建一个“完整”集合。
  const requireManifestValue = process.env.EVAL_REQUIRE_DATASET_MANIFEST ?? "1";
  if (requireManifestValue !== "1") {
    incompleteBeforeCalls({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      fileCount: preflight.fileCount,
      expectedIds: preflight.sources.map((source) => source.sourceId),
      failures: [{
        sampleId: "dataset-manifest-requirement",
        phase: "setup",
        code: "DATASET_MANIFEST_REQUIRED"
      }],
      manifest: { enabled: true, expectedFiles: null, fingerprint: null, verified: false }
    });
    return;
  }
  if (requireManifestValue === "1" && manifestPath === undefined) {
    incompleteBeforeCalls({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      fileCount: preflight.fileCount,
      expectedIds: preflight.sources.map((source) => source.sourceId),
      failures: [{
        sampleId: "dataset-manifest",
        phase: "setup",
        code: "DATASET_MANIFEST_REQUIRED"
      }],
      manifest: { enabled: true, expectedFiles: null, fingerprint: null, verified: false }
    });
    return;
  }
  let manifestReport: DifficultyReport["dataset"]["manifest"] = {
    enabled: false,
    expectedFiles: null,
    fingerprint: null,
    verified: false
  };
  if (manifestPath !== undefined) {
    const loadedManifest = loadDifficultyDatasetManifest(manifestPath);
    if (loadedManifest.manifest === null) {
      incompleteBeforeCalls({
        runId,
        label,
        generatedAt,
        ...codeEvidence,
        fileCount: preflight.fileCount,
        expectedIds: preflight.sources.map((source) => source.sourceId),
        failures: loadedManifest.failures,
        manifest: {
          enabled: true,
          expectedFiles: null,
          fingerprint: null,
          verified: false
        }
      });
      return;
    }
    const verification = verifyDifficultyDatasetManifest(
      preflight.sources,
      loadedManifest.manifest
    );
    const profileFailures = verifyKnownPublicDifficultyArchiveProfile(
      preflight.sources,
      loadedManifest.manifest
    );
    manifestReport = {
      enabled: true,
      expectedFiles: loadedManifest.manifest.expectedFileCount,
      fingerprint: loadedManifest.fingerprint,
      verified: verification.failures.length === 0 && profileFailures.length === 0
    };
    if (verification.failures.length > 0 || profileFailures.length > 0) {
      incompleteBeforeCalls({
        runId,
        label,
        generatedAt,
        ...codeEvidence,
        fileCount: preflight.fileCount,
        expectedIds: verification.expectedSampleIds,
        failures: [...verification.failures, ...profileFailures],
        manifest: manifestReport
      });
      return;
    }
  }

  let strictAnchors;
  try {
    strictAnchors = loadDifficultyAnchorsStrict(ANCHORS_FILE);
  } catch (error) {
    logError("难度锚点文件不完整，不发起模型请求", error);
    incompleteBeforeCalls({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      fileCount: preflight.fileCount,
      expectedIds: preflight.sources.map((source) => source.sourceId),
      failures: [{ sampleId: "difficulty-anchors", phase: "setup", code: "DIFFICULTY_ANCHORS_INVALID" }],
      manifest: manifestReport
    });
    return;
  }
  const anchors = strictAnchors.anchors;
  const anchorKeys = new Set(anchors.map((anchor) => `${anchor.contestId}#${anchor.index}`));
  const excludedAnchorSources = preflight.sources.filter(
    (source) => anchorKeys.has(`${source.item.contestId}#${source.item.index}`)
  );
  let dataset = preflight.sources.filter(
    (source) => !anchorKeys.has(`${source.item.contestId}#${source.item.index}`)
  );
  const excludedAnchors = excludedAnchorSources.length;
  if (excludedAnchors > 0) {
    incompleteBeforeCalls({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      fileCount: preflight.fileCount,
      expectedIds: preflight.sources.map((source) => source.sourceId),
      failures: excludedAnchorSources.map((source) => ({
        sampleId: source.sourceId,
        phase: "dataset" as const,
        code: "DATASET_PROFILE_OVERLAPS_DIFFICULTY_ANCHORS"
      })),
      manifest: manifestReport,
      anchorsProvisional: strictAnchors.provisional,
      excludedAnchors
    });
    return;
  }

  const duplicateFailures: EvaluationFailure[] = [];
  const sourceIdsByProblem = new Map<string, string[]>();
  for (const source of dataset) {
    const key = `${source.item.contestId}#${source.item.index}`;
    const list = sourceIdsByProblem.get(key) ?? [];
    list.push(source.sourceId);
    sourceIdsByProblem.set(key, list);
  }
  for (const sourceIds of sourceIdsByProblem.values()) {
    if (sourceIds.length > 1) {
      duplicateFailures.push(
        ...sourceIds.map((sampleId) => ({
          sampleId,
          phase: "dataset" as const,
          code: "DATASET_SAMPLE_DUPLICATED"
        }))
      );
    }
  }
  if (dataset.length === 0 || duplicateFailures.length > 0) {
    incompleteBeforeCalls({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      fileCount: preflight.fileCount,
      expectedIds: dataset.map((source) => source.sourceId),
      failures:
        dataset.length === 0
          ? [{ sampleId: "dataset-after-anchor-exclusion", phase: "setup", code: "DATASET_EMPTY" }]
          : duplicateFailures,
      manifest: manifestReport,
      anchorsProvisional: strictAnchors.provisional
    });
    return;
  }

  // 公开 difficulty smoke 选择器：仅在完整 83 归档 + manifest + profile +
  // 锚点 + 去重全部通过之后应用。它把本次付费运行限定到恰好 4 个公开样本；
  // 任何解析/存在性失败都 fail closed，默认（不设置 env）保持全量行为不变。
  const boundedSelection = parsePublicDifficultyBoundedSelection({
    rawLimit: process.env.EVAL_SAMPLE_LIMIT,
    rawIds: process.env.EVAL_SAMPLE_IDS,
    availableSamples: dataset.map((source) => ({
      contestId: source.item.contestId,
      index: source.item.index
    }))
  });
  if (boundedSelection.failures.length > 0) {
    incompleteBeforeCalls({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      fileCount: preflight.fileCount,
      expectedIds: dataset.map((source) => source.sourceId),
      failures: boundedSelection.failures,
      manifest: manifestReport,
      anchorsProvisional: strictAnchors.provisional
    });
    return;
  }
  if (boundedSelection.enabled && boundedSelection.selection !== null) {
    const selectedKeys = new Set(
      boundedSelection.selection.map((entry) => `${entry.contestId}#${entry.index}`)
    );
    dataset = dataset.filter((source) =>
      selectedKeys.has(`${source.item.contestId}#${source.item.index}`)
    );
    if (dataset.length !== boundedSelection.selection.length) {
      incompleteBeforeCalls({
        runId,
        label,
        generatedAt,
        ...codeEvidence,
        fileCount: preflight.fileCount,
        expectedIds: dataset.map((source) => source.sourceId),
        failures: [{
          sampleId: "public-sample-selector",
          phase: "setup",
          code: "PUBLIC_SAMPLE_SELECTION_FAILED"
        }],
        manifest: manifestReport,
        anchorsProvisional: strictAnchors.provisional
      });
      return;
    }
  }

  let blindContent: BlindContentDataset;
  let blindGold: BlindGoldDataset<DifficultyBlindGold>;
  try {
    blindContent = buildBlindContentDataset({
      datasetId: knownPublicDifficultyArchiveProfile.datasetId,
      purpose: knownPublicDifficultyArchiveProfile.purpose,
      samples: dataset.map((source) => ({
        safeId: source.sourceId,
        problem: toReviewTaskProblem(source.sourceId, source.item)
      }))
    });
    const contentBySafeId = new Map(
      blindContent.samples.map((sample) => [sample.safeId, sample] as const)
    );
    blindGold = buildBlindGoldDataset({
      content: blindContent,
      goldSchema: difficultyBlindGoldSchema,
      samples: dataset.map((source) => {
        const content = contentBySafeId.get(source.sourceId);
        if (content === undefined) {
          throw new Error("DIFFICULTY_BLIND_CONTENT_MISSING");
        }
        return {
          safeId: source.sourceId,
          contentHash: content.problem.contentHash,
          gold: {
            contestId: source.item.contestId,
            index: source.item.index,
            actualRating: source.item.rating
          }
        };
      })
    });
  } catch {
    incompleteBeforeCalls({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      fileCount: preflight.fileCount,
      expectedIds: dataset.map((source) => source.sourceId),
      failures: [{
        sampleId: "difficulty-blind-dataset",
        phase: "setup",
        code: "BLIND_DATASET_PRECHECK_FAILED"
      }],
      manifest: manifestReport,
      anchorsProvisional: strictAnchors.provisional
    });
    return;
  }

  let concurrency: number;
  try {
    concurrency = parseBoundedPositiveInteger(
      process.env.EVAL_CONCURRENCY,
      6,
      32,
      "EVAL_CONCURRENCY"
    );
  } catch {
    incompleteBeforeCalls({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      fileCount: preflight.fileCount,
      expectedIds: dataset.map((source) => source.sourceId),
      failures: [{
        sampleId: "evaluation-concurrency",
        phase: "setup",
        code: "EVALUATION_CONCURRENCY_INVALID"
      }],
      manifest: manifestReport,
      anchorsProvisional: strictAnchors.provisional
    });
    return;
  }

  let config: AppConfig;
  let modelsConfigSha256: string | null = null;
  try {
    const modelsConfigBytes = readFileSync(MODELS_CONFIG_FILE);
    modelsConfigSha256 = createHash("sha256").update(modelsConfigBytes).digest("hex");
    config = loadConfig({ modelsYamlSource: modelsConfigBytes.toString("utf8") });
  } catch (error) {
    logError("实验配置校验失败，不发起模型请求", error);
    incompleteBeforeCalls({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      fileCount: preflight.fileCount,
      expectedIds: dataset.map((source) => source.sourceId),
      failures: [{ sampleId: "evaluation-config", phase: "setup", code: "EVALUATION_CONFIG_INVALID" }],
      manifest: manifestReport,
      modelsConfigSha256,
      anchorsProvisional: strictAnchors.provisional
    });
    return;
  }
  const profileName = config.models.defaults.modelProfileName;
  const profiles: Record<string, ProfileConfig | undefined> = config.models.profiles;
  const profile = profiles[profileName];
  if (profile === undefined) {
    incompleteBeforeCalls({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      fileCount: preflight.fileCount,
      expectedIds: dataset.map((source) => source.sourceId),
      failures: [{ sampleId: "evaluation-profile", phase: "setup", code: "EVALUATION_PROFILE_MISSING" }],
      manifest: manifestReport,
      modelsConfigSha256,
      anchorsProvisional: strictAnchors.provisional
    });
    return;
  }
  const credentials = getProviderCredentials(config, profile.difficulty.provider);
  if (credentials === undefined) {
    incompleteBeforeCalls({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      fileCount: preflight.fileCount,
      expectedIds: dataset.map((source) => source.sourceId),
      failures: [{ sampleId: "evaluation-provider", phase: "setup", code: "EVALUATION_PROVIDER_MISSING" }],
      manifest: manifestReport,
      modelsConfigSha256,
      anchorsProvisional: strictAnchors.provisional
    });
    return;
  }
  const providerIdentityFingerprint = difficultyProviderIdentityFingerprint(
    profile.difficulty.provider,
    credentials
  );
  const configurationFingerprint = difficultyEvaluationConfigurationFingerprint(codeVersion, {
    modelsConfigSha256,
    runnerSha256: codeIdentity.runnerSha256,
    dependencyCodeSha256: codeIdentity.dependencyCodeSha256,
    dependencyFileCount: codeIdentity.dependencyFileCount,
    experimentVersion: config.models.experimentVersion,
    modelProfileName: profileName,
    model: profile.difficulty,
    retry: config.models.retry,
    timeouts: config.models.timeouts,
    anchorsFingerprint: strictAnchors.fingerprint,
    anchorsProvisional: strictAnchors.provisional,
    datasetManifestFingerprint: manifestReport.fingerprint,
    datasetPurpose: blindContent.purpose,
    blindContentFingerprint: blindContent.contentFingerprint
  }, providerIdentityFingerprint);
  if (!manifestReport.verified || manifestReport.fingerprint === null) {
    incompleteBeforeCalls({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      fileCount: preflight.fileCount,
      expectedIds: dataset.map((source) => source.sourceId),
      failures: [{
        sampleId: "dataset-manifest",
        phase: "setup",
        code: "DATASET_MANIFEST_NOT_VERIFIED"
      }],
      manifest: manifestReport,
      modelsConfigSha256,
      configurationFingerprint,
      providerIdentityFingerprint,
      anchorsProvisional: strictAnchors.provisional,
      excludedAnchors
    });
    return;
  }
  const model = {
    spec: profile.difficulty,
    credentials,
    runtime: {
      firstOutputTimeoutMs: config.models.timeouts.llmFirstOutputMs,
      outputIdleTimeoutMs: config.models.timeouts.llmOutputIdleMs,
      maximumDurationMs: config.models.timeouts.llmMaximumDurationMs,
      maxAttempts: config.models.retry.maxAttempts,
      baseDelayMs: config.models.retry.baseDelayMs
    }
  };

  const expectedSampleIds = dataset.map((source) => source.sourceId);
  let checkpoint: DifficultyEvaluationCheckpoint;
  try {
    checkpoint = new DifficultyEvaluationCheckpoint({
      label,
      reportRunId: runId,
      datasetManifestFingerprint: manifestReport.fingerprint,
      configurationFingerprint,
      expectedSampleIds
    });
  } catch (error) {
    logError("难度评测检查点不可用，不发起模型请求", error);
    incompleteBeforeCalls({
      runId,
      label,
      generatedAt,
      ...codeEvidence,
      fileCount: preflight.fileCount,
      expectedIds: expectedSampleIds,
      failures: [{
        sampleId: "difficulty-checkpoint",
        phase: "setup",
        code: "DIFFICULTY_CHECKPOINT_UNAVAILABLE"
      }],
      manifest: manifestReport,
      modelsConfigSha256,
      configurationFingerprint,
      providerIdentityFingerprint,
      anchorsProvisional: strictAnchors.provisional,
      excludedAnchors
    });
    return;
  }

  try {
    const checkpointState = checkpoint.snapshot();
    const chain: DifficultyReport["chain"] = {
      chainRunId: checkpointState.chainRunId,
      originalReportRunId: checkpointState.reportRunId,
      createdAt: checkpointState.createdAt,
      executionKind: checkpoint.openedExistingCheckpoint() ? "resume" : "new"
    };
    if (
      checkpoint.hasPublishedCompleteReport() ||
      completedEvaluationChainMarkerExists(
        RESULTS_DIR,
        "difficulty",
        checkpointState.chainRunId
      )
    ) {
      // 固定 chain marker 与私有 checkpoint 任一显示已发布，就拒绝零调用重放；
      // 不生成第二份看似独立的 complete 报告。
      logError("这个 difficulty 实验链已经发布完整报告，拒绝重复生成");
      incompleteBeforeCalls({
        runId,
        label,
        generatedAt,
        ...codeEvidence,
        fileCount: preflight.fileCount,
        expectedIds: expectedSampleIds,
        failures: [{
          sampleId: "difficulty-complete-chain-replay",
          phase: "setup",
          code: "EVALUATION_COMPLETE_CHAIN_REPLAY_BLOCKED"
        }],
        manifest: manifestReport,
        modelsConfigSha256,
        configurationFingerprint,
        providerIdentityFingerprint,
        anchorsProvisional: strictAnchors.provisional,
        excludedAnchors,
        persistedRows: scoreDifficultyPredictions(
          blindContent,
          blindGold,
          checkpoint.succeededPredictions()
        ),
        chain: { ...chain, executionKind: "replay_blocked" }
      });
      return;
    }

    const continuation = await continueDifficultyEvaluationUnlessContaminated({
      checkpoint,
      expectedSampleIds,
      continueClean: async (): Promise<EvaluationFailure | null> => {
        const pendingIds = checkpoint.pendingSampleIds();
        if (pendingIds.length === 0) {
          return null;
        }
        const pendingContent = deriveBlindContentSubset(
          blindContent,
          pendingIds
        );
        let done = dataset.length - pendingContent.samples.length;
        try {
          await runBlindInference({
            content: pendingContent,
            concurrency,
            // 这是付费调用的提交点。只有 active 已经 fsync 并原子替换成功后，
            // 才允许进入 inferDifficultyBlindSample。
            beforeInference: (sample) => {
              checkpoint.markActive(sample.safeId);
            },
            infer: (sample) => inferDifficultyBlindSample({ sample, anchors, model }),
            // 这里只冻结预测；整批在途请求全部收束后，外层才允许连接 gold。
            afterInference: (prediction) => {
              const checkpointPrediction: DifficultyCheckpointPrediction = {
                contentHash: prediction.contentHash,
                predictedRating: prediction.prediction.predictedRating,
                confidence: prediction.prediction.confidence
              };
              checkpoint.markSucceeded(
                prediction.safeId,
                checkpointPrediction
              );
              done += 1;
              logInfo("完成一题的难度盲评", {
                sampleId: prediction.safeId,
                progress: `${done}/${dataset.length}`
              });
            },
            onInferenceError: (sample, error) => {
              done += 1;
              const failure = executionFailure(sample.safeId, error);
              checkpoint.markFailed(sample.safeId, failure);
              logError("这一题的难度评定失败，停止发起后续请求", error, {
                sampleId: sample.safeId,
                progress: `${done}/${dataset.length}`
              });
              throw new Error("DIFFICULTY_EVALUATION_SAMPLE_FAILED");
            }
          });
          return null;
        } catch (error) {
          logError("难度评测已安全停止，不再发起后续请求", error);
          return {
            sampleId: "difficulty-evaluation-orchestration",
            phase: "setup",
            code: "DIFFICULTY_EVALUATION_STOPPED"
          };
        }
      }
    });

    let persistedRows: PersistedEvalRow[];
    let integrity: EvaluationCompleteness;
    if (continuation.kind === "contaminated") {
      persistedRows = scoreDifficultyPredictions(
        blindContent,
        blindGold,
        continuation.persistedPredictions
      );
      integrity = continuation.integrity;
      logInfo("既有 difficulty 链含永久失败证据，直接写不完整报告", {
        terminalFailures: continuation.terminalFailures.length,
        pendingMissing: integrity.failures.filter(
          (failure) => failure.code === "EVALUATION_SAMPLE_MISSING"
        ).length
      });
    } else {
      const orchestrationFailure = continuation.value;
      persistedRows = scoreDifficultyPredictions(
        blindContent,
        blindGold,
        checkpoint.succeededPredictions()
      );
      const executionFailures = checkpoint.terminalFailures();
      integrity = reconcileEvaluation({
        expectedSampleIds,
        succeededSampleIds: persistedRows.map((row) => row.sampleId),
        failures: [
          ...executionFailures,
          ...(orchestrationFailure === null ? [] : [orchestrationFailure])
        ]
      });
    }
    const rows: EvalRow[] = persistedRows.map(({ sampleId: _sampleId, ...row }) => row);
    const summary = summarize(rows);
    const eligibility = assessDifficultyEvaluationEligibility({
      integrityComplete: integrity.complete,
      expected: integrity.expected,
      summaryCount: summary.count,
      meanAbsoluteError: summary.meanAbsoluteError,
      hitRateWithin200: summary.hitRateWithin200,
      manifestVerified: manifestReport.verified,
      anchorsProvisional: strictAnchors.provisional
    });
    const report: DifficultyReport = {
      schemaVersion: 4,
      runId,
      label,
      generatedAt,
      codeVersion,
      runnerSha256: codeIdentity.runnerSha256,
      dependencyCodeSha256: codeIdentity.dependencyCodeSha256,
      dependencyFileCount: codeIdentity.dependencyFileCount,
      modelsConfigSha256,
      configurationFingerprint,
      providerIdentityFingerprint,
      anchorsProvisional: strictAnchors.provisional,
      ...eligibility,
      chain,
      dataset: {
        purpose: knownPublicDifficultyArchiveProfile.purpose,
        discoveredFiles: preflight.fileCount,
        excludedAnchors,
        manifest: manifestReport
      },
      integrity,
      summary,
      rows
    };
    const artifacts = writeReports(report, persistedRows);
    if (report.executionComplete) {
      // completion marker 已最后落盘；再把其哈希封存进私有检查点。两者任一存在
      // 都会阻止完整链被零调用重复发布。
      checkpoint.markCompleteReportPublished(runId, artifacts.completionFingerprint);
    }

    logInfo("难度评测收束", {
      label,
      expected: integrity.expected,
      succeeded: integrity.succeeded,
      failed: integrity.failed,
      complete: integrity.complete,
      accuracyPassed: report.accuracyPassed,
      eligible: report.eligible,
      meanAbsoluteError: report.summary.meanAbsoluteError,
      hitRateWithin200: report.summary.hitRateWithin200
    });
    if (!report.eligible) {
      process.exitCode = 1;
    }
  } finally {
    checkpoint.close();
  }
}

main().catch((error: unknown) => {
  logError("experiments/eval-difficulty.ts 执行失败", error);
  process.exitCode = 1;
});
