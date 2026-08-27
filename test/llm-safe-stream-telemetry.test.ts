import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatComplete,
  type LlmSafeStreamTelemetryEvent
} from "../src/llm";

const provider = {
  baseUrl: "https://llm.example.test/v1",
  apiKey: "synthetic-key"
};
const spec = { model: "synthetic-model", temperature: 0, thinking: false };
const encoder = new TextEncoder();

function runtime(
  fetch: typeof globalThis.fetch,
  onEvent?: (event: LlmSafeStreamTelemetryEvent) => void,
  signal?: AbortSignal
) {
  return {
    outputIdleTimeoutMs: 30_000,
    firstOutputTimeoutMs: 30_000,
    maximumDurationMs: 30_000,
    maxAttempts: 1,
    baseDelayMs: 1,
    fetch,
    ...(onEvent === undefined
      ? {}
      : { safeStreamTelemetry: { role: "solver" as const, onEvent } }),
    ...(signal === undefined ? {} : { signal })
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("calibration safe stream telemetry", () => {
  it("A: continuous growth records rate-limited cumulative progress", async () => {
    vi.useFakeTimers();
    const events: LlmSafeStreamTelemetryEvent[] = [];
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        }
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    ));
    const resultPromise = chatComplete(
      provider,
      spec,
      [],
      runtime(fetchMock, (event) => events.push(event))
    );

    await flushMicrotasks();
    streamController.enqueue(encoder.encode(
      'data: {"choices":[{"delta":{"content":"first"}}]}\n\n'
    ));
    await flushMicrotasks();
    const first = events.find((event) => event.stage === "first_chunk");
    expect(first).toBeDefined();
    expect(events[0]).toMatchObject({ stage: "headers", statusClass: "2xx" });
    streamController.enqueue(encoder.encode(
      'data: {"choices":[{"delta":{"content":"middle"}}]}\n\n'
    ));
    await flushMicrotasks();
    expect(events.some((event) => event.stage === "progress")).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    streamController.enqueue(encoder.encode(
      'data: {"choices":[{"delta":{"content":"second"},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n"
    ));
    streamController.close();

    await expect(resultPromise).resolves.toEqual({
      content: "firstmiddlesecond",
      reasoning: null
    });
    const progress = events.find((event) => event.stage === "progress");
    expect(progress).toBeDefined();
    expect(progress!.bytes).toBeGreaterThan(first!.bytes);
    expect(progress!.elapsedMs).toBeGreaterThanOrEqual(first!.elapsedMs);
    expect(progress!.lastDataMs).toBe(progress!.elapsedMs);
    expect(events.map((event) => event.stage)).toContain("done");
    expect(events.map((event) => event.stage)).toContain("eof");
    expect(events.every((event, index) =>
      index === 0 || event.elapsedMs >= events[index - 1]!.elapsedMs
    )).toBe(true);
  });

  it("B: a stalled reader emits a durable pending state before abort", async () => {
    vi.useFakeTimers();
    const events: LlmSafeStreamTelemetryEvent[] = [];
    const requestController = new AbortController();
    const fetchMock = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({}),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    ));
    const resultPromise = chatComplete(
      provider,
      spec,
      [],
      runtime(fetchMock, (event) => events.push(event), requestController.signal)
    );

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5_000);
    const pending = events.find((event) => event.stage === "pending");
    expect(pending).toMatchObject({
      bytes: 0,
      lastDataMs: null,
      readerPending: true,
      done: false,
      eof: false,
      abort: false
    });

    requestController.abort();
    await expect(resultPromise).rejects.toMatchObject({ code: "LLM_CANCELLED" });
    expect(events.find((event) => event.stage === "abort")).toMatchObject({
      abort: true,
      readerPending: true
    });
  });

  it("C: EOF without DONE remains explicitly distinguishable", async () => {
    const events: LlmSafeStreamTelemetryEvent[] = [];
    const fetchMock = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"complete"},"finish_reason":"stop"}]}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    ));

    await expect(chatComplete(
      provider,
      spec,
      [],
      runtime(fetchMock, (event) => events.push(event))
    )).resolves.toEqual({ content: "complete", reasoning: null });

    expect(events.some((event) => event.stage === "done")).toBe(false);
    expect(events.find((event) => event.stage === "eof")).toMatchObject({
      done: false,
      eof: true,
      readerPending: false,
      abort: false
    });
  });

  it("records a reader error without retaining its value", async () => {
    const events: LlmSafeStreamTelemetryEvent[] = [];
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        }
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    ));
    const resultPromise = chatComplete(
      provider,
      spec,
      [],
      runtime(fetchMock, (event) => events.push(event))
    );

    await flushMicrotasks();
    streamController.error(new Error("synthetic stream failure"));
    await expect(resultPromise).rejects.toMatchObject({ code: "LLM_NETWORK_FAILED" });
    expect(events.find((event) => event.stage === "reader_error")).toMatchObject({
      bytes: 0,
      done: false,
      eof: false,
      readerPending: true,
      abort: false
    });
  });

  it("disabled telemetry creates no interval or callback path", async () => {
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const fetchMock = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"complete"},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n",
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    ));

    await expect(chatComplete(provider, spec, [], runtime(fetchMock))).resolves.toEqual({
      content: "complete",
      reasoning: null
    });
    expect(intervalSpy).not.toHaveBeenCalled();
  });
});
