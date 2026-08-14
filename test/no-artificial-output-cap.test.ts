/**
 * 仓库级不变量：项目不再为任何模型请求设置人工输出上限。
 *
 * 扫描 src/ 与 experiments/（不含 experiments/results/ 历史证据）的全部
 * .ts/.mjs 源文件，断言不存在任何一行同时满足：
 *   1. 出现输出上限关键字（maxOutputTokens / max_tokens / MAX_TOKENS /
 *      maxTokens / outputLimit / 输出上限）；
 *   2. 出现低于提供商硬上限（maximumExplicitLlmOutputTokens = 384000）的
 *      人工小上限字面量（2k/4k/8k/16k/32k/64k 系列）。
 *
 * 显式允许的例外：
 *   - 注释行（例如说明"提供商默认 max_tokens=4096"的注释）不构成实际请求参数；
 *   - experiments/lib/development-smoke-launcher.ts 中旧 checkpoint 读路径的
 *     反向兼容 union（32k/24k/12k/8k）——历史 checkpoint 写的就是旧预算，读路径
 *     按设计保留它们，写路径仍是严格 z.literal(384_000)。
 *
 * test/ 目录不扫描：那里的 0/-1/超限值/旧 fixture 是显式拒绝行为夹具，不是
 * 实际模型请求。生产或探针一旦重新引入人工输出上限，本测试必须失败。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { maximumExplicitLlmOutputTokens } from "../src/llm";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

// 输出上限关键字：出现其中任意一个的行才会被检查数值。
const outputCapKeyword = /maxOutputTokens|max_tokens|MAX_TOKENS|maxTokens|outputLimit|输出上限/u;
// 低于提供商硬上限的人工小上限字面量（2k/4k/8k/16k/32k/64k 系列）。
// 带下划线形式需要数字/下划线边界，避免把 512_000、768_000、18_000_000 等
// 更大数值的子串（如 12_000、8_000）误判成人工上限。
const artificialCapLiteral =
  /(?:^|[^0-9_])(?:2_048|4_096|8_192|16_384|32_000|24_000|12_000|8_000)(?:$|[^0-9_])|\b(?:2048|4096|8192|2000|16000|16384|32768|65536)\b/u;
// 注释行（*、//、/*、*/ 开头）不构成实际请求参数。
const commentLine = /^\s*(?:\*|\/\/|\/\*|\*\/)/u;

// 显式豁免：旧 checkpoint 读路径的反向兼容 union（已生成的历史 checkpoint
// 写的是旧预算 32k/24k/12k/8k；读路径按设计保留它们）。
const legacyReadUnionFile = resolve(
  repositoryRoot,
  "experiments/lib/development-smoke-launcher.ts"
);
const legacyReadUnionLiteral = /z\.literal\((?:32_000|24_000|12_000|8_000)\)/u;

function collectScannableFiles(): string[] {
  const files: string[] = [];
  for (const root of ["src", "experiments"]) {
    const start = resolve(repositoryRoot, root);
    if (!statSync(start, { throwIfNoEntry: false })) continue;
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.pop() as string;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const absolute = join(current, entry.name);
        if (entry.isDirectory()) {
          // 历史实验结果证据不扫描（experiments/results/**）。
          if (entry.name === "results") continue;
          queue.push(absolute);
        } else if (/\.(?:ts|mjs)$/u.test(entry.name)) {
          files.push(absolute);
        }
      }
    }
  }
  return files;
}

describe("仓库级不变量：生产与探针模型请求不设人工输出上限", () => {
  it("提供商硬上限常量保持 384000", () => {
    expect(maximumExplicitLlmOutputTokens).toBe(384_000);
  });

  it("src/ 与 experiments/（不含 results/）不存在 输出上限关键字 + 低于硬上限 的小数值组合", () => {
    const violations: string[] = [];
    for (const file of collectScannableFiles()) {
      const relativeFile = relative(repositoryRoot, file);
      const lines = readFileSync(file, "utf8").split(/\r?\n/u);
      lines.forEach((line, index) => {
        if (commentLine.test(line)) return;
        if (!outputCapKeyword.test(line)) return;
        if (!artificialCapLiteral.test(line)) return;
        if (file === legacyReadUnionFile && legacyReadUnionLiteral.test(line)) return;
        violations.push(`${relativeFile}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });
});