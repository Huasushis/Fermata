import { writeSync } from "node:fs";
import { acquireAnchorPublicationLock } from "../../experiments/lib/anchor-publication-lock";

const [containingWorkspace, privateRoot] = process.argv.slice(2);
if (containingWorkspace === undefined || privateRoot === undefined) {
  process.exit(2);
}

acquireAnchorPublicationLock({
  runId: "anchor-crash-case",
  targetFingerprint: "a".repeat(64),
  privateRoot,
  containingWorkspace,
  now: () => new Date("2026-08-01T00:00:00.000Z")
});

// 故意不 release：模拟付费调用在途时进程被不可捕获地终止。
writeSync(1, Buffer.from("ANCHOR_LOCK_ACQUIRED\n", "utf8"));
process.kill(process.pid, "SIGKILL");
