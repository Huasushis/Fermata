#!/usr/bin/node
/**
 * 从官方 Node 归档和 package-lock 的完整性绑定独立重建 review-flow 运行时。
 *
 * 这个审阅工具固定由系统 Node 运行，不 import 项目包，也绝不执行 npm lifecycle
 * script。默认只比较已跟踪 manifest；`--proposal` 只把安全 runtime 候选写到
 * stdout，调用方仍须人工审阅并用 apply_patch 更新正式文件。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..")
);
const workspaceRoot = realpathSync(resolve(repositoryRoot, ".."));
const projectCacheRoot = resolve(workspaceRoot, ".cache");
const manifestPath = resolve(repositoryRoot, "config/review-flow-runtime.json");
const packageJsonPath = resolve(repositoryRoot, "package.json");
const packageLockPath = resolve(repositoryRoot, "package-lock.json");
const fixedSystemNode = "/usr/bin/node";
const fixedNpmCli = "/usr/lib/node_modules/npm/bin/npm-cli.js";
const fixedTar = "/usr/bin/tar";
const fixedGit = "/usr/bin/git";
const fixedCurl = "/usr/bin/curl";
const requiredPackageNames = Object.freeze([
  "tsx",
  "esbuild",
  "@esbuild/linux-x64",
  "undici",
  "zod"
]);
const proxyEnvironmentKeys = Object.freeze([
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy"
]);
const digestPattern = /^[0-9a-f]{64}$/u;
const integrityPattern = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const packageNamePattern = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u;
const runtimeIdentifierPattern = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,119}$/u;
const gitCommitPattern = /^[0-9a-f]{40}$/u;
const maximumSourceFileBytes = 192 * 1024 * 1024;
const maximumPackageFileCount = 2_048;
const maximumPackageByteLength = 64 * 1024 * 1024;
const maximumBundleFileCount = 4_096;
const maximumBundleByteLength = 128 * 1024 * 1024;
export const reviewFlowRuntimeFreshInstallArguments = Object.freeze([
  fixedNpmCli,
  "ci",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund"
]);

function failVerification() {
  throw new Error("REVIEW_FLOW_RUNTIME_MANIFEST_VERIFICATION_FAILED");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map((entry) => stableJson(entry));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableJson(value[key])])
  );
}

function isStrictDescendant(parent, candidate) {
  const fromParent = relative(parent, candidate);
  return fromParent !== "" &&
    fromParent !== ".." &&
    !fromParent.startsWith(`..${sep}`) &&
    !isAbsolute(fromParent);
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

function readStableFile(path, maximumBytes = maximumSourceFileBytes) {
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
      failVerification();
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(before, after) || bytes.byteLength !== Number(before.size)) {
      failVerification();
    }
    return {
      bytes,
      executable: (before.mode & 0o111n) !== 0n,
      snapshot: before
    };
  } catch {
    failVerification();
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 对外只保留固定失败。
      }
    }
  }
}

function parseJson(bytes) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    failVerification();
  }
}

function expectedPackageArchiveUrl(name, version) {
  const leafName = name.split("/").at(-1);
  if (leafName === undefined) failVerification();
  return `https://registry.npmjs.org/${name}/-/${leafName}-${version}.tgz`;
}

function expectedNodeSource(node) {
  const root = `node-v${node.version}-${node.platform}-${node.arch}`;
  return {
    archiveUrl: `https://nodejs.org/dist/v${node.version}/${root}.tar.xz`,
    archiveExecutablePath: `${root}/bin/node`
  };
}

/** 独立解析 source binding；不复用 bootstrap 的 manifest parser。 */
export function parseReviewFlowRuntimeSourceDocuments(manifestBytes, lockBytes) {
  const manifest = parseJson(manifestBytes);
  const lock = parseJson(lockBytes);
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== 1 ||
    !isRecord(manifest.runtime) ||
    !hasExactKeys(manifest.runtime.node, [
      "version",
      "platform",
      "arch",
      "sha256",
      "byteLength",
      "source"
    ]) ||
    !hasExactKeys(manifest.runtime.node.source, [
      "archiveUrl",
      "archiveSha256",
      "archiveExecutablePath"
    ]) ||
    !runtimeIdentifierPattern.test(manifest.runtime.node.version) ||
    !runtimeIdentifierPattern.test(manifest.runtime.node.platform) ||
    !runtimeIdentifierPattern.test(manifest.runtime.node.arch) ||
    !digestPattern.test(manifest.runtime.node.sha256) ||
    !digestPattern.test(manifest.runtime.node.source.archiveSha256) ||
    !Number.isSafeInteger(manifest.runtime.node.byteLength) ||
    manifest.runtime.node.byteLength <= 0 ||
    manifest.runtime.node.byteLength > maximumSourceFileBytes ||
    !Array.isArray(manifest.runtime.packages) ||
    manifest.runtime.packages.length !== requiredPackageNames.length ||
    !isRecord(lock) ||
    lock.lockfileVersion !== 3 ||
    !isRecord(lock.packages)
  ) {
    failVerification();
  }
  const nodeSource = expectedNodeSource(manifest.runtime.node);
  if (
    manifest.runtime.node.source.archiveUrl !== nodeSource.archiveUrl ||
    manifest.runtime.node.source.archiveExecutablePath !==
      nodeSource.archiveExecutablePath
  ) {
    failVerification();
  }

  const seen = new Set();
  for (let index = 0; index < requiredPackageNames.length; index += 1) {
    const package_ = manifest.runtime.packages[index];
    const expectedName = requiredPackageNames[index];
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
      package_.name !== expectedName ||
      !packageNamePattern.test(package_.name) ||
      seen.has(package_.name) ||
      !runtimeIdentifierPattern.test(package_.version) ||
      package_.resolved !== expectedPackageArchiveUrl(
        package_.name,
        package_.version
      ) ||
      !integrityPattern.test(package_.integrity) ||
      !digestPattern.test(package_.sha256) ||
      !Number.isSafeInteger(package_.fileCount) ||
      package_.fileCount <= 0 ||
      package_.fileCount > maximumPackageFileCount ||
      !Number.isSafeInteger(package_.byteLength) ||
      package_.byteLength <= 0 ||
      package_.byteLength > maximumPackageByteLength
    ) {
      failVerification();
    }
    seen.add(package_.name);
    const locked = lock.packages[`node_modules/${package_.name}`];
    if (
      !isRecord(locked) ||
      locked.version !== package_.version ||
      locked.resolved !== package_.resolved ||
      locked.integrity !== package_.integrity
    ) {
      failVerification();
    }
  }
  return Object.freeze({ manifest, lock });
}

