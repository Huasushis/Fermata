import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertOfficialNodeChecksumDocument,
  assertReviewFlowNodeArchiveBytes,
  assertReviewFlowRuntimeCommitIdentity,
  assertReviewFlowRuntimeWorkingBytes,
  buildReviewFlowRuntimeGitEnvironment,
  buildFreshDependencyIdentity,
  normalizeReviewFlowEsbuildBinary,
  parseReviewFlowRuntimeSourceDocuments,
  reviewFlowRuntimeFreshInstallArguments
} from "../scripts/verify-review-flow-runtime-manifest.mjs";

const projectCacheRoot = fileURLToPath(new URL("../../.cache", import.meta.url));
const manifestBytes = readFileSync(
  new URL("../config/review-flow-runtime.json", import.meta.url)
);
const lockBytes = readFileSync(new URL("../package-lock.json", import.meta.url));
const temporaryDirectories = [];

beforeAll(() => {
  mkdirSync(projectCacheRoot, { recursive: true, mode: 0o700 });
  chmodSync(projectCacheRoot, 0o700);
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function cloneDocument(bytes) {
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

function sourceDocuments(manifest, lock) {
  return parseReviewFlowRuntimeSourceDocuments(
    Buffer.from(JSON.stringify(manifest)),
    Buffer.from(JSON.stringify(lock))
  );
}

describe("review-flow runtime manifest 独立来源复核", () => {
  it("固定 Git 子进程的 HOME 与全部临时目录都留在受保护运行根", () => {
    const environment = buildReviewFlowRuntimeGitEnvironment({
      HOME: "/private/root/home",
      TEMP: "/private/root/tmp",
      TMP: "/private/root/tmp",
      TMPDIR: "/private/root/tmp",
      TZ: "UTC"
    });
    expect(environment).toMatchObject({
      HOME: "/private/root/home",
      TEMP: "/private/root/tmp",
      TMP: "/private/root/tmp",
      TMPDIR: "/private/root/tmp",
      TZ: "UTC"
    });
  });

  it("正式 manifest 的 Node 官方归档与五个 npm source binding 全部可独立解析", () => {
    const parsed = parseReviewFlowRuntimeSourceDocuments(
      manifestBytes,
      lockBytes
    );
    expect(parsed.manifest.runtime.packages.map((entry) => entry.name)).toEqual([
      "tsx",
      "esbuild",
      "@esbuild/linux-x64",
      "undici",
      "zod"
    ]);
    expect(parsed.manifest.runtime.node.source.archiveUrl).toBe(
      "https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz"
    );
  });

  it.each([
    "missing_integrity",
    "non_official_resolved",
    "lock_version_mismatch",
    "node_source_mismatch"
  ])("来源绑定被篡改时固定失败：%s", (kind) => {
    const manifest = cloneDocument(manifestBytes);
    const lock = cloneDocument(lockBytes);
    const package_ = manifest.runtime.packages[0];
    const locked = lock.packages[`node_modules/${package_.name}`];
    if (kind === "missing_integrity") delete package_.integrity;
    if (kind === "non_official_resolved") {
      package_.resolved = "https://mirror.invalid/package.tgz";
      locked.resolved = package_.resolved;
    }
    if (kind === "lock_version_mismatch") locked.version = "0.0.0";
    if (kind === "node_source_mismatch") {
      manifest.runtime.node.source.archiveUrl =
        "https://nodejs.org/dist/v24.18.0/other.tar.xz";
    }
    expect(() => sourceDocuments(manifest, lock)).toThrow(
      "REVIEW_FLOW_RUNTIME_MANIFEST_VERIFICATION_FAILED"
    );
  });

  it("Node 归档必须逐字节匹配已跟踪官方 SHA-256", () => {
    const node = {
      source: {
        archiveSha256: createHash("sha256").update("official").digest("hex")
      }
    };
    expect(() => assertReviewFlowNodeArchiveBytes(
      node,
      Buffer.from("official")
    )).not.toThrow();
    expect(() => assertReviewFlowNodeArchiveBytes(
      node,
      Buffer.from("changed")
    )).toThrow("REVIEW_FLOW_RUNTIME_MANIFEST_VERIFICATION_FAILED");
  });

  it("manifest 的 Node 摘要必须同时出现在 fresh 官方 SHASUMS256", () => {
    const node = cloneDocument(manifestBytes).runtime.node;
    const archiveName = node.source.archiveUrl.split("/").at(-1);
    expect(() => assertOfficialNodeChecksumDocument(
      node,
      Buffer.from(`${node.source.archiveSha256}  ${archiveName}\n`)
    )).not.toThrow();
    expect(() => assertOfficialNodeChecksumDocument(
      node,
      Buffer.from(`${"0".repeat(64)}  ${archiveName}\n`)
    )).toThrow("REVIEW_FLOW_RUNTIME_MANIFEST_VERIFICATION_FAILED");
  });

  it("verifier 的 source 文件必须与 HEAD 原始字节一致", () => {
    expect(() => assertReviewFlowRuntimeWorkingBytes(
      Buffer.from("tracked"),
      Buffer.from("tracked")
    )).not.toThrow();
    expect(() => assertReviewFlowRuntimeWorkingBytes(
      Buffer.from("working tamper"),
      Buffer.from("tracked")
    )).toThrow("REVIEW_FLOW_RUNTIME_MANIFEST_VERIFICATION_FAILED");
  });

  it("一次复核只允许绑定同一个非零 Git 提交对象", () => {
    const identity = {
      topLevel: "/trusted/repository",
      commit: "1".repeat(40)
    };
    expect(() => assertReviewFlowRuntimeCommitIdentity(
      identity,
      { ...identity }
    )).not.toThrow();
    expect(() => assertReviewFlowRuntimeCommitIdentity(
      identity,
      { ...identity, commit: "2".repeat(40) }
    )).toThrow("REVIEW_FLOW_RUNTIME_MANIFEST_VERIFICATION_FAILED");
    expect(() => assertReviewFlowRuntimeCommitIdentity(
      { ...identity, commit: "0".repeat(40) },
      { ...identity, commit: "0".repeat(40) }
    )).toThrow("REVIEW_FLOW_RUNTIME_MANIFEST_VERIFICATION_FAILED");
  });

  it("fresh install 永久禁用 lifecycle，esbuild 映射只复制已验证平台 binary", () => {
    expect(reviewFlowRuntimeFreshInstallArguments).toContain("--ignore-scripts");
    const root = mkdtempSync(join(projectCacheRoot, "fermata-runtime-map-"));
    temporaryDirectories.push(root);
    const source = join(
      root,
      "node_modules/@esbuild/linux-x64/bin/esbuild"
    );
    const destination = join(root, "node_modules/esbuild/bin/esbuild");
    mkdirSync(dirname(source), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(source, Buffer.from("\u007fELFsynthetic-binary"), {
      mode: 0o700
    });
    writeFileSync(destination, "#!/usr/bin/env node\n", { mode: 0o700 });
    normalizeReviewFlowEsbuildBinary(root);
    expect(readFileSync(destination)).toEqual(readFileSync(source));

    expect(() => normalizeReviewFlowEsbuildBinary(root)).toThrow(
      "REVIEW_FLOW_RUNTIME_MANIFEST_VERIFICATION_FAILED"
    );
  });

  it("同一 fresh 文件树产生确定的 package/bundle proposal", () => {
    const root = mkdtempSync(join(projectCacheRoot, "fermata-runtime-tree-"));
    temporaryDirectories.push(root);
    const manifest = cloneDocument(manifestBytes);
    for (const [index, package_] of manifest.runtime.packages.entries()) {
      const packageRoot = join(root, "node_modules", ...package_.name.split("/"));
      mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(packageRoot, "package.json"),
        `${JSON.stringify({ name: package_.name, version: package_.version })}\n`,
        { mode: 0o600 }
      );
      writeFileSync(join(packageRoot, "index.js"), `export default ${index};\n`, {
        mode: 0o600
      });
    }
    const first = buildFreshDependencyIdentity(root, manifest);
    const second = buildFreshDependencyIdentity(root, manifest);
    expect(second).toEqual(first);
    expect(first.dependencyFileCount).toBe(10);
  });
});
