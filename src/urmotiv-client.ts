/**
 * Urmotiv 机器人 API 客户端：领取 / 续租 / 提交审题任务。
 *
 * 路由（见团队约定，Urmotiv 侧正在实现）：
 *   POST {baseUrl}/api/v1/robot/review-tasks/claim
 *   POST {baseUrl}/api/v1/robot/review-tasks/:assignmentId/renew
 *   POST {baseUrl}/api/v1/robot/review-tasks/:assignmentId/complete
 *
 * 认证：Authorization: Bearer <URMOTIV_ROBOT_TOKEN>。
 *
 * 状态码语义（401/403/409/404 都可能出现）：
 *   - 401：机器人令牌本身无效或过期——这是持续性的配置问题，不是单个任务的
 *     问题，调用方应该停止把它当普通失败重试，而是大声报警。
 *   - 403：没有权限处理这个任务（或机器人账号被收回权限）——放弃这一个任务，
 *     不重试；是否要连带怀疑整个令牌失效由调用方结合频率自行判断。
 *   - 404/409：任务已经不存在、租约已过期被别人抢走、或者版本号对不上——
 *     说明这个任务从我们手里"丢"了，放弃即可，不重试。
 * claim 不自动重试，避免一次响应丢失后重复领取。renew/complete 由调用方为每个
 * 逻辑操作生成 UUID 请求标识；本文件只对没有拿到 HTTP 响应、429 限流和 5xx
 * 服务端故障做一次有界重试，并逐字复用调用方给出的请求体。其它确定响应和契约
 * 错误不重试。
 */
import { z } from "zod";
import {
  claimRobotReviewTasksInputSchema,
  claimRobotReviewTasksResponseSchema,
  completeRobotReviewTaskInputSchema,
  renewRobotReviewTaskInputSchema,
  renewRobotReviewTaskResponseSchema,
  robotReviewTaskCompletionSchema,
  type ClaimRobotReviewTasksResponse,
  type RenewRobotReviewTaskResponse,
  type RobotReviewTaskCompletion
} from "./urmotiv-schemas";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// 请求参数类型使用 `z.input`（解析前的类型），让 schema 自己补齐 leaseSeconds、
// tagIds 等默认值；真正发送前仍统一经过下面的本地边界 schema 校验。
export type ClaimRobotReviewTasksRequest = z.input<typeof claimRobotReviewTasksInputSchema>;
// Urmotiv 在滚动升级期间仍把 requestId 标成 optional；Fermata 已是新客户端，
// 所以在自己的 HTTP 边界叠加 required 约束，不能只依赖 TypeScript 阻止 JS/any 漏传。
const requiredRequestIdSchema = z.string().uuid();
const fermataRenewRobotReviewTaskInputSchema = renewRobotReviewTaskInputSchema.extend({
  requestId: requiredRequestIdSchema
});
const fermataCompleteRobotReviewTaskInputSchema = completeRobotReviewTaskInputSchema.extend({
  requestId: requiredRequestIdSchema
});

export type RenewRobotReviewTaskRequest = z.input<typeof fermataRenewRobotReviewTaskInputSchema>;
export type CompleteRobotReviewTaskRequest = z.input<typeof fermataCompleteRobotReviewTaskInputSchema>;

/** 与生产装配使用的默认值保持一致，供 worker 计算续租重试的最小安全预算。 */
export const DEFAULT_URMOTIV_REQUEST_TIMEOUT_MS = 30_000;
export const URMOTIV_RETRY_DEADLINE_SAFETY_MS = 1_000;
const IDEMPOTENT_OPERATION_MAXIMUM_ATTEMPTS = 2;

export interface UrmotivClientOptions {
  readonly baseUrl: string;
  readonly robotToken: string;
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
}

/** Urmotiv 用非 2xx 状态码明确拒绝了这次请求（服务端已经处理并给出结论）。 */
export class UrmotivApiError extends Error {
  public readonly status: number;
  public readonly code: string | undefined;
  public readonly requestId: string | undefined;
  public readonly fieldErrors: Record<string, string[]> | undefined;

