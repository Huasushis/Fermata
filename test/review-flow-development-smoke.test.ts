import { describe, expect, it, vi } from "vitest";
import {
  chatComplete,
  type LlmRuntimeOptions,
  type ModelCallSpec
} from "../src/llm";
import {
  FairLlmRequestScheduler,
  LlmStageRequestError,
  type LlmStageFailureKind
} from "../src/llm-scheduler";
import {
  DevelopmentSmokeRunController,
  createDevelopmentSmokeScheduler,
  developmentSmokeAggregateBudgetReceipt,
  developmentSmokePhaseSlots,
  developmentSmokeProfile,
  developmentSmokeProfileFingerprint,
  parseDevelopmentSmokeManifest,
  parseDevelopmentSmokeProfile,
  runDevelopmentSmokePhase,
  summarizeDevelopmentSmokeManifest,
  type DevelopmentSmokeAnonymousSlot,
  type DevelopmentSmokeManifest,
  type DevelopmentSmokeSafeRequestReceipt
} from "../src/review-flow/development-smoke";
import {
  reviewFlowStageJsonSchemas,
  reviewFlowStageOutputBudgets,
  type FourCallRequest,
  type ReviewFlowDagStage
} from "../src/review-flow/four-call";
import type { FourCallSafeRequestFailure } from "../src/review-flow/four-call-runtime";
import { hashCanonicalValue } from "../src/review-flow/evidence";

const digest = (character: string): string => character.repeat(64);

function safeFailure(
  kind: LlmStageFailureKind
): FourCallSafeRequestFailure {
  return {
    kind,
    code: "unknown",
    httpStatus: null,
    requestCount: 0,
    transportAttemptCount: 0,
    completedResponseCount: 0,
    terminalResponseMode: null,
    terminalEofObserved: false,
    terminalFinishReasonStopObserved: false,
    terminalSseDoneObserved: null,
    jsonSchemaValidated: null,
    streamEventCount: 0,
    streamUtf8Bytes: 0,
    streamChunkCount: 0,
    usageEventCount: 0,
    usageTotalTokens: null,
    firstRejectedEvent: null,
    formatFailureStage: null,
    formatFailureSubstage: null
  };
}
const runBindingHash = digest("f");
const stages = ["A", "B", "C", "D", "formatter"] as const;
const expectedModels: Readonly<Record<ReviewFlowDagStage, string>> = {
  A: "deepseek-v4-pro",
  B: "deepseek-v4-flash",
  C: "deepseek-v4-pro",
  D: "deepseek-v4-pro",
  formatter: "deepseek-v4-flash"
};

function manifest(): DevelopmentSmokeManifest {
  return parseDevelopmentSmokeManifest({
    schemaVersion: 1,
    profileName: developmentSmokeProfile.name,
    slots: [
      slot("slot-01", "low", "pass", ["schema_invalid"], "1"),
      slot("slot-02", "middle", "reject", [], "2"),
      slot("slot-03", "high", "pass", [], "3"),
      slot("slot-04", "middle", "reject", ["output_limit"], "4"),
      slot("slot-05", "high", "pass", [], "5"),
      slot("slot-06", "high", "reject", [], "6")
    ]
  });
}

