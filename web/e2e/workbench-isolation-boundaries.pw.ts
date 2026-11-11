import { readFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, IMAGE, type MockCanvasApi } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

const videoBytes = readFileSync(new URL("./media/video.mp4", import.meta.url));
const imageModel = { id: "10000000-0000-4000-8000-000000000001", name: "E2E Image", modelId: "gpt-image-2", capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 };
const videoModel = { id: "10000000-0000-4000-8000-000000000003", name: "E2E Video", modelId: "wan2.7", capabilities: ["video"], creditCost: 0, rmbCost: 0 };
const FIRST_OWNER = "00000000-0000-4000-8000-000000000099";
const SECOND_OWNER = "00000000-0000-4000-8000-000000000088";
const boards = [
    { kind: "video", path: "/video", submit: "生成视频" },
    { kind: "seamless", path: "/image?tool=seamless-stitch", submit: "开始无缝拼接" },
    { kind: "image", path: "/image?tool=image-edit", submit: "开始编辑" },
] as const;
type Board = typeof boards[number];
const pane = (page: Page) => page.getByRole("tabpanel");
const tabs = (page: Page) => page.getByRole("tablist", { name: "任务列表", exact: true }).getByRole("tab");

async function mockModelsAndMedia(context: BrowserContext, api: MockCanvasApi) {
    await context.route("**/api/models", route => route.fulfill({ json: {
        models: [imageModel, videoModel], prices: [],
        tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: tool.toolKey === "video" || tool.toolKey === "canvas-video" ? videoModel.id : imageModel.id, configurationVersion: 1 })),
    } }));
    await context.route("**/api/tasks/preflight", route => route.fulfill({ json: { ok: true, normalized: {} } }));
    await context.route("**/api/tasks/by-request/*", route => {
        const requestId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
        return route.fulfill({ json: { task: [...api.tasks.values()].find(task => task.requestId === requestId) } });
    });
    await context.route("**/api/assets/*/content", route => {
        const id = new URL(route.request().url()).pathname.split("/")[3];
        return api.tasks.get(id)?.operationType === "video_generation" ? route.fulfill({ contentType: "video/mp4", body: videoBytes }) : route.fallback();
    });
    await context.route("**/api/assets/*/playback", route => route.fulfill({ contentType: "video/mp4", body: videoBytes }));
}

async function fill(page: Page, board: Board, marker: string) {
    if (board.kind === "video") await pane(page).getByRole("textbox", { name: "视频提示词", exact: true }).fill(marker);
    if (board.kind === "image") {
        await pane(page).getByRole("textbox", { name: "图像提示词", exact: true }).fill(marker);
        const chooser = page.waitForEvent("filechooser");
        await pane(page).getByRole("button", { name: "上传图片", exact: true }).click();
        await (await chooser).setFiles({ name: `${marker}.png`, mimeType: "image/png", buffer: IMAGE });
    }
    if (board.kind === "seamless") {
        await pane(page).locator('input[type="file"]').setInputFiles({ name: `${marker}.png`, mimeType: "image/png", buffer: IMAGE });
        await expect(pane(page).getByRole("img", { name: `${marker}.png`, exact: true })).toBeVisible();
    }
}

