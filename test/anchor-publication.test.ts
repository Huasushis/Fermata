import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  anchorDocumentFingerprint,
  prepareAnchorPublication,
  readValidatedAnchorSnapshot,
  validateAnchorCandidatesForPublication
} from "../experiments/lib/anchor-publication";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function anchorDocument(rating: number, note: string): string {
  return `${JSON.stringify({
    provisional: false,
    note,
    anchors: [{ contestId: rating, index: "A", rating, summary: `summary-${rating}` }]
  }, null, 2)}\n`;
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "fermata-anchor-publication-"));
  directories.push(directory);
  chmodSync(directory, 0o700);
  const targetPath = join(directory, "difficulty.json");
  const beforePath = join(directory, "before.private.json");
  const candidatePath = join(directory, "candidate.private.json");
  const previous = anchorDocument(800, "before");
  const candidate = anchorDocument(900, "candidate");
  writeFileSync(targetPath, previous, "utf8");
  return {
    targetPath,
    beforePath,
    candidatePath,
    target: pathToFileURL(targetPath),
    before: pathToFileURL(beforePath),
    candidateUrl: pathToFileURL(candidatePath),
    previous,
    candidate
  };
}

describe("锚点原子发布", () => {
  it("付费请求前按正式锚点契约拒绝越界或非 100 倍数候选", () => {
    expect(() =>
      validateAnchorCandidatesForPublication([
        { contestId: 1, index: "A", rating: 800 },
        { contestId: 2, index: "B", rating: 3500 }
      ])
    ).not.toThrow();
    expect(() =>
      validateAnchorCandidatesForPublication([
        { contestId: 1, index: "A", rating: 801 }
      ])
    ).toThrow("ANCHOR_CANDIDATE_CONTRACT_INVALID");
    expect(() =>
      validateAnchorCandidatesForPublication([
        { contestId: 1, index: "A", rating: 3600 }
      ])
    ).toThrow("ANCHOR_CANDIDATE_CONTRACT_INVALID");
    expect(() =>
      validateAnchorCandidatesForPublication([
        { contestId: 1, index: "A", rating: 800 },
        { contestId: 1, index: "A", rating: 900 }
      ])
    ).toThrow("ANCHOR_CANDIDATE_CONTRACT_INVALID");
  });

  it("先排他保留前后快照，再原子替换并复核哈希", () => {
    const fixture = setup();
    const prepared = prepareAnchorPublication({
      target: fixture.target,
      beforeSnapshot: fixture.before,
      candidateSnapshot: fixture.candidateUrl,
      expectedPreviousFingerprint: anchorDocumentFingerprint(fixture.previous),
      candidateDocument: fixture.candidate
    });
    expect(readFileSync(fixture.targetPath, "utf8")).toBe(fixture.previous);
    expect(readFileSync(fixture.beforePath, "utf8")).toBe(fixture.previous);
    expect(readFileSync(fixture.candidatePath, "utf8")).toBe(fixture.candidate);
    expect(lstatSync(fixture.beforePath).mode & 0o777).toBe(0o600);
    expect(lstatSync(fixture.candidatePath).mode & 0o777).toBe(0o600);

    prepared.publish();
    expect(readFileSync(fixture.targetPath, "utf8")).toBe(fixture.candidate);
    expect(readValidatedAnchorSnapshot(fixture.target).fingerprint).toBe(
      prepared.candidateFingerprint
    );
    expect(() => prepared.publish()).toThrow("ANCHOR_PUBLICATION_ALREADY_ATTEMPTED");
  });

  it("带 UTF-8 BOM 的修改前快照仍与原文件逐字节同哈希", () => {
    const fixture = setup();
    const previousBytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(fixture.previous, "utf8")
    ]);
    writeFileSync(fixture.targetPath, previousBytes);
    const expectedFingerprint = anchorDocumentFingerprint(previousBytes);

    const prepared = prepareAnchorPublication({
      target: fixture.target,
      beforeSnapshot: fixture.before,
      candidateSnapshot: fixture.candidateUrl,
      expectedPreviousFingerprint: expectedFingerprint,
      candidateDocument: fixture.candidate
    });

    const snapshotBytes = readFileSync(fixture.beforePath);
    expect(snapshotBytes.equals(previousBytes)).toBe(true);
    expect(anchorDocumentFingerprint(snapshotBytes)).toBe(expectedFingerprint);
    expect(prepared.previousFingerprint).toBe(expectedFingerprint);
  });

  it("准备后目标被改动时拒绝覆盖并保留第三方版本", () => {
    const fixture = setup();
    const prepared = prepareAnchorPublication({
      target: fixture.target,
      beforeSnapshot: fixture.before,
      candidateSnapshot: fixture.candidateUrl,
      expectedPreviousFingerprint: anchorDocumentFingerprint(fixture.previous),
      candidateDocument: fixture.candidate
    });
    const changed = anchorDocument(1000, "changed-during-generation");
    writeFileSync(fixture.targetPath, changed, "utf8");
    expect(() => prepared.publish()).toThrow("ANCHOR_TARGET_CHANGED");
    expect(readFileSync(fixture.targetPath, "utf8")).toBe(changed);
  });

  it("快照名已使用或候选损坏都在正式文件替换前失败", () => {
    const fixture = setup();
    writeFileSync(fixture.candidatePath, "occupied", "utf8");
    expect(() =>
      prepareAnchorPublication({
        target: fixture.target,
        beforeSnapshot: fixture.before,
        candidateSnapshot: fixture.candidateUrl,
        expectedPreviousFingerprint: anchorDocumentFingerprint(fixture.previous),
        candidateDocument: fixture.candidate
      })
    ).toThrow();
    expect(readFileSync(fixture.targetPath, "utf8")).toBe(fixture.previous);

    const second = setup();
    expect(() =>
      prepareAnchorPublication({
        target: second.target,
        beforeSnapshot: second.before,
        candidateSnapshot: second.candidateUrl,
        expectedPreviousFingerprint: anchorDocumentFingerprint(second.previous),
        candidateDocument: "{}"
      })
    ).toThrow("ANCHOR_CANDIDATE_INVALID");
    expect(readFileSync(second.targetPath, "utf8")).toBe(second.previous);
  });
});
