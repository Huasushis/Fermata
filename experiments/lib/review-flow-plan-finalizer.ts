/**
 * 已封存历史审核输入 -> 正式 v5 bridge plan 定稿器（finalizer）。
 *
 * 本模块把既有证据的原始字节绑定到正式 plan：历史输入准备完成标记、bridge
 * draft、Anklang v2 capture attestation / 完成标记与实际逐 case 请求、响应原件。
 * 它不执行 verifier、不重跑 capture、不修复任何 attestation 字节；全部验证通过
 * 后才把 attestation / capture 完成标记 / 32 份响应复制进准备输出目录，并最后以
 * 正式 plan（bridge-plan.private.json）收尾。任何缺失条目、非 200、attempt != 1、
 * 取消/跳过响应或摘要不绑定都视为整批未完成：报告 INCOMPLETE，且不写任何文件。
 */
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import {
  closePrivateDirectory,
  openExistingPrivateDirectory,
  type PrivateDirectoryHandle
} from "../../scripts/private-runtime.mjs";
import { hashCanonicalValue } from "../../src/review-flow/evidence";
import {
  historicalInputPreparationCompletionFileName,
  reviewFlowEvaluationAnklangCaptureAttestationSchema,
  reviewFlowEvaluationAnklangCaptureCompletionSchema,
  reviewFlowEvaluationAnklangCaptureSetSha256,
  reviewFlowEvaluationBridgePlanSchema,
  reviewFlowHistoricalInputPreparationCompletionSchema
} from "./review-flow-evaluation-bridge";
import {
  reviewFlowHistoricalAnklangCaptureManifestSchema,
  reviewFlowHistoricalBridgePlanDraftSchema
} from "./review-flow-historical-input-preparer";
import {
  readPrivateArtifactBytes,
  writePrivateArtifactExclusive
} from "./private-artifact-io";
import { parsePhysicalBlindJson } from "./physical-blind-common";

const bridgePlanFileName = "bridge-plan.private.json" as const;
const anklangCaptureAttestationOutputFileName =
  "anklang-capture-attestation.private.json" as const;
const anklangCaptureCompletionOutputFileName =
  "anklang-capture-completion.private.json" as const;

// Anklang scripts/capture-review-flow-calibration.py 的运行目录布局：
// capture 跑在 <captureWorkspace>/runs/<captureId>/ 下，目录里同时有
// attestation、完成标记和逐 case 的 request / response 原件。
const anklangCaptureRunDirectoryName = "runs" as const;
const anklangCaptureAttestationName = "attestation.json" as const;
const anklangCaptureCompletionMarkerName =
  "REVIEW_FLOW_ANKLANG_CAPTURE_COMPLETE" as const;

function runCaseFileName(position: number, kind: "request" | "response"): string {
  return `case-${String(position).padStart(4, "0")}.${kind}.json`;
}

function runCaseMetadataFileName(position: number): string {
  return `case-${String(position).padStart(4, "0")}.response-meta.json`;
}

const anklangResponseMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal("anklang_review_flow_http_response_metadata"),
    caseId: z
      .string()
      .regex(/^case-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u),
    caseIndex: z.number().int().positive().max(2_000),
    attempt: z.literal(1),
    httpStatus: z.literal(200),
    contentType: z.string().nullable(),
    cacheControl: z.string().nullable(),
    bodyPresent: z.literal(true),
    bodySha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
  })
  .strict();

type PreparationCompletion = z.infer<
  typeof reviewFlowHistoricalInputPreparationCompletionSchema
>;
type BridgePlanDraft = z.infer<
  typeof reviewFlowHistoricalBridgePlanDraftSchema
>;
type CaptureAttestation = z.infer<
  typeof reviewFlowEvaluationAnklangCaptureAttestationSchema
>;
type CaptureCompletion = z.infer<
  typeof reviewFlowEvaluationAnklangCaptureCompletionSchema
>;

export interface FinalizeReviewFlowBridgePlanInput {
  readonly privateRoot: string;
  readonly containingWorkspace: string;
  readonly preparationOutputDirectory: string;
  readonly anklangCaptureWorkspace: string;
  readonly anklangCaptureManifestPath: string;
}

