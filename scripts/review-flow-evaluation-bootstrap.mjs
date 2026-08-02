#!/usr/bin/env node
/**
 * 11 角色付费评测的纯 Node 启动器。
 *
 * 本文件与 run-with-env、trusted-git-state 构成最小启动信任根；在它完成核验和
 * 快照前不加载 tsx、任何 npm 包或评测 TypeScript。评测只从只读临时快照运行，
 * 因而 ignored node_modules 或工作树在核验后的变化不能改变已启动的代码。
 *
 * 权限模型不声称能防御同一 UID 直接改写当前进程内存、替换本启动器后删除检查，
 * 或调试已运行进程。它防御的是磁盘依赖篡改、普通并发写入、路径/符号链接替换，
 * 以及“先让 tsx/评测代码执行，再恢复工作树通过身份检查”的旧启动顺序。
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import {
  closePrivateDirectory,
  preparePrivateDirectory
} from "./private-runtime.mjs";
import { withTrustedGitSnapshot } from "./trusted-git-state.mjs";

export const reviewFlowRuntimeAttestationEnvironmentKey =
  "FERMATA_REVIEW_FLOW_RUNTIME_ATTESTATION";
export const reviewFlowRuntimeManifestPath =
  "config/review-flow-runtime.json";

const repositoryRoot = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..")
);
const workspaceRoot = realpathSync(resolve(repositoryRoot, ".."));
const digestPattern = /^[0-9a-f]{64}$/u;
const commitPattern = /^(?!0{40}$)[0-9a-f]{40}$/u;
const runtimeIdentifierPattern = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,119}$/u;
const safeRepositoryPathPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;
const safePackageNamePattern = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u;
const npmSha512IntegrityPattern = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const maximumRuntimeFileBytes = 192 * 1024 * 1024;
const maximumRuntimeDependencyFileCount = 4_096;
const maximumRuntimeDependencyByteLength = 128 * 1024 * 1024;
const maximumRuntimePackageFileCount = 2_048;
const maximumRuntimePackageByteLength = 64 * 1024 * 1024;
const maximumChildOutputBytes = 8 * 1024;
const forwardedSignals = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);
const requiredRuntimePackageNames = Object.freeze([
  "tsx",
  "esbuild",
  "@esbuild/linux-x64",
  "undici",
  "zod"
]);
const requiredBootstrapCodePaths = Object.freeze([
  "config/review-flow-runtime.json",
  "experiments/lib/review-flow-runtime-attestation.ts",
  "package-lock.json",
  "package.json",
  "scripts/env-file.mjs",
  "scripts/private-runtime.mjs",
  "scripts/review-flow-evaluation-bootstrap.mjs",
  "scripts/run-with-env.mjs",
  "scripts/trusted-git-state.mjs"
]);

const allowedBootstrapEnvironmentKeys = new Set([
  "AETHER_API_KEY",
  "AETHER_BASE_URL",
  "ALL_PROXY",
  "CI",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_BASE_URL",
  "EVAL_CODE_VERSION",
  "EVAL_CONCURRENCY",
  "FERMATA_RUN_WITH_ENV",
  "FORCE_COLOR",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
  "NODE_DISABLE_COMPILE_CACHE",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REDIRECT_WARNINGS",
  "NODE_V8_COVERAGE",
  "NO_COLOR",
  "NO_PROXY",
  "PATH",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy"
]);

/**
 * 在 tsx 注册 loader 之前安装同步解析边界。bare import 可以正常解析 snapshot
 * 自己的 node_modules，但解析结果一旦落到 snapshot 外就固定失败。该源码作为
 * bootstrap 常量随其 Git 身份绑定，并作为独立文件计入每次 snapshot 摘要。
 */
export const reviewFlowModuleBoundaryGuardSource = `
import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const failure = () => {
  throw new Error("REVIEW_FLOW_MODULE_BOUNDARY_FAILED");
};
const snapshotRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const assertInsideSnapshot = (url) => {
  if (typeof url === "string" && url.startsWith("node:")) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:" || parsed.username || parsed.password) failure();
    const candidate = realpathSync(fileURLToPath(parsed));
    const fromRoot = relative(snapshotRoot, candidate);
    if (
      fromRoot === "" ||
      fromRoot === ".." ||
      fromRoot.startsWith(\`..\${sep}\`) ||
      fromRoot.startsWith(sep)
    ) failure();
  } catch {
    failure();
  }
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (result === null || typeof result !== "object" || typeof result.url !== "string") {
      failure();
    }
    assertInsideSnapshot(result.url);
    return result;
  },
  load(url, context, nextLoad) {
    assertInsideSnapshot(url);
    return nextLoad(url, context);
  }
});
`;

function failBootstrap() {
  throw new Error("REVIEW_FLOW_RUNTIME_BOOTSTRAP_FAILED");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isSafeRepositoryPath(path) {
  return typeof path === "string" &&
    safeRepositoryPathPattern.test(path) &&
    !path.startsWith("/") &&
    !path.split("/").some((component) => component === "." || component === "..");
}

function expectedNpmArchiveUrl(packageName, version) {
  const leafName = packageName.split("/").at(-1);
  if (leafName === undefined) failBootstrap();
  return `https://registry.npmjs.org/${packageName}/-/${leafName}-${version}.tgz`;
}

function expectedNodeArchiveSource(node) {
  const archiveRoot = `node-v${node.version}-${node.platform}-${node.arch}`;
  return {
    archiveUrl:
      `https://nodejs.org/dist/v${node.version}/${archiveRoot}.tar.xz`,
    archiveExecutablePath: `${archiveRoot}/bin/node`
  };
}

function assertBootstrapEnvironment(environment) {
  if (
    environment.FERMATA_RUN_WITH_ENV !== "1" ||
    environment[reviewFlowRuntimeAttestationEnvironmentKey] !== undefined ||
    !commitPattern.test(environment.EVAL_CODE_VERSION ?? "")
  ) {
    failBootstrap();
  }
  for (const [key, value] of Object.entries(environment)) {
    if (!allowedBootstrapEnvironmentKeys.has(key) || typeof value !== "string") {
      failBootstrap();
    }
    if (value.includes("\0")) failBootstrap();
  }
  for (const key of [
    "NODE_DEBUG",
    "NODE_DEBUG_NATIVE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_REDIRECT_WARNINGS",
    "NODE_V8_COVERAGE"
  ]) {
    if ((environment[key] ?? "").trim() !== "") failBootstrap();
  }
  if (environment.NODE_DISABLE_COMPILE_CACHE !== "1") failBootstrap();
}

function parsePositiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum
    ? value
    : undefined;
}

