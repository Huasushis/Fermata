/**
 * reasoning-length salvage 路径的聚焦合成测试。
 *
 * 所有测试用合成 SSE 响应驱动真实生产路径（runProductionFourCallReviewDag），
 * 不发起任何外部模型请求。验证：
 *   1. 默认（salvage 关闭路径不变）finish_reason=length 仍然失败
 *   2. salvage 启用 + reasoning 非空 + content 为空 → finalizer 路径成功
 *   3. salvage 启用 + reasoning 为空 → 仍然失败
 *   4. salvage 启用 + finish_reason=stop → 正常路径不受影响
 *   5. finalizer 输出非合法 JSON → 修复轮；修复轮仍失败 → 终态失败
 *   6. 传输错误正常传播
 *   7. 不从 difficulty 推断 verdict
 *   8. 请求/尝试次数计数包含 finalizer
 */
import { describe, expect, it, vi } from "vitest";
import {
  chatCompleteSalvageableWithReceipt,
  getLlmFailureAudit
} from "../src/llm";
import { FairLlmRequestScheduler } from "../src/llm-scheduler";
import {
  runProductionFourCallReviewDag,
  type FourCallRequestLifecycle,
  type FourCallSafeRequestFailure
} from "../src/review-flow/four-call-runtime";
import type { PipelineModelConfig } from "../src/pipelines/types";

const digestB = "b".repeat(64);

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

function stageOutput(stage: "A" | "B" | "C" | "D"): string {
  const output = unifiedOutput();
  const property = { A: "a", B: "b", C: "c", D: "d" }[stage] as "a" | "b" | "c" | "d";
  return JSON.stringify(output[property]);
}

function unifiedOutputJson(): string {
  return JSON.stringify(unifiedOutput());
}

/** SSE 完整流：delta content + finish_reason=stop + DONE */
function sseContentStream(content: string): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content }, finish_reason: "stop" }]
  })}\n\ndata: [DONE]\n\n`;
}

/** SSE reasoning-only + finish_reason=length + DONE */
function sseReasoningLengthStream(reasoning: string): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { reasoning_content: reasoning }, finish_reason: "length" }]
  })}\n\ndata: [DONE]\n\n`;
}

