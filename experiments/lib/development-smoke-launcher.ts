import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { modelsYamlSchema, type ModelSpec } from "../../src/config";
import type { PipelineModelConfig } from "../../src/pipelines/types";
import {
  loadDifficultyAnchors,
  type DifficultyAnchor
} from "../../src/pipelines/difficulty";
import {
  createDevelopmentSmokeScheduler,
  developmentSmokeProfile,
  developmentSmokeProfileFingerprint,
  bindDevelopmentSmokeModels,
  DevelopmentSmokeRunController,
  parseDevelopmentSmokeManifest,
  runDevelopmentSmokePhase,
  summarizeDevelopmentSmokeManifest,
  type DevelopmentSmokeAnonymousSlot,
  type DevelopmentSmokeSafeRequestReceipt
} from "../../src/review-flow/development-smoke";
import { hashCanonicalValue } from "../../src/review-flow/evidence";
import type {
  FourCallReviewSource,
  ReviewFlowCompletedStage,
  ReviewFlowCompletedStages
} from "../../src/review-flow/four-call";
import type {
  FourCallRuntimeModels,
  FourCallSafeRequestTiming
} from "../../src/review-flow/four-call-runtime";
import { buildHistoricalCalibrationReviewFlowTaskSource } from "../../src/review-flow/task-source";
import { parseYamlLite } from "../../src/yaml-lite";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const slotSchema = z.enum(["slot-01", "slot-02", "slot-03", "slot-04", "slot-05", "slot-06"]);
const failureKindSchema = z.enum(["output_limit", "schema_invalid"]);
const privateFileReferenceSchema = z.object({
  absolutePath: z.string().min(1),
  fileSha256: digestSchema
}).strict();
const failureReferenceSchema = privateFileReferenceSchema.extend({
  class: failureKindSchema,
  entryBindingSha256: digestSchema
}).strict();
const privateBindingSchema = z.object({
  slot: slotSchema,
  opaqueSafeId: digestSchema,
  slotBindingHash: digestSchema,
  source: privateFileReferenceSchema.extend({
    frozenManifestAbsolutePath: z.string().min(1),
    frozenManifestFileSha256: digestSchema,
    frozenEntryBindingSha256: digestSchema
  }).strict(),
  truth: privateFileReferenceSchema.extend({
    truthBindingSha256: digestSchema
  }).strict(),
  difficulty: z.object({
    band: z.enum(["low", "middle", "high"]),
    explicitCfRatings: z.array(z.number().int().min(800).max(4_000)).min(1),
    evidenceAbsolutePath: z.string().min(1),
    evidenceFileSha256: digestSchema,
    rowEvidenceSha256: digestSchema,
    evidenceBindingSha256: digestSchema
  }).strict(),
  priorFailures: z.array(failureReferenceSchema).min(1)
}).strict();
const privateManifestSchema = z.object({
  schemaVersion: z.literal(1),
  selectionPolicy: z.object({
    name: z.literal("frozen-human-evidence-6x4-v1"),
    selectionBindingSha256: digestSchema,
    phase0Slots: z.tuple([z.literal("slot-01"), z.literal("slot-02")]),
    phase1Slots: z.tuple([
      z.literal("slot-03"),
      z.literal("slot-04"),
      z.literal("slot-05"),
      z.literal("slot-06")
    ]),
    difficultyBandDefinition: z.object({
      low: z.literal("explicit CF rating < 1400"),
      middle: z.literal("explicit CF rating 1400-2199"),
      high: z.literal("explicit CF rating >= 2200")
    }).strict()
  }).strict(),
  profileManifest: z.unknown(),
  bindings: z.array(privateBindingSchema).length(6)
}).strict();

