import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  closePrivateDirectory,
  preparePrivateDirectory
} from "../scripts/private-runtime.mjs";
import {
  PhysicalBlindArtifactError,
  hashPhysicalBlindValue,
  serializePhysicalBlindArtifact
} from "../experiments/lib/physical-blind-common";
import {
  loadPhysicalBlindContentArtifact,
  physicalBlindProblemCoreIdentities
} from "../experiments/lib/physical-blind-content";
import {
  buildPhysicalBlindPredictionArtifact,
  runPhysicalBlindInference,
  serializePhysicalBlindPredictionArtifact
} from "../experiments/lib/physical-blind-inference";
import {
  sealPhysicalBlindOutcomeDocument
} from "../experiments/lib/physical-blind-outcomes";
import {
  preparePhysicalBlindArtifactsFromPrivateFile,
  projectLegacyCombinedBlindDocument
} from "../experiments/lib/physical-blind-prepare";
import {
  physicalBlindProfile,
  physicalBlindProfileImplementationVersion
} from "../experiments/lib/physical-blind-profiles";
import {
  loadPhysicalBlindScoreArtifact,
  physicalBlindScoreCodeIdentity,
  verifyPhysicalBlindScoreArtifact
} from "../experiments/lib/physical-blind-score-artifact";
import {
  runPhysicalBlindScoreSandbox,
  verifyPhysicalBlindScoreSandbox
} from "../experiments/lib/physical-blind-score-sandbox";
import {
  assertPhysicalBlindPredictionScorable,
  scorePhysicalBlindArtifacts
} from "../experiments/lib/physical-blind-score";
import {
  ensurePrivateArtifactExact,
  openPrivateArtifactSnapshotDescriptor,
  verifyAndClosePrivateArtifactSnapshotDescriptor,
  writePrivateArtifactExclusive
} from "../experiments/lib/private-artifact-io";
import type { ReviewTaskProblem } from "../src/pipelines/types";
import type { RobotReviewTask } from "../src/urmotiv-schemas";

const sentinel = "SYNTHETIC_GOLD_SENTINEL_ONLY_FOR_TESTS";
const genericGoldSchema = z
  .object({
    officialRating: z.number().int(),
    expectedVerdict: z.string()
  })
  .strict();
const simplePredictionSchema = z
  .object({ rating: z.number().int().min(800).max(3500) })
  .strict();

function problem(
  coreId: string,
  overrides: Partial<ReviewTaskProblem> = {}
): ReviewTaskProblem {
  return {
    id: `wrapper-${coreId}`,
    revision: 1,
    reviewRound: 1,
    contentHash: createHash("sha256").update(`wrapper-${coreId}`).digest("hex"),
    title: `synthetic-${coreId}`,
    type: "traditional",
    tagIds: ["synthetic"],
    basicStatement: `statement-${coreId}`,
    basicSolution: `solution-${coreId}`,
    ...overrides
  };
}

interface CombinedSample {
  readonly legacySafeId: string;
  readonly problem: ReviewTaskProblem;
  readonly gold: unknown;
}

type RobotProblem = RobotReviewTask["problem"];

function robotProblem(coreId: string): RobotProblem {
  return {
    id: `robot-${coreId}`,
    revision: 1,
    reviewRound: 1,
    contentHash: createHash("sha256").update(`robot-${coreId}`).digest("hex"),
    title: `robot-${coreId}`,
    type: "traditional",
    tagIds: ["synthetic"],
    content: {
      basicStatement: `basic-statement-${coreId}`,
      basicSolution: `basic-solution-${coreId}`,
      background: `background-${coreId}`,
      statement: `statement-${coreId}`,
      inputFormat: `input-format-${coreId}`,
      outputFormat: `output-format-${coreId}`,
      constraints: `constraints-${coreId}`,
      solution: `detailed-solution-${coreId}`,
      hints: `hints-${coreId}`
    },
    samples: [{
      safeId: "sample-001",
      input: `sample-input-${coreId}`,
      output: `sample-output-${coreId}`,
      explanation: `sample-explanation-${coreId}`
    }],
    limits: { timeMs: 1_000, memoryMiB: 256 }
  };
}

function combinedV2Document(
  problemValue: RobotProblem,
  options: {
    readonly datasetId?: string;
    readonly purpose?: "development" | "holdout";
    readonly safeId?: string;
    readonly gold?: unknown;
  } = {}
): string {
  return JSON.stringify({
    schemaVersion: 2,
    artifactKind: "legacy-blind-combined",
    datasetId: options.datasetId ?? "synthetic-v2",
    purpose: options.purpose ?? "development",
    samples: [{
      safeId: options.safeId ?? "legacy-semantic-id",
      problem: problemValue,
      gold: options.gold ?? { officialRating: 1800, expectedVerdict: sentinel }
    }]
  });
}

