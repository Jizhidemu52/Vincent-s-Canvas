import { test, expect, newCanvas } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

async function uploadSizedImage(page: Page, width: number, height: number) {
    const png = await page.evaluate(({ width, height }) => {
        const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#4b8290"; context.fillRect(0, 0, width, height);
        return canvas.toDataURL("image/png").split(",")[1];
    }, { width, height });
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传素材", exact: true }).click();
    await (await chooser).setFiles({ name: "large-source.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
}

async function openMask(page: Page, node: Locator) {
    await node.click({ position: { x: 35, y: 15 } });
    await node.hover();
    const mask = page.getByRole("button", { name: "局部重绘", exact: true });
    if (await mask.isVisible()) await mask.click();
    else {
        await page.getByRole("button", { name: "更多图片工具", exact: true }).click();
        await page.getByRole("menuitem", { name: "局部重绘", exact: true }).click();
    }
    const dialog = page.getByRole("dialog", { name: "局部遮罩编辑", exact: true });
    await expect(dialog.getByRole("button", { name: "AI 修改", exact: true })).toBeEnabled();
    await dialog.locator('[aria-label="蒙版绘制区"]').hover();
    return dialog;
}

test("大图蒙版笔刷按显示像素绘制，小预览不扫描原图，关闭保护且原尺寸提交", async ({ page, api }, testInfo) => {
    const id = await newCanvas(page);
    await expect(page.getByRole("button", { name: "展开创建面板", exact: true })).toBeVisible();
    await uploadSizedImage(page, 3840, 2160);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const nodeId = api.document(id)!.nodes[0].id;
    const dialog = await openMask(page, page.locator(`[data-node-id="${nodeId}"]`));
    const overlay = dialog.locator('[aria-label="蒙版绘制区"]');
    await expect(overlay).toHaveAttribute("width", "1200");
    await expect(overlay).toHaveAttribute("height", "675");
    await expect(dialog.locator("canvas.hidden")).toHaveAttribute("width", "3840");
    await page.evaluate(() => {
        const prototype = CanvasRenderingContext2D.prototype, original = prototype.getImageData;
        (window as any).maskReads = [];
        prototype.getImageData = function (...args: any[]) {
            if (this.canvas.closest('[role="dialog"]')) (window as any).maskReads.push([this.canvas.width, this.canvas.height, args[2], args[3]]);
            return original.apply(this, args as any);
        };
    });
    const box = (await overlay.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => page.evaluate(() => (window as any).maskReads.length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).maskReads.every((read: number[]) => read[0] <= 1200 && read[1] <= 1200))).toBe(true);
    const stroke = await dialog.locator("canvas.hidden").evaluate((canvas: HTMLCanvasElement) => {
        const pixels = canvas.getContext("2d")!.getImageData(0, 1080, canvas.width, 1).data;
        const selected: number[] = [];
        for (let x = 0; x < canvas.width; x++) if (pixels[x * 4 + 3]) selected.push(x);
        return { width: selected.at(-1)! - selected[0]! + 1, center: (selected.at(-1)! + selected[0]! + 1) / 2 };
    });
    expect(stroke.width * box.width / 3840).toBeCloseTo(40, 0);
    expect(stroke.center).toBeCloseTo(1920, 0);
    await dialog.getByPlaceholder("例如：把选中区域改成金属材质，保持原图光影").fill("仅修改涂抹区域");
    await page.keyboard.press("Escape");
    const discard = page.getByRole("dialog", { name: "放弃本次蒙版编辑？", exact: true });
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(discard).toBeHidden();
    await expect(dialog.getByRole("textbox")).toHaveValue("仅修改涂抹区域");
    await page.mouse.click(10, 10);
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(discard).toBeHidden();
    await dialog.screenshot({ path: testInfo.outputPath("mask-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await dialog.screenshot({ path: testInfo.outputPath("mask-390.png") });
    await dialog.getByRole("button", { name: "AI 修改", exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("button", { name: "AI 修改", exact: true })).toBeInViewport();
    await dialog.screenshot({ path: testInfo.outputPath("mask-390-actions.png") });
    await dialog.getByRole("button", { name: /^取\s*消$/ }).click();
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(discard).toBeHidden();
    await page.setViewportSize({ width: 1800, height: 1200 });
    await dialog.getByRole("button", { name: "AI 修改", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.submissions.length).toBe(1);
    const task = api.submissions[0];
    expect(task.parameters.size).toBe("3840x2160");
    expect(task.sourceUrls).toHaveLength(2);
    const maskId = task.sourceUrls[1].split("/")[3];
    const bytes = api.assetBytes.get(maskId)!;
    expect(bytes).toBeDefined();
    const exported = await page.evaluate(async data => {
        const image = new Image(); image.src = data; await image.decode();
        const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
        return { width: canvas.width, height: canvas.height, center: context.getImageData(1920, 1080, 1, 1).data[3], corner: context.getImageData(0, 0, 1, 1).data[3] };
    }, `data:image/png;base64,${bytes.toString("base64")}`);
    expect(exported).toEqual({ width: 3840, height: 2160, center: 0, corner: 255 });
});

test("图片缩略图失败回退原图，原图失败显示重试且不改动节点", async ({ page, browser, api }) => {
    const id = await newCanvas(page);
    await expect(page.getByRole("button", { name: "展开创建面板", exact: true })).toBeVisible();
    await uploadSizedImage(page, 1600, 1200);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const original = structuredClone(api.document(id)!.nodes[0]);
    let failing = true, thumbnailReads = 0, originalReads = 0;
    // A fresh device has no IndexedDB original to mask a failed server read.
    const context = await browser.newContext({ viewport: { width: 1800, height: 1200 }, serviceWorkers: "block" });
    await api.attach(context);
    const remotePage = await context.newPage();
    try {
    await context.route("**/api/assets/**", route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/thumb")) { thumbnailReads++; return route.fulfill({ status: 503, body: "temporarily unavailable" }); }
        if (url.pathname.endsWith("/content")) { originalReads++; if (failing) return route.fulfill({ status: 503, body: "temporarily unavailable" }); }
        return route.fallback();
    });
    await remotePage.goto(page.url());
    const node = remotePage.locator(`[data-node-id="${original.id}"]`);
    const retry = node.getByRole("button", { name: "重新加载图片", exact: true });
    await expect(retry).toBeVisible();
    expect(thumbnailReads).toBeGreaterThan(0);
    expect(originalReads).toBe(1);
    failing = false;
    await retry.click();
    await expect(retry).toBeHidden();
    await expect.poll(() => node.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(1600);
    expect(originalReads).toBe(2);
    expect(api.document(id)!.nodes[0]).toEqual(original);
    expect(api.submissions).toHaveLength(0);
    } finally { await context.close(); }
});
