import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { test, expect, newCanvas } from "./fixtures";
import type { Page } from "@playwright/test";

async function skipGuide(page: Page) {
    const skip = page.getByRole("button", { name: "跳过引导", exact: true });
    await expect(skip).toBeVisible();
    await skip.click();
}

test("命令搜索、节点键盘编辑与微移、历史提示和刷新视图恢复", async ({ page, api }, testInfo) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const id = await newCanvas(page);
    await skipGuide(page);
    await expect(page.getByRole("button", { name: "展开创建面板", exact: true })).toBeVisible();
    await page.keyboard.press("Control+k");
    const search = page.getByRole("combobox", { name: "搜索命令、节点和素材" });
    await search.fill("添加文本");
    await search.press("Enter");
    await expect(page.getByRole("dialog", { name: "命令与搜索" })).toBeHidden();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const nodeId = api.document(id)!.nodes[0].id;
    const node = page.locator(`[data-node-id="${nodeId}"]`);
    await node.focus();
    await node.press("Enter");
    const editor = node.locator("textarea:not([placeholder])");
    await editor.fill("键盘与命令验收");
    // Editing owns shortcuts, so Ctrl+K must not open the canvas command palette.
    await editor.press("Control+k");
    await expect(page.getByRole("dialog", { name: "命令与搜索" })).toHaveCount(0);
    await editor.press("Escape");
    await expect.poll(() => api.document(id)?.nodes[0].metadata.content).toBe("键盘与命令验收");
    const before = { ...api.document(id)!.nodes[0].position };
    await node.focus();
    await node.press("Shift+ArrowRight");
    await expect.poll(() => api.document(id)?.nodes[0].position.x).toBe(before.x + 10);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page.getByText(/已撤销：移动/)).toBeVisible();
    await expect.poll(() => api.document(id)?.nodes[0].position.x).toBe(before.x);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect(page.getByText(/已重做：移动/)).toBeVisible();
    await node.focus();
    await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
    await page.getByRole("button", { name: "50%", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect.poll(() => api.document(id)?.viewport.k).toBe(.5);
    await expect.poll(() => api.document(id)?.selectedNodeIds).toEqual([nodeId]);
    await page.reload();
    await expect(node).toHaveAttribute("aria-label", /已选择/);
    await expect(page.getByRole("button", { name: "画布缩放与视图" })).toContainText("50%");
    await expect(page.getByTestId("canvas-onboarding-tour")).toHaveCount(0);
    await page.keyboard.press("Control+k");
    await search.fill("文本");
    await expect(page.getByRole("option").filter({ hasText: "画布节点" })).toHaveCount(1);
    await page.getByRole("option").filter({ hasText: "画布节点" }).click();
    await expect(node).toHaveAttribute("aria-label", /已选择/);
    await page.screenshot({ path: testInfo.outputPath("canvas-keyboard-1366.png") });
    await node.hover();
    await page.getByRole("button", { name: "加入我的素材", exact: true }).click();
    await expect(page.getByText("已加入我的素材", { exact: true })).toBeVisible();
    await page.keyboard.press("Control+k");
    await search.fill("画布文本");
    await page.getByRole("option").filter({ hasText: "本地素材" }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    expect(api.document(id)!.nodes[1].metadata.content).toBe("键盘与命令验收");
    expect(api.submissions).toHaveLength(0);
});

test("连续本机写入失败五秒内只升级一次且立即导出保留内存内容", async ({ page, api }, testInfo) => {
    const id = await newCanvas(page);
    await skipGuide(page);
    await expect.poll(() => api.document(id)?.id).toBe(id);
    await page.evaluate(() => {
        const original = IDBObjectStore.prototype.put;
        (window as any).__restoreCanvasWrites = () => { IDBObjectStore.prototype.put = original; };
        IDBObjectStore.prototype.put = function(value: any, key?: IDBValidKey) {
            if (String(key).includes(":project-documents:v1")) throw new DOMException("E2E full storage", "QuotaExceededError");
            return original.call(this, value, key!);
        };
    });
    await page.getByRole("button", { name: "文本", exact: true }).click();
    const warning = page.getByText("画布连续保存失败，请立即备份", { exact: true });
    await expect(warning).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: "文本", exact: true }).click();
    await expect(page.locator("[data-node-id]")).toHaveCount(2);
    await expect(warning).toHaveCount(1);
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "立即导出备份", exact: true }).click();
    const archive = await downloaded;
    await archive.saveAs(testInfo.outputPath("failed-save-backup.zip"));
    const files = unzipSync(await readFile((await archive.path())!));
    const payload = JSON.parse(strFromU8(files["projects.json"]!));
    const projects = Array.isArray(payload) ? payload : payload.projects;
    expect(projects).toHaveLength(1);
    expect(projects[0].project.nodes).toHaveLength(2);
    expect(projects[0].project.selectedNodeIds).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath("save-failure-backup.png") });
    await page.evaluate(() => (window as any).__restoreCanvasWrites());
    await page.getByTestId("canvas-save-status").click();
    await expect(warning).toBeHidden();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    expect(api.submissions).toHaveLength(0);
});

test("两处快捷键入口共用真实说明，命令可从菜单打开", async ({ page, api }) => {
    await newCanvas(page); await skipGuide(page);
    await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "快捷键", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "快捷键与画布操作", exact: true });
    const first = await dialog.locator(".cw-shortcuts-list").innerText();
    expect(first).toContain("Ctrl / Cmd + K");
    expect(first).toContain("选择工具 + 空白处拖动");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
    await page.getByRole("button", { name: "快捷键", exact: true }).click();
    await expect(dialog).toBeVisible();
    expect(await dialog.locator(".cw-shortcuts-list").innerText()).toBe(first);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: /搜索命令、节点和素材/ }).click();
    await expect(page.getByRole("combobox", { name: "搜索命令、节点和素材" })).toBeFocused();
    expect(api.submissions).toHaveLength(0);
});
