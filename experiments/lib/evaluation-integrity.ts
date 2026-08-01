/**
 * 旧评测脚本曾把损坏数据和单题请求失败当成“跳过”，最后仍生成一份
 * 看似成功的部分报告。这个模块把评测完整性所需的纯逻辑和严格读取收在一处：
 *
 * - 付费请求之前就给每个数据文件分配一个不含文件名的稳定 sourceId；
 * - 损坏文件、符号链接和非普通文件一律记为失败，不宽松跳过；
 * - 按 expected sample id 对账，自动找出缺失、重复结果和未预期结果；
 * - 报告文件使用 wx 写入，绝不覆盖之前的实验证据。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
  type Dirent
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import type { ZodType } from "zod";
import { describeError } from "../../src/logger";

export interface EvaluationFailure {
  readonly sampleId: string;
  readonly phase: "dataset" | "execution" | "reconciliation" | "setup";
  readonly code: string;
  readonly httpStatus?: number;
}

export interface EvaluationCompleteness {
  readonly expected: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly complete: boolean;
  readonly failures: readonly EvaluationFailure[];
}

export interface DatasetSource<T> {
  readonly sourceId: string;
  /** 原始 JSON 文件字节的 SHA-256，可与私有 manifest 对账而不记录文件内容。 */
  readonly fileSha256: string;
  readonly item: T;
}

export interface DatasetPreflight<T> {
  readonly fileCount: number;
  readonly sources: readonly DatasetSource<T>[];
  readonly failures: readonly EvaluationFailure[];
}

export interface DatasetPreflightOptions {
  readonly maximumFiles?: number;
  readonly maximumFileBytes?: number;
  readonly maximumTotalBytes?: number;
}

export function parseEvaluationLabel(raw: string, fallback: string): string {
  const label = raw.length === 0 ? fallback : raw;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(label)) {
    throw new Error(
      "实验标签必须以字母或数字开头，且只能包含字母、数字、点、下划线和短横线（最长 64 字符）。"
    );
  }
  return label;
}

export function parseBoundedPositiveInteger(
  raw: string | undefined,
  fallback: number,
  maximum: number,
  name: string
): number {
  const source = raw ?? String(fallback);
  if (!/^[1-9][0-9]*$/.test(source)) {
    throw new RangeError(`${name} 必须是 1 到 ${maximum} 之间的整数。`);
  }
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new RangeError(`${name} 必须是 1 到 ${maximum} 之间的整数。`);
  }
  return value;
}

/**
 * 评测代码版本由启动者显式提供，脚本不自行调用 Git，也不接受分支名或缩写。
 * 只允许完整的 40 位小写提交 SHA；全零值不是有效的提交身份。
 */
export function parseEvaluationCodeVersion(raw: string | undefined): string {
  if (raw === undefined) {
    throw new Error("EVALUATION_CODE_VERSION_REQUIRED");
  }
  if (!/^(?!0{40}$)[0-9a-f]{40}$/.test(raw)) {
    throw new Error("EVALUATION_CODE_VERSION_INVALID");
  }
  return raw;
}

/** 调用方只应记录布尔结果，不记录未知变量的名称或值。 */
export function hasUnknownPrefixedEnvironmentKeys(
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
  prefix: string,
  allowedKeys: readonly string[]
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(environment).some(
    (key) => key.startsWith(prefix) && !allowed.has(key)
  );
}

export function createEvaluationRunId(
  label: string,
  now: Date = new Date(),
  nonce: string = randomUUID()
): string {
  const safeLabel = parseEvaluationLabel(label, "run");
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const safeNonce = nonce.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  if (safeNonce.length < 8) {
    throw new Error("实验运行随机标识无效。");
  }
  return `${safeLabel}-${timestamp}-${safeNonce}`;
}

/** 只创建新文件；目标已存在时由文件系统拒绝，不会覆盖旧报告。 */
export function writeNewEvaluationFile(url: URL, contents: string): void {
  const targetPath = fileURLToPath(url);
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  let directoryDescriptor: number | undefined;
  let temporaryExists = false;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    temporaryExists = true;
    const bytes = Buffer.from(contents, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        offset
      );
      if (written <= 0) {
        throw new Error("short-write");
      }
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    // hard link 提供“目标不存在才发布”的原子语义；目标绝不会短暂出现半份内容。
    linkSync(temporaryPath, targetPath);
    unlinkSync(temporaryPath);
    temporaryExists = false;
    directoryDescriptor = openSync(
      dirname(targetPath),
      constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)
    );
    fsyncSync(directoryDescriptor);
  } catch {
    throw new Error("EVALUATION_REPORT_WRITE_FAILED");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 固定错误码，不记录路径。
      }
    }
    if (directoryDescriptor !== undefined) {
      try {
        closeSync(directoryDescriptor);
      } catch {
        // 固定错误码，不记录路径。
      }
    }
    if (temporaryExists) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // 只清理本次 UUID 临时文件。
      }
    }
  }
}

