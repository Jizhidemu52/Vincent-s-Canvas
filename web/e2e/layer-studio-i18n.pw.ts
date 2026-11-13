import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test as base, expect, type Page } from "@playwright/test";
import { MockCanvasApi, IMAGE } from "./fixtures";

const sourcePrompt = "保留针织纹理、中文绣花和颜色";
const translations: Record<string, string> = {
    [sourcePrompt]: "Preserve the knitted texture, Chinese embroidery, and color",
    "原始毛衫.png": "Original knitwear.png",
    "原始底图": "Original base",
    "针织文字图层": "Knitted lettering layer",
    "保留原图的针织与绣花细节": "Preserve the original knitting and embroidery details",
    "针织文字": "Knitted lettering",
    "微软雅黑": "Microsoft YaHei",
};
const imageSha = createHash("sha256").update(IMAGE).digest("hex");
type Fixture = { api: MockCanvasApi; batches: string[][]; quote: boolean; failTranslations: boolean };
const test = base.extend<{ studio: Fixture }>({ studio: async ({ context }, use, testInfo) => {
    const api = new MockCanvasApi(testInfo.project.use.baseURL || "http://127.0.0.1:5222");
    await api.attach(context);
    // The standard CI viewport also shows the account name in the shared header.
    // Keep that unrelated display leaf English so the strict batches below still
    // measure only the layer sources, including their exact no-retry boundary.
    await context.route("**/api/auth/session", route => route.fulfill({ json: { user: {
        id: "00000000-0000-4000-8000-000000000099", username: "e2e", displayName: "Isolated regression account",
        role: api.role, departmentId: null, status: "active", mustChangePassword: false, creditBalance: 999,
    } } }));
    const studio: Fixture = { api, batches: [], quote: true, failTranslations: false };
    await context.route("**/api/display-translations", async route => {
        const body = route.request().postDataJSON();
        expect(body.target).toBe("en-US");
        studio.batches.push(body.texts);
        if (studio.failTranslations) return route.fulfill({ status: 503, json: { error: "DISPLAY_TRANSLATION_UNAVAILABLE" } });
        const output = body.texts.map((source: string) => {
            expect(translations[source], `Unexpected translation input: ${source}`).toBeDefined();
            return translations[source];
        });
        return route.fulfill({ json: { translations: output } });
    });
    await context.route("**/api/layer-studio/estimate", route => {
        const body = route.request().postDataJSON();
        return route.fulfill(studio.quote ? { json: { estimate: { currency: "CNY", estimatedPrecharge: 1, maximumOutputs: body.parameters.layer_decomposition ? body.parameters.layer_decomposition_options.max_images : 1, sourceCount: body.sourceCount, priceVersion: 1, employeeCredits: 0, providerCharge: "unverified" } } }
            : { status: 503, json: { error: "PRICE_NOT_CONFIGURED" } });
    });
    await context.route("**/api/tasks", route => {
        if (route.request().method() !== "POST") return route.fallback();
        const input = route.request().postDataJSON();
        api.submissions.push(input);
        const id = randomUUID();
        const original = { state: "saved", assetId: id, contentUrl: `/api/assets/${id}/content`, width: 256, height: 256, mimeType: "image/png", sha256: imageSha };
        const document = { version: 1, taskId: id, mode: "decompose", status: "ready", expectedOutputCount: 2,
            items: [
                { ...original, index: 0, groupIndex: 0, urlIndex: 0, role: "base", name: "原始底图" },
                { ...original, index: 1, groupIndex: 0, urlIndex: 1, role: "layer", name: "针织文字图层", description: "保留原图的针织与绣花细节", boundingBox: { absolute: [16, 16, 200, 200] },
                    textRecognition: { text: "针织文字", lines: [{ runs: [{ text: "针织文字", style: { similarFontFamily: "微软雅黑", foregroundColor: "#112233", bold: true } }], boundingBox: { absolute: [16, 16, 200, 200] } }] } },
            ] };
        const task = { ...input, id, userId: "00000000-0000-4000-8000-000000000099", upstreamTaskId: "private-model-identity", status: "success", resultUrls: [`/api/assets/${id}/content`], resultDocument: document, createdAt: new Date().toISOString() };
        api.tasks.set(id, task);
        return route.fulfill({ status: 201, json: { task } });
    });
    await use(studio);
    expect(api.blocked).toEqual([]);
    expect(api.unexpected).toEqual([]);
    expect(api.pageErrors).toEqual([]);
} });

