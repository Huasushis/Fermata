import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  readStageCheckpoint,
  writeStageCheckpointAtomic
} from "../experiments/lib/review-flow-stage-checkpoint-file";
import {
  deriveCheckpointAfterWorkerLoss,
  type StageCheckpoint
} from "../experiments/lib/review-flow-stage-state";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true
  })));
});

describe("阶段 checkpoint 文件", () => {
  it("writes recovery to a new atomic checkpoint while preserving old bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fermata-stage-checkpoint-"));
    temporaryDirectories.push(directory);
    const oldPath = join(directory, "old.json");
    const derivedPath = join(directory, "derived.json");
    const oldCheckpoint: StageCheckpoint = {
      schemaVersion: 1,
      expectedCaseIds: ["case-1"],
      cases: [{
        caseId: "case-1",
        status: "active",
        stages: [{ stage: "A", status: "active", workerId: "dead-worker" }]
      }]
    };
    const oldBytes = `${JSON.stringify(oldCheckpoint, null, 4)}\n`;
    await writeFile(oldPath, oldBytes, "utf8");
    const parsed = await readStageCheckpoint(oldPath);
    const derived = deriveCheckpointAfterWorkerLoss(parsed, new Set());
    await writeStageCheckpointAtomic(derivedPath, derived);
    expect(await readFile(oldPath, "utf8")).toBe(oldBytes);
    expect(await readStageCheckpoint(derivedPath)).toMatchObject({
      cases: [{ status: "orphaned_unknown" }]
    });
  });
});
