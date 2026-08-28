# Fermata 管理 HTTP API（v1）

本文档描述 Fermata 自己监听的管理端口。API（应用程序编程接口）版本写在路径 `/api/v1` 中；当前没有其它管理 API 版本。完整实现见 [`src/server.ts`](../src/server.ts)，字段镜像和 Zod（运行时数据校验库）Schema 见 [`src/urmotiv-schemas.ts`](../src/urmotiv-schemas.ts)。

这组路由用于运维和 Urmotiv 的 `fermata-control` 插件，不是普通用户接口，也不是模型推理接口。管理 API 返回成功只表示管理操作或进程状态满足协议，**不表示审题评分准确**。

## 基本约定

- 默认地址：`http://127.0.0.1:8720`。端口由 `FERMATA_PORT` 控制。
- 请求和响应使用 UTF-8 JSON（结构化文本格式）；`Content-Type` 为 `application/json; charset=utf-8`。
- 除 `GET /healthz` 外，所有路径先检查管理令牌：
  其中 `Bearer` 表示“持有者令牌”认证方案；令牌由部署环境注入，不要把值写入文档或命令历史。

  ```http
  Authorization: Bearer $FERMATA_MANAGEMENT_TOKEN
  ```

  `$FERMATA_MANAGEMENT_TOKEN` 表示由部署环境注入当前调用进程的变量，不是要写进文档或命令历史的字面值。
- 管理请求体最大 64,000 字节；响应体最大 512,000 字节。超限分别返回 `413 PAYLOAD_TOO_LARGE` 或内部错误。
- 未知路径在鉴权之后返回 `404 NOT_FOUND`。缺少或无效令牌返回 `401 UNAUTHENTICATED`，不会泄露路径存在性。

## 路由一览

| 方法 | 路径 | 令牌 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/healthz` | 不需要 | 容器 liveness（存活）探测；只说明 HTTP 进程可达。 |
| `GET` | `/api/v1/health` | 需要 | 读取 worker（后台轮询进程）状态和当前已知降级条件。 |
| `GET` | `/api/v1/settings/public` | 需要 | 读取公开运行设置、revision（乐观锁版本号）和 provider（模型服务商）凭据是否齐全的布尔值。 |
| `PUT` | `/api/v1/settings/public` | 需要 | 使用 revision 条件更新公开运行设置。 |
| `POST` | `/api/v1/actions/wake` | 需要 | 跳过当前等待，立即触发一次轮询；不修改设置、不绕过生产资格门。 |

## `GET /healthz`

无需令牌：

```bash
curl --fail-with-body --silent --show-error \
  http://127.0.0.1:8720/healthz
```

成功状态为 `200`，响应固定为：

```json
{"ok":true}
```

该路由不读取管理令牌、provider 密钥、Urmotiv 状态或评分结果。它适合 Docker 或反向代理的 liveness 检查；不能用来判断 worker 已启用、能否领取任务或评分准确性。

## `GET /api/v1/health`

需要管理令牌：

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${FERMATA_MANAGEMENT_TOKEN}" \
  http://127.0.0.1:8720/api/v1/health
```

成功状态为 `200`。响应示例使用合成状态值，不包含题目、模型输出或任何凭据：

```json
{
  "status": "ok",
  "service": "fermata",
  "apiVersion": "1",
  "workerRunning": true,
  "activeTasks": 0,
  "checkedAt": "2030-01-01T00:00:00.000Z"
}
```

字段含义：

- `status`：`ok` 或 `degraded`。当前实现只在“设置要求启用但 worker 未运行”或“当前设置选择的模型档位缺 provider 凭据”时标记 `degraded`。
- `service`：固定为 `fermata`。
- `apiVersion`：固定为字符串 `"1"`。
- `workerRunning`：调度循环是否已启动；禁用设置时它仍可能为 `true`。
- `activeTasks`：当前正在处理的任务数，非负整数。
- `checkedAt`：生成响应时的 ISO 8601 日期时间。

`status: "ok"` 不检查生产资格证据，也不测量人工标准上的准确率。当前版本的生产资格验证器固定拒绝，因而 `workerRunning: true` 与 `activeTasks: 0` 可以同时出现。

## `GET /api/v1/settings/public`

需要管理令牌：

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${FERMATA_MANAGEMENT_TOKEN}" \
  http://127.0.0.1:8720/api/v1/settings/public
```

成功状态为 `200`。响应示例：

```json
{
  "settings": {
    "enabled": false,
    "pollingIntervalSeconds": 30,
    "maximumConcurrentTasks": 2,
    "modelProfileName": "review-balanced",
    "experimentVersion": "example-experiment-version"
  },
  "revision": 1,
  "secretsConfigured": true
}
```

- `settings` 只包含公开运行设置，不包含任何令牌、API key、URL 凭据或数据库信息。
- `revision` 是正整数。每次成功更新后加 1。
- `secretsConfigured` 只表示当前 `modelProfileName` 所需的 provider 凭据是否已在进程环境中成对配置；`true` 不表示模型响应正确或生产资格已通过。

## `PUT /api/v1/settings/public`

使用最新的 `revision` 进行条件写入：

```bash
curl --fail-with-body --silent --show-error \
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