export function parseReviewFlowRuntimeManifest(bytes) {
  let document;
  try {
    document = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    failBootstrap();
  }
  if (
    !hasExactKeys(document, [
      "schemaVersion",
      "runnerPath",
      "codePaths",
      "productionCodePaths",
      "runtime"
    ]) ||
    document.schemaVersion !== 1 ||
    !isSafeRepositoryPath(document.runnerPath) ||
    !Array.isArray(document.codePaths) ||
    document.codePaths.length === 0 ||
    document.codePaths.length !== new Set(document.codePaths).size ||
    document.codePaths.some((path) => !isSafeRepositoryPath(path)) ||
    !document.codePaths.includes(document.runnerPath) ||
    requiredBootstrapCodePaths.some((path) => !document.codePaths.includes(path)) ||
    !Array.isArray(document.productionCodePaths) ||
    document.productionCodePaths.length === 0 ||
    document.productionCodePaths.length !==
      new Set(document.productionCodePaths).size ||
    document.productionCodePaths.some(
      (path) => !document.codePaths.includes(path)
    ) ||
    !hasExactKeys(document.runtime, [
      "node",
      "dependencyBundleSha256",
      "dependencyFileCount",
      "dependencyByteLength",
      "packages"
    ]) ||
    !hasExactKeys(document.runtime.node, [
      "version",
      "platform",
      "arch",
      "sha256",
      "byteLength",
      "source"
    ]) ||
    !hasExactKeys(document.runtime.node.source, [
      "archiveUrl",
      "archiveSha256",
      "archiveExecutablePath"
    ]) ||
    !runtimeIdentifierPattern.test(document.runtime.node.version) ||
    !runtimeIdentifierPattern.test(document.runtime.node.platform) ||
    !runtimeIdentifierPattern.test(document.runtime.node.arch) ||
    !digestPattern.test(document.runtime.node.sha256) ||
    !digestPattern.test(document.runtime.node.source.archiveSha256) ||
    parsePositiveInteger(
      document.runtime.node.byteLength,
      maximumRuntimeFileBytes
    ) === undefined ||
    !digestPattern.test(document.runtime.dependencyBundleSha256) ||
    parsePositiveInteger(
      document.runtime.dependencyFileCount,
      maximumRuntimeDependencyFileCount
    ) === undefined ||
    parsePositiveInteger(
      document.runtime.dependencyByteLength,
      maximumRuntimeDependencyByteLength
    ) === undefined ||
    !Array.isArray(document.runtime.packages) ||
    document.runtime.packages.length === 0
  ) {
    failBootstrap();
  }
  const expectedNodeSource = expectedNodeArchiveSource(document.runtime.node);
  if (
    document.runtime.node.source.archiveUrl !== expectedNodeSource.archiveUrl ||
    document.runtime.node.source.archiveExecutablePath !==
      expectedNodeSource.archiveExecutablePath
  ) {
    failBootstrap();
  }
  const packageNames = new Set();
  for (const package_ of document.runtime.packages) {
    if (
      !hasExactKeys(package_, [
        "name",
        "version",
        "resolved",
        "integrity",
        "sha256",
        "fileCount",
        "byteLength"
      ]) ||
      typeof package_.name !== "string" ||
      !safePackageNamePattern.test(package_.name) ||
      packageNames.has(package_.name) ||
      !runtimeIdentifierPattern.test(package_.version) ||
      package_.resolved !== expectedNpmArchiveUrl(
        package_.name,
        package_.version
      ) ||
      !npmSha512IntegrityPattern.test(package_.integrity) ||
      !digestPattern.test(package_.sha256) ||
      parsePositiveInteger(
        package_.fileCount,
        maximumRuntimePackageFileCount
      ) === undefined ||
      parsePositiveInteger(
        package_.byteLength,
        maximumRuntimePackageByteLength
      ) === undefined
    ) {
      failBootstrap();
    }
    packageNames.add(package_.name);
  }
  if (
    packageNames.size !== requiredRuntimePackageNames.length ||
    requiredRuntimePackageNames.some((name) => !packageNames.has(name)) ||
    document.runtime.packages.reduce(
      (sum, package_) => sum + package_.fileCount,
      0
    ) !== document.runtime.dependencyFileCount ||
    document.runtime.packages.reduce(
      (sum, package_) => sum + package_.byteLength,
      0
    ) !== document.runtime.dependencyByteLength
  ) {
    failBootstrap();
  }
  return Object.freeze(document);
}

/**
 * HEAD lock 是依赖来源承诺，不只是被整体哈希的一块字节。bootstrap 离线核对
 * 五个实际运行包的 exact version、npm 官方归档地址和 sha512 integrity；
 * fresh verifier 再从这些绑定重建真实文件树。
 */