function ensurePrivateCacheRoot() {
  let canonical;
  try {
    canonical = realpathSync(projectCacheRoot);
    const status = lstatSync(canonical, { bigint: true });
    if (
      canonical !== projectCacheRoot ||
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      (status.mode & 0o777n) !== 0o700n ||
      (typeof process.getuid === "function" &&
        status.uid !== BigInt(process.getuid()))
    ) {
      failVerification();
    }
  } catch {
    failVerification();
  }
  return canonical;
}

function createVerificationDirectory() {
  const parent = ensurePrivateCacheRoot();
  const directory = mkdtempSync(join(parent, "fermata-runtime-verify-"));
  chmodSync(directory, 0o700);
  const snapshot = lstatSync(directory, { bigint: true });
  if (!snapshot.isDirectory() || (snapshot.mode & 0o777n) !== 0o700n) {
    failVerification();
  }
  return { directory: realpathSync(directory), snapshot };
}

function cleanupVerificationDirectory(handle) {
  try {
    const canonical = realpathSync(handle.directory);
    const current = lstatSync(canonical, { bigint: true });
    if (
      canonical !== handle.directory ||
      dirname(canonical) !== projectCacheRoot ||
      !basename(canonical).startsWith("fermata-runtime-verify-") ||
      !current.isDirectory() ||
      current.dev !== handle.snapshot.dev ||
      current.ino !== handle.snapshot.ino ||
      current.uid !== handle.snapshot.uid ||
      current.gid !== handle.snapshot.gid ||
      (current.mode & 0o777n) !== 0o700n
    ) {
      failVerification();
    }
    rmSync(canonical, { recursive: true, force: false });
  } catch {
    failVerification();
  }
}

