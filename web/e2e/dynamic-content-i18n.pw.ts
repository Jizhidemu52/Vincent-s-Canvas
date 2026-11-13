import { readFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, IMAGE } from "./fixtures";

const owner = "00000000-0000-4000-8000-000000000099";
const translations: Record<string, string> = {
    "未提交中文草稿：保留纽扣": "Unsent draft: preserve the buttons",
    "云端历史中文标题": "Cloud history title",
    "原始提示词：只改袖口，保留提花。": "Original prompt: change only the cuff and preserve the jacquard.",
    "原始中文图像模型": "Original image model",
    "嵌套人工说明": "Nested human description",
    "中文图层名称": "Layer name",
    "原始任务说明": "Original task note",
    "中文文本素材": "Text asset",
    "原始中文正文：保持版型。": "Original text: preserve the fit.",
    "中文商品原图": "Original product image",
    "中文服装标签": "Garment tag",
    "自定义来源说明": "Custom source note",
    "原始备注不能改": "Original note must stay unchanged",
    "中文项目名称": "Garment project",
    "中文视频历史": "Video history",
    "原始视频提示词": "Original video prompt",
    "镜头缓慢推进，保持人物和服装不变。": "Move the camera slowly forward, preserving the person and garment.",
    "视频未提交草稿": "Unsent video draft",
    "隐藏排除原文：不要增加花纹": "Hidden exclusion: do not add a pattern",
};

async function switchLanguage(page: Page, language: "en" | "zh-CN", modalOpen = false) {
    const control = page.getByTestId("language-switch").filter({ visible: true }).first();
    if (modalOpen) await control.dispatchEvent("click");
    else await control.click();
    await expect(page.locator("html")).toHaveAttribute("lang", language);
}
async function mockDisplay(context: BrowserContext, sources: string[]) {
    await context.route("**/api/display-translations", route => {
        const input = route.request().postDataJSON() as { texts: string[]; target: string };
        expect(input.target).toBe("en-US");
        sources.push(...input.texts);
        // Only the exact source fields above are acceptance assertions. Other
        // global examples outside these four files get an isolated fixture value.
        return route.fulfill({ json: { translations: input.texts.map(text => translations[text] ?? "Unrelated fixture display") } });
    });
}

