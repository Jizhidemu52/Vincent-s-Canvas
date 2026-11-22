import { test, expect, IMAGE } from "./fixtures";
import { activeWorkbench, readWorkspaceRecords } from "./headless-workbench";
import type { SceneLog } from "../src/pages/creative/use-scene-workspace";

for (const optimize of [false, true]) test(`garment colorway restores one coherent observation on visibility and retrieves the original image on reload (optimize=${optimize})`, async ({ page, api }, info) => {
    const taskId = "cd14d28a-f862-40cd-9977-5ef320218941";
    let phase: "uncertain" | "optimizing" | "processing" | "success" = "uncertain", posts = 0, requestId = "";
    await page.route("**/api/tasks", route => {
        if (route.request().method() !== "POST") return route.fallback();
        posts++;
        requestId = route.request().postDataJSON().requestId;
        return route.fulfill({ status: 504, json: { message: "Gateway timeout" } });
    });
    const task = () => ({ task: { id: taskId, requestId, status: phase, resultUrls: phase === "success" ? [`/api/assets/${taskId}/content`] : [], failureReason: null } });
    await page.route("**/api/tasks/by-request/*", route => phase === "processing" || phase === "success" ? route.fulfill({ json: task() }) : route.fulfill({ status: 404, json: {} }));
    await page.route(`**/api/tasks/${taskId}`, route => route.fulfill({ json: task() }));
    await page.route(`**/api/tasks/${taskId}/progress`, route => route.fulfill({ status: 404, json: {} }));
    await page.route("**/api/prompt-compilations/by-request/*", route => route.fulfill({ json: { compilation: {
        id: "12345678-1234-4123-8123-123456789abc", requestId, status: phase,
    } } }));
    await page.goto("/creative/garment-colorway");
    const pane = activeWorkbench(page);
    await pane.getByLabel("上传服装参考图", { exact: true }).setInputFiles({ name: "original-garment.png", mimeType: "image/png", buffer: IMAGE });
    const optimization = pane.getByRole("checkbox", { name: "本次先优化提示词" });
    await expect(optimization).not.toBeChecked();
    if (optimize) await optimization.check();
    await pane.locator("button.cs-generate").click();
    const stored = async () => (await readWorkspaceRecords<SceneLog>(page, "creative_scene_workspaces"))
        .find(row => row.key.startsWith("history-record:"))?.value.results[0];
    await expect.poll(async () => (await stored())?.failureKind).toBe("uncertain");
    const wake = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    phase = "optimizing"; await wake();
    await expect(pane.getByText(optimize ? "正在准备提示词 · 方案 1" : "正在提交图片任务 · 方案 1", { exact: true })).toBeVisible();
    await expect(pane.getByText(optimize ? "正在准备提示词，请稍候。" : "正在核对设计输入，尚未确认出图。", { exact: true })).toBeVisible();
    await expect(pane.getByText(/方案 1 暂时无法获取进度/)).toHaveCount(0);
    expect((await stored())?.failureKind).toBeUndefined();
    await page.screenshot({ path: info.outputPath("garment-preparing.png") });
    phase = "processing"; await wake();
    await expect(pane.getByText("图片生成中 · 方案 1", { exact: true })).toBeVisible();
    await expect(pane.getByText("正在准备提示词，请稍候。", { exact: true })).toHaveCount(0);
    expect(await stored()).toMatchObject({ status: "pending", progress: "generating", taskId, requestId });
    phase = "success"; await page.reload();
    const recovered = activeWorkbench(page).getByRole("img", { name: "服装配色结果 1", exact: true });
    await expect(recovered).toBeVisible();
    await expect.poll(() => recovered.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await stored()).toMatchObject({ status: "success", taskId, requestId });
    expect((await stored())?.error).toBeUndefined();
    expect(posts).toBe(1);
    expect(api.submissions).toEqual([]);
    await page.screenshot({ path: info.outputPath("garment-original-recovered.png") });
});

