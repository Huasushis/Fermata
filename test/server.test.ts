import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createManagementServer, type ManagementServerDeps, type SettingsStoreLike } from "../src/server";
import { SettingsConflictError } from "../src/settings-store";
import type { FermataPublicSettings } from "../src/urmotiv-schemas";

const managementToken = "test-management-token-1234567890";

function defaultSettings(): FermataPublicSettings {
  return {
    enabled: true,
    pollingIntervalSeconds: 30,
    maximumConcurrentTasks: 2,
    modelProfileName: "review-balanced",
    experimentVersion: "experiment-2026-07"
  };
}

/** 内存里的假 SettingsStore，行为和真实的 SettingsStore 一致，但不碰文件系统。 */
function createFakeSettingsStore(initial: FermataPublicSettings): SettingsStoreLike {
  let revision = 4;
  let settings = initial;
  return {
    get: () => ({ settings, revision }),
    update: (expectedRevision, next) => {
      if (expectedRevision !== revision) {
        throw new SettingsConflictError(expectedRevision, revision);
      }
      settings = next;
      revision += 1;
      return { settings, revision };
    }
  };
}

interface TestServer {
  readonly baseUrl: string;
  readonly deps: ManagementServerDeps;
  readonly wake: ReturnType<typeof vi.fn>;
  close(): Promise<void>;
}

