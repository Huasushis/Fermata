import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
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
  developmentSmokePhaseSlots,
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
import {
  buildHistoricalCalibrationReviewFlowTaskSource,
  type ReviewFlowTaskSourceResult
} from "../../src/review-flow/task-source";
import {
  DevelopmentDiagnosticRunController,
  expectedDiagnosticSlots,
  type DevelopmentDiagnosticSlot
} from "../../src/review-flow/development-diagnostic";
import {
  createReviewFlowLlmBundle,
  type ReviewFlowModelConfigs
} from "../../src/review-flow/llm-roles";
import {
  runReviewEvidenceFlowCalibrationOutcome,
  type ReviewFlowCalibrationOutcome
} from "../../src/review-flow/orchestrator";
import {
  reviewFlowRoleSchema,
  type ReviewFlowRole
} from "../../src/review-flow/schemas";
import type { LlmStageFailureKind } from "../../src/llm-scheduler";
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

const safeJsonTypeSchema = z.enum([
  "missing",
  "null",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "other"
]);
const safeShapeKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u);
const safePayloadFieldTypesSchema = z.object({
  content: safeJsonTypeSchema,
  reasoningContent: safeJsonTypeSchema,
  reasoning: safeJsonTypeSchema,
  role: safeJsonTypeSchema,
  functionCall: safeJsonTypeSchema,
  refusal: safeJsonTypeSchema,
  toolCalls: safeJsonTypeSchema
}).strict();
/**
 * Legacy ae47bbc SSE structure schema: raw unknown key arrays, no count/fingerprint.
 * Only used for reading old checkpoints; never for writing new records.
 */
const legacySafeSseStructureSchema = z.object({
  fieldTypes: z.object({
    choices: safeJsonTypeSchema,
    created: safeJsonTypeSchema,
    id: safeJsonTypeSchema,
    model: safeJsonTypeSchema,
    object: safeJsonTypeSchema,
    serviceTier: safeJsonTypeSchema,
    systemFingerprint: safeJsonTypeSchema,
    usage: safeJsonTypeSchema,
    error: safeJsonTypeSchema,
    control: safeJsonTypeSchema,
    choice: safeJsonTypeSchema,
    delta: safeJsonTypeSchema,
    message: safeJsonTypeSchema,
    finishReason: safeJsonTypeSchema,
    index: safeJsonTypeSchema,
    logprobs: safeJsonTypeSchema,
    deltaFields: safePayloadFieldTypesSchema,
    messageFields: safePayloadFieldTypesSchema
  }).strict(),
  choicesLength: z.enum(["0", "1", "many"]).nullable(),
  payloadSource: z.enum(["delta", "message", "both", "neither"]),
  finishReasonClass: z.enum([
    "missing",
    "null",
    "stop",
    "length",
    "content_filter",
    "unknown_string",
    "non_string"
  ]),
  finishReasonIsNull: z.boolean(),
  finishReasonUnknownStringHash: digestSchema.nullable(),
  hasUsageField: z.boolean(),
  hasErrorField: z.boolean(),
  hasControlField: z.boolean(),
  unknownTopLevelKeys: z.array(safeShapeKeySchema).max(32),
  unknownChoiceKeys: z.array(safeShapeKeySchema).max(32),
  unknownPayloadKeys: z.array(safeShapeKeySchema).max(32),
  unknownKeysFingerprint: digestSchema
}).strict();

const safeSseStructureSchema = z.object({
  fieldTypes: z.object({
    choices: safeJsonTypeSchema,
    created: safeJsonTypeSchema,
    id: safeJsonTypeSchema,
    model: safeJsonTypeSchema,
    object: safeJsonTypeSchema,
    serviceTier: safeJsonTypeSchema,
    systemFingerprint: safeJsonTypeSchema,
    usage: safeJsonTypeSchema,
    error: safeJsonTypeSchema,
    control: safeJsonTypeSchema,
    choice: safeJsonTypeSchema,
    delta: safeJsonTypeSchema,
    message: safeJsonTypeSchema,
    finishReason: safeJsonTypeSchema,
    index: safeJsonTypeSchema,
    logprobs: safeJsonTypeSchema,
    deltaFields: safePayloadFieldTypesSchema,
    messageFields: safePayloadFieldTypesSchema
  }).strict(),
  choicesLength: z.enum(["0", "1", "many"]).nullable(),
  payloadSource: z.enum(["delta", "message", "both", "neither"]),
  finishReasonClass: z.enum([
    "missing",
    "null",
    "stop",
    "length",
    "content_filter",
    "unknown_string",
    "non_string"
  ]),
  finishReasonIsNull: z.boolean(),
  finishReasonUnknownStringHash: digestSchema.nullable(),
  hasUsageField: z.boolean(),
  hasErrorField: z.boolean(),
  hasControlField: z.boolean(),
  unknownTopLevelKeyCount: z.number().int().nonnegative(),
  unknownTopLevelKeysFingerprint: digestSchema,
  unknownChoiceKeyCount: z.number().int().nonnegative(),
  unknownChoiceKeysFingerprint: digestSchema,
  unknownPayloadKeyCount: z.number().int().nonnegative(),
  unknownPayloadKeysFingerprint: digestSchema,
  unknownKeysFingerprint: digestSchema
}).strict();
const acceptedEventShapeSchema = z.object({
  category: z.enum([
    "done",
    "usage",
    "content",
    "reasoning",
    "content_reasoning",
    "role",
    "finish",
    "metadata"
  ]),
  shapeFingerprint: digestSchema,
  count: z.number().int().positive()
}).strict();

const safeRoundReceiptSchema = z.object({
  round: z.enum(["semantic", "format", "format_repair"]),
  firstValidOutputMs: z.number().int().nonnegative().nullable(),
  endToEndMs: z.number().int().nonnegative(),
  validOutputEventCount: z.number().int().positive(),
  transportAttemptCount: z.number().int().positive(),
  eofVerified: z.literal(true),
  acceptedEventShapes: z.array(acceptedEventShapeSchema).max(64).readonly()
}).strict();

const safeTimingSchema = z.object({
  firstValidOutputMs: z.number().int().nonnegative(),
  endToEndMs: z.number().int().nonnegative(),
  validOutputEventCount: z.number().int().positive(),
  outputUtf8Bytes: z.number().int().positive(),
  acceptedEventShapes: z.array(acceptedEventShapeSchema).max(64).readonly(),
  externalTransportAttemptsUsed: z.number().int().min(1).max(104).optional(),
  rounds: z.array(safeRoundReceiptSchema).min(2).max(3).readonly().optional()
}).strict().superRefine((value, context) => {
  if (value.endToEndMs < value.firstValidOutputMs) {
    context.addIssue({ code: "custom", message: "invalid timing order" });
  }
  if (value.rounds !== undefined) {
    const expectedOrder = ["semantic", "format", "format_repair"] as const;
    if (value.rounds.some((round, index) => round.round !== expectedOrder[index])) {
      context.addIssue({ code: "custom", message: "invalid round order" });
    }
    const roundTransportSum = value.rounds.reduce(
      (sum, round) => sum + round.transportAttemptCount,
      0
    );
    if (
      value.externalTransportAttemptsUsed !== undefined &&
      value.externalTransportAttemptsUsed !== roundTransportSum
    ) {
      context.addIssue({ code: "custom", message: "round transport mismatch" });
    }
  }
});
const safeReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  profileName: z.literal("development-smoke-6x4-v1"),
  profileFingerprint: digestSchema,
  manifestFingerprint: digestSchema,
  runBindingHash: digestSchema,
  anonymousSlot: slotSchema,
  phase: z.enum(["phase0", "phase1"]),
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
const stageFailureKindSchema = z.enum([
  "rate_limited",
  "server_error",
  "connect",
  "first_byte_timeout",
  "no_progress_timeout",
  "stream_interrupted",
  "output_limit",
  "schema_invalid",
  "permanent"
]);
/**
 * Legacy ae47bbc firstRejectedEvent schema: raw key arrays, no count/fingerprint, no errorEnvelope.
 * Only used for reading old checkpoints; never for writing new records.
 */
const legacyFirstRejectedEventSchema = z.object({
  eventOrdinal: z.number().int().positive(),
  completedEventCount: z.number().int().nonnegative(),
  dataFieldCount: z.number().int().nonnegative(),
  eventUtf8Bytes: z.number().int().nonnegative(),
  topLevelKeys: z.array(safeShapeKeySchema).max(32),
  choiceKeys: z.array(safeShapeKeySchema).max(32),
  deltaKeys: z.array(safeShapeKeySchema).max(32),
  shape: z.enum([
    "json_invalid",
    "non_object",
    "error_object",
    "choices_missing_or_non_array",
    "choice_non_object",
    "delta_missing_or_non_object",
    "delta_field_type",
    "finish_reason_type_or_unknown"
  ]),
  structure: legacySafeSseStructureSchema,
  shapeFingerprint: digestSchema
}).strict();

export const safeRequestFailureSchema = z.object({
  kind: stageFailureKindSchema,
  code: z.enum([
    "LLM_HTTP_ERROR",
    "LLM_NETWORK_FAILED",
    "LLM_FIRST_OUTPUT_TIMEOUT",
    "LLM_OUTPUT_IDLE_TIMEOUT",
    "LLM_TOTAL_TIMEOUT",
    "LLM_STREAM_INTERRUPTED",
    "LLM_CANCELLED",
    "LLM_REQUEST_START_BLOCKED",
    "LLM_TRANSPORT_DENIED",
    "LLM_OUTPUT_LENGTH_LIMIT",
    "LLM_OUTPUT_CONTENT_FILTERED",
    "LLM_RESPONSE_BODY_TOO_LARGE",
    "LLM_RESPONSE_FORMAT_INVALID",
    "LLM_JSON_OUTPUT_INVALID",
    "unknown"
  ]),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  requestCount: z.number().int().min(0).max(4),
  transportAttemptCount: z.number().int().nonnegative(),
  completedResponseCount: z.number().int().nonnegative(),
  terminalResponseMode: z.enum(["sse", "json"]).nullable(),
  terminalEofObserved: z.boolean(),
  terminalFinishReasonStopObserved: z.boolean(),
  terminalSseDoneObserved: z.boolean().nullable(),
  jsonSchemaValidated: z.literal(false).nullable(),
  streamEventCount: z.number().int().nonnegative(),
  streamUtf8Bytes: z.number().int().nonnegative(),
  streamChunkCount: z.number().int().nonnegative(),
  usageEventCount: z.number().int().nonnegative(),
  usageTotalTokens: z.number().int().nonnegative().nullable(),
  acceptedEventShapes: z.array(acceptedEventShapeSchema).max(64).readonly(),
  firstRejectedEvent: z.object({
    eventOrdinal: z.number().int().positive(),
    completedEventCount: z.number().int().nonnegative(),
    dataFieldCount: z.number().int().nonnegative(),
    eventUtf8Bytes: z.number().int().nonnegative(),
    topLevelKeys: z.array(safeShapeKeySchema).max(32),
    unknownTopLevelKeyCount: z.number().int().nonnegative(),
    unknownTopLevelKeysFingerprint: digestSchema,
    choiceKeys: z.array(safeShapeKeySchema).max(32),
    unknownChoiceKeyCount: z.number().int().nonnegative(),
    unknownChoiceKeysFingerprint: digestSchema,
    deltaKeys: z.array(safeShapeKeySchema).max(32),
    unknownPayloadKeyCount: z.number().int().nonnegative(),
    unknownPayloadKeysFingerprint: digestSchema,
    shape: z.enum([
      "json_invalid",
      "non_object",
      "error_object",
      "choices_missing_or_non_array",
      "choice_non_object",
      "delta_missing_or_non_object",
      "delta_field_type",
      "finish_reason_type_or_unknown"
    ]),
    structure: safeSseStructureSchema,
    errorEnvelope: z.object({
      present: z.literal(true),
      classification: z.enum(["known_fields_only", "unknown_fields_present", "non_object"]),
      fieldCount: z.number().int().nonnegative(),
      allowedFields: z.array(z.object({
        key: safeShapeKeySchema,
        type: safeJsonTypeSchema
      }).strict()).max(32),
      allowedNestedObjectKeys: z.array(safeShapeKeySchema).max(32),
      unknownFieldCount: z.number().int().nonnegative(),
      unknownKeysFingerprint: digestSchema,
      envelopeFingerprint: digestSchema
    }).strict().nullable().optional(),
    shapeFingerprint: digestSchema
  }).strict().nullable(),
  formatFailureStage: z.enum([
    "missing_body",
    "content_type",
    "json_utf8",
    "json_parse",
    "response_shape",
    "sse_utf8",
    "event_json",
    "event_shape",
    "delta_shape",
    "finish_shape",
    "trailing_data"
  ]).nullable(),
  formatFailureSubstage: z.enum([
    "duplicate_done",
    "data_after_done",
    "data_after_done_usage_metadata_only",
    "data_after_done_benign_controls_only",
    "data_after_done_json_syntax_invalid",
    "data_after_done_json_non_object",
    "data_after_done_error_object",
    "data_after_done_unknown_object_or_scan_limit",
    "data_after_done_choices_present",
    "data_after_done_content_or_tool_present",
    "data_after_done_other_or_unclassifiable",
    "data_after_done_tail_incomplete",
    "choice_after_stop"
  ]).nullable()
}).strict();

