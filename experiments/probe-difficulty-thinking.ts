import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  writeFileSync,
  type BigIntStats
} from "node:fs";
import { fileURLToPath } from "node:url";
import { EnvHttpProxyAgent } from "undici";
import { z } from "zod";
import { getProviderCredentials, loadConfig } from "../src/config";
import {
  createUndiciLlmFetch,
  maximumExplicitLlmOutputTokens,
  type FetchLike
} from "../src/llm";
import { describeError } from "../src/logger";
import {
  runDifficultyPipeline,
  type DifficultyAnchor
} from "../src/pipelines/difficulty";
import type { ReviewTaskProblem } from "../src/pipelines/types";
import { loadDifficultyAnchorsStrict } from "./lib/difficulty-anchors-strict";
import {
  anchoredPrivatePath,
  closePrivateDirectory,
  preparePrivateDirectory
} from "../scripts/private-runtime.mjs";

const experimentVersion =
  "experiment-2026-08-difficulty-rubric-thinking-low-cap4096-v1";
const sourceManifestSha256 =
  "edd286b5511ea7887e685c1cf7ee2b8aba75bf58f2ef5c914617807c3d6dc68e";
const providerIdentityFingerprint =
  "6e913442f0833b7950c9ae934e46f437dad6ffd72bf847fbe3acee058256050c";
const maximumProbeFileBytes = 1024 * 1024;
const repositoryDirectory = fileURLToPath(new URL("../", import.meta.url));
const reportLabel = "difficulty-thinking-low-probe-4096-20260801-b";
const checkpointFileName = `${reportLabel}.checkpoint.private.json`;
const reportFileName = `${reportLabel}.private.json`;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const sourceManifestSchema = z
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
            index: z.string().regex(/^[A-Z][0-9]{0,7}$/),
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
    contestId: z.number().int().positive(),
    index: z.string().regex(/^[A-Z][0-9]{0,7}$/),
    rating: z.number().int().min(800).max(3500).multipleOf(100),
    statement: z.string().min(1).max(500_000)
  })
  .strict();
const thinkingRequestBodySchema = z
  .object({
    model: z.literal("deepseek-v4-flash"),
    temperature: z.literal(0.2),
    stream: z.literal(true),
    messages: z.array(z.unknown()).min(1),
    thinking: z.object({ type: z.literal("enabled") }).strict(),
    reasoning_effort: z.literal("max"),
    max_tokens: z.literal(maximumExplicitLlmOutputTokens)
  })
  .strict();

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

type ProbeResult = {
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

type CheckpointState =
  | "ready"
  | "active"
  | "running"
  | "failed"
  | "closing"
  | "report_pending"
  | "complete"
  | "incomplete";

type PrivateDirectoryHandle = ReturnType<typeof preparePrivateDirectory>;

function assertBoundGitState(): {
  readonly codeVersion: string;
  readonly runnerSha256: string;
} {
  const actualHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryDirectory,
    encoding: "utf8",
    stdio: "pipe"
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(actualHead)) {
    throw new Error("PROBE_CONFIGURATION_INVALID");
  }
  const trackedRunner = execFileSync(
    "git",
    ["show", "HEAD:experiments/probe-difficulty-thinking.ts"],
    { cwd: repositoryDirectory, stdio: ["ignore", "pipe", "ignore"] }
  );
  const currentRunner = readFileSync(fileURLToPath(import.meta.url));
  const trackedRunnerSha256 = createHash("sha256")
    .update(trackedRunner)
    .digest("hex");
  const runnerSha256 = createHash("sha256")
    .update(currentRunner)
    .digest("hex");
  if (runnerSha256 !== trackedRunnerSha256) {
    throw new Error("PROBE_CONFIGURATION_INVALID");
  }
  execFileSync("git", ["diff", "--quiet"], {
    cwd: repositoryDirectory,
    stdio: "ignore"
  });
  execFileSync("git", ["diff", "--cached", "--quiet"], {
    cwd: repositoryDirectory,
    stdio: "ignore"
  });
  return { codeVersion: actualHead, runnerSha256 };
}

