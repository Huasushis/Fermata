import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const runnerPath = fileURLToPath(
  new URL("../scripts/run-with-env.mjs", import.meta.url)
);

interface RunWithEnvOptions {
  readonly parentEnvironment?: Readonly<NodeJS.ProcessEnv>;
  readonly readEnvFile?: (path: string) => string;
  readonly spawnProcess?: (
    command: string,
    arguments_: readonly string[],
    options: { readonly env?: NodeJS.ProcessEnv }
  ) => object;
}

type RunWithEnv = (
  argv: readonly string[],
  options?: RunWithEnvOptions
) => object | undefined;

async function loadRunWithEnv(): Promise<RunWithEnv> {
  // The existing declaration intentionally exposes only signal APIs; this test narrows the
  // known runtime module to exercise its dedicated argument and spawn boundary.
  const imported: unknown = await import("../scripts/run-with-env.mjs");
  if (
    typeof imported !== "object" ||
    imported === null ||
    !("runWithEnv" in imported) ||
    typeof imported.runWithEnv !== "function"
  ) {
    throw new Error("run-with-env runtime API unavailable");
  }
  return imported.runWithEnv as RunWithEnv;
}

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
      "      node scripts/run-with-env.mjs --development-smoke <env文件> [--preflight|--preflight-phase1 --resume=<runId>|--network-phase0 [--resume=<runId>]|--network-phase1 --resume=<runId> --release-phase1]\n" +
      "      node scripts/run-with-env.mjs --development-diagnostic <env文件> --state-dir <绝对目录> [--authorize-plan <fingerprint>]\n"
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

  it("专用诊断模式固定 Node、tsx 与 CLI 绝对路径并只转发严格参数", async () => {
    const secret = "WRAPPER_PRIVATE_SECRET_SENTINEL";
    let spawned:
      | {
          readonly command: string;
          readonly arguments_: readonly string[];
          readonly environment: NodeJS.ProcessEnv | undefined;
        }
      | undefined;
    const runWithEnv = await loadRunWithEnv();
    runWithEnv(
      [
        "--development-diagnostic",
        "/private/diagnostic.env",
        "--state-dir",
        "/safe/state",
        "--authorize-plan",
        "a".repeat(64)
      ],
      {
        parentEnvironment: {},
        readEnvFile: () =>
          `AETHER_BASE_URL=https://example.invalid\nAETHER_API_KEY=${secret}\nFERMATA_DEVELOPMENT_DIAGNOSTIC_MANIFEST=/safe/manifest.json\n`,
        spawnProcess: (command, arguments_, options) => {
          spawned = { command, arguments_, environment: options.env };
          return {};
        }
      }
    );
    expect(spawned).toBeDefined();
    expect(spawned?.command).toBe(process.execPath);
    expect(spawned?.arguments_[0]).toMatch(/\/node_modules\/tsx\/dist\/cli\.mjs$/u);
    expect(spawned?.arguments_[1]).toMatch(
      /\/experiments\/run-development-diagnostic\.ts$/u
    );
    expect(spawned?.arguments_.slice(2)).toEqual([
      "--state-dir",
      "/safe/state",
      "--authorize-plan",
      "a".repeat(64)
    ]);
    expect(spawned?.environment?.AETHER_API_KEY).toBe(secret);
    expect(spawned?.environment?.FERMATA_DEVELOPMENT_DIAGNOSTIC_MANIFEST).toBe(
      "/safe/manifest.json"
    );
  });

  it.each([
    { arguments_: [] },
    { arguments_: ["--unknown", "value"] },
    { arguments_: ["--state-dir", "/safe/a", "--state-dir", "/safe/b"] },
    { arguments_: ["--state-dir", "relative"] },
    { arguments_: ["--state-dir", "/safe/a", "--"] },
    { arguments_: ["--state-dir", "/safe/state;node"] },
    { arguments_: ["--state-dir", "/safe/a", "--authorize-plan", "bad"] },
    { arguments_: ["--state-dir", "/safe/a", "node", "-e", "injected"] }
  ] as const)(
    "专用诊断模式在读取秘密前拒绝参数：$arguments_",
    async ({ arguments_ }) => {
      const runWithEnv = await loadRunWithEnv();
      const readEnvFile = vi.fn(() => "AETHER_API_KEY=secret\n");
      expect(() =>
        runWithEnv(
          ["--development-diagnostic", "/private/diagnostic.env", ...arguments_],
          {
            parentEnvironment: {},
            readEnvFile,
            spawnProcess: () => ({})
          }
        )
      ).toThrow("RUN_WITH_ENV_INVALID_ARGUMENTS");
      expect(readEnvFile).not.toHaveBeenCalled();
    }
  );

  it("通用模式不能替代正式诊断入口", async () => {
    const runWithEnv = await loadRunWithEnv();
    const readEnvFile = vi.fn(() => "AETHER_API_KEY=secret\n");
    const diagnosticEntrypoint = fileURLToPath(
      new URL("../experiments/run-development-diagnostic.ts", import.meta.url)
    );
    expect(() =>
      runWithEnv(
        [
          "/private/diagnostic.env",
          process.execPath,
          diagnosticEntrypoint,
          "--state-dir",
          "/safe/state"
        ],
        { parentEnvironment: {}, readEnvFile, spawnProcess: () => ({}) }
      )
    ).toThrow("RUN_WITH_ENV_INVALID_ARGUMENTS");
    expect(readEnvFile).not.toHaveBeenCalled();
  });
  it("package 正式入口唯一指向受信 bootstrap，不再直达环境包装器", () => {
    const packageDocument: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    );
    if (
      typeof packageDocument !== "object" ||
      packageDocument === null ||
      !("scripts" in packageDocument) ||
      typeof packageDocument.scripts !== "object" ||
      packageDocument.scripts === null
    ) {
      throw new Error("package scripts unavailable");
    }
    const scripts = packageDocument.scripts as Readonly<Record<string, unknown>>;
    expect(scripts["diagnostic:development"]).toBe(
      "node scripts/development-diagnostic-bootstrap.mjs"
    );
    expect(
      Object.values(scripts).filter(
        (value) =>
          typeof value === "string" && value.includes("--development-diagnostic")
      )
    ).toHaveLength(0);
  });
});
