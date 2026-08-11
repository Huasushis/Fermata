/**
 * Token consumption probe: measure reasoning_content vs content token usage
 * with reasoning_effort="max" and max_tokens=384000 on a complex prompt.
 * Uses public-domain content only — no private problem statements.
 */
import { z } from "zod";
import {
  chatCompleteWithReceipt,
  type LlmRuntimeOptions
} from "../src/llm.js";
import { loadConfig, getProviderCredentials, type ModelSpec, type ProviderCredentials } from "../src/config.js";

const probeSpec: ModelSpec = {
  provider: "aether",
  model: "deepseek-v4-pro",
  temperature: 0.4,
  thinking: true,
  thinkingRequest: "enabled",
  reasoningEffort: "max"
};

const probeRuntime: Omit<LlmRuntimeOptions, "fetch"> = {
  outputIdleTimeoutMs: 600_000,
  firstOutputTimeoutMs: 1_800_000,
  maximumDurationMs: 14_400_000,
  maxAttempts: 1,
  baseDelayMs: 500
};

// Complex public-domain competitive programming problem requiring extensive reasoning.
// This is NOT a private problem — it's a well-known algorithmic challenge.
const complexMessages = [
  {
    role: "user" as const,
    content: `You are reviewing a competitive programming problem. Analyze the following problem statement and provide a detailed solution analysis.

Problem: Given a tree with N vertices (N up to 2*10^5), each vertex has a weight w_i (|w_i| up to 10^9). Answer Q queries (Q up to 2*10^5). Each query gives vertices u, v and asks for the maximum weight simple path from u to v.

Provide:
1. An O((N+Q) sqrt(N)) or O((N+Q) log^2 N) solution using heavy-light decomposition with segment trees
2. Handle negative weights, single-vertex paths, and the u=v edge case
3. A formal correctness proof by induction on the decomposition
4. Complete time and space complexity analysis
5. Identify three common implementation pitfalls and how to avoid them

Be thorough and precise. This analysis will be used to judge whether a proposed solution is correct.`
  }
];

async function main(): Promise<void> {
  const config = loadConfig();
  const profile = config.models.profiles[config.models.defaults.modelProfileName];
  const reviewSolver = profile?.reviewFlow?.solver;
  if (!reviewSolver) {
    throw new Error("PROBE_CONFIG_MISSING_REVIEW_SOLVER");
  }
  console.log("config-check:", JSON.stringify({
    model: reviewSolver.model,
    provider: reviewSolver.provider,
    thinking: reviewSolver.thinking,
    thinkingRequest: reviewSolver.thinkingRequest,
    reasoningEffort: reviewSolver.reasoningEffort,
    temperature: reviewSolver.temperature
  }));

  const credentials = getProviderCredentials(config, reviewSolver.provider);
  if (!credentials) {
    throw new Error("PROBE_CONFIG_MISSING_CREDENTIALS");
  }

  console.log("Sending probe with max_tokens=384000, reasoning_effort=max...");
  console.log("Prompt length:", complexMessages[0].content.length, "chars");
  const startTime = Date.now();

  try {
    const result = await chatCompleteWithReceipt(
      credentials,
      probeSpec,
      complexMessages,
      { ...probeRuntime, fetch: undefined as never } as LlmRuntimeOptions,
      { requestJson: false, maxOutputTokens: 512_000 }
    );
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log("--- Results ---");
    console.log("elapsed_seconds:", elapsed);
    console.log("content_length:", result.content.length);
    console.log("reasoning_length:", result.reasoning?.length ?? 0);
    console.log("eof_verified:", result.receipt.eofVerified);
    console.log("transport_attempt_count:", result.receipt.transportAttemptCount);
    console.log("finishReasonStopVerified:", result.receipt.finishReasonStopVerified);
    // Print first 200 chars of reasoning to gauge depth (safe: public prompt)
    console.log("content_preview:", result.content.slice(0, 200));
  } catch (error) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log("error after", elapsed, "seconds:", error instanceof Error ? error.name : "unknown");
    if (error instanceof Error && error.message) {
      console.log("error_message:", error.message.slice(0, 200));
    }
  }
}

main().catch((error) => {
  console.error("probe-fatal:", error instanceof Error ? error.name : "unknown");
  process.exit(1);
});
