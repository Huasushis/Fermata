/**
 * 正式 difficulty 锚点目标的全局发布锁。
 *
 * 锁名故意与实验标签无关，并从第一笔付费调用前持有到发布审计完成。
 * 任何既有锁（包括崩溃遗留锁）都 fail-closed；本模块绝不猜测或自动删除它。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  anchoredPrivatePath,
  closePrivateDirectory,
  preparePrivateDirectory,
  projectPrivateRoot,
  workspaceRoot,
  type PrivateDirectoryHandle
} from "../../scripts/private-runtime.mjs";

const LOCK_DIRECTORY_NAME = "anchor-publication";
const LOCK_FILE_NAME = "difficulty-anchors-publication.lock.private";
const MAXIMUM_COMMAND_BYTES = 64 * 1024;
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const runIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const processStartTimeTicksSchema = z.string().regex(/^[1-9][0-9]*$/);

export const anchorPublicationLockRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    processId: z.number().int().positive(),
    processStartTimeTicks: processStartTimeTicksSchema,
    runId: runIdSchema,
    targetFingerprint: digestSchema,
    acquiredAt: z.string().datetime(),
    expectedCommandKind: z.literal("FERMATA_CALIBRATE_ANCHORS"),
    expectedWorkingDirectoryFingerprint: digestSchema,
    processCommandFingerprint: digestSchema,
    recoveryRule: z.literal(
      "VERIFY_PID_START_TIME_FULL_COMMAND_AND_CWD_BEFORE_MANUAL_REMOVAL"
    )
  })
  .strict();
export type AnchorPublicationLockRecord = z.infer<
  typeof anchorPublicationLockRecordSchema
>;

export interface AnchorPublicationLock {
  readonly record: AnchorPublicationLockRecord;
  /** 锁被人工删除或替换时立即失败，禁止继续发布。 */
  readonly assertHeld: () => void;
  /** 返回 false 表示不能证明锁已由本进程安全释放，调用方必须失败退出。 */
  readonly release: () => boolean;
}

export interface AcquireAnchorPublicationLockOptions {
  readonly runId: string;
  readonly targetFingerprint: string;
  readonly privateRoot?: string;
  readonly containingWorkspace?: string;
  readonly now?: () => Date;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Linux /proc stat 第 22 字段；从最后一个右括号后解析，兼容进程名中的空格。 */
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
    throw new Error("ANCHOR_PUBLICATION_PROCESS_IDENTITY_UNAVAILABLE");
  }
}

function readProcessCommandFingerprint(): string {
  try {
    const command = readFileSync("/proc/self/cmdline");
    if (command.byteLength < 1 || command.byteLength > MAXIMUM_COMMAND_BYTES) {
      throw new Error("invalid-command-size");
    }
    return sha256(command);
  } catch {
    throw new Error("ANCHOR_PUBLICATION_PROCESS_IDENTITY_UNAVAILABLE");
  }
}

function readWorkingDirectoryFingerprint(): string {
  try {
    return sha256(realpathSync(process.cwd()));
  } catch {
    throw new Error("ANCHOR_PUBLICATION_PROCESS_IDENTITY_UNAVAILABLE");
  }
}

function writeCompleteDocument(descriptor: number, record: AnchorPublicationLockRecord): void {
  const document = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
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
      throw new Error("ANCHOR_PUBLICATION_LOCK_SHORT_WRITE");
    }
    offset += written;
  }
  fsyncSync(descriptor);
}

function ownsLinkedLock(
  directory: PrivateDirectoryHandle,
  descriptor: number
): boolean {
  try {
    const held = fstatSync(descriptor, { bigint: true });
    const linked = lstatSync(
      anchoredPrivatePath(directory, LOCK_FILE_NAME),
      { bigint: true }
    );
    return (
      held.isFile() &&
      linked.isFile() &&
      held.dev === linked.dev &&
      held.ino === linked.ino
    );
  } catch {
    return false;
  }
}

