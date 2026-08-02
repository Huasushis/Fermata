/**
 * 固定并发度的分批映射：每批最多 N 个 worker，整批全部成功收束后才启动下一批，
 * 并保留原始顺序。不能用“某个成功 worker 立刻补位”的动态队列；Promise 已经拒绝
 * 到失败 handler 真正关闸之间存在微任务窗口，补位会在首个失败后误发新的付费请求。
 */
export async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  concurrency: number,
  worker: (item: TInput, index: number) => Promise<TOutput>
): Promise<TOutput[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new RangeError("同时处理任务数必须是 1 到 32 之间的整数。");
  }
  const results = new Array<TOutput>(items.length);
  for (let offset = 0; offset < items.length; offset += concurrency) {
    const batch = items.slice(offset, offset + concurrency);
    const settled = await Promise.allSettled(
      batch.map((item, batchIndex) => worker(item, offset + batchIndex))
    );
    const failed = settled.find(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected"
    );
    if (failed !== undefined) {
      throw failed.reason;
    }
    for (const [batchIndex, entry] of settled.entries()) {
      results[offset + batchIndex] = (entry as PromiseFulfilledResult<TOutput>).value;
    }
  }
  return results;
}
