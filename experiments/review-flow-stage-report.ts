import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { readStageCheckpoint } from "./lib/review-flow-stage-checkpoint-file";
import {
  buildStageCalibrationReport,
  type DualAxisCalibrationCase
} from "./lib/review-flow-stage-state";

const argumentsSchema = z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)]);
const caseSchema = z.object({
  predictedVerdict: z.enum(["approve", "request_changes", "reject"]),
  humanVerdict: z.enum(["approve", "request_changes", "reject"]),
  predictedCodeforcesDifficulty: z.number().int().min(800).max(3500).multipleOf(100).nullable(),
  frozenCodeforcesDifficulty: z.number().int().min(800).max(3500).multipleOf(100).nullable()
}).strict();

export async function writeReviewFlowStageReport(input: {
  readonly checkpointPath: string;
  readonly casesPath: string;
  readonly outputPath: string;
}): Promise<void> {
  const checkpoint = await readStageCheckpoint(input.checkpointPath);
  const cases = z.array(caseSchema).parse(
    JSON.parse(await readFile(input.casesPath, "utf8")) as unknown
  ) as readonly DualAxisCalibrationCase[];
  const report = buildStageCalibrationReport(checkpoint, cases);
  await writeFile(input.outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [checkpointPath, casesPath, outputPath] = argumentsSchema.parse(process.argv.slice(2));
  await writeReviewFlowStageReport({ checkpointPath, casesPath, outputPath });
}
