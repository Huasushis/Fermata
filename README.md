# Fermata

Fermata 是一个**独立部署的 AI 审题服务**。它通过 Urmotiv 的机器人 HTTP API（应用程序编程接口）领取待审题目，使用配置的模型服务商生成结构化审核意见，再把意见交回 Urmotiv。Fermata 还提供一个小型管理 HTTP API，供运维人员或 Urmotiv 的 `fermata-control` 插件读取健康状态、修改公开运行设置和唤醒一次轮询。

Fermata 不是 Urmotiv 的插件、不是数据库服务，也不是远程代码执行器。它与 Urmotiv 分开安装、分开持有凭据，只通过明确的 HTTP 契约通信。完整的管理端 API 和 JSON Schema（字段、类型和范围的机器可读规则）见 [`docs/http-api.md`](docs/http-api.md)。

> **当前版本的声明边界**：本版本可以验证接口、JSON 格式和进程运行状态，但**不声明审题评分准确率，也不声明已经具备生产审题资格**。`status: "ok"`、`/healthz` 返回成功、模型请求格式正确，都不能推导出与人工标准的一致率。

## 1. 产品边界

### Fermata 负责什么

- 作为 Urmotiv 机器人客户端，调用 `claim`、`renew`、`complete` 三类机器人 API。
- 在内存中处理题目快照和模型结果，并按 Urmotiv 的审核输入契约提交结构化意见。
- 作为管理 API 服务端提供健康检查、公开设置读写和立即轮询动作。
- 将模型服务商配置与运行期设置分开保存；密钥只进入进程环境和内存。

### Fermata 不负责什么

- 不连接 Urmotiv 的 PostgreSQL、Redis、对象存储或其它内部数据库；Urmotiv 是题目、审核状态和权限的唯一来源。
- 不提供普通用户登录，不代替 Urmotiv 的账号、权限和人工审题流程。
- 不把 Anklang 当作工作流、审核状态或最终裁决系统。Anklang 证据只在 Urmotiv 机器人任务中以受信任的相似题检索结果出现；Fermata 不直接读取 Anklang 数据库。
- 不把运行成功、协议成功或结构化输出成功当作准确性证据。

## 2. 当前状态：运行性与准确性是两件事

首次阅读时请把下面两类证据分开：

| 类别 | 能回答的问题 | 当前版本的结论 |
| --- | --- | --- |
| **接口/格式运行性** | 进程能否启动？管理路由是否按 v1 契约返回 JSON？设置是否按 Schema 校验？ | 有管理 API、严格 JSON 校验、无令牌 liveness 路由和默认关闭设置。 |
| **评判准确性** | 模型的难度、质量、原创性、标签或通过/拒绝是否接近人工真值？ | **没有可用于本版本的已接受准确性声明；Fermata 不声称准确。** |

当前代码中的生产资格验证器固定返回 `production_evidence_verifier_unimplemented`。因此，即使操作员把公开设置中的 `enabled` 改为 `true`，worker（后台轮询进程）也会在领取任务前拒绝生产资格，不会发出 `claim`，不会提交审核结果。这是安全的 fail-closed（失败即关闭）行为，不是准确性通过证明。参见 [`src/production-eligibility.ts`](src/production-eligibility.ts) 和 [`src/reviewer-activation.ts`](src/reviewer-activation.ts)。

## 3. 运行前准备

- Node.js **24 或更高版本**（`package.json` 的 `engines` 约束；Dockerfile 使用 `node:24-alpine`）。
- npm。
- 一个可访问的 Urmotiv 服务，以及由 Urmotiv 管理员签发的机器人令牌。
- `config/models.yaml` 中默认模型档位所使用的每个模型服务商的一对环境变量。当前允许的 provider（模型服务商）是 `aether` 和 `dashscope`。
- 一个至少 16 个字符的 Fermata 管理令牌。它只用于管理 API，不等于 Urmotiv 机器人令牌。

配置模板在 [`.env.example`](.env.example)。模板只列出变量名和说明，不包含任何凭据。`config/models.yaml` 只描述模型档位，不应写入 API key。

## 4. 最短安全启动路径

### 4.1 使用宿主机 Node

