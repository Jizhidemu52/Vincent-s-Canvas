import { test, expect, newCanvas, uploadImage, IMAGE } from "./fixtures";

for (const action of ["remove-background", "hd-upscale"] as const) {
    test(`${action} standalone uses a fixed server recipe with no prompt or model input`, async ({ page, api }, testInfo) => {
        const title = action === "remove-background" ? "一键去背景" : "高清放大";
        await page.goto(`/${action}`);
        await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
        await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
        await expect(page.getByRole("textbox", { name: "图像提示词" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "调整", exact: true })).toHaveCount(0);
        await expect(page.getByText(/内置配方|Nano 2\.1|MAI|4K|无需填写提示词/)).toHaveCount(0);
        const submit = page.getByRole("button", { name: title, exact: true });
        await expect(submit).toBeDisabled();
        await page.locator('input[type="file"]').setInputFiles({ name: "原图.png", mimeType: "image/png", buffer: IMAGE });
        await expect(submit).toBeEnabled(); await submit.click();
        await expect.poll(() => api.submissions.length).toBe(1);
        expect(api.submissions[0]).toMatchObject({ toolKey: action === "hd-upscale" ? "detail-enhance" : "image-edit", operationType: action === "hd-upscale" ? "upscale" : "inpaint", parameters: { quickImageAction: action } });
        expect(api.submissions[0]).not.toHaveProperty("prompt"); expect(api.submissions[0]).not.toHaveProperty("modelConfigId");
        await expect(page.getByRole("button", { name: "下载", exact: true })).toBeVisible();
        await expect.poll(() => page.getByRole("img", { name: "生成结果 1", exact: true }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
        await page.screenshot({ path: testInfo.outputPath(`${action}-desktop.png`), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`${action}-390.png`), fullPage: true });
    });
}

test("an unresolved standalone request only refreshes its original task and cannot resubmit", async ({ page, api }) => {
    api.taskStatus = "paused";
    await page.goto("/remove-background");
    await page.locator('input[type="file"]').setInputFiles({ name: "原图.png", mimeType: "image/png", buffer: IMAGE });
    await page.getByRole("button", { name: "一键去背景", exact: true }).click();
    await expect(page.getByText("提交结果待核查", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "一键去背景", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    expect(api.submissions).toHaveLength(1);
});

test("selected canvas images show right-side actions, preserve the original and produce recoverable new nodes", async ({ page, api }, testInfo) => {
    const id = await newCanvas(page); await uploadImage(page, "保留原图.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const original = structuredClone(api.document(id)!.nodes[0]);
    const panel = page.getByTestId("canvas-image-quick-actions");
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/内置配方|Nano 2\.1|MAI|4K/)).toHaveCount(0);
    const bounds = (await panel.boundingBox())!; expect(bounds.x).toBeGreaterThan(1000);
    await expect(panel.getByRole("button", { name: "高清放大", exact: true })).toHaveCSS("color", "rgb(23, 23, 23)");
    await page.screenshot({ path: testInfo.outputPath("canvas-actions-light.png") });
    await panel.getByRole("button", { name: "一键去背景", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect.poll(() => api.document(id)?.nodes[1]?.metadata?.status).toBe("success");
    expect(api.document(id)!.nodes[0]).toEqual(original);
    expect(api.submissions[0]).toMatchObject({ toolKey: "canvas-edit", operationType: "inpaint", parameters: { quickImageAction: "remove-background" } });
    expect(api.document(id)!.nodes[1].metadata.generationRecord.sourceNodeId).toBe(original.id);
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    await expect(panel.getByRole("button", { name: "高清放大", exact: true })).toHaveCSS("color", "rgb(242, 242, 242)");
    await page.mouse.move(800, 700);
    await page.screenshot({ path: testInfo.outputPath("canvas-actions-dark.png") });
    await panel.getByRole("button", { name: "高清放大", exact: true }).hover();
    await expect(panel.getByRole("button", { name: "高清放大", exact: true })).toHaveCSS("background-color", "rgb(48, 48, 48)");
    await page.screenshot({ path: testInfo.outputPath("canvas-actions-dark-hover.png") });
    api.taskStatus = "paused";
    await panel.getByRole("button", { name: "高清放大", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(2);
    await expect(panel.getByRole("button", { name: "高清放大", exact: true })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "高清放大", exact: true })).toHaveCSS("color", "rgb(163, 163, 163)");
    await page.mouse.move(800, 700);
    await page.screenshot({ path: testInfo.outputPath("canvas-actions-dark-disabled.png") });
    await page.getByRole("button", { name: "切换到浅色主题", exact: true }).click();
    await expect(panel.getByRole("button", { name: "高清放大", exact: true })).toHaveCSS("color", "rgb(104, 104, 104)");
    await page.screenshot({ path: testInfo.outputPath("canvas-actions-light-disabled.png") });
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel).toBeVisible(); const small = (await panel.boundingBox())!;
    expect(small.x).toBeGreaterThanOrEqual(0); expect(small.x + small.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath("canvas-actions-390.png") });
});
