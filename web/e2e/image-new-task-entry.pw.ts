import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect, fixturePng, type MockCanvasApi } from "./fixtures";

const active = (page: Page) => page.getByRole("tabpanel");
const tabs = (page: Page) => page.getByRole("tablist", { name: "任务列表", exact: true }).getByRole("tab");
const prompt = (page: Page) => active(page).getByRole("textbox", { name: "图像提示词", exact: true });
const sidebarNew = (page: Page) => page.getByRole("button", { name: "新建任务", exact: true });
const sourceA = fixturePng(31), sourceB = fixturePng(213);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function upload(page: Page, name: string, bytes: Buffer) {
    const chooser = page.waitForEvent("filechooser");
    await active(page).getByRole("button", { name: "上传图片", exact: true }).click();
    await (await chooser).setFiles({ name, mimeType: "image/png", buffer: bytes });
    await expect(active(page).getByRole("region", { name: "参考图", exact: true }).getByRole("img", { name, exact: true })).toBeVisible();
}

async function submitA(page: Page, api: MockCanvasApi) {
    api.taskStatus = "processing";
    await page.goto("/image");
    await upload(page, "A-original.png", sourceA);
    await prompt(page).fill("ENTRY_A_绿色圆形包，仅用A原件");
    await active(page).getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect(tabs(page).nth(0)).toContainText("处理中");
    return [...api.tasks.keys()][0];
}

async function expectFreshB(page: Page) {
    await expect(tabs(page)).toHaveCount(2);
    await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(prompt(page)).toHaveValue("");
    await expect(active(page).getByRole("img", { name: "A-original.png", exact: true })).toHaveCount(0);
    await expect(active(page).getByRole("img", { name: "生成结果 1", exact: true })).toHaveCount(0);
}

function finish(api: MockCanvasApi, id: string) {
    const task = api.tasks.get(id)!;
    task.status = "success";
    task.resultUrls = [`/api/assets/${id}/content`];
}

async function storedLogs(page: Page) {
    return page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const { getImageBlob } = await import("/src/services/image-storage.ts");
        const records: any[] = [];
        await createWorkspaceStorage("image_generation_logs").iterate(value => { records.push(value); });
        return Promise.all(records.map(async log => {
            // Persisted history intentionally strips blob URLs. Read its real
            // stored original, not an empty URL or a thumbnail/remote fallback.
            const blob = await getImageBlob(log.images[0].storageKey);
            if (!blob) throw new Error("Completed task has no stored original");
            const bytes = await blob.arrayBuffer();
            const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
            return { workspaceId: log.workspaceId, prompt: log.prompt, references: log.references.map((item: any) => item.name), taskId: log.images[0]?.sourceTaskId, resultBytes: blob.size, resultSha256: sha256 };
        }));
    });
}