const safeTimingSchema = z.object({
  firstValidOutputMs: z.number().int().nonnegative(),
  endToEndMs: z.number().int().nonnegative(),
  validOutputEventCount: z.number().int().positive(),
  outputUtf8Bytes: z.number().int().positive()
}).strict().superRefine((value, context) => {
  if (value.endToEndMs < value.firstValidOutputMs) {
    context.addIssue({ code: "custom", message: "invalid timing order" });
  }
});
const safeReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  profileName: z.literal("development-smoke-6x4-v1"),
  profileFingerprint: digestSchema,
  manifestFingerprint: digestSchema,
  runBindingHash: digestSchema,
  anonymousSlot: slotSchema,
  phase: z.literal("phase0"),
  stage: z.enum(["A", "B", "C", "D", "formatter"]),
  provider: z.literal("aether"),
  model: z.enum(["deepseek-v4-pro", "deepseek-v4-flash"]),
  modelFingerprint: digestSchema,
  schemaFingerprint: digestSchema,
  maxOutputTokens: z.union([z.literal(32_000), z.literal(8_000), z.literal(24_000), z.literal(12_000)]),
  thinkingRequest: z.literal("enabled"),
  reasoningEffort: z.literal("max"),
  logicalAttempt: z.literal(1),
  logicalRequestsUsed: z.number().int().min(1).max(30),
  logicalRequestCeiling: z.literal(30),
  externalAttemptsUsed: z.number().int().min(1).max(30),
  externalAttemptCeiling: z.literal(30)
}).strict();
const stageReceiptSchema = z.object({
  stage: z.enum(["A", "B", "C", "D", "formatter"]),
  inputHash: digestSchema,
  promptHash: digestSchema,
  schemaFingerprint: digestSchema.nullable(),
  modelFingerprint: digestSchema,
  attemptCount: z.literal(1),
  eofVerified: z.literal(true),
  outputHash: digestSchema,
  receiptHash: digestSchema
}).strict();
const completedStageSchema = z.object({
  output: z.string().min(1),
  receipt: stageReceiptSchema
}).strict();
const requestLedgerSchema = z.object({
  receipt: safeReceiptSchema,
  timing: safeTimingSchema.optional(),
  completedStage: completedStageSchema.optional(),
  failureKind: z.enum([
    "rate_limited",
    "server_error",
    "connect",
    "first_byte_timeout",
    "no_progress_timeout",
    "stream_interrupted",
    "output_limit",
    "schema_invalid",
    "permanent"
  ]).optional()
}).strict().superRefine((value, context) => {
  if (
    value.completedStage !== undefined &&
    (value.timing === undefined || value.failureKind !== undefined)
  ) {
    context.addIssue({ code: "custom", message: "completed stage state invalid" });
  }
  if (value.completedStage?.receipt.stage !== undefined &&
      value.completedStage.receipt.stage !== value.receipt.stage) {
    context.addIssue({ code: "custom", message: "stage binding mismatch" });
  }
});
const safeFailureCodeSchema = z.enum([
  "rate_limited",
  "server_error",
  "connect",
  "first_byte_timeout",
  "no_progress_timeout",
  "stream_interrupted",
  "output_limit",
  "schema_invalid",
  "permanent",
  "request_receipt_schema_invalid",
  "checkpoint_state_schema_invalid",
  "final_failure"
]);
const safeFailureLocationSchema = z.string().regex(
  /^[A-Za-z0-9._/-]+:\d+:[A-Za-z0-9_.#<>-]+$/u
);
const privateCheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  profileName: z.literal("development-smoke-6x4-v1"),
  profileFingerprint: digestSchema,
  manifestFingerprint: digestSchema,
  privateManifestFileSha256: digestSchema,
  runId: digestSchema,
  runBindingHash: digestSchema,
  codeVersion: z.string().regex(/^[a-f0-9]{40}$/u),
  phase: z.literal("phase0"),
  state: z.enum(["prepared", "running", "phase0_complete", "incomplete"]),
  revision: z.number().int().positive(),
  previousCheckpointSha256: digestSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  requests: z.array(requestLedgerSchema).max(10),
  phase0Forecast: z.unknown().nullable(),
  stopReason: z.string().nullable(),
  failureCode: safeFailureCodeSchema.nullable().optional(),
  failureLocation: safeFailureLocationSchema.nullable().optional(),
  accuracyClaim: z.null(),
  includedInFinalCalibration: z.literal(false),
  phase1Released: z.literal(false)
}).strict();

type PrivateManifest = z.infer<typeof privateManifestSchema>;
type PrivateBinding = z.infer<typeof privateBindingSchema>;
type PrivateCheckpoint = z.infer<typeof privateCheckpointSchema>;
type SafeFailureCode = z.infer<typeof safeFailureCodeSchema>;

class DevelopmentSmokeSafeError extends Error {
  public constructor(
    public readonly safeCode: SafeFailureCode,
    options: { readonly cause: unknown }
  ) {
    super(safeCode, { cause: options.cause });
    this.name = "DevelopmentSmokeSafeError";
  }
}

export interface DevelopmentSmokePreparedCase {
  readonly slot: DevelopmentSmokeAnonymousSlot;
  readonly sourceBinding: string;
  readonly source: FourCallReviewSource;
  readonly truthBindingHash: string;
}

export interface DevelopmentSmokePreflight {
  readonly manifestPath: string;
  readonly manifestFileSha256: string;
  readonly manifest: ReturnType<typeof parseDevelopmentSmokeManifest>;
  readonly privateManifest: PrivateManifest;
  readonly cases: readonly DevelopmentSmokePreparedCase[];
  readonly models: FourCallRuntimeModels;
  readonly codeVersion: string;
  readonly repositoryRoot: string;
  readonly privateRuntimeRoot: string;
  readonly safeSummary: {
    readonly slots: 6;
    readonly phase0Slots: 2;
    readonly provider: "aether";
    readonly models: readonly ["deepseek-v4-pro", "deepseek-v4-flash"];
    readonly concurrency: 12;
    readonly retries: 0;
    readonly externalAttemptCeiling: 30;
    readonly manifestFingerprint: string;
  };
}

export interface DevelopmentSmokePreflightOptions {
  readonly repositoryRoot: string;
  readonly projectRoot: string;
  readonly manifestPath: string;
  readonly codeVersion: string;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly modelsYamlSource?: string;
  readonly allowedPrivateRoots?: readonly string[];
}

