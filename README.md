# Fermata

USTC 算法竞赛协会的独立 AI 审题服务：用机器人令牌轮询 Urmotiv 题库里的待审
题目，跑一套有冻结证据边界的多角色 LLM 审题流程，提交结构化审核意见，并对 Urmotiv 的
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
│    轮询 claim → 严格完整任务快照 → 盲解冻结 → 题解/技术核验          │
│      → 难度、命题品味、ICPC 适配、原创性、固定标签并行证据            │
│      → critic + adversary → adjudicator                             │
│      → 11 角色 receipt 全部完整且准确性指纹匹配                      │
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
档位仍然存在，并且服务端生产资格证据完整通过时，worker 才会调用 claim。旧版本或
缺字段的设置一律关闭失败：旧版本原样保留等待人工核对，缺字段或损坏文件则拒绝启动。
`enabled` 和版本一致只是必要条件，不是生产资格证书。

模型配置中的 `thinking` 只决定是否保留响应里的推理过程；正式 Aether DeepSeek V4
请求必须同时使用 `thinkingRequest: enabled` 和 `reasoningEffort: max`。配置层会在网络请求前拒绝
缺字段、关闭思考或非 `max` 的 V4 槽位。新的四语义请求审题流按 A/B/C/D 执行：A 盲解与 B 独立
难度并行，A 完成后运行 C 综合核验，B 与 C 都完成后才运行 D 独立反证和硬规则裁决；典型语义请求
数为 4，关键路径为 3。B 只对冻结 Codeforces 参考难度，D 的通过/否决只对独立人工真值，两个轴
不能互相推出。旧 11 角色实现仅保留作历史兼容和离线对照，不是新实验的请求拓扑。

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

## 实验怎么跑

`experiments/` 下是离线调优工具，不是线上服务的一部分，需要模型 API 密钥。
数据集有两种来源：`fetch-cf-dataset` 直连 Codeforces API（服务器上题面网页可能被
Cloudflare 拦截）；`fetch-hf-dataset` 从公开数据集 open-r1/codeforces（CC-BY-4.0）
经镜像抽样，带官方 rating 和题解，更稳，推荐。评测脚本支持 `EVAL_CONCURRENCY`
控制并发（默认 6/4），大幅缩短总时长。

`fetch-cf-dataset` 现在按失败关闭处理：最近比赛范围为空、任一预定 rating 档候选不足、
样本数参数非法或任一题面抓取失败都会整批非零退出；所有题面都成功读入内存前不会开始写输出文件，
不会再把空档或抓取失败记成“跳过后成功”。

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
# 实验代码对应的完整 40 位小写 Git 提交 SHA；不接受分支名或缩写。脚本会自行核对
# 真实 HEAD、Git 可见的干净工作树，以及 runner 与登记依赖的实际字节。
node scripts/run-with-env.mjs "$FERMATA_ENV_FILE" npm run experiment:eval-difficulty -- --label=calibrated

# a/b/c/d/e 都已经实际运行并永久占用，禁止删除、重跑或复用 completion。
# 当前源码登记的全新 f 标签尚未运行，也尚未完成提交后的代码绑定和独立复审。
# 禁止执行下面的探针入口；这里只保留命令名称供以后经明确批准的操作员识别。
# 不要执行：npm run experiment:probe-difficulty-connectivity

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

### 正式四语义请求审题流的准确性实验

当前代码已冻结 A/B/C/D 四语义 DAG、统一机器 JSON Schema、内容绑定阶段 receipt 和请求级全局
公平调度，但**尚未产生新的真实准确性报告**，生产资格仍恒关闭。任何新的付费实验都必须先取得用户
明确同意；本轮代码验收未读取私有题面、未发送模型请求、未启动新 eval。现有
`experiment:eval-review-flow` 的 11 角色 bridge、registry 和旧 checkpoint 仍作为只读历史证据
保留，不能把它的请求数量或结果冒充四调用基线，也不能取消、覆写或复用旧 checkpoint 身份。

准确性入口只消费已经人工整理好的严格数据集，不生成题目、不生成 gold，也不会直接读取 Urmotiv、
历史 XML 或题库目录。导入人员必须先在隔离步骤中把允许使用的材料整理成完整
`robotReviewTaskSchema` 快照。历史品味样本继续使用避免当前语料自匹配的排除策略。

manifest、固定标签目录、逐题 content 和逐题 gold 都必须放在 `--dataset-private-root` 明确指定的
Git 忽略私有根内；当前桥接输出可以留在 `Urmotiv/private/`，只有 registry、检查点和报告固定写入
`Fermata/private/`。私有根及每层目录必须是当前用户所有的 `0700` 真目录；文件必须是当前用户所有、硬链接数为
1 的 `0600` 普通文件，不能是符号链接。manifest 只可用同目录文件名引用材料。所有 `sha256` 都是
磁盘文件**原始字节**的 SHA-256，不是解析后 JSON 的摘要。一个 manifest 必须固定非空
`development`；`holdout` 可以非空并登记冻结标签对，也可以显式为空且令 `holdoutRegistration=null`，
但两分区必须互不重叠。每题必须有稳定、不透露题号的 `subjectId` 和来源谱系摘要；即使后来
改写 content 字节，同一主体也不能从 development 移入 holdout。两边还会按安全编号、来源谱系、
content 与原始 Anklang 响应摘要检查交叉污染。固定标签目录单独保存为：

```jsonc
{
  "schemaVersion": 1,
  "version": 1,
  "tags": [
    {
      "id": "固定标签编号",
      "name": "标签名",
      "categoryId": "固定大类编号",
      "categoryName": "大类名",
      "description": "",
      "aliases": [],
      "active": true
    }
  ]
}
```

每个 content 文件必须是完整且无额外字段的 `robotReviewTaskSchema` 文档；其中 `tagCatalog` 必须与
上述固定目录逐字段一致。manifest v4 的两个分区都**不得**保存 Gold 文件名、逐题 Gold 摘要、
原始审核行摘要、封存 Gold 证据摘要、verdict、理由、难度、比赛使用情况或任何 Gold 聚合摘要，避免
这些低熵字段形成可枚举的哈希 oracle。只有 development 运行或一次性 reveal 真正打开
所选分区 Gold 后，程序才在内存中计算该分区摘要。12 个品味维度键为 `novelty`、
`idea_depth`、`naturalness`、`contestant_experience`、`icpc_fit`、
`implementation_balance`、`difficulty_role`、`fairness`、`judgeability`、
`statement_expression`、`solution_exposition`、`data_preparation`。

```jsonc
{
  "schemaVersion": 4,
  "datasetId": "dataset-16位小写十六进制",
  "anklangInputPolicy": "exclude_current_corpus_for_historical_outcome",
  "placeholderTagIds": ["整批统一的非 Gold 占位标签编号"],
  "tagCatalog": {
    "fileName": "固定标签目录.private.json",
    "sha256": "64位小写十六进制",
    "version": 1
  },
  "holdoutRegistration": {
    "baselineLabel": "预先冻结的 holdout 基线标签",
    "candidateLabel": "预先冻结的 holdout 候选标签",
    "thresholdPolicySha256": "预先冻结的阈值政策摘要"
  },
  "developmentRevealCommitmentSha256": "带独立随机 nonce 的 development reveal descriptor 原始字节摘要",
  "holdoutRevealCommitmentSha256": "带随机 nonce 的独立 reveal descriptor 原始字节摘要",
  "partitions": {
    "development": {
      "cases": [
        {
          "safeId": "case-0001",
          "subjectId": "subject-不透明稳定编号",
          "sourceLineageSha256": "来源谱系摘要",
          "originalAnklangResponseSha256": "原始 Anklang v2 响应字节摘要",
          "content": {
            "fileName": "开发集题目快照.private.json",
            "sha256": "64位小写十六进制"
          }
        }
      ]
    },
    "holdout": {
      "cases": [
        {
          "safeId": "case-0002",
          "subjectId": "subject-另一个不透明稳定编号",
          "sourceLineageSha256": "另一个来源谱系摘要",
          "originalAnklangResponseSha256": "另一个原始 Anklang v2 响应字节摘要",
          "content": {
            "fileName": "留出集题目快照.private.json",
            "sha256": "64位小写十六进制"
          }
        }
      ]
    }
  }
}
```

development 与 holdout 的 Gold 分别写入两个独立 `0700` 真目录中的 reveal descriptor；两条
commitment 使用不同 nonce，development run 绝不能获得 holdout descriptor 路径。descriptor 的绝对
路径不出现在 prediction manifest；development run 虽显式接收自己的 descriptor 路径，也必须先用
无 Gold 的身份视图完成全局用途登记，成功后才能首次打开。`commitmentNonce` 必须由密码学安全随机数
生成器新建 256 bit 随机值，
不能由题号、标签或 Gold 内容推导。manifest 只绑定整个 descriptor 的原始字节摘要，因此不能枚举
`approve/reject` 或 `confirmedDuplicate` 等低熵组合反查逐题标签。descriptor 的严格形状是：

```jsonc
{
  "schemaVersion": 1,
  "artifactKind": "review_flow_evaluation_reveal_descriptor",
  "protocolVersion": "review-flow-evaluation-reveal-v1",
  "datasetId": "必须与 prediction manifest 一致",
  "purpose": "development 或 holdout；两个 descriptor 各固定一个用途",
  "predictionBindingSha256": "不含 Gold 的 holdout 输入集合摘要",
  "commitmentNonce": "密码学安全生成的 64 位小写十六进制随机值",
  "cases": [
    {
      "safeId": "case-0002",
      "subjectId": "必须与 prediction manifest 一致",
      "sourceLineageSha256": "必须与 prediction manifest 一致",
      "contentSha256": "必须与 prediction manifest 一致",
      "upstreamEvidence": {
        "sealedEvidenceSha256": "上游封存证据摘要",
        "rowEvidenceSha256": "原始审核行证据摘要",
        "originalAnklangResponseSha256": "必须与 prediction manifest 一致",
        "bridgeEvidence": {
          "bridgeVersion": "urmotiv-review-flow-bridge-v5",
          "verificationAttestationSha256": "上游验证证明原始字节摘要",
          "bridgePlanSha256": "桥接计划原始字节摘要",
          "reviewGoldEvidenceSha256": "上游 evidence 原始字节摘要",
          "sourceBindingsSha256": "上游 source-bindings 原始字节摘要",
          "upstreamGoldSha256": "本题上游 Gold 原始字节摘要",
          "worksheetSha256": "审核工作表原始字节摘要",
          "inspectionSha256": "原始表格检查报告原始字节摘要",
          "layoutSha256": "人工布局确认原始字节摘要",
          "reviewInputSetSha256": "原始审核输入集合摘要",
          "sourceMappingSha256": "本题来源映射原始字节摘要",
          "anklangCaptureAttestationSha256": "整批采集证明原始字节摘要",
          "anklangCaptureCompletionSha256": "整批采集完成标记原始字节摘要",
          "anklangRequestSha256": "本题原始 v2 request 字节摘要",
          "anklangResponseSha256": "本题原始 HTTP response 字节摘要",
          "anklangCorpusEvidenceKind": "语料证据等级"
        }
      },
      "gold": {
        "fileName": "与 descriptor 同目录的留出集人工标准.private.json",
        "sha256": "Gold 文件原始字节摘要"
      }
    }
  ]
}
```

