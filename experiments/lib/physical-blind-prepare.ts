import { join } from "node:path";
import { z } from "zod";
import {
  reviewTaskProblemSchema,
  type ReviewTaskProblem
} from "../../src/pipelines/types";
import { toLegacyPipelineProblem } from "../../src/review-task-input";
import { robotReviewTaskSchema } from "../../src/urmotiv-schemas";
import {
  closePrivateDirectory,
  preparePrivateDirectory,
  projectPrivateRoot,
  workspaceRoot,
  type PrivateDirectoryHandle
} from "../../scripts/private-runtime.mjs";
import {
  assertBlindContentGoldBinding,
  type BlindGoldDataset,
  type BlindGoldSample
} from "./blind-evaluation";
import {
  assertUniquePhysicalBlindSampleIds,
  deepFreezePhysicalBlind,
  failPhysicalBlind,
  hashPhysicalBlindValue,
  parsePhysicalBlindJson,
  parseVersionedStrictArtifact,
  physicalBlindDigestSchema,
  physicalBlindPurposeSchema,
  physicalBlindSafeIdSchema,
  serializePhysicalBlindArtifact,
  type PhysicalBlindArtifactError,
  type PhysicalBlindPurpose
} from "./physical-blind-common";
import {
  buildPhysicalBlindContentArtifact,
  generatePhysicalBlindSafeId,
  loadPhysicalBlindContentArtifact,
  physicalBlindSourceIneligibilityReasonCode,
  physicalBlindProblemCoreIdentities,
  physicalBlindTextCoreIdentities,
  physicalBlindContentToLogicalDataset,
  serializePhysicalBlindContentArtifact,
  type PhysicalBlindContentArtifact,
  type PhysicalBlindProblemCoreIdentities
} from "./physical-blind-content";
import {
  readPrivateArtifactText,
  writePrivateArtifactExclusive
} from "./private-artifact-io";

export const physicalBlindContentFileName = "content.v1.json";
export const physicalBlindGoldFileName = "gold.v1.json";

const legacyCombinedV1SampleBase = z
  .object({
    safeId: physicalBlindSafeIdSchema,
    problem: reviewTaskProblemSchema,
    gold: z.unknown()
  })
  .strict();

const legacyCombinedV2SampleBase = z
  .object({
    safeId: physicalBlindSafeIdSchema,
    problem: robotReviewTaskSchema.shape.problem,
    gold: z.unknown()
  })
  .strict();

const purposeClaimSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal("blind-purpose-claim"),
    identityKind: z.enum(["statement", "statement-solution"]),
    itemIdentityFingerprint: physicalBlindDigestSchema,
    purpose: physicalBlindPurposeSchema
  })
  .strict();

export interface PhysicalBlindGoldArtifact<TGold> {
  readonly schemaVersion: 1;
  readonly artifactKind: "blind-gold";
  readonly datasetId: string;
  readonly purpose: PhysicalBlindPurpose;
  readonly sourceSchemaVersion: 1 | 2;
  readonly productionEligible: false;
  readonly sourceIneligibilityReasonCode: typeof physicalBlindSourceIneligibilityReasonCode;
  readonly contentIdentityFingerprint: string;
  readonly contentFingerprint: string;
  readonly goldFingerprint: string;
  readonly samples: readonly BlindGoldSample<TGold>[];
}

export interface PreparedPhysicalBlindArtifacts<TGold> {
  readonly sourceSchemaVersion: 1 | 2;
  readonly productionEligible: false;
  readonly sourceIneligibilityReasonCode: typeof physicalBlindSourceIneligibilityReasonCode;
  readonly content: PhysicalBlindContentArtifact;
  readonly gold: PhysicalBlindGoldArtifact<TGold>;
  readonly contentDocument: string;
  readonly goldDocument: string;
  /** 只含不可逆内容摘要；v2 同时登记完整视图和旧 basic 兼容身份。 */
  readonly purposeClaimIdentities: readonly PhysicalBlindPurposeClaimIdentities[];
}

export interface PhysicalBlindPurposeClaimIdentities {
  readonly statementFingerprints: readonly string[];
  readonly statementSolutionFingerprints: readonly string[];
}

export interface PhysicalBlindPrivateDirectoryOptions {
  readonly privateRoot?: string;
  readonly containingWorkspace?: string;
}

