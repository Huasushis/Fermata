/**
 * Linux 正式运行的私有路径边界。所有实际打开、创建和替换都从已验证的目录
 * 描述符经 /proc/self/fd 锚定，不能被中间符号链接或路径改名带出 Fermata/private。
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

export const repositoryRoot = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..")
);
export const workspaceRoot = realpathSync(resolve(repositoryRoot, ".."));
export const projectPrivateRoot = resolve(repositoryRoot, "private");

const directoryOpenFlags =
  constants.O_RDONLY |
  constants.O_DIRECTORY |
  (constants.O_NOFOLLOW ?? 0);

export class PrivateRuntimeInputError extends Error {
  constructor(code) {
    super(code);
    this.name = "PrivateRuntimeInputError";
    this.code = code;
  }
}

function failPrivateRuntime(code) {
  throw new PrivateRuntimeInputError(code);
}

function hasSystemErrorCode(error, ...codes) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    codes.includes(error.code)
  );
}

export function isInside(parent, candidate, { allowSame = true } = {}) {
  const pathFromParent = relative(parent, candidate);
  if (pathFromParent === "") {
    return allowSame;
  }
  return (
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function closeQuietly(descriptor) {
  if (!Number.isSafeInteger(descriptor)) {
    return;
  }
  try {
    closeSync(descriptor);
  } catch {
    // 不输出可能包含服务器路径的底层错误。
  }
}

function assertOwnedPrivateDirectoryDescriptor(descriptor) {
  const status = fstatSync(descriptor);
  if (!status.isDirectory()) {
    failPrivateRuntime("PRIVATE_DIRECTORY_INVALID_TYPE");
  }
  if ((status.mode & 0o777) !== 0o700) {
    failPrivateRuntime("PRIVATE_DIRECTORY_INVALID_MODE");
  }
  if (
    typeof process.getuid === "function" &&
    status.uid !== process.getuid()
  ) {
    failPrivateRuntime("PRIVATE_DIRECTORY_INVALID_OWNER");
  }
}

function descriptorPath(descriptor, childName = null) {
  const anchoredDirectory = `/proc/self/fd/${descriptor}`;
  return childName === null
    ? anchoredDirectory
    : `${anchoredDirectory}/${childName}`;
}

function openPrivateRoot(privateRoot, containingWorkspace) {
  const resolvedRoot = resolve(privateRoot);
  if (
    !isInside(containingWorkspace, resolvedRoot, { allowSame: false })
  ) {
    failPrivateRuntime("PRIVATE_ROOT_OUTSIDE_PROJECT");
  }

  let descriptor;
  try {
    descriptor = openSync(resolvedRoot, directoryOpenFlags);
    assertOwnedPrivateDirectoryDescriptor(descriptor);
    const canonicalRoot = realpathSync(descriptorPath(descriptor));
    if (
      canonicalRoot !== resolvedRoot ||
      !isInside(containingWorkspace, canonicalRoot, { allowSame: false })
    ) {
      failPrivateRuntime("PRIVATE_ROOT_OUTSIDE_PROJECT");
    }
    return { path: canonicalRoot, descriptor };
  } catch (error) {
    if (descriptor !== undefined) {
      closeQuietly(descriptor);
    }
    if (error instanceof PrivateRuntimeInputError) {
      throw error;
    }
    if (hasSystemErrorCode(error, "ELOOP", "ENOTDIR")) {
      failPrivateRuntime("PRIVATE_DIRECTORY_INVALID_TYPE");
    }
    failPrivateRuntime("PRIVATE_ROOT_UNAVAILABLE");
  }
}

function splitPrivateRelativePath(canonicalRoot, candidate, kind) {
  const resolvedCandidate = resolve(candidate);
  const pathFromRoot = relative(canonicalRoot, resolvedCandidate);
  if (
    pathFromRoot === "" ||
    !isInside(canonicalRoot, resolvedCandidate, { allowSame: false })
  ) {
    failPrivateRuntime(`${kind}_OUTSIDE_ROOT`);
  }
  const components = pathFromRoot.split(sep);
  if (
    components.some(
      (component) =>
        component === "" || component === "." || component === ".."
    )
  ) {
    failPrivateRuntime(`${kind}_OUTSIDE_ROOT`);
  }
  return { resolvedCandidate, components };
}

function openPrivateAncestorChain(rootHandle, components) {
  const descriptors = [rootHandle.descriptor];
  let currentDescriptor = rootHandle.descriptor;
  try {
    for (const component of components) {
      const nextDescriptor = openSync(
        descriptorPath(currentDescriptor, component),
        directoryOpenFlags
      );
      descriptors.push(nextDescriptor);
      assertOwnedPrivateDirectoryDescriptor(nextDescriptor);
      currentDescriptor = nextDescriptor;
    }
    return { descriptor: currentDescriptor, descriptors };
  } catch (error) {
    // root descriptor 的所有权始终属于调用者；这里只关闭本函数打开的子目录。
    for (const descriptor of descriptors.slice(1).reverse()) {
      closeQuietly(descriptor);
    }
    if (error instanceof PrivateRuntimeInputError) {
      throw error;
    }
    if (hasSystemErrorCode(error, "ELOOP", "ENOTDIR")) {
      failPrivateRuntime("PRIVATE_DIRECTORY_INVALID_TYPE");
    }
    failPrivateRuntime("PRIVATE_ANCESTOR_UNAVAILABLE");
  }
}

function closeAncestorChain(descriptors, keepDescriptor = null) {
  for (const descriptor of descriptors.reverse()) {
    if (descriptor !== keepDescriptor) {
      closeQuietly(descriptor);
    }
  }
}

export function closePrivateDirectory(privateDirectoryHandle) {
  if (
    privateDirectoryHandle !== null &&
    typeof privateDirectoryHandle === "object" &&
    Number.isSafeInteger(privateDirectoryHandle.descriptor)
  ) {
    const descriptor = privateDirectoryHandle.descriptor;
    privateDirectoryHandle.descriptor = undefined;
    closeQuietly(descriptor);
  }
}

/**
 * 新建私有末级目录时，先同步目录自身元数据，再同步持有其目录项的父目录。
 * 只有两步都成功后调用方才可把目录视为付费前持久化边界。
 */
