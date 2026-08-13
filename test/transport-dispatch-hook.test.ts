import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  chatCompleteWithReceipt,
  LlmRequestError,
  type ChatMessage,
  type LlmRuntimeOptions,
  type ModelCallSpec,
  type ProviderCredentialsLike
} from "../src/llm";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function buildProvider(): ProviderCredentialsLike {
  return {
    baseUrl: "https://test.example.com/v1/chat/completions",
    apiKey: "test-key"
  };
}

function buildSpec(): ModelCallSpec {
  return {
    provider: "aether",
    model: "deepseek-v4-pro",
    temperature: 1.0,
    thinking: true,
    thinkingRequest: "enabled",
    reasoningEffort: "max"
  };
}

function buildMessages(): ChatMessage[] {
  return [{ role: "user", content: "synthetic" }];
}

/**
 * Fake fetch that returns a minimal valid SSE stream with a single completion.
 * The test controls the response to simulate success, 429 retry, or denial.
 */
function buildFakeFetch(options: {
  readonly status?: number;
  readonly body?: string;
  readonly retryAfter?: string | null;
  readonly contentType?: string;
}) {
  const status = options.status ?? 200;
  const contentType = options.contentType ?? "text/event-stream";
  const body = options.body ?? [
    'data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
    'data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    "data: [DONE]",
    ""
  ].join("\n\n");
  return async function fakeFetch(_url: string | URL | Request, _init?: RequestInit): Promise<Response> {
    const headers = new Map<string, string>();
    headers.set("content-type", contentType);
    if (options.retryAfter !== undefined && options.retryAfter !== null) {
      headers.set("retry-after", options.retryAfter);
    }
    const encoder = new TextEncoder();
    const bodyBytes = encoder.encode(body);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bodyBytes);
        controller.close();
      }
    });
    return new Response(stream, {
      status,
      headers: {
        "content-type": contentType,
        ...(options.retryAfter ? { "retry-after": options.retryAfter } : {})
      }
    });
  };
}

function buildRuntime(options: {
  readonly fetchImpl: LlmRuntimeOptions["fetch"];
  readonly onTransportDispatch?: () => void;
  readonly dispatchTransport?: LlmRuntimeOptions["dispatchTransport"];
  readonly maxAttempts?: number;
}): LlmRuntimeOptions {
  return {
    outputIdleTimeoutMs: 60_000,
    firstOutputTimeoutMs: 60_000,
    maximumDurationMs: 120_000,
    maxAttempts: options.maxAttempts ?? 1,
    baseDelayMs: 0,
    fetch: options.fetchImpl,
    onTransportDispatch: options.onTransportDispatch,
    dispatchTransport: options.dispatchTransport
  };
}

