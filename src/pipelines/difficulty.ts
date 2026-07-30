/**
 * CF 难度流水线：给出题面 + 题解 + 若干锚点参考题（真实 Codeforces 难度），
 * 让模型估计一个 800-3500 的整百难度，附带置信度和简短理由。
 *
 * 锚点数据来自 config/anchors/difficulty.json，由 experiments/calibrate-anchors.ts
 * 生成——see AGENTS.md，那份文件里的具体锚点是初始占位数据，正式使用前应该
 * 重新跑一遍生成脚本。
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { chatCompleteJson, type ChatMessage } from "../llm";
import type { PipelineModelConfig, ReviewTaskProblem } from "./types";

export interface DifficultyAnchor {
  readonly contestId: number;
  readonly index: string;
  readonly rating: number;
  readonly summary: string;
}

const difficultyAnchorSchema = z
  .object({
    contestId: z.number().int().positive(),
    index: z.string().trim().min(1).max(10),
    rating: z.number().int().min(800).max(3500),
    summary: z.string().trim().min(1).max(2_000)
  })
  .strict();

const difficultyAnchorsFileSchema = z
  .object({
    provisional: z.boolean().default(false),
    note: z.string().default(""),
    anchors: z.array(difficultyAnchorSchema).max(50)
  })
  .strict();

const defaultAnchorsFilePath = new URL("../../config/anchors/difficulty.json", import.meta.url);

/**
 * 读取并校验 config/anchors/difficulty.json。这个文件目前是手工种子数据（见
 * provisional 字段），正式使用前应该用 experiments/calibrate-anchors.ts 重新
 * 生成——见 AGENTS.md。文件不存在或格式不对时不让整个进程崩溃启动失败，只是
 * 退化成没有锚点（返回空数组），因为锚点缺失只会让难度评估的参照物变少，
 * 不是没法运行的硬性前提。
 */
export function loadDifficultyAnchors(filePath: URL | string = defaultAnchorsFilePath): DifficultyAnchor[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
  const parsed = difficultyAnchorsFileSchema.safeParse(raw);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.anchors;
}

export interface DifficultyPipelineInput {
  readonly problem: ReviewTaskProblem;
  readonly anchors: readonly DifficultyAnchor[];
  readonly model: PipelineModelConfig;
}

export interface DifficultyResult {
  /** 800-3500，整百，已经做过 clamp + round，可以直接用作 reviewInputSchema 的 codeforcesDifficulty。 */
  readonly rating: number;
  readonly confidence: number;
  readonly rationale: string;
}

// LLM 原始输出不强求整百/范围——先如实拿到模型的判断，clamp/round 是之后单独的
// 一步纯代码逻辑，这样两件事都可以独立测试。
const rawDifficultyOutputSchema = z.object({
  rating: z.number().finite(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().trim().min(1).max(2_000)
});

export async function runDifficultyPipeline(input: DifficultyPipelineInput): Promise<DifficultyResult> {
  const messages = buildDifficultyMessages(input.problem, input.anchors);
  const { data } = await chatCompleteJson(
    input.model.credentials,
    input.model.spec,
    messages,
    rawDifficultyOutputSchema,
    input.model.runtime
  );
  return {
    rating: clampAndRoundDifficultyRating(data.rating),
    confidence: data.confidence,
    rationale: data.rationale
  };
}

/** 夹到 [800,3500] 再取整百，和 packages/contracts 里 codeforcesDifficultySchema 的约束对齐。 */
export function clampAndRoundDifficultyRating(rawRating: number): number {
  const clamped = Math.min(3500, Math.max(800, rawRating));
  return Math.round(clamped / 100) * 100;
}

function buildDifficultyMessages(
  problem: ReviewTaskProblem,
  anchors: readonly DifficultyAnchor[]
): ChatMessage[] {
  const system: ChatMessage = {
    role: "system",
    content:
      "你是一名经验丰富的算法竞赛出题与难度评估专家。请参考给出的锚点题目（真实 Codeforces 难度）作为" +
      "标定基准，估计目标题目在 Codeforces 评分体系下的难度（800 到 3500，整百）。只依据题面和题解本身" +
      '判断，不要臆测未给出的信息。输出 JSON：{"rating": 数字, "confidence": 0到1之间的数字, ' +
      '"rationale": "简短中文理由"}。'
  };

  const messages: ChatMessage[] = [system];

  if (anchors.length > 0) {
    const anchorLines = anchors.map(
      (anchor) => `- [CF ${anchor.contestId}${anchor.index}，真实难度 ${anchor.rating}] ${anchor.summary}`
    );
    messages.push({ role: "user", content: `参考锚点：\n${anchorLines.join("\n")}` });
  }

  messages.push({
    role: "user",
    content: [
      `题目类型：${problem.type}`,
      `题目标题：${problem.title}`,
      `题面：\n${problem.basicStatement}`,
      `题解：\n${problem.basicSolution}`
    ].join("\n\n")
  });

  return messages;
}
