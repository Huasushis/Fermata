import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  linkSync,
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
  DevelopmentDiagnosticRunStateError,
  acquireDevelopmentDiagnosticRunLock,
  applyDevelopmentDiagnosticRunEvent,
  assessDevelopmentDiagnosticRecovery,
  createDevelopmentDiagnosticRunState,
  developmentDiagnosticRunLockPath,
  developmentDiagnosticRunStatePath,
  isDevelopmentDiagnosticTemporaryFile,
  developmentDiagnosticRunStateTemporaryPath,
  parseDevelopmentDiagnosticRunState,
  readDevelopmentDiagnosticRunState,
  transitionDevelopmentDiagnosticRunState,
  updateDevelopmentDiagnosticRunProgress,
  writeDevelopmentDiagnosticRunStateAtomic,
  type AtomicWriteFaults,
  type DevelopmentDiagnosticProcessProbe,
  type DevelopmentDiagnosticRunIdentity,
  type DevelopmentDiagnosticRunProgress,
  type DevelopmentDiagnosticRunState
} from "../experiments/lib/development-diagnostic-run-state";
import {
  developmentDiagnosticProfile,
  developmentDiagnosticProfileFingerprint
} from "../src/review-flow/development-diagnostic";

const roles = [
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
const fixedTime = new Date("2026-08-13T06:00:00.000Z");
const temporaryRoots: string[] = [];

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function buildIdentity(runId = randomUUID()): DevelopmentDiagnosticRunIdentity {
  return {
    runId,
    codeFingerprint: digest("code-v1"),
    manifestFingerprint: digest("manifest-v1"),
    authorityFingerprint: digest("authority-v1"),
    configurationFingerprint: digest("configuration-v1"),
    profileFingerprint: developmentDiagnosticProfileFingerprint,
    profile: {
      ...developmentDiagnosticProfile,
      retryableHttpStatuses: [429]
    }
  };
}

function createTemporaryDirectory(name = "state"): string {
  const root = mkdtempSync(join(tmpdir(), "fermata-run-state-v1-"));
  temporaryRoots.push(root);
  return join(root, name);
}

function expectRunStateError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("expected run-state operation to fail");

  } catch (error) {
    expect(error).toBeInstanceOf(DevelopmentDiagnosticRunStateError);
    expect((error as DevelopmentDiagnosticRunStateError).code).toBe(code);
  }
}
function createOwnedStateDirectory(name = "state"): string {
  const directoryPath = createTemporaryDirectory(name);
  mkdirSync(directoryPath, { mode: 0o700 });
  return directoryPath;
}

function advanceToRunning(identity: DevelopmentDiagnosticRunIdentity): DevelopmentDiagnosticRunState {
  const planned = createDevelopmentDiagnosticRunState(identity, fixedTime);
  const authorized = transitionDevelopmentDiagnosticRunState(planned, "authorized", fixedTime);
  return transitionDevelopmentDiagnosticRunState(authorized, "running", fixedTime);
}

type SlotProgress = DevelopmentDiagnosticRunProgress["slots"][0];

function notStartedSlot(slot: "slot-01" | "slot-02"): SlotProgress {
  return {
    slot,
    status: "not_started",
    completedRoleFingerprints: [],
    failedRoleFingerprints: [],
    completedStageFingerprints: [],
    failedStageFingerprints: []
  };
}

function completedSlot(slot: "slot-01" | "slot-02"): SlotProgress {
  return {
    slot,
    status: "complete",
    completedRoleFingerprints: roles.map((role) => digest(`role:${role}`)),
    failedRoleFingerprints: [],
    completedStageFingerprints: ["review", "cross", "adversarial", "adjudication"].map(digest),
    failedStageFingerprints: []
  };
}

function runningSlot(slot: "slot-01" | "slot-02", withSettledRole = false): SlotProgress {
  return {
    slot,
    status: "running",
    completedRoleFingerprints: withSettledRole ? [digest("role:solver")] : [],
    failedRoleFingerprints: [],
    completedStageFingerprints: [],
    failedStageFingerprints: []
  };
}

function incompleteSlot(slot: "slot-01" | "slot-02"): SlotProgress {
  return {
    slot,
    status: "incomplete",
    completedRoleFingerprints: [],
    failedRoleFingerprints: [digest("role:solver")],
    completedStageFingerprints: [],
    failedStageFingerprints: []
  };
}

