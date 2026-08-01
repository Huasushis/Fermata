import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  closePrivateDirectory,
  preparePrivateDirectory
} from "../scripts/private-runtime.mjs";
import type { DifficultyAnchor } from "../src/pipelines/difficulty";
import {
  assertCandidateCAnchorSet,
  assertCleanRepositoryStatus,
  assertProbeDoesNotOverlap,
  buildDifficultyProProbePrecompletionArtifacts,
  createDifficultyProSingleFetchGuard,
  difficultyProProbeLabel,
  difficultyProProbeManifestSchema,
  difficultyProProbeRequestBodySchema,
  publishDifficultyProArtifactExclusive,
  runDifficultyProProbeSequence,
  type DifficultyProProbeResult
} from "../experiments/probe-difficulty-pro";

const validRequestBody = {
  model: "deepseek-v4-pro",
  temperature: 0.2,
  stream: true,
  messages: [{ role: "user", content: "synthetic" }],
  max_tokens: 2048
};

function result(
  sampleId: string,
  kind: "synthetic" | "public",
  overrides: Partial<DifficultyProProbeResult> = {}
): DifficultyProProbeResult {
  return {
    sampleId,
    kind,
    status: "succeeded",
    requestCount: 1,
    fetchInvocationCount: 1,
    httpStatus: 200,
    schemaValidated: true,
    stopAndHttpEofVerified: true,
    code: "PROBE_SUCCEEDED",
    ...overrides
  };
}

describe("Candidate D 私有输入契约", () => {
  const hash = "a".repeat(64);
  const commit = "b".repeat(40);
  const manifest = {
    schemaVersion: 1,
    kind: "difficulty-pro-probe-input",
    label: difficultyProProbeLabel,
    source: {
      dataset: "open-r1/codeforces",
      license: "CC-BY-4.0",
      registeredManifestSha256:
        "edd286b5511ea7887e685c1cf7ee2b8aba75bf58f2ef5c914617807c3d6dc68e",
      sample: {
        safeId: "cf-2006e-public-probe",
        contestId: 2006,
        index: "E",
        rating: 3100,
        fileName: "2006E.json",
        fileSizeBytes: 1234,
        fileSha256: hash,
        statementSha256: hash
      }
    },
    bindings: {
      codeVersion: commit,
      runnerSha256: hash,
      modelsConfigSha256: hash,
      candidateCAnchorsSha256: hash,
      public83ManifestSha256: hash,
      providerIdentitySha256: hash
    }
  };

  it("只接受固定 CF 2006E、公有来源和完整运行绑定", () => {
    expect(difficultyProProbeManifestSchema.parse(manifest)).toEqual(manifest);
    expect(() =>
      difficultyProProbeManifestSchema.parse({
        ...manifest,
        source: {
          ...manifest.source,
          sample: { ...manifest.source.sample, contestId: 2007 }
        }
      })
    ).toThrow();
    expect(() =>
      difficultyProProbeManifestSchema.parse({
        ...manifest,
        bindings: { ...manifest.bindings, runnerSha256: undefined }
      })
    ).toThrow();
  });

  it("运行前同时排除 public83 和 Candidate C 锚点", () => {
    expect(() => assertProbeDoesNotOverlap([{ contestId: 1, index: "A" }], [])).not.toThrow();
    expect(() => assertProbeDoesNotOverlap([{ contestId: 2006, index: "E" }], [])).toThrow(
      "PROBE_SAMPLE_OVERLAP"
    );
    expect(() => assertProbeDoesNotOverlap([], [{ contestId: 2006, index: "E" }])).toThrow(
      "PROBE_SAMPLE_OVERLAP"
    );
  });

  it("Candidate C 锚点题号、评分和 provisional 状态不能漂移", () => {
    const anchors: DifficultyAnchor[] = [
      [1993, "A", 800],
      [2021, "C1", 1300],
      [2009, "F", 1700],
      [1998, "E1", 2200],
      [2003, "E1", 2600],
      [2027, "E2", 3100],
      [2013, "F2", 3500]
    ].map(([contestId, index, rating]) => ({
      contestId: contestId as number,
      index: index as string,
      rating: rating as number,
      summary: "公开摘要"
    }));
    expect(() => assertCandidateCAnchorSet(anchors, true)).not.toThrow();
    expect(() => assertCandidateCAnchorSet(anchors, false)).toThrow(
      "PROBE_CONFIGURATION_INVALID"
    );
    expect(() =>
      assertCandidateCAnchorSet(
        anchors.map((anchor, index) =>
          index === 0 ? { ...anchor, rating: 900 } : anchor
        ),
        true
      )
    ).toThrow("PROBE_CONFIGURATION_INVALID");
  });

  it("要求 tracked/untracked 都干净，只允许已确认忽略且未跟踪的 private", () => {
    expect(() =>
      assertCleanRepositoryStatus({
        porcelain: "",
        trackedPrivatePaths: "",
        privatePathIgnored: true
      })
    ).not.toThrow();
    for (const invalid of [
      { porcelain: "?? scratch.txt\n", trackedPrivatePaths: "", privatePathIgnored: true },
      { porcelain: "", trackedPrivatePaths: "private/key.env\n", privatePathIgnored: true },
      { porcelain: "", trackedPrivatePaths: "", privatePathIgnored: false }
    ]) {
      expect(() => assertCleanRepositoryStatus(invalid)).toThrow(
        "PROBE_REPOSITORY_NOT_CLEAN"
      );
    }
  });
});

