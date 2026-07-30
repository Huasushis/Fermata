/**
 * Codeforces API 客户端 + 题面抓取。
 *
 * 签名算法（apiSig，见 https://codeforces.com/apiHelp ，"Authorization" 一节）：
 *   1. 把方法自身的参数、apiKey、time 放在一起；
 *   2. 按参数名、再按参数值做字典序排序；
 *   3. 拼成 "rand/方法名?排序后的query#secret"，rand 是随机选的 6 个字符；
 *   4. 对这个字符串取 SHA-512，转十六进制；
 *   5. apiSig = rand + 这个十六进制哈希。
 * 官方文档给的例子：key=xxx secret=yyy rand=123456 time=1784928977 访问
 * contest.hacks?contestId=566 时，
 * apiSig = 123456 + sha512Hex("123456/contest.hacks?apiKey=xxx&contestId=566&time=1784928977#yyy")。
 * test/codeforces.test.ts 里原样验证了这个例子。
 *
 * problemset.problems 本身不强制要求签名（匿名也能访问），但配置了 key/secret
 * 时统一走签名请求，避免匿名请求更严格的限流。
 *
 * 限速：Codeforces 的规则是不能发得太频繁，这里保守地要求相邻两次请求之间至少
 * 间隔 minimumRequestIntervalMs（默认见 config/models.yaml，≥2100ms）。
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export interface CodeforcesCredentials {
  readonly key: string;
  readonly secret: string;
}

export interface CodeforcesProblem {
  readonly contestId: number | undefined;
  readonly index: string;
  readonly name: string;
  readonly rating: number | undefined;
  readonly tags: readonly string[];
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CodeforcesClientOptions {
  readonly credentials?: CodeforcesCredentials | null;
  readonly minimumRequestIntervalMs: number;
  readonly requestTimeoutMs: number;
  readonly fetch?: FetchLike;
  /** 测试时注入假的时钟/睡眠实现，避免真的等待 2 秒以上。 */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class CodeforcesApiError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CodeforcesApiError";
  }
}

export class CodeforcesParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CodeforcesParseError";
  }
}

const problemsetProblemSchema = z.object({
  contestId: z.number().int().optional(),
  index: z.string().min(1),
  name: z.string(),
  rating: z.number().int().optional(),
  tags: z.array(z.string()).default([])
});

const problemsetProblemsResultSchema = z.object({
  problems: z.array(problemsetProblemSchema)
});

const cfEnvelopeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("OK"), result: z.unknown() }),
  z.object({ status: z.literal("FAILED"), comment: z.string().default("Codeforces 返回了失败状态，但没有说明原因。") })
]);

export class CodeforcesClient {
  readonly #credentials: CodeforcesCredentials | null;
  readonly #minimumRequestIntervalMs: number;
  readonly #requestTimeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #lastRequestAt: number | null = null;

  public constructor(options: CodeforcesClientOptions) {
    this.#credentials = options.credentials ?? null;
    this.#minimumRequestIntervalMs = options.minimumRequestIntervalMs;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  public async fetchProblemsetProblems(): Promise<CodeforcesProblem[]> {
    const result = await this.callMethod("problemset.problems", {}, problemsetProblemsResultSchema);
    return result.problems.map((problem) => ({
      contestId: problem.contestId,
      index: problem.index,
      name: problem.name,
      rating: problem.rating,
      tags: problem.tags
    }));
  }

  public async fetchProblemStatementHtml(contestId: number, index: string): Promise<string> {
    await this.throttle();
    const url = new URL(`https://codeforces.com/problemset/problem/${contestId}/${encodeURIComponent(index)}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try {
      const response = await this.#fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new CodeforcesApiError(`抓取题面失败，状态码 ${response.status}：contest ${contestId} ${index}`);
      }
      return await response.text();
    } finally {
      clearTimeout(timeout);
    }
  }

  /** 抓取并解析成纯文本，是 fetchProblemStatementHtml + extractProblemStatementText 的组合。 */
  public async fetchProblemStatement(contestId: number, index: string): Promise<string> {
    const html = await this.fetchProblemStatementHtml(contestId, index);
    return extractProblemStatementText(html);
  }

  /**
   * 通用方法调用：走同一套限速 + 签名逻辑。fetchProblemsetProblems 内部也是
   * 用这个实现的；experiments/ 下的脚本如果要调 problemset.problems 之外的
   * 方法（比如 contest.list，用来按时间筛选比赛），也应该复用这个而不是
   * 自己重新拼一遍签名和限速。resultSchema 用来校验 `result` 字段本身的形状，
   * 不用管外层的 status/comment 信封，那一层已经在这里处理了。
   */
  public async callMethod<T>(
    method: string,
    params: Record<string, string>,
    resultSchema: z.ZodType<T>
  ): Promise<T> {
    const raw = await this.callMethodRaw(method, params);
    return resultSchema.parse(raw);
  }

  private async callMethodRaw(method: string, params: Record<string, string>): Promise<unknown> {
    await this.throttle();
    const query = this.#credentials === null ? { ...params } : signCodeforcesRequest(method, params, this.#credentials);
    const url = new URL(`https://codeforces.com/api/${method}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      throw new CodeforcesApiError(`Codeforces 响应不是合法 JSON（状态码 ${response.status}）：${method}`);
    }
    const envelope = cfEnvelopeSchema.parse(raw);
    if (envelope.status === "FAILED") {
      throw new CodeforcesApiError(`Codeforces 返回 FAILED：${envelope.comment}`);
    }
    return envelope.result;
  }

