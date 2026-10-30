import type { Locator, Page } from "@playwright/test";
import { test, expect, newCanvas, uploadImage } from "./fixtures";

async function highlightMatches(page: Page, control: Locator) {
    const highlight = page.getByTestId("canvas-onboarding-highlight");
    await expect(highlight).toBeVisible();
    await expect.poll(async () => {
        const actual = await highlight.boundingBox(), target = await control.boundingBox();
        return actual && target ? Math.abs(actual.x - target.x) + Math.abs(actual.y - target.y) + Math.abs(actual.width - target.width) + Math.abs(actual.height - target.height) : 999;
    }).toBeLessThan(3);
}

async function tourLeavesToolbarsUsable(page: Page) {
    const tour = page.getByTestId("canvas-onboarding-tour");
    await expect.poll(async () => {
        const card = await tour.boundingBox(), dock = await page.locator(".cw-dock").boundingBox(), topbar = await page.locator(".cw-topbar").boundingBox();
        return Boolean(card && dock && topbar && card.y + card.height <= dock.y - 15 && card.y >= topbar.y + topbar.height + 11);
    }).toBe(true);
    const controls = page.locator(".cw-dock button:not(:disabled), .cw-topbar button:not(:disabled)");
    for (const control of await controls.all()) {
        if (!await control.isVisible()) continue;
        await expect.poll(() => control.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return [rect.top + 4, rect.top + rect.height / 2].every(y => {
                const hit = document.elementFromPoint(rect.left + rect.width / 2, y);
                return hit === element || Boolean(hit && element.contains(hit));
            });
        })).toBe(true);
    }
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "图片节点", exact: true })).toBeVisible();
    await expect(tour).toBeVisible();
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "图片节点", exact: true })).toBeHidden();
}

async function emptyEntriesAreUncovered(page: Page, panel: Locator) {
    const empty = page.getByTestId("canvas-empty-start");
    await expect(empty).toBeVisible();
    await expect.poll(async () => {
        const card = await empty.boundingBox(), blocker = await panel.boundingBox();
        return Boolean(card && blocker && (card.x >= blocker.x + blocker.width || card.x + card.width <= blocker.x || card.y >= blocker.y + blocker.height || card.y + card.height <= blocker.y));
    }).toBe(true);
    const controls = [
        empty.getByRole("button", { name: /拖入图片/ }),
        empty.getByRole("button", { name: /用模板开始/ }),
        empty.getByRole("button", { name: /打开示例画布/ }),
        empty.getByRole("button", { name: "跟我走一遍", exact: true }),
    ];
    for (const control of controls) {
        await expect(control).toBeVisible();
        await expect.poll(() => control.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return [rect.top + 4, rect.top + rect.height / 2].every(y => {
                const hit = document.elementFromPoint(rect.left + rect.width / 2, y);
                return hit === element || Boolean(hit && element.contains(hit));
            });
        })).toBe(true);
    }
}

