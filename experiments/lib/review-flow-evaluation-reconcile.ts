import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import {
  closePrivateDirectory,
  openExistingPrivateDirectory,
  preparePrivateDirectory,
  projectPrivateRoot,
  workspaceRoot,
  type PrivateDirectoryHandle
} from "../../scripts/private-runtime.mjs";
import {
  readPrivateArtifactBytes,
  writePrivateArtifactExclusive
} from "./private-artifact-io";
import { withTrustedGitSnapshot } from "../../scripts/trusted-git-state.mjs";
import { hashCanonicalValue } from "../../src/review-flow/evidence";
import {
  reviewFlowRoleStage,
  reviewFlowRoleAttemptAuditSchema
} from "../../src/review-flow/orchestrator";
import {
  reviewFlowRoleSchema,
  type ReviewFlowRole
} from "../../src/review-flow/schemas";
import {
  reviewFlowEvaluationCheckpointSchema,
  reviewFlowEvaluationExecutionCompletionFingerprint,
  reviewFlowEvaluationIdentitySchema,
  reviewFlowEvaluationReconciliationBindingSchema,
  type ReviewFlowEvaluationCheckpointState,
  type ReviewFlowEvaluationEntry,
  type ReviewFlowEvaluationExpectedCase,
  type ReviewFlowEvaluationReconciliationBinding
} from "./review-flow-evaluation-state";
import {
  reviewFlowEvaluationCaseSelectionSchema,
  reviewFlowEvaluationOrderedSelectionSha256,
  type ReviewFlowEvaluationCaseSelection
} from "./review-flow-evaluation-dataset";
import { z } from "zod";

export const reviewFlowEvaluationReconciliationAuthorityCodeVersion =
  "56065f656b44638f012454fdc878b53570194343" as const;
export const reviewFlowEvaluationReconciliationAuthorityDiffSha256 =
  "ae8b3d06a2a95b9c2a0e2a2fb6eaa5ff1c3d07188b2045c2d1e704f2bc69692c" as const;
export const reviewFlowEvaluationReconciliationAuthoritySolVerdict =
  "bounded_event_shape_retry_only" as const;

export const reviewFlowEvaluationReconciliationSourceCodeVersion =
  "3c0005a8054056748e2adf99cc3ada8aa9bca4c2" as const;
export const reviewFlowEvaluationReconciliationTargetCodeVersion =
  "fa2929af05cd7564a3bb1a98b072f639524627b0" as const;
export const reviewFlowEvaluationReconciliationDiffSha256 =
  "04cd8432202f37c3cc400722776891896eb4b9f90356e232ae0f0f266876a8a4" as const;
export const reviewFlowEvaluationReconciliationSolVerdict =
  "safe_stream_telemetry_only" as const;

export const reviewFlowEvaluationReconciliationAllowedPaths = Object.freeze([
  "experiments/eval-review-flow.ts",
  "experiments/lib/review-flow-evaluation-adapter.ts",
  "experiments/lib/review-flow-evaluation-state.ts",
  "src/llm.ts",
  "test/llm-safe-stream-telemetry.test.ts",
  "test/review-flow-safe-stream-checkpoint.test.ts"
] as const);
export const reviewFlowEvaluationReconciliationAuthorityAllowedPaths =
  Object.freeze([
    "experiments/eval-review-flow.ts",
    "experiments/lib/review-flow-evaluation-adapter.ts",
    "experiments/lib/review-flow-evaluation-config.ts",
    "experiments/lib/review-flow-evaluation-state.ts",
    "src/llm.ts",
    "test/llm.test.ts",
    "test/review-flow-evaluation-config.test.ts",
    "test/review-flow-evaluation.test.ts"
  ] as const);

export const reviewFlowEvaluationReconciliationPostCommitSourceCodeVersion =
  reviewFlowEvaluationReconciliationTargetCodeVersion;
export const reviewFlowEvaluationReconciliationPostCommitAllowedPaths =
  Object.freeze([
    "config/review-flow-runtime.json",
    "experiments/eval-review-flow.ts",
    "experiments/lib/review-flow-evaluation-reconcile.ts",
    "experiments/lib/review-flow-evaluation-state.ts",
    "scripts/trusted-git-state.mjs",
    "test/review-flow-evaluation-reconcile.test.ts"
  ] as const);
export const reviewFlowEvaluationReconciliationPostCommitSolVerdict =
  "reconciliation_projection_only" as const;

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const commitVersionSchema = z.string().regex(
  /^(?!0{40}$)[0-9a-f]{40}$/u
);
const repositoryPathSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u
);

export const reviewFlowEvaluationCompatibilityProofSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal(
      "review_flow_evaluation_compatibility_proof"
    ),
    authorityCheckpointCodeVersion: z.literal(
      reviewFlowEvaluationReconciliationAuthorityCodeVersion
    ),
    authorityCheckpointSha256: digestSchema,
    authorityDiffSha256: z.literal(
      reviewFlowEvaluationReconciliationAuthorityDiffSha256
    ),
    authorityChangedPaths: z
      .array(repositoryPathSchema)
      .length(
        reviewFlowEvaluationReconciliationAuthorityAllowedPaths.length
      ),
    authoritySolVerdict: z.literal(
      reviewFlowEvaluationReconciliationAuthoritySolVerdict
    ),
    sourceCodeVersion: z.literal(
      reviewFlowEvaluationReconciliationSourceCodeVersion
    ),
    targetCodeVersion: z.literal(
      reviewFlowEvaluationReconciliationTargetCodeVersion
    ),
    diffSha256: z.literal(reviewFlowEvaluationReconciliationDiffSha256),
    changedPaths: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u))
      .length(reviewFlowEvaluationReconciliationAllowedPaths.length),
    solVerdict: z.literal(reviewFlowEvaluationReconciliationSolVerdict)
  })
  .strict()
  .superRefine((proof, context) => {
    if (
      proof.authorityChangedPaths.some(
        (path, index) =>
          path !== reviewFlowEvaluationReconciliationAuthorityAllowedPaths[index]
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["authorityChangedPaths"],
        message: "authority proof changed paths are not the exact allowlist."
      });
    }
    const expectedPaths = reviewFlowEvaluationReconciliationAllowedPaths;
    if (
      proof.changedPaths.some(
        (path, index) => path !== expectedPaths[index]
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["changedPaths"],
        message: "compatibility proof changed paths are not the exact allowlist."
      });
    }
  });
