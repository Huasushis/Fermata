import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runnerPath = fileURLToPath(
  new URL("../scripts/run-with-env.mjs", import.meta.url)
);

describe("run-with-env：命令行边界", () => {
  it("缺少参数时只输出固定用法，不读取文件或启动命令", () => {
    const result = spawnSync(process.execPath, [runnerPath], {
      encoding: "utf8"
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "用法：node scripts/run-with-env.mjs <env文件> <命令> [参数...]\n" +
      "      node scripts/run-with-env.mjs --review-flow-evaluation <env文件> [评测参数...]\n" +
      "      node scripts/run-with-env.mjs --development-smoke <env文件> [--preflight|--network-phase0 [--resume=<runId>]]\n"
    );
  });

  for (const [key, value] of [
    ["LD_PRELOAD", "/lib/x86_64-linux-gnu/libc.so.6"],
    ["LD_LIBRARY_PATH", "/tmp/untrusted-libraries"],
    ["NODE_DEBUG", "child_process"],
    ["NODE_DEBUG_NATIVE", "http"],
    ["NODE_TLS_REJECT_UNAUTHORIZED", "0"]
  ] as const) {
    it(`危险父变量 ${key} 在读取 env 文件前固定拒绝`, () => {
      const marker = "parent-secret-must-not-appear";
      const missingPath = "/definitely/missing/private/fermata.env";
      const result = spawnSync(
        process.execPath,
        [runnerPath, missingPath, process.execPath, "--version"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            [key]: value,
            FERMATA_TEST_SECRET: marker
          }
        }
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("无法安全启动指定命令。\n");
      expect(result.stderr).not.toContain(marker);
      expect(result.stderr).not.toContain(missingPath);
    });
  }
});
