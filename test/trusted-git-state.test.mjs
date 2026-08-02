import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repositoryRoot } from "../scripts/private-runtime.mjs";
import {
  assertSafeCallerGitEnvironment,
  buildTrustedGitEnvironment,
  runTrustedGit,
  trustedGitExecutable,
  verifyTrustedGitExecutable,
  withTrustedGitSnapshot
} from "../scripts/trusted-git-state.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runFixtureGit(repository, arguments_) {
  return execFileSync(trustedGitExecutable, arguments_, {
    cwd: repository,
    encoding: "utf8",
    env: buildTrustedGitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function createRepository({ ignorePrivate = true } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "fermata-trusted-repo-"));
  directories.push(fixture);
  chmodSync(fixture, 0o700);
  const repository = join(fixture, "repository");
  execFileSync(
    trustedGitExecutable,
    ["init", "-q", "--initial-branch=main", repository],
    { env: buildTrustedGitEnvironment(), stdio: "ignore" }
  );
  writeFileSync(join(repository, "tracked-clean.txt"), "clean base\n");
  writeFileSync(join(repository, "tracked-process.txt"), "process base\n");
  writeFileSync(join(repository, "tracked-textconv.txt"), "textconv base\n");
  writeFileSync(join(repository, "tracked-info.txt"), "info base\n");
  writeFileSync(
    join(repository, ".gitattributes"),
    "tracked-clean.txt filter=arbitrary-clean-driver-47\n" +
      "tracked-process.txt filter=arbitrary-process-driver-83\n" +
      "tracked-textconv.txt diff=arbitrary-textconv-driver-29\n"
  );
  if (ignorePrivate) {
    writeFileSync(join(repository, ".gitignore"), "/private/\n");
  }
  runFixtureGit(repository, ["add", "--all"]);
  runFixtureGit(repository, [
    "-c",
    "user.name=Synthetic Test",
    "-c",
    "user.email=synthetic@example.invalid",
    "commit",
    "-q",
    "-m",
    "synthetic fixture"
  ]);
  return { fixture, repository };
}

function sameIndexSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function markerCommand(fixture, name) {
  const marker = join(fixture, `${name}.marker`);
  const command = join(fixture, `${name}.sh`);
  writeFileSync(
    command,
    `#!/bin/sh\n: > "${marker}"\nexit 97\n`,
    { mode: 0o700 }
  );
  return { marker, command };
}

