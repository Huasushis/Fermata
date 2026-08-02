import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmRequestStartGate } from "../src/llm";

const trustedRunnerState = vi.hoisted(() => ({
  runners: new WeakSet<object>(),
  productionRunners: new WeakSet<object>()
}));

// 生产 grant 故意没有公开签发入口。这里只在独立测试模块替换两个品牌读取器，
// 以覆盖真实编排器的一次性消费路径；生产模块没有新增测试开关或后门。
vi.mock("../src/review-flow/llm-roles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/review-flow/llm-roles")>();
  const hasTestBrand = (candidate: unknown): boolean =>
    typeof candidate === "object" && candidate !== null &&
    trustedRunnerState.runners.has(candidate);
  return {
    ...actual,
    isTrustedReviewFlowLlmBundle: hasTestBrand,
    isProductionEligibleReviewFlowLlmBundle: (candidate: unknown): boolean =>
      typeof candidate === "object" && candidate !== null &&
      trustedRunnerState.productionRunners.has(candidate)
  };
});

import {
  consumeReviewFlowSubmission,
  runReviewEvidenceFlow,
  runReviewEvidenceFlowCalibrationOutcome,
  type ReviewFlowRoles,
  type ReviewFlowSubmissionExpectation
} from "../src/review-flow/orchestrator";
import type { ReviewFlowLlmBundle } from "../src/review-flow/llm-roles";
import { reviewFlowRoleSchema, type ReviewFlowRole } from "../src/review-flow/schemas";
import { buildReviewFlowTaskSource } from "../src/review-flow/task-source";

const assignmentId = "3fa85f64-5717-4562-b3fc-2c963f66afa7";
const runId = "3fa85f64-5717-4562-b3fc-2c963f66afa8";
const problemContentHash = "b".repeat(64);
const accuracyEvidenceFingerprint = "f".repeat(64);
const startTime = new Date("2026-08-02T10:00:00.000Z");
const evidenceExpiry = "2026-08-02T10:01:00.000Z";

const receipt = {
  schemaVersion: 2,
  requestCount: 1,
  transportAttemptCount: 1,
  eofVerified: true,
  jsonSchemaValidated: true,
  responses: [{
    schemaVersion: 2,
    transportAttemptCount: 1,
    eofVerified: true,
    responseMode: "json",
    finishReasonStopVerified: true,
    sseDoneObserved: null
  }]
} as const;

function trustedResult(payload: unknown): unknown {
  return { schemaVersion: 1, payload, receipt };
}

function roles(): ReviewFlowRoles {
  return {
    solver: async () => trustedResult({
      solved: true,
      narrative: "合成独立解题过程。",
      approach: "直接处理输入。",
      claimedComplexity: "O(1)",
      uncertainties: []
    }),
    solutionAnalyst: async () => trustedResult({
      solverCorrect: true,
      officialSolutionCorrect: true,
      approachRelation: "equivalent",
      keyInsights: ["直接处理"],
      issues: [],
      rationale: "合成题解与独立解法一致。"
    }),
    technicalAuditor: async () => trustedResult({
      statementSolutionConsistency: "verified",
      judgeability: "verified",
      sampleConsistency: "verified",
      constraintSufficiency: "verified",
      referenceImplementation: {
        provided: false,
        status: "unavailable",
        executionMode: "not_executed",
        compileStatus: "not_run",
        sampleCount: 0,
        samplePassed: null,
        algorithmEquivalent: null,
        complexityAcceptable: null
      },
      concerns: [],
      rationale: "合成技术材料一致。"
    }),
    difficulty: async () => trustedResult({
      codeforcesDifficulty: 800,
      thinkingLevel: 1,
      codingLevel: 1,
      confidence: 0.9,
      rationale: "合成题难度较低。"
    }),
    editorialJudge: async () => trustedResult({
      qualityLevel: 4,
      noveltyLevel: 4,
      ideaDepthLevel: 4,
      naturalnessLevel: 4,
      contestantExperienceLevel: 4,
      evidenceCoverage: { strengths: "found", concerns: "none_found" },
      evidence: [{
        dimension: "idea_depth",
        direction: "strength",
        severity: "note",
        confidence: 0.8,
        summary: "合成正向证据。"
      }],
      rationale: "合成命题品味证据良好。"
    }),
    contestFit: async () => trustedResult({
      icpcFit: "strong",
      implementationBurden: 2,
      thinkingImplementationBalance: "strong",
      knowledgeFairness: "fair",
      problemsetRole: "introductory",
      roleConfidence: 0.8,
      evidenceCoverage: { strengths: "found", concerns: "none_found" },
      evidence: [{
        dimension: "icpc_fit",
        direction: "strength",
        severity: "note",
        confidence: 0.8,
        summary: "合成比赛适配证据。"
      }],
      rationale: "合成比赛适配良好。"
    }),
    originality: async () => trustedResult({
      originalityLevel: 4,
      sameProblemAsExisting: false,
      highestSimilarity: 0,
      evidenceIds: [],
      rationale: "合成检索没有候选。"
    }),
    tags: async () => trustedResult({
      tagIds: ["basic.simulation"],
      rationale: "选择固定目录中的合成标签。"
    }),
    critic: async () => trustedResult({
      conflicts: [],
      missingRoles: [],
      rationale: "合成证据没有冲突。"
    }),
    adversary: async () => trustedResult({
      counterexamples: [],
      rationale: "没有构造出合成反例。"
    }),
    adjudicator: async (view) => trustedResult({
      verdict: "approve",
      qualityLevel: 4,
      fixability: "none",
      strengths: ["合成材料完整"],
      improvements: "合成材料已经满足要求。",
      publicComment: "",
      privateNote: "",
      citedEvidenceIds: [view.evidence[0]!.evidenceId]
    })
  };
}

