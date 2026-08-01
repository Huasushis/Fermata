import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anchoredPrivatePath,
  closePrivateDirectory,
  preparePrivateDirectory
} from "../scripts/private-runtime.mjs";
import type { ModelSpec, ProviderCredentials } from "../src/config";
import type { LlmRuntimeOptions } from "../src/llm";
import type { ReviewTaskProblem } from "../src/pipelines/types";
import {
  acquireDifficultyConnectivityLabelLock,
  assertDifficultyConnectivityLabelNamespaceUnused,
  assertDifficultyConnectivityRepositoryStatus,
  buildDifficultyConnectivityCompletion,
  difficultyConnectivityExpectedModelsConfigSha256,
  difficultyConnectivityExpectedProviderIdentitySha256,
  difficultyConnectivityProbeCompletionFileName,
  difficultyConnectivityProbeExperimentVersion,
  difficultyConnectivityProbeLabel,
  difficultyConnectivityProbeLockRecordSchema,
  difficultyConnectivityProbeRequestBodySchema,
  difficultyConnectivityPreviousProbeLabel,
  executeDifficultyConnectivityProbe,
  isCompleteDifficultyConnectivityResult,
  publishDifficultyConnectivityArtifactExclusive,
  runSingleDifficultyConnectivitySequence,
  sha256ConnectivityProbe,
  type DifficultyConnectivityProbeResult
} from "../experiments/probe-difficulty-connectivity";

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const spec: ModelSpec = {
  provider: "aether",
  model: "deepseek-v4-flash",
  temperature: 0.2,
  thinking: false,
  thinkingRequest: "disabled"
};
const credentials: ProviderCredentials = {
  baseUrl: "https://aether.example.test/v1",
  apiKey: "synthetic-test-key"
};
const runtime: Omit<LlmRuntimeOptions, "fetch"> = {
  firstOutputTimeoutMs: 10_000,
  outputIdleTimeoutMs: 10_000,
  maximumDurationMs: 20_000,
  maxAttempts: 1,
  baseDelayMs: 1
};
const problem: ReviewTaskProblem = {
  id: "synthetic-connectivity-sum",
  revision: 1,
  reviewRound: 1,
  contentHash: "0".repeat(64),
  title: "synthetic",
  type: "traditional",
  tagIds: ["synthetic"],
  basicStatement: "synthetic statement",
  basicSolution: "synthetic solution"
};

const validRequestBody = {
  model: "deepseek-v4-flash",
  temperature: 0.2,
  stream: true,
  messages: [{ role: "user", content: "synthetic" }],
  thinking: { type: "disabled" },
  max_tokens: 2_048
};

function validResult(): DifficultyConnectivityProbeResult {
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
    code: "CONNECTIVITY_PROBE_SUCCEEDED"
  };
}

function eventStreamChunk(content: string): Uint8Array {
  const event = JSON.stringify({
    choices: [{ delta: { content }, finish_reason: "stop" }]
  });
  return new TextEncoder().encode(`data: ${event}\n\ndata: [DONE]\n\n`);
}

function closedEventStream(content: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(eventStreamChunk(content));
        controller.close();
      }
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

function setupPrivateDirectory() {
  const workspace = mkdtempSync(join(tmpdir(), "fermata-connectivity-probe-"));
  directories.push(workspace);
  chmodSync(workspace, 0o700);
  const repository = join(workspace, "Fermata");
  mkdirSync(repository, { mode: 0o700 });
  const privateRoot = join(repository, "private");
  mkdirSync(privateRoot, { mode: 0o700 });
  const output = join(privateRoot, "probe-results");
  const handle = preparePrivateDirectory(output, {
    privateRoot,
    containingWorkspace: workspace
  });
  return { output, handle };
}

