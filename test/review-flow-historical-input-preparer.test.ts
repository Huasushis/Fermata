import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hashCanonicalValue } from "../src/review-flow/evidence";
import { anklangV2RequestSchema } from "../src/review-flow/task-source";
import { robotReviewTaskSchema } from "../src/urmotiv-schemas";
import {
  buildReviewFlowHistoricalInputArtifacts,
  ReviewFlowHistoricalInputPreparationError,
  reviewFlowHistoricalAnklangCaptureManifestSchema,
  reviewFlowHistoricalBridgePlanDraftSchema,
  reviewFlowHistoricalInputOperatorConfirmationSchema
} from "../experiments/lib/review-flow-historical-input-preparer";
import {
  anklangCaptureDependencyPaths,
  anklangCaptureRunnerPath,
  historicalInputPreparationCodePaths,
  historicalInputPreparationCompletionFileName,
  reviewFlowEvaluationSourceMappingSchema,
  reviewFlowEvaluationTagCatalogSchema,
  reviewFlowHistoricalInputPreparationCompletionSchema,
  upstreamVerifierDependencyPaths,
  upstreamVerifierRunnerPath,
  type ValidatedReviewFlowEvaluationUpstream,
  type ValidatedReviewFlowEvaluationUpstreamCase,
  type VerifiedReviewFlowEvaluationUpstreamSource
} from "../experiments/lib/review-flow-evaluation-bridge";

type BuildInput = Parameters<
  typeof buildReviewFlowHistoricalInputArtifacts
>[0];
type OperatorValue = z.infer<
  typeof reviewFlowHistoricalInputOperatorConfirmationSchema
>;
type OperatorCase = OperatorValue["cases"][number];
type CatalogValue = z.infer<typeof reviewFlowEvaluationTagCatalogSchema>;

const digest = (seed: string): string =>
  createHash("sha256").update(seed).digest("hex");
const digest40 = (seed: string): string => digest(seed).slice(0, 40);

const caseId = (index: number): string =>
  `case-${String(index + 1).padStart(4, "0")}`;
const subjectId = (index: number): string =>
  `subject-synthetic-${String(index + 1).padStart(4, "0")}`;
const sourceId = (index: number): string =>
  `source-${String(index + 1).padStart(6, "0")}`;
const rowId = (index: number): string =>
  `review-row-${String(index + 1).padStart(6, "0")}`;
/** 第 34-36 例为 originality_only，第 33 例被列为 solution_missing。 */
const isOriginalityOnly = (index: number): boolean => index >= 33;
const isMissingSolution = (index: number): boolean => index === 32;
const verdictFor = (index: number): "accepted" | "rejected" =>
  index === 0 || index >= 21 ? "rejected" : "accepted";
const reviewCommentsFor = (index: number): string[] => {
  if (index === 0) return ["synthetic style concern", ""];
  if (index === 2) return ["synthetic ok", "synthetic checker concern"];
  return [""];
};
const hasRealComment = (index: number): boolean =>
  reviewCommentsFor(index).some((comment) => comment.trim().length > 0);

/** 与 buildCaseArtifacts sourceBytes 逐字节一致的三段式合成源码。 */
function synSourceBytes(index: number): Buffer {
  return Buffer.from(
    `synthetic\n\n题面 Synthetic statement ${index + 1}` +
      `\n**题解**\n题解 Synthetic solution ${index + 1}\n`,
    "utf8"
  );
}

function synProjection(index: number) {
  const bytes = synSourceBytes(index);
  const statementLength = Buffer.from(
    `synthetic\n\n题面 Synthetic statement ${index + 1}`,
    "utf8"
  ).byteLength;
  const solutionStart = bytes.indexOf(
    Buffer.from(`题解 Synthetic solution ${index + 1}`, "utf8")
  );
  return {
    method: "operator_explicit_offsets_v1" as const,
    statement: { startByte: 0, endByte: statementLength },
    solution: { startByte: solutionStart, endByte: bytes.byteLength }
  };
}