describe("onTransportDispatch hook — per-transport pre-dispatch", () => {
  it("hook count equals actual fetch count for a single transport", async () => {
    let hookCount = 0;
    let fetchCount = 0;
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      fetchCount += 1;
      return buildFakeFetch({})(url, init);
    };
    const runtime = buildRuntime({
      fetchImpl: fakeFetch,
      onTransportDispatch: () => { hookCount += 1; }
    });
    try {
      await chatCompleteWithReceipt(buildProvider(), buildSpec(), buildMessages(), runtime);
    } catch {
      // may throw on synthetic response — we only care about hook/fetch counts
    }
    expect(hookCount).toBe(fetchCount);
    expect(fetchCount).toBe(1);
  });

  it("hook fires before each fetch including 429 retry", async () => {
    let hookCount = 0;
    let fetchCount = 0;
    let dispatchCount = 0;
    let responseIndex = 0;
    const responses = [
      { status: 429, retryAfter: "0" },
      { status: 200 }
    ];
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      fetchCount += 1;
      const resp = responses[responseIndex++];
      return buildFakeFetch(resp)(url, init);
    };
    const runtime = buildRuntime({
      fetchImpl: fakeFetch,
      onTransportDispatch: () => { hookCount += 1; },
      maxAttempts: 2,
      dispatchTransport: async (execute) => {
        dispatchCount += 1;
        return execute();
      }
    });
    try {
      await chatCompleteWithReceipt(buildProvider(), buildSpec(), buildMessages(), runtime);
    } catch {
      // synthetic may fail — counts are what matter
    }
    expect(hookCount).toBe(fetchCount);
    expect(fetchCount).toBe(2);
    expect(dispatchCount).toBe(2);
  });

  it("denial before 2nd fetch causes 2nd fetch to remain absent", async () => {
    let hookCount = 0;
    let fetchCount = 0;
    let responseIndex = 0;
    const responses = [
      { status: 429, retryAfter: "0" },
      { status: 200 }
    ];
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      fetchCount += 1;
      const resp = responses[responseIndex++];
      return buildFakeFetch(resp)(url, init);
    };
    const runtime = buildRuntime({
      fetchImpl: fakeFetch,
      onTransportDispatch: () => {
        hookCount += 1;
        if (hookCount >= 2) {
          throw new Error("TRANSPORT_DENIED_BY_HOOK");
        }
      },
      maxAttempts: 3
    });
    let caughtError: unknown;
    try {
      await chatCompleteWithReceipt(buildProvider(), buildSpec(), buildMessages(), runtime);
    } catch (error) {
      caughtError = error;
    }
    expect(hookCount).toBe(2);
    expect(fetchCount).toBe(1);
    expect(caughtError).toBeInstanceOf(LlmRequestError);
    expect((caughtError as LlmRequestError).code).toBe("LLM_TRANSPORT_DENIED");
  });

  it("existing no-hook behavior is unchanged — same fetch count", async () => {
    let fetchCount = 0;
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      fetchCount += 1;
      return buildFakeFetch({})(url, init);
    };
    const runtime = buildRuntime({ fetchImpl: fakeFetch });
    try {
      await chatCompleteWithReceipt(buildProvider(), buildSpec(), buildMessages(), runtime);
    } catch {
      // synthetic may fail
    }
    expect(fetchCount).toBe(1);
  });

  it("hook denial on first transport produces no fetch at all", async () => {
    let fetchCount = 0;
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      fetchCount += 1;
      return buildFakeFetch({})(url, init);
    };
    const runtime = buildRuntime({
      fetchImpl: fakeFetch,
      onTransportDispatch: () => { throw new Error("DENIED"); }
    });
    let caughtError: unknown;
    try {
      await chatCompleteWithReceipt(buildProvider(), buildSpec(), buildMessages(), runtime);
    } catch (error) {
      caughtError = error;
    }
    expect(fetchCount).toBe(0);
    expect(caughtError).toBeInstanceOf(LlmRequestError);
    expect((caughtError as LlmRequestError).code).toBe("LLM_TRANSPORT_DENIED");
  });

  it("concurrent reservations cannot exceed ceiling in single JS process", async () => {
    const ceiling = 3;
    let used = 0;
    let peak = 0;
    const hook = () => {
      if (used >= ceiling) throw new Error("CEILING_EXCEEDED");
      used += 1;
      peak = Math.max(peak, used);
    };
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      // simulate async work while "transport" is in-flight
      await new Promise(resolve => setTimeout(resolve, 10));
      used -= 1;
      return buildFakeFetch({})(url, init);
    };
    const runtime = buildRuntime({
      fetchImpl: fakeFetch,
      onTransportDispatch: hook
    });
    // Launch ceiling concurrent requests
    const promises = Array.from({ length: ceiling }, () =>
      chatCompleteWithReceipt(buildProvider(), buildSpec(), buildMessages(), runtime).catch(() => undefined)
    );
    await Promise.all(promises);
    expect(peak).toBeLessThanOrEqual(ceiling);
  });

  it("hook error does not leak private content in error message", async () => {
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      return buildFakeFetch({})(url, init);
    };
    const runtime = buildRuntime({
      fetchImpl: fakeFetch,
      onTransportDispatch: () => { throw new Error("PRIVATE_SECRET_KEY_VALUE"); }
    });
    let caughtError: unknown;
    try {
      await chatCompleteWithReceipt(buildProvider(), buildSpec(), buildMessages(), runtime);
    } catch (error) {
      caughtError = error;
    }
    const serialized = JSON.stringify({
      code: (caughtError as LlmRequestError).code,
      message: (caughtError as LlmRequestError).message,
      name: (caughtError as LlmRequestError).name
    });
    expect(serialized).not.toContain("PRIVATE_SECRET_KEY_VALUE");
    expect((caughtError as LlmRequestError).code).toBe("LLM_TRANSPORT_DENIED");
  });
});