export function assertReviewFlowRuntimeSourceBindings(manifest, lockBytes) {
  let lock;
  try {
    lock = JSON.parse(Buffer.from(lockBytes).toString("utf8"));
  } catch {
    failBootstrap();
  }
  if (
    !isRecord(lock) ||
    lock.lockfileVersion !== 3 ||
    !isRecord(lock.packages)
  ) {
    failBootstrap();
  }
  for (const expected of manifest.runtime.packages) {
    const locked = lock.packages[`node_modules/${expected.name}`];
    if (
      !isRecord(locked) ||
      locked.version !== expected.version ||
      locked.resolved !== expected.resolved ||
      locked.integrity !== expected.integrity ||
      locked.resolved !== expectedNpmArchiveUrl(expected.name, expected.version) ||
      !npmSha512IntegrityPattern.test(locked.integrity)
    ) {
      failBootstrap();
    }
  }
}

function hashCodeBundle(files) {
  const paths = files.map((file) => file.path);
  if (paths.length !== new Set(paths).size || paths.some((path) => !isSafeRepositoryPath(path))) {
    failBootstrap();
  }
  const digest = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const pathBytes = Buffer.from(file.path, "utf8");
    digest.update(String(pathBytes.byteLength));
    digest.update(":");
    digest.update(pathBytes);
    digest.update("\0");
    digest.update(String(file.bytes.byteLength));
    digest.update(":");
    digest.update(file.bytes);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function hashRuntimeFiles(files) {
  const digest = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const pathBytes = Buffer.from(file.path, "utf8");
    digest.update(String(pathBytes.byteLength));
    digest.update(":");
    digest.update(pathBytes);
    digest.update("\0");
    digest.update(file.executable ? "1" : "0");
    digest.update(":");
    digest.update(String(file.bytes.byteLength));
    digest.update(":");
    digest.update(file.bytes);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid;
}

function readStableOwnedFile(path, maximumBytes = maximumRuntimeFileBytes) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.size < 0n ||
      before.size > BigInt(maximumBytes) ||
      (typeof process.getuid === "function" &&
        before.uid !== BigInt(process.getuid()))
    ) {
      failBootstrap();
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(before, after) || bytes.byteLength !== Number(before.size)) {
      failBootstrap();
    }
    return {
      bytes,
      executable: (before.mode & 0o111n) !== 0n,
      snapshot: before
    };
  } catch {
    failBootstrap();
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 固定错误码；后续复核仍会失败关闭。
      }
    }
  }
}

function assertPathInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  if (
    pathFromParent === "" ||
    pathFromParent === ".." ||
    pathFromParent.startsWith(`..${sep}`) ||
    isAbsolute(pathFromParent)
  ) {
    failBootstrap();
  }
}

function collectPackageFiles(
  repositoryDirectory,
  packageName,
  expectedFileCount,
  expectedByteLength
) {
  const packageRoot = resolve(repositoryDirectory, "node_modules", ...packageName.split("/"));
  assertPathInside(repositoryDirectory, packageRoot);
  let canonicalRoot;
  try {
    const status = lstatSync(packageRoot, { bigint: true });
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      (typeof process.getuid === "function" &&
        status.uid !== BigInt(process.getuid()))
    ) {
      failBootstrap();
    }
    canonicalRoot = realpathSync(packageRoot);
    if (canonicalRoot !== packageRoot) failBootstrap();
  } catch {
    failBootstrap();
  }
  const files = [];
  let collectedByteLength = 0;
  let visitedDirectoryCount = 0;
  const visit = (directory, depth = 0) => {
    if (depth > 64) failBootstrap();
    visitedDirectoryCount += 1;
    if (visitedDirectoryCount > expectedFileCount * 4 + 64) {
      failBootstrap();
    }
    let handle;
    try {
      handle = opendirSync(directory);
    } catch {
      failBootstrap();
    }
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        if (entry.name === "." || entry.name === ".." || entry.name.includes("\0")) {
          failBootstrap();
        }
        const child = join(directory, entry.name);
        assertPathInside(canonicalRoot, child);
        if (entry.isDirectory()) {
          const status = lstatSync(child, { bigint: true });
          if (
            !status.isDirectory() ||
            status.isSymbolicLink() ||
            (typeof process.getuid === "function" &&
              status.uid !== BigInt(process.getuid()))
          ) {
            failBootstrap();
          }
          visit(child, depth + 1);
        } else if (entry.isFile()) {
          if (files.length >= expectedFileCount) failBootstrap();
          const remainingBytes = expectedByteLength - collectedByteLength;
          if (remainingBytes < 0) failBootstrap();
          const opened = readStableOwnedFile(
            child,
            Math.min(maximumRuntimeFileBytes, remainingBytes)
          );
          collectedByteLength += opened.bytes.byteLength;
          if (collectedByteLength > expectedByteLength) failBootstrap();
          files.push({
            path: relative(repositoryDirectory, child).split(sep).join("/"),
            bytes: opened.bytes,
            executable: opened.executable,
            originPath: child,
            originSnapshot: opened.snapshot
          });
        } else {
          failBootstrap();
        }
      }
    } catch {
      failBootstrap();
    } finally {
      try {
        handle.closeSync();
      } catch {
        failBootstrap();
      }
    }
  };
  visit(canonicalRoot);
  if (
    files.length !== expectedFileCount ||
    collectedByteLength !== expectedByteLength
  ) {
    failBootstrap();
  }
  return files;
}

function packageVersion(files, packageName) {
  const packageJsonPath = `node_modules/${packageName}/package.json`;
  const entry = files.find((file) => file.path === packageJsonPath);
  if (entry === undefined) failBootstrap();
  let metadata;
  try {
    metadata = JSON.parse(entry.bytes.toString("utf8"));
  } catch {
    failBootstrap();
  }
  if (!isRecord(metadata) || typeof metadata.version !== "string") failBootstrap();
  return metadata.version;
}

