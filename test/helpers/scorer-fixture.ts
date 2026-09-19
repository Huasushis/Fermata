import type { AppConfig } from "../../src/config";
import type { FermataPublicSettings, ReviewInput, RobotReviewTask } from "../../src/urmotiv-schemas";

export const appConfig: AppConfig = {
  urmotiv: { baseUrl: "https://urmotiv.example.test", robotToken: "urv_test_token_1234567890" },
  server: { port: 8720, managementToken: "management-token-1234567890", settingsPath: "./data/settings.json" },
  providers: { aether: { baseUrl: "https://llm.example.test/v1", apiKey: "sk-test" } },
  codeforces: null,
  models: {
    experimentVersion: "exp-test",
    defaults: { modelProfileName: "test-profile", pollingIntervalSeconds: 30, maximumConcurrentTasks: 2 },
    profiles: {
      "test-profile": {
        difficulty: { provider: "aether", model: "m", temperature: 0.2, thinking: false },
        thinking: {
          solver: { provider: "aether", model: "m", temperature: 0.4, thinking: true },
          analyst: { provider: "aether", model: "m", temperature: 0.1, thinking: false }
        },
        coding: { provider: "aether", model: "m", temperature: 0.3, thinking: false },
        verdict: { provider: "aether", model: "m", temperature: 0.1, thinking: false },
        reviewFlow: {
          solver: { provider: "aether", model: "m", temperature: 0.1, thinking: false },
          solutionAnalyst: { provider: "aether", model: "m", temperature: 0.1, thinking: false },
          technicalAuditor: { provider: "aether", model: "m", temperature: 0.1, thinking: false },
          difficulty: { provider: "aether", model: "m", temperature: 0.1, thinking: false },
          editorialJudge: { provider: "aether", model: "m", temperature: 0.1, thinking: false },
          contestFit: { provider: "aether", model: "m", temperature: 0.1, thinking: false },
          originality: { provider: "aether", model: "m", temperature: 0.1, thinking: false },
          tags: { provider: "aether", model: "m", temperature: 0.1, thinking: false },
          critic: { provider: "aether", model: "m", temperature: 0.1, thinking: false },
          adversary: { provider: "aether", model: "m", temperature: 0.1, thinking: false },
          adjudicator: { provider: "aether", model: "m", temperature: 0.1, thinking: false }
        }
      }
    },
    retry: { maxAttempts: 1, baseDelayMs: 1 },
    timeouts: {
      llmFirstOutputMs: 120_000,
      llmOutputIdleMs: 120_000,
      llmMaximumDurationMs: 300_000,
      codeforcesRequestMs: 5_000
    },
    codeforces: { minimumRequestIntervalMs: 0 },
    thresholds: { duplicateSimilarityReject: 0.9 }
  }
};

export const settings: FermataPublicSettings = { enabled: true, pollingIntervalSeconds: 30, maximumConcurrentTasks: 2, modelProfileName: "test-profile", experimentVersion: "exp-test" };
export const review: ReviewInput = { verdict: "approve", codeforcesDifficulty: 1000, qualityLevel: 3, thinkingLevel: 1, codingLevel: 1, originalityLevel: null, tagIds: ["math"], improvements: "合成测试意见", privateNote: "", expectedRound: 2 };
export function task(id = "11111111-1111-4111-8111-111111111111"): RobotReviewTask {
 return { assignmentId: id, leaseExpiresAt: new Date(Date.now() + 300000).toISOString(), problem: { id: "synthetic-problem", revision: 3, reviewRound: 2, contentHash: "a".repeat(64), title: "合成测试", type: "traditional", tagIds: ["math"], content: { basicStatement: "输入两个整数，输出它们的和。", basicSolution: "使用整数加法。", background: "", statement: "", inputFormat: "", outputFormat: "", constraints: "", solution: "", hints: "" }, samples: [], limits: null }, tagCatalog: { version: 4, tags: [{ id: "math", name: "数学", categoryId: "basic", categoryName: "基础", description: "", aliases: [], active: true }] }, reviewItems: [] };
}