function slot(
  anonymousSlot: DevelopmentSmokeAnonymousSlot,
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

function request(
  anonymousSlot: DevelopmentSmokeAnonymousSlot,
  stage: ReviewFlowDagStage,
  overrides: Partial<FourCallRequest> = {}
): FourCallRequest {
  const schema = reviewFlowStageJsonSchemas[stage];
  const model = {
    provider: "aether",
    model: expectedModels[stage],
    thinkingRequest: "enabled" as const,
    reasoningEffort: "max" as const,
    fingerprint: digest(stage === "B" || stage === "formatter" ? "b" : "a")
  };
  return {
    caseId: anonymousSlot,
    stage,
    input: "not logged",
    model,
    messages: [{ role: "user", content: "not logged" }],
    maxOutputTokens: reviewFlowStageOutputBudgets[stage],
    thinkingRequest: "enabled",
    reasoningEffort: "max",
    schema,
    schemaFingerprint: hashCanonicalValue(schema),
    attempt: 1,
    ...overrides
  };
}

function controller(
  sink: (receipt: DevelopmentSmokeSafeRequestReceipt) => void = () => undefined,
  nowMs = developmentSmokeProfile.phase0CheckpointMs
): DevelopmentSmokeRunController {
  return new DevelopmentSmokeRunController({
    profile: developmentSmokeProfile,
    manifest: manifest(),
    runBindingHash,
    scheduler: createDevelopmentSmokeScheduler(),
    safeReceiptSink: sink,
    startedAtMs: 0,
    clock: () => nowMs
  });
}

function completeSlot(
  run: DevelopmentSmokeRunController,
  anonymousSlot: DevelopmentSmokeAnonymousSlot,
  includeFormatter: boolean,
  endToEndMs = 2_000
): void {
  for (const stage of includeFormatter ? stages : stages.slice(0, 4)) {
    const stageRequest = request(anonymousSlot, stage);
    run.authorizeRequest(stageRequest);
    run.recordRequestCompleted(stageRequest, {
      firstValidOutputMs: Math.min(1_000, endToEndMs),
      endToEndMs,
      validOutputEventCount: 2,
      outputUtf8Bytes: 100
    });
  }
  run.markSlotComplete(anonymousSlot);
}

function releasePhase1(
  run: DevelopmentSmokeRunController
) {
  return run.releasePhase1();
}

const provider = { baseUrl: "https://provider.invalid/v1", apiKey: "test-only" };
const spec: ModelCallSpec = {
  provider: "aether",
  model: "deepseek-v4-pro",
  temperature: 0,
  thinking: false,
  thinkingRequest: "enabled",
  reasoningEffort: "max"
};
const smokeRuntime = (fetch: LlmRuntimeOptions["fetch"]): LlmRuntimeOptions => ({
  outputIdleTimeoutMs: developmentSmokeProfile.outputIdleTimeoutMs,
  firstOutputTimeoutMs: developmentSmokeProfile.firstValidOutputTimeoutMs,
  maximumDurationMs: developmentSmokeProfile.preFirstOutputFallbackMs,
  maxAttempts: 1,
  baseDelayMs: 500,
  fetch
});

function streamResponse(
  start: (controller: ReadableStreamDefaultController<Uint8Array>) => void
): Response {
  return new Response(new ReadableStream<Uint8Array>({ start }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

const encoder = new TextEncoder();
const outputEvent = (text: string, stop = false): Uint8Array =>
  encoder.encode(
    `data: ${JSON.stringify({
      choices: [{ delta: { content: text }, ...(stop ? { finish_reason: "stop" } : {}) }]
    })}\n\n${stop ? "data: [DONE]\n\n" : ""}`
  );

describe("development smoke profile", () => {
  it("fails closed when a required profile field is missing or enlarged", () => {
    const missing = { ...developmentSmokeProfile } as Record<string, unknown>;
    delete missing.maximumTotalExternalAttempts;
    expect(() => parseDevelopmentSmokeProfile(missing)).toThrow(
      "DEVELOPMENT_SMOKE_PROFILE_INVALID"
    );
    expect(() => parseDevelopmentSmokeProfile({
      ...developmentSmokeProfile,
      maximumTotalExternalAttempts: 31
    })).toThrow("DEVELOPMENT_SMOKE_PROFILE_INVALID");
    expect(() => new DevelopmentSmokeRunController({
      profile: developmentSmokeProfile,
      manifest: manifest(),
      runBindingHash,
      scheduler: new FairLlmRequestScheduler({
        maximumConcurrency: 12,
        maximumAttemptsPerLogicalRequest: 2,
        maximumAttemptsPerCase: 5
      }),
      startedAtMs: 0,
      clock: () => developmentSmokeProfile.phase0CheckpointMs
    })).toThrow("DEVELOPMENT_SMOKE_SCHEDULER_INVALID");
  });

  it("reports only anonymous coverage, dual-axis truth, and binding fingerprints", () => {
    const summary = summarizeDevelopmentSmokeManifest(manifest());
    expect(summary).toMatchObject({
      slotCount: 6,
      difficultyCounts: { low: 1, middle: 2, high: 3 },
      verdictCounts: { pass: 3, reject: 3 },
      priorFailureCounts: { output_limit: 1, schema_invalid: 1 },
      slotsWithBothTruthAxes: 6
    });
    expect(JSON.stringify(summary)).not.toContain("problem");
    expect(() => parseDevelopmentSmokeManifest({
      ...manifest(),
      slots: manifest().slots.map((entry, index) =>
        index === 0 ? { ...entry, verdictTruth: undefined } : entry
      )
    })).toThrow("DEVELOPMENT_SMOKE_MANIFEST_INVALID");
    expect(developmentSmokeProfile).toMatchObject({
      allowYuantiji: false,
      allowCodeforces: false,
      allowWeb: false,
      allowedExternalService: "configured_aether_deepseek"
    });
    const run = controller();
    run.assertSlotBindings("slot-01", digest("1"), digest("1".toUpperCase()));
    expect(() => run.assertSlotBindings(
      "slot-01",
      digest("2"),
      digest("1".toUpperCase())
    )).toThrow("DEVELOPMENT_SMOKE_SLOT_BINDING_INVALID");
  });

  it("requires the exact two-slot then four-slot batches before model access", async () => {
    await expect(runDevelopmentSmokePhase({
      phase: "phase0",
      controller: controller(),
      models: {} as never,
      nativeSchemaCompatible: true,
      cases: []
    })).rejects.toThrow("DEVELOPMENT_SMOKE_PHASE_BATCH_INVALID");
  });
  it("emits exact per-request token/model/schema receipts and no request content", () => {
    const receipts: DevelopmentSmokeSafeRequestReceipt[] = [];
    const run = controller((receipt) => receipts.push(receipt));
    for (const stage of stages) run.authorizeRequest(request("slot-01", stage));
    expect(receipts.map((receipt) => receipt.maxOutputTokens))
      .toEqual([32_000, 8_000, 24_000, 12_000, 8_000]);
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({
        provider: "aether",
        thinkingRequest: "enabled",
        reasoningEffort: "max",
        logicalAttempt: 1,
        logicalRequestCeiling: 30,
        externalAttemptCeiling: 30
      });
      expect(JSON.stringify(receipt)).not.toContain("not logged");
    }
    expect(() => controller().authorizeRequest(request("slot-01", "A", {
      maxOutputTokens: 32_001
    }))).toThrow("DEVELOPMENT_SMOKE_REQUEST_RECEIPT_INVALID");
    expect(() => controller().authorizeRequest(request("slot-01", "A", {
      model: { ...request("slot-01", "A").model, reasoningEffort: "low" as never }
    }))).toThrow("DEVELOPMENT_SMOKE_REQUEST_RECEIPT_INVALID");
    expect(developmentSmokeAggregateBudgetReceipt).toMatchObject({
      semanticLogicalRequestCeiling: 24,
      formatterLogicalRequestCeiling: 6,
      totalLogicalRequestCeiling: 30,
      semanticOutputTokenCeiling: 456_000,
      formatterOutputTokenCeiling: 48_000,
      totalOutputTokenCeiling: 504_000
    });
  });

  it("restores sealed requests without resetting budget or authorizing them twice", () => {
    const receipts: DevelopmentSmokeSafeRequestReceipt[] = [];
    const first = controller((receipt) => receipts.push(receipt));
    const stageA = request("slot-01", "A");
    first.authorizeRequest(stageA);
    const timing = {
      firstValidOutputMs: 1_000,
      endToEndMs: 2_000,
      validOutputEventCount: 2,
      outputUtf8Bytes: 100
    };
    first.recordRequestCompleted(stageA, timing);
    const restored = controller();
    restored.restoreCompletedRequest(receipts[0]!, timing);
    expect(restored.checkpoint()).toMatchObject({
      logicalRequestsUsed: 1,
      externalAttemptsUsed: 1
    });
    expect(() => restored.authorizeRequest(stageA)).toThrow(
      "DEVELOPMENT_SMOKE_WHOLE_CASE_RETRY_FORBIDDEN"
    );
    expect(() => restored.restoreCompletedRequest({
      ...receipts[0]!,
      profileFingerprint: developmentSmokeProfileFingerprint,
      logicalRequestsUsed: 2
    }, timing)).toThrow("DEVELOPMENT_SMOKE_RESTORED_REQUEST_INVALID");
  });

  it("shares one 30-attempt ceiling across phase0 and one-shot phase1", () => {
    const run = controller();
    expect(developmentSmokePhaseSlots("phase0")).toEqual(["slot-01", "slot-02"]);
    expect(developmentSmokePhaseSlots("phase1")).toEqual([
      "slot-03",
      "slot-04",
      "slot-05",
      "slot-06"
    ]);
    completeSlot(run, "slot-01", true);
    completeSlot(run, "slot-02", true);
    expect(run.checkpoint()).toMatchObject({
      phase: "phase0",
      logicalRequestsUsed: 10,
      externalAttemptsUsed: 10,
      status: "INCOMPLETE"
    });
    const forecast = releasePhase1(run);
    expect(forecast).toMatchObject({
      basis: "phase0_measured_per_logical_request",
      legacy31MinuteObservationUnit: "UNKNOWN",
      durationEstimator: "nearest_rank_empirical_p90",
      measuredLogicalRequestCount: 10,
      observedLogicalRequestP90Ms: 2_000,
      observedFirstValidOutputP90Ms: 1_000,
      observedValidOutputEventsPerMinuteFloor: 120,
      remainingCriticalWaveCount: 4,
      projectedAllSixP90Ms: developmentSmokeProfile.phase0CheckpointMs + 8_000
    });
    for (const anonymousSlot of developmentSmokePhaseSlots("phase1")) {
      completeSlot(run, anonymousSlot, true);
    }
    expect(run.checkpoint()).toMatchObject({
      phase: "phase1",
      logicalRequestsUsed: 30,
      externalAttemptsUsed: 30,
      completedSlotCount: 6,
      status: "PIPELINE_SMOKE",
      accuracyClaim: null,
      includedInFinalCalibration: false
    });
    expect(() => run.authorizeRequest(request("slot-06", "formatter"))).toThrow(
      "DEVELOPMENT_SMOKE_WHOLE_CASE_RETRY_FORBIDDEN"
    );
  });

  it("never authorizes all six from the unproven legacy 31-minute observation", () => {
    const run = controller();
    completeSlot(run, "slot-01", false, 60 * 60_000);
    completeSlot(run, "slot-02", false, 60 * 60_000);
    expect(developmentSmokeProfile.legacy31MinuteObservationUnit).toBe("UNKNOWN");
    expect(() => run.releasePhase1()).toThrow(
      "DEVELOPMENT_SMOKE_P90_OVER_THREE_HOURS"
    );
    expect(run.checkpoint()).toMatchObject({
      stopped: true,
      stopReason: "p90_over_three_hours",
      status: "INCOMPLETE"
    });
  });

  it("uses zero retries for every failure class", async () => {
    const kinds: LlmStageFailureKind[] = [
      "rate_limited",
      "server_error",
      "connect",
      "first_byte_timeout",
      "no_progress_timeout",
      "stream_interrupted",
      "output_limit",
      "schema_invalid",
      "permanent"
    ];
    for (const kind of kinds) {
      const scheduler = createDevelopmentSmokeScheduler();
      let attempts = 0;
      await expect(scheduler.runLogicalRequest({
        caseId: `case-${kind.replaceAll("_", "-")}`,
        requestId: "A",
        execute: async () => {
          attempts += 1;
          throw new LlmStageRequestError(kind);
        }
      })).rejects.toMatchObject({ kind });
      expect(attempts).toBe(1);
    }
  });

  it("soft stop rejects new work without aborting an inflight request", async () => {
    const scheduler = createDevelopmentSmokeScheduler();
    const waiter = Promise.withResolvers<string>();
    const inflight = scheduler.runLogicalRequest({
      caseId: "case-active",
      requestId: "A",
      execute: () => waiter.promise
    });
    await vi.waitFor(() => expect(scheduler.snapshot().active).toBe(1));
    scheduler.softStop();
    waiter.resolve("eof");
    await expect(inflight).resolves.toMatchObject({ value: "eof", attemptCount: 1 });
    await expect(scheduler.runLogicalRequest({
      caseId: "case-new",
      requestId: "A",
      execute: async () => "never"
    })).rejects.toThrow("LLM_SCHEDULER_SOFT_STOPPED");
  });

  it("stops on output/schema, repeated system errors, and the three-hour gate", () => {
    const outputRun = controller();
    outputRun.recordFailure("output_limit");
    expect(outputRun.checkpoint().stopReason).toBe("output_limit");
    const schemaRun = controller();
    schemaRun.recordFailure("schema_invalid");
    expect(schemaRun.checkpoint().stopReason).toBe("schema_invalid");
    const repeatedRun = controller();
    repeatedRun.recordFailure("server_error");
    expect(repeatedRun.checkpoint().stopped).toBe(false);
    repeatedRun.recordFailure("connect");
    expect(repeatedRun.checkpoint().stopReason).toBe("repeated_system_error");
    const resetRun = controller();
    resetRun.recordFailure("server_error");
    const successfulRequest = request("slot-01", "A");
    resetRun.authorizeRequest(successfulRequest);
    resetRun.recordRequestCompleted(successfulRequest, {
      firstValidOutputMs: 1,
      endToEndMs: 2,
      validOutputEventCount: 1,
      outputUtf8Bytes: 1
    });
    resetRun.recordFailure("connect");
    expect(resetRun.checkpoint().stopped).toBe(false);
    const elapsedRun = controller(
      () => undefined,
      developmentSmokeProfile.closeNewStagesAfterMs
    );
    expect(() => elapsedRun.authorizeRequest(request("slot-01", "A"))).toThrow(
      "DEVELOPMENT_SMOKE_NEW_REQUESTS_CLOSED"
    );
    expect(elapsedRun.checkpoint().stopReason).toBe("three_hour_gate");
    const firstSystemRun = controller();
    firstSystemRun.lifecycle().requestFailed(
      request("slot-01", "A"),
      safeFailure("connect")
    );
    expect(firstSystemRun.checkpoint().stopped).toBe(false);
    const finalRun = controller();
    finalRun.lifecycle().requestFailed(
      request("slot-01", "A"),
      safeFailure("permanent")
    );
    expect(finalRun.checkpoint().stopReason).toBe("final_failure");
  });
  it("anchors the three-hour soft gate to a Phase 1 T1 clock", () => {
    const phase1 = new DevelopmentSmokeRunController({
      profile: developmentSmokeProfile,
      manifest: manifest(),
      runBindingHash,
      scheduler: createDevelopmentSmokeScheduler(),
      initialPhase: "phase1",
      startedAtMs: 1_000,
      clock: () => 1_000 + developmentSmokeProfile.closeNewStagesAfterMs
    });
    expect(() => phase1.authorizeRequest(request("slot-03", "A"))).toThrow(
      "DEVELOPMENT_SMOKE_NEW_REQUESTS_CLOSED"
    );
    expect(phase1.checkpoint()).toMatchObject({
      phase: "phase1",
      stopped: true,
      stopReason: "three_hour_gate"
    });
  });

});

describe("development smoke transport timing", () => {
  it("lets a healthy stream exceed 30 minutes while progress continues until EOF", async () => {
    vi.useFakeTimers();
    try {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const fetchMock = vi.fn(async () => streamResponse((value) => {
        streamController = value;
      }));
      const task = chatComplete(provider, spec, [], smokeRuntime(fetchMock));
      await vi.advanceTimersByTimeAsync(0);
      let elapsedMinutes = 0;
      for (const minute of [1, 9, 17, 25, 31]) {
        await vi.advanceTimersByTimeAsync((minute - elapsedMinutes) * 60_000);
        elapsedMinutes = minute;
        streamController.enqueue(outputEvent(".", minute === 31));
      }
      streamController.close();
      await expect(task).resolves.toEqual({ content: ".....", reasoning: null });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces first-valid-output and no-progress timeouts without retry", async () => {
    vi.useFakeTimers();
    try {
      const firstFetch = vi.fn(async () => streamResponse(() => undefined));
      const firstTask = chatComplete(provider, spec, [], smokeRuntime(firstFetch));
      const firstRejection = expect(firstTask).rejects.toMatchObject({
        code: "LLM_FIRST_OUTPUT_TIMEOUT"
      });
      await vi.advanceTimersByTimeAsync(600_001);
      await firstRejection;
      expect(firstFetch).toHaveBeenCalledTimes(1);

      let idleController!: ReadableStreamDefaultController<Uint8Array>;
      const idleFetch = vi.fn(async () => streamResponse((value) => {
        idleController = value;
      }));
      const idleTask = chatComplete(provider, spec, [], smokeRuntime(idleFetch));
      await vi.advanceTimersByTimeAsync(0);
      idleController.enqueue(outputEvent("started"));
      const idleRejection = expect(idleTask).rejects.toMatchObject({
        code: "LLM_OUTPUT_IDLE_TIMEOUT"
      });
      await vi.advanceTimersByTimeAsync(600_001);
      await idleRejection;
      expect(idleFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
