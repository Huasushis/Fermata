# Fermata

USTC 算法竞赛协会的独立 AI 审题服务：用机器人令牌轮询 Urmotiv 题库里的待审
题目，使用模型审题并提交结构化审核意见，并对 Urmotiv 的
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
│    轮询 claim → 审题 → JSON Schema 格式化与校验                    │
│      → 输出难度、通过/修改/拒绝、知识点与具体意见                    │
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
跑起来。首次创建 `settings.json` 时 `enabled` 固定为 `false`，不会因为 YAML 里
存在默认档位就自动领取题目。已有设置不会被新部署自动改写；只有操作员明确保存
`enabled=true`，且其中的 `experimentVersion` 与本次 `models.yaml` 精确一致、所选
档位仍然存在且模型凭据齐全时，worker 才会调用 claim。旧版本原样保留等待人工核对，
缺字段或损坏文件则拒绝启动。运行不再依赖旧实验的“生产资格证书”；准确性未标定，
意见默认供人工参考，是否参与状态汇总由 Urmotiv 的审核规则决定。

模型配置中的 `thinking` 只决定是否保留响应里的推理过程；正式 Aether DeepSeek V4
请求必须同时使用 `thinkingRequest: enabled` 和 `reasoningEffort: max`。配置层会在网络请求前拒绝
缺字段、关闭思考或非 `max` 的 V4 槽位。正式服务使用所选档位的 `reviewFlow.adjudicator`
模型：第一轮深度思考审题，第二轮使用完整 JSON Schema 转换格式（必要时仅修复一次格式）。
两轮都复用现有流式传输，不设置固定总生成时限；不同题目按 `maximumConcurrentTasks` 并行。
模型地址与密钥来自本项目私有环境文件的 `AETHER_BASE_URL`/`AETHER_API_KEY`，该变量名是
历史命名，与 OMP 的模型配置无关。生产使用 `deepseek-v4-flash`，不使用 pro。
难度和是否通过分别判断，不能按难度直接通过或否决；缺少查重资料仍能审题，但不声称已查重。
旧 11 角色和四语义请求工作流仅保留作离线实验，不是正式服务的请求路径。

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

续租和完成请求由 worker 为每个逻辑操作生成一个 UUID 请求标识。HTTP 客户端只对
没有收到响应、429 限流和 5xx 服务端故障做有界重试，并在这一条交付链中逐字复用
同一请求体和标识；401/403/404/409、其它确定的 4xx 和响应契约错误不会自动重试。
续租的暂时故障可以在租约安全预算内跨短间隔继续复用原标识，成功后的下一轮正常
续租才生成新标识。完成交付的结果如果仍不确定，当前任务路径不会换一个标识重复
提交。请求标识和请求体都不写入日志。

## 准确性实验与历史记录

正式部署不需要先运行准确性实验。实验命令、历史记录和研究约束见[准确性实验文档](docs/calibration.md)；它们不能代替当前服务的运行验收。

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
| CF 难度（旧 difficulty.ts） | **Candidate C 完整但未达标；旧 provider-v1 探针已冻结** | 旧 83/83 结果只作历史证据；不得据此声明当前四调用准确。 |
| 思维/代码难度（旧流水线） | **旧实验均不可作基线** | 旧结果不完整或缺分层，保持原字节只读。 |
| 查重判断（旧 verdict.ts） | **旧设计不可作准确性基线** | 不能替代独立 human truth 的 verdict 轴。 |
| 四语义请求 reviewFlow（离线实验） | **准确性未实跑，不是正式服务路径** | 旧实验终态仍为 0 completed / 20 failed / 72 pending / 4 orphaned，accuracy=`INCOMPLETE`。 |
| 正式两轮评分器 | **接口与格式验证；准确性尚未标定** | 明确启用后通过机器人 API 领取任务；独立判断难度和通过/修改/拒绝，不以实验资格阻止运行。 |


旧离线实验的付费诊断必须由仓库 owner 直接使用绝对 Node 路径调用
`scripts/development-diagnostic-bootstrap.mjs`。先用 `--print-contract --state-dir <绝对状态目录>`
取得只含摘要的启动契约，再以同一入口和 `--approve-contract <摘要>` 明确批准；之后才可传入
私有 env 文件和诊断参数。bootstrap 会在读取 env、加载仓库 helper、tsx 或诊断 CLI 之前，从已验证
descriptor 把批准的完整生产源码、入口、配置、已安装递归运行时依赖及二进制复制到 owner-only、
不可复用的 content-addressed staging 闭包；动态 import、loader、tsconfig、cwd 与 child source
随后全部来自该闭包，结束后按 identity 安全清理。仓库 owner 直接调用该 bootstrap 是信任根；边界
防御未确认的依赖漂移、并发替换和非 owner/组/其他用户可写路径，不声称防御 owner 恶意自替换
bootstrap。`npm run diagnostic:development` 只是便捷入口，不是正式付费授权边界；正式运行不得
从 npm script 开始。
这张表应该随每一次真正跑过评测脚本之后更新。只有当前代码生成、对应脱敏汇总与完成证据存在，
并且报告明确 `eligible=true` 时，才能把结果写成合格候选；仅有完整性为真不代表准确性达标。

## 已对齐的跨仓库契约

- 机器人任务已经携带严格的 Anklang v2 条目来源、插件编号、可见级别、有效期与内容哈希；
  Fermata 不再兼容猜测形状，也不会把未认证建议升级为确定性重复题证据。
- `reviewInputSchema` 已包含 `publicComment`；Fermata 镜像实际 Urmotiv 契约并在提交前再次严格校验。
- 机器人任务已经携带版本化的活动标签目录。每题可选择多个目录内标签，`tags` 角色只能返回当前
  活动编号；目录外、停用或重复编号不能提交。

## 项目结构

```
config/
  models.yaml              模型档位、深度思考与首输出/停顿超时配置
  anchors/difficulty.json  CF 难度评估的参照题（当前为 7 条 Candidate C 临时数据，见"当前校准状态"）
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
  scorer.ts                正式两轮评分：审题、JSON Schema 格式化、目录校验
  production-eligibility.ts
                           旧离线实验资格逻辑；正式服务不使用
  review-flow/
    task-source.ts         严格绑定 Urmotiv 任务、Anklang 来源和标签目录
    four-call.ts           A/B/C/D DAG、统一 schema、预算与内容绑定 receipt
    four-call-runtime.ts   共享全局 scheduler 的生产 transport 适配
    llm-roles.ts           旧 11 角色历史兼容适配
    orchestrator.ts        旧证据流冻结、失败收束与一次性提交载荷
    schemas.ts / views.ts  旧 11 角色输入、输出与最小可见视图
  reviewer.ts              主循环：轮询、并发、续租、优雅停机
  server.ts                管理端口
  index.ts                 入口
  pipelines/
    difficulty.ts / thinking.ts / coding.ts / verdict.ts
experiments/               离线调优脚本，见 docs/calibration.md
test/                      vitest，覆盖签名算法、HTML 解析、数值映射、
                           settings 乐观锁、verdict 阈值、client 错误分类等
```
