import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireDevelopmentDiagnosticRunLock,
  applyDevelopmentDiagnosticRunEvent,
  developmentDiagnosticRunLockPath,
  developmentDiagnosticRunStatePath,
  isDevelopmentDiagnosticTemporaryFile,
  parseDevelopmentDiagnosticRunState,
  transitionDevelopmentDiagnosticRunState,
  writeDevelopmentDiagnosticRunStateAtomic,
  type DevelopmentDiagnosticRunIdentity
} from "../experiments/lib/development-diagnostic-run-state";
import {
  assertDevelopmentDiagnosticCliOwner,
  developmentDiagnosticPlanFingerprint,
  buildDevelopmentDiagnosticSafePlan,
  developmentDiagnosticStateIdentityFingerprint,
  parseDevelopmentDiagnosticCliArguments,
  runDevelopmentDiagnosticCli,
  type DevelopmentDiagnosticCliOwnerIdentity,
  type DevelopmentDiagnosticCliRuntime,
  type DevelopmentDiagnosticSafePlan,
  type DevelopmentDiagnosticCliSignal,
  type DevelopmentDiagnosticHistorySample
} from "../experiments/run-development-diagnostic";
import {
  chatCompleteWithReceipt,
  LlmRequestError,
  withLlmRequestStartGate,
  type ModelCallSpec,
  type ProviderCredentialsLike
} from "../src/llm";
import {
  createDevelopmentDiagnosticScheduler,
  DevelopmentDiagnosticRunController,
  developmentDiagnosticProfile,
  developmentDiagnosticProfileFingerprint
} from "../src/review-flow/development-diagnostic";
import {
  legacyDevelopmentDiagnosticPlannedRunContract
} from "../src/review-flow/development-diagnostic-run-contract";

const roots: string[] = [];
const fingerprint = (label: string): string =>
  createHash("sha256").update(label, "utf8").digest("hex");
const diagnosticRoles = [
  "solver",
  "solution_analyst",
  "technical_auditor",
  "difficulty",
  "editorial_judge",
  "contest_fit",
  "originality",
  "tags",
  "critic",
  "adversary",
  "adjudicator"
] as const;
const diagnosticStages = ["A", "B", "C", "D"] as const;

async function emitCompleteMockRun(
  context: Parameters<NonNullable<DevelopmentDiagnosticCliRuntime["paidExecution"]>>[0]
): Promise<{ readonly complete: true }> {
  context.registerSoftStop(() => undefined);
  const requestRoles = [
    "solver",
    "solver",
    ...diagnosticRoles.filter((role) => role !== "solver")
  ] as const;
  let nextSequence = 1;
  const requests = context.plannedRun.selectedSlots.flatMap(() => requestRoles);
  for (
    let offset = 0;
    offset < requests.length;
    offset += context.plannedRun.maximumConcurrency
  ) {
    await Promise.all(
      requests
        .slice(offset, offset + context.plannedRun.maximumConcurrency)
        .map(async (role) => {
          const sequence = nextSequence;
          nextSequence += 1;
          await context.lifecycleSink({
            type: "transport_intent",
            sequence,
            role,
            modelFingerprint: fingerprint(`model:${role}`),
            attempt: 1
          });
          await context.lifecycleSink({
            type: "transport_reserved",
            sequence,
            role,
            modelFingerprint: fingerprint(`model:${role}`),
            attempt: 1
          });
          await context.lifecycleSink({ type: "transport_started", sequence });
          await fetch("https://mock.invalid/diagnostic");
          await context.lifecycleSink({ type: "transport_first_output", sequence });
          await context.lifecycleSink({
            type: "transport_settled",
            sequence,
            outcome: "succeeded",
            errorCategory: null
          });
        })
    );
  }
  for (const slot of context.plannedRun.selectedSlots) {
    for (const role of diagnosticRoles) {
      await context.lifecycleSink({ type: "role_completed", slot, role });
    }
    for (const stage of diagnosticStages) {
      await context.lifecycleSink({ type: "stage_completed", slot, stage });
    }
    await context.lifecycleSink({ type: "slot_outcome", slot, status: "complete" });
  }
  return { complete: true };
}
async function emitRetryCompleteMockRun(
  context: Parameters<NonNullable<DevelopmentDiagnosticCliRuntime["paidExecution"]>>[0]
): Promise<{ readonly complete: true }> {
  context.registerSoftStop(() => undefined);
  const requestRoles = [
    "solver",
    "solver",
    ...diagnosticRoles.filter((role) => role !== "solver")
  ] as const;
  let sequence = 0;
  for (const [requestIndex, role] of requestRoles.entries()) {
    const attempts = requestIndex === 0 ? [1, 2] as const : [1] as const;
    for (const attempt of attempts) {
      sequence += 1;
      await context.lifecycleSink({
        type: "transport_intent",
        sequence,
        role,
        modelFingerprint: fingerprint(`model:${role}`),
        attempt
      });
      await context.lifecycleSink({
        type: "transport_reserved",
        sequence,
        role,
        modelFingerprint: fingerprint(`model:${role}`),
        attempt
      });
      await context.lifecycleSink({ type: "transport_started", sequence });
      await context.lifecycleSink({
        type: "transport_settled",
        sequence,
        outcome: requestIndex === 0 && attempt === 1
          ? "retryable_failed"
          : "succeeded",
        errorCategory: null
      });
    }
  }
  for (const role of diagnosticRoles) {
    await context.lifecycleSink({ type: "role_completed", slot: "slot-01", role });
  }
  for (const stage of diagnosticStages) {
    await context.lifecycleSink({ type: "stage_completed", slot: "slot-01", stage });
  }
  await context.lifecycleSink({ type: "slot_outcome", slot: "slot-01", status: "complete" });
  return { complete: true };
}

function createStateDirectoryPath(label = "state"): string {
  const root = mkdtempSync(join(tmpdir(), "fermata-diagnostic-cli-"));
  roots.push(root);
  return join(root, label);
}

function currentOwner(): DevelopmentDiagnosticCliOwnerIdentity {
  if (process.getuid === undefined || process.geteuid === undefined) {
    throw new Error("Linux ownership APIs unavailable");
  }
  const realUserId = process.getuid();
  return {
    realUserId,
    effectiveUserId: process.geteuid(),
    repositoryOwnerId: realUserId
  };
}

interface RuntimeHarness {
  readonly runtime: DevelopmentDiagnosticCliRuntime;
  readonly output: string[];
  readonly errors: string[];
  readonly getSignalHandler: () =>
    | ((signal: DevelopmentDiagnosticCliSignal) => void)
    | undefined;
}

function createRuntime(input: {
  readonly stateDirectory: string;
  readonly argv?: readonly string[];
  readonly stdinIsTTY?: boolean;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly ownerIdentity?: DevelopmentDiagnosticCliOwnerIdentity;
  readonly confirmationTimeoutMs?: number;
  readonly codeFingerprint?: string;
  readonly manifestFingerprint?: string;
  readonly authorityFingerprint?: string;
  readonly configurationFingerprint?: string;
  readonly readConfirmation?: DevelopmentDiagnosticCliRuntime["readConfirmation"];
  readonly onError?: (text: string) => void;
  readonly paidExecution?: DevelopmentDiagnosticCliRuntime["paidExecution"];
  readonly preflight?: DevelopmentDiagnosticCliRuntime["preflight"];
  readonly historySamples?: readonly DevelopmentDiagnosticHistorySample[];
  readonly writeStateAtomic?: DevelopmentDiagnosticCliRuntime["writeStateAtomic"];
}): RuntimeHarness {
  const output: string[] = [];
  const errors: string[] = [];
  let signalHandler: ((signal: DevelopmentDiagnosticCliSignal) => void) | undefined;
  return {
    runtime: {
      argv: input.argv ?? ["--state-dir", input.stateDirectory],
      environment: input.environment ?? { FERMATA_RUN_WITH_ENV: "1" },
      wrapperParentAttested: true,
      stdinIsTTY: input.stdinIsTTY ?? false,
      ownerIdentity: input.ownerIdentity ?? currentOwner(),
      codeFingerprint: input.codeFingerprint ?? fingerprint("code"),
      manifestFingerprint: input.manifestFingerprint ?? fingerprint("manifest"),
      authorityFingerprint: input.authorityFingerprint ?? fingerprint("authority"),
      configurationFingerprint:
        input.configurationFingerprint ?? fingerprint("configuration"),
      now: () => new Date("2026-08-13T06:50:00.000Z"),
      ...(input.confirmationTimeoutMs === undefined
        ? {}
        : { confirmationTimeoutMs: input.confirmationTimeoutMs }),
      writeOutput: (text) => output.push(text),
      writeError: (text) => {
        errors.push(text);
        input.onError?.(text);
      },
      readConfirmation: input.readConfirmation ?? (async () => null),
      installSignalHandlers: (handler) => {
        signalHandler = handler;
        return () => {
          signalHandler = undefined;
        };
      },
      ...(input.paidExecution === undefined ? {} : { paidExecution: input.paidExecution }),
      ...(input.preflight === undefined ? {} : { preflight: input.preflight }),
      ...(input.historySamples === undefined ? {} : { historySamples: input.historySamples }),
      ...(input.writeStateAtomic === undefined
        ? {}
        : { writeStateAtomic: input.writeStateAtomic })
    },
    output,
    errors,
    getSignalHandler: () => signalHandler
  };
}

