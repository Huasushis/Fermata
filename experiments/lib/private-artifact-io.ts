import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readdirSync,
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
import {
  failPhysicalBlind,
  PhysicalBlindArtifactError
} from "./physical-blind-common";

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
  const bytes = readPrivateArtifactBytes(directory, fileName, maximumBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    failPhysicalBlind("BLIND_ARTIFACT_FILE_INVALID_UTF8");
  }
}

/**
 * 读取受保护文件的原始字节快照。实验 manifest 用它绑定磁盘上的精确字节，
 * 不能先解码再重新编码，否则 UTF-8 BOM 等合法字节差异会被悄悄抹平。
 */
export function readPrivateArtifactBytes(
  directory: PrivateDirectoryHandle,
  fileName: string,
  maximumBytes = defaultMaximumArtifactBytes
): Buffer {
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
    return bytes;
  } catch (error) {
    mapPrivateArtifactReadError(error);
  } finally {
    if (descriptor !== undefined) {
      closeQuietly(descriptor);
    }
  }
  return failPhysicalBlind("BLIND_ARTIFACT_FILE_UNAVAILABLE");
}

/** dirfd 锚定的可选读取；只有确实不存在才返回 null，其它异常全部保留。 */
export function readPrivateArtifactBytesIfPresent(
  directory: PrivateDirectoryHandle,
  fileName: string,
  maximumBytes = defaultMaximumArtifactBytes
): Buffer | null {
  try {
    return readPrivateArtifactBytes(directory, fileName, maximumBytes);
  } catch (error) {
    if (
      error instanceof PhysicalBlindArtifactError &&
      error.code === "BLIND_ARTIFACT_FILE_MISSING"
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * 幂等发布私有文件：不存在则 O_EXCL 创建；存在时仅在权限严格且字节完全相同
 * 时成功。它用于报告崩溃恢复，绝不覆盖或接纳近似内容。
 */
export function ensurePrivateArtifactExact(
  directory: PrivateDirectoryHandle,
  fileName: string,
  text: string,
  maximumBytes = defaultMaximumArtifactBytes
): Buffer {
  const expected = Buffer.from(text, "utf8");
  if (expected.byteLength > maximumBytes) {
    failPhysicalBlind("BLIND_ARTIFACT_FILE_TOO_LARGE");
  }
  recoverPrivateArtifactExclusiveOrphan(directory, fileName, maximumBytes);
  const existing = readPrivateArtifactBytesIfPresent(
    directory,
    fileName,
    maximumBytes
  );
  if (existing !== null) {
    if (!existing.equals(expected)) {
      failPhysicalBlind("BLIND_ARTIFACT_EXISTING_BYTES_MISMATCH");
    }
    return existing;
  }
  try {
    writePrivateArtifactExclusive(directory, fileName, text);
  } catch (error) {
    // 并发发布者可能刚刚赢得 O_EXCL；只有其最终严格字节完全相同才接纳。
    if (
      !(error instanceof PhysicalBlindArtifactError) ||
      error.code !== "BLIND_ARTIFACT_ALREADY_EXISTS"
    ) {
      throw error;
    }
  }
  const written = readPrivateArtifactBytes(directory, fileName, maximumBytes);
  if (!written.equals(expected)) {
    failPhysicalBlind("BLIND_ARTIFACT_EXISTING_BYTES_MISMATCH");
  }
  return written;
}

/**
 * 先同步 0600 临时文件，再用 hard link 以“不存在才发布”的语义原子公开。
 * 目标已存在时固定失败，绝不会覆盖一份旧实验材料。
 */
export function writePrivateArtifactExclusive(
  directory: PrivateDirectoryHandle,
  fileName: string,
  text: string,
  hooks: { readonly afterTargetLink?: () => void } = {}
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
    if (hooks.afterTargetLink !== undefined) {
      // 测试钩子模拟进程在 link 成功、unlink 前直接消失；异常时故意留下
      // 同 inode 的内部临时链接，供下一次 exact resume 安全收养。
      temporaryExists = false;
      hooks.afterTargetLink();
      temporaryExists = true;
    }
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

/**
 * 收养 exclusive publish 在 link→unlink 崩溃窗留下的同目录临时硬链接。
 * 只会删除名称符合本模块随机格式、且与目标 dev/ino 完全相同的唯一内部链接。
 */
export function recoverPrivateArtifactExclusiveOrphan(
  directory: PrivateDirectoryHandle,
  fileName: string,
  maximumBytes = defaultMaximumArtifactBytes
): boolean {
  const target = anchoredPrivatePath(directory, fileName);
  let targetDescriptor: number | undefined;
  try {
    try {
      targetDescriptor = openSync(
        target,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
      );
    } catch (error) {
      if (hasSystemCode(error, "ENOENT")) return false;
      throw error;
    }
    const targetStatus = fstatSync(targetDescriptor, { bigint: true });
    assertArtifactBaseStatus(targetStatus, maximumBytes);
    if (targetStatus.nlink === 1n) return false;
    if (targetStatus.nlink !== 2n) {
      failPhysicalBlind("BLIND_ARTIFACT_FILE_LINK_INVALID");
    }
    const candidates: string[] = [];
    for (const entry of readdirSync(`/proc/self/fd/${directory.descriptor}`, {
      withFileTypes: true
    })) {
      if (
        !entry.isFile() ||
        !/^\.blind-[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u
          .test(entry.name)
      ) {
        continue;
      }
      let candidateDescriptor: number | undefined;
      try {
        candidateDescriptor = openSync(
          anchoredPrivatePath(directory, entry.name),
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
        );
        const candidateStatus = fstatSync(candidateDescriptor, { bigint: true });
        if (
          candidateStatus.dev === targetStatus.dev &&
          candidateStatus.ino === targetStatus.ino
        ) {
          candidates.push(entry.name);
        }
      } catch (error) {
        if (!hasSystemCode(error, "ENOENT")) throw error;
      } finally {
        if (candidateDescriptor !== undefined) closeQuietly(candidateDescriptor);
      }
    }
    if (candidates.length !== 1) {
      failPhysicalBlind("BLIND_ARTIFACT_FILE_LINK_INVALID");
    }
    try {
      unlinkSync(anchoredPrivatePath(directory, candidates[0]!));
    } catch (error) {
      if (!hasSystemCode(error, "ENOENT")) throw error;
    }
    fsyncSync(directory.descriptor);
    const recovered = fstatSync(targetDescriptor, { bigint: true });
    assertReadableArtifactStatus(recovered, maximumBytes);
    if (
      recovered.dev !== targetStatus.dev ||
      recovered.ino !== targetStatus.ino ||
      recovered.size !== targetStatus.size ||
      recovered.mtimeNs !== targetStatus.mtimeNs
    ) {
      failPhysicalBlind("BLIND_ARTIFACT_FILE_CHANGED_DURING_READ");
    }
    return true;
  } catch (error) {
    mapPrivateArtifactReadError(error);
  } finally {
    if (targetDescriptor !== undefined) closeQuietly(targetDescriptor);
  }
  return false;
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
  assertArtifactBaseStatus(status, maximumBytes);
  if (status.nlink !== 1n) {
    failPhysicalBlind("BLIND_ARTIFACT_FILE_LINK_INVALID");
  }
}

function assertArtifactBaseStatus(
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
