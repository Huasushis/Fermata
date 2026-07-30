# Fermata

USTC 算法竞赛协会的独立 AI 审题服务：用机器人令牌轮询 Urmotiv 题库里的待审
题目，跑一套 LLM 流水线评定难度，提交结构化的审核意见，并对 Urmotiv 的
`fermata-control` 管理插件暴露自己的健康状态和可公开设置。

## 架构

```
                         ┌───────────────────────────────┐
                         │            Urmotiv             │
                         │   （题库、账号、审核规则等）      │
                         └───────────────┬─────────────────┘
                                          │
               机器人 API（claim/renew/complete）
                   Authorization: Bearer <机器人令牌>
                                          │
                                          ▼
┌──────────────────────────────────────────────────────────────────┐
│                              Fermata                              │
│                                                                    │
│  src/reviewer.ts  主循环                                           │
│    轮询 claim → 对每个任务：                                        │
│      ┌─ difficulty.ts（CF 难度，参考锚点题）───┐                    │
│      ├─ thinking.ts（思维难度，解题 + 对比分析）├─ 并发跑           │
│      └─ coding.ts（代码难度，写参考代码 + 统计）┘                    │
│           ↓ 三者都跑完                                              │
│      verdict.ts（综合成结构化审核意见，查重阈值规则）                  │
│           ↓                                                        │
│    complete 提交回 Urmotiv；同时给每个任务挂续租定时器                │
│                                                                    │
│  src/server.ts  管理端口（node:http，Bearer 管理令牌鉴权）            │
│    GET  /api/v1/health           worker 是否在跑、活跃任务数         │
│    GET  /api/v1/settings/public  当前设置 + 乐观锁 revision          │
│    PUT  /api/v1/settings/public  改设置（enabled/并发上限/轮询间隔等）│
│    POST /api/v1/actions/wake     跳过等待，立即触发一轮轮询           │
│                                                                    │
│  src/llm.ts  直接用 fetch 调 OpenAI 兼容接口（Aether / 阿里云百炼）    │
│  src/codeforces.ts  CF API 客户端 + 题面抓取（签名、限速、HTML 解析）  │
│  src/settings-store.ts  内存 + settings.json 持久化，乐观锁           │
└──────────────────────────────────────┬─────────────────────────────┘
                                        │
                          Authorization: Bearer <管理令牌>
                                        │
                                        ▼
                         ┌───────────────────────────────┐
                         │  Urmotiv 的 fermata-control 插件  │
                         │  （设置页面、健康状态展示、唤醒按钮） │
                         └───────────────────────────────┘
```

Fermata 不是 Urmotiv 里的一个插件、不共享数据库、不共享代码依赖——两边只通过
上面这两组 HTTP 接口交互，Fermata 崩溃或者被关掉，Urmotiv 本身（人工审题、
其它插件）不受影响，只是少了机器人这一路审核意见。

## 快速开始

```bash
npm install

# 参照 .env.example，在仓库外的私有目录创建 fermata.env 并填写必需变量。
# USTC 服务器约定使用下面这个位置；不要把真实密钥文件放进仓库。
node scripts/run-with-env.mjs /home/ubuntu/urmotiv-codex/private/fermata.env npm run dev
# 上一行是 tsx watch 模式；或者单次启动：
node scripts/run-with-env.mjs /home/ubuntu/urmotiv-codex/private/fermata.env npm start
# 或者
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

启动会先校验环境变量和 `config/models.yaml`；任何必填项缺失、格式不对，或者
默认模型档位缺少对应服务商的密钥，都会在启动时直接报错退出，不会带着残缺配置
跑起来。

Fermata 本身不解析 `.env` 文件，只读取进程已经收到的环境变量。上面的
`run-with-env.mjs` 会逐行读取指定文件，再直接启动命令；它不会让 shell 解释密钥中的
特殊字符，也不会在出错时打印密钥内容。不要用 shell 的 `source` 或 `.` 加载密钥文件，
因为特殊字符可能导致命令失败并把密钥回显到终端。生产环境也可以由部署平台直接把变量
传给进程，不需要改 Fermata 的代码。

## 和 Urmotiv / fermata-control 的关系

- **谁发起连接**：Fermata 主动调用 Urmotiv 的机器人 API（claim/renew/
  complete），是"客户端"；Urmotiv 的 `fermata-control` 插件主动调用 Fermata
  的管理端口，这时候 Fermata 是"服务端"。两个方向的鉴权是两套完全独立的
  令牌（`URMOTIV_ROBOT_TOKEN` 和 `FERMATA_MANAGEMENT_TOKEN`），互不影响。
- **谁定义契约**：所有数据结构都由 Urmotiv 的 `packages/contracts` 定义，
  Fermata 只是手工镜像了用得到的子集到 `src/urmotiv-schemas.ts`，并注明了
  对齐时间和来源——这不是 Fermata 自己发明的格式。契约变了需要回来同步，
  见 AGENTS.md 第 2 节。
- **失败边界**：Fermata 的任何故障（进程崩溃、模型服务不可用、单个任务处理
  失败）都不会影响 Urmotiv 本身或者人工审题流程；反过来，Urmotiv 侧的普通
  故障也不会导致 Fermata 崩溃——领取任务失败只是跳过这一轮轮询，下一轮再试。
- **权限边界**：Fermata 拿到的机器人令牌只能做机器人 API 明确允许的事（领取
  自己有权限看的待审题目、提交审核意见），不能读写普通用户能读写的其它内容，
  更不是什么"远程执行任意代码"的后门。

## 实验怎么跑

`experiments/` 下是离线调优工具，不是线上服务的一部分，需要模型 API 密钥。
数据集有两种来源：`fetch-cf-dataset` 直连 Codeforces API（服务器上题面网页可能被
Cloudflare 拦截）；`fetch-hf-dataset` 从公开数据集 open-r1/codeforces（CC-BY-4.0）
经镜像抽样，带官方 rating 和题解，更稳，推荐。评测脚本支持 `EVAL_CONCURRENCY`
控制并发（默认 6/4），大幅缩短总时长。

```bash
# 下列命令都通过安全脚本读取仓库外的环境文件。
FERMATA_ENV_FILE=/home/ubuntu/urmotiv-codex/private/fermata.env

