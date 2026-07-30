#!/usr/bin/env node
/**
 * 用法：node scripts/run-with-env.mjs <env文件> <命令> [参数...]
 *
 * 逐行解析 env 文件后启动子进程。之所以不用 shell 的 source：值里出现 #、) 、:
 * 等字符时 shell 会当语法解析，不但失败，报错还会把密钥值回显到终端。
 * 本脚本不经过任何 shell 解释，出错时也绝不打印文件内容。
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [, , envPath, ...command] = process.argv;
if (envPath === undefined || command.length === 0) {
  process.stderr.write("用法：node scripts/run-with-env.mjs <env文件> <命令> [参数...]\n");
  process.exit(2);
}

let content;
try {
  content = readFileSync(envPath, "utf8");
} catch {
  process.stderr.write("无法读取指定的 env 文件。\n");
  process.exit(2);
}

for (const line of content.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    continue;
  }
  const eq = trimmed.indexOf("=");
  if (eq <= 0) {
    continue;
  }
  const key = trimmed.slice(0, eq).trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    continue;
  }
  let value = trimmed.slice(eq + 1);
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1);
  }
  if (!(key in process.env)) {
    process.env[key] = value;
  }
}

const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: process.env });
child.on("error", () => {
  process.stderr.write("子进程启动失败。\n");
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal === null ? 1 : 1));
});
