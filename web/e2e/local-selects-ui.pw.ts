import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const output = resolve(import.meta.dirname, "../../output/ui-plan-20261112/local");
const select = (page: Page, key: string) => page.locator(`[data-workbench-select-control="${key}"]`);
const status = (page: Page) => page.locator("[data-project-status]");
async function choose(page: Page, name: string, label: string) {
    await page.getByRole("combobox", { name, exact: true }).click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").getByText(label, { exact: true }).click();
}
async function createProject(page: Page, name: string) {
    page.once("dialog", dialog => dialog.accept(name));
    await page.getByRole("button", { name: "新建工程", exact: true }).click();
    await expect(status(page)).toHaveText("已自动保存到本机");
    await expect(select(page, "project")).toContainText(name);
}
async function exportProject(page: Page, name = "导出 JSON") {
    const event = page.waitForEvent("download"); await page.getByRole("button", { name, exact: true }).click();
    const stream = await (await event).createReadStream();
    if (!stream) throw new Error("Missing local project export");
    const parts: Buffer[] = []; for await (const part of stream) parts.push(Buffer.from(part));
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
async function ready(page: Page, route: string) {
    await page.goto(route); await expect(select(page, "project").getByRole("combobox")).toBeEnabled();
    await expect(page.locator(".local-workbench-host select:visible")).toHaveCount(0);
}

test("repeat AntD DPI and project selectors keep each project's exact values and keyboard focus", async ({ page, api }) => {
    await ready(page, "/creative/pattern-repeat");
    await createProject(page, "A_花型"); const original = await exportProject(page);
    await choose(page, "输出分辨率 / DPI", "300");
    await expect(select(page, "dpi")).toContainText("300");
    await expect(page.locator('[data-role="export-pixels"]')).toHaveText("2362 × 1181 像素");
    const updated = await exportProject(page);
    expect(updated).toEqual({ ...original, dpi: 300, metadata: { ...original.metadata, exportedAt: updated.metadata.exportedAt, basePixels: { width: 1181, height: 1181 }, periodPixels: { width: 2362, height: 1181 } } });
    await createProject(page, "B_花型"); await choose(page, "输出分辨率 / DPI", "72");
    await expect(status(page)).toHaveText("已自动保存到本机");
    await choose(page, "本地工程", "A_花型"); await expect(select(page, "dpi")).toContainText("300");
    const restored = await exportProject(page);
    // The existing importer assigns fresh editor IDs; artwork and all geometry
    // must remain exact when reopening the stored project.
    expect(restored).toEqual({ ...updated, elements: updated.elements.map((item: any, index: number) => ({ ...item, id: restored.elements[index].id })), metadata: { ...updated.metadata, exportedAt: restored.metadata.exportedAt } });
    await choose(page, "本地工程", "B_花型"); await expect(select(page, "dpi")).toContainText("72");
    await page.getByTestId("repeat-restore").click(); await expect(page.getByRole("combobox", { name: "本地工程", exact: true })).toBeFocused();
    await page.getByRole("combobox", { name: "本地工程", exact: true }).press("ArrowDown");
    await expect(page.locator(".ant-select-dropdown:visible")).toBeVisible();
    await page.getByRole("combobox", { name: "本地工程", exact: true }).press("Escape");
    await page.reload(); await expect(select(page, "project")).toContainText("B_花型"); await expect(select(page, "dpi")).toContainText("72");
    expect(api.submissions).toHaveLength(0); expect(api.assetBytes.size).toBe(0);
});

test("dynamic placement blend selectors preserve layers, undo and independent projects", async ({ page, api }) => {
    await ready(page, "/creative/pattern-placement"); await createProject(page, "A_定位");
    const initial = await exportProject(page, "导出工程 JSON");
    await choose(page, "混合模式", "正常");
    const changed = await exportProject(page, "导出工程 JSON");
    expect(changed).toEqual({ ...initial, layers: initial.layers.map((layer: any) => ({ ...layer, blend: "source-over" })) });
    await page.locator('[data-action="undo"]').click(); await expect(select(page, "blend")).toContainText("正片叠底");
    await page.locator('[data-action="redo"]').click(); await expect(select(page, "blend")).toContainText("正常");
    await page.getByRole("button", { name: "添加枝叶图案", exact: true }).click();
    await choose(page, "混合模式", "正片叠底");
    const layers = (await exportProject(page, "导出工程 JSON")).layers;
    expect(layers.map((layer: any) => layer.blend)).toEqual(["source-over", "multiply"]);
    await page.locator(".placement-layer-select").last().click(); await expect(select(page, "blend")).toContainText("正常");
    await expect(select(page, "blend")).toHaveCount(1);
    const beforeKeyboard = await exportProject(page, "导出工程 JSON");
    const control = page.getByRole("combobox", { name: "混合模式", exact: true });
    await control.focus(); await control.press("ArrowDown"); await control.press("Escape");
    expect(await exportProject(page, "导出工程 JSON")).toEqual(beforeKeyboard);
    await createProject(page, "B_定位"); await expect(select(page, "blend")).toContainText("正片叠底");
    await choose(page, "本地工程", "A_定位"); await expect(select(page, "blend")).toContainText("正片叠底");
    expect((await exportProject(page, "导出工程 JSON")).layers).toEqual(layers);
    await page.getByRole("button", { name: "打开本地工程", exact: true }).click(); await expect(page.getByRole("combobox", { name: "本地工程", exact: true })).toBeFocused();
    expect(api.submissions).toHaveLength(0); expect(api.assetBytes.size).toBe(0);
});

test("a failed save keeps the active project and modified DPI when the AntD picker tries switching", async ({ page, api }) => {
    await ready(page, "/creative/pattern-repeat"); await createProject(page, "安全工程 A"); await createProject(page, "未保存工程 B");
    await page.evaluate(() => {
        (window as any).__originalWorkbenchPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args: any[]) {
            if (this.name === "design_workbench_projects") throw new DOMException("isolated storage full", "QuotaExceededError");
            return (window as any).__originalWorkbenchPut.apply(this, args);
        };
    });
    await choose(page, "输出分辨率 / DPI", "600"); await expect(status(page)).toContainText("保存失败");
    await choose(page, "本地工程", "安全工程 A");
    await expect(select(page, "project")).toContainText("未保存工程 B"); await expect(select(page, "dpi")).toContainText("600");
    expect((await exportProject(page)).dpi).toBe(600);
    await page.evaluate(() => { IDBObjectStore.prototype.put = (window as any).__originalWorkbenchPut; });
    await page.getByTestId("repeat-save").click(); await expect(status(page)).toHaveText("已自动保存到本机");
    await choose(page, "本地工程", "安全工程 A"); await expect(select(page, "dpi")).toContainText("150");
    await choose(page, "本地工程", "未保存工程 B"); await expect(select(page, "dpi")).toContainText("600");
    expect(api.submissions).toHaveLength(0);
});