export type ReviewFlowEvaluationCompatibilityProof = z.infer<
  typeof reviewFlowEvaluationCompatibilityProofSchema
>;
export const reviewFlowEvaluationReconciliationPostCommitProofSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal(
      "review_flow_evaluation_reconciliation_post_commit_proof"
    ),
    sourceCodeVersion: z.literal(
      reviewFlowEvaluationReconciliationPostCommitSourceCodeVersion
    ),
    targetCodeVersion: commitVersionSchema,
    diffSha256: digestSchema,
    changedPaths: z
      .array(repositoryPathSchema)
      .length(
        reviewFlowEvaluationReconciliationPostCommitAllowedPaths.length
      ),
    solVerdict: z.literal(
      reviewFlowEvaluationReconciliationPostCommitSolVerdict
    )
  })
  .strict()
  .superRefine((proof, context) => {
    if (
      proof.targetCodeVersion === proof.sourceCodeVersion ||
      proof.changedPaths.some(
        (path, index) =>
          path !== reviewFlowEvaluationReconciliationPostCommitAllowedPaths[index]
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["changedPaths"],
        message: "post-commit proof changed paths are not the exact allowlist."
      });
    }
  });
export type ReviewFlowEvaluationReconciliationPostCommitProof = z.infer<
  typeof reviewFlowEvaluationReconciliationPostCommitProofSchema
>;

export type ReviewFlowEvaluationReconciliationErrorCode =
  | "REVIEW_FLOW_EVALUATION_RECONCILIATION_ARGUMENT_INVALID"
  | "REVIEW_FLOW_EVALUATION_RECONCILIATION_PROOF_INVALID"
  | "REVIEW_FLOW_EVALUATION_RECONCILIATION_REPOSITORY_INVALID"
  | "REVIEW_FLOW_EVALUATION_RECONCILIATION_AUTHORITY_INVALID"
  | "REVIEW_FLOW_EVALUATION_RECONCILIATION_DONOR_INVALID"
  | "REVIEW_FLOW_EVALUATION_RECONCILIATION_IDENTITY_MISMATCH"
  | "REVIEW_FLOW_EVALUATION_RECONCILIATION_CASE_SET_MISMATCH"
  | "REVIEW_FLOW_EVALUATION_RECONCILIATION_LEDGER_INVALID"
  | "REVIEW_FLOW_EVALUATION_RECONCILIATION_OUTPUT_INVALID"
  | "REVIEW_FLOW_EVALUATION_RECONCILIATION_OUTPUT_WRITE_FAILED";

export class ReviewFlowEvaluationReconciliationError extends Error {
  readonly code: ReviewFlowEvaluationReconciliationErrorCode;

  constructor(code: ReviewFlowEvaluationReconciliationErrorCode) {
    super(code);
    this.name = "ReviewFlowEvaluationReconciliationError";
    this.code = code;
  }
}

export interface ReviewFlowEvaluationReconciliationCliOptions {
  readonly action: "reconcile";
  readonly authoritativeCheckpointPath: string;
  readonly donorCheckpointPath: string;
  readonly compatibilityProofPath: string;
  readonly reconciliationProofPath?: string | null;
  readonly outputPath: string;
  readonly dryRun: boolean;
}

export interface ReviewFlowEvaluationReconciliationInput {
  readonly authoritativeCheckpointPath: string;
  readonly donorCheckpointPath: string;
  readonly compatibilityProofPath: string;
  readonly reconciliationProofPath?: string;
  readonly outputPath?: string;
  readonly dryRun?: boolean;
  readonly repositoryDirectory?: string;
  readonly privateRoot?: string;
  readonly containingWorkspace?: string;
}

export interface ReviewFlowEvaluationReconciliationSummary {
  readonly expectedCaseCount: 32;
  readonly donorCompletedCaseCount: 7;
  readonly remainingCaseCount: 2;
  readonly duplicateCaseCount: 0;
  readonly missingCaseCount: 0;
  readonly completedCaseCount: 30;
  readonly failedCaseCount: 2;
  readonly activeCaseCount: 0;
  readonly pendingCaseCount: 0;
  readonly identityFingerprint: string;
  readonly completionFingerprint: string;
  readonly stateFingerprint: string;
  readonly compatibilityProofSha256: string;
  readonly reconciliationProofSha256: string | null;
}

export interface ReviewFlowEvaluationReconciliationResult {
  readonly state: ReviewFlowEvaluationCheckpointState;
  readonly summary: ReviewFlowEvaluationReconciliationSummary;
  readonly serializedState: string;
}

const maximumCheckpointBytes = 16 * 1024 * 1024;
function parseCompatibilityProof(
  value: unknown
): ReviewFlowEvaluationCompatibilityProof {
  try {
    return reviewFlowEvaluationCompatibilityProofSchema.parse(value);
  } catch {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_PROOF_INVALID"
    );
  }
}
function parseReconciliationPostCommitProof(
  value: unknown
): ReviewFlowEvaluationReconciliationPostCommitProof {
  try {
    return reviewFlowEvaluationReconciliationPostCommitProofSchema.parse(value);
  } catch {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_PROOF_INVALID"
    );
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function readPrivateJson<T>(
  filePath: string,
  parse: (value: unknown) => T,
  errorCode:
    | "REVIEW_FLOW_EVALUATION_RECONCILIATION_PROOF_INVALID"
    | "REVIEW_FLOW_EVALUATION_RECONCILIATION_AUTHORITY_INVALID"
    | "REVIEW_FLOW_EVALUATION_RECONCILIATION_DONOR_INVALID",
  privateRoot: string,
  containingWorkspace: string
): { readonly bytes: Buffer; readonly value: T } {
  if (!isAbsolute(filePath)) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_ARGUMENT_INVALID"
    );
  }
  let directory: PrivateDirectoryHandle | undefined;
  try {
    directory = openExistingPrivateDirectory(resolve(dirname(filePath)), {
      privateRoot,
      containingWorkspace
    });
    const bytes = readPrivateArtifactBytes(
      directory,
      basename(filePath),
      maximumCheckpointBytes
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = parse(JSON.parse(text));
    return { bytes, value };
  } catch (error) {
    if (error instanceof ReviewFlowEvaluationReconciliationError) {
      throw error;
    }
    throw new ReviewFlowEvaluationReconciliationError(errorCode);
  } finally {
    if (directory !== undefined) {
      closePrivateDirectory(directory);
    }
  }
}

