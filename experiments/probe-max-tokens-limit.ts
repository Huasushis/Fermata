/**
 * Quick probe: test whether Aether gateway accepts max_tokens > 384000.
 * Sends a minimal prompt with max_tokens=400000 and checks if the API
 * accepts or rejects it. Does NOT print any private content.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

if (!baseUrl || !apiKey) {
  console.log("ERROR: missing AETHER_BASE_URL or AETHER_API_KEY");
  process.exit(1);
}

const testValues = [384_000, 400_000, 512_000, 1_000_000];

for (const maxTokens of testValues) {
  console.log(`\n--- Testing max_tokens=${maxTokens} ---`);
  const body = {
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: "Say hello." }],
    stream: false,
    thinking: { type: "enabled" },
    reasoning_effort: "max",
    max_tokens: maxTokens,
    temperature: 0.1,
  };

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    console.log("HTTP status:", response.status);
    if (response.ok) {
      const data = await response.json() as Record<string, unknown>;
      const choice = (data.choices as Array<Record<string, unknown>>)?.[0];
      const finishReason = choice?.finish_reason;
      console.log("finish_reason:", finishReason);
      console.log("ACCEPTED: max_tokens=" + maxTokens + " is valid");
      // Don't print content — just confirm acceptance
    } else {
      const text = await response.text();
      // Only print error type/code, not full message (may contain internal details)
      try {
        const err = JSON.parse(text) as Record<string, unknown>;
        const errorObj = err.error as Record<string, unknown> | undefined;
        console.log("REJECTED:", errorObj?.type ?? "unknown", "-", errorObj?.code ?? "unknown");
      } catch {
        console.log("REJECTED: status", response.status);
      }
    }
  } catch (error) {
    console.log("ERROR:", error instanceof Error ? error.name : "unknown");
  }
}
