/**
 * 一个只支持很小的 YAML 子集的解析器。
 *
 * 为什么要自己写：项目要求生产依赖只有 zod，不引入 js-yaml / yaml 之类的包。
 * `config/models.yaml` 的结构本身也不复杂（嵌套映射 + 标量 + 一层平铺列表），
 * 所以没必要为此引入完整的 YAML 实现。
 *
 * 支持的子集：
 *   - `#` 注释：不在引号内、且前面是行首或空白字符时，`#` 到行尾都是注释；
 *   - 空行忽略；
 *   - 缩进只能用空格，不允许 Tab；缩进层级由相邻行的相对缩进决定，
 *     不强制要求每层正好两个空格；
 *   - 映射：`key: value` 或 `key:`（值由后续更深缩进的行给出）；
 *   - 列表：`- value`，元素只能是标量，不支持“列表项本身是映射”的写法；
 *   - 标量：双引号字符串（支持 \\、\"、\n、\t 转义）、单引号字符串
 *     （`''` 表示一个单引号）、不加引号的裸字符串、整数、小数、
 *     true/false、null/~/空值；
 *   - 不支持：锚点与别名、多文档（`---`）、块级字符串（`|`、`>`）、
 *     流式集合（`{a: 1}`、`[1, 2]`）、列表项是映射。
 *
 * 如果输入用到了以上没提及的语法，会抛出 `YamlLiteError`，而不是悄悄解析错。
 */

export class YamlLiteError extends Error {
  public readonly line: number;

  public constructor(message: string, line: number) {
    super(`第 ${line} 行：${message}`);
    this.name = "YamlLiteError";
    this.line = line;
  }
}

export type YamlLiteValue =
  | string
  | number
  | boolean
  | null
  | YamlLiteValue[]
  | { [key: string]: YamlLiteValue };

type Container = YamlLiteValue[] | Record<string, YamlLiteValue>;

interface Frame {
  indent: number;
  container: Container;
  /** 上一次写入的、值为空待定的 key（可能被后续更深缩进的行确定为对象或数组）。 */
  pendingKey: string | null;
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function parseYamlLite(source: string): Record<string, YamlLiteValue> {
  const root: Record<string, YamlLiteValue> = {};
  const stack: Frame[] = [{ indent: -1, container: root, pendingKey: null }];

  const rawLines = source.split(/\r\n|\n|\r/);

  for (let index = 0; index < rawLines.length; index += 1) {
    const lineNumber = index + 1;
    const rawLine = rawLines[index] ?? "";
    if (rawLine.includes("\t")) {
      throw new YamlLiteError("不允许使用 Tab 缩进或包含 Tab 字符，请用空格。", lineNumber);
    }

    const withoutComment = stripComment(rawLine, lineNumber);
    if (withoutComment.trim().length === 0) {
      continue;
    }

    const indent = withoutComment.length - withoutComment.trimStart().length;
    const content = withoutComment.trim();

    // 回退到匹配当前缩进的层级：只有严格小于栈顶缩进才出栈，等于则是同级条目。
    while (stack.length > 1 && indent < currentFrame(stack).indent) {
      stack.pop();
    }

    let top = currentFrame(stack);

    if (indent > top.indent) {
      const isRootFirstLine = stack.length === 1 && top.indent === -1;
      if (isRootFirstLine) {
        // 整个文件第一条非空内容行：把它的缩进采纳为顶层基准缩进，
        // 不需要“待定 key”，因为根容器本来就是写入目标，不是谁的子级。
        top.indent = indent;
      } else {
        // 这一行比当前栈顶更深，必须是栈顶最近一个“待定 key”的子内容。
        if (top.pendingKey === null) {
          throw new YamlLiteError("出现了没有对应父级键的缩进。", lineNumber);
        }
        const parentContainer = top.container;
        if (Array.isArray(parentContainer)) {
          throw new YamlLiteError("列表项不能再嵌套子级内容（不支持列表项是映射）。", lineNumber);
        }
        if (parentContainer[top.pendingKey] !== null) {
          // 正常流程下，待定 key 对应的占位值一定还是 null。如果不是，说明缩进
          // 既不匹配父级也不匹配已经建立的子级，是不一致的缩进，必须报错而不是
          // 静默覆盖已经解析出来的内容。
          throw new YamlLiteError("缩进和已建立的层级都不匹配，无法确定这一行属于哪一级。", lineNumber);
        }
        const isListItem = content === "-" || content.startsWith("- ");
        const child: Container = isListItem ? [] : {};
        parentContainer[top.pendingKey] = child;
        stack.push({ indent, container: child, pendingKey: null });
        top = currentFrame(stack);
      }
    } else if (indent < top.indent) {
      // 只会在 stack 已经回退到根节点、但根节点采纳的基准缩进比这一行更深时出现
      // （例如文件第一行缩进了 2 格，后面又出现缩进为 0 的顶层行）。
      throw new YamlLiteError("缩进比已采纳的顶层基准缩进更浅，无法解析。", lineNumber);
    }

    const isListItem = content === "-" || content.startsWith("- ");
    if (isListItem) {
      if (!Array.isArray(top.container)) {
        throw new YamlLiteError("这个位置期望映射条目，却出现了列表项（- ...）。", lineNumber);
      }
      const valueText = content === "-" ? "" : content.slice(2).trim();
      if (valueText.length === 0) {
        throw new YamlLiteError("列表项不能为空，也不支持列表项本身是映射。", lineNumber);
      }
      top.container.push(parseScalar(valueText, lineNumber));
      top.pendingKey = null;
      continue;
    }

    if (Array.isArray(top.container)) {
      throw new YamlLiteError("这个位置期望列表项（- ...），却出现了映射条目。", lineNumber);
    }

    const { key, value } = splitKeyValue(content, lineNumber);
    if (value.length === 0) {
      // 值留空：可能是 null，也可能后面跟更深缩进的子内容；先写 null，
      // 如果后面出现更深缩进的子行，上面的分支会覆盖成 {} 或 []。
      top.container[key] = null;
      top.pendingKey = key;
    } else {
      top.container[key] = parseScalar(value, lineNumber);
      top.pendingKey = null;
    }
  }

  return root;
}

function currentFrame(stack: Frame[]): Frame {
  const top = stack[stack.length - 1];
  if (top === undefined) {
    throw new YamlLiteError("内部错误：解析栈为空。", 0);
  }
  return top;
}

/**
 * 去掉不在引号内的 `#` 注释。注释规则：`#` 前面是行首或空白字符。
 */
function stripComment(line: string, lineNumber: number): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== null) {
      if (quote === '"' && ch === "\\") {
        i += 1; // 跳过被转义的下一个字符
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") {
      const previous = i === 0 ? undefined : line[i - 1];
      if (previous === undefined || /\s/.test(previous)) {
        return line.slice(0, i);
      }
    }
  }
  if (quote !== null) {
    throw new YamlLiteError("字符串引号没有闭合。", lineNumber);
  }
  return line;
}