function readCheckpoint(
  filePath: string,
  errorCode:
    | "REVIEW_FLOW_EVALUATION_RECONCILIATION_AUTHORITY_INVALID"
    | "REVIEW_FLOW_EVALUATION_RECONCILIATION_DONOR_INVALID",
  privateRoot: string,
  containingWorkspace: string
): { readonly bytes: Buffer; readonly value: ReviewFlowEvaluationCheckpointState } {
  return readPrivateJson(
    filePath,
    (value) => reviewFlowEvaluationCheckpointSchema.parse(value),
    errorCode,
    privateRoot,
    containingWorkspace
  );
}

function readProof(
  filePath: string,
  privateRoot: string,
  containingWorkspace: string
): { readonly bytes: Buffer; readonly value: ReviewFlowEvaluationCompatibilityProof } {
  return readPrivateJson(
    filePath,
    parseCompatibilityProof,
    "REVIEW_FLOW_EVALUATION_RECONCILIATION_PROOF_INVALID",
    privateRoot,
    containingWorkspace
  );
}

function readReconciliationPostCommitProof(
  filePath: string,
  privateRoot: string,
  containingWorkspace: string
): {
  readonly bytes: Buffer;
  readonly value: ReviewFlowEvaluationReconciliationPostCommitProof;
} {
  return readPrivateJson(
    filePath,
    parseReconciliationPostCommitProof,
    "REVIEW_FLOW_EVALUATION_RECONCILIATION_PROOF_INVALID",
    privateRoot,
    containingWorkspace
  );
}

function assertDifferentPaths(paths: readonly string[]): void {
  const resolved = paths.map((path) => {
    if (!isAbsolute(path)) {
      throw new ReviewFlowEvaluationReconciliationError(
        "REVIEW_FLOW_EVALUATION_RECONCILIATION_ARGUMENT_INVALID"
      );
    }
    return resolve(path);
  });
  if (new Set(resolved).size !== resolved.length) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_ARGUMENT_INVALID"
    );
  }
}

function assertOutputLocation(
  outputPath: string,
  privateRoot: string
): void {
  if (!isAbsolute(outputPath) || !isAbsolute(privateRoot)) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_ARGUMENT_INVALID"
    );
  }
  const root = resolve(privateRoot);
  const parent = resolve(dirname(outputPath));
  if (parent !== root && !parent.startsWith(`${root}${sep}`)) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_OUTPUT_INVALID"
    );
  }
}

interface VerifiedReconciliationCodeBinding {
  readonly currentCodeVersion: string;
  readonly postCommitProof: ReviewFlowEvaluationReconciliationPostCommitProof | null;
  readonly postCommitProofSha256: string | null;
}

interface TrustedGitSnapshot {
  readonly headCodeVersion: string;
  run(
    commandArguments: readonly string[],
    options?: { readonly encoding?: "utf8" }
  ): Buffer | string;
}

function assertExactGitDiff(
  git: TrustedGitSnapshot,
  sourceCodeVersion: string,
  targetCodeVersion: string,
  expectedDiffSha256: string,
  expectedPaths: readonly string[]
): void {
  const diff = git.run(
    [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-renames",
      sourceCodeVersion,
      targetCodeVersion
    ],
    {}
  );
  const changedPathsText = git.run(
    [
      "diff",
      "--name-only",
      "--no-ext-diff",
      "--no-renames",
      sourceCodeVersion,
      targetCodeVersion
    ],
    { encoding: "utf8" }
  );
  const changedPaths = String(changedPathsText)
    .split("\n")
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .sort();
  if (
    sha256(typeof diff === "string" ? Buffer.from(diff) : diff) !==
      expectedDiffSha256 ||
    JSON.stringify(changedPaths) !== JSON.stringify([...expectedPaths])
  ) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_REPOSITORY_INVALID"
    );
  }
}

function verifyCompatibilityProof(
  proof: ReviewFlowEvaluationCompatibilityProof,
  postCommitProof: {
    readonly bytes: Buffer;
    readonly value: ReviewFlowEvaluationReconciliationPostCommitProof;
  } | null,
  repositoryDirectory: string
): VerifiedReconciliationCodeBinding {
  try {
    return withTrustedGitSnapshot(repositoryDirectory, (git) => {
      const status = git.run(
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { encoding: "utf8" }
      );
      const trackedPrivatePaths = git.run(["ls-files", "private"], {
        encoding: "utf8"
      });
      if (status.length !== 0 || trackedPrivatePaths.length !== 0) {
        throw new ReviewFlowEvaluationReconciliationError(
          "REVIEW_FLOW_EVALUATION_RECONCILIATION_REPOSITORY_INVALID"
        );
      }
      assertExactGitDiff(
        git,
        proof.authorityCheckpointCodeVersion,
        proof.sourceCodeVersion,
        proof.authorityDiffSha256,
        reviewFlowEvaluationReconciliationAuthorityAllowedPaths
      );
      assertExactGitDiff(
        git,
        proof.sourceCodeVersion,
        proof.targetCodeVersion,
        proof.diffSha256,
        reviewFlowEvaluationReconciliationAllowedPaths
      );
      const currentCodeVersion = git.headCodeVersion;
      if (postCommitProof === null) {
        if (
          currentCodeVersion !==
          reviewFlowEvaluationReconciliationTargetCodeVersion
        ) {
          throw new ReviewFlowEvaluationReconciliationError(
            "REVIEW_FLOW_EVALUATION_RECONCILIATION_REPOSITORY_INVALID"
          );
        }
        return {
          currentCodeVersion,
          postCommitProof: null,
          postCommitProofSha256: null
        };
      }
      if (currentCodeVersion !== postCommitProof.value.targetCodeVersion) {
        throw new ReviewFlowEvaluationReconciliationError(
          "REVIEW_FLOW_EVALUATION_RECONCILIATION_REPOSITORY_INVALID"
        );
      }
      assertExactGitDiff(
        git,
        postCommitProof.value.sourceCodeVersion,
        postCommitProof.value.targetCodeVersion,
        postCommitProof.value.diffSha256,
        reviewFlowEvaluationReconciliationPostCommitAllowedPaths
      );
      return {
        currentCodeVersion,
        postCommitProof: postCommitProof.value,
        postCommitProofSha256: sha256(postCommitProof.bytes)
      };
    });
  } catch (error) {
    if (error instanceof ReviewFlowEvaluationReconciliationError) {
      throw error;
    }
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_REPOSITORY_INVALID"
    );
  }
}

