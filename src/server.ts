/**
 * 管理端口：给 plugins/fermata-control 用的四个接口。
 *
 *   GET  /api/v1/health           -> fermataHealthSchema
 *   GET  /api/v1/settings/public  -> fermataPublicSettingsResponseSchema
 *   PUT  /api/v1/settings/public  -> fermataPublicSettingsResponseSchema（乐观锁）
 *   POST /api/v1/actions/wake     -> { ok: true }
 *
 * 全部要求 `Authorization: Bearer <FERMATA_MANAGEMENT_TOKEN>`，用常量时间比较。
 * 用 node:http 直接写，不引入任何 HTTP 框架依赖。
 *
 * 错误响应不泄露内部细节：未捕获异常统一变成一句不带堆栈/细节的 500；请求体
 * 校验失败会带上字段级别的错误（这不算"内部细节"，是给已经通过鉴权的调用方的
 * 正常校验反馈，格式仿照 Urmotiv 自己 apps/api/src/app.ts 里 sendError 的
 * `{ error: { code, message, fieldErrors? } }` 形状）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { logError, timingSafeEqual } from "./logger";
import { SettingsConflictError, type SettingsStoreLike } from "./settings-store";
import {
  fermataHealthSchema,
  fermataPublicSettingsResponseSchema,
  updateFermataPublicSettingsInputSchema
} from "./urmotiv-schemas";

export type { SettingsStoreLike };

/** 和 fermata-control 插件约定的响应体上限一致；这里的响应本来就都是很小的固定结构，不会真的逼近这个值。 */
const RESPONSE_BYTE_LIMIT = 512_000;
/** settings/public、actions/wake 的请求体都很小，限制一个保守的上限防止被灌爆内存。 */
const REQUEST_BODY_BYTE_LIMIT = 64_000;

export interface WorkerStatus {
  readonly workerRunning: boolean;
  readonly activeTasks: number;
}

export interface ManagementServerDeps {
  readonly managementToken: string;
  readonly settingsStore: SettingsStoreLike;
  /** 当前生效的模型档位是否已经配置好所需的 provider 密钥，实时计算，不缓存。 */
  readonly secretsConfigured: () => boolean;
  readonly getWorkerStatus: () => WorkerStatus;
  readonly wake: () => void;
  readonly now?: () => Date;
}

