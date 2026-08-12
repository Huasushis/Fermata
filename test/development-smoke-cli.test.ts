import { describe, expect, it } from "vitest";
import { parseDevelopmentSmokeCli } from "../experiments/run-development-smoke";

const runId = "a".repeat(64);

describe("development smoke CLI", () => {
  it("defaults to offline preflight and requires an explicit network phase", () => {
    expect(parseDevelopmentSmokeCli([])).toEqual({ networkPhase0: false });
    expect(parseDevelopmentSmokeCli(["--preflight"]))
      .toEqual({ networkPhase0: false });
    expect(parseDevelopmentSmokeCli(["--network-phase0"]))
      .toEqual({ networkPhase0: true });
    expect(parseDevelopmentSmokeCli([
      "--network-phase0",
      `--resume=${runId}`
    ])).toEqual({ networkPhase0: true, resumeRunId: runId });
  });

  it.each([
    ["--network"],
    ["--phase1"],
    ["--network-phase1"],
    ["--network-phase0", "--resume=short"],
    ["--network-phase0", `--resume=${runId}`, "extra"],
    ["--preflight", "extra"]
  ])("rejects every unregistered launch shape %#", (...argv: string[]) => {
    expect(() => parseDevelopmentSmokeCli(argv)).toThrow(
      "DEVELOPMENT_SMOKE_ARGUMENTS_INVALID"
    );
  });
});