function countStatuses(state: ReviewFlowEvaluationCheckpointState): {
  readonly completed: number;
  readonly failed: number;
  readonly active: number;
  readonly pending: number;
} {
  return state.entries.reduce(
    (counts, entry) => {
      counts[entry.status] += 1;
      return counts;
    },
    { completed: 0, failed: 0, active: 0, pending: 0 }
  );
}

function assertExpectedAndEntryBindings(
  state: ReviewFlowEvaluationCheckpointState,
  expectedCount: number,
  errorCode:
    | "REVIEW_FLOW_EVALUATION_RECONCILIATION_AUTHORITY_INVALID"
    | "REVIEW_FLOW_EVALUATION_RECONCILIATION_DONOR_INVALID"
): Map<string, ReviewFlowEvaluationEntry> {
  if (
    state.expectedCases.length !== expectedCount ||
    state.entries.length !== expectedCount
  ) {
    throw new ReviewFlowEvaluationReconciliationError(errorCode);
  }
  const expectedIds = new Set<string>();
  const entries = new Map<string, ReviewFlowEvaluationEntry>();
  for (let index = 0; index < expectedCount; index += 1) {
    const expected = state.expectedCases[index]!;
    const entry = state.entries[index]!;
    if (
      expectedIds.has(expected.safeId) ||
      entries.has(entry.safeId) ||
      expected.safeId !== entry.safeId
    ) {
      throw new ReviewFlowEvaluationReconciliationError(errorCode);
    }
    expectedIds.add(expected.safeId);
    entries.set(entry.safeId, entry);
  }
  return entries;
}
type ReviewFlowEvaluationAuditCase = NonNullable<
  ReviewFlowEvaluationCheckpointState["auditLedger"]
>["cases"][number];
function assertAuditLedger(
  state: ReviewFlowEvaluationCheckpointState,
  errorCode:
    | "REVIEW_FLOW_EVALUATION_RECONCILIATION_AUTHORITY_INVALID"
    | "REVIEW_FLOW_EVALUATION_RECONCILIATION_DONOR_INVALID"
): Map<string, ReviewFlowEvaluationAuditCase> {
  if (state.auditLedger === null) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_LEDGER_INVALID"
    );
  }
  const ledgerByOrdinal = new Map<number, ReviewFlowEvaluationAuditCase>();
  for (const caseLedger of state.auditLedger.cases) {
    if (
      ledgerByOrdinal.has(caseLedger.caseOrdinal) ||
      caseLedger.caseOrdinal < 1 ||
      caseLedger.caseOrdinal > state.expectedCases.length
    ) {
      throw new ReviewFlowEvaluationReconciliationError(errorCode);
    }
    ledgerByOrdinal.set(caseLedger.caseOrdinal, caseLedger);
  }
  if (ledgerByOrdinal.size !== state.expectedCases.length) {
    throw new ReviewFlowEvaluationReconciliationError(errorCode);
  }
  const bySafeId = new Map<string, ReviewFlowEvaluationAuditCase>();
  for (let index = 0; index < state.expectedCases.length; index += 1) {
    const caseLedger = ledgerByOrdinal.get(index + 1);
    if (caseLedger === undefined) {
      throw new ReviewFlowEvaluationReconciliationError(errorCode);
    }
    bySafeId.set(state.expectedCases[index]!.safeId, caseLedger);
  }
  return bySafeId;
}

function assertAuthorityCheckpoint(
  state: ReviewFlowEvaluationCheckpointState
): Map<string, ReviewFlowEvaluationEntry> {
  if (
    state.identity.caseSelection !== undefined ||
    state.executionSeal === null ||
    state.executionSeal.complete ||
    state.termination !== null
  ) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_AUTHORITY_INVALID"
    );
  }
  const counts = countStatuses(state);
  if (
    counts.completed !== 23 ||
    counts.failed !== 9 ||
    counts.active !== 0 ||
    counts.pending !== 0
  ) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_AUTHORITY_INVALID"
    );
  }
  assertExpectedAndEntryBindings(
    state,
    32,
    "REVIEW_FLOW_EVALUATION_RECONCILIATION_AUTHORITY_INVALID"
  );
  assertAuditLedger(
    state,
    "REVIEW_FLOW_EVALUATION_RECONCILIATION_AUTHORITY_INVALID"
  );
  return new Map(state.entries.map((entry) => [entry.safeId, entry]));
}

