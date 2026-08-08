import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,mjs}"],
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 30_000
  }
});
