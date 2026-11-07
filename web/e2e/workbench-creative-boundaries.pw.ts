import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const active = (page: Page) => page.getByRole("tabpanel");
const tabs = (page: Page) => page.getByRole("tablist", { name: "任务列表", exact: true }).getByRole("tab");
const prompt = (page: Page) => active(page).getByRole("textbox", { name: "款式描述", exact: true });
const closeSecond = (page: Page) => page.getByRole("button", { name: "关闭任务 2 页签", exact: true });

async function secondTask(page: Page) {
    await page.goto("/creative/text-to-style");
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await expect(tabs(page)).toHaveCount(2);
    await expect(prompt(page)).toBeEnabled();
}

for (const viewChange of ["clear", "successful-history"] as const) {
    test(`creative unresolved tab cannot close after ${viewChange} replaces its visible results`, async ({ page, api }) => {
        await page.route("**/api/prompt-compilations/by-request/*", route => route.fulfill({ status: 404, json: { error: "NOT_FOUND" } }));
        await secondTask(page);
        await prompt(page).fill("FIRST_COMPLETED_INPUT");
        await active(page).locator("button.cs-generate").click();
        await expect(tabs(page).nth(1)).toContainText("已完成");
        await expect(closeSecond(page)).toBeEnabled();
        api.taskStatus = "processing";
        await prompt(page).fill("SECOND_PENDING_INPUT");
        await active(page).locator("button.cs-generate").click();
        await expect.poll(() => api.submissions.length).toBe(2);
        await active(page).getByRole("button", { name: "停止本页查询（不取消服务端任务）", exact: true }).click();
        await expect(tabs(page).nth(1)).toContainText("待核查");
        await expect(closeSecond(page)).toBeDisabled();
        if (viewChange === "clear") {
            await active(page).getByRole("button", { name: "清空当前草稿", exact: true }).click();
            await expect(prompt(page)).toHaveValue("");
        } else {
            await active(page).getByRole("button", { name: /^最近任务/ }).click();
            await active(page).locator("button.cs-history-item").last().click();
            await expect(active(page).getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
        }
        await expect(closeSecond(page)).toBeDisabled();
        await expect(tabs(page).nth(1)).toContainText("待核查");
        expect(api.submissions).toHaveLength(2);
        const pending = [...api.tasks.values()][1];
        expect(pending.status).toBe("processing");
        pending.status = "success";
        pending.resultUrls = [`/api/assets/${pending.id}/content`];
        await active(page).getByRole("button", { name: /^最近任务/ }).click();
        await active(page).locator("button.cs-history-item").first().click();
        await active(page).getByRole("button", { name: "查询原请求", exact: true }).click();
        await expect(closeSecond(page)).toBeEnabled();
        expect(api.submissions).toHaveLength(2);
        await closeSecond(page).click();
        await expect(tabs(page)).toHaveCount(1);
        await page.reload();
        await expect(tabs(page)).toHaveCount(1);
        expect(api.submissions).toHaveLength(2);
    });
}

test("a missing latest creative result never disables persistence of its valid draft", async ({ page, api }) => {
    await secondTask(page);
    await prompt(page).fill("VALID_DRAFT_BEFORE_MISSING_PREVIEW");
    await active(page).locator("button.cs-generate").click();
    await expect(tabs(page).nth(1)).toContainText("已完成");
    const stored = await page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const storage = createWorkspaceStorage("creative_scene_workspaces");
        let draftKey = "", recordKey = "";
        let original: any;
        await storage.iterate((value: any, key) => {
            if (key.startsWith("draft:") && key.includes(":task:")) draftKey = key;
            if (key.startsWith("history-record:") && value.workspaceId?.includes(":task:")) { recordKey = key; original = value; }
        });
        if (!draftKey || !recordKey) throw new Error("Expected isolated creative task draft and record");
        const broken = structuredClone(original);
        for (const image of broken.images) { image.storageKey = "isolated-missing-result"; image.dataUrl = ""; }
        for (const result of broken.results) if (result.image) { result.image.storageKey = "isolated-missing-result"; result.image.dataUrl = ""; }
        await storage.setItem(recordKey, broken);
        return { draftKey, recordKey, original, broken };
    });
    await page.reload();
    await expect(prompt(page)).toHaveValue("VALID_DRAFT_BEFORE_MISSING_PREVIEW");
    await expect(active(page).getByText(/本地文件已不可用/)).toBeVisible();
    await prompt(page).fill("EDIT_AFTER_MISSING_PREVIEW_MUST_SURVIVE");
    await expect.poll(() => page.evaluate(async key => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        return (await createWorkspaceStorage("creative_scene_workspaces").getItem<any>(key))?.form.description;
    }, stored.draftKey)).toBe("EDIT_AFTER_MISSING_PREVIEW_MUST_SURVIVE");
    await page.reload();
    await expect(prompt(page)).toHaveValue("EDIT_AFTER_MISSING_PREVIEW_MUST_SURVIVE");
    expect(api.submissions).toHaveLength(1);
    const retained = await page.evaluate(async key => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        return createWorkspaceStorage("creative_scene_workspaces").getItem(key);
    }, stored.recordKey);
    expect(retained).toEqual(stored.broken);
});
