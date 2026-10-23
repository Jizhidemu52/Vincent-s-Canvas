# 数据库与媒体的外部备份

入口为 `backup.sh` / `restore.sh`，由 `archive.py` 调用官方 PostgreSQL、MinIO `mc` 和 `age` 工具。脚本不会读取前端凭据，不会删除源对象，也不会执行 `mirror --remove`、自动清理旧备份或恢复“最新”快照。

## 备份覆盖和一致性边界

每次备份创建唯一的 `<UTC时间>-<随机ID>`，目录为：

```text
<BACKUP_PREFIX>/snapshots/<snapshot>/
  db.dump.age
  manifest.json.age
  media/<原始字节的SHA256>
  COMPLETE.json
```

- `pg_dump` 与媒体引用清单使用同一个 `pg_export_snapshot()` 的只读、可重复读快照。导出事务保持到两个读取者完成，因此数据库 dump 与清单对应同一个数据库状态。
- 清单包括全部 `status='ready'` 的素材原件（包括尚在数据库里的软删除素材）、已登记缩略图和独立的 `design_library_images` 原件。`pending`/`failed` 上传记录不承诺有文件；数据库以外的孤立文件、旧对象版本、数据库集群角色及服务器配置不在本快照内。
- 每个必需对象先读取、核对数据库记录的字节数，再复制到外部 bucket；重新读取外部对象计算 SHA-256。任何缺失、复制失败或不一致都会退出非零，且不发布完成标志。
- 数据库直接通过匿名管道送给 `age`，未加密 dump 不落盘、不上传。清单也经过 `age` 加密。只有全部媒体和两个加密文件回读校验完成，才最后写入 `COMPLETE.json`。
- 媒体保留原始字节，不转码；媒体本身未使用 `age` 加密，外部 bucket 必须配置访问控制、传输保护及服务端静态加密。`COMPLETE.json` 只含快照编号、数量、加密文件摘要和一致性标记，不含账号、对象路径或凭据。

**这不是数据库与 S3 的原子联合快照。** S3 读取发生在数据库快照之后；在线期间删除、改写对象可能导致本次失败，同尺寸改写无法仅凭数据库的 `byte_size` 判定它属于哪个历史时点。完成标志承诺“该数据库快照引用的对象已逐项复制并验证”，不承诺跨系统同一时间点。标记固定为 `postgres-snapshot-with-online-reference-verification`，不得宣传成原子备份。

如需严格联合恢复点：先阻止新请求并停止 API/所有其他写入方；让 Worker 按停止宽限排空已有任务，确认没有上传、生成保存、缩略图和清理写入；保持 PostgreSQL/对象存储运行；执行一次备份；看到对应 `backup.completed` 后才恢复业务。脚本不能替操作者证明所有写入方都已停机。

## 配置

源环境沿用 `DATABASE_URL`、`S3_ENDPOINT`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`。

| 变量 | 说明 |
| --- | --- |
| `BACKUP_S3_ENDPOINT` | 必填，独立外部 S3/MinIO endpoint；不提供默认值，拒绝与源相同 hostname（包括不同端口）。不同域名不等于真正独立，运维仍须确认不在同一磁盘/主机故障域。 |
| `BACKUP_S3_BUCKET` | 必填，预先创建的专用备份 bucket。 |
| `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | 必填，只赋予所需读/写权限；备份流程无需删除权限。 |
| `BACKUP_AGE_RECIPIENT` | 必填，离线保管私钥对应的 `age1…` 公钥。私钥不要挂入定时备份容器。 |
| `BACKUP_PREFIX` | 默认 `canvas`，不接受空路径或 `..`。 |
| `BACKUP_RUN_ONCE` | `true` 只执行一次；默认循环运行。 |
| `BACKUP_INTERVAL_SECONDS` | 默认 `900`，最少 `60`；以上一轮成功完成为间隔起点。失败直接退出非零。 |
| `BACKUP_FAILURE_WEBHOOK_URL` | 可选 HTTPS 地址；失败仅发送固定事件和失败阶段，不发送 SQL、对象路径、工具原始错误或 Key。告警失败不能将备份改记为成功。 |

