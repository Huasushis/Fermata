#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { workspaceRoot } from "../scripts/private-runtime.mjs";
import {
  prepareReviewFlowEvaluationDatasetBridge,
  ReviewFlowEvaluationBridgeError
} from "./lib/review-flow-evaluation-bridge";

interface BridgeCliOptions {
  readonly privateRoot: string;
  readonly fermataCodeVersion: string;
  readonly bridgePlan: string;
  readonly anklangCaptureWorkspace: string;
  readonly anklangCaptureManifest: string;
  readonly anklangVerifierManifest?: string;
  readonly upstreamGold: string;
  readonly materialized: string;
  readonly worksheet: string;
  readonly worksheetCompletion: string;
  readonly inspection: string;
  readonly layout: string;
  readonly upstreamPlan: string;
  readonly tuningHistory: string;
  readonly reviewInputs: readonly string[];
  readonly output: string;
  readonly developmentRevealOutput: string;
  readonly holdoutRevealOutput?: string;
  readonly urmotivRepo?: string;
  readonly preparationFermataRepo?: string;
}

const singletonOptions = new Set([
  "private-root",
  "fermata-code-version",
  "bridge-plan",
  "anklang-capture-workspace",
  "anklang-capture-manifest",
  "anklang-verifier-manifest",
  "upstream-gold",
  "materialized",
  "worksheet",
  "worksheet-completion",
  "inspection",
  "layout",
  "upstream-plan",
  "tuning-history",
  "out",
  "development-reveal-out",
  "holdout-reveal-out",
  "urmotiv-repo",
  "preparation-fermata-repo",
]);

export function parseReviewFlowDatasetBridgeArguments(
  argv: readonly string[]
): BridgeCliOptions {
  const values = new Map<string, string>();
  const reviewInputs: string[] = [];
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (match === null) failArguments();
    const [, key, value] = match;
    if (key === undefined || value === undefined) failArguments();
    if (key === "review-input") {
      reviewInputs.push(value);
      continue;
    }
    if (!singletonOptions.has(key) || values.has(key)) failArguments();
    values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined) failArguments();
    return value;
  };
  if (reviewInputs.length < 1 || reviewInputs.length > 2) failArguments();
  const fermataCodeVersion = required("fermata-code-version");
  if (!/^(?!0{40}$)[0-9a-f]{40}$/u.test(fermataCodeVersion)) failArguments();
  const optionalHoldout = values.get("holdout-reveal-out");
  const optionalUrmotivRepo = values.get("urmotiv-repo");
  const optionalPreparationFermataRepo = values.get("preparation-fermata-repo");
  const optionalAnklangVerifierManifest = values.get("anklang-verifier-manifest");
  return {
    privateRoot: required("private-root"),
    fermataCodeVersion,
    bridgePlan: required("bridge-plan"),
    anklangCaptureWorkspace: required("anklang-capture-workspace"),
    anklangCaptureManifest: required("anklang-capture-manifest"),
    upstreamGold: required("upstream-gold"),
    materialized: required("materialized"),
    worksheet: required("worksheet"),
    worksheetCompletion: required("worksheet-completion"),
    inspection: required("inspection"),
    layout: required("layout"),
    upstreamPlan: required("upstream-plan"),
    tuningHistory: required("tuning-history"),
    reviewInputs,
    output: required("out"),
    developmentRevealOutput: required("development-reveal-out"),
    ...(optionalHoldout === undefined
      ? {}
      : { holdoutRevealOutput: optionalHoldout }),
    ...(optionalUrmotivRepo === undefined
      ? {}
      : { urmotivRepo: optionalUrmotivRepo }),
    ...(optionalPreparationFermataRepo === undefined
      ? {}
      : { preparationFermataRepo: optionalPreparationFermataRepo }),
    ...(optionalAnklangVerifierManifest === undefined
      ? {}
      : { anklangVerifierManifest: optionalAnklangVerifierManifest })
  };
}

export function runReviewFlowDatasetBridgeCli(
  argv: readonly string[] = process.argv.slice(2)
): void {
  const options = parseReviewFlowDatasetBridgeArguments(argv);
  const result = prepareReviewFlowEvaluationDatasetBridge({
    privateRoot: options.privateRoot,
    containingWorkspace: workspaceRoot,
    fermataCodeVersion: options.fermataCodeVersion,
    bridgePlanPath: options.bridgePlan,
    anklangCaptureWorkspace: options.anklangCaptureWorkspace,
    anklangCaptureManifestPath: options.anklangCaptureManifest,
    upstreamGoldDirectory: options.upstreamGold,
    materializedDirectory: options.materialized,
    worksheetPath: options.worksheet,
    worksheetCompletionPath: options.worksheetCompletion,
    inspectionPath: options.inspection,
    layoutPath: options.layout,
    upstreamPlanPath: options.upstreamPlan,
    tuningHistoryPath: options.tuningHistory,
    reviewInputPaths: options.reviewInputs,
    outputDirectory: options.output,
    developmentRevealDirectory: options.developmentRevealOutput,
    ...(options.holdoutRevealOutput === undefined
      ? {}
      : { holdoutRevealDirectory: options.holdoutRevealOutput }),
    ...(options.urmotivRepo === undefined
      ? {}
      : { urmotivRepositoryDirectory: options.urmotivRepo }),
    ...(options.preparationFermataRepo === undefined
      ? {}
      : { preparationFermataRepositoryDirectory: options.preparationFermataRepo }),
    ...(options.anklangVerifierManifest === undefined
      ? {}
      : { anklangVerifierManifestPath: options.anklangVerifierManifest })
  });
  process.stdout.write(`${JSON.stringify({
    datasetId: result.datasetId,
    cases: result.caseCount,
    development: result.developmentCount,
    holdout: result.holdoutCount,
    complete: true
  })}\n`);
}

function failArguments(): never {
  throw new ReviewFlowEvaluationBridgeError(
    "REVIEW_FLOW_EVALUATION_BRIDGE_ARGUMENT_INVALID"
  );
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(entry).href === import.meta.url;
}

if (isMainModule()) {
  try {
    runReviewFlowDatasetBridgeCli();
  } catch (error) {
    const code = error instanceof ReviewFlowEvaluationBridgeError
      ? error.code
      : "REVIEW_FLOW_EVALUATION_BRIDGE_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