function loadRuntimeDependencies(repositoryDirectory, manifest) {
  const allFiles = [];
  const packages = [];
  for (const expected of manifest.runtime.packages) {
    const files = collectPackageFiles(
      repositoryDirectory,
      expected.name,
      expected.fileCount,
      expected.byteLength
    );
    const sha256 = hashRuntimeFiles(files);
    const byteLength = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    if (
      packageVersion(files, expected.name) !== expected.version ||
      sha256 !== expected.sha256 ||
      files.length !== expected.fileCount ||
      byteLength !== expected.byteLength
    ) {
      failBootstrap();
    }
    allFiles.push(...files);
    packages.push(Object.freeze({
      name: expected.name,
      version: expected.version,
      sha256,
      fileCount: files.length,
      byteLength
    }));
  }
  const dependencyBundleSha256 = hashRuntimeFiles(allFiles);
  const dependencyByteLength = allFiles.reduce(
    (sum, file) => sum + file.bytes.byteLength,
    0
  );
  if (
    dependencyBundleSha256 !== manifest.runtime.dependencyBundleSha256 ||
    allFiles.length !== manifest.runtime.dependencyFileCount ||
    dependencyByteLength !== manifest.runtime.dependencyByteLength
  ) {
    failBootstrap();
  }
  return { allFiles, packages, dependencyBundleSha256, dependencyByteLength };
}

/** 纯合成测试/部署预检入口；只返回不含文件内容与路径的运行依赖身份。 */
export function verifyReviewFlowRuntimeDependencyBundle(input) {
  const manifest = parseReviewFlowRuntimeManifest(input.manifestBytes);
  const loaded = loadRuntimeDependencies(
    realpathSync(input.repositoryDirectory),
    manifest
  );
  return Object.freeze({
    dependencyBundleSha256: loaded.dependencyBundleSha256,
    dependencyFileCount: loaded.allFiles.length,
    dependencyByteLength: loaded.dependencyByteLength,
    packages: loaded.packages
  });
}

function loadNodeExecutable(nodeExecutablePath, manifest) {
  let canonical;
  try {
    canonical = realpathSync(nodeExecutablePath);
  } catch {
    failBootstrap();
  }
  const opened = readStableOwnedFile(canonical);
  const sha256 = createHash("sha256").update(opened.bytes).digest("hex");
  if (
    process.versions.node !== manifest.runtime.node.version ||
    process.platform !== manifest.runtime.node.platform ||
    process.arch !== manifest.runtime.node.arch ||
    sha256 !== manifest.runtime.node.sha256 ||
    opened.bytes.byteLength !== manifest.runtime.node.byteLength ||
    !opened.executable
  ) {
    failBootstrap();
  }
  return {
    path: canonical,
    bytes: opened.bytes,
    executable: true,
    snapshot: opened.snapshot,
    sha256
  };
}

function trustedTemporaryRoot(repositoryDirectory) {
  const containingWorkspace = realpathSync(resolve(repositoryDirectory, ".."));
  const privateRoot = resolve(repositoryDirectory, "private");
  const handle = preparePrivateDirectory(
    resolve(privateRoot, "review-flow-runtime-snapshots"),
    { privateRoot, containingWorkspace }
  );
  try {
    return realpathSync(`/proc/self/fd/${handle.descriptor}`);
  } finally {
    closePrivateDirectory(handle);
  }
}

function loadTrackedCode(repositoryDirectory, expectedCodeVersion) {
  return withTrustedGitSnapshot(repositoryDirectory, (git) => {
    if (git.headCodeVersion !== expectedCodeVersion) failBootstrap();
    const status = git.run(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { encoding: "utf8" }
    );
    if (status.length !== 0 || git.run(["ls-files", "private"], { encoding: "utf8" }).length !== 0) {
      failBootstrap();
    }
    for (const arguments_ of [
      ["ls-files", "-v", "-z"],
      ["ls-files", "-f", "-z"]
    ]) {
      const entries = git.run(arguments_).toString("utf8").split("\0");
      if (entries.some((entry) => entry.length > 0 && !entry.startsWith("H "))) {
        failBootstrap();
      }
    }
    const manifestBytes = git.run(["show", `HEAD:${reviewFlowRuntimeManifestPath}`]);
    const manifest = parseReviewFlowRuntimeManifest(manifestBytes);
    git.run([
      "ls-files",
      "--error-unmatch",
      "--",
      ...manifest.codePaths
    ]);
    const files = manifest.codePaths.map((path) => {
      const absolutePath = resolve(repositoryDirectory, path);
      assertPathInside(repositoryDirectory, absolutePath);
      const working = readStableOwnedFile(absolutePath);
      const headBytes = git.run(["show", `HEAD:${path}`]);
      if (!working.bytes.equals(headBytes)) failBootstrap();
      return {
        path,
        bytes: Buffer.from(headBytes),
        executable: working.executable,
        originPath: absolutePath,
        originSnapshot: working.snapshot
      };
    });
    const packageLock = files.find((file) => file.path === "package-lock.json");
    if (packageLock === undefined) failBootstrap();
    assertReviewFlowRuntimeSourceBindings(manifest, packageLock.bytes);
    const productionFiles = files.filter((file) =>
      manifest.productionCodePaths.includes(file.path)
    );
    const runner = files.find((file) => file.path === manifest.runnerPath);
    if (runner === undefined || productionFiles.length !== manifest.productionCodePaths.length) {
      failBootstrap();
    }
    return {
      manifest,
      files,
      codeIdentity: Object.freeze({
        codeVersion: expectedCodeVersion,
        runnerSha256: createHash("sha256").update(runner.bytes).digest("hex"),
        dependencyCodeSha256: hashCodeBundle(files),
        dependencyFileCount: files.length,
        productionDependencyCodeSha256: hashCodeBundle(productionFiles),
        productionDependencyFileCount: productionFiles.length
      })
    };
  }, { temporaryRoot: trustedTemporaryRoot(repositoryDirectory) });
}