function extractPlanFingerprint(output: readonly string[]): string {
  const document: unknown = JSON.parse(output[0] ?? "null");
  if (
    typeof document !== "object" ||
    document === null ||
    !("planFingerprint" in document) ||
    typeof document.planFingerprint !== "string"
  ) {
    throw new Error("plan fingerprint missing");
  }
  return document.planFingerprint;
}

function readPersistedPhase(stateDirectory: string): string {
  const document: unknown = JSON.parse(
    readFileSync(developmentDiagnosticRunStatePath(stateDirectory), "utf8")
  );
  if (
    typeof document !== "object" ||
    document === null ||
    !("phase" in document) ||
    typeof document.phase !== "string"
  ) {
    throw new Error("state phase missing");
  }
  return document.phase;
}

function temporaryStateNames(stateDirectory: string): readonly string[] {
  return readdirSync(stateDirectory).filter(isDevelopmentDiagnosticTemporaryFile);
}

function persistPhase(
  stateDirectory: string,
  phase: "authorized" | "running",
  withProgress = false
): void {
  let state = parseDevelopmentDiagnosticRunState(
    JSON.parse(readFileSync(developmentDiagnosticRunStatePath(stateDirectory), "utf8"))
  );
  if (state.phase === "planned") {
    state = transitionDevelopmentDiagnosticRunState(state, "authorized");
  }
  if (phase === "running") {
    state = transitionDevelopmentDiagnosticRunState(state, "running");
    if (withProgress) {
      state = applyDevelopmentDiagnosticRunEvent(state, {
        type: "transport_intent",
        roleFingerprint: fingerprint("recovery-role"),
        modelFingerprint: fingerprint("recovery-model"),
        attempt: 1,
        at: new Date("2026-08-13T06:55:00.000Z")
      });
    }
  }
  writeDevelopmentDiagnosticRunStateAtomic({ directoryPath: stateDirectory, state });
}

