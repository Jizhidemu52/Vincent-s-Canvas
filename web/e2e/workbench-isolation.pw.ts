import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test, expect, IMAGE, type MockCanvasApi } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";
import type { BrowserContext, Page } from "@playwright/test";
import { activeWorkbench as activePane, workbenchPanes, readWorkbenchRegistry, readWorkspaceRecords } from "./headless-workbench";

const videoModel = { id: "10000000-0000-4000-8000-000000000003", name: "测试视频模型", modelId: "wan2.7", capabilities: ["video"], creditCost: 0, rmbCost: 0 };
const videoBytes = readFileSync(new URL("./media/video.mp4", import.meta.url));
const addTask = async (page: Page, expected: number) => {
    await expect(activePane(page)).toBeVisible();
    const continuation = activePane(page).getByRole("button", { name: "新建任务，继续创作", exact: true });
    if (await continuation.isVisible()) await continuation.click();
    else {
        await activePane(page).getByRole("tab", { name: /^历史记录/ }).click();
        await activePane(page).getByRole("button", { name: "新建", exact: true }).click();
    }
    await expect(workbenchPanes(page)).toHaveCount(expected);
    await expect(workbenchPanes(page).last()).toBeVisible();
};
async function videoRoutes(context: BrowserContext) {
    await context.route("**/api/models", route => route.fulfill({ json: { models: [videoModel], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: videoModel.id, configurationVersion: 1 })), prices: [] } }));
    await context.route("**/api/tasks/preflight", route => route.fulfill({ json: { ok: true, normalized: {} } }));
    await context.route("**/api/assets/*/content", route => route.request().method() === "HEAD" ? route.fulfill({ contentType: "video/mp4", body: "" }) : route.fulfill({ contentType: "video/mp4", body: videoBytes }));
    await context.route("**/api/assets/*/playback", route => route.fulfill({ contentType: "video/mp4", body: videoBytes }));
}
async function cloudHistory(context: BrowserContext, api: MockCanvasApi, board: string) {
    const reads: string[] = [];
    await context.route("**/api/tasks/history?*", route => {
        const requested = new URL(route.request().url()).searchParams.get("board")!;
        reads.push(requested);
        expect(route.request().method()).toBe("GET");
        expect(requested).toBe(board);
        return route.fulfill({ json: { tasks: [...api.tasks.values()].map(task => ({ ...task, userId: "00000000-0000-4000-8000-000000000099" })), nextCursor: null, hasMore: false } });
    });
    return reads;
}

async function openCloudRecords(page: Page, api: MockCanvasApi, media: "image" | "video") {
    const history = activePane(page).getByRole("region", { name: "账号云端历史", exact: true });
    const records = history.getByRole("button", { name: /^查看云端记录：/ });
    await expect(records).toHaveCount(api.tasks.size);
    for (const [index, task] of [...api.tasks.values()].entries()) {
        const title = (task.userInput?.userText || task.prompt).slice(0, 80);
        const status = task.status === "success" ? "已完成" : "失败";
        const record = history.getByRole("button", { name: `查看云端记录：${title}`, exact: true }).filter({ hasText: status });
        await expect(record).toHaveCount(1);
        await record.click();
        const detail = page.getByRole("dialog", { name: "云端任务详情", exact: true });
        await detail.getByText("查看输入、参数和任务编号", { exact: true }).click();
        await expect(detail.locator("pre")).toContainText(task.id);
        await expect(detail.locator("pre")).toContainText(task.requestId);
        await expect(detail.getByText(task.status === "success" ? "已完成" : "失败", { exact: true })).toBeVisible();
        const originalPaths = [...(task.resultUrls || []), ...(task.sourceUrls || [])];
        const originalChoices = detail.getByRole("group", { name: "历史原件选择", exact: true }).getByRole("button");
        for (const [originalIndex, originalPath] of originalPaths.entries()) {
            await originalChoices.nth(originalIndex).click();
            await expect(media === "video" ? detail.locator("video") : detail.getByRole("img", { name: "账号历史原件", exact: true })).toBeVisible();
            const downloadEvent = page.waitForEvent("download");
            await detail.getByRole("link", { name: "下载原件", exact: true }).click();
            const download = await downloadEvent;
            expect(await download.failure()).toBeNull();
            const downloadedBytes = readFileSync((await download.path())!);
            const expectedBytes = media === "video" ? videoBytes : api.assetBytes.get(originalPath.split("/")[3]) || IMAGE;
            expect(downloadedBytes.length).toBe(expectedBytes.length);
            expect(createHash("sha256").update(downloadedBytes).digest("hex")).toBe(createHash("sha256").update(expectedBytes).digest("hex"));
        }
        await page.screenshot({ path: test.info().outputPath(`cloud-history-${media}-${index + 1}.png`), fullPage: true });
        await detail.getByRole("button", { name: "Close", exact: true }).click();
    }
}