先安装依赖：

```bash
npm install
```

Fermata 的 `npm start` 只读取**进程已经收到的环境变量**，不会自动解析仓库根目录的 `.env` 文件。推荐由 systemd、容器平台或其它 secret manager（密钥管理器）注入环境变量。

如果必须使用文件，使用仓库提供的安全启动器；它要求 env 文件是 Fermata `private/` 目录中的绝对路径、普通文件、当前用户所有且权限为 `0600`：

```bash
mkdir -p private
chmod 700 private
# 使用密钥管理器把变量写入 private/fermata.env；不要把真实值粘贴到 shell 历史或 Git
chmod 600 private/fermata.env
node scripts/run-with-env.mjs "$PWD/private/fermata.env" npm start
```

不要用 `source private/fermata.env` 或 `. private/fermata.env`。安全启动器不经过 shell，并且只向子进程传递登记过的环境变量。直接注入进程环境时，也不要把令牌写进启动命令、日志或文档。

开发时可以使用：

```bash
node scripts/run-with-env.mjs "$PWD/private/fermata.env" npm run dev
```

启动前会校验环境变量和 `config/models.yaml`。缺少必填变量、URL 含账号/密码/查询参数/片段、provider 变量只配置了一半，或默认档位需要而环境中没有 provider 凭据时，进程会退出，不会以残缺配置运行。**禁用模式也不绕过启动配置校验。**

### 4.2 使用 Docker

本仓库提供 [`Dockerfile`](Dockerfile)，不提供独立的 Compose 文件。构建镜像：

```bash
docker build -t fermata:local .
```

准备好只包含环境变量的私有 env 文件后，挂载 `data/` 保存运行期 `settings.json`：

```bash
mkdir -p data
docker run --name fermata \
  --restart unless-stopped \
  --env-file "$PWD/private/fermata.env" \
  -p 127.0.0.1:8720:8720 \
  -v "$PWD/data:/app/data" \
  fermata:local
```

默认 `FERMATA_SETTINGS_PATH=./data/settings.json`，在镜像中对应 `/app/data/settings.json`。如果改变了 `FERMATA_PORT`，必须同时改变端口映射的容器端口；反向代理或 Urmotiv `fermata-control` 只应访问管理端口，不应把它公开到互联网。

镜像不会复制 `.env`、`private/`、`test/` 或 `experiments/`。部署方应另外配置 `/healthz` liveness（存活）探测；该路由无令牌，只表示 HTTP 进程可达，不表示 worker 已启用或评分有效。

如果使用包含 Urmotiv 的外部 Compose 部署，请把 Fermata 作为独立服务运行，并单独注入 Fermata 的 env 文件；不要把 Fermata 的模型密钥合并进 Urmotiv 主应用环境，也不要为 Fermata 增加数据库连接。

## 5. 环境变量

所有 URL 必须是不含账号、密码、查询参数或片段的 `http://`/`https://` 地址。下面的“必填”是指服务启动所需；provider 是否还被当前档位使用由 `config/models.yaml` 决定。

| 变量 | 必填 | 默认值 | 作用与约束 |
| --- | --- | --- | --- |
| `URMOTIV_BASE_URL` | 是 | 无 | Urmotiv 基础 URL。Fermata 在其下调用 `/api/v1/robot/review-tasks/...`。 |
| `URMOTIV_ROBOT_TOKEN` | 是 | 无 | Urmotiv 机器人 Bearer 令牌，长度 8–4096。 |
| `FERMATA_PORT` | 否 | `8720` | 管理 HTTP 端口，范围 1–65535。 |
| `FERMATA_MANAGEMENT_TOKEN` | 是 | 无 | 管理 API Bearer 令牌，长度 16–4096；不要与机器人令牌混用。 |
| `FERMATA_SETTINGS_PATH` | 否 | `./data/settings.json` | 运行期公开设置文件；容器部署应挂载其所在目录。 |
| `AETHER_BASE_URL` + `AETHER_API_KEY` | 按档位 | 无 | Aether OpenAI 兼容接口。两者必须同时设置或同时留空。 |
| `DASHSCOPE_BASE_URL` + `DASHSCOPE_API_KEY` | 按档位 | 无 | DashScope compatible-mode 接口。两者必须同时设置或同时留空。 |
| `CODEFORCES_KEY` + `CODEFORCES_SECRET` | 否 | 无 | Codeforces 实验脚本的可选凭据；两者必须同时设置或同时留空。 |