function makePrivateDirectory(path) {
  mkdirSync(path, { recursive: false, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writeExclusiveFile(path, bytes, mode = 0o600) {
  writeFileSync(path, bytes, { flag: "wx", mode });
  chmodSync(path, mode);
}

function buildChildEnvironment(home, temporaryDirectory, npmCache) {
  const environment = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    NODE_OPTIONS: "",
    NODE_PATH: "",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_GLOBALCONFIG: resolve(home, "global.npmrc"),
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    NPM_CONFIG_USERCONFIG: resolve(home, "user.npmrc")
  };
  for (const key of proxyEnvironmentKeys) {
    const value = process.env[key];
    if (typeof value === "string" && !value.includes("\0")) {
      environment[key] = value;
    }
  }
  return environment;
}

export function buildReviewFlowRuntimeGitEnvironment(childEnvironment) {
  return {
    PATH: "/usr/bin:/bin",
    HOME: childEnvironment.HOME,
    TEMP: childEnvironment.TEMP,
    TMP: childEnvironment.TMP,
    TMPDIR: childEnvironment.TMPDIR,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: childEnvironment.TZ,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_EXTERNAL_DIFF: "",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0"
  };
}

function runFixed(command, arguments_, options) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    env: options.environment,
    shell: false,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "ignore",
    encoding: options.capture && options.binary !== true ? "utf8" : undefined,
    timeout: options.timeout ?? 10 * 60 * 1_000,
    maxBuffer: options.capture ? 64 * 1024 : undefined
  });
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    failVerification();
  }
  return result;
}

function runFixedGit(arguments_, options) {
  return runFixed(
    fixedGit,
    ["--no-pager", "--no-replace-objects", ...arguments_],
    options
  );
}

function readRepositoryIdentity(environment) {
  const topLevel = runFixedGit(["rev-parse", "--show-toplevel"], {
    cwd: repositoryRoot,
    environment,
    capture: true,
    timeout: 30_000
  }).stdout.trim();
  const commit = runFixedGit(["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: repositoryRoot,
    environment,
    capture: true,
    timeout: 30_000
  }).stdout.trim();
  if (
    realpathSync(topLevel) !== repositoryRoot ||
    !gitCommitPattern.test(commit) ||
    commit === "0".repeat(40)
  ) {
    failVerification();
  }
  return { topLevel, commit };
}

export function assertReviewFlowRuntimeCommitIdentity(initial, current) {
  if (
    !isRecord(initial) ||
    !isRecord(current) ||
    !gitCommitPattern.test(initial.commit) ||
    initial.commit === "0".repeat(40) ||
    initial.commit !== current.commit ||
    initial.topLevel !== current.topLevel
  ) {
    failVerification();
  }
}

export function assertReviewFlowRuntimeWorkingBytes(workingBytes, headBytes) {
  if (
    !Buffer.isBuffer(workingBytes) ||
    !Buffer.isBuffer(headBytes) ||
    !workingBytes.equals(headBytes)
  ) {
    failVerification();
  }
}

function readHeadBoundWorkingFile(
  path,
  repositoryPath,
  repositoryIdentity,
  environment
) {
  if (realpathSync(path) !== path) failVerification();
  const working = readStableFile(path);
  const result = runFixedGit(
    ["show", `${repositoryIdentity.commit}:${repositoryPath}`],
    {
      cwd: repositoryRoot,
      environment,
      capture: true,
      binary: true,
      timeout: 30_000
    }
  );
  assertReviewFlowRuntimeWorkingBytes(working.bytes, result.stdout);
  return { ...working, path };
}

function assertVerifierHeadBinding(repositoryIdentity, environment) {
  const verifierPath = fileURLToPath(import.meta.url);
  return readHeadBoundWorkingFile(
    verifierPath,
    "scripts/verify-review-flow-runtime-manifest.mjs",
    repositoryIdentity,
    environment
  );
}

function verifyOriginBinding(binding) {
  const reopened = readStableFile(binding.path);
  if (
    !sameFileSnapshot(binding.snapshot, reopened.snapshot) ||
    !binding.bytes.equals(reopened.bytes)
  ) {
    failVerification();
  }
}