test("sidebar New submits B while A remains processing and keeps reverse-completed originals separate", async ({ page, api }) => {
    const aId = await submitA(page, api);
    await expect(sidebarNew(page)).toBeEnabled();
    await sidebarNew(page).click();
    await expectFreshB(page);
    expect(api.tasks.get(aId)?.status).toBe("processing");
    await upload(page, "B-original.png", sourceB);
    await prompt(page).fill("ENTRY_B_橙色三角包，仅用B原件");
    // Two clicks in one event turn must still create only B, not a duplicate.
    await active(page).getByRole("button", { name: "开始生成", exact: true }).evaluate(button => { button.click(); button.click(); });
    await expect.poll(() => api.submissions.length).toBe(2);
    const bId = [...api.tasks.keys()][1];
    expect(api.tasks.get(aId)?.status).toBe("processing");
    expect(api.tasks.get(bId)?.status).toBe("processing");
    expect(new Set(api.submissions.map(item => item.requestId)).size).toBe(2);
    expect(api.submissions[0].prompt).toContain("ENTRY_A_");
    expect(api.submissions[0].prompt).not.toContain("ENTRY_B_");
    expect(api.submissions[1].prompt).toContain("ENTRY_B_");
    expect(api.submissions[1].prompt).not.toContain("ENTRY_A_");
    expect(digest(api.assetBytes.get(api.submissions[0].sourceUrls[0].split("/")[3])!)).toBe(digest(sourceA));
    expect(digest(api.assetBytes.get(api.submissions[1].sourceUrls[0].split("/")[3])!)).toBe(digest(sourceB));
    await expect(active(page).getByRole("button", { name: /正在生成，请稍候/ })).toBeDisabled();
    await prompt(page).press("Control+Enter");
    expect(api.submissions).toHaveLength(2);

    finish(api, bId);
    await expect(tabs(page).nth(1)).toContainText("已完成");
    expect(api.tasks.get(aId)?.status).toBe("processing");
    await tabs(page).nth(0).click();
    await expect(prompt(page)).toHaveValue("ENTRY_A_绿色圆形包，仅用A原件");
    await expect(active(page).getByRole("img", { name: "A-original.png", exact: true })).toBeVisible();
    await expect(active(page).getByRole("img", { name: "生成结果 1", exact: true })).toHaveCount(0);
    finish(api, aId);
    await expect(tabs(page).nth(0)).toContainText("已完成");
    const logs = await storedLogs(page);
    expect(logs).toHaveLength(2);
    expect(logs.find(log => log.taskId === aId)).toMatchObject({ workspaceId: "default", prompt: api.submissions[0].prompt, references: ["A-original.png"], resultBytes: api.assetBytes.get(aId)!.length, resultSha256: digest(api.assetBytes.get(aId)!) });
    expect(logs.find(log => log.taskId === bId)).toMatchObject({ prompt: api.submissions[1].prompt, references: ["B-original.png"], resultBytes: api.assetBytes.get(bId)!.length, resultSha256: digest(api.assetBytes.get(bId)!) });
    expect(logs.find(log => log.taskId === aId)?.resultSha256).not.toBe(logs.find(log => log.taskId === bId)?.resultSha256);
    expect(logs.find(log => log.taskId === bId)?.workspaceId).toMatch(/^image-generation:task:/);
    await page.reload();
    await expect(tabs(page)).toHaveCount(2);
    await expect(prompt(page)).toHaveValue("ENTRY_A_绿色圆形包，仅用A原件");
    await tabs(page).nth(1).click();
    await expect(prompt(page)).toHaveValue("ENTRY_B_橙色三角包，仅用B原件");
    await expect(active(page).getByRole("img", { name: "B-original.png", exact: true })).toBeVisible();
    await expect(active(page).getByRole("img", { name: "生成结果 1", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(2);
});

test("running footer creates only one independent B when activated twice", async ({ page, api }) => {
    const aId = await submitA(page, api);
    const create = active(page).getByRole("button", { name: "新建任务，继续创作", exact: true });
    await expect(create).toBeEnabled();
    await create.evaluate(button => { button.click(); button.click(); });
    await expectFreshB(page);
    expect(api.tasks.get(aId)?.status).toBe("processing");
    await tabs(page).nth(0).click();
    await expect(prompt(page)).toHaveValue("ENTRY_A_绿色圆形包，仅用A原件");
    expect(api.submissions).toHaveLength(1);
});

test("mobile history New switches to an independent B while A keeps running", async ({ page, api }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const aId = await submitA(page, api);
    await active(page).getByRole("tab", { name: /历史记录/ }).click();
    const history = active(page).locator(".image-history-panel");
    await expect(history).toBeVisible();
    await expect(history.getByRole("button", { name: "新建", exact: true })).toBeEnabled();
    await history.getByRole("button", { name: "新建", exact: true }).click();
    await expectFreshB(page);
    await expect(history).toBeHidden();
    await prompt(page).fill("MOBILE_B_新任务保持独立");
    await active(page).getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(2);
    expect(api.tasks.get(aId)?.status).toBe("processing");
    await tabs(page).nth(0).click();
    await expect(prompt(page)).toHaveValue("ENTRY_A_绿色圆形包，仅用A原件");
    await expect(history).toBeHidden();
});

test("a failed sidebar registry write preserves running A and its pending record", async ({ page, api }) => {
    await page.addInitScript(() => {
        const original = IDBObjectStore.prototype.put;
        let failures = 1;
        IDBObjectStore.prototype.put = function (...args) {
            if (this.name === "generation_workbench_tasks" && failures-- > 0) throw new DOMException("入口测试注册表写入失败", "QuotaExceededError");
            return original.apply(this, args as any);
        };
    });
    const aId = await submitA(page, api);
    await expect(sidebarNew(page)).toBeEnabled();
    await sidebarNew(page).click();
    await expect(page.getByRole("region", { name: "多任务工作区", exact: true }).getByRole("alert")).toContainText("入口测试注册表写入失败");
    await expect(tabs(page)).toHaveCount(1);
    await expect(prompt(page)).toHaveValue("ENTRY_A_绿色圆形包，仅用A原件");
    await expect(active(page).getByRole("img", { name: "A-original.png", exact: true })).toBeVisible();
    await expect(tabs(page).nth(0)).toContainText("处理中");
    expect(api.tasks.get(aId)?.status).toBe("processing");
    expect(api.submissions).toHaveLength(1);
    await sidebarNew(page).click();
    await expectFreshB(page);
    finish(api, aId);
    await expect(tabs(page).nth(0)).toContainText("已完成");
    await expect(prompt(page)).toHaveValue("");
    await expect(active(page).getByRole("img", { name: "生成结果 1", exact: true })).toHaveCount(0);
    expect(api.submissions).toHaveLength(1);
});

test("idle sidebar New preserves the previous draft as an independent task", async ({ page, api }) => {
    await page.goto("/image");
    await upload(page, "A-original.png", sourceA);
    await prompt(page).fill("未提交的旧草稿必须保留");
    await sidebarNew(page).click();
    await expectFreshB(page);
    await tabs(page).nth(0).click();
    await expect(prompt(page)).toHaveValue("未提交的旧草稿必须保留");
    await expect(active(page).getByRole("img", { name: "A-original.png", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(0);
});
