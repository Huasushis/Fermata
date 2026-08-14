import { describe, expect, it, vi, type Mock } from "vitest";
import {
  parseReviewFlowUnifiedResult,
  reviewFlowStageOutputBudgets,
  reviewFlowUnifiedJsonSchema,
  reviewFlowUnifiedSchemaFingerprint,
  runFourCallReviewDag,
  type ReviewFlowSemanticStage
} from "../src/review-flow/four-call";
import {
  FairLlmRequestScheduler,
  LlmStageRequestError
} from "../src/llm-scheduler";
import { LlmRequestError, LlmResponseFormatError } from "../src/llm";
import {
  runProductionFourCallReviewDag,
  type FourCallRequestLifecycle,
  type FourCallSafeRequestFailure
} from "../src/review-flow/four-call-runtime";
import type { PipelineModelConfig } from "../src/pipelines/types";
import { classifyTransportFailure } from "../src/review-flow/four-call-runtime";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);

function unifiedOutput() {
  return {
    schemaVersion: 1 as const,
    a: {
      solvable: true,
      blindSolution: "solution",
      positiveSignals: ["constructive path"],
      negativeSignals: ["boundary risk"]
    },
    b: {
      codeforcesDifficulty: 1800,
      thinkingLevel: 4,
      codingLevel: 3,
      rationale: "frozen anchors"
    },
    c: {
      solutionAnalysis: "consistent",
      technicalQuality: "sound",
      editorialQuality: "strong",
      contestFit: "acceptable" as const,
      originalityLevel: 4,
      tagIds: ["dp"],
      positiveSignals: ["clear invariant"],
      negativeSignals: ["proof wording"],
      hardBlockers: []
    },
    d: {
      verdict: "approve" as const,
      qualityLevel: 4,
      acceptedSignals: ["clear invariant"],
      rejectedSignals: ["boundary risk"],
      hardBlockers: [],
      improvements: "clarify proof",
      publicComment: "可通过。",
      privateNote: "独立裁决。"
    }
  };
}

function model() {
  return {
    provider: "aether",
    model: "deepseek-v4-pro",
    thinkingRequest: "enabled" as const,
    reasoningEffort: "max" as const,
    fingerprint: digestA
  };
}

function stageOutput(stage: "A" | "B" | "C" | "D" | "formatter"): string {
  const output = unifiedOutput();
  if (stage === "formatter") return JSON.stringify(output);
  const property = { A: "a", B: "b", C: "c", D: "d" }[stage] as "a" | "b" | "c" | "d";
  return JSON.stringify(output[property]);
}

/**
 * 识别合成请求体中的四阶段：B/C/D 通过 response_format 名称；两轮 A 阶段
 * 两轮都不带 response_format，靠 max_tokens=32000 与末条用户消息是否含
 * "目标 JSON Schema"区分语义轮与格式轮。
 */
function syntheticFourCallStage(body: {
  readonly max_tokens?: number;
  readonly response_format?: {
    readonly json_schema?: { readonly name?: string };
  };
  readonly messages?: readonly { readonly content?: unknown }[];
}): "A" | "A_FORMAT" | "B" | "C" | "D" | undefined {
  const responseFormat = body.response_format as
    | { readonly json_schema?: { readonly name?: string } }
    | undefined;
  const stage = responseFormat?.json_schema?.name
    ?.match(/_([abcd])_v1$/u)?.[1]?.toUpperCase();
  if (stage === "A" || stage === "B" || stage === "C" || stage === "D") {
    return stage;
  }
  if (body.max_tokens === 384_000) {
    // 语义轮不含"目标 JSON Schema"指令；格式轮与修复轮都包含该指令
    // （修复轮在格式消息后会追加 assistant/修复提示）。
    const containsSchemaInstruction = (body.messages ?? []).some(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("目标 JSON Schema")
    );
    return containsSchemaInstruction ? "A_FORMAT" : "A";
  }
  return undefined;
}

