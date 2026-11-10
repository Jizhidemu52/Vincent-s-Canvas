import { test, expect, IMAGE } from "./fixtures";
import type { Page } from "@playwright/test";

const OWNER = "00000000-0000-4000-8000-000000000099";
const SCENE = "text-to-style";

async function seedImages(page: Page, tool: string) {
    await page.goto(`/image?tool=${tool}`);
    await expect(page.getByRole("heading", { name: "生成记录", exact: true })).toBeVisible();
    await page.evaluate(async ({ owner, tool, image }) => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const logs = createWorkspaceStorage("image_generation_logs"), media = createWorkspaceStorage("image_files");
        const blob = await (await fetch(image)).blob();
        for (const id of ["a", "b"]) {
            await media.setItem(`batch-${id}`, blob);
            await logs.setItem(id, { id, ownerId: owner, tool, title: `批量记录 ${id}`, prompt: `原始输入 ${id}`, createdAt: 1700000000000 + (id === "a" ? 1 : 2), status: "成功", successCount: 1, imageCount: 1, references: [], images: [{ id, storageKey: `batch-${id}`, dataUrl: "", width: 256, height: 256, bytes: blob.size, durationMs: 1 }] });
        }
        await logs.setItem("other-tool", { id: "other-tool", ownerId: owner, tool: "unrelated-tool", title: "其他板块记录", images: [] });
        await logs.setItem("other-owner", { id: "other-owner", ownerId: "other-employee", tool, title: "其他员工记录", images: [] });
    }, { owner: OWNER, tool, image: `data:image/png;base64,${IMAGE.toString("base64")}` });
    await page.reload();
    await expect(page.getByRole("checkbox", { name: /^选择记录：/ })).toHaveCount(2);
}

async function imageRecords(page: Page) {
    return page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const logs = createWorkspaceStorage("image_generation_logs"), media = createWorkspaceStorage("image_files");
        return { logs: await Promise.all(["a", "b", "other-tool", "other-owner"].map(id => logs.getItem(id))), media: await Promise.all(["batch-a", "batch-b"].map(async id => Boolean(await media.getItem(id)))) };
    });
}

for (const tool of ["image-generation", "image-edit", "detail-enhance", "angle-control", "midjourney-blend"]) {
    test(`${tool} exposes multi-select history deletion with cancellation and scoped persistence`, async ({ page, api }, info) => {
        await seedImages(page, tool);
        const remove = page.getByRole("button", { name: /^批量删除/ });
        await expect(remove).toBeDisabled();
        await page.getByRole("button", { name: "全选", exact: true }).click();
        await expect(remove).toHaveText("批量删除（2）");
        await remove.click();
        await expect(page.getByRole("dialog")).toContainText("确定删除选中的2 条生成记录吗？");
        await page.getByRole("button", { name: /^取\s*消$/ }).click();
        await expect(page.getByRole("dialog", { name: "批量删除生成记录", exact: true })).toBeHidden();
        expect((await imageRecords(page)).logs.slice(0, 2).every(Boolean)).toBe(true);
        if (tool === "image-generation") await page.screenshot({ path: info.outputPath("image-history-desktop.png"), fullPage: true, animations: "disabled" });
        await remove.click();
        await page.getByRole("button", { name: "确认删除", exact: true }).click();
        await expect(page.getByRole("checkbox", { name: /^选择记录：/ })).toHaveCount(0);
        const persisted = await imageRecords(page);
        expect(persisted.logs.slice(0, 2)).toEqual([null, null]);
        expect(persisted.logs.slice(2).every(Boolean)).toBe(true);
        expect(persisted.media).toEqual([false, false]);
        expect(api.submissions).toEqual([]);
    });
}

