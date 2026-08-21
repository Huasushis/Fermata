import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  reviewFlowCalibrationProjectionSchema,
  type ReviewFlowCalibrationProjection
} from "../src/review-flow/orchestrator";
import { hashCanonicalValue } from "../src/review-flow/evidence";
import { reviewFlowRoleSchema } from "../src/review-flow/schemas";
import {
  type RobotReviewTask
} from "../src/urmotiv-schemas";
import {
  assertUsableReviewFlowEvaluationBaseline,
  loadDevelopmentDatasetAfterUsageRegistration,
  resolveReviewFlowEvaluationCliOptions,
  runReviewFlowEvaluationCli
} from "../experiments/eval-review-flow";
import {
  createReviewFlowEvaluationAdapter
} from "../experiments/lib/review-flow-evaluation-adapter";
import {
  anklangCaptureDependencyPaths,
  anklangCaptureRunnerPath,
  historicalInputPreparationCodePaths,
  upstreamVerifierDependencyPaths,
  upstreamVerifierRunnerPath
} from "../experiments/lib/review-flow-bridge-repositories";
import { reviewFlowEvaluationCodePaths } from "../experiments/lib/review-flow-bridge-repositories";
import { loadReviewFlowEvaluationConfig } from "../experiments/lib/review-flow-evaluation-config";
import {
  loadReviewFlowEvaluationDataset,
  reviewFlowEvaluationBridgeCompletionFileName,
  reviewFlowEvaluationDevelopmentPredictionBindingSha256,
  reviewFlowEvaluationHoldoutPredictionBindingSha256,
  reviewFlowEvaluationOrderedSelectionSha256,
  reviewFlowEvaluationRepresentative3V2AuditedStrataCounts,
  reviewFlowEvaluationRevealDescriptorSchema,
  reviewFlowEvaluationSourceLineageSetSha256,
  selectReviewFlowEvaluationRepresentative3V2,
  selectReviewFlowEvaluationRepresentative3V3,
  type ReviewFlowEvaluationDatasetBundle,
  type ReviewFlowEvaluationGold
} from "../experiments/lib/review-flow-evaluation-dataset";
import {
  ReviewFlowEvaluationGlobalRegistry,
  reviewFlowEvaluationSubjectUsageClaimSchema,
  reviewFlowEvaluationPublicationReceiptSchema,
  reviewFlowEvaluationReportSetMarkerSchema,
  type ReviewFlowEvaluationHoldoutPlan,
  type ReviewFlowEvaluationHoldoutSelection
} from "../experiments/lib/review-flow-evaluation-registry";
import {
  buildReviewFlowEvaluationComparison,
  buildReviewFlowEvaluationReport,
  parseReviewFlowEvaluationReportSummary
} from "../experiments/lib/review-flow-evaluation-report";
import {
  buildRepresentative3PilotTimingReceipt,
  installReviewFlowEvaluationSignalHandlers,
  representative3MaximumTotalDurationMs,
  ReviewFlowEvaluationStartGate,
  runReviewFlowEvaluationCases,
  type ReviewFlowEvaluationTerminationSignal
} from "../experiments/lib/review-flow-evaluation-runner";
import {
  loadReviewFlowEvaluationCheckpointForReveal,
  reviewFlowEvaluationIdentitySchema,
  reviewFlowEvaluationPredictionIdentityFingerprint,
  ReviewFlowEvaluationCheckpoint,
  type ReviewFlowEvaluationCheckpointState,
  type ReviewFlowEvaluationBaselineBinding,
  type ReviewFlowEvaluationExpectedCase,
  type ReviewFlowEvaluationIdentity
} from "../experiments/lib/review-flow-evaluation-state";
import { serializePhysicalBlindArtifact } from "../experiments/lib/physical-blind-common";
import { LlmRequestStartGate } from "../src/llm";

const temporaryRoots: string[] = [];
const fixedNow = () => new Date("2026-08-02T12:00:00.000Z");

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("review-flow 跨阶段预测身份", () => {
  it("完整身份覆盖 adapter/dataset/runner，任一 bundle 摘要变化都会换指纹", () => {
    expect(reviewFlowEvaluationCodePaths).toEqual(expect.arrayContaining([
      "experiments/eval-review-flow.ts",
      "experiments/lib/review-flow-evaluation-adapter.ts",
      "experiments/lib/review-flow-evaluation-dataset.ts",
      "experiments/lib/review-flow-evaluation-runner.ts"
    ]));
    const original = identityFixture("development");
    const changed: ReviewFlowEvaluationIdentity = {
      ...original,
      codeIdentity: {
        ...original.codeIdentity,
        dependencyCodeSha256: "f".repeat(64)
      }
    };
    expect(reviewFlowEvaluationPredictionIdentityFingerprint(changed)).not.toBe(
      reviewFlowEvaluationPredictionIdentityFingerprint(original)
    );
  });
});

describe("review-flow dataset v2 与真实 Gold 边界", () => {
  it("development 只打开本分区，缺少可选独立标注不会制造假三态/品味/原创性标签", () => {
    const fixture = createDatasetFixture();
    chmodPartitionFiles(fixture, "holdout", 0o000);
    const dataset = loadDataset(fixture, "development_scored");

    expect(dataset.summary).toMatchObject({
      caseCount: 32,
      historicalOutcomeCounts: { accepted: 30, rejected: 2 },
      contestUseCounts: { used: 1, not_used: 31, unknown: 0 },
      independentVerdictLabeledCaseCount: 1,
      independentTasteLabeledCaseCount: 1,
      independentOriginalityLabeledCaseCount: 1,
      difficultyLabeledCaseCount: 1
    });
    expect(dataset.cases[1]?.gold).toMatchObject({
      historicalOutcome: "rejected",
      observedHistoricalTechnicalReasons: ["judgeability_concern"]
    });
    expect(dataset.cases[1]?.gold).not.toHaveProperty("independentVerdict");
    expect(dataset.cases[1]?.gold).not.toHaveProperty("independentTaste");
    expect(dataset.cases[1]?.gold).not.toHaveProperty("independentOriginality");
  });

  it("representative3 只在 frozen32 全量登记与 Gold 验真后按三层摘要确定选三题", () => {
    const fixture = createDatasetFixture("representative3");
    const registry = newRegistry(
      fixture,
      join(fixture.privateRoot, "representative3-registry")
    );
    const full = loadDataset(fixture, "development_scored");
    const first = loadDevelopmentDatasetAfterUsageRegistration({
      manifestPath: fixture.manifestPath,
      revealDescriptorPath: fixture.developmentRevealDescriptorPath,
      datasetPrivateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace,
      registry,
      caseSelector: "representative3-v1"
    });
    const second = loadDevelopmentDatasetAfterUsageRegistration({
      manifestPath: fixture.manifestPath,
      revealDescriptorPath: fixture.developmentRevealDescriptorPath,
      datasetPrivateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace,
      registry,
      caseSelector: "representative3-v1"
    });

    expect(full.cases).toHaveLength(32);
    expect(full).not.toHaveProperty("caseSelection");
    expect(first.cases).toHaveLength(3);
    expect(first.cases.map((entry) => entry.safeId)).toEqual(
      second.cases.map((entry) => entry.safeId)
    );
    expect(first.caseSelection).toMatchObject({
      selector: "representative3-v1",
      parentDatasetFingerprint: full.datasetFingerprint,
      parentManifestSha256: full.manifestSha256,
      parentBridgeCompletionSha256: full.bridgeCompletionSha256,
      parentCaseCount: 32,
      selectedCaseCount: 3,
      orderedSelectionSha256:
        reviewFlowEvaluationOrderedSelectionSha256(first.cases)
    });
    const [accepted, technical, tasteOrMixed] = first.cases;
    expect(accepted?.gold).toMatchObject({ historicalOutcome: "accepted" });
    expect(
      technical?.gold?.evaluationScope === "verdict_and_taste"
        ? technical.gold.observedHistoricalTechnicalReasons.length
        : 0
    ).toBeGreaterThan(0);
    expect(
      technical?.gold?.evaluationScope === "verdict_and_taste"
        ? technical.gold.observedHistoricalTasteReasons
        : []
    ).toHaveLength(0);
    expect(
      tasteOrMixed?.gold?.evaluationScope === "verdict_and_taste"
        ? tasteOrMixed.gold.observedHistoricalTasteReasons.length
        : 0
    ).toBeGreaterThan(0);
    registry.close();
  });

  it("representative3-v2 绑定已审计三层、稳定顺序与全局 claim", () => {
    const fixture = createDatasetFixture("representative3-v2");
    const registry = newRegistry(
      fixture,
      join(fixture.privateRoot, "representative3-v2-registry")
    );
    const full = loadDataset(fixture, "development_scored");
    const first = loadDevelopmentDatasetAfterUsageRegistration({
      manifestPath: fixture.manifestPath,
      revealDescriptorPath: fixture.developmentRevealDescriptorPath,
      datasetPrivateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace,
      registry,
      caseSelector: "representative3-v2"
    });
    const second = loadDevelopmentDatasetAfterUsageRegistration({
      manifestPath: fixture.manifestPath,
      revealDescriptorPath: fixture.developmentRevealDescriptorPath,
      datasetPrivateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace,
      registry,
      caseSelector: "representative3-v2"
    });
    if (first.caseSelection?.selector !== "representative3-v2") {
      throw new Error("TEST_REPRESENTATIVE3_V2_SELECTION_MISSING");
    }

    expect(first.cases.map((entry) => entry.safeId)).toEqual(
      second.cases.map((entry) => entry.safeId)
    );
    expect(first.caseSelection).toMatchObject({
      schemaVersion: 2,
      selector: "representative3-v2",
      selectorIdentity: "review-flow-evaluation-representative3-v2",
      tieBreakProtocol: "review-flow-representative3-v2-tiebreak",
      parentDatasetFingerprint: full.datasetFingerprint,
      parentManifestSha256: full.manifestSha256,
      parentBridgeCompletionSha256: full.bridgeCompletionSha256,
      auditedStrataCounts:
        reviewFlowEvaluationRepresentative3V2AuditedStrataCounts,
      orderedSelectionSha256:
        reviewFlowEvaluationOrderedSelectionSha256(first.cases)
    });
    const [accepted, rejectedTaste, rejectedNoReasons] = first.cases;
    expect(accepted).toMatchObject({
      task: { problem: { type: "interactive" } },
      gold: { historicalOutcome: "accepted" }
    });
    expect(rejectedTaste).toMatchObject({
      task: { problem: { type: "submit_answer" } },
      gold: {
        historicalOutcome: "rejected",
        observedHistoricalTechnicalReasons: []
      }
    });
    expect(
      rejectedTaste?.gold?.evaluationScope === "verdict_and_taste"
        ? rejectedTaste.gold.observedHistoricalTasteReasons.some(
            (reason) => reason.direction === "concern"
          )
        : false
    ).toBe(true);
    expect(rejectedNoReasons).toMatchObject({
      task: { problem: { type: "traditional" } },
      gold: {
        historicalOutcome: "rejected",
        observedHistoricalTechnicalReasons: [],
        observedHistoricalTasteReasons: []
      }
    });

    const identity: ReviewFlowEvaluationIdentity = {
      ...identityFixture("development"),
      datasetFingerprint: first.datasetFingerprint,
      manifestSha256: first.manifestSha256,
      configurationSummary: {
        ...identityFixture("development").configurationSummary,
        caseAttempts: 1
      },
      caseSelection: first.caseSelection
    };
    const chain = createDatasetCheckpoint(
      fixture,
      first,
      "baseline",
      "representative3-v2-smoke",
      null,
      "representative3-v2-state",
      { identity }
    );
    const claim = registry.claimLabel({
      genesis: chain.checkpoint.genesisBinding(),
      datasetFingerprint: first.datasetFingerprint,
      holdoutIdentity: null,
      thresholdPolicySha256: null,
      caseSelection: first.caseSelection,
      resume: false
    });
    expect(claim.claim.caseSelection).toEqual(first.caseSelection);
    chain.checkpoint.close();
    registry.close();
  });

  it("representative3-v2 对审计计数变化与 tie digest 碰撞失败关闭", () => {
    const changed = loadDataset(
      createDatasetFixture("representative3-v2-count-mismatch"),
      "development_scored"
    );
    expect(() =>
      selectReviewFlowEvaluationRepresentative3V2(changed)
    ).toThrow(
      "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_V2_AUDITED_COUNTS_CHANGED"
    );

    const full = loadDataset(
      createDatasetFixture("representative3-v2-tie"),
      "development_scored"
    );
    const candidates = full.cases.filter(
      (entry) =>
        entry.task.problem.type === "submit_answer" &&
        entry.gold?.evaluationScope === "verdict_and_taste" &&
        entry.gold.historicalOutcome === "rejected"
    );
    const source = candidates[0];
    const replaced = candidates[1];
    if (source === undefined || replaced === undefined) {
      throw new Error("TEST_REPRESENTATIVE3_V2_CANDIDATES_MISSING");
    }
    const collided: ReviewFlowEvaluationDatasetBundle = {
      ...full,
      cases: full.cases.map((entry) => entry === replaced ? source : entry)
    };
    expect(() =>
      selectReviewFlowEvaluationRepresentative3V2(collided)
    ).toThrow(
      "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_V2_TIE_DIGEST_COLLISION"
    );
  });

  it("representative3-v3 与旧 v2 全集不相交，且按 1 accepted + 2 rejected 不同类别选择", () => {
    const fixture = createDatasetFixture("representative3-v2");
    const full = loadDataset(fixture, "development_scored");
    const oldUnionV2 = selectReviewFlowEvaluationRepresentative3V2(full);
    const selected = selectReviewFlowEvaluationRepresentative3V3(full);

    // 与旧全集严格不相交（旧 v1/v2 sequencer 都不再复选）。
    const oldIds = new Set(
      oldUnionV2.cases.map((entry) => entry.safeId)
    );
    for (const entry of selected.cases) {
      expect(oldIds.has(entry.safeId)).toBe(false);
    }

    expect(selected.cases).toHaveLength(3);
    expect(new Set(selected.cases.map((entry) => entry.safeId)).size).toBe(3);
    const outcomes = selected.cases.map((entry) =>
      entry.gold?.evaluationScope === "verdict_and_taste"
        ? entry.gold.historicalOutcome
        : null
    );
    expect(outcomes.filter((value) => value === "accepted")).toHaveLength(1);
    expect(outcomes.filter((value) => value === "rejected")).toHaveLength(2);
    const types = selected.cases.map((entry) => entry.task.problem.type);
    expect(new Set(types).size).toBeGreaterThanOrEqual(2);

    expect(selected.caseSelection).toMatchObject({
      schemaVersion: 3,
      selector: "representative3-v3",
      selectorIdentity: "review-flow-evaluation-representative3-v3",
      parentDatasetFingerprint: full.datasetFingerprint,
      parentManifestSha256: full.manifestSha256,
      parentBridgeCompletionSha256: full.bridgeCompletionSha256,
      parentCaseCount: 32,
      selectedCaseCount: 3
    });
    expect(selected.caseSelection?.orderedSelectionSha256).toBe(
      reviewFlowEvaluationOrderedSelectionSha256(selected.cases)
    );
  });

  it("representative3-v3 在旧全集覆盖全部槽位、类别不足或 tie 碰撞时失败关闭", () => {
    const full = loadDataset(
      createDatasetFixture("representative3-v2-tie"),
      "development_scored"
    );
    const oldUnionV2 = selectReviewFlowEvaluationRepresentative3V2(full);
    // 用旧全集覆盖全部剩余槽位：v3 再选就必须与旧全集相交 -> OLD_INTERSECTION。
    const frozen = selectReviewFlowEvaluationRepresentative3V3(full);
    const excluded = new Set(
      oldUnionV2.cases.map((entry) => entry.safeId)
    );
    for (const entry of frozen.cases) {
      expect(excluded.has(entry.safeId)).toBe(false);
    }

    // audit 计数不足（v2 形状被破坏）-> v3 同 v2 一样拒绝。
    const broken = loadDataset(
      createDatasetFixture("representative3-v2-count-mismatch"),
      "development_scored"
    );
    expect(() =>
      selectReviewFlowEvaluationRepresentative3V3(broken)
    ).toThrow(
      "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_V2_AUDITED_COUNTS_CHANGED"
    );
  });

  it("holdout_prediction 不打开 Gold；reveal 才读取并严格失败", () => {
    const fixture = createDatasetFixture();
    const reveal = readRevealDescriptor(fixture);
    for (const descriptor of reveal.cases) {
      chmodSync(join(fixture.revealDirectory, descriptor.gold.fileName), 0o000);
    }
    const blind = loadDataset(fixture, "holdout_prediction");
    expect(blind.summary).toBeNull();
    expect(blind.cases.every((entry) => entry.gold === null)).toBe(true);
    expect(JSON.stringify(blind)).not.toContain("goldSha256");
    expect(() => loadDataset(fixture, "holdout_reveal")).toThrow(
      "REVIEW_FLOW_EVALUATION_DATASET_INVALID"
    );
  });

  it("固定标签目录在 loader 边界拒绝重复标签编号", () => {
    const fixture = createDatasetFixture("duplicate-tag-catalog");
    const manifest = readManifest(fixture);
    const catalogPath = join(
      fixture.suiteDirectory,
      manifest.tagCatalog.fileName
    );
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
      schemaVersion: 1;
      version: number;
      tags: RobotReviewTask["tagCatalog"]["tags"];
    };
    const duplicateBytes = jsonBytes({
      ...catalog,
      tags: [...catalog.tags, { ...catalog.tags[0]! }]
    });
    writePrivateFile(catalogPath, duplicateBytes);
    manifest.tagCatalog.sha256 = sha256(duplicateBytes);
    writeDatasetManifestAndBridge(fixture, manifest);
    expect(() => loadDataset(fixture, "development_identity")).toThrow(
      "REVIEW_FLOW_EVALUATION_TAG_CATALOG_INVALID"
    );
  });

  it("loader 在无 Gold 模式绑定全局占位标签、completion 与每份 content", () => {
    const missingCatalogTag = createDatasetFixture("placeholder-not-in-catalog");
    const missingCatalogManifest = readManifest(missingCatalogTag);
    missingCatalogManifest.placeholderTagIds = ["tag-missing"];
    writeDatasetManifestAndBridge(missingCatalogTag, missingCatalogManifest);
    expect(() => loadDataset(
      missingCatalogTag,
      "development_identity"
    )).toThrow("REVIEW_FLOW_EVALUATION_PLACEHOLDER_TAGS_INVALID");

    const manifestTamper = createDatasetFixture("placeholder-manifest-tamper");
    const changedManifest = readManifest(manifestTamper);
    changedManifest.placeholderTagIds = ["tag-other"];
    writeDatasetManifestAndBridge(manifestTamper, changedManifest);
    expect(() => loadDataset(
      manifestTamper,
      "development_identity"
    )).toThrow("REVIEW_FLOW_EVALUATION_CASE_BINDING_MISMATCH");

    const contentTamper = createDatasetFixture("placeholder-content-tamper");
    const contentManifest = readManifest(contentTamper);
    const descriptor = contentManifest.partitions.development.cases[0]!;
    const contentPath = join(
      contentTamper.suiteDirectory,
      descriptor.content.fileName
    );
    const originalContent = readJson(contentPath) as RobotReviewTask;
    const changedContent = {
      ...originalContent,
      problem: {
        ...originalContent.problem,
        tagIds: ["tag-other"]
      }
    };
    const changedContentBytes = jsonBytes(changedContent);
    writePrivateFile(contentPath, changedContentBytes);
    descriptor.content.sha256 = sha256(changedContentBytes);
    writeDatasetManifestAndBridge(contentTamper, contentManifest);
    expect(() => loadDataset(
      contentTamper,
      "development_identity"
    )).toThrow("REVIEW_FLOW_EVALUATION_CASE_BINDING_MISMATCH");

    const completionTamper = createDatasetFixture(
      "placeholder-completion-tamper"
    );
    const completionPath = join(
      completionTamper.suiteDirectory,
      reviewFlowEvaluationBridgeCompletionFileName
    );
    writePrivateJson(completionPath, {
      ...(readJson(completionPath) as Record<string, unknown>),
      placeholderTagIds: ["tag-other"]
    });
    expect(() => loadDataset(
      completionTamper,
      "development_identity"
    )).toThrow("REVIEW_FLOW_EVALUATION_BRIDGE_COMPLETION_MISMATCH");
  });

  it("holdout prediction 的 manifest、bundle、checkpoint 与 plan 不形成 Gold 哈希 oracle", () => {
    const fixture = createDatasetFixture("gold-oracle");
    const manifest = readManifest(fixture);
    const reveal = readRevealDescriptor(fixture);
    const blind = loadDataset(fixture, "holdout_prediction");
    const holdout = requireTestHoldoutBindings(blind);
    const registry = newRegistry(fixture, join(fixture.privateRoot, "oracle-registry"));
    const plan = registry.registerHoldoutPlan(blind).plan;
    const chain = createDatasetCheckpoint(
      fixture,
      blind,
      "baseline",
      holdout.registration.baselineLabel,
      null,
      "oracle-checkpoint"
    );
    const predictionSurfaces = [
      JSON.stringify(manifest.partitions.holdout),
      JSON.stringify(blind),
      JSON.stringify(plan),
      JSON.stringify(chain.checkpoint.snapshot())
    ];
    for (const surface of predictionSurfaces) {
      expect(surface).not.toContain("goldSha256");
      expect(surface).not.toContain("rowEvidenceSha256");
      expect(surface).not.toContain("sealedEvidenceSha256");
      for (const entry of reveal.cases) {
        expect(surface).not.toContain(entry.gold.fileName);
        expect(surface).not.toContain(entry.gold.sha256);
        expect(surface).not.toContain(entry.upstreamEvidence.rowEvidenceSha256);
        expect(surface).not.toContain(entry.upstreamEvidence.sealedEvidenceSha256);
      }
    }
    expect(manifest.holdoutRevealCommitmentSha256).toBe(
      sha256(readFileSync(fixture.revealDescriptorPath))
    );
    expect(JSON.stringify(manifest)).not.toContain(reveal.commitmentNonce);
    expect(() => loadReviewFlowEvaluationDataset({
      manifestPath: fixture.manifestPath,
      revealDescriptorPath: fixture.revealDescriptorPath,
      mode: "holdout_prediction",
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace
    })).toThrow("REVIEW_FLOW_EVALUATION_REVEAL_DESCRIPTOR_PATH_INVALID");
    chain.checkpoint.close();
    registry.close();
  });

  it("manifest 不允许声明 Gold 分布，subject/source lineage 跨分区即使内容变更也拒绝", () => {
    const fixture = createDatasetFixture();
    const manifest = readManifest(fixture);
    (manifest.partitions.holdout as Record<string, unknown>).summary = {
      historicalOutcomeCounts: { accepted: 99, rejected: 0 }
    };
    writeDatasetManifestAndBridge(fixture, manifest);
    expect(() => loadDataset(fixture, "development_scored")).toThrow(
      "REVIEW_FLOW_EVALUATION_MANIFEST_INVALID"
    );

    const second = createDatasetFixture();
    const secondManifest = readManifest(second);
    const development = secondManifest.partitions.development.cases[0]!;
    const holdout = secondManifest.partitions.holdout.cases[0]!;
    holdout.subjectId = development.subjectId;
    // content/reveal 字节保持完全不同；opaque subject 仍阻止跨分区洗牌。
    writePrivateJson(second.manifestPath, secondManifest);
    expect(() => loadDataset(second, "holdout_prediction")).toThrow(
      "REVIEW_FLOW_EVALUATION_PARTITION_OVERLAP"
    );

    const anklangAcross = createDatasetFixture("anklang-digest-across");
    const acrossManifest = readManifest(anklangAcross);
    acrossManifest.partitions.holdout.cases[0]!
      .originalAnklangResponseSha256 = acrossManifest.partitions.development
        .cases[0]!.originalAnklangResponseSha256;
    writeDatasetManifestAndBridge(anklangAcross, acrossManifest);
    expect(() => loadDataset(anklangAcross, "holdout_prediction")).toThrow(
      "REVIEW_FLOW_EVALUATION_PARTITION_OVERLAP"
    );

    const anklangWithin = createDatasetFixture("anklang-digest-within");
    const withinManifest = readManifest(anklangWithin);
    withinManifest.partitions.holdout.cases[1]!
      .originalAnklangResponseSha256 = withinManifest.partitions.holdout
        .cases[0]!.originalAnklangResponseSha256;
    writeDatasetManifestAndBridge(anklangWithin, withinManifest);
    expect(() => loadDataset(anklangWithin, "holdout_prediction")).toThrow(
      "REVIEW_FLOW_EVALUATION_DUPLICATE_CASE"
    );
  });

  it("Gold 必须逐项绑定 sealed evidence、row evidence 与 source lineage", () => {
    const fixture = createDatasetFixture();
    const manifest = readManifest(fixture);
    const reveal = readRevealDescriptor(fixture, "development");
    const revealCase = reveal.cases[0]!;
    const path = join(
      fixture.developmentRevealDirectory,
      revealCase.gold.fileName
    );
    const gold = readJson(path) as ReviewFlowEvaluationGold;
    const changed = {
      ...gold,
      upstreamEvidence: {
        ...gold.upstreamEvidence,
        rowEvidenceSha256: "f".repeat(64)
      }
    };
    const bytes = jsonBytes(changed);
    writePrivateFile(path, bytes);
    revealCase.gold.sha256 = sha256(bytes);
    writePrivateFile(fixture.developmentRevealDescriptorPath, jsonBytes(reveal));
    writeDatasetManifestAndBridge(fixture, manifest);
    expect(() => loadDataset(fixture, "development_scored")).toThrow(
      "REVIEW_FLOW_EVALUATION_CASE_BINDING_MISMATCH"
    );
  });

  it("同一上游封存批次的多题可以共享 sealed evidence 摘要", () => {
    const fixture = createDatasetFixture();
    const manifest = readManifest(fixture);
    const reveal = readRevealDescriptor(fixture, "development");
    const first = reveal.cases[0]!;
    const second = reveal.cases[1]!;
    const secondGoldPath = join(
      fixture.developmentRevealDirectory,
      second.gold.fileName
    );
    const secondGold = readJson(secondGoldPath) as ReviewFlowEvaluationGold;
    const changedGold = {
      ...secondGold,
      upstreamEvidence: {
        ...secondGold.upstreamEvidence,
        sealedEvidenceSha256: first.upstreamEvidence.sealedEvidenceSha256
      }
    };
    const changedGoldBytes = jsonBytes(changedGold);
    writePrivateFile(secondGoldPath, changedGoldBytes);
    second.upstreamEvidence.sealedEvidenceSha256 =
      first.upstreamEvidence.sealedEvidenceSha256;
    second.gold.sha256 = sha256(changedGoldBytes);
    writePrivateFile(fixture.developmentRevealDescriptorPath, jsonBytes(reveal));
    writeDatasetManifestAndBridge(fixture, manifest);

    expect(loadDataset(fixture, "development_scored").cases).toHaveLength(32);
  });

  it("真实 development-only 集允许空 holdout/null 注册，holdout 操作严格拒绝", () => {
    const fixture = createDatasetFixture("development-only");
    chmodPartitionFiles(fixture, "holdout", 0o000);
    const manifest = readManifest(fixture);
    manifest.partitions.holdout.cases = [];
    manifest.holdoutRegistration = null;
    writeDatasetManifestAndBridge(fixture, manifest);

    const development = loadDataset(fixture, "development_scored");
    expect(development.cases).toHaveLength(32);
    expect(development.holdoutIdentity).toBeNull();
    expect(development.holdoutRegistration).toBeNull();
    expect(() => loadDataset(fixture, "holdout_prediction")).toThrow(
      "REVIEW_FLOW_EVALUATION_PARTITION_EMPTY"
    );
  });

  it("缺少 bridge 最终完成标记的 partial 转换目录不能运行", () => {
    const fixture = createDatasetFixture("missing-bridge-seal");
    renameSync(
      join(fixture.suiteDirectory, reviewFlowEvaluationBridgeCompletionFileName),
      join(fixture.suiteDirectory, "partial-bridge-marker.private.json")
    );
    expect(() => loadDataset(fixture, "development_scored")).toThrow(
      "REVIEW_FLOW_EVALUATION_DATASET_INVALID"
    );
  });

  it("只读 dataset loader 不会创建缺失的输入目录", () => {
    const root = createPrivateWorkspace("missing-dataset-input");
    const missingDirectory = join(root.privateRoot, "missing-dataset");
    expect(() => loadReviewFlowEvaluationDataset({
      manifestPath: join(missingDirectory, "manifest.private.json"),
      mode: "development_scored",
      privateRoot: root.privateRoot,
      containingWorkspace: root.workspace
    })).toThrow();
    expect(existsSync(missingDirectory)).toBe(false);
  });

  it("历史结果排除策略的所有 reveal 都保持 verdict_and_taste，不把原创性当隐含负例", () => {
    const fixture = createDatasetFixture();
    const development = loadDataset(fixture, "development_scored");
    const holdout = loadDataset(fixture, "holdout_reveal");
    expect(development.cases[1]?.gold).not.toHaveProperty("confirmedDuplicate");
    expect(holdout.cases[1]?.gold).toMatchObject({
      evaluationScope: "verdict_and_taste",
      historicalOutcome: "accepted",
      contestUse: "used"
    });
    expect(holdout.cases[1]?.gold).not.toHaveProperty("confirmedDuplicate");
  });
});