export function preflightDevelopmentSmoke(
  options: DevelopmentSmokePreflightOptions
): DevelopmentSmokePreflight {
  assertControlledEnvironment(options.env ?? process.env);
  if (!/^[a-f0-9]{40}$/u.test(options.codeVersion)) {
    throw new Error("DEVELOPMENT_SMOKE_CODE_VERSION_INVALID");
  }
  const repositoryRoot = realpathSync(options.repositoryRoot);
  const projectRoot = realpathSync(options.projectRoot);
  const allowedPrivateRoots = (options.allowedPrivateRoots ?? [
    resolve(projectRoot, "Fermata/private"),
    resolve(projectRoot, "Urmotiv/private")
  ]).map((root) => realpathSync(root));
  const manifestRead = readPrivateFile(options.manifestPath, allowedPrivateRoots);
  assertUserOnlyPath(resolve(manifestRead.realPath, ".."), true);
  const privateManifest = parsePrivateManifest(manifestRead.bytes);
  const manifest = parseDevelopmentSmokeManifest(privateManifest.profileManifest);
  const summary = summarizeDevelopmentSmokeManifest(manifest);
  verifySelection(privateManifest, manifest, allowedPrivateRoots);
  const modelState = loadDevelopmentModels({
    repositoryRoot,
    env: options.env ?? process.env,
    modelsYamlSource: options.modelsYamlSource
  });
  const difficultyAnchors = loadDifficultyAnchors();
  if (difficultyAnchors.length === 0) {
    throw new Error("DEVELOPMENT_SMOKE_DIFFICULTY_ANCHORS_MISSING");
  }
  const cases = privateManifest.bindings.slice(0, 2).map((binding) => ({
    slot: binding.slot,
    sourceBinding: binding.slotBindingHash,
    source: buildFourCallSource(
      binding,
      allowedPrivateRoots,
      modelState.duplicateSimilarityReject,
      difficultyAnchors
    ),
    truthBindingHash: binding.truth.truthBindingSha256
  }));
  return Object.freeze({
    manifestPath: manifestRead.realPath,
    manifestFileSha256: sha256(manifestRead.bytes),
    manifest,
    privateManifest,
    cases: Object.freeze(cases),
    models: modelState.models,
    codeVersion: options.codeVersion,
    repositoryRoot,
    privateRuntimeRoot: resolve(repositoryRoot, "private/development-smoke-6x4-v1/runtime"),
    safeSummary: Object.freeze({
      slots: 6 as const,
      phase0Slots: 2 as const,
      provider: "aether" as const,
      models: Object.freeze(["deepseek-v4-pro", "deepseek-v4-flash"] as const),
      concurrency: 12 as const,
      retries: 0 as const,
      externalAttemptCeiling: 30 as const,
      manifestFingerprint: summary.manifestFingerprint
    })
  });
}

export async function executeDevelopmentSmokePhase0(input: {
  readonly preflight: DevelopmentSmokePreflight;
  readonly resumeRunId?: string;
  readonly now?: () => Date;
}): Promise<Readonly<{ runId: string; state: "phase0_complete" | "incomplete"; requestCount: number }>> {
  const now = input.now ?? (() => new Date());
  const runId = input.resumeRunId ?? randomBytes(32).toString("hex");
  digestSchema.parse(runId);
  const runDirectory = resolve(input.preflight.privateRuntimeRoot, `run-${runId}`);
  ensurePrivateDirectory(input.preflight.privateRuntimeRoot);
  if (input.resumeRunId === undefined) {
    mkdirSync(runDirectory, { mode: 0o700 });
  } else {
    assertUserOnlyPath(runDirectory, true);
  }
  const releaseLock = acquireRunLock(runDirectory, runId);
  try {
    const ledger = input.resumeRunId === undefined
      ? createRunLedger(input.preflight, runId, runDirectory, now)
      : resumeRunLedger(input.preflight, runId, runDirectory, now);
    ledger.mutate((state) => ({ ...state, state: "running" }));
    const scheduler = createDevelopmentSmokeScheduler();
    const controller = new DevelopmentSmokeRunController({
      profile: developmentSmokeProfile,
      manifest: input.preflight.manifest,
      runBindingHash: ledger.state.runBindingHash,
      scheduler,
      startedAtMs: new Date(ledger.state.createdAt).getTime(),
      safeReceiptSink: (receipt) => {
        const parsedReceipt = safeReceiptSchema.safeParse(receipt);
        if (!parsedReceipt.success) {
          throw new DevelopmentSmokeSafeError("request_receipt_schema_invalid", {
            cause: parsedReceipt.error
          });
        }
        ledger.mutate((state) => ({
          ...state,
          requests: [...state.requests, { receipt: parsedReceipt.data }]
        }));
      },
      safeCompletionSink: (slot, stage, timing) => {
        ledger.mutate((state) => ({
          ...state,
          requests: state.requests.map((request) =>
            request.receipt.anonymousSlot === slot && request.receipt.stage === stage
              ? { ...request, timing }
              : request
          )
        }));
      },
      safeFailureSink: (slot, stage, failureKind) => {
        ledger.mutate((state) => ({
          ...state,
          requests: state.requests.map((request) =>
            request.receipt.anonymousSlot === slot &&
            request.receipt.stage === stage
              ? { ...request, failureKind }
              : request
          )
        }));
      }
    });
    const reusableBySlot = restoreReusableRequests(controller, ledger.state);
    const checkpoint15 = setTimeout(() => {
      ledger.mutate((state) => ({ ...state, stopReason: state.stopReason }));
    }, developmentSmokeProfile.phase0CheckpointMs);
    checkpoint15.unref();
    const checkpoint60 = setTimeout(() => {
      let forecast: unknown = null;
      try {
        forecast = controller.reestimate();
      } catch {
        // 未收齐八个语义请求时，没有可诚实计算的 Phase 0 样本 P90。
      }
      ledger.mutate((state) => ({ ...state, phase0Forecast: forecast }));
    }, developmentSmokeProfile.reestimateCheckpointMs);
    checkpoint60.unref();
    try {
      const outcomes = await runDevelopmentSmokePhase({
        phase: "phase0",
        controller,
        models: input.preflight.models,
        nativeSchemaCompatible: true,
        cases: input.preflight.cases.map((entry) => ({
          ...entry,
          reusableStages: reusableBySlot.get(entry.slot)
        })),
        onStageCompleted: (slot, completed) => {
          const sealedStage = completedStageSchema.parse(completed);
          ledger.mutate((state) => ({
            ...state,
            requests: state.requests.map((request) =>
              request.receipt.anonymousSlot === slot &&
              request.receipt.stage === sealedStage.receipt.stage
                ? { ...request, completedStage: sealedStage }
                : request
            )
          }));
        }
      });
      const rejectedOutcome = outcomes.find((outcome) => outcome.status === "rejected");
      const rejected = rejectedOutcome !== undefined;
      const forecast = rejected ? null : controller.phase0Forecast(controller.elapsedMs());
      ledger.mutate((state) => ({
        ...state,
        state: rejected ? "incomplete" : "phase0_complete",
        phase0Forecast: forecast,
        stopReason: rejected ? controller.checkpoint().stopReason ?? "final_failure" : null,
        failureCode: rejectedOutcome === undefined ? null : safeFailureCode(rejectedOutcome.reason),
        failureLocation: rejectedOutcome === undefined
          ? null
          : safeFailureLocation(rejectedOutcome.reason)
      }));
    } catch (error) {
      const failureCode = safeFailureCode(error);
      ledger.mutate((state) => ({
        ...state,
        state: "incomplete",
        stopReason: failureCode,
        failureCode,
        failureLocation: safeFailureLocation(error)
      }));
    } finally {
      clearTimeout(checkpoint15);
      clearTimeout(checkpoint60);
    }
    return Object.freeze({
      runId,
      state: ledger.state.state === "phase0_complete" ? "phase0_complete" : "incomplete",
      requestCount: ledger.state.requests.length
    });
  } finally {
    releaseLock();
  }
}