  public constructor(
    status: number,
    message: string,
    options?: { code?: string; requestId?: string; fieldErrors?: Record<string, string[]> }
  ) {
    super(message);
    this.name = "UrmotivApiError";
    this.status = status;
    this.code = options?.code;
    this.requestId = options?.requestId;
    this.fieldErrors = options?.fieldErrors;
  }
}

/** 请求根本没有拿到 HTTP 响应：网络错误、超时、DNS 失败等。 */
export class UrmotivNetworkError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "UrmotivNetworkError";
  }
}

/** 拿到了 2xx 响应，但内容不符合我们镜像的契约——说明契约漂移了，需要人工排查。 */
export class UrmotivContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UrmotivContractError";
  }
}

/** 409/404：任务已经从我们手里"丢"了（被抢、过期、或已不存在），应放弃且不重试。 */
export function isTaskConflictError(error: unknown): error is UrmotivApiError {
  return error instanceof UrmotivApiError && (error.status === 404 || error.status === 409);
}

/** 403：没有权限处理这个任务，应放弃且不重试。 */
export function isForbiddenError(error: unknown): error is UrmotivApiError {
  return error instanceof UrmotivApiError && error.status === 403;
}

/** 401：机器人令牌本身有问题，是持续性故障，不是单任务问题。 */
export function isAuthenticationError(error: unknown): error is UrmotivApiError {
  return error instanceof UrmotivApiError && error.status === 401;
}

/** 没有响应、限流和服务端故障可依靠操作请求标识安全重放；其它确定响应不重试。 */
export function isRetryableUrmotivDeliveryError(
  error: unknown
): error is UrmotivNetworkError | UrmotivApiError {
  return error instanceof UrmotivNetworkError
    || (error instanceof UrmotivApiError && (error.status === 429 || error.status >= 500));
}

const assignmentIdSchema = z.string().uuid();

/**
 * 只声明 claim/renew/complete 三个方法，而不是直接依赖 UrmotivClient 这个具体
 * 类。UrmotivClient 结构上自然满足这个接口；reviewer.ts 依赖这个接口而不是
 * 具体类，测试时可以传一个不发真实请求的假实现。
 */
export interface UrmotivClientLike {
  /** 单次 HTTP 尝试的最长等待时间；worker 用它保留完整的租约重试预算。 */
  readonly requestTimeoutMs: number;
  claim(input?: ClaimRobotReviewTasksRequest): Promise<ClaimRobotReviewTasksResponse>;
  renew(assignmentId: string, input: RenewRobotReviewTaskRequest): Promise<RenewRobotReviewTaskResponse>;
  complete(assignmentId: string, input: CompleteRobotReviewTaskRequest): Promise<RobotReviewTaskCompletion>;
}

export class UrmotivClient implements UrmotivClientLike {
  readonly #baseUrl: URL;
  readonly #robotToken: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  public constructor(options: UrmotivClientOptions) {
    this.#baseUrl = new URL(ensureTrailingSlash(z.string().url().parse(options.baseUrl)));
    this.#robotToken = z.string().trim().min(1).parse(options.robotToken);
    this.#timeoutMs = z.number().int().min(1_000).max(120_000).parse(
      options.timeoutMs ?? DEFAULT_URMOTIV_REQUEST_TIMEOUT_MS
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public get requestTimeoutMs(): number {
    return this.#timeoutMs;
  }

  // 这三个方法都标成 async：方法体里 schema.parse(...) 校验失败会同步抛错，
  // 如果方法不是 async，那个抛出会在“拿到 Promise 之前”就发生，调用方没办法
  // 用 `.catch()`/`await ... catch` 统一处理；标成 async 之后，JS 会自动把方法体
  // 里同步抛出的异常转成这个方法返回的 Promise 的 rejection，调用方永远只需要
  // 处理“这个 Promise 会不会 reject”一种情况。
  public async claim(input: ClaimRobotReviewTasksRequest = {}): Promise<ClaimRobotReviewTasksResponse> {
    const body = claimRobotReviewTasksInputSchema.parse(input);
    return this.requestOnce(
      "api/v1/robot/review-tasks/claim",
      JSON.stringify(body),
      claimRobotReviewTasksResponseSchema
    );
  }