function startTestServer(overrides: Partial<ManagementServerDeps> = {}): TestServer {
  const wake = vi.fn();
  const deps: ManagementServerDeps = {
    managementToken,
    settingsStore: createFakeSettingsStore(defaultSettings()),
    secretsConfigured: () => true,
    getWorkerStatus: () => ({ workerRunning: true, activeTasks: 1 }),
    wake,
    now: () => new Date("2026-07-26T00:00:00.000Z"),
    ...overrides
  };
  const server = createManagementServer(deps);
  server.listen(0);
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    deps,
    wake,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

let testServer: TestServer;

afterEach(async () => {
  await testServer.close();
});

describe("管理端口：鉴权", () => {
  it("没有 Authorization 头时返回 401", async () => {
    testServer = startTestServer();
    const response = await fetch(`${testServer.baseUrl}/api/v1/health`);
    expect(response.status).toBe(401);
  });

  it("令牌错误时返回 401", async () => {
    testServer = startTestServer();
    const response = await fetch(`${testServer.baseUrl}/api/v1/health`, {
      headers: { Authorization: "Bearer wrong-token" }
    });
    expect(response.status).toBe(401);
  });

  it("未知路径即使带对的令牌也返回 404", async () => {
    testServer = startTestServer();
    const response = await fetch(`${testServer.baseUrl}/api/v1/does-not-exist`, {
      headers: { Authorization: `Bearer ${managementToken}` }
    });
    expect(response.status).toBe(404);
  });
});

describe("GET /api/v1/health", () => {
  it("worker 在跑、密钥齐全时返回 ok", async () => {
    testServer = startTestServer({
      getWorkerStatus: () => ({ workerRunning: true, activeTasks: 2 }),
      secretsConfigured: () => true
    });
    const response = await fetch(`${testServer.baseUrl}/api/v1/health`, {
      headers: { Authorization: `Bearer ${managementToken}` }
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status?: string; error?: { code?: string; message?: string; fieldErrors?: unknown } };
    expect(body).toEqual({
      status: "ok",
      service: "fermata",
      apiVersion: "1",
      workerRunning: true,
      activeTasks: 2,
      checkedAt: "2026-07-26T00:00:00.000Z"
    });
  });

  it("设置里 enabled 但 worker 没在跑时返回 degraded", async () => {
    testServer = startTestServer({ getWorkerStatus: () => ({ workerRunning: false, activeTasks: 0 }) });
    const response = await fetch(`${testServer.baseUrl}/api/v1/health`, {
      headers: { Authorization: `Bearer ${managementToken}` }
    });
    const body = (await response.json()) as { status?: string; error?: { code?: string; message?: string; fieldErrors?: unknown } };
    expect(body.status).toBe("degraded");
  });

  it("密钥没配置齐全时返回 degraded", async () => {
    testServer = startTestServer({ secretsConfigured: () => false });
    const response = await fetch(`${testServer.baseUrl}/api/v1/health`, {
      headers: { Authorization: `Bearer ${managementToken}` }
    });
    const body = (await response.json()) as { status?: string; error?: { code?: string; message?: string; fieldErrors?: unknown } };
    expect(body.status).toBe("degraded");
  });
});

describe("GET /api/v1/settings/public", () => {
  it("返回当前设置、revision 和 secretsConfigured", async () => {
    testServer = startTestServer();
    const response = await fetch(`${testServer.baseUrl}/api/v1/settings/public`, {
      headers: { Authorization: `Bearer ${managementToken}` }
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status?: string; error?: { code?: string; message?: string; fieldErrors?: unknown } };
    expect(body).toEqual({ settings: defaultSettings(), revision: 4, secretsConfigured: true });
    // 响应里不应该出现任何密钥字段。
    // secretsConfigured 是安全的布尔标志，正则要避开这个字段名本身。
    expect(JSON.stringify(body)).not.toMatch(/apiKey|api_key|managementToken|Bearer |sk-[A-Za-z0-9]/);
  });
});

describe("PUT /api/v1/settings/public", () => {
  it("expectedRevision 正确时更新成功并返回新快照", async () => {
    testServer = startTestServer();
    const newSettings: FermataPublicSettings = { ...defaultSettings(), maximumConcurrentTasks: 5 };
    const response = await fetch(`${testServer.baseUrl}/api/v1/settings/public`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${managementToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 4, settings: newSettings })
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status?: string; error?: { code?: string; message?: string; fieldErrors?: unknown } };
    expect(body).toEqual({ settings: newSettings, revision: 5, secretsConfigured: true });
  });

  it("expectedRevision 不匹配时返回 409", async () => {
    testServer = startTestServer();
    const response = await fetch(`${testServer.baseUrl}/api/v1/settings/public`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${managementToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 999, settings: defaultSettings() })
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { status?: string; error?: { code?: string; message?: string; fieldErrors?: unknown } };
    expect(body.error?.code).toBe("CONFLICT");
  });

  it("请求体不满足 schema 时返回 400 和字段级别的错误", async () => {
    testServer = startTestServer();
    const response = await fetch(`${testServer.baseUrl}/api/v1/settings/public`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${managementToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 4, settings: { ...defaultSettings(), pollingIntervalSeconds: -1 } })
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { status?: string; error?: { code?: string; message?: string; fieldErrors?: unknown } };
    expect(body.error?.code).toBe("INVALID_BODY");
    expect(body.error?.fieldErrors).toBeTruthy();
  });

  it("请求体带密钥字段时会被拒绝（settings 是 strict schema）", async () => {
    testServer = startTestServer();
    const response = await fetch(`${testServer.baseUrl}/api/v1/settings/public`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${managementToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 4, settings: { ...defaultSettings(), modelApiKey: "leak" } })
    });
    expect(response.status).toBe(400);
  });

  it("请求体不是合法 JSON 时返回 400", async () => {
    testServer = startTestServer();
    const response = await fetch(`${testServer.baseUrl}/api/v1/settings/public`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${managementToken}`, "Content-Type": "application/json" },
      body: "{ not json"
    });
    expect(response.status).toBe(400);
  });
});

describe("POST /api/v1/actions/wake", () => {
  it("调用 deps.wake 并返回 { ok: true }", async () => {
    testServer = startTestServer();
    const response = await fetch(`${testServer.baseUrl}/api/v1/actions/wake`, {
      method: "POST",
      headers: { Authorization: `Bearer ${managementToken}`, "Content-Type": "application/json" },
      body: "{}"
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status?: string; error?: { code?: string; message?: string; fieldErrors?: unknown } };
    expect(body).toEqual({ ok: true });
    expect(testServer.wake).toHaveBeenCalledTimes(1);
  });
});