模型服务商的 key 只在进程内使用，不写入 `settings.json`，也不会出现在 health 或 settings 响应中。修改模型选择应改 `config/models.yaml` 并让 `experimentVersion` 与运行期设置精确一致；不要把密钥放进 YAML。

### 离线校准与私有材料

`experiments/` 下的脚本是离线开发/评测工具，不是线上启动依赖。完整题面、题解、人工 gold（人工标准答案）、模型原始输出、私有校准清单和模型凭据不得写进 Git 跟踪的 README、文档或镜像；Docker 构建也不会复制 `experiments/`。文档中的请求和状态示例只使用合成值。

离线校准使用的 env 文件和材料应由部署或实验环境单独管理，不能复用线上机器人/管理令牌，也不能把校准结果直接当作生产资格。当前版本的生产资格门仍固定拒绝，任何接口/格式运行成功都不足以产生准确性声明。

## 6. 禁用、启用与运行期设置

### 默认禁用

第一次启动且不存在 settings 文件时，Fermata 创建 revision（乐观锁版本号）为 `1` 的设置，并固定 `enabled: false`。`pollingIntervalSeconds`、`maximumConcurrentTasks`、`modelProfileName` 和 `experimentVersion` 来自 `config/models.yaml` 的 `defaults`。worker 进程可以已经运行，但禁用的轮询会立即返回，不会领取任务。

禁用模式仍会启动时校验环境和默认档位所需的 provider；“不领取题目”不等于“可以缺少启动配置”。

### 公开设置的安全更新

1. `GET /api/v1/settings/public` 读取当前 `revision`。
2. 修改需要的设置后，把原 revision 作为 `expectedRevision` 发送 PUT。
3. 返回 200 时 revision 增加 1；返回 409 时说明已有其它写入，重新 GET 后再决定是否更新。

`settings` 是严格对象，只接受文档契约列出的字段；不能通过此接口写入 token、API key、数据库连接或其它内部字段。设置更新会原子写入文件；文件存在但损坏时服务启动失败，不会静默重置为默认值。

### 当前版本的启用结果

把 `enabled` 改为 `true` 只表示操作员明确请求启用。实际领取还要求版本完全一致、档位存在、所需 provider 已配置，并通过生产资格证据门；当前生产资格门没有可达的 `eligible=true` 分支。因此当前版本的正确预期是：管理 API 可写入设置，worker 继续运行并记录拒绝原因，但 `activeTasks` 不会因该设置而开始领取任务。

## 7. 管理 API 与快速检查

管理 API 的版本在路径中固定为 `/api/v1`，所有受保护路由使用：

```http
Authorization: Bearer $FERMATA_MANAGEMENT_TOKEN
```

快速检查（令牌应由环境或 secret manager 注入当前 shell）：

```bash
curl --fail-with-body --silent --show-error \
  http://127.0.0.1:8720/healthz

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${FERMATA_MANAGEMENT_TOKEN}" \
  http://127.0.0.1:8720/api/v1/health

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${FERMATA_MANAGEMENT_TOKEN}" \
  http://127.0.0.1:8720/api/v1/settings/public
```

路由、响应字段、错误码、JSON Schema 和可复制的请求示例见 [`docs/http-api.md`](docs/http-api.md)。

最重要的语义：

- `GET /healthz` 返回 `{ "ok": true }`，无需令牌；它是容器 liveness，不检查 provider、Urmotiv 或准确性。
- `GET /api/v1/health` 需要管理令牌，返回 `workerRunning` 和 `activeTasks`。`status: "degraded"` 只表示已知的 worker 停止或当前档位缺 provider；`status: "ok"` 不是评分准确性声明。
- `POST /api/v1/actions/wake` 只跳过等待并触发一次轮询；它不会修改 `enabled`，也不会绕过生产资格门。

## 8. 故障排查

