import { describe, expect, it } from "vitest";
import {
  assertSafeNodeEnvironment,
  mergeEnvFile,
  parseEnvFile,
  selectEnvironment
} from "../scripts/env-file.mjs";
import {
  buildReviewFlowEvaluationRunEnvironment,
  buildDevelopmentSmokeRunEnvironment,
  buildDifficultyEvaluationRunEnvironment,
  assertDevelopmentSmokeArguments,
  buildRunEnvironment,
  createRunWithEnvSignalController,
  formatRunWithEnvFailure,
  developmentSmokeEntrypointPath,
  developmentSmokeTsxPath,
  reviewFlowEvaluationBootstrapPath,
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
    ["LD_PRELOAD", "/tmp/inject.so"],
    ["LD_LIBRARY_PATH", "/tmp/untrusted-libraries"],
    ["LD_AUDIT", "/tmp/audit.so"],
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
        UNRELATED_PARENT: "/tmp/not-selected",
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
      AETHER_API_KEY: "file-value",
      FERMATA_RUN_WITH_ENV: "1"
    });
    expect(environment.UNRELATED_PARENT).toBeUndefined();
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

  it("专用公开 difficulty-smoke env 文件可携带私有 manifest 路径并选中 4 个样本", () => {
    const environment = buildDifficultyEvaluationRunEnvironment(
      "AETHER_BASE_URL=https://model.example/v1\n" +
        "AETHER_API_KEY=private-value\n" +
        `EVAL_CODE_VERSION=${"a".repeat(40)}\n` +
        "EVAL_CONCURRENCY=4\n" +
        "EVAL_DATASET_MANIFEST_PATH=/project/private/manifest.json\n" +
        "EVAL_REQUIRE_DATASET_MANIFEST=1\n" +
        "EVAL_SAMPLE_LIMIT=4\n" +
        "EVAL_SAMPLE_IDS=1862A,1989E,2065A,2068A\n" +
        "EVAL_ATTEMPT_CEILING=8\n",
      { PATH: "/safe/bin" }
    );
    expect(environment).toMatchObject({
      PATH: "/safe/bin",
      AETHER_BASE_URL: "https://model.example/v1",
      AETHER_API_KEY: "private-value",
      EVAL_CODE_VERSION: "a".repeat(40),
      EVAL_CONCURRENCY: "4",
      EVAL_DATASET_MANIFEST_PATH: "/project/private/manifest.json",
      EVAL_REQUIRE_DATASET_MANIFEST: "1",
      EVAL_SAMPLE_LIMIT: "4",
      EVAL_SAMPLE_IDS: "1862A,1989E,2065A,2068A",
      EVAL_ATTEMPT_CEILING: "8",
      FERMATA_RUN_WITH_ENV: "1"
    });
    expect(environment.PATH).toBe("/safe/bin");
  });

  it("专用公开 difficulty-smoke env 文件拒绝未登记键，manifest 键仍不可伪造父环境", () => {
    expect(() =>
      buildDifficultyEvaluationRunEnvironment(
        "EVAL_CONCURENCY=4\n" +
          `EVAL_CODE_VERSION=${"a".repeat(40)}\n` +
          "EVAL_SAMPLE_LIMIT=4\n" +
          "EVAL_SAMPLE_IDS=1862A,1989E,2065A,2068A\n" +
          "EVAL_ATTEMPT_CEILING=8\n",
        { PATH: "/bin" }
      )
    ).toThrow("DIFFICULTY_EVALUATION_ENV_FILE_INCOMPLETE");
    expect(() =>
      buildDifficultyEvaluationRunEnvironment(
        "AETHER_API_KEY=x\nAETHER_BASE_URL=http://y\n" +
          `EVAL_CODE_VERSION=${"a".repeat(40)}\n` +
          "EVAL_CONCURRENCY=4\n" +
          "EVAL_SAMPLE_LIMIT=4\n" +
          "EVAL_SAMPLE_IDS=1862A,1989E,2065A,2068A\n" +
          "EVAL_ATTEMPT_CEILING=8\n" +
          "EVAL_MANIFEST_PATH=/tmp/unknown\n",
        { PATH: "/bin" }
      )
    ).toThrow("UNKNOWN_PROTECTED_ENVIRONMENT_KEY");
  });

  it("reviewFlow 安全启动标记不能由父环境或 env 文件伪造", () => {
    expect(() =>
      buildRunEnvironment("", {
        PATH: "/bin",
        FERMATA_RUN_WITH_ENV: "1"
      })
    ).toThrow("UNKNOWN_PROTECTED_ENVIRONMENT_KEY");
    expect(() =>
      buildRunEnvironment("FERMATA_RUN_WITH_ENV=1\n", { PATH: "/bin" })
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

  it("外层信号在 spawn 前关闭闸门时不读取 env 也不启动 child", () => {
    const signalController = createRunWithEnvSignalController();
    signalController.request("SIGTERM");
    let readCalled = false;
    let spawnCalled = false;
    expect(runWithEnv(
      ["/project/private/test.env", "command"],
      {
        signalController,
        readEnvFile: () => {
          readCalled = true;
          return "";
        },
        spawnProcess: () => {
          spawnCalled = true;
          return { once() {} };
        }
      }
    )).toBeUndefined();
    expect(readCalled).toBe(false);
    expect(spawnCalled).toBe(false);
  });

  it("外层多次信号只向直接 child 转发第一次并继续由调用方等待", () => {
    const signalController = createRunWithEnvSignalController();
    const signals = [];
    signalController.attach({ kill: (signal) => signals.push(signal) });
    signalController.request("SIGINT");
    signalController.request("SIGTERM");
    signalController.request("SIGHUP");
    expect(signals).toEqual(["SIGINT"]);
  });

  it("专用 review-flow 模式只透传模型、评估版本/并发、代理和基本环境", () => {
    const environment = buildReviewFlowEvaluationRunEnvironment(
      "AETHER_BASE_URL=https://model.example/v1\n" +
        "AETHER_API_KEY=private-value\n" +
        "EVAL_CODE_VERSION=1234567890abcdef1234567890abcdef12345678\n" +
        "EVAL_CONCURRENCY=2\n",
      {
        PATH: "/safe/bin",
        HTTP_PROXY: "http://127.0.0.1:10808",
        RANDOM_PARENT_VALUE: "must-not-pass"
      }
    );
    expect(environment).toMatchObject({
      PATH: "/safe/bin",
      HTTP_PROXY: "http://127.0.0.1:10808",
      AETHER_BASE_URL: "https://model.example/v1",
      AETHER_API_KEY: "private-value",
      EVAL_CODE_VERSION: "1234567890abcdef1234567890abcdef12345678",
      EVAL_CONCURRENCY: "2",
      FERMATA_RUN_WITH_ENV: "1"
    });
    expect(environment.RANDOM_PARENT_VALUE).toBeUndefined();
    expect(environment.URMOTIV_ROBOT_TOKEN).toBeUndefined();
    expect(environment.CODEFORCES_SECRET).toBeUndefined();
  });

  it("专用文件必须自行登记版本、并发和至少一组完整 provider，父环境不能补缺", () => {
    const parent = {
      PATH: "/safe/bin",
      AETHER_BASE_URL: "https://parent.example/v1",
      AETHER_API_KEY: "parent-key",
      EVAL_CODE_VERSION: "2".repeat(40),
      EVAL_CONCURRENCY: "31"
    };
    expect(() => buildReviewFlowEvaluationRunEnvironment(
      "AETHER_BASE_URL=https://file.example/v1\n" +
        "AETHER_API_KEY=file-key\n" +
        "EVAL_CONCURRENCY=2\n",
      parent
    )).toThrow("REVIEW_FLOW_EVALUATION_ENV_FILE_INCOMPLETE");
    expect(() => buildReviewFlowEvaluationRunEnvironment(
      `EVAL_CODE_VERSION=${"1".repeat(40)}\nEVAL_CONCURRENCY=2\n`,
      parent
    )).toThrow("REVIEW_FLOW_EVALUATION_ENV_FILE_INCOMPLETE");
    expect(() => buildReviewFlowEvaluationRunEnvironment(
      "AETHER_BASE_URL=https://file.example/v1\n" +
        `EVAL_CODE_VERSION=${"1".repeat(40)}\n` +
        "EVAL_CONCURRENCY=2\n",
      parent
    )).toThrow("REVIEW_FLOW_EVALUATION_ENV_FILE_INCOMPLETE");
  });

  it("review-flow 并发上限与内部 CLI 一致：接受 1..4，拒绝 5 和 32", () => {
    const parent = {
      PATH: "/safe/bin",
      AETHER_BASE_URL: "https://parent.example/v1",
      AETHER_API_KEY: "parent-key",
      EVAL_CODE_VERSION: "2".repeat(40),
      EVAL_CONCURRENCY: "2"
    };
    const baseFile =
      "AETHER_BASE_URL=https://file.example/v1\n" +
      "AETHER_API_KEY=file-key\n" +
      `EVAL_CODE_VERSION=${"1".repeat(40)}\n`;
    // 1..4 all accepted
    for (const c of ["1", "2", "3", "4"]) {
      const env = buildReviewFlowEvaluationRunEnvironment(
        baseFile + `EVAL_CONCURRENCY=${c}\n`,
        parent
      );
      expect(env.EVAL_CONCURRENCY).toBe(c);
    }
    // 5 rejected
    expect(() => buildReviewFlowEvaluationRunEnvironment(
      baseFile + "EVAL_CONCURRENCY=5\n",
      parent
    )).toThrow("REVIEW_FLOW_EVALUATION_ENV_FILE_INCOMPLETE");
    // 32 rejected
    expect(() => buildReviewFlowEvaluationRunEnvironment(
      baseFile + "EVAL_CONCURRENCY=32\n",
      parent
    )).toThrow("REVIEW_FLOW_EVALUATION_ENV_FILE_INCOMPLETE");
  });

  it("专用文件完整时丢弃父环境中的同名 provider 与评估参数", () => {
    const environment = buildReviewFlowEvaluationRunEnvironment(
      "AETHER_BASE_URL=https://file.example/v1\n" +
        "AETHER_API_KEY=file-key\n" +
        `EVAL_CODE_VERSION=${"1".repeat(40)}\n` +
        "EVAL_CONCURRENCY=2\n",
      {
        PATH: "/safe/bin",
        AETHER_BASE_URL: "https://parent.example/v1",
        AETHER_API_KEY: "parent-key",
        EVAL_CODE_VERSION: "2".repeat(40),
        EVAL_CONCURRENCY: "31"
      }
    );
    expect(environment).toMatchObject({
      AETHER_BASE_URL: "https://file.example/v1",
      AETHER_API_KEY: "file-key",
      EVAL_CODE_VERSION: "1".repeat(40),
      EVAL_CONCURRENCY: "2"
    });
  });

  it.each([
    "URMOTIV_ROBOT_TOKEN=robot-token\n",
    "FERMATA_MANAGEMENT_TOKEN=management-token\n",
    "CODEFORCES_KEY=key\n",
    "CODEFORCES_SECRET=secret\n",
    "EVAL_DATASET_MANIFEST_PATH=/private/manifest.json\n",
    "FERMATA_REVIEW_FLOW_RUNTIME_ATTESTATION={}\n",
    "PATH=/must/not/override\n"
  ])("专用 review-flow env 文件拒绝无关键 %#", (content) => {
    expect(() =>
      buildReviewFlowEvaluationRunEnvironment(content, { PATH: "/safe/bin" })
    ).toThrow("UNKNOWN_PROTECTED_ENVIRONMENT_KEY");
  });

  it("专用 review-flow 模式也拒绝父环境中的项目凭据", () => {
    expect(() =>
      buildReviewFlowEvaluationRunEnvironment("", {
        PATH: "/safe/bin",
        URMOTIV_ROBOT_TOKEN: "must-not-enter-child"
      })
    ).toThrow("UNKNOWN_PROTECTED_ENVIRONMENT_KEY");
    expect(() =>
      buildReviewFlowEvaluationRunEnvironment("", {
        PATH: "/safe/bin",
        FERMATA_REVIEW_FLOW_RUNTIME_ATTESTATION: "{}"
      })
    ).toThrow("UNKNOWN_PROTECTED_ENVIRONMENT_KEY");
  });

  it("显式模式参数选择 review-flow 专用环境", () => {
    let receivedEnvironment;
    let receivedCommand;
    let receivedArguments;
    const child = { once() {} };
    expect(
      runWithEnv(
        [
          "--review-flow-evaluation",
          "/project/private/test.env",
          "command",
          "argument"
        ],
        {
          parentEnvironment: { PATH: "/safe/bin" },
          readEnvFile: () =>
            "AETHER_BASE_URL=https://model.example/v1\n" +
            "AETHER_API_KEY=private-value\n" +
            `EVAL_CODE_VERSION=${"1".repeat(40)}\n` +
            "EVAL_CONCURRENCY=2\n",
          spawnProcess: (command, arguments_, options) => {
            receivedCommand = command;
            receivedArguments = arguments_;
            receivedEnvironment = options.env;
            return child;
          }
        }
      )
    ).toBe(child);
    expect(receivedEnvironment).toMatchObject({
      AETHER_BASE_URL: "https://model.example/v1",
      AETHER_API_KEY: "private-value",
      FERMATA_RUN_WITH_ENV: "1"
    });
    expect(receivedEnvironment.URMOTIV_ROBOT_TOKEN).toBeUndefined();
    expect(receivedCommand).toBe(process.execPath);
    expect(receivedArguments).toEqual([
      reviewFlowEvaluationBootstrapPath,
      "command",
      "argument"
    ]);
  });

  it("development-smoke 模式只透传 Aether、代理和基本环境", () => {
    const environment = buildDevelopmentSmokeRunEnvironment(
      "AETHER_BASE_URL=https://model.example/v1\n" +
        "AETHER_API_KEY=private-value\n",
      {
        PATH: "/safe/bin",
        HTTP_PROXY: "http://127.0.0.1:10808",
        RANDOM_PARENT_VALUE: "must-not-pass"
      }
    );
    expect(environment).toMatchObject({
      PATH: "/safe/bin",
      HTTP_PROXY: "http://127.0.0.1:10808",
      AETHER_BASE_URL: "https://model.example/v1",
      AETHER_API_KEY: "private-value",
      FERMATA_RUN_WITH_ENV: "1"
    });
    expect(environment.RANDOM_PARENT_VALUE).toBeUndefined();
    expect(environment.URMOTIV_ROBOT_TOKEN).toBeUndefined();
    expect(environment.CODEFORCES_SECRET).toBeUndefined();
    expect(environment.EVAL_CODE_VERSION).toBeUndefined();
  });

  it("development-smoke 文件缺项或多出项目变量时固定拒绝", () => {
    expect(() => buildDevelopmentSmokeRunEnvironment(
      "AETHER_BASE_URL=https://model.example/v1\n",
      { PATH: "/safe/bin", AETHER_API_KEY: "parent-must-not-fill" }
    )).toThrow("DEVELOPMENT_SMOKE_ENV_FILE_INCOMPLETE");
    for (const content of [
      "AETHER_BASE_URL=https://model.example/v1\n" +
        "AETHER_API_KEY=value\nURMOTIV_ROBOT_TOKEN=never\n",
      "AETHER_BASE_URL=https://model.example/v1\n" +
        "AETHER_API_KEY=value\nEVAL_CONCURRENCY=2\n",
      "AETHER_BASE_URL=https://model.example/v1\n" +
        "AETHER_API_KEY=value\nFERMATA_RUN_WITH_ENV=1\n"
    ]) {
      expect(() => buildDevelopmentSmokeRunEnvironment(
        content,
        { PATH: "/safe/bin" }
      )).toThrow("UNKNOWN_PROTECTED_ENVIRONMENT_KEY");
    }
  });

  it("development-smoke 显式模式只启动仓库内固定 CLI", () => {
    let receivedEnvironment;
    let receivedCommand;
    let receivedArguments;
    const child = { once() {} };
    expect(runWithEnv(
      [
        "--development-smoke",
        "/project/private/smoke.env",
        "--preflight"
      ],
      {
        parentEnvironment: { PATH: "/safe/bin" },
        readEnvFile: () =>
          "AETHER_BASE_URL=https://model.example/v1\n" +
          "AETHER_API_KEY=private-value\n",
        spawnProcess: (command, arguments_, options) => {
          receivedCommand = command;
          receivedArguments = arguments_;
          receivedEnvironment = options.env;
          return child;
        }
      }
    )).toBe(child);
    expect(receivedEnvironment).toMatchObject({
      AETHER_BASE_URL: "https://model.example/v1",
      AETHER_API_KEY: "private-value",
      FERMATA_RUN_WITH_ENV: "1"
    });
    expect(receivedCommand).toBe(process.execPath);
    expect(receivedArguments).toEqual([
      developmentSmokeTsxPath,
      developmentSmokeEntrypointPath,
      "--preflight"
    ]);
  });

  it("development-smoke 包装器固定 Phase 1 恢复与显式 release 组合", () => {
    const runId = "a".repeat(64);
    expect(() => assertDevelopmentSmokeArguments([
      "--preflight-phase1",
      `--resume=${runId}`
    ])).not.toThrow();
    expect(() => assertDevelopmentSmokeArguments([
      "--network-phase1",
      `--resume=${runId}`,
      "--release-phase1"
    ])).not.toThrow();
    for (const args of [
      ["--network-phase1"],
      ["--network-phase1", `--resume=${runId}`],
      ["--network-phase1", "--release-phase1"],
      ["--preflight-phase1"],
      ["--preflight-phase1", `--resume=${runId}`, "--release-phase1"],
      ["--network-phase0", "--release-phase1"]
    ]) {
      expect(() => assertDevelopmentSmokeArguments(args)).toThrow(
        "RUN_WITH_ENV_INVALID_ARGUMENTS"
      );
    }
  });

  it("专用模式即使父 PATH 可疑，也不会经 PATH 解析 npm、tsx 或调用者命令", () => {
    let receivedCommand;
    let receivedArguments;
    runWithEnv(
      [
        "--review-flow-evaluation",
        "/project/private/test.env",
        "--action=run"
      ],
      {
        parentEnvironment: { PATH: "/attacker/first:/safe/bin" },
        readEnvFile: () =>
          "AETHER_BASE_URL=https://model.example/v1\n" +
          "AETHER_API_KEY=private-value\n" +
          `EVAL_CODE_VERSION=${"1".repeat(40)}\n` +
          "EVAL_CONCURRENCY=2\n",
        spawnProcess: (command, arguments_) => {
          receivedCommand = command;
          receivedArguments = arguments_;
          return { once() {} };
        }
      }
    );
    expect(receivedCommand).toBe(process.execPath);
    expect(receivedArguments).toEqual([
      reviewFlowEvaluationBootstrapPath,
      "--action=run"
    ]);
  });
});
