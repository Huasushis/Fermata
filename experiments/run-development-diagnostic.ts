import { createHash } from "node:crypto";
import {
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  type Stats
} from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DevelopmentDiagnosticRunStateError,
  acquireDevelopmentDiagnosticRunLock,
  applyDevelopmentDiagnosticRunEvent,
  createDevelopmentDiagnosticRunState,
  assessDevelopmentDiagnosticRecovery,
  developmentDiagnosticRunIdentitySchema,
  developmentDiagnosticRunStatePath,
  readDevelopmentDiagnosticRunState,
  transitionDevelopmentDiagnosticRunState,
  writeDevelopmentDiagnosticRunStateAtomic,
  type DevelopmentDiagnosticRunEvent,
  type DevelopmentDiagnosticRunIdentity,
  type DevelopmentDiagnosticRunLock,
  type DevelopmentDiagnosticRunState
} from "./lib/development-diagnostic-run-state";
import {
  preflightDevelopmentDiagnostic,
  runDevelopmentDiagnosticPhase,
  type DevelopmentDiagnosticPreflight
} from "./lib/development-smoke-launcher";
import {
  DevelopmentDiagnosticRunController,
  createDevelopmentDiagnosticScheduler,
  developmentDiagnosticProfile,
  developmentDiagnosticProfileFingerprint,
  type DevelopmentDiagnosticLifecycleEvent
} from "../src/review-flow/development-diagnostic";
import {
  developmentDiagnosticExpectedRequestCount,
  legacyDevelopmentDiagnosticPlannedRunContract,
  parseDevelopmentDiagnosticPlannedRunContract,
  type DevelopmentDiagnosticPlannedRunContract
} from "../src/review-flow/development-diagnostic-run-contract";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digestPattern = /^[0-9a-f]{64}$/u;
const confirmationTimeoutMs = 60_000;
const roleSummary = Object.freeze([
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
] as const);

export type DevelopmentDiagnosticCliSignal = "SIGINT" | "SIGTERM";

export interface DevelopmentDiagnosticCliOwnerIdentity {
  readonly realUserId: number;
  readonly effectiveUserId: number;
  readonly repositoryOwnerId: number;
}

export interface DevelopmentDiagnosticSafePlan {
  readonly schemaVersion: 1;
  readonly runIdSummary: string;
  readonly stateIdentityFingerprint: string;
  readonly slots: number;
  readonly selectedSlots: readonly ("slot-01" | "slot-02")[];
  readonly expectedRequestsPerSlot: 12;
  readonly expectedFetches: number;
  readonly maximumExternalAttempts: number;
  readonly maximumConcurrency: number;
  readonly softStopBudgetMs: number;
  readonly softStopPolicy:
    | "deny_next_transport"
    | "stop_new_and_drain_in_flight";
  readonly profileName: string;
  readonly retry: {
    readonly maximumAttemptsPerLogicalRequest: 1;
    readonly maximumTransportAttemptsPerRequest: number;
    readonly retryableHttpStatuses: readonly [429];
  };
  readonly roles: typeof roleSummary;
  readonly modelBindings: "configured";
  readonly stateDirectorySummary: string;
  readonly paidExecution: "wired";
  readonly eta:
    | {
        readonly status: "data_insufficient";
        readonly successfulSampleCount: 0;
        readonly remainingFetches: number;
        readonly softStopBudgetMs: number;
      }
    | {
        readonly status: "estimated";
        readonly successfulSampleCount: number;
        readonly p50Ms: number;
        readonly p90Ms: number;
        readonly remainingFetches: number;
        readonly formula: string;
        readonly estimateMs: number;
      };
}

export interface DevelopmentDiagnosticCliResult {
  readonly exitCode: 0 | 1 | 2 | 130;
  readonly code:
    | "PLAN_REQUIRES_AUTHORIZATION"
    | "COMPLETE"
    | "INCOMPLETE"
    | "INTERRUPTED"
    | "SAFE_FAILURE";
  readonly planFingerprint?: string;
}

export interface DevelopmentDiagnosticHistorySample {
  readonly stateIdentityFingerprint: string;
  readonly roleFingerprint: string;
  readonly modelFingerprint: string;
  readonly queuedAt: string;
  readonly startAt: string;
  readonly firstOutputAt: string;
  readonly endAt: string;
  readonly endToEndMs: number;
  readonly outcome: "succeeded";
}

export interface DevelopmentDiagnosticPaidExecutionContext {
  readonly lifecycleSink: (event: DevelopmentDiagnosticLifecycleEvent) => Promise<void>;
  readonly registerSoftStop: (close: () => void) => void;
  readonly plannedRun: DevelopmentDiagnosticPlannedRunContract;
}

export interface DevelopmentDiagnosticPaidExecutionResult {
  readonly complete: boolean;
  readonly reason?: "deadline" | "terminal_role_failure" | "attempt_count_mismatch";
}

export interface DevelopmentDiagnosticCliRuntime {
  readonly argv: readonly string[];
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly stdinIsTTY: boolean;
  readonly wrapperParentAttested: boolean;
  readonly ownerIdentity: DevelopmentDiagnosticCliOwnerIdentity;
  readonly codeFingerprint: string;
  readonly manifestFingerprint: string;
  readonly authorityFingerprint: string;
  readonly configurationFingerprint: string;
  readonly now?: () => Date;
  readonly confirmationTimeoutMs?: number;
  readonly historySamples?: readonly DevelopmentDiagnosticHistorySample[];
  readonly writeOutput: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly readConfirmation: (
    prompt: string,
    signal: AbortSignal
  ) => Promise<string | null>;
  readonly installSignalHandlers: (
    handler: (signal: DevelopmentDiagnosticCliSignal) => void
  ) => () => void;
  readonly preflight?: (plannedRun: DevelopmentDiagnosticPlannedRunContract) => Promise<{
    readonly manifestFingerprint: string;
    readonly configurationFingerprint: string;
  }>;
  readonly paidExecution?: (
    context: DevelopmentDiagnosticPaidExecutionContext
  ) => Promise<DevelopmentDiagnosticPaidExecutionResult>;
  readonly writeStateAtomic?: typeof writeDevelopmentDiagnosticRunStateAtomic;
}
class DevelopmentDiagnosticCliError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "DevelopmentDiagnosticCliError";
  }
}

