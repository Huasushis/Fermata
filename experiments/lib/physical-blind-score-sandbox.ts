import { existsSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  failPhysicalBlind,
  parsePhysicalBlindJson,
  parseVersionedStrictArtifact
} from "./physical-blind-common";
import type { PrivateArtifactSnapshotDescriptor } from "./private-artifact-io";
import { z } from "zod";

const preflightSchema = z
  .object({
    schemaVersion: z.literal(1),
    sandboxVerified: z.literal(true),
    environmentKeyCount: z.literal(2),
    networkCanaryBlocked: z.literal(true),
    parentEnvironmentInvisible: z.literal(true),
    projectPrivateRootInvisible: z.literal(true)
  })
  .strict();
const repositoryRoot = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../..")
);

export interface PhysicalBlindScoreSandboxPreflight {
  readonly schemaVersion: 1;
  readonly sandboxVerified: true;
  readonly environmentKeyCount: 2;
  readonly networkCanaryBlocked: true;
  readonly parentEnvironmentInvisible: true;
  readonly projectPrivateRootInvisible: true;
}

export async function verifyPhysicalBlindScoreSandbox(): Promise<
  PhysicalBlindScoreSandboxPreflight
> {
  return withNetworkCanary(async (port, acceptedConnection) => {
    const result = await runSandboxProcess({
      workerArguments: ["preflight", String(port)],
      snapshots: []
    });
    if (acceptedConnection()) {
      failPhysicalBlind("BLIND_SCORE_SANDBOX_NETWORK_ISOLATION_FAILED");
    }
    if (result.exitCode !== 0) {
      failPhysicalBlind("BLIND_SCORE_SANDBOX_UNAVAILABLE");
    }
    return parseVersionedStrictArtifact({
      value: parsePhysicalBlindJson(result.stdout),
      schema: preflightSchema
    });
  });
}

export async function runPhysicalBlindScoreSandbox(input: {
  readonly content: PrivateArtifactSnapshotDescriptor;
  readonly predictions: PrivateArtifactSnapshotDescriptor;
  readonly profileName: "difficulty" | "levels" | "verdict";
}): Promise<never> {
  return withNetworkCanary(async (port, acceptedConnection) => {
    const result = await runSandboxProcess({
      workerArguments: ["score", String(port), input.profileName],
      snapshots: [
        { snapshot: input.content, sandboxFileName: "content.v1.json" },
        { snapshot: input.predictions, sandboxFileName: "predictions.v1.json" }
      ]
    });
    if (acceptedConnection()) {
      failPhysicalBlind("BLIND_SCORE_SANDBOX_NETWORK_ISOLATION_FAILED");
    }
    const code = result.stderr.trim();
    if (result.exitCode !== 0 && /^[A-Z0-9_]{1,160}$/.test(code)) {
      failPhysicalBlind(code);
    }
    failPhysicalBlind("BLIND_SCORE_WORKER_PROTOCOL_INVALID");
  });
}

