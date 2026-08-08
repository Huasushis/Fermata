/**
 * 已封存历史审核 Gold -> 32 题 verdict/taste 私有桥接输入准备器。
 *
 * 本模块不调用 Anklang 或外部模型，也不猜测标题、题面/题解边界、题型、标签或
 * 历史理由。所有这类信息都必须由严格的操作员确认文件逐项给出；准备结果只写入
 * 0700/0600 私有目录，并以完成标记最后发布。
 */
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import {
  closePrivateDirectory,
  openExistingPrivateDirectory,
  preparePrivateDirectory,
  type PrivateDirectoryHandle
} from "../../scripts/private-runtime.mjs";
import { hashCanonicalValue } from "../../src/review-flow/evidence";
import { anklangV2RequestSchema } from "../../src/review-flow/task-source";
import {
  robotReviewTaskSchema,
  type RobotReviewTask
} from "../../src/urmotiv-schemas";
import {
  anklangCaptureDependencyPaths,
  anklangCaptureRunnerPath,
  computeUrmotivProblemContentHash,
  historicalInputPreparationCodePaths,
  historicalInputPreparationCompletionFileName,
  historicalInputPreparationVersion,
  loadVerifiedReviewFlowEvaluationUpstreamSource,
  projectReviewFlowEvaluationBoundSource,
  reviewFlowEvaluationFileBindingSchema,
  reviewFlowEvaluationProblemHashInputSchema,
  reviewFlowEvaluationSourceMappingSchema,
  reviewFlowEvaluationSourceProjectionSchema,
  reviewFlowEvaluationTagCatalogSchema,
  reviewFlowHistoricalInputPreparationCompletionSchema,
  upstreamVerifierDependencyPaths,
  upstreamVerifierRunnerPath,
  type ReviewFlowEvaluationUpstreamSourceInput,
  type ValidatedReviewFlowEvaluationUpstreamCase,
  type VerifiedReviewFlowEvaluationUpstreamSource
} from "./review-flow-evaluation-bridge";
import {
  reviewFlowEvaluationDatasetIdSchema,
  reviewFlowEvaluationDigestSchema,
  reviewFlowEvaluationPlaceholderTagIdsSchema,
  reviewFlowEvaluationSafeIdSchema,
  reviewFlowEvaluationTasteReasonSchema,
  reviewFlowEvaluationTechnicalReasonSchema
} from "./review-flow-evaluation-dataset";
import {
  loadEvaluationCodeIdentity,
  type EvaluationCodeIdentity
} from "./evaluation-code-identity";
import { parsePhysicalBlindJson } from "./physical-blind-common";
import {
  readPrivateArtifactBytes,
  writePrivateArtifactExclusive
} from "./private-artifact-io";

const preparationRunnerPath =
  "experiments/prepare-review-flow-historical-inputs.ts" as const;
const operatorFileMaximumBytes = 16 * 1024 * 1024;
const tagCatalogMaximumBytes = 4 * 1024 * 1024;
const fixedLeaseExpiry = "2099-01-01T00:00:00.000Z" as const;

const repositoryCodeVersionsSchema = z
  .object({
    fermata: z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/u),
    urmotiv: z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/u),
    anklang: z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/u)
  })
  .strict();

const reviewCommentIndexSchema = z.number().int().nonnegative().max(31);
const tasteReasonEvidenceSchema = z
  .object({
    reviewCommentIndex: reviewCommentIndexSchema,
    reason: reviewFlowEvaluationTasteReasonSchema
  })
  .strict();
const technicalReasonEvidenceSchema = z
  .object({
    reviewCommentIndex: reviewCommentIndexSchema,
    reason: reviewFlowEvaluationTechnicalReasonSchema
  })
  .strict();

const operatorCaseCommon = {
  caseId: z
    .string()
    .regex(/^case-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u),
  confirmed: z.literal(true)
} as const;
const includedOperatorCaseSchema = z
  .object({
    ...operatorCaseCommon,
    disposition: z.literal("include_verdict_and_taste"),
    safeId: reviewFlowEvaluationSafeIdSchema,
    titleIdentityValueIndex: z.number().int().nonnegative().max(7),
    titleIdentityConfirmedExact: z.literal(true),
    problemType: z.enum(["traditional", "interactive", "submit_answer"]),
    problemTypeConfirmed: z.literal(true),
    sourceProjection: reviewFlowEvaluationSourceProjectionSchema,
    sourceProjectionConfirmed: z.literal(true),
    historicalReviewReasonMapping: z.literal(
      "operator_asserted_sparse_mapping_v1"
    ),
    observedHistoricalTasteReasonEvidence: z
      .array(tasteReasonEvidenceSchema)
      .max(48),
    observedHistoricalTechnicalReasonEvidence: z
      .array(technicalReasonEvidenceSchema)
      .max(32)
  })
  .strict();
const excludedOriginalityOperatorCaseSchema = z
  .object({
    ...operatorCaseCommon,
    disposition: z.literal("exclude_originality_only"),
    exclusionConfirmed: z.literal(true)
  })
  .strict();
const excludedMissingSolutionOperatorCaseSchema = z
  .object({
    ...operatorCaseCommon,
    disposition: z.literal("exclude_solution_missing"),
    exclusionConfirmed: z.literal(true)
  })
  .strict();
const operatorCaseSchema = z.discriminatedUnion("disposition", [
  includedOperatorCaseSchema,
  excludedOriginalityOperatorCaseSchema,
  excludedMissingSolutionOperatorCaseSchema
]);