function writeSnapshotFile(root, relativePath, bytes, executable) {
  const destination = resolve(root, relativePath);
  assertPathInside(root, destination);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, bytes, {
    flag: "wx",
    mode: executable ? 0o500 : 0o400
  });
  chmodSync(destination, executable ? 0o500 : 0o400);
  return destination;
}

function createSnapshotDirectory(repositoryDirectory, temporaryRoot) {
  let directory;
  if (temporaryRoot !== undefined) {
    const root = realpathSync(temporaryRoot);
    directory = mkdtempSync(join(root, "fermata-review-runtime-"));
  } else {
    const containingWorkspace = realpathSync(resolve(repositoryDirectory, ".."));
    const privateRoot = resolve(repositoryDirectory, "private");
    const parent = preparePrivateDirectory(
      resolve(privateRoot, "review-flow-runtime-snapshots"),
      { privateRoot, containingWorkspace }
    );
    try {
      directory = mkdtempSync(
        `/proc/self/fd/${parent.descriptor}/fermata-review-runtime-`
      );
      directory = realpathSync(directory);
    } finally {
      closePrivateDirectory(parent);
    }
  }
  chmodSync(directory, 0o700);
  const status = lstatSync(directory, { bigint: true });
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (status.mode & 0o777n) !== 0o700n ||
    (typeof process.getuid === "function" &&
      status.uid !== BigInt(process.getuid()))
  ) {
    failBootstrap();
  }
  return { directory, status };
}

function hashSnapshotFiles(files) {
  return hashRuntimeFiles(files.map((file) => ({
    path: file.snapshotPath,
    bytes: file.bytes,
    executable: file.executable
  })));
}

function verifySnapshotBytes(snapshot) {
  const reread = snapshot.snapshotFiles.map((file) => {
    const opened = readStableOwnedFile(resolve(snapshot.directory, file.snapshotPath));
    if (opened.executable !== file.executable || !opened.bytes.equals(file.bytes)) {
      failBootstrap();
    }
    return { ...file, bytes: opened.bytes };
  });
  if (hashSnapshotFiles(reread) !== snapshot.snapshotSha256) failBootstrap();
}

export function verifyReviewFlowOriginFiles(files) {
  if (!Array.isArray(files) || files.length === 0) failBootstrap();
  for (const file of files) {
    const reopened = readStableOwnedFile(file.originPath);
    if (
      !sameFileSnapshot(file.originSnapshot, reopened.snapshot) ||
      !file.bytes.equals(reopened.bytes)
    ) {
      failBootstrap();
    }
  }
}

function verifyOriginRuntime(snapshot) {
  const node = readStableOwnedFile(snapshot.nodeOrigin.path);
  if (
    !sameFileSnapshot(snapshot.nodeOrigin.snapshot, node.snapshot) ||
    !node.bytes.equals(snapshot.nodeOrigin.bytes)
  ) {
    failBootstrap();
  }
  verifyReviewFlowOriginFiles(snapshot.runtimeOriginFiles);
  verifyReviewFlowOriginFiles(snapshot.trackedOriginFiles);
}