export function assertDevelopmentDiagnosticCliOwner(input: {
  readonly identity: DevelopmentDiagnosticCliOwnerIdentity;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}): void {
  const { realUserId, effectiveUserId, repositoryOwnerId } = input.identity;
  if (
    !Number.isSafeInteger(realUserId) ||
    !Number.isSafeInteger(effectiveUserId) ||
    !Number.isSafeInteger(repositoryOwnerId) ||
    realUserId < 0 ||
    effectiveUserId < 0 ||
    repositoryOwnerId < 0
  ) {
    throw new DevelopmentDiagnosticCliError("OWNER_IDENTITY_UNAVAILABLE");
  }
  if (
    input.environment.SUDO_UID !== undefined ||
    input.environment.SUDO_GID !== undefined ||
    input.environment.SUDO_USER !== undefined
  ) {
    throw new DevelopmentDiagnosticCliError("SUDO_EXECUTION_FORBIDDEN");
  }
  if (
    realUserId !== effectiveUserId ||
    realUserId !== repositoryOwnerId ||
    (realUserId === 0 && repositoryOwnerId !== 0)
  ) {
    throw new DevelopmentDiagnosticCliError("OWNER_EXECUTION_REQUIRED");
  }
}

export function parseDevelopmentDiagnosticCliArguments(argv: readonly string[]): {
  readonly stateDirectory: string;
  readonly authorizationFingerprint?: string;
  readonly plannedRun: DevelopmentDiagnosticPlannedRunContract;
} {
  const values = new Map<string, string>();
  const allowedFlags = new Set([
    "--state-dir",
    "--authorize-plan",
    "--slots",
    "--max-concurrency",
    "--transport-attempt-ceiling",
    "--max-transport-attempts-per-request",
    "--phase-scheduling-budget-ms",
    "--soft-stop-policy"
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || flag === undefined || !allowedFlags.has(flag) || values.has(flag)) {
      throw new DevelopmentDiagnosticCliError("INVALID_ARGUMENTS");
    }
    values.set(flag, value);
  }
  const stateDirectory = values.get("--state-dir");
  const authorizationFingerprint = values.get("--authorize-plan");
  if (
    stateDirectory === undefined ||
    !isAbsolute(stateDirectory) ||
    stateDirectory.includes("\0") ||
    (authorizationFingerprint !== undefined &&
      !digestPattern.test(authorizationFingerprint))
  ) {
    throw new DevelopmentDiagnosticCliError("INVALID_ARGUMENTS");
  }
  const slotsValue = values.get("--slots");
  const selectedSlots = slotsValue === undefined
    ? legacyDevelopmentDiagnosticPlannedRunContract.selectedSlots
    : slotsValue.split(",");
  const parseInteger = (flag: string, fallback: number): number => {
    const value = values.get(flag);
    if (value === undefined) return fallback;
    if (!/^[1-9][0-9]*$/u.test(value)) {
      throw new DevelopmentDiagnosticCliError("INVALID_ARGUMENTS");
    }
    return Number(value);
  };
  let plannedRun: DevelopmentDiagnosticPlannedRunContract;
  try {
    plannedRun = parseDevelopmentDiagnosticPlannedRunContract({
      schemaVersion: 1,
      selectedSlots,
      expectedRequestsPerSlot: 12,
      maximumConcurrency: parseInteger(
        "--max-concurrency",
        legacyDevelopmentDiagnosticPlannedRunContract.maximumConcurrency
      ),
      maximumTransportAttemptsPerRequest: parseInteger(
        "--max-transport-attempts-per-request",
        legacyDevelopmentDiagnosticPlannedRunContract.maximumTransportAttemptsPerRequest
      ),
      globalTransportAttemptCeiling: parseInteger(
        "--transport-attempt-ceiling",
        legacyDevelopmentDiagnosticPlannedRunContract.globalTransportAttemptCeiling
      ),
      phaseSchedulingBudgetMs: parseInteger(
        "--phase-scheduling-budget-ms",
        legacyDevelopmentDiagnosticPlannedRunContract.phaseSchedulingBudgetMs
      ),
      softStopPolicy:
        values.get("--soft-stop-policy") ??
        legacyDevelopmentDiagnosticPlannedRunContract.softStopPolicy
    });
  } catch {
    throw new DevelopmentDiagnosticCliError("INVALID_ARGUMENTS");
  }
  return {
    stateDirectory: resolve(stateDirectory),
    ...(authorizationFingerprint === undefined ? {} : { authorizationFingerprint }),
    plannedRun
  };
}

export function developmentDiagnosticStateIdentityFingerprint(input: {
  readonly absoluteStateDirectory: string;
  readonly identity: unknown;
}): string {
  return hashValue({
    absoluteStateDirectory: input.absoluteStateDirectory,
    identity: input.identity
  });
}

export function estimateDevelopmentDiagnosticEta(input: {
  readonly stateIdentityFingerprint: string;
  readonly samples: readonly DevelopmentDiagnosticHistorySample[];
  readonly plannedRun?: DevelopmentDiagnosticPlannedRunContract;
}): DevelopmentDiagnosticSafePlan["eta"] {
  const plannedRun =
    input.plannedRun ?? legacyDevelopmentDiagnosticPlannedRunContract;
  const expectedFetches = developmentDiagnosticExpectedRequestCount(plannedRun);
  const matching = input.samples.filter((sample) =>
    sample.stateIdentityFingerprint === input.stateIdentityFingerprint &&
    digestPattern.test(sample.roleFingerprint) &&
    digestPattern.test(sample.modelFingerprint) &&
    Number.isSafeInteger(sample.endToEndMs) &&
    sample.endToEndMs >= 0 &&
    Date.parse(sample.queuedAt) <= Date.parse(sample.startAt) &&
    Date.parse(sample.startAt) <= Date.parse(sample.firstOutputAt) &&
    Date.parse(sample.firstOutputAt) <= Date.parse(sample.endAt)
  );
  if (matching.length === 0) {
    return Object.freeze({
      status: "data_insufficient" as const,
      successfulSampleCount: 0 as const,
      remainingFetches: expectedFetches,
      softStopBudgetMs: plannedRun.phaseSchedulingBudgetMs
    });
  }
  const durations = matching
    .map((sample) => sample.endToEndMs)
    .sort((left, right) => left - right);
  const percentile = (fraction: number): number =>
    durations[
      Math.min(durations.length - 1, Math.ceil(durations.length * fraction) - 1)
    ]!;
  const p50Ms = percentile(0.5);
  const p90Ms = percentile(0.9);
  const remainingDagCriticalPathMs = p50Ms * 4;
  const dividedByConcurrencyMs = Math.ceil(
    (p50Ms * expectedFetches) / plannedRun.maximumConcurrency
  );
  return Object.freeze({
    status: "estimated" as const,
    successfulSampleCount: matching.length,
    p50Ms,
    p90Ms,
    remainingFetches: expectedFetches,
    formula:
      `max(remaining DAG critical path, sum remaining role p50 /${plannedRun.maximumConcurrency})`,
    estimateMs: Math.max(remainingDagCriticalPathMs, dividedByConcurrencyMs)
  });
}