成功状态为 `200`，响应是更新后的完整 settings 响应。例如上例会返回 `revision: 2`（其它字段与请求中实际值一致）。

请求体严格要求只有以下两个键：`expectedRevision` 和 `settings`。`settings` 也必须严格只包含下表字段：

| 字段 | JSON 类型和范围 | 说明 |
| --- | --- | --- |
| `enabled` | boolean | 是否请求 worker 进入启用检查。当前版本仍会被生产资格门拦截。 |
| `pollingIntervalSeconds` | integer，5–3600 | 两次轮询之间的秒数。 |
| `maximumConcurrentTasks` | integer，1–32 | 并行在途任务上限。 |
| `modelProfileName` | 去除首尾空白的字符串，1–120 字符 | `config/models.yaml` 中存在的档位名。 |
| `experimentVersion` | 去除首尾空白的字符串，1–120 字符 | 必须与当前 `models.yaml` 版本完全一致，才有机会通过设置门。 |

设置 Schema 是 strict（严格对象）：未知字段（例如 `modelApiKey`）会返回 `400 INVALID_BODY`，不会被忽略或保存。`expectedRevision` 不是当前值时返回 `409 CONFLICT`，服务端不做任何修改。

## `POST /api/v1/actions/wake`

需要管理令牌。推荐发送空 JSON 对象：

```bash
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer ${FERMATA_MANAGEMENT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{}' \
  http://127.0.0.1:8720/api/v1/actions/wake
```

成功状态为 `200`，响应固定为：

```json
{"ok":true}
```

该动作只要求当前调度器尽快开始一次轮询；它不会修改 `enabled`，不会增加并发上限，不会绕过 `experimentVersion`、provider 或生产资格检查。服务处于禁用状态时，动作仍可返回成功，但本轮会在禁用门返回，不会领取任务。

## 错误响应

错误响应使用统一外层结构；`fieldErrors` 只在 `INVALID_BODY` 时出现，键名是校验失败的字段路径：

```json
{
  "error": {
    "code": "INVALID_BODY",
    "message": "请求体不满足要求。",
    "fieldErrors": {
      "settings.pollingIntervalSeconds": ["字段值不符合范围。"]
    }
  }
}
```

常见状态和固定错误码：

| HTTP 状态 | `error.code` | 触发条件 |
| ---: | --- | --- |
| 400 | `INVALID_JSON` | 请求体不是合法 JSON。 |
| 400 | `INVALID_BODY` | JSON 可解析，但不符合严格 Schema。 |
| 400 | `REQUEST_ERROR` | 读取请求体时连接出错。 |
| 401 | `UNAUTHENTICATED` | 缺少或无效的管理令牌。 |
| 404 | `NOT_FOUND` | 鉴权成功后仍未找到路由。 |
| 409 | `CONFLICT` | PUT 使用了过期的 `expectedRevision`。 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超过 64,000 字节。 |
| 500 | `INTERNAL_ERROR` | 服务端未预期的内部错误。 |

## 可机器校验的管理 Schema

下面的 JSON Schema（字段、类型和范围的机器可读规则）与当前 [`src/urmotiv-schemas.ts`](../src/urmotiv-schemas.ts) 中的 `fermataHealthSchema`、`fermataPublicSettingsSchema`、`fermataPublicSettingsResponseSchema` 和 `updateFermataPublicSettingsInputSchema` 对齐。运行时以 Zod 校验为准；Schema 示例本身不包含密钥。

### Health

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:fermata:health:v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["status", "service", "apiVersion", "workerRunning", "activeTasks", "checkedAt"],
  "properties": {
    "status": { "type": "string", "enum": ["ok", "degraded"] },
    "service": { "const": "fermata" },
    "apiVersion": { "const": "1" },
    "workerRunning": { "type": "boolean" },
    "activeTasks": { "type": "integer", "minimum": 0 },
    "checkedAt": { "type": "string", "format": "date-time" }
  }
}
```

### Public settings

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:fermata:public-settings:v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["enabled", "pollingIntervalSeconds", "maximumConcurrentTasks", "modelProfileName", "experimentVersion"],
  "properties": {
    "enabled": { "type": "boolean" },
    "pollingIntervalSeconds": { "type": "integer", "minimum": 5, "maximum": 3600 },
    "maximumConcurrentTasks": { "type": "integer", "minimum": 1, "maximum": 32 },
    "modelProfileName": { "type": "string", "minLength": 1, "maxLength": 120 },
    "experimentVersion": { "type": "string", "minLength": 1, "maxLength": 120 }
  }
}
```

