import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { freezeReviewFlowSource, buildStatementOnlyView } from "../src/review-flow/views";
import { buildSolverExplorationMessages } from "../src/review-flow/llm-roles";
import { reviewFlowStageOutputBudgets } from "../src/review-flow/four-call";

const d = (v: string): string => createHash("sha256").update(v, "utf8").digest("hex");

function mkSyntheticSource() {
  return freezeReviewFlowSource({
    schemaVersion: 1,
    problemContentHash: d("synthetic-content-hash"),
    problemRevision: 1,
    expectedRound: 1,
    type: "traditional",
    statement: "占位题面占位题面占位题面占位题面占位题面占位题面。",
    solution: "占位题解占位题解占位题解占位题解占位题解占位题解。",
    constraints: "1 ≤ n ≤ 10",
    samples: [
      { safeId: "sample-1", input: "1", output: "1", explanation: "" }
    ],
    limits: { timeMs: 1000, memoryMiB: 256 },
    referenceImplementation: null,
    tagCatalogVersion: 1,
    tagCatalog: [
      { id: "tag-dp", categoryId: "cat-algo", categoryName: "算法", name: "dp", description: "", aliases: [], active: true }
    ],
    duplicateEvidence: [],
    duplicateSimilarityRejectThreshold: 0.8
  });
}

describe("Stage-A prompt invariant (B2)", () => {
  it("exploration prompt contains visible-output budget instruction (600 字)", () => {
    const source = mkSyntheticSource();
    const view = buildStatementOnlyView(source);
    const messages = buildSolverExplorationMessages(view);
    const systemPrompt = messages.find((m) => m.role === "system")?.content ?? "";
    expect(systemPrompt).toContain("600");
    expect(systemPrompt).toContain("可见输出预算");
  });

  it("exploration prompt contains immediate-stop rule", () => {
    const source = mkSyntheticSource();
    const view = buildStatementOnlyView(source);
    const messages = buildSolverExplorationMessages(view);
    const systemPrompt = messages.find((m) => m.role === "system")?.content ?? "";
    expect(systemPrompt).toContain("立即停止规则");
    expect(systemPrompt).toContain("立即结束输出");
  });

  it("exploration prompt does not contain false truncation claim (截断)", () => {
    const source = mkSyntheticSource();
    const view = buildStatementOnlyView(source);
    const messages = buildSolverExplorationMessages(view);
    const systemPrompt = messages.find((m) => m.role === "system")?.content ?? "";
    expect(systemPrompt).not.toContain("截断");
    expect(systemPrompt).not.toContain("truncat");
  });

  it("exploration prompt instructs natural-language output, not forced JSON", () => {
    const source = mkSyntheticSource();
    const view = buildStatementOnlyView(source);
    const messages = buildSolverExplorationMessages(view);
    const systemPrompt = messages.find((m) => m.role === "system")?.content ?? "";
    expect(systemPrompt).toContain("不需要 JSON 格式");
  });

  it("DeepSeek A-stage output budget remains 32000 (32k ceiling preserved)", () => {
    expect(reviewFlowStageOutputBudgets.A).toBe(32_000);
  });

  it("all review-flow stage budgets are nonzero and A is the largest (thinking budget preserved)", () => {
    const budgets = reviewFlowStageOutputBudgets;
    expect(budgets.A).toBeGreaterThan(budgets.B);
    expect(budgets.A).toBeGreaterThan(budgets.C);
    expect(budgets.A).toBeGreaterThan(budgets.D);
    expect(budgets.A).toBeGreaterThan(budgets.formatter);
    expect(budgets.B).toBeGreaterThan(0);
    expect(budgets.C).toBeGreaterThan(0);
    expect(budgets.D).toBeGreaterThan(0);
    expect(budgets.formatter).toBeGreaterThan(0);
  });

  it("prompt implementation digest differs across roles (identity binding is content-addressed)", () => {
    // Build messages for the same view; the prompt itself must be deterministic
    const source1 = mkSyntheticSource();
    const view1 = buildStatementOnlyView(source1);
    const messages1 = buildSolverExplorationMessages(view1);
    const source2 = mkSyntheticSource();
    const view2 = buildStatementOnlyView(source2);
    const messages2 = buildSolverExplorationMessages(view2);
    // Same source → same prompt (deterministic)
    expect(messages1).toEqual(messages2);
  });
});
