import { describe, expect, it, vi } from "vitest";
import {
  isAuthenticationError,
  isForbiddenError,
  isTaskConflictError,
  UrmotivApiError,
  UrmotivClient,
  UrmotivContractError,
  UrmotivNetworkError,
  type CompleteRobotReviewTaskRequest
} from "../src/urmotiv-client";
import {
  completeRobotReviewTaskInputSchema,
  reviewInputSchema,
  renewRobotReviewTaskInputSchema,
  robotReviewTaskSchema,
  type RobotReviewTask
} from "../src/urmotiv-schemas";

const robotToken = "urv_test_token_1234567890";
const baseUrl = "https://urmotiv.example.test";
const assignmentId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const renewalRequestId = "3fa85f64-5717-4562-b3fc-2c963f66afa7";
const completionRequestId = "3fa85f64-5717-4562-b3fc-2c963f66afa8";
const contentHash = "a".repeat(64);

function sampleTask(): RobotReviewTask {
  return {
    assignmentId,
    leaseExpiresAt: "2026-07-26T00:05:00.000Z",
    problem: {
      id: "problem-1",
      revision: 3,
      reviewRound: 1,
      contentHash,
      title: "样例题目",
      type: "traditional",
      tagIds: ["dp"],
      basicStatement: "给定一个数组……",
      basicSolution: "用动态规划……"
    },
    reviewItems: []
  };
}

function validCompleteInput(): CompleteRobotReviewTaskRequest {
  return {
    requestId: completionRequestId,
    expectedLeaseExpiresAt: "2026-07-26T00:05:00.000Z",
    expectedProblemRevision: 3,
    experimentVersion: "experiment-2026-07",
    modelProfileName: "review-balanced",
    review: {
      verdict: "approve",
      codeforcesDifficulty: 1500,
      qualityLevel: 3,
      thinkingLevel: 3,
      codingLevel: 2,
      tagIds: ["dp"],
      improvements: "建议补充数据范围说明。",
      privateNote: "",
      expectedRound: 1
    }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("UrmotivClient：正常路径", () => {
  it("claim 发送正确的请求并解析响应", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`${baseUrl}/api/v1/robot/review-tasks/claim`);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual(
        expect.objectContaining({
          Authorization: `Bearer ${robotToken}`,
          "X-Urmotiv-API-Version": "1"
        })
      );
      expect(JSON.parse(String(init?.body))).toEqual({ maximumTasks: 2, leaseSeconds: 300 });
      return jsonResponse({ items: [sampleTask()] });
    });

    const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });
    const result = await client.claim({ maximumTasks: 2, leaseSeconds: 300 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.assignmentId).toBe(assignmentId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renew 把 assignmentId 拼进路径", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`${baseUrl}/api/v1/robot/review-tasks/${assignmentId}/renew`);
      expect(JSON.parse(String(init?.body))).toEqual({
        requestId: renewalRequestId,
        expectedLeaseExpiresAt: "2026-07-26T00:05:00.000Z",
        leaseSeconds: 300
      });
      return jsonResponse({ assignmentId, leaseExpiresAt: "2026-07-26T00:10:00.000Z" });
    });
    const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });
    const result = await client.renew(assignmentId, {
      requestId: renewalRequestId,
      expectedLeaseExpiresAt: "2026-07-26T00:05:00.000Z",
      leaseSeconds: 300
    });
    expect(result.leaseExpiresAt).toBe("2026-07-26T00:10:00.000Z");
  });

  it("complete 把 assignmentId 拼进路径并透传 review", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`${baseUrl}/api/v1/robot/review-tasks/${assignmentId}/complete`);
      const body = JSON.parse(String(init?.body));
      expect(body.requestId).toBe(completionRequestId);
      expect(body.review.verdict).toBe("approve");
      return jsonResponse({ assignmentId, accepted: true, problemStatus: "approved" });
    });
    const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });
    const result = await client.complete(assignmentId, validCompleteInput());
    expect(result.problemStatus).toBe("approved");
  });
});

