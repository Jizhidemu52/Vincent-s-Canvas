import type { Page } from "@playwright/test";
import { test, expect, IMAGE } from "./fixtures";

async function chatModels(page: Page) {
    await page.route("**/api/models", route => route.fulfill({ json: { models: [
        { id: "chat", modelId: "gpt-6-astra", name: "隔离对话", capabilities: ["chat", "vision"] },
        { id: "image", modelId: "gpt-image-2", name: "隔离图片", capabilities: ["generate", "edit"] },
    ], prices: [], tools: [{ toolKey: "gpt-chat", enabled: true, modelConfigId: "chat", configurationVersion: 1 }, { toolKey: "gpt-chat-image", enabled: true, modelConfigId: "image", configurationVersion: 1 }] } }));
}

test("asset copy feedback is bound to its asset, lasts 1200ms and retains clipboard failures", async ({ page, context, api }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const assets = ["A", "B"].map(id => ({ id: `text-${id}`, kind: "text", filename: `${id}.txt`, mimeType: "text/plain", byteSize: 10,
        ownerUserId: "00000000-0000-4000-8000-000000000099", source: "upload", status: "ready", createdAt: "2026-11-13T00:00:00Z",
        metadata: { title: `文本${id}`, content: `原文 ${id}\n保持换行`, tags: [] }, visibilityScope: "private" }));
    await page.route("**/api/assets**", route => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({ json: path === "/api/assets" ? { assets, hasMore: false, nextCursor: null } : { asset: assets.find(asset => path === `/api/assets/${asset.id}`) } });
    });
    await page.goto("/assets");
    const card = (title: string) => page.locator(".ant-card").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
    await card("文本A").getByRole("button", { name: /^查\s*看$/ }).click();
    const drawer = page.getByRole("dialog", { name: "素材详情", exact: true });
    const copy = drawer.getByRole("button", { name: "复制文本", exact: true });
    await page.clock.install(); await page.clock.pauseAt(new Date());
    await copy.click(); await expect(copy).toHaveText("已复制 ✓");
    expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe("原文 A\n保持换行");
    await expect(card("文本A").getByRole("status")).toHaveText("已复制 ✓");
    await expect(card("文本B").getByRole("status")).toHaveCount(0);
    await page.clock.runFor(1199); await expect(copy).toHaveText("已复制 ✓");
    await page.clock.runFor(1); await expect(copy).toHaveText("复制文本");
    await expect(card("文本A").getByRole("status")).toHaveCount(0);
    await page.clock.resume();
    await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    await card("文本B").getByRole("button", { name: /^查\s*看$/ }).click();
    await expect(copy).toHaveText("复制文本");
    await copy.click(); await expect(copy).toHaveText("已复制 ✓");
    await expect(card("文本A").getByRole("status")).toHaveCount(0);
    await expect(card("文本B").getByRole("status")).toHaveText("已复制 ✓");
    await expect(page.locator(".ant-message-success")).toHaveCount(0);
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new DOMException("denied", "NotAllowedError"); }; document.execCommand = () => false; window.prompt = () => null; });
    await copy.click();
    await expect(copy).toHaveText("复制文本");
    await expect(page.getByText("复制失败，请检查浏览器剪贴板权限后重试", { exact: true })).toBeVisible();
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("asset required image error is inline, clears on file choice and empty export explains why", async ({ page, api }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/assets");
    await page.getByRole("button", { name: "更多筛选", exact: true }).click();
    const exportButton = page.getByRole("button", { name: "导出全部筛选素材", exact: true });
    await expect(exportButton).toBeDisabled(); await exportButton.hover({ force: true });
    await expect(page.locator(".ant-tooltip:visible")).toHaveText("当前筛选下没有可导出的素材");
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await page.getByRole("menuitem", { name: "新增素材", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新增素材", exact: true });
    await dialog.getByLabel("类型", { exact: true }).click();
    await page.locator(".ant-select-item-option-content").getByText("图片", { exact: true }).click();
    await dialog.getByLabel("标题", { exact: true }).fill("缺图片验证");
    await dialog.getByRole("button", { name: /^保\s*存$/ }).click();
    const upload = dialog.getByRole("button", { name: "选择图片文件", exact: true });
    await expect(upload).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.locator("#asset-image-required-error")).toHaveText("请选择图片文件");
    await expect(page.locator(".ant-message-error")).toHaveCount(0);
    const chooser = page.waitForEvent("filechooser"); await upload.click();
    await (await chooser).setFiles({ name: "保持原图.png", mimeType: "image/png", buffer: IMAGE });
    await expect(dialog.locator("#asset-image-required-error")).toHaveCount(0);
    await expect(upload).not.toHaveAttribute("aria-invalid");
    await dialog.getByRole("button", { name: /^取\s*消$/ }).click();
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("chat uploads explain attachment limit and processing while new conversation remains usable", async ({ page, api }) => {
    await chatModels(page);
    let held: import("@playwright/test").Route | undefined;
    await page.route("**/api/chat/responses", route => { held = route; });
    await page.goto("/chat");
    const files = page.getByRole("button", { name: "上传文件", exact: true });
    const pictures = page.getByRole("button", { name: "上传图片", exact: true });
    const chooser = page.waitForEvent("filechooser"); await files.click();
    await (await chooser).setFiles(Array.from({ length: 5 }, (_, index) => ({ name: `附件${index}.txt`, mimeType: "text/plain", buffer: Buffer.from(`附件${index}`) })));
    await expect(files).toBeDisabled();
    await expect(files).toHaveAttribute("aria-description", "最多添加 5 个附件，请先移除一个");
    await pictures.hover({ force: true });
    await expect(page.locator(".ant-tooltip:visible")).toHaveText("最多添加 5 个附件，请先移除一个");
    await page.getByRole("textbox", { name: "对话内容", exact: true }).fill("只读附件");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => Boolean(held)).toBe(true);
    await expect(files).toHaveAttribute("aria-description", "当前请求处理中，完成或停止后可添加附件");
    await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeEnabled();
    await held!.fulfill({ json: { content: "隔离回复", toolCalls: [] } });
    await expect(page.getByText("隔离回复", { exact: true })).toBeVisible();
    await expect(files).toBeEnabled(); await expect(pictures).toBeEnabled();
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("chat task diagnostic copy stays local to the action and preserves the request identity", async ({ page, context, api }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await chatModels(page); api.taskStatus = "processing";
    await page.route("**/api/chat/responses", route => route.fulfill({ json: { content: "隔离出图", toolCalls: [{ id: "fixture", type: "function", function: { name: "edit_image", arguments: JSON.stringify({ prompt: "隔离生成", edit_spec: { changes: ["隔离生成"] } }) } }] } }));
    await page.goto("/chat");
    await page.getByRole("textbox", { name: "对话内容", exact: true }).fill("生成隔离图");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    const pending = page.getByTestId("chat-pending-image-card");
    await pending.getByText("任务信息", { exact: true }).click();
    const copy = pending.getByRole("button", { name: "复制诊断信息", exact: true });
    await page.clock.install(); await page.clock.pauseAt(new Date());
    await copy.click(); await expect(copy).toHaveText("已复制 ✓");
    const diagnostic = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    expect(diagnostic.requestId).toBe(api.submissions[0].requestId);
    expect(diagnostic.taskId).toBe([...api.tasks.keys()][0]);
    await page.clock.runFor(1199); await expect(copy).toHaveText("已复制 ✓");
    await page.clock.runFor(1); await expect(copy).toHaveText("复制诊断信息");
    await page.clock.resume();
    await expect(page.locator(".ant-message-success")).toHaveCount(0);
    await pending.getByRole("button", { name: "停止本页等待", exact: true }).click();
    expect(api.submissions).toHaveLength(1); expect(api.batchSubmissions).toEqual([]);
});