上面的 JSONC 只展示字段位置，尖括号式说明和中文摘要占位必须替换为真实、满足 schema 的值，不能
原样作为 manifest。Urmotiv `prepare-review-gold.py seal` 的输出只是上游证据，不能直接当作这里的
manifest；必须先验证 `REVIEW_GOLD_COMPLETE`、evidence、source-bindings 和逐题 Gold 的摘要，再由操作员
登记可核验的题面/题解来源投影及 XML 稀疏意见映射，生成本 schema 的 content、Gold、prediction manifest 与独立
reveal descriptor。这里的
`sealedEvidenceSha256` 绑定整批上游完成标记，因此同一封存批次的多题可以共享；逐题
`rowEvidenceSha256` 和 `bridgeEvidence` 只进入受随机 nonce 保护的 reveal/Gold 材料；它们及其中任何
摘要都不得出现在 prediction manifest 或 `sourceLineageSha256`。原始 Anklang 响应摘要、`subjectId` 与
`sourceLineageSha256` 仍各自唯一绑定。`sourceLineageSha256` 不得由带审核结论的 XML 行或其它标签材料
派生，不能凭空填写理由文字或伪造空查重候选。现有封存集若只有 development，必须使用空
`holdout.cases`、`holdoutRegistration: null` 与 `holdoutRevealCommitmentSha256: null`；不能为了满足
schema 伪造 holdout。只有非空 holdout 才能登记标签对。

转换器必须最后写出同目录固定文件 `REVIEW_FLOW_DATASET_COMPLETE`，loader 会在读取任何题目内容前验证它
绑定 manifest、标签目录、逐题来源谱系集合和精确分区计数；标记缺失、截断或摘要不符的 partial 目录一律
不能运行。它还必须绑定独立 reveal commitment，但仍不保存 reveal 文件名。标记的严格结构如下，
转换版本当前固定为 `urmotiv-review-flow-bridge-v5`：

```jsonc
{
  "schemaVersion": 5,
  "artifactKind": "review_flow_evaluation_dataset_bridge_completion",
  "bridgeVersion": "urmotiv-review-flow-bridge-v5",
  "datasetId": "必须与 manifest 一致",
  "manifestFileName": "manifest.private.json",
  "manifestSha256": "manifest 原始字节摘要",
  "generator": {
    "codeVersion": "生成数据集的 Fermata 40 位 clean Git HEAD",
    "runnerSha256": "experiments/prepare-review-flow-dataset.ts 原始字节摘要",
    "dependencyCodeSha256": "完整 reviewFlowEvaluationCodePaths 代码包摘要",
    "dependencyFileCount": 46
  },
  "historicalInputPreparationCompletionSha256": "必须等于准备器 REVIEW_FLOW_HISTORICAL_INPUTS_COMPLETE 标记原始字节摘要",
  "tagCatalogSha256": "必须与 manifest 一致",
  "placeholderTagIds": ["必须与 manifest 顺序逐项一致"],
  "sourceLineageSetSha256": "按 v4 契约计算并绑定全局 Anklang 输入策略的全部来源谱系集合摘要",
  "developmentPredictionBindingSha256": "无标签 development 输入集合摘要",
  "developmentRevealCommitmentSha256": "必须与 manifest 的 development commitment 一致",
  "holdoutPredictionBindingSha256": "非空 holdout 的无标签输入集合摘要；否则 null",
  "holdoutRevealCommitmentSha256": "必须与 manifest 的 opaque commitment 一致；否则 null",
  "caseCount": 32,
  "developmentCount": 32,
  "holdoutCount": 0
}
```

桥接时不能只拿一份声称 `complete` 的 Anklang 响应。bridge plan 必须逐题同时绑定实际发送的原始
v2 request 和 HTTP 原始 response，并另外绑定整批 capture attestation 与 marker-last completion。
request 必须是无额外字段的 v2 严格结构，`requestId` 整批唯一；`title/type/tagIds/basicStatement`
逐字段等于 task draft，`contentHash` 等于由 problem hash input 重算的 Urmotiv 摘要。response 必须是
HTTP 200、attempt 1 的严格 v2 `complete`，并原样回显 request 的 `contentHash`。转换器必须验证原始候选
与判断且把它们绑定进私有 capture lineage，但当前历史结果策略统一输出空 `reviewItems`，不得把这些赛后
查重候选注入 11 角色任务，也不得由实验入口重新调用 Anklang。

capture attestation 固定绑定 clean Anklang HEAD 和代码内置的 4 文件采集器身份：
`scripts/capture-review-flow-calibration.py`、`anklang/__init__.py`、
`anklang/review_flow_capture.py`、`anklang/contracts.py`；依赖清单不能由 attestation 自报或动态扩展。
attestation 还必须保存不含地址明文和密钥的 v2 endpoint/config 摘要、backend 声明、corpus 声明，
以及逐题 case/requestId/request 原始 SHA-256/response 原始 SHA-256/HTTP 200/attempt 1 和完整计数。
顶层 `captureFingerprint` 是去掉自身后规范 JSON 的摘要；completion 再绑定 attestation 原始字节摘要、
逐题 capture set 摘要和全部相等计数，并固定 `failureCount=0`、`complete=true`。两者都必须是规范化的
JSON 字节，任一缺失、非完整、计数不等或 Anklang 工作树不干净都会失败关闭。bridge 不只读取手写
attestation：它还会以固定 `/usr/bin/python3 -I -B -X pycache_prefix=/dev/null`、受限环境在同一 clean Anklang HEAD 上执行
`capture-review-flow-calibration.py verify-capture`，传入原始 capture workspace、manifest 和三个
`--verifier-*` 身份摘要；stdout 必须与 plan 绑定的 attestation 原始字节逐字一致，执行前后代码身份也
必须一致。

```jsonc
{
  "schemaVersion": 1,
  "artifactKind": "anklang_review_flow_capture_attestation",
  "protocolVersion": "anklang-review-flow-capture-v1",
  "captureStatus": "complete",
  "captureId": "capture-16位小写十六进制",
  "capturedAt": "UTC Z 时间",
  "capturer": {
    "repository": "Anklang",
    "codeVersion": "clean Anklang HEAD",
    "runnerPath": "scripts/capture-review-flow-calibration.py",
    "runnerSha256": "固定 runner 原始字节摘要",
    "dependencyCodeSha256": "固定 4 文件代码包摘要",
    "dependencyFileCount": 4
  },
  "configuration": {
    "apiVersion": "2",
    "endpointPath": "/api/v2/checks/similarity",
    "baseUrlSha256": "不含账号密码的服务地址摘要",
    "timeoutMs": 300000,
    "authentication": "bearer_redacted",
    "secretsExcluded": true
  },
  "backend": {
    "kind": "reverse_proxy",
    "configurationSha256": "去密钥 backend 配置声明摘要",
    "secretsExcluded": true
  },
  "corpus": {
    "evidenceKind": "remote_corpus_unverifiable",
    "serviceOriginSha256": "远端服务来源摘要",
    "declarationSha256": "去密钥远端语料声明摘要"
  },
  "cases": [{
    "caseId": "上游 caseId",
    "requestId": "唯一 UUID",
    "requestSha256": "原始 request 字节摘要",
    "responseSha256": "原始 response 字节摘要",
    "httpStatus": 200,
    "attempt": 1,
    "responseCompletionStatus": "complete"
  }],
  "counts": {
    "caseCount": 32,
    "requestCount": 32,
    "responseCount": 32,
    "http200Count": 32,
    "attemptCount": 32,
    "completeResponseCount": 32,
    "failureCount": 0
  },
  "captureFingerprint": "去掉本字段后的规范 JSON 摘要"
}
```

capture completion 使用相同 `captureId`，并严格含
`attestationSha256/captureSetSha256`、上述七个计数字段和 `complete: true`。当前 bridge v5 硬限制
`reverse_proxy + remote_corpus_unverifiable`；`local_engine`、`reproducible_snapshot` 及二者伪装组合都
在 schema 边界拒绝，不能靠手写 corpus 摘要制造“已复现”成功路径。远端语料不可复核这一事实会进入隐藏
Gold bridge evidence 与来源谱系，但原始响应只用于 capture 完整性验证，不注入历史结果任务。

正式转换使用 `experiment:prepare-review-flow-dataset`。它不是“相信一份已经写好的 JSON”：每次执行都先
要求 `--fermata-code-version` 精确等于当前干净 Fermata HEAD，并用可信 Git 快照核对固定 runner
`experiments/prepare-review-flow-dataset.ts` 与完整 `reviewFlowEvaluationCodePaths`；代码版本、runner
摘要、依赖代码全集摘要和文件数会写入 completion，并进入每题无标签 `sourceLineageSha256`。全部 Gold、
reveal、content 和 manifest 写完后、完成标记发布前会再次核对同一身份；期间代码、HEAD 或工作树发生
任何变化都只留下没有完成标记的 partial 目录。当前未提交或含任意未跟踪文件的 Fermata 工作树不能正式
转换。

转换器同时会以固定 `/usr/bin/python3 -I -B -X pycache_prefix=/dev/null` 调用干净 Urmotiv HEAD 中的
`scripts/migrate-hist/prepare-review-gold.py verify-sealed`，并把安全 stdout 与 bridge plan 预先绑定的
`urmotiv_review_gold_verification_attestation` 原始字节逐字比较。attestation 固定绑定 verifier 的 40 位
Git HEAD、runner 摘要和 `prepare-review-gold.py`/`parse-metadata.py` 两文件代码全集；运行前后都会用隔离
Git 配置和复制索引重新核对。缺少 action、非零退出、代码脏、摘要不符、stdout 多一个字节或 attestation
缺失时都不会创建完成标记。

