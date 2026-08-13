import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import {
  developmentDiagnosticProfile,
  developmentDiagnosticProfileFingerprint,
  developmentDiagnosticProfileSchema
} from "../../src/review-flow/development-diagnostic";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const timestampSchema = z.string().datetime();
const processStartTimeTicksSchema = z.string().regex(/^[1-9][0-9]*$/u);
const slotSchema = z.enum(["slot-01", "slot-02"]);
const roleSchema = z.enum([
  "solver",
  "solution_analyst",
  "technical_auditor",
  "difficulty",
  "editorial_judge",
  "contest_fit",
  "originality",
  "tags",
  "critic",
  "adversary",
  "adjudicator"
]);
const terminalFailureSchema = z.enum([
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

const developmentDiagnosticPaidRunProfileSchema = developmentDiagnosticProfileSchema
  .extend({
    retryableHttpStatuses: z.tuple([z.literal(429)])
  })
  .strict();

export const developmentDiagnosticRunIdentitySchema = z
  .object({
    runId: z.string().uuid(),
    codeFingerprint: digestSchema,
    manifestFingerprint: digestSchema,
    authorityFingerprint: digestSchema,
    configurationFingerprint: digestSchema,
    profileFingerprint: z.literal(developmentDiagnosticProfileFingerprint),
    profile: developmentDiagnosticPaidRunProfileSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (
      fingerprint(value.profile) !==
      fingerprint({
        ...developmentDiagnosticProfile,
        retryableHttpStatuses: [429]
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["profile"],
        message: "development diagnostic paid-run profile mismatch"
      });
    }
  });
export type DevelopmentDiagnosticRunIdentity = z.infer<
  typeof developmentDiagnosticRunIdentitySchema
>;

const slotProgressSchema = z
  .object({
    slot: slotSchema,
    status: z.enum(["not_started", "running", "complete", "incomplete"]),
    completedRoleFingerprints: z.array(digestSchema).max(11).readonly(),
    failedRoleFingerprints: z.array(digestSchema).max(11).readonly(),
    completedStageFingerprints: z.array(digestSchema).max(4).readonly(),
    failedStageFingerprints: z.array(digestSchema).max(4).readonly()
  })
  .strict()
  .superRefine((value, context) => {
    for (const field of [
      "completedRoleFingerprints",
      "failedRoleFingerprints",
      "completedStageFingerprints",
      "failedStageFingerprints"
    ] as const) {
      if (new Set(value[field]).size !== value[field].length) {
        context.addIssue({ code: "custom", path: [field], message: "duplicate fingerprint" });
      }
    }
    if (
      value.completedRoleFingerprints.some((entry) =>
        value.failedRoleFingerprints.includes(entry)
      ) ||
      value.completedStageFingerprints.some((entry) =>
        value.failedStageFingerprints.includes(entry)
      )
    ) {
      context.addIssue({ code: "custom", path: ["status"], message: "completion/failure overlap" });
    }
    if (
      value.status === "not_started" &&
      [
        value.completedRoleFingerprints,
        value.failedRoleFingerprints,
        value.completedStageFingerprints,
        value.failedStageFingerprints
      ].some((entries) => entries.length !== 0)
    ) {
      context.addIssue({ code: "custom", path: ["status"], message: "not-started slot has progress" });
    }
    if (
      value.status === "complete" &&
      (value.completedRoleFingerprints.length !== 11 ||
        value.failedRoleFingerprints.length !== 0 ||
        value.completedStageFingerprints.length !== 4 ||
        value.failedStageFingerprints.length !== 0)
    ) {
      context.addIssue({ code: "custom", path: ["status"], message: "complete slot mismatch" });
    }
  });

const transportAttemptSchema = z
  .object({
    sequence: z.number().int().min(1).max(52),
    roleFingerprint: digestSchema,
    modelFingerprint: digestSchema,
    attempt: z.number().int().min(1).max(3),
    outcome: z.enum(["queued", "reserved", "running", "succeeded", "failed"]),
    queuedAt: timestampSchema,
    startAt: timestampSchema.nullable(),
    firstOutputAt: timestampSchema.nullable(),
    endAt: timestampSchema.nullable(),
    endToEndMs: z.number().int().min(0).nullable(),
    errorCategory: terminalFailureSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    const started = value.startAt !== null;
    const terminal = value.outcome === "succeeded" || value.outcome === "failed";
    if (
      (value.outcome === "queued" && started) ||
      (value.outcome === "reserved" && started) ||
      (value.outcome === "running" && (!started || value.endAt !== null)) ||
      (terminal && value.endAt === null) ||
      (!terminal && (value.endAt !== null || value.endToEndMs !== null)) ||
      (value.firstOutputAt !== null && !started) ||
      (value.outcome === "succeeded" && value.errorCategory !== null)
    ) {
      context.addIssue({ code: "custom", path: ["outcome"], message: "attempt timing mismatch" });
    }
  });

const transportProgressSchema = z
  .object({
    intended: z.number().int().min(0).max(52),
    reserved: z.number().int().min(0).max(52),
    started: z.number().int().min(0).max(52),
    settled: z.number().int().min(0).max(52),
    active: z.number().int().min(0).max(4),
    queued: z.number().int().min(0).max(52),
    terminalFailure: terminalFailureSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.reserved > value.intended ||
      value.started > value.reserved ||
      value.settled > value.started ||
      value.active !== value.started - value.settled ||
      value.queued > value.intended - value.started
    ) {
      context.addIssue({ code: "custom", path: ["started"], message: "transport count mismatch" });
    }
  });

const runTerminalReasonSchema = z.enum([
  "terminal_role_failure",
  "deadline",
  "signal",
  "persistence_error",
  "runner_failure",
  "attempt_count_mismatch"
]);

const runStatePayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("development-diagnostic-run-state"),
    phase: z.enum(["planned", "authorized", "running", "complete", "incomplete"]),
    identity: developmentDiagnosticRunIdentitySchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    sequence: z.number().int().min(0),
    terminationIntent: z.enum(["SIGINT", "SIGTERM"]).nullable(),
    terminalReason: runTerminalReasonSchema.nullable(),
    transport: transportProgressSchema,
    attempts: z.array(transportAttemptSchema).max(52).readonly(),
    slots: z.tuple([slotProgressSchema, slotProgressSchema])
  })
  .strict()
  .superRefine((value, context) => {
    if (value.slots[0].slot !== "slot-01" || value.slots[1].slot !== "slot-02") {
      context.addIssue({ code: "custom", path: ["slots"], message: "fixed slot order required" });
    }
    if (
      value.attempts.length !== value.transport.intended ||
      value.attempts.some((attempt, index) => attempt.sequence !== index + 1) ||
      value.attempts.filter((attempt) => attempt.outcome === "queued").length !==
        value.transport.queued ||
      value.attempts.filter((attempt) => attempt.startAt !== null).length !==
        value.transport.started ||
      value.attempts.filter((attempt) => attempt.startAt !== null && attempt.endAt !== null)
        .length !== value.transport.settled
    ) {
      context.addIssue({ code: "custom", path: ["attempts"], message: "attempt ledger mismatch" });
    }
    if (["planned", "authorized"].includes(value.phase)) {
      if (
        value.sequence !== 0 ||
        value.transport.intended !== 0 ||
        value.transport.reserved !== 0 ||
        value.transport.started !== 0 ||
        value.transport.settled !== 0 ||
        value.transport.active !== 0 ||
        value.transport.queued !== 0 ||
        value.transport.terminalFailure !== null ||
        value.attempts.length !== 0 ||
        value.terminationIntent !== null ||
        value.terminalReason !== null ||
        value.slots.some((slot) => slot.status !== "not_started")
      ) {
        context.addIssue({ code: "custom", path: ["phase"], message: "pre-run state has progress" });
      }
    }
    if (value.phase === "complete") {
      if (
        value.transport.started !== 24 ||
        value.transport.settled !== 24 ||
        value.transport.active !== 0 ||
        value.transport.queued !== 0 ||
        value.transport.terminalFailure !== null ||
        value.terminalReason !== null ||
        value.terminationIntent !== null ||
        value.attempts.length !== 24 ||
        value.attempts.some((attempt) => attempt.outcome !== "succeeded") ||
        value.slots.some((slot) => slot.status !== "complete")
      ) {
        context.addIssue({ code: "custom", path: ["phase"], message: "complete state mismatch" });
      }
    }
    if (
      value.phase === "incomplete" &&
      (value.transport.active !== 0 ||
        value.transport.queued !== 0 ||
        value.terminalReason === null ||
        value.attempts.some((attempt) =>
          attempt.outcome === "queued" ||
          attempt.outcome === "reserved" ||
          attempt.outcome === "running"
        ))
    ) {
      context.addIssue({ code: "custom", path: ["phase"], message: "incomplete state mismatch" });
    }
  });

