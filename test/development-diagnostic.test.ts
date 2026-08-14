import { describe, expect, it, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { delimiter, dirname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  developmentDiagnosticProfile,
  developmentDiagnosticProfileFingerprint,
  developmentDiagnosticAggregateBudgetReceipt,
  parseDevelopmentDiagnosticProfile,
  parseDevelopmentDiagnosticManifest,
  DevelopmentDiagnosticRunController,
  TransportPreDispatchGate,
  createDevelopmentDiagnosticScheduler,
  expectedDiagnosticSlots,
  type DevelopmentDiagnosticLifecycleEvent,
  type DevelopmentDiagnosticManifest
} from "../src/review-flow/development-diagnostic";
import {
  developmentSmokeProfile,
  developmentSmokeProfileFingerprint
} from "../src/review-flow/development-smoke";
import { FairLlmRequestScheduler } from "../src/llm-scheduler";
import {
  chatCompleteWithReceipt,
  LlmRequestError,
  LlmRequestStartGate,
  type LlmRuntimeOptions
} from "../src/llm";
import { hashCanonicalValue } from "../src/review-flow/evidence";
import { reviewFlowRoleSchema } from "../src/review-flow/schemas";
import {
  reviewFlowCalibrationOutcomeSchema,
  reviewFlowRoleCompletionSummarySchema,
  type ReviewFlowCalibrationOutcome
} from "../src/review-flow/orchestrator";
import {
  preflightDevelopmentDiagnostic,
  runDevelopmentDiagnosticPhase,
  type DevelopmentDiagnosticPreflight
} from "../experiments/lib/development-smoke-launcher";
import {
  developmentDiagnosticPreflightConfigurationFingerprint,
  runDevelopmentDiagnosticCli,
  type DevelopmentDiagnosticCliRuntime
} from "../experiments/run-development-diagnostic";
import {
  developmentDiagnosticRunLockPath,
  developmentDiagnosticRunStatePath
} from "../experiments/lib/development-diagnostic-run-state";
import {
  legacyDevelopmentDiagnosticPlannedRunContract,
  type DevelopmentDiagnosticPlannedRunContract
} from "../src/review-flow/development-diagnostic-run-contract";

/* ═══════════════════════════════════════════════════════════════
 * Helpers
 * ═══════════════════════════════════════════════════════════════ */

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
}

function writePrivateJson(path: string, value: unknown): void {
  writePrivateFile(path, JSON.stringify(value));
}

const syntheticProvider = Object.freeze({
  baseUrl: "https://test.example.com/v1/chat/completions",
  apiKey: "synthetic-key"
});

const syntheticSpec = Object.freeze({
  provider: "aether" as const,
  model: "deepseek-v4-pro",
  temperature: 0.1,
  thinking: true,
  thinkingRequest: "enabled" as const,
  reasoningEffort: "max" as const
});

const syntheticMessages = [
  { role: "user" as const, content: "synthetic" }
];

function successfulSseResponse(): Response {
  const body = [
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    "data: [DONE]",
    ""
  ].join("\n\n");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}
type SyntheticTerminalPath =
  | "rate_limited"
  | "server_error"
  | "connect"
  | "first_byte_timeout"
  | "no_progress_timeout"
  | "stream_interrupted"
  | "output_limit"
  | "schema_invalid"
  | "permanent";

function syntheticSseResponse(events: readonly string[]): Response {
  return new Response([...events, ""].join("\n\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function syntheticTerminalFetch(
  path: SyntheticTerminalPath,
  onStart: () => void
): NonNullable<LlmRuntimeOptions["fetch"]> {
  return async () => {
    onStart();
    switch (path) {
      case "rate_limited":
        return new Response(null, { status: 429 });
      case "server_error":
        return new Response(null, { status: 500 });
      case "connect":
        throw new Error("SYNTHETIC_CONNECT_FAILURE");
      case "first_byte_timeout":
        return new Promise<Response>(() => undefined);
      case "no_progress_timeout":
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"{"},"finish_reason":null}]}\n\n'
            ));
          }
        }), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      case "stream_interrupted":
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("SYNTHETIC_STREAM_INTERRUPTED"));
          }
        }), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      case "output_limit":
        return syntheticSseResponse([
          'data: {"choices":[{"delta":{},"finish_reason":"length"}]}'
        ]);
      case "schema_invalid":
        return syntheticSseResponse([
          'data: {"choices":[{"delta":{"content":"{}"},"finish_reason":null}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          "data: [DONE]"
        ]);
      case "permanent":
        return syntheticSseResponse([
          'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}'
        ]);
    }
  };
}

function diagnosticTransportRuntime(
  controller: DevelopmentDiagnosticRunController,
  fetchImpl: NonNullable<LlmRuntimeOptions["fetch"]>,
  observers: {
    readonly maxAttempts?: number;
    readonly onDispatch?: () => void;
    readonly onTransportHook?: () => void;
    readonly onTransportDenied?: () => void;
  } = {}
): LlmRuntimeOptions {
  return {
    outputIdleTimeoutMs: 60_000,
    firstOutputTimeoutMs: 60_000,
    maximumDurationMs: 120_000,
    maxAttempts: observers.maxAttempts ?? 1,
    baseDelayMs: 0,
    fetch: fetchImpl,
    onTransportDispatch: () => {
      observers.onTransportHook?.();
      try {
        controller.reserveTransportOrThrow();
      } catch (error) {
        observers.onTransportDenied?.();
        throw error;
      }
    },
    dispatchTransport: (execute) => {
      observers.onDispatch?.();
      return controller.dispatchTransport(execute);
    }
  };
}

function completeCalibrationOutcome(): ReviewFlowCalibrationOutcome {
  const responses = [{
    responseMode: "sse" as const,
    transportAttemptCount: 1,
    eofVerified: true as const,
    finishReasonStopVerified: true as const,
    acceptedEventShapes: [{
      category: "content" as const,
      shapeFingerprint: digest("accepted-content-shape"),
      count: 1
    }],
    sseDoneObserved: true as const
  }];
  const receiptHash = hashCanonicalValue({
    schemaVersion: 2,
    requestCount: 1,
    transportAttemptCount: 1,
    eofVerified: true,
    jsonSchemaValidated: true,
    responses: responses.map((response) => ({
      schemaVersion: 2,
      transportAttemptCount: response.transportAttemptCount,
      eofVerified: response.eofVerified,
      responseMode: response.responseMode,
      finishReasonStopVerified: response.finishReasonStopVerified,
      acceptedEventShapes: response.acceptedEventShapes,
      sseDoneObserved: response.sseDoneObserved
    }))
  });
  const roleReceipts = reviewFlowRoleSchema.options.map((role) => ({
    role,
    receiptHash,
    requestCount: 1 as const,
    transportAttemptCount: 1,
    responses
  }));
  return {
    status: "complete",
    projection: {
      schemaVersion: 2,
      verdict: "approve",
      codeforcesDifficulty: 1200,
      qualityLevel: 4,
      originalityLevel: 4,
      thinkingLevel: 3,
      codingLevel: 2,
      tagIds: ["tag-01"],
      hardBlockers: [],
      difficultyConfidence: 0.8,
      technical: {
        officialSolutionCorrect: true,
        statementSolutionConsistency: "verified",
        judgeability: "verified",
        sampleConsistency: "verified",
        constraintSufficiency: "verified",
        referenceImplementation: {
          provided: false,
          status: "unavailable",
          complexityAcceptable: null
        }
      },
      editorial: {
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
          confidence: 0.8
        }]
      },
      contestFit: {
        icpcFit: "strong",
        implementationBurden: 2,
        thinkingImplementationBalance: "strong",
        knowledgeFairness: "fair",
        problemsetRole: "introductory",
        roleConfidence: 0.8,
        evidenceCoverage: { strengths: "found", concerns: "none_found" },
        evidence: [{
          dimension: "idea_depth",
          direction: "strength",
          severity: "note",
          confidence: 0.8
        }]
      },
      originality: {
        originalityLevel: 4,
        sameProblemAsExisting: false,
        highestSimilarity: 0.1
      },
      roleReceipts,
      receiptSetHash: hashCanonicalValue(roleReceipts)
    }
  };
}
type ObservedRoleRequest = {
  readonly role: string;
  readonly prompt: string;
  readonly targetSchema: unknown | null;
  readonly responseFormatPresent: boolean;
  readonly model: unknown;
  readonly maxTokens: unknown;
  readonly thinkingRequest: unknown;
  readonly reasoningEffort: unknown;
};

function targetSchemaFromPrompt(prompt: string): unknown | null {
  const marker = "完整 JSON Schema：\n";
  const markerIndex = prompt.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  return JSON.parse(prompt.slice(markerIndex + marker.length));
}

function requestRole(init?: RequestInit): string | null {
  if (typeof init?.body !== "string") return null;
  const request = JSON.parse(init.body) as {
    readonly messages?: readonly { readonly content?: unknown }[];
  };
  const prompt = (request.messages ?? [])
    .flatMap((message) => typeof message.content === "string" ? [message.content] : [])
    .join("\n");
  const targetSchema = targetSchemaFromPrompt(prompt);
  if (targetSchema !== null) {
    const serializedSchema = JSON.stringify(targetSchema);
    for (const [field, role] of [
      ['"solverCorrect"', "solution_analyst"],
      ['"statementSolutionConsistency"', "technical_auditor"],
      ['"codeforcesDifficulty"', "difficulty"],
      ['"noveltyLevel"', "editorial_judge"],
      ['"icpcFit"', "contest_fit"],
      ['"sameProblemAsExisting"', "originality"],
      ['"tagIds"', "tags"],
      ['"conflicts"', "critic"],
      ['"counterexamples"', "adversary"],
      ['"citedEvidenceIds"', "adjudicator"],
      ['"solved"', "solver"]
    ] as const) {
      if (serializedSchema.includes(field)) return role;
    }
  }
  for (const [rolePrompt, role] of [
    ["题解分析者", "solution_analyst"],
    ["技术核验员", "technical_auditor"],
    ["独立难度评估者", "difficulty"],
    ["资深算法竞赛命题审稿人", "editorial_judge"],
    ["ICPC 风格比赛的题组审稿人", "contest_fit"],
    ["原创性证据分析者", "originality"],
    ["知识点标签整理员", "tags"],
    ["证据批评者", "critic"],
    ["独立反方审稿人", "adversary"],
    ["最终审题裁决者", "adjudicator"],
    ["正在参加算法竞赛的独立选手", "solver"]
  ] as const) {
    if (prompt.includes(rolePrompt)) return role;
  }
  return null;
}

function syntheticRolePayload(
  role: string,
  requestBody: string,
  invalidAdjudicatorEvidence = false
): unknown {
  const request = JSON.parse(requestBody) as {
    readonly messages: readonly { readonly content: string }[];
  };
  const collectEvidenceIds = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(collectEvidenceIds);
    if (typeof value !== "object" || value === null) return [];
    return Object.entries(value).flatMap(([key, entry]) =>
      key === "evidenceId" && typeof entry === "string"
        ? [entry]
        : collectEvidenceIds(entry)
    );
  };
  const evidenceIds = request.messages.flatMap((message) => {
    try {
      return collectEvidenceIds(JSON.parse(message.content));
    } catch {
      return [];
    }
  });
  switch (role) {
    case "solver":
      return { solved: true, narrative: "Synthetic complete solution.", approach: "Invariant.", claimedComplexity: "O(n)", uncertainties: [] };
    case "solution_analyst":
      return { solverCorrect: true, officialSolutionCorrect: true, approachRelation: "compatible", keyInsights: ["Invariant."], issues: [], rationale: "Internally consistent." };
    case "technical_auditor":
      return {
        statementSolutionConsistency: "verified",
        judgeability: "verified",
        sampleConsistency: "verified",
        constraintSufficiency: "verified",
        concerns: [],
        rationale: "Synthetic checks pass."
      };
    case "difficulty":
      return { codeforcesDifficulty: 1800, thinkingLevel: 5, codingLevel: 5, confidence: 0.9, rationale: "Synthetic middle band." };
    case "editorial_judge":
      return {
        qualityLevel: 5,
        noveltyLevel: 5,
        ideaDepthLevel: 5,
        naturalnessLevel: 5,
        contestantExperienceLevel: 5,
        evidenceCoverage: { strengths: "found", concerns: "none_found" },
        evidence: [{ dimension: "idea_depth", direction: "strength", severity: "note", confidence: 0.9, summary: "Synthetic strength." }],
        rationale: "Synthetic editorial assessment."
      };
    case "contest_fit":
      return {
        icpcFit: "strong",
        implementationBurden: 5,
        thinkingImplementationBalance: "strong",
        knowledgeFairness: "fair",
        problemsetRole: "standard",
        roleConfidence: 0.9,
        evidenceCoverage: { strengths: "found", concerns: "none_found" },
        evidence: [{ dimension: "icpc_fit", direction: "strength", severity: "note", confidence: 0.9, summary: "Synthetic fit." }],
        rationale: "Synthetic contest fit."
      };
    case "originality":
      return { originalityLevel: 5, sameProblemAsExisting: false, highestSimilarity: 0, evidenceIds: [], rationale: "No duplicate evidence." };
    case "tags":
      return { tagIds: ["tag-01"], rationale: "Allowed synthetic tag." };
    case "critic":
      return { conflicts: [], missingRoles: [], rationale: "Evidence is consistent." };
    case "adversary":
      return { counterexamples: [], rationale: "No blocker." };
    case "adjudicator":
      return {
        verdict: "approve",
        qualityLevel: 5,
        fixability: "none",
        strengths: ["Synthetic evidence is consistent."],
        improvements: "No required changes.",
        publicComment: "Synthetic complete review.",
        privateNote: "Synthetic private note.",
        citedEvidenceIds: invalidAdjudicatorEvidence
          ? [`ev-${digest("wrong-evidence").slice(0, 32)}`]
          : evidenceIds
      };
    default:
      throw new Error(`UNEXPECTED_ROLE_${role}`);
  }
}

