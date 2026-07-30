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
  const results = new Array<TOutput>(items.length);
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let cursor = 0;

  async function run(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}