| 现象 | 检查与处理 |
| --- | --- |
| 进程启动即退出，并提示环境变量校验失败 | 对照 [`.env.example`](.env.example) 检查必填变量、URL 格式、令牌长度，以及每个 provider 的 BASE_URL/API_KEY 是否成对出现。确认默认模型档位用到的 provider 都有凭据。 |
| `run-with-env.mjs` 拒绝 env 文件 | 路径必须是 `$PWD/private/` 下的绝对路径；目录必须是当前用户所有且权限 `0700`，文件必须是当前用户所有的普通文件且权限 `0600`。不要使用符号链接或 `source`。 |
| `/healthz` 成功，但管理 API 返回 401 | 管理 API 需要 `Authorization: Bearer ...`，且令牌必须是 `FERMATA_MANAGEMENT_TOKEN`；它与 `URMOTIV_ROBOT_TOKEN` 是两套令牌。 |
| `/api/v1/health` 返回 `degraded` | 查看 `workerRunning` 和 `activeTasks`，再确认当前 `modelProfileName` 所需的 provider 凭据；检查日志中的固定错误码，不要打印题面或令牌。 |
| PUT settings 返回 409 `CONFLICT` | 先 GET 最新设置，使用最新的正整数 `revision` 作为 `expectedRevision`，不要覆盖其它操作员的更新。 |
| `enabled: true` 但没有任务 | 当前版本预期如此：生产资格验证器固定拒绝，日志会出现 `production_evidence_verifier_unimplemented`，worker 不会发送 claim。这不是“模型准确”或“任务已处理”的证据。 |
| settings 文件损坏导致启动失败 | 停止服务，使用受控备份恢复完整 JSON；不要让部署脚本自动删除并重建，因为这会丢失操作员明确保存的版本和档位。 |
| Docker 容器反复重启或端口不可达 | 查看容器日志，确认 `FERMATA_PORT` 与 `-p` 的容器端口一致，确认 `/healthz` 在容器内可达，并确认挂载目录可写。 |
| Urmotiv 返回 401/403/404/409 | 401 通常是机器人令牌问题，403 是机器人权限问题，404/409 表示任务不存在、过期或冲突；先检查 Urmotiv 基础 URL、机器人权限和任务租约，不要把它当作模型错误。 |

## 9. 安全与数据处理

- 两个方向使用两套令牌：Fermata 调 Urmotiv 用机器人令牌；Urmotiv `fermata-control` 调 Fermata 用管理令牌。
- 管理 API 的公开设置 schema 是严格对象；响应只包含设置、revision 和 `secretsConfigured` 布尔值，不返回任何密钥。
- 日志只记录固定错误码及安全摘要，不记录题面、题解、模型原文或令牌。运维采集日志时仍应避免把环境变量或请求头写入日志系统。
- 机器人令牌只获得 Urmotiv 明确授予机器人的领取、续租和提交权限。Fermata 不拥有 Urmotiv 普通用户权限，也不执行提交到评测机的任意代码。
- `settings.json` 可能包含操作员选择的档位和版本，属于运行状态；将其放在持久化卷中并限制文件访问。模型密钥和机器人令牌不要写进该文件。

## 10. 契约来源

Fermata 是独立仓库，不能直接导入 Urmotiv 的 contracts 包，因此对使用到的字段做了带严格校验的镜像：

- 管理和机器人数据结构：[`src/urmotiv-schemas.ts`](src/urmotiv-schemas.ts)
- 管理路由：[`src/server.ts`](src/server.ts)
- Urmotiv 机器人客户端：[`src/urmotiv-client.ts`](src/urmotiv-client.ts)
- 设置与生产启用门：[`src/reviewer-activation.ts`](src/reviewer-activation.ts)、[`src/production-eligibility.ts`](src/production-eligibility.ts)

如果 Urmotiv 端的 API 或 schema 发生变化，必须先同步镜像和文档，再部署；不要仅凭旧响应或模型输出猜测字段。管理 API 的版本化约束和出站机器人 API 的边界以 [`docs/http-api.md`](docs/http-api.md) 为准。

## 11. 许可

见 [`LICENSE`](LICENSE)。