/** SSE finish_reason=length + 空 delta + DONE */
function sseEmptyLengthStream(): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: "length" }]
  })}\n\ndata: [DONE]\n\n`;
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

/**
 * 识别合成请求中的阶段（nativeSchemaCompatible=true）。
 * - B/C/D：response_format={json_schema:{name:fermata_..._X_v1}}
 * - formatter：response_format={json_schema:{name:fermata_..._formatter_v1}}
 * - A 语义轮：无 response_format，无"目标 JSON Schema"
 * - A 格式/finalizer 轮：无 response_format，含"目标 JSON Schema"
 * - C/D salvage finalizer：response_format={type:json_object}
 */
type SyntheticStage = "A" | "A_CONT" | "A_FORMAT" | "B" | "C" | "D" | "FORMATTER" | "FINALIZER" | "FINALIZER_REPAIR";

function syntheticStage(body: Record<string, unknown>): SyntheticStage | undefined {
  expect(body).not.toHaveProperty("max_tokens");
  expect(body).not.toHaveProperty("max_completion_tokens");
  expect(body).not.toHaveProperty("maxOutputTokens");
  const responseFormat = body.response_format as
    | { type?: string; json_schema?: { name?: string } }
    | undefined;
  const messages = (body.messages ?? []) as Array<{ content?: unknown }>;
  const hasContinuation = messages.some(
    (m) => typeof m.content === "string" && (
      m.content.includes("前序模型段") || m.content.includes("请继续完成")
    )
  );
  if (hasContinuation) return "A_CONT";
  const hasSchemaInstruction = messages.some(
    (m) => typeof m.content === "string" && m.content.includes("目标 JSON Schema")
  );
  const hasRepairHint = messages.some(
    (m) => typeof m.content === "string" && m.content.includes("上一条回复")
  );

  const schemaName = responseFormat?.json_schema?.name ?? "";
  const schemaStage = schemaName.match(/_([abcd])_v1$/u)?.[1]?.toUpperCase();
  if (schemaStage === "B" || schemaStage === "C" || schemaStage === "D") {
    return schemaStage;
  }
  if (schemaName === "fermata_review_flow_role_v1") return "A_FORMAT";
  if (schemaName.endsWith("_formatter_v1") || schemaName.includes("formatter")) {
    return "FORMATTER";
  }
  if (responseFormat?.type === "json_object") {
    return hasRepairHint ? "FINALIZER_REPAIR" : "FINALIZER";
  }
  if (responseFormat !== undefined) return undefined;
  return hasSchemaInstruction ? "A_FORMAT" : "A";

}
function proConfig(fetchImpl: NonNullable<PipelineModelConfig["runtime"]["fetch"]>): PipelineModelConfig {
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

function dagArgs(
  fetchImpl: NonNullable<PipelineModelConfig["runtime"]["fetch"]>,
  lifecycle?: FourCallRequestLifecycle
) {
  const pro = proConfig(fetchImpl);
  return {
    caseId: "salvage-test",
    sourceBinding: digestB,
    source: fourCallSource(),
    models: { A: pro, B: pro, C: pro, D: pro, formatter: pro },
    nativeSchemaCompatible: true,
    scheduler: new FairLlmRequestScheduler({ maximumConcurrency: 12, jitter: () => 0 }),
    ...(lifecycle === undefined ? {} : { lifecycle })
  };
}

describe("reasoning-length salvage 路径", () => {
  it("默认 finish_reason=length 仍然失败（B 阶段单轮 salvage 不生效）", async () => {
    const failures: FourCallSafeRequestFailure[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const stage = syntheticStage(body);
      if (stage === "A") return sseResponse(sseContentStream("合成盲解自由文本。"));
      if (stage === "A_FORMAT") return sseResponse(sseContentStream(stageOutput("A")));
      if (stage === "B") return sseResponse(sseEmptyLengthStream());
      if (stage === "C" || stage === "D") return sseResponse(sseContentStream(stageOutput(stage)));
      if (stage === "FORMATTER") return sseResponse(sseContentStream(unifiedOutputJson()));
      throw new Error(`unexpected stage: ${stage}`);
    });

    await expect(runProductionFourCallReviewDag(
      dagArgs(fetchImpl, {
        beforeRequest: () => undefined,
        requestCompleted: () => undefined,
        requestFailed: (_req, failure) => { failures.push(failure); }
      })
    )).rejects.toMatchObject({ kind: "output_limit" });
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures[0]!.kind).toBe("output_limit");
  });

  it("A length → 仅续写一次后进入独立 strict schema 格式轮", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const stage = syntheticStage(body);
      if (stage === "A") {
        return sseResponse(sseReasoningLengthStream("合成推理：题目可解，构造路径存在。"));
      }
      if (stage === "A_CONT") {
        return sseResponse(sseContentStream("续写完成。"));
      }
      if (stage === "A_FORMAT") {
        return sseResponse(sseContentStream(stageOutput("A")));
      }
      if (stage === "B" || stage === "C" || stage === "D") {
        return sseResponse(sseContentStream(stageOutput(stage)));
      }
      if (stage === "FORMATTER") return sseResponse(sseContentStream(unifiedOutputJson()));
      throw new Error(`unexpected stage: ${stage}`);
    });

    const result = await runProductionFourCallReviewDag(dagArgs(fetchImpl));
    expect(result.semanticRequestCount).toBe(4);
    expect(result.output.d.verdict).toBe("approve");
    const aSemantic = bodies.filter((b) => syntheticStage(b) === "A");
    expect(aSemantic).toHaveLength(1);
    const aContinuation = bodies.filter((b) => syntheticStage(b) === "A_CONT");
    expect(aContinuation).toHaveLength(1);
    expect((aContinuation[0]!.messages as Array<{ content?: string }>).some(
      (message) => message.content?.includes("合成推理：题目可解，构造路径存在。") === true
    )).toBe(true);
    const aFormat = bodies.filter((b) => syntheticStage(b) === "A_FORMAT");
    expect(aFormat.length).toBeGreaterThanOrEqual(1);
  });

  it("续写轮再次 length 时 fail closed，并保留前序 length receipt", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const stage = syntheticStage(body);
      if (stage === "A") {
        return sseResponse(sseReasoningLengthStream("第一段推理。"));
      }
      if (stage === "A_CONT") {
        return sseResponse(sseReasoningLengthStream("第二段仍被截断。"));
      }
      throw new Error(`unexpected stage: ${stage}`);
    });

    const caught = await chatCompleteSalvageableWithReceipt(
      proConfig(fetchImpl).credentials,
      proConfig(fetchImpl).spec,
      [{ role: "user", content: "synthetic" }],
      proConfig(fetchImpl).runtime
    ).catch((error: unknown) => error);

    expect(caught).toMatchObject({ code: "LLM_OUTPUT_LENGTH_LIMIT" });
    const audit = getLlmFailureAudit(caught);
    expect(audit).toMatchObject({
      requestCount: 2,
      transportAttemptCount: 2,
      completedResponses: [{
        finishReasonLengthSalvaged: true,
        transportAttemptCount: 1,
        eofVerified: true
      }],
      terminal: {
        responseMode: "sse",
        eofObserved: true,
        finishReason: "length",
        sseDoneObserved: true
      }
    });
    expect(audit?.completedResponses).toHaveLength(1);
  });

  it("length 后的第二个 data event 即使 choices 为空也拒绝", async () => {
    const fetchImpl = vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({
        choices: [{ delta: { reasoning_content: "第一段推理。" }, finish_reason: "length" }]
      })}`,
      `data: ${JSON.stringify({ choices: [] })}`,
      "data: [DONE]"
    ].join("\n\n") + "\n\n"));

    const caught = await chatCompleteSalvageableWithReceipt(
      proConfig(fetchImpl).credentials,
      proConfig(fetchImpl).spec,
      [{ role: "user", content: "synthetic" }],
      proConfig(fetchImpl).runtime
    ).catch((error: unknown) => error);

    expect(caught).toMatchObject({
      code: "LLM_RESPONSE_FORMAT_INVALID",
      formatFailureStage: "trailing_data",
      formatFailureSubstage: "choice_after_length"
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("A salvage: reasoning 为空 + content 为空 → 仍然失败", async () => {
    const failures: FourCallSafeRequestFailure[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const stage = syntheticStage(body);
      if (stage === "A") return sseResponse(sseEmptyLengthStream());
      if (stage === "A_FORMAT") return sseResponse(sseContentStream(stageOutput("A")));
      if (stage === "B" || stage === "C" || stage === "D") {
        return sseResponse(sseContentStream(stageOutput(stage)));
      }
      if (stage === "FORMATTER") return sseResponse(sseContentStream(unifiedOutputJson()));
      throw new Error(`unexpected stage: ${stage}`);
    });

    await expect(runProductionFourCallReviewDag(
      dagArgs(fetchImpl, {
        beforeRequest: () => undefined,
        requestCompleted: () => undefined,
        requestFailed: (_req, failure) => { failures.push(failure); }
      })
    )).rejects.toMatchObject({ kind: "output_limit" });
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures[0]!.kind).toBe("output_limit");
  });

  it("salvage 启用 + finish_reason=stop → 正常两轮路径不受影响", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const stage = syntheticStage(body);
      if (stage === "A") return sseResponse(sseContentStream("合成盲解自由文本。"));
      if (stage === "A_FORMAT") return sseResponse(sseContentStream(stageOutput("A")));
      if (stage === "B" || stage === "C" || stage === "D") {
        return sseResponse(sseContentStream(stageOutput(stage)));
      }
      if (stage === "FORMATTER") return sseResponse(sseContentStream(unifiedOutputJson()));
      throw new Error(`unexpected stage: ${stage}`);
    });

    const result = await runProductionFourCallReviewDag(dagArgs(fetchImpl));
    expect(result.semanticRequestCount).toBe(4);
    expect(result.output.d.verdict).toBe("approve");
    const jsonObjectCalls = bodies.filter((b) => {
      const rf = b.response_format as { type?: string } | undefined;
      return rf?.type === "json_object";
    });
    expect(jsonObjectCalls).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("续写完成后格式轮非法 JSON → 仅允许一次修复，仍失败即关闭", async () => {
    let finalizerAttempts = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const stage = syntheticStage(body);
      if (stage === "A") {
        return sseResponse(sseReasoningLengthStream("合成推理。"));
      }
      if (stage === "A_CONT") {
        return sseResponse(sseContentStream("续写完成。"));
      }
      if (stage === "A_FORMAT") {
        finalizerAttempts += 1;
        if (finalizerAttempts === 1) {
          return sseResponse(sseContentStream("这不是合法 JSON。"));
        }
        return sseResponse(sseContentStream("仍然不是 JSON。"));
      }
      if (stage === "B" || stage === "C" || stage === "D") {
        return sseResponse(sseContentStream(stageOutput(stage)));
      }
      if (stage === "FORMATTER") return sseResponse(sseContentStream(unifiedOutputJson()));
      throw new Error(`unexpected stage: ${stage}`);
    });

    await expect(runProductionFourCallReviewDag(dagArgs(fetchImpl))).rejects.toMatchObject({
      cause: { code: "LLM_JSON_OUTPUT_INVALID" }
    });
    expect(finalizerAttempts).toBe(2);
  });

  it("传输错误（HTTP 503）正常传播", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const stage = syntheticStage(body);
      if (stage === "A") {
        return sseResponse(sseReasoningLengthStream("合成推理。"));
      }
      if (stage === "A_CONT") {
        return sseResponse(sseContentStream("续写完成。"));
      }
      if (stage === "A_FORMAT") {
        return new Response(null, { status: 503 });
      }
      if (stage === "B" || stage === "C" || stage === "D") {
        return sseResponse(sseContentStream(stageOutput(stage)));
      }
      if (stage === "FORMATTER") return sseResponse(sseContentStream(unifiedOutputJson()));
      throw new Error(`unexpected stage: ${stage}`);
    });

    await expect(runProductionFourCallReviewDag(dagArgs(fetchImpl))).rejects.toMatchObject({
      kind: "server_error"
    });
  });

  it("不从 difficulty 推断 verdict：B 难度与 D 判决独立", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const stage = syntheticStage(body);
      if (stage === "A") return sseResponse(sseContentStream("合成盲解。"));
      if (stage === "A_FORMAT") return sseResponse(sseContentStream(stageOutput("A")));
      if (stage === "B") {
        const b = {
          codeforcesDifficulty: 3500,
          thinkingLevel: 5,
          codingLevel: 5,
          rationale: "extremely hard"
        };
        return sseResponse(sseContentStream(JSON.stringify(b)));
      }
      if (stage === "C") return sseResponse(sseContentStream(stageOutput("C")));
      if (stage === "D") {
        const d = {
          verdict: "reject" as const,
          qualityLevel: 2,
          acceptedSignals: [],
          rejectedSignals: ["boundary risk"],
          hardBlockers: [],
          improvements: "clarify proof",
          publicComment: "不通过。",
          privateNote: "独立裁决。"
        };
        return sseResponse(sseContentStream(JSON.stringify(d)));
      }
      if (stage === "FORMATTER") return sseResponse(sseContentStream(unifiedOutputJson()));
      throw new Error(`unexpected stage: ${stage}`);
    });

    const result = await runProductionFourCallReviewDag(dagArgs(fetchImpl));
    expect(result.output.b.codeforcesDifficulty).toBe(3500);
    expect(result.output.d.verdict).toBe("reject");
  });

  it("salvage 路径的 externalTransportAttemptsUsed 包含 finalizer 传输", async () => {
    const timings: Array<{ stage: string; externalTransportAttemptsUsed: number }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const stage = syntheticStage(body);
      if (stage === "A") return sseResponse(sseReasoningLengthStream("合成推理。"));
      if (stage === "A_FORMAT") return sseResponse(sseContentStream(stageOutput("A")));
      if (stage === "A_CONT") {
        return sseResponse(sseContentStream("续写完成。"));
      }
      if (stage === "B" || stage === "C" || stage === "D") {
        return sseResponse(sseContentStream(stageOutput(stage)));
      }
      if (stage === "FORMATTER") return sseResponse(sseContentStream(unifiedOutputJson()));
      throw new Error(`unexpected stage: ${stage}`);
    });

    await runProductionFourCallReviewDag(dagArgs(fetchImpl, {
      beforeRequest: () => undefined,
      requestCompleted: (req, timing) => {
        timings.push({
          stage: req.stage,
          externalTransportAttemptsUsed: timing.externalTransportAttemptsUsed ?? 0
        });
      },
      requestFailed: () => undefined
    }));

    const aTiming = timings.find((t) => t.stage === "A");
    expect(aTiming).toBeDefined();
    expect(aTiming!.externalTransportAttemptsUsed).toBeGreaterThanOrEqual(2);
    for (const stage of ["B", "C", "D"] as const) {
      const t = timings.find((t) => t.stage === stage);
      expect(t).toBeDefined();
      expect(t!.externalTransportAttemptsUsed).toBe(1);
    }
  });
});