/**
 * Reader schema: accepts strict union of legacy ae47bbc OR current safe format.
 * Hybrid records (mixing raw arrays with count/fingerprint) fail both branches.
 * Writer/types for new records use safeRequestFailureSchema only.
 */
const legacySafeRequestFailureSchema = z.object({
  kind: stageFailureKindSchema,
  code: z.enum([
    "LLM_HTTP_ERROR",
    "LLM_NETWORK_FAILED",
    "LLM_FIRST_OUTPUT_TIMEOUT",
    "LLM_OUTPUT_IDLE_TIMEOUT",
    "LLM_TOTAL_TIMEOUT",
    "LLM_STREAM_INTERRUPTED",
    "LLM_CANCELLED",
    "LLM_REQUEST_START_BLOCKED",
    "LLM_TRANSPORT_DENIED",
    "LLM_OUTPUT_LENGTH_LIMIT",
    "LLM_OUTPUT_CONTENT_FILTERED",
    "LLM_RESPONSE_BODY_TOO_LARGE",
    "LLM_RESPONSE_FORMAT_INVALID",
    "LLM_JSON_OUTPUT_INVALID",
    "unknown"
  ]),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  requestCount: z.number().int().min(0).max(4),
  transportAttemptCount: z.number().int().nonnegative(),
  completedResponseCount: z.number().int().nonnegative(),
  terminalResponseMode: z.enum(["sse", "json"]).nullable(),
  terminalEofObserved: z.boolean(),
  terminalFinishReasonStopObserved: z.boolean(),
  terminalSseDoneObserved: z.boolean().nullable(),
  jsonSchemaValidated: z.literal(false).nullable(),
  streamEventCount: z.number().int().nonnegative(),
  streamUtf8Bytes: z.number().int().nonnegative(),
  streamChunkCount: z.number().int().nonnegative(),
  usageEventCount: z.number().int().nonnegative(),
  usageTotalTokens: z.number().int().nonnegative().nullable(),
  acceptedEventShapes: z.array(acceptedEventShapeSchema).max(64).readonly(),
  firstRejectedEvent: legacyFirstRejectedEventSchema.nullable(),
  formatFailureStage: z.enum([
    "missing_body",
    "content_type",
    "json_utf8",
    "json_parse",
    "response_shape",
    "sse_utf8",
    "event_json",
    "event_shape",
    "delta_shape",
    "finish_shape",
    "trailing_data"
  ]).nullable(),
  formatFailureSubstage: z.enum([
    "duplicate_done",
    "data_after_done",
    "data_after_done_json_non_object",
    "data_after_done_error_object",
    "data_after_done_unknown_object_or_scan_limit",
    "data_after_done_choices_present",
    "data_after_done_content_or_tool_present",
    "data_after_done_other_or_unclassifiable",
    "data_after_done_tail_incomplete",
    "choice_after_stop"
  ]).nullable()
}).strict();
export const safeRequestFailureReadSchema = z.union([
  safeRequestFailureSchema,
  legacySafeRequestFailureSchema
]);
const completedStageSchema = z.object({
  output: z.string().min(1),
  receipt: stageReceiptSchema
}).strict();
const requestLedgerSchema = z.object({
  receipt: safeReceiptSchema,
  timing: safeTimingSchema.optional(),
  completedStage: completedStageSchema.optional(),
  failureKind: stageFailureKindSchema.optional(),
  failureDetail: safeRequestFailureSchema.optional()
}).strict().superRefine((value, context) => {
  if (
    value.completedStage !== undefined &&
    (value.timing === undefined || value.failureKind !== undefined)
  ) {
    context.addIssue({ code: "custom", message: "completed stage state invalid" });
  }
  if (
    value.failureDetail !== undefined &&
    value.failureDetail.kind !== value.failureKind
  ) {
    context.addIssue({ code: "custom", message: "failure detail mismatch" });
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
const phaseReleaseSlotBinding = (
  slot: "slot-03" | "slot-04" | "slot-05" | "slot-06"
) => z.object({
  slot: z.literal(slot),
  slotBindingHash: digestSchema,
  truthBindingHash: digestSchema
}).strict();
const phase0ForecastSchema = z.object({
  basis: z.literal("phase0_measured_per_logical_request"),
  legacy31MinuteObservationUnit: z.literal("UNKNOWN"),
  durationEstimator: z.literal("nearest_rank_empirical_p90"),
  measuredLogicalRequestCount: z.literal(8),
  measurementFingerprint: digestSchema,
  estimatorFingerprint: digestSchema,
  observedLogicalRequestP90Ms: z.number().int().nonnegative(),
  observedFirstValidOutputP90Ms: z.number().int().nonnegative(),
  observedValidOutputEventsPerMinuteFloor: z.number().int().nonnegative(),
  remainingCriticalWaveCount: z.union([z.literal(3), z.literal(4)]),
  projectedAllSixP90Ms: z.number().int().nonnegative()
}).strict();
const phase1ReleaseSchema = z.object({
  schemaVersion: z.literal(1),
  t1: z.string().datetime(),
  releaseRevision: z.number().int().positive(),
  remainingSlots: z.tuple([
    phaseReleaseSlotBinding("slot-03"),
    phaseReleaseSlotBinding("slot-04"),
    phaseReleaseSlotBinding("slot-05"),
    phaseReleaseSlotBinding("slot-06")
  ]),
  phase0LogicalRequestsUsed: z.literal(8),
  phase0ExternalAttemptsUsed: z.literal(8),
  logicalRequestCeiling: z.literal(30),
  externalAttemptCeiling: z.literal(30),
  checkpointAfterMs: z.literal(15 * 60_000),
  reestimateAfterMs: z.literal(60 * 60_000),
  closeNewStagesAfterMs: z.literal(180 * 60_000),
  releaseBindingHash: digestSchema
}).strict();
const phaseMetricsSchema = z.object({
  requestCount: z.number().int().min(0).max(30),
  completedRequestCount: z.number().int().min(0).max(30),
  failedRequestCount: z.number().int().min(0).max(30),
  inflightRequestCount: z.number().int().min(0).max(30),
  measuredTimingCount: z.number().int().min(0).max(30),
  firstValidOutputP90Ms: z.number().int().nonnegative().nullable(),
  endToEndP90Ms: z.number().int().nonnegative().nullable()
}).strict();
const phase1EtaSchema = z.object({
  basis: z.enum(["phase0_fallback", "phase1_measured"]),
  measuredLogicalRequestCount: z.number().int().positive().max(30),
  observedLogicalRequestP90Ms: z.number().int().nonnegative(),
  remainingCriticalWaveCount: z.number().int().min(0).max(4),
  projectedRemainingMs: z.number().int().nonnegative(),
  projectedCompletionAt: z.string().datetime()
}).strict();
const runMetricsSchema = z.object({
  phase0: phaseMetricsSchema,
  phase1: phaseMetricsSchema,
  run: phaseMetricsSchema,
  remainingLogicalRequestBudget: z.number().int().min(0).max(30),
  phase1Eta: phase1EtaSchema.nullable()
}).strict();
const privateCheckpointBaseSchema = z.object({
  schemaVersion: z.literal(1),
  profileName: z.literal("development-smoke-6x4-v1"),
  profileFingerprint: digestSchema,
  manifestFingerprint: digestSchema,
  privateManifestFileSha256: digestSchema,
  runId: digestSchema,
  runBindingHash: digestSchema,
  codeVersion: z.string().regex(/^[a-f0-9]{40}$/u),
  phase: z.enum(["phase0", "phase1"]),
  state: z.enum(["prepared", "running", "phase0_complete", "complete", "incomplete"]),
  revision: z.number().int().positive(),
  previousCheckpointSha256: digestSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  requests: z.array(requestLedgerSchema).max(30),
  phase0Forecast: phase0ForecastSchema.nullable(),
  phase1Forecast: phase1EtaSchema.nullable().optional(),
  phase1Release: phase1ReleaseSchema.nullable().optional(),
  metrics: runMetricsSchema.optional(),
  stopReason: z.string().nullable(),
  failureCode: safeFailureCodeSchema.nullable().optional(),
  failureLocation: safeFailureLocationSchema.nullable().optional(),
  accuracyClaim: z.null(),
  includedInFinalCalibration: z.literal(false),
  phase1Released: z.boolean()
}).strict();
const privateCheckpointSchema = privateCheckpointBaseSchema.superRefine((value, context) => {
  const phase1State = value.phase === "phase1";
  if (value.phase1Released !== phase1State) {
    context.addIssue({ code: "custom", message: "phase release state invalid" });
  }
  if (phase1State) {
    if (
      value.phase1Release === undefined ||
      value.phase1Release === null ||
      !["running", "complete", "incomplete"].includes(value.state)
    ) {
      context.addIssue({ code: "custom", message: "phase1 checkpoint invalid" });
    }
  } else if (
    (value.phase1Release !== undefined && value.phase1Release !== null) ||
    value.phase1Forecast !== undefined ||
    value.state === "complete"
  ) {
    context.addIssue({ code: "custom", message: "phase0 checkpoint invalid" });
  }
});
const privateCheckpointSchemaForWrite = privateCheckpointBaseSchema.superRefine(
  (value, context) => {
    const parsed = privateCheckpointSchema.safeParse(value);
    if (!parsed.success) {
      context.addIssue({ code: "custom", message: "checkpoint state invalid" });
    }
    if (value.metrics === undefined) {
      context.addIssue({ code: "custom", message: "checkpoint metrics missing" });
    }
  }
);

/**
 * Read-only request ledger schema: uses safeRequestFailureReadSchema (legacy OR current union)
 * for failureDetail. Used only for parsing checkpoint files on disk.
 * Writer/in-memory schema (requestLedgerSchema) remains current-only.
 */
const requestLedgerReadSchema = z.object({
  receipt: safeReceiptSchema,
  timing: safeTimingSchema.optional(),
  completedStage: completedStageSchema.optional(),
  failureKind: stageFailureKindSchema.optional(),
  failureDetail: safeRequestFailureReadSchema.optional()
}).strict().superRefine((value, context) => {
  if (
    value.completedStage !== undefined &&
    (value.timing === undefined || value.failureKind !== undefined)
  ) {
    context.addIssue({ code: "custom", message: "completed stage state invalid" });
  }
  if (
    value.failureDetail !== undefined &&
    value.failureDetail.kind !== value.failureKind
  ) {
    context.addIssue({ code: "custom", message: "failure detail mismatch" });
  }
  if (value.completedStage?.receipt.stage !== undefined &&
      value.completedStage.receipt.stage !== value.receipt.stage) {
    context.addIssue({ code: "custom", message: "stage binding mismatch" });
  }
});

/**
 * Read-only checkpoint base schema: uses requestLedgerReadSchema for requests array.
 * Accepts legacy ae47bbc OR current checkpoint files; never used for writing.
 */
const privateCheckpointBaseReadSchema = z.object({
  schemaVersion: z.literal(1),
  profileName: z.literal("development-smoke-6x4-v1"),
  profileFingerprint: digestSchema,
  manifestFingerprint: digestSchema,
  privateManifestFileSha256: digestSchema,
  runId: digestSchema,
  runBindingHash: digestSchema,
  codeVersion: z.string().regex(/^[a-f0-9]{40}$/u),
  phase: z.enum(["phase0", "phase1"]),
  state: z.enum(["prepared", "running", "phase0_complete", "complete", "incomplete"]),
  revision: z.number().int().positive(),
  previousCheckpointSha256: digestSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  requests: z.array(requestLedgerReadSchema).max(30),
  phase0Forecast: phase0ForecastSchema.nullable(),
  phase1Forecast: phase1EtaSchema.nullable().optional(),
  phase1Release: phase1ReleaseSchema.nullable().optional(),
  metrics: runMetricsSchema.optional(),
  stopReason: z.string().nullable(),
  failureCode: safeFailureCodeSchema.nullable().optional(),
  failureLocation: safeFailureLocationSchema.nullable().optional(),
  accuracyClaim: z.null(),
  includedInFinalCalibration: z.literal(false),
  phase1Released: z.boolean()
}).strict();

/**
 * Read-only checkpoint schema: same phase validation as privateCheckpointSchema,
 * but accepts legacy OR current request ledger entries. Used for file read/resume path.
 */
export const privateCheckpointReadSchema = privateCheckpointBaseReadSchema.superRefine((value, context) => {
  const phase1State = value.phase === "phase1";
  if (value.phase1Released !== phase1State) {
    context.addIssue({ code: "custom", message: "phase release state invalid" });
  }
  if (phase1State) {
    if (
      value.phase1Release === undefined ||
      value.phase1Release === null ||
      !["running", "complete", "incomplete"].includes(value.state)
    ) {
      context.addIssue({ code: "custom", message: "phase1 checkpoint invalid" });
    }
  } else if (
    (value.phase1Release !== undefined && value.phase1Release !== null) ||
    value.phase1Forecast !== undefined ||
    value.state === "complete"
  ) {
    context.addIssue({ code: "custom", message: "phase0 checkpoint invalid" });
  }
});
// Existing Phase 0 checkpoints omit the optional Phase 1 and metrics fields.
// They remain readable byte-for-byte; every new revision is append-only.

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
  /**
   * 任务候选绑定指纹：assignmentId + problemContentHash + tagCatalogVersion。
   * 由 preflight 从源文件构建的任务源计算，runner 用它校验调用方传入的
   * taskCandidate 与 preflight 时绑定到该 slot 的任务同一。
   * 可选：仅 `runDevelopmentDiagnosticPhase`（经 diagnostic registrar）强制要求。
   */
  readonly taskBindingFingerprint?: string;
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
  /**
   * 仅诊断路径（`preflightDevelopmentDiagnostic`/`runDevelopmentDiagnosticPhase`）消费；
   * phase0/phase1 冒烟无需这两个绑定字段。真实 `preflightDevelopmentSmoke` 总是填充。
   */
  readonly duplicateSimilarityRejectThreshold?: number;
  readonly experimentVersion?: string;
  readonly configuredRoleModelsFingerprint?: string;
  readonly difficultyAnchors?: readonly DifficultyAnchor[];
}

export interface PaidExecutionSourceContractFilesystemHooks {
  readonly beforeDirectoryRead?: (input: { readonly sourceId: string }) => void;
  readonly beforeFileRead?: (input: { readonly sourceId: string }) => void;
  readonly afterFileRead?: (input: { readonly sourceId: string }) => void;
}

export interface DevelopmentSmokePreflightOptions {
  readonly repositoryRoot: string;
  readonly projectRoot: string;
  readonly manifestPath: string;
  readonly codeVersion: string;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly modelsYamlSource?: string;
  readonly allowedPrivateRoots?: readonly string[];
  readonly paidExecutionSourceContractFingerprint?: string;
  readonly paidExecutionSourceContractFilesystemHooks?:
    PaidExecutionSourceContractFilesystemHooks;
  readonly difficultyAnchorsOverride?: readonly DifficultyAnchor[];
}

const paidExecutionEntrySourceFiles = Object.freeze([
  "config/anchors/difficulty.json",
  "config/models.yaml",
  "experiments/lib/development-diagnostic-run-state.ts",
  "experiments/lib/development-smoke-launcher.ts",
  "experiments/run-development-diagnostic.ts",
  "scripts/development-diagnostic-bootstrap.mjs",
  "scripts/env-file.mjs",
  "scripts/private-runtime.mjs",
  "scripts/run-with-env.mjs"
] as const);

const excludedSourceTreeDirectories = new Set([
  "__tests__",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "private",
  "test",
  "tests"
]);

const packageExecutionContractSchema = z.object({
  type: z.enum(["module", "commonjs"]),
  engines: z.object({
    node: z.string().trim().min(1).max(200)
  }).passthrough(),
  scripts: z.object({
    "diagnostic:development": z.string().trim().min(1).max(2_000)
  }).passthrough()
}).passthrough();

interface PaidExecutionSourceDigest {
  readonly sourceId: string;
  readonly contentSha256: string;
}

interface PaidSourceIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly rdev: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function paidSourceIdentity(descriptor: number): PaidSourceIdentity {
  const stat = fstatSync(descriptor, { bigint: true });
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    uid: stat.uid,
    gid: stat.gid,
    rdev: stat.rdev,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs
  });
}

