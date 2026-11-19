import { test, expect, newCanvas } from "./fixtures";
import { wordDocumentFixture } from "../tests/fixtures/agent-document-fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

const catalog = { models: [{ id: "10000000-0000-4000-8000-000000000001", modelId: "10000000-0000-4000-8000-000000000001", name: "豆包生图", publicName: "豆包生图", imageParameterProfile: "seedream55", capabilities: ["generate", "edit"] }], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) };

for (const imageConversationsEnabled of [false, true]) test(`idle discussion does no periodic auth or storage scan (conversations=${imageConversationsEnabled})`, async ({ page, context, api }) => {
    let auth = 0;
    await context.route("**/api/deployment", route => route.fulfill({ json: { authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false, imageConversationsEnabled } }));
    await context.route("**/api/auth/session", route => { auth++; return route.fallback(); });
    await context.route("**/api/models", route => route.fulfill({ json: catalog }));
    await newCanvas(page);
    await page.getByRole("button", { name: "打开设计讨论", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "设计讨论面板" });
    await expect(panel.getByRole("button", { name: "发送讨论", exact: true })).toBeEnabled();
    await panel.getByRole("button", { name: "收起讨论面板" }).click();
    await page.evaluate(() => {
        const original = IDBObjectStore.prototype.openCursor;
        (window as any).discussionScans = 0;
        IDBObjectStore.prototype.openCursor = function (...args) { if (this.name === "design_discussion") (window as any).discussionScans++; return original.apply(this, args); };
    });
    const before = auth;
    await page.clock.install();
    await page.clock.runFor(12_100);
    expect(auth).toBe(before);
    expect(await page.evaluate(() => (window as any).discussionScans)).toBe(0);
    expect(api.submissions).toHaveLength(0);
});

test("document media is written once while typing and restored byte-for-byte after close and reload", async ({ page, context, api }, info) => {
    await context.route("**/api/models", route => route.fulfill({ json: catalog }));
    await newCanvas(page);
    await page.getByRole("button", { name: "打开设计讨论", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "设计讨论面板" });
    const composer = panel.getByRole("textbox", { name: "输入设计需求" });
    await expect(panel.getByRole("button", { name: "发送讨论", exact: true })).toBeEnabled();
    await page.evaluate(() => {
        const original = IDBObjectStore.prototype.put;
        (window as any).discussionWrites = [];
        IDBObjectStore.prototype.put = function (value, ...args) {
            if (this.name.startsWith("design_discussion")) (window as any).discussionWrites.push({ store: this.name, media: JSON.stringify(value).includes("data:image/"), key: args[0] });
            return original.call(this, value, ...args);
        };
    });
    const fixture = wordDocumentFixture();
    await panel.getByLabel("上传设计资料", { exact: true }).setInputFiles({ name: "含原图设计资料.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from(fixture.original) });
    await expect(panel.locator(".studio-document")).toContainText("1 张插图");
    await expect.poll(() => page.evaluate(() => (window as any).discussionWrites.filter((write: any) => write.store === "design_discussion_media").length)).toBe(1);
    await page.evaluate(() => { (window as any).discussionWrites = []; });
    await page.clock.install();
    const draft = "保留资料原图与全部细节。这段连续输入的设计草稿在关闭及刷新后必须完整恢复。";
    await composer.pressSequentially(draft);
    await panel.getByRole("button", { name: "收起讨论面板" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).discussionWrites.filter((write: any) => write.store === "design_discussion").length)).toBe(1);
    expect(await page.evaluate(() => (window as any).discussionWrites.some((write: any) => write.media))).toBe(false);
    await page.reload();
    await page.getByRole("button", { name: "打开设计讨论", exact: true }).click();
    await expect(composer).toHaveValue(draft);
    await expect(panel.locator(".studio-document")).toContainText("1 张插图");
    await panel.locator(".studio-brief > summary").click();
    await panel.getByRole("button", { name: "把插图放到画布", exact: true }).click();
    await expect.poll(() => [...api.assetBytes.values()].some(bytes => bytes.equals(Buffer.from(fixture.png)))).toBe(true);
    await composer.fill("刷新前最后一笔草稿");
    await page.reload();
    await page.getByRole("button", { name: "打开设计讨论", exact: true }).click();
    await expect(composer).toHaveValue("刷新前最后一笔草稿");
    await page.screenshot({ path: info.outputPath("document-media-draft-restored.png"), animations: "disabled" });
    expect(api.submissions).toHaveLength(0);
});

test("hiding discussion keeps an accepted task observed and installs the original result once", async ({ page, context, api }, info) => {
    await context.route("**/api/models", route => route.fulfill({ json: catalog }));
    await context.route("**/api/chat/responses", route => route.fulfill({ json: { content: JSON.stringify({ message: "蓝灰配色方向", questions: [], proposals: [{ id: "blue", title: "蓝灰方向", features: ["灰蓝配色", "针织纹理"], rationale: "隔离回归", prompt: "生成一张完整灰蓝针织开衫商品图。", referenceIds: [], sourceNotes: [] }], sources: [], trendStatus: "隔离回归" }), toolCalls: [] } }));
    api.taskStatus = "processing";
    const projectId = await newCanvas(page);
    await page.getByRole("button", { name: "打开设计讨论", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "设计讨论面板" });
    await expect(panel.getByRole("button", { name: "发送讨论", exact: true })).toBeEnabled();
    await panel.locator(".discussion-settings > summary").click();
    await panel.getByRole("combobox", { name: "方案数量", exact: true }).selectOption("1");
    await panel.getByRole("textbox", { name: "输入设计需求" }).fill("给我一个完整的灰蓝针织方向。");
    await panel.getByRole("button", { name: "给我方案", exact: true }).click();
    await panel.locator(".studio-batch").click();
    await page.getByRole("dialog").getByRole("button", { name: "按选中方案生成 1 张", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    await panel.getByRole("button", { name: "收起讨论面板" }).click();
    for (const task of api.tasks.values()) { task.status = "success"; task.resultUrls = [`/api/assets/${task.id}/content`]; }
    const originalTask = [...api.tasks.values()][0];
    await expect.poll(() => api.document(projectId)?.nodes.filter((node: any) => node.metadata?.sourceTaskId === originalTask.id && node.metadata?.content === `/api/assets/${originalTask.id}/content`).length).toBe(1);
    await expect(panel).not.toBeVisible();
    expect(api.taskReads.length).toBeGreaterThan(0);
    expect(api.submissions).toHaveLength(1);
    await page.screenshot({ path: info.outputPath("hidden-discussion-original-result.png"), animations: "disabled" });
});
