import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareReviewFlowEvaluationDatasetBridge,
  computeUrmotivProblemContentHash,
  type PrepareReviewFlowEvaluationBridgeInput
} from "../experiments/lib/review-flow-evaluation-bridge";
import { loadEvaluationCodeIdentity } from "../experiments/lib/evaluation-code-identity";
import { reviewFlowEvaluationCodePaths } from "../experiments/lib/review-flow-evaluation-adapter";
import { hashCanonicalValue } from "../src/review-flow/evidence";
import { loadReviewFlowEvaluationDataset } from "../experiments/lib/review-flow-evaluation-dataset";
import { parseReviewFlowDatasetBridgeArguments } from "../experiments/prepare-review-flow-dataset";
import type { RobotReviewTask } from "../src/urmotiv-schemas";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("review-flow trusted dataset bridge", () => {
  it("验证完整上游链，保留 Anklang 候选，并以不含 Gold oracle 的 v3 manifest 发布", () => {
    const fixture = createBridgeFixture("complete");
    const stages: string[] = [];
    const result = prepareReviewFlowEvaluationDatasetBridge({
      ...fixture.input,
      randomBytes: sequentialRandomBytes(),
      hooks: {
        afterArtifactWrite: (stage) => stages.push(stage)
      }
    });

    expect(result).toMatchObject({
      caseCount: 2,
      developmentCount: 1,
      holdoutCount: 1
    });
    expect(stages.at(-1)).toBe("completion");
    expect(existsSync(join(fixture.output, "REVIEW_FLOW_DATASET_COMPLETE")))
      .toBe(true);

    const developmentIdentity = loadReviewFlowEvaluationDataset({
      manifestPath: result.manifestPath,
      mode: "development_identity",
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace
    });
    expect(developmentIdentity.cases).toHaveLength(1);
    expect(developmentIdentity.cases[0]?.gold).toBeNull();
    const developmentScored = loadReviewFlowEvaluationDataset({
      manifestPath: result.manifestPath,
      revealDescriptorPath: result.developmentRevealDescriptorPath,
      mode: "development_scored",
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace
    });
    expect(developmentScored.cases[0]?.gold).toMatchObject({
      evaluationScope: "verdict_and_taste",
      historicalOutcome: "rejected",
      contestUse: "not_used"
    });
    const holdoutPrediction = loadReviewFlowEvaluationDataset({
      manifestPath: result.manifestPath,
      mode: "holdout_prediction",
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace
    });
    expect(holdoutPrediction.cases[0]?.gold).toBeNull();
    const holdoutRevealPath = result.holdoutRevealDescriptorPath;
    if (holdoutRevealPath === null) throw new Error("TEST_HOLDOUT_REVEAL_MISSING");
    const holdoutReveal = loadReviewFlowEvaluationDataset({
      manifestPath: result.manifestPath,
      revealDescriptorPath: holdoutRevealPath,
      mode: "holdout_reveal",
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace
    });
    expect(holdoutReveal.cases[0]?.gold).toMatchObject({
      evaluationScope: "originality_only",
      confirmedDuplicate: true
    });

    const task = developmentIdentity.cases[0]?.task;
    const data = task?.reviewItems[0]?.data as Record<string, unknown> | undefined;
    expect(data?.completion).toEqual({
      status: "complete",
      reasonCode: "complete",
      retryable: false
    });
    expect(data?.reuse).toEqual({ policy: "no-store" });
    expect(data?.candidates).toEqual(fixture.developmentCandidates);

    const manifestText = readFileSync(result.manifestPath, "utf8");
    expect(manifestText).not.toContain("gold.private.json");
    const developmentDescriptor = readJson(result.developmentRevealDescriptorPath);
    const holdoutDescriptor = readJson(holdoutRevealPath);
    const labelSideEvidenceDigests = [
      ...developmentDescriptor.cases,
      ...holdoutDescriptor.cases
    ].flatMap((entry: {
      upstreamEvidence: {
        sealedEvidenceSha256: string;
        rowEvidenceSha256: string;
        bridgeEvidence: Record<string, string>;
      };
    }) => [
      entry.upstreamEvidence.sealedEvidenceSha256,
      entry.upstreamEvidence.rowEvidenceSha256,
      ...Object.values(entry.upstreamEvidence.bridgeEvidence).filter(
        (value) => /^[a-f0-9]{64}$/u.test(value)
      )
    ]);
    expect(labelSideEvidenceDigests).toContain(fixture.rowEvidenceSha256);
    expect(labelSideEvidenceDigests).toContain(fixture.upstreamMarkerSha256);
    for (const digest of labelSideEvidenceDigests) {
      expect(manifestText).not.toContain(digest);
    }
    expect(developmentDescriptor.commitmentNonce).not.toBe(
      holdoutDescriptor.commitmentNonce
    );
    const manifest = readJson(result.manifestPath);
    expect(manifest.developmentRevealCommitmentSha256).toBe(
      sha256(readFileSync(result.developmentRevealDescriptorPath))
    );
    expect(manifest.holdoutRevealCommitmentSha256).toBe(
      sha256(readFileSync(holdoutRevealPath))
    );
    const expectedGenerator = {
      codeVersion: fixture.generatorIdentity.codeVersion,
      runnerSha256: fixture.generatorIdentity.runnerSha256,
      dependencyCodeSha256: fixture.generatorIdentity.dependencyCodeSha256,
      dependencyFileCount: fixture.generatorIdentity.dependencyFileCount
    };
    const completion = readJson(
      join(fixture.output, "REVIEW_FLOW_DATASET_COMPLETE")
    );
    expect(completion.generator).toEqual(expectedGenerator);
    const bridgePlan = readJson(fixture.input.bridgePlanPath);
    const planCase = bridgePlan.cases[0];
    const sourceBindings = readJson(
      join(fixture.upstreamGold, "source-bindings.private.json")
    );
    const sourceBinding = sourceBindings.cases[0];
    const prediction = manifest.partitions.development.cases[0];
    const generatedTask = readJson(join(fixture.output, prediction.content.fileName));
    expect(prediction.sourceLineageSha256).toBe(hashCanonicalValue({
      protocol: "review-flow-evaluation-source-lineage-v3",
      bridgeVersion: "urmotiv-review-flow-bridge-v2",
      generator: expectedGenerator,
      identity: {
        upstreamCaseId: planCase.caseId,
        subjectId: planCase.subjectId
      },
      source: {
        sourceId: planCase.sourceId,
        sourcePath: sourceBinding.sourcePath,
        materializedSourceSha256: planCase.sourceSha256
      },
      task: {
        taskDraftSha256: planCase.taskDraft.sha256,
        problemHashInputSha256: planCase.problemHashInput.sha256,
        problemContentHash: generatedTask.problem.contentHash,
        outputContentSha256: prediction.content.sha256,
        originalAnklangResponseSha256:
          planCase.originalAnklangResponse.sha256
      }
    }));
  });

  it("生成器必须来自显式 clean Fermata HEAD，且生成期间身份不能变化", () => {
    const dirty = createBridgeFixture("generator-dirty");
    writeFileSync(join(dirty.generatorRepository, "untracked.txt"), "dirty\n");
    expect(() => prepare(dirty)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_GENERATOR_IDENTITY_INVALID"
    );

    const wrongVersion = createBridgeFixture("generator-version");
    expect(() => prepareReviewFlowEvaluationDatasetBridge({
      ...wrongVersion.input,
      fermataCodeVersion: wrongVersion.input.fermataCodeVersion === "f".repeat(40)
        ? "e".repeat(40)
        : "f".repeat(40),
      randomBytes: sequentialRandomBytes()
    })).toThrow("REVIEW_FLOW_EVALUATION_BRIDGE_GENERATOR_IDENTITY_INVALID");

    const tamperedDependency = createBridgeFixture("generator-tampered");
    writeFileSync(
      join(tamperedDependency.generatorRepository, "src", "llm.ts"),
      "tampered generator dependency\n"
    );
    expect(() => prepare(tamperedDependency)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_GENERATOR_IDENTITY_INVALID"
    );

    const changedDuringRun = createBridgeFixture("generator-changed-during-run");
    expect(() => prepareReviewFlowEvaluationDatasetBridge({
      ...changedDuringRun.input,
      randomBytes: sequentialRandomBytes(),
      hooks: {
        beforeCompletionMarker: () => {
          writeFileSync(
            join(changedDuringRun.generatorRepository, "src", "llm.ts"),
            "changed while publishing\n"
          );
        }
      }
    })).toThrow("REVIEW_FLOW_EVALUATION_BRIDGE_GENERATOR_IDENTITY_CHANGED");
    expect(existsSync(join(changedDuringRun.output, "manifest.private.json")))
      .toBe(true);
    expect(existsSync(
      join(changedDuringRun.output, "REVIEW_FLOW_DATASET_COMPLETE")
    )).toBe(false);
  });

  it("REVIEW_GOLD_COMPLETE 缺失、Gold 被改或原始 review input 未全部绑定时失败关闭", () => {
    const missingMarker = createBridgeFixture("missing-marker");
    rmSync(join(missingMarker.upstreamGold, "REVIEW_GOLD_COMPLETE"));
    expect(() => prepare(missingMarker)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_INPUT_INVALID"
    );

    const changedGold = createBridgeFixture("changed-gold");
    writePrivate(
      join(changedGold.upstreamGold, "gold", "case-upstream-dev.json"),
      pretty({ changed: true })
    );
    expect(() => prepare(changedGold)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_UPSTREAM_GOLD_INVALID"
    );

    const missingReviewInput = createBridgeFixture("missing-review-input");
    expect(() => prepareReviewFlowEvaluationDatasetBridge({
      ...missingReviewInput.input,
      reviewInputPaths: missingReviewInput.input.reviewInputPaths.slice(0, 1),
      randomBytes: sequentialRandomBytes()
    })).toThrow("REVIEW_FLOW_EVALUATION_BRIDGE_REVIEW_INPUT_SET_MISMATCH");

    const changedReviewInput = createBridgeFixture("changed-review-input");
    writePrivate(changedReviewInput.input.reviewInputPaths[1]!, Buffer.from("changed"));
    expect(() => prepare(changedReviewInput)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_REVIEW_INPUT_SET_MISMATCH"
    );
  });

  it("静态 attestation 不能替代本次可信 verifier 执行，stdout 必须逐字一致", () => {
    const missingExecution = createBridgeFixture("attestation-no-execution");
    rmSync(missingExecution.verifierOutputPath);
    expect(() => prepare(missingExecution)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_VERIFIER_EXECUTION_FAILED"
    );

    const changedOutput = createBridgeFixture("attestation-output-mismatch");
    writePrivate(changedOutput.verifierOutputPath, pretty({ forged: true }));
    expect(() => prepare(changedOutput)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_ATTESTATION_MISMATCH"
    );

    const selfConsistentForgery = createBridgeFixture("attestation-forgery");
    const plan = readJson(selfConsistentForgery.input.bridgePlanPath);
    const attestationPath = join(
      selfConsistentForgery.bridgeInput,
      plan.upstreamVerificationAttestation.fileName
    );
    const original = readJson(attestationPath);
    const { verificationFingerprint: _old, ...withoutFingerprint } = original;
    withoutFingerprint.artifacts.layoutSha256 = "f".repeat(64);
    const forged = {
      ...withoutFingerprint,
      verificationFingerprint: hashCanonicalValue(withoutFingerprint)
    };
    const forgedBytes = pretty(forged);
    writePrivate(attestationPath, forgedBytes);
    writePrivate(selfConsistentForgery.verifierOutputPath, forgedBytes);
    plan.upstreamVerificationAttestation.sha256 = sha256(forgedBytes);
    writePrivate(selfConsistentForgery.input.bridgePlanPath, pretty(plan));
    expect(() => prepare(selfConsistentForgery)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_ATTESTATION_MISMATCH"
    );
  });

  it("人工 XML 行映射、source binding 与 task contentHash 任一错配都拒绝", () => {
    const mappingMismatch = createBridgeFixture("mapping-mismatch");
    rewriteBridgeInput(mappingMismatch, "case-0001.mapping.private.json", (value) => ({
      ...value,
      sourceRowNumber: 999
    }), "case-upstream-dev", "humanMapping");
    expect(() => prepare(mappingMismatch)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_CASE_BINDING_MISMATCH"
    );

    const sourceMismatch = createBridgeFixture("source-mismatch");
    writePrivate(
      join(sourceMismatch.materialized, "sources", "source-000001.md"),
      Buffer.from("different source")
    );
    expect(() => prepare(sourceMismatch)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_MATERIALIZATION_INVALID"
    );

    const taskMismatch = createBridgeFixture("task-mismatch");
    rewriteBridgeInput(taskMismatch, "case-0001.task.private.json", (value) => ({
      ...value,
      problem: { ...value.problem, contentHash: "f".repeat(64) }
    }), "case-upstream-dev", "taskDraft");
    expect(() => prepare(taskMismatch)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_CASE_BINDING_MISMATCH"
    );

    const coordinatedSelfReport = createBridgeFixture("coordinated-fake-hash");
    const taskPath = join(
      coordinatedSelfReport.bridgeInput,
      "case-0001.task.private.json"
    );
    const anklangPath = join(
      coordinatedSelfReport.bridgeInput,
      "case-0001.anklang.private.json"
    );
    const mappingPath = join(
      coordinatedSelfReport.bridgeInput,
      "case-0001.mapping.private.json"
    );
    const fakeHash = "f".repeat(64);
    const changedTaskBytes = pretty((() => {
      const value = readJson(taskPath);
      return { ...value, problem: { ...value.problem, contentHash: fakeHash } };
    })());
    writePrivate(taskPath, changedTaskBytes);
    const changedAnklangBytes = pretty({
      ...readJson(anklangPath),
      contentHash: fakeHash
    });
    writePrivate(anklangPath, changedAnklangBytes);
    const changedMappingBytes = pretty({
      ...readJson(mappingPath),
      taskDraftSha256: sha256(changedTaskBytes),
      problemContentHash: fakeHash
    });
    writePrivate(mappingPath, changedMappingBytes);
    const bridgePlan = readJson(coordinatedSelfReport.input.bridgePlanPath);
    const developmentCase = bridgePlan.cases.find(
      (entry: { caseId: string }) => entry.caseId === "case-upstream-dev"
    );
    if (developmentCase === undefined) throw new Error("TEST_PLAN_CASE_MISSING");
    developmentCase.taskDraft.sha256 = sha256(changedTaskBytes);
    developmentCase.originalAnklangResponse.sha256 = sha256(changedAnklangBytes);
    developmentCase.humanMapping.sha256 = sha256(changedMappingBytes);
    writePrivate(coordinatedSelfReport.input.bridgePlanPath, pretty(bridgePlan));
    expect(() => prepare(coordinatedSelfReport)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_CASE_BINDING_MISMATCH"
    );
  });

  it("只接受 complete 且 contentHash 一致的原始 Anklang v2；输出候选不丢失不重排", () => {
    const incomplete = createBridgeFixture("anklang-incomplete");
    rewriteBridgeInput(incomplete, "case-0001.anklang.private.json", (value) => ({
      ...value,
      completion: {
        status: "partial",
        reasonCode: "search_partial",
        retryable: false
      }
    }), "case-upstream-dev", "originalAnklangResponse");
    expect(() => prepare(incomplete)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_INVALID"
    );

    const contentMismatch = createBridgeFixture("anklang-content-mismatch");
    rewriteBridgeInput(
      contentMismatch,
      "case-0001.anklang.private.json",
      (value) => ({ ...value, contentHash: "e".repeat(64) }),
      "case-upstream-dev",
      "originalAnklangResponse"
    );
    expect(() => prepare(contentMismatch)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_CASE_BINDING_MISMATCH"
    );

    const success = createBridgeFixture("candidate-order");
    const result = prepare(success);
    const dataset = loadReviewFlowEvaluationDataset({
      manifestPath: result.manifestPath,
      mode: "development_identity",
      privateRoot: success.privateRoot,
      containingWorkspace: success.workspace
    });
    const data = dataset.cases[0]?.task.reviewItems[0]?.data as {
      candidates?: unknown[];
    } | undefined;
    expect(data?.candidates).toEqual(success.developmentCandidates);
  });

  it("development/holdout nonce 必须独立且恰为 256 bit", () => {
    const repeated = createBridgeFixture("nonce-repeat");
    expect(() => prepareReviewFlowEvaluationDatasetBridge({
      ...repeated.input,
      randomBytes: () => Buffer.alloc(32, 7)
    })).toThrow("REVIEW_FLOW_EVALUATION_BRIDGE_NONCE_REUSE");

    const short = createBridgeFixture("nonce-short");
    expect(() => prepareReviewFlowEvaluationDatasetBridge({
      ...short.input,
      randomBytes: () => Buffer.alloc(31, 1)
    })).toThrow("REVIEW_FLOW_EVALUATION_BRIDGE_RANDOMNESS_INVALID");
  });

  it("completion marker 是最后发布物；marker 前故障留下明确 partial 且不能原地覆盖", () => {
    const fixture = createBridgeFixture("marker-last");
    expect(() => prepareReviewFlowEvaluationDatasetBridge({
      ...fixture.input,
      randomBytes: sequentialRandomBytes(),
      hooks: {
        beforeCompletionMarker: () => {
          throw new Error("synthetic crash");
        }
      }
    })).toThrow("REVIEW_FLOW_EVALUATION_BRIDGE_INPUT_INVALID");
    expect(existsSync(join(fixture.output, "manifest.private.json"))).toBe(true);
    expect(existsSync(join(fixture.output, "REVIEW_FLOW_DATASET_COMPLETE")))
      .toBe(false);
    expect(() => prepare(fixture)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_OUTPUT_EXISTS"
    );
  });

  it("CLI 参数只接受完整显式输入和最多两份原始 review input", () => {
    const validArguments = [
      "--private-root=/private",
      `--fermata-code-version=${"1".repeat(40)}`,
      "--bridge-plan=/private/input/bridge.json",
      "--upstream-gold=/private/upstream",
      "--materialized=/private/materialized",
      "--worksheet=/private/worksheet.json",
      "--worksheet-completion=/private/REVIEW_WORKSHEET_COMPLETE",
      "--inspection=/private/inspection.json",
      "--layout=/private/layout.json",
      "--upstream-plan=/private/plan.json",
      "--tuning-history=/private/tuning.json",
      "--review-input=/private/old.xml",
      "--review-input=/private/new.xml",
      "--out=/private/output",
      "--development-reveal-out=/private/dev-reveal",
      "--holdout-reveal-out=/private/holdout-reveal"
    ];
    const values = parseReviewFlowDatasetBridgeArguments(validArguments);
    expect(values.reviewInputs).toHaveLength(2);
    expect(values.fermataCodeVersion).toBe("1".repeat(40));
    expect(() => parseReviewFlowDatasetBridgeArguments([])).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_ARGUMENT_INVALID"
    );
    expect(() => parseReviewFlowDatasetBridgeArguments([
      ...Array.from({ length: 3 }, (_, index) =>
        `--review-input=/private/${index}.xml`)
    ])).toThrow("REVIEW_FLOW_EVALUATION_BRIDGE_ARGUMENT_INVALID");
    expect(() => parseReviewFlowDatasetBridgeArguments(
      validArguments.map((argument) => argument.startsWith(
        "--fermata-code-version="
      ) ? "--fermata-code-version=not-a-commit" : argument)
    )).toThrow("REVIEW_FLOW_EVALUATION_BRIDGE_ARGUMENT_INVALID");
  });
});