function combinedV2DatasetDocument(input: {
  readonly datasetId: string;
  readonly purpose: "development" | "holdout";
  readonly samples: readonly {
    readonly safeId: string;
    readonly problem: RobotProblem;
    readonly gold: unknown;
  }[];
}): string {
  return JSON.stringify({
    schemaVersion: 2,
    artifactKind: "legacy-blind-combined",
    ...input
  });
}

function combinedDocument(input: {
  readonly datasetId?: string;
  readonly purpose?: "development" | "holdout";
  readonly samples?: readonly CombinedSample[];
  readonly schemaVersion?: number;
  readonly extra?: Readonly<Record<string, unknown>>;
} = {}): string {
  const samples = input.samples ?? ["a", "b"].map((id, index) => ({
    legacySafeId: `legacy-rating-${index === 0 ? 3500 : 800}-reject`,
    problem: problem(id),
    gold: {
      officialRating: index === 0 ? 1800 : 2400,
      expectedVerdict: sentinel
    }
  }));
  return JSON.stringify({
    schemaVersion: input.schemaVersion ?? 1,
    artifactKind: "legacy-blind-combined",
    datasetId: input.datasetId ?? "synthetic-development",
    purpose: input.purpose ?? "development",
    samples: samples.map((sample) => ({
      safeId: sample.legacySafeId,
      problem: sample.problem,
      gold: sample.gold
    })),
    ...input.extra
  });
}

