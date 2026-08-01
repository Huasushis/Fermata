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
});

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
