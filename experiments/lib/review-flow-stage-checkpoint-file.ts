import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { StageCheckpoint } from "./review-flow-stage-state";

const stageCheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  expectedCaseIds: z.array(z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/u)),
  cases: z.array(z.object({
    caseId: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/u),
    status: z.enum(["pending", "active", "completed", "failed", "orphaned_unknown"]),
    stages: z.array(z.unknown())
  }).passthrough())
}).passthrough();

/** 读取后返回独立对象；派生恢复状态必须写到新路径，绝不覆写旧 checkpoint。 */
export async function readStageCheckpoint(path: string): Promise<StageCheckpoint> {
  const text = await readFile(path, "utf8");
  return parseStageCheckpoint(JSON.parse(text) as unknown);
}

/** 同目录临时文件 + rename，避免留下半份 checkpoint。 */
export async function writeStageCheckpointAtomic(
  targetPath: string,
  checkpoint: StageCheckpoint
): Promise<void> {
  const normalized = parseStageCheckpoint(checkpoint);
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  await rename(temporaryPath, targetPath);
}

export function parseStageCheckpoint(value: unknown): StageCheckpoint {
  const parsed = stageCheckpointSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("REVIEW_FLOW_STAGE_CHECKPOINT_SCHEMA_INVALID");
  }
  if (new Set(parsed.data.expectedCaseIds).size !== parsed.data.expectedCaseIds.length) {
    throw new Error("REVIEW_FLOW_STAGE_CHECKPOINT_DUPLICATE_CASE");
  }
  return structuredClone(parsed.data) as StageCheckpoint;
}