test("手动开启四步引导高亮真实控件，完成与以后再看均持久化且不调用模型", async ({ page, api }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await newCanvas(page);
    const tour = page.getByTestId("canvas-onboarding-tour");
    await expect(tour).toBeHidden();
    await page.getByRole("button", { name: "跟我走一遍", exact: true }).click();
    await expect(tour).toContainText("1 / 4");
    await highlightMatches(page, page.getByRole("button", { name: "上传素材", exact: true }));
    await tourLeavesToolbarsUsable(page);
    await page.setViewportSize({ width: 1800, height: 1200 });
    await tourLeavesToolbarsUsable(page);
    await page.setViewportSize({ width: 1366, height: 768 });
    await tour.getByRole("button", { name: "下一步", exact: true }).click();
    await expect(page.getByTestId("canvas-quick-generate-panel")).toBeVisible();
    await highlightMatches(page, page.getByTestId("canvas-quick-generate-panel"));
    await tour.getByRole("button", { name: "下一步", exact: true }).click();
    await expect(tour).toContainText("逐图执行");
    await expect(tour).toContainText("合并参考");
    await expect(tour).toContainText("@");
    await highlightMatches(page, page.getByRole("button", { name: "更多工具", exact: true }));
    await expect(page.getByTestId("canvas-quick-generate-panel")).toBeHidden();
    await tour.getByRole("button", { name: "下一步", exact: true }).click();
    await highlightMatches(page, page.getByRole("button", { name: "设计工具", exact: true }));
    await tour.getByRole("button", { name: "完成引导", exact: true }).click();
    await expect(tour).toBeHidden();
    await page.reload();
    await expect(page.getByTestId("canvas-empty-start")).toBeVisible();
    await expect(tour).toBeHidden();
    await page.getByRole("button", { name: "跟我走一遍", exact: true }).click();
    await expect(tour).toContainText("1 / 4");
    await tour.getByRole("button", { name: /以后再看 ·/ }).click();
    await page.reload();
    await expect(page.getByTestId("canvas-empty-start")).toBeVisible();
    await expect(tour).toBeHidden();
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});

test("空画布三入口真实可用，模板和示例均不自动提交生成", async ({ page, api }) => {
    await page.setViewportSize({ width: 1280, height: 768 });
    const originalId = await newCanvas(page);
    await expect(page.getByTestId("canvas-onboarding-tour")).toBeHidden();
    await page.getByRole("button", { name: "跟我走一遍", exact: true }).click();
    await page.getByRole("button", { name: "跳过引导", exact: true }).click();
    const empty = page.getByTestId("canvas-empty-start");
    await expect(empty.getByRole("button", { name: /拖入图片/ })).toBeEnabled();
    const chooser = page.waitForEvent("filechooser");
    await empty.getByRole("button", { name: /拖入图片/ }).click();
    await (await chooser).setFiles([]);
    await empty.getByRole("button", { name: /用模板开始/ }).click();
    const templates = page.getByRole("dialog", { name: "整套服装画布模板", exact: true });
    await expect(templates).toBeVisible();
    await expect(templates.getByRole("button", { name: "添加这套流程", exact: true }).first()).toBeEnabled();
    await templates.locator(".ant-modal-close").click();
    await empty.getByRole("button", { name: /打开示例画布/ }).click();
    await expect(page).not.toHaveURL(new RegExp(`/canvas/${originalId}$`));
    await expect(page.locator(".node-element")).toHaveCount(4);
    const id = new URL(page.url()).pathname.split("/").at(-1)!;
    await expect.poll(() => api.document(id)?.nodes.length).toBe(4);
    const graph = api.document(id)!;
    const source = graph.nodes.find((node: any) => node.type === "image");
    const config = graph.nodes.find((node: any) => node.type === "config");
    expect(config.metadata.composerContent).toContain(`@[node:${source.id}]`);
    expect(config.metadata.status).toBe("idle");
    expect(graph.connections).toHaveLength(1);
    const image = page.locator(`[data-node-id="${source.id}"] img`).first();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(1024);
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
    await page.reload();
    await expect(page.locator(".node-element")).toHaveCount(4);
});

