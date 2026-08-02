/**
 * 从带私有 manifest 的 levels v5 标定集里，按难度均匀挑一批锚点题，
 * 用 LLM 生成简短摘要（不逐字照抄题面），写出 config/anchors/difficulty.json，
 * 供 difficulty 流水线做少样本参照。
 *
 * 只有全部摘要成功、候选文件与审计证据排他写入后，才原子替换
 * config/anchors/difficulty.json；部分结果绝不发布。
 *
 * 用法：
 *   npm run experiment:calibrate-anchors
 *   ANCHOR_COUNT=8 npm run experiment:calibrate-anchors
 */
import { mkdirSync } from "node:fs";
import { getProviderCredentials, loadConfig, type ProfileConfig, type ProviderCredentials } from "../src/config";
import { chatComplete, type ChatMessage } from "../src/llm";
import { logError, logInfo, logWarn } from "../src/logger";
import { difficultyAnchorsFileForExperimentSchema } from "./lib/difficulty-anchors-strict";
import {
  anchorDocumentFingerprint,
  prepareAnchorPublication,
  readValidatedAnchorSnapshot,
  validateAnchorCandidatesForPublication,
  type PreparedAnchorPublication,
  type ValidatedAnchorSnapshot
} from "./lib/anchor-publication";
import {
  acquireAnchorPublicationLock,
  type AnchorPublicationLock
} from "./lib/anchor-publication-lock";
import {
  createEvaluationRunId,
  evaluationConfigurationFingerprint,
  hasUnknownPrefixedEnvironmentKeys,
  parseBoundedPositiveInteger,
  parseEvaluationLabel,
  writeNewEvaluationFile,
  validateGeneratedAnchorSummary
} from "./lib/evaluation-integrity";
import {
  loadCalibrationDatasetDirectory,
  type CalibrationDatasetBundle,
  type CalibrationDatasetItem
} from "./lib/levels-calibration-state";

// 锚点应来自独立于评估集的数据（DATA_SUBDIR=levels），避免 few-shot 里
// 出现评估题本身；eval-difficulty 里还有按锚点排除的双保险。
const DATA_DIR = new URL("./data/levels/", import.meta.url);
const ANCHORS_FILE = new URL("../config/anchors/difficulty.json", import.meta.url);
const RESULTS_DIR = new URL("./results/", import.meta.url);
const RAW_RESULTS_DIR = new URL("./results/raw/", import.meta.url);
const RATING_MIN = 800;
const RATING_MAX = 3500;

function parseLabelArg(): string {
  const arg = process.argv.find((value) => value.startsWith("--label="));
  return parseEvaluationLabel(arg?.slice("--label=".length) ?? "", "anchors");
}

function parseAnchorCount(): number {
  return parseBoundedPositiveInteger(process.env.ANCHOR_COUNT, 7, 50, "ANCHOR_COUNT");
}

interface AnchorAuditEvent {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly label: string;
  readonly event: "started" | "incomplete" | "prepared" | "published" | "publish_failed";
  readonly generatedAt: string;
  readonly expected: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly complete: boolean;
  readonly published: boolean;
  readonly datasetManifestFingerprint: string;
  readonly configurationFingerprint: string;
  readonly previousAnchorFingerprint: string;
  readonly candidateAnchorFingerprint: string | null;
  readonly publicationState?: "previous_present" | "candidate_present" | "unknown";
}

function writeAuditEvent(event: AnchorAuditEvent): void {
  writeNewEvaluationFile(
    new URL(`anchors-${event.runId}-${event.event}.json`, RESULTS_DIR),
    `${JSON.stringify(event, null, 2)}\n`
  );
}

function publicationState(
  previousFingerprint: string,
  candidateFingerprint: string
): AnchorAuditEvent["publicationState"] {
  try {
    const current = readValidatedAnchorSnapshot(ANCHORS_FILE).fingerprint;
    if (current === candidateFingerprint) {
      return "candidate_present";
    }
    if (current === previousFingerprint) {
      return "previous_present";
    }
  } catch {
    // 只返回固定状态，不输出文件内容或底层路径。
  }
  return "unknown";
}

