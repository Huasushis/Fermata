import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  loadReviewFlowRuntimeAttestation,
  reviewFlowRuntimeAttestationEnvironmentKey
} from "../experiments/lib/review-flow-runtime-attestation";
import {
  assertReviewFlowRuntimeSourceBindings,
  buildReviewFlowSnapshotChildEnvironment,
  parseReviewFlowRuntimeManifest,
  parseReviewFlowChildProtocolOutput,
  reviewFlowModuleBoundaryGuardSource,
  isReviewFlowChildProtocolPrefix,
  runReviewFlowSnapshotChild,
  verifyReviewFlowOriginFiles,
  verifyReviewFlowRuntimeDependencyBundle
} from "../scripts/review-flow-evaluation-bootstrap.mjs";

const projectCacheRoot = fileURLToPath(new URL("../../.cache", import.meta.url));
const bootstrapPath = fileURLToPath(
  new URL("../scripts/review-flow-evaluation-bootstrap.mjs", import.meta.url)
);
const fixtures = [];

beforeAll(() => {
  mkdirSync(projectCacheRoot, { recursive: true, mode: 0o700 });
  chmodSync(projectCacheRoot, 0o700);
});

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function runtimeDigest(files) {
  const digest = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.path.localeCompare(right.path))) {
    const pathBytes = Buffer.from(file.path, "utf8");
    digest.update(String(pathBytes.byteLength));
    digest.update(":");
    digest.update(pathBytes);
    digest.update("\0");
    digest.update(file.executable ? "1" : "0");
    digest.update(":");
    digest.update(String(file.bytes.byteLength));
    digest.update(":");
    digest.update(file.bytes);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function createRuntimeFixture() {
  const root = mkdtempSync(join(projectCacheRoot, "fermata-runtime-bootstrap-"));
  fixtures.push(root);
  chmodSync(root, 0o700);
  const packageSpecs = [
    ["tsx", "4.23.1"],
    ["esbuild", "0.28.1"],
    ["@esbuild/linux-x64", "0.28.1"],
    ["undici", "8.9.0"],
    ["zod", "4.4.3"]
  ];
  const files = packageSpecs.flatMap(([name, version], index) => [
    {
      path: `node_modules/${name}/index.js`,
      bytes: Buffer.from(`export const value = ${index + 1};\n`),
      executable: false
    },
    {
      path: `node_modules/${name}/package.json`,
      bytes: Buffer.from(`${JSON.stringify({ name, version })}\n`),
      executable: false
    }
  ]);
  for (const file of files) {
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, file.bytes, { mode: 0o600 });
  }
  const byteLength = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  const sha256 = runtimeDigest(files);
  const manifest = {
    schemaVersion: 1,
    runnerPath: "experiments/eval-review-flow.ts",
    codePaths: [
      "config/review-flow-runtime.json",
      "experiments/eval-review-flow.ts",
      "experiments/lib/review-flow-runtime-attestation.ts",
      "package-lock.json",
      "package.json",
      "scripts/env-file.mjs",
      "scripts/private-runtime.mjs",
      "scripts/review-flow-evaluation-bootstrap.mjs",
      "scripts/run-with-env.mjs",
      "scripts/trusted-git-state.mjs"
    ],
    productionCodePaths: ["experiments/eval-review-flow.ts"],
    runtime: {
      node: {
        version: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        sha256: "a".repeat(64),
        byteLength: 1,
        source: {
          archiveUrl:
            `https://nodejs.org/dist/v${process.versions.node}/` +
            `node-v${process.versions.node}-${process.platform}-${process.arch}.tar.xz`,
          archiveSha256: "b".repeat(64),
          archiveExecutablePath:
            `node-v${process.versions.node}-${process.platform}-${process.arch}/bin/node`
        }
      },
      dependencyBundleSha256: sha256,
      dependencyFileCount: files.length,
      dependencyByteLength: byteLength,
      packages: packageSpecs.map(([name, version]) => {
        const packageFiles = files.filter((file) =>
          file.path.startsWith(`node_modules/${name}/`));
        return {
          name,
          version,
          resolved:
            `https://registry.npmjs.org/${name}/-/` +
            `${name.split("/").at(-1)}-${version}.tgz`,
          integrity: `sha512-${"A".repeat(86)}==`,
          sha256: runtimeDigest(packageFiles),
          fileCount: packageFiles.length,
          byteLength: packageFiles.reduce(
            (sum, file) => sum + file.bytes.byteLength,
            0
          )
        };
      })
    }
  };
  return {
    root,
    files,
    manifest,
    manifestBytes: Buffer.from(`${JSON.stringify(manifest)}\n`)
  };
}

