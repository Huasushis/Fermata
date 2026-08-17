import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseEnvFile } from "../scripts/env-file.mjs";
import {
  buildReviewFlowEvaluationEnvFile,
  prepareReviewFlowEvaluationEnv
} from "../scripts/prepare-review-flow-evaluation-env.mjs";
import { readProtectedEnvFile } from "../scripts/private-runtime.mjs";

const commit = "1".repeat(40);
const projectCacheRoot = fileURLToPath(new URL("../../.cache", import.meta.url));
const temporaryRoots = [];

beforeAll(() => {
  mkdirSync(projectCacheRoot, { recursive: true, mode: 0o700 });
  chmodSync(projectCacheRoot, 0o700);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createPrivateFixture(name) {
  const workspace = mkdtempSync(join(projectCacheRoot, `env-prep-${name}-`));
  temporaryRoots.push(workspace);
  chmodSync(workspace, 0o700);
  const privateRoot = join(workspace, "private");
  const temporaryRoot = join(workspace, "cache");
  const targetDirectory = join(privateRoot, "dedicated");
  mkdirSync(privateRoot, { mode: 0o700 });
  mkdirSync(temporaryRoot, { mode: 0o700 });
  const source = join(privateRoot, "source.env");
  const sourceContent =
    "AETHER_BASE_URL=https://example.invalid/v1\n" +
    "AETHER_API_KEY=test-secret\n" +
    "URMOTIV_ROBOT_TOKEN=never-copy\n";
  writeFileSync(source, sourceContent, { mode: 0o600 });
  const readRepositoryHead = vi.fn((expected, options) => {
    expect(options).toEqual({ temporaryRoot });
    if (expected !== undefined && expected !== commit) {
      throw new Error("EVAL_CODE_VERSION_UPDATE_FAILED");
    }
    return commit;
  });
  return {
    workspace,
    privateRoot,
    temporaryRoot,
    targetDirectory,
    source,
    sourceContent,
    target: join(targetDirectory, "review-flow.env"),
    argv: [
      `--source-environment-file=${source}`,
      `--target-directory=${targetDirectory}`
    ],
    options: {
      parentEnvironment: { PATH: "/usr/bin:/bin" },
      privateRoot,
      containingWorkspace: workspace,
      temporaryRoot,
      readRepositoryHead
    }
  };
}

describe("review-flow 专用环境准备", () => {
  it("只复制成对 provider，并加入当前提交和受限并发", () => {
    const content = buildReviewFlowEvaluationEnvFile(
      "AETHER_BASE_URL=https://example.invalid/v1\n" +
        "AETHER_API_KEY='secret=value'\n" +
        "URMOTIV_ROBOT_TOKEN=never-copy\n" +
        "DASHSCOPE_BASE_URL=https://dashscope.invalid/v1\n" +
        "DASHSCOPE_API_KEY=another-secret\n",
      commit,
      2
    );
    expect(parseEnvFile(content)).toEqual({
      AETHER_BASE_URL: "https://example.invalid/v1",
      AETHER_API_KEY: "secret=value",
      DASHSCOPE_BASE_URL: "https://dashscope.invalid/v1",
      DASHSCOPE_API_KEY: "another-secret",
      EVAL_CODE_VERSION: commit,
      EVAL_CONCURRENCY: "2"
    });
    expect(content).not.toContain("URMOTIV_");
  });

  it.each([
    "",
    "AETHER_BASE_URL=https://example.invalid/v1\n",
    "AETHER_API_KEY=secret\n",
    "AETHER_BASE_URL=\nAETHER_API_KEY=secret\n"
  ])("拒绝没有完整 provider 对的输入 %#", (content) => {
    expect(() => buildReviewFlowEvaluationEnvFile(content, commit)).toThrow(
      "REVIEW_FLOW_EVALUATION_ENV_PREPARATION_FAILED"
    );
  });

  it("拒绝无效提交号和并发", () => {
    const source =
      "AETHER_BASE_URL=https://example.invalid/v1\nAETHER_API_KEY=secret\n";
    expect(() => buildReviewFlowEvaluationEnvFile(source, "0".repeat(40)))
      .toThrow("REVIEW_FLOW_EVALUATION_ENV_PREPARATION_FAILED");
    expect(() => buildReviewFlowEvaluationEnvFile(source, commit, 21))
      .toThrow("REVIEW_FLOW_EVALUATION_ENV_PREPARATION_FAILED");
    expect(() => buildReviewFlowEvaluationEnvFile(source, commit, 20))
      .not.toThrow();
  });

  it("以 0600/nlink=1 独占发布最小配置，既有目标绝不覆盖", () => {
    const fixture = createPrivateFixture("success");
    prepareReviewFlowEvaluationEnv(fixture.argv, fixture.options);
    const status = statSync(fixture.target);
    expect(status.mode & 0o777).toBe(0o600);
    expect(status.nlink).toBe(1);
    expect(parseEnvFile(readFileSync(fixture.target, "utf8"))).toEqual({
      AETHER_BASE_URL: "https://example.invalid/v1",
      AETHER_API_KEY: "test-secret",
      EVAL_CODE_VERSION: commit,
      EVAL_CONCURRENCY: "16"
    });
    const firstBytes = readFileSync(fixture.target);
    expect(() => prepareReviewFlowEvaluationEnv(
      fixture.argv,
      fixture.options
    )).toThrow("REVIEW_FLOW_EVALUATION_ENV_PREPARATION_FAILED");
    expect(readFileSync(fixture.target)).toEqual(firstBytes);
  });

  it("CLI 可显式准备 concurrency20，并拒绝 21+", () => {
    const accepted = createPrivateFixture("concurrency-20");
    prepareReviewFlowEvaluationEnv(
      [...accepted.argv, "--concurrency=20"],
      accepted.options
    );
    expect(parseEnvFile(readFileSync(accepted.target, "utf8")))
      .toMatchObject({ EVAL_CONCURRENCY: "20" });

    const rejected = createPrivateFixture("concurrency-21");
    expect(() => prepareReviewFlowEvaluationEnv(
      [...rejected.argv, "--concurrency=21"],
      rejected.options
    )).toThrow("REVIEW_FLOW_EVALUATION_ENV_PREPARATION_FAILED");
    expect(existsSync(rejected.target)).toBe(false);
  });

  it.each(["mode", "hardlink", "symlink"])(
    "拒绝不安全源文件：%s",
    (kind) => {
      const fixture = createPrivateFixture(`unsafe-${kind}`);
      if (kind === "mode") chmodSync(fixture.source, 0o644);
      if (kind === "hardlink") {
        linkSync(fixture.source, join(fixture.privateRoot, "second-link.env"));
      }
      if (kind === "symlink") {
        const realSource = join(fixture.privateRoot, "real-source.env");
        writeFileSync(realSource, fixture.sourceContent, { mode: 0o600 });
        rmSync(fixture.source);
        symlinkSync(realSource, fixture.source);
      }
      expect(() => prepareReviewFlowEvaluationEnv(
        fixture.argv,
        fixture.options
      )).toThrow();
    }
  );

  it("源配置并发变化或 HEAD 变化都会在不可逆发布前失败", () => {
    const sourceFixture = createPrivateFixture("source-change");
    let sourceReads = 0;
    expect(() => prepareReviewFlowEvaluationEnv(sourceFixture.argv, {
      ...sourceFixture.options,
      readEnvFile(path, options) {
        const content = readProtectedEnvFile(path, options);
        if (path === sourceFixture.source && ++sourceReads === 2) {
          return `${content}# changed\n`;
        }
        return content;
      }
    })).toThrow("REVIEW_FLOW_EVALUATION_ENV_PREPARATION_FAILED");
    expect(existsSync(sourceFixture.target)).toBe(false);

    const headFixture = createPrivateFixture("head-change");
    let headReads = 0;
    expect(() => prepareReviewFlowEvaluationEnv(headFixture.argv, {
      ...headFixture.options,
      readRepositoryHead() {
        headReads += 1;
        if (headReads === 1) return commit;
        throw new Error("EVAL_CODE_VERSION_UPDATE_FAILED");
      }
    })).toThrow("REVIEW_FLOW_EVALUATION_ENV_PREPARATION_FAILED");
    expect(existsSync(headFixture.target)).toBe(false);
  });

  it("在读取私有源前拒绝危险父环境和项目外临时根", () => {
    const fixture = createPrivateFixture("boundary");
    expect(() => prepareReviewFlowEvaluationEnv(fixture.argv, {
      ...fixture.options,
      parentEnvironment: {
        PATH: "/usr/bin:/bin",
        NODE_OPTIONS: "--inspect"
      }
    })).toThrow("DANGEROUS_NODE_ENVIRONMENT");

    const outside = mkdtempSync(join(projectCacheRoot, "env-prep-outside-"));
    temporaryRoots.push(outside);
    chmodSync(outside, 0o700);
    expect(() => prepareReviewFlowEvaluationEnv(fixture.argv, {
      ...fixture.options,
      temporaryRoot: outside
    })).toThrow("REVIEW_FLOW_EVALUATION_ENV_PREPARATION_FAILED");
  });
});