describe("物理盲测可信边界", () => {
  let workspace: string;
  let privateRoot: string;
  let sourceDirectory: string;
  let outputDirectory: string;
  let directoryOptions: {
    readonly privateRoot: string;
    readonly containingWorkspace: string;
  };

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "fermata-physical-blind-"));
    chmodSync(workspace, 0o700);
    const repository = join(workspace, "Fermata");
    mkdirSync(repository, { mode: 0o700 });
    privateRoot = join(repository, "private");
    mkdirSync(privateRoot, { mode: 0o700 });
    sourceDirectory = join(privateRoot, "source");
    mkdirSync(sourceDirectory, { mode: 0o700 });
    outputDirectory = join(privateRoot, "artifacts");
    directoryOptions = { privateRoot, containingWorkspace: workspace };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("trusted prepare 忽略 legacy safeId，并只生成无语义稳定编号", () => {
    const prepared = projectLegacyCombinedBlindDocument({
      document: combinedDocument(),
      goldSchema: genericGoldSchema
    });
    expect(prepared.sourceSchemaVersion).toBe(1);
    expect(prepared.productionEligible).toBe(false);
    expect(prepared.content.productionEligible).toBe(false);
    expect(prepared.gold.productionEligible).toBe(false);
    expect(prepared.sourceIneligibilityReasonCode).toBe(
      "BLIND_HOLDOUT_LEDGER_MIGRATION_REQUIRED"
    );
    expect(prepared.content.samples).toHaveLength(2);
    expect(
      prepared.content.samples.every((sample) =>
        /^sample-[0-9a-f]{32}$/.test(sample.safeId)
      )
    ).toBe(true);
    expect(prepared.contentDocument).not.toContain("legacy-rating");
    expect(prepared.contentDocument).not.toContain(sentinel);
    expect(prepared.contentDocument).not.toContain("officialRating");
    expect(prepared.goldDocument).toContain(sentinel);

    const original = physicalBlindProblemCoreIdentities(problem("a"));
    const repackaged = physicalBlindProblemCoreIdentities(problem("a", {
      id: "other-id",
      revision: 99,
      reviewRound: 42,
      contentHash: "f".repeat(64),
      title: "other title",
      tagIds: ["other"],
      basicStatement: "  statement-a\r\n"
    }));
    expect(repackaged).toEqual(original);
    expect(() => projectLegacyCombinedBlindDocument({
      document: combinedDocument({ purpose: "holdout" }),
      goldSchema: genericGoldSchema
    })).toThrowError(expect.objectContaining({
      code: "BLIND_HOLDOUT_LEDGER_MIGRATION_REQUIRED"
    }));
  });

  it("v2 trusted prepare 组装完整机器人快照，全部题面/样例/限制/题解都进入身份", () => {
    const base = robotProblem("complete");
    const baseline = projectLegacyCombinedBlindDocument({
      document: combinedV2Document(base),
      goldSchema: genericGoldSchema
    });
    expect(baseline.sourceSchemaVersion).toBe(2);
    expect(baseline.productionEligible).toBe(false);
    expect(baseline.content.productionEligible).toBe(false);
    expect(baseline.sourceIneligibilityReasonCode).toBe(
      "BLIND_HOLDOUT_LEDGER_MIGRATION_REQUIRED"
    );
    const assembled = baseline.content.samples[0]!.problem;
    for (const marker of [
      "basic-statement-complete",
      "background-complete",
      "statement-complete",
      "input-format-complete",
      "output-format-complete",
      "constraints-complete",
      "hints-complete",
      "sample-input-complete",
      "sample-output-complete",
      "sample-explanation-complete",
      "1000 ms",
      "256 MiB"
    ]) {
      expect(assembled.basicStatement).toContain(marker);
    }
    expect(assembled.basicSolution).toContain("basic-solution-complete");
    expect(assembled.basicSolution).toContain("detailed-solution-complete");

    const variants: Array<{
      readonly kind: "statement" | "solution";
      readonly problem: RobotProblem;
    }> = [];
    const statementFields: Array<keyof Omit<RobotProblem["content"],
      "basicSolution" | "solution">> = [
      "basicStatement",
      "background",
      "statement",
      "inputFormat",
      "outputFormat",
      "constraints",
      "hints"
    ];
    for (const field of statementFields) {
      const changed = structuredClone(base);
      changed.content[field] += "-changed";
      variants.push({ kind: "statement", problem: changed });
    }
    for (const field of ["basicSolution", "solution"] as const) {
      const changed = structuredClone(base);
      changed.content[field] += "-changed";
      variants.push({ kind: "solution", problem: changed });
    }
    for (const field of ["input", "output", "explanation"] as const) {
      const changed = structuredClone(base);
      changed.samples[0]![field] += "-changed";
      variants.push({ kind: "statement", problem: changed });
    }
    for (const field of ["timeMs", "memoryMiB"] as const) {
      const changed = structuredClone(base);
      changed.limits![field] += 1;
      variants.push({ kind: "statement", problem: changed });
    }

    const baselineIdentities = physicalBlindProblemCoreIdentities(assembled);
    for (const variant of variants) {
      const projected = projectLegacyCombinedBlindDocument({
        document: combinedV2Document(variant.problem),
        goldSchema: genericGoldSchema
      });
      const identities = physicalBlindProblemCoreIdentities(
        projected.content.samples[0]!.problem
      );
      if (variant.kind === "statement") {
        expect(identities.statementFingerprint).not.toBe(
          baselineIdentities.statementFingerprint
        );
      } else {
        expect(identities.statementFingerprint).toBe(
          baselineIdentities.statementFingerprint
        );
      }
      expect(identities.statementSolutionFingerprint).not.toBe(
        baselineIdentities.statementSolutionFingerprint
      );
      expect(projected.content.contentIdentityFingerprint).not.toBe(
        baseline.content.contentIdentityFingerprint
      );
      expect(projected.content.contentFingerprint).not.toBe(
        baseline.content.contentFingerprint
      );
    }
  });

  it("旧 development 账本未迁移时，v2 holdout 在登记任何新 claim 前固定拒绝", () => {
    writeFileSync(
      join(sourceDirectory, "development.json"),
      combinedV2DatasetDocument({
        datasetId: "development-v2",
        purpose: "development",
        samples: ["a", "b"].map((id) => ({
          safeId: `legacy-${id}`,
          problem: robotProblem(id),
          gold: { officialRating: 1800, expectedVerdict: sentinel }
        }))
      }),
      { mode: 0o600 }
    );
    preparePhysicalBlindArtifactsFromPrivateFile({
      sourceDirectory,
      sourceFileName: "development.json",
      outputDirectory,
      goldSchema: genericGoldSchema,
      directoryOptions
    });
    const originalA = robotProblem("a");
    const repackagedA: RobotProblem = {
      ...originalA,
      id: "renamed",
      revision: 7,
      reviewRound: 8,
      contentHash: "e".repeat(64),
      title: "renamed title",
      tagIds: ["renamed"]
    };
    writeFileSync(
      join(sourceDirectory, "holdout.json"),
      combinedV2DatasetDocument({
        datasetId: "different-dataset",
        purpose: "holdout",
        samples: [
          { safeId: "new-safe-id", problem: repackagedA, gold: {
            officialRating: 1,
            expectedVerdict: sentinel
          } },
          { safeId: "new-c", problem: robotProblem("c"), gold: {
            officialRating: 2,
            expectedVerdict: sentinel
          } }
        ]
      }),
      { mode: 0o600 }
    );
    expect(() => preparePhysicalBlindArtifactsFromPrivateFile({
      sourceDirectory,
      sourceFileName: "holdout.json",
      outputDirectory: join(privateRoot, "other-output"),
      goldSchema: genericGoldSchema,
      directoryOptions
    })).toThrowError(expect.objectContaining<Partial<PhysicalBlindArtifactError>>({
      code: "BLIND_HOLDOUT_LEDGER_MIGRATION_REQUIRED"
    }));
    const claimRoot = join(privateRoot, "blind-purpose-claims");
    expect(readdirSync(join(claimRoot, "statement"))).toHaveLength(4);
    expect(readdirSync(join(claimRoot, "statement-solution"))).toHaveLength(4);
    for (const kind of ["statement", "statement-solution"]) {
      for (const fileName of readdirSync(join(claimRoot, kind))) {
        const claim = readFileSync(join(claimRoot, kind, fileName), "utf8");
        expect(claim).not.toContain(sentinel);
        expect(claim).not.toContain("officialRating");
      }
    }
  });

  it("v1 development 与同题 v2 快照共享 basic 兼容身份，且 v2 holdout 仍固定关闭", () => {
    const legacy = projectLegacyCombinedBlindDocument({
      document: combinedDocument({
        samples: [{
          legacySafeId: "legacy-cross-version",
          problem: problem("cross-version"),
          gold: { officialRating: 1800, expectedVerdict: sentinel }
        }]
      }),
      goldSchema: genericGoldSchema
    });
    const v2 = robotProblem("cross-version");
    const v2Problem = {
      ...v2,
      content: {
        ...v2.content,
        basicStatement: "statement-cross-version",
        basicSolution: "solution-cross-version"
      }
    };
    const current = projectLegacyCombinedBlindDocument({
      document: combinedV2Document(v2Problem),
      goldSchema: genericGoldSchema
    });
    const legacyClaims = legacy.purposeClaimIdentities[0]!;
    const currentClaims = current.purposeClaimIdentities[0]!;
    expect(currentClaims.statementFingerprints.some((fingerprint) =>
      legacyClaims.statementFingerprints.includes(fingerprint)
    )).toBe(true);
    expect(currentClaims.statementSolutionFingerprints.some((fingerprint) =>
      legacyClaims.statementSolutionFingerprints.includes(fingerprint)
    )).toBe(true);
    expect(() => projectLegacyCombinedBlindDocument({
      document: combinedV2Document(v2Problem, {
        datasetId: "cross-version-holdout",
        purpose: "holdout"
      }),
      goldSchema: genericGoldSchema
    })).toThrowError(expect.objectContaining({
      code: "BLIND_HOLDOUT_LEDGER_MIGRATION_REQUIRED"
    }));
  });

  it("完整题面相同但完整题解变化时，只靠 statement identity 也能识别同题", () => {
    const developmentProblem = robotProblem("same");
    const development = projectLegacyCombinedBlindDocument({
      document: combinedV2Document(developmentProblem),
      goldSchema: genericGoldSchema
    });
    const changedSolution = projectLegacyCombinedBlindDocument({
      document: combinedV2Document({
        ...developmentProblem,
        content: {
          ...developmentProblem.content,
          basicSolution: "different basic solution",
          solution: "different detailed solution"
        }
      }, {
        datasetId: "different-solution-development"
      }),
      goldSchema: genericGoldSchema
    });
    const originalClaims = development.purposeClaimIdentities[0]!;
    const changedClaims = changedSolution.purposeClaimIdentities[0]!;
    expect(changedClaims.statementFingerprints).toEqual(
      originalClaims.statementFingerprints
    );
    expect(changedClaims.statementSolutionFingerprints.some((fingerprint) =>
      originalClaims.statementSolutionFingerprints.includes(fingerprint)
    )).toBe(false);
  });

  it("同一批内重复核心题面、版本、缺字段和额外字段都固定拒绝", () => {
    const duplicate = combinedDocument({
      samples: [
        { legacySafeId: "a", problem: problem("dup"), gold: {
          officialRating: 1,
          expectedVerdict: sentinel
        } },
        { legacySafeId: "b", problem: problem("dup", {
          id: "other",
          contentHash: "d".repeat(64)
        }), gold: { officialRating: 2, expectedVerdict: sentinel } }
      ]
    });
    expect(() => projectLegacyCombinedBlindDocument({
      document: duplicate,
      goldSchema: genericGoldSchema
    })).toThrowError(expect.objectContaining({
      code: "BLIND_ARTIFACT_DUPLICATE_CORE_CONTENT"
    }));
    expect(() => projectLegacyCombinedBlindDocument({
      document: combinedDocument({ schemaVersion: 3 }),
      goldSchema: genericGoldSchema
    })).toThrowError(expect.objectContaining({
      code: "BLIND_ARTIFACT_VERSION_UNSUPPORTED"
    }));
    expect(() => projectLegacyCombinedBlindDocument({
      document: combinedDocument({ extra: { surprise: true } }),
      goldSchema: genericGoldSchema
    })).toThrowError(expect.objectContaining({
      code: "BLIND_ARTIFACT_EXTRA_FIELD"
    }));
    const missing = JSON.parse(combinedDocument()) as Record<string, unknown>;
    delete missing.samples;
    expect(() => projectLegacyCombinedBlindDocument({
      document: JSON.stringify(missing),
      goldSchema: genericGoldSchema
    })).toThrowError(expect.objectContaining({
      code: "BLIND_ARTIFACT_FIELD_MISSING"
    }));
  });

  it("0600/0700、符号链接、哈希和不可覆盖发布边界保持关闭", () => {
    const sourceFile = join(sourceDirectory, "legacy.json");
    writeFileSync(sourceFile, combinedDocument(), { mode: 0o600 });
    const published = preparePhysicalBlindArtifactsFromPrivateFile({
      sourceDirectory,
      sourceFileName: "legacy.json",
      outputDirectory,
      goldSchema: genericGoldSchema,
      directoryOptions
    });
    const contentDirectory = join(outputDirectory, published.contentDirectoryName);
    const goldDirectory = join(outputDirectory, published.goldDirectoryName);
    expect(lstatSync(contentDirectory).mode & 0o777).toBe(0o700);
    expect(lstatSync(goldDirectory).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(contentDirectory, "content.v1.json")).mode & 0o777)
      .toBe(0o600);
    expect(lstatSync(join(goldDirectory, "gold.v1.json")).mode & 0o777)
      .toBe(0o600);
    expect(() => preparePhysicalBlindArtifactsFromPrivateFile({
      sourceDirectory,
      sourceFileName: "legacy.json",
      outputDirectory,
      goldSchema: genericGoldSchema,
      directoryOptions
    })).toThrowError(expect.objectContaining({
      code: "BLIND_ARTIFACT_ALREADY_EXISTS"
    }));

    const parsed = JSON.parse(
      readFileSync(join(contentDirectory, "content.v1.json"), "utf8")
    ) as Record<string, unknown>;
    parsed.contentFingerprint = "f".repeat(64);
    expect(() => loadPhysicalBlindContentArtifact(JSON.stringify(parsed)))
      .toThrowError(expect.objectContaining({
        code: "BLIND_ARTIFACT_HASH_MISMATCH"
      }));

    symlinkSync(sourceFile, join(sourceDirectory, "linked.json"));
    expect(() => preparePhysicalBlindArtifactsFromPrivateFile({
      sourceDirectory,
      sourceFileName: "linked.json",
      outputDirectory: join(privateRoot, "linked-output"),
      goldSchema: genericGoldSchema,
      directoryOptions
    })).toThrowError(expect.objectContaining({
      code: "BLIND_ARTIFACT_SYMBOLIC_LINK"
    }));
  });

  it("exclusive publish 在 link 后崩溃会由 exact resume 收养唯一同 inode orphan", () => {
    const directory = preparePrivateDirectory(outputDirectory, directoryOptions);
    const target = join(outputDirectory, "recover.private.json");
    expect(() => writePrivateArtifactExclusive(
      directory,
      "recover.private.json",
      "{\"ok\":true}\n",
      { afterTargetLink: () => { throw new Error("SIMULATED_PROCESS_CRASH"); } }
    )).toThrow();
    expect(lstatSync(target).nlink).toBe(2);
    expect(readdirSync(outputDirectory).filter((name) => name.startsWith(".blind-")))
      .toHaveLength(1);
    expect(ensurePrivateArtifactExact(
      directory,
      "recover.private.json",
      "{\"ok\":true}\n"
    ).toString("utf8")).toBe("{\"ok\":true}\n");
    expect(lstatSync(target).nlink).toBe(1);
    expect(readdirSync(outputDirectory).filter((name) => name.startsWith(".blind-")))
      .toHaveLength(0);
    closePrivateDirectory(directory);
  });

  it("orphan 恢复遇到非内部名称或多余链接时失败关闭且不误删", () => {
    const directory = preparePrivateDirectory(outputDirectory, directoryOptions);
    const target = join(outputDirectory, "protected.private.json");
    writePrivateArtifactExclusive(
      directory,
      "protected.private.json",
      "{\"ok\":true}\n"
    );
    const unrelated = join(outputDirectory, "must-remain.alias");
    linkSync(target, unrelated);
    expect(() => ensurePrivateArtifactExact(
      directory,
      "protected.private.json",
      "{\"ok\":true}\n"
    )).toThrow("BLIND_ARTIFACT_FILE_LINK_INVALID");
    expect(existsSync(target)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("{\"ok\":true}\n");
    closePrivateDirectory(directory);
  });

  it("callback/checkpoint/prediction 均不含 gold，且明确标为无可信执行证据", async () => {
    const prepared = projectLegacyCombinedBlindDocument({
      document: combinedDocument(),
      goldSchema: genericGoldSchema
    });
    const callbackDocuments: string[] = [];
    const checkpoints: string[] = [];
    const artifact = await runPhysicalBlindInference({
      contentDocument: prepared.contentDocument,
      runId: "synthetic-untrusted-run",
      concurrency: 2,
      predictionSchema: simplePredictionSchema,
      infer: async (sample) => {
        callbackDocuments.push(JSON.stringify(sample));
        return { rating: 1800 };
      },
      onCheckpoint: (checkpoint) => {
        checkpoints.push(JSON.stringify(checkpoint));
      }
    });
    expect(artifact.completeness.complete).toBe(true);
    expect(artifact.executionEvidence).toEqual({
      schemaVersion: 1,
      evidenceKind: "unverified-callback",
      trustedCheckpointBound: false,
      eofVerified: false,
      productionEligible: false,
      reasonCode: "BLIND_TRUSTED_EXECUTION_ADAPTER_REQUIRED"
    });
    for (const document of [...callbackDocuments, ...checkpoints, JSON.stringify(artifact)]) {
      expect(document).not.toContain(sentinel);
      expect(document).not.toContain("officialRating");
    }
  });

  it("499、取消和缺失固定 incomplete；人工 outcomes 永远不能封印", async () => {
    const prepared = projectLegacyCombinedBlindDocument({
      document: combinedDocument(),
      goldSchema: genericGoldSchema
    });
    const status499 = await runPhysicalBlindInference({
      contentDocument: prepared.contentDocument,
      runId: "synthetic-499",
      concurrency: 1,
      predictionSchema: simplePredictionSchema,
      infer: async () => { throw { status: 499 }; }
    });
    expect(status499.completeness).toEqual({
      expected: 2,
      succeeded: 0,
      failed: 1,
      missing: 1,
      complete: false
    });
    expect(status499.failures[0]).toEqual(expect.objectContaining({
      code: "HTTP_499",
      httpStatus: 499
    }));
    const cancelled = await runPhysicalBlindInference({
      contentDocument: prepared.contentDocument,
      runId: "synthetic-cancelled",
      concurrency: 1,
      predictionSchema: simplePredictionSchema,
      infer: async () => { throw new DOMException("synthetic", "AbortError"); }
    });
    expect(cancelled.completeness.complete).toBe(false);
    expect(cancelled.failures[0]?.code).toBe("REQUEST_CANCELLED");
    expect(() => sealPhysicalBlindOutcomeDocument({
      contentDocument: prepared.contentDocument,
      outcomesDocument: JSON.stringify({ complete: true }),
      predictionSchema: simplePredictionSchema
    })).toThrowError(expect.objectContaining({
      code: "BLIND_TRUSTED_EXECUTION_ADAPTER_REQUIRED"
    }));
  });

  it("来源账本未迁移时在读取 gold 前固定拒绝评分", () => {
    const profile = physicalBlindProfile("difficulty");
    const prepared = projectLegacyCombinedBlindDocument({
      document: combinedDocument({
        samples: [{
          legacySafeId: "semantic-3500",
          problem: problem("difficulty"),
          gold: { officialRating: 1800 }
        }]
      }),
      goldSchema: profile.goldSchema
    });
    const predictions = buildPhysicalBlindPredictionArtifact({
      content: prepared.content,
      runId: "untrusted-complete",
      predictions: prepared.content.samples.map((sample) => ({
        safeId: sample.safeId,
        contentHash: sample.problem.contentHash,
        prediction: { rating: 1800, confidence: 1 }
      })),
      failures: [],
      predictionSchema: profile.predictionSchema
    });
    const predictionDocument = serializePhysicalBlindPredictionArtifact({
      artifact: predictions,
      content: prepared.content,
      predictionSchema: profile.predictionSchema
    });
    expect(() => assertPhysicalBlindPredictionScorable({
      contentDocument: prepared.contentDocument,
      predictionDocument,
      profileName: "difficulty"
    })).toThrowError(expect.objectContaining({
      code: "BLIND_HOLDOUT_LEDGER_MIGRATION_REQUIRED"
    }));
    expect(() => scorePhysicalBlindArtifacts({
      contentDocument: prepared.contentDocument,
      goldDocument: "not-json-and-must-not-be-parsed",
      predictionDocument,
      profileName: "difficulty"
    })).toThrowError(expect.objectContaining({
      code: "BLIND_HOLDOUT_LEDGER_MIGRATION_REQUIRED"
    }));
  });

  it("登记 profile 精确执行 README 阈值，verdict treatment 未绑定时关闭", () => {
    const difficulty = physicalBlindProfile("difficulty");
    const difficultyRows = Array.from({ length: 83 }, () => ({
      prediction: { rating: 1800, confidence: 1 },
      gold: { officialRating: 1800 }
    }));
    expect(difficulty.assess(difficultyRows)).toEqual(expect.objectContaining({
      sampleCount: 83,
      minimumSampleSizeMet: true,
      accuracyPassed: true,
      metrics: expect.objectContaining({
        meanAbsoluteError: 0,
        hitRateWithin200: 1
      })
    }));
    expect(difficulty.assess(difficultyRows.slice(0, 82)).accuracyPassed).toBe(false);

    const levels = physicalBlindProfile("levels");
    const levelRows = Array.from({ length: 60 }, () => ({
      prediction: { thinkingLevel: 3, codingLevel: 4 },
      gold: { humanThinkingLevel: 3, humanCodingLevel: 4 }
    }));
    expect(levels.assess(levelRows)).toEqual(expect.objectContaining({
      sampleCount: 60,
      minimumSampleSizeMet: true,
      accuracyPassed: true,
      metrics: expect.objectContaining({
        thinkingExactRate: 1,
        thinkingWithinOneRate: 1,
        thinkingMeanAbsoluteError: 0,
        codingExactRate: 1,
        codingWithinOneRate: 1,
        codingMeanAbsoluteError: 0
      })
    }));
    expect(levels.assess(levelRows.slice(0, 59)).accuracyPassed).toBe(false);
    const verdict = physicalBlindProfile("verdict");
    expect(verdict.scoringAvailable).toBe(false);
    expect(() => verdict.assess([])).toThrowError(expect.objectContaining({
      code: "BLIND_PROFILE_TREATMENT_UNBOUND"
    }));
  });

  it("真实隔离子进程清空项目凭据/代理，并由网络 namespace 阻断 canary", async () => {
    vi.stubEnv("AETHER_API_KEY", "synthetic-secret");
    vi.stubEnv("URMOTIV_ROBOT_TOKEN", "synthetic-token");
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:65530");
    vi.stubEnv("PHYSICAL_BLIND_SANDBOX_PARENT_SENTINEL", "must-not-be-visible");
    await expect(verifyPhysicalBlindScoreSandbox()).resolves.toEqual({
      schemaVersion: 1,
      sandboxVerified: true,
      environmentKeyCount: 2,
      networkCanaryBlocked: true,
      parentEnvironmentInvisible: true,
      projectPrivateRootInvisible: true
    });
  }, 30_000);

  it("正式 score 资格阶段物理上不打开或挂载 gold，并拒绝 untrusted prediction", async () => {
    const profile = physicalBlindProfile("difficulty");
    const legacyPath = join(sourceDirectory, "difficulty.json");
    writeFileSync(legacyPath, combinedDocument({
      samples: [{
        legacySafeId: "semantic",
        problem: problem("sandbox"),
        gold: { officialRating: 1800 }
      }]
    }), { mode: 0o600 });
    const published = preparePhysicalBlindArtifactsFromPrivateFile({
      sourceDirectory,
      sourceFileName: "difficulty.json",
      outputDirectory,
      goldSchema: profile.goldSchema,
      directoryOptions
    });
    const contentDirectoryPath = join(outputDirectory, published.contentDirectoryName);
    const contentDocument = readFileSync(
      join(contentDirectoryPath, "content.v1.json"),
      "utf8"
    );
    const contentArtifact = loadPhysicalBlindContentArtifact(contentDocument);
    const predictionArtifact = buildPhysicalBlindPredictionArtifact({
      content: contentArtifact,
      runId: "sandbox-untrusted",
      predictions: contentArtifact.samples.map((sample) => ({
        safeId: sample.safeId,
        contentHash: sample.problem.contentHash,
        prediction: { rating: 1800, confidence: 1 }
      })),
      failures: [],
      predictionSchema: profile.predictionSchema
    });
    const predictionsDirectoryPath = join(privateRoot, "predictions");
    mkdirSync(predictionsDirectoryPath, { mode: 0o700 });
    writeFileSync(
      join(predictionsDirectoryPath, "predictions.v1.json"),
      serializePhysicalBlindPredictionArtifact({
        artifact: predictionArtifact,
        content: contentArtifact,
        predictionSchema: profile.predictionSchema
      }),
      { mode: 0o600 }
    );
    const contentDirectory = preparePrivateDirectory(
      contentDirectoryPath,
      directoryOptions
    );
    const predictionsDirectory = preparePrivateDirectory(
      predictionsDirectoryPath,
      directoryOptions
    );
    const content = openPrivateArtifactSnapshotDescriptor(
      contentDirectory,
      "content.v1.json"
    );
    const predictions = openPrivateArtifactSnapshotDescriptor(
      predictionsDirectory,
      "predictions.v1.json"
    );
    try {
      await expect(runPhysicalBlindScoreSandbox({
        content,
        predictions,
        profileName: "difficulty"
      })).rejects.toMatchObject({
        code: "BLIND_HOLDOUT_LEDGER_MIGRATION_REQUIRED"
      });
    } finally {
      for (const snapshot of [predictions, content]) {
        verifyAndClosePrivateArtifactSnapshotDescriptor(snapshot);
      }
      for (const handle of [predictionsDirectory, contentDirectory]) {
        closePrivateDirectory(handle);
      }
    }
  }, 30_000);

  it("v1 unqualified artifact 绑定 content/prediction/profile/code 且没有成功分支", () => {
    const profile = physicalBlindProfile("difficulty");
    const prepared = projectLegacyCombinedBlindDocument({
      document: combinedDocument({
        samples: [{
          legacySafeId: "semantic",
          problem: problem("score-binding"),
          gold: { officialRating: 1800 }
        }]
      }),
      goldSchema: profile.goldSchema
    });
    const prediction = buildPhysicalBlindPredictionArtifact({
      content: prepared.content,
      runId: "score-binding-run",
      predictions: prepared.content.samples.map((sample) => ({
        safeId: sample.safeId,
        contentHash: sample.problem.contentHash,
        prediction: { rating: 1800, confidence: 1 }
      })),
      failures: [],
      predictionSchema: profile.predictionSchema
    });
    const predictionDocument = serializePhysicalBlindPredictionArtifact({
      artifact: prediction,
      content: prepared.content,
      predictionSchema: profile.predictionSchema
    });
    const scoreCore = {
      schemaVersion: 1 as const,
      artifactKind: "blind-score-unqualified" as const,
      profile: "difficulty" as const,
      profileImplementationVersion: physicalBlindProfileImplementationVersion,
      profileSpecificationFingerprint: profile.specificationFingerprint,
      scoreCodeIdentity: physicalBlindScoreCodeIdentity(),
      binding: {
        datasetId: prepared.content.datasetId,
        purpose: prepared.content.purpose,
        contentIdentityFingerprint: prepared.content.contentIdentityFingerprint,
        contentFingerprint: prepared.content.contentFingerprint,
        predictionFingerprint: prediction.predictionFingerprint,
        runId: prediction.runId,
        contentDocumentSha256: sha256(prepared.contentDocument),
        predictionDocumentSha256: sha256(predictionDocument)
      },
      operationalComplete: false as const,
      integrityClean: false as const,
      assessment: null,
      accuracyPassed: false as const,
      sandboxVerified: false as const,
      eligible: false as const,
      eligibilityReasonCodes: [
        "BLIND_HOLDOUT_LEDGER_MIGRATION_REQUIRED" as const,
        "BLIND_TRUSTED_EXECUTION_ADAPTER_REQUIRED" as const,
        "BLIND_SCORE_SANDBOX_REQUIRED" as const
      ]
    };
    const scoreDocument = serializePhysicalBlindArtifact({
      ...scoreCore,
      scoreFingerprint: hashPhysicalBlindValue(scoreCore)
    });
    expect(loadPhysicalBlindScoreArtifact(scoreDocument).binding).toEqual(
      scoreCore.binding
    );
    const forgedEligibleCore = {
      ...scoreCore,
      sandboxVerified: true,
      eligible: true,
      eligibilityReasonCodes: []
    };
    expect(() => loadPhysicalBlindScoreArtifact(serializePhysicalBlindArtifact({
      ...forgedEligibleCore,
      scoreFingerprint: hashPhysicalBlindValue(forgedEligibleCore)
    }))).toThrowError(expect.objectContaining({
      code: "BLIND_ARTIFACT_DOCUMENT_INVALID"
    }));
    const tamperedCore = {
      ...scoreCore,
      binding: {
        ...scoreCore.binding,
        contentDocumentSha256: "f".repeat(64)
      }
    };
    const tamperedDocument = serializePhysicalBlindArtifact({
      ...tamperedCore,
      scoreFingerprint: hashPhysicalBlindValue(tamperedCore)
    });
    expect(() => verifyPhysicalBlindScoreArtifact({
      scoreDocument: tamperedDocument,
      contentDocumentBytes: Buffer.from(prepared.contentDocument, "utf8"),
      predictionDocumentBytes: Buffer.from(predictionDocument, "utf8")
    })).toThrowError(expect.objectContaining({
      code: "BLIND_SCORE_BINDING_MISMATCH"
    }));
    expect(() => verifyPhysicalBlindScoreArtifact({
      scoreDocument,
      contentDocumentBytes: Buffer.from(prepared.contentDocument, "utf8"),
      predictionDocumentBytes: Buffer.from(predictionDocument, "utf8")
    })).toThrowError(expect.objectContaining({
      code: "BLIND_HOLDOUT_LEDGER_MIGRATION_REQUIRED"
    }));
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