export function normalizeReviewFlowEsbuildBinary(installRoot) {
  const sourcePath = resolve(
    installRoot,
    "node_modules/@esbuild/linux-x64/bin/esbuild"
  );
  const destinationPath = resolve(
    installRoot,
    "node_modules/esbuild/bin/esbuild"
  );
  const source = readStableFile(sourcePath, maximumPackageByteLength);
  const destination = readStableFile(destinationPath, maximumPackageByteLength);
  if (
    !source.executable ||
    destination.bytes.equals(source.bytes) ||
    !destination.bytes.subarray(0, 2).equals(Buffer.from("#!"))
  ) {
    // `npm ci --ignore-scripts` 必须保留 npm 归档里的 JS launcher；若它已经被
    // postinstall 改成平台 binary，说明 lifecycle 边界没有生效。
    failVerification();
  }
  let descriptor;
  try {
    descriptor = openSync(
      destinationPath,
      constants.O_WRONLY |
        constants.O_TRUNC |
        (constants.O_NOFOLLOW ?? 0)
    );
    writeSync(descriptor, source.bytes, 0, source.bytes.byteLength, 0);
    fchmodSync(descriptor, 0o755);
    const after = fstatSync(descriptor, { bigint: true });
    if (!after.isFile() || after.size !== BigInt(source.bytes.byteLength)) {
      failVerification();
    }
  } catch {
    failVerification();
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 后续逐字节复核会固定失败。
      }
    }
  }
  const normalized = readStableFile(destinationPath, maximumPackageByteLength);
  if (!normalized.executable || !normalized.bytes.equals(source.bytes)) {
    failVerification();
  }
}

export function assertReviewFlowNodeArchiveBytes(node, archiveBytes) {
  if (
    !isRecord(node) ||
    !isRecord(node.source) ||
    !digestPattern.test(node.source.archiveSha256) ||
    createHash("sha256").update(archiveBytes).digest("hex") !==
      node.source.archiveSha256
  ) {
    failVerification();
  }
}

function hashRuntimeFiles(files) {
  const digest = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.path.localeCompare(right.path))) {
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

function collectPackageFiles(installRoot, packageName) {
  const packageRoot = resolve(
    installRoot,
    "node_modules",
    ...packageName.split("/")
  );
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(packageRoot);
    const status = lstatSync(packageRoot, { bigint: true });
    if (
      canonicalRoot !== packageRoot ||
      !status.isDirectory() ||
      status.isSymbolicLink()
    ) {
      failVerification();
    }
  } catch {
    failVerification();
  }
  const files = [];
  let totalBytes = 0;
  const visit = (directory) => {
    let handle;
    try {
      handle = opendirSync(directory);
      while (true) {
        const entry = handle.readSync();
        if (entry === null) break;
        if (entry.name === "." || entry.name === ".." || entry.name.includes("\0")) {
          failVerification();
        }
        const child = join(directory, entry.name);
        if (!isStrictDescendant(canonicalRoot, child)) failVerification();
        if (entry.isDirectory()) {
          const status = lstatSync(child, { bigint: true });
          if (!status.isDirectory() || status.isSymbolicLink()) failVerification();
          visit(child);
        } else if (entry.isFile()) {
          if (files.length >= maximumPackageFileCount) failVerification();
          const remaining = maximumPackageByteLength - totalBytes;
          if (remaining <= 0) failVerification();
          const opened = readStableFile(child, remaining);
          totalBytes += opened.bytes.byteLength;
          if (totalBytes > maximumPackageByteLength) failVerification();
          files.push({
            path: relative(installRoot, child).split(sep).join("/"),
            bytes: opened.bytes,
            executable: opened.executable
          });
        } else {
          failVerification();
        }
      }
    } catch {
      failVerification();
    } finally {
      try {
        handle?.closeSync();
      } catch {
        // 对外只保留固定失败。
      }
    }
  };
  visit(canonicalRoot);
  if (files.length === 0) failVerification();
  return files;
}

function packageVersion(files, packageName) {
  const entry = files.find(
    (file) => file.path === `node_modules/${packageName}/package.json`
  );
  if (entry === undefined) failVerification();
  const metadata = parseJson(entry.bytes);
  if (!isRecord(metadata) || typeof metadata.version !== "string") {
    failVerification();
  }
  return metadata.version;
}

export function buildFreshDependencyIdentity(installRoot, sourceDocument) {
  const allFiles = [];
  const packages = [];
  for (const source of sourceDocument.runtime.packages) {
    const files = collectPackageFiles(installRoot, source.name);
    const byteLength = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    if (packageVersion(files, source.name) !== source.version) failVerification();
    allFiles.push(...files);
    if (
      allFiles.length > maximumBundleFileCount ||
      allFiles.reduce((sum, file) => sum + file.bytes.byteLength, 0) >
        maximumBundleByteLength
    ) {
      failVerification();
    }
    packages.push({
      name: source.name,
      version: source.version,
      resolved: source.resolved,
      integrity: source.integrity,
      sha256: hashRuntimeFiles(files),
      fileCount: files.length,
      byteLength
    });
  }
  return {
    dependencyBundleSha256: hashRuntimeFiles(allFiles),
    dependencyFileCount: allFiles.length,
    dependencyByteLength: allFiles.reduce(
      (sum, file) => sum + file.bytes.byteLength,
      0
    ),
    packages
  };
}