# 1. 取数据集：评估集放默认 cf/ 子目录
SAMPLE_SIZE_PER_BUCKET=2 node scripts/run-with-env.mjs "$FERMATA_ENV_FILE" npm run experiment:fetch-hf-dataset
# 标定集（带题解，供思维/代码难度实验）放 levels/ 子目录
DATA_SUBDIR=levels SAMPLE_SIZE_PER_BUCKET=1 node scripts/run-with-env.mjs "$FERMATA_ENV_FILE" npm run experiment:fetch-hf-dataset

# 2. 选一批锚点题（已有官方难度、供模型对照的参照题），覆盖 config/anchors/difficulty.json
DATA_SUBDIR=levels ANCHOR_COUNT=8 node scripts/run-with-env.mjs "$FERMATA_ENV_FILE" npm run experiment:calibrate-anchors

# 3. CF 难度评测：输出平均绝对误差（预测与实际平均相差多少，报告中记作 MAE）、
# ±200 命中率和分档统计；脚本会排除参照题，避免提前见过答案影响结果。
EVAL_CONCURRENCY=6 node scripts/run-with-env.mjs "$FERMATA_ENV_FILE" npm run experiment:eval-difficulty -- --label=calibrated

# 4. 思维/代码难度标定：检验 rating 越高等级是否单调上升。
# 中断后用相同 label 加 --resume，只补跑没有完成的题。
EVAL_CONCURRENCY=2 node scripts/run-with-env.mjs "$FERMATA_ENV_FILE" npm run experiment:calibrate-levels -- --label=v1 --resume

