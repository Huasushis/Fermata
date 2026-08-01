import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registryUrl = new URL(
  "../experiments/results/legacy-report-registry.json",
  import.meta.url
);
const allowedArchiveRoots = new Map([
  [
    "A",
    "../previous-server-work/urmotiv-codex/fermata-repo/experiments/results"
  ],
  [
    "B",
    "../previous-server-work/urmotiv-codex/fermata-accuracy-20260731/experiments/results"
  ],
  [
    "C",
    "../previous-server-work/urmotiv-codex/fermata-timeout-review-20260731/experiments/results"
  ]
]);

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}

function isDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function regularTopLevelHashes(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const regularFiles = entries.filter((entry) => entry.isFile());
  if (
    entries.some(
      (entry) =>
        (!entry.isFile() && !entry.isDirectory()) ||
        (entry.isDirectory() && entry.name !== "raw")
    )
  ) {
    throw new Error("LEGACY_REPORT_ARCHIVE_UNSAFE_ENTRY");
  }
  return Promise.all(
    regularFiles.map((entry) => sha256(resolve(root, entry.name)))
  );
}

async function rawAreaEntryCount(root) {
  const rawRoot = resolve(root, "raw");
  const rawStatus = await lstat(rawRoot).catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (rawStatus === null) {
    return 0;
  }
  if (!rawStatus.isDirectory() || rawStatus.isSymbolicLink()) {
    throw new Error("LEGACY_REPORT_RAW_AREA_UNSAFE_ENTRY");
  }
  const entries = await readdir(rawRoot, {
    withFileTypes: true
  });
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error("LEGACY_REPORT_RAW_AREA_UNSAFE_ENTRY");
  }
  return entries.length;
}

function equalDigestMultiset(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

async function main() {
  const registry = JSON.parse(await readFile(registryUrl, "utf8"));
  if (
    registry?.schemaVersion !== 1 ||
    !Array.isArray(registry.archiveCategories) ||
    !Array.isArray(registry.logicalExperiments)
  ) {
    throw new Error("LEGACY_REPORT_REGISTRY_INVALID");
  }

  const categoryIds = new Set();
  const categoryDigests = new Map();
  const archiveBoundary = await realpath(
    resolve(repositoryRoot, "../previous-server-work")
  );
  let archivedSafeCopies = 0;
  let rawAreaFileEntries = 0;
  for (const category of registry.archiveCategories) {
    const allowedRelativeRoot = allowedArchiveRoots.get(category?.id);
    if (
      typeof category?.id !== "string" ||
      categoryIds.has(category.id) ||
      allowedRelativeRoot === undefined ||
      category.root !== allowedRelativeRoot ||
      !Array.isArray(category.safeArtifactSha256) ||
      category.safeArtifactSha256.some((value) => !isDigest(value)) ||
      !Number.isSafeInteger(category.rawAreaFileEntries) ||
      category.rawAreaFileEntries < 0
    ) {
      throw new Error("LEGACY_REPORT_REGISTRY_INVALID");
    }
    categoryIds.add(category.id);
    const configuredArchiveRoot = resolve(repositoryRoot, allowedRelativeRoot);
    const configuredStatus = await lstat(configuredArchiveRoot);
    if (!configuredStatus.isDirectory() || configuredStatus.isSymbolicLink()) {
      throw new Error("LEGACY_REPORT_ARCHIVE_UNSAFE_ENTRY");
    }
    const archiveRoot = await realpath(configuredArchiveRoot);
    if (
      archiveRoot !== archiveBoundary &&
      !archiveRoot.startsWith(`${archiveBoundary}${sep}`)
    ) {
      throw new Error("LEGACY_REPORT_ARCHIVE_OUT_OF_SCOPE");
    }
    const actualHashes = await regularTopLevelHashes(archiveRoot);
    if (!equalDigestMultiset(actualHashes, category.safeArtifactSha256)) {
      throw new Error("LEGACY_REPORT_SAFE_ARTIFACT_MISMATCH");
    }
    const actualRawEntries = await rawAreaEntryCount(archiveRoot);
    if (actualRawEntries !== category.rawAreaFileEntries) {
      throw new Error("LEGACY_REPORT_RAW_AREA_COUNT_MISMATCH");
    }
    categoryDigests.set(category.id, new Set(actualHashes));
    archivedSafeCopies += actualHashes.length;
    rawAreaFileEntries += actualRawEntries;
  }

  for (const category of registry.archiveCategories) {
    if (category.duplicateOf === undefined) {
      continue;
    }
    const source = categoryDigests.get(category.duplicateOf);
    const current = categoryDigests.get(category.id);
    if (
      source === undefined ||
      current === undefined ||
      !equalDigestMultiset([...source], [...current])
    ) {
      throw new Error("LEGACY_REPORT_DUPLICATE_MISMATCH");
    }
  }

  const registeredDigests = registry.logicalExperiments.flatMap((experiment) => {
    if (
      experiment?.baselineEligible !== false ||
      typeof experiment.label !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(experiment.label) ||
      !["incomplete", "legacy-unverifiable"].includes(
        experiment.completeness
      ) ||
      !Number.isSafeInteger(experiment.sampleCount) ||
      experiment.sampleCount < 1 ||
      !Array.isArray(experiment.artifacts) ||
      !Array.isArray(experiment.sourceCopies) ||
      experiment.sourceCopies.some((id) => !categoryIds.has(id))
    ) {
      throw new Error("LEGACY_REPORT_REGISTRY_INVALID");
    }
    return experiment.artifacts.map((artifact) => {
      const digest = artifact?.sha256;
      if (
        !isDigest(digest) ||
        experiment.sourceCopies.some(
          (id) => !categoryDigests.get(id)?.has(digest)
        )
      ) {
        throw new Error("LEGACY_REPORT_SOURCE_COPY_MISMATCH");
      }
      return digest;
    });
  });
  if (
    registeredDigests.some((value) => !isDigest(value)) ||
    new Set(registeredDigests).size !== registeredDigests.length
  ) {
    throw new Error("LEGACY_REPORT_REGISTRY_INVALID");
  }
  const archivedDigests = new Set(
    registry.archiveCategories.flatMap((category) => category.safeArtifactSha256)
  );
  if (
    registeredDigests.length !== archivedDigests.size ||
    registeredDigests.some((digest) => !archivedDigests.has(digest))
  ) {
    throw new Error("LEGACY_REPORT_REGISTRY_INCOMPLETE");
  }

  process.stdout.write(
    JSON.stringify({
      archivesVerified: registry.archiveCategories.length,
      logicalExperiments: registry.logicalExperiments.length,
      uniqueSafeArtifacts: registeredDigests.length,
      archivedSafeCopies,
      rawAreaFileEntries,
      rawAreaContentInspected: false,
      baselineEligibleExperiments: 0
    }) + "\n"
  );
}

main().catch((error) => {
  const code =
    error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "LEGACY_REPORT_REGISTRY_CHECK_FAILED";
  fail(code);
});