function planFor(index: number): ValidatedReviewFlowEvaluationUpstreamCase["plan"] {
  const common = {
    caseId: caseId(index),
    subjectId: subjectId(index),
    rowId: rowId(index),
    sourceId: sourceId(index),
    sourceSha256: digest(`source-${index}`),
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
    contestUse: (verdictFor(index) === "accepted"
      ? "used"
      : "not_used") as "used" | "not_used"
  };
}

function goldFor(index: number) {
  const plan = planFor(index);
  return plan.evaluationScope === "originality_only"
    ? {
        version: 2 as const,
        artifactKind: "historical_review_gold" as const,
        caseId: plan.caseId,
        reviewCommentPresent: false,
        evaluationScope: "originality_only" as const,
        sameProblemAsExisting: true as const
      }
    : {
        version: 2 as const,
        artifactKind: "historical_review_gold" as const,
        caseId: plan.caseId,
        reviewCommentPresent: hasRealComment(index),
        evaluationScope: "verdict_and_taste" as const,
        verdict: verdictFor(index),
        contestUse: (verdictFor(index) === "accepted"
          ? "used"
          : "not_used") as "used" | "not_used"
      };
}

function syntheticCase(index: number): ValidatedReviewFlowEvaluationUpstreamCase {
  const plan = planFor(index);
  return {
    plan,
    evidence: {
      caseId: plan.caseId,
      purpose: plan.purpose,
      evaluationScope: plan.evaluationScope,
      materializedSourceSha256: plan.sourceSha256,
      goldFile: `gold/${plan.caseId}.json`,
      goldSha256: digest(`gold-${plan.caseId}`)
    },
    binding: {
      caseId: plan.caseId,
      subjectId: plan.subjectId,
      sourceId: plan.sourceId,
      sourcePath: `${plan.sourceId}.md`,
      sourceSha256: plan.sourceSha256,
      rowEvidenceSha256: digest(`row-${plan.caseId}`)
    },
    gold: goldFor(index),
    goldSha256: digest(`gold-sha-${plan.caseId}`),
    row: {
      rowId: plan.rowId,
      inputId: "input-000001",
      worksheetId: "worksheet-000001",
      sourceRowNumber: index + 1,
      metadataNumber: String(101 + index),
      identityValues: [`Synthetic ${index + 1}`],
      finalDecisionText: verdictFor(index) === "accepted"
        ? "synthetic accepted"
        : "synthetic rejected",
      contestUseText: verdictFor(index) === "accepted"
        ? "synthetic used"
        : "synthetic not used",
      reviewComments: reviewCommentsFor(index),
      reviewCommentPresent: hasRealComment(index),
      rowEvidenceSha256: digest(`row-${plan.caseId}`)
    },
    source: {
      sourceId: plan.sourceId,
      sourcePath: `${plan.sourceId}.md`,
      sourceSha256: plan.sourceSha256,
      metadataNumber: String(101 + index)
    },
    sourceBytes: synSourceBytes(index)
  };
}

const syntheticDatasetId = "dataset-0123456789abcdef";
const syntheticUpstreamDatasetId = "history-0123456789abcdef";

function upstreamValue(): ValidatedReviewFlowEvaluationUpstream {
  const counts = {
    caseCount: 36,
    developmentCount: 36,
    holdoutCount: 0,
    verdictAndTasteCount: 33,
    originalityOnlyCount: 3,
    reviewInputCount: 1,
    materializedSourceCount: 36
  };
  return {
    markerSha256: digest("marker-sha"),
    evidenceSha256: digest("evidence-sha"),
    bindingsSha256: digest("bindings-sha"),
    tuningHistoryAdditionsSha256: digest("tuning-additions-sha"),
    planSha256: digest("upstream-plan-sha"),
    tuningHistorySha256: digest("tuning-sha"),
    worksheetSha256: digest("worksheet-sha"),
    worksheetCompletionSha256: digest("worksheet-completion-sha"),
    inspectionSha256: digest("inspection-sha"),
    layoutSha256: digest("layout-sha"),
    inputSetSha256: digest("input-set-sha"),
    reviewInputs: [
      {
        inputId: "input-000001",
        format: "spreadsheetml_xml",
        sha256: digest("input-1")
      }
    ],
    sourceConfirmationSha256: digest("source-confirmation-sha"),
    materializationCompleteSha256: digest("materialize-sha"),
    materializationReportCanonicalSha256: digest("materialization-report-sha"),
    materializationSourceSetSha256: digest("materialization-set-sha"),
    materializedSourceCount: 36,
    datasetId: syntheticUpstreamDatasetId,
    counts,
    cases: Array.from({ length: 36 }, (_, index) => syntheticCase(index))
  };
}

