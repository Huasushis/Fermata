/**
 * 深度协议探测：捕获 SSE 流中 finish_reason=stop 之后的事件形状。
 * 只输出安全结构信息（字段名、类型、数组长度、finish_reason 值），
 * 绝不输出 content、reasoning_content 或任何模型正文。
 */
import { accessSync, constants, realpathSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { readProtectedEnvFile } from "../scripts/private-runtime.mjs";
import { EnvHttpProxyAgent, request as undiciRequest } from "undici";
import { loadConfig, getProviderCredentials } from "../src/config.js";

const repositoryRoot = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..")
);

function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function describeEventShape(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) return {};
  const record = raw as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    const val = record[key];
    if (key === "choices" && Array.isArray(val)) {
      const choices: Record<string, unknown>[] = [];
      for (const choice of val) {
        if (typeof choice !== "object" || choice === null) continue;
        const choiceRecord = choice as Record<string, unknown>;
        const choiceShape: Record<string, unknown> = {};
        for (const ck of Object.keys(choiceRecord)) {
          const cv = choiceRecord[ck];
          if (ck === "finish_reason") {
            choiceShape.finish_reason = typeof cv === "string" ? cv : typeof cv;
          } else if (ck === "delta" || ck === "message") {
            if (typeof cv !== "object" || cv === null) continue;
            const deltaShape: Record<string, unknown> = {};
            for (const dk of Object.keys(cv)) {
              const dv = (cv as Record<string, unknown>)[dk];
              if (typeof dv === "string") {
                deltaShape[dk] = { type: "string", length: dv.length };
              } else {
                deltaShape[dk] = { type: typeof dv };
              }
            }
            choiceShape[ck] = deltaShape;
          } else {
            choiceShape[ck] = { type: typeof cv };
          }
        }
        choices.push(choiceShape);
      }
      result.choices = choices;
    } else if (key === "usage" && typeof val === "object" && val !== null) {
      result.usage = { keys: Object.keys(val) };
    } else if (key === "error") {
      result.error = { present: true };
    } else {
      result[key] = { type: typeof val };
    }
  }
  return result;
}

async function main(): Promise<void> {
  const envPath = process.argv[2];
  if (!envPath || !isAbsolute(envPath)) {
    process.stderr.write("用法: node experiments/probe-sse-shape.ts <env文件绝对路径>\n");
    process.exit(2);
  }
  accessSync(envPath, constants.R_OK);

  const envContent = readProtectedEnvFile(envPath);
  const fileEnv = parseEnvFile(envContent);

  process.env.URMOTIV_BASE_URL = "http://placeholder.invalid/";
  process.env.URMOTIV_ROBOT_TOKEN = "placeholder-token-not-used";
  process.env.FERMATA_MANAGEMENT_TOKEN = "placeholder-management-token-not-used";
  if (fileEnv.AETHER_BASE_URL) process.env.AETHER_BASE_URL = fileEnv.AETHER_BASE_URL;
  if (fileEnv.AETHER_API_KEY) process.env.AETHER_API_KEY = fileEnv.AETHER_API_KEY;

  const config = loadConfig();
  const credentials = getProviderCredentials(config, "aether");
  if (!credentials) throw new Error("PROBE_NO_AETHER_CREDENTIALS");

  const dispatcher = new EnvHttpProxyAgent({
    connectTimeout: 0,
    headersTimeout: 0,
    bodyTimeout: 0
  });

  const url = credentials.baseUrl.endsWith("/")
    ? `${credentials.baseUrl}chat/completions`
    : `${credentials.baseUrl}/chat/completions`;

  const body = JSON.stringify({
    model: "deepseek-v4-pro",
    temperature: 0.4,
    stream: true,
    messages: [{ role: "user", content: "请用一句话回答：1+1 等于几？只输出答案数字。" }],
    thinking: { type: "enabled" },
    reasoning_effort: "max",
    max_tokens: 4096
  });

  console.log("--- sending streaming request ---");
  const response = await undiciRequest(url, {
    method: "POST",
    dispatcher,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credentials.apiKey}`
    },
    body
  });

  console.log("http-status:", response.statusCode);
  if (response.statusCode !== 200) {
    console.log("error: non-200 response");
    await response.body.dump();
    await dispatcher.close();
    return;
  }

  let buffer = "";
  let sawStop = false;
  let eventCount = 0;
  const postStopEvents: Array<{ eventIndex: number; shape: Record<string, unknown> }> = [];
  let contentLength = 0;
  let reasoningLength = 0;
  let hasContent = false;
  let hasReasoning = false;

  for await (const chunk of response.body) {
    buffer += Buffer.from(chunk).toString("utf8");

    while (true) {
      const eventEnd = buffer.indexOf("\n\n");
      if (eventEnd < 0) break;
      const eventText = buffer.slice(0, eventEnd);
      buffer = buffer.slice(eventEnd + 2);

      const dataLines = eventText.split("\n")
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart());
      if (dataLines.length === 0) continue;
      const data = dataLines.join("\n").trim();
      if (data.length === 0) continue;
      if (data === "[DONE]") { console.log("done-marker: [DONE]"); continue; }

      let raw: unknown;
      try { raw = JSON.parse(data); } catch { eventCount++; continue; }
      eventCount++;

      const shape = describeEventShape(raw);
      const choices = (raw as { choices?: unknown[] })?.choices;
      if (Array.isArray(choices) && choices.length > 0) {
        const choice = choices[0] as Record<string, unknown> | undefined;
        const finishReason = choice?.finish_reason;
        const delta = (choice?.delta ?? choice?.message) as Record<string, unknown> | undefined;
        if (typeof delta?.content === "string") {
          contentLength += delta.content.length;
          if (delta.content.trim().length > 0) hasContent = true;
        }
        if (typeof delta?.reasoning_content === "string") {
          reasoningLength += delta.reasoning_content.length;
          if (delta.reasoning_content.trim().length > 0) hasReasoning = true;
        }
        if (finishReason === "stop") sawStop = true;
        if (sawStop) postStopEvents.push({ eventIndex: eventCount - 1, shape });
      }
    }
  }

  console.log("total-events:", eventCount);
  console.log("saw-stop:", sawStop);
  console.log("has-content:", hasContent);
  console.log("content-length:", contentLength);
  console.log("has-reasoning:", hasReasoning);
  console.log("reasoning-length:", reasoningLength);
  console.log("post-stop-event-count:", postStopEvents.length);
  if (postStopEvents.length > 0) {
    console.log("post-stop-event-shapes:", JSON.stringify(postStopEvents, null, 2));
  }

  await dispatcher.close();
}

main().catch((error: unknown) => {
  console.error("probe-fatal:", error instanceof Error ? error.name : "unknown");
  process.exit(1);
});