export function durablyCommitCreatedPrivateDirectory(
  directoryDescriptor,
  parentDirectoryDescriptor,
  synchronize = fsyncSync
) {
  synchronize(directoryDescriptor);
  synchronize(parentDirectoryDescriptor);
}

function openPrivateDirectoryInternal(
  privateDirectory,
  {
    privateRoot = projectPrivateRoot,
    containingWorkspace = workspaceRoot,
    createMissing
  }
) {
  if (!isAbsolute(privateDirectory)) {
    failPrivateRuntime("PRIVATE_DIRECTORY_NOT_ABSOLUTE");
  }
  const rootHandle = openPrivateRoot(privateRoot, containingWorkspace);
  let chain;
  let finalDescriptor;
  let created = false;
  let finalAnchoredPath;
  try {
    const { resolvedCandidate, components } = splitPrivateRelativePath(
      rootHandle.path,
      privateDirectory,
      "PRIVATE_DIRECTORY"
    );
    const finalName = components.at(-1);
    const parentComponents = components.slice(0, -1);
    chain = openPrivateAncestorChain(rootHandle, parentComponents);
    finalAnchoredPath = descriptorPath(chain.descriptor, finalName);
    try {
      finalDescriptor = openSync(finalAnchoredPath, directoryOpenFlags);
    } catch (error) {
      if (
        !createMissing ||
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      mkdirSync(finalAnchoredPath, { recursive: false, mode: 0o700 });
      created = true;
      finalDescriptor = openSync(finalAnchoredPath, directoryOpenFlags);
      fchmodSync(finalDescriptor, 0o700);
      durablyCommitCreatedPrivateDirectory(finalDescriptor, chain.descriptor);
    }
    assertOwnedPrivateDirectoryDescriptor(finalDescriptor);
    closeAncestorChain(chain.descriptors, finalDescriptor);
    chain = undefined;
    return {
      path: resolvedCandidate,
      descriptor: finalDescriptor,
      created
    };
  } catch (error) {
    if (finalDescriptor !== undefined) {
      closeQuietly(finalDescriptor);
    }
    if (created && finalAnchoredPath !== undefined) {
      try {
        rmdirSync(finalAnchoredPath);
      } catch {
        // 只删除本函数刚创建且仍为空的末级目录；失败时保留，不扩大删除范围。
      }
    }
    if (chain !== undefined) {
      closeAncestorChain(chain.descriptors);
    } else {
      // ancestor helper 从不接管 root；未返回 chain 时由调用者关闭它一次。
      closeQuietly(rootHandle.descriptor);
    }
    if (error instanceof PrivateRuntimeInputError) {
      throw error;
    }
    if (hasSystemErrorCode(error, "ELOOP", "ENOTDIR")) {
      failPrivateRuntime("PRIVATE_DIRECTORY_INVALID_TYPE");
    }
    failPrivateRuntime("PRIVATE_DIRECTORY_UNAVAILABLE");
  }
}

/** 打开已存在的私有输入目录；只读路径绝不能因为拼写错误而创建空目录。 */
export function openExistingPrivateDirectory(
  privateDirectory,
  {
    privateRoot = projectPrivateRoot,
    containingWorkspace = workspaceRoot
  } = {}
) {
  return openPrivateDirectoryInternal(privateDirectory, {
    privateRoot,
    containingWorkspace,
    createMissing: false
  });
}

/** 打开输出目录，不存在时只创建经过逐段验证的末级目录。 */
export function preparePrivateDirectory(
  privateDirectory,
  {
    privateRoot = projectPrivateRoot,
    containingWorkspace = workspaceRoot
  } = {}
) {
  return openPrivateDirectoryInternal(privateDirectory, {
    privateRoot,
    containingWorkspace,
    createMissing: true
  });
}

function sameFileSnapshot(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function readBoundedFile(descriptor, maximumBytes) {
  const chunks = [];
  let totalBytes = 0;
  while (totalBytes <= maximumBytes) {
    const maximumNextBytes = Math.min(64 * 1024, maximumBytes + 1 - totalBytes);
    if (maximumNextBytes <= 0) {
      break;
    }
    const chunk = Buffer.allocUnsafe(maximumNextBytes);
    const bytesRead = readSync(
      descriptor,
      chunk,
      0,
      maximumNextBytes,
      null
    );
    if (bytesRead === 0) {
      break;
    }
    totalBytes += bytesRead;
    chunks.push(chunk.subarray(0, bytesRead));
  }
  if (totalBytes > maximumBytes) {
    failPrivateRuntime("ENV_FILE_TOO_LARGE");
  }
  return Buffer.concat(chunks, totalBytes);
}

export function readProtectedEnvFile(
  envFile,
  {
    privateRoot = projectPrivateRoot,
    containingWorkspace = workspaceRoot,
    maximumBytes = 1024 * 1024
  } = {}
) {
  if (!isAbsolute(envFile)) {
    failPrivateRuntime("ENV_FILE_NOT_ABSOLUTE");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    failPrivateRuntime("ENV_FILE_INVALID_LIMIT");
  }

  const rootHandle = openPrivateRoot(privateRoot, containingWorkspace);
  let chain;
  let fileDescriptor;
  try {
    const { components } = splitPrivateRelativePath(
      rootHandle.path,
      envFile,
      "ENV_FILE"
    );
    const fileName = components.at(-1);
    const parentComponents = components.slice(0, -1);
    chain = openPrivateAncestorChain(rootHandle, parentComponents);
    fileDescriptor = openSync(
      descriptorPath(chain.descriptor, fileName),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    );
    const before = fstatSync(fileDescriptor, { bigint: true });
    if (!before.isFile()) {
      failPrivateRuntime("ENV_FILE_INVALID_TYPE");
    }
    if ((before.mode & 0o777n) !== 0o600n) {
      failPrivateRuntime("ENV_FILE_INVALID_MODE");
    }
    if (before.nlink !== 1n) {
      failPrivateRuntime("ENV_FILE_INVALID_LINK");
    }
    if (
      typeof process.getuid === "function" &&
      before.uid !== BigInt(process.getuid())
    ) {
      failPrivateRuntime("ENV_FILE_INVALID_OWNER");
    }
    if (before.size > BigInt(maximumBytes)) {
      failPrivateRuntime("ENV_FILE_TOO_LARGE");
    }
    const content = readBoundedFile(fileDescriptor, maximumBytes);
    const after = fstatSync(fileDescriptor, { bigint: true });
    if (!sameFileSnapshot(before, after)) {
      failPrivateRuntime("ENV_FILE_CHANGED_DURING_READ");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      failPrivateRuntime("ENV_FILE_INVALID_UTF8");
    }
  } catch (error) {
    if (error instanceof PrivateRuntimeInputError) {
      throw error;
    }
    if (hasSystemErrorCode(error, "ELOOP", "ENOTDIR")) {
      failPrivateRuntime("ENV_FILE_INVALID_TYPE");
    }
    failPrivateRuntime("ENV_FILE_UNAVAILABLE");
  } finally {
    if (fileDescriptor !== undefined) {
      closeQuietly(fileDescriptor);
    }
    if (chain !== undefined) {
      closeAncestorChain(chain.descriptors);
    } else {
      closeQuietly(rootHandle.descriptor);
    }
  }
}

export function anchoredPrivatePath(privateDirectoryHandle, fileName) {
  if (!Number.isSafeInteger(privateDirectoryHandle?.descriptor)) {
    failPrivateRuntime("PRIVATE_DIRECTORY_HANDLE_CLOSED");
  }
  if (
    typeof fileName !== "string" ||
    basename(fileName) !== fileName ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("\0")
  ) {
    failPrivateRuntime("PRIVATE_FILE_NAME_INVALID");
  }
  return descriptorPath(privateDirectoryHandle.descriptor, fileName);
}
