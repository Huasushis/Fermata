import { describe, expect, it, vi } from "vitest";
import {
  isAuthenticationError,
  isForbiddenError,
  isTaskConflictError,
  UrmotivApiError,
  UrmotivClient,
  UrmotivContractError,
  UrmotivNetworkError
} from "../src/urmotiv-client";
import type { CompleteRobotReviewTaskInput, RobotReviewTask } from "../src/urmotiv-schemas";

const robotToken = "urv_test_token_1234567890";
const baseUrl = "https://urmotiv.example.test";
const assignmentId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
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

function validCompleteInput(): CompleteRobotReviewTaskInput {
  return {
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
      tagIds: [],
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
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`${baseUrl}/api/v1/robot/review-tasks/${assignmentId}/renew`);
      return jsonResponse({ assignmentId, leaseExpiresAt: "2026-07-26T00:10:00.000Z" });
    });
    const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });
    const result = await client.renew(assignmentId, {
      expectedLeaseExpiresAt: "2026-07-26T00:05:00.000Z",
      leaseSeconds: 300
    });
    expect(result.leaseExpiresAt).toBe("2026-07-26T00:10:00.000Z");
  });

  it("complete 把 assignmentId 拼进路径并透传 review", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`${baseUrl}/api/v1/robot/review-tasks/${assignmentId}/complete`);
      const body = JSON.parse(String(init?.body));
      expect(body.review.verdict).toBe("approve");
      return jsonResponse({ assignmentId, accepted: true, problemStatus: "approved" });
    });
    const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });
    const result = await client.complete(assignmentId, validCompleteInput());
    expect(result.problemStatus).toBe("approved");
  });
});

describe("UrmotivClient：本地校验先于网络请求", () => {
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

  it("claim 在 leaseSeconds 超出范围时直接抛错，不发请求", async () => {
    const fetchMock = vi.fn();
    const client = new UrmotivClient({ baseUrl, robotToken, fetch: fetchMock });
    await expect(client.claim({ leaseSeconds: 999_999 })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
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
      expect((error as UrmotivApiError).code).toBe("UNAUTHENTICATED");
      expect((error as UrmotivApiError).requestId).toBe("req-1");
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
        client.renew(assignmentId, { expectedLeaseExpiresAt: "2026-07-26T00:05:00.000Z", leaseSeconds: 300 })
      ).rejects.toSatisfy((error: unknown) => {
        expect(isTaskConflictError(error)).toBe(true);
        return true;
      });
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
});

describe("UrmotivClient：网络与契约错误", () => {
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
});