function splitKeyValue(content: string, lineNumber: number): { key: string; value: string } {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (quote !== null) {
      if (quote === '"' && ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ":" && (i === content.length - 1 || content[i + 1] === " ")) {
      const key = content.slice(0, i).trim();
      const value = content.slice(i + 1).trim();
      if (!KEY_PATTERN.test(key)) {
        throw new YamlLiteError(
          `键名 "${key}" 不合法，只允许字母、数字、下划线、连字符，且不能以数字开头。`,
          lineNumber
        );
      }
      return { key, value };
    }
  }
  throw new YamlLiteError(`无法解析这一行，既不是 "key: value" 也不是 "- value"：${content}`, lineNumber);
}

function parseScalar(text: string, lineNumber: number): YamlLiteValue {
  if (text === "~" || text === "null") {
    return null;
  }
  if (text === "true") {
    return true;
  }
  if (text === "false") {
    return false;
  }
  if (text.startsWith('"')) {
    return parseDoubleQuoted(text, lineNumber);
  }
  if (text.startsWith("'")) {
    return parseSingleQuoted(text, lineNumber);
  }
  if (/^-?\d+$/.test(text)) {
    return Number.parseInt(text, 10);
  }
  if (/^-?\d+\.\d+$/.test(text)) {
    return Number.parseFloat(text);
  }
  return text;
}

function parseDoubleQuoted(text: string, lineNumber: number): string {
  if (text.length < 2 || !text.endsWith('"')) {
    throw new YamlLiteError("双引号字符串没有闭合。", lineNumber);
  }
  const inner = text.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "\\") {
      const next = inner[i + 1];
      if (next === undefined) {
        throw new YamlLiteError("双引号字符串里有未完成的转义。", lineNumber);
      }
      switch (next) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        default:
          throw new YamlLiteError(`不支持的转义序列 "\\${next}"。`, lineNumber);
      }
      i += 1;
    } else if (ch === '"') {
      throw new YamlLiteError("双引号字符串中间出现了未转义的引号。", lineNumber);
    } else {
      out += ch;
    }
  }
  return out;
}

function parseSingleQuoted(text: string, lineNumber: number): string {
  if (text.length < 2 || !text.endsWith("'")) {
    throw new YamlLiteError("单引号字符串没有闭合。", lineNumber);
  }
  const inner = text.slice(1, -1);
  return inner.replace(/''/g, "'");
}
