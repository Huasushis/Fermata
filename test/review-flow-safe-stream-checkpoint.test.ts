import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveReviewFlowEvaluationCliOptions } from "../experiments/eval-review-flow";
import {
  openReviewFlowSafeStreamCheckpoint,
  ReviewFlowSafeStreamCheckpoint,
  reviewFlowSafeStreamCheckpointRecordSchema
} from "../experiments/lib/review-flow-evaluation-state";
import type { LlmSafeStreamTelemetryEvent } from "../src/llm";

const roots: string[] = [];
const checkpointFileName = "review-flow-stream.checkpoint.private.jsonl";
const safeKeys = [
  "abort",
  "bytes",
  "done",
  "elapsedMs",
  "eof",
  "lastDataMs",
  "readerPending",
  "role",
  "schemaVersion",
  "stage",
  "statusClass"
] as const;

function fixture(): {
  workspace: string;
  privateRoot: string;
  privateDirectory: string;
} {
  const workspace = mkdtempSync(join(tmpdir(), "fermata-safe-stream-"));
  roots.push(workspace);
  chmodSync(workspace, 0o700);
  const privateRoot = join(workspace, "private");
  mkdirSync(privateRoot, { mode: 0o700 });
  return {
    workspace,
    privateRoot,
    privateDirectory: join(privateRoot, "calibration-run")
  };
}

function event(
  stage: LlmSafeStreamTelemetryEvent["stage"],
  overrides: Partial<LlmSafeStreamTelemetryEvent> = {}
): LlmSafeStreamTelemetryEvent {
  return {
    schemaVersion: 1,
    role: "solver",
    stage,
    statusClass: "2xx",
    elapsedMs: 5_000,
    bytes: 128,
    lastDataMs: 2_000,
    done: false,
    eof: false,
    readerPending: stage === "pending",
    abort: false,
    ...overrides
  };
}

function runArguments(): readonly string[] {
  return [
    "--action=run",
    "--manifest=/private/manifest.json",
    "--dataset-private-root=/private",
    "--private-dir=/private/runs",
    "--partition=holdout",
    "--label=before-a",
    "--variant=baseline",
    "--development-baseline-label=dev-before-a",
    "--development-candidate-label=dev-after-a"
  ];
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("review-flow safe stream checkpoint", () => {
  it("requires the explicit run switch and rejects it for reveal", () => {
    expect(resolveReviewFlowEvaluationCliOptions(runArguments())).toMatchObject({
      streamCheckpoints: false
    });
    expect(resolveReviewFlowEvaluationCliOptions([
      ...runArguments(),
      "--stream-checkpoints"
    ])).toMatchObject({ streamCheckpoints: true });
    expect(() => resolveReviewFlowEvaluationCliOptions([
      "--action=reveal",
      "--manifest=/private/manifest.json",
      "--reveal-descriptor=/private/reveal.private.json",
      "--dataset-private-root=/private",
      "--baseline-private-dir=/private/before",
      "--candidate-private-dir=/private/after",
      "--stream-checkpoints"
    ])).toThrow("REVIEW_FLOW_EVALUATION_ARGUMENT_INVALID");
  });

  it("disabled mode returns before creating any directory or file", () => {
    const root = fixture();
    const checkpoint = openReviewFlowSafeStreamCheckpoint({
      enabled: false,
      privateDirectory: root.privateDirectory,
      privateRoot: root.privateRoot,
      containingWorkspace: root.workspace
    });

    expect(checkpoint).toBeUndefined();
    expect(existsSync(root.privateDirectory)).toBe(false);
  });

  it("fsyncs an append-only pending record before close with mode 0600", () => {
    const root = fixture();
    const checkpoint = new ReviewFlowSafeStreamCheckpoint({
      privateDirectory: root.privateDirectory,
      privateRoot: root.privateRoot,
      containingWorkspace: root.workspace
    });
    const path = join(root.privateDirectory, checkpointFileName);
    try {
      checkpoint.append(event("pending"));
      const beforeClose = readFileSync(path, "utf8");
      const first = JSON.parse(beforeClose.trim()) as Record<string, unknown>;
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(Object.keys(first).sort()).toEqual([...safeKeys]);
      expect(first).toMatchObject({
        stage: "pending",
        bytes: 128,
        lastDataMs: 2_000,
        readerPending: true
      });

      checkpoint.append(event("abort", {
        elapsedMs: 5_001,
        abort: true,
        readerPending: true
      }));
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(beforeClose.trim());
    } finally {
      checkpoint.close();
    }
  });

  it("strictly rejects every field outside the safe whitelist", () => {
    const root = fixture();
    const checkpoint = new ReviewFlowSafeStreamCheckpoint({
      privateDirectory: root.privateDirectory,
      privateRoot: root.privateRoot,
      containingWorkspace: root.workspace
    });
    try {
      expect(() => checkpoint.append({
        ...event("headers"),
        unexpected: "blocked"
      } as LlmSafeStreamTelemetryEvent)).toThrow();
      expect(() => reviewFlowSafeStreamCheckpointRecordSchema.parse({
        ...event("headers"),
        identifier: "blocked"
      })).toThrow();
    } finally {
      checkpoint.close();
    }
  });
});
