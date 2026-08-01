/** 锚点配置的不可部分发布事务；只处理已经通过摘要完整性校验的候选 JSON。 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { dirname } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import { difficultyAnchorsFileForExperimentSchema } from "./difficulty-anchors-strict";
import { writeNewEvaluationFile } from "./evaluation-integrity";
import { writeTextAtomically } from "./levels-calibration-state";

export interface ValidatedAnchorSnapshot {
  readonly document: string;
  readonly bytes: Uint8Array;
  readonly fingerprint: string;
}

export interface PreparedAnchorPublication {
  readonly previousFingerprint: string;
  readonly candidateFingerprint: string;
  readonly publish: () => void;
}

export function anchorDocumentFingerprint(document: string | Uint8Array): string {
  return createHash("sha256").update(document).digest("hex");
}

export interface AnchorCandidateForPublication {
  readonly contestId: number;
  readonly index: string;
  readonly rating: number;
}

/**
 * 数据清单只保证 rating 为正整数；这里在任何付费请求前再按正式锚点契约
 * 校验范围、100 倍数、题号格式、数量上限和题号唯一性。
 */
export function validateAnchorCandidatesForPublication(
  candidates: readonly AnchorCandidateForPublication[]
): void {
  try {
    difficultyAnchorsFileForExperimentSchema.parse({
      provisional: false,
      note: "candidate-contract-preflight",
      anchors: candidates.map((candidate) => ({
        contestId: candidate.contestId,
        index: candidate.index,
        rating: candidate.rating,
        summary: "candidate-contract-preflight"
      }))
    });
  } catch {
    throw new Error("ANCHOR_CANDIDATE_CONTRACT_INVALID");
  }
}

export function readValidatedAnchorSnapshot(target: URL): ValidatedAnchorSnapshot {
  let bytes: Buffer;
  try {
    bytes = readFileSync(target);
    if (bytes.byteLength > 1024 * 1024) {
      throw new Error("too-large");
    }
    // ignoreBOM=true 表示把 BOM 保留为 U+FEFF；解析时只剥离这一个字符，
    // 快照仍使用原始 bytes，因此其指纹与修改前文件逐字节一致。
    const document = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const jsonDocument = document.startsWith("\uFEFF") ? document.slice(1) : document;
    difficultyAnchorsFileForExperimentSchema.parse(JSON.parse(jsonDocument) as unknown);
    return {
      document,
      bytes: Buffer.from(bytes),
      fingerprint: anchorDocumentFingerprint(bytes)
    };
  } catch {
    throw new Error("ANCHOR_FILE_INVALID");
  }
}

/** 与报告 wx 写入相同，但接受原始 bytes，避免 BOM 或换行被文本解码改写。 */
function writeNewAnchorSnapshot(target: URL, contents: Uint8Array): void {
  const targetPath = fileURLToPath(target);
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  let directoryDescriptor: number | undefined;
  let temporaryExists = false;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    temporaryExists = true;
    const bytes = Buffer.from(contents);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (written <= 0) {
        throw new Error("short-write");
      }
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporaryPath, targetPath);
    unlinkSync(temporaryPath);
    temporaryExists = false;
    directoryDescriptor = openSync(
      dirname(targetPath),
      constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)
    );
    fsyncSync(directoryDescriptor);
  } catch {
    throw new Error("ANCHOR_SNAPSHOT_WRITE_FAILED");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 固定错误码，不输出路径。
      }
    }
    if (temporaryExists) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // 只清理本次 UUID 临时文件。
      }
    }
    if (directoryDescriptor !== undefined) {
      try {
        closeSync(directoryDescriptor);
      } catch {
        // 固定错误码，不输出路径。
      }
    }
  }
}

/**
 * 先排他保存修改前和候选快照，再返回显式 publish。publish 会在 rename 前后
 * 各校验一次哈希；现有配置在模型运行期间被别人修改时绝不静默覆盖。
 */
export function prepareAnchorPublication(input: {
  readonly target: URL;
  readonly beforeSnapshot: URL;
  readonly candidateSnapshot: URL;
  readonly expectedPreviousFingerprint: string;
  readonly candidateDocument: string;
}): PreparedAnchorPublication {
  const previous = readValidatedAnchorSnapshot(input.target);
  if (previous.fingerprint !== input.expectedPreviousFingerprint) {
    throw new Error("ANCHOR_TARGET_CHANGED");
  }
  try {
    difficultyAnchorsFileForExperimentSchema.parse(
      JSON.parse(input.candidateDocument) as unknown
    );
  } catch {
    throw new Error("ANCHOR_CANDIDATE_INVALID");
  }
  const candidateFingerprint = anchorDocumentFingerprint(input.candidateDocument);

  // 两份证据都是 wx；任一已存在都会在改动正式配置前失败。
  writeNewAnchorSnapshot(input.beforeSnapshot, previous.bytes);
  if (
    anchorDocumentFingerprint(readFileSync(input.beforeSnapshot)) !==
    input.expectedPreviousFingerprint
  ) {
    throw new Error("ANCHOR_BEFORE_SNAPSHOT_HASH_MISMATCH");
  }
  writeNewEvaluationFile(input.candidateSnapshot, input.candidateDocument);

  let attempted = false;
  return {
    previousFingerprint: previous.fingerprint,
    candidateFingerprint,
    publish: () => {
      if (attempted) {
        throw new Error("ANCHOR_PUBLICATION_ALREADY_ATTEMPTED");
      }
      attempted = true;
      if (
        readValidatedAnchorSnapshot(input.target).fingerprint !==
        input.expectedPreviousFingerprint
      ) {
        throw new Error("ANCHOR_TARGET_CHANGED");
      }
      writeTextAtomically(input.target, input.candidateDocument);
      if (
        readValidatedAnchorSnapshot(input.target).fingerprint !== candidateFingerprint
      ) {
        throw new Error("ANCHOR_PUBLICATION_HASH_MISMATCH");
      }
    }
  };
}
