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
│  src/llm.ts  用显式可控 HTTP 客户端调 OpenAI 兼容接口            │
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

# 参照 .env.example，在被 Git 整体忽略的 Fermata/private/ 中创建 fermata.env。
# USTC 服务器约定使用下面这个位置；不要把真实密钥文件放进跟踪文件。
node scripts/run-with-env.mjs /home/ubuntu/codex-urmotiv/Fermata/private/fermata.env npm run dev
# 上一行是 tsx watch 模式；或者单次启动：
node scripts/run-with-env.mjs /home/ubuntu/codex-urmotiv/Fermata/private/fermata.env npm start
# 或者
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

启动会先校验环境变量和 `config/models.yaml`；任何必填项缺失、格式不对，或者
默认模型档位缺少对应服务商的密钥，都会在启动时直接报错退出，不会带着残缺配置
跑起来。

模型配置中的 `thinking` 只决定是否把响应里的推理过程保留给下游；可选的
`thinkingRequest` 才会为当前 Aether `deepseek-v4-flash` 显式开启或关闭
深度思考。`enabled` 必须同时配置 `reasoningEffort: low`；`disabled` 不允许带
推理强度，未配置 `thinkingRequest` 时两个请求字段都不发送。当
`thinkingRequest: enabled` 时仍保留 `temperature` 配置以维持档位形状，但当前
服务端会忽略这个字段。

Fermata 本身不解析 `.env` 文件，只读取进程已经收到的环境变量。上面的
`run-with-env.mjs` 只接受 `Fermata/private/` 内的绝对路径，并沿已经打开的目录描述符
读取文件；路径中的符号链接、权限过宽的目录、非普通文件、读取中变化、超限内容或非法
UTF-8 都会失败关闭。它只向子进程传递明确登记的 Fermata、实验、基本运行时和代理变量，
不会让 shell 解释密钥中的特殊字符，也不会在出错时打印密钥内容。env 文件里的 Fermata
和实验变量明确覆盖父进程中的同名值；代理、`PATH` 和临时目录只从父进程继承，不能写进
env 文件。未知键、重复键、危险 Node/OpenSSL 设置或关闭 TLS 校验的设置都会在启动前被
拒绝。需要改变一次实验参数时，应使用内容已登记的专用私有 env 文件，不能依赖命令前的
同名临时变量覆盖它。
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
# 下列命令都通过安全脚本读取 Fermata/private/ 中的专用环境文件。
# 并发数、数据子目录等实验参数也要写入对应文件；文件值优先于父环境。
FERMATA_ENV_FILE=/home/ubuntu/codex-urmotiv/Fermata/private/fermata-experiment.env

# 1. 取数据集：评估集放默认 cf/ 子目录
# 当前 env 文件登记 SAMPLE_SIZE_PER_BUCKET=2，且不登记 DATA_SUBDIR。
node scripts/run-with-env.mjs "$FERMATA_ENV_FILE" npm run experiment:fetch-hf-dataset
# 标定集（带题解，供思维/代码难度实验）放 levels/ 子目录
# 运行前改用另一份已登记 DATA_SUBDIR=levels、SAMPLE_SIZE_PER_BUCKET=1 的私有 env 文件。
node scripts/run-with-env.mjs "$FERMATA_ENV_FILE" npm run experiment:fetch-hf-dataset

# 2. 选一批锚点题（已有官方难度、供模型对照的参照题），覆盖 config/anchors/difficulty.json
# 当前 env 文件登记 DATA_SUBDIR=levels、ANCHOR_COUNT=8。
node scripts/run-with-env.mjs "$FERMATA_ENV_FILE" npm run experiment:calibrate-anchors

# 3. CF 难度评测：输出平均绝对误差（预测与实际平均相差多少，报告中记作 MAE）、
# ±200 命中率和分档统计；脚本会排除参照题，避免提前见过答案影响结果。
# 当前 env 文件登记 EVAL_CONCURRENCY=6，并且必须登记 EVAL_CODE_VERSION，值为本次
# 实验代码对应的完整 40 位小写 Git 提交 SHA。脚本不会自行调用 Git，也不接受分支名或缩写。
node scripts/run-with-env.mjs "$FERMATA_ENV_FILE" npm run experiment:eval-difficulty -- --label=calibrated

# 4. 思维/代码难度标定：检验 rating 越高等级是否单调上升。
# 首次运行不加 --resume。
# 当前 env 文件登记 EVAL_CONCURRENCY=2。
node scripts/run-with-env.mjs "$FERMATA_ENV_FILE" npm run experiment:calibrate-levels -- --label=v1
# 中断后保持原参数不变，并用相同 label 加 --resume，只补跑没有完成的题。
node scripts/run-with-env.mjs "$FERMATA_ENV_FILE" npm run experiment:calibrate-levels -- --label=v1 --resume

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
FERMATA_ENV_FILE=/home/ubuntu/codex-urmotiv/Fermata/private/fermata.env
FERMATA_CALIBRATION_RUN_DIR=/home/ubuntu/codex-urmotiv/Fermata/private/fermata-calibration-runs

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

