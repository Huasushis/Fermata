import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeDevelopmentSmokePhase0,
  executeDevelopmentSmokePhase1,
  preflightDevelopmentSmokePhase1,
  type DevelopmentSmokePreflight
} from "../experiments/lib/development-smoke-launcher";
import {
  developmentSmokeProfile,
  parseDevelopmentSmokeManifest,
  summarizeDevelopmentSmokeManifest
} from "../src/review-flow/development-smoke";

const temporaryRoots: string[] = [];
const digest = (character: string): string => character.repeat(64);

function fixturePreflight(
  root: string,
  allCases = false
): DevelopmentSmokePreflight {
  const manifest = parseDevelopmentSmokeManifest({
    schemaVersion: 1,
    profileName: developmentSmokeProfile.name,
    slots: [
      slot("slot-01", "low", "pass", ["schema_invalid"], "1"),
      slot("slot-02", "middle", "reject", ["output_limit"], "2"),
      slot("slot-03", "high", "pass", [], "3"),
      slot("slot-04", "middle", "reject", [], "4"),
      slot("slot-05", "high", "pass", [], "5"),
      slot("slot-06", "high", "reject", [], "6")
    ]
  });
  const manifestFingerprint = summarizeDevelopmentSmokeManifest(manifest)
    .manifestFingerprint;
  const source = {
    statement: {
      type: "traditional" as const,
      statement: "SENSITIVE_SOURCE_MUST_NOT_ENTER_CHECKPOINT",
      constraints: "1 <= n <= 10",
      samples: [],
      limits: { timeMs: 1_000, memoryMiB: 256 }
    },
    referenceSolution: {
      solution: "SENSITIVE_SOLUTION_MUST_NOT_ENTER_CHECKPOINT",
      referenceImplementation: null
    },
    technicalContext: {
      constraints: "1 <= n <= 10",
      samples: [],
      limits: { timeMs: 1_000, memoryMiB: 256 }
    },
    historicalTasteRubric: null,
    difficultyAnchors: null,
    labelCatalog: { version: 1, tags: [] },
    hardRules: { duplicateSimilarityRejectThreshold: 0.9 }
  };
  return {
    manifestPath: resolve(root, "manifest.private.json"),
    manifestFileSha256: digest("a"),
    manifest,
    privateManifest: {} as never,
    cases: manifest.slots
      .slice(0, allCases ? 6 : 2)
      .map((binding) => ({
        slot: binding.slot,
        sourceBinding: binding.slotBindingHash,
        source,
        truthBindingHash: binding.truthBindingHash
      })),
    models: {} as never,
    codeVersion: "b".repeat(40),
    repositoryRoot: root,
    privateRuntimeRoot: resolve(root, "private/runtime"),
    safeSummary: {
      slots: 6,
      phase0Slots: 2,
      provider: "aether",
      models: ["deepseek-v4-pro", "deepseek-v4-flash"],
      concurrency: 12,
      retries: 0,
      externalAttemptCeiling: 30,
      manifestFingerprint
    }
  };
}

function offlineModels(
  fetch: NonNullable<DevelopmentSmokePreflight["models"]["A"]["runtime"]["fetch"]>
): DevelopmentSmokePreflight["models"] {
  const credentials = {
    baseUrl: "https://offline-transport.invalid/v1",
    apiKey: "offline-test-only"
  };
  const runtime = {
    outputIdleTimeoutMs: developmentSmokeProfile.outputIdleTimeoutMs,
    firstOutputTimeoutMs: developmentSmokeProfile.firstValidOutputTimeoutMs,
    maximumDurationMs: developmentSmokeProfile.preFirstOutputFallbackMs,
    maxAttempts: 1,
    baseDelayMs: 500,
    fetch
  };
  const model = (name: "deepseek-v4-pro" | "deepseek-v4-flash") => ({
    spec: {
      provider: "aether" as const,
      model: name,
      temperature: 0,
      thinking: false,
      thinkingRequest: "enabled" as const,
      reasoningEffort: "max" as const
    },
    credentials,
    runtime
  });
  return {
    A: model("deepseek-v4-pro"),
    B: model("deepseek-v4-flash"),
    C: model("deepseek-v4-pro"),
    D: model("deepseek-v4-pro"),
    formatter: model("deepseek-v4-flash")
  };
}

