import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  chatComplete,
  chatCompleteWithReceipt,
  chatCompleteJson,
  chatCompleteJsonWithReceipt,
  chatCompleteTwoRoundJsonWithReceipt,
  getLlmFailureAudit,
  LlmRequestStartGate,
  LlmJsonOutputError,
  LlmRequestError,
  LlmRetainedTextTooLargeError,
  LlmResponseFormatError,
  maximumExplicitLlmOutputTokens,
  maximumRetainedLlmTextLength,
  withLlmRequestStartGate,
  type ModelCallSpec
} from "../src/llm";
import {
  createAdjudicatorPayloadSchema,
  createAdversaryPayloadSchema,
  createOriginalityPayloadSchema,
  originalityPayloadSchema
} from "../src/review-flow/schemas";

const provider = { baseUrl: "https://llm.example.test/v1", apiKey: "sk-test" };
const spec = { model: "test-model", temperature: 0.2, thinking: false };
const runtime = { outputIdleTimeoutMs: 5_000, maxAttempts: 3, baseDelayMs: 1 };

function completionResponse(content: string, reasoning?: string): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content, ...(reasoning === undefined ? {} : { reasoning_content: reasoning }) },
          finish_reason: "stop"
        }
      ]
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function stoppedSsePrefix(lineEnding = "\n"): string {
  const event = JSON.stringify({
    choices: [{ delta: { content: "合成完整答案" }, finish_reason: "stop" }]
  });
  return [
    `data: ${event}`,
    "",
    "data: [DONE]",
    "",
    ""
  ].join(lineEnding);
}

function sseDataEvent(data: string, lineEnding = "\n"): string {
  return [`data: ${data}`, "", ""].join(lineEnding);
}

function strictUsageMetadataEvent(): Record<string, unknown> {
  return {
    id: "synthetic-completion-id",
    object: "chat.completion.chunk",
    created: 1,
    model: "synthetic-model",
    system_fingerprint: null,
    service_tier: "default",
    choices: [],
    usage: {
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
      prompt_tokens_details: { cached_tokens: 0 }
    }
  };
}

