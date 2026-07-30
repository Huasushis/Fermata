# AGENTS.md

给在这个仓库里工作的人类和 AI 代理看的约定。README.md 是给"使用者"看的介绍，
这份文件是给"改代码的人"看的规则——两者不重复，README 没讲清楚具体规则的地方
以这里为准。

## 1. 项目定位

Fermata 是 USTC 算法竞赛协会的独立 AI 审题服务，**不是** Urmotiv 内部的一个
插件，是一个单独部署、单独仓库的进程：

- 用机器人令牌调用 Urmotiv 的机器人 API，主动领取待审题目、续租、提交结构化
  审核意见；
- 自己暴露一个管理端口（HTTP），供 Urmotiv 侧的 `fermata-control` 插件读取
  健康状态、读写"公开设置"（不含密钥）、触发立即轮询。

Fermata 不是"站内任意代码执行器"：它只能通过机器人 API 做 Urmotiv 明确允许
机器人做的事，看不到、也不需要看到普通用户账号能看到的其它内容。

## 2. 契约来源，以及怎么保持同步

Fermata 是独立仓库，**不通过 workspace 依赖 Urmotiv**，所以没法直接 `import`
Urmotiv 的 `@urmotiv/contracts` 包。凡是和 Urmotiv 之间的数据结构，都手工镜像
到本仓库里，并且明确标注来源：

- `src/urmotiv-schemas.ts`：从 Urmotiv `packages/contracts/src/{problem,review,robot}.ts`
  镜像过来的 zod schema 子集（机器人任务领取/续租/提交、Fermata 健康状态、
  Fermata 公开设置）。文件头写了对齐时间和来源路径。
- 管理端口的四个路由（`src/server.ts`）对应 Urmotiv 那边
  `plugins/fermata-control/src/index.ts` 里 `FermataControlClient` 期望的形状：
  `GET /api/v1/health`、`GET/PUT /api/v1/settings/public`、
  `POST /api/v1/actions/wake`，鉴权都是 `Authorization: Bearer <管理令牌>`。

**规则：如果 Urmotiv 那边这些 schema 或者路由约定变了，必须回来手动同步这两
处，不能凭记忆改，也不能只改一半。** 同步之后，至少要：
1. 重新过一遍 `src/urmotiv-schemas.ts` 每个字段的约束（min/max/multipleOf/
   正则/是否 `.strict()`）是不是逐字段一致；
2. 跑一遍 `test/urmotiv-client.test.ts` 和 `test/server.test.ts` 确认没有
   回归（这两个文件分别覆盖"我们发给 Urmotiv 的请求"和"我们自己暴露的响应"）。

## 3. 密钥红线

- 机器人令牌、管理令牌、模型 API Key、Codeforces key/secret 只允许存在于
  `src/config.ts` 产出的内存对象里，不写文件、不进日志、不出现在任何对外
  响应里。
- `src/logger.ts` 里的 `describeText()` 是唯一允许用来记录题面/题解/模型
  原始输出的方式——只记长度，不记内容。**新代码如果要打印和题目内容或者模型
  输出有关的日志，用 `describeText()`，不要直接把字符串塞进日志。**
- `src/server.ts` 的 `GET/PUT /api/v1/settings/public` 响应永远要经过
  `fermataPublicSettingsResponseSchema.parse()` 再发出去——这个 schema 是
  `.strict()` 的，如果不小心往响应对象里加了一个内部字段（比如某个 provider
  的 apiKey），会在这一步直接抛错而不是把它发出去。**不要为了"方便调试"而
  绕过这一层 parse。**
- Bearer 令牌比较一律用 `src/logger.ts` 里的 `timingSafeEqual()`，不要用
  `===` 直接比较字符串。

## 4. 实验数据不入库

`experiments/` 下的脚本会抓取、生成一些数据：

- `experiments/data/`：`fetch-cf-dataset.ts` 抓下来的完整题面，整个目录都
  不入库（`.gitignore` 里是 `experiments/data/*` + 保留 `.gitkeep`）。这些
  数据本身是 Codeforces 上的公开内容，但仓库里不需要、也不应该保留题面原文——
  报告和代码里引用到具体题目时，只引用 `contestId`+`index`（比如 "CF 1500A"），
  不贴题面。