export const developmentDiagnosticRunStateSchema = runStatePayloadSchema
  .extend({ integritySha256: digestSchema })
  .strict();
export type DevelopmentDiagnosticRunState = z.infer<
  typeof developmentDiagnosticRunStateSchema
>;
export type DevelopmentDiagnosticRunPhase = DevelopmentDiagnosticRunState["phase"];
export type DevelopmentDiagnosticRunProgress = Pick<
  DevelopmentDiagnosticRunState,
  | "sequence"
  | "terminationIntent"
  | "terminalReason"
  | "transport"
  | "attempts"
  | "slots"
>;

export class DevelopmentDiagnosticRunStateError extends Error {
  public constructor(
    public readonly code: string,
    public readonly published = false,
    public readonly durabilityUnknown = false
  ) {
    super(code);
    this.name = "DevelopmentDiagnosticRunStateError";
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)])
  );
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function sealState(input: z.input<typeof runStatePayloadSchema>): DevelopmentDiagnosticRunState {
  const payload = runStatePayloadSchema.parse(input);
  return Object.freeze(
    developmentDiagnosticRunStateSchema.parse({
      ...payload,
      integritySha256: fingerprint(payload)
    })
  );
}

export function parseDevelopmentDiagnosticRunState(
  input: unknown,
  expectedIdentity?: DevelopmentDiagnosticRunIdentity
): DevelopmentDiagnosticRunState {
  let parsed: DevelopmentDiagnosticRunState;
  try {
    parsed = developmentDiagnosticRunStateSchema.parse(input);
  } catch {
    throw new DevelopmentDiagnosticRunStateError("RUN_STATE_INVALID");
  }
  const { integritySha256, ...payload } = parsed;
  if (fingerprint(payload) !== integritySha256) {
    throw new DevelopmentDiagnosticRunStateError("RUN_STATE_TAMPERED");
  }
  if (expectedIdentity !== undefined) {
    let expected: DevelopmentDiagnosticRunIdentity;
    try {
      expected = developmentDiagnosticRunIdentitySchema.parse(expectedIdentity);
    } catch {
      throw new DevelopmentDiagnosticRunStateError("RUN_STATE_IDENTITY_MISMATCH");
    }
    if (fingerprint(parsed.identity) !== fingerprint(expected)) {
      throw new DevelopmentDiagnosticRunStateError("RUN_STATE_IDENTITY_MISMATCH");
    }
  }
  return parsed;
}