export function buildDevelopmentDiagnosticSafePlan(input: {
  readonly stateDirectory: string;
  readonly ownerUserId: number;
  readonly identity: DevelopmentDiagnosticRunIdentity;
  readonly historySamples?: readonly DevelopmentDiagnosticHistorySample[];
}): DevelopmentDiagnosticSafePlan {
  ensureStateDirectory(input.stateDirectory, input.ownerUserId);
  const absoluteStateDirectory = realpathSync(input.stateDirectory);
  if (absoluteStateDirectory !== resolve(input.stateDirectory)) {
    throw new DevelopmentDiagnosticCliError("STATE_DIRECTORY_UNSAFE");
  }
  const identity = developmentDiagnosticRunIdentitySchema.parse(input.identity);
  const stateIdentityFingerprint = developmentDiagnosticStateIdentityFingerprint({
    absoluteStateDirectory,
    identity
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    runIdSummary: hashValue(identity.runId).slice(0, 16),
    stateIdentityFingerprint,
    slots: identity.plannedRun.selectedSlots.length,
    selectedSlots: Object.freeze([...identity.plannedRun.selectedSlots]),
    expectedRequestsPerSlot: identity.plannedRun.expectedRequestsPerSlot,
    expectedFetches: developmentDiagnosticExpectedRequestCount(identity.plannedRun),
    maximumExternalAttempts: identity.plannedRun.globalTransportAttemptCeiling,
    maximumConcurrency: identity.plannedRun.maximumConcurrency,
    softStopBudgetMs: identity.plannedRun.phaseSchedulingBudgetMs,
    softStopPolicy: identity.plannedRun.softStopPolicy,
    profileName: developmentDiagnosticProfile.name,
    retry: Object.freeze({
      maximumAttemptsPerLogicalRequest:
        developmentDiagnosticProfile.maximumAttemptsPerLogicalRequest,
      maximumTransportAttemptsPerRequest:
        identity.plannedRun.maximumTransportAttemptsPerRequest,
      retryableHttpStatuses: Object.freeze([429] as const)
    }),
    roles: roleSummary,
    modelBindings: "configured" as const,
    stateDirectorySummary: hashValue(absoluteStateDirectory).slice(0, 16),
    paidExecution: "wired" as const,
    eta: estimateDevelopmentDiagnosticEta({
      stateIdentityFingerprint,
      samples: input.historySamples ?? [],
      plannedRun: identity.plannedRun
    })
  });
}

export function developmentDiagnosticPlanFingerprint(
  plan: DevelopmentDiagnosticSafePlan
): string {
  return hashValue(plan);
}

export function developmentDiagnosticPreflightConfigurationFingerprint(
  preflight: Pick<
    DevelopmentDiagnosticPreflight,
    | "profileName"
    | "experimentVersion"
    | "caseBindingFingerprints"
    | "roleModelsFingerprint"
    | "paidExecutionContractFingerprint"
  >
): string {
  return hashValue({
    schemaVersion: 1,
    profileName: preflight.profileName,
    experimentVersion: preflight.experimentVersion,
    caseBindingFingerprints: preflight.caseBindingFingerprints,
    roleModelsFingerprint: preflight.roleModelsFingerprint,
    paidExecutionContractFingerprint: preflight.paidExecutionContractFingerprint
  });
}

export function developmentDiagnosticConfirmationPhrase(planFingerprint: string): string {
  if (!digestPattern.test(planFingerprint)) {
    throw new DevelopmentDiagnosticCliError("PLAN_FINGERPRINT_INVALID");
  }
  return `AUTHORIZE DEVELOPMENT DIAGNOSTIC ${planFingerprint}`;
}