function parsePrivateManifest(bytes: Buffer): PrivateManifest {
  try {
    return privateManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new Error("DEVELOPMENT_SMOKE_PRIVATE_MANIFEST_INVALID");
  }
}

function verifySelection(
  manifest: PrivateManifest,
  profileManifest: ReturnType<typeof parseDevelopmentSmokeManifest>,
  allowedRoots: readonly string[]
): void {
  if (manifest.bindings.some((binding, index) => binding.slot !== `slot-${String(index + 1).padStart(2, "0")}`)) {
    throw new Error("DEVELOPMENT_SMOKE_PRIVATE_SLOT_ORDER_INVALID");
  }
  if (hashCanonicalValue(manifest.bindings.map((binding) => binding.slotBindingHash)) !==
      manifest.selectionPolicy.selectionBindingSha256) {
    throw new Error("DEVELOPMENT_SMOKE_PRIVATE_SELECTION_BINDING_INVALID");
  }
  for (const [index, binding] of manifest.bindings.entries()) {
    const profileSlot = profileManifest.slots[index]!;
    const expectedVerdict = readHistoricalVerdict(binding.truth, allowedRoots);
    if (
      profileSlot.slot !== binding.slot ||
      profileSlot.slotBindingHash !== binding.slotBindingHash ||
      profileSlot.truthBindingHash !== binding.truth.truthBindingSha256 ||
      profileSlot.difficultyTruth !== binding.difficulty.band ||
      profileSlot.verdictTruth !== expectedVerdict ||
      hashCanonicalValue(profileSlot.priorFailures) !==
        hashCanonicalValue([...new Set(binding.priorFailures.map((failure) => failure.class))].sort())
    ) {
      throw new Error("DEVELOPMENT_SMOKE_PROFILE_BINDING_INVALID");
    }
    verifyBinding(binding, allowedRoots);
  }
  if (
    profileManifest.slots[0]!.verdictTruth === profileManifest.slots[1]!.verdictTruth ||
    profileManifest.slots[0]!.difficultyTruth === profileManifest.slots[1]!.difficultyTruth
  ) {
    throw new Error("DEVELOPMENT_SMOKE_PHASE0_NOT_REPRESENTATIVE");
  }
}

function readHistoricalVerdict(
  truth: { absolutePath: string; fileSha256: string },
  allowedRoots: readonly string[]
): "pass" | "reject" {
  const value = asRecord(parseJson(readBoundFile(truth, allowedRoots)));
  if (value.historicalOutcome === "accepted") return "pass";
  if (value.historicalOutcome === "rejected") return "reject";
  throw new Error("DEVELOPMENT_SMOKE_TRUTH_BINDING_INVALID");
}

