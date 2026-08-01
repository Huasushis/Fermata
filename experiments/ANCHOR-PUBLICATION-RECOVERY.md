# 正式难度锚点发布锁恢复

`experiments/calibrate-anchors.ts` 在第一笔付费请求前取得一把与实验标签无关的锁，并持有到正式锚点发布和审计写完。固定锁文件是：

`private/anchor-publication/difficulty-anchors-publication.lock.private`

锁存在时，新一轮标定一律失败退出。程序不会按 PID 是否存在、锁的年龄或记录能否解析来自动删锁；损坏记录也会 fail-closed。

锁记录只含安全元数据：PID、Linux 进程启动时钟、runId、目标锚点指纹、取得时间、固定命令类型、完整命令行与工作目录的 SHA-256，以及恢复规则。它不含题面、题解、模型回答、密钥或配置值。

## 人工核验

只在服务器交互终端核验，不把完整命令、环境、路径或进程输出复制进 Git、报告、日志或聊天。

1. 只读上述一个固定锁文件，记下 `processId`、`processStartTimeTicks`、`processCommandFingerprint` 和 `expectedWorkingDirectoryFingerprint`。不要扫描或批量处理 `private/`。
2. 核对该 PID 是否仍存在，并检查它的父进程。按 `/proc/<PID>/stat` 最后一个右括号之后解析字段：右括号后的第 20 个字段才是原始 stat 的第 22 字段 `starttime`。它必须逐字等于锁记录的 `processStartTimeTicks`，不能只比较 PID。
3. 读取 `/proc/<PID>/cmdline` 的完整 NUL 分隔字节，确认它确实是 Fermata 的 `calibrate-anchors.ts` 标定进程；这些原始字节的 SHA-256 必须等于 `processCommandFingerprint`。不得按 `node`、`tsx` 等进程名批量判断或结束进程。
4. 核对 `/proc/<PID>/cwd` 的规范路径确实是本项目 Fermata 工作目录。锁中的工作目录指纹是“规范路径 UTF-8 字节（不附加换行）”的 SHA-256；必须与 `expectedWorkingDirectoryFingerprint` 一致。
5. 同时检查父进程、完整命令和当前工作目录，确认没有仍属于 `/home/ubuntu/codex-urmotiv/Fermata` 的锚点标定进程。身份相符或仍有疑问时保留锁，不得删除，也不得结束进程。

只有在下列条件全部成立时，才可以人工移除这一个精确锁文件：锁内 PID 已不存在，或 PID 存在但启动时钟不一致；并且已经按完整命令、父进程与工作目录确认没有本项目锚点标定进程。移除后先重新运行不调用模型的预检和测试，再决定是否发起新的付费标定。

不要删除整个 `anchor-publication` 目录，不要批量删除 `.lock.private`、检查点或报告，也不要批量结束 Node.js、Python 或 pnpm 进程。崩溃前已产生的审计和快照应原样保留。