describe("UrmotivClient：本地校验先于网络请求", () => {
  it("镜像契约允许评价缺省或显式使用空标签，但领取任务仍要求至少一个标签", () => {
    const { tagIds: _tagIds, ...reviewWithoutTags } = validCompleteInput().review;
    expect(reviewInputSchema.parse(reviewWithoutTags).tagIds).toEqual([]);
    expect(reviewInputSchema.safeParse({ ...reviewWithoutTags, tagIds: [] }).success).toBe(true);
    expect(
      reviewInputSchema.safeParse({
        ...reviewWithoutTags,
        tagIds: Array.from({ length: 31 }, (_, index) => `tag-${index}`)
      }).success
    ).toBe(false);
    expect(
      robotReviewTaskSchema.safeParse({
        ...sampleTask(),
        problem: { ...sampleTask().problem, tagIds: [] }
      }).success
    ).toBe(false);
  });

  it("镜像契约要求 renew 和 complete 都携带请求标识", () => {
    expect(
      renewRobotReviewTaskInputSchema.safeParse({
        expectedLeaseExpiresAt: "2026-07-26T00:05:00.000Z",
        leaseSeconds: 300
      }).success
    ).toBe(false);
    const { requestId: _requestId, ...withoutRequestId } = validCompleteInput();
    expect(completeRobotReviewTaskInputSchema.safeParse(withoutRequestId).success).toBe(false);
  });

  it("complete 在 review 不满足 schema 时直接抛错，不发请求", async () => {
    const fetchMock = vi.fn();
    const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });
    const invalidInput = {
      ...validCompleteInput(),
      review: { ...validCompleteInput().review, codeforcesDifficulty: 1550 } // 不是整百
    };
    await expect(client.complete(assignmentId, invalidInput)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("complete 接受评价的空知识点列表并原样发送", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).review.tagIds).toEqual([]);
      return jsonResponse({ assignmentId, accepted: true, problemStatus: "approved" });
    });
    const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });
    const input = {
      ...validCompleteInput(),
      review: { ...validCompleteInput().review, tagIds: [] }
    };
    await expect(client.complete(assignmentId, input)).resolves.toMatchObject({ accepted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("claim 在 leaseSeconds 超出范围时直接抛错，不发请求", async () => {
    const fetchMock = vi.fn();
    const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });
    await expect(client.claim({ leaseSeconds: 999_999 })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renew 在请求标识不是 UUID 时直接抛错，不发请求", async () => {
    const fetchMock = vi.fn();
    const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });
    await expect(client.renew(assignmentId, {
      requestId: "not-a-uuid",
      expectedLeaseExpiresAt: "2026-07-26T00:05:00.000Z",
      leaseSeconds: 300
    })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["renew", "complete"] as const)(
    "%s 在运行时缺少请求标识时直接拒绝且不发请求",
    async (operation) => {
      const fetchMock = vi.fn();
      const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });
      if (operation === "renew") {
        await expect(client.renew(assignmentId, {
          expectedLeaseExpiresAt: "2026-07-26T00:05:00.000Z",
          leaseSeconds: 300
        } as never)).rejects.toThrow();
      } else {
        const { requestId: _requestId, ...withoutRequestId } = validCompleteInput();
        await expect(client.complete(assignmentId, withoutRequestId as never)).rejects.toThrow();
      }
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});

