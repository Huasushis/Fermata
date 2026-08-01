import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  chatComplete,
  chatCompleteJson,
  LlmJsonOutputError,
  LlmRequestError,
  LlmResponseBodyTooLargeError,
  LlmResponseFormatError,
  maximumExplicitLlmOutputTokens,
  maximumLlmResponseBodyBytes,
  type ModelCallSpec
} from "../src/llm";
import { logError } from "../src/logger";

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

describe("chatComplete：正常路径", () => {
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
        reasoningEffort: "low"
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
        reasoningEffort: "low"
      },
      [],
      { ...runtime, fetch: fetchMock }
    );
    await chatComplete(
      provider,
      {
        ...spec,
        provider: "aether",
        model: "deepseek-v4-flash",
        thinkingRequest: "disabled"
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
      reasoning_effort: "low"
    });
    expect(requestBodies[1]).toEqual(requestBodies[0]);
    expect(requestBodies[2]).toEqual({
      model: "deepseek-v4-flash",
      temperature: 0.2,
      stream: true,
      messages: [],
      thinking: { type: "disabled" }
    });
    expect(requestBodies[3]).toEqual({
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
      "开启时缺 low",
      { ...spec, provider: "aether", model: "deepseek-v4-flash", thinkingRequest: "enabled" }
    ],
    [
      "开启时缺 provider",
      { ...spec, model: "deepseek-v4-flash", thinkingRequest: "enabled", reasoningEffort: "low" }
    ],
    [
      "其它 provider",
      {
        ...spec,
        provider: "dashscope",
        model: "deepseek-v4-flash",
        thinkingRequest: "enabled",
        reasoningEffort: "low"
      }
    ],
    [
      "其它 model",
      {
        ...spec,
        provider: "aether",
        model: "other-model",
        thinkingRequest: "enabled",
        reasoningEffort: "low"
      }
    ],
    [
      "关闭时携带 effort",
      {
        ...spec,
        provider: "aether",
        model: "deepseek-v4-flash",
        thinkingRequest: "disabled",
        reasoningEffort: "low"
      }
    ],
    [
      "关闭时缺 provider",
      { ...spec, model: "deepseek-v4-flash", thinkingRequest: "disabled" }
    ],
    [
      "关闭时使用其它 provider",
      { ...spec, provider: "dashscope", model: "deepseek-v4-flash", thinkingRequest: "disabled" }
    ],
    [
      "关闭时使用其它 model",
      { ...spec, provider: "aether", model: "other-model", thinkingRequest: "disabled" }
    ],
    ["缺省请求却携带 effort", { ...spec, reasoningEffort: "low" }],
    ["未支持的请求模式", { ...spec, thinkingRequest: "automatic" }],
    [
      "未支持的 effort",
      {
        ...spec,
        provider: "aether",
        model: "deepseek-v4-flash",
        thinkingRequest: "enabled",
        reasoningEffort: "medium"
      }
    ]
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

  it("显式输出 token 上限按 OpenAI compatible 字段发送，未传时保持字段缺失", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return completionResponse("答案");
    });

    await chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock }, { maxOutputTokens: 2_048 });
    await chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock });

    expect(requestBodies[0]?.max_tokens).toBe(2_048);
    expect(requestBodies[1]).not.toHaveProperty("max_tokens");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, maximumExplicitLlmOutputTokens + 1])(
    "输出 token 上限 %s 非法时在发请求前拒绝",
    async (maxOutputTokens) => {
      const fetchMock = vi.fn(async () => completionResponse("不应调用"));
      await expect(
        chatComplete(
          provider,
          spec,
          [],
          { ...runtime, fetch: fetchMock },
          { maxOutputTokens }
        )
      ).rejects.toBeInstanceOf(RangeError);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

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
      substage: "duplicate_done",
      invalidEvents: ["data: [DONE]", "", "data: [DONE]", "", ""].join("\n")
    },
    {
      substage: "data_after_done",
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
      ),
      () => new LlmResponseBodyTooLargeError(
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
      expectedCancelled: false
    },
    {
      mode: "cancelled",
      expectedCode: "LLM_CANCELLED",
      expectedCancelled: true
    },
    {
      mode: "body_too_large",
      expectedCode: "LLM_RESPONSE_BODY_TOO_LARGE",
      expectedCancelled: true
    }
  ] as const)(
    "终止序列首错在排空异常后仍保留封闭子阶段：$mode",
    async ({ mode, expectedCode, expectedCancelled }) => {
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
      } else {
        streamController.enqueue(new Uint8Array(maximumLlmResponseBodyBytes));
      }

      const error = await resultPromise.catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: expectedCode,
        formatFailureStage: "trailing_data",
        formatFailureSubstage: "duplicate_done"
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

  it("协议首错后的排空仍受累计字节上限约束，超限时取消且保留首错阶段", async () => {
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
    streamController.enqueue(new Uint8Array(maximumLlmResponseBodyBytes));

    await expect(resultPromise).rejects.toMatchObject({
      code: "LLM_RESPONSE_BODY_TOO_LARGE",
      formatFailureStage: "event_json"
    });
    expect(cancelled).toBe(true);
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
          reasoningEffort: "low"
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

  it("SSE 心跳不会刷新已开始输出后的停顿时间", async () => {
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
      streamController.enqueue(
        encoder.encode('data: {"choices":[{"delta":{"content":"有效输出"}}]}\n\n')
      );
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: "LLM_OUTPUT_IDLE_TIMEOUT"
      });
      await vi.advanceTimersByTimeAsync(900);
      streamController.enqueue(encoder.encode(": heartbeat\n\n"));
      await vi.advanceTimersByTimeAsync(101);
      await rejection;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("role-only 事件不算首个有效模型输出", async () => {
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
        formatFailureSubstage: "duplicate_done"
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
      expect(cancelled).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("持续排空也不能延长既有 maximumDuration 最终边界", async () => {
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
        maximumDurationMs: 2_500,
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
        code: "LLM_TOTAL_TIMEOUT",
        formatFailureStage: "event_json"
      });
      await vi.advanceTimersByTimeAsync(701);
      await rejection;
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
        maximumDurationMs: 2_500,
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

describe("chatComplete：响应正文大小限制", () => {
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

  it("正文恰好等于固定字节上限时允许读取", async () => {
    const prefix = '{"choices":[{"message":{"content":"';
    const suffix = '"},"finish_reason":"stop"}]}';
    const fixedBytes = new TextEncoder().encode(prefix + suffix).byteLength;
    const content = "a".repeat(maximumLlmResponseBodyBytes - fixedBytes);
    const responseBody = prefix + content + suffix;
    expect(new TextEncoder().encode(responseBody).byteLength).toBe(
      maximumLlmResponseBodyBytes
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
    expect(result.content.length).toBe(content.length);
  });

  it("按 UTF-8 字节拒绝超限正文，取消流且不重试或泄露内容", async () => {
    const sensitiveBody = "不应进入异常或日志的正文";
    const sensitiveCancelError = "不应进入异常或日志的取消错误";
    const oversizedText =
      sensitiveBody +
      "题".repeat(Math.floor(maximumLlmResponseBodyBytes / 3) + 1);
    expect(oversizedText.length).toBeLessThan(maximumLlmResponseBodyBytes);
    const oversizedBytes = new TextEncoder().encode(oversizedText);
    expect(oversizedBytes.byteLength).toBeGreaterThan(maximumLlmResponseBodyBytes);
    const splitAt = Math.floor(oversizedBytes.byteLength / 2);
    const firstChunk = oversizedBytes.slice(0, splitAt);
    const secondChunk = oversizedBytes.slice(splitAt);
    expect(firstChunk.byteLength).toBeLessThan(maximumLlmResponseBodyBytes);
    expect(secondChunk.byteLength).toBeLessThan(maximumLlmResponseBodyBytes);

    let cancelled = false;
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(firstChunk);
            controller.enqueue(secondChunk);
          },
          cancel() {
            cancelled = true;
            return Promise.reject(new Error(sensitiveCancelError));
          }
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
    );
    const error = await chatComplete(provider, spec, [], {
      ...runtime,
      fetch: fetchMock
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LlmResponseBodyTooLargeError);
    expect(error).toMatchObject({ code: "LLM_RESPONSE_BODY_TOO_LARGE" });
    expect((error as Error).message).not.toContain(sensitiveBody);
    expect((error as Error).message).not.toContain(sensitiveCancelError);
    expect(cancelled).toBe(true);
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      logError("模型响应过大", error);
      const output = write.mock.calls.map(([value]) => String(value)).join("");
      expect(output).toContain('errorCode="LLM_RESPONSE_BODY_TOO_LARGE"');
      expect(output).not.toContain(sensitiveBody);
      expect(output).not.toContain(sensitiveCancelError);
    } finally {
      write.mockRestore();
    }
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

  it("429 的等待和后续尝试共用同一个最终保护时长", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        async () => new Response("rate limited", { status: 429 })
      );
      const resultPromise = chatComplete(provider, spec, [], {
        outputIdleTimeoutMs: 1_000,
        firstOutputTimeoutMs: 1_000,
        maximumDurationMs: 2_500,
        maxAttempts: 10,
        baseDelayMs: 2_000,
        fetch: fetchMock
      });
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: "LLM_TOTAL_TIMEOUT"
      });

      await vi.advanceTimersByTimeAsync(2_501);
      await rejection;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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

  it("网络异常不自动重发，因为无法证明模型服务没有开始生成", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(
      chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock })
    ).rejects.toMatchObject({ code: "LLM_NETWORK_FAILED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("能从代码块里抠出 JSON", async () => {
    const fetchMock = vi.fn(async () => completionResponse('这是结果：\n```json\n{"rating": 1600}\n```'));
    const result = await chatCompleteJson(provider, spec, [], resultSchema, { ...runtime, fetch: fetchMock });
    expect(result.data).toEqual({ rating: 1600 });
  });

  it("第一次不合法时会带着错误信息重试一次，第二次成功就返回", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.max_tokens).toBe(2_048);
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.reasoning_effort).toBe("low");
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
        reasoningEffort: "low"
      },
      [],
      resultSchema,
      { ...runtime, fetch: fetchMock },
      { maxOutputTokens: 2_048 }
    );
    expect(result.data).toEqual({ rating: 1400 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("非法输出 token 上限不会发出 JSON 首轮或修复轮请求", async () => {
    const fetchMock = vi.fn(async () => completionResponse('{"rating": 1500}'));
    await expect(
      chatCompleteJson(
        provider,
        spec,
        [],
        resultSchema,
        { ...runtime, fetch: fetchMock },
        { maxOutputTokens: 0 }
      )
    ).rejects.toBeInstanceOf(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
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
