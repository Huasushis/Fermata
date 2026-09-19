# 运行配置网页管理验收

范围：模型地址/名称/温度、模型密钥、题库地址/机器人令牌、加密持久化及任务配置快照。不修改评分提示词、难度映射或历史审核数据。

- `pnpm typecheck` 通过。
- `pnpm exec vitest run test/scorer.test.ts test/reviewer.test.ts test/settings-store.test.ts test/server.test.ts test/config.test.ts test/urmotiv-client.test.ts --maxWorkers=1 --no-file-parallelism --silent`：6 文件 150 项通过。
- 覆盖管理认证、密钥不回显、加密重启恢复、错误密钥拒绝恢复、显式清除不回退环境、版本冲突/写盘失败不改变内存、模型 HTTP 两轮实际请求字段，以及在途任务保留旧模型/凭据/客户端。
- 与 Urmotiv 契约逐字段核对；忽略 TypeScript 类型别名和空白后，新增设置 Schema 镜像一致。
- 完整 `test/` 单 worker 检查：68 文件通过、8 文件失败；1440 项通过、76 项失败。失败位于旧 review-flow 离线实验、development diagnostic/smoke、trusted-git 与 detached-calibration 测试，包括固定旧仓库路径、Git attestation 和旧请求次数/输出上限断言。没有声称完整基线通过，也没有以此声明模型准确性。

模型调用使用合成 HTTP mock，没有发送私有题面或启动新的付费标定请求。生产部署状态以运维交接记录为准。
