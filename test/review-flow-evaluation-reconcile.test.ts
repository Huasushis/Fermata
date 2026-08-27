import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  closePrivateDirectory,
  preparePrivateDirectory
} from "../scripts/private-runtime.mjs";
import {
  writePrivateArtifactExclusive
} from "../experiments/lib/private-artifact-io";
import { hashCanonicalValue } from "../src/review-flow/evidence";
import {
  reviewFlowRoleStage,
  reviewFlowRoleAttemptAuditSchema,
} from "../src/review-flow/orchestrator";
import {
  reviewFlowRoleSchema,
  type ReviewFlowRole
} from "../src/review-flow/schemas";
import {
  reviewFlowEvaluationCaseSelectionSchema,
  reviewFlowEvaluationOrderedSelectionSha256
} from "../experiments/lib/review-flow-evaluation-dataset";
import {
  reviewFlowEvaluationCheckpointSchema,
  reviewFlowEvaluationExecutionCompletionFingerprint,
  reviewFlowEvaluationIdentitySchema,
  ReviewFlowEvaluationCheckpoint,
  summarizeReviewFlowEvaluationAuditLedger,
  type ReviewFlowEvaluationCheckpointState,
  type ReviewFlowEvaluationEntry
} from "../experiments/lib/review-flow-evaluation-state";
import {
  formatReviewFlowEvaluationReconciliationSummary,
  reconcileReviewFlowEvaluationCheckpoints,
  reviewFlowEvaluationCompatibilityProofSchema,
  reviewFlowEvaluationReconciliationAllowedPaths,
  reviewFlowEvaluationReconciliationAuthorityAllowedPaths,
  reviewFlowEvaluationReconciliationAuthorityCodeVersion,
  reviewFlowEvaluationReconciliationAuthorityDiffSha256,
  reviewFlowEvaluationReconciliationAuthoritySolVerdict,
  reviewFlowEvaluationReconciliationDiffSha256,
  reviewFlowEvaluationReconciliationPostCommitAllowedPaths,
  reviewFlowEvaluationReconciliationPostCommitProofSchema,
  reviewFlowEvaluationReconciliationPostCommitSolVerdict,
  reviewFlowEvaluationReconciliationSolVerdict,
  reviewFlowEvaluationReconciliationSourceCodeVersion,
  reviewFlowEvaluationReconciliationTargetCodeVersion,
  runReviewFlowEvaluationReconciliationCli
} from "../experiments/lib/review-flow-evaluation-reconcile";
import { resolveReviewFlowEvaluationCliOptions } from "../experiments/eval-review-flow";
const timestamp = "2026-08-27T00:00:00.000Z";
const roles = reviewFlowRoleSchema.options;
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const trustedGitEnvironment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: "/nonexistent",
  LANG: "C",
  LC_ALL: "C"
};

