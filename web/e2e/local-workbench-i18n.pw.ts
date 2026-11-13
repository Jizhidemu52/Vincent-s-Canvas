import type { BrowserContext, Locator, Page } from "@playwright/test";
import { test, expect, IMAGE } from "./fixtures";

const artworkName = '中文胸花"<样稿>.png';
const translatedArtwork = 'Chinese chest flower "<draft>.png';
const repeatName = artworkName.replace(/\.png$/, ""), translatedRepeatName = translatedArtwork.replace(/\.png$/, "");
const translations: Record<string, string> = {
    [artworkName]: translatedArtwork,
    [`8 ${repeatName}`]: `8 ${translatedRepeatName}`,
    "胸前花朵": "Chest flower", "蓝色短袖 · 示例底图": "Blue tee · sample base",
    "原始服装底图.png": "Original garment base.png",
    "中文本地工程": "Chinese local project",
};

async function mockDisplay(context: BrowserContext, sources: string[]) {
    await context.route("**/api/display-translations", route => {
        const { texts, target } = route.request().postDataJSON() as { texts: string[]; target: string };
        expect(target).toBe("en-US"); sources.push(...texts);
        return route.fulfill({ json: { translations: texts.map(text => translations[text] ?? (text.startsWith("示例素材未能加载：") ? "Sample assets could not load. Refresh to retry." : text.includes(repeatName) ? `Editing · ${translatedRepeatName}` : "Unrelated fixture display")) } });
    });
}
async function switchLanguage(page: Page, language: "en" | "zh-CN") {
    await page.getByTestId("language-switch").filter({ visible: true }).first().click();
    await expect(page.locator("html")).toHaveAttribute("lang", language);
}
async function dropImage(target: Locator, name: string) {
    await target.evaluate((element, input) => {
        const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(input.bytes)], input.name, { type: "image/png" }));
        element.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    }, { bytes: [...IMAGE], name });
}
async function exportProject(page: Page) {
    const pending = page.waitForEvent("download");
    await page.locator('[data-action="export-json"]').click();
    const download = await pending, stream = await download.createReadStream();
    if (!stream) throw new Error("Project download missing");
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return { filename: download.suggestedFilename(), project: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
}
const artworkBytes = (src: string) => Buffer.from(src.split(",")[1]!, "base64");
const canvasPixels = (canvas: Locator) => canvas.evaluateAll(elements => elements.map(element => (element as HTMLCanvasElement).toDataURL()));

test("placement language switches translate marked names without changing original project or artwork", async ({ page, context, api }) => {
    const sources: string[] = []; await mockDisplay(context, sources);
    await page.goto("/creative/pattern-placement");
    await expect(page.locator('[data-workbench-select="project"]')).toBeEnabled();
    page.once("dialog", dialog => dialog.accept("中文本地工程"));
    await page.locator("[data-project-rename]").click();
    await dropImage(page.locator(".placement-canvas-wrap"), artworkName);
    await expect(page.locator("[data-layer-count]")).toHaveText("2 / 30");
    await dropImage(page.locator('[data-action="upload-base"]'), "原始服装底图.png");
    await expect(page.locator(".placement-base-name")).toHaveText("原始服装底图.png");
    const title = page.locator("[data-controls] > .section-title"), layer = page.locator(".placement-layer-select").first();
    await expect(title).toHaveText(artworkName); await expect(layer).toHaveText(artworkName);
    const original = await exportProject(page), pixels = await canvasPixels(page.locator(".placement-demo canvas"));
    const inputs = await page.locator("[data-prop]").evaluateAll(elements => elements.map(element => (element as HTMLInputElement).value));
    expect(artworkBytes(original.project.base.src)).toEqual(IMAGE);
    expect(artworkBytes(original.project.layers[1].src)).toEqual(IMAGE);
    expect(original.project.layers[1].name).toBe(artworkName);
    await switchLanguage(page, "en");
    await expect(title).toHaveText(translatedArtwork); await expect(layer).toHaveText(translatedArtwork);
    await expect(page.locator(".placement-base-name")).toHaveText("Original garment base.png");
    await expect(page.locator('[data-workbench-select="project"] option:checked')).toHaveText("Chinese local project");
    expect(await exportProject(page)).toEqual(original);
    expect(await canvasPixels(page.locator(".placement-demo canvas"))).toEqual(pixels);
    expect(await page.locator("[data-prop]").evaluateAll(elements => elements.map(element => (element as HTMLInputElement).value))).toEqual(inputs);
    await switchLanguage(page, "zh-CN");
    await expect(title).toHaveText(artworkName); await expect(layer).toHaveText(artworkName);
    await expect(page.locator('[data-workbench-select="project"] option:checked')).toHaveText("中文本地工程");
    expect(await exportProject(page)).toEqual(original);
    expect(sources).toContain(artworkName);
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]); expect(api.assetBytes.size).toBe(0);
});