describe("Candidate D 单次请求门", () => {
  it("请求体固定为 pro/0.2/2048 且不允许显式思考字段", () => {
    expect(difficultyProProbeRequestBodySchema.parse(validRequestBody)).toEqual(validRequestBody);
    for (const invalid of [
      { ...validRequestBody, model: "deepseek-v4-flash" },
      { ...validRequestBody, max_tokens: 4096 },
      { ...validRequestBody, thinking: { type: "disabled" } },
      { ...validRequestBody, reasoning_effort: "low" }
    ]) {
      expect(() => difficultyProProbeRequestBodySchema.parse(invalid)).toThrow();
    }
  });

  it("每题只把第一次合法 fetch 交给传输层，第二次 JSON repair 在网络前拒绝", async () => {
    const baseFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const guard = createDifficultyProSingleFetchGuard({
      baseFetch,
      expectedUrl: "https://aether.example.test/v1/chat/completions",
      expectedAuthorization: "Bearer test-key"
    });
    const init: RequestInit = {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(validRequestBody)
    };
    await expect(
      guard.fetch("https://aether.example.test/v1/chat/completions", init)
    ).resolves.toHaveProperty("status", 200);
    await expect(
      guard.fetch("https://aether.example.test/v1/chat/completions", init)
    ).rejects.toThrow("PROBE_MULTIPLE_REQUEST_BLOCKED");
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(guard.snapshot()).toMatchObject({
      requestCount: 1,
      fetchInvocationCount: 2,
      httpStatus: 200,
      multipleRequestBlocked: true
    });
  });

  it("URL、鉴权或请求体漂移时在网络前拒绝", async () => {
    const baseFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const guard = createDifficultyProSingleFetchGuard({
      baseFetch,
      expectedUrl: "https://aether.example.test/v1/chat/completions",
      expectedAuthorization: "Bearer test-key"
    });
    await expect(
      guard.fetch("https://wrong.example.test/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
        body: JSON.stringify(validRequestBody)
      })
    ).rejects.toThrow("PROBE_REQUEST_CONTRACT_INVALID");
    expect(baseFetch).not.toHaveBeenCalled();
    expect(guard.snapshot()).toMatchObject({
      requestCount: 0,
      fetchInvocationCount: 1,
      contractViolation: true
    });
  });
});