export function prepareReviewFlowRuntimeSnapshot(input) {
  const repositoryDirectory = realpathSync(input.repositoryDirectory);
  const tracked = loadTrackedCode(repositoryDirectory, input.expectedCodeVersion);
  const runtime = loadRuntimeDependencies(repositoryDirectory, tracked.manifest);
  const nodeOrigin = loadNodeExecutable(input.nodeExecutablePath, tracked.manifest);
  const createdDirectory = createSnapshotDirectory(
    repositoryDirectory,
    input.temporaryRoot
  );
  const directory = createdDirectory.directory;
  const snapshotFiles = [];
  try {
    for (const file of tracked.files) {
      writeSnapshotFile(directory, file.path, file.bytes, false);
      snapshotFiles.push({
        snapshotPath: file.path,
        bytes: file.bytes,
        executable: false
      });
    }
    for (const file of runtime.allFiles) {
      writeSnapshotFile(directory, file.path, file.bytes, file.executable);
      snapshotFiles.push({
        snapshotPath: file.path,
        bytes: file.bytes,
        executable: file.executable
      });
    }
    const snapshotNodePath = "runtime/node";
    const nodePath = writeSnapshotFile(
      directory,
      snapshotNodePath,
      nodeOrigin.bytes,
      true
    );
    snapshotFiles.push({
      snapshotPath: snapshotNodePath,
      bytes: nodeOrigin.bytes,
      executable: true
    });
    const moduleGuardPath = "runtime/module-boundary-guard.mjs";
    const moduleGuardBytes = Buffer.from(
      reviewFlowModuleBoundaryGuardSource,
      "utf8"
    );
    writeSnapshotFile(directory, moduleGuardPath, moduleGuardBytes, false);
    snapshotFiles.push({
      snapshotPath: moduleGuardPath,
      bytes: moduleGuardBytes,
      executable: false
    });
    const runtimeHomeDirectory = resolve(directory, "runtime/home");
    const runtimeTemporaryDirectory = resolve(directory, "runtime/tmp");
    mkdirSync(runtimeHomeDirectory, { recursive: false, mode: 0o700 });
    mkdirSync(runtimeTemporaryDirectory, { recursive: false, mode: 0o700 });
    chmodSync(runtimeHomeDirectory, 0o700);
    chmodSync(runtimeTemporaryDirectory, 0o700);
    const snapshotSha256 = hashSnapshotFiles(snapshotFiles);
    const runtimeIdentity = Object.freeze({
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      packageLockSha256: createHash("sha256")
        .update(tracked.files.find((file) => file.path === "package-lock.json").bytes)
        .digest("hex"),
      nodeExecutableSha256: nodeOrigin.sha256,
      nodeExecutableByteLength: nodeOrigin.bytes.byteLength,
      dependencyBundleSha256: runtime.dependencyBundleSha256,
      dependencyFileCount: runtime.allFiles.length,
      dependencyByteLength: runtime.dependencyByteLength,
      snapshotSha256,
      snapshotFileCount: snapshotFiles.length,
      packages: runtime.packages,
      trustModel:
        "trusted_bootstrap_same_uid_non_adversarial_trusted_host_system_runtime_unbound_v1"
    });
    const snapshot = {
      directory,
      nodePath,
      moduleGuardPath: resolve(directory, moduleGuardPath),
      runtimeHomeDirectory,
      runtimeTemporaryDirectory,
      runnerPath: resolve(directory, tracked.manifest.runnerPath),
      loaderPath: resolve(directory, "node_modules/tsx/dist/loader.mjs"),
      codeIdentity: tracked.codeIdentity,
      runtimeIdentity,
      snapshotFiles,
      snapshotSha256,
      nodeOrigin,
      runtimeOriginFiles: runtime.allFiles,
      trackedOriginFiles: tracked.files,
      repositoryDirectory,
      workspaceDirectory: realpathSync(resolve(repositoryDirectory, "..")),
      expectedCodeVersion: input.expectedCodeVersion,
      directorySnapshot: createdDirectory.status
    };
    verifySnapshotBytes(snapshot);
    return snapshot;
  } catch {
    try {
      cleanupReviewFlowRuntimeSnapshot({
        directory,
        directorySnapshot: createdDirectory.status
      });
    } catch {
      // 临时根由本进程唯一创建；对外仍只报告固定错误。
    }
    failBootstrap();
  }
}

export function verifyReviewFlowRuntimeSnapshot(snapshot) {
  verifySnapshotBytes(snapshot);
  verifyOriginRuntime(snapshot);
  const tracked = loadTrackedCode(
    snapshot.repositoryDirectory,
    snapshot.expectedCodeVersion
  );
  if (
    JSON.stringify(tracked.codeIdentity) !== JSON.stringify(snapshot.codeIdentity)
  ) {
    failBootstrap();
  }
}

export function cleanupReviewFlowRuntimeSnapshot(snapshot) {
  try {
    const canonical = realpathSync(snapshot.directory);
    const current = lstatSync(canonical, { bigint: true });
    if (
      canonical !== snapshot.directory ||
      !resolve(canonical).split(sep).at(-1)?.startsWith("fermata-review-runtime-") ||
      !sameDirectoryIdentity(snapshot.directorySnapshot, current) ||
      !current.isDirectory() ||
      (current.mode & 0o777n) !== 0o700n
    ) {
      failBootstrap();
    }
    rmSync(canonical, { recursive: true, force: false });
  } catch {
    failBootstrap();
  }
}

function buildChildAttestation(snapshot) {
  return JSON.stringify({
    schemaVersion: 1,
    launchNonce: randomBytes(32).toString("hex"),
    snapshotRoot: snapshot.directory,
    originRepositoryRoot: snapshot.repositoryDirectory,
    originWorkspaceRoot: snapshot.workspaceDirectory,
    codeIdentity: snapshot.codeIdentity,
    runtimeIdentity: snapshot.runtimeIdentity
  });
}

export function buildReviewFlowSnapshotChildEnvironment(
  snapshot,
  environment,
  attestation
) {
  return {
    ...environment,
    HOME: snapshot.runtimeHomeDirectory,
    TEMP: snapshot.runtimeTemporaryDirectory,
    TMP: snapshot.runtimeTemporaryDirectory,
    TMPDIR: snapshot.runtimeTemporaryDirectory,
    [reviewFlowRuntimeAttestationEnvironmentKey]: attestation
  };
}

function parseChildCount(value) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) failBootstrap();
  const count = Number(value);
  if (!Number.isSafeInteger(count)) failBootstrap();
  return count;
}

function formatSafeChildProtocol(payload) {
  return `FERMATA_REVIEW_FLOW_RESULT ${JSON.stringify({
    schemaVersion: 1,
    ...payload,
    eligible: false
  })}\n`;
}

const childProtocolTokenPatterns = Object.freeze([
  [
    { literal: "11 角色 development 实验已私有封存：标签 " },
    { kind: "label" },
    { literal: "，完成 " },
    { kind: "count" },
    { literal: "/" },
    { kind: "count" },
    { literal: "，完整=" },
    { choices: ["是", "否"] },
    { literal: "，可用资格=否。\n" }
  ],
  [
    { literal: "11 角色 holdout 预测链已私有封存：标签 " },
    { kind: "label" },
    { literal: "，完成 " },
    { kind: "count" },
    { literal: "/" },
    { kind: "count" },
    { literal: "；尚未读取 Gold、尚未计分、可用资格=否。\n" }
  ],
  [
    { literal: "11 角色 holdout 预测链不完整并已永久封存：标签 " },
    { kind: "label" },
    { literal: "；未读取 Gold、不可 reveal、可用资格=否。\n" }
  ],
  [
    { literal: "holdout 已一次性揭盲并私有封存基线、候选和对比报告：" },
    { kind: "count" },
    { literal: " 个样本，报告完整=是，可用资格=否。\n" }
  ]
]);