export interface PublishedPhysicalBlindArtifacts {
  readonly sourceSchemaVersion: 1 | 2;
  readonly productionEligible: false;
  readonly sourceIneligibilityReasonCode: typeof physicalBlindSourceIneligibilityReasonCode;
  readonly contentIdentityFingerprint: string;
  readonly contentFingerprint: string;
  readonly sampleCount: number;
  readonly contentDirectoryName: string;
  readonly goldDirectoryName: string;
}

/**
 * v1 只读取旧开发资料且永不具备生产资格；v2 严格接收当前机器人 problem
 * 快照，并在 trusted prepare 内组装完整的扁平题面/题解视图。
 */
export function projectLegacyCombinedBlindDocument<TGold>(input: {
  readonly document: string;
  readonly goldSchema: z.ZodType<TGold>;
}): PreparedPhysicalBlindArtifacts<TGold> {
  const legacyV1Schema = z
    .object({
      schemaVersion: z.literal(1),
      artifactKind: z.literal("legacy-blind-combined"),
      datasetId: physicalBlindSafeIdSchema,
      purpose: physicalBlindPurposeSchema,
      samples: z
        .array(
          legacyCombinedV1SampleBase.extend({ gold: input.goldSchema }).strict()
        )
        .min(1)
        .max(10_000)
    })
    .strict();
  const legacyV2Schema = z
    .object({
      schemaVersion: z.literal(2),
      artifactKind: z.literal("legacy-blind-combined"),
      datasetId: physicalBlindSafeIdSchema,
      purpose: physicalBlindPurposeSchema,
      samples: z
        .array(
          legacyCombinedV2SampleBase.extend({ gold: input.goldSchema }).strict()
        )
        .min(1)
        .max(10_000)
    })
    .strict();
  const value = parsePhysicalBlindJson(input.document);
  const rawVersion = typeof value === "object" && value !== null &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>).schemaVersion
    : undefined;
  let sourceSchemaVersion: 1 | 2;
  let datasetId: string;
  let purpose: PhysicalBlindPurpose;
  let samples: Array<{
    readonly safeId: string;
    readonly problem: ReviewTaskProblem;
    readonly gold: TGold;
  }>;
  let compatibilityIdentities: Array<
    PhysicalBlindProblemCoreIdentities | undefined
  >;
  if (rawVersion === 2) {
    const parsed = parseVersionedStrictArtifact({
      value,
      schema: legacyV2Schema,
      supportedVersions: [2]
    });
    sourceSchemaVersion = 2;
    datasetId = parsed.datasetId;
    purpose = parsed.purpose;
    samples = parsed.samples.map((sample) => ({
      safeId: sample.safeId,
      problem: toLegacyPipelineProblem(sample.problem),
      gold: sample.gold
    }));
    compatibilityIdentities = parsed.samples.map((sample) =>
      physicalBlindTextCoreIdentities({
        type: sample.problem.type,
        statement: sample.problem.content.basicStatement,
        solution: sample.problem.content.basicSolution
      })
    );
  } else {
    const parsed = parseVersionedStrictArtifact({
      value,
      schema: legacyV1Schema
    });
    sourceSchemaVersion = 1;
    datasetId = parsed.datasetId;
    purpose = parsed.purpose;
    samples = parsed.samples;
    compatibilityIdentities = parsed.samples.map(() => undefined);
  }
  if (purpose === "holdout") {
    failPhysicalBlind(physicalBlindSourceIneligibilityReasonCode);
  }
  assertUniquePhysicalBlindSampleIds(samples);
  if (
    new Set(samples.map((sample) => sample.problem.contentHash)).size !==
    samples.length
  ) {
    failPhysicalBlind("BLIND_ARTIFACT_DUPLICATE_CONTENT");
  }

  const projectedSamples = samples.map(({ problem }) => {
    const identities = physicalBlindProblemCoreIdentities(problem);
    return {
      safeId: generatePhysicalBlindSafeId(identities),
      problem,
      identities
    };
  });
  if (
    new Set(projectedSamples.map((sample) => sample.identities.statementFingerprint))
      .size !== projectedSamples.length ||
    new Set(
      projectedSamples.map(
        (sample) => sample.identities.statementSolutionFingerprint
      )
    ).size !== projectedSamples.length
  ) {
    failPhysicalBlind("BLIND_ARTIFACT_DUPLICATE_CORE_CONTENT");
  }
  const content = buildPhysicalBlindContentArtifact({
    datasetId,
    purpose,
    sourceSchemaVersion,
    samples: projectedSamples.map(({ safeId, problem }) => ({ safeId, problem }))
  });
  const gold = buildPhysicalBlindGoldArtifact({
    content,
    goldSchema: input.goldSchema,
    samples: projectedSamples.map(({ safeId, problem }, index) => ({
      safeId,
      contentHash: problem.contentHash,
      gold: samples[index]!.gold
    }))
  });
  const purposeClaimIdentities = projectedSamples.map((sample, index) => {
    const compatibility = compatibilityIdentities[index];
    return {
      statementFingerprints: uniqueFingerprints([
        sample.identities.statementFingerprint,
        ...(compatibility === undefined
          ? []
          : [compatibility.statementFingerprint])
      ]),
      statementSolutionFingerprints: uniqueFingerprints([
        sample.identities.statementSolutionFingerprint,
        ...(compatibility === undefined
          ? []
          : [compatibility.statementSolutionFingerprint])
      ])
    };
  });
  return deepFreezePhysicalBlind({
    sourceSchemaVersion,
    productionEligible: false as const,
    sourceIneligibilityReasonCode: physicalBlindSourceIneligibilityReasonCode,
    content,
    gold,
    contentDocument: serializePhysicalBlindContentArtifact(content),
    goldDocument: serializePhysicalBlindGoldArtifact(gold, input.goldSchema),
    purposeClaimIdentities
  });
}