export async function runDevelopmentDiagnosticCli(
  runtime: DevelopmentDiagnosticCliRuntime
): Promise<DevelopmentDiagnosticCliResult> {
  let lock: DevelopmentDiagnosticRunLock | undefined;
  let state: DevelopmentDiagnosticRunState | undefined;
  let removeSignalHandlers: (() => void) | undefined;
  let interrupted = false;
  let running = false;
  let terminalPersisted = false;
  let runnerFailed = false;
  let releaseLockOnExit = true;
  let closePaidGates: (() => void) | undefined;
  let enqueueCheckpoint:
    | ((event: DevelopmentDiagnosticRunEvent, safeKind: string) => Promise<void>)
    | undefined;
  let terminationCheckpoint: Promise<void> | undefined;
  const confirmationAbort = new AbortController();
  const now = (): Date => runtime.now?.() ?? new Date();
  const writeState = runtime.writeStateAtomic ?? writeDevelopmentDiagnosticRunStateAtomic;

  try {
    assertDevelopmentDiagnosticCliOwner({
      identity: runtime.ownerIdentity,
      environment: runtime.environment
    });
    if (
      runtime.environment.FERMATA_RUN_WITH_ENV !== "1" ||
      runtime.wrapperParentAttested !== true
    ) {
      throw new DevelopmentDiagnosticCliError("ENV_WRAPPER_REQUIRED");
    }
    const parsedArguments = parseDevelopmentDiagnosticCliArguments(runtime.argv);
    if (runtime.stdinIsTTY && parsedArguments.authorizationFingerprint !== undefined) {
      throw new DevelopmentDiagnosticCliError("AMBIGUOUS_TTY_AUTHORIZATION");
    }
    removeSignalHandlers = runtime.installSignalHandlers((signal) => {
      if (state?.phase === "complete" || state?.phase === "incomplete") return;
      if (interrupted) return;
      interrupted = true;
      confirmationAbort.abort();
      closePaidGates?.();
      if (running && enqueueCheckpoint !== undefined) {
        terminationCheckpoint = enqueueCheckpoint(
          { type: "termination_intent", signal, at: now() },
          "termination_intent"
        );
        void terminationCheckpoint.catch(() => undefined);
      }
    });
    if (interrupted) return interruptedResult();

    ensureStateDirectory(parsedArguments.stateDirectory, runtime.ownerIdentity.effectiveUserId);
    const preflight = await runtime.preflight?.(parsedArguments.plannedRun);
    if (interrupted) return interruptedResult();
    const effectiveRuntime = {
      codeFingerprint: runtime.codeFingerprint,
      manifestFingerprint: preflight?.manifestFingerprint ?? runtime.manifestFingerprint,
      authorityFingerprint: runtime.authorityFingerprint,
      configurationFingerprint:
        preflight?.configurationFingerprint ?? runtime.configurationFingerprint
    };
    const identity = buildRunIdentity(
      parsedArguments.stateDirectory,
      effectiveRuntime,
      parsedArguments.plannedRun
    );
    lock = acquireDevelopmentDiagnosticRunLock({
      directoryPath: parsedArguments.stateDirectory,
      runId: provisionalLockRunId(
        parsedArguments.stateDirectory,
        effectiveRuntime,
        parsedArguments.plannedRun
      ),
      takeover: true
    });
    if (interrupted) return interruptedResult();
    const statePath = developmentDiagnosticRunStatePath(parsedArguments.stateDirectory);
    const stateExisted = pathExistsWithoutFollowing(statePath);
    if (stateExisted) {
      state = readDevelopmentDiagnosticRunState({
        directoryPath: parsedArguments.stateDirectory,
        expectedIdentity: identity
      });
    } else {
      const plannedState = createDevelopmentDiagnosticRunState(identity, now());
      writeState({ directoryPath: parsedArguments.stateDirectory, state: plannedState });
      state = plannedState;
    }

    const plan = buildDevelopmentDiagnosticSafePlan({
      stateDirectory: parsedArguments.stateDirectory,
      ownerUserId: runtime.ownerIdentity.effectiveUserId,
      identity,
      historySamples: runtime.historySamples
    });
    const planFingerprint = developmentDiagnosticPlanFingerprint(plan);
    if (stateExisted) {
      const recovery = assessDevelopmentDiagnosticRecovery({
        state,
        expectedIdentity: identity,
        directoryPath: parsedArguments.stateDirectory
      });
      if (!recovery.allowed) {
        throw new DevelopmentDiagnosticCliError("RUN_RECOVERY_DENIED");
      }
    }
    runtime.writeOutput(`${JSON.stringify({ plan, planFingerprint })}\n`);
    if (interrupted) return interruptedResult();
    if (state.phase !== "planned" && state.phase !== "authorized") {
      throw new DevelopmentDiagnosticCliError("AUTHORIZATION_ALREADY_CONSUMED");
    }

    let confirmed = false;
    if (runtime.stdinIsTTY) {
      const configuredTimeout = runtime.confirmationTimeoutMs ?? confirmationTimeoutMs;
      if (
        !Number.isSafeInteger(configuredTimeout) ||
        configuredTimeout <= 0 ||
        configuredTimeout > confirmationTimeoutMs
      ) {
        throw new DevelopmentDiagnosticCliError("CONFIRMATION_TIMEOUT_INVALID");
      }
      const signal = AbortSignal.any([
        confirmationAbort.signal,
        AbortSignal.timeout(configuredTimeout)
      ]);
      const response = await runtime.readConfirmation(
        `${developmentDiagnosticConfirmationPhrase(planFingerprint)}\n> `,
        signal
      );
      confirmed = response === developmentDiagnosticConfirmationPhrase(planFingerprint);
    } else if (parsedArguments.authorizationFingerprint !== undefined) {
      if (!stateExisted) {
        throw new DevelopmentDiagnosticCliError("AUTHORIZATION_WITHOUT_PRIOR_PLAN");
      }
      confirmed = parsedArguments.authorizationFingerprint === planFingerprint;
    }
    if (interrupted) return interruptedResult();
    if (!confirmed) {
      runtime.writeError("PLAN_REQUIRES_AUTHORIZATION\n");
      return {
        exitCode: 2,
        code: "PLAN_REQUIRES_AUTHORIZATION",
        planFingerprint
      };
    }
    if (runtime.paidExecution === undefined) {
      throw new DevelopmentDiagnosticCliError("PAID_EXECUTION_UNAVAILABLE");
    }
    if (state.phase === "planned") {
      const authorizedState = transitionDevelopmentDiagnosticRunState(state, "authorized", now());
      writeState({ directoryPath: parsedArguments.stateDirectory, state: authorizedState });
      state = authorizedState;
    }
    if (interrupted) return interruptedResult();
    const runningState = transitionDevelopmentDiagnosticRunState(state, "running", now());
    try {
      writeState({ directoryPath: parsedArguments.stateDirectory, state: runningState });
    } catch (error) {
      releaseLockOnExit = false;
      throw error;
    }
    state = runningState;
    running = true;
    releaseLockOnExit = false;

    let checkpointTail = Promise.resolve();
    let checkpointFailure: unknown;
    enqueueCheckpoint = (event, safeKind) => {
      const operation = checkpointTail.then(() => {
        if (state === undefined) {
          throw new DevelopmentDiagnosticCliError("RUN_STATE_MISSING");
        }
        const candidate = applyDevelopmentDiagnosticRunEvent(state, event);
        writeState({ directoryPath: parsedArguments.stateDirectory, state: candidate });
        state = candidate;
        runtime.writeOutput(`${JSON.stringify(
          buildSafeDevelopmentDiagnosticProgress(candidate, safeKind)
        )}\n`);
      });
      checkpointTail = operation.catch((error: unknown) => {
        checkpointFailure = error;
        closePaidGates?.();
        throw error;
      });
      return checkpointTail;
    };

    const paidResult = await runtime.paidExecution({
      lifecycleSink: async (event) => {
        await enqueueCheckpoint!(mapLifecycleEvent(event, now()), event.type);
        if (
          event.type === "role_failed" ||
          (event.type === "transport_settled" && event.outcome === "failed")
        ) {
          closePaidGates?.();
        }
      },
      registerSoftStop: (close) => {
        closePaidGates = close;
        if (interrupted || checkpointFailure !== undefined) close();
      },
      plannedRun: parsedArguments.plannedRun
    }).catch(async (error: unknown) => {
      await checkpointTail.catch(() => undefined);
      if (checkpointFailure !== undefined) throw checkpointFailure;
      if (interrupted) {
        return { complete: false, reason: "attempt_count_mismatch" as const };
      }
      runnerFailed = true;
      await enqueueCheckpoint!({
        type: "terminal",
        phase: "incomplete",
        reason: "runner_failure",
        at: now()
      }, "terminal");
      terminalPersisted = true;
      releaseLockOnExit = true;
      return { complete: false, reason: "attempt_count_mismatch" as const };
    });
    if (runnerFailed) {
      running = false;
      return { exitCode: 1, code: "INCOMPLETE", planFingerprint };
    }
    await terminationCheckpoint;
    await checkpointTail;

    const expectedFetches = developmentDiagnosticExpectedRequestCount(
      parsedArguments.plannedRun
    );
    const selectedSlots = new Set(parsedArguments.plannedRun.selectedSlots);
    const complete =
      !interrupted &&
      paidResult.complete &&
      state.transport.started === state.attempts.length &&
      state.transport.settled === state.attempts.length &&
      state.attempts.filter((attempt) => attempt.outcome === "succeeded").length ===
        expectedFetches &&
      state.transport.active === 0 &&
      state.transport.queued === 0 &&
      state.slots.every((slot) =>
        selectedSlots.has(slot.slot)
          ? slot.status === "complete"
          : slot.status === "not_started"
      );
    const terminalReason = interrupted
      ? "signal"
      : paidResult.reason ??
        (state.transport.terminalFailure !== null
          ? "terminal_role_failure"
          : "attempt_count_mismatch");
    await enqueueCheckpoint({
      type: "terminal",
      phase: complete ? "complete" : "incomplete",
      reason: complete ? null : terminalReason,
      at: now()
    }, "terminal");
    terminalPersisted = true;
    releaseLockOnExit = true;
    running = false;
    if (interrupted) return interruptedResult();
    return complete
      ? { exitCode: 0, code: "COMPLETE", planFingerprint }
      : { exitCode: 1, code: "INCOMPLETE", planFingerprint };
  } catch (error) {
    closePaidGates?.();
    if (
      error instanceof DevelopmentDiagnosticRunStateError &&
      error.code === "RUN_STATE_PUBLISHED_DURABILITY_UNKNOWN" &&
      error.durabilityUnknown
    ) {
      releaseLockOnExit = false;
    } else if (running && !terminalPersisted) {
      releaseLockOnExit = false;
    }
    if (interrupted) return interruptedResult();
    runtime.writeError("SAFE_FAILURE\n");
    return { exitCode: 1, code: "SAFE_FAILURE" };
  } finally {
    confirmationAbort.abort();
    removeSignalHandlers?.();
    if (releaseLockOnExit) lock?.release();
  }
}

