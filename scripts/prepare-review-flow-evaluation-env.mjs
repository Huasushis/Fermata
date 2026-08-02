#!/usr/bin/env node
/**
 * 从现有 Fermata 私有 env 中只复制 review-flow 允许的 provider 配置，并绑定
 * 当前干净 HEAD。不会输出路径、配置值或 Git 提交号，也绝不覆盖既有目标。
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { parseEnvFile } from "./env-file.mjs";
import {
  anchoredPrivatePath,
  closePrivateDirectory,
  preparePrivateDirectory,
  readProtectedEnvFile
} from "./private-runtime.mjs";
import {
  buildReviewFlowEvaluationRunEnvironment
} from "./run-with-env.mjs";
import {
  readCleanRepositoryHead
} from "./update-eval-code-version.mjs";

const outputFileName = "review-flow.env";
const codeVersionPattern = /^(?!0{40}$)[0-9a-f]{40}$/u;
const providerPairs = Object.freeze([
  ["AETHER_BASE_URL", "AETHER_API_KEY"],
  ["DASHSCOPE_BASE_URL", "DASHSCOPE_API_KEY"]
]);

function failPreparation() {
  throw new Error("REVIEW_FLOW_EVALUATION_ENV_PREPARATION_FAILED");
}

function rawEnvironmentLines(content) {
  const lines = new Map();
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) failPreparation();
    const key = trimmed.slice(0, separatorIndex).trim();
    if (lines.has(key)) failPreparation();
    lines.set(key, trimmed);
  }
  return lines;
}

export function buildReviewFlowEvaluationEnvFile(
  sourceContent,
  codeVersion,
  concurrency = 2
) {
  try {
    if (
      typeof sourceContent !== "string" ||
      !codeVersionPattern.test(codeVersion) ||
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 32
    ) {
      failPreparation();
    }
    const parsed = parseEnvFile(sourceContent);
    const sourceLines = rawEnvironmentLines(sourceContent);
    const selectedLines = [];
    let configuredProviders = 0;
    for (const [baseUrlKey, apiKeyKey] of providerPairs) {
      const hasBaseUrl = Object.hasOwn(parsed, baseUrlKey);
      const hasApiKey = Object.hasOwn(parsed, apiKeyKey);
      if (hasBaseUrl !== hasApiKey) failPreparation();
      if (!hasBaseUrl) continue;
      if (
        parsed[baseUrlKey].trim() === "" ||
        parsed[apiKeyKey].trim() === "" ||
        !sourceLines.has(baseUrlKey) ||
        !sourceLines.has(apiKeyKey)
      ) {
        failPreparation();
      }
      selectedLines.push(sourceLines.get(baseUrlKey), sourceLines.get(apiKeyKey));
      configuredProviders += 1;
    }
    if (configuredProviders === 0) failPreparation();
    const content = [
      ...selectedLines,
      `EVAL_CODE_VERSION=${codeVersion}`,
      `EVAL_CONCURRENCY=${concurrency}`,
      ""
    ].join("\n");
    // 复用正式入口的 exact-key 校验，确保生成物不会因为复制了额外键而被拒绝。
    buildReviewFlowEvaluationRunEnvironment(content, { PATH: "/usr/bin:/bin" });
    return content;
  } catch {
    failPreparation();
  }
}

function writeExclusivePrivateFile(directory, content) {
  const temporaryName = `.review-flow-env-${process.pid}-${randomUUID()}.tmp`;
  const temporaryPath = anchoredPrivatePath(directory, temporaryName);
  const targetPath = anchoredPrivatePath(directory, outputFileName);
  let descriptor;
  let temporaryExists = false;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    temporaryExists = true;
    fchmodSync(descriptor, 0o600);
    const bytes = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        offset
      );
      if (written <= 0) failPreparation();
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporaryPath, targetPath);
    unlinkSync(temporaryPath);
    temporaryExists = false;
    fsyncSync(directory.descriptor);
  } catch {
    failPreparation();
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 固定失败，不输出路径。
      }
    }
    if (temporaryExists) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // 目标采用 O_EXCL/link 发布；遗留临时文件留给人工按目录身份核对。
      }
    }
  }
}

function parseArguments(argv) {
  if (
    argv.length !== 2 ||
    !argv[0].startsWith("--source-environment-file=") ||
    !argv[1].startsWith("--target-directory=")
  ) {
    failPreparation();
  }
  const source = argv[0].slice("--source-environment-file=".length);
  const targetDirectory = argv[1].slice("--target-directory=".length);
  if (!isAbsolute(source) || !isAbsolute(targetDirectory)) failPreparation();
  return { source: resolve(source), targetDirectory: resolve(targetDirectory) };
}

export function prepareReviewFlowEvaluationEnv(argv) {
  const { source, targetDirectory } = parseArguments(argv);
  const codeVersion = readCleanRepositoryHead();
  const content = buildReviewFlowEvaluationEnvFile(
    readProtectedEnvFile(source),
    codeVersion
  );
  const directory = preparePrivateDirectory(targetDirectory);
  try {
    writeExclusivePrivateFile(directory, content);
  } finally {
    closePrivateDirectory(directory);
  }
  const target = resolve(targetDirectory, outputFileName);
  if (readProtectedEnvFile(target) !== content) failPreparation();
  readCleanRepositoryHead(codeVersion);
}

function isDirectEntry() {
  return process.argv[1] !== undefined &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectEntry()) {
  try {
    prepareReviewFlowEvaluationEnv(process.argv.slice(2));
    process.stdout.write("REVIEW_FLOW_EVALUATION_ENV_READY\n");
  } catch {
    process.stderr.write("无法安全准备 review-flow 专用环境。\n");
    process.exitCode = 1;
  }
}