async function expectInput(page: Page, board: Board, marker: string) {
    if (board.kind === "video") await expect(pane(page).getByRole("textbox", { name: "视频提示词", exact: true })).toHaveValue(marker);
    if (board.kind === "image") await expect(pane(page).getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue(marker);
    if (board.kind === "seamless") await expect(pane(page).getByRole("img", { name: `${marker}.png`, exact: true })).toBeVisible();
}

async function expectOriginalResult(page: Page, board: Board) {
    if (board.kind === "video") await expect(pane(page).locator("video")).toHaveCount(1);
    if (board.kind === "seamless") await expect(pane(page).getByRole("img", { name: "无缝拼接结果", exact: true })).toBeVisible();
    if (board.kind === "image") {
        await expect(pane(page).getByRole("img", { name: "生成结果 1", exact: true })).toBeVisible();
    }
}

test("boundary: video initial history delay and failure block new submission until query-only retry restores the original task", async ({ page, context, api }) => {
    await mockModelsAndMedia(context, api);
    api.taskStatus = "queued";
    const taskControlPosts: string[] = [];
    await context.route(/\/api\/tasks\/[^/]+\/(?:cancel|recover)$/, route => {
        taskControlPosts.push(new URL(route.request().url()).pathname);
        return route.fulfill({ status: 409, json: { error: "FIXTURE_QUERY_ONLY_RETRY" } });
    });
    await page.goto("/video");
    await fill(page, boards[0], "ORIGINAL_VIDEO_HISTORY_GATE");
    await pane(page).getByRole("button", { name: "生成视频", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    const originalTask = [...api.tasks.values()][0]!;
    await expect(tabs(page).first()).toContainText("处理中");
    await page.addInitScript(() => {
        const original = IDBObjectStore.prototype.openCursor;
        const success = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "onsuccess")!;
        const callbacks: Array<() => void> = [];
        let mode = sessionStorage.getItem("isolated-video-history-mode");
        const gate = (window as any).__videoHistoryGate = { count: 0, release() {
            mode = null;
            IDBObjectStore.prototype.openCursor = original;
            for (const callback of callbacks.splice(0)) callback();
        } };
        IDBObjectStore.prototype.openCursor = function (...args) {
            if (this.name === "video_generation_logs" && mode === "fail") throw new Error("isolated-video-history-unavailable");
            const request = original.apply(this, args);
            if (this.name !== "video_generation_logs") return request;
            Object.defineProperty(request, "onsuccess", { set(handler) {
                success.set!.call(request, (event: Event) => {
                    if (mode !== "hold" || request.result !== null) return handler.call(request, event);
                    gate.count += 1;
                    callbacks.push(() => handler.call(request, event));
                });
            } });
            return request;
        };
    });
    await page.evaluate(() => sessionStorage.setItem("isolated-video-history-mode", "hold"));
    await page.reload();
    await expect.poll(() => page.evaluate(() => (window as any).__videoHistoryGate.count)).toBeGreaterThan(0);
    await expect(pane(page).getByRole("button", { name: "生成视频", exact: true })).toBeDisabled();
    await expect(pane(page).getByText("正在恢复视频记录…", { exact: true })).toBeVisible();
    await pane(page).getByRole("textbox", { name: "视频提示词", exact: true }).press("Control+Enter");
    expect(api.submissions).toHaveLength(1);
    await page.evaluate(() => (window as any).__videoHistoryGate.release());
    await expect(tabs(page).first()).toContainText("处理中");
    await expectInput(page, boards[0], "ORIGINAL_VIDEO_HISTORY_GATE");
    await expect(pane(page).getByRole("button", { name: "继续生成新视频", exact: true })).toBeEnabled();
    await expect.poll(() => api.taskReads.includes(`/api/tasks/${originalTask.id}`)).toBe(true);
    await page.evaluate(() => sessionStorage.setItem("isolated-video-history-mode", "fail"));
    await page.reload();
    await expect(pane(page).getByRole("alert")).toContainText("isolated-video-history-unavailable");
    await expect(pane(page).getByRole("button", { name: "生成视频", exact: true })).toBeDisabled();
    await pane(page).getByRole("textbox", { name: "视频提示词", exact: true }).press("Control+Enter");
    expect(api.submissions).toHaveLength(1);
    const oldReads = api.taskReads.filter(path => path === `/api/tasks/${originalTask.id}`).length;
    await page.evaluate(() => (window as any).__videoHistoryGate.release());
    await pane(page).getByRole("button", { name: "重新读取视频记录", exact: true }).click();
    await expect(pane(page).getByRole("alert")).toHaveCount(0);
    await expect.poll(() => api.taskReads.filter(path => path === `/api/tasks/${originalTask.id}`).length).toBeGreaterThan(oldReads);
    await expectInput(page, boards[0], "ORIGINAL_VIDEO_HISTORY_GATE");
    expect(api.submissions).toHaveLength(1);
    await pane(page).getByRole("textbox", { name: "视频提示词", exact: true }).fill("EXPLICIT_PARALLEL_VIDEO_AFTER_READ");
    await pane(page).getByRole("button", { name: "继续生成新视频", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(2);
    expect(api.submissions[0]!.requestId).toBe(originalTask.requestId);
    expect(api.submissions[1]!.requestId).not.toBe(originalTask.requestId);
    expect(taskControlPosts).toEqual([]);
    await expect.poll(() => page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const logs: Array<{ requestId?: string; prompt: string }> = [];
        await createWorkspaceStorage("video_generation_logs").iterate<any, void>(value => { logs.push({ requestId: value.requestId, prompt: value.prompt }); });
        return logs;
    })).toEqual(expect.arrayContaining([{ requestId: originalTask.requestId, prompt: "ORIGINAL_VIDEO_HISTORY_GATE" }, { requestId: api.submissions[1]!.requestId, prompt: "EXPLICIT_PARALLEL_VIDEO_AFTER_READ" }]));
});

for (const viewport of [{ width: 1800, height: 1200 }, { width: 390, height: 844 }]) {
    for (const kind of ["image", "video"] as const) {
        test(`boundary: ${kind} repeated pointer clicks retain the original task and query at ${viewport.width}px`, async ({ page, context, api }) => {
            await page.setViewportSize(viewport);
            await mockModelsAndMedia(context, api);
            api.taskStatus = "queued";
            let releaseSubmission!: () => void;
            const submissionGate = new Promise<void>(resolve => { releaseSubmission = resolve; });
            let attempts = 0;
            const controls: string[] = [];
            await context.route(/\/api\/tasks$/, async route => {
                if (route.request().method() !== "POST") return route.fallback();
                attempts += 1;
                await submissionGate;
                return route.fallback();
            });
            await context.route(/\/api\/tasks\/[^/]+\/(?:cancel|recover)$/, route => {
                controls.push(new URL(route.request().url()).pathname);
                return route.fulfill({ status: 409, json: { error: "FIXTURE_NO_TASK_CONTROL_EXPECTED" } });
            });
            try {
                await page.goto(`/${kind}`);
                const prompt = pane(page).getByRole("textbox", { name: kind === "image" ? "图像提示词" : "视频提示词", exact: true });
                await prompt.fill(`POINTER_${kind}_${viewport.width}`);
                const originalTabId = await tabs(page).first().getAttribute("id");
                const submit = pane(page).locator(".generation-submit .ant-btn-primary");
                await expect(submit).toBeEnabled();
                await submit.scrollIntoViewIfNeeded();
                const before = (await submit.boundingBox())!;
                await page.evaluate(() => {
                    (window as any).__submitPointerTargets = [];
                    document.addEventListener("pointerdown", event => {
                        const button = (event.target as Element).closest("button");
                        if (button) (window as any).__submitPointerTargets.push(button.textContent);
                    }, true);
                });
                // Exercise the same physical location across the submitting reflow.
                // Holding the POST keeps this distinct from a deliberate later generation.
                await page.mouse.dblclick(before.x + before.width / 2, before.y + before.height / 2, { delay: 80 });
                await expect.poll(() => attempts).toBe(1);
                await expect(tabs(page)).toHaveCount(1);
                await expect(tabs(page).first()).toHaveAttribute("id", originalTabId!);
                await expect(tabs(page).first()).toHaveAttribute("aria-selected", "true");
                await expect(prompt).toHaveValue(`POINTER_${kind}_${viewport.width}`);
                expect(await page.evaluate(() => (window as any).__submitPointerTargets)).not.toEqual(expect.arrayContaining([expect.stringMatching(/新建任务|停止.*查询/)]));
                const during = (await submit.boundingBox())!;
                expect(Math.abs(during.y - before.y)).toBeLessThan(1);
                releaseSubmission();
                await expect.poll(() => api.submissions.length).toBe(1);
                const original = [...api.tasks.values()][0]!;
                await expect(tabs(page).first()).toContainText("处理中");
                const oldReads = api.taskReads.filter(path => path === `/api/tasks/${original.id}`).length;
                await expect.poll(() => api.taskReads.filter(path => path === `/api/tasks/${original.id}`).length).toBeGreaterThan(oldReads);
                await expect(pane(page).getByRole("button", { name: "停止本页查询（不取消服务端任务）", exact: true })).toBeVisible();
                expect(attempts).toBe(1);
                expect(controls).toEqual([]);
            } finally { releaseSubmission(); }
        });
    }
}

for (const completion of ["before-navigation", "after-navigation"] as const) {
    test(`boundary: duplicate clicks and board navigation retain three original tasks without cancellation or resubmission (${completion})`, async ({ page, context, api }) => {
        await mockModelsAndMedia(context, api);
        api.taskStatus = "queued";
        const controlPosts: string[] = [];
        await context.route(/\/api\/tasks\/[^/]+\/(?:cancel|recover)$/, route => {
            controlPosts.push(new URL(route.request().url()).pathname);
            return route.fulfill({ status: 409, json: { error: "FIXTURE_NO_TASK_CONTROL_EXPECTED" } });
        });
        for (const [index, board] of boards.entries()) {
            await page.goto(board.path);
            await fill(page, board, `BOARD_${board.kind}`);
            await pane(page).getByRole("button", { name: board.submit, exact: true }).dblclick();
            await expect.poll(() => api.submissions.length).toBe(index + 1);
            await expect(tabs(page).first()).toContainText("处理中");
            await expect(tabs(page)).toHaveCount(1);
            await expect(tabs(page).first()).toHaveAttribute("aria-selected", "true");
        }
        const ids = [...api.tasks.keys()];
        expect(ids).toHaveLength(3);
        // The final board is image edit. Complete it deterministically on either side
        // of unmount instead of racing its active observer against navigation.
        if (completion === "after-navigation") {
            await page.goto("/");
            await expect(pane(page)).toHaveCount(0);
        }
        for (const task of api.tasks.values()) { task.status = "success"; task.resultUrls = [`/api/assets/${task.id}/content`]; }
        if (completion === "before-navigation") {
            await expect(pane(page).getByRole("img", { name: "生成结果 1", exact: true })).toBeVisible();
            await expect(tabs(page).first()).toContainText("已完成");
        }
        for (const board of boards) {
            await page.goto(board.path);
            await expectInput(page, board, `BOARD_${board.kind}`);
            if (board.kind === "image" && completion === "before-navigation") {
                await expect(pane(page).getByRole("img", { name: "生成结果 1", exact: true })).toBeVisible();
                await expect(pane(page).getByRole("button", { name: "继续获取结果", exact: true })).toHaveCount(0);
            } else {
                await expectOriginalResult(page, board);
            }
        }
        expect(api.submissions).toHaveLength(3);
        expect(new Set(api.submissions.map(task => task.requestId)).size).toBe(3);
        expect(controlPosts).toEqual([]);
        expect([...api.tasks.keys()]).toEqual(ids);
    });
}

for (const board of boards) {
    test(`boundary: ${board.kind} switches employee without exposing or overwriting another employee's tasks`, async ({ page, context, api }) => {
        await mockModelsAndMedia(context, api);
        api.taskStatus = "queued";
        let secondOwner = false;
        const secondOwnerTaskReads: string[] = [];
        await context.route("**/api/auth/session", route => secondOwner ? route.fulfill({ json: { user: { id: SECOND_OWNER, username: "second", displayName: "第二员工", role: "designer", status: "active", creditBalance: 999 } } }) : route.fallback());
        // Model the server's existing owner filter; an auth test must not return
        // employee A's backend history as if it belonged to employee B.
        await context.route(/\/api\/tasks(?:\?.*)?$/, route => secondOwner && route.request().method() === "GET" ? route.fulfill({ json: { tasks: [], nextCursor: null } }) : route.fallback());
        await context.route(/\/api\/tasks\/(?:by-request\/)?[^/?]+(?:\/progress)?$/, route => {
            if (!secondOwner) return route.fallback();
            // An already-started A request can reach the server while its session check is in flight.
            // It remains bound to A and must be rejected; it is not a request from B's workspace.
            if (route.request().headers()["x-canvas-owner-id"] !== FIRST_OWNER)
                secondOwnerTaskReads.push(new URL(route.request().url()).pathname);
            return route.fulfill({ status: 404, json: { error: "FIXTURE_OTHER_OWNER" } });
        });
        await page.goto(board.path);
        await page.getByRole("button", { name: "新建任务", exact: true }).click();
        await expect(tabs(page)).toHaveCount(2);
        await fill(page, board, `EMPLOYEE_A_${board.kind}`);
        await pane(page).getByRole("button", { name: board.submit, exact: true }).click();
        await expect.poll(() => api.submissions.length).toBe(1);
        await expect(tabs(page).nth(1)).toContainText("处理中");
        secondOwner = true;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(page.getByRole("heading", { name: "登录状态已变化，工作区已暂停", exact: true })).toBeVisible();
        await expect(page.getByRole("tabpanel")).toHaveCount(0);
        const original = [...api.tasks.values()][0]!;
        original.status = "success"; original.resultUrls = [`/api/assets/${original.id}/content`];
        await page.reload();
        await expect(tabs(page)).toHaveCount(1);
        await expect(tabs(page).first()).toContainText("草稿");
        if (board.kind === "video") await expect(pane(page).getByRole("textbox", { name: "视频提示词", exact: true })).toHaveValue("");
        if (board.kind === "image") await expect(pane(page).getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("");
        await expect(pane(page).getByText(`EMPLOYEE_A_${board.kind}`, { exact: true })).toHaveCount(0);
        await expect(pane(page).getByRole("img", { name: `EMPLOYEE_A_${board.kind}.png`, exact: true })).toHaveCount(0);
        await expect(pane(page).locator('video, img[alt="生成结果 1"]')).toHaveCount(0);
        await expect(pane(page).getByRole("img", { name: "无缝拼接结果", exact: true })).toHaveCount(0);
        await fill(page, board, `EMPLOYEE_B_${board.kind}`);
        // Read-only persistence evidence before a deliberate full reload.
        await expect.poll(() => page.evaluate(async ({ kind }) => {
            const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
            if (kind === "image") return createWorkspaceStorage("generation_drafts").getItem<string>("image-edit:prompt");
            const drafts = createWorkspaceStorage("generation_drafts");
            return kind === "video" ? drafts.getItem<string>("video:prompt") : (await drafts.getItem<any>("seamless-stitch:source"))?.name?.replace(/\.png$/, "");
        }, { kind: board.kind })).toBe(`EMPLOYEE_B_${board.kind}`);
        secondOwner = false;
        await page.reload();
        await expect(tabs(page)).toHaveCount(2);
        await expectInput(page, board, `EMPLOYEE_A_${board.kind}`);
        await expectOriginalResult(page, board);
        secondOwner = true;
        await page.reload();
        await expect(tabs(page)).toHaveCount(1);
        await expectInput(page, board, `EMPLOYEE_B_${board.kind}`);
        expect(api.submissions).toHaveLength(1);
        expect(secondOwnerTaskReads.filter(path => path.includes(original.id) || path.includes(original.requestId))).toEqual([]);
    });
}