function mapLifecycleEvent(
  event: DevelopmentDiagnosticLifecycleEvent,
  at: Date

): DevelopmentDiagnosticRunEvent {
  switch (event.type) {
    case "transport_intent":
      return {
        type: "transport_intent",
        roleFingerprint: hashValue({ role: event.role }),
        modelFingerprint: event.modelFingerprint,
        attempt: event.attempt,
        at
      };
    case "transport_reserved":
    case "transport_started":
    case "transport_first_output":
      return {
        type: event.type,
        attemptSequence: event.sequence,
        at
      };
    case "transport_settled":
      return {
        type: "transport_settled",
        attemptSequence: event.sequence,
        outcome: event.outcome,
        errorCategory: event.errorCategory,
        at
      };
    case "role_completed":
    case "role_failed":
      return {
        type: event.type,
        slot: event.slot,
        roleFingerprint: hashValue({ role: event.role }),
        ...(event.type === "role_failed" && event.errorCategory !== undefined
          ? { errorCategory: event.errorCategory }
          : {}),
        at
      };
    case "stage_completed":
    case "stage_failed":
      return {
        type: event.type,
        slot: event.slot,
        stageFingerprint: hashValue({ stage: event.stage }),
        at
      };
    case "slot_outcome":
      return {
        type: "slot_outcome",
        slot: event.slot,
        status: event.status,
        at
      };
  }
}
function buildSafeDevelopmentDiagnosticProgress(
  state: DevelopmentDiagnosticRunState,
  kind: string
): Readonly<Record<string, unknown>> {
  const pendingRetryDurations = new Map<string, number[]>();
  const successfulDurations: number[] = [];
  let failedLogicalRequests = 0;
  for (const attempt of state.attempts) {
    if (attempt.endToEndMs === null) continue;
    const key = `${attempt.roleFingerprint}:${attempt.modelFingerprint}`;
    const pending = pendingRetryDurations.get(key) ?? [];
    if (attempt.outcome === "retryable_failed") {
      pending.push(attempt.endToEndMs);
      pendingRetryDurations.set(key, pending);
      continue;
    }
    const retryDuration =
      attempt.attempt > 1 && pending.length > 0 ? pending.shift()! : 0;
    if (pending.length === 0) pendingRetryDurations.delete(key);
    else pendingRetryDurations.set(key, pending);
    if (attempt.outcome === "succeeded") {
      successfulDurations.push(retryDuration + attempt.endToEndMs);
    } else if (attempt.outcome === "failed") {
      failedLogicalRequests += 1;
    }
  }
  successfulDurations.sort((left, right) => left - right);
  const pendingRetryRequests = [...pendingRetryDurations.values()]
    .reduce((total, entries) => total + entries.length, 0);
  const percentile = (fraction: number): number | null =>
    successfulDurations.length === 0
      ? null
      : successfulDurations[
          Math.min(
            successfulDurations.length - 1,
            Math.ceil(successfulDurations.length * fraction) - 1
          )
        ]!;
  const elapsedMs = Math.max(0, Date.parse(state.updatedAt) - Date.parse(state.createdAt));
  const p50Ms = percentile(0.5);
  const expectedFetches = developmentDiagnosticExpectedRequestCount(
    state.identity.plannedRun
  );
  const completedLogicalRequests = successfulDurations.length;
  const activeRetryAttempts = state.attempts.filter(
    (attempt) => attempt.outcome === "running" && attempt.attempt > 1
  ).length;
  const inFlightLogicalRequests =
    state.transport.active +
    Math.max(0, pendingRetryRequests - activeRetryAttempts);
  const remainingFetches = Math.max(0, expectedFetches - completedLogicalRequests);
  const notStartedLogicalRequests = Math.max(
    0,
    expectedFetches -
      completedLogicalRequests -
      failedLogicalRequests -
      inFlightLogicalRequests
  );
  return Object.freeze({
    event: "development_diagnostic_progress",
    kind,
    sequence: state.sequence,
    phase: state.phase,
    counts: Object.freeze({
      completed: completedLogicalRequests,
      inFlight: inFlightLogicalRequests,
      failed: failedLogicalRequests,
      notStarted: notStartedLogicalRequests
    }),
    throughputPerMinute:
      elapsedMs === 0
        ? null
        : Number(((completedLogicalRequests * 60_000) / elapsedMs).toFixed(3)),
    latency: Object.freeze({
      successfulSampleCount: successfulDurations.length,
      p50Ms,
      p90Ms: percentile(0.9)
    }),
    eta:
      p50Ms === null
        ? Object.freeze({
            status: "data_insufficient",
            remainingFetches,
            softStopBudgetMs: state.identity.plannedRun.phaseSchedulingBudgetMs
          })
        : Object.freeze({
            status: "estimated",
            remainingFetches,
            formula:
              `max(remaining DAG critical path, sum remaining role p50 /${state.identity.plannedRun.maximumConcurrency})`,
            estimateMs: Math.max(
              p50Ms * 4,
              Math.ceil(
                (p50Ms * remainingFetches) /
                  state.identity.plannedRun.maximumConcurrency
              )
            )
          })
  });
}