function verifiedSource(): VerifiedReviewFlowEvaluationUpstreamSource {
  const upstream = upstreamValue();
  const attestation = {
    schemaVersion: 1,
    artifactKind: "urmotiv_review_gold_verification_attestation",
    protocolVersion: "urmotiv-review-gold-verify-sealed-v1",
    verificationStatus: "complete",
    upstreamDatasetId: syntheticUpstreamDatasetId,
    verifier: {
      repository: "Urmotiv",
      codeVersion: digest40("urmotiv-head"),
      runnerPath: upstreamVerifierRunnerPath,
      runnerSha256: digest("urmotiv-runner"),
      dependencyCodeSha256: digest("urmotiv-deps"),
      dependencyFileCount: upstreamVerifierDependencyPaths.length
    },
    artifacts: {
      reviewGoldCompleteSha256: digest("marker"),
      evidenceSha256: digest("evidence"),
      sourceBindingsSha256: digest("bindings"),
      tuningHistorySha256: digest("tuning"),
      tuningHistoryAdditionsSha256: digest("tuning-additions"),
      planSha256: digest("upstream-plan"),
      worksheetSha256: digest("worksheet"),
      worksheetCompletionSha256: digest("worksheet-completion"),
      inspectionSha256: digest("inspection"),
      layoutSha256: digest("layout"),
      inputSetSha256: digest("input-set"),
      sourceConfirmationCanonicalSha256: digest("source-confirmation"),
      materializationCompleteSha256: digest("materialize"),
      materializationReportCanonicalSha256: digest("materialization-report"),
      materializationSourceSetSha256: digest("materialization-set")
    },
    reviewInputs: [
      {
        inputId: "input-000001",
        format: "spreadsheetml_xml",
        inputSha256: digest("input-1")
      }
    ],
    cases: upstream.cases.map((entry) => ({
      caseId: entry.plan.caseId,
      subjectId: entry.plan.subjectId,
      purpose: entry.plan.purpose,
      evaluationScope: entry.plan.evaluationScope,
      sourceId: entry.plan.sourceId,
      sourcePath: `${entry.plan.sourceId}.md`,
      sourceSha256: entry.plan.sourceSha256,
      rowEvidenceSha256: entry.binding.rowEvidenceSha256,
      goldSha256: entry.goldSha256
    })),
    counts: upstream.counts,
    verificationFingerprint: digest("verification-fingerprint")
  };
  return {
    upstream,
    attestation:
      attestation as VerifiedReviewFlowEvaluationUpstreamSource["attestation"],
    attestationSha256: digest(JSON.stringify(attestation)),
    attestationBytes: Buffer.from(JSON.stringify(attestation), "utf8")
  };
}

function catalogValue(): CatalogValue {
  return {
    schemaVersion: 1,
    version: 3,
    tags: [
      {
        id: "tag-basic",
        name: "基础",
        categoryId: "category-basic",
        categoryName: "基础",
        description: "synthetic tag",
        aliases: [],
        active: true
      }
    ]
  };
}

