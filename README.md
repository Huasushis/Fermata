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
特殊字符，也不会在出错时打印密钥内容。如果当前终端设置了 `NODE_DEBUG` 或
`NODE_DEBUG_NATIVE`，它会在读取密钥前拒绝启动；env 文件本身包含这两个设置时也会
拒绝启动，避免 Node 把子进程环境写到终端。
不要用 shell 的 `source` 或 `.` 加载密钥文件，
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
# 首次运行不加 --resume。
EVAL_CONCURRENCY=2 node scripts/run-with-env.mjs "$FERMATA_ENV_FILE" npm run experiment:calibrate-levels -- --label=v1
# 中断后保持原参数不变，并用相同 label 加 --resume，只补跑没有完成的题。
EVAL_CONCURRENCY=2 node scripts/run-with-env.mjs "$FERMATA_ENV_FILE" npm run experiment:calibrate-levels -- --label=v1 --resume

# 5. 综合评审判定：正常题不误拦 + 构造原题触发强制不通过
node scripts/run-with-env.mjs "$FERMATA_ENV_FILE" npm run experiment:eval-verdict -- --label=v1
```

完整用法是 `node scripts/run-with-env.mjs <env文件> <命令> [参数...]`。不要改回
shell 的 `source` 或 `.`。

### 让长时间标定留在服务器运行

思维/代码难度标定的一次模型请求可能持续数分钟。通过 SSH 在服务器上启动时，可以
使用下面的专用后台命令。它会创建独立于当前终端的进程；在服务器没有配置“用户退出
时清理全部登录会话进程”的常规环境下，关闭 SSH，或者发起 SSH 的本地电脑关机、重启，
不会仅因为终端断开而切断正在等待的模型请求。若服务器启用了登录会话进程清理，应改用
该服务器的 systemd 服务或其它长期任务管理方式。

```bash
FERMATA_ENV_FILE=/home/ubuntu/urmotiv-codex/private/fermata.env
FERMATA_CALIBRATION_RUN_DIR=/home/ubuntu/urmotiv-codex/private/fermata-calibration-runs

# 新实验
npm run experiment:calibrate-levels:detached -- \
  --environment-file="$FERMATA_ENV_FILE" \
  --private-dir="$FERMATA_CALIBRATION_RUN_DIR" \
  --label=v1

# 同一标签中断后的续跑
npm run experiment:calibrate-levels:detached -- \
  --environment-file="$FERMATA_ENV_FILE" \
  --private-dir="$FERMATA_CALIBRATION_RUN_DIR" \
  --label=v1 \
  --resume

# 从旧标签的检查点复制到尚未使用的新标签
npm run experiment:calibrate-levels:detached -- \
  --environment-file="$FERMATA_ENV_FILE" \
  --private-dir="$FERMATA_CALIBRATION_RUN_DIR" \
  --label=v2 \
  --resume-from=v1