test("image partial failure keeps only failed history and media selected, then permits a scoped retry", async ({ page, api }, info) => {
    await seedImages(page, "image-generation");
    await page.evaluate(() => {
        const original = IDBObjectStore.prototype.delete;
        (window as any).failImageDelete = true;
        IDBObjectStore.prototype.delete = function(key) {
            if (this.name === "image_generation_logs" && key === "b" && (window as any).failImageDelete) throw new DOMException("isolated write failure", "UnknownError");
            return original.call(this, key);
        };
    });
    await page.getByRole("button", { name: "全选", exact: true }).click();
    await page.getByRole("button", { name: "批量删除（2）", exact: true }).click();
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("确定删除选中的1 条生成记录吗？");
    await expect(page.getByText("已删除 1 条，1 条删除失败；失败记录仍保留并已选中，可重试。", { exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "选择记录：批量记录 b", exact: true })).toBeChecked();
    const partial = await imageRecords(page);
    expect(partial.logs[0]).toBeNull(); expect(partial.logs[1]).not.toBeNull();
    expect(partial.media).toEqual([false, true]);
    await page.getByRole("button", { name: /^取\s*消$/ }).click();
    await expect(page.getByRole("dialog", { name: "批量删除生成记录", exact: true })).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "记录", exact: true }).click();
    await expect(page.getByRole("button", { name: "批量删除（1）", exact: true }).last()).toBeVisible();
    await page.screenshot({ path: info.outputPath("image-history-mobile.png"), fullPage: true, animations: "disabled" });
    await page.evaluate(() => { (window as any).failImageDelete = false; });
    await page.getByRole("button", { name: "批量删除（1）", exact: true }).last().click();
    await expect(page.getByRole("dialog", { name: "生成记录", exact: true })).toBeHidden();
    await page.getByRole("button", { name: /确认删除$/ }).click();
    await expect(page.getByRole("dialog", { name: "批量删除生成记录", exact: true })).toBeHidden();
    expect((await imageRecords(page)).logs.slice(0, 2)).toEqual([null, null]);
    expect(api.submissions).toEqual([]);
});

async function seedScene(page: Page, count: number) {
    const originalLookups: string[] = [], taskWrites: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/tasks") && request.method() !== "GET") taskWrites.push(`${request.method()} ${new URL(request.url()).pathname}`); });
    // Preserve a genuinely unresolved record while the GET-only observer runs.
    // Only this seeded request is declared; every other unknown API still fails.
    await page.route("**/api/tasks/by-request/unresolved%3A0", route => {
        expect(route.request().method()).toBe("GET");
        originalLookups.push(decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!));
        return route.fulfill({ status: 503, json: { error: "TEMPORARILY_UNAVAILABLE", message: "原任务状态暂不可确认" } });
    });
    await page.goto(`/creative/${SCENE}`);
    await expect(page.getByText("正在恢复场景草稿…", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /最近任务/ })).toBeVisible();
    await page.evaluate(async ({ owner, scene, count }) => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const { createSceneHistory } = await import("/src/pages/creative/scene-history.ts");
        const { createSceneForm } = await import("/src/pages/creative/scene-form-model.ts");
        const history = createSceneHistory(createWorkspaceStorage("creative_scene_workspaces"), owner, scene);
        const base = { ownerId: owner, sceneId: scene, prompt: "保留原始输入", form: createSceneForm(scene), config: { model: "gpt-image-2", imageModel: "gpt-image-2", count: "1", size: "auto", quality: "auto" }, referenceImages: {}, images: [], durationMs: 1, successCount: 1, failCount: 0 };
        for (let index = 0; index < count; index++) await history.save({ ...base, id: `finished-${index}`, createdAt: 1700000000000 - index * 1000, results: [{ id: `result-${index}`, status: "success" }] });
        await history.save({ ...base, id: "unresolved", createdAt: 1700000001000, successCount: 0, results: [{ id: "pending-result", status: "pending", requestId: "unresolved:0" }] });
    }, { owner: OWNER, scene: SCENE, count });
    await page.reload();
    await expect.poll(() => originalLookups.length).toBeGreaterThan(0);
    await page.getByRole("button", { name: /最近任务/ }).click();
    await expect(page.getByRole("button", { name: "批量管理", exact: true })).toBeEnabled();
    return { originalLookups, taskWrites };
}