function assertPrivateSelection(
  state: ReviewFlowEvaluationCheckpointState
): Extract<ReviewFlowEvaluationCaseSelection, { readonly selector: "private-file-v1" }> {
  if (state.identity.purpose !== "development") {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_DONOR_INVALID"
    );
  }
  const selection = state.identity.caseSelection;
  const parsed = reviewFlowEvaluationCaseSelectionSchema.safeParse(selection);
  if (!parsed.success || parsed.data.selector !== "private-file-v1") {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_DONOR_INVALID"
    );
  }
  if (
    parsed.data.parentCaseCount !== 32 ||
    parsed.data.parentDatasetFingerprint !== state.identity.datasetFingerprint ||
    parsed.data.parentManifestSha256 !== state.identity.manifestSha256 ||
    parsed.data.selectedCaseCount !== 9 ||
    state.expectedCases.length !== 9 ||
    reviewFlowEvaluationOrderedSelectionSha256(state.expectedCases) !==
      parsed.data.orderedSelectionSha256 ||
    parsed.data.selectedCaseSetSha256 !== parsed.data.orderedSelectionSha256
  ) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_CASE_SET_MISMATCH"
    );
  }
  return parsed.data;
}

function assertDonorCheckpoint(
  state: ReviewFlowEvaluationCheckpointState
): {
  readonly entries: Map<string, ReviewFlowEvaluationEntry>;
  readonly ledger: Map<string, ReviewFlowEvaluationAuditCase>;
} {
  assertPrivateSelection(state);
  if (
    state.executionSeal !== null ||
    state.termination === null ||
    state.termination.signal !== "SIGTERM"
  ) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_DONOR_INVALID"
    );
  }
  const counts = countStatuses(state);
  if (
    counts.completed !== 7 ||
    counts.failed !== 1 ||
    counts.active !== 1 ||
    counts.pending !== 0
  ) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_DONOR_INVALID"
    );
  }
  const entries = assertExpectedAndEntryBindings(
    state,
    9,
    "REVIEW_FLOW_EVALUATION_RECONCILIATION_DONOR_INVALID"
  );
  const ledger = assertAuditLedger(
    state,
    "REVIEW_FLOW_EVALUATION_RECONCILIATION_DONOR_INVALID"
  );
  for (const entry of state.entries) {
    const caseLedger = ledger.get(entry.safeId);
    if (caseLedger === undefined) {
      throw new ReviewFlowEvaluationReconciliationError(
        "REVIEW_FLOW_EVALUATION_RECONCILIATION_LEDGER_INVALID"
      );
    }
    if (entry.status !== "active" && caseLedger.attempts.length === 0) {
      throw new ReviewFlowEvaluationReconciliationError(
        "REVIEW_FLOW_EVALUATION_RECONCILIATION_LEDGER_INVALID"
      );
    }
    const latest = caseLedger.attempts[caseLedger.attempts.length - 1]!;
    if (entry.status === "completed") {
      if (
        entry.projection.roleReceipts.length !== reviewFlowRoleSchema.options.length ||
        latest.outcome !== "completed" ||
        !latest.accountingComplete ||
        latest.roleAttempts.length !== reviewFlowRoleSchema.options.length ||
        latest.roleAttempts.some((role) => role.outcome !== "completed")
      ) {
        throw new ReviewFlowEvaluationReconciliationError(
          "REVIEW_FLOW_EVALUATION_RECONCILIATION_LEDGER_INVALID"
        );
      }
    } else if (entry.status === "failed" && latest.outcome !== "failed") {
      throw new ReviewFlowEvaluationReconciliationError(
        "REVIEW_FLOW_EVALUATION_RECONCILIATION_LEDGER_INVALID"
      );
    }
  }
  return { entries, ledger };
}

function assertSameRootBindings(
  authority: ReviewFlowEvaluationCheckpointState,
  donor: ReviewFlowEvaluationCheckpointState
): void {
  if (
    authority.variant !== donor.variant ||
    authority.baselineLabel !== donor.baselineLabel ||
    hashCanonicalValue(authority.baselineBinding) !==
      hashCanonicalValue(donor.baselineBinding) ||
    authority.holdoutIdentity !== donor.holdoutIdentity ||
    authority.thresholdPolicySha256 !== donor.thresholdPolicySha256
  ) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_IDENTITY_MISMATCH"
    );
  }
}

function assertSameExpectedCase(
  authority: ReviewFlowEvaluationExpectedCase,
  donor: ReviewFlowEvaluationExpectedCase
): void {
  if (hashCanonicalValue(authority) !== hashCanonicalValue(donor)) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_CASE_SET_MISMATCH"
    );
  }
}

function reconciliationIdentityProjection(
  identity: ReviewFlowEvaluationCheckpointState["identity"]
): unknown {
  const {
    codeIdentity: _codeIdentity,
    caseSelection: _caseSelection,
    runtime,
    ...semanticIdentity
  } = identity;
  const {
    snapshotSha256: _snapshotSha256,
    snapshotFileCount: _snapshotFileCount,
    ...stableRuntime
  } = runtime;
  return {
    ...semanticIdentity,
    runtime: {
      ...stableRuntime,
      snapshotSha256: null,
      snapshotFileCount: null
    }
  };
}

function assertDonorIdentity(
  authority: ReviewFlowEvaluationCheckpointState,
  donor: ReviewFlowEvaluationCheckpointState,
  currentCodeVersion: string
): ReviewFlowEvaluationCheckpointState["identity"] {
  if (
    authority.identity.codeIdentity.codeVersion !==
      reviewFlowEvaluationReconciliationAuthorityCodeVersion ||
    donor.identity.codeIdentity.codeVersion !==
      reviewFlowEvaluationReconciliationTargetCodeVersion
  ) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_IDENTITY_MISMATCH"
    );
  }
  const { caseSelection: _caseSelection, ...donorIdentity } = donor.identity;
  const targetIdentity = reviewFlowEvaluationIdentitySchema.parse({
    ...donorIdentity,
    codeIdentity: {
      ...donor.identity.codeIdentity,
      codeVersion: currentCodeVersion
    }
  });
  if (
    hashCanonicalValue(reconciliationIdentityProjection(authority.identity)) !==
    hashCanonicalValue(reconciliationIdentityProjection(targetIdentity))
  ) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_IDENTITY_MISMATCH"
    );
  }
  return targetIdentity;
}
function unknownCancelledRoleAttemptAudit(role: ReviewFlowRole) {
  return reviewFlowRoleAttemptAuditSchema.parse({
    schemaVersion: 1,
    role,
    roleStage: reviewFlowRoleStage(role),
    outcome: "failed",
    errorCategory: "cancelled",
    errorCode: "LLM_CANCELLED",
    failureStage: null,
    failureSubstage: null,
    httpStatus: null,
    finishReason: "unknown",
    maxTokens: null,
    usageTotalTokens: null,
    usageComplete: false,
    responseByteCount: null,
    eofObserved: null,
    stopObserved: null,
    doneObserved: null,
    logicalRequestCount: 0,
    transportAttemptCount: 0,
    providerRequestCount: 0,
    retryCount: 0,
    dependencyBlocked: false
  });
}