attestation v1 必须报告两类不同摘要，不能混用：普通 `*Sha256` 对原始文件字节计算；
`sourceConfirmationCanonicalSha256`、`materializationReportCanonicalSha256` 和
`materializationSourceSetSha256` 按 Urmotiv 的 Python compact JSON 字段顺序计算。它还必须绑定全部 1–2 份
原始 XLSX/XML 的 `inputId`/格式/原始摘要、`inputSetSha256`、inspection、layout、worksheet、
`REVIEW_WORKSHEET_COMPLETE`、materialization、plan、tuning history、sealed evidence，以及每题的
case/subject/purpose/scope/source/path/source 摘要/row evidence/Gold 摘要和全部计数。严格结构以
`reviewFlowEvaluationUpstreamAttestationSchema` 为准。

bridge plan v5 同目录只放 basename 引用，并逐题绑定五份既有 `0600` 文件：不含 review item 的
RobotReviewTask draft、`urmotiv_problem_content_hash_input`、原始 Anklang v2 request、原始 HTTP 200
complete response 和 `review_flow_evaluation_source_mapping`；顶层另绑定 capture attestation 与
capture completion，并固定
`anklangInputPolicy: "exclude_current_corpus_for_historical_outcome"`。顶层还必须唯一登记一份非空、
无重复的 `placeholderTagIds`，其顺序属于数据身份；每题 source mapping、task draft、problem hash input
和原始 Anklang request 的 `tagIds` 都必须与它顺序逐项相等。该列表同时绑定 prediction manifest v4、
completion、prediction binding、来源谱系集合、loader bundle 和 adapter 配置身份；loader 即使在不打开
Gold 的 identity/prediction 模式也会确认列表全部存在于固定标签目录，并检查每份 content。该策略要求整批上游 case 都是
`verdict_and_taste`；混入任何 `originality_only` 会在发布前失败关闭。problem hash input 保存 Urmotiv 计算 contentHash 所需、但 robot
task 不可见的难度、样例 UUID、完整 judge config 和状态；转换器按 Urmotiv 的字段顺序重算 SHA-256，再
核对 task 可见字段。source mapping 只声明实际采用的投影方法、操作员确认事项和可回查到 XML 评论下标的
稀疏历史理由；它不接受任何 `independent_human`、标签或难度 Gold。投稿者自报难度不能进入独立难度真值。

source mapping 固定为 schema v2。`titleIdentityValueIndex` 选择 worksheet 的一个原始
`identityValues` 项；该字符串必须已经符合任务标题规范并与 task title 逐字相等，桥接器不会静默
trim。`sourceProjection.statement` 和 `.solution` 是 UTF-8 原始字节的左闭右开区间：题面必须从 byte 0
开始，题解必须结束于文件 EOF，两段非空、不重叠、能严格解码且逐字等于 task 的
`basicStatement/basicSolution`。方法只能是
`markdown_solution_heading_v1`、`last_horizontal_rule_v1`、`algorithm_heading_v1` 或
`operator_explicit_offsets_v1`；前三种方法的 gap 必须完整由空白和恰好一个对应标题/分隔线组成，不能
夹带正文，显式 offset 方法才允许任意 gap。所有方法都禁止省略源文件前缀或后缀。

题型 provenance 固定写 `problemTypeBasis: "operator_confirmed"`。历史任务契约要求非空当前标签，
但它不是标签准确性 Gold，因此必须写
`currentTagIdsBasis: "calibration_placeholder_not_gold"` 和与 bridge plan 顶层顺序逐项相等的
`placeholderTagIds`；这些编号必须存在于本次绑定且标签 id 无重复的固定标签目录。source mapping
不提供标签准确性 Gold。除 `basicStatement/basicSolution` 外，task 的其余 content 字段必须为空，samples
必须为空且 limits 必须为 null，避免把未经投影的内容带进受信输入。
当前 bridge v5 不接受 `originality_only`：上游 36 例中由操作员确认把 3 例
`originality_only` 与 1 例 `solution_missing` 排除，只把 32 例 `verdict_and_taste` 纳入私有桥接输入。
未来若要恢复原创性专用数据集，必须新增整批一致、带版本的 include 策略，不能与历史结果 scope 混用。

普通题历史理由映射 provenance 固定为
`historicalReviewReasonMapping: "operator_asserted_sparse_mapping_v1"`。输入使用
`observedHistoricalTasteReasonEvidence` 和 `observedHistoricalTechnicalReasonEvidence`；每项同时登记
`reviewCommentIndex` 与 `reason`。桥接器只接受索引存在且对应 XML worksheet 评论非空的 evidence，再从中
去重派生 Gold 的 taste/technical reason 数组。这个名称明确表示语义分类是操作员断言，不冒充自动 codebook；
人工仍必须逐项核对评论确实支持所选 reason，绝不能从最终通过/否决结论反推理由。两个 evidence 数组都允许
为空。逐题来源谱系使用
`review-flow-evaluation-source-lineage-v7`，绑定投影区间、方法、标题索引、题型来源、非 Gold 标签占位、
原始 capture 摘要、全局排除策略和 `reviewItemInjected:false`，但不绑定 Gold 理由字段。

```bash
npm run experiment:prepare-review-flow-dataset -- \
  --private-root=/absolute/project/private-root \
  --fermata-code-version=当前干净Fermata_HEAD的40位小写提交号 \
  --bridge-plan=/absolute/project/private-root/bridge-input/bridge-plan.private.json \
  --anklang-capture-workspace=/absolute/project/private-root/anklang-capture-workspace \
  --anklang-capture-manifest=/absolute/project/private-root/anklang-capture-workspace/capture-manifest.private.json \
  --upstream-gold=/absolute/project/private-root/review-gold-sealed \
  --materialized=/absolute/project/private-root/materialized \
  --worksheet=/absolute/project/private-root/review-worksheet/review-worksheet.private.json \
  --worksheet-completion=/absolute/project/private-root/review-worksheet/REVIEW_WORKSHEET_COMPLETE \
  --inspection=/absolute/project/private-root/review-input-inspection.private.json \
  --layout=/absolute/project/private-root/review-layout.private.json \
  --upstream-plan=/absolute/project/private-root/review-plan.private.json \
  --tuning-history=/absolute/project/private-root/tuning-history.private.json \
  --review-input=/absolute/project/private-root/review-list-older.xml \
  --review-input=/absolute/project/private-root/review-list-newer.xml \
  --out=/absolute/project/private-root/review-flow-prediction \
  --development-reveal-out=/absolute/project/private-root/review-flow-development-reveal \
  --holdout-reveal-out=/absolute/project/private-root/review-flow-holdout-reveal
```

输出三个末级目录必须都不存在；转换器只创建新目录，绝不续写或覆盖 partial。它先写两边 Gold 和 reveal
descriptor，再写标签目录、全部 content 和 manifest，重新核对精确目录清单后才最后写
`REVIEW_FLOW_DATASET_COMPLETE`。若没有 holdout，省略最后一个输出参数，bridge plan 的 registration 也必须
为 `null`。development 与 holdout descriptor 的 nonce 分别调用系统密码学随机源生成 32 字节；相同或长度
错误固定拒绝。

v5 桥接输入先由准备器从 36 例已封存上游生成 32 个私有桥接输入草案：

```bash
npm run experiment:prepare-review-flow-historical-inputs -- \
  --private-root=/absolute/project/private-root \
  --upstream-gold=/absolute/project/private-root/review-gold-sealed \
  --materialized=/absolute/project/private-root/materialized \
  --worksheet=/absolute/project/private-root/review-worksheet/review-worksheet.private.json \
  --worksheet-completion=/absolute/project/private-root/review-worksheet/REVIEW_WORKSHEET_COMPLETE \
  --inspection=/absolute/project/private-root/review-input-inspection.private.json \
  --layout=/absolute/project/private-root/review-layout.private.json \
  --upstream-plan=/absolute/project/private-root/review-plan.private.json \
  --tuning-history=/absolute/project/private-root/tuning-history.private.json \
  --review-input=/absolute/project/private-root/review-list-older.xml \
  --operator-confirmation=/absolute/project/private-root/operator-confirmation.private.json \
  --upstream-verification-attestation=/absolute/project/private-root/upstream-verification-attestation.private.json \
  --tag-catalog=/absolute/project/private-root/tag-catalog.private.json \
  --out=/absolute/project/private-root/review-flow-historical-inputs
```

准备器强制 32 例契约：operator 确认文件必须包含恰好 36 个上游 case（其中 32 个
`include_verdict_and_taste`、3 个 `exclude_originality_only`、1 个 `exclude_solution_missing`），
`caseId/safeId/requestId/request 字节摘要`全局唯一；逐项绑定操作员确认的 `reviewCommentIndex + reason`
稀疏评论映射，绝不关键词扫描；生成严格 Anklang v2 request（仅
`apiVersion/requestId/contentHash/problem{title,type,tagIds,basicStatement}`），不含
solutions/authors/accounts/testdata/review-opinions。任何缺失的确认项、非唯一 caseId 或虚假理由
都会以错误码拒绝，绝不合成意见。完成后目录含 `REVIEW_FLOW_HISTORICAL_INPUTS_COMPLETE` 完成标记、
`capture-manifest.private.json` 与 `bridge-plan-draft.private.json` 草案。

随后 Anklang 在 `--anklang-capture-workspace` 中执行真实 capture（外部操作，非本仓库），产生
attestation 与逐 case 原始响应；再定稿 v5 plan：

```bash
npm run experiment:finalise-review-flow-bridge-plan -- \
  --private-root=/absolute/project/private-root \
  --preparation-dir=/absolute/project/private-root/review-flow-historical-inputs \
  --anklang-capture-workspace=/absolute/project/private-root/anklang-capture-workspace \
  --anklang-capture-manifest=/absolute/project/private-root/anklang-capture-workspace/capture-manifest.private.json
```

