import { test, expect } from "./fixtures";
import { activeWorkbench as active, readWorkspaceRecords, workbenchPanes } from "./headless-workbench";
import type { Page } from "@playwright/test";

const prompt = (page: Page) => active(page).getByRole("textbox", { name: "款式描述", exact: true });

async function openWorkspace(page: Page) {
    await page.goto("/creative/text-to-style");
    await expect(prompt(page)).toBeEnabled();
}

for (const viewChange of ["clear", "successful-history"] as const) {
    test(`creative unresolved original survives ${viewChange} and reconciles through history without resubmission`, async ({ page, api }) => {
        await page.route("**/api/prompt-compilations/by-request/*", route => route.fulfill({ status: 404, json: { error: "NOT_FOUND" } }));
        await openWorkspace(page);
        await prompt(page).fill("FIRST_COMPLETED_INPUT");
        await active(page).locator("button.cs-generate").click();
        await expect(active(page).getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
        api.taskStatus = "processing";
        await prompt(page).fill("SECOND_PENDING_INPUT");
        await active(page).locator("button.cs-generate").click();
        await expect.poll(() => api.submissions.length).toBe(2);
        await active(page).getByRole("button", { name: "暂停获取进度", exact: true }).click();
        const requestIds = api.submissions.map(input => input.requestId);
        if (viewChange === "clear") {
            await active(page).getByRole("button", { name: "清空当前草稿", exact: true }).click();
            await expect(prompt(page)).toHaveValue("");
        } else {
            await active(page).getByRole("button", { name: /^最近任务/ }).click();
            await active(page).locator("button.cs-history-item").last().click();
            await expect(active(page).getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
        }
        await expect(page.getByRole("button", { name: /^关闭任务 \d+ 页签$/ })).toHaveCount(0);
        await expect.poll(async () => (await readWorkspaceRecords<any>(page, "creative_scene_workspaces")).filter(({ key, value }) => key.startsWith("history-record:") && value.results.some((result: any) => result.status === "pending" || result.failureKind === "uncertain")).length).toBe(1);
        expect(api.submissions).toHaveLength(2);
        const pending = [...api.tasks.values()][1];
        expect(pending.status).toBe("processing");
        pending.status = "success";
        pending.resultUrls = [`/api/assets/${pending.id}/content`];
        await active(page).getByRole("button", { name: /^最近任务/ }).click();
        await active(page).locator("button.cs-history-item").first().click();
        await expect(active(page).getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
        await expect.poll(() => api.taskReads.includes(`/api/tasks/${pending.id}`)).toBe(true);
        await expect.poll(async () => (await readWorkspaceRecords<any>(page, "creative_scene_workspaces")).filter(({ key, value }) => key.startsWith("history-record:") && value.results.some((result: any) => result.status === "pending" || result.failureKind === "uncertain")).length).toBe(0);
        expect(api.submissions).toHaveLength(2);
        await page.reload();
        await expect(workbenchPanes(page)).toHaveCount(1);
        expect(api.submissions.map(input => input.requestId)).toEqual(requestIds);
    });
}

test("a missing latest creative result never disables persistence of its valid draft", async ({ page, api }) => {
    await openWorkspace(page);
    await prompt(page).fill("VALID_DRAFT_BEFORE_MISSING_PREVIEW");
    await active(page).locator("button.cs-generate").click();
    await expect(active(page).getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
    const stored = await page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const storage = createWorkspaceStorage("creative_scene_workspaces");
        let draftKey = "", recordKey = "";
        let original: any;
        await storage.iterate((value: any, key) => {
            if (key.startsWith("draft:")) draftKey = key;
            if (key.startsWith("history-record:")) { recordKey = key; original = value; }
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