async function sceneRecords(page: Page) {
    return page.evaluate(async ({ owner, scene }) => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const storage = createWorkspaceStorage("creative_scene_workspaces");
        return { index: await storage.getItem<any>(`history-index:${owner}:${scene}`), original: await storage.getItem(`history-record:${owner}:${scene}:finished-0`) };
    }, { owner: OWNER, scene: SCENE });
}

test("creative bulk select covers only loaded finished tasks and leaves tracking plus archived details intact", async ({ page, api }, info) => {
    const recovery = await seedScene(page, 24);
    await page.getByRole("button", { name: "批量管理", exact: true }).click();
    await expect(page.getByRole("button", { name: "批量删除", exact: true })).toBeDisabled();
    await page.getByRole("checkbox", { name: "全选已加载的已结束任务", exact: true }).check();
    await expect(page.getByText("已选 19 条", { exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /^选择任务：/ }).first()).toBeDisabled();
    await page.getByRole("button", { name: "加载更多（已显示 20 / 25）", exact: true }).click();
    await expect(page.getByText("已选 19 条", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "批量删除", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("creative-history-desktop.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "批量删除", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("删除选中的 19 条历史记录？");
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(page.locator(".cs-history-item")).toHaveCount(6);
    await expect(page.getByRole("dialog")).toBeHidden();
    const persisted = await sceneRecords(page);
    expect(persisted.index.entries.map((log: any) => log.id)).toEqual(["unresolved", "finished-19", "finished-20", "finished-21", "finished-22", "finished-23"]);
    expect(persisted.original).not.toBeNull();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "退出批量管理", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("creative-history-mobile.png"), fullPage: true, animations: "disabled" });
    expect(new Set(recovery.originalLookups)).toEqual(new Set(["unresolved:0"]));
    expect(recovery.taskWrites).toEqual([]);
    expect(api.submissions).toEqual([]);
    expect(api.batchSubmissions).toEqual([]);
});

test("creative partial index-write failure preserves only failed selection for retry", async ({ page, api }) => {
    const recovery = await seedScene(page, 3);
    await page.evaluate(() => {
        const original = IDBObjectStore.prototype.put;
        (window as any).failSceneDelete = true;
        IDBObjectStore.prototype.put = function(value, key) {
            if (this.name === "creative_scene_workspaces" && String(key).startsWith("history-index:") && !value.entries.some((entry: any) => entry.id === "finished-1") && (window as any).failSceneDelete) throw new DOMException("isolated index failure", "UnknownError");
            return original.call(this, value, key);
        };
    });
    await page.getByRole("button", { name: "批量管理", exact: true }).click();
    await page.getByRole("checkbox", { name: "全选已加载的已结束任务", exact: true }).check();
    await page.getByRole("button", { name: "批量删除", exact: true }).click();
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(page.locator(".cs-history-item")).toHaveCount(2);
    await expect(page.getByText("已选 1 条", { exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /^选择任务：/ }).last()).toBeChecked();
    expect((await sceneRecords(page)).index.entries.map((log: any) => log.id)).toEqual(["unresolved", "finished-1"]);
    await page.evaluate(() => { (window as any).failSceneDelete = false; });
    await page.getByRole("button", { name: "批量删除", exact: true }).click();
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(page.locator(".cs-history-item")).toHaveCount(1);
    expect((await sceneRecords(page)).original).not.toBeNull();
    expect(new Set(recovery.originalLookups)).toEqual(new Set(["unresolved:0"]));
    expect(recovery.taskWrites).toEqual([]);
    expect(api.submissions).toEqual([]);
    expect(api.batchSubmissions).toEqual([]);
});
