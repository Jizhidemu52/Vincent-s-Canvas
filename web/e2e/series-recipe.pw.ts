import { test, expect } from "./fixtures";
import { seedRetiredRecipes, snapshotRetiredRecipes, expectRecipeRetired } from "./retired-recipe-fixtures";

test("additional retired series recipe exposes only cloud originals and keeps frozen local projects untouched", async ({ page, context, api }, info) => {
    const before = await seedRetiredRecipes(page, 2);
    const reads: string[] = [], writes: string[] = [];
    context.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/tasks") && request.method() !== "GET") writes.push(request.url()); });
    await context.route("**/api/tasks/history?**", route => {
        const url = new URL(route.request().url()); reads.push(url.searchParams.get("board")!);
        return route.fulfill({ json: { tasks: [{ id: "retired-cloud-task", userId: "00000000-0000-4000-8000-000000000099", status: "success", prompt: "下线前已保存的配色成果", sourceUrls: ["/api/assets/retired-source/content"], resultUrls: ["/api/assets/retired-output/content"], queuedAt: "2026-11-01T03:00:00Z", parameters: {} }], hasMore: false, nextCursor: null } });
    });
    for (const path of ["/creative/series-recipe", "/series-recipe"]) {
        await page.goto(path); await expectRecipeRetired(page);
        await expect(page.getByText("系列配方已下线；这里只读查看此前提交的任务与原成果，不恢复编辑或生成。", { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "查看云端记录：下线前已保存的配色成果", exact: true }).click();
        await expect(page.getByRole("img", { name: "账号历史原件", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Close", exact: true }).click();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("retired-recipe-cloud-readonly-mobile.png"), animations: "disabled" });
    expect(await snapshotRetiredRecipes(page)).toEqual(before);
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(reads)]).toEqual(["series-recipe"]);
    await page.goto("/detail-enhance");
    await expect(page.getByTestId("account-history")).toHaveCount(0);
    expect(writes).toEqual([]); expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("retired series recipe retains frozen candidates, original bytes and task tabs through reload", async ({ page, api }) => {
    const before = await seedRetiredRecipes(page, 2);
    await page.goto("/creative/series-recipe");
    await expectRecipeRetired(page);
    expect(await snapshotRetiredRecipes(page)).toEqual(before);
    await page.reload();
    await expectRecipeRetired(page);
    expect(await snapshotRetiredRecipes(page)).toEqual(before);
    expect(api.submissions).toEqual([]);
    expect(api.batchSubmissions).toEqual([]);
    expect(api.taskReads).toEqual([]);
});

test("retired series recipe never resumes or reposts accepted pending branches from a saved URL", async ({ page, context, api }) => {
    const before = await seedRetiredRecipes(page, 1, true);
    const writes: string[] = [];
    context.on("request", request => {
        if (new URL(request.url()).pathname.startsWith("/api/tasks") && request.method() !== "GET") writes.push(request.url());
    });
    await page.goto("/creative/series-recipe?task=default#saved-project");
    await expectRecipeRetired(page);
    await page.reload();
    await expectRecipeRetired(page);
    expect(await snapshotRetiredRecipes(page)).toEqual(before);
    expect(api.taskReads).toEqual([]);
    expect(writes).toEqual([]);
    expect(api.submissions).toEqual([]);
});
