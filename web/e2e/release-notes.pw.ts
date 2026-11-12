import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserContext, Locator, Page, Route } from "@playwright/test";
import { test, expect, newCanvas } from "./fixtures";
import type { AdminReleaseNote } from "../../shared/release-notes";

const version = `v${readFileSync(resolve(import.meta.dirname, "../../VERSION"), "utf8").trim().replace(/^v/, "")}`;
const content = "画布交互与生成体验已改善。\n\n保留已有作品和历史记录。\n<b>这段是纯文本，不是 HTML</b>";
const published = (value = version): AdminReleaseNote => ({ version: value, title: "画布体验更新与版本公告", content, revision: 1, createdAt: "2026-11-03T12:00:00.000Z", updatedAt: "2026-11-03T12:00:00.000Z", publishedAt: "2026-11-03T12:00:00.000Z" });
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });

async function openReleaseNotes(page: Page, navigation: Page | Locator = page) {
    await navigation.getByRole("button", { name: "帮助与使用说明", exact: true }).click();
    // The help menu is a portal, including when opened from the mobile drawer.
    await page.getByRole("button", { name: "版本更新", exact: true }).click();
}

async function releaseFixture(context: BrowserContext) {
    const state = { notes: [] as AdminReleaseNote[], reads: 0, saves: 0, publishes: 0, publicFailure: 0, holdPublic: false, held: [] as Route[] };
    const publicBody = () => ({ notes: state.notes.filter(note => note.publishedAt).map(({ version, title, content, publishedAt }) => ({ version, title, content, publishedAt })), hasMore: false });
    await context.route("**/api/auth/methods", route => json(route, { password: true, wecom: false, wecomLoginUrl: null }));
    await context.route("**/api/prompt-templates?*", route => json(route, { templates: [], total: 0, hasMore: false }));
    await context.route("**/api/admin/**", route => {
        const path = new URL(route.request().url()).pathname, method = route.request().method();
        if (path === "/api/admin/accounts") return json(route, { users: [], totalUsedCredits: 0 });
        if (path === "/api/admin/departments") return json(route, { departments: [] });
        if (path === "/api/admin/audit-logs") return json(route, { auditLogs: [] });
        if (path === "/api/admin/credit-policy") return json(route, { creditsEnabled: false, updatedAt: null });
        if (/history/.test(path)) return json(route, { history: [], total: 0, totalRmbCost: 0 });
        if (path === "/api/admin/release-notes" && method === "GET") return json(route, { notes: state.notes, hasMore: false });
        const match = path.match(/^\/api\/admin\/release-notes\/([^/]+)\/(draft|publish)$/);
        if (!match) return route.fallback();
        const target = decodeURIComponent(match[1]), current = state.notes.find(note => note.version === target), body = route.request().postDataJSON();
        if (match[2] === "draft" && method === "PUT") {
            state.saves++;
            if ((current?.revision ?? null) !== body.expectedRevision || current?.publishedAt) return json(route, { error: "RELEASE_NOTE_CONFLICT", message: "内容版本冲突" }, 409);
            const note: AdminReleaseNote = { version: target, title: body.title.trim(), content: body.content.trim(), revision: (current?.revision || 0) + 1, createdAt: current?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), publishedAt: null };
            state.notes = [note, ...state.notes.filter(item => item.version !== target)]; return json(route, { note });
        }
        if (match[2] === "publish" && method === "POST") {
            state.publishes++;
            if (!current || current.revision !== body.expectedRevision) return json(route, { error: "RELEASE_NOTE_CONFLICT", message: "内容版本冲突" }, 409);
            current.publishedAt ||= new Date().toISOString(); return json(route, { note: current });
        }
        return route.fallback();
    });
    await context.route("**/api/release-notes?*", route => {
        state.reads++;
        if (state.holdPublic) { state.held.push(route); return; }
        if (state.publicFailure) return json(route, { message: "临时不可用" }, state.publicFailure);
        return json(route, publicBody());
    });
    return { state, publicBody };
}

