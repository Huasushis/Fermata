import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  BlindEvaluationError,
  assertBlindDatasetSeparation,
  buildBlindContentDataset,
  buildBlindGoldDataset,
  deriveBlindContentSubset,
  joinBlindPredictionsWithGold,
  loadBlindContentDocument,
  runBlindInference,
  type BlindPrediction
} from "../experiments/lib/blind-evaluation";
import type { ReviewTaskProblem } from "../src/pipelines/types";

const goldSchema = z
  .object({
    officialRating: z.number().int(),
    humanThinkingLevel: z.number().int(),
    humanCodingLevel: z.number().int(),
    expectedVerdict: z.string()
  })
  .strict();

function problem(id: string): ReviewTaskProblem {
  return {
    id,
    revision: 1,
    reviewRound: 1,
    contentHash: id.padEnd(64, "0").slice(0, 64),
    title: `synthetic-${id}`,
    type: "traditional",
    tagIds: ["synthetic"],
    basicStatement: `statement-${id}`,
    basicSolution: `solution-${id}`
  };
}

describe("盲评内容与答案隔离", () => {
  it("内容 strict schema 在推理前拒绝 gold、自报难度和预期结论字段", () => {
    const document = JSON.stringify({
      schemaVersion: 1,
      datasetId: "development-a",
      purpose: "development",
      samples: [{
        safeId: "sample-a",
        problem: problem("a"),
        rating: 2600,
        humanThinkingLevel: 5,
        expectedVerdict: "reject"
      }]
    });
    expect(() => loadBlindContentDocument(document)).toThrowError(
      expect.objectContaining<Partial<BlindEvaluationError>>({
        code: "BLIND_CONTENT_DOCUMENT_INVALID"
      })
    );
  });

  it("推理回调只收到递归冻结的内容，prompt 输入不含 gold sentinel", async () => {
    const content = buildBlindContentDataset({
      datasetId: "development-a",
      purpose: "development",
      samples: [{ safeId: "sample-a", problem: problem("a") }]
    });
    const sentinel = "GOLD_MUST_NEVER_ENTER_PROMPT";
    const gold = buildBlindGoldDataset({
      content,
      goldSchema,
      samples: [{
        safeId: "sample-a",
        contentHash: problem("a").contentHash,
        gold: {
          officialRating: 2600,
          humanThinkingLevel: 5,
          humanCodingLevel: 4,
          expectedVerdict: sentinel
        }
      }]
    });
    let serializedPromptInput = "";
    const predictions = await runBlindInference({
      content,
      concurrency: 1,
      infer: async (sample) => {
        serializedPromptInput = JSON.stringify(sample);
        expect(Object.keys(sample).sort()).toEqual(["problem", "safeId"]);
        expect(Object.isFrozen(sample)).toBe(true);
        expect(Object.isFrozen(sample.problem)).toBe(true);
        expect(() => {
          (sample.problem as { title: string }).title = "mutated";
        }).toThrow();
        return { predictedRating: 2500 };
      }
    });
    expect(serializedPromptInput).not.toContain(sentinel);
    expect(serializedPromptInput).not.toContain("officialRating");
    expect(serializedPromptInput).not.toContain("humanThinkingLevel");
    expect(serializedPromptInput).not.toContain("expectedVerdict");

    const joined = joinBlindPredictionsWithGold({ content, gold, predictions });
    expect(joined[0]?.gold.expectedVerdict).toBe(sentinel);
    expect(joined[0]?.prediction.predictedRating).toBe(2500);
  });

  it("并发样本全部结束前不会进入 gold 评分阶段", async () => {
    const content = buildBlindContentDataset({
      datasetId: "development-batch",
      purpose: "development",
      samples: [
        { safeId: "sample-a", problem: problem("a") },
        { safeId: "sample-b", problem: problem("b") }
      ]
    });
    const goldSentinel = "GOLD_BATCH_SENTINEL_31337";
    const gold = buildBlindGoldDataset({
      content,
      goldSchema,
      samples: content.samples.map((sample) => ({
        safeId: sample.safeId,
        contentHash: sample.problem.contentHash,
        gold: {
          officialRating: 2600,
          humanThinkingLevel: 5,
          humanCodingLevel: 4,
          expectedVerdict: goldSentinel
        }
      }))
    });
    let releaseFirst = (): void => undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond = (): void => undefined;
    const secondCanFinish = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let notifyBothStarted = (): void => undefined;
    const bothStarted = new Promise<void>((resolve) => {
      notifyBothStarted = resolve;
    });
    let started = 0;
    const score = vi.fn((
      predictions: readonly BlindPrediction<{ readonly predictedRating: number }>[]
    ) =>
      joinBlindPredictionsWithGold({ content, gold, predictions })
    );
    const observed = runBlindInference({
      content,
      concurrency: 2,
      infer: async (sample) => {
        started += 1;
        if (started === 2) {
          notifyBothStarted();
        }
        await (sample.safeId === "sample-a" ? firstCanFinish : secondCanFinish);
        return { predictedRating: 2500 };
      }
    }).then(score);

    await bothStarted;
    releaseFirst();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(score).not.toHaveBeenCalled();
    releaseSecond();
    const joined = await observed;
    expect(score).toHaveBeenCalledOnce();
    expect(JSON.stringify(score.mock.calls[0]?.[0])).not.toContain(goldSentinel);
    expect(joined).toHaveLength(2);
  });

  it("首个失败一发生就关闸；异步失败持久化期间不会启动排队推理", async () => {
    const content = buildBlindContentDataset({
      datasetId: "development-fail-stop",
      purpose: "development",
      samples: [
        { safeId: "sample-a", problem: problem("a") },
        { safeId: "sample-b", problem: problem("b") },
        { safeId: "sample-c", problem: problem("c") },
        { safeId: "sample-d", problem: problem("d") }
      ]
    });
    let releaseSecond = (): void => undefined;
    const secondCanFinish = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let notifyBothStarted = (): void => undefined;
    const bothStarted = new Promise<void>((resolve) => {
      notifyBothStarted = resolve;
    });
    let notifyFailureCallback = (): void => undefined;
    const failureCallbackStarted = new Promise<void>((resolve) => {
      notifyFailureCallback = resolve;
    });
    let releaseFailureCallback = (): void => undefined;
    const failureCallbackCanFinish = new Promise<void>((resolve) => {
      releaseFailureCallback = resolve;
    });
    const inferenceCalls: string[] = [];
    const observed = runBlindInference({
      content,
      concurrency: 2,
      infer: async (sample) => {
        inferenceCalls.push(sample.safeId);
        if (inferenceCalls.length === 2) {
          notifyBothStarted();
        }
        if (sample.safeId === "sample-a") {
          throw new Error("synthetic-inference-failure");
        }
        if (sample.safeId === "sample-b") {
          await secondCanFinish;
        }
        return sample.safeId;
      },
      onInferenceError: async () => {
        notifyFailureCallback();
        await failureCallbackCanFinish;
      }
    });

    await bothStarted;
    await failureCallbackStarted;
    releaseSecond();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(inferenceCalls).toEqual(["sample-a", "sample-b"]);
    releaseFailureCallback();
    await expect(observed).rejects.toThrow();
    expect(inferenceCalls).toEqual(["sample-a", "sample-b"]);
  });

  it("另一 worker 等待异步 active 登记时关闸，登记返回后也不得开始推理", async () => {
    const content = buildBlindContentDataset({
      datasetId: "development-before-inference-gate",
      purpose: "development",
      samples: [
        { safeId: "sample-a", problem: problem("a") },
        { safeId: "sample-b", problem: problem("b") },
        { safeId: "sample-c", problem: problem("c") }
      ]
    });
    let notifySecondRegistering = (): void => undefined;
    const secondRegistering = new Promise<void>((resolve) => {
      notifySecondRegistering = resolve;
    });
    let releaseSecondRegistration = (): void => undefined;
    const secondRegistrationCanFinish = new Promise<void>((resolve) => {
      releaseSecondRegistration = resolve;
    });
    let notifyFailurePersisted = (): void => undefined;
    const failurePersisted = new Promise<void>((resolve) => {
      notifyFailurePersisted = resolve;
    });
    const inferenceCalls: string[] = [];
    const rejection = expect(runBlindInference({
      content,
      concurrency: 2,
      beforeInference: async (sample) => {
        if (sample.safeId === "sample-b") {
          notifySecondRegistering();
          await secondRegistrationCanFinish;
        }
      },
      infer: async (sample) => {
        inferenceCalls.push(sample.safeId);
        if (sample.safeId === "sample-a") {
          await secondRegistering;
          throw new Error("synthetic-inference-failure");
        }
        return sample.safeId;
      },
      onInferenceError: () => {
        notifyFailurePersisted();
      }
    })).rejects.toThrow();

    await secondRegistering;
    await failurePersisted;
    releaseSecondRegistration();
    await rejection;
    expect(inferenceCalls).toEqual(["sample-a"]);
  });

  it("infer Promise 已拒绝后不会从下一批补位启动新推理", async () => {
    const content = buildBlindContentDataset({
      datasetId: "development-rejection-gap",
      purpose: "development",
      samples: ["a", "b", "c", "d"].map((id) => ({
        safeId: `sample-${id}`,
        problem: problem(id)
      }))
    });
    let triggerFirstFailure = (): void => undefined;
    const firstFailureGate = new Promise<void>((resolve) => {
      triggerFirstFailure = resolve;
    });
    const events: string[] = [];
    await runBlindInference({
      content,
      concurrency: 2,
      beforeInference: (_sample, index) => {
        events.push(`before-${index}`);
      },
      infer: async (_sample, index) => {
        events.push(`infer-${index}`);
        if (index === 0) {
          await firstFailureGate;
          events.push("throw-0");
          throw new Error("synthetic-inference-failure");
        }
        return index;
      },
      afterInference: (_prediction, index) => {
        events.push(`after-${index}`);
        if (index === 1) {
          triggerFirstFailure();
        }
      },
      onInferenceError: async (_sample, _error, index) => {
        events.push(`error-callback-${index}`);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }).catch(() => undefined);

    const failureIndex = events.indexOf("throw-0");
    expect(failureIndex).toBeGreaterThanOrEqual(0);
    expect(
      events.slice(failureIndex + 1).some((event) => event.startsWith("infer-"))
    ).toBe(false);
  });

  it("全部内容先 strict 预检；后置样本偷带 gold 时前置样本也不会发起推理", async () => {
    const content = buildBlindContentDataset({
      datasetId: "development-a",
      purpose: "development",
      samples: [
        { safeId: "sample-a", problem: problem("a") },
        { safeId: "sample-b", problem: problem("b") }
      ]
    });
    const infer = vi.fn(async () => 1);
    await expect(runBlindInference({
      content: {
        ...content,
        samples: [
          content.samples[0]!,
          { ...content.samples[1]!, expectedVerdict: "reject" }
        ] as typeof content.samples
      },
      concurrency: 2,
      infer
    })).rejects.toMatchObject({ code: "BLIND_CONTENT_CONTAINER_INVALID" });
    expect(infer).not.toHaveBeenCalled();
  });

  it("完整容器任一身份字段被偷换时，所有推理生命周期回调都不会运行", async () => {
    const content = buildBlindContentDataset({
      datasetId: "development-a",
      purpose: "development",
      samples: [
        { safeId: "sample-a", problem: problem("a") },
        { safeId: "sample-b", problem: problem("b") }
      ]
    });
    const tamperedContainers = [
      { ...content, datasetId: "development-b" },
      { ...content, purpose: "holdout" as const },
      {
        ...content,
        samples: [content.samples[0]!, {
          ...content.samples[1]!,
          problem: { ...content.samples[1]!.problem, title: "swapped" }
        }]
      },
      { ...content, contentFingerprint: "f".repeat(64) }
    ];

    for (const tampered of tamperedContainers) {
      const beforeInference = vi.fn();
      const infer = vi.fn(async () => 1);
      const afterInference = vi.fn();
      const onInferenceError = vi.fn();
      await expect(runBlindInference({
        content: tampered,
        concurrency: 2,
        beforeInference,
        infer,
        afterInference,
        onInferenceError
      })).rejects.toMatchObject({
        code: "BLIND_CONTENT_CONTAINER_IDENTITY_MISMATCH"
      });
      expect(beforeInference).not.toHaveBeenCalled();
      expect(infer).not.toHaveBeenCalled();
      expect(afterInference).not.toHaveBeenCalled();
      expect(onInferenceError).not.toHaveBeenCalled();
    }
  });

  it("pending 必须生成显式派生容器，不能 spread 父容器后替换 samples", async () => {
    const parent = buildBlindContentDataset({
      datasetId: "development-parent",
      purpose: "development",
      samples: [
        { safeId: "sample-a", problem: problem("a") },
        { safeId: "sample-b", problem: problem("b") }
      ]
    });
    const subset = deriveBlindContentSubset(parent, ["sample-b"]);
    expect(subset.datasetId).not.toBe(parent.datasetId);
    expect(subset.contentFingerprint).not.toBe(parent.contentFingerprint);
    expect(subset.samples.map((sample) => sample.safeId)).toEqual(["sample-b"]);
    await expect(runBlindInference({
      content: { ...parent, samples: [parent.samples[1]!] },
      concurrency: 1,
      infer: async () => 1
    })).rejects.toMatchObject({
      code: "BLIND_CONTENT_CONTAINER_IDENTITY_MISMATCH"
    });
    await expect(runBlindInference({
      content: subset,
      concurrency: 1,
      infer: async (sample) => sample.safeId
    })).resolves.toEqual([{
      safeId: "sample-b",
      contentHash: problem("b").contentHash,
      prediction: "sample-b"
    }]);
  });

  it("内容和 gold 的数据集身份、指纹、样本集合或 contentHash 不一致就拒绝评分", () => {
    const content = buildBlindContentDataset({
      datasetId: "holdout-a",
      purpose: "holdout",
      samples: [{ safeId: "sample-a", problem: problem("a") }]
    });
    const gold = buildBlindGoldDataset({
      content,
      goldSchema,
      samples: [{
        safeId: "sample-a",
        contentHash: problem("a").contentHash,
        gold: {
          officialRating: 1800,
          humanThinkingLevel: 3,
          humanCodingLevel: 3,
          expectedVerdict: "revise"
        }
      }]
    });
    expect(() => buildBlindGoldDataset({
      content,
      goldSchema,
      samples: [{
        safeId: "sample-a",
        contentHash: "f".repeat(64),
        gold: {
          officialRating: 1800,
          humanThinkingLevel: 3,
          humanCodingLevel: 3,
          expectedVerdict: "revise"
        }
      }]
    })).toThrowError(
      expect.objectContaining<Partial<BlindEvaluationError>>({
        code: "BLIND_EVALUATION_SAMPLE_SET_MISMATCH"
      })
    );
    expect(() => joinBlindPredictionsWithGold({
      content,
      gold: { ...gold, contentFingerprint: "f".repeat(64) },
      predictions: [{
        safeId: "sample-a",
        contentHash: problem("a").contentHash,
        prediction: 1800
      }]
    })).toThrowError(
      expect.objectContaining<Partial<BlindEvaluationError>>({
        code: "BLIND_CONTENT_GOLD_IDENTITY_MISMATCH"
      })
    );
  });

  it("锚点、开发集和 holdout 身份与样本必须隔离", () => {
    expect(() => assertBlindDatasetSeparation({
      development: {
        datasetId: "public83",
        purpose: "development",
        sampleKeys: ["public-a"]
      },
      holdout: {
        datasetId: "holdout-v1",
        purpose: "holdout",
        sampleKeys: ["blind-a"]
      },
      anchorKeys: ["anchor-a"]
    })).not.toThrow();

    expect(() => assertBlindDatasetSeparation({
      development: {
        datasetId: "public83",
        purpose: "development",
        sampleKeys: ["same"]
      },
      holdout: {
        datasetId: "holdout-v1",
        purpose: "holdout",
        sampleKeys: ["blind-a"]
      },
      anchorKeys: ["same"]
    })).toThrowError(
      expect.objectContaining<Partial<BlindEvaluationError>>({
        code: "BLIND_DATASET_SAMPLE_OVERLAP"
      })
    );
    expect(() => assertBlindDatasetSeparation({
      development: {
        datasetId: "public83",
        purpose: "holdout",
        sampleKeys: ["public-a"]
      },
      holdout: {
        datasetId: "holdout-v1",
        purpose: "holdout",
        sampleKeys: ["blind-a"]
      },
      anchorKeys: ["anchor-a"]
    })).toThrowError(
      expect.objectContaining<Partial<BlindEvaluationError>>({
        code: "BLIND_DATASET_ROLE_MISMATCH"
      })
    );
  });
});
