import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join as joinPath } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { LlmRequestError } from "../src/llm";
import {
  createEvaluationRunId,
  completedEvaluationChainMarkerExists,
  evaluationConfigurationFingerprint,
  executionFailure,
  hasUnknownPrefixedEnvironmentKeys,
  parseBoundedPositiveInteger,
  parseEvaluationLabel,
  preflightJsonDataset,
  reconcileEvaluation,
  validateGeneratedAnchorSummary,
  writeEvaluationReportArtifactGroup,
  writeNewEvaluationFile
} from "../experiments/lib/evaluation-integrity";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(joinPath(tmpdir(), "fermata-evaluation-integrity-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("preflightJsonDataset", () => {
  it("损坏 JSON 和符号链接都会导致预检失败，不宽松跳过", () => {
    const directory = temporaryDirectory();
    writeFileSync(joinPath(directory, "valid.json"), JSON.stringify({ id: 1 }), "utf8");
    writeFileSync(joinPath(directory, "broken.json"), "{", "utf8");
    writeFileSync(joinPath(directory, "unexpected.txt"), "not a dataset file", "utf8");
    symlinkSync(joinPath(directory, "valid.json"), joinPath(directory, "linked.json"));

    const result = preflightJsonDataset(pathToFileURL(`${directory}/`), z.object({ id: z.number() }));

    expect(result.fileCount).toBe(4);
    expect(result.sources).toHaveLength(1);
    expect(result.failures.map((failure) => failure.code).sort()).toEqual([
      "DATASET_FILE_INVALID",
      "DATASET_SYMLINK_REJECTED",
      "DATASET_UNEXPECTED_ENTRY"
    ]);
    expect(JSON.stringify(result)).not.toContain("broken.json");
    expect(JSON.stringify(result)).not.toContain(directory);
  });

  it("拒绝任何非法 UTF-8，不让不同原始字节归一成替换字符", () => {
    const directory = temporaryDirectory();
    writeFileSync(
      joinPath(directory, "invalid-a.json"),
      Buffer.concat([Buffer.from('{"id":"'), Buffer.from([0xff]), Buffer.from('"}')])
    );
    writeFileSync(
      joinPath(directory, "invalid-b.json"),
      Buffer.concat([Buffer.from('{"id":"'), Buffer.from([0xfe]), Buffer.from('"}')])
    );

    const result = preflightJsonDataset(
      pathToFileURL(`${directory}/`),
      z.object({ id: z.string() })
    );
    expect(result.sources).toHaveLength(0);
    expect(result.failures.map((failure) => failure.code)).toEqual([
      "DATASET_FILE_INVALID_UTF8",
      "DATASET_FILE_INVALID_UTF8"
    ]);
  });

  it("在读取内容前限制文件数、单文件大小和总大小", () => {
    const directory = temporaryDirectory();
    writeFileSync(joinPath(directory, "a.json"), JSON.stringify({ id: "a" }), "utf8");
    writeFileSync(joinPath(directory, "b.json"), JSON.stringify({ id: "b" }), "utf8");
    const url = pathToFileURL(`${directory}/`);
    const schema = z.object({ id: z.string() });

    expect(preflightJsonDataset(url, schema, { maximumFiles: 1 }).failures[0]?.code).toBe(
      "DATASET_FILE_COUNT_EXCEEDED"
    );
    expect(
      preflightJsonDataset(url, schema, {
        maximumFiles: 2,
        maximumFileBytes: 5,
        maximumTotalBytes: 10
      }).failures.map((failure) => failure.code)
    ).toEqual(["DATASET_FILE_TOO_LARGE", "DATASET_FILE_TOO_LARGE"]);
    expect(
      preflightJsonDataset(url, schema, {
        maximumFiles: 2,
        maximumFileBytes: 100,
        maximumTotalBytes: 15
      }).failures.map((failure) => failure.code)
    ).toContain("DATASET_TOTAL_SIZE_EXCEEDED");
  });
});