async function runSandboxProcess(input: {
  readonly workerArguments: readonly string[];
  readonly snapshots: readonly {
    readonly snapshot: PrivateArtifactSnapshotDescriptor;
    readonly sandboxFileName: "content.v1.json" | "predictions.v1.json";
  }[];
}): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const bubblewrap = "/usr/bin/bwrap";
  if (!existsSync(bubblewrap)) {
    failPhysicalBlind("BLIND_SCORE_SANDBOX_UNAVAILABLE");
  }
  const nodeBinary = realpathSync(process.execPath);
  const worker = join(repositoryRoot, "experiments", "physical-blind-score-worker.ts");
  const argumentsList = [
    "--die-with-parent",
    "--new-session",
    "--unshare-net",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--clearenv",
    "--setenv",
    "PATH",
    "/runtime",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/lib",
    "/lib",
    ...(existsSync("/lib64") ? ["--ro-bind", "/lib64", "/lib64"] : []),
    "--dir",
    "/runtime",
    "--ro-bind",
    nodeBinary,
    "/runtime/node",
    "--dir",
    "/app",
    "--dir",
    "/app/experiments",
    "--ro-bind",
    join(repositoryRoot, "experiments", "lib"),
    "/app/experiments/lib",
    "--ro-bind",
    worker,
    "/app/experiments/physical-blind-score-worker.ts",
    "--ro-bind",
    join(repositoryRoot, "src"),
    "/app/src",
    "--dir",
    "/app/node_modules",
    "--ro-bind",
    join(repositoryRoot, "node_modules", "tsx"),
    "/app/node_modules/tsx",
    "--ro-bind",
    join(repositoryRoot, "node_modules", "zod"),
    "/app/node_modules/zod",
    "--ro-bind",
    join(repositoryRoot, "node_modules", "esbuild"),
    "/app/node_modules/esbuild",
    "--dir",
    "/app/node_modules/@esbuild",
    "--ro-bind",
    join(repositoryRoot, "node_modules", "@esbuild", "linux-x64"),
    "/app/node_modules/@esbuild/linux-x64",
    "--ro-bind",
    join(repositoryRoot, "package.json"),
    "/app/package.json",
    "--dir",
    "/input",
    ...input.snapshots.flatMap((entry, index) => [
      "--perms",
      "0400",
      "--ro-bind-data",
      String(index + 3),
      `/input/${entry.sandboxFileName}`
    ]),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--chdir",
    "/app",
    "/runtime/node",
    "--no-warnings",
    "--permission",
    "--allow-fs-read=/app",
    "--allow-fs-read=/APP",
    "--allow-fs-read=/runtime",
    "--allow-fs-read=/usr",
    "--allow-fs-read=/lib",
    "--allow-fs-read=/lib64",
    "--allow-fs-read=/proc",
    "--allow-fs-read=/dev",
    "--allow-fs-read=/tmp",
    "--allow-fs-read=/input",
    "--allow-fs-read=/home/ubuntu/codex-urmotiv/Fermata/private",
    "--allow-fs-write=/tmp",
    "--allow-worker",
    "--import",
    "tsx",
    "/app/experiments/physical-blind-score-worker.ts",
    ...input.workerArguments
  ];
  const stdio: ("ignore" | "pipe" | number)[] = ["ignore", "pipe", "pipe"];
  for (const entry of input.snapshots) {
    stdio.push(entry.snapshot.descriptor);
  }
  return new Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>((resolvePromise, rejectPromise) => {
    const child = spawn(bubblewrap, argumentsList, {
      cwd: repositoryRoot,
      env: {},
      shell: false,
      stdio
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const collect = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > 1024 * 1024) {
        overflow = true;
        child.kill("SIGKILL");
      }
      return next;
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = collect(stderr, chunk);
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.once("error", () => {
      clearTimeout(timeout);
      rejectPromise(new Error("BLIND_SCORE_SANDBOX_UNAVAILABLE"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (overflow || code === null) {
        rejectPromise(new Error("BLIND_SCORE_WORKER_PROTOCOL_INVALID"));
        return;
      }
      resolvePromise({ exitCode: code, stdout, stderr });
    });
  }).catch(() => failPhysicalBlind("BLIND_SCORE_SANDBOX_UNAVAILABLE"));
}

async function withNetworkCanary<T>(
  operation: (
    port: number,
    acceptedConnection: () => boolean
  ) => Promise<T>
): Promise<T> {
  let accepted = false;
  const server = createServer((socket) => {
    accepted = true;
    socket.destroy();
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  }).catch(() => failPhysicalBlind("BLIND_SCORE_SANDBOX_CANARY_FAILED"));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      failPhysicalBlind("BLIND_SCORE_SANDBOX_CANARY_FAILED");
    }
    return await operation(address.port, () => accepted);
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
}
