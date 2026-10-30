import type { Locator, Page } from "@playwright/test";
import { test, expect, newCanvas, uploadImage, IMAGE } from "./fixtures";

async function moveNode(page: Page, node: Locator, x: number, y: number) {
    const box = (await node.boundingBox())!;
    await page.mouse.move(box.x + 30, box.y + 15);
    await page.mouse.down();
    await page.mouse.move(x + 30, y + 15, { steps: 8 });
    await page.mouse.up();
}

async function decodedImages(nodes: Locator[]) {
    const pixels: number[][] = [], sources: string[] = [];
    for (const node of nodes) {
        await expect(node.getByTestId("canvas-node-overview")).toHaveCount(0);
        const image = node.locator("img[data-canvas-image-resolution]");
        await expect(image).toBeVisible();
        await expect(image).toBeInViewport({ ratio: .9 });
        await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0 && getComputedStyle(element).opacity === "1" && getComputedStyle(element).filter === "none")).toBe(true);
        const decoded = await image.evaluate(async (element: HTMLImageElement) => {
            await element.decode();
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 1;
            const context = canvas.getContext("2d")!;
            context.drawImage(element, Math.floor(element.naturalWidth / 2), Math.floor(element.naturalHeight / 2), 1, 1, 0, 0, 1, 1);
            return { src: element.currentSrc, pixel: Array.from(context.getImageData(0, 0, 1, 1).data) };
        });
        sources.push(decoded.src);
        pixels.push(decoded.pixel);
    }
    expect(sources[0]).not.toBe(sources[1]);
    // Distinct URLs are insufficient: verify the actual decoded pixels too.
    expect(pixels).toEqual([[128, 128, 160, 255], [20, 120, 220, 255]]);
}

test("不同原图在低缩放失选、多选、单选焦点和AI编辑后仍真实解码显示", async ({ page, api }, testInfo) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const id = await newCanvas(page);
    await expect(page.getByTestId("canvas-onboarding-tour")).toBeHidden();
    await page.getByRole("button", { name: "跟我走一遍", exact: true }).click();
    await page.getByRole("button", { name: "跳过引导", exact: true }).click();
    await uploadImage(page, "gradient-reference.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const first = page.locator(`[data-node-id="${api.document(id)!.nodes[0].id}"]`);
    await moveNode(page, first, 300, 200);

    // A genuinely different, larger PNG exercises derivative selection as well
    // as lazy/effect loading. This only constructs an isolated test fixture.
    const secondBytes = Buffer.from(await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1024;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "rgb(20, 120, 220)";
        context.fillRect(0, 0, 1024, 1024);
        return canvas.toDataURL("image/png").split(",")[1];
    }), "base64");
    expect(secondBytes.equals(IMAGE)).toBe(false);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传素材", exact: true }).click();
    await (await chooser).setFiles({ name: "blue-reference.png", mimeType: "image/png", buffer: secondBytes });
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    const second = page.locator(`[data-node-id="${api.document(id)!.nodes[1].id}"]`);
    await moveNode(page, second, 600, 100);
    const nodes = [first, second];
    const sources = () => api.document(id)!.nodes.map((node: any) => ({ id: node.id, content: node.metadata.content, storageKey: node.metadata.storageKey, naturalWidth: node.metadata.naturalWidth, naturalHeight: node.metadata.naturalHeight }));
    const originalSources = structuredClone(sources());
    await expect(first).not.toHaveAttribute("aria-label", /已选择/);
    await decodedImages(nodes);

    await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
    await page.getByRole("button", { name: "25%", exact: true }).click();
    await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
    await expect.poll(() => api.document(id)?.viewport.k).toBe(.25);

    await test.step("失去选择后两张图都不是空概览", async () => {
        await page.mouse.click(1100, 550);
        await expect.poll(() => api.document(id)?.selectedNodeIds).toEqual([]);
        await decodedImages(nodes);
        for (const node of nodes) await expect(node.locator("[data-canvas-resize-handle]")).toHaveCount(0);
    });
    await test.step("多选保留两张解码图且不挂载逐节点缩放控件", async () => {
        await page.keyboard.press("Control+a");
        await expect.poll(() => api.document(id)?.selectedNodeIds.length).toBe(2);
        await decodedImages(nodes);
        for (const node of nodes) await expect(node.locator("[data-canvas-resize-handle]")).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath("two-images-low-zoom-multiselect.png") });
    });
    await test.step("单选、键盘焦点和打开AI编辑继续保留真实图片", async () => {
        // Clicking a member of an existing multi-selection intentionally keeps
        // the group selected for dragging; clear it before selecting one node.
        await page.mouse.click(1100, 550);
        await first.click();
        await expect.poll(() => api.document(id)?.selectedNodeIds).toEqual([originalSources[0].id]);
        await decodedImages(nodes);
        await first.focus();
        await expect(first).toBeFocused();
        await expect(first.locator('[data-canvas-resize-handle="top-left"]')).toBeVisible();
        await decodedImages(nodes);
        await first.press("Enter");
        await expect(page.getByTestId("canvas-quick-generate-panel")).toBeVisible();
        await decodedImages(nodes);
        await page.screenshot({ path: testInfo.outputPath("two-images-low-zoom-editor.png") });
    });
    expect(sources()).toEqual(originalSources);
    expect([...api.assetBytes.values()].some(bytes => bytes.equals(IMAGE))).toBe(true);
    expect([...api.assetBytes.values()].some(bytes => bytes.equals(secondBytes))).toBe(true);
    await page.reload();
    await expect(page.getByRole("button", { name: "画布缩放与视图", exact: true })).toContainText("25%");
    await decodedImages(nodes);
    expect(sources()).toEqual(originalSources);
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});