```

这个后台入口只支持 Linux 服务器。`--environment-file` 和 `--private-dir` 都必须是服务器
绝对路径，并且都必须位于被 Git 忽略的 `Fermata/private/` 内。私有根和中间目录必须属于
启动标定的当前用户且为 `0700`；env 文件不能是符号链接，必须属于当前用户，而且不能给
同组用户或其他用户任何权限，通常应使用 `0600`。后台
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
或模型服务地址。`ready` 会在含 PID 的元数据同步落盘后、发送 `START` 前写入，并保持为
最终启动状态；它表示启动门可能已经送达，不代表实验完成。此后如果启动器报告授权结果
不确定，不得重复启动，也不得结束该 PID，应先按登记的完整进程信息和私有日志核对。只有
授权前失败才会尝试清理子进程；`cleanup-unconfirmed` 表示清理结果无法确认，同样必须先
核对 PID。命令打印的“已脱离”只表示后台进程已经创建，最终结果仍以日志和标定报告为准。

这个入口固定运行 `calibrate-levels`，启动器自身使用参数数组和 `shell: false` 创建
后台进程，不把用户输入拼成 shell 命令，也不接受任意命令。除两个路径参数外，只允许
标定本身支持的 `--label` 和 `--resume`；未知、重复、冲突或格式
不安全的参数会在创建进程前被拒绝。并发、等待时间和重试次数仍通过受原标定脚本范围
检查的环境变量设置。

这里的“电脑重启”只指发起 SSH 的本地电脑。Fermata 所在服务器重启、进程被系统
终止或服务器网络中断，仍会终止当前模型请求。确认旧进程已停止后，保持数据、代码、
模型和运行参数不变，用同一 `--label` 加 `--resume` 继续；已经写入检查点的阶段不会
重跑。

思维和代码难度标定中的深度推理可能明显超过 90 秒。模型开始输出后，每收到一个通过
格式检查的非空白 content/reasoning 事件都会重新计算等待时间；心跳、用量和只含角色的事件
不会续时。默认连续 10 分钟没有新有效内容才停止。等待第一个有效事件默认最多 30 分钟，在它之前
（包括 429 重试等待）另有 4 小时的最终保护；首个有效输出到达后会清除这道保护，它不是持续输出
请求的绝对总时限。实验可分别用 `LEVELS_LLM_OUTPUT_IDLE_MS`、
`LEVELS_LLM_FIRST_OUTPUT_MS` 和 `LEVELS_LLM_MAX_DURATION_MS` 覆盖这三项。它们只接受整数，
安全下限依次是 600000、1800000 和 14400000 毫秒，上限都是 86400000 毫秒；最终保护配置值不能
小于另外两项等待配置值。旧的 `LEVELS_LLM_TIMEOUT_MS` 已不再支持，设置后会明确报错。
`LEVELS_LLM_MAX_ATTEMPTS` 调整最多尝试次数，但只有模型服务明确返回请求过多时才会再次尝试。
`EVAL_CONCURRENCY` 决定同时处理几道题，只接受 1 到 32 的整数。模型响应正文按 UTF-8 原始字节
计算，固定最多读取 4 MiB（约 4 MB）；超过后立即停止读取，并且错误和日志都不会包含响应正文。

正式服务已有的 `settings.json` 会保留上次保存的 `experimentVersion`，不会因为替换
`models.yaml` 自动改变。部署当前版本后，应在没有在途任务时，通过 Urmotiv 的 Fermata 设置页
或管理接口把 `experimentVersion` 明确更新为
`experiment-2026-08-difficulty-rubric-restored-v1`，再恢复领取任务；这样提交的审核结果才能准确说明使用了
哪一版请求规则和难度量尺。当前默认已恢复到显式关闭深度思考和 2048 输出上限；这只是撤回未通过
协议探针的 Candidate B，不表示 Candidate A 的难度准确性已经通过标定门槛。

Candidate B 的协议验证使用
`npm run experiment:probe-difficulty-thinking`。这个入口只依次检查一个人工合成的短题和三个与
83 题清单不重叠的公开高难题；每题最多向模型服务发送一次请求，任何第二次修复请求都会在进入
网络前被拒绝。它要求模型明确报告正常结束，并继续读取到 HTTP 响应真正结束；四题任一失败就停止
后续请求，不能据此启动正式实验。探针把付费前状态和每题终态写入 Git 忽略区的 `0600` 检查点，
不保存题面、题解、难度预测或模型原文。运行时还会核对当前 Git 提交、探针源文件、已登记公开材料
和当前模型服务身份的安全指纹；其中“安全指纹”是配置内容的 SHA-256 摘要，用于确认仍是同一份
配置，而不把服务地址或密钥写入报告。

2048 输出上限的第一轮探针在第一道公开高难题上明确得到
`LLM_OUTPUT_LENGTH_LIMIT`，所以完整性为假，也没有启动 83 题实验。按预先登记的唯一升级条件，
第二轮只把上限改为 4096，但同一道公开题仍得到相同失败码；因此没有继续提高上限，Candidate B 已
停止。两份不完整报告都已保留，后续候选不得把它们改写成成功结果。

思维/代码标定必须先在 `experiments/data/levels/manifest.private.json` 登记私有数据集清单。
清单逐项绑定安全编号、文件名和文件原始字节的 SHA-256 校验值；目录里漏文件、多文件、改后缀、
出现符号链接或文件内容变化都会在任何付费模型请求前整体失败。标定集至少 60 题，每题 JSON 都要有
人工确认的思维难度和代码难度（1 到 5 级）、非空题面和题解，并且低、中、高三个 rating 段都要有
覆盖。损坏 JSON、重复题号、缺人工标准或缺任一分段同样不会被静默跳过。

当前检查点格式是第 4 版。每个思维或代码付费阶段开始前，脚本先把该安全编号和阶段写入
`activeStages`，原子保存成功后才调用模型；阶段成功或明确失败时，再把结果或固定失败码与移除
`activeStages` 放在同一次检查点写入中。进程异常退出留下的 active 项在续跑时会转成永久的
`STALE_IN_FLIGHT` 证据。第 3 版及更早检查点没有这套在途证据、预登记清单和人工标准绑定，全部
明确拒绝续跑，不会自动转换成看似干净的第 4 版。

当前可续跑进度仍保存在
`experiments/results/raw/levels-<标签>-checkpoint.json`；同标签 `--resume` 只读取这一份，不扫描或
拼接其它历史快照。第 4 版检查点同时保存实验链 UUID。任何模型失败、HTTP 499、取消、等待超时、
流中断、历史跳过或陈旧在途都会永久留在同一实验链的失败统计中：即使续跑后来补齐全部题目，
`complete` 和 `eligible` 仍为假。出现首个失败后，脚本只等待已经发出的模型请求自然结束并保存结果，
不再启动新的付费阶段；再次运行这条失败链也不会继续付费。只有最初以全新标签从零启动、且整个同标签
实验链没有留下任何失败证据的链才可能合格；这样的干净链在安全中断后仍可用同标签 `--resume` 继续。

跨标签 `--resume-from` 已明确停用：从同一旧检查点派生多个标签会形成分支，使某个分支的失败证据
可能被另一个分支绕开。需要保留修改前、修改后两份实验时，修改后的实验必须使用全新标签从零运行；
只有当前标签自己的 `--resume` 可以续跑。相同标签仍只允许一个进程持锁；异常留下锁文件时，先确认
服务器上没有对应标定进程，再人工处理。

报告把“当前阶段是否都跑完”的 `operationalComplete`、“实验链是否无失败证据”的
`integrityClean`、准确性是否达标的 `accuracyPassed` 和最终可用性 `eligible` 分开记录。思维与代码
分别计算完全一致率、相差不超过 1 级的比例和平均绝对误差；两类都必须达到完全一致至少 60%、
相差不超过 1 级至少 90%、平均绝对误差不超过 0.6，并满足至少 60 题，`accuracyPassed` 才为真。

每次执行使用新的执行 UUID，分别写出
`levels-<标签>-<执行UUID>-report.md`、`levels-<标签>-<执行UUID>-summary.json` 和最后落盘的
`levels-<标签>-<执行UUID>-completion.json`。完成文件绑定报告与汇总各自的 SHA-256；同标签续跑不会
覆盖旧报告，写到一半的文件也不会被误认成成对完成的证据。检查点、快照、报告和完成文件都通过
随机临时文件原子替换。日志与公开汇总只记录安全编号、固定错误码、阶段、等级、运行参数和汇总数字，
不记录私有文件名、服务商错误原文、题面、题解或模型原始输出。服务地址仍只显示不含密钥的短校验值。

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
都不能作为当前代码的合格基线。修改前的完整方案与候选方案必须使用各自唯一标签，保留
两份报告；任何失败、取消、缺失或跳过都会使该次报告不完整。

| 流水线 | 状态 | 说明 |
| --- | --- | --- |
| CF 难度（difficulty.ts） | **Candidate A 完整但未达标；Candidate B 已在探针阶段淘汰** | 修改前 public83 v4 的 83/83 完整报告为 MAE 302.4、±200 命中率 56.6%；加入 800–3500 完整量尺的 Candidate A 独立 83/83 报告为 MAE 289.2、命中率 55.4%。MAE 改善 13.3，但命中率下降 1.2 个百分点，低、中档退化且高档 MAE 仍为 387.8；没有达到 MAE ≤ 200、命中率 ≥ 75% 的门槛。Candidate B 在 2048、4096 两档都无法让同一道公开高难题完成输出，未运行 83 题；默认配置已恢复 Candidate A 的非思考请求。`config/anchors/difficulty.json` 仍只有 2 条手工种子且标记为 `provisional: true`。 |
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
  private-runtime.mjs      从 Fermata/private/ 的目录描述符安全读取或创建私有运行文件
  run-with-env.mjs         从 Git 忽略的私有目录安全读取 env 文件，不经 shell 运行参数数组
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
