import { describe, expect, it, vi } from "vitest";
import { assertEvidenceArtifact, sealEvidenceArtifact } from "../src/review-flow/evidence";
import {
  consumeReviewFlowSubmission,
  inspectReviewFlowArtifactsForTest,
  inspectReviewFlowSubmissionForTest,
  runReviewEvidenceFlow,
  runReviewEvidenceFlowOutcome,
  type ReviewFlowInput,
  type ReviewFlowDecision,
  type ReviewFlowRoles
} from "../src/review-flow/orchestrator";
import {
  createReviewFlowLlmBundle,
  type ReviewFlowModelConfigs
} from "../src/review-flow/llm-roles";
import { buildReviewFlowTaskSource } from "../src/review-flow/task-source";
import type { PipelineModelConfig } from "../src/pipelines/types";
import {
  reviewFlowRoleSchema,
  solverPayloadSchema,
  type ReviewFlowRole,
  type RoleIdentity
} from "../src/review-flow/schemas";

const solutionSentinel = "PRIVATE_SOLUTION_SENTINEL_731";
const modelIdentity = "a".repeat(64);

function source(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    problemContentHash: "b".repeat(64),
    problemRevision: 3,
    expectedRound: 2,
    type: "traditional",
    statement: "合成题面：给定一个整数，输出它。",
    solution: `合成题解：直接输出。${solutionSentinel}`,
    constraints: "整数在安全范围内。",
    samples: [{
      safeId: "sample-1",
      input: "1\n",
      output: "1\n",
      explanation: ""
    }],
    referenceImplementation: { language: "cpp", source: "int main(){}" },
    tagCatalogVersion: 7,
    tagCatalog: [
      {
        id: "basic.simulation",
        categoryId: "basic",
        categoryName: "基础算法",
        name: "模拟",
        description: "按题意实现",
        aliases: [],
        active: true
      },
      {
        id: "math.counting",
        categoryId: "math",
        categoryName: "数学",
        name: "计数",
        description: "计数方法",
        aliases: ["组合计数"],
        active: true
      }
    ],
    duplicateEvidence: [{
      evidenceId: "duplicate-1",
      source: "synthetic",
      externalId: "public-1",
      similarity: 0.2,
      sameProblemSuggestion: false,
      summary: "合成查重摘要"
    }],
    duplicateSimilarityRejectThreshold: 0.9,
    ...overrides
  };
}

function identities(): Readonly<Record<ReviewFlowRole, RoleIdentity>> {
  return Object.fromEntries(reviewFlowRoleSchema.options.map((role) => [
    role,
    { promptVersion: `${role}-v1`, modelIdentity }
  ])) as Record<ReviewFlowRole, RoleIdentity>;
}

function defaultRoles(overrides: Partial<ReviewFlowRoles> = {}): ReviewFlowRoles {
  return {
    solver: async () => ({
      solved: true,
      narrative: "独立解题过程",
      approach: "直接处理输入",
      claimedComplexity: "O(1)",
      uncertainties: []
    }),
    solutionAnalyst: async () => ({
      solverCorrect: true,
      officialSolutionCorrect: true,
      approachRelation: "equivalent",
      keyInsights: ["直接处理"],
      issues: [],
      rationale: "两种思路一致。"
    }),
    technicalAuditor: async () => ({
      statementSolutionConsistency: "verified",
      judgeability: "verified",
      sampleConsistency: "verified",
      constraintSufficiency: "verified",
      referenceImplementation: {
        provided: true,
        status: "verified",
        executionMode: "sandbox",
        compileStatus: "passed",
        sampleCount: 1,
        samplePassed: 1,
        algorithmEquivalent: true,
        complexityAcceptable: true
      },
      concerns: [],
      rationale: "合成隔离验证通过。"
    }),
    difficulty: async () => ({
      codeforcesDifficulty: 800,
      thinkingLevel: 1,
      codingLevel: 1,
      confidence: 0.9,
      rationale: "合成题很基础。"
    }),
    editorialJudge: async () => ({
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
    contestFit: async () => ({
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
        summary: "适合合成赛制。"
      }],
      rationale: "合成 ICPC 适配证据良好。"
    }),
    originality: async () => ({
      originalityLevel: 4,
      sameProblemAsExisting: false,
      highestSimilarity: 0.2,
      evidenceIds: ["duplicate-1"],
      rationale: "未发现同题。"
    }),
    tags: async () => ({
      tagIds: ["basic.simulation", "math.counting"],
      rationale: "对应两项固定标签。"
    }),
    critic: async () => ({
      conflicts: [],
      missingRoles: [],
      rationale: "未发现冲突。"
    }),
    adversary: async () => ({
      counterexamples: [],
      rationale: "未构造出致命反例。"
    }),
    adjudicator: async (view) => ({
      verdict: "approve",
      qualityLevel: 4,
      fixability: "none",
      strengths: ["合成优点"],
      improvements: "材料已满足合成验收要求。",
      publicComment: "",
      privateNote: "",
      citedEvidenceIds: [view.evidence[0]!.evidenceId]
    }),
    ...overrides
  };
}

const trustedReceipt = {
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

function executionContext(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    runId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    assignmentId: "3fa85f64-5717-4562-b3fc-2c963f66afa7",
    expectedRound: 2,
    ...overrides
  };
}