function samePaidSourceIdentity(
  left: PaidSourceIdentity,
  right: PaidSourceIdentity
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.rdev === right.rdev &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function procDescriptorPath(descriptor: number, name?: string): string {
  return name === undefined
    ? `/proc/self/fd/${descriptor}`
    : `/proc/self/fd/${descriptor}/${name}`;
}

function openPaidSourceAt(
  parentDescriptor: number,
  name: string,
  directory: boolean
): number {
  if (name.length === 0 || name === "." || name === ".." || name.includes("/")) {
    throw new Error("invalid paid source name");
  }
  return openSync(
    procDescriptorPath(parentDescriptor, name),
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      (directory ? constants.O_DIRECTORY : 0)
  );
}

function assertPaidSourceTypeAndOwner(
  descriptor: number,
  expectedOwner: bigint,
  expectedType: "directory" | "file"
): PaidSourceIdentity {
  const stat = fstatSync(descriptor, { bigint: true });
  if (
    stat.uid !== expectedOwner ||
    (expectedType === "directory" ? !stat.isDirectory() : !stat.isFile())
  ) {
    throw new Error("invalid paid source identity");
  }
  return paidSourceIdentity(descriptor);
}

function assertPaidSourceBinding(
  parentDescriptor: number,
  name: string,
  expectedIdentity: PaidSourceIdentity,
  expectedOwner: bigint,
  expectedType: "directory" | "file"
): void {
  let verificationDescriptor: number | undefined;
  try {
    verificationDescriptor = openPaidSourceAt(
      parentDescriptor,
      name,
      expectedType === "directory"
    );
    const currentIdentity = assertPaidSourceTypeAndOwner(
      verificationDescriptor,
      expectedOwner,
      expectedType
    );
    if (!samePaidSourceIdentity(currentIdentity, expectedIdentity)) {
      throw new Error("paid source binding changed");
    }
  } finally {
    if (verificationDescriptor !== undefined) closeSync(verificationDescriptor);
  }
}

function readPaidSourceDescriptor(
  input: {
    readonly parentDescriptor: number;
    readonly parentIdentity: PaidSourceIdentity;
    readonly name: string;
    readonly descriptor: number;
    readonly sourceId: string;
    readonly owner: bigint;
    readonly hooks?: PaidExecutionSourceContractFilesystemHooks;
  }
): Buffer {
  const identityBefore = assertPaidSourceTypeAndOwner(
    input.descriptor,
    input.owner,
    "file"
  );
  if (!samePaidSourceIdentity(
    input.parentIdentity,
    paidSourceIdentity(input.parentDescriptor)
  )) {
    throw new Error("paid source parent changed");
  }
  input.hooks?.beforeFileRead?.({ sourceId: input.sourceId });
  assertPaidSourceBinding(
    input.parentDescriptor,
    input.name,
    identityBefore,
    input.owner,
    "file"
  );
  if (!samePaidSourceIdentity(
    input.parentIdentity,
    paidSourceIdentity(input.parentDescriptor)
  )) {
    throw new Error("paid source parent changed");
  }
  const bytes = readFileSync(input.descriptor);
  const identityAfter = assertPaidSourceTypeAndOwner(
    input.descriptor,
    input.owner,
    "file"
  );
  if (
    !samePaidSourceIdentity(identityBefore, identityAfter) ||
    BigInt(bytes.byteLength) !== identityBefore.size
  ) {
    throw new Error("paid source changed while reading");
  }
  assertPaidSourceBinding(
    input.parentDescriptor,
    input.name,
    identityBefore,
    input.owner,
    "file"
  );
  if (!samePaidSourceIdentity(
    input.parentIdentity,
    paidSourceIdentity(input.parentDescriptor)
  )) {
    throw new Error("paid source parent changed");
  }
  input.hooks?.afterFileRead?.({ sourceId: input.sourceId });
  return bytes;
}

function collectPaidExecutionSrcTree(
  input: {
    readonly parentDescriptor: number;
    readonly name: string;
    readonly descriptor: number;
    readonly sourceId: string;
    readonly owner: bigint;
    readonly hooks?: PaidExecutionSourceContractFilesystemHooks;
  },
  result: PaidExecutionSourceDigest[]
): void {
  const directoryIdentity = assertPaidSourceTypeAndOwner(
    input.descriptor,
    input.owner,
    "directory"
  );
  input.hooks?.beforeDirectoryRead?.({ sourceId: input.sourceId });
  assertPaidSourceBinding(
    input.parentDescriptor,
    input.name,
    directoryIdentity,
    input.owner,
    "directory"
  );
  const names = readdirSync(procDescriptorPath(input.descriptor))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (!samePaidSourceIdentity(
    directoryIdentity,
    paidSourceIdentity(input.descriptor)
  )) {
    throw new Error("paid source directory changed");
  }
  for (const name of names) {
    let childDescriptor: number | undefined;
    try {
      childDescriptor = openPaidSourceAt(input.descriptor, name, false);
      if (!samePaidSourceIdentity(
        directoryIdentity,
        paidSourceIdentity(input.descriptor)
      )) {
        throw new Error("paid source directory changed");
      }
      const childStat = fstatSync(childDescriptor, { bigint: true });
      if (childStat.uid !== input.owner || childStat.isSymbolicLink()) {
        throw new Error("invalid paid source child");
      }
      if (childStat.isDirectory()) {
        if (!excludedSourceTreeDirectories.has(name)) {
          collectPaidExecutionSrcTree({
            parentDescriptor: input.descriptor,
            name,
            descriptor: childDescriptor,
            sourceId: `${input.sourceId}/${name}`,
            owner: input.owner,
            ...(input.hooks === undefined ? {} : { hooks: input.hooks })
          }, result);
        }
      } else if (childStat.isFile()) {
        if (
          name.endsWith(".ts") &&
          !name.endsWith(".test.ts") &&
          !name.endsWith(".spec.ts")
        ) {
          const sourceId = `${input.sourceId}/${name}`;
          const bytes = readPaidSourceDescriptor({
            parentDescriptor: input.descriptor,
            parentIdentity: directoryIdentity,
            name,
            descriptor: childDescriptor,
            sourceId,
            owner: input.owner,
            ...(input.hooks === undefined ? {} : { hooks: input.hooks })
          });
          result.push(Object.freeze({
            sourceId,
            contentSha256: sha256(bytes)
          }));
        }
      } else {
        throw new Error("invalid paid source tree entry");
      }
    } finally {
      if (childDescriptor !== undefined) closeSync(childDescriptor);
    }
    if (!samePaidSourceIdentity(
      directoryIdentity,
      paidSourceIdentity(input.descriptor)
    )) {
      throw new Error("paid source directory changed");
    }
  }
  assertPaidSourceBinding(
    input.parentDescriptor,
    input.name,
    directoryIdentity,
    input.owner,
    "directory"
  );
}

function withPaidSourceParentDirectory<T>(
  rootDescriptor: number,
  owner: bigint,
  directoryNames: readonly string[],
  operation: (
    parentDescriptor: number,
    parentIdentity: PaidSourceIdentity
  ) => T
): T {
  const descriptors = [rootDescriptor];
  const identities: PaidSourceIdentity[] = [paidSourceIdentity(rootDescriptor)];
  try {
    for (const name of directoryNames) {
      const parentDescriptor = descriptors.at(-1)!;
      const descriptor = openPaidSourceAt(parentDescriptor, name, true);
      identities.push(assertPaidSourceTypeAndOwner(descriptor, owner, "directory"));
      descriptors.push(descriptor);
    }
    return operation(descriptors.at(-1)!, identities.at(-1)!);
  } finally {
    for (let index = descriptors.length - 1; index > 0; index -= 1) {
      const descriptor = descriptors[index]!;
      const parentDescriptor = descriptors[index - 1]!;
      const name = directoryNames[index - 1]!;
      try {
        assertPaidSourceBinding(
          parentDescriptor,
          name,
          identities[index]!,
          owner,
          "directory"
        );
      } finally {
        closeSync(descriptor);
      }
    }
  }
}

function readPaidExecutionEntry(
  rootDescriptor: number,
  owner: bigint,
  sourceId: string,
  hooks?: PaidExecutionSourceContractFilesystemHooks
): Buffer {
  const components = sourceId.split("/");
  const name = components.pop()!;
  return withPaidSourceParentDirectory(
    rootDescriptor,
    owner,
    components,
    (parentDescriptor, parentIdentity) => {
      let descriptor: number | undefined;
      try {
        descriptor = openPaidSourceAt(parentDescriptor, name, false);
        return readPaidSourceDescriptor({
          parentDescriptor,
          parentIdentity,
          name,
          descriptor,
          sourceId,
          owner,
          ...(hooks === undefined ? {} : { hooks })
        });
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }
  );
}

function paidExecutionSourceContractFingerprint(
  repositoryRoot: string,
  hooks?: PaidExecutionSourceContractFilesystemHooks
): string {
  let rootDescriptor: number | undefined;
  try {
    const requestedRoot = resolve(repositoryRoot);
    rootDescriptor = openSync(
      requestedRoot,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY
    );
    const rootStat = fstatSync(rootDescriptor, { bigint: true });
    if (
      !rootStat.isDirectory() ||
      realpathSync(procDescriptorPath(rootDescriptor)) !== requestedRoot
    ) {
      throw new Error("invalid paid source root");
    }
    const rootIdentity = paidSourceIdentity(rootDescriptor);
    const owner = rootIdentity.uid;
    const sourceDigests: PaidExecutionSourceDigest[] = [];
    let srcDescriptor: number | undefined;
    try {
      srcDescriptor = openPaidSourceAt(rootDescriptor, "src", true);
      collectPaidExecutionSrcTree({
        parentDescriptor: rootDescriptor,
        name: "src",
        descriptor: srcDescriptor,
        sourceId: "src",
        owner,
        ...(hooks === undefined ? {} : { hooks })
      }, sourceDigests);
    } finally {
      if (srcDescriptor !== undefined) closeSync(srcDescriptor);
    }
    for (const sourceId of paidExecutionEntrySourceFiles) {
      sourceDigests.push(Object.freeze({
        sourceId,
        contentSha256: sha256(
          readPaidExecutionEntry(rootDescriptor, owner, sourceId, hooks)
        )
      }));
    }
    const packageContract = packageExecutionContractSchema.parse(
      JSON.parse(
        readPaidExecutionEntry(rootDescriptor, owner, "package.json", hooks)
          .toString("utf8")
      )
    );
    if (!samePaidSourceIdentity(
      rootIdentity,
      paidSourceIdentity(rootDescriptor)
    )) {
      throw new Error("paid source root changed");
    }
    let rootVerificationDescriptor: number | undefined;
    try {
      rootVerificationDescriptor = openSync(
        requestedRoot,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY
      );
      const currentRootIdentity = assertPaidSourceTypeAndOwner(
        rootVerificationDescriptor,
        owner,
        "directory"
      );
      if (!samePaidSourceIdentity(rootIdentity, currentRootIdentity)) {
        throw new Error("paid source root binding changed");
      }
    } finally {
      if (rootVerificationDescriptor !== undefined) {
        closeSync(rootVerificationDescriptor);
      }
    }
    sourceDigests.sort((left, right) =>
      left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0
    );
    return hashCanonicalValue({
      schemaVersion: 1,
      sources: sourceDigests,
      packageExecutionContract: {
        type: packageContract.type,
        nodeEngine: packageContract.engines.node,
        diagnosticDevelopmentScript:
          packageContract.scripts["diagnostic:development"]
      }
    });
  } catch {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_SOURCE_CONTRACT_UNAVAILABLE");
  } finally {
    if (rootDescriptor !== undefined) closeSync(rootDescriptor);
  }
}

const difficultyAnchorContractSchema = z.object({
  contestId: z.number().int().positive(),
  index: z.string().trim().min(1).max(10),
  rating: z.number().int().min(800).max(3500),
  summary: z.string().trim().min(1).max(2_000)
}).strict();

function paidExecutionContractFingerprint(input: {
  readonly sourceContractFingerprint: string;
  readonly duplicateSimilarityRejectThreshold: number;
  readonly difficultyAnchors: readonly DifficultyAnchor[];
}): string {
  return hashCanonicalValue({
    schemaVersion: 1,
    sourceContractFingerprint: digestSchema.parse(input.sourceContractFingerprint),
    duplicateSimilarityRejectThreshold: input.duplicateSimilarityRejectThreshold,
    difficultyAnchors: input.difficultyAnchors
  });
}

export function preflightDevelopmentSmoke(
  options: DevelopmentSmokePreflightOptions
): DevelopmentSmokePreflight {
  assertControlledEnvironment(options.env ?? process.env);
  return preflightDevelopmentSmokeAfterControlledEnvironment(options);
}

function preflightDevelopmentSmokeAfterControlledEnvironment(
  options: DevelopmentSmokePreflightOptions
): DevelopmentSmokePreflight {
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
  const difficultyAnchors = (
    options.difficultyAnchorsOverride === undefined
      ? loadDifficultyAnchors()
      : z.array(difficultyAnchorContractSchema).max(50).parse(options.difficultyAnchorsOverride)
  ).map((anchor) => Object.freeze({ ...anchor }));
  if (difficultyAnchors.length === 0) {
    throw new Error("DEVELOPMENT_SMOKE_DIFFICULTY_ANCHORS_MISSING");
  }
  const cases = privateManifest.bindings.map((binding) => {
    const task = parseJson(readBoundFile(binding.source, allowedPrivateRoots));
    const built = buildHistoricalCalibrationReviewFlowTaskSource(task, {
      duplicateSimilarityRejectThreshold: modelState.duplicateSimilarityReject
    });
    return {
      slot: binding.slot,
      sourceBinding: binding.slotBindingHash,
      source: buildFourCallSource(
        binding,
        allowedPrivateRoots,
        modelState.duplicateSimilarityReject,
        difficultyAnchors
      ),
      truthBindingHash: binding.truth.truthBindingSha256,
      taskBindingFingerprint: hashCanonicalValue({
        assignmentId: built.taskBinding.assignmentId,
        problemContentHash: built.taskBinding.problemContentHash,
        tagCatalogVersion: built.taskBinding.tagCatalogVersion
      })
    };
  });
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
    }),
    duplicateSimilarityRejectThreshold: modelState.duplicateSimilarityReject,
    configuredRoleModelsFingerprint: modelState.configuredRoleModelsFingerprint,
    difficultyAnchors: Object.freeze(difficultyAnchors),
    experimentVersion: modelState.experimentVersion
  });
}

