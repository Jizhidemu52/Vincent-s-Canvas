import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { moduleDefinitions } from "../../shared/feature-catalog";

const employeeA = "71000000-0000-4000-8000-000000000001", employeeB = "71000000-0000-4000-8000-000000000002";
function template(index: number, scope: string, favorite: boolean, ownerId = employeeA) {
    const label = scope === "personal" ? ownerId === employeeA ? "个人" : "新账号" : scope === "team" ? "团队" : "公共";
    return { id: `${ownerId}-${scope}-${index}`, scope, ownerUserId: ownerId, groupId: "group-a", departmentId: "department-a", currentVersionId: `version-${index}`, version: 1,
        title: `${label}模板 ${String(index).padStart(2, "0")}`, prompt: `完整提示词 ${index}`, targetTool: "image-generation", modelConfigId: null, modelSnapshot: {}, parameters: {}, referenceAssetIds: [], category: "服装", tags: ["原有标签"], notes: "",
        sourceTaskId: null, sourceAssetId: null, favorite, useCount: index, lastUsedAt: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" };
}

async function fixture(context: BrowserContext, baseURL: string, count = 25, favorites = false) {
    let owner = employeeA, failNext = false, returnNext: boolean | undefined;
    let gate: Promise<void> | undefined, release: (() => void) | undefined;
    const rows = [employeeA, employeeB].flatMap(employee => ["personal", "team", "public"].flatMap(scope => Array.from({ length: count }, (_, index) => template(index + 1, scope, favorites, employee))));
    const lists: URL[] = [], writes: Array<{ id: string; favorite: boolean; owner: string }> = [], unexpected: string[] = [], pageErrors: string[] = [];
    let reviews = 0;
    context.on("page", page => page.on("pageerror", error => pageErrors.push(error.message)));
    for (const page of context.pages()) page.on("pageerror", error => pageErrors.push(error.message));
    await context.routeWebSocket("**/*", socket => socket.close());
    await context.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname;
        const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
        if (url.origin !== baseURL) { unexpected.push(request.url()); return route.abort(); }
        if (!path.startsWith("/api/")) return route.continue();
        if (path === "/api/deployment") return json({ authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false });
        if (path === "/api/auth/session") return json({ user: { id: owner, displayName: owner === employeeA ? "收藏验证员工" : "新账号员工", username: owner, role: "designer", groupId: "group-a", groupRole: "leader", departmentId: "department-a", status: "active", mustChangePassword: false } });
        if (path === "/api/modules") return json({ modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: true })) });
        if (path === "/api/models") return json({ models: [], tools: [], prices: [] });
        if (path === "/api/canvas-documents") return json({ documents: [] });
        if (path === "/api/projects") return json({ projects: [] });
        if (path === "/api/usage/events") return json({ code: 0, data: [] });
        if (path === "/api/prompt-templates/review/submissions") { reviews++; return json({ submissions: [] }); }
        if (path === "/api/prompt-templates" && request.method() === "GET") {
            lists.push(url);
            const page = Number(url.searchParams.get("page")), pageSize = Number(url.searchParams.get("pageSize"));
            const filtered = rows.filter(item => item.ownerUserId === owner && item.scope === url.searchParams.get("scope")
                && (!url.searchParams.get("favorite") || item.favorite === (url.searchParams.get("favorite") === "true"))
                && (!url.searchParams.get("query") || item.title.includes(url.searchParams.get("query")!)));
            return json({ templates: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize });
        }
        const match = path.match(/^\/api\/prompt-templates\/([^/]+)\/favorite$/);
        if (match && request.method() === "PUT") {
            const input = request.postDataJSON(), actionOwner = owner;
            const favorite = returnNext ?? input.favorite; returnNext = undefined;
            const fail = failNext; failNext = false;
            writes.push({ id: match[1], favorite: input.favorite, owner: actionOwner });
            if (gate) await gate;
            if (fail) return json({ message: "收藏服务暂不可用" }, 503);
            const row = rows.find(item => item.id === match[1] && item.ownerUserId === actionOwner);
            if (!row) return json({ message: "not found" }, 404);
            row.favorite = favorite; return json({ favorite });
        }
        unexpected.push(`${request.method()} ${path}`); return json({ message: "Unmocked test request" }, 501);
    });
    return { lists, writes, unexpected, pageErrors, reviews: () => reviews, fail: () => { failNext = true; }, returnFavorite: (value: boolean) => { returnNext = value; },
        switchOwner: () => { owner = employeeB; }, hold: () => { gate = new Promise<void>(resolve => { release = resolve; }); }, release: () => { release?.(); gate = undefined; } };
}
const titleButton = (page: Page, title: string) => page.getByRole("button", { name: `查看完整提示词：${title}`, exact: true });
const card = (page: Page, title: string) => page.locator("article").filter({ has: titleButton(page, title) });
async function loaded(page: Page) { await expect(page.locator('section[aria-busy="false"]')).toBeVisible(); }