export interface EvaluationReportArtifactGroup {
  readonly rawFileName: string;
  readonly summaryFileName: string;
  readonly markdownFileName: string;
  readonly completionFileName: string;
  readonly completionFingerprint: string;
}

/** 完整实验链使用固定 chain marker；其存在即禁止再发布第二份 complete 报告。 */
export function completedEvaluationChainMarkerExists(
  resultsDirectory: URL,
  prefix: string,
  chainRunId: string
): boolean {
  assertSafeArtifactComponent(prefix, "EVALUATION_REPORT_PREFIX_INVALID");
  assertSafeArtifactComponent(chainRunId, "EVALUATION_REPORT_CHAIN_ID_INVALID");
  return existsSync(new URL(`${prefix}-chain-${chainRunId}-completion.json`, resultsDirectory));
}

/**
 * 先排他写 raw/summary/markdown，最后排他写绑定三者 SHA-256 的 completion marker。
 * 没有 marker 的半写目录永远不能被报告消费者视为一组完成的证据。
 */
export function writeEvaluationReportArtifactGroup(input: {
  readonly resultsDirectory: URL;
  readonly rawDirectory: URL;
  readonly prefix: string;
  readonly executionRunId: string;
  readonly chainRunId: string | null;
  readonly experimentComplete: boolean;
  readonly rawJson: string;
  readonly summaryJson: string;
  readonly markdown: string;
}): EvaluationReportArtifactGroup {
  assertSafeArtifactComponent(input.prefix, "EVALUATION_REPORT_PREFIX_INVALID");
  assertSafeArtifactComponent(input.executionRunId, "EVALUATION_REPORT_RUN_ID_INVALID");
  if (input.chainRunId !== null) {
    assertSafeArtifactComponent(input.chainRunId, "EVALUATION_REPORT_CHAIN_ID_INVALID");
  }
  if (input.experimentComplete && input.chainRunId === null) {
    throw new Error("EVALUATION_COMPLETE_REPORT_REQUIRES_CHAIN_ID");
  }

  const rawFileName = `${input.prefix}-${input.executionRunId}-raw.json`;
  const summaryFileName = `${input.prefix}-${input.executionRunId}-summary.json`;
  const markdownFileName = `${input.prefix}-${input.executionRunId}.md`;
  const completionFileName = input.experimentComplete
    ? `${input.prefix}-chain-${input.chainRunId}-completion.json`
    : `${input.prefix}-${input.executionRunId}-completion.json`;
  if (
    input.experimentComplete &&
    completedEvaluationChainMarkerExists(
      input.resultsDirectory,
      input.prefix,
      input.chainRunId!
    )
  ) {
    throw new Error("EVALUATION_CHAIN_ALREADY_PUBLISHED");
  }

  mkdirSync(input.resultsDirectory, { recursive: true });
  mkdirSync(input.rawDirectory, { recursive: true });
  writeNewEvaluationFile(new URL(rawFileName, input.rawDirectory), input.rawJson);
  writeNewEvaluationFile(new URL(summaryFileName, input.resultsDirectory), input.summaryJson);
  writeNewEvaluationFile(new URL(markdownFileName, input.resultsDirectory), input.markdown);

  const completionDocument = `${JSON.stringify({
    schemaVersion: 1,
    kind: "evaluation-report-completion",
    executionRunId: input.executionRunId,
    chainRunId: input.chainRunId,
    experimentComplete: input.experimentComplete,
    artifacts: {
      raw: { fileName: rawFileName, sha256: sha256Text(input.rawJson) },
      summary: { fileName: summaryFileName, sha256: sha256Text(input.summaryJson) },
      markdown: { fileName: markdownFileName, sha256: sha256Text(input.markdown) }
    }
  }, null, 2)}\n`;
  writeNewEvaluationFile(
    new URL(completionFileName, input.resultsDirectory),
    completionDocument
  );
  return {
    rawFileName,
    summaryFileName,
    markdownFileName,
    completionFileName,
    completionFingerprint: sha256Text(completionDocument)
  };
}

