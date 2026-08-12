import { describe, expect, it } from "vitest";
import { parseDevelopmentSmokeCli } from "../experiments/run-development-smoke";

const runId = "a".repeat(64);

describe("development smoke CLI", () => {
  it("defaults to offline preflight and requires explicit Phase 1 release", () => {
    expect(parseDevelopmentSmokeCli([])).toEqual({ mode: "preflight" });
    expect(parseDevelopmentSmokeCli(["--preflight"]))
      .toEqual({ mode: "preflight" });
    expect(parseDevelopmentSmokeCli(["--network-phase0"]))
      .toEqual({ mode: "network-phase0" });
    expect(parseDevelopmentSmokeCli([
      "--network-phase0",
      `--resume=${runId}`
    ])).toEqual({ mode: "network-phase0", resumeRunId: runId });
    expect(parseDevelopmentSmokeCli([
      "--preflight-phase1",
      `--resume=${runId}`
    ])).toEqual({ mode: "phase1-preflight", resumeRunId: runId });
    expect(parseDevelopmentSmokeCli([
      "--network-phase1",
      `--resume=${runId}`,
      "--release-phase1"
    ])).toEqual({
      mode: "network-phase1",
      resumeRunId: runId,
      releaseAuthorized: true
    });
  });

  it.each([
    ["--network"],
    ["--phase1"],
    ["--network-phase1"],
    ["--network-phase1", `--resume=${runId}`],
    ["--network-phase1", "--release-phase1"],
    ["--preflight-phase1"],
    ["--preflight-phase1", `--resume=${runId}`, "--release-phase1"],
    ["--network-phase0", "--resume=short"],
    ["--network-phase0", `--resume=${runId}`, "extra"],
    ["--preflight", "extra"]
  ])("rejects every unregistered launch shape %#", (...argv: string[]) => {
    expect(() => parseDevelopmentSmokeCli(argv)).toThrow(
      "DEVELOPMENT_SMOKE_ARGUMENTS_INVALID"
    );
  });
});
