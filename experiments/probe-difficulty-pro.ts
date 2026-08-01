/**
 * Candidate D（deepseek-v4-pro 默认请求）的两题协议探针。
 *
 * 这个入口与历史 Candidate B 探针相互独立，不读取、续写或覆盖旧标签。它只按
 * 固定顺序运行一个人工短题和 CF 2006E；任何失败都会熔断后续付费请求。私有
 * manifest、公开题快照、public83 清单和结果只允许位于 Fermata/private/。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EnvHttpProxyAgent } from "undici";
import { z } from "zod";
import {
  anchoredPrivatePath,
  closePrivateDirectory,
  preparePrivateDirectory,
  readProtectedEnvFile
} from "../scripts/private-runtime.mjs";
import { getProviderCredentials, loadConfig, type ModelSpec } from "../src/config";
import { createUndiciLlmFetch, type FetchLike } from "../src/llm";
import { describeError } from "../src/logger";
import {
  runDifficultyPipeline,
  type DifficultyAnchor
} from "../src/pipelines/difficulty";
import type { ReviewTaskProblem } from "../src/pipelines/types";
import { loadDifficultyAnchorsStrict } from "./lib/difficulty-anchors-strict";
import { difficultyDatasetManifestSchema } from "./lib/difficulty-dataset-manifest";
import { evaluationConfigurationFingerprint } from "./lib/evaluation-integrity";

export const difficultyProProbeExperimentVersion =
  "experiment-2026-08-difficulty-pro-default-request-v1";
export const difficultyProProbeLabel =
  "difficulty-pro-default-request-probe-20260801-a";
export const difficultyProProbeMaxOutputTokens = 2_048;

const repositoryDirectory = fileURLToPath(new URL("../", import.meta.url));
const runnerRepositoryPath = "experiments/probe-difficulty-pro.ts";
const maximumPrivateDocumentBytes = 1024 * 1024;
const inputManifestPath = fileURLToPath(
  new URL("../private/difficulty-pro-probe-20260801-a/manifest.private.json", import.meta.url)
);
const registeredSourceManifestPath = fileURLToPath(
  new URL(
    "../private/difficulty-thinking-probes-20260801-c/manifest.private.json",
    import.meta.url
  )
);
const publicProblemPath = fileURLToPath(
  new URL("../private/difficulty-thinking-probes-20260801-c/2006E.json", import.meta.url)
);
const public83ManifestPath = fileURLToPath(
  new URL("../private/difficulty-dataset-manifest.json", import.meta.url)
);
const resultsDirectory = fileURLToPath(
  new URL("../private/difficulty-pro-probe-results/", import.meta.url)
);
const modelsConfigUrl = new URL("../config/models.yaml", import.meta.url);
const anchorsConfigUrl = new URL("../config/anchors/difficulty.json", import.meta.url);
const checkpointFileName = `${difficultyProProbeLabel}.checkpoint.private.json`;
const reportFileName = `${difficultyProProbeLabel}.report.private.json`;
const summaryFileName = `${difficultyProProbeLabel}.summary.private.json`;
export const difficultyProProbeCompletionFileName =
  `${difficultyProProbeLabel}.completion.private.json`;
const expectedModelsConfigSha256 =
  "392151d4e102187401e119086c3f888b7e9ab72a98c4b10e8b2c358e4a72c2a2";
const expectedCandidateCAnchorsSha256 =
  "48b4c5f95732347b2a0a48f4143f50dbc6bc6706f427aa75179def45988b9a7f";
const expectedPublic83ManifestSha256 =
  "6c6d7a60b4568e1477c6da88eeb7f7a33ce8bd94e8ee650c5fa02a0d4161ea7a";
const expectedPublic83ManifestFingerprint =
  "509473b84d457c91c25cdae65037e0931d1bd0d7a4c34a344e7334ebee233cfe";
const expectedRegisteredSourceManifestSha256 =
  "edd286b5511ea7887e685c1cf7ee2b8aba75bf58f2ef5c914617807c3d6dc68e";
const expectedProviderIdentitySha256 =
  "6e913442f0833b7950c9ae934e46f437dad6ffd72bf847fbe3acee058256050c";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const gitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);

export const difficultyProProbeManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("difficulty-pro-probe-input"),
    label: z.literal(difficultyProProbeLabel),
    source: z
      .object({
        dataset: z.literal("open-r1/codeforces"),
        license: z.literal("CC-BY-4.0"),
        registeredManifestSha256: z.literal(expectedRegisteredSourceManifestSha256),
        sample: z
          .object({
            safeId: z.literal("cf-2006e-public-probe"),
            contestId: z.literal(2006),
            index: z.literal("E"),
            rating: z.literal(3100),
            fileName: z.literal("2006E.json"),
            fileSizeBytes: z.number().int().min(1).max(maximumPrivateDocumentBytes),
            fileSha256: sha256Schema,
            statementSha256: sha256Schema
          })
          .strict()
      })
      .strict(),
    bindings: z
      .object({
        codeVersion: gitCommitSchema,
        runnerSha256: sha256Schema,
        modelsConfigSha256: sha256Schema,
        candidateCAnchorsSha256: sha256Schema,
        public83ManifestSha256: sha256Schema,
        providerIdentitySha256: sha256Schema
      })
      .strict()
  })
  .strict();

const registeredSourceManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.literal("huggingface-open-r1-codeforces"),
    sourceLicense: z.literal("CC-BY-4.0"),
    metadataVerifiedBy: z.literal("codeforces-official-api"),
    overlapCount: z.literal(0),
    samples: z
      .array(
        z
          .object({
            contestId: z.number().int().positive(),
            index: z.string().regex(/^[A-Z][0-9]{0,7}$/u),
            rating: z.number().int().min(800).max(3500).multipleOf(100),
            fileSha256: sha256Schema,
            statementSha256: sha256Schema
          })
          .strict()
      )
      .length(3)
  })
  .strict();

const publicProblemSchema = z
  .object({
    contestId: z.literal(2006),
    index: z.literal("E"),
    rating: z.literal(3100),
    statement: z.string().trim().min(1).max(500_000)
  })
  .strict();

export const difficultyProProbeRequestBodySchema = z
  .object({
    model: z.literal("deepseek-v4-pro"),
    temperature: z.literal(0.2),
    stream: z.literal(true),
    messages: z.array(z.unknown()).min(1),
    max_tokens: z.literal(difficultyProProbeMaxOutputTokens)
  })
  .strict();

const expectedCandidateCAnchors = [
  [1993, "A", 800],
  [2021, "C1", 1300],
  [2009, "F", 1700],
  [1998, "E1", 2200],
  [2003, "E1", 2600],
  [2027, "E2", 3100],
  [2013, "F2", 3500]
] as const;

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

export type DifficultyProProbeResult = {
  readonly sampleId: string;
  readonly kind: "synthetic" | "public";
  readonly status: "succeeded" | "failed" | "not_run";
  readonly requestCount: number;
  readonly fetchInvocationCount: number;
  readonly httpStatus: number | null;
  readonly schemaValidated: true | null;
  readonly stopAndHttpEofVerified: true | null;
  readonly code: string;
};

export type DifficultyProProbeCheckpointState =
  | "ready"
  | "active"
  | "running"
  | "failed"
  | "closing"
  | "report_pending"
  | "summary_pending"
  | "completion_pending"
  | "incomplete";

type ProbeSample = {
  readonly sampleId: string;
  readonly kind: "synthetic" | "public";
  readonly problem: ReviewTaskProblem;
};

type PrivateDocument = {
  readonly text: string;
  readonly sizeBytes: number;
  readonly sha256: string;
};

type RequestGuardSnapshot = {
  readonly requestCount: number;
  readonly fetchInvocationCount: number;
  readonly httpStatus: number | null;
  readonly contractViolation: boolean;
  readonly multipleRequestBlocked: boolean;
};

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertCandidateCAnchorSet(
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
    throw new Error("PROBE_CONFIGURATION_INVALID");
  }
}

export function assertProbeDoesNotOverlap(
  public83Problems: readonly { readonly contestId: number; readonly index: string }[],
  candidateCAnchors: readonly { readonly contestId: number; readonly index: string }[]
): void {
  const target = "2006#E";
  if (
    public83Problems.some((item) => `${item.contestId}#${item.index}` === target) ||
    candidateCAnchors.some((item) => `${item.contestId}#${item.index}` === target)
  ) {
    throw new Error("PROBE_SAMPLE_OVERLAP");
  }
}

export function assertCleanRepositoryStatus(input: {
  readonly porcelain: string;
  readonly trackedPrivatePaths: string;
  readonly privatePathIgnored: boolean;
}): void {
  if (
    input.porcelain.length !== 0 ||
    input.trackedPrivatePaths.length !== 0 ||
    !input.privatePathIgnored
  ) {
    throw new Error("PROBE_REPOSITORY_NOT_CLEAN");
  }
}

export function createDifficultyProSingleFetchGuard(input: {
  readonly baseFetch: FetchLike;
  readonly expectedUrl: string;
  readonly expectedAuthorization: string;
}): { readonly fetch: FetchLike; readonly snapshot: () => RequestGuardSnapshot } {
  let requestCount = 0;
  let fetchInvocationCount = 0;
  let httpStatus: number | null = null;
  let contractViolation = false;
  let multipleRequestBlocked = false;

  const fetch: FetchLike = async (url, init) => {
    fetchInvocationCount += 1;
    if (fetchInvocationCount > 1) {
      multipleRequestBlocked = true;
      throw new Error("PROBE_MULTIPLE_REQUEST_BLOCKED");
    }
    try {
      difficultyProProbeRequestBodySchema.parse(
        JSON.parse(String(init?.body)) as unknown
      );
      const headers = new Headers(init?.headers);
      if (
        String(url) !== input.expectedUrl ||
        init?.method !== "POST" ||
        headers.get("authorization") !== input.expectedAuthorization ||
        headers.get("content-type") !== "application/json"
      ) {
        throw new Error("PROBE_REQUEST_CONTRACT_INVALID");
      }
    } catch {
      contractViolation = true;
      throw new Error("PROBE_REQUEST_CONTRACT_INVALID");
    }
    requestCount += 1;
    const response = await input.baseFetch(url, init);
    httpStatus = response.status;
    return response;
  };

  return {
    fetch,
    snapshot: () => ({
      requestCount,
      fetchInvocationCount,
      httpStatus,
      contractViolation,
      multipleRequestBlocked
    })
  };
}

export async function runDifficultyProProbeSequence(input: {
  readonly samples: readonly Pick<ProbeSample, "sampleId" | "kind">[];
  readonly execute: (
    sample: Pick<ProbeSample, "sampleId" | "kind">
  ) => Promise<DifficultyProProbeResult>;
  readonly persist: (
    state: DifficultyProProbeCheckpointState,
    activeSampleId: string | null,
    results: readonly DifficultyProProbeResult[]
  ) => void;
}): Promise<DifficultyProProbeResult[]> {
  const results: DifficultyProProbeResult[] = [];
  let stopNewRequests = false;
  for (const sample of input.samples) {
    if (stopNewRequests) {
      results.push(notRunResult(sample));
      input.persist("failed", null, results);
      continue;
    }
    input.persist("active", sample.sampleId, results);
    let result: DifficultyProProbeResult;
    try {
      result = await input.execute(sample);
    } catch {
      result = failedResult(sample, emptyGuardSnapshot(), "PROBE_UNCLASSIFIED_FAILURE");
    }
    if (
      result.sampleId !== sample.sampleId ||
      result.kind !== sample.kind ||
      (result.status === "succeeded" &&
        (result.requestCount !== 1 ||
          result.fetchInvocationCount !== 1 ||
          result.httpStatus !== 200 ||
          result.schemaValidated !== true ||
          result.stopAndHttpEofVerified !== true))
    ) {
      result = failedResult(sample, result, "PROBE_RESULT_CONTRACT_INVALID");
    }
    results.push(result);
    stopNewRequests = result.status !== "succeeded";
    input.persist(stopNewRequests ? "failed" : "running", null, results);
  }
  return results;
}

export function buildDifficultyProProbePrecompletionArtifacts(input: {
  readonly commonEvidence: Readonly<Record<string, unknown>>;
  readonly expected: number;
  readonly results: readonly DifficultyProProbeResult[];
  readonly globalFailureCode: string | null;
}): {
  readonly succeeded: number;
  readonly failed: number;
  readonly allSuccessConditionsMet: boolean;
  readonly report: Readonly<Record<string, unknown>>;
  readonly summary: Readonly<Record<string, unknown>>;
} {
  const succeeded = input.results.filter((result) => result.status === "succeeded").length;
  const failed = input.expected - succeeded;
  const allSuccessConditionsMet =
    succeeded === input.expected &&
    input.results.length === input.expected &&
    input.globalFailureCode === null;
  const shared = {
    ...input.commonEvidence,
    artifactRole: "non_authoritative_evidence",
    succeeded,
    failed,
    allSuccessConditionsMet,
    globalFailureCode: input.globalFailureCode
  } as const;
  return {
    succeeded,
    failed,
    allSuccessConditionsMet,
    report: { ...shared, results: input.results },
    summary: {
      ...shared,
      results: input.results.map(({ sampleId, kind, status, code }) => ({
        sampleId,
        kind,
        status,
        code
      }))
    }
  };
}

function emptyGuardSnapshot(): RequestGuardSnapshot {
  return {
    requestCount: 0,
    fetchInvocationCount: 0,
    httpStatus: null,
    contractViolation: false,
    multipleRequestBlocked: false
  };
}

function failedResult(
  sample: Pick<ProbeSample, "sampleId" | "kind">,
  snapshot: Pick<
    RequestGuardSnapshot,
    "requestCount" | "fetchInvocationCount" | "httpStatus"
  >,
  code: string
): DifficultyProProbeResult {
  return {
    sampleId: sample.sampleId,
    kind: sample.kind,
    status: "failed",
    requestCount: snapshot.requestCount,
    fetchInvocationCount: snapshot.fetchInvocationCount,
    httpStatus: snapshot.httpStatus,
    schemaValidated: null,
    stopAndHttpEofVerified: null,
    code
  };
}

function notRunResult(
  sample: Pick<ProbeSample, "sampleId" | "kind">
): DifficultyProProbeResult {
  return {
    sampleId: sample.sampleId,
    kind: sample.kind,
    status: "not_run",
    requestCount: 0,
    fetchInvocationCount: 0,
    httpStatus: null,
    schemaValidated: null,
    stopAndHttpEofVerified: null,
    code: "PROBE_NOT_RUN_AFTER_FAILURE"
  };
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
  if (!/^[0-9a-f]{40}$/u.test(codeVersion)) {
    throw new Error("PROBE_CONFIGURATION_INVALID");
  }
  const trackedRunner = execFileSync("git", ["show", `HEAD:${runnerRepositoryPath}`], {
    cwd: repositoryDirectory,
    stdio: ["ignore", "pipe", "ignore"]
  });
  const currentRunner = readFileSync(fileURLToPath(import.meta.url));
  const runnerSha256 = sha256Bytes(currentRunner);
  if (runnerSha256 !== sha256Bytes(trackedRunner)) {
    throw new Error("PROBE_CONFIGURATION_INVALID");
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
  assertCleanRepositoryStatus({ porcelain, trackedPrivatePaths, privatePathIgnored });
  return { codeVersion, runnerSha256 };
}

function readPrivateDocument(path: string, maximumBytes = maximumPrivateDocumentBytes): PrivateDocument {
  const text = readProtectedEnvFile(path, { maximumBytes });
  const sizeBytes = Buffer.byteLength(text, "utf8");
  if (sizeBytes < 1 || sizeBytes > maximumBytes) {
    throw new Error("PROBE_INPUT_INVALID");
  }
  return { text, sizeBytes, sha256: sha256Bytes(text) };
}

function assertDifficultyConfiguration(spec: ModelSpec, config: ReturnType<typeof loadConfig>): void {
  if (
    config.models.experimentVersion !== difficultyProProbeExperimentVersion ||
    config.models.defaults.modelProfileName !== "review-balanced" ||
    spec.provider !== "aether" ||
    spec.model !== "deepseek-v4-pro" ||
    spec.temperature !== 0.2 ||
    spec.thinking !== false ||
    spec.thinkingRequest !== undefined ||
    spec.reasoningEffort !== undefined ||
    config.models.retry.maxAttempts !== 3 ||
    config.models.retry.baseDelayMs !== 500 ||
    config.models.timeouts.llmFirstOutputMs !== 1_800_000 ||
    config.models.timeouts.llmOutputIdleMs !== 600_000 ||
    config.models.timeouts.llmMaximumDurationMs !== 14_400_000
  ) {
    throw new Error("PROBE_CONFIGURATION_INVALID");
  }
}

function syntheticProblem(): ReviewTaskProblem {
  return {
    id: "synthetic-protocol-sum",
    revision: 1,
    reviewRound: 1,
    contentHash: "0".repeat(64),
    title: "整数求和协议探针",
    type: "traditional",
    tagIds: ["experiment", "synthetic"],
    basicStatement:
      "给定正整数 n，计算 1 到 n 的整数之和。输入只有 n，输出一个整数；1 <= n <= 10^9。",
    basicSolution:
      "使用等差数列求和公式 n(n+1)/2。使用 64 位整数即可，时间复杂度 O(1)。"
  };
}

function publicProblem(item: z.infer<typeof publicProblemSchema>): ReviewTaskProblem {
  return {
    id: "cf-2006E",
    revision: 1,
    reviewRound: 1,
    contentHash: "0".repeat(64),
    title: "CF 2006E",
    type: "traditional",
    tagIds: ["experiment"],
    basicStatement: item.statement,
    basicSolution:
      "公开探针材料未登记单独题解；只依据题面与约束判断并降低置信度。"
  };
}

function safeFailureCode(error: unknown, snapshot: RequestGuardSnapshot): string {
  if (snapshot.multipleRequestBlocked) return "PROBE_MULTIPLE_REQUEST_BLOCKED";
  if (snapshot.contractViolation) return "PROBE_REQUEST_CONTRACT_INVALID";
  const described = describeError(error);
  return safeLlmFailureCodes.has(described)
    ? described
    : "PROBE_UNCLASSIFIED_FAILURE";
}

type PrivateDirectoryHandle = ReturnType<typeof preparePrivateDirectory>;

function writeDurableExclusive(
  directory: PrivateDirectoryHandle,
  fileName: string,
  value: unknown
): void {
  const descriptor = openSync(
    anchoredPrivatePath(directory, fileName),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncSync(directory.descriptor);
}

function replaceCheckpoint(
  directory: PrivateDirectoryHandle,
  revision: number,
  value: unknown
): void {
  const temporaryFileName = `${difficultyProProbeLabel}.checkpoint.${String(revision).padStart(4, "0")}.next.private.json`;
  writeDurableExclusive(directory, temporaryFileName, value);
  renameSync(
    anchoredPrivatePath(directory, temporaryFileName),
    anchoredPrivatePath(directory, checkpointFileName)
  );
  fsyncSync(directory.descriptor);
}

export function publishDifficultyProArtifactExclusive(
  directory: PrivateDirectoryHandle,
  finalFileName: string,
  temporaryKind: string,
  value: unknown
): string {
  const document = `${JSON.stringify(value, null, 2)}\n`;
  const temporaryFileName = `${difficultyProProbeLabel}.${temporaryKind}.next.private.json`;
  const descriptor = openSync(
    anchoredPrivatePath(directory, temporaryFileName),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    writeFileSync(descriptor, document, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncSync(directory.descriptor);
  linkSync(
    anchoredPrivatePath(directory, temporaryFileName),
    anchoredPrivatePath(directory, finalFileName)
  );
  unlinkSync(anchoredPrivatePath(directory, temporaryFileName));
  fsyncSync(directory.descriptor);
  return sha256Bytes(document);
}

function assertLabelNamespaceUnused(directory: PrivateDirectoryHandle): void {
  const prefix = `${difficultyProProbeLabel}.`;
  if (
    readdirSync(`/proc/self/fd/${directory.descriptor}`).some((name) => name.startsWith(prefix))
  ) {
    throw new Error("PROBE_LABEL_ALREADY_USED");
  }
}

async function main(): Promise<void> {
  const { codeVersion, runnerSha256 } = assertBoundGitState();
  if (process.env.EVAL_CODE_VERSION !== codeVersion) {
    throw new Error("PROBE_CONFIGURATION_INVALID");
  }

  const modelsConfigDocument = readFileSync(modelsConfigUrl);
  const modelsConfigSha256 = sha256Bytes(modelsConfigDocument);
  if (modelsConfigSha256 !== expectedModelsConfigSha256) {
    throw new Error("PROBE_CONFIGURATION_INVALID");
  }
  const config = loadConfig();
  const profile = config.models.profiles[config.models.defaults.modelProfileName];
  if (profile === undefined) throw new Error("PROBE_CONFIGURATION_INVALID");
  assertDifficultyConfiguration(profile.difficulty, config);
  const credentials = getProviderCredentials(config, "aether");
  if (credentials === undefined) throw new Error("PROBE_CONFIGURATION_INVALID");
  const providerIdentitySha256 = sha256Bytes(
    JSON.stringify({
      schemaVersion: 1,
      provider: "aether",
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey
    })
  );
  if (providerIdentitySha256 !== expectedProviderIdentitySha256) {
    throw new Error("PROBE_CONFIGURATION_INVALID");
  }

  const strictAnchors = loadDifficultyAnchorsStrict(anchorsConfigUrl);
  assertCandidateCAnchorSet(strictAnchors.anchors, strictAnchors.provisional);
  if (strictAnchors.fingerprint !== expectedCandidateCAnchorsSha256) {
    throw new Error("PROBE_CONFIGURATION_INVALID");
  }
  const public83Document = readPrivateDocument(public83ManifestPath);
  const public83Manifest = difficultyDatasetManifestSchema.parse(
    JSON.parse(public83Document.text) as unknown
  );
  if (
    public83Document.sha256 !== expectedPublic83ManifestSha256 ||
    evaluationConfigurationFingerprint(public83Manifest) !==
      expectedPublic83ManifestFingerprint ||
    public83Manifest.expectedFileCount !== 83
  ) {
    throw new Error("PROBE_INPUT_INVALID");
  }
  assertProbeDoesNotOverlap(public83Manifest.samples, strictAnchors.anchors);

  const inputManifestDocument = readPrivateDocument(inputManifestPath, 64 * 1024);
  const inputManifest = difficultyProProbeManifestSchema.parse(
    JSON.parse(inputManifestDocument.text) as unknown
  );
  const registeredSourceManifestDocument = readPrivateDocument(
    registeredSourceManifestPath,
    64 * 1024
  );
  if (
    registeredSourceManifestDocument.sha256 !==
    expectedRegisteredSourceManifestSha256
  ) {
    throw new Error("PROBE_INPUT_INVALID");
  }
  const registeredSourceManifest = registeredSourceManifestSchema.parse(
    JSON.parse(registeredSourceManifestDocument.text) as unknown
  );
  const registeredSourceSample = registeredSourceManifest.samples.filter(
    (sample) => sample.contestId === 2006 && sample.index === "E"
  );
  if (registeredSourceSample.length !== 1) {
    throw new Error("PROBE_INPUT_INVALID");
  }
  const publicProblemDocument = readPrivateDocument(publicProblemPath);
  const publicItem = publicProblemSchema.parse(
    JSON.parse(publicProblemDocument.text) as unknown
  );
  const registeredSample = registeredSourceSample[0]!;
  if (
    publicProblemDocument.sizeBytes !== inputManifest.source.sample.fileSizeBytes ||
    publicProblemDocument.sha256 !== inputManifest.source.sample.fileSha256 ||
    sha256Bytes(publicItem.statement) !== inputManifest.source.sample.statementSha256 ||
    publicItem.rating !== registeredSample.rating ||
    publicProblemDocument.sha256 !== registeredSample.fileSha256 ||
    sha256Bytes(publicItem.statement) !== registeredSample.statementSha256 ||
    inputManifest.source.registeredManifestSha256 !==
      expectedRegisteredSourceManifestSha256 ||
    inputManifest.bindings.codeVersion !== codeVersion ||
    inputManifest.bindings.runnerSha256 !== runnerSha256 ||
    inputManifest.bindings.modelsConfigSha256 !== modelsConfigSha256 ||
    inputManifest.bindings.candidateCAnchorsSha256 !== strictAnchors.fingerprint ||
    inputManifest.bindings.public83ManifestSha256 !== public83Document.sha256 ||
    inputManifest.bindings.providerIdentitySha256 !== providerIdentitySha256
  ) {
    throw new Error("PROBE_INPUT_INVALID");
  }

  const samples: ProbeSample[] = [
    {
      sampleId: "synthetic-protocol-sum",
      kind: "synthetic",
      problem: syntheticProblem()
    },
    {
      sampleId: "cf-2006e-public-probe",
      kind: "public",
      problem: publicProblem(publicItem)
    }
  ];
  const privateDirectory = preparePrivateDirectory(resultsDirectory);
  let checkpointRevision = 0;
  let currentResults: readonly DifficultyProProbeResult[] = [];
  let globalFailureCode: string | null = null;
  const commonEvidence = {
    schemaVersion: 1,
    label: difficultyProProbeLabel,
    codeVersion,
    runnerSha256,
    experimentVersion: difficultyProProbeExperimentVersion,
    inputManifestSha256: inputManifestDocument.sha256,
    inputManifestSizeBytes: inputManifestDocument.sizeBytes,
    registeredSourceManifestSha256: registeredSourceManifestDocument.sha256,
    modelsConfigSha256,
    candidateCAnchorsSha256: strictAnchors.fingerprint,
    public83ManifestSha256: public83Document.sha256,
    providerIdentitySha256,
    maxOutputTokens: difficultyProProbeMaxOutputTokens,
    maxAttempts: 1,
    expected: samples.length,
    completionAuthorityFileName: difficultyProProbeCompletionFileName
  } as const;
  const checkpointDocument = (
    state: DifficultyProProbeCheckpointState,
    activeSampleId: string | null
  ): Record<string, unknown> => ({
    ...commonEvidence,
    revision: checkpointRevision,
    state,
    activeSampleId,
    complete: false,
    globalFailureCode,
    results: currentResults
  });
  const persistCheckpoint = (
    state: DifficultyProProbeCheckpointState,
    activeSampleId: string | null = null,
    results: readonly DifficultyProProbeResult[] = currentResults
  ): void => {
    currentResults = results;
    checkpointRevision += 1;
    replaceCheckpoint(
      privateDirectory,
      checkpointRevision,
      checkpointDocument(state, activeSampleId)
    );
  };

  try {
    assertLabelNamespaceUnused(privateDirectory);
    writeDurableExclusive(
      privateDirectory,
      checkpointFileName,
      checkpointDocument("ready", null)
    );

    const dispatcher = new EnvHttpProxyAgent({
      connectTimeout: 0,
      headersTimeout: 0,
      bodyTimeout: 0
    });
    const baseFetch = createUndiciLlmFetch(dispatcher);
    const expectedUrl = new URL(
      "chat/completions",
      credentials.baseUrl.endsWith("/") ? credentials.baseUrl : `${credentials.baseUrl}/`
    ).href;
    try {
      currentResults = await runDifficultyProProbeSequence({
        samples,
        persist: (state, activeSampleId, results) => {
          persistCheckpoint(state, activeSampleId, results);
        },
        execute: async (sampleIdentity) => {
          const sample = samples.find((candidate) => candidate.sampleId === sampleIdentity.sampleId);
          if (sample === undefined) {
            return failedResult(sampleIdentity, emptyGuardSnapshot(), "PROBE_SAMPLE_INVALID");
          }
          const guard = createDifficultyProSingleFetchGuard({
            baseFetch,
            expectedUrl,
            expectedAuthorization: `Bearer ${credentials.apiKey}`
          });
          try {
            await runDifficultyPipeline({
              problem: sample.problem,
              anchors: strictAnchors.anchors,
              model: {
                spec: profile.difficulty,
                credentials,
                runtime: {
                  firstOutputTimeoutMs: config.models.timeouts.llmFirstOutputMs,
                  outputIdleTimeoutMs: config.models.timeouts.llmOutputIdleMs,
                  maximumDurationMs: config.models.timeouts.llmMaximumDurationMs,
                  maxAttempts: 1,
                  baseDelayMs: config.models.retry.baseDelayMs,
                  fetch: guard.fetch
                }
              }
            });
            const snapshot = guard.snapshot();
            if (
              snapshot.requestCount !== 1 ||
              snapshot.fetchInvocationCount !== 1 ||
              snapshot.httpStatus !== 200
            ) {
              return failedResult(sample, snapshot, "PROBE_REQUEST_COUNT_INVALID");
            }
            return {
              sampleId: sample.sampleId,
              kind: sample.kind,
              status: "succeeded",
              requestCount: 1,
              fetchInvocationCount: 1,
              httpStatus: 200,
              schemaValidated: true,
              stopAndHttpEofVerified: true,
              code: "PROBE_SUCCEEDED"
            };
          } catch (error) {
            const snapshot = guard.snapshot();
            return failedResult(sample, snapshot, safeFailureCode(error, snapshot));
          }
        }
      });
      persistCheckpoint("closing", null, currentResults);
    } finally {
      try {
        await dispatcher.close();
      } catch {
        globalFailureCode = "PROBE_DISPATCHER_CLOSE_FAILED";
        // close 失败本身先成为 durable 证据，再尝试生成报告；即使随后崩溃，
        // 这个标签也不能回到看似干净的状态。
        persistCheckpoint("incomplete", null, currentResults);
      }
    }

    const artifacts = buildDifficultyProProbePrecompletionArtifacts({
      commonEvidence,
      expected: samples.length,
      results: currentResults,
      globalFailureCode
    });
    const {
      succeeded,
      failed,
      allSuccessConditionsMet: complete,
      report,
      summary
    } = artifacts;
    persistCheckpoint("report_pending", null, currentResults);
    const reportSha256 = publishDifficultyProArtifactExclusive(
      privateDirectory,
      reportFileName,
      "report",
      report
    );
    persistCheckpoint("summary_pending", null, currentResults);
    const summarySha256 = publishDifficultyProArtifactExclusive(
      privateDirectory,
      summaryFileName,
      "summary",
      summary
    );
    persistCheckpoint("completion_pending", null, currentResults);
    const checkpointSha256 = sha256Bytes(
      readFileSync(anchoredPrivatePath(privateDirectory, checkpointFileName))
    );
    const completion = {
      ...commonEvidence,
      kind: "difficulty-pro-probe-completion",
      complete,
      succeeded,
      failed,
      globalFailureCode,
      artifacts: {
        checkpoint: { fileName: checkpointFileName, sha256: checkpointSha256 },
        report: { fileName: reportFileName, sha256: reportSha256 },
        summary: { fileName: summaryFileName, sha256: summarySha256 }
      }
    };
    // 精确文件名的 completion certificate 是唯一终态权威；它最后排他发布。
    // 任一前序崩溃只会留下 complete=false 的 checkpoint 和非权威产物。
    publishDifficultyProArtifactExclusive(
      privateDirectory,
      difficultyProProbeCompletionFileName,
      "completion",
      completion
    );
    process.stdout.write(
      `PROBE_RUN_COMPLETE expected=${samples.length} succeeded=${succeeded} failed=${failed} complete=${complete}\n`
    );
    if (!complete) process.exitCode = 1;
  } finally {
    closePrivateDirectory(privateDirectory);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stdout.write("PROBE_RUN_FAILED_INCOMPLETE\n");
    process.exitCode = 1;
  });
}
