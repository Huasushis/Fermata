#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  executeDevelopmentSmokePhase0,
  preflightDevelopmentSmoke
} from "./lib/development-smoke-launcher";

const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const projectRoot = realpathSync(resolve(repositoryRoot, ".."));
const manifestPath = resolve(repositoryRoot, "private/development-smoke-6x4-v1/manifest.private.json");

export interface DevelopmentSmokeCliOptions {
  readonly networkPhase0: boolean;
  readonly resumeRunId?: string;
}

export function parseDevelopmentSmokeCli(argv: readonly string[]): DevelopmentSmokeCliOptions {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--preflight")) {
    return Object.freeze({ networkPhase0: false });
  }
  if (argv[0] !== "--network-phase0" || argv.length > 2) {
    throw new Error("DEVELOPMENT_SMOKE_ARGUMENTS_INVALID");
  }
  const resume = argv[1];
  if (resume === undefined) return Object.freeze({ networkPhase0: true });
  const match = /^--resume=([a-f0-9]{64})$/u.exec(resume);
  if (match === null) throw new Error("DEVELOPMENT_SMOKE_ARGUMENTS_INVALID");
  return Object.freeze({ networkPhase0: true, resumeRunId: match[1] });
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
  if (options.networkPhase0 && !trackedWorktreeClean) {
    throw new Error("DEVELOPMENT_SMOKE_TRACKED_WORKTREE_NOT_CLEAN");
  }
  const preflight = preflightDevelopmentSmoke({
    repositoryRoot,
    projectRoot,
    manifestPath,
    codeVersion,
    env
  });
  if (!options.networkPhase0) {
    process.stdout.write(`${JSON.stringify({
      status: trackedWorktreeClean ? "GO-PHASE0" : "NO-GO-TRACKED-WORKTREE-DIRTY",
      networkCalls: 0,
      ...preflight.safeSummary,
      manifestFingerprintPrefix: preflight.safeSummary.manifestFingerprint.slice(0, 12)
    })}\n`);
    return trackedWorktreeClean ? 0 : 1;
  }
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