function settledProgress(
  count: number,
  slots: DevelopmentDiagnosticRunProgress["slots"],
  terminalFailure: DevelopmentDiagnosticRunProgress["transport"]["terminalFailure"] = null
): DevelopmentDiagnosticRunProgress {
  return {
    sequence: count * 3,
    terminationIntent: null,
    terminalReason: terminalFailure === null ? null : "terminal_role_failure",
    transport: {
      intended: count,
      reserved: count,
      started: count,
      settled: count,
      active: 0,
      queued: 0,
      terminalFailure
    },
    attempts: Array.from({ length: count }, (_, index) => ({
      sequence: index + 1,
      roleFingerprint: digest(`role:${index}`),
      modelFingerprint: digest(`model:${index}`),
      attempt: 1,
      outcome: terminalFailure !== null && index === count - 1 ? "failed" : "succeeded",
      queuedAt: fixedTime.toISOString(),
      startAt: fixedTime.toISOString(),
      firstOutputAt: fixedTime.toISOString(),
      endAt: fixedTime.toISOString(),
      endToEndMs: 0,
      errorCategory: terminalFailure !== null && index === count - 1 ? terminalFailure : null
    })),
    slots
  };
}

function completeProgress(): DevelopmentDiagnosticRunProgress {
  return settledProgress(24, [completedSlot("slot-01"), completedSlot("slot-02")]);
}

function settledBoundaryProgress(): DevelopmentDiagnosticRunProgress {
  return settledProgress(12, [completedSlot("slot-01"), notStartedSlot("slot-02")]);
}