function provisionalLockRunId(
  stateDirectory: string,
  runtime: Pick<
    DevelopmentDiagnosticCliRuntime,
    "codeFingerprint" | "authorityFingerprint" | "configurationFingerprint"
  >,
  plannedRun: DevelopmentDiagnosticPlannedRunContract
): string {
  return digestToUuid(hashValue({
    stateDirectory: resolve(stateDirectory),
    codeFingerprint: runtime.codeFingerprint,
    authorityFingerprint: runtime.authorityFingerprint,
    configurationFingerprint: runtime.configurationFingerprint,
    plannedRun,
    lockPurpose: "development-diagnostic-exclusive"
  }));
}

function interruptedResult(): DevelopmentDiagnosticCliResult {
  return { exitCode: 130, code: "INTERRUPTED" };
}

function buildRunIdentity(
  stateDirectory: string,
  runtime: Pick<
    DevelopmentDiagnosticCliRuntime,
    | "codeFingerprint"
    | "manifestFingerprint"
    | "authorityFingerprint"
    | "configurationFingerprint"
  >,
  plannedRun: DevelopmentDiagnosticPlannedRunContract
): DevelopmentDiagnosticRunIdentity {
  const identitySeed = hashValue({
    stateDirectory: resolve(stateDirectory),
    codeFingerprint: runtime.codeFingerprint,
    manifestFingerprint: runtime.manifestFingerprint,
    authorityFingerprint: runtime.authorityFingerprint,
    configurationFingerprint: runtime.configurationFingerprint,
    profileFingerprint: developmentDiagnosticProfileFingerprint,
    plannedRun
  });
  return {
    runId: digestToUuid(identitySeed),
    codeFingerprint: runtime.codeFingerprint,
    manifestFingerprint: runtime.manifestFingerprint,
    authorityFingerprint: runtime.authorityFingerprint,
    configurationFingerprint: runtime.configurationFingerprint,
    profileFingerprint: developmentDiagnosticProfileFingerprint,
    profile: {
      ...developmentDiagnosticProfile,
      retryableHttpStatuses: [429]
    },
    plannedRun
  };
}

function digestToUuid(digest: string): string {
  const bytes = Buffer.from(digest.slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function ensureStateDirectory(path: string, ownerUserId: number): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) {
      throw new DevelopmentDiagnosticCliError("STATE_DIRECTORY_UNSAFE");
    }
  }
  let status: Stats;
  try {
    status = lstatSync(path);
  } catch {
    throw new DevelopmentDiagnosticCliError("STATE_DIRECTORY_UNSAFE");
  }
  if (
    status.isSymbolicLink() ||
    !status.isDirectory() ||
    status.uid !== ownerUserId ||
    (status.mode & 0o777) !== 0o700 ||
    realpathSync(path) !== resolve(path)
  ) {
    throw new DevelopmentDiagnosticCliError("STATE_DIRECTORY_UNSAFE");
  }
}

