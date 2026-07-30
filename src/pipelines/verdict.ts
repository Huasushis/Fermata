/**
 * 综合流水线：输入题面、题解、三条难度流水线的结果、已有审核条目摘要（比如
 * Anklang 查重给出的相似度），输出一份满足 reviewInputSchema 的审核意见。
 *
 * 注意 reviewInputSchema（packages/contracts/src/review.ts）实际字段是
 * verdict / codeforcesDifficulty / qualityLevel / thinkingLevel / codingLevel /
 * tagIds / improvements / privateNote / expectedRound，没有独立的
 * "publicComment" 字段——improvements 本身就是必填、面向审核意见的主要内容。
 *
 * 阈值规则："已有审核条目显示的最高相似度超过 VERDICT_THRESHOLDS.duplicateSimilarityReject，
 * 且模型自己也判断是同一道题" 时，不管模型给的 verdict 是什么，都强制改判为 reject。
 * 这条规则本身（shouldForceRejectAsDuplicate）是纯函数，不依赖网络，可以直接测试。
 *
 * 已有审核条目的 `data` 字段在契约里是 z.unknown()——不同插件（比如 Anklang）写入的
 * 结构可能不一样，这里用 extractDuplicateSimilarity 尽力而为地识别几种常见形状
 * （data.similarity / data.topSimilarity / data.candidates[].similarity），识别不出
 * 就当作没有相似度信息，不会报错。等 Anklang 那边的 reviewItem 数据结构定下来，
 * 应该回来对齐这里的识别逻辑。
 *
 * 知识点标签修正：目前 Fermata 没有从机器人 API 拿到 Urmotiv 的标签词表，没办法
 * 判断自己想出来的标签 id 是不是真实存在，所以这里没有让模型自由建议标签，
 * tagIds 总是空数组。如果以后机器人 API 暴露了标签列表，可以在这里启用。
 */
import { z } from "zod";
import { chatCompleteJson, type ChatMessage } from "../llm";
import { reviewInputSchema, type ReviewInput } from "../urmotiv-schemas";
import type { CodingResult } from "./coding";
import type { DifficultyResult } from "./difficulty";
import type { ThinkingResult } from "./thinking";
import type { PipelineModelConfig, ReviewTaskItem, ReviewTaskProblem } from "./types";

export const VERDICT_THRESHOLDS = {
  /**
   * 已有审核条目里的相似度超过这个值、且模型自己也确认是同一道题时，强制拒绝。
   * 初始标定，修改前必须先跑评测脚本对比，不能凭感觉改。
   */
  duplicateSimilarityReject: 0.9
} as const;

export interface VerdictPipelineInput {
  readonly problem: ReviewTaskProblem;
  readonly reviewItems: readonly ReviewTaskItem[];
  readonly difficulty: DifficultyResult;
  readonly thinking: ThinkingResult;
  readonly coding: CodingResult;
  /** 对应 problem.reviewRound，写进 review.expectedRound 做乐观锁。 */
  readonly expectedRound: number;
  readonly model: PipelineModelConfig;
}

export interface VerdictOutput {
  /** 已经用 reviewInputSchema 校验过，可以直接放进 completeRobotReviewTaskInputSchema 的 review 字段。 */
  readonly review: ReviewInput;
  /** 是否被查重阈值规则强制改判过，方便上层记录/日志，不影响提交内容。 */
  readonly forcedDuplicateReject: boolean;
  readonly highestKnownSimilarity: number;
}

const verdictRawOutputSchema = z.object({
  verdict: z.enum(["approve", "request_changes", "reject"]),
  qualityLevel: z.number().int().min(1).max(5),
  mainImprovement: z.string().trim().min(1).max(2_000),
  sameProblemAsExisting: z.boolean(),
  privateNote: z.string().trim().max(2_000).default("")
});

