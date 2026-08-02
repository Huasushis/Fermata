import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  physicalBlindCliErrorCode,
  parsePhysicalBlindCliOptions
} from "./lib/physical-blind-cli-options";
import { sealPhysicalBlindOutcomesFromPrivateFiles } from "./lib/physical-blind-outcomes";
import { physicalBlindProfile } from "./lib/physical-blind-profiles";

export function runSealPhysicalBlindPredictionsCli(
  argv: readonly string[]
): never {
  const options = parsePhysicalBlindCliOptions(argv, [
    "content-directory",
    "outcomes-directory",
    "output-directory",
    "profile"
  ]);
  const profile = physicalBlindProfile(options.profile!);
  return sealPhysicalBlindOutcomesFromPrivateFiles({
    contentDirectory: options["content-directory"]!,
    outcomesDirectory: options["outcomes-directory"]!,
    outputDirectory: options["output-directory"]!,
    predictionSchema: profile.predictionSchema
  });
}

async function main(): Promise<void> {
  try {
    console.log(JSON.stringify(runSealPhysicalBlindPredictionsCli(process.argv.slice(2))));
  } catch (error) {
    console.error(physicalBlindCliErrorCode(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