function syntheticJsonCompletion(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{
      message: { role: "assistant", content },
      finish_reason: "stop"
    }]
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function syntheticJsonCompletionFinish(content: string, finishReason: string): Response {
  return new Response(JSON.stringify({
    choices: [{
      message: { role: "assistant", content },
      finish_reason: finishReason
    }]
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function fourCallSource() {
  return {
    statement: "statement",
    referenceSolution: "solution",
    technicalContext: null,
    historicalTasteRubric: null,
    difficultyAnchors: [],
    labelCatalog: ["dp"],
    hardRules: []
  };
}

function twoRoundRuntimeModel(
  fetchImpl: NonNullable<PipelineModelConfig["runtime"]["fetch"]>
): PipelineModelConfig {
  return {
    credentials: { baseUrl: "https://provider.example/v1", apiKey: "synthetic-key" },
    spec: {
      provider: "aether",
      model: "deepseek-v4-pro",
      temperature: 0,
      thinking: false,
      thinkingRequest: "enabled",
      reasoningEffort: "max"
    },
    runtime: {
      outputIdleTimeoutMs: 600_000,
      firstOutputTimeoutMs: 600_000,
      maximumDurationMs: 1_800_000,
      maxAttempts: 3,
      baseDelayMs: 500,
      fetch: fetchImpl
    }
  };
}

function twoRoundDagArgs(fetchImpl: NonNullable<PipelineModelConfig["runtime"]["fetch"]>, lifecycle?: FourCallRequestLifecycle) {
  const runtimeModel = twoRoundRuntimeModel(fetchImpl);
  return {
    caseId: "production-two-round",
    sourceBinding: digestB,
    source: fourCallSource(),
    models: {
      A: runtimeModel,
      B: runtimeModel,
      C: runtimeModel,
      D: runtimeModel,
      formatter: runtimeModel
    },
    nativeSchemaCompatible: true,
    scheduler: new FairLlmRequestScheduler({ maximumConcurrency: 12, jitter: () => 0 }),
    ...(lifecycle === undefined ? {} : { lifecycle })
  };
}

describe("四语义请求 DAG 冻结接口", () => {
  it("A 与 B 并行，C 只依赖 A，D 等待 B+C；语义关键路径为 3", async () => {
    const scheduler = new FairLlmRequestScheduler({ maximumConcurrency: 2, jitter: () => 0 });
    const entered = new Map<ReviewFlowSemanticStage, Mock<() => void>>();
    const release = new Map<ReviewFlowSemanticStage, () => void>();
    const completed: ReviewFlowSemanticStage[] = [];
    for (const stage of ["A", "B", "C", "D"] as const) {
      entered.set(stage, vi.fn());
    }
    const pending = runFourCallReviewDag({
      caseId: "case-1",
      sourceBinding: digestB,
      model: model(),
      nativeSchemaCompatible: true,
      scheduler,
      call: async (request) => {
        const semanticStage = request.stage;
        if (semanticStage === "formatter") {
          return { output: JSON.stringify(unifiedOutput()), eofVerified: true };
        }
        entered.get(semanticStage)?.();
        const waiter = Promise.withResolvers<void>();
        release.set(semanticStage, waiter.resolve);
        await waiter.promise;
        completed.push(semanticStage);
        return {
          output: stageOutput(semanticStage),
          eofVerified: true
        };
      }
    });

    await vi.waitFor(() => {
      expect(entered.get("A")).toHaveBeenCalledTimes(1);
      expect(entered.get("B")).toHaveBeenCalledTimes(1);
    });
    expect(entered.get("C")).not.toHaveBeenCalled();
    release.get("A")!();
    await vi.waitFor(() => expect(entered.get("C")).toHaveBeenCalledTimes(1));
    expect(entered.get("D")).not.toHaveBeenCalled();
    release.get("C")!();
    await Promise.resolve();
    expect(entered.get("D")).not.toHaveBeenCalled();
    release.get("B")!();
    await vi.waitFor(() => expect(entered.get("D")).toHaveBeenCalledTimes(1));
    release.get("D")!();

    const result = await pending;
    expect(completed).toEqual(["A", "C", "B", "D"]);
    expect(result.semanticRequestCount).toBe(4);
    expect(result.formatterRequestCount).toBe(0);
    expect(result.criticalPathSemanticRequests).toBe(3);
    expect(result.output.d.verdict).toBe("approve");
  });

  it("enforces blind and independent stage views without exposing either scoring truth", async () => {
    const scheduler = new FairLlmRequestScheduler({ maximumConcurrency: 12, jitter: () => 0 });
    const inputs = new Map<string, Record<string, unknown>>();
    await runFourCallReviewDag({
      caseId: "case-views",
      sourceBinding: digestB,
      source: {
        statement: "statement-only",
        referenceSolution: "solution-only",
        technicalContext: "technical-only",
        historicalTasteRubric: "taste-only",
        difficultyAnchors: "anchors-only",
        labelCatalog: "labels-only",
        hardRules: "rules-only"
      },
      model: model(),
      nativeSchemaCompatible: true,
      scheduler,
      call: async (request) => {
        inputs.set(request.stage, JSON.parse(request.input) as Record<string, unknown>);
        return { output: stageOutput(request.stage), eofVerified: true };
      }
    });
    expect(Object.keys(inputs.get("A")!).sort()).toEqual(["sourceBinding", "statement"]);
    expect(Object.keys(inputs.get("B")!).sort()).toEqual([
      "difficultyAnchors", "sourceBinding", "statement"
    ]);
    expect(Object.keys(inputs.get("C")!).sort()).toEqual([
      "a",
      "historicalTasteRubric",
      "labelCatalog",
      "referenceSolution",
      "sourceBinding",
      "statement",
      "technicalContext"
    ]);
    expect(Object.keys(inputs.get("D")!).sort()).toEqual(["b", "c", "hardRules", "sourceBinding"]);
    expect([...inputs.values()].some((value) => Object.hasOwn(value, "humanVerdict"))).toBe(false);
    expect([...inputs.values()].some((value) => Object.hasOwn(value, "frozenCodeforcesDifficulty"))).toBe(false);
  });

  it("native max 与 forced schema 冲突时仅在全题末尾调用一次统一 formatter", async () => {
    const scheduler = new FairLlmRequestScheduler({ maximumConcurrency: 12, jitter: () => 0 });
    const calls: Array<{
      stage: string;
      schema: string | null;
      input: string;
      messages: readonly { readonly content: string }[];
    }> = [];
    const result = await runFourCallReviewDag({
      caseId: "case-2",
      sourceBinding: digestB,
      model: model(),
      nativeSchemaCompatible: false,
      scheduler,
      call: async (request) => {
        calls.push({
          stage: request.stage,
          schema: request.schemaFingerprint,
          input: request.input,
          messages: request.messages
        });
        return {
          output: request.stage === "formatter"
            ? JSON.stringify(unifiedOutput())
            : `${request.stage}-natural-judgement`,
          eofVerified: true
        };
      }
    });

    expect(calls.map((call) => call.stage).sort()).toEqual(["A", "B", "C", "D", "formatter"].sort());
    expect(calls.filter((call) => call.stage === "formatter")).toHaveLength(1);
    expect(calls.filter((call) => call.stage !== "formatter").every((call) => call.schema === null)).toBe(true);
    expect(calls.at(-1)!.schema).toBe(reviewFlowUnifiedSchemaFingerprint);
    expect(calls.at(-1)!.input).toContain("D-natural-judgement");
    expect(calls.at(-1)!.messages[0]!.content).toContain("禁止增加、删除、纠正或重新判断");
    expect(result.formatterRequestCount).toBe(1);
  });

  it("only reuses a successful stage when every content binding and EOF fact matches", async () => {
    const scheduler = new FairLlmRequestScheduler({ maximumConcurrency: 12, jitter: () => 0 });
    const first = await runFourCallReviewDag({
      caseId: "case-reuse",
      sourceBinding: digestB,
      model: model(),
      nativeSchemaCompatible: true,
      scheduler,
      call: async (request) => ({
        output: stageOutput(request.stage),
        eofVerified: true
      })
    });
    const called: string[] = [];
    const second = await runFourCallReviewDag({
      caseId: "case-reuse",
      sourceBinding: digestB,
      model: model(),

      nativeSchemaCompatible: true,
      scheduler,
      reusableStages: first.stages,
      call: async (request) => {
        called.push(request.stage);
        return { output: "must-not-run", eofVerified: true };
      }
    });
    expect(called).toEqual([]);
    expect(second.reusedStages).toEqual(["A", "B", "C", "D"]);

    const tampered = {
      ...first.stages,
      A: { ...first.stages.A, output: "changed" }
    };
    await expect(runFourCallReviewDag({
      caseId: "case-reuse",
      sourceBinding: digestB,
      model: model(),
      nativeSchemaCompatible: true,
      scheduler,
      reusableStages: tampered,
      call: async (request) => {
        const output = unifiedOutput();
        if (request.stage === "A") {
          return {
            output: JSON.stringify({ ...output.a, blindSolution: "changed-solution" }),
            eofVerified: true
          };
        }
        if (request.stage === "C") {
          return {
            output: JSON.stringify({ ...output.c, solutionAnalysis: "changed-analysis" }),
            eofVerified: true
          };
        }
        return { output: stageOutput(request.stage), eofVerified: true };
      }
    })).resolves.toMatchObject({ reusedStages: ["B"] });
  });
  it("production adapter emits two-round A plus single-round B/C/D with stage budgets", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const stage = syntheticFourCallStage(body);
      if (stage === undefined) {
        throw new Error("unexpected synthetic stage");
      }
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: stage === "A"
              ? "合成盲解自由文本，不包含 JSON。"
              : stage === "A_FORMAT"
                ? stageOutput("A")
                : stageOutput(stage)
          },
          finish_reason: "stop"
        }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const runtimeModel: PipelineModelConfig = {
      credentials: { baseUrl: "https://provider.example/v1", apiKey: "synthetic-key" },
      spec: {
        provider: "aether",
        model: "deepseek-v4-pro",
        temperature: 0,
        thinking: false,
        thinkingRequest: "enabled",
        reasoningEffort: "max"
      },
      runtime: {
        outputIdleTimeoutMs: 600_000,
        firstOutputTimeoutMs: 600_000,
        maximumDurationMs: 1_800_000,
        maxAttempts: 3,
        baseDelayMs: 500,
        fetch: fetchImpl
      }
    };
    const result = await runProductionFourCallReviewDag({
      caseId: "production-synthetic",
      sourceBinding: digestB,
      source: {
        statement: "statement",
        referenceSolution: "solution",
        technicalContext: null,
        historicalTasteRubric: null,
        difficultyAnchors: [],
        labelCatalog: ["dp"],
        hardRules: []
      },
      models: {
        A: runtimeModel,
        B: runtimeModel,
        C: runtimeModel,
        D: runtimeModel,
        formatter: runtimeModel
      },
      nativeSchemaCompatible: true,
      scheduler: new FairLlmRequestScheduler({ maximumConcurrency: 12, jitter: () => 0 })
    });
    expect(result.semanticRequestCount).toBe(4);
    expect(result.formatterRequestCount).toBe(0);
    // A 语义轮 + A 格式轮 + B/C/D 各一次
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(bodies.map((body) => body.max_tokens).sort((left, right) =>
      Number(left) - Number(right)
    )).toEqual([384_000, 384_000, 384_000, 384_000, 384_000]);
    for (const body of bodies) {
      expect(body).toMatchObject({
        thinking: { type: "enabled" },
        reasoning_effort: "max"
      });
    }
    expect(bodies.filter((body) => body.max_tokens === 384_000 && body.response_format === undefined))
      .toHaveLength(2);
    const formatBody = bodies.find((body) =>
      String((body.messages as readonly { content: string }[]).at(-1)?.content).includes(
        "目标 JSON Schema"
      )
    );
    expect(formatBody).toBeDefined();
    expect(formatBody?.max_tokens).toBe(384_000);
  });
});

describe("两轮 A 阶段（语义→格式）", () => {
  it("routes A through reasoning-then-format rounds with per-round provider-max budget and reasoning=max", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const stage = syntheticFourCallStage(body);
      if (stage === undefined) {
        throw new Error("unexpected synthetic stage");
      }
      if (stage === "A") {
        return syntheticJsonCompletion("合成盲解自由文本，不包含 JSON。");
      }
      if (stage === "A_FORMAT") {
        return syntheticJsonCompletion(stageOutput("A"));
      }
      return syntheticJsonCompletion(stageOutput(stage));
    });

    const result = await runProductionFourCallReviewDag(
      twoRoundDagArgs(fetchImpl)
    );
    expect(result.semanticRequestCount).toBe(4);
    expect(fetchImpl).toHaveBeenCalledTimes(5);

    const semanticCalls = bodies.filter((body) =>
      syntheticFourCallStage(body) === "A"
    );
    const formatCalls = bodies.filter((body) =>
      syntheticFourCallStage(body) === "A_FORMAT"
    );
    expect(semanticCalls).toHaveLength(1);
    expect(formatCalls).toHaveLength(1);
    for (const call of [...semanticCalls, ...formatCalls]) {
      expect(call).toMatchObject({
        max_tokens: 384_000,
        thinking: { type: "enabled" },
        reasoning_effort: "max"
      });
      expect(call.response_format).toBeUndefined();
    }
  });

  it("format round is format-only: a malformed format is repaired exactly once", async () => {
    let formatAttempts = 0;
    const failures: FourCallSafeRequestFailure[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const stage = syntheticFourCallStage(JSON.parse(String(init?.body)));
      if (stage === undefined) {
        throw new Error("unexpected synthetic stage");
      }
      if (stage === "A") {
        return syntheticJsonCompletion("合成盲解自由文本。");
      }
      if (stage === "A_FORMAT") {
        formatAttempts += 1;
        if (formatAttempts === 1) {
          return syntheticJsonCompletion("这不是合法 JSON，仅演示格式轮修复。");
        }
        return syntheticJsonCompletion(stageOutput("A"));
      }
      return syntheticJsonCompletion(stageOutput(stage));
    });

    const result = await runProductionFourCallReviewDag(
      twoRoundDagArgs(fetchImpl, {
        beforeRequest: () => undefined,
        requestCompleted: () => undefined,
        requestFailed: (_request, failure) => {
          failures.push(failure);
        }
      })
    );
    expect(result.semanticRequestCount).toBe(4);
    expect(formatAttempts).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(6); // A 语义 + A 格式 + A 修复 + B/C/D
    expect(failures).toHaveLength(0);
  });

  it("treats an output-limited format round as terminal without retry and reports both-round identity", async () => {
    let formatAttempts = 0;
    const failures: FourCallSafeRequestFailure[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const stage = syntheticFourCallStage(JSON.parse(String(init?.body)));
      if (stage === undefined) {
        throw new Error("unexpected synthetic stage");
      }
      if (stage === "A") {
        return syntheticJsonCompletion("合成盲解自由文本。");
      }
      if (stage === "A_FORMAT") {
        formatAttempts += 1;
        return syntheticJsonCompletionFinish("截断输出", "length");
      }
      return syntheticJsonCompletion(stageOutput(stage));
    });

    await expect(runProductionFourCallReviewDag(
      twoRoundDagArgs(fetchImpl, {
        beforeRequest: () => undefined,
        requestCompleted: () => undefined,
        requestFailed: (_request, failure) => {
          failures.push(failure);
        }
      })
    )).rejects.toMatchObject({
      kind: "output_limit",
      cause: { code: "LLM_OUTPUT_LENGTH_LIMIT" }
    });
    expect(formatAttempts).toBe(1); // 终态，无重试、无修复轮
    expect(failures).toHaveLength(1);
    expect(failures[0]!).toMatchObject({
      kind: "output_limit",
      code: "LLM_OUTPUT_LENGTH_LIMIT",
      requestCount: 2,
      transportAttemptCount: 2,
      completedResponseCount: 1
    });
  });

  it("keeps B/C/D single-round with one external transport each", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const stage = syntheticFourCallStage(body);
      if (stage === undefined) {
        throw new Error("unexpected synthetic stage");
      }
      if (stage === "A") {
        return syntheticJsonCompletion("合成盲解自由文本。");
      }
      if (stage === "A_FORMAT") {
        return syntheticJsonCompletion(stageOutput("A"));
      }
      return syntheticJsonCompletion(stageOutput(stage));
    });

    const result = await runProductionFourCallReviewDag(
      twoRoundDagArgs(fetchImpl)
    );
    expect(result.semanticRequestCount).toBe(4);
    for (const stage of ["B", "C", "D"] as const) {
      const calls = bodies.filter((body) => syntheticFourCallStage(body) === stage);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.max_tokens).toBe(
        reviewFlowStageOutputBudgets[stage]
      );
    }
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});

