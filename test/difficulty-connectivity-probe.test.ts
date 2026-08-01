import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
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
  assertDifficultyConnectivityCodeBinding,
  assertDifficultyConnectivityInvocationEnvironment,
  assertDifficultyConnectivityLabelNamespaceUnused,
  assertDifficultyConnectivityRepositoryStatus,
  buildDifficultyConnectivityCheckpoint,
  buildDifficultyConnectivityCompletion,
  difficultyConnectivityCheckpointSchema,
  difficultyConnectivityCompletionSchema,
  difficultyConnectivityCommonEvidenceSchema,
  difficultyConnectivityExpectedCandidateCAnchorsSha256,
  difficultyConnectivityExpectedModelsConfigSha256,
  difficultyConnectivityExpectedProviderIdentitySha256,
  difficultyConnectivityProbeCompletionFileName,
  difficultyConnectivityProbeArtifactSchemaVersion,
  difficultyConnectivityProbeExperimentVersion,
  difficultyConnectivityProbeLabel,
  difficultyConnectivityProbeLockRecordSchema,
  difficultyConnectivityProbeRequestBodySchema,
  difficultyConnectivityProbeResultSchema,
  difficultyConnectivityPreviousProbeLabels,
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
    formatFailureStage: null,
    formatFailureSubstage: null,
    code: "CONNECTIVITY_PROBE_SUCCEEDED"
  };
}