/**
 * 严格读取目录中的 JSON 数据。返回结构不包含原始文件名、路径或文本，
 * 可以安全放入汇总报告。
 */
export function preflightJsonDataset<T>(
  directory: URL,
  schema: ZodType<T>,
  options: DatasetPreflightOptions = {}
): DatasetPreflight<T> {
  const maximumFiles = options.maximumFiles ?? 1_000;
  const maximumFileBytes = options.maximumFileBytes ?? 2 * 1024 * 1024;
  const maximumTotalBytes = options.maximumTotalBytes ?? 128 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maximumFiles) || maximumFiles < 1 ||
    !Number.isSafeInteger(maximumFileBytes) || maximumFileBytes < 1 ||
    !Number.isSafeInteger(maximumTotalBytes) || maximumTotalBytes < 1
  ) {
    throw new RangeError("DATASET_PREFLIGHT_LIMIT_INVALID");
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return {
      fileCount: 0,
      sources: [],
      failures: [
        {
          sampleId: "dataset-directory",
          phase: "setup",
          code: "DATASET_DIRECTORY_UNREADABLE"
        }
      ]
    };
  }

  if (entries.length > maximumFiles) {
    return {
      fileCount: entries.length,
      sources: [],
      failures: [{
        sampleId: "dataset-file-count",
        phase: "setup",
        code: "DATASET_FILE_COUNT_EXCEEDED"
      }]
    };
  }

  const sources: DatasetSource<T>[] = [];
  const failures: EvaluationFailure[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const sourceId = sourceIdForName(entry.name);
    if (!entry.name.endsWith(".json")) {
      failures.push({
        sampleId: sourceId,
        phase: "dataset",
        code: "DATASET_UNEXPECTED_ENTRY"
      });
      continue;
    }
    if (!entry.isFile()) {
      failures.push({
        sampleId: sourceId,
        phase: "dataset",
        code: entry.isSymbolicLink() ? "DATASET_SYMLINK_REJECTED" : "DATASET_NON_FILE_REJECTED"
      });
      continue;
    }
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        new URL(encodeURIComponent(entry.name), directory),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
      );
      const before = fstatSync(descriptor, { bigint: true });
      if (!before.isFile()) {
        failures.push({ sampleId: sourceId, phase: "dataset", code: "DATASET_NON_FILE_REJECTED" });
        continue;
      }
      if (before.size > BigInt(maximumFileBytes)) {
        failures.push({ sampleId: sourceId, phase: "dataset", code: "DATASET_FILE_TOO_LARGE" });
        continue;
      }
      totalBytes += Number(before.size);
      if (totalBytes > maximumTotalBytes) {
        failures.push({ sampleId: sourceId, phase: "dataset", code: "DATASET_TOTAL_SIZE_EXCEEDED" });
        continue;
      }
      const sourceBytes = readFileSync(descriptor);
      const after = fstatSync(descriptor, { bigint: true });
      if (!sameFileSnapshot(before, after)) {
        failures.push({ sampleId: sourceId, phase: "dataset", code: "DATASET_FILE_CHANGED_DURING_READ" });
        continue;
      }
      let sourceText: string;
      try {
        sourceText = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
      } catch {
        failures.push({
          sampleId: sourceId,
          phase: "dataset",
          code: "DATASET_FILE_INVALID_UTF8"
        });
        continue;
      }
      const raw = JSON.parse(sourceText) as unknown;
      sources.push({
        sourceId,
        fileSha256: createHash("sha256").update(sourceBytes).digest("hex"),
        item: schema.parse(raw)
      });
    } catch (error) {
      failures.push({
        sampleId: sourceId,
        phase: "dataset",
        code: describeError(error) === "UNEXPECTED_ERROR" ? "DATASET_FILE_READ_FAILED" : "DATASET_FILE_INVALID"
      });
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // 文件内容和路径不进错误；关闭失败由进程回收描述符。
        }
      }
    }
  }
  return { fileCount: entries.length, sources, failures };
}

/** 将模型请求异常收窄为不含响应正文的固定错误码和可选 HTTP 状态码。 */
export function executionFailure(sampleId: string, error: unknown): EvaluationFailure {
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    Number.isInteger((error as { readonly status?: unknown }).status)
      ? ((error as { readonly status: number }).status)
      : undefined;
  return {
    sampleId,
    phase: "execution",
    code: describeError(error),
    ...(status === undefined ? {} : { httpStatus: status })
  };
}

