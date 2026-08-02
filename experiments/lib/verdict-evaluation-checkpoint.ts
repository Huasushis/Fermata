/**
 * verdict 付费诊断的 prediction-only 私有检查点。每个 case 在请求前先原子写入
 * active；检查点从不保存 rating、expected verdict、expectationMet 或模型原文。
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  anchoredPrivatePath,
  closePrivateDirectory,
  preparePrivateDirectory,
  projectPrivateRoot,
  readProtectedEnvFile,
  workspaceRoot,
  type PrivateDirectoryHandle
} from "../../scripts/private-runtime.mjs";
import {
  reconcileEvaluation,
  type EvaluationCompleteness,
  type EvaluationFailure
} from "./evaluation-integrity";
import {
  verdictBlindPredictionSchema,
  type VerdictBlindPrediction,
  type VerdictBlindPredictionRecord
} from "./verdict-evaluation-design";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const labelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const runIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const sampleIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const timestampSchema = z.string().datetime();
const processStartTimeTicksSchema = z.string().regex(/^[1-9][0-9]*$/);

export class VerdictCheckpointError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "VerdictCheckpointError";
    this.code = code;
  }
}

export const verdictCheckpointCaseBindingSchema = z
  .object({
    sampleId: sampleIdSchema,
    contentHash: digestSchema
  })
  .strict();
export type VerdictCheckpointCaseBinding = z.infer<
  typeof verdictCheckpointCaseBindingSchema
>;

const pendingEntrySchema = verdictCheckpointCaseBindingSchema.extend({
  status: z.literal("pending")
}).strict();
const activeEntrySchema = verdictCheckpointCaseBindingSchema.extend({
  status: z.literal("active"),
  startedAt: timestampSchema
}).strict();
const succeededEntrySchema = verdictCheckpointCaseBindingSchema.extend({
  status: z.literal("succeeded"),
  completedAt: timestampSchema,
  prediction: verdictBlindPredictionSchema
}).strict();
const failedEntrySchema = verdictCheckpointCaseBindingSchema.extend({
  status: z.literal("failed"),
  failedAt: timestampSchema,
  code: z.string().regex(/^[A-Z0-9_]{1,120}$/),
  httpStatus: z.number().int().min(100).max(599).optional()
}).strict();
const entrySchema = z.discriminatedUnion("status", [
  pendingEntrySchema,
  activeEntrySchema,
  succeededEntrySchema,
  failedEntrySchema
]);
type VerdictCheckpointEntry = z.infer<typeof entrySchema>;

const publishedReportSchema = z
  .object({
    executionRunId: runIdSchema,
    completionFingerprint: digestSchema,
    publishedAt: timestampSchema
  })
  .strict();

export const verdictCheckpointLockRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    processId: z.number().int().positive(),
    processStartTimeTicks: processStartTimeTicksSchema,
    chainRunId: z.string().uuid(),
    originalReportRunId: runIdSchema,
    chainIdentityStatus: z.enum(["provisional", "checkpoint_bound"]),
    acquiredAt: timestampSchema,
    recoveryRule: z.literal("VERIFY_PID_START_TIME_AND_PROJECT_PROCESS_BEFORE_MANUAL_REMOVAL")
  })
  .strict();
export type VerdictCheckpointLockRecord = z.infer<
  typeof verdictCheckpointLockRecordSchema
>;

const verdictCheckpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    chainRunId: z.string().uuid(),
    reportRunId: runIdSchema,
    label: labelSchema,
    contentDatasetFingerprint: digestSchema,
    configurationFingerprint: digestSchema,
    expectedCases: z.array(verdictCheckpointCaseBindingSchema).min(1).max(20_000),
    entries: z.array(entrySchema).min(1).max(20_000),
    revision: z.number().int().positive(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    publishedReport: publishedReportSchema.optional()
  })
  .strict()
  .superRefine((state, context) => {
    const expectedIds = state.expectedCases.map((entry) => entry.sampleId);
    const entryIds = state.entries.map((entry) => entry.sampleId);
    if (
      new Set(expectedIds).size !== expectedIds.length ||
      new Set(entryIds).size !== entryIds.length ||
      state.entries.length !== state.expectedCases.length ||
      state.entries.some((entry, index) => {
        const expected = state.expectedCases[index];
        return expected === undefined ||
          entry.sampleId !== expected.sampleId ||
          entry.contentHash !== expected.contentHash;
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "verdict 检查点 case 集不一致。"
      });
    }
    if (
      state.publishedReport !== undefined &&
      state.entries.some((entry) => entry.status !== "succeeded")
    ) {
      context.addIssue({
        code: "custom",
        path: ["publishedReport"],
        message: "只有全部 case 成功的链才能封存完整报告。"
      });
    }
  });
export type VerdictEvaluationCheckpointState = z.infer<
  typeof verdictCheckpointSchema
>;

export interface VerdictCheckpointOptions {
  readonly label: string;
  readonly reportRunId: string;
  /** 只由推理内容容器计算，不能使用包含 rating/人工答案的源 manifest 指纹。 */
  readonly contentDatasetFingerprint: string;
  readonly configurationFingerprint: string;
  readonly expectedCases: readonly VerdictCheckpointCaseBinding[];
  readonly privateRoot?: string;
  readonly containingWorkspace?: string;
  readonly now?: () => Date;
}

