import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { z } from "zod";
import {
  failPhysicalBlind,
  hashPhysicalBlindValue,
  parsePhysicalBlindJson,
  parseVersionedStrictArtifact,
  physicalBlindDigestSchema,
  physicalBlindPurposeSchema,
  physicalBlindRunIdSchema,
  physicalBlindSafeIdSchema
} from "./physical-blind-common";
import {
  loadPhysicalBlindContentArtifact,
  physicalBlindSourceIneligibilityReasonCode
} from "./physical-blind-content";
import { loadPhysicalBlindPredictionArtifact } from "./physical-blind-inference";
import {
  physicalBlindProfile,
  physicalBlindProfileImplementationVersion,
  physicalBlindProfileNameSchema
} from "./physical-blind-profiles";

export const physicalBlindScoreArtifactImplementationVersion =
  "physical-blind-unqualified-artifact-v1" as const;

const scoreCodeIdentitySchema = z
  .object({
    implementationVersion: z.literal(
      physicalBlindScoreArtifactImplementationVersion
    ),
    sourceFilesSha256: physicalBlindDigestSchema,
    sourceFileCount: z.number().int().positive(),
    workerSha256: physicalBlindDigestSchema,
    packageLockSha256: physicalBlindDigestSchema,
    runtimeDependenciesSha256: physicalBlindDigestSchema,
    runtimeDependencyFileCount: z.number().int().positive(),
    bubblewrapSha256: physicalBlindDigestSchema,
    nodeBinarySha256: physicalBlindDigestSchema,
    nodeVersion: z.string().regex(/^v[0-9]+\.[0-9]+\.[0-9]+$/)
  })
  .strict();

const scoreBindingSchema = z
  .object({
    datasetId: physicalBlindSafeIdSchema,
    purpose: physicalBlindPurposeSchema,
    contentIdentityFingerprint: physicalBlindDigestSchema,
    contentFingerprint: physicalBlindDigestSchema,
    predictionFingerprint: physicalBlindDigestSchema,
    runId: physicalBlindRunIdSchema,
    contentDocumentSha256: physicalBlindDigestSchema,
    predictionDocumentSha256: physicalBlindDigestSchema
  })
  .strict();

const scoreArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal("blind-score-unqualified"),
    profile: physicalBlindProfileNameSchema,
    profileImplementationVersion: z.literal(
      physicalBlindProfileImplementationVersion
    ),
    profileSpecificationFingerprint: physicalBlindDigestSchema,
    scoreCodeIdentity: scoreCodeIdentitySchema,
    binding: scoreBindingSchema,
    operationalComplete: z.literal(false),
    integrityClean: z.literal(false),
    assessment: z.null(),
    accuracyPassed: z.literal(false),
    sandboxVerified: z.literal(false),
    eligible: z.literal(false),
    eligibilityReasonCodes: z.tuple([
      z.literal(physicalBlindSourceIneligibilityReasonCode),
      z.literal("BLIND_TRUSTED_EXECUTION_ADAPTER_REQUIRED"),
      z.literal("BLIND_SCORE_SANDBOX_REQUIRED")
    ]),
    scoreFingerprint: physicalBlindDigestSchema
  })
  .strict();
export type PhysicalBlindScoreArtifact = z.infer<typeof scoreArtifactSchema>;

export function loadPhysicalBlindScoreArtifact(
  document: string
): PhysicalBlindScoreArtifact {
  const parsed = parseVersionedStrictArtifact({
    value: parsePhysicalBlindJson(document),
    schema: scoreArtifactSchema
  });
  const { scoreFingerprint: _scoreFingerprint, ...withoutFingerprint } = parsed;
  if (parsed.scoreFingerprint !== hashPhysicalBlindValue(withoutFingerprint)) {
    failPhysicalBlind("BLIND_ARTIFACT_HASH_MISMATCH");
  }
  return parsed;
}

/**
 * v1 只描述“资格失败”，绑定 content、prediction、profile 和当前代码身份；它
 * 不接受 gold 或 completion，也没有任何可构造的 eligible=true 分支。
 */
