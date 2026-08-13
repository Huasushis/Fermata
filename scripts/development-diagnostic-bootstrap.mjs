#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const genericCode = "DEVELOPMENT_DIAGNOSTIC_BOOTSTRAP_REJECTED";
const contractFileName = "development-diagnostic-bootstrap-contract.json";
const digestPattern = /^[a-f0-9]{64}$/u;
const entryFiles = Object.freeze([
  "config/models.yaml",
  "config/anchors/difficulty.json",
  "experiments/lib/development-diagnostic-run-state.ts",
  "experiments/lib/development-smoke-launcher.ts",
  "experiments/run-development-diagnostic.ts",
  "scripts/development-diagnostic-bootstrap.mjs",
  "scripts/env-file.mjs",
  "scripts/private-runtime.mjs",
  "scripts/run-with-env.mjs"
]);
const linuxOpenPathFlag = 0o10000000;
const excludedSourceDirectories = new Set([
  "__tests__",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "private",
  "test",
  "tests"
]);
const forbiddenEnvironmentOverrides = Object.freeze([
  "BABEL_ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "TSX_TSCONFIG_PATH",
  "TS_NODE_PROJECT"
]);

function fail() {
  throw new Error(genericCode);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value !== "object") fail();
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(",")}}`;
}

function canonicalDigest(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

function descriptorIdentity(descriptor) {
  const stat = fstatSync(descriptor, { bigint: true });
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    uid: stat.uid,
    gid: stat.gid,
    rdev: stat.rdev,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs
  });
}

function sameIdentity(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.rdev === right.rdev &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function descriptorPath(descriptor, name) {
  return name === undefined
    ? `/proc/self/fd/${descriptor}`
    : `/proc/self/fd/${descriptor}/${name}`;
}

class DescriptorRegistry {
  #descriptors = [];
  #closeDescriptor;

  constructor(closeDescriptor = closeSync) {
    this.#closeDescriptor = closeDescriptor;
  }

  open(path, flags, mode) {
    const descriptor = openSync(path, flags, mode);
    this.#descriptors.push(descriptor);
    return descriptor;
  }

  closeAll() {
    let closeFailed = false;
    while (this.#descriptors.length > 0) {
      const descriptor = this.#descriptors.pop();
      try {
        this.#closeDescriptor(descriptor);
      } catch {
        closeFailed = true;
        try {
          closeSync(descriptor);
        } catch {
          // A second best-effort close is intentionally silent; callers receive one generic error.
        }
      }
    }
    if (closeFailed) fail();
  }
}

function validateModeAndOwner(
  stat,
  allowedOwners,
  expectedType,
  allowOwnerWritableDirectory = false
) {
  const writableDirectoryIsDescriptorBound =
    allowOwnerWritableDirectory &&
    expectedType === "directory" &&
    allowedOwners.length === 1 &&
    stat.uid === allowedOwners[0];
  if (
    ((stat.mode & 0o022n) !== 0n && !writableDirectoryIsDescriptorBound) ||
    !allowedOwners.includes(stat.uid) ||
    (expectedType === "directory" ? !stat.isDirectory() : !stat.isFile())
  ) {
    fail();
  }
}

function openChild(registry, parentDescriptor, name, expectedType, owner) {
  if (name.length === 0 || name === "." || name === ".." || name.includes("/")) fail();
  const descriptor = registry.open(
    descriptorPath(parentDescriptor, name),
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      (expectedType === "directory" ? constants.O_DIRECTORY : 0)
  );
  const stat = fstatSync(descriptor, { bigint: true });
  validateModeAndOwner(
    stat,
    [owner],
    expectedType,
    expectedType === "directory"
  );
  return descriptor;
}

function openUnknownChild(registry, parentDescriptor, name, owner) {
  if (name.length === 0 || name === "." || name === ".." || name.includes("/")) fail();
  const identityDescriptor = registry.open(
    descriptorPath(parentDescriptor, name),
    linuxOpenPathFlag | constants.O_NOFOLLOW
  );
  const identityStat = fstatSync(identityDescriptor, { bigint: true });
  if (
    identityStat.uid !== owner ||
    (!identityStat.isDirectory() && (identityStat.mode & 0o022n) !== 0n) ||
    identityStat.isSymbolicLink() ||
    (!identityStat.isDirectory() && !identityStat.isFile())
  ) {
    fail();
  }
  const expected = descriptorIdentity(identityDescriptor);
  const descriptor = registry.open(
    descriptorPath(identityDescriptor),
    constants.O_RDONLY |
      (identityStat.isDirectory() ? constants.O_DIRECTORY : 0)
  );
  const actual = descriptorIdentity(descriptor);
  if (!sameIdentity(expected, actual)) fail();
  validateModeAndOwner(
    fstatSync(descriptor, { bigint: true }),
    [owner],
    identityStat.isDirectory() ? "directory" : "file",
    identityStat.isDirectory()
  );
  return Object.freeze({
    descriptor,
    type: identityStat.isDirectory() ? "directory" : "file"
  });
}

function revalidateChild(registry, parentDescriptor, name, expected, type, owner) {
  const descriptor = openChild(registry, parentDescriptor, name, type, owner);
  if (!sameIdentity(expected, descriptorIdentity(descriptor))) fail();
}

function readVerifiedFile(input) {
  const before = descriptorIdentity(input.descriptor);
  validateModeAndOwner(
    fstatSync(input.descriptor, { bigint: true }),
    [input.owner],
    "file"
  );
  input.hooks?.beforeFileRead?.({ sourceId: input.sourceId });
  revalidateChild(
    input.registry,
    input.parentDescriptor,
    input.name,
    before,
    "file",
    input.owner
  );
  const bytes = readFileSync(input.descriptor);
  const after = descriptorIdentity(input.descriptor);
  if (!sameIdentity(before, after) || BigInt(bytes.byteLength) !== before.size) fail();
  revalidateChild(
    input.registry,
    input.parentDescriptor,
    input.name,
    before,
    "file",
    input.owner
  );
  input.hooks?.afterFileRead?.({ sourceId: input.sourceId });
  input.hooks?.beforeStageFileWrite?.({ sourceId: input.sourceId });
  revalidateChild(
    input.registry,
    input.parentDescriptor,
    input.name,
    after,
    "file",
    input.owner
  );
  stageVerifiedFile(input.stageRoot, input.sourceId, bytes, Number(before.mode & 0o7777n));
  return bytes;
}

function stagedReadOnlyMode(mode) {
  return (mode & 0o111) === 0 ? 0o400 : 0o500;
}

function stageVerifiedFile(stageRoot, sourceId, bytes, mode) {
  if (stageRoot === undefined) return;
  const destination = resolve(stageRoot, sourceId);
  const relativeDestination = relative(stageRoot, destination);
  if (
    relativeDestination.length === 0 ||
    isAbsolute(relativeDestination) ||
    relativeDestination === ".." ||
    relativeDestination.startsWith(`..${sep}`)
  ) {
    fail();
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const descriptor = openSync(
    destination,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    stagedReadOnlyMode(mode)
  );
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    fchmodSync(descriptor, stagedReadOnlyMode(mode));
  } finally {
    closeSync(descriptor);
  }
}

function walkTree(input, result, include, shouldDescend = () => true) {
  const identity = descriptorIdentity(input.descriptor);
  validateModeAndOwner(
    fstatSync(input.descriptor, { bigint: true }),
    [input.owner],
    "directory",
    true
  );
  input.hooks?.beforeDirectoryRead?.({ sourceId: input.sourceId });
  revalidateChild(
    input.registry,
    input.parentDescriptor,
    input.name,
    identity,
    "directory",
    input.owner
  );
  const names = readdirSync(descriptorPath(input.descriptor))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (!sameIdentity(identity, descriptorIdentity(input.descriptor))) fail();
  for (const name of names) {
    const child = openUnknownChild(input.registry, input.descriptor, name, input.owner);
    if (child.type === "directory") {
      if (shouldDescend(`${input.sourceId}/${name}`, name)) {
        walkTree({
          ...input,
          parentDescriptor: input.descriptor,
          name,
          descriptor: child.descriptor,
          sourceId: `${input.sourceId}/${name}`
        }, result, include, shouldDescend);
      }
    } else if (child.type === "file") {
      const sourceId = `${input.sourceId}/${name}`;
      if (include(sourceId, name)) {
        const fileIdentity = descriptorIdentity(child.descriptor);
        result.push(Object.freeze({
          sourceId,
          mode: Number(fileIdentity.mode & 0o7777n),
          contentSha256: sha256(readVerifiedFile({
            ...input,
            parentDescriptor: input.descriptor,
            name,
            descriptor: child.descriptor,
            sourceId
          }))
        }));
      }
    } else {
      fail();
    }
    if (!sameIdentity(identity, descriptorIdentity(input.descriptor))) fail();
  }
  revalidateChild(
    input.registry,
    input.parentDescriptor,
    input.name,
    identity,
    "directory",
    input.owner
  );
}

function openAbsoluteDirectory(registry, absolutePath, owner, requireOwnerAtLeaf) {
  if (!isAbsolute(absolutePath)) fail();
  const components = absolutePath.split(sep).filter((entry) => entry.length > 0);
  let descriptor = registry.open(
    sep,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY
  );
  validateModeAndOwner(fstatSync(descriptor, { bigint: true }), [0n, owner], "directory");
  for (let index = 0; index < components.length; index += 1) {
    const name = components[index];
    const child = registry.open(
      descriptorPath(descriptor, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY
    );
    validateModeAndOwner(
      fstatSync(child, { bigint: true }),
      index === components.length - 1 && requireOwnerAtLeaf ? [owner] : [0n, owner],
      "directory"
    );
    descriptor = child;
  }
  return descriptor;
}

function withParentDirectory(registry, rootDescriptor, owner, sourceId, operation) {
  const components = sourceId.split("/");
  const name = components.pop();
  let parentDescriptor = rootDescriptor;
  const directoryBindings = [];
  for (const component of components) {
    const childDescriptor = openChild(
      registry,
      parentDescriptor,
      component,
      "directory",
      owner
    );
    directoryBindings.push(Object.freeze({
      parentDescriptor,
      name: component,
      identity: descriptorIdentity(childDescriptor)
    }));
    parentDescriptor = childDescriptor;
  }
  const result = operation(parentDescriptor, name);
  for (let index = directoryBindings.length - 1; index >= 0; index -= 1) {
    const binding = directoryBindings[index];
    revalidateChild(
      registry,
      binding.parentDescriptor,
      binding.name,
      binding.identity,
      "directory",
      owner
    );
  }
  return result;
}

function readEntry(registry, rootDescriptor, owner, sourceId, hooks, stageRoot) {
  return withParentDirectory(
    registry,
    rootDescriptor,
    owner,
    sourceId,
    (parentDescriptor, name) => {
      const descriptor = openChild(registry, parentDescriptor, name, "file", owner);
      return readVerifiedFile({
        registry,
        parentDescriptor,
        name,
        descriptor,
        sourceId,
        owner,
        hooks,
        stageRoot
      });
    }
  );
}

function digestEntry(registry, rootDescriptor, owner, sourceId, hooks, stageRoot) {
  return withParentDirectory(
    registry,
    rootDescriptor,
    owner,
    sourceId,
    (parentDescriptor, name) => {
      const descriptor = openChild(registry, parentDescriptor, name, "file", owner);
      const identity = descriptorIdentity(descriptor);
      return Object.freeze({
        sourceId,
        mode: Number(identity.mode & 0o7777n),
        contentSha256: sha256(readVerifiedFile({
          registry,
          parentDescriptor,
          name,
          descriptor,
          sourceId,
          owner,
          hooks,
          stageRoot
        }))
      });
    }
  );
}

function parseObject(bytes) {
  const value = JSON.parse(bytes.toString("utf8"));
  if (value === null || Array.isArray(value) || typeof value !== "object") fail();
  return value;
}

function validatePackageContract(packageObject) {
  const script = packageObject.scripts?.["diagnostic:development"];
  if (
    packageObject.type !== "module" ||
    typeof packageObject.engines?.node !== "string" ||
    typeof script !== "string" ||
    script !== "node scripts/development-diagnostic-bootstrap.mjs"
  ) {
    fail();
  }
  return Object.freeze({
    type: packageObject.type,
    nodeEngine: packageObject.engines.node,
    diagnosticDevelopmentScript: script
  });
}

function validateTsconfig(tsconfig) {
  if (
    Object.hasOwn(tsconfig, "extends") ||
    Object.hasOwn(tsconfig, "references") ||
    tsconfig.compilerOptions?.module !== "ESNext" ||
    tsconfig.compilerOptions?.moduleResolution !== "Bundler" ||
    tsconfig.compilerOptions?.noEmit !== true ||
    tsconfig.compilerOptions?.allowJs !== false
  ) {
    fail();
  }
  return Object.freeze({
    module: tsconfig.compilerOptions.module,
    moduleResolution: tsconfig.compilerOptions.moduleResolution,
    noEmit: true,
    allowJs: false
  });
}

function packageNameComponents(packageName) {
  if (
    typeof packageName !== "string" ||
    !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/iu.test(packageName)
  ) {
    fail();
  }
  return packageName.split("/");
}

function directoryContains(directoryDescriptor, name) {
  return readdirSync(descriptorPath(directoryDescriptor)).includes(name);
}

function normalizeInsideNodeModules(nodeModulesPath, targetPath) {
  const normalized = normalize(targetPath);
  const relativeTarget = relative(nodeModulesPath, normalized);
  if (
    relativeTarget.length === 0 ||
    isAbsolute(relativeTarget) ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`)
  ) {
    fail();
  }
  return relativeTarget;
}