export function createDevelopmentDiagnosticRunState(
  identity: DevelopmentDiagnosticRunIdentity,
  now: Date = new Date()
): DevelopmentDiagnosticRunState {
  const parsedIdentity = developmentDiagnosticRunIdentitySchema.parse(identity);
  const timestamp = now.toISOString();
  return sealState({
    schemaVersion: 1,
    kind: "development-diagnostic-run-state",
    phase: "planned",
    identity: parsedIdentity,
    createdAt: timestamp,
    updatedAt: timestamp,
    sequence: 0,
    terminationIntent: null,
    terminalReason: null,
    transport: {
      intended: 0,
      reserved: 0,
      started: 0,
      settled: 0,
      active: 0,
      queued: 0,
      terminalFailure: null
    },
    attempts: [],
    slots: [
      {
        slot: "slot-01",
        status: "not_started",
        completedRoleFingerprints: [],
        failedRoleFingerprints: [],
        completedStageFingerprints: [],
        failedStageFingerprints: []
      },
      {
        slot: "slot-02",
        status: "not_started",
        completedRoleFingerprints: [],
        failedRoleFingerprints: [],
        completedStageFingerprints: [],
        failedStageFingerprints: []
      }
    ]
  });
}

const allowedTransitions: Readonly<Record<DevelopmentDiagnosticRunPhase, readonly DevelopmentDiagnosticRunPhase[]>> = {
  planned: ["authorized"],
  authorized: ["running"],
  running: ["complete", "incomplete"],
  complete: [],
  incomplete: []
};

export function transitionDevelopmentDiagnosticRunState(
  stateInput: DevelopmentDiagnosticRunState,
  nextPhase: DevelopmentDiagnosticRunPhase,
  now: Date = new Date()
): DevelopmentDiagnosticRunState {
  const state = parseDevelopmentDiagnosticRunState(stateInput);
  if (!allowedTransitions[state.phase].includes(nextPhase)) {
    throw new DevelopmentDiagnosticRunStateError("RUN_STATE_TRANSITION_INVALID");
  }
  return sealState({
    ...withoutIntegrity(state),
    phase: nextPhase,
    updatedAt: now.toISOString()
  });
}

export function updateDevelopmentDiagnosticRunProgress(
  stateInput: DevelopmentDiagnosticRunState,
  progress: DevelopmentDiagnosticRunProgress,
  now: Date = new Date()
): DevelopmentDiagnosticRunState {
  const state = parseDevelopmentDiagnosticRunState(stateInput);
  if (state.phase !== "running") {
    throw new DevelopmentDiagnosticRunStateError("RUN_STATE_PROGRESS_NOT_RUNNING");
  }
  return sealState({
    ...withoutIntegrity(state),
    updatedAt: now.toISOString(),
    ...progress
  });
}

export type DevelopmentDiagnosticRunEvent =
  | {
      readonly type: "transport_intent";
      readonly roleFingerprint: string;
      readonly modelFingerprint: string;
      readonly attempt: number;
      readonly at: Date;
    }
  | {
      readonly type: "transport_reserved" | "transport_started" | "transport_first_output";
      readonly attemptSequence: number;
      readonly at: Date;
    }
  | {
      readonly type: "transport_settled";
      readonly attemptSequence: number;
      readonly outcome: "succeeded" | "failed";
      readonly errorCategory: z.infer<typeof terminalFailureSchema> | null;
      readonly at: Date;
    }
  | {
      readonly type: "role_completed" | "role_failed";
      readonly slot: z.infer<typeof slotSchema>;
      readonly roleFingerprint: string;
      readonly errorCategory?: z.infer<typeof terminalFailureSchema>;
      readonly at: Date;
    }
  | {
      readonly type: "stage_completed" | "stage_failed";
      readonly slot: z.infer<typeof slotSchema>;
      readonly stageFingerprint: string;
      readonly at: Date;
    }
  | {
      readonly type: "slot_outcome";
      readonly slot: z.infer<typeof slotSchema>;
      readonly status: "complete" | "incomplete";
      readonly at: Date;
    }
  | {
      readonly type: "termination_intent";
      readonly signal: "SIGINT" | "SIGTERM";
      readonly at: Date;
    }
  | {
      readonly type: "terminal";
      readonly phase: "complete" | "incomplete";
      readonly reason: z.infer<typeof runTerminalReasonSchema> | null;
      readonly at: Date;
    };