const endpointSchema = z.string().min(1).max(2_000).superRefine(
  (value, context) => {
    if (
      value !== value.trim() ||
      value.includes("\\") ||
      /[\s\u0000-\u001f]/u.test(value)
    ) {
      context.addIssue({ code: "custom", message: "CAPTURE_ENDPOINT_INVALID" });
      return;
    }
    try {
      const parsed = new URL(value);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username.length > 0 ||
        parsed.password.length > 0 ||
        parsed.pathname !== "/api/v2/checks/similarity" ||
        parsed.search.length > 0 ||
        parsed.hash.length > 0
      ) {
        context.addIssue({ code: "custom", message: "CAPTURE_ENDPOINT_INVALID" });
      }
    } catch {
      context.addIssue({ code: "custom", message: "CAPTURE_ENDPOINT_INVALID" });
    }
  }
);

const remoteCorpusSchema = z
  .object({
    evidenceKind: z.literal("remote_corpus_unverifiable"),
    serviceOriginSha256: reviewFlowEvaluationDigestSchema,
    declarationSha256: reviewFlowEvaluationDigestSchema
  })
  .strict();
const reverseProxyRuntimeDeclarationSchema = z
  .object({
    backend: z.literal("reverse_proxy"),
    searchK: z.number().int().min(1).max(20),
    minimumSimilarity: z.number().finite().min(0).max(1),
    blockThreshold: z.number().finite().min(0).max(1),
    similarityBlockEnabled: z.boolean(),
    cacheTtlSeconds: z.number().int().min(60).max(604_800),
    llmReviewEnabled: z.boolean(),
    llmModel: z.string().trim().min(1).max(200).nullable(),
    llmReviewTopN: z.number().int().min(1).max(5).nullable(),
    llmEndpointSha256: reviewFlowEvaluationDigestSchema.nullable(),
    reverseProxy: z
      .object({
        useRerank: z.boolean(),
        upstreamEndpointSha256: reviewFlowEvaluationDigestSchema
      })
      .strict(),
    localEngine: z.null(),
    corpus: remoteCorpusSchema
  })
  .strict()
  .superRefine((runtime, context) => {
    const llmFieldsPresent = runtime.llmModel !== null &&
      runtime.llmReviewTopN !== null &&
      runtime.llmEndpointSha256 !== null;
    const llmFieldsAbsent = runtime.llmModel === null &&
      runtime.llmReviewTopN === null &&
      runtime.llmEndpointSha256 === null;
    if (
      (runtime.llmReviewEnabled && !llmFieldsPresent) ||
      (!runtime.llmReviewEnabled && !llmFieldsAbsent) ||
      runtime.corpus.serviceOriginSha256 !==
        runtime.reverseProxy.upstreamEndpointSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "CAPTURE_RUNTIME_DECLARATION_INVALID"
      });
    }
  });

export const reviewFlowHistoricalInputOperatorConfirmationSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal(
      "review_flow_historical_input_operator_confirmation"
    ),
    preparationVersion: z.literal(historicalInputPreparationVersion),
    confirmed: z.literal(true),
    preparationId: z.string().regex(/^preparation-[0-9a-f]{16}$/u),
    upstreamDatasetId: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
    datasetId: reviewFlowEvaluationDatasetIdSchema,
    repositoryCodeVersions: repositoryCodeVersionsSchema,
    selection: z
      .object({
        confirmed: z.literal(true),
        upstreamCaseCount: z.literal(36),
        upstreamDevelopmentCount: z.literal(36),
        upstreamHoldoutCount: z.literal(0),
        upstreamVerdictAndTasteCount: z.literal(33),
        upstreamOriginalityOnlyCount: z.literal(3),
        excludedOriginalityOnlyCount: z.literal(3),
        excludedMissingSolutionCount: z.literal(1),
        includedCaseCount: z.literal(32),
        acceptedCount: z.literal(20),
        rejectedCount: z.literal(12),
        holdoutCount: z.literal(0)
      })
      .strict(),
    placeholderTagIds: reviewFlowEvaluationPlaceholderTagIdsSchema,
    placeholderTagIdsConfirmedForWholeBatch: z.literal(true),
    submitterTagsExcluded: z.literal(true),
    submitterDifficultyExcluded: z.literal(true),
    anklangCapture: z
      .object({
        confirmed: z.literal(true),
        captureId: z.string().regex(/^capture-[0-9a-f]{16}$/u),
        endpoint: endpointSchema,
        timeoutMs: z.number().int().min(1_000).max(600_000),
        externalStatementTransferConfirmed: z.literal(true),
        runtimeDeclaration: reverseProxyRuntimeDeclarationSchema
      })
      .strict(),
    cases: z.array(operatorCaseSchema).length(36)
  })
  .strict()
  .superRefine((confirmation, context) => {
    const caseIds = confirmation.cases.map((entry) => entry.caseId);
    const included = confirmation.cases.filter(
      (entry) => entry.disposition === "include_verdict_and_taste"
    );
    const safeIds = included.map((entry) => entry.safeId);
    if (
      new Set(caseIds).size !== 36 ||
      new Set(safeIds).size !== 32 ||
      included.length !== 32 ||
      confirmation.cases.filter(
        (entry) => entry.disposition === "exclude_originality_only"
      ).length !== 3 ||
      confirmation.cases.filter(
        (entry) => entry.disposition === "exclude_solution_missing"
      ).length !== 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "HISTORICAL_OPERATOR_SELECTION_INVALID"
      });
    }
  });

export type ReviewFlowHistoricalInputOperatorConfirmation = z.infer<
  typeof reviewFlowHistoricalInputOperatorConfirmationSchema