function createChildSnapshotFixture({
  runnerSource,
  includeLoader = true,
  containingRoot,
  runnerName = "synthetic-runner.mjs"
}) {
  const parent = containingRoot ?? mkdtempSync(
    join(projectCacheRoot, "fermata-runtime-child-parent-")
  );
  if (containingRoot === undefined) fixtures.push(parent);
  chmodSync(parent, 0o700);
  const directory = join(parent, "snapshot");
  mkdirSync(directory, { mode: 0o700 });
  const runtimeHomeDirectory = join(directory, "runtime/home");
  const runtimeTemporaryDirectory = join(directory, "runtime/tmp");
  mkdirSync(runtimeHomeDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(runtimeTemporaryDirectory, { recursive: true, mode: 0o700 });
  const moduleGuardPath = join(directory, "runtime/module-boundary-guard.mjs");
  writeFileSync(moduleGuardPath, reviewFlowModuleBoundaryGuardSource, {
    mode: 0o600
  });
  const loaderPath = join(directory, "runtime/synthetic-loader.mjs");
  if (includeLoader) writeFileSync(loaderPath, "", { mode: 0o600 });
  const runnerPath = join(directory, runnerName);
  writeFileSync(runnerPath, runnerSource, { mode: 0o600 });
  return {
    directory,
    nodePath: process.execPath,
    moduleGuardPath,
    loaderPath,
    runnerPath,
    runtimeHomeDirectory,
    runtimeTemporaryDirectory,
    repositoryDirectory: join(parent, "origin-repository-marker"),
    workspaceDirectory: join(parent, "origin-workspace-marker"),
    codeIdentity: { codeVersion: "a".repeat(40) },
    runtimeIdentity: { trustModel: "synthetic-only" }
  };
}

async function waitForPath(path, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("SYNTHETIC_MARKER_TIMEOUT");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function waitForChild(child) {
  return await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
}

describe("review-flow 可信运行时 bootstrap", () => {
  it("bootstrap 在身份确认前只加载 Node 内置模块和两份已跟踪启动信任根", () => {
    const source = readFileSync(bootstrapPath, "utf8");
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/gu)]
      .map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.every((specifier) =>
      specifier.startsWith("node:") ||
      specifier === "./private-runtime.mjs" ||
      specifier === "./trusted-git-state.mjs"
    )).toBe(true);
    expect(source).not.toMatch(/from\s+["'](?:tsx|zod|undici)/u);
    expect(source).not.toContain("experiments/eval-review-flow.ts\";");
  });

  it("严格 manifest 与实际依赖逐文件字节完全一致时通过", () => {
    const fixture = createRuntimeFixture();
    expect(parseReviewFlowRuntimeManifest(fixture.manifestBytes)).toMatchObject({
      schemaVersion: 1,
      runnerPath: "experiments/eval-review-flow.ts"
    });
    expect(verifyReviewFlowRuntimeDependencyBundle({
      repositoryDirectory: fixture.root,
      manifestBytes: fixture.manifestBytes
    })).toMatchObject({
      dependencyFileCount: 10,
      packages: expect.arrayContaining([
        expect.objectContaining({ name: "undici", version: "8.9.0" })
      ])
    });
  });

  it("离线语义核对 HEAD lock 中五个运行包的官方来源与完整性", () => {
    const fixture = createRuntimeFixture();
    const packages = Object.fromEntries(
      fixture.manifest.runtime.packages.map((package_) => [
        `node_modules/${package_.name}`,
        {
          version: package_.version,
          resolved: package_.resolved,
          integrity: package_.integrity
        }
      ])
    );
    expect(() => assertReviewFlowRuntimeSourceBindings(
      fixture.manifest,
      Buffer.from(JSON.stringify({ lockfileVersion: 3, packages }))
    )).not.toThrow();

    const first = fixture.manifest.runtime.packages[0];
    packages[`node_modules/${first.name}`] = {
      version: first.version,
      resolved: first.resolved,
      integrity: `sha512-${"B".repeat(86)}==`
    };
    expect(() => assertReviewFlowRuntimeSourceBindings(
      fixture.manifest,
      Buffer.from(JSON.stringify({ lockfileVersion: 3, packages }))
    )).toThrow("REVIEW_FLOW_RUNTIME_BOOTSTRAP_FAILED");
  });

  it("ignored node_modules 即使版本字符串不变，任一字节变化也失败关闭", () => {
    const fixture = createRuntimeFixture();
    writeFileSync(
      join(fixture.root, "node_modules/tsx/index.js"),
      "export const value = 2;\n",
      { mode: 0o600 }
    );
    expect(() => verifyReviewFlowRuntimeDependencyBundle({
      repositoryDirectory: fixture.root,
      manifestBytes: fixture.manifestBytes
    })).toThrow("REVIEW_FLOW_RUNTIME_BOOTSTRAP_FAILED");
  });

  it("包级声明和 bundle 声明超过全局上限时在遍历前失败关闭", () => {
    const fixture = createRuntimeFixture();
    const document = JSON.parse(fixture.manifestBytes.toString("utf8"));
    document.runtime.packages[0].fileCount = 4_097;
    document.runtime.dependencyFileCount = document.runtime.packages.reduce(
      (sum, package_) => sum + package_.fileCount,
      0
    );
    expect(() => parseReviewFlowRuntimeManifest(
      Buffer.from(JSON.stringify(document))
    )).toThrow("REVIEW_FLOW_RUNTIME_BOOTSTRAP_FAILED");
  });

  it("包内文件在读取前超过登记总字节就失败，不会先载入超大内容", () => {
    const fixture = createRuntimeFixture();
    const document = JSON.parse(fixture.manifestBytes.toString("utf8"));
    const expected = document.runtime.packages.find(
      (package_) => package_.name === "tsx"
    );
    const oversizedPath = join(
      fixture.root,
      "node_modules/tsx/00-oversized-synthetic.bin"
    );
    writeFileSync(oversizedPath, "", { mode: 0o600 });
    truncateSync(oversizedPath, expected.byteLength + 1);
    expect(() => verifyReviewFlowRuntimeDependencyBundle({
      repositoryDirectory: fixture.root,
      manifestBytes: fixture.manifestBytes
    })).toThrow("REVIEW_FLOW_RUNTIME_BOOTSTRAP_FAILED");
  });

  it("包内文件数量一超过登记值就立即失败关闭", () => {
    const fixture = createRuntimeFixture();
    writeFileSync(
      join(fixture.root, "node_modules/tsx/00-extra-synthetic.js"),
      "",
      { mode: 0o600 }
    );
    expect(() => verifyReviewFlowRuntimeDependencyBundle({
      repositoryDirectory: fixture.root,
      manifestBytes: fixture.manifestBytes
    })).toThrow("REVIEW_FLOW_RUNTIME_BOOTSTRAP_FAILED");
  });

  it("manifest 不能漏掉 bootstrap、trusted Git 或把生产清单指向全集之外", () => {
    const fixture = createRuntimeFixture();
    const document = JSON.parse(fixture.manifestBytes.toString("utf8"));
    document.codePaths = document.codePaths.filter(
      (path) => path !== "scripts/review-flow-evaluation-bootstrap.mjs"
    );
    expect(() => parseReviewFlowRuntimeManifest(
      Buffer.from(JSON.stringify(document))
    )).toThrow("REVIEW_FLOW_RUNTIME_BOOTSTRAP_FAILED");
  });

  it("评测子进程的 HOME 与所有临时目录固定到项目内快照", () => {
    const fixture = createRuntimeFixture();
    const home = join(fixture.root, "snapshot/runtime/home");
    const temporary = join(fixture.root, "snapshot/runtime/tmp");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    const environment = buildReviewFlowSnapshotChildEnvironment(
      {
        runtimeHomeDirectory: home,
        runtimeTemporaryDirectory: temporary
      },
      {
        HOME: "/outside/home",
        TEMP: "/tmp",
        TMP: "/tmp",
        TMPDIR: "/tmp",
        AETHER_API_KEY: "synthetic-only"
      },
      "{\"schemaVersion\":1}"
    );
    expect(environment).toMatchObject({
      HOME: home,
      TEMP: temporary,
      TMP: temporary,
      TMPDIR: temporary,
      AETHER_API_KEY: "synthetic-only",
      FERMATA_REVIEW_FLOW_RUNTIME_ATTESTATION: "{\"schemaVersion\":1}"
    });
  });

  it("tracked 源码读取后即使原字节写回，stat 身份变化也会失败关闭", () => {
    const fixture = createRuntimeFixture();
    const path = join(fixture.root, "tracked-source.mjs");
    const bytes = Buffer.from("export const synthetic = true;\n");
    writeFileSync(path, bytes, { mode: 0o600 });
    const originSnapshot = statSync(path, { bigint: true });
    writeFileSync(path, "export const synthetic = false;\n", { mode: 0o600 });
    const replacement = join(fixture.root, "tracked-source-replacement.mjs");
    writeFileSync(replacement, bytes, { mode: 0o600 });
    renameSync(replacement, path);
    expect(() => verifyReviewFlowOriginFiles([{
      originPath: path,
      originSnapshot,
      bytes
    }])).toThrow("REVIEW_FLOW_RUNTIME_BOOTSTRAP_FAILED");
  });

  it("只把 runner 的严格完成行转换为不含 label 的安全 JSON 协议", () => {
    const safe = parseReviewFlowChildProtocolOutput(
      Buffer.from(
        "11 角色 development 实验已私有封存：标签 synthetic-label，完成 2/3，完整=否，可用资格=否。\n"
      ),
      Buffer.alloc(0)
    );
    expect(safe).toBe(
      "FERMATA_REVIEW_FLOW_RESULT " +
      '{"schemaVersion":1,"event":"development_report_published","completed":2,"expected":3,"complete":false,"scored":true,"eligible":false}\n'
    );
    expect(safe).not.toContain("synthetic-label");
    expect(() => parseReviewFlowChildProtocolOutput(
      Buffer.from(
        "11 角色 development 实验已私有封存：标签 synthetic-label，完成 2/3，完整=否，可用资格=否。\n/private/path-marker\n"
      ),
      Buffer.alloc(0)
    )).toThrow("REVIEW_FLOW_RUNTIME_BOOTSTRAP_FAILED");
    expect(() => parseReviewFlowChildProtocolOutput(
      Buffer.from(
        "11 角色 development 实验已私有封存：标签 synthetic，完成 3/2，完整=否，可用资格=否。\n"
      ),
      Buffer.alloc(0)
    )).toThrow("REVIEW_FLOW_RUNTIME_BOOTSTRAP_FAILED");
    expect(() => parseReviewFlowChildProtocolOutput(
      Buffer.from(
        "11 角色 development 实验已私有封存：标签 synthetic，完成 1/2，完整=是，可用资格=否。\n"
      ),
      Buffer.alloc(0)
    )).toThrow("REVIEW_FLOW_RUNTIME_BOOTSTRAP_FAILED");
    expect(() => parseReviewFlowChildProtocolOutput(
      Buffer.from(
        "holdout 已一次性揭盲并私有封存基线、候选和对比报告：0 个样本，报告完整=是，可用资格=否。\n"
      ),
      Buffer.alloc(0)
    )).toThrow("REVIEW_FLOW_RUNTIME_BOOTSTRAP_FAILED");
  });

  it("stdout 增量检查只接受四种协议语言的可能前缀", () => {
    expect(isReviewFlowChildProtocolPrefix("11 角色 deve")).toBe(true);
    expect(isReviewFlowChildProtocolPrefix(
      "11 角色 development 实验已私有封存：标签 safe_1，完成 1/"
    )).toBe(true);
    expect(isReviewFlowChildProtocolPrefix(
      "11 角色 development 实验已私有封存：标签 .bad"
    )).toBe(false);
    expect(isReviewFlowChildProtocolPrefix("private model output")).toBe(false);
  });

  it("Node/loader 入口失败的 stderr 被捕获，只向调用方返回固定错误", async () => {
    const snapshot = createChildSnapshotFixture({
      includeLoader: false,
      runnerSource:
        'process.stdout.write("11 角色 development 实验已私有封存：标签 synthetic，完成 1/1，完整=是，可用资格=否。\\n");\n'
    });
    let caught;
    try {
      await runReviewFlowSnapshotChild(snapshot, [], {});
    } catch (error) {
      caught = String(error);
    }
    expect(caught).toBe("Error: REVIEW_FLOW_RUNTIME_BOOTSTRAP_FAILED");
    expect(caught).not.toContain(snapshot.directory);
    expect(caught).not.toContain(snapshot.repositoryDirectory);
  });

  it.each([
    ["stderr 首块", 'process.stderr.write("synthetic stderr marker");\n'],
    ["stdout 超限", 'process.stdout.write("x".repeat(9000));\n']
  ])("%s 会关新工作闸门但等待已在途步骤自然完成", async (_name, trigger) => {
    const parent = mkdtempSync(join(projectCacheRoot, "fermata-delayed-child-"));
    fixtures.push(parent);
    chmodSync(parent, 0o700);
    const marker = join(parent, "delayed-completion.json");
    const snapshot = createChildSnapshotFixture({
      containingRoot: parent,
      runnerSource:
        'import { writeFileSync } from "node:fs";\n' +
        `const marker = ${JSON.stringify(marker)};\n` +
        "let gateClosed = false;\n" +
        "let newWorkStarted = false;\n" +
        "process.on(\"SIGTERM\", () => {\n" +
        "  gateClosed = true;\n" +
        "  setTimeout(() => { if (!gateClosed) newWorkStarted = true; }, 20);\n" +
        "});\n" +
        "setTimeout(() => {\n" +
        "  writeFileSync(marker, JSON.stringify({ inFlightCompleted: true, gateClosed, newWorkStarted }));\n" +
        "}, 140);\n" +
        trigger
    });
    const startedAt = Date.now();
    await expect(runReviewFlowSnapshotChild(snapshot, [], {})).rejects.toThrow(
      "REVIEW_FLOW_RUNTIME_BOOTSTRAP_FAILED"
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(110);
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({
      inFlightCompleted: true,
      gateClosed: true,
      newWorkStarted: false
    });
  });

  it("只向 bootstrap PID 发信号也会幂等转发并等待直接 runner 收口", async () => {
    const parent = mkdtempSync(join(projectCacheRoot, "fermata-bootstrap-signal-"));
    fixtures.push(parent);
    chmodSync(parent, 0o700);
    const ready = join(parent, "runner-ready");
    const completed = join(parent, "runner-completed.json");
    const helperCompleted = join(parent, "bootstrap-completed");
    const snapshot = createChildSnapshotFixture({
      containingRoot: parent,
      runnerSource:
        'import { writeFileSync } from "node:fs";\n' +
        `writeFileSync(${JSON.stringify(ready)}, "ready");\n` +
        "let gateClosed = false;\n" +
        "process.on(\"SIGTERM\", () => { gateClosed = true; });\n" +
        "setTimeout(() => {\n" +
        `  writeFileSync(${JSON.stringify(completed)}, JSON.stringify({ gateClosed, inFlightCompleted: true }));\n` +
        '  process.stdout.write("11 角色 development 实验已私有封存：标签 synthetic，完成 1/1，完整=是，可用资格=否。\\n");\n' +
        "}, 260);\n"
    });
    const helperPath = join(parent, "bootstrap-helper.mjs");
    writeFileSync(
      helperPath,
      `import { writeFileSync } from "node:fs";\n` +
      `import { createReviewFlowBootstrapSignalController, installReviewFlowBootstrapSignalHandlers, runReviewFlowSnapshotChild } from ${JSON.stringify(new URL(`file://${bootstrapPath}`).href)};\n` +
      `const snapshot = ${JSON.stringify(snapshot)};\n` +
      "const controller = createReviewFlowBootstrapSignalController();\n" +
      "const remove = installReviewFlowBootstrapSignalHandlers(controller);\n" +
      "try { await runReviewFlowSnapshotChild(snapshot, [], {}, controller); } catch {}\n" +
      "remove();\n" +
      `writeFileSync(${JSON.stringify(helperCompleted)}, "done");\n`,
      { mode: 0o600 }
    );
    const helper = spawn(process.execPath, [helperPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    await waitForPath(ready);
    process.kill(helper.pid, "SIGTERM");
    process.kill(helper.pid, "SIGTERM");
    expect(await waitForChild(helper)).toEqual({ code: 0, signal: null });
    expect(JSON.parse(readFileSync(completed, "utf8"))).toEqual({
      gateClosed: true,
      inFlightCompleted: true
    });
    expect(readFileSync(helperCompleted, "utf8")).toBe("done");
  });

  it("只向 run-with-env 外层 PID 发信号也只转发一次并等待 child 收口", async () => {
    const parent = mkdtempSync(join(projectCacheRoot, "fermata-wrapper-signal-"));
    fixtures.push(parent);
    chmodSync(parent, 0o700);
    const ready = join(parent, "wrapper-child-ready");
    const completed = join(parent, "wrapper-child-completed.json");
    const helperCompleted = join(parent, "wrapper-completed");
    const childPath = join(parent, "wrapper-child.mjs");
    writeFileSync(
      childPath,
      `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(ready)}, "ready");\n` +
      "let signalCount = 0;\n" +
      "process.on(\"SIGTERM\", () => { signalCount += 1; });\n" +
      "setTimeout(() => {\n" +
      `  writeFileSync(${JSON.stringify(completed)}, JSON.stringify({ signalCount, inFlightCompleted: true }));\n` +
      "}, 260);\n",
      { mode: 0o600 }
    );
    const helperPath = join(parent, "wrapper-helper.mjs");
    const runWithEnvModuleUrl = new URL(
      "../scripts/run-with-env.mjs",
      import.meta.url
    ).href;
    writeFileSync(
      helperPath,
      `import { spawn } from "node:child_process";\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `import { createRunWithEnvSignalController, installRunWithEnvSignalHandlers } from ${JSON.stringify(runWithEnvModuleUrl)};\n` +
      "const controller = createRunWithEnvSignalController();\n" +
      "const remove = installRunWithEnvSignalHandlers(controller);\n" +
      `const child = spawn(process.execPath, [${JSON.stringify(childPath)}], { stdio: ["ignore", "pipe", "pipe"] });\n` +
      "controller.attach(child);\n" +
      "await new Promise((resolve) => child.once(\"close\", resolve));\n" +
      "remove();\n" +
      `writeFileSync(${JSON.stringify(helperCompleted)}, "done");\n`,
      { mode: 0o600 }
    );
    const helper = spawn(process.execPath, [helperPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    await waitForPath(ready);
    process.kill(helper.pid, "SIGTERM");
    process.kill(helper.pid, "SIGTERM");
    expect(await waitForChild(helper)).toEqual({ code: 0, signal: null });
    expect(JSON.parse(readFileSync(completed, "utf8"))).toEqual({
      signalCount: 1,
      inFlightCompleted: true
    });
    expect(readFileSync(helperCompleted, "utf8")).toBe("done");
  });

  it("真实 tsx loader 与 snapshot 内 bare package 可在模块边界内正常运行", async () => {
    const snapshot = createChildSnapshotFixture({
      runnerName: "synthetic-runner.ts",
      runnerSource:
        'import { z } from "zod";\n' +
        "const completed: number = z.number().parse(1);\n" +
        'process.stdout.write(`11 角色 development 实验已私有封存：标签 synthetic，完成 ${completed}/1，完整=是，可用资格=否。\\n`);\n'
    });
    for (const packageName of [
      "tsx",
      "esbuild",
      "@esbuild/linux-x64",
      "zod"
    ]) {
      const source = fileURLToPath(
        new URL(`../node_modules/${packageName}/`, import.meta.url)
      );
      const destination = join(snapshot.directory, "node_modules", packageName);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      cpSync(source, destination, { recursive: true, preserveTimestamps: true });
    }
    snapshot.loaderPath = join(
      snapshot.directory,
      "node_modules/tsx/dist/loader.mjs"
    );
    await expect(runReviewFlowSnapshotChild(snapshot, [], {})).resolves.toBe(
      "FERMATA_REVIEW_FLOW_RESULT " +
      '{"schemaVersion":1,"event":"development_report_published","completed":1,"expected":1,"complete":true,"scored":true,"eligible":false}\n'
    );
  });

  it("只存在于 snapshot 父目录的 bare package 不能被动态 import", async () => {
    const parent = mkdtempSync(join(projectCacheRoot, "fermata-module-parent-"));
    fixtures.push(parent);
    chmodSync(parent, 0o700);
    const packageRoot = join(parent, "node_modules/synthetic-parent-only");
    mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "synthetic-parent-only",
        type: "module",
        exports: "./index.mjs"
      }),
      { mode: 0o600 }
    );
    writeFileSync(
      join(packageRoot, "index.mjs"),
      "export const escaped = true;\n",
      { mode: 0o600 }
    );
    const snapshot = createChildSnapshotFixture({
      containingRoot: parent,
      runnerSource:
        'await import("synthetic-parent-only");\n' +
        'process.stdout.write("11 角色 development 实验已私有封存：标签 synthetic，完成 1/1，完整=是，可用资格=否。\\n");\n'
    });
    let caught;
    try {
      await runReviewFlowSnapshotChild(snapshot, [], {});
    } catch (error) {
      caught = String(error);
    }
    expect(caught).toBe("Error: REVIEW_FLOW_RUNTIME_BOOTSTRAP_FAILED");
    expect(caught).not.toContain(packageRoot);
    expect(caught).not.toContain(snapshot.directory);
  });

  it("TS 入口读取后立即清除 bootstrap attestation 环境变量", () => {
    const environment = {
      EVAL_CODE_VERSION: "a".repeat(40),
      [reviewFlowRuntimeAttestationEnvironmentKey]: "{}"
    };
    expect(() => loadReviewFlowRuntimeAttestation({
      environment,
      currentRepositoryRoot: projectCacheRoot,
      currentExecutable: process.execPath
    })).toThrow("REVIEW_FLOW_RUNTIME_ATTESTATION_INVALID");
    expect(environment).not.toHaveProperty(
      reviewFlowRuntimeAttestationEnvironmentKey
    );
  });
});