export function buildPhysicalBlindGoldArtifact<TGold>(input: {
  readonly content: PhysicalBlindContentArtifact;
  readonly samples: readonly BlindGoldSample<TGold>[];
  readonly goldSchema: z.ZodType<TGold>;
}): PhysicalBlindGoldArtifact<TGold> {
  const content = loadPhysicalBlindContentArtifact(
    serializePhysicalBlindArtifact(input.content)
  );
  const withoutFingerprint = {
    schemaVersion: 1 as const,
    artifactKind: "blind-gold" as const,
    datasetId: content.datasetId,
    purpose: content.purpose,
    sourceSchemaVersion: content.sourceSchemaVersion,
    productionEligible: content.productionEligible,
    sourceIneligibilityReasonCode: content.sourceIneligibilityReasonCode,
    contentIdentityFingerprint: content.contentIdentityFingerprint,
    contentFingerprint: content.contentFingerprint,
    samples: input.samples
  };
  return loadPhysicalBlindGoldArtifact(
    serializePhysicalBlindArtifact({
      ...withoutFingerprint,
      goldFingerprint: hashPhysicalBlindValue(withoutFingerprint)
    }),
    input.goldSchema
  );
}

export function loadPhysicalBlindGoldArtifact<TGold>(
  document: string,
  goldSchema: z.ZodType<TGold>
): PhysicalBlindGoldArtifact<TGold> {
  const schema = z
    .object({
      schemaVersion: z.literal(1),
      artifactKind: z.literal("blind-gold"),
      datasetId: physicalBlindSafeIdSchema,
      purpose: physicalBlindPurposeSchema,
      sourceSchemaVersion: z.union([z.literal(1), z.literal(2)]),
      productionEligible: z.literal(false),
      sourceIneligibilityReasonCode: z.literal(
        physicalBlindSourceIneligibilityReasonCode
      ),
      contentIdentityFingerprint: physicalBlindDigestSchema,
      contentFingerprint: physicalBlindDigestSchema,
      goldFingerprint: physicalBlindDigestSchema,
      samples: z
        .array(
          z
            .object({
              safeId: physicalBlindSafeIdSchema,
              contentHash: physicalBlindDigestSchema,
              gold: goldSchema
            })
            .strict()
        )
        .min(1)
        .max(10_000)
    })
    .strict();
  const parsed = parseVersionedStrictArtifact({
    value: parsePhysicalBlindJson(document),
    schema
  });
  assertUniquePhysicalBlindSampleIds(parsed.samples);
  const { goldFingerprint: _goldFingerprint, ...withoutFingerprint } = parsed;
  if (parsed.goldFingerprint !== hashPhysicalBlindValue(withoutFingerprint)) {
    failPhysicalBlind("BLIND_ARTIFACT_HASH_MISMATCH");
  }
  return deepFreezePhysicalBlind(parsed);
}