describe("UrmotivClient：按状态码分类错误", () => {
  it("401 归类为认证错误", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: "UNAUTHENTICATED", message: "令牌无效", requestId: "req-1" } }, 401)
    );
    const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });
    await expect(client.claim({})).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(UrmotivApiError);
      expect(isAuthenticationError(error)).toBe(true);
      expect(isForbiddenError(error)).toBe(false);
      expect(isTaskConflictError(error)).toBe(false);
      return true;
    });
  });

  it("403 归类为禁止访问", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { code: "FORBIDDEN", message: "无权限" } }, 403));
    const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });
    await expect(client.claim({})).rejects.toSatisfy((error: unknown) => {
      expect(isForbiddenError(error)).toBe(true);
      expect(isAuthenticationError(error)).toBe(false);
      return true;
    });
  });

  it("404 和 409 都归类为任务冲突（应放弃且不重试）", async () => {
    for (const status of [404, 409]) {
      const fetchMock = vi.fn(async () => jsonResponse({ error: { code: "CONFLICT", message: "任务已变化" } }, status));
      const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });
      await expect(
        client.renew(assignmentId, {
          requestId: renewalRequestId,
          expectedLeaseExpiresAt: "2026-07-26T00:05:00.000Z",
          leaseSeconds: 300
        })
      ).rejects.toSatisfy((error: unknown) => {
        expect(isTaskConflictError(error)).toBe(true);
        return true;
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("非 JSON 错误响应体时仍然按状态码抛出 UrmotivApiError", async () => {
    const fetchMock = vi.fn(
      async () => new Response("Internal Server Error", { status: 500, headers: { "Content-Type": "text/plain" } })
    );
    const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });
    await expect(client.claim({})).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(UrmotivApiError);
      expect((error as UrmotivApiError).status).toBe(500);
      return true;
    });
  });

  it("已收到错误状态时不等待永不结束的正文，并立即取消正文", async () => {
    for (const status of [401, 403, 409]) {
      let cancelled = false;
      const fetchMock = vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled = true;
              }
            }),
            {
              status,
              headers: { "Content-Type": "application/json" }
            }
          )
      );
      const client = new UrmotivClient({
        baseUrl,
        robotToken,
        fetch: fetchMock
      });
      const error = await client
        .renew(assignmentId, {
          requestId: renewalRequestId,
          expectedLeaseExpiresAt: "2026-07-26T00:05:00.000Z",
          leaseSeconds: 300
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(UrmotivApiError);
      expect((error as UrmotivApiError).status).toBe(status);
      expect(cancelled).toBe(true);
    }
  });
});

