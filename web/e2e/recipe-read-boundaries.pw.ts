import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect, IMAGE } from "./fixtures";

const OWNER = "00000000-0000-4000-8000-000000000099";
const pane = (page: Page) => page.getByRole("tabpanel");
const projectKey = `project:${OWNER}`;

async function savedProject(page: Page) {
    return page.evaluate(async key => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        return createWorkspaceStorage("series_recipe_workspaces").getItem<any>(key);
    }, projectKey);
}

async function installReadGate(page: Page) {
    await page.addInitScript(({ owner, key }) => {
        const get = IDBObjectStore.prototype.get;
        const put = IDBObjectStore.prototype.put;
        const success = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "onsuccess")!;
        const held: Array<() => void> = [];
        let mode = sessionStorage.getItem("recipe-original-read-mode");
        const gate = (window as any).__recipeReadGate = {
            reads: 0, writes: 0,
            release() { mode = null; for (const callback of held.splice(0)) callback(); },
            readOriginal: () => new Promise((resolve, reject) => {
                const open = indexedDB.open(`wireless-canvas:oa:user:${owner}`);
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                    const db = open.result;
                    const transaction = db.transaction("series_recipe_workspaces", "readonly");
                    const request = get.call(transaction.objectStore("series_recipe_workspaces"), key);
                    request.onerror = () => reject(request.error);
                    request.onsuccess = () => resolve(request.result);
                    transaction.oncomplete = () => db.close();
                };
            }),
        };
        IDBObjectStore.prototype.get = function (...args) {
            if (this.name === "series_recipe_workspaces" && args[0] === key && mode === "fail") {
                gate.reads += 1;
                throw new Error("isolated-recipe-original-read-failed");
            }
            const request = get.apply(this, args);
            if (this.name === "series_recipe_workspaces" && args[0] === key && mode === "hold") {
                Object.defineProperty(request, "onsuccess", { set(handler) {
                    success.set!.call(request, (event: Event) => {
                        gate.reads += 1;
                        held.push(() => handler.call(request, event));
                    });
                } });
            }
            return request;
        };
        IDBObjectStore.prototype.put = function (...args) {
            if (this.name === "series_recipe_workspaces") gate.writes += 1;
            return put.apply(this, args);
        };
    }, { owner: OWNER, key: projectKey });
}

test("recipe initial read failure preserves the original project and pending request until explicit retry", async ({ page, context, api }) => {
    api.taskStatus = "queued";
    await context.route("**/api/tasks/by-request/*", route => {
        const requestId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
        return route.fulfill({ json: { task: [...api.tasks.values()].find(task => task.requestId === requestId) } });
    });
    await page.goto("/creative/series-recipe");
    await pane(page).getByRole("textbox", { name: "系列名称", exact: true }).fill("ORIGINAL_RECIPE_MUST_SURVIVE");
    await pane(page).getByLabel("上传参考底图（必需）", { exact: true }).setInputFiles({ name: "recipe-original.png", mimeType: "image/png", buffer: IMAGE });
    await pane(page).getByRole("button", { name: "生成第 1 色 1 张", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect.poll(async () => (await savedProject(page))?.run?.branches[0]?.taskIds[0]).toBe([...api.tasks.keys()][0]);
    const before = await savedProject(page);
    const task = [...api.tasks.values()][0]!;
    await installReadGate(page);
    await page.evaluate(() => sessionStorage.setItem("recipe-original-read-mode", "fail"));
    await page.reload();
    await expect(pane(page).getByRole("alert")).toContainText("isolated-recipe-original-read-failed");
    await expect(pane(page).getByRole("textbox", { name: "系列名称", exact: true })).toBeDisabled();
    await expect(pane(page).getByRole("button", { name: "生成第 1 色 1 张", exact: true })).toBeDisabled();
    await expect(pane(page).getByRole("button", { name: "保存项目", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => (window as any).__recipeReadGate.writes)).toBe(0);
    expect(await page.evaluate(() => (window as any).__recipeReadGate.readOriginal())).toEqual(before);
    expect(api.submissions).toHaveLength(1);
    await page.evaluate(() => (window as any).__recipeReadGate.release());
    await pane(page).getByRole("button", { name: "重试读取原项目", exact: true }).click();
    await expect(pane(page).getByRole("textbox", { name: "系列名称", exact: true })).toHaveValue("ORIGINAL_RECIPE_MUST_SURVIVE");
    await expect(pane(page).getByRole("alert")).toHaveCount(0);
    task.status = "success";
    task.resultUrls = [`/api/assets/${task.id}/content`];
    await pane(page).getByRole("button", { name: /^查询原任务 \(1\)/ }).click();
    await expect(pane(page).locator(".sr-result img")).toHaveCount(1);
    expect(api.submissions).toHaveLength(1);
    expect([...api.tasks.keys()]).toEqual([task.id]);
    const restored = await savedProject(page);
    expect(restored.form).toEqual(before.form);
    const originalReferences = (references: Array<{ id: string; name: string; type: string; dataUrl: string }>) => references.map(({ id, name, type, dataUrl }) => ({ id, name, type, sha256: createHash("sha256").update(dataUrl).digest("hex") }));
    expect(originalReferences(restored.references)).toEqual(originalReferences(before.references));
    expect(api.pageErrors).toEqual([]);
    expect(api.blocked).toEqual([]);
});

test("recipe delayed original read keeps all writes closed and restores the exact draft after release", async ({ page, api }) => {
    await page.goto("/creative/series-recipe");
    await pane(page).getByRole("textbox", { name: "系列名称", exact: true }).fill("DELAYED_RECIPE_ORIGINAL");
    await expect.poll(async () => (await savedProject(page))?.form.series).toBe("DELAYED_RECIPE_ORIGINAL");
    const before = await savedProject(page);
    await installReadGate(page);
    await page.evaluate(() => sessionStorage.setItem("recipe-original-read-mode", "hold"));
    await page.reload();
    await expect.poll(() => page.evaluate(() => (window as any).__recipeReadGate.reads)).toBeGreaterThan(0);
    await expect(pane(page).getByRole("textbox", { name: "系列名称", exact: true })).toBeDisabled();
    await expect(pane(page).getByRole("button", { name: "保存项目", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => (window as any).__recipeReadGate.writes)).toBe(0);
    expect(await page.evaluate(() => (window as any).__recipeReadGate.readOriginal())).toEqual(before);
    await page.evaluate(() => (window as any).__recipeReadGate.release());
    await expect(pane(page).getByRole("textbox", { name: "系列名称", exact: true })).toBeEnabled();
    await expect(pane(page).getByRole("textbox", { name: "系列名称", exact: true })).toHaveValue("DELAYED_RECIPE_ORIGINAL");
    expect(await savedProject(page)).toEqual(before);
    expect(api.submissions).toHaveLength(0);
    expect(api.pageErrors).toEqual([]);
    expect(api.blocked).toEqual([]);
});
