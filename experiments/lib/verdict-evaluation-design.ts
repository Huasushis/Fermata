import { randomUUID } from "node:crypto";
import type { ReviewTaskItem, ReviewTaskProblem } from "../../src/pipelines/types";

export type VerdictDiagnosticCaseKind = "normal" | "fabricated_duplicate";

export interface PairedVerdictCase<T> {
  readonly sampleId: string;
  readonly caseKind: VerdictDiagnosticCaseKind;
  readonly item: T;
}

export interface PairedVerdictCasePlan<T> {
  readonly selectedItems: readonly T[];
  readonly normal: readonly PairedVerdictCase<T>[];
  readonly fabricatedDuplicate: readonly PairedVerdictCase<T>[];
  readonly expectedSampleIds: readonly string[];
}

export interface VerdictDiagnosticObservation {
  readonly caseKind: VerdictDiagnosticCaseKind;
  readonly expectationMet: boolean;
}

export interface VerdictSyntheticDiagnosticAssessment {
  readonly diagnosticPassed: boolean;
  readonly syntheticDiagnostics: {
    readonly normal: { readonly total: number; readonly metExpectation: number };
    readonly fabricatedDuplicate: { readonly total: number; readonly metExpectation: number };
  };
}

/**
 * complete 只回答“预期调用是否都收束”；这个纯函数另外回答两组接线预期
 * 是否逐例成立。少例、多例或任一反例都会让 diagnosticPassed=false。
 */
export function assessVerdictSyntheticDiagnostic(
  observations: readonly VerdictDiagnosticObservation[],
  expectedPerGroup: number
): VerdictSyntheticDiagnosticAssessment {
  if (!Number.isSafeInteger(expectedPerGroup) || expectedPerGroup < 1) {
    throw new Error("VERDICT_DIAGNOSTIC_EXPECTED_COUNT_INVALID");
  }
  const summarize = (caseKind: VerdictDiagnosticCaseKind) => {
    const rows = observations.filter((observation) => observation.caseKind === caseKind);
    return {
      total: rows.length,
      metExpectation: rows.filter((observation) => observation.expectationMet).length
    };
  };
  const normal = summarize("normal");
  const fabricatedDuplicate = summarize("fabricated_duplicate");
  return {
    diagnosticPassed:
      normal.total === expectedPerGroup &&
      normal.metExpectation === expectedPerGroup &&
      fabricatedDuplicate.total === expectedPerGroup &&
      fabricatedDuplicate.metExpectation === expectedPerGroup,
    syntheticDiagnostics: { normal, fabricatedDuplicate }
  };
}

/** 同一可信样本一对二，避免把题目差异误当成合成审核条目的效果。 */
export function buildPairedVerdictCasePlan<T extends { readonly safeId: string }>(
  orderedItems: readonly T[],
  casesPerGroup: number
): PairedVerdictCasePlan<T> {
  if (!Number.isSafeInteger(casesPerGroup) || casesPerGroup < 1 || orderedItems.length < casesPerGroup) {
    throw new Error("VERDICT_PAIRED_CASES_UNAVAILABLE");
  }
  const selectedItems = orderedItems.slice(0, casesPerGroup);
  const safeIds = selectedItems.map((item) => item.safeId);
  if (
    new Set(safeIds).size !== safeIds.length ||
    safeIds.some((safeId) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(safeId))
  ) {
    throw new Error("VERDICT_PAIRED_CASE_IDS_INVALID");
  }
  const normal = selectedItems.map((item): PairedVerdictCase<T> => ({
    sampleId: `${item.safeId}:normal`,
    caseKind: "normal",
    item
  }));
  const fabricatedDuplicate = selectedItems.map((item): PairedVerdictCase<T> => ({
    sampleId: `${item.safeId}:fabricated_duplicate`,
    caseKind: "fabricated_duplicate",
    item
  }));
  return {
    selectedItems,
    normal,
    fabricatedDuplicate,
    expectedSampleIds: selectedItems.flatMap((item) => [
      `${item.safeId}:normal`,
      `${item.safeId}:fabricated_duplicate`
    ])
  };
}

/**
 * verdict 的模型上下文只包含 ReviewTaskItem.summary；因此合成证据必须写入 summary，
 * data 只用于本地提取数值阈值。该记录只可用于接线诊断，不是真实查重标注。
 */
export function buildFabricatedSimilarityItem(
  problem: ReviewTaskProblem,
  similarity: number,
  now: Date = new Date()
): ReviewTaskItem {
  if (!Number.isFinite(similarity) || similarity < 0 || similarity > 1) {
    throw new Error("VERDICT_FABRICATED_SIMILARITY_INVALID");
  }
  const timestamp = now.toISOString();
  return {
    id: randomUUID(),
    type: "org.ustc.urmotiv.anklang.similarity",
    summary:
      `合成诊断记录：候选题《${problem.title}》与当前题的题面叙述、输入输出格式和数据范围均完全一致，` +
      `仅变量命名不同；最高相似度为 ${(similarity * 100).toFixed(1)}%，请独立判断是否同一道题。`,
    data: {
      apiVersion: "1",
      contentHash: problem.contentHash,
      checkedAt: timestamp,
      candidates: [
        {
          source: "yuantiji",
          externalId: "public-archive-synthetic",
          title: problem.title,
          url: "https://example.test/problem/public-archive-synthetic",
          similarity,
          sameProblemSuggestion: true,
          explanation: "题面叙述、输入输出格式与数据范围与该公开题完全一致，仅变量命名不同。"
        }
      ],
      recommendation: {
        blockSubmission: true,
        message: "候选题与本题几乎完全一致，疑似同一道公开题。"
      }
    },
    contentHash: problem.contentHash,
    createdAt: timestamp
  };
}