describe("chatComplete：正常路径", () => {
  it("共享停发闸门关闭后仍等待已发请求真实 EOF", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({
          choices: [{
            message: { role: "assistant", content: "完整答案" },
            finish_reason: "stop"
          }]
        })));
      }
    });
    const fetchMock = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    const gate = new LlmRequestStartGate();
    let settled = false;
    const pending = withLlmRequestStartGate(gate, () =>
      chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock })
    ).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    gate.close();
    await Promise.resolve();
    expect(settled).toBe(false);
    streamController.close();
    await expect(pending).resolves.toEqual({ content: "完整答案", reasoning: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("共享停发闸门在 429 退避期间关闭时不启动下一次 HTTP 尝试", async () => {
    vi.useFakeTimers();
    try {
      const gate = new LlmRequestStartGate();
      const fetchMock = vi.fn(async () => new Response(null, { status: 429 }));
      const outcome = withLlmRequestStartGate(gate, () =>
        chatComplete(provider, spec, [], {
          ...runtime,
          baseDelayMs: 1_000,
          fetch: fetchMock
        })
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error })
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      gate.close();
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await outcome;
      expect(result).toMatchObject({
        status: "rejected",
        error: { code: "LLM_REQUEST_START_BLOCKED" }
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("并发 AsyncLocalStorage 上下文中的两个停发闸门互不污染", async () => {
    const closedGate = new LlmRequestStartGate();
    const openGate = new LlmRequestStartGate();
    let releaseBoth!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const closedFetch = vi.fn(async () => completionResponse("不应发送"));
    const openFetch = vi.fn(async () => completionResponse("独立完整答案"));
    const closed = withLlmRequestStartGate(closedGate, async () => {
      await barrier;
      return chatComplete(provider, spec, [], { ...runtime, fetch: closedFetch });
    });
    const open = withLlmRequestStartGate(openGate, async () => {
      await barrier;
      return chatComplete(provider, spec, [], { ...runtime, fetch: openFetch });
    });

    closedGate.close();
    releaseBoth();
    const [closedResult, openResult] = await Promise.allSettled([closed, open]);
    expect(closedResult).toMatchObject({
      status: "rejected",
      reason: { code: "LLM_REQUEST_START_BLOCKED" }
    });
    expect(openResult).toEqual({
      status: "fulfilled",
      value: { content: "独立完整答案", reasoning: null }
    });
    expect(closedFetch).not.toHaveBeenCalled();
    expect(openFetch).toHaveBeenCalledTimes(1);
  });

  it("可信 receipt 只在完整响应后生成，并记录明确 429 后的真实 HTTP 尝试数", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response(null, { status: 429 })
        : completionResponse("完整答案");
    });
    const result = await chatCompleteWithReceipt(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    });
    expect(result).toEqual({
      content: "完整答案",
      reasoning: null,
      receipt: {
        schemaVersion: 2,
        transportAttemptCount: 2,
        eofVerified: true,
        responseMode: "json",
        finishReasonStopVerified: true,
        acceptedEventShapes: [],
        sseDoneObserved: null
      }
    });
  });

  it("请求正确的 URL、鉴权头，并解析 content 和 reasoning_content", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://llm.example.test/v1/chat/completions");
      expect(init?.headers).toEqual(
        expect.objectContaining({ Authorization: `Bearer ${provider.apiKey}` })
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true });
      return completionResponse("这是回答", "这是推理过程");
    });
    const result = await chatComplete(provider, { ...spec, thinking: true }, [{ role: "user", content: "你好" }], {
      ...runtime,
      fetch: fetchMock
    });
    expect(result.content).toBe("这是回答");
    expect(result.reasoning).toBe("这是推理过程");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("SSE receipt 区分 DONE 完整终止与仅 stop 后 EOF 的兼容响应", async () => {
    const complete = await chatCompleteWithReceipt(provider, spec, [], {
      ...runtime,
      fetch: vi.fn(async () => new Response(stoppedSsePrefix(), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      }))
    });
    expect(complete.receipt).toMatchObject({
      schemaVersion: 2,
      responseMode: "sse",
      eofVerified: true,
      finishReasonStopVerified: true,
      sseDoneObserved: true
    });

    const compatibleOnly = await chatCompleteWithReceipt(provider, spec, [], {
      ...runtime,
      fetch: vi.fn(async () => new Response(
        'data: {"choices":[{"delta":{"content":"完整答案"},"finish_reason":"stop"}]}\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    });
    expect(compatibleOnly.receipt.sseDoneObserved).toBe(false);
  });

  it("499 失败通过不可枚举安全审计保留尝试数，不保存服务商正文", async () => {
    const privateBody = "PRIVATE_PROVIDER_BODY_SENTINEL";
    let caught: unknown;
    try {
      await chatCompleteWithReceipt(provider, spec, [], {
        ...runtime,
        fetch: vi.fn(async () => new Response(privateBody, { status: 499 }))
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "LLM_HTTP_ERROR", status: 499 });
    expect(getLlmFailureAudit(caught)).toEqual({
      schemaVersion: 1,
      requestCount: 1,
      transportAttemptCount: 1,
      providerRequestCount: 1,
      retryCount: 0,
      maxOutputTokens: null,
      responseByteCount: 0,
      usageTotalTokens: null,
      usageComplete: false,
      completedResponses: [],
      terminal: {
        status: 499,
        responseMode: null,
        eofObserved: false,
        finishReason: null,
        finishReasonStopObserved: false,
        sseDoneObserved: null
      },
      stream: {
        eventCount: 0,
        utf8Bytes: 0,
        chunkCount: 0,
        usageEventCount: 0,
        usageTotalTokens: null,
        acceptedEventShapes: [],
        firstRejectedEvent: null
      },
      jsonSchemaValidated: null
    });
    expect(JSON.stringify(caught)).not.toContain(privateBody);
  });
  it("audit-chain RED: output_limit keeps exact content-free terminal accounting", async () => {
    const privateOutput = "PRIVATE_OUTPUT_LIMIT_SENTINEL";
    const event = JSON.stringify({
      choices: [{
        delta: { content: privateOutput },
        finish_reason: "length"
      }],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 4,
        total_tokens: 7
      }
    });
    const body = `data: ${event}\n\n`;
    let caught: unknown;
    try {
      await chatCompleteWithReceipt(provider, spec, [], {
        ...runtime,
        fetch: vi.fn(async () => new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        }))
      }, { maxOutputTokens: 2_048 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "LLM_OUTPUT_LENGTH_LIMIT" });
    expect(getLlmFailureAudit(caught)).toMatchObject({
      maxOutputTokens: null,
      providerRequestCount: 1,
      retryCount: 0,
      responseByteCount: new TextEncoder().encode(body).byteLength,
      usageTotalTokens: 7,
      usageComplete: true,
      terminal: {
        status: 200,
        responseMode: "sse",
        eofObserved: true,
        finishReason: "length",
        finishReasonStopObserved: false,
        sseDoneObserved: false
      }
    });
    expect(JSON.stringify(getLlmFailureAudit(caught))).not.toContain(privateOutput);
  });

  it("audit-chain RED: protocol failure keeps bytes and closed stage without response text", async () => {
    const privateOutput = "PRIVATE_PROTOCOL_RESPONSE_SENTINEL";
    let caught: unknown;
    try {
      await chatCompleteWithReceipt(provider, spec, [], {
        ...runtime,
        fetch: vi.fn(async () => new Response(privateOutput, {
          status: 200,
          headers: { "Content-Type": "text/plain" }
        }))
      }, { maxOutputTokens: 4_096 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "LLM_RESPONSE_FORMAT_INVALID",
      formatFailureStage: "content_type"
    });
    expect(getLlmFailureAudit(caught)).toMatchObject({
      maxOutputTokens: null,
      providerRequestCount: 1,
      retryCount: 0,
      responseByteCount: new TextEncoder().encode(privateOutput).byteLength,
      usageTotalTokens: null,
      usageComplete: false,
      terminal: {
        status: 200,
        responseMode: "json",
        eofObserved: true,
        finishReason: null,
        finishReasonStopObserved: false,
        sseDoneObserved: null
      }
    });
    expect(JSON.stringify(getLlmFailureAudit(caught))).not.toContain(privateOutput);
  });

  it("请求前已取消时 fetch=0 且 HTTP 尝试数也必须为 0", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(async () => completionResponse("不应调用"));
    let caught: unknown;
    try {
      await chatCompleteWithReceipt(provider, spec, [], {
        ...runtime,
        signal: controller.signal,
        fetch: fetchMock
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "LLM_CANCELLED" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getLlmFailureAudit(caught)?.transportAttemptCount).toBe(0);
  });

  it("首个 429 后在退避期取消，不会把未发出的第二次请求计入尝试数", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      setTimeout(() => controller.abort(), 0);
      return new Response(null, { status: 429 });
    });
    let caught: unknown;
    try {
      await chatCompleteWithReceipt(provider, spec, [], {
        ...runtime,
        baseDelayMs: 1_000,
        signal: controller.signal,
        fetch: fetchMock
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "LLM_CANCELLED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getLlmFailureAudit(caught)?.transportAttemptCount).toBe(1);
  });

  it("没有 reasoning_content 时 reasoning 为 null", async () => {
    const fetchMock = vi.fn(async () => completionResponse("答案"));
    const result = await chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock });
    expect(result.reasoning).toBeNull();
  });

  it("thinking 为 false 时不保留服务商额外返回的思考过程", async () => {
    const fetchMock = vi.fn(
      async () => completionResponse("答案", "不应被下游使用的思考过程")
    );
    const result = await chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    });
    expect(result).toEqual({ content: "答案", reasoning: null });
  });

  it("thinkingRequest 精确构造请求，且与是否保留推理文本解耦", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return completionResponse("答案", "推理过程");
    });

    const retained = await chatComplete(
      provider,
      {
        ...spec,
        provider: "aether",
        model: "deepseek-v4-flash",
        thinking: true,
        thinkingRequest: "enabled",
        reasoningEffort: "max"
      },
      [],
      { ...runtime, fetch: fetchMock }
    );
    const discarded = await chatComplete(
      provider,
      {
        ...spec,
        provider: "aether",
        model: "deepseek-v4-flash",
        thinking: false,
        thinkingRequest: "enabled",
        reasoningEffort: "max"
      },
      [],
      { ...runtime, fetch: fetchMock }
    );
    await chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock });

    expect(requestBodies[0]).toEqual({
      model: "deepseek-v4-flash",
      temperature: 0.2,
      stream: true,
      messages: [],
      thinking: { type: "enabled" },
      reasoning_effort: "max"
    });
    expect(requestBodies[1]).toEqual(requestBodies[0]);
    expect(requestBodies[2]).toEqual({
      model: "test-model",
      temperature: 0.2,
      stream: true,
      messages: []
    });
    expect(retained.reasoning).toBe("推理过程");
    expect(discarded.reasoning).toBeNull();
  });

  it.each([
    [
      "V4 flash 缺少 thinkingRequest",
      { ...spec, provider: "aether", model: "deepseek-v4-flash", reasoningEffort: "max" }
    ],
    [
      "V4 flash 缺少 reasoningEffort",
      { ...spec, provider: "aether", model: "deepseek-v4-flash", thinkingRequest: "enabled" }
    ],
    [
      "V4 flash 使用 disabled",
      { ...spec, provider: "aether", model: "deepseek-v4-flash", thinkingRequest: "disabled" }
    ],
    [
      "V4 flash enabled 但使用已废弃的 low effort",
      { ...spec, provider: "aether", model: "deepseek-v4-flash", thinkingRequest: "enabled", reasoningEffort: "low" as unknown as "max" }
    ],
    [
      "V4 pro 缺少 thinkingRequest",
      { ...spec, provider: "aether", model: "deepseek-v4-pro", reasoningEffort: "max" }
    ],
    [
      "V4 pro 缺少 reasoningEffort",
      { ...spec, provider: "aether", model: "deepseek-v4-pro", thinkingRequest: "enabled" }
    ],
    [
      "V4 pro 使用 disabled",
      { ...spec, provider: "aether", model: "deepseek-v4-pro", thinkingRequest: "disabled" }
    ],
    [
      "V4 pro enabled 但使用已废弃的 low effort",
      { ...spec, provider: "aether", model: "deepseek-v4-pro", thinkingRequest: "enabled", reasoningEffort: "low" as unknown as "max" }
    ],
    [
      "其它 provider",
      {
        ...spec,
        provider: "dashscope",
        model: "deepseek-v4-flash",
        thinkingRequest: "enabled",
        reasoningEffort: "max"
      }
    ],
    [
      "其它 model",
      {
        ...spec,
        provider: "aether",
        model: "other-model",
        thinkingRequest: "enabled",
        reasoningEffort: "max"
      }
    ],
    [
      "非 V4 携带 thinkingRequest",
      { ...spec, provider: "dashscope", model: "qwen-max", thinkingRequest: "disabled" }
    ],
    [
      "非 V4 携带 reasoningEffort",
      { ...spec, provider: "dashscope", model: "qwen-max", reasoningEffort: "max" }
    ],
    ["未支持的请求模式", { ...spec, thinkingRequest: "automatic" }]
  ])("无效推理组合在请求前被拒绝：%s", async (_name, invalidSpec) => {
    const fetchMock = vi.fn(async () => completionResponse("不应请求"));
    await expect(
      chatComplete(
        provider,
        invalidSpec as unknown as ModelCallSpec,
        [],
        { ...runtime, fetch: fetchMock }
      )
    ).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requestJson 时请求体带 response_format", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.response_format).toEqual({ type: "json_object" });
      return completionResponse('{"ok":true}');
    });
    await chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock }, { requestJson: true });
  });

  it("legacy output token options never enter outbound request", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return completionResponse("答案");
    });

    await chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock }, { maxOutputTokens: 2_048 });
    await chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock });

    for (const body of requestBodies) {
      expect(body).not.toHaveProperty("max_tokens");
      expect(body).not.toHaveProperty("max_output_tokens");
      expect(body).not.toHaveProperty("maxOutputTokens");
    }
  });


  it("provider hard-cap metadata remains stable while requests omit output caps", async () => {
    expect(maximumExplicitLlmOutputTokens).toBe(384_000);
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return completionResponse("答案");
    });
    await chatComplete(
      provider,
      spec,
      [],
      { ...runtime, fetch: fetchMock },
      { maxOutputTokens: maximumExplicitLlmOutputTokens }
    );
    expect(requestBodies[0]).not.toHaveProperty("max_tokens");
    expect(requestBodies[0]).not.toHaveProperty("max_output_tokens");
    expect(requestBodies[0]).not.toHaveProperty("maxOutputTokens");
  });

  it("逐段读取 SSE，并正确拼接跨字节块的推理和最终答案", async () => {
    const encoded = new TextEncoder().encode(
      [
        'data: {"choices":[{"delta":{"reasoning_content":"先推理"}}]}',
        "",
        'data: {"choices":[{"delta":{"reasoning_content":"，再确认","content":"最终"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":"答案"},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        ""
      ].join("\r\n")
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of encoded) {
          controller.enqueue(Uint8Array.of(byte));
        }
        controller.close();
      }
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream; charset=utf-8" }
        })
    );

    await expect(
      chatComplete(provider, { ...spec, thinking: true }, [], { ...runtime, fetch: fetchMock })
    ).resolves.toEqual({
      content: "最终答案",
      reasoning: "先推理，再确认"
    });
  });

  it("收到 stop 和 DONE 后继续读到 HTTP 正常结尾，且不主动取消响应体", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"已经完成"},"finish_reason":"stop"}]}\n\n' +
              "data: [DONE]\n\n"
          )
        );
      },
      cancel() {
        cancelled = true;
      }
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        })
    );

    let settled = false;
    const resultPromise = chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    }).then((result) => {
      settled = true;
      return result;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(cancelled).toBe(false);
    streamController.close();
    await expect(resultPromise).resolves.toEqual({
      content: "已经完成",
      reasoning: null
    });
    expect(cancelled).toBe(false);
  });

  it("finish_reason=stop 后继续等待 DONE，不把网关仍在收尾误记成取消", async () => {
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"完整答案"},"finish_reason":"stop"}]}\n\n'
          )
        );
      }
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        })
    );
    let settled = false;
    const resultPromise = chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    }).then((result) => {
      settled = true;
      return result;
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
    streamController.close();

    await expect(resultPromise).resolves.toEqual({
      content: "完整答案",
      reasoning: null
    });
  });

  it("finish_reason=stop 后若尾部报告错误，拒绝使用前半段答案", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"不能直接采用"},"finish_reason":"stop"}]}',
            "",
            'data: {"choices":[],"error":{"message":"不应泄露的尾部错误"}}',
            "",
            "data: [DONE]",
            ""
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        )
    );

    await expect(
      chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock })
    ).rejects.toMatchObject({ code: "LLM_RESPONSE_FORMAT_INVALID" });
  });

  it("finish_reason=stop 后正常到达 HTTP 结尾时接受完整答案", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"完整答案"},"finish_reason":"stop"}]}\n\n',
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        )
    );

    await expect(
      chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock })
    ).resolves.toEqual({ content: "完整答案", reasoning: null });
  });

  it("DONE 前的严格用量事件保持原有兼容行为", async () => {
    const answer = JSON.stringify({
      choices: [{ delta: { content: "完整答案" }, finish_reason: "stop" }]
    });
    const fetchMock = vi.fn(async () => new Response([
      `data: ${answer}`,
      "",
      `data: ${JSON.stringify(strictUsageMetadataEvent())}`,
      "",
      "data: [DONE]",
      "",
      ""
    ].join("\n"), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    }));

    await expect(chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    })).resolves.toEqual({ content: "完整答案", reasoning: null });
  });

  it("正文和 DONE 到达 HTTP 结尾但没有 stop 时固定失败且不重试或泄漏正文", async () => {
    const sensitiveContent = "不应进入异常的无终止正文";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          [
            `data: ${JSON.stringify({
              choices: [{ delta: { content: sensitiveContent } }]
            })}`,
            "",
            "data: [DONE]",
            ""
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        )
    );
    const error = await chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "LLM_STREAM_INTERRUPTED" });
    expect((error as Error).message).not.toContain(sensitiveContent);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      substage: "data_after_done_benign_controls_only",
      invalidEvents: ["data: [DONE]", "", "data: [DONE]", "", ""].join("\n")
    },
    {
      substage: "data_after_done_unknown_object_or_scan_limit",
      invalidEvents: [
        "data: [DONE]",
        "",
        'data: {"private_provider_payload":"不应泄露"}',
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
    "严格拒绝并安全排空终止序列异常：$substage",
    async ({ substage, invalidEvents }) => {
      const encoder = new TextEncoder();
      const sensitiveTail = "不应进入错误或分类的尾部原文";
      let cancelled = false;
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        cancel() {
          cancelled = true;
        }
      });
      const fetchMock = vi.fn(async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      }));
      let settled = false;
      const resultPromise = chatComplete(provider, spec, [], {
        ...runtime,
        fetch: fetchMock
      });
      void resultPromise.finally(() => {
        settled = true;
      }).catch(() => undefined);

      streamController.enqueue(encoder.encode([
        'data: {"choices":[{"delta":{"content":"前半段"},"finish_reason":"stop"}]}',
        "",
        invalidEvents
      ].join("\n")));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(cancelled).toBe(false);

      streamController.enqueue(encoder.encode(sensitiveTail));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(cancelled).toBe(false);
      streamController.close();

      const error = await resultPromise.catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: "LLM_RESPONSE_FORMAT_INVALID",
        formatFailureStage: "trailing_data",
        formatFailureSubstage: substage
      });
      expect((error as Error).message).not.toContain(sensitiveTail);
      expect((error as Error).message).not.toContain("private_provider_payload");
      expect(cancelled).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it("网关在 stop 之后发送空 delta 事件（重复 stop 或带 usage 的空 choice）应被接受", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // 1) 正常 stop 事件（含内容）
        controller.enqueue(encoder.encode([
          'data: {"choices":[{"delta":{"content":"合成完整答案"},"finish_reason":"stop"}]}',
          "",
          ""
        ].join("\n")));
        // 2) post-stop：重复 stop 信号，空 delta
        controller.enqueue(encoder.encode([
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          "",
          ""
        ].join("\n")));
        // 3) post-stop：带 usage 的空 choice（无 finish_reason）
        controller.enqueue(encoder.encode([
          'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}',
          "",
          ""
        ].join("\n")));
        // 4) DONE
        controller.enqueue(encoder.encode([
          "data: [DONE]",
          "",
          ""
        ].join("\n")));
        controller.close();
      }
    });
    const fetchMock = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    }));
    const result = await chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    });
    expect(result.content).toBe("合成完整答案");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "strict usage metadata",
      tailData: JSON.stringify(strictUsageMetadataEvent()),
      expectedSubstage: "data_after_done_benign_controls_only"
    },
    {
      name: "empty choices is metadata evidence",
      tailData: JSON.stringify({ choices: [] }),
      expectedSubstage: "data_after_done_benign_controls_only"
    },
    {
      name: "bounded usage counters are metadata evidence",
      tailData: JSON.stringify({ usage: { total_tokens: 7 } }),
      expectedSubstage: "data_after_done_benign_controls_only"
    },
    {
      name: "nullable usage detail needs a real numeric counter",
      tailData: JSON.stringify({
        usage: { total_tokens: 7, completion_tokens_details: null }
      }),
      expectedSubstage: "data_after_done_benign_controls_only"
    },
    {
      name: "nested nullable usage detail can accompany a real numeric counter",
      tailData: JSON.stringify({
        usage: {
          total_tokens: 7,
          completion_tokens_details: { reasoning_tokens: null }
        }
      }),
      expectedSubstage: "data_after_done_benign_controls_only"
    },
    {
      name: "bounded standard id is metadata evidence",
      tailData: JSON.stringify({ id: "synthetic-completion-id" }),
      expectedSubstage: "data_after_done_benign_controls_only"
    },
    {
      name: "non-empty choices without output fields",
      tailData: JSON.stringify({ choices: [{ index: 0 }] }),
      expectedSubstage: "data_after_done_choices_present"
    },
    {
      name: "content outside choices",
      tailData: JSON.stringify({ choices: [], content: "合成尾部正文" }),
      expectedSubstage: "data_after_done_content_or_tool_present"
    },
    {
      name: "reasoning key is dangerous even with null value",
      tailData: JSON.stringify({ choices: [], reasoning: null }),
      expectedSubstage: "data_after_done_content_or_tool_present"
    },
    {
      name: "delta key is dangerous even when empty",
      tailData: JSON.stringify({ choices: [], delta: {} }),
      expectedSubstage: "data_after_done_content_or_tool_present"
    },
    {
      name: "message key is dangerous even when empty",
      tailData: JSON.stringify({ choices: [], message: {} }),
      expectedSubstage: "data_after_done_content_or_tool_present"
    },
    {
      name: "function key is dangerous even when empty",
      tailData: JSON.stringify({ choices: [], function: {} }),
      expectedSubstage: "data_after_done_content_or_tool_present"
    },
    {
      name: "nested tool call",
      tailData: JSON.stringify({
        choices: [{ delta: { tool_calls: [{ function: { arguments: "{}" } }] } }]
      }),
      expectedSubstage: "data_after_done_content_or_tool_present"
    },
    {
      name: "unknown top-level field",
      tailData: JSON.stringify({ choices: [], provider_payload: "合成未知值" }),
      expectedSubstage: "data_after_done_unknown_object_or_scan_limit"
    },
    {
      name: "empty object has no metadata evidence",
      tailData: JSON.stringify({}),
      expectedSubstage: "data_after_done_unknown_object_or_scan_limit"
    },
    {
      name: "null and blank standard fields have no metadata evidence",
      tailData: JSON.stringify({
        id: "   ",
        system_fingerprint: null,
        service_tier: null
      }),
      expectedSubstage: "data_after_done_unknown_object_or_scan_limit"
    },
    {
      name: "all-null optional fields have no metadata evidence",
      tailData: JSON.stringify({
        system_fingerprint: null,
        service_tier: null
      }),
      expectedSubstage: "data_after_done_unknown_object_or_scan_limit"
    },
    {
      name: "all-null usage has no numeric metadata evidence",
      tailData: JSON.stringify({
        usage: { total_tokens: null, completion_tokens_details: null }
      }),
      expectedSubstage: "data_after_done_unknown_object_or_scan_limit"
    },
    {
      name: "nested all-null usage still has no numeric metadata evidence",
      tailData: JSON.stringify({
        usage: {
          completion_tokens_details: { reasoning_tokens: null }
        }
      }),
      expectedSubstage: "data_after_done_unknown_object_or_scan_limit"
    },
    {
      name: "scalar usage is not the strict usage object",
      tailData: JSON.stringify({ usage: 7 }),
      expectedSubstage: "data_after_done_unknown_object_or_scan_limit"
    },
    {
      name: "unknown null field is not metadata evidence",
      tailData: JSON.stringify({ provider_payload: null }),
      expectedSubstage: "data_after_done_unknown_object_or_scan_limit"
    },
    {
      name: "provider error object",
      tailData: JSON.stringify({ error: { code: "synthetic_error" } }),
      expectedSubstage: "data_after_done_error_object"
    },
    {
      name: "standard message inside a top-level error remains an error envelope",
      tailData: JSON.stringify({ error: { message: "合成错误正文" } }),
      expectedSubstage: "data_after_done_error_object"
    },
    {
      name: "content sibling outside an error object still uses dangerous priority",
      tailData: JSON.stringify({
        error: { message: "合成错误说明" },
        content: "合成尾部正文"
      }),
      expectedSubstage: "data_after_done_content_or_tool_present"
    },
    {
      name: "content inside a malformed top-level array uses dangerous priority",
      tailData: JSON.stringify([{ content: "合成尾部正文" }]),
      expectedSubstage: "data_after_done_content_or_tool_present"
    },
    {
      name: "content sibling outranks malformed choices regardless of DFS order",
      tailData: JSON.stringify([
        { content: "合成尾部正文" },
        { choices: 1 }
      ]),
      expectedSubstage: "data_after_done_content_or_tool_present"
    },
    {
      name: "malformed JSON",
      tailData: "{not-json}",
      expectedSubstage: "data_after_done_json_syntax_invalid"
    },
    {
      name: "valid JSON scalar is not an event object",
      tailData: "7",
      expectedSubstage: "data_after_done_json_non_object"
    },
    {
      name: "valid JSON array without dangerous fields is not an event object",
      tailData: "[]",
      expectedSubstage: "data_after_done_json_non_object"
    },
    {
      name: "usage counter exceeds depth bound",
      tailData: JSON.stringify({
        choices: [],
        usage: { a: { b: { c: { d: { e: 1 } } } } }
      }),
      expectedSubstage: "data_after_done_unknown_object_or_scan_limit"
    },
    {
      name: "usage contains a negative counter",
      tailData: JSON.stringify({ choices: [], usage: { total_tokens: -1 } }),
      expectedSubstage: "data_after_done_unknown_object_or_scan_limit"
    },
    {
      name: "usage key is outside the fixed grammar",
      tailData: JSON.stringify({ choices: [], usage: { "total-tokens": 7 } }),
      expectedSubstage: "data_after_done_unknown_object_or_scan_limit"
    },
    {
      name: "usage counter is not a safe integer",
      tailData: JSON.stringify({
        choices: [],
        usage: { total_tokens: Number.MAX_SAFE_INTEGER + 1 }
      }),
      expectedSubstage: "data_after_done_unknown_object_or_scan_limit"
    },
    {
      name: "usage exceeds bounded key count",
      tailData: JSON.stringify({
        choices: [],
        usage: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`counter_${index}`, index])
        )
      }),
      expectedSubstage: "data_after_done_unknown_object_or_scan_limit"
    },
    {
      name: "non-empty choices outrank an oversized sibling-key set",
      tailData: JSON.stringify({
        ...Object.fromEntries(
          Array.from({ length: 260 }, (_, index) => [`filler_${index}`, index])
        ),
        choices: [{ index: 0 }]
      }),
      expectedSubstage: "data_after_done_choices_present"
    },
    {
      name: "metadata string exceeds the length bound",
      tailData: JSON.stringify({ id: "x".repeat(1_025) }),
      expectedSubstage: "data_after_done_unknown_object_or_scan_limit"
    },
    {
      name: "metadata string contains a control character",
      tailData: JSON.stringify({ id: "synthetic\nidentifier" }),
      expectedSubstage: "data_after_done_unknown_object_or_scan_limit"
    },
    {
      name: "created timestamp is negative",
      tailData: JSON.stringify({ created: -1 }),
      expectedSubstage: "data_after_done_unknown_object_or_scan_limit"
    }
  ] as const)(
    "DONE 后形状只输出封闭分类且仍严格失败：$name",
    async ({ tailData, expectedSubstage }) => {
      const marker = "合成尾部正文";
      const fetchMock = vi.fn(async () => new Response(
        stoppedSsePrefix() + sseDataEvent(tailData),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ));
      const error = await chatComplete(provider, spec, [], {
        ...runtime,
        fetch: fetchMock
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: "LLM_RESPONSE_FORMAT_INVALID",
        formatFailureStage: "trailing_data",
        formatFailureSubstage: expectedSubstage
      });
      expect((error as Error).message).not.toContain(marker);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    { name: "empty value", rawTail: "data:\n\n" },
    { name: "whitespace value", rawTail: "data:    \n\n" },
    { name: "field without colon", rawTail: "data\n\n" },
    { name: "multiple empty lines", rawTail: "data:\ndata:   \n\n" }
  ] as const)(
    "DONE 后空 data 字段到达 EOF 仍固定失败：$name",
    async ({ rawTail }) => {
      const fetchMock = vi.fn(async () => new Response(
        stoppedSsePrefix() + rawTail,
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ));
      await expect(chatComplete(provider, spec, [], {
        ...runtime,
        fetch: fetchMock
      })).rejects.toMatchObject({
        code: "LLM_RESPONSE_FORMAT_INVALID",
        formatFailureStage: "trailing_data",
        formatFailureSubstage: "data_after_done_benign_controls_only"
      });
    }
  );

  it.each([
    {
      mode: "stream_interrupted",
      expectedCode: "LLM_STREAM_INTERRUPTED",
      expectedCancelled: false
    },
    {
      mode: "cancelled",
      expectedCode: "LLM_CANCELLED",
      expectedCancelled: true
    }
  ] as const)(
    "DONE 后完整空 data 事件在 $mode 时保留固定危险分类",
    async ({ mode, expectedCode, expectedCancelled }) => {
      const encoder = new TextEncoder();
      const taskController = new AbortController();
      let cancelled = false;
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        cancel() {
          cancelled = true;
        }
      });
      const fetchMock = vi.fn(async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      }));
      const resultPromise = chatComplete(provider, spec, [], {
        ...runtime,
        signal: taskController.signal,
        fetch: fetchMock
      });
      streamController.enqueue(encoder.encode(
        stoppedSsePrefix() + "data:\n\n"
      ));
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (mode === "stream_interrupted") {
        streamController.error(new Error("合成空尾部传输中断"));
      } else {
        taskController.abort();
      }
      const error = await resultPromise.catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: expectedCode,
        formatFailureStage: "trailing_data",
        formatFailureSubstage: "data_after_done_tail_incomplete"
      });
      expect((error as Error).message).not.toContain("合成空尾部传输中断");
      expect(cancelled).toBe(expectedCancelled);
    }
  );

  it.each([
    {
      mode: "stream_interrupted",
      expectedCode: "LLM_STREAM_INTERRUPTED",
      expectedCancelled: false
    },
    {
      mode: "cancelled",
      expectedCode: "LLM_CANCELLED",
      expectedCancelled: true
    }
  ] as const)(
    "DONE 后尚未分派的空 data 字段在 $mode 时只能报告 tail-incomplete",
    async ({ mode, expectedCode, expectedCancelled }) => {
      const encoder = new TextEncoder();
      const taskController = new AbortController();
      let cancelled = false;
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        cancel() {
          cancelled = true;
        }
      });
      const fetchMock = vi.fn(async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      }));
      const resultPromise = chatComplete(provider, spec, [], {
        ...runtime,
        signal: taskController.signal,
        fetch: fetchMock
      });
      streamController.enqueue(encoder.encode(
        stoppedSsePrefix() + "data:"
      ));
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (mode === "stream_interrupted") {
        streamController.error(new Error("合成未收齐空尾部传输中断"));
      } else {
        taskController.abort();
      }
      const error = await resultPromise.catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: expectedCode,
        formatFailureStage: "trailing_data",
        formatFailureSubstage: "data_after_done_tail_incomplete"
      });
      expect((error as Error).message).not.toContain("合成未收齐空尾部传输中断");
      expect(cancelled).toBe(expectedCancelled);
    }
  );

  it("高度分片的 DONE 后长事件只增量扫描并保持固定失败", async () => {
    const encoder = new TextEncoder();
    const marker = "x".repeat(32_768);
    const tail = encoder.encode(
      sseDataEvent(JSON.stringify({ provider_payload: marker }))
    );
    let offset = -1;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < 0) {
          controller.enqueue(encoder.encode(stoppedSsePrefix()));
          offset = 0;
        } else if (offset < tail.length) {
          controller.enqueue(tail.slice(offset, offset + 1));
          offset += 1;
        } else {
          controller.close();
        }
      }
    });
    const fetchMock = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    }));
    const error = await chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "LLM_RESPONSE_FORMAT_INVALID",
      formatFailureStage: "trailing_data",
      formatFailureSubstage: "data_after_done_unknown_object_or_scan_limit"
    });
    expect((error as Error).message).not.toContain(marker);
  });

  it("响应分块数量上限阻止微小分块无限饿死超时定时器", async () => {
    const encoder = new TextEncoder();
    const tail = encoder.encode(`data: ${"x".repeat(70_000)}`);
    let offset = -1;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < 0) {
          controller.enqueue(encoder.encode(stoppedSsePrefix()));
          offset = 0;
        } else if (offset < tail.length) {
          controller.enqueue(tail.slice(offset, offset + 1));
          offset += 1;
        } else {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      }
    });
    const fetchMock = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    }));
    await expect(chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    })).rejects.toMatchObject({
      code: "LLM_RESPONSE_FORMAT_INVALID",
      formatFailureStage: "trailing_data",
      formatFailureSubstage: "data_after_done_tail_incomplete"
    });
    expect(cancelled).toBe(true);
  });

  it("跨块的 database 等未知 SSE 字段不会误判为空 data", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(stoppedSsePrefix() + "dat"));
        controller.enqueue(encoder.encode("abase: synthetic-ignored\n\n"));
        controller.close();
      }
    });
    const fetchMock = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    }));
    await expect(chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    })).resolves.toMatchObject({
      content: "合成完整答案"
    });
  });

  it("只有整个 DONE 后尾部都是严格元数据且到达 EOF 才归为 metadata-only", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        cancelled = true;
      }
    });
    const fetchMock = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    }));
    let settled = false;
    const resultPromise = chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    });
    void resultPromise.finally(() => {
      settled = true;
    }).catch(() => undefined);
    streamController.enqueue(encoder.encode(
      stoppedSsePrefix() +
        sseDataEvent(JSON.stringify(strictUsageMetadataEvent()))
    ));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(cancelled).toBe(false);

    streamController.close();
    await expect(resultPromise).rejects.toMatchObject({
      code: "LLM_RESPONSE_FORMAT_INVALID",
      formatFailureStage: "trailing_data",
      formatFailureSubstage: "data_after_done_benign_controls_only"
    });
    expect(cancelled).toBe(false);
  });

  it.each([
    {
      name: "multiple metadata events stay metadata-only",
      tailEvents: [
        JSON.stringify(strictUsageMetadataEvent()),
        JSON.stringify({ choices: [], usage: { total_tokens: 7 } })
      ],
      expectedSubstage: "data_after_done_benign_controls_only"
    },
    {
      name: "usage followed by choices upgrades to choices",
      tailEvents: [
        JSON.stringify(strictUsageMetadataEvent()),
        JSON.stringify({ choices: [{ index: 0 }] })
      ],
      expectedSubstage: "data_after_done_choices_present"
    },
    {
      name: "usage followed by content upgrades to content",
      tailEvents: [
        JSON.stringify(strictUsageMetadataEvent()),
        JSON.stringify({ choices: [], content: "合成危险尾部" })
      ],
      expectedSubstage: "data_after_done_content_or_tool_present"
    },
    {
      name: "unknown followed by tool data uses dangerous priority",
      tailEvents: [
        JSON.stringify({ provider_payload: true }),
        JSON.stringify({ choices: [], function_call: { arguments: "{}" } })
      ],
      expectedSubstage: "data_after_done_content_or_tool_present"
    },
    {
      name: "malformed event followed by content still uses dangerous priority",
      tailEvents: [
        "{not-json}",
        JSON.stringify({ choices: [], content: "合成危险尾部" })
      ],
      expectedSubstage: "data_after_done_content_or_tool_present"
    },
    {
      name: "metadata followed by malformed event is not metadata-only",
      tailEvents: [
        JSON.stringify(strictUsageMetadataEvent()),
        "{not-json}"
      ],
      expectedSubstage: "data_after_done_json_syntax_invalid"
    },
    {
      name: "choices followed by content uses content priority",
      tailEvents: [
        JSON.stringify({ choices: [{ index: 0 }] }),
        JSON.stringify({ choices: [], reasoning_content: "合成推理尾部" })
      ],
      expectedSubstage: "data_after_done_content_or_tool_present"
    },
    {
      name: "empty data, duplicate DONE and metadata remain one benign class",
      tailEvents: [
        "",
        "[DONE]",
        JSON.stringify(strictUsageMetadataEvent()),
        ""
      ],
      expectedSubstage: "data_after_done_benign_controls_only"
    },
    {
      name: "valid scalar outranks malformed JSON",
      tailEvents: ["{not-json}", "7"],
      expectedSubstage: "data_after_done_json_non_object"
    },
    {
      name: "error object outranks valid scalar",
      tailEvents: ["7", JSON.stringify({ error: { code: "synthetic" } })],
      expectedSubstage: "data_after_done_error_object"
    },
    {
      name: "unknown object outranks error object",
      tailEvents: [
        JSON.stringify({ error: { code: "synthetic" } }),
        JSON.stringify({ provider_payload: true })
      ],
      expectedSubstage: "data_after_done_unknown_object_or_scan_limit"
    },
    {
      name: "choices outrank unknown object",
      tailEvents: [
        JSON.stringify({ provider_payload: true }),
        JSON.stringify({ choices: [{ index: 0 }] })
      ],
      expectedSubstage: "data_after_done_choices_present"
    }
  ] as const)(
    "聚合整个 DONE 后尾部并让危险类别优先：$name",
    async ({ tailEvents, expectedSubstage }) => {
      const bodyText = stoppedSsePrefix() +
        tailEvents.map((event) => sseDataEvent(event)).join("");
      const fetchMock = vi.fn(async () => new Response(bodyText, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      }));
      await expect(chatComplete(provider, spec, [], {
        ...runtime,
        fetch: fetchMock
      })).rejects.toMatchObject({
        code: "LLM_RESPONSE_FORMAT_INVALID",
        formatFailureStage: "trailing_data",
        formatFailureSubstage: expectedSubstage
      });
    }
  );

  it("逐字节跨块和 CRLF 不改变完整元数据尾部分类", async () => {
    const encoded = new TextEncoder().encode(
      stoppedSsePrefix("\r\n") +
        sseDataEvent(JSON.stringify(strictUsageMetadataEvent()), "\r\n")
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      }
    });
    const fetchMock = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" }
    }));
    await expect(chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    })).rejects.toMatchObject({
      code: "LLM_RESPONSE_FORMAT_INVALID",
      formatFailureStage: "trailing_data",
      formatFailureSubstage: "data_after_done_benign_controls_only"
    });
  });

  it.each([
    {
      mode: "stream_interrupted",
      expectedCode: "LLM_STREAM_INTERRUPTED",
      expectedCancelled: false
    },
    {
      mode: "cancelled",
      expectedCode: "LLM_CANCELLED",
      expectedCancelled: true
    }
  ] as const)(
    "metadata-only 暂态在 EOF 前 $mode 时只能报告 tail-incomplete",
    async ({ mode, expectedCode, expectedCancelled }) => {
      const encoder = new TextEncoder();
      const taskController = new AbortController();
      let cancelled = false;
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        cancel() {
          cancelled = true;
        }
      });
      const fetchMock = vi.fn(async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      }));
      const resultPromise = chatComplete(provider, spec, [], {
        ...runtime,
        signal: taskController.signal,
        fetch: fetchMock
      });
      streamController.enqueue(encoder.encode(
        stoppedSsePrefix() +
          sseDataEvent(JSON.stringify(strictUsageMetadataEvent()))
      ));
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (mode === "stream_interrupted") {
        streamController.error(new Error("合成传输中断原文"));
      } else {
        taskController.abort();
      }
      const error = await resultPromise.catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: expectedCode,
        formatFailureStage: "trailing_data",
        formatFailureSubstage: "data_after_done_tail_incomplete"
      });
      expect((error as Error).message).not.toContain("合成传输中断原文");
      expect(cancelled).toBe(expectedCancelled);
    }
  );

  it("DONE 后元数据事件尚未收齐就取消时也只报 tail-incomplete", async () => {
    const encoder = new TextEncoder();
    const taskController = new AbortController();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        }
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    ));
    const resultPromise = chatComplete(provider, spec, [], {
      ...runtime,
      signal: taskController.signal,
      fetch: fetchMock
    });
    streamController.enqueue(encoder.encode(
      stoppedSsePrefix() +
        'data: {"choices":[],"usage":{"total_tokens":'
    ));
    await new Promise<void>((resolve) => setImmediate(resolve));
    taskController.abort();

    await expect(resultPromise).rejects.toMatchObject({
      code: "LLM_CANCELLED",
      formatFailureStage: "trailing_data",
      formatFailureSubstage: "data_after_done_tail_incomplete"
    });
  });

  it("DONE 后最后一个元数据事件可以由真实 EOF 收口", async () => {
    const fetchMock = vi.fn(async () => new Response(
      stoppedSsePrefix() +
        `data: ${JSON.stringify({ choices: [], usage: { total_tokens: 7 } })}`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    ));

    await expect(chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    })).rejects.toMatchObject({
      code: "LLM_RESPONSE_FORMAT_INVALID",
      formatFailureStage: "trailing_data",
      formatFailureSubstage: "data_after_done_benign_controls_only"
    });
  });

  it("metadata-only 暂态的连续停顿只报告 tail-incomplete", async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      let cancelled = false;
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        cancel() {
          cancelled = true;
        }
      });
      const fetchMock = vi.fn(async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      }));
      const resultPromise = chatComplete(provider, spec, [], {
        firstOutputTimeoutMs: 1_000,
        outputIdleTimeoutMs: 1_000,
        maximumDurationMs: 5_000,
        maxAttempts: 1,
        baseDelayMs: 1,
        fetch: fetchMock
      });
      await vi.advanceTimersByTimeAsync(0);
      streamController.enqueue(encoder.encode(
        stoppedSsePrefix() +
          sseDataEvent(JSON.stringify(strictUsageMetadataEvent()))
      ));
      await vi.advanceTimersByTimeAsync(0);
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: "LLM_OUTPUT_IDLE_TIMEOUT",
        formatFailureStage: "trailing_data",
        formatFailureSubstage: "data_after_done_tail_incomplete"
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("metadata 后超长完整尾部按尾部形状分类，不再触发旧 4 MiB 字节上限", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        cancelled = true;
      }
    });
    const fetchMock = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    }));
    const resultPromise = chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    });
    streamController.enqueue(encoder.encode(
      stoppedSsePrefix() +
        sseDataEvent(JSON.stringify(strictUsageMetadataEvent()))
    ));
    await new Promise<void>((resolve) => setImmediate(resolve));
    // 超过旧 4 MiB 上限的单个完整 data 行：正文按形状分类而不是按字节数拒绝。
    streamController.enqueue(encoder.encode(
      sseDataEvent("a".repeat(5 * 1024 * 1024))
    ));
    streamController.close();
    const error = await resultPromise.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "LLM_RESPONSE_FORMAT_INVALID",
      formatFailureStage: "trailing_data",
      formatFailureSubstage: "data_after_done_json_syntax_invalid"
    });
    expect(cancelled).toBe(false);
  });

  it("终止序列子阶段在运行时也是闭集，非法值不会进入错误对象", () => {
    const sensitiveValue = "服务商原始尾部文本";
    const invalidConstructors = [
      () => new LlmResponseFormatError(
        "trailing_data",
        sensitiveValue as "duplicate_done"
      ),
      () => new LlmResponseFormatError("trailing_data"),
      () => new LlmResponseFormatError("event_json", "duplicate_done"),
      () => new LlmRequestError(
        "LLM_STREAM_INTERRUPTED",
        undefined,
        "trailing_data",
        sensitiveValue as "duplicate_done"
      )
    ];
    for (const construct of invalidConstructors) {
      const error = (() => {
        try {
          construct();
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).not.toContain(sensitiveValue);
    }
    expect(() => new LlmResponseFormatError(
      "trailing_data",
      "duplicate_done"
    )).not.toThrow();
  });

  it.each([
    {
      mode: "stream_interrupted",
      expectedCode: "LLM_STREAM_INTERRUPTED",
      expectedCancelled: false,
      expectedSubstage: "data_after_done_tail_incomplete"
    },
    {
      mode: "cancelled",
      expectedCode: "LLM_CANCELLED",
      expectedCancelled: true,
      expectedSubstage: "data_after_done_tail_incomplete"
    }
  ] as const)(
    "终止序列首错在排空异常后仍保留封闭子阶段：$mode",
    async ({ mode, expectedCode, expectedCancelled, expectedSubstage }) => {
      const encoder = new TextEncoder();
      const sensitiveTransportText = "不应进入错误的排空传输细节";
      const taskController = new AbortController();
      let cancelled = false;
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        cancel() {
          cancelled = true;
        }
      });
      const fetchMock = vi.fn(async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      }));
      const resultPromise = chatComplete(provider, spec, [], {
        ...runtime,
        signal: taskController.signal,
        fetch: fetchMock
      });
      streamController.enqueue(encoder.encode([
        'data: {"choices":[{"delta":{"content":"前半段"},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        "",
        "data: [DONE]",
        "",
        ""
      ].join("\n")));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(cancelled).toBe(false);

      if (mode === "stream_interrupted") {
        streamController.error(new Error(sensitiveTransportText));
      } else if (mode === "cancelled") {
        taskController.abort();
      }

      const error = await resultPromise.catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: expectedCode,
        formatFailureStage: "trailing_data",
        formatFailureSubstage: expectedSubstage
      });
      expect((error as Error).message).not.toContain(sensitiveTransportText);
      expect(cancelled).toBe(expectedCancelled);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it("流中出现服务商错误对象时拒绝残缺答案，且不泄漏错误正文", async () => {
    const sensitiveError = "不应进入异常或日志的服务商原文";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"残缺"}}]}',
            "",
            `data: {"choices":[],"error":{"message":"${sensitiveError}"}}`,
            "",
            "data: [DONE]",
            ""
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        )
    );
    const error = await chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "LLM_RESPONSE_FORMAT_INVALID" });
    expect((error as Error).message).not.toContain(sensitiveError);
  });

  it.each([
    ["length", "LLM_OUTPUT_LENGTH_LIMIT"],
    ["content_filter", "LLM_OUTPUT_CONTENT_FILTERED"]
  ] as const)(
    "SSE finish_reason=%s 映射为固定错误码且不重试或泄漏正文",
    async (finishReason, expectedCode) => {
      const sensitiveContent = "不应进入异常的模型残缺输出";
      const fetchMock = vi.fn(
        async () =>
          new Response(
            `data: ${JSON.stringify({
              choices: [{
                delta: { content: sensitiveContent },
                finish_reason: finishReason
              }]
            })}\n\n`,
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          )
      );
      const error = await chatComplete(provider, spec, [], {
        ...runtime,
        fetch: fetchMock
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: expectedCode });
      expect((error as Error).message).not.toContain(finishReason);
      expect((error as Error).message).not.toContain(sensitiveContent);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it("SSE 未知终止原因和工具调用仍是固定格式错误且不泄漏服务商字段", async () => {
    const sensitiveContent = "不应进入异常的服务商响应内容";
    const cases = [
      {
        delta: { content: sensitiveContent },
        finish_reason: "provider_private_finish_reason"
      },
      {
        delta: {
          tool_calls: [{
            function: {
              name: "provider_private_tool",
              arguments: sensitiveContent
            }
          }]
        },
        finish_reason: "tool_calls"
      }
    ];
    for (const choice of cases) {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            `data: ${JSON.stringify({ choices: [choice] })}\n\n`,
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          )
      );
      const error = await chatComplete(provider, spec, [], {
        ...runtime,
        fetch: fetchMock
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "LLM_RESPONSE_FORMAT_INVALID" });
      expect((error as Error).message).not.toContain(choice.finish_reason);
      expect((error as Error).message).not.toContain(sensitiveContent);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("完成事件里的内容字段类型不正确时拒绝空结果", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":123},"finish_reason":"stop"}]}\n\n',
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        )
    );
    await expect(
      chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock })
    ).rejects.toMatchObject({ code: "LLM_RESPONSE_FORMAT_INVALID" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("SSE event_shape 首错只重发一次且成功 receipt 记录两次传输", async () => {
    const bodies: string[] = [];
    let callCount = 0;
    const fetchMock = vi.fn(async (
      _url: string | URL | Request,
      init?: RequestInit
    ) => {
      bodies.push(String(init?.body));
      callCount += 1;
      return callCount === 1
        ? new Response('data: {"unexpected":true}\n\n', {
            status: 200,
            headers: { "Content-Type": "text/event-stream" }
          })
        : new Response(stoppedSsePrefix(), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" }
          });
    });

    const result = await chatCompleteWithReceipt(provider, spec, [], {
      ...runtime,
      maxAttempts: 1,
      fetch: fetchMock
    });

    expect(result.content).toBe("合成完整答案");
    expect(result.receipt.transportAttemptCount).toBe(2);
    expect(result.receipt.eofVerified).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it("SSE event_shape 两次失败后保持固定拒绝并保留两次尝试计数", async () => {
    const fetchMock = vi.fn(async () => new Response(
      'data: {"unexpected":true}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    ));
    const error = await chatCompleteWithReceipt(provider, spec, [], {
      ...runtime,
      maxAttempts: 1,
      fetch: fetchMock
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "LLM_RESPONSE_FORMAT_INVALID",
      formatFailureStage: "event_shape"
    });
    expect(getLlmFailureAudit(error)).toMatchObject({
      requestCount: 1,
      transportAttemptCount: 2,
      providerRequestCount: 2,
      retryCount: 1,
      completedResponses: []
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "event_json",
      body: "data: {not-json}\n\n",
      stage: "event_json"
    },
    {
      name: "delta_shape",
      body: 'data: {"choices":[{"delta":{"content":7},"finish_reason":"stop"}]}\n\n',
      stage: "delta_shape"
    },
    {
      name: "finish_shape",
      body: 'data: {"choices":[{"delta":{},"finish_reason":17}]}\n\n',
      stage: "finish_shape"
    },
    {
      name: "trailing_data",
      body: [
        'data: {"choices":[{"delta":{"content":"合成答案"},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        "",
        'data: {"choices":[]}',
        "",
        ""
      ].join("\n"),
      stage: "trailing_data"
    }
  ] as const)(
    "SSE $name 不触发 event_shape 专用重试",
    async ({ body, stage }) => {
      const fetchMock = vi.fn(async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      }));
      const error = await chatCompleteWithReceipt(provider, spec, [], {
        ...runtime,
        maxAttempts: 1,
        fetch: fetchMock
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "LLM_RESPONSE_FORMAT_INVALID",
        formatFailureStage: stage
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );


  it("SSE 事件首错后静默丢弃多个分块，等真实 EOF 才抛固定首错且不取消", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        cancelled = true;
      }
    });
    const fetchMock = vi.fn(
      async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      })
    );
    let settled = false;
    const resultPromise = chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    });
    void resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    streamController.enqueue(encoder.encode("data: {not-json}\n\n"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(cancelled).toBe(false);

    streamController.enqueue(encoder.encode(
      'data: {"choices":[{"delta":{"content":"不应再解析"},"finish_reason":"length"}]}\n\n'
    ));
    streamController.enqueue(encoder.encode("不应被解码或保留的尾部"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(cancelled).toBe(false);

    streamController.close();
    await expect(resultPromise).rejects.toMatchObject({
      code: "LLM_RESPONSE_FORMAT_INVALID",
      formatFailureStage: "event_json"
    });
    expect(cancelled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("SSE 协议首错只审计字段形状与计数，不保存事件正文，event_shape 仅重试一次", async () => {
    const privateSentinel = "SYNTHETIC_PRIVATE_EVENT_VALUE";
    const body = [
      ": heartbeat",
      "",
      `data: ${JSON.stringify({
        choices: [],
        usage: { total_tokens: 7 }
      })}`,
      "",
      `data: ${JSON.stringify({
        choices: [{ delta: { reasoning_content: "synthetic reasoning" } }]
      })}`,
      "",
      `data: ${JSON.stringify({
        provider_control: { private: privateSentinel }
      })}`,
      "",
      `data: ${JSON.stringify({
        choices: [{ delta: { content: privateSentinel } }]
      })}`,
      "",
      ""
    ].join("\n");
    const fetchMock = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    }));
    let caught: unknown;

    try {
      await chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "LLM_RESPONSE_FORMAT_INVALID",
      formatFailureStage: "event_shape"
    });
    const audit = getLlmFailureAudit(caught);
    expect(audit).toMatchObject({
      transportAttemptCount: 2,
      terminal: {
        status: 200,
        responseMode: "sse",
        eofObserved: true,
        finishReasonStopObserved: false,
        sseDoneObserved: false
      },
      stream: {
        eventCount: 4,
        chunkCount: 1,
        usageEventCount: 1,
        usageTotalTokens: 7,
        firstRejectedEvent: {
          eventOrdinal: 4,
          completedEventCount: 3,
          dataFieldCount: 1,
          topLevelKeys: [],
          unknownTopLevelKeyCount: 1,
          unknownTopLevelKeysFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
          choiceKeys: [],
          deltaKeys: [],
          shape: "choices_missing_or_non_array"
        }
      }
    });
    expect(audit?.stream.utf8Bytes).toBeGreaterThan(0);
    expect(audit?.stream.firstRejectedEvent?.eventUtf8Bytes).toBeGreaterThan(0);
    expect(audit?.stream.firstRejectedEvent?.shapeFingerprint).toMatch(
      /^[a-f0-9]{64}$/u
    );
    expect(JSON.stringify(audit)).not.toContain(privateSentinel);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("SSE 成功流只按封闭形状聚合事件，不保存任何字段值", async () => {
    const privateSentinel = "SYNTHETIC_PRIVATE_ACCEPTED_VALUE";
    const contentEvent = (content: string): string =>
      `data: ${JSON.stringify({
        choices: [{ delta: { content } }]
      })}`;
    const body = [
      ": heartbeat",
      "",
      `data: ${JSON.stringify(strictUsageMetadataEvent())}`,
      "",
      `data: ${JSON.stringify({
        choices: [
          { delta: { role: "assistant" } },
          { delta: { content: "ignored second choice" } }
        ]
      })}`,
      "",
      contentEvent(privateSentinel),
      "",
      contentEvent("synthetic second fragment"),
      "",
      `data: ${JSON.stringify({
        choices: [{ message: { reasoning_content: "synthetic reasoning" } }]
      })}`,
      "",
      `data: ${JSON.stringify({
        choices: [{
          delta: {
            content: "synthetic combined content",
            reasoning_content: "synthetic combined reasoning"
          }
        }]
      })}`,
      "",
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }]
      })}`,
      "",
      "data: [DONE]",
      "",
      ""
    ].join("\n");

    const result = await chatCompleteWithReceipt(provider, spec, [], {
      ...runtime,
      fetch: vi.fn(async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      }))
    });

    expect(result.receipt.acceptedEventShapes.map(({ category, count }) => ({
      category,
      count
    }))).toEqual([
      { category: "content", count: 2 },
      { category: "content_reasoning", count: 1 },
      { category: "done", count: 1 },
      { category: "finish", count: 1 },
      { category: "metadata", count: 1 },
      { category: "reasoning", count: 1 },
      { category: "role", count: 1 },
      { category: "usage", count: 1 }
    ]);
    for (const shape of result.receipt.acceptedEventShapes) {
      expect(shape.shapeFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(JSON.stringify(result.receipt)).not.toContain(privateSentinel);
  });

  it.each([
    {
      name: "多 data 字段、完整已知字段类型和 stop",
      body: [
        "data: {\"created\":1,\"id\":\"SYNTHETIC_PRIVATE_SHAPE_VALUE\",\"model\":\"synthetic\",\"object\":\"chunk\",\"service_tier\":\"default\",\"system_fingerprint\":null,\"usage\":{},\"control\":{},\"future_top\":{\"value\":\"SYNTHETIC_PRIVATE_SHAPE_VALUE\"},\"choices\":[",
        "data: {\"delta\":{\"content\":7,\"reasoning_content\":false,\"reasoning\":null,\"role\":\"assistant\",\"function_call\":{},\"refusal\":null,\"tool_calls\":[],\"future_delta\":\"SYNTHETIC_PRIVATE_SHAPE_VALUE\"},\"message\":{\"content\":\"synthetic\",\"reasoning_content\":null,\"reasoning\":\"synthetic\",\"role\":\"assistant\",\"function_call\":null,\"refusal\":\"synthetic\",\"tool_calls\":{},\"future_message\":true},\"finish_reason\":\"stop\",\"index\":0,\"logprobs\":null,\"future_choice\":true}]}",
        "",
        ""
      ].join("\n"),
      expectedCode: "LLM_RESPONSE_FORMAT_INVALID",
      expectedDataFieldCount: 2,
      expectedShape: "delta_field_type",
      expectedStructure: {
        fieldTypes: {
          choices: "array",
          created: "number",
          id: "string",
          model: "string",
          object: "string",
          serviceTier: "string",
          systemFingerprint: "null",
          usage: "object",
          error: "missing",
          control: "object",
          choice: "object",
          delta: "object",
          message: "object",
          finishReason: "string",
          index: "number",
          logprobs: "null",
          deltaFields: {
            content: "number",
            reasoningContent: "boolean",
            reasoning: "null",
            role: "string",
            functionCall: "object",
            refusal: "null",
            toolCalls: "array"
          },
          messageFields: {
            content: "string",
            reasoningContent: "null",
            reasoning: "string",
            role: "string",
            functionCall: "null",
            refusal: "string",
            toolCalls: "object"
          }
        },
        choicesLength: "1",
        payloadSource: "both",
        finishReasonClass: "stop",
        finishReasonIsNull: false,
        finishReasonUnknownStringHash: null,
        hasUsageField: true,
        hasErrorField: false,
        hasControlField: true,
        unknownTopLevelKeyCount: 1,
        unknownTopLevelKeysFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        unknownChoiceKeyCount: 1,
        unknownChoiceKeysFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        unknownPayloadKeyCount: 2,
        unknownPayloadKeysFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }
    },
    {
      name: "length",
      body: 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      expectedCode: "LLM_OUTPUT_LENGTH_LIMIT",
      expectedDataFieldCount: 1,
      expectedShape: "finish_reason_type_or_unknown",
      expectedStructure: {
        choicesLength: "1",
        payloadSource: "delta",
        finishReasonClass: "length",
        finishReasonIsNull: false,
        finishReasonUnknownStringHash: null
      }
    },
    {
      name: "content_filter",
      body: 'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n',
      expectedCode: "LLM_OUTPUT_CONTENT_FILTERED",
      expectedDataFieldCount: 1,
      expectedShape: "finish_reason_type_or_unknown",
      expectedStructure: {
        choicesLength: "1",
        payloadSource: "delta",
        finishReasonClass: "content_filter",
        finishReasonIsNull: false,
        finishReasonUnknownStringHash: null
      }
    },
    {
      name: "未知字符串和多个 choice",
      body: 'data: {"choices":[{"message":{},"finish_reason":"SYNTHETIC_PRIVATE_SHAPE_VALUE"},{"delta":{}}]}\n\n',
      expectedCode: "LLM_RESPONSE_FORMAT_INVALID",
      expectedDataFieldCount: 1,
      expectedShape: "finish_reason_type_or_unknown",
      expectedStructure: {
        choicesLength: "many",
        payloadSource: "message",
        finishReasonClass: "unknown_string",
        finishReasonIsNull: false
      }
    },
    {
      name: "非字符串 finish",
      body: 'data: {"choices":[{"delta":{},"finish_reason":17}]}\n\n',
      expectedCode: "LLM_RESPONSE_FORMAT_INVALID",
      expectedDataFieldCount: 1,
      expectedShape: "finish_reason_type_or_unknown",
      expectedStructure: {
        choicesLength: "1",
        payloadSource: "delta",
        finishReasonClass: "non_string",
        finishReasonIsNull: false,
        finishReasonUnknownStringHash: null
      }
    },
    {
      name: "choices=0 且 usage/error/control",
      body: 'data: {"choices":[],"usage":{"private":"SYNTHETIC_PRIVATE_SHAPE_VALUE"},"error":{"private":"SYNTHETIC_PRIVATE_SHAPE_VALUE"},"control":{"private":"SYNTHETIC_PRIVATE_SHAPE_VALUE"}}\n\n',
      expectedCode: "LLM_RESPONSE_FORMAT_INVALID",
      expectedDataFieldCount: 1,
      expectedShape: "error_object",
      expectedStructure: {
        choicesLength: "0",
        payloadSource: "neither",
        finishReasonClass: "missing",
        finishReasonIsNull: false,
        finishReasonUnknownStringHash: null,
        hasUsageField: true,
        hasErrorField: true,
        hasControlField: true
      }
    },
    {
      name: "message reasoning 类型错误",
      body: 'data: {"choices":[{"message":{"reasoning":false}}]}\n\n',
      expectedCode: "LLM_RESPONSE_FORMAT_INVALID",
      expectedDataFieldCount: 1,
      expectedShape: "delta_field_type",
      expectedStructure: {
        choicesLength: "1",
        payloadSource: "message",
        finishReasonClass: "missing",
        fieldTypes: {
          message: "object",
          messageFields: {
            reasoning: "boolean"
          }
        }
      }
    },
    {
      name: "损坏 JSON",
      body: "data: {SYNTHETIC_PRIVATE_SHAPE_VALUE\n\n",
      expectedCode: "LLM_RESPONSE_FORMAT_INVALID",
      expectedDataFieldCount: 1,
      expectedShape: "json_invalid",
      expectedStructure: {
        choicesLength: null,
        payloadSource: "neither",
        finishReasonClass: "missing",
        finishReasonIsNull: false,
        finishReasonUnknownStringHash: null
      }
    }
  ] as const)(
    "SSE 封闭形状审计覆盖$name，永久失败且仅对 event_shape 重试一次",
    async ({
      body,
      expectedCode,
      expectedDataFieldCount,
      expectedShape,
      expectedStructure
    }) => {
      const privateSentinel = "SYNTHETIC_PRIVATE_SHAPE_VALUE";
      const fetchMock = vi.fn(async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      }));
      const error = await chatComplete(provider, spec, [], {
        ...runtime,
        fetch: fetchMock
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: expectedCode });
      const audit = getLlmFailureAudit(error);
      expect(audit?.stream.firstRejectedEvent).toMatchObject({
        dataFieldCount: expectedDataFieldCount,
        shape: expectedShape,
        structure: expectedStructure
      });
      expect(
        audit?.stream.firstRejectedEvent?.structure.unknownKeysFingerprint
      ).toMatch(/^[a-f0-9]{64}$/u);
      expect(audit?.stream.firstRejectedEvent?.shapeFingerprint).toMatch(
        /^[a-f0-9]{64}$/u
      );
      if (
        audit?.stream.firstRejectedEvent?.structure.finishReasonClass ===
        "unknown_string"
      ) {
        expect(
          audit.stream.firstRejectedEvent.structure.finishReasonUnknownStringHash
        ).toMatch(/^[a-f0-9]{64}$/u);
      }
      const expectedAttempts =
        expectedShape === "delta_field_type" ||
        expectedShape === "finish_reason_type_or_unknown" ||
        expectedShape === "json_invalid"
          ? 1
          : 2;
      expect(fetchMock).toHaveBeenCalledTimes(expectedAttempts);
      expect(JSON.stringify(audit)).not.toContain(privateSentinel);
    }
  );

  it("SSE 未知 finish 首错不会被尾部事件替换，排空 EOF 后保留安全阶段", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        cancelled = true;
      }
    });
    const fetchMock = vi.fn(
      async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      })
    );
    const resultPromise = chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    });

    streamController.enqueue(encoder.encode(
      'data: {"choices":[{"delta":{"content":"残缺"},"finish_reason":"provider-private"}]}\n\n'
    ));
    streamController.enqueue(encoder.encode("data: {not-json}\n\n"));
    streamController.close();

    await expect(resultPromise).rejects.toMatchObject({
      code: "LLM_RESPONSE_FORMAT_INVALID",
      formatFailureStage: "finish_shape"
    });
    expect(cancelled).toBe(false);
  });

  it("SSE length 终止也先排空到延迟 EOF，再返回固定长度错误且不取消", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        cancelled = true;
      }
    });
    const fetchMock = vi.fn(
      async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      })
    );
    let settled = false;
    const resultPromise = chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    });
    void resultPromise.finally(() => {
      settled = true;
    }).catch(() => undefined);

    streamController.enqueue(encoder.encode(
      'data: {"choices":[{"delta":{"content":"已达上限"},"finish_reason":"length"}]}\n\n'
    ));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(cancelled).toBe(false);
    streamController.close();

    await expect(resultPromise).rejects.toMatchObject({
      code: "LLM_OUTPUT_LENGTH_LIMIT"
    });
    expect(cancelled).toBe(false);
  });

  it("不支持的 content-type 只丢弃正文，延迟 EOF 前不结束也不取消", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        cancelled = true;
      }
    });
    const fetchMock = vi.fn(
      async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      })
    );
    let settled = false;
    const resultPromise = chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    });
    void resultPromise.finally(() => {
      settled = true;
    }).catch(() => undefined);

    streamController.enqueue(encoder.encode("任意服务商正文"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(cancelled).toBe(false);
    streamController.close();

    await expect(resultPromise).rejects.toMatchObject({
      code: "LLM_RESPONSE_FORMAT_INVALID",
      formatFailureStage: "content_type"
    });
    expect(cancelled).toBe(false);
  });

  it("JSON UTF-8 首错后排空到 EOF，不用后续字节替换安全阶段", async () => {
    let cancelled = false;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        cancelled = true;
      }
    });
    const fetchMock = vi.fn(
      async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    const resultPromise = chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    });

    streamController.enqueue(Uint8Array.of(0xff));
    streamController.enqueue(new TextEncoder().encode("不应再解析"));
    streamController.close();

    await expect(resultPromise).rejects.toMatchObject({
      code: "LLM_RESPONSE_FORMAT_INVALID",
      formatFailureStage: "json_utf8"
    });
    expect(cancelled).toBe(false);
  });

  it("协议首错后的底层断流仍报告中断，不把未到达 EOF 伪装成格式完成", async () => {
    const sensitiveTransportError = "不应泄露的排空断流细节";
    let cancelled = false;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        cancelled = true;
      }
    });
    const fetchMock = vi.fn(
      async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      })
    );
    const resultPromise = chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    });

    streamController.enqueue(new TextEncoder().encode("data: {not-json}\n\n"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    streamController.error(new Error(sensitiveTransportError));

    const error = await resultPromise.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "LLM_STREAM_INTERRUPTED",
      formatFailureStage: "event_json"
    });
    expect((error as Error).message).not.toContain(sensitiveTransportError);
    expect(cancelled).toBe(false);
  });

  it("协议首错后的排空不再受累计字节上限约束，超限排空到 EOF 仍保留首错阶段", async () => {
    let cancelled = false;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        cancelled = true;
      }
    });
    const fetchMock = vi.fn(
      async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      })
    );
    const resultPromise = chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    });

    streamController.enqueue(new TextEncoder().encode("data: {not-json}\n\n"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // 超过旧 4 MiB 上限的排空正文：逐块丢弃直到真实 EOF，不再按字节数报错，
    // 同时保留首错阶段而不是被中断覆盖。
    streamController.enqueue(new Uint8Array(6 * 1024 * 1024));
    streamController.close();

    await expect(resultPromise).rejects.toMatchObject({
      code: "LLM_RESPONSE_FORMAT_INVALID",
      formatFailureStage: "event_json"
    });
    expect(cancelled).toBe(false);
  });
});

describe("chatComplete：按输出活动判断是否停住", () => {
  it("thinking=false 仍把 reasoning 事件算作有效活动，但最终不保留推理文本", async () => {
    vi.useFakeTimers();
    try {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const encoder = new TextEncoder();
      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          }
        });
        init?.signal?.addEventListener("abort", () => {
          streamController.error(new DOMException("连接已停止", "AbortError"));
        }, { once: true });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      });
      const resultPromise = chatComplete(
        provider,
        {
          ...spec,
          provider: "aether",
          model: "deepseek-v4-flash",
          thinking: false,
          thinkingRequest: "enabled",
          reasoningEffort: "max"
        },
        [],
        {
          outputIdleTimeoutMs: 1_000,
          firstOutputTimeoutMs: 1_000,
          maximumDurationMs: 5_000,
          maxAttempts: 1,
          baseDelayMs: 1,
          fetch: fetchMock
        }
      );

      await vi.advanceTimersByTimeAsync(900);
      streamController.enqueue(
        encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"有效推理"}}]}\n\n')
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(900);
      streamController.enqueue(
        encoder.encode(
          'data: {"choices":[{"delta":{"content":"最终答案"},"finish_reason":"stop"}]}\n\n' +
            "data: [DONE]\n\n"
        )
      );
      streamController.close();
      await vi.advanceTimersByTimeAsync(0);

      await expect(resultPromise).resolves.toEqual({ content: "最终答案", reasoning: null });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("SSE 心跳会刷新持续流的 no-progress 边界", async () => {
    vi.useFakeTimers();
    try {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const encoder = new TextEncoder();
      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          }
        });
        init?.signal?.addEventListener("abort", () => {
          streamController.error(new DOMException("连接已停止", "AbortError"));
        }, { once: true });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      });
      const resultPromise = chatComplete(provider, spec, [], {
        outputIdleTimeoutMs: 1_000,
        firstOutputTimeoutMs: 1_000,
        maximumDurationMs: 1,
        maxAttempts: 1,
        baseDelayMs: 1,
        fetch: fetchMock
      });
      await vi.advanceTimersByTimeAsync(0);
      streamController.enqueue(
        encoder.encode('data: {"choices":[{"delta":{"content":"有效输出"}}]}\n\n')
      );
      await vi.advanceTimersByTimeAsync(900);
      streamController.enqueue(encoder.encode(": heartbeat\n\n"));
      await vi.advanceTimersByTimeAsync(900);
      streamController.enqueue(
        encoder.encode(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
            "data: [DONE]\n\n"
        )
      );
      streamController.close();
      await vi.advanceTimersByTimeAsync(0);
      await expect(resultPromise).resolves.toMatchObject({
        content: "有效输出",
        reasoning: null
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("role-only 事件在首字节后仍受 no-progress 保护", async () => {
    vi.useFakeTimers();
    try {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const encoder = new TextEncoder();
      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          }
        });
        init?.signal?.addEventListener("abort", () => {
          streamController.error(new DOMException("连接已停止", "AbortError"));
        }, { once: true });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      });
      const resultPromise = chatComplete(provider, spec, [], {
        outputIdleTimeoutMs: 1_000,
        firstOutputTimeoutMs: 1_000,
        maximumDurationMs: 5_000,
        maxAttempts: 3,
        baseDelayMs: 1,
        fetch: fetchMock
      });
      await vi.advanceTimersByTimeAsync(0);
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: "LLM_FIRST_OUTPUT_TIMEOUT"
      });
      await vi.advanceTimersByTimeAsync(900);
      streamController.enqueue(
        encoder.encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n')
      );
      await vi.advanceTimersByTimeAsync(101);
      await rejection;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("终止序列首错后的排空分块刷新 idle 边界，超时仍保留封闭子阶段", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        cancel() {
          cancelled = true;
        }
      });
      const fetchMock = vi.fn(
        async () => new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        })
      );
      const resultPromise = chatComplete(provider, spec, [], {
        outputIdleTimeoutMs: 1_000,
        firstOutputTimeoutMs: 1_000,
        maximumDurationMs: 5_000,
        maxAttempts: 1,
        baseDelayMs: 1,
        fetch: fetchMock
      });
      await vi.advanceTimersByTimeAsync(0);
      streamController.enqueue(encoder.encode([
        'data: {"choices":[{"delta":{"content":"前半段"},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        "",
        "data: [DONE]",
        "",
        ""
      ].join("\n")));
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(900);
      streamController.enqueue(encoder.encode("排空中的非空分块"));
      await vi.advanceTimersByTimeAsync(0);
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: "LLM_OUTPUT_IDLE_TIMEOUT",
        formatFailureStage: "trailing_data",
        formatFailureSubstage: "data_after_done_tail_incomplete"
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
      expect(cancelled).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("持续排空只受 no-progress 保护，不受累计总时限取消", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        cancel() {
          cancelled = true;
        }
      });
      const fetchMock = vi.fn(
        async () => new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        })
      );
      const resultPromise = chatComplete(provider, spec, [], {
        outputIdleTimeoutMs: 1_000,
        firstOutputTimeoutMs: 1_000,
        maximumDurationMs: 1_000,
        maxAttempts: 1,
        baseDelayMs: 1,
        fetch: fetchMock
      });
      await vi.advanceTimersByTimeAsync(0);
      streamController.enqueue(encoder.encode("data: {not-json}\n\n"));
      await vi.advanceTimersByTimeAsync(0);
      for (let elapsed = 900; elapsed <= 1_800; elapsed += 900) {
        await vi.advanceTimersByTimeAsync(900);
        streamController.enqueue(encoder.encode(`排空分块${elapsed}`));
        await vi.advanceTimersByTimeAsync(0);
      }
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: "LLM_OUTPUT_IDLE_TIMEOUT",
        formatFailureStage: "event_json"
      });
      await vi.advanceTimersByTimeAsync(1_001);
      expect(cancelled).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("持续收到数据时会续时，即使总耗时超过单次停顿上限也不会取消", async () => {
    vi.useFakeTimers();
    try {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        }
      });
      const fetchMock = vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" }
          })
      );
      const resultPromise = chatComplete(provider, { ...spec, thinking: true }, [], {
        outputIdleTimeoutMs: 1_000,
        firstOutputTimeoutMs: 1_000,
        maximumDurationMs: 5_000,
        maxAttempts: 3,
        baseDelayMs: 1,
        fetch: fetchMock
      });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(900);
      streamController.enqueue(
        encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"还在"}}]}\n\n')
      );
      await vi.advanceTimersByTimeAsync(900);
      streamController.enqueue(
        encoder.encode('data: {"choices":[{"delta":{"content":"继续"}}]}\n\n')
      );
      await vi.advanceTimersByTimeAsync(900);
      streamController.enqueue(
        encoder.encode(
          'data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\n' +
            "data: [DONE]\n\n"
        )
      );
      streamController.close();

      await expect(resultPromise).resolves.toEqual({
        content: "继续完成",
        reasoning: "还在"
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("收到输出后只有连续停顿超限才中断，且不会自动重发", async () => {
    vi.useFakeTimers();
    try {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const encoder = new TextEncoder();
      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          }
        });
        init?.signal?.addEventListener(
          "abort",
          () => {
            streamController.error(new DOMException("不应泄露的部分输出", "AbortError"));
          },
          { once: true }
        );
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      });
      const onResponseBodyByte = vi.fn();
      const resultPromise = chatComplete(provider, spec, [], {
        outputIdleTimeoutMs: 1_000,
        firstOutputTimeoutMs: 1_000,
        maximumDurationMs: 5_000,
        maxAttempts: 3,
        baseDelayMs: 1,
        fetch: fetchMock,
        onResponseBodyByte
      });
      await vi.advanceTimersByTimeAsync(0);
      streamController.enqueue(
        encoder.encode('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n')
      );
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: "LLM_OUTPUT_IDLE_TIMEOUT"
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
      const error = await resultPromise.catch((caught: unknown) => caught);
      expect((error as Error).message).not.toContain("部分");
      expect((error as Error).message).not.toContain("不应泄露的部分输出");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onResponseBodyByte).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("只有 finish_reason=stop 而服务端未结束时仍受连续停顿保护", async () => {
    vi.useFakeTimers();
    try {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const encoder = new TextEncoder();
      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          }
        });
        init?.signal?.addEventListener(
          "abort",
          () => {
            streamController.error(new DOMException("连接已停止", "AbortError"));
          },
          { once: true }
        );
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      });
      const resultPromise = chatComplete(provider, spec, [], {
        outputIdleTimeoutMs: 1_000,
        firstOutputTimeoutMs: 1_000,
        maximumDurationMs: 5_000,
        maxAttempts: 3,
        baseDelayMs: 1,
        fetch: fetchMock
      });
      await vi.advanceTimersByTimeAsync(0);
      streamController.enqueue(
        encoder.encode(
          'data: {"choices":[{"delta":{"content":"答案"},"finish_reason":"stop"}]}\n\n'
        )
      );
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: "LLM_OUTPUT_IDLE_TIMEOUT"
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("持续有效输出超过首输出前最终保护值也不会被取消", async () => {
    vi.useFakeTimers();
    try {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const encoder = new TextEncoder();
      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          }
        });
        init?.signal?.addEventListener(
          "abort",
          () => {
            streamController.error(new DOMException("保护时长到期", "AbortError"));
          },
          { once: true }
        );
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      });
      const resultPromise = chatComplete(provider, spec, [], {
        outputIdleTimeoutMs: 1_000,
        firstOutputTimeoutMs: 1_000,
        maximumDurationMs: 1,
        maxAttempts: 3,
        baseDelayMs: 1,
        fetch: fetchMock
      });
      await vi.advanceTimersByTimeAsync(0);
      for (let elapsed = 500; elapsed <= 3_000; elapsed += 500) {
        await vi.advanceTimersByTimeAsync(500);
        streamController.enqueue(
          encoder.encode(
            `data: {"choices":[{"delta":{"content":"."}${
              elapsed === 3_000 ? ',"finish_reason":"stop"' : ""
            }}]}\n\n${elapsed === 3_000 ? "data: [DONE]\n\n" : ""}`
          )
        );
      }
      streamController.close();
      await expect(resultPromise).resolves.toEqual({
        content: "......",
        reasoning: null
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("没有完成标记就断流时拒绝使用残缺结果", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"残缺答案"}}]}\n\n',
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        )
    );
    await expect(
      chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock })
    ).rejects.toMatchObject({ code: "LLM_STREAM_INTERRUPTED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("chatComplete：响应正文大小与保留护栏", () => {
  it("拒绝损坏的 UTF-8，不把替换字符当成模型内容", async () => {
    for (const contentType of ["application/json", "text/event-stream"]) {
      const fetchMock = vi.fn(
        async () =>
          new Response(Uint8Array.of(0xff), {
            status: 200,
            headers: { "Content-Type": contentType }
          })
      );
      await expect(
        chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock })
      ).rejects.toMatchObject({ code: "LLM_RESPONSE_FORMAT_INVALID" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("UTF-8 多字节字符跨数据块时仍能正确解析", async () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify({
        choices: [{
          message: { content: "分块中文回答" },
          finish_reason: "stop"
        }]
      })
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of encoded) {
          controller.enqueue(Uint8Array.of(byte));
        }
        controller.close();
      }
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    await expect(
      chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock })
    ).resolves.toMatchObject({ content: "分块中文回答" });
  });

  it("非流 JSON 正文超过旧 4 MiB 字节上限仍完整解析", async () => {
    const prefix = '{"choices":[{"message":{"content":"';
    const suffix = '"},"finish_reason":"stop"}]}';
    const content = "a".repeat(5 * 1024 * 1024 - 128);
    const responseBody = prefix + content + suffix;
    expect(new TextEncoder().encode(responseBody).byteLength).toBeGreaterThan(
      4 * 1024 * 1024
    );
    const fetchMock = vi.fn(
      async () => new Response(responseBody, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    const result = await chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    });
    expect(result.content).toBe(content);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("长 reasoning=max 式响应超过旧 4 MiB 字节上限时流式读完并正常收尾", async () => {
    const reasoningDelta = "a".repeat(1024 * 1024);
    const events = [
      ...[0, 1, 2, 3].map(() => JSON.stringify({
        choices: [{ index: 0, delta: { reasoning_content: reasoningDelta } }]
      })),
      JSON.stringify({
        choices: [{ index: 0, delta: { content: "合成完整答案" } }]
      }),
      JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      }),
      "[DONE]"
    ];
    const responseBody = events.map((event) => `data: ${event}\n\n`).join("");
    expect(new TextEncoder().encode(responseBody).byteLength).toBeGreaterThan(
      4 * 1024 * 1024
    );
    const fetchMock = vi.fn(
      async () => new Response(responseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      })
    );
    const result = await chatComplete(
      provider,
      { ...spec, thinking: true },
      [],
      { ...runtime, fetch: fetchMock }
    );
    expect(result.content).toBe("合成完整答案");
    expect(result.reasoning).toBe(reasoningDelta.repeat(4));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("防护护栏：单个未结束事件超过防御上限时以永久错误拒绝且不重试", async () => {
    let cancelled = false;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        cancelled = true;
      }
    });
    const fetchMock = vi.fn(
      async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      })
    );
    const resultPromise = chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    });
    // 单个无换行的 data 行，累计超过防御上限（24576000 单位）。
    streamController.enqueue(new TextEncoder().encode(
      "data: " + "a".repeat(maximumRetainedLlmTextLength + 1)
    ));

    const error = await resultPromise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmRetainedTextTooLargeError);
    expect(error).toMatchObject({ code: "LLM_RETAINED_TEXT_TOO_LARGE" });
    expect(cancelled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("防护护栏：跨多个事件累计保留文本超过防御上限时以永久错误拒绝", async () => {
    const delta = "a".repeat(13 * 1024 * 1024);
    const responseBody = [0, 1].map(() => `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: delta } }]
    })}\n\n`).join("");
    // 两个事件各 13 MiB 单位，单个事件低于护栏，累计超过 24576000。
    const fetchMock = vi.fn(
      async () => new Response(responseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      })
    );
    const error = await chatComplete(
      provider,
      { ...spec, thinking: true },
      [],
      { ...runtime, fetch: fetchMock }
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmRetainedTextTooLargeError);
    expect(error).toMatchObject({ code: "LLM_RETAINED_TEXT_TOO_LARGE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("chatComplete：只在服务端明确拒绝接单时重试", () => {
  it("在 maxAttempts 次内成功就返回结果，且确实按顺序重试了", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        return new Response("rate limited", { status: 429 });
      }
      return completionResponse("成功");
    });
    const result = await chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock });
    expect(result.content).toBe("成功");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("收到 429 响应头后不等待错误正文结束，取消正文并安全重试", async () => {
    let firstBodyCancelled = false;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            firstBodyCancelled = true;
          }
        });
        return new Response(body, { status: 429 });
      })
      .mockImplementationOnce(async () => completionResponse("限流后成功"));

    await expect(
      chatComplete(provider, spec, [], {
        ...runtime,
        baseDelayMs: 1,
        fetch: fetchMock
      })
    ).resolves.toMatchObject({ content: "限流后成功" });
    expect(firstBodyCancelled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });


  it("连续 429 只尝试配置的次数，耗尽后返回最后一个状态码", async () => {
    const fetchMock = vi.fn(
      async () => new Response("rate limited", { status: 429 })
    );
    await expect(
      chatComplete(provider, spec, [], {
        ...runtime,
        maxAttempts: 3,
        baseDelayMs: 1,
        fetch: fetchMock
      })
    ).rejects.toMatchObject({ code: "LLM_HTTP_ERROR", status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("5xx 不自动重发，避免模型已经开始生成时重复计费", async () => {
    const fetchMock = vi.fn(async () => new Response("server error", { status: 503 }));
    await expect(chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock })).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(LlmRequestError);
        expect((error as LlmRequestError).status).toBe(503);
        return true;
      }
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("5xx 响应正文即使不结束也立即按状态失败，并取消正文", async () => {
    let cancelled = false;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            }
          }),
          { status: 503 }
        )
    );
    await expect(
      chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock })
    ).rejects.toMatchObject({ code: "LLM_HTTP_ERROR", status: 503 });
    expect(cancelled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("其它错误状态码（比如 400）不重试，直接失败", async () => {
    const sensitiveProviderMessage = "不应进入异常的题面或模型原文";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: sensitiveProviderMessage } }),
          { status: 400 }
        )
    );
    const error = await chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmRequestError);
    expect(error).toMatchObject({ code: "LLM_HTTP_ERROR", status: 400 });
    expect((error as Error).message).not.toContain(sensitiveProviderMessage);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("499 表示已取消的请求，不会自动重发", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 499 }));
    await expect(
      chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock })
    ).rejects.toMatchObject({ code: "LLM_HTTP_ERROR", status: 499 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("零字节连接失败重试到 maxAttempts 上限后以网络失败封存", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(
      chatComplete(provider, spec, [], {
        ...runtime,
        maxAttempts: 3,
        baseDelayMs: 1,
        fetch: fetchMock
      })
    ).rejects.toMatchObject({ code: "LLM_NETWORK_FAILED" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("零字节连接失败后首次重试成功，且不重复计费", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("ECONNRESET");
      }
      return completionResponse("成功");
    });
    const result = await chatComplete(provider, spec, [], {
      ...runtime,
      maxAttempts: 3,
      baseDelayMs: 1,
      fetch: fetchMock
    });
    expect(result.content).toBe("成功");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("上层确认任务已丢失时停止当前模型请求，且不自动重发", async () => {
    const taskController = new AbortController();
    let requestWasAborted = false;
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            requestWasAborted = true;
          },
          { once: true }
        );
        return new Promise<Response>(() => undefined);
      }
    );
    const resultPromise = chatComplete(provider, spec, [], {
      ...runtime,
      signal: taskController.signal,
      fetch: fetchMock
    });
    await Promise.resolve();
    taskController.abort();

    await expect(resultPromise).rejects.toMatchObject({
      code: "LLM_CANCELLED"
    });
    expect(requestWasAborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("网络失败时不把底层错误原文放进异常", async () => {
    const sensitiveNetworkMessage = "不应进入日志的外部错误正文";
    const fetchMock = vi.fn(async () => {
      throw new Error(sensitiveNetworkMessage);
    });
    const error = await chatComplete(provider, spec, [], {
      outputIdleTimeoutMs: 5_000,
      maxAttempts: 1,
      baseDelayMs: 1,
      fetch: fetchMock
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "LLM_NETWORK_FAILED" });
    expect((error as Error).message).not.toContain(sensitiveNetworkMessage);
  });

  it("等待时间覆盖响应正文读取，而不只覆盖响应头", async () => {
    vi.useFakeTimers();
    try {
      const sensitiveBodyError = "不应进入日志的响应正文片段";
      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        let streamController!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          }
        });
        init?.signal?.addEventListener(
          "abort",
          () => {
            streamController.error(new DOMException(sensitiveBodyError, "AbortError"));
          },
          { once: true }
        );
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      });
      const resultPromise = chatComplete(provider, spec, [], {
        outputIdleTimeoutMs: 1_000,
        firstOutputTimeoutMs: 1_000,
        maxAttempts: 1,
        baseDelayMs: 1,
        fetch: fetchMock
      });
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: "LLM_FIRST_OUTPUT_TIMEOUT"
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
      const error = await resultPromise.catch((caught: unknown) => caught);
      expect((error as Error).message).not.toContain(sensitiveBodyError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("响应正文忽略取消信号时仍会结束并取消底层流", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const fetchMock = vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled = true;
              }
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" }
            }
          )
      );
      const resultPromise = chatComplete(provider, spec, [], {
        outputIdleTimeoutMs: 1_000,
        firstOutputTimeoutMs: 1_000,
        maximumDurationMs: 5_000,
        maxAttempts: 1,
        baseDelayMs: 1,
        fetch: fetchMock
      });
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: "LLM_FIRST_OUTPUT_TIMEOUT"
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
      expect(cancelled).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("即使注入的请求实现忽略取消信号，第一段输出等待仍会结束", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        () => new Promise<Response>(() => undefined)
      );
      const resultPromise = chatComplete(provider, spec, [], {
        outputIdleTimeoutMs: 1_000,
        firstOutputTimeoutMs: 1_000,
        maximumDurationMs: 5_000,
        maxAttempts: 1,
        baseDelayMs: 1,
        fetch: fetchMock
      });
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: "LLM_FIRST_OUTPUT_TIMEOUT"
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("chatComplete：响应结构异常", () => {
  it("响应不是对象时抛出 LlmResponseFormatError", async () => {
    const fetchMock = vi.fn(async () => new Response("null", { status: 200 }));
    await expect(chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock })).rejects.toBeInstanceOf(
      LlmResponseFormatError
    );
  });

  it("缺少 choices 时抛出 LlmResponseFormatError", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    await expect(chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock })).rejects.toBeInstanceOf(
      LlmResponseFormatError
    );
  });

  it.each([
    ["length", "LLM_OUTPUT_LENGTH_LIMIT"],
    ["content_filter", "LLM_OUTPUT_CONTENT_FILTERED"]
  ] as const)(
    "JSON 回退 finish_reason=%s 映射为固定错误码且不重试或泄漏正文",
    async (finishReason, expectedCode) => {
      const sensitiveContent = "不应进入异常的模型残缺输出";
      const fetchMock = vi.fn(
        async () => new Response(JSON.stringify({
          choices: [{
            message: { role: "assistant", content: sensitiveContent },
            finish_reason: finishReason
          }]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
      const error = await chatComplete(provider, spec, [], {
        ...runtime,
        fetch: fetchMock
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: expectedCode });
      expect((error as Error).message).not.toContain(finishReason);
      expect((error as Error).message).not.toContain(sensitiveContent);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it("JSON 回退必须明确以 finish_reason=stop 完成，未知值和工具调用仍是格式错误", async () => {
    const sensitiveContent = "不应进入异常的服务商响应内容";
    const choices: Array<Record<string, unknown>> = [
      { message: { role: "assistant", content: sensitiveContent } },
      {
        message: { role: "assistant", content: sensitiveContent },
        finish_reason: null
      },
      {
        message: { role: "assistant", content: sensitiveContent },
        finish_reason: "provider_private_finish_reason"
      },
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            function: {
              name: "provider_private_tool",
              arguments: sensitiveContent
            }
          }]
        },
        finish_reason: "tool_calls"
      }
    ];
    for (const choice of choices) {
      const fetchMock = vi.fn(
        async () => new Response(JSON.stringify({ choices: [choice] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
      const error = await chatComplete(provider, spec, [], {
        ...runtime,
        fetch: fetchMock
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LlmResponseFormatError);
      expect(error).toMatchObject({ code: "LLM_RESPONSE_FORMAT_INVALID" });
      expect((error as Error).message).not.toContain(sensitiveContent);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("JSON 回退拒绝空白和 role-only 最终内容", async () => {
    for (const message of [
      { role: "assistant", content: " \n\t " },
      { role: "assistant" }
    ]) {
      const fetchMock = vi.fn(
        async () => new Response(JSON.stringify({
          choices: [{ message, finish_reason: "stop" }]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
      await expect(
        chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock })
      ).rejects.toBeInstanceOf(LlmResponseFormatError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("reasoning-only 不会被当作最终答案", async () => {
    const responses = [
      new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "   ",
            reasoning_content: "已经推理但没有最终回答"
          },
          finish_reason: "stop"
        }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }),
      new Response([
        'data: {"choices":[{"delta":{"reasoning_content":"只有推理"}}]}',
        "",
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        ""
      ].join("\n"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      })
    ];
    for (const response of responses) {
      const fetchMock = vi.fn(async () => response);
      await expect(
        chatComplete(provider, { ...spec, thinking: true }, [], {
          ...runtime,
          fetch: fetchMock
        })
      ).rejects.toBeInstanceOf(LlmResponseFormatError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
});

const resultSchema = z.object({ rating: z.number().int() }).strict();

describe("chatCompleteJson：结构化输出与一次修复重试", () => {
  it("共享停发闸门在首轮 EOF 后关闭时不启动 JSON 修复轮", async () => {
    const gate = new LlmRequestStartGate();
    const fetchMock = vi.fn(async () => {
      gate.close();
      return completionResponse("不是 JSON");
    });
    await expect(withLlmRequestStartGate(gate, () =>
      chatCompleteJsonWithReceipt(
        provider,
        spec,
        [],
        resultSchema,
        { ...runtime, fetch: fetchMock }
      )
    )).rejects.toMatchObject({ code: "LLM_REQUEST_START_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("JSON receipt 绑定首轮/修复轮数、总 HTTP 尝试数和 schema 成功", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return completionResponse(calls === 1 ? "不是 JSON" : '{"rating": 1500}');
    });
    const result = await chatCompleteJsonWithReceipt(
      provider,
      spec,
      [],
      resultSchema,
      { ...runtime, fetch: fetchMock }
    );
    expect(result.data).toEqual({ rating: 1500 });
    expect(result.receipt).toEqual({
      schemaVersion: 2,
      requestCount: 2,
      transportAttemptCount: 2,
      eofVerified: true,
      jsonSchemaValidated: true,
      responses: [
        {
          schemaVersion: 2,
          transportAttemptCount: 1,
          eofVerified: true,
          responseMode: "json",
          finishReasonStopVerified: true,
          sseDoneObserved: null,
          acceptedEventShapes: []
        },
        {
          schemaVersion: 2,
          transportAttemptCount: 1,
          eofVerified: true,
          responseMode: "json",
          finishReasonStopVerified: true,
          sseDoneObserved: null,
          acceptedEventShapes: []
        }
      ]
    });
  });

  it("第一次就是合法 JSON 时直接返回", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.response_format).toBeUndefined();
      return completionResponse('{"rating": 1500}');
    });
    const result = await chatCompleteJson(provider, spec, [], resultSchema, { ...runtime, fetch: fetchMock });
    expect(result.data).toEqual({ rating: 1500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("JSON 修复轮若收到 499，失败审计保留两轮与首轮完成证据", async () => {
    let calls = 0;
    let caught: unknown;
    try {
      await chatCompleteJsonWithReceipt(
        provider,
        spec,
        [],
        resultSchema,
        {
          ...runtime,
          fetch: vi.fn(async () => {
            calls += 1;
            return calls === 1
              ? completionResponse("不是 JSON")
              : new Response(null, { status: 499 });
          })
        }
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "LLM_HTTP_ERROR", status: 499 });
    expect(getLlmFailureAudit(caught)).toMatchObject({
      schemaVersion: 1,
      requestCount: 2,
      transportAttemptCount: 2,
      jsonSchemaValidated: false,
      terminal: {
        status: 499,
        responseMode: null,
        eofObserved: false
      }
    });
    expect(getLlmFailureAudit(caught)?.completedResponses).toHaveLength(1);
  });

  it("JSON 修复轮缺少 SSE DONE 时保留首轮完成证据并判定整体不完整", async () => {
    let calls = 0;
    let caught: unknown;
    try {
      await chatCompleteJsonWithReceipt(
        provider,
        spec,
        [],
        resultSchema,
        {
          ...runtime,
          fetch: vi.fn(async () => {
            calls += 1;
            return calls === 1
              ? completionResponse("不是 JSON")
              : new Response(
                  'data: {"choices":[{"delta":{"content":"{\\"rating\\":1500}"},"finish_reason":"stop"}]}\n\n',
                  { status: 200, headers: { "Content-Type": "text/event-stream" } }
                );
          })
        }
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "LLM_RESPONSE_FORMAT_INVALID" });
    expect(getLlmFailureAudit(caught)).toMatchObject({
      schemaVersion: 1,
      requestCount: 2,
      transportAttemptCount: 2,
      jsonSchemaValidated: false,
      terminal: {
        status: 200,
        responseMode: "sse",
        eofObserved: true,
        finishReasonStopObserved: true,
        sseDoneObserved: false
      }
    });
    expect(getLlmFailureAudit(caught)?.completedResponses).toHaveLength(1);
  });

  it("结构化可信调用拒绝缺少 SSE DONE 的 stop+EOF，并保留真实终态", async () => {
    let caught: unknown;
    try {
      await chatCompleteJsonWithReceipt(
        provider,
        spec,
        [],
        resultSchema,
        {
          ...runtime,
          fetch: vi.fn(async () => new Response(
            'data: {"choices":[{"delta":{"content":"{\\"rating\\":1500}"},"finish_reason":"stop"}]}\n\n',
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          ))
        }
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "LLM_RESPONSE_FORMAT_INVALID" });
    expect(getLlmFailureAudit(caught)).toMatchObject({
      requestCount: 1,
      transportAttemptCount: 1,
      jsonSchemaValidated: false,
      terminal: {
        status: 200,
        responseMode: "sse",
        eofObserved: true,
        finishReasonStopObserved: true,
        sseDoneObserved: false
      }
    });
  });

  it("能从代码块里抠出 JSON", async () => {
    const fetchMock = vi.fn(async () => completionResponse('这是结果：\n```json\n{"rating": 1600}\n```'));
    const result = await chatCompleteJson(provider, spec, [], resultSchema, { ...runtime, fetch: fetchMock });
    expect(result.data).toEqual({ rating: 1600 });
  });

  it("第一次不合法时会带着错误信息重试一次，第二次成功就返回", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).not.toHaveProperty("max_tokens");
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.reasoning_effort).toBe("max");
      expect(body.response_format).toBeUndefined();
      calls += 1;
      if (calls === 1) {
        return completionResponse("抱歉，我不知道怎么用 JSON 回答");
      }
      // 第二次请求应该包含第一次的坏输出和纠正提示，让模型知道错在哪。
      const joined = body.messages.map((m: { content: string }) => m.content).join("\n");
      expect(joined).toContain("不知道怎么用 JSON 回答");
      return completionResponse('{"rating": 1400}');
    });
    const result = await chatCompleteJson(
      provider,
      {
        ...spec,
        provider: "aether",
        model: "deepseek-v4-flash",
        thinkingRequest: "enabled",
        reasoningEffort: "max"
      },
      [],
      resultSchema,
      { ...runtime, fetch: fetchMock },
      { maxOutputTokens: 2_048 }
    );
    expect(result.data).toEqual({ rating: 1400 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });


  it("保留原创性 schema 失败的三字段安全诊断，不泄漏响应内容", async () => {
    const valid = {
      originalityLevel: 4,
      sameProblemAsExisting: false,
      highestSimilarity: 0,
      evidenceIds: [],
      rationale: "synthetic rationale"
    };
    const capture = async (payload: unknown) => {
      let calls = 0;
      const fetchMock = vi.fn(async () => {
        calls += 1;
        return completionResponse(calls === 1 ? "synthetic semantic output" : JSON.stringify(payload));
      });
      const error = await chatCompleteTwoRoundJsonWithReceipt(
        provider,
        spec,
        [],
        (semanticOutput) => [{ role: "user", content: semanticOutput }],
        originalityPayloadSchema,
        { ...runtime, fetch: fetchMock },
        { safeSchemaDiagnostic: "originality" }
      ).catch((caught: unknown) => caught);
      const audit = getLlmFailureAudit(error);
      const diagnostic = audit?.schemaDiagnostic;
      expect(error).toBeInstanceOf(LlmJsonOutputError);
      expect(Object.keys(diagnostic ?? {}).sort()).toEqual([
        "code",
        "expectedCategory",
        "path"
      ]);
      const serializedAudit = JSON.stringify(audit);
      expect(serializedAudit).not.toContain("secret-value");
      expect(serializedAudit).not.toContain("private-message");
      expect(serializedAudit).not.toContain("unexpectedKey");
      expect(serializedAudit).not.toContain("模型两次输出");
      return diagnostic;
    };

    await expect(capture({ ...valid, highestSimilarity: "secret-value" })).resolves.toMatchObject({
      code: "invalid_type",
      path: "/highestSimilarity",
      expectedCategory: "number_0_1"
    });
    await expect(capture({ ...valid, highestSimilarity: 2 })).resolves.toMatchObject({
      code: "too_big",
      path: "/highestSimilarity",
      expectedCategory: "number_0_1"
    });
    await expect(capture({ ...valid, unexpectedKey: "private-message" })).resolves.toMatchObject({
      code: "unrecognized_keys",
      path: "/",
      expectedCategory: "exact_key_set"
    });
  });

  it("两次都不合法时抛出 LlmJsonOutputError", async () => {
    const fetchMock = vi.fn(async () => completionResponse("完全不是 JSON"));
    const error = await chatCompleteJson(provider, spec, [], resultSchema, {
      ...runtime,
      fetch: fetchMock
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmJsonOutputError);
    expect((error as Error).message).not.toContain("完全不是 JSON");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("JSON 合法但不满足 schema 时也会触发修复重试", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return completionResponse(calls === 1 ? '{"rating": "not-a-number"}' : '{"rating": 1700}');
    });
    const result = await chatCompleteJson(provider, spec, [], resultSchema, { ...runtime, fetch: fetchMock });
    expect(result.data).toEqual({ rating: 1700 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("review-flow dynamic evidence enums", () => {
  const allowed = ["ev-allowed-a", "ev-allowed-b"] as const;

  it("rejects evidence references outside the stage input", () => {
    const originality = {
      originalityLevel: 4,
      sameProblemAsExisting: false,
      highestSimilarity: 0,
      evidenceIds: ["ev-allowed-a"],
      rationale: "合成理由"
    };
    expect(
      createOriginalityPayloadSchema(allowed).safeParse(originality).success
    ).toBe(true);
    expect(
      createOriginalityPayloadSchema(allowed).safeParse({
        ...originality,
        evidenceIds: ["ev-not-allowed"]
      }).success
    ).toBe(false);

    const adversary = {
      counterexamples: [{
        targetEvidenceId: "ev-allowed-a",
        scenario: "合成场景",
        impact: "minor" as const
      }],
      rationale: "合成理由"
    };
    expect(
      createAdversaryPayloadSchema(allowed).safeParse(adversary).success
    ).toBe(true);
    expect(
      createAdversaryPayloadSchema(allowed).safeParse({
        ...adversary,
        counterexamples: [{
          ...adversary.counterexamples[0],
          targetEvidenceId: "ev-not-allowed"
        }]
      }).success
    ).toBe(false);

    const adjudicator = {
      verdict: "approve" as const,
      qualityLevel: 4,
      fixability: "none" as const,
      strengths: ["合成优点"],
      improvements: "合成改进",
      publicComment: "",
      privateNote: "",
      citedEvidenceIds: ["ev-allowed-b"]
    };
    expect(
      createAdjudicatorPayloadSchema(allowed).safeParse(adjudicator).success
    ).toBe(true);
    expect(
      createAdjudicatorPayloadSchema(allowed).safeParse({
        ...adjudicator,
        citedEvidenceIds: ["ev-not-allowed"]
      }).success
    ).toBe(false);
  });
});
describe("chatComplete：统一机器 JSON Schema transport", () => {
  it("sends strict json_schema and native max in the same request", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        thinking: { type: "enabled" },
        reasoning_effort: "max",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "fermata_review_flow_unified_v1",
            strict: true,
            schema: {
              type: "object",
              required: ["verdict"],
              additionalProperties: false
            }
          }
        }
      });
      expect(body).not.toHaveProperty("max_tokens");
      expect(body).not.toHaveProperty("max_output_tokens");
      expect(body).not.toHaveProperty("maxOutputTokens");
      return completionResponse('{"verdict":"approve"}');
    });
    await expect(chatCompleteWithReceipt(
      provider,
      {
        provider: "aether",
        model: "deepseek-v4-pro",
        temperature: 0,
        thinking: false,
        thinkingRequest: "enabled",
        reasoningEffort: "max"
      },
      [],
      { ...runtime, maxAttempts: 1, fetch: fetchMock },
      {
        maxOutputTokens: 12_000,
        responseJsonSchema: {
          name: "fermata_review_flow_unified_v1",
          schema: {
            type: "object",
            required: ["verdict"],
            additionalProperties: false
          }
        }
      }
    )).resolves.toMatchObject({ receipt: { eofVerified: true, transportAttemptCount: 1 } });
  });

  it("carries bounded Retry-After on a terminal 429 without reading its body", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("private-body-must-not-be-read"));
      },
      cancel: vi.fn()
    });
    const fetchMock = vi.fn(async () => new Response(body, {
      status: 429,
      headers: { "Retry-After": "7" }
    }));
    const error = await chatCompleteWithReceipt(
      provider,
      spec,
      [],
      { ...runtime, maxAttempts: 1, fetch: fetchMock }
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmRequestError);
    expect(error).toMatchObject({
      code: "LLM_HTTP_ERROR",
      status: 429,
      retryAfterMs: 7_000
    });
  });
});

describe("两轮 JSON：phase2 结构化轮不继承 phase1 的 max thinking", () => {
  it("phase1 语义轮保持 max thinking，phase2 格式/修复轮不再发送 thinking 与 reasoning_effort", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      calls += 1;
      if (calls === 1) {
        return completionResponse("语义轮自由文本结论");
      }
      if (calls === 2) {
        return completionResponse("这个不是 JSON");
      }
      return completionResponse('{"rating": 1500}');
    });
    const result = await chatCompleteTwoRoundJsonWithReceipt(
      provider,
      {
        ...spec,
        provider: "aether",
        model: "deepseek-v4-flash",
        thinkingRequest: "enabled",
        reasoningEffort: "max"
      },
      [{ role: "user", content: "语义轮输入" }],
      (_semanticOutput, _semanticReasoning) => [{ role: "user", content: "格式轮输入" }],
      resultSchema,
      { ...runtime, fetch: fetchMock }
    );
    expect(result.data).toEqual({ rating: 1500 });
    expect(bodies).toHaveLength(3);
    // phase1 保持 max thinking 是既有必需行为，不能退化。
    expect(bodies[0]).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max"
    });
    // phase2 格式轮与修复轮必须是兼容的结构化提取规格，不得携带 max thinking。
    // 当前实现把这个 spec 原样传给两轮，导致这里失败（RED）。
    expect(bodies[1].thinking).toBeUndefined();
    expect(bodies[1].reasoning_effort).toBeUndefined();
    expect(bodies[2].thinking).toBeUndefined();
    expect(bodies[2].reasoning_effort).toBeUndefined();
    for (const body of bodies.slice(1)) {
      expect(body).toMatchObject({
        response_format: {
          type: "json_schema",
          json_schema: { strict: true }
        }
      });
    }
  });
  it("semantic draft stays ordinary text while formatter requests strict schema output", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return completionResponse(
        bodies.length === 1 ? "合成语义草稿自由文本" : '{"rating": 1500}'
      );
    });
    const result = await chatCompleteTwoRoundJsonWithReceipt(
      provider,
      {
        ...spec,
        provider: "aether",
        model: "deepseek-v4-flash",
        thinkingRequest: "enabled",
        reasoningEffort: "max"
      },
      [{ role: "user", content: "合成语义输入" }],
      (semanticOutput) => [{
        role: "user",
        content: `把语义草稿格式化为 role 对象：${semanticOutput}`
      }],
      resultSchema,
      { ...runtime, fetch: fetchMock }
    );

    expect(result.data).toEqual({ rating: 1500 });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toHaveProperty("response_format");
    expect(bodies[0]).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max"
    });
    expect(bodies[1]).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: {
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false
          }
        }
      }
    });
  });
  it("formatter length termination is terminal and does not trigger a repair", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return completionResponse("合成语义草稿自由文本");
      }
      return new Response(JSON.stringify({
        choices: [{
          message: { role: "assistant", content: "不完整的格式输出" },
          finish_reason: "length"
        }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const error = await chatCompleteTwoRoundJsonWithReceipt(
      provider,
      {
        ...spec,
        provider: "aether",
        model: "deepseek-v4-flash",
        thinkingRequest: "enabled",
        reasoningEffort: "max"
      },
      [{ role: "user", content: "合成语义输入" }],
      (semanticOutput) => [{
        role: "user",
        content: `把语义草稿格式化为 role 对象：${semanticOutput}`
      }],
      resultSchema,
      { ...runtime, fetch: fetchMock }
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "LLM_OUTPUT_LENGTH_LIMIT" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[0]).not.toHaveProperty("response_format");
    expect(bodies[1]).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: { strict: true }
      }
    });
  });
});