/* ── 诊断预检权威：仅本模块内部持有 ── */

/**
 * 不透明诊断预检令牌：仅可由本模块 `preflightDevelopmentDiagnostic`
 * （内部直接调用生产 `preflightDevelopmentSmoke`）经 `registerDiagnosticPreflight`
 * 创建。调用方无法用结构相同的对象冒充——WeakMap 权威快照仅限本模块内部持有。
 */
export interface DevelopmentDiagnosticPreflight {
  readonly manifestFingerprint: string;
  readonly cases: readonly {
    readonly slot: DevelopmentDiagnosticSlot;
    readonly sourceBinding: string;
    readonly source: FourCallReviewSource;
    readonly truthBindingHash: string;
    readonly taskBindingFingerprint: string;
  }[];
  readonly roleModels: ReviewFlowModelConfigs;
  readonly roleModelsFingerprint: string;
  readonly difficultyAnchors: readonly DifficultyAnchor[];
  readonly includedInFinalCalibration: false;
  readonly phase1Concept: false;
  /**
   * 权威绑定：preflight 令牌与 preflight 时的运行参数不可篡改地绑定。
   * runner 必须逐一校验这些字段与调用方传入的 taskCandidates/threshold/profile/version 一致。
   */
  readonly duplicateSimilarityRejectThreshold: number;
  readonly profileName: string;
  readonly experimentVersion: string;
  readonly paidExecutionContractFingerprint: string;
  readonly caseBindingFingerprints: readonly string[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function diagnosticCaseBindingFingerprint(
  entry: DevelopmentDiagnosticPreflight["cases"][number]
): string {
  return hashCanonicalValue({
    slot: entry.slot,
    sourceBinding: entry.sourceBinding,
    truthBindingHash: entry.truthBindingHash,
    taskBindingFingerprint: entry.taskBindingFingerprint
  });
}
/**
 * Paid diagnostic credential identity. The versioned domain and fixed-order
 * length framing keep this digest separate from every other project hash.
 * Only the digest is returned; credential bytes and their metadata are never
 * placed in preflight/state/output records.
 */
function diagnosticCredentialIdentityFingerprint(
  model: Pick<PipelineModelConfig, "spec" | "credentials">
): string {
  const hash = createHash("sha256");
  hash.update(
    "fermata.development-diagnostic.credential-identity\u0000v1\u0000",
    "utf8"
  );
  const frame = Buffer.allocUnsafe(8);
  for (const value of [
    model.spec.provider,
    model.credentials.baseUrl,
    model.credentials.apiKey
  ]) {
    frame.writeBigUInt64BE(BigInt(Buffer.byteLength(value, "utf8")));
    hash.update(frame);
    hash.update(value, "utf8");
  }
  return hash.digest("hex");
}

function diagnosticProxyEnvironmentIdentityFingerprint(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): string {
  const selectedHttp = env.http_proxy ?? env.HTTP_PROXY;
  const effectiveHttp = selectedHttp ? selectedHttp : null;
  const selectedHttps = env.https_proxy ?? env.HTTPS_PROXY;
  const effectiveHttps = selectedHttps ? selectedHttps : effectiveHttp;
  const selectedNoProxy = env.no_proxy ?? env.NO_PROXY ?? "";
  const noProxyEntries = selectedNoProxy.split(/[,\s]/u)
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const parsed = entry.match(/^(.+):(\d+)$/u);
      return {
        hostname: (parsed?.[1] ?? entry).replace(/^\*?\./u, "").toLowerCase(),
        port: parsed === null ? 0 : Number.parseInt(parsed[2]!, 10)
      };
    })
    .sort((left, right) =>
      left.hostname.localeCompare(right.hostname) || left.port - right.port);
  const hash = createHash("sha256");
  hash.update(
    "fermata.development-diagnostic.proxy-environment-identity\u0000v1\u0000",
    "utf8"
  );
  const frame = Buffer.allocUnsafe(8);
  for (const value of [
    effectiveHttp ?? "\u0000",
    effectiveHttps ?? "\u0000",
    selectedNoProxy === "*" ? "*" : JSON.stringify(noProxyEntries)
  ]) {
    frame.writeBigUInt64BE(BigInt(Buffer.byteLength(value, "utf8")));
    hash.update(frame);
    hash.update(value, "utf8");
  }
  return hash.digest("hex");
}

function diagnosticRoleModelsFingerprint(
  models: ReviewFlowModelConfigs,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): string {
  return hashCanonicalValue({
    proxyEnvironmentIdentityFingerprint:
      diagnosticProxyEnvironmentIdentityFingerprint(env),
    roleModels: reviewFlowRoleSchema.options.map((role) => {
      const model = models[role];
      return {
        role,
        spec: model.spec,
        credentialIdentityFingerprint:
          diagnosticCredentialIdentityFingerprint(model),
        runtime: {
          outputIdleTimeoutMs: model.runtime.outputIdleTimeoutMs,
          firstOutputTimeoutMs: model.runtime.firstOutputTimeoutMs ?? null,
          maximumDurationMs: model.runtime.maximumDurationMs ?? null,
          maxAttempts: model.runtime.maxAttempts,
          baseDelayMs: model.runtime.baseDelayMs
        }
      };
    })
  });
}
function captureDiagnosticPreflightOptions(
  options: DevelopmentSmokePreflightOptions
): DevelopmentSmokePreflightOptions {
  return deepFreeze({
    repositoryRoot: options.repositoryRoot,
    projectRoot: options.projectRoot,
    manifestPath: options.manifestPath,
    codeVersion: options.codeVersion,
    ...(options.paidExecutionSourceContractFilesystemHooks === undefined
      ? {}
      : {
          paidExecutionSourceContractFilesystemHooks:
            options.paidExecutionSourceContractFilesystemHooks
        }),
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    ...(options.modelsYamlSource === undefined
      ? {}
      : { modelsYamlSource: options.modelsYamlSource }),
    ...(options.allowedPrivateRoots === undefined
      ? {}
      : { allowedPrivateRoots: [...options.allowedPrivateRoots] }),
    ...(options.paidExecutionSourceContractFingerprint === undefined
      ? {}
      : {
          paidExecutionSourceContractFingerprint:
            options.paidExecutionSourceContractFingerprint
        }),
    ...(options.difficultyAnchorsOverride === undefined
      ? {}
      : {
          difficultyAnchorsOverride:
            options.difficultyAnchorsOverride.map((anchor) => ({ ...anchor }))
        })
  });
}

interface DevelopmentDiagnosticTrustedExecution {
  readonly slot: DevelopmentDiagnosticSlot;
  readonly taskSource: ReviewFlowTaskSourceResult;
  readonly taskSourceFingerprint: string;
}

