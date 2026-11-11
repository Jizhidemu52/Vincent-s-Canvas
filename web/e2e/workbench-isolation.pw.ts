import { readFileSync } from "node:fs";
import { test, expect, IMAGE } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";
import type { BrowserContext, Page } from "@playwright/test";

const videoModel = { id: "10000000-0000-4000-8000-000000000003", name: "测试视频模型", modelId: "wan2.7", capabilities: ["video"], creditCost: 0, rmbCost: 0 };
const videoBytes = readFileSync(new URL("./media/video.mp4", import.meta.url));
const activePane = (page: Page) => page.getByRole("tabpanel");
const selectTask = async (page: Page, index: number) => {
    await page.getByRole("tab").nth(index).click();
    await expect(page.getByRole("tab").nth(index)).toHaveAttribute("aria-selected", "true");
};
const addTask = async (page: Page, expected: number) => {
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveCount(expected);
    await expect(page.getByRole("tab").last()).toHaveAttribute("aria-selected", "true");
};
async function videoRoutes(context: BrowserContext) {
    await context.route("**/api/models", route => route.fulfill({ json: { models: [videoModel], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: videoModel.id, configurationVersion: 1 })), prices: [] } }));
    await context.route("**/api/tasks/preflight", route => route.fulfill({ json: { ok: true, normalized: {} } }));
    await context.route("**/api/assets/*/content", route => route.request().method() === "HEAD" ? route.fulfill({ contentType: "video/mp4", body: "" }) : route.fulfill({ contentType: "video/mp4", body: videoBytes }));
    await context.route("**/api/assets/*/playback", route => route.fulfill({ contentType: "video/mp4", body: videoBytes }));
}

test("video task tabs keep delayed submissions, prompts and out-of-order results independent across reload", async ({ page, context, api }) => {
    await videoRoutes(context);
    api.taskStatus = "queued";
    let releaseFirst: (() => void) | undefined;
    let posts = 0;
    await context.route("**/api/tasks", async route => {
        if (route.request().method() !== "POST") return route.fallback();
        posts++;
        if (posts === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
        return route.fallback();
    });
    await page.goto("/video");
    await activePane(page).getByRole("textbox", { name: "视频提示词" }).fill("TASK_A frozen navy camera");
    await activePane(page).getByRole("button", { name: "生成视频", exact: true }).click();
    await expect.poll(() => posts).toBe(1);
    await addTask(page, 2);
    await expect(activePane(page).getByRole("textbox", { name: "视频提示词" })).toHaveValue("");
    await activePane(page).getByRole("textbox", { name: "视频提示词" }).fill("TASK_B slow turn");
    await activePane(page).getByRole("button", { name: "生成视频", exact: true }).click();
    await expect.poll(() => posts).toBe(2);
    await expect.poll(() => api.submissions.length).toBe(1);
    releaseFirst!();
    await expect.poll(() => api.submissions.length).toBe(2);
    const taskB = [...api.tasks.values()].find(task => task.prompt.includes("TASK_B"))!;
    taskB.status = "success"; taskB.resultUrls = [`/api/assets/${taskB.id}/content`];
    await expect(activePane(page).locator("video")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "关闭任务 2 页签" })).toBeEnabled();
    await selectTask(page, 0);
    await expect(activePane(page).getByRole("textbox", { name: "视频提示词" })).toHaveValue("TASK_A frozen navy camera");
    await expect(activePane(page).getByRole("status", { name: "视频生成中" })).toHaveCount(1);
    await expect(activePane(page).locator("video")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(activePane(page).getByRole("textbox", { name: "视频提示词" })).toHaveValue("TASK_A frozen navy camera");
    const taskA = [...api.tasks.values()].find(task => task.prompt.includes("TASK_A"))!;
    taskA.status = "failed"; taskA.failureReason = "FIXTURE_A_FAILED";
    await expect(page.getByRole("tab").nth(0)).toContainText("已失败");
    await expect(activePane(page).getByRole("alert")).toBeVisible();
    await selectTask(page, 1);
    await expect(activePane(page).getByRole("textbox", { name: "视频提示词" })).toHaveValue("TASK_B slow turn");
    await expect(activePane(page).locator("video")).toHaveCount(1);
    await expect(activePane(page).getByRole("alert")).toHaveCount(0);
    expect(api.submissions).toHaveLength(2);
    expect(new Set(api.submissions.map(task => task.requestId)).size).toBe(2);
});

