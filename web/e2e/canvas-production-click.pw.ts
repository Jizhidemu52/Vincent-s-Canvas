import { test, expect, newCanvas, uploadImage } from "./fixtures";

test("线上正式包：连续点击上传图片、打开工具栏、刷新后再点击均不白屏", async ({ page, api }, testInfo) => {
    test.setTimeout(120000);
    const id = await newCanvas(page);
    const skip = page.getByRole("button", { name: "跳过引导", exact: true });
    if (await skip.isVisible()) await skip.click();
    for (let index = 0; index < 3; index++) {
        await uploadImage(page, `点击验证-${index}.png`);
        await expect.poll(() => api.document(id)?.nodes.length).toBe(index + 1);
        const image = api.document(id)!.nodes.find((node: any) => node.title === `点击验证-${index}.png`);
        const node = page.locator(`[data-node-id="${image.id}"]`);
        await node.click({ position: { x: 35, y: 15 } });
        await expect(page.getByRole("toolbar", { name: "图片工具栏", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "上传素材", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "更多图片工具", exact: true }).click();
        await expect(page.getByRole("menuitem", { name: "自定义工具", exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        await page.reload();
        await expect(node).toBeVisible();
        await node.click({ position: { x: 35, y: 15 } });
        await expect(page.getByRole("toolbar", { name: "图片工具栏", exact: true })).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath("production-click-images.png") });
    expect(api.submissions).toHaveLength(0);
});

test("线上正式包：生成任务进行中点击已有图、完成后点击结果以及刷新恢复", async ({ page, api }, testInfo) => {
    test.setTimeout(120000);
    api.taskStatus = "processing";
    const id = await newCanvas(page);
    const skip = page.getByRole("button", { name: "跳过引导", exact: true });
    if (await skip.isVisible()) await skip.click();
    await uploadImage(page, "任务中原图.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const originalId = api.document(id)!.nodes[0].id;
    const panel = page.getByTestId("canvas-quick-generate-panel");
    if (!await panel.isVisible()) await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    await panel.getByRole("textbox", { name: "描述图像", exact: true }).fill("隔离任务状态测试，不提交真实模型");
    await panel.locator("button.cw-generate-button").click();
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect(page).toHaveTitle(/^\(0\/1\)/);
    await page.getByRole("button", { name: "收起创建面板", exact: true }).click();
    const original = page.locator(`[data-node-id="${originalId}"]`);
    await original.click({ position: { x: 35, y: 15 } });
    await expect(page.getByRole("toolbar", { name: "图片工具栏", exact: true })).toBeVisible();
    await page.reload();
    await expect(original).toBeVisible();
    await original.click({ position: { x: 35, y: 15 } });
    await expect(page.getByRole("toolbar", { name: "图片工具栏", exact: true })).toBeVisible();
    const task = [...api.tasks.values()][0];
    task.status = "success"; task.resultUrls = [`/api/assets/${task.id}/content`];
    await expect(page).not.toHaveTitle(/^\(0\/1\)/);
    await expect.poll(() => api.document(id)?.nodes.filter((node: any) => node.type === "image" && node.metadata?.content).length).toBe(2);
    const result = api.document(id)!.nodes.find((node: any) => node.type === "image" && node.id !== originalId);
    await page.locator(`[data-node-id="${result.id}"]`).click({ position: { x: 35, y: 15 } });
    await expect(page.getByRole("toolbar", { name: "图片工具栏", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("production-generated-click.png") });
    expect(api.submissions).toHaveLength(1);
});

for (const preference of ["legacy", "malformed"]) {
    test(`线上正式包：已有图片来源与${preference}工具栏偏好点击不白屏`, async ({ page, context, api }, testInfo) => {
        await context.addInitScript((kind) => {
            localStorage.setItem("canvas-image-quick-tools-v6", kind === "legacy"
                ? JSON.stringify(["manualEdit", "edit", "download", "copyPrompt", "crop", "resize"])
                : "{invalid preference");
        }, preference);
        const id = await newCanvas(page);
        const skip = page.getByRole("button", { name: "跳过引导", exact: true });
        if (await skip.isVisible()) await skip.click();
        await uploadImage(page, "已有图片.png");
        await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
        await page.goto("/canvas");
        await expect(page.getByRole("button", { name: "新建画布", exact: true }).first()).toBeVisible();
        const record = api.documents.get(id)!;
        const node = record.document!.nodes[0];
        node.metadata.references = ["/api/assets/previous-input/content"];
        node.metadata.compareSources = [{ type: "image", content: "/api/assets/previous-input/content", label: "已移出画布的来源图" }];
        node.metadata.imageName = "已有图片";
        node.metadata.imageVersion = 2;
        record.revision++;
        record.updatedAt = new Date().toISOString();
        await page.goto(`/canvas/${id}`);
        await page.locator(`[data-node-id="${node.id}"]`).click({ position: { x: 35, y: 15 } });
        await expect(page.getByRole("toolbar", { name: "图片工具栏", exact: true })).toBeVisible();
        await expect(page.getByRole("slider", { name: "原图与修改后对比", exact: true })).toBeEnabled();
        await page.getByRole("button", { name: "更多图片工具", exact: true }).click();
        await expect(page.getByRole("menuitem", { name: "自定义工具", exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        await page.screenshot({ path: testInfo.outputPath(`production-sources-${preference}.png`) });
        expect(api.submissions).toHaveLength(0);
    });
}