# 5. 综合评审判定：正常题不误拦 + 构造原题触发强制不通过
node scripts/run-with-env.mjs "$FERMATA_ENV_FILE" npm run experiment:eval-verdict -- --label=v1
```

完整用法是 `node scripts/run-with-env.mjs <env文件> <命令> [参数...]`。不要改回
shell 的 `source` 或 `.`。

思维和代码难度标定中的深度推理可能明显超过 90 秒。正式服务和该实验现在默认允许单次请求等待
600 秒，避免请求方过早断开后让模型服务记录 `499`。实验可用 `LEVELS_LLM_TIMEOUT_MS` 单独覆盖
等待时间，用 `LEVELS_LLM_MAX_ATTEMPTS` 调整总尝试次数；两者都只接受有范围限制的整数。脚本会在
每题完成后把不含题面原文的中间结果写入 `experiments/results/raw/`，以相同 `--label` 加
`--resume` 时会复用这些结果，不会重复调用已经完成的题。需要保留旧的公开报告时，请换一个新
`--label`，再用 `--resume-from=<旧标签>` 复用旧标签下已经完成的题；这样旧报告不会被覆盖。

产出的 `experiments/results/*.json` 和 `*.md` 是不含题面原文的汇总统计，会
入库；`experiments/data/` 和 `experiments/results/raw/` 里含有较完整的题面/
中间结果，不入库。规则详见 AGENTS.md 第 4 节。

如果要修改 `src/pipelines/{thinking,coding,verdict}.ts` 里的数值映射表/阈值，
必须先跑一遍对比评测再改——见 AGENTS.md 第 5 节。

## 当前校准状态

当前本地工作区尚未包含 `experiments/results/` 下的脱敏汇总报告。下面只区分
“当前随服务发布的配置”和“曾在验收服务器完成的离线实验”，不把离线实验误写成
当前运行配置已经完成校准。报告同步回来后，应以实际报告文件补充精确数字和链接，
不能凭交接文字手工重建报告。

| 流水线 | 状态 | 说明 |
| --- | --- | --- |
| CF 难度（difficulty.ts） | **发布配置仍是临时数据** | 当前 `config/anchors/difficulty.json` 只有 2 条手工种子，并标记为 `provisional: true`（表示尚未完成正式校准）。验收服务器曾用 7 条真实参照题做离线对比，但那份实验配置和脱敏报告尚未同步回本地，不能据此声称当前服务已经采用 7 条参照题。 |
| 思维难度（thinking.ts） | **离线小样本结论待报告同步** | 已知的小样本结果中，题目实际难度升高时，思维难度平均值没有下降；样本仍不足，扩大样本后需要复核。 |
| 代码难度（coding.ts） | **离线结果显示需要调整后重跑** | 小样本中出现了题目实际难度升高、代码难度平均值反而下降的区间，而且高分段没有样本。必须先扩大标定集，再按同步回来的报告调整 `CODING_LEVEL_WEIGHTS`，并用新的 `--label` 保留修改前后两份报告。 |
| 查重判断（verdict.ts） | **离线判定实验待报告同步** | 验收服务器已运行正常题和人工构造的重复题用例；脱敏汇总报告同步回仓库后，再在这里补充可核对的结果和链接。 |

这张表应该随每一次真正跑过评测脚本之后更新。只有对应的脱敏汇总报告已经存在于
`experiments/results/` 时，才能在这里填写精确数字、评测日期和文件链接。

## 待确认 / 待对齐的点

- **Anklang 查重条目的 `data` 形状**：`review.ts` 里 reviewItem 的 `data`
  字段是 `z.unknown()`，`src/pipelines/verdict.ts` 里的
  `extractSimilarityFromData` 目前尽力兼容几种可能的形状
  （`data.similarity`/`data.topSimilarity`/`data.candidates[].similarity`），
  等 Anklang 插件那边的实际结构定下来，应该回来对齐这段逻辑。
- **`reviewInputSchema` 和 `docs/spec.md` 5.3 节的措辞略有出入**：spec.md
  提到审核意见包含"公开评论"，但 `packages/contracts/src/review.ts` 实际
  字段是 `verdict/codeforcesDifficulty/qualityLevel/thinkingLevel/
  codingLevel/tagIds/improvements/privateNote/expectedRound`，没有独立的
  `publicComment` 字段——`improvements`（主要改进点）本身就是必填、面向审核
  意见的内容。Fermata 这边是按实际契约代码实现的，如果这确实是 spec.md 和
  代码之间的用词不一致，建议回来对齐文档。
- **知识点标签修正**：Fermata 目前没有从机器人 API 拿到 Urmotiv 的标签词表，
  没办法判断自己想出来的标签 id 是不是真实存在，所以 `verdict.ts` 提交的
  `tagIds` 目前总是空数组，没有启用"标签修正建议"这个能力。如果以后机器人
  API 增加了标签列表的读取入口，可以在 `verdict.ts` 里补上。

## 项目结构

```
config/
  models.yaml              模型档位配置（每条流水线用什么模型/温度/是否思考，见文件内注释）
  anchors/difficulty.json  CF 难度评估的参照题（当前发布的是 2 条临时数据，见"当前校准状态"）
src/
  config.ts                读 env + models.yaml，启动即校验
  yaml-lite.ts             一个只支持很小子集的 YAML 解析器（避免引入额外依赖）
  logger.ts                日志 + 常量时间比较，硬性规则见 AGENTS.md 第 3 节
  urmotiv-schemas.ts       从 Urmotiv contracts 镜像的 zod schema
  urmotiv-client.ts        机器人 API 客户端（claim/renew/complete）
  llm.ts                   OpenAI 兼容 chat 客户端（重试、JSON 结构化输出）
  codeforces.ts            CF API 客户端 + 题面抓取
  settings-store.ts        运行期设置，内存 + 文件持久化，乐观锁
  reviewer.ts              主循环：轮询、并发、续租、优雅停机
  server.ts                管理端口
  index.ts                 入口
  pipelines/
    difficulty.ts / thinking.ts / coding.ts / verdict.ts
experiments/               离线调优脚本，见上面"实验怎么跑"
test/                      vitest，覆盖签名算法、HTML 解析、数值映射、
                           settings 乐观锁、verdict 阈值、client 错误分类等
```