function openRelativeDirectoryIfPresent(
  registry,
  nodeModulesDescriptor,
  components,
  owner
) {
  let descriptor = nodeModulesDescriptor;
  for (const component of components) {
    if (!directoryContains(descriptor, component)) return undefined;
    descriptor = openChild(registry, descriptor, component, "directory", owner);
  }
  return descriptor;
}

function resolutionCandidatePaths(issuerLocation, packageName) {
  const packagePath = packageNameComponents(packageName).join("/");
  const candidates = [];
  let current = issuerLocation;
  while (current !== undefined && current.length > 0) {
    candidates.push(`${current}/node_modules/${packagePath}`);
    const parent = dirname(current);
    current = parent === "." || parent === current ? "" : parent;
  }
  candidates.push(packagePath);
  return [...new Set(candidates)];
}

function resolvePackageCandidate(input, candidateLocation) {
  const components = candidateLocation.split("/");
  const name = components.pop();
  const parentDescriptor = openRelativeDirectoryIfPresent(
    input.registry,
    input.nodeModulesDescriptor,
    components,
    input.owner
  );
  if (parentDescriptor === undefined || !directoryContains(parentDescriptor, name)) {
    return undefined;
  }
  const identityDescriptor = input.registry.open(
    descriptorPath(parentDescriptor, name),
    linuxOpenPathFlag | constants.O_NOFOLLOW
  );
  const identity = descriptorIdentity(identityDescriptor);
  const stat = fstatSync(identityDescriptor, { bigint: true });
  if (stat.uid !== input.owner) fail();
  if (stat.isDirectory()) {
    validateModeAndOwner(stat, [input.owner], "directory", true);
    const descriptor = input.registry.open(
      descriptorPath(identityDescriptor),
      constants.O_RDONLY | constants.O_DIRECTORY
    );
    if (!sameIdentity(identity, descriptorIdentity(descriptor))) fail();
    return Object.freeze({
      descriptor,
      parentDescriptor,
      name,
      logicalLocation: candidateLocation,
      resolvedLocation: candidateLocation,
      link: null
    });
  }
  if (!stat.isSymbolicLink()) fail();
  const linkTarget = readlinkSync(descriptorPath(parentDescriptor, name), "utf8");
  const targetAbsolute = resolve(
    dirname(resolve(input.nodeModulesPath, candidateLocation)),
    linkTarget
  );
  const resolvedLocation = normalizeInsideNodeModules(
    input.nodeModulesPath,
    targetAbsolute
  );
  const targetComponents = resolvedLocation.split("/");
  const targetName = targetComponents.pop();
  const targetParent = openRelativeDirectoryIfPresent(
    input.registry,
    input.nodeModulesDescriptor,
    targetComponents,
    input.owner
  );
  if (
    targetParent === undefined ||
    !directoryContains(targetParent, targetName)
  ) {
    fail();
  }
  const descriptor = openChild(
    input.registry,
    targetParent,
    targetName,
    "directory",
    input.owner
  );
  if (
    !sameIdentity(identity, descriptorIdentity(identityDescriptor)) ||
    readlinkSync(descriptorPath(parentDescriptor, name), "utf8") !== linkTarget
  ) {
    fail();
  }
  return Object.freeze({
    descriptor,
    parentDescriptor: targetParent,
    name: targetName,
    logicalLocation: candidateLocation,
    resolvedLocation,
    link: Object.freeze({
      location: candidateLocation,
      target: linkTarget,
      resolvedTarget: resolvedLocation,
      owner: Number(stat.uid),
      mode: Number(stat.mode & 0o7777n),
      contentSha256: sha256(Buffer.from(linkTarget, "utf8"))
    })
  });
}