function leaveStaleLockFromChild(stateDirectory: string): void {
  const modulePath = "./experiments/lib/development-diagnostic-run-state.ts";
  const source = [
    `import { acquireDevelopmentDiagnosticRunLock } from ${JSON.stringify(modulePath)};`,
    `acquireDevelopmentDiagnosticRunLock({ directoryPath: ${JSON.stringify(stateDirectory)},`,
    `runId: "2cc0d504-d702-432e-8095-22128a32db11" });`
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "--eval", source],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  expect(child.status).toBe(0);
  expect(child.signal).toBeNull();
  expect(child.stderr).toBe("");
  expect(statSync(developmentDiagnosticRunLockPath(stateDirectory)).isFile()).toBe(true);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("strict CLI arguments and owner boundary", () => {
  it.each([
    { argv: [] },
    { argv: ["--unknown", "/tmp/x"] },
    { argv: ["--state-dir"] },
    { argv: ["--state-dir", "relative"] },
    { argv: ["--state-dir", "/tmp/a", "--state-dir", "/tmp/b"] },
    { argv: ["--authorize-plan", fingerprint("plan")] },
    { argv: ["--state-dir", "/tmp/a", "--authorize-plan", "short"] },
    { argv: ["--state-dir", "/tmp/a", "trailing"] }
  ] as const)("rejects unknown, duplicate, missing, or ambiguous argv: $argv", ({ argv }) => {
    expect(() => parseDevelopmentDiagnosticCliArguments(argv)).toThrow();
  });

  it("accepts one absolute state directory and one exact authorization digest", () => {
    expect(
      parseDevelopmentDiagnosticCliArguments([
        "--authorize-plan",
        fingerprint("plan"),
        "--state-dir",
        "/tmp/diagnostic-state"
      ])
    ).toEqual({
      stateDirectory: "/tmp/diagnostic-state",
      authorizationFingerprint: fingerprint("plan"),
      plannedRun: legacyDevelopmentDiagnosticPlannedRunContract
    });
  });
  it("parses and binds the controlled one-slot run contract", () => {
    const parsed = parseDevelopmentDiagnosticCliArguments([
      "--state-dir", "/tmp/diagnostic-state",
      "--slots", "slot-01",
      "--max-concurrency", "12",
      "--max-transport-attempts-per-request", "2",
      "--transport-attempt-ceiling", "16",
      "--phase-scheduling-budget-ms", "5400000",
      "--soft-stop-policy", "stop_new_and_drain_in_flight"
    ]);
    expect(parsed.plannedRun).toEqual({
      schemaVersion: 1,
      selectedSlots: ["slot-01"],
      expectedRequestsPerSlot: 12,
      maximumConcurrency: 12,
      maximumTransportAttemptsPerRequest: 2,
      globalTransportAttemptCeiling: 16,
      phaseSchedulingBudgetMs: 5_400_000,
      softStopPolicy: "stop_new_and_drain_in_flight"
    });
  });

  it.each([
    ["--slots", ""],
    ["--slots", "slot-01,slot-01"],
    ["--slots", "slot-02,slot-01"],
    ["--max-concurrency", "17"],
    ["--transport-attempt-ceiling", "11"],
    ["--max-transport-attempts-per-request", "2", "--transport-attempt-ceiling", "12"]
  ])("rejects invalid planned-run arguments: %s", (...runArguments) => {
    expect(() =>
      parseDevelopmentDiagnosticCliArguments([
        "--state-dir", "/tmp/diagnostic-state",
        ...runArguments
      ])
    ).toThrow();
  });

  it.each([
    {
      identity: { realUserId: 1000, effectiveUserId: 0, repositoryOwnerId: 1000 },
      environment: {}
    },
    {
      identity: { realUserId: 0, effectiveUserId: 0, repositoryOwnerId: 1000 },
      environment: {}
    },
    {
      identity: { realUserId: 1000, effectiveUserId: 1000, repositoryOwnerId: 1001 },
      environment: {}
    },
    {
      identity: { realUserId: 1000, effectiveUserId: 1000, repositoryOwnerId: 1000 },
      environment: { SUDO_UID: "1000" }
    }
  ])("rejects non-owner, setuid, root substitution, and sudo semantics", (input) => {
    expect(() => assertDevelopmentDiagnosticCliOwner(input)).toThrow();
  });

  it("allows root only when root is the real repository owner and sudo is absent", () => {
    expect(() =>
      assertDevelopmentDiagnosticCliOwner({
        identity: { realUserId: 0, effectiveUserId: 0, repositoryOwnerId: 0 },
        environment: {}
      })
    ).not.toThrow();
  });

  it("rejects direct execution without the controlled env wrapper marker", async () => {
    const harness = createRuntime({
      stateDirectory: createStateDirectoryPath(),
      environment: {}
    });
    await expect(runDevelopmentDiagnosticCli(harness.runtime)).resolves.toEqual({
      exitCode: 1,
      code: "SAFE_FAILURE"
    });
    expect(harness.errors).toEqual(["SAFE_FAILURE\n"]);
  });

  it("rejects a forged wrapper marker without parent attestation", async () => {
    const stateDirectory = createStateDirectoryPath();
    const harness = createRuntime({ stateDirectory });
    const runtime: DevelopmentDiagnosticCliRuntime = {
      ...harness.runtime,
      wrapperParentAttested: false
    };
    expect((await runDevelopmentDiagnosticCli(runtime)).code).toBe("SAFE_FAILURE");
  });
});

describe("safe plan and explicit confirmation", () => {
  it("persists planned and emits only the safe non-TTY plan", async () => {
    const privateSentinels = [
      "PRIVATE_PROBLEM_SENTINEL",
      "PRIVATE_SOLUTION_SENTINEL",
      "PRIVATE_CREDENTIAL_SENTINEL",
      "PRIVATE_RESPONSE_SENTINEL"
    ];
    const stateDirectory = createStateDirectoryPath(privateSentinels[0]);
    const harness = createRuntime({
      stateDirectory,
      environment: {
        FERMATA_RUN_WITH_ENV: "1",
        EVAL_DATASET_MANIFEST_PATH: privateSentinels[0],
        DASHSCOPE_API_KEY: privateSentinels[1],
        AETHER_API_KEY: privateSentinels[2],
        AETHER_BASE_URL: privateSentinels[3]
      }
    });
    const result = await runDevelopmentDiagnosticCli(harness.runtime);

    expect(result.code).toBe("PLAN_REQUIRES_AUTHORIZATION");
    expect(readPersistedPhase(stateDirectory)).toBe("planned");
    expect(statSync(stateDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(developmentDiagnosticRunStatePath(stateDirectory)).mode & 0o777).toBe(0o600);
    const completeOutput = [...harness.output, ...harness.errors].join("");
    for (const hiddenIdentityValue of [
      fingerprint("code"),
      fingerprint("manifest"),
      fingerprint("authority"),
      fingerprint("configuration"),
      developmentDiagnosticProfileFingerprint
    ]) {
      expect(completeOutput).not.toContain(hiddenIdentityValue);
    }
    for (const sentinel of privateSentinels) expect(completeOutput).not.toContain(sentinel);
    const planDocument = JSON.parse(harness.output[0] ?? "null") as {
      readonly plan: Readonly<Record<string, unknown>>;
    };
    expect(planDocument.plan).toMatchObject({
      slots: 2,
      expectedFetches: 24,
      maximumExternalAttempts: 52,
      maximumConcurrency: 4,
      softStopBudgetMs: 3_600_000,
      modelBindings: "configured",
      paidExecution: "wired"
    });
    expect(planDocument.plan.stateIdentityFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(planDocument.plan).not.toHaveProperty("runId");
    expect(planDocument.plan).not.toHaveProperty("stateDirectory");
  });

  it("binds every paid identity field and absolute state directory into authorization", async () => {
    const stateDirectory = createStateDirectoryPath("identity");
    const harness = createRuntime({ stateDirectory });
    await runDevelopmentDiagnosticCli(harness.runtime);
    const outputDocument = JSON.parse(harness.output[0] ?? "null") as {
      readonly plan: DevelopmentDiagnosticSafePlan;
    };
    const identity: DevelopmentDiagnosticRunIdentity = {
      runId: "c8d808e6-489d-47e8-948b-b0e03698e11a",
      codeFingerprint: fingerprint("code"),
      manifestFingerprint: fingerprint("manifest"),
      authorityFingerprint: fingerprint("authority"),
      configurationFingerprint: fingerprint("configuration"),
      profileFingerprint: developmentDiagnosticProfileFingerprint,
      profile: {
        ...developmentDiagnosticProfile,
        retryableHttpStatuses: [429]
      },
      plannedRun: legacyDevelopmentDiagnosticPlannedRunContract
    };
    const baseline = developmentDiagnosticStateIdentityFingerprint({
      absoluteStateDirectory: stateDirectory,
      identity
    });
    expect(baseline).toMatch(/^[0-9a-f]{64}$/u);
    const baselinePlan: DevelopmentDiagnosticSafePlan = {
      ...outputDocument.plan,
      stateIdentityFingerprint: baseline
    };
    const baselineAuthorization = developmentDiagnosticPlanFingerprint(baselinePlan);
    const variants: readonly unknown[] = [
      { ...identity, codeFingerprint: fingerprint("code-drift") },
      { ...identity, manifestFingerprint: fingerprint("manifest-drift") },
      { ...identity, authorityFingerprint: fingerprint("authority-drift") },
      { ...identity, configurationFingerprint: fingerprint("configuration-drift") },
      { ...identity, profileFingerprint: fingerprint("profile-drift") },
      {
        ...identity,
        profile: {
          ...identity.profile,
          anonymousSlotCount: 3
        }
      },
      {
        ...identity,
        profile: {
          ...identity.profile,
          softStopBudgetMs: identity.profile.softStopBudgetMs + 1
        }
      }
    ];
    for (const variant of variants) {
      const variantFingerprint = developmentDiagnosticStateIdentityFingerprint({
        absoluteStateDirectory: stateDirectory,
        identity: variant
      });
      expect(variantFingerprint).not.toBe(baseline);
      expect(
        developmentDiagnosticPlanFingerprint({
          ...baselinePlan,
          stateIdentityFingerprint: variantFingerprint
        })
      ).not.toBe(baselineAuthorization);
    }
    const pathFingerprint = developmentDiagnosticStateIdentityFingerprint({
      absoluteStateDirectory: createStateDirectoryPath("other-identity"),
      identity
    });
    expect(pathFingerprint).not.toBe(baseline);
    expect(
      developmentDiagnosticPlanFingerprint({
        ...baselinePlan,
        stateIdentityFingerprint: pathFingerprint
      })
    ).not.toBe(baselineAuthorization);
  });

  it("reports data-insufficient ETA or same-identity measured n/p50/p90 without raw samples", () => {
    const stateDirectory = createStateDirectoryPath("eta");
    const identity: DevelopmentDiagnosticRunIdentity = {
      runId: "86a88acf-7e96-4cc4-956a-028f32bc6f82",
      codeFingerprint: fingerprint("eta-code"),
      manifestFingerprint: fingerprint("eta-manifest"),
      authorityFingerprint: fingerprint("eta-authority"),
      configurationFingerprint: fingerprint("eta-configuration"),
      profileFingerprint: developmentDiagnosticProfileFingerprint,
      profile: {
        ...developmentDiagnosticProfile,
        retryableHttpStatuses: [429]
      },
      plannedRun: legacyDevelopmentDiagnosticPlannedRunContract
    };
    const noHistory = buildDevelopmentDiagnosticSafePlan({
      stateDirectory,
      ownerUserId: currentOwner().effectiveUserId,
      identity
    });
    expect(noHistory.eta).toEqual({
      status: "data_insufficient",
      successfulSampleCount: 0,
      remainingFetches: 24,
      softStopBudgetMs: 3_600_000
    });
    const stateIdentityFingerprint = developmentDiagnosticStateIdentityFingerprint({
      absoluteStateDirectory: stateDirectory,
      identity
    });
    const sample: DevelopmentDiagnosticHistorySample = {
      stateIdentityFingerprint,
      roleFingerprint: fingerprint("eta-role"),
      modelFingerprint: fingerprint("eta-model"),
      queuedAt: "2026-08-13T06:00:00.000Z",
      startAt: "2026-08-13T06:00:00.100Z",
      firstOutputAt: "2026-08-13T06:00:00.300Z",
      endAt: "2026-08-13T06:00:00.800Z",
      endToEndMs: 800,
      outcome: "succeeded"
    };
    const measured = buildDevelopmentDiagnosticSafePlan({
      stateDirectory,
      ownerUserId: currentOwner().effectiveUserId,
      identity,
      historySamples: [
        sample,
        { ...sample, stateIdentityFingerprint: fingerprint("different-identity") }
      ]
    });
    expect(measured.eta).toEqual({
      status: "estimated",
      successfulSampleCount: 1,
      p50Ms: 800,
      p90Ms: 800,
      remainingFetches: 24,
      formula: "max(remaining DAG critical path, sum remaining role p50 /4)",
      estimateMs: 4_800
    });
    expect(JSON.stringify(measured)).not.toContain(sample.roleFingerprint);
    expect(JSON.stringify(measured)).not.toContain(sample.modelFingerprint);
  });

  it.each([
    ["code", { codeFingerprint: fingerprint("code-drift") }],
    ["manifest", { manifestFingerprint: fingerprint("manifest-drift") }],
    ["authority", { authorityFingerprint: fingerprint("authority-drift") }],
    ["configuration", { configurationFingerprint: fingerprint("configuration-drift") }]
  ] as const)("rejects an old authorization after %s identity drift", async (_label, drift) => {
    const stateDirectory = createStateDirectoryPath();
    const first = createRuntime({ stateDirectory });
    await runDevelopmentDiagnosticCli(first.runtime);
    const oldAuthorization = extractPlanFingerprint(first.output);
    const drifted = createRuntime({
      stateDirectory,
      ...drift,
      argv: ["--state-dir", stateDirectory, "--authorize-plan", oldAuthorization]
    });
    expect((await runDevelopmentDiagnosticCli(drifted.runtime)).code).toBe("SAFE_FAILURE");
    expect(readPersistedPhase(stateDirectory)).toBe("planned");
  });

  it("rejects an old authorization token for a different absolute state directory", async () => {
    const firstDirectory = createStateDirectoryPath("first-path");
    const first = createRuntime({ stateDirectory: firstDirectory });
    await runDevelopmentDiagnosticCli(first.runtime);
    const oldAuthorization = extractPlanFingerprint(first.output);
    const secondDirectory = createStateDirectoryPath("second-path");
    const second = createRuntime({
      stateDirectory: secondDirectory,
      argv: ["--state-dir", secondDirectory, "--authorize-plan", oldAuthorization]
    });
    expect((await runDevelopmentDiagnosticCli(second.runtime)).code).toBe("SAFE_FAILURE");
    expect(readPersistedPhase(secondDirectory)).toBe("planned");
  });

  it("accepts the existing run-with-env filtered environment without exposing its secret", async () => {
    interface RunWithEnvModule {
      readonly runWithEnv: (
        argv: readonly string[],
        options: {
          readonly parentEnvironment: Readonly<NodeJS.ProcessEnv>;
          readonly readEnvFile: (path: string) => string;
          readonly spawnProcess: (
            command: string,
            arguments_: readonly string[],
            options: { readonly env?: NodeJS.ProcessEnv }
          ) => object;
        }
      ) => unknown;
    }
    // The wrapper's public .d.mts intentionally omits its generic test seam; this test loads
    // that runtime boundary explicitly and narrows it before exercising the filtered child env.
    const imported: unknown = await import("../scripts/run-with-env.mjs");
    if (
      typeof imported !== "object" ||
      imported === null ||
      !("runWithEnv" in imported) ||
      typeof imported.runWithEnv !== "function"
    ) {
      throw new Error("run-with-env API unavailable");
    }
    const runWithEnvModule = imported as RunWithEnvModule;
    const secret = "PRIVATE_WRAPPER_SECRET_SENTINEL";
    const stateDirectory = createStateDirectoryPath("wrapper");
    let childEnvironment: NodeJS.ProcessEnv | undefined;
    runWithEnvModule.runWithEnv(
      [
        "--development-diagnostic",
        "/tmp/diagnostic.env",
        "--state-dir",
        stateDirectory
      ],
      {
        parentEnvironment: {},
        readEnvFile: () =>
          `AETHER_BASE_URL=https://example.invalid\nAETHER_API_KEY=${secret}\n`,
        spawnProcess: (_command, _arguments, options) => {
          childEnvironment = options.env;
          return {};
        }
      }
    );
    if (childEnvironment === undefined) throw new Error("child environment missing");
    const harness = createRuntime({
      stateDirectory,
      environment: childEnvironment,
      paidExecution: async () => {
        throw new Error("poison paid runner called");
      }
    });
    expect((await runDevelopmentDiagnosticCli(harness.runtime)).code).toBe(
      "PLAN_REQUIRES_AUTHORIZATION"
    );
    expect([...harness.output, ...harness.errors].join("")).not.toContain(secret);
  });

  it("authorizes a prior non-TTY plan exactly once and enters the injected paid runner", async () => {
    const stateDirectory = createStateDirectoryPath();
    const plannedHarness = createRuntime({ stateDirectory });
    const planned = await runDevelopmentDiagnosticCli(plannedHarness.runtime);
    const planFingerprint = extractPlanFingerprint(plannedHarness.output);
    expect(planned.code).toBe("PLAN_REQUIRES_AUTHORIZATION");

    let paidCalls = 0;
    let fetchCalls = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCalls += 1;
      throw new Error("poison fetch called");
    });
    const authorizationHarness = createRuntime({
      stateDirectory,
      argv: ["--state-dir", stateDirectory, "--authorize-plan", planFingerprint],
      paidExecution: async () => {
        paidCalls += 1;
        throw new Error("injected runner failure");
      }
    });
    await expect(runDevelopmentDiagnosticCli(authorizationHarness.runtime)).resolves.toMatchObject({
      exitCode: 1,
      code: "INCOMPLETE",
      planFingerprint
    });
    expect(readPersistedPhase(stateDirectory)).toBe("incomplete");
    expect(paidCalls).toBe(1);
    expect(fetchCalls).toBe(0);
    const replayHarness = createRuntime({
      stateDirectory,
      argv: ["--state-dir", stateDirectory, "--authorize-plan", planFingerprint]
    });
    expect(fetchCalls).toBe(0);
    await expect(runDevelopmentDiagnosticCli(replayHarness.runtime)).resolves.toEqual({
      exitCode: 1,
      code: "SAFE_FAILURE"
    });
  });

  it("durably completes a deterministic 24-fetch run with peak concurrency four", async () => {
    const stateDirectory = createStateDirectoryPath("complete");
    const planned = createRuntime({ stateDirectory });
    await runDevelopmentDiagnosticCli(planned.runtime);
    const planFingerprint = extractPlanFingerprint(planned.output);
    let fetchCalls = 0;
    let activeFetches = 0;
    let peakFetches = 0;
    let pendingFetches: ((response: Response) => void)[] = [];
    vi.stubGlobal("fetch", () => {
      fetchCalls += 1;
      activeFetches += 1;
      peakFetches = Math.max(peakFetches, activeFetches);
      return new Promise<Response>((resolveFetch) => {
        pendingFetches.push(resolveFetch);
        if (pendingFetches.length === 4) {
          const batch = pendingFetches;
          pendingFetches = [];
          activeFetches -= batch.length;
          for (const resolvePending of batch) {
            resolvePending(new Response(null, { status: 204 }));
          }
        }
      });
    });
    const authorized = createRuntime({
      stateDirectory,
      argv: ["--state-dir", stateDirectory, "--authorize-plan", planFingerprint],
      paidExecution: emitCompleteMockRun
    });
    expect(await runDevelopmentDiagnosticCli(authorized.runtime)).toEqual({
      exitCode: 0,
      code: "COMPLETE",
      planFingerprint
    });
    expect(fetchCalls).toBe(24);
    expect(peakFetches).toBe(4);
    expect(readPersistedPhase(stateDirectory)).toBe("complete");
    expect(() => statSync(developmentDiagnosticRunLockPath(stateDirectory))).toThrow();
    const persisted = JSON.parse(
      readFileSync(developmentDiagnosticRunStatePath(stateDirectory), "utf8")
    ) as {
      readonly sequence: number;
      readonly transport: {
        readonly intended: number;
        readonly reserved: number;
        readonly started: number;
        readonly settled: number;
        readonly active: number;
        readonly queued: number;
        readonly terminalFailure: null;
      };
    };
    expect(persisted.sequence).toBeGreaterThan(0);
    expect(persisted.transport).toEqual({
      intended: 24,
      reserved: 24,

      started: 24,
      settled: 24,
      active: 0,
      queued: 0,
      terminalFailure: null
    });
  });
  it("authorizes and durably completes standalone slot-02 with a distinct token and clean lock", async () => {
    const slotOneDirectory = createStateDirectoryPath("slot-one");
    const slotTwoDirectory = createStateDirectoryPath("slot-two");
    const commonArguments = [
      "--max-concurrency", "12",
      "--max-transport-attempts-per-request", "2",
      "--transport-attempt-ceiling", "16",
      "--phase-scheduling-budget-ms", "5400000",
      "--soft-stop-policy", "stop_new_and_drain_in_flight"
    ] as const;
    const planOne = createRuntime({
      stateDirectory: slotOneDirectory,
      argv: ["--state-dir", slotOneDirectory, "--slots", "slot-01", ...commonArguments]
    });
    const planTwo = createRuntime({
      stateDirectory: slotTwoDirectory,
      argv: ["--state-dir", slotTwoDirectory, "--slots", "slot-02", ...commonArguments]
    });
    await runDevelopmentDiagnosticCli(planOne.runtime);
    await runDevelopmentDiagnosticCli(planTwo.runtime);
    const slotOneToken = extractPlanFingerprint(planOne.output);
    const slotTwoToken = extractPlanFingerprint(planTwo.output);
    expect(slotTwoToken).not.toBe(slotOneToken);
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    const authorized = createRuntime({
      stateDirectory: slotTwoDirectory,
      argv: [
        "--state-dir", slotTwoDirectory,
        "--slots", "slot-02",
        ...commonArguments,
        "--authorize-plan", slotTwoToken
      ],
      paidExecution: emitCompleteMockRun
    });
    expect(await runDevelopmentDiagnosticCli(authorized.runtime)).toEqual({
      exitCode: 0,
      code: "COMPLETE",
      planFingerprint: slotTwoToken
    });
    expect(readPersistedPhase(slotTwoDirectory)).toBe("complete");
    expect(() => statSync(developmentDiagnosticRunLockPath(slotTwoDirectory))).toThrow();
    const persisted = JSON.parse(
      readFileSync(developmentDiagnosticRunStatePath(slotTwoDirectory), "utf8")
    ) as {
      readonly identity: {
        readonly runId: string;
        readonly plannedRun: { readonly selectedSlots: readonly string[] };
      };
    };
    expect(persisted.identity.plannedRun.selectedSlots).toEqual(["slot-02"]);
    expect(persisted.identity.runId).not.toBe(slotOneToken);
  });
  it("emits only safe plan/progress fields and never content, secret, path, or raw error sentinels", async () => {
    const stateDirectory = createStateDirectoryPath("privacy-sentinel");
    const sensitive = {
      task: "PRIVATE_TASK_SENTINEL",
      answer: "PRIVATE_ANSWER_SENTINEL",
      secret: "PRIVATE_SECRET_SENTINEL",
      response: "PRIVATE_RESPONSE_SENTINEL",
      path: stateDirectory,
      error: "PRIVATE_ERROR_SENTINEL"
    };
    const planned = createRuntime({
      stateDirectory,
      environment: {
        FERMATA_RUN_WITH_ENV: "1",
        AETHER_API_KEY: sensitive.secret
      }
    });
    await runDevelopmentDiagnosticCli(planned.runtime);
    const planFingerprint = extractPlanFingerprint(planned.output);
    const authorized = createRuntime({
      stateDirectory,
      argv: ["--state-dir", stateDirectory, "--authorize-plan", planFingerprint],
      environment: {
        FERMATA_RUN_WITH_ENV: "1",
        AETHER_API_KEY: sensitive.secret
      },
      paidExecution: async (context) => {
        context.registerSoftStop(() => undefined);
        await context.lifecycleSink({
          type: "transport_intent",
          sequence: 1,
          role: "solver",
          modelFingerprint: fingerprint(JSON.stringify(sensitive)),
          attempt: 1
        });
        await context.lifecycleSink({
          type: "transport_reserved",
          sequence: 1,
          role: "solver",
          modelFingerprint: fingerprint(JSON.stringify(sensitive)),
          attempt: 1
        });
        return { complete: false, reason: "attempt_count_mismatch" };
      }
    });
    await runDevelopmentDiagnosticCli(authorized.runtime);
    const rendered = [...planned.output, ...authorized.output, ...authorized.errors].join("");
    for (const sentinel of Object.values(sensitive)) {
      expect(rendered).not.toContain(sentinel);
    }
    expect(rendered).toContain('"status":"data_insufficient"');
    expect(rendered).toContain('"counts"');
    expect(rendered).toContain('"latency"');
    expect(rendered).toContain('"throughputPerMinute"');
  });
  it("durably records a retryable attempt and cleans the single-slot lock", async () => {
    const stateDirectory = createStateDirectoryPath("retry-complete");
    const runArguments = [
      "--state-dir", stateDirectory,
      "--slots", "slot-01",
      "--max-concurrency", "12",
      "--max-transport-attempts-per-request", "2",
      "--transport-attempt-ceiling", "16",
      "--phase-scheduling-budget-ms", "5400000",
      "--soft-stop-policy", "stop_new_and_drain_in_flight"
    ] as const;
    const planned = createRuntime({ stateDirectory, argv: runArguments });
    await runDevelopmentDiagnosticCli(planned.runtime);
    const planFingerprint = extractPlanFingerprint(planned.output);
    const authorized = createRuntime({
      stateDirectory,
      argv: [...runArguments, "--authorize-plan", planFingerprint],
      paidExecution: emitRetryCompleteMockRun
    });
    expect(await runDevelopmentDiagnosticCli(authorized.runtime)).toEqual({
      exitCode: 0,
      code: "COMPLETE",
      planFingerprint
    });
    const persisted = JSON.parse(
      readFileSync(developmentDiagnosticRunStatePath(stateDirectory), "utf8")
    ) as {
      readonly phase: string;
      readonly attempts: readonly { readonly outcome: string }[];
      readonly transport: {
        readonly settled: number;
        readonly active: number;
        readonly queued: number;
      };
    };
    expect(persisted.phase).toBe("complete");
    expect(persisted.attempts).toHaveLength(13);
    expect(persisted.attempts.filter((attempt) =>
      attempt.outcome === "retryable_failed"
    )).toHaveLength(1);
    expect(persisted.transport).toMatchObject({
      settled: 13,
      active: 0,
      queued: 0
    });
    const progress = authorized.output
      .map((line) => JSON.parse(line) as {
        readonly event?: string;
        readonly kind?: string;
        readonly counts?: {
          readonly completed: number;
          readonly inFlight: number;
          readonly notStarted: number;
        };
        readonly eta?: { readonly remainingFetches?: number };
      })
      .filter((entry) =>
        entry.event === "development_diagnostic_progress" &&
        entry.kind === "transport_settled"
      );
    expect(progress[0]).toMatchObject({
      counts: { completed: 0, inFlight: 1, notStarted: 11 },
      eta: { remainingFetches: 12 }
    });
    expect(progress[1]).toMatchObject({
      counts: { completed: 1, inFlight: 0, notStarted: 11 },
      eta: { remainingFetches: 11 }
    });
    expect(() => statSync(developmentDiagnosticRunLockPath(stateDirectory))).toThrow();
  });

  it("performs zero fetches when real preflight fails before planning or paid execution", async () => {
    const stateDirectory = createStateDirectoryPath("preflight-failure");
    let paidCalls = 0;
    let fetchCalls = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCalls += 1;
      throw new Error("poison fetch");
    });
    const harness = createRuntime({
      stateDirectory,
      preflight: async () => {
        throw new Error("preflight rejected");
      },
      paidExecution: async () => {
        paidCalls += 1;
        return { complete: false };
      }
    });
    expect(await runDevelopmentDiagnosticCli(harness.runtime)).toEqual({
      exitCode: 1,
      code: "SAFE_FAILURE"
    });
    expect(paidCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(() => statSync(developmentDiagnosticRunStatePath(stateDirectory))).toThrow();
    expect(() => statSync(developmentDiagnosticRunLockPath(stateDirectory))).toThrow();
  });

  it("persists a deadline as incomplete with zero fetches", async () => {
    const stateDirectory = createStateDirectoryPath("deadline");
    const planned = createRuntime({ stateDirectory });
    await runDevelopmentDiagnosticCli(planned.runtime);
    const planFingerprint = extractPlanFingerprint(planned.output);
    let fetchCalls = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCalls += 1;
      throw new Error("poison fetch");
    });
    const harness = createRuntime({
      stateDirectory,
      argv: ["--state-dir", stateDirectory, "--authorize-plan", planFingerprint],
      paidExecution: async ({ registerSoftStop }) => {
        registerSoftStop(() => undefined);
        return { complete: false, reason: "deadline" };
      }
    });
    expect((await runDevelopmentDiagnosticCli(harness.runtime)).code).toBe("INCOMPLETE");
    expect(fetchCalls).toBe(0);
    expect(readPersistedPhase(stateDirectory)).toBe("incomplete");
    expect(() => statSync(developmentDiagnosticRunLockPath(stateDirectory))).toThrow();
  });

  it("closes paid gates at the first terminal role failure and publishes incomplete", async () => {
    const stateDirectory = createStateDirectoryPath("terminal-role-failure");
    const planned = createRuntime({ stateDirectory });
    await runDevelopmentDiagnosticCli(planned.runtime);
    const planFingerprint = extractPlanFingerprint(planned.output);
    let fetchCalls = 0;
    let gateClosed = false;
    vi.stubGlobal("fetch", async () => {
      fetchCalls += 1;
      return new Response(null, { status: 500 });
    });
    const harness = createRuntime({
      stateDirectory,
      argv: ["--state-dir", stateDirectory, "--authorize-plan", planFingerprint],
      paidExecution: async (context) => {
        context.registerSoftStop(() => {
          gateClosed = true;
        });
        const modelFingerprint = fingerprint("failed-model");
        await context.lifecycleSink({
          type: "transport_intent",
          sequence: 1,
          role: "solver",
          modelFingerprint,
          attempt: 1
        });
        await context.lifecycleSink({
          type: "transport_reserved",
          sequence: 1,
          role: "solver",
          modelFingerprint,
          attempt: 1
        });
        await context.lifecycleSink({ type: "transport_started", sequence: 1 });
        await fetch("https://mock.invalid/failure");
        await context.lifecycleSink({
          type: "transport_settled",
          sequence: 1,
          outcome: "failed",
          errorCategory: "server_error"
        });
        await context.lifecycleSink({
          type: "role_failed",
          slot: "slot-01",
          role: "solver",
          errorCategory: "server_error"
        });
        await context.lifecycleSink({
          type: "slot_outcome",
          slot: "slot-01",
          status: "incomplete"
        });
        return { complete: false, reason: "terminal_role_failure" };
      }
    });
    expect((await runDevelopmentDiagnosticCli(harness.runtime)).code).toBe("INCOMPLETE");
    expect(fetchCalls).toBe(1);
    expect(gateClosed).toBe(true);
    expect(readPersistedPhase(stateDirectory)).toBe("incomplete");
    expect(() => statSync(developmentDiagnosticRunLockPath(stateDirectory))).toThrow();
  });

  it("retains the lock and performs zero fetches when the running checkpoint fails", async () => {
    const stateDirectory = createStateDirectoryPath("running-write-failure");
    const planned = createRuntime({ stateDirectory });
    await runDevelopmentDiagnosticCli(planned.runtime);
    const planFingerprint = extractPlanFingerprint(planned.output);
    let paidCalls = 0;
    const harness = createRuntime({
      stateDirectory,
      argv: ["--state-dir", stateDirectory, "--authorize-plan", planFingerprint],
      writeStateAtomic: (input) => {
        if (input.state.phase === "running") throw new Error("running write failed");
        return writeDevelopmentDiagnosticRunStateAtomic(input);
      },
      paidExecution: async () => {
        paidCalls += 1;
        return { complete: false };
      }
    });
    expect((await runDevelopmentDiagnosticCli(harness.runtime)).code).toBe("SAFE_FAILURE");
    expect(paidCalls).toBe(0);
    expect(readPersistedPhase(stateDirectory)).toBe("authorized");
    expect(statSync(developmentDiagnosticRunLockPath(stateDirectory)).isFile()).toBe(true);
  });

  it("awaits the fetch-before checkpoint and closes gates on checkpoint failure", async () => {
    const stateDirectory = createStateDirectoryPath("prefetch-failure");
    const planned = createRuntime({ stateDirectory });
    await runDevelopmentDiagnosticCli(planned.runtime);
    const planFingerprint = extractPlanFingerprint(planned.output);
    let fetchCalls = 0;
    let gateClosed = false;
    const harness = createRuntime({
      stateDirectory,
      argv: ["--state-dir", stateDirectory, "--authorize-plan", planFingerprint],
      writeStateAtomic: (input) => {
        if (input.state.phase === "running" && input.state.sequence === 1) {
          throw new Error("intent checkpoint failed");
        }
        return writeDevelopmentDiagnosticRunStateAtomic(input);
      },
      paidExecution: async (context) => {
        context.registerSoftStop(() => {
          gateClosed = true;
        });
        await context.lifecycleSink({
          type: "transport_intent",
          sequence: 1,
          role: "solver",
          modelFingerprint: fingerprint("prefetch-model"),
          attempt: 1
        });
        fetchCalls += 1;
        return { complete: false };
      }
    });
    expect((await runDevelopmentDiagnosticCli(harness.runtime)).code).toBe("SAFE_FAILURE");
    expect(fetchCalls).toBe(0);
    expect(gateClosed).toBe(true);
    expect(readPersistedPhase(stateDirectory)).toBe("running");
    expect(statSync(developmentDiagnosticRunLockPath(stateDirectory)).isFile()).toBe(true);
  });

  it("blocks recovery after a settle rename is published but directory fsync is unknown", async () => {
    const stateDirectory = createStateDirectoryPath("settle-failure");
    const planned = createRuntime({ stateDirectory });
    await runDevelopmentDiagnosticCli(planned.runtime);
    const planFingerprint = extractPlanFingerprint(planned.output);
    let fetchCalls = 0;
    let gateClosed = false;
    let writeCalls = 0;
    let writesAtDurabilityFailure = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    });
    const harness = createRuntime({
      stateDirectory,
      argv: ["--state-dir", stateDirectory, "--authorize-plan", planFingerprint],
      writeStateAtomic: (input) => {
        writeCalls += 1;
        return writeDevelopmentDiagnosticRunStateAtomic({
          ...input,
          ...(input.state.phase === "running" && input.state.transport.settled === 1
            ? {
                faults: {
                  beforeDirectoryFsync: () => {
                    writesAtDurabilityFailure = writeCalls;
                    throw new Error("settle directory fsync failed");
                  }
                }
              }
            : {})
        });
      },
      paidExecution: async (context) => {
        context.registerSoftStop(() => {
          gateClosed = true;
        });
        const modelFingerprint = fingerprint("settle-model");
        await context.lifecycleSink({
          type: "transport_intent",
          sequence: 1,
          role: "solver",
          modelFingerprint,
          attempt: 1
        });
        await context.lifecycleSink({
          type: "transport_reserved",
          sequence: 1,
          role: "solver",
          modelFingerprint,
          attempt: 1
        });
        await context.lifecycleSink({ type: "transport_started", sequence: 1 });
        await fetch("https://mock.invalid/settle");
        await context.lifecycleSink({ type: "transport_first_output", sequence: 1 });
        await context.lifecycleSink({
          type: "transport_settled",
          sequence: 1,
          outcome: "succeeded",
          errorCategory: null
        });
        return { complete: false };
      }
    });
    expect((await runDevelopmentDiagnosticCli(harness.runtime)).code).toBe("SAFE_FAILURE");
    expect(fetchCalls).toBe(1);
    expect(gateClosed).toBe(true);
    expect(writeCalls).toBe(writesAtDurabilityFailure);
    expect(readPersistedPhase(stateDirectory)).toBe("running");
    expect(statSync(developmentDiagnosticRunLockPath(stateDirectory)).isFile()).toBe(true);
    expect(harness.output.join("")).not.toContain('"kind":"transport_settled"');
    expect(harness.output.join("")).not.toContain('"kind":"terminal"');
    const uncertainCheckpoint = readFileSync(
      developmentDiagnosticRunStatePath(stateDirectory),
      "utf8"
    );
    const persisted = JSON.parse(uncertainCheckpoint) as {
      readonly transport: { readonly settled: number; readonly active: number };
    };
    expect(persisted.transport).toMatchObject({ settled: 1, active: 0 });
    const recovery = createRuntime({
      stateDirectory,
      argv: ["--state-dir", stateDirectory, "--authorize-plan", planFingerprint],
      paidExecution: async () => {
        throw new Error("recovery runner must stay closed");
      }
    });
    expect((await runDevelopmentDiagnosticCli(recovery.runtime)).code).toBe("SAFE_FAILURE");
    expect(readFileSync(developmentDiagnosticRunStatePath(stateDirectory), "utf8")).toBe(
      uncertainCheckpoint
    );
  });

  it("retains its lock and reports safe failure when terminal directory fsync is unknown", async () => {
    const stateDirectory = createStateDirectoryPath("terminal-fsync-failure");
    const planned = createRuntime({ stateDirectory });
    await runDevelopmentDiagnosticCli(planned.runtime);
    const planFingerprint = extractPlanFingerprint(planned.output);
    let failTerminalFsync = true;
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    const harness = createRuntime({
      stateDirectory,
      argv: ["--state-dir", stateDirectory, "--authorize-plan", planFingerprint],
      writeStateAtomic: (input) =>
        writeDevelopmentDiagnosticRunStateAtomic({
          ...input,
          ...(input.state.phase === "complete" && failTerminalFsync
            ? {
                faults: {
                  beforeDirectoryFsync: () => {
                    failTerminalFsync = false;
                    throw new Error("terminal directory fsync failed");
                  }
                }
              }
            : {})
        }),
      paidExecution: emitCompleteMockRun
    });
    expect((await runDevelopmentDiagnosticCli(harness.runtime)).code).toBe("SAFE_FAILURE");
    expect(statSync(developmentDiagnosticRunLockPath(stateDirectory)).isFile()).toBe(true);
    expect(harness.output.join("")).not.toContain('"phase":"complete"');
  });

  it("rejects wrong authorization, authorization without a prior plan, and fingerprint drift", async () => {
    const stateDirectory = createStateDirectoryPath();
    const first = createRuntime({ stateDirectory });
    await runDevelopmentDiagnosticCli(first.runtime);

    const wrong = createRuntime({
      stateDirectory,
      argv: ["--state-dir", stateDirectory, "--authorize-plan", fingerprint("wrong")]
    });
    expect((await runDevelopmentDiagnosticCli(wrong.runtime)).code).toBe(
      "PLAN_REQUIRES_AUTHORIZATION"
    );
    expect(readPersistedPhase(stateDirectory)).toBe("planned");

    const drift = createRuntime({
      stateDirectory,
      configurationFingerprint: fingerprint("drift")
    });
    expect((await runDevelopmentDiagnosticCli(drift.runtime)).code).toBe("SAFE_FAILURE");

    const freshDirectory = createStateDirectoryPath("fresh");
    const noPriorPlan = createRuntime({
      stateDirectory: freshDirectory,
      argv: ["--state-dir", freshDirectory, "--authorize-plan", fingerprint("guessed")]
    });
    expect((await runDevelopmentDiagnosticCli(noPriorPlan.runtime)).code).toBe("SAFE_FAILURE");
    expect(readPersistedPhase(freshDirectory)).toBe("planned");
  });

  it.each([
    ["correct", (prompt: string) => prompt.split("\n", 1)[0] ?? null, "SAFE_FAILURE"],
    ["wrong", () => "AUTHORIZE SOMETHING ELSE", "PLAN_REQUIRES_AUTHORIZATION"],
    ["eof", () => null, "PLAN_REQUIRES_AUTHORIZATION"],
  ] as const)("handles TTY %s confirmation", async (_label, response, expectedCode) => {
    const stateDirectory = createStateDirectoryPath();
    const harness = createRuntime({
      stateDirectory,
      stdinIsTTY: true,
      readConfirmation: async (prompt) => response(prompt)
    });
    expect((await runDevelopmentDiagnosticCli(harness.runtime)).code).toBe(expectedCode);
    expect(readPersistedPhase(stateDirectory)).toBe("planned");
  });

  it("times out TTY confirmation without authorization", async () => {
    const stateDirectory = createStateDirectoryPath();
    const harness = createRuntime({
      stateDirectory,
      stdinIsTTY: true,
      confirmationTimeoutMs: 1,
      readConfirmation: (_prompt, signal) =>
        new Promise((resolveConfirmation) => {
          signal.addEventListener("abort", () => resolveConfirmation(null), { once: true });
        })
    });
    expect((await runDevelopmentDiagnosticCli(harness.runtime)).code).toBe(
      "PLAN_REQUIRES_AUTHORIZATION"
    );
    expect(readPersistedPhase(stateDirectory)).toBe("planned");
  });

  it("rejects --authorize-plan in a TTY as ambiguous", async () => {
    const stateDirectory = createStateDirectoryPath();
    const harness = createRuntime({
      stateDirectory,
      stdinIsTTY: true,
      argv: ["--state-dir", stateDirectory, "--authorize-plan", fingerprint("plan")]
    });
    expect((await runDevelopmentDiagnosticCli(harness.runtime)).code).toBe("SAFE_FAILURE");
  });
});

