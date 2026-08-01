import { afterEach, describe, expect, it, vi } from "vitest";
import { describeError, logError } from "../src/logger";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("安全错误码", () => {
  it("不记录普通 Error 的 message", () => {
    const sensitiveText = "题面、题解或模型原始内容";
    expect(describeError(new Error(sensitiveText))).toBe("UNEXPECTED_ERROR");
    expect(describeError(new Error(sensitiveText))).not.toContain(sensitiveText);
  });

  it("只接受格式受限的显式错误码", () => {
    expect(describeError({ code: "LLM_HTTP_ERROR", message: "外部原文" })).toBe(
      "LLM_HTTP_ERROR"
    );
    for (const code of [
      "LLM_NETWORK_FAILED",
      "LLM_FIRST_OUTPUT_TIMEOUT",
      "LLM_OUTPUT_IDLE_TIMEOUT",
      "LLM_TOTAL_TIMEOUT",
      "LLM_STREAM_INTERRUPTED",
      "LLM_CANCELLED",
      "LLM_OUTPUT_LENGTH_LIMIT",
      "LLM_OUTPUT_CONTENT_FILTERED"
    ]) {
      expect(describeError({ code, message: "外部原文" })).toBe(code);
    }
    expect(describeError({ code: "UNTRUSTED_EXTERNAL_CODE", message: "外部原文" })).toBe(
      "UNEXPECTED_ERROR"
    );
    expect(
      describeError({
        code: "LEVELS_CHECKPOINT_VERSION_UNSUPPORTED",
        message: "旧检查点内容"
      })
    ).toBe("LEVELS_CHECKPOINT_VERSION_UNSUPPORTED");
  });

  it("把解析、校验和取消请求映射为固定错误码", () => {
    expect(describeError(new SyntaxError("原始 JSON 片段"))).toBe("PARSE_ERROR");
    expect(describeError(Object.assign(new Error("校验详情"), { name: "ZodError" }))).toBe(
      "VALIDATION_ERROR"
    );
    expect(describeError(new DOMException("响应正文", "AbortError"))).toBe(
      "REQUEST_ABORTED"
    );
  });

  it("logError 的实际输出不包含 Error.message", () => {
    const sensitiveText = "服务商回显的题面与模型原始输出";
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    logError("模型请求失败", new Error(sensitiveText));
    const output = write.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain('errorCode="UNEXPECTED_ERROR"');
    expect(output).not.toContain(sensitiveText);
  });

  it("调用方字段不能覆盖由异常得到的可信错误码", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    logError(
      "模型请求失败",
      { code: "LLM_HTTP_ERROR" },
      { errorCode: "UNTRUSTED_EXTERNAL_CODE" }
    );
    const output = write.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain('errorCode="LLM_HTTP_ERROR"');
    expect(output).not.toContain("UNTRUSTED_EXTERNAL_CODE");
  });

  it("实验失败日志只记录合成序号，不记录可能敏感的题名", () => {
    const sensitiveTitle = "尚未公开的校内赛题名";
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    logError("这一例判定失败，跳过", new Error(sensitiveTitle), {
      caseKind: "normal",
      caseNumber: 1
    });
    const output = write.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain("caseNumber=1");
    expect(output).not.toContain(sensitiveTitle);
  });
});