interface BridgeFixture {
  readonly workspace: string;
  readonly privateRoot: string;
  readonly input: PrepareReviewFlowEvaluationBridgeInput;
  readonly bridgeInput: string;
  readonly upstreamGold: string;
  readonly materialized: string;
  readonly output: string;
  readonly rowEvidenceSha256: string;
  readonly upstreamMarkerSha256: string;
  readonly verifierOutputPath: string;
  readonly generatorRepository: string;
  readonly generatorIdentity: ReturnType<typeof loadEvaluationCodeIdentity>;
  readonly developmentCandidates: readonly unknown[];
}

function createBridgeFixture(seed: string): BridgeFixture {
  const workspace = mkdtempSync(join(tmpdir(), `fermata-bridge-${seed}-`));
  temporaryRoots.push(workspace);
  chmodSync(workspace, 0o700);
  const privateRoot = mkdirPrivate(join(workspace, "private"));
  const rawInputDirectory = mkdirPrivate(join(privateRoot, "raw-inputs"));
  const evidenceInputDirectory = mkdirPrivate(join(privateRoot, "evidence-inputs"));
  const materialized = mkdirPrivate(join(privateRoot, "materialized"));
  const materializedSources = mkdirPrivate(join(materialized, "sources"));
  const upstreamGold = mkdirPrivate(join(privateRoot, "upstream-gold"));
  const upstreamGoldFiles = mkdirPrivate(join(upstreamGold, "gold"));
  const bridgeInput = mkdirPrivate(join(privateRoot, "bridge-input"));
  const generator = createSyntheticFermataGenerator(workspace);

  const rawInputs = [
    Buffer.from(`<Workbook seed="${seed}-old"/>`, "utf8"),
    Buffer.from(`<Workbook seed="${seed}-new"/>`, "utf8")
  ];
  const rawInputPaths = rawInputs.map((bytes, index) => {
    const path = join(rawInputDirectory, `review-${index + 1}.xml`);
    writePrivate(path, bytes);
    return path;
  });
  const inspection = {
    version: 1,
    inputSetSha256: "",
    inputs: rawInputs.map((bytes, index) => ({
      inputId: `input-${String(index + 1).padStart(6, "0")}`,
      inputSha256: sha256(bytes),
      format: "spreadsheetml_xml",
      worksheets: [{
        worksheetId: "worksheet-000001",
        presentRowCount: 2,
        maximumRowNumber: 2,
        maximumColumnNumber: 6
      }]
    }))
  };
  inspection.inputSetSha256 = compactSha256({
    version: 1,
    inputs: inspection.inputs
  });
  const inspectionPath = join(evidenceInputDirectory, "inspection.private.json");
  const inspectionBytes = pretty(inspection);
  writePrivate(inspectionPath, inspectionBytes);
  const layoutPath = join(evidenceInputDirectory, "layout.private.json");
  const layoutBytes = pretty({
    version: 3,
    confirmed: true,
    submitterDifficultyColumnsExcluded: true,
    synthetic: seed
  });
  writePrivate(layoutPath, layoutBytes);

  const sourceDefinitions = [
    {
      sourceId: "source-000001",
      sourcePath: "source-000001.md",
      metadataNumber: "101",
      content: Buffer.from(`synthetic statement and solution ${seed} development`)
    },
    {
      sourceId: "source-000002",
      sourcePath: "source-000002.md",
      metadataNumber: "102",
      content: Buffer.from(`synthetic statement and solution ${seed} holdout`)
    }
  ];
  for (const source of sourceDefinitions) {
    writePrivate(join(materializedSources, source.sourcePath), source.content);
  }
  const sourceConfirmation = {
    version: 1,
    confirmed: true,
    metadataFileSha256: sha256(`metadata-${seed}`),
    mappings: sourceDefinitions.map((source) => ({
      sourcePath: source.sourcePath,
      sourceSha256: sha256(source.content),
      metadataNumber: source.metadataNumber
    }))
  };
  writePrivate(
    join(materialized, "source-confirmation.private.json"),
    pretty(sourceConfirmation)
  );
  const groupingBatchSha256 = sha256(`grouping-${seed}`);
  const materializationReport = {
    version: 2,
    phase: "materialize",
    sourceInventorySha256: sha256(`inventory-${seed}`),
    groupingBatchSha256,
    fragmentCount: 2,
    sourceCount: 2,
    unresolvedItemCount: 0,
    sources: sourceDefinitions.map((source, index) => ({
      groupId: `group-${String(index + 1).padStart(6, "0")}`,
      sourceId: source.sourceId,
      sourceSha256: sha256(source.content),
      fragmentCount: 1,
      byteLength: source.content.byteLength,
      characterCount: source.content.toString("utf8").length,
      status: "ready_for_prepare"
    }))
  };
  writePrivate(join(materialized, "report.json"), pretty(materializationReport));
  const materializationSourceSetSha256 = compactSha256({
    version: 1,
    sources: sourceDefinitions.map((source) => ({
      sourceId: source.sourceId,
      sourceSha256: sha256(source.content),
      byteLength: source.content.byteLength
    }))
  });
  const materializationMarker = {
    version: 2,
    phase: "materialize",
    reportSha256: compactSha256(materializationReport),
    sourceConfirmationSha256: compactSha256(sourceConfirmation),
    sourceSetSha256: materializationSourceSetSha256,
    groupingBatchSha256,
    sourceCount: 2,
    fragmentCount: 2,
    unresolvedItemCount: 0
  };
  const materializationMarkerBytes = pretty(materializationMarker);
  writePrivate(join(materialized, "MATERIALIZE_COMPLETE"), materializationMarkerBytes);

  const rowDefinitions = [
    {
      rowId: "review-row-000001",
      inputId: "input-000001",
      worksheetId: "worksheet-000001",
      sourceRowNumber: 2,
      metadataNumber: "101",
      identityValues: ["synthetic-development"],
      finalDecisionText: "synthetic rejected",
      contestUseText: "synthetic not used",
      reviewComments: ["synthetic style concern"],
      reviewCommentPresent: true
    },
    {
      rowId: "review-row-000002",
      inputId: "input-000002",
      worksheetId: "worksheet-000001",
      sourceRowNumber: 2,
      metadataNumber: "102",
      identityValues: ["synthetic-holdout"],
      finalDecisionText: "",
      contestUseText: "",
      reviewComments: [""],
      reviewCommentPresent: false
    }
  ];
  const rows = rowDefinitions.map((row) => ({
    ...row,
    rowEvidenceSha256: compactSha256({
      version: 1,
      inputId: row.inputId,
      worksheetId: row.worksheetId,
      sourceRowNumber: row.sourceRowNumber,
      metadataNumber: row.metadataNumber,
      identityValues: row.identityValues,
      finalDecisionText: row.finalDecisionText,
      contestUseText: row.contestUseText,
      reviewComments: row.reviewComments,
      reviewCommentPresent: row.reviewCommentPresent
    })
  }));
  const worksheet = {
    version: 1,
    inputSetSha256: inspection.inputSetSha256,
    inspectionFileSha256: sha256(inspectionBytes),
    layoutFileSha256: sha256(layoutBytes),
    sourceConfirmationSha256: compactSha256(sourceConfirmation),
    materializationCompleteSha256: sha256(materializationMarkerBytes),
    rows,
    sources: sourceDefinitions.map((source) => ({
      sourceId: source.sourceId,
      sourcePath: source.sourcePath,
      sourceSha256: sha256(source.content),
      metadataNumber: source.metadataNumber
    }))
  };
  const worksheetPath = join(evidenceInputDirectory, "worksheet.private.json");
  const worksheetBytes = pretty(worksheet);
  writePrivate(worksheetPath, worksheetBytes);
  const worksheetCompletion = {
    version: 1,
    phase: "review_gold_worksheet",
    worksheetSha256: sha256(worksheetBytes),
    planSkeletonSha256: sha256(`plan-skeleton-${seed}`),
    tuningHistorySkeletonSha256: sha256(`tuning-skeleton-${seed}`),
    rowCount: rows.length,
    sourceCount: sourceDefinitions.length,
    reviewCommentRowCount: rows.filter((entry) => entry.reviewCommentPresent).length
  };
  const worksheetCompletionPath = join(
    evidenceInputDirectory,
    "REVIEW_WORKSHEET_COMPLETE"
  );
  const worksheetCompletionBytes = pretty(worksheetCompletion);
  writePrivate(worksheetCompletionPath, worksheetCompletionBytes);

  const upstreamCases = [
    {
      caseId: "case-upstream-dev",
      subjectId: "subject-synthetic-development",
      rowId: rows[0]!.rowId,
      sourceId: sourceDefinitions[0]!.sourceId,
      sourceSha256: sha256(sourceDefinitions[0]!.content),
      purpose: "development",
      evaluationScope: "verdict_and_taste",
      verdict: "rejected",
      contestUse: "not_used",
      confirmed: true
    },
    {
      caseId: "case-upstream-hold",
      subjectId: "subject-synthetic-holdout",
      rowId: rows[1]!.rowId,
      sourceId: sourceDefinitions[1]!.sourceId,
      sourceSha256: sha256(sourceDefinitions[1]!.content),
      purpose: "holdout",
      evaluationScope: "originality_only",
      sameProblemAsExisting: true,
      confirmed: true
    }
  ];
  const upstreamPlan = {
    version: 3,
    confirmed: true,
    submitterDifficultyColumnsExcludedReconfirmed: true,
    datasetId: `history-${safeToken(seed)}`,
    worksheetSha256: sha256(worksheetBytes),
    sourceConfirmationSha256: compactSha256(sourceConfirmation),
    cases: upstreamCases
  };
  const upstreamPlanPath = join(evidenceInputDirectory, "upstream-plan.private.json");
  const upstreamPlanBytes = pretty(upstreamPlan);
  writePrivate(upstreamPlanPath, upstreamPlanBytes);
  const tuningHistory = {
    version: 1,
    confirmedComplete: true,
    developmentSamples: []
  };
  const tuningHistoryPath = join(evidenceInputDirectory, "tuning.private.json");
  const tuningHistoryBytes = pretty(tuningHistory);
  writePrivate(tuningHistoryPath, tuningHistoryBytes);

  const upstreamGoldValues = [
    {
      version: 2,
      artifactKind: "historical_review_gold",
      caseId: upstreamCases[0]!.caseId,
      reviewCommentPresent: true,
      evaluationScope: "verdict_and_taste",
      verdict: "rejected",
      contestUse: "not_used"
    },
    {
      version: 2,
      artifactKind: "historical_review_gold",
      caseId: upstreamCases[1]!.caseId,
      reviewCommentPresent: false,
      evaluationScope: "originality_only",
      sameProblemAsExisting: true
    }
  ];
  const upstreamGoldBytes = upstreamGoldValues.map(pretty);
  upstreamGoldBytes.forEach((bytes, index) => {
    writePrivate(
      join(upstreamGoldFiles, `${upstreamCases[index]!.caseId}.json`),
      bytes
    );
  });
  const evidenceEntries = upstreamCases.map((entry, index) => ({
    caseId: entry.caseId,
    purpose: entry.purpose,
    evaluationScope: entry.evaluationScope,
    materializedSourceSha256: entry.sourceSha256,
    goldFile: `gold/${entry.caseId}.json`,
    goldSha256: sha256(upstreamGoldBytes[index]!)
  }));
  const evidence = {
    version: 1,
    artifactKind: "historical_review_gold_evidence",
    datasetId: upstreamPlan.datasetId,
    entries: evidenceEntries
  };
  const evidenceBytes = pretty(evidence);
  writePrivate(join(upstreamGold, "review-gold-evidence.private.json"), evidenceBytes);
  const bindings = {
    version: 1,
    sourceConfirmationSha256: compactSha256(sourceConfirmation),
    materializationCompleteSha256: sha256(materializationMarkerBytes),
    worksheetSha256: sha256(worksheetBytes),
    cases: upstreamCases.map((entry, index) => ({
      caseId: entry.caseId,
      subjectId: entry.subjectId,
      sourceId: entry.sourceId,
      sourcePath: sourceDefinitions[index]!.sourcePath,
      sourceSha256: entry.sourceSha256,
      rowEvidenceSha256: rows[index]!.rowEvidenceSha256
    }))
  };
  const bindingsBytes = pretty(bindings);
  writePrivate(join(upstreamGold, "source-bindings.private.json"), bindingsBytes);
  const additions = {
    version: 1,
    priorTuningHistorySha256: sha256(tuningHistoryBytes),
    developmentSamples: [{
      subjectId: upstreamCases[0]!.subjectId,
      contentSha256: upstreamCases[0]!.sourceSha256
    }]
  };
  const additionsBytes = pretty(additions);
  writePrivate(
    join(upstreamGold, "tuning-history-additions.private.json"),
    additionsBytes
  );
  const upstreamMarker = {
    version: 1,
    phase: "historical_review_gold_evidence",
    evidenceSha256: sha256(evidenceBytes),
    sourceBindingsSha256: sha256(bindingsBytes),
    tuningHistorySha256: sha256(tuningHistoryBytes),
    tuningHistoryAdditionsSha256: sha256(additionsBytes),
    planSha256: sha256(upstreamPlanBytes),
    goldSetSha256: compactSha256({
      version: 1,
      gold: evidenceEntries.map((entry) => ({
        caseId: entry.caseId,
        goldSha256: entry.goldSha256
      }))
    }),
    caseCount: 2,
    developmentCount: 1,
    holdoutCount: 1,
    verdictAndTasteCount: 1,
    originalityOnlyCount: 1
  };
  const upstreamMarkerBytes = pretty(upstreamMarker);
  writePrivate(join(upstreamGold, "REVIEW_GOLD_COMPLETE"), upstreamMarkerBytes);

  const catalog = {
    schemaVersion: 1,
    version: 7,
    tags: [{
      id: "tag-basic",
      name: "基础",
      categoryId: "category-basic",
      categoryName: "基础",
      description: "synthetic tag",
      aliases: [],
      active: true as const
    }]
  };
  const catalogBytes = pretty(catalog);
  writePrivate(join(bridgeInput, "tag-catalog.private.json"), catalogBytes);

  const developmentCandidates = [
    {
      source: "synthetic-a",
      externalId: "A-1",
      title: "Synthetic A",
      similarity: 0.91,
      sameProblemSuggestion: true,
      explanation: "synthetic first"
    },
    {
      source: "synthetic-b",
      externalId: "B-2",
      title: "Synthetic B",
      similarity: 0.42,
      sameProblemSuggestion: false,
      explanation: "synthetic second"
    }
  ];
  const bridgeCases = upstreamCases.map((entry, index) => {
    const safeId = index === 0 ? "case-0001" : "case-9001";
    const hashInput = problemHashInput(index + 1);
    const contentHash = computeUrmotivProblemContentHash(hashInput);
    const hashInputBytes = pretty(hashInput);
    const hashInputFileName = `${safeId}.problem-hash-input.private.json`;
    writePrivate(join(bridgeInput, hashInputFileName), hashInputBytes);
    const task = taskDraft(index + 1, contentHash, catalog, hashInput);
    const taskBytes = pretty(task);
    const taskFileName = `${safeId}.task.private.json`;
    writePrivate(join(bridgeInput, taskFileName), taskBytes);
    const candidates = index === 0 ? developmentCandidates : [];
    const anklang = {
      apiVersion: "2",
      contentHash,
      checkedAt: "2026-08-01T00:00:00.000Z",
      candidates,
      recommendation: {
        blockSubmission: index === 0,
        message: index === 0 ? "synthetic candidate" : "synthetic none"
      },
      completion: {
        status: "complete",
        reasonCode: "complete",
        retryable: false
      },
      reuse: {
        policy: "allowed",
        expiresAt: "2026-08-02T00:00:00.000Z"
      }
    };
    const anklangBytes = pretty(anklang);
    const anklangFileName = `${safeId}.anklang.private.json`;
    writePrivate(join(bridgeInput, anklangFileName), anklangBytes);
    const mapping = index === 0
      ? {
          schemaVersion: 1,
          artifactKind: "review_flow_evaluation_human_mapping",
          confirmed: true,
          caseId: entry.caseId,
          safeId,
          subjectId: entry.subjectId,
          purpose: entry.purpose,
          sourceId: entry.sourceId,
          sourceSha256: entry.sourceSha256,
          rowEvidenceSha256: rows[index]!.rowEvidenceSha256,
          reviewInputId: rows[index]!.inputId,
          worksheetId: rows[index]!.worksheetId,
          sourceRowNumber: rows[index]!.sourceRowNumber,
          taskDraftSha256: sha256(taskBytes),
          problemHashInputSha256: sha256(hashInputBytes),
          problemContentHash: contentHash,
          statementSolutionBoundary:
            "independently_human_confirmed_from_materialized_source",
          evaluationScope: "verdict_and_taste",
          historicalReviewReasonMapping:
            "independently_human_confirmed_from_bound_review_row",
          observedHistoricalTasteReasons: [{
            dimension: "icpc_fit",
            direction: "concern"
          }],
          observedHistoricalTechnicalReasons: [],
          independentVerdict: {
            annotation: "independent_human_three_way",
            verdict: "reject"
          },
          expectedTagIds: ["tag-basic"]
        }
      : {
          schemaVersion: 1,
          artifactKind: "review_flow_evaluation_human_mapping",
          confirmed: true,
          caseId: entry.caseId,
          safeId,
          subjectId: entry.subjectId,
          purpose: entry.purpose,
          sourceId: entry.sourceId,
          sourceSha256: entry.sourceSha256,
          rowEvidenceSha256: rows[index]!.rowEvidenceSha256,
          reviewInputId: rows[index]!.inputId,
          worksheetId: rows[index]!.worksheetId,
          sourceRowNumber: rows[index]!.sourceRowNumber,
          taskDraftSha256: sha256(taskBytes),
          problemHashInputSha256: sha256(hashInputBytes),
          problemContentHash: contentHash,
          statementSolutionBoundary:
            "independently_human_confirmed_from_materialized_source",
          evaluationScope: "originality_only",
          originalityAnnotation: "confirmed_duplicate_evidence",
          confirmedDuplicate: true
        };
    const mappingBytes = pretty(mapping);
    const mappingFileName = `${safeId}.mapping.private.json`;
    writePrivate(join(bridgeInput, mappingFileName), mappingBytes);
    return {
      caseId: entry.caseId,
      safeId,
      subjectId: entry.subjectId,
      purpose: entry.purpose,
      sourceId: entry.sourceId,
      sourceSha256: entry.sourceSha256,
      rowEvidenceSha256: rows[index]!.rowEvidenceSha256,
      taskDraft: { fileName: taskFileName, sha256: sha256(taskBytes) },
      problemHashInput: {
        fileName: hashInputFileName,
        sha256: sha256(hashInputBytes)
      },
      originalAnklangResponse: {
        fileName: anklangFileName,
        sha256: sha256(anklangBytes)
      },
      humanMapping: {
        fileName: mappingFileName,
        sha256: sha256(mappingBytes)
      }
    };
  });
  const verifier = createSyntheticVerifier(workspace);
  const attestationWithoutFingerprint = {
    schemaVersion: 1,
    artifactKind: "urmotiv_review_gold_verification_attestation",
    protocolVersion: "urmotiv-review-gold-verify-sealed-v1",
    verificationStatus: "complete",
    upstreamDatasetId: upstreamPlan.datasetId,
    verifier: {
      repository: "Urmotiv",
      codeVersion: verifier.identity.codeVersion,
      runnerPath: "scripts/migrate-hist/prepare-review-gold.py",
      runnerSha256: verifier.identity.runnerSha256,
      dependencyCodeSha256: verifier.identity.dependencyCodeSha256,
      dependencyFileCount: 2
    },
    artifacts: {
      reviewGoldCompleteSha256: sha256(upstreamMarkerBytes),
      evidenceSha256: sha256(evidenceBytes),
      sourceBindingsSha256: sha256(bindingsBytes),
      tuningHistorySha256: sha256(tuningHistoryBytes),
      tuningHistoryAdditionsSha256: sha256(additionsBytes),
      planSha256: sha256(upstreamPlanBytes),
      worksheetSha256: sha256(worksheetBytes),
      worksheetCompletionSha256: sha256(worksheetCompletionBytes),
      inspectionSha256: sha256(inspectionBytes),
      layoutSha256: sha256(layoutBytes),
      inputSetSha256: inspection.inputSetSha256,
      sourceConfirmationCanonicalSha256: compactSha256(sourceConfirmation),
      materializationCompleteSha256: sha256(materializationMarkerBytes),
      materializationReportCanonicalSha256:
        compactSha256(materializationReport),
      materializationSourceSetSha256
    },
    reviewInputs: inspection.inputs.map((entry) => ({
      inputId: entry.inputId,
      format: entry.format,
      inputSha256: entry.inputSha256
    })),
    cases: upstreamCases.map((entry, index) => ({
      caseId: entry.caseId,
      subjectId: entry.subjectId,
      purpose: entry.purpose,
      evaluationScope: entry.evaluationScope,
      sourceId: entry.sourceId,
      sourcePath: sourceDefinitions[index]!.sourcePath,
      sourceSha256: entry.sourceSha256,
      rowEvidenceSha256: rows[index]!.rowEvidenceSha256,
      goldSha256: evidenceEntries[index]!.goldSha256
    })),
    counts: {
      caseCount: 2,
      developmentCount: 1,
      holdoutCount: 1,
      verdictAndTasteCount: 1,
      originalityOnlyCount: 1,
      reviewInputCount: 2,
      materializedSourceCount: 2
    }
  };
  const attestation = {
    ...attestationWithoutFingerprint,
    verificationFingerprint: hashCanonicalValue(attestationWithoutFingerprint)
  };
  const attestationBytes = pretty(attestation);
  const attestationFileName = "upstream-attestation.private.json";
  writePrivate(join(bridgeInput, attestationFileName), attestationBytes);
  writePrivate(verifier.outputPath, attestationBytes);
  const bridgePlan = {
    schemaVersion: 2,
    artifactKind: "review_flow_evaluation_bridge_plan",
    bridgeVersion: "urmotiv-review-flow-bridge-v2",
    confirmed: true,
    upstreamDatasetId: upstreamPlan.datasetId,
    datasetId: `dataset-${sha256(seed).slice(0, 16)}`,
    tagCatalog: {
      fileName: "tag-catalog.private.json",
      sha256: sha256(catalogBytes)
    },
    upstreamVerificationAttestation: {
      fileName: attestationFileName,
      sha256: sha256(attestationBytes)
    },
    holdoutRegistration: {
      baselineLabel: `baseline-${safeToken(seed)}`,
      candidateLabel: `candidate-${safeToken(seed)}`,
      thresholdPolicySha256: sha256(`threshold-${seed}`)
    },
    cases: bridgeCases
  };
  const bridgePlanPath = join(bridgeInput, "bridge-plan.private.json");
  writePrivate(bridgePlanPath, pretty(bridgePlan));

  const output = join(privateRoot, "output");
  const developmentReveal = join(privateRoot, "development-reveal");
  const holdoutReveal = join(privateRoot, "holdout-reveal");
  return {
    workspace,
    privateRoot,
    bridgeInput,
    upstreamGold,
    materialized,
    output,
    rowEvidenceSha256: rows[0]!.rowEvidenceSha256,
    upstreamMarkerSha256: sha256(upstreamMarkerBytes),
    verifierOutputPath: verifier.outputPath,
    generatorRepository: generator.repository,
    generatorIdentity: generator.identity,
    developmentCandidates,
    input: {
      privateRoot,
      containingWorkspace: workspace,
      fermataCodeVersion: generator.identity.codeVersion,
      bridgePlanPath,
      upstreamGoldDirectory: upstreamGold,
      materializedDirectory: materialized,
      worksheetPath,
      worksheetCompletionPath,
      inspectionPath,
      layoutPath,
      upstreamPlanPath,
      tuningHistoryPath,
      reviewInputPaths: rawInputPaths,
      outputDirectory: output,
      developmentRevealDirectory: developmentReveal,
      holdoutRevealDirectory: holdoutReveal
    }
  };
}

