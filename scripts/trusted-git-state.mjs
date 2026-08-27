/**
 * 只读 Git 状态检查的固定执行边界。
 *
 * 正式仓库只提供经过校验的 HEAD、对象目录、工作树和正式索引的逻辑条目。
 * 状态检查使用的临时索引由受控 Git read-tree 重新生成，不继承正式索引的
 * stat/fsmonitor cache；正式索引只复制成另一份 0400 source-index，供 write-tree
 * 重建 staged tree 及只读 flags 查询。Git 进程看到的是本工具新建的 0700 临时
 * 元数据目录，因此不会读取正式仓库的 local config、include、info/attributes
 * 或其它可执行配置。
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

export const trustedGitExecutable = "/usr/bin/git";
const directoryFlags =
  constants.O_RDONLY |
  constants.O_DIRECTORY |
  (constants.O_NOFOLLOW ?? 0);
const fileFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const exclusiveFileFlags =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  (constants.O_NOFOLLOW ?? 0);
const maximumHeadBytes = 4 * 1024;
const maximumPackedRefsBytes = 8 * 1024 * 1024;
const maximumIndexBytes = 64 * 1024 * 1024;
const commitPattern = /^[0-9a-f]{40}$/u;
const symbolicHeadPattern =
  /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,500}$/u;
const temporaryPrefix = "fermata-trusted-git-";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function failTrustedGit() {
  throw new Error("TRUSTED_GIT_STATE_UNAVAILABLE");
}

function closeQuietly(descriptor) {
  try {
    closeSync(descriptor);
    return true;
  } catch {
    return false;
  }
}

function currentUserId() {
  return typeof process.getuid === "function"
    ? BigInt(process.getuid())
    : undefined;
}

function assertCurrentUserOwned(status, expectedType) {
  const userId = currentUserId();
  if (
    !expectedType(status) ||
    (userId !== undefined && status.uid !== userId)
  ) {
    failTrustedGit();
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableSnapshot(left, right) {
  return (
    sameIdentity(left, right) &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertTrustedSystemStatus(
  status,
  expectedType,
  requireExecutable,
  expectedOwner
) {
  const currentUserIsRoot =
    typeof process.getuid === "function" && process.getuid() === 0;
  if (
    !expectedType(status) ||
    (expectedOwner !== undefined && status.uid !== expectedOwner) ||
    (!currentUserIsRoot &&
      typeof process.getuid === "function" &&
      status.uid === BigInt(process.getuid())) ||
    (status.mode & 0o022n) !== 0n ||
    (requireExecutable && (status.mode & 0o111n) === 0n)
  ) {
    failTrustedGit();
  }
  return status.uid;
}

export function verifyTrustedGitExecutable() {
  const opened = [];
  let systemOwner;
  try {
    for (const expectedPath of ["/", "/usr", "/usr/bin"]) {
      const descriptor = openSync(expectedPath, directoryFlags);
      opened.push(descriptor);
      const status = fstatSync(descriptor, { bigint: true });
      systemOwner = assertTrustedSystemStatus(
        status,
        (candidate) => candidate.isDirectory(),
        false,
        systemOwner
      );
      if (realpathSync(`/proc/self/fd/${descriptor}`) !== expectedPath) {
        failTrustedGit();
      }
    }
    const descriptor = openSync(trustedGitExecutable, fileFlags);
    opened.push(descriptor);
    const status = fstatSync(descriptor, { bigint: true });
    assertTrustedSystemStatus(
      status,
      (candidate) => candidate.isFile(),
      true,
      systemOwner
    );
    if (realpathSync(`/proc/self/fd/${descriptor}`) !== trustedGitExecutable) {
      failTrustedGit();
    }
  } catch {
    failTrustedGit();
  } finally {
    for (const descriptor of opened.reverse()) {
      try {
        closeSync(descriptor);
      } catch {
        // 对外只返回固定错误码。
      }
    }
  }
}

function openOwnedDirectory(path, expectedRealPath, { allowMissing = false } = {}) {
  let descriptor;
  try {
    descriptor = openSync(path, directoryFlags);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return undefined;
    failTrustedGit();
  }
  try {
    const status = fstatSync(descriptor, { bigint: true });
    assertCurrentUserOwned(status, (candidate) => candidate.isDirectory());
    if (realpathSync(`/proc/self/fd/${descriptor}`) !== expectedRealPath) {
      failTrustedGit();
    }
    return { descriptor, status };
  } catch {
    closeQuietly(descriptor);
    failTrustedGit();
  }
}

function openOwnedDirectoryAt(
  parentDescriptor,
  name,
  expectedRealPath,
  options
) {
  if (!/^[A-Za-z0-9._-]+$/u.test(name)) failTrustedGit();
  return openOwnedDirectory(
    `/proc/self/fd/${parentDescriptor}/${name}`,
    expectedRealPath,
    options
  );
}

function openOwnedFileAt(
  parentDescriptor,
  name,
  maximumBytes,
  { allowMissing = false } = {}
) {
  if (!/^[A-Za-z0-9._-]+$/u.test(name)) failTrustedGit();
  let descriptor;
  try {
    descriptor = openSync(
      `/proc/self/fd/${parentDescriptor}/${name}`,
      fileFlags
    );
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return undefined;
    failTrustedGit();
  }
  try {
    const status = fstatSync(descriptor, { bigint: true });
    assertCurrentUserOwned(status, (candidate) => candidate.isFile());
    if (status.size < 0n || status.size > BigInt(maximumBytes)) {
      failTrustedGit();
    }
    return readStableBoundFile(descriptor, status, maximumBytes);
  } catch {
    closeQuietly(descriptor);
    failTrustedGit();
  }
}

function readDescriptorBytes(descriptor, size) {
  const byteLength = Number(size);
  const bytes = Buffer.allocUnsafe(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const bytesRead = readSync(
      descriptor,
      bytes,
      offset,
      byteLength - offset,
      offset
    );
    if (bytesRead <= 0) failTrustedGit();
    offset += bytesRead;
  }
  return bytes;
}

function readStableBoundFile(descriptor, initialStatus, maximumBytes) {
  if (
    initialStatus.size < 0n ||
    initialStatus.size > BigInt(maximumBytes)
  ) {
    failTrustedGit();
  }
  const bytes = readDescriptorBytes(descriptor, initialStatus.size);
  const status = fstatSync(descriptor, { bigint: true });
  if (!sameStableSnapshot(initialStatus, status)) failTrustedGit();
  return { descriptor, status, bytes, maximumBytes };
}

function decodeUtf8(bytes) {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    failTrustedGit();
  }
}

function parseHead(content) {
  const normalized = content.endsWith("\n")
    ? content.slice(0, -1)
    : content;
  if (normalized.includes("\n") || normalized.includes("\r")) {
    failTrustedGit();
  }
  if (commitPattern.test(normalized)) {
    return { codeVersion: normalized, symbolicRef: undefined };
  }
  if (!normalized.startsWith("ref: ")) failTrustedGit();
  const symbolicRef = normalized.slice("ref: ".length);
  if (
    !symbolicHeadPattern.test(symbolicRef) ||
    symbolicRef.includes("..") ||
    symbolicRef.includes("//") ||
    symbolicRef.includes("@{") ||
    symbolicRef.split("/").some(
      (component) =>
        component.startsWith(".") ||
        component.endsWith(".") ||
        component.endsWith(".lock")
    )
  ) {
    failTrustedGit();
  }
  return { codeVersion: undefined, symbolicRef };
}

function openNestedRef(
  gitDirectoryDescriptor,
  symbolicRef,
  { allowMissing = false } = {}
) {
  const components = symbolicRef.split("/");
  let parentDescriptor = gitDirectoryDescriptor;
  const openedDirectories = [];
  try {
    for (const component of components.slice(0, -1)) {
      const opened = openOwnedDirectoryAt(
        parentDescriptor,
        component,
        realpathSync(`/proc/self/fd/${parentDescriptor}`) + `/${component}`,
        { allowMissing }
      );
      if (opened === undefined) return undefined;
      openedDirectories.push(opened.descriptor);
      parentDescriptor = opened.descriptor;
    }
    return openOwnedFileAt(
      parentDescriptor,
      components.at(-1),
      maximumHeadBytes,
      { allowMissing }
    );
  } finally {
    for (const descriptor of openedDirectories.reverse()) {
      try {
        closeSync(descriptor);
      } catch {
        // 已打开的引用文件描述符仍然独立有效。
      }
    }
  }
}

function commitFromRefBytes(bytes) {
  const content = decodeUtf8(bytes);
  const normalized = content.endsWith("\n")
    ? content.slice(0, -1)
    : content;
  if (!commitPattern.test(normalized)) failTrustedGit();
  return normalized;
}

function commitFromPackedRefs(bytes, symbolicRef) {
  const content = decodeUtf8(bytes);
  let result;
  let previousWasEntry = false;
  for (const line of content.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("#")) {
      previousWasEntry = false;
      continue;
    }
    if (/^\^[0-9a-f]{40}$/u.test(line)) {
      if (!previousWasEntry) failTrustedGit();
      previousWasEntry = false;
      continue;
    }
    const match = /^([0-9a-f]{40}) ([^\0-\x20\x7f]+)$/u.exec(line);
    if (match === null) failTrustedGit();
    previousWasEntry = true;
    if (match[2] === symbolicRef) {
      if (result !== undefined) failTrustedGit();
      result = match[1];
    }
  }
  if (result === undefined) failTrustedGit();
  return result;
}

function openHeadBinding(gitDirectoryDescriptor) {
  let head;
  let reference;
  try {
    head = openOwnedFileAt(
      gitDirectoryDescriptor,
      "HEAD",
      maximumHeadBytes
    );
    const parsedHead = parseHead(decodeUtf8(head.bytes));
    if (parsedHead.codeVersion !== undefined) {
      return {
        head,
        reference: undefined,
        referenceKind: undefined,
        symbolicRef: undefined,
        codeVersion: parsedHead.codeVersion
      };
    }

    reference = openNestedRef(
      gitDirectoryDescriptor,
      parsedHead.symbolicRef,
      { allowMissing: true }
    );
    if (reference !== undefined) {
      return {
        head,
        reference,
        referenceKind: "loose",
        symbolicRef: parsedHead.symbolicRef,
        codeVersion: commitFromRefBytes(reference.bytes)
      };
    }
    reference = openOwnedFileAt(
      gitDirectoryDescriptor,
      "packed-refs",
      maximumPackedRefsBytes
    );
    return {
      head,
      reference,
      referenceKind: "packed",
      symbolicRef: parsedHead.symbolicRef,
      codeVersion: commitFromPackedRefs(reference.bytes, parsedHead.symbolicRef)
    };
  } catch {
    if (reference !== undefined) closeQuietly(reference.descriptor);
    if (head !== undefined) closeQuietly(head.descriptor);
    failTrustedGit();
  }
}

function openRepositorySnapshot(repositoryDirectory) {
  if (!isAbsolute(repositoryDirectory)) failTrustedGit();
  const repository = resolve(repositoryDirectory);
  const gitDirectory = resolve(repository, ".git");
  const repositoryBinding = openOwnedDirectory(repository, repository);
  let gitDirectoryBinding;
  let headBinding;
  let indexBinding;
  let objectsBinding;
  try {
    gitDirectoryBinding = openOwnedDirectoryAt(
      repositoryBinding.descriptor,
      ".git",
      gitDirectory
    );
    headBinding = openHeadBinding(gitDirectoryBinding.descriptor);
    indexBinding = openOwnedFileAt(
      gitDirectoryBinding.descriptor,
      "index",
      maximumIndexBytes
    );
    objectsBinding = openOwnedDirectoryAt(
      gitDirectoryBinding.descriptor,
      "objects",
      resolve(gitDirectory, "objects")
    );
    return {
      repository,
      repositoryBinding,
      gitDirectory,
      gitDirectoryBinding,
      headBinding,
      indexBinding,
      objectsBinding
    };
  } catch {
    for (const descriptor of [
      objectsBinding?.descriptor,
      indexBinding?.descriptor,
      headBinding?.reference?.descriptor,
      headBinding?.head?.descriptor,
      gitDirectoryBinding?.descriptor,
      repositoryBinding.descriptor
    ]) {
      if (descriptor === undefined) continue;
      try {
        closeSync(descriptor);
      } catch {
        // 失败路径仍只报告固定错误。
      }
    }
    failTrustedGit();
  }
}

function reopenAndAssertDirectory(path, binding) {
  const reopened = openOwnedDirectory(path, path);
  try {
    const heldStatus = fstatSync(binding.descriptor, { bigint: true });
    if (
      !sameStableSnapshot(binding.status, heldStatus) ||
      !sameStableSnapshot(binding.status, reopened.status)
    ) {
      failTrustedGit();
    }
  } finally {
    closeSync(reopened.descriptor);
  }
}

function assertHeldFileUnchanged(binding) {
  const heldStatus = fstatSync(binding.descriptor, { bigint: true });
  assertCurrentUserOwned(heldStatus, (candidate) => candidate.isFile());
  if (!sameStableSnapshot(binding.status, heldStatus)) failTrustedGit();
  const bytes = readDescriptorBytes(binding.descriptor, heldStatus.size);
  if (!bytes.equals(binding.bytes)) failTrustedGit();
}

function reopenAndAssertFileAt(parentDescriptor, name, binding) {
  const reopened = openOwnedFileAt(
    parentDescriptor,
    name,
    binding.maximumBytes
  );
  try {
    if (
      !sameStableSnapshot(binding.status, reopened.status) ||
      !binding.bytes.equals(reopened.bytes)
    ) {
      failTrustedGit();
    }
  } finally {
    closeSync(reopened.descriptor);
  }
}

function reopenNestedRef(gitDirectoryDescriptor, symbolicRef, binding) {
  const reopened = openNestedRef(gitDirectoryDescriptor, symbolicRef);
  try {
    if (
      !sameStableSnapshot(binding.status, reopened.status) ||
      !binding.bytes.equals(reopened.bytes)
    ) {
      failTrustedGit();
    }
  } finally {
    closeSync(reopened.descriptor);
  }
}

function assertRepositorySnapshotUnchanged(snapshot) {
  reopenAndAssertDirectory(snapshot.repository, snapshot.repositoryBinding);
  reopenAndAssertDirectory(snapshot.gitDirectory, snapshot.gitDirectoryBinding);
  assertHeldFileUnchanged(snapshot.headBinding.head);
  reopenAndAssertFileAt(
    snapshot.gitDirectoryBinding.descriptor,
    "HEAD",
    snapshot.headBinding.head
  );
  assertHeldFileUnchanged(snapshot.indexBinding);
  reopenAndAssertFileAt(
    snapshot.gitDirectoryBinding.descriptor,
    "index",
    snapshot.indexBinding
  );
  const objectsStatus = fstatSync(
    snapshot.objectsBinding.descriptor,
    { bigint: true }
  );
  if (!sameStableSnapshot(snapshot.objectsBinding.status, objectsStatus)) {
    failTrustedGit();
  }
  const reopenedObjects = openOwnedDirectoryAt(
    snapshot.gitDirectoryBinding.descriptor,
    "objects",
    resolve(snapshot.gitDirectory, "objects")
  );
  try {
    if (!sameStableSnapshot(snapshot.objectsBinding.status, reopenedObjects.status)) {
      failTrustedGit();
    }
  } finally {
    closeSync(reopenedObjects.descriptor);
  }

  if (snapshot.headBinding.reference !== undefined) {
    assertHeldFileUnchanged(snapshot.headBinding.reference);
    if (snapshot.headBinding.symbolicRef === undefined) failTrustedGit();
    if (snapshot.headBinding.referenceKind === "packed") {
      const unexpectedLooseRef = openNestedRef(
        snapshot.gitDirectoryBinding.descriptor,
        snapshot.headBinding.symbolicRef,
        { allowMissing: true }
      );
      if (unexpectedLooseRef !== undefined) {
        closeSync(unexpectedLooseRef.descriptor);
        failTrustedGit();
      }
      reopenAndAssertFileAt(
        snapshot.gitDirectoryBinding.descriptor,
        "packed-refs",
        snapshot.headBinding.reference
      );
    } else if (snapshot.headBinding.referenceKind === "loose") {
      reopenNestedRef(
        snapshot.gitDirectoryBinding.descriptor,
        snapshot.headBinding.symbolicRef,
        snapshot.headBinding.reference
      );
    } else {
      failTrustedGit();
    }
  }
}

function closeRepositorySnapshot(snapshot) {
  let closed = true;
  for (const descriptor of [
    snapshot.objectsBinding.descriptor,
    snapshot.indexBinding.descriptor,
    snapshot.headBinding.reference?.descriptor,
    snapshot.headBinding.head.descriptor,
    snapshot.gitDirectoryBinding.descriptor,
    snapshot.repositoryBinding.descriptor
  ]) {
    if (descriptor === undefined) continue;
    try {
      closeSync(descriptor);
    } catch {
      closed = false;
    }
  }
  return closed;
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
    if (written <= 0) failTrustedGit();
    offset += written;
  }
}

function writeControlledFile(path, content, finalMode = 0o600) {
  let descriptor;
  try {
    descriptor = openSync(path, exclusiveFileFlags, 0o600);
    fchmodSync(descriptor, 0o600);
    writeAll(
      descriptor,
      typeof content === "string" ? Buffer.from(content, "utf8") : content
    );
    fsyncSync(descriptor);
    fchmodSync(descriptor, finalMode);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function executeControlledIndexCommand(
  snapshot,
  directory,
  indexPath,
  commandArguments
) {
  try {
    return execFileSync(
      trustedGitExecutable,
      [
        "--no-pager",
        "--no-replace-objects",
        `--git-dir=${directory}`,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        "core.excludesFile=/dev/null",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.splitIndex=false",
        ...commandArguments
      ],
      {
        cwd: snapshot.repository,
        encoding: "buffer",
        env: {
          ...buildTrustedGitEnvironment(),
          GIT_ALTERNATE_OBJECT_DIRECTORIES: "/proc/self/fd/3",
          GIT_INDEX_FILE: indexPath,
          GIT_OBJECT_DIRECTORY: join(directory, "objects")
        },
        maxBuffer: 1024 * 1024,
        stdio: [
          "ignore",
          "pipe",
          "pipe",
          snapshot.objectsBinding.descriptor
        ]
      }
    );
  } catch {
    failTrustedGit();
  }
}

function rebuildControlledIndex(snapshot, directory) {
  const sourceIndexPath = join(directory, "source-index");
  const stagedIndexPath = join(directory, "staged-index");
  const indexPath = join(directory, "index");
  writeControlledFile(
    sourceIndexPath,
    snapshot.indexBinding.bytes,
    0o400
  );
  // write-tree 可能为了 cache-tree extension 原子刷新 index；因此只让它改写
  // 另一份可丢弃副本，source-index 始终保留正式 index 的精确只读字节。
  writeControlledFile(
    stagedIndexPath,
    snapshot.indexBinding.bytes,
    0o600
  );

  // 先从已绑定 HEAD 创建全新 index，确保不存在正式 index 的 stat cache。
  executeControlledIndexCommand(
    snapshot,
    directory,
    indexPath,
    ["read-tree", snapshot.headBinding.codeVersion]
  );
  // source-index 只贡献 staged 的逻辑 mode/OID/path；write-tree 不读工作树、
  // 不执行 clean/process filter。再 read-tree 该 tree 会重新把所有 stat 清零。
  const stagedTree = decodeUtf8(executeControlledIndexCommand(
    snapshot,
    directory,
    stagedIndexPath,
    ["write-tree"]
  )).trim();
  if (!commitPattern.test(stagedTree)) failTrustedGit();
  rmSync(stagedIndexPath, { force: false });
  executeControlledIndexCommand(
    snapshot,
    directory,
    indexPath,
    ["read-tree", stagedTree]
  );
  chmodSync(indexPath, 0o400);
  return { indexPath, sourceIndexPath };
}

function createControlledGitDirectory(snapshot, temporaryRoot) {
  const root = resolve(temporaryRoot);
  if (!isAbsolute(root)) failTrustedGit();
  let directory;
  let binding;
  let indexBinding;
  let sourceIndexBinding;
  try {
    directory = mkdtempSync(join(root, temporaryPrefix));
    const requiredPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (!directory.startsWith(requiredPrefix)) failTrustedGit();
    chmodSync(directory, 0o700);
    mkdirSync(join(directory, "info"), { mode: 0o700 });
    chmodSync(join(directory, "info"), 0o700);
    mkdirSync(join(directory, "objects"), { mode: 0o700 });
    chmodSync(join(directory, "objects"), 0o700);
    mkdirSync(join(directory, "refs"), { mode: 0o700 });
    chmodSync(join(directory, "refs"), 0o700);
    writeControlledFile(
      join(directory, "HEAD"),
      `${snapshot.headBinding.codeVersion}\n`
    );
    writeControlledFile(
      join(directory, "config"),
      "[core]\n" +
        "\trepositoryformatversion = 0\n" +
        "\tbare = false\n" +
        "\thooksPath = /dev/null\n" +
        "\tfsmonitor = false\n" +
        "\tattributesFile = /dev/null\n" +
        "\texcludesFile = /dev/null\n" +
        "\tuntrackedCache = false\n" +
        "\tsplitIndex = false\n" +
        "[diff]\n" +
        "\texternal =\n" +
        "\tignoreSubmodules = all\n" +
        "[status]\n" +
        "\tsubmoduleSummary = false\n" +
        "[submodule]\n" +
        "\trecurse = false\n"
    );
    writeControlledFile(join(directory, "info", "attributes"), "");
    // 临时 gitdir 位于 /tmp，正式工作树根下的 .git 否则会被当作普通未跟踪目录。
    // 这里只精确排除这一目录；private 仍必须由仓库跟踪的 .gitignore 证明已忽略。
    writeControlledFile(join(directory, "info", "exclude"), "/.git/\n");
    const rebuilt = rebuildControlledIndex(snapshot, directory);
    binding = openOwnedDirectory(directory, directory);
    const status = fstatSync(binding.descriptor, { bigint: true });
    if ((status.mode & 0o777n) !== 0o700n) failTrustedGit();
    indexBinding = openOwnedFileAt(
      binding.descriptor,
      "index",
      maximumIndexBytes
    );
    sourceIndexBinding = openOwnedFileAt(
      binding.descriptor,
      "source-index",
      maximumIndexBytes
    );
    if (
      (indexBinding.status.mode & 0o777n) !== 0o400n ||
      (sourceIndexBinding.status.mode & 0o777n) !== 0o400n ||
      !sourceIndexBinding.bytes.equals(snapshot.indexBinding.bytes)
    ) {
      closeQuietly(indexBinding.descriptor);
      closeQuietly(sourceIndexBinding.descriptor);
      failTrustedGit();
    }
    fsyncSync(binding.descriptor);
    return {
      directory,
      binding,
      indexBinding,
      sourceIndexBinding,
      indexPath: rebuilt.indexPath,
      sourceIndexPath: rebuilt.sourceIndexPath
    };
  } catch {
    if (binding !== undefined) {
      try {
        closeSync(binding.descriptor);
      } catch {
        // 随后仍尝试清理本次唯一临时目录。
      }
    }
    if (indexBinding !== undefined) closeQuietly(indexBinding.descriptor);
    if (sourceIndexBinding !== undefined) {
      closeQuietly(sourceIndexBinding.descriptor);
    }
    if (directory !== undefined) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // 临时目录固定为 0700；对外仍只报告固定错误。
      }
    }
    failTrustedGit();
  }
}

function cleanupControlledGitDirectory(controlled) {
  let integrityValid = true;
  let safeToRemove = false;
  let removed = false;
  try {
    const heldStatus = fstatSync(controlled.binding.descriptor, { bigint: true });
    const reopened = openOwnedDirectory(controlled.directory, controlled.directory);
    try {
      safeToRemove =
        sameIdentity(controlled.binding.status, heldStatus) &&
        sameIdentity(controlled.binding.status, reopened.status);
      if (!safeToRemove || (heldStatus.mode & 0o777n) !== 0o700n) {
        integrityValid = false;
      }
    } finally {
      closeSync(reopened.descriptor);
    }
    try {
      assertHeldFileUnchanged(controlled.indexBinding);
      reopenAndAssertFileAt(
        controlled.binding.descriptor,
        "index",
        controlled.indexBinding
      );
      assertHeldFileUnchanged(controlled.sourceIndexBinding);
      reopenAndAssertFileAt(
        controlled.binding.descriptor,
        "source-index",
        controlled.sourceIndexBinding
      );
    } catch {
      integrityValid = false;
    }
  } catch {
    integrityValid = false;
  }
  if (!closeQuietly(controlled.indexBinding.descriptor)) {
    integrityValid = false;
  }
  if (!closeQuietly(controlled.sourceIndexBinding.descriptor)) {
    integrityValid = false;
  }
  if (safeToRemove) {
    try {
      rmSync(controlled.directory, { recursive: true, force: false });
      removed = true;
    } catch {
      integrityValid = false;
    }
  }
  if (!closeQuietly(controlled.binding.descriptor)) {
    integrityValid = false;
  }
  return integrityValid && removed;
}

export function assertSafeCallerGitEnvironment(environment) {
  for (const [key, value] of Object.entries(environment)) {
    if (
      key.startsWith("GIT_") &&
      key !== "GIT_PAGER" &&
      value !== undefined
    ) {
      failTrustedGit();
    }
  }
}

export function buildTrustedGitEnvironment() {
  return {
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    HOME: "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    XDG_CONFIG_HOME: "/nonexistent"
  };
}

function isAllowedReadOnlyGitCommand(commandArguments) {
  if (
    commandArguments.length === 6 &&
    commandArguments[0] === "diff" &&
    commandArguments[1] === "--binary" &&
    commandArguments[2] === "--no-ext-diff" &&
    commandArguments[3] === "--no-renames" &&
    commitPattern.test(commandArguments[4] ?? "") &&
    commitPattern.test(commandArguments[5] ?? "") &&
    commandArguments[4] !== commandArguments[5]
  ) {
    return true;
  }
  if (
    commandArguments.length === 6 &&
    commandArguments[0] === "diff" &&
    commandArguments[1] === "--name-only" &&
    commandArguments[2] === "--no-ext-diff" &&
    commandArguments[3] === "--no-renames" &&
    commitPattern.test(commandArguments[4] ?? "") &&
    commitPattern.test(commandArguments[5] ?? "") &&
    commandArguments[4] !== commandArguments[5]
  ) {
    return true;
  }
  const serialized = JSON.stringify(commandArguments);
  if (
    serialized === JSON.stringify(["rev-parse", "HEAD"]) ||
    serialized === JSON.stringify([
      "status",
      "--porcelain=v1",
      "--untracked-files=all"
    ]) ||
    serialized === JSON.stringify(["ls-files", "-v", "-z"]) ||
    serialized === JSON.stringify(["ls-files", "-f", "-z"]) ||
    serialized === JSON.stringify(["ls-files", "private"])
  ) {
    return true;
  }
  if (
    commandArguments.length >= 4 &&
    commandArguments[0] === "ls-files" &&
    commandArguments[1] === "--error-unmatch" &&
    commandArguments[2] === "--" &&
    commandArguments.slice(3).every(
      (path) =>
        /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(path) &&
        !path.startsWith("/") &&
        !path.split("/").some((component) => component === "." || component === "..")
    )
  ) {
    return true;
  }
  if (
    commandArguments.length === 2 &&
    commandArguments[0] === "show" &&
    /^HEAD:[A-Za-z0-9._/-]+$/u.test(commandArguments[1]) &&
    !commandArguments[1].includes("..")
  ) {
    return true;
  }
  return (
    commandArguments.length === 3 &&
    commandArguments[0] === "check-ignore" &&
    commandArguments[1] === "-q" &&
    /^private\/[.][a-z0-9-]+$/u.test(commandArguments[2])
  );
}

function executeSnapshotGit(
  snapshot,
  controlled,
  commandArguments,
  { encoding, execute }
) {
  if (
    !Array.isArray(commandArguments) ||
    commandArguments.some(
      (argument) => typeof argument !== "string" || argument.includes("\0")
    ) ||
    !isAllowedReadOnlyGitCommand(commandArguments)
  ) {
    failTrustedGit();
  }
  const selectedIndexBinding = commandArguments[0] === "ls-files"
    ? controlled.sourceIndexBinding
    : controlled.indexBinding;
  try {
    const output = execute(
      trustedGitExecutable,
      [
        "--no-pager",
        "--no-replace-objects",
        "--git-dir=/proc/self/fd/6",
        "--work-tree=/proc/self/fd/5",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "diff.external=",
        "-c",
        "diff.ignoreSubmodules=all",
        "-c",
        "status.submoduleSummary=false",
        "-c",
        "submodule.recurse=false",
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        "core.excludesFile=/dev/null",
        "-c",
        "core.ignoreStat=false",
        "-c",
        "core.trustctime=true",
        "-c",
        "core.checkStat=default",
        "-c",
        "core.fileMode=true",
        "-c",
        "core.bare=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.splitIndex=false",
        ...commandArguments
      ],
      {
        cwd: snapshot.repository,
        encoding,
        env: {
          ...buildTrustedGitEnvironment(),
          GIT_INDEX_FILE: "/proc/self/fd/3",
          GIT_OBJECT_DIRECTORY: "/proc/self/fd/4"
        },
        maxBuffer: 16 * 1024 * 1024,
        stdio: [
          "ignore",
          "pipe",
          "pipe",
          selectedIndexBinding.descriptor,
          snapshot.objectsBinding.descriptor,
          snapshot.repositoryBinding.descriptor,
          controlled.binding.descriptor
        ]
      }
    );
    if (
      JSON.stringify(commandArguments) ===
        JSON.stringify(["rev-parse", "HEAD"]) &&
      String(output).trim() !== snapshot.headBinding.codeVersion
    ) {
      failTrustedGit();
    }
    return output;
  } catch {
    failTrustedGit();
  }
}

export function withTrustedGitSnapshot(
  repositoryDirectory,
  callback,
  {
    execute = execFileSync,
    verifyExecutable = verifyTrustedGitExecutable,
    temporaryRoot = tmpdir()
  } = {}
) {
  let snapshot;
  let controlled;
  let result;
  let succeeded = false;
  let apiActive = false;
  try {
    verifyExecutable();
    snapshot = openRepositorySnapshot(repositoryDirectory);
    controlled = createControlledGitDirectory(snapshot, temporaryRoot);
    apiActive = true;
    const api = Object.freeze({
      headCodeVersion: snapshot.headBinding.codeVersion,
      run: (commandArguments, options = {}) => {
        if (!apiActive) failTrustedGit();
        return executeSnapshotGit(snapshot, controlled, commandArguments, {
          encoding: options.encoding,
          execute
        });
      }
    });
    result = callback(api);
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof result.then === "function"
    ) {
      failTrustedGit();
    }
    apiActive = false;
    assertRepositorySnapshotUnchanged(snapshot);
    succeeded = true;
  } catch {
    succeeded = false;
  } finally {
    apiActive = false;
    if (controlled !== undefined && !cleanupControlledGitDirectory(controlled)) {
      succeeded = false;
    }
    if (snapshot !== undefined && !closeRepositorySnapshot(snapshot)) {
      succeeded = false;
    }
  }
  if (!succeeded) failTrustedGit();
  return result;
}

export function runTrustedGit(
  repositoryDirectory,
  commandArguments,
  {
    encoding,
    execute = execFileSync,
    verifyExecutable = verifyTrustedGitExecutable,
    temporaryRoot = tmpdir()
  } = {}
) {
  return withTrustedGitSnapshot(
    repositoryDirectory,
    (snapshot) => snapshot.run(commandArguments, { encoding }),
    { execute, verifyExecutable, temporaryRoot }
  );
}