function resolveInstalledPackage(input, issuerLocation, packageName) {
  for (const candidateLocation of resolutionCandidatePaths(issuerLocation, packageName)) {
    const resolvedPackage = resolvePackageCandidate(input, candidateLocation);
    if (resolvedPackage !== undefined) return resolvedPackage;
  }
  return undefined;
}

function dependencyNames(packageObject, field) {
  const value = packageObject[field];
  if (value === undefined) return [];
  if (value === null || Array.isArray(value) || typeof value !== "object") fail();
  const names = Object.keys(value).sort();
  for (const name of names) {
    packageNameComponents(name);
    if (typeof value[name] !== "string") fail();
  }
  return names;
}

function collectInstalledRuntimeClosure(input, rootPackageObject) {
  const queue = dependencyNames(rootPackageObject, "dependencies")
    .map((name) => Object.freeze({ issuer: ".", name, kind: "production" }));
  queue.push(Object.freeze({ issuer: ".", name: "tsx", kind: "execution-tool" }));
  const packages = new Map();
  const edges = [];
  while (queue.length > 0) {
    const request = queue.shift();
    const resolvedPackage = resolveInstalledPackage(
      input,
      request.issuer === "." ? "" : request.issuer,
      request.name
    );
    if (resolvedPackage === undefined) {
      if (request.kind === "optional" || request.kind === "optional-peer") {
        edges.push(Object.freeze({ ...request, installed: false }));
        continue;
      }
      fail();
    }
    edges.push(Object.freeze({
      ...request,
      installed: true,
      logicalLocation: resolvedPackage.logicalLocation,
      resolvedLocation: resolvedPackage.resolvedLocation,
      link: resolvedPackage.link
    }));
    if (packages.has(resolvedPackage.resolvedLocation)) continue;
    const packageSourceId = `node_modules/${resolvedPackage.resolvedLocation}`;
    const packageBytes = readVerifiedFile({
      registry: input.registry,
      parentDescriptor: resolvedPackage.descriptor,
      name: "package.json",
      descriptor: openChild(
        input.registry,
        resolvedPackage.descriptor,
        "package.json",
        "file",
        input.owner
      ),
      sourceId: `${packageSourceId}/package.json`,
      owner: input.owner,
      hooks: input.hooks,
      stageRoot: input.stageRoot
    });
    const packageObject = parseObject(packageBytes);
    if (
      packageObject.name !== request.name ||
      typeof packageObject.version !== "string" ||
      packageObject.version.length === 0
    ) {
      fail();
    }
    if (
      request.name === "tsx" &&
      (
        packageObject.type !== "module" ||
        packageObject.bin !== "./dist/cli.mjs" ||
        packageObject.exports?.["./cli"] !== "./dist/cli.mjs"
      )
    ) {
      fail();
    }
    const files = [];
    walkTree({
      registry: input.registry,
      parentDescriptor: resolvedPackage.parentDescriptor,
      name: resolvedPackage.name,
      descriptor: resolvedPackage.descriptor,
      sourceId: packageSourceId,
      owner: input.owner,
      hooks: input.hooks,
      stageRoot: input.stageRoot
    }, files, (_sourceId, name) => name !== "package.json",
    (_sourceId, name) => name !== "node_modules");
    files.sort((left, right) =>
      left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0
    );
    packages.set(resolvedPackage.resolvedLocation, Object.freeze({
      logicalName: request.name,
      version: packageObject.version,
      packageJsonSha256: sha256(packageBytes),
      resolvedLocation: resolvedPackage.resolvedLocation,
      files
    }));
    for (const name of dependencyNames(packageObject, "dependencies")) {
      queue.push(Object.freeze({
        issuer: resolvedPackage.resolvedLocation,
        name,
        kind: "dependency"
      }));
    }
    for (const name of dependencyNames(packageObject, "optionalDependencies")) {
      queue.push(Object.freeze({
        issuer: resolvedPackage.resolvedLocation,
        name,
        kind: "optional"
      }));
    }
    const peerNames = dependencyNames(packageObject, "peerDependencies");
    const peerMetadata = packageObject.peerDependenciesMeta;
    if (
      peerMetadata !== undefined &&
      (peerMetadata === null || Array.isArray(peerMetadata) || typeof peerMetadata !== "object")
    ) {
      fail();
    }
    for (const name of peerNames) {
      const optional = peerMetadata?.[name]?.optional === true;
      queue.push(Object.freeze({
        issuer: resolvedPackage.resolvedLocation,
        name,
        kind: optional ? "optional-peer" : "peer"
      }));
    }
  }
  edges.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return Object.freeze({
    edges,
    packages: [...packages.values()].sort((left, right) =>
      left.resolvedLocation < right.resolvedLocation
        ? -1
        : left.resolvedLocation > right.resolvedLocation
          ? 1
          : 0
    )
  });
}
function stageRuntimePackageLinks(stageRoot, edges) {
  if (stageRoot === undefined) return;
  const stagedLinks = new Set();
  for (const edge of edges) {
    if (edge.link === null || edge.link === undefined) continue;
    if (stagedLinks.has(edge.link.location)) continue;
    const linkPath = resolve(stageRoot, "node_modules", edge.link.location);
    mkdirSync(dirname(linkPath), { recursive: true, mode: 0o700 });
    symlinkSync(edge.link.target, linkPath, "dir");
    stagedLinks.add(edge.link.location);
  }
}