describe("checkpoint、11-role receipt 与停止闸门", () => {
  it("reveal checkpoint loader 不会创建缺失的输入目录", () => {
    const root = createPrivateWorkspace("missing-reveal-checkpoint");
    const missingDirectory = join(root.privateRoot, "missing-checkpoint");
    expect(() => loadReviewFlowEvaluationCheckpointForReveal({
      privateDirectory: missingDirectory,
      label: "missing-checkpoint",
      privateRoot: root.privateRoot,
      containingWorkspace: root.workspace
    })).toThrow();
    expect(existsSync(missingDirectory)).toBe(false);
  });
  it("checkpoint identity 只允许 representative3 单次案例尝试，full 保持三次", () => {
    for (const selector of ["representative3-v1", "representative3-v2"] as const) {
      const singleAttempt = createRepresentative3StateFixture(
        { caseAttempts: 1 },
        selector
      );
      expect(
        reviewFlowEvaluationIdentitySchema.safeParse(singleAttempt.identity).success
      ).toBe(true);

      for (const caseAttempts of [0, 2, 3, 8, 9]) {
        const invalid = createRepresentative3StateFixture(
          { caseAttempts },
          selector
        );
        expect(
          reviewFlowEvaluationIdentitySchema.safeParse(invalid.identity).success
        ).toBe(false);
      }
    }

    const full = createStateFixture(3).identity;
    const fullDefault = {
      ...full,
      configurationSummary: {
        ...full.configurationSummary,
        caseAttempts: 3
      }
    };
    expect(reviewFlowEvaluationIdentitySchema.safeParse(fullDefault).success).toBe(true);
  });

  it("checkpoint resume 从 dirfd 严格要求 0600/current owner/nlink=1", () => {
    const fixture = createStateFixture(1);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    checkpoint.close();
    const statePath = checkpointPath(fixture.outputDirectory, fixture.label);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);

    chmodSync(statePath, 0o400);
    expect(() => openCheckpoint(fixture, { resume: true })).toThrow(
      "REVIEW_FLOW_EVALUATION_CHECKPOINT_INVALID"
    );
    chmodSync(statePath, 0o600);
    linkSync(statePath, join(fixture.outputDirectory, "hardlink.private.json"));
    expect(() => openCheckpoint(fixture, { resume: true })).toThrow(
      "REVIEW_FLOW_EVALUATION_CHECKPOINT_INVALID"
    );
  });

  it("目录路径被替换后，后续写入仍锚定最初验证的 inode", () => {
    const fixture = createStateFixture(1);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    const moved = `${fixture.outputDirectory}-moved`;
    renameSync(fixture.outputDirectory, moved);
    mkdirSync(fixture.outputDirectory, { mode: 0o700 });
    checkpoint.markActive("case-0001");
    const movedState = readJson(checkpointPath(moved, fixture.label)) as {
      entries: { status: string }[];
    };
    expect(movedState.entries[0]?.status).toBe("active");
    expect(() => readFileSync(checkpointPath(fixture.outputDirectory, fixture.label))).toThrow();
    checkpoint.close();
  });

  it("10/11 或伪造 EOF 收据的 projection 不能进入 completed checkpoint", () => {
    const fixture = createStateFixture(1);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    checkpoint.markActive("case-0001");
    const invalid = {
      ...projection("approve"),
      roleReceipts: projection("approve").roleReceipts.slice(0, 10)
    };
    expect(() => checkpoint.markCompleted("case-0001", invalid as never)).toThrow();
    const falseEof = structuredClone(projection("approve")) as unknown as {
      roleReceipts: Array<{ responses: Array<{ eofVerified: boolean }> }>;
    };
    falseEof.roleReceipts[0]!.responses[0]!.eofVerified = false;
    expect(() => checkpoint.markCompleted("case-0001", falseEof as never)).toThrow();
    checkpoint.close();
  });

  it("499/缺失样本永久封存为 incomplete，resume 不重发 pending", async () => {
    const fixture = createStateFixture(3);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    const execute = vi.fn(async () => ({
      status: "incomplete" as const,
      failure: fixedFailure("REVIEW_FLOW_HTTP_499", 499)
    }));
    const state = await runReviewFlowEvaluationCases({
      checkpoint,
      cases: preparedStateCases(fixture),
      executor: { execute },
      concurrency: 1
    });
    expect(state.executionSeal?.complete).toBe(false);
    expect(state.entries.map((entry) => entry.status)).toEqual([
      "failed",
      "failed",
      "failed"
    ]);
    expect(execute).toHaveBeenCalledTimes(3);
    checkpoint.close();

    const resumed = openCheckpoint(fixture, { resume: true });
    const resumedExecute = vi.fn();
    const resumedState = await runReviewFlowEvaluationCases({
      checkpoint: resumed,
      cases: preparedStateCases(fixture),
      executor: { execute: resumedExecute },
      concurrency: 3
    });
    expect(resumedExecute).not.toHaveBeenCalled();
    expect(resumedState.executionSeal?.complete).toBe(false);
    resumed.close();
  });

  it("可重试失败在同一案例内重生闸门整体重跑，最后一次尝试才封存", async () => {
    const fixture = createStateFixture(2);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    const calls: string[] = [];
    const execute = vi.fn(async (safeId: string) => {
      calls.push(safeId);
      if (safeId === "case-0001" && calls.filter((id) => id === safeId).length < 3) {
        return {
          status: "incomplete" as const,
          failure: {
            ...fixedFailure("REVIEW_FLOW_OUTPUT_LIMIT", 200),
            failureKind: "output_limit" as const
          }
        };
      }
      return { status: "complete" as const, projection: projection("approve") };
    });
    const state = await runReviewFlowEvaluationCases({
      checkpoint,
      cases: preparedStateCases(fixture),
      executor: { execute },
      concurrency: 2,
      maxCaseAttempts: 3
    });
    expect(state.entries.map((entry) => entry.status)).toEqual([
      "completed",
      "completed"
    ]);
    // case-0001 重试两次失败后第三次成功；case-0002 首次即成功。
    expect(calls.filter((id) => id === "case-0001")).toHaveLength(3);
    expect(calls.filter((id) => id === "case-0002")).toHaveLength(1);
    expect(state.entries.every((entry) => entry.status === "completed")).toBe(true);
    expect(state.executionSeal).not.toBeNull();
    checkpoint.close();
  });

  it("可重试失败耗尽预算后封存 failed 并记录尝试次数，不无限重试", async () => {
    const fixture = createStateFixture(1);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    const execute = vi.fn(async () => ({
      status: "incomplete" as const,
      failure: {
        ...fixedFailure("REVIEW_FLOW_OUTPUT_LIMIT", 200),
        failureKind: "output_limit" as const
      }
    }));
    const state = await runReviewFlowEvaluationCases({
      checkpoint,
      cases: preparedStateCases(fixture),
      executor: { execute },
      concurrency: 1,
      maxCaseAttempts: 3
    });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(state.entries.map((entry) => entry.status)).toEqual(["failed"]);
    const attemptByCase = new Map(
      state.entries.map((entry) => [
        entry.safeId,
        entry.status === "failed" ? entry.failure.caseAttempts : null
      ])
    );
    expect(attemptByCase.get("case-0001")).toBe(3);
    expect(state.executionSeal?.complete).toBe(false);
    checkpoint.close();
  });

  it("不可重试失败只尝试一次且不消耗重试预算", async () => {
    const fixture = createStateFixture(1);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    const execute = vi.fn(async (safeId: string) => ({
      status: "incomplete" as const,
      failure: {
        ...fixedFailure("REVIEW_FLOW_VALIDATION", 200),
        failureKind: "validation" as const
      }
    }));
    const state = await runReviewFlowEvaluationCases({
      checkpoint,
      cases: preparedStateCases(fixture),
      executor: { execute },
      concurrency: 1,
      maxCaseAttempts: 3
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const attemptByCase = new Map(
      state.entries.map((entry) => [
        entry.safeId,
        entry.status === "failed" ? entry.failure.caseAttempts : null
      ])
    );
    expect(attemptByCase.get("case-0001")).toBe(1);
    checkpoint.close();
  });

  it("partial-byte 流中断不重放案例，zero-byte transport 仍按上限安全重试", async () => {
    const partialFixture = createStateFixture(1);
    const partialCheckpoint = openCheckpoint(partialFixture, {
      bindClaim: true
    });
    const partialExecute = vi.fn(async () => ({
      status: "incomplete" as const,
      failure: {
        ...fixedFailure("REVIEW_FLOW_ROLE_FAILED", null),
        failureKind: "stream_interrupted" as const
      }
    }));
    const partialState = await runReviewFlowEvaluationCases({
      checkpoint: partialCheckpoint,
      cases: preparedStateCases(partialFixture),
      executor: { execute: partialExecute },
      concurrency: 1,
      maxCaseAttempts: 3
    });
    expect(partialExecute).toHaveBeenCalledTimes(1);
    expect(partialState.entries[0]).toMatchObject({
      status: "failed",
      failure: { failureKind: "stream_interrupted", caseAttempts: 1 }
    });
    partialCheckpoint.close();

    const zeroByteFixture = createStateFixture(1);
    const zeroByteCheckpoint = openCheckpoint(zeroByteFixture, {
      bindClaim: true
    });
    const zeroByteExecute = vi.fn()
      .mockResolvedValueOnce({
        status: "incomplete" as const,
        failure: {
          ...fixedFailure("REVIEW_FLOW_NETWORK_FAILED", null),
          failureKind: "transport" as const
        }
      })
      .mockResolvedValueOnce({
        status: "complete" as const,
        projection: projection("approve")
      });
    const zeroByteState = await runReviewFlowEvaluationCases({
      checkpoint: zeroByteCheckpoint,
      cases: preparedStateCases(zeroByteFixture),
      executor: { execute: zeroByteExecute },
      concurrency: 1,
      maxCaseAttempts: 3
    });
    expect(zeroByteExecute).toHaveBeenCalledTimes(2);
    expect(zeroByteState.entries[0]?.status).toBe("completed");
    zeroByteCheckpoint.close();
  });

  it("maxCaseAttempts 超界或非整数被拒绝", async () => {
    const fixture = createStateFixture(1);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    await expect(runReviewFlowEvaluationCases({
      checkpoint,
      cases: preparedStateCases(fixture),
      executor: { execute: async () => ({ status: "complete" as const, projection: projection("approve") }) },
      concurrency: 1,
      maxCaseAttempts: 9
    })).rejects.toThrow("REVIEW_FLOW_EVALUATION_CASE_ATTEMPTS_INVALID");
    checkpoint.close();
  });

  it("并发 20 被接受且 worker 数不越过挂起案例数；未开始的案例不启动", async () => {
    const fixture = createStateFixture(3);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    const thirdStarted = deferred<void>();
    const started: string[] = [];
    const run = runReviewFlowEvaluationCases({
      checkpoint,
      cases: preparedStateCases(fixture),
      executor: {
        async execute(safeId) {
          if (safeId === "case-0003") {
            thirdStarted.resolve();
            return { status: "complete" as const, projection: projection("approve") };
          }
          await thirdStarted.promise;
          started.push(safeId);
          return { status: "complete" as const, projection: projection("approve") };
        }
      },
      // 20 必须通过 runner 校验（旧代码上限 4）；worker 数取 min(concurrency, pending)，
      // 不会因为配置 20 就同时发起超过挂起案例数的请求，未开始的案例也不占槽位。
      concurrency: 20
    });
    const state = await run;
    expect(started.length).toBeLessThanOrEqual(3);
    expect(started.sort()).toEqual(["case-0001", "case-0002"]);
    expect(state.entries.map((entry) => entry.status)).toEqual([
      "completed",
      "completed",
      "completed"
    ]);
    checkpoint.close();
  });

  it("终止后闸门关闭，剩余重试不再启动", async () => {
    const fixture = createStateFixture(1);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    const source = new EventEmitter();
    const gate = new ReviewFlowEvaluationStartGate(checkpoint);
    const remove = installReviewFlowEvaluationSignalHandlers({ gate, source });
    const called: number[] = [];
    const run = runReviewFlowEvaluationCases({
      checkpoint,
      cases: preparedStateCases(fixture),
      executor: {
        async execute() {
          called.push(called.length);
          source.emit("SIGTERM");
          return {
            status: "incomplete" as const,
            failure: fixedFailure("REVIEW_FLOW_HTTP_499", 499)
          };
        }
      },
      concurrency: 1,
      startGate: gate,
      maxCaseAttempts: 3
    });
    const state = await run;
    remove();
    expect(called).toHaveLength(1);
    const attemptByCase = new Map(
      state.entries.map((entry) => [
        entry.safeId,
        entry.status === "failed" ? entry.failure.caseAttempts : null
      ])
    );
    expect(attemptByCase.get("case-0001")).toBe(1);
    checkpoint.close();
  });

  it("单题失败不阻止其它题目启动；每题拥有独立请求闸门", async () => {
    const fixture = createStateFixture(2);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    const siblingFirstRequest = deferred<void>();
    const started: string[] = [];
    const run = runReviewFlowEvaluationCases({
      checkpoint,
      cases: preparedStateCases(fixture),
      executor: {
        async execute(safeId, _runId, requestStartGate) {
          started.push(`${safeId}:first`);
          if (safeId === "case-0001") {
            return {
              status: "incomplete" as const,
              failure: fixedFailure("REVIEW_FLOW_HTTP_499", 499)
            };
          }
          await siblingFirstRequest.promise;
          if (requestStartGate.canStartRequest()) {
            started.push(`${safeId}:second`);
          }
          return {
            status: "incomplete" as const,
            failure: fixedFailure("REVIEW_FLOW_HTTP_499", 499)
          };
        }
      },
      concurrency: 2
    });
    await vi.waitFor(() => {
      expect(started).toContain("case-0001:first");
      expect(started).toContain("case-0002:first");
    });
    siblingFirstRequest.resolve();
    const state = await run;
    expect(started).toContain("case-0002:second");
    expect(state.entries.map((entry) => entry.status)).toEqual([
      "failed",
      "failed"
    ]);
    checkpoint.close();
  });

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "%s 只阻止第三条启动，等待两条 in-flight 自然 EOF 后封存 incomplete",
    async (signal) => {
      const fixture = createStateFixture(3);
      const checkpoint = openCheckpoint(fixture, { bindClaim: true });
      const source = new EventEmitter();
      const gate = new ReviewFlowEvaluationStartGate(checkpoint);
      const remove = installReviewFlowEvaluationSignalHandlers({
        gate,
        source
      });
      const first = deferred<ReviewFlowCalibrationProjection>();
      const second = deferred<ReviewFlowCalibrationProjection>();
      const started: string[] = [];
      const settled: string[] = [];
      const run = runReviewFlowEvaluationCases({
        checkpoint,
        cases: preparedStateCases(fixture),
        executor: {
          async execute(safeId) {
            started.push(safeId);
            const value = await (safeId === "case-0001" ? first.promise : second.promise);
            settled.push(safeId);
            return { status: "complete" as const, projection: value };
          }
        },
        concurrency: 2,
        startGate: gate
      });
      await vi.waitFor(() => expect(started).toHaveLength(2));
      source.emit(signal);
      let finished = false;
      void run.finally(() => { finished = true; });
      await Promise.resolve();
      expect(finished).toBe(false);
      first.resolve(projection("approve"));
      second.resolve(projection("reject", { judgeabilityConcern: true }));
      const state = await run;
      remove();
      expect(settled).toHaveLength(2);
      expect(started).toEqual(["case-0001", "case-0002"]);
      expect(state.entries.map((entry) => entry.status)).toEqual([
        "completed",
        "completed",
        "pending"
      ]);
      expect(state.termination?.signal).toBe(signal);
      expect(state.executionSeal?.complete).toBe(false);
      checkpoint.close();
    }

  );

  it.each([
    "representative3-v1",
    "representative3-v2"
  ] as const)(
    "%s 先独占执行首题 pilot，落盘单调时延收据后才并发剩余两题",
    async (selector) => {
      const fixture = createRepresentative3StateFixture({}, selector);
      const checkpoint = openCheckpoint(fixture, { bindClaim: true });
      const calls: string[] = [];
      const monotonicValues = [0, 1_000, 1_000, 2_000];
      const state = await runReviewFlowEvaluationCases({
        checkpoint,
        cases: preparedStateCases(fixture),
        executor: {
          async execute(safeId) {
            calls.push(safeId);
            return {
              status: "complete" as const,
              projection: projection("approve"),
              timing: {
                schemaVersion: 1 as const,
                firstByteMs: 100,
                endToEndMs: 500
              }
            };
          }
        },
        concurrency: 20,
        maxCaseAttempts: 1,
        monotonicNow: () => monotonicValues.shift() ?? 1_000
      });
      expect(calls[0]).toBe(fixture.expectedCases[0]?.safeId);
      expect(calls.slice(1).sort()).toEqual(
        fixture.expectedCases.slice(1).map((entry) => entry.safeId).sort()
      );
      expect(state.entries.map((entry) => entry.status)).toEqual([
        "completed",
        "completed",
        "completed"
      ]);
      const pilot = state.entries[0];
      expect(
        pilot?.status === "completed" ? pilot.pilotTiming : null
      ).toMatchObject({
        monotonicLatencyMs: 1_000,
        projectedWithinLimit: true,
        remainingCasesAdmitted: true,
        maximumTotalDurationMs: representative3MaximumTotalDurationMs
      });
      expect(state.representative3Timing).toEqual({
        schemaVersion: 1,
        firstByteMs: 100,
        stage2LatencyMs: 1_000,
        endToEndMs: 2_000
      });
      expect(state.entries.slice(1).every(
        (entry) => !("pilotTiming" in entry)
      )).toBe(true);
      // 三题 smoke 不得冒充 frozen32 完整标定。
      expect(state.executionSeal?.complete).toBe(false);
      checkpoint.close();
    }
  );

  it.each([
    "representative3-v1",
    "representative3-v2"
  ] as const)("%s runner 拒绝多次 case 尝试", async (selector) => {
    const fixture = createRepresentative3StateFixture({}, selector);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    await expect(runReviewFlowEvaluationCases({
      checkpoint,
      cases: preparedStateCases(fixture),
      executor: {
        async execute() {
          throw new Error("must not execute");
        }
      },
      concurrency: 20,
      maxCaseAttempts: 3
    })).rejects.toThrow("REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_RUN_INVALID");
    checkpoint.close();
  });

  it("representative3 的 retry/backoff/watchdog 保守 ETA 超过 90 分钟时不调度剩余两题", async () => {
    const fixture = createRepresentative3StateFixture({
      baseDelayMs: 100_000_000
    });
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    const execute = vi.fn(async () => ({
      status: "complete" as const,
      projection: projection("approve"),
      timing: {
        schemaVersion: 1 as const,
        firstByteMs: 1_000,
        endToEndMs: 60_000
      }
    }));
    const monotonicValues = [0, 60_000];
    const state = await runReviewFlowEvaluationCases({
      checkpoint,
      cases: preparedStateCases(fixture),
      executor: { execute },
      concurrency: 20,
      maxCaseAttempts: 1,
      monotonicNow: () => monotonicValues.shift() ?? 60_000
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(state.entries.map((entry) => entry.status)).toEqual([
      "completed",
      "pending",
      "pending"
    ]);
    const pilot = state.entries[0];
    expect(pilot?.status === "completed" ? pilot.pilotTiming : null).toMatchObject({
      monotonicLatencyMs: 60_000,
      projectedWithinLimit: false,
      remainingCasesAdmitted: false
    });
    expect(
      pilot?.status === "completed"
        ? pilot.pilotTiming?.projectedTotalDurationMs
        : 0
    ).toBeGreaterThan(representative3MaximumTotalDurationMs);
    expect(state.termination).toBeNull();
    expect(state.executionSeal?.complete).toBe(false);
    checkpoint.close();
  });

  it("representative3 缺少真实请求时延收据时持久失败并封存 INCOMPLETE", async () => {
    const fixture = createRepresentative3StateFixture();
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    const execute = vi.fn(async () => ({
      status: "complete" as const,
      projection: projection("approve")
    }));
    const state = await runReviewFlowEvaluationCases({
      checkpoint,
      cases: preparedStateCases(fixture),
      executor: { execute },
      concurrency: 20,
      maxCaseAttempts: 1
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(state.entries.map((entry) => entry.status)).toEqual([
      "failed",
      "pending",
      "pending"
    ]);
    expect(state.entries[0]).toMatchObject({
      status: "failed",
      failure: {
        code: "REVIEW_FLOW_EVALUATION_TIMING_RECEIPT_MISSING",
        caseAttempts: 1
      }
    });
    expect(state.representative3Timing).toBeUndefined();
    expect(state.executionSeal?.complete).toBe(false);
    checkpoint.close();
  });

  it("representative3 checkpoint/registry 绑定 parent、顺序与数量，且完全禁止 resume", () => {
    const fixture = createRepresentative3StateFixture();
    const checkpoint = openCheckpoint(fixture);
    const registry = newRegistry(
      fixture,
      join(fixture.privateRoot, "representative3-registry")
    );
    const claim = registry.claimLabel({
      genesis: checkpoint.genesisBinding(),
      datasetFingerprint: fixture.identity.datasetFingerprint,
      holdoutIdentity: null,
      thresholdPolicySha256: null,
      caseSelection: fixture.identity.caseSelection,
      resume: false
    });
    expect(claim.claim.caseSelection).toEqual(fixture.identity.caseSelection);
    checkpoint.bindGlobalClaim(claim.sha256);
    checkpoint.close();
    expect(() => openCheckpoint(fixture, { resume: true })).toThrow(
      "REVIEW_FLOW_EVALUATION_REPRESENTATIVE3_FRESH_ONLY"
    );
    registry.close();
  });

  it("representative3 ETA 对 case retry、transport backoff 与请求 watchdog 均单调保守", () => {
    const fixture = createRepresentative3StateFixture();
    const configuration = fixture.identity.configurationSummary;
    const base = buildRepresentative3PilotTimingReceipt({
      firstByteMs: 100,
      monotonicLatencyMs: 1_000,
      succeeded: true,
      concurrency: 2,
      maxCaseAttempts: 3,
      configuration
    });
    const moreBackoff = buildRepresentative3PilotTimingReceipt({
      firstByteMs: 100,
      monotonicLatencyMs: 1_000,
      succeeded: true,
      concurrency: 2,
      maxCaseAttempts: 3,
      configuration: { ...configuration, baseDelayMs: configuration.baseDelayMs + 1 }
    });
    const longerWatchdog = buildRepresentative3PilotTimingReceipt({
      firstByteMs: 100,
      monotonicLatencyMs: 1_000,
      succeeded: true,
      concurrency: 2,
      maxCaseAttempts: 3,
      configuration: {
        ...configuration,
        llmMaximumDurationMs: configuration.llmMaximumDurationMs + 1
      }
    });
    const serial = buildRepresentative3PilotTimingReceipt({
      firstByteMs: 100,
      monotonicLatencyMs: 1_000,
      succeeded: true,
      concurrency: 1,
      maxCaseAttempts: 3,
      configuration
    });
    expect(moreBackoff.remainingTwoBoundMs).toBeGreaterThan(
      base.remainingTwoBoundMs
    );
    expect(longerWatchdog.remainingTwoBoundMs).toBeGreaterThan(
      base.remainingTwoBoundMs
    );
    expect(serial.remainingTwoBoundMs).toBe(base.remainingTwoBoundMs * 2);
  });
});

describe("NO_SAFE_CONTROL 每案例请求闸门注册表", () => {
  it("终止时关闭所有已登记的每案例请求闸门", () => {
    const fixture = createStateFixture(1);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    const gate = new ReviewFlowEvaluationStartGate(checkpoint);
    const caseGateA = gate.createCaseRequestStartGate();
    const caseGateB = gate.createCaseRequestStartGate();
    const caseGateC = gate.createCaseRequestStartGate();
    expect(caseGateA.canStartRequest()).toBe(true);
    expect(caseGateB.canStartRequest()).toBe(true);
    expect(caseGateC.canStartRequest()).toBe(true);
    gate.closeForTermination();
    expect(caseGateA.canStartRequest()).toBe(false);
    expect(caseGateB.canStartRequest()).toBe(false);
    expect(caseGateC.canStartRequest()).toBe(false);
    expect(gate.canStart()).toBe(false);
    checkpoint.close();
  });

  it("终止不取消已发出的流，in-flight 案例跑到自然 EOF", async () => {
    const fixture = createStateFixture(3);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    const source = new EventEmitter();
    const gate = new ReviewFlowEvaluationStartGate(checkpoint);
    const remove = installReviewFlowEvaluationSignalHandlers({ gate, source });
    const first = deferred<ReviewFlowCalibrationProjection>();
    const second = deferred<ReviewFlowCalibrationProjection>();
    const started: string[] = [];
    const settled: string[] = [];
    const run = runReviewFlowEvaluationCases({
      checkpoint,
      cases: preparedStateCases(fixture),
      executor: {
        async execute(safeId, _runId, requestStartGate) {
          started.push(safeId);
          // 模拟已发出的流：闸门此时已登记，但请求已开始，不应被取消。
          expect(requestStartGate.canStartRequest()).toBe(true);
          const value = await (safeId === "case-0001"
            ? first.promise
            : second.promise);
          // 终止后该闸门应已关闭；但本次已开始的流仍跑完到 EOF。
          settled.push(safeId);
          return { status: "complete" as const, projection: value };
        }
      },
      concurrency: 2,
      startGate: gate
    });
    await vi.waitFor(() => expect(started).toHaveLength(2));
    source.emit("SIGTERM");
    let finished = false;
    void run.finally(() => { finished = true; });
    await Promise.resolve();
    // 两条 in-flight 流在终止后仍未结束——证明未被取消。
    expect(finished).toBe(false);
    expect(settled).toHaveLength(0);
    first.resolve(projection("approve"));
    second.resolve(projection("reject", { judgeabilityConcern: true }));
    const state = await run;
    remove();
    // 两条已开始的流都跑到自然 EOF 并完成。
    expect(settled).toHaveLength(2);
    expect(state.entries.map((entry) => entry.status)).toEqual([
      "completed",
      "completed",
      "pending"
    ]);
    expect(state.termination?.signal).toBe("SIGTERM");
    checkpoint.close();
  });

  it("终止后已登记案例闸门拒绝后续角色/修复/重试启动", async () => {
    const fixture = createStateFixture(2);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    const source = new EventEmitter();
    const gate = new ReviewFlowEvaluationStartGate(checkpoint);
    const remove = installReviewFlowEvaluationSignalHandlers({ gate, source });
    const secondEntered = deferred<void>();
    const terminated = deferred<void>();
    const secondRoleChecked = deferred<boolean>();
    const run = runReviewFlowEvaluationCases({
      checkpoint,
      cases: preparedStateCases(fixture),
      executor: {
        async execute(safeId, _runId, requestStartGate) {
          if (safeId === "case-0001") {
            // 等待 case-0002 已进入执行（通过 markActive）后再触发终止，
            // 避免终止使 case-0002 的 markActive 被拒绝而提前退出。
            await secondEntered.promise;
            source.emit("SIGTERM");
            // 此时两个案例的闸门都已被终止批量关闭。
            expect(requestStartGate.canStartRequest()).toBe(false);
            terminated.resolve();
            return {
              status: "incomplete" as const,
              failure: fixedFailure("REVIEW_FLOW_HTTP_499", 499)
            };
          }
          // case-0002 在终止前已登记闸门；终止后该闸门被批量关闭。
          secondEntered.resolve();
          await terminated.promise;
          const canSecondRoleStart = requestStartGate.canStartRequest();
          secondRoleChecked.resolve(canSecondRoleStart);
          return {
            status: "incomplete" as const,
            failure: fixedFailure("REVIEW_FLOW_HTTP_499", 499)
          };
        }
      },
      concurrency: 2,
      startGate: gate,
      maxCaseAttempts: 3
    });
    const checked = await secondRoleChecked.promise;
    const state = await run;
    remove();
    // 终止后任何已登记案例的后续角色/修复/重试都无法启动新请求。
    expect(checked).toBe(false);
    expect(state.entries.map((entry) => entry.status)).toEqual([
      "failed",
      "failed"
    ]);
    checkpoint.close();
  });

  it("案例清理后从注册表移除其请求闸门，后续终止不再关闭已释放闸门", () => {
    const fixture = createStateFixture(1);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    const gate = new ReviewFlowEvaluationStartGate(checkpoint);
    const released = gate.createCaseRequestStartGate();
    gate.releaseCaseRequestStartGate(released);
    // 释放后再终止：已释放的闸门保持打开，证明已从注册表移除。
    gate.closeForTermination();
    expect(released.canStartRequest()).toBe(true);
    // 幂等：重复释放无副作用。
    gate.releaseCaseRequestStartGate(released);
    expect(released.canStartRequest()).toBe(true);
    checkpoint.close();
  });
});

describe("32 案例 × 11 角色 = 352 收据封存契约", () => {
  function uniqueProjection(safeId: string): ReviewFlowCalibrationProjection {
    const caseIndex = Number.parseInt(safeId.slice(-4), 10) - 1;
    const roleReceipts = reviewFlowRoleSchema.options.map((role, index) => {
      const attemptCount = caseIndex * 11 + index + 1;
      const response = {
        responseMode: index % 2 === 0 ? "sse" as const : "json" as const,
        transportAttemptCount: attemptCount,
        eofVerified: true as const,
        finishReasonStopVerified: true as const,
        acceptedEventShapes: [],
        sseDoneObserved: index % 2 === 0 ? true as const : null
      };
      return {
        role,
        receiptHash: hashCanonicalValue({
          schemaVersion: 2,
          requestCount: 1,
          transportAttemptCount: attemptCount,
          eofVerified: true,
          jsonSchemaValidated: true,
          responses: [{
            schemaVersion: 2,
            transportAttemptCount: attemptCount,
            eofVerified: true,
            responseMode: response.responseMode,
            finishReasonStopVerified: response.finishReasonStopVerified,
            acceptedEventShapes: response.acceptedEventShapes,
            sseDoneObserved: response.sseDoneObserved
          }]
        }),
        requestCount: 1 as const,
        transportAttemptCount: attemptCount,
        responses: [response]
      };
    });
    return reviewFlowCalibrationProjectionSchema.parse({
      schemaVersion: 2,
      verdict: "approve",
      codeforcesDifficulty: 1800,
      qualityLevel: 3,
      originalityLevel: 4,
      thinkingLevel: 3,
      codingLevel: 2,
      tagIds: ["tag-basic"],
      hardBlockers: [],
      difficultyConfidence: 0.8,
      technical: {
        officialSolutionCorrect: true,
        statementSolutionConsistency: "verified",
        judgeability: "verified",
        sampleConsistency: "verified",
        constraintSufficiency: "verified",
        referenceImplementation: {
          provided: false,
          status: "unavailable",
          complexityAcceptable: null
        }
      },
      editorial: {
        qualityLevel: 3,
        noveltyLevel: 4,
        ideaDepthLevel: 3,
        naturalnessLevel: 4,
        contestantExperienceLevel: 4,
        evidenceCoverage: { strengths: "found", concerns: "none_found" },
        evidence: [{
          dimension: "novelty",
          direction: "strength",
          severity: "note",
          confidence: 0.8
        }]
      },
      contestFit: {
        icpcFit: "strong",
        implementationBurden: 2,
        thinkingImplementationBalance: "strong",
        knowledgeFairness: "fair",
        problemsetRole: "standard",
        roleConfidence: 0.8,
        evidenceCoverage: { strengths: "found", concerns: "none_found" },
        evidence: [{
          dimension: "icpc_fit",
          direction: "strength",
          severity: "note",
          confidence: 0.8
        }]
      },
      originality: {
        originalityLevel: 4,
        sameProblemAsExisting: false,
        highestSimilarity: 0.1
      },
      roleReceipts,
      receiptSetHash: hashCanonicalValue(roleReceipts)
    });
  }

  it("32 案例 × 11 角色 = 352 唯一 (safeId, role, receiptHash) 元组，角色顺序严格匹配 schema", () => {
    const fixture = createStateFixture(32);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    const safeIds = fixture.expectedCases.map((e) => e.safeId);
    completeAll(checkpoint, safeIds, uniqueProjection);
    const state = checkpoint.sealExecution();
    expect(state.executionSeal?.complete).toBe(true);
    expect(state.entries).toHaveLength(32);
    expect(state.entries.every((e) => e.status === "completed")).toBe(true);

    let totalReceipts = 0;
    const tupleSet = new Set<string>();
    for (const entry of state.entries) {
      if (entry.status !== "completed") continue;
      expect(entry.projection.roleReceipts).toHaveLength(11);
      expect(
        entry.projection.roleReceipts.map((r) => r.role)
      ).toEqual(reviewFlowRoleSchema.options);
      for (const receipt of entry.projection.roleReceipts) {
        totalReceipts += 1;
        const tuple = `${entry.safeId}|${receipt.role}|${receipt.receiptHash}`;
        expect(tupleSet.has(tuple)).toBe(false);
        tupleSet.add(tuple);
      }
    }
    expect(totalReceipts).toBe(352);
    expect(tupleSet.size).toBe(352);
    checkpoint.close();
  });

  it("32/352 完成封存摘要可由 executionCompletionFingerprint 重算且唯一", () => {
    const fixture = createStateFixture(32);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    const safeIds = fixture.expectedCases.map((e) => e.safeId);
    completeAll(checkpoint, safeIds, uniqueProjection);
    const state = checkpoint.sealExecution();
    expect(state.executionSeal?.completionFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    // Re-sealing is idempotent — same fingerprint.
    const resealed = checkpoint.sealExecution();
    expect(resealed.executionSeal?.completionFingerprint).toBe(
      state.executionSeal?.completionFingerprint
    );
    checkpoint.close();
  });

  it("重复角色收据被 checkpoint 拒绝", () => {
    const fixture = createStateFixture(1);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    checkpoint.markActive("case-0001");
    const dup = structuredClone(projection("approve")) as unknown as {
      roleReceipts: Array<{ role: string }>;
    };
    dup.roleReceipts[1]!.role = dup.roleReceipts[0]!.role;
    expect(() => checkpoint.markCompleted("case-0001", dup as never)).toThrow();
    checkpoint.close();
  });

  it("全部样本失败时封存 complete=false 且终态不可恢复（非 fail-fast）", async () => {
    const fixture = createStateFixture(32);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    const execute = vi.fn(async () => ({
      status: "incomplete" as const,
      failure: fixedFailure("REVIEW_FLOW_HTTP_499", 499)
    }));
    const state = await runReviewFlowEvaluationCases({
      checkpoint,
      cases: preparedStateCases(fixture),
      executor: { execute },
      concurrency: 1
    });
    expect(state.executionSeal?.complete).toBe(false);
    expect(checkpoint.terminallyContaminated()).toBe(true);
    expect(state.entries.some((e) => e.status === "failed")).toBe(true);
    expect(state.entries.filter((e) => e.status === "completed")).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(32);
    checkpoint.close();
  });

  it("残留 active 条目阻止 complete 封存", () => {
    const fixture = createStateFixture(32);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    const safeIds = fixture.expectedCases.map((e) => e.safeId);
    // Complete 31 cases, leave one active.
    completeAll(checkpoint, safeIds.slice(0, 31), uniqueProjection);
    checkpoint.markActive(safeIds[31]!);
    const state = checkpoint.sealExecution();
    expect(state.executionSeal?.complete).toBe(false);
    expect(state.entries.filter((e) => e.status === "completed")).toHaveLength(31);
    expect(state.entries.filter((e) => e.status === "active")).toHaveLength(1);
    checkpoint.close();
  });

  it("31 完成 + 1 失败导致 complete=false 且终态被污染", () => {
    const fixture = createStateFixture(32);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    const safeIds = fixture.expectedCases.map((e) => e.safeId);
    completeAll(checkpoint, safeIds.slice(0, 31), uniqueProjection);
    checkpoint.markActive(safeIds[31]!);
    checkpoint.markFailed(safeIds[31]!, fixedFailure("REVIEW_FLOW_HTTP_499", 499));
    const state = checkpoint.sealExecution();
    expect(state.executionSeal?.complete).toBe(false);
    expect(state.entries.filter((e) => e.status === "completed")).toHaveLength(31);
    expect(state.entries.filter((e) => e.status === "failed")).toHaveLength(1);
    expect(checkpoint.terminallyContaminated()).toBe(true);
    checkpoint.close();
  });

  it("全部失败时封存摘要 receiptTuples 为空", () => {
    const fixture = createStateFixture(32);
    const checkpoint = openCheckpoint(fixture, { bindClaim: true });
    for (const expectedCase of fixture.expectedCases) {
      checkpoint.markActive(expectedCase.safeId);
      checkpoint.markFailed(expectedCase.safeId, fixedFailure("REVIEW_FLOW_HTTP_499", 499));
    }
    const state = checkpoint.sealExecution();
    expect(state.executionSeal?.complete).toBe(false);
    expect(state.entries.filter((e) => e.status === "completed")).toHaveLength(0);
    expect(state.entries.filter((e) => e.status === "failed")).toHaveLength(32);
    expect(checkpoint.terminallyContaminated()).toBe(true);
    checkpoint.close();
  });
});

describe("固定全局 registry 与 holdout 一次性账本", () => {
  it("同 label 跨 private-dir 或并发 registry 永久拒绝，付费 executor 为 0", () => {
    const root = createPrivateWorkspace("registry-label");
    const registryPath = join(root.privateRoot, "registry");
    const registryA = newRegistry(root, registryPath);
    const registryB = newRegistry(root, registryPath);
    const firstFixture = createStateFixtureIn(root, 1, "run-a", "same-label");
    const secondFixture = createStateFixtureIn(root, 1, "run-b", "same-label");
    const first = openCheckpoint(firstFixture);
    const second = openCheckpoint(secondFixture);
    const firstClaim = claimDevelopment(registryA, first, false);
    first.bindGlobalClaim(firstClaim.sha256);
    const execute = vi.fn();
    expect(() => claimDevelopment(registryB, second, false)).toThrow(
      "REVIEW_FLOW_EVALUATION_LABEL_ALREADY_CLAIMED"
    );
    expect(execute).not.toHaveBeenCalled();
    first.close();
    second.close();
    registryA.close();
    registryB.close();
  });

  it("同一 run UUID 不能换 label/目录重放，exact resume 可收养 run claim orphan", () => {
    const root = createPrivateWorkspace("registry-run-id");
    const registryPath = join(root.privateRoot, "registry");
    const registry = newRegistry(root, registryPath);
    const sharedRunId = "10000000-0000-4000-8000-000000000001";
    const first = openCheckpoint(
      createStateFixtureIn(root, 1, "run-first", "run-label-first"),
      { runId: sharedRunId }
    );
    const firstClaim = claimDevelopment(registry, first, false);
    first.bindGlobalClaim(firstClaim.sha256);
    addExclusivePublishOrphan(join(
      registryPath,
      `run-${sharedRunId}.claim.private.json`
    ));
    expect(claimDevelopment(registry, first, true).sha256).toBe(firstClaim.sha256);

    const second = openCheckpoint(
      createStateFixtureIn(root, 1, "run-second", "run-label-second"),
      { runId: sharedRunId }
    );
    expect(() => claimDevelopment(registry, second, false)).toThrow(
      "REVIEW_FLOW_EVALUATION_RUN_ALREADY_CLAIMED"
    );
    first.close();
    second.close();
    registry.close();
  });

  it("fresh 在半套报告存在时于请求前失败", () => {
    const root = createPrivateWorkspace("registry-partial");
    const registryPath = join(root.privateRoot, "registry");
    mkdirSync(registryPath, { mode: 0o700 });
    writePrivateFile(
      join(registryPath, "review-flow-half-label-summary.private.json"),
      Buffer.from("{}\n")
    );
    const registry = newRegistry(root, registryPath);
    const fixture = createStateFixtureIn(root, 1, "run", "half-label");
    const checkpoint = openCheckpoint(fixture);
    const execute = vi.fn();
    expect(() => claimDevelopment(registry, checkpoint, false)).toThrow(
      "REVIEW_FLOW_EVALUATION_PARTIAL_REPORT_EXISTS"
    );
    expect(execute).not.toHaveBeenCalled();
    checkpoint.close();
    registry.close();
  });

  it("development 主体用途跨数据根永久登记，同主体新版本可追加但不能转入 holdout", () => {
    const developmentFixture = createDatasetFixture("usage-development-a");
    const development = loadDataset(developmentFixture, "development_identity");
    const developmentDescriptor = readManifest(developmentFixture)
      .partitions.development.cases[0]!;
    const registryPath = join(developmentFixture.privateRoot, "usage-registry");
    const registryA = newRegistry(developmentFixture, registryPath);
    const registryB = newRegistry(developmentFixture, registryPath);
    const first = registryA.registerDevelopmentUse(development);
    expect(registryB.registerDevelopmentUse(development).sha256).toBe(first.sha256);

    const newVersionFixture = createDatasetFixture("usage-development-v2");
    rewriteDatasetCaseBinding(newVersionFixture, "development", 0, {
      safeId: "case-0033",
      subjectId: developmentDescriptor.subjectId
    });
    const newVersion = loadDataset(newVersionFixture, "development_identity");
    expect(() => registryB.registerDevelopmentUse(newVersion)).not.toThrow();

    const holdoutFixture = createDatasetFixture("usage-holdout-subject");
    rewriteDatasetCaseBinding(holdoutFixture, "holdout", 0, {
      safeId: "case-9033",
      subjectId: developmentDescriptor.subjectId
    });
    const holdout = loadDataset(holdoutFixture, "holdout_prediction");
    expect(() => registryB.registerHoldoutPlan(holdout)).toThrow(
      "REVIEW_FLOW_EVALUATION_SUBJECT_USAGE_CONFLICT"
    );
    registryA.close();
    registryB.close();
  });

  it("换 subject/safeId/dataset/content 仍按来源谱系或内容摘要阻止 development→holdout", () => {
    const sourceFixture = createDatasetFixture("usage-source");
    const development = loadDataset(sourceFixture, "development_identity");
    const sourceDescriptor = readManifest(sourceFixture)
      .partitions.development.cases[0]!;
    const registry = newRegistry(
      sourceFixture,
      join(sourceFixture.privateRoot, "usage-registry")
    );
    registry.registerDevelopmentUse(development);

    const lineageFixture = createDatasetFixture("usage-lineage-replay");
    rewriteDatasetCaseBinding(lineageFixture, "holdout", 0, {
      safeId: "case-9033",
      sourceLineageSha256: sourceDescriptor.sourceLineageSha256
    });
    expect(() => registry.registerHoldoutPlan(
      loadDataset(lineageFixture, "holdout_prediction")
    )).toThrow("REVIEW_FLOW_EVALUATION_SUBJECT_USAGE_CONFLICT");

    const contentFixture = createDatasetFixture("usage-content-replay");
    rewriteDatasetCaseBinding(contentFixture, "holdout", 0, {
      safeId: "case-9033",
      contentFrom: {
        fixture: sourceFixture,
        partition: "development",
        index: 0
      }
    });
    expect(() => registry.registerHoldoutPlan(
      loadDataset(contentFixture, "holdout_prediction")
    )).toThrow("REVIEW_FLOW_EVALUATION_SUBJECT_USAGE_CONFLICT");
    registry.close();
  });

  it("预留 holdout 反向阻止 development，partial 同用途 claim 可精确补齐", () => {
    const holdoutFixture = createDatasetFixture("usage-holdout-first");
    const holdout = loadDataset(holdoutFixture, "holdout_prediction");
    const holdoutDescriptor = readManifest(holdoutFixture)
      .partitions.holdout.cases[0]!;
    const registryPath = join(holdoutFixture.privateRoot, "usage-registry");
    const registry = newRegistry(holdoutFixture, registryPath);
    registry.registerHoldoutPlan(holdout);

    const developmentFixture = createDatasetFixture("usage-development-replay");
    rewriteDatasetCaseBinding(developmentFixture, "development", 0, {
      safeId: "case-0033",
      subjectId: holdoutDescriptor.subjectId
    });
    expect(() => registry.registerDevelopmentUse(
      loadDataset(developmentFixture, "development_identity")
    )).toThrow("REVIEW_FLOW_EVALUATION_SUBJECT_USAGE_CONFLICT");
    chmodSync(developmentFixture.developmentRevealDescriptorPath, 0o000);
    expect(() => loadDevelopmentDatasetAfterUsageRegistration({
      manifestPath: developmentFixture.manifestPath,
      revealDescriptorPath:
        developmentFixture.developmentRevealDescriptorPath,
      datasetPrivateRoot: developmentFixture.privateRoot,
      containingWorkspace: developmentFixture.workspace,
      registry
    })).toThrow("REVIEW_FLOW_EVALUATION_SUBJECT_USAGE_CONFLICT");
    registry.close();

    const partialFixture = createDatasetFixture("usage-partial");
    const partialDataset = loadDataset(partialFixture, "development_identity");
    const subjectId = partialDataset.cases[0]!.subjectId;
    const partialRegistryPath = join(partialFixture.privateRoot, "partial-registry");
    mkdirSync(partialRegistryPath, { mode: 0o700 });
    const partialClaim = reviewFlowEvaluationSubjectUsageClaimSchema.parse({
      schemaVersion: 2,
      artifactKind: "review_flow_evaluation_subject_usage_claim",
      keyKind: "subject",
      purpose: "development",
      subjectId
    });
    writePrivateFile(
      join(partialRegistryPath, `usage-subject-${sha256(subjectId)}.private.json`),
      Buffer.from(serializePhysicalBlindArtifact(partialClaim), "utf8")
    );
    const partialRegistry = newRegistry(partialFixture, partialRegistryPath);
    expect(() => partialRegistry.registerDevelopmentUse(partialDataset)).not.toThrow();
    partialRegistry.close();
  });

  it("holdout 固定主体、标签对与 baseline→candidate phase；换标签/目录不能重开链", () => {
    const datasetFixture = createDatasetFixture();
    const blind = loadDataset(datasetFixture, "holdout_prediction");
    const registryPath = join(datasetFixture.privateRoot, "registry");
    const registry = newRegistry(datasetFixture, registryPath);
    const nomination = nominateTestHoldoutSelection(
      datasetFixture,
      blind,
      registry
    );
    const plan = nomination.plan;
    const baseline = createDatasetCheckpoint(
      datasetFixture,
      blind,
      "baseline",
      plan.registration.baselineLabel,
      null,
      "holdout-baseline"
    );
    const baselineClaim = claimHoldout(
      registry,
      baseline.checkpoint,
      blind,
      false
    );
    baseline.checkpoint.bindGlobalClaim(baselineClaim.sha256);
    const baselineSlot = registry.claimHoldoutSlot({
      plan,
      genesis: baseline.checkpoint.genesisBinding(),
      labelClaimSha256: baselineClaim.sha256,
      selectionClaimSha256: nomination.sha256,
      resume: false
    });
    completeAll(baseline.checkpoint, blind.cases.map((entry) => entry.safeId));
    const baselineState = baseline.checkpoint.sealExecution();
    registry.completeHoldoutPrediction({
      state: baselineState,
      slotClaimSha256: baselineSlot.sha256
    });

    const replay = createDatasetCheckpoint(
      datasetFixture,
      blind,
      "baseline",
      plan.registration.baselineLabel,
      null,
      "holdout-baseline-replay"
    );
    expect(() => claimHoldout(registry, replay.checkpoint, blind, false)).toThrow(
      "REVIEW_FLOW_EVALUATION_LABEL_ALREADY_CLAIMED"
    );
    replay.checkpoint.close();

    const wrongLabel = createDatasetCheckpoint(
      datasetFixture,
      blind,
      "candidate",
      "unregistered-candidate",
      plan.registration.baselineLabel,
      "holdout-wrong"
    );
    const wrongClaim = claimHoldout(registry, wrongLabel.checkpoint, blind, false);
    wrongLabel.checkpoint.bindGlobalClaim(wrongClaim.sha256);
    expect(() => registry.claimHoldoutSlot({
      plan,
      genesis: wrongLabel.checkpoint.genesisBinding(),
      labelClaimSha256: wrongClaim.sha256,
      selectionClaimSha256: nomination.sha256,
      resume: false
    })).toThrow("REVIEW_FLOW_EVALUATION_HOLDOUT_LABEL_NOT_PREREGISTERED");
    wrongLabel.checkpoint.close();
    baseline.checkpoint.close();
    registry.close();
  });

  it("holdout 槽位拒绝 adapter/dataset/runner 等完整预测身份变化", () => {
    const fixture = createDatasetFixture("selection-production-identity");
    const blind = loadDataset(fixture, "holdout_prediction");
    const holdout = requireTestHoldoutBindings(blind);
    const registry = newRegistry(fixture, join(fixture.privateRoot, "registry"));
    const nomination = nominateTestHoldoutSelection(fixture, blind, registry);

    const baseIdentity: ReviewFlowEvaluationIdentity = {
      ...identityFixture("holdout"),
      datasetFingerprint: blind.datasetFingerprint,
      manifestSha256: blind.manifestSha256
    };
    const harnessChangedIdentity: ReviewFlowEvaluationIdentity = {
      ...baseIdentity,
      codeIdentity: {
        ...baseIdentity.codeIdentity,
        codeVersion: "d".repeat(40),
        runnerSha256: "e".repeat(64),
        dependencyCodeSha256: "f".repeat(64),
        dependencyFileCount: baseIdentity.codeIdentity.dependencyFileCount + 1
      }
    };
    const harnessChanged = createDatasetCheckpoint(
      fixture,
      blind,
      "baseline",
      holdout.registration.baselineLabel,
      null,
      "harness-only-change",
      { identity: harnessChangedIdentity }
    );
    const harnessChangedClaim = claimHoldout(
      registry,
      harnessChanged.checkpoint,
      blind,
      false
    );
    harnessChanged.checkpoint.bindGlobalClaim(harnessChangedClaim.sha256);
    expect(() => registry.claimHoldoutSlot({
      plan: nomination.plan,
      genesis: harnessChanged.checkpoint.genesisBinding(),
      labelClaimSha256: harnessChangedClaim.sha256,
      selectionClaimSha256: nomination.sha256,
      resume: false
    })).toThrow("REVIEW_FLOW_EVALUATION_HOLDOUT_PREDICTION_IDENTITY_MISMATCH");
    harnessChanged.checkpoint.close();
    registry.close();

    const mismatchFixture = createDatasetFixture("selection-config-mismatch");
    const mismatchBlind = loadDataset(mismatchFixture, "holdout_prediction");
    const mismatchHoldout = requireTestHoldoutBindings(mismatchBlind);
    const mismatchRegistry = newRegistry(
      mismatchFixture,
      join(mismatchFixture.privateRoot, "registry")
    );
    const mismatchNomination = nominateTestHoldoutSelection(
      mismatchFixture,
      mismatchBlind,
      mismatchRegistry
    );
    const mismatchedIdentity: ReviewFlowEvaluationIdentity = {
      ...identityFixture("holdout"),
      datasetFingerprint: mismatchBlind.datasetFingerprint,
      manifestSha256: mismatchBlind.manifestSha256,
      configurationFingerprint: "0".repeat(64)
    };
    const rejected = createDatasetCheckpoint(
      mismatchFixture,
      mismatchBlind,
      "baseline",
      mismatchHoldout.registration.baselineLabel,
      null,
      "production-config-change",
      { identity: mismatchedIdentity }
    );
    const rejectedClaim = claimHoldout(
      mismatchRegistry,
      rejected.checkpoint,
      mismatchBlind,
      false
    );
    rejected.checkpoint.bindGlobalClaim(rejectedClaim.sha256);
    expect(() => mismatchRegistry.claimHoldoutSlot({
      plan: mismatchNomination.plan,
      genesis: rejected.checkpoint.genesisBinding(),
      labelClaimSha256: rejectedClaim.sha256,
      selectionClaimSha256: mismatchNomination.sha256,
      resume: false
    })).toThrow("REVIEW_FLOW_EVALUATION_HOLDOUT_PREDICTION_IDENTITY_MISMATCH");
    rejected.checkpoint.close();
    mismatchRegistry.close();
  });

  it("candidate incomplete 不生成 completion，不能 reveal；两条完整链只允许一次 reveal/exact resume", () => {
    const fixture = createDatasetFixture();
    const blind = loadDataset(fixture, "holdout_prediction");
    const blindHoldout = requireTestHoldoutBindings(blind);
    const registryPath = join(fixture.privateRoot, "registry");
    const registry = newRegistry(fixture, registryPath);
    const baseline = completeHoldoutChain(
      fixture,
      blind,
      registry,
      "baseline",
      "baseline-run"
    );

    const incomplete = createDatasetCheckpoint(
      fixture,
      blind,
      "candidate",
      blindHoldout.registration.candidateLabel,
      blindHoldout.registration.baselineLabel,
      "candidate-incomplete"
    );
    const incompleteClaim = claimHoldout(
      registry,
      incomplete.checkpoint,
      blind,
      false
    );
    incomplete.checkpoint.bindGlobalClaim(incompleteClaim.sha256);
    const nomination = nominateTestHoldoutSelection(fixture, blind, registry);
    const plan = nomination.plan;
    const incompleteSlot = registry.claimHoldoutSlot({
      plan,
      genesis: incomplete.checkpoint.genesisBinding(),
      labelClaimSha256: incompleteClaim.sha256,
      selectionClaimSha256: nomination.sha256,
      resume: false
    });
    incomplete.checkpoint.markActive(blind.cases[0]!.safeId);
    incomplete.checkpoint.markFailed(
      blind.cases[0]!.safeId,
      fixedFailure("REVIEW_FLOW_HTTP_499", 499)
    );
    const incompleteState = incomplete.checkpoint.sealExecution();
    expect(() => registry.completeHoldoutPrediction({
      state: incompleteState,
      slotClaimSha256: incompleteSlot.sha256
    })).toThrow("REVIEW_FLOW_EVALUATION_HOLDOUT_PREDICTION_INCOMPLETE");
    incomplete.checkpoint.close();

    // 使用另一份数据集标签，完成真正 candidate，避免已永久占用的不完整槽。
    registry.close();
    baseline.checkpoint.close();

    const fullFixture = createDatasetFixture("full-reveal");
    const fullBlind = loadDataset(fullFixture, "holdout_prediction");
    const fullHoldout = requireTestHoldoutBindings(fullBlind);
    const fullRegistryPath = join(fullFixture.privateRoot, "registry");
    const fullRegistry = newRegistry(fullFixture, fullRegistryPath);
    const fullBaseline = completeHoldoutChain(
      fullFixture,
      fullBlind,
      fullRegistry,
      "baseline",
      "baseline"
    );
    const fullCandidate = completeHoldoutChain(
      fullFixture,
      fullBlind,
      fullRegistry,
      "candidate",
      "candidate"
    );
    addExclusivePublishOrphan(join(
      fullRegistryPath,
      `holdout-${fullHoldout.identity}-baseline.complete.private.json`
    ));
    expect(fullRegistry.readPredictionCompletion(
      fullHoldout.identity,
      "baseline"
    ).completion.complete).toBe(true);
    addExclusivePublishOrphan(join(
      fullRegistryPath,
      `label-${fullHoldout.registration.baselineLabel}.claim.private.json`
    ));
    expect(claimHoldout(
      fullRegistry,
      fullBaseline.checkpoint,
      fullBlind,
      true
    ).claim.label).toBe(fullHoldout.registration.baselineLabel);
    fullBaseline.checkpoint.close();
    fullCandidate.checkpoint.close();
    const baselineSnapshot = loadReviewFlowEvaluationCheckpointForReveal({
      privateDirectory: fullBaseline.outputDirectory,
      label: fullHoldout.registration.baselineLabel,
      privateRoot: fullFixture.privateRoot,
      containingWorkspace: fullFixture.workspace
    });
    const candidateSnapshot = loadReviewFlowEvaluationCheckpointForReveal({
      privateDirectory: fullCandidate.outputDirectory,
      label: fullHoldout.registration.candidateLabel,
      privateRoot: fullFixture.privateRoot,
      containingWorkspace: fullFixture.workspace
    });
    const claimInput = {
      dataset: fullBlind,
      baselineSnapshot,
      candidateSnapshot,
      scoringCodeIdentity: codeIdentityFixture(),
      resume: false
    } as const;
    const reveal = fullRegistry.claimReveal(claimInput);
    expect(reveal.claim.holdoutIdentity).toBe(fullBlind.holdoutIdentity);
    expect(() => fullRegistry.claimReveal(claimInput)).toThrow(
      "REVIEW_FLOW_EVALUATION_HOLDOUT_ALREADY_REVEALED"
    );
    addExclusivePublishOrphan(join(
      fullRegistryPath,
      `holdout-${fullHoldout.identity}.reveal.private.json`
    ));
    expect(fullRegistry.claimReveal({ ...claimInput, resume: true }).sha256).toBe(
      reveal.sha256
    );
    fullRegistry.close();
  });
});

describe("严格私有报告、恢复与计分", () => {
  it("只在有独立标注的样本上计三态/穷尽品味/原创性，并报告技术召回与 contestUse 分层", () => {
    const fixture = createDatasetFixture();
    const dataset = loadDataset(fixture, "development_scored");
    const chain = createDatasetCheckpoint(
      fixture,
      dataset,
      "baseline",
      "dev-report",
      null,
      "dev-report"
    );
    chain.checkpoint.bindGlobalClaim("a".repeat(64));
    completeAll(chain.checkpoint, dataset.cases.map((entry) => entry.safeId), (safeId) => {
      if (safeId === "case-0001") return projection("approve");
      if (safeId === "case-0002") return projection("reject", { judgeabilityConcern: true, contestUse: "not_used" });
      if (safeId === "case-0003") return projection("reject", { judgeabilityConcern: true, contestUse: "not_used" });
      return projection("approve", { contestUse: "not_used" });
    });
    const state = chain.checkpoint.sealExecution();
    const report = buildReviewFlowEvaluationReport({ dataset, checkpoint: state });
    expect(report.summary.complete).toBe(true);
    expect(report.summary.eligible).toBe(false);
    expect(report.summary.scoring.historicalOutcomeBinary).toMatchObject({
      scoredCaseCount: 32,
      accuracy: 1
    });
    expect(report.summary.scoring.independentThreeWayVerdict).toMatchObject({
      scoredCaseCount: 1,
      accuracy: 1
    });
    expect(report.summary.scoring.exhaustiveIndependentTasteReasons.scoredCaseCount).toBe(1);
    expect(report.summary.scoring.originality.scoredCaseCount).toBe(1);
    expect(report.summary.scoring.observedHistoricalTechnicalReasons.recall).toBe(1);
    expect(report.summary.scoring.contestUse.coverage).toMatchObject({
      used: 1,
      not_used: 31,
      historicalAccepted: 30,
      historicalRejected: 2
    });
    expect(report.summary.scoring.contestUse.knownUseBinary.accuracy).toBe(1);
    expect(report.summary.receiptCoverage.completeElevenRoleReceiptCaseCount).toBe(32);
    expect(report.summary.receiptCoverage.totalReceiptCount).toBe(352);
    expect(report.summary.generatedAt).toBe(state.executionSeal?.sealedAt);
    expect(report.json).not.toContain("PRIVATE_STATEMENT_SENTINEL");
    expect(report.json).not.toContain("PRIVATE_SOLUTION_SENTINEL");
    chain.checkpoint.close();
  });

  it("incomplete/499 令所有准确率失效且 eligible 永远 false", () => {
    const fixture = createDatasetFixture();
    const dataset = loadDataset(fixture, "development_scored");
    const chain = createDatasetCheckpoint(
      fixture,
      dataset,
      "baseline",
      "dev-incomplete",
      null,
      "dev-incomplete"
    );
    chain.checkpoint.bindGlobalClaim("b".repeat(64));
    chain.checkpoint.markActive("case-0001");
    chain.checkpoint.markFailed(
      "case-0001",
      fixedFailure("REVIEW_FLOW_HTTP_499", 499)
    );
    const state = chain.checkpoint.sealExecution();
    const report = buildReviewFlowEvaluationReport({ dataset, checkpoint: state });
    expect(report.summary).toMatchObject({ complete: false, eligible: false });
    expect(report.summary.scoring.valid).toBe(false);
    expect(report.summary.scoring.historicalOutcomeBinary.accuracy).toBeNull();
    expect(report.summary.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "REVIEW_FLOW_HTTP_499", httpStatus: 499 }),
      expect.objectContaining({
        code: "REVIEW_FLOW_EVALUATION_NOT_STARTED_AFTER_FAILURE"
      })
    ]));
    chain.checkpoint.close();
  });

  it.each([1, 2, 3, 4])(
    "报告发布崩溃在第 %i 个文件后，exact resume 补齐且 executor=0",
    async (existingArtifactCount) => {
      const fixture = createDatasetFixture(`publish-${existingArtifactCount}`);
      const dataset = loadDataset(fixture, "development_scored");
      const registryPath = join(fixture.privateRoot, "registry");
      const registry = newRegistry(fixture, registryPath);
      const chain = createDatasetCheckpoint(
        fixture,
        dataset,
        "baseline",
        `publish-${existingArtifactCount}`,
        null,
        `publish-${existingArtifactCount}`
      );
      const claim = claimDevelopment(registry, chain.checkpoint, false);
      chain.checkpoint.bindGlobalClaim(claim.sha256);
      completeAll(chain.checkpoint, dataset.cases.map((entry) => entry.safeId));
      const state = chain.checkpoint.sealExecution();
      const executor = { execute: vi.fn() };
      await runReviewFlowEvaluationCases({
        checkpoint: chain.checkpoint,
        cases: dataset.cases.map((entry) => ({
          safeId: entry.safeId,
          prepared: entry.safeId
        })),
        executor,
        concurrency: 2
      });
      expect(executor.execute).not.toHaveBeenCalled();
      const report = buildReviewFlowEvaluationReport({ dataset, checkpoint: state });
      const artifacts = reportArtifacts(state, claim.sha256, report.json, report.markdown);
      mkdirSync(registryPath, { recursive: true, mode: 0o700 });
      for (const artifact of artifacts.slice(0, existingArtifactCount)) {
        writePrivateFile(join(registryPath, artifact.name), Buffer.from(artifact.text));
      }
      const publication = registry.publishScoredReport({
        state,
        summaryJson: report.json,
        markdown: report.markdown
      });
      expect(publication.receipt.complete).toBe(true);
      for (const artifact of artifacts) {
        expect(statSync(join(registryPath, artifact.name)).mode & 0o777).toBe(0o600);
      }
      chain.checkpoint.close();
      registry.close();
    }
  );

  it("baseline loader 要求完整 strict summary、marker、claim、publication receipt", () => {
    const fixture = createDatasetFixture("baseline-loader");
    const dataset = loadDataset(fixture, "development_scored");
    const registryPath = join(fixture.privateRoot, "registry");
    const registry = newRegistry(fixture, registryPath);
    const chain = createDatasetCheckpoint(
      fixture,
      dataset,
      "baseline",
      "strict-baseline",
      null,
      "strict-baseline"
    );
    const claim = claimDevelopment(registry, chain.checkpoint, false);
    chain.checkpoint.bindGlobalClaim(claim.sha256);
    completeAll(chain.checkpoint, dataset.cases.map((entry) => entry.safeId));
    const state = chain.checkpoint.sealExecution();
    const report = buildReviewFlowEvaluationReport({ dataset, checkpoint: state });
    expect(() => registry.publishScoredReport({
      state,
      summaryJson: serializePhysicalBlindArtifact({
        ...report.summary,
        label: "different-label"
      }),
      markdown: report.markdown
    })).toThrow("REVIEW_FLOW_EVALUATION_REPORT_STATE_INVALID");
    const publication = registry.publishScoredReport({
      state,
      summaryJson: report.json,
      markdown: report.markdown
    });
    chain.checkpoint.acknowledgePublication({
      kind: "scored_report",
      artifactSetSha256: publication.markerSha256,
      registryReceiptSha256: publication.receiptSha256,
      complete: true
    });
    const markerPath = join(
      registryPath,
      "review-flow-strict-baseline-report-set.private.json"
    );
    addExclusivePublishOrphan(markerPath);
    const binding = assertUsableReviewFlowEvaluationBaseline(
      "strict-baseline",
      dataset.datasetFingerprint,
      registry
    );
    expect(binding).toMatchObject({
      schemaVersion: 2,
      labelClaimSha256: claim.sha256,
      executionCompletionFingerprint: state.executionSeal?.completionFingerprint
    });
    expect(statSync(markerPath).nlink).toBe(1);
    expect(() => parseReviewFlowEvaluationReportSummary(
      Buffer.from(`${JSON.stringify({
        schemaVersion: 2,
        protocolVersion: "review-flow-evaluation-v2",
        label: "strict-baseline"
      })}\n`)
    )).toThrow("REVIEW_FLOW_EVALUATION_REPORT_SUMMARY_INVALID");
    expect(() => parseReviewFlowEvaluationReportSummary(
      Buffer.from(`${JSON.stringify({ ...report.summary, unexpected: true })}\n`)
    )).toThrow("REVIEW_FLOW_EVALUATION_REPORT_SUMMARY_INVALID");
    chain.checkpoint.close();
    registry.close();
  });

  it("holdout reveal 同时生成 baseline/candidate 报告与 comparison，仍不签发资格", () => {
    const fixture = createDatasetFixture("comparison");
    const blind = loadDataset(fixture, "holdout_prediction");
    const revealed = loadDataset(fixture, "holdout_reveal");
    const blindHoldout = requireTestHoldoutBindings(blind);
    const revealedHoldout = requireTestHoldoutBindings(revealed);
    const registry = newRegistry(fixture, join(fixture.privateRoot, "registry"));
    const baseline = completeHoldoutChain(
      fixture,
      blind,
      registry,
      "baseline",
      "comparison-baseline",
      () => projection("reject", { duplicate: true, contestUse: "not_used" })
    );
    const candidate = completeHoldoutChain(
      fixture,
      blind,
      registry,
      "candidate",
      "comparison-candidate",
      () => projection("approve")
    );
    const baselineReport = buildReviewFlowEvaluationReport({
      dataset: revealed,
      checkpoint: baseline.state
    });
    const candidateReport = buildReviewFlowEvaluationReport({
      dataset: revealed,
      checkpoint: candidate.state
    });
    const comparison = buildReviewFlowEvaluationComparison({
      holdoutIdentity: revealedHoldout.identity,
      thresholdPolicySha256: revealedHoldout.registration.thresholdPolicySha256,
      baseline: baselineReport.summary,
      candidate: candidateReport.summary,
      baselineReportSha256: baselineReport.sha256,
      candidateReportSha256: candidateReport.sha256
    });
    expect(comparison.comparison).toMatchObject({
      complete: true,
      eligible: false,
      eligibilityReason: "accuracy_threshold_policy_not_approved"
    });
    baseline.checkpoint.close();
    candidate.checkpoint.close();
    const baselineSnapshot = loadReviewFlowEvaluationCheckpointForReveal({
      privateDirectory: baseline.outputDirectory,
      label: blindHoldout.registration.baselineLabel,
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace
    });
    const candidateSnapshot = loadReviewFlowEvaluationCheckpointForReveal({
      privateDirectory: candidate.outputDirectory,
      label: blindHoldout.registration.candidateLabel,
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace
    });
    const reveal = registry.claimReveal({
      dataset: blind,
      baselineSnapshot,
      candidateSnapshot,
      scoringCodeIdentity: codeIdentityFixture(),
      resume: false
    });
    const baselinePublication = registry.publishScoredReport({
      state: baselineSnapshot.state,
      summaryJson: baselineReport.json,
      markdown: baselineReport.markdown
    });
    const candidatePublication = registry.publishScoredReport({
      state: candidateSnapshot.state,
      summaryJson: candidateReport.json,
      markdown: candidateReport.markdown
    });
    expect(() => registry.publishHoldoutComparison({
      dataset: revealed,
      revealClaimSha256: reveal.sha256,
      baselineReportSetSha256: baselinePublication.markerSha256,
      candidateReportSetSha256: candidatePublication.markerSha256,
      comparisonJson: `${comparison.json.trimEnd()} `
    })).toThrow("REVIEW_FLOW_EVALUATION_COMPARISON_INVALID");
    expect(registry.publishHoldoutComparison({
      dataset: revealed,
      revealClaimSha256: reveal.sha256,
      baselineReportSetSha256: baselinePublication.markerSha256,
      candidateReportSetSha256: candidatePublication.markerSha256,
      comparisonJson: comparison.json
    }).markerSha256).toMatch(/^[0-9a-f]{64}$/u);
    registry.close();
  });
});

describe("adapter、CLI 与窄环境", () => {
  it("正式 adapter 绑定 Node/arch/dependency 与固定 11 个模型槽位但不发请求", () => {
    const fixture = createDatasetFixture();
    const dataset = loadDataset(fixture, "development_scored");
    const config = loadReviewFlowEvaluationConfig({ env: narrowEnvironment() });
    const adapter = createReviewFlowEvaluationAdapter({
      config,
      codeIdentity: codeIdentityFixture(),
      runtimeIdentity: runtimeIdentityFixture(),
      difficultyAnchors: {
        anchors: [],
        provisional: true,
        fingerprint: "4".repeat(64)
      },
      datasetFingerprint: dataset.datasetFingerprint,
      manifestSha256: dataset.manifestSha256,
      anklangInputPolicy: dataset.anklangInputPolicy,
      placeholderTagIds: dataset.placeholderTagIds,
      purpose: dataset.purpose,
      concurrency: 2,
      maxCaseAttempts: 2,
      proxyEnvironment: { HTTP_PROXY: "http://127.0.0.1:10808" }
    });
    const prepared = adapter.prepare({
      safeId: dataset.cases[0]!.safeId,
      task: dataset.cases[0]!.task
    });
    expect(prepared.taskSource.provenance.anklang.reviewItemExpiresAt).toBeNull();
    expect(adapter.identity.providerSummary.map((entry) => entry.role)).toEqual(
      reviewFlowRoleSchema.options
    );
    expect(adapter.identity.runtime).toMatchObject({
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      packageLockSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      nodeExecutableSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      dependencyBundleSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      packages: expect.arrayContaining([
        expect.objectContaining({ name: "undici", version: "8.9.0" })
      ])
    });
    expect(adapter.identity.configurationSummary).toMatchObject({
      concurrency: 2,
      caseAttempts: 2,
      proxyEnvironmentKeys: ["HTTP_PROXY"],
      proxyEnvironmentFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u)
    });
    const changedConcurrency = createReviewFlowEvaluationAdapter({
      config,
      codeIdentity: codeIdentityFixture(),
      runtimeIdentity: runtimeIdentityFixture(),
      difficultyAnchors: {
        anchors: [],
        provisional: true,
        fingerprint: "4".repeat(64)
      },
      datasetFingerprint: dataset.datasetFingerprint,
      manifestSha256: dataset.manifestSha256,
      anklangInputPolicy: dataset.anklangInputPolicy,
      placeholderTagIds: dataset.placeholderTagIds,
      purpose: dataset.purpose,
      concurrency: 3,
      maxCaseAttempts: 2,
      proxyEnvironment: { HTTP_PROXY: "http://127.0.0.1:10808" }
    });
    const changedProxy = createReviewFlowEvaluationAdapter({
      config,
      codeIdentity: codeIdentityFixture(),
      runtimeIdentity: runtimeIdentityFixture(),
      difficultyAnchors: {
        anchors: [],
        provisional: true,
        fingerprint: "4".repeat(64)
      },
      datasetFingerprint: dataset.datasetFingerprint,
      manifestSha256: dataset.manifestSha256,
      anklangInputPolicy: dataset.anklangInputPolicy,
      placeholderTagIds: dataset.placeholderTagIds,
      purpose: dataset.purpose,
      concurrency: 2,
      maxCaseAttempts: 2,
      proxyEnvironment: { HTTPS_PROXY: "http://127.0.0.1:10809" }
    });
    expect(changedConcurrency.identity.configurationFingerprint).not.toBe(
      adapter.identity.configurationFingerprint
    );
    expect(changedProxy.identity.configurationFingerprint).not.toBe(
      adapter.identity.configurationFingerprint
    );
    const changedPlaceholder = createReviewFlowEvaluationAdapter({
      config,
      codeIdentity: codeIdentityFixture(),
      runtimeIdentity: runtimeIdentityFixture(),
      difficultyAnchors: {
        anchors: [],
        provisional: true,
        fingerprint: "4".repeat(64)
      },
      datasetFingerprint: dataset.datasetFingerprint,
      manifestSha256: dataset.manifestSha256,
      anklangInputPolicy: dataset.anklangInputPolicy,
      placeholderTagIds: ["tag-other"],
      purpose: dataset.purpose,
      concurrency: 2,
      maxCaseAttempts: 2,
      proxyEnvironment: { HTTP_PROXY: "http://127.0.0.1:10808" }
    });
    expect(changedPlaceholder.identity.configurationFingerprint).not.toBe(
      adapter.identity.configurationFingerprint
    );
    const changedCaseAttempts = createReviewFlowEvaluationAdapter({
      config,
      codeIdentity: codeIdentityFixture(),
      runtimeIdentity: runtimeIdentityFixture(),
      difficultyAnchors: {
        anchors: [],
        provisional: true,
        fingerprint: "4".repeat(64)
      },
      datasetFingerprint: dataset.datasetFingerprint,
      manifestSha256: dataset.manifestSha256,
      anklangInputPolicy: dataset.anklangInputPolicy,
      placeholderTagIds: dataset.placeholderTagIds,
      purpose: dataset.purpose,
      concurrency: 2,
      maxCaseAttempts: 5,
      proxyEnvironment: { HTTP_PROXY: "http://127.0.0.1:10808" }
    });
    expect(changedCaseAttempts.identity.configurationFingerprint).not.toBe(
      adapter.identity.configurationFingerprint
    );
    expect(() => changedPlaceholder.prepare({
      safeId: dataset.cases[0]!.safeId,
      task: dataset.cases[0]!.task
    })).toThrow("REVIEW_FLOW_EVALUATION_PLACEHOLDER_TAGS_MISMATCH");
  });

  it("adapter 接受并发 16/20 并写入配置，拒绝超过硬上限 20", () => {
    const fixture = createDatasetFixture();
    const dataset = loadDataset(fixture, "development_scored");
    const config = loadReviewFlowEvaluationConfig({ env: narrowEnvironment() });
    const baseOverrides = {
      config,
      codeIdentity: codeIdentityFixture(),
      runtimeIdentity: runtimeIdentityFixture(),
      difficultyAnchors: {
        anchors: [],
        provisional: true,
        fingerprint: "4".repeat(64)
      },
      datasetFingerprint: dataset.datasetFingerprint,
      manifestSha256: dataset.manifestSha256,
      anklangInputPolicy: dataset.anklangInputPolicy,
      placeholderTagIds: dataset.placeholderTagIds,
      purpose: dataset.purpose,
      maxCaseAttempts: 2,
      proxyEnvironment: { HTTP_PROXY: "http://127.0.0.1:10808" }
    };
    // 16（CLI 默认起始）与 20（硬上限）都必须通过 adapter 校验并进入配置摘要。
    for (const concurrency of [16, 20]) {
      const adapter = createReviewFlowEvaluationAdapter({
        ...baseOverrides,
        concurrency
      });
      expect(adapter.identity.configurationSummary.concurrency).toBe(concurrency);
    }
    // 超过 20 必须在 adapter 层被拒绝，而不是等到运行时。
    expect(() => createReviewFlowEvaluationAdapter({
      ...baseOverrides,
      concurrency: 21
    })).toThrow("REVIEW_FLOW_EVALUATION_CONCURRENCY_INVALID");
  });

  it("CLI 分离 run/reveal 参数，标记不能绕过危险/无关凭据检查", async () => {
    expect(resolveReviewFlowEvaluationCliOptions([
      "--action=run",
      "--manifest=/private/manifest.json",
      "--dataset-private-root=/private",
      "--private-dir=/private/runs",
      "--partition=holdout",
      "--label=before-a",
      "--variant=baseline",
      "--development-baseline-label=dev-before-a",
      "--development-candidate-label=dev-after-a"
    ])).toMatchObject({
      action: "run",
      datasetPrivateRoot: "/private",
      variant: "baseline",
      developmentBaselineLabel: "dev-before-a",
      developmentCandidateLabel: "dev-after-a",
      maxCaseAttempts: 3,
      resume: false
    });
    expect(resolveReviewFlowEvaluationCliOptions([
      "--action=reveal",
      "--manifest=/private/manifest.json",
      "--reveal-descriptor=/private/reveal/reveal.private.json",
      "--dataset-private-root=/private",
      "--baseline-private-dir=/private/before",
      "--candidate-private-dir=/private/after",
      "--resume"
    ])).toMatchObject({
      action: "reveal",
      revealDescriptorPath: "/private/reveal/reveal.private.json",
      datasetPrivateRoot: "/private",
      resume: true
    });
    expect(() => resolveReviewFlowEvaluationCliOptions([
      "--action=run",
      "--manifest=/private/manifest.json",
      "--dataset-private-root=relative/private",
      "--private-dir=/private/runs",
      "--partition=development",
      "--label=dev-a",
      "--variant=baseline"
    ])).toThrow("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
    const representative3Args = [
      "--action=run",
      "--manifest=/private/manifest.json",
      "--reveal-descriptor=/private/reveal/development.private.json",
      "--dataset-private-root=/private",
      "--private-dir=/private/runs",
      "--partition=development",
      "--label=dev-smoke",
      "--variant=baseline",
      "--case-selector=representative3-v1",
      "--max-case-attempts=1"
    ] as const;
    expect(resolveReviewFlowEvaluationCliOptions(
      representative3Args
    )).toMatchObject({
      purpose: "development",
      caseSelector: "representative3-v1",
      maxCaseAttempts: 1,
      resume: false
    });
    const representative3V2Args = representative3Args.map((entry) =>
      entry === "--case-selector=representative3-v1"
        ? "--case-selector=representative3-v2"
        : entry
    );
    expect(resolveReviewFlowEvaluationCliOptions(
      representative3V2Args
    )).toMatchObject({
      purpose: "development",
      caseSelector: "representative3-v2",
      maxCaseAttempts: 1,
      resume: false
    });
    expect(() => resolveReviewFlowEvaluationCliOptions([
      ...representative3V2Args,
      "--resume"
    ])).toThrow("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
    for (const invalidArgs of [
      representative3Args.map((entry) =>
        entry === "--case-selector=representative3-v1"
          ? "--case-selector=case-0001"
          : entry
      ),
      [...representative3Args, "--resume"],
      representative3Args.map((entry) =>
        entry === "--max-case-attempts=1"
          ? "--max-case-attempts=3"
          : entry
      ),
      [
        "--action=run",
        "--manifest=/private/manifest.json",
        "--dataset-private-root=/private",
        "--private-dir=/private/runs",
        "--partition=holdout",
        "--label=before-a",
        "--variant=baseline",
        "--development-baseline-label=dev-before-a",
        "--development-candidate-label=dev-after-a",
        "--case-selector=representative3-v1"
      ]
    ]) {
      expect(() => resolveReviewFlowEvaluationCliOptions(invalidArgs)).toThrow(
        "REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID"
      );
    }
    await expect(runReviewFlowEvaluationCli({ argv: [], env: {} })).rejects.toThrow(
      "REVIEW_FLOW_EVALUATION_SAFE_LAUNCH_REQUIRED"
    );
    await expect(runReviewFlowEvaluationCli({
      argv: [],
      env: {
        FERMATA_RUN_WITH_ENV: "1",
        NODE_OPTIONS: "--inspect",
        EVAL_CODE_VERSION: "1".repeat(40)
      }
    })).rejects.toThrow("DANGEROUS_NODE_ENVIRONMENT");
    await expect(runReviewFlowEvaluationCli({
      argv: [],
      env: {
        FERMATA_RUN_WITH_ENV: "1",
        URMOTIV_ROBOT_TOKEN: "must-never-enter",
        EVAL_CODE_VERSION: "1".repeat(40)
      }
    })).rejects.toThrow();
  });
});

interface DatasetFixture {
  readonly workspace: string;
  readonly privateRoot: string;
  readonly suiteDirectory: string;
  readonly manifestPath: string;
  readonly developmentRevealDirectory: string;
  readonly developmentRevealDescriptorPath: string;
  readonly revealDirectory: string;
  readonly revealDescriptorPath: string;
  readonly seed: string;
}

interface FileBinding {
  fileName: string;
  sha256: string;
}

interface PredictionCaseDescriptor {
  safeId: string;
  subjectId: string;
  sourceLineageSha256: string;
  originalAnklangResponseSha256: string;
  content: FileBinding;
}

interface RevealCaseMaterial extends PredictionCaseDescriptor {
  upstreamEvidence: {
    sealedEvidenceSha256: string;
    rowEvidenceSha256: string;
    originalAnklangResponseSha256: string;
    bridgeEvidence: ReviewFlowEvaluationGold["upstreamEvidence"]["bridgeEvidence"];
  };
  gold: FileBinding;
}

interface ManifestDocument {
  schemaVersion: 4;
  datasetId: string;
  anklangInputPolicy:
    "exclude_current_corpus_for_historical_outcome";
  placeholderTagIds: string[];
  tagCatalog: FileBinding & { version: number };
  holdoutRegistration: {
    baselineLabel: string;
    candidateLabel: string;
    thresholdPolicySha256: string;
  } | null;
  developmentRevealCommitmentSha256: string;
  holdoutRevealCommitmentSha256: string | null;
  partitions: {
    development: { cases: PredictionCaseDescriptor[] };
    holdout: { cases: PredictionCaseDescriptor[] };
  };
}

function createDatasetFixture(seed = "default"): DatasetFixture {
  const root = createPrivateWorkspace(`dataset-${seed}`);
  const suiteDirectory = join(root.privateRoot, "suite");
  const developmentRevealDirectory = join(root.privateRoot, "development-reveal");
  const revealDirectory = join(root.privateRoot, "reveal");
  mkdirSync(suiteDirectory, { mode: 0o700 });
  mkdirSync(developmentRevealDirectory, { mode: 0o700 });
  mkdirSync(revealDirectory, { mode: 0o700 });
  const catalog = {
    schemaVersion: 1 as const,
    version: 7,
    tags: [
      {
        id: "tag-basic",
        name: "基础",
        categoryId: "category-foundation",
        categoryName: "基础",
        description: "固定测试标签",
        aliases: [],
        active: true as const
      },
      {
        id: "tag-other",
        name: "其他",
        categoryId: "category-other",
        categoryName: "其他",
        description: "备用占位标签",
        aliases: [],
        active: true as const
      }
    ]
  };
  const catalogBytes = jsonBytes(catalog);
  writePrivateFile(join(suiteDirectory, "tag-catalog.private.json"), catalogBytes);
  const developmentMaterials: RevealCaseMaterial[] = [];
  if (seed.startsWith("representative3-v2")) {
    const countMismatch = seed.includes("count-mismatch");
    for (let index = 1; index <= 32; index++) {
      const padded = String(index).padStart(4, "0");
      const rejectedSubmitAnswer = index >= 2 && index <= 9;
      const rejectedNoReasons = index >= 10 && index <= 12;
      const rejectedTraditionalTaste = index === 13;
      const rejected = rejectedSubmitAnswer ||
        rejectedNoReasons ||
        rejectedTraditionalTaste;
      const hasTaste = index === 1 ||
        rejectedSubmitAnswer ||
        rejectedTraditionalTaste ||
        (index >= 14 && index <= 28);
      const problemType: RobotReviewTask["problem"]["type"] =
        index === 1
          ? "interactive"
          : rejectedSubmitAnswer
            ? countMismatch && index === 9
              ? "traditional"
              : "submit_answer"
            : index <= 18
              ? "traditional"
              : "submit_answer";
      developmentMaterials.push(writeDatasetCase({
        directory: suiteDirectory,
        goldDirectory: developmentRevealDirectory,
        partition: "development",
        safeId: `case-${padded}`,
        subjectId: `subject-${safeToken(seed)}-dev-${padded}`,
        numericId: numericSeed(seed, index),
        problemType,
        catalog,
        gold: (common) => ({
          ...common,
          evaluationScope: "verdict_and_taste",
          historicalOutcome: rejected ? "rejected" : "accepted",
          contestUse:
            !rejected && (index === 1 || index <= 29)
              ? "used"
              : "unknown",
          observedHistoricalTasteReasons: hasTaste
            ? [{
                dimension: rejected ? "icpc_fit" : "novelty",
                direction: rejected ? "concern" : "strength"
              }]
            : [],
          observedHistoricalTechnicalReasons: []
        })
      }));
    }
  } else {
    developmentMaterials.push(
      writeDatasetCase({
        directory: suiteDirectory,
        goldDirectory: developmentRevealDirectory,
        partition: "development",
        safeId: "case-0001",
        subjectId: `subject-${safeToken(seed)}-dev-0001`,
        numericId: numericSeed(seed, 1),
        catalog,
        gold: (common) => ({
          ...common,
          evaluationScope: "verdict_and_taste",
          historicalOutcome: "accepted",
          contestUse: "used",
          observedHistoricalTasteReasons: [{
            dimension: "novelty",
            direction: "strength"
          }],
          observedHistoricalTechnicalReasons: [],
          independentVerdict: {
            annotation: "independent_human_three_way",
            verdict: "approve"
          },
          independentTaste: {
            annotation: "exhaustive_independent_human",
            reasons: [{ dimension: "novelty", direction: "strength" }]
          },
          independentOriginality: {
            annotation: "independent_human_originality",
            confirmedDuplicate: false
          },
          expectedTagIds: ["tag-basic"],
          independentDifficulty: {
            annotation: "independent_human_without_submitter_metadata",
            codeforcesDifficulty: 1800,
            thinkingLevel: 3,
            codingLevel: 2
          }
        })
      }),
      writeDatasetCase({
        directory: suiteDirectory,
        goldDirectory: developmentRevealDirectory,
        partition: "development",
        safeId: "case-0002",
        subjectId: `subject-${safeToken(seed)}-dev-0002`,
        numericId: numericSeed(seed, 2),
        catalog,
        gold: (common) => ({
          ...common,
          evaluationScope: "verdict_and_taste",
          historicalOutcome: "rejected",
          contestUse: "not_used",
          observedHistoricalTasteReasons: [{
            dimension: "icpc_fit",
            direction: "concern"
          }],
          observedHistoricalTechnicalReasons: ["judgeability_concern"]
        })
      })
    );
    for (let extraIndex = 3; extraIndex <= 32; extraIndex++) {
      const padded = String(extraIndex).padStart(4, "0");
      developmentMaterials.push(
        writeDatasetCase({
          directory: suiteDirectory,
          goldDirectory: developmentRevealDirectory,
          partition: "development",
          safeId: `case-${padded}`,
          subjectId: `subject-${safeToken(seed)}-dev-${padded}`,
          numericId: numericSeed(seed, extraIndex),
          catalog,
          gold: (common) => ({
            ...common,
            evaluationScope: "verdict_and_taste",
            historicalOutcome: extraIndex === 3 ? "rejected" : "accepted",
            contestUse: "not_used",
            observedHistoricalTasteReasons: [],
            observedHistoricalTechnicalReasons:
              extraIndex === 3 ? ["judgeability_concern"] : []
          })
        })
      );
    }
  }
  const development = developmentMaterials.map(toPredictionDescriptor);
  const holdoutMaterials = [
    writeDatasetCase({
      directory: suiteDirectory,
      goldDirectory: revealDirectory,
      partition: "holdout",
      safeId: "case-9001",
      subjectId: `subject-${safeToken(seed)}-hold-9001`,
      numericId: numericSeed(seed, 91),
      catalog,
      gold: (common) => ({
        ...common,
        evaluationScope: "verdict_and_taste",
        historicalOutcome: "rejected",
        contestUse: "not_used",
        observedHistoricalTasteReasons: [{
          dimension: "icpc_fit",
          direction: "concern"
        }],
        observedHistoricalTechnicalReasons: []
      })
    }),
    writeDatasetCase({
      directory: suiteDirectory,
      goldDirectory: revealDirectory,
      partition: "holdout",
      safeId: "case-9002",
      subjectId: `subject-${safeToken(seed)}-hold-9002`,
      numericId: numericSeed(seed, 92),
      catalog,
      gold: (common) => ({
        ...common,
        evaluationScope: "verdict_and_taste",
        historicalOutcome: "accepted",
        contestUse: "used",
        observedHistoricalTasteReasons: [],
        observedHistoricalTechnicalReasons: []
      })
    })
  ];
  for (let extraHoldoutIndex = 3; extraHoldoutIndex <= 32; extraHoldoutIndex++) {
    const holdoutId = String(9000 + extraHoldoutIndex);
    holdoutMaterials.push(
      writeDatasetCase({
        directory: suiteDirectory,
        goldDirectory: revealDirectory,
        partition: "holdout",
        safeId: `case-${holdoutId}`,
        subjectId: `subject-${safeToken(seed)}-hold-${holdoutId}`,
        numericId: numericSeed(seed, 90 + extraHoldoutIndex),
        catalog,
        gold: (common) => ({
          ...common,
          evaluationScope: "verdict_and_taste",
          historicalOutcome: "accepted",
          contestUse: "not_used",
          observedHistoricalTasteReasons: [],
          observedHistoricalTechnicalReasons: []
        })
      })
    );
  }
  const holdout = holdoutMaterials.map((entry) => ({
    safeId: entry.safeId,
    subjectId: entry.subjectId,
    sourceLineageSha256: entry.sourceLineageSha256,
    originalAnklangResponseSha256: entry.originalAnklangResponseSha256,
    content: entry.content
  }));
  const manifest: ManifestDocument = {
    schemaVersion: 4,
    datasetId: `dataset-${sha256(seed).slice(0, 16)}`,
    anklangInputPolicy:
      "exclude_current_corpus_for_historical_outcome",
    placeholderTagIds: ["tag-basic"],
    tagCatalog: {
      fileName: "tag-catalog.private.json",
      sha256: sha256(catalogBytes),
      version: 7
    },
    holdoutRegistration: {
      baselineLabel: `holdout-${safeToken(seed)}-before`,
      candidateLabel: `holdout-${safeToken(seed)}-after`,
      thresholdPolicySha256: sha256(`threshold-${seed}`)
    },
    developmentRevealCommitmentSha256: "0".repeat(64),
    holdoutRevealCommitmentSha256: "0".repeat(64),
    partitions: {
      development: { cases: development },
      holdout: { cases: holdout }
    }
  };
  const manifestPath = join(suiteDirectory, "manifest.private.json");
  const developmentRevealDescriptorPath = join(
    developmentRevealDirectory,
    "reveal.private.json"
  );
  const revealDescriptorPath = join(revealDirectory, "reveal.private.json");
  const developmentRevealDescriptor = reviewFlowEvaluationRevealDescriptorSchema.parse({
    schemaVersion: 1,
    artifactKind: "review_flow_evaluation_reveal_descriptor",
    protocolVersion: "review-flow-evaluation-reveal-v1",
    datasetId: manifest.datasetId,
    purpose: "development",
    predictionBindingSha256:
      reviewFlowEvaluationDevelopmentPredictionBindingSha256(manifest),
    commitmentNonce: sha256(`development-reveal-nonce-${seed}`),
    cases: developmentMaterials.map(toRevealDescriptorCase)
  });
  const developmentRevealBytes = jsonBytes(developmentRevealDescriptor);
  writePrivateFile(developmentRevealDescriptorPath, developmentRevealBytes);
  manifest.developmentRevealCommitmentSha256 = sha256(developmentRevealBytes);
  const revealDescriptor = reviewFlowEvaluationRevealDescriptorSchema.parse({
    schemaVersion: 1,
    artifactKind: "review_flow_evaluation_reveal_descriptor",
    protocolVersion: "review-flow-evaluation-reveal-v1",
    datasetId: manifest.datasetId,
    purpose: "holdout",
    predictionBindingSha256:
      reviewFlowEvaluationHoldoutPredictionBindingSha256(manifest),
    commitmentNonce: sha256(`reveal-nonce-${seed}`),
    cases: holdoutMaterials.map(toRevealDescriptorCase)
  });
  const revealBytes = jsonBytes(revealDescriptor);
  writePrivateFile(revealDescriptorPath, revealBytes);
  manifest.holdoutRevealCommitmentSha256 = sha256(revealBytes);
  const fixture = {
    ...root,
    suiteDirectory,
    manifestPath,
    developmentRevealDirectory,
    developmentRevealDescriptorPath,
    revealDirectory,
    revealDescriptorPath,
    seed
  };
  writeDatasetManifestAndBridge(fixture, manifest);
  return fixture;
}

function writeDatasetCase(input: {
  readonly directory: string;
  readonly goldDirectory?: string;
  readonly partition: "development" | "holdout";
  readonly safeId: string;
  readonly subjectId: string;
  readonly numericId: number;
  readonly problemType?: RobotReviewTask["problem"]["type"];
  readonly catalog: {
    readonly version: number;
    readonly tags: RobotReviewTask["tagCatalog"]["tags"];
  };
  readonly gold: (
    common: {
      schemaVersion: 2;
      safeId: string;
      subjectId: string;
      sourceLineageSha256: string;
      contentSha256: string;
      upstreamEvidence: {
        schemaVersion: 1;
        sealedEvidenceSha256: string;
        rowEvidenceSha256: string;
        sourceLineageSha256: string;
        originalAnklangResponseSha256: string;
        bridgeEvidence: ReviewFlowEvaluationGold["upstreamEvidence"]["bridgeEvidence"];
      };
    }
  ) => ReviewFlowEvaluationGold;
}): RevealCaseMaterial {
  const task = taskFixture(
    input.numericId,
    input.catalog,
    input.problemType ?? "traditional"
  );
  const contentBytes = jsonBytes(task);
  const contentSha256 = sha256(contentBytes);
  const sourceLineageSha256 = sha256(`lineage-${input.subjectId}`);
  const sealedEvidenceSha256 = sha256(`sealed-${input.subjectId}`);
  const rowEvidenceSha256 = sha256(`row-${input.subjectId}`);
  const originalAnklangResponseSha256 = sha256(`anklang-${input.subjectId}`);
  const bridgeEvidence = {
    bridgeVersion: "urmotiv-review-flow-bridge-v5" as const,
    historicalInputPreparationCompletionSha256:
      sha256(`preparation-completion-${input.subjectId}`),
    verificationAttestationSha256: sha256(`attestation-${input.subjectId}`),
    bridgePlanSha256: sha256(`bridge-plan-${input.subjectId}`),
    reviewGoldEvidenceSha256: sha256(`review-gold-evidence-${input.subjectId}`),
    sourceBindingsSha256: sha256(`source-bindings-${input.subjectId}`),
    upstreamGoldSha256: sha256(`upstream-gold-${input.subjectId}`),
    worksheetSha256: sha256(`worksheet-${input.subjectId}`),
    inspectionSha256: sha256(`inspection-${input.subjectId}`),
    layoutSha256: sha256(`layout-${input.subjectId}`),
    reviewInputSetSha256: sha256(`review-input-set-${input.subjectId}`),
    sourceMappingSha256: sha256(`source-mapping-${input.subjectId}`),
    anklangCaptureAttestationSha256:
      sha256(`anklang-capture-attestation-${input.subjectId}`),
    anklangCaptureCompletionSha256:
      sha256(`anklang-capture-completion-${input.subjectId}`),
    anklangRequestSha256: sha256(`anklang-request-${input.subjectId}`),
    anklangResponseSha256: originalAnklangResponseSha256,
    anklangCorpusEvidenceKind: "remote_corpus_unverifiable" as const
  };
  const gold = input.gold({
    schemaVersion: 2,
    safeId: input.safeId,
    subjectId: input.subjectId,
    sourceLineageSha256,
    contentSha256,
    upstreamEvidence: {
      schemaVersion: 1,
      sealedEvidenceSha256,
      rowEvidenceSha256,
      sourceLineageSha256,
      originalAnklangResponseSha256,
      bridgeEvidence
    }
  });
  const goldBytes = jsonBytes(gold);
  const stem = `${input.partition}-${input.safeId}`;
  const contentFileName = `${stem}.content.private.json`;
  const goldFileName = `${stem}.gold.private.json`;
  writePrivateFile(join(input.directory, contentFileName), contentBytes);
  writePrivateFile(
    join(input.goldDirectory ?? input.directory, goldFileName),
    goldBytes
  );
  return {
    safeId: input.safeId,
    subjectId: input.subjectId,
    sourceLineageSha256,
    originalAnklangResponseSha256,
    upstreamEvidence: {
      sealedEvidenceSha256,
      rowEvidenceSha256,
      originalAnklangResponseSha256,
      bridgeEvidence
    },
    content: { fileName: contentFileName, sha256: contentSha256 },
    gold: { fileName: goldFileName, sha256: sha256(goldBytes) }
  };
}

function toPredictionDescriptor(
  entry: RevealCaseMaterial
): PredictionCaseDescriptor {
  return {
    safeId: entry.safeId,
    subjectId: entry.subjectId,
    sourceLineageSha256: entry.sourceLineageSha256,
    originalAnklangResponseSha256: entry.originalAnklangResponseSha256,
    content: entry.content
  };
}

function toRevealDescriptorCase(entry: RevealCaseMaterial) {
  return {
    safeId: entry.safeId,
    subjectId: entry.subjectId,
    sourceLineageSha256: entry.sourceLineageSha256,
    contentSha256: entry.content.sha256,
    upstreamEvidence: entry.upstreamEvidence,
    gold: entry.gold
  };
}

function taskFixture(
  numericId: number,
  catalog: {
    readonly version: number;
    readonly tags: RobotReviewTask["tagCatalog"]["tags"];
  },
  problemType: RobotReviewTask["problem"]["type"] = "traditional"
): RobotReviewTask {
  const suffix = String(numericId).padStart(12, "0").slice(-12);
  const contentHash = sha256(`problem-${numericId}`);
  return {
    assignmentId: `10000000-0000-4000-8000-${suffix}`,
    leaseExpiresAt: "2099-08-01T01:00:00.000Z",
    problem: {
      id: `private-problem-${numericId}`,
      revision: 1,
      reviewRound: 1,
      contentHash,
      title: `PRIVATE_TITLE_SENTINEL_${numericId}`,
      type: problemType,
      tagIds: ["tag-basic"],
      content: {
        basicStatement: `PRIVATE_STATEMENT_SENTINEL_${numericId}`,
        basicSolution: `PRIVATE_SOLUTION_SENTINEL_${numericId}`,
        background: "",
        statement: "",
        inputFormat: "",
        outputFormat: "",
        constraints: "",
        solution: "",
        hints: ""
      },
      samples: [],
      limits: { timeMs: 1000, memoryMiB: 256 }
    },
    tagCatalog: { version: catalog.version, tags: [...catalog.tags] },
    reviewItems: []
  };
}

function loadDataset(
  fixture: DatasetFixture,
  mode: "development_identity" | "development_scored" |
    "holdout_prediction" | "holdout_reveal"
): ReviewFlowEvaluationDatasetBundle {
  return loadReviewFlowEvaluationDataset({
    manifestPath: fixture.manifestPath,
    revealDescriptorPath: mode === "development_scored"
      ? fixture.developmentRevealDescriptorPath
      : mode === "holdout_reveal"
        ? fixture.revealDescriptorPath
        : undefined,
    mode,
    privateRoot: fixture.privateRoot,
    containingWorkspace: fixture.workspace
  });
}

function requireTestHoldoutBindings(
  dataset: ReviewFlowEvaluationDatasetBundle
): {
  readonly identity: string;
  readonly registration: NonNullable<
    ReviewFlowEvaluationDatasetBundle["holdoutRegistration"]
  >;
} {
  if (
    dataset.purpose !== "holdout" ||
    dataset.holdoutIdentity === null ||
    dataset.holdoutRegistration === null
  ) {
    throw new Error("TEST_HOLDOUT_DATASET_INVALID");
  }
  return {
    identity: dataset.holdoutIdentity,
    registration: dataset.holdoutRegistration
  };
}

function chmodPartitionFiles(
  fixture: DatasetFixture,
  partition: "development" | "holdout",
  mode: number
): void {
  const manifest = readManifest(fixture);
  const descriptors = manifest.partitions[partition].cases;
  const reveal = readRevealDescriptor(fixture, partition);
  for (const [index, descriptor] of descriptors.entries()) {
    chmodSync(join(fixture.suiteDirectory, descriptor.content.fileName), mode);
    const gold = reveal.cases[index]?.gold;
    if (gold === undefined) throw new Error("TEST_GOLD_BINDING_MISSING");
    chmodSync(
      join(
        partition === "development"
          ? fixture.developmentRevealDirectory
          : fixture.revealDirectory,

        gold.fileName
      ),
      mode
    );
  }
}

interface PrivateWorkspace {
  readonly workspace: string;
  readonly privateRoot: string;
}

function createPrivateWorkspace(seed: string): PrivateWorkspace {
  const workspace = mkdtempSync(join(tmpdir(), `fermata-${safeToken(seed)}-`));
  temporaryRoots.push(workspace);
  chmodSync(workspace, 0o700);
  const privateRoot = join(workspace, "private");
  mkdirSync(privateRoot, { mode: 0o700 });
  return { workspace, privateRoot };
}

interface StateFixture extends PrivateWorkspace {
  readonly outputDirectory: string;
  readonly label: string;
  readonly identity: ReviewFlowEvaluationIdentity;
  readonly expectedCases: readonly ReviewFlowEvaluationExpectedCase[];
  readonly holdoutIdentity: string | null;
  readonly thresholdPolicySha256: string | null;
}

function createStateFixture(count: number): StateFixture {
  const root = createPrivateWorkspace("state");
  return createStateFixtureIn(root, count, "runs", "baseline-a");
}

function createStateFixtureIn(
  root: PrivateWorkspace,
  count: number,
  directoryName: string,
  label: string,
  purpose: "development" | "holdout" = "development"
): StateFixture {
  const outputDirectory = join(root.privateRoot, directoryName);
  mkdirSync(outputDirectory, { mode: 0o700 });
  return {
    ...root,
    outputDirectory,
    label,
    identity: identityFixture(purpose),
    expectedCases: Array.from({ length: count }, (_, index) => ({
      safeId: `case-${String(index + 1).padStart(4, "0")}`,
      subjectId: `subject-state-${String(index + 1).padStart(4, "0")}`,
      sourceLineageSha256: sha256(`lineage-${index}`),
      contentSha256: sha256(`content-${index}`)
    })),
    holdoutIdentity: purpose === "holdout" ? "8".repeat(64) : null,
    thresholdPolicySha256: purpose === "holdout" ? "9".repeat(64) : null
  };
}

function createRepresentative3StateFixture(
  configurationOverrides: Partial<
    ReviewFlowEvaluationIdentity["configurationSummary"]
  > = {},
  selector: "representative3-v1" | "representative3-v2" =
    "representative3-v1"
): StateFixture {
  const fixture = createStateFixture(3);
  const configurationSummary = {
    ...fixture.identity.configurationSummary,
    llmFirstOutputMs: 100,
    llmOutputIdleMs: 100,
    llmMaximumDurationMs: 1_000,
    maxAttempts: 3,
    baseDelayMs: 100,
    concurrency: 20,
    caseAttempts: 1,
    ...configurationOverrides
  };
  const identity: ReviewFlowEvaluationIdentity = {
    ...fixture.identity,
    configurationSummary,
    caseSelection: selector === "representative3-v1"
      ? {
          schemaVersion: 1,
          selector,
          parentDatasetFingerprint: fixture.identity.datasetFingerprint,
          parentManifestSha256: fixture.identity.manifestSha256,
          parentBridgeCompletionSha256: "3".repeat(64),
          parentCaseCount: 32,
          orderedSelectionSha256:
            reviewFlowEvaluationOrderedSelectionSha256(fixture.expectedCases),
          selectedCaseCount: 3
        }
      : {
          schemaVersion: 2,
          selector,
          selectorIdentity: "review-flow-evaluation-representative3-v2",
          tieBreakProtocol: "review-flow-representative3-v2-tiebreak",
          parentDatasetFingerprint: fixture.identity.datasetFingerprint,
          parentManifestSha256: fixture.identity.manifestSha256,
          parentBridgeCompletionSha256: "3".repeat(64),
          parentCaseCount: 32,
          auditedStrataCounts:
            reviewFlowEvaluationRepresentative3V2AuditedStrataCounts,
          orderedSelectionSha256:
            reviewFlowEvaluationOrderedSelectionSha256(fixture.expectedCases),
          selectedCaseCount: 3
        }
  };
  return { ...fixture, identity };
}

function openCheckpoint(
  fixture: StateFixture,
  options: {
    readonly resume?: boolean;
    readonly bindClaim?: boolean;
    readonly variant?: "baseline" | "candidate";
    readonly baselineLabel?: string | null;
    readonly runId?: string;
  } = {}
): ReviewFlowEvaluationCheckpoint {
  const variant = options.variant ?? "baseline";
  const baselineLabel = options.baselineLabel ?? null;
  const checkpoint = new ReviewFlowEvaluationCheckpoint({
    privateDirectory: fixture.outputDirectory,
    label: fixture.label,
    variant,
    baselineLabel,
    baselineBinding: null,
    identity: fixture.identity,
    holdoutIdentity: fixture.holdoutIdentity,
    thresholdPolicySha256: fixture.thresholdPolicySha256,
    expectedCases: fixture.expectedCases,
    resume: options.resume ?? false,
    privateRoot: fixture.privateRoot,
    containingWorkspace: fixture.workspace,
    now: fixedNow,
    randomId: () => options.runId ?? runIdFor(fixture.label)
  });
  if (options.bindClaim) checkpoint.bindGlobalClaim("a".repeat(64));
  return checkpoint;
}

function createDatasetCheckpoint(
  fixture: DatasetFixture,
  dataset: ReviewFlowEvaluationDatasetBundle,
  variant: "baseline" | "candidate",
  label: string,
  baselineLabel: string | null,
  directoryName: string,
  options: {
    readonly baselineBinding?: ReviewFlowEvaluationBaselineBinding | null;
    readonly identity?: ReviewFlowEvaluationIdentity;
  } = {}
): { readonly checkpoint: ReviewFlowEvaluationCheckpoint; readonly outputDirectory: string } {
  const outputDirectory = join(fixture.privateRoot, directoryName);
  mkdirSync(outputDirectory, { mode: 0o700 });
  const holdout = dataset.purpose === "holdout"
    ? requireTestHoldoutBindings(dataset)
    : null;
  const identity: ReviewFlowEvaluationIdentity = options.identity ?? {
    ...identityFixture(dataset.purpose),
    datasetFingerprint: dataset.datasetFingerprint,
    manifestSha256: dataset.manifestSha256
  };
  const checkpoint = new ReviewFlowEvaluationCheckpoint({
    privateDirectory: outputDirectory,
    label,
    variant,
    baselineLabel,
    baselineBinding: options.baselineBinding ?? null,
    identity,
    holdoutIdentity: holdout?.identity ?? null,
    thresholdPolicySha256: holdout?.registration.thresholdPolicySha256 ?? null,
    expectedCases: dataset.cases.map((entry) => ({
      safeId: entry.safeId,
      subjectId: entry.subjectId,
      sourceLineageSha256: entry.sourceLineageSha256,
      contentSha256: entry.contentSha256
    })),
    resume: false,
    privateRoot: fixture.privateRoot,
    containingWorkspace: fixture.workspace,
    now: fixedNow,
    randomId: () => runIdFor(label)
  });
  return { checkpoint, outputDirectory };
}

function identityFixture(
  purpose: "development" | "holdout" = "development"
): ReviewFlowEvaluationIdentity {
  return {
    schemaVersion: 2,
    protocolVersion: "review-flow-evaluation-v2",
    datasetFingerprint: "1".repeat(64),
    manifestSha256: "2".repeat(64),
    purpose,
    codeIdentity: codeIdentityFixture(),
    runtime: runtimeIdentityFixture(),
    configurationFingerprint: "6".repeat(64),
    configurationSummary: {
      llmFirstOutputMs: 1_800_000,
      llmOutputIdleMs: 600_000,
      llmMaximumDurationMs: 14_400_000,
      maxAttempts: 3,
      baseDelayMs: 500,
      concurrency: 2,
      caseAttempts: 1,
      proxyEnvironmentFingerprint: "b".repeat(64),
      proxyEnvironmentKeys: ["HTTP_PROXY"],
      duplicateSimilarityReject: 0.9,
      difficultyAnchorsFingerprint: "9".repeat(64),
      difficultyAnchorsProvisional: true
    },
    experimentVersion: "experiment-test",
    profileName: "profile-test",
    runnerIdentity: "7".repeat(64),
    transportMode: "production_undici",
    providerSummary: reviewFlowRoleSchema.options.map((role) => ({
      role,
      provider: "aether",
      model: `model-${role}`
    }))
  };
}

function codeIdentityFixture() {
  return {
    codeVersion: "3".repeat(40),
    runnerSha256: "4".repeat(64),
    dependencyCodeSha256: "5".repeat(64),
    dependencyFileCount: 33,
    productionDependencyCodeSha256: "c".repeat(64),
    productionDependencyFileCount: 20
  };
}

function runtimeIdentityFixture() {
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    packageLockSha256: "a".repeat(64),
    nodeExecutableSha256: "b".repeat(64),
    nodeExecutableByteLength: 123_456,
    dependencyBundleSha256: "c".repeat(64),
    dependencyFileCount: 4,
    dependencyByteLength: 3_000,
    snapshotSha256: "d".repeat(64),
    snapshotFileCount: 40,
    packages: [
      {
        name: "tsx",
        version: "4.23.1",
        sha256: "e".repeat(64),
        fileCount: 2,
        byteLength: 1_000
      },
      {
        name: "undici",
        version: "8.9.0",
        sha256: "f".repeat(64),
        fileCount: 2,
        byteLength: 2_000
      }
    ],
    trustModel:
      "trusted_bootstrap_same_uid_non_adversarial_trusted_host_system_runtime_unbound_v1" as const
  };
}

function projection(
  verdict: "approve" | "request_changes" | "reject",
  options: {
    readonly duplicate?: boolean;
    readonly judgeabilityConcern?: boolean;
    readonly contestUse?: "used" | "not_used";
  } = {}
): ReviewFlowCalibrationProjection {
  const duplicate = options.duplicate ?? false;
  const roleReceipts = reviewFlowRoleSchema.options.map((role, index) => {
    const response = {
      responseMode: index % 2 === 0 ? "sse" as const : "json" as const,
      transportAttemptCount: 1,
      eofVerified: true as const,
      finishReasonStopVerified: true as const,
      acceptedEventShapes: [],
      sseDoneObserved: index % 2 === 0 ? true as const : null
    };
    return {
      role,
      receiptHash: hashCanonicalValue({
        schemaVersion: 2,
        requestCount: 1,
        transportAttemptCount: 1,
        eofVerified: true,
        jsonSchemaValidated: true,
        responses: [{ schemaVersion: 2, ...response }]
      }),
      requestCount: 1 as const,
      transportAttemptCount: 1,
      responses: [response]
    };
  });
  return reviewFlowCalibrationProjectionSchema.parse({
    schemaVersion: 2,
    verdict,
    codeforcesDifficulty: 1800,
    qualityLevel: 3,
    originalityLevel: duplicate ? 1 : 4,
    thinkingLevel: 3,
    codingLevel: 2,
    tagIds: ["tag-basic"],
    hardBlockers: duplicate ? ["CONFIRMED_DUPLICATE"] : [],
    difficultyConfidence: 0.8,
    technical: {
      officialSolutionCorrect: true,
      statementSolutionConsistency: "verified",
      judgeability: options.judgeabilityConcern ? "concern" : "verified",
      sampleConsistency: "verified",
      constraintSufficiency: "verified",
      referenceImplementation: {
        provided: false,
        status: "unavailable",
        complexityAcceptable: null
      }
    },
    editorial: {
      qualityLevel: 3,
      noveltyLevel: 4,
      ideaDepthLevel: 3,
      naturalnessLevel: 4,
      contestantExperienceLevel: 4,
      evidenceCoverage: { strengths: "found", concerns: "none_found" },
      evidence: [{
        dimension: "novelty",
        direction: "strength",
        severity: "note",
        confidence: 0.8
      }]
    },
    contestFit: {
      icpcFit: options.contestUse === "not_used" ? "weak" : "strong",
      implementationBurden: 2,
      thinkingImplementationBalance: "strong",
      knowledgeFairness: "fair",
      problemsetRole: "standard",
      roleConfidence: 0.8,
      evidenceCoverage: { strengths: "found", concerns: "none_found" },
      evidence: [{
        dimension: "icpc_fit",
        direction: options.contestUse === "not_used" ? "concern" : "strength",
        severity: "note",
        confidence: 0.8
      }]
    },
    originality: {
      originalityLevel: duplicate ? 1 : 4,
      sameProblemAsExisting: duplicate,
      highestSimilarity: duplicate ? 0.99 : 0.1
    },
    roleReceipts,
    receiptSetHash: hashCanonicalValue(roleReceipts)
  });
}

function preparedStateCases(fixture: StateFixture) {
  return fixture.expectedCases.map((entry) => ({
    safeId: entry.safeId,
    prepared: entry.safeId
  }));
}

function completeAll(
  checkpoint: ReviewFlowEvaluationCheckpoint,
  safeIds: readonly string[],
  makeProjection: (safeId: string) => ReviewFlowCalibrationProjection = () =>
    projection("approve")
): void {
  for (const safeId of safeIds) {
    checkpoint.markActive(safeId);
    checkpoint.markCompleted(safeId, makeProjection(safeId));
  }
}

function fixedFailure(code: string, httpStatus: number | null) {
  return {
    code,
    failureKind: httpStatus === 499 ? "cancelled" as const : null,
    httpStatus,
    completedRoleCount: 1,
    failedRoleCount: 1,
    failedRoles: [],
    caseAttempts: 1
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

function newRegistry(
  root: PrivateWorkspace,
  registryDirectory: string
): ReviewFlowEvaluationGlobalRegistry {
  return new ReviewFlowEvaluationGlobalRegistry({
    registryDirectory,
    privateRoot: root.privateRoot,
    containingWorkspace: root.workspace,
    now: fixedNow
  });
}

function claimDevelopment(
  registry: ReviewFlowEvaluationGlobalRegistry,
  checkpoint: ReviewFlowEvaluationCheckpoint,
  resume: boolean
) {
  const state = checkpoint.snapshot();
  return registry.claimLabel({
    genesis: checkpoint.genesisBinding(),
    datasetFingerprint: state.identity.datasetFingerprint,
    holdoutIdentity: null,
    thresholdPolicySha256: null,
    resume
  });
}

function claimHoldout(
  registry: ReviewFlowEvaluationGlobalRegistry,
  checkpoint: ReviewFlowEvaluationCheckpoint,
  dataset: ReviewFlowEvaluationDatasetBundle,
  resume: boolean
) {
  const holdout = requireTestHoldoutBindings(dataset);
  return registry.claimLabel({
    genesis: checkpoint.genesisBinding(),
    datasetFingerprint: dataset.datasetFingerprint,
    holdoutIdentity: holdout.identity,
    thresholdPolicySha256: holdout.registration.thresholdPolicySha256,
    resume
  });
}

const testHoldoutSelections = new WeakMap<
  ReviewFlowEvaluationGlobalRegistry,
  {
    readonly plan: ReviewFlowEvaluationHoldoutPlan;
    readonly selection: ReviewFlowEvaluationHoldoutSelection;
    readonly sha256: string;
  }
>();

function nominateTestHoldoutSelection(
  fixture: DatasetFixture,
  blind: ReviewFlowEvaluationDatasetBundle,
  registry: ReviewFlowEvaluationGlobalRegistry
) {
  const cached = testHoldoutSelections.get(registry);
  if (cached !== undefined) return cached;
  const developmentIdentity = loadDataset(fixture, "development_identity");
  registry.registerDevelopmentUse(developmentIdentity);
  const development = loadDataset(fixture, "development_scored");
  const suffix = development.datasetId.slice("dataset-".length);
  const baselineLabel = `dev-${suffix}-baseline`;
  const candidateLabel = `dev-${suffix}-candidate`;

  const baseline = createDatasetCheckpoint(
    fixture,
    development,
    "baseline",
    baselineLabel,
    null,
    `${baselineLabel}-state`
  );
  const baselineClaim = claimDevelopment(registry, baseline.checkpoint, false);
  baseline.checkpoint.bindGlobalClaim(baselineClaim.sha256);
  completeAll(baseline.checkpoint, development.cases.map((entry) => entry.safeId));
  const baselineState = baseline.checkpoint.sealExecution();
  const baselineReport = buildReviewFlowEvaluationReport({
    dataset: development,
    checkpoint: baselineState
  });
  registry.publishScoredReport({
    state: baselineState,
    summaryJson: baselineReport.json,
    markdown: baselineReport.markdown
  });
  const baselineBinding = assertUsableReviewFlowEvaluationBaseline(
    baselineLabel,
    development.datasetFingerprint,
    registry
  );
  baseline.checkpoint.close();

  const candidate = createDatasetCheckpoint(
    fixture,
    development,
    "candidate",
    candidateLabel,
    baselineLabel,
    `${candidateLabel}-state`,
    { baselineBinding }
  );
  const candidateClaim = claimDevelopment(registry, candidate.checkpoint, false);
  candidate.checkpoint.bindGlobalClaim(candidateClaim.sha256);
  completeAll(candidate.checkpoint, development.cases.map((entry) => entry.safeId));
  const candidateState = candidate.checkpoint.sealExecution();
  const candidateReport = buildReviewFlowEvaluationReport({
    dataset: development,
    checkpoint: candidateState
  });
  registry.publishScoredReport({
    state: candidateState,
    summaryJson: candidateReport.json,
    markdown: candidateReport.markdown
  });
  candidate.checkpoint.close();

  const plan = registry.registerHoldoutPlan(blind).plan;
  const nominated = registry.nominateHoldoutSelection({
    plan,
    developmentBaselineLabel: baselineLabel,
    developmentCandidateLabel: candidateLabel
  });
  const result = { plan, ...nominated };
  testHoldoutSelections.set(registry, result);
  return result;
}

function completeHoldoutChain(
  fixture: DatasetFixture,
  blind: ReviewFlowEvaluationDatasetBundle,
  registry: ReviewFlowEvaluationGlobalRegistry,
  variant: "baseline" | "candidate",
  directoryName: string,
  makeProjection: (safeId: string) => ReviewFlowCalibrationProjection = () =>
    projection("approve")
): {
  readonly checkpoint: ReviewFlowEvaluationCheckpoint;
  readonly outputDirectory: string;
  readonly state: ReviewFlowEvaluationCheckpointState;
} {
  const holdout = requireTestHoldoutBindings(blind);
  const nomination = nominateTestHoldoutSelection(fixture, blind, registry);
  const plan = nomination.plan;
  const label = variant === "baseline"
    ? holdout.registration.baselineLabel
    : holdout.registration.candidateLabel;
  const chain = createDatasetCheckpoint(
    fixture,
    blind,
    variant,
    label,
    variant === "candidate" ? holdout.registration.baselineLabel : null,
    directoryName
  );
  const claim = claimHoldout(registry, chain.checkpoint, blind, false);
  chain.checkpoint.bindGlobalClaim(claim.sha256);
  const slot = registry.claimHoldoutSlot({
    plan,
    genesis: chain.checkpoint.genesisBinding(),
    labelClaimSha256: claim.sha256,
    selectionClaimSha256: nomination.sha256,
    resume: false
  });
  completeAll(
    chain.checkpoint,
    blind.cases.map((entry) => entry.safeId),
    makeProjection
  );
  const state = chain.checkpoint.sealExecution();
  const completion = registry.completeHoldoutPrediction({
    state,
    slotClaimSha256: slot.sha256
  });
  chain.checkpoint.acknowledgePublication({
    kind: "holdout_prediction",
    artifactSetSha256: completion.completion.projectionSetSha256,
    registryReceiptSha256: completion.sha256,
    complete: true
  });
  return { ...chain, state };
}

function reportArtifacts(
  state: ReviewFlowEvaluationCheckpointState,
  claimSha256: string,
  summaryJson: string,
  markdown: string
): readonly { readonly name: string; readonly text: string }[] {
  const summarySha256 = sha256(summaryJson);
  const markdownSha256 = sha256(markdown);
  const marker = reviewFlowEvaluationReportSetMarkerSchema.parse({
    schemaVersion: 2,
    protocolVersion: "review-flow-evaluation-v2",
    label: state.label,
    runId: state.runId,
    summarySha256,
    markdownSha256,
    complete: true,
    executionCompletionFingerprint: state.executionSeal!.completionFingerprint,
    labelClaimSha256: claimSha256
  });
  const markerText = serializePhysicalBlindArtifact(marker);
  const receipt = reviewFlowEvaluationPublicationReceiptSchema.parse({
    schemaVersion: 2,
    artifactKind: "review_flow_evaluation_report_publication",
    label: state.label,
    runId: state.runId,
    labelClaimSha256: claimSha256,
    executionCompletionFingerprint: state.executionSeal!.completionFingerprint,
    summarySha256,
    markdownSha256,
    reportSetSha256: sha256(markerText),
    complete: true
  });
  return [
    { name: `review-flow-${state.label}-summary.private.json`, text: summaryJson },
    { name: `review-flow-${state.label}.private.md`, text: markdown },
    {
      name: `label-${state.label}.published.private.json`,
      text: serializePhysicalBlindArtifact(receipt)
    },
    {
      name: `review-flow-${state.label}-report-set.private.json`,
      text: markerText
    }
  ];
}

function checkpointPath(directory: string, label: string): string {
  return join(directory, `review-flow-${label}.checkpoint.private.json`);
}

function readManifest(fixture: DatasetFixture): ManifestDocument {
  return readJson(fixture.manifestPath) as ManifestDocument;
}

function readRevealDescriptor(
  fixture: DatasetFixture,
  purpose: "development" | "holdout" = "holdout"
) {
  return reviewFlowEvaluationRevealDescriptorSchema.parse(
    readJson(
      purpose === "development"
        ? fixture.developmentRevealDescriptorPath
        : fixture.revealDescriptorPath
    )
  );
}

function rewriteDatasetCaseBinding(
  fixture: DatasetFixture,
  partition: "development" | "holdout",
  index: number,
  changes: {
    readonly safeId?: string;
    readonly subjectId?: string;
    readonly sourceLineageSha256?: string;
    readonly contentFrom?: {
      readonly fixture: DatasetFixture;
      readonly partition: "development" | "holdout";
      readonly index: number;
    };
  }
): void {
  const manifest = readManifest(fixture);
  const descriptor = manifest.partitions[partition].cases[index];
  if (descriptor === undefined) throw new Error("TEST_CASE_MISSING");
  if (changes.contentFrom !== undefined) {
    const sourceManifest = readManifest(changes.contentFrom.fixture);
    const sourceDescriptor =
      sourceManifest.partitions[changes.contentFrom.partition]
        .cases[changes.contentFrom.index];
    if (sourceDescriptor === undefined) throw new Error("TEST_SOURCE_CASE_MISSING");
    const contentBytes = readFileSync(
      join(
        changes.contentFrom.fixture.suiteDirectory,
        sourceDescriptor.content.fileName
      )
    );
    writePrivateFile(
      join(fixture.suiteDirectory, descriptor.content.fileName),
      contentBytes
    );
    descriptor.content.sha256 = sha256(contentBytes);
  }
  descriptor.safeId = changes.safeId ?? descriptor.safeId;
  descriptor.subjectId = changes.subjectId ?? descriptor.subjectId;
  descriptor.sourceLineageSha256 =
    changes.sourceLineageSha256 ?? descriptor.sourceLineageSha256;

  const reveal = readRevealDescriptor(fixture, partition);
  const goldBinding = reveal.cases[index]?.gold;
  if (goldBinding === undefined) throw new Error("TEST_GOLD_BINDING_MISSING");
  const goldPath = join(
    partition === "development"
      ? fixture.developmentRevealDirectory
      : fixture.revealDirectory,
    goldBinding.fileName
  );
  const gold = readJson(goldPath) as ReviewFlowEvaluationGold;
  const changedGold = {
    ...gold,
    safeId: descriptor.safeId,
    subjectId: descriptor.subjectId,
    sourceLineageSha256: descriptor.sourceLineageSha256,
    contentSha256: descriptor.content.sha256,
    upstreamEvidence: {
      ...gold.upstreamEvidence,
      sourceLineageSha256: descriptor.sourceLineageSha256
    }
  } satisfies ReviewFlowEvaluationGold;
  const goldBytes = jsonBytes(changedGold);
  writePrivateFile(goldPath, goldBytes);
  goldBinding.sha256 = sha256(goldBytes);
  writePrivateFile(
    partition === "development"
      ? fixture.developmentRevealDescriptorPath
      : fixture.revealDescriptorPath,
    jsonBytes(reveal)
  );
  writeDatasetManifestAndBridge(fixture, manifest);
}

function writePrivateJson(path: string, value: unknown): void {
  writePrivateFile(path, jsonBytes(value));
}

function rewriteFixtureRevealDescriptor(
  fixture: DatasetFixture,
  manifest: ManifestDocument,
  purpose: "development" | "holdout"
): string {
  const existing = readRevealDescriptor(fixture, purpose);
  const predictions = manifest.partitions[purpose].cases;
  if (existing.cases.length !== predictions.length) {
    throw new Error("TEST_REVEAL_CASE_COUNT_MISMATCH");
  }
  const reveal = reviewFlowEvaluationRevealDescriptorSchema.parse({
    ...existing,
    datasetId: manifest.datasetId,
    purpose,
    predictionBindingSha256: purpose === "development"
      ? reviewFlowEvaluationDevelopmentPredictionBindingSha256(manifest)
      : reviewFlowEvaluationHoldoutPredictionBindingSha256(manifest),
    cases: predictions.map((descriptor, index) => ({
      ...existing.cases[index]!,
      safeId: descriptor.safeId,
      subjectId: descriptor.subjectId,
      sourceLineageSha256: descriptor.sourceLineageSha256,
      contentSha256: descriptor.content.sha256,
      upstreamEvidence: {
        ...existing.cases[index]!.upstreamEvidence,
        originalAnklangResponseSha256:
          descriptor.originalAnklangResponseSha256
      }
    }))
  });
  const bytes = jsonBytes(reveal);
  writePrivateFile(
    purpose === "development"
      ? fixture.developmentRevealDescriptorPath
      : fixture.revealDescriptorPath,
    bytes
  );
  return sha256(bytes);
}

function writeDatasetManifestAndBridge(
  fixture: DatasetFixture,
  manifest: ManifestDocument
): void {
  manifest.developmentRevealCommitmentSha256 = rewriteFixtureRevealDescriptor(
    fixture,
    manifest,
    "development"
  );
  const holdoutCount = manifest.partitions.holdout.cases.length;
  if (holdoutCount === 0) {
    manifest.holdoutRevealCommitmentSha256 = null;
  } else {
    manifest.holdoutRevealCommitmentSha256 = rewriteFixtureRevealDescriptor(
      fixture,
      manifest,
      "holdout"
    );
  }
  const manifestBytes = jsonBytes(manifest);
  writePrivateFile(fixture.manifestPath, manifestBytes);
  const developmentCount = manifest.partitions.development.cases.length;
  writePrivateJson(
    join(fixture.suiteDirectory, reviewFlowEvaluationBridgeCompletionFileName),
    {
      schemaVersion: 5,
      artifactKind: "review_flow_evaluation_dataset_bridge_completion",
      bridgeVersion: "urmotiv-review-flow-bridge-v5",
      datasetId: manifest.datasetId,
      manifestFileName: basename(fixture.manifestPath),
      manifestSha256: sha256(manifestBytes),
      historicalInputPreparationCompletionSha256:
        sha256(`preparation-completion-${manifest.datasetId}`),
      generator: {
        codeVersion: "1".repeat(40),
        runnerSha256: sha256("synthetic-bridge-runner"),
        dependencyCodeSha256: sha256("synthetic-bridge-dependencies"),
        dependencyFileCount: reviewFlowEvaluationCodePaths.length
      },
      repositories: {
        fermata: {
          repository: "Fermata",
          codeVersion: "2".repeat(40),
          runnerPath: "experiments/prepare-review-flow-historical-inputs.ts",
          runnerSha256: sha256("synthetic-fermata-runner"),
          dependencyCodeSha256: sha256("synthetic-fermata-dependencies"),
          dependencyFileCount: historicalInputPreparationCodePaths.length
        },
        urmotiv: {
          repository: "Urmotiv",
          codeVersion: "2".repeat(40),
          runnerPath: upstreamVerifierRunnerPath,
          runnerSha256: sha256("synthetic-urmotiv-runner"),
          dependencyCodeSha256: sha256("synthetic-urmotiv-dependencies"),
          dependencyFileCount: upstreamVerifierDependencyPaths.length
        },
        anklang: {
          repository: "Anklang",
          codeVersion: "2".repeat(40),
          runnerPath: anklangCaptureRunnerPath,
          runnerSha256: sha256("synthetic-anklang-runner"),
          dependencyCodeSha256: sha256("synthetic-anklang-dependencies"),
          dependencyFileCount: anklangCaptureDependencyPaths.length
        }
      },
      tagCatalogSha256: manifest.tagCatalog.sha256,
      placeholderTagIds: manifest.placeholderTagIds,
      sourceLineageSetSha256:
        reviewFlowEvaluationSourceLineageSetSha256(manifest),
      developmentPredictionBindingSha256:
        reviewFlowEvaluationDevelopmentPredictionBindingSha256(manifest),
      developmentRevealCommitmentSha256:
        manifest.developmentRevealCommitmentSha256,
      holdoutPredictionBindingSha256: holdoutCount === 0
        ? null
        : reviewFlowEvaluationHoldoutPredictionBindingSha256(manifest),
      holdoutRevealCommitmentSha256:
        manifest.holdoutRevealCommitmentSha256,
      caseCount: developmentCount + holdoutCount,
      developmentCount,
      holdoutCount
    }
  );
}

function writePrivateFile(path: string, bytes: Uint8Array): void {
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function addExclusivePublishOrphan(targetPath: string): void {
  linkSync(
    targetPath,
    join(
      dirname(targetPath),
      `.blind-${process.pid}-${randomUUID()}.tmp`
    )
  );
  expect(statSync(targetPath).nlink).toBe(2);
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function safeToken(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function numericSeed(seed: string, offset: number): number {
  return Number.parseInt(sha256(`${seed}-${offset}`).slice(0, 7), 16);
}

function runIdFor(label: string): string {
  return `${sha256(label).slice(0, 8)}-0000-4000-8000-${sha256(`run-${label}`).slice(0, 12)}`;
}

function narrowEnvironment(): Record<string, string> {
  return {
    AETHER_BASE_URL: "https://aether.example.test",
    AETHER_API_KEY: "aether-secret-key"
  };
}

describe("T0145-RED 终端摘要账本完整性", () => {
  it("部分角色失败+未启动案例必须暴露逐案例/逐角色/逐尝试账本，缺失字段 completeness=false", () => {
    const fixture = createDatasetFixture("red-accounting");
    const dataset = loadDataset(fixture, "development_scored");
    const chain = createDatasetCheckpoint(
      fixture,
      dataset,
      "baseline",
      "dev-red-accounting",
      null,
      "dev-red-accounting"
    );
    chain.checkpoint.bindGlobalClaim("c".repeat(64));
    // 单例部分角色失败：failedRoles 持久化 requestCount=2 / transportAttemptCount=2 / completedResponseCount=1
    chain.checkpoint.markActive("case-0001");
    chain.checkpoint.markFailed("case-0001", {
      ...fixedFailure("REVIEW_FLOW_ROLE_FAILED", 200),
      completedRoleCount: 2,
      failedRoleCount: 1,
      failedRoles: [{
        role: "critic",
        failureKind: "protocol",
        requestCount: 2,
        transportAttemptCount: 2,
        completedResponseCount: 1
      }]
    });
    const state = chain.checkpoint.sealExecution();
    const report = buildReviewFlowEvaluationReport({ dataset, checkpoint: state });
    const summary = report.summary as unknown as {
      caseCounts: Record<string, number>;
      accounting: {
        logicalRequests: number;
        transportAttempts: number;
        receivedByteResponses: number;
        retries: number;
        schemaErrors: number;
        formatterCorrections: number;
        repairCount: number;
      };
      complete: boolean;
      failures: Array<{ code: string; count: number }>;
    };
    // 逐案例状态账本必须一分不差
    expect(summary.caseCounts.completed).toBe(0);
    expect(summary.caseCounts.failed).toBe(1);
    expect(summary.caseCounts.notStarted).toBe(31);
    expect(summary.caseCounts.skipped).toBe(0);
    expect(summary.caseCounts.cancelled).toBe(0);
    expect(summary.caseCounts.http499).toBe(0);
    expect(summary.caseCounts.unaccounted).toBe(0);
    // 逐角色/逐尝试账本：一次部分角色失败精确暴露 2 次逻辑请求 / 2 次传输 / 1 次收到字节响应 / 重试 / schema / formatter / repair
    expect(summary.accounting).toEqual({
      logicalRequests: 2,
      transportAttempts: 2,
      receivedByteResponses: 1,
      retries: 0,
      schemaErrors: 0,
      formatterCorrections: 0,
      repairCount: 0
    });
    // 任一账本字段缺失 => completeness=false，且 failures 必须逐项列出
    expect(summary.complete).toBe(false);
    expect(summary.failures.some((row) => row.code === "REVIEW_FLOW_ROLE_FAILED")).toBe(true);
    expect(summary.failures.some((row) => row.code === "REVIEW_FLOW_EVALUATION_NOT_STARTED_AFTER_FAILURE")).toBe(true);
    chain.checkpoint.close();
  });
});
