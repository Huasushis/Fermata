/**
 * 付费评测的实际 Git/代码身份核验。
 *
 * EVAL_CODE_VERSION 只是启动者声明；这里还要核对真实 HEAD、干净工作树、runner
 * 与 HEAD 字节一致，以及 runner 的直接/传递依赖代码全集哈希。任何不一致都在
 * 付费请求前用固定错误码关闭，不输出文件内容或私有路径。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const commitPattern = /^(?!0{40}$)[0-9a-f]{40}$/u;
const safeRepositoryPathPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;

export const difficultyEvaluationCodePaths = [
  "experiments/eval-difficulty.ts",
  "experiments/lib/blind-evaluation.ts",
  "experiments/lib/concurrency.ts",
  "experiments/lib/difficulty-anchors-strict.ts",
  "experiments/lib/difficulty-dataset-manifest.ts",
  "experiments/lib/difficulty-evaluation-checkpoint.ts",
  "experiments/lib/difficulty-evaluation-eligibility.ts",
  "experiments/lib/evaluation-code-identity.ts",
  "experiments/lib/evaluation-integrity.ts",
  "scripts/private-runtime.mjs",
  "src/config.ts",
  "src/llm.ts",
  "src/logger.ts",
  "src/pipelines/difficulty.ts",
  "src/pipelines/types.ts",
  "src/urmotiv-schemas.ts",
  "src/yaml-lite.ts",
  "package.json",
  "package-lock.json",
  "tsconfig.json"
] as const;

/** verdict 付费诊断的 runner 与全部直接/传递本地代码依赖。 */
export const verdictEvaluationCodePaths = [
  "experiments/eval-verdict.ts",
  "experiments/lib/blind-evaluation.ts",
  "experiments/lib/concurrency.ts",
  "experiments/lib/difficulty-evaluation-eligibility.ts",
  "experiments/lib/evaluation-code-identity.ts",
  "experiments/lib/evaluation-integrity.ts",
  "experiments/lib/levels-calibration-runner.ts",
  "experiments/lib/levels-calibration-state.ts",
  "experiments/lib/verdict-evaluation-design.ts",
  "experiments/lib/verdict-evaluation-checkpoint.ts",
  "scripts/private-runtime.mjs",
  "src/config.ts",
  "src/llm.ts",
  "src/logger.ts",
  "src/pipelines/coding.ts",
  "src/pipelines/difficulty.ts",
  "src/pipelines/thinking.ts",
  "src/pipelines/types.ts",
  "src/pipelines/verdict.ts",
  "src/urmotiv-schemas.ts",
  "src/yaml-lite.ts",
  "package.json",
  "package-lock.json",
  "tsconfig.json"
] as const;

export interface EvaluationCodeIdentity {
  readonly codeVersion: string;
  readonly runnerSha256: string;
  readonly dependencyCodeSha256: string;
  readonly dependencyFileCount: number;
}

export interface EvaluationRepositoryStateSnapshot {
  readonly expectedCodeVersion: string;
  readonly actualHead: string;
  readonly porcelain: string;
  readonly trackedPrivatePaths: string;
  readonly runnerWorkingSha256: string;
  readonly runnerHeadSha256: string;
  readonly dependencyWorkingSha256: string;
  readonly dependencyHeadSha256: string;
}

export function assertEvaluationRepositoryState(
  snapshot: EvaluationRepositoryStateSnapshot
): void {
  if (
    !commitPattern.test(snapshot.expectedCodeVersion) ||
    snapshot.actualHead !== snapshot.expectedCodeVersion ||
    snapshot.porcelain.length !== 0 ||
    snapshot.trackedPrivatePaths.length !== 0 ||
    snapshot.runnerWorkingSha256 !== snapshot.runnerHeadSha256 ||
    snapshot.dependencyWorkingSha256 !== snapshot.dependencyHeadSha256
  ) {
    throw new Error("EVALUATION_CODE_IDENTITY_INVALID");
  }
}