describe("受信 Git 状态读取", () => {
  it("固定映射已验证 Git、只读仓库描述符和 0700 临时元数据目录", () => {
    expect(() => verifyTrustedGitExecutable()).not.toThrow();
    let invocation;
    let controlledGitDirectory;
    const result = runTrustedGit(repositoryRoot, ["rev-parse", "HEAD"], {
      encoding: "utf8",
      verifyExecutable: () => {},
      execute: (executable, args, options) => {
        invocation = { executable, args, options };
        const controlledIndex = realpathSync(
          `/proc/self/fd/${options.stdio[3]}`
        );
        controlledGitDirectory = realpathSync(
          `/proc/self/fd/${options.stdio[6]}`
        );
        expect(controlledIndex).toBe(join(controlledGitDirectory, "index"));
        expect(statSync(join(controlledGitDirectory, "source-index")).mode & 0o777)
          .toBe(0o400);
        expect(readFileSync(join(controlledGitDirectory, "source-index")))
          .toEqual(readFileSync(join(repositoryRoot, ".git", "index")));
        expect(controlledIndex).not.toBe(join(repositoryRoot, ".git", "index"));
        expect(statSync(controlledIndex).mode & 0o777).toBe(0o400);
        let writeError;
        try {
          writeFileSync(
            `/proc/self/fd/${options.stdio[3]}`,
            "must-not-write"
          );
        } catch (error) {
          writeError = error;
        }
        expect(writeError).toMatchObject({ code: "EACCES" });
        expect(statSync(controlledGitDirectory).mode & 0o777).toBe(0o700);
        expect(statSync(join(controlledGitDirectory, "HEAD")).mode & 0o777)
          .toBe(0o600);
        expect(readFileSync(
          join(controlledGitDirectory, "info", "exclude"),
          "utf8"
        )).toBe("/.git/\n");
        return readFileSync(join(controlledGitDirectory, "HEAD"), "utf8");
      }
    });
    expect(result).toMatch(/^[0-9a-f]{40}\n$/u);
    expect(invocation.executable).toBe("/usr/bin/git");
    expect(invocation.args).toEqual(expect.arrayContaining([
      "--git-dir=/proc/self/fd/6",
      "--work-tree=/proc/self/fd/5",
      "--no-replace-objects",
      "core.fsmonitor=false",
      "core.hooksPath=/dev/null",
      "diff.ignoreSubmodules=all"
    ]));
    expect(invocation.args).not.toContain(
      `--git-dir=${join(repositoryRoot, ".git")}`
    );
    expect(invocation.options.env).toMatchObject({
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_INDEX_FILE: "/proc/self/fd/3",
      GIT_OBJECT_DIRECTORY: "/proc/self/fd/4",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin"
    });
    expect(invocation.options.env.GIT_CONFIG).toBeUndefined();
    expect(invocation.options.env.GIT_DIR).toBeUndefined();
    expect(invocation.options.env.GIT_WORK_TREE).toBeUndefined();
    expect(invocation.options.stdio).toHaveLength(7);
    for (const descriptor of invocation.options.stdio.slice(3)) {
      expect(descriptor).toEqual(expect.any(Number));
    }
    expect(existsSync(controlledGitDirectory)).toBe(false);
  });

  it("伪 PATH 和调用者 GIT_* 不能替换可执行文件、仓库或索引", () => {
    const fixture = mkdtempSync(join(tmpdir(), "fermata-fake-git-"));
    directories.push(fixture);
    chmodSync(fixture, 0o700);
    const fakeBin = join(fixture, "bin");
    mkdirSync(fakeBin, { mode: 0o700 });
    const marker = join(fixture, "fake-git-was-run");
    const fakeGit = join(fakeBin, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh\n: > "${marker}"\nexit 99\n`,
      { mode: 0o700 }
    );

    const original = {
      PATH: process.env.PATH,
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE
    };
    try {
      process.env.PATH = fakeBin;
      process.env.GIT_DIR = join(fixture, "fake.git");
      process.env.GIT_WORK_TREE = fixture;
      process.env.GIT_INDEX_FILE = join(fixture, "fake.index");
      const head = runTrustedGit(repositoryRoot, ["rev-parse", "HEAD"], {
        encoding: "utf8"
      }).trim();
      expect(head).toMatch(/^[0-9a-f]{40}$/u);
      expect(existsSync(marker)).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("隔离 local config/include、任意 clean/process/textconv 与 info attributes", () => {
    const { fixture, repository } = createRepository();
    const clean = markerCommand(fixture, "clean-filter");
    const processFilter = markerCommand(fixture, "process-filter");
    const textconv = markerCommand(fixture, "textconv-filter");
    const info = markerCommand(fixture, "info-attributes-filter");
    const fsmonitor = markerCommand(fixture, "fsmonitor");
    const includedConfig = join(fixture, "included.config");
    writeFileSync(
      includedConfig,
      `[filter "arbitrary-process-driver-83"]\n` +
        `\tprocess = ${processFilter.command}\n` +
        `\trequired = true\n` +
        `[diff "arbitrary-textconv-driver-29"]\n` +
        `\ttextconv = ${textconv.command}\n`,
      { mode: 0o600 }
    );
    writeFileSync(
      join(repository, ".git", "config"),
      `[core]\n` +
        `\trepositoryformatversion = 0\n` +
        `\tbare = false\n` +
        `\tworktree = ${join(fixture, "wrong-worktree")}\n` +
        `\tfsmonitor = ${fsmonitor.command}\n` +
        `[filter "arbitrary-clean-driver-47"]\n` +
        `\tclean = ${clean.command}\n` +
        `\trequired = true\n` +
        `[filter "arbitrary-info-driver-61"]\n` +
        `\tclean = ${info.command}\n` +
        `\trequired = true\n` +
        `[include]\n\tpath = ${includedConfig}\n`,
      { mode: 0o600 }
    );
    writeFileSync(
      join(repository, ".git", "info", "attributes"),
      "tracked-info.txt filter=arbitrary-info-driver-61 " +
        "diff=arbitrary-textconv-driver-29\n",
      { mode: 0o600 }
    );
    // 保持文件大小不变，迫使 status 真正读取并转换内容，而非只凭 size 判脏。
    writeFileSync(join(repository, "tracked-clean.txt"), "clean flip\n");
    writeFileSync(join(repository, "tracked-process.txt"), "process flip\n");
    writeFileSync(join(repository, "tracked-textconv.txt"), "textconv flip\n");
    writeFileSync(join(repository, "tracked-info.txt"), "info flip\n");
    const privateDirectory = join(repository, "private");
    mkdirSync(privateDirectory);
    writeFileSync(join(privateDirectory, "synthetic.txt"), "ignored\n");

    // 正向控制证明这些正式 config/include/info attributes 确实都能启动对应
    // 外部程序；随后删除标记，再验证受信快照的 status/show 一个也不启动。
    for (const arguments_ of [
      [
        `--work-tree=${repository}`,
        "hash-object",
        "--path=tracked-clean.txt",
        "tracked-clean.txt"
      ],
      [
        `--work-tree=${repository}`,
        "hash-object",
        "--path=tracked-process.txt",
        "tracked-process.txt"
      ],
      [
        `--work-tree=${repository}`,
        "hash-object",
        "--path=tracked-info.txt",
        "tracked-info.txt"
      ],
      [
        `--work-tree=${repository}`,
        "-c",
        "core.fsmonitor=false",
        "diff",
        "--textconv",
        "HEAD",
        "--",
        "tracked-textconv.txt"
      ],
      [
        `--work-tree=${repository}`,
        "status",
        "--porcelain=v1",
        "--untracked-files=all"
      ]
    ]) {
      try {
        runFixtureGit(repository, arguments_);
      } catch {
        // 合成外部程序在写标记后固定失败；这里只验证它确实可被正式配置触发。
      }
    }
    for (const { marker } of [clean, processFilter, textconv, info, fsmonitor]) {
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
    }

    const indexPath = join(repository, ".git", "index");
    const indexBefore = statSync(indexPath, { bigint: true });
    const indexBytesBefore = readFileSync(indexPath);
    const result = withTrustedGitSnapshot(repository, (git) => ({
      head: git.headCodeVersion,
      status: git.run(
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { encoding: "utf8" }
      ),
      shown: git.run(
        ["show", "HEAD:tracked-textconv.txt"],
        { encoding: "utf8" }
      ),
      privateIgnored: (() => {
        try {
          git.run(["check-ignore", "-q", "private/.synthetic-check"]);
          return true;
        } catch {
          return false;
        }
      })()
    }));

    expect(result.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(result.status).toContain(" M tracked-clean.txt");
    expect(result.status).toContain(" M tracked-process.txt");
    expect(result.status).toContain(" M tracked-textconv.txt");
    expect(result.status).toContain(" M tracked-info.txt");
    expect(result.status).not.toContain(".git/");
    expect(result.status).not.toContain("private/");
    expect(result.shown).toBe("textconv base\n");
    expect(result.privateIgnored).toBe(true);
    for (const { marker } of [clean, processFilter, textconv, info, fsmonitor]) {
      expect(existsSync(marker)).toBe(false);
    }
    expect(existsSync(join(repository, ".git", "index.lock"))).toBe(false);
    expect(readFileSync(indexPath)).toEqual(indexBytesBefore);
    expect(sameIndexSnapshot(
      indexBefore,
      statSync(indexPath, { bigint: true })
    )).toBe(true);
  });

  it("不信任正式 index 被 local clean filter 刷新的同尺寸 clean stat cache", () => {
    const { fixture, repository } = createRepository();
    const cleanCommand = join(fixture, "cache-poison-clean.sh");
    writeFileSync(
      cleanCommand,
      "#!/bin/sh\ncat >/dev/null\nprintf 'clean base\\n'\n",
      { mode: 0o700 }
    );
    writeFileSync(
      join(repository, ".git", "config"),
      "[core]\n" +
        "\trepositoryformatversion = 0\n" +
        "\tbare = false\n" +
        `[filter "arbitrary-clean-driver-47"]\n` +
        `\tclean = ${cleanCommand}\n` +
        "\trequired = true\n",
      { mode: 0o600 }
    );
    // 与 HEAD 字节数相同；正式 Git 在本地 filter 看来仍等于 clean base，并在
    // optional-locks 开启时把这份脏工作树的 stat 写回正式 index。
    writeFileSync(join(repository, "tracked-clean.txt"), "clean flip\n");
    const poisonedStatus = execFileSync(
      trustedGitExecutable,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: repository,
        encoding: "utf8",
        env: {
          ...buildTrustedGitEnvironment(),
          GIT_OPTIONAL_LOCKS: "1"
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    expect(poisonedStatus).not.toContain("tracked-clean.txt");

    const indexPath = join(repository, ".git", "index");
    const indexBefore = statSync(indexPath, { bigint: true });
    const indexBytesBefore = readFileSync(indexPath);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const trustedStatus = runTrustedGit(
        repository,
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { encoding: "utf8" }
      );
      expect(trustedStatus).toContain(" M tracked-clean.txt");
    }
    expect(readFileSync(indexPath)).toEqual(indexBytesBefore);
    expect(sameIndexSnapshot(
      indexBefore,
      statSync(indexPath, { bigint: true })
    )).toBe(true);
  });

  it("HEAD 重建索引仍准确区分 staged、unstaged 与 untracked", () => {
    const { repository } = createRepository();
    writeFileSync(join(repository, "tracked-clean.txt"), "staged clean\n");
    runFixtureGit(repository, ["add", "tracked-clean.txt"]);
    writeFileSync(join(repository, "tracked-clean.txt"), "working tree\n");
    writeFileSync(join(repository, "tracked-info.txt"), "staged info\n");
    runFixtureGit(repository, ["add", "tracked-info.txt"]);
    writeFileSync(join(repository, "untracked.txt"), "untracked\n");

    const indexPath = join(repository, ".git", "index");
    const indexBefore = statSync(indexPath, { bigint: true });
    const indexBytesBefore = readFileSync(indexPath);
    const status = runTrustedGit(
      repository,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { encoding: "utf8" }
    );
    expect(status).toContain("MM tracked-clean.txt");
    expect(status).toContain("M  tracked-info.txt");
    expect(status).toContain("?? untracked.txt");
    expect(readFileSync(indexPath)).toEqual(indexBytesBefore);
    expect(sameIndexSnapshot(
      indexBefore,
      statSync(indexPath, { bigint: true })
    )).toBe(true);
  });

  it("临时 exclude 只排除根 .git，不会把 private 放宽成隐式忽略", () => {
    const { repository } = createRepository({ ignorePrivate: false });
    mkdirSync(join(repository, "private"));
    writeFileSync(join(repository, "private", "synthetic.txt"), "synthetic\n");
    const status = runTrustedGit(
      repository,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { encoding: "utf8" }
    );
    expect(status).toContain("?? private/synthetic.txt");
    expect(status).not.toContain(".git/");
    expect(() => runTrustedGit(
      repository,
      ["check-ignore", "-q", "private/.synthetic-check"]
    )).toThrow("TRUSTED_GIT_STATE_UNAVAILABLE");
  });

  it("支持绑定 packed ref，但在检查期间 HEAD 或索引变化时失败关闭并清理", () => {
    const packed = createRepository();
    const expectedHead = runFixtureGit(packed.repository, ["rev-parse", "HEAD"])
      .trim();
    runFixtureGit(packed.repository, ["pack-refs", "--all"]);
    expect(runTrustedGit(
      packed.repository,
      ["rev-parse", "HEAD"],
      { encoding: "utf8" }
    ).trim()).toBe(expectedHead);

    for (const mutation of ["HEAD", "index"]) {
      const current = createRepository();
      const temporaryRoot = join(current.fixture, `temporary-${mutation}`);
      mkdirSync(temporaryRoot, { mode: 0o700 });
      let caught;
      try {
        withTrustedGitSnapshot(
          current.repository,
          () => {
            if (mutation === "HEAD") {
              writeFileSync(
                join(current.repository, ".git", "HEAD"),
                `${"f".repeat(40)}\n`
              );
            } else {
              appendFileSync(join(current.repository, ".git", "index"), "x");
            }
            return "must-not-return";
          },
          { temporaryRoot }
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toBe("TRUSTED_GIT_STATE_UNAVAILABLE");
      expect(readdirSync(temporaryRoot)).toEqual([]);
    }
  });

  it("回调错误不泄露原文并清理唯一临时元数据目录", () => {
    const { fixture, repository } = createRepository();
    const temporaryRoot = join(fixture, "temporary-root");
    mkdirSync(temporaryRoot, { mode: 0o700 });
    const marker = "synthetic-secret-callback-error-must-not-appear";
    let caught;
    try {
      withTrustedGitSnapshot(
        repository,
        () => {
          throw new Error(marker);
        },
        { temporaryRoot }
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toBe("TRUSTED_GIT_STATE_UNAVAILABLE");
    expect(String(caught)).not.toContain(marker);
    expect(readdirSync(temporaryRoot)).toEqual([]);
  });

  it("只允许同步快照作用域，结束后保存的接口不能复用已关闭描述符", () => {
    const { repository } = createRepository();
    let escapedSnapshot;
    const head = withTrustedGitSnapshot(repository, (git) => {
      escapedSnapshot = git;
      return git.headCodeVersion;
    });
    expect(head).toMatch(/^[0-9a-f]{40}$/u);
    expect(() => escapedSnapshot.run(["rev-parse", "HEAD"], {
      encoding: "utf8"
    })).toThrow("TRUSTED_GIT_STATE_UNAVAILABLE");
    expect(() => withTrustedGitSnapshot(
      repository,
      async () => "must-not-return"
    )).toThrow("TRUSTED_GIT_STATE_UNAVAILABLE");
  });

  it("只读检查前后正式仓库状态一致且不创建真实索引锁", () => {
    const { repository } = createRepository();
    const beforeStatus = runFixtureGit(repository, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all"
    ]);
    const indexPath = join(repository, ".git", "index");
    const beforeIndex = statSync(indexPath, { bigint: true });
    const beforeBytes = readFileSync(indexPath);

    expect(runTrustedGit(
      repository,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { encoding: "utf8" }
    )).toBe(beforeStatus);
    expect(readFileSync(indexPath)).toEqual(beforeBytes);
    expect(sameIndexSnapshot(
      beforeIndex,
      statSync(indexPath, { bigint: true })
    )).toBe(true);
    expect(existsSync(join(repository, ".git", "index.lock"))).toBe(false);
    expect(runFixtureGit(repository, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all"
    ])).toBe(beforeStatus);
  });

  it("只放行固定 ls-files 身份检查形状并拒绝 pathspec 选项注入", () => {
    const { repository } = createRepository();
    for (const command of [
      ["ls-files", "-v", "-z"],
      ["ls-files", "-f", "-z"]
    ]) {
      const output = runTrustedGit(repository, command);
      expect(output.toString("utf8").split("\0").filter(Boolean))
        .toEqual(expect.arrayContaining(["H tracked-clean.txt"]));
    }
    expect(runTrustedGit(repository, [
      "ls-files",
      "--error-unmatch",
      "--",
      "tracked-clean.txt",
      "tracked-info.txt"
    ]).toString("utf8")).toContain("tracked-clean.txt");
    expect(() => runTrustedGit(repository, [
      "ls-files",
      "--error-unmatch",
      "--",
      "--stage"
    ])).toThrow("TRUSTED_GIT_STATE_UNAVAILABLE");
    expect(() => runTrustedGit(repository, [
      "ls-files",
      "--error-unmatch",
      "--",
      "../outside"
    ])).toThrow("TRUSTED_GIT_STATE_UNAVAILABLE");
  });

  it("拒绝未登记的写入型或任意 Git 子命令", () => {
    for (const command of [
      ["reset", "--hard"],
      ["config", "--list"],
      ["show", "HEAD:../outside"]
    ]) {
      expect(() => runTrustedGit(repositoryRoot, command, {
        encoding: "utf8",
        verifyExecutable: () => {},
        execute: () => {
          throw new Error("must-not-execute");
        }
      })).toThrow("TRUSTED_GIT_STATE_UNAVAILABLE");
    }
  });

  it("危险调用者 Git 变量固定拒绝且错误不包含其值", () => {
    const marker = "synthetic-git-config-secret-must-not-appear";
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_CONFIG_PARAMETERS"
    ]) {
      let caught;
      try {
        assertSafeCallerGitEnvironment({ [key]: marker });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toBe("TRUSTED_GIT_STATE_UNAVAILABLE");
      expect(String(caught)).not.toContain(marker);
    }
    expect(() => assertSafeCallerGitEnvironment({
      GIT_PAGER: "caller-value-is-ignored"
    })).not.toThrow();
  });
});
