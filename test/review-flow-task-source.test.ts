import { describe, expect, it } from "vitest";
import {
  anklangSimilarityReviewItemType,
  buildHistoricalCalibrationReviewFlowTaskSource,
  buildReviewFlowTaskSource,
  isBuiltReviewFlowTaskSourceResult,
  isHistoricalCalibrationReviewFlowTaskSourceResult,
  ReviewFlowTaskSourceError,
  type ReviewFlowTaskSourceErrorCode,
  type ReviewFlowTaskSourceResult
} from "../src/review-flow/task-source";
import type { RobotReviewTask } from "../src/urmotiv-schemas";

const problemContentHash = "a".repeat(64);
const otherContentHash = "b".repeat(64);
const assignmentId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const statementMarker = "SYNTHETIC_STATEMENT_MARKER";
const solutionMarker = "SYNTHETIC_SOLUTION_MARKER";
const observedNow = new Date("2026-08-02T10:30:00.000Z");

function completeAnklangV2Data(): Record<string, unknown> {
  return {
    apiVersion: "2",
    contentHash: problemContentHash,
    checkedAt: "2026-08-02T10:00:00.000Z",
    completion: {
      status: "complete",
      reasonCode: "complete",
      retryable: false
    },
    candidates: [{
      source: "public-index",
      externalId: "public-1000-A",
      title: "合成公开候选题",
      url: "https://example.test/problems/1000-A",
      similarity: 0.96,
      sameProblemSuggestion: true,
      explanation: "公开候选在结构上高度相似。"
    }],
    recommendation: {
      blockSubmission: true,
      message: "建议人工复核公开候选。"
    },
    reuse: { policy: "no-store" }
  };
}

function completeTask(): RobotReviewTask {
  return {
    assignmentId,
    leaseExpiresAt: "2026-08-02T10:30:00.000Z",
    problem: {
      id: "synthetic-problem",
      revision: 7,
      reviewRound: 3,
      contentHash: problemContentHash,
      title: "合成题目",
      type: "traditional",
      tagIds: ["basic.simulation"],
      content: {
        basicStatement: `合成基础题面 ${statementMarker}`,
        basicSolution: `合成基础题解 ${solutionMarker}`,
        background: "合成背景",
        statement: "合成正式描述",
        inputFormat: "合成输入格式",
        outputFormat: "合成输出格式",
        constraints: "1 <= n <= 10",
        solution: "合成详细题解",
        hints: "合成提示"
      },
      samples: [{
        safeId: "sample-001",
        input: "1\n",
        output: "1\n",
        explanation: "合成样例说明"
      }],
      limits: { timeMs: 1_000, memoryMiB: 256 }
    },
    tagCatalog: {
      version: 11,
      tags: [
        {
          id: "basic.simulation",
          categoryId: "basic-algorithms",
          categoryName: "基础算法",
          name: "模拟",
          description: "按题意实现。",
          aliases: [],
          active: true
        },
        {
          id: "math.counting",
          categoryId: "math",
          categoryName: "数学",
          name: "计数",
          description: "组合计数。",
          aliases: ["组合计数"],
          active: true
        }
      ]
    },
    reviewItems: [
      {
        id: "anklang-item-1",
        type: anklangSimilarityReviewItemType,
        source: "anklang",
        sourcePluginId: "org.ustc.urmotiv.anklang",
        visibility: "author",
        summary: "合成查重结果。",
        data: completeAnklangV2Data(),
        contentHash: problemContentHash,
        expiresAt: null,
        createdAt: "2026-08-02T10:00:01.000Z"
      },
      {
        id: "unrelated-item-1",
        type: "org.ustc.urmotiv.unrelated.evidence",
        source: "human",
        sourcePluginId: null,
        visibility: "reviewer",
        summary: "其它审核信息。",
        data: {
          apiVersion: "2",
          candidates: [{ similarity: 1, sameProblemSuggestion: true }]
        },
        contentHash: problemContentHash,
        expiresAt: null,
        createdAt: "2026-08-02T10:00:02.000Z"
      }
    ]
  };
}

