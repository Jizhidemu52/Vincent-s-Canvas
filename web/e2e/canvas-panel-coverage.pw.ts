import type { Locator, Page } from "@playwright/test";
import { test, expect, newCanvas, uploadImage } from "./fixtures";

async function start(page: Page, width = 1366) {
    await page.setViewportSize({ width, height: 768 });
    const id = await newCanvas(page);
    await expect(page.getByTestId("canvas-onboarding-tour")).toBeHidden();
    await page.getByRole("button", { name: "跟我走一遍", exact: true }).click();
    await page.getByRole("button", { name: "跳过引导", exact: true }).click();
    return id;
}

async function panExposedCanvas(page: Page, x = 1100, y = 580) {
    await expect.poll(() => page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest("[data-canvas-viewport]")), { x, y })).toBe(true);
    const canvas = page.locator("[data-canvas-viewport]");
    const content = canvas.locator(":scope > .origin-top-left");
    const before = await content.getAttribute("style");
    await page.mouse.move(x, y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(x + 30, y + 20, { steps: 4 });
    await expect(canvas).toHaveAttribute("data-cursor-panning", "true");
    await page.mouse.up({ button: "middle" });
    await expect(canvas).toHaveAttribute("data-cursor-panning", "false");
    await expect.poll(() => content.getAttribute("style")).not.toBe(before);
}

async function leftPanelLeavesHalf(page: Page, panel: Locator) {
    await expect(panel).toBeVisible();
    await expect.poll(async () => {
        const box = await panel.boundingBox();
        return box ? box.x + box.width : Infinity;
    }).toBeLessThanOrEqual(page.viewportSize()!.width / 2);
    await panExposedCanvas(page);
}

for (const width of [1280, 1024, 1023, 768, 390]) {
    test(`${width}px 首次进入和刷新均默认收起非模态创建与助手`, async ({ page, api }) => {
        await start(page, width);
        await expect(page.getByTestId("canvas-quick-generate-panel")).toBeHidden();
        await expect(page.locator(".cw-agent-panel")).toBeHidden();
        await page.reload();
        await expect(page.getByTestId("canvas-empty-start")).toBeVisible();
        await expect(page.getByTestId("canvas-quick-generate-panel")).toBeHidden();
        await expect(page.locator(".cw-agent-panel")).toBeHidden();
        expect(api.submissions).toHaveLength(0);
        expect(api.batchSubmissions).toHaveLength(0);
    });
}

test("1366普通助手最大宽度、历史、宽屏及创建大小浮层不阻塞半幅画布", async ({ page, context, api }, testInfo) => {
    await context.route("**/api/generation-capabilities?**", route => route.fulfill({ json: { models: [] } }));
    await start(page);
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    await page.getByRole("separator", { name: "调整创建面板宽度", exact: true }).press("End");
    await leftPanelLeavesHalf(page, page.locator(".cw-create-panel"));
    await page.getByRole("button", { name: "调整面板大小", exact: true }).click();
    await expect(page.getByRole("slider", { name: "面板宽度", exact: true })).toBeVisible();
    await panExposedCanvas(page);
    await page.getByRole("tab", { name: "对话", exact: true }).click();
    await page.getByRole("separator", { name: "调整对话面板宽度", exact: true }).press("End");
    const assistant = page.locator(".cw-agent-panel");
    await leftPanelLeavesHalf(page, assistant);
    await page.getByRole("button", { name: "对话选项", exact: true }).click();
    await page.getByRole("menuitem", { name: "对话历史", exact: true }).click();
    await leftPanelLeavesHalf(page, assistant);
    await page.getByRole("button", { name: "切换为宽屏对话", exact: true }).click();
    await leftPanelLeavesHalf(page, assistant);
    await page.screenshot({ path: testInfo.outputPath("assistant-half-canvas.png") });
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});