export function applyDevelopmentDiagnosticRunEvent(
  stateInput: DevelopmentDiagnosticRunState,
  event: DevelopmentDiagnosticRunEvent
): DevelopmentDiagnosticRunState {
  const state = parseDevelopmentDiagnosticRunState(stateInput);
  if (state.phase !== "running") {
    throw new DevelopmentDiagnosticRunStateError("RUN_STATE_PROGRESS_NOT_RUNNING");
  }
  const timestamp = event.at.toISOString();
  const attempts = state.attempts.map((attempt) => ({ ...attempt }));
  const slots = state.slots.map((slot) => ({
    ...slot,
    completedRoleFingerprints: [...slot.completedRoleFingerprints],
    failedRoleFingerprints: [...slot.failedRoleFingerprints],
    completedStageFingerprints: [...slot.completedStageFingerprints],
    failedStageFingerprints: [...slot.failedStageFingerprints]
  })) as [
    {
      slot: "slot-01";
      status: "not_started" | "running" | "complete" | "incomplete";
      completedRoleFingerprints: string[];
      failedRoleFingerprints: string[];
      completedStageFingerprints: string[];
      failedStageFingerprints: string[];
    },
    {
      slot: "slot-02";
      status: "not_started" | "running" | "complete" | "incomplete";
      completedRoleFingerprints: string[];
      failedRoleFingerprints: string[];
      completedStageFingerprints: string[];
      failedStageFingerprints: string[];
    }
  ];
  const transport = { ...state.transport };
  let terminationIntent = state.terminationIntent;
  let terminalReason = state.terminalReason;
  let phase: DevelopmentDiagnosticRunPhase = state.phase;
  const findAttempt = (sequence: number): (typeof attempts)[number] => {
    const found = attempts[sequence - 1];
    if (found === undefined || found.sequence !== sequence) {
      throw new DevelopmentDiagnosticRunStateError("RUN_STATE_ATTEMPT_MISSING");
    }
    return found;
  };
  const findSlot = (slot: "slot-01" | "slot-02"): (typeof slots)[number] =>
    slots[slot === "slot-01" ? 0 : 1];
  const addUnique = (entries: string[], value: string): void => {
    digestSchema.parse(value);
    if (!entries.includes(value)) entries.push(value);
  };

  switch (event.type) {
    case "transport_intent": {
      if (attempts.length >= 52) {
        throw new DevelopmentDiagnosticRunStateError("RUN_STATE_ATTEMPT_LIMIT");
      }
      attempts.push({
        sequence: attempts.length + 1,
        roleFingerprint: digestSchema.parse(event.roleFingerprint),
        modelFingerprint: digestSchema.parse(event.modelFingerprint),
        attempt: event.attempt,
        outcome: "queued",
        queuedAt: timestamp,
        startAt: null,
        firstOutputAt: null,
        endAt: null,
        endToEndMs: null,
        errorCategory: null
      });
      transport.intended += 1;
      transport.queued += 1;
      break;
    }
    case "transport_reserved": {
      const attempt = findAttempt(event.attemptSequence);
      if (attempt.outcome !== "queued") {
        throw new DevelopmentDiagnosticRunStateError("RUN_STATE_ATTEMPT_TRANSITION_INVALID");
      }
      attempt.outcome = "reserved";
      transport.reserved += 1;
      transport.queued -= 1;
      break;
    }
    case "transport_started": {
      const attempt = findAttempt(event.attemptSequence);
      if (attempt.outcome !== "reserved") {
        throw new DevelopmentDiagnosticRunStateError("RUN_STATE_ATTEMPT_TRANSITION_INVALID");
      }
      attempt.outcome = "running";
      attempt.startAt = timestamp;
      transport.started += 1;
      transport.active += 1;
      break;
    }
    case "transport_first_output": {
      const attempt = findAttempt(event.attemptSequence);
      if (attempt.outcome !== "running") {
        throw new DevelopmentDiagnosticRunStateError("RUN_STATE_ATTEMPT_TRANSITION_INVALID");
      }
      attempt.firstOutputAt ??= timestamp;
      break;
    }
    case "transport_settled": {
      const attempt = findAttempt(event.attemptSequence);
      if (
        attempt.outcome !== "queued" &&
        attempt.outcome !== "reserved" &&
        attempt.outcome !== "running"
      ) {
        throw new DevelopmentDiagnosticRunStateError("RUN_STATE_ATTEMPT_TRANSITION_INVALID");
      }
      const wasRunning = attempt.outcome === "running";
      attempt.outcome = event.outcome;
      attempt.endAt = timestamp;
      attempt.endToEndMs = Math.max(0, event.at.getTime() - Date.parse(attempt.queuedAt));
      attempt.errorCategory = event.outcome === "failed"
        ? terminalFailureSchema.parse(event.errorCategory ?? "permanent")
        : null;
      if (attempt.outcome === "failed") {
        transport.terminalFailure ??= attempt.errorCategory;
      }
      if (wasRunning) {
        transport.settled += 1;
        transport.active -= 1;
      } else if (attempt.startAt === null && state.attempts[event.attemptSequence - 1]?.outcome === "queued") {
        transport.queued -= 1;
      }
      break;
    }
    case "role_completed":
    case "role_failed": {
      const slot = findSlot(event.slot);
      slot.status = "running";
      const destination = event.type === "role_completed"
        ? slot.completedRoleFingerprints
        : slot.failedRoleFingerprints;
      addUnique(destination, event.roleFingerprint);
      if (event.type === "role_failed") {
        transport.terminalFailure ??= terminalFailureSchema.parse(
          event.errorCategory ?? "permanent"
        );
        terminalReason ??= "terminal_role_failure";
      }
      break;
    }
    case "stage_completed":
    case "stage_failed": {
      const slot = findSlot(event.slot);
      slot.status = "running";
      addUnique(
        event.type === "stage_completed"
          ? slot.completedStageFingerprints
          : slot.failedStageFingerprints,
        event.stageFingerprint
      );
      break;
    }
    case "slot_outcome":
      findSlot(event.slot).status = event.status;
      break;
    case "termination_intent":
      terminationIntent ??= event.signal;
      terminalReason ??= "signal";
      break;
    case "terminal": {
      if (event.phase === "complete") {
        phase = "complete";
        terminalReason = null;
      } else {
        if (attempts.some((attempt) => attempt.outcome === "running")) {
          throw new DevelopmentDiagnosticRunStateError("RUN_STATE_ACTIVE_AT_TERMINAL");
        }
        for (const attempt of attempts) {
          if (attempt.outcome === "queued" || attempt.outcome === "reserved") {
            if (attempt.outcome === "queued") transport.queued -= 1;
            attempt.outcome = "failed";
            attempt.endAt = timestamp;
            attempt.endToEndMs = Math.max(0, event.at.getTime() - Date.parse(attempt.queuedAt));
            attempt.errorCategory = "permanent";
          }
        }
        phase = "incomplete";
        terminalReason = runTerminalReasonSchema.parse(event.reason);
        for (const slot of slots) {
          if (slot.status !== "complete") slot.status = "incomplete";
        }
      }
      break;
    }
  }

  return sealState({
    ...withoutIntegrity(state),
    phase,
    updatedAt: timestamp,
    sequence: state.sequence + 1,
    terminationIntent,
    terminalReason,
    transport,
    attempts,
    slots
  });
}

function withoutIntegrity(state: DevelopmentDiagnosticRunState): z.infer<typeof runStatePayloadSchema> {
  const { integritySha256: _integritySha256, ...payload } = state;
  return payload;
}