interface ReconciliationFixture {
  readonly workspace: string;
  readonly privateRoot: string;
  readonly inputDirectory: string;
  readonly authorityPath: string;
  readonly donorPath: string;
  readonly proofPath: string;
  readonly outputPath: string;
  readonly repositoryDirectory: string;
  readonly authority: ReviewFlowEvaluationCheckpointState;
  readonly donor: ReviewFlowEvaluationCheckpointState;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function expectedCases(): ReviewFlowEvaluationCheckpointState["expectedCases"] {
  return Array.from({ length: 32 }, (_, index) => {
    const number = index + 1;
    const safeId = `case-${number.toString().padStart(4, "0")}`;
    return {
      safeId,
      subjectId: `subject-${number.toString().padStart(8, "0")}`,
      sourceLineageSha256: digest(`lineage-${safeId}`),
      contentSha256: digest(`content-${safeId}`)
    };
  });
}

function roleAudit(
  role: ReviewFlowRole,
  outcome: "completed" | "failed"
) {
  return reviewFlowRoleAttemptAuditSchema.parse({
    schemaVersion: 1,
    role,
    roleStage: reviewFlowRoleStage(role),
    outcome,
    errorCategory: outcome === "failed" ? "schema_output" : null,
    errorCode: outcome === "failed" ? "LLM_RESPONSE_FORMAT_INVALID" : null,
    failureStage: outcome === "failed" ? "event_shape" : null,
    failureSubstage: null,
    httpStatus: 200,
    finishReason: outcome === "failed" ? "missing" : "stop",
    maxTokens: 100,
    usageTotalTokens: 1,
    usageComplete: true,
    responseByteCount: 1,
    eofObserved: true,
    stopObserved: outcome === "completed",
    doneObserved: outcome === "completed",
    logicalRequestCount: 1,
    transportAttemptCount: 1,
    providerRequestCount: 1,
    retryCount: 0,
    dependencyBlocked: false
  });
}

function completedRoleAudits() {
  return roles.map((role) => roleAudit(role, "completed"));
}

function failedRoleAudits() {
  return roles.map((role) => roleAudit(role, "failed"));
}

function caseAttempt(
  attempt: number,
  outcome: "completed" | "failed"
) {
  return {
    schemaVersion: 1 as const,
    attempt,
    outcome,
    accountingComplete: true,
    errorCategory: outcome === "failed" ? "schema_output" as const : null,
    errorCode: outcome === "failed" ? "LLM_RESPONSE_FORMAT_INVALID" as const : null,
    roleAttempts: outcome === "completed"
      ? completedRoleAudits()
      : failedRoleAudits()
  };
}

function projection() {
  const roleReceipts = roles.map((role) => {
    const response = {
      responseMode: "json" as const,
      transportAttemptCount: 1,
      eofVerified: true as const,
      finishReasonStopVerified: true as const,
      acceptedEventShapes: [],
      sseDoneObserved: null
    };
    return {
      role,
      receiptHash: hashCanonicalValue({
        schemaVersion: 2,
        requestCount: 1,
        transportAttemptCount: 1,
        eofVerified: true,
        jsonSchemaValidated: true,
        responses: [{
          schemaVersion: 2,
          transportAttemptCount: 1,
          eofVerified: true,
          responseMode: response.responseMode,
          finishReasonStopVerified: true,
          acceptedEventShapes: [],
          sseDoneObserved: null
        }]
      }),
      requestCount: 1 as const,
      transportAttemptCount: 1,
      responses: [response]
    };
  });
  return {
    schemaVersion: 2 as const,
    verdict: "approve" as const,
    codeforcesDifficulty: 1200,
    qualityLevel: 3,
    originalityLevel: 3,
    thinkingLevel: 3,
    codingLevel: 3,
    tagIds: ["implementation"],
    hardBlockers: [],
    difficultyConfidence: 1,
    technical: {
      officialSolutionCorrect: true,
      statementSolutionConsistency: "verified" as const,
      judgeability: "verified" as const,
      sampleConsistency: "verified" as const,
      constraintSufficiency: "verified" as const,
      referenceImplementation: {
        provided: false,
        status: "unavailable" as const,
        complexityAcceptable: null
      }
    },
    editorial: {
      qualityLevel: 3,
      noveltyLevel: 3,
      ideaDepthLevel: 3,
      naturalnessLevel: 3,
      contestantExperienceLevel: 3,
      evidenceCoverage: { strengths: "found" as const, concerns: "none_found" as const },
      evidence: [{
        dimension: "novelty" as const,
        direction: "strength" as const,
        severity: "note" as const,
        confidence: 1
      }]
    },
    contestFit: {
      icpcFit: "strong" as const,
      implementationBurden: 3,
      thinkingImplementationBalance: "strong" as const,
      knowledgeFairness: "fair" as const,
      problemsetRole: "standard" as const,
      roleConfidence: 1,
      evidenceCoverage: { strengths: "found" as const, concerns: "none_found" as const },
      evidence: [{
        dimension: "novelty" as const,
        direction: "strength" as const,
        severity: "note" as const,
        confidence: 1
      }]
    },
    originality: {
      originalityLevel: 3,
      sameProblemAsExisting: false,
      highestSimilarity: 0
    },
    roleReceipts,
    receiptSetHash: hashCanonicalValue(roleReceipts)
  };
}

function makeIdentity(
  codeVersion: string,
  datasetFingerprint: string,
  manifestSha256: string,
  caseSelection?: ReviewFlowEvaluationCheckpointState["identity"]["caseSelection"]
) {
  return reviewFlowEvaluationIdentitySchema.parse({
    schemaVersion: 2,
    protocolVersion: "review-flow-evaluation-v2",
    datasetFingerprint,
    manifestSha256,
    purpose: "development",
    codeIdentity: {
      codeVersion,
      runnerSha256: digest("runner"),
      dependencyCodeSha256: digest(`dependency-${codeVersion}`),
      dependencyFileCount: 2,
      productionDependencyCodeSha256: digest("production-dependency"),
      productionDependencyFileCount: 1
    },
    runtime: {
      nodeVersion: "24.6.0",
      platform: "linux",
      arch: "x64",
      packageLockSha256: digest("package-lock"),
      nodeExecutableSha256: digest("node"),
      nodeExecutableByteLength: 1,
      dependencyBundleSha256: digest("bundle"),
      dependencyFileCount: 1,
      dependencyByteLength: 1,
      snapshotSha256: digest("snapshot"),
      snapshotFileCount: 2,
      packages: [{
        name: "fixture-package",
        version: "1.0.0",
        sha256: digest("fixture-package"),
        fileCount: 1,
        byteLength: 1
      }],
      trustModel:
        "trusted_bootstrap_same_uid_non_adversarial_trusted_host_system_runtime_unbound_v1"
    },
    configurationFingerprint: digest("configuration"),
    configurationSummary: {
      llmFirstOutputMs: 1,
      llmOutputIdleMs: 1,
      llmMaximumDurationMs: 1,
      maxAttempts: 1,
      baseDelayMs: 1,
      concurrency: 1,
      caseAttempts: 1,
      proxyEnvironmentFingerprint: digest("proxy"),
      proxyEnvironmentKeys: [],
      duplicateSimilarityReject: 0.9,
      difficultyAnchorsFingerprint: digest("anchors"),
      difficultyAnchorsProvisional: true
    },
    experimentVersion: "fixture-experiment",
    profileName: "fixture-profile",
    runnerIdentity: digest("runner-identity"),
    transportMode: "production_undici",
    providerSummary: roles.map((role) => ({
      role,
      provider: "fixture",
      model: "fixture-model"
    })),
    ...(caseSelection === undefined ? {} : { caseSelection })
  });
}

function failedEntry(safeId: string): Extract<ReviewFlowEvaluationEntry, { status: "failed" }> {
  return {
    safeId,
    status: "failed",
    failedAt: timestamp,
    failure: {
      code: "LLM_RESPONSE_FORMAT_INVALID",
      failureKind: "schema_output",
      httpStatus: 200,
      completedRoleCount: 0,
      failedRoleCount: 11,
      failedRoles: roles.map((role) => ({
        role,
        failureKind: "schema_output" as const,
        requestCount: 1,
        transportAttemptCount: 1,
        completedResponseCount: 0
      })),
      roleAttempts: failedRoleAudits(),
      caseAttempts: 1
    }
  };
}

function completedEntry(safeId: string) {
  return {
    safeId,
    status: "completed" as const,
    completedAt: timestamp,
    projection: projection()
  };
}

function activeEntry(safeId: string) {
  return { safeId, status: "active" as const, startedAt: timestamp };
}

function identityFingerprint(identity: ReviewFlowEvaluationCheckpointState["identity"]): string {
  return hashCanonicalValue(identity);
}

function checkpointBase(
  label: string,
  runId: string,
  identity: ReviewFlowEvaluationCheckpointState["identity"],
  expected: ReviewFlowEvaluationCheckpointState["expectedCases"],
  entries: ReviewFlowEvaluationCheckpointState["entries"],
  ledger: NonNullable<ReviewFlowEvaluationCheckpointState["auditLedger"]>,
  termination: ReviewFlowEvaluationCheckpointState["termination"],
  executionSeal: ReviewFlowEvaluationCheckpointState["executionSeal"]
) {
  return {
    schemaVersion: 2 as const,
    label,
    variant: "baseline" as const,
    baselineLabel: null,
    baselineBinding: null,
    runId,
    identity,
    identityFingerprint: identityFingerprint(identity),
    holdoutIdentity: null,
    thresholdPolicySha256: null,
    expectedCases: expected,
    entries,
    auditLedger: ledger,
    globalClaimSha256: null,
    termination,
    executionSeal,
    publication: null,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function sealCheckpoint(
  base: ReturnType<typeof checkpointBase>
): ReviewFlowEvaluationCheckpointState {
  const draft = reviewFlowEvaluationCheckpointSchema.parse(base);
  return reviewFlowEvaluationCheckpointSchema.parse({
    ...draft,
    executionSeal: {
      sealedAt: timestamp,
      complete: false,
      completionFingerprint:
        reviewFlowEvaluationExecutionCompletionFingerprint(draft)
    }
  });
}

function buildFixtureStates() {
  const expected = expectedCases();
  const datasetFingerprint = digest("dataset");
  const manifestSha256 = digest("manifest");
  const authorityIdentity = makeIdentity(
    reviewFlowEvaluationReconciliationAuthorityCodeVersion,
    datasetFingerprint,
    manifestSha256
  );
  const selectedExpected = expected.slice(23);
  const orderedSelectionSha256 = reviewFlowEvaluationOrderedSelectionSha256(
    selectedExpected
  );
  const selection = reviewFlowEvaluationCaseSelectionSchema.parse({
    schemaVersion: 1,
    selector: "private-file-v1",
    selectorIdentity: "review-flow-evaluation-private-file-v1",
    selectorSha256: digest("selector"),
    selectedCaseSetSha256: orderedSelectionSha256,
    parentDatasetFingerprint: datasetFingerprint,
    parentManifestSha256: manifestSha256,
    parentBridgeCompletionSha256: digest("bridge"),
    parentCaseCount: 32,
    orderedSelectionSha256,
    selectedCaseCount: 9
  });
  const donorIdentity = makeIdentity(
    reviewFlowEvaluationReconciliationTargetCodeVersion,
    datasetFingerprint,
    manifestSha256,
    selection
  );
  const authorityEntries = expected.map((entry, index) =>
    index < 23 ? completedEntry(entry.safeId) : failedEntry(entry.safeId)
  );
  const authorityLedger = {
    schemaVersion: 1 as const,
    cases: authorityEntries.map((entry, index) => ({
      caseOrdinal: index + 1,
      attempts: [caseAttempt(1, entry.status === "completed" ? "completed" : "failed")]
    }))
  };
  const authority = sealCheckpoint(checkpointBase(
    "authority",
    "11111111-1111-4111-8111-111111111111",
    authorityIdentity,
    expected,
    authorityEntries,
    authorityLedger,
    null,
    null
  ));
  const donorEntries = selectedExpected.map((entry, index) =>
    index < 7
      ? completedEntry(entry.safeId)
      : index === 7
        ? failedEntry(entry.safeId)
        : activeEntry(entry.safeId)
  );
  const donorLedger = {
    schemaVersion: 1 as const,
    cases: donorEntries.map((entry, index) => ({
      caseOrdinal: index + 1,
      attempts: entry.status === "active"
        ? []
        : [caseAttempt(1, entry.status === "completed" ? "completed" : "failed")]
    }))
  };
  const donor = reviewFlowEvaluationCheckpointSchema.parse(checkpointBase(
    "donor",
    "22222222-2222-4222-8222-222222222222",
    donorIdentity,
    selectedExpected,
    donorEntries,
    donorLedger,
    { signal: "SIGTERM", observedAt: timestamp },
    null
  ));
  return { authority, donor };
}

function writePrivateJson(
  directory: string,
  privateRoot: string,
  containingWorkspace: string,
  fileName: string,
  value: unknown
): string {
  const handle = preparePrivateDirectory(directory, {
    privateRoot,
    containingWorkspace
  });
  try {
    writePrivateArtifactExclusive(
      handle,
      fileName,
      `${JSON.stringify(value, null, 2)}\n`
    );
  } finally {
    closePrivateDirectory(handle);
  }
  return join(directory, fileName);
}

function makeFixture(): ReconciliationFixture {
  const workspace = mkdtempSync(join("/tmp", "fermata-reconcile-test-"));
  const privateRoot = join(workspace, "private");
  const inputDirectory = join(privateRoot, "inputs");
  mkdirSync(privateRoot, { mode: 0o700 });
  mkdirSync(inputDirectory, { mode: 0o700 });
  const { authority, donor } = buildFixtureStates();
  const authorityPath = writePrivateJson(
    inputDirectory,
    privateRoot,
    workspace,
    "authority.json",
    authority
  );
  const donorPath = writePrivateJson(
    inputDirectory,
    privateRoot,
    workspace,
    "donor.json",
    donor
  );
  const proof = reviewFlowEvaluationCompatibilityProofSchema.parse({
    schemaVersion: 1,
    artifactKind: "review_flow_evaluation_compatibility_proof",
    authorityCheckpointCodeVersion:
      reviewFlowEvaluationReconciliationAuthorityCodeVersion,
    authorityCheckpointSha256: digest(readFileSync(authorityPath)),
    authorityDiffSha256:
      reviewFlowEvaluationReconciliationAuthorityDiffSha256,
    authorityChangedPaths: [
      ...reviewFlowEvaluationReconciliationAuthorityAllowedPaths
    ],
    authoritySolVerdict:
      reviewFlowEvaluationReconciliationAuthoritySolVerdict,
    sourceCodeVersion: reviewFlowEvaluationReconciliationSourceCodeVersion,
    targetCodeVersion: reviewFlowEvaluationReconciliationTargetCodeVersion,
    diffSha256: reviewFlowEvaluationReconciliationDiffSha256,
    changedPaths: [...reviewFlowEvaluationReconciliationAllowedPaths],
    solVerdict: reviewFlowEvaluationReconciliationSolVerdict
  });
  const proofPath = writePrivateJson(
    inputDirectory,
    privateRoot,
    workspace,
    "compatibility-proof.json",
    proof
  );
  const repositoryDirectory = join(workspace, "repository");
  execFileSync(
    "/usr/bin/git",
    ["clone", "--no-local", "--quiet", repositoryRoot, repositoryDirectory],
    { env: trustedGitEnvironment }
  );
  return {
    workspace,
    privateRoot,
    inputDirectory,
    authorityPath,
    donorPath,
    proofPath,
    outputPath: join(privateRoot, "reconciled", "checkpoint.json"),
    repositoryDirectory,
    authority,
    donor
  };
}
function makePostCommitProof(fixture: ReconciliationFixture): {
  readonly repositoryDirectory: string;
  readonly proofPath: string;
  readonly targetCodeVersion: string;
} {
  const repositoryDirectory = join(fixture.workspace, "post-commit-repository");
  execFileSync(
    "/usr/bin/git",
    ["clone", "--no-local", "--quiet", fixture.repositoryDirectory, repositoryDirectory],
    { env: trustedGitEnvironment }
  );
  for (const path of reviewFlowEvaluationReconciliationPostCommitAllowedPaths) {
    const sourcePath = join(repositoryRoot, path);
    const targetPath = join(repositoryDirectory, path);
    if (!existsSync(sourcePath)) {
      throw new Error(`missing post-commit fixture path: ${path}`);
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
  execFileSync(
    "/usr/bin/git",
    ["-C", repositoryDirectory, "add", "--", ...reviewFlowEvaluationReconciliationPostCommitAllowedPaths],
    { env: trustedGitEnvironment }
  );
  execFileSync(
    "/usr/bin/git",
    [
      "-C",
      repositoryDirectory,
      "-c",
      "user.name=Fermata Test",
      "-c",
      "user.email=fermata-test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "post-commit fixture"
    ],
    { env: trustedGitEnvironment }
  );
  const targetCodeVersion = execFileSync(
    "/usr/bin/git",
    ["-C", repositoryDirectory, "rev-parse", "HEAD"],
    { env: trustedGitEnvironment, encoding: "utf8" }
  ).trim();
  const diff = execFileSync(
    "/usr/bin/git",
    [
      "-C",
      repositoryDirectory,
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-renames",
      reviewFlowEvaluationReconciliationTargetCodeVersion,
      targetCodeVersion
    ],
    { env: trustedGitEnvironment }
  );
  const proof = reviewFlowEvaluationReconciliationPostCommitProofSchema.parse({
    schemaVersion: 1,
    artifactKind: "review_flow_evaluation_reconciliation_post_commit_proof",
    sourceCodeVersion:
      reviewFlowEvaluationReconciliationTargetCodeVersion,
    targetCodeVersion,
    diffSha256: digest(diff),
    changedPaths: [...reviewFlowEvaluationReconciliationPostCommitAllowedPaths],
    solVerdict: reviewFlowEvaluationReconciliationPostCommitSolVerdict
  });
  return {
    repositoryDirectory,
    proofPath: writePrivateJson(
      fixture.inputDirectory,
      fixture.privateRoot,
      fixture.workspace,
      "reconciliation-post-commit-proof.json",
      proof
    ),
    targetCodeVersion
  };
}

const fixtures: ReconciliationFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture.workspace, { recursive: true, force: true });
  }
});

describe("review-flow checkpoint reconciliation", () => {
  it("parses the exact compatibility proof and exposes a strict reconcile CLI", () => {
    const options = resolveReviewFlowEvaluationCliOptions([
      "--action=reconcile",
      "--authoritative-checkpoint=/private/authority.json",
      "--donor-checkpoint=/private/donor.json",
      "--compatibility-proof=/private/proof.json",
      "--output=/private/reconciled.json",
      "--dry-run"
    ]);
    expect(options).toEqual({
      action: "reconcile",
      authoritativeCheckpointPath: "/private/authority.json",
      donorCheckpointPath: "/private/donor.json",
      compatibilityProofPath: "/private/proof.json",
      reconciliationProofPath: null,
      outputPath: "/private/reconciled.json",
      dryRun: true
    });
    expect(reviewFlowEvaluationCompatibilityProofSchema.parse({
      schemaVersion: 1,
      artifactKind: "review_flow_evaluation_compatibility_proof",
      authorityCheckpointCodeVersion:
        reviewFlowEvaluationReconciliationAuthorityCodeVersion,
      authorityCheckpointSha256: digest("authority-checkpoint"),
      authorityDiffSha256:
        reviewFlowEvaluationReconciliationAuthorityDiffSha256,
      authorityChangedPaths: [
        ...reviewFlowEvaluationReconciliationAuthorityAllowedPaths
      ],
      authoritySolVerdict:
        reviewFlowEvaluationReconciliationAuthoritySolVerdict,
      sourceCodeVersion: reviewFlowEvaluationReconciliationSourceCodeVersion,
      targetCodeVersion: reviewFlowEvaluationReconciliationTargetCodeVersion,
      diffSha256: reviewFlowEvaluationReconciliationDiffSha256,
      changedPaths: [...reviewFlowEvaluationReconciliationAllowedPaths],
      solVerdict: reviewFlowEvaluationReconciliationSolVerdict
    }).changedPaths).toEqual([...reviewFlowEvaluationReconciliationAllowedPaths]);
    const postCommitOptions = resolveReviewFlowEvaluationCliOptions([
      "--action=reconcile",
      "--authoritative-checkpoint=/private/authority.json",
      "--donor-checkpoint=/private/donor.json",
      "--compatibility-proof=/private/proof.json",
      "--reconciliation-proof=/private/post-commit-proof.json",
      "--output=/private/reconciled.json"
    ]);
    expect(postCommitOptions).toMatchObject({
      action: "reconcile",
      reconciliationProofPath: "/private/post-commit-proof.json"
    });
    const oldRunOptions = resolveReviewFlowEvaluationCliOptions([
      "--manifest=/private/manifest.json",
      "--reveal-descriptor=/private/reveal.json",
      "--dataset-private-root=/private/dataset",
      "--private-dir=run",
      "--partition=development",
      "--label=baseline",
      "--variant=baseline"
    ]);
    expect(oldRunOptions.action).toBe("run");
    expect(() => resolveReviewFlowEvaluationCliOptions([
      "--dry-run",
      "--manifest=/private/manifest.json",
      "--reveal-descriptor=/private/reveal.json",
      "--dataset-private-root=/private/dataset",
      "--private-dir=run",
      "--partition=development",
      "--label=baseline",
      "--variant=baseline"
    ])).toThrow("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
  });

  it("dry-runs and writes an auditable 30-complete/2-failed sealed source", async () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const input = {
      authoritativeCheckpointPath: fixture.authorityPath,
      donorCheckpointPath: fixture.donorPath,
      compatibilityProofPath: fixture.proofPath,
      outputPath: fixture.outputPath,
      repositoryDirectory: fixture.repositoryDirectory,
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace
    };
    const dryRun = reconcileReviewFlowEvaluationCheckpoints({
      ...input,
      dryRun: true
    });
    expect(dryRun.summary).toMatchObject({
      expectedCaseCount: 32,
      donorCompletedCaseCount: 7,
      remainingCaseCount: 2,
      duplicateCaseCount: 0,
      missingCaseCount: 0,
      completedCaseCount: 30,
      failedCaseCount: 2,
      activeCaseCount: 0,
      pendingCaseCount: 0
    });
    expect(() => statSync(fixture.outputPath)).toThrow();

    const output = await runReviewFlowEvaluationReconciliationCli({
      options: {
        action: "reconcile",
        authoritativeCheckpointPath: fixture.authorityPath,
        donorCheckpointPath: fixture.donorPath,
        compatibilityProofPath: fixture.proofPath,
        outputPath: fixture.outputPath,
        dryRun: false
      },
      repositoryDirectory: fixture.repositoryDirectory,
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace,
      writeOutput: () => undefined
    });
    expect(output).toEqual(dryRun.summary);
    expect(statSync(fixture.outputPath).mode & 0o777).toBe(0o600);
    const parsed = reviewFlowEvaluationCheckpointSchema.parse(
      JSON.parse(readFileSync(fixture.outputPath, "utf8"))
    );
    expect(parsed.entries.filter((entry) => entry.status === "completed")).toHaveLength(30);
    expect(parsed.entries.filter((entry) => entry.status === "failed")).toHaveLength(2);
    expect(parsed.entries.some((entry) => entry.status === "active")).toBe(false);
    expect(parsed.entries.some((entry) => entry.status === "pending")).toBe(false);
    expect(parsed.executionSeal).toMatchObject({ complete: false });
    expect(parsed.termination).toBeNull();
    expect(parsed.publication).toBeNull();
    expect(parsed.reconciliation).toMatchObject({
      sourceCodeVersion: reviewFlowEvaluationReconciliationSourceCodeVersion,
      targetCodeVersion: reviewFlowEvaluationReconciliationTargetCodeVersion,
      compatibilityProofSha256: digest(readFileSync(fixture.proofPath))
    });
    const requeued = parsed.entries.find((entry) => entry.safeId === "case-0032");
    expect(requeued).toMatchObject({
      status: "failed",
      failure: { code: "REVIEW_FLOW_RECONCILIATION_REQUEUEABLE" }
    });
    expect(() => reviewFlowEvaluationCheckpointSchema.parse({
      ...parsed,
      reconciliation: {
        ...parsed.reconciliation!,
        requeueCaseIds: [...parsed.reconciliation!.requeueCaseIds].reverse()
      }
    })).toThrow();
    expect(formatReviewFlowEvaluationReconciliationSummary(output, false)).not.toContain("case-");
    for (let index = 0; index < 23; index += 1) {
      expect(parsed.entries[index]).toEqual(fixture.authority.entries[index]);
      expect(parsed.auditLedger!.cases[index]!.attempts).toEqual(
        fixture.authority.auditLedger!.cases[index]!.attempts
      );
    }
    for (let index = 0; index < 7; index += 1) {
      expect(parsed.entries[index + 23]).toEqual(fixture.donor.entries[index]);
      expect(parsed.auditLedger!.cases[index + 23]!.attempts).toEqual(
        fixture.donor.auditLedger!.cases[index]!.attempts
      );
    }
    const continuation = new ReviewFlowEvaluationCheckpoint({
      privateDirectory: join(fixture.privateRoot, "future-failed-only"),
      label: "future-failed-only",
      variant: parsed.variant,
      baselineLabel: parsed.baselineLabel,
      failedOnlySource: parsed,
      failedOnlyCaseIds: ["case-0031", "case-0032"],
      baselineBinding: parsed.baselineBinding,
      identity: parsed.identity,
      holdoutIdentity: parsed.holdoutIdentity,
      thresholdPolicySha256: parsed.thresholdPolicySha256,
      expectedCases: parsed.expectedCases,
      resume: false,
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace,
      now: () => new Date(timestamp),
      randomId: () => "33333333-3333-4333-8333-333333333333"
    });
    try {
      const continuationState = continuation.snapshot();
      expect(continuationState.entries.filter(
        (entry) => entry.status === "pending"
      ).map((entry) => entry.safeId)).toEqual([
        "case-0031",
        "case-0032"
      ]);
      expect(continuationState.failedOnlyContinuation!.selectedFailedCaseIds)
        .toEqual(["case-0031", "case-0032"]);
    } finally {
      continuation.close();
    }
  });
  it("binds the post-implementation HEAD and narrows future continuation drift", () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const postCommit = makePostCommitProof(fixture);
    const postCommitInput = {
      authoritativeCheckpointPath: fixture.authorityPath,
      donorCheckpointPath: fixture.donorPath,
      compatibilityProofPath: fixture.proofPath,
      outputPath: fixture.outputPath,
      repositoryDirectory: postCommit.repositoryDirectory,
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace,
      dryRun: true
    };
    expect(() => reconcileReviewFlowEvaluationCheckpoints(postCommitInput)).toThrow(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_REPOSITORY_INVALID"
    );
    const reconciled = reconcileReviewFlowEvaluationCheckpoints({
      ...postCommitInput,
      reconciliationProofPath: postCommit.proofPath
    });
    expect(reconciled.state.identity.codeIdentity.codeVersion).toBe(
      postCommit.targetCodeVersion
    );
    expect(reconciled.state.reconciliation?.postCommitCodeDelta).toMatchObject({
      sourceCodeVersion: reviewFlowEvaluationReconciliationTargetCodeVersion,
      targetCodeVersion: postCommit.targetCodeVersion,
      changedPaths: [...reviewFlowEvaluationReconciliationPostCommitAllowedPaths]
    });
    expect(reconciled.summary.reconciliationProofSha256).toBe(
      digest(readFileSync(postCommit.proofPath))
    );

    const activeAudit = reconciled.state.auditLedger!.cases.find(
      (entry) => entry.caseOrdinal === 32
    )!;
    const unknownCancelledAttempt = activeAudit.attempts[0]!;
    expect(unknownCancelledAttempt).toMatchObject({
      outcome: "failed",
      accountingComplete: false,
      errorCategory: "cancelled",
      errorCode: "LLM_CANCELLED"
    });
    expect(unknownCancelledAttempt.roleAttempts[0]).toMatchObject({
      outcome: "failed",
      dependencyBlocked: false,
      usageTotalTokens: null,
      responseByteCount: null
    });
    expect(
      summarizeReviewFlowEvaluationAuditLedger(reconciled.state.auditLedger)
    ).toMatchObject({
      exact: false,
      usageTotalTokens: 341,
      unknownUsageRoleCount: 11,
      responseBytes: 341,
      unknownResponseByteRoleCount: 11
    });

    const futureIdentity = reviewFlowEvaluationIdentitySchema.parse({
      ...reconciled.state.identity,
      codeIdentity: {
        ...reconciled.state.identity.codeIdentity,
        runnerSha256: digest("future-runner"),
        dependencyCodeSha256: digest("future-dependencies"),
        dependencyFileCount:
          reconciled.state.identity.codeIdentity.dependencyFileCount + 1,
      }
    });
    const continuation = new ReviewFlowEvaluationCheckpoint({
      privateDirectory: join(fixture.privateRoot, "future-bound-continuation"),
      label: "future-bound-continuation",
      variant: reconciled.state.variant,
      baselineLabel: reconciled.state.baselineLabel,
      failedOnlySource: reconciled.state,
      failedOnlyCaseIds: ["case-0031", "case-0032"],
      baselineBinding: reconciled.state.baselineBinding,
      identity: futureIdentity,
      holdoutIdentity: reconciled.state.holdoutIdentity,
      thresholdPolicySha256: reconciled.state.thresholdPolicySha256,
      expectedCases: reconciled.state.expectedCases,
      resume: false,
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace,
      now: () => new Date(timestamp),
      randomId: () => "44444444-4444-4444-8444-444444444444"
    });
    try {
      expect(
        continuation.snapshot().reconciliation?.postCommitCodeDelta
      ).toEqual(reconciled.state.reconciliation?.postCommitCodeDelta);
    } finally {
      continuation.close();
    }

    const changedProductionIdentity = reviewFlowEvaluationIdentitySchema.parse({
      ...futureIdentity,
      codeIdentity: {
        ...futureIdentity.codeIdentity,
        productionDependencyCodeSha256: digest("changed-production-dependencies")
      }
    });
    expect(() => new ReviewFlowEvaluationCheckpoint({
      privateDirectory: join(fixture.privateRoot, "future-production-drift"),
      label: "future-production-drift",
      variant: reconciled.state.variant,
      baselineLabel: reconciled.state.baselineLabel,
      failedOnlySource: reconciled.state,
      failedOnlyCaseIds: ["case-0031", "case-0032"],
      baselineBinding: reconciled.state.baselineBinding,
      identity: changedProductionIdentity,
      holdoutIdentity: reconciled.state.holdoutIdentity,
      thresholdPolicySha256: reconciled.state.thresholdPolicySha256,
      expectedCases: reconciled.state.expectedCases,
      resume: false,
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace,
      now: () => new Date(timestamp),
      randomId: () => "55555555-5555-4555-8555-555555555555"
    })).toThrow("REVIEW_FLOW_EVALUATION_FAILED_ONLY_IDENTITY_MISMATCH");
  });

  it("rejects tampered proof, unclean git, non-code identity drift, and incomplete donor accounting", () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const baseInput = {
      authoritativeCheckpointPath: fixture.authorityPath,
      donorCheckpointPath: fixture.donorPath,
      compatibilityProofPath: fixture.proofPath,
      outputPath: fixture.outputPath,
      repositoryDirectory: fixture.repositoryDirectory,
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace,
      dryRun: true
    };
    const tamperedProofPath = writePrivateJson(
      fixture.inputDirectory,
      fixture.privateRoot,
      fixture.workspace,
      "tampered-proof.json",
      {
        schemaVersion: 1,
        artifactKind: "review_flow_evaluation_compatibility_proof",
        authorityCheckpointCodeVersion:
          reviewFlowEvaluationReconciliationAuthorityCodeVersion,
        authorityCheckpointSha256: digest(readFileSync(fixture.authorityPath)),
        authorityDiffSha256:
          reviewFlowEvaluationReconciliationAuthorityDiffSha256,
        authorityChangedPaths: [
          ...reviewFlowEvaluationReconciliationAuthorityAllowedPaths
        ],
        authoritySolVerdict:
          reviewFlowEvaluationReconciliationAuthoritySolVerdict,
        sourceCodeVersion: reviewFlowEvaluationReconciliationSourceCodeVersion,
        targetCodeVersion: reviewFlowEvaluationReconciliationTargetCodeVersion,
        diffSha256: reviewFlowEvaluationReconciliationDiffSha256,
        changedPaths: [...reviewFlowEvaluationReconciliationAllowedPaths].reverse(),
        solVerdict: reviewFlowEvaluationReconciliationSolVerdict
      }
    );
    expect(() => reconcileReviewFlowEvaluationCheckpoints({
      ...baseInput,
      compatibilityProofPath: tamperedProofPath
    })).toThrow("REVIEW_FLOW_EVALUATION_RECONCILIATION_PROOF_INVALID");
    const mismatchedAuthorityProofPath = writePrivateJson(
      fixture.inputDirectory,
      fixture.privateRoot,
      fixture.workspace,
      "mismatched-authority-proof.json",
      {
        ...JSON.parse(readFileSync(fixture.proofPath, "utf8")),
        authorityCheckpointSha256: digest("different-authority-checkpoint")
      }
    );
    expect(() => reconcileReviewFlowEvaluationCheckpoints({
      ...baseInput,
      compatibilityProofPath: mismatchedAuthorityProofPath
    })).toThrow("REVIEW_FLOW_EVALUATION_RECONCILIATION_PROOF_INVALID");


    writeFileSync(join(fixture.repositoryDirectory, "unclean.txt"), "unclean\n", {
      mode: 0o600
    });
    expect(() => reconcileReviewFlowEvaluationCheckpoints(baseInput)).toThrow(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_REPOSITORY_INVALID"
    );
    rmSync(join(fixture.repositoryDirectory, "unclean.txt"));

    const changedDonor = {
      ...fixture.donor,
      identity: {
        ...fixture.donor.identity,
        configurationSummary: {
          ...fixture.donor.identity.configurationSummary,
          concurrency: 2
        }
      }
    };
    const changedDonorPath = writePrivateJson(
      fixture.inputDirectory,
      fixture.privateRoot,
      fixture.workspace,
      "changed-donor.json",
      {
        ...changedDonor,
        identityFingerprint: identityFingerprint(changedDonor.identity)
      }
    );
    expect(() => reconcileReviewFlowEvaluationCheckpoints({
      ...baseInput,
      donorCheckpointPath: changedDonorPath
    })).toThrow("REVIEW_FLOW_EVALUATION_RECONCILIATION_IDENTITY_MISMATCH");

    const donorWithIncompleteAccounting = {
      ...fixture.donor,
      auditLedger: {
        ...fixture.donor.auditLedger!,
        cases: fixture.donor.auditLedger!.cases.map((entry, index) =>
          index === 0
            ? {
                ...entry,
                attempts: entry.attempts.map((attempt) => ({
                  ...attempt,
                  accountingComplete: false
                }))
              }
            : entry
        )
      }
    };
    const incompleteDonorPath = writePrivateJson(
      fixture.inputDirectory,
      fixture.privateRoot,
      fixture.workspace,
      "incomplete-donor.json",
      donorWithIncompleteAccounting
    );
    expect(() => reconcileReviewFlowEvaluationCheckpoints({
      ...baseInput,
      donorCheckpointPath: incompleteDonorPath
    })).toThrow("REVIEW_FLOW_EVALUATION_RECONCILIATION_LEDGER_INVALID");
  });