test("video workspaces keep delayed submissions, prompts and out-of-order results independent across reload", async ({ page, context, api }) => {
    await videoRoutes(context);
    const historyReads = await cloudHistory(context, api, "video");
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
    const original = workbenchPanes(page).nth(0);
    await expect(original.getByRole("textbox", { name: "视频提示词", includeHidden: true })).toHaveValue("TASK_A frozen navy camera");
    await expect(original.getByRole("status", { name: "视频生成中", includeHidden: true })).toHaveCount(1);
    await expect(original.locator("video")).toHaveCount(0);
    await page.reload();
    await expect(workbenchPanes(page)).toHaveCount(2);
    await expect(activePane(page).getByRole("textbox", { name: "视频提示词" })).toHaveValue("TASK_B slow turn");
    const taskA = [...api.tasks.values()].find(task => task.prompt.includes("TASK_A"))!;
    taskA.status = "failed"; taskA.failureReason = "FIXTURE_A_FAILED";
    await expect(original.getByRole("alert", { includeHidden: true })).toHaveCount(1);
    await expect.poll(async () => (await readWorkspaceRecords<any>(page, "video_generation_logs")).some(({ value }) => value.task?.id === taskA.id && value.status === "失败")).toBe(true);
    await expect(activePane(page).getByRole("textbox", { name: "视频提示词" })).toHaveValue("TASK_B slow turn");
    await expect(activePane(page).locator("video")).toHaveCount(1);
    await expect(activePane(page).getByRole("alert")).toHaveCount(0);
    await activePane(page).getByRole("tab", { name: /^历史记录/ }).click();
    await expect(activePane(page).locator(".video-history-panel button").filter({ has: page.getByRole("checkbox") })).toHaveCount(1);
    await openCloudRecords(page, api, "video");
    expect(historyReads).toContain("video");
    await expect(activePane(page).getByRole("textbox", { name: "视频提示词" })).toHaveValue("TASK_B slow turn");
    expect(api.submissions).toHaveLength(2);
    expect(new Set(api.submissions.map(task => task.requestId)).size).toBe(2);
});