/** expected 是付费请求前锁定的集合；没有结果的 id 会被显式补成缺失失败。 */
export function reconcileEvaluation(input: {
  readonly expectedSampleIds: readonly string[];
  readonly succeededSampleIds: readonly string[];
  readonly failures: readonly EvaluationFailure[];
}): EvaluationCompleteness {
  const expected = new Set(input.expectedSampleIds);
  if (expected.size !== input.expectedSampleIds.length) {
    throw new Error("expected sample id 存在重复。");
  }

  const successCounts = countIds(input.succeededSampleIds);
  const failureById = new Map<string, EvaluationFailure[]>();
  for (const failure of input.failures) {
    const list = failureById.get(failure.sampleId) ?? [];
    list.push(failure);
    failureById.set(failure.sampleId, list);
  }

  let succeeded = 0;
  const failures: EvaluationFailure[] = [];
  for (const sampleId of expected) {
    const successCount = successCounts.get(sampleId) ?? 0;
    const explicitFailures = failureById.get(sampleId) ?? [];
    successCounts.delete(sampleId);
    failureById.delete(sampleId);
    if (successCount === 1 && explicitFailures.length === 0) {
      succeeded += 1;
      continue;
    }
    if (explicitFailures.length > 0) {
      failures.push(...explicitFailures);
    } else {
      failures.push({
        sampleId,
        phase: "reconciliation",
        code: successCount === 0 ? "EVALUATION_SAMPLE_MISSING" : "EVALUATION_RESULT_DUPLICATED"
      });
    }
    if (successCount > 0 && explicitFailures.length > 0) {
      failures.push({
        sampleId,
        phase: "reconciliation",
        code: "EVALUATION_RESULT_CONFLICT"
      });
    }
  }

  for (const [sampleId] of successCounts) {
    failures.push({ sampleId, phase: "reconciliation", code: "EVALUATION_RESULT_UNEXPECTED" });
  }
  for (const remaining of failureById.values()) {
    failures.push(...remaining);
  }

  return {
    expected: expected.size,
    succeeded,
    failed: failures.length,
    complete: succeeded === expected.size && failures.length === 0,
    failures: failures.sort((left, right) =>
      `${left.sampleId}\0${left.code}`.localeCompare(`${right.sampleId}\0${right.code}`)
    )
  };
}

/** 对不含密钥/题面的配置快照做稳定哈希，用于实验报告溯源。 */
export function evaluationConfigurationFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** 让代码提交成为配置身份的必需部分，避免调用方只把它写进展示字段。 */
export function evaluationConfigurationFingerprintWithCodeVersion(
  codeVersion: string,
  configuration: unknown
): string {
  return evaluationConfigurationFingerprint({
    codeVersion: parseEvaluationCodeVersion(codeVersion),
    configuration
  });
}

/**
 * 锚点摘要会进入受跟踪配置，因此模型违令时不能截断后当作成功。
 * 这里只接受短、单行、无代码块且不含明显题面连续复述的文本。
 */
export function validateGeneratedAnchorSummary(statement: string, rawSummary: string): string {
  const summary = rawSummary.trim();
  const length = [...summary].length;
  if (
    length < 1 ||
    length > 80 ||
    /[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(summary) ||
    summary.includes("```")
  ) {
    throw new Error("ANCHOR_SUMMARY_FORMAT_INVALID");
  }

  const normalizedStatement = statement.replace(/\s+/g, "");
  const normalizedSummary = summary.replace(/\s+/g, "");
  const comparisonWindow = Math.min(12, [...normalizedSummary].length);
  if (comparisonWindow >= 8) {
    const characters = [...normalizedSummary];
    for (let index = 0; index + comparisonWindow <= characters.length; index += 1) {
      if (normalizedStatement.includes(characters.slice(index, index + comparisonWindow).join(""))) {
        throw new Error("ANCHOR_SUMMARY_VERBATIM_REPETITION");
      }
    }
  }
  return summary;
}

function sourceIdForName(name: string): string {
  return `source-${createHash("sha256").update(name, "utf8").digest("hex").slice(0, 16)}`;
}

function assertSafeArtifactComponent(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) {
    throw new Error(code);
  }
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function countIds(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function sameFileSnapshot(
  before: BigIntStats,
  after: BigIntStats
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