export function serializePhysicalBlindGoldArtifact<TGold>(
  artifact: PhysicalBlindGoldArtifact<TGold>,
  goldSchema: z.ZodType<TGold>
): string {
  const verified = loadPhysicalBlindGoldArtifact(
    serializePhysicalBlindArtifact(artifact),
    goldSchema
  );
  return serializePhysicalBlindArtifact(verified);
}

export function assertPhysicalBlindContentGoldBinding<TGold>(input: {
  readonly content: PhysicalBlindContentArtifact;
  readonly gold: PhysicalBlindGoldArtifact<TGold>;
}): void {
  const content = loadPhysicalBlindContentArtifact(
    serializePhysicalBlindArtifact(input.content)
  );
  if (
    input.gold.datasetId !== content.datasetId ||
    input.gold.purpose !== content.purpose ||
    input.gold.sourceSchemaVersion !== content.sourceSchemaVersion ||
    input.gold.productionEligible !== content.productionEligible ||
    input.gold.sourceIneligibilityReasonCode !==
      content.sourceIneligibilityReasonCode ||
    input.gold.contentIdentityFingerprint !==
      content.contentIdentityFingerprint ||
    input.gold.contentFingerprint !== content.contentFingerprint
  ) {
    failPhysicalBlind("BLIND_ARTIFACT_IDENTITY_MISMATCH");
  }
  const logicalGold: BlindGoldDataset<unknown> = {
    schemaVersion: 1,
    datasetId: input.gold.datasetId,
    purpose: input.gold.purpose,
    contentFingerprint: input.gold.contentFingerprint,
    samples: input.gold.samples
  };
  try {
    assertBlindContentGoldBinding(
      physicalBlindContentToLogicalDataset(content),
      logicalGold
    );
  } catch {
    failPhysicalBlind("BLIND_ARTIFACT_SAMPLE_SET_MISMATCH");
  }
}

/**
 * 写盘时先永久登记 content-only purpose claim，再写 gold，最后才发布 content。
 * 推理进程只拿 content 目录，即使准备中断也不会误读半份已发布内容。
 */