function build(task: unknown = completeTask(), now: Date = observedNow) {
  return buildReviewFlowTaskSource(task, {
    duplicateSimilarityRejectThreshold: 0.9,
    now: () => new Date(now.getTime())
  });
}

function expectFailure(task: unknown, code: ReviewFlowTaskSourceErrorCode): void {
  let caught: unknown;
  try {
    build(task);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReviewFlowTaskSourceError);
  expect(caught).toMatchObject({ code, message: code });
  expect(JSON.stringify(caught)).not.toContain(statementMarker);
  expect(JSON.stringify(caught)).not.toContain(solutionMarker);
}

describe("robot review task 到可信审题 source 的严格适配", () => {
  it("完整保留任务材料，并只让认证 Anklang 建议进入确定性证据", () => {
    const result = build();

    expect(result.taskBinding).toEqual({
      assignmentId,
      leaseExpiresAt: "2026-08-02T10:30:00.000Z",
      problemId: "synthetic-problem",
      problemRevision: 7,
      expectedRound: 3,
      problemContentHash,
      tagCatalogVersion: 11,
      currentTagIds: ["basic.simulation"]
    });
    for (const marker of [
      "合成题目",
      statementMarker,
      "合成背景",
      "合成正式描述",
      "合成输入格式",
      "合成输出格式",
      "合成提示"
    ]) {
      expect(result.source.statement).toContain(marker);
    }
    expect(result.source.statement).not.toContain(solutionMarker);
    expect(result.source.problemRevision).toBe(7);
    expect(result.source.solution).toContain(solutionMarker);
    expect(result.source.solution).toContain("合成详细题解");
    expect(result.source.constraints).toBe("1 <= n <= 10");
    expect(result.source.samples).toHaveLength(1);
    expect(result.source.samples[0]?.safeId).toBe("sample-001");
    expect(result.source.limits).toEqual({ timeMs: 1_000, memoryMiB: 256 });
    expect(result.source.tagCatalog.map((tag) => tag.id)).toEqual([
      "basic.simulation",
      "math.counting"
    ]);
    expect(result.source.referenceImplementation).toBeNull();

    expect(result.source.duplicateEvidence).toHaveLength(1);
    expect(result.source.duplicateEvidence[0]).toMatchObject({
      source: "public-index",
      externalId: "public-1000-A",
      similarity: 0.96,
      sameProblemSuggestion: true
    });
    expect(result.provenance.anklang).toMatchObject({
      reviewItemType: anklangSimilarityReviewItemType,
      apiVersion: "2",
      checkedAt: "2026-08-02T10:00:00.000Z",
      completionStatus: "complete",
      contentHash: problemContentHash,
      resultHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      contentHashBinding: "matched",
      authenticationStatus: "authenticated_builtin_anklang_plugin",
      reviewItemSource: "anklang",
      sourcePluginId: "org.ustc.urmotiv.anklang",
      reviewItemVisibility: "author",
      reviewItemExpiresAt: null,
      reportedBlockSubmission: true,
      deterministicConfirmationAllowed: true
    });
    expect(result.provenance.anklang.evidence[0]).toMatchObject({
      evidenceId: result.source.duplicateEvidence[0]?.evidenceId,
      candidateIndex: 0,
      serviceReviewSuggestion: true,
      authenticationStatus: "authenticated_builtin_anklang_plugin",
      deterministicConfirmationAllowed: true
    });
    expect(JSON.stringify(result.provenance)).not.toContain(statementMarker);
    expect(JSON.stringify(result.provenance)).not.toContain(solutionMarker);
    expect(result.provenance.referenceImplementation.status).toBe(
      "not_provided_by_robot_task_contract"
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.source)).toBe(true);
    expect(Object.isFrozen(result.provenance.anklang.evidence)).toBe(true);
    expect(isBuiltReviewFlowTaskSourceResult(result)).toBe(true);
    expect(isBuiltReviewFlowTaskSourceResult({ ...result })).toBe(false);
  });

  it("完整 v2 没有候选时保留完整性 provenance，而不是伪造候选", () => {
    const task = completeTask();
    const data = completeAnklangV2Data();
    data.candidates = [];
    data.recommendation = {
      blockSubmission: false,
      message: "完整检索未发现候选。"
    };
    task.reviewItems[0]!.data = data;

    const result = build(task);
    expect(result.source.duplicateEvidence).toEqual([]);
    expect(result.provenance.anklang.evidence).toEqual([]);
    expect(result.provenance.anklang.completionStatus).toBe("complete");
  });

  it("历史结果校准品牌只接受空 reviewItems，并生成不可用于确定性查重的空证据", () => {
    const task = completeTask();
    task.reviewItems = [];
    const result = buildHistoricalCalibrationReviewFlowTaskSource(task, {
      duplicateSimilarityRejectThreshold: 0.9
    });
    expect(result.source.duplicateEvidence).toEqual([]);
    expect(result.provenance.anklang).toEqual({
      inputPolicy: "exclude_current_corpus_for_historical_outcome",
      completionStatus: "excluded",
      reviewItemInjection: "excluded",
      reviewItemExpiresAt: null,
      deterministicConfirmationAllowed: false,
      evidence: []
    });
    expect(isBuiltReviewFlowTaskSourceResult(result)).toBe(true);
    expect(isHistoricalCalibrationReviewFlowTaskSourceResult(result)).toBe(true);
    expect(isHistoricalCalibrationReviewFlowTaskSourceResult({ ...result }))
      .toBe(false);
    expect(() => buildHistoricalCalibrationReviewFlowTaskSource(
      completeTask(),
      { duplicateSimilarityRejectThreshold: 0.9 }
    )).toThrow("REVIEW_FLOW_TASK_ANKLANG_EXCLUSION_INVALID");
  });

  it("缺失或多条同类型 Anklang 条目都 fail closed", () => {
    const missing = completeTask();
    missing.reviewItems = missing.reviewItems.filter(
      (item) => item.type !== anklangSimilarityReviewItemType
    );
    expectFailure(missing, "REVIEW_FLOW_TASK_ANKLANG_ITEM_MISSING");

    const ambiguous = completeTask();
    ambiguous.reviewItems.push({
      ...structuredClone(ambiguous.reviewItems[0]!),
      id: "anklang-item-2"
    });
    expectFailure(ambiguous, "REVIEW_FLOW_TASK_ANKLANG_ITEM_AMBIGUOUS");
  });

  it("伪造来源 fail closed；无复用期限的 no-store 条目保持有效", () => {
    const forgedSource = completeTask();
    forgedSource.reviewItems[0]!.source = "plugin";
    expectFailure(forgedSource, "REVIEW_FLOW_TASK_ANKLANG_SOURCE_UNTRUSTED");

    const forgedPlugin = completeTask();
    forgedPlugin.reviewItems[0]!.sourcePluginId = "org.example.forged";
    expectFailure(forgedPlugin, "REVIEW_FLOW_TASK_INVALID");

    const withoutExpiry = completeTask();
    withoutExpiry.reviewItems[0]!.expiresAt = null;
    expect(build(withoutExpiry).provenance.anklang.reviewItemExpiresAt).toBeNull();
  });

  it("可注入时钟严格拒绝 expiresAt 位于 now-1 或 now，并接受 now+1", () => {
    const expiryOffsets = [-1, 0, 1] as const;
    for (const offsetMs of expiryOffsets) {
      const task = completeTask();
      const expiresAt = new Date(observedNow.getTime() + offsetMs).toISOString();
      const data = completeAnklangV2Data();
      data.reuse = { policy: "allowed", expiresAt };
      task.reviewItems[0]!.data = data;
      task.reviewItems[0]!.expiresAt = expiresAt;

      if (offsetMs <= 0) {
        expectFailure(task, "REVIEW_FLOW_TASK_ANKLANG_ITEM_EXPIRED");
      } else {
        expect(build(task).provenance.anklang.reviewItemExpiresAt).toBe(expiresAt);
      }
    }
  });

  it("认证条目的 expiresAt 必须与 allowed reuse 完全一致，no-store 则必须为 null", () => {
    const allowedExpiry = "2026-08-02T10:31:00.000Z";

    const missingItemExpiry = completeTask();
    const missingItemExpiryData = completeAnklangV2Data();
    missingItemExpiryData.reuse = { policy: "allowed", expiresAt: allowedExpiry };
    missingItemExpiry.reviewItems[0]!.data = missingItemExpiryData;
    expectFailure(
      missingItemExpiry,
      "REVIEW_FLOW_TASK_ANKLANG_EXPIRY_MISMATCH"
    );

    const differentExpiry = completeTask();
    const differentExpiryData = completeAnklangV2Data();
    differentExpiryData.reuse = { policy: "allowed", expiresAt: allowedExpiry };
    differentExpiry.reviewItems[0]!.data = differentExpiryData;
    differentExpiry.reviewItems[0]!.expiresAt = "2026-08-02T10:32:00.000Z";
    expectFailure(
      differentExpiry,
      "REVIEW_FLOW_TASK_ANKLANG_EXPIRY_MISMATCH"
    );

    const noStoreWithExpiry = completeTask();
    noStoreWithExpiry.reviewItems[0]!.expiresAt = allowedExpiry;
    expectFailure(
      noStoreWithExpiry,
      "REVIEW_FLOW_TASK_ANKLANG_EXPIRY_MISMATCH"
    );
  });

  it("同类型旧版、畸形 v2 和不完整 v2 都 fail closed", () => {
    const legacy = completeTask();
    legacy.reviewItems[0]!.data = {
      apiVersion: "1",
      contentHash: problemContentHash,
      checkedAt: "2026-08-02T10:00:00.000Z",
      candidates: [],
      recommendation: { blockSubmission: false, message: "旧版结果。" }
    };
    expectFailure(legacy, "REVIEW_FLOW_TASK_ANKLANG_VERSION_UNSUPPORTED");

    const malformed = completeTask();
    const malformedData = completeAnklangV2Data();
    delete malformedData.reuse;
    malformed.reviewItems[0]!.data = malformedData;
    expectFailure(malformed, "REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID");

    const partial = completeTask();
    const partialData = completeAnklangV2Data();
    partialData.completion = {
      status: "partial",
      reasonCode: "search_partial",
      retryable: true
    };
    partial.reviewItems[0]!.data = partialData;
    expectFailure(partial, "REVIEW_FLOW_TASK_ANKLANG_RESULT_INCOMPLETE");

    const unavailable = completeTask();
    const unavailableData = completeAnklangV2Data();
    unavailableData.completion = {
      status: "unavailable",
      reasonCode: "service_unavailable",
      retryable: true
    };
    unavailableData.candidates = [];
    unavailableData.recommendation = {
      blockSubmission: false,
      message: "本次检索不可用。"
    };
    unavailable.reviewItems[0]!.data = unavailableData;
    expectFailure(unavailable, "REVIEW_FLOW_TASK_ANKLANG_RESULT_INCOMPLETE");
  });

  it("review item、Anklang data 与 problem 的 contentHash 任一不一致都 fail closed", () => {
    const itemMismatch = completeTask();
    itemMismatch.reviewItems[0]!.contentHash = otherContentHash;
    expectFailure(
      itemMismatch,
      "REVIEW_FLOW_TASK_ANKLANG_CONTENT_HASH_MISMATCH"
    );

    const dataMismatch = completeTask();
    const data = completeAnklangV2Data();
    data.contentHash = otherContentHash;
    dataMismatch.reviewItems[0]!.data = data;
    expectFailure(
      dataMismatch,
      "REVIEW_FLOW_TASK_ANKLANG_CONTENT_HASH_MISMATCH"
    );
  });

  it("不完整核心材料、未知当前标签和畸形机器人任务都 fail closed", () => {
    const missingStatement = completeTask();
    missingStatement.problem.content.basicStatement = "";
    missingStatement.problem.content.statement = "";
    expectFailure(
      missingStatement,
      "REVIEW_FLOW_TASK_MATERIAL_INCOMPLETE"
    );

    const missingSolution = completeTask();
    missingSolution.problem.content.basicSolution = "";
    missingSolution.problem.content.solution = "";
    expectFailure(
      missingSolution,
      "REVIEW_FLOW_TASK_MATERIAL_INCOMPLETE"
    );

    const unknownTag = completeTask();
    unknownTag.problem.tagIds = ["unknown.tag"];
    expectFailure(
      unknownTag,
      "REVIEW_FLOW_TASK_TAG_CATALOG_MISMATCH"
    );

    const extraField = {
      ...completeTask(),
      unexpected: true
    };
    expectFailure(extraField, "REVIEW_FLOW_TASK_INVALID");
  });

  it("非法阈值由最终 ReviewFlowSource strict schema 固定拒绝", () => {
    let caught: unknown;
    try {
      buildReviewFlowTaskSource(completeTask(), {
        duplicateSimilarityRejectThreshold: 1.1
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "REVIEW_FLOW_TASK_SOURCE_INVALID",
      message: "REVIEW_FLOW_TASK_SOURCE_INVALID"
    });
  });
});