/** 在 [RATING_MIN, RATING_MAX] 里均匀选 count 个目标难度点。 */
function pickTargetRatings(count: number): number[] {
  if (count <= 1) {
    return [RATING_MIN];
  }
  const step = (RATING_MAX - RATING_MIN) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round((RATING_MIN + i * step) / 100) * 100);
}

/** 为每个目标难度点，从数据集里选一道 rating 最接近它的题（选过的不会重复选）。 */
function selectAnchorCandidates(
  dataset: readonly CalibrationDatasetItem[],
  targetRatings: readonly number[]
): CalibrationDatasetItem[] {
  const used = new Set<string>();
  const selected: CalibrationDatasetItem[] = [];
  for (const target of targetRatings) {
    let best: CalibrationDatasetItem | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const item of dataset) {
      const key = `${item.contestId}#${item.index}`;
      if (used.has(key)) {
        continue;
      }
      const distance = Math.abs(item.rating - target);
      if (distance < bestDistance) {
        best = item;
        bestDistance = distance;
      }
    }
    if (best !== undefined) {
      used.add(`${best.contestId}#${best.index}`);
      selected.push(best);
    } else {
      logWarn("这个目标难度附近没有找到还没被选过的候选题", { target });
    }
  }
  return selected;
}

async function summarize(
  statement: string,
  profile: ProfileConfig,
  credentials: ProviderCredentials,
  runtime: {
    firstOutputTimeoutMs: number;
    outputIdleTimeoutMs: number;
    maximumDurationMs: number;
    maxAttempts: number;
    baseDelayMs: number;
  }
): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "请用一句中文话概括下面这道算法竞赛题目在考什么、大致的解法方向，不要逐字复述题面原文，" +
        "不要超过 80 个字，只输出这一句话本身。"
    },
    { role: "user", content: statement }
  ];
  const result = await chatComplete(credentials, profile.difficulty, messages, runtime);
  return result.content.trim();
}

