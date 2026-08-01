import { describe, expect, it } from "vitest";
import {
  assertSafeNodeEnvironment,
  mergeEnvFile,
  parseEnvFile,
  selectEnvironment
} from "../scripts/env-file.mjs";
import {
  buildRunEnvironment,
  formatRunWithEnvFailure,
  runWithEnv,
  spawnRunCommand
} from "../scripts/run-with-env.mjs";

describe("env 文件安全解析", () => {
  it("env 文件明确覆盖父环境中的同名实验变量", () => {
    expect(
      mergeEnvFile("EVAL_CONCURRENCY=2\n", {
        EVAL_CONCURRENCY: "31",
        PATH: "/safe/bin"
      })
    ).toEqual({ EVAL_CONCURRENCY: "2", PATH: "/safe/bin" });
  });

  it("拒绝任何 NUL 字节且错误不回显该行", () => {
    const marker = "nul-secret-must-not-appear";
    expect(() => parseEnvFile(`AETHER_API_KEY=${marker}\0tail\n`)).toThrow(
      "ENV_FILE_CONTAINS_NUL"
    );
    try {
      parseEnvFile(`AETHER_API_KEY=${marker}\0tail\n`);
    } catch (error) {
      expect(String(error)).not.toContain(marker);
    }
  });

  it("格式错误、引号不配对和重复键全部失败关闭", () => {
    expect(() => parseEnvFile("EVAL_CONCURRENCY\n")).toThrow(
      "ENV_FILE_MALFORMED_LINE"
    );
    expect(() => parseEnvFile('EVAL_CONCURRENCY="2\n')).toThrow(
      "ENV_FILE_UNBALANCED_QUOTE"
    );
    expect(() =>
      parseEnvFile("EVAL_CONCURRENCY=2\nEVAL_CONCURRENCY=3\n")
    ).toThrow("ENV_FILE_DUPLICATE_KEY");
  });

  it.each([
    ["NODE_OPTIONS", "--import=/tmp/inject.mjs"],
    ["NODE_DEBUG", "child_process"],
    ["NODE_EXTRA_CA_CERTS", "/tmp/untrusted.pem"],
    ["OPENSSL_CONF", "/tmp/inject.cnf"]
  ])("拒绝危险 Node 注入变量 %s", (key, value) => {
    expect(() => assertSafeNodeEnvironment({ [key]: value })).toThrow(
      "DANGEROUS_NODE_ENVIRONMENT"
    );
  });

  it("拒绝关闭 TLS 证书校验，但允许值 1", () => {
    expect(() =>
      assertSafeNodeEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: " 0 " })
    ).toThrow("TLS_VERIFICATION_DISABLED");
    expect(() =>
      assertSafeNodeEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: "1" })
    ).not.toThrow();
  });

  it("只选择白名单变量并在选中值含 NUL 时固定失败", () => {
    expect(
      selectEnvironment(
        { PATH: "/safe/bin", LD_PRELOAD: "/tmp/inject.so" },
        ["PATH"]
      )
    ).toEqual({ PATH: "/safe/bin" });
    expect(() => selectEnvironment({ PATH: "bad\0path" }, ["PATH"])).toThrow(
      "PARENT_ENVIRONMENT_CONTAINS_NUL"
    );
  });
});

describe("run-with-env 的受控环境与同步启动异常", () => {
  it("保留代理与已知实验变量，文件覆盖父值并丢弃任意父变量", () => {
    const environment = buildRunEnvironment(
      "EVAL_CONCURRENCY=2\n" +
        "EVAL_CODE_VERSION=1234567890abcdef1234567890abcdef12345678\n" +
        "EVAL_DATASET_MANIFEST_PATH=/project/private/manifest.json\n" +
        "EVAL_REQUIRE_DATASET_MANIFEST=1\n" +
        "AETHER_API_KEY=file-value\n",
      {
        PATH: "/safe/bin",
        http_proxy: "http://127.0.0.1:10808",
        EVAL_CONCURRENCY: "30",
        LD_PRELOAD: "/tmp/inject.so",
        UNKNOWN_PARENT: "drop"
      }
    );
    expect(environment).toMatchObject({
      PATH: "/safe/bin",
      http_proxy: "http://127.0.0.1:10808",
      EVAL_CONCURRENCY: "2",
      EVAL_CODE_VERSION: "1234567890abcdef1234567890abcdef12345678",
      EVAL_DATASET_MANIFEST_PATH: "/project/private/manifest.json",
      EVAL_REQUIRE_DATASET_MANIFEST: "1",
      AETHER_API_KEY: "file-value"
    });
    expect(environment.LD_PRELOAD).toBeUndefined();
    expect(environment.UNKNOWN_PARENT).toBeUndefined();
  });

  it("env 文件不能设置 PATH 或任意未登记键", () => {
    expect(() =>
      buildRunEnvironment("PATH=/must/not/override\n", { PATH: "/safe/bin" })
    ).toThrow("UNKNOWN_PROTECTED_ENVIRONMENT_KEY");
    expect(() =>
      buildRunEnvironment("AETHEER_API_KEY=typo\n", { PATH: "/safe/bin" })
    ).toThrow("UNKNOWN_PROTECTED_ENVIRONMENT_KEY");
  });

  it("未知 EVAL/LEVELS 键不能静默退回父环境默认值", () => {
    expect(() =>
      buildRunEnvironment("EVAL_CONCURENCY=2\n", { PATH: "/bin" })
    ).toThrow("UNKNOWN_PROTECTED_ENVIRONMENT_KEY");
    expect(() =>
      buildRunEnvironment("", {
        PATH: "/bin",
        LEVELS_LLM_MAX_DURATON_MS: "14400000"
      })
    ).toThrow("UNKNOWN_PROTECTED_ENVIRONMENT_KEY");
  });

  it("spawn 同步抛出的动态异常被替换成固定码", () => {
    const marker = "spawn-secret-must-not-appear";
    expect(() =>
      spawnRunCommand(["command"], {}, () => {
        throw new Error(marker);
      })
    ).toThrow("CHILD_PROCESS_SPAWN_THROWN");
    try {
      spawnRunCommand(["command"], {}, () => {
        throw new Error(marker);
      });
    } catch (error) {
      expect(String(error)).not.toContain(marker);
      expect(formatRunWithEnvFailure(error)).toBe(
        "无法安全启动指定命令。\n"
      );
      expect(formatRunWithEnvFailure(error)).not.toContain(marker);
    }
  });

  it("危险父环境在读取 env 文件前被拒绝", () => {
    let readCalled = false;
    expect(() =>
      runWithEnv(["/project/private/test.env", "command"], {
        parentEnvironment: { NODE_OPTIONS: "--inspect" },
        readEnvFile: () => {
          readCalled = true;
          return "";
        },
        spawnProcess: () => {
          throw new Error("must not spawn");
        }
      })
    ).toThrow("DANGEROUS_NODE_ENVIRONMENT");
    expect(readCalled).toBe(false);
  });
});
