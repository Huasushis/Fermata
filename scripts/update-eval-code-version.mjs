#!/usr/bin/env node
/**
 * 把一个受保护 env 文件里既有的 EVAL_CODE_VERSION 原子更新为当前干净 HEAD。
 *
 * 不接受要写入的值，不经过 shell，不输出文件内容、路径、旧值或新值。除目标键
 * 所在行外保留原始字节；目标文件和临时文件都必须/固定为当前用户的 0600 普通文件。
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import {
  assertSafeNodeEnvironment,
  parseEnvFile
} from "./env-file.mjs";
import {
  anchoredPrivatePath,
  isInside,
  projectPrivateRoot,
  readProtectedEnvFile,
  repositoryRoot,
  workspaceRoot
} from "./private-runtime.mjs";
import {
  assertSafeCallerGitEnvironment,
  withTrustedGitSnapshot
} from "./trusted-git-state.mjs";

const usage =
  "用法：node scripts/update-eval-code-version.mjs " +
  "--environment-file=<Fermata/private 内 env 文件绝对路径>\n";
const codeVersionPattern = /^[0-9a-f]{40}$/u;
const maximumEnvBytes = 1024 * 1024;
const parentDirectoryFlags =
  constants.O_RDONLY |
  constants.O_DIRECTORY |
  (constants.O_NOFOLLOW ?? 0);
const protectedFileReadFlags =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const protectedFileWriteFlags =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  (constants.O_NOFOLLOW ?? 0);

function failUpdate() {
  throw new Error("EVAL_CODE_VERSION_UPDATE_FAILED");
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertOwnedMode(status, expectedType, expectedMode) {
  if (!expectedType(status) || (status.mode & 0o777n) !== expectedMode) {
    failUpdate();
  }
  if (
    typeof process.getuid === "function" &&
    status.uid !== BigInt(process.getuid())
  ) {
    failUpdate();
  }
}

function readStableEnvDescriptor(descriptor) {
  const before = fstatSync(descriptor, { bigint: true });
  assertOwnedMode(before, (status) => status.isFile(), 0o600n);
  if (before.size > BigInt(maximumEnvBytes)) {
    failUpdate();
  }
  const chunks = [];
  let totalBytes = 0;
  while (totalBytes <= maximumEnvBytes) {
    const maximumNextBytes = Math.min(
      64 * 1024,
      maximumEnvBytes + 1 - totalBytes
    );
    if (maximumNextBytes <= 0) break;
    const chunk = Buffer.allocUnsafe(maximumNextBytes);
    const bytesRead = readSync(
      descriptor,
      chunk,
      0,
      maximumNextBytes,
      null
    );
    if (bytesRead === 0) break;
    totalBytes += bytesRead;
    chunks.push(chunk.subarray(0, bytesRead));
  }
  if (totalBytes > maximumEnvBytes) failUpdate();
  const bytes = Buffer.concat(chunks, totalBytes);
  const after = fstatSync(descriptor, { bigint: true });
  if (
    bytes.byteLength !== Number(before.size) ||
    !sameFileSnapshot(before, after)
  ) {
    failUpdate();
  }
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    failUpdate();
  }
  return { bytes, content, snapshot: after };
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(
      descriptor,
      bytes,
      offset,
      bytes.byteLength - offset,
      offset
    );
    if (written <= 0) failUpdate();
    offset += written;
  }
}

export function replaceEvalCodeVersionLine(content, codeVersion) {
  if (
    typeof content !== "string" ||
    !codeVersionPattern.test(codeVersion) ||
    /\r(?!\n)/u.test(content)
  ) {
    failUpdate();
  }
  let parsed;
  try {
    parsed = parseEnvFile(content);
  } catch {
    failUpdate();
  }
  if (
    !Object.hasOwn(parsed, "EVAL_CODE_VERSION") ||
    !codeVersionPattern.test(parsed.EVAL_CODE_VERSION)
  ) {
    failUpdate();
  }

  const pieces = content.split(/(\r?\n)/u);
  let replacements = 0;
  for (let index = 0; index < pieces.length; index += 2) {
    const line = pieces[index];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (
      separatorIndex > 0 &&
      trimmed.slice(0, separatorIndex).trim() === "EVAL_CODE_VERSION"
    ) {
      pieces[index] = `EVAL_CODE_VERSION=${codeVersion}`;
      replacements += 1;
    }
  }
  if (replacements !== 1) failUpdate();
  const updated = pieces.join("");
  return { content: updated, changed: updated !== content };
}

export function assertCleanUpdateRepositoryState(input) {
  if (
    !codeVersionPattern.test(input.headCodeVersion) ||
    input.porcelain !== "" ||
    input.trackedPrivatePaths !== "" ||
    input.privatePathIgnored !== true ||
    (input.expectedHeadCodeVersion !== undefined &&
      input.expectedHeadCodeVersion !== input.headCodeVersion)
  ) {
    failUpdate();
  }
  return input.headCodeVersion;
}

function openVerifiedParentDirectory(envFile, privateRoot, containingWorkspace) {
  const parentPath = resolve(dirname(envFile));
  const resolvedPrivateRoot = resolve(privateRoot);
  const resolvedWorkspace = resolve(containingWorkspace);
  if (
    !isInside(resolvedPrivateRoot, parentPath) ||
    !isInside(resolvedWorkspace, parentPath, { allowSame: false })
  ) {
    failUpdate();
  }
  let descriptor;
  try {
    descriptor = openSync(parentPath, parentDirectoryFlags);
    const status = fstatSync(descriptor, { bigint: true });
    assertOwnedMode(status, (candidate) => candidate.isDirectory(), 0o700n);
    if (realpathSync(`/proc/self/fd/${descriptor}`) !== parentPath) {
      failUpdate();
    }
    return descriptor;
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 只关闭本次打开的目录描述符。
      }
    }
    failUpdate();
  }
}

function readAnchoredTarget(parentDescriptor, fileName) {
  let descriptor;
  try {
    descriptor = openSync(
      anchoredPrivatePath({ descriptor: parentDescriptor }, fileName),
      protectedFileReadFlags
    );
    return readStableEnvDescriptor(descriptor);
  } catch {
    failUpdate();
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        failUpdate();
      }
    }
  }
}

export function updateEvalCodeVersionFile(
  envFile,
  codeVersion,
  {
    privateRoot = projectPrivateRoot,
    containingWorkspace = workspaceRoot,
    validateBeforeAtomicReplace = () => {}
  } = {}
) {
  if (!isAbsolute(envFile) || !codeVersionPattern.test(codeVersion)) {
    failUpdate();
  }
  const resolvedEnvFile = resolve(envFile);
  let protectedContent;
  try {
    protectedContent = readProtectedEnvFile(resolvedEnvFile, {
      privateRoot,
      containingWorkspace,
      maximumBytes: maximumEnvBytes
    });
  } catch {
    failUpdate();
  }
  const replacement = replaceEvalCodeVersionLine(protectedContent, codeVersion);
  const parentDescriptor = openVerifiedParentDirectory(
    resolvedEnvFile,
    privateRoot,
    containingWorkspace
  );
  const fileName = basename(resolvedEnvFile);
  const temporaryFileName =
    `.${fileName}.eval-code-version-${randomBytes(12).toString("hex")}.tmp`;
  const temporaryPath = anchoredPrivatePath(
    { descriptor: parentDescriptor },
    temporaryFileName
  );
  const targetPath = anchoredPrivatePath({ descriptor: parentDescriptor }, fileName);
  let temporaryDescriptor;
  let temporaryExists = false;
  let committed = false;
  try {
    const initial = readAnchoredTarget(parentDescriptor, fileName);
    if (initial.content !== protectedContent) failUpdate();
    if (!replacement.changed) {
      validateBeforeAtomicReplace();
      const current = readAnchoredTarget(parentDescriptor, fileName);
      if (
        !sameFileSnapshot(initial.snapshot, current.snapshot) ||
        !initial.bytes.equals(current.bytes)
      ) {
        failUpdate();
      }
      return false;
    }

    temporaryDescriptor = openSync(temporaryPath, protectedFileWriteFlags, 0o600);
    temporaryExists = true;
    fchmodSync(temporaryDescriptor, 0o600);
    const replacementBytes = Buffer.from(replacement.content, "utf8");
    if (replacementBytes.byteLength > maximumEnvBytes) failUpdate();
    writeAll(temporaryDescriptor, replacementBytes);
    fsyncSync(temporaryDescriptor);
    closeSync(temporaryDescriptor);
    temporaryDescriptor = undefined;

    validateBeforeAtomicReplace();
    const current = readAnchoredTarget(parentDescriptor, fileName);
    if (
      !sameFileSnapshot(initial.snapshot, current.snapshot) ||
      !initial.bytes.equals(current.bytes)
    ) {
      failUpdate();
    }
    renameSync(temporaryPath, targetPath);
    temporaryExists = false;
    committed = true;
    fsyncSync(parentDescriptor);
    return true;
  } catch {
    failUpdate();
  } finally {
    if (temporaryDescriptor !== undefined) {
      try {
        closeSync(temporaryDescriptor);
      } catch {
        // 后续仍尝试删除唯一临时文件。
      }
    }
    if (temporaryExists && !committed) {
      try {
        unlinkSync(temporaryPath);
        fsyncSync(parentDescriptor);
      } catch {
        // 临时文件仍是 0600 且只位于已验证私有目录；不输出底层路径。
      }
    }
    try {
      closeSync(parentDescriptor);
    } catch {
      // 替换结果已经由 rename + fsync 边界决定，对外不泄露底层错误。
    }
  }
}

export function parseUpdateArguments(argv) {
  if (
    argv.length !== 1 ||
    !argv[0].startsWith("--environment-file=")
  ) {
    throw new Error("UPDATE_EVAL_CODE_VERSION_INVALID_ARGUMENTS");
  }
  const value = argv[0].slice("--environment-file=".length);
  if (value === "" || !isAbsolute(value)) {
    throw new Error("UPDATE_EVAL_CODE_VERSION_INVALID_ARGUMENTS");
  }
  return resolve(value);
}

export function readCleanRepositoryHead(expectedHeadCodeVersion) {
  try {
    return withTrustedGitSnapshot(repositoryRoot, (git) => {
      const porcelain = git.run(
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { encoding: "utf8" }
      );
      const trackedPrivatePaths = git.run(
        ["ls-files", "private"],
        { encoding: "utf8" }
      );
      let privatePathIgnored = false;
      try {
        git.run(
          ["check-ignore", "-q", "private/.eval-code-version-ignore-check"]
        );
        privatePathIgnored = true;
      } catch {
        privatePathIgnored = false;
      }
      const porcelainAfterChecks = git.run(
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { encoding: "utf8" }
      );
      if (porcelainAfterChecks !== porcelain) failUpdate();
      return assertCleanUpdateRepositoryState({
        headCodeVersion: git.headCodeVersion,
        porcelain,
        trackedPrivatePaths,
        privatePathIgnored,
        expectedHeadCodeVersion
      });
    });
  } catch {
    failUpdate();
  }
}

export function runEvalCodeVersionUpdate(
  argv,
  {
    parentEnvironment = process.env,
    readRepositoryHead = readCleanRepositoryHead,
    updateFile = updateEvalCodeVersionFile
  } = {}
) {
  // 在解析目标路径、更不能在读取 env 之前拒绝 Node/Git 注入环境。
  assertSafeNodeEnvironment(parentEnvironment);
  assertSafeCallerGitEnvironment(parentEnvironment);
  const envFile = parseUpdateArguments(argv);
  const codeVersion = readRepositoryHead();
  return updateFile(envFile, codeVersion, {
    validateBeforeAtomicReplace: () => {
      readRepositoryHead(codeVersion);
    }
  });
}

function isDirectEntry() {
  if (process.argv[1] === undefined) return false;
  try {
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  try {
    runEvalCodeVersionUpdate(process.argv.slice(2));
    process.stdout.write("EVAL_CODE_VERSION_READY\n");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "UPDATE_EVAL_CODE_VERSION_INVALID_ARGUMENTS"
    ) {
      process.stderr.write(usage);
      process.exitCode = 2;
    } else {
      process.stderr.write("无法安全更新 EVAL_CODE_VERSION。\n");
      process.exitCode = 1;
    }
  }
}
