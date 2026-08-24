/**
 * 代码难度流水线：
 *   1. 让模型按"精炼竞赛风格"写一份 C++ 参考实现；
 *   2. 纯代码统计有效代码行数、大括号嵌套深度（作为分支/循环嵌套深度的近似）、
 *      命中了清单里哪些数据结构/算法关键词；
 *   3. 纯代码把这些信号映射到 1-5 的等级（mapCodingSignalsToLevel）。
 *
 * 数据结构清单和权重表、映射公式都是初始标定，不是理论推导，修改前必须先跑
 * 一遍类似 experiments/eval-difficulty.ts 的对比评估，不能凭感觉改（见 AGENTS.md）。
 *
 * 嵌套深度用"大括号计数"近似，不是真的解析语法树；行数统计会先去掉注释和
 * 字符串字面量，避免字符串里的花括号或注释里的文字干扰统计。这是有意的简化，
 * 前提是参考代码是 C++（提示词里明确要求了），如果模型返回了别的语言，这两个
 * 统计量会失真，但不会报错崩溃。
 */
import { chatComplete, type ChatMessage } from "../llm";
import { clampLevel, type PipelineModelConfig, type ReviewTaskProblem } from "./types";

export interface DataStructureSignature {
  readonly label: string;
  readonly pattern: RegExp;
  readonly weight: number;
}

/**
 * 数据结构/算法关键词清单和权重。用识别符里常见的英文缩写匹配，因为提示词
 * 明确要求写 C++，标识符几乎总是英文。初始标定，见文件头注释。
 */
export const DATA_STRUCTURE_SIGNATURES: readonly DataStructureSignature[] = [
  { label: "线段树", pattern: /segment.?tree|segtree/i, weight: 1.5 },
  { label: "树状数组", pattern: /fenwick|binary.?indexed.?tree|\bbit\b/i, weight: 1 },
  { label: "平衡树/Treap/Splay", pattern: /treap|splay|\bavl\b|red.?black|rbtree/i, weight: 2 },
  { label: "并查集", pattern: /union.?find|disjoint.?set|\bdsu\b/i, weight: 0.5 },
  { label: "网络流", pattern: /max.?flow|dinic|mcmf|min.?cost.?flow|edmonds.?karp/i, weight: 2.5 },
  { label: "后缀结构", pattern: /suffix.?array|suffix.?automaton|\bsam\b|suffix.?tree/i, weight: 2.5 },
  { label: "字典树", pattern: /\btrie\b/i, weight: 1 },
  { label: "最短路", pattern: /dijkstra|bellman.?ford|floyd.?warshall|\bspfa\b/i, weight: 1 },
  { label: "计算几何/凸包", pattern: /convex.?hull|computational.?geometry/i, weight: 1.5 },
  { label: "字符串匹配", pattern: /\bkmp\b|z.?function|manacher/i, weight: 1 }
];

/** 映射公式的权重，初始标定。 */
export const CODING_LEVEL_WEIGHTS = {
  base: 1,
  linesPerLevelStep: 35,
  /** 嵌套深度不超过这个值时不额外计分（比如一层循环套一层 if 很常见）。 */
  nestingBaseline: 2,
  nestingWeight: 0.35,
  dataStructureWeightScale: 0.7
} as const;

export interface CodingSignals {
  readonly effectiveLineCount: number;
  readonly maxNestingDepth: number;
  readonly detectedDataStructures: readonly string[];
  /** 命中清单里的最高权重；一个都没命中时为 0。 */
  readonly maxDataStructureWeight: number;
}

export interface CodingPipelineInput {
  readonly problem: ReviewTaskProblem;
  readonly model: PipelineModelConfig;
}

export interface CodingResult {
  /** 1-5，已经 clamp 过。 */
  readonly level: number;
  readonly signals: CodingSignals;
  /** 只留参考代码长度，不留原文。 */
  readonly referenceCodeLength: number;
}