export interface FinalizedReviewFlowBridgePlan {
  readonly preparationId: string;
  readonly datasetId: string;
  readonly planPath: string;
  readonly completionPath: string;
  readonly caseCount: 32;
  readonly responseBoundCount: 32;
}

export class ReviewFlowBridgePlanFinalizationError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(code);
    this.name = "ReviewFlowBridgePlanFinalizationError";
    this.code = code;
  }
}

/** 完整验证准备输出与 Anklang capture 运行目录后，把正式 v5 plan 写成定稿。 */
export function finalizeReviewFlowBridgePlan(
  input: FinalizeReviewFlowBridgePlanInput
): FinalizedReviewFlowBridgePlan {
  try {
    return finalize(input);
  } catch (error) {
    if (error instanceof ReviewFlowBridgePlanFinalizationError) throw error;
    fail("REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_INVALID");
  }
}

function finalize(input: FinalizeReviewFlowBridgePlanInput) {
  if (
    !isAbsolute(input.privateRoot) ||
    !isAbsolute(input.containingWorkspace) ||
    !isAbsolute(input.preparationOutputDirectory) ||
    !isAbsolute(input.anklangCaptureWorkspace) ||
    !isAbsolute(input.anklangCaptureManifestPath)
  ) {
    fail("REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_PATH_INVALID");
  }
  const preparation = openExistingPrivateDirectory(
    input.preparationOutputDirectory,
    runtimeOptions(input)
  );
  try {
    const existingInventory = enumerateInventory(preparation);
    const markerFile = readRunArtifact(
      preparation,
      historicalInputPreparationCompletionFileName,
      4 * 1024 * 1024,
      "REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_PREPARATION_INCOMPLETE"
    );
    const marker = parseStrict(
      markerFile,
      reviewFlowHistoricalInputPreparationCompletionSchema,
      "REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_PREPARATION_INVALID"
    );
    const { preparationFingerprint: _fingerprint, ...withoutFingerprint } =
      marker;
    if (
      marker.preparationFingerprint !==
        hashCanonicalValue(withoutFingerprint) ||
      !markerFile.equals(prettyJsonBytes(marker))
    ) {
      fail("REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_PREPARATION_INVALID");
    }
    const draftFile = readBoundInput(
      preparation,
      marker.bridgePlanDraft,
      16 * 1024 * 1024,
      "REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_PREPARATION_INCOMPLETE",
      "REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_PREPARATION_MISMATCH"
    );
    const draft = parseStrict(
      draftFile,
      reviewFlowHistoricalBridgePlanDraftSchema,
      "REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_PREPARATION_INVALID"
    );
    assertDraftMatchesMarker(draft, marker);
    for (const binding of marker.cases.flatMap((entry) => [
      entry.taskDraft,
      entry.problemHashInput,
      entry.originalAnklangRequest,
      entry.sourceMapping
    ])) {
      readBoundInput(
        preparation,
        binding,
        16 * 1024 * 1024,
        "REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_PREPARATION_INCOMPLETE",
        "REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_PREPARATION_MISMATCH"
      );
    }
    for (const binding of [marker.tagCatalog, marker.upstreamVerificationAttestation]) {
      readBoundInput(
        preparation,
        binding,
        16 * 1024 * 1024,
        "REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_PREPARATION_INCOMPLETE",
        "REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_PREPARATION_MISMATCH"
      );
    }
    const run = loadCaptureRun(input, marker);
    try {
      assertCaptureRunMatchesMarker(run, marker, draft);
      const responses = collectRunResponses(run.hand, run.attestation, marker);
      const responseFileNameByCaseId = new Map(
        draft.cases.map((entry) => [
          entry.caseId,
          entry.originalAnklangResponse.fileName
        ])
      );
      const outputNames = [
        anklangCaptureAttestationOutputFileName,
        anklangCaptureCompletionOutputFileName,
        ...draft.cases.map((entry) => entry.originalAnklangResponse.fileName)
      ];
      if (outputNames.some((fileName) => existingInventory.has(fileName))) {
        fail("REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_OUTPUT_EXISTS");
      }
      for (const entry of marker.cases) {
        const response = responses.get(entry.caseId);
        const responseFileName = responseFileNameByCaseId.get(entry.caseId);
        if (response === undefined || responseFileName === undefined) {
          fail("REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_RESPONSE_MISSING");
        }
        publish(preparation, responseFileName, response.bytes);
      }
      publish(
        preparation,
        anklangCaptureAttestationOutputFileName,
        run.attestationBytes
      );
      publish(
        preparation,
        anklangCaptureCompletionOutputFileName,
        run.completionBytes
      );
      const plan = buildPlan(
        draft,
        markerFile,
        run,
        responses
      );
      publish(preparation, bridgePlanFileName, prettyJsonBytes(plan));
      assertExactInventory(
        preparation,
        new Set([
          ...existingInventory,
          ...outputNames,
          bridgePlanFileName
        ])
      );
      return {
        preparationId: marker.preparationId,
        datasetId: marker.datasetId,
        planPath: resolve(input.preparationOutputDirectory, bridgePlanFileName),
        completionPath: resolve(
          input.preparationOutputDirectory,
          historicalInputPreparationCompletionFileName
        ),
        caseCount: 32 as const,
        responseBoundCount: 32 as const
      };
    } finally {
      closePrivateDirectory(run.hand);
    }
  } finally {
    closePrivateDirectory(preparation);
  }
}