describe("reconcileEvaluation", () => {
  it("没有结果的 expected 样本被判为缺失，报告不完整", () => {
    const result = reconcileEvaluation({
      expectedSampleIds: ["a", "b"],
      succeededSampleIds: ["a"],
      failures: []
    });
    expect(result).toMatchObject({ expected: 2, succeeded: 1, failed: 1, complete: false });
    expect(result.failures[0]?.code).toBe("EVALUATION_SAMPLE_MISSING");
  });

  it("499、主动取消和显式跳过都会让报告不完整", () => {
    const result = reconcileEvaluation({
      expectedSampleIds: ["http-499", "cancelled", "skipped"],
      succeededSampleIds: [],
      failures: [
        executionFailure("http-499", new LlmRequestError("LLM_HTTP_ERROR", 499)),
        executionFailure("cancelled", new LlmRequestError("LLM_CANCELLED")),
        { sampleId: "skipped", phase: "execution", code: "EVALUATION_SAMPLE_SKIPPED" }
      ]
    });
    expect(result).toMatchObject({ expected: 3, succeeded: 0, failed: 3, complete: false });
    expect(result.failures).toContainEqual(
      expect.objectContaining({ sampleId: "http-499", code: "LLM_HTTP_ERROR", httpStatus: 499 })
    );
  });

  it("每个 expected 样本恰好成功一次时才完整", () => {
    expect(
      reconcileEvaluation({
        expectedSampleIds: ["a", "b"],
        succeededSampleIds: ["b", "a"],
        failures: []
      })
    ).toEqual({ expected: 2, succeeded: 2, failed: 0, complete: true, failures: [] });
  });
});