export function createManagementServer(deps: ManagementServerDeps): Server {
  const now = deps.now ?? (() => new Date());
  return createServer((req, res) => {
    void handleRequest(req, res, deps, now).catch((error: unknown) => {
      logError("管理端口处理请求时出现未捕获异常", error, { path: req.url ?? "" });
      if (!res.headersSent) {
        sendJson(res, 500, { error: { code: "INTERNAL_ERROR", message: "内部错误。" } });
      } else {
        res.destroy();
      }
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ManagementServerDeps,
  now: () => Date
): Promise<void> {
  const method = req.method ?? "GET";
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  // 容器健康检查专用：不带任何状态信息，也不要求管理令牌。
  if (method === "GET" && path === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isAuthorized(req, deps.managementToken)) {
    sendJson(res, 401, { error: { code: "UNAUTHENTICATED", message: "缺少或无效的管理令牌。" } });
    return;
  }

  if (method === "GET" && path === "/api/v1/health") {
    sendHealth(res, deps, now);
    return;
  }
  if (method === "GET" && path === "/api/v1/settings/public") {
    sendSettings(res, deps, 200);
    return;
  }
  if (method === "PUT" && path === "/api/v1/settings/public") {
    await handlePutSettings(req, res, deps);
    return;
  }
  if (method === "POST" && path === "/api/v1/actions/wake") {
    await handleWake(req, res, deps);
    return;
  }

  sendJson(res, 404, { error: { code: "NOT_FOUND", message: "未找到请求的资源。" } });
}

function isAuthorized(req: IncomingMessage, managementToken: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return false;
  }
  const token = header.slice("Bearer ".length);
  return timingSafeEqual(token, managementToken);
}

function sendHealth(res: ServerResponse, deps: ManagementServerDeps, now: () => Date): void {
  const workerStatus = deps.getWorkerStatus();
  const settings = deps.settingsStore.get().settings;
  // "降级"目前只覆盖两种能明确判断的情况：设置里希望它在跑但实际主循环没在跑，
  // 或者当前生效档位缺密钥导致就算跑着也做不了任何事。
  const isDegraded = (settings.enabled && !workerStatus.workerRunning) || !deps.secretsConfigured();
  const health = fermataHealthSchema.parse({
    status: isDegraded ? "degraded" : "ok",
    service: "fermata",
    apiVersion: "1",
    workerRunning: workerStatus.workerRunning,
    activeTasks: workerStatus.activeTasks,
    checkedAt: now().toISOString()
  });
  sendJson(res, 200, health);
}

function sendSettings(res: ServerResponse, deps: ManagementServerDeps, status: number): void {
  const snapshot = deps.settingsStore.get();
  const response = fermataPublicSettingsResponseSchema.parse({
    settings: snapshot.settings,
    revision: snapshot.revision,
    secretsConfigured: deps.secretsConfigured()
  });
  sendJson(res, status, response);
}

async function handlePutSettings(req: IncomingMessage, res: ServerResponse, deps: ManagementServerDeps): Promise<void> {
  const body = await readJsonBody(req, REQUEST_BODY_BYTE_LIMIT);
  if (!body.ok) {
    sendJson(res, body.status, { error: { code: body.code, message: body.message } });
    return;
  }
  const parsed = updateFermataPublicSettingsInputSchema.safeParse(body.value);
  if (!parsed.success) {
    sendJson(res, 400, {
      error: { code: "INVALID_BODY", message: "请求体不满足要求。", fieldErrors: formatZodFieldErrors(parsed.error) }
    });
    return;
  }

  try {
    deps.settingsStore.update(parsed.data.expectedRevision, parsed.data.settings);
  } catch (error) {
    if (error instanceof SettingsConflictError) {
      sendJson(res, 409, { error: { code: "CONFLICT", message: error.message } });
      return;
    }
    throw error;
  }

  sendSettings(res, deps, 200);
}

async function handleWake(req: IncomingMessage, res: ServerResponse, deps: ManagementServerDeps): Promise<void> {
  // fermata-control 发的是 "{}"，内容本身不重要，但必须读完并限制大小，
  // 不然连接可能一直挂着，或者被灌一个超大 body 撑爆内存。
  const body = await readJsonBody(req, REQUEST_BODY_BYTE_LIMIT);
  if (!body.ok) {
    sendJson(res, body.status, { error: { code: body.code, message: body.message } });
    return;
  }
  deps.wake();
  sendJson(res, 200, { ok: true });
}

type ReadJsonBodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string };

function readJsonBody(req: IncomingMessage, limit: number): Promise<ReadJsonBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const finish = (result: ReadJsonBodyResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, status: 413, code: "PAYLOAD_TOO_LARGE", message: "请求体过大。" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) {
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim().length === 0) {
        finish({ ok: true, value: undefined });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(text) as unknown });
      } catch {
        finish({ ok: false, status: 400, code: "INVALID_JSON", message: "请求体不是合法 JSON。" });
      }
    });

    req.on("error", () => {
      finish({ ok: false, status: 400, code: "REQUEST_ERROR", message: "读取请求体时出错。" });
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  if (payload.length > RESPONSE_BYTE_LIMIT) {
    // 不应该发生（所有响应都是固定的小结构），但万一发生，宁可报错也不要发出
    // 一个会被 fermata-control 客户端直接拒收的超大响应。
    logError("管理端口试图发送超过大小限制的响应，已拦截", undefined, { byteLength: payload.length });
    const fallback = Buffer.from(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "内部错误。" } }), "utf8");
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(fallback.length) });
    res.end(fallback);
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(payload.length)
  });
  res.end(payload);
}

function formatZodFieldErrors(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = issue.path.join(".") || "body";
    (fieldErrors[field] ??= []).push(issue.message);
  }
  return fieldErrors;
}
