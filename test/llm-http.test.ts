import { createServer, type Server } from "node:http";
import { Agent, EnvHttpProxyAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { chatComplete, createUndiciLlmFetch } from "../src/llm";

const dispatchers: Array<Agent | EnvHttpProxyAgent> = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map(async (dispatcher) => {
    await dispatcher.close();
  }));
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("LLM 生产 HTTP 传输层", () => {
  it("每次请求都禁用 Undici 的隐含响应头和正文超时", async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.flushHeaders();
        setTimeout(() => {
          response.end(JSON.stringify({
            choices: [{
              message: { role: "assistant", content: "延迟后仍完整" },
              finish_reason: "stop"
            }]
          }));
        }, 75);
      }, 75);
    });
    const baseUrl = await listen(server);
    const dispatcher = new Agent({
      // 如果生产适配器没有在单次请求上明确传 0，下面响应头和
      // 正文之间的 75ms 停顿会分别触发这两个底层超时。
      headersTimeout: 25,
      bodyTimeout: 25,
      connectTimeout: 1_000
    });
    dispatchers.push(dispatcher);

    await expect(chatComplete(
      { baseUrl: `${baseUrl}/v1`, apiKey: "local-test-key" },
      { model: "local-model", temperature: 0, thinking: false },
      [{ role: "user", content: "合成测试" }],
      {
        outputIdleTimeoutMs: 1_000,
        firstOutputTimeoutMs: 1_000,
        maximumDurationMs: 2_000,
        maxAttempts: 1,
        baseDelayMs: 1,
        fetch: createUndiciLlmFetch(dispatcher)
      }
    )).resolves.toEqual({
      content: "延迟后仍完整",
      reasoning: null
    });
  });

  it("代理 Dispatcher 会对 noProxy 命中的目标使用直连", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: { role: "assistant", content: "本地直连成功" },
          finish_reason: "stop"
        }]
      }));
    });
    const baseUrl = await listen(server);
    const dispatcher = new EnvHttpProxyAgent({
      httpProxy: "http://127.0.0.1:1",
      httpsProxy: "http://127.0.0.1:1",
      noProxy: "127.0.0.1",
      connectTimeout: 1_000,
      headersTimeout: 25,
      bodyTimeout: 25
    });
    dispatchers.push(dispatcher);

    await expect(chatComplete(
      { baseUrl: `${baseUrl}/v1`, apiKey: "local-test-key" },
      { model: "local-model", temperature: 0, thinking: false },
      [],
      {
        outputIdleTimeoutMs: 1_000,
        firstOutputTimeoutMs: 1_000,
        maximumDurationMs: 2_000,
        maxAttempts: 1,
        baseDelayMs: 1,
        fetch: createUndiciLlmFetch(dispatcher)
      }
    )).resolves.toMatchObject({ content: "本地直连成功" });
  });

  it("代理 Dispatcher 会把 HTTP 目标请求发给配置的代理", async () => {
    let proxyReceivedRequest = false;
    const proxy = createServer((request, response) => {
      proxyReceivedRequest = request.url?.startsWith(
        "http://model.invalid/v1/chat/completions"
      ) === true;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: { role: "assistant", content: "代理路径成功" },
          finish_reason: "stop"
        }]
      }));
    });
    const proxyUrl = await listen(proxy);
    const dispatcher = new EnvHttpProxyAgent({
      httpProxy: proxyUrl,
      httpsProxy: proxyUrl,
      noProxy: "",
      connectTimeout: 1_000
    });
    dispatchers.push(dispatcher);

    await expect(chatComplete(
      { baseUrl: "http://model.invalid/v1", apiKey: "local-test-key" },
      { model: "local-model", temperature: 0, thinking: false },
      [],
      {
        outputIdleTimeoutMs: 1_000,
        firstOutputTimeoutMs: 1_000,
        maximumDurationMs: 2_000,
        maxAttempts: 1,
        baseDelayMs: 1,
        fetch: createUndiciLlmFetch(dispatcher)
      }
    )).resolves.toMatchObject({ content: "代理路径成功" });
    expect(proxyReceivedRequest).toBe(true);
  });

  it("大且持续分块的 404 正文只留下固定状态，清理后仍能继续请求", async () => {
    let requestCount = 0;
    let errorBodyClosed = false;
    const server = createServer((_request, response) => {
      requestCount += 1;
      if (requestCount === 1) {
        response.writeHead(404, "provider-private-status", {
          "Content-Type": "application/json",
          "X-Provider-Error": "provider-private-header"
        });
        response.flushHeaders();
        const chunk = Buffer.alloc(512 * 1024, 0x78);
        response.write(chunk);
        const timer = setInterval(() => {
          response.write(chunk);
        }, 10);
        response.once("close", () => {
          clearInterval(timer);
          errorBodyClosed = true;
        });
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: { role: "assistant", content: "错误响应后仍可用" },
          finish_reason: "stop"
        }]
      }));
    });
    const baseUrl = await listen(server);
    const dispatcher = new Agent({ connectTimeout: 1_000 });
    dispatchers.push(dispatcher);
    const undiciFetch = createUndiciLlmFetch(dispatcher);
    let errorResponseBody: ReadableStream<Uint8Array> | null | undefined;
    let errorResponseStatusText: string | undefined;
    let errorResponseHeaders: Array<[string, string]> | undefined;
    const inspectingFetch = async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      const response = await undiciFetch(input, init);
      if (!response.ok) {
        errorResponseBody = response.body;
        errorResponseStatusText = response.statusText;
        errorResponseHeaders = Array.from(response.headers.entries());
      }
      return response;
    };

    const observed = await captureProcessAsyncFailures(async () => {
      const error = await chatComplete(
        { baseUrl: `${baseUrl}/v1`, apiKey: "local-test-key" },
        { model: "local-model", temperature: 0, thinking: false },
        [],
        {
          outputIdleTimeoutMs: 1_000,
          firstOutputTimeoutMs: 1_000,
          maximumDurationMs: 2_000,
          maxAttempts: 3,
          baseDelayMs: 1,
          fetch: inspectingFetch
        }
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: "LLM_HTTP_ERROR",
        status: 404,
        message: "模型服务返回了错误状态。"
      });
      expect(requestCount).toBe(1);

      return chatComplete(
        { baseUrl: `${baseUrl}/v1`, apiKey: "local-test-key" },
        { model: "local-model", temperature: 0, thinking: false },
        [],
        {
          outputIdleTimeoutMs: 1_000,
          firstOutputTimeoutMs: 1_000,
          maximumDurationMs: 2_000,
          maxAttempts: 1,
          baseDelayMs: 1,
          fetch: undiciFetch
        }
      );
    });

    expect(observed.result).toEqual({
      content: "错误响应后仍可用",
      reasoning: null
    });
    expect(errorResponseBody).toBeNull();
    expect(errorResponseStatusText).toBe("");
    expect(errorResponseHeaders).toEqual([]);
    expect(errorBodyClosed).toBe(true);
    expect(requestCount).toBe(2);
    expect(observed.uncaughtExceptions).toEqual([]);
    expect(observed.unhandledRejections).toEqual([]);
  });

  it("慢速分块 429 安全重试，成功流仍等待真正 EOF，后续请求仍可用", async () => {
    let requestCount = 0;
    let rateLimitBodyClosed = false;
    let markSuccessfulStreamStarted!: () => void;
    const successfulStreamStarted = new Promise<void>((resolve) => {
      markSuccessfulStreamStarted = resolve;
    });
    let releaseSuccessfulEof!: () => void;
    const successfulEof = new Promise<void>((resolve) => {
      releaseSuccessfulEof = resolve;
    });
    const server = createServer((_request, response) => {
      requestCount += 1;
      if (requestCount === 1) {
        response.writeHead(429, "provider-private-status", {
          "Content-Type": "application/json",
          "X-Provider-Error": "provider-private-header"
        });
        response.flushHeaders();
        const chunk = Buffer.alloc(512 * 1024, 0x79);
        response.write(chunk);
        const timer = setInterval(() => {
          response.write(chunk);
        }, 10);
        response.once("close", () => {
          clearInterval(timer);
          rateLimitBodyClosed = true;
        });
        return;
      }
      if (requestCount === 2) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(
          'data: {"choices":[{"delta":{"content":"限流后完整"},"finish_reason":"stop"}]}\n\n'
        );
        response.write("data: [DONE]\n\n");
        markSuccessfulStreamStarted();
        void successfulEof.then(() => {
          response.end();
        });
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: { role: "assistant", content: "后续请求可用" },
          finish_reason: "stop"
        }]
      }));
    });
    const baseUrl = await listen(server);
    const dispatcher = new Agent({ connectTimeout: 1_000 });
    dispatchers.push(dispatcher);
    const undiciFetch = createUndiciLlmFetch(dispatcher);
    const nonSuccessResponses: Array<{
      readonly status: number;
      readonly body: ReadableStream<Uint8Array> | null;
      readonly statusText: string;
      readonly headers: Array<[string, string]>;
    }> = [];
    const inspectingFetch = async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      const response = await undiciFetch(input, init);
      if (!response.ok) {
        nonSuccessResponses.push({
          status: response.status,
          body: response.body,
          statusText: response.statusText,
          headers: Array.from(response.headers.entries())
        });
      }
      return response;
    };

    const observed = await captureProcessAsyncFailures(async () => {
      let retrySettled = false;
      const retried = chatComplete(
        { baseUrl: `${baseUrl}/v1`, apiKey: "local-test-key" },
        { model: "local-model", temperature: 0, thinking: false },
        [],
        {
          outputIdleTimeoutMs: 1_000,
          firstOutputTimeoutMs: 1_000,
          maximumDurationMs: 2_000,
          maxAttempts: 2,
          baseDelayMs: 1,
          fetch: inspectingFetch
        }
      );
      void retried.then(
        () => {
          retrySettled = true;
        },
        () => {
          retrySettled = true;
        }
      );
      await successfulStreamStarted;
      await nextEventLoopTurn();
      expect(retrySettled).toBe(false);
      releaseSuccessfulEof();
      const retriedResult = await retried;

      const followingResult = await chatComplete(
        { baseUrl: `${baseUrl}/v1`, apiKey: "local-test-key" },
        { model: "local-model", temperature: 0, thinking: false },
        [],
        {
          outputIdleTimeoutMs: 1_000,
          firstOutputTimeoutMs: 1_000,
          maximumDurationMs: 2_000,
          maxAttempts: 1,
          baseDelayMs: 1,
          fetch: undiciFetch
        }
      );
      return { retriedResult, followingResult };
    });

    expect(observed.result).toEqual({
      retriedResult: { content: "限流后完整", reasoning: null },
      followingResult: { content: "后续请求可用", reasoning: null }
    });
    expect(nonSuccessResponses).toEqual([{
      status: 429,
      body: null,
      statusText: "",
      headers: []
    }]);
    expect(rateLimitBodyClosed).toBe(true);
    expect(requestCount).toBe(3);
    expect(observed.uncaughtExceptions).toEqual([]);
    expect(observed.unhandledRejections).toEqual([]);
  });

  it("DeepSeek V4 thinking 请求通过真实 HTTP 传输发送 thinking.type=enabled、reasoning_effort=max、max_tokens=256000", async () => {
    let observedBody: Record<string, unknown> | undefined;
    const server = createServer((_request, response) => {
      let chunks = "";
      _request.on("data", (chunk: Buffer) => { chunks += chunk.toString(); });
      _request.on("end", () => {
        observedBody = JSON.parse(chunks) as Record<string, unknown>;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          choices: [{
            message: { role: "assistant", content: "合成回答" },
            finish_reason: "stop"
          }]
        }));
      });
    });
    const baseUrl = await listen(server);
    const dispatcher = new Agent({ connectTimeout: 1_000 });
    dispatchers.push(dispatcher);

    const result = await chatComplete(
      { baseUrl: `${baseUrl}/v1`, apiKey: "local-test-key" },
      {
        provider: "aether",
        model: "deepseek-v4-pro",
        temperature: 0.1,
        thinking: true,
        thinkingRequest: "enabled",
        reasoningEffort: "max"
      },
      [{ role: "user", content: "合成测试" }],
      {
        outputIdleTimeoutMs: 1_000,
        firstOutputTimeoutMs: 1_000,
        maximumDurationMs: 2_000,
        maxAttempts: 1,
        baseDelayMs: 1,
        fetch: createUndiciLlmFetch(dispatcher)
      },
      { maxOutputTokens: 256_000 }
    );

    expect(result).toEqual({ content: "合成回答", reasoning: null });
    expect(observedBody).toBeDefined();
    expect(observedBody?.thinking).toEqual({ type: "enabled" });
    expect(observedBody?.reasoning_effort).toBe("max");
    expect(observedBody?.max_tokens).toBe(256_000);
    expect(observedBody?.stream).toBe(true);
  });

  it("DeepSeek V4 缺少 thinkingRequest 在 HTTP 请求前被拒绝", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "不应到达" }, finish_reason: "stop" }]
      }));
    });
    const baseUrl = await listen(server);
    const dispatcher = new Agent({ connectTimeout: 1_000 });
    dispatchers.push(dispatcher);

    await expect(
      chatComplete(
        { baseUrl: `${baseUrl}/v1`, apiKey: "local-test-key" },
        {
          provider: "aether",
          model: "deepseek-v4-pro",
          temperature: 0.1,
          thinking: true
        },
        [{ role: "user", content: "合成测试" }],
        {
          outputIdleTimeoutMs: 1_000,
          firstOutputTimeoutMs: 1_000,
          maximumDurationMs: 2_000,
          maxAttempts: 1,
          baseDelayMs: 1,
          fetch: createUndiciLlmFetch(dispatcher)
        },
        { maxOutputTokens: 131_072 }
      )
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("DeepSeek V4 enabled 但缺少 max reasoningEffort 在 HTTP 请求前被拒绝", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "不应到达" }, finish_reason: "stop" }]
      }));
    });
    const baseUrl = await listen(server);
    const dispatcher = new Agent({ connectTimeout: 1_000 });
    dispatchers.push(dispatcher);

    await expect(
      chatComplete(
        { baseUrl: `${baseUrl}/v1`, apiKey: "local-test-key" },
        {
          provider: "aether",
          model: "deepseek-v4-pro",
          temperature: 0.1,
          thinking: true,
          thinkingRequest: "enabled"
        },
        [{ role: "user", content: "合成测试" }],
        {
          outputIdleTimeoutMs: 1_000,
          firstOutputTimeoutMs: 1_000,
          maximumDurationMs: 2_000,
          maxAttempts: 1,
          baseDelayMs: 1,
          fetch: createUndiciLlmFetch(dispatcher)
        },
        { maxOutputTokens: 131_072 }
      )
    ).rejects.toBeInstanceOf(TypeError);
  });
});

async function captureProcessAsyncFailures<T>(
  action: () => Promise<T>
): Promise<{
  readonly result: T;
  readonly uncaughtExceptions: unknown[];
  readonly unhandledRejections: unknown[];
}> {
  const uncaughtExceptions: unknown[] = [];
  const unhandledRejections: unknown[] = [];
  const onUncaughtException = (error: unknown): void => {
    uncaughtExceptions.push(error);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    const result = await action();
    await nextEventLoopTurn();
    await nextEventLoopTurn();
    return { result, uncaughtExceptions, unhandledRejections };
  } finally {
    process.removeListener("uncaughtException", onUncaughtException);
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }
}

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("本地测试服务器未绑定 TCP 端口。");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