>;

export const reviewFlowHistoricalAnklangCaptureManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal("anklang_review_flow_v2_capture_manifest"),
    captureId: z.string().regex(/^capture-[0-9a-f]{16}$/u),
    expectedCaseCount: z.literal(32),
    endpoint: endpointSchema,
    timeoutMs: z.number().int().min(1_000).max(600_000),
    externalStatementTransferConfirmed: z.literal(true),
    runtimeDeclaration: reverseProxyRuntimeDeclarationSchema,
    cases: z
      .array(
        z
          .object({
            caseId: operatorCaseCommon.caseId,
            request: reviewFlowEvaluationFileBindingSchema
          })
          .strict()
      )
      .length(32)
  })
  .strict();
const captureManifestSchema = reviewFlowHistoricalAnklangCaptureManifestSchema;

const draftCaseSchema = z
  .object({
    caseId: operatorCaseCommon.caseId,
    safeId: reviewFlowEvaluationSafeIdSchema,
    subjectId: z
      .string()
      .regex(/^subject-[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$/u),
    purpose: z.literal("development"),
    sourceId: z.string().regex(/^source-[0-9]{6}$/u),
    sourceSha256: reviewFlowEvaluationDigestSchema,
    rowEvidenceSha256: reviewFlowEvaluationDigestSchema,
    taskDraft: reviewFlowEvaluationFileBindingSchema,
    problemHashInput: reviewFlowEvaluationFileBindingSchema,
    originalAnklangRequest: reviewFlowEvaluationFileBindingSchema,
    originalAnklangResponse: z
      .object({
        fileName: z.string().min(1).max(180),
        sha256: z.null(),
        pendingCapture: z.literal(true)
      })
      .strict(),
    sourceMapping: reviewFlowEvaluationFileBindingSchema
  })
  .strict();

export const reviewFlowHistoricalBridgePlanDraftSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal("review_flow_evaluation_bridge_plan_draft"),
    intendedBridgeVersion: z.literal("urmotiv-review-flow-bridge-v5"),
    confirmed: z.literal(false),
    readyForBridge: z.literal(false),
    preparationCompletion: z
      .object({
        fileName: z.literal(historicalInputPreparationCompletionFileName),
        sha256: z.null(),
        pendingMarkerLastPublication: z.literal(true)
      })
      .strict(),
    anklangInputPolicy: z.literal(
      "exclude_current_corpus_for_historical_outcome"
    ),
    placeholderTagIds: reviewFlowEvaluationPlaceholderTagIdsSchema,
    upstreamDatasetId: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
    datasetId: reviewFlowEvaluationDatasetIdSchema,
    tagCatalog: reviewFlowEvaluationFileBindingSchema,
    upstreamVerificationAttestation: reviewFlowEvaluationFileBindingSchema,
    anklangCaptureAttestation: z
      .object({
        fileName: z.literal("anklang-capture-attestation.private.json"),
        sha256: z.null(),
        pendingCapture: z.literal(true)
      })
      .strict(),
    anklangCaptureCompletion: z
      .object({
        fileName: z.literal("anklang-capture-completion.private.json"),
        sha256: z.null(),
        pendingCapture: z.literal(true)
      })
      .strict(),
    holdoutRegistration: z.null(),
    cases: z.array(draftCaseSchema).length(32),
    unresolvedBindings: z.tuple([
      z.literal("historicalInputPreparationCompletion.sha256"),
      z.literal("anklangCaptureAttestation.sha256"),
      z.literal("anklangCaptureCompletion.sha256"),
      z.literal("cases[*].originalAnklangResponse.sha256")
    ])
  })
  .strict();

type PreparationCompletion = z.infer<
  typeof reviewFlowHistoricalInputPreparationCompletionSchema
>;
type RepositoryIdentities = PreparationCompletion["repositories"];

export interface PrepareReviewFlowHistoricalInputsInput extends
  ReviewFlowEvaluationUpstreamSourceInput {
  readonly operatorConfirmationPath: string;
  readonly upstreamVerificationAttestationPath: string;
  readonly tagCatalogPath: string;
  readonly outputDirectory: string;
  readonly hooks?: {
    readonly afterArtifactWrite?: (fileName: string) => void;
    readonly beforeCompletionMarker?: () => void;
  };
}

export interface PreparedReviewFlowHistoricalInputs {
  readonly preparationId: string;
  readonly datasetId: string;
  readonly outputDirectory: string;
  readonly caseCount: 32;
  readonly acceptedCount: 20;
  readonly rejectedCount: 12;
  readonly completionPath: string;
  readonly captureManifestPath: string;
  readonly bridgePlanDraftPath: string;
}

export class ReviewFlowHistoricalInputPreparationError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(code);
    this.name = "ReviewFlowHistoricalInputPreparationError";
    this.code = code;
  }
}

interface LoadedPrivateJson<T> {
  readonly bytes: Buffer;
  readonly value: T;
  readonly sha256: string;
}

interface BuiltArtifacts {
  readonly files: ReadonlyMap<string, Buffer>;
  readonly completionWithoutFingerprint: Omit<
    PreparationCompletion,
    "preparationFingerprint"
  >;
  readonly result: Omit<
    PreparedReviewFlowHistoricalInputs,
    "outputDirectory" | "completionPath" | "captureManifestPath" |
      "bridgePlanDraftPath"
  >;
}