test("seamless task tabs preserve sources, isolate history and resume original requests without duplicate posts", async ({ page, api }) => {
    api.taskStatus = "queued";
    await page.goto("/image?tool=seamless-stitch");
    await activePane(page).locator('input[type="file"]').setInputFiles({ name: "TASK_A.png", mimeType: "image/png", buffer: IMAGE });
    await expect(activePane(page).getByRole("img", { name: "TASK_A.png", exact: true })).toBeVisible();
    await activePane(page).getByRole("button", { name: "开始无缝拼接", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    await addTask(page, 2);
    await expect(activePane(page).getByRole("img", { name: "TASK_A.png", exact: true })).toHaveCount(0);
    await expect(activePane(page).getByRole("img", { name: "无缝拼接历史结果" })).toHaveCount(0);
    await activePane(page).locator('input[type="file"]').setInputFiles({ name: "TASK_B.png", mimeType: "image/png", buffer: IMAGE });
    await activePane(page).getByRole("button", { name: "开始无缝拼接", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(2);
    await expect(page.getByRole("button", { name: "关闭任务 2 页签" })).toBeDisabled();
    await selectTask(page, 0);
    await expect(activePane(page).getByRole("img", { name: "TASK_A.png", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(activePane(page).getByRole("img", { name: "TASK_A.png", exact: true })).toBeVisible();
    await expect(activePane(page).getByRole("button", { name: "开始无缝拼接", exact: true })).toBeDisabled();
    const [taskA, taskB] = [...api.tasks.values()];
    taskB!.status = "success"; taskB!.resultUrls = [`/api/assets/${taskB!.id}/content`];
    await selectTask(page, 1);
    await expect(activePane(page).getByRole("img", { name: "TASK_B.png", exact: true })).toBeVisible();
    await expect(activePane(page).getByRole("img", { name: "无缝拼接结果", exact: true })).toBeVisible();
    await expect(activePane(page).getByRole("img", { name: "无缝拼接历史结果" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "关闭任务 2 页签" })).toBeEnabled();
    await selectTask(page, 0);
    await expect(activePane(page).getByRole("img", { name: "无缝拼接结果", exact: true })).toHaveCount(0);
    taskA!.status = "failed"; taskA!.failureReason = "FIXTURE_STITCH_A_FAILED";
    await expect(activePane(page).getByText("FIXTURE_STITCH_A_FAILED", { exact: true })).toBeVisible();
    await selectTask(page, 1);
    await page.getByRole("button", { name: "关闭任务 2 页签" }).click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(activePane(page).getByRole("img", { name: "无缝拼接历史结果" })).toHaveCount(0);
    expect(api.submissions).toHaveLength(2);
});

test("image edit tasks retain separate drafts and frozen results while background tasks finish", async ({ page, api }) => {
    api.taskStatus = "queued";
    await page.goto("/image?tool=image-edit");
    for (const [index, marker] of ["EDIT_A", "EDIT_B"].entries()) {
        if (index) await addTask(page, 2);
        await expect(activePane(page).getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("");
        await activePane(page).getByRole("textbox", { name: "图像提示词", exact: true }).fill(marker);
        const chooser = page.waitForEvent("filechooser");
        await activePane(page).getByRole("button", { name: "上传图片", exact: true }).click();
        await (await chooser).setFiles({ name: `${marker}.png`, mimeType: "image/png", buffer: IMAGE });
        await activePane(page).getByRole("button", { name: "开始编辑", exact: true }).click();
        await expect.poll(() => api.submissions.length).toBe(index + 1);
    }
    await expect(page.getByRole("button", { name: "关闭任务 2 页签" })).toBeDisabled();
    const [taskA, taskB] = [...api.tasks.values()];
    taskA!.status = "success"; taskA!.resultUrls = [`/api/assets/${taskA!.id}/content`];
    await selectTask(page, 0);
    await expect(activePane(page).getByRole("img", { name: "生成结果 1", exact: true })).toBeVisible();
    await expect(activePane(page).getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("EDIT_A");
    await selectTask(page, 1);
    await expect(activePane(page).getByRole("img", { name: "生成结果 1", exact: true })).toHaveCount(0);
    taskB!.status = "success"; taskB!.resultUrls = [`/api/assets/${taskB!.id}/content`];
    await expect(activePane(page).getByRole("img", { name: "生成结果 1", exact: true })).toBeVisible();
    await page.reload();
    await expect(activePane(page).getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("EDIT_B");
    await expect(activePane(page).getByRole("img", { name: "EDIT_B.png", exact: true }).first()).toBeVisible();
    await selectTask(page, 0);
    await expect(activePane(page).getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("EDIT_A");
    await expect(activePane(page).getByRole("img", { name: "EDIT_A.png", exact: true }).first()).toBeVisible();
    await expect(activePane(page).getByRole("img", { name: "生成结果 1", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(2);
    expect(api.submissions.map(task => task.prompt)).toEqual([expect.stringContaining("EDIT_A"), expect.stringContaining("EDIT_B")]);
});

test("seamless uncertain acknowledgement stays attached to its original task while another tab remains usable", async ({ page, context, api }) => {
    let lookupUnavailable = true;
    const id = "80000000-0000-4000-8000-000000000074";
    await context.route("**/api/tasks/by-request/*", route => {
        if (lookupUnavailable) return route.fulfill({ status: 503, json: { error: "FIXTURE_LOOKUP_UNAVAILABLE" } });
        const requestId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
        return route.fulfill({ json: { task: [...api.tasks.values()].find(task => task.requestId === requestId) } });
    });
    await context.route(/\/api\/tasks(?:\?.*)?$/, async route => {
        if (route.request().method() !== "POST") return route.fulfill({ json: { tasks: lookupUnavailable ? [] : [...api.tasks.values()], nextCursor: null } });
        const input = route.request().postDataJSON();
        api.submissions.push(input);
        api.tasks.set(id, { ...input, id, status: "queued", resultUrls: [], createdAt: new Date().toISOString() });
        return route.abort("connectionreset");
    });
    await page.goto("/image?tool=seamless-stitch");
    await addTask(page, 2);
    await activePane(page).locator('input[type="file"]').setInputFiles({ name: "uncertain-source.png", mimeType: "image/png", buffer: IMAGE });
    await activePane(page).getByRole("button", { name: "开始无缝拼接", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect(page.getByRole("tab").nth(1)).toContainText("待核查");
    await expect(page.getByRole("button", { name: "关闭任务 2 页签" })).toBeDisabled();
    await addTask(page, 3);
    await expect(activePane(page).getByRole("img", { name: "uncertain-source.png", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "关闭任务 3 页签" })).toBeEnabled();
    await selectTask(page, 1);
    await page.reload();
    await expect(page.getByRole("tab").nth(1)).toContainText("读取中");
    // Wait for the failed read, not the shell's initial loading frame, before
    // making the mocked endpoint healthy again.
    await expect(activePane(page).getByRole("button", { name: /^重\s*试$/ })).toBeVisible();
    lookupUnavailable = false;
    api.tasks.get(id)!.status = "success";
    api.tasks.get(id)!.resultUrls = [`/api/assets/${id}/content`];
    // Explicit history refresh is a read of the original task, never a POST.
    await activePane(page).getByRole("button", { name: /^重\s*试$/ }).click();
    await expect(activePane(page).getByRole("img", { name: "无缝拼接结果", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "关闭任务 2 页签" })).toBeEnabled();
    await selectTask(page, 2);
    await expect(activePane(page).getByRole("img", { name: "无缝拼接历史结果" })).toHaveCount(0);
    expect(api.submissions).toHaveLength(1);
});

test("seamless twelve independent source drafts survive rapid task switching and reload without submissions", async ({ page, api }, testInfo) => {
    await page.goto("/image?tool=seamless-stitch");
    for (let index = 0; index < 12; index++) {
        if (index) await addTask(page, index + 1);
        await activePane(page).locator('input[type="file"]').setInputFiles({ name: `source-${index + 1}.png`, mimeType: "image/png", buffer: IMAGE });
        await expect(activePane(page).getByRole("img", { name: `source-${index + 1}.png`, exact: true })).toBeVisible();
    }
    for (let index = 11; index >= 0; index--) {
        await selectTask(page, index);
        await expect(activePane(page).getByRole("img", { name: `source-${index + 1}.png`, exact: true })).toBeVisible();
    }
    await page.reload();
    await expect(page.getByRole("tab")).toHaveCount(12);
    await expect(activePane(page).getByRole("img", { name: "source-1.png", exact: true })).toBeVisible();
    await selectTask(page, 11);
    await expect(activePane(page).getByRole("img", { name: "source-12.png", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("seamless-12-task-mobile.png"), fullPage: true });
    expect(api.submissions).toHaveLength(0);
});

for (const board of [{ path: "/video", label: "视频提示词", prefix: "VIDEO" }, { path: "/image?tool=image-edit", label: "图像提示词", prefix: "EDIT" }]) {
    test(`${board.prefix} twelve task drafts survive rapid switching, closing and a narrow-screen reload without generation`, async ({ page, context, api }, testInfo) => {
        if (board.prefix === "VIDEO") await videoRoutes(context);
        await page.goto(board.path);
        const count = 12;
        for (let index = 0; index < count; index++) {
            if (index) await addTask(page, index + 1);
            await activePane(page).getByRole("textbox", { name: board.label, exact: true }).fill(`${board.prefix}_TASK_${index + 1}`);
        }
        for (let index = count - 1; index >= 0; index--) {
            await selectTask(page, index);
            await expect(activePane(page).getByRole("textbox", { name: board.label, exact: true })).toHaveValue(`${board.prefix}_TASK_${index + 1}`);
        }
        await selectTask(page, count - 1);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload();
        await expect(page.getByRole("tab")).toHaveCount(count);
        await expect(activePane(page).getByRole("textbox", { name: board.label, exact: true })).toHaveValue(`${board.prefix}_TASK_${count}`);
        await page.getByRole("button", { name: `关闭任务 ${count} 页签` }).click();
        await expect(page.getByRole("tab")).toHaveCount(count - 1);
        await expect(activePane(page).getByRole("textbox", { name: board.label, exact: true })).toHaveValue(`${board.prefix}_TASK_${count - 1}`);
        await page.screenshot({ path: testInfo.outputPath(`${board.prefix.toLowerCase()}-12-task-mobile.png`), fullPage: true });
        expect(api.submissions).toHaveLength(0);
    });
}