function assertDraftMatchesMarker(
  draft: BridgePlanDraft,
  marker: PreparationCompletion
): void {
  const draftWithoutPendingResponse = draft.cases.map(
    ({ originalAnklangResponse: _pending, ...rest }) => rest
  );
  if (
    draft.intendedBridgeVersion !== "urmotiv-review-flow-bridge-v5" ||
    draft.confirmed !== false ||
    draft.readyForBridge !== false ||
    draft.preparationCompletion.fileName !==
      historicalInputPreparationCompletionFileName ||
    draft.preparationCompletion.sha256 !== null ||
    draft.preparationCompletion.pendingMarkerLastPublication !== true ||
    draft.anklangInputPolicy !==
      "exclude_current_corpus_for_historical_outcome" ||
    draft.upstreamDatasetId !== marker.upstreamDatasetId ||
    draft.datasetId !== marker.datasetId ||
    JSON.stringify(draft.placeholderTagIds) !==
      JSON.stringify(marker.placeholderTagIds) ||
    JSON.stringify(draft.tagCatalog) !==
      JSON.stringify(marker.tagCatalog) ||
    JSON.stringify(draft.upstreamVerificationAttestation) !==
      JSON.stringify(marker.upstreamVerificationAttestation) ||
    draft.anklangCaptureAttestation.fileName !==
      anklangCaptureAttestationOutputFileName ||
    draft.anklangCaptureAttestation.sha256 !== null ||
    draft.anklangCaptureAttestation.pendingCapture !== true ||
    draft.anklangCaptureCompletion.fileName !==
      anklangCaptureCompletionOutputFileName ||
    draft.anklangCaptureCompletion.sha256 !== null ||
    draft.anklangCaptureCompletion.pendingCapture !== true ||
    draft.holdoutRegistration !== null ||
    JSON.stringify(draft.unresolvedBindings) !==
      JSON.stringify([
        "historicalInputPreparationCompletion.sha256",
        "anklangCaptureAttestation.sha256",
        "anklangCaptureCompletion.sha256",
        "cases[*].originalAnklangResponse.sha256"
      ]) ||
    !draft.cases.every((entry) =>
      entry.originalAnklangResponse.sha256 === null &&
      entry.originalAnklangResponse.pendingCapture === true
    ) ||
    JSON.stringify(draftWithoutPendingResponse) !==
      JSON.stringify(marker.cases)
  ) {
    fail("REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_PREPARATION_MISMATCH");
  }
}

interface CaptureRun {
  readonly hand: PrivateDirectoryHandle;
  readonly attestation: CaptureAttestation;
  readonly attestationBytes: Buffer;
  readonly completion: CaptureCompletion;
  readonly completionBytes: Buffer;
  readonly manifest: z.infer<
    typeof reviewFlowHistoricalAnklangCaptureManifestSchema
  >;
}