const pane = (page: Page) => page.getByRole("tabpanel");
async function storedWorkspace(page: Page) {
    return page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const records: unknown[] = [];
        await createWorkspaceStorage("layer_studio_workspaces").iterate(value => { records.push(value); });
        return JSON.stringify(records);
    });
}

test("English display translates layer content while Chinese, source data and canvas pixels remain exact", async ({ page, studio }, testInfo) => {
    await page.goto("/layer-studio");
    await expect(pane(page).getByRole("heading", { name: "图层拆分与图片生成", exact: true })).toBeVisible();
    await pane(page).getByLabel("上传参考图片", { exact: true }).setInputFiles({ name: "原始毛衫.png", mimeType: "image/png", buffer: IMAGE });
    await pane(page).getByRole("textbox", { name: "拆分说明", exact: true }).fill(sourcePrompt);
    await pane(page).getByLabel("请求文字 OCR", { exact: true }).check();
    await pane(page).getByRole("button", { name: "开始拆分", exact: true }).click();
    await expect(pane(page).getByLabel("原任务状态")).toContainText("已完成");
    await expect(pane(page).getByRole("spinbutton", { name: "X 位置", exact: true })).toHaveValue("16");
    await pane(page).getByText("文字识别与样式（模型参考值）", { exact: true }).click();
    await expect(pane(page)).toContainText("微软雅黑");
    await expect(pane(page).locator(".layer-editor-canvas-status")).not.toContainText("预览更新中");
    expect(studio.batches).toHaveLength(0);
    expect(studio.api.submissions).toHaveLength(1);
    expect(studio.api.submissions[0]).toMatchObject({ prompt: sourcePrompt, toolKey: "layer-studio", parameters: { layer_decomposition: true, layer_decomposition_options: { text_recognition: true } } });
    expect(studio.api.submissions[0]).not.toHaveProperty("modelConfigId");
    expect([...studio.api.assetBytes.values()][0]).toEqual(IMAGE);
    await expect.poll(async () => JSON.parse(await storedWorkspace(page))[0]?.jobs?.[0]?.edit?.layers?.[1]?.x).toBe(16);
    const chineseText = await pane(page).innerText();
    const sourceState = await storedWorkspace(page);
    const sourcePixels = await pane(page).locator("canvas").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());

    await page.getByTestId("language-switch").click();
    await expect(pane(page).getByRole("heading", { name: "Layer Studio", exact: true })).toBeVisible();
    await expect(pane(page).getByTestId("display-translation-preview")).toContainText(translations[sourcePrompt]);
    await expect(pane(page).locator(".layer-editor-inspector h4")).toHaveText("Knitted lettering layer");
    await expect(pane(page).locator(".layer-editor-inspector")).toContainText("Preserve the original knitting and embroidery details");
    await expect(pane(page).locator(".layer-editor-ocr")).toContainText("Microsoft YaHei");
    await expect(pane(page).getByLabel("Reference images", { exact: true })).toContainText("Original knitwear.png");
    // The editable source intentionally remains Chinese; only its separate display preview is translated.
    const englishCopy = await pane(page).evaluate(element => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const texts: string[] = [];
        while (walker.nextNode()) if (!walker.currentNode.parentElement?.closest("textarea")) texts.push(walker.currentNode.textContent || "");
        return texts.join("");
    });
    expect(englishCopy).not.toMatch(/\p{Script=Han}/u);
    await expect(pane(page).getByRole("textbox", { name: "Decomposition instructions", exact: true })).toHaveValue(sourcePrompt);
    await expect(pane(page).locator(".layer-editor-inspector h4")).toHaveAttribute("title", "针织文字图层");
    expect(await storedWorkspace(page)).toBe(sourceState);
    expect(await pane(page).locator("canvas").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).toBe(sourcePixels);
    expect(studio.api.submissions).toHaveLength(1);
    expect(studio.batches.flat()).not.toContain("private-model-identity");
    await page.screenshot({ path: testInfo.outputPath("layer-studio-en.png"), fullPage: true });

    await page.getByTestId("language-switch").click();
    await expect(pane(page).getByRole("heading", { name: "图层拆分与图片生成", exact: true })).toBeVisible();
    await expect(pane(page).getByTestId("display-translation-preview")).toHaveCount(0);
    await expect(pane(page).locator("[data-display-translation]")).toHaveCount(0);
    expect(await pane(page).innerText()).toBe(chineseText);
    expect(await storedWorkspace(page)).toBe(sourceState);
    expect(await pane(page).locator("canvas").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).toBe(sourcePixels);
    await expect(pane(page).getByRole("textbox", { name: "拆分说明", exact: true })).toHaveValue(sourcePrompt);
    const downloaded = page.waitForEvent("download");
    await pane(page).getByRole("button", { name: "下载 针织文字图层 原件", exact: true }).click();
    const originalDownload = await downloaded;
    expect(originalDownload.suggestedFilename()).toBe("02-针织文字图层.png");
    expect(await readFile((await originalDownload.path())!)).toEqual(IMAGE);
    expect(studio.api.submissions).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath("layer-studio-zh-restored.png"), fullPage: true });
});

