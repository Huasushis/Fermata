import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  physicalBlindCliErrorCode,
  parsePhysicalBlindCliOptions
} from "./lib/physical-blind-cli-options";
import { physicalBlindProfile } from "./lib/physical-blind-profiles";
import { preparePhysicalBlindArtifactsFromPrivateFile } from "./lib/physical-blind-prepare";

export function runPreparePhysicalBlindArtifactsCli(
  argv: readonly string[]
): Readonly<Record<string, string | number | boolean>> {
  const options = parsePhysicalBlindCliOptions(argv, [
    "source-directory",
    "source-file",
    "output-directory",
    "profile"
  ]);
  const profile = physicalBlindProfile(options.profile!);
  const result = preparePhysicalBlindArtifactsFromPrivateFile({
    sourceDirectory: options["source-directory"]!,
    sourceFileName: options["source-file"]!,
    outputDirectory: options["output-directory"]!,
    goldSchema: profile.goldSchema
  });
  return Object.freeze({
    status: "ok",
    sourceSchemaVersion: result.sourceSchemaVersion,
    productionEligible: result.productionEligible,
    sourceIneligibilityReasonCode: result.sourceIneligibilityReasonCode,
    sampleCount: result.sampleCount,
    contentIdentityFingerprint: result.contentIdentityFingerprint,
    contentFingerprint: result.contentFingerprint
  });
}

async function main(): Promise<void> {
  try {
    console.log(JSON.stringify(runPreparePhysicalBlindArtifactsCli(process.argv.slice(2))));
  } catch (error) {
    console.error(physicalBlindCliErrorCode(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
