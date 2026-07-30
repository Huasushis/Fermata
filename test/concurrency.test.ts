import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../experiments/lib/concurrency";

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = () => accept();
  });
  return { promise, resolve };
}

describe("有限并发任务", () => {
  it("成功时保留输入顺序", async () => {
    await expect(
      mapWithConcurrency([3, 1, 2], 2, async (value) => value * 2)
    ).resolves.toEqual([6, 2, 4]);
  });

  it("拒绝无效或过大的同时处理任务数", async () => {
    const worker = async (value: number) => value;
    await expect(mapWithConcurrency([1], Number.NaN, worker)).rejects.toThrow(
      "1 到 32"
    );
    await expect(mapWithConcurrency([1], 0, worker)).rejects.toThrow("1 到 32");
    await expect(mapWithConcurrency([1], 33, worker)).rejects.toThrow("1 到 32");
  });

  it("一个任务失败后不再启动新任务，并等待已经开始的任务结束", async () => {
    const secondStarted = deferred();
    const secondCanFinish = deferred();
    const fatalError = new Error("checkpoint write failed");
    const started: number[] = [];

    const mapping = mapWithConcurrency([0, 1, 2, 3], 2, async (value) => {
      started.push(value);
      if (value === 0) {
        await secondStarted.promise;
        throw fatalError;
      }
      if (value === 1) {
        secondStarted.resolve();
        await secondCanFinish.promise;
      }
      return value;
    });
    let settled = false;
    const observed = mapping.then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );

    await secondStarted.promise;
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(settled).toBe(false);

    secondCanFinish.resolve();
    expect(await observed).toBe(fatalError);
    expect(started).toEqual([0, 1]);
  });
});
