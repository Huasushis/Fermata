#!/usr/bin/env node
/**
 * Token consumption probe launcher: reads env file, sets proxy + Aether credentials,
 * runs experiments/probe-token-consumption.ts via tsx.
 */
import { accessSync, constants, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readProtectedEnvFile } from "./private-runtime.mjs";

const repositoryRoot = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..")
);

function parseEnvFile(content) {
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function main() {
  const envPath = process.argv[2];
  if (!envPath || !isAbsolute(envPath)) {
    process.stderr.write("用法: node scripts/run-token-probe.mjs <env文件绝对路径>\n");
    process.exit(2);
  }
  accessSync(envPath, constants.R_OK);

  const envContent = readProtectedEnvFile(envPath);
  const fileEnv = parseEnvFile(envContent);

  const childEnv = {};
  const allowedFromParent = [
    "ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
    "all_proxy", "https_proxy", "http_proxy", "no_proxy",
    "HOME", "LANG", "LC_ALL", "LC_CTYPE", "PATH",
    "TERM", "TMPDIR", "TZ", "USER"
  ];
  for (const key of allowedFromParent) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  const allowedFromFile = [
    "AETHER_BASE_URL", "AETHER_API_KEY",
    "DASHSCOPE_BASE_URL", "DASHSCOPE_API_KEY",
    "EVAL_CODE_VERSION", "EVAL_CONCURRENCY"
  ];
  for (const key of allowedFromFile) {
    if (fileEnv[key]) childEnv[key] = fileEnv[key];
  }
  childEnv.NODE_OPTIONS = "";
  childEnv.NODE_PATH = "";
  childEnv.NODE_DISABLE_COMPILE_CACHE = "1";

  // loadConfig requires these but the probe doesn't use them
  childEnv.URMOTIV_BASE_URL = "http://placeholder.invalid/";
  childEnv.URMOTIV_ROBOT_TOKEN = "placeholder-token-not-used";
  childEnv.FERMATA_MANAGEMENT_TOKEN = "placeholder-management-token-not-used";

  const probeScript = resolve(repositoryRoot, "experiments/probe-token-consumption.ts");
  const tsxLoaderPath = resolve(repositoryRoot, "node_modules/tsx/dist/loader.mjs");
  const child = spawn(process.execPath, [
    "--import",
    pathToFileURL(tsxLoaderPath).href,
    probeScript
  ], {
    env: childEnv,
    stdio: "inherit",
    cwd: repositoryRoot
  });

  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

void main();
