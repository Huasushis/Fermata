import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertEvaluationRepositoryState,
  difficultyEvaluationCodePaths,
  hashEvaluationCodeBundle,
  loadEvaluationCodeIdentity,
  verdictEvaluationCodePaths
} from "../experiments/lib/evaluation-code-identity";
import {
  buildTrustedGitEnvironment,
  trustedGitExecutable
} from "../scripts/trusted-git-state.mjs";

const digest = "a".repeat(64);
const commit = "b".repeat(40);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureGit(repository: string, arguments_: readonly string[]): string {
  return execFileSync(trustedGitExecutable, arguments_, {
    cwd: repository,
    encoding: "utf8",
    env: buildTrustedGitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function createIdentityRepository(): { readonly root: string; readonly repository: string; readonly head: string } {
  const root = mkdtempSync(join(tmpdir(), "fermata-code-identity-"));
  temporaryDirectories.push(root);
  chmodSync(root, 0o700);
  const repository = join(root, "repository");
  execFileSync(
    trustedGitExecutable,
    ["init", "-q", "--initial-branch=main", repository],
    { env: buildTrustedGitEnvironment(), stdio: "ignore" }
  );
  writeFileSync(join(repository, "runner.ts"), "export const value = 'base';\n");
  writeFileSync(join(repository, ".gitattributes"), "runner.ts filter=identity-test\n");
  writeFileSync(join(repository, ".gitignore"), "/private/\n");
  fixtureGit(repository, ["add", "--all"]);
  fixtureGit(repository, [
    "-c", "user.name=Synthetic Test",
    "-c", "user.email=synthetic@example.invalid",
    "commit", "-q", "-m", "base"
  ]);
  return { root, repository, head: fixtureGit(repository, ["rev-parse", "HEAD"]) };
}

describe("付费评测实际代码身份", () => {
  it("安全关键的私有运行边界属于登记的运行依赖", () => {
    expect(difficultyEvaluationCodePaths).toContain("experiments/eval-difficulty.ts");
    expect(difficultyEvaluationCodePaths).toContain("scripts/private-runtime.mjs");
    expect(new Set(difficultyEvaluationCodePaths).size).toBe(difficultyEvaluationCodePaths.length);
    expect(verdictEvaluationCodePaths).toContain("experiments/eval-verdict.ts");
    expect(verdictEvaluationCodePaths).toContain("experiments/lib/verdict-evaluation-checkpoint.ts");
    expect(verdictEvaluationCodePaths).toContain("scripts/private-runtime.mjs");
    expect(verdictEvaluationCodePaths).toContain("src/pipelines/verdict.ts");
    expect(new Set(verdictEvaluationCodePaths).size).toBe(verdictEvaluationCodePaths.length);
  });

  it("声明提交、真实 HEAD、干净工作树、runner 和依赖全集都一致时通过", () => {
    expect(() => assertEvaluationRepositoryState({
      expectedCodeVersion: commit,
      actualHead: commit,
      porcelain: "",
      trackedPrivatePaths: "",
      runnerWorkingSha256: digest,
      runnerHeadSha256: digest,
      dependencyWorkingSha256: digest,
      dependencyHeadSha256: digest
    })).not.toThrow();
  });

  it.each([
    { actualHead: "c".repeat(40) },
    { porcelain: " M src/llm.ts\n" },
    { trackedPrivatePaths: "private/secret.env\n" },
    { runnerWorkingSha256: "c".repeat(64) },
    { dependencyWorkingSha256: "c".repeat(64) }
  ])("任一身份不一致都在付费前固定拒绝：%o", (override) => {
    expect(() => assertEvaluationRepositoryState({
      expectedCodeVersion: commit,
      actualHead: commit,
      porcelain: "",
      trackedPrivatePaths: "",
      runnerWorkingSha256: digest,
      runnerHeadSha256: digest,
      dependencyWorkingSha256: digest,
      dependencyHeadSha256: digest,
      ...override
    })).toThrow("EVALUATION_CODE_IDENTITY_INVALID");
  });

  it("依赖路径和字节都进入稳定全集哈希", () => {
    const original = hashEvaluationCodeBundle([
      { path: "src/b.ts", bytes: new TextEncoder().encode("b") },
      { path: "src/a.ts", bytes: new TextEncoder().encode("a") }
    ]);
    expect(hashEvaluationCodeBundle([
      { path: "src/a.ts", bytes: new TextEncoder().encode("a") },
      { path: "src/b.ts", bytes: new TextEncoder().encode("b") }
    ])).toBe(original);
    expect(hashEvaluationCodeBundle([
      { path: "src/a.ts", bytes: new TextEncoder().encode("changed") },
      { path: "src/b.ts", bytes: new TextEncoder().encode("b") }
    ])).not.toBe(original);
    expect(() => hashEvaluationCodeBundle([
      { path: "../outside.ts", bytes: new Uint8Array() }
    ])).toThrow("EVALUATION_CODE_IDENTITY_INVALID");
  });

  it("代码身份忽略 PATH 伪 git、local filter/fsmonitor 与 replace ref", () => {
    const fixture = createIdentityRepository();
    const marker = join(fixture.root, "untrusted-command.marker");
    const command = join(fixture.root, "untrusted-command.sh");
    writeFileSync(command, `#!/bin/sh\n: > "${marker}"\ncat\n`, { mode: 0o700 });

    writeFileSync(join(fixture.repository, "runner.ts"), "export const value = 'replacement';\n");
    fixtureGit(fixture.repository, ["add", "runner.ts"]);
    fixtureGit(fixture.repository, [
      "-c", "user.name=Synthetic Test",
      "-c", "user.email=synthetic@example.invalid",
      "commit", "-q", "-m", "replacement"
    ]);
    const replacement = fixtureGit(fixture.repository, ["rev-parse", "HEAD"]);
    fixtureGit(fixture.repository, ["reset", "-q", "--hard", fixture.head]);
    fixtureGit(fixture.repository, ["replace", fixture.head, replacement]);
    fixtureGit(fixture.repository, ["config", "core.fsmonitor", command]);
    fixtureGit(fixture.repository, ["config", "filter.identity-test.clean", command]);
    fixtureGit(fixture.repository, ["config", "filter.identity-test.required", "true"]);
    const now = new Date(Date.now() + 1_000);
    utimesSync(join(fixture.repository, "runner.ts"), now, now);

    const fakeBin = join(fixture.root, "fake-bin");
    mkdirSync(fakeBin, { mode: 0o700 });
    const fakeGit = join(fakeBin, "git");
    writeFileSync(fakeGit, `#!/bin/sh\n: > "${marker}"\nexit 97\n`, { mode: 0o700 });
    const originalPath = process.env.PATH;
    const originalGitConfig = process.env.GIT_CONFIG;
    try {
      process.env.PATH = fakeBin;
      process.env.GIT_CONFIG = join(fixture.root, "attacker.config");
      expect(loadEvaluationCodeIdentity({
        repositoryDirectory: fixture.repository,
        expectedCodeVersion: fixture.head,
        runnerPath: "runner.ts",
        dependencyPaths: ["runner.ts"]
      })).toMatchObject({ codeVersion: fixture.head, dependencyFileCount: 1 });
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalGitConfig === undefined) delete process.env.GIT_CONFIG;
      else process.env.GIT_CONFIG = originalGitConfig;
    }
  });

  it.each(["--assume-unchanged", "--skip-worktree"])(
    "拒绝 index %s 标志，即使 porcelain 会少报",
    (flag) => {
      const fixture = createIdentityRepository();
      fixtureGit(fixture.repository, ["update-index", flag, "runner.ts"]);
      expect(() => loadEvaluationCodeIdentity({
        repositoryDirectory: fixture.repository,
        expectedCodeVersion: fixture.head,
        runnerPath: "runner.ts",
        dependencyPaths: ["runner.ts"]
      })).toThrow("EVALUATION_CODE_IDENTITY_INVALID");
    }
  );

});
