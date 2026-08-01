/** 评测专用的严格锚点读取；不采用生产运行时“损坏则退化为空”的容错语义。 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { TextDecoder } from "node:util";
import { z } from "zod";
import type { DifficultyAnchor } from "../../src/pipelines/difficulty";

const anchorSchema = z
  .object({
    contestId: z.number().int().positive(),
    index: z.string().regex(/^[A-Z][0-9]{0,7}$/),
    rating: z.number().int().min(800).max(3500).multipleOf(100),
    summary: z.string().trim().min(1).max(2_000)
  })
  .strict();

export const difficultyAnchorsFileForExperimentSchema = z
  .object({
    provisional: z.boolean(),
    note: z.string().max(20_000),
    anchors: z.array(anchorSchema).min(1).max(50)
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.anchors.map((anchor) => `${anchor.contestId}#${anchor.index}`);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["anchors"], message: "锚点题号不能重复。" });
    }
  });

export interface StrictDifficultyAnchors {
  readonly anchors: readonly DifficultyAnchor[];
  readonly provisional: boolean;
  readonly fingerprint: string;
}

export function loadDifficultyAnchorsStrict(filePath: URL): StrictDifficultyAnchors {
  const content = readFileSync(filePath);
  if (content.byteLength > 1024 * 1024) {
    throw new Error("DIFFICULTY_ANCHORS_TOO_LARGE");
  }
  const document = new TextDecoder("utf-8", { fatal: true }).decode(content);
  const parsed = difficultyAnchorsFileForExperimentSchema.parse(JSON.parse(document) as unknown);
  return {
    anchors: parsed.anchors,
    provisional: parsed.provisional,
    fingerprint: createHash("sha256").update(content).digest("hex")
  };
}
