import { reviewTaskProblemSchema, type ReviewTaskProblem } from "./pipelines/types";
import type { RobotReviewTask } from "./urmotiv-schemas";

type RobotProblem = RobotReviewTask["problem"];

/**
 * 旧实验流水线仍接收两个扁平 Markdown 字段。这里从机器人快照完整组装，绝不只取
 * basicStatement/basicSolution 而丢掉正式题面、格式、约束、提示、样例或资源限制。
 */
export function toLegacyPipelineProblem(problem: RobotProblem): ReviewTaskProblem {
  return reviewTaskProblemSchema.parse({
    id: problem.id,
    revision: problem.revision,
    reviewRound: problem.reviewRound,
    contentHash: problem.contentHash,
    title: problem.title,
    type: problem.type,
    tagIds: [...problem.tagIds],
    basicStatement: buildCompleteStatement(problem),
    basicSolution: buildCompleteSolution(problem)
  });
}

export function buildCompleteStatement(problem: RobotProblem): string {
  const content = problem.content;
  const sections: Array<readonly [string, string]> = [
    ["基础题面", content.basicStatement],
    ["背景", content.background],
    ["题目描述", content.statement],
    ["输入格式", content.inputFormat],
    ["输出格式", content.outputFormat],
    ["数据范围与约束", content.constraints],
    ["提示", content.hints]
  ];
  if (problem.samples.length > 0) {
    sections.push([
      "公开样例",
      problem.samples.map((sample) => [
        `样例 ${sample.safeId}`,
        `输入：\n${sample.input}`,
        `输出：\n${sample.output}`,
        sample.explanation.length === 0 ? "" : `说明：\n${sample.explanation}`
      ].filter((part) => part.length > 0).join("\n\n")).join("\n\n")
    ]);
  }
  if (problem.limits !== null) {
    sections.push([
      "资源限制",
      `时间：${problem.limits.timeMs} ms\n\n内存：${problem.limits.memoryMiB} MiB`
    ]);
  }
  return joinSections(sections);
}

export function buildCompleteSolution(problem: RobotProblem): string {
  return joinSections([
    ["基础题解", problem.content.basicSolution],
    ["详细题解", problem.content.solution]
  ]);
}

function joinSections(sections: readonly (readonly [string, string])[]): string {
  return sections
    .filter(([, content]) => content.trim().length > 0)
    .map(([heading, content]) => `## ${heading}\n\n${content}`)
    .join("\n\n");
}
