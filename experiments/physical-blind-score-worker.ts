import { existsSync, readFileSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { assertPhysicalBlindPredictionScorable } from "./lib/physical-blind-score";
import { physicalBlindProfileNameSchema } from "./lib/physical-blind-profiles";

const allowedEnvironment = new Set(["PATH", "PWD"]);

async function main(): Promise<void> {
  assertMinimalEnvironment();
  assertParentEnvironmentInvisible();
  assertProjectPrivateRootInvisible();
  const mode = process.argv[2];
  const canaryPort = parseCanaryPort(process.argv[3]);
  await assertNetworkNamespaceIsolated(canaryPort);
  if (mode === "preflight") {
    console.log(JSON.stringify({
      schemaVersion: 1,
      sandboxVerified: true,
      environmentKeyCount: Object.keys(process.env).length,
      networkCanaryBlocked: true,
      parentEnvironmentInvisible: true,
      projectPrivateRootInvisible: true
    }));
    return;
  }
  if (mode !== "score") {
    throw fixedError("BLIND_SCORE_WORKER_ARGUMENT_INVALID");
  }
  assertGoldUnavailableDuringQualification();
  const profileName = physicalBlindProfileNameSchema.safeParse(process.argv[4]);
  if (!profileName.success) {
    throw fixedError("BLIND_CLI_PROFILE_INVALID");
  }
  // 必须先验证 content + prediction completion 资格；当前固定失败，因而绝不打开 gold。
  assertPhysicalBlindPredictionScorable({
    contentDocument: readFileSync("/input/content.v1.json", "utf8"),
    predictionDocument: readFileSync("/input/predictions.v1.json", "utf8"),
    profileName: profileName.data
  });
}

function assertGoldUnavailableDuringQualification(): void {
  if (existsSync("/input/gold.v1.json")) {
    throw fixedError("BLIND_SCORE_WORKER_GOLD_VISIBLE_BEFORE_QUALIFICATION");
  }
}

function assertProjectPrivateRootInvisible(): void {
  if (
    existsSync("/app/private") ||
    existsSync("/home/ubuntu/codex-urmotiv/Fermata/private")
  ) {
    throw fixedError("BLIND_SCORE_WORKER_PRIVATE_ROOT_VISIBLE");
  }
}

function assertParentEnvironmentInvisible(): void {
  for (const name of readdirSync("/proc")) {
    if (!/^[1-9][0-9]*$/.test(name)) {
      continue;
    }
    try {
      const environment = readFileSync(`/proc/${name}/environ`);
      if (
        environment.includes(
          Buffer.from("PHYSICAL_BLIND_SANDBOX_PARENT_SENTINEL=", "utf8")
        )
      ) {
        throw fixedError("BLIND_SCORE_WORKER_PARENT_ENVIRONMENT_VISIBLE");
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "BLIND_SCORE_WORKER_PARENT_ENVIRONMENT_VISIBLE"
      ) {
        throw error;
      }
      // 其它同 namespace 进程可能禁止读取 environ；不可读不构成泄漏。
    }
  }
}

function assertMinimalEnvironment(): void {
  const keys = Object.keys(process.env);
  if (
    keys.some((key) => !allowedEnvironment.has(key)) ||
    process.env.PATH !== "/runtime" ||
    process.env.PWD !== "/app"
  ) {
    throw fixedError("BLIND_SCORE_WORKER_ENVIRONMENT_INVALID");
  }
}

function parseCanaryPort(raw: string | undefined): number {
  if (raw === undefined || !/^[1-9][0-9]{0,4}$/.test(raw)) {
    throw fixedError("BLIND_SCORE_WORKER_ARGUMENT_INVALID");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 65_535) {
    throw fixedError("BLIND_SCORE_WORKER_ARGUMENT_INVALID");
  }
  return value;
}

async function assertNetworkNamespaceIsolated(port: number): Promise<void> {
  const connected = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
  if (connected) {
    throw fixedError("BLIND_SCORE_WORKER_NETWORK_AVAILABLE");
  }
}

function fixedError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code });
}

try {
  await main();
} catch (error) {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,160}$/.test(error.code)
      ? error.code
      : "BLIND_SCORE_WORKER_FAILED";
  console.error(code);
  process.exitCode = 1;
}