function buildDiagnosticTrustedExecutions(
  smoke: DevelopmentSmokePreflight,
  options: DevelopmentSmokePreflightOptions,
  selectedSlots: readonly DevelopmentDiagnosticSlot[]
): readonly DevelopmentDiagnosticTrustedExecution[] {
  const projectRoot = realpathSync(options.projectRoot);
  const allowedPrivateRoots = (options.allowedPrivateRoots ?? [
    resolve(projectRoot, "Fermata/private"),
    resolve(projectRoot, "Urmotiv/private")
  ]).map((root) => realpathSync(root));
  if (typeof smoke.duplicateSimilarityRejectThreshold !== "number") {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_PREFLIGHT_SLOTS_INVALID");
  }
  const duplicateSimilarityRejectThreshold = smoke.duplicateSimilarityRejectThreshold;
  return deepFreeze(selectedSlots.map((slot) => {
    const binding = smoke.privateManifest.bindings.find((entry) => entry.slot === slot);
    if (binding === undefined) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_PREFLIGHT_SLOT_MISSING");
    }
    const taskCandidate = parseJson(readBoundFile(binding.source, allowedPrivateRoots));
    const taskSource = buildHistoricalCalibrationReviewFlowTaskSource(taskCandidate, {
      duplicateSimilarityRejectThreshold
    });
    return {
      slot,
      taskSource,
      taskSourceFingerprint: hashCanonicalValue(taskSource)
    };
  }));
}


interface DevelopmentDiagnosticPreflightAuthority {
  readonly manifestFingerprint: string;
  readonly cases: DevelopmentDiagnosticPreflight["cases"];
  readonly roleModels: ReviewFlowModelConfigs;
  readonly roleModelsFingerprint: string;
  readonly paidExecutionContractFingerprint: string;
  readonly difficultyAnchors: readonly DifficultyAnchor[];
  readonly duplicateSimilarityRejectThreshold: number;
  readonly profileName: string;
  readonly experimentVersion: string;
  readonly caseBindingFingerprints: readonly string[];
  readonly revalidationOptions: DevelopmentSmokePreflightOptions;
  readonly trustedExecutions: readonly DevelopmentDiagnosticTrustedExecution[];
}

const registeredDiagnosticPreflights =
  new WeakMap<object, DevelopmentDiagnosticPreflightAuthority>();
/**
 * 模块私有登记器：接收 `preflightDevelopmentSmoke` 产生的 6×4 预检数据，
 * 选取 slot-01/02，将 4 阶段模型映射为 11 角色配置，登记为不透明令牌。
 */
function registerDiagnosticPreflight(input: {
  readonly manifestFingerprint: string;
  readonly cases: readonly {
    readonly slot: string;
    readonly sourceBinding: string;
    readonly source: FourCallReviewSource;
    readonly truthBindingHash: string;
    readonly taskBindingFingerprint?: string;
  }[];
  readonly fourCallModels: FourCallRuntimeModels;
  readonly difficultyAnchors: readonly DifficultyAnchor[];
  readonly safeSummary: {
    readonly slots: number;
    readonly provider: string;
    readonly models: readonly string[];
  };
  readonly duplicateSimilarityRejectThreshold: number;
  readonly profileName: string;
  readonly experimentVersion: string;
  readonly configuredRoleModelsFingerprint: string;
  readonly paidExecutionContractFingerprint: string;
  readonly revalidationOptions: DevelopmentSmokePreflightOptions;
  readonly selectedSlots: readonly DevelopmentDiagnosticSlot[];
  readonly trustedExecutions: readonly DevelopmentDiagnosticTrustedExecution[];
}): DevelopmentDiagnosticPreflight {
  if (input.safeSummary.slots !== 6) {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_PREFLIGHT_SLOTS_INVALID");
  }
  if (input.safeSummary.provider !== "aether") {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_PREFLIGHT_PROVIDER_INVALID");
  }
  if (input.cases.length !== 6) {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_PREFLIGHT_CASES_INVALID");
  }
  const selected = deepFreeze(input.selectedSlots.map((slot) => {
    const found = input.cases.find((entry) => entry.slot === slot);
    if (found === undefined) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_PREFLIGHT_SLOT_MISSING");
    }
    if (typeof found.taskBindingFingerprint !== "string" || found.taskBindingFingerprint.length === 0) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_PREFLIGHT_CASES_INVALID");
    }
    return { ...found, slot, taskBindingFingerprint: found.taskBindingFingerprint };
  }));
  const roleModels = mapFourCallToRoleModels(input.fourCallModels);
  const roleModelsFingerprint = input.configuredRoleModelsFingerprint;
  const executionContractFingerprint = input.paidExecutionContractFingerprint;
  const difficultyAnchors = deepFreeze(input.difficultyAnchors.map((anchor) => ({ ...anchor })));
  const caseBindingFingerprints = deepFreeze(
    selected.map((entry) => diagnosticCaseBindingFingerprint(entry))
  );
  const preflight = deepFreeze({
    manifestFingerprint: input.manifestFingerprint,
    cases: selected,
    roleModels,
    roleModelsFingerprint,
    difficultyAnchors,
    paidExecutionContractFingerprint: executionContractFingerprint,
    includedInFinalCalibration: false as const,
    phase1Concept: false as const,
    duplicateSimilarityRejectThreshold: input.duplicateSimilarityRejectThreshold,
    profileName: input.profileName,
    experimentVersion: input.experimentVersion,
    caseBindingFingerprints
  }) as DevelopmentDiagnosticPreflight;
  registeredDiagnosticPreflights.set(preflight, {
    manifestFingerprint: preflight.manifestFingerprint,
    cases: preflight.cases,
    paidExecutionContractFingerprint: preflight.paidExecutionContractFingerprint,
    roleModels: preflight.roleModels,
    roleModelsFingerprint: preflight.roleModelsFingerprint,
    difficultyAnchors: preflight.difficultyAnchors,
    duplicateSimilarityRejectThreshold: preflight.duplicateSimilarityRejectThreshold,
    profileName: preflight.profileName,
    experimentVersion: preflight.experimentVersion,
    caseBindingFingerprints: preflight.caseBindingFingerprints,
    revalidationOptions: input.revalidationOptions,
    trustedExecutions: input.trustedExecutions
  });
  return preflight;
}


/**
 * 模块私有验证：除 WeakMap 身份外，再核对所有公开权威字段及案例绑定指纹。
 * 运行时只使用返回的私有快照，不信任调用方可见对象中的替代引用。
 */
function requireDiagnosticPreflightAuthority(
  value: unknown
): DevelopmentDiagnosticPreflightAuthority {
  if (typeof value !== "object" || value === null) {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_PREFLIGHT_FORBIDDEN");
  }
  const authority = registeredDiagnosticPreflights.get(value);
  if (authority === undefined) {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_PREFLIGHT_FORBIDDEN");
  }
  const preflight = value as DevelopmentDiagnosticPreflight;
  if (
    preflight.manifestFingerprint !== authority.manifestFingerprint ||
    preflight.paidExecutionContractFingerprint !==
      authority.paidExecutionContractFingerprint ||
    preflight.cases !== authority.cases ||
    preflight.roleModels !== authority.roleModels ||
    preflight.roleModelsFingerprint !== authority.roleModelsFingerprint ||
    preflight.difficultyAnchors !== authority.difficultyAnchors ||
    preflight.duplicateSimilarityRejectThreshold !==
      authority.duplicateSimilarityRejectThreshold ||
    preflight.profileName !== authority.profileName ||
    preflight.experimentVersion !== authority.experimentVersion ||
    preflight.caseBindingFingerprints !== authority.caseBindingFingerprints ||
    preflight.cases.length !== authority.caseBindingFingerprints.length ||
    preflight.cases.some(
      (entry, index) =>
        diagnosticCaseBindingFingerprint(entry) !== authority.caseBindingFingerprints[index]
    )
  ) {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_PREFLIGHT_FORBIDDEN");
  }
  return authority;
}

/**
 * 模块私有：将生产 4 阶段模型映射为 11 角色配置。
 * A→solver, B→difficulty, C→8 角色, D→adjudicator。
 */
function mapFourCallToRoleModels(
  models: FourCallRuntimeModels
): ReviewFlowModelConfigs {
  const roles = reviewFlowRoleSchema.options as readonly ReviewFlowRole[];
  const stageForRole = (role: ReviewFlowRole): "A" | "B" | "C" | "D" | "formatter" => {

    switch (role) {
      case "solver": return "A";
      case "difficulty": return "B";
      case "adjudicator": return "D";
      case "solution_analyst":
      case "technical_auditor":
      case "editorial_judge":
      case "contest_fit":
      case "originality":
      case "tags":
      case "critic":
      case "adversary":
        return "C";
      default:
        return "formatter";
    }
  };
  return deepFreeze(Object.fromEntries(
    roles.map((role) => {
      const config = models[stageForRole(role)];
      return [role, {
        spec: { ...config.spec },
        credentials: { ...config.credentials },
        runtime: { ...config.runtime }
      }];
    })
  ) as unknown as ReviewFlowModelConfigs);
}
function revalidateDiagnosticPreflight(
  authority: DevelopmentDiagnosticPreflightAuthority
): void {
  assertDiagnosticControlledEnvironment(
    authority.revalidationOptions.env ?? process.env,
    authority.revalidationOptions.manifestPath,
    authority.revalidationOptions.paidExecutionSourceContractFingerprint,
    authority.revalidationOptions.allowedPrivateRoots
  );
  const smoke = preflightDevelopmentSmokeAfterControlledEnvironment(
    authority.revalidationOptions
  );
  const currentExecutions = buildDiagnosticTrustedExecutions(
    smoke,
    authority.revalidationOptions,
    authority.trustedExecutions.map((execution) => execution.slot)
  );
  const currentCases = authority.trustedExecutions.map(({ slot }) => {
    const found = smoke.cases.find((entry) => entry.slot === slot);
    if (found === undefined || found.taskBindingFingerprint === undefined) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_PREFLIGHT_CHANGED");
    }
    return diagnosticCaseBindingFingerprint({
      ...found,
      slot,
      taskBindingFingerprint: found.taskBindingFingerprint
    });
  });
  const currentModelsFingerprint = diagnosticRoleModelsFingerprint(
    mapFourCallToRoleModels(smoke.models),
    authority.revalidationOptions.env ?? process.env
  );
  if (
    smoke.safeSummary.manifestFingerprint !== authority.manifestFingerprint ||
    smoke.duplicateSimilarityRejectThreshold !==
      authority.duplicateSimilarityRejectThreshold ||
    smoke.experimentVersion !== authority.experimentVersion ||
    currentModelsFingerprint !== authority.roleModelsFingerprint ||
    currentExecutions.length !== authority.trustedExecutions.length ||
    currentExecutions.some(
      (execution, index) =>
        execution.slot !== authority.trustedExecutions[index]?.slot ||
        execution.taskSourceFingerprint !==
          authority.trustedExecutions[index]?.taskSourceFingerprint
    ) ||
    currentCases.length !== authority.caseBindingFingerprints.length ||
    currentCases.some(
      (fingerprint, index) => fingerprint !== authority.caseBindingFingerprints[index]
    )
  ) {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_PREFLIGHT_CHANGED");
  }
}

/**
 * 模块私有：将传输门钩子注入每个 11 角色模型配置的 `runtime.onTransportDispatch`。
 * 测试通过 `fetchRuntimeOverride` 注入离线 fetch——不改变 provider/model/thinking/budgets。
 */
function bindDiagnosticRoleModels(
  models: ReviewFlowModelConfigs,
  controller: DevelopmentDiagnosticRunController,
  maximumTransportAttemptsPerRequest: number,
  fetchOverride?: PipelineModelConfig["runtime"]["fetch"]
): ReviewFlowModelConfigs {
  const roles = reviewFlowRoleSchema.options as readonly ReviewFlowRole[];
  const bound = Object.fromEntries(
    roles.map((role) => {
      const config = models[role];
      const modelFingerprint = hashCanonicalValue(config.spec);
      return [role, Object.freeze({
        ...config,
        runtime: Object.freeze({
          ...config.runtime,
          directStructuredOutput: true,
          maxAttempts: maximumTransportAttemptsPerRequest,
          dispatchTransport: <T>(execute: () => Promise<T>) =>
            controller.dispatchTransport(execute),
          onSafeOutputActivity: () => {
            config.runtime.onSafeOutputActivity?.();
            controller.markTransportFirstOutput();
          },
          onTransportDispatch: (attempt: number) =>
            controller.beforeTransport({
              role,
              modelFingerprint,
              attempt
            }),
          ...(fetchOverride !== undefined ? { fetch: fetchOverride } : {})
        })
      })];
    })
  ) as unknown as ReviewFlowModelConfigs;
  return Object.freeze(bound);
}

/**
 * 模块私有：将诊断错误映射为调度器失败类型。
 */