function verifyBinding(binding: PrivateBinding, allowedRoots: readonly string[]): void {
  const sourceBytes = readBoundFile(binding.source, allowedRoots);
  const frozenManifestBytes = readBoundFile({
    absolutePath: binding.source.frozenManifestAbsolutePath,
    fileSha256: binding.source.frozenManifestFileSha256
  }, allowedRoots);
  const frozenManifest = parseJson(frozenManifestBytes);
  const sourceCases = asRecord(asRecord(asRecord(frozenManifest).partitions).development).cases;
  if (!Array.isArray(sourceCases)) throw new Error("DEVELOPMENT_SMOKE_SOURCE_MANIFEST_INVALID");
  const sourceCase = sourceCases.find((candidate) =>
    hashCanonicalValue(candidate) === binding.source.frozenEntryBindingSha256
  );
  if (sourceCase === undefined) {
    throw new Error("DEVELOPMENT_SMOKE_SOURCE_BINDING_INVALID");
  }
  const sourceCaseRecord = asRecord(sourceCase);
  const contentRecord = asRecord(sourceCaseRecord.content);
  if (
    contentRecord.sha256 !== binding.source.fileSha256 ||
    sourceCaseRecord.sourceLineageSha256 === undefined ||
    sourceBytes.byteLength === 0 ||
    asRecord(parseJson(sourceBytes)).problem === undefined
  ) {
    throw new Error("DEVELOPMENT_SMOKE_SOURCE_BINDING_INVALID");
  }

  const truthBytes = readBoundFile(binding.truth, allowedRoots);
  const truth = asRecord(parseJson(truthBytes));
  const upstreamEvidence = asRecord(truth.upstreamEvidence);
  const verdict = truth.historicalOutcome === "accepted" ? "pass" :
    truth.historicalOutcome === "rejected" ? "reject" : null;
  const truthBinding = hashCanonicalValue({
    fileSha256: binding.truth.fileSha256,
    contentSha256: truth.contentSha256,
    verdict,
    sourceLineageSha256: truth.sourceLineageSha256,
    rowEvidenceSha256: upstreamEvidence.rowEvidenceSha256
  });
  if (
    verdict === null ||
    truth.contentSha256 !== binding.source.fileSha256 ||
    truth.sourceLineageSha256 !== sourceCaseRecord.sourceLineageSha256 ||
    truthBinding !== binding.truth.truthBindingSha256
  ) {
    throw new Error("DEVELOPMENT_SMOKE_TRUTH_BINDING_INVALID");
  }

  const evidenceBytes = readBoundFile({
    absolutePath: binding.difficulty.evidenceAbsolutePath,
    fileSha256: binding.difficulty.evidenceFileSha256
  }, allowedRoots);
  const evidence = asRecord(parseJson(evidenceBytes));
  if (!Array.isArray(evidence.rows)) throw new Error("DEVELOPMENT_SMOKE_DIFFICULTY_EVIDENCE_INVALID");
  const row = evidence.rows.find((candidate) =>
    asRecord(candidate).rowEvidenceSha256 === binding.difficulty.rowEvidenceSha256
  );
  if (row === undefined || upstreamEvidence.rowEvidenceSha256 !== binding.difficulty.rowEvidenceSha256) {
    throw new Error("DEVELOPMENT_SMOKE_DIFFICULTY_EVIDENCE_INVALID");
  }
  const ratings = extractExplicitRatings(asRecord(row));
  const band = difficultyBand(ratings);
  const evidenceBinding = hashCanonicalValue({
    rowEvidenceSha256: binding.difficulty.rowEvidenceSha256,
    explicitCfRatings: ratings,
    band
  });
  if (
    band !== binding.difficulty.band ||
    hashCanonicalValue(ratings) !== hashCanonicalValue(binding.difficulty.explicitCfRatings) ||
    evidenceBinding !== binding.difficulty.evidenceBindingSha256
  ) {
    throw new Error("DEVELOPMENT_SMOKE_DIFFICULTY_BINDING_INVALID");
  }

  for (const failure of binding.priorFailures) {
    const checkpoint = asRecord(parseJson(readBoundFile(failure, allowedRoots)));
    if (!Array.isArray(checkpoint.entries)) throw new Error("DEVELOPMENT_SMOKE_FAILURE_EVIDENCE_INVALID");
    const entry = checkpoint.entries.find((candidate) => {
      const record = asRecord(candidate);
      return hashCanonicalValue({
        safeId: record.safeId,
        status: record.status,
        failure: record.failure
      }) === failure.entryBindingSha256;
    });
    const entryRecord = entry === undefined ? null : asRecord(entry);
    const failureRecord = entryRecord === null ? null : asRecord(entryRecord.failure);
    const normalizedFailureKind =
      failureRecord?.failureKind === "schema_output"
        ? "schema_invalid"
        : failureRecord?.failureKind;
    if (entryRecord?.status !== "failed" || normalizedFailureKind !== failure.class) {
      throw new Error("DEVELOPMENT_SMOKE_FAILURE_EVIDENCE_INVALID");
    }
  }

  const opaqueSafeId = hashCanonicalValue({
    domain: "development-smoke-opaque-id-v1",
    sourceFileSha256: binding.source.fileSha256,
    truthBindingSha256: binding.truth.truthBindingSha256,
    difficultyEvidenceBindingSha256: binding.difficulty.evidenceBindingSha256
  });
  const { slotBindingHash: _ignored, ...slotBase } = binding;
  if (opaqueSafeId !== binding.opaqueSafeId || hashCanonicalValue(slotBase) !== binding.slotBindingHash) {
    throw new Error("DEVELOPMENT_SMOKE_SLOT_BINDING_INVALID");
  }
  void sourceBytes;
}

function buildFourCallSource(
  binding: PrivateBinding,
  allowedRoots: readonly string[],
  duplicateSimilarityRejectThreshold: number,
  difficultyAnchors: readonly DifficultyAnchor[]
): FourCallReviewSource {
  const task = parseJson(readBoundFile(binding.source, allowedRoots));
  const built = buildHistoricalCalibrationReviewFlowTaskSource(task, {
    duplicateSimilarityRejectThreshold
  });
  return Object.freeze({
    statement: Object.freeze({
      type: built.source.type,
      statement: built.source.statement,
      constraints: built.source.constraints,
      samples: built.source.samples,
      limits: built.source.limits
    }),
    referenceSolution: Object.freeze({
      solution: built.source.solution,
      referenceImplementation: built.source.referenceImplementation
    }),
    technicalContext: Object.freeze({
      constraints: built.source.constraints,
      samples: built.source.samples,
      limits: built.source.limits
    }),
    historicalTasteRubric: null,
    difficultyAnchors,
    labelCatalog: Object.freeze({
      version: built.source.tagCatalogVersion,
      tags: built.source.tagCatalog
    }),
    hardRules: Object.freeze({ duplicateSimilarityRejectThreshold })
  });
}