定稿器只在这个条件（capture 完成标记 + attestation + 全部真实 200 响应的摘要与准备输出逐字节绑定）
成立时在准备目录写出正式 `bridge-plan.private.json`、`anklang-capture-attestation.private.json` 和
`anklang-capture-completion.private.json`；任一缺失、499、取消或跳过项都使整批保持 incomplete，
绝不修补 attestation。正式 plan 使用
`review-flow-evaluation-source-lineage-v7` 谱系，描述源投影、方法、标题索引、题型来源、非 Gold
标签占位、原始 capture 摘要和 `reviewItemInjected:false`；capture 前发布的草案带未解析绑定占位。

Gold schema 为未来独立标注保留两个互斥范围，但当前 bridge v5 的 32 题历史品味基线只允许
`verdict_and_taste`：历史 XML 的最终通过/否决只进入二分类 `historicalOutcome`。XML 中明确写出的审核理由
只是操作员绑定评论下标后的稀疏观察，只计算召回率；某个轴没写出来不等于负例。bridge v5 不从 source
mapping 接受或生成独立三态 verdict、穷尽品味、独立原创性、标签或难度 Gold。未来若要启用这些指标，必须
先设计独立、带版本和可核验 provenance 的标注 artifact，再升级 bridge；不能为了凑数复制历史二元结论、
投稿者自报难度或伪造 `independent_human`。

```jsonc
{
  "schemaVersion": 2,
  "safeId": "case-0001",
  "subjectId": "必须与 manifest 一致",
  "sourceLineageSha256": "必须与 manifest 一致",
  "contentSha256": "对应 content 原始字节的 64 位小写十六进制",
  "upstreamEvidence": {
    "schemaVersion": 1,
    "sealedEvidenceSha256": "必须与对应 reveal descriptor 一致",
    "rowEvidenceSha256": "必须与对应 reveal descriptor 一致",
    "sourceLineageSha256": "必须与 manifest 一致",
    "originalAnklangResponseSha256": "必须与 manifest 一致",
    "bridgeEvidence": {
      "bridgeVersion": "urmotiv-review-flow-bridge-v5",
      "verificationAttestationSha256": "只在揭盲侧绑定",
      "bridgePlanSha256": "只在揭盲侧绑定",
      "reviewGoldEvidenceSha256": "只在揭盲侧绑定",
      "sourceBindingsSha256": "只在揭盲侧绑定",
      "upstreamGoldSha256": "只在揭盲侧绑定",
      "worksheetSha256": "只在揭盲侧绑定",
      "inspectionSha256": "只在揭盲侧绑定",
      "layoutSha256": "只在揭盲侧绑定",
      "reviewInputSetSha256": "只在揭盲侧绑定",
      "sourceMappingSha256": "只在揭盲侧绑定",
      "anklangCaptureAttestationSha256": "只在揭盲侧绑定",
      "anklangCaptureCompletionSha256": "只在揭盲侧绑定",
      "anklangRequestSha256": "只在揭盲侧绑定",
      "anklangResponseSha256": "等于 manifest 的原始响应摘要",
      "anklangCorpusEvidenceKind": "remote_corpus_unverifiable"
    }
  },
  "evaluationScope": "verdict_and_taste",
  "historicalOutcome": "accepted",
  "contestUse": "used",
  "observedHistoricalTasteReasons": [
    { "dimension": "icpc_fit", "direction": "strength" }
  ],
  "observedHistoricalTechnicalReasons": ["judgeability_concern"]
}
```

上面展示的是 bridge v5 能生成的普通题 Gold；它不会出现 `independentVerdict`、`independentTaste`、
`independentOriginality`、`expectedTagIds` 或 `independentDifficulty`。稀疏技术理由只允许
`statement_solution_inconsistency`、`judgeability_concern`、`sample_mismatch`、
`constraint_insufficiency`、`official_solution_incorrect`、`complexity_unacceptable`、
`reference_implementation_incorrect`；它们同样只计算召回，不把缺席当负例，也不要求投稿附带标程。
普通题没有独立原创性标注时不会默认成“非原题”。下列 `originality_only` 是数据集 schema 为未来
独立、整批一致的原创性标注流程保留的最小结构；当前 bridge v5 没有 include 策略，不能生成或混入
这种 Gold。它不能携带 verdict、品味、比赛使用、标签或难度字段：

```jsonc
{
  "schemaVersion": 2,
  "safeId": "case-0003",
  "subjectId": "必须与 manifest 一致",
  "sourceLineageSha256": "必须与 manifest 一致",
  "contentSha256": "对应 content 原始字节的 64 位小写十六进制",
  "upstreamEvidence": {
    "schemaVersion": 1,
    "sealedEvidenceSha256": "必须与对应 reveal descriptor 一致",
    "rowEvidenceSha256": "必须与对应 reveal descriptor 一致",
    "sourceLineageSha256": "必须与 manifest 一致",
    "originalAnklangResponseSha256": "必须与 manifest 一致",
    "bridgeEvidence": {
      "bridgeVersion": "urmotiv-review-flow-bridge-v5",
      "verificationAttestationSha256": "只在揭盲侧绑定",
      "bridgePlanSha256": "只在揭盲侧绑定",
      "reviewGoldEvidenceSha256": "只在揭盲侧绑定",
      "sourceBindingsSha256": "只在揭盲侧绑定",
      "upstreamGoldSha256": "只在揭盲侧绑定",
      "worksheetSha256": "只在揭盲侧绑定",
      "inspectionSha256": "只在揭盲侧绑定",
      "layoutSha256": "只在揭盲侧绑定",
      "reviewInputSetSha256": "只在揭盲侧绑定",
      "sourceMappingSha256": "只在揭盲侧绑定",
      "anklangCaptureAttestationSha256": "只在揭盲侧绑定",
      "anklangCaptureCompletionSha256": "只在揭盲侧绑定",
      "anklangRequestSha256": "只在揭盲侧绑定",
      "anklangResponseSha256": "等于 manifest 的原始响应摘要",
      "anklangCorpusEvidenceKind": "remote_corpus_unverifiable"
    }
  },
  "evaluationScope": "originality_only",
  "originalityAnnotation": "confirmed_duplicate_evidence",
  "confirmedDuplicate": true
}
```

真实运行前，专用私有 env 文件必须自行登记 `EVAL_CODE_VERSION`（当前**已提交且工作树干净**的完整 40 位
小写 Git HEAD）和 `EVAL_CONCURRENCY`，以及实际被 11 个角色使用的 provider 的 `*_BASE_URL`、
`*_API_KEY`；每个 provider 的地址和密钥必须成对登记，未使用的 provider 可以不写。启动终端里遗留的
同名 provider/`EVAL_*` 变量不会补缺、参与或覆盖这份文件。这个专用 env **不得**含 Urmotiv 机器人/管理令牌、Fermata 管理令牌、设置路径或
Codeforces 凭据；入口不调用通用 `loadConfig`，这些值不会进入实验配置对象。必须使用 Node.js 24 或
更高版本，并经过 `scripts/run-with-env.mjs --review-flow-evaluation`。这个专用模式不接受任意命令，
也不经 `PATH` 启动 npm/tsx；它固定用当前 Node 先运行纯内置模块 bootstrap。bootstrap 在任何 npm 包或
评测 TypeScript 载入前，核对干净 HEAD、逐文件代码清单、Node 可执行文件，以及 tsx/esbuild/undici/zod
实际安装字节；随后只从 `Fermata/private/review-flow-runtime-snapshots/` 内的临时 0700 代码快照运行，
模块解析钩子拒绝任何落到该快照之外的非 `node:` 模块。子进程 stdout/stderr 不直接继承终端；启动器
只捕获至严格上限，接受唯一一行登记的完成消息并转换成不含 label、路径和模型内容的
`FERMATA_REVIEW_FLOW_RESULT` JSON 协议，详细报告仍从固定私有 registry 取得。Node/tsx 加载错误、额外
输出、stderr 或协议不符都只返回固定失败。结束后复核原始源码的初次 stat 身份、原始依赖和快照字节，
再按精确目录身份清理；因此读取后改写再恢复原字节也会失败关闭。报告绑定这些字节摘要，不把路径写入
报告。`run-with-env` 外层与 bootstrap 都捕获 `SIGINT`/`SIGTERM`/`SIGHUP`：child 尚未启动时直接关闭
启动闸门；启动后只向各自的直接 child 幂等转发第一次信号，不用 Abort 中断付费流，并继续等待 runner
关掉新请求、让在途响应读到真实 EOF、复核身份和清理 snapshot。runtime identity 会明确写入
`trusted_host_system_runtime_unbound`：该边界不声称能防御同一 UID
直接篡改进程内存或删改 bootstrap 自身；Node 可执行文件摘要也不覆盖系统动态库、TLS CA、DNS 和内核，
fresh 来源复核固定调用的系统 Git、curl、tar、npm 及其动态库也属于这个受信服务器宿主边界。
这些仍不由项目 manifest 单独证明。`SIGKILL` 无法捕获，若在清理前强杀 bootstrap，项目私有 snapshot 根中
可能留下只读临时目录，必须按目录身份人工核对后处理。但 ignored `node_modules` 修改、
普通并发编辑、父目录模块回退和“先载入后恢复”都会失败关闭。包装器标记只是启动约定，CLI 仍独立检查危险 Node 环境、未知变量和
bootstrap attestation。下面的变量值是格式占位，不是真实私有路径：

`config/review-flow-runtime.json` 不能从当前 `node_modules` 自报更新。它同时绑定
Node 官方发布归档的 SHA-256，以及 `tsx`、`esbuild`、Linux 平台 binary、`undici`、
`zod` 在 `package-lock.json` 中的 npm 官方归档地址和 sha512 完整性值；bootstrap
每次离线核对这些语义绑定。更新或独立复核时，先取得该 manifest 指定的官方 Node
归档，并把候选改动提交到待审分支，再用固定系统 Node 运行下面的工具。工具先逐字节
确认自身、manifest、`package.json` 和 lock 都来自当前 HEAD；工作树临时改写不能生成
可接受结果。它还会通过系统 TLS 从严格推导的 Node 官方地址重新取得
`SHASUMS256.txt`；本地归档只作为缓存，必须同时匹配 fresh 官方摘要和 manifest，
校验后的原始字节会复制到私有临时目录再解压，避免路径在校验后被替换。随后它在项目
`.cache/` 的 `0700` 临时目录中
执行全新的 `npm ci --ignore-scripts`，不会执行任何安装脚本；esbuild 的 launcher 只由
已经过完整性校验的平台 binary 按固定步骤映射。默认只比较，不修改 manifest；
`--proposal` 也只向 stdout 生成不含路径或密钥的候选 runtime JSON，仍须另一名审阅者
核对来源和 diff 后才能用 `apply_patch` 更新正式文件。