describe("safe CLI crash recovery", () => {
  it("takes over a real dead lock with no state and restarts at an unconfirmed plan", async () => {
    const stateDirectory = createStateDirectoryPath("dead-lock-without-state");
    mkdirSync(stateDirectory, { mode: 0o700 });
    leaveStaleLockFromChild(stateDirectory);
    expect(() => statSync(developmentDiagnosticRunStatePath(stateDirectory))).toThrow();
    let paidCalls = 0;
    let fetchCalls = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCalls += 1;
      throw new Error("poison fetch");
    });
    const restarted = createRuntime({
      stateDirectory,
      paidExecution: async () => {
        paidCalls += 1;
        return { complete: false };
      }
    });

    expect(await runDevelopmentDiagnosticCli(restarted.runtime)).toEqual({
      exitCode: 2,
      code: "PLAN_REQUIRES_AUTHORIZATION",
      planFingerprint: extractPlanFingerprint(restarted.output)
    });
    expect(paidCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(readPersistedPhase(stateDirectory)).toBe("planned");
    expect(temporaryStateNames(stateDirectory)).toHaveLength(0);
    expect(() => statSync(developmentDiagnosticRunLockPath(stateDirectory))).toThrow();
  });

  it("still rejects an active lock before creating state or reaching confirmation", async () => {
    const stateDirectory = createStateDirectoryPath("active-lock-without-state");
    mkdirSync(stateDirectory, { mode: 0o700 });
    const held = acquireDevelopmentDiagnosticRunLock({
      directoryPath: stateDirectory,
      runId: "c04af45e-5a4a-449f-a0d2-b96709831c59"
    });
    let paidCalls = 0;
    let fetchCalls = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCalls += 1;
      throw new Error("poison fetch");
    });
    try {
      const rejected = createRuntime({
        stateDirectory,
        paidExecution: async () => {
          paidCalls += 1;
          return { complete: false };
        }
      });
      expect(await runDevelopmentDiagnosticCli(rejected.runtime)).toEqual({
        exitCode: 1,
        code: "SAFE_FAILURE"
      });
      expect(rejected.output).toHaveLength(0);
      expect(paidCalls).toBe(0);
      expect(fetchCalls).toBe(0);
      expect(() => statSync(developmentDiagnosticRunStatePath(stateDirectory))).toThrow();
      held.assertHeld();
    } finally {
      expect(held.release()).toBe(true);
    }
  });

  it("takes over a real child-process stale lock and resumes authorized zero-request state", async () => {
    const stateDirectory = createStateDirectoryPath("authorized-stale");
    const planned = createRuntime({ stateDirectory });
    await runDevelopmentDiagnosticCli(planned.runtime);
    const planFingerprint = extractPlanFingerprint(planned.output);
    persistPhase(stateDirectory, "authorized");
    leaveStaleLockFromChild(stateDirectory);
    let paidCalls = 0;
    let fetchCalls = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCalls += 1;
      throw new Error("poison fetch");
    });
    const resumed = createRuntime({
      stateDirectory,
      argv: ["--state-dir", stateDirectory, "--authorize-plan", planFingerprint],
      paidExecution: async () => {
        paidCalls += 1;
        return { complete: false, reason: "attempt_count_mismatch" };
      }
    });
    expect((await runDevelopmentDiagnosticCli(resumed.runtime)).code).toBe("INCOMPLETE");
    expect(paidCalls).toBe(1);
    expect(fetchCalls).toBe(0);
    expect(readPersistedPhase(stateDirectory)).toBe("incomplete");
    expect(() => statSync(developmentDiagnosticRunLockPath(stateDirectory))).toThrow();
  });

  it.each([
    { name: "running zero transport", withProgress: false },
    { name: "running with progress", withProgress: true }
  ])("rejects $name recovery before paid execution", async ({ withProgress }) => {
    const stateDirectory = createStateDirectoryPath(
      withProgress ? "running-progress" : "running-empty"
    );
    const planned = createRuntime({ stateDirectory });
    await runDevelopmentDiagnosticCli(planned.runtime);
    const planFingerprint = extractPlanFingerprint(planned.output);
    persistPhase(stateDirectory, "running", withProgress);
    let paidCalls = 0;
    let fetchCalls = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCalls += 1;
      throw new Error("poison fetch");
    });
    const resumed = createRuntime({
      stateDirectory,
      argv: ["--state-dir", stateDirectory, "--authorize-plan", planFingerprint],
      paidExecution: async () => {
        paidCalls += 1;
        return { complete: false };
      }
    });
    expect((await runDevelopmentDiagnosticCli(resumed.runtime)).code).toBe("SAFE_FAILURE");
    expect(paidCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(readPersistedPhase(stateDirectory)).toBe("running");
  });
});

