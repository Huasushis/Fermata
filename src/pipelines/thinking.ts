/**
 * 思维难度流水线，分三步：
 *   1. 用思考模型只看题面（不给标准题解）独立解题，记录它的推理/解题过程；
 *   2. 用分析模型对比这段解题过程和标准题解，输出结构化信号
 *      {solved, approachSimilarity, selfCorrections, keyInsightCount}；
 *   3. 纯代码把这些信号映射到 1-5 的等级（mapThinkingSignalsToLevel）。
 *
 * 第 3 步的映射公式是初始标定，不是理论推导，修改前必须先跑一遍类似
 * experiments/eval-difficulty.ts 的对比评估，不能凭感觉改（见 AGENTS.md）。
 */
import { z } from "zod";
import {
  chatComplete,
  chatCompleteJson,
  type ChatCompletionResult,
  type ChatMessage
} from "../llm";
import { clampLevel, type PipelineModelConfig, type ReviewTaskProblem } from "./types";

export interface ThinkingPipelineInput {
  readonly problem: ReviewTaskProblem;
  readonly solverModel: PipelineModelConfig;
  readonly analystModel: PipelineModelConfig;
}

export interface ThinkingSignals {
  readonly solved: boolean;
  readonly approachSimilarity: number;
  readonly selfCorrections: number;
  readonly keyInsightCount: number;
}

export interface ThinkingResult {
  /** 1-5，已经 clamp 过。 */
  readonly level: number;
  readonly signals: ThinkingSignals;
  /** 只留解题过程文本的长度，不留原文——避免日志/中间结果里出现大段模型输出。 */
  readonly solverNarrativeLength: number;
  readonly rationale: string;
}

const thinkingSignalsRawSchema = z.object({
  solved: z.boolean(),
  approachSimilarity: z.number().min(0).max(1),
  selfCorrections: z.number().int().min(0).max(50),
  keyInsightCount: z.number().int().min(0).max(50),
  rationale: z.string().trim().min(1).max(2_000)
});

/**
 * 信号 -> 等级的权重表。初始标定：
 *   - 没解出来是最强的"难"信号；
 *   - 思路和标准题解越接近，说明越"送分"，等级越低；
 *   - 自我纠正次数和关键洞察个数都是"要试错/要灵光一现"的信号，加分。
 * 基线定在 3（中等），最终结果 clamp 到 [1,5]。
 */
export const THINKING_LEVEL_WEIGHTS = {
  base: 3,
  notSolvedPenalty: 1.5,
  approachSimilarityWeight: -2,
  selfCorrectionWeight: 0.4,
  keyInsightWeight: 0.6
} as const;

export function mapThinkingSignalsToLevel(signals: ThinkingSignals): number {
  const solvedTerm = signals.solved ? 0 : THINKING_LEVEL_WEIGHTS.notSolvedPenalty;
  const similarityTerm = THINKING_LEVEL_WEIGHTS.approachSimilarityWeight * signals.approachSimilarity;
  const correctionsTerm = THINKING_LEVEL_WEIGHTS.selfCorrectionWeight * signals.selfCorrections;
  const insightTerm = THINKING_LEVEL_WEIGHTS.keyInsightWeight * signals.keyInsightCount;
  const raw = THINKING_LEVEL_WEIGHTS.base + solvedTerm + similarityTerm + correctionsTerm + insightTerm;
  return clampLevel(raw);
}

/**
 * 部分供应商把思考过程和最终回答放在两个字段里。两者都可能包含后续分析
 * 所需的信息，因此不能在 reasoning 存在时丢掉 content；空白 reasoning 则
 * 不应制造一个假的“思考过程”段落。
 */
export function mergeSolverNarrative(
  result: Pick<ChatCompletionResult, "content" | "reasoning">
): string {
  const reasoning = result.reasoning?.trim() ?? "";
  const content = result.content.trim();
  if (reasoning.length === 0) return content;
  if (content.length === 0) return reasoning;
  return `模型思考过程：\n${reasoning}\n\n模型最终回答：\n${content}`;
}

export async function runThinkingPipeline(input: ThinkingPipelineInput): Promise<ThinkingResult> {
  const solverMessages = buildSolverMessages(input.problem);
  const solverResult = await chatComplete(
    input.solverModel.credentials,
    input.solverModel.spec,
    solverMessages,
    input.solverModel.runtime
  );
  const solverNarrative = mergeSolverNarrative(solverResult);

  const analystMessages = buildAnalystMessages(input.problem, solverNarrative);
  const { data } = await chatCompleteJson(
    input.analystModel.credentials,
    input.analystModel.spec,
    analystMessages,
    thinkingSignalsRawSchema,
    input.analystModel.runtime
  );

  const signals: ThinkingSignals = {
    solved: data.solved,
    approachSimilarity: data.approachSimilarity,
    selfCorrections: data.selfCorrections,
    keyInsightCount: data.keyInsightCount
  };

  return {
    level: mapThinkingSignalsToLevel(signals),
    signals,
    solverNarrativeLength: solverNarrative.length,
    rationale: data.rationale
  };
}

function buildSolverMessages(problem: ReviewTaskProblem): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "你是一名参加算法竞赛的选手。请独立解决下面这道题，完整展示你的思考过程：先理解题意，" +
        "再尝试不同思路，指出遇到的困难和转折点，最后给出你认为正确的解法概述。不要假设你已经" +
        "见过标准题解，也不知道这道题的正确难度。"
    },
    {
      role: "user",
      content: `题目类型：${problem.type}\n\n题面：\n${problem.basicStatement}`
    }
  ];
}

function buildAnalystMessages(problem: ReviewTaskProblem, solverNarrative: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "你是评估算法竞赛选手解题过程的分析专家。会给你题面、标准题解，以及另一名选手独立解题时的" +
        "思考过程记录。请对比选手的思路和标准题解，输出 JSON：" +
        '{"solved": 选手是否得到了正确或等价的解法(布尔值), ' +
        '"approachSimilarity": 选手思路与标准题解的相似程度(0到1，1表示基本一致), ' +
        '"selfCorrections": 选手在过程中明显推翻自己之前想法、重新尝试的次数(整数), ' +
        '"keyInsightCount": 选手在过程中体现出的关键突破性想法个数(整数), ' +
        '"rationale": "简短中文理由"}。'
    },
    {
      role: "user",
      content: [
        `题面：\n${problem.basicStatement}`,
        `标准题解：\n${problem.basicSolution}`,
        `选手的思考过程记录：\n${solverNarrative}`
      ].join("\n\n")
    }
  ];
}
