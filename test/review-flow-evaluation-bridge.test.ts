import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  globSync,
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
  reviewFlowEvaluationAnklangCaptureSetSha256,
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
  it("验证完整上游链，排除赛后 Anklang 自匹配，并以不含 Gold oracle 的 v4 manifest 发布", () => {
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
      evaluationScope: "verdict_and_taste",
      historicalOutcome: "accepted",
      contestUse: "used"
    });

    const task = developmentIdentity.cases[0]?.task;
    expect(task?.reviewItems).toEqual([]);

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
      ...Object.entries(entry.upstreamEvidence.bridgeEvidence)
        .filter(([key, value]) =>
          key !== "anklangResponseSha256" &&
          /^[a-f0-9]{64}$/u.test(value)
        )
        .map(([, value]) => value)
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
    expect(manifest).toMatchObject({
      schemaVersion: 4,
      anklangInputPolicy:
        "exclude_current_corpus_for_historical_outcome",
      placeholderTagIds: ["tag-basic"]
    });
    expect(developmentIdentity.placeholderTagIds).toEqual(["tag-basic"]);
    expect(holdoutPrediction.placeholderTagIds).toEqual(["tag-basic"]);
    for (const descriptor of [
      ...manifest.partitions.development.cases,
      ...manifest.partitions.holdout.cases
    ]) {
      expect(descriptor).not.toHaveProperty("anklangInputPolicy");
      expect(descriptor).not.toHaveProperty("evaluationScope");
    }
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
    expect(completion.placeholderTagIds).toEqual(["tag-basic"]);
    const bridgePlan = readJson(fixture.input.bridgePlanPath);
    const planCase = bridgePlan.cases[0];
    const sourceBindings = readJson(
      join(fixture.upstreamGold, "source-bindings.private.json")
    );
    const sourceBinding = sourceBindings.cases[0];
    const mapping = readJson(join(
      fixture.bridgeInput,
      planCase.sourceMapping.fileName
    ));
    const prediction = manifest.partitions.development.cases[0];
    const generatedTask = readJson(join(fixture.output, prediction.content.fileName));
    expect(prediction.sourceLineageSha256).toBe(hashCanonicalValue({
      protocol: "review-flow-evaluation-source-lineage-v6",
      bridgeVersion: "urmotiv-review-flow-bridge-v4",
      generator: expectedGenerator,
      identity: {
        upstreamCaseId: planCase.caseId,
        subjectId: planCase.subjectId
      },
      source: {
        sourceId: planCase.sourceId,
        sourcePath: sourceBinding.sourcePath,
        materializedSourceSha256: planCase.sourceSha256,
        projection: {
          method: mapping.sourceProjection.method,
          statement: mapping.sourceProjection.statement,
          solution: mapping.sourceProjection.solution,
          titleIdentityValueIndex: mapping.titleIdentityValueIndex
        },
        taskMetadata: {
          problemType: generatedTask.problem.type,
          problemTypeBasis: mapping.problemTypeBasis,
          currentTagIds: mapping.placeholderTagIds,
          currentTagIdsBasis: mapping.currentTagIdsBasis
        }
      },
      task: {
        taskDraftSha256: planCase.taskDraft.sha256,
        problemHashInputSha256: planCase.problemHashInput.sha256,
        problemContentHash: generatedTask.problem.contentHash,
        outputContentSha256: prediction.content.sha256,
        originalAnklangRequestSha256:
          planCase.originalAnklangRequest.sha256,
        originalAnklangResponseSha256:
          planCase.originalAnklangResponse.sha256
      },
      anklangCapture: {
        attestationSha256:
          bridgePlan.anklangCaptureAttestation.sha256,
        completionSha256:
          bridgePlan.anklangCaptureCompletion.sha256,
        corpusEvidenceKind: "remote_corpus_unverifiable",
        inputPolicy:
          "exclude_current_corpus_for_historical_outcome",
        reviewItemInjected: false
      }
    }));
  });

  it("历史结果排除策略要求整批都是 verdict_and_taste，混合 scope 在发布前拒绝", () => {
    const mixed = createBridgeFixture("mixed-evaluation-scope", {
      holdoutEvaluationScope: "originality_only"
    });
    expect(() => prepare(mixed)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_INPUT_POLICY_SCOPE_INVALID"
    );
  });

  it("整批只能使用同一组占位标签，两题不一致时在创建任何发布目录前拒绝", () => {
    const fixture = createBridgeFixture("placeholder-batch-mismatch", {
      secondPlaceholderTagIds: ["tag-other"]
    });
    expect(() => prepare(fixture)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_PLACEHOLDER_TAGS_MISMATCH"
    );
    expect(existsSync(fixture.output)).toBe(false);
    expect(existsSync(fixture.input.developmentRevealDirectory)).toBe(false);
    expect(existsSync(fixture.input.holdoutRevealDirectory!)).toBe(false);
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

    const captureChangedDuringRun = createBridgeFixture(
      "capture-changed-during-run"
    );
    expect(() => prepareReviewFlowEvaluationDatasetBridge({
      ...captureChangedDuringRun.input,
      randomBytes: sequentialRandomBytes(),
      hooks: {
        beforeCompletionMarker: () => {
          writeFileSync(
            join(
              captureChangedDuringRun.capturerRepository,
              "anklang",
              "review_flow_capture.py"
            ),
            "changed while publishing\n"
          );
        }
      }
    })).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_CAPTURER_IDENTITY_INVALID"
    );
    expect(existsSync(join(
      captureChangedDuringRun.output,
      "REVIEW_FLOW_DATASET_COMPLETE"
    ))).toBe(false);
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

  it("hardened bridge 忽略默认 importer 会执行的 unchecked-hash pyc，且不改写仓库 bytecode", () => {
    const fixture = createBridgeFixture("unchecked-hash-pyc");
    const anklangRepository = fixture.capturerRepository;
    const urmotivRepository = join(fixture.workspace, "Urmotiv");
    const anklangMarker = join(fixture.workspace, "anklang-malicious.marker");
    const urmotivMarker = join(fixture.workspace, "urmotiv-malicious.marker");
    installUncheckedHashPyc(
      join(anklangRepository, "anklang", "review_flow_capture.py"),
      anklangMarker
    );
    installUncheckedHashPyc(
      join(
        urmotivRepository,
        "scripts",
        "migrate-hist",
        "parse-metadata.py"
      ),
      urmotivMarker
    );

    const captureManifest = readJson(fixture.captureVerifierManifestPath);
    const defaultAnklangStdout = execFileSync(
      "/usr/bin/python3",
      [
        join(
          anklangRepository,
          "scripts",
          "capture-review-flow-calibration.py"
        ),
        "verify-capture",
        "--workspace",
        captureManifest.workspace,
        "--manifest",
        fixture.captureVerifierManifestPath,
        "--verifier-code-version",
        captureManifest.verifierCodeVersion,
        "--verifier-runner-sha256",
        captureManifest.verifierRunnerSha256,
        "--verifier-dependency-code-sha256",
        captureManifest.verifierDependencyCodeSha256
      ],
      { cwd: anklangRepository, encoding: "buffer" }
    );
    expect(defaultAnklangStdout).toEqual(
      readFileSync(fixture.captureVerifierAttestationPath)
    );
    expect(existsSync(anklangMarker)).toBe(true);

    const defaultUrmotivStdout = execFileSync(
      "/usr/bin/python3",
      [
        join(
          urmotivRepository,
          "scripts",
          "migrate-hist",
          "prepare-review-gold.py"
        ),
        "verify-sealed"
      ],
      { cwd: urmotivRepository, encoding: "buffer" }
    );
    expect(defaultUrmotivStdout).toEqual(
      readFileSync(fixture.verifierOutputPath)
    );
    expect(existsSync(urmotivMarker)).toBe(true);

    rmSync(anklangMarker);
    rmSync(urmotivMarker);
    const before = {
      anklang: snapshotPycFiles(anklangRepository),
      urmotiv: snapshotPycFiles(urmotivRepository)
    };
    expect(() => prepare(fixture)).not.toThrow();
    expect(existsSync(anklangMarker)).toBe(false);
    expect(existsSync(urmotivMarker)).toBe(false);
    expect(snapshotPycFiles(anklangRepository)).toEqual(before.anklang);
    expect(snapshotPycFiles(urmotivRepository)).toEqual(before.urmotiv);
  }, 30_000);

  it("XML 行来源映射、source binding 与 task contentHash 任一错配都拒绝", () => {
    const mappingMismatch = createBridgeFixture("mapping-mismatch");
    rewriteBridgeInput(mappingMismatch, "case-0001.mapping.private.json", (value) => ({
      ...value,
      sourceRowNumber: 999
    }), "case-upstream-dev", "sourceMapping");
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
    developmentCase.sourceMapping.sha256 = sha256(changedMappingBytes);
    writePrivate(coordinatedSelfReport.input.bridgePlanPath, pretty(bridgePlan));
    expect(() => prepare(coordinatedSelfReport)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_CASE_BINDING_MISMATCH"
    );
  });

  it("稀疏历史理由逐项绑定非空 XML 评论，并去重派生 Gold", () => {
    const invalidIndex = createBridgeFixture("reason-index-missing");
    rewriteBridgeInput(invalidIndex, "case-0001.mapping.private.json", (value) => ({
      ...value,
      observedHistoricalTasteReasonEvidence: [{
        ...value.observedHistoricalTasteReasonEvidence[0],
        reviewCommentIndex: 31
      }]
    }), "case-upstream-dev", "sourceMapping");
    expect(() => prepare(invalidIndex)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_MAPPING_INVALID"
    );

    const emptyComment = createBridgeFixture("reason-index-empty");
    rewriteBridgeInput(emptyComment, "case-0001.mapping.private.json", (value) => ({
      ...value,
      observedHistoricalTasteReasonEvidence: [{
        ...value.observedHistoricalTasteReasonEvidence[0],
        reviewCommentIndex: 1
      }]
    }), "case-upstream-dev", "sourceMapping");
    expect(() => prepare(emptyComment)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_MAPPING_INVALID"
    );

    const derived = createBridgeFixture("reason-derived-unique");
    rewriteBridgeInput(derived, "case-0001.mapping.private.json", (value) => ({
      ...value,
      observedHistoricalTasteReasonEvidence: [
        value.observedHistoricalTasteReasonEvidence[0],
        value.observedHistoricalTasteReasonEvidence[0]
      ],
      observedHistoricalTechnicalReasonEvidence: [{
        reviewCommentIndex: 0,
        reason: "judgeability_concern"
      }]
    }), "case-upstream-dev", "sourceMapping");
    const result = prepare(derived);
    const dataset = loadReviewFlowEvaluationDataset({
      manifestPath: result.manifestPath,
      revealDescriptorPath: result.developmentRevealDescriptorPath,
      mode: "development_scored",
      privateRoot: derived.privateRoot,
      containingWorkspace: derived.workspace
    });
    expect(dataset.cases[0]?.gold).toMatchObject({
      observedHistoricalTasteReasons: [{
        dimension: "icpc_fit",
        direction: "concern"
      }],
      observedHistoricalTechnicalReasons: ["judgeability_concern"]
    });

    const forgedIndependent = createBridgeFixture("reason-independent-forbidden");
    rewriteBridgeInput(
      forgedIndependent,
      "case-0001.mapping.private.json",
      (value) => ({
        ...value,
        independentVerdict: {
          annotation: "independent_human_three_way",
          verdict: "approve"
        }
      }),
      "case-upstream-dev",
      "sourceMapping"
    );
    expect(() => prepare(forgedIndependent)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_MAPPING_INVALID"
    );
  }, 30_000);

  it("四种来源投影方法都接受各自的完整 UTF-8 源结构", () => {
    const headingAndRule = createBridgeFixture("projection-positive-heading-rule", {
      projectionMethods: [
        "markdown_solution_heading_v1",
        "last_horizontal_rule_v1"
      ]
    });
    expect(() => prepare(headingAndRule)).not.toThrow();

    const algorithmAndOperator = createBridgeFixture(
      "projection-positive-algorithm-operator",
      {
        projectionMethods: [
          "algorithm_heading_v1",
          "operator_explicit_offsets_v1"
        ]
      }
    );
    expect(() => prepare(algorithmAndOperator)).not.toThrow();
  }, 30_000);

  it("来源投影拒绝错位、UTF-8 半字符、伪造方法、遗漏首尾和边界夹带正文", () => {
    const wrongOffset = createBridgeFixture("projection-wrong-offset");
    rewriteBridgeInput(wrongOffset, "case-9001.mapping.private.json", (value) => ({
      ...value,
      sourceProjection: {
        ...value.sourceProjection,
        solution: {
          ...value.sourceProjection.solution,
          startByte: value.sourceProjection.solution.startByte + 3
        }
      }
    }), "case-upstream-hold", "sourceMapping");
    expect(() => prepare(wrongOffset)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_CASE_BINDING_MISMATCH"
    );

    const utf8Midpoint = createBridgeFixture("projection-utf8-midpoint");
    rewriteBridgeInput(utf8Midpoint, "case-9001.mapping.private.json", (value) => ({
      ...value,
      sourceProjection: {
        ...value.sourceProjection,
        statement: { ...value.sourceProjection.statement, endByte: 1 }
      }
    }), "case-upstream-hold", "sourceMapping");
    expect(() => prepare(utf8Midpoint)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_SOURCE_PROJECTION_INVALID"
    );

    const titleMisalignment = createBridgeFixture("projection-title-index");
    rewriteBridgeInput(
      titleMisalignment,
      "case-0001.mapping.private.json",
      (value) => ({ ...value, titleIdentityValueIndex: 1 }),
      "case-upstream-dev",
      "sourceMapping"
    );
    expect(() => prepare(titleMisalignment)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_CASE_BINDING_MISMATCH"
    );

    const falseMethod = createBridgeFixture("projection-false-method");
    rewriteBridgeInput(falseMethod, "case-0001.mapping.private.json", (value) => ({
      ...value,
      sourceProjection: {
        ...value.sourceProjection,
        method: "algorithm_heading_v1"
      }
    }), "case-upstream-dev", "sourceMapping");
    expect(() => prepare(falseMethod)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_SOURCE_PROJECTION_INVALID"
    );

    const nonLastHorizontalRule = createBridgeFixture(
      "projection-non-last-horizontal-rule",
      {
        projectionMethods: [
          "last_horizontal_rule_v1",
          "operator_explicit_offsets_v1"
        ],
        solutionSuffixes: ["\r---\rtrailing solution", ""]
      }
    );
    expect(() => prepare(nonLastHorizontalRule)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_SOURCE_PROJECTION_INVALID"
    );

    const omittedPrefix = createBridgeFixture("projection-omitted-prefix");
    rewriteBridgeInput(omittedPrefix, "case-9001.mapping.private.json", (value) => ({
      ...value,
      sourceProjection: {
        ...value.sourceProjection,
        statement: { ...value.sourceProjection.statement, startByte: 3 }
      }
    }), "case-upstream-hold", "sourceMapping");
    expect(() => prepare(omittedPrefix)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_SOURCE_PROJECTION_INVALID"
    );

    const omittedSuffix = createBridgeFixture("projection-omitted-suffix");
    rewriteBridgeInput(omittedSuffix, "case-9001.mapping.private.json", (value) => ({
      ...value,
      sourceProjection: {
        ...value.sourceProjection,
        solution: {
          ...value.sourceProjection.solution,
          endByte: value.sourceProjection.solution.endByte - 1
        }
      }
    }), "case-upstream-hold", "sourceMapping");
    expect(() => prepare(omittedSuffix)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_SOURCE_PROJECTION_INVALID"
    );

    const hiddenGapBody = createBridgeFixture("projection-hidden-gap-body");
    rewriteBridgeInput(hiddenGapBody, "case-0001.mapping.private.json", (value) => ({
      ...value,
      sourceProjection: {
        ...value.sourceProjection,
        statement: {
          ...value.sourceProjection.statement,
          endByte: value.sourceProjection.statement.endByte - 1
        }
      }
    }), "case-upstream-dev", "sourceMapping");
    expect(() => prepare(hiddenGapBody)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_SOURCE_PROJECTION_INVALID"
    );
  }, 20_000);

  it("来源投影拒绝自洽内容伪造和基本题面/题解之外的额外任务内容", () => {
    const forgedStatement = createBridgeFixture("projection-content-forgery");
    rewriteCoherentDevelopmentContent(forgedStatement, (hashInput) => ({
      ...hashInput,
      content: {
        ...hashInput.content,
        basicStatement: `${hashInput.content.basicStatement} forged`
      }
    }));
    expect(() => prepare(forgedStatement)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_CASE_BINDING_MISMATCH"
    );

    const extraContent = createBridgeFixture("projection-extra-content");
    rewriteCoherentDevelopmentContent(extraContent, (hashInput) => ({
      ...hashInput,
      content: { ...hashInput.content, background: "forged background" }
    }));
    expect(() => prepare(extraContent)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_CASE_BINDING_MISMATCH"
    );
  });

  it("标题输入必须已规范化，当前标签只能是目录内明确声明的非 Gold 占位", () => {
    const nonCanonicalTitle = createBridgeFixture("mapping-title-canonical");
    rewriteBridgeInput(
      nonCanonicalTitle,
      "case-0001.task.private.json",
      (value) => ({
        ...value,
        problem: { ...value.problem, title: ` ${value.problem.title} ` }
      }),
      "case-upstream-dev",
      "taskDraft"
    );
    const nonCanonicalPlan = readJson(nonCanonicalTitle.input.bridgePlanPath);
    const nonCanonicalCase = nonCanonicalPlan.cases.find(
      (entry: { caseId: string }) => entry.caseId === "case-upstream-dev"
    );
    if (nonCanonicalCase === undefined) throw new Error("TEST_PLAN_CASE_MISSING");
    rewriteBridgeInput(
      nonCanonicalTitle,
      "case-0001.mapping.private.json",
      (value) => ({
        ...value,
        taskDraftSha256: nonCanonicalCase.taskDraft.sha256
      }),
      "case-upstream-dev",
      "sourceMapping"
    );
    expect(() => prepare(nonCanonicalTitle)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_TASK_INVALID"
    );

    const unboundPlaceholder = createBridgeFixture("mapping-placeholder");
    rewriteCoherentDevelopmentContent(unboundPlaceholder, (hashInput) => ({
      ...hashInput,
      tagIds: ["missing-tag"]
    }));
    expect(() => prepare(unboundPlaceholder)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_PLACEHOLDER_TAGS_MISMATCH"
    );

    const duplicateCatalog = createBridgeFixture("mapping-catalog-duplicate");
    const duplicatePlan = readJson(duplicateCatalog.input.bridgePlanPath);
    const catalogPath = join(
      duplicateCatalog.bridgeInput,
      duplicatePlan.tagCatalog.fileName
    );
    const catalog = readJson(catalogPath);
    const duplicateCatalogBytes = pretty({
      ...catalog,
      tags: [...catalog.tags, { ...catalog.tags[0] }]
    });
    writePrivate(catalogPath, duplicateCatalogBytes);
    duplicatePlan.tagCatalog.sha256 = sha256(duplicateCatalogBytes);
    writePrivate(duplicateCatalog.input.bridgePlanPath, pretty(duplicatePlan));
    expect(() => prepare(duplicateCatalog)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_TAG_CATALOG_INVALID"
    );
  });

  it("所有严格 JSON 输入都拒绝非法 UTF-8，而不做替换字符规范化", () => {
    const fixture = createBridgeFixture("task-invalid-utf8");
    const taskPath = join(fixture.bridgeInput, "case-0001.task.private.json");
    const taskBytes = Buffer.from(readFileSync(taskPath));
    const statementMarker = Buffer.from("题面 Synthetic statement 1", "utf8");
    const statementOffset = taskBytes.indexOf(statementMarker);
    if (statementOffset < 0) throw new Error("TEST_TASK_STATEMENT_MISSING");
    taskBytes[statementOffset + Buffer.from("题面 ", "utf8").byteLength] = 0xff;
    writePrivate(taskPath, taskBytes);

    const plan = readJson(fixture.input.bridgePlanPath);
    const planCase = plan.cases.find(
      (entry: { caseId: string }) => entry.caseId === "case-upstream-dev"
    );
    if (planCase === undefined) throw new Error("TEST_PLAN_CASE_MISSING");
    planCase.taskDraft.sha256 = sha256(taskBytes);
    writePrivate(fixture.input.bridgePlanPath, pretty(plan));
    rewriteBridgeInput(
      fixture,
      "case-0001.mapping.private.json",
      (value) => ({ ...value, taskDraftSha256: sha256(taskBytes) }),
      "case-upstream-dev",
      "sourceMapping"
    );
    expect(() => prepare(fixture)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_TASK_INVALID"
    );
  });

  it("只接受 complete 且 contentHash 一致的原始 Anklang v2，但历史结果任务统一不注入候选", () => {
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
    expect(dataset.cases[0]?.task.reviewItems).toEqual([]);
    expect(readFileSync(result.manifestPath, "utf8")).not.toContain(
      "sameProblemSuggestion"
    );
  });

  it("原始 Anklang request 必须是唯一 v2 请求，并逐字段绑定 task 与重算 contentHash", () => {
    const extraField = createBridgeFixture("anklang-request-extra");
    rewriteBridgeInput(
      extraField,
      "case-0001.anklang-request.private.json",
      (value) => ({ ...value, unexpected: true }),
      "case-upstream-dev",
      "originalAnklangRequest"
    );
    expect(() => prepare(extraField)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_REQUEST_INVALID"
    );

    const changedProblem = createBridgeFixture("anklang-request-problem");
    rewriteBridgeInput(
      changedProblem,
      "case-0001.anklang-request.private.json",
      (value) => ({
        ...value,
        problem: { ...value.problem, basicStatement: "different statement" }
      }),
      "case-upstream-dev",
      "originalAnklangRequest"
    );
    expect(() => prepare(changedProblem)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_CASE_BINDING_MISMATCH"
    );

    const duplicateRequestId = createBridgeFixture("anklang-request-duplicate");
    const firstRequestId = readJson(join(
      duplicateRequestId.bridgeInput,
      "case-0001.anklang-request.private.json"
    )).requestId;
    rewriteBridgeInput(
      duplicateRequestId,
      "case-9001.anklang-request.private.json",
      (value) => ({ ...value, requestId: firstRequestId }),
      "case-upstream-hold",
      "originalAnklangRequest"
    );
    rewriteCaptureAttestation(duplicateRequestId, (attestation, plan) => ({
      ...attestation,
      cases: attestation.cases.map((entry: Record<string, unknown>, index: number) =>
        index === 1
          ? {
              ...entry,
              requestId: firstRequestId,
              requestSha256: plan.cases[1].originalAnklangRequest.sha256
            }
          : entry)
    }));
    expect(() => prepare(duplicateRequestId)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_CAPTURE_MISMATCH"
    );
  });

  it("Anklang capture 必须绑定 clean capturer、HTTP 200/attempt 1、完整批次 marker", () => {
    const dirtyCapturer = createBridgeFixture("anklang-capturer-dirty");
    writeFileSync(join(dirtyCapturer.capturerRepository, "untracked.txt"), "dirty\n");
    expect(() => prepare(dirtyCapturer)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_CAPTURER_IDENTITY_INVALID"
    );

    const wrongAttempt = createBridgeFixture("anklang-attempt-two");
    rewriteCaptureAttestation(wrongAttempt, (attestation) => ({
      ...attestation,
      cases: attestation.cases.map((entry: Record<string, unknown>, index: number) =>
        index === 0 ? { ...entry, attempt: 2 } : entry)
    }));
    expect(() => prepare(wrongAttempt)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_CAPTURE_ATTESTATION_INVALID"
    );

    const missingCompletion = createBridgeFixture("anklang-completion-missing");
    const missingPlan = readJson(missingCompletion.input.bridgePlanPath);
    rmSync(join(
      missingCompletion.bridgeInput,
      missingPlan.anklangCaptureCompletion.fileName
    ));
    expect(() => prepare(missingCompletion)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_INPUT_INVALID"
    );

    const extraResponseField = createBridgeFixture("anklang-response-extra");
    rewriteBridgeInput(
      extraResponseField,
      "case-0001.anklang.private.json",
      (value) => ({ ...value, unexpected: true }),
      "case-upstream-dev",
      "originalAnklangResponse"
    );
    expect(() => prepare(extraResponseField)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_INVALID"
    );

    const falseReproducible = createBridgeFixture("anklang-false-reproducible");
    rewriteCaptureAttestation(falseReproducible, (attestation) => ({
      ...attestation,
      corpus: {
        evidenceKind: "reproducible_snapshot",
        corpusId: "synthetic-corpus",
        manifestSha256: sha256("manifest"),
        snapshotSha256: sha256("snapshot"),
        corpusRevisionSha256: sha256("revision"),
        problemCount: 2
      }
    }));
    expect(() => prepare(falseReproducible)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_CAPTURE_ATTESTATION_INVALID"
    );

    const localSnapshot = createBridgeFixture("anklang-local-snapshot");
    rewriteCaptureAttestation(localSnapshot, (attestation) => ({
      ...attestation,
      backend: { ...attestation.backend, kind: "local_engine" },
      corpus: {
        evidenceKind: "reproducible_snapshot",
        corpusId: "synthetic-corpus",
        manifestSha256: sha256("manifest"),
        snapshotSha256: sha256("snapshot"),
        corpusRevisionSha256: sha256("revision"),
        problemCount: 2
      }
    }));
    expect(() => prepare(localSnapshot)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_CAPTURE_ATTESTATION_INVALID"
    );
  }, 15_000);

  it("手写 Anklang attestation 不能替代 verifier 重放，输出不一致和执行失败都关闭", () => {
    const handwritten = createBridgeFixture("anklang-handwritten-attestation");
    rewriteCaptureAttestation(
      handwritten,
      (attestation) => ({
        ...attestation,
        capturedAt: "2026-08-01T00:00:01.000Z"
      }),
      false
    );
    expect(() => prepare(handwritten)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_CAPTURE_ATTESTATION_MISMATCH"
    );

    const mismatchedIdentity = createBridgeFixture(
      "anklang-verifier-identity-mismatch"
    );
    const mismatchedManifest = readJson(
      mismatchedIdentity.captureVerifierManifestPath
    );
    writePrivate(
      mismatchedIdentity.captureVerifierManifestPath,
      pretty({
        ...mismatchedManifest,
        verifierRunnerSha256: "f".repeat(64)
      })
    );
    expect(() => prepare(mismatchedIdentity)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_VERIFIER_EXECUTION_FAILED"
    );

    const failed = createBridgeFixture("anklang-verifier-failed");
    const failedManifest = readJson(failed.captureVerifierManifestPath);
    writePrivate(
      failed.captureVerifierManifestPath,
      pretty({ ...failedManifest, mode: "fail" })
    );
    expect(() => prepare(failed)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_VERIFIER_EXECUTION_FAILED"
    );
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
      "--anklang-capture-workspace=/private/anklang-capture",
      "--anklang-capture-manifest=/private/anklang-capture/manifest.json",
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
  readonly capturerRepository: string;
  readonly captureVerifierAttestationPath: string;
  readonly captureVerifierManifestPath: string;
  readonly generatorIdentity: ReturnType<typeof loadEvaluationCodeIdentity>;
  readonly developmentCandidates: readonly unknown[];
}

type SourceProjectionMethod =
  | "markdown_solution_heading_v1"
  | "last_horizontal_rule_v1"
  | "algorithm_heading_v1"
  | "operator_explicit_offsets_v1";

interface BridgeFixtureOptions {
  readonly projectionMethods?: readonly [
    SourceProjectionMethod,
    SourceProjectionMethod
  ];
  readonly solutionSuffixes?: readonly [string, string];
  readonly holdoutEvaluationScope?:
    | "verdict_and_taste"
    | "originality_only";
  readonly secondPlaceholderTagIds?: readonly string[];
}

function createBridgeFixture(
  seed: string,
  options: BridgeFixtureOptions = {}
): BridgeFixture {
  const projectionMethods = options.projectionMethods ?? [
    "markdown_solution_heading_v1",
    "operator_explicit_offsets_v1"
  ] as const;
  const solutionSuffixes = options.solutionSuffixes ?? ["", ""] as const;
  const holdoutOriginalityOnly =
    options.holdoutEvaluationScope === "originality_only";
  const problemInputs = [
    problemHashInput(1, solutionSuffixes[0]),
    problemHashInput(
      2,
      solutionSuffixes[1],
      options.secondPlaceholderTagIds ?? ["tag-basic"]
    )
  ] as const;
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
  const capturer = createSyntheticAnklangCapturer(workspace);

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
      content: sourceBytes(problemInputs[0], projectionMethods[0])
    },
    {
      sourceId: "source-000002",
      sourcePath: "source-000002.md",
      metadataNumber: "102",
      content: sourceBytes(problemInputs[1], projectionMethods[1])
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
      identityValues: ["Synthetic 1"],
      finalDecisionText: "synthetic rejected",
      contestUseText: "synthetic not used",
      reviewComments: ["synthetic style concern", ""],
      reviewCommentPresent: true
    },
    {
      rowId: "review-row-000002",
      inputId: "input-000002",
      worksheetId: "worksheet-000001",
      sourceRowNumber: 2,
      metadataNumber: "102",
      identityValues: ["Synthetic 2"],
      finalDecisionText: holdoutOriginalityOnly ? "" : "synthetic accepted",
      contestUseText: holdoutOriginalityOnly ? "" : "synthetic used",
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
    holdoutOriginalityOnly ? {
      caseId: "case-upstream-hold",
      subjectId: "subject-synthetic-holdout",
      rowId: rows[1]!.rowId,
      sourceId: sourceDefinitions[1]!.sourceId,
      sourceSha256: sha256(sourceDefinitions[1]!.content),
      purpose: "holdout",
      evaluationScope: "originality_only",
      sameProblemAsExisting: true,
      confirmed: true
    } : {
      caseId: "case-upstream-hold",
      subjectId: "subject-synthetic-holdout",
      rowId: rows[1]!.rowId,
      sourceId: sourceDefinitions[1]!.sourceId,
      sourceSha256: sha256(sourceDefinitions[1]!.content),
      purpose: "holdout",
      evaluationScope: "verdict_and_taste",
      verdict: "accepted",
      contestUse: "used",
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
    holdoutOriginalityOnly ? {
      version: 2,
      artifactKind: "historical_review_gold",
      caseId: upstreamCases[1]!.caseId,
      reviewCommentPresent: false,
      evaluationScope: "originality_only",
      sameProblemAsExisting: true
    } : {
      version: 2,
      artifactKind: "historical_review_gold",
      caseId: upstreamCases[1]!.caseId,
      reviewCommentPresent: false,
      evaluationScope: "verdict_and_taste",
      verdict: "accepted",
      contestUse: "used"
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
    verdictAndTasteCount: holdoutOriginalityOnly ? 1 : 2,
    originalityOnlyCount: holdoutOriginalityOnly ? 1 : 0
  };
  const upstreamMarkerBytes = pretty(upstreamMarker);
  writePrivate(join(upstreamGold, "REVIEW_GOLD_COMPLETE"), upstreamMarkerBytes);

  const catalog = {
    schemaVersion: 1,
    version: 7,
    tags: [
      {
        id: "tag-basic",
        name: "基础",
        categoryId: "category-basic",
        categoryName: "基础",
        description: "synthetic tag",
        aliases: [],
        active: true as const
      },
      {
        id: "tag-other",
        name: "其他",
        categoryId: "category-other",
        categoryName: "其他",
        description: "synthetic alternate tag",
        aliases: [],
        active: true as const
      }
    ]
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
  const captureCases: {
    caseId: string;
    requestId: string;
    requestSha256: string;
    responseSha256: string;
    httpStatus: 200;
    attempt: 1;
    responseCompletionStatus: "complete";
  }[] = [];
  const bridgeCases = upstreamCases.map((entry, index) => {
    const safeId = index === 0 ? "case-0001" : "case-9001";
    const hashInput = problemInputs[index]!;
    const contentHash = computeUrmotivProblemContentHash(hashInput);
    const hashInputBytes = pretty(hashInput);
    const hashInputFileName = `${safeId}.problem-hash-input.private.json`;
    writePrivate(join(bridgeInput, hashInputFileName), hashInputBytes);
    const task = taskDraft(index + 1, contentHash, catalog, hashInput);
    const taskBytes = pretty(task);
    const taskFileName = `${safeId}.task.private.json`;
    writePrivate(join(bridgeInput, taskFileName), taskBytes);
    const requestId = `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const anklangRequest = {
      apiVersion: "2",
      requestId,
      contentHash,
      problem: {
        title: task.problem.title,
        type: task.problem.type,
        tagIds: task.problem.tagIds,
        basicStatement: task.problem.content.basicStatement
      }
    };
    const anklangRequestBytes = pretty(anklangRequest);
    const anklangRequestFileName = `${safeId}.anklang-request.private.json`;
    writePrivate(join(bridgeInput, anklangRequestFileName), anklangRequestBytes);
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
    captureCases.push({
      caseId: entry.caseId,
      requestId,
      requestSha256: sha256(anklangRequestBytes),
      responseSha256: sha256(anklangBytes),
      httpStatus: 200,
      attempt: 1,
      responseCompletionStatus: "complete"
    });
    const statementBytes = Buffer.from(task.problem.content.basicStatement);
    const solutionBytes = Buffer.from(task.problem.content.basicSolution);
    const sourceBytes = sourceDefinitions[index]!.content;
    const statementStartByte = sourceBytes.indexOf(statementBytes);
    const solutionStartByte = sourceBytes.indexOf(solutionBytes);
    if (statementStartByte < 0 || solutionStartByte < 0) {
      throw new Error("TEST_SOURCE_PROJECTION_MISSING");
    }
    const projectionFields = {
      titleIdentityValueIndex: 0,
      sourceProjection: {
        method: projectionMethods[index]!,
        statement: {
          startByte: statementStartByte,
          endByte: statementStartByte + statementBytes.byteLength
        },
        solution: {
          startByte: solutionStartByte,
          endByte: solutionStartByte + solutionBytes.byteLength
        }
      },
      problemTypeBasis: "operator_confirmed",
      currentTagIdsBasis: "calibration_placeholder_not_gold",
      placeholderTagIds: hashInput.tagIds
    } as const;
    const mapping = holdoutOriginalityOnly && index === 1 ? {
          schemaVersion: 2,
          artifactKind: "review_flow_evaluation_source_mapping",
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
          ...projectionFields,
          evaluationScope: "originality_only",
          originalityAnnotation: "confirmed_duplicate_evidence",
          confirmedDuplicate: true
        } : {
          schemaVersion: 2,
          artifactKind: "review_flow_evaluation_source_mapping",
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
          ...projectionFields,
          evaluationScope: "verdict_and_taste",
          historicalReviewReasonMapping:
            "operator_asserted_sparse_mapping_v1",
          observedHistoricalTasteReasonEvidence: index === 0 ? [{
              reviewCommentIndex: 0,
              reason: {
                dimension: "icpc_fit",
                direction: "concern"
              }
            }] : [],
          observedHistoricalTechnicalReasonEvidence: []
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
      originalAnklangRequest: {
        fileName: anklangRequestFileName,
        sha256: sha256(anklangRequestBytes)
      },
      originalAnklangResponse: {
        fileName: anklangFileName,
        sha256: sha256(anklangBytes)
      },
      sourceMapping: {
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
      verdictAndTasteCount: holdoutOriginalityOnly ? 1 : 2,
      originalityOnlyCount: holdoutOriginalityOnly ? 1 : 0,
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
  const captureAttestationWithoutFingerprint = {
    schemaVersion: 1,
    artifactKind: "anklang_review_flow_capture_attestation",
    protocolVersion: "anklang-review-flow-capture-v1",
    captureStatus: "complete",
    captureId: `capture-${sha256(`capture-${seed}`).slice(0, 16)}`,
    capturedAt: "2026-08-01T00:00:00.000Z",
    capturer: {
      repository: "Anklang",
      codeVersion: capturer.identity.codeVersion,
      runnerPath: "scripts/capture-review-flow-calibration.py",
      runnerSha256: capturer.identity.runnerSha256,
      dependencyCodeSha256: capturer.identity.dependencyCodeSha256,
      dependencyFileCount: 4
    },
    configuration: {
      apiVersion: "2",
      endpointPath: "/api/v2/checks/similarity",
      baseUrlSha256: sha256("https://synthetic.invalid"),
      timeoutMs: 300_000,
      authentication: "bearer_redacted",
      secretsExcluded: true
    },
    backend: {
      kind: "reverse_proxy",
      configurationSha256: sha256(`backend-${seed}`),
      secretsExcluded: true
    },
    corpus: {
      evidenceKind: "remote_corpus_unverifiable",
      serviceOriginSha256: sha256("https://synthetic.invalid"),
      declarationSha256: sha256(`remote-corpus-${seed}`)
    },
    cases: captureCases,
    counts: {
      caseCount: captureCases.length,
      requestCount: captureCases.length,
      responseCount: captureCases.length,
      http200Count: captureCases.length,
      attemptCount: captureCases.length,
      completeResponseCount: captureCases.length,
      failureCount: 0
    }
  };
  const captureAttestation = {
    ...captureAttestationWithoutFingerprint,
    captureFingerprint: hashCanonicalValue(
      captureAttestationWithoutFingerprint
    )
  };
  const captureAttestationBytes = pretty(captureAttestation);
  const captureAttestationFileName = "anklang-capture-attestation.private.json";
  writePrivate(
    join(bridgeInput, captureAttestationFileName),
    captureAttestationBytes
  );
  const captureVerifierWorkspace = mkdirPrivate(
    join(privateRoot, "anklang-capture-workspace")
  );
  const captureVerifierAttestationPath = join(
    captureVerifierWorkspace,
    "verified-attestation.private.json"
  );
  writePrivate(captureVerifierAttestationPath, captureAttestationBytes);
  const captureVerifierManifestPath = join(
    captureVerifierWorkspace,
    "capture-manifest.private.json"
  );
  writePrivate(captureVerifierManifestPath, pretty({
    schemaVersion: 1,
    workspace: captureVerifierWorkspace,
    attestationFileName: "verified-attestation.private.json",
    verifierCodeVersion: capturer.identity.codeVersion,
    verifierRunnerSha256: capturer.identity.runnerSha256,
    verifierDependencyCodeSha256:
      capturer.identity.dependencyCodeSha256,
    mode: "success"
  }));
  const captureCompletion = {
    schemaVersion: 1,
    artifactKind: "anklang_review_flow_capture_completion",
    protocolVersion: "anklang-review-flow-capture-v1",
    captureId: captureAttestation.captureId,
    attestationSha256: sha256(captureAttestationBytes),
    captureSetSha256:
      reviewFlowEvaluationAnklangCaptureSetSha256(captureCases),
    caseCount: captureCases.length,
    requestCount: captureCases.length,
    responseCount: captureCases.length,
    http200Count: captureCases.length,
    attemptCount: captureCases.length,
    completeResponseCount: captureCases.length,
    failureCount: 0,
    complete: true
  };
  const captureCompletionBytes = pretty(captureCompletion);
  const captureCompletionFileName = "anklang-capture-completion.private.json";
  writePrivate(
    join(bridgeInput, captureCompletionFileName),
    captureCompletionBytes
  );
  const bridgePlan = {
    schemaVersion: 4,
    artifactKind: "review_flow_evaluation_bridge_plan",
    bridgeVersion: "urmotiv-review-flow-bridge-v4",
    confirmed: true,
    anklangInputPolicy:
      "exclude_current_corpus_for_historical_outcome",
    placeholderTagIds: ["tag-basic"],
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
    anklangCaptureAttestation: {
      fileName: captureAttestationFileName,
      sha256: sha256(captureAttestationBytes)
    },
    anklangCaptureCompletion: {
      fileName: captureCompletionFileName,
      sha256: sha256(captureCompletionBytes)
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
    capturerRepository: capturer.repository,
    captureVerifierAttestationPath,
    captureVerifierManifestPath,
    generatorIdentity: generator.identity,
    developmentCandidates,
    input: {
      privateRoot,
      containingWorkspace: workspace,
      fermataCodeVersion: generator.identity.codeVersion,
      bridgePlanPath,
      anklangCaptureWorkspace: captureVerifierWorkspace,
      anklangCaptureManifestPath: captureVerifierManifestPath,
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
      limits: null
    },
    tagCatalog: { version: catalog.version, tags: [...catalog.tags] },
    reviewItems: []
  };
}

function problemHashInput(
  index: number,
  solutionSuffix = "",
  tagIds: readonly string[] = ["tag-basic"]
) {
  return {
    schemaVersion: 1 as const,
    artifactKind: "urmotiv_problem_content_hash_input" as const,
    title: `Synthetic ${index}`,
    type: "traditional" as const,
    tagIds: [...tagIds],
    codeforcesDifficulty: null,
    thinkingLevel: null,
    codingLevel: null,
    content: {
      basicStatement: `题面 Synthetic statement ${index}`,
      basicSolution: `题解 Synthetic solution ${index}${solutionSuffix}`,
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
    judgeConfig: null,
    status: "pending_review" as const
  };
}

function sourceBytes(
  input: ReturnType<typeof problemHashInput>,
  method: SourceProjectionMethod
): Buffer {
  const gap = method === "markdown_solution_heading_v1"
    ? "\n\n# 题解\n\n"
    : method === "algorithm_heading_v1"
    ? "\r\n\r\n# 算法\r\n\r\n"
    : method === "last_horizontal_rule_v1"
    ? "\n\n---\n\n"
    : "\n\noperator confirmed boundary\n\n";
  return Buffer.from(
    `${input.content.basicStatement}${gap}${input.content.basicSolution}`,
    "utf8"
  );
}

function rewriteBridgeInput(
  fixture: BridgeFixture,
  fileName: string,
  update: (value: Record<string, any>) => Record<string, any>,
  caseId: string,
  bindingKey:
    | "sourceMapping"
    | "taskDraft"
    | "originalAnklangRequest"
    | "originalAnklangResponse"
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

function rewriteCoherentDevelopmentContent(
  fixture: BridgeFixture,
  update: (
    value: ReturnType<typeof problemHashInput>
  ) => ReturnType<typeof problemHashInput>
): void {
  const hashInputPath = join(
    fixture.bridgeInput,
    "case-0001.problem-hash-input.private.json"
  );
  const taskPath = join(fixture.bridgeInput, "case-0001.task.private.json");
  const requestPath = join(
    fixture.bridgeInput,
    "case-0001.anklang-request.private.json"
  );
  const responsePath = join(
    fixture.bridgeInput,
    "case-0001.anklang.private.json"
  );
  const mappingPath = join(
    fixture.bridgeInput,
    "case-0001.mapping.private.json"
  );
  const changedHashInput = update(
    readJson(hashInputPath) as ReturnType<typeof problemHashInput>
  );
  const contentHash = computeUrmotivProblemContentHash(changedHashInput);
  const hashInputBytes = pretty(changedHashInput);
  writePrivate(hashInputPath, hashInputBytes);

  const originalTask = readJson(taskPath);
  const changedTask = {
    ...originalTask,
    problem: {
      ...originalTask.problem,
      contentHash,
      title: changedHashInput.title,
      type: changedHashInput.type,
      tagIds: changedHashInput.tagIds,
      content: changedHashInput.content
    }
  };
  const taskBytes = pretty(changedTask);
  writePrivate(taskPath, taskBytes);

  const changedRequest = {
    ...readJson(requestPath),
    contentHash,
    problem: {
      title: changedTask.problem.title,
      type: changedTask.problem.type,
      tagIds: changedTask.problem.tagIds,
      basicStatement: changedTask.problem.content.basicStatement
    }
  };
  const requestBytes = pretty(changedRequest);
  writePrivate(requestPath, requestBytes);
  const responseBytes = pretty({
    ...readJson(responsePath),
    contentHash
  });
  writePrivate(responsePath, responseBytes);

  const mappingBytes = pretty({
    ...readJson(mappingPath),
    taskDraftSha256: sha256(taskBytes),
    problemHashInputSha256: sha256(hashInputBytes),
    problemContentHash: contentHash,
    placeholderTagIds: changedHashInput.tagIds
  });
  writePrivate(mappingPath, mappingBytes);

  const planPath = fixture.input.bridgePlanPath;
  const plan = readJson(planPath);
  const planCase = plan.cases.find(
    (entry: { caseId: string }) => entry.caseId === "case-upstream-dev"
  );
  if (planCase === undefined) throw new Error("TEST_PLAN_CASE_MISSING");
  planCase.problemHashInput.sha256 = sha256(hashInputBytes);
  planCase.taskDraft.sha256 = sha256(taskBytes);
  planCase.originalAnklangRequest.sha256 = sha256(requestBytes);
  planCase.originalAnklangResponse.sha256 = sha256(responseBytes);
  planCase.sourceMapping.sha256 = sha256(mappingBytes);
  writePrivate(planPath, pretty(plan));

  rewriteCaptureAttestation(fixture, (attestation, currentPlan) => {
    const currentCase = currentPlan.cases.find(
      (entry: { caseId: string }) => entry.caseId === "case-upstream-dev"
    );
    if (currentCase === undefined) throw new Error("TEST_PLAN_CASE_MISSING");
    return {
      ...attestation,
      cases: attestation.cases.map((entry: Record<string, any>) =>
        entry.caseId === "case-upstream-dev"
          ? {
              ...entry,
              requestSha256: currentCase.originalAnklangRequest.sha256,
              responseSha256: currentCase.originalAnklangResponse.sha256
            }
          : entry)
    };
  });
}

function rewriteCaptureAttestation(
  fixture: BridgeFixture,
  update: (
    attestation: Record<string, any>,
    plan: Record<string, any>
  ) => Record<string, any>,
  syncVerifier = true
): void {
  const planPath = fixture.input.bridgePlanPath;
  const plan = readJson(planPath);
  const attestationPath = join(
    fixture.bridgeInput,
    plan.anklangCaptureAttestation.fileName
  );
  const original = readJson(attestationPath);
  const changed = update(original, plan);
  const { captureFingerprint: _oldFingerprint, ...withoutFingerprint } = changed;
  const attestation: Record<string, any> = {
    ...withoutFingerprint,
    captureFingerprint: hashCanonicalValue(withoutFingerprint)
  };
  const attestationBytes = pretty(attestation);
  writePrivate(attestationPath, attestationBytes);
  if (syncVerifier) {
    writePrivate(fixture.captureVerifierAttestationPath, attestationBytes);
  }
  plan.anklangCaptureAttestation.sha256 = sha256(attestationBytes);

  const completionPath = join(
    fixture.bridgeInput,
    plan.anklangCaptureCompletion.fileName
  );
  const completion = readJson(completionPath);
  const completionBytes = pretty({
    ...completion,
    captureId: attestation.captureId,
    attestationSha256: sha256(attestationBytes),
    captureSetSha256:
      reviewFlowEvaluationAnklangCaptureSetSha256(attestation.cases)
  });
  writePrivate(completionPath, completionBytes);
  plan.anklangCaptureCompletion.sha256 = sha256(completionBytes);
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

function createSyntheticAnklangCapturer(workspace: string) {
  const repository = join(workspace, "Anklang");
  const dependencyPaths = [
    "scripts/capture-review-flow-calibration.py",
    "anklang/__init__.py",
    "anklang/review_flow_capture.py",
    "anklang/contracts.py"
  ] as const;
  mkdirSync(repository, { recursive: true, mode: 0o700 });
  writeFileSync(join(repository, ".gitignore"), "__pycache__/\n", {
    mode: 0o600
  });
  for (const path of dependencyPaths) {
    const absolutePath = join(repository, path);
    mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
    const contents = path === dependencyPaths[0]
      ? `#!/usr/bin/python3
import argparse
import json
import os
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT))
from anklang.review_flow_capture import read_attestation

parser = argparse.ArgumentParser()
subparsers = parser.add_subparsers(dest="command", required=True)
verify = subparsers.add_parser("verify-capture")
verify.add_argument("--workspace", required=True)
verify.add_argument("--manifest", required=True)
verify.add_argument("--verifier-code-version", required=True)
verify.add_argument("--verifier-runner-sha256", required=True)
verify.add_argument("--verifier-dependency-code-sha256", required=True)
args = parser.parse_args()
with open(args.manifest, "r", encoding="utf-8") as handle:
    manifest = json.load(handle)
if manifest.get("mode") == "fail":
    raise SystemExit(19)
if (
    os.path.realpath(args.workspace) != os.path.realpath(manifest["workspace"])
    or args.verifier_code_version != manifest["verifierCodeVersion"]
    or args.verifier_runner_sha256 != manifest["verifierRunnerSha256"]
    or args.verifier_dependency_code_sha256 != manifest["verifierDependencyCodeSha256"]
):
    raise SystemExit(20)
name = manifest["attestationFileName"]
if os.path.basename(name) != name:
    raise SystemExit(21)
sys.stdout.buffer.write(read_attestation(Path(args.workspace) / name))
`
      : path === "anklang/review_flow_capture.py"
      ? `from pathlib import Path

def read_attestation(path: Path) -> bytes:
    return path.read_bytes()
`
      : `# synthetic capture dependency: ${path}\n`;
    writeFileSync(absolutePath, contents, { mode: 0o600 });
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
      "synthetic capture"
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
    runnerPath: "scripts/capture-review-flow-calibration.py",
    dependencyPaths
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
    ".synthetic-attestation-output\n__pycache__/\n",
    { mode: 0o600 }
  );
  writeFileSync(
    join(repository, "scripts", "migrate-hist", "prepare-review-gold.py"),
    [
      "import importlib.util",
      "from pathlib import Path",
      "import sys",
      "if len(sys.argv) < 2 or sys.argv[1] != 'verify-sealed':",
      "    raise SystemExit(2)",
      "dependency_path = Path(__file__).with_name('parse-metadata.py')",
      "spec = importlib.util.spec_from_file_location('synthetic_parse_metadata', dependency_path)",
      "if spec is None or spec.loader is None:",
      "    raise SystemExit(3)",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "sys.stdout.buffer.write(module.read_attestation(Path('.synthetic-attestation-output')))",
      ""
    ].join("\n"),
    { mode: 0o600 }
  );
  writeFileSync(
    join(repository, "scripts", "migrate-hist", "parse-metadata.py"),
    [
      "from pathlib import Path",
      "def read_attestation(path: Path) -> bytes:",
      "    return path.read_bytes()",
      ""
    ].join("\n"),
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

function installUncheckedHashPyc(
  sourcePath: string,
  markerPath: string
): void {
  const maliciousSourcePath = join(
    dirname(dirname(dirname(sourcePath))),
    `.malicious-${sha256(sourcePath).slice(0, 12)}.py`
  );
  writeFileSync(
    maliciousSourcePath,
    [
      "from pathlib import Path",
      `Path(${JSON.stringify(markerPath)}).write_text('executed', encoding='utf-8')`,
      "def read_attestation(path: Path) -> bytes:",
      "    return path.read_bytes()",
      ""
    ].join("\n"),
    { mode: 0o600 }
  );
  try {
    execFileSync(
      "/usr/bin/python3",
      [
        "-c",
        [
          "import importlib.util",
          "import py_compile",
          "import sys",
          "py_compile.compile(",
          "    sys.argv[1],",
          "    cfile=importlib.util.cache_from_source(sys.argv[2]),",
          "    dfile=sys.argv[2],",
          "    doraise=True,",
          "    invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH,",
          ")"
        ].join("\n"),
        maliciousSourcePath,
        sourcePath
      ]
    );
  } finally {
    rmSync(maliciousSourcePath, { force: true });
  }
}

function snapshotPycFiles(repository: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    globSync("**/*.pyc", { cwd: repository })
      .sort()
      .map((path) => [path, sha256(readFileSync(join(repository, path)))])
  );
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
