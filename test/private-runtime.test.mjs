import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  anchoredPrivatePath,
  closePrivateDirectory,
  durablyCommitCreatedPrivateDirectory,
  openExistingPrivateDirectory,
  preparePrivateDirectory,
  readProtectedEnvFile
} from "../scripts/private-runtime.mjs";

describe("Fermata 私有运行路径", () => {
  let workspace;
  let privateRoot;
  let options;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "fermata-private-runtime-"));
    chmodSync(workspace, 0o700);
    const repository = join(workspace, "Fermata");
    mkdirSync(repository, { mode: 0o700 });
    privateRoot = join(repository, "private");
    mkdirSync(privateRoot, { mode: 0o700 });
    options = { privateRoot, containingWorkspace: workspace };
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("只创建最后一级运行目录并固定为 0700", () => {
    const result = preparePrivateDirectory(join(privateRoot, "runs"), options);
    expect(result.created).toBe(true);
    expect(result.path).toBe(join(privateRoot, "runs"));
    expect(lstatSync(result.path).mode & 0o777).toBe(0o700);
    const existing = preparePrivateDirectory(join(privateRoot, "runs"), options);
    expect(existing.created).toBe(false);
    closePrivateDirectory(existing);
    expect(() => closePrivateDirectory(existing)).not.toThrow();
    expect(() => anchoredPrivatePath(existing, "log.txt")).toThrow(
      "PRIVATE_DIRECTORY_HANDLE_CLOSED"
    );
    closePrivateDirectory(result);
  });

  it("只读打开不存在目录时不创建，存在目录仍保持 dirfd 锚定", () => {
    const missing = join(privateRoot, "missing-input");
    expect(() => openExistingPrivateDirectory(missing, options)).toThrow(
      "PRIVATE_DIRECTORY_UNAVAILABLE"
    );
    expect(existsSync(missing)).toBe(false);

    const original = join(privateRoot, "existing-input");
    const moved = join(privateRoot, "existing-input-moved");
    mkdirSync(original, { mode: 0o700 });
    const handle = openExistingPrivateDirectory(original, options);
    expect(handle.created).toBe(false);
    renameSync(original, moved);
    mkdirSync(original, { mode: 0o700 });
    writeFileSync(anchoredPrivatePath(handle, "proof.txt"), "anchored\n", {
      mode: 0o600
    });
    expect(readFileSync(join(moved, "proof.txt"), "utf8")).toBe("anchored\n");
    expect(existsSync(join(original, "proof.txt"))).toBe(false);
    closePrivateDirectory(handle);
  });

  it("只读打开同样拒绝过宽权限与末级符号链接", () => {
    const broad = join(privateRoot, "broad-input");
    mkdirSync(broad, { mode: 0o755 });
    chmodSync(broad, 0o755); // umask 可能把 mkdir 模式收窄成 0700，显式固定
    expect(() => openExistingPrivateDirectory(broad, options)).toThrow(
      "PRIVATE_DIRECTORY_INVALID_MODE"
    );
    const target = join(privateRoot, "input-target");
    const linked = join(privateRoot, "input-linked");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, linked);
    expect(() => openExistingPrivateDirectory(linked, options)).toThrow(
      "PRIVATE_DIRECTORY_INVALID_TYPE"
    );
  });

  it("新建目录先 fsync 自身、再 fsync 持有目录项的父目录", () => {
    const synchronized = [];
    durablyCommitCreatedPrivateDirectory(101, 202, (descriptor) => {
      synchronized.push(descriptor);
    });
    expect(synchronized).toEqual([101, 202]);
  });

  it("拒绝项目私有根之外和旧归档方向的运行目录", () => {
    expect(() =>
      preparePrivateDirectory(join(workspace, "previous-server-work", "run"), options)
    ).toThrow("PRIVATE_DIRECTORY_OUTSIDE_ROOT");
    expect(() => preparePrivateDirectory(privateRoot, options)).toThrow(
      "PRIVATE_DIRECTORY_OUTSIDE_ROOT"
    );
  });

  it("拒绝权限过宽、末级符号链接和中间符号链接", () => {
    const broad = join(privateRoot, "broad");
    mkdirSync(broad, { mode: 0o700 });
    chmodSync(broad, 0o755);
    expect(() => preparePrivateDirectory(broad, options)).toThrow(
      "PRIVATE_DIRECTORY_INVALID_MODE"
    );

    const target = join(privateRoot, "target");
    mkdirSync(target, { mode: 0o700 });
    const linked = join(privateRoot, "linked");
    symlinkSync(target, linked);
    expect(() => preparePrivateDirectory(linked, options)).toThrow(
      "PRIVATE_DIRECTORY_INVALID_TYPE"
    );
    expect(() => preparePrivateDirectory(join(linked, "nested"), options)).toThrow(
      "PRIVATE_DIRECTORY_INVALID_TYPE"
    );
  });

  it("祖先打开失败不会泄漏或二次接管 root 描述符", () => {
    const before = readdirSync("/proc/self/fd").length;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(() =>
        preparePrivateDirectory(
          join(privateRoot, "missing-parent", `run-${attempt}`),
          options
        )
      ).toThrow("PRIVATE_ANCESTOR_UNAVAILABLE");
    }
    const after = readdirSync("/proc/self/fd").length;
    expect(after).toBeLessThanOrEqual(before + 2);
  });

  it("运行目录改名后 handle 仍锚定原目录 inode", () => {
    const originalPath = join(privateRoot, "anchored-run");
    const movedPath = join(privateRoot, "moved-run");
    const handle = preparePrivateDirectory(originalPath, options);
    renameSync(originalPath, movedPath);
    mkdirSync(originalPath, { mode: 0o700 });

    writeFileSync(anchoredPrivatePath(handle, "proof.txt"), "anchored\n", {
      mode: 0o600
    });
    expect(readFileSync(join(movedPath, "proof.txt"), "utf8")).toBe(
      "anchored\n"
    );
    expect(existsSync(join(originalPath, "proof.txt"))).toBe(false);
    closePrivateDirectory(handle);
  });

  it("只读取私有根内 0600 的普通 env 文件", () => {
    const envPath = join(privateRoot, "fermata.env");
    writeFileSync(envPath, "EVAL_CONCURRENCY=2\n", { mode: 0o600 });
    expect(readProtectedEnvFile(envPath, options)).toBe(
      "EVAL_CONCURRENCY=2\n"
    );

    chmodSync(envPath, 0o644);
    expect(() => readProtectedEnvFile(envPath, options)).toThrow(
      "ENV_FILE_INVALID_MODE"
    );

    chmodSync(envPath, 0o400);
    expect(() => readProtectedEnvFile(envPath, options)).toThrow(
      "ENV_FILE_INVALID_MODE"
    );

    chmodSync(envPath, 0o640);
    expect(() => readProtectedEnvFile(envPath, options)).toThrow(
      "ENV_FILE_INVALID_MODE"
    );
  });

  it("拒绝有额外硬链接的 env 文件", () => {
    const envPath = join(privateRoot, "fermata.env");
    const aliasPath = join(privateRoot, "fermata-alias.env");
    writeFileSync(envPath, "EVAL_CONCURRENCY=2\n", { mode: 0o600 });
    linkSync(envPath, aliasPath);
    expect(() => readProtectedEnvFile(envPath, options)).toThrow(
      "ENV_FILE_INVALID_LINK"
    );
  });

  it("拒绝 env 符号链接和超限文件", () => {
    const envPath = join(privateRoot, "source.env");
    writeFileSync(envPath, "SAFE=1\n", { mode: 0o600 });
    const linked = join(privateRoot, "linked.env");
    symlinkSync(envPath, linked);
    expect(() => readProtectedEnvFile(linked, options)).toThrow(
      "ENV_FILE_INVALID_TYPE"
    );
    expect(() =>
      readProtectedEnvFile(envPath, { ...options, maximumBytes: 1 })
    ).toThrow("ENV_FILE_TOO_LARGE");
    expect(readFileSync(envPath, "utf8")).toBe("SAFE=1\n");
  });

  it("拒绝不是严格 UTF-8 的 env 文件", () => {
    const envPath = join(privateRoot, "invalid-utf8.env");
    writeFileSync(envPath, Buffer.from([0xff, 0xfe]), { mode: 0o600 });
    expect(() => readProtectedEnvFile(envPath, options)).toThrow(
      "ENV_FILE_INVALID_UTF8"
    );
  });
});