function classifyDevelopmentDiagnosticFailure(
  error: unknown
): LlmStageFailureKind {
  if (
    error instanceof Error &&
    error.message.startsWith("DEVELOPMENT_DIAGNOSTIC_")
  ) {
    return "permanent";
  }
  return "permanent";
}

/**
 * 诊断预检：内部调用生产 `preflightDevelopmentSmoke`，从其返回的 6×4 预检中
 * 选取固定的 slot-01/slot-02，将 4 阶段模型映射为 11 角色配置，
 * 经模块私有 `registerDiagnosticPreflight` 登记为不透明令牌。
 * 调用方只提供与 `preflightDevelopmentSmoke` 相同的选项——不接受任意 cases/models/fingerprint。
 */
export function preflightDevelopmentDiagnostic(
  options: DevelopmentSmokePreflightOptions,
  selectedSlots: readonly DevelopmentDiagnosticSlot[] = expectedDiagnosticSlots
): DevelopmentDiagnosticPreflight {
  const sortedSlots = [...selectedSlots].sort(
    (left, right) =>
      expectedDiagnosticSlots.indexOf(left) - expectedDiagnosticSlots.indexOf(right)
  );
  if (
    selectedSlots.length < 1 ||
    selectedSlots.length > expectedDiagnosticSlots.length ||
    new Set(selectedSlots).size !== selectedSlots.length ||
    selectedSlots.some(
      (slot, index) =>
        !expectedDiagnosticSlots.includes(slot) || sortedSlots[index] !== slot
    )
  ) {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_SELECTED_SLOTS_INVALID");
  }
  const revalidationOptions = captureDiagnosticPreflightOptions(options);
  assertDiagnosticControlledEnvironment(
    revalidationOptions.env ?? process.env,
    revalidationOptions.manifestPath,
    revalidationOptions.paidExecutionSourceContractFingerprint,
    revalidationOptions.allowedPrivateRoots
  );
  const smoke = preflightDevelopmentSmokeAfterControlledEnvironment(
    revalidationOptions
  );
  const trustedExecutions = buildDiagnosticTrustedExecutions(
    smoke,
    revalidationOptions,
    selectedSlots
  );
  if (
    typeof smoke.duplicateSimilarityRejectThreshold !== "number" ||
    typeof smoke.experimentVersion !== "string" ||
    smoke.configuredRoleModelsFingerprint === undefined ||
    smoke.difficultyAnchors === undefined
  ) {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_PREFLIGHT_SLOTS_INVALID");
  }
  const sourceContractFingerprint =
    revalidationOptions.paidExecutionSourceContractFingerprint === undefined
      ? paidExecutionSourceContractFingerprint(
          smoke.repositoryRoot,
          revalidationOptions.paidExecutionSourceContractFilesystemHooks
        )
      : digestSchema.parse(revalidationOptions.paidExecutionSourceContractFingerprint);
  const executionContractFingerprint = paidExecutionContractFingerprint({
    sourceContractFingerprint,
    duplicateSimilarityRejectThreshold: smoke.duplicateSimilarityRejectThreshold,
    difficultyAnchors: smoke.difficultyAnchors
  });
  return registerDiagnosticPreflight({
    selectedSlots,
    manifestFingerprint: smoke.safeSummary.manifestFingerprint,
    cases: smoke.cases,
    fourCallModels: smoke.models,
    configuredRoleModelsFingerprint: smoke.configuredRoleModelsFingerprint,
    paidExecutionContractFingerprint: executionContractFingerprint,
    difficultyAnchors: smoke.difficultyAnchors,
    safeSummary: smoke.safeSummary,
    duplicateSimilarityRejectThreshold: smoke.duplicateSimilarityRejectThreshold,
    profileName: "review-balanced",
    experimentVersion: smoke.experimentVersion,
    revalidationOptions,
    trustedExecutions
  });
}

/**
 * 诊断运行阶段：验证 preflight 令牌来自本模块 WeakMap 权威快照，
 * 构建标定 bundle 并运行 11 角色标定 outcome。
 */