function taskDraft(
  index: number,
  contentHash: string,
  catalog: { version: number; tags: RobotReviewTask["tagCatalog"]["tags"] },
  hashInput: ReturnType<typeof problemHashInput>
): RobotReviewTask {
  const suffix = String(index).padStart(12, "0");
  return {
    assignmentId: `10000000-0000-4000-8000-${suffix}`,
    leaseExpiresAt: "2099-08-01T00:00:00.000Z",
    problem: {
      id: `synthetic-problem-${index}`,
      revision: 1,
      reviewRound: 1,
      contentHash,
      title: hashInput.title,
      type: hashInput.type,
      tagIds: hashInput.tagIds,
      content: hashInput.content,
      samples: hashInput.samples.map((sample, sampleIndex) => ({
        safeId: `sample-${String(sampleIndex + 1).padStart(3, "0")}`,
        input: sample.input,
        output: sample.output,
        explanation: sample.explanation
      })),
      limits: hashInput.judgeConfig.limits
    },
    tagCatalog: { version: catalog.version, tags: [...catalog.tags] },
    reviewItems: []
  };
}

function problemHashInput(index: number) {
  return {
    schemaVersion: 1 as const,
    artifactKind: "urmotiv_problem_content_hash_input" as const,
    title: `Synthetic ${index}`,
    type: "traditional" as const,
    tagIds: ["tag-basic"],
    codeforcesDifficulty: null,
    thinkingLevel: null,
    codingLevel: null,
    content: {
      basicStatement: `Synthetic statement ${index}`,
      basicSolution: `Synthetic solution ${index}`,
      background: "",
      statement: "",
      inputFormat: "",
      outputFormat: "",
      constraints: "",
      solution: "",
      hints: ""
    },
    samples: [] as {
      id: string;
      input: string;
      output: string;
      explanation: string;
    }[],
    judgeConfig: {
      version: 1 as const,
      limits: { timeMs: 1_000, memoryMiB: 256 },
      scoring: { total: 100, subtaskMode: "sum" as const },
      subtasks: [],
      testcases: []
    },
    status: "pending_review" as const
  };
}

