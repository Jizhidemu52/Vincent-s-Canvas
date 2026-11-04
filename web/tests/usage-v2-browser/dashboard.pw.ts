import { test, expect, type Page, type BrowserContext, type Route } from "@playwright/test";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { fixture, personId, departmentId, modelId } from "./fixture";
import { peopleComparisonFixture } from "./people-comparison-fixture";
const base = "/tests/usage-v2-browser/index.html?tab=usage-analysis&uFrom=2026-10-01&uTo=2026-10-07";
const output = resolve(import.meta.dirname, "../../../output/usage-frontend-browser");
async function setup(context: BrowserContext, handle?: (route: Route, url: URL) => Promise<boolean>) {
    const calls: Array<{ url: URL; method: string; body: any }> = [],
        errors: string[] = [];
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    for (const page of context.pages()) page.on("pageerror", (error) => errors.push(error.message));
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1") return route.abort();
        if (!url.pathname.startsWith("/api/")) return route.continue();
        calls.push({ url, method: route.request().method(), body: route.request().postDataJSON() });
        if (handle && (await handle(route, url))) return;
        const ok = (data: unknown) => route.fulfill({ json: { code: 0, data, msg: "ok" } });
        if (url.pathname.endsWith("analysis-models")) return ok({ models: [{ id: modelId, name: "隔离文字模型" }] });
        if (url.pathname.endsWith("analysis-preview"))
            return ok({ previewId: "frozen-id", previewHash: "frozen-hash", expiresAt: "2099-01-01T00:00:00Z", content: "合成聚合汇总，不含人员姓名与原始提示词。", estimatedCharacters: 24, includesPromptSamples: false, sampleCount: 0, warnings: [] });
        if (url.pathname.endsWith("/analyze")) return route.fulfill({ status: 503, json: { code: "PROVIDER_FAILED", msg: "Do not repeat" } });
        if (url.pathname.endsWith("/export"))
            return route.fulfill({
                headers: { "content-type": "application/x-ndjson" },
                body: JSON.stringify({ type: "manifest", filters: {}, coverage: {}, exportedAt: "2026-11-04T00:00:00Z" }) + "\n" + JSON.stringify({ type: "record", record: { id: "test" } }) + "\n",
            }); // deliberately incomplete
        try {
            return ok(fixture(url));
        } catch {
            return route.fulfill({ status: 501, json: { code: "UNMOCKED" } });
        }
    });
    return { calls, errors };
}
async function loaded(page: Page) {
    await expect(page.getByTestId("usage-v2-content")).toBeVisible();
}
test("six tabs, URL scope, real sorting/pagination requests and profile work without fabricated metrics", async ({ page, context }) => {
    const state = await setup(context);
    await page.goto(base);
    await loaded(page);
    await expect(page.getByRole("tab")).toHaveCount(6);
    await expect(page.locator('[data-usage-metric*="可见活跃时长"]').getByText("不可用", { exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(output, "overview-light.png"), fullPage: true });
    for (const name of ["板块与功能", "模型与成本", "生成质量", "流程分析", "人员"]) {
        await page.getByRole("tab", { name, exact: true }).click();
        await loaded(page);
    }
    await page.getByRole("columnheader", { name: "活跃天数" }).click();
    await loaded(page);
    expect(state.calls.some((call) => call.url.pathname.endsWith("people-v2") && call.url.searchParams.get("sort") === "activeDays")).toBe(true);
    await page.locator(".ant-pagination-item-2").click();
    await loaded(page);
    expect(state.calls.some((call) => call.url.pathname.endsWith("people-v2") && call.url.searchParams.get("page") === "2")).toBe(true);
    await page.getByRole("button", { name: "测试设计师甲", exact: true }).click();
    await loaded(page);
    await expect(page).toHaveURL(new RegExp(`uPerson=${personId}`));
    await expect(page.getByRole("heading", { name: "测试设计师甲 · 个人使用画像" })).toBeVisible();
    expect(state.calls.some((call) => /\/people\/[^/]+\/profile$/.test(call.url.pathname))).toBe(true);
    expect(state.calls.filter((call) => /\/people\/[^/]+$/.test(call.url.pathname))).toHaveLength(0);
    await page.getByRole("button", { name: "← 返回人员列表" }).click();
    await loaded(page);
    await page.getByLabel("分析部门筛选").click();
    await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").filter({ hasText: "隔离设计部" }).click();
    await page.getByLabel("分析部门筛选").press("Escape");
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await loaded(page);
    await expect
        .poll(() =>
            state.calls
                .filter((call) => call.url.pathname.endsWith("people-v2"))
                .at(-1)
                ?.url.searchParams.get("departmentIds"),
        )
        .toBe(departmentId);
    await expect(page.getByText("当前筛选不支持旧版操作")).toBeVisible();
    await expect(page.getByRole("button", { name: "导出完整 JSONL", exact: true })).toBeDisabled();
    await page.reload();
    await loaded(page);
    expect(new URL(page.url()).searchParams.get("uDepartments")).toBe(departmentId);
    await expect(page.getByLabel("分析部门筛选")).toBeVisible();
    await page.getByRole("button", { name: "清除维度筛选", exact: true }).click();
    await loaded(page);
    await page.locator(".ant-pagination-item-3").click();
    await loaded(page);
    await expect
        .poll(() =>
            state.calls
                .filter((call) => call.url.pathname.endsWith("people-v2"))
                .at(-1)
                ?.url.searchParams.get("page"),
        )
        .toBe("3");
    await page.goBack();
    await loaded(page);
    await expect
        .poll(() =>
            state.calls
                .filter((call) => call.url.pathname.endsWith("people-v2"))
                .at(-1)
                ?.url.searchParams.get("departmentIds"),
        )
        .toBe(departmentId);
    await expect
        .poll(() =>
            state.calls
                .filter((call) => call.url.pathname.endsWith("people-v2"))
                .at(-1)
                ?.url.searchParams.get("page"),
        )
        .toBe("1");
    expect(state.errors).toEqual([]);
});
test("export PNG/PDF/Excel produces real files and incomplete JSONL is not saved", async ({ page, context }) => {
    const state = await setup(context);
    await page.goto(base);
    await loaded(page);
    await expect(page.locator("[data-usage-chart] canvas").first()).toBeVisible();
    for (const [button, extension, magic] of [
        ["图片", ".png", "PNG"],
        ["PDF", ".pdf", "%PDF"],
        ["Excel 当前页", ".xlsx", "PK"],
    ] as const) {
        await page.getByRole("button", { name: button, exact: true }).click();
        const downloading = page.waitForEvent("download");
        await page.getByRole("button", { name: "确认导出", exact: true }).click();
        const download = await downloading;
        const path = resolve(output, `report${extension}`);
        await download.saveAs(path);
        expect(download.suggestedFilename().endsWith(extension)).toBe(true);
        const bytes = await readFile(path);
        expect(bytes.length).toBeGreaterThan(300);
        expect(bytes.subarray(0, 8).toString("latin1")).toContain(magic);
    }
    let downloads = 0;
    page.on("download", () => downloads++);
    await page.getByRole("button", { name: "导出完整 JSONL", exact: true }).click();
    await page.getByRole("button", { name: "确认导出", exact: true }).click();
    await expect(page.getByText(/导出连接中断/)).toBeVisible();
    expect(downloads).toBe(0);
    expect(state.errors).toEqual([]);
});
test("paid analysis keeps explicit preview, invalidates scope changes and does not retry failure", async ({ page, context }) => {
    const state = await setup(context);
    await page.goto(base);
    await loaded(page);
    await page.getByRole("button", { name: "加载 / 刷新文字模型" }).click();
    await page.getByLabel("手动分析文字模型").click();
    await page.getByText("隔离文字模型", { exact: true }).click();
    await page.getByRole("button", { name: "预览将发送的汇总", exact: true }).click();
    await expect(page.getByTestId("usage-v2-preview")).toBeVisible();
    expect(state.calls.filter((call) => call.url.pathname.endsWith("/analyze"))).toHaveLength(0);
    await page.getByRole("button", { name: "发送已预览汇总 · 可能付费", exact: true }).click();
    await expect(page.getByText(/本次预览不自动重发|本次操作未完成|使用分析服务暂不可用/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "发送已预览汇总 · 可能付费", exact: true })).toBeDisabled();
    const paid = state.calls.filter((call) => call.url.pathname.endsWith("/analyze"));
    expect(paid).toHaveLength(1);
    expect(paid[0]!.body).toEqual({ previewId: "frozen-id", previewHash: "frozen-hash", modelConfigId: modelId, confirm: true });
    await page.getByLabel("分析开始日期").fill("2026-10-02");
    await expect(page.getByTestId("usage-v2-preview")).toHaveCount(0);
    expect(state.errors).toEqual([]);
});
test("dark and narrow layouts stay usable and a non-superadmin never queries analysis", async ({ page, context }) => {
    const state = await setup(context);
    await page.goto(`${base}&theme=dark&uTab=models`);
    await loaded(page);
    await expect(page.locator("[data-usage-chart] canvas")).toHaveCount(3);
    for (const name of ["模型成本与结果对比", "成本结构", "模型端到端耗时 · 五数分布"]) {
        await expect(page.getByRole("img", { name, exact: true }).locator("canvas")).toBeVisible();
    }
    await page.screenshot({ path: resolve(output, "models-dark.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}&theme=dark&uTab=flows`);
    await loaded(page);
    await expect(page.locator("[data-usage-chart] canvas")).toHaveCount(1);
    await page.screenshot({ path: resolve(output, "flows-narrow.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
    const before = state.calls.length;
    await page.goto(`${base}&role=designer`);
    await expect(page.getByText("仅超级管理员可访问使用分析", { exact: true })).toBeVisible();
    expect(state.calls.length).toBe(before);
    expect(state.errors).toEqual([]);
});

const testJob = (request: { fromDay: string; toDay: string }, status = "queued", completedDays: string[] = []) => ({
    jobId: "00000000-0000-4000-8000-000000000010",
    ...request,
    status,
    completedDays,
    createdAt: "2026-11-04T00:00:00Z",
    updatedAt: "2026-11-04T00:00:01Z",
    completedAt: ["completed", "failed"].includes(status) ? "2026-11-04T00:00:01Z" : null,
    failureCode: status === "failed" ? "RECOMPUTE_FAILED" : null,
});
test("409 recovery explicitly enqueues once, shows real progress and only reloads after completion", async ({ page, context }) => {
    await context.addInitScript(() => Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true }));
    let done = false,
        polls = 0;
    let request: { fromDay: string; toDay: string } = { fromDay: "2026-10-01", toDay: "2026-10-02" };
    const state = await setup(context, async (route, url) => {
        if (url.pathname.endsWith("/overview") && !done) {
            await route.fulfill({ status: 409, json: { code: "USAGE_ROLLUP_REFRESH_REQUIRED", data: null, msg: "refresh" } });
            return true;
        }
        if (url.pathname.endsWith("/recompute")) {
            request = route.request().postDataJSON();
            await route.fulfill({ status: 202, json: { code: 0, data: testJob(request) } });
            return true;
        }
        if (url.pathname.includes("/rollups/jobs/")) {
            polls++;
            done = polls >= 2;
            await route.fulfill({ json: { code: 0, data: testJob(request, done ? "completed" : "running", done ? [request.fromDay, request.toDay] : [request.fromDay]) } });
            return true;
        }
        return false;
    });
    await page.goto(base.replace("uTo=2026-10-07", "uTo=2026-10-02"));
    await expect(page.getByText("当前缺少可用日事实，需先重算", { exact: true })).toBeVisible();
    expect(state.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    await page.getByRole("button", { name: "刷新所选日期", exact: true }).click();
    await expect(page.getByText(/已排队，尚未完成/)).toBeVisible();
    await expect(page.getByText(/真实已提交 1 \/ 2 天/)).toBeVisible();
    await expect(page.getByText(/全部日期重算完成/)).toBeVisible();
    await loaded(page);
    expect(state.calls.filter((call) => call.url.pathname.endsWith("/recompute"))).toHaveLength(1);
    expect(state.calls.find((call) => call.url.pathname.endsWith("/recompute"))!.body.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    await expect(page.getByTestId("usage-snapshot")).toContainText("混合刷新时点，不是统一观察快照");
    await expect(page.getByTestId("usage-snapshot")).toContainText("7,500 秒");
    expect(state.errors).toEqual([]);
});

test("uncertain receipt survives reload, resumes with original key and failed jobs never auto-restart", async ({ page, context }) => {
    let submitted = 0;
    const state = await setup(context, async (route, url) => {
        if (url.pathname.endsWith("/recompute")) {
            submitted++;
            if (submitted === 1) await route.fulfill({ status: 503, json: { code: "UNCERTAIN" } });
            else await route.fulfill({ json: { code: 0, data: testJob(route.request().postDataJSON(), "failed") } });
            return true;
        }
        return false;
    });
    await page.goto(base);
    await loaded(page);
    await page.getByRole("button", { name: "刷新所选日期", exact: true }).click();
    await expect(page.getByRole("button", { name: "找回本次刷新回执", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "刷新今天", exact: true })).toBeDisabled();
    const first = state.calls.find((call) => call.url.pathname.endsWith("/recompute"))!.body;
    await page.reload();
    await loaded(page);
    expect(submitted).toBe(1);
    await page.getByRole("button", { name: "找回本次刷新回执", exact: true }).click();
    await expect(page.getByText(/刷新失败，未自动重新启动/)).toBeVisible();
    const requests = state.calls.filter((call) => call.url.pathname.endsWith("/recompute"));
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body).toEqual(first);
    await expect(page.getByRole("button", { name: "刷新所选日期", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "刷新所选日期", exact: true }).click();
    await expect(page.getByText(/刷新失败，未自动重新启动/)).toBeVisible();
    expect(state.calls.filter((call) => call.url.pathname.endsWith("/recompute")).at(-1)!.body.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(submitted).toBe(3);
    expect(state.errors).toEqual([]);
});

test("polling pause retains the task and long ranges cannot enqueue truncated work", async ({ page, context }) => {
    const state = await setup(context, async (route, url) => {
        if (url.pathname.endsWith("/recompute")) {
            await route.fulfill({ status: 202, json: { code: 0, data: testJob(route.request().postDataJSON()) } });
            return true;
        }
        if (url.pathname.includes("/rollups/jobs/")) {
            await route.fulfill({ json: { code: 0, data: testJob({ fromDay: "2026-10-01", toDay: "2026-10-07" }, "running") } });
            return true;
        }
        return false;
    });
    await page.goto(base);
    await loaded(page);
    await page.getByRole("button", { name: "刷新所选日期", exact: true }).click();
    await expect(page.getByText(/已排队，尚未完成/)).toBeVisible();
    await page.getByRole("button", { name: "暂停本机等待", exact: true }).click();
    await expect(page.getByText(/已暂停本机等待，未取消后台任务/)).toBeVisible();
    await page.getByRole("button", { name: "继续查询同一任务", exact: true }).click();
    await expect(page.getByText(/正在重算，尚未全部完成/)).toBeVisible();
    await page.getByRole("button", { name: "暂停本机等待", exact: true }).click();
    expect(state.calls.filter((call) => call.url.pathname.endsWith("/recompute"))).toHaveLength(1);
    await page.goto(base.replace("uTo=2026-10-07", "uTo=2026-11-01"));
    await loaded(page);
    await expect(page.getByRole("button", { name: "刷新所选日期", exact: true })).toBeDisabled();
    await expect(page.getByText(/一次重算最多 31 天/)).toBeVisible();
    expect(state.errors).toEqual([]);
});

test("cross-page comparison reads selected IDs together, caps at five and invalidates changed filters", async ({ page, context }) => {
    const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-${String(i + 101).padStart(12, "0")}`);
    const names = ["甲", "乙", "丙", "丁", "戊", "己"];
    const state = await setup(context, async (route, url) => {
        if (url.pathname.endsWith("people-compare")) {
            const body = route.request().postDataJSON();
            await route.fulfill({ json: { code: 0, data: peopleComparisonFixture(body.filters, body.selectedUserIds, names.slice(0, 5).map(name => `跨页设计师${name}`)) } });
            return true;
        }
        if (!url.pathname.endsWith("people-v2")) return false;
        const data = fixture(url) as any;
        const all = ids.map((userId, index) => ({ ...data.people[0], userId, displayName: `跨页设计师${names[index]}` }));
        const selected = url.searchParams.get("userIds")?.split(",");
        data.people = selected ? all.filter((person) => selected.includes(person.userId)) : Number(url.searchParams.get("page")) === 2 ? all.slice(3) : all.slice(0, 3);
        data.pagination = { page: Number(url.searchParams.get("page") || 1), pageSize: selected ? 5 : 20, total: selected ? data.people.length : 41 };
        await route.fulfill({ json: { code: 0, data } });
        return true;
    });
    await page.goto(`${base}&uTab=people`);
    await loaded(page);
    for (const name of names.slice(0, 3)) await page.getByLabel(`对比选择 跨页设计师${name}`, { exact: true }).check();
    await page.locator(".ant-pagination-item-2").click();
    await loaded(page);
    for (const name of names.slice(3, 5)) await page.getByLabel(`对比选择 跨页设计师${name}`, { exact: true }).check();
    await expect(page.getByText("跨页已选 5 / 5 人", { exact: true })).toBeVisible();
    await expect(page.getByLabel("对比选择 跨页设计师己", { exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "读取所选人员对比", exact: true }).click();
    await expect(page.getByTestId("usage-people-comparison")).toBeVisible();
    const comparisonCalls = state.calls.filter((call) => call.url.pathname.endsWith("people-compare"));
    expect(comparisonCalls).toHaveLength(1);
    expect(comparisonCalls[0]!.body.selectedUserIds).toEqual(ids.slice(0, 5));
    expect(comparisonCalls[0]!.body.filters.userIds).toBeUndefined();
    await expect(page.getByTestId("usage-people-comparison")).toContainText("混合刷新时点，不是统一观察快照");
    for (const name of names.slice(0, 5)) await expect(page.getByTestId("usage-people-comparison").getByRole("columnheader", { name: `跨页设计师${name}` })).toBeVisible();
    await page.getByLabel("分析开始日期").fill("2026-10-02");
    await expect(page.getByTestId("usage-people-comparison")).toHaveCount(0);
    await expect(page.getByText("跨页已选 0 / 5 人", { exact: true })).toBeVisible();
    expect(state.errors).toEqual([]);
});

test("local polling stops at two minutes without creating another job", async ({ page, context }) => {
    const state = await setup(context, async (route, url) => {
        if (url.pathname.endsWith("/recompute") || url.pathname.includes("/rollups/jobs/")) {
            const request = url.pathname.endsWith("/recompute") ? route.request().postDataJSON() : { fromDay: "2026-10-01", toDay: "2026-10-07" };
            await route.fulfill({ json: { code: 0, data: testJob(request, "running") } });
            return true;
        }
        return false;
    });
    await page.goto(base);
    await loaded(page);
    await page.clock.install();
    await page.getByRole("button", { name: "刷新所选日期", exact: true }).click();
    await expect(page.getByText(/正在重算，尚未全部完成/)).toBeVisible();
    await page.clock.fastForward(121000);
    await expect(page.getByRole("button", { name: "继续查询同一任务", exact: true })).toBeVisible();
    await expect(page.getByText(/本机等待已停止，不能据此判断后台是否完成/)).toBeVisible();
    expect(state.calls.filter((call) => call.url.pathname.endsWith("/recompute"))).toHaveLength(1);
    expect(state.errors).toEqual([]);
});

test("missing secure random support refuses submission with a recoverable explanation", async ({ page, context }) => {
    await context.addInitScript(() => {
        Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
        Object.defineProperty(globalThis.crypto, "getRandomValues", { value: undefined, configurable: true });
    });
    const state = await setup(context);
    await page.goto(base);
    await loaded(page);
    await page.getByRole("button", { name: "刷新所选日期", exact: true }).click();
    await expect(page.getByText(/浏览器缺少安全随机数能力，未提交刷新任务/)).toBeVisible();
    expect(state.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    expect(state.errors).toEqual([]);
});
