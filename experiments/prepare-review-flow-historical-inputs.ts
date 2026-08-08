#!/usr/bin/env node
/**
 * 已封存历史审核输入 -> v5 私有桥接输入准备 CLI。
 *
 * 读取操作员确认文件（或封存的确认 JSON）与三仓 sealed 上游产物，生成 32 个
 * 严格 Anklang v2 请求、任务草稿、源码映射与 capture manifest；只写 0700/0600
 * 私有目录，不发任何网络请求。
 */
import { pathToFileURL } from "node:url";
import { workspaceRoot } from "../scripts/private-runtime.mjs";
import {
  prepareReviewFlowHistoricalInputs,
  ReviewFlowHistoricalInputPreparationError
} from "./lib/review-flow-historical-input-preparer";

interface HistoricalInputsCliOptions {
  readonly privateRoot: string;
  readonly upstreamGold: string;
  readonly materialized: string;
  readonly worksheet: string;
  readonly worksheetCompletion: string;
  readonly inspection: string;
  readonly layout: string;
  readonly upstreamPlan: string;
  readonly tuningHistory: string;
  readonly reviewInputs: readonly string[];
  readonly operatorConfirmation: string;
  readonly upstreamVerificationAttestation: string;
  readonly tagCatalog: string;
  readonly output: string;
}

const singletonOptions = new Set([
  "private-root",
  "upstream-gold",
  "materialized",
  "worksheet",
  "worksheet-completion",
  "inspection",
  "layout",
  "upstream-plan",
  "tuning-history",
  "operator-confirmation",
  "upstream-verification-attestation",
  "tag-catalog",
  "out"
]);

export function parseHistoricalInputsCliArguments(
  argv: readonly string[]
): HistoricalInputsCliOptions {
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
  return {
    privateRoot: required("private-root"),
    upstreamGold: required("upstream-gold"),
    materialized: required("materialized"),
    worksheet: required("worksheet"),
    worksheetCompletion: required("worksheet-completion"),
    inspection: required("inspection"),
    layout: required("layout"),
    upstreamPlan: required("upstream-plan"),
    tuningHistory: required("tuning-history"),
    reviewInputs,
    operatorConfirmation: required("operator-confirmation"),
    upstreamVerificationAttestation: required(
      "upstream-verification-attestation"
    ),
    tagCatalog: required("tag-catalog"),
    output: required("out")
  };
}

export function runHistoricalInputsCli(
  argv: readonly string[] = process.argv.slice(2)
): void {
  const options = parseHistoricalInputsCliArguments(argv);
  const result = prepareReviewFlowHistoricalInputs({
    privateRoot: options.privateRoot,
    containingWorkspace: workspaceRoot,
    upstreamGoldDirectory: options.upstreamGold,
    materializedDirectory: options.materialized,
    worksheetPath: options.worksheet,
    worksheetCompletionPath: options.worksheetCompletion,
    inspectionPath: options.inspection,
    layoutPath: options.layout,
    upstreamPlanPath: options.upstreamPlan,
    tuningHistoryPath: options.tuningHistory,
    reviewInputPaths: options.reviewInputs,
    operatorConfirmationPath: options.operatorConfirmation,
    upstreamVerificationAttestationPath:
      options.upstreamVerificationAttestation,
    tagCatalogPath: options.tagCatalog,
    outputDirectory: options.output
  });
  process.stdout.write(`${JSON.stringify({
    preparationId: result.preparationId,
    datasetId: result.datasetId,
    caseCount: result.caseCount,
    accepted: result.acceptedCount,
    rejected: result.rejectedCount,
    outputDirectory: result.outputDirectory,
    completion: result.completionPath,
    captureManifest: result.captureManifestPath,
    bridgePlanDraft: result.bridgePlanDraftPath,
    complete: true
  })}\n`);
}

function printUsage(): void {
  process.stdout.write(
    [
      "usage: prepare-review-flow-historical-inputs \\",
      "  --private-root=<绝对路径> --upstream-gold=<目录> \\",
      "  --materialized=<目录> --worksheet=<文件> --worksheet-completion=<文件> \\",
      "  --inspection=<文件> --layout=<文件> --upstream-plan=<文件> \\",
      "  --tuning-history=<文件> --review-input=<文件> [--review-input=<文件>] \\",
      "  --operator-confirmation=<文件> --upstream-verification-attestation=<文件> \\",
      "  --tag-catalog=<文件> --out=<目录>",
      "",
      "读取操作员确认（含 32 例选择、投影与评注释绑定）与三路上游 sealed 产物，",
      "生成 32 个严格 Anklang v2 请求、task/source-mapping/problem-hash-input、",
      "capture manifest 与 bridge plan draft；全部写入新私有目录，完成标记最后发布。",
      "",
      "选项：--help 显示本帮助；任何必填项缺失或重复时以参数错误退出（exit 1）。"
    ].join("\n") + "\n"
  );
}

function failArguments(): never {
  throw new ReviewFlowHistoricalInputPreparationError(
    "REVIEW_FLOW_HISTORICAL_INPUT_ARGUMENT_INVALID"
  );
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(entry).href === import.meta.url;
}

if (isMainModule()) {
  if (process.argv.slice(2).includes("--help")) {
    printUsage();
  } else {
    try {
      runHistoricalInputsCli();
    } catch (error) {
      const code = error instanceof ReviewFlowHistoricalInputPreparationError
        ? error.code
        : "REVIEW_FLOW_HISTORICAL_INPUT_PREPARATION_FAILED";
      process.stderr.write(`${code}\n`);
      process.exitCode = 1;
    }
  }
}