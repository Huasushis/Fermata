import { describe, expect, it } from "vitest";
import {
  assertEvaluationRepositoryState,
  difficultyEvaluationCodePaths,
  hashEvaluationCodeBundle
} from "../experiments/lib/evaluation-code-identity";

const digest = "a".repeat(64);
const commit = "b".repeat(40);

describe("付费评测实际代码身份", () => {
  it("安全关键的私有运行边界属于登记的运行依赖", () => {
    expect(difficultyEvaluationCodePaths).toContain("experiments/eval-difficulty.ts");
    expect(difficultyEvaluationCodePaths).toContain("scripts/private-runtime.mjs");
    expect(new Set(difficultyEvaluationCodePaths).size).toBe(difficultyEvaluationCodePaths.length);
  });

  it("声明提交、真实 HEAD、干净工作树、runner 和依赖全集都一致时通过", () => {
    expect(() => assertEvaluationRepositoryState({
      expectedCodeVersion: commit,
      actualHead: commit,
      porcelain: "",
      trackedPrivatePaths: "",
      runnerWorkingSha256: digest,
      runnerHeadSha256: digest,
      dependencyWorkingSha256: digest,
      dependencyHeadSha256: digest
    })).not.toThrow();
  });

  it.each([
    { actualHead: "c".repeat(40) },
    { porcelain: " M src/llm.ts\n" },
    { trackedPrivatePaths: "private/secret.env\n" },
    { runnerWorkingSha256: "c".repeat(64) },
    { dependencyWorkingSha256: "c".repeat(64) }
  ])("任一身份不一致都在付费前固定拒绝：%o", (override) => {
    expect(() => assertEvaluationRepositoryState({
      expectedCodeVersion: commit,
      actualHead: commit,
      porcelain: "",
      trackedPrivatePaths: "",
      runnerWorkingSha256: digest,
      runnerHeadSha256: digest,
      dependencyWorkingSha256: digest,
      dependencyHeadSha256: digest,
      ...override
    })).toThrow("EVALUATION_CODE_IDENTITY_INVALID");
  });

  it("依赖路径和字节都进入稳定全集哈希", () => {
    const original = hashEvaluationCodeBundle([
      { path: "src/b.ts", bytes: new TextEncoder().encode("b") },
      { path: "src/a.ts", bytes: new TextEncoder().encode("a") }
    ]);
    expect(hashEvaluationCodeBundle([
      { path: "src/a.ts", bytes: new TextEncoder().encode("a") },
      { path: "src/b.ts", bytes: new TextEncoder().encode("b") }
    ])).toBe(original);
    expect(hashEvaluationCodeBundle([
      { path: "src/a.ts", bytes: new TextEncoder().encode("changed") },
      { path: "src/b.ts", bytes: new TextEncoder().encode("b") }
    ])).not.toBe(original);
    expect(() => hashEvaluationCodeBundle([
      { path: "../outside.ts", bytes: new Uint8Array() }
    ])).toThrow("EVALUATION_CODE_IDENTITY_INVALID");
  });

});