describe("candidate.metadata 镜像契约", () => {
  function taskWithCandidateMetadata(metadata: unknown): RobotReviewTask {
    const task = completeTask();
    const data = completeAnklangV2Data();
    const candidates = data.candidates as unknown[];
    (candidates[0] as Record<string, unknown>).metadata = metadata;
    task.reviewItems[0]!.data = data;
    return task;
  }

  it("合法标量 metadata 原样保留进认证 provenance，决策输入保持不变", () => {
    const metadata = {
      origin: "CF 1000A",
      rounds: 3,
      pinned: true,
      archived: null,
      score: 0.75,
      display_order: 2
    } as const;
    const withMetadata = build(taskWithCandidateMetadata(metadata));
    const withoutMetadata = build(completeTask());

    // metadata 只进入 provenance evidence，不进 duplicateEvidence/裁决。
    expect(withMetadata.provenance.anklang.evidence[0]).toMatchObject({
      metadata
    });
    expect(Object.keys(withMetadata.source.duplicateEvidence[0]!).sort()).toEqual(
      ["evidenceId", "sameProblemSuggestion", "similarity", "source", "summary", "externalId"]
        .sort()
    );
    // 有无 metadata 时 duplicateEvidence 逐字节/语义等价。
    expect(withMetadata.source.duplicateEvidence).toEqual(
      withoutMetadata.source.duplicateEvidence
    );
    expect(withMetadata.source).toEqual(withoutMetadata.source);
    expect(withMetadata.taskBinding).toEqual(withoutMetadata.taskBinding);
  });

  function authenticatedAnklang(result: ReviewFlowTaskSourceResult) {
    const provenance = result.provenance.anklang;
    if ("resultHash" in provenance) return provenance;
    throw new Error("expected authenticated provenance");
  }

  it("结果身份哈希与证据 id 在有/无 metadata 时逐字节相同", () => {
    const metadata = { origin: "CF 1000A", rounds: 3 };
    const withResult = build(taskWithCandidateMetadata(metadata));
    const withMetadata = authenticatedAnklang(withResult);
    const withoutResult = build(completeTask());
    const withoutMetadata = authenticatedAnklang(withoutResult);
    expect(withMetadata.resultHash).toBe(withoutMetadata.resultHash);
    expect(withMetadata.evidence[0]?.evidenceId).toBe(
      withoutMetadata.evidence[0]?.evidenceId
    );
    const [withId, withoutId] = [
      withResult.source.duplicateEvidence[0]!.evidenceId,
      withoutResult.source.duplicateEvidence[0]!.evidenceId
    ];
    expect(withId).toBe(withoutId);
  });

  it("空对象与缺失同样视为没有 metadata，provenance 省略该字段", () => {
    const withEmpty = authenticatedAnklang(
      build(taskWithCandidateMetadata({}))
    );
    const withoutMetadata = authenticatedAnklang(build(completeTask()));
    expect("metadata" in withEmpty.evidence[0]!).toBe(false);
    expect(withEmpty.evidence[0]).toEqual(withoutMetadata.evidence[0]);
    expect(withEmpty.resultHash).toBe(withoutMetadata.resultHash);
  });

  it("键名、键数量、值类型与整包字节的每个边界都 fail closed", () => {
    const invalidKeyBadChar = taskWithCandidateMetadata({ "BadKey": "x" });
    expectFailure(invalidKeyBadChar, "REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID");

    const invalidKeyDigitStart = taskWithCandidateMetadata({ "1abc": "x" });
    expectFailure(invalidKeyDigitStart, "REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID");

    const invalidKeyHyphen = taskWithCandidateMetadata({ "a-b": "x" });
    expectFailure(invalidKeyHyphen, "REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID");

    const invalidKeyDot = taskWithCandidateMetadata({ "a.b": "x" });
    expectFailure(invalidKeyDot, "REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID");

    const tooLongKey = taskWithCandidateMetadata({
      [`a${"a".repeat(64)}`]: "x"
    });
    expectFailure(tooLongKey, "REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID");

    const emptyKey = taskWithCandidateMetadata({ "": "x" });
    expectFailure(emptyKey, "REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID");

    const tooManyKeys = taskWithCandidateMetadata(
      Object.fromEntries(
        Array.from({ length: 17 }, (_, i) => [`k${i}`, "x"])
      )
    );
    expectFailure(tooManyKeys, "REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID");

    const nestedObjectButValidScalar = taskWithCandidateMetadata({
      nested: { value: 1 }
    });
    expectFailure(
      nestedObjectButValidScalar,
      "REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID"
    );

    const nestedArray = taskWithCandidateMetadata({
      children: [1, 2, 3]
    });
    expectFailure(nestedArray, "REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID");

    const emptyStringValue = taskWithCandidateMetadata({ empty: "" });
    expectFailure(emptyStringValue, "REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID");

    const untrimmed = taskWithCandidateMetadata({ untrimmed: "  x " });
    expectFailure(untrimmed, "REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID");

    const tooLongString = taskWithCandidateMetadata({
      long: "中".repeat(171) // 每字 3 字节 => 513 字节 > 512
    });
    expectFailure(tooLongString, "REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID");

    const nonFinite = taskWithCandidateMetadata({
      infinity: Number.POSITIVE_INFINITY,
      negativeInfinity: Number.NEGATIVE_INFINITY,
      nan: Number.NaN
    });
    expectFailure(nonFinite, "REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID");

    // 16 个键每个 500 字节 → 总量远超 2048 字节上限；但单值仍 ≤512。
    const overBudget = taskWithCandidateMetadata(
      Object.fromEntries(
        Array.from({ length: 16 }, (_, i) => [`k${i}`, "x".repeat(500)])
      )
    );
    expectFailure(overBudget, "REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID");
  });

  it("candidate 未知字段仍拒绝未声明字段，metadata 必须声明为可用字段", () => {
    const unknownCandidateField = completeTask();
    const data = completeAnklangV2Data();
    const candidates = data.candidates as unknown[];
    const candidate = candidates[0] as Record<string, unknown>;
    candidate.unexpected = true;
    data.candidates = candidates;
    unknownCandidateField.reviewItems[0]!.data = data;
    expectFailure(
      unknownCandidateField,
      "REVIEW_FLOW_TASK_ANKLANG_RESULT_INVALID"
    );

    // 合法 metadata 被完整保留，未引入任何新错误码或字段泄漏。
    const valid = taskWithCandidateMetadata({ origin: "CF", tags: "demo" });
    const result = build(valid);
    expect(result.provenance.anklang.evidence[0]).toMatchObject({
      metadata: { origin: "CF", tags: "demo" }
    });
  });
});