```

这个后台入口只支持 Linux 服务器。`--environment-file` 和 `--private-dir` 都必须是服务器
绝对路径，并且都必须位于 Fermata 仓库之外。env 文件不能是符号链接，必须属于启动
标定的当前用户，而且不能给同组用户或其他用户任何权限；通常应使用 `0600`。后台
入口和 `run-with-env.mjs` 共用同一套 env 解析规则，但只从文件接收 Fermata 配置、
模型服务配置和本标定支持的有界运行参数，忽略 `NODE_OPTIONS` 等能改变 Node 启动
行为的变量。如果启动终端设置了 `NODE_DEBUG` 或 `NODE_DEBUG_NATIVE`，入口会在读取
密钥和创建子进程前拒绝启动，避免 Node 的调试输出把子进程环境写到终端。

请给每个部署使用一个专用私有运行目录；它的父目录必须预先存在，最后一级目录不存在时
启动器会按 `0700` 创建。已存在的目录必须属于当前用户并且已经是 `0700`，启动器不会
改动一个权限过宽的既有目录。
每次启动会写一个唯一的 `0600` 日志和一个通过临时文件原子替换的 `0600` JSON 元数据
文件。元数据只含固定格式版本、任务类型、任务编号、实际标定进程及进程组 ID、标签、
续跑方式、启动时间、启动状态和日志文件名，不保存环境变量、env 文件路径、完整命令
或模型服务地址。命令启动后会打印任务编号、进程及进程组 ID 和两个文件名；“已脱离”
只表示后台进程已经创建，最终是否成功仍应以日志和标定报告为准。

这个入口固定运行 `calibrate-levels`，启动器自身使用参数数组和 `shell: false` 创建
后台进程，不把用户输入拼成 shell 命令，也不接受任意命令。除两个路径参数外，只允许
标定本身支持的 `--label`、`--resume` 和 `--resume-from`；未知、重复、冲突或格式
不安全的参数会在创建进程前被拒绝。并发、等待时间和重试次数仍通过受原标定脚本范围
检查的环境变量设置。

这里的“电脑重启”只指发起 SSH 的本地电脑。Fermata 所在服务器重启、进程被系统
终止或服务器网络中断，仍会终止当前模型请求。确认旧进程已停止后，保持数据、代码、
模型和运行参数不变，用同一 `--label` 加 `--resume` 继续；已经写入检查点的阶段不会
重跑。

思维和代码难度标定中的深度推理可能明显超过 90 秒。模型开始输出后，每收到一段新数据都会重新
计算等待时间；默认连续 10 分钟没有新数据才停止。等待第一段输出默认最多 30 分钟，每次向模型
服务发出请求另有 4 小时的最终保护。实验可分别用 `LEVELS_LLM_OUTPUT_IDLE_MS`、
`LEVELS_LLM_FIRST_OUTPUT_MS` 和 `LEVELS_LLM_MAX_DURATION_MS` 覆盖这三项。它们只接受整数，
安全下限依次是 600000、1800000 和 14400000 毫秒，上限都是 86400000 毫秒；最长时间不能小于
另外两项等待时间。旧的 `LEVELS_LLM_TIMEOUT_MS` 已不再支持，设置后会明确报错。
`LEVELS_LLM_MAX_ATTEMPTS` 调整最多尝试次数，但只有模型服务明确返回请求过多时才会再次尝试。
`EVAL_CONCURRENCY` 决定同时处理几道题，只接受 1 到 32 的整数。模型响应正文按 UTF-8 原始字节
计算，固定最多读取 4 MiB（约 4 MB）；超过后立即停止读取，并且错误和日志都不会包含响应正文。

正式服务已有的 `settings.json` 会保留上次保存的 `experimentVersion`，不会因为替换
`models.yaml` 自动改变。部署这次流式请求改动后，应在没有在途任务时，通过 Urmotiv 的
Fermata 设置页或管理接口把 `experimentVersion` 明确更新为
`experiment-2026-07-stream-v1`，再恢复领取任务；这样提交的审核结果才能准确说明使用了哪一版
请求与等待规则。

脚本会在发出任何模型请求前检查标定集里的全部 JSON 文件。损坏的 JSON、缺少必需字段、空题解、
不符合 Codeforces 题号格式的 index（如小写 `a`、`AA` 或含空白的值）、非正数比赛编号或
rating（官方难度分）、
重复题号和空目录都会让整次实验立即失败，不会先跳过这些文件再把较小的数据集误写成“完整”。
标定集还必须同时包含低、中、高三个 rating 段；缺任一段时会在付费模型调用前直接失败，不生成
可用于调整算法的报告。实验结束时仍会再次检查题数和三个分段，不能用不完整结果调整提示词、
工作流或数值映射。

每道题的思维阶段完成后，脚本就会先保存等级和固定结构的数字、布尔值信号；代码阶段完成后再补上
代码等级和对应信号。因此，代码阶段失败时，用同一标签加 `--resume` 会直接保留已经完成的思维结果，
只补跑代码阶段。思维阶段失败的题不会继续请求代码模型。

脚本会把不含题面原文的进度保存到唯一的
`experiments/results/raw/levels-<标签>-checkpoint.json`。以相同 `--label` 加 `--resume`
时只读取这一个检查点，不扫描或合并同标签的其它历史快照；检查点不存在或损坏会明确失败。
需要保留旧的公开报告时，可以换一个新 `--label`，再用 `--resume-from=<旧标签>` 读取旧标签的
唯一检查点。

当前检查点格式版本是 3。版本 2 只会在整道题两个阶段都成功后保存，无法安全判断哪些思维结果可以
复用，因此会被明确拒绝，不能自动转换或拼进版本 3。需要继续版本 2 的实验时，应先用原代码自然结束；
切换到当前代码后则使用新标签从头运行。

标签一旦已有检查点、带时间的原始快照、汇总、报告或写到一半的临时文件，就不能再作为新实验的
标签；请使用 `--resume` 续跑同一标签，或者换一个新标签重新开始。使用 `--resume-from=<旧标签>`
时，参数里填写的是读取来源，当前 `--label` 必须是尚未使用的新标签，两者不能相同。这样既不会
覆盖旧报告，也能保留调整前后的两份报告做对比。

检查点带有“实验校验摘要”：它把完整标定集内容、实际模型档位配置、思维/代码流水线源文件以及
辅助代码、分段标准、实际模型服务地址、等待时间、重试设置和同时处理题数压成校验值，用来确认
续跑前后是否完全一致。题面、题解、rating、模型配置、提示词、数值映射代码或这些运行参数有任何
变化，续跑都会被拒绝；这时必须使用新标签从头运行，不能把不同实验的结果拼在一起。汇总和报告
会列出这些不含密钥的运行参数；服务地址只显示“地址校验值”，也就是用来比较两次地址是否相同的
短字符串，不会写出完整地址、私有路径、查询参数或 API key。模型服务地址不得包含账号、密码、
查询参数（网址中 `?` 后的内容）或片段（`#` 后的内容），密钥必须放在单独的 API key 环境变量中。
比第 2 版更早且没有校验摘要的格式也会被拒绝。
修改提示词、权重、映射或运行参数后的对比实验必须使用新标签从头运行，不能加 `--resume-from`；
这个参数只用于数据、代码、模型和运行参数完全相同、但需要把旧检查点复制到新标签继续保存的情况。
相同标签同时只能运行一个进程；锁文件带有每次随机生成的所有权标记，旧进程不会删除后来进程的
锁。如果进程异常终止留下 `.lock` 文件，应先确认服务器上没有对应标定进程，再人工移除该锁文件。