export async function runDevelopmentDiagnosticPhase(input: {
  readonly controller: DevelopmentDiagnosticRunController;
  readonly preflight: DevelopmentDiagnosticPreflight;
  readonly taskCandidates?: readonly {
    readonly slot: DevelopmentDiagnosticSlot;
    readonly taskCandidate: unknown;
    readonly duplicateSimilarityRejectThreshold: number;
  }[];
  readonly fetchRuntimeOverride?: PipelineModelConfig["runtime"]["fetch"];
  readonly engineBuildFingerprint: string;
  readonly profileName: string;
  readonly experimentVersion: string;
}): Promise<readonly PromiseSettledResult<ReviewFlowCalibrationOutcome>[]> {
  const authority = requireDiagnosticPreflightAuthority(input.preflight);
  revalidateDiagnosticPreflight(authority);
  const candidateSnapshot = input.taskCandidates?.map((entry) => ({
    slot: entry.slot,
    duplicateSimilarityRejectThreshold: entry.duplicateSimilarityRejectThreshold,
    taskSource: buildHistoricalCalibrationReviewFlowTaskSource(entry.taskCandidate, {
      duplicateSimilarityRejectThreshold: entry.duplicateSimilarityRejectThreshold
    })
  }));
  if (
    candidateSnapshot !== undefined &&
    (candidateSnapshot.length !== authority.trustedExecutions.length ||
      candidateSnapshot.some(
        (entry, index) => entry.slot !== authority.trustedExecutions[index]?.slot
      ))
  ) {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_BATCH_INVALID");
  }
  if (input.profileName !== authority.profileName) {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_PROFILE_MISMATCH");
  }
  if (input.experimentVersion !== authority.experimentVersion) {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_EXPERIMENT_VERSION_MISMATCH");
  }
  if (candidateSnapshot !== undefined) {
    for (const [index, entry] of candidateSnapshot.entries()) {
      const trusted = authority.trustedExecutions[index];
      if (trusted === undefined) {
        throw new Error("DEVELOPMENT_DIAGNOSTIC_CASE_MISSING");
      }
      if (entry.duplicateSimilarityRejectThreshold !==
          authority.duplicateSimilarityRejectThreshold) {
        throw new Error("DEVELOPMENT_DIAGNOSTIC_THRESHOLD_MISMATCH");
      }
      if (hashCanonicalValue(entry.taskSource) !== trusted.taskSourceFingerprint) {
        throw new Error("DEVELOPMENT_DIAGNOSTIC_TASK_BINDING_MISMATCH");
      }
    }
  }
  const boundRoleModels = bindDiagnosticRoleModels(
    authority.roleModels,
    input.controller,
    input.controller.plannedRun.maximumTransportAttemptsPerRequest,
    input.fetchRuntimeOverride
  );
  const bundle = createReviewFlowLlmBundle({
    models: boundRoleModels,
    difficultyAnchors: authority.difficultyAnchors,
    profileName: input.profileName,
    experimentVersion: input.experimentVersion,
    engineBuildFingerprint: input.engineBuildFingerprint,
    productionGrant: null
  });
  const outcomes = await Promise.allSettled(
    authority.trustedExecutions.map(async (execution) => {
      const { slot, taskSource } = execution;
      const outcome = await runReviewEvidenceFlowCalibrationOutcome({
        taskSource,
        trustedRunner: bundle,
        executionContext: {
          schemaVersion: 1,
          runId: taskSource.taskBinding.assignmentId,
          assignmentId: taskSource.taskBinding.assignmentId,
          expectedRound: taskSource.source.expectedRound
        },
        requestStartGate: input.controller.requestStartGate,
        onTerminalRoleFailure: (role, failureKind, error) => {
          input.controller.recordTerminalRoleFailure(slot, role, failureKind, error);
        }
      });
      input.controller.applySlotOutcome(slot, outcome);
      return outcome;
    })
  );
  await input.controller.flushLifecycleEvents();
  if (outcomes.some((outcome) => outcome.status === "rejected")) {
    input.controller.recordFinalFailure();
  }
  return Object.freeze(outcomes);
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
    const controller = createLedgerController({
      preflight: input.preflight,
      ledger,
      initialPhase: "phase0",
      startedAtMs: new Date(ledger.state.createdAt).getTime(),
      clock: () => now().getTime()
    });
    const reusableBySlot = restoreReusableRequests(controller, ledger.state);
    const checkpoint15 = setTimeout(() => {
      ledger.mutate((state) => ({ ...state, stopReason: state.stopReason }));
    }, developmentSmokeProfile.phase0CheckpointMs);
    checkpoint15.unref();
    const checkpoint60 = setTimeout(() => {
      let forecast: z.infer<typeof phase0ForecastSchema> | null = null;
      try {
        forecast = phase0ForecastSchema.parse(controller.reestimate());
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
        cases: preparedCasesForPhase(input.preflight, "phase0").map((entry) => ({
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
      const rejectedOutcomes = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
      );
      const rejectedOutcome = rejectedOutcomes.find(
        (outcome) => safeFailureCode(outcome.reason) !== "final_failure"
      ) ?? rejectedOutcomes[0];
      const rejected = rejectedOutcome !== undefined;
      const forecast = rejected
        ? null
        : phase0ForecastSchema.parse(
            controller.phase0Forecast(controller.elapsedMs())
          );
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

export interface DevelopmentSmokePhase1PreflightResult {
  readonly status: "GO-PHASE1";
  readonly mode: "release" | "resume";
  readonly runId: string;
  readonly phase0RequestCount: 8;
  readonly phase1RequestCount: number;
  readonly logicalRequestsUsed: number;
  readonly logicalRequestCeiling: 30;
  readonly remainingSlotCount: number;
  readonly phase1Released: boolean;
  readonly networkCalls: 0;
  readonly checkpointAppended: false;
  readonly metrics: z.infer<typeof runMetricsSchema>;
}

export function preflightDevelopmentSmokePhase1(input: {
  readonly preflight: DevelopmentSmokePreflight;
  readonly resumeRunId: string;
  readonly now?: () => Date;
}): DevelopmentSmokePhase1PreflightResult {
  const now = input.now ?? (() => new Date());
  const runId = digestSchema.parse(input.resumeRunId);
  const runDirectory = resolve(input.preflight.privateRuntimeRoot, `run-${runId}`);
  assertUserOnlyPath(runDirectory, true);
  assertRunUnlocked(runDirectory, runId);
  const state = readLatestCheckpoint(runDirectory);
  const validated = validatePhase1Entry(input.preflight, state, now);
  assertRunUnlocked(runDirectory, runId);
  return phase1PreflightResult(state, validated.mode, now());
}

export async function executeDevelopmentSmokePhase1(input: {
  readonly preflight: DevelopmentSmokePreflight;
  readonly resumeRunId: string;
  readonly releaseAuthorized: true;
  readonly now?: () => Date;
  readonly afterReleaseCheckpoint?: () => void;
}): Promise<Readonly<{
  runId: string;
  state: "complete" | "incomplete";
  phase0RequestCount: number;
  phase1RequestCount: number;
  requestCount: number;
  metrics: z.infer<typeof runMetricsSchema>;
}>> {
  if (input.releaseAuthorized !== true) {
    throw new Error("DEVELOPMENT_SMOKE_PHASE1_RELEASE_REQUIRED");
  }
  const now = input.now ?? (() => new Date());
  const runId = digestSchema.parse(input.resumeRunId);
  const runDirectory = resolve(input.preflight.privateRuntimeRoot, `run-${runId}`);
  assertUserOnlyPath(runDirectory, true);
  const releaseLock = acquireRunLock(runDirectory, runId);
  try {
    const initial = readLatestCheckpoint(runDirectory);
    const validated = validatePhase1Entry(input.preflight, initial, now);
    const ledger = new RunLedger(runDirectory, initial, now, false);
    if (validated.mode === "release") {
      const release = buildPhase1Release(input.preflight, initial, now());
      ledger.mutate((state) => {
        const releasedState = {
          ...state,
          phase: "phase1" as const,
          state: "running" as const,
          phase1Released: true,
          phase1Release: release,
          stopReason: null,
          failureCode: null,
          failureLocation: null
        };
        return {
          ...releasedState,
          phase1Forecast: buildPhase1Eta(
            releasedState as PrivateCheckpoint,
            new Date(release.t1)
          )
        };
      });
      input.afterReleaseCheckpoint?.();
    }
    const release = phase1ReleaseSchema.parse(ledger.state.phase1Release);
    const controller = createLedgerController({
      preflight: input.preflight,
      ledger,
      initialPhase: "phase1",
      startedAtMs: new Date(release.t1).getTime(),
      clock: () => now().getTime()
    });
    const reusableBySlot = restoreReusableRequests(controller, ledger.state);
    const checkpoint15 = setTimeout(() => {
      ledger.mutate((state) => ({
        ...state,
        phase1Forecast: buildPhase1Eta(state, now())
      }));
    }, release.checkpointAfterMs);
    checkpoint15.unref();
    const checkpoint60 = setTimeout(() => {
      const at = now();
      const forecast = buildPhase1Eta(ledger.state, at);
      if (
        forecast !== null &&
        at.getTime() - new Date(release.t1).getTime() +
          forecast.projectedRemainingMs > release.closeNewStagesAfterMs
      ) {
        controller.softStop("p90_over_three_hours");
      }
      ledger.mutate((state) => ({ ...state, phase1Forecast: forecast }));
    }, release.reestimateAfterMs);
    checkpoint60.unref();
    try {
      const outcomes = await runDevelopmentSmokePhase({
        phase: "phase1",
        controller,
        models: input.preflight.models,
        nativeSchemaCompatible: true,
        cases: preparedCasesForPhase(input.preflight, "phase1").map((entry) => ({
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
      const rejectedOutcomes = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
      );
      const rejectedOutcome = rejectedOutcomes.find(
        (outcome) => safeFailureCode(outcome.reason) !== "final_failure"
      ) ?? rejectedOutcomes[0];
      const rejected = rejectedOutcome !== undefined;
      ledger.mutate((state) => ({
        ...state,
        state: rejected ? "incomplete" : "complete",
        phase1Forecast: buildPhase1Eta(state, now()),
        stopReason: rejected
          ? controller.checkpoint().stopReason ?? "final_failure"
          : null,
        failureCode: rejectedOutcome === undefined
          ? null
          : safeFailureCode(rejectedOutcome.reason),
        failureLocation: rejectedOutcome === undefined
          ? null
          : safeFailureLocation(rejectedOutcome.reason)
      }));
    } catch (error) {
      const failureCode = safeFailureCode(error);
      ledger.mutate((state) => ({
        ...state,
        state: "incomplete",
        phase1Forecast: buildPhase1Eta(state, now()),
        stopReason: controller.checkpoint().stopReason ?? failureCode,
        failureCode,
        failureLocation: safeFailureLocation(error)
      }));
    } finally {
      clearTimeout(checkpoint15);
      clearTimeout(checkpoint60);
    }
    const metrics = buildRunMetrics(ledger.state, now());
    return Object.freeze({
      runId,
      state: ledger.state.state === "complete" ? "complete" : "incomplete",
      phase0RequestCount: metrics.phase0.requestCount,
      phase1RequestCount: metrics.phase1.requestCount,
      requestCount: metrics.run.requestCount,
      metrics
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
}): {
  models: FourCallRuntimeModels;
  configuredRoleModelsFingerprint: string;
  duplicateSimilarityReject: number;
  experimentVersion: string;
} {
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
  const configuredModels: FourCallRuntimeModels = {
    A: model(roles.solver),
    B: model(roles.difficulty),
    C: model(roles.editorialJudge),
    D: model(roles.adjudicator),
    formatter: model(roles.tags)
  };
  return {
    models: bindDevelopmentSmokeModels(configuredModels),
    configuredRoleModelsFingerprint:
      diagnosticRoleModelsFingerprint(
        mapFourCallToRoleModels(configuredModels),
        input.env
      ),
    duplicateSimilarityReject: modelsConfig.thresholds.duplicateSimilarityReject,
    experimentVersion: modelsConfig.experimentVersion
  };
}

type Phase1EntryMode = "release" | "resume";

function preparedCasesForPhase(
  preflight: DevelopmentSmokePreflight,
  phase: "phase0" | "phase1"
): readonly DevelopmentSmokePreparedCase[] {
  const slots = developmentSmokePhaseSlots(phase);
  const cases = slots.map((slot) =>
    preflight.cases.find((candidate) => candidate.slot === slot)
  );
  const uniqueCaseCount = new Set(
    preflight.cases.map((entry) => entry.slot)
  ).size;
  const allowedCaseCount =
    phase === "phase0"
      ? preflight.cases.length === developmentSmokeProfile.phase0SlotCount ||
        preflight.cases.length === developmentSmokeProfile.anonymousSlotCount
      : preflight.cases.length === developmentSmokeProfile.anonymousSlotCount;
  if (
    !allowedCaseCount ||
    uniqueCaseCount !== preflight.cases.length ||
    cases.some((entry) => entry === undefined)
  ) {
    throw new Error("DEVELOPMENT_SMOKE_PREPARED_CASES_INVALID");
  }
  return Object.freeze(cases as DevelopmentSmokePreparedCase[]);
}

function createLedgerController(input: {
  readonly preflight: DevelopmentSmokePreflight;
  readonly ledger: RunLedger;
  readonly initialPhase: "phase0" | "phase1";
  readonly startedAtMs: number;
  readonly clock: () => number;
}): DevelopmentSmokeRunController {
  return new DevelopmentSmokeRunController({
    profile: developmentSmokeProfile,
    manifest: input.preflight.manifest,
    runBindingHash: input.ledger.state.runBindingHash,
    scheduler: createDevelopmentSmokeScheduler(),
    initialPhase: input.initialPhase,
    startedAtMs: input.startedAtMs,
    clock: input.clock,
    safeReceiptSink: (receipt) => {
      const parsedReceipt = safeReceiptSchema.safeParse(receipt);
      if (!parsedReceipt.success) {
        throw new DevelopmentSmokeSafeError("request_receipt_schema_invalid", {
          cause: parsedReceipt.error
        });
      }
      input.ledger.mutate((state) => ({
        ...state,
        requests: [...state.requests, { receipt: parsedReceipt.data }]
      }));
    },
    safeCompletionSink: (slot, stage, timing) => {
      input.ledger.mutate((state) => ({
        ...state,
        requests: state.requests.map((request) =>
          request.receipt.anonymousSlot === slot &&
          request.receipt.stage === stage
            ? { ...request, timing }
            : request
        )
      }));
    },
    safeFailureSink: (slot, stage, failure) => {
      const failureDetail = safeRequestFailureSchema.parse(failure);
      input.ledger.mutate((state) => ({
        ...state,
        requests: state.requests.map((request) =>
          request.receipt.anonymousSlot === slot &&
          request.receipt.stage === stage
            ? { ...request, failureKind: failureDetail.kind, failureDetail }
            : request
        )
      }));
    }
  });
}

function validatePhase1Entry(
  preflight: DevelopmentSmokePreflight,
  state: PrivateCheckpoint,
  now: () => Date
): { readonly mode: Phase1EntryMode } {
  assertCheckpointBinding(preflight, state);
  preparedCasesForPhase(preflight, "phase1");
  assertExactPhase0Success(state);
  const at = now();
  if (!Number.isFinite(at.getTime())) {
    throw new Error("DEVELOPMENT_SMOKE_PHASE1_TIME_INVALID");
  }
  if (!state.phase1Released) {
    if (
      state.phase !== "phase0" ||
      state.state !== "phase0_complete" ||
      state.requests.length !== 8 ||
      state.phase1Release !== undefined ||
      state.failureCode !== null ||
      state.stopReason !== null
    ) {
      throw new Error("DEVELOPMENT_SMOKE_PHASE1_PRECONDITION_INVALID");
    }
    const controller = new DevelopmentSmokeRunController({
      profile: developmentSmokeProfile,
      manifest: preflight.manifest,
      runBindingHash: state.runBindingHash,
      scheduler: createDevelopmentSmokeScheduler(),
      initialPhase: "phase0",
      startedAtMs: new Date(state.createdAt).getTime(),
      clock: () => at.getTime()
    });
    restoreReusableRequests(controller, state);
    const persistedForecast = phase0ForecastSchema.parse(state.phase0Forecast);
    const recomputedForecast = controller.releasePhase1();
    if (
      persistedForecast.measurementFingerprint !==
        recomputedForecast.measurementFingerprint ||
      persistedForecast.estimatorFingerprint !==
        recomputedForecast.estimatorFingerprint ||
      persistedForecast.observedLogicalRequestP90Ms !==
        recomputedForecast.observedLogicalRequestP90Ms ||
      persistedForecast.observedFirstValidOutputP90Ms !==
        recomputedForecast.observedFirstValidOutputP90Ms ||
      persistedForecast.observedValidOutputEventsPerMinuteFloor !==
        recomputedForecast.observedValidOutputEventsPerMinuteFloor ||
      persistedForecast.remainingCriticalWaveCount !==
        recomputedForecast.remainingCriticalWaveCount ||
      persistedForecast.projectedAllSixP90Ms >
        developmentSmokeProfile.closeNewStagesAfterMs
    ) {
      throw new Error("DEVELOPMENT_SMOKE_PHASE0_FORECAST_INVALID");
    }
    return Object.freeze({ mode: "release" as const });
  }
  if (
    state.phase !== "phase1" ||
    state.state !== "running" ||
    state.failureCode !== null ||
    state.stopReason !== null ||
    state.requests.some((request) =>
      request.completedStage === undefined ||
      request.timing === undefined ||
      request.failureKind !== undefined ||
      request.failureDetail !== undefined
    )
  ) {
    throw new Error("DEVELOPMENT_SMOKE_PHASE1_RESUME_INVALID");
  }
  const release = phase1ReleaseSchema.parse(state.phase1Release);
  assertPhase1Release(preflight, state, release);
  const t1 = new Date(release.t1).getTime();
  const elapsed = at.getTime() - t1;
  if (
    !Number.isSafeInteger(elapsed) ||
    elapsed < 0 ||
    elapsed >= release.closeNewStagesAfterMs
  ) {
    throw new Error("DEVELOPMENT_SMOKE_PHASE1_TIME_INVALID");
  }
  assertCompletedRequestSequence(state);
  return Object.freeze({ mode: "resume" as const });
}

function assertCheckpointBinding(
  preflight: DevelopmentSmokePreflight,
  state: PrivateCheckpoint
): void {
  const expectedRunBindingHash = hashCanonicalValue({
    schemaVersion: 1,
    runId: state.runId,
    codeVersion: preflight.codeVersion,
    profileFingerprint: developmentSmokeProfileFingerprint,
    manifestFingerprint: preflight.safeSummary.manifestFingerprint,
    privateManifestFileSha256: preflight.manifestFileSha256
  });
  if (
    state.codeVersion !== preflight.codeVersion ||
    state.profileFingerprint !== developmentSmokeProfileFingerprint ||
    state.manifestFingerprint !== preflight.safeSummary.manifestFingerprint ||
    state.privateManifestFileSha256 !== preflight.manifestFileSha256 ||
    state.runBindingHash !== expectedRunBindingHash
  ) {
    throw new Error("DEVELOPMENT_SMOKE_PHASE1_BINDING_INVALID");
  }
}

function assertExactPhase0Success(state: PrivateCheckpoint): void {
  const phase0Requests = state.requests.filter(
    (request) => request.receipt.phase === "phase0"
  );
  const expectedKeys = new Set(
    developmentSmokePhaseSlots("phase0").flatMap((slot) =>
      (["A", "B", "C", "D"] as const).map((stage) => `${slot}:${stage}`)
    )
  );
  const actualKeys = phase0Requests.map(
    (request) => `${request.receipt.anonymousSlot}:${request.receipt.stage}`
  );
  if (
    phase0Requests.length !== 8 ||
    new Set(actualKeys).size !== expectedKeys.size ||
    actualKeys.some((key) => !expectedKeys.has(key)) ||
    phase0Requests.some((request) =>
      request.completedStage === undefined ||
      request.timing === undefined ||
      request.failureKind !== undefined ||
      request.failureDetail !== undefined
    )
  ) {
    throw new Error("DEVELOPMENT_SMOKE_PHASE0_SUCCESS_INVALID");
  }
  assertCompletedRequestSequence({ ...state, requests: phase0Requests });
}

function assertCompletedRequestSequence(
  state: Pick<PrivateCheckpoint, "requests">
): void {
  const ordered = [...state.requests].sort((left, right) =>
    left.receipt.logicalRequestsUsed - right.receipt.logicalRequestsUsed
  );
  if (
    ordered.length > developmentSmokeProfile.maximumTotalLogicalRequests ||
    ordered.some((request, index) =>
      request.receipt.logicalRequestsUsed !== index + 1 ||
      request.receipt.externalAttemptsUsed !== index + 1 ||
      request.receipt.logicalRequestCeiling !== 30 ||
      request.receipt.externalAttemptCeiling !== 30 ||
      request.completedStage === undefined ||
      request.timing === undefined ||
      request.failureKind !== undefined ||
      request.failureDetail !== undefined
    )
  ) {
    throw new Error("DEVELOPMENT_SMOKE_ATTEMPT_LEDGER_INVALID");
  }
  const keys = ordered.map((request) =>
    `${request.receipt.anonymousSlot}:${request.receipt.stage}`
  );
  if (new Set(keys).size !== keys.length) {
    throw new Error("DEVELOPMENT_SMOKE_ATTEMPT_LEDGER_INVALID");
  }
  for (const slot of developmentSmokePhaseSlots("phase1")) {
    if (keys.filter((key) => key.startsWith(`${slot}:`)).length > 5) {
      throw new Error("DEVELOPMENT_SMOKE_ATTEMPT_LEDGER_INVALID");
    }
  }
}

function buildPhase1Release(
  preflight: DevelopmentSmokePreflight,
  state: PrivateCheckpoint,
  at: Date
): z.infer<typeof phase1ReleaseSchema> {
  const remainingSlots = preparedCasesForPhase(preflight, "phase1").map((entry) => {
    const binding = preflight.manifest.slots.find((slot) => slot.slot === entry.slot);
    if (
      binding === undefined ||
      binding.slotBindingHash !== entry.sourceBinding ||
      binding.truthBindingHash !== entry.truthBindingHash
    ) {
      throw new Error("DEVELOPMENT_SMOKE_PHASE1_SLOT_BINDING_INVALID");
    }
    return {
      slot: entry.slot,
      slotBindingHash: binding.slotBindingHash,
      truthBindingHash: binding.truthBindingHash
    };
  });
  const base = {
    schemaVersion: 1 as const,
    t1: at.toISOString(),
    releaseRevision: state.revision + 1,
    remainingSlots,
    phase0LogicalRequestsUsed: 8 as const,
    phase0ExternalAttemptsUsed: 8 as const,
    logicalRequestCeiling: 30 as const,
    externalAttemptCeiling: 30 as const,
    checkpointAfterMs: developmentSmokeProfile.phase0CheckpointMs,
    reestimateAfterMs: developmentSmokeProfile.reestimateCheckpointMs,
    closeNewStagesAfterMs: developmentSmokeProfile.closeNewStagesAfterMs
  };
  return phase1ReleaseSchema.parse({
    ...base,
    releaseBindingHash: hashCanonicalValue(base)
  });
}

function assertPhase1Release(
  preflight: DevelopmentSmokePreflight,
  state: PrivateCheckpoint,
  release: z.infer<typeof phase1ReleaseSchema>
): void {
  const { releaseBindingHash, ...base } = release;
  const expected = buildPhase1Release(
    preflight,
    { ...state, revision: release.releaseRevision - 1 },
    new Date(release.t1)
  );
  if (
    release.releaseRevision > state.revision ||
    releaseBindingHash !== hashCanonicalValue(base) ||
    hashCanonicalValue(release) !== hashCanonicalValue(expected)
  ) {
    throw new Error("DEVELOPMENT_SMOKE_PHASE1_RELEASE_INVALID");
  }
}

function phase1PreflightResult(
  state: PrivateCheckpoint,
  mode: Phase1EntryMode,
  at: Date
): DevelopmentSmokePhase1PreflightResult {
  const metrics = buildRunMetrics(state, at);
  const remainingSlotCount = developmentSmokePhaseSlots("phase1").filter((slot) =>
    !["A", "B", "C", "D"].every((stage) =>
      state.requests.some((request) =>
        request.receipt.anonymousSlot === slot &&
        request.receipt.stage === stage &&
        request.completedStage !== undefined
      )
    )
  ).length;
  return Object.freeze({
    status: "GO-PHASE1" as const,
    mode,
    runId: state.runId,
    phase0RequestCount: 8 as const,
    phase1RequestCount: metrics.phase1.requestCount,
    logicalRequestsUsed: metrics.run.requestCount,
    logicalRequestCeiling: 30 as const,
    remainingSlotCount,
    phase1Released: state.phase1Released,
    networkCalls: 0 as const,
    checkpointAppended: false as const,
    metrics
  });
}

function buildRunMetrics(
  state: Pick<PrivateCheckpoint, "requests" | "phase1Released" | "phase1Release">,
  at: Date
): z.infer<typeof runMetricsSchema> {
  const phase0Requests = state.requests.filter(
    (request) => request.receipt.phase === "phase0"
  );
  const phase1Requests = state.requests.filter(
    (request) => request.receipt.phase === "phase1"
  );
  const result = {
    phase0: buildPhaseMetrics(phase0Requests),
    phase1: buildPhaseMetrics(phase1Requests),
    run: buildPhaseMetrics(state.requests),
    remainingLogicalRequestBudget:
      developmentSmokeProfile.maximumTotalLogicalRequests - state.requests.length,
    phase1Eta: state.phase1Released
      ? buildPhase1Eta(state as PrivateCheckpoint, at)
      : null
  };
  return runMetricsSchema.parse(result);
}

function buildPhaseMetrics(
  requests: PrivateCheckpoint["requests"]
): z.infer<typeof phaseMetricsSchema> {
  const completed = requests.filter((request) => request.completedStage !== undefined);
  const failures = requests.filter((request) => request.failureKind !== undefined);
  const timings = completed.flatMap((request) =>
    request.timing === undefined ? [] : [request.timing]
  );
  return phaseMetricsSchema.parse({
    requestCount: requests.length,
    completedRequestCount: completed.length,
    failedRequestCount: failures.length,
    inflightRequestCount: requests.length - completed.length - failures.length,
    measuredTimingCount: timings.length,
    firstValidOutputP90Ms: timings.length === 0
      ? null
      : nearestRankSafe(timings.map((timing) => timing.firstValidOutputMs)),
    endToEndP90Ms: timings.length === 0
      ? null
      : nearestRankSafe(timings.map((timing) => timing.endToEndMs))
  });
}

function buildPhase1Eta(
  state: PrivateCheckpoint,
  at: Date
): z.infer<typeof phase1EtaSchema> | null {
  const phase1Timings = state.requests.flatMap((request) =>
    request.receipt.phase === "phase1" &&
    request.completedStage !== undefined &&
    request.timing !== undefined
      ? [request.timing]
      : []
  );
  const phase0Timings = state.requests.flatMap((request) =>
    request.receipt.phase === "phase0" &&
    request.completedStage !== undefined &&
    request.timing !== undefined
      ? [request.timing]
      : []
  );
  const timings = phase1Timings.length === 0 ? phase0Timings : phase1Timings;
  if (timings.length === 0) return null;
  const observedLogicalRequestP90Ms = nearestRankSafe(
    timings.map((timing) => timing.endToEndMs)
  );
  const stageComplete = (stage: "A" | "B" | "C" | "D"): boolean =>
    developmentSmokePhaseSlots("phase1").every((slot) =>
      state.requests.some((request) =>
        request.receipt.anonymousSlot === slot &&
        request.receipt.stage === stage &&
        request.completedStage !== undefined
      )
    );
  const remainingCriticalWaveCount =
    !stageComplete("A") || !stageComplete("B")
      ? 4
      : !stageComplete("C")
        ? 3
        : !stageComplete("D")
          ? 2
          : 0;
  const projectedRemainingMs =
    observedLogicalRequestP90Ms * remainingCriticalWaveCount;
  return phase1EtaSchema.parse({
    basis: phase1Timings.length === 0 ? "phase0_fallback" : "phase1_measured",
    measuredLogicalRequestCount: timings.length,
    observedLogicalRequestP90Ms,
    remainingCriticalWaveCount,
    projectedRemainingMs,
    projectedCompletionAt: new Date(at.getTime() + projectedRemainingMs).toISOString()
  });
}

function nearestRankSafe(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.9) - 1]!;
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
  const base = privateCheckpointSchema.parse({
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
  });
  const state = privateCheckpointSchemaForWrite.parse({
    ...base,
    metrics: buildRunMetrics(base, new Date(timestamp))
  });
  return new RunLedger(runDirectory, state, now, true);
}

function resumeRunLedger(
  preflight: DevelopmentSmokePreflight,
  runId: string,
  runDirectory: string,
  now: () => Date
): RunLedger {
  const state = readLatestCheckpoint(runDirectory);
  assertCheckpointBinding(preflight, state);
  if (
    state.runId !== runId ||
    state.phase !== "phase0" ||
    state.phase1Released ||
    state.state === "phase0_complete" ||
    state.requests.some((request) =>
      request.completedStage === undefined ||
      request.timing === undefined
    )
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
    const updated = update(this.state);
    const at = this.#now();
    const candidate = {
      ...updated,
      revision: this.state.revision + 1,
      previousCheckpointSha256: sha256(previousBytes),
      updatedAt: at.toISOString()
    };
    const parsedNext = privateCheckpointSchemaForWrite.safeParse({
      ...candidate,
      metrics: buildRunMetrics(candidate, at)
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
  for (const [slot, completed] of result) {
    if ((["A", "B", "C", "D"] as const).every((stage) => completed[stage] !== undefined)) {
      controller.markSlotComplete(slot);
    }
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
      parsed = privateCheckpointReadSchema.parse(JSON.parse(bytes.toString("utf8"))) as PrivateCheckpoint;
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

function assertRunUnlocked(runDirectory: string, runId: string): void {
  const lockPath = resolve(runDirectory, "active.lock.private.json");
  if (!existsSync(lockPath)) return;
  const lock = asRecord(parseJson(readPrivateFile(lockPath, [runDirectory]).bytes));
  if (
    lock.schemaVersion !== 1 ||
    lock.runId !== runId ||
    typeof lock.pid !== "number" ||
    !Number.isSafeInteger(lock.pid) ||
    lock.pid < 1
  ) {
    throw new Error("DEVELOPMENT_SMOKE_RUN_LOCK_INVALID");
  }
  throw new Error("DEVELOPMENT_SMOKE_RUN_LOCKED");
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

function assertDiagnosticControlledEnvironment(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  manifestPath: string,
  startupContractFingerprint: string | undefined,
  allowedPrivateRoots: readonly string[] | undefined
): void {
  if (env.FERMATA_RUN_WITH_ENV !== "1") {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_WRAPPER_REQUIRED");
  }
  const manifestAttestation = env.FERMATA_DEVELOPMENT_DIAGNOSTIC_MANIFEST;
  const startupAttestation =
    env.FERMATA_DEVELOPMENT_DIAGNOSTIC_STARTUP_CONTRACT;
  const privateRootsSource =
    env.FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS;
  const privateRootsAttestation =
    env.FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS_ATTESTATION;
  if (
    manifestAttestation === undefined ||
    !isAbsolute(manifestAttestation) ||
    resolve(manifestAttestation) !== resolve(manifestPath) ||
    startupAttestation === undefined ||
    !digestSchema.safeParse(startupAttestation).success ||
    (startupContractFingerprint !== undefined &&
      startupContractFingerprint !== startupAttestation) ||
    privateRootsSource === undefined ||
    privateRootsAttestation === undefined ||
    !digestSchema.safeParse(privateRootsAttestation).success
  ) {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_BOOTSTRAP_ATTESTATION_INVALID");
  }
  let attestedPrivateRoots: unknown;
  try {
    attestedPrivateRoots = JSON.parse(privateRootsSource);
  } catch {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_BOOTSTRAP_ATTESTATION_INVALID");
  }
  if (
    !Array.isArray(attestedPrivateRoots) ||
    attestedPrivateRoots.some((root) => typeof root !== "string" || !isAbsolute(root)) ||
    allowedPrivateRoots === undefined ||
    JSON.stringify(attestedPrivateRoots) !== JSON.stringify(allowedPrivateRoots) ||
    (
      startupContractFingerprint !== undefined &&
      hashCanonicalValue({
        privateRoots: attestedPrivateRoots,
        schemaVersion: 1,
        startupContractFingerprint
      }) !== privateRootsAttestation
    )
  ) {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_BOOTSTRAP_ATTESTATION_INVALID");
  }
  const allowedFermataKeys = new Set([
    "FERMATA_RUN_WITH_ENV",
    "FERMATA_DEVELOPMENT_DIAGNOSTIC_MANIFEST",
    "FERMATA_DEVELOPMENT_DIAGNOSTIC_STARTUP_CONTRACT",
    "FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS",
    "FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS_ATTESTATION"
  ]);
  for (const key of Object.keys(env)) {
    if (/^(?:CODEFORCES|DASHSCOPE|EVAL|URMOTIV)_/u.test(key)) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_ENVIRONMENT_NOT_NARROW");
    }
    if (/^FERMATA_/u.test(key) && !allowedFermataKeys.has(key)) {
      throw new Error("DEVELOPMENT_DIAGNOSTIC_ENVIRONMENT_NOT_NARROW");
    }
  }
  if (env.AETHER_BASE_URL === undefined || env.AETHER_API_KEY === undefined) {
    throw new Error("DEVELOPMENT_DIAGNOSTIC_AETHER_CONFIGURATION_INVALID");
  }
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