function validCommonEvidence() {
  return {
    schemaVersion: 2 as const,
    label: difficultyConnectivityProbeLabel,
    experimentVersion: difficultyConnectivityProbeExperimentVersion,
    codeVersion: "b".repeat(40),
    runnerSha256: "c".repeat(64),
    modelsConfigSha256: difficultyConnectivityExpectedModelsConfigSha256,
    candidateCAnchorsSha256:
      difficultyConnectivityExpectedCandidateCAnchorsSha256,
    providerIdentitySha256:
      difficultyConnectivityExpectedProviderIdentitySha256,
    model: "deepseek-v4-flash" as const,
    thinking: false as const,
    thinkingRequest: "disabled" as const,
    maxOutputTokens: 2_048 as const,
    maximumPaidRequests: 1 as const,
    expected: 1 as const,
    completionAuthorityFileName:
      difficultyConnectivityProbeCompletionFileName
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
  it("全新 d 身份严格绑定 v5、schema v2 与当前配置，a/b/c 永久历史化", () => {
    expect(difficultyConnectivityProbeExperimentVersion).toBe(
      "experiment-2026-08-difficulty-candidate-c-provider-v1-drain-v5"
    );
    expect(difficultyConnectivityProbeArtifactSchemaVersion).toBe(2);
    expect(difficultyConnectivityExpectedModelsConfigSha256).toBe(
      "326a0f7d67122db493529929944b8984d64f66092535a596a89afe66ad744df8"
    );
    expect(sha256ConnectivityProbe(
      readFileSync(new URL("../config/models.yaml", import.meta.url))
    )).toBe(difficultyConnectivityExpectedModelsConfigSha256);
    expect(difficultyConnectivityProbeLabel).toBe(
      "difficulty-candidate-c-connectivity-probe-20260801-d"
    );
    expect(difficultyConnectivityPreviousProbeLabels).toEqual([
      "difficulty-candidate-c-connectivity-probe-20260801-a",
      "difficulty-candidate-c-connectivity-probe-20260801-b",
      "difficulty-candidate-c-connectivity-probe-20260801-c"
    ]);
    for (const previousLabel of difficultyConnectivityPreviousProbeLabels) {
      expect(difficultyConnectivityProbeCompletionFileName).not.toContain(
        `${previousLabel}.`
      );
    }
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

  it("提交前 runner 字节、错误 EVAL_CODE_VERSION 或脏工作树都 fail closed", () => {
    const trackedRunner = "tracked runner bytes";
    const headCodeVersion = "a".repeat(40);
    expect(assertDifficultyConnectivityCodeBinding({
      headCodeVersion,
      evalCodeVersion: headCodeVersion,
      currentRunner: trackedRunner,
      trackedRunner
    })).toEqual({
      codeVersion: headCodeVersion,
      runnerSha256: sha256ConnectivityProbe(trackedRunner)
    });
    for (const invalid of [
      {
        headCodeVersion,
        evalCodeVersion: headCodeVersion,
        currentRunner: "uncommitted runner bytes",
        trackedRunner
      },
      {
        headCodeVersion,
        evalCodeVersion: "b".repeat(40),
        currentRunner: trackedRunner,
        trackedRunner
      },
      {
        headCodeVersion: "not-a-commit",
        evalCodeVersion: "not-a-commit",
        currentRunner: trackedRunner,
        trackedRunner
      }
    ]) {
      expect(() => assertDifficultyConnectivityCodeBinding(invalid)).toThrow(
        "CONNECTIVITY_PROBE_CONFIGURATION_INVALID"
      );
    }
    expect(() => assertDifficultyConnectivityRepositoryStatus({
      porcelain: " M README.md\n",
      trackedPrivatePaths: "",
      privatePathIgnored: true
    })).toThrow("CONNECTIVITY_PROBE_REPOSITORY_NOT_CLEAN");
  });

  it("调用者的 Git 仓库与索引注入在接触私有目录前固定拒绝", () => {
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
      const marker = `synthetic-${key.toLowerCase()}-must-not-appear`;
      let caught: unknown;
      try {
        assertDifficultyConnectivityInvocationEnvironment({
          PATH: "/untrusted",
          [key]: marker
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(
        "CONNECTIVITY_PROBE_CONFIGURATION_INVALID"
      );
      expect(String(caught)).not.toContain(marker);
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
      formatFailureStage: null,
      code: "CONNECTIVITY_PROBE_MULTIPLE_REQUEST_BLOCKED"
    });
  });

  it("畸形首事件排空到 EOF 后保留固定阶段且不取消正文", async () => {
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const baseFetch = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(encoder.encode("data: not-json\n\n"));
        },
        cancel() {
          cancelled = true;
        }
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    ));

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
    streamController.enqueue(encoder.encode("ignored-after-format-error"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(cancelled).toBe(false);
    streamController.close();

    await expect(pending).resolves.toMatchObject({
      status: "failed",
      requestCount: 1,
      fetchInvocationCount: 1,
      httpStatus: 200,
      httpEofObserved: true,
      responseBodyCancelled: false,
      schemaValidated: null,
      stopAndHttpEofVerified: null,
      formatFailureStage: "event_json",
      code: "LLM_RESPONSE_FORMAT_INVALID"
    });
  });

  it.each([
    {
      substage: "duplicate_done",
      invalidEvents: ["data: [DONE]", "", "data: [DONE]", "", ""].join("\n")
    },
    {
      substage: "data_after_done",
      invalidEvents: [
        "data: [DONE]",
        "",
        'data: {"private_provider_payload":"不应落盘"}',
        "",
        ""
      ].join("\n")
    },
    {
      substage: "choice_after_stop",
      invalidEvents: [
        'data: {"choices":[{"delta":{"content":"不应采用"}}]}',
        "",
        ""
      ].join("\n")
    }
  ] as const)(
    "报告只保留封闭终止子阶段且等待真实 EOF：$substage",
    async ({ substage, invalidEvents }) => {
      const encoder = new TextEncoder();
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      let cancelled = false;
      const validContent = JSON.stringify({
        rating: 800,
        confidence: 0.9,
        rationale: "合成样本"
      });
      const baseFetch = vi.fn(async () => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          },
          cancel() {
            cancelled = true;
          }
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ));
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
      streamController.enqueue(encoder.encode([
        `data: ${JSON.stringify({
          choices: [{
            delta: { content: validContent },
            finish_reason: "stop"
          }]
        })}`,
        "",
        invalidEvents
      ].join("\n")));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(cancelled).toBe(false);
      streamController.enqueue(encoder.encode("不应落盘的排空尾部"));
      streamController.close();

      const result = await pending;
      expect(result).toMatchObject({
        status: "failed",
        requestCount: 1,
        fetchInvocationCount: 1,
        httpStatus: 200,
        httpEofObserved: true,
        responseBodyCancelled: false,
        formatFailureStage: "trailing_data",
        formatFailureSubstage: substage,
        code: "LLM_RESPONSE_FORMAT_INVALID"
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("private_provider_payload");
      expect(serialized).not.toContain("不应落盘");
      expect(serialized).not.toContain("排空尾部");
    }
  );

  it("结果 schema 拒绝未知子阶段、主子阶段错配、外部错误码和额外字段", () => {
    const failed = {
      ...validResult(),
      status: "failed" as const,
      schemaValidated: null,
      stopAndHttpEofVerified: null,
      formatFailureStage: "trailing_data" as const,
      formatFailureSubstage: "duplicate_done" as const,
      code: "LLM_RESPONSE_FORMAT_INVALID"
    };
    expect(difficultyConnectivityProbeResultSchema.parse(failed)).toEqual(failed);
    for (const invalid of [
      { ...failed, formatFailureSubstage: "provider_private_value" },
      { ...failed, formatFailureStage: "event_json" },
      { ...failed, code: "PRIVATE_PROVIDER_ERROR_TEXT" },
      { ...failed, private_provider_payload: "不应落盘" }
    ]) {
      expect(() => difficultyConnectivityProbeResultSchema.parse(invalid)).toThrow();
    }
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
        commonEvidence: validCommonEvidence(),
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
  it("保留旧 a/b/c 产物，但 d 只认自己的独立命名空间", () => {
    const fixture = setupPrivateDirectory();
    try {
      for (const previousLabel of difficultyConnectivityPreviousProbeLabels) {
        publishDifficultyConnectivityArtifactExclusive(
          fixture.handle,
          `${previousLabel}.completion.private.json`,
          `previous-${previousLabel.at(-1) ?? "unknown"}-label-test`,
          { complete: false }
        );
      }
      expect(() =>
        assertDifficultyConnectivityLabelNamespaceUnused(fixture.handle)
      ).not.toThrow();

      writeFileSync(
        join(fixture.output, difficultyConnectivityProbeCompletionFileName),
        `${JSON.stringify({
          label: "difficulty-candidate-c-connectivity-probe-20260801-c",
          complete: false
        })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 }
      );
      expect(() =>
        assertDifficultyConnectivityLabelNamespaceUnused(fixture.handle)
      ).toThrow("CONNECTIVITY_PROBE_LABEL_ALREADY_USED");
    } finally {
      closePrivateDirectory(fixture.handle);
    }
  });

  it("a/b/c 的旧 completion 即使改名也不能通过 d 的严格 schema", () => {
    const completion = buildDifficultyConnectivityCompletion({
      commonEvidence: validCommonEvidence(),
      result: validResult(),
      globalFailureCode: null,
      labelLockReleased: true,
      checkpointSha256: "a".repeat(64)
    });
    for (const previousLabel of difficultyConnectivityPreviousProbeLabels) {
      expect(() => difficultyConnectivityCompletionSchema.parse({
        ...completion,
        label: previousLabel,
        completionAuthorityFileName:
          `${previousLabel}.completion.private.json`
      })).toThrow();
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

      const checkpointDocument = buildDifficultyConnectivityCheckpoint({
        commonEvidence: validCommonEvidence(),
        revision: 0,
        state: "ready",
        activeSampleId: null,
        globalFailureCode: null,
        labelLockReleased: false,
        result: null
      });
      publishDifficultyConnectivityArtifactExclusive(
        fixture.handle,
        `${difficultyConnectivityProbeLabel}.checkpoint.private.json`,
        "checkpoint-test",
        checkpointDocument
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

  it("公共证据与 checkpoint 只接受精确字段和固定全局错误码", () => {
    const commonEvidence = validCommonEvidence();
    expect(difficultyConnectivityCommonEvidenceSchema.parse(commonEvidence))
      .toEqual(commonEvidence);
    const checkpoint = buildDifficultyConnectivityCheckpoint({
      commonEvidence,
      revision: 1,
      state: "failed",
      activeSampleId: null,
      globalFailureCode: "CONNECTIVITY_PROBE_RESULT_MISSING",
      labelLockReleased: false,
      result: null
    });
    expect(difficultyConnectivityCheckpointSchema.parse(checkpoint)).toEqual(
      checkpoint
    );

    const sensitiveText = "不应进入产物或固定错误信息的服务商原文";
    for (const invalid of [
      {
        commonEvidence,
        globalFailureCode: sensitiveText
      },
      {
        commonEvidence: {
          ...commonEvidence,
          privateProviderPayload: sensitiveText
        },
        globalFailureCode: null
      }
    ]) {
      const error = (() => {
        try {
          buildDifficultyConnectivityCheckpoint({
            commonEvidence: invalid.commonEvidence,
            revision: 2,
            state: "failed",
            activeSampleId: null,
            globalFailureCode: invalid.globalFailureCode,
            labelLockReleased: false,
            result: null
          });
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "CONNECTIVITY_PROBE_RESULT_CONTRACT_INVALID"
      );
      expect((error as Error).message).not.toContain(sensitiveText);
    }
  });

  it("completion 拒绝未知全局码和公共证据额外字段且只抛固定错误", () => {
    const sensitiveText = "不应进入 completion 或错误信息的外部原文";
    const invalidInputs = [
      {
        commonEvidence: validCommonEvidence(),
        globalFailureCode: sensitiveText
      },
      {
        commonEvidence: {
          ...validCommonEvidence(),
          privateProviderPayload: sensitiveText
        },
        globalFailureCode: null
      }
    ];
    for (const invalid of invalidInputs) {
      const error = (() => {
        try {
          buildDifficultyConnectivityCompletion({
            ...invalid,
            result: validResult(),
            labelLockReleased: true,
            checkpointSha256: "a".repeat(64)
          });
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "CONNECTIVITY_PROBE_RESULT_CONTRACT_INVALID"
      );
      expect((error as Error).message).not.toContain(sensitiveText);
    }
  });

  it("当前 checkpoint/completion 文件在写盘前再次执行严格 schema", () => {
    const fixture = setupPrivateDirectory();
    try {
      for (const [fileName, invalid] of [
        [
          `${difficultyConnectivityProbeLabel}.checkpoint.private.json`,
          { privateProviderPayload: "不应写盘" }
        ],
        [
          difficultyConnectivityProbeCompletionFileName,
          { globalFailureCode: "不应写盘" }
        ]
      ] as const) {
        expect(() => publishDifficultyConnectivityArtifactExclusive(
          fixture.handle,
          fileName,
          "invalid-artifact-test",
          invalid
        )).toThrow("CONNECTIVITY_PROBE_RESULT_CONTRACT_INVALID");
        expect(() => lstatSync(join(fixture.output, fileName))).toThrow();
      }
    } finally {
      closePrivateDirectory(fixture.handle);
    }
  });

  it("completion 最后排他发布、绑定 checkpoint 哈希且绝不覆盖旧证据", () => {
    const fixture = setupPrivateDirectory();
    try {
      const checkpoint = buildDifficultyConnectivityCheckpoint({
        commonEvidence: validCommonEvidence(),
        revision: 1,
        state: "completion_pending",
        activeSampleId: null,
        globalFailureCode: null,
        labelLockReleased: true,
        result: validResult()
      });
      const checkpointPath = anchoredPrivatePath(
        fixture.handle,
        `${difficultyConnectivityProbeLabel}.checkpoint.private.json`
      );
      const checkpointSha = publishDifficultyConnectivityArtifactExclusive(
        fixture.handle,
        `${difficultyConnectivityProbeLabel}.checkpoint.private.json`,
        "checkpoint-final",
        checkpoint
      );
      expect(sha256ConnectivityProbe(readFileSync(checkpointPath))).toBe(checkpointSha);
      const completion = buildDifficultyConnectivityCompletion({
        commonEvidence: validCommonEvidence(),
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
        commonEvidence: validCommonEvidence(),
        result: validResult(),
        globalFailureCode: "CONNECTIVITY_PROBE_DISPATCHER_CLOSE_FAILED",
        labelLockReleased: true,
        checkpointSha256: "a".repeat(64)
      }).complete).toBe(false);
      expect(buildDifficultyConnectivityCompletion({
        commonEvidence: validCommonEvidence(),
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