function requeueActiveEntry(
  entry: Extract<ReviewFlowEvaluationEntry, { readonly status: "active" }>,
  ledger: ReviewFlowEvaluationAuditCase,
  failedAt: string
): Extract<ReviewFlowEvaluationEntry, { readonly status: "failed" }> {
  const nextAttempt = ledger.attempts.length + 1;
  if (nextAttempt > 8) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_LEDGER_INVALID"
    );
  }
  const roleAttempts = reviewFlowRoleSchema.options.map((role) =>
    unknownCancelledRoleAttemptAudit(role)
  );
  return {
    safeId: entry.safeId,
    status: "failed",
    failedAt,
    failure: {
      code: "REVIEW_FLOW_RECONCILIATION_REQUEUEABLE",
      failureKind: "cancelled",
      httpStatus: null,
      completedRoleCount: 0,
      failedRoleCount: 0,
      failedRoles: [],
      roleAttempts,
      caseAttempts: nextAttempt
    }
  };
}

type ReviewFlowEvaluationAuditCases = ReviewFlowEvaluationAuditCase[];
function mergeState(
  authority: ReviewFlowEvaluationCheckpointState,
  donor: ReviewFlowEvaluationCheckpointState,
  authorityEntries: Map<string, ReviewFlowEvaluationEntry>,
  donorEntries: Map<string, ReviewFlowEvaluationEntry>,
  authorityLedger: Map<string, ReviewFlowEvaluationAuditCase>,
  donorLedger: Map<string, ReviewFlowEvaluationAuditCase>,
  targetIdentity: ReviewFlowEvaluationCheckpointState["identity"],
  compatibilityProofSha256: string,
  postCommitCodeDelta:
    | ReviewFlowEvaluationReconciliationBinding["postCommitCodeDelta"]
    | undefined,
  authorityCheckpointSha256: string,
  donorCheckpointSha256: string,
  donorTerminationObservedAt: string
): ReviewFlowEvaluationCheckpointState {
  const donorCompletedIds: string[] = [];
  const requeueIds: string[] = [];
  const mergedEntries: ReviewFlowEvaluationEntry[] = [];
  const mergedAuditCases: ReviewFlowEvaluationAuditCases = [];
  for (let index = 0; index < authority.expectedCases.length; index += 1) {
    const expected = authority.expectedCases[index]!;
    const authorityEntry = authorityEntries.get(expected.safeId)!;
    const authorityCaseLedger = authorityLedger.get(expected.safeId)!;
    if (authorityEntry.status === "completed") {
      mergedEntries.push(authorityEntry);
      mergedAuditCases.push({
        caseOrdinal: index + 1,
        attempts: authorityCaseLedger.attempts
      });
      continue;
    }
    const donorEntry = donorEntries.get(expected.safeId);
    const donorCaseLedger = donorLedger.get(expected.safeId);
    if (donorEntry === undefined || donorCaseLedger === undefined) {
      throw new ReviewFlowEvaluationReconciliationError(
        "REVIEW_FLOW_EVALUATION_RECONCILIATION_CASE_SET_MISMATCH"
      );
    }
    if (donorEntry.status === "completed") {
      donorCompletedIds.push(expected.safeId);
      mergedEntries.push(donorEntry);
      mergedAuditCases.push({
        caseOrdinal: index + 1,
        attempts: donorCaseLedger.attempts
      });
      continue;
    }
    if (donorEntry.status === "failed") {
      requeueIds.push(expected.safeId);
      mergedEntries.push(donorEntry);
      mergedAuditCases.push({
        caseOrdinal: index + 1,
        attempts: donorCaseLedger.attempts
      });
      continue;
    }
    if (donorEntry.status !== "active") {
      throw new ReviewFlowEvaluationReconciliationError(
        "REVIEW_FLOW_EVALUATION_RECONCILIATION_DONOR_INVALID"
      );
    }
    requeueIds.push(expected.safeId);
    const requeuedEntry = requeueActiveEntry(
      donorEntry,
      donorCaseLedger,
      donorTerminationObservedAt
    );
    mergedEntries.push(requeuedEntry);
    mergedAuditCases.push({
      caseOrdinal: index + 1,
      attempts: [
        ...donorCaseLedger.attempts,
        {
          schemaVersion: 1,
          attempt: donorCaseLedger.attempts.length + 1,
          outcome: "failed",
          accountingComplete: false,
          errorCategory: "cancelled",
          errorCode: "LLM_CANCELLED",
          roleAttempts: requeuedEntry.failure.roleAttempts!
        }
      ]
    });
  }

  if (donorCompletedIds.length !== 7 || requeueIds.length !== 2) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_DONOR_INVALID"
    );
  }

  const identityFingerprint = hashCanonicalValue(targetIdentity);
  const reconciliationWithoutFingerprint = {
    schemaVersion: 1 as const,
    artifactKind: "review_flow_evaluation_reconciliation" as const,
    authority: {
      label: authority.label,
      runId: authority.runId,
      identityFingerprint: authority.identityFingerprint,
      stateFingerprint: hashCanonicalValue(authority),
      checkpointSha256: authorityCheckpointSha256,
      expectedCaseCount: 32 as const,
      completedCaseCount: 23,
      failedCaseCount: 9,
      activeCaseCount: 0
    },
    donor: {
      label: donor.label,
      runId: donor.runId,
      identityFingerprint: donor.identityFingerprint,
      stateFingerprint: hashCanonicalValue(donor),
      checkpointSha256: donorCheckpointSha256,
      expectedCaseCount: 9 as const,
      completedCaseCount: 7 as const,
      failedCaseCount: 1 as const,
      activeCaseCount: 1 as const
    },
    compatibilityProofSha256,
    sourceCodeVersion: reviewFlowEvaluationReconciliationSourceCodeVersion,
    targetCodeVersion: reviewFlowEvaluationReconciliationTargetCodeVersion,
    ...(postCommitCodeDelta === undefined ? {} : { postCommitCodeDelta }),
    reconciledIdentityFingerprint: identityFingerprint,
    absorbedCaseIds: donorCompletedIds,
    requeueCaseIds: requeueIds
  };
  const reconciliation: ReviewFlowEvaluationReconciliationBinding =
    reviewFlowEvaluationReconciliationBindingSchema.parse(
      reconciliationWithoutFingerprint
    );
  const runBinding = hashCanonicalValue({
    protocol: "review-flow-evaluation-reconciliation-run-v2",
    authorityStateFingerprint: reconciliation.authority.stateFingerprint,
    donorStateFingerprint: reconciliation.donor.stateFingerprint,
    compatibilityProofSha256,
    ...(postCommitCodeDelta === undefined ? {} : { postCommitCodeDelta }),
    targetIdentityFingerprint: identityFingerprint
  });
  const runId = `${runBinding.slice(0, 8)}-${runBinding.slice(8, 12)}-4${runBinding.slice(13, 16)}-${["8", "9", "a", "b"][Number.parseInt(runBinding[16]!, 16) % 4]}${runBinding.slice(17, 20)}-${runBinding.slice(20, 32)}`;
  const reconciledAt = donorTerminationObservedAt;
  const draft = reviewFlowEvaluationCheckpointSchema.parse({
    schemaVersion: 2,
    label: `reconciled-${runBinding.slice(0, 16)}`,
    variant: authority.variant,
    baselineLabel: authority.baselineLabel,
    baselineBinding: authority.baselineBinding,
    runId,
    identity: targetIdentity,
    identityFingerprint,
    holdoutIdentity: authority.holdoutIdentity,
    thresholdPolicySha256: authority.thresholdPolicySha256,
    expectedCases: authority.expectedCases,
    entries: mergedEntries,
    auditLedger: {
      schemaVersion: 1,
      cases: mergedAuditCases
    },
    globalClaimSha256: null,
    termination: null,
    executionSeal: null,
    reconciliation,
    publication: null,
    ...(authority.representative3Timing === undefined
      ? {}
      : { representative3Timing: authority.representative3Timing }),
    revision: 1,
    createdAt: authority.createdAt,
    updatedAt: reconciledAt
  });
  const completionFingerprint =
    reviewFlowEvaluationExecutionCompletionFingerprint(draft);
  return reviewFlowEvaluationCheckpointSchema.parse({
    ...draft,
    executionSeal: {
      sealedAt: reconciledAt,
      complete: false,
      completionFingerprint
    }
  });
}