test("English sizing, disabled reasons and errors remain usable at 390 pixels without generation", async ({ page, context, studio }, testInfo) => {
    await context.addInitScript(() => localStorage.setItem("inchoice.ui-locale", "en-US"));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/layer-studio");
    await expect(pane(page)).toContainText("Layer decomposition requires exactly 1 reference image");
    await pane(page).getByRole("button", { name: "Image generation / editing", exact: true }).click();
    await pane(page).getByRole("textbox", { name: "Image description", exact: true }).fill("Keep the knitted texture and original color");
    await pane(page).getByRole("combobox", { name: "Background", exact: true }).click();
    await page.locator(".ant-select-dropdown:visible").getByText("Transparent", { exact: true }).click();
    await expect(pane(page).getByRole("combobox", { name: "Output format", exact: true })).toBeDisabled();
    await pane(page).getByRole("combobox", { name: "Output format", exact: true }).hover();
    await expect(page.getByRole("tooltip")).toContainText("Transparent backgrounds use PNG format");
    await pane(page).getByRole("combobox", { name: "Sizing mode", exact: true }).click();
    await page.locator(".ant-select-dropdown:visible").getByText("Exact pixels", { exact: true }).click();
    await pane(page).getByLabel("Width (pixels)", { exact: true }).fill("1");
    await expect(pane(page)).toContainText("Exact dimensions require 921600–4624220 total pixels and an aspect ratio of 1/16–16.");
    await expect(pane(page).getByRole("button", { name: "Generate image", exact: true })).toBeDisabled();
    await pane(page).getByLabel("Width (pixels)", { exact: true }).fill("2048");
    await expect(pane(page).getByRole("button", { name: "Generate image", exact: true })).toBeEnabled();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await expect(pane(page)).not.toContainText(/\p{Script=Han}/u);
    expect(studio.batches).toHaveLength(0);
    expect(studio.api.submissions).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath("layer-studio-en-mobile.png"), fullPage: true });
});

test("unavailable English content translation preserves the original and never retries or generates", async ({ page, context, studio }) => {
    studio.failTranslations = true;
    await context.addInitScript(() => localStorage.setItem("inchoice.ui-locale", "en-US"));
    await page.goto("/layer-studio");
    await pane(page).getByRole("textbox", { name: "Decomposition instructions", exact: true }).fill(sourcePrompt);
    await expect(pane(page).getByTestId("display-translation-preview")).toContainText("Translation unavailable. Your original is preserved.");
    await expect(pane(page).getByTestId("display-translation-preview")).toContainText(sourcePrompt);
    const sourceState = await storedWorkspace(page);
    await pane(page).getByLabel("Request text recognition (OCR)", { exact: true }).check();
    await page.getByTestId("language-switch").click();
    await expect(pane(page).getByRole("textbox", { name: "拆分说明", exact: true })).toHaveValue(sourcePrompt);
    await page.getByTestId("language-switch").click();
    await expect(pane(page).getByTestId("display-translation-preview")).toContainText("Translation unavailable. Your original is preserved.");
    expect(studio.batches).toEqual([[sourcePrompt]]);
    expect(JSON.parse(await storedWorkspace(page))[0].form.prompt).toBe(JSON.parse(sourceState)[0].form.prompt);
    expect(studio.api.submissions).toHaveLength(0);
});