export async function runVerdictPipeline(input: VerdictPipelineInput): Promise<VerdictOutput> {
  const highestKnownSimilarity = extractHighestDuplicateSimilarity(input.reviewItems);
  const messages = buildVerdictMessages(input, highestKnownSimilarity);
  const { data } = await chatCompleteJson(
    input.model.credentials,
    input.model.spec,
    messages,
    verdictRawOutputSchema,
    input.model.runtime
  );

  const forcedDuplicateReject = shouldForceRejectAsDuplicate(highestKnownSimilarity, data.sameProblemAsExisting);
  const verdict = forcedDuplicateReject ? "reject" : data.verdict;
  const improvements = forcedDuplicateReject
    ? `系统判定与已有题目高度相似（已知最高相似度 ${highestKnownSimilarity.toFixed(2)}），疑似重复题目，请核实。${data.mainImprovement}`
    : data.mainImprovement;

  const review = reviewInputSchema.parse({
    verdict,
    codeforcesDifficulty: input.difficulty.rating,
    qualityLevel: data.qualityLevel,
    thinkingLevel: input.thinking.level,
    codingLevel: input.coding.level,
    tagIds: [],
    improvements,
    privateNote: data.privateNote,
    expectedRound: input.expectedRound
  } satisfies ReviewInput);

  return { review, forcedDuplicateReject, highestKnownSimilarity };
}

/** 相似度超过阈值、且模型自己也认为是同一道题时，强制拒绝。纯函数，方便直接测试阈值边界。 */
export function shouldForceRejectAsDuplicate(highestSimilarity: number, llmConfirmsSameProblem: boolean): boolean {
  return highestSimilarity > VERDICT_THRESHOLDS.duplicateSimilarityReject && llmConfirmsSameProblem;
}

/**
 * 尽力而为地从已有审核条目的 data 字段里找一个 0-1 的相似度数值，尝试几种
 * 可能的形状；找不到就跳过这一条，不会抛错。找到多条时取最大值。
 */
export function extractHighestDuplicateSimilarity(reviewItems: readonly ReviewTaskItem[]): number {
  let highest = 0;
  for (const item of reviewItems) {
    const similarity = extractSimilarityFromData(item.data);
    if (similarity !== null) {
      highest = Math.max(highest, similarity);
    }
  }
  return highest;
}

function extractSimilarityFromData(data: unknown): number | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (isUnitInterval(record.similarity)) {
    return record.similarity;
  }
  if (isUnitInterval(record.topSimilarity)) {
    return record.topSimilarity;
  }
  if (Array.isArray(record.candidates)) {
    const similarities = record.candidates
      .map((candidate) =>
        typeof candidate === "object" && candidate !== null
          ? (candidate as Record<string, unknown>).similarity
          : undefined
      )
      .filter(isUnitInterval);
    if (similarities.length > 0) {
      return Math.max(...similarities);
    }
  }
  return null;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}

function buildVerdictMessages(input: VerdictPipelineInput, highestKnownSimilarity: number): ChatMessage[] {
  const reviewItemsSummary =
    input.reviewItems.length === 0
      ? "（没有已有的审核条目）"
      : input.reviewItems.map((item) => `- [${item.type}] ${item.summary}`).join("\n");

  const system: ChatMessage = {
    role: "system",
    content:
      "你是算法竞赛协会的资深审题人，正在给一道题目写结构化审核意见。已经有三项自动化难度评估" +
      "结果可以参考：CF 难度、思维难度、代码难度。如果已有审核条目显示这道题和已有题目相似度较高，" +
      "且你自己看完题面后也认为确实是同一道题（只是改了数字或者包装），把 sameProblemAsExisting 设为" +
      "true；否则设为 false，即使相似度分数较高，也要基于你自己的判断，不要盲目采信。输出 JSON，字段为：" +
      'verdict(approve/request_changes/reject)、qualityLevel(1-5 的整数，题目整体质量)、' +
      "mainImprovement(必填，最主要的改进建议，即使判定 approve 也可以给一条可选的小建议)、" +
      "sameProblemAsExisting(布尔值)、privateNote(可选，仅审题人可见的备注，没有就留空字符串)。"
  };

  const contextLines = [
    `题目类型：${input.problem.type}`,
    `题目标题：${input.problem.title}`,
    `题面：\n${input.problem.basicStatement}`,
    `题解：\n${input.problem.basicSolution}`,
    `自动化难度评估：CF 难度 ${input.difficulty.rating}（置信度 ${input.difficulty.confidence.toFixed(2)}），` +
      `思维难度 ${input.thinking.level}/5，代码难度 ${input.coding.level}/5。`,
    `已有审核条目摘要：\n${reviewItemsSummary}`
  ];
  if (highestKnownSimilarity > 0) {
    contextLines.push(`已知与其它题目的最高相似度分数：${highestKnownSimilarity.toFixed(2)}。`);
  }

  return [system, { role: "user", content: contextLines.join("\n\n") }];
}