describe("filesystem, lock, and signal boundaries", () => {
  it("rejects wide and symbolic-link state directories", async () => {
    const wideDirectory = createStateDirectoryPath("wide");
    mkdirSync(wideDirectory, { mode: 0o755 });
    const wide = createRuntime({ stateDirectory: wideDirectory });
    expect((await runDevelopmentDiagnosticCli(wide.runtime)).code).toBe("SAFE_FAILURE");

    const linkPath = createStateDirectoryPath("link");
    const targetPath = createStateDirectoryPath("target");
    mkdirSync(targetPath, { mode: 0o700 });
    symlinkSync(targetPath, linkPath);
    const symbolic = createRuntime({ stateDirectory: linkPath });
    expect((await runDevelopmentDiagnosticCli(symbolic.runtime)).code).toBe("SAFE_FAILURE");
  });

  it("rejects wide or hard-linked state files", async () => {
    const wideDirectory = createStateDirectoryPath("wide-state");

    const firstWide = createRuntime({ stateDirectory: wideDirectory });
    await runDevelopmentDiagnosticCli(firstWide.runtime);
    chmodSync(developmentDiagnosticRunStatePath(wideDirectory), 0o644);
    const wide = createRuntime({ stateDirectory: wideDirectory });
    expect((await runDevelopmentDiagnosticCli(wide.runtime)).code).toBe("SAFE_FAILURE");

    const hardDirectory = createStateDirectoryPath("hard-state");
    const firstHard = createRuntime({ stateDirectory: hardDirectory });
    await runDevelopmentDiagnosticCli(firstHard.runtime);
    linkSync(
      developmentDiagnosticRunStatePath(hardDirectory),
      join(hardDirectory, "state-alias.json")
    );
    const hard = createRuntime({ stateDirectory: hardDirectory });
    expect((await runDevelopmentDiagnosticCli(hard.runtime)).code).toBe("SAFE_FAILURE");
  });
  it("rejects a state directory not owned by the effective process identity", async () => {
    const stateDirectory = createStateDirectoryPath("foreign-owner");
    const harness = createRuntime({ stateDirectory });
    if (process.geteuid === undefined) throw new Error("Linux effective UID unavailable");
    const effectiveUserId = process.geteuid();
    vi.spyOn(process, "geteuid").mockReturnValue(effectiveUserId + 1);
    expect((await runDevelopmentDiagnosticCli(harness.runtime)).code).toBe("SAFE_FAILURE");
  });

  it("rejects symbolic, hard-linked, and wide lock files", async () => {
    const symbolicDirectory = createStateDirectoryPath("symbolic-lock");
    mkdirSync(symbolicDirectory, { mode: 0o700 });
    const symbolicTarget = join(symbolicDirectory, "external.lock");
    writeFileSync(symbolicTarget, "{}", { mode: 0o600 });
    symlinkSync(symbolicTarget, developmentDiagnosticRunLockPath(symbolicDirectory));
    expect(
      (await runDevelopmentDiagnosticCli(createRuntime({ stateDirectory: symbolicDirectory }).runtime))
        .code
    ).toBe("SAFE_FAILURE");

    const wideDirectory = createStateDirectoryPath("wide-lock");
    mkdirSync(wideDirectory, { mode: 0o700 });
    writeFileSync(developmentDiagnosticRunLockPath(wideDirectory), "{}", { mode: 0o644 });
    expect(
      (await runDevelopmentDiagnosticCli(createRuntime({ stateDirectory: wideDirectory }).runtime))
        .code
    ).toBe("SAFE_FAILURE");

    const hardDirectory = createStateDirectoryPath("hard-lock");
    mkdirSync(hardDirectory, { mode: 0o700 });
    const held = acquireDevelopmentDiagnosticRunLock({
      directoryPath: hardDirectory,
      runId: "f5d56585-62de-4bbb-834d-d5cce16c5066"
    });
    linkSync(developmentDiagnosticRunLockPath(hardDirectory), join(hardDirectory, "lock-alias"));
    expect(
      (await runDevelopmentDiagnosticCli(createRuntime({ stateDirectory: hardDirectory }).runtime))
        .code
    ).toBe("SAFE_FAILURE");
    expect(held.release()).toBe(false);
  });

  it("allows only one concurrent process to reach confirmation", async () => {
    const stateDirectory = createStateDirectoryPath();
    let resolveFirst: ((value: string | null) => void) | undefined;
    const firstReady = new Promise<void>((resolveReady) => {
      resolveFirst = undefined;
      const check = (): void => resolveReady();
      queueMicrotask(check);
    });
    const first = createRuntime({
      stateDirectory,
      stdinIsTTY: true,
      readConfirmation: (_prompt, signal) =>
        new Promise((resolveConfirmation) => {
          resolveFirst = resolveConfirmation;
          signal.addEventListener("abort", () => resolveConfirmation(null), { once: true });
        })
    });
    const firstRun = runDevelopmentDiagnosticCli(first.runtime);
    await firstReady;
    while (resolveFirst === undefined) await new Promise((resolveWait) => setImmediate(resolveWait));
    const lockStatus = statSync(developmentDiagnosticRunLockPath(stateDirectory));
    expect(lockStatus.mode & 0o777).toBe(0o600);
    expect(lockStatus.uid).toBe(currentOwner().effectiveUserId);
    expect(lockStatus.nlink).toBe(1);

    const second = createRuntime({ stateDirectory });
    expect((await runDevelopmentDiagnosticCli(second.runtime)).code).toBe("SAFE_FAILURE");
    resolveFirst("wrong");
    expect((await firstRun).code).toBe("PLAN_REQUIRES_AUTHORIZATION");
    expect(() => statSync(developmentDiagnosticRunLockPath(stateDirectory))).toThrow();
  });

  it("seals planned state before releasing its lock on SIGINT", async () => {
    const stateDirectory = createStateDirectoryPath();
    let handlerReady: (() => void) | undefined;
    const ready = new Promise<void>((resolveReady) => {
      handlerReady = resolveReady;
    });
    const harness = createRuntime({
      stateDirectory,
      stdinIsTTY: true,
      readConfirmation: (_prompt, signal) =>
        new Promise((resolveConfirmation) => {
          signal.addEventListener("abort", () => resolveConfirmation(null), { once: true });
          handlerReady?.();
        })
    });
    const running = runDevelopmentDiagnosticCli(harness.runtime);
    await ready;
    harness.getSignalHandler()?.("SIGINT");
    expect(await running).toEqual({ exitCode: 130, code: "INTERRUPTED" });
    expect(readPersistedPhase(stateDirectory)).toBe("planned");
    expect(temporaryStateNames(stateDirectory)).toHaveLength(0);
    expect(() => statSync(developmentDiagnosticRunLockPath(stateDirectory))).toThrow();
  });

  it("persists one queued SIGTERM intent when signalled twice and completes incomplete", async () => {
    const stateDirectory = createStateDirectoryPath();
    const planned = createRuntime({ stateDirectory });
    await runDevelopmentDiagnosticCli(planned.runtime);
    const planFingerprint = extractPlanFingerprint(planned.output);
    let paidCalls = 0;
    let gateClosed = false;
    let authorizationHarness: RuntimeHarness;
    authorizationHarness = createRuntime({
      stateDirectory,
      argv: ["--state-dir", stateDirectory, "--authorize-plan", planFingerprint],
      paidExecution: async ({ registerSoftStop }) => {
        paidCalls += 1;
        registerSoftStop(() => {
          gateClosed = true;
        });
        authorizationHarness.getSignalHandler()?.("SIGTERM");
        authorizationHarness.getSignalHandler()?.("SIGTERM");
        return { complete: false };
      }
    });
    expect(await runDevelopmentDiagnosticCli(authorizationHarness.runtime)).toEqual({
      exitCode: 130,
      code: "INTERRUPTED"
    });
    expect(readPersistedPhase(stateDirectory)).toBe("incomplete");
    expect(temporaryStateNames(stateDirectory)).toHaveLength(0);
    expect(paidCalls).toBe(1);
    expect(gateClosed).toBe(true);
    expect(() => statSync(developmentDiagnosticRunLockPath(stateDirectory))).toThrow();
    const persisted = JSON.parse(
      readFileSync(developmentDiagnosticRunStatePath(stateDirectory), "utf8")
    ) as { readonly terminationIntent: string; readonly sequence: number };
    expect(persisted.terminationIntent).toBe("SIGTERM");
    expect(persisted.sequence).toBe(2);
  });

  it("denies payment when SIGTERM closes the gate during a durable pre-fetch flush", async () => {
    const stateDirectory = createStateDirectoryPath("signal-prefetch-flush");
    const planned = createRuntime({ stateDirectory });
    await runDevelopmentDiagnosticCli(planned.runtime);
    const planFingerprint = extractPlanFingerprint(planned.output);
    let releaseStartedCheckpoint: (() => void) | undefined;
    const startedCheckpointReleased = new Promise<void>((resolve) => {
      releaseStartedCheckpoint = resolve;
    });
    let startedCheckpointReached: (() => void) | undefined;
    const startedCheckpointPending = new Promise<void>((resolve) => {
      startedCheckpointReached = resolve;
    });
    let fetchCalls = 0;
    let denialCode: string | undefined;
    let controller: DevelopmentDiagnosticRunController | undefined;
    let authorizationHarness: RuntimeHarness;
    authorizationHarness = createRuntime({
      stateDirectory,
      argv: ["--state-dir", stateDirectory, "--authorize-plan", planFingerprint],
      paidExecution: async (context) => {
        controller = new DevelopmentDiagnosticRunController({
          profile: developmentDiagnosticProfile,
          manifest: {
            schemaVersion: 1,
            profileName: "development-diagnostic-2x4-v1",
            profileFingerprint: developmentDiagnosticProfileFingerprint,
            slots: [
              {
                slot: "slot-01",
                sourceBinding: fingerprint("signal-prefetch-source-01"),
                truthBindingHash: fingerprint("signal-prefetch-truth-01")
              },
              {
                slot: "slot-02",
                sourceBinding: fingerprint("signal-prefetch-source-02"),
                truthBindingHash: fingerprint("signal-prefetch-truth-02")
              }
            ]
          },
          runBindingHash: fingerprint("signal-prefetch-run"),
          scheduler: createDevelopmentDiagnosticScheduler(),
          startedAtMs: 0,
          clock: () => 1,
          lifecycleSink: async (event) => {
            await context.lifecycleSink(event);
            if (event.type === "transport_started") {
              startedCheckpointReached?.();
              await startedCheckpointReleased;
            }
          }
        });
        context.registerSoftStop(() => controller?.softStop("manual"));
        const provider: ProviderCredentialsLike = {
          baseUrl: "https://mock.invalid/v1/chat/completions",
          apiKey: "test-key"
        };
        const spec: ModelCallSpec = {
          provider: "aether",
          model: "deepseek-v4-pro",
          temperature: 1,
          thinking: true,
          thinkingRequest: "enabled",
          reasoningEffort: "max"
        };
        const payment = withLlmRequestStartGate(
          controller.requestStartGate,
          () => chatCompleteWithReceipt(
            provider,
            spec,
            [{ role: "user", content: "synthetic" }],
            {
              outputIdleTimeoutMs: 60_000,
              firstOutputTimeoutMs: 60_000,
              maximumDurationMs: 120_000,
              maxAttempts: 1,
              baseDelayMs: 0,
              fetch: async () => {
                fetchCalls += 1;
                throw new Error("fetch must remain unreachable");
              },
              onTransportDispatch: () => controller!.prepareTransportOrThrow({
                role: "solver",
                modelFingerprint: fingerprint("signal-prefetch-model")
              }),
              dispatchTransport: (execute) => controller!.dispatchTransport(execute)
            }
          )
        );
        await startedCheckpointPending;
        authorizationHarness.getSignalHandler()?.("SIGTERM");
        releaseStartedCheckpoint?.();
        try {
          await payment;
        } catch (error) {
          denialCode = error instanceof LlmRequestError ? error.code : "unexpected";
        }
        await controller.flushLifecycleEvents();
        return { complete: false, reason: "terminal_role_failure" };
      }
    });

    expect(await runDevelopmentDiagnosticCli(authorizationHarness.runtime)).toEqual({
      exitCode: 130,
      code: "INTERRUPTED"
    });
    expect(fetchCalls).toBe(0);
    expect(denialCode).toBe("LLM_REQUEST_START_BLOCKED");
    expect(controller?.requestStartGate.canStartRequest()).toBe(false);
    expect(controller?.scheduler().snapshot().softStopped).toBe(true);
    expect(readPersistedPhase(stateDirectory)).toBe("incomplete");
    expect(temporaryStateNames(stateDirectory)).toHaveLength(0);
    expect(() => statSync(developmentDiagnosticRunLockPath(stateDirectory))).toThrow();
    const persisted = JSON.parse(
      readFileSync(developmentDiagnosticRunStatePath(stateDirectory), "utf8")
    ) as {
      readonly terminationIntent: string;
      readonly attempts: readonly { readonly outcome: string }[];
      readonly transport: {
        readonly started: number;
        readonly settled: number;
        readonly active: number;
        readonly queued: number;
      };
    };
    expect(persisted.terminationIntent).toBe("SIGTERM");
    expect(persisted.transport).toEqual(expect.objectContaining({
      started: 1,
      settled: 1,
      active: 0,
      queued: 0
    }));
    expect(persisted.attempts).toEqual([
      expect.objectContaining({ outcome: "failed" })
    ]);
    const progress = authorizationHarness.output.slice(1).map((line) =>
      JSON.parse(line) as {
        readonly event: string;
        readonly phase: string;
        readonly counts: { readonly completed: number; readonly failed: number };
      }
    );
    expect(progress.some((entry) => entry.phase === "complete")).toBe(false);
    expect(progress.at(-1)).toEqual(expect.objectContaining({
      event: "development_diagnostic_progress",
      phase: "incomplete",
      counts: expect.objectContaining({ completed: 0, failed: 1 })
    }));
  });

  it("soft-stops on double SIGINT, drains four healthy inflight fetches, and persists incomplete", async () => {
    const stateDirectory = createStateDirectoryPath("signal-inflight");
    const planned = createRuntime({ stateDirectory });
    await runDevelopmentDiagnosticCli(planned.runtime);
    const planFingerprint = extractPlanFingerprint(planned.output);
    let fetchCalls = 0;
    let activeFetches = 0;
    let peakFetches = 0;
    let gateClosed = false;
    let pending: ((response: Response) => void)[] = [];
    let authorizationHarness: RuntimeHarness;
    vi.stubGlobal("fetch", () => {
      fetchCalls += 1;
      activeFetches += 1;
      peakFetches = Math.max(peakFetches, activeFetches);
      return new Promise<Response>((resolveFetch) => {
        pending.push(resolveFetch);
        if (pending.length === 4) {
          authorizationHarness.getSignalHandler()?.("SIGINT");
          authorizationHarness.getSignalHandler()?.("SIGINT");
          const batch = pending;
          pending = [];
          activeFetches -= batch.length;
          for (const resolvePending of batch) {
            resolvePending(new Response(null, { status: 204 }));
          }
        }
      });
    });
    authorizationHarness = createRuntime({
      stateDirectory,
      argv: ["--state-dir", stateDirectory, "--authorize-plan", planFingerprint],
      paidExecution: async (context) => {
        context.registerSoftStop(() => {
          gateClosed = true;
        });
        await Promise.all(
          Array.from({ length: 4 }, async (_, index) => {
            const sequence = index + 1;
            const role = diagnosticRoles[index]!;
            const modelFingerprint = fingerprint(`signal-model:${role}`);
            await context.lifecycleSink({
              type: "transport_intent",
              sequence,
              role,
              modelFingerprint,
              attempt: 1
            });
            await context.lifecycleSink({
              type: "transport_reserved",
              sequence,
              role,
              modelFingerprint,
              attempt: 1
            });
            await context.lifecycleSink({ type: "transport_started", sequence });
            await fetch("https://mock.invalid/signal");
            await context.lifecycleSink({ type: "transport_first_output", sequence });
            await context.lifecycleSink({
              type: "transport_settled",
              sequence,
              outcome: "succeeded",
              errorCategory: null
            });
          })
        );
        return { complete: false };
      }
    });
    expect(await runDevelopmentDiagnosticCli(authorizationHarness.runtime)).toEqual({
      exitCode: 130,
      code: "INTERRUPTED"
    });
    expect(fetchCalls).toBe(4);
    expect(peakFetches).toBe(4);
    expect(gateClosed).toBe(true);
    expect(readPersistedPhase(stateDirectory)).toBe("incomplete");
    const persisted = JSON.parse(
      readFileSync(developmentDiagnosticRunStatePath(stateDirectory), "utf8")
    ) as {
      readonly terminationIntent: string;
      readonly transport: {
        readonly started: number;
        readonly settled: number;
        readonly active: number;
        readonly queued: number;
      };
    };
    expect(persisted.terminationIntent).toBe("SIGINT");
    expect(persisted.transport).toMatchObject({
      started: 4,
      settled: 4,
      active: 0,
      queued: 0
    });
    expect(() => statSync(developmentDiagnosticRunLockPath(stateDirectory))).toThrow();
  });
});