test("try-on refresh adopts an already successful original task without another submission", async ({ page, api }, info) => {
    api.taskStatus = "paused";
    await page.goto("/creative/virtual-try-on");
    await page.getByLabel("上传产品图", { exact: true }).setInputFiles({ name: "synthetic-garment.png", mimeType: "image/png", buffer: IMAGE });
    await page.getByRole("textbox", { name: "成人模特与试穿要求", exact: true }).fill("成年模特正面站姿，保留衣服材质");
    await page.getByRole("button", { name: /^生成试穿效果/ }).click();
    await expect(page.getByRole("button", { name: "刷新进度", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(1);
    const original = [...api.tasks.values()][0]!;
    const requestId = original.requestId;
    original.status = "success";
    original.resultUrls = [`/api/assets/${original.id}/content`];
    original.queuedAt = "2026-11-10T08:26:12.742Z";
    original.completedAt = "2026-11-10T08:26:35.465Z";
    await page.reload();
    await expect(page.getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "刷新进度", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "成人模特与试穿要求", exact: true })).toHaveValue("成年模特正面站姿，保留衣服材质");
    expect(api.submissions).toHaveLength(1);
    expect(api.submissions[0].requestId).toBe(requestId);
    expect(api.taskReads).toContain(`/api/tasks/${original.id}`);
    await page.screenshot({ path: info.outputPath("try-on-original-restored.png"), fullPage: true });
    await page.reload();
    await expect(page.getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(1);
});

test("a failed compilation with authoritative no-task lookup permits resubmission only after an explicit click", async ({ page, api }) => {
    let requestId = "";
    let postCount = 0;
    const requestIds: string[] = [];
    await page.route("**/api/tasks", async route => {
        if (route.request().method() !== "POST") return route.fallback();
        postCount++;
        requestId = route.request().postDataJSON().requestId;
        requestIds.push(requestId);
        return route.fulfill({ status: 504, json: { message: "Gateway timeout" } });
    });
    await page.route("**/api/tasks/by-request/*", route => route.fulfill({ status: 404, json: { error: "NOT_FOUND" } }));
    await page.route("**/api/prompt-compilations/by-request/*", route => route.fulfill({ json: { compilation: {
        id: "12345678-1234-4123-8123-123456789abc", requestId, status: "failed", errorCode: "PROMPT_OPTIMIZATION_FAILED", message: "提示词准备失败，尚未提交图片生成，请重试。",
    } } }));
    await page.goto("/creative/text-to-style");
    await page.getByRole("textbox", { name: "款式描述", exact: true }).fill("蓝色圆领针织衫");
    await page.locator("button.cs-generate").click();
    // No image task was admitted, so the retained draft can be submitted again.
    // Per-result original-parameter retry is reserved for an admitted failed task.
    await expect(page.locator("button.cs-generate")).toBeEnabled();
    await expect(page.getByText("方案 1 生成失败", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "刷新进度", exact: true })).toHaveCount(0);
    await expect(page.getByText("原任务状态尚未确认，请继续查询原任务，不要重复生成。", { exact: true })).toHaveCount(0);
    expect(postCount).toBe(1);
    expect(api.submissions).toHaveLength(0);
    expect(api.tasks.size).toBe(0);
    await page.locator("button.cs-generate").click();
    await expect.poll(() => postCount).toBe(2);
    expect(new Set(requestIds).size).toBe(2);
    await expect(page.getByText("方案 1 生成失败", { exact: true })).toBeVisible();
    expect(api.tasks.size).toBe(0);
});

for (const [code, message] of [
    ["PROMPT_PREPARATION_FAILED", "提示词准备失败，本次未提交生成。"],
    ["PROMPT_PREPARATION_TIMEOUT", "提示词准备超时，本次已结束，未提交生成。"],
]) test(`preparation stays pending and ends clearly for ${code} without resubmission`, async ({ page, api }, info) => {
    let requestId = "", postCount = 0, terminal = false;
    await page.route("**/api/tasks", async route => {
        if (route.request().method() !== "POST") return route.fallback();
        postCount++;
        requestId = route.request().postDataJSON().requestId;
        return route.fulfill({ status: 504, json: { message: "Gateway timeout" } });
    });
    await page.route("**/api/tasks/by-request/*", route => route.fulfill({ status: 404, json: { error: "NOT_FOUND" } }));
    await page.route("**/api/prompt-compilations/by-request/*", route => route.fulfill({ json: { compilation: {
        id: "12345678-1234-4123-8123-123456789abc", requestId, status: terminal ? "failed" : "optimizing",
        ...(terminal ? { errorCode: code, message: "提示词准备未完成" } : {}),
    } } }));
    await page.goto("/creative/text-to-style");
    const pane = activeWorkbench(page);
    await pane.getByRole("textbox", { name: "款式描述", exact: true }).fill("蓝色圆领针织衫");
    await pane.getByRole("checkbox", { name: "本次先优化提示词" }).check();
    await pane.locator("button.cs-generate").click();
    const result = async () => (await readWorkspaceRecords<SceneLog>(page, "creative_scene_workspaces"))
        .filter(record => record.key.startsWith("history-record:"))[0]?.value.results[0];
    await expect.poll(async () => (await result())?.status).toBe("pending");
    await expect(pane.getByText("方案 1 生成失败", { exact: true })).toHaveCount(0);
    await expect(pane.getByText("正在准备提示词，请稍候。", { exact: true })).toBeVisible();
    expect((await result())?.failureKind).toBeUndefined();
    expect(postCount).toBe(1);
    await page.screenshot({ path: info.outputPath("preparation-pending.png"), fullPage: true });
    terminal = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(pane.getByText("方案 1 生成失败", { exact: true })).toBeVisible();
    await expect(pane.getByText(message, { exact: true })).toBeVisible();
    await expect(pane.getByRole("button", { name: "刷新进度", exact: true })).toHaveCount(0);
    await expect(pane.getByRole("button", { name: "暂停获取进度", exact: true })).toHaveCount(0);
    await expect(pane.locator("button.cs-generate")).toBeEnabled();
    expect(await result()).toMatchObject({ status: "failed", failureKind: "local", requestId });
    expect((await result())?.compilationId).toBeUndefined();
    expect((await result())?.recovery).toBeUndefined();
    await page.reload();
    await expect(activeWorkbench(page).getByText(message, { exact: true })).toBeVisible();
    expect(postCount).toBe(1);
    expect(api.tasks.size).toBe(0);
    expect(api.submissions).toHaveLength(0);
    await page.screenshot({ path: info.outputPath("preparation-terminal-after-reload.png"), fullPage: true });
});