源账号需要读取数据库、素材和缩略图；目标账号需要写入及回读校验。凭据通过进程环境传入，不通过 `mc alias set` 或带密码的命令参数传入。不要用 shell `set -x` 执行，也不要输出容器环境。

容器镜像安装官方仓库的 `age` 与 PostgreSQL 17 客户端，并沿用本项目固定源码版本构建的 `mc`。不要在运行时下载不明二进制。S3 bucket 必须预先创建；脚本不会自动修改 bucket ACL、版本或生命周期配置。

旧 `BACKUP_RETENTION_DAYS` 不再生效。由备份服务端配置包含 current/noncurrent versions 和未完成上传的生命周期策略，并结合离线/不可变保留要求；本脚本不传播源删除、不删除历史快照。不含 `COMPLETE.json` 的前缀属于失败或中断的暂存，不能拿来恢复。

一次性执行（先通过受保护的环境/secret 注入上述变量）：

```bash
BACKUP_RUN_ONCE=true /usr/local/bin/backup.sh
```

## 恢复：先验证、再写入

恢复**仅在明确指定快照**且两个确认变量均为 `true` 时允许执行：

```bash
RESTORE_ALLOW_DESTRUCTIVE=true \
RESTORE_WRITES_STOPPED=true \
BACKUP_AGE_IDENTITY_FILE=/run/secrets/backup-age-identity \
/usr/local/bin/restore.sh 20261024T120000Z-example01234
```

上述命令只是格式示例，不是现有可恢复快照。`DATABASE_URL` 和 `S3_*` 此时指向**恢复目标**；`BACKUP_S3_*` 指向外部备份源。私钥文件需只读挂载，并且其权限只允许恢复操作者读取。推荐恢复到新的空数据库及 bucket；务必保持所有业务写入方停止。

恢复先读取完成标志，核对快照身份与加密文件摘要，解密 dump/清单，下载并校验全部媒体，再用 `pg_restore --list` 预检。任何预检失败都不得写入目标媒体或数据库。全部预检通过后才按原 object key 上传媒体、重新校验，并执行 `pg_restore --clean --if-exists --single-transaction --exit-on-error`。

恢复会覆盖清单内的同名目标对象并重建 dump 中的数据库对象，但不删除目标 bucket 的额外对象。媒体写入和数据库恢复仍不是跨系统事务；数据库恢复失败时，已经写入的媒体不会自动撤销，因此优先使用新目标，失败后保持停写并处理。不要在正在使用的数据库上尝试恢复。dump 可能包含数据库超级用户定义的 SQL，仅恢复可信来源。

备份暂存空间约为加密 dump、清单和一个最大媒体文件；恢复预检需要存放解密 dump 与**全部媒体**，应按数据量提供足够受保护的临时磁盘。私钥损失即无法解密，必须另行离线保管和演练。

完成后检查账号隔离、模型配置、素材原图/视频和画布引用，再让 Worker 重建队列并恢复业务。Redis、容器环境、Provider 加密主密钥、TLS 证书及浏览器本地未同步数据不在该备份内，应按各自安全策略单独保管；数据库里的 Provider 密文需要原 `PROVIDER_ENCRYPTION_KEY` 才可使用。

## 验证

`bun test tests/backup-archive.test.ts`（在 `server/` 内）使用隔离工具替身测试 shell 入口、同一快照参数、加密管道、缺媒体/校验失败、不删除源和恢复确认门槛。这不能替代 PostgreSQL + 两个独立 MinIO + 真 `age` 的联合恢复演练；后者由部署 CI/隔离环境验证，不得对线上数据执行。

参考：[PostgreSQL 快照同步](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION)、[pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)、[age 官方工具](https://github.com/FiloSottile/age)、[MinIO mc cp](https://docs.min.io/aistor/reference/cli/mc-cp/)。