function runner(options: {
  readonly productionEligible?: boolean;
  readonly roleOverrides?: Partial<ReviewFlowRoles>;
} = {}): ReviewFlowLlmBundle {
  const identities = Object.freeze(Object.fromEntries(
    reviewFlowRoleSchema.options.map((role: ReviewFlowRole) => [role, {
      promptVersion: `${role}-submission-test-v1`,
      modelIdentity: "a".repeat(64)
    }])
  )) as ReviewFlowLlmBundle["identities"];
  const result: ReviewFlowLlmBundle = Object.freeze({
    roles: Object.freeze({ ...roles(), ...options.roleOverrides }),
    identities,
    runnerIdentity: "c".repeat(64),
    engineBuildFingerprint: "d".repeat(64),
    transportMode: "production_undici",
    accuracyEvidenceFingerprint
  });
  trustedRunnerState.runners.add(result);
  if (options.productionEligible ?? true) {
    trustedRunnerState.productionRunners.add(result);
  }
  return result;
}

function taskSource() {
  return buildReviewFlowTaskSource({
    assignmentId,
    leaseExpiresAt: "2026-08-02T10:10:00.000Z",
    problem: {
      id: "synthetic-problem",
      revision: 3,
      reviewRound: 2,
      contentHash: problemContentHash,
      title: "合成题目",
      type: "traditional",
      tagIds: ["basic.simulation"],
      content: {
        basicStatement: "合成题面。",
        basicSolution: "合成题解。",
        background: "",
        statement: "",
        inputFormat: "",
        outputFormat: "",
        constraints: "",
        solution: "",
        hints: ""
      },
      samples: [],
      limits: null
    },
    tagCatalog: {
      version: 7,
      tags: [{
        id: "basic.simulation",
        categoryId: "basic",
        categoryName: "基础算法",
        name: "模拟",
        description: "按题意实现。",
        aliases: [],
        active: true
      }]
    },
    reviewItems: [{
      id: "synthetic-anklang-v2",
      type: "org.ustc.urmotiv.anklang.similarity",
      source: "anklang",
      sourcePluginId: "org.ustc.urmotiv.anklang",
      visibility: "reviewer",
      summary: "合成完整查重摘要。",
      contentHash: problemContentHash,
      expiresAt: evidenceExpiry,
      createdAt: "2026-08-02T09:59:00.000Z",
      data: {
        apiVersion: "2",
        contentHash: problemContentHash,
        checkedAt: "2026-08-02T09:59:00.000Z",
        completion: {
          status: "complete",
          reasonCode: "complete",
          retryable: false
        },
        candidates: [],
        recommendation: {
          blockSubmission: false,
          message: "合成完整检索没有候选。"
        },
        reuse: { policy: "allowed", expiresAt: evidenceExpiry }
      }
    }]
  }, {
    duplicateSimilarityRejectThreshold: 0.9,
    now: () => new Date(startTime.getTime())
  });
}

function expectation(source: ReturnType<typeof taskSource>): ReviewFlowSubmissionExpectation {
  return {
    taskSource: source,
    assignmentId,
    problemContentHash,
    problemRevision: 3,
    expectedRound: 2,
    tagCatalogVersion: 7,
    accuracyEvidenceFingerprint
  };
}