/** 完整验证所有私有输入和三仓 clean identity 后才创建输出目录。 */
export function prepareReviewFlowHistoricalInputs(
  input: PrepareReviewFlowHistoricalInputsInput
): PreparedReviewFlowHistoricalInputs {
  try {
    assertInputPaths(input);
    const operatorFile = readAbsoluteJson(
      input.operatorConfirmationPath,
      input,
      reviewFlowHistoricalInputOperatorConfirmationSchema,
      operatorFileMaximumBytes,
      "REVIEW_FLOW_HISTORICAL_OPERATOR_INVALID"
    );
    const catalogFile = readAbsoluteJson(
      input.tagCatalogPath,
      input,
      reviewFlowEvaluationTagCatalogSchema,
      tagCatalogMaximumBytes,
      "REVIEW_FLOW_HISTORICAL_TAG_CATALOG_INVALID"
    );
    const verified = loadVerifiedReviewFlowEvaluationUpstreamSource(input);
    const identities = loadRepositoryIdentities(
      input,
      operatorFile.value,
      verified
    );
    const built = buildReviewFlowHistoricalInputArtifacts({
      operatorFile,
      catalogFile,
      verified,
      identities
    });
    const output = preparePrivateDirectory(
      input.outputDirectory,
      runtimeOptions(input)
    );
    if (!output.created) {
      closePrivateDirectory(output);
      fail("REVIEW_FLOW_HISTORICAL_OUTPUT_EXISTS");
    }
    try {
      assertExactInventory(output, new Set());
      for (const [fileName, bytes] of built.files) {
        publish(output, fileName, bytes);
        input.hooks?.afterArtifactWrite?.(fileName);
      }
      assertExactInventory(output, new Set(built.files.keys()));
      assertSourceFilesUnchanged(input, operatorFile, catalogFile, verified);
      const finalIdentities = loadRepositoryIdentities(
        input,
        operatorFile.value,
        verified
      );
      if (JSON.stringify(finalIdentities) !== JSON.stringify(identities)) {
        fail("REVIEW_FLOW_HISTORICAL_CODE_IDENTITY_CHANGED");
      }
      input.hooks?.beforeCompletionMarker?.();
      const completion = reviewFlowHistoricalInputPreparationCompletionSchema
        .parse({
          ...built.completionWithoutFingerprint,
          preparationFingerprint: hashCanonicalValue(
            built.completionWithoutFingerprint
          )
        });
      const completionBytes = prettyJsonBytes(completion);
      publish(
        output,
        historicalInputPreparationCompletionFileName,
        completionBytes
      );
      assertExactInventory(
        output,
        new Set([
          ...built.files.keys(),
          historicalInputPreparationCompletionFileName
        ])
      );
      return {
        ...built.result,
        outputDirectory: input.outputDirectory,
        completionPath: resolve(
          input.outputDirectory,
          historicalInputPreparationCompletionFileName
        ),
        captureManifestPath: resolve(
          input.outputDirectory,
          "capture-manifest.private.json"
        ),
        bridgePlanDraftPath: resolve(
          input.outputDirectory,
          "bridge-plan-draft.private.json"
        )
      };
    } finally {
      closePrivateDirectory(output);
    }
  } catch (error) {
    if (error instanceof ReviewFlowHistoricalInputPreparationError) throw error;
    fail("REVIEW_FLOW_HISTORICAL_INPUT_PREPARATION_INVALID");
  }
}

/**
 * 纯构造边界，供合成测试覆盖选择、投影和绑定；调用方必须先用上面的正式入口
 * 完成 sealed verifier 与三仓 clean identity 验证。
 */