  private async throttle(): Promise<void> {
    if (this.#lastRequestAt !== null) {
      const elapsed = this.#now() - this.#lastRequestAt;
      const remaining = this.#minimumRequestIntervalMs - elapsed;
      if (remaining > 0) {
        await this.#sleep(remaining);
      }
    }
    this.#lastRequestAt = this.#now();
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// apiSig 签名
// ---------------------------------------------------------------------------

export interface SignCodeforcesRequestOptions {
  /** 测试用：固定 rand，而不是每次随机生成。 */
  readonly rand?: string;
  /** 测试用：固定 time（Unix 秒），而不是取当前时间。 */
  readonly time?: number;
}

/** 返回值是签好名、可以直接拼进查询字符串的完整参数集合（含 apiKey/time/apiSig）。 */
export function signCodeforcesRequest(
  method: string,
  params: Record<string, string>,
  credentials: CodeforcesCredentials,
  options: SignCodeforcesRequestOptions = {}
): Record<string, string> {
  const time = String(options.time ?? Math.floor(Date.now() / 1000));
  const allParams: Record<string, string> = { ...params, apiKey: credentials.key, time };

  const sortedEntries = Object.entries(allParams).sort(([keyA, valueA], [keyB, valueB]) => {
    if (keyA !== keyB) {
      return keyA < keyB ? -1 : 1;
    }
    if (valueA !== valueB) {
      return valueA < valueB ? -1 : 1;
    }
    return 0;
  });

  const queryString = sortedEntries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");

  const rand = options.rand ?? randomRandComponent();
  const stringToHash = `${rand}/${method}?${queryString}#${credentials.secret}`;
  const hash = createHash("sha512").update(stringToHash, "utf8").digest("hex");

  return { ...allParams, apiSig: `${rand}${hash}` };
}

function randomRandComponent(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(6);
  let result = "";
  for (let i = 0; i < 6; i += 1) {
    result += alphabet[(bytes[i] as number) % alphabet.length];
  }
  return result;
}

// ---------------------------------------------------------------------------
// 题面 HTML -> 纯文本
// ---------------------------------------------------------------------------

/**
 * 从完整页面 HTML 里解析出纯文本题面：
 *   - 只取 div.problem-statement 内的内容；
 *   - <script type="math/tex">...</script>（Codeforces 用来存放 LaTeX 源码的
 *     地方）转成 $...$ 或 $$...$$，不是直接丢弃，因为这经常是数据范围等
 *     关键信息；
 *   - 其它 <script>（MathJax 加载器/配置等）和 <style> 整段删除；
 *   - 块级标签（div/p/li/tr/h1-6/br）转换成换行，其余标签直接去掉；
 *   - 解码常见 HTML 实体，折叠多余空白。
 * 不是通用 HTML 解析器，只覆盖 Codeforces 题目页面这一种结构。
 */
export function extractProblemStatementText(html: string): string {
  const statementHtml = extractProblemStatementDiv(html);
  if (statementHtml === null) {
    throw new CodeforcesParseError("HTML 中没有找到 div.problem-statement，题面可能改版或抓取失败。");
  }
  const withMath = replaceMathScripts(statementHtml);
  const withoutScripts = stripTagAndContent(withMath, "script");
  const withoutStyles = stripTagAndContent(withoutScripts, "style");
  const withNewlines = insertNewlinesForBlockTags(withoutStyles);
  const textOnly = stripAllTags(withNewlines);
  const decoded = decodeHtmlEntities(textOnly);
  return collapseWhitespace(decoded);
}

/**
 * 找到 `<div class="...problem-statement...">` 并返回它内部（不含这层 div 本身）
 * 的原始 HTML，用简单的深度计数正确处理任意层级的嵌套 div。找不到时返回 null。
 * 单独导出主要是为了直接测试嵌套处理是否正确，不依赖后续的文本清洗步骤。
 */
export function extractProblemStatementDiv(html: string): string | null {
  const startPattern = /<div[^>]*\bclass="[^"]*\bproblem-statement\b[^"]*"[^>]*>/i;
  const startMatch = startPattern.exec(html);
  if (startMatch === null || startMatch.index === undefined) {
    return null;
  }
  const contentStart = startMatch.index + startMatch[0].length;

  const tagPattern = /<div\b[^>]*>|<\/div\s*>/gi;
  tagPattern.lastIndex = contentStart;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html)) !== null) {
    if (match[0].toLowerCase().startsWith("</div")) {
      depth -= 1;
      if (depth === 0) {
        return html.slice(contentStart, match.index);
      }
    } else {
      depth += 1;
    }
  }
  return null;
}

function replaceMathScripts(html: string): string {
  return html.replace(
    /<script\b[^>]*\btype="math\/tex(?:; ?mode=display)?"[^>]*>([\s\S]*?)<\/script\s*>/gi,
    (fullMatch, mathSource: string) => {
      const isDisplay = /mode=display/i.test(fullMatch);
      const delimiter = isDisplay ? "$$" : "$";
      return `${delimiter}${mathSource}${delimiter}`;
    }
  );
}

function stripTagAndContent(html: string, tagName: string): string {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}\\s*>`, "gi");
  return html.replace(pattern, "");
}

function insertNewlinesForBlockTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n</$1>")
    .replace(/<(p|div|li|h[1-6])\b[^>]*>/gi, "\n<$1>");
}

function stripAllTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function decodeHtmlEntities(text: string): string {
  // &amp; 必须最后解码，否则会把源文本里本来就写的 "&amp;lt;" 这类内容
  // 二次解码成 "<"。
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function collapseWhitespace(text: string): string {
  const lines = text.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim());
  const collapsed: string[] = [];
  for (const line of lines) {
    const previous = collapsed[collapsed.length - 1];
    if (line.length === 0 && previous === "") {
      continue;
    }
    collapsed.push(line);
  }
  return collapsed.join("\n").trim();
}
