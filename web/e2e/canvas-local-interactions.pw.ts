import { test, expect, newCanvas, uploadImage } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

async function selectImage(page: Page, node: Locator) {
    await node.click({ position: { x: 35, y: 15 } });
    await page.mouse.move(20, 1000);
    await expect(node.locator('[data-canvas-resize-handle="top-left"]')).toBeVisible();
    await node.hover();
}

async function openCrop(page: Page, node: Locator) {
    await selectImage(page, node);
    const crop = page.getByRole("button", { name: "裁剪并生成新节点", exact: true });
    if (await crop.isVisible()) await crop.click();
    else {
        await page.getByRole("button", { name: "更多图片工具", exact: true }).click();
        await page.getByRole("menuitem", { name: "裁剪", exact: true }).click();
    }
    const dialog = page.getByRole("dialog", { name: "裁剪图片", exact: true });
    await expect(dialog.getByRole("button", { name: "确认裁剪", exact: true })).toBeEnabled();
    // Wait for the modal's opening transform before deriving pointer coordinates.
    await dialog.getByRole("button", { name: "调整裁剪框右", exact: true }).hover();
    return dialog;
}

async function fitsViewport(page: Page, dialog: Locator) {
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}

test("裁剪自由拖动与比例切换可用，取消保留原图且确认创建新图", async ({ page, api }, testInfo) => {
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "收起创建面板", exact: true }).click();
    await uploadImage(page);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const original = structuredClone(api.document(id)!.nodes[0]);
    const node = page.locator(`[data-node-id="${original.id}"]`);
    await page.setViewportSize({ width: 1280, height: 900 });
    let dialog = await openCrop(page, node);
    const selection = dialog.locator('[aria-label="裁剪选区"]');
    const before = (await selection.boundingBox())!;
    const right = (await dialog.getByRole("button", { name: "调整裁剪框右", exact: true }).boundingBox())!;
    await page.mouse.move(right.x + right.width / 2, right.y + right.height / 2); await page.mouse.down();
    await page.mouse.move(right.x - 45, right.y + right.height / 2, { steps: 8 }); await page.mouse.up();
    const after = (await selection.boundingBox())!;
    expect(after.width).toBeLessThan(before.width - 30);
    expect(after.height).toBeCloseTo(before.height, 0);
    await dialog.getByRole("combobox", { name: "裁剪比例" }).click();
    await page.getByTitle("4:3", { exact: true }).click();
    await expect(dialog.getByRole("combobox", { name: "裁剪比例" })).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".ant-select-dropdown")).toBeHidden();
    const preset = (await selection.boundingBox())!;
    expect(preset.width / preset.height).toBeCloseTo(4 / 3, 1);
    await fitsViewport(page, dialog);
    await dialog.screenshot({ path: testInfo.outputPath("crop-1280.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await fitsViewport(page, dialog);
    await dialog.screenshot({ path: testInfo.outputPath("crop-390.png") });
    await dialog.getByRole("button", { name: /^取\s*消$/ }).click();
    await expect(dialog).toBeHidden();
    expect(api.document(id)!.nodes).toEqual([original]);
    await page.setViewportSize({ width: 1280, height: 900 });
    dialog = await openCrop(page, node);
    await expect(dialog.getByText("自由比例", { exact: true })).toBeVisible();
    await dialog.getByRole("combobox", { name: "裁剪比例" }).click();
    await page.getByTitle("4:3", { exact: true }).click();
    await dialog.getByRole("button", { name: "确认裁剪", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    expect(api.document(id)!.nodes.find((item: any) => item.id === original.id)).toEqual(original);
    const result = api.document(id)!.nodes.find((item: any) => item.id !== original.id);
    expect(result.metadata.naturalWidth / result.metadata.naturalHeight).toBeCloseTo(4 / 3, 1);
    expect(typeof result.metadata.content).toBe("string");
    expect(result.metadata.content).not.toBe(original.metadata.content);
    expect(api.submissions).toHaveLength(0);
});

test("参考图取消后重开不残留，已确认项目不可重复添加且清空后可重选", async ({ page, api }, testInfo) => {
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "收起创建面板", exact: true }).click();
    await uploadImage(page, "first.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    // Existing-image AI editing uses the quick composer. The reference picker
    // belongs to an empty image node's prompt panel, opened through its real menu.
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "图片节点", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    const targetId = api.document(id)!.nodes[1].id;
    await page.getByRole("button", { name: "从画布选择", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "从画布选择参考图", exact: true });
    const choice = dialog.getByRole("button", { name: /^选择参考图 / });
    await choice.click();
    await expect(dialog.getByRole("button", { name: "加入参考图", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: /^取\s*消$/ }).click();
    await page.getByRole("button", { name: "从画布选择", exact: true }).click();
    await expect(choice).toHaveAttribute("aria-pressed", "false");
    await expect(dialog.getByRole("button", { name: "加入参考图", exact: true })).toBeDisabled();
    await choice.click();
    await page.setViewportSize({ width: 390, height: 844 });
    await fitsViewport(page, dialog);
    await dialog.screenshot({ path: testInfo.outputPath("reference-picker-390.png") });
    await dialog.getByRole("button", { name: "加入参考图", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.document(id)?.nodes.find((item: any) => item.id === targetId).metadata.manualImageReferences?.length).toBe(1);
    await page.setViewportSize({ width: 1800, height: 1200 });
    await page.getByRole("button", { name: "从画布选择", exact: true }).click();
    await expect(dialog.getByRole("button", { name: /^已添加 / })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "加入参考图", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: /^取\s*消$/ }).click();
    await page.getByRole("button", { name: /^清\s*空$/ }).click();
    await page.getByRole("button", { name: "从画布选择", exact: true }).click();
    await expect(choice).toHaveAttribute("aria-pressed", "false");
    await expect(dialog.getByRole("button", { name: "加入参考图", exact: true })).toBeDisabled();
    expect(api.submissions).toHaveLength(0);
});