async function main(): Promise<void> {
  const label = parseLabelArg();
  const runId = createEvaluationRunId(label);
  if (
    hasUnknownPrefixedEnvironmentKeys(process.env, "EVAL_", []) ||
    hasUnknownPrefixedEnvironmentKeys(process.env, "ANCHOR_", ["ANCHOR_COUNT"]) ||
    (process.env.DATA_SUBDIR !== undefined && process.env.DATA_SUBDIR !== "levels")
  ) {
    logError("锚点实验参数不受支持，不发起模型请求且不覆盖现有锚点");
    process.exitCode = 1;
    return;
  }
  const anchorCount = parseAnchorCount();
  let calibrationBundle: CalibrationDatasetBundle;
  try {
    // 与 levels v5 共用逐文件哈希清单和严格目录读取；manifest.private.json
    // 不会被误当成题目，缺题解、目录多文件或内容变化都会整体失败。
    calibrationBundle = loadCalibrationDatasetDirectory(DATA_DIR);
  } catch (error) {
    logError("锚点数据集预检失败，不发起模型请求且不覆盖现有锚点", error);
    process.exitCode = 1;
    return;
  }
  const dataset = calibrationBundle.items;

  const targetRatings = pickTargetRatings(anchorCount);
  const candidates = selectAnchorCandidates(dataset, targetRatings);
  if (candidates.length !== anchorCount) {
    logError("无法为每个目标难度绑定唯一锚点，不发起模型请求且不覆盖现有锚点", undefined, {
      expected: anchorCount,
      selected: candidates.length
    });
    process.exitCode = 1;
    return;
  }
  try {
    validateAnchorCandidatesForPublication(candidates);
  } catch {
    logError(
      "候选题不符合正式锚点契约，不发起模型请求且不覆盖现有锚点",
      undefined,
      { failureCode: "ANCHOR_CANDIDATE_CONTRACT_INVALID" }
    );
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();

  const profileName = config.models.defaults.modelProfileName;
  const profiles: Record<string, ProfileConfig | undefined> = config.models.profiles;
  const profile = profiles[profileName];
  if (profile === undefined) {
    logError("默认模型档位不存在，检查 config/models.yaml", undefined, { profileName });
    process.exitCode = 1;
    return;
  }
  const credentials = getProviderCredentials(config, profile.difficulty.provider);
  if (credentials === undefined) {
    logError("difficulty 流水线的 provider 没有配置密钥", undefined, { provider: profile.difficulty.provider });
    process.exitCode = 1;
    return;
  }

  let previousSnapshot: ValidatedAnchorSnapshot;
  try {
    previousSnapshot = readValidatedAnchorSnapshot(ANCHORS_FILE);
  } catch (error) {
    logError("现有锚点文件不可安全验证，不发起模型请求", error);
    process.exitCode = 1;
    return;
  }

  const runtime = {
    firstOutputTimeoutMs: config.models.timeouts.llmFirstOutputMs,
    outputIdleTimeoutMs: config.models.timeouts.llmOutputIdleMs,
    maximumDurationMs: config.models.timeouts.llmMaximumDurationMs,
    maxAttempts: config.models.retry.maxAttempts,
    baseDelayMs: config.models.retry.baseDelayMs
  };
  const configurationFingerprint = evaluationConfigurationFingerprint({
    experimentVersion: config.models.experimentVersion,
    modelProfileName: profileName,
    model: profile.difficulty,
    retry: config.models.retry,
    timeouts: config.models.timeouts,
    anchorCount,
    targetRatings,
    selectedSafeIds: candidates.map((candidate) => candidate.safeId),
    datasetManifestFingerprint: calibrationBundle.manifestHash,
    summaryValidationVersion: "single-line-nonverbatim-v1"
  });

  let publicationLock: AnchorPublicationLock;
  try {
    publicationLock = acquireAnchorPublicationLock({
      runId,
      targetFingerprint: previousSnapshot.fingerprint
    });
  } catch {
    logError(
      "正式锚点发布锁已被占用或不可安全建立，不发起模型请求",
      undefined,
      { failureCode: "ANCHOR_PUBLICATION_LOCKED_OR_UNAVAILABLE" }
    );
    process.exitCode = 1;
    return;
  }

  try {
    // 候选选择后到加锁前仍可能有另一轮发布；加锁后再次对账，避免为已过期
    // 的 previous 指纹发起任何付费调用。
    try {
      publicationLock.assertHeld();
      if (
        readValidatedAnchorSnapshot(ANCHORS_FILE).fingerprint !==
        previousSnapshot.fingerprint
      ) {
        throw new Error("target-changed");
      }
    } catch {
      logError(
        "加锁前后正式锚点已经变化，不发起模型请求",
        undefined,
        { failureCode: "ANCHOR_TARGET_CHANGED_BEFORE_GENERATION" }
      );
      process.exitCode = 1;
      return;
    }

  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(RAW_RESULTS_DIR, { recursive: true });
  const auditBase = {
    schemaVersion: 1 as const,
    runId,
    label,
    expected: anchorCount,
    datasetManifestFingerprint: calibrationBundle.manifestHash,
    configurationFingerprint,
    previousAnchorFingerprint: previousSnapshot.fingerprint
  };
  // 在第一笔付费请求前留下不可覆盖的开始证据；异常退出时不会冒充完整实验。
  writeAuditEvent({
    ...auditBase,
    event: "started",
    generatedAt: new Date().toISOString(),
    succeeded: 0,
    failed: 0,
    complete: false,
    published: false,
    candidateAnchorFingerprint: null
  });

  const anchors: Array<{ contestId: number; index: string; rating: number; summary: string }> = [];
  let generationFailed = false;
  for (const candidate of candidates) {
    try {
      const summary = validateGeneratedAnchorSummary(
        candidate.statement,
        await summarize(candidate.statement, profile, credentials, runtime)
      );
      anchors.push({ contestId: candidate.contestId, index: candidate.index, rating: candidate.rating, summary });
      logInfo("生成一条锚点", { contestId: candidate.contestId, index: candidate.index, rating: candidate.rating });
    } catch (error) {
      generationFailed = true;
      logError("生成锚点摘要失败，本次结果不完整", error, {
        contestId: candidate.contestId,
        index: candidate.index
      });
      break;
    }
  }

  if (generationFailed || anchors.length !== candidates.length || anchors.length !== anchorCount) {
    writeAuditEvent({
      ...auditBase,
      event: "incomplete",
      generatedAt: new Date().toISOString(),
      succeeded: anchors.length,
      failed: anchorCount - anchors.length,
      complete: false,
      published: false,
      candidateAnchorFingerprint: null
    });
    logError("锚点生成不完整，不覆盖现有文件", undefined, {
      expected: anchorCount,
      succeeded: anchors.length,
      failed: anchorCount - anchors.length,
      complete: false
    });
    process.exitCode = 1;
    return;
  }

  const payload = difficultyAnchorsFileForExperimentSchema.parse({
    provisional: false,
    note:
      `由 experiments/calibrate-anchors.ts 于 ${new Date().toISOString()} 从 ${dataset.length} 道题的数据集中` +
      "生成，摘要由 LLM 概括。数据集本身会随实际抓取时间/样本变化，如果难度评定表现明显偏离预期，" +
      "应该重新跑一遍生成脚本。",
    anchors
  });
  const serializedPayload = `${JSON.stringify(payload, null, 2)}\n`;
  const candidateFingerprint = anchorDocumentFingerprint(serializedPayload);
  let publication: PreparedAnchorPublication;
  try {
    // 原始目录只保存“修改前/候选”两份已校验配置，不含题面、题解或模型原始响应。
    // 这里还会重新校验现有文件未在付费生成期间发生变化。
    publicationLock.assertHeld();
    publication = prepareAnchorPublication({
      target: ANCHORS_FILE,
      beforeSnapshot: new URL(`anchors-${runId}-before.private.json`, RAW_RESULTS_DIR),
      candidateSnapshot: new URL(`anchors-${runId}-candidate.private.json`, RAW_RESULTS_DIR),
      expectedPreviousFingerprint: previousSnapshot.fingerprint,
      candidateDocument: serializedPayload
    });
  } catch (error) {
    writeAuditEvent({
      ...auditBase,
      event: "publish_failed",
      generatedAt: new Date().toISOString(),
      succeeded: anchors.length,
      failed: 1,
      complete: false,
      published: false,
      candidateAnchorFingerprint: candidateFingerprint,
      publicationState: publicationState(previousSnapshot.fingerprint, candidateFingerprint)
    });
    logError("锚点发布准备失败，保留现有配置", error);
    process.exitCode = 1;
    return;
  }
  writeAuditEvent({
    ...auditBase,
    event: "prepared",
    generatedAt: new Date().toISOString(),
    succeeded: anchors.length,
    failed: 0,
    complete: false,
    published: false,
    candidateAnchorFingerprint: candidateFingerprint,
    publicationState: "previous_present"
  });

  try {
    // 同目录临时文件先 fsync，再 rename 和 fsync 父目录；不会暴露半份 JSON。
    publicationLock.assertHeld();
    publication.publish();
  } catch (error) {
    writeAuditEvent({
      ...auditBase,
      event: "publish_failed",
      generatedAt: new Date().toISOString(),
      succeeded: anchors.length,
      failed: 1,
      complete: false,
      published: false,
      candidateAnchorFingerprint: candidateFingerprint,
      publicationState: publicationState(previousSnapshot.fingerprint, candidateFingerprint)
    });
    logError("锚点原子发布失败，不能把本次结果视为完整", error);
    process.exitCode = 1;
    return;
  }

  writeAuditEvent({
    ...auditBase,
    event: "published",
    generatedAt: new Date().toISOString(),
    succeeded: anchors.length,
    failed: 0,
    complete: true,
    published: true,
    candidateAnchorFingerprint: candidateFingerprint,
    publicationState: "candidate_present"
  });
  logInfo("已原子发布完整锚点文件", { count: anchors.length, runId });
  } finally {
    if (!publicationLock.release()) {
      logError(
        "正式锚点发布锁无法证明已安全释放，后续运行必须按恢复文档人工核验",
        undefined,
        { failureCode: "ANCHOR_PUBLICATION_LOCK_RELEASE_FAILED" }
      );
      process.exitCode = 1;
    }
  }
}

main().catch((error: unknown) => {
  logError("experiments/calibrate-anchors.ts 执行失败", error);
  process.exitCode = 1;
});
