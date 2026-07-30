/**
 * 固定并发度的映射：把一组输入分给最多 N 个并行 worker 处理，保留原始顺序。
 * 实验脚本用它把逐题串行的 LLM 调用改成有限并发，大幅缩短总时长，同时不至于
 * 一次性把所有请求打给网关。
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
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let cursor = 0;
  let stopped = false;
  let firstError: unknown;

  async function run(): Promise<void> {
    while (!stopped) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      try {
        results[index] = await worker(items[index]!, index);
      } catch (error) {
        if (!stopped) {
          stopped = true;
          firstError = error;
        }
        return;
      }
    }
  }

  await Promise.allSettled(Array.from({ length: limit }, () => run()));
  if (stopped) {
    throw firstError;
  }
  return results;
}