function slot(
  anonymousSlot: string,
  difficultyTruth: "low" | "middle" | "high",
  verdictTruth: "pass" | "reject",
  priorFailures: readonly ("output_limit" | "schema_invalid")[],
  seed: string
) {
  return {
    slot: anonymousSlot,
    slotBindingHash: digest(seed),
    truthBindingHash: digest(seed.toUpperCase()),
    difficultyTruth,
    verdictTruth,
    priorFailures
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function validStageOutput(stage: "A" | "B" | "C" | "D"): string {
  const output = {
    A: {
      solvable: true,
      blindSolution: "synthetic",
      positiveSignals: ["synthetic"],
      negativeSignals: []
    },
    B: {
      codeforcesDifficulty: 1800,
      thinkingLevel: 4,
      codingLevel: 3,
      rationale: "synthetic"
    },
    C: {
      solutionAnalysis: "synthetic",
      technicalQuality: "synthetic",
      editorialQuality: "synthetic",
      contestFit: "acceptable",
      originalityLevel: 4,
      tagIds: ["synthetic"],
      positiveSignals: ["synthetic"],
      negativeSignals: [],
      hardBlockers: []
    },
    D: {
      verdict: "approve",
      qualityLevel: 4,
      acceptedSignals: ["synthetic"],
      rejectedSignals: [],
      hardBlockers: [],
      improvements: "synthetic",
      publicComment: "synthetic",
      privateNote: "synthetic"
    }
  } as const;
  return JSON.stringify(output[stage]);
}

function validOfflineTransport(
  entered?: (stage: "A" | "B" | "C" | "D") => void
) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      readonly response_format?: {
        readonly json_schema?: { readonly name?: string };
      };
    };
    const stage = body.response_format?.json_schema?.name
      ?.match(/_([abcd])_v1$/u)?.[1]?.toUpperCase();
    if (stage !== "A" && stage !== "B" && stage !== "C" && stage !== "D") {
      throw new Error("SYNTHETIC_STAGE_INVALID");
    }
    entered?.(stage);
    return new Response(JSON.stringify({
      choices: [{
        message: { role: "assistant", content: validStageOutput(stage) },
        finish_reason: "stop"
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });
}

function validOfflineSseTransport() {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      readonly response_format?: {
        readonly json_schema?: { readonly name?: string };
      };
    };
    const stage = body.response_format?.json_schema?.name
      ?.match(/_([abcd])_v1$/u)?.[1]?.toUpperCase();
    if (stage !== "A" && stage !== "B" && stage !== "C" && stage !== "D") {
      throw new Error("SYNTHETIC_STAGE_INVALID");
    }
    return new Response([
      ": heartbeat",
      "",
      `data: ${JSON.stringify({
        choices: [],
        usage: { total_tokens: 7 }
      })}`,
      "",
      `data: ${JSON.stringify({
        choices: [{ delta: { content: validStageOutput(stage) } }]
      })}`,
      "",
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
      ""
    ].join("\n"), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    });
  });
}

async function completeSyntheticPhase0(root: string) {
  const transport = validOfflineTransport();
  const preflight = {
    ...fixturePreflight(root, true),
    models: offlineModels(transport)
  };
  const t0 = new Date("2026-08-12T00:00:00.000Z");
  const result = await executeDevelopmentSmokePhase0({
    preflight,
    now: () => t0
  });
  expect(result).toMatchObject({ state: "phase0_complete", requestCount: 8 });
  expect(transport).toHaveBeenCalledTimes(8);
  return { preflight, result, transport, t0 };
}