export function assertOfficialNodeChecksumDocument(node, checksumBytes) {
  let checksumText;
  try {
    checksumText = new TextDecoder("utf-8", { fatal: true }).decode(checksumBytes);
  } catch {
    failVerification();
  }
  const archiveName = basename(new URL(node.source.archiveUrl).pathname);
  const matchingLines = checksumText
    .split(/\r?\n/u)
    .filter((line) => line.endsWith(`  ${archiveName}`));
  if (matchingLines.length !== 1) failVerification();
  const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/u.exec(matchingLines[0]);
  if (
    match === null ||
    match[2] !== archiveName ||
    match[1] !== node.source.archiveSha256
  ) {
    failVerification();
  }
}

function verifyOfficialNodeReleaseChecksum(input) {
  const checksumUrl =
    `https://nodejs.org/dist/v${input.node.version}/SHASUMS256.txt`;
  const checksumPath = resolve(input.temporaryDirectory, "SHASUMS256.txt");
  runFixed(
    fixedCurl,
    [
      "--disable",
      "--fail",
      "--silent",
      "--show-error",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--connect-timeout",
      "20",
      "--max-time",
      "60",
      "--max-filesize",
      String(1024 * 1024),
      "--output",
      checksumPath,
      "--url",
      checksumUrl
    ],
    {
      cwd: input.temporaryDirectory,
      environment: input.environment,
      capture: false,
      timeout: 90_000
    }
  );
  chmodSync(checksumPath, 0o600);
  const checksumBytes = readStableFile(checksumPath, 1024 * 1024).bytes;
  assertOfficialNodeChecksumDocument(input.node, checksumBytes);
}

function extractAndVerifyNode(input) {
  verifyOfficialNodeReleaseChecksum({
    node: input.node,
    temporaryDirectory: input.temporaryDirectory,
    environment: input.environment
  });
  const archivePath = realpathSync(input.archivePath);
  if (!isStrictDescendant(workspaceRoot, archivePath)) failVerification();
  const archive = readStableFile(archivePath, maximumSourceFileBytes);
  assertReviewFlowNodeArchiveBytes(input.node, archive.bytes);
  const verifiedArchivePath = resolve(
    input.temporaryDirectory,
    "verified-node-release.tar.xz"
  );
  writeExclusiveFile(verifiedArchivePath, archive.bytes);
  runFixed(
    fixedTar,
    [
      "-xJf",
      verifiedArchivePath,
      "-C",
      input.extractRoot,
      "--no-same-owner",
      "--no-same-permissions"
    ],
    {
      cwd: input.extractRoot,
      environment: input.environment,
      capture: false
    }
  );
  const executablePath = resolve(
    input.extractRoot,
    input.node.source.archiveExecutablePath
  );
  const canonicalExecutable = realpathSync(executablePath);
  if (!isStrictDescendant(input.extractRoot, canonicalExecutable)) {
    failVerification();
  }
  const executable = readStableFile(canonicalExecutable, maximumSourceFileBytes);
  if (!executable.executable) failVerification();
  const version = runFixed(canonicalExecutable, ["--version"], {
    cwd: input.extractRoot,
    environment: input.environment,
    capture: true,
    timeout: 30_000
  });
  if (version.stdout.trim() !== `v${input.node.version}`) failVerification();
  return {
    node: {
      version: input.node.version,
      platform: input.node.platform,
      arch: input.node.arch,
      sha256: createHash("sha256").update(executable.bytes).digest("hex"),
      byteLength: executable.bytes.byteLength,
      source: input.node.source
    },
    archiveOrigin: { ...archive, path: archivePath }
  };
}

function parseArguments(argv) {
  let archivePath;
  let proposal = false;
  for (const argument of argv) {
    if (argument === "--proposal") {
      if (proposal) failVerification();
      proposal = true;
      continue;
    }
    if (argument.startsWith("--node-archive=")) {
      if (archivePath !== undefined) failVerification();
      archivePath = argument.slice("--node-archive=".length);
      continue;
    }
    failVerification();
  }
  if (archivePath === undefined || !isAbsolute(archivePath)) failVerification();
  return { archivePath, proposal };
}

