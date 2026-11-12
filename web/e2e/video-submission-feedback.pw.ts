import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const videoModel = { id: "10000000-0000-4000-8000-000000000005", modelId: "doubao-seedance-2.5", name: "隔离视频模型", capabilities: ["video"], creditCost: 0, rmbCost: 0 };

async function prepare(page: Page) {
    await page.route("**/api/models", route => route.fulfill({ json: { models: [videoModel], prices: [], tools: [{ toolKey: "video", enabled: true, modelConfigId: videoModel.id, configurationVersion: 1 }] } }));
    await page.route("**/api/tasks/preflight", route => route.fulfill({ json: { ok: true, normalized: {} } }));
    await page.goto("/video");
    await expect(page.getByRole("textbox", { name: "视频提示词", exact: true })).toBeEnabled();
    await page.getByRole("textbox", { name: "视频提示词", exact: true }).fill("镜头缓慢拉近服装领口");
    await expect(page.getByRole("button", { name: "生成视频", exact: true })).toBeEnabled();
}

async function diagnostic(page: Page) {
    await page.getByRole("button", { name: "复制诊断信息", exact: true }).click();
    return page.evaluate(() => navigator.clipboard.readText());
}

test("video recipe 503 is a definite failed submission, with no recovery loop after reload", async ({ page, context, api }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    let posts = 0, lookups = 0, requestId = "";
    await page.route("**/api/tasks", route => {
        if (route.request().method() !== "POST") return route.fallback();
        posts++; requestId = route.request().postDataJSON().requestId;
        return route.fulfill({ status: 503, json: { error: "PROMPT_RECIPE_UNAVAILABLE", message: "管理员尚未启用此场景的配方版本，未提交生成" } });
    });
    await page.route("**/api/tasks/by-request/**", route => { lookups++; return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } }); });
    await prepare(page);
    await page.getByRole("button", { name: "生成视频", exact: true }).click();
    await expect(page.getByRole("button", { name: "按原参数重试", exact: true })).toBeVisible();
    await expect(page.locator("p[role=alert]")).toContainText("尚未提交生成");
    await expect(page.getByRole("button", { name: "继续获取结果", exact: true })).toHaveCount(0);
    const copied = await diagnostic(page);
    expect(copied).toContain("PROMPT_RECIPE_UNAVAILABLE");
    expect(copied).toContain(`requestId: ${requestId}`);
    await page.reload();
    await page.getByRole("tab", { name: /^历史记录/ }).click();
    await page.getByRole("button", { name: /镜头缓慢拉近服装领口.*失败/ }).click();
    await expect(page.getByRole("button", { name: "按原参数重试", exact: true })).toBeVisible();
    expect(await diagnostic(page)).toContain("PROMPT_RECIPE_UNAVAILABLE");
    expect(posts).toBe(1); expect(lookups).toBe(0);
    expect(api.submissions).toHaveLength(0);
});

test("an unknown video 503 keeps the first diagnostic through missing lookup and reload, without a second POST", async ({ page, context, api }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    let posts = 0, requestId = "";
    const lookups: { requestId: string; method: string }[] = [];
    await page.route("**/api/tasks", route => {
        if (route.request().method() !== "POST") return route.fallback();
        posts++; requestId = route.request().postDataJSON().requestId;
        return route.fulfill({ status: 503, json: { error: "UNKNOWN_SUBMISSION_STATE", message: "original-video-503-diagnostic" } });
    });
    await page.route("**/api/tasks/by-request/**", route => {
        lookups.push({ requestId: decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!), method: route.request().method() });
        return route.fulfill({ status: 404, json: { error: "NOT_FOUND", message: "later lookup 404" } });
    });
    await prepare(page);
    await page.getByRole("button", { name: "生成视频", exact: true }).click();
    const resume = page.getByRole("button", { name: "继续获取结果", exact: true });
    await expect(resume).toBeVisible();
    await expect(resume).toBeEnabled();
    // The uncertain POST already performs one GET before exposing recovery.
    expect(requestId).not.toBe("");
    expect(lookups).toEqual([{ requestId, method: "GET" }]);
    const expectFirstDiagnostic = (copied: string) => {
        expect(copied).toContain("original-video-503-diagnostic");
        expect(copied).toContain("HTTP 503");
        expect(copied).toContain(`requestId: ${requestId}`);
        expect(copied).not.toContain("later lookup 404");
    };
    expectFirstDiagnostic(await diagnostic(page));
    await resume.click();
    await expect.poll(() => lookups).toEqual(Array.from({ length: 2 }, () => ({ requestId, method: "GET" })));
    await expect(resume).toBeVisible();
    await expect(resume).toBeEnabled();
    expectFirstDiagnostic(await diagnostic(page));
    expect(posts).toBe(1);
    await page.reload();
    await expect.poll(() => lookups).toEqual(Array.from({ length: 3 }, () => ({ requestId, method: "GET" })));
    await expect(resume).toBeVisible();
    await expect(resume).toBeEnabled();
    expectFirstDiagnostic(await diagnostic(page));
    expect(posts).toBe(1);
    expect(api.submissions).toHaveLength(0);
});

test("a confirmed video task failure copies the real server task ID and request ID", async ({ page, context, api }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const taskId = "20000000-0000-4000-8000-000000000005";
    let posts = 0, requestId = "";
    await page.route("**/api/tasks", route => {
        if (route.request().method() !== "POST") return route.fallback();
        posts++; requestId = route.request().postDataJSON().requestId;
        return route.fulfill({ json: { task: { id: taskId, requestId, status: "queued", resultUrls: [], failureReason: null } } });
    });
    await page.route(`**/api/tasks/${taskId}`, route => route.fulfill({ json: { task: { id: taskId, requestId, status: "failed", resultUrls: [], failureReason: "当前模型不支持这组参数或参考素材，请检查尺寸、格式和参考图数量后重试。" } } }));
    await prepare(page);
    await page.getByRole("button", { name: "生成视频", exact: true }).click();
    await expect(page.getByRole("button", { name: "按原参数重试", exact: true })).toBeVisible();
    const copied = await diagnostic(page);
    expect(copied).toContain(`taskId: ${taskId}`);
    expect(copied).toContain(`requestId: ${requestId}`);
    expect(posts).toBe(1); expect(api.submissions).toHaveLength(0);
});
