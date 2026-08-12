import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeDevelopmentSmokePhase0,
  type DevelopmentSmokePreflight
} from "../experiments/lib/development-smoke-launcher";
import {
  developmentSmokeProfile,
  parseDevelopmentSmokeManifest,
  summarizeDevelopmentSmokeManifest
} from "../src/review-flow/development-smoke";

const temporaryRoots: string[] = [];
const digest = (character: string): string => character.repeat(64);

function fixturePreflight(root: string): DevelopmentSmokePreflight {
  const manifest = parseDevelopmentSmokeManifest({
    schemaVersion: 1,
    profileName: developmentSmokeProfile.name,
    slots: [
      slot("slot-01", "low", "pass", ["schema_invalid"], "1"),
      slot("slot-02", "middle", "reject", ["output_limit"], "2"),
      slot("slot-03", "high", "pass", [], "3"),
      slot("slot-04", "middle", "reject", [], "4"),
      slot("slot-05", "high", "pass", [], "5"),
      slot("slot-06", "high", "reject", [], "6")
    ]
  });
  const manifestFingerprint = summarizeDevelopmentSmokeManifest(manifest)
    .manifestFingerprint;
  const source = {
    statement: {
      type: "traditional" as const,
      statement: "SENSITIVE_SOURCE_MUST_NOT_ENTER_CHECKPOINT",
      constraints: "1 <= n <= 10",
      samples: [],
      limits: { timeMs: 1_000, memoryMiB: 256 }
    },
    referenceSolution: {
      solution: "SENSITIVE_SOLUTION_MUST_NOT_ENTER_CHECKPOINT",
      referenceImplementation: null
    },
    technicalContext: {
      constraints: "1 <= n <= 10",
      samples: [],
      limits: { timeMs: 1_000, memoryMiB: 256 }
    },
    historicalTasteRubric: null,
    difficultyAnchors: null,
    labelCatalog: { version: 1, tags: [] },
    hardRules: { duplicateSimilarityRejectThreshold: 0.9 }
  };
  return {
    manifestPath: resolve(root, "manifest.private.json"),
    manifestFileSha256: digest("a"),
    manifest,
    privateManifest: {} as never,
    cases: [
      {
        slot: "slot-01",
        sourceBinding: digest("1"),
        source,
        truthBindingHash: digest("1")
      },
      {
        slot: "slot-02",
        sourceBinding: digest("2"),
        source,
        truthBindingHash: digest("2")
      }
    ],
    models: {} as never,
    codeVersion: "b".repeat(40),
    repositoryRoot: root,
    privateRuntimeRoot: resolve(root, "private/runtime"),
    safeSummary: {
      slots: 6,
      phase0Slots: 2,
      provider: "aether",
      models: ["deepseek-v4-pro", "deepseek-v4-flash"],
      concurrency: 12,
      retries: 0,
      externalAttemptCeiling: 30,
      manifestFingerprint
    }
  };
}

function offlineModels(
  fetch: NonNullable<DevelopmentSmokePreflight["models"]["A"]["runtime"]["fetch"]>
): DevelopmentSmokePreflight["models"] {
  const credentials = {
    baseUrl: "https://offline-transport.invalid/v1",
    apiKey: "offline-test-only"
  };
  const runtime = {
    outputIdleTimeoutMs: developmentSmokeProfile.outputIdleTimeoutMs,
    firstOutputTimeoutMs: developmentSmokeProfile.firstValidOutputTimeoutMs,
    maximumDurationMs: developmentSmokeProfile.preFirstOutputFallbackMs,
    maxAttempts: 1,
    baseDelayMs: 500,
    fetch
  };
  const model = (name: "deepseek-v4-pro" | "deepseek-v4-flash") => ({
    spec: {
      provider: "aether" as const,
      model: name,
      temperature: 0,
      thinking: false,
      thinkingRequest: "enabled" as const,
      reasoningEffort: "max" as const
    },
    credentials,
    runtime
  });
  return {
    A: model("deepseek-v4-pro"),
    B: model("deepseek-v4-flash"),
    C: model("deepseek-v4-pro"),
    D: model("deepseek-v4-pro"),
    formatter: model("deepseek-v4-flash")
  };
}