function loadDevelopmentModels(input: {
  repositoryRoot: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  modelsYamlSource?: string;
}): { models: FourCallRuntimeModels; duplicateSimilarityReject: number } {
  const source = input.modelsYamlSource ??
    readFileSync(resolve(input.repositoryRoot, "config/models.yaml"), "utf8");
  let modelsConfig: z.infer<typeof modelsYamlSchema>;
  try {
    modelsConfig = modelsYamlSchema.parse(parseYamlLite(source));
  } catch {
    throw new Error("DEVELOPMENT_SMOKE_MODELS_CONFIG_INVALID");
  }
  if (modelsConfig.defaults.modelProfileName !== "review-balanced") {
    throw new Error("DEVELOPMENT_SMOKE_PROFILE_SELECTION_INVALID");
  }
  const profile = modelsConfig.profiles["review-balanced"];
  const baseUrl = input.env.AETHER_BASE_URL;
  const apiKey = input.env.AETHER_API_KEY;
  if (profile === undefined || baseUrl === undefined || apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error("DEVELOPMENT_SMOKE_AETHER_CONFIGURATION_INVALID");
  }
  try {
    const url = new URL(baseUrl);
    if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch {
    throw new Error("DEVELOPMENT_SMOKE_AETHER_CONFIGURATION_INVALID");
  }
  const model = (spec: ModelSpec): PipelineModelConfig => Object.freeze({
    spec,
    credentials: Object.freeze({ baseUrl, apiKey }),
    runtime: Object.freeze({
      firstOutputTimeoutMs: modelsConfig.timeouts.llmFirstOutputMs,
      outputIdleTimeoutMs: modelsConfig.timeouts.llmOutputIdleMs,
      maximumDurationMs: modelsConfig.timeouts.llmMaximumDurationMs,
      maxAttempts: 1,
      baseDelayMs: modelsConfig.retry.baseDelayMs
    })
  });
  const roles = profile.reviewFlow;
  return {
    models: bindDevelopmentSmokeModels({
      A: model(roles.solver),
      B: model(roles.difficulty),
      C: model(roles.editorialJudge),
      D: model(roles.adjudicator),
      formatter: model(roles.tags)
    }),
    duplicateSimilarityReject: modelsConfig.thresholds.duplicateSimilarityReject
  };
}

function createRunLedger(
  preflight: DevelopmentSmokePreflight,
  runId: string,
  runDirectory: string,
  now: () => Date
): RunLedger {
  const timestamp = now().toISOString();
  const runBindingHash = hashCanonicalValue({
    schemaVersion: 1,
    runId,
    codeVersion: preflight.codeVersion,
    profileFingerprint: developmentSmokeProfileFingerprint,
    manifestFingerprint: preflight.safeSummary.manifestFingerprint,
    privateManifestFileSha256: preflight.manifestFileSha256
  });
  const state: PrivateCheckpoint = {
    schemaVersion: 1,
    profileName: developmentSmokeProfile.name,
    profileFingerprint: developmentSmokeProfileFingerprint,
    manifestFingerprint: preflight.safeSummary.manifestFingerprint,
    privateManifestFileSha256: preflight.manifestFileSha256,
    runId,
    runBindingHash,
    codeVersion: preflight.codeVersion,
    phase: "phase0",
    state: "prepared",
    revision: 1,
    previousCheckpointSha256: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    requests: [],
    phase0Forecast: null,
    stopReason: null,
    failureCode: null,
    failureLocation: null,
    accuracyClaim: null,
    includedInFinalCalibration: false,
    phase1Released: false
  };
  return new RunLedger(runDirectory, privateCheckpointSchema.parse(state), now, true);
}

function resumeRunLedger(
  preflight: DevelopmentSmokePreflight,
  runId: string,
  runDirectory: string,
  now: () => Date
): RunLedger {
  const state = readLatestCheckpoint(runDirectory);
  if (
    state.runId !== runId ||
    state.codeVersion !== preflight.codeVersion ||
    state.profileFingerprint !== developmentSmokeProfileFingerprint ||
    state.manifestFingerprint !== preflight.safeSummary.manifestFingerprint ||
    state.privateManifestFileSha256 !== preflight.manifestFileSha256 ||
    state.state === "phase0_complete" ||
    state.requests.some((request) => request.completedStage === undefined || request.timing === undefined)
  ) {
    throw new Error("DEVELOPMENT_SMOKE_RESUME_BINDING_INVALID");
  }
  return new RunLedger(runDirectory, state, now, false);
}

class RunLedger {
  public state: PrivateCheckpoint;
  readonly #directory: string;
  readonly #now: () => Date;

  public constructor(
    directory: string,
    initial: PrivateCheckpoint,
    now: () => Date,
    persistInitial: boolean
  ) {
    this.#directory = directory;
    this.#now = now;
    this.state = initial;
    if (persistInitial) this.#persist(initial);
  }

  public mutate(update: (state: PrivateCheckpoint) => Omit<PrivateCheckpoint, "revision" | "previousCheckpointSha256" | "updatedAt"> & Partial<Pick<PrivateCheckpoint, "revision" | "previousCheckpointSha256" | "updatedAt">>): void {
    const previousBytes = checkpointBytes(this.state);
    const parsedNext = privateCheckpointSchema.safeParse({
      ...update(this.state),
      revision: this.state.revision + 1,
      previousCheckpointSha256: sha256(previousBytes),
      updatedAt: this.#now().toISOString()
    });
    if (!parsedNext.success) {
      throw new DevelopmentSmokeSafeError("checkpoint_state_schema_invalid", {
        cause: parsedNext.error
      });
    }
    this.#persist(parsedNext.data);
    this.state = parsedNext.data;
  }

  #persist(state: PrivateCheckpoint): void {
    const path = resolve(this.#directory, checkpointName(state.revision));
    writeNewPrivateFile(path, checkpointBytes(state));
  }
}

function restoreReusableRequests(
  controller: DevelopmentSmokeRunController,
  state: PrivateCheckpoint
): Map<DevelopmentSmokeAnonymousSlot, ReviewFlowCompletedStages> {
  const result = new Map<DevelopmentSmokeAnonymousSlot, ReviewFlowCompletedStages>();
  const ordered = [...state.requests].sort((left, right) =>
    left.receipt.logicalRequestsUsed - right.receipt.logicalRequestsUsed
  );
  for (const request of ordered) {
    if (request.timing === undefined || request.completedStage === undefined) {
      throw new Error("DEVELOPMENT_SMOKE_RESUME_UNCERTAIN_ATTEMPT");
    }
    controller.restoreCompletedRequest(
      request.receipt as DevelopmentSmokeSafeRequestReceipt,
      request.timing as FourCallSafeRequestTiming
    );
    const current = result.get(request.receipt.anonymousSlot) ?? {};
    result.set(request.receipt.anonymousSlot, Object.freeze({
      ...current,
      [request.receipt.stage]: request.completedStage as ReviewFlowCompletedStage
    }));
  }
  return result;
}

function readLatestCheckpoint(runDirectory: string): PrivateCheckpoint {
  const names = readdirSync(runDirectory)
    .filter((name) => /^checkpoint-[0-9]{6}\.private\.json$/u.test(name))
    .sort();
  if (names.length === 0) throw new Error("DEVELOPMENT_SMOKE_CHECKPOINT_MISSING");
  let previousHash: string | null = null;
  let latest: PrivateCheckpoint | null = null;
  for (const [index, name] of names.entries()) {
    if (name !== checkpointName(index + 1)) throw new Error("DEVELOPMENT_SMOKE_CHECKPOINT_CHAIN_INVALID");
    const bytes = readPrivateFile(resolve(runDirectory, name), [runDirectory]).bytes;
    let parsed: PrivateCheckpoint;
    try {
      parsed = privateCheckpointSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw new Error("DEVELOPMENT_SMOKE_CHECKPOINT_INVALID");
    }
    if (parsed.revision !== index + 1 || parsed.previousCheckpointSha256 !== previousHash) {
      throw new Error("DEVELOPMENT_SMOKE_CHECKPOINT_CHAIN_INVALID");
    }
    previousHash = sha256(bytes);
    latest = parsed;
  }
  return latest!;
}

function acquireRunLock(runDirectory: string, runId: string): () => void {
  const lockPath = resolve(runDirectory, "active.lock.private.json");
  if (existsSync(lockPath)) {
    const lock = asRecord(parseJson(readPrivateFile(lockPath, [runDirectory]).bytes));
    const pid = lock.pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) {
      throw new Error("DEVELOPMENT_SMOKE_RUN_LOCK_INVALID");
    }
    try {
      process.kill(pid, 0);
      throw new Error("DEVELOPMENT_SMOKE_RUN_LOCKED");
    } catch (error) {
      if (error instanceof Error && error.message === "DEVELOPMENT_SMOKE_RUN_LOCKED") throw error;
      const stalePath = resolve(runDirectory, `stale-lock-${randomBytes(8).toString("hex")}.private.json`);
      renameSync(lockPath, stalePath);
    }
  }
  writeNewPrivateFile(lockPath, Buffer.from(`${JSON.stringify({ schemaVersion: 1, runId, pid: process.pid })}\n`, "utf8"));
  return () => rmSync(lockPath, { force: false });
}