describe("统一机器 schema", () => {
  it("has one stable fingerprint and forbids undeclared object properties recursively", () => {
    expect(reviewFlowUnifiedSchemaFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(reviewFlowUnifiedJsonSchema.additionalProperties).toBe(false);
    expect(reviewFlowUnifiedJsonSchema.properties.a.additionalProperties).toBe(false);
    expect(reviewFlowUnifiedJsonSchema.properties.c.properties.tagIds.items).toEqual({ type: "string" });
    expect(reviewFlowUnifiedJsonSchema.required).toEqual(["schemaVersion", "a", "b", "c", "d"]);
    expect(() => parseReviewFlowUnifiedResult({ ...unifiedOutput(), unexpected: true })).toThrow(
      "REVIEW_FLOW_UNIFIED_SCHEMA_INVALID"
    );
    expect(parseReviewFlowUnifiedResult(unifiedOutput())).toEqual(unifiedOutput());
  });

  it("freezes stage budgets at provider hard max (no project output cap remains)", () => {
    expect(reviewFlowStageOutputBudgets).toEqual({
      A: 384_000,
      B: 384_000,
      C: 384_000,
      D: 384_000,
      formatter: 384_000
    });
  });
});

describe("全局公平调度与逐阶段重试", () => {
  it("uses one global cap, is work-conserving, and round-robins pending cases", async () => {
    const scheduler = new FairLlmRequestScheduler({ maximumConcurrency: 2, jitter: () => 0 });
    const starts: string[] = [];
    const releases: Array<() => void> = [];
    const schedule = (caseId: string, requestId: string) => scheduler.runLogicalRequest({
      caseId,
      requestId,
      execute: async () => {
        starts.push(`${caseId}:${requestId}`);
        const waiter = Promise.withResolvers<void>();
        releases.push(waiter.resolve);
        await waiter.promise;
        return requestId;
      }
    });

    const jobs = [
      schedule("case-a", "a1"),
      schedule("case-a", "a2"),
      schedule("case-a", "a3"),
      schedule("case-b", "b1")
    ];
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    expect(starts).toEqual(["case-a:a1", "case-b:b1"]);
    releases.shift()!();
    await vi.waitFor(() => expect(starts).toHaveLength(3));
    expect(scheduler.snapshot().peakConcurrency).toBe(2);
    for (const release of releases.splice(0)) release();
    await vi.waitFor(() => expect(starts).toHaveLength(4));
    for (const release of releases.splice(0)) release();
    await Promise.all(jobs);
  });
  it("defaults to one global 12 cap; 16 is configurable and 20 needs an accepted probe", () => {
    expect(new FairLlmRequestScheduler().snapshot().maximumConcurrency).toBe(12);
    expect(new FairLlmRequestScheduler({ maximumConcurrency: 16 }).snapshot().maximumConcurrency).toBe(16);
    expect(() => new FairLlmRequestScheduler({ maximumConcurrency: 20 })).toThrow(
      "LLM_SCHEDULER_TWENTY_REQUIRES_ACCEPTED_PROBE"
    );
    expect(new FairLlmRequestScheduler({
      maximumConcurrency: 20,
      twentyConcurrencyProbeAccepted: true
    }).snapshot().maximumConcurrency).toBe(20);
  });

  it("retries only classified transient failures, honors Retry-After, and caps logical/case attempts", async () => {
    const delays: number[] = [];
    const scheduler = new FairLlmRequestScheduler({
      maximumConcurrency: 12,
      jitter: () => 0,
      sleep: async (ms) => { delays.push(ms); }
    });
    let attempt = 0;
    await expect(scheduler.runLogicalRequest({
      caseId: "retry-case",
      requestId: "A",
      execute: async () => {
        attempt += 1;
        if (attempt === 1) throw new LlmStageRequestError("rate_limited", { retryAfterMs: 2_000 });
        if (attempt === 2) throw new LlmStageRequestError("server_error");
        return "ok";
      }
    })).resolves.toMatchObject({ value: "ok", attemptCount: 3 });
    expect(delays).toEqual([2_000, 1_000]);

    await expect(scheduler.runLogicalRequest({
      caseId: "schema-case",
      requestId: "C",
      execute: async () => { throw new LlmStageRequestError("schema_invalid"); }
    })).rejects.toMatchObject({ kind: "schema_invalid" });
    expect(scheduler.snapshot().attemptsByCase["schema-case"]).toBe(1);

    const exhausted = new FairLlmRequestScheduler({ maximumConcurrency: 12, jitter: () => 0, sleep: async () => undefined });
    for (let index = 0; index < 2; index += 1) {
      await expect(exhausted.runLogicalRequest({
        caseId: "bounded",
        requestId: `request-${index}`,
        execute: async () => { throw new LlmStageRequestError("connect"); }
      })).rejects.toMatchObject({ kind: "connect" });
    }
    await expect(exhausted.runLogicalRequest({
      caseId: "bounded",
      requestId: "request-2",

      execute: async () => { throw new LlmStageRequestError("connect"); }
    })).rejects.toThrow("LLM_CASE_ATTEMPT_LIMIT");
    expect(exhausted.snapshot().attemptsByCase.bounded).toBe(8);
  });
  it("classifies every response-loss boundary while refusing blind schema/output-limit retries", () => {
    expect(classifyTransportFailure(
      new LlmRequestError("LLM_HTTP_ERROR", 429, undefined, undefined, 9_000)
    )).toMatchObject({ kind: "rate_limited", retryAfterMs: 9_000 });
    expect(classifyTransportFailure(
      new LlmRequestError("LLM_HTTP_ERROR", 503)
    )).toMatchObject({ kind: "server_error" });
    expect(classifyTransportFailure(
      new LlmRequestError("LLM_NETWORK_FAILED")
    )).toMatchObject({ kind: "connect" });
    expect(classifyTransportFailure(
      new LlmRequestError("LLM_FIRST_OUTPUT_TIMEOUT")
    )).toMatchObject({ kind: "first_byte_timeout" });
    expect(classifyTransportFailure(
      new LlmRequestError("LLM_OUTPUT_IDLE_TIMEOUT")
    )).toMatchObject({ kind: "no_progress_timeout" });
    expect(classifyTransportFailure(
      new LlmRequestError("LLM_STREAM_INTERRUPTED")
    )).toMatchObject({ kind: "stream_interrupted" });
    expect(classifyTransportFailure(
      new LlmRequestError("LLM_OUTPUT_LENGTH_LIMIT")
    )).toMatchObject({ kind: "output_limit" });
    expect(classifyTransportFailure(
      new LlmResponseFormatError("response_shape")
    )).toMatchObject({ kind: "permanent" });
  });

  it("soft stop blocks new work while in-flight work drains naturally", async () => {
    const scheduler = new FairLlmRequestScheduler({ maximumConcurrency: 1, jitter: () => 0 });
    let release!: () => void;
    const inFlight = scheduler.runLogicalRequest({
      caseId: "drain",
      requestId: "A",
      execute: async () => {
        const waiter = Promise.withResolvers<string>();
        release = () => waiter.resolve("done");
        return waiter.promise;
      }
    });
    await vi.waitFor(() => expect(scheduler.snapshot().active).toBe(1));
    const queued = scheduler.runLogicalRequest({
      caseId: "queued",
      requestId: "A",
      execute: async () => "must-not-start"
    });
    await vi.waitFor(() => expect(scheduler.snapshot().queued).toBe(1));
    scheduler.softStop();
    await expect(queued).rejects.toThrow("LLM_SCHEDULER_SOFT_STOPPED");
    await expect(scheduler.runLogicalRequest({
      caseId: "new",
      requestId: "A",
      execute: async () => "no"
    })).rejects.toThrow("LLM_SCHEDULER_SOFT_STOPPED");
    expect(scheduler.snapshot().attemptsByCase.queued).toBeUndefined();
    release();
    await expect(inFlight).resolves.toMatchObject({ value: "done" });
    expect(scheduler.snapshot().active).toBe(0);
  });
});