function isPrefixOfTokenPattern(value, tokens, tokenIndex = 0, offset = 0) {
  if (offset === value.length) return true;
  if (tokenIndex === tokens.length) return false;
  const token = tokens[tokenIndex];
  if (token.literal !== undefined) {
    const remaining = value.slice(offset);
    if (token.literal.startsWith(remaining)) return true;
    if (!value.startsWith(token.literal, offset)) return false;
    return isPrefixOfTokenPattern(
      value,
      tokens,
      tokenIndex + 1,
      offset + token.literal.length
    );
  }
  if (token.choices !== undefined) {
    return token.choices.some((choice) => isPrefixOfTokenPattern(
      value,
      [
        { literal: choice },
        ...tokens.slice(tokenIndex + 1)
      ],
      0,
      offset
    ));
  }
  const start = offset;
  if (token.kind === "label") {
    if (!/[A-Za-z0-9]/u.test(value[offset])) return false;
    while (
      offset < value.length &&
      /[A-Za-z0-9._-]/u.test(value[offset]) &&
      offset - start < 64
    ) {
      offset += 1;
    }
    if (offset === value.length) return offset > start;
    if (
      offset === start ||
      !/[A-Za-z0-9]/u.test(value[start]) ||
      offset - start > 64 ||
      /[A-Za-z0-9._-]/u.test(value[offset])
    ) {
      return false;
    }
  } else if (token.kind === "count") {
    while (offset < value.length && /[0-9]/u.test(value[offset])) offset += 1;
    const digits = value.slice(start, offset);
    if (
      digits.length === 0 ||
      (digits.length > 1 && digits.startsWith("0")) ||
      digits.length > 16 ||
      Number(digits) > Number.MAX_SAFE_INTEGER
    ) {
      return false;
    }
    if (offset === value.length) return true;
  } else {
    return false;
  }
  return isPrefixOfTokenPattern(value, tokens, tokenIndex + 1, offset);
}

export function isReviewFlowChildProtocolPrefix(value) {
  return typeof value === "string" && childProtocolTokenPatterns.some(
    (tokens) => isPrefixOfTokenPattern(value, tokens)
  );
}

export function createReviewFlowBootstrapSignalController() {
  let child;
  let requestedSignal = null;
  let forwarded = false;
  const forwardOnce = () => {
    if (child === undefined || requestedSignal === null || forwarded) return;
    forwarded = true;
    try {
      child.kill(requestedSignal);
    } catch {
      // 只折叠成 bootstrap 固定失败；父进程仍等待直接 child 收口。
    }
  };
  return {
    get closed() {
      return requestedSignal !== null;
    },
    request(signal) {
      if (!forwardedSignals.includes(signal) || requestedSignal !== null) return;
      requestedSignal = signal;
      forwardOnce();
    },
    attach(attachedChild) {
      if (child !== undefined) failBootstrap();
      child = attachedChild;
      forwardOnce();
    }
  };
}

export function installReviewFlowBootstrapSignalHandlers(
  controller,
  processTarget = process
) {
  const handlers = new Map(
    forwardedSignals.map((signal) => [signal, () => controller.request(signal)])
  );
  for (const [signal, handler] of handlers) processTarget.on(signal, handler);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    for (const [signal, handler] of handlers) processTarget.off(signal, handler);
  };
}

/**
 * 子进程 stdout 不是日志通道。只接受 runner 当前定义的单行完成协议，再转换为
 * 不含 label、路径或模型内容的固定 JSON；stderr 必须为空。
 */
export function parseReviewFlowChildProtocolOutput(stdoutBytes, stderrBytes) {
  if (
    !Buffer.isBuffer(stdoutBytes) ||
    !Buffer.isBuffer(stderrBytes) ||
    stdoutBytes.byteLength === 0 ||
    stdoutBytes.byteLength > maximumChildOutputBytes ||
    stderrBytes.byteLength !== 0
  ) {
    failBootstrap();
  }
  let output;
  try {
    output = new TextDecoder("utf-8", { fatal: true }).decode(stdoutBytes);
  } catch {
    failBootstrap();
  }
  const label = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
  let match = new RegExp(
    `^11 角色 development 实验已私有封存：标签 (${label})，完成 ((?:0|[1-9][0-9]*))/((?:0|[1-9][0-9]*))，完整=(是|否)，可用资格=否。\\n$`,
    "u"
  ).exec(output);
  if (match !== null) {
    const completed = parseChildCount(match[2]);
    const expected = parseChildCount(match[3]);
    const complete = match[4] === "是";
    if (completed > expected || (complete && completed !== expected)) {
      failBootstrap();
    }
    return formatSafeChildProtocol({
      event: "development_report_published",
      completed,
      expected,
      complete,
      scored: true
    });
  }
  match = new RegExp(
    `^11 角色 holdout 预测链已私有封存：标签 (${label})，完成 ((?:0|[1-9][0-9]*))/((?:0|[1-9][0-9]*))；尚未读取 Gold、尚未计分、可用资格=否。\\n$`,
    "u"
  ).exec(output);
  if (match !== null) {
    const completed = parseChildCount(match[2]);
    const expected = parseChildCount(match[3]);
    if (completed !== expected) failBootstrap();
    return formatSafeChildProtocol({
      event: "holdout_prediction_published",
      completed,
      expected,
      complete: true,
      scored: false
    });
  }
  match = new RegExp(
    `^11 角色 holdout 预测链不完整并已永久封存：标签 (${label})；未读取 Gold、不可 reveal、可用资格=否。\\n$`,
    "u"
  ).exec(output);
  if (match !== null) {
    return formatSafeChildProtocol({
      event: "holdout_prediction_incomplete",
      completed: null,
      expected: null,
      complete: false,
      scored: false
    });
  }
  match = /^holdout 已一次性揭盲并私有封存基线、候选和对比报告：((?:0|[1-9][0-9]*)) 个样本，报告完整=是，可用资格=否。\n$/u.exec(
    output
  );
  if (match !== null) {
    const count = parseChildCount(match[1]);
    if (count === 0) failBootstrap();
    return formatSafeChildProtocol({
      event: "holdout_reports_revealed",
      completed: count,
      expected: count,
      complete: true,
      scored: true
    });
  }
  failBootstrap();
}

