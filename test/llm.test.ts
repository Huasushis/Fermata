import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  chatComplete,
  chatCompleteJson,
  LlmJsonOutputError,
  LlmRequestError,
  LlmResponseFormatError
} from "../src/llm";

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
    const fetchMock = vi.fn(async () => new Response("bad request", { status: 400 }));
    await expect(chatComplete(provider, spec, [], { ...runtime, fetch: fetchMock })).rejects.toBeInstanceOf(
      LlmRequestError
    );
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
    await expect(
      chatCompleteJson(provider, spec, [], resultSchema, { ...runtime, fetch: fetchMock })
    ).rejects.toBeInstanceOf(LlmJsonOutputError);
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
