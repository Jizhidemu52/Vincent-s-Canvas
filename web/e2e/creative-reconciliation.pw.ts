import { test, expect, IMAGE } from "./fixtures";

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
