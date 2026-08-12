#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  executeDevelopmentSmokePhase0,
  executeDevelopmentSmokePhase1,
  preflightDevelopmentSmoke,
  preflightDevelopmentSmokePhase1
} from "./lib/development-smoke-launcher";

const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const projectRoot = realpathSync(resolve(repositoryRoot, ".."));
const manifestPath = resolve(repositoryRoot, "private/development-smoke-6x4-v1/manifest.private.json");

export type DevelopmentSmokeCliOptions =
  | Readonly<{ mode: "preflight" }>
  | Readonly<{ mode: "phase1-preflight"; resumeRunId: string }>
  | Readonly<{ mode: "network-phase0"; resumeRunId?: string }>
  | Readonly<{
      mode: "network-phase1";
      resumeRunId: string;
      releaseAuthorized: true;
    }>;

export function parseDevelopmentSmokeCli(
  argv: readonly string[]
): DevelopmentSmokeCliOptions {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--preflight")) {
    return Object.freeze({ mode: "preflight" });
  }
  const resumeValues = argv.flatMap((value) => {
    const match = /^--resume=([a-f0-9]{64})$/u.exec(value);
    return match === null ? [] : [match[1]!];
  });
  const modes = [
    argv.includes("--preflight-phase1") ? "phase1-preflight" : null,
    argv.includes("--network-phase0") ? "network-phase0" : null,
    argv.includes("--network-phase1") ? "network-phase1" : null
  ].filter((mode): mode is Exclude<DevelopmentSmokeCliOptions["mode"], "preflight"> =>
    mode !== null
  );
  const releaseAuthorized = argv.includes("--release-phase1");
  const known = new Set([
    "--preflight-phase1",
    "--network-phase0",
    "--network-phase1",
    "--release-phase1"
  ]);
  if (
    modes.length !== 1 ||
    resumeValues.length > 1 ||
    argv.some((value) =>
      !known.has(value) && !/^--resume=[a-f0-9]{64}$/u.test(value)
    )
  ) {
    throw new Error("DEVELOPMENT_SMOKE_ARGUMENTS_INVALID");
  }
  const mode = modes[0]!;
  const resumeRunId = resumeValues[0];
  if (mode === "network-phase0") {
    if (releaseAuthorized || argv.length !== 1 + (resumeRunId === undefined ? 0 : 1)) {
      throw new Error("DEVELOPMENT_SMOKE_ARGUMENTS_INVALID");
    }
    return Object.freeze({ mode, resumeRunId });
  }
  if (
    resumeRunId === undefined ||
    (mode === "phase1-preflight" && (releaseAuthorized || argv.length !== 2)) ||
    (mode === "network-phase1" && (!releaseAuthorized || argv.length !== 3))
  ) {
    throw new Error("DEVELOPMENT_SMOKE_ARGUMENTS_INVALID");
  }
  return mode === "phase1-preflight"
    ? Object.freeze({ mode, resumeRunId })
    : Object.freeze({ mode, resumeRunId, releaseAuthorized: true as const });
}

export async function runDevelopmentSmokeCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const options = parseDevelopmentSmokeCli(argv);
  if (Number.parseInt(process.versions.node.split(".")[0]!, 10) !== 24) {
    throw new Error("DEVELOPMENT_SMOKE_NODE_24_REQUIRED");
  }
  const codeVersion = gitOutput(["rev-parse", "HEAD"]);
  const trackedWorktreeClean =
    gitOutput(["status", "--porcelain", "--untracked-files=no"]) === "";
  if (options.mode !== "preflight" && !trackedWorktreeClean) {
    throw new Error("DEVELOPMENT_SMOKE_TRACKED_WORKTREE_NOT_CLEAN");
  }
  const preflight = preflightDevelopmentSmoke({
    repositoryRoot,
    projectRoot,
    manifestPath,
    codeVersion,
    env
  });
  if (options.mode === "preflight") {
    process.stdout.write(`${JSON.stringify({
      status: trackedWorktreeClean ? "GO-PHASE0" : "NO-GO-TRACKED-WORKTREE-DIRTY",
      networkCalls: 0,
      ...preflight.safeSummary,
      manifestFingerprintPrefix: preflight.safeSummary.manifestFingerprint.slice(0, 12)
    })}\n`);
    return trackedWorktreeClean ? 0 : 1;
  }
  if (options.mode === "phase1-preflight") {
    const result = preflightDevelopmentSmokePhase1({
      preflight,
      resumeRunId: options.resumeRunId
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  if (options.mode === "network-phase0") {
    const result = await executeDevelopmentSmokePhase0({
      preflight,
      resumeRunId: options.resumeRunId
    });
    process.stdout.write(`${JSON.stringify({
      status: result.state === "phase0_complete" ? "PHASE0-COMPLETE" : "INCOMPLETE",
      requestCount: result.requestCount,
      runBindingPrefix: result.runId.slice(0, 12),
      accuracyClaim: null,
      includedInFinalCalibration: false,
      phase1Released: false
    })}\n`);
    return result.state === "phase0_complete" ? 0 : 1;
  }
  const result = await executeDevelopmentSmokePhase1({
    preflight,
    resumeRunId: options.resumeRunId,
    releaseAuthorized: options.releaseAuthorized
  });
  process.stdout.write(`${JSON.stringify({
    status: result.state === "complete" ? "PHASE1-COMPLETE" : "INCOMPLETE",
    phase0RequestCount: result.phase0RequestCount,
    phase1RequestCount: result.phase1RequestCount,
    requestCount: result.requestCount,
    runBindingPrefix: result.runId.slice(0, 12),
    metrics: result.metrics,
    accuracyClaim: null,
    includedInFinalCalibration: false,
    phase1Released: true
  })}\n`);
  return result.state === "complete" ? 0 : 1;
}

function gitOutput(args: readonly string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    throw new Error("DEVELOPMENT_SMOKE_GIT_STATE_INVALID");
  }
}

function isDirectEntry(): boolean {
  return process.argv[1] !== undefined &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectEntry()) {
  runDevelopmentSmokeCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    () => {
      process.stderr.write("development smoke 启动前检查失败；未发起请求。\n");
      process.exitCode = 2;
    }
  );
}
