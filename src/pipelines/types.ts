/**
 * 四条流水线共用的小类型，避免每个文件各自重复定义。
 */
import type { ModelSpec } from "../config";
import type { LlmRuntimeOptions, ProviderCredentialsLike } from "../llm";
import type { RobotReviewTask } from "../urmotiv-schemas";

/** 机器人任务里题目部分的类型，直接从契约类型上取，保证和契约同步。 */
export type ReviewTaskProblem = RobotReviewTask["problem"];

/** 机器人任务里已有审核条目的类型。 */
export type ReviewTaskItem = RobotReviewTask["reviewItems"][number];

/** 某条流水线要用哪个模型、用什么凭据、什么超时/重试参数——三者总是一起出现。 */
export interface PipelineModelConfig {
  readonly spec: ModelSpec;
  readonly credentials: ProviderCredentialsLike;
  readonly runtime: LlmRuntimeOptions;
}

/** 1-5 整数等级的公共 clamp 逻辑，思维难度和代码难度的映射公式共用。 */
export function clampLevel(rawLevel: number): number {
  return Math.min(5, Math.max(1, Math.round(rawLevel)));
}