  it("rejects duplicate, missing, and overlapping donor case identities", () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const baseInput = {
      authoritativeCheckpointPath: fixture.authorityPath,
      donorCheckpointPath: fixture.donorPath,
      compatibilityProofPath: fixture.proofPath,
      outputPath: fixture.outputPath,
      repositoryDirectory: fixture.repositoryDirectory,
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace,
      dryRun: true
    };
    const duplicateDonorPath = writePrivateJson(
      fixture.inputDirectory,
      fixture.privateRoot,
      fixture.workspace,
      "duplicate-donor.json",
      {
        ...fixture.donor,
        expectedCases: [
          ...fixture.donor.expectedCases.slice(0, 8),
          fixture.donor.expectedCases[7]
        ]
      }
    );
    expect(() => reconcileReviewFlowEvaluationCheckpoints({
      ...baseInput,
      donorCheckpointPath: duplicateDonorPath
    })).toThrow("REVIEW_FLOW_EVALUATION_RECONCILIATION_DONOR_INVALID");

    const missingDonorPath = writePrivateJson(
      fixture.inputDirectory,
      fixture.privateRoot,
      fixture.workspace,
      "missing-donor.json",
      {
        ...fixture.donor,
        expectedCases: fixture.donor.expectedCases.slice(0, 8),
        entries: fixture.donor.entries.slice(0, 8),
        auditLedger: {
          ...fixture.donor.auditLedger!,
          cases: fixture.donor.auditLedger!.cases.slice(0, 8)
        }
      }
    );
    expect(() => reconcileReviewFlowEvaluationCheckpoints({
      ...baseInput,
      donorCheckpointPath: missingDonorPath
    })).toThrow("REVIEW_FLOW_EVALUATION_RECONCILIATION_DONOR_INVALID");

    const overlappingDonorPath = writePrivateJson(
      fixture.inputDirectory,
      fixture.privateRoot,
      fixture.workspace,
      "overlapping-donor.json",
      {
        ...fixture.donor,
        expectedCases: [
          ...fixture.donor.expectedCases.slice(0, 8),
          fixture.authority.expectedCases[0]
        ]
      }
    );
    expect(() => reconcileReviewFlowEvaluationCheckpoints({
      ...baseInput,
      donorCheckpointPath: overlappingDonorPath
    })).toThrow();
  });

  it("rejects proof symlinks and hardlinks", () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const baseInput = {
      authoritativeCheckpointPath: fixture.authorityPath,
      donorCheckpointPath: fixture.donorPath,
      outputPath: fixture.outputPath,
      repositoryDirectory: fixture.repositoryDirectory,
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace,
      dryRun: true
    };
    const symlinkPath = join(fixture.inputDirectory, "proof-symlink.json");
    symlinkSync(fixture.proofPath, symlinkPath);
    expect(() => reconcileReviewFlowEvaluationCheckpoints({
      ...baseInput,
      compatibilityProofPath: symlinkPath
    })).toThrow("REVIEW_FLOW_EVALUATION_RECONCILIATION_PROOF_INVALID");

    const hardlinkPath = join(fixture.inputDirectory, "proof-hardlink.json");
    linkSync(fixture.proofPath, hardlinkPath);
    expect(() => reconcileReviewFlowEvaluationCheckpoints({
      ...baseInput,
      compatibilityProofPath: hardlinkPath
    })).toThrow("REVIEW_FLOW_EVALUATION_RECONCILIATION_PROOF_INVALID");
  });
  it("rejects post-commit proof mode, symlink, and hardlink substitutions", () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const postCommit = makePostCommitProof(fixture);
    const baseInput = {
      authoritativeCheckpointPath: fixture.authorityPath,
      donorCheckpointPath: fixture.donorPath,
      compatibilityProofPath: fixture.proofPath,
      reconciliationProofPath: postCommit.proofPath,
      outputPath: fixture.outputPath,
      repositoryDirectory: postCommit.repositoryDirectory,
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace,
      dryRun: true
    };
    const symlinkPath = join(fixture.inputDirectory, "post-proof-symlink.json");
    symlinkSync(postCommit.proofPath, symlinkPath);
    expect(() => reconcileReviewFlowEvaluationCheckpoints({
      ...baseInput,
      reconciliationProofPath: symlinkPath
    })).toThrow("REVIEW_FLOW_EVALUATION_RECONCILIATION_PROOF_INVALID");

    const hardlinkPath = join(fixture.inputDirectory, "post-proof-hardlink.json");
    linkSync(postCommit.proofPath, hardlinkPath);
    expect(() => reconcileReviewFlowEvaluationCheckpoints({
      ...baseInput,
      reconciliationProofPath: hardlinkPath
    })).toThrow("REVIEW_FLOW_EVALUATION_RECONCILIATION_PROOF_INVALID");

    chmodSync(postCommit.proofPath, 0o644);
    expect(() => reconcileReviewFlowEvaluationCheckpoints(baseInput)).toThrow(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_PROOF_INVALID"
    );
  });

  it("rejects an unauthorized committed code delta", () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    writeFileSync(join(fixture.repositoryDirectory, "unauthorized.txt"), "x\\n", {
      mode: 0o600
    });
    execFileSync(
      "/usr/bin/git",
      ["-C", fixture.repositoryDirectory, "add", "--", "unauthorized.txt"],
      { env: trustedGitEnvironment }
    );
    execFileSync(
      "/usr/bin/git",
      [
        "-C",
        fixture.repositoryDirectory,
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "user.name=fixture",
        "commit",
        "-m",
        "unauthorized fixture delta"
      ],
      { env: trustedGitEnvironment }
    );
    expect(() => reconcileReviewFlowEvaluationCheckpoints({
      authoritativeCheckpointPath: fixture.authorityPath,
      donorCheckpointPath: fixture.donorPath,
      compatibilityProofPath: fixture.proofPath,
      outputPath: fixture.outputPath,
      repositoryDirectory: fixture.repositoryDirectory,
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace,
      dryRun: true
    })).toThrow("REVIEW_FLOW_EVALUATION_RECONCILIATION_REPOSITORY_INVALID");
  });

  it("rejects a proof with unsafe private permissions", () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    chmodSync(fixture.proofPath, 0o644);
    expect(() => reconcileReviewFlowEvaluationCheckpoints({
      authoritativeCheckpointPath: fixture.authorityPath,
      donorCheckpointPath: fixture.donorPath,
      compatibilityProofPath: fixture.proofPath,
      outputPath: fixture.outputPath,
      repositoryDirectory: fixture.repositoryDirectory,
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace,
      dryRun: true
    })).toThrow();
  });
});