export function reconcileReviewFlowEvaluationCheckpoints(
  input: ReviewFlowEvaluationReconciliationInput
): ReviewFlowEvaluationReconciliationResult {
  if (input.outputPath === undefined && input.dryRun !== true) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_OUTPUT_INVALID"
    );
  }
  const privateRoot = resolve(input.privateRoot ?? projectPrivateRoot);
  const containingWorkspace = resolve(
    input.containingWorkspace ?? workspaceRoot
  );
  const repositoryDirectory = resolve(
    input.repositoryDirectory ??
      fileURLToPath(new URL("../..", import.meta.url))
  );
  const paths = [
    input.authoritativeCheckpointPath,
    input.donorCheckpointPath,
    input.compatibilityProofPath,
    ...(input.reconciliationProofPath === undefined
      ? []
      : [input.reconciliationProofPath])
  ];
  assertDifferentPaths(
    input.outputPath === undefined ? paths : [...paths, input.outputPath]
  );
  if (input.outputPath !== undefined) {
    assertOutputLocation(input.outputPath, privateRoot);
  }

  const proofFile = readProof(
    input.compatibilityProofPath,
    privateRoot,
    containingWorkspace
  );
  const postCommitProofFile =
    input.reconciliationProofPath === undefined
      ? null
      : readReconciliationPostCommitProof(
          input.reconciliationProofPath,
          privateRoot,
          containingWorkspace
        );
  const verifiedCodeBinding = verifyCompatibilityProof(
    proofFile.value,
    postCommitProofFile,
    repositoryDirectory
  );
  const authorityFile = readCheckpoint(
    input.authoritativeCheckpointPath,
    "REVIEW_FLOW_EVALUATION_RECONCILIATION_AUTHORITY_INVALID",
    privateRoot,
    containingWorkspace
  );
  if (
    sha256(authorityFile.bytes) !==
    proofFile.value.authorityCheckpointSha256
  ) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_PROOF_INVALID"
    );
  }
  const donorFile = readCheckpoint(
    input.donorCheckpointPath,
    "REVIEW_FLOW_EVALUATION_RECONCILIATION_DONOR_INVALID",
    privateRoot,
    containingWorkspace
  );
  const authorityEntries = assertAuthorityCheckpoint(authorityFile.value);
  const donorResult = assertDonorCheckpoint(donorFile.value);
  assertSameRootBindings(authorityFile.value, donorFile.value);
  const targetIdentity = assertDonorIdentity(
    authorityFile.value,
    donorFile.value,
    verifiedCodeBinding.currentCodeVersion
  );

  const authorityFailedIds = new Set(
    authorityFile.value.entries
      .filter((entry) => entry.status === "failed")
      .map((entry) => entry.safeId)
  );
  const donorExpectedIds = new Set(
    donorFile.value.expectedCases.map((entry) => entry.safeId)
  );
  if (
    authorityFailedIds.size !== 9 ||
    donorExpectedIds.size !== 9 ||
    authorityFailedIds.size !== donorExpectedIds.size ||
    [...authorityFailedIds].some((safeId) => !donorExpectedIds.has(safeId))
  ) {
    throw new ReviewFlowEvaluationReconciliationError(
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_CASE_SET_MISMATCH"
    );
  }
  for (const expected of donorFile.value.expectedCases) {
    const authorityExpected = authorityFile.value.expectedCases.find(
      (candidate) => candidate.safeId === expected.safeId
    );
    if (authorityExpected === undefined) {
      throw new ReviewFlowEvaluationReconciliationError(
        "REVIEW_FLOW_EVALUATION_RECONCILIATION_CASE_SET_MISMATCH"
      );
    }
    assertSameExpectedCase(authorityExpected, expected);
  }
  const postCommitCodeDelta =
    verifiedCodeBinding.postCommitProof === null
      ? undefined
      : {
          sourceCodeVersion:
            verifiedCodeBinding.postCommitProof.sourceCodeVersion,
          targetCodeVersion:
            verifiedCodeBinding.postCommitProof.targetCodeVersion,
          diffSha256: verifiedCodeBinding.postCommitProof.diffSha256,
          proofSha256: verifiedCodeBinding.postCommitProofSha256!,
          changedPaths: verifiedCodeBinding.postCommitProof.changedPaths
        };
  const merged = mergeState(
    authorityFile.value,
    donorFile.value,
    authorityEntries,
    donorResult.entries,
    assertAuditLedger(
      authorityFile.value,
      "REVIEW_FLOW_EVALUATION_RECONCILIATION_AUTHORITY_INVALID"
    ),
    donorResult.ledger,
    targetIdentity,
    sha256(proofFile.bytes),
    postCommitCodeDelta,
    sha256(authorityFile.bytes),
    sha256(donorFile.bytes),
    donorFile.value.termination!.observedAt
  );
  const serializedState = `${JSON.stringify(merged, null, 2)}\n`;
  const summary: ReviewFlowEvaluationReconciliationSummary = {
    expectedCaseCount: 32,
    donorCompletedCaseCount: 7,
    remainingCaseCount: 2,
    duplicateCaseCount: 0,
    missingCaseCount: 0,
    completedCaseCount: 30,
    failedCaseCount: 2,
    activeCaseCount: 0,
    pendingCaseCount: 0,
    identityFingerprint: merged.identityFingerprint,
    completionFingerprint: merged.executionSeal!.completionFingerprint,
    stateFingerprint: hashCanonicalValue(merged),
    compatibilityProofSha256: sha256(proofFile.bytes),
    reconciliationProofSha256: verifiedCodeBinding.postCommitProofSha256
  };
  if (input.outputPath !== undefined && input.dryRun !== true) {
    try {
      const outputDirectory = preparePrivateDirectory(
        resolve(dirname(input.outputPath)),
        { privateRoot, containingWorkspace }
      );
      try {
        writePrivateArtifactExclusive(
          outputDirectory,
          input.outputPath.slice(resolve(dirname(input.outputPath)).length + 1),
          serializedState
        );
        const stored = readPrivateArtifactBytes(
          outputDirectory,
          input.outputPath.slice(resolve(dirname(input.outputPath)).length + 1),
          maximumCheckpointBytes
        );
        if (stored.toString("utf8") !== serializedState) {
          throw new ReviewFlowEvaluationReconciliationError(
            "REVIEW_FLOW_EVALUATION_RECONCILIATION_OUTPUT_WRITE_FAILED"
          );
        }
      } finally {
        closePrivateDirectory(outputDirectory);
      }
    } catch (error) {
      if (error instanceof ReviewFlowEvaluationReconciliationError) {
        throw error;
      }
      throw new ReviewFlowEvaluationReconciliationError(
        "REVIEW_FLOW_EVALUATION_RECONCILIATION_OUTPUT_WRITE_FAILED"
      );
    }
  }
  return { state: merged, summary, serializedState };
}

