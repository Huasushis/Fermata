import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareReviewFlowEvaluationDatasetBridge,
  computeUrmotivProblemContentHash,
  reviewFlowEvaluationAnklangCaptureSetSha256,
  historicalInputPreparationCodePaths,
  historicalInputPreparationCompletionFileName,
  historicalInputPreparationVersion,
  type PrepareReviewFlowEvaluationBridgeInput
} from "../experiments/lib/review-flow-evaluation-bridge";
import { loadEvaluationCodeIdentity } from "../experiments/lib/evaluation-code-identity";
import { reviewFlowEvaluationCodePaths } from "../experiments/lib/review-flow-bridge-repositories";
import { hashCanonicalValue } from "../src/review-flow/evidence";
import { loadReviewFlowEvaluationDataset } from "../experiments/lib/review-flow-evaluation-dataset";
import { parseReviewFlowDatasetBridgeArguments } from "../experiments/prepare-review-flow-dataset";
import type { RobotReviewTask } from "../src/urmotiv-schemas";

const temporaryRoots: string[] = [];

// 共享 worktree（Fermata/Anklang）的测试性改动必须逐条恢复，否则会污染
// 同文件后续测试的仓库身份校验。
const trackedWorktreeMutations: Array<() => void> = [];
function mutateWorktreeFile(path: string, content: string): void {
  const original = existsSync(path) ? readFileSync(path) : null;
  writeFileSync(path, content);
  trackedWorktreeMutations.push(() => {
    if (original === null) {
      rmSync(path, { force: true });
    } else {
      writeFileSync(path, original);
    }
  });
}

