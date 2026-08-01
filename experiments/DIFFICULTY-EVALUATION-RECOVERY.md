# difficulty 评测异常锁恢复

`eval-difficulty` 会在 `Fermata/private/evaluation-state/` 为每个标签创建一把
`difficulty-<标签>.lock.private`。锁内只保存 PID、Linux 进程启动时钟、实验链 UUID、
原始报告编号和固定恢复规则，不含题面、题解、模型响应或密钥。

正常退出会自动移除锁。SIGKILL、服务器崩溃等不可捕获退出会故意留下锁；程序不会根据
PID 名称猜测并自动删除，以免 PID 已复用或旧模型请求其实仍在运行时重复付费。

人工恢复必须按以下顺序进行：

1. 读取该标签锁中的 `processId`、`processStartTimeTicks`、`chainRunId`、
   `originalReportRunId` 和 `chainIdentityStatus`。`checkpoint_bound` 表示锁已与持久检查点绑定；
   `provisional` 表示进程在检查点准备完成前就退出，因此不可能已经进入模型调用。这些字段可以记录
   在安全运维记录中；不要输出同目录的检查点内容。
2. 同时核对该 PID 的父进程、完整命令、`/proc/<PID>/cwd` 和
   `/proc/<PID>/stat` 第 22 字段。只有 PID 已不存在，或 PID 存在但启动时钟明确不同，并且
   没有仍属于本项目的对应评测进程时，才可认定锁已遗留。不能只凭进程名称判断。
3. 只删除核验过的那一个精确锁文件。不得删除或修改
   `difficulty-<标签>.checkpoint.private.json`，不得批量删除 `evaluation-state`。
4. 使用完全相同的数据 manifest、配置和标签重新运行。检查点中的 `succeeded` 不会重跑；
   崩溃时的 `active` 会永久计为不完整且不会重跑；只有 `pending` 会继续发起请求。

若不能证明旧 PID/启动时钟对应的进程已经退出，就保留锁并停止恢复。任何 active、499、取消、
显式失败或缺失样本都会让整个链永久 `complete=false`；人工删除锁不能清除这些证据。

## 报告组与重放

每次执行的 JSON/Markdown 文件只有在同次 `*-completion.json` 最后落盘后才构成完整报告组；
marker 会绑定 raw、summary 和 Markdown 三份文件的 SHA-256。缺 marker 的半写文件不能用于结论。
完整实验使用固定 `difficulty-chain-<chainRunId>-completion.json`，并把 marker 哈希再次封存到私有
检查点。marker 或检查点任一显示完整链已发布，后续同标签运行都会生成明确标为
`replay_blocked` 的不完整诊断，而不会产生第二份 `complete=true` 报告。