async function decisionFor(source: ReturnType<typeof taskSource>) {
  return runReviewEvidenceFlow({
    taskSource: source,
    trustedRunner: runner(),
    executionContext: {
      schemaVersion: 1,
      runId,
      assignmentId,
      expectedRound: 2
    }
  });
}

describe("生产审题提交的一次性来源与时效绑定", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(startTime);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("错误的同内容 branded source 不会烧掉载荷；原始 source 首次成功、第二次拒绝", async () => {
    const originalSource = taskSource();
    const equivalentButDifferentSource = taskSource();
    const decision = await decisionFor(originalSource);

    expect(decision.executionEligible).toBe(true);
    expect(decision.runBinding.anklangEvidenceExpiresAt).toBe(evidenceExpiry);
    expect(() => consumeReviewFlowSubmission(
      decision,
      expectation(equivalentButDifferentSource)
    )).toThrow("REVIEW_FLOW_SUBMISSION_FORBIDDEN");

    const review = consumeReviewFlowSubmission(decision, expectation(originalSource));
    expect(review).toMatchObject({ verdict: "approve", expectedRound: 2 });
    expect(() => consumeReviewFlowSubmission(
      decision,
      expectation(originalSource)
    )).toThrow("REVIEW_FLOW_SUBMISSION_FORBIDDEN");
  });

  it("运行期间越过 Anklang 到期时刻后，提交载荷在消费前 fail closed", async () => {
    const source = taskSource();
    const decision = await decisionFor(source);

    vi.setSystemTime(new Date(evidenceExpiry));
    expect(() => consumeReviewFlowSubmission(
      decision,
      expectation(source)
    )).toThrow("REVIEW_FLOW_SUBMISSION_FORBIDDEN");
  });

  it("离线标定在任何角色执行前拒绝生产 bundle 与伪造来源/runner", async () => {
    const solver = vi.fn(roles().solver);
    const productionRunner = runner({ roleOverrides: { solver } });
    const source = taskSource();
    const input = {
      taskSource: source,
      trustedRunner: productionRunner,
      executionContext: {
        schemaVersion: 1,
        runId,
        assignmentId,
        expectedRound: 2
      },
      requestStartGate: new LlmRequestStartGate()
    };

    await expect(runReviewEvidenceFlowCalibrationOutcome(input)).rejects.toThrow(
      "REVIEW_FLOW_CALIBRATION_INPUT_FORBIDDEN"
    );
    expect(solver).not.toHaveBeenCalled();

    await expect(runReviewEvidenceFlowCalibrationOutcome({
      ...input,
      trustedRunner: { ...productionRunner }
    })).rejects.toThrow("REVIEW_FLOW_CALIBRATION_INPUT_FORBIDDEN");
    await expect(runReviewEvidenceFlowCalibrationOutcome({
      ...input,
      taskSource: { ...source },
      trustedRunner: runner({ productionEligible: false })
    })).rejects.toThrow("REVIEW_FLOW_CALIBRATION_INPUT_FORBIDDEN");
  });

  it("离线可信角色缺少完成 receipt 时只返回 incomplete", async () => {
    const offlineRunner = runner({
      productionEligible: false,
      roleOverrides: {
        solver: async () => ({
          solved: true,
          narrative: "合成但缺少 receipt 的输出。",
          approach: "直接处理输入。",
          claimedComplexity: "O(1)",
          uncertainties: []
        })
      }
    });
    const outcome = await runReviewEvidenceFlowCalibrationOutcome({
      taskSource: taskSource(),
      trustedRunner: offlineRunner,
      executionContext: {
        schemaVersion: 1,
        runId,
        assignmentId,
        expectedRound: 2
      },
      requestStartGate: new LlmRequestStartGate()
    });

    expect(outcome.status).toBe("incomplete");
    if (outcome.status !== "incomplete") throw new Error("expected incomplete");
    expect(outcome.failure.failedRoles).toEqual([{
      role: "solver",
      failureKind: "schema_output",
      httpStatus: null,
      requestCount: 0,
      transportAttemptCount: 0,
      completedResponseCount: 0,
      terminalResponseMode: null,
      terminalEofObserved: false,
      terminalFinishReasonStopObserved: false,
      terminalSseDoneObserved: null
    }]);
    expect(JSON.stringify(outcome)).not.toContain("缺少 receipt");
    expect(JSON.stringify(outcome)).not.toContain("projection");
  });
});