function completeElevenRoleFetch(invalidAdjudicatorEvidence = false): {
  readonly fetch: NonNullable<LlmRuntimeOptions["fetch"]>;
  readonly counts: ReadonlyMap<string, number>;
  readonly requests: readonly ObservedRoleRequest[];
  readonly total: () => number;
  readonly peak: () => number;
} {
  const counts = new Map<string, number>();
  const requests: ObservedRoleRequest[] = [];
  let total = 0;
  let active = 0;
  let peak = 0;
  const fetchImpl: NonNullable<LlmRuntimeOptions["fetch"]> = async (_input, init) => {
    if (typeof init?.body !== "string") throw new Error("MISSING_REQUEST_BODY");
    const role = requestRole(init);
    if (role === null) throw new Error("MISSING_ROLE_MARKER");
    const request = JSON.parse(init.body) as {
      readonly messages?: readonly { readonly content?: unknown }[];
      readonly response_format?: unknown;
      readonly model?: unknown;
      readonly max_tokens?: unknown;
      readonly thinking?: unknown;
      readonly reasoning_effort?: unknown;
    };
    const prompt = (request.messages ?? [])
      .flatMap((message) => typeof message.content === "string" ? [message.content] : [])
      .join("\n");
    requests.push({
      role,
      prompt,
      targetSchema: targetSchemaFromPrompt(prompt),
      responseFormatPresent: "response_format" in request,
      model: request.model,
      maxTokens: request.max_tokens,
      thinkingRequest: request.thinking,
      reasoningEffort: request.reasoning_effort
    });
    total += 1;
    counts.set(role, (counts.get(role) ?? 0) + 1);
    const payload = syntheticRolePayload(role, init.body, invalidAdjudicatorEvidence);
    const content = role === "solver" && !prompt.includes("完整 JSON Schema")
      ? "Synthetic exploration."
      : JSON.stringify(payload);
    const bytes = new TextEncoder().encode([
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}`,
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
      ""
    ].join("\n\n"));
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        active += 1;
        peak = Math.max(peak, active);
        queueMicrotask(() => {
          controller.enqueue(bytes);
          controller.close();
          active -= 1;
        });
      }
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };
  return {
    fetch: fetchImpl,
    counts,
    requests,
    total: () => total,
    peak: () => peak
  };
}
interface RealSmokeFixture {
  readonly rootDir: string;
  readonly manifestPath: string;
  readonly repositoryRoot: string;
  readonly modelsYamlSource: string;
  readonly paidExecutionSourceContractFingerprint: string;
  readonly env: Record<string, string | undefined>;
  readonly taskCandidates: readonly {
    readonly slot: string;
    readonly taskCandidate: unknown;
    readonly duplicateSimilarityRejectThreshold: number;
  }[];
}

const fixtureRoots: string[] = [];

function createRealDevelopmentSmokeFixture(
  containingRoot = tmpdir()
): RealSmokeFixture {
  const rootDir = resolve(
    containingRoot,
    `dev-diag-${randomBytes(8).toString("hex")}`
  );
  mkdirSync(rootDir, { recursive: false, mode: 0o700 });
  const privateRoot = realpathSync(rootDir);
  chmodSync(rootDir, 0o700);
  fixtureRoots.push(rootDir);

  // Six slot configurations — slot-01/02 must differ on both axes.
  const slotConfigs = [
    { slot: "slot-01", verdict: "reject", difficulty: "high" as const, rating: 2500, failureKind: "schema_output" as const, failureClass: "schema_invalid" as const },
    { slot: "slot-02", verdict: "accepted", difficulty: "low" as const, rating: 1200, failureKind: "output_limit" as const, failureClass: "output_limit" as const },
    { slot: "slot-03", verdict: "reject", difficulty: "middle" as const, rating: 1500, failureKind: "schema_output" as const, failureClass: "schema_invalid" as const },
    { slot: "slot-04", verdict: "accepted", difficulty: "high" as const, rating: 2800, failureKind: "output_limit" as const, failureClass: "output_limit" as const },
    { slot: "slot-05", verdict: "reject", difficulty: "low" as const, rating: 1000, failureKind: "schema_output" as const, failureClass: "schema_invalid" as const },
    { slot: "slot-06", verdict: "accepted", difficulty: "middle" as const, rating: 1800, failureKind: "output_limit" as const, failureClass: "output_limit" as const }
  ];

  const bindings: Record<string, unknown>[] = [];
  const profileSlots: Record<string, unknown>[] = [];
  const taskCandidates: {
    readonly slot: string;
    readonly taskCandidate: unknown;
    readonly duplicateSimilarityRejectThreshold: number;
  }[] = [];

  for (const [index, cfg] of slotConfigs.entries()) {
    const slotDir = resolve(rootDir, cfg.slot);
    mkdirSync(slotDir, { recursive: true, mode: 0o700 });

    // ── 1. Source file (RobotReviewTask JSON, content-free) ──
    const assignmentId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const sourceTask = {
      assignmentId,
      leaseExpiresAt: "2026-12-31T23:59:59Z",
      problem: {
        id: `diag-${cfg.slot}`,
        revision: 1,
        reviewRound: 1,
        contentHash: digest(`problem-content-${cfg.slot}`),
        title: `Diagnostic ${cfg.slot}`,
        type: "traditional",
        tagIds: ["tag-01"],
        content: {
          basicStatement: `Content-free statement ${cfg.slot}.`,
          basicSolution: `Content-free solution ${cfg.slot}.`,
          background: "",
          statement: "",
          inputFormat: "",
          outputFormat: "",
          constraints: "",
          solution: "",
          hints: ""
        },
        samples: [],
        limits: { timeMs: 1000, memoryMiB: 256 }
      },
      tagCatalog: {
        version: 1,
        tags: [{
          id: "tag-01",
          name: "Tag 01",
          categoryId: "cat-01",
          categoryName: "Cat 01",
          description: "",
          aliases: [],
          active: true
        }]
      },
      reviewItems: []
    };

    const sourcePath = resolve(slotDir, "source.json");
    const sourceContent = JSON.stringify(sourceTask);
    writePrivateFile(sourcePath, sourceContent);
    const sourceFileSha = sha256Bytes(sourceContent);
    taskCandidates.push({
      slot: cfg.slot,
      taskCandidate: sourceTask,
      duplicateSimilarityRejectThreshold: 0.9
    });

    // ── 2. Frozen manifest ──
    const sourceLineageSha = digest(`lineage-${cfg.slot}`);
    const frozenCase = {
      content: { sha256: sourceFileSha },
      sourceLineageSha256: sourceLineageSha,
      extra: "ignored"
    };
    const frozenManifest = {
      partitions: {
        development: { cases: [frozenCase] }
      }
    };
    const frozenManifestPath = resolve(slotDir, "frozen-manifest.json");
    const frozenManifestContent = JSON.stringify(frozenManifest);
    writePrivateFile(frozenManifestPath, frozenManifestContent);
    const frozenManifestSha = sha256Bytes(frozenManifestContent);
    const frozenEntryBindingSha = hashCanonicalValue(frozenCase);

    // ── 3. Truth file ──
    const rowEvidenceSha = digest(`row-evidence-${cfg.slot}`);
    const truth = {
      historicalOutcome: cfg.verdict === "accepted" ? "accepted" : "rejected",
      contentSha256: sourceFileSha,
      sourceLineageSha256: sourceLineageSha,
      upstreamEvidence: { rowEvidenceSha256: rowEvidenceSha }
    };
    const truthPath = resolve(slotDir, "truth.json");
    const truthContent = JSON.stringify(truth);
    writePrivateFile(truthPath, truthContent);
    const truthFileSha = sha256Bytes(truthContent);
    const truthVerdict = cfg.verdict === "accepted" ? "pass" : "reject";
    const truthBindingSha = hashCanonicalValue({
      fileSha256: truthFileSha,
      contentSha256: truth.contentSha256,
      verdict: truthVerdict,
      sourceLineageSha256: truth.sourceLineageSha256,
      rowEvidenceSha256: truth.upstreamEvidence.rowEvidenceSha256
    });

    // ── 4. Difficulty evidence ──
    const difficultyRow = {
      rowEvidenceSha256: rowEvidenceSha,
      contestUseText: `rating ${cfg.rating}`,
      finalDecisionText: "",
      reviewComments: [],
      identityValues: []
    };
    const difficultyEvidence = { rows: [difficultyRow] };
    const evidencePath = resolve(slotDir, "difficulty-evidence.json");
    const evidenceContent = JSON.stringify(difficultyEvidence);
    writePrivateFile(evidencePath, evidenceContent);
    const evidenceFileSha = sha256Bytes(evidenceContent);
    const ratings = [cfg.rating];
    const band = cfg.difficulty;
    const evidenceBindingSha = hashCanonicalValue({
      rowEvidenceSha256: rowEvidenceSha,
      explicitCfRatings: ratings,
      band
    });

    // ── 5. Prior failure ──
    const failureEntry = {
      safeId: `${cfg.slot}-fail-001`,
      status: "failed",
      failure: { failureKind: cfg.failureKind, extra: "ignored" }
    };
    const priorFailure = { entries: [failureEntry] };
    const priorFailurePath = resolve(slotDir, "prior-failure.json");
    const priorFailureContent = JSON.stringify(priorFailure);
    writePrivateFile(priorFailurePath, priorFailureContent);
    const priorFailureFileSha = sha256Bytes(priorFailureContent);
    const entryBindingSha = hashCanonicalValue({
      safeId: failureEntry.safeId,
      status: failureEntry.status,
      failure: failureEntry.failure
    });
    const priorFailureRef = {
      absolutePath: priorFailurePath,
      fileSha256: priorFailureFileSha,
      class: cfg.failureClass,
      entryBindingSha256: entryBindingSha
    };

    // ── 6. Opaque safe ID ──
    const opaqueSafeId = hashCanonicalValue({
      domain: "development-smoke-opaque-id-v1",
      sourceFileSha256: sourceFileSha,
      truthBindingSha256: truthBindingSha,
      difficultyEvidenceBindingSha256: evidenceBindingSha
    });

    // ── 7. Build private binding ──
    const bindingBase: Record<string, unknown> = {
      slot: cfg.slot,
      opaqueSafeId,
      source: {
        absolutePath: sourcePath,
        fileSha256: sourceFileSha,
        frozenManifestAbsolutePath: frozenManifestPath,
        frozenManifestFileSha256: frozenManifestSha,
        frozenEntryBindingSha256: frozenEntryBindingSha
      },
      truth: {
        absolutePath: truthPath,
        fileSha256: truthFileSha,
        truthBindingSha256: truthBindingSha
      },
      difficulty: {
        band,
        explicitCfRatings: ratings,
        evidenceAbsolutePath: evidencePath,
        evidenceFileSha256: evidenceFileSha,
        rowEvidenceSha256: rowEvidenceSha,
        evidenceBindingSha256: evidenceBindingSha
      },
      priorFailures: [priorFailureRef]
    };

    const slotBindingHash = hashCanonicalValue(bindingBase);
    bindings.push({ ...bindingBase, slotBindingHash });

    // ── 8. Profile manifest slot ──
    profileSlots.push({
      slot: cfg.slot,
      slotBindingHash,
      truthBindingHash: truthBindingSha,
      difficultyTruth: band,
      verdictTruth: truthVerdict,
      priorFailures: [cfg.failureClass]
    });
  }

  // ── Private smoke manifest ──
  const selectionBindingSha = hashCanonicalValue(
    bindings.map((b) => (b as { slotBindingHash: string }).slotBindingHash)
  );
  const privateManifest = {
    schemaVersion: 1,
    selectionPolicy: {
      name: "frozen-human-evidence-6x4-v1",
      selectionBindingSha256: selectionBindingSha,
      phase0Slots: ["slot-01", "slot-02"],
      phase1Slots: ["slot-03", "slot-04", "slot-05", "slot-06"],
      difficultyBandDefinition: {
        low: "explicit CF rating < 1400",
        middle: "explicit CF rating 1400-2199",
        high: "explicit CF rating >= 2200"
      }
    },
    profileManifest: {
      schemaVersion: 1,
      profileName: developmentSmokeProfile.name,
      slots: profileSlots
    },
    bindings
  };

  const manifestPath = resolve(rootDir, "private-manifest.json");
  writePrivateJson(manifestPath, privateManifest);

  // ── Models YAML source (content-free, valid) ──
  const modelsYamlSource = [
    'experimentVersion: "test-v1"',
    "defaults:",
    "  modelProfileName: review-balanced",
    "  pollingIntervalSeconds: 30",
    "  maximumConcurrentTasks: 2",
    "profiles:",
    "  review-balanced:",
    "    difficulty:",
    "      provider: aether",
    "      model: deepseek-v4-flash",
    "      temperature: 0.2",
    "      thinking: false",
    "      thinkingRequest: enabled",
    "      reasoningEffort: max",
    "    thinking:",
    "      solver:",
    "        provider: aether",
    "        model: deepseek-v4-pro",
    "        temperature: 0.4",
    "        thinking: true",
    "        thinkingRequest: enabled",
    "        reasoningEffort: max",
    "      analyst:",
    "        provider: aether",
    "        model: deepseek-v4-flash",
    "        temperature: 0.1",
    "        thinking: false",
    "        thinkingRequest: enabled",
    "        reasoningEffort: max",
    "    coding:",
    "      provider: aether",
    "      model: deepseek-v4-flash",
    "      temperature: 0.3",
    "      thinking: false",
    "      thinkingRequest: enabled",
    "      reasoningEffort: max",
    "    verdict:",
    "      provider: aether",
    "      model: deepseek-v4-pro",
    "      temperature: 0.1",
    "      thinking: false",
    "      thinkingRequest: enabled",
    "      reasoningEffort: max",
    "    reviewFlow:",
    "      solver:",
    "        provider: aether",
    "        model: deepseek-v4-pro",
    "        temperature: 0.4",
    "        thinking: true",
    "        thinkingRequest: enabled",
    "        reasoningEffort: max",
    "      solutionAnalyst:",
    "        provider: aether",
    "        model: deepseek-v4-pro",
    "        temperature: 0.2",
    "        thinking: true",
    "        thinkingRequest: enabled",
    "        reasoningEffort: max",
    "      technicalAuditor:",
    "        provider: aether",
    "        model: deepseek-v4-pro",
    "        temperature: 0.1",
    "        thinking: true",
    "        thinkingRequest: enabled",
    "        reasoningEffort: max",
    "      difficulty:",
    "        provider: aether",
    "        model: deepseek-v4-flash",
    "        temperature: 0.2",
    "        thinking: false",
    "        thinkingRequest: enabled",
    "        reasoningEffort: max",
    "      editorialJudge:",
    "        provider: aether",
    "        model: deepseek-v4-pro",
    "        temperature: 0.1",
    "        thinking: true",
    "        thinkingRequest: enabled",
    "        reasoningEffort: max",
    "      contestFit:",
    "        provider: aether",
    "        model: deepseek-v4-pro",
    "        temperature: 0.1",
    "        thinking: true",
    "        thinkingRequest: enabled",
    "        reasoningEffort: max",
    "      originality:",
    "        provider: aether",
    "        model: deepseek-v4-flash",
    "        temperature: 0.1",
    "        thinking: false",
    "        thinkingRequest: enabled",
    "        reasoningEffort: max",
    "      tags:",
    "        provider: aether",
    "        model: deepseek-v4-flash",
    "        temperature: 0.1",
    "        thinking: false",
    "        thinkingRequest: enabled",
    "        reasoningEffort: max",
    "      critic:",
    "        provider: aether",
    "        model: deepseek-v4-pro",
    "        temperature: 0.2",
    "        thinking: true",
    "        thinkingRequest: enabled",
    "        reasoningEffort: max",
    "      adversary:",
    "        provider: aether",
    "        model: deepseek-v4-pro",
    "        temperature: 0.2",
    "        thinking: true",
    "        thinkingRequest: enabled",
    "        reasoningEffort: max",
    "      adjudicator:",
    "        provider: aether",
    "        model: deepseek-v4-pro",
    "        temperature: 0.1",
    "        thinking: true",
    "        thinkingRequest: enabled",
    "        reasoningEffort: max",
    "retry:",
    "  maxAttempts: 3",
    "  baseDelayMs: 500",
    "timeouts:",
    "  llmFirstOutputMs: 600000",
    "  llmOutputIdleMs: 600000",
    "  llmMaximumDurationMs: 1800000",
    "  codeforcesRequestMs: 15000",
    "codeforces:",
    "  minimumRequestIntervalMs: 2100",
    "thresholds:",
    "  duplicateSimilarityReject: 0.9"
  ].join("\n");

  // ── Controlled Aether env (no real keys, mock fetch injected later) ──
  const paidExecutionSourceContractFingerprint =
    digest("fixture-paid-source-contract");
  const privateRoots = [rootDir];
  const env: Record<string, string | undefined> = {
    FERMATA_RUN_WITH_ENV: "1",
    FERMATA_DEVELOPMENT_DIAGNOSTIC_MANIFEST: manifestPath,
    FERMATA_DEVELOPMENT_DIAGNOSTIC_STARTUP_CONTRACT:
      paidExecutionSourceContractFingerprint,
    FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS: JSON.stringify(privateRoots),
    FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS_ATTESTATION:
      hashCanonicalValue({
        privateRoots,
        schemaVersion: 1,
        startupContractFingerprint: paidExecutionSourceContractFingerprint
      }),
    AETHER_BASE_URL: "http://test-aether.invalid",
    AETHER_API_KEY: "test-key-not-real"
  };

  return {
    rootDir,
    manifestPath,
    repositoryRoot: rootDir,
    modelsYamlSource,
    paidExecutionSourceContractFingerprint,
    env,
    taskCandidates
  };
}

/* ═══════════════════════════════════════════════════════════════
 * Mock fetch — returns valid SSE stream for all roles
 * ═══════════════════════════════════════════════════════════════ */

let mockFetchCallCount = 0;

function buildMockFetchForAllRoles(): (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response> {
  // 断言绑定的 fetch 覆盖被真正调用（绑定通过后才会进入标定运行）。
  return async function mockFetch(
    _input: string | URL | Request,
    _init?: RequestInit
  ): Promise<Response> {
    mockFetchCallCount += 1;
    throw new Error("MOCK_FETCH_NOT_CONFIGURED");
  };
}

function materializePaidExecutionSourceFixture(fixture: RealSmokeFixture): void {
  const sourceFiles = [
    "config/anchors/difficulty.json",
    "config/models.yaml",
    "src/config.ts",
    "experiments/lib/development-diagnostic-run-state.ts",
    "experiments/lib/development-smoke-launcher.ts",
    "experiments/run-development-diagnostic.ts",
    "scripts/development-diagnostic-bootstrap.mjs",
    "scripts/env-file.mjs",
    "scripts/private-runtime.mjs",
    "scripts/run-with-env.mjs"
  ] as const;
  for (const sourceId of sourceFiles) {
    const sourcePath = resolve(fixture.repositoryRoot, sourceId);
    mkdirSync(resolve(sourcePath, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(sourcePath, `export const fixtureSource = ${JSON.stringify(sourceId)};\n`, {
      mode: 0o600
    });
  }
  writeFileSync(
    resolve(fixture.repositoryRoot, "package.json"),
    JSON.stringify({
      type: "module",
      engines: { node: ">=24" },
      scripts: {
        "diagnostic:development":
          "node scripts/development-diagnostic-bootstrap.mjs"
      }
    }),
    { mode: 0o600 }
  );
}

interface BootstrapFixture {
  readonly root: string;
  readonly bootstrap: string;
  readonly trustedNode: string;
  readonly stateDirectory: string;
  readonly envFile: string;
  readonly sentinelFile: string;
  readonly wrongDigestTrigger: string;
}

const emptyBootstrapSentinels = Object.freeze({
  helperLoad: 0,
  envOpen: 0,
  network: 0,
  fetch: 0,
  paid: 0
});

function bootstrapEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME ?? realpathSync(resolve(".")),
    LANG: "C",
    NO_PROXY: "*",
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`
  };
}

function prependBootstrapSentinel(
  fixture: BootstrapFixture,
  sourceId: "scripts/env-file.mjs" | "scripts/private-runtime.mjs" | "scripts/run-with-env.mjs"
): void {
  const path = resolve(fixture.root, sourceId);
  let source = readFileSync(path, "utf8");
  const prefix = [
    "import { existsSync as __bootstrapExists, readFileSync as __bootstrapRead, writeFileSync as __bootstrapWrite } from \"node:fs\";",
    `const __bootstrapSentinelPath = ${JSON.stringify(fixture.sentinelFile)};`,
    "function __bumpBootstrapSentinel(key) {",
    "  const value = JSON.parse(__bootstrapRead(__bootstrapSentinelPath, \"utf8\"));",
    "  value[key] += 1;",
    "  __bootstrapWrite(__bootstrapSentinelPath, JSON.stringify(value));",
    "}",
    "__bumpBootstrapSentinel(\"helperLoad\");",
    sourceId === "scripts/run-with-env.mjs"
      ? [
          `if (__bootstrapExists(${JSON.stringify(fixture.wrongDigestTrigger)})) {`,
          `  __bootstrapWrite(${JSON.stringify(resolve(
            fixture.stateDirectory,
            "development-diagnostic-bootstrap-contract.json"
          ))}, JSON.stringify({ schemaVersion: 1, contractFingerprint: ${JSON.stringify(
            digest("wrong-approved-bootstrap-contract")
          )} }) + "\\n", { mode: 0o600 });`,
          "}"
        ].join("\n")
      : "",
    ""
  ].join("\n");
  if (source.startsWith("#!")) {
    const firstNewline = source.indexOf("\n");
    source = `${source.slice(0, firstNewline + 1)}${prefix}${source.slice(firstNewline + 1)}`;
  } else {
    source = `${prefix}${source}`;
  }
  if (sourceId === "scripts/private-runtime.mjs") {
    source = source.replace(
      ") {\n  if (!isAbsolute(envFile)) {",
      ") {\n  __bumpBootstrapSentinel(\"envOpen\");\n  if (!isAbsolute(envFile)) {"
    );
  }
  writeFileSync(path, source, { mode: 0o600 });
}

function copyInstalledRuntimeClosure(
  repositoryRoot: string,
  fixtureRoot: string
): void {
  const rootPackage = JSON.parse(
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8")
  ) as {
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  const queue = [
    ...Object.keys(rootPackage.dependencies ?? {}),
    "tsx"
  ];
  const copied = new Set<string>();
  while (queue.length > 0) {
    const packageName = queue.shift();
    if (packageName === undefined || copied.has(packageName)) continue;
    const source = resolve(repositoryRoot, "node_modules", packageName);
    if (!existsSync(source)) {
      throw new Error(`required runtime package is not installed: ${packageName}`);
    }
    const packageObject = JSON.parse(
      readFileSync(resolve(source, "package.json"), "utf8")
    ) as {
      readonly dependencies?: Readonly<Record<string, string>>;
      readonly optionalDependencies?: Readonly<Record<string, string>>;
      readonly peerDependencies?: Readonly<Record<string, string>>;
      readonly peerDependenciesMeta?: Readonly<
        Record<string, { readonly optional?: boolean }>
      >;
    };
    const destination = resolve(fixtureRoot, "node_modules", packageName);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    cpSync(source, destination, { recursive: true, preserveTimestamps: true });
    copied.add(packageName);
    queue.push(...Object.keys(packageObject.dependencies ?? {}));
    for (const optionalName of Object.keys(
      packageObject.optionalDependencies ?? {}
    )) {
      if (existsSync(resolve(repositoryRoot, "node_modules", optionalName))) {
        queue.push(optionalName);
      }
    }
    for (const peerName of Object.keys(packageObject.peerDependencies ?? {})) {
      if (existsSync(resolve(repositoryRoot, "node_modules", peerName))) {
        queue.push(peerName);
      } else if (packageObject.peerDependenciesMeta?.[peerName]?.optional !== true) {
        throw new Error(`required runtime peer is not installed: ${peerName}`);
      }
    }
  }
}


function createBootstrapFixture(): BootstrapFixture {
  const repositoryRoot = realpathSync(resolve("."));
  const workspace = mkdtempSync(resolve(
    dirname(repositoryRoot),
    ".development-bootstrap-fixture-"
  ));
  chmodSync(workspace, 0o700);
  fixtureRoots.push(workspace);
  const root = resolve(workspace, "Fermata");
  mkdirSync(root, { mode: 0o700 });
  cpSync(resolve(repositoryRoot, "src"), resolve(root, "src"), {
    recursive: true,
    preserveTimestamps: true
  });
  chmodSync(resolve(root, "src"), 0o700);
  for (const directory of readdirSync(resolve(root, "src"), {
    recursive: true,
    withFileTypes: true
  })) {
    if (directory.isDirectory()) {
      chmodSync(resolve(directory.parentPath, directory.name), 0o700);
    }
  }
  const entryFiles = [
    "config/models.yaml",
    "config/anchors/difficulty.json",
    "experiments/lib/development-diagnostic-run-state.ts",
    "experiments/lib/development-smoke-launcher.ts",
    "experiments/run-development-diagnostic.ts",
    "scripts/development-diagnostic-bootstrap.mjs",
    "scripts/env-file.mjs",
    "scripts/private-runtime.mjs",
    "scripts/run-with-env.mjs",
    "package.json",
    "package-lock.json",
    "tsconfig.json"
  ] as const;
  for (const sourceId of entryFiles) {
    const destination = resolve(root, sourceId);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    cpSync(resolve(repositoryRoot, sourceId), destination, {
      preserveTimestamps: true
    });
  }
  const repositoryConfigMode =
    lstatSync(resolve(repositoryRoot, "config")).mode & 0o777;
  chmodSync(resolve(root, "config"), repositoryConfigMode);
  for (const path of [
    resolve(root, "experiments"),
    resolve(root, "experiments/lib"),
    resolve(root, "scripts")
  ]) {
    chmodSync(path, 0o700);
  }
  copyInstalledRuntimeClosure(repositoryRoot, root);
  chmodSync(resolve(root, "node_modules"), 0o700);
  for (const directory of readdirSync(resolve(root, "node_modules"), {
    recursive: true,
    withFileTypes: true
  })) {
    if (directory.isDirectory()) {
      chmodSync(resolve(directory.parentPath, directory.name), 0o700);
    }
  }
  cpSync(
    resolve(repositoryRoot, "node_modules/.package-lock.json"),
    resolve(root, "node_modules/.package-lock.json"),
    { preserveTimestamps: true }
  );
  const stateDirectory = resolve(root, "bootstrap-state");
  const privateDirectory = resolve(root, "private");
  mkdirSync(stateDirectory, { mode: 0o700 });
  mkdirSync(privateDirectory, { mode: 0o700 });
  mkdirSync(resolve(workspace, "Urmotiv/private"), {
    recursive: true,
    mode: 0o700
  });
  const envFile = resolve(privateDirectory, "diagnostic.env");
  writePrivateFile(envFile, "");
  const trustedNodeDirectory = resolve(root, "trusted-node");
  mkdirSync(trustedNodeDirectory, { mode: 0o700 });
  const trustedNode = resolve(trustedNodeDirectory, "node");
  linkSync(process.execPath, trustedNode);
  const fixture: BootstrapFixture = {
    root,
    bootstrap: resolve(root, "scripts/development-diagnostic-bootstrap.mjs"),
    trustedNode,
    stateDirectory,
    envFile,
    sentinelFile: resolve(root, "bootstrap-sentinels.json"),
    wrongDigestTrigger: resolve(root, "wrong-digest-trigger")
  };
  writePrivateJson(fixture.sentinelFile, emptyBootstrapSentinels);
  prependBootstrapSentinel(fixture, "scripts/env-file.mjs");
  prependBootstrapSentinel(fixture, "scripts/private-runtime.mjs");
  prependBootstrapSentinel(fixture, "scripts/run-with-env.mjs");
  return fixture;
}

function runBootstrap(
  fixture: BootstrapFixture,
  arguments_: readonly string[]
): SpawnSyncReturns<string> {
  return spawnSync(fixture.trustedNode, [fixture.bootstrap, ...arguments_], {
    cwd: fixture.root,
    encoding: "utf8",
    env: bootstrapEnvironment(),
    timeout: 120_000
  });
}

function approveBootstrapFixture(fixture: BootstrapFixture): string {
  const printed = runBootstrap(fixture, [
    "--print-contract",
    "--state-dir",
    fixture.stateDirectory
  ]);
  expect(printed.error).toBeUndefined();
  expect(printed.status, `${printed.stdout}\n${printed.stderr}`).toBe(0);
  const parsed = JSON.parse(printed.stdout.trim()) as {
    readonly contractFingerprint: string;
  };
  expect(parsed.contractFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  const approved = runBootstrap(fixture, [
    fixture.envFile,
    "--approve-contract",
    parsed.contractFingerprint,
    "--state-dir",
    fixture.stateDirectory
  ]);
  expect(approved.error).toBeUndefined();
  expect(approved.status).toBe(0);
  return parsed.contractFingerprint;
}

function expectBootstrapSentinels(
  fixture: BootstrapFixture,
  expected: Readonly<Record<keyof typeof emptyBootstrapSentinels, number>>
): void {
  expect(JSON.parse(readFileSync(fixture.sentinelFile, "utf8"))).toEqual(expected);
}

/* ═══════════════════════════════════════════════════════════════
 * Controller helpers
 * ═══════════════════════════════════════════════════════════════ */

function buildContentFreeManifest(): DevelopmentDiagnosticManifest {
  return parseDevelopmentDiagnosticManifest({
    schemaVersion: 1,
    profileName: "development-diagnostic-2x4-v1",
    profileFingerprint: developmentDiagnosticProfileFingerprint,
    slots: [
      { slot: "slot-01", sourceBinding: digest("src-01"), truthBindingHash: digest("truth-01") },
      { slot: "slot-02", sourceBinding: digest("src-02"), truthBindingHash: digest("truth-02") }
    ]
  });
}

function buildController(options?: {
  readonly clock?: () => number;
  readonly scheduler?: FairLlmRequestScheduler;
  readonly plannedRun?: DevelopmentDiagnosticPlannedRunContract;
  readonly lifecycleSink?: (
    event: DevelopmentDiagnosticLifecycleEvent
  ) => Promise<void>;
}): DevelopmentDiagnosticRunController {
  const plannedRun =
    options?.plannedRun ?? legacyDevelopmentDiagnosticPlannedRunContract;
  const scheduler =
    options?.scheduler ??
    createDevelopmentDiagnosticScheduler(developmentDiagnosticProfile, plannedRun);
  return new DevelopmentDiagnosticRunController({
    profile: developmentDiagnosticProfile,
    plannedRun,
    manifest: buildContentFreeManifest(),
    runBindingHash: digest("run-binding"),
    scheduler,
    lifecycleSink: options?.lifecycleSink,
    startedAtMs: 0,
    clock: options?.clock ?? (() => 0)
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const root of fixtureRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  fixtureRoots.length = 0;
});

/* ═══════════════════════════════════════════════════════════════
 * 1. Profile and manifest validation
 * ═══════════════════════════════════════════════════════════════ */

describe("development diagnostic profile", () => {
  it("2×4 profile is unchanged and distinct from 6×4 smoke", () => {
    expect(developmentDiagnosticProfile.name).toBe("development-diagnostic-2x4-v1");
    expect(developmentDiagnosticProfile.anonymousSlotCount).toBe(2);
    expect(developmentDiagnosticProfileFingerprint).not.toBe(developmentSmokeProfileFingerprint);
  });

  it("6x4 profile is unchanged and distinct from diagnostic", () => {
    expect(developmentSmokeProfile.name).toBe("development-smoke-6x4-v1");
    expect(developmentSmokeProfile.anonymousSlotCount).toBe(6);
    expect(developmentSmokeProfileFingerprint).not.toBe(developmentDiagnosticProfileFingerprint);
  });

  it("profile schema rejects unknown keys", () => {
    expect(() =>
      parseDevelopmentDiagnosticProfile({ ...developmentDiagnosticProfile, extra: true })
    ).toThrow();
  });

  it("manifest schema rejects unknown keys", () => {
    expect(() =>
      parseDevelopmentDiagnosticManifest({
        ...buildContentFreeManifest(),
        extra: true
      } as unknown)
    ).toThrow();
  });

  it("budget receipt is frozen", () => {
    expect(Object.isFrozen(developmentDiagnosticAggregateBudgetReceipt)).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════
 * 2. TransportPreDispatchGate
 * ═══════════════════════════════════════════════════════════════ */

describe("TransportPreDispatchGate", () => {
  it("reserveOrThrow succeeds under ceiling", () => {
    const gate = new TransportPreDispatchGate(5, new LlmRequestStartGate());
    expect(() => gate.reserveOrThrow()).not.toThrow();
    expect(() => gate.reserveOrThrow()).not.toThrow();
    expect(() => gate.reserveOrThrow()).not.toThrow();
  });

  it("reserveOrThrow denies at ceiling", () => {
    const gate = new TransportPreDispatchGate(2, new LlmRequestStartGate());
    gate.reserveOrThrow();
    gate.reserveOrThrow();
    expect(() => gate.reserveOrThrow()).toThrow("TRANSPORT_GATE_DENIED");
  });

  it("close() denies all further reservations", () => {
    const gate = new TransportPreDispatchGate(10, new LlmRequestStartGate());
    gate.close();
    expect(() => gate.reserveOrThrow()).toThrow("TRANSPORT_GATE_DENIED");
  });

  it("closed requestStartGate denies transport", () => {
    const startGate = new LlmRequestStartGate();
    const gate = new TransportPreDispatchGate(10, startGate);
    startGate.close();
    expect(() => gate.reserveOrThrow()).toThrow("TRANSPORT_GATE_DENIED");
  });
});

/* ═══════════════════════════════════════════════════════════════
 * 3. Controller transport deadline enforcement
 * ═══════════════════════════════════════════════════════════════ */
describe("DevelopmentDiagnosticRunController — real transport boundaries", () => {
  it("52nd fetch succeeds and 53rd hook is denied before fetch", async () => {
    const controller = buildController();
    for (let index = 0; index < 51; index += 1) {
      controller.reserveTransportOrThrow();
    }
    let dispatchCount = 0;
    let hookCount = 0;
    let deniedCount = 0;
    let fetchCount = 0;
    const runtime = diagnosticTransportRuntime(
      controller,
      async () => {
        fetchCount += 1;
        return successfulSseResponse();
      },
      {
        onDispatch: () => {
          dispatchCount += 1;
        },
        onTransportHook: () => {
          hookCount += 1;
        },
        onTransportDenied: () => {
          deniedCount += 1;
        }
      }
    );
    await chatCompleteWithReceipt(
      syntheticProvider,
      syntheticSpec,
      syntheticMessages,
      runtime
    );
    expect({
      dispatchCount,
      hookCount,
      deniedCount,
      fetchCount,
      cumulativeAccepted: controller.checkpoint().externalAttemptsUsed
    }).toEqual({
      dispatchCount: 1,
      hookCount: 1,
      deniedCount: 0,
      fetchCount: 1,
      cumulativeAccepted: 52
    });
    await expect(chatCompleteWithReceipt(
      syntheticProvider,
      syntheticSpec,
      syntheticMessages,
      runtime
    )).rejects.toMatchObject({ code: "LLM_TRANSPORT_DENIED" });
    expect({
      dispatchCount,
      hookCount,
      deniedCount,
      fetchCount,
      cumulativeAccepted: controller.checkpoint().externalAttemptsUsed
    }).toEqual({
      dispatchCount: 2,
      hookCount: 2,
      deniedCount: 1,
      fetchCount: 1,
      cumulativeAccepted: 52
    });
  });
  it("retryable 429 keeps every gate open until the successful second fetch", async () => {
    const controller = buildController();
    let dispatchCount = 0;
    let hookCount = 0;
    let fetchCount = 0;
    let deniedCount = 0;
    let terminalFailureCallbackCount = 0;
    const runtime = diagnosticTransportRuntime(
      controller,
      async () => {
        fetchCount += 1;
        return fetchCount === 1
          ? new Response(null, { status: 429 })
          : successfulSseResponse();
      },
      {
        maxAttempts: 2,
        onDispatch: () => {
          dispatchCount += 1;
          if (dispatchCount !== 2) return;
          expect({
            hookCount,
            fetchCount,
            deniedCount,
            terminalFailureCallbackCount,
            externalAttemptsUsed: controller.checkpoint().externalAttemptsUsed,
            stopped: controller.checkpoint().stopped,
            firstFailureKind: controller.checkpoint().firstFailureKind,
            requestGateOpen: controller.requestStartGate.canStartRequest(),
            schedulerSoftStopped: controller.scheduler().snapshot().softStopped
          }).toEqual({
            hookCount: 1,
            fetchCount: 1,
            deniedCount: 0,
            terminalFailureCallbackCount: 0,
            externalAttemptsUsed: 1,
            stopped: false,
            firstFailureKind: null,
            requestGateOpen: true,
            schedulerSoftStopped: false
          });
        },
        onTransportHook: () => {
          hookCount += 1;
        },
        onTransportDenied: () => {
          deniedCount += 1;
        }
      }
    );
    const result = await chatCompleteWithReceipt(
      syntheticProvider,
      syntheticSpec,
      syntheticMessages,
      runtime
    ).catch((error: unknown) => {
      terminalFailureCallbackCount += 1;
      controller.recordTerminalRoleFailure(
        "slot-01",
        "solver",
        "service_http",
        error
      );
      throw error;
    });
    expect(result.receipt.transportAttemptCount).toBe(2);
    expect({
      dispatchCount,
      hookCount,
      fetchCount,
      deniedCount,
      terminalFailureCallbackCount,
      externalAttemptsUsed: controller.checkpoint().externalAttemptsUsed,
      stopped: controller.checkpoint().stopped,
      firstFailureKind: controller.checkpoint().firstFailureKind,
      requestGateOpen: controller.requestStartGate.canStartRequest(),
      schedulerSoftStopped: controller.scheduler().snapshot().softStopped
    }).toEqual({
      dispatchCount: 2,
      hookCount: 2,
      fetchCount: 2,
      terminalFailureCallbackCount: 0,
      deniedCount: 0,
      externalAttemptsUsed: 2,
      stopped: false,
      firstFailureKind: null,
      requestGateOpen: true,
      schedulerSoftStopped: false
    });
  });
  it("global cumulative attempt ceiling drains the final retry then closes new scheduling", async () => {
    const plannedRun = {
      schemaVersion: 1 as const,
      selectedSlots: ["slot-01"] as const,
      expectedRequestsPerSlot: 12 as const,
      maximumConcurrency: 16,
      maximumTransportAttemptsPerRequest: 2,
      globalTransportAttemptCeiling: 52,
      phaseSchedulingBudgetMs: 90 * 60_000,
      softStopPolicy: "stop_new_and_drain_in_flight" as const
    };
    const controller = buildController({ plannedRun });
    for (let index = 0; index < 50; index += 1) {
      controller.reserveTransportOrThrow();
    }
    let fetchCount = 0;
    const result = await chatCompleteWithReceipt(
      syntheticProvider,
      syntheticSpec,
      syntheticMessages,
      diagnosticTransportRuntime(
        controller,
        async () => {
          fetchCount += 1;
          return fetchCount === 1
            ? new Response(null, { status: 429 })
            : successfulSseResponse();
        },
        { maxAttempts: 2 }
      )
    );
    expect(result.receipt.transportAttemptCount).toBe(2);
    expect(fetchCount).toBe(2);
    expect(controller.checkpoint()).toMatchObject({
      externalAttemptsUsed: 52,
      stopped: true,
      stopReason: "attempt_ceiling"
    });
    expect(controller.scheduler().snapshot().active).toBe(0);
    expect(controller.requestStartGate.canStartRequest()).toBe(false);
  });

  it("deadline denies a queued fifth fetch while four started fetches drain", async () => {
    const clock = { ms: 0 };
    const controller = buildController({ clock: () => clock.ms });
    let fetchCount = 0;
    let releaseStarted: (() => void) | undefined;
    let signalAllStarted: (() => void) | undefined;
    const allStarted = new Promise<void>((resolveStarted) => {
      signalAllStarted = resolveStarted;
    });
    const held = new Promise<void>((resolveHeld) => {
      releaseStarted = resolveHeld;
    });
    const runtime = diagnosticTransportRuntime(controller, async () => {
      fetchCount += 1;
      if (fetchCount === 4) signalAllStarted?.();
      await held;
      return successfulSseResponse();
    });
    const draining = Array.from({ length: 4 }, () =>
      chatCompleteWithReceipt(
        syntheticProvider,
        syntheticSpec,
        syntheticMessages,
        runtime
      )
    );
    await allStarted;
    const denied = chatCompleteWithReceipt(
      syntheticProvider,
      syntheticSpec,
      syntheticMessages,
      runtime
    );
    clock.ms = 3_600_001;
    releaseStarted?.();
    await expect(denied).rejects.toMatchObject({ code: "LLM_TRANSPORT_DENIED" });
    await Promise.all(draining);
    expect(fetchCount).toBe(4);
    expect(controller.checkpoint().externalAttemptsUsed).toBe(4);
  });

  it("shared scheduler holds ten live response bodies to peak four", async () => {
    const controller = buildController();
    let fetchCount = 0;
    let active = 0;
    let peak = 0;
    let signalPeak: (() => void) | undefined;
    let release: (() => void) | undefined;
    const reachedPeak = new Promise<void>((resolvePeak) => {
      signalPeak = resolvePeak;
    });
    const held = new Promise<void>((resolveHeld) => {
      release = resolveHeld;
    });
    const payload = new TextEncoder().encode([
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
      ""
    ].join("\n\n"));
    const runtime = diagnosticTransportRuntime(controller, async () => {
      fetchCount += 1;
      const body = new ReadableStream<Uint8Array>({
        async start(streamController) {
          active += 1;
          peak = Math.max(peak, active);
          if (active === 4) signalPeak?.();
          await held;
          streamController.enqueue(payload);
          streamController.close();
          active -= 1;
        }
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });
    const requests = Array.from({ length: 10 }, () =>
      chatCompleteWithReceipt(
        syntheticProvider,
        syntheticSpec,
        syntheticMessages,
        runtime
      )
    );
    await reachedPeak;
    expect(active).toBe(4);
    expect(fetchCount).toBe(4);
    release?.();
    await Promise.all(requests);
    expect(fetchCount).toBe(10);
    expect(peak).toBe(4);
    expect(controller.scheduler().snapshot().peakConcurrency).toBe(4);
  });
});

describe("DevelopmentDiagnosticRunController — atomic outcome state", () => {
  it("commits complete A/B/C/D exactly once with formatter not started", () => {
    const controller = buildController();
    controller.applySlotOutcome("slot-01", completeCalibrationOutcome());
    controller.applySlotOutcome("slot-01", completeCalibrationOutcome());
    expect(controller.getStageSnapshot("slot-01")).toEqual({
      A: "complete",
      B: "complete",
      C: "complete",
      D: "complete",
      F: "not_started"
    });
    const checkpoint = controller.checkpoint();
    expect(checkpoint.completedRequestCount).toBe(4);
    expect(checkpoint.completedSlotCount).toBe(1);
  });

  it("invalid complete outcome cannot partially mutate stage state", () => {
    const controller = buildController();
    const complete = completeCalibrationOutcome();
    if (complete.status !== "complete") throw new Error("TEST_OUTCOME_INVALID");
    const invalid: ReviewFlowCalibrationOutcome = {
      status: "complete",
      projection: {
        ...complete.projection,
        receiptSetHash: "0".repeat(64)
      }
    };
    expect(() => controller.applySlotOutcome("slot-01", invalid)).toThrow();
    expect(controller.getStageSnapshot("slot-01")).toEqual({
      A: "not_started",
      B: "not_started",
      C: "not_started",
      D: "not_started",
      F: "not_started"
    });
    expect(controller.checkpoint().completedSlotCount).toBe(0);
    expect(controller.checkpoint().completedRequestCount).toBe(0);
    expect(controller.getRoleCompletions("slot-01")).toEqual([]);
    expect(controller.getRoleFailures("slot-01")).toEqual([]);
  });

  it.each([
    ["rate_limited", "service_http", { code: "LLM_HTTP_ERROR", status: 429 }],
    ["server_error", "service_http", { code: "LLM_HTTP_ERROR", status: 500 }],
    ["connect", "transport", { code: "LLM_NETWORK_FAILED" }],
    ["first_byte_timeout", "timeout", { code: "LLM_FIRST_OUTPUT_TIMEOUT" }],
    ["no_progress_timeout", "timeout", { code: "LLM_OUTPUT_IDLE_TIMEOUT" }],
    ["stream_interrupted", "transport", { code: "LLM_STREAM_INTERRUPTED" }],
    ["output_limit", "output_limit", { code: "LLM_OUTPUT_LENGTH_LIMIT" }],
    ["schema_invalid", "schema_output", { code: "SCHEMA_INVALID" }],
    ["permanent", "validation", { code: "VALIDATION_FAILED" }]
  ] as const)(
    "first terminal %s callback closes request, transport, and scheduler gates",
    (expectedKind, failureKind, error) => {
      const controller = buildController();
      controller.recordTerminalRoleFailure(
        "slot-01",
        "solver",
        failureKind,
        error
      );
      expect(controller.checkpoint().firstFailureKind).toBe(expectedKind);
      expect(controller.requestStartGate.canStartRequest()).toBe(false);
      expect(() => controller.reserveTransportOrThrow()).toThrow("TRANSPORT_GATE_DENIED");
      expect(controller.scheduler().snapshot().softStopped).toBe(true);
    }
  );
});
describe("Development diagnostic — real terminal failure paths", () => {
  it.each([
    ["rate_limited", "rate_limited"],
    ["server_error", "server_error"],
    ["connect", "connect"],
    ["first_byte_timeout", "first_byte_timeout"],
    ["no_progress_timeout", "no_progress_timeout"],
    ["stream_interrupted", "stream_interrupted"],
    ["output_limit", "output_limit"],
    ["schema_invalid", "schema_invalid"],
    ["permanent", "permanent"]
  ] as const)(
    "real orchestrator request path classifies first terminal %s",
    async (path, expectedKind) => {
      const fixture = createRealDevelopmentSmokeFixture();
      const preflight = preflightDevelopmentDiagnostic({
        repositoryRoot: fixture.repositoryRoot,
        projectRoot: fixture.repositoryRoot,
        manifestPath: fixture.manifestPath,
        codeVersion: randomBytes(20).toString("hex"),
        env: fixture.env,
        modelsYamlSource: fixture.modelsYamlSource,
        paidExecutionSourceContractFingerprint:
          fixture.paidExecutionSourceContractFingerprint,
        allowedPrivateRoots: [fixture.rootDir]
      });
      const controller = buildController();
      let startedCount = 0;
      let signalBothStarted: (() => void) | undefined;
      const bothStarted = new Promise<void>((resolveStarted) => {
        signalBothStarted = resolveStarted;
      });
      const observedKinds: string[] = [];
      const recordTerminalRoleFailure =
        controller.recordTerminalRoleFailure.bind(controller);
      controller.recordTerminalRoleFailure = (
        ...args: Parameters<DevelopmentDiagnosticRunController["recordTerminalRoleFailure"]>
      ): void => {
        recordTerminalRoleFailure(...args);
        observedKinds.push(controller.checkpoint().firstFailureKind ?? "missing");
      };
      if ([
        "rate_limited",
        "first_byte_timeout",
        "no_progress_timeout"
      ].includes(path)) {
        vi.useFakeTimers();
      }
      const runPromise = runDevelopmentDiagnosticPhase({
        controller,
        preflight,
        taskCandidates: fixture.taskCandidates.slice(0, 2).map((entry) => ({
          slot: entry.slot as "slot-01" | "slot-02",
          taskCandidate: entry.taskCandidate,
          duplicateSimilarityRejectThreshold: entry.duplicateSimilarityRejectThreshold
        })),
        engineBuildFingerprint: digest("engine"),
        fetchRuntimeOverride: syntheticTerminalFetch(path, () => {
          startedCount += 1;
          if (startedCount === 2) signalBothStarted?.();
        }),
        profileName: preflight.profileName,
        experimentVersion: preflight.experimentVersion
      });
      await bothStarted;
      if (path === "rate_limited") {
        await vi.runAllTimersAsync();
      } else if (
        path === "first_byte_timeout" ||
        path === "no_progress_timeout"
      ) {
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(600_001);
      }
      const outcomes = await runPromise;
      expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
      expect(observedKinds[0]).toBe(expectedKind);
      expect(controller.checkpoint().firstFailureKind).toBe(expectedKind);
      expect(controller.requestStartGate.canStartRequest()).toBe(false);
      expect(() => controller.reserveTransportOrThrow()).toThrow("TRANSPORT_GATE_DENIED");
      expect(controller.scheduler().snapshot().softStopped).toBe(true);
    }
  );
});

describe("Development diagnostic — scheduler-level transport retry contract", () => {
  it("retries LLM_STREAM_INTERRUPTED once; exhaustion preserves stream_interrupted identity", async () => {
    const events: DevelopmentDiagnosticLifecycleEvent[] = [];
    const controller = buildController({
      lifecycleSink: async (event) => {
        events.push(event);
      }
    });
    const settled: Array<{
      sequence: number;
      outcome: string;
      errorCategory: string | null;
    }> = [];
    let fetchCount = 0;
    const runtime = diagnosticTransportRuntime(controller, async () => {
      fetchCount += 1;
      throw new LlmRequestError("LLM_STREAM_INTERRUPTED");
    });
    await expect(
      chatCompleteWithReceipt(
        syntheticProvider,
        syntheticSpec,
        syntheticMessages,
        runtime
      )
    ).rejects.toMatchObject({ code: "LLM_STREAM_INTERRUPTED" });
    for (const event of events) {
      if (event.type === "transport_settled") {
        settled.push({
          sequence: event.sequence,
          outcome: event.outcome,
          errorCategory: event.errorCategory
        });
      }
    }
    expect(fetchCount).toBe(2);
    expect(settled).toEqual([
      { sequence: 1, outcome: "retryable_failed", errorCategory: null },
      { sequence: 2, outcome: "failed", errorCategory: "stream_interrupted" }
    ]);
    const snapshot = controller.scheduler().snapshot();
    expect(Object.values(snapshot.attemptsByCase)).toEqual([2]);
    expect(snapshot.active).toBe(0);
    expect(snapshot.queued).toBe(0);
    expect(controller.checkpoint().externalAttemptsUsed).toBe(2);
  });

  it("retries LLM_NETWORK_FAILED once and succeeds on the second attempt", async () => {
    const controller = buildController();
    let fetchCount = 0;
    const runtime = diagnosticTransportRuntime(controller, async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        throw new LlmRequestError("LLM_NETWORK_FAILED");
      }
      return successfulSseResponse();
    });
    const result = await chatCompleteWithReceipt(
      syntheticProvider,
      syntheticSpec,
      syntheticMessages,
      runtime
    );
    expect(result.receipt.transportAttemptCount).toBe(2);
    expect(fetchCount).toBe(2);
    expect(controller.checkpoint().externalAttemptsUsed).toBe(2);
    expect(Object.values(controller.scheduler().snapshot().attemptsByCase)).toEqual([2]);
  });

  it.each([
    ["LLM_CANCELLED"],
    ["LLM_TRANSPORT_DENIED"],
    ["LLM_REQUEST_START_BLOCKED"],
    ["LLM_FIRST_OUTPUT_TIMEOUT"],
    ["LLM_OUTPUT_IDLE_TIMEOUT"],
    ["LLM_TOTAL_TIMEOUT"],
    ["LLM_RESPONSE_FORMAT_INVALID"],
    ["LLM_RESPONSE_BODY_TOO_LARGE"],
    ["LLM_OUTPUT_LENGTH_LIMIT"]
  ] as const)("never retries non-eligible code %s", async (code) => {
    const controller = buildController();
    let fetchCount = 0;
    const runtime = diagnosticTransportRuntime(controller, async () => {
      fetchCount += 1;
      throw new LlmRequestError(code as LlmRequestError["code"]);
    });
    await expect(
      chatCompleteWithReceipt(
        syntheticProvider,
        syntheticSpec,
        syntheticMessages,
        runtime
      )
    ).rejects.toMatchObject({ code });
    expect(fetchCount).toBe(1);
    expect(Object.values(controller.scheduler().snapshot().attemptsByCase)).toEqual([1]);
    expect(controller.checkpoint().externalAttemptsUsed).toBe(1);
  });

  it("keeps a single dispatched caseId stable across scheduler retries", async () => {
    const controller = buildController();
    let fetchCount = 0;
    const runtime = diagnosticTransportRuntime(controller, async () => {
      fetchCount += 1;
      throw new LlmRequestError("LLM_STREAM_INTERRUPTED");
    });
    await expect(
      chatCompleteWithReceipt(
        syntheticProvider,
        syntheticSpec,
        syntheticMessages,
        runtime
      )
    ).rejects.toMatchObject({ code: "LLM_STREAM_INTERRUPTED" });
    const attemptsByCase = controller.scheduler().snapshot().attemptsByCase;
    const caseIds = Object.keys(attemptsByCase);
    expect(caseIds).toHaveLength(1);
    expect(caseIds[0]).toMatch(/^diagnostic-transport-\d{6}$/);
    expect(attemptsByCase[caseIds[0]]).toBe(2);
  });
});

describe("Development diagnostic — active concurrency versus cumulative budget", () => {
  const singleSlotSharedRun = {
    schemaVersion: 1 as const,
    selectedSlots: ["slot-01"] as const,
    expectedRequestsPerSlot: 12 as const,
    maximumConcurrency: 16,
    maximumTransportAttemptsPerRequest: 2,
    globalTransportAttemptCeiling: 52,
    phaseSchedulingBudgetMs: 90 * 60_000,
    softStopPolicy: "stop_new_and_drain_in_flight" as const
  };
  const createMatchingScheduler = () =>
    new FairLlmRequestScheduler({
      maximumConcurrency: 16,
      maximumAttemptsPerLogicalRequest: 2,
      maximumAttemptsPerCase: 5,
      jitter: () => 0,
      sleep: async () => undefined
    });

  it("allows sixteen simultaneous active transports and queues the seventeenth", async () => {
    const controller = buildController({
      plannedRun: singleSlotSharedRun,
      scheduler: createMatchingScheduler()
    });
    let fetchCount = 0;
    let releaseHeld: (() => void) | undefined;
    let signalSixteen: (() => void) | undefined;
    const allSixteenStarted = new Promise<void>((resolveStarted) => {
      signalSixteen = resolveStarted;
    });
    const held = new Promise<void>((resolveHeld) => {
      releaseHeld = resolveHeld;
    });
    const runtime = diagnosticTransportRuntime(controller, async () => {
      fetchCount += 1;
      if (fetchCount === 16) signalSixteen?.();
      await held;
      return successfulSseResponse();
    });
    const started = Array.from({ length: 16 }, () =>
      chatCompleteWithReceipt(
        syntheticProvider,
        syntheticSpec,
        syntheticMessages,
        runtime
      )
    );
    await allSixteenStarted;
    const extra = chatCompleteWithReceipt(
      syntheticProvider,
      syntheticSpec,
      syntheticMessages,
      runtime
    );
    for (let index = 0; ; index += 1) {
      const queuing = controller.scheduler().snapshot();
      if (queuing.queued === 1) break;
      await Promise.resolve();
      if (index > 1000) throw new Error("seventeenth transport never queued");
    }
    expect(controller.scheduler().snapshot().active).toBe(16);
    expect(controller.scheduler().snapshot().queued).toBe(1);
    releaseHeld?.();
    await Promise.all([...started, extra]);
    expect(fetchCount).toBe(17);
    expect(controller.scheduler().snapshot().active).toBe(0);
    expect(controller.scheduler().snapshot().queued).toBe(0);
    expect(controller.checkpoint().externalAttemptsUsed).toBe(17);
    expect(controller.checkpoint().stopped).toBe(false);
  });

  it("lets cumulative attempts beyond sixteen complete within the separate total budget", async () => {
    const controller = buildController({
      plannedRun: singleSlotSharedRun,
      scheduler: createMatchingScheduler()
    });
    let fetchCount = 0;
    const runtime = diagnosticTransportRuntime(controller, async () => {
      fetchCount += 1;
      return successfulSseResponse();
    });
    for (let index = 0; index < 18; index += 1) {
      const result = await chatCompleteWithReceipt(
        syntheticProvider,
        syntheticSpec,
        syntheticMessages,
        runtime
      );
      expect(result.receipt.transportAttemptCount).toBe(1);
    }
    expect(fetchCount).toBe(18);
    expect(controller.checkpoint().externalAttemptsUsed).toBe(18);
    expect(controller.scheduler().snapshot().active).toBe(0);
    expect(controller.checkpoint().stopped).toBe(false);
  });

  it("keeps retries inside the shared active concurrency gate and respects max two attempts", async () => {
    const controller = buildController({
      plannedRun: singleSlotSharedRun,
      scheduler: createMatchingScheduler()
    });
    let releaseHeld: (() => void) | undefined;
    const held = new Promise<void>((resolveHeld) => {
      releaseHeld = resolveHeld;
    });
    const heldRuntime = diagnosticTransportRuntime(controller, async () => {
      await held;
      return successfulSseResponse();
    });
    const heldSixteen = Array.from({ length: 16 }, () =>
      chatCompleteWithReceipt(
        syntheticProvider,
        syntheticSpec,
        syntheticMessages,
        heldRuntime
      )
    );
    for (let index = 0; ; index += 1) {
      if (controller.scheduler().snapshot().active === 16) break;
      await Promise.resolve();
      if (index > 1000) throw new Error("sixteen active slots never reached");
    }
    let retryFetches = 0;
    const retryRuntime = diagnosticTransportRuntime(controller, async () => {
      retryFetches += 1;
      if (retryFetches === 1) throw new LlmRequestError("LLM_STREAM_INTERRUPTED");
      return successfulSseResponse();
    });
    const retried = chatCompleteWithReceipt(
      syntheticProvider,
      syntheticSpec,
      syntheticMessages,
      retryRuntime
    );
    for (let index = 0; index < 100; index += 1) {
      await Promise.resolve();
    }
    expect(retryFetches).toBe(0);
    releaseHeld?.();
    await Promise.all([retried, ...heldSixteen]);
    expect(retryFetches).toBe(2);
    expect(controller.scheduler().snapshot().peakConcurrency).toBeLessThanOrEqual(16);
    expect(Object.values(controller.scheduler().snapshot().attemptsByCase)).toContain(2);
    expect(controller.checkpoint().externalAttemptsUsed).toBe(18);
  });

  it("enforces the cumulative planned-run ceiling independently of concurrency", async () => {
    const controller = buildController({
      plannedRun: singleSlotSharedRun,
      scheduler: createMatchingScheduler()
    });
    for (let index = 0; index < 52; index += 1) {
      controller.reserveTransportOrThrow();
    }
    expect(() => controller.reserveTransportOrThrow()).toThrow(
      "TRANSPORT_GATE_DENIED"
    );
    expect(controller.checkpoint().externalAttemptsUsed).toBe(52);
    expect(controller.scheduler().snapshot().active).toBe(0);
  });
});

describe("Development diagnostic — real package bootstrap", () => {
  it("prints the installed startup contract through the real npm entry without provider dispatch", () => {
    const repositoryRoot = realpathSync(resolve("."));
    const packageObject = JSON.parse(
      readFileSync(resolve(repositoryRoot, "package.json"), "utf8")
    ) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    expect(packageObject.scripts?.["diagnostic:development"]).toBe(
      "node scripts/development-diagnostic-bootstrap.mjs"
    );
    const result = spawnSync(
      "npm",
      [
        "run",
        "diagnostic:development",
        "--",
        "--print-contract",
        "--state-dir",
        resolve(repositoryRoot, ".state/development-diagnostic")
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          HOME: process.env.HOME ?? repositoryRoot,
          LANG: "C",
          NO_PROXY: "*",
          PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`
        },
        timeout: 120_000
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("DEVELOPMENT_DIAGNOSTIC_BOOTSTRAP_REJECTED");
    const contractLine = result.stdout
      .split(/\r?\n/u)
      .find((line) => line.startsWith("{") && line.includes(
        "\"event\":\"development_diagnostic_bootstrap_contract\""
      ));
    expect(contractLine).toBeDefined();
    expect(JSON.parse(contractLine ?? "{}")).toMatchObject({
      event: "development_diagnostic_bootstrap_contract",
      contractFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
  });

  it("binds the complete installed runtime closure including nested loader and native files", () => {
    const repositoryRoot = realpathSync(resolve("."));
    const probe = [
      "import { pathToFileURL } from 'node:url';",
      "const ids = [];",
      "const module = await import(pathToFileURL(process.argv[2]).href);",
      "const fingerprint = module.verifyDevelopmentDiagnosticStartupContract(process.argv[3], {",
      "  hooks: { afterFileRead: ({ sourceId }) => ids.push(sourceId) }",
      "});",
      "process.stdout.write(JSON.stringify({ fingerprint, ids }));"
    ].join("\n");
    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      probe,
      "bootstrap-contract-probe",
      resolve(repositoryRoot, "scripts/development-diagnostic-bootstrap.mjs"),
      repositoryRoot
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: bootstrapEnvironment(),
      timeout: 120_000
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const observed = JSON.parse(result.stdout) as {
      readonly fingerprint: string;
      readonly ids: readonly string[];
    };
    expect(observed.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(observed.ids).toContain("node_modules/tsx/dist/cli.mjs");
    expect(observed.ids.some((id) => id.startsWith("node_modules/zod/"))).toBe(true);
    expect(observed.ids.some((id) => id.startsWith("node_modules/undici/"))).toBe(true);
    expect(observed.ids).toContain("node_modules/esbuild/lib/main.js");
    expect(observed.ids).toContain(
      `node_modules/@esbuild/${process.platform}-${process.arch}/bin/esbuild`
    );
  });

  it("rejects old authorization for every executable, helper, mapping, metadata, and mode drift before side effects", () => {
    const fixture = createBootstrapFixture();
    approveBootstrapFixture(fixture);
    const textDrifts = [
      [
        "package script",
        resolve(fixture.root, "package.json"),
        (source: string) => source.replace(
          "node scripts/development-diagnostic-bootstrap.mjs",
          "node scripts/development-diagnostic-bootstrap.mjs --drift"
        )
      ],
      [
        "wrapper",
        resolve(fixture.root, "scripts/run-with-env.mjs"),
        (source: string) => `${source}\n// wrapper drift\n`
      ],
      [
        "env helper",
        resolve(fixture.root, "scripts/env-file.mjs"),
        (source: string) => `${source}\n// env helper drift\n`
      ],
      [
        "private runtime",
        resolve(fixture.root, "scripts/private-runtime.mjs"),
        (source: string) => `${source}\n// private runtime drift\n`
      ],
      [
        "difficulty anchors",
        resolve(fixture.root, "config/anchors/difficulty.json"),
        (source: string) => `${source}\n`
      ],
      [
        "tsx loader",
        resolve(fixture.root, "node_modules/tsx/dist/cli.mjs"),
        (source: string) => `${source}\n// loader drift\n`
      ],
      [
        "zod executable bytes",
        resolve(fixture.root, "node_modules/zod/index.js"),
        (source: string) => `${source}\n// zod drift\n`
      ],
      [
        "undici executable bytes",
        resolve(fixture.root, "node_modules/undici/index.js"),
        (source: string) => `${source}\n// undici drift\n`
      ],
      [
        "esbuild executable bytes",
        resolve(fixture.root, "node_modules/esbuild/lib/main.js"),
        (source: string) => `${source}\n// esbuild drift\n`
      ]
    ] as const;
    for (const [_label, path, mutate] of textDrifts) {
      const original = readFileSync(path, "utf8");
      writeFileSync(path, mutate(original));
      writePrivateJson(fixture.sentinelFile, emptyBootstrapSentinels);
      const rejected = runBootstrap(fixture, [
        fixture.envFile,
        "--state-dir",
        fixture.stateDirectory
      ]);
      expect(rejected.status).toBe(1);
      expectBootstrapSentinels(fixture, emptyBootstrapSentinels);
      writeFileSync(path, original);
    }

    const tsconfigPath = resolve(fixture.root, "tsconfig.json");
    const originalTsconfig = readFileSync(tsconfigPath, "utf8");
    const tsconfig = JSON.parse(originalTsconfig) as {
      compilerOptions: Record<string, unknown>;
    };
    tsconfig.compilerOptions.paths = { "@forged/*": ["src/forged/*"] };
    writeFileSync(tsconfigPath, JSON.stringify(tsconfig));
    writePrivateJson(fixture.sentinelFile, emptyBootstrapSentinels);
    expect(runBootstrap(fixture, [
      fixture.envFile,
      "--state-dir",
      fixture.stateDirectory
    ]).status).toBe(1);
    expectBootstrapSentinels(fixture, emptyBootstrapSentinels);
    writeFileSync(tsconfigPath, originalTsconfig);

    const zodMetadataPath = resolve(fixture.root, "node_modules/zod/package.json");
    const originalZodMetadata = readFileSync(zodMetadataPath, "utf8");
    const zodMetadata = JSON.parse(originalZodMetadata) as Record<string, unknown>;
    zodMetadata.dependencies = { "missing-runtime-dependency": "1.0.0" };
    writeFileSync(zodMetadataPath, JSON.stringify(zodMetadata));
    writePrivateJson(fixture.sentinelFile, emptyBootstrapSentinels);
    expect(runBootstrap(fixture, [
      fixture.envFile,
      "--state-dir",
      fixture.stateDirectory
    ]).status).toBe(1);
    expectBootstrapSentinels(fixture, emptyBootstrapSentinels);
    writeFileSync(zodMetadataPath, originalZodMetadata);

    const binaryPath = resolve(
      fixture.root,
      `node_modules/@esbuild/${process.platform}-${process.arch}/bin/esbuild`
    );
    const originalBinary = readFileSync(binaryPath);
    const changedBinary = Buffer.from(originalBinary);
    changedBinary[0] = changedBinary[0] ^ 0xff;
    writeFileSync(binaryPath, changedBinary);
    writePrivateJson(fixture.sentinelFile, emptyBootstrapSentinels);
    expect(runBootstrap(fixture, [
      fixture.envFile,
      "--state-dir",
      fixture.stateDirectory
    ]).status).toBe(1);
    expectBootstrapSentinels(fixture, emptyBootstrapSentinels);
    writeFileSync(binaryPath, originalBinary);

    const modePath = resolve(fixture.root, "node_modules/tsx/dist/cli.mjs");
    const originalMode = lstatSync(modePath).mode & 0o7777;
    chmodSync(modePath, 0o666);
    writePrivateJson(fixture.sentinelFile, emptyBootstrapSentinels);
    expect(runBootstrap(fixture, [
      fixture.envFile,
      "--state-dir",
      fixture.stateDirectory
    ]).status).toBe(1);
    expectBootstrapSentinels(fixture, emptyBootstrapSentinels);
    chmodSync(modePath, originalMode);
  }, 60_000);

  it("rejects missing anchors and unsafe attested private roots before loading helpers or env", () => {
    const fixture = createBootstrapFixture();
    approveBootstrapFixture(fixture);
    const anchors = resolve(fixture.root, "config/anchors/difficulty.json");
    const removedAnchors = resolve(fixture.root, "config/anchors/difficulty.removed");
    renameSync(anchors, removedAnchors);
    expect(runBootstrap(fixture, [
      fixture.envFile,
      "--state-dir",
      fixture.stateDirectory
    ]).status).toBe(1);
    expectBootstrapSentinels(fixture, emptyBootstrapSentinels);
    renameSync(removedAnchors, anchors);

    const siblingPrivate = resolve(dirname(fixture.root), "Urmotiv/private");
    chmodSync(siblingPrivate, 0o707);
    writePrivateJson(fixture.sentinelFile, emptyBootstrapSentinels);
    expect(runBootstrap(fixture, [
      fixture.envFile,
      "--state-dir",
      fixture.stateDirectory
    ]).status).toBe(1);
    expectBootstrapSentinels(fixture, emptyBootstrapSentinels);
    chmodSync(siblingPrivate, 0o700);
  });

  it("allows a bound in-store package link but rejects target drift, escape, and special entries", () => {
    const fixture = createBootstrapFixture();
    const store = resolve(fixture.root, "node_modules/.store");
    mkdirSync(store, { mode: 0o700 });
    renameSync(
      resolve(fixture.root, "node_modules/zod"),
      resolve(store, "zod")
    );
    symlinkSync(".store/zod", resolve(fixture.root, "node_modules/zod"), "dir");
    approveBootstrapFixture(fixture);
    const targetPath = resolve(store, "zod/index.js");
    const originalTarget = readFileSync(targetPath, "utf8");
    writeFileSync(targetPath, `${originalTarget}\n// linked target drift\n`);
    writePrivateJson(fixture.sentinelFile, emptyBootstrapSentinels);
    expect(runBootstrap(fixture, [
      fixture.envFile,
      "--state-dir",
      fixture.stateDirectory
    ]).status).toBe(1);
    expectBootstrapSentinels(fixture, emptyBootstrapSentinels);

    const escaped = createBootstrapFixture();
    renameSync(
      resolve(escaped.root, "node_modules/zod"),
      resolve(escaped.root, "escaped-zod")
    );
    symlinkSync("../escaped-zod", resolve(escaped.root, "node_modules/zod"), "dir");
    const escapedResult = runBootstrap(escaped, [
      "--print-contract",
      "--state-dir",
      escaped.stateDirectory
    ]);
    expect(escapedResult.status).toBe(1);
    expectBootstrapSentinels(escaped, emptyBootstrapSentinels);

    const special = createBootstrapFixture();
    const fifoPath = resolve(special.root, "node_modules/tsx/dist/runtime-fifo");
    const fifo = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
    expect(fifo.status).toBe(0);
    const specialResult = runBootstrap(special, [
      "--print-contract",
      "--state-dir",
      special.stateDirectory
    ]);
    expect(specialResult.status).toBe(1);
    expectBootstrapSentinels(special, emptyBootstrapSentinels);
  });

  it("rejects descriptor races and injected close faults without reading replacements or leaking fds", () => {
    const fixture = createBootstrapFixture();
    const fingerprint = approveBootstrapFixture(fixture);
    const raceProbe = [
      "import { renameSync, writeFileSync } from 'node:fs';",
      "import { pathToFileURL } from 'node:url';",
      "const module = await import(pathToFileURL(process.argv[2]).href);",
      "let rejected = false;",
      "let stageCompleted = false;",
      "try {",
      "  module.createStagedClosure(process.argv[4], process.argv[3], process.argv[5], {",
      "    beforeStageFileWrite: ({ sourceId }) => {",
      "      if (sourceId !== 'node_modules/tsx/dist/cli.mjs') return;",
      "      const path = process.argv[3] + '/node_modules/tsx/dist/cli.mjs';",
      "      renameSync(path, path + '.original');",
      "      writeFileSync(path, 'REPLACEMENT_MUST_NOT_BE_STAGED', { mode: 0o600 });",
      "    },",
      "    afterStageComplete: () => { stageCompleted = true; }",
      "  });",
      "} catch { rejected = true; }",
      "process.stdout.write(JSON.stringify({ rejected, stageCompleted }));"
    ].join("\n");
    const race = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      raceProbe,
      "bootstrap-race-probe",
      fixture.bootstrap,
      fixture.root,
      fixture.stateDirectory,
      fingerprint
    ], {
      cwd: fixture.root,
      encoding: "utf8",
      env: bootstrapEnvironment(),
      timeout: 120_000
    });
    expect(race.status).toBe(0);
    expect(JSON.parse(race.stdout)).toEqual({
      rejected: true,
      stageCompleted: false
    });
    expectBootstrapSentinels(fixture, emptyBootstrapSentinels);

    const repositoryRoot = realpathSync(resolve("."));
    const closeProbe = [
      "import { closeSync, readdirSync } from 'node:fs';",
      "import { pathToFileURL } from 'node:url';",
      "const module = await import(pathToFileURL(process.argv[2]).href);",
      "const before = readdirSync('/proc/self/fd').length;",
      "let injected = false;",
      "let rejected = false;",
      "try {",
      "  module.verifyDevelopmentDiagnosticStartupContract(process.argv[3], {",
      "    closeDescriptor: (descriptor) => {",
      "      if (!injected) { injected = true; throw new Error('injected close fault'); }",
      "      closeSync(descriptor);",
      "    }",
      "  });",
      "} catch { rejected = true; }",
      "const after = readdirSync('/proc/self/fd').length;",
      "process.stdout.write(JSON.stringify({ before, after, injected, rejected }));"
    ].join("\n");
    const closeFault = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      closeProbe,
      "bootstrap-close-probe",
      resolve(repositoryRoot, "scripts/development-diagnostic-bootstrap.mjs"),
      repositoryRoot
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: bootstrapEnvironment(),
      timeout: 120_000
    });
    expect(closeFault.status).toBe(0);
    const closeResult = JSON.parse(closeFault.stdout) as {
      readonly before: number;
      readonly after: number;
      readonly injected: boolean;
      readonly rejected: boolean;
    };
    expect(closeResult.injected).toBe(true);
    expect(closeResult.rejected).toBe(true);
    expect(closeResult.after).toBeLessThanOrEqual(closeResult.before);
  });

  it("spawns exactly one canonical state directory and preserves authorization arguments", () => {
    const fixture = createBootstrapFixture();
    const argvMarker = resolve(fixture.root, "child-argv.json");
    writeFileSync(
      resolve(fixture.root, "experiments/run-development-diagnostic.ts"),
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(argvMarker)}, JSON.stringify(process.argv.slice(2)));`,
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    approveBootstrapFixture(fixture);
    const authorization = digest("bootstrap-authorization");
    const launched = runBootstrap(fixture, [
      fixture.envFile,
      "--state-dir",
      fixture.stateDirectory,
      "--",
      "--authorize-plan",
      authorization
    ]);
    expect(launched.error).toBeUndefined();
    expect(launched.status, `${launched.stdout}\n${launched.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(argvMarker, "utf8"))).toEqual([
      "--state-dir",
      fixture.stateDirectory,
      "--authorize-plan",
      authorization
    ]);
    const sideEffects = JSON.parse(readFileSync(fixture.sentinelFile, "utf8")) as
      typeof emptyBootstrapSentinels;
    expect(sideEffects.fetch).toBe(0);
    expect(sideEffects.paid).toBe(0);

    for (const conflictingState of [
      fixture.stateDirectory,
      resolve(fixture.root, "conflicting-state")
    ]) {
      rmSync(argvMarker, { force: true });
      writePrivateJson(fixture.sentinelFile, emptyBootstrapSentinels);
      const rejected = runBootstrap(fixture, [
        fixture.envFile,
        "--state-dir",
        fixture.stateDirectory,
        "--",
        "--state-dir",
        conflictingState,
        "--authorize-plan",
        authorization
      ]);
      expect(rejected.status).toBe(1);
      expect(() => readFileSync(argvMarker)).toThrow();
      expectBootstrapSentinels(fixture, emptyBootstrapSentinels);
    }
  });


  it("executes only staged approved bytes after repository source, helper, and loader replacement", async () => {
    const fixture = createBootstrapFixture();
    const approvedMarker = resolve(fixture.root, "approved-staged-child.json");
    const untrustedMarker = resolve(fixture.root, "untrusted-repository-code-ran");
    writeFileSync(
      resolve(fixture.root, "experiments/run-development-diagnostic.ts"),
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(approvedMarker)}, JSON.stringify({ argv: process.argv.slice(2) }));`,
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    const fingerprint = approveBootstrapFixture(fixture);
    const stageProbe = [
      "import { writeFileSync } from 'node:fs';",
      "import { pathToFileURL } from 'node:url';",
      "const module = await import(pathToFileURL(process.argv[2]).href);",
      "const staged = module.createStagedClosure(process.argv[4], process.argv[3], process.argv[5], {",
      "  afterStageComplete: () => {",
      "    for (const relativePath of [",
      "      'experiments/run-development-diagnostic.ts',",
      "      'scripts/run-with-env.mjs',",
      "      'node_modules/tsx/dist/loader.mjs'",
      "    ]) {",
      `      writeFileSync(process.argv[3] + '/' + relativePath, ${JSON.stringify(
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(
          untrustedMarker
        )}, "ran"); throw new Error("untrusted replacement");\n`
      )}, { mode: 0o600 });`,
      "    }",
      "  }",
      "});",
      "process.stdout.write(JSON.stringify(staged));"
    ].join("\n");
    const stagedResult = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      stageProbe,
      "bootstrap-stage-boundary-probe",
      fixture.bootstrap,
      fixture.root,
      fixture.stateDirectory,
      fingerprint
    ], {
      cwd: fixture.root,
      encoding: "utf8",
      env: bootstrapEnvironment(),
      timeout: 120_000
    });
    expect(stagedResult.status, stagedResult.stderr).toBe(0);
    const staged = JSON.parse(stagedResult.stdout) as {
      readonly stageRoot: string;
      readonly stagedFingerprint: string;
    };
    expect(staged.stagedFingerprint).not.toBe(fingerprint);
    expect(lstatSync(staged.stageRoot).mode & 0o777).toBe(0o500);
    expect(
      lstatSync(resolve(
        staged.stageRoot,
        "scripts/development-diagnostic-bootstrap.mjs"
      )).mode & 0o777
    ).toBe(0o500);
    expect(
      lstatSync(resolve(
        staged.stageRoot,
        `node_modules/@esbuild/${process.platform}-${process.arch}/bin/esbuild`
      )).mode & 0o777
    ).toBe(0o500);
    const authorization = digest("post-stage-authorization");
    const privateRoots = [
      resolve(fixture.root, "private"),
      resolve(dirname(fixture.root), "Urmotiv/private")
    ];
    const startupContractFingerprint = hashCanonicalValue({
      approvedContractFingerprint: fingerprint,
      schemaVersion: 1,
      stagedContractFingerprint: staged.stagedFingerprint
    });
    const privateRootsAttestation = hashCanonicalValue({
      privateRoots,
      schemaVersion: 1,
      startupContractFingerprint
    });
    const stagedArguments = [
      resolve(staged.stageRoot, "scripts/development-diagnostic-bootstrap.mjs"),
      fixture.envFile,
      "--state-dir",
      fixture.stateDirectory,
      "--staged-contract",
      staged.stagedFingerprint,
      "--",
      "--authorize-plan",
      authorization
    ];
    const forgedAttestation = spawnSync(fixture.trustedNode, stagedArguments, {
      cwd: staged.stageRoot,
      encoding: "utf8",
      env: {
        ...bootstrapEnvironment(),
        FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS: JSON.stringify(privateRoots),
        FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS_ATTESTATION:
          digest("forged-private-roots-attestation")
      },
      timeout: 120_000
    });
    expect(forgedAttestation.status).toBe(1);
    expectBootstrapSentinels(fixture, emptyBootstrapSentinels);
    const executed = spawnSync(fixture.trustedNode, stagedArguments, {
      cwd: staged.stageRoot,
      encoding: "utf8",
      env: {
        ...bootstrapEnvironment(),
        FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS: JSON.stringify(privateRoots),
        FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS_ATTESTATION:
          privateRootsAttestation
      },
      timeout: 120_000
    });
    expect(executed.status, `${executed.stdout}\n${executed.stderr}`).toBe(0);
    expect(existsSync(untrustedMarker)).toBe(false);
    expect(JSON.parse(readFileSync(approvedMarker, "utf8"))).toEqual({
      argv: [
        "--state-dir",
        fixture.stateDirectory,
        "--authorize-plan",
        authorization
      ]
    });
    const counters = JSON.parse(readFileSync(fixture.sentinelFile, "utf8")) as
      typeof emptyBootstrapSentinels;
    expect(counters.fetch).toBe(0);
    expect(counters.paid).toBe(0);
    const bootstrapModule = await import(fixture.bootstrap);
    await bootstrapModule.cleanupStagedClosure(staged.stageRoot);
  });

  it("plans, authorizes, and completes standalone slot-02 through two real bootstrap children", () => {
    const fixture = createBootstrapFixture();
    const marker = resolve(fixture.root, "private/stable-stage-authorization.json");
    const manifestPath = resolve(
      fixture.root,
      "private/stable-stage-fixture/manifest.private.json"
    );
    mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
    writePrivateJson(manifestPath, {});
    writePrivateFile(fixture.envFile, [
      "AETHER_BASE_URL=http://provider-dispatch-must-not-occur.invalid",
      "AETHER_API_KEY=provider-dispatch-must-not-occur",
      `FERMATA_DEVELOPMENT_DIAGNOSTIC_MANIFEST=${manifestPath}`,
      ""
    ].join("\n"));
    const stableStageHarness = [
      "async function runStableStageAuthorizationHarness() {",
      "const { writeFileSync } = await import('node:fs');",
      `const marker = ${JSON.stringify(marker)};`,
      "const startupContractFingerprint =",
      "  process.env.FERMATA_DEVELOPMENT_DIAGNOSTIC_STARTUP_CONTRACT ?? '';",
      "let paid = false;",
      "const result = await runDevelopmentDiagnosticCli({",
      "  argv: process.argv.slice(2),",
      "  environment: process.env,",
      "  stdinIsTTY: false,",
      "  wrapperParentAttested: attestTrustedBootstrapParent(",
      "    startupContractFingerprint,",
      "    process.env.FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS_ATTESTATION ?? ''",
      "  ),",
      "  ownerIdentity: {",
      "    realUserId: process.getuid(),",
      "    effectiveUserId: process.geteuid(),",
      "    repositoryOwnerId: process.getuid()",
      "  },",
      "  codeFingerprint: startupContractFingerprint,",
      `  manifestFingerprint: ${JSON.stringify(digest("stable-stage-manifest"))},`,
      `  authorityFingerprint: ${JSON.stringify(digest("stable-stage-authority"))},`,
      "  configurationFingerprint: startupContractFingerprint,",
      "  writeOutput: () => undefined,",
      "  writeError: () => undefined,",
      "  readConfirmation: async () => '',",
      "  installSignalHandlers: () => () => undefined,",
      "  preflight: async () => ({",
      `    manifestFingerprint: ${JSON.stringify(digest("stable-stage-manifest"))},`,
      "    configurationFingerprint: startupContractFingerprint",
      "  }),",
      "  paidExecution: async (context) => {",
      "    paid = true;",
      "    context.registerSoftStop(() => undefined);",
      "    const roles = ['solver','solver','solution_analyst','technical_auditor','difficulty','editorial_judge','contest_fit','originality','tags','critic','adversary','adjudicator'];",
      "    let sequence = 0;",
      "    for (const role of roles) {",
      "      sequence += 1;",
      `      const modelFingerprint = ${JSON.stringify(digest("stable-stage-model"))};`,
      "      await context.lifecycleSink({ type: 'transport_intent', sequence, role, modelFingerprint, attempt: 1 });",
      "      await context.lifecycleSink({ type: 'transport_reserved', sequence, role, modelFingerprint, attempt: 1 });",
      "      await context.lifecycleSink({ type: 'transport_started', sequence });",
      "      await context.lifecycleSink({ type: 'transport_settled', sequence, outcome: 'succeeded', errorCategory: null });",
      "    }",
      "    for (const role of ['solver','solution_analyst','technical_auditor','difficulty','editorial_judge','contest_fit','originality','tags','critic','adversary','adjudicator']) {",
      "      await context.lifecycleSink({ type: 'role_completed', slot: 'slot-02', role });",
      "    }",
      "    for (const stage of ['A','B','C','D']) await context.lifecycleSink({ type: 'stage_completed', slot: 'slot-02', stage });",
      "    await context.lifecycleSink({ type: 'slot_outcome', slot: 'slot-02', status: 'complete' });",
      "    return { complete: true };",
      "  }",
      "});",
      "writeFileSync(marker, JSON.stringify({",
      "  code: result.code,",
      "  paid,",
      "  planFingerprint: result.planFingerprint ?? null,",
      "  stageRoot: process.cwd(),",
      "  startupContractFingerprint",
      "}));",
      "process.exitCode = result.exitCode;",
      "}",
      "if (isDirectEntry()) void runStableStageAuthorizationHarness();",
      ""
    ].join("\n");
    const childSource = readFileSync(
      resolve(fixture.root, "experiments/run-development-diagnostic.ts"),
      "utf8"
    ).replace(
      "if (isDirectEntry()) void runDirectEntry();",
      stableStageHarness
    );
    writeFileSync(
      resolve(fixture.root, "experiments/run-development-diagnostic.ts"),
      childSource,
      { mode: 0o600 }
    );
    approveBootstrapFixture(fixture);
    const plannedRunArguments = [
      "--slots", "slot-02",
      "--max-concurrency", "12",
      "--max-transport-attempts-per-request", "2",
      "--transport-attempt-ceiling", "16",
      "--phase-scheduling-budget-ms", "5400000",
      "--soft-stop-policy", "stop_new_and_drain_in_flight"
    ] as const;

    const planned = runBootstrap(fixture, [
      fixture.envFile,
      "--state-dir",
      fixture.stateDirectory,
      "--",
      ...plannedRunArguments
    ]);
    expect(planned.status, `${planned.stdout}\n${planned.stderr}`).toBe(2);
    const first = JSON.parse(readFileSync(marker, "utf8")) as {
      readonly code: string;
      readonly paid: boolean;
      readonly planFingerprint: string;
      readonly stageRoot: string;
      readonly startupContractFingerprint: string;
    };
    expect(first.code).toBe("PLAN_REQUIRES_AUTHORIZATION");
    expect(first.paid).toBe(false);
    expect(first.planFingerprint).toMatch(/^[a-f0-9]{64}$/u);

    const authorized = runBootstrap(fixture, [
      fixture.envFile,
      "--state-dir",
      fixture.stateDirectory,
      "--",
      ...plannedRunArguments,
      "--authorize-plan",
      first.planFingerprint
    ]);
    expect(authorized.status, `${authorized.stdout}\n${authorized.stderr}`).toBe(0);
    const second = JSON.parse(readFileSync(marker, "utf8")) as typeof first;
    expect(second.code).toBe("COMPLETE");
    expect(second.paid).toBe(true);
    expect(second.stageRoot).not.toBe(first.stageRoot);
    expect(second.startupContractFingerprint).toBe(
      first.startupContractFingerprint
    );
    expect(
      readdirSync(fixture.stateDirectory).filter(
        (name) => name.startsWith(".development-diagnostic-stage-")
      )
    ).toEqual([]);
    const completeState = JSON.parse(
      readFileSync(developmentDiagnosticRunStatePath(fixture.stateDirectory), "utf8")
    ) as {
      readonly phase: string;
      readonly identity: {
        readonly plannedRun: { readonly selectedSlots: readonly string[] };
      };
    };
    expect(completeState.phase).toBe("complete");
    expect(completeState.identity.plannedRun.selectedSlots).toEqual(["slot-02"]);
    expect(existsSync(developmentDiagnosticRunLockPath(fixture.stateDirectory))).toBe(false);
    const afterAuthorized = readFileSync(marker, "utf8");
    const counters = JSON.parse(readFileSync(fixture.sentinelFile, "utf8")) as
      typeof emptyBootstrapSentinels;
    expect(counters.helperLoad).toBeGreaterThan(0);
    expect(counters.envOpen).toBeGreaterThan(0);
    expect(counters.network).toBe(0);
    expect(counters.fetch).toBe(0);
    expect(counters.paid).toBe(0);

    writeFileSync(
      resolve(fixture.root, "experiments/run-development-diagnostic.ts"),
      `${childSource}\n// changed source identity\n`,
      { mode: 0o600 }
    );
    const changedSource = runBootstrap(fixture, [
      fixture.envFile,
      "--state-dir",
      fixture.stateDirectory,
      "--",
      ...plannedRunArguments,
      "--authorize-plan",
      first.planFingerprint
    ]);
    expect(changedSource.status).toBe(1);
    expect(readFileSync(marker, "utf8")).toBe(afterAuthorized);
    expect(JSON.parse(readFileSync(fixture.sentinelFile, "utf8"))).toEqual(
      counters
    );
  }, 120_000);

  it("allows only bound bootstrap attestations through the real child preflight", () => {
    const fixture = createBootstrapFixture();
    const smoke = createRealDevelopmentSmokeFixture(
      resolve(fixture.root, "private")
    );
    const marker = resolve(fixture.root, "preflight-environment.json");
    writePrivateFile(fixture.envFile, [
      "AETHER_BASE_URL=http://test-aether.invalid",
      "AETHER_API_KEY=test-key-not-real",
      `FERMATA_DEVELOPMENT_DIAGNOSTIC_MANIFEST=${smoke.manifestPath}`,
      ""
    ].join("\n"));
    writeFileSync(
      resolve(fixture.root, "experiments/run-development-diagnostic.ts"),
      [
        "import { writeFileSync } from 'node:fs';",
        "import { preflightDevelopmentDiagnostic } from './lib/development-smoke-launcher.ts';",
        `const marker = ${JSON.stringify(marker)};`,
        "const environment = { ...process.env };",
        "const startupContract = environment.FERMATA_DEVELOPMENT_DIAGNOSTIC_STARTUP_CONTRACT;",
        "const modeIndex = process.argv.indexOf('--environment-case');",
        "const mode = modeIndex < 0 ? 'trusted' : process.argv[modeIndex + 1];",
        "if (mode === 'unknown') environment.FERMATA_UNKNOWN_ATTESTATION = 'forged';",
        `if (mode === 'manifest') environment.FERMATA_DEVELOPMENT_DIAGNOSTIC_MANIFEST = ${JSON.stringify(
          resolve(smoke.rootDir, "forged-manifest.json")
        )};`,
        `if (mode === 'contract') environment.FERMATA_DEVELOPMENT_DIAGNOSTIC_STARTUP_CONTRACT = ${JSON.stringify(
          digest("forged-startup-contract")
        )};`,
        `if (mode === 'private-root') environment.FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS = ${JSON.stringify(
          JSON.stringify([resolve(fixture.root, "forged-private-root")])
        )};`,
        `if (mode === 'private-attestation') environment.FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS_ATTESTATION = ${JSON.stringify(
          digest("forged-private-root-attestation")
        )};`,
        "let fetchCalls = 0;",
        "globalThis.fetch = async () => { fetchCalls += 1; throw new Error('provider dispatch forbidden'); };",
        "try {",
        "  const preflight = preflightDevelopmentDiagnostic({",
        `    repositoryRoot: ${JSON.stringify(smoke.repositoryRoot)},`,
        `    projectRoot: ${JSON.stringify(smoke.repositoryRoot)},`,
        `    manifestPath: ${JSON.stringify(smoke.manifestPath)},`,
        `    codeVersion: ${JSON.stringify(digest("bootstrap-preflight-code").slice(0, 40))},`,
        "    env: environment,",
        `    modelsYamlSource: ${JSON.stringify(smoke.modelsYamlSource)},`,
        "    paidExecutionSourceContractFingerprint: startupContract,",
        "    difficultyAnchorsOverride: [{ contestId: 1, index: 'A', rating: 1200, summary: 'offline fixture anchor' }],",
        "    allowedPrivateRoots: JSON.parse(environment.FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS ?? '[]')",
        "  });",
        "  writeFileSync(marker, JSON.stringify({ ok: true, cases: preflight.cases.length, fetchCalls }));",
        "} catch (error) {",
        "  writeFileSync(marker, JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'unknown', fetchCalls }));",
        "}",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    approveBootstrapFixture(fixture);
    const cases = [
      ["trusted", true, undefined],
      ["unknown", false, "DEVELOPMENT_DIAGNOSTIC_ENVIRONMENT_NOT_NARROW"],
      ["manifest", false, "DEVELOPMENT_DIAGNOSTIC_BOOTSTRAP_ATTESTATION_INVALID"],
      ["contract", false, "DEVELOPMENT_DIAGNOSTIC_BOOTSTRAP_ATTESTATION_INVALID"],
      ["private-root", false, "DEVELOPMENT_DIAGNOSTIC_BOOTSTRAP_ATTESTATION_INVALID"],
      ["private-attestation", false, "DEVELOPMENT_DIAGNOSTIC_BOOTSTRAP_ATTESTATION_INVALID"]
    ] as const;
    for (const [mode, ok, error] of cases) {
      rmSync(marker, { force: true });
      const result = runBootstrap(fixture, [
        fixture.envFile,
        "--state-dir",
        fixture.stateDirectory,
        "--",
        "--environment-case",
        mode
      ]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const observed = JSON.parse(readFileSync(marker, "utf8")) as {
        readonly ok: boolean;
        readonly cases?: number;
        readonly error?: string;
        readonly fetchCalls: number;
      };
      expect(observed.ok, JSON.stringify(observed)).toBe(ok);
      expect(observed.fetchCalls).toBe(0);
      if (ok) {
        expect(observed.cases).toBe(2);
      } else {
        expect(observed.error).toBe(error);
      }
      const counters = JSON.parse(readFileSync(fixture.sentinelFile, "utf8")) as
        typeof emptyBootstrapSentinels;
      expect(counters.fetch).toBe(0);
      expect(counters.paid).toBe(0);
    }
  });
  it("attests the real bootstrap parent and rejects wrong digest and forged basename parents", () => {
    const fixture = createBootstrapFixture();
    const attestationMarker = resolve(fixture.root, "parent-attestation.json");
    const cliPath = resolve(fixture.root, "experiments/run-development-diagnostic.ts");
    const cliSource = readFileSync(cliPath, "utf8");
    writeFileSync(
      cliPath,
      `import { writeFileSync as __writeAttestation } from "node:fs";\n${cliSource.replace(
        "if (isDirectEntry()) void runDirectEntry();",
        [
          "if (isDirectEntry()) {",
          `  __writeAttestation(${JSON.stringify(attestationMarker)}, JSON.stringify({`,
          "    attested: attestTrustedBootstrapParent(",
          "      process.env.FERMATA_DEVELOPMENT_DIAGNOSTIC_STARTUP_CONTRACT ?? \"\",",
          "      process.env.FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS_ATTESTATION ?? \"\"",
          "    )",
          "  }));",
          "  void runDirectEntry();",
          "}"
        ].join("\n")
      )}`,
      { mode: 0o600 }
    );
    const fingerprint = approveBootstrapFixture(fixture);
    const trusted = runBootstrap(fixture, [
      fixture.envFile,
      "--state-dir",
      fixture.stateDirectory
    ]);
    expect(trusted.status, `${trusted.stdout}\n${trusted.stderr}`).toBe(1);
    expect(
      existsSync(attestationMarker),
      `${trusted.stdout}\n${trusted.stderr}`
    ).toBe(true);
    expect(JSON.parse(readFileSync(attestationMarker, "utf8"))).toEqual({
      attested: true
    });
    let counters = JSON.parse(readFileSync(fixture.sentinelFile, "utf8")) as
      typeof emptyBootstrapSentinels;
    expect(counters.fetch).toBe(0);
    expect(counters.paid).toBe(0);

    rmSync(attestationMarker);
    writePrivateFile(fixture.wrongDigestTrigger, "trigger\n");
    const wrongDigest = runBootstrap(fixture, [
      fixture.envFile,
      "--state-dir",
      fixture.stateDirectory
    ]);
    expect(wrongDigest.status).toBe(1);
    expect(JSON.parse(readFileSync(attestationMarker, "utf8"))).toEqual({
      attested: false
    });
    counters = JSON.parse(readFileSync(fixture.sentinelFile, "utf8")) as
      typeof emptyBootstrapSentinels;
    expect(counters.fetch).toBe(0);
    expect(counters.paid).toBe(0);

    rmSync(attestationMarker);
    rmSync(fixture.wrongDigestTrigger);
    writePrivateJson(
      resolve(
        fixture.stateDirectory,
        "development-diagnostic-bootstrap-contract.json"
      ),
      { schemaVersion: 1, contractFingerprint: fingerprint }
    );
    const forgedDirectory = resolve(fixture.root, "forged-parent");
    mkdirSync(forgedDirectory, { mode: 0o700 });
    const forgedParent = resolve(
      forgedDirectory,
      "development-diagnostic-bootstrap.mjs"
    );
    writeFileSync(forgedParent, [
      "import { spawnSync } from 'node:child_process';",
      "const result = spawnSync(process.execPath, [",
      `  ${JSON.stringify(resolve(fixture.root, "node_modules/tsx/dist/cli.mjs"))},`,
      "  '--tsconfig',",
      `  ${JSON.stringify(resolve(fixture.root, "tsconfig.json"))},`,
      `  ${JSON.stringify(cliPath)},`,
      "  '--state-dir',",
      `  ${JSON.stringify(fixture.stateDirectory)}`,
      "], {",
      `  cwd: ${JSON.stringify(fixture.root)},`,
      "  env: {",

      "    ...process.env,",
      "    FERMATA_RUN_WITH_ENV: '1',",
      `    FERMATA_DEVELOPMENT_DIAGNOSTIC_STARTUP_CONTRACT: ${JSON.stringify(fingerprint)}`,
      "  },",
      "  stdio: 'inherit'",
      "});",
      "process.exitCode = result.status ?? 1;",
      ""
    ].join("\n"), { mode: 0o600 });
    const forged = spawnSync(process.execPath, [forgedParent], {
      cwd: fixture.root,
      encoding: "utf8",
      env: bootstrapEnvironment(),
      timeout: 120_000
    });
    expect(forged.status).toBe(1);
    expect(JSON.parse(readFileSync(attestationMarker, "utf8"))).toEqual({
      attested: false
    });
    counters = JSON.parse(readFileSync(fixture.sentinelFile, "utf8")) as
      typeof emptyBootstrapSentinels;
    expect(counters.fetch).toBe(0);
    expect(counters.paid).toBe(0);
  });
  it("runs the unchanged staged CLI through real preflight with original private roots and staged anchors without provider dispatch", () => {
    const repositoryRoot = realpathSync(resolve("."));
    const stateDirectory = mkdtempSync(resolve(
      repositoryRoot,
      ".unchanged-bootstrap-state-"
    ));
    chmodSync(stateDirectory, 0o700);
    fixtureRoots.push(stateDirectory);
    const envDirectory = mkdtempSync(resolve(
      repositoryRoot,
      "private/.unchanged-bootstrap-env-"
    ));
    chmodSync(envDirectory, 0o700);
    fixtureRoots.push(envDirectory);
    const envFile = resolve(envDirectory, "diagnostic.env");
    writePrivateFile(envFile, [
      "AETHER_BASE_URL=http://127.0.0.1:1",
      "AETHER_API_KEY=provider-dispatch-must-not-occur",
      `FERMATA_DEVELOPMENT_DIAGNOSTIC_MANIFEST=${resolve(
        repositoryRoot,
        "private/development-smoke-6x4-v1/manifest.private.json"
      )}`,
      ""
    ].join("\n"));
    const trustedNodeDirectory = resolve(stateDirectory, "trusted-node");
    mkdirSync(trustedNodeDirectory, { mode: 0o700 });
    const trustedNode = resolve(trustedNodeDirectory, "node");
    linkSync(process.execPath, trustedNode);
    const bootstrap = resolve(
      repositoryRoot,
      "scripts/development-diagnostic-bootstrap.mjs"
    );
    const fixture: BootstrapFixture = {
      root: repositoryRoot,
      bootstrap,
      trustedNode,
      stateDirectory,
      envFile,
      sentinelFile: resolve(envDirectory, "unused-sentinel.json"),
      wrongDigestTrigger: resolve(envDirectory, "unused-trigger")
    };
    const printed = runBootstrap(fixture, [
      "--print-contract",
      "--state-dir",
      stateDirectory
    ]);
    expect(printed.status, `${printed.stdout}\n${printed.stderr}`).toBe(0);
    const contract = JSON.parse(printed.stdout.trim()) as {
      readonly contractFingerprint: string;
    };
    const approved = runBootstrap(fixture, [
      envFile,
      "--approve-contract",
      contract.contractFingerprint,
      "--state-dir",
      stateDirectory
    ]);
    expect(approved.status, `${approved.stdout}\n${approved.stderr}`).toBe(0);
    const launched = runBootstrap(fixture, [
      envFile,
      "--state-dir",
      stateDirectory
    ]);
    expect(launched.status, `${launched.stdout}\n${launched.stderr}`).toBe(2);
    expect(launched.stdout).toContain("\"expectedFetches\":24");
    expect(launched.stderr).toContain("PLAN_REQUIRES_AUTHORIZATION");
    expect(readdirSync(stateDirectory).filter(
      (name) => name.startsWith(".development-diagnostic-stage-")
    )).toEqual([]);
  });
});


/* ═══════════════════════════════════════════════════════════════
 * 4. Real filesystem preflight via public launcher API
 * ═══════════════════════════════════════════════════════════════ */

describe("createRealDevelopmentSmokeFixture — public preflight", () => {
  it("creates 6 source/frozen-manifest/truth/difficulty/prior-failure bindings and passes public preflight", () => {
    const fixture = createRealDevelopmentSmokeFixture();
    const preflight = preflightDevelopmentDiagnostic({
      repositoryRoot: fixture.repositoryRoot,
      projectRoot: fixture.repositoryRoot,
      manifestPath: fixture.manifestPath,
      codeVersion: randomBytes(20).toString("hex"),
      env: fixture.env,
      modelsYamlSource: fixture.modelsYamlSource,
      paidExecutionSourceContractFingerprint:
        fixture.paidExecutionSourceContractFingerprint,
      allowedPrivateRoots: [fixture.rootDir]
    });
    expect(preflight.manifestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(preflight.cases).toHaveLength(2);
    expect(preflight.cases[0]!.slot).toBe("slot-01");
    expect(preflight.cases[1]!.slot).toBe("slot-02");
    expect(preflight.includedInFinalCalibration).toBe(false);
    expect(preflight.phase1Concept).toBe(false);
  });

  it("computes the formal source contract from the explicit repository set and fails closed when files are unavailable", () => {
    const fixture = createRealDevelopmentSmokeFixture();
    const formal = preflightDevelopmentDiagnostic({
      repositoryRoot: realpathSync(resolve(".")),
      projectRoot: fixture.repositoryRoot,
      manifestPath: fixture.manifestPath,
      codeVersion: randomBytes(20).toString("hex"),
      env: fixture.env,
      modelsYamlSource: fixture.modelsYamlSource,
      allowedPrivateRoots: [fixture.rootDir]
    });
    expect(formal.paidExecutionContractFingerprint).toMatch(/^[a-f0-9]{64}$/);

    expect(() => preflightDevelopmentDiagnostic({
      repositoryRoot: fixture.repositoryRoot,
      projectRoot: fixture.repositoryRoot,
      manifestPath: fixture.manifestPath,
      codeVersion: randomBytes(20).toString("hex"),
      env: fixture.env,
      modelsYamlSource: fixture.modelsYamlSource,
      allowedPrivateRoots: [fixture.rootDir]
    })).toThrow("DEVELOPMENT_DIAGNOSTIC_SOURCE_CONTRACT_UNAVAILABLE");
  });

  it("rejects a symlinked formal source tree without publishing contract details", () => {
    const fixture = createRealDevelopmentSmokeFixture();
    const target = resolve(fixture.rootDir, "source-target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, resolve(fixture.rootDir, "src"), "dir");

    expect(() => preflightDevelopmentDiagnostic({
      repositoryRoot: fixture.repositoryRoot,
      projectRoot: fixture.repositoryRoot,
      manifestPath: fixture.manifestPath,
      codeVersion: randomBytes(20).toString("hex"),
      env: fixture.env,
      modelsYamlSource: fixture.modelsYamlSource,
      allowedPrivateRoots: [fixture.rootDir]
    })).toThrow("DEVELOPMENT_DIAGNOSTIC_SOURCE_CONTRACT_UNAVAILABLE");
  });

  it("rejects a directory swap through verified descriptor traversal before reading replacement bytes", () => {
    const fixture = createRealDevelopmentSmokeFixture();
    materializePaidExecutionSourceFixture(fixture);
    const replacementMarker = "PRIVATE_DIRECTORY_REPLACEMENT_MUST_NOT_BE_READ";
    const readSourceIds: string[] = [];
    let swapped = false;
    let captured: unknown;
    try {
      preflightDevelopmentDiagnostic({
        repositoryRoot: fixture.repositoryRoot,
        projectRoot: fixture.repositoryRoot,
        manifestPath: fixture.manifestPath,
        codeVersion: randomBytes(20).toString("hex"),
        env: fixture.env,
        modelsYamlSource: fixture.modelsYamlSource,
        allowedPrivateRoots: [fixture.rootDir],
        paidExecutionSourceContractFilesystemHooks: {
          beforeDirectoryRead: ({ sourceId }) => {
            if (sourceId !== "src" || swapped) return;
            swapped = true;
            renameSync(
              resolve(fixture.repositoryRoot, "src"),
              resolve(fixture.repositoryRoot, "src-original")
            );
            mkdirSync(resolve(fixture.repositoryRoot, "src"), { mode: 0o700 });
            writeFileSync(
              resolve(fixture.repositoryRoot, "src/private.ts"),
              replacementMarker,
              { mode: 0o600 }
            );
          },
          afterFileRead: ({ sourceId }) => readSourceIds.push(sourceId)
        }
      });
    } catch (error) {
      captured = error;
    }

    expect(swapped).toBe(true);
    expect(captured).toEqual(new Error(
      "DEVELOPMENT_DIAGNOSTIC_SOURCE_CONTRACT_UNAVAILABLE"
    ));
    expect(readSourceIds).not.toContain("src/private.ts");
    expect(String(captured)).not.toContain(replacementMarker);
    expect(String(captured)).not.toContain(fixture.repositoryRoot);
  });

  it("rejects a file swap before reading replacement bytes or publishing its identity", () => {
    const fixture = createRealDevelopmentSmokeFixture();
    materializePaidExecutionSourceFixture(fixture);
    const replacementMarker = "PRIVATE_FILE_REPLACEMENT_MUST_NOT_BE_READ";
    const readSourceIds: string[] = [];
    let swapped = false;
    let captured: unknown;
    try {
      preflightDevelopmentDiagnostic({
        repositoryRoot: fixture.repositoryRoot,
        projectRoot: fixture.repositoryRoot,
        manifestPath: fixture.manifestPath,
        codeVersion: randomBytes(20).toString("hex"),
        env: fixture.env,
        modelsYamlSource: fixture.modelsYamlSource,
        allowedPrivateRoots: [fixture.rootDir],
        paidExecutionSourceContractFilesystemHooks: {
          beforeFileRead: ({ sourceId }) => {
            if (sourceId !== "scripts/env-file.mjs" || swapped) return;
            swapped = true;
            renameSync(
              resolve(fixture.repositoryRoot, sourceId),
              resolve(fixture.repositoryRoot, "scripts/env-file.original.mjs")
            );
            writeFileSync(
              resolve(fixture.repositoryRoot, sourceId),
              replacementMarker,
              { mode: 0o600 }
            );
          },
          afterFileRead: ({ sourceId }) => readSourceIds.push(sourceId)
        }
      });
    } catch (error) {
      captured = error;
    }

    expect(swapped).toBe(true);
    expect(captured).toEqual(new Error(
      "DEVELOPMENT_DIAGNOSTIC_SOURCE_CONTRACT_UNAVAILABLE"
    ));
    expect(readSourceIds).not.toContain("scripts/env-file.mjs");
    expect(String(captured)).not.toContain(replacementMarker);
    expect(String(captured)).not.toContain(fixture.repositoryRoot);
  });

  it("binds both wrapper helpers and only the relevant package execution contract", () => {
    const fixture = createRealDevelopmentSmokeFixture();
    materializePaidExecutionSourceFixture(fixture);
    const readSourceIds: string[] = [];
    const preflight = () => preflightDevelopmentDiagnostic({
      repositoryRoot: fixture.repositoryRoot,
      projectRoot: fixture.repositoryRoot,
      manifestPath: fixture.manifestPath,
      codeVersion: randomBytes(20).toString("hex"),
      env: fixture.env,
      modelsYamlSource: fixture.modelsYamlSource,
      allowedPrivateRoots: [fixture.rootDir],
      paidExecutionSourceContractFilesystemHooks: {
        afterFileRead: ({ sourceId }) => readSourceIds.push(sourceId)
      }
    });
    const baseline = preflight();
    expect(readSourceIds).toEqual(expect.arrayContaining([
      "scripts/env-file.mjs",
      "scripts/private-runtime.mjs",
      "package.json"
    ]));
    writeFileSync(
      resolve(fixture.repositoryRoot, "scripts/env-file.mjs"),
      "export const driftedEnvHelper = true;\n",
      { mode: 0o600 }
    );
    expect(preflight().paidExecutionContractFingerprint).not.toBe(
      baseline.paidExecutionContractFingerprint
    );
    materializePaidExecutionSourceFixture(fixture);
    writeFileSync(
      resolve(fixture.repositoryRoot, "scripts/private-runtime.mjs"),
      "export const driftedPrivateRuntime = true;\n",
      { mode: 0o600 }
    );
    expect(preflight().paidExecutionContractFingerprint).not.toBe(
      baseline.paidExecutionContractFingerprint
    );
    materializePaidExecutionSourceFixture(fixture);
    writeFileSync(
      resolve(fixture.repositoryRoot, "package.json"),
      JSON.stringify({
        version: "unrelated-metadata-drift",
        type: "module",
        engines: { node: ">=24" },
        scripts: {
          "diagnostic:development":
            "node scripts/development-diagnostic-bootstrap.mjs"
        }
      }),
      { mode: 0o600 }
    );
    const unrelatedMetadata = preflight();
    expect(unrelatedMetadata.paidExecutionContractFingerprint).toBe(
      baseline.paidExecutionContractFingerprint
    );
    writeFileSync(
      resolve(fixture.repositoryRoot, "package.json"),
      JSON.stringify({
        type: "module",
        engines: { node: ">=24" },
        scripts: {
          "diagnostic:development":
            "node scripts/development-diagnostic-bootstrap.mjs --drift"
        }
      }),
      { mode: 0o600 }
    );
    const entryDrift = preflight();
    expect(entryDrift.paidExecutionContractFingerprint).not.toBe(
      baseline.paidExecutionContractFingerprint
    );
  });

  it.each([
    [
      "model parameters",
      (fixture: RealSmokeFixture) => ({
        env: fixture.env,
        modelsYamlSource: fixture.modelsYamlSource.replace(
          "    reviewFlow:\n      solver:\n        provider: aether\n        model: deepseek-v4-pro\n        temperature: 0.4",
          "    reviewFlow:\n      solver:\n        provider: aether\n        model: deepseek-v4-pro\n        temperature: 0.5"
        ),
        paidExecutionSourceContractFingerprint:
          fixture.paidExecutionSourceContractFingerprint,
        difficultyAnchorsOverride: undefined
      })
    ],
    [
      "base URL",
      (fixture: RealSmokeFixture) => ({
        env: { ...fixture.env, AETHER_BASE_URL: "http://drift-aether.invalid" },
        modelsYamlSource: fixture.modelsYamlSource,
        paidExecutionSourceContractFingerprint:
          fixture.paidExecutionSourceContractFingerprint,
        difficultyAnchorsOverride: undefined
      })
    ],
    [
      "API key identity",
      (fixture: RealSmokeFixture) => ({
        env: {
          ...fixture.env,
          AETHER_API_KEY: "credential-drift-secret-never-persist"
        },
        modelsYamlSource: fixture.modelsYamlSource,
        paidExecutionSourceContractFingerprint:
          fixture.paidExecutionSourceContractFingerprint,
        difficultyAnchorsOverride: undefined
      })
    ],
    [
      "proxy route",
      (fixture: RealSmokeFixture) => ({
        env: {
          ...fixture.env,
          HTTP_PROXY:
            "http://route-user:route-pass@proxy-route.invalid:8080"
        },
        modelsYamlSource: fixture.modelsYamlSource,
        paidExecutionSourceContractFingerprint:
          fixture.paidExecutionSourceContractFingerprint,
        difficultyAnchorsOverride: undefined
      })
    ],
    [
      "proxy credential",
      (fixture: RealSmokeFixture) => ({
        env: {
          ...fixture.env,
          HTTPS_PROXY:
            "http://credential-user:credential-pass@proxy-credential.invalid:8443"
        },
        modelsYamlSource: fixture.modelsYamlSource,
        paidExecutionSourceContractFingerprint:
          fixture.paidExecutionSourceContractFingerprint,
        difficultyAnchorsOverride: undefined
      })
    ],
    [
      "NO_PROXY routing",
      (fixture: RealSmokeFixture) => ({
        env: {
          ...fixture.env,
          NO_PROXY: "provider-route-secret.invalid,.internal-route.invalid:443"
        },
        modelsYamlSource: fixture.modelsYamlSource,
        paidExecutionSourceContractFingerprint:
          fixture.paidExecutionSourceContractFingerprint,
        difficultyAnchorsOverride: undefined
      })
    ],
    [
      "proxy case conflict",
      (fixture: RealSmokeFixture) => ({
        env: {
          ...fixture.env,
          HTTP_PROXY: "http://shadowed-uppercase.invalid:8080",
          http_proxy:
            "http://selected-user:selected-pass@selected-lowercase.invalid:8081"
        },
        modelsYamlSource: fixture.modelsYamlSource,
        paidExecutionSourceContractFingerprint:
          fixture.paidExecutionSourceContractFingerprint,
        difficultyAnchorsOverride: undefined
      })
    ],
    [
      "timeout",
      (fixture: RealSmokeFixture) => ({
        env: fixture.env,
        modelsYamlSource: fixture.modelsYamlSource.replace(
          "llmFirstOutputMs: 600000",
          "llmFirstOutputMs: 600001"
        ),
        paidExecutionSourceContractFingerprint:
          fixture.paidExecutionSourceContractFingerprint,
        difficultyAnchorsOverride: undefined
      })
    ],
    [
      "omitted src-tree dependency snapshot",
      (fixture: RealSmokeFixture) => ({
        env: fixture.env,
        modelsYamlSource: fixture.modelsYamlSource,
        paidExecutionSourceContractFingerprint: digest("drifted-paid-source-contract"),
        difficultyAnchorsOverride: undefined
      })
    ],
    [
      "scripts/env-file helper snapshot",
      (fixture: RealSmokeFixture) => ({
        env: fixture.env,
        modelsYamlSource: fixture.modelsYamlSource,
        paidExecutionSourceContractFingerprint: digest("drifted-env-file-helper"),
        difficultyAnchorsOverride: undefined
      })
    ],
    [
      "scripts/private-runtime helper snapshot",
      (fixture: RealSmokeFixture) => ({
        env: fixture.env,
        modelsYamlSource: fixture.modelsYamlSource,
        paidExecutionSourceContractFingerprint: digest("drifted-private-runtime-helper"),
        difficultyAnchorsOverride: undefined
      })
    ],
    [
      "package diagnostic entry contract",
      (fixture: RealSmokeFixture) => ({
        env: fixture.env,
        modelsYamlSource: fixture.modelsYamlSource,
        paidExecutionSourceContractFingerprint: digest("drifted-package-entry"),
        difficultyAnchorsOverride: undefined
      })
    ],
    [
      "duplicate threshold",
      (fixture: RealSmokeFixture) => ({
        env: fixture.env,
        modelsYamlSource: fixture.modelsYamlSource.replace(
          "duplicateSimilarityReject: 0.9",
          "duplicateSimilarityReject: 0.91"
        ),
        paidExecutionSourceContractFingerprint:
          fixture.paidExecutionSourceContractFingerprint,
        difficultyAnchorsOverride: undefined
      })
    ],
    [
      "difficulty anchors",
      (fixture: RealSmokeFixture) => ({
        env: fixture.env,
        modelsYamlSource: fixture.modelsYamlSource,
        paidExecutionSourceContractFingerprint:
          fixture.paidExecutionSourceContractFingerprint,
        difficultyAnchorsOverride: [{
          contestId: 99_999,
          index: "Z",
          rating: 2_600,
          summary: "Synthetic drift anchor"
        }]
      })
    ]
  ] as const)(
    "real preflight binds %s drift into authorization before provider dispatch",
    async (_label, drift) => {
      const fixture = createRealDevelopmentSmokeFixture();
      const codeFingerprint = digest("configuration-drift-code");
      const original = preflightDevelopmentDiagnostic({
        repositoryRoot: fixture.repositoryRoot,
        projectRoot: fixture.repositoryRoot,
        manifestPath: fixture.manifestPath,
        codeVersion: codeFingerprint.slice(0, 40),
        env: fixture.env,
        modelsYamlSource: fixture.modelsYamlSource,
        paidExecutionSourceContractFingerprint:
          fixture.paidExecutionSourceContractFingerprint,
        allowedPrivateRoots: [fixture.rootDir]
      });
      const changedConfiguration = drift(fixture);
      const changed = preflightDevelopmentDiagnostic({
        repositoryRoot: fixture.repositoryRoot,
        projectRoot: fixture.repositoryRoot,
        manifestPath: fixture.manifestPath,
        codeVersion: codeFingerprint.slice(0, 40),
        env: (() => {
          const startupContractFingerprint =
            changedConfiguration.paidExecutionSourceContractFingerprint;
          return {
            ...changedConfiguration.env,
            FERMATA_DEVELOPMENT_DIAGNOSTIC_STARTUP_CONTRACT:
              startupContractFingerprint,
            FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS_ATTESTATION:
              hashCanonicalValue({
                privateRoots: [fixture.rootDir],
                schemaVersion: 1,
                startupContractFingerprint
              })
          };
        })(),
        modelsYamlSource: changedConfiguration.modelsYamlSource,
        paidExecutionSourceContractFingerprint:
          changedConfiguration.paidExecutionSourceContractFingerprint,
        ...(changedConfiguration.difficultyAnchorsOverride === undefined
          ? {}
          : {
              difficultyAnchorsOverride:
                changedConfiguration.difficultyAnchorsOverride
            }),
        allowedPrivateRoots: [fixture.rootDir]
      });
      const originalConfigurationFingerprint =
        developmentDiagnosticPreflightConfigurationFingerprint(original);
      const changedConfigurationFingerprint =
        developmentDiagnosticPreflightConfigurationFingerprint(changed);
      expect(changedConfigurationFingerprint).not.toBe(originalConfigurationFingerprint);
      expect(changed.manifestFingerprint).toBe(original.manifestFingerprint);
      const stateDirectory = resolve(fixture.rootDir, "authorization-state");
      const output: string[] = [];
      let fetchCalls = 0;
      const errors: string[] = [];
      let paidCalls = 0;
      vi.stubGlobal("fetch", async () => {
        fetchCalls += 1;
        throw new Error("poison fetch");
      });
      const runtime = (
        preflight: DevelopmentDiagnosticPreflight,
        argv: readonly string[]
      ): DevelopmentDiagnosticCliRuntime => ({
        argv,
        environment: { FERMATA_RUN_WITH_ENV: "1" },
        stdinIsTTY: false,
        ownerIdentity: {
          realUserId: process.getuid!(),
          effectiveUserId: process.geteuid!(),
          repositoryOwnerId: process.getuid!()
        },
        codeFingerprint,
        manifestFingerprint: preflight.manifestFingerprint,
        authorityFingerprint: digest("configuration-drift-authority"),
        configurationFingerprint:
          developmentDiagnosticPreflightConfigurationFingerprint(preflight),
        wrapperParentAttested: true,
        writeOutput: (text) => output.push(text),
        writeError: (text) => errors.push(text),
        readConfirmation: async () => "",
        installSignalHandlers: () => () => undefined,
        preflight: async () => ({
          manifestFingerprint: preflight.manifestFingerprint,
          configurationFingerprint:
            developmentDiagnosticPreflightConfigurationFingerprint(preflight)
        }),
        paidExecution: async () => {
          paidCalls += 1;
          return { complete: false };
        }
      });
      const planned = await runDevelopmentDiagnosticCli(runtime(original, [
        "--state-dir",
        stateDirectory
      ]));
      expect(planned.code).toBe("PLAN_REQUIRES_AUTHORIZATION");
      const oldPlanFingerprint = planned.planFingerprint!;
      output.length = 0;

      expect(await runDevelopmentDiagnosticCli(runtime(changed, [
        "--state-dir",
        stateDirectory,
        "--authorize-plan",
        oldPlanFingerprint
      ]))).toEqual({ exitCode: 1, code: "SAFE_FAILURE" });
      expect(output).toHaveLength(0);
      expect(paidCalls).toBe(0);
      expect(fetchCalls).toBe(0);
      const persistedSource = readFileSync(
        developmentDiagnosticRunStatePath(stateDirectory),
        "utf8"
      );
      const persisted = JSON.parse(persistedSource) as {
        readonly identity: { readonly configurationFingerprint: string };
      };
      expect(persisted.identity.configurationFingerprint).toBe(
        originalConfigurationFingerprint
      );
      const persistedArtifacts = readdirSync(stateDirectory, {
        recursive: true,
        withFileTypes: true
      })
        .filter((entry) => entry.isFile())
        .map((entry) =>
          readFileSync(resolve(entry.parentPath, entry.name), "utf8"))
        .join("");
      const privacySurfaces = [
        persistedArtifacts,
        output.join(""),
        errors.join("")
      ];
      const proxyVariables = [
        "http_proxy",
        "HTTP_PROXY",
        "https_proxy",
        "HTTPS_PROXY",
        "no_proxy",
        "NO_PROXY"
      ] as const;
      const privateFragments = new Set<string>([
        fixture.env.AETHER_API_KEY!,
        ...("AETHER_API_KEY" in changedConfiguration.env
          ? [changedConfiguration.env.AETHER_API_KEY!]
          : []),
        ...proxyVariables.flatMap((name) => {
          const value = (
            changedConfiguration.env as Record<string, string | undefined>
          )[name];
          if (value === undefined) return [];
          const fragments = [value];
          try {
            const url = new URL(value);
            fragments.push(url.hostname, url.username, url.password);
          } catch {
            fragments.push(...value.split(/[,\s]/u));
          }
          return fragments;
        })
      ]);
      for (const secret of privateFragments) {
        if (secret.length < 8) continue;
        for (const surface of privacySurfaces) {
          expect(surface).not.toContain(secret);
          expect(surface).not.toContain(secret.slice(0, Math.min(12, secret.length)));
        }
      }
      expect(persistedSource).not.toContain("test-aether.invalid");
      expect(persistedSource).not.toContain("src/llm.ts");
      expect(persistedSource).not.toContain("Synthetic drift anchor");
      expect(persistedSource).not.toContain("duplicateSimilarityReject");
    }
  );

  it("real preflight accepts an old plan for the same credential and canonical proxy environment", async () => {
    const fixture = createRealDevelopmentSmokeFixture();
    const codeFingerprint = digest("configuration-stable-code");
    const canonicalProxyEnv = {
      ...fixture.env,
      ALL_PROXY: "http://ignored-all-proxy-one.invalid",
      HTTP_PROXY: "http://shadowed-proxy-one.invalid",
      NO_PROXY: "EXAMPLE.INVALID,.internal.invalid:443",
      http_proxy:
        "http://canonical-user:canonical-pass@canonical-proxy.invalid:8080"
    };
    const equivalentCanonicalProxyEnv = {
      ...fixture.env,
      ALL_PROXY: "http://ignored-all-proxy-two.invalid",
      HTTP_PROXY: "http://shadowed-proxy-two.invalid",
      http_proxy:
        "http://canonical-user:canonical-pass@canonical-proxy.invalid:8080",
      no_proxy: "*.INTERNAL.INVALID:443 example.invalid"
    };
    const canonicalProxyPreflight = preflightDevelopmentDiagnostic({
      repositoryRoot: fixture.repositoryRoot,
      projectRoot: fixture.repositoryRoot,
      manifestPath: fixture.manifestPath,
      codeVersion: codeFingerprint.slice(0, 40),
      env: canonicalProxyEnv,
      modelsYamlSource: fixture.modelsYamlSource,
      paidExecutionSourceContractFingerprint:
        fixture.paidExecutionSourceContractFingerprint,
      allowedPrivateRoots: [fixture.rootDir]
    });
    const equivalentProxyPreflight = preflightDevelopmentDiagnostic({
      repositoryRoot: fixture.repositoryRoot,
      projectRoot: fixture.repositoryRoot,
      manifestPath: fixture.manifestPath,
      codeVersion: codeFingerprint.slice(0, 40),
      env: equivalentCanonicalProxyEnv,
      modelsYamlSource: fixture.modelsYamlSource,
      paidExecutionSourceContractFingerprint:
        fixture.paidExecutionSourceContractFingerprint,
      allowedPrivateRoots: [fixture.rootDir]
    });
    expect(
      developmentDiagnosticPreflightConfigurationFingerprint(
        equivalentProxyPreflight
      )
    ).toBe(
      developmentDiagnosticPreflightConfigurationFingerprint(
        canonicalProxyPreflight
      )
    );
    const stateDirectory = resolve(fixture.rootDir, "stable-authorization-state");
    const output: string[] = [];
    const errors: string[] = [];
    let fetchCalls = 0;
    let paidCalls = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCalls += 1;
      throw new Error("poison fetch");
    });
    const runtime = (
      argv: readonly string[],
      effectivePreflight = canonicalProxyPreflight
    ): DevelopmentDiagnosticCliRuntime => ({
      argv,
      environment: { FERMATA_RUN_WITH_ENV: "1" },
      stdinIsTTY: false,
      ownerIdentity: {
        realUserId: process.getuid!(),
        effectiveUserId: process.geteuid!(),
        repositoryOwnerId: process.getuid!()
      },
      codeFingerprint,
      manifestFingerprint: effectivePreflight.manifestFingerprint,
      authorityFingerprint: digest("configuration-stable-authority"),
      configurationFingerprint:
        developmentDiagnosticPreflightConfigurationFingerprint(
          effectivePreflight
        ),
      wrapperParentAttested: true,
      writeOutput: (text) => output.push(text),
      writeError: (text) => errors.push(text),
      readConfirmation: async () => "",
      installSignalHandlers: () => () => undefined,
      preflight: async () => ({
        manifestFingerprint: effectivePreflight.manifestFingerprint,
        configurationFingerprint:
          developmentDiagnosticPreflightConfigurationFingerprint(
            effectivePreflight
          )
      }),
      paidExecution: async () => {
        paidCalls += 1;
        return { complete: false, reason: "terminal_role_failure" };
      }
    });
    const planned = await runDevelopmentDiagnosticCli(runtime([
      "--state-dir",
      stateDirectory
    ]));
    expect(planned.code).toBe("PLAN_REQUIRES_AUTHORIZATION");
    output.length = 0;

    expect(await runDevelopmentDiagnosticCli(runtime([
      "--state-dir",
      stateDirectory,
      "--authorize-plan",
      planned.planFingerprint!
    ], equivalentProxyPreflight))).toEqual(
      expect.objectContaining({ exitCode: 1, code: "INCOMPLETE" })
    );
    expect(paidCalls).toBe(1);
    expect(fetchCalls).toBe(0);
    const privacySurfaces = [
      ...readdirSync(stateDirectory, {
        recursive: true,
        withFileTypes: true
      })
        .filter((entry) => entry.isFile())
        .map((entry) =>
          readFileSync(resolve(entry.parentPath, entry.name), "utf8")),
      output.join(""),
      errors.join("")
    ];
    for (const privateFragment of [
      fixture.env.AETHER_API_KEY!,
      "http://canonical-user:canonical-pass@canonical-proxy.invalid:8080",
      "canonical-user",
      "canonical-pass",
      "canonical-proxy.invalid",
      "example.invalid",
      "internal.invalid"
    ]) {
      for (const surface of privacySurfaces) {
        expect(surface).not.toContain(privateFragment);
      }
    }
  });

  it("tampered source file hash is rejected", () => {
    const fixture = createRealDevelopmentSmokeFixture();
    // Tamper the source file for slot-01 after manifest was built
    const tamperedPath = resolve(fixture.rootDir, "slot-01", "source.json");
    writePrivateFile(tamperedPath, JSON.stringify({ tampered: true }));

    expect(() =>
      preflightDevelopmentDiagnostic({
        repositoryRoot: fixture.repositoryRoot,
        projectRoot: fixture.repositoryRoot,
        manifestPath: fixture.manifestPath,
        codeVersion: randomBytes(20).toString("hex"),
        env: fixture.env,
        modelsYamlSource: fixture.modelsYamlSource,
        paidExecutionSourceContractFingerprint:
          fixture.paidExecutionSourceContractFingerprint,
        allowedPrivateRoots: [fixture.rootDir]
      })
    ).toThrow("DEVELOPMENT_SMOKE_PRIVATE_FILE_HASH_MISMATCH");
  });

  it("structural copy of preflight token is rejected by runDevelopmentDiagnosticPhase", async () => {
    const fixture = createRealDevelopmentSmokeFixture();
    const realPreflight = preflightDevelopmentDiagnostic({
      repositoryRoot: fixture.repositoryRoot,
      projectRoot: fixture.repositoryRoot,
      manifestPath: fixture.manifestPath,
      codeVersion: randomBytes(20).toString("hex"),
      env: fixture.env,
      modelsYamlSource: fixture.modelsYamlSource,
      paidExecutionSourceContractFingerprint:
        fixture.paidExecutionSourceContractFingerprint,
      allowedPrivateRoots: [fixture.rootDir]
    });
    // Structural copy — same fields but not registered in the module-private WeakMap
    const forged: DevelopmentDiagnosticPreflight = {
      manifestFingerprint: realPreflight.manifestFingerprint,
      cases: realPreflight.cases,
      roleModels: realPreflight.roleModels,
      roleModelsFingerprint: realPreflight.roleModelsFingerprint,
      paidExecutionContractFingerprint:
        realPreflight.paidExecutionContractFingerprint,
      difficultyAnchors: realPreflight.difficultyAnchors,
      includedInFinalCalibration: false,
      phase1Concept: false,
      duplicateSimilarityRejectThreshold: realPreflight.duplicateSimilarityRejectThreshold,
      profileName: realPreflight.profileName,
      experimentVersion: realPreflight.experimentVersion,
      caseBindingFingerprints: realPreflight.caseBindingFingerprints
    };
    const controller = buildController();
    await expect(
      runDevelopmentDiagnosticPhase({
        controller,
        preflight: forged,
        taskCandidates: fixture.taskCandidates.slice(0, 2).map((tc) => ({
          slot: tc.slot as "slot-01" | "slot-02",
          taskCandidate: tc.taskCandidate,
          duplicateSimilarityRejectThreshold: tc.duplicateSimilarityRejectThreshold
        })),
        engineBuildFingerprint: digest("engine"),
        fetchRuntimeOverride: buildMockFetchForAllRoles(),
        profileName: "test",
        experimentVersion: "test-v1"
      })
    ).rejects.toThrow("DEVELOPMENT_DIAGNOSTIC_PREFLIGHT_FORBIDDEN");
  });

  function realPreflightOf(
    fixture: RealSmokeFixture,
    selectedSlots: readonly ("slot-01" | "slot-02")[] = expectedDiagnosticSlots
  ): DevelopmentDiagnosticPreflight {
    return preflightDevelopmentDiagnostic({
      repositoryRoot: fixture.repositoryRoot,
      projectRoot: fixture.repositoryRoot,
      manifestPath: fixture.manifestPath,
      codeVersion: randomBytes(20).toString("hex"),
      env: fixture.env,
      modelsYamlSource: fixture.modelsYamlSource,
      paidExecutionSourceContractFingerprint:
        fixture.paidExecutionSourceContractFingerprint,
      allowedPrivateRoots: [fixture.rootDir]
    }, selectedSlots);
  }

  function diagnosticRunArgs(
    fixture: RealSmokeFixture,
    preflight: DevelopmentDiagnosticPreflight,
    overrides: Partial<{
      taskCandidates: RealSmokeFixture["taskCandidates"];
      threshold: number;
      profileName: string;
      experimentVersion: string;
    }> = {}
  ): {
    controller: DevelopmentDiagnosticRunController;
    input: Parameters<typeof runDevelopmentDiagnosticPhase>[0];
  } {
    const taskCandidates = overrides.taskCandidates ?? fixture.taskCandidates.slice(0, 2);
    const controller = buildController();
    return {
      controller,
      input: {
        controller,
        preflight,
        taskCandidates: taskCandidates.map((tc) => ({
          slot: tc.slot as "slot-01" | "slot-02",
          taskCandidate: tc.taskCandidate,
          duplicateSimilarityRejectThreshold: overrides.threshold ?? tc.duplicateSimilarityRejectThreshold
        })),
        engineBuildFingerprint: digest("engine"),
        fetchRuntimeOverride: buildMockFetchForAllRoles(),
        profileName: overrides.profileName ?? preflight.profileName,
        experimentVersion: overrides.experimentVersion ?? preflight.experimentVersion
      }
    };
  }

  it("legitimate candidates pass binding checks and produce parsed incomplete state", async () => {
    mockFetchCallCount = 0;
    const fixture = createRealDevelopmentSmokeFixture();
    const preflight = realPreflightOf(fixture);
    const { controller, input } = diagnosticRunArgs(fixture, preflight);
    const outcomes = await runDevelopmentDiagnosticPhase(input);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every(
      (outcome) => outcome.status === "fulfilled" && outcome.value.status === "incomplete"
    )).toBe(true);
    expect(controller.checkpoint().completedSlotCount).toBe(0);
    expect(controller.checkpoint().completedRequestCount).toBe(0);
    expect(controller.getStageSnapshot("slot-01")).toEqual({
      A: "failed",
      B: "not_started",
      C: "not_started",
      D: "not_started",
      F: "not_started"
    });
    expect(controller.getStageSnapshot("slot-02")).toEqual({
      A: "failed",
      B: "not_started",
      C: "not_started",
      D: "not_started",
      F: "not_started"
    });
    expect(mockFetchCallCount).toBeGreaterThan(0);
  });
  it("runs one authorized slot with exactly twelve fetches and no second slot", async () => {
    const fixture = createRealDevelopmentSmokeFixture();
    const plannedRun = {
      schemaVersion: 1 as const,
      selectedSlots: ["slot-01"] as const,
      expectedRequestsPerSlot: 12 as const,
      maximumConcurrency: 12,
      maximumTransportAttemptsPerRequest: 2,
      globalTransportAttemptCeiling: 16,
      phaseSchedulingBudgetMs: 90 * 60_000,
      softStopPolicy: "stop_new_and_drain_in_flight" as const
    };
    const preflight = realPreflightOf(fixture, plannedRun.selectedSlots);
    const controller = buildController({ plannedRun });
    const mock = completeElevenRoleFetch();
    const outcomes = await runDevelopmentDiagnosticPhase({
      controller,
      preflight,
      taskCandidates: fixture.taskCandidates.slice(0, 1).map((candidate) => ({
        slot: candidate.slot as "slot-01",
        taskCandidate: candidate.taskCandidate,
        duplicateSimilarityRejectThreshold:
          candidate.duplicateSimilarityRejectThreshold
      })),
      engineBuildFingerprint: digest("engine"),
      fetchRuntimeOverride: mock.fetch,
      profileName: preflight.profileName,
      experimentVersion: preflight.experimentVersion
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("fulfilled");
    expect(mock.total()).toBe(12);
    expect(controller.scheduler().snapshot().maximumConcurrency).toBe(12);
    expect(controller.checkpoint().completedSlotCount).toBe(1);
    expect(controller.getStageSnapshot("slot-02")).toEqual({
      A: "not_started",
      B: "not_started",
      C: "not_started",
      D: "not_started",
      F: "not_started"
    });
  });

  it("runs standalone slot-02 with its own canonical preflight and twelve fetches", async () => {
    const fixture = createRealDevelopmentSmokeFixture();
    const plannedRun = {
      schemaVersion: 1 as const,
      selectedSlots: ["slot-02"] as const,
      expectedRequestsPerSlot: 12 as const,
      maximumConcurrency: 12,
      maximumTransportAttemptsPerRequest: 2,
      globalTransportAttemptCeiling: 16,
      phaseSchedulingBudgetMs: 90 * 60_000,
      softStopPolicy: "stop_new_and_drain_in_flight" as const
    };
    const preflight = realPreflightOf(fixture, plannedRun.selectedSlots);
    const controller = buildController({ plannedRun });
    const mock = completeElevenRoleFetch();
    const candidate = fixture.taskCandidates[1]!;
    const outcomes = await runDevelopmentDiagnosticPhase({
      controller,
      preflight,
      taskCandidates: [{
        slot: "slot-02",
        taskCandidate: candidate.taskCandidate,
        duplicateSimilarityRejectThreshold:
          candidate.duplicateSimilarityRejectThreshold
      }],
      engineBuildFingerprint: digest("engine"),
      fetchRuntimeOverride: mock.fetch,
      profileName: preflight.profileName,
      experimentVersion: preflight.experimentVersion
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("fulfilled");
    expect(mock.total()).toBe(12);
    expect(controller.checkpoint().completedSlotCount).toBe(1);
    expect(controller.getStageSnapshot("slot-01")).toEqual({
      A: "not_started",
      B: "not_started",
      C: "not_started",
      D: "not_started",
      F: "not_started"
    });
  });
  it("runs two complete eleven-role slots with exactly twelve fetches each", async () => {
    const fixture = createRealDevelopmentSmokeFixture();
    const preflight = realPreflightOf(fixture);
    const { controller, input } = diagnosticRunArgs(fixture, preflight);
    const mock = completeElevenRoleFetch();
    const outcomes = await runDevelopmentDiagnosticPhase({
      ...input,
      fetchRuntimeOverride: mock.fetch
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((outcome) =>
      outcome.status === "fulfilled" ? outcome.value.status : "rejected"
    )).toEqual(["complete", "complete"]);
    expect(Object.fromEntries(mock.counts)).toEqual({
      solver: 4,
      solution_analyst: 2,
      technical_auditor: 2,
      difficulty: 2,
      editorial_judge: 2,
      contest_fit: 2,
      originality: 2,
      tags: 2,
      critic: 2,
      adversary: 2,
      adjudicator: 2
    });
    expect(mock.peak()).toBe(4);
    expect(controller.scheduler().snapshot().peakConcurrency).toBe(4);
    expect(mock.total()).toBe(24);
    const schemaKeyByRole = {
      solver: "solved",
      solution_analyst: "solverCorrect",
      technical_auditor: "statementSolutionConsistency",
      difficulty: "codeforcesDifficulty",
      editorial_judge: "noveltyLevel",
      contest_fit: "icpcFit",
      originality: "sameProblemAsExisting",
      tags: "tagIds",
      critic: "conflicts",
      adversary: "counterexamples",
      adjudicator: "citedEvidenceIds"
    } as const;
    expect(mock.requests).toHaveLength(24);
    expect(mock.requests.every((request) => !request.responseFormatPresent)).toBe(true);
    for (const request of mock.requests) {
      expect(request.model).toMatch(/^deepseek-/u);
      expect(request.thinkingRequest).toEqual({ type: "enabled" });
      expect(request.reasoningEffort).toBe("max");
      expect(typeof request.maxTokens).toBe("number");
      if (typeof request.maxTokens !== "number") {
        throw new Error("EXPECTED_NUMERIC_MAX_TOKENS");
      }
      expect(request.maxTokens).toBeLessThanOrEqual(32_000);
    }
    const structuredRequests = mock.requests.filter(
      (request) => request.targetSchema !== null
    );
    expect(structuredRequests).toHaveLength(22);
    for (const request of structuredRequests) {
      expect(request.prompt).not.toMatch(
        /(?:不(?:要)?输出|不需要)\s*JSON(?:\s*格式)?|Do not output JSON/iu
      );
      expect(request.prompt).not.toMatch(/上一条|previous semantic output/iu);
    }
    for (const request of structuredRequests) {
      if (
        typeof request.targetSchema !== "object" ||
        request.targetSchema === null ||
        Array.isArray(request.targetSchema)
      ) {
        throw new Error("EXPECTED_OBJECT_JSON_SCHEMA");
      }
      const targetSchema = request.targetSchema as Record<string, unknown>;
      const properties = targetSchema.properties;
      const required = targetSchema.required;
      expect(targetSchema.type).toBe("object");
      expect(targetSchema.additionalProperties).toBe(false);
      expect(properties).toBeTypeOf("object");
      expect(Array.isArray(required)).toBe(true);
      const schemaKey = schemaKeyByRole[
        request.role as keyof typeof schemaKeyByRole
      ];
      expect(schemaKey).toBeDefined();
      expect(properties).toHaveProperty(schemaKey);
      expect(required).toContain(schemaKey);
      expect(request.prompt).toContain("只输出一个满足下列完整 JSON Schema");
    }
    const solverRequests = mock.requests.filter(
      (request) => request.role === "solver"
    );
    expect(solverRequests.filter((request) => request.targetSchema === null)).toHaveLength(2);
    expect(solverRequests.filter((request) => request.targetSchema !== null)).toHaveLength(2);
    for (const request of solverRequests.filter(
      (entry) => entry.targetSchema !== null
    )) {
      expect(request.prompt).toContain("Synthetic exploration.");
    }
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("fulfilled");
      if (outcome.status !== "fulfilled") throw outcome.reason;
      const parsed = reviewFlowCalibrationOutcomeSchema.parse(outcome.value);
      expect(parsed.status).toBe("complete");
      if (parsed.status !== "complete") {
        throw new Error("EXPECTED_COMPLETE_CALIBRATION");
      }
      expect(parsed.projection.roleReceipts).toHaveLength(11);
      expect(parsed.projection.roleReceipts.reduce(
        (sum, receipt) => sum + receipt.requestCount,
        0
      )).toBe(12);
      expect(new Set(parsed.projection.roleReceipts.map((entry) => entry.role))).toEqual(
        new Set(reviewFlowRoleSchema.options)
      );
      expect(parsed.projection.receiptSetHash).toBe(
        hashCanonicalValue(parsed.projection.roleReceipts)
      );
      for (const receipt of parsed.projection.roleReceipts) {
        expect(receipt.requestCount).toBe(receipt.role === "solver" ? 2 : 1);
        expect(receipt.transportAttemptCount).toBe(receipt.requestCount);
        expect(receipt.responses).toHaveLength(receipt.requestCount);
        expect(receipt.receiptHash).toMatch(/^[0-9a-f]{64}$/u);
        for (const response of receipt.responses) {
          expect(response).toMatchObject({
            responseMode: "sse",
            transportAttemptCount: 1,
            eofVerified: true,
            finishReasonStopVerified: true,
            sseDoneObserved: true
          });
          expect(response.acceptedEventShapes.length).toBeGreaterThan(0);
        }
      }
    }
    for (const slot of ["slot-01", "slot-02"] as const) {
      expect(controller.getStageSnapshot(slot)).toEqual({
        A: "complete",
        B: "complete",
        C: "complete",
        D: "complete",
        F: "not_started"
      });
      expect(new Set(controller.getRoleCompletions(slot))).toEqual(
        new Set(reviewFlowRoleSchema.options)
      );
      expect(controller.getRoleFailures(slot)).toEqual([]);
    }
    expect(controller.checkpoint().externalAttemptsUsed).toBe(24);
    expect(controller.checkpoint().completedRequestCount).toBe(8);
    expect(controller.checkpoint().completedSlotCount).toBe(2);
    expect(controller.checkpoint().stopped).toBe(false);
  });

  it("rejects a wrong adjudicator evidence id without marking either slot complete", async () => {
    const fixture = createRealDevelopmentSmokeFixture();
    const preflight = realPreflightOf(fixture);
    const { controller, input } = diagnosticRunArgs(fixture, preflight);
    const mock = completeElevenRoleFetch(true);
    const outcomes = await runDevelopmentDiagnosticPhase({
      ...input,
      fetchRuntimeOverride: mock.fetch
    });
    expect(mock.total()).toBe(24);
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("fulfilled");
      if (outcome.status !== "fulfilled") throw outcome.reason;
      const parsed = reviewFlowCalibrationOutcomeSchema.parse(outcome.value);
      expect(parsed.status).toBe("incomplete");
      if (parsed.status !== "incomplete") {
        throw new Error("EXPECTED_INCOMPLETE_CALIBRATION");
      }
      expect(parsed.failure.completedRoles).toHaveLength(10);
      expect(parsed.failure.completedRoles.map((entry) => entry.role)).not.toContain(
        "adjudicator"
      );
      expect(parsed.failure.failedRoles).toEqual([expect.objectContaining({
        role: "adjudicator",
        failureKind: "validation"
      })]);
      const { failureId, ...failureBase } = parsed.failure;
      expect(failureId).toBe(hashCanonicalValue(failureBase));
    }
    for (const slot of ["slot-01", "slot-02"] as const) {
      expect(controller.getStageSnapshot(slot)).toEqual({
        A: "complete",
        B: "complete",
        C: "complete",
        D: "failed",
        F: "not_started"
      });
      expect(controller.getRoleCompletions(slot)).toHaveLength(10);
      expect(controller.getRoleFailures(slot)).toEqual(["adjudicator"]);
    }
    expect(controller.checkpoint().completedRequestCount).toBe(6);
    expect(controller.checkpoint().completedSlotCount).toBe(0);
    expect(controller.checkpoint().firstFailureKind).toBe("permanent");
  });

  it("commits a completed solver before a later exhausted role failure", async () => {
    const fixture = createRealDevelopmentSmokeFixture();
    const preflight = realPreflightOf(fixture);
    const { controller, input } = diagnosticRunArgs(fixture, preflight);
    const solverPayload = JSON.stringify({
      solved: true,
      narrative: "A complete synthetic solution.",
      approach: "Use the stated invariant.",
      claimedComplexity: "O(n)",
      uncertainties: []
    });
    let fetchCount = 0;
    const outcomes = await runDevelopmentDiagnosticPhase({
      ...input,
      fetchRuntimeOverride: async () => {
        fetchCount += 1;
        if (fetchCount <= 4) {
          return syntheticSseResponse([
            `data: ${JSON.stringify({
              choices: [{
                delta: { content: solverPayload },
                finish_reason: null
              }]
            })}`,
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
            "data: [DONE]"
          ]);
        }
        return new Response(null, { status: 429 });
      }
    });
    // 两槽 solver 各完成探索+直接结构化综合两次请求；随后两个
    // solution_analyst 各自用完诊断 profile 唯一允许尝试并收到 429。
    expect(fetchCount).toBe(6);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]?.status).toBe("fulfilled");
    if (outcomes[0]?.status !== "fulfilled") {
      throw outcomes[0]?.reason;
    }
    const parsed = reviewFlowCalibrationOutcomeSchema.parse(outcomes[0].value);
    expect(parsed.status).toBe("incomplete");
    if (parsed.status !== "incomplete") {
      throw new Error("EXPECTED_INCOMPLETE_OUTCOME");
    }
    expect(parsed.failure.completedRoles.map((entry) => entry.role)).toEqual(["solver"]);
    expect(parsed.failure.failedRoles.map((entry) => entry.role)).toEqual([
      "solution_analyst"
    ]);
    expect(parsed.failure.failedRoles[0]).toMatchObject({
      role: "solution_analyst",
      failureKind: "service_http",
      httpStatus: 429,
      requestCount: 1,
      transportAttemptCount: 1,
      completedResponseCount: 0
    });
    const completion = parsed.failure.completedRoles[0]!;
    expect(completion.requestCount).toBe(2);
    expect(completion.transportAttemptCount).toBe(2);
    expect(completion.responses).toHaveLength(2);
    expect(completion.responses[0]?.acceptedEventShapes.length).toBeGreaterThan(0);
    expect(
      reviewFlowRoleCompletionSummarySchema.parse(completion)
    ).toEqual(completion);
    expect(() => reviewFlowRoleCompletionSummarySchema.parse({
      ...completion,
      responses: [{
        ...completion.responses[0],
        acceptedEventShapes: [{
          category: "unsupported",
          shapeFingerprint: digest("shape"),
          count: 1
        }]
      }]
    })).toThrow();
    const { failureId, ...failureBase } = parsed.failure;
    expect(failureId).toBe(hashCanonicalValue(failureBase));
    expect(controller.getStageSnapshot("slot-01")).toEqual({
      A: "complete",
      B: "not_started",
      C: "failed",
      D: "not_started",
      F: "not_started"
    });
    expect(controller.getRoleCompletions("slot-01")).toEqual(["solver"]);
    expect(controller.getRoleFailures("slot-01")).toEqual(["solution_analyst"]);
    expect(controller.checkpoint().completedRequestCount).toBe(2);
    expect(controller.checkpoint().completedSlotCount).toBe(0);
    expect(controller.checkpoint().firstFailureKind).toBe("rate_limited");
  });

  it("real orchestrator first terminal failure closes gates while held peer drains", async () => {
    mockFetchCallCount = 0;
    const fixture = createRealDevelopmentSmokeFixture();
    const preflight = realPreflightOf(fixture);
    let signalPeerStarted: (() => void) | undefined;
    let releasePeer: (() => void) | undefined;
    let peerDrained = false;
    const peerStarted = new Promise<void>((resolveStarted) => {
      signalPeerStarted = resolveStarted;
    });
    const heldPeer = new Promise<void>((resolveHeld) => {
      releasePeer = resolveHeld;
    });
    const { controller, input } = diagnosticRunArgs(fixture, preflight);
    let signalFailureObserved: (() => void) | undefined;
    const failureObserved = new Promise<void>((resolveFailure) => {
      signalFailureObserved = resolveFailure;
    });
    const recordTerminalRoleFailure =
      controller.recordTerminalRoleFailure.bind(controller);
    controller.recordTerminalRoleFailure = (
      ...args: Parameters<DevelopmentDiagnosticRunController["recordTerminalRoleFailure"]>
    ): void => {
      recordTerminalRoleFailure(...args);
      signalFailureObserved?.();
    };
    const runPromise = runDevelopmentDiagnosticPhase({
      ...input,
      fetchRuntimeOverride: async () => {
        mockFetchCallCount += 1;
        if (mockFetchCallCount === 1) {
          return new Response("", { status: 500 });
        }
        signalPeerStarted?.();
        await heldPeer;
        peerDrained = true;
        return successfulSseResponse();
      }
    });
    let runSettled = false;
    const runSettlementObserved = runPromise.then(
      () => {
        runSettled = true;
      },
      () => {
        runSettled = true;
      }
    );
    await peerStarted;
    await failureObserved;
    expect(controller.checkpoint().firstFailureKind).toBe("server_error");
    expect(controller.requestStartGate.canStartRequest()).toBe(false);
    expect(controller.scheduler().snapshot().softStopped).toBe(true);
    expect(() => controller.reserveTransportOrThrow()).toThrow("TRANSPORT_GATE_DENIED");
    expect(peerDrained).toBe(false);
    expect(runSettled).toBe(false);
    expect(mockFetchCallCount).toBe(2);
    releasePeer?.();
    const outcomes = await runPromise;
    await runSettlementObserved;
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    expect(peerDrained).toBe(true);
    expect(mockFetchCallCount).toBe(2);
    expect(controller.scheduler().snapshot().peakConcurrency).toBe(2);
  });

  it.each([
    ["source", "source.json"],
    ["frozen manifest", "frozen-manifest.json"],
    ["truth", "truth.json"],
    ["difficulty evidence", "difficulty-evidence.json"],
    ["prior failure", "prior-failure.json"]
  ])("runner revalidates %s after preflight", async (_label, fileName) => {
    mockFetchCallCount = 0;
    const fixture = createRealDevelopmentSmokeFixture();
    const preflight = realPreflightOf(fixture);
    writePrivateFile(
      resolve(fixture.rootDir, "slot-01", fileName),
      JSON.stringify({ tampered: true })
    );
    const { input } = diagnosticRunArgs(fixture, preflight);
    await expect(runDevelopmentDiagnosticPhase(input))
      .rejects.toThrow("DEVELOPMENT_SMOKE_PRIVATE_FILE_HASH_MISMATCH");
    expect(mockFetchCallCount).toBe(0);
  });

  it("registered authority recursively freezes cases, fingerprints, and role model specs", async () => {
    mockFetchCallCount = 0;
    const fixture = createRealDevelopmentSmokeFixture();
    const preflight = realPreflightOf(fixture);
    const originalSourceBinding = preflight.cases[0]!.sourceBinding;
    const originalSolverModel = preflight.roleModels.solver.spec.model;
    expect(Reflect.set(
      preflight.cases[0] as object,
      "sourceBinding",
      digest("forged-source-binding")
    )).toBe(false);
    expect(Reflect.set(
      preflight.caseBindingFingerprints as object,
      "0",
      digest("forged-case-fingerprint")
    )).toBe(false);
    expect(Reflect.set(
      preflight.roleModels.solver.spec as object,
      "model",
      preflight.roleModels.difficulty.spec.model
    )).toBe(false);
    expect(Reflect.set(
      preflight.roleModels as object,
      "solver",
      preflight.roleModels.difficulty
    )).toBe(false);
    expect(preflight.cases[0]!.sourceBinding).toBe(originalSourceBinding);
    expect(preflight.roleModels.solver.spec.model).toBe(originalSolverModel);

    const { input } = diagnosticRunArgs(fixture, preflight);
    const outcomes = await runDevelopmentDiagnosticPhase(input);
    expect(outcomes).toHaveLength(2);
    expect(mockFetchCallCount).toBeGreaterThan(0);
  });

  it("structural model-role substitution is rejected as an unregistered authority", async () => {
    mockFetchCallCount = 0;
    const fixture = createRealDevelopmentSmokeFixture();
    const preflight = realPreflightOf(fixture);
    const forged = {
      ...preflight,
      roleModels: {
        ...preflight.roleModels,
        solver: preflight.roleModels.difficulty
      }
    } as DevelopmentDiagnosticPreflight;
    const { input } = diagnosticRunArgs(fixture, forged);
    await expect(runDevelopmentDiagnosticPhase(input))
      .rejects.toThrow("DEVELOPMENT_DIAGNOSTIC_PREFLIGHT_FORBIDDEN");
    expect(mockFetchCallCount).toBe(0);
  });

  it("tampered slot label is rejected before evaluation", async () => {
    mockFetchCallCount = 0;
    const fixture = createRealDevelopmentSmokeFixture();
    const preflight = realPreflightOf(fixture);
    const first = fixture.taskCandidates[0]!;
    const second = fixture.taskCandidates[1]!;
    const wrongSlots = [
      { ...first, slot: "slot-02" },
      { ...second, slot: "slot-01" }
    ];
    const { input } = diagnosticRunArgs(fixture, preflight, {
      taskCandidates: wrongSlots
    });
    await expect(runDevelopmentDiagnosticPhase(input))
      .rejects.toThrow("DEVELOPMENT_DIAGNOSTIC_BATCH_INVALID");
    expect(mockFetchCallCount).toBe(0);
  });

  it("tampered threshold is rejected at binding", async () => {
    const fixture = createRealDevelopmentSmokeFixture();
    const preflight = realPreflightOf(fixture);
    const { input } = diagnosticRunArgs(fixture, preflight, { threshold: 0.99 });
    await expect(runDevelopmentDiagnosticPhase(input))
      .rejects.toThrow("DEVELOPMENT_DIAGNOSTIC_THRESHOLD_MISMATCH");
  });

  it("substituted task candidate is rejected at binding", async () => {
    const fixture = createRealDevelopmentSmokeFixture();
    const preflight = realPreflightOf(fixture);
    const substituted = structuredClone(fixture.taskCandidates.slice(0, 2));
    (substituted[0]!.taskCandidate as Record<string, unknown>).assignmentId =
      "11111111-1111-4111-8111-111111111111";
    const { input } = diagnosticRunArgs(fixture, preflight, { taskCandidates: substituted });
    await expect(runDevelopmentDiagnosticPhase(input))
      .rejects.toThrow("DEVELOPMENT_DIAGNOSTIC_TASK_BINDING_MISMATCH");
  });

  it("nested task content changes are rejected even when identity fields stay unchanged", async () => {
    mockFetchCallCount = 0;
    const fixture = createRealDevelopmentSmokeFixture();
    const preflight = realPreflightOf(fixture);
    const tampered = structuredClone(fixture.taskCandidates.slice(0, 2));
    const firstTask = tampered[0]!.taskCandidate as {
      problem: { content: { basicStatement: string; basicSolution: string } };
    };
    firstTask.problem.content.basicStatement = "Different synthetic statement.";
    firstTask.problem.content.basicSolution = "Different synthetic solution.";
    const { input } = diagnosticRunArgs(fixture, preflight, {
      taskCandidates: tampered
    });
    await expect(runDevelopmentDiagnosticPhase(input))
      .rejects.toThrow("DEVELOPMENT_DIAGNOSTIC_TASK_BINDING_MISMATCH");
    expect(mockFetchCallCount).toBe(0);
  });

  it("captures trusted slots before await so caller slot mutation cannot redirect failures", async () => {
    mockFetchCallCount = 0;
    const fixture = createRealDevelopmentSmokeFixture();
    const preflight = realPreflightOf(fixture);
    let signalFetchStarted: (() => void) | undefined;
    let releaseFetch: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolveStarted) => {
      signalFetchStarted = resolveStarted;
    });
    const holdFetch = new Promise<void>((resolveHeld) => {
      releaseFetch = resolveHeld;
    });
    const { controller, input } = diagnosticRunArgs(fixture, preflight);
    const mutableCandidates = input.taskCandidates as {
      slot: "slot-01" | "slot-02";
      taskCandidate: unknown;
      duplicateSimilarityRejectThreshold: number;
    }[];
    const runPromise = runDevelopmentDiagnosticPhase({
      ...input,
      fetchRuntimeOverride: async () => {
        mockFetchCallCount += 1;
        signalFetchStarted?.();
        await holdFetch;
        throw new Error("MOCK_FETCH_NOT_CONFIGURED");
      }
    });
    await fetchStarted;
    mutableCandidates[0]!.slot = "slot-02";
    releaseFetch?.();
    const outcomes = await runPromise;
    expect(outcomes).toHaveLength(2);
    expect(controller.getRoleFailures("slot-01")).toContain("solver");
    expect(controller.getRoleFailures("slot-02")).toContain("solver");
    expect(mockFetchCallCount).toBeGreaterThan(0);
  });

  it("swapped candidates across slots are rejected at binding", async () => {
    const fixture = createRealDevelopmentSmokeFixture();
    const preflight = realPreflightOf(fixture);
    // 保持每个位置的 slot 标签不变、但交换任务内容——slot 顺序检查无法发现，
    // 必须由 taskBindingFingerprint 逐槽比对拒绝。
    const first = fixture.taskCandidates[0]!;
    const second = fixture.taskCandidates[1]!;
    const contentSwapped = [
      { slot: first.slot, taskCandidate: second.taskCandidate, duplicateSimilarityRejectThreshold: first.duplicateSimilarityRejectThreshold },
      { slot: second.slot, taskCandidate: first.taskCandidate, duplicateSimilarityRejectThreshold: second.duplicateSimilarityRejectThreshold }
    ];
    const { input } = diagnosticRunArgs(fixture, preflight, { taskCandidates: contentSwapped });
    await expect(runDevelopmentDiagnosticPhase(input))
      .rejects.toThrow("DEVELOPMENT_DIAGNOSTIC_TASK_BINDING_MISMATCH");
  });

  it("profile mismatch is rejected at binding", async () => {
    const fixture = createRealDevelopmentSmokeFixture();
    const preflight = realPreflightOf(fixture);
    const { input } = diagnosticRunArgs(fixture, preflight, { profileName: "not-review-balanced" });
    await expect(runDevelopmentDiagnosticPhase(input))
      .rejects.toThrow("DEVELOPMENT_DIAGNOSTIC_PROFILE_MISMATCH");
  });

  it("experiment version mismatch is rejected at binding", async () => {
    const fixture = createRealDevelopmentSmokeFixture();
    const preflight = realPreflightOf(fixture);
    const { input } = diagnosticRunArgs(fixture, preflight, { experimentVersion: "tampered-v1" });
    await expect(runDevelopmentDiagnosticPhase(input))
      .rejects.toThrow("DEVELOPMENT_DIAGNOSTIC_EXPERIMENT_VERSION_MISMATCH");
  });
});

describe("durable lifecycle hook ordering", () => {
  it("serializes concurrent transport callbacks without loss", async () => {
    const profile = developmentDiagnosticProfile;
    const events: { readonly type: string; readonly sequence?: number }[] = [];
    const controller = new DevelopmentDiagnosticRunController({
      profile,
      manifest: buildContentFreeManifest(),
      runBindingHash: digest("lifecycle-order"),
      scheduler: createDevelopmentDiagnosticScheduler(profile),
      startedAtMs: 0,
      clock: () => 1,
      lifecycleSink: async (event) => {
        events.push({
          type: event.type,
          ...("sequence" in event ? { sequence: event.sequence } : {})
        });
        await Promise.resolve();
      }
    });
    expect(
      await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          controller.dispatchTransport(async () => {
            await controller.prepareTransportOrThrow({
              role: (["solver", "solution_analyst", "technical_auditor", "difficulty"] as const)[index]!,
              modelFingerprint: digest(`lifecycle-model:${index}`)
            });
            controller.markTransportFirstOutput();
            return index;
          })
        )
      )
    ).toEqual([0, 1, 2, 3]);
    await controller.flushLifecycleEvents();
    expect(events).toHaveLength(20);
    for (const sequence of [1, 2, 3, 4]) {
      expect(
        events
          .filter((event) => event.sequence === sequence)
          .map((event) => event.type)
      ).toEqual([
        "transport_intent",
        "transport_reserved",
        "transport_started",
        "transport_first_output",
        "transport_settled"
      ]);
    }
  });

  it("prevents execute when the durable started checkpoint rejects", async () => {
    const profile = developmentDiagnosticProfile;
    let executeCalls = 0;
    const controller = new DevelopmentDiagnosticRunController({
      profile,
      manifest: buildContentFreeManifest(),
      runBindingHash: digest("lifecycle-reject"),
      scheduler: createDevelopmentDiagnosticScheduler(profile),
      startedAtMs: 0,
      clock: () => 1,
      lifecycleSink: async (event) => {
        if (event.type === "transport_started") {
          throw new Error("durable checkpoint rejected");
        }
      }
    });
    await expect(
      controller.dispatchTransport(async () => {
        await controller.prepareTransportOrThrow({
          role: "solver",
          modelFingerprint: digest("reject-model")
        });
        executeCalls += 1;
      })
    ).rejects.toThrow();
    expect(executeCalls).toBe(0);
    expect(controller.requestStartGate.canStartRequest()).toBe(false);
    expect(() => controller.transportGate.reserveOrThrow()).toThrow(
      "TRANSPORT_GATE_DENIED"
    );
  });
});