export function preparePhysicalBlindArtifactsFromPrivateFile<TGold>(input: {
  readonly sourceDirectory: string;
  readonly sourceFileName: string;
  readonly outputDirectory: string;
  readonly goldSchema: z.ZodType<TGold>;
  readonly directoryOptions?: PhysicalBlindPrivateDirectoryOptions;
}): PublishedPhysicalBlindArtifacts {
  const privateRoot = input.directoryOptions?.privateRoot ?? projectPrivateRoot;
  const containingWorkspace =
    input.directoryOptions?.containingWorkspace ?? workspaceRoot;
  const runtimeOptions = { privateRoot, containingWorkspace };
  let source: PrivateDirectoryHandle | undefined;
  let output: PrivateDirectoryHandle | undefined;
  let claims: PrivateDirectoryHandle | undefined;
  let statementClaims: PrivateDirectoryHandle | undefined;
  let statementSolutionClaims: PrivateDirectoryHandle | undefined;
  let contentDirectory: PrivateDirectoryHandle | undefined;
  let goldDirectory: PrivateDirectoryHandle | undefined;
  try {
    source = preparePrivateDirectory(input.sourceDirectory, runtimeOptions);
    if (source.created) {
      failPhysicalBlind("BLIND_ARTIFACT_SOURCE_DIRECTORY_MISSING");
    }
    const prepared = projectLegacyCombinedBlindDocument({
      document: readPrivateArtifactText(source, input.sourceFileName),
      goldSchema: input.goldSchema
    });
    output = preparePrivateDirectory(input.outputDirectory, runtimeOptions);
    claims = preparePrivateDirectory(
      join(privateRoot, "blind-purpose-claims"),
      runtimeOptions
    );
    statementClaims = preparePrivateDirectory(
      join(privateRoot, "blind-purpose-claims", "statement"),
      runtimeOptions
    );
    statementSolutionClaims = preparePrivateDirectory(
      join(privateRoot, "blind-purpose-claims", "statement-solution"),
      runtimeOptions
    );
    for (const identities of prepared.purposeClaimIdentities) {
      for (const fingerprint of identities.statementFingerprints) {
        assertOrPublishPurposeClaim({
          directory: statementClaims,
          identityKind: "statement",
          itemIdentityFingerprint: fingerprint,
          purpose: prepared.content.purpose
        });
      }
      for (const fingerprint of identities.statementSolutionFingerprints) {
        assertOrPublishPurposeClaim({
          directory: statementSolutionClaims,
          identityKind: "statement-solution",
          itemIdentityFingerprint: fingerprint,
          purpose: prepared.content.purpose
        });
      }
    }

    const identity = prepared.content.contentIdentityFingerprint;
    const contentDirectoryName = `${identity}.content`;
    const goldDirectoryName = `${identity}.gold`;
    contentDirectory = preparePrivateDirectory(
      join(input.outputDirectory, contentDirectoryName),
      runtimeOptions
    );
    goldDirectory = preparePrivateDirectory(
      join(input.outputDirectory, goldDirectoryName),
      runtimeOptions
    );
    writePrivateArtifactExclusive(
      goldDirectory,
      physicalBlindGoldFileName,
      prepared.goldDocument
    );
    writePrivateArtifactExclusive(
      contentDirectory,
      physicalBlindContentFileName,
      prepared.contentDocument
    );
    return deepFreezePhysicalBlind({
      sourceSchemaVersion: prepared.sourceSchemaVersion,
      productionEligible: prepared.productionEligible,
      sourceIneligibilityReasonCode: prepared.sourceIneligibilityReasonCode,
      contentIdentityFingerprint: identity,
      contentFingerprint: prepared.content.contentFingerprint,
      sampleCount: prepared.content.samples.length,
      contentDirectoryName,
      goldDirectoryName
    });
  } finally {
    for (const handle of [
      goldDirectory,
      contentDirectory,
      statementSolutionClaims,
      statementClaims,
      claims,
      output,
      source
    ]) {
      if (handle !== undefined) {
        closePrivateDirectory(handle);
      }
    }
  }
}

function uniqueFingerprints(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function assertOrPublishPurposeClaim(input: {
  readonly directory: PrivateDirectoryHandle;
  readonly identityKind: "statement" | "statement-solution";
  readonly itemIdentityFingerprint: string;
  readonly purpose: PhysicalBlindPurpose;
}): void {
  const fileName = `${input.itemIdentityFingerprint}.purpose.v1.json`;
  const claim = {
    schemaVersion: 1 as const,
    artifactKind: "blind-purpose-claim" as const,
    identityKind: input.identityKind,
    itemIdentityFingerprint: input.itemIdentityFingerprint,
    purpose: input.purpose
  };
  let existing: string | undefined;
  try {
    existing = readPrivateArtifactText(input.directory, fileName);
  } catch (error) {
    if (physicalBlindErrorCode(error) !== "BLIND_ARTIFACT_FILE_MISSING") {
      throw error;
    }
  }
  if (existing === undefined) {
    try {
      writePrivateArtifactExclusive(
        input.directory,
        fileName,
        serializePhysicalBlindArtifact(claim)
      );
      return;
    } catch (error) {
      if (physicalBlindErrorCode(error) !== "BLIND_ARTIFACT_ALREADY_EXISTS") {
        throw error;
      }
      existing = readPrivateArtifactText(input.directory, fileName);
    }
  }
  const parsed = parseVersionedStrictArtifact({
    value: parsePhysicalBlindJson(existing),
    schema: purposeClaimSchema
  });
  if (
    parsed.identityKind !== input.identityKind ||
    parsed.itemIdentityFingerprint !== input.itemIdentityFingerprint
  ) {
    failPhysicalBlind("BLIND_PURPOSE_CLAIM_IDENTITY_MISMATCH");
  }
  if (parsed.purpose !== input.purpose) {
    failPhysicalBlind("BLIND_DATASET_PURPOSE_RELABELED");
  }
}

function physicalBlindErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as PhysicalBlindArtifactError).code)
    : undefined;
}