export const developmentDiagnosticRunStateFileName = "development-diagnostic-run-state.v1.json";
export const developmentDiagnosticRunLockFileName = "development-diagnostic-run.v1.lock";
const maximumDocumentBytes = 256 * 1024;
const temporaryStatePrefix = `.${developmentDiagnosticRunStateFileName}.`;

export interface DevelopmentDiagnosticAtomicWriteResult {
  readonly statePath: string;
  readonly published: true;
  readonly durabilityUnknown: false;
}

export interface AtomicWriteFaults {
  readonly beforeTemporaryOpen?: () => void;
  readonly beforeWrite?: () => void;
  readonly beforeFileFsync?: () => void;
  readonly beforeRename?: () => void;
  readonly beforeDirectoryFsync?: () => void;
}

function assertOwnedStateDirectory(directoryPath: string, create: boolean): void {
  if (create) {
    try {
      mkdirSync(directoryPath, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw new DevelopmentDiagnosticRunStateError("RUN_STATE_DIRECTORY_UNAVAILABLE");
      }
    }
  }
  let status: Stats;
  try {
    status = lstatSync(directoryPath);
  } catch {
    throw new DevelopmentDiagnosticRunStateError("RUN_STATE_DIRECTORY_UNAVAILABLE");
  }
  if (
    status.isSymbolicLink() ||
    !status.isDirectory() ||
    status.uid !== currentUserId() ||
    (status.mode & 0o777) !== 0o700
  ) {
    throw new DevelopmentDiagnosticRunStateError("RUN_STATE_DIRECTORY_UNSAFE");
  }
}

function assertSafeRegularFile(path: string, code: string): Stats {
  let status: Stats;
  try {
    status = lstatSync(path);
  } catch {
    throw new DevelopmentDiagnosticRunStateError(code);
  }
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    status.nlink !== 1 ||
    status.uid !== currentUserId() ||
    (status.mode & 0o777) !== 0o600 ||
    status.size > maximumDocumentBytes
  ) {
    throw new DevelopmentDiagnosticRunStateError(code);
  }
  return status;
}

function assertExistingTargetSafe(path: string): void {
  try {
    assertSafeRegularFile(path, "RUN_STATE_TARGET_UNSAFE");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    if (
      error instanceof DevelopmentDiagnosticRunStateError &&
      error.code === "RUN_STATE_TARGET_UNSAFE"
    ) {
      try {
        lstatSync(path);
      } catch (nested) {
        if (isNodeError(nested, "ENOENT")) return;
      }
    }
    throw error;
  }
}
export function developmentDiagnosticRunStateTemporaryPath(
  directoryPath: string,
  stateInput: DevelopmentDiagnosticRunState
): string {
  const state = parseDevelopmentDiagnosticRunState(stateInput);
  return resolve(
    directoryPath,
    `${temporaryStatePrefix}${state.identity.runId}.${state.integritySha256}.tmp`
  );
}