function loadCaptureRun(
  input: Pick<FinalizeReviewFlowBridgePlanInput,
    | "privateRoot"
    | "containingWorkspace"
    | "anklangCaptureWorkspace"
    | "anklangCaptureManifestPath">,
  marker: PreparationCompletion
): CaptureRun {
  const manifestPath = input.anklangCaptureManifestPath;
  const manifestBytes = readAbsolutePrivateBytes(
    manifestPath,
    input,
    "REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_CAPTURE_INCOMPLETE"
  );
  const manifest = parseStrict(
    manifestBytes,
    reviewFlowHistoricalAnklangCaptureManifestSchema,
    "REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_CAPTURE_INVALID"
  );
  if (
    marker.anklangCaptureManifest.fileName !== basename(manifestPath) ||
    marker.anklangCaptureManifest.sha256 !== sha256(manifestBytes)
  ) {
    fail("REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_CAPTURE_MISMATCH");
  }
  const run = openExistingPrivateDirectory(
    resolve(
      input.anklangCaptureWorkspace,
      anklangCaptureRunDirectoryName,
      manifest.captureId
    ),
    runtimeOptions(input)
  );
  try {
    const attestationBytes = readRunArtifact(
      run,
      anklangCaptureAttestationName,
      16 * 1024 * 1024,
      "REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_CAPTURE_INCOMPLETE"
    );
    const attestation = parseStrict(
      attestationBytes,
      reviewFlowEvaluationAnklangCaptureAttestationSchema,
      "REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_CAPTURE_INVALID"
    );
    const { captureFingerprint: _fingerprint, ...withoutFingerprint } =
      attestation;
    if (
      attestation.captureFingerprint !==
        hashCanonicalValue(withoutFingerprint) ||
      !attestationBytes.equals(prettyJsonBytes(attestation))
    ) {
      fail("REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_CAPTURE_INVALID");
    }
    const completionBytes = readRunArtifact(
      run,
      anklangCaptureCompletionMarkerName,
      1024 * 1024,
      "REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_CAPTURE_INCOMPLETE"
    );
    const completion = parseStrict(
      completionBytes,
      reviewFlowEvaluationAnklangCaptureCompletionSchema,
      "REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_CAPTURE_INVALID"
    );
    if (!completionBytes.equals(prettyJsonBytes(completion))) {
      fail("REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_CAPTURE_INVALID");
    }
    assertCaptureConsistent(attestation, completion, attestationBytes);
    return {
      hand: run,
      attestation,
      attestationBytes,
      completion,
      completionBytes,
      manifest
    };
  } catch (error) {
    closePrivateDirectory(run);
    throw error;
  }
}

function assertCaptureConsistent(
  attestation: CaptureAttestation,
  completion: CaptureCompletion,
  attestationBytes: Buffer
): void {
  const count = attestation.cases.length;
  const counts = attestation.counts;
  const attestationSha256 = sha256(attestationBytes);
  const captureSetSha256 = reviewFlowEvaluationAnklangCaptureSetSha256(
    attestation.cases
  );
  const selectorsUnique =
    count === 32 &&
    new Set(attestation.cases.map((entry) => entry.caseId)).size === count &&
    new Set(attestation.cases.map((entry) => entry.requestId)).size === count &&
    new Set(attestation.cases.map((entry) => entry.requestSha256)).size ===
      count &&
    new Set(attestation.cases.map((entry) => entry.responseSha256)).size ===
      count;
  const countsMatch =
    counts.caseCount === count &&
    counts.requestCount === count &&
    counts.responseCount === count &&
    counts.http200Count === count &&
    counts.attemptCount === count &&
    counts.completeResponseCount === count;
  const completionMatches =
    completion.captureId === attestation.captureId &&
    completion.attestationSha256 === attestationSha256 &&
    completion.captureSetSha256 === captureSetSha256 &&
    completion.caseCount === count &&
    completion.requestCount === count &&
    completion.responseCount === count &&
    completion.http200Count === count &&
    completion.attemptCount === count &&
    completion.completeResponseCount === count &&
    completion.failureCount === counts.failureCount;
  if (!selectorsUnique || !countsMatch || !completionMatches) {
    fail("REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_CAPTURE_MISMATCH");
  }
}