function slot(
  anonymousSlot: string,
  difficultyTruth: "low" | "middle" | "high",
  verdictTruth: "pass" | "reject",
  priorFailures: readonly ("output_limit" | "schema_invalid")[],
  seed: string
) {
  return {
    slot: anonymousSlot,
    slotBindingHash: digest(seed),
    truthBindingHash: digest(seed.toUpperCase()),
    difficultyTruth,
    verdictTruth,
    priorFailures
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("development smoke private checkpoint", () => {
  it("persists authorization receipts before entering an injected offline transport", async () => {
    const root = mkdtempSync(join(tmpdir(), "fermata-smoke-authorization-"));
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    const transport = vi.fn(async () => {
      throw new Error("OFFLINE_TRANSPORT_BOUNDARY");
    });
    const preflight = {
      ...fixturePreflight(root),
      models: offlineModels(transport)
    };

    const result = await executeDevelopmentSmokePhase0({ preflight });

    const runDirectory = resolve(
      preflight.privateRuntimeRoot,
      `run-${result.runId}`
    );
    const checkpointNames = readdirSync(runDirectory)
      .filter((name) => name.startsWith("checkpoint-"))
      .sort();
    const checkpoint = JSON.parse(readFileSync(
      resolve(runDirectory, checkpointNames.at(-1)!),
      "utf8"
    ));
    expect(checkpoint.failureCode).toBe("connect");
    expect(result).toMatchObject({
      state: "incomplete",
      requestCount: 4
    });
    expect(transport).toHaveBeenCalledTimes(4);
    expect(checkpoint.phase1Released).toBe(false);
    expect(checkpoint.requests).toHaveLength(4);
    expect(checkpoint.requests.every(
      (request: { receipt: { schemaFingerprint?: string }; failureKind?: string }) =>
        request.receipt.schemaFingerprint?.length === 64 &&
        request.failureKind === "connect"
    )).toBe(true);
  });

  it("writes an owner-only immutable hash chain and never persists source text", async () => {
    const root = mkdtempSync(join(tmpdir(), "fermata-smoke-checkpoint-"));
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    const preflight = fixturePreflight(root);
    const first = await executeDevelopmentSmokePhase0({ preflight });
    expect(first.state).toBe("incomplete");
    expect(first.requestCount).toBe(0);

    const runDirectory = resolve(
      preflight.privateRuntimeRoot,
      `run-${first.runId}`
    );
    const firstNames = readdirSync(runDirectory).sort();
    expect(firstNames).toEqual([
      "checkpoint-000001.private.json",
      "checkpoint-000002.private.json",
      "checkpoint-000003.private.json"
    ]);
    let previousHash: string | null = null;
    const originalBytes = new Map<string, Buffer>();
    for (const [index, name] of firstNames.entries()) {
      const path = resolve(runDirectory, name);
      const bytes = readFileSync(path);
      originalBytes.set(name, bytes);
      const checkpoint = JSON.parse(bytes.toString("utf8"));
      expect(statSync(path).mode & 0o077).toBe(0);
      expect(checkpoint.revision).toBe(index + 1);
      expect(checkpoint.previousCheckpointSha256).toBe(previousHash);
      expect(checkpoint.accuracyClaim).toBeNull();
      expect(checkpoint.includedInFinalCalibration).toBe(false);
      expect(checkpoint.phase1Released).toBe(false);
      expect(bytes.toString("utf8")).not.toContain("SENSITIVE_");
      previousHash = sha256(bytes);
    }
    expect(readdirSync(runDirectory)).not.toContain("active.lock.private.json");

    const resumed = await executeDevelopmentSmokePhase0({
      preflight,
      resumeRunId: first.runId
    });
    expect(resumed).toMatchObject({
      runId: first.runId,
      state: "incomplete",
      requestCount: 0
    });
    for (const [name, bytes] of originalBytes) {
      expect(readFileSync(resolve(runDirectory, name))).toEqual(bytes);
    }
    expect(readdirSync(runDirectory).filter((name) =>
      name.startsWith("checkpoint-")
    )).toHaveLength(5);
  });

  it("always creates a unique run directory instead of reusing a label", async () => {
    const root = mkdtempSync(join(tmpdir(), "fermata-smoke-unique-"));
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    const preflight = fixturePreflight(root);
    const [left, right] = await Promise.all([
      executeDevelopmentSmokePhase0({ preflight }),
      executeDevelopmentSmokePhase0({ preflight })
    ]);
    expect(left.runId).not.toBe(right.runId);
    expect(readdirSync(preflight.privateRuntimeRoot).sort()).toEqual([
      `run-${left.runId}`,
      `run-${right.runId}`
    ].sort());
  });
});