export function writeDevelopmentDiagnosticRunStateAtomic(input: {
  readonly directoryPath: string;
  readonly state: DevelopmentDiagnosticRunState;
  readonly faults?: AtomicWriteFaults;
}): DevelopmentDiagnosticAtomicWriteResult {
  const state = parseDevelopmentDiagnosticRunState(input.state);
  assertOwnedStateDirectory(input.directoryPath, true);
  const targetPath = resolve(input.directoryPath, developmentDiagnosticRunStateFileName);
  assertExistingTargetSafe(targetPath);
  try {
    lstatSync(targetPath);
    const existing = readDevelopmentDiagnosticRunState({
      directoryPath: input.directoryPath,
      expectedIdentity: state.identity
    });
    if (existing.integritySha256 === state.integritySha256) {
      throw new DevelopmentDiagnosticRunStateError(
        "RUN_STATE_ACTION_ALREADY_PUBLISHED",
        true,
        true
      );
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  const temporaryPath = developmentDiagnosticRunStateTemporaryPath(input.directoryPath, state);
  let descriptor: number | undefined;
  let published = false;
  try {
    input.faults?.beforeTemporaryOpen?.();
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    fchmodSync(descriptor, 0o600);
    input.faults?.beforeWrite?.();
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    input.faults?.beforeFileFsync?.();
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    input.faults?.beforeRename?.();
    renameSync(temporaryPath, targetPath);
    published = true;
    const directoryDescriptor = openSync(
      input.directoryPath,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)
    );
    try {
      input.faults?.beforeDirectoryFsync?.();
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    return { statePath: targetPath, published: true, durabilityUnknown: false };
  } catch (error) {
    if (descriptor !== undefined) closeQuietly(descriptor);
    if (published) {
      throw new DevelopmentDiagnosticRunStateError(
        "RUN_STATE_PUBLISHED_DURABILITY_UNKNOWN",
        true,
        true
      );
    }
    if (error instanceof DevelopmentDiagnosticRunStateError) throw error;
    throw new DevelopmentDiagnosticRunStateError("RUN_STATE_ATOMIC_WRITE_FAILED");
  }
}

export function sealDevelopmentDiagnosticRunStateLocally(input: {
  readonly directoryPath: string;
  readonly state: DevelopmentDiagnosticRunState;
}): string {
  const state = parseDevelopmentDiagnosticRunState(input.state);
  assertOwnedStateDirectory(input.directoryPath, false);
  const temporaryPath = developmentDiagnosticRunStateTemporaryPath(input.directoryPath, state);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    syncDirectory(input.directoryPath);
    return temporaryPath;
  } catch (error) {
    if (descriptor !== undefined) closeQuietly(descriptor);
    try {
      if (
        detectOrphanedDevelopmentDiagnosticTemporaryState({
          directoryPath: input.directoryPath,
          expectedIdentity: state.identity
        })
      ) {
        return temporaryPath;
      }
    } catch {
      // Any unverifiable temporary entry already keeps recovery failed closed.
      return temporaryPath;
    }
    if (error instanceof DevelopmentDiagnosticRunStateError) throw error;
    throw new DevelopmentDiagnosticRunStateError("RUN_STATE_LOCAL_SEAL_FAILED");
  }
}

export function readDevelopmentDiagnosticRunState(input: {
  readonly directoryPath: string;
  readonly expectedIdentity: DevelopmentDiagnosticRunIdentity;
}): DevelopmentDiagnosticRunState {
  assertOwnedStateDirectory(input.directoryPath, false);
  const targetPath = resolve(input.directoryPath, developmentDiagnosticRunStateFileName);
  const pathStatus = assertSafeRegularFile(targetPath, "RUN_STATE_FILE_UNSAFE");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(targetPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStatus = fstatSync(descriptor);
    if (
      openedStatus.dev !== pathStatus.dev ||
      openedStatus.ino !== pathStatus.ino ||
      openedStatus.uid !== currentUserId() ||
      openedStatus.nlink !== 1 ||
      (openedStatus.mode & 0o777) !== 0o600 ||
      !openedStatus.isFile() ||
      openedStatus.size > maximumDocumentBytes
    ) {
      throw new DevelopmentDiagnosticRunStateError("RUN_STATE_FILE_UNSAFE");
    }
    const source = readFileSync(descriptor, "utf8");
    return parseDevelopmentDiagnosticRunState(JSON.parse(source), input.expectedIdentity);
  } catch (error) {
    if (error instanceof DevelopmentDiagnosticRunStateError) throw error;
    throw new DevelopmentDiagnosticRunStateError("RUN_STATE_READ_FAILED");
  } finally {
    if (descriptor !== undefined) closeQuietly(descriptor);
  }
}
function detectOrphanedDevelopmentDiagnosticTemporaryState(input: {
  readonly directoryPath: string;
  readonly expectedIdentity: DevelopmentDiagnosticRunIdentity;
}): boolean {
  assertOwnedStateDirectory(input.directoryPath, false);
  let detected = false;
  let names: string[];
  try {
    names = readdirSync(input.directoryPath);
  } catch {
    throw new DevelopmentDiagnosticRunStateError("RUN_STATE_ORPHAN_SCAN_UNSAFE");
  }
  for (const name of names) {
    if (!name.startsWith(temporaryStatePrefix)) continue;
    const path = resolve(input.directoryPath, name);
    const pathStatus = assertSafeRegularFile(path, "RUN_STATE_ORPHAN_UNSAFE");
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const openedStatus = fstatSync(descriptor);
      if (
        openedStatus.dev !== pathStatus.dev ||
        openedStatus.ino !== pathStatus.ino ||
        openedStatus.uid !== currentUserId() ||
        openedStatus.nlink !== 1 ||
        (openedStatus.mode & 0o777) !== 0o600 ||
        !openedStatus.isFile() ||
        openedStatus.size > maximumDocumentBytes
      ) {
        throw new DevelopmentDiagnosticRunStateError("RUN_STATE_ORPHAN_UNSAFE");
      }
      const state = parseDevelopmentDiagnosticRunState(
        JSON.parse(readFileSync(descriptor, "utf8")),
        input.expectedIdentity
      );
      if (basename(developmentDiagnosticRunStateTemporaryPath(input.directoryPath, state)) !== name) {
        throw new DevelopmentDiagnosticRunStateError("RUN_STATE_ORPHAN_UNSAFE");
      }
      detected = true;
    } catch {
      throw new DevelopmentDiagnosticRunStateError("RUN_STATE_ORPHAN_UNSAFE");
    } finally {
      if (descriptor !== undefined) closeQuietly(descriptor);
    }
  }
  return detected;
}


const lockPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("development-diagnostic-run-lock"),
    runId: z.string().uuid(),
    processId: z.number().int().positive(),
    processStartTimeTicks: processStartTimeTicksSchema,
    startedAt: timestampSchema,
    bootIdSha256: digestSchema
  })
  .strict();
const lockRecordSchema = lockPayloadSchema.extend({ integritySha256: digestSchema }).strict();
type LockRecord = z.infer<typeof lockRecordSchema>;

export interface DevelopmentDiagnosticProcessProbe {
  readonly processId: number;
  readonly processStartTimeTicks: string;
  readonly bootIdSha256: string;
  readonly now: () => Date;
  readonly readProcessStartTimeTicks: (processId: number) => string | null;
}

function defaultProcessProbe(): DevelopmentDiagnosticProcessProbe {
  const processId = process.pid;
  return {
    processId,
    processStartTimeTicks: readProcessStartTimeTicks(processId) ?? failIdentity(),
    bootIdSha256: fingerprint(readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()),
    now: () => new Date(),
    readProcessStartTimeTicks
  };
}

function failIdentity(): never {
  throw new DevelopmentDiagnosticRunStateError("RUN_LOCK_PROCESS_IDENTITY_UNAVAILABLE");
}

function readProcessStartTimeTicks(processId: number): string | null {
  try {
    const source = readFileSync(`/proc/${processId}/stat`, "utf8");
    const commandEnd = source.lastIndexOf(")");
    if (commandEnd < 0) return failIdentity();
    return processStartTimeTicksSchema.parse(
      source.slice(commandEnd + 1).trim().split(/\s+/u)[19]
    );
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    if (error instanceof DevelopmentDiagnosticRunStateError) throw error;
    throw new DevelopmentDiagnosticRunStateError("RUN_LOCK_PROCESS_IDENTITY_UNAVAILABLE");
  }
}

function sealLock(payloadInput: z.input<typeof lockPayloadSchema>): LockRecord {
  const payload = lockPayloadSchema.parse(payloadInput);
  return lockRecordSchema.parse({ ...payload, integritySha256: fingerprint(payload) });
}

