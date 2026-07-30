/**
 * 综合评审（verdict）流水线的判定实验。
 *
 * 覆盖两类场景，对应产品要求“用通过/不通过的样本检验判定标准”：
 *   1. 正常题：没有任何相似度警告，期望结论不是 reject（approve 或 request_changes 都算合理）；
 *   2. 疑似原题：注入一条**人工构造的原题机（Anklang）审核条目**（相似度 0.95、
 *      候选说明写明题面几乎一致），期望触发“相似度超阈值 + 模型确认同题”的强制
 *      不通过规则（forcedDuplicateReject）。
 *
 * 难度输入直接用数据集的官方 rating 构造（本实验只检验 verdict 的判断与阈值规则，
 * 不重复评上游三条流水线）。
 *
 * 用法：
 *   npm run experiment:eval-verdict -- --label=v1
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { getProviderCredentials, loadConfig, type ProfileConfig } from "../src/config";
import { logError, logInfo, logWarn } from "../src/logger";
import { runVerdictPipeline } from "../src/pipelines/verdict";
import type { PipelineModelConfig, ReviewTaskItem, ReviewTaskProblem } from "../src/pipelines/types";
import { mapWithConcurrency } from "./lib/concurrency";

const DATA_DIR = new URL("./data/levels/", import.meta.url);
const RESULTS_DIR = new URL("./results/", import.meta.url);
const RAW_DIR = new URL("./results/raw/", import.meta.url);
const CASES_PER_GROUP = Number.parseInt(process.env.VERDICT_CASES_PER_GROUP ?? "3", 10);

const datasetItemSchema = z.object({
  contestId: z.number().int(),
  index: z.string().min(1),
  rating: z.number().int(),
  statement: z.string().min(1),
  editorial: z.string().min(1).nullable()
});

type DatasetItem = z.infer<typeof datasetItemSchema>;

function parseLabelArg(): string {
  const arg = process.argv.find((value) => value.startsWith("--label="));
  return arg?.slice("--label=".length) ?? "v1";
}

function loadDataset(): DatasetItem[] {
  let fileNames: string[] = [];
  try {
    fileNames = readdirSync(DATA_DIR).filter((name) => name.endsWith(".json"));
  } catch {
    // 目录不存在时按空集处理。
  }
  const items: DatasetItem[] = [];
  for (const fileName of fileNames) {
    try {
      const parsed = datasetItemSchema.parse(
        JSON.parse(readFileSync(new URL(fileName, DATA_DIR), "utf8"))
      );
      if (parsed.editorial !== null) {
        items.push(parsed);
      }
    } catch (error) {
      logWarn("跳过无法解析的数据文件", { fileName, reason: String(error).slice(0, 120) });
    }
  }
  return items.sort((left, right) => left.rating - right.rating);
}

function toProblem(item: DatasetItem): ReviewTaskProblem {
  return {
    id: `verdict-${item.contestId}${item.index}`,
    revision: 1,
    reviewRound: 1,
    contentHash: createHash("sha256").update(item.statement, "utf8").digest("hex"),
    title: `CF${item.contestId}${item.index}`,
    type: "traditional",
    tagIds: ["calibration.sample"],
    basicStatement: item.statement,
    basicSolution: item.editorial ?? ""
  };
}

/** 人工构造的原题机审核条目：相似度超过阈值，候选说明明确指向“同一道题”。 */
function fabricatedSimilarityItem(problem: ReviewTaskProblem): ReviewTaskItem {
  return {
    id: randomUUID(),
    type: "org.ustc.urmotiv.anklang.similarity",
    summary: "发现 1 道候选题，最高相似度为 95%。",
    data: {
      apiVersion: "1",
      contentHash: problem.contentHash,
      checkedAt: new Date().toISOString(),
      candidates: [
        {
          source: "yuantiji",
          externalId: "public-archive-001",
          title: problem.title,
          url: "https://example.test/problem/public-archive-001",
          similarity: 0.95,
          sameProblemSuggestion: true,
          explanation: "题面叙述、输入输出格式与数据范围与该公开题完全一致，仅变量命名不同。"
        }
      ],
      recommendation: {
        blockSubmission: true,
        message: "候选题与本题几乎完全一致，疑似同一道公开题。"
      }
    },
    contentHash: problem.contentHash,
    createdAt: new Date().toISOString()
  };
}

interface CaseResult {
  readonly caseKind: "normal" | "fabricated_duplicate";
  readonly problemLabel: string;
  readonly rating: number;
  readonly verdict: string;
  readonly forcedDuplicateReject: boolean;
  readonly highestKnownSimilarity: number;
  readonly expectationMet: boolean;
}

