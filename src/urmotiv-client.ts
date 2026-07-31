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
 * 本文件只负责发请求、按状态码分类抛出类型化错误；要不要重试、重试几次，
 * 由调用方（src/reviewer.ts）决定，这里不做任何自动重试。
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
  type CompleteRobotReviewTaskInput,
  type RenewRobotReviewTaskResponse,
  type RobotReviewTaskCompletion
} from "./urmotiv-schemas";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// claim/renew 的请求体里有几个字段带 zod `.default(...)`。用 `z.infer`（也就是
// schema 的输出类型）当参数类型会强迫调用方把带默认值的字段也显式填上，等于
// 白白浪费了 schema 里已经声明好的默认值。这里改用 `z.input`（解析前的类型），
// 让调用方可以省略 leaseSeconds 之类的字段，交给 `.parse()` 去补默认值——
// complete() 不用这个处理，因为它的 review 字段总是由 verdict 流水线完整构造，
// 不依赖默认值，直接用契约里导出的 CompleteRobotReviewTaskInput（输出类型）
// 反而能强制调用方不要漏字段。
export type ClaimRobotReviewTasksRequest = z.input<typeof claimRobotReviewTasksInputSchema>;
export type RenewRobotReviewTaskRequest = z.input<typeof renewRobotReviewTaskInputSchema>;

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

const assignmentIdSchema = z.string().uuid();

/**
 * 只声明 claim/renew/complete 三个方法，而不是直接依赖 UrmotivClient 这个具体
 * 类。UrmotivClient 结构上自然满足这个接口；reviewer.ts 依赖这个接口而不是
 * 具体类，测试时可以传一个不发真实请求的假实现。
 */
export interface UrmotivClientLike {
  claim(input?: ClaimRobotReviewTasksRequest): Promise<ClaimRobotReviewTasksResponse>;
  renew(assignmentId: string, input: RenewRobotReviewTaskRequest): Promise<RenewRobotReviewTaskResponse>;
  complete(assignmentId: string, input: CompleteRobotReviewTaskInput): Promise<RobotReviewTaskCompletion>;
}

export class UrmotivClient implements UrmotivClientLike {
  readonly #baseUrl: URL;
  readonly #robotToken: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  public constructor(options: UrmotivClientOptions) {
    this.#baseUrl = new URL(ensureTrailingSlash(z.string().url().parse(options.baseUrl)));
    this.#robotToken = z.string().trim().min(1).parse(options.robotToken);
    this.#timeoutMs = z.number().int().min(1_000).max(120_000).parse(options.timeoutMs ?? 30_000);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  // 这三个方法都标成 async：方法体里 schema.parse(...) 校验失败会同步抛错，
  // 如果方法不是 async，那个抛出会在“拿到 Promise 之前”就发生，调用方没办法
  // 用 `.catch()`/`await ... catch` 统一处理；标成 async 之后，JS 会自动把方法体
  // 里同步抛出的异常转成这个方法返回的 Promise 的 rejection，调用方永远只需要
  // 处理“这个 Promise 会不会 reject”一种情况。
  public async claim(input: ClaimRobotReviewTasksRequest = {}): Promise<ClaimRobotReviewTasksResponse> {
    const body = claimRobotReviewTasksInputSchema.parse(input);
    return this.request(
      "api/v1/robot/review-tasks/claim",
      body,
      claimRobotReviewTasksResponseSchema
    );
  }

  public async renew(
    assignmentId: string,
    input: RenewRobotReviewTaskRequest
  ): Promise<RenewRobotReviewTaskResponse> {
    const id = assignmentIdSchema.parse(assignmentId);
    const body = renewRobotReviewTaskInputSchema.parse(input);
    return this.request(
      `api/v1/robot/review-tasks/${id}/renew`,
      body,
      renewRobotReviewTaskResponseSchema
    );
  }

  public async complete(
    assignmentId: string,
    input: CompleteRobotReviewTaskInput
  ): Promise<RobotReviewTaskCompletion> {
    const id = assignmentIdSchema.parse(assignmentId);
    const body = completeRobotReviewTaskInputSchema.parse(input);
    return this.request(
      `api/v1/robot/review-tasks/${id}/complete`,
      body,
      robotReviewTaskCompletionSchema
    );
  }

  private async request<T>(relativePath: string, body: unknown, responseSchema: z.ZodType<T>): Promise<T> {
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
          body: JSON.stringify(body),
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