export function hashEvaluationCodeBundle(
  files: readonly { readonly path: string; readonly bytes: Uint8Array }[]
): string {
  const paths = files.map((file) => file.path);
  if (
    new Set(paths).size !== paths.length ||
    paths.some((path) =>
      !safeRepositoryPathPattern.test(path) ||
      path.startsWith("/") ||
      path.split("/").some((component) => component === ".." || component === ".")
    )
  ) {
    throw new Error("EVALUATION_CODE_IDENTITY_INVALID");
  }
  const digest = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const pathBytes = Buffer.from(file.path, "utf8");
    digest.update(String(pathBytes.byteLength));
    digest.update(":");
    digest.update(pathBytes);
    digest.update("\0");
    digest.update(String(file.bytes.byteLength));
    digest.update(":");
    digest.update(file.bytes);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function git(repositoryDirectory: string, args: readonly string[]): Buffer {
  try {
    return execFileSync("git", args, {
      cwd: repositoryDirectory,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    throw new Error("EVALUATION_CODE_IDENTITY_INVALID");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function loadEvaluationCodeIdentity(input: {
  readonly repositoryDirectory: string;
  readonly expectedCodeVersion: string;
  readonly runnerPath: string;
  readonly dependencyPaths: readonly string[];
}): EvaluationCodeIdentity {
  try {
    const dependencyPaths = [...input.dependencyPaths];
    if (
      !dependencyPaths.includes(input.runnerPath) ||
      new Set(dependencyPaths).size !== dependencyPaths.length
    ) {
      throw new Error("EVALUATION_CODE_IDENTITY_INVALID");
    }
    // --error-unmatch 确保清单里的每个文件都已跟踪；不接受运行时新增依赖。
    git(input.repositoryDirectory, [
      "ls-files",
      "--error-unmatch",
      "--",
      ...dependencyPaths
    ]);
    const actualHead = git(input.repositoryDirectory, ["rev-parse", "--verify", "HEAD"])
      .toString("utf8")
      .trim();
    const porcelain = git(input.repositoryDirectory, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all"
    ]).toString("utf8");
    const trackedPrivatePaths = git(input.repositoryDirectory, [
      "ls-files",
      "private"
    ]).toString("utf8");

    const workingFiles: { path: string; bytes: Buffer }[] = [];
    const headFiles: { path: string; bytes: Buffer }[] = [];
    for (const path of dependencyPaths) {
      if (
        !safeRepositoryPathPattern.test(path) ||
        path.startsWith("/") ||
        path.split("/").some((component) => component === ".." || component === ".")
      ) {
        throw new Error("EVALUATION_CODE_IDENTITY_INVALID");
      }
      const absolutePath = resolve(input.repositoryDirectory, path);
      const status = lstatSync(absolutePath);
      if (!status.isFile() || status.isSymbolicLink()) {
        throw new Error("EVALUATION_CODE_IDENTITY_INVALID");
      }
      workingFiles.push({ path, bytes: readFileSync(absolutePath) });
      headFiles.push({
        path,
        bytes: git(input.repositoryDirectory, ["show", `HEAD:${path}`])
      });
    }
    const runnerWorking = workingFiles.find((file) => file.path === input.runnerPath);
    const runnerHead = headFiles.find((file) => file.path === input.runnerPath);
    if (runnerWorking === undefined || runnerHead === undefined) {
      throw new Error("EVALUATION_CODE_IDENTITY_INVALID");
    }
    const dependencyWorkingSha256 = hashEvaluationCodeBundle(workingFiles);
    const dependencyHeadSha256 = hashEvaluationCodeBundle(headFiles);
    const runnerWorkingSha256 = sha256(runnerWorking.bytes);
    const runnerHeadSha256 = sha256(runnerHead.bytes);
    assertEvaluationRepositoryState({
      expectedCodeVersion: input.expectedCodeVersion,
      actualHead,
      porcelain,
      trackedPrivatePaths,
      runnerWorkingSha256,
      runnerHeadSha256,
      dependencyWorkingSha256,
      dependencyHeadSha256
    });
    return {
      codeVersion: actualHead,
      runnerSha256: runnerWorkingSha256,
      dependencyCodeSha256: dependencyWorkingSha256,
      dependencyFileCount: dependencyPaths.length
    };
  } catch {
    throw new Error("EVALUATION_CODE_IDENTITY_INVALID");
  }
}