function parseLock(source: string): LockRecord {
  let record: LockRecord;
  try {
    record = lockRecordSchema.parse(JSON.parse(source));
  } catch {
    throw new DevelopmentDiagnosticRunStateError("RUN_LOCK_INVALID");
  }
  const { integritySha256, ...payload } = record;
  if (fingerprint(payload) !== integritySha256) {
    throw new DevelopmentDiagnosticRunStateError("RUN_LOCK_TAMPERED");
  }
  return record;
}

function readSafeLock(path: string): { readonly record: LockRecord; readonly status: Stats } {
  const pathStatus = assertSafeRegularFile(path, "RUN_LOCK_UNSAFE");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== pathStatus.dev ||
      opened.ino !== pathStatus.ino ||
      opened.uid !== currentUserId() ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 ||
      !opened.isFile()
    ) {
      throw new DevelopmentDiagnosticRunStateError("RUN_LOCK_UNSAFE");
    }
    return { record: parseLock(readFileSync(descriptor, "utf8")), status: opened };
  } finally {
    if (descriptor !== undefined) closeQuietly(descriptor);
  }
}

export interface DevelopmentDiagnosticRunLock {
  readonly record: LockRecord;
  assertHeld(): void;
  release(): boolean;
}

export function acquireDevelopmentDiagnosticRunLock(input: {
  readonly directoryPath: string;
  readonly runId: string;
  readonly takeover?: boolean;
  readonly probe?: DevelopmentDiagnosticProcessProbe;
}): DevelopmentDiagnosticRunLock {
  assertOwnedStateDirectory(input.directoryPath, true);
  const probe = input.probe ?? defaultProcessProbe();
  const lockPath = resolve(input.directoryPath, developmentDiagnosticRunLockFileName);
  const record = sealLock({
    schemaVersion: 1,
    kind: "development-diagnostic-run-lock",
    runId: input.runId,
    processId: probe.processId,
    processStartTimeTicks: probe.processStartTimeTicks,
    startedAt: probe.now().toISOString(),
    bootIdSha256: probe.bootIdSha256
  });
  try {
    return createLock(lockPath, input.directoryPath, record);
  } catch (error) {
    if (!isRunStateError(error, "RUN_LOCK_ALREADY_HELD")) throw error;
  }
  const existing = readSafeLock(lockPath);
  if (existing.record.bootIdSha256 !== probe.bootIdSha256) {
    throw new DevelopmentDiagnosticRunStateError("RUN_LOCK_BOOT_ID_MISMATCH");
  }
  let observedStart: string | null;
  try {
    observedStart = probe.readProcessStartTimeTicks(existing.record.processId);
  } catch {
    throw new DevelopmentDiagnosticRunStateError("RUN_LOCK_PROCESS_IDENTITY_UNAVAILABLE");
  }
  if (observedStart === existing.record.processStartTimeTicks) {
    throw new DevelopmentDiagnosticRunStateError("RUN_LOCK_ACTIVE");
  }
  if (input.takeover !== true) {
    throw new DevelopmentDiagnosticRunStateError("RUN_LOCK_STALE_TAKEOVER_REQUIRED");
  }
  const quarantinePath = resolve(
    input.directoryPath,
    `.${developmentDiagnosticRunLockFileName}.${randomBytes(12).toString("hex")}.stale`
  );
  try {
    renameSync(lockPath, quarantinePath);
    const moved = readSafeLock(quarantinePath);
    if (
      moved.status.dev !== existing.status.dev ||
      moved.status.ino !== existing.status.ino ||
      moved.record.integritySha256 !== existing.record.integritySha256
    ) {
      restoreQuarantinedLock(quarantinePath, lockPath);
      throw new DevelopmentDiagnosticRunStateError("RUN_LOCK_TAKEOVER_RACE");
    }
    let confirmedStart: string | null;
    try {
      confirmedStart = probe.readProcessStartTimeTicks(moved.record.processId);
    } catch {
      restoreQuarantinedLock(quarantinePath, lockPath);
      throw new DevelopmentDiagnosticRunStateError("RUN_LOCK_PROCESS_IDENTITY_UNAVAILABLE");
    }
    if (confirmedStart === moved.record.processStartTimeTicks) {
      restoreQuarantinedLock(quarantinePath, lockPath);
      throw new DevelopmentDiagnosticRunStateError("RUN_LOCK_ACTIVE");
    }
    let acquired: DevelopmentDiagnosticRunLock;
    try {
      acquired = createLock(lockPath, input.directoryPath, record);
    } catch (error) {
      if (isRunStateError(error, "RUN_LOCK_ALREADY_HELD")) {
        discardQuarantinedLock(quarantinePath, input.directoryPath);
        throw new DevelopmentDiagnosticRunStateError("RUN_LOCK_TAKEOVER_RACE");
      }
      restoreQuarantinedLock(quarantinePath, lockPath);
      throw error;
    }
    discardQuarantinedLock(quarantinePath, input.directoryPath);
    return acquired;
  } catch (error) {
    if (error instanceof DevelopmentDiagnosticRunStateError) throw error;
    throw new DevelopmentDiagnosticRunStateError("RUN_LOCK_TAKEOVER_FAILED");
  }
}

