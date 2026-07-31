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
import { mergeEnvFile } from "./env-file.mjs";

const [, , envPath, ...command] = process.argv;
if (envPath === undefined || command.length === 0) {
  process.stderr.write("用法：node scripts/run-with-env.mjs <env文件> <命令> [参数...]\n");
  process.exit(2);
}
if (hasNodeDebugEnabled(process.env)) {
  process.stderr.write(
    "启动前必须清除 NODE_DEBUG 和 NODE_DEBUG_NATIVE，防止 Node 把子进程环境写到终端。\n"
  );
  process.exit(2);
}

let childEnvironment;
try {
  childEnvironment = mergeEnvFile(readFileSync(envPath, "utf8"), process.env);
} catch {
  process.stderr.write("无法读取指定的 env 文件。\n");
  process.exit(2);
}
if (hasNodeDebugEnabled(childEnvironment)) {
  process.stderr.write(
    "env 文件不能设置 NODE_DEBUG 或 NODE_DEBUG_NATIVE，防止 Node 把子进程环境写到终端。\n"
  );
  process.exit(2);
}

const child = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  env: childEnvironment
});
child.on("error", () => {
  process.stderr.write("子进程启动失败。\n");
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal === null ? 1 : 1));
});

function hasNodeDebugEnabled(environment) {
  return (
    environment.NODE_DEBUG?.trim() ||
    environment.NODE_DEBUG_NATIVE?.trim()
  );
}