function trustedTaskSource() {
  const contentHash = "b".repeat(64);
  return buildReviewFlowTaskSource({
    assignmentId: executionContext().assignmentId,
    leaseExpiresAt: "2026-08-02T01:00:00.000Z",
    problem: {
      id: "problem-synthetic-1",
      revision: 3,
      reviewRound: 2,
      contentHash,
      title: "合成题目",
      type: "traditional",
      tagIds: ["basic.simulation", "math.counting"],
      content: {
        basicStatement: "合成题面：给定一个整数，输出它。",
        basicSolution: `合成题解：直接输出。${solutionSentinel}`,
        background: "",
        statement: "",
        inputFormat: "",
        outputFormat: "",
        constraints: "整数在安全范围内。",
        solution: "",
        hints: ""
      },
      samples: [{
        safeId: "sample-001",
        input: "1\n",
        output: "1\n",
        explanation: ""
      }],
      limits: null
    },
    tagCatalog: {
      version: 7,
      tags: source().tagCatalog
    },
    reviewItems: [{
      id: "synthetic-anklang-v2",
      type: "org.ustc.urmotiv.anklang.similarity",
      source: "anklang",
      sourcePluginId: "org.ustc.urmotiv.anklang",
      visibility: "reviewer",
      summary: "合成完整查重摘要",
      data: {
        apiVersion: "2",
        contentHash,
        checkedAt: "2026-08-02T00:00:00.000Z",
        completion: {
          status: "complete",
          reasonCode: "complete",
          retryable: false
        },
        candidates: [{
          source: "synthetic",
          externalId: "public-1",
          title: "合成公开候选",
          similarity: 0.2,
          sameProblemSuggestion: false,
          explanation: "合成查重摘要"
        }],
        recommendation: {
          blockSubmission: false,
          message: "合成完整检索未发现同题。"
        },
        reuse: { policy: "no-store" }
      },
      contentHash,
      expiresAt: null,
      createdAt: "2026-08-02T00:00:00.000Z"
    }]
  }, { duplicateSimilarityRejectThreshold: 0.9 });
}