export function buildReviewFlowHistoricalInputArtifacts(input: {
  readonly operatorFile: LoadedPrivateJson<
    ReviewFlowHistoricalInputOperatorConfirmation
  >;
  readonly catalogFile: LoadedPrivateJson<
    z.infer<typeof reviewFlowEvaluationTagCatalogSchema>
  >;
  readonly verified: VerifiedReviewFlowEvaluationUpstreamSource;
  readonly identities: RepositoryIdentities;
}): BuiltArtifacts {
  const { operatorFile, catalogFile, verified } = input;
  const operator = operatorFile.value;
  const upstream = verified.upstream;
  if (
    operator.upstreamDatasetId !== upstream.datasetId ||
    upstream.cases.length !== 36 ||
    upstream.counts.caseCount !== 36 ||
    upstream.counts.developmentCount !== 36 ||
    upstream.counts.holdoutCount !== 0 ||
    upstream.counts.verdictAndTasteCount !== 33 ||
    upstream.counts.originalityOnlyCount !== 3 ||
    upstream.cases.some((entry) => entry.plan.purpose !== "development")
  ) {
    fail("REVIEW_FLOW_HISTORICAL_UPSTREAM_COUNT_INVALID");
  }
  if (
    operator.repositoryCodeVersions.urmotiv !==
      verified.attestation.verifier.codeVersion
  ) {
    fail("REVIEW_FLOW_HISTORICAL_UPSTREAM_IDENTITY_MISMATCH");
  }
  const catalogIds = new Set(catalogFile.value.tags.map((entry) => entry.id));
  if (
    operator.placeholderTagIds.some((tagId) => !catalogIds.has(tagId))
  ) {
    fail("REVIEW_FLOW_HISTORICAL_PLACEHOLDER_TAG_INVALID");
  }
  const operatorByCase = uniqueMap(
    operator.cases,
    (entry) => entry.caseId,
    "REVIEW_FLOW_HISTORICAL_OPERATOR_DUPLICATE"
  );
  if (
    operatorByCase.size !== upstream.cases.length ||
    upstream.cases.some((entry) => !operatorByCase.has(entry.plan.caseId))
  ) {
    fail("REVIEW_FLOW_HISTORICAL_OPERATOR_CASE_SET_MISMATCH");
  }

  const files = new Map<string, Buffer>();
  const preparedCases: PreparationCompletion["cases"][number][] = [];
  const excludedCases: PreparationCompletion["excludedCases"][number][] = [];
  const draftCases: z.infer<typeof draftCaseSchema>[] = [];
  const captureCases: z.infer<typeof captureManifestSchema>["cases"] = [];
  let acceptedCount = 0;
  let rejectedCount = 0;
  for (const upstreamCase of upstream.cases) {
    const confirmation = operatorByCase.get(upstreamCase.plan.caseId);
    if (confirmation === undefined) {
      fail("REVIEW_FLOW_HISTORICAL_OPERATOR_CASE_SET_MISMATCH");
    }
    if (confirmation.disposition === "exclude_originality_only") {
      if (upstreamCase.plan.evaluationScope !== "originality_only") {
        fail("REVIEW_FLOW_HISTORICAL_EXCLUSION_INVALID");
      }
      excludedCases.push(excludedCase(upstreamCase, "originality_only"));
      continue;
    }
    if (confirmation.disposition === "exclude_solution_missing") {
      if (upstreamCase.plan.evaluationScope !== "verdict_and_taste") {
        fail("REVIEW_FLOW_HISTORICAL_EXCLUSION_INVALID");
      }
      excludedCases.push(excludedCase(upstreamCase, "solution_missing"));
      continue;
    }
    if (upstreamCase.plan.evaluationScope !== "verdict_and_taste") {
      fail("REVIEW_FLOW_HISTORICAL_INCLUDED_SCOPE_INVALID");
    }
    if (upstreamCase.plan.verdict === "accepted") acceptedCount += 1;
    else rejectedCount += 1;
    const prepared = buildCaseArtifacts({
      upstream: upstreamCase,
      confirmation,
      operator,
      catalog: catalogFile.value
    });
    for (const [fileName, bytes] of prepared.files) {
      if (files.has(fileName)) {
        fail("REVIEW_FLOW_HISTORICAL_FILE_NAME_DUPLICATE");
      }
      files.set(fileName, bytes);
    }
    preparedCases.push(prepared.completionCase);
    draftCases.push(prepared.draftCase);
    captureCases.push(prepared.captureCase);
  }
  if (
    preparedCases.length !== 32 ||
    excludedCases.length !== 4 ||
    excludedCases.filter((entry) => entry.exclusion === "originality_only")
      .length !== 3 ||
    excludedCases.filter((entry) => entry.exclusion === "solution_missing")
      .length !== 1 ||
    acceptedCount !== 20 ||
    rejectedCount !== 12
  ) {
    fail("REVIEW_FLOW_HISTORICAL_SELECTION_COUNT_INVALID");
  }

  const upstreamAttestationName =
    "upstream-verification-attestation.private.json";
  const tagCatalogName = "tag-catalog.private.json";
  files.set(upstreamAttestationName, verified.attestationBytes);
  files.set(tagCatalogName, catalogFile.bytes);
  const captureManifest = captureManifestSchema.parse({
    schemaVersion: 1,
    artifactKind: "anklang_review_flow_v2_capture_manifest",
    captureId: operator.anklangCapture.captureId,
    expectedCaseCount: 32,
    endpoint: operator.anklangCapture.endpoint,
    timeoutMs: operator.anklangCapture.timeoutMs,
    externalStatementTransferConfirmed: true,
    runtimeDeclaration: operator.anklangCapture.runtimeDeclaration,
    cases: captureCases
  });
  const captureManifestBytes = prettyJsonBytes(captureManifest);
  const captureManifestName = "capture-manifest.private.json";
  files.set(captureManifestName, captureManifestBytes);

  const draft = reviewFlowHistoricalBridgePlanDraftSchema.parse({
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
    anklangInputPolicy:
      "exclude_current_corpus_for_historical_outcome",
    placeholderTagIds: operator.placeholderTagIds,
    upstreamDatasetId: operator.upstreamDatasetId,
    datasetId: operator.datasetId,
    tagCatalog: binding(tagCatalogName, catalogFile.bytes),
    upstreamVerificationAttestation: binding(
      upstreamAttestationName,
      verified.attestationBytes
    ),
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
  });
  const draftBytes = prettyJsonBytes(draft);
  const draftName = "bridge-plan-draft.private.json";
  files.set(draftName, draftBytes);

  const completionWithoutFingerprint = {
    schemaVersion: 1 as const,
    artifactKind:
      "review_flow_historical_input_preparation_completion" as const,
    preparationVersion: historicalInputPreparationVersion,
    complete: true as const,
    preparationId: operator.preparationId,
    upstreamDatasetId: operator.upstreamDatasetId,
    datasetId: operator.datasetId,
    operatorConfirmationSha256: operatorFile.sha256,
    upstreamVerificationAttestation: binding(
      upstreamAttestationName,
      verified.attestationBytes
    ),
    tagCatalog: binding(tagCatalogName, catalogFile.bytes),
    placeholderTagIds: operator.placeholderTagIds,
    anklangCaptureManifest: binding(captureManifestName, captureManifestBytes),
    bridgePlanDraft: binding(draftName, draftBytes),
    repositories: input.identities,
    counts: {
      upstreamCaseCount: 36 as const,
      upstreamDevelopmentCount: 36 as const,
      upstreamHoldoutCount: 0 as const,
      upstreamVerdictAndTasteCount: 33 as const,
      upstreamOriginalityOnlyCount: 3 as const,
      excludedOriginalityOnlyCount: 3 as const,
      excludedMissingSolutionCount: 1 as const,
      includedCaseCount: 32 as const,
      acceptedCount: 20 as const,
      rejectedCount: 12 as const,
      holdoutCount: 0 as const
    },
    cases: preparedCases,
    excludedCases
  } satisfies Omit<PreparationCompletion, "preparationFingerprint">;
  // 与 run 路径同一道校验：补上占位摘要后整体通过完成模式（含 refine 检查）。
  // 不能按 .shape 重建“去掉 fingerprint 的模式”：zod v4 对带 refine 的
  // 模式不提供可迭代的 shape，且拆俗会造成两套校验规则漂移。
  reviewFlowHistoricalInputPreparationCompletionSchema.parse({
    ...completionWithoutFingerprint,
    preparationFingerprint: hashCanonicalValue(completionWithoutFingerprint)
  });
  return {
    files,
    completionWithoutFingerprint,
    result: {
      preparationId: operator.preparationId,
      datasetId: operator.datasetId,
      caseCount: 32,
      acceptedCount: 20,
      rejectedCount: 12
    }
  };
}