export function verifyDevelopmentDiagnosticStartupContract(
  repositoryRoot,
  { hooks, closeDescriptor, stageRoot } = {}
) {
  const registry = new DescriptorRegistry(closeDescriptor);
  let result;
  let failed = false;
  try {
    const owner = BigInt(process.getuid());
    const rootDescriptor = openAbsoluteDirectory(registry, resolve(repositoryRoot), owner, true);
    const rootIdentity = descriptorIdentity(rootDescriptor);
    const sourceDigests = [];
    const srcDescriptor = openChild(registry, rootDescriptor, "src", "directory", owner);
    walkTree({
      registry,
      parentDescriptor: rootDescriptor,
      name: "src",
      descriptor: srcDescriptor,
      sourceId: "src",
      owner,
      hooks,
      stageRoot
    }, sourceDigests, (_sourceId, name) =>
      name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".spec.ts"),
    (_sourceId, name) => !excludedSourceDirectories.has(name));
    for (const sourceId of entryFiles) {
      sourceDigests.push(digestEntry(
        registry,
        rootDescriptor,
        owner,
        sourceId,
        hooks,
        stageRoot
      ));
    }
    const packageBytes = readEntry(
      registry,
      rootDescriptor,
      owner,
      "package.json",
      hooks,
      stageRoot
    );
    const packageObject = parseObject(packageBytes);
    const tsconfigBytes = readEntry(
      registry,
      rootDescriptor,
      owner,
      "tsconfig.json",
      hooks,
      stageRoot
    );
    const nodeModulesDescriptor = openChild(
      registry,
      rootDescriptor,
      "node_modules",
      "directory",
      owner
    );
    const runtimeClosure = collectInstalledRuntimeClosure({
      registry,
      nodeModulesDescriptor,
      nodeModulesPath: resolve(repositoryRoot, "node_modules"),
      owner,
      hooks,
      stageRoot
    }, packageObject);
    stageRuntimePackageLinks(stageRoot, runtimeClosure.edges);
    const packageManagerMetadata = [
      digestEntry(
        registry,
        rootDescriptor,
        owner,
        "package-lock.json",
        hooks,
        stageRoot
      ),
      digestEntry(
        registry,
        rootDescriptor,
        owner,
        "node_modules/.package-lock.json",
        hooks,
        stageRoot
      )
    ];
    sourceDigests.sort((left, right) =>
      left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0
    );
    if (!sameIdentity(rootIdentity, descriptorIdentity(rootDescriptor))) fail();
    result = canonicalDigest({
      schemaVersion: 2,
      productionSources: sourceDigests,
      packageExecutionContract: {
        contentSha256: sha256(packageBytes),
        runtimeContract: validatePackageContract(packageObject)
      },
      tsconfig: {
        contentSha256: sha256(tsconfigBytes),
        runtimeContract: validateTsconfig(parseObject(tsconfigBytes))
      },
      installedRuntimeClosure: runtimeClosure,
      packageManagerMetadata
    });
  } catch {
    failed = true;
  } finally {
    try {
      registry.closeAll();
    } catch {
      failed = true;
    }
  }
  if (failed || !digestPattern.test(result ?? "")) fail();
  return result;
}