function operatorCases(): OperatorCase[] {
  return Array.from({ length: 36 }, (_, index): OperatorCase => {
    const common = {
      caseId: caseId(index),
      confirmed: true as const
    };
    if (isOriginalityOnly(index)) {
      return {
        ...common,
        disposition: "exclude_originality_only" as const,
        exclusionConfirmed: true as const
      };
    }
    if (isMissingSolution(index)) {
      return {
        ...common,
        disposition: "exclude_solution_missing" as const,
        exclusionConfirmed: true as const
      };
    }
    return {
      ...common,
      disposition: "include_verdict_and_taste" as const,
      safeId: caseId(index),
      titleIdentityValueIndex: 0,
      titleIdentityConfirmedExact: true as const,
      problemType: "traditional" as const,
      problemTypeConfirmed: true as const,
      sourceProjection: synProjection(index),
      sourceProjectionConfirmed: true as const,
      historicalReviewReasonMapping:
        "operator_asserted_sparse_mapping_v1" as const,
      observedHistoricalTasteReasonEvidence:
        index === 0
          ? [
              {
                reviewCommentIndex: 0,
                reason: { dimension: "icpc_fit", direction: "concern" }
              }
            ]
          : index === 2
          ? [
              {
                reviewCommentIndex: 1,
                reason: {
                  dimension: "statement_expression",
                  direction: "strength"
                }
              }
            ]
          : [],
      observedHistoricalTechnicalReasonEvidence:
        index === 2
          ? [{ reviewCommentIndex: 1, reason: "judgeability_concern" }]
          : []
    };
  });
}

function operatorValue(): OperatorValue {
  return {
    schemaVersion: 1,
    artifactKind: "review_flow_historical_input_operator_confirmation",
    preparationVersion: "urmotiv-historical-review-input-preparation-v1",
    confirmed: true,
    preparationId: "preparation-0123456789abcdef",
    upstreamDatasetId: syntheticUpstreamDatasetId,
    datasetId: syntheticDatasetId,
    repositoryCodeVersions: {
      fermata: digest40("fermata-head"),
      urmotiv: digest40("urmotiv-head"),
      anklang: digest40("anklang-head")
    },
    selection: {
      confirmed: true,
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
    placeholderTagIds: ["tag-basic"],
    placeholderTagIdsConfirmedForWholeBatch: true,
    submitterTagsExcluded: true,
    submitterDifficultyExcluded: true,
    anklangCapture: {
      confirmed: true,
      captureId: "capture-0123456789abcdef",
      endpoint: "https://anklang.example/api/v2/checks/similarity",
      timeoutMs: 30_000,
      externalStatementTransferConfirmed: true,
      runtimeDeclaration: {
        backend: "reverse_proxy",
        searchK: 3,
        minimumSimilarity: 0.95,
        blockThreshold: 0.8,
        similarityBlockEnabled: true,
        cacheTtlSeconds: 120,
        llmReviewEnabled: false,
        llmModel: null,
        llmReviewTopN: null,
        llmEndpointSha256: null,
        reverseProxy: {
          useRerank: false,
          upstreamEndpointSha256: digest("anklang-upstream")
        },
        localEngine: null,
        corpus: {
          evidenceKind: "remote_corpus_unverifiable",
          serviceOriginSha256: digest("anklang-upstream"),
          declarationSha256: digest("anklang-declaration")
        }
      }
    },
    cases: operatorCases()
  };
}

function identities(): BuildInput["identities"] {
  return {
    fermata: {
      repository: "Fermata",
      codeVersion: digest40("fermata-head"),
      runnerPath: "experiments/prepare-review-flow-historical-inputs.ts",
      runnerSha256: digest("fermata-runner"),
      dependencyCodeSha256: digest("fermata-current-paths"),
      dependencyFileCount: historicalInputPreparationCodePaths.length
    },
    urmotiv: {
      repository: "Urmotiv",
      codeVersion: digest40("urmotiv-head"),
      runnerPath: upstreamVerifierRunnerPath,
      runnerSha256: digest("urmotiv-runner"),
      dependencyCodeSha256: digest("urmotiv-deps"),
      dependencyFileCount: upstreamVerifierDependencyPaths.length
    },
    anklang: {
      repository: "Anklang",
      codeVersion: digest40("anklang-head"),
      runnerPath: anklangCaptureRunnerPath,
      runnerSha256: digest("anklang-runner"),
      dependencyCodeSha256: digest("anklang-deps"),
      dependencyFileCount: anklangCaptureDependencyPaths.length
    }
  };
}

function syntheticInput(overrides?: {
  readonly operator?: (value: OperatorValue) => OperatorValue;
  /** 跳过 operator schema 校验，直接以原始值驱动 build() 的防御检查路径。 */
  readonly operatorRaw?: (value: OperatorValue) => OperatorValue;
  readonly upstream?: (
    value: ValidatedReviewFlowEvaluationUpstream
  ) => ValidatedReviewFlowEvaluationUpstream;
}): BuildInput {
  const configuredOperator = overrides?.operator
    ? overrides.operator(operatorValue())
    : operatorValue();
  const configuredSource = overrides?.upstream
    ? { ...verifiedSource(), upstream: overrides.upstream(upstreamValue()) }
    : verifiedSource();
  return {
    operatorFile: {
      bytes: Buffer.from(JSON.stringify(configuredOperator), "utf8"),
      value: overrides?.operatorRaw === undefined
        ? reviewFlowHistoricalInputOperatorConfirmationSchema.parse(
            configuredOperator
          )
        : overrides.operatorRaw(operatorValue()) as OperatorValue,
      sha256: digest("operator-bytes")
    },
    catalogFile: {
      bytes: Buffer.from(JSON.stringify(catalogValue()), "utf8"),
      value: catalogValue(),
      sha256: digest("catalog-bytes")
    },
    verified: configuredSource,
    identities: identities()
  };
}

function expectPreparationError(code: string, run: () => unknown): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReviewFlowHistoricalInputPreparationError);
  expect(
    (caught as ReviewFlowHistoricalInputPreparationError).code
  ).toBe(code);
}