export async function runCodingPipeline(input: CodingPipelineInput): Promise<CodingResult> {
  const messages = buildCodingMessages(input.problem);
  const result = await chatComplete(
    input.model.credentials,
    input.model.spec,
    messages,
    input.model.runtime,
  );
  const code = (extractCodeBlock(result.content) ?? result.content).trim();

  const { labels, maxWeight } = detectDataStructures(code);
  const signals: CodingSignals = {
    effectiveLineCount: computeEffectiveLineCount(code),
    maxNestingDepth: computeMaxBraceDepth(code),
    detectedDataStructures: labels,
    maxDataStructureWeight: maxWeight
  };

  return {
    level: mapCodingSignalsToLevel(signals),
    signals,
    referenceCodeLength: code.length
  };
}

export function mapCodingSignalsToLevel(signals: CodingSignals): number {
  const lineTerm = signals.effectiveLineCount / CODING_LEVEL_WEIGHTS.linesPerLevelStep;
  const extraNesting = Math.max(0, signals.maxNestingDepth - CODING_LEVEL_WEIGHTS.nestingBaseline);
  const nestingTerm = extraNesting * CODING_LEVEL_WEIGHTS.nestingWeight;
  const dataStructureTerm = signals.maxDataStructureWeight * CODING_LEVEL_WEIGHTS.dataStructureWeightScale;
  const raw = CODING_LEVEL_WEIGHTS.base + lineTerm + nestingTerm + dataStructureTerm;
  return clampLevel(raw);
}

export function detectDataStructures(code: string): { labels: string[]; maxWeight: number } {
  const labels: string[] = [];
  let maxWeight = 0;
  for (const signature of DATA_STRUCTURE_SIGNATURES) {
    if (signature.pattern.test(code)) {
      labels.push(signature.label);
      maxWeight = Math.max(maxWeight, signature.weight);
    }
  }
  return { labels, maxWeight };
}

export function computeEffectiveLineCount(code: string): number {
  const stripped = stripCommentsAndLiterals(code);
  return stripped
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
}

export function computeMaxBraceDepth(code: string): number {
  const stripped = stripCommentsAndLiterals(code);
  let depth = 0;
  let max = 0;
  for (const ch of stripped) {
    if (ch === "{") {
      depth += 1;
      max = Math.max(max, depth);
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
    }
  }
  return max;
}

/**
 * 去掉 // 行注释、/* 块注释 和 "..."/'...' 字面量（都不保留内容，只是为了不让
 * 里面的花括号或者文字干扰行数/嵌套统计），但保留换行结构。不是真的词法分析器，
 * 对 C++ 这种类 C 语法足够用。
 */
function stripCommentsAndLiterals(code: string): string {
  let result = "";
  let i = 0;
  while (i < code.length) {
    const twoChars = code.slice(i, i + 2);
    if (twoChars === "//") {
      const newlineIndex = code.indexOf("\n", i);
      i = newlineIndex === -1 ? code.length : newlineIndex;
      continue;
    }
    if (twoChars === "/*") {
      const endIndex = code.indexOf("*/", i + 2);
      i = endIndex === -1 ? code.length : endIndex + 2;
      continue;
    }
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < code.length && code[i] !== quote) {
        i += code[i] === "\\" ? 2 : 1;
      }
      i += 1; // 跳过闭合引号
      continue;
    }
    result += ch;
    i += 1;
  }
  return result;
}

function buildCodingMessages(problem: ReviewTaskProblem): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "你是一名经验丰富的算法竞赛选手。请根据下面的题面和题解，写一份精炼的 C++ 竞赛风格参考实现：" +
        "只用标准库，不需要注释，不需要输入输出以外的多余封装，直接给出完整可编译的单文件代码。" +
        "只输出代码本身，用一个代码块包裹，不要额外解释。"
    },
    {
      role: "user",
      content: `题面：\n${problem.basicStatement}\n\n题解：\n${problem.basicSolution}`
    }
  ];
}

function extractCodeBlock(content: string): string | null {
  const fenced = /```(?:[a-zA-Z0-9+]*)\s*([\s\S]*?)```/.exec(content);
  return fenced?.[1] ?? null;
}
