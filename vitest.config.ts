import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    maxWorkers: 1,
    fileParallelism: false,
    include: ["test/**/*.test.{ts,mjs}"],
    // 这个文件是独立 Node 测试程序，自行顺序运行并设置退出码。
    exclude: ["test/durable-smoke.test.mjs"],
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 30_000
  }
});
