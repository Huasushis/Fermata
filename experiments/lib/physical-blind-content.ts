import { z } from "zod";
import { reviewTaskProblemSchema } from "../../src/pipelines/types";
import {
  assertBlindContentDataset,
  buildBlindContentDataset,
  type BlindContentDataset,
  type BlindProblemContentSample
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
  type PhysicalBlindPurpose
} from "./physical-blind-common";

export const physicalBlindSourceIneligibilityReasonCode =
  "BLIND_HOLDOUT_LEDGER_MIGRATION_REQUIRED" as const;

const physicalBlindContentSampleSchema = z
  .object({
    safeId: z.string().regex(/^sample-[0-9a-f]{32}$/),
    problem: reviewTaskProblemSchema
  })
  .strict();

const physicalBlindContentArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal("blind-content"),
    datasetId: physicalBlindSafeIdSchema,
    purpose: physicalBlindPurposeSchema,
    sourceSchemaVersion: z.union([z.literal(1), z.literal(2)]),
    productionEligible: z.literal(false),
    sourceIneligibilityReasonCode: z.literal(
      physicalBlindSourceIneligibilityReasonCode
    ),
    contentIdentityFingerprint: physicalBlindDigestSchema,
    contentFingerprint: physicalBlindDigestSchema,
    samples: z.array(physicalBlindContentSampleSchema).min(1).max(10_000)
  })
  .strict();

export interface PhysicalBlindContentArtifact {
  readonly schemaVersion: 1;
  readonly artifactKind: "blind-content";
  readonly datasetId: string;
  readonly purpose: PhysicalBlindPurpose;
  readonly sourceSchemaVersion: 1 | 2;
  readonly productionEligible: false;
  readonly sourceIneligibilityReasonCode: typeof physicalBlindSourceIneligibilityReasonCode;
  /** 只由题目内容集合计算，不含 datasetId、purpose、safeId 或 gold。 */
  readonly contentIdentityFingerprint: string;
  readonly contentFingerprint: string;
  readonly samples: readonly BlindProblemContentSample[];
}

export function buildPhysicalBlindContentArtifact(input: {
  readonly datasetId: string;
  readonly purpose: PhysicalBlindPurpose;
  readonly sourceSchemaVersion: 1 | 2;
  readonly samples: readonly BlindProblemContentSample[];
}): PhysicalBlindContentArtifact {
  const content = buildBlindContentDataset(input);
  const artifact = {
    schemaVersion: 1 as const,
    artifactKind: "blind-content" as const,
    datasetId: content.datasetId,
    purpose: content.purpose,
    sourceSchemaVersion: input.sourceSchemaVersion,
    productionEligible: false as const,
    sourceIneligibilityReasonCode: physicalBlindSourceIneligibilityReasonCode,
    contentIdentityFingerprint: physicalBlindContentIdentity(content.samples),
    contentFingerprint: content.contentFingerprint,
    samples: content.samples
  };
  return loadPhysicalBlindContentArtifact(
    serializePhysicalBlindArtifact(artifact)
  );
}

export function loadPhysicalBlindContentArtifact(
  document: string
): PhysicalBlindContentArtifact {
  const parsed = parseVersionedStrictArtifact({
    value: parsePhysicalBlindJson(document),
    schema: physicalBlindContentArtifactSchema
  });
  assertUniquePhysicalBlindSampleIds(parsed.samples);
  if (
    parsed.samples.some(
      (sample) =>
        sample.safeId !==
        generatePhysicalBlindSafeId(
          physicalBlindProblemCoreIdentities(sample.problem)
        )
    )
  ) {
    failPhysicalBlind("BLIND_ARTIFACT_SAFE_ID_MISMATCH");
  }
  const contentHashes = parsed.samples.map((sample) => sample.problem.contentHash);
  if (new Set(contentHashes).size !== contentHashes.length) {
    failPhysicalBlind("BLIND_ARTIFACT_DUPLICATE_CONTENT");
  }
  if (
    parsed.contentIdentityFingerprint !==
    physicalBlindContentIdentity(parsed.samples)
  ) {
    failPhysicalBlind("BLIND_ARTIFACT_HASH_MISMATCH");
  }
  let content: BlindContentDataset;
  try {
    content = assertBlindContentDataset({
      schemaVersion: 1,
      datasetId: parsed.datasetId,
      purpose: parsed.purpose,
      contentFingerprint: parsed.contentFingerprint,
      samples: parsed.samples
    });
  } catch {
    failPhysicalBlind("BLIND_ARTIFACT_HASH_MISMATCH");
  }
  return deepFreezePhysicalBlind({
    ...parsed,
    samples: content.samples
  });
}

