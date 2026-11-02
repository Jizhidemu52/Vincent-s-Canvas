import type { BrowserContext } from "@playwright/test";
import { test, expect, MockCanvasApi } from "./fixtures";
import { canvasProjectSummary } from "../src/lib/canvas/canvas-project-summary";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";

const originalImage = "/api/assets/11111111-1111-4111-8111-111111111111/content";
const generatedImage = "/api/assets/22222222-2222-4222-8222-222222222222/content";
function project(id: string, index: number): CanvasProject {
    return { id, title: `测试画布 ${index}`, createdAt: new Date(Date.UTC(2026, 0, index)).toISOString(), updatedAt: new Date(Date.UTC(2026, 9, index)).toISOString(),
        nodes: [
            { id: "source", type: "image", title: "原始参考图", width: 256, height: 256, position: { x: 0, y: 0 }, metadata: { content: originalImage } },
            { id: "result", type: "image", title: "最新结果图", width: 256, height: 256, position: { x: 300, y: 0 }, metadata: { content: generatedImage, sourceTaskId: "task-provenance" } },
            { id: "text", type: "text", title: "作品说明", width: 300, height: 120, position: { x: 0, y: 300 }, metadata: { content: "原版内容" } },
        ] as CanvasProject["nodes"], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
}
async function seed(api: MockCanvasApi, context: BrowserContext, count = 12) {
    for (let index = 1; index <= count; index++) { const document = project(`library-${index}`, index); api.documents.set(document.id, { id: document.id, revision: 1, deleted: false, document, updatedAt: document.updatedAt }); }
    await context.route("**/api/canvas-documents", route => route.fulfill({ json: { documents: [...api.documents.values()].map(({ document, ...entry }) => ({ ...entry, summary: document ? canvasProjectSummary(document as CanvasProject) : null })) } }));
}

test("library rename supports Escape and blur without changing recency; selection has clear feedback", async ({ page, context, api }) => {
    await seed(api, context);
    await page.goto("/canvas");
    const card = page.locator('[data-canvas-project-id="library-12"]');
    await expect(card).toBeVisible();
    const order = await page.locator("[data-canvas-project-id]").evaluateAll(items => items.map(item => item.getAttribute("data-canvas-project-id")));
    await card.getByRole("button", { name: "重命名", exact: true }).click();
    await card.getByRole("textbox", { name: "画布名称" }).fill("取消的名字");
    await card.getByRole("textbox", { name: "画布名称" }).press("Escape");
    await expect(card.getByRole("heading", { name: "测试画布 12", exact: true })).toBeVisible();
    await card.getByRole("button", { name: "重命名", exact: true }).click();
    await card.getByRole("textbox", { name: "画布名称" }).fill("改名不改变位置");
    await page.getByRole("heading", { name: "无限画布", exact: true }).click();
    await expect(card.getByRole("heading", { name: "改名不改变位置", exact: true })).toBeVisible();
    await expect.poll(() => api.document("library-12")?.title).toBe("改名不改变位置");
    expect(api.document("library-12")?.updatedAt).toBe(project("library-12", 12).updatedAt);
    expect(await page.locator("[data-canvas-project-id]").evaluateAll(items => items.map(item => item.getAttribute("data-canvas-project-id")))).toEqual(order);
    await card.getByRole("checkbox").check();
    await expect(card).toHaveAttribute("data-selected", "true");
    expect(await card.evaluate(element => getComputedStyle(element).outlineWidth)).toBe("2px");
    await page.getByRole("button", { name: "全选", exact: true }).click();
    await expect(page.getByRole("button", { name: "取消选择（12）", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card).toHaveAttribute("data-selected", "false");
    expect(api.submissions).toHaveLength(0);
});

test("library duplicates whole canvas, sorts by name and chooses a cover without changing original media", async ({ page, context, api }, info) => {
    await seed(api, context);
    await page.setViewportSize({ width: 2100, height: 1100 });
    await page.goto("/canvas");
    const card = page.locator('[data-canvas-project-id="library-12"]');
    await expect(card).toBeVisible();
    expect(await page.locator("[data-canvas-project-row]").first().evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(5);
    await card.getByRole("button", { name: "创建副本", exact: true }).click();
    await expect(page.getByRole("heading", { name: "测试画布 12（副本）", exact: true })).toBeVisible();
    await expect.poll(() => [...api.documents.values()].some(entry => entry.document?.title === "测试画布 12（副本）")).toBe(true);
    const copy = [...api.documents.values()].find(entry => entry.document?.title === "测试画布 12（副本）")!.document!;
    expect(copy.nodes).toEqual(api.document("library-12")!.nodes);
    expect(copy.id).not.toBe("library-12");
    await card.getByRole("button", { name: "设置封面", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "选择画布封面" });
    await dialog.getByRole("button", { name: "设为封面：原始参考图", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.document("library-12")?.coverNodeId).toBe("source");
    expect(api.document("library-12")?.nodes[0].metadata.content).toBe(originalImage);
    await page.getByRole("combobox", { name: "画布排序" }).click();
    await page.getByRole("option", { name: "按名称排序", exact: true }).click();
    await expect(page.locator("[data-canvas-project-id]").first()).toHaveAttribute("data-canvas-project-id", "library-1");
    await page.screenshot({ path: info.outputPath("library-wide-five-columns.png") });
    await page.setViewportSize({ width: 1366, height: 768 });
    await expect.poll(() => page.locator("[data-canvas-project-row]").first().evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(3);
    await page.screenshot({ path: info.outputPath("library-standard-three-columns.png") });
    expect(api.submissions).toHaveLength(0);
});

test("conflict comparison shows real differences and deletion names; cancel and keep never delete the original", async ({ page, context, api }) => {
    await seed(api, context, 1);
    const original = api.document("library-1")!;
    const copy = structuredClone(original);
    copy.id = "library-conflict"; copy.title += "（保存冲突副本）";
    copy.nodes[2].metadata.content = "冲突版本中的修改";
    copy.persistenceConflict = { projectId: "library-1", paths: ["nodes.text.metadata.content"], savedAt: "2026-10-02T00:00:00.000Z" };
    api.documents.set(copy.id, { id: copy.id, revision: 1, deleted: false, document: copy, updatedAt: copy.updatedAt });
    await page.goto("/canvas");
    const card = page.locator('[data-canvas-project-id="library-conflict"]');
    await card.getByRole("button", { name: "对比版本", exact: true }).click();
    const compare = page.getByRole("dialog", { name: "对比冲突版本" });
    await expect(compare.getByText("原版内容", { exact: false })).toBeVisible();
    await expect(compare.getByText("冲突版本中的修改", { exact: false })).toBeVisible();
    await expect(compare.getByText("副本相对原画布：新增 0 个、缺少 0 个、内容或位置不同 1 个节点。", { exact: true })).toBeVisible();
    await compare.getByRole("button", { name: "删除此副本…", exact: true }).click();
    const deletion = page.getByRole("dialog", { name: "删除画布？" });
    await expect(deletion.getByText("测试画布 1（保存冲突副本）", { exact: true })).toBeVisible();
    await expect(deletion.getByText("此操作不可撤销", { exact: false })).toBeVisible();
    await deletion.getByRole("button", { name: /^取\s*消$/ }).click();
    expect(api.documents.get("library-1")?.deleted).toBe(false);
    expect(api.documents.get("library-conflict")?.deleted).toBe(false);
    await card.getByRole("button", { name: "保留此版本", exact: true }).click();
    await expect(card.getByText("冲突副本 · 原版本已保留", { exact: true })).toBeHidden();
    await expect.poll(() => api.document("library-conflict")?.persistenceConflict).toBeUndefined();
    expect(api.document("library-1")).toEqual(original);
    expect(api.submissions).toHaveLength(0);
});

test("cache cleanup and chat-library copy expose safe user-facing actions without technical query text", async ({ page, context, api }) => {
    await seed(api, context, 1);
    await page.goto("/canvas?tool=gpt-chat");
    await expect(page.getByText("从这里进入的画布会自动打开对话改图", { exact: false })).toBeVisible();
    await expect(page.getByText("tool=gpt-chat", { exact: false })).toHaveCount(0);
    await page.getByRole("button", { name: "清理已同步缓存", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("逐字节核对一致", { exact: false })).toBeVisible();
    await dialog.getByRole("button", { name: /^取\s*消$/ }).click();
    expect(api.documents.get("library-1")?.deleted).toBe(false);
    expect(api.submissions).toHaveLength(0);
});

test("library time and complete sentences follow English and Chinese IME Enter never submits a rename", async ({ page, context, api }, info) => {
    await seed(api, context, 1);
    api.document("library-1")!.updatedAt = "2025-12-01T00:00:00.000Z";
    await page.goto("/canvas");
    const card = page.locator('[data-canvas-project-id="library-1"]');
    await card.getByRole("button", { name: "重命名", exact: true }).click();
    const input = card.getByRole("textbox", { name: "画布名称" });
    await input.fill("拼音尚未确认");
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true, bubbles: true });
    await expect(input).toBeVisible();
    expect(api.document("library-1")?.title).toBe("测试画布 1");
    await input.press("Escape");
    await page.getByRole("button", { name: "切换语言为 English", exact: true }).click();
    await expect(page.getByRole("button", { name: "Select all", exact: true })).toBeVisible();
    await expect(card.getByText(/Updated .*2025/)).toBeVisible();
    await expect(card.getByText("3 nodes · 0 connections", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Select all", exact: true }).click();
    await expect(page.getByRole("button", { name: "Clear selection (1)", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear selection (1)", exact: true }).click();
    await expect(card).toHaveAttribute("data-selected", "false");
    await page.screenshot({ path: info.outputPath("library-english-time.png") });
    expect(api.submissions).toHaveLength(0);
});