describe("Candidate C 连通性请求契约", () => {
  it("新版本与 provider /v1 身份固定，不能沿用旧 a 标签", () => {
    expect(difficultyConnectivityProbeExperimentVersion).toBe(
      "experiment-2026-08-difficulty-candidate-c-provider-v1-v3"
    );
    expect(
      sha256ConnectivityProbe(
        readFileSync(new URL("../config/models.yaml", import.meta.url))
      )
    ).toBe(difficultyConnectivityExpectedModelsConfigSha256);
    expect(difficultyConnectivityProbeLabel).toBe(
      "difficulty-candidate-c-connectivity-probe-20260801-b"
    );
    expect(difficultyConnectivityPreviousProbeLabel).toBe(
      "difficulty-candidate-c-connectivity-probe-20260801-a"
    );
    expect(difficultyConnectivityProbeCompletionFileName).not.toContain(
      `${difficultyConnectivityPreviousProbeLabel}.`
    );
    expect(difficultyConnectivityExpectedProviderIdentitySha256).toBe(
      "6e913442f0833b7950c9ae934e46f437dad6ffd72bf847fbe3acee058256050c"
    );
    expect(difficultyConnectivityExpectedProviderIdentitySha256).not.toBe(
      "630b4c6feb6b32c4bbcacaad0fca69938a2cf503b4cb63569ff94fc6d62b53d6"
    );
  });

  it("只接受 flash、thinking false 对应的 disabled 请求且没有 reasoning_effort", () => {
    expect(difficultyConnectivityProbeRequestBodySchema.parse(validRequestBody)).toEqual(
      validRequestBody
    );
    for (const invalid of [
      { ...validRequestBody, model: "deepseek-v4-pro" },
      { ...validRequestBody, thinking: undefined },
      { ...validRequestBody, thinking: { type: "enabled" } },
      { ...validRequestBody, reasoning_effort: "low" },
      { ...validRequestBody, max_tokens: 4_096 }
    ]) {
      expect(() => difficultyConnectivityProbeRequestBodySchema.parse(invalid)).toThrow();
    }
  });

  it("tracked/untracked 必须干净，private 只能是已忽略且未跟踪路径", () => {
    expect(() => assertDifficultyConnectivityRepositoryStatus({
      porcelain: "",
      trackedPrivatePaths: "",
      privatePathIgnored: true
    })).not.toThrow();
    for (const invalid of [
      { porcelain: " M config/models.yaml\n", trackedPrivatePaths: "", privatePathIgnored: true },
      { porcelain: "", trackedPrivatePaths: "private/key.env\n", privatePathIgnored: true },
      { porcelain: "", trackedPrivatePaths: "", privatePathIgnored: false }
    ]) {
      expect(() => assertDifficultyConnectivityRepositoryStatus(invalid)).toThrow(
        "CONNECTIVITY_PROBE_REPOSITORY_NOT_CLEAN"
      );
    }
  });
});