function parseArguments(argv) {
  const stateIndexes = argv.flatMap((value, index) =>
    value === "--state-dir" ? [index] : []);
  const printIndexes = argv.flatMap((value, index) =>
    value === "--print-contract" ? [index] : []);
  const approvalIndexes = argv.flatMap((value, index) =>
    value === "--approve-contract" ? [index] : []);
  const stagedIndexes = argv.flatMap((value, index) =>
    value === "--staged-contract" ? [index] : []);
  if (stateIndexes.length !== 1) fail();
  const stateIndex = stateIndexes[0];
  const stateDirectory = argv[stateIndex + 1];
  if (stateDirectory === undefined || !isAbsolute(stateDirectory)) fail();
  if (printIndexes.length > 0) {
    if (
      printIndexes.length !== 1 ||
      approvalIndexes.length !== 0 ||
      stagedIndexes.length !== 0 ||
      argv.length !== 3 ||
      printIndexes[0] !== 0 ||
      stateIndex !== 1
    ) {
      fail();
    }
    return Object.freeze({ mode: "print", stateDirectory, cliArguments: [] });
  }
  const envFile = argv[0];
  if (!isAbsolute(envFile)) fail();
  if (approvalIndexes.length > 1 || stagedIndexes.length > 1) fail();
  const removed = new Set([0, stateIndex, stateIndex + 1]);
  let approval;
  if (approvalIndexes.length === 1) {
    const approvalIndex = approvalIndexes[0];
    approval = argv[approvalIndex + 1];
    if (!digestPattern.test(approval ?? "")) fail();
    removed.add(approvalIndex);
    removed.add(approvalIndex + 1);
  }
  let stagedContract;
  if (stagedIndexes.length === 1) {
    const stagedIndex = stagedIndexes[0];
    stagedContract = argv[stagedIndex + 1];
    if (!digestPattern.test(stagedContract ?? "") || approval !== undefined) fail();
    removed.add(stagedIndex);
    removed.add(stagedIndex + 1);
  }
  const cliArguments = argv.filter((_value, index) => !removed.has(index));
  const delimiterIndex = cliArguments.indexOf("--");
  if (delimiterIndex >= 0) {
    if (delimiterIndex !== 0 || cliArguments.lastIndexOf("--") !== 0) fail();
    cliArguments.shift();
  }
  if (approval !== undefined && cliArguments.length !== 0) fail();
  return Object.freeze({
    mode: approval !== undefined
      ? "approve"
      : stagedContract !== undefined
        ? "staged"
        : "run",
    stateDirectory,
    envFile,
    approval,
    stagedContract,
    cliArguments
  });
}
function attestPrivateRoots(repositoryRoot, envFile, owner) {
  const roots = Object.freeze([
    resolve(repositoryRoot, "private"),
    resolve(dirname(repositoryRoot), "Urmotiv/private")
  ]);
  if (
    new Set(roots).size !== roots.length ||
    !roots.some((root) => {
      const relativeEnv = relative(root, envFile);
      return relativeEnv.length > 0 &&
        !isAbsolute(relativeEnv) &&
        relativeEnv !== ".." &&
        !relativeEnv.startsWith(`..${sep}`);
    })
  ) {
    fail();
  }
  const registry = new DescriptorRegistry();
  let failed = false;
  try {
    for (const root of roots) {
      const descriptor = openAbsoluteDirectory(registry, root, owner, true);
      validateModeAndOwner(
        fstatSync(descriptor, { bigint: true }),
        [owner],
        "directory"
      );
    }
  } catch {
    failed = true;
  } finally {
    try {
      registry.closeAll();
    } catch {
      failed = true;
    }
  }
function stagedStartupContract(approvedFingerprint, stagedFingerprint) {
  return canonicalDigest({
    approvedContractFingerprint: approvedFingerprint,
    schemaVersion: 1,
    stagedContractFingerprint: stagedFingerprint
  });
}
    stagedContractFingerprint: stagedFingerprint,
    stagedRoot: resolve(stageRoot)
  });
}

