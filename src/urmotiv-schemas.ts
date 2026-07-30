/**
 * 从 Urmotiv contracts 同步，勿手改。
 *
 * Fermata 是独立仓库，不通过 workspace 依赖 Urmotiv，所以把机器人 API 用到的契约
 * 子集手工镜像到这一个文件里。对齐时间：2026-07-26。来源：
 *
 *   - packages/contracts/src/problem.ts
 *     （problemTypeSchema、difficultyLevelSchema、codeforcesDifficultySchema）
 *   - packages/contracts/src/review.ts
 *     （reviewVerdictSchema、reviewInputSchema）
 *   - packages/contracts/src/robot.ts
 *     （机器人任务领取/续租/提交、Fermata 健康状态与公开设置）
 *
 * 校验规则（min/max/multipleOf/正则/strict）必须和源文件逐字段一致，因为：
 *   - 提交给 Urmotiv 的 review 会在服务端被同名 zod schema 再校验一次；
 *   - Fermata 自己暴露的 health/settings 会被 plugins/fermata-control 用
 *     `.strict()` 的响应 schema 校验，多一个字段（比如不小心把内部字段带出去）
 *     都会直接被插件拒绝。
 *
 * 如果 Urmotiv 那边这几个 schema 发生变化，必须回来手动同步本文件，不要凭记忆改。
 */
import { z } from "zod";

// ---- 来自 packages/contracts/src/problem.ts ----

export const problemTypes = ["traditional", "interactive", "submit_answer"] as const;
export const problemTypeSchema = z.enum(problemTypes);
export type ProblemType = z.infer<typeof problemTypeSchema>;

export const difficultyLevelSchema = z.number().int().min(1).max(5);

export const codeforcesDifficultySchema = z.number().int().min(800).max(3500).multipleOf(100);

// ---- 来自 packages/contracts/src/review.ts ----

export const reviewVerdicts = ["approve", "request_changes", "reject"] as const;
export const reviewVerdictSchema = z.enum(reviewVerdicts);

// 注意：这个 schema 在源文件中没有调用 `.strict()`，这里保持一致，不要加。
export const reviewInputSchema = z.object({
  verdict: reviewVerdictSchema,
  codeforcesDifficulty: codeforcesDifficultySchema,
  qualityLevel: difficultyLevelSchema,
  thinkingLevel: difficultyLevelSchema,
  codingLevel: difficultyLevelSchema,
  tagIds: z.array(z.string().min(1).max(120)).max(30).default([]),
  improvements: z.string().trim().min(1, "请填写主要改进点").max(20_000),
  privateNote: z.string().trim().max(20_000).default(""),
  expectedRound: z.number().int().positive()
});
export type ReviewInput = z.infer<typeof reviewInputSchema>;

// ---- 来自 packages/contracts/src/robot.ts ----

const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const robotReviewTaskSchema = z
  .object({
    assignmentId: z.string().uuid(),
    leaseExpiresAt: z.string().datetime(),
    problem: z
      .object({
        id: z.string().min(1).max(200),
        revision: z.number().int().positive(),
        reviewRound: z.number().int().positive(),
        contentHash: contentHashSchema,
        title: z.string().trim().min(1).max(200),
        type: problemTypeSchema,
        tagIds: z.array(z.string().min(1).max(120)).min(1).max(30),
        basicStatement: z.string().min(1).max(500_000),
        basicSolution: z.string().min(1).max(500_000)
      })
      .strict(),
    reviewItems: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            type: z.string().min(1).max(160),
            summary: z.string().max(1_000),
            data: z.unknown(),
            contentHash: contentHashSchema,
            createdAt: z.string().datetime()
          })
          .strict()
      )
      .max(1_000)
      .default([])
  })
  .strict();
export type RobotReviewTask = z.infer<typeof robotReviewTaskSchema>;

export const claimRobotReviewTasksInputSchema = z
  .object({
    maximumTasks: z.number().int().min(1).max(10).default(1),
    leaseSeconds: z.number().int().min(30).max(1_800).default(300),
    supportedProblemTypes: z.array(problemTypeSchema).min(1).max(3).optional()
  })
  .strict();
export type ClaimRobotReviewTasksInput = z.infer<typeof claimRobotReviewTasksInputSchema>;

export const claimRobotReviewTasksResponseSchema = z
  .object({ items: z.array(robotReviewTaskSchema).max(10) })
  .strict();
export type ClaimRobotReviewTasksResponse = z.infer<typeof claimRobotReviewTasksResponseSchema>;

export const renewRobotReviewTaskInputSchema = z
  .object({
    expectedLeaseExpiresAt: z.string().datetime(),
    leaseSeconds: z.number().int().min(30).max(1_800).default(300)
  })
  .strict();
export type RenewRobotReviewTaskInput = z.infer<typeof renewRobotReviewTaskInputSchema>;

export const renewRobotReviewTaskResponseSchema = z
  .object({ assignmentId: z.string().uuid(), leaseExpiresAt: z.string().datetime() })
  .strict();
export type RenewRobotReviewTaskResponse = z.infer<typeof renewRobotReviewTaskResponseSchema>;

export const completeRobotReviewTaskInputSchema = z
  .object({
    expectedLeaseExpiresAt: z.string().datetime(),
    expectedProblemRevision: z.number().int().positive(),
    experimentVersion: z.string().trim().min(1).max(120),
    modelProfileName: z.string().trim().min(1).max(120),
    review: reviewInputSchema
  })
  .strict();
export type CompleteRobotReviewTaskInput = z.infer<typeof completeRobotReviewTaskInputSchema>;

export const robotReviewTaskCompletionSchema = z
  .object({
    assignmentId: z.string().uuid(),
    accepted: z.literal(true),
    problemStatus: z.enum(["pending_review", "approved", "rejected"])
  })
  .strict();
export type RobotReviewTaskCompletion = z.infer<typeof robotReviewTaskCompletionSchema>;

export const fermataHealthSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    service: z.literal("fermata"),
    apiVersion: z.literal("1"),
    workerRunning: z.boolean(),
    activeTasks: z.number().int().nonnegative(),
    checkedAt: z.string().datetime()
  })
  .strict();
export type FermataHealth = z.infer<typeof fermataHealthSchema>;

export const fermataPublicSettingsSchema = z
  .object({
    enabled: z.boolean(),
    pollingIntervalSeconds: z.number().int().min(5).max(3_600),
    maximumConcurrentTasks: z.number().int().min(1).max(32),
    modelProfileName: z.string().trim().min(1).max(120),
    experimentVersion: z.string().trim().min(1).max(120)
  })
  .strict();
export type FermataPublicSettings = z.infer<typeof fermataPublicSettingsSchema>;

export const fermataPublicSettingsResponseSchema = z
  .object({
    settings: fermataPublicSettingsSchema,
    revision: z.number().int().positive(),
    secretsConfigured: z.boolean()
  })
  .strict();
export type FermataPublicSettingsResponse = z.infer<typeof fermataPublicSettingsResponseSchema>;

export const updateFermataPublicSettingsInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    settings: fermataPublicSettingsSchema
  })
  .strict();
export type UpdateFermataPublicSettingsInput = z.infer<typeof updateFermataPublicSettingsInputSchema>;