export async function runReviewFlowSnapshotChild(
  snapshot,
  argv,
  environment,
  signalController = createReviewFlowBootstrapSignalController()
) {
  if (signalController.closed) failBootstrap();
  let child;
  try {
    child = spawn(
      snapshot.nodePath,
      [
        "--import",
        pathToFileURL(snapshot.moduleGuardPath).href,
        "--import",
        pathToFileURL(snapshot.loaderPath).href,
        snapshot.runnerPath,
        ...argv
      ],
      {
        cwd: snapshot.directory,
        env: buildReviewFlowSnapshotChildEnvironment(
          snapshot,
          environment,
          buildChildAttestation(snapshot)
        ),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
  } catch {
    failBootstrap();
  }
  signalController.attach(child);
  return await new Promise((resolvePromise, rejectPromise) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutDecoder = new TextDecoder("utf-8", { fatal: true });
    let stdoutText = "";
    let outputByteLength = 0;
    let outputLimitExceeded = false;
    let protocolViolation = false;
    let settled = false;
    const rejectFixed = () => {
      if (settled) return;
      settled = true;
      rejectPromise(new Error("REVIEW_FLOW_RUNTIME_BOOTSTRAP_FAILED"));
    };
    const closeStartGate = () => {
      protocolViolation = true;
      signalController.request("SIGTERM");
    };
    const collect = (chunks, chunk, stream) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stream === "stderr") closeStartGate();
      outputByteLength += bytes.byteLength;
      if (outputByteLength > maximumChildOutputBytes) {
        outputLimitExceeded = true;
        closeStartGate();
        return;
      }
      chunks.push(Buffer.from(bytes));
      if (stream === "stdout" && !protocolViolation) {
        try {
          stdoutText += stdoutDecoder.decode(bytes, { stream: true });
          if (!isReviewFlowChildProtocolPrefix(stdoutText)) closeStartGate();
        } catch {
          closeStartGate();
        }
      }
    };
    child.stdout.on("data", (chunk) => collect(stdoutChunks, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderrChunks, chunk, "stderr"));
    child.once("error", rejectFixed);
    child.once("close", (code, signal) => {
      if (settled) return;
      try {
        stdoutText += stdoutDecoder.decode();
        if (!isReviewFlowChildProtocolPrefix(stdoutText)) protocolViolation = true;
      } catch {
        protocolViolation = true;
      }
      if (
        outputLimitExceeded ||
        protocolViolation ||
        signalController.closed ||
        signal !== null ||
        code !== 0
      ) {
        rejectFixed();
        return;
      }
      try {
        const safeOutput = parseReviewFlowChildProtocolOutput(
          Buffer.concat(stdoutChunks),
          Buffer.concat(stderrChunks)
        );
        settled = true;
        resolvePromise(safeOutput);
      } catch {
        rejectFixed();
      }
    });
  });
}

export async function runReviewFlowEvaluationBootstrap(input = {}) {
  const environment = input.environment ?? process.env;
  assertBootstrapEnvironment(environment);
  const signalController =
    input.signalController ?? createReviewFlowBootstrapSignalController();
  const snapshot = prepareReviewFlowRuntimeSnapshot({
    repositoryDirectory: input.repositoryDirectory ?? repositoryRoot,
    expectedCodeVersion: environment.EVAL_CODE_VERSION,
    nodeExecutablePath: input.nodeExecutablePath ?? process.execPath,
    temporaryRoot: input.temporaryRoot
  });
  let safeOutput;
  let childFailed = false;
  let verified = false;
  try {
    // 让准备 snapshot 期间送达 bootstrap PID 的信号先关闭启动闸门。
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    if (signalController.closed) {
      childFailed = true;
    } else {
      try {
        safeOutput = await (input.runChild ?? runReviewFlowSnapshotChild)(
          snapshot,
          input.argv ?? process.argv.slice(2),
          environment,
          signalController
        );
        if (typeof safeOutput !== "string") childFailed = true;
      } catch {
        childFailed = true;
      }
    }
    // child 成功、失败或被信号关闸都必须复核原始/快照身份后再清理。
    verifyReviewFlowRuntimeSnapshot(snapshot);
    verified = true;
  } finally {
    cleanupReviewFlowRuntimeSnapshot(snapshot);
  }
  if (!verified || childFailed || typeof safeOutput !== "string") {
    failBootstrap();
  }
  return safeOutput;
}

function isDirectEntry() {
  return process.argv[1] !== undefined &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectEntry()) {
  const signalController = createReviewFlowBootstrapSignalController();
  const removeSignalHandlers = installReviewFlowBootstrapSignalHandlers(
    signalController
  );
  runReviewFlowEvaluationBootstrap({ signalController })
    .then((safeOutput) => {
      process.stdout.write(safeOutput);
    })
    .catch(() => {
      process.stderr.write("11 角色审题实验未能通过可信运行时启动。\n");
      process.exitCode = 1;
    })
    .finally(removeSignalHandlers);
}

export const reviewFlowRuntimeBootstrapWorkspaceRoot = workspaceRoot;