test("seamless workspaces preserve sources, isolate local history and expose both cloud originals without duplicate posts", async ({ page, context, api }) => {
    const historyReads = await cloudHistory(context, api, "seamless-stitch");
    api.taskStatus = "queued";
    await page.goto("/image?tool=seamless-stitch");
    await activePane(page).locator('input[type="file"]').setInputFiles({ name: "TASK_A.png", mimeType: "image/png", buffer: IMAGE });
    await expect(activePane(page).getByRole("img", { name: "TASK_A.png", exact: true })).toBeVisible();
    await activePane(page).getByRole("button", { name: "开始无缝拼接", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    await addTask(page, 2);
    await expect(activePane(page).getByRole("img", { name: "TASK_A.png", exact: true })).toHaveCount(0);
    await activePane(page).getByRole("tab", { name: /^历史记录/ }).click();
    await expect(activePane(page).getByRole("img", { name: "无缝拼接历史结果" })).toHaveCount(0);
    await activePane(page).getByRole("tab", { name: "本次结果", exact: true }).click();
    await activePane(page).locator('input[type="file"]').setInputFiles({ name: "TASK_B.png", mimeType: "image/png", buffer: IMAGE });
    await activePane(page).getByRole("button", { name: "开始无缝拼接", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(2);
    await expect(workbenchPanes(page).nth(0).getByRole("img", { name: "TASK_A.png", exact: true, includeHidden: true })).toHaveCount(1);
    await page.reload();
    await expect(workbenchPanes(page)).toHaveCount(2);
    await expect(activePane(page).getByRole("img", { name: "TASK_B.png", exact: true })).toBeVisible();
    await expect(activePane(page).getByRole("button", { name: "开始无缝拼接", exact: true })).toBeDisabled();
    const [taskA, taskB] = [...api.tasks.values()];
    taskB!.status = "success"; taskB!.resultUrls = [`/api/assets/${taskB!.id}/content`];
    await expect(activePane(page).getByRole("img", { name: "TASK_B.png", exact: true })).toBeVisible();
    await expect(activePane(page).getByRole("img", { name: "无缝拼接结果", exact: true })).toBeVisible();
    await activePane(page).getByRole("tab", { name: /^历史记录/ }).click();
    await expect(activePane(page).getByRole("img", { name: "无缝拼接历史结果" })).toHaveCount(1);
    await expect(workbenchPanes(page).nth(0).getByRole("img", { name: "无缝拼接结果", exact: true, includeHidden: true })).toHaveCount(0);
    taskA!.status = "failed"; taskA!.failureReason = "FIXTURE_STITCH_A_FAILED";
    await expect.poll(async () => (await readWorkspaceRecords<any>(page, "seamless_stitch_tasks")).some(({ value }) => value.taskId === taskA.id && value.pending === false)).toBe(true);
    await addTask(page, 3);
    await activePane(page).getByRole("tab", { name: /^历史记录/ }).click();
    await expect(activePane(page).getByRole("img", { name: "无缝拼接历史结果" })).toHaveCount(0);
    await expect(workbenchPanes(page)).toHaveCount(3);
    const records = await readWorkspaceRecords<any>(page, "seamless_stitch_tasks");
    expect(records.map(({ value }) => value.taskId).filter(Boolean).sort()).toEqual([taskA.id, taskB.id].sort());
    await openCloudRecords(page, api, "image");
    expect(historyReads).toContain("seamless-stitch");
    await expect(activePane(page).getByRole("img", { name: "TASK_A.png", exact: true })).toHaveCount(0);
    await expect(activePane(page).getByRole("img", { name: "TASK_B.png", exact: true })).toHaveCount(0);
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
    const [taskA, taskB] = [...api.tasks.values()];
    taskA!.status = "success"; taskA!.resultUrls = [`/api/assets/${taskA!.id}/content`];
    await expect(workbenchPanes(page).nth(0).getByRole("img", { name: "生成结果 1", exact: true, includeHidden: true })).toHaveCount(1);
    await expect(workbenchPanes(page).nth(0).getByRole("textbox", { name: "图像提示词", exact: true, includeHidden: true })).toHaveValue("EDIT_A");
    await expect(activePane(page).getByRole("img", { name: "生成结果 1", exact: true })).toHaveCount(0);
    taskB!.status = "success"; taskB!.resultUrls = [`/api/assets/${taskB!.id}/content`];
    await expect(activePane(page).getByRole("img", { name: "生成结果 1", exact: true })).toBeVisible();
    await page.reload();
    await expect(activePane(page).getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("EDIT_B");
    await expect(activePane(page).getByRole("img", { name: "EDIT_B.png", exact: true }).first()).toBeVisible();
    await expect(workbenchPanes(page).nth(0).getByRole("textbox", { name: "图像提示词", exact: true, includeHidden: true })).toHaveValue("EDIT_A");
    await expect(workbenchPanes(page).nth(0).getByRole("img", { name: "EDIT_A.png", exact: true, includeHidden: true }).first()).toHaveCount(1);
    await activePane(page).getByRole("tab", { name: /^历史记录/ }).click();
    await expect(activePane(page).locator("button.image-history-card")).toHaveCount(2);
    await activePane(page).locator("button.image-history-card").last().click();
    await expect(activePane(page).getByRole("img", { name: "生成结果 1", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(2);
    expect(api.submissions.map(task => task.prompt)).toEqual([expect.stringContaining("EDIT_A"), expect.stringContaining("EDIT_B")]);
});

test("seamless uncertain acknowledgement stays attached to its original request and history retry is GET-only", async ({ page, context, api }) => {
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
    await expect(activePane(page).getByText(/原任务仍在处理或待核查/)).toBeVisible();
    await page.reload();
    await expect(workbenchPanes(page)).toHaveCount(2);
    await activePane(page).getByRole("tab", { name: /^历史记录/ }).click();
    // Wait for the failed read, not the shell's initial loading frame, before
    // making the mocked endpoint healthy again.
    await expect(activePane(page).getByRole("button", { name: /^重\s*试$/ })).toBeVisible();
    lookupUnavailable = false;
    api.tasks.get(id)!.status = "success";
    api.tasks.get(id)!.resultUrls = [`/api/assets/${id}/content`];
    // Explicit history refresh is a read of the original task, never a POST.
    await activePane(page).getByRole("button", { name: /^重\s*试$/ }).click();
    await activePane(page).getByRole("tab", { name: "本次结果", exact: true }).click();
    await expect(activePane(page).getByRole("img", { name: "无缝拼接结果", exact: true })).toBeVisible();
    await addTask(page, 3);
    await expect(activePane(page).getByRole("img", { name: "uncertain-source.png", exact: true })).toHaveCount(0);
    await activePane(page).getByRole("tab", { name: /^历史记录/ }).click();
    await expect(activePane(page).getByRole("img", { name: "无缝拼接历史结果" })).toHaveCount(0);
    expect(api.submissions).toHaveLength(1);
});

test("seamless twelve independent source drafts survive continued creation and reload without submissions", async ({ page, api }, testInfo) => {
    await page.goto("/image?tool=seamless-stitch");
    for (let index = 0; index < 12; index++) {
        if (index) await addTask(page, index + 1);
        await activePane(page).locator('input[type="file"]').setInputFiles({ name: `source-${index + 1}.png`, mimeType: "image/png", buffer: IMAGE });
        await expect(activePane(page).getByRole("img", { name: `source-${index + 1}.png`, exact: true })).toBeVisible();
    }
    for (let index = 11; index >= 0; index--) {
        await expect(workbenchPanes(page).nth(index).getByRole("img", { name: `source-${index + 1}.png`, exact: true, includeHidden: true })).toHaveCount(1);
    }
    const registry = await readWorkbenchRegistry(page);
    await page.reload();
    await expect(workbenchPanes(page)).toHaveCount(12);
    await expect(activePane(page).getByRole("img", { name: "source-12.png", exact: true })).toBeVisible();
    expect(await readWorkbenchRegistry(page)).toEqual(registry);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("seamless-12-task-mobile.png"), fullPage: true });
    expect(api.submissions).toHaveLength(0);
});

for (const board of [{ path: "/video", label: "视频提示词", prefix: "VIDEO" }, { path: "/image?tool=image-edit", label: "图像提示词", prefix: "EDIT" }]) {
    test(`${board.prefix} twelve task drafts survive continued creation and a narrow-screen reload without generation`, async ({ page, context, api }, testInfo) => {
        if (board.prefix === "VIDEO") await videoRoutes(context);
        await page.goto(board.path);
        const count = 12;
        for (let index = 0; index < count; index++) {
            if (index) await addTask(page, index + 1);
            await activePane(page).getByRole("textbox", { name: board.label, exact: true }).fill(`${board.prefix}_TASK_${index + 1}`);
        }
        for (let index = count - 1; index >= 0; index--) {
            await expect(workbenchPanes(page).nth(index).getByRole("textbox", { name: board.label, exact: true, includeHidden: true })).toHaveValue(`${board.prefix}_TASK_${index + 1}`);
        }
        const registry = await readWorkbenchRegistry(page);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload();
        await expect(workbenchPanes(page)).toHaveCount(count);
        await expect(activePane(page).getByRole("textbox", { name: board.label, exact: true })).toHaveValue(`${board.prefix}_TASK_${count}`);
        expect(await readWorkbenchRegistry(page)).toEqual(registry);
        await expect(page.getByRole("tablist", { name: "任务列表", exact: true })).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath(`${board.prefix.toLowerCase()}-12-task-mobile.png`), fullPage: true });
        expect(api.submissions).toHaveLength(0);
    });
}
