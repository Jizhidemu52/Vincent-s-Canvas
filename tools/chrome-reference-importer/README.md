# 画布网页参考图采集（原生 Chrome MV3）

此扩展无依赖、不含第三方商业扩展代码、不需模型 Key 或服务端插件 token。只处理当前网页图片，不采视频、全站、iframe、DRM 或付费内容。

## 安装与使用

1. 在 Chrome 打开 `chrome://extensions`，启用开发者模式，点“加载已解压的扩展程序”，选择本目录。不会修改 Chrome 策略、已有账号或其他扩展。
2. 先在同一 Chrome 登录画布（企业用户按原 OA 流程进入）。打开参考网页，点击扩展图标，新建的采集标签页扫描该页的 `img.currentSrc` 和 CSS 背景图。最多列出 500 个 URL、最多检查 5000 个 DOM 元素，不自动滚动加载。
3. 填写自己的画布 origin，例如 `http://192.168.1.115:5188`。地址可更换；本机/可信私有 IPv4 内网允许 HTTP，其他地址要求 HTTPS。HTTP 不提供传输加密，仅用于可信网络。
4. 勾选 1–20 张图片，点击“授权并送到画布审核”。Chrome 仅请求目标画布与本次所选图片域名权限；授权模式不能限制端口，这是 Chrome host permission 的限制。不默认请求所有站点。
5. `/reference-import` 收到的是内存草稿，核对图片、来源、当前员工，点击“确认导入”才进入素材库。入库后可按现有素材库流程使用。原始二进制保留，GIF 不转换静态图。

扩展配置只持久化画布 origin，不保存图片/来源列表/登录信息。采集和审核页关闭或刷新会丢失草稿。可以撤销所有已授予站点权限。

## 限制与错误

- 单张 10 MiB、每批最多 20 张/30 MiB；按字节签名只接受 PNG/JPEG/WebP/GIF。URL 与原始内容分别去重；同一审核草稿重试使用固定 `clientReferenceId`，已成功项不会重复上传。
- 只读取公开可访问 HTTP/HTTPS 图片；`credentials: omit`、无 referrer、拒绝重定向。需要 Cookie、防盗链 referrer、跳转、`data:`/`blob:`、iframe 的图会失败或不显示，不绕过限制。浏览器预览请求不等于成功读取原字节。
- 扩展取消会终止下载并停止后续发送；审核页取消停止后续上传。当前已经开始的现有上传 API 不支持 AbortSignal，可能完成；页面会明确显示结果，不承诺撤回已保存内容。
- 审核页逐张校验当前服务端会话，上传带 `expectedOwnerId`。任何上传/身份错误都会停止后续项。成功与失败逐项显示，网络恢复后可重试。
- 来源 URL 删除所有 query/hash/userinfo 后才送入 metadata；URL 路径和页面标题仍可能包含业务信息，导入前应人工核对。浏览器访问源 URL 本身仍使用其原始 query，以便读取原字节。

## 消息契约

扩展只对用户配置且授权的 origin、`/reference-import` 标签页注入隔离脚本。随机 UUID 放在目标页 fragment 的 `referenceNonce`，仅同源 `window.postMessage` 传递：

```js
{ channel: "canvas-reference-import/v1", nonce, requestId, type: "hello" | "image",
  image: { id, name, mime, base64, sourcePage, sourceImage, pageTitle } }
// 审核页回执
{ channel: "canvas-reference-import/v1", nonce, requestId, type: "ack", ok, error }
```

两端校验 `event.source === window`、精确 origin、nonce、requestId；图片校验字段、大小、数量及魔数。逐张发送/回执，未响应不会声称成功。nonce 防止串批和误消息，不替代同源页面的信任边界；同源 XSS 不在本协议可防御范围内。消息不接受 owner、API URL 或 upload URL，无长期后台监听、`externally_connectable`、全局 CORS 或服务器任意 URL 抓取。

## 本地打包与检查

无需编译。Windows PowerShell 在项目根目录执行：

```powershell
Compress-Archive -Path tools/chrome-reference-importer/manifest.json,tools/chrome-reference-importer/background.js,tools/chrome-reference-importer/collector.js,tools/chrome-reference-importer/protocol.js,tools/chrome-reference-importer/collector.html,tools/chrome-reference-importer/collector.css,tools/chrome-reference-importer/README.md -DestinationPath chrome-reference-importer.zip
bun test web/tests/reference-import.test.ts tools/chrome-reference-importer/protocol.test.js
```

首次打包输出 ZIP；如已存在请换一个输出名以保留原文件。解压后加载扩展目录，ZIP 不会静默安装。

浏览器冒烟脚本 `smoke.mjs` 使用独立临时 Chromium profile，见脚本顶部参数；不会接触用户 Chrome 会话。它复制本目录到临时文件夹，仅在该测试副本的 manifest 中预授权两个 localhost fixture 来源，因为 headless 无法操作 Chrome 原生可选权限弹窗；生产 manifest 不受修改。扫描、扩展 fetch、注入/回执、网页审核均为真实浏览器执行，认证和上传 API 使用测试响应并核对原字节、员工绑定和失败重试。截图输出到项目 `output/reference-import-smoke/`，自动清理测试副本/profile。测试不调用付费模型。原生权限弹窗、工具栏 activeTab 手势、真实企业 OA 与公网防盗链图片需另行验收。