function writeNewPrivateFile(path: string, bytes: Buffer): void {
  const directory = resolve(path, "..");
  assertUserOnlyPath(directory, true);
  const temporary = resolve(directory, `.${randomBytes(12).toString("hex")}.tmp`);
  const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    linkSync(temporary, path);
    unlinkSync(temporary);
    const directoryDescriptor = openSync(directory, constants.O_RDONLY);
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertUserOnlyPath(path, true);
}

function readBoundFile(
  reference: { absolutePath: string; fileSha256: string },
  allowedRoots: readonly string[]
): Buffer {
  const read = readPrivateFile(reference.absolutePath, allowedRoots);
  if (sha256(read.bytes) !== reference.fileSha256) {
    throw new Error("DEVELOPMENT_SMOKE_PRIVATE_FILE_HASH_MISMATCH");
  }
  return read.bytes;
}

function readPrivateFile(path: string, allowedRoots: readonly string[]): { bytes: Buffer; realPath: string } {
  if (!isAbsolute(path)) throw new Error("DEVELOPMENT_SMOKE_PRIVATE_PATH_INVALID");
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("DEVELOPMENT_SMOKE_PRIVATE_PATH_INVALID");
  assertUserOnlyStat(before.mode, before.uid, false);
  const realPath = realpathSync(path);
  if (resolve(path) !== realPath) {
    throw new Error("DEVELOPMENT_SMOKE_PRIVATE_PATH_INVALID");
  }
  if (!allowedRoots.some((root) => isPathWithin(realPath, root))) {
    throw new Error("DEVELOPMENT_SMOKE_PRIVATE_PATH_OUTSIDE_ROOT");
  }
  assertPrivateAncestors(realPath, allowedRoots);
  const bytes = readFileSync(realPath);
  const after = statSync(realPath);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("DEVELOPMENT_SMOKE_PRIVATE_FILE_CHANGED");
  }
  return { bytes, realPath };
}

