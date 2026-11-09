import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, fixturePng, type MockCanvasApi } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

const model = { id: "10000000-0000-4000-8000-000000000003", name: "测试视频模型", modelId: "wan2.7", capabilities: ["video"], creditCost: 0, rmbCost: 0 };
const resultA = readFileSync(new URL("./media/video.mp4", import.meta.url));
const resultB = readFileSync(new URL("./media/video-control.mp4", import.meta.url));
const sourceA = fixturePng(31), sourceB = fixturePng(213);
const active = (page: Page) => page.getByRole("tabpanel");
const tabs = (page: Page) => page.getByRole("tablist", { name: "任务列表", exact: true }).getByRole("tab");
const prompt = (page: Page) => active(page).getByRole("textbox", { name: "视频提示词", exact: true });
const sidebarNew = (page: Page) => active(page).locator("aside").getByRole("button", { name: "新建", exact: true });
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function routes(context: BrowserContext, api: MockCanvasApi) {
    await context.route("**/api/models", route => route.fulfill({ json: { models: [model], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: model.id, configurationVersion: 1 })) } }));
    await context.route("**/api/tasks/preflight", route => route.fulfill({ json: { ok: true, normalized: {} } }));
    await context.route("**/api/assets/*/content", route => {
        const task = api.tasks.get(new URL(route.request().url()).pathname.split("/")[3]);
        return task ? route.fulfill({ contentType: "video/mp4", body: task.prompt.includes("ENTRY_B") ? resultB : resultA }) : route.fallback();
    });
    await context.route("**/api/assets/*/playback", route => {
        const task = api.tasks.get(new URL(route.request().url()).pathname.split("/")[3]);
        return route.fulfill({ contentType: "video/mp4", body: task?.prompt.includes("ENTRY_B") ? resultB : resultA });
    });
}

async function upload(page: Page, name: string, bytes: Buffer) {
    await active(page).locator('input[type="file"][accept^="image/"]').setInputFiles({ name, mimeType: "image/png", buffer: bytes });
    await expect(active(page).getByRole("img", { name, exact: true })).toBeVisible();
}

async function submitA(page: Page, api: MockCanvasApi) {
    api.taskStatus = "processing";
    await page.goto("/video");
    await upload(page, "A-original.png", sourceA);
    await prompt(page).fill("ENTRY_A_绿色圆形包缓慢转身");
    await active(page).getByRole("button", { name: "生成视频", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect(active(page).getByRole("status", { name: "视频生成中", exact: true })).toHaveCount(1);
    return [...api.tasks.keys()][0];
}

async function freshB(page: Page) {
    await expect(tabs(page)).toHaveCount(2);
    await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(prompt(page)).toHaveValue("");
    await expect(active(page).getByRole("img", { name: "A-original.png", exact: true })).toHaveCount(0);
    await expect(active(page).locator("video")).toHaveCount(0);
}

function finish(api: MockCanvasApi, id: string) {
    const task = api.tasks.get(id)!;
    task.status = "success";
    task.resultUrls = [`/api/assets/${id}/content`];
}

async function logs(page: Page) {
    return page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const { getMediaBlob } = await import("/src/services/file-storage.ts");
        const records: any[] = [];
        await createWorkspaceStorage("video_generation_logs").iterate(value => { records.push(value); });
        return Promise.all(records.map(async log => {
            const blob = await getMediaBlob(log.video.storageKey);
            if (!blob) throw new Error("Completed video has no stored original");
            const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
            return { workspaceId: log.workspaceId, prompt: log.prompt, taskId: log.task.id, references: log.references.map((item: any) => item.name), bytes: blob.size, sha256 };
        }));
    });
}