function rewriteBridgeInput(
  fixture: BridgeFixture,
  fileName: string,
  update: (value: Record<string, any>) => Record<string, any>,
  caseId: string,
  bindingKey: "humanMapping" | "taskDraft" | "originalAnklangResponse"
): void {
  const path = join(fixture.bridgeInput, fileName);
  const changedBytes = pretty(update(readJson(path)));
  writePrivate(path, changedBytes);
  const planPath = fixture.input.bridgePlanPath;
  const plan = readJson(planPath);
  const target = plan.cases.find((entry: { caseId: string }) => entry.caseId === caseId);
  if (target === undefined) throw new Error("TEST_PLAN_CASE_MISSING");
  target[bindingKey].sha256 = sha256(changedBytes);
  writePrivate(planPath, pretty(plan));
}

function prepare(fixture: BridgeFixture) {
  return prepareReviewFlowEvaluationDatasetBridge({
    ...fixture.input,
    randomBytes: sequentialRandomBytes()
  });
}

function sequentialRandomBytes(): (size: number) => Uint8Array {
  let call = 0;
  return (size) => Buffer.alloc(size, ++call);
}

function createSyntheticFermataGenerator(workspace: string) {
  const repository = join(workspace, "Fermata");
  for (const path of reviewFlowEvaluationCodePaths) {
    const absolutePath = join(repository, path);
    mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
    writeFileSync(absolutePath, `synthetic generator dependency: ${path}\n`, {
      mode: 0o600
    });
  }
  execFileSync("/usr/bin/git", ["init", "-q"], { cwd: repository });
  execFileSync("/usr/bin/git", ["add", "."], { cwd: repository });
  execFileSync(
    "/usr/bin/git",
    [
      "-c",
      "user.name=Synthetic Test",
      "-c",
      "user.email=synthetic@example.invalid",
      "commit",
      "-q",
      "-m",
      "synthetic generator"
    ],
    { cwd: repository }
  );
  const codeVersion = execFileSync(
    "/usr/bin/git",
    ["rev-parse", "HEAD"],
    { cwd: repository, encoding: "utf8" }
  ).trim();
  const identity = loadEvaluationCodeIdentity({
    repositoryDirectory: repository,
    expectedCodeVersion: codeVersion,
    runnerPath: "experiments/prepare-review-flow-dataset.ts",
    dependencyPaths: reviewFlowEvaluationCodePaths
  });
  return { repository, identity };
}