describe("UrmotivClient：网络与契约错误", () => {
  it.each([429, 500])(
    "renew 收到可重试的 HTTP %i 时仍逐字复用同一请求体",
    async (status) => {
      const requestBodies: string[] = [];
      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requestBodies.push(String(init?.body));
        if (requestBodies.length === 1) {
          return jsonResponse({ error: { code: "TEMPORARY", message: "稍后重试" } }, status);
        }
        return jsonResponse({ assignmentId, leaseExpiresAt: "2099-01-01T00:10:00.000Z" });
      });
      const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });

      await expect(client.renew(assignmentId, {
        requestId: renewalRequestId,
        expectedLeaseExpiresAt: "2099-01-01T00:05:00.000Z",
        leaseSeconds: 300
      })).resolves.toEqual({ assignmentId, leaseExpiresAt: "2099-01-01T00:10:00.000Z" });

      expect(requestBodies).toEqual([requestBodies[0], requestBodies[0]]);
    }
  );

  it.each([400, 401, 403, 404, 409])(
    "renew 收到确定且不可重试的 HTTP %i 时只请求一次",
    async (status) => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ error: { code: "REJECTED", message: "固定拒绝" } }, status)
      );
      const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });

      await expect(client.renew(assignmentId, {
        requestId: renewalRequestId,
        expectedLeaseExpiresAt: "2099-01-01T00:05:00.000Z",
        leaseSeconds: 300
      })).rejects.toBeInstanceOf(UrmotivApiError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it("renew 的网络重试逐字复用同一个 UUID 和请求体", async () => {
    const requestBodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(String(init?.body));
      if (requestBodies.length === 1) {
        throw new Error("响应在到达客户端前断开");
      }
      return jsonResponse({ assignmentId, leaseExpiresAt: "2099-01-01T00:10:00.000Z" });
    });
    const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });

    await expect(client.renew(assignmentId, {
      requestId: renewalRequestId,
      expectedLeaseExpiresAt: "2099-01-01T00:05:00.000Z",
      leaseSeconds: 300
    })).resolves.toEqual({ assignmentId, leaseExpiresAt: "2099-01-01T00:10:00.000Z" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodies).toEqual([requestBodies[0], requestBodies[0]]);
    expect(JSON.parse(requestBodies[0]!)).toEqual({
      requestId: renewalRequestId,
      expectedLeaseExpiresAt: "2099-01-01T00:05:00.000Z",
      leaseSeconds: 300
    });
  });

  it("complete 的网络重试逐字复用同一个 UUID 和请求体", async () => {
    const requestBodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(String(init?.body));
      if (requestBodies.length === 1) {
        throw new Error("响应在到达客户端前断开");
      }
      return jsonResponse({ assignmentId, accepted: true, problemStatus: "approved" });
    });
    const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });
    const input = {
      ...validCompleteInput(),
      expectedLeaseExpiresAt: "2099-01-01T00:05:00.000Z"
    };

    await expect(client.complete(assignmentId, input)).resolves.toEqual({
      assignmentId,
      accepted: true,
      problemStatus: "approved"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodies).toEqual([requestBodies[0], requestBodies[0]]);
    expect(JSON.parse(requestBodies[0]!).requestId).toBe(completionRequestId);
  });

  it.each([429, 500])(
    "complete 收到可重试的 HTTP %i 时有界复用同一 UUID 和请求体",
    async (status) => {
      const requestBodies: string[] = [];
      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requestBodies.push(String(init?.body));
        if (requestBodies.length === 1) {
          return jsonResponse({ error: { code: "TEMPORARY", message: "稍后重试" } }, status);
        }
        return jsonResponse({ assignmentId, accepted: true, problemStatus: "approved" });
      });
      const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });

      await expect(client.complete(assignmentId, {
        ...validCompleteInput(),
        expectedLeaseExpiresAt: "2099-01-01T00:05:00.000Z"
      })).resolves.toEqual({ assignmentId, accepted: true, problemStatus: "approved" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(requestBodies).toEqual([requestBodies[0], requestBodies[0]]);
      expect(JSON.parse(requestBodies[0]!).requestId).toBe(completionRequestId);
    }
  );

  it("complete 的两次网络尝试都失败时仍只使用原 UUID，并返回结果不确定错误", async () => {
    const requestBodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(String(init?.body));
      throw new Error("响应在到达客户端前断开");
    });
    const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });

    await expect(client.complete(assignmentId, {
      ...validCompleteInput(),
      expectedLeaseExpiresAt: "2099-01-01T00:05:00.000Z"
    })).rejects.toBeInstanceOf(UrmotivNetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodies).toEqual([requestBodies[0], requestBodies[0]]);
    expect(JSON.parse(requestBodies[0]!).requestId).toBe(completionRequestId);
  });

  it("按实际 120 秒客户端超时判断租约不足时不启动网络重试", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("网络中断");
    });
    const client = new UrmotivClient({
      baseUrl,
      robotToken,
      timeoutMs: 120_000,
      fetch: fetchMock
    });
    const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();

    await expect(client.renew(assignmentId, {
      requestId: renewalRequestId,
      expectedLeaseExpiresAt: leaseExpiresAt,
      leaseSeconds: 300
    })).rejects.toBeInstanceOf(UrmotivNetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("确定的 2xx 契约错误不自动重试", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ accepted: "maybe" }));
    const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });

    await expect(client.complete(assignmentId, {
      ...validCompleteInput(),
      expectedLeaseExpiresAt: "2099-01-01T00:05:00.000Z"
    })).rejects.toBeInstanceOf(UrmotivContractError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetch 抛出异常时包装成 UrmotivNetworkError", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });
    await expect(client.claim({})).rejects.toBeInstanceOf(UrmotivNetworkError);
  });

  it("响应结构不符合契约时抛出 UrmotivContractError", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [{ notATask: true }] }));
    const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });
    await expect(client.claim({})).rejects.toBeInstanceOf(UrmotivContractError);
  });

  it("等待时限覆盖完整响应正文，正文不结束时按网络失败返回", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        async () =>
          new Response(new ReadableStream<Uint8Array>(), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          })
      );
      const client = new UrmotivClient({
        baseUrl,
        robotToken,
        timeoutMs: 1_000,
        fetch: fetchMock
      });
      const resultPromise = client.claim({});
      const rejection = expect(resultPromise).rejects.toBeInstanceOf(
        UrmotivNetworkError
      );
      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