function assertPrivateAncestors(path: string, allowedRoots: readonly string[]): void {
  const root = allowedRoots.find((candidate) => isPathWithin(path, candidate));
  if (root === undefined) {
    throw new Error("DEVELOPMENT_SMOKE_PRIVATE_PATH_OUTSIDE_ROOT");
  }
  assertUserOnlyPath(root, true);
  const parts = relative(root, resolve(path, "..")).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    assertUserOnlyPath(current, true);
  }
}

function assertUserOnlyPath(path: string, directory: boolean): void {
  const value = lstatSync(path);
  if (value.isSymbolicLink() || (directory ? !value.isDirectory() : !value.isFile())) {
    throw new Error("DEVELOPMENT_SMOKE_PRIVATE_PATH_INVALID");
  }
  assertUserOnlyStat(value.mode, value.uid, directory);
}

function assertUserOnlyStat(mode: number, uid: number, directory: boolean): void {
  if (uid !== process.getuid?.() || (mode & 0o077) !== 0 || (directory && (mode & 0o700) !== 0o700)) {
    throw new Error("DEVELOPMENT_SMOKE_PRIVATE_PERMISSIONS_INVALID");
  }
}

function assertControlledEnvironment(env: NodeJS.ProcessEnv | Record<string, string | undefined>): void {
  if (env.FERMATA_RUN_WITH_ENV !== "1") throw new Error("DEVELOPMENT_SMOKE_WRAPPER_REQUIRED");
  for (const key of Object.keys(env)) {
    if (/^(?:CODEFORCES|DASHSCOPE|EVAL|URMOTIV)_/u.test(key)) {
      throw new Error("DEVELOPMENT_SMOKE_ENVIRONMENT_NOT_NARROW");
    }
    if (/^FERMATA_/u.test(key) && key !== "FERMATA_RUN_WITH_ENV") {
      throw new Error("DEVELOPMENT_SMOKE_ENVIRONMENT_NOT_NARROW");
    }
  }
  if (env.AETHER_BASE_URL === undefined || env.AETHER_API_KEY === undefined) {
    throw new Error("DEVELOPMENT_SMOKE_AETHER_CONFIGURATION_INVALID");
  }
}

function extractExplicitRatings(row: Record<string, unknown>): number[] {
  const text = [row.contestUseText, row.finalDecisionText,
    ...(Array.isArray(row.reviewComments) ? row.reviewComments : []),
    ...(Array.isArray(row.identityValues) ? row.identityValues : [])]
    .map((value) => String(value ?? ""))
    .join(" ");
  const ratings = new Set<number>();
  for (const pattern of [
    /(?:难度|rating|cf)[^0-9]{0,10}(\d{3,4})/giu,
    /(\d{3,4})[^0-9]{0,6}(?:左右|难度)/giu,
    /【\s*(\d{3,4})[^】]*】/gu
  ]) {
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1]);
      if (value >= 800 && value <= 4_000) ratings.add(value);
    }
  }
  return [...ratings].sort((left, right) => left - right);
}

function difficultyBand(ratings: readonly number[]): "low" | "middle" | "high" | null {
  const bands = new Set(ratings.map((value) => value < 1_400 ? "low" : value < 2_200 ? "middle" : "high"));
  return bands.size === 1 ? [...bands][0]! : null;
}

function parseJson(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("DEVELOPMENT_SMOKE_PRIVATE_JSON_INVALID"); }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("DEVELOPMENT_SMOKE_PRIVATE_JSON_INVALID");
  }
  return value as Record<string, unknown>;
}

function checkpointBytes(state: PrivateCheckpoint): Buffer {
  return Buffer.from(`${JSON.stringify(state)}\n`, "utf8");
}

function checkpointName(revision: number): string {
  return `checkpoint-${String(revision).padStart(6, "0")}.private.json`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPathWithin(path: string, root: string): boolean {
  const pathRelative = relative(root, path);
  return pathRelative === "" || (!pathRelative.startsWith(`..${sep}`) && pathRelative !== "..");
}

function safeFailureCode(error: unknown): SafeFailureCode {
  let current = error;
  let stageFailure: SafeFailureCode | null = null;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if (current instanceof DevelopmentSmokeSafeError) return current.safeCode;
    if ("kind" in current) {
      const parsedKind = safeFailureCodeSchema.safeParse(current.kind);
      if (parsedKind.success) stageFailure ??= parsedKind.data;
    }
    current = "cause" in current ? current.cause : null;
  }
  return stageFailure ?? "final_failure";
}

function safeFailureLocation(error: unknown): string | null {
  let current = error;
  let location: string | null = null;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if (current instanceof Error && typeof current.stack === "string") {
      const frame = current.stack.split("\n").find((line) => line.includes("Fermata/"));
      const match = frame?.match(
        /at\s+(?:(?<symbol>[^\s(]+)\s+\()?[^()]*Fermata\/(?<path>[^():]+):(?<line>\d+):\d+\)?/u
      );
      if (match?.groups !== undefined) {
        location = `${match.groups.path}:${match.groups.line}:${match.groups.symbol ?? "anonymous"}`;
      }
    }
    current = "cause" in current ? current.cause : null;
  }
  return location;
}
