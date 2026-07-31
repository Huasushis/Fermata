#!/usr/bin/env node
/**
 * 等启动器把 PID 元数据安全写盘后，再在当前进程里载入标定入口。
 *
 * stdin 是父进程创建的单向启动门。父进程如果在写完元数据前退出，管道会直接
 * 关闭，本进程也会退出，不会留下没有 PID 记录的模型请求。
 */
import { closeSync, readFileSync } from "node:fs";

let authorization;
let readFailed = false;
try {
  authorization = readFileSync(0, "utf8");
} catch {
  readFailed = true;
} finally {
  try {
    closeSync(0);
  } catch {
    // 只关闭固定的启动门描述符，不输出底层错误。
  }
}

if (readFailed) {
  process.stderr.write("长期标定启动授权读取失败。\n");
  process.exit(1);
}

if (authorization !== "START\n") {
  process.stderr.write("长期标定未获得启动授权。\n");
  process.exit(1);
}

await import("../experiments/calibrate-levels.ts");