describe("Candidate C 单请求与真实 EOF", () => {
  it("收到 stop 和 DONE 后仍等待 HTTP EOF，EOF 前绝不报告成功", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let requestBody: unknown;
    const baseFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as unknown;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(eventStreamChunk(JSON.stringify({
              rating: 800,
              confidence: 0.9,
              rationale: "合成样本"
            })));
          }
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    });

    let settled = false;
    const pending = executeDifficultyConnectivityProbe({
      problem,
      anchors: [],
      spec,
      credentials,
      runtime,
      baseFetch
    }).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(baseFetch).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(requestBody).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "disabled" },
      max_tokens: 2_048
    });
    expect(requestBody).not.toHaveProperty("reasoning_effort");

    streamController.close();
    await expect(pending).resolves.toEqual(validResult());
  });

  it("JSON 不合格触发的修复轮在第二次真实 fetch 前被拒绝", async () => {
    const baseFetch = vi.fn(async () => closedEventStream("not-json"));
    const result = await executeDifficultyConnectivityProbe({
      problem,
      anchors: [],
      spec,
      credentials,
      runtime,
      baseFetch
    });
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "failed",
      requestCount: 1,
      fetchInvocationCount: 2,
      httpEofObserved: true,
      code: "CONNECTIVITY_PROBE_MULTIPLE_REQUEST_BLOCKED"
    });
  });

  it("HTTP 499、取消和缺少 stop 都是 complete=false", async () => {
    const http499 = await executeDifficultyConnectivityProbe({
      problem,
      anchors: [],
      spec,
      credentials,
      runtime,
      baseFetch: async () => new Response(null, { status: 499 })
    });
    expect(http499).toMatchObject({
      status: "failed",
      httpStatus: 499,
      code: "LLM_HTTP_ERROR"
    });

    const cancelledController = new AbortController();
    cancelledController.abort();
    const cancelledFetch = vi.fn(async () => closedEventStream("unused"));
    const cancelled = await executeDifficultyConnectivityProbe({
      problem,
      anchors: [],
      spec,
      credentials,
      runtime: { ...runtime, signal: cancelledController.signal },
      baseFetch: cancelledFetch
    });
    expect(cancelled).toMatchObject({
      status: "failed",
      requestCount: 0,
      code: "LLM_CANCELLED"
    });
    expect(cancelledFetch).not.toHaveBeenCalled();

    const missingStopEvent = JSON.stringify({
      choices: [{ delta: { content: "{}" }, finish_reason: null }]
    });
    const missingStop = await executeDifficultyConnectivityProbe({
      problem,
      anchors: [],
      spec,
      credentials,
      runtime,
      baseFetch: async () => new Response(
        new TextEncoder().encode(`data: ${missingStopEvent}\n\ndata: [DONE]\n\n`),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    });
    expect(missingStop).toMatchObject({
      status: "failed",
      httpEofObserved: true,
      code: "LLM_STREAM_INTERRUPTED"
    });

    for (const failed of [http499, cancelled, missingStop]) {
      expect(isCompleteDifficultyConnectivityResult(failed)).toBe(false);
      expect(buildDifficultyConnectivityCompletion({
        commonEvidence: { label: difficultyConnectivityProbeLabel },
        result: failed,
        globalFailureCode: null,
        labelLockReleased: true,
        checkpointSha256: "a".repeat(64)
      }).complete).toBe(false);
    }
  });

  it("active 必须同步持久化完成后才执行唯一合成样本", async () => {
    const events: string[] = [];
    const execute = vi.fn(async () => {
      events.push("execute");
      return validResult();
    });
    const result = await runSingleDifficultyConnectivitySequence({
      execute,
      persist: (state, activeSampleId) => {
        events.push(`persist:${state}:${activeSampleId ?? "none"}`);
      }
    });
    expect(events).toEqual([
      "persist:active:synthetic-connectivity-sum",
      "execute",
      "persist:succeeded:none"
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual(validResult());
  });
});

describe("Candidate C 私有检查点、completion 与标签锁", () => {
  it("保留旧 a 产物，但 b 只认自己的独立命名空间", () => {
    const fixture = setupPrivateDirectory();
    try {
      publishDifficultyConnectivityArtifactExclusive(
        fixture.handle,
        `${difficultyConnectivityPreviousProbeLabel}.completion.private.json`,
        "previous-label-test",
        { complete: false }
      );
      expect(() =>
        assertDifficultyConnectivityLabelNamespaceUnused(fixture.handle)
      ).not.toThrow();

      publishDifficultyConnectivityArtifactExclusive(
        fixture.handle,
        `${difficultyConnectivityProbeLabel}.checkpoint.private.json`,
        "current-label-test",
        { complete: false }
      );
      expect(() =>
        assertDifficultyConnectivityLabelNamespaceUnused(fixture.handle)
      ).toThrow("CONNECTIVITY_PROBE_LABEL_ALREADY_USED");
    } finally {
      closePrivateDirectory(fixture.handle);
    }
  });

  it("标签锁排他且记录安全进程身份；旧证据使标签永久不可重用", () => {
    const fixture = setupPrivateDirectory();
    try {
      const first = acquireDifficultyConnectivityLabelLock(
        fixture.handle,
        "b".repeat(40),
        () => new Date("2026-08-01T00:00:00.000Z")
      );
      const lockPath = join(
        fixture.output,
        `${difficultyConnectivityProbeLabel}.lock.private`
      );
      const record = difficultyConnectivityProbeLockRecordSchema.parse(
        JSON.parse(readFileSync(lockPath, "utf8")) as unknown
      );
      expect(record).toMatchObject({
        processId: process.pid,
        codeVersion: "b".repeat(40),
        recoveryRule: "VERIFY_PID_START_TIME_FULL_COMMAND_AND_CWD_BEFORE_MANUAL_REMOVAL"
      });
      expect(lstatSync(lockPath).mode & 0o777).toBe(0o600);
      expect(() => acquireDifficultyConnectivityLabelLock(
        fixture.handle,
        "c".repeat(40)
      )).toThrow("CONNECTIVITY_PROBE_LABEL_LOCKED_OR_UNAVAILABLE");
      expect(() => assertDifficultyConnectivityLabelNamespaceUnused(fixture.handle)).not.toThrow();

      const checkpointDocument = "checkpoint-safe-document\n";
      publishDifficultyConnectivityArtifactExclusive(
        fixture.handle,
        `${difficultyConnectivityProbeLabel}.checkpoint.private.json`,
        "checkpoint-test",
        { value: checkpointDocument }
      );
      expect(() => assertDifficultyConnectivityLabelNamespaceUnused(fixture.handle)).toThrow(
        "CONNECTIVITY_PROBE_LABEL_ALREADY_USED"
      );
      expect(first.release()).toBe(true);

      const second = acquireDifficultyConnectivityLabelLock(
        fixture.handle,
        "c".repeat(40)
      );
      expect(() => assertDifficultyConnectivityLabelNamespaceUnused(fixture.handle)).toThrow(
        "CONNECTIVITY_PROBE_LABEL_ALREADY_USED"
      );
      expect(second.release()).toBe(true);
    } finally {
      closePrivateDirectory(fixture.handle);
    }
  });

  it("completion 最后排他发布、绑定 checkpoint 哈希且绝不覆盖旧证据", () => {
    const fixture = setupPrivateDirectory();
    try {
      const checkpoint = `${JSON.stringify({ state: "completion_pending", complete: false })}\n`;
      const checkpointPath = anchoredPrivatePath(
        fixture.handle,
        `${difficultyConnectivityProbeLabel}.checkpoint.private.json`
      );
      const checkpointSha = publishDifficultyConnectivityArtifactExclusive(
        fixture.handle,
        `${difficultyConnectivityProbeLabel}.checkpoint.private.json`,
        "checkpoint-final",
        JSON.parse(checkpoint) as unknown
      );
      expect(sha256ConnectivityProbe(readFileSync(checkpointPath))).toBe(checkpointSha);
      const completion = buildDifficultyConnectivityCompletion({
        commonEvidence: {
          label: difficultyConnectivityProbeLabel,
          codeVersion: "b".repeat(40),
          modelsConfigSha256: "c".repeat(64),
          providerIdentitySha256: "d".repeat(64)
        },
        result: validResult(),
        globalFailureCode: null,
        labelLockReleased: true,
        checkpointSha256: checkpointSha
      });
      expect(completion.complete).toBe(true);
      publishDifficultyConnectivityArtifactExclusive(
        fixture.handle,
        difficultyConnectivityProbeCompletionFileName,
        "completion-test",
        completion
      );
      const original = readFileSync(
        join(fixture.output, difficultyConnectivityProbeCompletionFileName),
        "utf8"
      );
      expect(() => publishDifficultyConnectivityArtifactExclusive(
        fixture.handle,
        difficultyConnectivityProbeCompletionFileName,
        "completion-test",
        { complete: false }
      )).toThrow();
      expect(readFileSync(
        join(fixture.output, difficultyConnectivityProbeCompletionFileName),
        "utf8"
      )).toBe(original);

      expect(buildDifficultyConnectivityCompletion({
        commonEvidence: {},
        result: validResult(),
        globalFailureCode: "CONNECTIVITY_PROBE_DISPATCHER_CLOSE_FAILED",
        labelLockReleased: true,
        checkpointSha256: "a".repeat(64)
      }).complete).toBe(false);
      expect(buildDifficultyConnectivityCompletion({
        commonEvidence: {},
        result: validResult(),
        globalFailureCode: null,
        labelLockReleased: false,
        checkpointSha256: "a".repeat(64)
      }).complete).toBe(false);
    } finally {
      closePrivateDirectory(fixture.handle);
    }
  });
});
