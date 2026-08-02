import { describe, expect, it } from "vitest";
import { parseEnvFile } from "../scripts/env-file.mjs";
import {
  buildReviewFlowEvaluationEnvFile
} from "../scripts/prepare-review-flow-evaluation-env.mjs";

const commit = "1".repeat(40);

describe("review-flow 专用环境准备", () => {
  it("只复制成对 provider，并加入当前提交和受限并发", () => {
    const content = buildReviewFlowEvaluationEnvFile(
      "AETHER_BASE_URL=https://example.invalid/v1\n" +
        "AETHER_API_KEY='secret=value'\n" +
        "URMOTIV_ROBOT_TOKEN=never-copy\n" +
        "DASHSCOPE_BASE_URL=https://dashscope.invalid/v1\n" +
        "DASHSCOPE_API_KEY=another-secret\n",
      commit,
      2
    );
    expect(parseEnvFile(content)).toEqual({
      AETHER_BASE_URL: "https://example.invalid/v1",
      AETHER_API_KEY: "secret=value",
      DASHSCOPE_BASE_URL: "https://dashscope.invalid/v1",
      DASHSCOPE_API_KEY: "another-secret",
      EVAL_CODE_VERSION: commit,
      EVAL_CONCURRENCY: "2"
    });
    expect(content).not.toContain("URMOTIV_");
  });

  it.each([
    "",
    "AETHER_BASE_URL=https://example.invalid/v1\n",
    "AETHER_API_KEY=secret\n",
    "AETHER_BASE_URL=\nAETHER_API_KEY=secret\n"
  ])("拒绝没有完整 provider 对的输入 %#", (content) => {
    expect(() => buildReviewFlowEvaluationEnvFile(content, commit)).toThrow(
      "REVIEW_FLOW_EVALUATION_ENV_PREPARATION_FAILED"
    );
  });

  it("拒绝无效提交号和并发", () => {
    const source =
      "AETHER_BASE_URL=https://example.invalid/v1\nAETHER_API_KEY=secret\n";
    expect(() => buildReviewFlowEvaluationEnvFile(source, "0".repeat(40)))
      .toThrow("REVIEW_FLOW_EVALUATION_ENV_PREPARATION_FAILED");
    expect(() => buildReviewFlowEvaluationEnvFile(source, commit, 33))
      .toThrow("REVIEW_FLOW_EVALUATION_ENV_PREPARATION_FAILED");
  });
});
