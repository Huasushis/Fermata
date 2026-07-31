import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runnerPath = fileURLToPath(
  new URL("../scripts/run-with-env.mjs", import.meta.url)
);

describe("run-with-env：启动前的密钥保护", () => {
  for (const debugVariable of ["NODE_DEBUG", "NODE_DEBUG_NATIVE"] as const) {
    it(`设置 ${debugVariable} 时在读取 env 文件前拒绝启动`, () => {
      const marker = "test-secret-must-not-appear";
      const result = spawnSync(
        process.execPath,
        [
          runnerPath,
          "/definitely/missing/fermata.env",
          process.execPath,
          "-e",
          "process.exit(0)"
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            [debugVariable]: "child_process",
            FERMATA_TEST_SECRET: marker
          }
        }
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("启动前必须清除");
      expect(result.stderr).not.toContain("无法读取指定的 env 文件");
      expect(`${result.stdout}${result.stderr}`).not.toContain(marker);
    });

    it(`env 文件包含 ${debugVariable} 时不把它传给子进程`, () => {
      const marker = "env-file-secret-must-not-appear";
      const temporaryDirectory = mkdtempSync(
        join(tmpdir(), "fermata-run-with-env-")
      );
      const envPath = join(temporaryDirectory, "fermata.env");
      writeFileSync(
        envPath,
        `${debugVariable}=child_process\nFERMATA_TEST_SECRET=${marker}\n`,
        "utf8"
      );
      const parentEnvironment = { ...process.env };
      delete parentEnvironment.NODE_DEBUG;
      delete parentEnvironment.NODE_DEBUG_NATIVE;

      try {
        const result = spawnSync(
          process.execPath,
          [runnerPath, envPath, process.execPath, "-e", "process.exit(0)"],
          {
            encoding: "utf8",
            env: parentEnvironment
          }
        );

        expect(result.status).toBe(2);
        expect(result.stderr).toContain("env 文件不能设置");
        expect(`${result.stdout}${result.stderr}`).not.toContain(marker);
      } finally {
        unlinkSync(envPath);
        rmdirSync(temporaryDirectory);
      }
    });
  }
});