  public async renew(
    assignmentId: string,
    input: RenewRobotReviewTaskRequest
  ): Promise<RenewRobotReviewTaskResponse> {
    const id = assignmentIdSchema.parse(assignmentId);
    const body = fermataRenewRobotReviewTaskInputSchema.parse(input);
    return this.requestIdempotently(
      `api/v1/robot/review-tasks/${id}/renew`,
      JSON.stringify(body),
      renewRobotReviewTaskResponseSchema,
      body.expectedLeaseExpiresAt
    );
  }

  public async complete(
    assignmentId: string,
    input: CompleteRobotReviewTaskRequest
  ): Promise<RobotReviewTaskCompletion> {
    const id = assignmentIdSchema.parse(assignmentId);
    const body = fermataCompleteRobotReviewTaskInputSchema.parse(input);
    return this.requestIdempotently(
      `api/v1/robot/review-tasks/${id}/complete`,
      JSON.stringify(body),
      robotReviewTaskCompletionSchema,
      body.expectedLeaseExpiresAt
    );
  }

  private async requestIdempotently<T>(
    relativePath: string,
    serializedBody: string,
    responseSchema: z.ZodType<T>,
    leaseExpiresAt: string
  ): Promise<T> {
    for (let attempt = 1; attempt <= IDEMPOTENT_OPERATION_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        return await this.requestOnce(relativePath, serializedBody, responseSchema);
      } catch (error) {
        const hasAnotherAttempt = attempt < IDEMPOTENT_OPERATION_MAXIMUM_ATTEMPTS;
        if (
          !isRetryableUrmotivDeliveryError(error)
          || !hasAnotherAttempt
          || !this.hasFullRetryBudget(leaseExpiresAt)
        ) {
          throw error;
        }
      }
    }
    throw new UrmotivNetworkError(`请求 Urmotiv 机器人 API 失败：${relativePath}`);
  }

  private hasFullRetryBudget(leaseExpiresAt: string): boolean {
    const deadlineMs = Date.parse(leaseExpiresAt);
    return Number.isFinite(deadlineMs)
      && deadlineMs - Date.now() > this.#timeoutMs + URMOTIV_RETRY_DEADLINE_SAFETY_MS;
  }

  private async requestOnce<T>(
    relativePath: string,
    serializedBody: string,
    responseSchema: z.ZodType<T>
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response | undefined;
    let rawBody: unknown;
    try {
      response = await waitForOrAbort(
        this.#fetch(new URL(relativePath, this.#baseUrl), {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.#robotToken}`,
            "X-Urmotiv-API-Version": "1"
          },
          body: serializedBody,
          signal: controller.signal
        }),
        controller.signal
      );
      if (response.ok) {
        rawBody = await parseJsonBodyLeniently(response, controller.signal);
      } else {
        cancelResponseBodyWithoutReading(response);
      }
    } catch (error) {
      controller.abort();
      if (response?.body !== null && response?.body !== undefined) {
        try {
          const cancellation = response.body.cancel();
          void cancellation.catch(() => undefined);
        } catch {
          // 取消失败不能替换固定的网络错误。
        }
      }
      throw new UrmotivNetworkError(`请求 Urmotiv 机器人 API 失败：${relativePath}`, error);
    } finally {
      clearTimeout(timeout);
    }

    if (response === undefined) {
      throw new UrmotivNetworkError(`请求 Urmotiv 机器人 API 失败：${relativePath}`);
    }
    if (!response.ok) {
      throw new UrmotivApiError(
        response.status,
        `Urmotiv 返回状态码 ${response.status}：${relativePath}`
      );
    }

    const parsed = responseSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new UrmotivContractError(
        `Urmotiv 对 ${relativePath} 的响应不符合预期结构，契约可能已经漂移：${parsed.error.message}`
      );
    }
    return parsed.data;
  }
}

function cancelResponseBodyWithoutReading(response: Response): void {
  if (response.body === null) {
    return;
  }
  try {
    const cancellation = response.body.cancel();
    void cancellation.catch(() => undefined);
  } catch {
    // 状态码已经足够分类；取消正文失败不能把它改成网络错误。
  }
}

async function parseJsonBodyLeniently(
  response: Response,
  signal: AbortSignal
): Promise<unknown> {
  const text = await waitForOrAbort(response.text(), signal);
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function waitForOrAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("请求已结束。", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("请求已结束。", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