function privateRootsAttestation(startupContractFingerprint, roots) {
  return canonicalDigest({
    privateRoots: roots,
    schemaVersion: 1,
    startupContractFingerprint
  });
}

function parseAttestedPrivateRoots(environment, startupContractFingerprint, owner) {
  const serialized = environment.FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS;
  const attestation =
    environment.FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS_ATTESTATION;
  if (
    typeof serialized !== "string" ||
    typeof attestation !== "string" ||
    !digestPattern.test(attestation)
  ) {
    fail();
  }
  let roots;
  try {
    roots = JSON.parse(serialized);
  } catch {
    fail();
  }
  if (
    !Array.isArray(roots) ||
    roots.length !== 2 ||
    roots.some((root) => typeof root !== "string" || !isAbsolute(root)) ||
    new Set(roots).size !== roots.length ||
    privateRootsAttestation(startupContractFingerprint, roots) !== attestation
  ) {
    fail();
  }
  const registry = new DescriptorRegistry();
  let failed = false;
  try {
    for (const root of roots) {
      openAbsoluteDirectory(registry, root, owner, true);
    }
  } catch {
    failed = true;
  } finally {
    try {
      registry.closeAll();
    } catch {
      failed = true;
    }
  }
  if (failed) fail();
  return Object.freeze([...roots]);
}