```bash
/usr/bin/node scripts/verify-review-flow-runtime-manifest.mjs \
  --node-archive=/absolute/path/under/codex-urmotiv/node-v24.18.0-linux-x64.tar.xz
```

`--dataset-private-root` 必须显式给出绝对真实私有根；prediction manifest 与 reveal descriptor 必须位于
其下两个不同的受保护子目录，各自只能按 basename 引用同目录普通文件。development run 必须提供
development reveal descriptor，但 loader 会先只读无 Gold 身份并完成全局用途占用，成功后才打开它；
holdout prediction run 禁止提供 descriptor，只有 reveal 阶段在永久 claim 落盘后才打开 holdout descriptor。
根与每层目录仍要求当前用户所有、
精确 `0700`、逐段禁止跟随符号链接，
文件要求精确 `0600` 且 `nlink=1`。这个参数只影响只读数据集 loader；registry、检查点和报告仍固定在
Fermata 自己的 `private/` 边界，不能借此改根。

```bash
FERMATA_REVIEW_ENV="/absolute/path/under/Fermata/private/实验环境文件.env"
FERMATA_REVIEW_DATASET_ROOT="/home/ubuntu/codex-urmotiv/Urmotiv/private"
FERMATA_REVIEW_MANIFEST="$FERMATA_REVIEW_DATASET_ROOT/受保护转换输出/manifest.private.json"
FERMATA_REVIEW_DEV_REVEAL_DESCRIPTOR="$FERMATA_REVIEW_DATASET_ROOT/development揭盲材料/reveal.private.json"
FERMATA_REVIEW_HOLDOUT_REVEAL_DESCRIPTOR="$FERMATA_REVIEW_DATASET_ROOT/holdout揭盲材料/reveal.private.json"
FERMATA_DEV_BASELINE_STATE="/absolute/path/under/Fermata/private/dev-baseline-state"
FERMATA_DEV_CANDIDATE_STATE="/absolute/path/under/Fermata/private/dev-candidate-state"
FERMATA_HOLDOUT_BASELINE_STATE="/absolute/path/under/Fermata/private/holdout-baseline-state"
FERMATA_HOLDOUT_CANDIDATE_STATE="/absolute/path/under/Fermata/private/holdout-candidate-state"

# env 文件内：
# AETHER_BASE_URL=https://...
# AETHER_API_KEY=...
# 如果冻结档位实际使用 dashscope，再加入对应 DASHSCOPE_* 两项。
# EVAL_CODE_VERSION=<与干净 HEAD 完全一致的 40 位小写提交 SHA>
# EVAL_CONCURRENCY=2

# 阶段 1：冻结的 v1 配置在 development 上跑修改前基线。
node scripts/run-with-env.mjs --review-flow-evaluation "$FERMATA_REVIEW_ENV" \
  --action=run --manifest="$FERMATA_REVIEW_MANIFEST" \
  --reveal-descriptor="$FERMATA_REVIEW_DEV_REVEAL_DESCRIPTOR" \
  --dataset-private-root="$FERMATA_REVIEW_DATASET_ROOT" \
  --private-dir="$FERMATA_DEV_BASELINE_STATE" \
  --partition=development --variant=baseline --label=reviewflow-v1-dev-baseline

# 阶段 2：修改、提交并更新 EVAL_CODE_VERSION 后，只在 development 上迭代候选；
# 每轮用全新 label，并绑定同 datasetFingerprint 的 development 基线。
node scripts/run-with-env.mjs --review-flow-evaluation "$FERMATA_REVIEW_ENV" \
  --action=run --manifest="$FERMATA_REVIEW_MANIFEST" \
  --reveal-descriptor="$FERMATA_REVIEW_DEV_REVEAL_DESCRIPTOR" \
  --dataset-private-root="$FERMATA_REVIEW_DATASET_ROOT" \
  --private-dir="$FERMATA_DEV_CANDIDATE_STATE" \
  --partition=development --variant=candidate --label=reviewflow-v2-dev-candidate-01 \
  --baseline-label=reviewflow-v1-dev-baseline

# 阶段 3：人工选定完整 development candidate 后，第一次进入 holdout。
# 命令会先永久冻结 development baseline/candidate 的发布物和生产身份，再生成 baseline 预测链；
# holdout label 必须与 manifest.holdoutRegistration.baselineLabel 完全一致。
node scripts/run-with-env.mjs --review-flow-evaluation "$FERMATA_REVIEW_ENV" \
  --action=run --manifest="$FERMATA_REVIEW_MANIFEST" \
  --dataset-private-root="$FERMATA_REVIEW_DATASET_ROOT" \
  --private-dir="$FERMATA_HOLDOUT_BASELINE_STATE" \
  --partition=holdout --variant=baseline --label=reviewflow-v1-holdout-baseline \
  --development-baseline-label=reviewflow-v1-dev-baseline \
  --development-candidate-label=reviewflow-v2-dev-candidate-01

# 阶段 4：候选提示词、处理步骤、配置与提交全部冻结后，只运行一次 holdout candidate；
# label 对和阈值摘要已经写死在 manifest，不能临时换 label 重跑。
node scripts/run-with-env.mjs --review-flow-evaluation "$FERMATA_REVIEW_ENV" \
  --action=run --manifest="$FERMATA_REVIEW_MANIFEST" \
  --dataset-private-root="$FERMATA_REVIEW_DATASET_ROOT" \
  --private-dir="$FERMATA_HOLDOUT_CANDIDATE_STATE" \
  --partition=holdout --variant=candidate --label=reviewflow-v2-holdout-candidate \
  --baseline-label=reviewflow-v1-holdout-baseline \
  --development-baseline-label=reviewflow-v1-dev-baseline \
  --development-candidate-label=reviewflow-v2-dev-candidate-01

# 阶段 5：两条 holdout phase 都完整后，一次性打开 Gold，同时生成前、后和 comparison。
node scripts/run-with-env.mjs --review-flow-evaluation "$FERMATA_REVIEW_ENV" \
  --action=reveal --manifest="$FERMATA_REVIEW_MANIFEST" \
  --reveal-descriptor="$FERMATA_REVIEW_HOLDOUT_REVEAL_DESCRIPTOR" \
  --dataset-private-root="$FERMATA_REVIEW_DATASET_ROOT" \
  --baseline-private-dir="$FERMATA_HOLDOUT_BASELINE_STATE" \
  --candidate-private-dir="$FERMATA_HOLDOUT_CANDIDATE_STATE"
```

holdout baseline/candidate 阶段不会生成任何可读分数；只保存完整的安全枚举投影、每题固定 11 角色的
EOF/`finish_reason=stop`/SSE `DONE` 收据摘要，以及全局 phase marker。candidate 不完整就不能 reveal，
也不能换 label 或目录另跑新链，只能对原链做不重发请求的 exact resume。阶段 5 在打开第一份 holdout
Gold **之前**先永久占用 reveal claim；崩溃恢复必须是同一代码身份、同一两条链和 `--resume`。
第一次 holdout 请求前还会以 O_EXCL 永久提名完整发布的 development baseline 与人工选定 candidate，
并分别冻结模型/provider/提示词角色身份、运行配置和正式审题代码摘要。holdout 两个槽位必须逐一匹配；
完整 runtime fingerprint 当前绑定 46 个登记代码文件；同一条链的 exact resume 要求这 46 个文件和提交
身份全部不变。即使只修改 checkpoint、报告、CLI 或 bootstrap，也必须新建实验链/label，不能拿新提交
续接旧链。development 提名到 holdout 槽位也绑定同一份完整 46 文件预测身份和提交号；在另行审阅出
可靠的语义子集前，adapter、dataset、runner、CLI、持久化或报告代码的任何变化都必须回到 development
重新运行。较小的 production code 子集只用于 runner 的引擎构建指纹，不参与放宽跨阶段验收。

所有 development 报告、揭盲后的两份 holdout 报告与 comparison 都只写到固定的
`Fermata/private/review-flow-evaluation-registry/`（目录 `0700`、文件 `0600`），不再写
`experiments/results/`。JSON、Markdown、report-set marker 和全局 publication receipt 按固定字节
幂等补齐，marker 最后发布；在任何一步崩溃后，exact resume 只核对/补齐，不重发模型请求。普通题
原创性只计有独立标注的样本；历史/XML 品味与技术意见只计召回；`contestUse` 会分别报告 used、
not_used、unknown、历史通过和历史否决覆盖，并明确使用 `icpcFit=strong/acceptable → used` 的运行指标
映射。任何样本量下报告都固定 `eligible=false`，不能只凭一两个样本的高百分比宣布准确性达标。

每个 label 和 run UUID 都是全项目永久实验身份；固定私有全局 registry 用 O_EXCL claim 绑定 label、
run、代码/配置身份和检查点目录的 device/inode，因此换 `--private-dir` 或并发启动也不能重用 label。
只有同一 label、同一主体/case 集合、同一代码、Node/platform/arch、实际依赖版本、配置、模型绑定
和基线绑定全部精确一致时才能恢复。新四调用 checkpoint 逐阶段绑定 input、prompt、schema、model、
attempt、真实 EOF 与 output 哈希；只有全部绑定一致的成功阶段可复用。失去 worker 的 `active`
必须派生为 `orphaned_unknown`，且只能写新 checkpoint，不能改旧文件原字节。软停止只拒绝尚未开始
的请求，在途请求自然读到真实 EOF。完整性要求 pending/active/orphaned/failed/missing 全为 0，
并要求每个必需阶段恰有一份唯一有效 receipt；否则准确性报告固定 `INCOMPLETE`。

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
（包括 429 重试等待）另有 30 分钟的最终保护；持续输出会按有效进度刷新停顿计时，任何 transport
调用都不再以 4 小时作为常态。实验可分别用 `LEVELS_LLM_OUTPUT_IDLE_MS`、
`LEVELS_LLM_FIRST_OUTPUT_MS` 和 `LEVELS_LLM_MAX_DURATION_MS` 覆盖三项，但正式 review-flow
配置只接受 10 至 30 分钟的有界值；不得恢复 120 秒总时限。
旧实验的 `LEVELS_LLM_*` 约束按冻结 checkpoint 解释；新四调用 scheduler 的 attempts 和 duration
由本节前述固定契约控制。旧的 `LEVELS_LLM_TIMEOUT_MS` 已不再支持，设置后会明确报错。
`EVAL_CONCURRENCY` 决定同时处理几道题，只接受 1 到 32 的整数。模型响应正文按 UTF-8 原始字节
计算，固定最多读取 4 MiB（约 4 MB）；超过后立即停止读取，并且错误和日志都不会包含响应正文。
流式响应还固定最多读取 65536 个非空网络分块；分块是底层每次交给客户端的一小段字节。超过上限
说明响应被异常细碎地发送，客户端会停止并按固定格式错误处理，避免大量微小分块让超时保护无法及时运行。

