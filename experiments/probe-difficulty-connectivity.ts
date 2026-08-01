/**
 * Candidate C 恢复配置的单样本连通性/协议预检。
 *
 * 只发送一个人工合成短题，严格允许一次真实 fetch。成功必须同时满足当前
 * provider 身份、Git/runner/config/锚点绑定、请求体契约、结构化输出、
 * finish_reason=stop、HTTP 正常 EOF、dispatcher 关闭和标签锁安全释放。
 * 任何失败都只保存固定码与计数，不保存题面、模型内容、地址或密钥。
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EnvHttpProxyAgent } from "undici";
import { z } from "zod";
import {
  anchoredPrivatePath,
  closePrivateDirectory,
  preparePrivateDirectory,
  type PrivateDirectoryHandle
} from "../scripts/private-runtime.mjs";
import {
  getProviderCredentials,
  loadConfig,
  type ModelSpec,
  type ProviderCredentials
} from "../src/config";
import {
  createUndiciLlmFetch,
  type FetchLike,
  type LlmRequestError,
  type LlmResponseFormatFailureStage,
  type LlmRuntimeOptions
} from "../src/llm";
import { describeError } from "../src/logger";
import {
  runDifficultyPipeline,
  type DifficultyAnchor
} from "../src/pipelines/difficulty";
import type { ReviewTaskProblem } from "../src/pipelines/types";
import { loadDifficultyAnchorsStrict } from "./lib/difficulty-anchors-strict";
import { hasUnknownPrefixedEnvironmentKeys } from "./lib/evaluation-integrity";

export const difficultyConnectivityProbeExperimentVersion =
  "experiment-2026-08-difficulty-candidate-c-provider-v1-drain-v4";
export const difficultyConnectivityPreviousProbeLabels = [
  "difficulty-candidate-c-connectivity-probe-20260801-a",
  "difficulty-candidate-c-connectivity-probe-20260801-b"
] as const;
export const difficultyConnectivityProbeLabel =
  "difficulty-candidate-c-connectivity-probe-20260801-c";
export const difficultyConnectivityProbeMaxOutputTokens = 2_048;

const repositoryDirectory = fileURLToPath(new URL("../", import.meta.url));
const runnerRepositoryPath = "experiments/probe-difficulty-connectivity.ts";
const resultsDirectory = fileURLToPath(
  new URL("../private/difficulty-connectivity-probe-results/", import.meta.url)
);
const modelsConfigUrl = new URL("../config/models.yaml", import.meta.url);
const anchorsConfigUrl = new URL("../config/anchors/difficulty.json", import.meta.url);
const checkpointFileName = `${difficultyConnectivityProbeLabel}.checkpoint.private.json`;
const lockFileName = `${difficultyConnectivityProbeLabel}.lock.private`;
export const difficultyConnectivityProbeCompletionFileName =
  `${difficultyConnectivityProbeLabel}.completion.private.json`;
export const difficultyConnectivityExpectedModelsConfigSha256 =
  "fcc7f9f8805c2c8bec3c909dc66b85c025363cb14c2c6e053d8e36313f826703";
const expectedCandidateCAnchorsSha256 =
  "48b4c5f95732347b2a0a48f4143f50dbc6bc6706f427aa75179def45988b9a7f";
// 旧 a 探针确认根路径配置会命中不存在的 chat/completions；当前身份只把
// baseUrl pathname 修正为 /v1，密钥及其它环境变量不变。这里只保存单向摘要。
export const difficultyConnectivityExpectedProviderIdentitySha256 =
  "6e913442f0833b7950c9ae934e46f437dad6ffd72bf847fbe3acee058256050c";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const gitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const processStartTimeTicksSchema = z.string().regex(/^[1-9][0-9]*$/u);

export const difficultyConnectivityProbeRequestBodySchema = z
  .object({
    model: z.literal("deepseek-v4-flash"),
    temperature: z.literal(0.2),
    stream: z.literal(true),
    messages: z.array(z.unknown()).min(1),
    thinking: z.object({ type: z.literal("disabled") }).strict(),
    max_tokens: z.literal(difficultyConnectivityProbeMaxOutputTokens)
  })
  .strict();

export const difficultyConnectivityProbeLockRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("difficulty-connectivity-probe-lock"),
    label: z.literal(difficultyConnectivityProbeLabel),
    processId: z.number().int().positive(),
    processStartTimeTicks: processStartTimeTicksSchema,
    codeVersion: gitCommitSchema,
    acquiredAt: z.string().datetime(),
    recoveryRule: z.literal(
      "VERIFY_PID_START_TIME_FULL_COMMAND_AND_CWD_BEFORE_MANUAL_REMOVAL"
    )
  })
  .strict();
export type DifficultyConnectivityProbeLockRecord = z.infer<
  typeof difficultyConnectivityProbeLockRecordSchema
>;

export interface DifficultyConnectivityProbeResult {
  readonly sampleId: "synthetic-connectivity-sum";
  readonly status: "succeeded" | "failed";
  readonly requestCount: number;
  readonly fetchInvocationCount: number;
  readonly httpStatus: number | null;
  readonly httpEofObserved: boolean;
  readonly responseBodyCancelled: boolean;
  readonly schemaValidated: true | null;
  readonly stopAndHttpEofVerified: true | null;
  readonly formatFailureStage: LlmResponseFormatFailureStage | null;
  readonly code: string;
}

export type DifficultyConnectivityCheckpointState =
  | "ready"
  | "active"
  | "succeeded"
  | "failed"
  | "completion_pending";

interface RequestGuardSnapshot {
  readonly requestCount: number;
  readonly fetchInvocationCount: number;
  readonly httpStatus: number | null;
  readonly httpEofObserved: boolean;
  readonly responseBodyCancelled: boolean;
  readonly contractViolation: boolean;
  readonly multipleRequestBlocked: boolean;
}

interface ProbeLabelLock {
  readonly record: DifficultyConnectivityProbeLockRecord;
  readonly release: () => boolean;
}

const safeLlmFailureCodes = new Set([
  "LLM_HTTP_ERROR",
  "LLM_NETWORK_FAILED",
  "LLM_FIRST_OUTPUT_TIMEOUT",
  "LLM_OUTPUT_IDLE_TIMEOUT",
  "LLM_TOTAL_TIMEOUT",
  "LLM_STREAM_INTERRUPTED",
  "LLM_CANCELLED",
  "LLM_OUTPUT_LENGTH_LIMIT",
  "LLM_OUTPUT_CONTENT_FILTERED",
  "LLM_RESPONSE_BODY_TOO_LARGE",
  "LLM_RESPONSE_FORMAT_INVALID",
  "LLM_JSON_OUTPUT_INVALID"
]);
const safeFormatFailureStages = new Set<LlmResponseFormatFailureStage>([
  "missing_body",
  "content_type",
  "json_utf8",
  "json_parse",
  "response_shape",
  "sse_utf8",
  "event_json",
  "event_shape",
  "delta_shape",
  "finish_shape",
  "trailing_data"
]);

const expectedCandidateCAnchors = [
  [1993, "A", 800],
  [2021, "C1", 1300],
  [2009, "F", 1700],
  [1998, "E1", 2200],
  [2003, "E1", 2600],
  [2027, "E2", 3100],
  [2013, "F2", 3500]
] as const;

export function sha256ConnectivityProbe(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function providerIdentityFingerprint(
  provider: "aether",
  credentials: ProviderCredentials
): string {
  return sha256ConnectivityProbe(JSON.stringify({
    schemaVersion: 1,
    provider,
    baseUrl: credentials.baseUrl,
    apiKey: credentials.apiKey
  }));
}

export function assertDifficultyConnectivityConfiguration(
  spec: ModelSpec,
  config: ReturnType<typeof loadConfig>
): void {
  if (
    config.models.experimentVersion !== difficultyConnectivityProbeExperimentVersion ||
    config.models.defaults.modelProfileName !== "review-balanced" ||
    spec.provider !== "aether" ||
    spec.model !== "deepseek-v4-flash" ||
    spec.temperature !== 0.2 ||
    spec.thinking !== false ||
    spec.thinkingRequest !== "disabled" ||
    spec.reasoningEffort !== undefined ||
    config.models.retry.maxAttempts !== 3 ||
    config.models.retry.baseDelayMs !== 500 ||
    config.models.timeouts.llmFirstOutputMs !== 1_800_000 ||
    config.models.timeouts.llmOutputIdleMs !== 600_000 ||
    config.models.timeouts.llmMaximumDurationMs !== 14_400_000
  ) {
    throw new Error("CONNECTIVITY_PROBE_CONFIGURATION_INVALID");
  }
}

export function assertDifficultyConnectivityAnchorSet(
  anchors: readonly DifficultyAnchor[],
  provisional: boolean
): void {
  const actual = anchors
    .map((anchor) => `${anchor.contestId}#${anchor.index}#${anchor.rating}`)
    .sort();
  const expected = expectedCandidateCAnchors
    .map(([contestId, index, rating]) => `${contestId}#${index}#${rating}`)
    .sort();
  if (provisional !== true || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("CONNECTIVITY_PROBE_CONFIGURATION_INVALID");
  }
}

export function assertDifficultyConnectivityRepositoryStatus(input: {
  readonly porcelain: string;
  readonly trackedPrivatePaths: string;
  readonly privatePathIgnored: boolean;
}): void {
  if (
    input.porcelain.length !== 0 ||
    input.trackedPrivatePaths.length !== 0 ||
    !input.privatePathIgnored
  ) {
    throw new Error("CONNECTIVITY_PROBE_REPOSITORY_NOT_CLEAN");
  }
}

function observeResponseEof(
  response: Response,
  state: { httpEofObserved: boolean; responseBodyCancelled: boolean }
): Response {
  if (response.body === null) {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }
  const reader = response.body.getReader();
  let released = false;
  const releaseReader = (): void => {
    if (released) return;
    released = true;
    try {
      reader.releaseLock();
    } catch {
      // 只记录 EOF/cancel 布尔量，不让清理错误替换固定结果。
    }
  };
  const monitored = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          state.httpEofObserved = true;
          releaseReader();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        releaseReader();
        controller.error(error);
      }
    },
    cancel: async (reason) => {
      state.responseBodyCancelled = true;
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
    }
  });
  return new Response(monitored, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

export function createDifficultyConnectivitySingleFetchGuard(input: {
  readonly baseFetch: FetchLike;
  readonly expectedUrl: string;
  readonly expectedAuthorization: string;
}): { readonly fetch: FetchLike; readonly snapshot: () => RequestGuardSnapshot } {
  let requestCount = 0;
  let fetchInvocationCount = 0;
  let httpStatus: number | null = null;
  const responseState = {
    httpEofObserved: false,
    responseBodyCancelled: false
  };
  let contractViolation = false;
  let multipleRequestBlocked = false;

  const fetch: FetchLike = async (url, init) => {
    fetchInvocationCount += 1;
    if (fetchInvocationCount > 1) {
      multipleRequestBlocked = true;
      throw new Error("CONNECTIVITY_PROBE_MULTIPLE_REQUEST_BLOCKED");
    }
    try {
      difficultyConnectivityProbeRequestBodySchema.parse(
        JSON.parse(String(init?.body)) as unknown
      );
      const headers = new Headers(init?.headers);
      if (
        String(url) !== input.expectedUrl ||
        init?.method !== "POST" ||
        headers.get("authorization") !== input.expectedAuthorization ||
        headers.get("content-type") !== "application/json"
      ) {
        throw new Error("request-contract");
      }
    } catch {
      contractViolation = true;
      throw new Error("CONNECTIVITY_PROBE_REQUEST_CONTRACT_INVALID");
    }
    requestCount += 1;
    const response = await input.baseFetch(url, init);
    httpStatus = response.status;
    return observeResponseEof(response, responseState);
  };

  return {
    fetch,
    snapshot: () => ({
      requestCount,
      fetchInvocationCount,
      httpStatus,
      ...responseState,
      contractViolation,
      multipleRequestBlocked
    })
  };
}

function emptyGuardSnapshot(): RequestGuardSnapshot {
  return {
    requestCount: 0,
    fetchInvocationCount: 0,
    httpStatus: null,
    httpEofObserved: false,
    responseBodyCancelled: false,
    contractViolation: false,
    multipleRequestBlocked: false
  };
}

function failedResult(
  snapshot: Pick<
    RequestGuardSnapshot,
    | "requestCount"
    | "fetchInvocationCount"
    | "httpStatus"
    | "httpEofObserved"
    | "responseBodyCancelled"
  >,
  code: string,
  formatFailureStage: LlmResponseFormatFailureStage | null = null
): DifficultyConnectivityProbeResult {
  return {
    sampleId: "synthetic-connectivity-sum",
    status: "failed",
    requestCount: snapshot.requestCount,
    fetchInvocationCount: snapshot.fetchInvocationCount,
    httpStatus: snapshot.httpStatus,
    httpEofObserved: snapshot.httpEofObserved,
    responseBodyCancelled: snapshot.responseBodyCancelled,
    schemaValidated: null,
    stopAndHttpEofVerified: null,
    formatFailureStage,
    code
  };
}

function safeFailureCode(error: unknown, snapshot: RequestGuardSnapshot): string {
  if (snapshot.multipleRequestBlocked) {
    return "CONNECTIVITY_PROBE_MULTIPLE_REQUEST_BLOCKED";
  }
  if (snapshot.contractViolation) {
    return "CONNECTIVITY_PROBE_REQUEST_CONTRACT_INVALID";
  }
  const described = describeError(error);
  return safeLlmFailureCodes.has(described)
    ? described
    : "CONNECTIVITY_PROBE_UNCLASSIFIED_FAILURE";
}

function safeFormatFailureStage(
  error: unknown
): LlmResponseFormatFailureStage | null {
  if (typeof error !== "object" || error === null) return null;
  const stage = (error as Partial<LlmRequestError> & {
    readonly formatFailureStage?: unknown;
  }).formatFailureStage;
  return typeof stage === "string" &&
    safeFormatFailureStages.has(stage as LlmResponseFormatFailureStage)
    ? stage as LlmResponseFormatFailureStage
    : null;
}

export async function executeDifficultyConnectivityProbe(input: {
  readonly problem: ReviewTaskProblem;
  readonly anchors: readonly DifficultyAnchor[];
  readonly spec: ModelSpec;
  readonly credentials: ProviderCredentials;
  readonly runtime: Omit<LlmRuntimeOptions, "fetch">;
  readonly baseFetch: FetchLike;
}): Promise<DifficultyConnectivityProbeResult> {
  const expectedUrl = new URL(
    "chat/completions",
    input.credentials.baseUrl.endsWith("/")
      ? input.credentials.baseUrl
      : `${input.credentials.baseUrl}/`
  ).href;
  const guard = createDifficultyConnectivitySingleFetchGuard({
    baseFetch: input.baseFetch,
    expectedUrl,
    expectedAuthorization: `Bearer ${input.credentials.apiKey}`
  });
  try {
    await runDifficultyPipeline({
      problem: input.problem,
      anchors: input.anchors,
      model: {
        spec: input.spec,
        credentials: input.credentials,
        runtime: { ...input.runtime, fetch: guard.fetch }
      }
    });
    const snapshot = guard.snapshot();
    if (
      snapshot.requestCount !== 1 ||
      snapshot.fetchInvocationCount !== 1 ||
      snapshot.httpStatus !== 200 ||
      !snapshot.httpEofObserved ||
      snapshot.responseBodyCancelled
    ) {
      return failedResult(snapshot, "CONNECTIVITY_PROBE_RESULT_CONTRACT_INVALID");
    }
    return {
      sampleId: "synthetic-connectivity-sum",
      status: "succeeded",
      requestCount: 1,
      fetchInvocationCount: 1,
      httpStatus: 200,
      httpEofObserved: true,
      responseBodyCancelled: false,
      schemaValidated: true,
      stopAndHttpEofVerified: true,
      formatFailureStage: null,
      code: "CONNECTIVITY_PROBE_SUCCEEDED"
    };
  } catch (error) {
    const snapshot = guard.snapshot();
    return failedResult(
      snapshot,
      safeFailureCode(error, snapshot),
      safeFormatFailureStage(error)
    );
  }
}

export function isCompleteDifficultyConnectivityResult(
  result: DifficultyConnectivityProbeResult
): boolean {
  return (
    result.sampleId === "synthetic-connectivity-sum" &&
    result.status === "succeeded" &&
    result.requestCount === 1 &&
    result.fetchInvocationCount === 1 &&
    result.httpStatus === 200 &&
    result.httpEofObserved &&
    !result.responseBodyCancelled &&
    result.schemaValidated === true &&
    result.stopAndHttpEofVerified === true &&
    result.formatFailureStage === null &&
    result.code === "CONNECTIVITY_PROBE_SUCCEEDED"
  );
}

export async function runSingleDifficultyConnectivitySequence(input: {
  readonly execute: () => Promise<DifficultyConnectivityProbeResult>;
  readonly persist: (
    state: DifficultyConnectivityCheckpointState,
    activeSampleId: string | null,
    result: DifficultyConnectivityProbeResult | null
  ) => void;
}): Promise<DifficultyConnectivityProbeResult> {
  input.persist("active", "synthetic-connectivity-sum", null);
  let result: DifficultyConnectivityProbeResult;
  try {
    result = await input.execute();
  } catch {
    result = failedResult(
      emptyGuardSnapshot(),
      "CONNECTIVITY_PROBE_UNCLASSIFIED_FAILURE"
    );
  }
  if (
    result.sampleId !== "synthetic-connectivity-sum" ||
    (result.status === "succeeded" && !isCompleteDifficultyConnectivityResult(result))
  ) {
    result = failedResult(result, "CONNECTIVITY_PROBE_RESULT_CONTRACT_INVALID");
  }
  input.persist(result.status === "succeeded" ? "succeeded" : "failed", null, result);
  return result;
}

export function buildDifficultyConnectivityCompletion(input: {
  readonly commonEvidence: Readonly<Record<string, unknown>>;
  readonly result: DifficultyConnectivityProbeResult;
  readonly globalFailureCode: string | null;
  readonly labelLockReleased: boolean;
  readonly checkpointSha256: string;
}): Readonly<Record<string, unknown>> & { readonly complete: boolean } {
  const complete =
    isCompleteDifficultyConnectivityResult(input.result) &&
    input.globalFailureCode === null &&
    input.labelLockReleased;
  return {
    ...input.commonEvidence,
    kind: "difficulty-connectivity-probe-completion",
    complete,
    expected: 1,
    succeeded: complete ? 1 : 0,
    failed: complete ? 0 : 1,
    globalFailureCode: input.globalFailureCode,
    labelLockReleased: input.labelLockReleased,
    result: input.result,
    artifacts: {
      checkpoint: {
        fileName: checkpointFileName,
        sha256: sha256Schema.parse(input.checkpointSha256)
      }
    }
  };
}

function writeCompleteDocument(descriptor: number, document: Uint8Array): void {
  let offset = 0;
  while (offset < document.byteLength) {
    const written = writeSync(
      descriptor,
      document,
      offset,
      document.byteLength - offset,
      offset
    );
    if (written <= 0) {
      throw new Error("CONNECTIVITY_PROBE_SHORT_WRITE");
    }
    offset += written;
  }
  fsyncSync(descriptor);
}

function writeDurableTemporary(
  directory: PrivateDirectoryHandle,
  fileName: string,
  document: string
): void {
  const descriptor = openSync(
    anchoredPrivatePath(directory, fileName),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    fchmodSync(descriptor, 0o600);
    writeCompleteDocument(descriptor, Buffer.from(document, "utf8"));
  } finally {
    closeSync(descriptor);
  }
}

export function publishDifficultyConnectivityArtifactExclusive(
  directory: PrivateDirectoryHandle,
  finalFileName: string,
  temporaryKind: string,
  value: unknown
): string {
  const document = `${JSON.stringify(value, null, 2)}\n`;
  const temporaryFileName =
    `${difficultyConnectivityProbeLabel}.${temporaryKind}.next.private.json`;
  writeDurableTemporary(directory, temporaryFileName, document);
  fsyncSync(directory.descriptor);
  linkSync(
    anchoredPrivatePath(directory, temporaryFileName),
    anchoredPrivatePath(directory, finalFileName)
  );
  unlinkSync(anchoredPrivatePath(directory, temporaryFileName));
  fsyncSync(directory.descriptor);
  return sha256ConnectivityProbe(document);
}

function replaceCheckpoint(
  directory: PrivateDirectoryHandle,
  revision: number,
  value: unknown
): void {
  const temporaryFileName =
    `${difficultyConnectivityProbeLabel}.checkpoint.${String(revision).padStart(4, "0")}.next.private.json`;
  const document = `${JSON.stringify(value, null, 2)}\n`;
  writeDurableTemporary(directory, temporaryFileName, document);
  renameSync(
    anchoredPrivatePath(directory, temporaryFileName),
    anchoredPrivatePath(directory, checkpointFileName)
  );
  fsyncSync(directory.descriptor);
}

function readCurrentProcessStartTimeTicks(): string {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) throw new Error("invalid-proc-stat");
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/u);
    return processStartTimeTicksSchema.parse(fields[19]);
  } catch {
    throw new Error("CONNECTIVITY_PROBE_PROCESS_IDENTITY_UNAVAILABLE");
  }
}

function ownsProbeLock(
  directory: PrivateDirectoryHandle,
  descriptor: number
): boolean {
  try {
    const held = fstatSync(descriptor, { bigint: true });
    const linked = lstatSync(anchoredPrivatePath(directory, lockFileName), {
      bigint: true
    });
    return (
      held.isFile() &&
      linked.isFile() &&
      held.dev === linked.dev &&
      held.ino === linked.ino
    );
  } catch {
    return false;
  }
}

export function acquireDifficultyConnectivityLabelLock(
  directory: PrivateDirectoryHandle,
  codeVersion: string,
  now: () => Date = () => new Date()
): ProbeLabelLock {
  const record = difficultyConnectivityProbeLockRecordSchema.parse({
    schemaVersion: 1,
    kind: "difficulty-connectivity-probe-lock",
    label: difficultyConnectivityProbeLabel,
    processId: process.pid,
    processStartTimeTicks: readCurrentProcessStartTimeTicks(),
    codeVersion,
    acquiredAt: now().toISOString(),
    recoveryRule: "VERIFY_PID_START_TIME_FULL_COMMAND_AND_CWD_BEFORE_MANUAL_REMOVAL"
  });
  const temporaryFileName =
    `${difficultyConnectivityProbeLabel}.lock.tmp-${process.pid}-${randomUUID()}.private`;
  const temporaryPath = anchoredPrivatePath(directory, temporaryFileName);
  let descriptor: number | undefined;
  let temporaryExists = false;
  let fixedLinked = false;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    temporaryExists = true;
    fchmodSync(descriptor, 0o600);
    writeCompleteDocument(
      descriptor,
      Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8")
    );
    linkSync(
      temporaryPath,
      anchoredPrivatePath(directory, lockFileName)
    );
    fixedLinked = true;
    unlinkSync(temporaryPath);
    temporaryExists = false;
    fsyncSync(directory.descriptor);
    const heldDescriptor = descriptor;
    descriptor = undefined;
    let releaseResult: boolean | undefined;
    return {
      record,
      release: () => {
        if (releaseResult !== undefined) return releaseResult;
        let succeeded = true;
        if (!ownsProbeLock(directory, heldDescriptor)) {
          succeeded = false;
        } else {
          try {
            unlinkSync(anchoredPrivatePath(directory, lockFileName));
            fsyncSync(directory.descriptor);
          } catch {
            succeeded = false;
          }
        }
        try {
          closeSync(heldDescriptor);
        } catch {
          succeeded = false;
        }
        releaseResult = succeeded;
        return releaseResult;
      }
    };
  } catch {
    if (
      fixedLinked &&
      descriptor !== undefined &&
      ownsProbeLock(directory, descriptor)
    ) {
      try {
        unlinkSync(anchoredPrivatePath(directory, lockFileName));
        fsyncSync(directory.descriptor);
      } catch {
        // 无法证明清理成功就留下锁，后续运行继续 fail-closed。
      }
    }
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 固定错误码，不输出路径。
      }
    }
    if (temporaryExists) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // 只清理本次 UUID 临时锁。
      }
    }
    throw new Error("CONNECTIVITY_PROBE_LABEL_LOCKED_OR_UNAVAILABLE");
  }
}

export function assertDifficultyConnectivityLabelNamespaceUnused(
  directory: PrivateDirectoryHandle
): void {
  const prefix = `${difficultyConnectivityProbeLabel}.`;
  if (
    readdirSync(`/proc/self/fd/${directory.descriptor}`).some(
      (name) => name.startsWith(prefix) && name !== lockFileName
    )
  ) {
    throw new Error("CONNECTIVITY_PROBE_LABEL_ALREADY_USED");
  }
}

function assertBoundGitState(): {
  readonly codeVersion: string;
  readonly runnerSha256: string;
} {
  const codeVersion = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryDirectory,
    encoding: "utf8",
    stdio: "pipe"
  }).trim();
  gitCommitSchema.parse(codeVersion);
  const trackedRunner = execFileSync("git", ["show", `HEAD:${runnerRepositoryPath}`], {
    cwd: repositoryDirectory,
    stdio: ["ignore", "pipe", "ignore"]
  });
  const currentRunner = readFileSync(fileURLToPath(import.meta.url));
  const runnerSha256 = sha256ConnectivityProbe(currentRunner);
  if (runnerSha256 !== sha256ConnectivityProbe(trackedRunner)) {
    throw new Error("CONNECTIVITY_PROBE_CONFIGURATION_INVALID");
  }
  const porcelain = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repositoryDirectory, encoding: "utf8", stdio: "pipe" }
  );
  const trackedPrivatePaths = execFileSync("git", ["ls-files", "private"], {
    cwd: repositoryDirectory,
    encoding: "utf8",
    stdio: "pipe"
  });
  let privatePathIgnored = false;
  try {
    execFileSync("git", ["check-ignore", "-q", "private/.probe-ignore-check"], {
      cwd: repositoryDirectory,
      stdio: "ignore"
    });
    privatePathIgnored = true;
  } catch {
    privatePathIgnored = false;
  }
  assertDifficultyConnectivityRepositoryStatus({
    porcelain,
    trackedPrivatePaths,
    privatePathIgnored
  });
  return { codeVersion, runnerSha256 };
}

function syntheticProblem(): ReviewTaskProblem {
  return {
    id: "synthetic-connectivity-sum",
    revision: 1,
    reviewRound: 1,
    contentHash: "0".repeat(64),
    title: "整数求和连通性探针",
    type: "traditional",
    tagIds: ["experiment", "synthetic"],
    basicStatement:
      "给定正整数 n，计算 1 到 n 的整数之和。输入只有 n，输出一个整数；1 <= n <= 10^9。",
    basicSolution:
      "使用等差数列求和公式 n(n+1)/2。使用 64 位整数即可，时间复杂度 O(1)。"
  };
}

async function main(): Promise<void> {
  if (
    process.argv.slice(2).length !== 0 ||
    hasUnknownPrefixedEnvironmentKeys(process.env, "EVAL_", ["EVAL_CODE_VERSION"])
  ) {
    throw new Error("CONNECTIVITY_PROBE_CONFIGURATION_INVALID");
  }
  const { codeVersion, runnerSha256 } = assertBoundGitState();
  if (process.env.EVAL_CODE_VERSION !== codeVersion) {
    throw new Error("CONNECTIVITY_PROBE_CONFIGURATION_INVALID");
  }

  const modelsConfigDocument = readFileSync(modelsConfigUrl);
  const modelsConfigSha256 = sha256ConnectivityProbe(modelsConfigDocument);
  if (
    modelsConfigSha256 !==
    difficultyConnectivityExpectedModelsConfigSha256
  ) {
    throw new Error("CONNECTIVITY_PROBE_CONFIGURATION_INVALID");
  }
  const config = loadConfig();
  const profile = config.models.profiles[config.models.defaults.modelProfileName];
  if (profile === undefined) {
    throw new Error("CONNECTIVITY_PROBE_CONFIGURATION_INVALID");
  }
  assertDifficultyConnectivityConfiguration(profile.difficulty, config);
  const credentials = getProviderCredentials(config, "aether");
  if (credentials === undefined) {
    throw new Error("CONNECTIVITY_PROBE_CONFIGURATION_INVALID");
  }
  const providerIdentitySha256 = providerIdentityFingerprint("aether", credentials);
  if (
    providerIdentitySha256 !==
    difficultyConnectivityExpectedProviderIdentitySha256
  ) {
    throw new Error("CONNECTIVITY_PROBE_PROVIDER_IDENTITY_MISMATCH");
  }

  const strictAnchors = loadDifficultyAnchorsStrict(anchorsConfigUrl);
  assertDifficultyConnectivityAnchorSet(
    strictAnchors.anchors,
    strictAnchors.provisional
  );
  if (strictAnchors.fingerprint !== expectedCandidateCAnchorsSha256) {
    throw new Error("CONNECTIVITY_PROBE_CONFIGURATION_INVALID");
  }

  const commonEvidence = {
    schemaVersion: 1,
    label: difficultyConnectivityProbeLabel,
    experimentVersion: difficultyConnectivityProbeExperimentVersion,
    codeVersion,
    runnerSha256,
    modelsConfigSha256,
    candidateCAnchorsSha256: strictAnchors.fingerprint,
    providerIdentitySha256,
    model: "deepseek-v4-flash",
    thinking: false,
    thinkingRequest: "disabled",
    maxOutputTokens: difficultyConnectivityProbeMaxOutputTokens,
    maximumPaidRequests: 1,
    expected: 1,
    completionAuthorityFileName: difficultyConnectivityProbeCompletionFileName
  } as const;
  const privateDirectory = preparePrivateDirectory(resultsDirectory);
  let labelLock: ProbeLabelLock | undefined;
  let labelLockReleaseAttempted = false;
  let labelLockReleased = false;
  let checkpointRevision = 0;
  let result: DifficultyConnectivityProbeResult | null = null;
  let globalFailureCode: string | null = null;
  const checkpointDocument = (
    state: DifficultyConnectivityCheckpointState,
    activeSampleId: string | null
  ): Record<string, unknown> => ({
    ...commonEvidence,
    revision: checkpointRevision,
    state,
    activeSampleId,
    complete: false,
    globalFailureCode,
    labelLockReleased,
    result
  });
  const persistCheckpoint = (
    state: DifficultyConnectivityCheckpointState,
    activeSampleId: string | null = null,
    nextResult: DifficultyConnectivityProbeResult | null = result
  ): void => {
    result = nextResult;
    checkpointRevision += 1;
    replaceCheckpoint(
      privateDirectory,
      checkpointRevision,
      checkpointDocument(state, activeSampleId)
    );
  };

  try {
    labelLock = acquireDifficultyConnectivityLabelLock(privateDirectory, codeVersion);
    assertDifficultyConnectivityLabelNamespaceUnused(privateDirectory);
    publishDifficultyConnectivityArtifactExclusive(
      privateDirectory,
      checkpointFileName,
      "checkpoint-initial",
      checkpointDocument("ready", null)
    );

    let dispatcher: EnvHttpProxyAgent | undefined;
    try {
      dispatcher = new EnvHttpProxyAgent({
        connectTimeout: 0,
        headersTimeout: 0,
        bodyTimeout: 0
      });
    } catch {
      globalFailureCode = "CONNECTIVITY_PROBE_TRANSPORT_SETUP_FAILED";
      result = failedResult(
        emptyGuardSnapshot(),
        "CONNECTIVITY_PROBE_TRANSPORT_SETUP_FAILED"
      );
      persistCheckpoint("failed", null, result);
    }

    if (dispatcher !== undefined) {
      const baseFetch = createUndiciLlmFetch(dispatcher);
      try {
        result = await runSingleDifficultyConnectivitySequence({
          persist: (state, activeSampleId, nextResult) => {
            persistCheckpoint(state, activeSampleId, nextResult);
          },
          execute: () => executeDifficultyConnectivityProbe({
            problem: syntheticProblem(),
            anchors: strictAnchors.anchors,
            spec: profile.difficulty,
            credentials,
            runtime: {
              firstOutputTimeoutMs: config.models.timeouts.llmFirstOutputMs,
              outputIdleTimeoutMs: config.models.timeouts.llmOutputIdleMs,
              maximumDurationMs: config.models.timeouts.llmMaximumDurationMs,
              maxAttempts: 1,
              baseDelayMs: config.models.retry.baseDelayMs
            },
            baseFetch
          })
        });
      } finally {
        try {
          await dispatcher.close();
        } catch {
          globalFailureCode = "CONNECTIVITY_PROBE_DISPATCHER_CLOSE_FAILED";
        }
      }
    }

    if (result === null) {
      result = failedResult(
        emptyGuardSnapshot(),
        "CONNECTIVITY_PROBE_RESULT_MISSING"
      );
      globalFailureCode ??= "CONNECTIVITY_PROBE_RESULT_MISSING";
    }
    if (globalFailureCode !== null) {
      persistCheckpoint("failed", null, result);
    }

    labelLockReleaseAttempted = true;
    labelLockReleased = labelLock.release();
    if (!labelLockReleased) {
      globalFailureCode = "CONNECTIVITY_PROBE_LABEL_LOCK_RELEASE_FAILED";
      persistCheckpoint("failed", null, result);
    }
    persistCheckpoint(
      globalFailureCode === null && isCompleteDifficultyConnectivityResult(result)
        ? "completion_pending"
        : "failed",
      null,
      result
    );
    const checkpointSha256 = sha256ConnectivityProbe(
      readFileSync(anchoredPrivatePath(privateDirectory, checkpointFileName))
    );
    const completion = buildDifficultyConnectivityCompletion({
      commonEvidence,
      result,
      globalFailureCode,
      labelLockReleased,
      checkpointSha256
    });
    publishDifficultyConnectivityArtifactExclusive(
      privateDirectory,
      difficultyConnectivityProbeCompletionFileName,
      "completion",
      completion
    );
    process.stdout.write(
      `CONNECTIVITY_PROBE_COMPLETE expected=1 succeeded=${completion.complete ? 1 : 0} failed=${completion.complete ? 0 : 1} complete=${completion.complete}\n`
    );
    if (!completion.complete) process.exitCode = 1;
  } finally {
    if (labelLock !== undefined && !labelLockReleaseAttempted) {
      labelLock.release();
    }
    closePrivateDirectory(privateDirectory);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stdout.write("CONNECTIVITY_PROBE_FAILED_INCOMPLETE\n");
    process.exitCode = 1;
  });
}
