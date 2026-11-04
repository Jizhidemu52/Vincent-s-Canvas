import { test, expect, type BrowserContext, type Route } from "@playwright/test";
import { resolve } from "node:path";
import { fixture, personId } from "./fixture";
const taskId = "00000000-0000-4000-8000-000000000010",
    assetId = "00000000-0000-4000-8000-000000000011",
    otherId = "00000000-0000-4000-8000-000000000004";
const base = "/tests/usage-v2-browser/index.html?tab=usage-analysis&uFrom=2026-10-01&uTo=2026-10-07&uTab=people";
const output = resolve(import.meta.dirname, "../../../output/usage-task-detail-browser");
const taskData = (userId: string, page: number) => ({
    userId,
    taskId,
    asOf: "2026-11-04T01:00:00Z",
    status: "success",
    operationType: "image_generation",
    boardKey: "image",
    modelName: "隔离测试模型",
    queuedAt: "2026-11-01T01:00:00Z",
    startedAt: "2026-11-01T01:00:03Z",
    completedAt: "2026-11-01T01:00:08Z",
    timing: { waitMs: 3000, runMs: 5000, totalMs: 8000 },
    bookedCny: "0.123456",
    parameters: { size: "1024x1024", quality: "high" },
    submittedReferenceCount: 0,
    results: {
        items: Array.from({ length: page === 1 ? 12 : 1 }, (_, i) => ({
            position: (page - 1) * 12 + i + 1,
            assetId: i === 0 ? assetId : null,
            kind: i === 0 ? "image" : null,
            thumbnailAvailable: i === 0,
            previewAvailable: i === 0,
            evidence:
                i === 0
                    ? [
                          {
                              eventType: "asset.downloaded",
                              count: 1,
                              lastAt: "2026-11-01T01:00:09Z",
                              basis: "client_reported",
                          },
                      ]
                    : [],
        })),
        pagination: { page, pageSize: 12, total: 13 },
        available: true,
    },
});
async function setup(context: BrowserContext, extra?: (route: Route, url: URL) => Promise<boolean>) {
    const calls: Array<{ url: string; body: any }> = [],
        errors: string[] = [];
    for (const page of context.pages()) page.on("pageerror", (e) => errors.push(e.message));
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1") return route.abort();
        if (!url.pathname.startsWith("/api/")) return route.continue();
        calls.push({ url: `${url.pathname}${url.search}`, body: route.request().postDataJSON() });
        if (extra && (await extra(route, url))) return;
        const task = /\/people\/([^/]+)\/tasks\/([^/]+)/.exec(url.pathname);
        if (task)
            return route.fulfill({
                json: {
                    code: 0,
                    data: url.pathname.endsWith("/prompt")
                        ? {
                              userId: task[1],
                              taskId,
                              prompt: "EXPLICIT_PRIVATE_PROMPT",
                              userInput: "EXPLICIT_USER_TEXT",
                              promptLength: 23,
                              userInputLength: 18,
                              truncated: false,
                          }
                        : taskData(task[1]!, Number(url.searchParams.get("page") || 1)),
                },
            });
        if (url.pathname.endsWith("/thumb"))
            return route.fulfill({
                contentType: "image/png",
                body: Buffer.from(
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6N1sAAAAASUVORK5CYII=",
                    "base64",
                ),
            });
        const data = fixture(url) as any;
        if (url.pathname.endsWith("/profile")) {
            const userId = url.pathname.split("/").at(-2)!;
            data.person = {
                ...data.person,
                userId,
                displayName: userId === personId ? "测试设计师甲" : "测试设计师乙",
            };
            data.activityPage.records[0].id = `task:${taskId}`;
        }
        return route.fulfill({ json: { code: 0, data } });
    });
    return {
        calls,
        errors,
        details: () => calls.filter((c) => /\/tasks\//.test(c.url) && !c.url.includes("/prompt")),
        prompts: () => calls.filter((c) => c.url.includes("/prompt")),
        thumbs: () => calls.filter((c) => c.url.includes("/thumb")),
    };
}
test("timeline detail, result pages, thumbnails and raw prompts are independently explicit", async ({
    page,
    context,
}) => {
    const state = await setup(context);
    await page.goto(`${base}&uPerson=${personId}`);
    await expect(page.getByRole("heading", { name: "测试设计师甲 · 个人使用画像" })).toBeVisible();
    expect(state.details()).toHaveLength(0);
    expect(state.prompts()).toHaveLength(0);
    expect(state.thumbs()).toHaveLength(0);
    await page.getByRole("button", { name: "查看任务详情", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "单任务详情 · 按需读取" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("¥0.123456", { exact: true })).toBeVisible();
    await expect(dialog.getByText("尺寸：1024x1024", { exact: true })).toBeVisible();
    await expect(dialog.getByText("请求张数：缺失", { exact: true })).toBeVisible();
    expect(state.prompts()).toHaveLength(0);
    expect(state.thumbs()).toHaveLength(0);
    await dialog.getByTestId("usage-task-result-1").getByRole("button", { name: "加载缩略图", exact: true }).click();
    await expect(dialog.getByRole("img", { name: "结果项 1 缩略预览", exact: true })).toBeVisible();
    expect(state.thumbs()[0]?.url).toBe(
        `/api/assets/${assetId}/thumb?w=256&pending=1&usageUserId=${personId}&usageTaskId=${taskId}`,
    );
    await dialog.getByTestId("usage-task-result-1").getByRole("button", { name: "查看较大预览", exact: true }).click();
    await expect.poll(() => state.thumbs().length).toBe(2);
    expect(state.thumbs()[1]?.url).toContain("w=1024&pending=1");
    await dialog.getByRole("button", { name: "明确查看此任务原始提示词", exact: true }).click();
    await expect(dialog.getByText("EXPLICIT_PRIVATE_PROMPT", { exact: true })).toBeVisible();
    expect(state.prompts()[0]?.body).toEqual({ confirm: true });
    await dialog.getByTestId("usage-task-detail").evaluate((element) => {
        element.scrollTop = 0;
    });
    await page.screenshot({ path: resolve(output, "task-detail-explicit-desktop.png"), animations: "disabled" });
    await dialog.locator(".ant-pagination-item-2").click();
    await expect(dialog.getByTestId("usage-task-result-13")).toBeVisible();
    await expect(dialog.getByTestId("usage-task-result-1")).toHaveCount(0);
    expect(state.details()).toHaveLength(2);
    expect(state.thumbs()).toHaveLength(2);
    expect(state.prompts()).toHaveLength(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
    await page.screenshot({ path: resolve(output, "task-detail-explicit-mobile.png"), animations: "disabled" });
    expect(state.calls.some((c) => /\/content|analysis-preview|\/analyze|rollups\/recompute/.test(c.url))).toBe(false);
    expect(state.errors).toEqual([]);
});
test("cancelled details and prompts cannot appear under a different employee; pending thumbnails never fall back", async ({
    page,
    context,
}) => {
    let mode = "hold-detail",
        release: (() => void) | undefined;
    const state = await setup(context, async (route, url) => {
        const held =
            (mode === "hold-detail" && /\/tasks\/[^/]+$/.test(url.pathname)) ||
            (mode === "hold-prompt" && url.pathname.endsWith("/prompt"));
        if (held) {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            await route
                .fulfill({
                    json: {
                        code: 0,
                        data:
                            mode === "hold-detail"
                                ? taskData(personId, 1)
                                : {
                                      userId: personId,
                                      taskId,
                                      prompt: "LATE_PRIVATE_MUST_NOT_SHOW",
                                      userInput: null,
                                      promptLength: 26,
                                      userInputLength: null,
                                      truncated: false,
                                  },
                    },
                })
                .catch(() => undefined);
            return true;
        }
        if (url.pathname.endsWith("/thumb")) {
            await route.fulfill({ status: 202 });
            return true;
        }
        return false;
    });
    await page.goto(`${base}&uPerson=${personId}`);
    await page.getByRole("button", { name: "查看任务详情", exact: true }).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
    await page.getByRole("button", { name: "← 返回人员列表", exact: true }).click();
    await page.getByRole("button", { name: "测试设计师乙", exact: true }).click();
    release?.();
    mode = "normal";
    await expect(page.getByRole("heading", { name: "测试设计师乙 · 个人使用画像" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "单任务详情 · 按需读取" })).toHaveCount(0);
    await page.getByRole("button", { name: "查看任务详情", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "单任务详情 · 按需读取" });
    await expect(dialog.getByText("¥0.123456", { exact: true })).toBeVisible();
    await dialog.getByTestId("usage-task-result-1").getByRole("button", { name: "加载缩略图", exact: true }).click();
    await expect(dialog.getByText(/缩略图暂不可用/)).toBeVisible();
    expect(state.thumbs()).toHaveLength(1);
    expect(state.thumbs()[0]?.url).toContain(`usageUserId=${otherId}`);
    mode = "hold-prompt";
    release = undefined;
    await dialog.getByRole("button", { name: "明确查看此任务原始提示词", exact: true }).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await dialog.getByRole("button", { name: "关闭任务详情", exact: true }).click();
    release?.();
    await expect(page.getByText("LATE_PRIVATE_MUST_NOT_SHOW")).toHaveCount(0);
    expect(state.prompts()).toHaveLength(1);
    expect(state.calls.some((c) => c.url.includes("/content"))).toBe(false);
    expect(state.errors).toEqual([]);
});