function buildCaseArtifacts(input: {
  readonly upstream: ValidatedReviewFlowEvaluationUpstreamCase;
  readonly confirmation: z.infer<typeof includedOperatorCaseSchema>;
  readonly operator: ReviewFlowHistoricalInputOperatorConfirmation;
  readonly catalog: z.infer<typeof reviewFlowEvaluationTagCatalogSchema>;
}) {
  const { upstream, confirmation, operator } = input;
  const title = upstream.row.identityValues[
    confirmation.titleIdentityValueIndex
  ];
  if (title === undefined) {
    fail("REVIEW_FLOW_HISTORICAL_TITLE_IDENTITY_INVALID");
  }
  const projection = projectReviewFlowEvaluationBoundSource(
    upstream.sourceBytes,
    confirmation.sourceProjection
  );
  const allReasonEvidence = [
    ...confirmation.observedHistoricalTasteReasonEvidence,
    ...confirmation.observedHistoricalTechnicalReasonEvidence
  ];
  if (
    (allReasonEvidence.length > 0 && !upstream.row.reviewCommentPresent) ||
    allReasonEvidence.some((evidence) => {
      const comment = upstream.row.reviewComments[evidence.reviewCommentIndex];
      return comment === undefined || comment.trim().length === 0;
    })
  ) {
    fail("REVIEW_FLOW_HISTORICAL_REASON_EVIDENCE_INVALID");
  }
  const hashInput = reviewFlowEvaluationProblemHashInputSchema.parse({
    schemaVersion: 1,
    artifactKind: "urmotiv_problem_content_hash_input",
    title,
    type: confirmation.problemType,
    tagIds: operator.placeholderTagIds,
    codeforcesDifficulty: null,
    thinkingLevel: null,
    codingLevel: null,
    content: {
      basicStatement: projection.statement,
      basicSolution: projection.solution,
      background: "",
      statement: "",
      inputFormat: "",
      outputFormat: "",
      constraints: "",
      solution: "",
      hints: ""
    },
    samples: [],
    judgeConfig: null,
    status: "pending_review"
  });
  const contentHash = computeUrmotivProblemContentHash(hashInput);
  const task = robotReviewTaskSchema.parse({
    assignmentId: deterministicUuid(
      operator.preparationId,
      confirmation.safeId,
      "assignment"
    ),
    leaseExpiresAt: fixedLeaseExpiry,
    problem: {
      id: `historical-${confirmation.safeId}`,
      revision: 1,
      reviewRound: 1,
      contentHash,
      title,
      type: confirmation.problemType,
      tagIds: operator.placeholderTagIds,
      content: hashInput.content,
      samples: [],
      limits: null
    },
    tagCatalog: {
      version: input.catalog.version,
      tags: input.catalog.tags
    },
    reviewItems: []
  } satisfies RobotReviewTask);
  const request = anklangV2RequestSchema.parse({
    apiVersion: "2",
    requestId: deterministicUuid(
      operator.preparationId,
      confirmation.safeId,
      "anklang-request"
    ),
    contentHash,
    problem: {
      title,
      type: confirmation.problemType,
      tagIds: operator.placeholderTagIds,
      basicStatement: projection.statement
    }
  });
  const safeId = confirmation.safeId;
  const hashInputName = `${safeId}.problem-hash-input.private.json`;
  const taskName = `${safeId}.task.private.json`;
  const requestName = `${safeId}.anklang-request.private.json`;
  const mappingName = `${safeId}.source-mapping.private.json`;
  const responseName = `${safeId}.anklang-response.private.json`;
  const hashInputBytes = prettyJsonBytes(hashInput);
  const taskBytes = prettyJsonBytes(task);
  const requestBytes = prettyJsonBytes(request);
  const mapping = reviewFlowEvaluationSourceMappingSchema.parse({
    schemaVersion: 2,
    artifactKind: "review_flow_evaluation_source_mapping",
    confirmed: true,
    caseId: upstream.plan.caseId,
    safeId,
    subjectId: upstream.plan.subjectId,
    purpose: "development",
    sourceId: upstream.plan.sourceId,
    sourceSha256: upstream.plan.sourceSha256,
    rowEvidenceSha256: upstream.binding.rowEvidenceSha256,
    reviewInputId: upstream.row.inputId,
    worksheetId: upstream.row.worksheetId,
    sourceRowNumber: upstream.row.sourceRowNumber,
    taskDraftSha256: sha256(taskBytes),
    problemHashInputSha256: sha256(hashInputBytes),
    problemContentHash: contentHash,
    titleIdentityValueIndex: confirmation.titleIdentityValueIndex,
    sourceProjection: confirmation.sourceProjection,
    problemTypeBasis: "operator_confirmed",
    currentTagIdsBasis: "calibration_placeholder_not_gold",
    placeholderTagIds: operator.placeholderTagIds,
    evaluationScope: "verdict_and_taste",
    historicalReviewReasonMapping:
      "operator_asserted_sparse_mapping_v1",
    observedHistoricalTasteReasonEvidence:
      confirmation.observedHistoricalTasteReasonEvidence,
    observedHistoricalTechnicalReasonEvidence:
      confirmation.observedHistoricalTechnicalReasonEvidence
  });
  const mappingBytes = prettyJsonBytes(mapping);
  const common = {
    caseId: upstream.plan.caseId,
    safeId,
    subjectId: upstream.plan.subjectId,
    purpose: "development" as const,
    sourceId: upstream.plan.sourceId,
    sourceSha256: upstream.plan.sourceSha256,
    rowEvidenceSha256: upstream.binding.rowEvidenceSha256,
    taskDraft: binding(taskName, taskBytes),
    problemHashInput: binding(hashInputName, hashInputBytes),
    originalAnklangRequest: binding(requestName, requestBytes),
    sourceMapping: binding(mappingName, mappingBytes)
  };
  return {
    files: new Map<string, Buffer>([
      [taskName, taskBytes],
      [hashInputName, hashInputBytes],
      [requestName, requestBytes],
      [mappingName, mappingBytes]
    ]),
    completionCase: common,
    draftCase: {
      ...common,
      originalAnklangResponse: {
        fileName: responseName,
        sha256: null,
        pendingCapture: true as const
      }
    },
    captureCase: {
      caseId: upstream.plan.caseId,
      request: binding(requestName, requestBytes)
    }
  };
}