test("shared favorites use the API value without refetching templates or the review queue", async ({ page, context, baseURL }, info) => {
    const f = await fixture(context, baseURL!, 3);
    await page.goto("/prompts"); await loaded(page);
    await page.getByText("团队提示词", { exact: true }).click(); await loaded(page);
    const target = card(page, "团队模板 01"), requests = f.lists.length, reviews = f.reviews();
    f.returnFavorite(false);
    await target.getByRole("button", { name: "收藏", exact: true }).click();
    await expect.poll(() => f.writes.length).toBe(1);
    await expect(target.getByRole("button", { name: "收藏", exact: true })).toBeEnabled();
    expect(f.lists).toHaveLength(requests); expect(f.reviews()).toBe(reviews);
    await target.getByRole("button", { name: "收藏", exact: true }).click({ clickCount: 2 });
    await expect(target.getByRole("button", { name: "取消收藏", exact: true })).toBeEnabled();
    expect(f.writes).toHaveLength(2); expect(f.lists).toHaveLength(requests); expect(f.reviews()).toBe(reviews);
    await page.screenshot({ path: info.outputPath("shared-local-favorite.png"), fullPage: true });
    expect(f.unexpected).toEqual([]); expect(f.pageErrors).toEqual([]);
});

test("personal favorite failure remains retryable and a changed search waits for the pending write", async ({ page, context, baseURL }) => {
    const f = await fixture(context, baseURL!, 3);
    await page.goto("/my-prompts"); await loaded(page);
    const target = card(page, "个人模板 01"), requests = f.lists.length;
    f.fail(); await target.getByRole("button", { name: "收藏", exact: true }).click();
    await expect(page.getByText("收藏服务暂不可用", { exact: true })).toBeVisible();
    await expect(target.getByRole("button", { name: "收藏", exact: true })).toBeEnabled();
    expect(f.lists).toHaveLength(requests);
    f.hold(); await target.getByRole("button", { name: "收藏", exact: true }).click();
    await expect.poll(() => f.writes.length).toBe(2);
    await expect(target.getByRole("button", { name: "收藏", exact: true })).toBeDisabled();
    await page.getByPlaceholder("搜索名称、提示词或分类").fill("03");
    await expect(page.locator('section[aria-busy="true"]')).toBeVisible();
    expect(f.lists).toHaveLength(requests);
    f.release(); await loaded(page);
    await expect(titleButton(page, "个人模板 03")).toBeVisible();
    await expect(page.locator("article")).toHaveCount(1);
    expect(f.lists).toHaveLength(requests + 1); expect(f.lists.at(-1)?.searchParams.get("query")).toBe("03");
    expect(f.unexpected).toEqual([]); expect(f.pageErrors).toEqual([]);
});

test("favorites-only replaces the missing row with a one-item read, preserving filters and total", async ({ page, context, baseURL }, info) => {
    const f = await fixture(context, baseURL!, 25, true);
    await page.goto("/my-prompts"); await loaded(page);
    await page.getByRole("switch").click();
    await expect.poll(() => f.lists.at(-1)?.searchParams.get("favorite")).toBe("true"); await loaded(page);
    const requests = f.lists.length;
    await card(page, "个人模板 01").getByRole("button", { name: "取消收藏", exact: true }).click();
    await expect(titleButton(page, "个人模板 01")).not.toBeVisible();
    await expect(titleButton(page, "个人模板 25")).toBeVisible();
    await expect(page.locator("article")).toHaveCount(24); await expect(page.getByText("共 24 个模板", { exact: true })).toBeVisible();
    expect(f.lists).toHaveLength(requests + 1);
    expect(Object.fromEntries(f.lists.at(-1)!.searchParams)).toEqual({ scope: "personal", page: "24", pageSize: "1", favorite: "true", sort: "updated" });
    await page.screenshot({ path: info.outputPath("favorite-filter-backfill.png"), fullPage: true });
    expect(f.unexpected).toEqual([]); expect(f.pageErrors).toEqual([]);
});

test("removing the last favorite on the last page navigates to the valid page", async ({ page, context, baseURL }) => {
    const f = await fixture(context, baseURL!, 25, true);
    await page.goto("/my-prompts"); await loaded(page);
    await page.getByRole("switch").click();
    await expect.poll(() => f.lists.at(-1)?.searchParams.get("favorite")).toBe("true"); await loaded(page);
    await page.locator('.ant-pagination-item[title="2"]').click();
    await expect(page.locator("article")).toHaveCount(1); await loaded(page);
    const requests = f.lists.length;
    await card(page, "个人模板 25").getByRole("button", { name: "取消收藏", exact: true }).click();
    await expect(page.locator("article")).toHaveCount(24); await loaded(page);
    expect(f.lists).toHaveLength(requests + 1);
    expect(f.lists.at(-1)?.searchParams.get("page")).toBe("1"); expect(f.lists.at(-1)?.searchParams.get("pageSize")).toBe("24");
    await expect(page.getByText("共 24 个模板", { exact: true })).toBeVisible();
    expect(f.unexpected).toEqual([]); expect(f.pageErrors).toEqual([]);
});

test("a late previous-account failure never updates or alerts the new account", async ({ page, context, baseURL }) => {
    const f = await fixture(context, baseURL!, 3);
    await page.goto("/my-prompts"); await loaded(page);
    f.hold(); f.fail(); await card(page, "个人模板 01").getByRole("button", { name: "收藏", exact: true }).click();
    await expect.poll(() => f.writes.length).toBe(1);
    f.switchOwner();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(titleButton(page, "新账号模板 01")).toBeVisible(); await loaded(page);
    f.release();
    await expect(card(page, "新账号模板 01").getByRole("button", { name: "收藏", exact: true })).toBeEnabled();
    await expect(page.getByText("收藏服务暂不可用", { exact: true })).not.toBeVisible();
    expect(f.writes).toHaveLength(1); expect(f.writes[0].owner).toBe(employeeA);
    expect(f.unexpected).toEqual([]); expect(f.pageErrors).toEqual([]);
});