function buildProbe(input: {
  readonly processId: number;
  readonly processStartTimeTicks: string;
  readonly boot: string;
  readonly observed: string | null | (() => string | null);
}): DevelopmentDiagnosticProcessProbe {
  return {
    processId: input.processId,
    processStartTimeTicks: input.processStartTimeTicks,
    bootIdSha256: digest(input.boot),
    now: () => fixedTime,
    readProcessStartTimeTicks: () =>
      typeof input.observed === "function" ? input.observed() : input.observed
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("development diagnostic strict run state", () => {
  it("binds immutable identity and permits only the v1 transition graph", () => {
    const identity = buildIdentity();
    const planned = createDevelopmentDiagnosticRunState(identity, fixedTime);
    expect(planned).toMatchObject({
      schemaVersion: 1,
      kind: "development-diagnostic-run-state",
      phase: "planned",
      identity
    });
    expectRunStateError(
      () => transitionDevelopmentDiagnosticRunState(planned, "running", fixedTime),
      "RUN_STATE_TRANSITION_INVALID"
    );
    expectRunStateError(
      () => updateDevelopmentDiagnosticRunProgress(planned, completeProgress(), fixedTime),
      "RUN_STATE_PROGRESS_NOT_RUNNING"
    );


    const eventRunning = advanceToRunning(identity);
    const intended = applyDevelopmentDiagnosticRunEvent(eventRunning, {
      type: "transport_intent",
      roleFingerprint: digest("role:solver"),
      modelFingerprint: digest("model:solver"),
      attempt: 1,
      at: fixedTime
    });
    const reserved = applyDevelopmentDiagnosticRunEvent(intended, {
      type: "transport_reserved",
      attemptSequence: 1,
      at: fixedTime
    });
    const started = applyDevelopmentDiagnosticRunEvent(reserved, {
      type: "transport_started",
      attemptSequence: 1,
      at: fixedTime
    });
    const output = applyDevelopmentDiagnosticRunEvent(started, {
      type: "transport_first_output",
      attemptSequence: 1,
      at: fixedTime
    });
    const settled = applyDevelopmentDiagnosticRunEvent(output, {
      type: "transport_settled",
      attemptSequence: 1,
      outcome: "succeeded",
      errorCategory: null,
      at: fixedTime
    });
    expect(settled.sequence).toBe(5);
    expect(settled.transport).toMatchObject({
      intended: 1,
      reserved: 1,
      started: 1,
      settled: 1,
      active: 0,
      queued: 0
    });
    expect(settled.attempts[0]).toMatchObject({
      outcome: "succeeded",
      firstOutputAt: fixedTime.toISOString(),
      endToEndMs: 0
    });
    expectRunStateError(
      () =>
        applyDevelopmentDiagnosticRunEvent(settled, {
          type: "transport_started",
          attemptSequence: 1,
          at: fixedTime
        }),
      "RUN_STATE_ATTEMPT_TRANSITION_INVALID"
    );
    const running = advanceToRunning(identity);
    const completedProgress = updateDevelopmentDiagnosticRunProgress(
      running,
      completeProgress(),
      fixedTime
    );
    const complete = transitionDevelopmentDiagnosticRunState(
      completedProgress,
      "complete",
      fixedTime
    );
    expect(complete.phase).toBe("complete");
    expectRunStateError(
      () => transitionDevelopmentDiagnosticRunState(complete, "running", fixedTime),
      "RUN_STATE_TRANSITION_INVALID"
    );
  });

  it("represents an incomplete terminal run without storing raw responses", () => {
    const running = advanceToRunning(buildIdentity());
    const failed = updateDevelopmentDiagnosticRunProgress(
      running,
      settledProgress(
        1,
        [incompleteSlot("slot-01"), notStartedSlot("slot-02")],
        "permanent"
      ),
      fixedTime
    );
    expect(transitionDevelopmentDiagnosticRunState(failed, "incomplete", fixedTime).phase).toBe(
      "incomplete"
    );
  });

  it("rejects unknown fields, stale integrity, and identity drift", () => {
    const identity = buildIdentity();
    const state = createDevelopmentDiagnosticRunState(identity, fixedTime);
    expectRunStateError(
      () => parseDevelopmentDiagnosticRunState({ ...state, unknown: true }),
      "RUN_STATE_INVALID"
    );
    expectRunStateError(
      () => parseDevelopmentDiagnosticRunState({ ...state, phase: "authorized" }),
      "RUN_STATE_TAMPERED"
    );
    expectRunStateError(
      () =>
        parseDevelopmentDiagnosticRunState(state, {
          ...identity,
          codeFingerprint: digest("different-code")
        }),
      "RUN_STATE_IDENTITY_MISMATCH"
    );
  });

  it("binds the complete real diagnostic profile and rejects paid-run drift", () => {
    const identity = buildIdentity();
    expect(identity.profile).toEqual({
      ...developmentDiagnosticProfile,
      retryableHttpStatuses: [429]
    });
    for (const invalid of [
      { ...identity, codeFingerprint: "not-a-digest" },
      { ...identity, profileFingerprint: digest("other-profile") },
      { ...identity, profile: { ...identity.profile, maximumTotalExternalAttempts: 53 } },
      { ...identity, profile: { ...identity.profile, maximumConcurrency: 5 } },
      { ...identity, profile: { ...identity.profile, maximumAttemptsPerLogicalRequest: 2 } },
      { ...identity, profile: { ...identity.profile, retryableHttpStatuses: [500] } },
      { ...identity, profile: { ...identity.profile, softStopBudgetMs: 1 } }
    ]) {
      expect(() =>
        createDevelopmentDiagnosticRunState(invalid as DevelopmentDiagnosticRunIdentity)
      ).toThrow();
    }
  });

  it("rejects progress beyond transport and concurrency ceilings", () => {
    const running = advanceToRunning(buildIdentity());
    expect(() =>
      updateDevelopmentDiagnosticRunProgress(running, {
        ...settledProgress(24, [completedSlot("slot-01"), completedSlot("slot-02")]),
        transport: {
          intended: 53,
          reserved: 53,
          started: 53,
          settled: 53,
          active: 0,
          queued: 0,
          terminalFailure: null
        }
      })
    ).toThrow();
    expect(() =>
      updateDevelopmentDiagnosticRunProgress(running, {
        ...settledProgress(4, [runningSlot("slot-01"), notStartedSlot("slot-02")]),
        transport: {
          intended: 5,
          reserved: 5,
          started: 5,
          settled: 0,
          active: 5,
          queued: 0,
          terminalFailure: null
        }
      })
    ).toThrow();
  });
});

describe("atomic state persistence and strict reader", () => {
  it("round-trips through a 0700 directory and 0600 file", () => {
    const directoryPath = createTemporaryDirectory();
    const identity = buildIdentity();
    const state = createDevelopmentDiagnosticRunState(identity, fixedTime);
    const statePath = writeDevelopmentDiagnosticRunStateAtomic({ directoryPath, state }).statePath;

    expect(statSync(directoryPath).mode & 0o777).toBe(0o700);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(readDevelopmentDiagnosticRunState({ directoryPath, expectedIdentity: identity })).toEqual(
      state
    );
  });

  it("leaves no temporary file when failure occurs before temporary open", () => {
    const directoryPath = createTemporaryDirectory();
    const identity = buildIdentity();
    const planned = createDevelopmentDiagnosticRunState(identity, fixedTime);
    writeDevelopmentDiagnosticRunStateAtomic({ directoryPath, state: planned });
    const authorized = transitionDevelopmentDiagnosticRunState(planned, "authorized", fixedTime);
    expectRunStateError(
      () =>
        writeDevelopmentDiagnosticRunStateAtomic({
          directoryPath,
          state: authorized,
          faults: {
            beforeTemporaryOpen: () => {
              throw new Error("injected pre-open fault");
            }
          }
        }),
      "RUN_STATE_ATOMIC_WRITE_FAILED"
    );
    expect(readdirSync(directoryPath).filter(isDevelopmentDiagnosticTemporaryFile)).toEqual([]);
  });

  it.each(["beforeWrite", "beforeFileFsync", "beforeRename"] as const)(
    "retains a private orphan and rejects recovery at %s",
    (faultName) => {
      const directoryPath = createTemporaryDirectory();
      const identity = buildIdentity();
      const planned = createDevelopmentDiagnosticRunState(identity, fixedTime);
      writeDevelopmentDiagnosticRunStateAtomic({ directoryPath, state: planned });
      const authorized = transitionDevelopmentDiagnosticRunState(planned, "authorized", fixedTime);
      const temporaryPath = developmentDiagnosticRunStateTemporaryPath(directoryPath, authorized);
      const faults: AtomicWriteFaults = {
        [faultName]: () => {
          throw new Error("injected pre-rename fault");
        }
      };

      expectRunStateError(
        () => writeDevelopmentDiagnosticRunStateAtomic({ directoryPath, state: authorized, faults }),
        "RUN_STATE_ATOMIC_WRITE_FAILED"
      );
      expect(statSync(temporaryPath).mode & 0o777).toBe(0o600);
      expect(
        readDevelopmentDiagnosticRunState({ directoryPath, expectedIdentity: identity }).phase
      ).toBe("planned");
      expect(
        assessDevelopmentDiagnosticRecovery({
          state: planned,
          expectedIdentity: identity,
          directoryPath
        })
      ).toEqual({ allowed: false, reason: "orphaned_atomic_write", requiresNewRun: true });
    }
  );

  it("publishes successfully without retaining a temporary file", () => {
    const directoryPath = createTemporaryDirectory();
    const identity = buildIdentity();
    const planned = createDevelopmentDiagnosticRunState(identity, fixedTime);
    writeDevelopmentDiagnosticRunStateAtomic({ directoryPath, state: planned });
    const authorized = transitionDevelopmentDiagnosticRunState(planned, "authorized", fixedTime);
    writeDevelopmentDiagnosticRunStateAtomic({ directoryPath, state: authorized });
    expect(readdirSync(directoryPath).filter(isDevelopmentDiagnosticTemporaryFile)).toEqual([]);
  });

  it("reports a published durability-unknown checkpoint and forbids same-action retry", () => {
    const directoryPath = createTemporaryDirectory();
    const identity = buildIdentity();
    const planned = createDevelopmentDiagnosticRunState(identity, fixedTime);
    writeDevelopmentDiagnosticRunStateAtomic({ directoryPath, state: planned });
    const authorized = transitionDevelopmentDiagnosticRunState(planned, "authorized", fixedTime);
    let writeError: DevelopmentDiagnosticRunStateError | undefined;
    try {
      writeDevelopmentDiagnosticRunStateAtomic({
        directoryPath,
        state: authorized,
        faults: {
          beforeDirectoryFsync: () => {
            throw new Error("injected directory fsync fault");
          }
        }
      });
    } catch (error) {
      expect(error).toBeInstanceOf(DevelopmentDiagnosticRunStateError);
      if (error instanceof DevelopmentDiagnosticRunStateError) writeError = error;
    }
    expect(writeError).toMatchObject({
      code: "RUN_STATE_PUBLISHED_DURABILITY_UNKNOWN",
      published: true,
      durabilityUnknown: true
    });
    const loaded = readDevelopmentDiagnosticRunState({
      directoryPath,
      expectedIdentity: identity
    });
    expect(loaded.phase).toBe("authorized");
    expect(
      assessDevelopmentDiagnosticRecovery({
        state: loaded,
        expectedIdentity: identity,
        directoryPath,
        atomicWriteError: writeError
      })
    ).toEqual({ allowed: false, reason: "durability_unknown", requiresNewRun: true });
    expectRunStateError(
      () => writeDevelopmentDiagnosticRunStateAtomic({ directoryPath, state: authorized }),
      "RUN_STATE_ACTION_ALREADY_PUBLISHED"
    );
  });

  it("rejects symbolic links, hard links, wide modes, and simulated non-owner", () => {
    const identity = buildIdentity();

    const symlinkDirectory = createTemporaryDirectory("symlink-state");
    mkdirSync(symlinkDirectory, { mode: 0o700 });
    const externalPath = join(symlinkDirectory, "external.json");
    writeFileSync(externalPath, "{}", { mode: 0o600 });
    symlinkSync(externalPath, developmentDiagnosticRunStatePath(symlinkDirectory));
    expectRunStateError(
      () => readDevelopmentDiagnosticRunState({ directoryPath: symlinkDirectory, expectedIdentity: identity }),
      "RUN_STATE_FILE_UNSAFE"
    );

    const hardLinkDirectory = createTemporaryDirectory("hard-link-state");
    const hardLinkState = createDevelopmentDiagnosticRunState(identity, fixedTime);
    const hardLinkStatePath = writeDevelopmentDiagnosticRunStateAtomic({
      directoryPath: hardLinkDirectory,
      state: hardLinkState
    }).statePath;
    linkSync(hardLinkStatePath, join(hardLinkDirectory, "state-alias.json"));
    expectRunStateError(
      () => readDevelopmentDiagnosticRunState({
        directoryPath: hardLinkDirectory,
        expectedIdentity: identity
      }),
      "RUN_STATE_FILE_UNSAFE"
    );
    expectRunStateError(
      () => writeDevelopmentDiagnosticRunStateAtomic({
        directoryPath: hardLinkDirectory,
        state: hardLinkState
      }),
      "RUN_STATE_TARGET_UNSAFE"
    );

    const modeDirectory = createTemporaryDirectory("mode-state");
    const state = createDevelopmentDiagnosticRunState(identity, fixedTime);
    const statePath = writeDevelopmentDiagnosticRunStateAtomic({
      directoryPath: modeDirectory,
      state
    }).statePath;
    chmodSync(statePath, 0o644);
    expectRunStateError(
      () => readDevelopmentDiagnosticRunState({ directoryPath: modeDirectory, expectedIdentity: identity }),
      "RUN_STATE_FILE_UNSAFE"
    );
    chmodSync(statePath, 0o600);
    chmodSync(modeDirectory, 0o755);
    expectRunStateError(
      () => readDevelopmentDiagnosticRunState({ directoryPath: modeDirectory, expectedIdentity: identity }),
      "RUN_STATE_DIRECTORY_UNSAFE"
    );
    chmodSync(modeDirectory, 0o700);

    const getUserId = process.geteuid;
    if (getUserId === undefined) throw new Error("Linux ownership probe unavailable");
    vi.spyOn(process, "geteuid").mockReturnValue(getUserId() + 1);
    expectRunStateError(
      () => readDevelopmentDiagnosticRunState({ directoryPath: modeDirectory, expectedIdentity: identity }),
      "RUN_STATE_DIRECTORY_UNSAFE"
    );
  });

  it.each([
    ["corrupt JSON", "{", "RUN_STATE_READ_FAILED"],
    [
      "old schema",
      JSON.stringify({ schemaVersion: 0, kind: "development-diagnostic-run-state" }),
      "RUN_STATE_INVALID"
    ]
  ])("rejects %s", (_label, source, code) => {
    const directoryPath = createTemporaryDirectory();
    const identity = buildIdentity();
    const state = createDevelopmentDiagnosticRunState(identity, fixedTime);
    const statePath = writeDevelopmentDiagnosticRunStateAtomic({ directoryPath, state }).statePath;
    writeFileSync(statePath, source, "utf8");
    expectRunStateError(
      () => readDevelopmentDiagnosticRunState({ directoryPath, expectedIdentity: identity }),
      code
    );
  });

  it("rejects unknown fields, tampering, and an expected-identity mismatch on disk", () => {
    const cases: ReadonlyArray<{
      readonly mutate: (state: DevelopmentDiagnosticRunState) => unknown;
      readonly code: string;
      readonly expectedIdentity?: (identity: DevelopmentDiagnosticRunIdentity) => DevelopmentDiagnosticRunIdentity;
    }> = [
      { mutate: (state) => ({ ...state, extra: "unknown" }), code: "RUN_STATE_INVALID" },
      { mutate: (state) => ({ ...state, updatedAt: "2026-08-13T06:01:00.000Z" }), code: "RUN_STATE_TAMPERED" },
      {
        mutate: (state) => state,
        code: "RUN_STATE_IDENTITY_MISMATCH",
        expectedIdentity: (identity) => ({ ...identity, profileFingerprint: digest("other-profile") })
      }
    ];
    for (const testCase of cases) {
      const directoryPath = createTemporaryDirectory();
      const identity = buildIdentity();
      const state = createDevelopmentDiagnosticRunState(identity, fixedTime);
      const statePath = writeDevelopmentDiagnosticRunStateAtomic({ directoryPath, state }).statePath;
      writeFileSync(statePath, `${JSON.stringify(testCase.mutate(state))}\n`, "utf8");
      expectRunStateError(
        () =>
          readDevelopmentDiagnosticRunState({
            directoryPath,
            expectedIdentity: testCase.expectedIdentity?.(identity) ?? identity
          }),
        testCase.code
      );
    }
  });

  it("never persists arbitrary problem, solution, credential, or response fields", () => {
    const privateSentinels = [
      "PRIVATE_PROBLEM_SENTINEL",
      "PRIVATE_SOLUTION_SENTINEL",
      "PRIVATE_CREDENTIAL_SENTINEL",
      "PRIVATE_RESPONSE_SENTINEL"
    ];
    const identity = buildIdentity();
    const state = createDevelopmentDiagnosticRunState(identity, fixedTime);
    expectRunStateError(
      () =>
        parseDevelopmentDiagnosticRunState({
          ...state,
          problemText: privateSentinels[0],
          solutionText: privateSentinels[1],
          credential: privateSentinels[2],
          rawResponse: privateSentinels[3]
        }),
      "RUN_STATE_INVALID"
    );

    const directoryPath = createTemporaryDirectory();
    const statePath = writeDevelopmentDiagnosticRunStateAtomic({ directoryPath, state }).statePath;
    const persisted = readFileSync(statePath, "utf8");
    for (const sentinel of privateSentinels) expect(persisted).not.toContain(sentinel);
  });
});

describe("single-instance lock", () => {
  it("uses a 0600 exclusive lock and rejects a live same-boot process", () => {
    const directoryPath = createTemporaryDirectory();
    const runId = randomUUID();
    const probe = buildProbe({
      processId: 41001,
      processStartTimeTicks: "101",
      boot: "boot-a",
      observed: "101"
    });
    const lock = acquireDevelopmentDiagnosticRunLock({ directoryPath, runId, probe });
    expect(statSync(developmentDiagnosticRunLockPath(directoryPath)).mode & 0o777).toBe(0o600);
    lock.assertHeld();
    expectRunStateError(
      () => acquireDevelopmentDiagnosticRunLock({ directoryPath, runId: randomUUID(), probe }),
      "RUN_LOCK_ACTIVE"
    );
    expectRunStateError(
      () => acquireDevelopmentDiagnosticRunLock({ directoryPath, runId: randomUUID(), probe, takeover: true }),
      "RUN_LOCK_ACTIVE"
    );
    expect(lock.release()).toBe(true);
    expect(lock.release()).toBe(false);
  });

  it("acquires, verifies, and releases with the real Linux process identity probe", () => {
    const directoryPath = createTemporaryDirectory();
    const lock = acquireDevelopmentDiagnosticRunLock({
      directoryPath,
      runId: randomUUID()
    });
    lock.assertHeld();
    expect(lock.release()).toBe(true);
  });

  it("requires explicit takeover for a dead process and prevents the old owner releasing the new lock", () => {
    const directoryPath = createTemporaryDirectory();
    const oldLock = acquireDevelopmentDiagnosticRunLock({
      directoryPath,
      runId: randomUUID(),
      probe: buildProbe({
        processId: 42001,
        processStartTimeTicks: "201",
        boot: "boot-a",
        observed: null
      })
    });
    const takeoverProbe = buildProbe({
      processId: 42002,
      processStartTimeTicks: "202",
      boot: "boot-a",
      observed: null
    });
    expectRunStateError(
      () =>
        acquireDevelopmentDiagnosticRunLock({
          directoryPath,
          runId: randomUUID(),
          probe: takeoverProbe
        }),
      "RUN_LOCK_STALE_TAKEOVER_REQUIRED"
    );

    const replacement = acquireDevelopmentDiagnosticRunLock({
      directoryPath,
      runId: randomUUID(),
      probe: takeoverProbe,
      takeover: true
    });
    expect(oldLock.release()).toBe(false);
    replacement.assertHeld();
    expect(replacement.release()).toBe(true);
  });

  it("treats PID reuse as stale but rechecks identity after quarantine", () => {
    const directoryPath = createTemporaryDirectory();
    const oldLock = acquireDevelopmentDiagnosticRunLock({
      directoryPath,
      runId: randomUUID(),
      probe: buildProbe({
        processId: 43001,
        processStartTimeTicks: "301",
        boot: "boot-a",
        observed: "302"
      })
    });
    expectRunStateError(
      () =>
        acquireDevelopmentDiagnosticRunLock({
          directoryPath,
          runId: randomUUID(),
          probe: buildProbe({
            processId: 43002,
            processStartTimeTicks: "401",
            boot: "boot-a",
            observed: "302"
          })
        }),
      "RUN_LOCK_STALE_TAKEOVER_REQUIRED"
    );

    let observations = 0;
    expectRunStateError(
      () =>
        acquireDevelopmentDiagnosticRunLock({
          directoryPath,
          runId: randomUUID(),
          takeover: true,
          probe: buildProbe({
            processId: 43002,
            processStartTimeTicks: "401",
            boot: "boot-a",
            observed: () => (++observations === 1 ? "302" : "301")
          })
        }),
      "RUN_LOCK_ACTIVE"
    );
    oldLock.assertHeld();
    expect(oldLock.release()).toBe(true);
  });

  it("rejects boot changes and unverifiable process identity without takeover", () => {
    const directoryPath = createTemporaryDirectory();
    const lock = acquireDevelopmentDiagnosticRunLock({
      directoryPath,
      runId: randomUUID(),
      probe: buildProbe({
        processId: 44001,
        processStartTimeTicks: "501",
        boot: "boot-a",
        observed: null
      })
    });
    expectRunStateError(
      () =>
        acquireDevelopmentDiagnosticRunLock({
          directoryPath,
          runId: randomUUID(),
          takeover: true,
          probe: buildProbe({
            processId: 44002,
            processStartTimeTicks: "502",
            boot: "boot-b",
            observed: null
          })
        }),
      "RUN_LOCK_BOOT_ID_MISMATCH"
    );
    expectRunStateError(
      () =>
        acquireDevelopmentDiagnosticRunLock({
          directoryPath,
          runId: randomUUID(),
          takeover: true,
          probe: {
            ...buildProbe({
              processId: 44002,
              processStartTimeTicks: "502",
              boot: "boot-a",
              observed: null
            }),
            readProcessStartTimeTicks: () => {
              throw new Error("unavailable");
            }
          }
        }),
      "RUN_LOCK_PROCESS_IDENTITY_UNAVAILABLE"
    );
    expect(lock.release()).toBe(true);
  });

  it.each([
    ["corrupt", "{"],
    ["old", JSON.stringify({ schemaVersion: 0, kind: "development-diagnostic-run-lock" })],
    ["unknown", JSON.stringify({ schemaVersion: 1, kind: "development-diagnostic-run-lock", unknown: true })]
  ])("rejects a %s lock record", (_label, source) => {
    const directoryPath = createTemporaryDirectory();
    mkdirSync(directoryPath, { mode: 0o700 });
    writeFileSync(developmentDiagnosticRunLockPath(directoryPath), source, { mode: 0o600 });
    expectRunStateError(
      () =>
        acquireDevelopmentDiagnosticRunLock({
          directoryPath,
          runId: randomUUID(),
          takeover: true,
          probe: buildProbe({
            processId: 45001,
            processStartTimeTicks: "601",
            boot: "boot-a",
            observed: null
          })
        }),
      "RUN_LOCK_INVALID"
    );
  });

  it("rejects tampering, symbolic links, hard links, and wide permissions", () => {
    const probe = buildProbe({
      processId: 46001,
      processStartTimeTicks: "701",
      boot: "boot-a",
      observed: null
    });

    const tamperDirectory = createTemporaryDirectory("tamper-lock");
    const lock = acquireDevelopmentDiagnosticRunLock({
      directoryPath: tamperDirectory,
      runId: randomUUID(),
      probe
    });
    const lockPath = developmentDiagnosticRunLockPath(tamperDirectory);
    const record = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    writeFileSync(lockPath, JSON.stringify({ ...record, runId: randomUUID() }), "utf8");
    expectRunStateError(
      () =>
        acquireDevelopmentDiagnosticRunLock({
          directoryPath: tamperDirectory,
          runId: randomUUID(),
          probe,
          takeover: true
        }),
      "RUN_LOCK_TAMPERED"
    );
    expect(lock.release()).toBe(false);

    const symlinkDirectory = createTemporaryDirectory("symlink-lock");
    mkdirSync(symlinkDirectory, { mode: 0o700 });
    const externalPath = join(symlinkDirectory, "external.lock");
    writeFileSync(externalPath, "{}", { mode: 0o600 });
    symlinkSync(externalPath, developmentDiagnosticRunLockPath(symlinkDirectory));
    expectRunStateError(
      () =>
        acquireDevelopmentDiagnosticRunLock({
          directoryPath: symlinkDirectory,
          runId: randomUUID(),
          probe,
          takeover: true
        }),
      "RUN_LOCK_UNSAFE"
    );

    const hardLinkDirectory = createTemporaryDirectory("hard-link-lock");
    const hardLinkLock = acquireDevelopmentDiagnosticRunLock({
      directoryPath: hardLinkDirectory,
      runId: randomUUID(),
      probe
    });
    linkSync(
      developmentDiagnosticRunLockPath(hardLinkDirectory),
      join(hardLinkDirectory, "lock-alias")
    );
    expectRunStateError(
      () => acquireDevelopmentDiagnosticRunLock({
        directoryPath: hardLinkDirectory,
        runId: randomUUID(),
        probe,
        takeover: true
      }),
      "RUN_LOCK_UNSAFE"
    );
    expect(hardLinkLock.release()).toBe(false);

    const modeDirectory = createTemporaryDirectory("mode-lock");
    mkdirSync(modeDirectory, { mode: 0o700 });
    writeFileSync(developmentDiagnosticRunLockPath(modeDirectory), "{}", { mode: 0o644 });
    expectRunStateError(
      () =>
        acquireDevelopmentDiagnosticRunLock({
          directoryPath: modeDirectory,
          runId: randomUUID(),
          probe,
          takeover: true
        }),
      "RUN_LOCK_UNSAFE"
    );
  });
});

describe("strict recovery decisions", () => {
  it("allows only zero-transport planned and authorized checkpoints", () => {
    const directoryPath = createOwnedStateDirectory();
    const identity = buildIdentity();
    const planned = createDevelopmentDiagnosticRunState(identity, fixedTime);
    const authorized = transitionDevelopmentDiagnosticRunState(planned, "authorized", fixedTime);

    for (const state of [planned, authorized]) {
      expect(
        assessDevelopmentDiagnosticRecovery({
          state,
          expectedIdentity: identity,
          directoryPath
        })
      ).toEqual({ allowed: true, reason: "safe_pre_transport" });
    }
  });

  it("rejects every running checkpoint, including zero-transport and all-settled states", () => {
    const directoryPath = createOwnedStateDirectory();
    const identity = buildIdentity();
    const running = advanceToRunning(identity);
    const settled = updateDevelopmentDiagnosticRunProgress(
      running,
      settledBoundaryProgress(),
      fixedTime
    );

    for (const state of [running, settled]) {
      expect(
        assessDevelopmentDiagnosticRecovery({
          state,
          expectedIdentity: identity,
          directoryPath
        })
      ).toEqual({
        allowed: false,
        reason: "running_state_requires_incomplete_seal",
        requiresNewRun: true
      });
    }
  });

  it("rejects complete and incomplete terminal checkpoints", () => {
    const directoryPath = createOwnedStateDirectory();
    const identity = buildIdentity();
    const running = advanceToRunning(identity);
    const complete = transitionDevelopmentDiagnosticRunState(
      updateDevelopmentDiagnosticRunProgress(running, completeProgress(), fixedTime),
      "complete",
      fixedTime
    );
    const incomplete = transitionDevelopmentDiagnosticRunState(
      updateDevelopmentDiagnosticRunProgress(
        running,
        settledProgress(
          1,
          [incompleteSlot("slot-01"), notStartedSlot("slot-02")],
          "permanent"
        ),
        fixedTime
      ),
      "incomplete",
      fixedTime
    );

    for (const state of [complete, incomplete]) {
      expect(
        assessDevelopmentDiagnosticRecovery({
          state,
          expectedIdentity: identity,
          directoryPath
        })
      ).toEqual({ allowed: false, reason: "terminal_state", requiresNewRun: true });
    }
  });

  it("automatically detects a valid owned orphan temporary checkpoint", () => {
    const directoryPath = createOwnedStateDirectory();
    const identity = buildIdentity();
    const state = createDevelopmentDiagnosticRunState(identity, fixedTime);
    writeFileSync(
      developmentDiagnosticRunStateTemporaryPath(directoryPath, state),
      `${JSON.stringify(state)}\n`,
      { mode: 0o600 }
    );

    expect(
      assessDevelopmentDiagnosticRecovery({
        state,
        expectedIdentity: identity,
        directoryPath
      })
    ).toEqual({ allowed: false, reason: "orphaned_atomic_write", requiresNewRun: true });
  });

  it.each(["unknown-name", "corrupt", "wide-mode"] as const)(
    "fails closed for %s temporary-prefix state",
    (kind) => {
      const directoryPath = createOwnedStateDirectory();
      const identity = buildIdentity();
      const state = createDevelopmentDiagnosticRunState(identity, fixedTime);
      const validPath = developmentDiagnosticRunStateTemporaryPath(directoryPath, state);
      const path =
        kind === "unknown-name"
          ? join(directoryPath, ".development-diagnostic-run-state.v1.json.unknown.tmp")
          : validPath;
      writeFileSync(path, kind === "corrupt" ? "{" : `${JSON.stringify(state)}\n`, {
        mode: kind === "wide-mode" ? 0o644 : 0o600
      });

      expect(
        assessDevelopmentDiagnosticRecovery({
          state,
          expectedIdentity: identity,
          directoryPath
        })
      ).toEqual({ allowed: false, reason: "orphaned_atomic_write", requiresNewRun: true });
    }
  );

  it("rejects identity drift, tampering, and old schemas", () => {
    const directoryPath = createOwnedStateDirectory();
    const identity = buildIdentity();
    const planned = createDevelopmentDiagnosticRunState(identity, fixedTime);
    const cases: ReadonlyArray<{
      readonly state: unknown;
      readonly expectedIdentity: DevelopmentDiagnosticRunIdentity;
      readonly reason: "identity_mismatch" | "state_invalid";
    }> = [
      {
        state: planned,
        expectedIdentity: { ...identity, authorityFingerprint: digest("other-authority") },
        reason: "identity_mismatch"
      },
      {
        state: { ...planned, updatedAt: "2026-08-13T06:02:00.000Z" },
        expectedIdentity: identity,
        reason: "state_invalid"
      },
      {
        state: { schemaVersion: 0, kind: "development-diagnostic-run-state" },
        expectedIdentity: identity,
        reason: "state_invalid"
      }
    ];
    for (const testCase of cases) {
      expect(
        assessDevelopmentDiagnosticRecovery({
          ...testCase,
          directoryPath
        })
      ).toEqual({
        allowed: false,
        reason: testCase.reason,
        requiresNewRun: true
      });
    }
  });
});
