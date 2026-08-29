# Fermata

Fermata 是独立部署的 AI 审题服务，向 Urmotiv 提交结构化审核意见。

<a id="toc"></a>
## Table of Contents（目录）

- [1. Background（背景）](#background)
- [2. Status（状态边界）](#status)
- [3. Prerequisites（前提）](#prerequisites)
- [4. Install（安装）](#install)
- [5. Start（启动）](#start)
- [6. Health（健康检查）](#health)
- [7. Usage（使用）](#usage)
- [8. API（接口）](#api)
- [9. Configuration（配置）](#configuration)
- [10. Operations and Security（运维与安全）](#operations-and-security)
- [11. Testing（测试）](#testing)
- [12. Support（支持）](#support)
- [13. Contributing（贡献）](#contributing)
- [14. Maintainers（维护者）](#maintainers)
- [15. License（许可）](#license)

<a id="background"></a>
## 1. Background（背景）

Fermata 是 USTC 算法竞赛协会的独立 AI 审题服务。它作为 Urmotiv 机器人客户端领取待审题目，运行分阶段的模型审核流程，再提交结构化意见；同时作为 HTTP 服务端向运维人员和 Urmotiv 的 `fermata-control` 插件提供管理接口。

Fermata 与 Urmotiv 分开部署、分开安装、分开保存凭据，不共享数据库或代码依赖：

- Fermata 只通过 Urmotiv 明确版本化的机器人 API 调用 `claim`、`renew` 和 `complete`。
- Urmotiv 的管理插件只访问 Fermata 的健康、公开设置和唤醒接口；这些接口不是普通用户 API，也不是模型推理 API。
- Fermata 不连接 Urmotiv 的 PostgreSQL、Redis 或对象存储，不执行选手代码，不提供普通用户登录。
- Anklang 的相似题信息若参与审核，只能作为 Urmotiv 任务快照中的受信任输入；Fermata 不读取 Anklang 数据库，也不与 Anklang 运行时互调。

管理接口契约见 [`docs/http-api.md`](docs/http-api.md)。Urmotiv 侧契约在本仓库以严格镜像的 [`src/urmotiv-schemas.ts`](src/urmotiv-schemas.ts) 为准。

<a id="status"></a>
## 2. Status（状态边界）

必须把接口运行性和审题准确性分开理解：

| 证据类别 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| 接口、JSON Schema 和启动检查 | 进程按约定启动，管理路由、设置和机器人数据通过格式校验。 | 不能证明模型判断符合人工标准。 |
| `/healthz`、`/api/v1/health` 成功 | HTTP 进程或 worker 的当前运行状态。 | 不能证明任务已领取、审核已提交或评分准确。 |
| 单元测试、类型检查和容器构建 | 当前工程契约在所运行的测试环境中成立。 | 不能替代人工标定，也不能产生生产资格。 |

当前生产资格验证器固定返回 `production_evidence_verifier_unimplemented`。因此，即使公开设置写入 `enabled: true`，worker 仍会在领取任务前失败关闭，不会发出 `claim` 或提交审核结果。这是安全边界，不是准确性通过声明。相关实现见 [`src/production-eligibility.ts`](src/production-eligibility.ts) 和 [`src/reviewer-activation.ts`](src/reviewer-activation.ts)。

本仓库不宣称当前版本的 CF 难度、思维难度、代码难度、标签、题目质量、原创性或通过/修改/拒绝结论达到任何准确率。离线校准材料和模型原始输出不进入 README、镜像或 Git；本次文档与工程验证不启动外部模型校准。

<a id="prerequisites"></a>
## 3. Prerequisites（前提）

- Node.js 24 或更高版本（`package.json` 的 engines 约束）。
- npm，以及可写的运行期设置目录。
- 一个可访问的 Urmotiv 服务和由 Urmotiv 授权的机器人令牌。
- `config/models.yaml` 当前默认档位所需的模型服务商凭据；当前支持 `aether` 和 `dashscope`。
- 至少 16 个字符的 Fermata 管理令牌。管理令牌与 Urmotiv 机器人令牌不是同一凭据。
- Docker 部署还需要 Docker Engine；若要运行镜像，反向代理或 Urmotiv 插件只能访问管理端口。

配置模板是 [`.env.example`](.env.example)，只包含变量名和说明。不要把真实令牌、API key、题面、题解或模型输出写入仓库。

<a id="install"></a>
## 4. Install（安装）

从仓库根目录安装锁定依赖：

```bash
npm ci
```

本仓库生产依赖保持精简；开发工具由 `package-lock.json` 固定。安装后可以先运行类型检查而不启动服务：

```bash
npm run typecheck
```

### Docker 镜像

仓库提供 [`Dockerfile`](Dockerfile)，不提供独立 Compose 文件：

```bash
docker build -t fermata:local .
```

镜像只复制运行服务需要的 `config/`、`src/` 和 TypeScript 配置，不复制 `private/`、`.env`、`experiments/` 或 `test/`。运行期设置应通过卷保存，密钥应由容器平台注入。

<a id="start"></a>
## 5. Start（启动）

### 使用进程环境

`npm start` 只读取已经注入进程的环境变量，不会自动解析仓库根目录的 `.env` 文件：

```bash
npm start
```

### 使用安全启动器

如需使用环境文件，文件必须位于 Fermata `private/` 下、是当前用户拥有的普通文件，目录权限为 `0700`、文件权限为 `0600`。使用仓库提供的启动器，不要使用 `source` 或 `.`：

```bash
mkdir -p private data
chmod 700 private data
# 由密钥管理器创建 private/fermata.env；不要把真实值粘贴到 shell 历史
chmod 600 private/fermata.env
node scripts/run-with-env.mjs "$PWD/private/fermata.env" npm start
```

开发热加载入口：

```bash
node scripts/run-with-env.mjs "$PWD/private/fermata.env" npm run dev
```

启动时会校验必填环境变量、URL 形状、成对的 provider 凭据和默认模型档位。缺少配置时直接退出；`enabled: false` 也不会绕过启动配置检查。

### 使用 Docker

```bash
mkdir -p data
docker run --name fermata \
  --restart unless-stopped \
  --env-file "$PWD/private/fermata.env" \
  -p 127.0.0.1:8720:8720 \
  -v "$PWD/data:/app/data" \
  fermata:local
```

默认管理端口为 `8720`，设置文件为 `./data/settings.json`。修改 `FERMATA_PORT` 时必须同步修改容器端口映射。不要把管理端口直接公开到互联网。

<a id="health"></a>
## 6. Health（健康检查）

`/healthz` 是不需要令牌的容器 liveness（存活）探针；它只证明 HTTP 进程可达：

```bash
curl --fail --silent --show-error http://127.0.0.1:8720/healthz
```

成功响应固定为：

```json
{"ok":true}
```

管理健康路由需要 `FERMATA_MANAGEMENT_TOKEN`：

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer ${FERMATA_MANAGEMENT_TOKEN}" \
  http://127.0.0.1:8720/api/v1/health
```

它返回 `workerRunning`、`activeTasks` 和固定的 `status`。`status: "ok"` 不是准确性声明；当前生产资格门仍可能阻止领取任务。

<a id="usage"></a>
## 7. Usage（使用）

首次启动且没有设置文件时，公开设置固定为 `enabled: false`、`revision: 1`。worker 可以运行，但禁用设置不会领取任务。

管理设置使用乐观锁：先读取 `revision`，再在 PUT 中带上同一个 `expectedRevision`。下面只使用合成值：

```bash
curl --fail --silent --show-error \
  -X PUT \
  -H "Authorization: Bearer ${FERMATA_MANAGEMENT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data @- \
  http://127.0.0.1:8720/api/v1/settings/public <<'JSON'
{
  "expectedRevision": 1,
  "settings": {
    "enabled": false,
    "pollingIntervalSeconds": 60,
    "maximumConcurrentTasks": 2,
    "modelProfileName": "review-balanced",
    "experimentVersion": "example-experiment-version"
  }
}
JSON
```

`POST /api/v1/actions/wake` 只请求调度器尽快轮询一次，不修改 `enabled`，不绕过版本、provider 或生产资格检查：

```bash
curl --fail --silent --show-error \
  -X POST \
  -H "Authorization: Bearer ${FERMATA_MANAGEMENT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{}' \
  http://127.0.0.1:8720/api/v1/actions/wake
```

如果设置、版本和 provider 都正确但没有任务，这是当前生产资格门固定拒绝时的预期结果，不应把它解释成模型准确或任务已处理。

<a id="api"></a>
## 8. API（接口）

### Fermata 管理接口

管理 API 的版本写在 `/api/v1` 路径中。除 `GET /healthz` 外，所有路径先检查：

```http
Authorization: Bearer $FERMATA_MANAGEMENT_TOKEN
```

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/healthz` | 无令牌 liveness；只表示 HTTP 进程可达。 |
| `GET` | `/api/v1/health` | worker 状态和已知降级条件。 |
| `GET` | `/api/v1/settings/public` | 公开设置、revision 和 `secretsConfigured`。 |
| `PUT` | `/api/v1/settings/public` | 按 `expectedRevision` 条件更新设置。 |
| `POST` | `/api/v1/actions/wake` | 尽快触发一次轮询。 |

公开设置是严格 JSON 对象，只允许 `enabled`、`pollingIntervalSeconds`、`maximumConcurrentTasks`、`modelProfileName` 和 `experimentVersion`。响应不会包含令牌、API key、数据库连接或其它内部字段。过期的 `expectedRevision` 返回 `409 CONFLICT`；未知字段不会被静默保存。

错误响应使用固定错误码，如 `INVALID_JSON`、`INVALID_BODY`、`UNAUTHENTICATED`、`NOT_FOUND`、`CONFLICT` 和 `PAYLOAD_TOO_LARGE`，不回显题面、密钥或外部服务原文。完整字段约束和 JSON 示例见 [`docs/http-api.md`](docs/http-api.md)。

### Fermata 调用的 Urmotiv 接口

这些是 Fermata 的**出站**请求，不是 Fermata 管理端口上的路由。Fermata 使用另一套 Urmotiv 机器人凭据：

```http
Authorization: Bearer $URMOTIV_ROBOT_TOKEN
X-Urmotiv-API-Version: 1
Content-Type: application/json
```

| 方法和路径 | 用途 |
| --- | --- |
| `POST /api/v1/robot/review-tasks/claim` | 领取待审任务。 |
| `POST /api/v1/robot/review-tasks/{assignmentId}/renew` | 续租任务。 |
| `POST /api/v1/robot/review-tasks/{assignmentId}/complete` | 提交通过严格 Schema 校验的结构化审核意见。 |

任务、续租和完成请求的完整字段以 [`src/urmotiv-schemas.ts`](src/urmotiv-schemas.ts) 与 [`docs/http-api.md`](docs/http-api.md) 为准。任务失败不会伪造完成结果，也不会改变 Urmotiv 的人工流程。

<a id="configuration"></a>
## 9. Configuration（配置）

所有 URL 必须是没有账号、密码、查询参数或片段的 `http://` 或 `https://` 地址。provider 的 BASE_URL 与 API key 必须同时设置或同时留空。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `URMOTIV_BASE_URL` | 无 | Urmotiv 服务基础 URL。 |
| `URMOTIV_ROBOT_TOKEN` | 无 | Fermata 出站机器人 Bearer 令牌，长度 8–4096。 |
| `FERMATA_PORT` | `8720` | 管理 HTTP 端口。 |
| `FERMATA_MANAGEMENT_TOKEN` | 无 | 管理 API Bearer 令牌，长度 16–4096。 |
| `FERMATA_SETTINGS_PATH` | `./data/settings.json` | 公开运行设置文件路径。 |
| `AETHER_BASE_URL` + `AETHER_API_KEY` | 无 | Aether 模型服务商凭据，按当前档位决定是否必需。 |
| `DASHSCOPE_BASE_URL` + `DASHSCOPE_API_KEY` | 无 | DashScope 模型服务商凭据，按当前档位决定是否必需。 |
| `CODEFORCES_KEY` + `CODEFORCES_SECRET` | 无 | 仅供离线 Codeforces 工具使用的可选凭据，必须成对设置。 |

模型 key 只在进程中使用，不写入 `settings.json`、健康响应或公开设置响应。模型档位和 `experimentVersion` 来自 `config/models.yaml`；二者不一致时，worker 不会通过启用门。

<a id="operations-and-security"></a>
## 10. Operations and Security（运维与安全）

### 运维

- 将 `/healthz` 配置为容器 liveness；用受保护的 `/api/v1/health` 观察 worker 和活动任务数。
- 通过 `docker logs --tail=100 fermata` 或受控日志系统检查固定错误码；不要把环境变量、请求头、题面、题解或模型原文写入日志。
- 将 `FERMATA_SETTINGS_PATH` 所在目录持久化，并限制 `settings.json` 访问权限；设置文件损坏时应停止并从受控备份恢复，不要自动删除重建。
- 管理设置 PUT 使用最新 `revision`，收到 `409 CONFLICT` 时重新 GET，不要覆盖其他操作员的更新。
- 机器人令牌丢失、租约过期、服务端拒绝或模型 provider 不可用时，先检查对应固定错误类别；不要把 Urmotiv 权限错误当成模型错误。
- 生产资格未有完整、受信任证据前保持 worker 领取关闭；不要把工程测试或离线报告改写成准确性结论。

### 安全

- Fermata 使用四类相互独立的凭据边界：调用 Urmotiv 的机器人令牌、访问 Fermata 管理端口的管理令牌、模型 provider key，以及仅供离线工具的可选 Codeforces 凭据。不要混用或互相转发。
- 管理接口使用常量时间 Bearer 比较；公开设置 Schema 严格拒绝未知字段，响应不返回任何 secret。
- `run-with-env.mjs` 不经过 shell 解释环境文件；目录和文件权限、路径身份、大小、UTF-8 和允许的变量都会检查。不要用 `source` 或 `.`。
- 仅在授权的 Urmotiv 机器人范围内领取、续租和提交；Fermata 不执行选手代码，不访问 Urmotiv 内部数据库。
- 离线实验使用的题面、题解、人工 gold、模型原始输出、私有清单和环境文件不进入 Git、镜像、日志或本文档。文档示例只用合成数据。

<a id="testing"></a>
## 11. Testing（测试）

测试使用注入的 HTTP、时间和模型依赖，不发起真实外部模型请求。受影响工作区从仓库根目录运行：

```bash
npm run typecheck
npm test
docker build -t fermata:verify .
```

这些命令只能证明类型、工程契约和镜像构建在当前环境成立；它们不证明审题准确性。不要为 README 或工程验证启动外部模型校准，也不要运行会读取私有题面或模型密钥的实验命令。

<a id="support"></a>
## 12. Support（支持）

请在 [GitHub Issues](https://github.com/Huasushis/Fermata/issues) 报告可复现问题。附上版本、运行模式、固定错误码和不含敏感内容的健康状态；不要提交题面、题解、模型原文、环境文件、令牌或请求头。

<a id="contributing"></a>
## 13. Contributing（贡献）

1. 从 `main` 创建主题分支，每个提交只覆盖一个可审阅的行为变化。
2. 修改 Urmotiv 契约、管理路由、鉴权、任务租约或失败边界时，同时更新对应镜像、文档和失败路径测试。
3. 保持生产资格门失败关闭，不以接口成功或少量实验结果推断准确性。
4. 运行 [Testing（测试）](#testing) 中的命令；确认 staged 文件没有私有材料、密钥、题面或模型原始输出。
5. Pull request 应写明行为、验证命令和未解决限制，不提交真实校准数据。

<a id="maintainers"></a>
## 14. Maintainers（维护者）

- [Huasushis](https://github.com/Huasushis)

<a id="license"></a>
## 15. License（许可）

本项目采用 MIT License，完整文本见 [`LICENSE`](LICENSE)。

SPDX-License-Identifier: MIT