test("draft stays private; publish is explicit; ordinary users read plain text in light, dark and narrow views", async ({ page, context, api }, info) => {
    const { state } = await releaseFixture(context); api.role = "super_admin";
    await page.goto("/admin?tab=release-notes");
    const panel = page.getByTestId("admin-release-notes");
    await expect(panel.getByRole("textbox", { name: "当前版本", exact: true })).toHaveValue(version);
    await expect(panel.getByRole("textbox", { name: "当前版本", exact: true })).toHaveAttribute("readonly", "");
    await expect(panel.getByLabel("更新标题", { exact: true })).toHaveValue("");
    await panel.getByLabel("更新标题", { exact: true }).fill("画布体验更新与版本公告");
    await panel.getByLabel("更新内容", { exact: true }).fill(content);
    await expect(panel.getByRole("button", { name: "发布给所有使用者", exact: true })).toBeDisabled();
    await panel.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(panel.getByRole("button", { name: "发布给所有使用者", exact: true })).toBeEnabled();
    expect(state.notes[0]?.publishedAt).toBeNull(); expect(state.saves).toBe(1);
    await page.goto("/"); await expect(page.getByTestId("home-release-note")).toHaveCount(0);
    await page.goto("/admin?tab=release-notes");
    await expect(panel.getByLabel("更新内容", { exact: true })).toHaveValue(content);
    await page.screenshot({ path: info.outputPath("admin-draft-light.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("admin-draft-mobile-light.png"), fullPage: true });
    await page.getByRole("button", { name: "打开导航菜单", exact: true }).click();
    const menu = page.getByRole("dialog", { name: "功能模块", exact: true });
    await menu.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-magicui-theme-vt", "active");
    await menu.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(menu).toBeHidden();
    await page.screenshot({ path: info.outputPath("admin-draft-mobile-dark.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "切换到浅色主题", exact: true }).first().click();
    await expect(page.locator("html")).not.toHaveAttribute("data-magicui-theme-vt", "active");
    await panel.getByRole("button", { name: "发布给所有使用者", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("已发布内容不能再修改");
    await page.getByRole("button", { name: "确认发布", exact: true }).click();
    await expect(panel.getByText("已发布 · 只读", { exact: true })).toBeVisible(); expect(state.publishes).toBe(1);
    await expect(panel.getByLabel("更新标题", { exact: true })).toHaveCount(0);
    api.role = "designer"; await page.goto("/");
    await expect(page.getByTestId("home-release-note")).toContainText("画布体验更新与版本公告");
    await page.screenshot({ path: info.outputPath("home-light.png"), fullPage: true });
    await page.getByTestId("home-release-note").getByRole("button", { name: "查看详情", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "版本更新", exact: true }); await expect(drawer.getByTestId("release-note-content")).toHaveText(content);
    await expect(drawer.locator("b")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("details-light.png"), fullPage: true });
    await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).first().click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator("html")).not.toHaveAttribute("data-magicui-theme-vt", "active");
    await page.screenshot({ path: info.outputPath("home-dark.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "打开导航菜单", exact: true }).click();
    await openReleaseNotes(page, page.getByRole("dialog", { name: "功能模块", exact: true }));
    await expect(page.getByRole("dialog", { name: "功能模块", exact: true })).toBeHidden();
    await expect(page.getByTestId("release-note-content")).toHaveText(content);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("details-mobile-dark.png"), fullPage: true });
    await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "打开导航菜单", exact: true }).click();
    await page.getByRole("dialog", { name: "功能模块", exact: true }).getByRole("button", { name: "切换到浅色主题", exact: true }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-magicui-theme-vt", "active");
    await openReleaseNotes(page, page.getByRole("dialog", { name: "功能模块", exact: true }));
    await expect(page.getByRole("dialog", { name: "功能模块", exact: true })).toBeHidden();
    await page.screenshot({ path: info.outputPath("details-mobile-light.png"), fullPage: true });
    expect(api.submissions).toHaveLength(0);
});

test("conflict preserves typed draft, dirty navigation asks, and refresh never overwrites silently", async ({ page, context, api }, info) => {
    const { state } = await releaseFixture(context); api.role = "super_admin";
    state.notes = [{ ...published(), publishedAt: null }];
    await page.goto("/admin?tab=release-notes"); const panel = page.getByTestId("admin-release-notes");
    await panel.getByLabel("更新标题", { exact: true }).fill("本机尚未保存的标题");
    await page.getByRole("navigation", { name: "管理板块", exact: true }).getByRole("link", { name: "账号管理", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("版本更新草稿尚未保存");
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    state.notes[0].revision = 2; state.notes[0].title = "另一位管理员已保存";
    await panel.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("你的文字已保留");
    await expect(panel.getByLabel("更新标题", { exact: true })).toHaveValue("本机尚未保存的标题");
    await expect(panel.getByRole("button", { name: "保存草稿", exact: true })).toBeDisabled();
    await panel.getByRole("button", { name: "刷新列表", exact: true }).click();
    await page.getByRole("button", { name: "保留当前文字", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(panel.getByLabel("更新标题", { exact: true })).toHaveValue("本机尚未保存的标题");
    await page.screenshot({ path: info.outputPath("admin-conflict-preserves-draft.png"), fullPage: true });
    await panel.getByRole("button", { name: "刷新列表", exact: true }).click();
    await page.getByRole("button", { name: "读取最新版本", exact: true }).click();
    await expect(panel.getByLabel("更新标题", { exact: true })).toHaveValue("另一位管理员已保存");
});

test("department administrator and designer cannot see the publishing panel", async ({ page, context, api }) => {
    await releaseFixture(context); api.role = "department_admin";
    await page.goto("/admin?tab=release-notes");
    await expect(page.getByRole("heading", { name: "管理中心", exact: true })).toBeVisible();
    await expect(page.getByTestId("admin-release-notes")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "管理板块", exact: true }).getByRole("link", { name: "版本更新", exact: true })).toHaveCount(0);
    api.role = "designer"; await page.reload();
    await expect(page.getByRole("heading", { name: "进入后台管理", exact: true })).toBeVisible();
    await expect(page.getByTestId("admin-release-notes")).toHaveCount(0);
});

test("empty publication list has no home banner; explicit details can show empty or transient failure", async ({ page, context, api }, info) => {
    const { state } = await releaseFixture(context);
    await page.goto("/"); await expect(page.getByRole("heading", { name: "想法成真", exact: true })).toBeVisible();
    await expect.poll(() => state.reads).toBe(1); await expect(page.getByTestId("home-release-note")).toHaveCount(0);
    await openReleaseNotes(page);
    await expect(page.getByRole("dialog")).toContainText("暂时没有已发布的版本更新");
    await page.screenshot({ path: info.outputPath("empty-state.png"), fullPage: true });
    await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    state.publicFailure = 503; await page.reload();
    await expect(page.getByRole("heading", { name: "想法成真", exact: true })).toBeVisible();
    await openReleaseNotes(page);
    await expect(page.getByRole("dialog")).toContainText("不影响继续创作");
    expect(api.submissions).toHaveLength(0);
});

test("new publication reaches an already-open canvas once without navigation, reload or automatic drawer", async ({ page, context, api }, info) => {
    const { state } = await releaseFixture(context); await page.clock.install();
    await newCanvas(page); const canvasUrl = page.url();
    await expect.poll(() => state.reads).toBe(1);
    state.notes = [published()];
    await page.clock.fastForward(61_000); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("status").filter({ hasText: `版本更新 · ${version}` })).toBeVisible();
    await page.clock.runFor(500);
    await expect(page.getByRole("dialog")).toHaveCount(0); expect(page.url()).toBe(canvasUrl);
    await expect(page.getByRole("button", { name: "上传素材", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("canvas-nonblocking-notice.png"), fullPage: true });
    await page.clock.fastForward(130_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("status").filter({ hasText: `版本更新 · ${version}` })).toHaveCount(0);
    expect(page.url()).toBe(canvasUrl); expect(api.submissions).toHaveLength(0);
});

test("trial deployment makes no release-note request and does not advertise publishing", async ({ page, context, api }) => {
    const { state } = await releaseFixture(context);
    await context.route("**/api/deployment", route => json(route, { authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false }));
    await page.goto("/"); await expect(page.getByRole("heading", { name: "想法成真", exact: true })).toBeVisible();
    expect(state.reads).toBe(0); await expect(page.getByRole("button", { name: "版本更新", exact: true })).toHaveCount(0);
    expect(api.submissions).toHaveLength(0);
});

test("an old employee response cannot reappear after explicit sign-out", async ({ page, context, api }) => {
    const { state, publicBody } = await releaseFixture(context); state.notes = [published()]; state.holdPublic = true;
    await context.route("**/api/auth/logout", route => route.fulfill({ status: 204 }));
    await page.goto("/"); await expect.poll(() => state.held.length).toBe(1);
    await page.getByRole("button", { name: "帮助与使用说明", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "画布已同步" })).toBeVisible();
    await page.getByRole("button", { name: "帮助与使用说明", exact: true }).click();
    await page.getByRole("button", { name: "个人账号", exact: true }).click();
    await page.getByRole("button", { name: "退出登录", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "登录状态已变化，工作区已暂停", exact: true })).toBeVisible();
    state.holdPublic = false;
    for (const held of state.held.splice(0)) await json(held, publicBody()).catch(() => undefined);
    await expect(page.getByTestId("home-release-note")).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: `版本更新 · ${version}` })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "版本更新", exact: true })).toHaveCount(0);
    expect(api.submissions).toHaveLength(0);
});