export interface ContaminatedVerdictResume {
  readonly kind: "contaminated";
  readonly persistedPredictions: readonly VerdictBlindPredictionRecord[];
  readonly terminalFailures: readonly EvaluationFailure[];
  readonly integrity: EvaluationCompleteness;
}

export interface ContinuedVerdictEvaluation<T> {
  readonly kind: "continued";
  readonly value: T;
}

/** 既有失败链在付费调用门前直接收束，pending 只记为缺失。 */
export async function continueVerdictEvaluationUnlessContaminated<T>(input: {
  readonly checkpoint: Pick<
    VerdictEvaluationCheckpoint,
    "openedExistingCheckpoint" | "terminalFailures" | "succeededPredictions"
  >;
  readonly expectedSampleIds: readonly string[];
  readonly continueClean: () => Promise<T>;
}): Promise<ContaminatedVerdictResume | ContinuedVerdictEvaluation<T>> {
  if (input.checkpoint.openedExistingCheckpoint()) {
    const terminalFailures = input.checkpoint.terminalFailures();
    if (terminalFailures.length > 0) {
      const persistedPredictions = input.checkpoint.succeededPredictions();
      return {
        kind: "contaminated",
        persistedPredictions,
        terminalFailures,
        integrity: reconcileEvaluation({
          expectedSampleIds: input.expectedSampleIds,
          succeededSampleIds: persistedPredictions.map((entry) => entry.sampleId),
          failures: terminalFailures
        })
      };
    }
  }
  return { kind: "continued", value: await input.continueClean() };
}

export class VerdictEvaluationCheckpoint {
  readonly #directory: PrivateDirectoryHandle;
  readonly #stateFileName: string;
  readonly #lockFileName: string;
  readonly #now: () => Date;
  #lockRecord: VerdictCheckpointLockRecord;
  #lockDescriptor: number | undefined;
  #state: VerdictEvaluationCheckpointState;
  #openedExisting = false;
  #closed = false;

