#!/usr/bin/env node
/**
 * 已封存历史审核输入 -> 正式 v5 bridge plan 定稿器 CLI。
 *
 * 仅当准备完成标记 + 操作员确认 + Anklang capture attestation/completion +
 * 全部真实响应存在且摘要互相绑定（preparation 完成 -> capture 运行目录 ->
 * 逐 case 响应字节）时才写正式 plan；任何缺失/499/取消/跳过项都会使整批
 * 保持未定稿（报告 incomplete），绝不修补 attestation。
 */
import { pathToFileURL } from "node:url";
import { workspaceRoot } from "../scripts/private-runtime.mjs";
import {
  finalizeReviewFlowBridgePlan,
  ReviewFlowBridgePlanFinalizationError
} from "./lib/review-flow-plan-finalizer";

interface FinalizeCliOptions {
  readonly privateRoot: string;
  readonly preparationDirectory: string;
  readonly anklangCaptureWorkspace: string;
  readonly anklangCaptureManifest: string;
}

const singletonOptions = new Set([
  "private-root",
  "preparation-dir",
  "anklang-capture-workspace",
  "anklang-capture-manifest"
]);

export function parseFinalizePlanArguments(
  argv: readonly string[]
): FinalizeCliOptions {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (match === null) failArguments();
    const [, key, value] = match;
    if (key === undefined || value === undefined) failArguments();
    if (!singletonOptions.has(key) || values.has(key)) failArguments();
    values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined) failArguments();
    return value;
  };
  return {
    privateRoot: required("private-root"),
    preparationDirectory: required("preparation-dir"),
    anklangCaptureWorkspace: required("anklang-capture-workspace"),
    anklangCaptureManifest: required("anklang-capture-manifest")
  };
}

export function runFinalizePlanCli(
  argv: readonly string[] = process.argv.slice(2)
): void {
  const options = parseFinalizePlanArguments(argv);
  const result = finalizeReviewFlowBridgePlan({
    privateRoot: options.privateRoot,
    containingWorkspace: workspaceRoot,
    preparationOutputDirectory: options.preparationDirectory,
    anklangCaptureWorkspace: options.anklangCaptureWorkspace,
    anklangCaptureManifestPath: options.anklangCaptureManifest
  });
  process.stdout.write(`${JSON.stringify({
    preparationId: result.preparationId,
    datasetId: result.datasetId,
    caseCount: result.caseCount,
    responseBoundCount: result.responseBoundCount,
    plan: result.planPath,
    completion: result.completionPath,
    complete: true
  })}\n`);
}

function printUsage(): void {
  process.stdout.write(
    [
      "usage: finalise-review-flow-bridge-plan \\",
      "  --private-root=<绝对路径> --preparation-dir=<目录> \\",
      "  --anklang-capture-workspace=<目录> --anklang-capture-manifest=<文件>",
      "",
      "校验准备目录与 Anklang capture 运行目录逐字节绑定后，把正式 v5 bridge plan",
      "写为 bridge-plan.private.json；任何缺失/不完整/取消/跳过响应都使整批保持",
      "未定稿并输出错误码（exit 1），绝不修补 attestation 摘要。",
      "",
      "选项：--help 显示本帮助；必填项缺失/重复或参数非法时以参数错误退出。"
    ].join("\n") + "\n"
  );
}

function failArguments(): never {
  throw new ReviewFlowBridgePlanFinalizationError(
    "REVIEW_FLOW_BRIDGE_PLAN_FINALIZE_ARGUMENT_INVALID"
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
      runFinalizePlanCli();
    } catch (error) {
      const code = error instanceof ReviewFlowBridgePlanFinalizationError
        ? error.code
        : "REVIEW_FLOW_BRIDGE_PLAN_FINALIZE_FAILED";
      process.stderr.write(`${code}\n`);
      process.exitCode = 1;
    }
  }
}