export function formatRuntimeVerificationSummary(runtime) {
  return (
    "review-flow runtime manifest verified: " +
    `${runtime.dependencyFileCount} files, ` +
    `${runtime.dependencyByteLength} bytes, ` +
    `${runtime.dependencyBundleSha256}\n`
  );
}

async function runCli(argv) {
  if (realpathSync(process.execPath) !== fixedSystemNode) failVerification();
  const arguments_ = parseArguments(argv);
  const temporary = createVerificationDirectory();
  let output;
  try {
    const installRoot = resolve(temporary.directory, "install");
    const extractRoot = resolve(temporary.directory, "node-source");
    const home = resolve(temporary.directory, "home");
    const temporaryDirectory = resolve(temporary.directory, "tmp");
    const npmCache = resolve(temporary.directory, "npm-cache");
    for (const directory of [installRoot, extractRoot, home, temporaryDirectory, npmCache]) {
      makePrivateDirectory(directory);
    }
    const childEnvironment = buildChildEnvironment(
      home,
      temporaryDirectory,
      npmCache
    );
    const gitEnvironment = buildReviewFlowRuntimeGitEnvironment(
      childEnvironment
    );
    const repositoryIdentity = readRepositoryIdentity(gitEnvironment);
    const verifierBinding = assertVerifierHeadBinding(
      repositoryIdentity,
      gitEnvironment
    );
    const manifestBinding = readHeadBoundWorkingFile(
      manifestPath,
      "config/review-flow-runtime.json",
      repositoryIdentity,
      gitEnvironment
    );
    const packageJsonBinding = readHeadBoundWorkingFile(
      packageJsonPath,
      "package.json",
      repositoryIdentity,
      gitEnvironment
    );
    const lockBinding = readHeadBoundWorkingFile(
      packageLockPath,
      "package-lock.json",
      repositoryIdentity,
      gitEnvironment
    );
    const { manifest } = parseReviewFlowRuntimeSourceDocuments(
      manifestBinding.bytes,
      lockBinding.bytes
    );
    writeExclusiveFile(
      resolve(installRoot, "package.json"),
      packageJsonBinding.bytes
    );
    writeExclusiveFile(
      resolve(installRoot, "package-lock.json"),
      lockBinding.bytes
    );
    writeExclusiveFile(resolve(home, "user.npmrc"), Buffer.alloc(0));
    writeExclusiveFile(resolve(home, "global.npmrc"), Buffer.alloc(0));
    runFixed(
      fixedSystemNode,
      reviewFlowRuntimeFreshInstallArguments,
      { cwd: installRoot, environment: childEnvironment, capture: false }
    );
    if (
      !readStableFile(resolve(installRoot, "package-lock.json")).bytes.equals(
        lockBinding.bytes
      )
    ) {
      failVerification();
    }
    normalizeReviewFlowEsbuildBinary(installRoot);
    const dependencies = buildFreshDependencyIdentity(installRoot, manifest);
    const verifiedNode = extractAndVerifyNode({
      archivePath: arguments_.archivePath,
      extractRoot,
      temporaryDirectory,
      environment: childEnvironment,
      node: manifest.runtime.node
    });
    const runtime = {
      node: verifiedNode.node,
      ...dependencies
    };
    if (arguments_.proposal) {
      output = `${JSON.stringify(runtime, null, 2)}\n`;
    } else {
      if (
        JSON.stringify(stableJson(runtime)) !==
          JSON.stringify(stableJson(manifest.runtime))
      ) {
        failVerification();
      }
      output = formatRuntimeVerificationSummary(runtime);
    }
    for (const binding of [
      verifierBinding,
      manifestBinding,
      packageJsonBinding,
      lockBinding,
      verifiedNode.archiveOrigin
    ]) {
      verifyOriginBinding(binding);
    }
    assertReviewFlowRuntimeCommitIdentity(
      repositoryIdentity,
      readRepositoryIdentity(gitEnvironment)
    );
  } finally {
    cleanupVerificationDirectory(temporary);
  }
  process.stdout.write(output);
}

function isDirectEntry() {
  return process.argv[1] !== undefined &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectEntry()) {
  runCli(process.argv.slice(2)).catch(() => {
    process.stderr.write("review-flow 运行时来源复核失败。\n");
    process.exitCode = 1;
  });
}
