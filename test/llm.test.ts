import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  chatComplete,
  chatCompleteJson,
  LlmJsonOutputError,
  LlmRequestError,
  LlmResponseBodyTooLargeError,
  LlmResponseFormatError,
  maximumLlmResponseBodyBytes
} from "../src/llm";
import { logError } from "../src/logger";

const provider = { baseUrl: "https://llm.example.test/v1", apiKey: "sk-test" };
const spec = { model: "test-model", temperature: 0.2, thinking: false };
const runtime = { timeoutMs: 5_000, maxAttempts: 3, baseDelayMs: 1 };

function completionResponse(content: string, reasoning?: string): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content, ...(reasoning === undefined ? {} : { reasoning_content: reasoning }) }
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
      return completionResponse("这是回答", "这是推理过程");
    });
    const result = await chatComplete(provider, spec, [{ role: "user", content: "你好" }], {
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

  it("requestJson 时请求体带 response_format", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.response_format).toEqual({ type: "json_object" });
      return completionResponse('{"ok":true}');
    });
    await chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock }, { requestJson: true });
  });
});

describe("chatComplete：响应正文大小限制", () => {
  it("UTF-8 多字节字符跨数据块时仍能正确解析", async () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify({
        choices: [{ message: { content: "分块中文回答" } }]
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
    const suffix = '"}}]}';
    const fixedBytes = new TextEncoder().encode(prefix + suffix).byteLength;
    const content = "a".repeat(maximumLlmResponseBodyBytes - fixedBytes);
    const responseBody = prefix + content + suffix;
    expect(new TextEncoder().encode(responseBody).byteLength).toBe(
      maximumLlmResponseBodyBytes
    );
    const fetchMock = vi.fn(async () => new Response(responseBody, { status: 200 }));
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
          status: 503,
          headers: { "Content-Length": "1" }
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

describe("chatComplete：429/5xx 指数退避重试", () => {
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

  it("用尽 maxAttempts 次仍然失败时抛出 LlmRequestError 并带上状态码", async () => {
    const fetchMock = vi.fn(async () => new Response("server error", { status: 503 }));
    await expect(chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock })).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(LlmRequestError);
        expect((error as LlmRequestError).status).toBe(503);
        return true;
      }
    );
    expect(fetchMock).toHaveBeenCalledTimes(runtime.maxAttempts);
  });

  it("非 429/5xx 的错误状态码（比如 400）不重试，直接失败", async () => {
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

  it("fetch 本身抛异常（网络错误/超时）也会按同样的退避重试", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls < 2) {
        throw new Error("ECONNRESET");
      }
      return completionResponse("恢复了");
    });
    const result = await chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock });
    expect(result.content).toBe("恢复了");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("重试耗尽时不把底层网络错误原文放进异常", async () => {
    const sensitiveNetworkMessage = "不应进入日志的外部错误正文";
    const fetchMock = vi.fn(async () => {
      throw new Error(sensitiveNetworkMessage);
    });
    const error = await chatComplete(provider, spec, [], {
      timeoutMs: 5_000,
      maxAttempts: 1,
      baseDelayMs: 1,
      fetch: fetchMock
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "LLM_REQUEST_FAILED" });
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
        timeoutMs: 1_000,
        maxAttempts: 1,
        baseDelayMs: 1,
        fetch: fetchMock
      });
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: "LLM_REQUEST_FAILED"
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
      const error = await resultPromise.catch((caught: unknown) => caught);
      expect((error as Error).message).not.toContain(sensitiveBodyError);
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
});

const resultSchema = z.object({ rating: z.number().int() }).strict();

describe("chatCompleteJson：结构化输出与一次修复重试", () => {
  it("第一次就是合法 JSON 时直接返回", async () => {
    const fetchMock = vi.fn(async () => completionResponse('{"rating": 1500}'));
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
      calls += 1;
      if (calls === 1) {
        return completionResponse("抱歉，我不知道怎么用 JSON 回答");
      }
      const body = JSON.parse(String(init?.body));
      // 第二次请求应该包含第一次的坏输出和纠正提示，让模型知道错在哪。
      const joined = body.messages.map((m: { content: string }) => m.content).join("\n");
      expect(joined).toContain("不知道怎么用 JSON 回答");
      return completionResponse('{"rating": 1400}');
    });
    const result = await chatCompleteJson(provider, spec, [], resultSchema, { ...runtime, fetch: fetchMock });
    expect(result.data).toEqual({ rating: 1400 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