describe("Candidate D 顺序熔断", () => {
  const samples = [
    { sampleId: "synthetic-protocol-sum", kind: "synthetic" as const },
    { sampleId: "cf-2006e-public-probe", kind: "public" as const }
  ];

  it("先持久化 active 再执行；首题失败后第二题永久 not_run 且不调用 execute", async () => {
    const events: string[] = [];
    const execute = vi.fn(async (sample: (typeof samples)[number]) => {
      events.push(`execute:${sample.sampleId}`);
      return result(sample.sampleId, sample.kind, {
        status: "failed",
        schemaValidated: null,
        stopAndHttpEofVerified: null,
        code: "LLM_OUTPUT_LENGTH_LIMIT"
      });
    });
    const results = await runDifficultyProProbeSequence({
      samples,
      execute,
      persist: (state, activeSampleId) => {
        events.push(`persist:${state}:${activeSampleId ?? "none"}`);
      }
    });
    expect(events.slice(0, 2)).toEqual([
      "persist:active:synthetic-protocol-sum",
      "execute:synthetic-protocol-sum"
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(results.map(({ status, code }) => ({ status, code }))).toEqual([
      { status: "failed", code: "LLM_OUTPUT_LENGTH_LIMIT" },
      { status: "not_run", code: "PROBE_NOT_RUN_AFTER_FAILURE" }
    ]);
  });

  it("两题都满足一次请求、HTTP 200、schema、stop 和真实 EOF 才全部成功", async () => {
    const results = await runDifficultyProProbeSequence({
      samples,
      execute: async (sample) => result(sample.sampleId, sample.kind),
      persist: () => undefined
    });
    expect(results.every((item) => item.status === "succeeded")).toBe(true);

    const invalidResults = await runDifficultyProProbeSequence({
      samples,
      execute: async (sample) => result(sample.sampleId, sample.kind, { httpStatus: 201 }),
      persist: () => undefined
    });
    expect(invalidResults[0]).toMatchObject({
      status: "failed",
      code: "PROBE_RESULT_CONTRACT_INVALID"
    });
    expect(invalidResults[1]).toMatchObject({ status: "not_run" });
  });

  it("关闭失败会否决候选结果，report/summary 永远不提前声称 complete", () => {
    const successfulResults = samples.map((sample) => result(sample.sampleId, sample.kind));
    const candidate = buildDifficultyProProbePrecompletionArtifacts({
      commonEvidence: { label: difficultyProProbeLabel },
      expected: 2,
      results: successfulResults,
      globalFailureCode: null
    });
    expect(candidate.allSuccessConditionsMet).toBe(true);
    expect(candidate.report).not.toHaveProperty("complete");
    expect(candidate.summary).not.toHaveProperty("complete");
    expect(candidate.report).toMatchObject({
      artifactRole: "non_authoritative_evidence",
      allSuccessConditionsMet: true
    });

    const closeFailed = buildDifficultyProProbePrecompletionArtifacts({
      commonEvidence: { label: difficultyProProbeLabel },
      expected: 2,
      results: successfulResults,
      globalFailureCode: "PROBE_DISPATCHER_CLOSE_FAILED"
    });
    expect(closeFailed.allSuccessConditionsMet).toBe(false);
    expect(closeFailed.report).not.toHaveProperty("complete");
    expect(closeFailed.summary).not.toHaveProperty("complete");
  });
});

describe("Candidate D 终态产物发布", () => {
  it("排他发布不覆盖旧证据，失败后保留 next 文件使标签不可重用", () => {
    const workspace = mkdtempSync(join(tmpdir(), "fermata-pro-probe-artifact-"));
    chmodSync(workspace, 0o700);
    const repository = join(workspace, "Fermata");
    const privateRoot = join(repository, "private");
    mkdirSync(repository, { mode: 0o700 });
    mkdirSync(privateRoot, { mode: 0o700 });
    const resultDirectory = join(privateRoot, "results");
    const handle = preparePrivateDirectory(resultDirectory, {
      privateRoot,
      containingWorkspace: workspace
    });
    try {
      const finalFileName = "artifact.private.json";
      const firstSha = publishDifficultyProArtifactExclusive(
        handle,
        finalFileName,
        "artifact-test",
        { value: "first" }
      );
      const firstDocument = readFileSync(join(resultDirectory, finalFileName), "utf8");
      expect(firstSha).toHaveLength(64);
      expect(firstDocument).toContain('"first"');

      expect(() =>
        publishDifficultyProArtifactExclusive(
          handle,
          finalFileName,
          "artifact-test",
          { value: "replacement" }
        )
      ).toThrow();
      expect(readFileSync(join(resultDirectory, finalFileName), "utf8")).toBe(firstDocument);
      expect(
        readdirSync(resultDirectory).some((name) => name.endsWith("artifact-test.next.private.json"))
      ).toBe(true);
    } finally {
      closePrivateDirectory(handle);
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
