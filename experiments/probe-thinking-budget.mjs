/**
 * 探测 Aether 网关是否接受 DeepSeek 格式的 thinking budget_tokens 上限。
 * 只打印状态与数值，绝不打印任何请求/响应的正文内容或凭据。
 */
const baseUrl = process.env.AETHER_BASE_URL;
const apiKey = process.env.AETHER_API_KEY;
if (!baseUrl || !apiKey) {
  console.error("MISSING_CREDENTIALS");
  process.exit(2);
}

async function probe({ label, thinking }) {
  const body = {
    model: "deepseek-v4-pro",
    messages: [
      {
        role: "user",
        content:
          "请用一段话解释为什么排序算法对算法竞赛重要，不要在回答里重复这个问题。"
      }
    ],
    stream: false,
    temperature: 0.1,
    thinking,
    reasoning_effort: "max",
    // 与项目"不设人工输出上限"决策一致：显式请求提供商硬上限 384000。
    max_tokens: 384_000
  };
  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000)
    });
    const elapsedMs = Date.now() - startedAt;
    if (!response.ok) {
      const text = await response.text();
      let code = `HTTP_${response.status}`;
      try {
        const err = JSON.parse(text);
        code += ` ${String(err?.error?.type ?? "").slice(0, 40)}`;
      } catch {
        /* keep short */
      }
      console.log(`${label}: REJECTED ${code} (${elapsedMs}ms)`);
      return;
    }
    const data = await response.json();
    const choice = data?.choices?.[0];
    const finishReason = choice?.finish_reason ?? "unknown";
    const usage = data?.usage ?? {};
    const contentLength = String(choice?.message?.content ?? "").length;
    const reasoningLength = String(
      choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? ""
    ).length;
    console.log(
      `${label}: OK finish=${finishReason} contentChars=${contentLength} ` +
        `reasoningChars=${reasoningLength} elapsedMs=${elapsedMs}`
    );
  } catch (error) {
    console.log(
      `${label}: ERROR ${error instanceof Error ? error.name : "unknown"} (${Date.now() - startedAt}ms)`
    );
  }
}

await probe({ label: "plain", thinking: { type: "enabled" } });
await probe({
  label: "budget16",
  thinking: { type: "enabled", budget_tokens: 16 }
});
await probe({
  label: "budget1024",
  thinking: { type: "enabled", budget_tokens: 1024 }
});