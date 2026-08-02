/**
 * 四条流水线共用的小类型，避免每个文件各自重复定义。
 */
import type { ModelSpec } from "../config";
import type { LlmRuntimeOptions, ProviderCredentialsLike } from "../llm";
import { z } from "zod";
import { problemTypeSchema, type RobotReviewTask } from "../urmotiv-schemas";

/** 旧的四条实验流水线使用的扁平视图；生产编排器会逐步由多角色证据流替换。 */
export const reviewTaskProblemSchema = z
  .object({
    id: z.string().min(1).max(200),
    revision: z.number().int().positive(),
    reviewRound: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    title: z.string().trim().min(1).max(200),
    type: problemTypeSchema,
    tagIds: z.array(z.string().min(1).max(120)).min(1).max(30),
    basicStatement: z.string().min(1).max(2_000_000),
    basicSolution: z.string().min(1).max(1_000_000)
  })
  .strict();
export type ReviewTaskProblem = z.infer<typeof reviewTaskProblemSchema>;

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
