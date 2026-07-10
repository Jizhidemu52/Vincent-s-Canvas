# 无线画布生产部署与验收

## 1. 服务器准备

建议准备一台安装了 Docker Engine 与 Docker Compose 的 Linux 服务器。正式环境仅向公网开放 Nginx 的 `3000` 端口，再由公司域名和 HTTPS 网关反向代理。PostgreSQL、Redis、MinIO、API 和 Worker 不应直接暴露到公网。

```bash
git clone https://github.com/Jizhidemu52/Vincent-s-Canvas.git
cd Vincent-s-Canvas
cp .env.example .env
```

编辑 `.env`，至少替换：

- `POSTGRES_PASSWORD`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `MFA_ENCRYPTION_KEY`
- `PROVIDER_ENCRYPTION_KEY`
- `S3_SECRET_ACCESS_KEY`

两把加密密钥必须分别生成，不能相同：

```bash
openssl rand -base64 32
openssl rand -base64 32
```

## 2. 启动

```bash
docker compose up -d --build
docker compose ps
curl http://localhost:3000/api/health
```

首次启动会自动执行 PostgreSQL 迁移、创建 MinIO Bucket、启用对象版本保护，并创建首位超级管理员。

打开 `http://服务器地址:3000/admin/login`：

1. 使用 `.env` 中的超级管理员账号和初始密码登录。
2. 按页面要求修改密码。
3. 在验证器中录入 MFA 密钥并输入六位动态码。
4. 成功后从 `.env` 删除 `BOOTSTRAP_ADMIN_PASSWORD`。

## 3. 开通设计师

进入 `后台管理 -> 账号额度`：

1. 先创建部门。
2. 单独创建账号，或下载 CSV 模板批量导入。
3. 登录账号可使用中文、英文、邮箱或工号。
4. 设置设计师所属部门、初始积分和额度上限。
5. 新账号首次密码登录必须修改密码。

部门管理员只能管理本部门设计师。超级管理员负责部门、Provider、模型、工作流和全局价格。

## 4. 企业微信

在企业微信管理后台创建自建应用，把可信回调地址设置为：

```text
https://你的域名/api/auth/wecom/callback
```

将 Corp ID、Agent ID 和 Secret 写入 `.env`：

```dotenv
WECOM_CORP_ID=
WECOM_AGENT_ID=
WECOM_SECRET=
WECOM_CALLBACK_URL=https://你的域名/api/auth/wecom/callback
```

重启 API：

```bash
docker compose up -d api
```

企业微信成员的 User ID 应与账号工号一致，首次扫码后系统会绑定不可变内部用户 ID。

## 5. Provider、工作流和模型

配置顺序：

1. 在 `API Provider` 新建 Provider，填写 Base URL 和 API Key。
2. API Key 由后端加密保存，浏览器只显示“已配置”。
3. 在 `工作流管理` 配置 RunningHub、ComfyUI 或自定义工作流。
4. 填写提交 JSON 模板、任务 ID 路径、状态路径和结果路径。
5. 在 `模型 API` 新建模型，并按需绑定工作流。
6. 配置模型积分、人民币成本和并发上限。
7. 在 `积分价格` 创建草稿，测试后发布。

模板变量：

```text
$prompt       提示词
$sourceUrls   公司素材地址数组
$workflowId   工作流 ID
$modelId      模型 ID
$apiKey       服务端 Provider API Key
```

设计师端只会收到模型名称、能力、积分、价格和启用状态。

## 6. 模拟出图验收

首次验收可在 `.env` 设置：

```dotenv
TASK_MOCK_MODE=true
```

```bash
docker compose up -d api worker
```

设计师点击生成后会经历真实的任务排队、积分冻结、Worker 执行、素材入库和成功结算，只是不调用外部模型。确认流程后必须把 `TASK_MOCK_MODE` 改回 `false`。

## 7. 备份与恢复

`backup` 容器每 15 分钟执行一次压缩 `pg_dump`，保存到 MinIO 的 `backups/postgres/`。MinIO Bucket 已启用版本保护。

查看备份日志：

```bash
docker compose logs --tail=100 backup
```

恢复前先停止 API 和 Worker：

```bash
docker compose stop api worker
docker compose run --rm backup restore.sh backups/postgres/20260710T120000Z.dump
docker compose up -d api worker
```

每季度至少执行一次恢复演练，并记录恢复耗时。验收目标为 RPO 不超过 15 分钟、RTO 不超过 4 小时。

## 8. 40 人并发验收

在测试环境创建 40 个设计师账号并准备各自的 Session Cookie，然后运行：

```bash
k6 run \
  -e BASE_URL=https://测试域名 \
  -e MODEL_CONFIG_ID=模型UUID \
  -e 'SESSION_COOKIES=["wireless_canvas_session=...","wireless_canvas_session=..."]' \
  ops/load/k6-40-submitters.js
```

通过条件：

- 40 个设计师持续提交 2 分钟。
- API 请求失败率低于 1%。
- 提交接口 P95 小于 1.5 秒。
- 相同 `requestId` 不重复冻结或扣费。
- 失败、取消和超时任务释放积分。
- 批量任务单张失败不影响其他图片。
- PostgreSQL、Redis、MinIO 和 Worker 无崩溃或数据串用。

## 9. 上线检查

```bash
docker compose ps
docker compose logs --tail=200 api worker postgres redis minio backup
curl https://正式域名/api/health
```

确认 HTTPS、MFA、企业微信回调、备份、审计导出、素材隔离和额度结算后，再从 10 位试点设计师逐步开放到约 100 人。