  constructor(options: VerdictCheckpointOptions) {
    const label = labelSchema.parse(options.label);
    const reportRunId = runIdSchema.parse(options.reportRunId);
    const contentDatasetFingerprint = digestSchema.parse(
      options.contentDatasetFingerprint
    );
    const configurationFingerprint = digestSchema.parse(
      options.configurationFingerprint
    );
    const expectedCases = z
      .array(verdictCheckpointCaseBindingSchema)
      .min(1)
      .max(20_000)
      .parse(options.expectedCases);
    if (new Set(expectedCases.map((entry) => entry.sampleId)).size !== expectedCases.length) {
      throw new VerdictCheckpointError("VERDICT_CHECKPOINT_CASE_SET_INVALID");
    }
    const privateRoot = options.privateRoot ?? projectPrivateRoot;
    const containingWorkspace = options.containingWorkspace ?? workspaceRoot;
    this.#directory = preparePrivateDirectory(join(privateRoot, "evaluation-state"), {
      privateRoot,
      containingWorkspace
    });
    this.#stateFileName = `verdict-${label}.checkpoint.private.json`;
    this.#lockFileName = `verdict-${label}.lock.private`;
    this.#now = options.now ?? (() => new Date());
    const newChainRunId = randomUUID();
    this.#lockRecord = verdictCheckpointLockRecordSchema.parse({
      schemaVersion: 1,
      processId: process.pid,
      processStartTimeTicks: readCurrentProcessStartTimeTicks(),
      chainRunId: newChainRunId,
      originalReportRunId: reportRunId,
      chainIdentityStatus: "provisional",
      acquiredAt: this.#now().toISOString(),
      recoveryRule: "VERIFY_PID_START_TIME_AND_PROJECT_PROCESS_BEFORE_MANUAL_REMOVAL"
    });

    try {
      this.acquireLock();
    } catch {
      this.releaseResources();
      throw new VerdictCheckpointError("VERDICT_CHECKPOINT_LOCKED_OR_UNAVAILABLE");
    }

    const statePath = join(this.#directory.path, this.#stateFileName);
    if (existsSync(anchoredPrivatePath(this.#directory, this.#stateFileName))) {
      let rawState: unknown;
      try {
        rawState = JSON.parse(
          readProtectedEnvFile(statePath, {
            privateRoot,
            containingWorkspace,
            maximumBytes: 8 * 1024 * 1024
          })
        ) as unknown;
      } catch {
        this.releaseResources();
        throw new VerdictCheckpointError("VERDICT_CHECKPOINT_INVALID");
      }
      const rawSchemaVersion =
        typeof rawState === "object" &&
        rawState !== null &&
        "schemaVersion" in rawState
          ? (rawState as { readonly schemaVersion?: unknown }).schemaVersion
          : undefined;
      if (
        typeof rawSchemaVersion === "number" &&
        Number.isInteger(rawSchemaVersion) &&
        rawSchemaVersion !== 1
      ) {
        this.releaseResources();
        throw new VerdictCheckpointError("VERDICT_CHECKPOINT_VERSION_UNSUPPORTED");
      }
      const parsed = verdictCheckpointSchema.safeParse(rawState);
      if (!parsed.success) {
        this.releaseResources();
        throw new VerdictCheckpointError("VERDICT_CHECKPOINT_INVALID");
      }
      if (
        parsed.data.label !== label ||
        parsed.data.contentDatasetFingerprint !== contentDatasetFingerprint ||
        parsed.data.configurationFingerprint !== configurationFingerprint ||
        !sameCases(parsed.data.expectedCases, expectedCases)
      ) {
        this.releaseResources();
        throw new VerdictCheckpointError("VERDICT_CHECKPOINT_FINGERPRINT_MISMATCH");
      }
      this.#state = parsed.data;
      this.#openedExisting = true;
      this.#lockRecord = verdictCheckpointLockRecordSchema.parse({
        ...this.#lockRecord,
        chainRunId: parsed.data.chainRunId,
        originalReportRunId: parsed.data.reportRunId,
        chainIdentityStatus: "checkpoint_bound"
      });
      try {
        this.replaceLockRecord();
      } catch {
        this.releaseResources();
        throw new VerdictCheckpointError("VERDICT_CHECKPOINT_LOCK_WRITE_FAILED");
      }
      return;
    }

    const now = this.#now().toISOString();
    this.#state = verdictCheckpointSchema.parse({
      schemaVersion: 1,
      chainRunId: newChainRunId,
      reportRunId,
      label,
      contentDatasetFingerprint,
      configurationFingerprint,
      expectedCases,
      entries: expectedCases.map((entry) => ({ ...entry, status: "pending" as const })),
      revision: 1,
      createdAt: now,
      updatedAt: now
    });
    try {
      this.persist();
      this.#lockRecord = verdictCheckpointLockRecordSchema.parse({
        ...this.#lockRecord,
        chainIdentityStatus: "checkpoint_bound"
      });
      this.replaceLockRecord();
    } catch (error) {
      this.releaseResources();
      throw error;
    }
  }

  snapshot(): VerdictEvaluationCheckpointState {
    return verdictCheckpointSchema.parse(this.#state);
  }

  openedExistingCheckpoint(): boolean {
    return this.#openedExisting;
  }

  hasPublishedCompleteReport(): boolean {
    return this.#state.publishedReport !== undefined;
  }

  pendingCases(): VerdictCheckpointCaseBinding[] {
    return this.#state.entries.flatMap((entry) =>
      entry.status === "pending"
        ? [{ sampleId: entry.sampleId, contentHash: entry.contentHash }]
        : []
    );
  }

  succeededPredictions(): VerdictBlindPredictionRecord[] {
    return this.#state.entries.flatMap((entry) =>
      entry.status === "succeeded"
        ? [{
            sampleId: entry.sampleId,
            contentHash: entry.contentHash,
            prediction: entry.prediction
          }]
        : []
    );
  }

  terminalFailures(): EvaluationFailure[] {
    return this.#state.entries.flatMap((entry): EvaluationFailure[] => {
      if (entry.status === "active") {
        return [{
          sampleId: entry.sampleId,
          phase: "execution",
          code: "EVALUATION_ACTIVE_FROM_INTERRUPTED_RUN"
        }];
      }
      if (entry.status === "failed") {
        return [{
          sampleId: entry.sampleId,
          phase: "execution",
          code: entry.code,
          ...(entry.httpStatus === undefined ? {} : { httpStatus: entry.httpStatus })
        }];
      }
      return [];
    });
  }

  markActive(sampleId: string): void {
    this.replaceEntry(sampleId, (entry) => {
      if (entry.status !== "pending") {
        throw new VerdictCheckpointError("VERDICT_CHECKPOINT_SAMPLE_NOT_PENDING");
      }
      return {
        sampleId: entry.sampleId,
        contentHash: entry.contentHash,
        status: "active",
        startedAt: this.#now().toISOString()
      };
    });
  }

  markSucceeded(sampleId: string, prediction: VerdictBlindPrediction): void {
    const parsedPrediction = verdictBlindPredictionSchema.parse(prediction);
    this.replaceEntry(sampleId, (entry) => {
      if (entry.status !== "active") {
        throw new VerdictCheckpointError("VERDICT_CHECKPOINT_SAMPLE_NOT_ACTIVE");
      }
      return {
        sampleId: entry.sampleId,
        contentHash: entry.contentHash,
        status: "succeeded",
        completedAt: this.#now().toISOString(),
        prediction: parsedPrediction
      };
    });
  }

  markFailed(sampleId: string, failure: EvaluationFailure): void {
    this.replaceEntry(sampleId, (entry) => {
      if (entry.status !== "active" || failure.sampleId !== sampleId) {
        throw new VerdictCheckpointError("VERDICT_CHECKPOINT_SAMPLE_NOT_ACTIVE");
      }
      return {
        sampleId: entry.sampleId,
        contentHash: entry.contentHash,
        status: "failed",
        failedAt: this.#now().toISOString(),
        code: failure.code.replace(/[^A-Z0-9_]/g, "_").slice(0, 120) || "UNEXPECTED_ERROR",
        ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus })
      };
    });
  }

  markCompleteReportPublished(
    executionRunId: string,
    completionFingerprint: string
  ): void {
    this.assertOpen();
    if (
      this.#state.publishedReport !== undefined ||
      this.#state.entries.some((entry) => entry.status !== "succeeded")
    ) {
      throw new VerdictCheckpointError("VERDICT_CHECKPOINT_REPORT_NOT_PUBLISHABLE");
    }
    this.#state = verdictCheckpointSchema.parse({
      ...this.#state,
      publishedReport: {
        executionRunId: runIdSchema.parse(executionRunId),
        completionFingerprint: digestSchema.parse(completionFingerprint),
        publishedAt: this.#now().toISOString()
      },
      revision: this.#state.revision + 1,
      updatedAt: this.#now().toISOString()
    });
    this.persist();
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.releaseResources();
    }
  }

  private replaceEntry(
    sampleId: string,
    replacement: (entry: VerdictCheckpointEntry) => VerdictCheckpointEntry
  ): void {
    this.assertOpen();
    const index = this.#state.entries.findIndex((entry) => entry.sampleId === sampleId);
    if (index < 0) {
      throw new VerdictCheckpointError("VERDICT_CHECKPOINT_SAMPLE_UNKNOWN");
    }
    const entries = [...this.#state.entries];
    entries[index] = replacement(entries[index]!);
    this.#state = verdictCheckpointSchema.parse({
      ...this.#state,
      entries,
      revision: this.#state.revision + 1,
      updatedAt: this.#now().toISOString()
    });
    this.persist();
  }

  private persist(): void {
    this.assertOpen();
    const temporaryName = `${this.#stateFileName}.tmp-${process.pid}-${randomUUID()}`;
    const temporaryPath = anchoredPrivatePath(this.#directory, temporaryName);
    const targetPath = anchoredPrivatePath(this.#directory, this.#stateFileName);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      writeFileSync(descriptor, `${JSON.stringify(this.#state, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, targetPath);
      fsyncSync(this.#directory.descriptor);
    } catch {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // 固定错误码，不记录内容或路径。
        }
      }
      try {
        unlinkSync(temporaryPath);
      } catch {
        // 只清理本次唯一临时文件。
      }
      throw new VerdictCheckpointError("VERDICT_CHECKPOINT_WRITE_FAILED");
    }
  }

  private acquireLock(): void {
    const temporaryName = `${this.#lockFileName}.tmp-${process.pid}-${randomUUID()}`;
    const temporaryPath = anchoredPrivatePath(this.#directory, temporaryName);
    const lockPath = anchoredPrivatePath(this.#directory, this.#lockFileName);
    let descriptor: number | undefined;
    let temporaryExists = false;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      temporaryExists = true;
      this.writeLockDocument(descriptor);
      linkSync(temporaryPath, lockPath);
      this.#lockDescriptor = descriptor;
      descriptor = undefined;
      unlinkSync(temporaryPath);
      temporaryExists = false;
      fsyncSync(this.#directory.descriptor);
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // 固定错误码。
        }
      }
      if (temporaryExists) {
        try {
          unlinkSync(temporaryPath);
        } catch {
          // 只清理本次临时锁。
        }
      }
    }
  }

  private replaceLockRecord(): void {
    if (this.#lockDescriptor === undefined) {
      throw new VerdictCheckpointError("VERDICT_CHECKPOINT_LOCK_NOT_HELD");
    }
    const temporaryName = `${this.#lockFileName}.tmp-${process.pid}-${randomUUID()}`;
    const temporaryPath = anchoredPrivatePath(this.#directory, temporaryName);
    const lockPath = anchoredPrivatePath(this.#directory, this.#lockFileName);
    let descriptor: number | undefined;
    let temporaryExists = false;
    let previousDescriptor: number | undefined;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      temporaryExists = true;
      this.writeLockDocument(descriptor);
      const held = fstatSync(this.#lockDescriptor, { bigint: true });
      const linked = lstatSync(lockPath, { bigint: true });
      if (held.dev !== linked.dev || held.ino !== linked.ino || !linked.isFile()) {
        throw new VerdictCheckpointError("VERDICT_CHECKPOINT_LOCK_OWNERSHIP_LOST");
      }
      renameSync(temporaryPath, lockPath);
      temporaryExists = false;
      previousDescriptor = this.#lockDescriptor;
      this.#lockDescriptor = descriptor;
      descriptor = undefined;
      fsyncSync(this.#directory.descriptor);
    } finally {
      if (previousDescriptor !== undefined) {
        try {
          closeSync(previousDescriptor);
        } catch {
          // 固定错误码。
        }
      }
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // 固定错误码。
        }
      }
      if (temporaryExists) {
        try {
          unlinkSync(temporaryPath);
        } catch {
          // 只清理本次临时锁。
        }
      }
    }
  }

  private writeLockDocument(descriptor: number): void {
    const document = Buffer.from(`${JSON.stringify(this.#lockRecord, null, 2)}\n`, "utf8");
    let offset = 0;
    while (offset < document.byteLength) {
      const written = writeSync(
        descriptor,
        document,
        offset,
        document.byteLength - offset,
        offset
      );
      if (written <= 0) {
        throw new VerdictCheckpointError("VERDICT_CHECKPOINT_LOCK_WRITE_FAILED");
      }
      offset += written;
    }
    fsyncSync(descriptor);
  }

  private assertOpen(): void {
    if (this.#closed) {
      throw new VerdictCheckpointError("VERDICT_CHECKPOINT_CLOSED");
    }
  }

  private releaseResources(): void {
    if (this.#lockDescriptor !== undefined) {
      const lockPath = anchoredPrivatePath(this.#directory, this.#lockFileName);
      try {
        const held = fstatSync(this.#lockDescriptor, { bigint: true });
        const linked = lstatSync(lockPath, { bigint: true });
        if (held.dev === linked.dev && held.ino === linked.ino && linked.isFile()) {
          unlinkSync(lockPath);
          fsyncSync(this.#directory.descriptor);
        }
      } catch {
        // 无法证明锁归属时保留锁，禁止误删其它进程的锁。
      }
      try {
        closeSync(this.#lockDescriptor);
      } catch {
        // 固定错误码。
      }
      this.#lockDescriptor = undefined;
    }
    closePrivateDirectory(this.#directory);
  }
}

function sameCases(
  left: readonly VerdictCheckpointCaseBinding[],
  right: readonly VerdictCheckpointCaseBinding[]
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return other !== undefined &&
      entry.sampleId === other.sampleId &&
      entry.contentHash === other.contentHash;
  });
}

/** Linux /proc stat 第 22 字段；与 PID 一起排除 PID 复用。 */
function readCurrentProcessStartTimeTicks(): string {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) {
      throw new Error("invalid-proc-stat");
    }
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    return processStartTimeTicksSchema.parse(fields[19]);
  } catch {
    throw new VerdictCheckpointError(
      "VERDICT_CHECKPOINT_PROCESS_IDENTITY_UNAVAILABLE"
    );
  }
}