function pathExistsWithoutFollowing(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw new DevelopmentDiagnosticCliError("STATE_FILE_UNSAFE");
  }
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function parseAttestedPrivateRoots(
  environment: NodeJS.ProcessEnv,
  startupContractFingerprint: string
): readonly string[] {
  const serialized =
    environment.FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS;
  const attestation =
    environment.FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS_ATTESTATION;
  if (
    serialized === undefined ||
    attestation === undefined ||
    !digestPattern.test(attestation)
  ) {
    throw new DevelopmentDiagnosticCliError("TRUSTED_BOOTSTRAP_REQUIRED");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new DevelopmentDiagnosticCliError("TRUSTED_BOOTSTRAP_REQUIRED");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    parsed.some((root) => typeof root !== "string" || !isAbsolute(root)) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new DevelopmentDiagnosticCliError("TRUSTED_BOOTSTRAP_REQUIRED");
  }
  const privateRoots = parsed as readonly string[];
  if (
    hashValue({
      privateRoots,
      schemaVersion: 1,
      startupContractFingerprint
    }) !== attestation
  ) {
    throw new DevelopmentDiagnosticCliError("TRUSTED_BOOTSTRAP_REQUIRED");
  }
  return Object.freeze([...privateRoots]);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function defaultOwnerIdentity(): DevelopmentDiagnosticCliOwnerIdentity {
  if (process.getuid === undefined || process.geteuid === undefined) {
    throw new DevelopmentDiagnosticCliError("OWNER_IDENTITY_UNAVAILABLE");
  }
  return {
    realUserId: process.getuid(),
    effectiveUserId: process.geteuid(),
    repositoryOwnerId: statSync(repositoryRoot).uid
  };
}

function defaultFingerprint(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function installDefaultSignalHandlers(
  handler: (signal: DevelopmentDiagnosticCliSignal) => void
): () => void {
  const onInterrupt = (): void => handler("SIGINT");
  const onTerminate = (): void => handler("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  return () => {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  };
}

function sameFilesystemIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function validateTrustedAbsolutePath(
  path: string,
  owner: number,
  expectedLeafType: "directory" | "file",
  privateLeaf = false,
  requireOwnerAtLeaf = true
): Stats {
  if (!isAbsolute(path)) throw new Error("untrusted path");
  const chain: string[] = [];
  let current = resolve(path);
  while (true) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  chain.reverse();
  let leaf: Stats | undefined;
  for (let index = 0; index < chain.length; index += 1) {
    const stat = lstatSync(chain[index]);
    const isLeaf = index === chain.length - 1;
    if (
      stat.isSymbolicLink() ||
      (stat.mode & 0o022) !== 0 ||
      (stat.uid !== 0 && stat.uid !== owner) ||
      (isLeaf && requireOwnerAtLeaf && stat.uid !== owner) ||
      (!isLeaf && !stat.isDirectory())
    ) {
      throw new Error("untrusted path");
    }
    if (
      isLeaf &&
      (
        (expectedLeafType === "file" ? !stat.isFile() : !stat.isDirectory()) ||
        (privateLeaf && (stat.mode & 0o077) !== 0)
      )
    ) {
      throw new Error("untrusted path");
    }
    leaf = stat;
  }
  if (leaf === undefined) throw new Error("untrusted path");
  return leaf;
}

function procParentId(statLine: string): number {
  const closingParenthesis = statLine.lastIndexOf(")");
  if (closingParenthesis < 0) throw new Error("invalid proc stat");
  const fields = statLine.slice(closingParenthesis + 2).trim().split(/\s+/u);
  const parentId = Number(fields[1]);
  if (!Number.isSafeInteger(parentId) || parentId <= 1) {
    throw new Error("invalid proc parent");
  }
  return parentId;
}

function procStartTime(statLine: string): string {
  const closingParenthesis = statLine.lastIndexOf(")");
  if (closingParenthesis < 0) throw new Error("invalid proc stat");
  const fields = statLine.slice(closingParenthesis + 2).trim().split(/\s+/u);
  const startTime = fields[19];
  if (startTime === undefined || !/^\d+$/u.test(startTime)) {
    throw new Error("invalid proc start time");
  }
  return startTime;
}

export function attestTrustedBootstrapParent(
  startupContractFingerprint: string,
  privateRootsAttestationFingerprint: string
): boolean {
  try {
    if (
      process.getuid === undefined ||
      !digestPattern.test(startupContractFingerprint) ||
      !digestPattern.test(privateRootsAttestationFingerprint) ||
      process.env.FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS_ATTESTATION !==
        privateRootsAttestationFingerprint ||
      procParentId(readFileSync("/proc/self/stat", "utf8")) !== process.ppid
    ) {
      return false;
    }
    const owner = process.getuid();
    const parentRoot = `/proc/${process.ppid}`;
    const parentBefore = readFileSync(`${parentRoot}/stat`, "utf8");
    if (lstatSync(parentRoot).uid !== owner) return false;
    const executableArgument = process.execPath;
    const executableIdentity = validateTrustedAbsolutePath(
      executableArgument,
      owner,
      "file",
      false,
      false
    );
    const parentExecutable = readlinkSync(`${parentRoot}/exe`);
    if (parentExecutable !== realpathSync(executableArgument)) return false;
    const parentExecutableIdentity = statSync(`${parentRoot}/exe`);
    if (!sameFilesystemIdentity(executableIdentity, parentExecutableIdentity)) return false;
    if (realpathSync(readlinkSync(`${parentRoot}/cwd`)) !== realpathSync(repositoryRoot)) {
      return false;
    }
    const bootstrapPath = resolve(
      repositoryRoot,
      "scripts/development-diagnostic-bootstrap.mjs"
    );
    const bootstrapIdentity = validateTrustedAbsolutePath(
      bootstrapPath,
      owner,
      "file"
    );
    const arguments_ = readFileSync(`${parentRoot}/cmdline`, "utf8")
      .split("\0")
      .filter((value) => value.length !== 0);
    if (
      arguments_[0] !== executableArgument ||
      arguments_[1] !== bootstrapPath ||
      !isAbsolute(arguments_[2] ?? "") ||
      arguments_.includes("--print-contract") ||
      arguments_.includes("--approve-contract")
    ) {
      return false;
    }
    const delimiterIndex = arguments_.indexOf("--");
    const bootstrapArguments = arguments_.slice(
      2,
      delimiterIndex < 0 ? arguments_.length : delimiterIndex
    );
    const stateIndexes = bootstrapArguments.flatMap((value, index) =>
      value === "--state-dir" ? [index] : []);
    if (stateIndexes.length !== 1) return false;
    const stateDirectory = bootstrapArguments[stateIndexes[0] + 1];
    if (!isAbsolute(stateDirectory ?? "")) return false;
    const stagedIndexes = bootstrapArguments.flatMap((value, index) =>
      value === "--staged-contract" ? [index] : []);
    if (stagedIndexes.length !== 1) return false;
    const stagedContractFingerprint =
      bootstrapArguments[stagedIndexes[0] + 1];
    if (!digestPattern.test(stagedContractFingerprint ?? "")) return false;
    validateTrustedAbsolutePath(stateDirectory, owner, "directory");
    const contractPath = resolve(
      stateDirectory,
      "development-diagnostic-bootstrap-contract.json"
    );
    const contractBefore = validateTrustedAbsolutePath(
      contractPath,
      owner,
      "file",
      true
    );
    const contractBytes = readFileSync(contractPath, "utf8");
    const contractAfter = lstatSync(contractPath);
    if (!sameFilesystemIdentity(contractBefore, contractAfter)) return false;
    const contract: unknown = JSON.parse(contractBytes);
    if (
      typeof contract !== "object" ||
      contract === null ||
      Array.isArray(contract) ||
      Object.keys(contract).sort().join(",") !== "contractFingerprint,schemaVersion"
    ) {
      return false;
    }
    const record = contract as Readonly<Record<string, unknown>>;
    if (
      record.schemaVersion !== 1 ||
      !digestPattern.test(String(record.contractFingerprint ?? "")) ||
      hashValue({
        approvedContractFingerprint: record.contractFingerprint,
        schemaVersion: 1,
        stagedContractFingerprint
      }) !== startupContractFingerprint
    ) {
      return false;
    }
    if (
      !sameFilesystemIdentity(bootstrapIdentity, lstatSync(bootstrapPath)) ||
      procStartTime(readFileSync(`${parentRoot}/stat`, "utf8")) !==
        procStartTime(parentBefore)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
async function readDefaultConfirmation(prompt: string, signal: AbortSignal): Promise<string | null> {
  const lineReader = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return await lineReader.question(prompt, { signal });
  } catch {
    return null;
  } finally {
    lineReader.close();
  }
}

function isDirectEntry(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

async function runDirectEntry(): Promise<void> {
  try {
    const cliPath = fileURLToPath(import.meta.url);
    const stateModulePath = fileURLToPath(
      new URL("./lib/development-diagnostic-run-state.ts", import.meta.url)
    );
    const launcherPath = fileURLToPath(
      new URL("./lib/development-smoke-launcher.ts", import.meta.url)
    );
    let diagnosticPreflight: DevelopmentDiagnosticPreflight | undefined;
    let diagnosticTaskCandidates:
      | readonly {
          readonly slot: "slot-01" | "slot-02";
          readonly taskCandidate: unknown;
          readonly duplicateSimilarityRejectThreshold: number;
        }[]
      | undefined;
    const codeFingerprint = hashValue({
      cli: defaultFingerprint(cliPath),
      state: defaultFingerprint(stateModulePath),
      launcher: defaultFingerprint(launcherPath)
    });
    const manifestPath = process.env.FERMATA_DEVELOPMENT_DIAGNOSTIC_MANIFEST;
    const startupContractFingerprint =
      process.env.FERMATA_DEVELOPMENT_DIAGNOSTIC_STARTUP_CONTRACT;
    if (
      startupContractFingerprint === undefined ||
      !digestPattern.test(startupContractFingerprint)
    ) {
      throw new DevelopmentDiagnosticCliError("TRUSTED_BOOTSTRAP_REQUIRED");
    }
    const privateRoots = parseAttestedPrivateRoots(
      process.env,
      startupContractFingerprint
    );
    const result = await runDevelopmentDiagnosticCli({
      argv: process.argv.slice(2),
      environment: process.env,
      stdinIsTTY: process.stdin.isTTY === true,
      ownerIdentity: defaultOwnerIdentity(),
      codeFingerprint,
      manifestFingerprint: manifestPath === undefined
        ? hashValue("manifest-unavailable")
        : defaultFingerprint(resolve(manifestPath)),
      authorityFingerprint: hashValue({
        profile: developmentDiagnosticProfileFingerprint,
        roles: roleSummary,
        paidExecution: "wired"
      }),
      configurationFingerprint: hashValue({
        roles: roleSummary,
        modelBindings: "configured"
      }),
      wrapperParentAttested: attestTrustedBootstrapParent(
        startupContractFingerprint,
        process.env.FERMATA_DEVELOPMENT_DIAGNOSTIC_PRIVATE_ROOTS_ATTESTATION ?? ""
      ),
      writeOutput: (text) => process.stdout.write(text),
      writeError: (text) => process.stderr.write(text),
      readConfirmation: readDefaultConfirmation,
      installSignalHandlers: installDefaultSignalHandlers,
      preflight: async (plannedRun) => {
        if (manifestPath === undefined) {
          throw new DevelopmentDiagnosticCliError("MANIFEST_REQUIRED");
        }
        diagnosticPreflight = await preflightDevelopmentDiagnostic({
          repositoryRoot,
          projectRoot: resolve(repositoryRoot, ".."),
          codeVersion: codeFingerprint.slice(0, 40),
          env: process.env,
          manifestPath: resolve(manifestPath),
          paidExecutionSourceContractFingerprint: startupContractFingerprint,
          allowedPrivateRoots: privateRoots
        }, plannedRun.selectedSlots);
        return {
          manifestFingerprint: diagnosticPreflight.manifestFingerprint,
          configurationFingerprint:
            developmentDiagnosticPreflightConfigurationFingerprint(diagnosticPreflight)
        };
      },
      paidExecution: async ({ lifecycleSink, registerSoftStop, plannedRun }) => {
        if (diagnosticPreflight === undefined) {
          throw new DevelopmentDiagnosticCliError("PREFLIGHT_REQUIRED");
        }
        const scheduler = createDevelopmentDiagnosticScheduler(
          developmentDiagnosticProfile,
          plannedRun
        );
        const controller = new DevelopmentDiagnosticRunController({
          profile: developmentDiagnosticProfile,
          plannedRun,
          manifest: {
            schemaVersion: 1,
            profileName: "development-diagnostic-2x4-v1",
            profileFingerprint: developmentDiagnosticProfileFingerprint,
            slots: diagnosticPreflight.cases.map((entry) => ({
              slot: entry.slot,
              sourceBinding: entry.sourceBinding,
              truthBindingHash: entry.truthBindingHash
            }))
          },
          runBindingHash: codeFingerprint,
          scheduler,
          startedAtMs: Date.now(),
          lifecycleSink
        });
        registerSoftStop(() => controller.softStop("manual"));
        const outcomes = await runDevelopmentDiagnosticPhase({
          controller,
          preflight: diagnosticPreflight,
          engineBuildFingerprint: codeFingerprint,
          profileName: diagnosticPreflight.profileName,
          experimentVersion: diagnosticPreflight.experimentVersion
        });
        return {
          complete:
            outcomes.every(
              (outcome) => outcome.status === "fulfilled" && outcome.value.status === "complete"
            ),
          reason: outcomes.some(
            (outcome) =>
              outcome.status === "fulfilled" &&
              outcome.value.status === "incomplete" &&
              outcome.value.failure.failureKind === "timeout"
          )
            ? "deadline"
            : outcomes.some(
                (outcome) =>
                  outcome.status === "rejected" ||
                  (outcome.status === "fulfilled" && outcome.value.status === "incomplete")
              )
              ? "terminal_role_failure"
              : "attempt_count_mismatch"
        };
      }
    });
    process.exitCode = result.exitCode;
  } catch {
    process.stderr.write("SAFE_FAILURE\n");
    process.exitCode = 1;
  }
}

if (isDirectEntry()) void runDirectEntry();