function checkpointPaths(
  preflight: DevelopmentSmokePreflight,
  runId: string
): string[] {
  const directory = resolve(preflight.privateRuntimeRoot, `run-${runId}`);
  return readdirSync(directory)
    .filter((name) => name.startsWith("checkpoint-"))
    .sort()
    .map((name) => resolve(directory, name));
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("development smoke private checkpoint", () => {
  it("persists authorization receipts before entering an injected offline transport", async () => {
    const root = mkdtempSync(join(tmpdir(), "fermata-smoke-authorization-"));
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    const transport = vi.fn(async () => {
      throw new Error("OFFLINE_TRANSPORT_BOUNDARY");
    });
    const preflight = {
      ...fixturePreflight(root),
      models: offlineModels(transport)
    };

    const result = await executeDevelopmentSmokePhase0({ preflight });

    const runDirectory = resolve(
      preflight.privateRuntimeRoot,
      `run-${result.runId}`
    );
    const checkpointNames = readdirSync(runDirectory)
      .filter((name) => name.startsWith("checkpoint-"))
      .sort();
    const checkpoint = JSON.parse(readFileSync(
      resolve(runDirectory, checkpointNames.at(-1)!),
      "utf8"
    ));
    expect(checkpoint.failureCode).toBe("connect");
    expect(result).toMatchObject({
      state: "incomplete",
      requestCount: 4
    });
    expect(transport).toHaveBeenCalledTimes(4);
    expect(checkpoint.phase1Released).toBe(false);
    expect(checkpoint.requests).toHaveLength(4);
    expect(checkpoint.requests.every(
      (request: { receipt: { schemaFingerprint?: string }; failureKind?: string }) =>
        request.receipt.schemaFingerprint?.length === 64 &&
        request.failureKind === "connect"
    )).toBe(true);
    expect(checkpoint.requests.every(
      (request: { failureDetail?: { code?: string; transportAttemptCount?: number } }) =>
        request.failureDetail?.code === "LLM_NETWORK_FAILED" &&
        request.failureDetail.transportAttemptCount === 1
    )).toBe(true);
  });

  it("persists accepted SSE shape aggregates through strict private checkpoints", async () => {
    const root = mkdtempSync(join(tmpdir(), "fermata-smoke-sse-shapes-"));
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    const transport = validOfflineSseTransport();
    const preflight = {
      ...fixturePreflight(root),
      models: offlineModels(transport)
    };

    const result = await executeDevelopmentSmokePhase0({ preflight });
    const checkpoint = JSON.parse(readFileSync(
      checkpointPaths(preflight, result.runId).at(-1)!,
      "utf8"
    )) as {
      readonly requests: readonly {
        readonly timing?: {
          readonly acceptedEventShapes?: readonly {
            readonly category: string;
            readonly shapeFingerprint: string;
            readonly count: number;
          }[];
        };
      }[];
    };

    expect(result).toMatchObject({ state: "phase0_complete", requestCount: 8 });
    expect(transport).toHaveBeenCalledTimes(8);
    expect(checkpoint.requests).toHaveLength(8);
    for (const request of checkpoint.requests) {
      expect(request.timing?.acceptedEventShapes?.map(({ category, count }) => ({
        category,
        count
      }))).toEqual([
        { category: "content", count: 1 },
        { category: "done", count: 1 },
        { category: "finish", count: 1 },
        { category: "metadata", count: 1 },
        { category: "usage", count: 1 }
      ]);
      for (const shape of request.timing?.acceptedEventShapes ?? []) {
        expect(shape.shapeFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      }
    }
  });

  it("persists rejected SSE structure without field values and never retries it", async () => {
    const privateSentinel = "SYNTHETIC_PRIVATE_CHECKPOINT_VALUE";
    const root = mkdtempSync(join(tmpdir(), "fermata-smoke-sse-rejected-"));
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    const transport = vi.fn(async () => new Response([
      ": heartbeat",
      "",
      'data: {"choices":[],"usage":{"total_tokens":7}}',
      "",
      `data: ${JSON.stringify({
        id: privateSentinel,
        control: { private: privateSentinel },
        future_top: { private: privateSentinel },
        choices: [{
          delta: {
            content: 17,
            future_payload: privateSentinel
          },
          finish_reason: "stop",
          future_choice: privateSentinel
        }]
      })}`,
      "",
      ""
    ].join("\n"), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    }));
    const preflight = {
      ...fixturePreflight(root),
      models: offlineModels(transport)
    };

    const result = await executeDevelopmentSmokePhase0({ preflight });
    const checkpointBytes = readFileSync(
      checkpointPaths(preflight, result.runId).at(-1)!,
      "utf8"
    );
    const checkpoint = JSON.parse(checkpointBytes) as {
      readonly requests: readonly {
        readonly failureDetail?: {
          readonly acceptedEventShapes?: readonly unknown[];
          readonly firstRejectedEvent?: {
            readonly structure?: Record<string, unknown>;
          };
        };
      }[];
    };
    const failed = checkpoint.requests.filter(
      (request) => request.failureDetail !== undefined
    );

    expect(result.state).toBe("incomplete");
    expect(transport).toHaveBeenCalledTimes(checkpoint.requests.length);
    expect(failed.length).toBeGreaterThan(0);
    for (const request of failed) {
      expect(request.failureDetail).toMatchObject({
        acceptedEventShapes: [
          { category: "metadata", count: 1 },
          { category: "usage", count: 1 }
        ],
        firstRejectedEvent: {
          shape: "delta_field_type",
          structure: {
            choicesLength: "1",
            payloadSource: "delta",
            finishReasonClass: "stop",
            hasControlField: true,
            unknownTopLevelKeys: ["future_top"],
            unknownChoiceKeys: ["future_choice"],
            unknownPayloadKeys: ["future_payload"]
          }
        }
      });
    }
    expect(checkpointBytes).not.toContain(privateSentinel);
  });

  it("keeps the primary HTTP failure when soft-stop masks another case", async () => {
    const root = mkdtempSync(join(tmpdir(), "fermata-smoke-primary-failure-"));
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    let stageACalls = 0;
    const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        readonly response_format?: {
          readonly json_schema?: { readonly name?: string };
        };
      };
      const stage = body.response_format?.json_schema?.name
        ?.match(/_([abcd])_v1$/u)?.[1]?.toUpperCase();
      if (stage === "A" && ++stageACalls === 2) {
        return new Response(null, { status: 400 });
      }
      return new Response(JSON.stringify({
        choices: [{
          message: { role: "assistant", content: "{}" },
          finish_reason: "stop"
        }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    const preflight = {
      ...fixturePreflight(root),
      models: offlineModels(transport)
    };

    const result = await executeDevelopmentSmokePhase0({ preflight });
    const runDirectory = resolve(
      preflight.privateRuntimeRoot,
      `run-${result.runId}`
    );
    const checkpointNames = readdirSync(runDirectory)
      .filter((name) => name.startsWith("checkpoint-"))
      .sort();
    const checkpoint = JSON.parse(readFileSync(
      resolve(runDirectory, checkpointNames.at(-1)!),
      "utf8"
    ));
    const failedRequests = checkpoint.requests.filter(
      (request: { failureKind?: string }) => request.failureKind !== undefined
    );

    expect(result).toMatchObject({ state: "incomplete", requestCount: 4 });
    expect(transport).toHaveBeenCalledTimes(4);
    expect(checkpoint.failureCode).toBe("permanent");
    expect(checkpoint.phase1Released).toBe(false);
    expect(failedRequests).toHaveLength(1);
    expect(failedRequests[0].failureDetail).toMatchObject({
      kind: "permanent",
      code: "LLM_HTTP_ERROR",
      httpStatus: 400,
      requestCount: 1,
      transportAttemptCount: 1,
      completedResponseCount: 0,
      terminalResponseMode: null,
      terminalEofObserved: false,
      terminalFinishReasonStopObserved: false,
      terminalSseDoneObserved: null,
      jsonSchemaValidated: null,
      formatFailureStage: null,
      formatFailureSubstage: null
    });
  });

  it("writes an owner-only immutable hash chain and never persists source text", async () => {
    const root = mkdtempSync(join(tmpdir(), "fermata-smoke-checkpoint-"));
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    const preflight = fixturePreflight(root);
    const first = await executeDevelopmentSmokePhase0({ preflight });
    expect(first.state).toBe("incomplete");
    expect(first.requestCount).toBe(0);

    const runDirectory = resolve(
      preflight.privateRuntimeRoot,
      `run-${first.runId}`
    );
    const firstNames = readdirSync(runDirectory).sort();
    expect(firstNames).toEqual([
      "checkpoint-000001.private.json",
      "checkpoint-000002.private.json",
      "checkpoint-000003.private.json"
    ]);
    let previousHash: string | null = null;
    const originalBytes = new Map<string, Buffer>();
    for (const [index, name] of firstNames.entries()) {
      const path = resolve(runDirectory, name);
      const bytes = readFileSync(path);
      originalBytes.set(name, bytes);
      const checkpoint = JSON.parse(bytes.toString("utf8"));
      expect(statSync(path).mode & 0o077).toBe(0);
      expect(checkpoint.revision).toBe(index + 1);
      expect(checkpoint.previousCheckpointSha256).toBe(previousHash);
      expect(checkpoint.accuracyClaim).toBeNull();
      expect(checkpoint.includedInFinalCalibration).toBe(false);
      expect(checkpoint.phase1Released).toBe(false);
      expect(bytes.toString("utf8")).not.toContain("SENSITIVE_");
      previousHash = sha256(bytes);
    }
    expect(readdirSync(runDirectory)).not.toContain("active.lock.private.json");

    const resumed = await executeDevelopmentSmokePhase0({
      preflight,
      resumeRunId: first.runId
    });
    expect(resumed).toMatchObject({
      runId: first.runId,
      state: "incomplete",
      requestCount: 0
    });
    for (const [name, bytes] of originalBytes) {
      expect(readFileSync(resolve(runDirectory, name))).toEqual(bytes);
    }
    expect(readdirSync(runDirectory).filter((name) =>
      name.startsWith("checkpoint-")
    )).toHaveLength(5);
  });

  it("always creates a unique run directory instead of reusing a label", async () => {
    const root = mkdtempSync(join(tmpdir(), "fermata-smoke-unique-"));
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    const preflight = fixturePreflight(root);
    const [left, right] = await Promise.all([
      executeDevelopmentSmokePhase0({ preflight }),
      executeDevelopmentSmokePhase0({ preflight })
    ]);
    expect(left.runId).not.toBe(right.runId);
    expect(readdirSync(preflight.privateRuntimeRoot).sort()).toEqual([
      `run-${left.runId}`,
      `run-${right.runId}`
    ].sort());
  });
  it("preflights Phase 1 without network calls or checkpoint writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "fermata-smoke-phase1-preflight-"));
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    const completed = await completeSyntheticPhase0(root);
    const pathsBefore = checkpointPaths(completed.preflight, completed.result.runId);
    const hashesBefore = pathsBefore.map((path) => sha256(readFileSync(path)));

    const result = preflightDevelopmentSmokePhase1({
      preflight: completed.preflight,
      resumeRunId: completed.result.runId,
      now: () => new Date(completed.t0.getTime() + 16 * 60_000)
    });

    expect(result).toMatchObject({
      status: "GO-PHASE1",
      mode: "release",
      phase0RequestCount: 8,
      phase1RequestCount: 0,
      logicalRequestsUsed: 8,
      logicalRequestCeiling: 30,
      remainingSlotCount: 4,
      phase1Released: false,
      networkCalls: 0,
      checkpointAppended: false
    });
    expect(completed.transport).toHaveBeenCalledTimes(8);
    expect(checkpointPaths(completed.preflight, completed.result.runId))
      .toEqual(pathsBefore);
    expect(pathsBefore.map((path) => sha256(readFileSync(path))))
      .toEqual(hashesBefore);
  });

  it("atomically releases once, resumes a post-release crash, and never resends Phase 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "fermata-smoke-phase1-resume-"));
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    const completed = await completeSyntheticPhase0(root);
    const t1 = new Date(completed.t0.getTime() + 16 * 60_000);
    let concurrentFailure: unknown;

    await expect(executeDevelopmentSmokePhase1({
      preflight: completed.preflight,
      resumeRunId: completed.result.runId,
      releaseAuthorized: true,
      now: () => t1,
      afterReleaseCheckpoint: () => {
        try {
          preflightDevelopmentSmokePhase1({
            preflight: completed.preflight,
            resumeRunId: completed.result.runId,
            now: () => t1
          });
        } catch (error) {
          concurrentFailure = error;
        }
        throw new Error("SYNTHETIC_POST_RELEASE_CRASH");
      }
    })).rejects.toThrow("SYNTHETIC_POST_RELEASE_CRASH");
    expect(concurrentFailure).toMatchObject({
      message: "DEVELOPMENT_SMOKE_RUN_LOCKED"
    });
    expect(completed.transport).toHaveBeenCalledTimes(8);

    const releasedPaths = checkpointPaths(
      completed.preflight,
      completed.result.runId
    );
    const releaseCheckpoint = JSON.parse(readFileSync(
      releasedPaths.at(-1)!,
      "utf8"
    ));
    expect(statSync(releasedPaths.at(-1)!).mode & 0o777).toBe(0o600);
    expect(releaseCheckpoint).toMatchObject({
      phase: "phase1",
      state: "running",
      phase1Released: true,
      phase1Release: {
        t1: t1.toISOString(),
        phase0LogicalRequestsUsed: 8,
        phase0ExternalAttemptsUsed: 8,
        logicalRequestCeiling: 30,
        externalAttemptCeiling: 30,
        checkpointAfterMs: 15 * 60_000,
        reestimateAfterMs: 60 * 60_000,
        closeNewStagesAfterMs: 180 * 60_000
      }
    });
    expect(releaseCheckpoint.phase1Release.remainingSlots.map(
      (entry: { slot: string }) => entry.slot
    )).toEqual(["slot-03", "slot-04", "slot-05", "slot-06"]);

    const resumePreflight = preflightDevelopmentSmokePhase1({
      preflight: completed.preflight,
      resumeRunId: completed.result.runId,
      now: () => new Date(t1.getTime() + 60_000)
    });
    expect(resumePreflight).toMatchObject({
      status: "GO-PHASE1",
      mode: "resume",
      logicalRequestsUsed: 8,
      remainingSlotCount: 4,
      networkCalls: 0,
      checkpointAppended: false
    });
    expect(checkpointPaths(completed.preflight, completed.result.runId))
      .toHaveLength(releasedPaths.length);

    const result = await executeDevelopmentSmokePhase1({
      preflight: completed.preflight,
      resumeRunId: completed.result.runId,
      releaseAuthorized: true,
      now: () => new Date(t1.getTime() + 60_000)
    });
    expect(result).toMatchObject({
      state: "complete",
      phase0RequestCount: 8,
      phase1RequestCount: 16,
      requestCount: 24
    });
    expect(completed.transport).toHaveBeenCalledTimes(24);
    const finalCheckpoint = JSON.parse(readFileSync(
      checkpointPaths(completed.preflight, completed.result.runId).at(-1)!,
      "utf8"
    ));
    expect(finalCheckpoint.phase1Release).toEqual(releaseCheckpoint.phase1Release);
    expect(finalCheckpoint.requests.slice(0, 8).every(
      (request: { receipt: { phase: string } }) => request.receipt.phase === "phase0"
    )).toBe(true);
    expect(finalCheckpoint.requests.slice(8).every(
      (request: { receipt: { phase: string } }) => request.receipt.phase === "phase1"
    )).toBe(true);
    expect(finalCheckpoint.requests.map(
      (request: { receipt: { logicalRequestsUsed: number } }) =>
        request.receipt.logicalRequestsUsed
    )).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
    expect(finalCheckpoint.metrics).toMatchObject({
      phase0: { requestCount: 8, completedRequestCount: 8 },
      phase1: { requestCount: 16, completedRequestCount: 16 },
      run: { requestCount: 24, completedRequestCount: 24 },
      remainingLogicalRequestBudget: 6
    });
    expect(finalCheckpoint.accuracyClaim).toBeNull();
    expect(finalCheckpoint.includedInFinalCalibration).toBe(false);
  });

  it.each([
    ["wrong code", (preflight: DevelopmentSmokePreflight) => ({
      ...preflight,
      codeVersion: "c".repeat(40)
    })],
    ["wrong manifest file", (preflight: DevelopmentSmokePreflight) => ({
      ...preflight,
      manifestFileSha256: digest("d")
    })],
    ["wrong manifest fingerprint", (preflight: DevelopmentSmokePreflight) => ({
      ...preflight,
      safeSummary: {
        ...preflight.safeSummary,
        manifestFingerprint: digest("e")
      }
    })],
    ["missing remaining slot", (preflight: DevelopmentSmokePreflight) => ({
      ...preflight,
      cases: preflight.cases.slice(0, 5)
    })],
    ["extra remaining slot", (preflight: DevelopmentSmokePreflight) => ({
      ...preflight,
      cases: [...preflight.cases, preflight.cases[5]!]
    })]
  ])("rejects Phase 1 preflight with %s", async (_name, alter) => {
    const root = mkdtempSync(join(tmpdir(), "fermata-smoke-phase1-binding-"));
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    const completed = await completeSyntheticPhase0(root);
    expect(() => preflightDevelopmentSmokePhase1({
      preflight: alter(completed.preflight),
      resumeRunId: completed.result.runId,
      now: () => new Date(completed.t0.getTime() + 16 * 60_000)
    })).toThrow();
    expect(completed.transport).toHaveBeenCalledTimes(8);
  });

  it.each([
    ["invalid state", (checkpoint: Record<string, unknown>) => {
      checkpoint.state = "running";
    }],
    ["failure", (checkpoint: Record<string, unknown>) => {
      checkpoint.failureCode = "final_failure";
      checkpoint.stopReason = "final_failure";
    }],
    ["inflight request", (checkpoint: Record<string, unknown>) => {
      const request = (checkpoint.requests as Array<Record<string, unknown>>)[0]!;
      delete request.completedStage;
      delete request.timing;
    }],
    ["attempt mismatch", (checkpoint: Record<string, unknown>) => {
      const request = (checkpoint.requests as Array<{
        receipt: Record<string, unknown>;
      }>)[7]!;
      request.receipt.logicalRequestsUsed = 7;
    }],
    ["attempt overflow", (checkpoint: Record<string, unknown>) => {
      const request = (checkpoint.requests as Array<{
        receipt: Record<string, unknown>;
      }>)[7]!;
      request.receipt.logicalRequestsUsed = 30;
      request.receipt.externalAttemptsUsed = 30;
    }],
    ["extra Phase 0 request", (checkpoint: Record<string, unknown>) => {
      const requests = checkpoint.requests as Array<Record<string, unknown>>;
      const duplicate = structuredClone(requests[0]!);
      const receipt = duplicate.receipt as Record<string, unknown>;
      receipt.logicalRequestsUsed = 9;
      receipt.externalAttemptsUsed = 9;
      requests.push(duplicate);
    }],
    ["wrong profile", (checkpoint: Record<string, unknown>) => {
      checkpoint.profileFingerprint = digest("f");
    }]
  ])("rejects Phase 1 preflight for %s", async (_name, mutate) => {
    const root = mkdtempSync(join(tmpdir(), "fermata-smoke-phase1-state-"));
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    const completed = await completeSyntheticPhase0(root);
    const path = checkpointPaths(
      completed.preflight,
      completed.result.runId
    ).at(-1)!;
    const checkpoint = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    mutate(checkpoint);
    writeFileSync(path, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });

    expect(() => preflightDevelopmentSmokePhase1({
      preflight: completed.preflight,
      resumeRunId: completed.result.runId,
      now: () => new Date(completed.t0.getTime() + 16 * 60_000)
    })).toThrow();
    expect(completed.transport).toHaveBeenCalledTimes(8);
  });
});