正式服务已有的 `settings.json` 会保留上次保存的 `experimentVersion`，不会因为替换
`models.yaml` 自动改变。当前配置版本是
`experiment-2026-08-review-flow-historical-rubric-v1-eof-receipt-v3`。部署后必须先保持
`enabled=false`；生产资格 verifier 仍恒拒绝，因此本次离线代码通过也不会领取任务。

四调用 transport 的单题语义拓扑是 `A || B`、`A → C`、`B + C → D`。若服务商无法同时保证
原生 `thinking=max` 与强制 schema，A-D 保持自然语义请求，全题末尾最多增加 1 次统一 formatter；
formatter 只接收 A-D 已有输出并逐字段转写，不得重判。统一 schema 是唯一来源，严格声明
required/type/enum/nullability/items，并在每层 object 使用 `additionalProperties=false`；
运行时复验并把 schema 指纹写入 receipt。项目不再为任何请求设置自有的输出上限：每次请求都
显式请求提供商硬上限 384000 token（DeepSeek V4 全系文档化最大输出；若不显式传入，提供商
默认 max_tokens=4096，反而更小，所以必须显式设置）。唯一剩余的输出终止边界是提供商自身的
硬上限，到达后按 LLM_OUTPUT_LENGTH_LIMIT 终态处理并 fail closed。development smoke
不对健康流设置总墙钟硬杀：首个有效输出前使用 30 分钟最终保护；首个有效输出后只执行
10 分钟无进度保护，并持续读取到服务端 EOF。

所有模型档位共用一个请求级调度器：全局并发默认 12，可显式配置 16；20 必须同时登记已接受的
并发探针。按样本轮转且 work-conserving，不存在三个档位上限相加。每个逻辑请求最多 3 attempts，
每题合计最多 8；只对 429、5xx、connect、首输出超时、无进度超时和流中断重试，并使用
`Retry-After`、指数退避和抖动。output-limit、schema 或永久错误不做相同请求盲重试，单题失败不会
触发全局 fail-fast。首输出、持续进度、无进度和真实 EOF 由 transport 分别记录。

这些代码与合成测试只证明离线协议行为，不证明模型判断准确。双轴报告分别输出 verdict 的预测/人工
class counts、confusion、false accept/reject，以及只对冻结 CF 参考计算的难度 MAE 和分层覆盖；
完整性未通过时 metrics 必须为空。

development smoke 使用固定 `development-smoke-6x4-v1` profile，只验证管道，不进入最终
`>=32` 题冻结校准集，也不报告准确率提升。输入只能是 `slot-01` 至 `slot-06` 六个不可逆匿名槽位：
低/中/高均有覆盖、人工 pass/reject 各 3、既往 output-limit/schema 各至少 1，且六槽都必须同时绑定
难度和结论两条冻结人工证据。私有 manifest 只保存绝对本地引用、逐文件 SHA-256、不可逆槽位摘要和
双轴真值；不复制题面、题解或测试。启动前逐一重算冻结来源、人工结论、人工 CF 难度证据及既往失败
检查点的绑定。该 profile 禁止原题集、Codeforces 和 Web 请求；唯一可联网目标是当前配置的 Aether
DeepSeek 服务。

唯一启动入口是 `scripts/run-with-env.mjs --development-smoke`。env 文件必须且只能含完整
`AETHER_BASE_URL`/`AETHER_API_KEY`；wrapper 会丢弃其它 provider、评估、原题集、Codeforces 和项目
凭据。`--preflight` 是默认离线动作，只核对私有文件 owner-only 权限、无符号链接、哈希/证据绑定、
固定模型映射、当前提交和 tracked worktree，不调用网络。显式 `--network-phase0` 才创建新的随机
run 并发起两个槽位；`--network-phase0 --resume=<64位runId>` 只恢复同提交、同 profile、同 manifest
的未完成 Phase 0 run。

Phase 1 不创建 run。`--preflight-phase1 --resume=<64位runId>` 只读验证不可变 checkpoint 链、
代码/profile/manifest/run 绑定、`phase0_complete` 状态、固定 A/B/C/D 共 8 个成功 EOF receipt、
零失败/在途 attempt、30 次共享上限和恰好四个剩余槽位；输出 `GO-PHASE1` 时仍为 0 次网络调用且
不追加 checkpoint。真实放行必须同时给出
`--network-phase1 --resume=<64位runId> --release-phase1`。Phase 0 与 Phase 1 参数互斥；缺少显式
release flag 时不能调用网络。示例：

```bash
node scripts/run-with-env.mjs --development-smoke private/development-smoke-6x4-v1/review-flow.env --preflight
node scripts/run-with-env.mjs --development-smoke private/development-smoke-6x4-v1/review-flow.env --network-phase0
node scripts/run-with-env.mjs --development-smoke private/development-smoke-6x4-v1/review-flow.env --preflight-phase1 --resume=<64位runId>
node scripts/run-with-env.mjs --development-smoke private/development-smoke-6x4-v1/review-flow.env --network-phase1 --resume=<64位runId> --release-phase1
```

Phase 1 放行在独占 owner-only 锁内先原子追加唯一 release revision，登记 T1、四个剩余槽位的安全绑定、
已使用 8/总上限 30，以及相对 T1 的 15/60/180 分钟闸门，然后才允许 fetch。崩溃恢复沿用该 release
和已计费 receipt，不重复放行、不重置预算、不重发成功 stage；授权后没有成功 checkpoint 的不确定
attempt 固定拒绝。四槽先形成最多 8 个 A/B 请求，再按 DAG 推进 C、D 和必要 formatter；全局并发
仍为 12。失败只关闭新阶段，已在途健康流自然排空，且不设置总墙钟硬杀。

每个 run 使用只增不改的原子 checkpoint 链。请求授权 receipt 在 fetch 前落盘；成功 stage 的原始
输出和 sealed receipt 只保存在 Git 忽略私有 checkpoint 中。Phase 0、Phase 1 和全 run 分开记录安全
聚合计数、P90 时序、失败码及 ETA；`accuracyClaim` 始终为空且不进入最终校准。两阶段共用一次预算：
每逻辑请求最多 1 attempt、每题最多 5、整题重跑为 0、总逻辑请求最多 30、外部 transport 累计最多
52、全局并发 12；声明值、聚合预算和运行 fence 全部来自同一 profile，任何字段缺失或放大都在 fetch
前拒绝。所有错误类别均零重试。

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

Candidate D 使用独立入口 `npm run experiment:probe-difficulty-pro`，不会读取或改写 Candidate B
报告。入口固定依次检查人工短题与公开题 CF 2006E，固定 2048 输出上限、每题最多一次真实 fetch，
并在付费前持久化 active 检查点；首题失败后不会发送第二题。成功必须同时满足输出 schema、
`finish_reason=stop` 和真实 HTTP EOF。运行前还会核对完整 Git HEAD、runner 自身 SHA-256、
tracked/untracked 干净状态、Candidate C 锚点、public83 零重叠、模型配置和当前服务身份指纹。
Candidate D 的私有预登记固定为 `private/difficulty-pro-probe-20260801-a/manifest.private.json`；
CF 2006E 快照复用既有只读公开材料目录中的 `difficulty-thinking-probes-20260801-c/2006E.json`，
但不读取 Candidate B 报告。runner 同时硬绑定该公开材料登记、public83、Candidate C 锚点和模型
配置的已跟踪 SHA-256，不能通过同步改写新 manifest 绕过。私有目录须为 `0700`，文件须仅 owner
可访问。manifest 的精确契约由 runner 导出的
`difficultyProProbeManifestSchema` 定义，并须预先绑定提交、runner、配置、锚点、public83 和服务
指纹以及来源文件的字节数、文件/题面哈希。运行必须通过 `scripts/run-with-env.mjs` 提供与 HEAD
一致的 `EVAL_CODE_VERSION`。结果只写入 Git 忽略的 `private/difficulty-pro-probe-results/`，不含
题面、预测或模型原文；report/summary 只是非权威证据，只有精确文件名的 completion certificate
才可声明 `complete: true`，并逐一绑定检查点、报告和汇总哈希。崩溃、关闭 dispatcher 失败或任一
不完整状态都会占用该标签，不能重跑洗掉。

Candidate D 已实际在第一个合成请求收到 HTTP 404，因此报告不完整、候选已失败；没有发送第二题，
也没有启动新的 83 题实验。当前配置只把 difficulty 恢复到 Candidate C 的 flash 请求，不改动
同档位其它流水线。`npm run experiment:probe-difficulty-connectivity` 是一次独立、固定标签的
单合成题预检：只允许一个真实 fetch，付费前同步落盘 active 检查点，必须验证结构化输出、
`finish_reason=stop` 并持续读取到真实 HTTP EOF；499、取消、流中断、缺结果、第二次修复请求或锁
释放失败都会使 completion 的 `complete=false`。它同时绑定干净 Git HEAD、runner、models.yaml、
Candidate C 锚点以及当前 provider/baseUrl/apiKey 的安全摘要；只在 Git 忽略的
`private/difficulty-connectivity-probe-results/` 保存 `0600` 检查点和最终 completion，不保存题面、
模型原文、地址或密钥，也不得复用旧标签。