describe("实验身份与配置指纹", () => {
  it("整数环境变量不接受小数、后缀或越界值", () => {
    expect(parseBoundedPositiveInteger(undefined, 6, 32, "EVAL_CONCURRENCY")).toBe(6);
    expect(parseBoundedPositiveInteger("32", 6, 32, "EVAL_CONCURRENCY")).toBe(32);
    for (const invalid of ["0", "-1", "1.5", "6junk", "33"]) {
      expect(() => parseBoundedPositiveInteger(invalid, 6, 32, "EVAL_CONCURRENCY")).toThrow();
    }
  });

  it("未知 EVAL_* 变量会 fail closed，变量值不进入结果", () => {
    const allowed = ["EVAL_CONCURRENCY", "EVAL_DATASET_MANIFEST_PATH"];
    expect(
      hasUnknownPrefixedEnvironmentKeys(
        { EVAL_CONCURRENCY: "2", EVAL_DATASET_MANIFEST_PATH: "/private/manifest", PATH: "/bin" },
        "EVAL_",
        allowed
      )
    ).toBe(false);
    expect(
      hasUnknownPrefixedEnvironmentKeys(
        { EVAL_CONCURRENCY: "2", EVAL_UNSAFE_UNKNOWN: "secret-value" },
        "EVAL_",
        allowed
      )
    ).toBe(true);
  });

  it("标签不能携带路径，运行 id 包含时间和唯一后缀", () => {
    expect(() => parseEvaluationLabel("../old-report", "baseline")).toThrow();
    expect(createEvaluationRunId("baseline", new Date("2026-08-01T00:00:00.000Z"), "12345678-abcd")).toBe(
      "baseline-2026-08-01T00-00-00-000Z-12345678abcd"
    );
  });

  it("阈值变化会改变配置指纹", () => {
    const first = evaluationConfigurationFingerprint({
      experimentVersion: "v1",
      thresholds: { duplicateSimilarityReject: 0.9 }
    });
    const second = evaluationConfigurationFingerprint({
      experimentVersion: "v1",
      thresholds: { duplicateSimilarityReject: 0.95 }
    });
    expect(first).not.toBe(second);
  });

  it("新报告写入使用排他创建，绝不覆盖已有文件", () => {
    const directory = temporaryDirectory();
    const url = pathToFileURL(joinPath(directory, "report.json"));
    writeNewEvaluationFile(url, "first");
    expect(lstatSync(url).mode & 0o777).toBe(0o600);
    expect(() => writeNewEvaluationFile(url, "second")).toThrow();
  });

  it("报告组最后写 completion marker，并逐份绑定内容哈希", () => {
    const directory = temporaryDirectory();
    const resultsPath = joinPath(directory, "results");
    const rawPath = joinPath(resultsPath, "raw");
    mkdirSync(rawPath, { recursive: true });
    const results = pathToFileURL(`${resultsPath}/`);
    const raw = pathToFileURL(`${rawPath}/`);
    const group = writeEvaluationReportArtifactGroup({
      resultsDirectory: results,
      rawDirectory: raw,
      prefix: "difficulty",
      executionRunId: "run-a",
      chainRunId: "chain-a",
      experimentComplete: true,
      rawJson: "raw-content",
      summaryJson: "summary-content",
      markdown: "markdown-content"
    });
    const marker = JSON.parse(
      readFileSync(joinPath(resultsPath, group.completionFileName), "utf8")
    ) as { artifacts: Record<string, { sha256: string }> };
    const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
    expect(marker.artifacts.raw?.sha256).toBe(hash("raw-content"));
    expect(marker.artifacts.summary?.sha256).toBe(hash("summary-content"));
    expect(marker.artifacts.markdown?.sha256).toBe(hash("markdown-content"));
    expect(completedEvaluationChainMarkerExists(results, "difficulty", "chain-a")).toBe(true);
    expect(lstatSync(joinPath(resultsPath, group.completionFileName)).mode & 0o777).toBe(0o600);

    expect(() =>
      writeEvaluationReportArtifactGroup({
        resultsDirectory: results,
        rawDirectory: raw,
        prefix: "difficulty",
        executionRunId: "run-b",
        chainRunId: "chain-a",
        experimentComplete: true,
        rawJson: "other",
        summaryJson: "other",
        markdown: "other"
      })
    ).toThrow("EVALUATION_CHAIN_ALREADY_PUBLISHED");
    expect(() => lstatSync(joinPath(rawPath, "difficulty-run-b-raw.json"))).toThrow();
  });

  it("前三份报告半写时没有 completion marker，不能冒充完整报告组", () => {
    const directory = temporaryDirectory();
    const resultsPath = joinPath(directory, "results");
    const rawPath = joinPath(resultsPath, "raw");
    mkdirSync(rawPath, { recursive: true });
    writeFileSync(joinPath(resultsPath, "difficulty-run-c-summary.json"), "occupied", "utf8");
    expect(() =>
      writeEvaluationReportArtifactGroup({
        resultsDirectory: pathToFileURL(`${resultsPath}/`),
        rawDirectory: pathToFileURL(`${rawPath}/`),
        prefix: "difficulty",
        executionRunId: "run-c",
        chainRunId: null,
        experimentComplete: false,
        rawJson: "raw",
        summaryJson: "summary",
        markdown: "markdown"
      })
    ).toThrow();
    expect(() => lstatSync(joinPath(resultsPath, "difficulty-run-c-completion.json"))).toThrow();
  });
});

describe("锚点摘要发布门", () => {
  it("只接受不超过 80 字的单行概括", () => {
    expect(
      validateGeneratedAnchorSummary(
        "给定一个数组，请输出满足条件的答案。",
        "  使用动态规划维护前缀状态。  "
      )
    ).toBe("使用动态规划维护前缀状态。");
    expect(() => validateGeneratedAnchorSummary("合成题面", "x".repeat(81))).toThrow();
    expect(() => validateGeneratedAnchorSummary("合成题面", "第一行\n第二行")).toThrow();
    expect(() => validateGeneratedAnchorSummary("合成题面", "```code```")).toThrow();
  });

  it("明显连续复述题面时整条拒绝，不截断", () => {
    const statement = "请计算所有区间中最大的元素之和并输出结果。";
    expect(() =>
      validateGeneratedAnchorSummary(statement, "计算所有区间中最大的元素之和并输出结果。")
    ).toThrow();
    expect(() =>
      validateGeneratedAnchorSummary(
        "ABCDEFGHIJKLMNO 是合成题面中的连续片段。",
        "ABCDEFGHIJKLMNO，再用动态规划求解。"
      )
    ).toThrow();
  });
});