function parseJsonFile(
  files: ReadonlyMap<string, Buffer>,
  fileName: string
): unknown {
  const bytes = files.get(fileName);
  expect(bytes).toBeDefined();
  return JSON.parse((bytes as Buffer).toString("utf8"));
}

describe("review-flow-historical-input-preparer", () => {
  it("由 36 例上游生成 32 个完成计划与 4 个排除项，文件集与计数正确", () => {
    const { files, completionWithoutFingerprint, result } =
      buildReviewFlowHistoricalInputArtifacts(syntheticInput());
    expect(result.datasetId).toBe(syntheticDatasetId);
    expect(result.caseCount).toBe(32);
    expect(result.acceptedCount).toBe(20);
    expect(result.rejectedCount).toBe(12);
    const completion =
      reviewFlowHistoricalInputPreparationCompletionSchema.parse({
        ...completionWithoutFingerprint,
        preparationFingerprint: hashCanonicalValue(
          completionWithoutFingerprint
        )
      });
    expect(completion.counts).toEqual({
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
    });
    expect(completion.cases).toHaveLength(32);
    expect(completion.excludedCases).toHaveLength(4);
    const exclusions = completion.excludedCases.map(
      (entry) => entry.exclusion
    );
    expect(
      exclusions.filter((entry) => entry === "originality_only")
    ).toHaveLength(3);
    expect(
      exclusions.filter((entry) => entry === "solution_missing")
    ).toHaveLength(1);
    // 每个已准备 case 的 4 个私有文件都存在且绑定摘要一致。
    for (const entry of completion.cases) {
      for (const binding of [
        entry.taskDraft,
        entry.problemHashInput,
        entry.originalAnklangRequest,
        entry.sourceMapping
      ]) {
        const bytes = files.get(binding.fileName);
        expect(bytes).toBeDefined();
        expect(
          createHash("sha256").update(bytes as Buffer).digest("hex")
        ).toBe(binding.sha256);
      }
    }
    // 排除项不生成任何计划文件。
    for (const excluded of completion.excludedCases) {
      expect(files.has(`${excluded.caseId}.task.private.json`)).toBe(false);
      expect(files.has(`${excluded.caseId}.source-mapping.private.json`))
        .toBe(false);
    }
    expect(files.has("upstream-verification-attestation.private.json"))
      .toBe(true);
    expect(files.has("tag-catalog.private.json")).toBe(true);
    expect(files.has("capture-manifest.private.json")).toBe(true);
    expect(files.has("bridge-plan-draft.private.json")).toBe(true);
    // 草案：32 个 case 以未解析绑定 + 待捕获响应呈现。
    const draft = reviewFlowHistoricalBridgePlanDraftSchema.parse(
      parseJsonFile(files, "bridge-plan-draft.private.json")
    );
    expect(draft.intendedBridgeVersion).toBe("urmotiv-review-flow-bridge-v5");
    expect(draft.readyForBridge).toBe(false);
    expect(draft.preparationCompletion.fileName).toBe(
      historicalInputPreparationCompletionFileName
    );
    expect(draft.preparationCompletion.sha256).toBeNull();
    expect(draft.cases).toHaveLength(32);
    expect(draft.unresolvedBindings).toEqual([
      "historicalInputPreparationCompletion.sha256",
      "anklangCaptureAttestation.sha256",
      "anklangCaptureCompletion.sha256",
      "cases[*].originalAnklangResponse.sha256"
    ]);
    for (const caseDraft of draft.cases) {
      expect(caseDraft.originalAnklangResponse.pendingCapture).toBe(true);
      expect(caseDraft.originalAnklangResponse.sha256).toBeNull();
    }
  });

  it("映射按索引绑定操作员评注释：taste/technical 使用真实 reviewCommentIndex", () => {
    const { files } = buildReviewFlowHistoricalInputArtifacts(
      syntheticInput()
    );
    const mapping1 = reviewFlowEvaluationSourceMappingSchema.parse(
      parseJsonFile(files, "case-0001.source-mapping.private.json")
    );
    if (mapping1.evaluationScope !== "verdict_and_taste") {
      throw new Error("case-0001 应为 verdict_and_taste 源映射");
    }
    expect(mapping1.historicalReviewReasonMapping)
      .toBe("operator_asserted_sparse_mapping_v1");
    expect(mapping1.observedHistoricalTasteReasonEvidence).toEqual([
      {
        reviewCommentIndex: 0,
        reason: { dimension: "icpc_fit", direction: "concern" }
      }
    ]);
    expect(mapping1.observedHistoricalTechnicalReasonEvidence).toEqual([]);
    const mapping3 = reviewFlowEvaluationSourceMappingSchema.parse(
      parseJsonFile(files, "case-0003.source-mapping.private.json")
    );
    if (mapping3.evaluationScope !== "verdict_and_taste") {
      throw new Error("case-0003 应为 verdict_and_taste 源映射");
    }
    expect(mapping3.observedHistoricalTasteReasonEvidence).toEqual([
      {
        reviewCommentIndex: 1,
        reason: {
          dimension: "statement_expression",
          direction: "strength"
        }
      }
    ]);
    expect(mapping3.observedHistoricalTechnicalReasonEvidence).toEqual([
      { reviewCommentIndex: 1, reason: "judgeability_concern" }
    ]);
  });

  it("Anklang v2 请求严格字段：无 solutions/authors/accounts/testdata/review-opinions", () => {
    const { files } = buildReviewFlowHistoricalInputArtifacts(
      syntheticInput()
    );
    const manifest = reviewFlowHistoricalAnklangCaptureManifestSchema.parse(
      parseJsonFile(files, "capture-manifest.private.json")
    );
    expect(manifest.expectedCaseCount).toBe(32);
    expect(manifest.cases).toHaveLength(32);
    for (const entry of manifest.cases) {
      const bytes = files.get(entry.request.fileName);
      expect(bytes).toBeDefined();
      expect(
        createHash("sha256").update(bytes as Buffer).digest("hex")
      ).toBe(entry.request.sha256);
      const raw = (bytes as Buffer).toString("utf8");
      for (const forbidden of [
        "solutions",
        "authors",
        "accounts",
        "testdata",
        "review-opinion"
      ]) {
        expect(raw).not.toContain(forbidden);
      }
      const request = anklangV2RequestSchema.parse(
        JSON.parse(raw)
      );
      expect(Object.keys(request).sort()).toEqual([
        "apiVersion",
        "contentHash",
        "problem",
        "requestId"
      ]);
      expect(Object.keys(request.problem).sort()).toEqual([
        "basicStatement",
        "tagIds",
        "title",
        "type"
      ]);
    }
    // 请求摘要与任务草稿的内容摘要一致（同一 content hash 链路）。
    const first = manifest.cases[0];
    const task = robotReviewTaskSchema.parse(
      parseJsonFile(
        files,
        `${first.caseId}.task.private.json`
      )
    );
    const request = anklangV2RequestSchema.parse(
      parseJsonFile(files, first.request.fileName)
    );
    expect(request.contentHash).toBe(task.problem.contentHash);
    expect(request.problem.basicStatement.length).toBeGreaterThan(0);
    expect(task.problem.id).toBe(`historical-${first.caseId}`);
  });

  it("拒绝：操作员缺少 case 的确认（OPERATOR_CASE_SET_MISMATCH）", () => {
    expectPreparationError(
      "REVIEW_FLOW_HISTORICAL_OPERATOR_CASE_SET_MISMATCH",
      () =>
        buildReviewFlowHistoricalInputArtifacts(
          syntheticInput({
            operatorRaw: (value) => ({
              ...value,
              cases: value.cases.filter(
                (entry) => entry.caseId !== caseId(5)
              )
            })
          })
        )
    );
  });

  it("拒绝：操作员含重复 caseId（OPERATOR_DUPLICATE）", () => {
    expectPreparationError(
      "REVIEW_FLOW_HISTORICAL_OPERATOR_DUPLICATE",
      () =>
        buildReviewFlowHistoricalInputArtifacts(
          syntheticInput({
            operatorRaw: (value) => ({
              ...value,
              cases: value.cases.map((entry, index) =>
                index === 4 ? { ...entry, caseId: caseId(3) } : entry
              )
            })
          })
        )
    );
  });

  it("拒绝：占位标签不在目录中（PLACEHOLDER_TAG_INVALID）", () => {
    expectPreparationError(
      "REVIEW_FLOW_HISTORICAL_PLACEHOLDER_TAG_INVALID",
      () =>
        buildReviewFlowHistoricalInputArtifacts(
          syntheticInput({
            operator: (value) => ({
              ...value,
              placeholderTagIds: ["tag-missing"]
            })
          })
        )
    );
  });

  it("拒绝：上游计数不一致（UPSTREAM_COUNT_INVALID）", () => {
    expectPreparationError(
      "REVIEW_FLOW_HISTORICAL_UPSTREAM_COUNT_INVALID",
      () =>
        buildReviewFlowHistoricalInputArtifacts(
          syntheticInput({
            upstream: (value) => ({
              ...value,
              counts: { ...value.counts, verdictAndTasteCount: 32 }
            })
          })
        )
    );
  });

  it("拒绝：选中计数不平衡（SELECTION_COUNT_INVALID）", () => {
    expectPreparationError(
      "REVIEW_FLOW_HISTORICAL_SELECTION_COUNT_INVALID",
      () =>
        buildReviewFlowHistoricalInputArtifacts(
          syntheticInput({
            upstream: (value) => ({
              ...value,
              cases: value.cases.map((entry, index) =>
                index === 20
                  ? {
                      ...entry,
                      plan: { ...entry.plan, verdict: "rejected" as const }
                    }
                  : entry
              )
            })
          })
        )
    );
  });

  it("确定性：同一输入两次构建逐字节一致（含文件顺序）", () => {
    const first = buildReviewFlowHistoricalInputArtifacts(
      syntheticInput()
    );
    const second = buildReviewFlowHistoricalInputArtifacts(
      syntheticInput()
    );
    expect([...first.files.keys()]).toEqual([...second.files.keys()]);
    for (const [fileName, bytes] of first.files) {
      const other = second.files.get(fileName);
      expect(other).toBeDefined();
      expect(Buffer.compare(bytes, other as Buffer)).toBe(0);
    }
    expect(hashCanonicalValue(first.completionWithoutFingerprint)).toBe(
      hashCanonicalValue(second.completionWithoutFingerprint)
    );
  });
});