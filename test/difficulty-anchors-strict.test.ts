import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  difficultyAnchorsFileForExperimentSchema,
  loadDifficultyAnchorsStrict
} from "../experiments/lib/difficulty-anchors-strict";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeAnchors(value: unknown): URL {
  const directory = mkdtempSync(join(tmpdir(), "fermata-anchors-strict-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "anchors.json");
  writeFileSync(path, JSON.stringify(value), "utf8");
  return pathToFileURL(path);
}

describe("评测锚点严格读取", () => {
  it("合法文件返回锚点、临时状态和原始字节指纹", () => {
    const result = loadDifficultyAnchorsStrict(
      writeAnchors({
        provisional: true,
        note: "synthetic",
        anchors: [{ contestId: 1, index: "A", rating: 800, summary: "synthetic summary" }]
      })
    );
    expect(result).toMatchObject({ provisional: true, anchors: [{ contestId: 1, index: "A" }] });
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("损坏、空集或重复锚点都直接失败，不退化成空集", () => {
    expect(() => loadDifficultyAnchorsStrict(writeAnchors("not-an-object"))).toThrow();
    expect(() =>
      loadDifficultyAnchorsStrict(writeAnchors({ provisional: false, note: "", anchors: [] }))
    ).toThrow();
    const duplicate = { contestId: 1, index: "A", rating: 800, summary: "synthetic" };
    expect(() =>
      loadDifficultyAnchorsStrict(
        writeAnchors({ provisional: false, note: "", anchors: [duplicate, duplicate] })
      )
    ).toThrow();
    expect(() =>
      difficultyAnchorsFileForExperimentSchema.parse({
        provisional: false,
        note: "",
        anchors: Array.from({ length: 51 }, (_, index) => ({
          contestId: index + 1,
          index: "A",
          rating: 800,
          summary: "synthetic"
        }))
      })
    ).toThrow();
  });
});