function createLock(
  lockPath: string,
  directoryPath: string,
  record: LockRecord
): DevelopmentDiagnosticRunLock {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      lockPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(descriptor);
    syncDirectory(directoryPath);
    const heldDescriptor = descriptor;
    descriptor = undefined;
    let closed = false;
    return {
      record,
      assertHeld: () => {
        if (closed || !lockPathMatchesDescriptor(lockPath, heldDescriptor, record)) {
          throw new DevelopmentDiagnosticRunStateError("RUN_LOCK_OWNERSHIP_LOST");
        }
      },
      release: () => {
        if (closed) return false;
        let released = false;
        try {
          if (lockPathMatchesDescriptor(lockPath, heldDescriptor, record)) {
            unlinkSync(lockPath);
            syncDirectory(directoryPath);
            released = true;
          }
        } catch {
          released = false;
        } finally {
          closeQuietly(heldDescriptor);
          closed = true;
        }
        return released;
      }
    };
  } catch (error) {
    if (descriptor !== undefined) closeQuietly(descriptor);
    if (isNodeError(error, "EEXIST")) {
      throw new DevelopmentDiagnosticRunStateError("RUN_LOCK_ALREADY_HELD");
    }
    throw new DevelopmentDiagnosticRunStateError("RUN_LOCK_CREATE_FAILED");
  }
}

function lockPathMatchesDescriptor(path: string, descriptor: number, record: LockRecord): boolean {
  try {
    const current = readSafeLock(path);
    const heldStatus = fstatSync(descriptor);
    return (
      current.status.dev === heldStatus.dev &&
      current.status.ino === heldStatus.ino &&
      current.record.integritySha256 === record.integritySha256
    );
  } catch {
    return false;
  }
}

function restoreQuarantinedLock(quarantinePath: string, lockPath: string): void {
  try {
    linkSync(quarantinePath, lockPath);
    syncDirectory(dirname(lockPath));
    unlinkSync(quarantinePath);
    syncDirectory(dirname(lockPath));
  } catch {
    throw new DevelopmentDiagnosticRunStateError("RUN_LOCK_TAKEOVER_RESTORE_FAILED");
  }
}

function discardQuarantinedLock(quarantinePath: string, directoryPath: string): void {
  try {
    unlinkSync(quarantinePath);
    syncDirectory(directoryPath);
  } catch {
  }
}

export type DevelopmentDiagnosticRecoveryReason =
  | "safe_pre_transport"
  | "identity_mismatch"
  | "orphaned_atomic_write"
  | "durability_unknown"
  | "running_state_requires_incomplete_seal"
  | "terminal_state"
  | "progress_before_authorization"
  | "state_invalid";

export type DevelopmentDiagnosticRecoveryDecision =
  | { readonly allowed: true; readonly reason: "safe_pre_transport" }
  | {
      readonly allowed: false;
      readonly reason: Exclude<DevelopmentDiagnosticRecoveryReason, "safe_pre_transport">;
      readonly requiresNewRun: true;
    };

function currentUserId(): number {
  if (process.geteuid === undefined) {
    throw new DevelopmentDiagnosticRunStateError("RUN_STATE_OWNER_IDENTITY_UNAVAILABLE");
  }
  return process.geteuid();
}

export function assessDevelopmentDiagnosticRecovery(input: {
  readonly state: unknown;
  readonly expectedIdentity: DevelopmentDiagnosticRunIdentity;
  readonly directoryPath: string;
  readonly atomicWriteError?: DevelopmentDiagnosticRunStateError;
}): DevelopmentDiagnosticRecoveryDecision {
  let state: DevelopmentDiagnosticRunState;
  try {
    state = parseDevelopmentDiagnosticRunState(input.state, input.expectedIdentity);
  } catch (error) {
    return deniedRecovery(
      isRunStateError(error, "RUN_STATE_IDENTITY_MISMATCH") ? "identity_mismatch" : "state_invalid"
    );
  }
  if (
    input.atomicWriteError?.published === true &&
    input.atomicWriteError.durabilityUnknown === true
  ) {
    return deniedRecovery("durability_unknown");
  }
  try {
    if (
      detectOrphanedDevelopmentDiagnosticTemporaryState({
        directoryPath: input.directoryPath,
        expectedIdentity: input.expectedIdentity
      })
    ) {
      return deniedRecovery("orphaned_atomic_write");
    }
  } catch {
    return deniedRecovery("orphaned_atomic_write");
  }
  if (state.phase === "running") {
    return deniedRecovery("running_state_requires_incomplete_seal");
  }
  if (state.phase === "complete" || state.phase === "incomplete") {
    return deniedRecovery("terminal_state");
  }
  return state.transport.started === 0 &&
    state.transport.settled === 0 &&
    state.transport.active === 0 &&
    state.transport.queued === 0 &&
    state.slots.every((slot) => slot.status === "not_started")
    ? { allowed: true, reason: "safe_pre_transport" }
    : deniedRecovery("progress_before_authorization");
}

function deniedRecovery(
  reason: Exclude<DevelopmentDiagnosticRecoveryReason, "safe_pre_transport">
): DevelopmentDiagnosticRecoveryDecision {
  return { allowed: false, reason, requiresNewRun: true };
}

function syncDirectory(directoryPath: string): void {
  const descriptor = openSync(directoryPath, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function closeQuietly(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // Best effort only; the primary operation remains failed closed.
  }
}


function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isRunStateError(error: unknown, code: string): boolean {
  return error instanceof DevelopmentDiagnosticRunStateError && error.code === code;
}

export function developmentDiagnosticRunStatePath(directoryPath: string): string {
  return resolve(directoryPath, developmentDiagnosticRunStateFileName);
}

export function developmentDiagnosticRunLockPath(directoryPath: string): string {
  return resolve(directoryPath, developmentDiagnosticRunLockFileName);
}

export function isDevelopmentDiagnosticTemporaryFile(path: string): boolean {
  const name = basename(path);
  if (
    dirname(path) === path ||
    !name.startsWith(temporaryStatePrefix) ||
    !name.endsWith(".tmp")
  ) {
    return false;
  }
  const components = name.slice(temporaryStatePrefix.length, -4).split(".");
  return (
    components.length === 2 &&
    z.string().uuid().safeParse(components[0]).success &&
    digestSchema.safeParse(components[1]).success
  );
}
