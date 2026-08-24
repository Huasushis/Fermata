/**
 * Token consumption probe v2 using the provider's uncapped streaming default.
 * Public-domain content only.
 */
import { readFileSync } from "node:fs";

const envPath = "/home/ubuntu/codex-urmotiv/Fermata/private/review-flow-baseline-20260811/review-flow.env";
const envText = readFileSync(envPath, "utf8");
const env: Record<string, string> = {};
for (const line of envText.split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq).trim();
  const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  env[k] = v;
}

const baseUrl = env.AETHER_BASE_URL;
const apiKey = env.AETHER_API_KEY;

const complexPrompt = `You are reviewing a competitive programming problem. Analyze the following problem statement and provide a detailed solution analysis.

Problem: Given a tree with N vertices (N up to 2*10^5), each vertex has a weight w_i (|w_i| up to 10^9). Answer Q queries (Q up to 2*10^5). Each query gives vertices u, v and asks for the maximum weight simple path from u to v.

Provide:
1. An O((N+Q) sqrt(N)) or O((N+Q) log^2 N) solution using heavy-light decomposition with segment trees
2. Handle negative weights, single-vertex paths, and the u=v edge case
3. A formal correctness proof by induction on the decomposition
4. Complete time and space complexity analysis
5. Identify three common implementation pitfalls and how to avoid them

Be thorough and precise. This analysis will be used to judge whether a proposed solution is correct.`;


const body = {
  model: "deepseek-v4-pro",
  messages: [{ role: "user", content: complexPrompt }],
  stream: true,
  thinking: { type: "enabled" },
  reasoning_effort: "max",
  temperature: 0.4,
};

const startTime = Date.now();

try {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4 * 60 * 60 * 1000),
  });

  console.log("HTTP status:", response.status);
  if (!response.ok || !response.body) {
    const text = await response.text();
    console.log("Error:", text.slice(0, 200));
    process.exit(1);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reasoningLength = 0;
  let contentLength = 0;
  let finishReason: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let chunkCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(data);
        chunkCount++;
        const choice = chunk.choices?.[0];
        if (choice) {
          const delta = choice.delta ?? choice.message;
          if (delta?.reasoning_content) reasoningLength += delta.reasoning_content.length;
          if (delta?.content) contentLength += delta.content.length;
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
        if (chunk.usage) usage = chunk.usage;
      } catch { /* skip */ }
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log("--- Results ---");
  console.log("elapsed_seconds:", elapsed);
  console.log("chunk_count:", chunkCount);
  console.log("reasoning_content_chars:", reasoningLength);
  console.log("content_chars:", contentLength);
  console.log("finish_reason:", finishReason);
  if (usage) {
    console.log("usage:", JSON.stringify({
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      reasoning_tokens: usage.reasoning_tokens ?? (usage.completion_tokens_details as Record<string, unknown>)?.reasoning_tokens ?? null,
    }));
  }
  console.log("eof_verified:", finishReason === "stop");
  console.log("hit_output_limit:", finishReason === "length");
} catch (error) {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log("error after", elapsed, "seconds:", error instanceof Error ? error.message : String(error));
}
