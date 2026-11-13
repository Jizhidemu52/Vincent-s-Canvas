import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, IMAGE } from "./fixtures";
import type { DesignLibraryEntry, DesignLibraryStats } from "../src/types/design-library";
import type { PromptTemplate } from "../src/services/api/prompts";

const owner = "00000000-0000-4000-8000-000000000099";
const originalTitle = "针织袖口配色探索", originalThought = "保留原有提花，只调整袖口的配色。", originalPrompt = "原始提示词：保留提花，不添加纽扣。";
const originalTag = "针织袖口", originalAuthor = "王设计师", originalDepartment = "服装设计组";
const translations: Record<string, string> = {
    [originalTitle]: "Knitted cuff color exploration", [originalThought]: "Preserve the jacquard and adjust only the cuff colors.",
    [originalPrompt]: "Original prompt: preserve the jacquard without adding buttons.", [originalTag]: "Knitted cuff",
    [originalAuthor]: "Designer Wang", [originalDepartment]: "Garment design team",
    "陈同事": "Colleague Chen", "针织开发组": "Knitwear development team",
    "首页私有中文原图": "Private original image", "首页文本素材": "Home text asset", "原始文本素材内容": "Original text asset content",
    "首页收藏中文模板": "Favorite template", "无图中文灵感": "Text-only inspiration",
    "当前设计作品暂不可读取，请联系上传同事核对。": "This design is temporarily unavailable. Ask the uploading colleague to check it.",
};
async function switchLanguage(page: Page, language: "en" | "zh-CN", modal = false) {
    const control = page.getByTestId("language-switch").filter({ visible: true }).first();
    if (modal) await control.dispatchEvent("click");
    else await control.click();
    await expect(page.locator("html")).toHaveAttribute("lang", language);
}
async function displayFixture(context: BrowserContext, sources: string[]) {
    await context.route("**/api/display-translations", route => {
        const input = route.request().postDataJSON() as { target: string; texts: string[] };
        expect(input.target).toBe("en-US"); sources.push(...input.texts);
        return route.fulfill({ json: { translations: input.texts.map(text => translations[text] ?? "Unrelated fixture display") } });
    });
}
function libraryEntry(): DesignLibraryEntry {
    return { id: "original-entry", title: originalTitle, thought: originalThought, prompt: originalPrompt, tags: [originalTag],
        author: { id: owner, name: originalAuthor, departmentId: "original-department", departmentName: originalDepartment },
        status: "published", createdAt: "2026-11-13T00:00:00Z", updatedAt: "2026-11-13T00:00:00Z", canViewStats: true, canWithdraw: true, canModerate: false,
        images: [{ id: "original-image", filename: "原始设计文件.png", mimeType: "image/png", byteSize: IMAGE.length, width: 256, height: 256,
            contentUrl: "/api/design-library/original-entry/images/original-image/content", thumbnailUrl: "/api/design-library/original-entry/images/original-image/thumbnail" }] };
}
async function libraryFixture(context: BrowserContext) {
    const entry = libraryEntry(), textEntry = { ...entry, id: "text-entry", title: "无图中文灵感", images: [] };
    const counts = { view: { count: 2, people: 1 }, download: { count: 1, people: 1 }, reuse: { count: 1, people: 1 }, prompt_copy: { count: 1, people: 1 } };
    const stats: DesignLibraryStats = { entryId: entry.id, totals: counts, images: [{ imageId: entry.images[0].id, filename: entry.images[0].filename, counts }],
        activity: [{ id: "original-activity", action: "download", imageId: entry.images[0].id, filename: entry.images[0].filename,
            actor: { id: "original-colleague", name: "陈同事", departmentName: "针织开发组" }, createdAt: "2026-11-13T03:00:00Z" }],
        activityTotal: 1, page: 1, pageSize: 20 };
    const writes: Array<{ path: string; body: Record<string, unknown> }> = [], searches: string[] = [];
    const original = JSON.stringify({ entry, textEntry, stats });
    await context.route("**/api/deployment", route => route.fulfill({ json: { authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: true } }));
    await context.route("**/api/prompt-templates?**", route => route.fulfill({ json: { templates: [], total: 0, page: 1, pageSize: 20 } }));
    await context.route(url => url.pathname.startsWith("/api/design-library"), route => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname;
        const ok = (data: unknown) => route.fulfill({ json: { code: 0, data } });
        if (request.method() !== "GET") {
            const body = request.postDataJSON(); writes.push({ path, body });
            if (path === "/api/design-library") return ok({ entry: { ...entry, ...body } });
            if (path.endsWith("/download")) return route.fulfill({ contentType: "image/png", body: IMAGE });
            if (path.endsWith("/events")) return ok({ recorded: true });
            return route.fulfill({ status: 501, json: { message: "Unexpected library write" } });
        }
        if (path === "/api/design-library") { searches.push(url.search); return ok({ items: [entry, textEntry], total: 2, page: 1, pageSize: 24 }); }
        if (path.endsWith("/stats")) return ok(stats);
        if (/\/(content|thumbnail)$/.test(path)) return route.fulfill({ contentType: "image/png", body: IMAGE });
        return ok({ entry });
    });
    return { entry, textEntry, stats, original, writes, searches };
}

