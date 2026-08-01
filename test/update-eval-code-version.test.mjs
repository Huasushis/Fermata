import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertCleanUpdateRepositoryState,
  parseUpdateArguments,
  replaceEvalCodeVersionLine,
  runEvalCodeVersionUpdate,
  updateEvalCodeVersionFile
} from "../scripts/update-eval-code-version.mjs";

describe("安全更新 EVAL_CODE_VERSION", () => {
  let workspace;
  let privateRoot;
  let envPath;
  let options;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "fermata-update-code-version-"));
    chmodSync(workspace, 0o700);
    const repository = join(workspace, "Fermata");
    mkdirSync(repository, { mode: 0o700 });
    privateRoot = join(repository, "private");
    mkdirSync(privateRoot, { mode: 0o700 });
    envPath = join(privateRoot, "connectivity.env");
    options = { privateRoot, containingWorkspace: workspace };
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("只替换既有目标键，保留其它字节并以 0600 原子落盘", () => {
    const oldVersion = "a".repeat(40);
    const newVersion = "b".repeat(40);
    const original = [
      "# synthetic fixture",
      "AETHER_API_KEY=synthetic-secret-value",
      `  EVAL_CODE_VERSION='${oldVersion}'  `,
      'OTHER_VALUE="spaces stay exactly"',
      ""
    ].join("\r\n");
    writeFileSync(envPath, original, { mode: 0o600 });
    let validationCount = 0;

    expect(updateEvalCodeVersionFile(envPath, newVersion, {
      ...options,
      validateBeforeAtomicReplace: () => {
        validationCount += 1;
      }
    })).toBe(true);
    expect(validationCount).toBe(1);
    expect(readFileSync(envPath, "utf8")).toBe([
      "# synthetic fixture",
      "AETHER_API_KEY=synthetic-secret-value",
      `EVAL_CODE_VERSION=${newVersion}`,
      'OTHER_VALUE="spaces stay exactly"',
      ""
    ].join("\r\n"));
    expect(lstatSync(envPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(privateRoot).filter((name) => name.includes(".tmp")))
      .toEqual([]);
  });

  it("目标已等于 HEAD 时不重写，但仍要求文件确实为 0600", () => {
    const version = "c".repeat(40);
    const original = `EVAL_CODE_VERSION=${version}\nSAFE=1\n`;
    writeFileSync(envPath, original, { mode: 0o600 });
    let validationCount = 0;
    expect(updateEvalCodeVersionFile(envPath, version, {
      ...options,
      validateBeforeAtomicReplace: () => {
        validationCount += 1;
      }
    })).toBe(false);
    expect(validationCount).toBe(1);
    expect(readFileSync(envPath, "utf8")).toBe(original);

    chmodSync(envPath, 0o400);
    expect(() => updateEvalCodeVersionFile(envPath, version, options)).toThrow(
      "EVAL_CODE_VERSION_UPDATE_FAILED"
    );
  });

  it("原子替换前文件被改动就拒绝覆盖，并清理本次临时文件", () => {
    const oldVersion = "d".repeat(40);
    const newVersion = "e".repeat(40);
    const original = `EVAL_CODE_VERSION=${oldVersion}\nSAFE=before\n`;
    const concurrent = `EVAL_CODE_VERSION=${oldVersion}\nSAFE=concurrent\n`;
    writeFileSync(envPath, original, { mode: 0o600 });

    expect(() => updateEvalCodeVersionFile(envPath, newVersion, {
      ...options,
      validateBeforeAtomicReplace: () => {
        writeFileSync(envPath, concurrent);
      }
    })).toThrow("EVAL_CODE_VERSION_UPDATE_FAILED");
    expect(readFileSync(envPath, "utf8")).toBe(concurrent);
    expect(readdirSync(privateRoot).filter((name) => name.includes(".tmp")))
      .toEqual([]);
  });

  it("缺键、重复键、非法旧值和秘密原文都只产生固定错误", () => {
    const marker = "synthetic-secret-must-not-appear";
    for (const content of [
      `AETHER_API_KEY=${marker}\n`,
      `EVAL_CODE_VERSION=${"a".repeat(40)}\n` +
        `EVAL_CODE_VERSION=${"b".repeat(40)}\n`,
      `EVAL_CODE_VERSION=${marker}\n`
    ]) {
      let caught;
      try {
        replaceEvalCodeVersionLine(content, "f".repeat(40));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toBe("EVAL_CODE_VERSION_UPDATE_FAILED");
      expect(String(caught)).not.toContain(marker);
    }
  });

  it("拒绝权限过宽文件与符号链接，不改变源文件", () => {
    const version = "1".repeat(40);
    writeFileSync(envPath, `EVAL_CODE_VERSION=${version}\n`, { mode: 0o600 });
    chmodSync(envPath, 0o640);
    expect(() => updateEvalCodeVersionFile(
      envPath,
      "2".repeat(40),
      options
    )).toThrow("EVAL_CODE_VERSION_UPDATE_FAILED");

    chmodSync(envPath, 0o600);
    const linkPath = join(privateRoot, "linked.env");
    symlinkSync(envPath, linkPath);
    expect(() => updateEvalCodeVersionFile(
      linkPath,
      "2".repeat(40),
      options
    )).toThrow("EVAL_CODE_VERSION_UPDATE_FAILED");
    expect(readFileSync(envPath, "utf8")).toBe(
      `EVAL_CODE_VERSION=${version}\n`
    );
  });

  it("只接受干净、private 未跟踪且目标 HEAD 未变化的仓库状态", () => {
    const head = "3".repeat(40);
    expect(assertCleanUpdateRepositoryState({
      headCodeVersion: head,
      porcelain: "",
      trackedPrivatePaths: "",
      privatePathIgnored: true
    })).toBe(head);
    for (const invalid of [
      { porcelain: " M README.md\n" },
      { trackedPrivatePaths: "private/secret.env\n" },
      { privatePathIgnored: false },
      { expectedHeadCodeVersion: "4".repeat(40) },
      { headCodeVersion: "not-a-commit" }
    ]) {
      expect(() => assertCleanUpdateRepositoryState({
        headCodeVersion: head,
        porcelain: "",
        trackedPrivatePaths: "",
        privatePathIgnored: true,
        ...invalid
      })).toThrow("EVAL_CODE_VERSION_UPDATE_FAILED");
    }
  });

  it("命令行只接受一个 private env 绝对路径参数", () => {
    expect(parseUpdateArguments([
      `--environment-file=${envPath}`
    ])).toBe(envPath);
    for (const argv of [
      [],
      ["--environment-file=relative.env"],
      [`--environment-file=${envPath}`, "extra"],
      [`--other=${envPath}`]
    ]) {
      expect(() => parseUpdateArguments(argv)).toThrow(
        "UPDATE_EVAL_CODE_VERSION_INVALID_ARGUMENTS"
      );
    }
  });

  it("危险 GIT_* 在读取仓库或 env 前固定拒绝且不泄露值", () => {
    const original = `EVAL_CODE_VERSION=${"5".repeat(40)}\nSAFE=unchanged\n`;
    writeFileSync(envPath, original, { mode: 0o600 });
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
      const marker = `synthetic-${key.toLowerCase()}-must-not-appear`;
      let repositoryRead = false;
      let envUpdated = false;
      let caught;
      try {
        runEvalCodeVersionUpdate([`--environment-file=${envPath}`], {
          parentEnvironment: { PATH: "/untrusted", [key]: marker },
          readRepositoryHead: () => {
            repositoryRead = true;
            return "6".repeat(40);
          },
          updateFile: () => {
            envUpdated = true;
            return true;
          }
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toBe("TRUSTED_GIT_STATE_UNAVAILABLE");
      expect(String(caught)).not.toContain(marker);
      expect(repositoryRead).toBe(false);
      expect(envUpdated).toBe(false);
      expect(readFileSync(envPath, "utf8")).toBe(original);
    }
  });
});