test("repeat display names switch reversibly while original exports and canvas pixels remain exact", async ({ page, context, api }) => {
    const sources: string[] = []; await mockDisplay(context, sources);
    // The existing export metadata includes the export time; hold only Date so
    // timers keep running and byte-for-byte project comparison is meaningful.
    await page.clock.setFixedTime(new Date("2026-11-13T04:00:00Z"));
    await page.goto("/creative/pattern-repeat");
    await expect(page.locator('[data-workbench-select="project"]')).toBeEnabled();
    await dropImage(page.locator(".local-workbench-host"), artworkName);
    const layer = page.locator('[data-role="layers"] button').last(), selection = page.locator('[data-role="selection-name"]');
    await expect(layer).toHaveText(`8 ${repeatName}`);
    await expect(selection).toContainText(repeatName);
    const original = await exportProject(page), pixels = await canvasPixels(page.locator(".repeat-workspace canvas"));
    const settings = await page.locator("[data-setting]").evaluateAll(elements => elements.map(element => ({ value: (element as HTMLInputElement).value, checked: (element as HTMLInputElement).checked })));
    expect(original.project.elements[7].name).toBe(repeatName);
    expect(artworkBytes(original.project.elements[7].src)).toEqual(IMAGE);
    await switchLanguage(page, "en");
    await expect(layer).toHaveText(`8 ${translatedRepeatName}`);
    await expect(selection).toContainText(translatedRepeatName);
    expect(await exportProject(page)).toEqual(original);
    expect(await canvasPixels(page.locator(".repeat-workspace canvas"))).toEqual(pixels);
    expect(await page.locator("[data-setting]").evaluateAll(elements => elements.map(element => ({ value: (element as HTMLInputElement).value, checked: (element as HTMLInputElement).checked })))).toEqual(settings);
    await switchLanguage(page, "zh-CN");
    await expect(layer).toHaveText(`8 ${repeatName}`); await expect(selection).toContainText(repeatName);
    expect(await exportProject(page)).toEqual(original);
    expect(sources).toContain(`8 ${repeatName}`);
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]); expect(api.assetBytes.size).toBe(0);
});

test("placement asset load failure remains translatable after the early return", async ({ page, context, api }) => {
    const sources: string[] = []; await mockDisplay(context, sources);
    await context.route("**/design-workbench/assets/garment.png", route => route.abort("failed"));
    await page.goto("/creative/pattern-placement");
    const error = page.locator(".placement-error");
    await expect(error).toContainText("示例素材未能加载：");
    const original = await error.textContent();
    await switchLanguage(page, "en");
    await expect(error).toHaveText("Sample assets could not load. Refresh to retry.");
    await switchLanguage(page, "zh-CN");
    await expect(error).toHaveText(original!);
    expect(sources).toContain(original);
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]); expect(api.assetBytes.size).toBe(0);
});