function syntheticRoleFetch(): PipelineModelConfig["runtime"]["fetch"] {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as {
      readonly messages: readonly { readonly role: string; readonly content: string }[];
    };
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
    const userMessage = [...request.messages].reverse().find((message) => message.role === "user");
    const user = userMessage === undefined
      ? {}
      : JSON.parse(userMessage.content) as Record<string, unknown>;
    let payload: unknown;
    if (system.includes("独立选手")) {
      payload = {
        solved: true,
        narrative: "合成独立解题记录。",
        approach: "直接处理。",
        claimedComplexity: "O(1)",
        uncertainties: []
      };
    } else if (system.includes("题解分析者")) {
      payload = {
        solverCorrect: true,
        officialSolutionCorrect: true,
        approachRelation: "equivalent",
        keyInsights: ["直接处理"],
        issues: [],
        rationale: "合成分析一致。"
      };
    } else if (system.includes("技术核验员")) {
      payload = {
        statementSolutionConsistency: "verified",
        judgeability: "verified",
        sampleConsistency: "verified",
        constraintSufficiency: "verified",
        concerns: [],
        rationale: "合成技术核验。"
      };
    } else if (system.includes("独立难度评估者")) {
      payload = {
        codeforcesDifficulty: 800,
        thinkingLevel: 1,
        codingLevel: 1,
        confidence: 0.8,
        rationale: "合成难度。"
      };
    } else if (system.includes("资深算法竞赛命题审稿人")) {
      payload = {
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
        rationale: "合成命题品味。"
      };
    } else if (system.includes("ICPC 风格比赛的题组审稿人")) {
      payload = {
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
        rationale: "合成比赛适配。"
      };
    } else if (system.includes("原创性证据分析者")) {
      const evidence = user.duplicateEvidence as readonly {
        readonly evidenceId: string;
        readonly similarity: number;
      }[];
      payload = {
        originalityLevel: 4,
        sameProblemAsExisting: false,
        highestSimilarity: Math.max(0, ...evidence.map((item) => item.similarity)),
        evidenceIds: evidence.map((item) => item.evidenceId),
        rationale: "合成原创性。"
      };
    } else if (system.includes("知识点标签整理员")) {
      const catalog = user.tagCatalog as readonly { readonly id: string }[];
      payload = { tagIds: catalog.slice(0, 2).map((tag) => tag.id), rationale: "合成标签。" };
    } else if (system.includes("证据批评者")) {
      payload = { conflicts: [], missingRoles: [], rationale: "合成无冲突。" };
    } else if (system.includes("独立反方审稿人")) {
      payload = { counterexamples: [], rationale: "合成无反例。" };
    } else if (system.includes("最终审题裁决者")) {
      const evidence = user.evidence as readonly { readonly evidenceId: string }[];
      payload = {
        verdict: "approve",
        qualityLevel: 4,
        fixability: "none",
        strengths: ["合成优点"],
        improvements: "合成材料已满足要求。",
        publicComment: "",
        privateNote: "",
        citedEvidenceIds: [evidence[0]!.evidenceId]
      };
    } else {
      throw new Error("unexpected_synthetic_role");
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

function syntheticTrustedRunner(fetchImpl = syntheticRoleFetch()) {
  const model: PipelineModelConfig = {
    spec: { provider: "aether", model: "synthetic-model", temperature: 0, thinking: false },
    credentials: { baseUrl: "https://llm.example.test/v1", apiKey: "synthetic-key" },
    runtime: {
      outputIdleTimeoutMs: 600_000,
      firstOutputTimeoutMs: 1_800_000,
      maximumDurationMs: 14_400_000,
      maxAttempts: 1,
      baseDelayMs: 1,
      fetch: fetchImpl
    }
  };
  const models = Object.fromEntries(
    reviewFlowRoleSchema.options.map((role) => [role, model])
  ) as ReviewFlowModelConfigs;
  return {
    runner: createReviewFlowLlmBundle({
      models,
      difficultyAnchors: [],
      profileName: "synthetic-profile",
      experimentVersion: "synthetic-experiment",
      engineBuildFingerprint: "c".repeat(64),
      productionGrant: null
    }),
    fetchImpl
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function artifacts(decision: ReviewFlowDecision) {
  return inspectReviewFlowArtifactsForTest(decision);
}

function submission(decision: ReviewFlowDecision) {
  return inspectReviewFlowSubmissionForTest(decision);
}

describe("冻结证据多角色审题编排", () => {
  it("solver 运行时只收到题面视图，题解、标签、查重和自报答案均不可见", async () => {
    let serializedSolverView = "";
    const decision = await runReviewEvidenceFlow({
      source: source(),
      identities: identities(),
      roles: defaultRoles({
        solver: async (view) => {
          serializedSolverView = JSON.stringify(view);
          expect(Object.keys(view).sort()).toEqual([
            "constraints",
            "limits",
            "problemContentHash",
            "samples",
            "schemaVersion",
            "statement",
            "type"
          ]);
          expect(Object.isFrozen(view)).toBe(true);
          expect(Object.isFrozen(view.samples)).toBe(true);
          expect(() => {
            (view as { statement: string }).statement = "mutated";
          }).toThrow();
          return {
            solved: true,
            narrative: "独立解题过程",
            approach: "直接处理输入",
            claimedComplexity: "O(1)",
            uncertainties: []
          };
        }
      })
    });
    expect(serializedSolverView).not.toContain(solutionSentinel);
    expect(serializedSolverView).not.toContain("tagCatalog");
    expect(serializedSolverView).not.toContain("duplicateEvidence");
    expect(submission(decision).verdict).toBe("approve");
    expect(submission(decision).tagIds).toEqual(["basic.simulation", "math.counting"]);
    expect(decision.tagCatalogVersion).toBe(7);
    expect(decision.evidenceIds).toHaveLength(11);
    expect(decision.executionEligible).toBe(false);
    expect(decision.accuracyEvidenceFingerprint).toBeNull();
    expect(decision.runContextHash).toBeNull();
    expect(decision.runBinding).toMatchObject({
      problemRevision: 3,
      expectedRound: 2,
      runId: null,
      assignmentId: null,
      runnerIdentity: null
    });
    expect(artifacts(decision).solver.execution.trust).toBe("untrusted_local");
    expect(JSON.stringify(decision)).not.toContain("payload");
    expect(JSON.stringify(decision)).not.toContain(solutionSentinel);
  });

  it("公开 decision 不可序列化最终评论，私有提交载荷冻结且不合格执行不能消费", async () => {
    const commentSentinel = "PRIVATE_FINAL_COMMENT_SENTINEL_947";
    const decision = await runReviewEvidenceFlow({
      source: source(),
      identities: identities(),
      roles: defaultRoles({
        adjudicator: async (view) => ({
          verdict: "approve",
          qualityLevel: 4,
          fixability: "none",
          strengths: ["合成优点"],
          improvements: commentSentinel,
          publicComment: commentSentinel,
          privateNote: commentSentinel,
          citedEvidenceIds: [view.evidence[0]!.evidenceId]
        })
      })
    });
    const serialized = JSON.stringify({ status: "complete", decision });
    expect(Object.keys(decision)).not.toContain("review");
    expect(serialized).not.toContain(commentSentinel);
    expect(submission(decision).improvements).toBe(commentSentinel);
    expect(Object.isFrozen(submission(decision))).toBe(true);
    expect(() => consumeReviewFlowSubmission(decision, {
      taskSource: {},
      assignmentId: executionContext().assignmentId,
      problemContentHash: "b".repeat(64),
      problemRevision: 3,
      expectedRound: 2,
      tagCatalogVersion: 7,
      accuracyEvidenceFingerprint: "f".repeat(64)
    })).toThrow("REVIEW_FLOW_SUBMISSION_FORBIDDEN");
    expect(() => consumeReviewFlowSubmission({} as ReviewFlowDecision, {
      taskSource: {},
      assignmentId: executionContext().assignmentId,
      problemContentHash: "b".repeat(64),
      problemRevision: 3,
      expectedRound: 2,
      tagCatalogVersion: 7,
      accuracyEvidenceFingerprint: "f".repeat(64)
    })).toThrow("REVIEW_FLOW_SUBMISSION_FORBIDDEN");
  });

  it("可信执行把任务、轮次、完整输入快照和每个角色的真实 EOF receipt 绑定进 artifact", async () => {
    const { runner } = syntheticTrustedRunner();
    const first = await runReviewEvidenceFlow({
      taskSource: trustedTaskSource(),
      trustedRunner: runner,
      executionContext: executionContext()
    });
    expect(first.executionEligible).toBe(false);
    expect(first.executionTransportMode).toBe("injected_fetch");
    expect(first.runContextHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.runBinding).toEqual({
      schemaVersion: 1,
      problemContentHash: "b".repeat(64),
      problemId: "problem-synthetic-1",
      problemRevision: 3,
      expectedRound: 2,
      tagCatalogVersion: 7,
      taskProvenanceHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      anklangEvidenceExpiresAt: null,
      engineBuildFingerprint: "c".repeat(64),
      accuracyEvidenceFingerprint: null,
      runId: executionContext().runId,
      assignmentId: executionContext().assignmentId,
      runnerIdentity: expect.stringMatching(/^[0-9a-f]{64}$/u)
    });
    expect(first.runBinding.runnerIdentity).toBe(runner.runnerIdentity);
    expect(first.sourceSnapshotHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.roleCompletions).toHaveLength(11);
    for (const artifact of Object.values(artifacts(first))) {
      expect(artifact.sourceSnapshotHash).toBe(first.sourceSnapshotHash);
      expect(artifact.execution).toEqual({
        trust: "trusted_llm",
        runContextHash: first.runContextHash,
        completionReceipt: trustedReceipt
      });
    }

    const nextRun = await runReviewEvidenceFlow({
      taskSource: trustedTaskSource(),
      trustedRunner: runner,
      executionContext: executionContext({
        runId: "3fa85f64-5717-4562-b3fc-2c963f66afa8"
      })
    });
    expect(nextRun.sourceSnapshotHash).toBe(first.sourceSnapshotHash);
    expect(nextRun.runContextHash).not.toBe(first.runContextHash);
    expect(artifacts(nextRun).solver.evidenceId).not.toBe(artifacts(first).solver.evidenceId);
    expect(nextRun.policyHash).toBe(first.policyHash);
    expect(nextRun.decisionId).not.toBe(first.decisionId);
  });

  it("499 明确形成带安全尝试数和 EOF 状态的不完整结果", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 499 }));
    const { runner } = syntheticTrustedRunner(fetchImpl);
    const outcome = await runReviewEvidenceFlowOutcome({
      taskSource: trustedTaskSource(),
      trustedRunner: runner,
      executionContext: executionContext()
    });
    expect(outcome.status).toBe("incomplete");
    if (outcome.status !== "incomplete") throw new Error("expected incomplete");
    expect(outcome.failure.failedRoles).toEqual([{
      role: "solver",
      failureKind: "service_http",
      httpStatus: 499,
      requestCount: 1,
      transportAttemptCount: 1,
      completedResponseCount: 0,
      terminalResponseMode: null,
      terminalEofObserved: false,
      terminalFinishReasonStopObserved: false,
      terminalSseDoneObserved: null
    }]);
    expect(outcome.failure.runBinding).toMatchObject({
      problemRevision: 3,
      runId: executionContext().runId,
      assignmentId: executionContext().assignmentId
    });
    expect(JSON.stringify(outcome)).not.toContain(solutionSentinel);
  });

  it("可信角色通过传输后若业务校验失败，只记失败并保留真实 EOF receipt", async () => {
    const baseFetch = syntheticRoleFetch();
    const fetchImpl: PipelineModelConfig["runtime"]["fetch"] = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          readonly messages: readonly { readonly role: string; readonly content: string }[];
        };
        const system = request.messages
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .join("\n");
        if (!system.includes("知识点标签整理员")) return baseFetch!(url, init);
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                tagIds: ["invented.tag"],
                rationale: "合成目录外标签。"
              })
            },
            finish_reason: "stop"
          }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    );
    const { runner } = syntheticTrustedRunner(fetchImpl);
    const outcome = await runReviewEvidenceFlowOutcome({
      taskSource: trustedTaskSource(),
      trustedRunner: runner,
      executionContext: executionContext()
    });
    expect(outcome.status).toBe("incomplete");
    if (outcome.status !== "incomplete") throw new Error("expected incomplete");
    expect(outcome.failure.failedRoles).toEqual([{
      role: "tags",
      failureKind: "validation",
      httpStatus: null,
      requestCount: 1,
      transportAttemptCount: 1,
      completedResponseCount: 1,
      terminalResponseMode: "json",
      terminalEofObserved: true,
      terminalFinishReasonStopObserved: true,
      terminalSseDoneObserved: null
    }]);
    expect(outcome.failure.completedRoles.map((entry) => entry.role)).not.toContain("tags");
  });

  it("并行角色全部收束并保留每个失败角色，不泄露异常文字", async () => {
    const privateFailure = "PRIVATE_MODEL_FAILURE_SENTINEL";
    const outcome = await runReviewEvidenceFlowOutcome({
      source: source(),
      identities: identities(),
      roles: defaultRoles({
        difficulty: async () => { throw new Error(privateFailure); },
        editorialJudge: async () => { throw new Error(privateFailure); }
      })
    });
    expect(outcome.status).toBe("incomplete");
    if (outcome.status !== "incomplete") throw new Error("expected incomplete");
    expect(outcome.failure.failedRoles.map((failure) => failure.role)).toEqual([
      "difficulty",
      "editorial_judge"
    ]);
    expect(outcome.failure.completedRoles.map((entry) => entry.role)).toEqual([
      "solver",
      "solution_analyst",
      "technical_auditor",
      "contest_fit",
      "originality",
      "tags"
    ]);
    expect(JSON.stringify(outcome)).not.toContain(privateFailure);
    expect(JSON.stringify(outcome)).not.toContain(solutionSentinel);
  });

  it("可信上下文缺 receipt 或轮次不匹配都在付费工作流边界 fail-closed", async () => {
    const forged = {
      roles: defaultRoles(),
      identities: identities(),
      runnerIdentity: "9".repeat(64),
      transportMode: "production_undici"
    };
    await expect(runReviewEvidenceFlow({
      taskSource: trustedTaskSource(),
      trustedRunner: forged,
      executionContext: executionContext()
    })).rejects.toMatchObject({
      code: "REVIEW_FLOW_TRUSTED_RUNNER_INVALID",
      failureKind: "input_invalid"
    });

    const { runner, fetchImpl } = syntheticTrustedRunner();
    await expect(runReviewEvidenceFlow({
      taskSource: trustedTaskSource(),
      trustedRunner: runner,
      executionContext: executionContext({ expectedRound: 3 })
    })).rejects.toMatchObject({
      code: "REVIEW_FLOW_EXECUTION_CONTEXT_INVALID",
      failureKind: "input_invalid"
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    const untrustedContext = {
      source: source(),
      identities: identities(),
      roles: defaultRoles(),
      executionContext: executionContext()
    } as unknown as ReviewFlowInput;
    await expect(runReviewEvidenceFlow(untrustedContext)).rejects.toMatchObject({
      code: "REVIEW_FLOW_EXECUTION_CONTEXT_INVALID",
      failureKind: "input_invalid"
    });
  });

  it("角色失败只保留封闭安全分类，不传播服务商正文或任意错误文本", async () => {
    const error = Object.assign(new Error("不应进入上层报告的合成正文"), {
      code: "LLM_OUTPUT_IDLE_TIMEOUT"
    });
    const caught = await runReviewEvidenceFlow({
      source: source(),
      identities: identities(),
      roles: defaultRoles({ solver: async () => { throw error; } })
    }).catch((failure: unknown) => failure);
    expect(caught).toMatchObject({
      code: "REVIEW_FLOW_ROLE_FAILED",
      role: "solver",
      failureKind: "timeout",
      message: "REVIEW_FLOW_ROLE_FAILED"
    });
    expect(JSON.stringify(caught)).not.toContain("合成正文");
  });

  it("先冻结 solver，再读取题解；solver artifact 不能被后续角色修改", async () => {
    const releaseSolver = deferred();
    const solverStarted = deferred();
    const analyst = vi.fn(async (view) => {
      expect(Object.isFrozen(view.solver)).toBe(true);
      expect(Object.isFrozen(view.solver.payload)).toBe(true);
      expect(view.officialSolution).toContain(solutionSentinel);
      expect(() => {
        (view.solver.payload as { narrative: string }).narrative = "mutated";
      }).toThrow();
      return {
        solverCorrect: true,
        officialSolutionCorrect: true,
        approachRelation: "equivalent" as const,
        keyInsights: ["直接处理"],
        issues: [],
        rationale: "一致。"
      };
    });
    const observed = runReviewEvidenceFlow({
      source: source(),
      identities: identities(),
      roles: defaultRoles({
        solver: async () => {
          solverStarted.resolve();
          await releaseSolver.promise;
          return {
            solved: true,
            narrative: "冻结的解题过程",
            approach: "直接处理",
            claimedComplexity: "O(1)",
            uncertainties: []
          };
        },
        solutionAnalyst: analyst
      })
    });
    await solverStarted.promise;
    await Promise.resolve();
    expect(analyst).not.toHaveBeenCalled();
    releaseSolver.resolve();
    await observed;
    expect(analyst).toHaveBeenCalledOnce();
  });

  it("独立角色整批收束后才启动 critic/adversary，二者收束后才裁决", async () => {
    const releases = Object.fromEntries(
      ["difficulty", "editorial", "contest-fit", "originality", "tags", "critic", "adversary"].map(
        (role) => [role, deferred()]
      )
    ) as Record<string, ReturnType<typeof deferred>>;
    const events: string[] = [];
    const wrap = <T>(role: string, payload: T) => async (): Promise<T> => {
      events.push(`start-${role}`);
      await releases[role]!.promise;
      events.push(`finish-${role}`);
      return payload;
    };
    const roles = defaultRoles({
      difficulty: wrap("difficulty", {
        codeforcesDifficulty: 800,
        thinkingLevel: 1,
        codingLevel: 1,
        confidence: 0.9,
        rationale: "基础。"
      }),
      editorialJudge: wrap("editorial", {
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
          summary: "有明确思维价值。"
        }],
        rationale: "命题价值良好。"
      }),
      contestFit: wrap("contest-fit", {
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
          summary: "适合比赛。"
        }],
        rationale: "ICPC 适配良好。"
      }),
      originality: wrap("originality", {
        originalityLevel: 4,
        sameProblemAsExisting: false,
        highestSimilarity: 0.2,
        evidenceIds: ["duplicate-1"],
        rationale: "未重复。"
      }),
      tags: wrap("tags", {
        tagIds: ["basic.simulation"],
        rationale: "固定目录标签。"
      }),
      critic: async (view) => {
        events.push("start-critic");
        expect(view.evidence).toHaveLength(8);
        expect(new Set(view.evidence.map((artifact) => artifact.evidenceId)).size).toBe(8);
        expect(view.evidence.map((artifact) => artifact.role).sort()).toEqual([
          "contest_fit",
          "difficulty",
          "editorial_judge",
          "originality",
          "solution_analyst",
          "solver",
          "tags",
          "technical_auditor"
        ]);
        await releases.critic!.promise;
        events.push("finish-critic");
        return { conflicts: [], missingRoles: [], rationale: "无冲突。" };
      },
      adversary: async () => {
        events.push("start-adversary");
        await releases.adversary!.promise;
        events.push("finish-adversary");
        return { counterexamples: [], rationale: "无反例。" };
      },
      adjudicator: async (view) => {
        events.push("start-adjudicator");
        return {
          verdict: "approve",
          qualityLevel: 4,
          fixability: "none",
          strengths: ["合成优点"],
          improvements: "通过。",
          citedEvidenceIds: [view.evidence[0]!.evidenceId]
        };
      }
    });
    const observed = runReviewEvidenceFlow({ source: source(), identities: identities(), roles });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events.filter((event) => event.startsWith("start-"))).toEqual(
      expect.arrayContaining([
        "start-difficulty",
        "start-editorial",
        "start-contest-fit",
        "start-originality",
        "start-tags"
      ])
    );
    expect(events).not.toContain("start-critic");
    for (const role of ["difficulty", "editorial", "contest-fit", "originality", "tags"]) {
      releases[role]!.resolve();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toContain("start-critic");
    expect(events).toContain("start-adversary");
    expect(events).not.toContain("start-adjudicator");
    releases.critic!.resolve();
    releases.adversary!.resolve();
    await observed;
    expect(events.at(-1)).toBe("start-adjudicator");
  });

  it("任一独立角色失败仍等待所有在途角色收束，且不启动后续角色", async () => {
    const allStarted = deferred();
    const releaseOthers = deferred();
    let starts = 0;
    const started = (): void => {
      starts += 1;
      if (starts === 5) allStarted.resolve();
    };
    const critic = vi.fn(defaultRoles().critic);
    const adjudicator = vi.fn(defaultRoles().adjudicator);
    const observed = runReviewEvidenceFlow({
      source: source(),
      identities: identities(),
      roles: defaultRoles({
        difficulty: async () => {
          started();
          await releaseOthers.promise;
          return {
            codeforcesDifficulty: 800,
            thinkingLevel: 1,
            codingLevel: 1,
            confidence: 0.9,
            rationale: "基础。"
          };
        },
        editorialJudge: async () => {
          started();
          throw new Error("synthetic-role-failure");
        },
        contestFit: async () => {
          started();
          await releaseOthers.promise;
          return {
            icpcFit: "acceptable",
            implementationBurden: 2,
            thinkingImplementationBalance: "acceptable",
            knowledgeFairness: "fair",
            problemsetRole: "standard",
            roleConfidence: 0.7,
            evidenceCoverage: { strengths: "found", concerns: "none_found" },
            evidence: [{
              dimension: "icpc_fit",
              direction: "strength",
              severity: "note",
              confidence: 0.7,
              summary: "可用于合成比赛。"
            }],
            rationale: "适配。"
          };
        },
        originality: async () => {
          started();
          await releaseOthers.promise;
          return {
            originalityLevel: 4,
            sameProblemAsExisting: false,
            highestSimilarity: 0.2,
            evidenceIds: ["duplicate-1"],
            rationale: "未重复。"
          };
        },
        tags: async () => {
          started();
          await releaseOthers.promise;
          return { tagIds: ["basic.simulation"], rationale: "固定标签。" };
        },
        critic,
        adjudicator
      })
    });
    const rejection = expect(observed).rejects.toMatchObject({
      code: "REVIEW_FLOW_ROLE_FAILED",
      role: "editorial_judge"
    });
    await allStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(critic).not.toHaveBeenCalled();
    expect(adjudicator).not.toHaveBeenCalled();
    releaseOthers.resolve();
    await rejection;
    expect(critic).not.toHaveBeenCalled();
    expect(adjudicator).not.toHaveBeenCalled();
  });

  it("未知或停用标签固定失败，不能让模型自由造标签编号", async () => {
    await expect(runReviewEvidenceFlow({
      source: source(),
      identities: identities(),
      roles: defaultRoles({
        tags: async () => ({ tagIds: ["invented.tag"], rationale: "错误标签。" })
      })
    })).rejects.toMatchObject({
      code: "REVIEW_FLOW_TAG_SELECTION_INVALID",
      role: "tags"
    });
  });

  it("没有或未执行可选标程不拦截通过，题解问题只阻止直接 approve", async () => {
    const notExecuted = await runReviewEvidenceFlow({
      source: source(),
      identities: identities(),
      roles: defaultRoles({
        technicalAuditor: async () => ({
          statementSolutionConsistency: "verified",
          judgeability: "verified",
          sampleConsistency: "verified",
          constraintSufficiency: "verified",
          referenceImplementation: {
            provided: true,
            status: "not_executed",
            executionMode: "not_executed",
            compileStatus: "not_run",
            sampleCount: 1,
            samplePassed: null,
            algorithmEquivalent: null,
            complexityAcceptable: null
          },
          concerns: [],
          rationale: "没有隔离执行环境，不能声称通过。"
        })
      })
    });
    expect(submission(notExecuted).verdict).toBe("approve");
    expect(notExecuted.hardBlockers).toEqual([]);

    const noReferenceImplementation = await runReviewEvidenceFlow({
      source: source({ referenceImplementation: null }),
      identities: identities(),
      roles: defaultRoles({
        technicalAuditor: async () => ({
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
          rationale: "没有另附标程，按题面和题解继续审核。"
        })
      })
    });
    expect(submission(noReferenceImplementation).verdict).toBe("approve");
    expect(noReferenceImplementation.hardBlockers).toEqual([]);

    const incorrectSolution = await runReviewEvidenceFlow({
      source: source(),
      identities: identities(),
      roles: defaultRoles({
        solutionAnalyst: async () => ({
          solverCorrect: true,
          officialSolutionCorrect: false,
          approachRelation: "contradictory",
          keyInsights: [],
          issues: ["合成矛盾"],
          rationale: "题解存在合成错误。"
        }),
        technicalAuditor: async () => ({
          statementSolutionConsistency: "concern",
          judgeability: "verified",
          sampleConsistency: "verified",
          constraintSufficiency: "verified",
          referenceImplementation: {
            provided: true,
            status: "verified",
            executionMode: "sandbox",
            compileStatus: "passed",
            sampleCount: 1,
            samplePassed: 1,
            algorithmEquivalent: true,
            complexityAcceptable: true
          },
          concerns: ["独立核验也发现合成矛盾"],
          rationale: "两个技术角色相互印证。"
        })
      })
    });
    expect(submission(incorrectSolution).verdict).toBe("request_changes");
    expect(incorrectSolution.hardBlockers).toContain("SOLUTION_INCORRECT");
  });

  it("最终评价合成失败归属 adjudicator，不能把十一角色全部记成完成", async () => {
    const outcome = await runReviewEvidenceFlowOutcome({
      source: source(),
      identities: identities(),
      roles: defaultRoles({
        solutionAnalyst: async () => ({
          solverCorrect: true,
          officialSolutionCorrect: false,
          approachRelation: "contradictory",
          keyInsights: [],
          issues: ["合成矛盾"],
          rationale: "题解存在合成错误。"
        }),
        technicalAuditor: async () => ({
          statementSolutionConsistency: "concern",
          judgeability: "verified",
          sampleConsistency: "verified",
          constraintSufficiency: "verified",
          referenceImplementation: {
            provided: true,
            status: "verified",
            executionMode: "sandbox",
            compileStatus: "passed",
            sampleCount: 1,
            samplePassed: 1,
            algorithmEquivalent: true,
            complexityAcceptable: true
          },
          concerns: ["独立核验确认合成矛盾"],
          rationale: "独立技术核验。"
        }),
        adjudicator: async (view) => ({
          verdict: "approve",
          qualityLevel: 4,
          fixability: "none",
          strengths: [],
          improvements: "x".repeat(20_000),
          publicComment: "",
          privateNote: "",
          citedEvidenceIds: [view.evidence[0]!.evidenceId]
        })
      })
    });
    expect(outcome.status).toBe("incomplete");
    if (outcome.status !== "incomplete") throw new Error("expected incomplete");
    expect(outcome.failure.code).toBe("REVIEW_FLOW_SUBMISSION_INVALID");
    expect(outcome.failure.failedRoles).toEqual([expect.objectContaining({
      role: "adjudicator",
      failureKind: "validation",
      requestCount: 0,
      transportAttemptCount: 0
    })]);
    expect(outcome.failure.completedRoles).toHaveLength(10);
    expect(outcome.failure.completedRoles.map((entry) => entry.role)).not.toContain("adjudicator");
  });

  it("外部技术角色只看到标程存在性摘要，不能读取标程源码", async () => {
    let observedReference: unknown;
    const decision = await runReviewEvidenceFlow({
      source: source(),
      identities: identities(),
      roles: defaultRoles({
        technicalAuditor: async (view) => {
          observedReference = view.referenceImplementation;
          expect(view.referenceImplementation).toEqual({
            provided: true,
            language: "cpp",
            sourceLength: "int main(){}".length
          });
          expect("source" in view.referenceImplementation).toBe(false);
          return defaultRoles().technicalAuditor(view);
        }
      })
    });
    expect(observedReference).toBeDefined();
    expect(submission(decision).verdict).toBe("approve");
  });

  it("未执行标程不能自报 invalid，样例计数也必须绑定公开样例", async () => {
    await expect(runReviewEvidenceFlow({
      source: source(),
      identities: identities(),
      roles: defaultRoles({
        technicalAuditor: async () => ({
          statementSolutionConsistency: "verified",
          judgeability: "verified",
          sampleConsistency: "verified",
          constraintSufficiency: "verified",
          referenceImplementation: {
            provided: true,
            status: "invalid",
            executionMode: "not_executed",
            compileStatus: "not_run",
            sampleCount: 1,
            samplePassed: null,
            algorithmEquivalent: null,
            complexityAcceptable: null
          },
          concerns: [],
          rationale: "合成的越权状态。"
        })
      })
    })).rejects.toMatchObject({
      code: "REVIEW_FLOW_ROLE_FAILED",
      role: "technical_auditor"
    });

    await expect(runReviewEvidenceFlow({
      source: source(),
      identities: identities(),
      roles: defaultRoles({
        technicalAuditor: async () => ({
          statementSolutionConsistency: "verified",
          judgeability: "verified",
          sampleConsistency: "verified",
          constraintSufficiency: "verified",
          referenceImplementation: {
            provided: true,
            status: "not_executed",
            executionMode: "not_executed",
            compileStatus: "not_run",
            sampleCount: 0,
            samplePassed: null,
            algorithmEquivalent: null,
            complexityAcceptable: null
          },
          concerns: [],
          rationale: "合成的错误样例计数。"
        })
      })
    })).rejects.toMatchObject({
      code: "REVIEW_FLOW_REFERENCE_STATE_INVALID",
      role: "technical_auditor"
    });
  });

  it("模型不能重新引入已移除的硬阻塞字段，双向证据声明必须自洽", async () => {
    await expect(runReviewEvidenceFlow({
      source: source(),
      identities: identities(),
      roles: defaultRoles({
        technicalAuditor: async () => ({
          ...(await defaultRoles().technicalAuditor({} as never) as Record<string, unknown>),
          blockers: ["SOLUTION_INCORRECT"]
        })
      })
    })).rejects.toMatchObject({
      code: "REVIEW_FLOW_ROLE_FAILED",
      role: "technical_auditor"
    });

    await expect(runReviewEvidenceFlow({
      source: source(),
      identities: identities(),
      roles: defaultRoles({
        editorialJudge: async () => ({
          qualityLevel: 4,
          noveltyLevel: 4,
          ideaDepthLevel: 4,
          naturalnessLevel: 4,
          contestantExperienceLevel: 4,
          evidenceCoverage: { strengths: "found", concerns: "found" },
          evidence: [{
            dimension: "idea_depth",
            direction: "strength",
            severity: "note",
            confidence: 0.8,
            summary: "只有合成正向证据。"
          }],
          rationale: "负向覆盖声明没有对应证据。"
        })
      })
    })).rejects.toMatchObject({
      code: "REVIEW_FLOW_ROLE_FAILED",
      role: "editorial_judge"
    });
  });

  it("技术核验无错也不能替代命题品味与 ICPC 适配裁决", async () => {
    const decision = await runReviewEvidenceFlow({
      source: source(),
      identities: identities(),
      roles: defaultRoles({
        editorialJudge: async () => ({
          qualityLevel: 1,
          noveltyLevel: 1,
          ideaDepthLevel: 1,
          naturalnessLevel: 2,
          contestantExperienceLevel: 1,
          evidenceCoverage: { strengths: "none_found", concerns: "found" },
          evidence: [{
            dimension: "idea_depth",
            direction: "concern",
            severity: "fundamental",
            confidence: 0.9,
            summary: "合成的根本性命题品味问题。"
          }],
          rationale: "核心价值不足。"
        }),
        contestFit: async () => ({
          icpcFit: "unsuitable",
          implementationBurden: 5,
          thinkingImplementationBalance: "weak",
          knowledgeFairness: "questionable",
          problemsetRole: "unclear",
          roleConfidence: 0.8,
          evidenceCoverage: { strengths: "none_found", concerns: "found" },
          evidence: [{
            dimension: "implementation_balance",
            direction: "concern",
            severity: "fundamental",
            confidence: 0.8,
            summary: "合成的思维收益与实现负担失衡。"
          }],
          rationale: "不适合合成 ICPC 场景。"
        }),
        adjudicator: async (view) => ({
          verdict: "reject",
          qualityLevel: 1,
          fixability: "fundamental",
          strengths: [],
          improvements: "需要重构核心命题价值。",
          citedEvidenceIds: view.evidence
            .filter((artifact) => ["editorial_judge", "contest_fit"].includes(artifact.role))
            .map((artifact) => artifact.evidenceId)
        })
      })
    });
    expect(decision.hardBlockers).toEqual([]);
    expect(submission(decision).verdict).toBe("reject");
    expect(submission(decision).qualityLevel).toBe(1);
    expect(artifacts(decision).editorial.payload.evidence[0]!.dimension).toBe("idea_depth");
    expect(artifacts(decision).contestFit.payload.icpcFit).toBe("unsuitable");
  });

  it("只有确认同题能越过裁决者的 approve 直接拒绝", async () => {
    const decision = await runReviewEvidenceFlow({
      source: source({
        duplicateEvidence: [{
          evidenceId: "duplicate-1",
          source: "synthetic",
          externalId: "public-1",
          similarity: 0.99,
          sameProblemSuggestion: true,
          summary: "合成的同题证据。"
        }]
      }),
      identities: identities(),
      roles: defaultRoles({
        originality: async () => ({
          originalityLevel: 1,
          sameProblemAsExisting: true,
          highestSimilarity: 0.99,
          evidenceIds: ["duplicate-1"],
          rationale: "合成证据确认同题。"
        })
      })
    });
    expect(submission(decision).verdict).toBe("reject");
    expect(decision.hardBlockers).toContain("CONFIRMED_DUPLICATE");
  });

  it("查重必须同时绑定真实证据与阈值，不能由模型自报相似度强制否决", async () => {
    await expect(runReviewEvidenceFlow({
      source: source(),
      identities: identities(),
      roles: defaultRoles({
        originality: async () => ({
          originalityLevel: 1,
          sameProblemAsExisting: true,
          highestSimilarity: 0.99,
          evidenceIds: ["duplicate-1"],
          rationale: "与输入证据不一致的合成自报。"
        })
      })
    })).rejects.toMatchObject({
      code: "REVIEW_FLOW_EVIDENCE_REFERENCE_INVALID",
      role: "originality"
    });

    const belowThreshold = await runReviewEvidenceFlow({
      source: source({
        duplicateEvidence: [{
          evidenceId: "duplicate-1",
          source: "synthetic",
          externalId: "public-1",
          similarity: 0.8,
          sameProblemSuggestion: true,
          summary: "低于确定性阈值的合成证据。"
        }]
      }),
      identities: identities(),
      roles: defaultRoles({
        originality: async () => ({
          originalityLevel: 2,
          sameProblemAsExisting: true,
          highestSimilarity: 0.8,
          evidenceIds: ["duplicate-1"],
          rationale: "模型认为相似，但确定性规则阈值未达到。"
        })
      })
    });
    expect(submission(belowThreshold).verdict).toBe("approve");
    expect(belowThreshold.hardBlockers).not.toContain("CONFIRMED_DUPLICATE");
  });

  it("不能把不同查重记录的最高相似度与同题建议拼接成确认重复", async () => {
    const decision = await runReviewEvidenceFlow({
      source: source({
        duplicateEvidence: [
          {
            evidenceId: "high-similarity",
            source: "synthetic",
            externalId: "public-high",
            similarity: 0.99,
            sameProblemSuggestion: false,
            summary: "高相似但不确认同题的合成证据。"
          },
          {
            evidenceId: "low-same-suggestion",
            source: "synthetic",
            externalId: "public-low",
            similarity: 0.2,
            sameProblemSuggestion: true,
            summary: "低相似但带同题建议的合成证据。"
          }
        ]
      }),
      identities: identities(),
      roles: defaultRoles({
        originality: async () => ({
          originalityLevel: 2,
          sameProblemAsExisting: true,
          highestSimilarity: 0.99,
          evidenceIds: ["high-similarity", "low-same-suggestion"],
          rationale: "两条证据必须分别核对。"
        })
      })
    });
    expect(submission(decision).verdict).toBe("approve");
    expect(decision.hardBlockers).not.toContain("CONFIRMED_DUPLICATE");
  });

  it("批评者的 blocker 严重度和反方 fatal 反例都只是证据，不能越权否决", async () => {
    const decision = await runReviewEvidenceFlow({
      source: source(),
      identities: identities(),
      roles: defaultRoles({
        critic: async (view) => ({
          conflicts: [{
            leftEvidenceId: view.evidence[0]!.evidenceId,
            rightEvidenceId: view.evidence[1]!.evidenceId,
            code: "SYNTHETIC_CONFLICT",
            severity: "blocker",
            rationale: "合成批评意见仍须由裁决者判断。"
          }],
          missingRoles: [],
          rationale: "发现合成冲突。"
        }),
        adversary: async (view) => ({
          counterexamples: [{
            targetEvidenceId: view.evidence[0]!.evidenceId,
            scenario: "合成最坏情况。",
            impact: "fatal"
          }],
          rationale: "反例严重度不是确定性硬阻塞。"
        })
      })
    });
    expect(submission(decision).verdict).toBe("approve");
    expect(decision.hardBlockers).toEqual([]);
  });

  it("总输入超过安全上限时在任何角色启动前失败，且绝不静默截断", async () => {
    const solver = vi.fn(defaultRoles().solver);
    await expect(runReviewEvidenceFlow({
      source: source({
        statement: "甲".repeat(2_000_000),
        solution: "乙".repeat(2_000_000),
        constraints: "丙".repeat(2_000_000),
        samples: Array.from({ length: 5 }, (_, index) => ({
          safeId: `oversize-${index}`,
          input: "1\n",
          output: "1\n",
          explanation: "丁".repeat(500_000)
        }))
      }),
      identities: identities(),
      roles: defaultRoles({ solver })
    })).rejects.toMatchObject({ code: "REVIEW_FLOW_SOURCE_INVALID" });
    expect(solver).not.toHaveBeenCalled();
  });

  it("artifact 的 inputHash 绑定标签目录和查重证据，而不只绑定题面哈希", async () => {
    const first = await runReviewEvidenceFlow({
      source: source(),
      identities: identities(),
      roles: defaultRoles()
    });
    const changedCatalog = await runReviewEvidenceFlow({
      source: source({ tagCatalogVersion: 8 }),
      identities: identities(),
      roles: defaultRoles()
    });
    const changedDuplicateEvidence = await runReviewEvidenceFlow({
      source: source({
        duplicateEvidence: [{
          evidenceId: "duplicate-1",
          source: "synthetic",
          externalId: "public-1",
          similarity: 0.2,
          sameProblemSuggestion: false,
          summary: "不同的合成查重摘要"
        }]
      }),
      identities: identities(),
      roles: defaultRoles()
    });
    expect(artifacts(changedCatalog).tags.evidenceId).not.toBe(artifacts(first).tags.evidenceId);
    expect(artifacts(changedDuplicateEvidence).originality.evidenceId).not.toBe(
      artifacts(first).originality.evidenceId
    );
  });

  it("artifact 绑定 payload/hash/角色/题目身份，篡改后拒绝", () => {
    const artifact = sealEvidenceArtifact({
      role: "solver",
      problemContentHash: "b".repeat(64),
      inputHash: "c".repeat(64),
      sourceSnapshotHash: "e".repeat(64),
      execution: {
        trust: "untrusted_local",
        runContextHash: null,
        completionReceipt: null
      },
      identity: { promptVersion: "solver-v1", modelIdentity },
      payloadSchema: solverPayloadSchema,
      payload: {
        solved: true,
        narrative: "合成过程",
        approach: "合成思路",
        claimedComplexity: "O(1)",
        uncertainties: []
      }
    });
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.payload)).toBe(true);
    expect(assertEvidenceArtifact({ artifact, payloadSchema: solverPayloadSchema })).toEqual(artifact);
    expect(() => assertEvidenceArtifact({
      artifact: {
        ...artifact,
        payload: { ...artifact.payload, narrative: "tampered" }
      },
      payloadSchema: solverPayloadSchema
    })).toThrow("REVIEW_FLOW_EVIDENCE_IDENTITY_INVALID");
    expect(() => assertEvidenceArtifact({
      artifact: { ...artifact, inputHash: "d".repeat(64) },
      payloadSchema: solverPayloadSchema
    })).toThrow("REVIEW_FLOW_EVIDENCE_IDENTITY_INVALID");
  });
});