test("默认不自动引导，关闭后可编辑节点；手动重开后不会被自动收起", async ({ page, api }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const id = await newCanvas(page);
    const tour = page.getByTestId("canvas-onboarding-tour");
    await expect(tour).toBeHidden();
    await page.getByRole("button", { name: "跟我走一遍", exact: true }).click();
    await expect(tour).toContainText("1 / 4");
    await tour.getByRole("button", { name: "下一步", exact: true }).click();
    await expect(page.getByTestId("canvas-quick-generate-panel")).toBeVisible();
    await tour.getByRole("button", { name: "关闭引导，以后再看", exact: true }).click();
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    await uploadImage(page, "first.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    await expect(tour).toBeHidden();
    await expect(page.getByTestId("canvas-onboarding-highlight")).toBeHidden();
    await expect(page.getByTestId("canvas-quick-generate-panel")).toBeVisible();
    await expect(page.getByRole("button", { name: "新手引导", exact: true })).toBeVisible();

    // The tour must yield to the real reference editor, not merely stop
    // covering the bottom toolbar. Exercise its previously blocked Clear action.
    await page.setViewportSize({ width: 1800, height: 1200 });
    await page.getByRole("button", { name: "收起创建面板", exact: true }).click();
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "图片节点", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    const targetId = api.document(id)!.nodes[1].id;
    await page.getByRole("button", { name: "从画布选择", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "从画布选择参考图", exact: true });
    await dialog.getByRole("button", { name: /^选择参考图 / }).click();
    await dialog.getByRole("button", { name: "加入参考图", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.document(id)?.nodes.find((node: any) => node.id === targetId).metadata.manualImageReferences?.length).toBe(1);
    await page.getByRole("button", { name: /^清\s*空$/ }).click();
    await expect.poll(() => api.document(id)?.nodes.find((node: any) => node.id === targetId).metadata.manualImageReferences?.length ?? 0).toBe(0);

    // A fresh empty canvas stays quiet but retains the explicit guide entry.
    const nextId = await newCanvas(page);
    await expect(tour).toBeHidden();
    await page.getByRole("button", { name: "跟我走一遍", exact: true }).click();
    await expect(tour).toContainText("1 / 4");
    await tour.getByRole("button", { name: /以后再看 ·/ }).click();
    await page.getByRole("button", { name: "跟我走一遍", exact: true }).click();
    await expect(tour).toContainText("1 / 4");
    await uploadImage(page, "manual-tour.png");
    await expect.poll(() => api.document(nextId)?.nodes.length).toBe(1);
    await expect(tour).toBeVisible();
    await tour.getByRole("button", { name: "关闭引导，以后再看", exact: true }).click();
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});

test("1280默认收起，1366打开最大创建面板与宽屏助手仍留一半可操作画布", async ({ page, context, api }, testInfo) => {
    await context.route("**/api/generation-capabilities?**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ models: [] }) }));
    await page.setViewportSize({ width: 1280, height: 768 });
    await newCanvas(page);
    await expect(page.getByTestId("canvas-onboarding-tour")).toBeHidden();
    await page.getByRole("button", { name: "跟我走一遍", exact: true }).click();
    await page.getByRole("button", { name: "跳过引导", exact: true }).click();
    await expect(page.getByTestId("canvas-quick-generate-panel")).toBeHidden();
    await expect(page.locator(".cw-agent-panel")).toBeHidden();
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    await page.getByRole("separator", { name: "调整创建面板宽度", exact: true }).press("End");
    const assertHalfCanvas = async (panel: Locator) => {
        const box = (await panel.boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(683);
        expect(await page.evaluate(() => Boolean(document.elementFromPoint(1100, 600)?.closest("[data-canvas-viewport]")))).toBe(true);
        await page.mouse.move(1100, 600);
        await page.mouse.down({ button: "middle" });
        await page.mouse.move(1140, 620, { steps: 4 });
        await expect(page.locator("[data-canvas-viewport]")).toHaveAttribute("data-cursor-panning", "true");
        await page.mouse.up({ button: "middle" });
    };
    await assertHalfCanvas(page.locator(".cw-create-panel"));
    await emptyEntriesAreUncovered(page, page.locator(".cw-create-panel"));
    await page.getByRole("tab", { name: "对话", exact: true }).click();
    await expect(page.locator(".cw-agent-panel")).toBeVisible();
    await page.getByRole("button", { name: "切换为宽屏对话", exact: true }).click();
    await assertHalfCanvas(page.locator(".cw-agent-panel"));
    await emptyEntriesAreUncovered(page, page.locator(".cw-agent-panel"));
    await page.screenshot({ path: testInfo.outputPath("laptop-half-canvas.png") });
    expect(api.submissions).toHaveLength(0);
});