- `experiments/results/raw/`：`eval-difficulty.ts` 之类脚本写的、含有 LLM
  完整 rationale 或者更详细中间结果的原始输出，整个目录不入库，原因同上
  （可能间接带出较长的题目相关文本）。
- `experiments/results/*.json`、`experiments/results/*.md`：**这两类要入库**——
  是不含题面/题解原文的汇总统计（MAE、命中率、分档统计、每题的题号/预测值/
  真实值/误差/置信度），是调优报告应该引用的东西。**新增实验脚本时，输出要
  按这个"raw 不入库、summary 入库"的规矩分开写，不要图省事把两种输出混在
  一个不受控制的目录里。**

## 5. 数值映射表是初始标定，不能凭感觉改

以下几处，都不是从理论推导出来的公式，而是为了让流水线先能跑起来、有个
合理量级的**初始标定**，代码里都写了注释说明：

- `src/pipelines/thinking.ts` 的 `THINKING_LEVEL_WEIGHTS`（把 solved/思路
  相似度/自我纠正次数/关键洞察个数映射到 1-5 的思维难度）；
- `src/pipelines/coding.ts` 的 `DATA_STRUCTURE_SIGNATURES`（数据结构关键词
  和权重）和 `CODING_LEVEL_WEIGHTS`（行数/嵌套深度/数据结构权重映射到 1-5
  的代码难度）；
- `src/pipelines/verdict.ts` 的 `VERDICT_THRESHOLDS.duplicateSimilarityReject`
  （查重相似度超过多少、且模型自己也确认同题时强制拒绝）；
- `config/anchors/difficulty.json`（CF 难度评估用的少样本锚点题，目前是
  手工种子数据，`provisional: true`）。

**规则：修改这几处任何一个数字之前，先跑一遍
`npm run experiment:eval-difficulty`（如果改的是 difficulty/锚点相关）或者
针对性地扩展一个类似的对比评测脚本（如果改的是 thinking/coding 的映射），
拿到修改前后的 MAE / 命中率 / 分档统计做对比，把对比结果写进 PR 描述或者
`experiments/results/` 里，不能仅凭"感觉应该调高/调低"就改。** 这些映射表
所在文件的开头注释里也重复了这条规则，方便直接看到代码的人也能注意到。

## 6. 测试约定

- `test/` 下的用例不做真实网络调用：HTTP 相关的测试用注入的 `fetch` mock
  （`vi.fn()` 返回 `new Response(...)`），CF 请求间隔限速测试用注入的假
  `now`/`sleep`，`ReviewerWorker` 的轮询/续租测试用 `vi.useFakeTimers()`。
- `src/settings-store.ts`、`src/server.ts`、`src/reviewer.ts`、
  `src/urmotiv-client.ts` 都刻意把依赖收窄成结构化接口（`SettingsStoreLike`、
  `UrmotivClientLike`），而不是直接依赖具体类——这样测试可以传一个不做真实
  I/O 的假实现，不用为了测试 `ReviewerWorker` 就必须起一个真的 HTTP 服务器
  或者真的写文件。新增依赖时优先延续这个模式。
- 新增/修改 `src/yaml-lite.ts`（自己写的一个只支持很小子集的 YAML 解析器，
  因为生产依赖只允许有 zod，不能引入 `js-yaml`）之后，一定要跑
  `test/yaml-lite.test.ts`，它包含一个对真实 `config/models.yaml` 的集成
  测试，能在语法超出这个"lite"子集覆盖范围时第一时间发现。

## 7. 技术栈边界

- 生产依赖只有 `zod`；`vitest`/`typescript`/`tsx` 是 devDependencies。新增
  任何生产依赖之前，先确认真的没办法用 `node:*` 内置模块或者几十行手写代码
  解决——这是团队特意做的选择，不是疏漏。
- 不引入 HTTP 框架（Fastify/Express 等），管理端口用 `node:http` 手写；
  不引入 LLM SDK，`src/llm.ts` 直接用 `fetch` 调 OpenAI 兼容接口。
- 所有用户可见文案、注释、提交给 Urmotiv 的 `improvements`/`privateNote`
  文本、日志里的说明性文字都用简体中文。
