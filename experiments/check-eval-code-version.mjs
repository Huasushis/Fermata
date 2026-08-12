// 只在终端打印 EVAL_CODE_VERSION 的长度与格式合法性，绝不打印 env 其他内容。
const value = process.env.EVAL_CODE_VERSION;
const expected = process.argv[2];
const valid = typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const matches = valid && expected !== undefined && value === expected;
console.log(
  `EVAL_CODE_VERSION_len=${(value ?? "").length} valid=${valid} matchesHead=${matches}`
);
if (!valid || !matches) process.exit(1);