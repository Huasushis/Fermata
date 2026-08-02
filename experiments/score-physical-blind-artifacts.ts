import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  closePrivateDirectory,
  preparePrivateDirectory,
  type PrivateDirectoryHandle
} from "../scripts/private-runtime.mjs";
import { failPhysicalBlind } from "./lib/physical-blind-common";
import {
  physicalBlindCliErrorCode,
  parsePhysicalBlindCliOptions
} from "./lib/physical-blind-cli-options";
import { physicalBlindPredictionsFileName } from "./lib/physical-blind-outcomes";
import { physicalBlindContentFileName } from "./lib/physical-blind-prepare";
import { physicalBlindProfileNameSchema } from "./lib/physical-blind-profiles";
import {
  runPhysicalBlindScoreSandbox,
  verifyPhysicalBlindScoreSandbox
} from "./lib/physical-blind-score-sandbox";
import {
  openPrivateArtifactSnapshotDescriptor,
  verifyAndClosePrivateArtifactSnapshotDescriptor,
  type PrivateArtifactSnapshotDescriptor
} from "./lib/private-artifact-io";

/**
 * 正式入口不接受 environment 或评分回调。它只运行登记 profile，并用 bubblewrap
 * 网络命名空间、最小挂载、清空环境和 Node permission 启动独立 worker。
 */
export async function runScorePhysicalBlindArtifactsCli(
  argv: readonly string[]
): Promise<never> {
  const options = parsePhysicalBlindCliOptions(argv, [
    "content-directory",
    "gold-directory",
    "predictions-directory",
    "output-directory",
    "profile"
  ]);
  const profileName = physicalBlindProfileNameSchema.safeParse(options.profile);
  if (!profileName.success) {
    failPhysicalBlind("BLIND_CLI_PROFILE_INVALID");
  }
  // 每次正式评分都先用父进程本地 canary 实测子进程网络不可达、环境已清空。
  await verifyPhysicalBlindScoreSandbox();
  let contentDirectory: PrivateDirectoryHandle | undefined;
  let predictionsDirectory: PrivateDirectoryHandle | undefined;
  let content: PrivateArtifactSnapshotDescriptor | undefined;
  let predictions: PrivateArtifactSnapshotDescriptor | undefined;
  try {
    contentDirectory = preparePrivateDirectory(options["content-directory"]!);
    predictionsDirectory = preparePrivateDirectory(
      options["predictions-directory"]!
    );
    if (
      contentDirectory.created ||
      predictionsDirectory.created
    ) {
      failPhysicalBlind("BLIND_ARTIFACT_SOURCE_DIRECTORY_MISSING");
    }
    content = openPrivateArtifactSnapshotDescriptor(
      contentDirectory,
      physicalBlindContentFileName
    );
    predictions = openPrivateArtifactSnapshotDescriptor(
      predictionsDirectory,
      physicalBlindPredictionsFileName
    );
    // 第一阶段只挂载 content + prediction。可信资格通过前，父进程不打开 gold，
    // bubblewrap 也不接收 gold fd；第二评分阶段必须随可信 adapter 另行实现。
    return await runPhysicalBlindScoreSandbox({
      content,
      predictions,
      profileName: profileName.data
    });
  } finally {
    let snapshotError: unknown;
    for (const snapshot of [predictions, content]) {
      if (snapshot !== undefined) {
        try {
          verifyAndClosePrivateArtifactSnapshotDescriptor(snapshot);
        } catch (error) {
          snapshotError ??= error;
        }
      }
    }
    for (const handle of [
      predictionsDirectory,
      contentDirectory
    ]) {
      if (handle !== undefined) {
        closePrivateDirectory(handle);
      }
    }
    void options["gold-directory"];
    void options["output-directory"];
    if (snapshotError !== undefined) {
      throw snapshotError;
    }
  }
}

async function main(): Promise<void> {
  try {
    await runScorePhysicalBlindArtifactsCli(process.argv.slice(2));
  } catch (error) {
    console.error(physicalBlindCliErrorCode(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
