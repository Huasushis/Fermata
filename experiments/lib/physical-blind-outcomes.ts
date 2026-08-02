import { z } from "zod";
import { failPhysicalBlind } from "./physical-blind-common";
import type { PhysicalBlindPrivateDirectoryOptions } from "./physical-blind-prepare";

export const physicalBlindOutcomesFileName = "outcomes.v1.json";
export const physicalBlindPredictionsFileName = "predictions.v1.json";

/**
 * 自述 outcomes 即使有自哈希，也不能证明付费前 active、代码/配置/模型/提示词
 * 身份、永久失败污染或真实 HTTP EOF。可信 difficulty 与 verdict 适配器同时完成
 * 前，这两个兼容入口固定失败关闭，不能封印人工构造的 complete prediction。
 */
export function sealPhysicalBlindOutcomeDocument<TPrediction>(input: {
  readonly contentDocument: string;
  readonly outcomesDocument: string;
  readonly predictionSchema: z.ZodType<TPrediction>;
}): never {
  void input;
  return failPhysicalBlind("BLIND_TRUSTED_EXECUTION_ADAPTER_REQUIRED");
}

export function sealPhysicalBlindOutcomesFromPrivateFiles<TPrediction>(input: {
  readonly contentDirectory: string;
  readonly outcomesDirectory: string;
  readonly outputDirectory: string;
  readonly predictionSchema: z.ZodType<TPrediction>;
  readonly directoryOptions?: PhysicalBlindPrivateDirectoryOptions;
}): never {
  void input;
  return failPhysicalBlind("BLIND_TRUSTED_EXECUTION_ADAPTER_REQUIRED");
}