### Public settings response

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:fermata:public-settings-response:v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["settings", "revision", "secretsConfigured"],
  "properties": {
    "settings": {
      "$ref": "urn:fermata:public-settings:v1"
    },
    "revision": { "type": "integer", "minimum": 1 },
    "secretsConfigured": { "type": "boolean" }
  }
}
```

### Settings update input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:fermata:settings-update:v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["expectedRevision", "settings"],
  "properties": {
    "expectedRevision": { "type": "integer", "minimum": 1 },
    "settings": { "$ref": "urn:fermata:public-settings:v1" }
  }
}
```

## Fermata 调用的 Urmotiv 机器人 API

以下是**出站**接口：Fermata 是客户端，Urmotiv 是服务端；这些路径不是 Fermata 管理端口上的路由。它们都使用 `URMOTIV_BASE_URL` 和另一套机器人令牌：

```http
Authorization: Bearer $URMOTIV_ROBOT_TOKEN
X-Urmotiv-API-Version: 1
Content-Type: application/json
```

| 方法和路径 | 请求要点 | 成功响应要点 |
| --- | --- | --- |
| `POST /api/v1/robot/review-tasks/claim` | `maximumTasks` 为 1–10；`leaseSeconds` 为 30–1800；可选 `supportedProblemTypes`。 | `{ "items": [...] }`，任务完整结构由 `robotReviewTaskSchema` 校验。 |
| `POST /api/v1/robot/review-tasks/{assignmentId}/renew` | `requestId` 为 UUID、`expectedLeaseExpiresAt` 为日期时间、`leaseSeconds` 为 30–1800。 | `assignmentId` 和新的 `leaseExpiresAt`。 |
| `POST /api/v1/robot/review-tasks/{assignmentId}/complete` | 带请求标识、租约/题目/tag catalog（标签目录）版本、实验版本、模型档位和 `review`。 | `accepted: true` 以及 `problemStatus`。 |

`claim` 省略字段时，服务端镜像会补默认值 `maximumTasks: 1`、`leaseSeconds: 300`；`supportedProblemTypes` 的值只能是 `traditional`、`interactive` 或 `submit_answer`。`complete` 成功响应的 `problemStatus` 只能是 `pending_review`、`approved` 或 `rejected`。

`complete` 的 `review` 必须通过 Urmotiv 审核输入 Schema：`verdict` 为 `approve`、`request_changes` 或 `reject`；`codeforcesDifficulty` 为 800–3500 的整百；`qualityLevel`、`thinkingLevel`、`codingLevel` 为 1–5；`originalityLevel` 可省略或为 null/1–5；`tagIds` 为 1–30 个非空字符串；`improvements` 为 1–20,000 字符的非空文本；`publicComment` 和 `privateNote` 最多 20,000 字符；`expectedRound` 为正整数。不要把题面、题解或模型原文写进运维文档。

Fermata 在本地先按严格镜像校验请求和响应；具体字段以 [`src/urmotiv-schemas.ts`](../src/urmotiv-schemas.ts) 的 `robotReviewTaskSchema`、`completeRobotReviewTaskInputSchema` 等定义为准。任务处理失败不会让 Fermata 伪造完成结果，也不会改变 Urmotiv 的人工流程。

续租和完成请求在满足租约安全预算时只对网络错误、429 和 5xx 做有界重试，并复用同一个请求标识和请求体；确定性的 4xx 或响应契约错误不会自动重试。详见 [`src/urmotiv-client.ts`](../src/urmotiv-client.ts)。

## 数据和服务边界

- Fermata 不连接 Urmotiv 的 PostgreSQL、Redis、对象存储或内部文件目录。题目、权限、审核状态和最终持久化由 Urmotiv 管理。
- Anklang 只作为 Urmotiv 任务中经过认证的相似题检索证据出现；Fermata 不把 Anklang 当作工作流或审核状态权威，不直接调用其数据库。相似度证据不能单独推出 Fermata 的评分准确性。
- 管理 API 的 `secretsConfigured` 只是布尔状态；它不返回 provider 地址中的凭据、不返回 API key，也不表示模型服务可用或判断结果正确。

## 相关文件

- 启动和环境变量：[`README.md`](../README.md)、[`.env.example`](../.env.example)
- 管理端实现：[`src/server.ts`](../src/server.ts)
- Schema 镜像：[`src/urmotiv-schemas.ts`](../src/urmotiv-schemas.ts)
- 设置门和当前生产资格状态：[`src/reviewer-activation.ts`](../src/reviewer-activation.ts)、[`src/production-eligibility.ts`](../src/production-eligibility.ts)