检查点和报告都会先写入随机命名的临时文件，写完后一次替换目标文件，避免中途终止留下半份
JSON；日志只记录固定错误码、题号、标签、模型档位、阶段、等级、运行参数和汇总数字，不记录服务商
错误原文、题面、题解或模型原始输出。检查点、汇总和报告中的失败统计也只记录“思维或代码阶段”、
固定错误码、100 到 599 中表示失败的 HTTP 状态码（不含 2xx 成功状态；没有可用状态码时为 `null`）
和累计次数。即使本次没有任何一道题完成两个阶段，脚本仍会写出安全的
不完整汇总和报告，随后以失败状态退出，方便核对失败类型并继续运行；这类报告不能用于调整算法。

产出的 `experiments/results/*.json` 和 `*.md` 是不含题面原文的汇总统计，会
入库；`experiments/data/` 和 `experiments/results/raw/` 里含有较完整的题面/
中间结果，不入库。规则详见 AGENTS.md 第 4 节。

如果要修改 `src/pipelines/{thinking,coding,verdict}.ts` 里的数值映射表/阈值，
必须先跑一遍对比评测再改——见 AGENTS.md 第 5 节。

## 当前校准状态

迁移前的 7 次逻辑实验已经登记在
`experiments/results/legacy-report-registry.json`。登记表只保存实验类型、标签、时间、
样本计数、完整性三态和安全汇总产物的 SHA-256 校验值；旧产物仍原样保留在只读档案，
没有复制 raw 区内容。运行 `npm run experiment:verify-legacy-reports` 可以逐字节核对
13 份唯一脱敏汇总及其重复快照，输出只含数量，不显示档案文件名或内容。

这些旧实验中有的明确缺样本或缺分段，其余旧格式没有 expected、失败和跳过计数，
都不能作为当前代码的合格基线。新付费实验仍必须先用当前代码跑完整旧方案，再用唯一
新标签跑候选方案并保留两份报告。

| 流水线 | 状态 | 说明 |
| --- | --- | --- |
| CF 难度（difficulty.ts） | **发布配置仍是临时数据** | 当前 `config/anchors/difficulty.json` 只有 2 条手工种子，并标记为 `provisional: true`。旧报告有 24 题和 33 题两组，但旧格式无法证明没有失败或跳过，且都少于当前最低要求 60 题。 |
| 思维难度（thinking.ts） | **旧实验均不可作基线** | 两份早期报告无法证明完整；后两份明确只完成 6/24、9/24，而且都缺高分段。 |
| 代码难度（coding.ts） | **旧实验均不可作基线** | 与思维难度共用的旧实验不完整；小样本曾出现难度分段升高但代码难度均值下降，需要在完整基线上复核。 |
| 查重判断（verdict.ts） | **旧设计不可作准确性基线** | 旧实验只有 3 个正常样本和 3 个人工重复样本；正常组只验证“不是不通过”，没有区分通过与需要修改。 |

这张表应该随每一次真正跑过评测脚本之后更新。只有当前代码生成、完整性字段为真且
对应脱敏汇总报告存在时，才能把结果写成合格基线。

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
scripts/
  env-file.mjs             run-with-env 和后台启动器共用的简单 env 解析规则
  run-with-env.mjs         从仓库外安全读取 env 文件后，不经 shell 运行参数数组
  detached-calibration-worker.mjs
                           等 PID 元数据写盘后，在同一进程载入标定入口
  start-detached-calibration.mjs
                           脱离 SSH 启动长期标定，日志和启动记录只写服务器私有目录
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