export function acquireAnchorPublicationLock(
  options: AcquireAnchorPublicationLockOptions
): AnchorPublicationLock {
  const privateRoot = options.privateRoot ?? projectPrivateRoot;
  const containingWorkspace = options.containingWorkspace ?? workspaceRoot;
  let directory: PrivateDirectoryHandle | undefined;
  let descriptor: number | undefined;
  let temporaryPath: string | undefined;
  let temporaryExists = false;
  let fixedLockLinked = false;

  try {
    const record = anchorPublicationLockRecordSchema.parse({
      schemaVersion: 1,
      processId: process.pid,
      processStartTimeTicks: readCurrentProcessStartTimeTicks(),
      runId: options.runId,
      targetFingerprint: options.targetFingerprint,
      acquiredAt: (options.now ?? (() => new Date()))().toISOString(),
      expectedCommandKind: "FERMATA_CALIBRATE_ANCHORS",
      expectedWorkingDirectoryFingerprint: readWorkingDirectoryFingerprint(),
      processCommandFingerprint: readProcessCommandFingerprint(),
      recoveryRule: "VERIFY_PID_START_TIME_FULL_COMMAND_AND_CWD_BEFORE_MANUAL_REMOVAL"
    });
    directory = preparePrivateDirectory(join(privateRoot, LOCK_DIRECTORY_NAME), {
      privateRoot,
      containingWorkspace
    });
    const temporaryName = `${LOCK_FILE_NAME}.tmp-${process.pid}-${randomUUID()}`;
    temporaryPath = anchoredPrivatePath(directory, temporaryName);
    const lockPath = anchoredPrivatePath(directory, LOCK_FILE_NAME);
    descriptor = openSync(
      temporaryPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    temporaryExists = true;
    fchmodSync(descriptor, 0o600);
    writeCompleteDocument(descriptor, record);

    // hard link 是原子的“不存在才建立”；任意旧锁存在时都不替换、不删除。
    linkSync(temporaryPath, lockPath);
    fixedLockLinked = true;
    unlinkSync(temporaryPath);
    temporaryExists = false;
    fsyncSync(directory.descriptor);

    const heldDirectory = directory;
    const heldDescriptor = descriptor;
    directory = undefined;
    descriptor = undefined;
    let releaseResult: boolean | undefined;
    let released = false;
    return {
      record,
      assertHeld: () => {
        if (released || !ownsLinkedLock(heldDirectory, heldDescriptor)) {
          throw new Error("ANCHOR_PUBLICATION_LOCK_OWNERSHIP_LOST");
        }
      },
      release: () => {
        if (releaseResult !== undefined) {
          return releaseResult;
        }
        released = true;
        let succeeded = true;
        if (!ownsLinkedLock(heldDirectory, heldDescriptor)) {
          succeeded = false;
        } else {
          try {
            unlinkSync(anchoredPrivatePath(heldDirectory, LOCK_FILE_NAME));
            fsyncSync(heldDirectory.descriptor);
          } catch {
            succeeded = false;
          }
        }
        try {
          closeSync(heldDescriptor);
        } catch {
          succeeded = false;
        }
        closePrivateDirectory(heldDirectory);
        releaseResult = succeeded;
        return releaseResult;
      }
    };
  } catch {
    // 只有 link 已由本次调用成功建立，且 inode 仍与本次 fd 相同，才清理固定锁。
    if (
      fixedLockLinked &&
      directory !== undefined &&
      descriptor !== undefined &&
      ownsLinkedLock(directory, descriptor)
    ) {
      try {
        unlinkSync(anchoredPrivatePath(directory, LOCK_FILE_NAME));
        fsyncSync(directory.descriptor);
      } catch {
        // 无法证明清理成功时保留遗留锁，后续运行继续 fail-closed。
      }
    }
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 固定错误码，不输出路径。
      }
    }
    if (temporaryExists && temporaryPath !== undefined) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // 只清理本次 UUID 临时锁。
      }
    }
    if (directory !== undefined) {
      closePrivateDirectory(directory);
    }
    throw new Error("ANCHOR_PUBLICATION_LOCKED_OR_UNAVAILABLE");
  }
}
