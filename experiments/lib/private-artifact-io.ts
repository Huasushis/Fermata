import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
  type BigIntStats
} from "node:fs";
import { TextDecoder } from "node:util";
import {
  anchoredPrivatePath,
  type PrivateDirectoryHandle
} from "../../scripts/private-runtime.mjs";
import { failPhysicalBlind } from "./physical-blind-common";

const defaultMaximumArtifactBytes = 16 * 1024 * 1024;

export interface PrivateArtifactSnapshotDescriptor {
  readonly descriptor: number;
  readonly before: BigIntStats;
}

/** 为受限子进程保留已验证 inode；调用方必须在子进程结束后核对并关闭。 */
export function openPrivateArtifactSnapshotDescriptor(
  directory: PrivateDirectoryHandle,
  fileName: string,
  maximumBytes = defaultMaximumArtifactBytes
): PrivateArtifactSnapshotDescriptor {
  const target = anchoredPrivatePath(directory, fileName);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    );
    const before = fstatSync(descriptor, { bigint: true });
    assertReadableArtifactStatus(before, maximumBytes);
    return { descriptor, before };
  } catch (error) {
    if (descriptor !== undefined) {
      closeQuietly(descriptor);
    }
    mapPrivateArtifactReadError(error);
  }
}

export function verifyAndClosePrivateArtifactSnapshotDescriptor(
  snapshot: PrivateArtifactSnapshotDescriptor
): void {
  try {
    const after = fstatSync(snapshot.descriptor, { bigint: true });
    if (!sameSnapshot(snapshot.before, after)) {
      failPhysicalBlind("BLIND_ARTIFACT_FILE_CHANGED_DURING_READ");
    }
  } finally {
    closeQuietly(snapshot.descriptor);
  }
}

export function readPrivateArtifactText(
  directory: PrivateDirectoryHandle,
  fileName: string,
  maximumBytes = defaultMaximumArtifactBytes
): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    failPhysicalBlind("BLIND_ARTIFACT_SIZE_LIMIT_INVALID");
  }
  const target = anchoredPrivatePath(directory, fileName);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    );
    const before = fstatSync(descriptor, { bigint: true });
    assertReadableArtifactStatus(before, maximumBytes);
    const bytes = readBounded(descriptor, maximumBytes);
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameSnapshot(before, after)) {
      failPhysicalBlind("BLIND_ARTIFACT_FILE_CHANGED_DURING_READ");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      failPhysicalBlind("BLIND_ARTIFACT_FILE_INVALID_UTF8");
    }
  } catch (error) {
    mapPrivateArtifactReadError(error);
  } finally {
    if (descriptor !== undefined) {
      closeQuietly(descriptor);
    }
  }
  return failPhysicalBlind("BLIND_ARTIFACT_FILE_UNAVAILABLE");
}

/**
 * 先同步 0600 临时文件，再用 hard link 以“不存在才发布”的语义原子公开。
 * 目标已存在时固定失败，绝不会覆盖一份旧实验材料。
 */
export function writePrivateArtifactExclusive(
  directory: PrivateDirectoryHandle,
  fileName: string,
  text: string
): void {
  const target = anchoredPrivatePath(directory, fileName);
  const temporaryName = `.blind-${process.pid}-${randomUUID()}.tmp`;
  const temporary = anchoredPrivatePath(directory, temporaryName);
  let descriptor: number | undefined;
  let temporaryExists = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    temporaryExists = true;
    fchmodSync(descriptor, 0o600);
    const bytes = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        offset
      );
      if (written <= 0) {
        failPhysicalBlind("BLIND_ARTIFACT_FILE_WRITE_FAILED");
      }
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    linkSync(temporary, target);
    unlinkSync(temporary);
    temporaryExists = false;
    fsyncSync(directory.descriptor);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.startsWith("BLIND_")
    ) {
      throw error;
    }
    if (hasSystemCode(error, "EEXIST")) {
      failPhysicalBlind("BLIND_ARTIFACT_ALREADY_EXISTS");
    }
    if (hasSystemCode(error, "ELOOP")) {
      failPhysicalBlind("BLIND_ARTIFACT_SYMBOLIC_LINK");
    }
    failPhysicalBlind("BLIND_ARTIFACT_FILE_WRITE_FAILED");
  } finally {
    if (descriptor !== undefined) {
      closeQuietly(descriptor);
    }
    if (temporaryExists) {
      try {
        unlinkSync(temporary);
      } catch {
        // 只清理本次随机创建的临时文件。
      }
    }
  }
}

function readBounded(descriptor: number, maximumBytes: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maximumBytes) {
    const length = Math.min(64 * 1024, maximumBytes + 1 - total);
    if (length <= 0) {
      break;
    }
    const chunk = Buffer.allocUnsafe(length);
    const count = readSync(descriptor, chunk, 0, length, null);
    if (count === 0) {
      break;
    }
    total += count;
    chunks.push(chunk.subarray(0, count));
  }
  if (total > maximumBytes) {
    failPhysicalBlind("BLIND_ARTIFACT_FILE_TOO_LARGE");
  }
  return Buffer.concat(chunks, total);
}

function sameSnapshot(
  left: BigIntStats,
  right: BigIntStats
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertReadableArtifactStatus(
  status: BigIntStats,
  maximumBytes: number
): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    failPhysicalBlind("BLIND_ARTIFACT_SIZE_LIMIT_INVALID");
  }
  if (!status.isFile()) {
    failPhysicalBlind("BLIND_ARTIFACT_FILE_TYPE_INVALID");
  }
  if ((status.mode & 0o777n) !== 0o600n) {
    failPhysicalBlind("BLIND_ARTIFACT_FILE_MODE_INVALID");
  }
  if (
    typeof process.getuid === "function" &&
    status.uid !== BigInt(process.getuid())
  ) {
    failPhysicalBlind("BLIND_ARTIFACT_FILE_OWNER_INVALID");
  }
  if (status.nlink !== 1n) {
    failPhysicalBlind("BLIND_ARTIFACT_FILE_LINK_INVALID");
  }
  if (status.size > BigInt(maximumBytes)) {
    failPhysicalBlind("BLIND_ARTIFACT_FILE_TOO_LARGE");
  }
}

function mapPrivateArtifactReadError(error: unknown): never {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("BLIND_")
  ) {
    throw error;
  }
  if (hasSystemCode(error, "ENOENT")) {
    failPhysicalBlind("BLIND_ARTIFACT_FILE_MISSING");
  }
  if (hasSystemCode(error, "ELOOP")) {
    failPhysicalBlind("BLIND_ARTIFACT_SYMBOLIC_LINK");
  }
  failPhysicalBlind("BLIND_ARTIFACT_FILE_UNAVAILABLE");
}

function hasSystemCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function closeQuietly(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // 固定错误码，不输出路径或内容。
  }
}