function writeDurableExclusive(
  directory: PrivateDirectoryHandle,
  fileName: string,
  value: unknown
): void {
  const descriptor = openSync(
    anchoredPrivatePath(directory, fileName),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
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

function assertLabelNamespaceUnused(directory: PrivateDirectoryHandle): void {
  const prefix = `${reportLabel}.`;
  if (
    readdirSync(`/proc/self/fd/${directory.descriptor}`).some((name) =>
      name.startsWith(prefix)
    )
  ) {
    throw new Error("PROBE_LABEL_ALREADY_USED");
  }
}

function replaceCheckpoint(
  directory: PrivateDirectoryHandle,
  revision: number,
  value: unknown
): void {
  const temporaryFileName = `${reportLabel}.checkpoint.${String(revision).padStart(4, "0")}.next.private.json`;
  writeDurableExclusive(directory, temporaryFileName, value);
  renameSync(
    anchoredPrivatePath(directory, temporaryFileName),
    anchoredPrivatePath(directory, checkpointFileName)
  );
  fsyncSync(directory.descriptor);
}

function publishReport(
  directory: PrivateDirectoryHandle,
  value: unknown
): void {
  const temporaryFileName = `${reportLabel}.report.next.private.json`;
  writeDurableExclusive(directory, temporaryFileName, value);
  renameSync(
    anchoredPrivatePath(directory, temporaryFileName),
    anchoredPrivatePath(directory, reportFileName)
  );
  fsyncSync(directory.descriptor);
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

function readBoundFile(
  directory: PrivateDirectoryHandle,
  fileName: string,
  expectedSha256: string
): Buffer {
  const descriptor = openSync(
    anchoredPrivatePath(directory, fileName),
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(maximumProbeFileBytes) ||
      (before.mode & 0o77n) !== 0n ||
      (typeof process.getuid === "function" &&
        before.uid !== BigInt(process.getuid()))
    ) {
      throw new Error("PROBE_INPUT_INVALID");
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= maximumProbeFileBytes) {
      const nextSize = Math.min(
        64 * 1024,
        maximumProbeFileBytes + 1 - totalBytes
      );
      if (nextSize < 1) break;
      const chunk = Buffer.allocUnsafe(nextSize);
      const bytesRead = readSync(descriptor, chunk, 0, nextSize, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (totalBytes > maximumProbeFileBytes) {
      throw new Error("PROBE_INPUT_INVALID");
    }
    const content = Buffer.concat(chunks, totalBytes);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !sameFileSnapshot(before, after) ||
      createHash("sha256").update(content).digest("hex") !== expectedSha256
    ) {
      throw new Error("PROBE_INPUT_INVALID");
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}

function publicProblem(
  item: z.infer<typeof publicProblemSchema>
): ReviewTaskProblem {
  return {
    id: `cf-${item.contestId}${item.index}`,
    revision: 1,
    reviewRound: 1,
    contentHash: "0".repeat(64),
    title: `CF ${item.contestId}${item.index}`,
    type: "traditional",
    tagIds: ["experiment"],
    basicStatement: item.statement,
    basicSolution:
      "（实验数据集没有单独抓取官方题解——Codeforces 编辑注解通常是独立论坛帖子，没有稳定的结构化格式可抓。" +
      "这次评测只依据题面本身判断难度，比正式使用时更难，结果仅供参考。）"
  };
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

function loadPublicProblems(): Array<{
  readonly sampleId: string;
  readonly kind: "public";
  readonly problem: ReviewTaskProblem;
}> {
  const sourceDirectory = preparePrivateDirectory(
    fileURLToPath(
      new URL("../private/difficulty-thinking-probes-20260801-c/", import.meta.url)
    )
  );
  try {
    if (sourceDirectory.created) {
      throw new Error("PROBE_INPUT_INVALID");
    }
    const manifestDocument = readBoundFile(
      sourceDirectory,
      "manifest.private.json",
      sourceManifestSha256
    );
    const manifest = sourceManifestSchema.parse(
      JSON.parse(manifestDocument.toString("utf8")) as unknown
    );
    const uniqueKeys = new Set(
      manifest.samples.map((sample) => `${sample.contestId}#${sample.index}`)
    );
    if (uniqueKeys.size !== manifest.samples.length) {
      throw new Error("PROBE_INPUT_INVALID");
    }
    return manifest.samples
      .map((entry) => {
        const fileName = `${entry.contestId}${entry.index}.json`;
        const content = readBoundFile(
          sourceDirectory,
          fileName,
          entry.fileSha256
        );
        const item = publicProblemSchema.parse(
          JSON.parse(content.toString("utf8")) as unknown
        );
        if (
          item.contestId !== entry.contestId ||
          item.index !== entry.index ||
          item.rating !== entry.rating ||
          createHash("sha256").update(item.statement).digest("hex") !==
            entry.statementSha256
        ) {
          throw new Error("PROBE_INPUT_INVALID");
        }
        return {
          sampleId: `cf-${entry.contestId}${entry.index}`,
          kind: "public" as const,
          rating: entry.rating,
          problem: publicProblem(item)
        };
      })
      .sort((left, right) => left.rating - right.rating)
      .map(({ rating: _rating, ...item }) => item);
  } finally {
    closePrivateDirectory(sourceDirectory);
  }
}

function safeFailureCode(
  error: unknown,
  contractViolation: boolean,
  multipleRequestBlocked: boolean
): string {
  if (multipleRequestBlocked) return "PROBE_MULTIPLE_REQUEST_BLOCKED";
  if (contractViolation) return "PROBE_REQUEST_CONTRACT_INVALID";
  const described = describeError(error);
  return safeLlmFailureCodes.has(described)
    ? described
    : "PROBE_UNCLASSIFIED_FAILURE";
}

async function main(): Promise<void> {
  const { codeVersion, runnerSha256 } = assertBoundGitState();
  if (process.env.EVAL_CODE_VERSION !== codeVersion) {
    throw new Error("PROBE_CONFIGURATION_INVALID");
  }
  const config = loadConfig();
  if (config.models.experimentVersion !== experimentVersion) {
    throw new Error("PROBE_CONFIGURATION_INVALID");
  }
  const profile = config.models.profiles[config.models.defaults.modelProfileName];
  if (
    profile === undefined ||
    profile.difficulty.provider !== "aether" ||
    profile.difficulty.model !== "deepseek-v4-flash" ||
    profile.difficulty.thinking !== false ||
    profile.difficulty.thinkingRequest !== "enabled" ||
    profile.difficulty.reasoningEffort !== "max"
  ) {
    throw new Error("PROBE_CONFIGURATION_INVALID");
  }
  const credentials = getProviderCredentials(config, profile.difficulty.provider);
  if (credentials === undefined) {
    throw new Error("PROBE_CONFIGURATION_INVALID");
  }
  const actualProviderIdentityFingerprint = createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: 1,
      provider: "aether",
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey
    }))
    .digest("hex");
  if (actualProviderIdentityFingerprint !== providerIdentityFingerprint) {
    throw new Error("PROBE_CONFIGURATION_INVALID");
  }
  const strictAnchors = loadDifficultyAnchorsStrict(
    new URL("../config/anchors/difficulty.json", import.meta.url)
  );
  const samples = [
    {
      sampleId: "synthetic-protocol-sum",
      kind: "synthetic" as const,
      problem: syntheticProblem()
    },
    ...loadPublicProblems()
  ];
  const results: ProbeResult[] = [];
  let stopNewRequests = false;
  let dispatcherCloseFailure = false;
  let checkpointRevision = 0;
  const resultsDirectory = fileURLToPath(
    new URL("../private/difficulty-thinking-probe-results/", import.meta.url)
  );
  const privateDirectory = preparePrivateDirectory(resultsDirectory);
  try {
  assertLabelNamespaceUnused(privateDirectory);
  const checkpointDocument = (
    state: CheckpointState,
    activeSampleId: string | null,
    complete: boolean,
    globalFailureCode: string | null
  ): Record<string, unknown> => ({
    schemaVersion: 1,
    label: reportLabel,
    codeVersion,
    runnerSha256,
    experimentVersion,
    sourceManifestSha256,
    providerIdentityFingerprint,
    anchorsFingerprint: strictAnchors.fingerprint,
    maxOutputTokens: maximumExplicitLlmOutputTokens,
    expected: samples.length,
    revision: checkpointRevision,
    state,
    activeSampleId,
    complete,
    globalFailureCode,
    results
  });
  const persistCheckpoint = (
    state: CheckpointState,
    activeSampleId: string | null = null,
    complete = false,
    globalFailureCode: string | null = null
  ): void => {
    checkpointRevision += 1;
    replaceCheckpoint(
      privateDirectory,
      checkpointRevision,
      checkpointDocument(state, activeSampleId, complete, globalFailureCode)
    );
  };

  writeDurableExclusive(
    privateDirectory,
    checkpointFileName,
    checkpointDocument("ready", null, false, null)
  );

  const dispatcher = new EnvHttpProxyAgent({
    connectTimeout: 0,
    headersTimeout: 0,
    bodyTimeout: 0
  });
  const baseFetch = createUndiciLlmFetch(dispatcher);
  const expectedRequestUrl = new URL(
    "chat/completions",
    credentials.baseUrl.endsWith("/")
      ? credentials.baseUrl
      : `${credentials.baseUrl}/`
  ).href;
  try {
    for (const sample of samples) {
      if (stopNewRequests) {
        results.push({
          sampleId: sample.sampleId,
          kind: sample.kind,
          status: "not_run",
          requestCount: 0,
          fetchInvocationCount: 0,
          httpStatus: null,
          schemaValidated: null,
          stopAndHttpEofVerified: null,
          code: "PROBE_NOT_RUN_AFTER_FAILURE"
        });
        persistCheckpoint("failed");
        continue;
      }
      let requestCount = 0;
      let fetchInvocationCount = 0;
      let httpStatus: number | null = null;
      let contractViolation = false;
      let multipleRequestBlocked = false;
      const checkedFetch: FetchLike = async (input, init) => {
        fetchInvocationCount += 1;
        if (fetchInvocationCount > 1) {
          multipleRequestBlocked = true;
          throw new Error("PROBE_MULTIPLE_REQUEST_BLOCKED");
        }
        try {
          thinkingRequestBodySchema.parse(
            JSON.parse(String(init?.body)) as unknown
          );
          if (
            String(input) !== expectedRequestUrl ||
            init?.method !== "POST"
          ) {
            throw new Error("PROBE_REQUEST_CONTRACT_INVALID");
          }
        } catch {
          contractViolation = true;
          throw new Error("PROBE_REQUEST_CONTRACT_INVALID");
        }
        requestCount += 1;
        const response = await baseFetch(input, init);
        httpStatus = response.status;
        return response;
      };
      persistCheckpoint("active", sample.sampleId);
      try {
        await runDifficultyPipeline({
          problem: sample.problem,
          anchors: strictAnchors.anchors as readonly DifficultyAnchor[],
          model: {
            spec: profile.difficulty,
            credentials,
            runtime: {
              firstOutputTimeoutMs: config.models.timeouts.llmFirstOutputMs,
              outputIdleTimeoutMs: config.models.timeouts.llmOutputIdleMs,
              maximumDurationMs: config.models.timeouts.llmMaximumDurationMs,
              maxAttempts: 1,
              baseDelayMs: config.models.retry.baseDelayMs,
              fetch: checkedFetch
            }
          }
        });
        if (requestCount !== 1 || fetchInvocationCount !== 1) {
          results.push({
            sampleId: sample.sampleId,
            kind: sample.kind,
            status: "failed",
            requestCount,
            fetchInvocationCount,
            httpStatus,
            schemaValidated: null,
            stopAndHttpEofVerified: null,
            code: "PROBE_REQUEST_COUNT_INVALID"
          });
          stopNewRequests = true;
        } else {
          results.push({
            sampleId: sample.sampleId,
            kind: sample.kind,
            status: "succeeded",
            requestCount,
            fetchInvocationCount,
            httpStatus,
            schemaValidated: true,
            stopAndHttpEofVerified: true,
            code: "PROBE_SUCCEEDED"
          });
        }
      } catch (error) {
        results.push({
          sampleId: sample.sampleId,
          kind: sample.kind,
          status: "failed",
          requestCount,
          fetchInvocationCount,
          httpStatus,
          schemaValidated: null,
          stopAndHttpEofVerified: null,
          code: safeFailureCode(
            error,
            contractViolation,
            multipleRequestBlocked
          )
        });
        stopNewRequests = true;
      }
      persistCheckpoint(stopNewRequests ? "failed" : "running");
      const latest = results.at(-1);
      process.stdout.write(
        `PROBE_PROGRESS sampleId=${sample.sampleId} code=${latest?.code ?? "PROBE_UNCLASSIFIED_FAILURE"} requests=${requestCount}\n`
      );
    }
    persistCheckpoint("closing");
  } finally {
    try {
      await dispatcher.close();
    } catch {
      dispatcherCloseFailure = true;
    }
  }

  const succeeded = results.filter((result) => result.status === "succeeded").length;
  const complete =
    succeeded === samples.length &&
    results.length === samples.length &&
    !dispatcherCloseFailure;
  const report = {
    schemaVersion: 1,
    label: reportLabel,
    codeVersion,
    runnerSha256,
    experimentVersion,
    sourceManifestSha256,
    providerIdentityFingerprint,
    anchorsFingerprint: strictAnchors.fingerprint,
    maxOutputTokens: maximumExplicitLlmOutputTokens,
    expected: samples.length,
    succeeded,
    failed: samples.length - succeeded,
    complete,
    globalFailureCode: dispatcherCloseFailure
      ? "PROBE_DISPATCHER_CLOSE_FAILED"
      : null,
    results
  };
  persistCheckpoint(
    "report_pending",
    null,
    false,
    dispatcherCloseFailure ? "PROBE_DISPATCHER_CLOSE_FAILED" : null
  );
  publishReport(privateDirectory, report);
  persistCheckpoint(
    complete ? "complete" : "incomplete",
    null,
    complete,
    dispatcherCloseFailure ? "PROBE_DISPATCHER_CLOSE_FAILED" : null
  );
  process.stdout.write(
    `PROBE_RUN_COMPLETE expected=${report.expected} succeeded=${report.succeeded} failed=${report.failed} complete=${report.complete}\n`
  );
  if (!complete) process.exitCode = 1;
  } finally {
    closePrivateDirectory(privateDirectory);
  }
}

main().catch(() => {
  process.stdout.write("PROBE_RUN_FAILED_INCOMPLETE\n");
  process.exitCode = 1;
});