function writeApprovedContract(stateDirectory, owner, fingerprint) {
  const registry = new DescriptorRegistry();
  let failed = false;
  try {
    const directory = openAbsoluteDirectory(registry, stateDirectory, owner, true);
    const temporaryName = `.bootstrap-contract.${process.pid}.${Date.now()}.tmp`;
    const descriptor = registry.open(
      descriptorPath(directory, temporaryName),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${canonicalJson({
      schemaVersion: 1,
      contractFingerprint: fingerprint
    })}\n`, "utf8");
    fsyncSync(descriptor);
    renameSync(
      descriptorPath(directory, temporaryName),
      descriptorPath(directory, contractFileName)
    );
    fsyncSync(directory);
  } catch {
    failed = true;
  } finally {
    try {
      registry.closeAll();
    } catch {
      failed = true;
    }
  }
  if (failed) fail();
}

function readApprovedContract(stateDirectory, owner) {
  const registry = new DescriptorRegistry();
  let result;
  let failed = false;
  try {
    const directory = openAbsoluteDirectory(registry, stateDirectory, owner, true);
    const descriptor = openChild(
      registry,
      directory,
      contractFileName,
      "file",
      owner
    );
    const stat = fstatSync(descriptor, { bigint: true });
    if ((stat.mode & 0o077n) !== 0n || stat.nlink !== 1n) fail();
    const parsed = parseObject(readFileSync(descriptor));
    if (
      parsed.schemaVersion !== 1 ||
      !digestPattern.test(parsed.contractFingerprint ?? "")
    ) {
      fail();
    }
    result = parsed.contractFingerprint;
  } catch {
    failed = true;
  } finally {
    try {
      registry.closeAll();
    } catch {
      failed = true;
    }
  }
  if (failed || result === undefined) fail();
  return result;
}

function fsyncStageDirectories(stageRoot) {
  const directories = [stageRoot];
  for (const entry of readdirSync(stageRoot, {
    recursive: true,
    withFileTypes: true
  })) {
    if (entry.isDirectory()) directories.push(resolve(entry.parentPath, entry.name));
  }
  directories.sort((left, right) => right.length - left.length);
  for (const directory of directories) {
    const descriptor = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      fchmodSync(descriptor, 0o700);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}
function sealStageDirectories(stageRoot) {
  const directories = [stageRoot];
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(resolve(directory, entry.name));
    }
  }
  for (const directory of directories.reverse()) {
    chmodSync(directory, 0o500);
    const descriptor = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}
function makeStageDeletable(stageRoot) {
  const directories = [stageRoot];
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index];
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(resolve(directory, entry.name));
    }
  }
}


function cleanupBoundedOrphanStages(stateDirectory) {
  const now = Date.now();
  let cleaned = 0;
  for (const name of readdirSync(stateDirectory).sort()) {
    if (cleaned >= 8) break;
    const match = /^\.development-diagnostic-(?:stage|delete)-(\d+)-[\w-]+$/u.exec(name);
    if (match === null) continue;
    const path = resolve(stateDirectory, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o022) !== 0 ||
      now - stat.mtimeMs < 24 * 60 * 60 * 1000
    ) {
      continue;
    }
    try {
      lstatSync(`/proc/${match[1]}`);
      continue;
    } catch {
      cleanupStagedClosure(path);
      cleaned += 1;
    }
  }
}
export function createStagedClosure(
  stateDirectory,

  repositoryRoot,
  approvedFingerprint,
  hooks
) {
  cleanupBoundedOrphanStages(stateDirectory);
  const stageRoot = mkdtempSync(
    resolve(stateDirectory, `.development-diagnostic-stage-${process.pid}-`)
  );
  chmodSync(stageRoot, 0o700);
  let complete = false;
  try {
    const repositoryFingerprint =
      verifyDevelopmentDiagnosticStartupContract(repositoryRoot, { stageRoot, hooks });
    if (repositoryFingerprint !== approvedFingerprint) fail();
    fsyncStageDirectories(stageRoot);
    const stagedFingerprint =
      verifyDevelopmentDiagnosticStartupContract(stageRoot);
    sealStageDirectories(stageRoot);
    hooks?.afterStageComplete?.({ stageRoot, stagedFingerprint });
    complete = true;
    return Object.freeze({ stageRoot, stagedFingerprint });
  } finally {
    if (!complete) {
      makeStageDeletable(stageRoot);
      rmSync(stageRoot, { recursive: true, force: true });
    }
  }
}

export function cleanupStagedClosure(stageRoot) {
  const parent = dirname(stageRoot);
  const name = stageRoot.slice(parent.length + 1);
  if (!/^\.development-diagnostic-(?:stage|delete)-\d+-[\w-]+$/u.test(name)) fail();
  const registry = new DescriptorRegistry();
  let quarantine;
  let failed = false;
  try {
    const owner = BigInt(process.getuid());
    const parentDescriptor = openAbsoluteDirectory(registry, parent, owner, true);
    const stageDescriptor = openChild(
      registry,
      parentDescriptor,
      name,
      "directory",
      owner
    );
    let identity = descriptorIdentity(stageDescriptor);
    quarantine = `.development-diagnostic-delete-${process.pid}-${randomUUID()}`;
    renameSync(
      descriptorPath(parentDescriptor, name),
      descriptorPath(parentDescriptor, quarantine)
    );
    identity = descriptorIdentity(stageDescriptor);
    revalidateChild(
      registry,
      parentDescriptor,
      quarantine,
      identity,
      "directory",
      owner
    );
    fsyncSync(parentDescriptor);
  } catch {
    failed = true;
  } finally {
    try {
      registry.closeAll();
    } catch {
      failed = true;
    }
  }
  if (failed || quarantine === undefined) fail();
  const quarantinePath = resolve(parent, quarantine);
  makeStageDeletable(quarantinePath);
  rmSync(quarantinePath, { recursive: true, force: false });
}

async function spawnAndWait(application, arguments_, options) {
  const child = spawn(application, arguments_, options);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map();
  for (const signal of signals) {
    const handler = () => child.kill(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const exitCode = await new Promise((resolveExit) => {
    child.once("error", () => resolveExit(1));
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  for (const [signal, handler] of handlers) process.off(signal, handler);
  return exitCode;
}

async function launch(repositoryRoot, parsed, fingerprint, privateRoots) {
  for (const key of forbiddenEnvironmentOverrides) {
    if (typeof process.env[key] === "string" && process.env[key].trim() !== "") fail();
  }
  const wrapper = await import(pathToFileURL(
    resolve(repositoryRoot, "scripts/run-with-env.mjs")
  ).href);
  const privateRuntime = await import(pathToFileURL(
    resolve(repositoryRoot, "scripts/private-runtime.mjs")
  ).href);
  const privateRoot = dirname(parsed.envFile);
  const envFileContent = privateRuntime.readProtectedEnvFile(parsed.envFile, {
    privateRoot,
    containingWorkspace: dirname(privateRoot)
  });
  const parentEnvironment = {
    ...process.env,
    FERMATA_DEVELOPMENT_DIAGNOSTIC_STARTUP_CONTRACT: fingerprint
  };
  const childEnvironment = wrapper.buildDevelopmentDiagnosticRunEnvironment(
    envFileContent,
    parentEnvironment
  );
  childEnvironment.FERMATA_DEVELOPMENT_DIAGNOSTIC_STARTUP_CONTRACT = fingerprint;
  childEnvironment.FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS =
    canonicalJson(privateRoots);
  childEnvironment.FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS_ATTESTATION =
    privateRootsAttestation(fingerprint, privateRoots);
  childEnvironment.TSX_TSCONFIG_PATH = resolve(repositoryRoot, "tsconfig.json");
  const exitCode = await spawnAndWait(
    process.execPath,
    [
      "--import",
      resolve(repositoryRoot, "node_modules/tsx/dist/loader.mjs"),
      resolve(repositoryRoot, "experiments/run-development-diagnostic.ts"),
      "--state-dir",
      parsed.stateDirectory,
      ...parsed.cliArguments
    ],
    {
      cwd: repositoryRoot,
      env: childEnvironment,
      shell: false,
      stdio: "inherit"
    }
  );
  process.exitCode = exitCode;
}

async function handoffToStagedBootstrap(
  stageRoot,
  parsed,
  approvedFingerprint,
  stagedFingerprint,
  privateRoots
) {
  const arguments_ = [
    resolve(stageRoot, "scripts/development-diagnostic-bootstrap.mjs"),
    parsed.envFile,
    "--state-dir",
    parsed.stateDirectory,
    "--staged-contract",
    stagedFingerprint
  ];
  if (parsed.cliArguments.length > 0) {
          stagedStartupContract(approvedFingerprint, stagedFingerprint),
  }
  return spawnAndWait(process.execPath, arguments_, {
    cwd: stageRoot,
    env: {
      ...process.env,
      FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS: canonicalJson(privateRoots),
      FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS_ATTESTATION:
        privateRootsAttestation(
          stagedStartupContract(approvedFingerprint, stagedFingerprint, stageRoot),
          privateRoots
        )
    },
    shell: false,
    stdio: "inherit"
  });
}

function isDirectEntry() {
  try {
    return process.argv[1] !== undefined &&
      pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

async function main() {
  try {
    if (process.getuid === undefined || process.geteuid === undefined) fail();
    if (process.getuid() !== process.geteuid()) fail();
      const startupContract = stagedStartupContract(
        approved,
        stagedFingerprint
      );
      const stagedFingerprint =
        verifyDevelopmentDiagnosticStartupContract(repositoryRoot);
      if (stagedFingerprint !== parsed.stagedContract) fail();
      const startupContract = stagedStartupContract(
        approved,
        stagedFingerprint,
        repositoryRoot
      );
      const privateRoots = parseAttestedPrivateRoots(
        process.env,
        startupContract,
        owner
      );
      await launch(repositoryRoot, parsed, startupContract, privateRoots);
      return;
    }
    const fingerprint = verifyDevelopmentDiagnosticStartupContract(repositoryRoot);
    if (parsed.mode === "print") {
      process.stdout.write(`${canonicalJson({
        event: "development_diagnostic_bootstrap_contract",
        contractFingerprint: fingerprint
      })}\n`);
      return;
    }
    if (parsed.mode === "approve") {
      if (parsed.approval !== fingerprint) fail();
      writeApprovedContract(parsed.stateDirectory, owner, fingerprint);
      process.stdout.write("已确认正式付费诊断启动契约。\n");
      return;
    }
    const approved = readApprovedContract(parsed.stateDirectory, owner);
    const privateRoots = attestPrivateRoots(repositoryRoot, parsed.envFile, owner);
    const staged = createStagedClosure(
      parsed.stateDirectory,
      repositoryRoot,
      approved
    );
    try {
      process.exitCode = await handoffToStagedBootstrap(
        staged.stageRoot,
        parsed,
        approved,
        staged.stagedFingerprint,
        privateRoots
      );
    } finally {
      cleanupStagedClosure(staged.stageRoot);
    }
  } catch {
    process.stderr.write(
      "正式付费诊断必须由 owner 直接使用受信 bootstrap 启动；npm script 仅为便捷入口。\n"
    );
    process.exitCode = 1;
  }
}

if (isDirectEntry()) void main();