test("video sidebar New keeps A intact while B submits and completes first, with separate durable originals", async ({ page, context, api }) => {
    await routes(context, api);
    const aId = await submitA(page, api);
    await sidebarNew(page).click();
    await freshB(page);
    expect(api.tasks.get(aId)?.status).toBe("processing");
    await upload(page, "B-original.png", sourceB);
    await prompt(page).fill("ENTRY_B_橙色三角包镜头拉近");
    await active(page).getByRole("button", { name: "生成视频", exact: true }).evaluate(button => { button.click(); button.click(); });
    await expect.poll(() => api.submissions.length).toBe(2);
    const bId = [...api.tasks.keys()][1];
    expect(api.tasks.get(aId)?.status).toBe("processing");
    expect(new Set(api.submissions.map(task => task.requestId)).size).toBe(2);
    expect(api.submissions[0].prompt).toContain("ENTRY_A");
    expect(api.submissions[1].prompt).toContain("ENTRY_B");
    expect(digest(api.assetBytes.get(api.submissions[0].sourceUrls[0].split("/")[3])!)).toBe(digest(sourceA));
    expect(digest(api.assetBytes.get(api.submissions[1].sourceUrls[0].split("/")[3])!)).toBe(digest(sourceB));
    finish(api, bId);
    await expect(tabs(page).nth(1)).toContainText("已完成");
    await expect(active(page).locator("video")).toHaveCount(1);
    expect(api.tasks.get(aId)?.status).toBe("processing");
    await tabs(page).nth(0).click();
    await expect(prompt(page)).toHaveValue("ENTRY_A_绿色圆形包缓慢转身");
    await expect(active(page).getByRole("img", { name: "A-original.png", exact: true })).toBeVisible();
    await expect(active(page).locator("video")).toHaveCount(0);
    finish(api, aId);
    await expect(tabs(page).nth(0)).toContainText("已完成");
    const records = await logs(page);
    expect(records).toHaveLength(2);
    expect(records.find(log => log.taskId === aId)).toMatchObject({ workspaceId: "default", references: ["A-original.png"], bytes: resultA.length, sha256: digest(resultA) });
    expect(records.find(log => log.taskId === bId)).toMatchObject({ references: ["B-original.png"], bytes: resultB.length, sha256: digest(resultB) });
    expect(records.find(log => log.taskId === bId)?.workspaceId).not.toBe("default");
    await page.reload();
    await expect(tabs(page)).toHaveCount(2);
    await expect(prompt(page)).toHaveValue("ENTRY_A_绿色圆形包缓慢转身");
    await tabs(page).nth(1).click();
    await expect(prompt(page)).toHaveValue("ENTRY_B_橙色三角包镜头拉近");
    await expect(active(page).getByRole("img", { name: "B-original.png", exact: true })).toBeVisible();
    await expect(active(page).locator("video")).toHaveCount(1);
    expect(api.submissions).toHaveLength(2);
});

test("video running footer creates only one independent task on a rapid double click", async ({ page, context, api }) => {
    await routes(context, api);
    const aId = await submitA(page, api);
    await active(page).getByRole("button", { name: "新建任务，继续创作", exact: true }).evaluate(button => { button.click(); button.click(); });
    await freshB(page);
    expect(api.tasks.get(aId)?.status).toBe("processing");
    await tabs(page).nth(0).click();
    await expect(prompt(page)).toHaveValue("ENTRY_A_绿色圆形包缓慢转身");
    expect(api.submissions).toHaveLength(1);
});

test("video mobile history New keeps its drawer on persistence failure, then closes only after B is saved", async ({ page, context, api }) => {
    await routes(context, api);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
        const original = IDBObjectStore.prototype.put;
        let failures = 1;
        IDBObjectStore.prototype.put = function (...args) {
            if (this.name === "generation_workbench_tasks" && failures-- > 0) throw new DOMException("视频注册表写入失败", "QuotaExceededError");
            return original.apply(this, args as any);
        };
    });
    const aId = await submitA(page, api);
    await active(page).getByRole("button", { name: "记录", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "生成记录", exact: true });
    await drawer.getByRole("button", { name: "新建", exact: true }).click();
    await expect(page.getByRole("region", { name: "多任务工作区", exact: true }).getByRole("alert")).toContainText("视频注册表写入失败");
    await expect(drawer).toBeVisible();
    await expect(tabs(page)).toHaveCount(1);
    await expect(prompt(page)).toHaveValue("ENTRY_A_绿色圆形包缓慢转身");
    expect(api.submissions).toHaveLength(1);
    await drawer.getByRole("button", { name: "新建", exact: true }).click();
    await freshB(page);
    await expect(drawer).toHaveCount(0);
    await prompt(page).fill("ENTRY_B_移动端继续独立创作");
    await active(page).getByRole("button", { name: "生成视频", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(2);
    expect(api.tasks.get(aId)?.status).toBe("processing");
    await tabs(page).nth(0).click();
    await expect(drawer).toHaveCount(0);
    await expect(prompt(page)).toHaveValue("ENTRY_A_绿色圆形包缓慢转身");
});

test("video idle sidebar New preserves the prior unsubmitted draft", async ({ page, context, api }) => {
    await routes(context, api);
    await page.goto("/video");
    await upload(page, "A-original.png", sourceA);
    await prompt(page).fill("未提交的旧视频草稿");
    await sidebarNew(page).click();
    await freshB(page);
    await tabs(page).nth(0).click();
    await expect(prompt(page)).toHaveValue("未提交的旧视频草稿");
    await expect(active(page).getByRole("img", { name: "A-original.png", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(0);
});