test("home resources translate display, restore Chinese, and fill the original favorite without changing media", async ({ page, context, api }, info) => {
    const sources: string[] = [], writes: Array<{ path: string; body: Record<string, unknown> }> = [];
    await displayFixture(context, sources);
    const common = { ownerUserId: owner, ownerName: originalAuthor, departmentId: null, projectId: null, projectName: null,
        source: "manual-upload", status: "ready", visibilityScope: "private", resultStatus: "unused", usabilityScore: 0, downloadCount: 0, createdAt: "2026-11-13T00:00:00Z", byteSize: IMAGE.length };
    const assets = [{ ...common, id: "home-original-image", kind: "image", filename: "首页私有中文原图.png", mimeType: "image/png",
        contentUrl: "/api/assets/home-original-image/content", thumbnailUrl: "/api/assets/home-original-image/thumb?w=256", metadata: { title: "首页私有中文原图" } },
    { ...common, id: "home-original-text", kind: "text", filename: "首页文本素材.txt", mimeType: "text/plain", contentUrl: "/api/assets/home-original-text/content",
        metadata: { title: "首页文本素材", content: "原始文本素材内容" } }];
    const template: PromptTemplate = { id: "home-original-template", scope: "personal", ownerUserId: owner, groupId: null, departmentId: null,
        currentVersionId: "home-original-version", version: 1, title: "首页收藏中文模板", prompt: originalPrompt, targetTool: "image-generation", modelConfigId: null,
        modelSnapshot: {}, parameters: {}, referenceAssetIds: [], category: "", tags: [], notes: "", sourceTaskId: null, sourceAssetId: null, favorite: true,
        useCount: 0, lastUsedAt: null, createdAt: "2026-11-13T00:00:00Z", updatedAt: "2026-11-13T00:00:00Z" };
    const pricing = { operationType: "image_generation", modelChanged: false, reason: null, selectedModel: null, estimate: null, alternatives: [] };
    const original = JSON.stringify({ assets, template });
    await context.route("**/api/assets**", route => {
        const path = new URL(route.request().url()).pathname;
        if (/\/(content|thumb)$/.test(path)) return route.fulfill({ contentType: "image/png", body: IMAGE });
        return route.fulfill({ json: { assets, hasMore: false, nextCursor: null } });
    });
    await context.route("**/api/prompt-templates**", route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (request.method() !== "GET") {
            writes.push({ path, body: request.postDataJSON() });
            return route.fulfill({ json: { reuseToken: "original-reuse-token", expiresInSeconds: 600, mode: "fill", pricing } });
        }
        if (path.includes("/reuse/")) return route.fulfill({ json: { template, mode: "fill", pricing, warnings: [] } });
        return route.fulfill({ json: { templates: [template], total: 1, page: 1, pageSize: 4 } });
    });
    await page.goto("/");
    const resources = page.locator("section").filter({ has: page.getByRole("heading", { name: "最近素材", exact: true }) });
    const favorites = page.locator("section").filter({ has: page.getByRole("heading", { name: "收藏的提示词", exact: true }) });
    await expect(resources).toContainText("原始文本素材内容"); await expect(favorites).toContainText(template.prompt);
    const chinese = { resources: await resources.innerText(), favorites: await favorites.innerText() };
    const media = await resources.locator("img").getAttribute("src");
    await switchLanguage(page, "en");
    const englishResources = page.getByRole("region", { name: "Recent assets", exact: true });
    const englishFavorites = page.getByRole("region", { name: "Favorite prompts", exact: true });
    await expect(englishResources).toContainText("Original text asset content"); await expect(englishResources).toContainText("Private original image");
    await expect(englishFavorites).toContainText("Favorite template"); await expect(englishFavorites).toContainText(translations[originalPrompt]);
    expect(await englishResources.locator("img").getAttribute("src")).toBe(media);
    expect(writes).toEqual([]);
    await switchLanguage(page, "zh-CN");
    await expect.poll(() => resources.innerText()).toBe(chinese.resources); await expect.poll(() => favorites.innerText()).toBe(chinese.favorites);
    await switchLanguage(page, "en");
    await englishResources.scrollIntoViewIfNeeded();
    await englishResources.locator("..").screenshot({ path: info.outputPath("home-English-resources.png"), animations: "disabled" });
    await englishFavorites.getByRole("button").click();
    await expect(page.getByRole("textbox", { name: "Image prompt", exact: true })).toHaveValue(template.prompt);
    expect(writes).toHaveLength(1); expect(writes[0].path).toBe(`/api/prompt-templates/${template.id}/resolve`);
    expect(writes[0].body).toEqual({ mode: "fill", requestId: expect.stringMatching(/^prompt-reuse:/) });
    expect(JSON.stringify({ assets, template })).toBe(original);
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("library list, detail and activity names translate while filters, copy and download retain originals", async ({ page, context, api }, info) => {
    const sources: string[] = []; await displayFixture(context, sources);
    const fixture = await libraryFixture(context), { entry, stats, writes, searches } = fixture;
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/design-library");
    const cards = page.locator("article").filter({ has: page.getByRole("button", { name: originalTitle, exact: true }) });
    await expect(cards).toBeVisible(); const chineseCard = await cards.innerText();
    await switchLanguage(page, "en");
    const englishCard = page.locator("article").filter({ has: page.getByRole("button", { name: translations[originalTitle], exact: true }) });
    await expect(englishCard).toContainText("Designer Wang"); await expect(englishCard).toContainText("Garment design team");
    await expect(page.getByText(translations[originalThought], { exact: true })).toBeVisible();
    await englishCard.getByRole("button", { name: `#${translations[originalTag]}`, exact: true }).click();
    await expect.poll(() => searches.some(search => new URLSearchParams(search).get("tag") === originalTag)).toBe(true);
    expect(writes).toEqual([]);
    await switchLanguage(page, "zh-CN"); await expect.poll(() => cards.innerText()).toBe(chineseCard);
    await cards.getByRole("button", { name: originalTitle, exact: true }).click();
    const detail = page.getByRole("dialog", { name: originalTitle, exact: true });
    await expect(detail.getByRole("img", { name: entry.images[0].filename, exact: true })).toBeVisible(); await expect.poll(() => writes.filter(item => item.body.action === "view").length).toBe(2);
    const chineseDetail = await detail.innerText(), media = await detail.getByRole("img", { name: entry.images[0].filename, exact: true }).getAttribute("src"), writesBeforeSwitch = writes.length;
    await switchLanguage(page, "en", true);
    const englishDetail = page.getByRole("dialog", { name: translations[originalTitle], exact: true });
    await expect(englishDetail).toContainText(translations[originalThought]); await expect(englishDetail).toContainText(translations[originalPrompt]);
    await expect(englishDetail).toContainText("Designer Wang"); await expect(englishDetail).toContainText("Garment design team");
    expect(await englishDetail.getByRole("img", { name: entry.images[0].filename, exact: true }).getAttribute("src")).toBe(media); expect(writes.length).toBe(writesBeforeSwitch);
    await englishDetail.getByRole("button", { name: "Usage statistics", exact: true }).click();
    const englishStats = page.getByRole("dialog", { name: `Usage statistics · ${translations[originalTitle]}`, exact: true });
    await expect(englishStats).toContainText("Colleague Chen"); await expect(englishStats).toContainText("Knitwear development team");
    expect(writes.length).toBe(writesBeforeSwitch);
    await page.screenshot({ path: info.outputPath("library-English-statistics.png"), animations: "disabled" });
    await switchLanguage(page, "zh-CN", true);
    const chineseStats = page.getByRole("dialog", { name: `使用统计 · ${originalTitle}`, exact: true });
    await expect(chineseStats).toContainText(stats.activity[0].actor.name); await expect(chineseStats).toContainText(stats.activity[0].actor.departmentName!);
    await chineseStats.getByRole("button", { name: /^(Close|关闭)$/ }).click();
    await expect.poll(() => detail.innerText()).toBe(chineseDetail);
    await switchLanguage(page, "en", true);
    await englishDetail.getByRole("button", { name: "Copy prompt", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(originalPrompt);
    const downloadEvent = page.waitForEvent("download"); await englishDetail.getByRole("button", { name: "Download original", exact: true }).click();
    const download = await downloadEvent, stream = await download.createReadStream(), chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(IMAGE); expect(download.suggestedFilename()).toBe(entry.images[0].filename);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await englishDetail.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("library-English-mobile-detail.png"), animations: "disabled" });
    expect(JSON.stringify({ entry, textEntry: fixture.textEntry, stats })).toBe(fixture.original);
    for (const value of [entry.id, entry.author.id, entry.author.departmentId!, entry.images[0].filename, entry.images[0].contentUrl, stats.activity[0].actor.id]) expect(sources).not.toContain(value);
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("publication English previews never replace input values or the explicit original publish payload", async ({ page, context, api }, info) => {
    const sources: string[] = []; await displayFixture(context, sources);
    const { writes } = await libraryFixture(context);
    await page.goto("/design-library?publish=1");
    const dialog = page.getByRole("dialog", { name: "发布到公司设计灵感库", exact: true });
    await dialog.getByLabel("作品标题", { exact: true }).fill(originalTitle);
    await dialog.getByLabel("设计思路", { exact: true }).fill(originalThought);
    await dialog.getByLabel("生图提示词", { exact: true }).fill(originalPrompt);
    await dialog.getByRole("combobox", { name: "标签", exact: true }).fill(originalTag);
    await dialog.getByRole("combobox", { name: "标签", exact: true }).press("Enter");
    await switchLanguage(page, "en", true);
    const english = page.getByRole("dialog", { name: "Publish to company design library", exact: true });
    for (const translated of [translations[originalTitle], translations[originalThought], translations[originalPrompt], translations[originalTag]]) {
        await expect(english.getByTestId("display-translation-preview").getByText(translated, { exact: true })).toBeVisible();
    }
    await expect(english.getByLabel("Work title", { exact: true })).toHaveValue(originalTitle);
    await expect(english.getByLabel("Design thinking", { exact: true })).toHaveValue(originalThought);
    await expect(english.getByLabel("Image generation prompt", { exact: true })).toHaveValue(originalPrompt);
    await expect(english.locator(".ant-select-selection-item")).toContainText(originalTag); expect(writes).toEqual([]);
    await switchLanguage(page, "zh-CN", true);
    await expect(dialog.getByTestId("display-translation-preview")).toHaveCount(0);
    await expect(dialog.getByLabel("作品标题", { exact: true })).toHaveValue(originalTitle);
    await expect(dialog.getByLabel("设计思路", { exact: true })).toHaveValue(originalThought);
    await expect(dialog.getByLabel("生图提示词", { exact: true })).toHaveValue(originalPrompt);
    await switchLanguage(page, "en", true);
    await english.getByRole("combobox", { name: "Tags", exact: true }).press("Escape");
    await english.locator("aside").screenshot({ path: info.outputPath("library-English-original-publish-preview-desktop.png"), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await english.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await english.locator("aside").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("library-English-original-publish-preview.png"), animations: "disabled", fullPage: true });
    await english.getByRole("checkbox", { name: "I have reviewed the public content and confirm I have permission to share it", exact: true }).check();
    await english.getByRole("button", { name: "Confirm public sharing & publish", exact: true }).click();
    await expect.poll(() => writes.filter(item => item.path === "/api/design-library")).toEqual([{ path: "/api/design-library", body: {
        title: originalTitle, thought: originalThought, prompt: originalPrompt, tags: [originalTag], assetIds: [], requestId: expect.any(String),
    } }]);
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("a dynamic library error translates inside the live notice without changing the API error", async ({ page, context, api }) => {
    const sources: string[] = []; await displayFixture(context, sources);
    const { entry, writes } = await libraryFixture(context);
    const originalMessage = "当前设计作品暂不可读取，请联系上传同事核对。";
    let reads = 0;
    await context.route(url => url.pathname === `/api/design-library/${entry.id}`, route => {
        reads++; return route.fulfill({ status: 503, json: { code: 503, msg: originalMessage } });
    });
    await page.goto("/design-library"); await switchLanguage(page, "en");
    await page.getByRole("button", { name: translations[originalTitle], exact: true }).click();
    await expect(page.locator(".ant-message-notice")).toContainText(translations[originalMessage]);
    expect(sources).toContain(originalMessage); expect(reads).toBe(1); expect(writes).toEqual([]);
    await switchLanguage(page, "zh-CN");
    await page.getByRole("button", { name: originalTitle, exact: true }).click();
    await expect(page.locator(".ant-message-notice").last()).toContainText(originalMessage);
    expect(reads).toBe(2); expect(writes).toEqual([]);
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});