旧的 a 固定标签已在提交 `3a442caa898ba9743c4d3d3a4d003c15c4070903` 上实际运行：expected=1、
succeeded=0、failed=1、complete=false。唯一一次 fetch 收到 HTTP 404，固定结果码为
`LLM_HTTP_ERROR`，没有观察到正常 HTTP EOF，也没有进入结构化输出校验；标签锁已安全释放。私有
completion 的 SHA-256 为 `b63f08ea270b0459a4140706996b7b936bdc5f869db49afc4a1f7aac46490590`，
原始私有证据继续只保存在 Git 忽略目录且权限为 `0600`。这个标签已经占用，不能删除证据或重跑。
只读定位确认旧配置的 base URL 位于站点根路径，因此客户端实际请求了缺少 `/v1` 的
`/chat/completions`。随后对同一服务身份精确执行了一次非生成式 `GET /v1/models`：响应为 2xx、
正文到达真实 EOF、标准 JSON `data` 数组内有 22 个安全模型 id，并且精确包含
`deepseek-v4-flash` 与 `deepseek-v4-pro`。这只能证明模型目录声明存在这些 id，不能替代任何生成
请求的协议预检。当前 v3 只把 provider base URL pathname 修正为 `/v1`，请求体中的模型、温度、
thinking 和输出上限保持不变。

新的 b 固定标签已在提交 `9baf6dcba9f3613bc35162da960176013d195631` 上实际运行：expected=1、
succeeded=0、failed=1、complete=false，且 request/fetch 都精确为 1。服务返回 HTTP 200，但客户端
在遇到不认可的响应格式后取消了正文，没有观察到真实 HTTP EOF，也没有进入结构化输出或
`finish_reason=stop` 校验；固定结果码为 `LLM_RESPONSE_FORMAT_INVALID`，标签锁已释放。私有
completion 的 SHA-256 为 `3f44838b6a8cb9a7e75e1dc785c7275cc9f39be890100c6f8d13f8b35f73fc95`。
这个标签同样已经占用，不能重跑。当前 v4 已让客户端在格式校验失败后继续逐段丢弃响应内容，只有
读到真实 EOF 才抛出最初的固定格式错误；排空期间不保存、不记录也不继续解析内容。c 固定标签已在
提交 `d4ea8c8ef35b0a3a77ea335887d75b24bd6a1fca` 上实际运行一次：expected=1、succeeded=0、
failed=1、complete=false，request/fetch 都精确为 1，HTTP 200，正文到达真实 EOF，且客户端没有
取消正文。失败码仍为 `LLM_RESPONSE_FORMAT_INVALID`，安全失败阶段为 `trailing_data`，说明传输已
完整收口，但终止标记后的协议数据仍未通过严格校验；没有进入结构化输出和 stop+EOF 成功判定。标签锁
已释放，两个私有产物均为 `0600`，completion 的 SHA-256 为
`4c80428cbc136f4c8c682d41a083d4b59b7decdf5b5b92c365f667ccea191afd`。c 已占用，不能重跑，也不得
据此启动 83 题付费实验。旧 checkpoint 仍按当时的 10 分钟连续停顿与 4 小时保护解释；新调用不继承
这一常态。传输中断、停顿超时或任务取消都不会伪装成 EOF。私有 completion 只保存固定枚举的
失败阶段，不保存原始事件、响应字段、正文、长度明细或服务商错误。

v5 在不放宽任何接受条件的前提下，把 `trailing_data` 细分为三个固定子阶段：
重复终止标记、终止标记后仍有数据，以及 `finish_reason=stop` 后仍有非空候选事件。
d 固定标签已实际运行且永久占用：HTTP 200，request/fetch 都精确为 1，正文到达真实
EOF，客户端没有取消正文；安全失败阶段是 `trailing_data`，子阶段是历史粗分类
`data_after_done`，结果码为 `LLM_RESPONSE_FORMAT_INVALID`，`complete=false`。这只能证明 `[DONE]`
后还有至少一个非空 data 事件，无法区分它是用量元数据、非空 `choices`、正文/工具输出，
还是其它或无法分类的形状；因此仍不得启动 83 题付费实验。

当前 v6/e 仍严格拒绝任何 `[DONE]` 后 data，但会在有界内解析并排空整个尾部，以封闭枚举区分：
仅重复 DONE、严格白名单的用量/标准元数据、非空 `choices`、正文或工具字段、其它或无法分类，
以及在真实 EOF 前中断的元数据尾部。正文/工具和非空候选始终按更危险的类别优先；
只有整个尾部每个事件都通过严格元数据字段、类型、字符串长度、计数键名、深度和键数上限校验，
且真正到达 HTTP EOF，才记为 `data_after_done_usage_metadata_only`。正常到达 EOF 的所有尾部形状仍都返回
`LLM_RESPONSE_FORMAT_INVALID`且 `complete=false`；中断、取消或超时则保留对应的固定传输错误码和安全子阶段，
也必定 `complete=false`。产物和日志不保存原始事件、字段名、字段值、文本、计数或长度。

当前产物 schema 已升为第 3 版。e 固定标签已在提交
`00a3a7c3cd455483824818dd636cab1b78a1c994` 上实际运行一次：expected=1、succeeded=0、
failed=1、complete=false，request/fetch 都精确为 1。服务返回 HTTP 200，正文到达真实 EOF，
客户端没有取消；固定结果码为 `LLM_RESPONSE_FORMAT_INVALID`，失败阶段为 `trailing_data`，
封闭子阶段为 `data_after_done_other_or_unclassifiable`。这排除了“整个 DONE 后尾部都只是严格
用量/标准元数据”，但不能安全推断未知尾部的字段或内容，因此仍不得放宽协议或启动 83 题实验。
两个私有产物均为 `0600`，标签锁已释放；completion 的 SHA-256 为
`e898c52405da58fe6c122eaf4676ac71101b2304a1531aab7033658c4c36959c`。a/b/c/d/e 均已永久占用，
此后没有发起其它请求。

当前源码中的 v7/f 只进一步诊断 e 的 `data_after_done_other_or_unclassifiable`，不改变生产
解析器的接受条件。它把整个 DONE 后尾部归入一个固定闭集：只含空 data、重复 DONE 与严格
元数据的任意组合；JSON 语法无效；JSON 是合法值但不是对象；顶层 error 对象；未知对象或
扫描上限；非空 choices；以及正文或工具字段。多个事件只保留危险优先级最高的一个枚举，
不保存各类是否同时出现、出现次数、原始事件、字段名、字段值、正文、长度或计数。无论最终
类别是什么，只要 DONE 后出现 data，仍必须排空到真实 HTTP EOF 后以固定格式错误失败；EOF
前的中断、超时、取消、正文上限或分块上限只能记录 `data_after_done_tail_incomplete`。

f 的唯一标签是 `difficulty-candidate-c-connectivity-probe-20260802-f`，产物 schema 是第 4 版；
a/b/c/d/e 都列入不可重放的历史标签。f 仍未运行，而正式 `models.yaml` 已升级到新的多角色审题
版本；它保存的旧 v7 配置哈希与当前配置明确不同。因此 f 现已和 a–e 一样冻结为历史预登记，禁止
更新提交绑定、修改旧配置哈希或执行探针。若需要验证当前版本，必须另建新标签、schema 与修改前
就固定的配置身份，不能把 f 重新绑定到新配置来制造连续性。

探针与 env 更新工具不从调用者 `PATH` 查找 Git，而是固定使用经系统路径权限检查的
`/usr/bin/git`。每次仓库检查都会新建一个 `0700` 临时 Git 元数据目录；Git 只读取其中固定生成的
HEAD、config 和 info 文件，正式 `.git/config`、config include 与 `.git/info/attributes` 不在其读取
路径中。正式 HEAD/引用会独立解析，索引经稳定读取后复制为临时 `0400` 文件，正式索引描述符不交给
Git；对象目录与工作树通过显式继承的只读描述符绑定。检查结束后再次逐字节核对正式索引，并确认
HEAD、引用和这些目录未并发变化，再清理唯一临时目录。临时 info/exclude 只
精确排除工作树根的 `.git/`，不会替 private 放宽忽略规则。Git 子进程使用最小环境，丢弃调用者的
`GIT_*`、代理、加载器及配置注入，并关闭系统/全局 Git 配置、replace objects、hooks、fsmonitor、
外部 diff、子模块递归和可选索引写入。直接入口还会在读取私有 env 或创建探针目录前拒绝
`GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE` 等调用者注入。

旧 connectivity 结果无论成功与否都只回答“旧 difficulty flash 请求能否完成一次协议往返”，不能
证明当前 `review-balanced` 可运行。旧的 difficulty/thinking/coding/verdict 五槽说明只适用于 v7
实验，不能作为当前生产资格。当前版本必须对 `reviewFlow` 的 11 个实际角色槽逐一绑定请求配置、
协议完成证据和相应人工标准的准确性结果；相同 model spec 可以共享协议能力证据，但各角色的准确性
不能因为模型相同就合并。任一角色缺失、取消、499、断流、跳过或未达门槛，都不得把整档位写成
可用，也不得开启生产领取。

每个固定标签一旦留下检查点、completion 或锁就不能重跑覆盖。旧 a/b/c/d/e 的失败证据必须永久保留，
后续新标签不能读取或复用它们。若后续探针异常退出留下同标签锁，只能在同时核对记录中的 PID、
进程启动时刻、完整命令和工作目录，确认该进程已不存在且确属本项目后，人工移除这一把锁；不得按
进程名批量结束 Node.js，也不得删除同标签检查点或 completion 来制造一次“干净重跑”。

正式领取还有一道独立于 settings 的生产资格证据门，实现在
`src/production-eligibility.ts`。当前可信聚合器尚未实现，因此所有实验版本都固定返回
`production_evidence_verifier_unimplemented`，并且不会读取或信任任何私有自述 JSON；即使操作员
同时修改 settings、实验版本或放入手写“合格证书”，也不会调用 claim。合格分支使用只存在于
进程内 WeakMap 的不透明 grant；任意 64 位摘要、`eligible=true` 同形对象或对象展开都不能伪造。
runner 身份单独绑定精确构建摘要、11 个角色配置与 provider 凭据的不可逆摘要，准确性证据指纹
另行进入运行上下文和 decision。日志只记录固定原因码和安全哈希。

真正的生产证据聚合器必须作为后续独立工作：它要回读原始协议 probe completion 和准确性
summary/completion，验证文件权限、排他标签、完整哈希链、当前 `experimentVersion`、profile、
`models.yaml`、provider 身份和实际请求配置，不能只相信另一份 JSON 里的 `complete=true`。
协议验证可以按完全相同的 distinct model spec 去重；准确性证据不能这样共用，必须按 solver、
solutionAnalyst、technicalAuditor、difficulty、editorialJudge、contestFit、originality、tags、critic、
adversary、adjudicator 这 11 个角色分别验证相应人工标准、完整性和门槛。该聚合器及其源证据测试
通过并经单独审阅前，生产资格总门保持恒关闭。