export function serializePhysicalBlindContentArtifact(
  artifact: PhysicalBlindContentArtifact
): string {
  const verified = loadPhysicalBlindContentArtifact(
    serializePhysicalBlindArtifact(artifact)
  );
  return serializePhysicalBlindArtifact(verified);
}

export function physicalBlindContentToLogicalDataset(
  artifact: PhysicalBlindContentArtifact
): BlindContentDataset {
  const verified = loadPhysicalBlindContentArtifact(
    serializePhysicalBlindArtifact(artifact)
  );
  return assertBlindContentDataset({
    schemaVersion: 1,
    datasetId: verified.datasetId,
    purpose: verified.purpose,
    contentFingerprint: verified.contentFingerprint,
    samples: verified.samples
  });
}

/**
 * 数据集绑定只取逐题的规范化题面+题解核心身份，并排序后再哈希；逐题跨 purpose
 * 防重由 trusted prepare 的全局 claim 账本完成，不能只依赖这个集合指纹。
 */
export function physicalBlindContentIdentity(
  samples: readonly BlindProblemContentSample[]
): string {
  const itemFingerprints = samples
    .map((sample) => physicalBlindProblemCoreIdentities(sample.problem))
    .sort((left, right) =>
      left.statementSolutionFingerprint.localeCompare(
        right.statementSolutionFingerprint
      )
    );
  return hashPhysicalBlindValue({
    schemaVersion: 1,
    itemFingerprints
  });
}

export interface PhysicalBlindProblemCoreIdentities {
  readonly statementFingerprint: string;
  readonly statementSolutionFingerprint: string;
}

/** 包装 id、revision、contentHash、tagIds、title 改变都不会改变这两个核心身份。 */
export function physicalBlindProblemCoreIdentities(
  problem: BlindProblemContentSample["problem"]
): PhysicalBlindProblemCoreIdentities {
  return physicalBlindTextCoreIdentities({
    type: problem.type,
    statement: problem.basicStatement,
    solution: problem.basicSolution
  });
}

export function physicalBlindTextCoreIdentities(input: {
  readonly type: BlindProblemContentSample["problem"]["type"];
  readonly statement: string;
  readonly solution: string;
}): PhysicalBlindProblemCoreIdentities {
  const statementCore = {
    schemaVersion: 1 as const,
    type: input.type,
    statement: normalizePhysicalBlindCoreText(input.statement)
  };
  const statementFingerprint = hashPhysicalBlindValue(statementCore);
  return {
    statementFingerprint,
    statementSolutionFingerprint: hashPhysicalBlindValue({
      schemaVersion: 1,
      statementFingerprint,
      solution: normalizePhysicalBlindCoreText(input.solution)
    })
  };
}

export function generatePhysicalBlindSafeId(
  identities: PhysicalBlindProblemCoreIdentities
): string {
  return `sample-${hashPhysicalBlindValue({
    schemaVersion: 1,
    statementFingerprint: identities.statementFingerprint,
    statementSolutionFingerprint: identities.statementSolutionFingerprint
  }).slice(0, 32)}`;
}

function normalizePhysicalBlindCoreText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .trim();
}
