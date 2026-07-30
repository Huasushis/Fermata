import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CodeforcesClient,
  CodeforcesParseError,
  extractProblemStatementDiv,
  extractProblemStatementText,
  signCodeforcesRequest
} from "../src/codeforces";

describe("signCodeforcesRequest：官方文档的例子", () => {
  it("复现 apiHelp 文档里 contest.hacks 的签名例子", () => {
    // 来源：https://codeforces.com/apiHelp ，Authorization 一节的示例：
    // key=xxx secret=yyy rand=123456 time=1784928977，访问
    // contest.hacks?contestId=566，apiSig 应该是
    // 123456 + sha512Hex("123456/contest.hacks?apiKey=xxx&contestId=566&time=1784928977#yyy")。
    const signed = signCodeforcesRequest(
      "contest.hacks",
      { contestId: "566" },
      { key: "xxx", secret: "yyy" },
      { rand: "123456", time: 1784928977 }
    );

    expect(signed.apiKey).toBe("xxx");
    expect(signed.time).toBe("1784928977");
    expect(signed.contestId).toBe("566");

    const expectedHash = createHash("sha512")
      .update("123456/contest.hacks?apiKey=xxx&contestId=566&time=1784928977#yyy", "utf8")
      .digest("hex");
    expect(signed.apiSig).toBe(`123456${expectedHash}`);
  });

  it("参数按参数名的字典序排序，和调用时传入的顺序无关", () => {
    const signed = signCodeforcesRequest(
      "problemset.problems",
      { tags: "dp", zetaParam: "z" },
      { key: "k", secret: "s" },
      { rand: "abcdef", time: 1000 }
    );
    const hashInput = `abcdef/problemset.problems?apiKey=k&tags=dp&time=1000&zetaParam=z#s`;
    const expectedHash = createHash("sha512").update(hashInput, "utf8").digest("hex");
    expect(signed.apiSig).toBe(`abcdef${expectedHash}`);
  });

  it("不传 rand/time 时也能生成一个 6 位 rand 前缀 + 128 位十六进制哈希", () => {
    const signed = signCodeforcesRequest("problemset.problems", {}, { key: "k", secret: "s" });
    expect(signed.apiSig).toMatch(/^[a-z0-9]{6}[0-9a-f]{128}$/);
  });
});

describe("CodeforcesClient：请求与限速", () => {
  it("配置了 key/secret 时请求带 apiKey/time/apiSig，没配置时不带", async () => {
    const fetchSigned = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const parsed = new URL(url instanceof Request ? url.url : url);
      expect(parsed.searchParams.get("apiKey")).toBe("k");
      expect(parsed.searchParams.get("apiSig")).toMatch(/^[a-z0-9]{6}[0-9a-f]{128}$/);
      return new Response(JSON.stringify({ status: "OK", result: { problems: [] } }), { status: 200 });
    });
    const signedClient = new CodeforcesClient({
      credentials: { key: "k", secret: "s" },
      minimumRequestIntervalMs: 0,
      requestTimeoutMs: 5_000,
      fetch: fetchSigned
    });
    await signedClient.fetchProblemsetProblems();
    expect(fetchSigned).toHaveBeenCalledTimes(1);

    const fetchAnonymous = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const parsed = new URL(url instanceof Request ? url.url : url);
      expect(parsed.searchParams.has("apiKey")).toBe(false);
      expect(parsed.searchParams.has("apiSig")).toBe(false);
      return new Response(JSON.stringify({ status: "OK", result: { problems: [] } }), { status: 200 });
    });
    const anonymousClient = new CodeforcesClient({
      minimumRequestIntervalMs: 0,
      requestTimeoutMs: 5_000,
      fetch: fetchAnonymous
    });
    await anonymousClient.fetchProblemsetProblems();
    expect(fetchAnonymous).toHaveBeenCalledTimes(1);
  });

  it("解析 problemset.problems 的返回并保留 rating/tags", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "OK",
          result: {
            problems: [
              { contestId: 4, index: "A", name: "Watermelon", rating: 800, tags: ["math"] },
              { index: "gym-only", name: "无 contestId 的题目", tags: [] }
            ]
          }
        }),
        { status: 200 }
      )
    );
    const client = new CodeforcesClient({ minimumRequestIntervalMs: 0, requestTimeoutMs: 5_000, fetch: fetchMock });
    const problems = await client.fetchProblemsetProblems();
    expect(problems).toEqual([
      { contestId: 4, index: "A", name: "Watermelon", rating: 800, tags: ["math"] },
      { contestId: undefined, index: "gym-only", name: "无 contestId 的题目", rating: undefined, tags: [] }
    ]);
  });

  it("status: FAILED 时抛出 CodeforcesApiError", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ status: "FAILED", comment: "限流了" }), { status: 200 })
    );
    const client = new CodeforcesClient({ minimumRequestIntervalMs: 0, requestTimeoutMs: 5_000, fetch: fetchMock });
    await expect(client.fetchProblemsetProblems()).rejects.toThrow(/限流了/);
  });

  it("相邻两次请求之间至少间隔 minimumRequestIntervalMs（用假时钟/睡眠验证，不真的等待）", async () => {
    let currentTime = 0;
    const sleepCalls: number[] = [];
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ status: "OK", result: { problems: [] } }), { status: 200 })
    );
    const client = new CodeforcesClient({
      minimumRequestIntervalMs: 2_100,
      requestTimeoutMs: 5_000,
      fetch: fetchMock,
      now: () => currentTime,
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
        currentTime += ms;
      }
    });

    await client.fetchProblemsetProblems();
    expect(sleepCalls).toEqual([]); // 第一次请求不需要等待

    currentTime += 500; // 模拟只过了 500ms 就发起第二次请求
    await client.fetchProblemsetProblems();
    expect(sleepCalls).toEqual([1_600]); // 还差 2100-500=1600ms

    currentTime += 3_000; // 第三次请求前已经过了足够长时间
    await client.fetchProblemsetProblems();
    expect(sleepCalls).toEqual([1_600]); // 没有新增等待
  });
});