function assertCaptureRunMatchesMarker(
  run: CaptureRun,
  marker: PreparationCompletion,
  draft: BridgePlanDraft
): void {
  if (
    JSON.stringify(run.attestation.cases.map((entry) => entry.caseId)) !==
      JSON.stringify(marker.cases.map((entry) => entry.caseId)) ||
    JSON.stringify(run.manifest.cases.map((entry) => entry.caseId)) !==
      JSON.stringify(marker.cases.map((entry) => entry.caseId)) ||
    run.manifest.cases.some((entry, index) =>
      JSON.stringify(entry.request) !==
      JSON.stringify(marker.cases[index]?.originalAnklangRequest)
    ) ||
    draft.cases.some((entry) =>
      entry.originalAnklangResponse.fileName !==
      `${entry.safeId}.anklang-response.private.json`
    )
  ) {
    fail("REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_CAPTURE_MISMATCH");
  }
}

function collectRunResponses(
  hand: PrivateDirectoryHandle,
  attestation: CaptureAttestation,
  marker: PreparationCompletion
): ReadonlyMap<string, { readonly bytes: Buffer; readonly sha256: string }> {
  const results = new Map<string, { bytes: Buffer; sha256: string }>();
  for (let index = 0; index < attestation.cases.length; index += 1) {
    const position = index + 1;
    const attestationCase = attestation.cases[index];
    const markerCase = marker.cases[index];
    if (attestationCase === undefined || markerCase === undefined) {
      fail("REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_CAPTURE_MISMATCH");
    }
    const metadataBytes = readRunArtifact(
      hand,
      runCaseMetadataFileName(position),
      1024 * 1024,
      "REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_RESPONSE_MISSING"
    );
    const metadata = parseStrict(
      metadataBytes,
      anklangResponseMetadataSchema,
      "REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_RESPONSE_MISMATCH"
    );
    const responseBytes = readRunArtifact(
      hand,
      runCaseFileName(position, "response"),
      16 * 1024 * 1024,
      "REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_RESPONSE_MISSING"
    );
    const requestBytes = readRunArtifact(
      hand,
      runCaseFileName(position, "request"),
      16 * 1024 * 1024,
      "REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_RESPONSE_MISSING"
    );
    const responseSha256 = sha256(responseBytes);
    const requestSha256 = sha256(requestBytes);
    if (
      metadata.caseId !== attestationCase.caseId ||
      metadata.caseIndex !== position ||
      metadata.bodySha256 !== responseSha256 ||
      responseSha256 !== attestationCase.responseSha256 ||
      requestSha256 !== attestationCase.requestSha256 ||
      requestSha256 !== markerCase.originalAnklangRequest.sha256 ||
      responseBytes.equals(requestBytes)
    ) {
      fail("REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_RESPONSE_MISMATCH");
    }
    results.set(attestationCase.caseId, {
      bytes: responseBytes,
      sha256: responseSha256
    });
  }
  return results;
}

function buildPlan(
  draft: BridgePlanDraft,
  markerFile: Buffer,
  run: CaptureRun,
  responses: ReadonlyMap<
    string,
    { readonly bytes: Buffer; readonly sha256: string }
  >
): z.infer<typeof reviewFlowEvaluationBridgePlanSchema> {
  const cases = draft.cases.map((entry) => {
    const response = responses.get(entry.caseId);
    if (response === undefined) {
      fail("REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_RESPONSE_MISSING");
    }
    return {
      ...entry,
      originalAnklangResponse: {
        fileName: entry.originalAnklangResponse.fileName,
        sha256: response.sha256
      }
    };
  });
  return reviewFlowEvaluationBridgePlanSchema.parse({
    schemaVersion: 5,
    artifactKind: "review_flow_evaluation_bridge_plan",
    bridgeVersion: "urmotiv-review-flow-bridge-v5",
    confirmed: true,
    historicalInputPreparationCompletion: {
      fileName: historicalInputPreparationCompletionFileName,
      sha256: sha256(markerFile)
    },
    anklangInputPolicy: draft.anklangInputPolicy,
    placeholderTagIds: draft.placeholderTagIds,
    upstreamDatasetId: draft.upstreamDatasetId,
    datasetId: draft.datasetId,
    tagCatalog: draft.tagCatalog,
    upstreamVerificationAttestation: draft.upstreamVerificationAttestation,
    anklangCaptureAttestation: {
      fileName: anklangCaptureAttestationOutputFileName,
      sha256: sha256(run.attestationBytes)
    },
    anklangCaptureCompletion: {
      fileName: anklangCaptureCompletionOutputFileName,
      sha256: sha256(run.completionBytes)
    },
    holdoutRegistration: null,
    cases
  });
}