function excludedCase(
  upstream: ValidatedReviewFlowEvaluationUpstreamCase,
  exclusion: "originality_only" | "solution_missing"
): PreparationCompletion["excludedCases"][number] {
  return {
    caseId: upstream.plan.caseId,
    subjectId: upstream.plan.subjectId,
    sourceId: upstream.plan.sourceId,
    sourceSha256: upstream.plan.sourceSha256,
    exclusion
  };
}

function loadRepositoryIdentities(
  input: Pick<PrepareReviewFlowHistoricalInputsInput, "containingWorkspace">,
  operator: ReviewFlowHistoricalInputOperatorConfirmation,
  verified: VerifiedReviewFlowEvaluationUpstreamSource
): RepositoryIdentities {
  if (
    operator.repositoryCodeVersions.urmotiv !==
      verified.attestation.verifier.codeVersion
  ) {
    fail("REVIEW_FLOW_HISTORICAL_UPSTREAM_IDENTITY_MISMATCH");
  }
  const fermata = loadIdentity({
    repositoryDirectory: resolve(input.containingWorkspace, "Fermata"),
    expectedCodeVersion: operator.repositoryCodeVersions.fermata,
    runnerPath: preparationRunnerPath,
    dependencyPaths: historicalInputPreparationCodePaths
  });
  const urmotiv = loadIdentity({
    repositoryDirectory: resolve(input.containingWorkspace, "Urmotiv"),
    expectedCodeVersion: operator.repositoryCodeVersions.urmotiv,
    runnerPath: upstreamVerifierRunnerPath,
    dependencyPaths: upstreamVerifierDependencyPaths
  });
  const anklang = loadIdentity({
    repositoryDirectory: resolve(input.containingWorkspace, "Anklang"),
    expectedCodeVersion: operator.repositoryCodeVersions.anklang,
    runnerPath: anklangCaptureRunnerPath,
    dependencyPaths: anklangCaptureDependencyPaths
  });
  if (
    urmotiv.runnerSha256 !== verified.attestation.verifier.runnerSha256 ||
    urmotiv.dependencyCodeSha256 !==
      verified.attestation.verifier.dependencyCodeSha256
  ) {
    fail("REVIEW_FLOW_HISTORICAL_UPSTREAM_IDENTITY_MISMATCH");
  }
  return {
    fermata: identityBinding(
      "Fermata",
      preparationRunnerPath,
      historicalInputPreparationCodePaths.length,
      fermata
    ),
    urmotiv: identityBinding(
      "Urmotiv",
      upstreamVerifierRunnerPath,
      upstreamVerifierDependencyPaths.length,
      urmotiv
    ),
    anklang: identityBinding(
      "Anklang",
      anklangCaptureRunnerPath,
      anklangCaptureDependencyPaths.length,
      anklang
    )
  };
}

function loadIdentity(input: {
  readonly repositoryDirectory: string;
  readonly expectedCodeVersion: string;
  readonly runnerPath: string;
  readonly dependencyPaths: readonly string[];
}): EvaluationCodeIdentity {
  try {
    return loadEvaluationCodeIdentity(input);
  } catch {
    fail("REVIEW_FLOW_HISTORICAL_CODE_IDENTITY_INVALID");
  }
}

function identityBinding<
  R extends "Fermata" | "Urmotiv" | "Anklang",
  P extends string,
  C extends number