afterEach(() => {
  while (trackedWorktreeMutations.length > 0) {
    const restoreFunction = trackedWorktreeMutations.pop();
    restoreFunction?.();
  }
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("review-flow trusted dataset bridge", () => {
  it("验证完整上游链，排除赛后 Anklang 自匹配，并以不含 Gold oracle 的 v5 manifest 发布", () => {
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
      caseCount: 32,
      developmentCount: 32,
      holdoutCount: 0
    });
    expect(result.holdoutRevealDescriptorPath).toBeNull();
    expect(stages.at(-1)).toBe("completion");
    expect(existsSync(join(fixture.output, "REVIEW_FLOW_DATASET_COMPLETE")))
      .toBe(true);

    const developmentIdentity = loadReviewFlowEvaluationDataset({
      manifestPath: result.manifestPath,
      mode: "development_identity",
      privateRoot: fixture.privateRoot,
      containingWorkspace: fixture.workspace
    });
    expect(developmentIdentity.cases).toHaveLength(32);
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
    expect(developmentScored.cases[1]?.gold).toMatchObject({
      evaluationScope: "verdict_and_taste",
      historicalOutcome: "accepted",
      contestUse: "used"
    });

    const task = developmentIdentity.cases[0]?.task;
    expect(task?.reviewItems).toEqual([]);

    const manifestText = readFileSync(result.manifestPath, "utf8");
    expect(manifestText).not.toContain("gold.private.json");
    const developmentDescriptor = readJson(result.developmentRevealDescriptorPath);
    const labelSideEvidenceDigests = developmentDescriptor.cases.flatMap((entry: {
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
    expect(developmentDescriptor.commitmentNonce).toMatch(/^[0-9a-f]{64}$/u);
    const manifest = readJson(result.manifestPath);
    expect(manifest).toMatchObject({
      schemaVersion: 4,
      anklangInputPolicy:
        "exclude_current_corpus_for_historical_outcome",
      placeholderTagIds: ["tag-basic"],
      holdoutRegistration: null,
      holdoutRevealCommitmentSha256: null
    });
    expect(manifest.partitions.holdout.cases).toHaveLength(0);
    expect(developmentIdentity.placeholderTagIds).toEqual(["tag-basic"]);
    for (const descriptor of manifest.partitions.development.cases) {
      expect(descriptor).not.toHaveProperty("anklangInputPolicy");
      expect(descriptor).not.toHaveProperty("evaluationScope");
    }
    expect(manifest.developmentRevealCommitmentSha256).toBe(
      sha256(readFileSync(result.developmentRevealDescriptorPath))
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
    expect(completion.bridgeVersion).toBe("urmotiv-review-flow-bridge-v5");
    expect(completion.placeholderTagIds).toEqual(["tag-basic"]);
    expect(completion.historicalInputPreparationCompletionSha256).toBe(
      sha256(readFileSync(join(
        fixture.bridgeInput,
        "REVIEW_FLOW_HISTORICAL_INPUTS_COMPLETE"
      )))
    );
    expect(completion.tagCatalogSha256).toBe(manifest.tagCatalog.sha256);
    expect(completion.sourceLineageSetSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(completion.developmentPredictionBindingSha256).toMatch(
      /^[0-9a-f]{64}$/u
    );
    expect(completion.developmentRevealCommitmentSha256).toBe(
      manifest.developmentRevealCommitmentSha256
    );
    expect(completion.holdoutPredictionBindingSha256).toBeNull();
    expect(completion.holdoutRevealCommitmentSha256).toBeNull();
    expect(completion).toMatchObject({
      schemaVersion: 5,
      caseCount: 32,
      developmentCount: 32,
      holdoutCount: 0
    });
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
      protocol: "review-flow-evaluation-source-lineage-v7",
      bridgeVersion: "urmotiv-review-flow-bridge-v5",
      generator: expectedGenerator,
      preparation: {
        preparationVersion: historicalInputPreparationVersion,
        repositories: completion.repositories
      },
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

  it("整批只能使用同一组占位标签，两题不一致时在创建任何发布目录前拒绝", () => {
    const fixture = createBridgeFixture("placeholder-batch-mismatch", {
      secondPlaceholderTagIds: ["tag-other"]
    });
    expect(() => prepare(fixture)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_PLACEHOLDER_TAGS_MISMATCH"
    );
    expect(existsSync(fixture.output)).toBe(false);
    expect(existsSync(fixture.input.developmentRevealDirectory)).toBe(false);
  });

  it("生成器必须来自显式 clean Fermata HEAD，且生成期间身份不能变化", () => {
    const dirty = createBridgeFixture("generator-dirty");
    mutateWorktreeFile(join(dirty.generatorRepository, "untracked.txt"), "dirty\n");
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
    mutateWorktreeFile(
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
          mutateWorktreeFile(
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
          mutateWorktreeFile(
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
      join(changedGold.upstreamGold, "gold", "case-0001.json"),
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
    }), "case-0001", "sourceMapping");
    expect(() => prepare(mappingMismatch)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_MAPPING_INVALID"
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
    }), "case-0001", "taskDraft");
    expect(() => prepare(taskMismatch)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_TASK_INVALID"
    );

    // 协调伪造：task/anklang/mapping 与 plan 绑定、准备封存全部一致，
    // 但内容哈希与 problemHashInput 不一致 —— 只能由内容级校验拒绝。
    const coordinatedSelfReport = createBridgeFixture("coordinated-fake-hash");
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
    }), "case-0001", "sourceMapping");
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
    }), "case-0001", "sourceMapping");
    expect(() => prepare(emptyComment)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_MAPPING_INVALID"
    );

    const derived = createBridgeFixture("reason-derived-unique");
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
      "case-0001",
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
    expect(() => prepare(wrongOffset)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_CASE_BINDING_MISMATCH"
    );

    const utf8Midpoint = createBridgeFixture("projection-utf8-midpoint");
    expect(() => prepare(utf8Midpoint)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_SOURCE_PROJECTION_INVALID"
    );

    const titleMisalignment = createBridgeFixture("projection-title-index");
    expect(() => prepare(titleMisalignment)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_CASE_BINDING_MISMATCH"
    );

    const falseMethod = createBridgeFixture("projection-false-method");
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
    expect(() => prepare(omittedPrefix)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_SOURCE_PROJECTION_INVALID"
    );

    const omittedSuffix = createBridgeFixture("projection-omitted-suffix");
    expect(() => prepare(omittedSuffix)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_SOURCE_PROJECTION_INVALID"
    );

    const hiddenGapBody = createBridgeFixture("projection-hidden-gap-body");
    expect(() => prepare(hiddenGapBody)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_SOURCE_PROJECTION_INVALID"
    );
  }, 20_000);

  it("来源投影拒绝自洽内容伪造和基本题面/题解之外的额外任务内容", () => {
    const forgedStatement = createBridgeFixture("projection-content-forgery");
    expect(() => prepare(forgedStatement)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_CASE_BINDING_MISMATCH"
    );

    const extraContent = createBridgeFixture("projection-extra-content");
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
      "case-0001",
      "taskDraft"
    );
    const nonCanonicalPlan = readJson(nonCanonicalTitle.input.bridgePlanPath);
    const nonCanonicalCase = nonCanonicalPlan.cases.find(
      (entry: { caseId: string }) => entry.caseId === "case-0001"
    );
    if (nonCanonicalCase === undefined) throw new Error("TEST_PLAN_CASE_MISSING");
    rewriteBridgeInput(
      nonCanonicalTitle,
      "case-0001.mapping.private.json",
      (value) => ({
        ...value,
        taskDraftSha256: nonCanonicalCase.taskDraft.sha256
      }),
      "case-0001",
      "sourceMapping"
    );
    expect(() => prepare(nonCanonicalTitle)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_TASK_INVALID"
    );

    const unboundPlaceholder = createBridgeFixture("mapping-placeholder");
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

    rewriteBridgeInput(
      fixture,
      "case-0001.mapping.private.json",
      (value) => ({ ...value, taskDraftSha256: sha256(taskBytes) }),
      "case-0001",
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
    }), "case-0001", "originalAnklangResponse");
    expect(() => prepare(incomplete)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_INVALID"
    );

    const contentMismatch = createBridgeFixture("anklang-content-mismatch");
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
      "case-0001",
      "originalAnklangRequest"
    );
    expect(() => prepare(extraField)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_ANKLANG_REQUEST_INVALID"
    );

    const changedProblem = createBridgeFixture("anklang-request-problem-mismatch");
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
    mutateWorktreeFile(join(dirtyCapturer.capturerRepository, "untracked.txt"), "dirty\n");
    expect(() => prepare(dirtyCapturer)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_PREPARATION_IDENTITY_INVALID"
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
      "case-0001",
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
      "REVIEW_FLOW_EVALUATION_BRIDGE_PREPARATION_MISMATCH"
    );

    const failed = createBridgeFixture("anklang-verifier-failed");
    const failedManifest = readJson(failed.captureVerifierManifestPath);
    writePrivate(
      failed.captureVerifierManifestPath,
      pretty({ ...failedManifest, mode: "fail" })
    );
    expect(() => prepare(failed)).toThrow(
      "REVIEW_FLOW_EVALUATION_BRIDGE_PREPARATION_MISMATCH"
    );
  });

  it("development nonce 必须恰为 256 bit，短随机输入在发布前拒绝", () => {
    const short = createBridgeFixture("nonce-short");
    expect(() => prepareReviewFlowEvaluationDatasetBridge({
      ...short.input,
      randomBytes: () => Buffer.alloc(31, 1)
    })).toThrow("REVIEW_FLOW_EVALUATION_BRIDGE_RANDOMNESS_INVALID");

    const ok = createBridgeFixture("nonce-ok");
    const result = prepare(ok);
    const descriptor = readJson(result.developmentRevealDescriptorPath);
    expect(descriptor.commitmentNonce).toMatch(/^[0-9a-f]{64}$/u);
    expect(descriptor.commitmentNonce).toBe(
      Buffer.alloc(32, 1).toString("hex")
    );
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
  it("CLI --urmotiv-repo 可选：省略时 urmotivRepo 为 undefined，提供时回传绝对路径", () => {
    const baseArguments = [
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
      "--development-reveal-out=/private/dev-reveal"
    ];
    expect(
      parseReviewFlowDatasetBridgeArguments(baseArguments).urmotivRepo
    ).toBeUndefined();
    expect(
      parseReviewFlowDatasetBridgeArguments([
        ...baseArguments,
        "--urmotiv-repo=/private/urmotiv-clean"
      ]).urmotivRepo
    ).toBe("/private/urmotiv-clean");
    expect(() => parseReviewFlowDatasetBridgeArguments([
      ...baseArguments,
      "--urmotiv-repo=/private/a",
      "--urmotiv-repo=/private/b"
    ])).toThrow("REVIEW_FLOW_EVALUATION_BRIDGE_ARGUMENT_INVALID");
  });

  it("--urmotiv-repo 覆盖：主 Urmotiv 脏时，干净精确 pinned 覆盖通过且产出与无覆盖逐字节相同", () => {
    const fixture = createBridgeFixture("override-clean-clone");
    const primaryUrmotiv = join(fixture.workspace, "Urmotiv");

    // Run without override first (primary is clean) — capture bytes.
    const directResult = prepareReviewFlowEvaluationDatasetBridge({
      ...fixture.input,
      randomBytes: sequentialRandomBytes()
    });
    // Recursively inventory the direct output and reveal trees.
    const directOutputFiles = recursiveDirectoryInventory(fixture.output);
    const directRevealFiles = recursiveDirectoryInventory(
      fixture.input.developmentRevealDirectory
    );

    // Fresh output directories for the override run (same fixture, same seed).
    const overrideOutput = join(fixture.privateRoot, "override-output");
    const overrideReveal = join(fixture.privateRoot, "override-reveal");

    // Clone the primary Urmotiv to a clean independent checkout (not worktree).
    const cleanClone = join(fixture.workspace, "Urmotiv-clean");
    execFileSync("/usr/bin/git", ["clone", "-q", primaryUrmotiv, cleanClone]);
    const pinnedCommit = execFileSync(
      "/usr/bin/git", ["rev-parse", "HEAD"],
      { cwd: primaryUrmotiv, encoding: "utf8" }
    ).trim();
    execFileSync("/usr/bin/git", ["checkout", "-q", pinnedCommit], {
      cwd: cleanClone
    });
    // The synthetic verifier reads .synthetic-attestation-output from its cwd
    // (the repo dir).  This file is gitignored so the clone lacks it; write
    // the same synthetic attestation bytes into the clone.
    writeFileSync(
      join(cleanClone, ".synthetic-attestation-output"),
      readFileSync(fixture.verifierOutputPath),
      { mode: 0o600 }
    );

    // Dirty the primary Urmotiv so the default path would fail.
    mutateWorktreeFile(
      join(primaryUrmotiv, "scripts", "migrate-hist", "prepare-review-gold.py"),
      "dirty\n"
    );
    expect(
      execFileSync("/usr/bin/git", ["status", "--porcelain"], {
        cwd: primaryUrmotiv, encoding: "utf8"
      }).trim().length
    ).toBeGreaterThan(0);

    // The override must point at the clean clone and still succeed.
    const overrideResult = prepareReviewFlowEvaluationDatasetBridge({
      ...fixture.input,
      outputDirectory: overrideOutput,
      developmentRevealDirectory: overrideReveal,
      urmotivRepositoryDirectory: cleanClone,
      randomBytes: sequentialRandomBytes()
    });
    expect(overrideResult.caseCount).toBe(32);
    expect(overrideResult.developmentCount).toBe(32);
    expect(overrideResult.holdoutCount).toBe(0);

    // Recursively inventory the override output and reveal trees.
    const overrideOutputFiles = recursiveDirectoryInventory(overrideOutput);
    const overrideRevealFiles = recursiveDirectoryInventory(overrideReveal);

    // Assert identical file sets — no extras, no missing.
    expect(overrideOutputFiles).toEqual(directOutputFiles);
    expect(overrideRevealFiles).toEqual(directRevealFiles);

    // Assert every corresponding file's bytes are equal.
    for (const relPath of directOutputFiles) {
      expect(readFileSync(join(overrideOutput, relPath))).toEqual(
        readFileSync(join(fixture.output, relPath))
      );
    }
    for (const relPath of directRevealFiles) {
      expect(readFileSync(join(overrideReveal, relPath))).toEqual(
        readFileSync(join(fixture.input.developmentRevealDirectory, relPath))
      );
    }
  });

  it("--urmotiv-repo 覆盖：脏覆盖以固定错误码失败关闭", () => {
    const fixture = createBridgeFixture("override-dirty-clone");
    const primaryUrmotiv = join(fixture.workspace, "Urmotiv");
    const dirtyClone = join(fixture.workspace, "Urmotiv-dirty");
    execFileSync("/usr/bin/git", ["clone", "-q", primaryUrmotiv, dirtyClone]);
    const pinnedCommit = execFileSync(
      "/usr/bin/git", ["rev-parse", "HEAD"],
      { cwd: primaryUrmotiv, encoding: "utf8" }
    ).trim();
    execFileSync("/usr/bin/git", ["checkout", "-q", pinnedCommit], {
      cwd: dirtyClone
    });
    // Make the clone dirty.
    writeFileSync(
      join(dirtyClone, "scripts", "migrate-hist", "prepare-review-gold.py"),
      "dirty\n",
      { mode: 0o600 }
    );
    expect(() => prepareReviewFlowEvaluationDatasetBridge({
      ...fixture.input,
      urmotivRepositoryDirectory: dirtyClone,
      randomBytes: sequentialRandomBytes()
    })).toThrow("REVIEW_FLOW_EVALUATION_BRIDGE_INPUT_INVALID");
  });

  it("--urmotiv-repo 覆盖：错误 commit 覆盖以固定错误码失败关闭", () => {
    const fixture = createBridgeFixture("override-wrong-commit");
    const primaryUrmotiv = join(fixture.workspace, "Urmotiv");
    const wrongCommitClone = join(fixture.workspace, "Urmotiv-wrong-commit");
    execFileSync("/usr/bin/git", ["clone", "-q", primaryUrmotiv, wrongCommitClone]);
    // Create a second commit so HEAD diverges from the pinned version.
    writeFileSync(
      join(wrongCommitClone, "scripts", "migrate-hist", "extra.txt"),
      "extra\n",
      { mode: 0o600 }
    );
    execFileSync("/usr/bin/git", ["add", "."], { cwd: wrongCommitClone });
    execFileSync("/usr/bin/git", [
      "-c", "user.name=Test",
      "-c", "user.email=test@example.invalid",
      "commit", "-q", "-m", "divergent"
    ], { cwd: wrongCommitClone });
    expect(() => prepareReviewFlowEvaluationDatasetBridge({
      ...fixture.input,
      urmotivRepositoryDirectory: wrongCommitClone,
      randomBytes: sequentialRandomBytes()
    })).toThrow("REVIEW_FLOW_EVALUATION_BRIDGE_INPUT_INVALID");
  });

  it("--urmotiv-repo 覆盖：不存在的目录以固定错误码失败关闭", () => {
    const fixture = createBridgeFixture("override-missing");
    expect(() => prepareReviewFlowEvaluationDatasetBridge({
      ...fixture.input,
      urmotivRepositoryDirectory: join(fixture.workspace, "does-not-exist"),
      randomBytes: sequentialRandomBytes()
    })).toThrow("REVIEW_FLOW_EVALUATION_BRIDGE_INPUT_INVALID");
  });

  it("--urmotiv-repo 覆盖：非 Git 仓库以固定错误码失败关闭", () => {
    const fixture = createBridgeFixture("override-non-repo");
    const notARepo = join(fixture.workspace, "not-a-repo");
    mkdirSync(join(notARepo, "scripts", "migrate-hist"), {
      recursive: true, mode: 0o700
    });
    expect(() => prepareReviewFlowEvaluationDatasetBridge({
      ...fixture.input,
      urmotivRepositoryDirectory: notARepo,
      randomBytes: sequentialRandomBytes()
    })).toThrow("REVIEW_FLOW_EVALUATION_BRIDGE_INPUT_INVALID");
  });

  it("--urmotiv-repo 覆盖：私有输入路径越出 privateRoot 时以路径约束错误码失败关闭", () => {
    const fixture = createBridgeFixture("override-private-escape");
    const primaryUrmotiv = join(fixture.workspace, "Urmotiv");
    const cleanClone = join(fixture.workspace, "Urmotiv-clean-escape");
    execFileSync("/usr/bin/git", ["clone", "-q", primaryUrmotiv, cleanClone]);
    const pinnedCommit = execFileSync(
      "/usr/bin/git", ["rev-parse", "HEAD"],
      { cwd: primaryUrmotiv, encoding: "utf8" }
    ).trim();
    execFileSync("/usr/bin/git", ["checkout", "-q", pinnedCommit], {
      cwd: cleanClone
    });
    writeFileSync(
      join(cleanClone, ".synthetic-attestation-output"),
      readFileSync(fixture.verifierOutputPath),
      { mode: 0o600 }
    );
    // Point the bridgePlanPath outside privateRoot — under the clean clone,
    // which is inside containingWorkspace but outside privateRoot.
    // The bridge must reject this for path confinement, not follow the path.
    const escapedBridgePlan = join(cleanClone, "bridge-plan.private.json");
    writeFileSync(escapedBridgePlan, readFileSync(fixture.input.bridgePlanPath));
    expect(() => prepareReviewFlowEvaluationDatasetBridge({
      ...fixture.input,
      bridgePlanPath: escapedBridgePlan,
      urmotivRepositoryDirectory: cleanClone,
      randomBytes: sequentialRandomBytes()
    })).toThrow("REVIEW_FLOW_EVALUATION_BRIDGE_INPUT_INVALID");
  });

  it("--urmotiv-repo 覆盖：私有输入路径越出 containingWorkspace 时以路径约束错误码失败关闭", () => {
    const fixture = createBridgeFixture("override-private-escape-workspace");
    const primaryUrmotiv = join(fixture.workspace, "Urmotiv");
    const cleanClone = join(fixture.workspace, "Urmotiv-clean-escape-ws");
    execFileSync("/usr/bin/git", ["clone", "-q", primaryUrmotiv, cleanClone]);
    const pinnedCommit = execFileSync(
      "/usr/bin/git", ["rev-parse", "HEAD"],
      { cwd: primaryUrmotiv, encoding: "utf8" }
    ).trim();
    execFileSync("/usr/bin/git", ["checkout", "-q", pinnedCommit], {
      cwd: cleanClone
    });
    writeFileSync(
      join(cleanClone, ".synthetic-attestation-output"),
      readFileSync(fixture.verifierOutputPath),
      { mode: 0o600 }
    );
    // Create a separate absolute temporary root that is neither inside
    // fixture.workspace (containingWorkspace) nor privateRoot.
    const externalRoot = mkdtempSync(join(tmpdir(), "fermata-escape-"));
    temporaryRoots.push(externalRoot);
    const escapedBridgePlan = join(externalRoot, "bridge-plan.private.json");
    writeFileSync(escapedBridgePlan, readFileSync(fixture.input.bridgePlanPath), {
      mode: 0o600
    });
    expect(() => prepareReviewFlowEvaluationDatasetBridge({
      ...fixture.input,
      bridgePlanPath: escapedBridgePlan,
      urmotivRepositoryDirectory: cleanClone,
      randomBytes: sequentialRandomBytes()
    })).toThrow("REVIEW_FLOW_EVALUATION_BRIDGE_INPUT_INVALID");
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
  const genericProjectionMethods: readonly SourceProjectionMethod[] = [
    "markdown_solution_heading_v1",
    "algorithm_heading_v1",
    "last_horizontal_rule_v1",
    "operator_explicit_offsets_v1"
  ];
  // v5 上游固定 36 例：前 32 例 verdict_and_taste（20 accepted + 12 rejected），
  // 第 33-35 例 originality_only，第 36 例 solution_missing；后 4 例由准备器排除。
  const upstreamCaseCount = 36;
  const regularCaseId = (index: number) =>
    `case-${String(index + 1).padStart(4, "0")}`;
  const includedCaseId = (index: number) =>
    index === 0 ? "case-0001"
      : index === 1 ? "case-upstream-hold"
      : regularCaseId(index);
  const subjectIdFor = (index: number) =>
    index === 0 ? "subject-synthetic-dev"
      : index === 1 ? "subject-synthetic-holdout"
      : `subject-synthetic-${String(index + 1).padStart(4, "0")}`;
  const rowId = (index: number) =>
    `review-row-${String(index + 1).padStart(6, "0")}`;
  const sourceId = (index: number) =>
    `source-${String(index + 1).padStart(6, "0")}`;
  const safeId = (index: number) =>
    index === 0 ? "case-0001"
      : index === 1 ? "case-9001"
      : regularCaseId(index);
  const isOriginalityOnly = (index: number) => index >= 33;
  const verdictFor = (index: number) =>
    index === 0 || index >= 21 ? "rejected" : "accepted";
  const contestUseFor = (index: number) =>
    verdictFor(index) === "accepted" ? "used" : "not_used";

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
  const verifier = createSyntheticVerifier(workspace);

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
        presentRowCount: upstreamCaseCount,
        maximumRowNumber: upstreamCaseCount,
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

  const problemInputs = Array.from({ length: upstreamCaseCount }, (_, index) =>
    problemHashInput(
      index + 1,
      index === 1 ? solutionSuffixes[1] : solutionSuffixes[0],
      index === 1
        ? options.secondPlaceholderTagIds ?? ["tag-basic"]
        : ["tag-basic"]
    )
  );
  const sourceDefinitions = problemInputs.map((problemInput, index) => {
    const method = index < 2 ? projectionMethods[index]!
      : genericProjectionMethods[(index - 2) % genericProjectionMethods.length]!;
    return {
      index,
      sourceId: sourceId(index),
      sourcePath: `${sourceId(index)}.md`,
      metadataNumber: String(101 + index),
      content: sourceBytes(problemInput, method)
    };
  });
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
    fragmentCount: upstreamCaseCount,
    sourceCount: upstreamCaseCount,
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
    sourceCount: upstreamCaseCount,
    fragmentCount: upstreamCaseCount,
    unresolvedItemCount: 0
  };
  const materializationMarkerBytes = pretty(materializationMarker);
  writePrivate(join(materialized, "MATERIALIZE_COMPLETE"), materializationMarkerBytes);

  const rows = Array.from({ length: upstreamCaseCount }, (_, index) => {
    const reviewComments = index === 0 ? ["synthetic style concern", ""]
      : index < 33 && verdictFor(index) === "rejected"
      ? ["synthetic rejected comment"]
      : [""];
    const reviewCommentPresent = reviewComments.some((comment) => comment !== "");
    return {
      rowId: rowId(index),
      inputId: `input-${String((index % 2) + 1).padStart(6, "0")}`,
      worksheetId: "worksheet-000001",
      sourceRowNumber: index + 1,
      metadataNumber: String(101 + index),
      identityValues: [`Synthetic ${index + 1}`],
      finalDecisionText: isOriginalityOnly(index) ? ""
        : contestUseFor(index) === "used" ? "synthetic accepted"
        : "synthetic rejected",
      contestUseText: isOriginalityOnly(index) ? ""
        : contestUseFor(index) === "used" ? "synthetic used"
        : "synthetic not used",
      reviewComments,
      reviewCommentPresent
    };
  });
  const rowsWithEvidence = rows.map((row) => ({
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
    rows: rowsWithEvidence,
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
    rowCount: rowsWithEvidence.length,
    sourceCount: sourceDefinitions.length,
    reviewCommentRowCount: rowsWithEvidence.filter(
      (entry) => entry.reviewCommentPresent
    ).length
  };
  const worksheetCompletionPath = join(
    evidenceInputDirectory,
    "REVIEW_WORKSHEET_COMPLETE"
  );
  const worksheetCompletionBytes = pretty(worksheetCompletion);
  writePrivate(worksheetCompletionPath, worksheetCompletionBytes);

  const upstreamCases = Array.from({ length: upstreamCaseCount }, (_, index) => {
    const common = {
      index,
      caseId: regularCaseId(index),
      subjectId: subjectIdFor(index),
      rowId: rowId(index),
      sourceId: sourceId(index),
      sourceSha256: sha256(sourceDefinitions[index]!.content),
      purpose: "development" as const,
      confirmed: true as const
    };
    if (isOriginalityOnly(index)) {
      return {
        ...common,
        evaluationScope: "originality_only" as const,
        sameProblemAsExisting: true as const
      };
    }
    return {
      ...common,
      evaluationScope: "verdict_and_taste" as const,
      verdict: verdictFor(index),
      contestUse: contestUseFor(index)
    };
  }) as {
    index: number;
    caseId: string;
    subjectId: string;
    rowId: string;
    sourceId: string;
    sourceSha256: string;
    purpose: "development";
    evaluationScope: "verdict_and_taste" | "originality_only";
    verdict?: "accepted" | "rejected";
    contestUse?: "used" | "not_used";
    sameProblemAsExisting?: boolean;
  }[];
  const upstreamPlan = {
    version: 3,
    confirmed: true,
    submitterDifficultyColumnsExcludedReconfirmed: true,
    datasetId: `history-${safeToken(seed)}`,
    worksheetSha256: sha256(worksheetBytes),
    sourceConfirmationSha256: compactSha256(sourceConfirmation),
    // fixtures keep index for their own builders; the strict upstream plan
    // schema does not accept it
    cases: upstreamCases.map(({ index: _index, ...rest }) => rest)
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

  const upstreamGoldValues = upstreamCases.map((entry) => isOriginalityOnly(entry.index) ? {
    version: 2,
    artifactKind: "historical_review_gold",
    caseId: entry.caseId,
    reviewCommentPresent: rowsWithEvidence[entry.index]!.reviewCommentPresent,
    evaluationScope: "originality_only",
    sameProblemAsExisting: true
  } : {
    version: 2,
    artifactKind: "historical_review_gold",
    caseId: entry.caseId,
    reviewCommentPresent: rowsWithEvidence[entry.index]!.reviewCommentPresent,
    evaluationScope: "verdict_and_taste",
    verdict: entry.verdict,
    contestUse: entry.contestUse
  });
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
      rowEvidenceSha256: rowsWithEvidence[index]!.rowEvidenceSha256
    }))
  };
  const bindingsBytes = pretty(bindings);
  writePrivate(join(upstreamGold, "source-bindings.private.json"), bindingsBytes);
  const additions = {
    version: 1,
    priorTuningHistorySha256: sha256(tuningHistoryBytes),
    developmentSamples: upstreamCases.map((entry) => ({
      subjectId: entry.subjectId,
      contentSha256: entry.sourceSha256
    }))
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
    caseCount: 36,
    developmentCount: 36,
    holdoutCount: 0,
    verdictAndTasteCount: 33,
    originalityOnlyCount: 3
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
  const preparedBindings: Record<string, {
    taskDraft: { fileName: string; sha256: string };
    problemHashInput: { fileName: string; sha256: string };
    originalAnklangRequest: { fileName: string; sha256: string };
    originalAnklangResponse: { fileName: string; sha256: string };
    sourceMapping: { fileName: string; sha256: string };
  }> = {};
  const includedCaseDefinitions = Array.from({ length: 32 }, (_, index) => {
    const entry = upstreamCases[index]!;
    const row = rowsWithEvidence[index]!;
    const source = sourceDefinitions[index]!;
    const thisSafeId = safeId(index);
    const baseHashInput = problemInputs[index]!;
    const hashInput =
      seed === "projection-content-forgery"
        ? {
            ...baseHashInput,
            content: {
              ...baseHashInput.content,
              basicStatement: `${baseHashInput.content.basicStatement} forged`
            }
          }
        : seed === "projection-extra-content"
          ? {
              ...baseHashInput,
              content: {
                ...baseHashInput.content,
                basicSolution: `题解 ${baseHashInput.content.basicSolution} extra`
              }
            }
          : seed === "mapping-placeholder"
            ? { ...baseHashInput, tagIds: ["missing-tag"] }
            : baseHashInput;
    const contentHash = computeUrmotivProblemContentHash(hashInput);
    const hashInputBytes = pretty(hashInput);
    const hashInputFileName = `${thisSafeId}.problem-hash-input.private.json`;
    writePrivate(join(bridgeInput, hashInputFileName), hashInputBytes);
    const task = taskDraft(index + 1, contentHash, catalog, hashInput);
    const taskBytes = pretty(task);
    const taskFileName = `${thisSafeId}.task.private.json`;
    writePrivate(join(bridgeInput, taskFileName), taskBytes);
    const requestId = `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const anklangRequest =
      seed === "anklang-request-problem-mismatch"
        ? {
            apiVersion: "2",
            requestId,
            contentHash,
            problem: {
              title: task.problem.title,
              type: task.problem.type,
              tagIds: task.problem.tagIds,
              basicStatement: "different statement"
            }
          }
        : {
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
    const anklangRequestFileName = `${thisSafeId}.anklang-request.private.json`;
    writePrivate(join(bridgeInput, anklangRequestFileName), anklangRequestBytes);
    const candidates = index === 0 ? developmentCandidates : [];
    const anklang = seed === "anklang-content-mismatch"
      ? {
          apiVersion: "2",
          contentHash: index === 0 ? "e".repeat(64) : contentHash,
          checkedAt: "2026-08-01T00:00:00.000Z",
          candidates: index === 0 ? developmentCandidates : [],
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
        }
      : {
          apiVersion: "2",
          contentHash,
          checkedAt: "2026-08-01T00:00:00.000Z",
          candidates: index === 0 ? developmentCandidates : [],
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
    const anklangFileName = `${thisSafeId}.anklang.private.json`;
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
    // 内容伪造种子必须自洽：task/hashInput/request/anklang 全部带伪造内容，
    // 但不可变的物化源仍保留原文，因此投影偏移按原文定位，内容级绑定校验拒绝。
    const statementBytes = Buffer.from(
      seed === "projection-content-forgery"
        ? baseHashInput.content.basicStatement
        : task.problem.content.basicStatement
    );
    const solutionBytes = Buffer.from(
      seed === "projection-extra-content"
        ? baseHashInput.content.basicSolution
        : task.problem.content.basicSolution
    );
    const sourceContent = source.content;
    const statementStartByte = sourceContent.indexOf(statementBytes);
    const solutionStartByte = sourceContent.indexOf(solutionBytes);
    if (statementStartByte < 0 || solutionStartByte < 0) {
      throw new Error("TEST_SOURCE_PROJECTION_MISSING");
    }
    // 错位/半字符/伪造方法/遗漏首尾/边界夹带正文等投影缺陷必须在封存前写入
    // mapping：绑定随文件重算后，只能由投影内容级校验拒绝。
    let titleIdentityValueIndex = 0;
    let sourceProjection: {
      method: SourceProjectionMethod;
      statement: { startByte: number; endByte: number };
      solution: { startByte: number; endByte: number };
    } = {
      method: index < 2 ? projectionMethods[index]!
        : genericProjectionMethods[(index - 2) % genericProjectionMethods.length]!,
      statement: {
        startByte: statementStartByte,
        endByte: statementStartByte + statementBytes.byteLength
      },
      solution: {
        startByte: solutionStartByte,
        endByte: solutionStartByte + solutionBytes.byteLength
      }
    };
    if (seed === "projection-wrong-offset" && index === 1) {
      sourceProjection = {
        ...sourceProjection,
        solution: {
          ...sourceProjection.solution,
          startByte: sourceProjection.solution.startByte + 3
        }
      };
    }
    if (seed === "projection-utf8-midpoint" && index === 1) {
      sourceProjection = {
        ...sourceProjection,
        statement: { ...sourceProjection.statement, endByte: 1 }
      };
    }
    if (seed === "projection-title-index" && index === 0) {
      titleIdentityValueIndex = 1;
    }
    if (seed === "projection-false-method" && index === 0) {
      sourceProjection = {
        ...sourceProjection,
        method: "algorithm_heading_v1"
      };
    }
    if (seed === "projection-omitted-prefix" && index === 1) {
      sourceProjection = {
        ...sourceProjection,
        statement: { ...sourceProjection.statement, startByte: 3 }
      };
    }
    if (seed === "projection-omitted-suffix" && index === 1) {
      sourceProjection = {
        ...sourceProjection,
        solution: {
          ...sourceProjection.solution,
          endByte: sourceProjection.solution.endByte - 1
        }
      };
    }
    if (seed === "projection-hidden-gap-body" && index === 0) {
      sourceProjection = {
        ...sourceProjection,
        statement: {
          ...sourceProjection.statement,
          endByte: sourceProjection.statement.endByte - 1
        }
      };
    }
    const projectionFields = {
      titleIdentityValueIndex,
      sourceProjection,
      problemTypeBasis: "operator_confirmed",
      currentTagIdsBasis: "calibration_placeholder_not_gold",
      placeholderTagIds: hashInput.tagIds
    };
    const mapping = {
      schemaVersion: 2,
      artifactKind: "review_flow_evaluation_source_mapping",
      confirmed: true,
      caseId: entry.caseId,
      safeId: thisSafeId,
      subjectId: entry.subjectId,
      purpose: entry.purpose,
      sourceId: entry.sourceId,
      sourceSha256: entry.sourceSha256,
      rowEvidenceSha256: row.rowEvidenceSha256,
      reviewInputId: row.inputId,
      worksheetId: row.worksheetId,
      sourceRowNumber: row.sourceRowNumber,
      taskDraftSha256: sha256(taskBytes),
      problemHashInputSha256: sha256(hashInputBytes),
      problemContentHash: contentHash,
      ...projectionFields,
      evaluationScope: "verdict_and_taste",
      historicalReviewReasonMapping: "operator_asserted_sparse_mapping_v1",
      observedHistoricalTasteReasonEvidence: index === 0 ? [{
          reviewCommentIndex: 0,
          reason: {
            dimension: "icpc_fit",
            direction: "concern"
          }
        }] : [],
      observedHistoricalTechnicalReasonEvidence: [] as {
        reviewCommentIndex: number;
        reason: string;
      }[]
    };
    if (seed === "reason-derived-unique" && index === 0) {
      mapping.observedHistoricalTasteReasonEvidence = [
        mapping.observedHistoricalTasteReasonEvidence[0],
        mapping.observedHistoricalTasteReasonEvidence[0]
      ];
      mapping.observedHistoricalTechnicalReasonEvidence = [{
        reviewCommentIndex: 0,
        reason: "judgeability_concern"
      }];
    }
    const mappingBytes = pretty(mapping);
    const mappingFileName = `${thisSafeId}.mapping.private.json`;
    writePrivate(join(bridgeInput, mappingFileName), mappingBytes);
    if (index === 0 && seed === "coordinated-fake-hash") {
      // 在封存前一致改写 task/anklang/mapping 的内容哈希：绑定随文件重算，
      // 准备完成同样封存此状态，因此只能由内容级校验（而非绑定/准备校验）拒绝。
      const fakeHash = "f".repeat(64);
      const changedTaskBytes = pretty({
        ...readJson(join(bridgeInput, taskFileName)),
        problem: {
          ...readJson(join(bridgeInput, taskFileName)).problem,
          contentHash: fakeHash
        }
      });
      writePrivate(join(bridgeInput, taskFileName), changedTaskBytes);
      const changedAnklangBytes = pretty({
        ...readJson(join(bridgeInput, anklangFileName)),
        contentHash: fakeHash
      });
      writePrivate(join(bridgeInput, anklangFileName), changedAnklangBytes);
      const changedMappingBytes = pretty({
        ...readJson(join(bridgeInput, mappingFileName)),
        taskDraftSha256: sha256(changedTaskBytes),
        problemContentHash: fakeHash
      });
      writePrivate(join(bridgeInput, mappingFileName), changedMappingBytes);
      taskBytes.set(changedTaskBytes, 0);
      mappingBytes.set(changedMappingBytes, 0);
      anklangBytes.set(changedAnklangBytes, 0);
    }
    const bindings = {
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
    preparedBindings[entry.caseId] = bindings;
    return {
      caseId: entry.caseId,
      safeId: thisSafeId,
      subjectId: entry.subjectId,
      purpose: entry.purpose,
      sourceId: entry.sourceId,
      sourceSha256: entry.sourceSha256,
      rowEvidenceSha256: row.rowEvidenceSha256,
      ...bindings
    };
  });

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
      materializationReportCanonicalSha256: compactSha256(materializationReport),
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
      rowEvidenceSha256: rowsWithEvidence[index]!.rowEvidenceSha256,
      goldSha256: evidenceEntries[index]!.goldSha256
    })),
    counts: {
      caseCount: 36,
      developmentCount: 36,
      holdoutCount: 0,
      verdictAndTasteCount: 33,
      originalityOnlyCount: 3,
      reviewInputCount: 2,
      materializedSourceCount: 36
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
    captureFingerprint: hashCanonicalValue(captureAttestationWithoutFingerprint)
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
  const captureVerifierManifestBytes = pretty({
    schemaVersion: 1,
    workspace: captureVerifierWorkspace,
    attestationFileName: "verified-attestation.private.json",
    verifierCodeVersion: capturer.identity.codeVersion,
    verifierRunnerSha256: capturer.identity.runnerSha256,
    verifierDependencyCodeSha256: capturer.identity.dependencyCodeSha256,
    mode: "success"
  });
  writePrivate(captureVerifierManifestPath, captureVerifierManifestBytes);
  const captureCompletion = {
    schemaVersion: 1,
    artifactKind: "anklang_review_flow_capture_completion",
    protocolVersion: "anklang-review-flow-capture-v1",
    captureId: captureAttestation.captureId,
    attestationSha256: sha256(captureAttestationBytes),
    captureSetSha256: reviewFlowEvaluationAnklangCaptureSetSha256(captureCases),
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

  // bridge-plan-draft：准备输出中最先发布的草稿，最终化前全部响应绑定均为待定。
  const draftCases = includedCaseDefinitions.map((entry) => {
    const bindings = preparedBindings[entry.caseId]!;
    return {
      caseId: entry.caseId,
      safeId: entry.safeId,
      subjectId: entry.subjectId,
      purpose: "development",
      sourceId: entry.sourceId,
      sourceSha256: entry.sourceSha256,
      rowEvidenceSha256: entry.rowEvidenceSha256,
      taskDraft: bindings.taskDraft,
      problemHashInput: bindings.problemHashInput,
      originalAnklangRequest: bindings.originalAnklangRequest,
      originalAnklangResponse: {
        fileName: `${entry.safeId}.anklang-response.private.json`,
        sha256: null,
        pendingCapture: true
      },
      sourceMapping: bindings.sourceMapping
    };
  });
  const draft = {
    schemaVersion: 1,
    artifactKind: "review_flow_evaluation_bridge_plan_draft",
    intendedBridgeVersion: "urmotiv-review-flow-bridge-v5",
    confirmed: false,
    readyForBridge: false,
    preparationCompletion: {
      fileName: historicalInputPreparationCompletionFileName,
      sha256: null,
      pendingMarkerLastPublication: true
    },
    anklangInputPolicy: "exclude_current_corpus_for_historical_outcome",
    placeholderTagIds: ["tag-basic"],
    upstreamDatasetId: upstreamPlan.datasetId,
    datasetId: `dataset-${sha256(seed).slice(0, 16)}`,
    tagCatalog: { fileName: "tag-catalog.private.json", sha256: sha256(catalogBytes) },
    upstreamVerificationAttestation: {
      fileName: attestationFileName,
      sha256: sha256(attestationBytes)
    },
    anklangCaptureAttestation: {
      fileName: "anklang-capture-attestation.private.json",
      sha256: null,
      pendingCapture: true
    },
    anklangCaptureCompletion: {
      fileName: "anklang-capture-completion.private.json",
      sha256: null,
      pendingCapture: true
    },
    holdoutRegistration: null,
    cases: draftCases,
    unresolvedBindings: [
      "historicalInputPreparationCompletion.sha256",
      "anklangCaptureAttestation.sha256",
      "anklangCaptureCompletion.sha256",
      "cases[*].originalAnklangResponse.sha256"
    ]
  };
  const draftBytes = pretty(draft);
  const draftFileName = "bridge-plan-draft.private.json";
  writePrivate(join(bridgeInput, draftFileName), draftBytes);

  const fermataPreparationIdentity = loadEvaluationCodeIdentity({
    repositoryDirectory: generator.repository,
    expectedCodeVersion: generator.identity.codeVersion,
    runnerPath: "experiments/prepare-review-flow-historical-inputs.ts",
    dependencyPaths: historicalInputPreparationCodePaths
  });
  const repositories = {
    fermata: {
      repository: "Fermata",
      codeVersion: fermataPreparationIdentity.codeVersion,
      runnerPath: "experiments/prepare-review-flow-historical-inputs.ts",
      runnerSha256: fermataPreparationIdentity.runnerSha256,
      dependencyCodeSha256: fermataPreparationIdentity.dependencyCodeSha256,
      dependencyFileCount: fermataPreparationIdentity.dependencyFileCount
    },
    urmotiv: {
      repository: "Urmotiv",
      codeVersion: verifier.identity.codeVersion,
      runnerPath: "scripts/migrate-hist/prepare-review-gold.py",
      runnerSha256: verifier.identity.runnerSha256,
      dependencyCodeSha256: verifier.identity.dependencyCodeSha256,
      dependencyFileCount: 2
    },
    anklang: {
      repository: "Anklang",
      codeVersion: capturer.identity.codeVersion,
      runnerPath: "scripts/capture-review-flow-calibration.py",
      runnerSha256: capturer.identity.runnerSha256,
      dependencyCodeSha256: capturer.identity.dependencyCodeSha256,
      dependencyFileCount: 4
    }
  };
  const markerBases = includedCaseDefinitions.map((entry) => {
    const bindings = preparedBindings[entry.caseId]!;
    return {
      caseId: entry.caseId,
      safeId: entry.safeId,
      subjectId: entry.subjectId,
      purpose: "development",
      sourceId: entry.sourceId,
      sourceSha256: entry.sourceSha256,
      rowEvidenceSha256: entry.rowEvidenceSha256,
      taskDraft: bindings.taskDraft,
      problemHashInput: bindings.problemHashInput,
      originalAnklangRequest: bindings.originalAnklangRequest,
      sourceMapping: bindings.sourceMapping
    };
  });
  const excludedCases = [
    ...Array.from({ length: 3 }, (_, offset) => {
      const entry = upstreamCases[33 + offset]!;
      return {
        caseId: entry.caseId,
        subjectId: entry.subjectId,
        sourceId: entry.sourceId,
        sourceSha256: entry.sourceSha256,
        exclusion: "originality_only" as const
      };
    }),
    {
      caseId: upstreamCases[32]!.caseId,
      subjectId: upstreamCases[32]!.subjectId,
      sourceId: upstreamCases[32]!.sourceId,
      sourceSha256: upstreamCases[32]!.sourceSha256,
      exclusion: "solution_missing" as const
    }
  ];
  const historicalCompletionWithoutFingerprint = {
    schemaVersion: 1,
    artifactKind: "review_flow_historical_input_preparation_completion",
    preparationVersion: historicalInputPreparationVersion,
    complete: true,
    preparationId: `preparation-${sha256(`preparation-${seed}`).slice(0, 16)}`,
    upstreamDatasetId: upstreamPlan.datasetId,
    datasetId: draft.datasetId,
    operatorConfirmationSha256: sha256(`operator-sealed-${seed}`),
    upstreamVerificationAttestation: {
      fileName: attestationFileName,
      sha256: sha256(attestationBytes)
    },
    tagCatalog: { fileName: "tag-catalog.private.json", sha256: sha256(catalogBytes) },
    placeholderTagIds: ["tag-basic"],
    anklangCaptureManifest: {
      fileName: "capture-manifest.private.json",
      sha256: sha256(captureVerifierManifestBytes)
    },
    bridgePlanDraft: { fileName: draftFileName, sha256: sha256(draftBytes) },
    repositories,
    counts: {
      upstreamCaseCount: 36,
      upstreamDevelopmentCount: 36,
      upstreamHoldoutCount: 0,
      upstreamVerdictAndTasteCount: 33,
      upstreamOriginalityOnlyCount: 3,
      excludedOriginalityOnlyCount: 3,
      excludedMissingSolutionCount: 1,
      includedCaseCount: 32,
      acceptedCount: 20,
      rejectedCount: 12,
      holdoutCount: 0
    },
    cases: markerBases,
    excludedCases
  };
  const historicalCompletion = {
    ...historicalCompletionWithoutFingerprint,
    preparationFingerprint: hashCanonicalValue(
      historicalCompletionWithoutFingerprint
    )
  };
  const historicalCompletionBytes = pretty(historicalCompletion);
  const historicalCompletionFileName = historicalInputPreparationCompletionFileName;
  writePrivate(
    join(bridgeInput, historicalCompletionFileName),
    historicalCompletionBytes
  );

  const bridgePlan = {
    schemaVersion: 5,
    artifactKind: "review_flow_evaluation_bridge_plan",
    bridgeVersion: "urmotiv-review-flow-bridge-v5",
    confirmed: true,
    historicalInputPreparationCompletion: {
      fileName: historicalCompletionFileName,
      sha256: sha256(historicalCompletionBytes)
    },
    anklangInputPolicy:
      "exclude_current_corpus_for_historical_outcome",
    placeholderTagIds: ["tag-basic"],
    upstreamDatasetId: upstreamPlan.datasetId,
    datasetId: draft.datasetId,
    tagCatalog: { fileName: "tag-catalog.private.json", sha256: sha256(catalogBytes) },
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
    holdoutRegistration: null,
    cases: includedCaseDefinitions.map((entry) => {
      const bindings = preparedBindings[entry.caseId]!;
      return {
        caseId: entry.caseId,
        safeId: entry.safeId,
        subjectId: entry.subjectId,
        purpose: "development",
        sourceId: entry.sourceId,
        sourceSha256: entry.sourceSha256,
        rowEvidenceSha256: entry.rowEvidenceSha256,
        taskDraft: bindings.taskDraft,
        problemHashInput: bindings.problemHashInput,
        originalAnklangRequest: bindings.originalAnklangRequest,
        originalAnklangResponse: bindings.originalAnklangResponse,
        sourceMapping: bindings.sourceMapping
      };
    })
  };
  const bridgePlanPath = join(bridgeInput, "bridge-plan.private.json");
  writePrivate(bridgePlanPath, pretty(bridgePlan));

  const output = join(privateRoot, "output");
  const developmentReveal = join(privateRoot, "development-reveal");
  return {
    workspace,
    privateRoot,
    bridgeInput,
    upstreamGold,
    materialized,
    output,
    rowEvidenceSha256: rowsWithEvidence[0]!.rowEvidenceSha256,
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
      developmentRevealDirectory: developmentReveal
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
  // 只改写绑定文件本身：plan 已由历史输入准备器封存，改动 plan 会在
  // prep 校验阶段以 PREPARATION_MISMATCH 关闭；文件与封存绑定的 sha 不一致
  // 则在对应阶段（readBoundInput）以阶段码关闭。
  const path = join(fixture.bridgeInput, fileName);
  const changedBytes = pretty(update(readJson(path)));
  writePrivate(path, changedBytes);
  void caseId;
  void bindingKey;
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

/** Recursively list all regular files under `root` as POSIX-style relative paths. */
function recursiveDirectoryInventory(root: string): string[] {
  const entries: string[] = [];
  function walk(dir: string): void {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, name.name);
      if (name.isDirectory()) {
        walk(abs);
      } else if (name.isFile()) {
        entries.push(relative(root, abs).split(sep).join("/"));
      }
    }
  }
  walk(root);
  return entries.sort();
}

function createSyntheticFermataGenerator(workspace: string) {
  const repository = join(workspace, "Fermata");
  for (const path of historicalInputPreparationCodePaths) {
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
  return value.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/-+$/u, "").slice(0, 24).replace(/-+$/u, "");
}