async function main(): Promise<void> {
  const label = parseLabelArg();
  const config = loadConfig({ env: process.env });
  const profiles: Record<string, ProfileConfig | undefined> = config.models.profiles;
  const profile = profiles[config.models.defaults.modelProfileName];
  if (profile === undefined) {
    logError("默认模型档位不存在", undefined, {
      profileName: config.models.defaults.modelProfileName
    });
    process.exitCode = 1;
    return;
  }
  const credentials = getProviderCredentials(config, profile.verdict.provider);
  if (credentials === undefined) {
    logError("verdict 流水线的服务商没有配置密钥", undefined, { provider: profile.verdict.provider });
    process.exitCode = 1;
    return;
  }
  const model: PipelineModelConfig = {
    spec: profile.verdict,
    credentials,
    runtime: {
      timeoutMs: config.models.timeouts.llmRequestMs,
      maxAttempts: config.models.retry.maxAttempts,
      baseDelayMs: config.models.retry.baseDelayMs
    }
  };

  const dataset = loadDataset();
  if (dataset.length < CASES_PER_GROUP * 2) {
    logError("数据集不足以抽取两组样本", undefined, {
      available: dataset.length,
      required: CASES_PER_GROUP * 2
    });
    process.exitCode = 1;
    return;
  }
  // 均匀取样：正常组取偶数位、构造组取奇数位，保证两组难度分布相近。
  const normalCases = dataset.filter((_, index) => index % 2 === 0).slice(0, CASES_PER_GROUP);
  const duplicateCases = dataset.filter((_, index) => index % 2 === 1).slice(0, CASES_PER_GROUP);
  logInfo("开始 verdict 判定实验", {
    label,
    normal: normalCases.length,
    fabricatedDuplicate: duplicateCases.length
  });

  const concurrency = Number.parseInt(process.env.EVAL_CONCURRENCY ?? "4", 10);
  const results: CaseResult[] = [];
  const runCase = async (item: DatasetItem, caseKind: CaseResult["caseKind"]): Promise<void> => {
    const problem = toProblem(item);
    const reviewItems = caseKind === "fabricated_duplicate" ? [fabricatedSimilarityItem(problem)] : [];
    try {
      const output = await runVerdictPipeline({
        problem,
        reviewItems,
        difficulty: {
          rating: item.rating,
          confidence: 0.8,
          rationale: "实验输入：直接采用官方难度。"
        },
        thinking: {
          level: 3,
          signals: { solved: true, approachSimilarity: 0.6, selfCorrections: 1, keyInsightCount: 2 },
          solverNarrativeLength: 600,
          rationale: "实验固定输入。"
        },
        coding: {
          level: 3,
          signals: {
            effectiveLineCount: 60,
            maxNestingDepth: 3,
            detectedDataStructures: [],
            maxDataStructureWeight: 0
          },
          referenceCodeLength: 1500
        },
        expectedRound: 1,
        model
      });
      const expectationMet =
        caseKind === "fabricated_duplicate"
          ? output.forcedDuplicateReject && output.review.verdict === "reject"
          : output.review.verdict !== "reject";
      results.push({
        caseKind,
        problemLabel: problem.title,
        rating: item.rating,
        verdict: output.review.verdict,
        forcedDuplicateReject: output.forcedDuplicateReject,
        highestKnownSimilarity: output.highestKnownSimilarity,
        expectationMet
      });
      logInfo("完成一例", {
        caseKind,
        problem: problem.title,
        verdict: output.review.verdict,
        forcedDuplicateReject: output.forcedDuplicateReject,
        expectationMet
      });
    } catch (error) {
      logError("这一例判定失败，跳过", error, { caseKind, problem: problem.title });
    }
  };

  await mapWithConcurrency(normalCases, concurrency, (item) => runCase(item, "normal"));
  await mapWithConcurrency(duplicateCases, concurrency, (item) =>
    runCase(item, "fabricated_duplicate")
  );

  const byKind = (kind: CaseResult["caseKind"]) => results.filter((row) => row.caseKind === kind);
  const summary = {
    label,
    generatedAt: new Date().toISOString(),
    normal: {
      total: byKind("normal").length,
      metExpectation: byKind("normal").filter((row) => row.expectationMet).length
    },
    fabricatedDuplicate: {
      total: byKind("fabricated_duplicate").length,
      metExpectation: byKind("fabricated_duplicate").filter((row) => row.expectationMet).length
    }
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(RAW_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(
    new URL(`verdict-${label}-${stamp}.json`, RAW_DIR),
    JSON.stringify({ summary, results }, null, 2),
    "utf8"
  );
  const markdown = [
    `# 综合评审判定实验（${label}）`,
    "",
    `- 生成时间：${summary.generatedAt}`,
    `- 正常组：${summary.normal.metExpectation}/${summary.normal.total} 符合预期（结论不是不通过）`,
    `- 构造原题组：${summary.fabricatedDuplicate.metExpectation}/${summary.fabricatedDuplicate.total} 符合预期（触发强制不通过）`,
    "",
    "构造原题组的做法：给题目注入一条人工构造的原题机审核条目（相似度 0.95、说明指向同一道",
    "公开题），检验“相似度超过阈值且模型确认同题即强制不通过”的规则是否可靠。",
    "",
    "| 组别 | 题目 | rating | 结论 | 强制不通过 | 已知相似度 | 符合预期 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...results.map(
      (row) =>
        `| ${row.caseKind === "normal" ? "正常" : "构造原题"} | ${row.problemLabel} | ${row.rating} | ${row.verdict} | ${row.forcedDuplicateReject ? "是" : "否"} | ${row.highestKnownSimilarity.toFixed(2)} | ${row.expectationMet ? "✓" : "✗"} |`
    ),
    "",
    "## 结论",
    "",
    summary.fabricatedDuplicate.metExpectation === summary.fabricatedDuplicate.total &&
    summary.normal.metExpectation === summary.normal.total
      ? "- 两组全部符合预期：阈值规则与模型判断在本样本上可靠。扩大样本后复核。"
      : "- 存在不符合预期的用例，启用前需要检查 verdict 提示词或阈值（config/models.yaml 的 thresholds）。"
  ].join("\n");
  writeFileSync(new URL(`verdict-${label}-report.md`, RESULTS_DIR), markdown, "utf8");
  logInfo("verdict 实验完成", {
    label,
    normalMet: `${summary.normal.metExpectation}/${summary.normal.total}`,
    duplicateMet: `${summary.fabricatedDuplicate.metExpectation}/${summary.fabricatedDuplicate.total}`
  });
}

main().catch((error) => {
  logError("experiments/eval-verdict.ts 执行失败", error);
  process.exitCode = 1;
});