>(
  repository: R,
  runnerPath: P,
  dependencyFileCount: C,
  identity: EvaluationCodeIdentity
) {
  if (identity.dependencyFileCount !== dependencyFileCount) {
    fail("REVIEW_FLOW_HISTORICAL_CODE_IDENTITY_INVALID");
  }
  return {
    repository,
    codeVersion: identity.codeVersion,
    runnerPath,
    runnerSha256: identity.runnerSha256,
    dependencyCodeSha256: identity.dependencyCodeSha256,
    dependencyFileCount
  };
}

function assertSourceFilesUnchanged(
  input: PrepareReviewFlowHistoricalInputsInput,
  operator: LoadedPrivateJson<unknown>,
  catalog: LoadedPrivateJson<unknown>,
  verified: VerifiedReviewFlowEvaluationUpstreamSource
): void {
  if (
    !readAbsoluteBytes(
      input.operatorConfirmationPath,
      input,
      operatorFileMaximumBytes
    ).equals(operator.bytes) ||
    !readAbsoluteBytes(
      input.tagCatalogPath,
      input,
      tagCatalogMaximumBytes
    ).equals(catalog.bytes) ||
    !readAbsoluteBytes(
      input.upstreamVerificationAttestationPath,
      input,
      10 * 1024 * 1024
    ).equals(verified.attestationBytes)
  ) {
    fail("REVIEW_FLOW_HISTORICAL_SOURCE_CHANGED");
  }
}

function assertInputPaths(input: PrepareReviewFlowHistoricalInputsInput): void {
  const paths = [
    input.operatorConfirmationPath,
    input.upstreamVerificationAttestationPath,
    input.tagCatalogPath,
    input.upstreamGoldDirectory,
    input.materializedDirectory,
    input.worksheetPath,
    input.worksheetCompletionPath,
    input.inspectionPath,
    input.layoutPath,
    input.upstreamPlanPath,
    input.tuningHistoryPath,
    ...input.reviewInputPaths,
    input.outputDirectory
  ];
  if (paths.some((path) => !isAbsolute(path))) {
    fail("REVIEW_FLOW_HISTORICAL_PATH_INVALID");
  }
}

function readAbsoluteJson<T>(
  path: string,
  input: Pick<PrepareReviewFlowHistoricalInputsInput,
    "privateRoot" | "containingWorkspace">,
  schema: z.ZodType<T>,
  maximumBytes: number,
  errorCode: string
): LoadedPrivateJson<T> {
  const bytes = readAbsoluteBytes(path, input, maximumBytes);
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = schema.safeParse(parsePhysicalBlindJson(decoded));
    if (!parsed.success) fail(errorCode);
    return { bytes, value: parsed.data, sha256: sha256(bytes) };
  } catch (error) {
    if (error instanceof ReviewFlowHistoricalInputPreparationError) throw error;
    fail(errorCode);
  }
}

function readAbsoluteBytes(
  path: string,
  input: Pick<PrepareReviewFlowHistoricalInputsInput,
    "privateRoot" | "containingWorkspace">,
  maximumBytes: number
): Buffer {
  if (!isAbsolute(path)) fail("REVIEW_FLOW_HISTORICAL_PATH_INVALID");
  const directory = openExistingPrivateDirectory(dirname(path), runtimeOptions(input));
  try {
    return readPrivateArtifactBytes(directory, basename(path), maximumBytes);
  } finally {
    closePrivateDirectory(directory);
  }
}

function publish(
  directory: PrivateDirectoryHandle,
  fileName: string,
  bytes: Buffer
): void {
  writePrivateArtifactExclusive(directory, fileName, bytes.toString("utf8"));
  const readBack = readPrivateArtifactBytes(
    directory,
    fileName,
    Math.max(1, bytes.byteLength)
  );
  if (!readBack.equals(bytes)) {
    fail("REVIEW_FLOW_HISTORICAL_PUBLICATION_MISMATCH");
  }
}

function assertExactInventory(
  directory: PrivateDirectoryHandle,
  expected: ReadonlySet<string>
): void {
  const actual = new Set<string>();
  for (const entry of readdirSync(`/proc/self/fd/${directory.descriptor}`, {
    withFileTypes: true
  })) {
    if (!entry.isFile()) {
      fail("REVIEW_FLOW_HISTORICAL_OUTPUT_INVENTORY_INVALID");
    }
    actual.add(entry.name);
  }
  if (
    actual.size !== expected.size ||
    [...actual].some((entry) => !expected.has(entry))
  ) {
    fail("REVIEW_FLOW_HISTORICAL_OUTPUT_INVENTORY_INVALID");
  }
}

function deterministicUuid(
  preparationId: string,
  safeId: string,
  purpose: string
): string {
  const bytes = createHash("sha256")
    .update("review-flow-historical-input-uuid-v1\0")
    .update(preparationId)
    .update("\0")
    .update(safeId)
    .update("\0")
    .update(purpose)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function binding(fileName: string, bytes: Buffer) {
  return reviewFlowEvaluationFileBindingSchema.parse({
    fileName,
    sha256: sha256(bytes)
  });
}

function uniqueMap<T>(
  values: readonly T[],
  key: (value: T) => string,
  errorCode: string
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const identity = key(value);
    if (result.has(identity)) fail(errorCode);
    result.set(identity, value);
  }
  return result;
}

function prettyJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function runtimeOptions(input: Pick<PrepareReviewFlowHistoricalInputsInput,
  "privateRoot" | "containingWorkspace">) {
  return {
    privateRoot: input.privateRoot,
    containingWorkspace: input.containingWorkspace
  };
}

function fail(code: string): never {
  throw new ReviewFlowHistoricalInputPreparationError(code);
}