思维/代码标定必须先在 `experiments/data/levels/manifest.private.json` 登记私有数据集清单。
清单逐项绑定安全编号、文件名和文件原始字节的 SHA-256 校验值；目录里漏文件、多文件、改后缀、
出现符号链接或文件内容变化都会在任何付费模型请求前整体失败。标定集至少 60 题，每题 JSON 都要有
人工确认的思维难度和代码难度（1 到 5 级）、非空题面和题解，并且低、中、高三个 rating 段都要有
覆盖。损坏 JSON、重复题号、缺人工标准或缺任一分段同样不会被静默跳过。

当前检查点格式是第 5 版。每个思维或代码付费阶段开始前，脚本先把该安全编号和阶段写入
`activeStages`，原子保存成功后才调用模型；阶段成功或明确失败时，再把结果或固定失败码与移除
`activeStages` 放在同一次检查点写入中。进程异常退出留下的 active 项在续跑时会转成永久的
`STALE_IN_FLIGHT` 证据。第 5 版进度只保存 `safeId`、`contentHash` 和模型预测，不保存 rating 或
人工思维/代码等级；必须等整批在途请求收束后，报告阶段才连接 gold。第 4 版及更早格式不具备这条
边界，全部明确拒绝续跑，不会自动转换成看似干净的第 5 版。

当前可续跑进度仍保存在
`experiments/results/raw/levels-<标签>-checkpoint.json`；同标签 `--resume` 只读取这一份，不扫描或
拼接其它历史快照。第 5 版检查点同时保存实验链 UUID。任何模型失败、HTTP 499、取消、等待超时、
流中断、历史跳过或陈旧在途都会永久留在同一实验链的失败统计中：即使续跑后来补齐全部题目，
`complete` 和 `eligible` 仍为假。出现首个失败后，脚本只等待已经发出的模型请求自然结束并保存结果，
不再启动新的付费阶段；再次运行这条失败链也不会继续付费。只有最初以全新标签从零启动、且整个同标签
实验链没有留下任何失败证据的链才可能合格；这样的干净链在安全中断后仍可用同标签 `--resume` 继续。

跨标签 `--resume-from` 已明确停用：从同一旧检查点派生多个标签会形成分支，使某个分支的失败证据
可能被另一个分支绕开。需要保留修改前、修改后两份实验时，修改后的实验必须使用全新标签从零运行；
只有当前标签自己的 `--resume` 可以续跑。相同标签仍只允许一个进程持锁；异常留下锁文件时，先确认
服务器上没有对应标定进程，再人工处理。

盲评的逻辑与类型隔离地基位于 `experiments/lib/blind-evaluation.ts`。第 1 版契约把题目内容与 gold
（官方难度、人工等级或预期结论）定义为两个可独立序列化的严格文档，用数据集身份、用途、内容指纹
和逐题 contentHash 对账；每次推理前都会重验完整内容容器，推理回调只收到递归冻结的
`safeId + problem`，整批推理收束后才允许评分连接 gold。`public83` 以及当前 levels 集都已经参与过基线、实验设计或调参，固定属于
`development`（开发集），不得改称最终 `holdout`（未参与调参的盲测集）。现有 Git 忽略目录里的
旧 CF/levels 文件仍是内容与人工字段同文件保存；三个入口现在会先投影到上述函数边界，但磁盘材料
尚未迁移成两套独立目录，内容和 gold 也仍在同一进程中建立。因此当前实现不是进程级或磁盘级的
物理隔离。在完成一次私有、可核验的拆分迁移并登记全新 holdout 身份前，不得用这些旧文件发布
“最终盲测准确率”。

这层旧 thinking/coding/verdict 离线地基不等于当前正式 `reviewFlow`。正式流程已经包含冻结的
“只看题面”独立解题产物、冻结后读取题解的核验角色、独立的命题品味/比赛适配/原创性/标签证据、
冲突与反方审阅，以及最后按证据汇总的结构化裁决；但这些角色仍未分别完成准确性标定。机器人任务
契约也不提供可选参考实现，因此当前不会声称已编译或执行标程。旧离线入口的结果只能作为开发实验，
不能替代正式流程的完整修改前/后报告，也不能证明自动审题已经可用。

verdict 合成诊断从报告 schema 第 4 版起，不再按 rating 排序取样；它只按预登记内容身份和固定 seed
产生可复现的 case 顺序。normal/fabricated treatment 属于推理输入，但 rating、expected verdict 和
expected forced-reject 保存在另一份 strict case gold 文档中；该文档同时绑定父 content 指纹、case
身份、contentHash 和独立 gold 指纹。推理检查点与完成日志只保存 case 身份、contentHash 和结构化
预测，检查点的内容身份和配置指纹不使用包含 gold 的源 manifest 或 case gold 指纹；case gold 只并入
全部在途请求收束后的报告指纹。`expectationMet` 也只能在这之后计算。

verdict 私有检查点第 1 版位于 `private/evaluation-state/`。每个付费 case 在调用模型前同步、原子登记
为 active；成功或固定失败再原子落盘。崩溃遗留 active 与明确失败都会永久污染该链，后续同标签运行
不会继续为 pending case 付费；干净中断只续跑 pending，已成功 case 不重复请求。同标签由不可覆盖的
锁排他持有，完整链以固定 chain completion marker 防止重放。异常遗留锁只能在核对 PID、进程启动
时间、完整命令和项目工作目录后人工移除，不能删除检查点来制造干净重跑。
通用盲推理执行器也在首个请求失败、active 登记失败或结果持久化失败时立即关掉本地启动闸门；即使
失败回调需要异步写盘，排队样本也不能在这段窗口内开始付费请求，只等待已经在途的请求自然收束。

报告把“当前阶段是否都跑完”的 `operationalComplete`、“实验链是否无失败证据”的
`integrityClean`、准确性是否达标的 `accuracyPassed` 和最终可用性 `eligible` 分开记录。思维与代码
分别计算完全一致率、相差不超过 1 级的比例和平均绝对误差；两类都必须达到完全一致至少 60%、
相差不超过 1 级至少 90%、平均绝对误差不超过 0.6，并满足至少 60 题，`accuracyPassed` 才为真。

CF public83 难度报告从 schema 第 3 版起同样把 `executionComplete`、`accuracyPassed`、
`anchorsEligible` 和 `eligible` 分开记录。只有 expected 与结果数都精确为 83、83 题全部成功且没有
499、取消、失败或缺失时，才可能按 MAE ≤ 200、±200 命中率 ≥ 75% 判断 `accuracyPassed`。这个指标
判断可在临时锚点上保留，但 `provisional: true` 会固定令 `anchorsEligible=false`，因此最终
`eligible=false`；只有执行完整、准确性达标、数据 manifest 已验证且锚点非 provisional 时才可用。
第 4 版再明确写入 `dataset.purpose=development`；verdict 合成诊断第 4 版继续写入同一用途字段，
并分别记录 prediction-only 推理配置指纹与推理收束后才加入 case gold 的报告指纹。
报告另存当前 provider/baseUrl/apiKey 的安全摘要，并把该摘要纳入带 Git 提交的配置
指纹；更换网关或密钥不能沿用旧实验链。脚本还会在打开检查点或发起付费请求前，核对
`EVAL_CODE_VERSION` 与真实 HEAD 完全一致、Git 可见的工作树干净、runner 及其登记的直接/传递
运行依赖与 HEAD 字节一致，并把 runner SHA-256、依赖代码组合 SHA-256/文件数和 `models.yaml`
原始字节 SHA-256 一起绑定进配置指纹、检查点和报告。换代码、依赖清单或模型配置都不能续用旧链。
completion marker 表示这条执行链已完整收束并阻止重放，不等于准确性达标，最终是否可用只看
`eligible`。

每次执行使用新的执行 UUID，分别写出
`levels-<标签>-<执行UUID>-report.md`、`levels-<标签>-<执行UUID>-summary.json` 和最后落盘的
`levels-<标签>-<执行UUID>-completion.json`。完成文件绑定报告与汇总各自的 SHA-256；同标签续跑不会
覆盖旧报告，写到一半的文件也不会被误认成成对完成的证据。检查点、快照、报告和完成文件都通过
随机临时文件原子替换。日志与公开汇总只记录安全编号、固定错误码、阶段、等级、运行参数和汇总数字，
不记录私有文件名、服务商错误原文、题面、题解或模型原始输出。服务地址仍只显示不含密钥的短校验值。

旧 difficulty/levels 工具产出的 `experiments/results/*.json` 和 `*.md` 是不含题面原文的汇总统计，
会入库；review-flow 报告是上一节所述的例外，全部只留在固定私有 registry。
`experiments/data/` 和 `experiments/results/raw/` 里含有较完整的题面/中间结果，不入库。规则详见
AGENTS.md 第 4 节。

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
| CF 难度（旧 difficulty.ts） | **Candidate C 完整但未达标；旧 provider-v1 探针已冻结** | 旧 83/83 结果只作历史证据；不得据此声明当前四调用准确。 |
| 思维/代码难度（旧流水线） | **旧实验均不可作基线** | 旧结果不完整或缺分层，保持原字节只读。 |
| 查重判断（旧 verdict.ts） | **旧设计不可作准确性基线** | 不能替代独立 human truth 的 verdict 轴。 |
| 四语义请求 reviewFlow | **代码离线验收进行中；准确性未实跑；生产恒关闭** | A/B/C/D、统一 formatter、全局公平调度、阶段 receipt、完整性 gate 与双轴汇总已有合成覆盖；旧实验终态仍为 0 completed / 20 failed / 72 pending / 4 orphaned，accuracy=`INCOMPLETE`。 |


正式付费诊断必须由仓库 owner 直接使用绝对 Node 路径调用
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
  活动编号；目录外、停用或重复编号都会让该次证据流不完整，不能提交。

## 项目结构

```
config/
  models.yaml              当前模型/native max 与 30 分钟有界 transport 配置
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
  production-eligibility.ts
                           正式领取总门与不透明 grant；可信聚合器完成前零签发、恒关闭
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
experiments/               离线调优脚本，见上面"实验怎么跑"
test/                      vitest，覆盖签名算法、HTML 解析、数值映射、
                           settings 乐观锁、verdict 阈值、client 错误分类等
```