function readBoundInput(
  directory: PrivateDirectoryHandle,
  binding: { readonly fileName: string; readonly sha256: string },
  maximumBytes: number,
  missingCode: string,
  mismatchCode: string
): Buffer {
  let bytes: Buffer;
  try {
    bytes = readPrivateArtifactBytes(directory, binding.fileName, maximumBytes);
  } catch (error) {
    if (error instanceof ReviewFlowBridgePlanFinalizationError) throw error;
    fail(missingCode);
  }
  if (sha256(bytes) !== binding.sha256) fail(mismatchCode);
  return bytes;
}

function readAbsolutePrivateBytes(
  path: string,
  input: Pick<FinalizeReviewFlowBridgePlanInput,
    "privateRoot" | "containingWorkspace">,
  errorCode: string
): Buffer {
  try {
    if (!isAbsolute(path)) fail(errorCode);
    const directory = openExistingPrivateDirectory(
      dirname(path),
      runtimeOptions(input)
    );
    try {
      return readPrivateArtifactBytes(
        directory,
        basename(path),
        4 * 1024 * 1024
      );
    } finally {
      closePrivateDirectory(directory);
    }
  } catch (error) {
    if (error instanceof ReviewFlowBridgePlanFinalizationError) throw error;
    fail(errorCode);
  }
}

function readRunArtifact(
  directory: PrivateDirectoryHandle,
  fileName: string,
  maximumBytes: number,
  errorCode: string
): Buffer {
  try {
    return readPrivateArtifactBytes(directory, fileName, maximumBytes);
  } catch (error) {
    if (error instanceof ReviewFlowBridgePlanFinalizationError) throw error;
    fail(errorCode);
  }
}

function parseStrict<T>(
  bytes: Buffer,
  schema: z.ZodType<T>,
  errorCode: string
): T {
  try {
    const parsed = schema.safeParse(
      parsePhysicalBlindJson(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      )
    );
    if (!parsed.success) fail(errorCode);
    return parsed.data;
  } catch {
    fail(errorCode);
  }
}

function enumerateInventory(directory: PrivateDirectoryHandle): Set<string> {
  const result = new Set<string>();
  for (const entry of readdirSync(`/proc/self/fd/${directory.descriptor}`, {
    withFileTypes: true
  })) {
    if (!entry.isFile()) {
      fail("REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_OUTPUT_INVENTORY_INVALID");
    }
    result.add(entry.name);
  }
  return result;
}

function assertExactInventory(
  directory: PrivateDirectoryHandle,
  expected: ReadonlySet<string>
): void {
  const actual = enumerateInventory(directory);
  if (
    actual.size !== expected.size ||
    [...actual].some((entry) => !expected.has(entry))
  ) {
    fail("REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_OUTPUT_INVENTORY_INVALID");
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
    fail("REVIEW_FLOW_BRIDGE_PLAN_FINALIZATION_PUBLICATION_MISMATCH");
  }
}

function prettyJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function runtimeOptions(
  input: Pick<FinalizeReviewFlowBridgePlanInput,
    "privateRoot" | "containingWorkspace">
) {
  return {
    privateRoot: input.privateRoot,
    containingWorkspace: input.containingWorkspace
  };
}

function fail(code: string): never {
  throw new ReviewFlowBridgePlanFinalizationError(code);
}
