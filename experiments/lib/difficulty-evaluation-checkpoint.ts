/**
 * difficulty 评测的私有付费请求检查点。检查点不保存题面、题解、模型理由
 * 或密钥，只保存不透明样本 id、数值结果和固定失败码。
 *
 * 语义是故意严格的：
 * - 发起模型请求前必须先原子持久化 active；
 * - 成功后原子持久化 succeeded，resume 不再为它付费；
 * - 失败会持久化 failed；崩溃留下的 active 也不自动重试，两者都永久污染该链；
 * - dataset/config/expected 指纹任一改变都不能沿用旧检查点。
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
import type { EvaluationFailure } from "./evaluation-integrity";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const labelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const runIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const sampleIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const timestampSchema = z.string().datetime();
const processStartTimeTicksSchema = z.string().regex(/^[1-9][0-9]*$/);

export const difficultyCheckpointRowSchema = z
  .object({
    contestId: z.number().int().positive(),
    index: z.string().regex(/^[A-Z][0-9]{0,7}$/),
    actualRating: z.number().int().min(800).max(3500).multipleOf(100),
    predictedRating: z.number().int().min(800).max(3500).multipleOf(100),
    error: z.number().int().min(-2700).max(2700).multipleOf(100),
    confidence: z.number().min(0).max(1)
  })
  .strict();
export type DifficultyCheckpointRow = z.infer<typeof difficultyCheckpointRowSchema>;

const pendingEntrySchema = z.object({ sampleId: sampleIdSchema, status: z.literal("pending") }).strict();
const activeEntrySchema = z
  .object({ sampleId: sampleIdSchema, status: z.literal("active"), startedAt: timestampSchema })
  .strict();
const succeededEntrySchema = z
  .object({
    sampleId: sampleIdSchema,
    status: z.literal("succeeded"),
    completedAt: timestampSchema,
    row: difficultyCheckpointRowSchema
  })
  .strict();
const failedEntrySchema = z
  .object({
    sampleId: sampleIdSchema,
    status: z.literal("failed"),
    failedAt: timestampSchema,
    code: z.string().regex(/^[A-Z0-9_]{1,120}$/),
    httpStatus: z.number().int().min(100).max(599).optional()
  })
  .strict();
const entrySchema = z.discriminatedUnion("status", [
  pendingEntrySchema,
  activeEntrySchema,
  succeededEntrySchema,
  failedEntrySchema
]);
type CheckpointEntry = z.infer<typeof entrySchema>;

const publishedReportSchema = z
  .object({
    executionRunId: runIdSchema,
    completionFingerprint: digestSchema,
    publishedAt: timestampSchema
  })
  .strict();

export const difficultyCheckpointLockRecordSchema = z
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
export type DifficultyCheckpointLockRecord = z.infer<typeof difficultyCheckpointLockRecordSchema>;

const checkpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    chainRunId: z.string().uuid(),
    reportRunId: runIdSchema,
    label: labelSchema,
    datasetManifestFingerprint: digestSchema,
    configurationFingerprint: digestSchema,
    expectedSampleIds: z.array(sampleIdSchema).min(1).max(10_000),
    entries: z.array(entrySchema).min(1).max(10_000),
    revision: z.number().int().positive(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    publishedReport: publishedReportSchema.optional()
  })
  .strict()
  .superRefine((state, context) => {
    if (
      new Set(state.expectedSampleIds).size !== state.expectedSampleIds.length ||
      new Set(state.entries.map((entry) => entry.sampleId)).size !== state.entries.length ||
      state.entries.length !== state.expectedSampleIds.length ||
      state.entries.some((entry, index) => entry.sampleId !== state.expectedSampleIds[index])
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "检查点样本集不一致。" });
    }
    if (
      state.publishedReport !== undefined &&
      state.entries.some((entry) => entry.status !== "succeeded")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["publishedReport"],
        message: "只有全部样本成功的链才能封存完整报告。"
      });
    }
  });
export type DifficultyEvaluationCheckpointState = z.infer<typeof checkpointSchema>;

export interface DifficultyCheckpointOptions {
  readonly label: string;
  readonly reportRunId: string;
  readonly datasetManifestFingerprint: string;
  readonly configurationFingerprint: string;
  readonly expectedSampleIds: readonly string[];
  readonly privateRoot?: string;
  readonly containingWorkspace?: string;
  readonly now?: () => Date;
}

export class DifficultyEvaluationCheckpoint {
  readonly #directory: PrivateDirectoryHandle;
  readonly #stateFileName: string;
  readonly #lockFileName: string;
  readonly #now: () => Date;
  #lockRecord: DifficultyCheckpointLockRecord;
  #lockDescriptor: number | undefined;
  #state: DifficultyEvaluationCheckpointState;
  #openedExisting = false;
  #closed = false;

  public constructor(options: DifficultyCheckpointOptions) {
    const label = labelSchema.parse(options.label);
    const reportRunId = runIdSchema.parse(options.reportRunId);
    const datasetManifestFingerprint = digestSchema.parse(options.datasetManifestFingerprint);
    const configurationFingerprint = digestSchema.parse(options.configurationFingerprint);
    const expectedSampleIds = z.array(sampleIdSchema).min(1).max(10_000).parse(options.expectedSampleIds);
    const privateRoot = options.privateRoot ?? projectPrivateRoot;
    const containingWorkspace = options.containingWorkspace ?? workspaceRoot;
    this.#directory = preparePrivateDirectory(join(privateRoot, "evaluation-state"), {
      privateRoot,
      containingWorkspace
    });
    this.#stateFileName = `difficulty-${label}.checkpoint.private.json`;
    this.#lockFileName = `difficulty-${label}.lock.private`;
    this.#now = options.now ?? (() => new Date());
    const newChainRunId = randomUUID();
    this.#lockRecord = difficultyCheckpointLockRecordSchema.parse({
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
      throw new Error("DIFFICULTY_CHECKPOINT_LOCKED_OR_UNAVAILABLE");
    }

    const statePath = join(this.#directory.path, this.#stateFileName);
    if (existsSync(anchoredPrivatePath(this.#directory, this.#stateFileName))) {
      let loaded: DifficultyEvaluationCheckpointState;
      try {
        loaded = checkpointSchema.parse(
          JSON.parse(
            readProtectedEnvFile(statePath, {
              privateRoot,
              containingWorkspace,
              maximumBytes: 4 * 1024 * 1024
            })
          ) as unknown
        );
      } catch {
        this.releaseResources();
        throw new Error("DIFFICULTY_CHECKPOINT_INVALID");
      }
      if (
        loaded.label !== label ||
        loaded.datasetManifestFingerprint !== datasetManifestFingerprint ||
        loaded.configurationFingerprint !== configurationFingerprint ||
        !sameStrings(loaded.expectedSampleIds, expectedSampleIds)
      ) {
        this.releaseResources();
        throw new Error("DIFFICULTY_CHECKPOINT_FINGERPRINT_MISMATCH");
      }
      this.#state = loaded;
      this.#openedExisting = true;
      this.#lockRecord = difficultyCheckpointLockRecordSchema.parse({
        ...this.#lockRecord,
        chainRunId: loaded.chainRunId,
        originalReportRunId: loaded.reportRunId,
        chainIdentityStatus: "checkpoint_bound"
      });
      try {
        this.replaceLockRecord();
      } catch {
        this.releaseResources();
        throw new Error("DIFFICULTY_CHECKPOINT_LOCK_WRITE_FAILED");
      }
      return;
    }

    const now = this.#now().toISOString();
    this.#state = checkpointSchema.parse({
      schemaVersion: 1,
      chainRunId: newChainRunId,
      reportRunId,
      label,
      datasetManifestFingerprint,
      configurationFingerprint,
      expectedSampleIds,
      entries: expectedSampleIds.map((sampleId) => ({ sampleId, status: "pending" as const })),
      revision: 1,
      createdAt: now,
      updatedAt: now
    });
    try {
      this.persist();
      this.#lockRecord = difficultyCheckpointLockRecordSchema.parse({
        ...this.#lockRecord,
        chainIdentityStatus: "checkpoint_bound"
      });
      this.replaceLockRecord();
    } catch (error) {
      this.releaseResources();
      throw error;
    }
  }

  public snapshot(): DifficultyEvaluationCheckpointState {
    return checkpointSchema.parse(this.#state);
  }

  public openedExistingCheckpoint(): boolean {
    return this.#openedExisting;
  }

  public hasPublishedCompleteReport(): boolean {
    return this.#state.publishedReport !== undefined;
  }

  public pendingSampleIds(): string[] {
    return this.#state.entries
      .filter((entry) => entry.status === "pending")
      .map((entry) => entry.sampleId);
  }

  public succeededRows(): Array<DifficultyCheckpointRow & { readonly sampleId: string }> {
    return this.#state.entries.flatMap((entry) =>
      entry.status === "succeeded" ? [{ sampleId: entry.sampleId, ...entry.row }] : []
    );
  }

  public terminalFailures(): EvaluationFailure[] {
    return this.#state.entries.flatMap((entry): EvaluationFailure[] => {
      if (entry.status === "active") {
        return [{ sampleId: entry.sampleId, phase: "execution", code: "EVALUATION_ACTIVE_FROM_INTERRUPTED_RUN" }];
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

  public markActive(sampleId: string): void {
    this.replaceEntry(sampleId, (entry) => {
      if (entry.status !== "pending") {
        throw new Error("DIFFICULTY_CHECKPOINT_SAMPLE_NOT_PENDING");
      }
      return { sampleId, status: "active", startedAt: this.#now().toISOString() };
    });
  }

  public markSucceeded(sampleId: string, row: DifficultyCheckpointRow): void {
    const parsedRow = difficultyCheckpointRowSchema.parse(row);
    this.replaceEntry(sampleId, (entry) => {
      if (entry.status !== "active") {
        throw new Error("DIFFICULTY_CHECKPOINT_SAMPLE_NOT_ACTIVE");
      }
      return {
        sampleId,
        status: "succeeded",
        completedAt: this.#now().toISOString(),
        row: parsedRow
      };
    });
  }

  public markFailed(sampleId: string, failure: EvaluationFailure): void {
    this.replaceEntry(sampleId, (entry) => {
      if (entry.status !== "active" || failure.sampleId !== sampleId) {
        throw new Error("DIFFICULTY_CHECKPOINT_SAMPLE_NOT_ACTIVE");
      }
      return {
        sampleId,
        status: "failed",
        failedAt: this.#now().toISOString(),
        code: failure.code.replace(/[^A-Z0-9_]/g, "_").slice(0, 120) || "UNEXPECTED_ERROR",
        ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus })
      };
    });
  }

  public markCompleteReportPublished(
    executionRunId: string,
    completionFingerprint: string
  ): void {
    this.assertOpen();
    if (
      this.#state.publishedReport !== undefined ||
      this.#state.entries.some((entry) => entry.status !== "succeeded")
    ) {
      throw new Error("DIFFICULTY_CHECKPOINT_REPORT_NOT_PUBLISHABLE");
    }
    this.#state = checkpointSchema.parse({
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

  public close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.releaseResources();
    }
  }

  private replaceEntry(
    sampleId: string,
    replacement: (entry: CheckpointEntry) => CheckpointEntry
  ): void {
    this.assertOpen();
    const index = this.#state.entries.findIndex((entry) => entry.sampleId === sampleId);
    if (index < 0) {
      throw new Error("DIFFICULTY_CHECKPOINT_SAMPLE_UNKNOWN");
    }
    const entries = [...this.#state.entries];
    entries[index] = replacement(entries[index]!);
    this.#state = checkpointSchema.parse({
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
          // 不记录路径或状态内容。
        }
      }
      try {
        unlinkSync(temporaryPath);
      } catch {
        // 只清理本次唯一命名的临时文件。
      }
      throw new Error("DIFFICULTY_CHECKPOINT_WRITE_FAILED");
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
      // hard link 是原子的“不存在才创建”；旧锁存在时绝不替换或删除它。
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
          // 固定错误码，不记录路径。
        }
      }
      if (temporaryExists) {
        try {
          unlinkSync(temporaryPath);
        } catch {
          // 只清理本次 UUID 临时锁。
        }
      }
    }
  }

  private replaceLockRecord(): void {
    if (this.#lockDescriptor === undefined) {
      throw new Error("DIFFICULTY_CHECKPOINT_LOCK_NOT_HELD");
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
        throw new Error("DIFFICULTY_CHECKPOINT_LOCK_OWNERSHIP_LOST");
      }
      // 当前进程已经持有旧锁；rename 让读者只可能看到完整旧记录或完整新记录。
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
          // 固定错误码，不记录路径。
        }
      }
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // 固定错误码，不记录路径。
        }
      }
      if (temporaryExists) {
        try {
          unlinkSync(temporaryPath);
        } catch {
          // 只清理本次 UUID 临时锁。
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
        throw new Error("DIFFICULTY_CHECKPOINT_LOCK_WRITE_FAILED");
      }
      offset += written;
    }
    fsyncSync(descriptor);
  }

  private assertOpen(): void {
    if (this.#closed) {
      throw new Error("DIFFICULTY_CHECKPOINT_CLOSED");
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
        // 锁归属无法证明时宁可留下锁，禁止误删另一进程的新锁。
      }
      try {
        closeSync(this.#lockDescriptor);
      } catch {
        // 不记录路径。
      }
      this.#lockDescriptor = undefined;
    }
    closePrivateDirectory(this.#directory);
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Linux /proc stat 第 22 字段；与 PID 一起可排除 PID 复用后误判为旧进程。 */
function readCurrentProcessStartTimeTicks(): string {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) {
      throw new Error("invalid-proc-stat");
    }
    // 右括号后从第 3 字段 state 开始，starttime(22) 是数组下标 19。
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    return processStartTimeTicksSchema.parse(fields[19]);
  } catch {
    throw new Error("DIFFICULTY_CHECKPOINT_PROCESS_IDENTITY_UNAVAILABLE");
  }
}