const SAMPLE_STATEMENT_HTML = `
<html><body>
<div class="problem-statement">
  <div class="header">
    <div class="title">A. 示例题目标题</div>
    <div class="time-limit"><div class="property-title">时间限制</div>1 second</div>
    <div class="memory-limit"><div class="property-title">内存限制</div>256 megabytes</div>
  </div>
  <div>
    给定一个长度为 <span class="tex-span"><script type="math/tex">n</script></span> 的数组，求最大子段和，
    保证 <script type="math/tex; mode=display">1 \\le n \\le 10^5</script>。含有 &amp; 和 &lt;示例&gt;。
  </div>
  <div class="input-specification">
    <div class="section-title">输入</div>
    <p>第一行一个整数 n。</p>
  </div>
  <div class="output-specification">
    <div class="section-title">输出</div>
    <p>输出一个整数。</p>
  </div>
  <script>MathJax.Hub.Config({tex2jax: {}});</script>
</div>
</body></html>
`;

describe("extractProblemStatementText", () => {
  it("保留内联和行间公式为 LaTeX，去掉 MathJax 加载脚本和所有标签", () => {
    const text = extractProblemStatementText(SAMPLE_STATEMENT_HTML);
    expect(text).toContain("示例题目标题");
    expect(text).toContain("$n$");
    expect(text).toContain("$$1 \\le n \\le 10^5$$");
    expect(text).toContain("输入");
    expect(text).toContain("输出");
    expect(text).not.toContain("MathJax.Hub.Config");
    expect(text).not.toContain("<div");
    expect(text).not.toContain("<script");
    expect(text).not.toContain("<p>");
  });

  it("解码常见 HTML 实体，且 &amp; 不会被二次解码", () => {
    const text = extractProblemStatementText(SAMPLE_STATEMENT_HTML);
    expect(text).toContain("含有 & 和 <示例>");
  });

  it("找不到 div.problem-statement 时抛出 CodeforcesParseError", () => {
    expect(() => extractProblemStatementText("<html><body>没有题面</body></html>")).toThrow(
      CodeforcesParseError
    );
  });
});

describe("extractProblemStatementDiv：嵌套 div 的深度计数", () => {
  it("正确匹配到最外层 problem-statement 对应的闭合标签，而不是第一个 </div>", () => {
    const html = '<div class="problem-statement"><div>a<div>b</div>c</div></div>';
    expect(extractProblemStatementDiv(html)).toBe("<div>a<div>b</div>c</div>");
  });

  it("没有 problem-statement 时返回 null", () => {
    expect(extractProblemStatementDiv("<div>hello</div>")).toBeNull();
  });

  it("class 属性里有多个 class 时也能识别", () => {
    const html = '<div class="ttypography problem-statement extra"><div>x</div></div>';
    expect(extractProblemStatementDiv(html)).toBe("<div>x</div>");
  });
});