export function formatReviewFlowEvaluationReconciliationSummary(
  summary: ReviewFlowEvaluationReconciliationSummary,
  dryRun: boolean
): string {
  return [
    `review-flow reconcile ${dryRun ? "dry-run" : "write"}`,
    `cases=${summary.expectedCaseCount}`,
    `donorCompleted=${summary.donorCompletedCaseCount}`,
    `remaining=${summary.remainingCaseCount}`,
    `duplicate=${summary.duplicateCaseCount}`,
    `missing=${summary.missingCaseCount}`,
    `completed=${summary.completedCaseCount}`,
    `failed=${summary.failedCaseCount}`,
    `active=${summary.activeCaseCount}`,
    `pending=${summary.pendingCaseCount}`,
    `identityFingerprint=${summary.identityFingerprint}`,
    `completionFingerprint=${summary.completionFingerprint}`,
    `stateFingerprint=${summary.stateFingerprint}`,
    `compatibilityProofSha256=${summary.compatibilityProofSha256}`,
    `reconciliationProofSha256=${summary.reconciliationProofSha256 ?? "none"}`
  ].join(" ") + "\n";
}

export async function runReviewFlowEvaluationReconciliationCli(input: {
  readonly options: ReviewFlowEvaluationReconciliationCliOptions;
  readonly repositoryDirectory?: string;
  readonly privateRoot?: string;
  readonly containingWorkspace?: string;
  readonly writeOutput?: (text: string) => void;
}): Promise<ReviewFlowEvaluationReconciliationSummary> {
  const result = reconcileReviewFlowEvaluationCheckpoints({
    authoritativeCheckpointPath: input.options.authoritativeCheckpointPath,
    donorCheckpointPath: input.options.donorCheckpointPath,
    compatibilityProofPath: input.options.compatibilityProofPath,
    reconciliationProofPath: input.options.reconciliationProofPath ?? undefined,
    outputPath: input.options.outputPath,
    dryRun: input.options.dryRun,
    repositoryDirectory: input.repositoryDirectory,
    privateRoot: input.privateRoot,
    containingWorkspace: input.containingWorkspace
  });
  (input.writeOutput ?? ((text) => process.stdout.write(text)))(
    formatReviewFlowEvaluationReconciliationSummary(
      result.summary,
      input.options.dryRun
    )
  );
  return result.summary;
}