test("cloud history translates display leaves while original JSON, copy, draft and media remain exact", async ({ page, context, api }, info) => {
    const sources: string[] = [];
    await mockDisplay(context, sources);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const task = { id: "task-history-original", requestId: "原始请求编号", userId: owner, status: "success", prompt: "原始提示词：只改袖口，保留提花。",
        userInput: { userText: "云端历史中文标题" }, modelName: "原始中文图像模型", modelId: "原始模型ID",
        queuedAt: "2026-11-13T03:00:00Z", sourceUrls: ["/api/assets/source-history/content"], resultUrls: ["/api/assets/result-history/content"],
        parameters: { size: "1024x1024", creditCost: 99, inputArchive: { description: "嵌套人工说明", model: "原始模型ID", url: "https://example.invalid/原图.png", token: "原始技术令牌" } },
        resultDocument: { items: [{ name: "中文图层名称", sourceId: "原始来源编号", width: 640 }] }, failureReason: "原始任务说明" };
    const original = JSON.stringify(task);
    await context.route("**/api/tasks/history?**", route => route.fulfill({ json: { tasks: [task], hasMore: false, nextCursor: null } }));
    await page.goto("/image");
    const draft = page.getByRole("textbox", { name: "图像提示词", exact: true });
    await draft.fill("未提交中文草稿：保留纽扣");
    await page.locator(".image-result-tabs").getByRole("tab", { name: /历史记录/ }).click();
    await page.getByRole("button", { name: "查看云端记录：云端历史中文标题", exact: true }).click();
    const detail = page.getByTestId("account-history-detail");
    await detail.getByText("查看输入、参数和任务编号", { exact: true }).click();
    await expect(detail.getByRole("img", { name: "账号历史原件", exact: true })).toBeVisible();
    const beforeChinese = await detail.innerText(), beforeJson = await detail.locator("pre").innerText();
    const beforeImage = await detail.getByRole("img").getAttribute("src");
    await switchLanguage(page, "en", true);
    await expect(detail).toContainText(translations[task.prompt]);
    await expect(detail).toContainText("Original image model");
    await expect(detail.locator("pre")).toContainText("Nested human description");
    const englishJson = JSON.parse(await detail.locator("pre").innerText());
    expect(englishJson.taskId).toBe(task.id); expect(englishJson.requestId).toBe(task.requestId);
    expect(englishJson.parameters.inputArchive).toEqual({ ...task.parameters.inputArchive, description: "Nested human description" });
    expect(englishJson.resultDocument.items[0]).toEqual({ name: "Layer name", sourceId: "原始来源编号", width: 640 });
    expect(englishJson.parameters.creditCost).toBeUndefined();
    expect(await detail.getByRole("img").getAttribute("src")).toBe(beforeImage);
    await detail.getByRole("button", { name: "Copy prompt", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(task.prompt);
    await expect(detail.getByRole("button", { name: "Copy prompt", exact: true })).toBeVisible();
    await switchLanguage(page, "zh-CN", true);
    await expect.poll(() => detail.innerText()).toBe(beforeChinese);
    expect(await detail.locator("pre").innerText()).toBe(beforeJson);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(draft).toHaveValue("未提交中文草稿：保留纽扣");
    await switchLanguage(page, "en");
    await expect(page.getByTestId("display-translation-preview").filter({ visible: true }).first()).toContainText("Unsent draft: preserve the buttons");
    await expect(page.getByRole("textbox", { name: "Image prompt", exact: true })).toHaveValue("未提交中文草稿：保留纽扣");
    await page.screenshot({ path: info.outputPath("image-English-draft-and-history.png"), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("image-English-mobile.png"), animations: "disabled" });
    for (const protectedValue of [task.id, task.requestId, "原始模型ID", "原始技术令牌", "原始来源编号", task.parameters.inputArchive.url]) expect(sources).not.toContain(protectedValue);
    expect(JSON.stringify(task)).toBe(original);
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("asset display and filters translate without changing copied text, downloaded bytes or metadata payloads", async ({ page, context, api }, info) => {
    const sources: string[] = [], lists: string[] = [], writes: Array<{ path: string; body: Record<string, unknown> }> = [];
    await mockDisplay(context, sources);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const common = { ownerUserId: owner, ownerName: "设计师", departmentId: null, projectId: "original-project", projectName: "中文项目名称", source: "manual-upload", status: "ready", visibilityScope: "private",
        resultStatus: "unused", usabilityScore: 0, downloadCount: 0, createdAt: "2026-11-13T00:00:00Z", byteSize: IMAGE.length };
    const assets = [
        { ...common, id: "original-text", kind: "text", filename: "中文文本素材.txt", mimeType: "text/plain", contentUrl: "/api/assets/original-text/content",
            metadata: { title: "中文文本素材", content: "原始中文正文：保持版型。", tags: ["中文服装标签"], source: "自定义来源说明", note: "原始备注不能改" } },
        { ...common, id: "original-image", kind: "image", filename: "中文商品原图.png", mimeType: "image/png", contentUrl: "/api/assets/original-image/content",
            thumbnailUrl: "/api/assets/original-image/thumb?w=256", metadata: { title: "中文商品原图", tags: ["中文服装标签"], width: 256, height: 256 } },
    ];
    const original = JSON.stringify(assets);
    await context.route("**/api/projects", route => route.fulfill({ json: { projects: [{ id: "original-project", name: "中文项目名称" }] } }));
    await context.route("**/api/assets**", route => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname;
        if (request.method() !== "GET") {
            writes.push({ path, body: request.postDataJSON() });
            if (path.endsWith("/download-receipts")) return route.fulfill({ json: { eventId: "original-download", projection: { resultStatus: "downloaded", downloadCount: 1, usabilityScore: 0 } } });
            return route.fulfill({ status: 204 });
        }
        if (path === "/api/assets") { lists.push(url.search); return route.fulfill({ json: { assets, hasMore: false, nextCursor: null } }); }
        if (/\/(content|thumb)$/.test(path)) return route.fulfill({ contentType: "image/png", body: IMAGE });
        return route.fulfill({ json: { asset: assets.find(item => item.id === path.split("/")[3]) } });
    });
    await page.goto("/assets");
    const card = page.locator(".ant-card").filter({ has: page.getByRole("heading", { name: "中文文本素材", exact: true }) });
    await expect(card).toBeVisible();
    const beforeChinese = await card.innerText();
    await switchLanguage(page, "en");
    await expect(page.getByRole("heading", { name: "Text asset", exact: true })).toBeVisible();
    await expect(page.getByText("Custom source note", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "More filters", exact: true }).click();
    await page.getByRole("combobox", { name: "Filter by tag", exact: true }).click();
    await page.locator(".ant-select-item-option-content").getByText("Garment tag", { exact: true }).click();
    await expect.poll(() => lists.some(value => new URLSearchParams(value).get("tag") === "中文服装标签")).toBe(true);
    await page.getByRole("combobox", { name: "Filter by project", exact: true }).click();
    await page.locator(".ant-select-item-option-content").getByText("Garment project", { exact: true }).click();
    await expect.poll(() => lists.some(value => new URLSearchParams(value).get("projectId") === "original-project")).toBe(true);
    expect(writes).toEqual([]);
    await switchLanguage(page, "zh-CN");
    await expect.poll(() => card.innerText()).toBe(beforeChinese);
    await switchLanguage(page, "en");
    await page.getByRole("heading", { name: "Text asset", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Asset details", exact: true });
    await expect(drawer).toContainText("Original note must stay unchanged");
    await drawer.getByRole("button", { name: "Copy text", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(assets[0].metadata.content);
    await drawer.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("heading", { name: "Original product image", exact: true }).click();
    const downloadEvent = page.waitForEvent("download");
    await drawer.getByRole("button", { name: "Download image", exact: true }).click();
    const download = await downloadEvent, stream = await download.createReadStream();
    const bytes: Buffer[] = [];
    for await (const chunk of stream!) bytes.push(Buffer.from(chunk));
    expect(Buffer.concat(bytes)).toEqual(IMAGE);
    expect(download.suggestedFilename()).toBe("中文商品原图.png");
    await drawer.getByRole("button", { name: "Close", exact: true }).click();
    const textCard = page.locator(".ant-card").filter({ has: page.getByRole("heading", { name: "Text asset", exact: true }) });
    await textCard.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Edit asset", exact: true });
    await expect(editor.getByLabel("Title", { exact: true })).toHaveValue("中文文本素材");
    await expect(editor.getByLabel("Source", { exact: true })).toHaveValue("自定义来源说明");
    await expect(editor.getByLabel("Notes", { exact: true })).toHaveValue("原始备注不能改");
    await expect(editor).toContainText("Original note must stay unchanged");
    await page.screenshot({ path: info.outputPath("asset-English-preview-original-editor.png"), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("asset-English-mobile-editor.png"), animations: "disabled" });
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => writes.filter(item => item.path.endsWith("/metadata"))).toEqual([{ path: "/api/assets/original-text/metadata", body: {
        title: "中文文本素材", tags: ["中文服装标签"], source: "自定义来源说明", note: "原始备注不能改",
    } }]);
    expect(JSON.stringify(assets)).toBe(original);
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("video history planning and draft previews translate without rewriting stored logs or reuse values", async ({ page, context, api }, info) => {
    const sources: string[] = [];
    await mockDisplay(context, sources);
    const videoBytes = readFileSync(new URL("./media/video.mp4", import.meta.url));
    await context.route("**/api/assets/video-original/content", route => route.fulfill({ contentType: "video/mp4", body: videoBytes }));
    await page.goto("/video");
    await expect(page.getByRole("textbox", { name: "视频提示词", exact: true })).toBeVisible();
    const log = { id: "video-original", workspaceId: "default", createdAt: 1794528000000, title: "中文视频历史", prompt: "原始视频提示词", effectivePrompt: "原始视频提示词",
        summaryZh: "镜头缓慢推进，保持人物和服装不变。", time: "12:00", model: "doubao-seedance-2.5", status: "成功", durationMs: 5000,
        config: { model: "doubao-seedance-2.5", videoModel: "doubao-seedance-2.5", size: "16:9", vquality: "720p", videoSeconds: "5", videoMode: "text", videoGenerateAudio: false, videoWatermark: false, videoSeed: "", videoOutputFormat: "mp4" },
        references: [], videoReferences: [], audioReferences: [], size: "16:9", resolution: "720p", seconds: "5",
        video: { id: "video-original-result", url: "/api/assets/video-original/content", storageKey: "", durationMs: 5000, width: 1280, height: 720, bytes: videoBytes.length, mimeType: "video/mp4" } };
    await page.evaluate(async value => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        await createWorkspaceStorage("video_generation_logs").setItem(value.id, value);
    }, log);
    await page.reload();
    const draft = page.getByRole("textbox", { name: "视频提示词", exact: true });
    await draft.fill("视频未提交草稿");
    await page.getByRole("tab", { name: "历史记录", exact: true }).click();
    await page.getByText("中文视频历史", { exact: true }).click();
    await expect(page.getByText(log.summaryZh, { exact: true })).toBeVisible();
    const originalLog = await page.evaluate(async id => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        return JSON.stringify(await createWorkspaceStorage("video_generation_logs").getItem(id));
    }, log.id);
    await switchLanguage(page, "en");
    await expect(page.getByText("Video history", { exact: true })).toBeVisible();
    await expect(page.getByText(translations[log.summaryZh], { exact: true })).toBeVisible();
    await expect(page.getByTestId("display-translation-preview").filter({ visible: true })).toContainText("Unsent video draft");
    await expect(page.getByRole("textbox", { name: "Video prompt", exact: true })).toHaveValue("视频未提交草稿");
    const video = page.locator("video[controls]").first();
    await expect(video).toHaveAttribute("src", log.video.url);
    await page.getByRole("button", { name: "Reuse prompt", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Video prompt", exact: true })).toHaveValue("视频未提交草稿");
    await page.getByRole("dialog", { name: "Replace the current draft?", exact: true }).getByRole("button", { name: "Replace draft", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Video prompt", exact: true })).toHaveValue(log.prompt);
    await switchLanguage(page, "zh-CN");
    await expect(page.getByText("中文视频历史", { exact: true })).toBeVisible();
    await expect(page.getByText(log.summaryZh, { exact: true })).toBeVisible();
    await expect(page.getByTestId("display-translation-preview")).toHaveCount(0);
    await expect(draft).toHaveValue(log.prompt);
    expect(await page.evaluate(async id => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        return JSON.stringify(await createWorkspaceStorage("video_generation_logs").getItem(id));
    }, log.id)).toBe(originalLog);
    await page.screenshot({ path: info.outputPath("video-Chinese-restored-original.png"), animations: "disabled" });
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("image details translate only after expansion and retain the original excluded-content parameter", async ({ page, context, api }) => {
    const sources: string[] = [];
    await mockDisplay(context, sources);
    await page.goto("/image");
    await expect(page.getByRole("textbox", { name: "图像提示词", exact: true })).toBeVisible();
    const excluded = "隐藏排除原文：不要增加花纹";
    const imageOptions = JSON.stringify({ negative_prompt: excluded });
    await page.evaluate(async value => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const store = createWorkspaceStorage("generation_drafts");
        const settings = await store.getItem<Record<string, unknown>>("image-generation:settings");
        await store.setItem("image-generation:settings", { ...settings, imageOptions: value });
    }, imageOptions);
    await page.reload();
    await page.getByRole("textbox", { name: "图像提示词", exact: true }).fill("未提交中文草稿：保留纽扣");
    await switchLanguage(page, "en");
    await expect(page.getByTestId("display-translation-preview")).toContainText("Unsent draft: preserve the buttons");
    const details = page.locator("details").filter({ has: page.getByText(excluded, { exact: true }) });
    await expect(details).not.toHaveAttribute("open");
    await expect(details.getByTestId("display-translation-preview")).toHaveCount(0);
    expect(sources).not.toContain(excluded);
    await details.locator("summary").click();
    await expect(details.getByTestId("display-translation-preview").filter({ hasText: translations[excluded] })).toBeVisible();
    await expect(details.locator("pre").filter({ hasText: excluded })).toHaveText(excluded);
    expect(sources).toContain(excluded);
    await details.locator("summary").click();
    await expect(details.getByTestId("display-translation-preview")).toHaveCount(0);
    await switchLanguage(page, "zh-CN");
    expect(await page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        return (await createWorkspaceStorage("generation_drafts").getItem<Record<string, unknown>>("image-generation:settings"))?.imageOptions;
    })).toBe(imageOptions);
    await expect(page.getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("未提交中文草稿：保留纽扣");
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});
