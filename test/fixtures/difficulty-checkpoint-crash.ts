import { DifficultyEvaluationCheckpoint } from "../../experiments/lib/difficulty-evaluation-checkpoint";
import { writeSync } from "node:fs";

const [containingWorkspace, privateRoot] = process.argv.slice(2);
if (containingWorkspace === undefined || privateRoot === undefined) {
  process.exit(2);
}

const checkpoint = new DifficultyEvaluationCheckpoint({
  label: "crash-case",
  reportRunId: "crash-case-2026-08-01T00-00-00-000Z-12345678",
  datasetManifestFingerprint: "a".repeat(64),
  configurationFingerprint: "a".repeat(64),
  expectedSampleIds: ["source-a", "source-b"],
  privateRoot,
  containingWorkspace,
  now: () => new Date("2026-08-01T00:00:00.000Z")
});
checkpoint.markActive("source-a");

// 故意不 close：模拟付费调用在途时进程被不可捕获地终止。
writeSync(1, Buffer.from("ACTIVE_PERSISTED\n", "utf8"));
process.kill(process.pid, "SIGKILL");