export function verifyPhysicalBlindScoreArtifact(input: {
  readonly scoreDocument: string;
  readonly contentDocumentBytes: Uint8Array;
  readonly predictionDocumentBytes: Uint8Array;
}): never {
  const contentDocument = decodeArtifactBytes(input.contentDocumentBytes);
  const predictionDocument = decodeArtifactBytes(input.predictionDocumentBytes);
  const score = loadPhysicalBlindScoreArtifact(input.scoreDocument);
  const profile = physicalBlindProfile(score.profile);
  const currentCodeIdentity = physicalBlindScoreCodeIdentity();
  if (
    hashPhysicalBlindValue(score.scoreCodeIdentity) !==
      hashPhysicalBlindValue(currentCodeIdentity) ||
    score.profileImplementationVersion !== profile.implementationVersion ||
    score.profileSpecificationFingerprint !== profile.specificationFingerprint
  ) {
    failPhysicalBlind("BLIND_SCORE_CODE_IDENTITY_MISMATCH");
  }
  const content = loadPhysicalBlindContentArtifact(contentDocument);
  const prediction = loadPhysicalBlindPredictionArtifact({
    document: predictionDocument,
    content,
    predictionSchema: profile.predictionSchema
  });
  const binding = score.binding;
  if (
    binding.datasetId !== content.datasetId ||
    binding.purpose !== content.purpose ||
    binding.contentIdentityFingerprint !== content.contentIdentityFingerprint ||
    binding.contentFingerprint !== content.contentFingerprint ||
    binding.predictionFingerprint !== prediction.predictionFingerprint ||
    binding.runId !== prediction.runId ||
    binding.contentDocumentSha256 !== sha256Bytes(input.contentDocumentBytes) ||
    binding.predictionDocumentSha256 !== sha256Bytes(input.predictionDocumentBytes)
  ) {
    failPhysicalBlind("BLIND_SCORE_BINDING_MISMATCH");
  }
  return failPhysicalBlind(content.sourceIneligibilityReasonCode);
}

export function physicalBlindScoreCodeIdentity(): z.infer<
  typeof scoreCodeIdentitySchema
> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const relativePaths = [
    "experiments/physical-blind-score-worker.ts",
    "experiments/score-physical-blind-artifacts.ts",
    "experiments/lib/blind-evaluation.ts",
    "experiments/lib/concurrency.ts",
    "experiments/lib/physical-blind-common.ts",
    "experiments/lib/physical-blind-content.ts",
    "experiments/lib/physical-blind-cli-options.ts",
    "experiments/lib/physical-blind-inference.ts",
    "experiments/lib/physical-blind-outcomes.ts",
    "experiments/lib/physical-blind-prepare.ts",
    "experiments/lib/physical-blind-profiles.ts",
    "experiments/lib/physical-blind-score-artifact.ts",
    "experiments/lib/physical-blind-score-sandbox.ts",
    "experiments/lib/physical-blind-score.ts",
    "experiments/lib/private-artifact-io.ts",
    "scripts/private-runtime.mjs",
    "package.json",
    "package-lock.json",
    "src/pipelines/types.ts",
    "src/review-task-input.ts",
    "src/urmotiv-schemas.ts"
  ] as const;
  const entries = relativePaths.map((relativePath) => ({
    relativePath,
    sha256: createHash("sha256")
      .update(readFileSync(resolve(root, relativePath)))
      .digest("hex")
  }));
  const runtimeDependencies = ["tsx", "zod", "esbuild", "@esbuild/linux-x64"]
    .flatMap((packageName) => hashDirectoryFiles(
      resolve(root, "node_modules", packageName),
      `node_modules/${packageName}`
    ));
  return scoreCodeIdentitySchema.parse({
    implementationVersion: physicalBlindScoreArtifactImplementationVersion,
    sourceFilesSha256: hashPhysicalBlindValue(entries),
    sourceFileCount: entries.length,
    workerSha256: entries[0]!.sha256,
    packageLockSha256: createHash("sha256")
      .update(readFileSync(resolve(root, "package-lock.json")))
      .digest("hex"),
    runtimeDependenciesSha256: hashPhysicalBlindValue(runtimeDependencies),
    runtimeDependencyFileCount: runtimeDependencies.length,
    bubblewrapSha256: createHash("sha256")
      .update(readFileSync("/usr/bin/bwrap"))
      .digest("hex"),
    nodeBinarySha256: createHash("sha256")
      .update(readFileSync(realpathSync(process.execPath)))
      .digest("hex"),
    nodeVersion: process.version
  });
}

function hashDirectoryFiles(
  directory: string,
  relativeDirectory: string
): { readonly relativePath: string; readonly sha256: string }[] {
  const result: { relativePath: string; sha256: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name)
  )) {
    const absolutePath = resolve(directory, entry.name);
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const status = lstatSync(absolutePath);
    if (status.isSymbolicLink() || (!status.isDirectory() && !status.isFile())) {
      failPhysicalBlind("BLIND_SCORE_CODE_IDENTITY_INVALID");
    }
    if (status.isDirectory()) {
      result.push(...hashDirectoryFiles(absolutePath, relativePath));
    } else {
      result.push({
        relativePath,
        sha256: createHash("sha256").update(readFileSync(absolutePath)).digest("hex")
      });
    }
  }
  return result;
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeArtifactBytes(value: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    failPhysicalBlind("BLIND_ARTIFACT_FILE_INVALID_UTF8");
  }
}