for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) test(`local selects use the shared style at ${viewport.width}x${viewport.height}`, async ({ page, api }) => {
    await mkdir(output, { recursive: true }); await page.setViewportSize(viewport);
    for (const kind of ["repeat", "placement"]) {
        await ready(page, `/creative/pattern-${kind}`);
        const key = kind === "repeat" ? "dpi" : "blend";
        await select(page, key).scrollIntoViewIfNeeded();
        await select(page, key).getByRole("combobox").click();
        await expect(page.locator(".ant-select-dropdown:visible")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        expect((await select(page, key).locator(".ant-select").boundingBox())!.height).toBe(32);
        await expect(page.locator(".ant-select-dropdown:visible")).not.toHaveClass(/ant-slide-up-(?:appear|enter)/);
        await page.screenshot({ path: resolve(output, `${kind}-${viewport.width}x${viewport.height}.png`), animations: "disabled" });
    }
    if (viewport.width === 1920) {
        await select(page, "blend").getByRole("combobox").press("Escape");
        await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
        await expect(page.locator("html")).toHaveClass(/dark/);
        await select(page, "blend").getByRole("combobox").click();
        await expect(page.locator(".ant-select-dropdown:visible")).not.toHaveClass(/ant-slide-up-(?:appear|enter)/);
        await page.screenshot({ path: resolve(output, "placement-1920-dark.png"), animations: "disabled" });
    }
    expect(api.submissions).toHaveLength(0);
});
