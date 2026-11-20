import { readFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import { test, expect, type MockCanvasApi } from "./fixtures";
import { performanceRaster } from "./canvas-performance-fixture";

const projectId = "51000000-0000-4000-8000-000000000113";
const sources = [
    { nodeId: "cloud-only", assetId: "51000000-0000-4000-8000-000000000001", title: "仅云端原图", blue: 31 },
    { nodeId: "expired-blob", assetId: "51000000-0000-4000-8000-000000000002", title: "过期本地原图", blue: 211 },
].map(source => ({ ...source, bytes: performanceRaster(source.blue, 1024, 1024) }));

function seedCloudImages(api: MockCanvasApi) {
    const now = new Date().toISOString();
    const nodes = sources.map((source, index) => {
        api.assetBytes.set(source.assetId, source.bytes);
        api.assets.set(source.assetId, { id: source.assetId, kind: "image", status: "ready", mimeType: "image/png", filename: `${source.title}.png`, contentUrl: `/api/assets/${source.assetId}/content` });
        return { id: source.nodeId, type: "image", title: source.title, width: 256, height: 256, position: { x: 500 + index * 420, y: 300 }, metadata: {
            serverAssetId: source.assetId, naturalWidth: 1024, naturalHeight: 1024, mimeType: "image/png", status: "success",
            ...(index === 1 ? { content: "blob:http://127.0.0.1:5199/expired-original", storageKey: "image:expired-cloud-original" } : {}),
        } };
    });
    const document = { id: projectId, title: "云端原图操作回归", createdAt: now, updatedAt: now, nodes, connections: [], groups: [], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "dots", showImageInfo: false, chatSessions: [], activeChatId: null, history: { past: [], future: [] } };
    api.documents.set(projectId, { id: projectId, revision: 1, deleted: false, document, updatedAt: now });
    return structuredClone(nodes);
}

async function selectImage(page: Page, nodeId: string) {
    const node = page.locator(`[data-node-id="${nodeId}"]`);
    await node.click({ position: { x: 35, y: 15 } });
    await node.hover();
    await expect(page.getByRole("toolbar", { name: "图片工具栏", exact: true })).toBeVisible();
    return node;
}

async function imageAction(page: Page, nodeId: string, buttonName: string, menuName = buttonName) {
    await selectImage(page, nodeId);
    const button = page.getByRole("toolbar", { name: "图片工具栏", exact: true }).getByRole("button", { name: buttonName, exact: true });
    if (await button.isVisible()) await button.click();
    else {
        await page.getByRole("button", { name: "更多图片工具", exact: true }).click();
        await page.getByRole("menuitem", { name: menuName, exact: true }).click();
    }
}

async function canvasPixel(canvas: Locator) {
    return canvas.evaluate((element: HTMLCanvasElement) => ({ width: element.width, height: element.height, pixel: [...element.getContext("2d")!.getImageData(83, 129, 1, 1).data] }));
}

async function clipboardPixel(page: Page) {
    return page.evaluate(async () => {
        const item = (await navigator.clipboard.read()).find(value => value.types.includes("image/png"));
        if (!item) return null;
        const bitmap = await createImageBitmap(await item.getType("image/png"));
        try {
            const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
            const context = canvas.getContext("2d")!; context.drawImage(bitmap, 0, 0);
            return { width: canvas.width, height: canvas.height, pixel: [...context.getImageData(83, 129, 1, 1).data] };
        } finally { bitmap.close(); }
    });
}

for (const source of sources) {
    test(`${source.title}：仅显式操作读取原件，复制编辑下载裁剪和比较保持正确来源`, async ({ page, context, api }, info) => {
        test.setTimeout(120_000);
        const originalNodes = seedCloudImages(api);
        await context.route(/\/api\/assets\/[^/]+\/thumb(?:\?.*)?$/, route => {
            const image = sources.find(item => item.assetId === new URL(route.request().url()).pathname.split("/")[3]);
            return image ? route.fulfill({ contentType: "image/png", body: performanceRaster(image.blue, 256, 256) }) : route.fallback();
        });
        const originalRequests: string[] = [], thumbnailRequests: string[] = [];
        page.on("request", request => {
            const path = new URL(request.url()).pathname;
            if (/^\/api\/assets\/[^/]+\/content$/.test(path)) originalRequests.push(path);
            if (/^\/api\/assets\/[^/]+\/thumb$/.test(path)) thumbnailRequests.push(path);
        });
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.goto(`/canvas/${projectId}`);
        const expectedImages = await page.evaluate(async inputs => Promise.all(inputs.map(async input => {
            const image = new Image(); image.src = input.dataUrl; await image.decode();
            const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
            const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
            return { nodeId: input.nodeId, width: canvas.width, height: canvas.height, pixel: [...context.getImageData(83, 129, 1, 1).data] };
        })), sources.map(image => ({ nodeId: image.nodeId, dataUrl: `data:image/png;base64,${image.bytes.toString("base64")}` })));
        const expectedImage = expectedImages.find(image => image.nodeId === source.nodeId)!;
        const expectedPixels = { width: expectedImage.width, height: expectedImage.height, pixel: expectedImage.pixel };
        const skip = page.getByRole("button", { name: "跳过引导", exact: true });
        if (await skip.isVisible()) await skip.click();
        const collapse = page.getByRole("button", { name: "收起创建面板", exact: true });
        if (await collapse.isVisible()) await collapse.click();
        for (const image of sources) {
            const node = await selectImage(page, image.nodeId);
            await expect.poll(() => node.locator("img").first().evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
            await page.getByRole("button", { name: "更多图片工具", exact: true }).click();
            await expect(page.getByRole("menuitem", { name: "复制图片", exact: true })).toBeVisible();
            expect(originalRequests).toEqual([]);
            await page.keyboard.press("Escape");
        }
        expect(thumbnailRequests.length).toBeGreaterThanOrEqual(2);
        expect(originalRequests).toEqual([]);
        await page.screenshot({ path: info.outputPath(`${source.nodeId}-idle-thumbnails.png`), animations: "disabled" });

        await page.evaluate(() => navigator.clipboard.writeText("等待显式复制云端原图"));
        await imageAction(page, source.nodeId, "复制图片");
        await expect(page.getByText("图片已复制，可粘贴到其他应用", { exact: true })).toBeVisible();
        await expect.poll(() => clipboardPixel(page)).toEqual(expectedPixels);
        expect(originalRequests).toContain(`/api/assets/${source.assetId}/content`);

        await imageAction(page, source.nodeId, "编辑图片");
        const editor = page.getByRole("dialog", { name: "编辑图片", exact: true });
        const preview = editor.getByLabel("编辑图片预览", { exact: true });
        await expect(preview).toBeVisible();
        await expect.poll(() => canvasPixel(preview)).toEqual(expectedPixels);
        await expect(editor.getByRole("button", { name: "确定并保存", exact: true })).toBeDisabled();
        await editor.screenshot({ path: info.outputPath(`${source.nodeId}-editor-original.png`), animations: "disabled" });
        await editor.getByRole("button", { name: /^取\s*消$/ }).click();
        await expect(editor).toBeHidden();

        const downloadPromise = page.waitForEvent("download");
        await imageAction(page, source.nodeId, "下载图片", "下载");
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe(`${source.title}_v1.png`);
        expect(await readFile((await download.path())!)).toEqual(source.bytes);

        await imageAction(page, source.nodeId, "裁剪并生成新节点", "裁剪");
        const crop = page.getByRole("dialog", { name: "裁剪图片", exact: true });
        await expect(crop.getByRole("button", { name: "确认裁剪", exact: true })).toBeEnabled();
        expect(await crop.locator("img").evaluate(async (element: HTMLImageElement) => {
            await element.decode();
            const canvas = document.createElement("canvas"); canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
            const context = canvas.getContext("2d")!; context.drawImage(element, 0, 0);
            return { width: canvas.width, height: canvas.height, pixel: [...context.getImageData(83, 129, 1, 1).data] };
        })).toEqual(expectedPixels);
        await crop.screenshot({ path: info.outputPath(`${source.nodeId}-crop-original.png`), animations: "disabled" });
        await crop.getByRole("button", { name: /^取\s*消$/ }).click();
        await expect(crop).toBeHidden();

        await imageAction(page, source.nodeId, "原位滑块位于结果图下方；此处打开差异图、并排、叠加和 PNG 导出工具", "高级对比 · 差异图与导出");
        const compare = page.getByRole("dialog", { name: "改款前后对比", exact: true });
        await expect(compare).toBeVisible();
        await expect(compare.getByRole("button", { name: "选择改款后图片", exact: true })).toContainText(source.title);
        await compare.getByRole("button", { name: "选择改款前图片", exact: true }).click();
        const picker = page.getByRole("dialog", { name: "选择改款前图片", exact: true });
        const other = sources.find(image => image.nodeId !== source.nodeId)!;
        await expect(picker.locator(`[data-compare-candidate="${source.nodeId}"]`)).toHaveCount(0);
        await picker.locator(`[data-compare-candidate="${other.nodeId}"]`).click();
        const comparison = compare.getByLabel("改款前后对比预览", { exact: true });
        await expect(comparison).toBeVisible();
        await compare.locator(".ant-segmented-item-label").filter({ hasText: /^差异图$/ }).click();
        await expect(compare.getByRole("radio", { name: "差异图", exact: true })).toBeChecked();
        const difference = Math.max(...expectedImages[0].pixel.map((channel, index) => Math.abs(channel - expectedImages[1].pixel[index])));
        await expect.poll(() => canvasPixel(comparison)).toEqual({ width: 1024, height: 1024, pixel: [difference, difference, difference, 255] });
        await expect(compare.getByRole("button", { name: "导出预览 PNG", exact: true })).toBeEnabled();
        await compare.screenshot({ path: info.outputPath(`${source.nodeId}-compare-originals.png`), animations: "disabled" });
        await compare.locator(".ant-modal-close").click();
        await expect(compare).toBeHidden();
        for (const image of sources) expect(originalRequests).toContain(`/api/assets/${image.assetId}/content`);
        expect(api.document(projectId)!.nodes).toEqual(originalNodes);
        for (const image of sources) expect(api.assetBytes.get(image.assetId)).toEqual(image.bytes);
        expect(api.submissions).toEqual([]);
        expect(api.batchSubmissions).toEqual([]);
        await info.attach("cloud-original-requests.json", { contentType: "application/json", body: JSON.stringify({ originalRequests, thumbnailRequests, providerSubmissions: api.submissions.length }) });
    });
}
