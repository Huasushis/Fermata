#!/usr/bin/env node
/**
 * 等启动器把 PID 元数据安全写盘后，再在当前进程里载入标定入口。
 *
 * stdin 是父进程创建的单向启动门。父进程如果在写完元数据前退出，管道会直接
 * 关闭，本进程也会退出，不会留下没有 PID 记录的模型请求。
 */
import { closeSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const startAuthorization = "START\n";

export class DetachedWorkerGateError extends Error {
  constructor(code) {
    super(code);
    this.name = "DetachedWorkerGateError";
    this.code = code;
  }
}

export function readStartAuthorization(
  descriptor = 0,
  readFromDescriptor = readSync
) {
  // 多读一个字节，用常量内存同时区分精确授权和带后缀的输入。
  const buffer = Buffer.alloc(startAuthorization.length + 1);
  let totalBytes = 0;
  while (totalBytes < buffer.length) {
    const bytesRead = readFromDescriptor(
      descriptor,
      buffer,
      totalBytes,
      buffer.length - totalBytes,
      null
    );
    if (bytesRead === 0) {
      break;
    }
    totalBytes += bytesRead;
  }
  return buffer.subarray(0, totalBytes).toString("utf8");
}

export function validateStartAuthorization(authorization) {
  if (authorization !== startAuthorization) {
    throw new DetachedWorkerGateError("DETACHED_WORKER_NOT_AUTHORIZED");
  }
}

export async function runDetachedCalibrationWorker({
  readAuthorization = () => readStartAuthorization(0),
  closeAuthorization = () => closeSync(0),
  loadCalibration = () => import("../experiments/calibrate-levels.ts")
} = {}) {
  let authorization;
  try {
    authorization = readAuthorization();
  } catch {
    throw new DetachedWorkerGateError("DETACHED_WORKER_GATE_READ_FAILED");
  } finally {
    try {
      closeAuthorization();
    } catch {
      // 只关闭固定的启动门描述符，不输出底层错误。
    }
  }

  validateStartAuthorization(authorization);
  await loadCalibration();
}

function isDirectEntry() {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  try {
    await runDetachedCalibrationWorker();
  } catch (error) {
    if (
      error instanceof DetachedWorkerGateError &&
      error.code === "DETACHED_WORKER_GATE_READ_FAILED"
    ) {
      process.stderr.write("长期标定启动授权读取失败。\n");
    } else if (error instanceof DetachedWorkerGateError) {
      process.stderr.write("长期标定未获得启动授权。\n");
    } else {
      // 标定入口自己的错误通常会在其安全日志里解释；这里只给固定退出信息，
      // 避免动态异常回显 env 值、私有路径或模型原始输出。
      process.stderr.write("长期标定进程异常退出。\n");
    }
    process.exitCode = 1;
  }
}