function createSyntheticVerifier(workspace: string) {
  const repository = join(workspace, "Urmotiv");
  mkdirSync(join(repository, "scripts", "migrate-hist"), {
    recursive: true,
    mode: 0o700
  });
  writeFileSync(
    join(repository, ".gitignore"),
    ".synthetic-attestation-output\n",
    { mode: 0o600 }
  );
  writeFileSync(
    join(repository, "scripts", "migrate-hist", "prepare-review-gold.py"),
    [
      "from pathlib import Path",
      "import sys",
      "if len(sys.argv) < 2 or sys.argv[1] != 'verify-sealed':",
      "    raise SystemExit(2)",
      "sys.stdout.buffer.write(Path('.synthetic-attestation-output').read_bytes())",
      ""
    ].join("\n"),
    { mode: 0o600 }
  );
  writeFileSync(
    join(repository, "scripts", "migrate-hist", "parse-metadata.py"),
    "# synthetic trusted dependency\n",
    { mode: 0o600 }
  );
  execFileSync("/usr/bin/git", ["init", "-q"], { cwd: repository });
  execFileSync("/usr/bin/git", ["add", "."], { cwd: repository });
  execFileSync(
    "/usr/bin/git",
    [
      "-c",
      "user.name=Synthetic Test",
      "-c",
      "user.email=synthetic@example.invalid",
      "commit",
      "-q",
      "-m",
      "synthetic verifier"
    ],
    { cwd: repository }
  );
  const codeVersion = execFileSync(
    "/usr/bin/git",
    ["rev-parse", "HEAD"],
    { cwd: repository, encoding: "utf8" }
  ).trim();
  const identity = loadEvaluationCodeIdentity({
    repositoryDirectory: repository,
    expectedCodeVersion: codeVersion,
    runnerPath: "scripts/migrate-hist/prepare-review-gold.py",
    dependencyPaths: [
      "scripts/migrate-hist/prepare-review-gold.py",
      "scripts/migrate-hist/parse-metadata.py"
    ]
  });
  return {
    identity,
    outputPath: join(repository, ".synthetic-attestation-output")
  };
}

function mkdirPrivate(path: string): string {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function writePrivate(path: string, bytes: Buffer): void {
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function pretty(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function compactSha256(value: unknown): string {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").slice(0, 24);
}
