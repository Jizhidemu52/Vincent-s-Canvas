import { test, expect, newCanvas } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

async function alpha(canvas: Locator, x: number, y: number) {
    return canvas.evaluate((element: HTMLCanvasElement, point) => element.getContext("2d")!.getImageData(point.x, point.y, 1, 1).data[3], { x, y });
}

async function openEraser(page: Page, nodeId: string) {
    await page.locator(`[data-node-id="${nodeId}"]`).click({ position: { x: 35, y: 15 } });
    await page.getByRole("button", { name: "擦除像素并另存透明 PNG，原图保留", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "编辑图片", exact: true });
    await expect(dialog.getByRole("button", { name: "橡皮擦", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByLabel("图片编辑画布")).toBeVisible();
    await expect(dialog).not.toHaveClass(/ant-zoom-(?:enter|appear)/);
    await expect(dialog).toHaveCSS("transform", "none");
    return dialog;
}

test("canvas eraser previews transparent pixels, supports undo/redo/cancel, and saves a new PNG without changing the JPEG source", async ({ page, api }, testInfo) => {
    const id = await newCanvas(page);
    const jpeg = await page.evaluate(() => {
        const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 240;
        const context = canvas.getContext("2d")!; context.fillStyle = "#2f6d91"; context.fillRect(0, 0, 320, 240);
        return canvas.toDataURL("image/jpeg").split(",")[1];
    });
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传素材", exact: true }).click();
    await (await chooser).setFiles({ name: "eraser-original.jpg", mimeType: "image/jpeg", buffer: Buffer.from(jpeg, "base64") });
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const original = structuredClone(api.document(id)!.nodes[0]);
    const originalAssets = new Map(api.assetBytes);
    const dialog = await openEraser(page, original.id);
    await expect(dialog.getByLabel("绘制颜色")).toHaveCount(0);
    const brush = dialog.getByRole("slider");
    await brush.focus(); await page.keyboard.press("End");
    await expect(brush).toHaveAttribute("aria-valuenow", "80");
    const overlay = dialog.getByLabel("图片编辑画布"), preview = dialog.getByLabel("编辑图片预览");
    const box = (await overlay.boundingBox())!;
    await page.mouse.move(box.x + box.width * .4, box.y + box.height * .5); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .6, box.y + box.height * .5, { steps: 5 });
    await expect.poll(() => alpha(overlay, 160, 120)).toBe(0);
    await expect.poll(() => alpha(overlay, 5, 5)).toBe(255);
    expect(await alpha(preview, 160, 120)).toBe(255);
    await expect(preview).toHaveCSS("visibility", "hidden");
    await page.mouse.up();
    await expect.poll(() => alpha(preview, 160, 120)).toBe(0);
    expect(await alpha(preview, 5, 5)).toBe(255);
    await dialog.getByRole("button", { name: "撤销图片编辑", exact: true }).click();
    expect(await alpha(preview, 160, 120)).toBe(255);
    await expect(dialog.getByRole("button", { name: "确定并保存", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "重做图片编辑", exact: true }).click();
    expect(await alpha(preview, 160, 120)).toBe(0);
    await dialog.getByRole("button", { name: /^取\s*消$/ }).click();
    await page.getByRole("dialog", { name: "放弃这次图片编辑？", exact: true }).getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(api.document(id)!.nodes).toEqual([original]);
    expect(api.assetBytes).toEqual(originalAssets);

    const reopened = await openEraser(page, original.id);
    const nextOverlay = reopened.getByLabel("图片编辑画布"), nextPreview = reopened.getByLabel("编辑图片预览");
    expect(await alpha(nextPreview, 160, 120)).toBe(255);
    const nextBox = (await nextOverlay.boundingBox())!;
    await page.mouse.click(nextBox.x + nextBox.width / 2, nextBox.y + nextBox.height / 2);
    await expect.poll(() => alpha(nextPreview, 160, 120)).toBe(0);
    await reopened.screenshot({ path: testInfo.outputPath("canvas-eraser-transparent.png") });
    await reopened.getByRole("button", { name: "确定并保存", exact: true }).click();
    await expect(reopened).toBeHidden();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    const saved = api.document(id)!;
    expect(saved.nodes[0]).toEqual(original);
    expect(saved.nodes[1].metadata).toMatchObject({ mimeType: "image/png", naturalWidth: 320, naturalHeight: 240, imageVersion: 2 });
    expect(saved.connections).toEqual([expect.objectContaining({ fromNodeId: original.id, toNodeId: saved.nodes[1].id })]);
    for (const [assetId, bytes] of originalAssets) expect(api.assetBytes.get(assetId)).toEqual(bytes);
    const derived = [...api.assetBytes].find(([assetId]) => !originalAssets.has(assetId))![1];
    expect([...derived.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const decoded = await page.evaluate(async data => {
        const image = new Image(); image.src = data; await image.decode();
        const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
        return { center: context.getImageData(160, 120, 1, 1).data[3], corner: context.getImageData(5, 5, 1, 1).data[3] };
    }, `data:image/png;base64,${derived.toString("base64")}`);
    expect(decoded).toEqual({ center: 0, corner: 255 });
    expect(api.submissions).toEqual([]);
    await page.reload();
    await expect(page.locator(`[data-node-id="${saved.nodes[1].id}"]`)).toBeVisible();
    expect(api.document(id)!.nodes[0]).toEqual(original);
});

test("eraser replay respects selection clipping, restores paint composition and can undo by replaying only committed history", async ({ page, api }) => {
    await newCanvas(page);
    const result = await page.evaluate(async () => {
        const { renderEditorDocument } = await import("/src/lib/canvas/image-editor-document.ts");
        const source = document.createElement("canvas"); source.width = source.height = 64;
        const sourceContext = source.getContext("2d")!; sourceContext.fillStyle = "red"; sourceContext.fillRect(0, 0, 64, 64);
        const image = new Image(); image.src = source.toDataURL(); await image.decode();
        const canvas = document.createElement("canvas");
        const erase = { kind: "erase", points: [{ x: 10, y: 32 }, { x: 54, y: 32 }], width: 20, color: "transparent", clip: { x: 24, y: 0, width: 16, height: 64 } };
        renderEditorDocument(canvas, image, [erase]);
        const context = canvas.getContext("2d")!;
        const erased = [16, 32, 48].map(x => context.getImageData(x, 32, 1, 1).data[3]);
        renderEditorDocument(canvas, image, [erase, { kind: "brush", points: [{ x: 32, y: 32 }], width: 4, color: "blue" }]);
        const painted = [...context.getImageData(32, 32, 1, 1).data];
        renderEditorDocument(canvas, image, []);
        const undone = context.getImageData(32, 32, 1, 1).data[3];
        renderEditorDocument(canvas, image, [{ ...erase, points: [{ x: 32, y: 32 }, { x: 32, y: 32 }] }]);
        return { erased, painted, undone, dot: context.getImageData(32, 32, 1, 1).data[3], original: sourceContext.getImageData(32, 32, 1, 1).data[3] };
    });
    expect(result).toEqual({ erased: [255, 0, 255], painted: [0, 0, 255, 255], undone: 255, dot: 0, original: 255 });
    expect(api.submissions).toEqual([]);
});
