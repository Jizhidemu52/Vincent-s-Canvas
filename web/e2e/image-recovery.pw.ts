import { test, expect } from "./fixtures";

test("首次认证延迟时不提前恢复任务，刷新后只查询已提交的原图片任务", async ({ page, api }) => {
    api.taskStatus = "queued";
    await page.goto("/image");
    await page.getByRole("textbox", { name: "图像提示词", exact: true }).fill("认证恢复与持久化回归");
    await page.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    await page.getByRole("button", { name: "停止本页查询（不取消服务端任务）", exact: true }).click();
    await expect(page.getByText("原任务查询暂停", { exact: true })).toBeVisible();
    const reads = api.taskReads.length;
    api.holdSession = true;
    await page.reload();
    await expect.poll(() => api.pendingSessions()).toBeGreaterThan(0);
    await expect(page.getByRole("status")).toContainText("正在准备工作区");
    expect(api.taskReads).toHaveLength(reads);
    expect(api.submissions).toHaveLength(1);
    const original = [...api.tasks.values()][0];
    original.status = "success"; original.resultUrls = [`/api/assets/${original.id}/content`];
    await api.releaseSessions();
    await expect.poll(() => api.taskReads.length).toBeGreaterThan(reads);
    await expect(page.getByRole("button", { name: "停止本页查询（不取消服务端任务）", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /下载/ }).first()).toBeVisible();
    expect(api.taskReads.slice(reads).every(path => path.endsWith(original.id))).toBe(true);
    expect(api.submissions).toHaveLength(1);
});