for (const name of ["图片节点", "视频节点"]) {
    test(`1366 ${name}内联编辑在50%、100%和200%缩放下保留半幅可操作画布`, async ({ page, api }, testInfo) => {
        const id = await start(page);
        await page.getByRole("button", { name: "更多工具", exact: true }).click();
        await page.getByRole("menuitem", { name, exact: true }).click();
        await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
        const node = page.locator(`[data-node-id="${api.document(id)!.nodes[0].id}"]`);
        const panel = node.locator(":scope > .top-full");
        await expect(panel).toBeVisible();
        for (const scale of [50, 100, 200]) {
            await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
            await page.getByRole("button", { name: `${scale}%`, exact: true }).click();
            await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
            await expect.poll(async () => (await panel.boundingBox())?.width ?? Infinity).toBeLessThanOrEqual(683);
            // Node editors move with canvas content; their narrower free side
            // need not be the fixed right-hand side used by sidebar panels.
            const box = (await panel.boundingBox())!;
            const x = box.x >= 100 ? 60 : 1300;
            await panExposedCanvas(page, x, 150);
            await expect(panel).toBeVisible();
        }
        await page.screenshot({ path: testInfo.outputPath("inline-editor-200.png") });
        expect(api.submissions).toHaveLength(0);
        expect(api.batchSubmissions).toHaveLength(0);
    });
}

test("1366素材、命令、导出属于短暂模态，关闭后画布恢复实际平移", async ({ page, api }) => {
    await start(page);
    await page.getByRole("button", { name: "我的素材", exact: true }).click();
    const assets = page.getByRole("dialog", { name: "选择素材", exact: true });
    await expect(assets).toBeVisible();
    await expect(assets).toHaveAttribute("aria-modal", "true");
    await assets.locator(".ant-modal-close").click();
    await expect(assets).toBeHidden();
    await panExposedCanvas(page);
    await page.keyboard.press("Control+k");
    const commands = page.getByRole("dialog", { name: "命令与搜索", exact: true });
    await expect(commands).toBeVisible();
    await expect(commands).toHaveAttribute("aria-modal", "true");
    await page.keyboard.press("Escape");
    await expect(commands).toBeHidden();
    await panExposedCanvas(page);
    await uploadImage(page);
    await expect(page.locator(".node-element")).toHaveCount(1);
    await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "导出图片集 / PDF", exact: true }).click();
    const exporting = page.getByRole("dialog", { name: "导出图片集", exact: true });
    await expect(exporting).toBeVisible();
    await expect(exporting).toHaveAttribute("aria-modal", "true");
    await exporting.locator(".ant-modal-close").click();
    await expect(exporting).toBeHidden();
    await panExposedCanvas(page);
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});

test("1366节点内联编辑高缩放不因最小逻辑宽度突破半屏", async ({ page, api }, testInfo) => {
    const id = await start(page);
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "图片节点", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const original = structuredClone(api.document(id)!.nodes[0]);
    const panel = page.locator(`[data-node-id="${api.document(id)!.nodes[0].id}"] > .top-full`);
    await expect(panel).toBeVisible();
    await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
    const zoom = page.getByRole("slider", { name: "放大/缩小画布", exact: true });
    // The public slider is logarithmic (5%–1600%). Two native large steps
    // below its maximum reach about 505%, preserving the high-zoom assertion.
    await zoom.press("End");
    await zoom.press("PageDown");
    await zoom.press("PageDown");
    await expect.poll(() => api.document(id)?.viewport.k ?? 0).toBeGreaterThan(4.2);
    await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
    for (let attempt = 0; attempt < 12; attempt++) {
        const box = (await panel.boundingBox())!;
        if (box.y <= 150) break;
        await page.mouse.move(1100, 600);
        await page.mouse.down({ button: "middle" });
        await page.mouse.move(1100, 600 - Math.min(450, box.y - 130), { steps: 5 });
        await page.mouse.up({ button: "middle" });
    }
    await expect(panel).toBeInViewport();
    await expect.poll(async () => (await panel.boundingBox())?.width ?? Infinity).toBeLessThanOrEqual(683);
    await panel.locator("textarea").fill("高倍率仍可编辑提示词");
    await expect.poll(() => api.document(id)?.nodes[0].metadata.draftPrompt).toBe("高倍率仍可编辑提示词");
    await panel.getByRole("button", { name: "从画布选择", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "从画布选择参考图", exact: true });
    await expect(picker).toBeVisible();
    await picker.locator(".ant-modal-close").click();
    await panExposedCanvas(page, 1200, 180);
    await expect(panel).toBeInViewport();
    await expect.poll(() => ({ width: api.document(id)?.nodes[0].width, height: api.document(id)?.nodes[0].height })).toEqual({ width: original.width, height: original.height });
    await page.screenshot({ path: testInfo.outputPath("high-zoom-editor.png") });
    expect(api.submissions).toHaveLength(0);
});
