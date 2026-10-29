import { test, expect, newCanvas, editText } from "./fixtures";
import { preparePerformanceScene, openPerformanceScene, PROJECT_ID } from "./canvas-performance-fixture";
import type { Page } from "@playwright/test";

async function changeLanguage(page: Page) { await page.getByTestId("language-switch").filter({ visible: true }).first().click(); }
async function settleTransitions(page: Page) {
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity).length)).toBe(0);
}

test("language switching preserves canvas content and an unsent assistant draft", async ({ page, context, api }, info) => {
    await context.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "文本", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const nodeId = api.document(id)!.nodes[0].id;
    await editText(page, nodeId, "我的原始中文作品：保存 / Create / {count}");
    await expect.poll(() => api.document(id)?.nodes[0].metadata.content).toBe("我的原始中文作品：保存 / Create / {count}");
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const composer = page.locator(".cw-agent-panel textarea").last();
    await composer.fill("尚未发送的中文草稿：白底印花 / Inchoice");
    const projectTitle = api.document(id)!.title;
    await page.evaluate(() => { (window as any).__i18nNoReload = "preserved"; });
    await changeLanguage(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByText("Inchoice TruCreate", { exact: true }).first()).toBeVisible();
    await expect(composer).toHaveValue("尚未发送的中文草稿：白底印花 / Inchoice");
    await expect(page.getByRole("button", { name: "Open canvas menu", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__i18nNoReload)).toBe("preserved");
    expect(api.document(id)!.nodes[0].metadata.content).toBe("我的原始中文作品：保存 / Create / {count}");
    expect(api.document(id)!.title).toBe(projectTitle);
    expect(api.submissions).toHaveLength(0);
    await page.screenshot({ path: info.outputPath("canvas-English.png") });
    await page.getByRole("button", { name: "Switch to dark theme", exact: true }).click();
    await expect(page.getByRole("button", { name: "Switch to light theme", exact: true })).toBeVisible();
    await settleTransitions(page);
    await page.screenshot({ path: info.outputPath("canvas-English-dark.png"), animations: "disabled" });
    await page.getByRole("button", { name: "Switch to light theme", exact: true }).click();
    await changeLanguage(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(composer).toHaveValue("尚未发送的中文草稿：白底印花 / Inchoice");
    await changeLanguage(page);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page).toHaveTitle("Inchoice TruCreate");
    await expect(page.locator(`[data-node-id="${nodeId}"]`)).toContainText("我的原始中文作品");
});

test("English navigation and mobile drawer remain operable", async ({ page, api }, info) => {
    await page.goto("/canvas");
    await expect(page.getByRole("button", { name: "新建画布", exact: true }).first()).toBeEnabled();
    await changeLanguage(page);
    await expect(page.getByRole("link", { name: "Creative design", exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Asset library", exact: true }).first()).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByTestId("language-switch")).toBeEnabled();
    await expect(page.getByRole("dialog").getByRole("link", { name: "Asset library", exact: true })).toBeInViewport();
    await settleTransitions(page);
    await page.screenshot({ path: info.outputPath("mobile-English.png"), animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByRole("dialog").getByTestId("language-switch").click();
    await expect(page.getByRole("dialog")).toContainText("功能模块");
    expect(api.submissions).toHaveLength(0);
});

test("image settings keep raw model parameters and the prompt when switching languages", async ({ page, context, api }, info) => {
    await context.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
    await page.goto("/image");
    const prompt = page.locator("textarea").first();
    await expect(prompt).toBeVisible();
    await prompt.fill("我的中文设计要求：保存、透明、1024x1024");
    const size = page.locator('select[data-usage-control="size"]').filter({ visible: true }).first();
    await expect(size).toBeVisible();
    await size.selectOption("1024x1024");
    const parameterState = async () => page.locator("select[data-usage-control], [data-usage-value][aria-pressed=true]").evaluateAll(elements => elements.map(element => ({
        key: element.getAttribute("data-usage-control"), value: element instanceof HTMLSelectElement ? element.value : element.getAttribute("data-usage-value"),
    })));
    const before = await parameterState();
    await changeLanguage(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(size).toHaveAttribute("aria-label", "Aspect ratio");
    await expect(prompt).toHaveValue("我的中文设计要求：保存、透明、1024x1024");
    expect(await parameterState()).toEqual(before);
    await expect(page.locator('[data-usage-control="model"]').first()).toContainText("出图模型");
    await page.screenshot({ path: info.outputPath("image-settings-English.png") });
    await changeLanguage(page);
    await expect(prompt).toHaveValue("我的中文设计要求：保存、透明、1024x1024");
    expect(await parameterState()).toEqual(before);
    expect(api.submissions).toHaveLength(0);
});

test("employee English preference does not translate admin pages or expose an admin language switch", async ({ page, context, api }, info) => {
    api.role = "super_admin";
    const writes: string[] = [];
    const replies: Record<string, unknown> = {
        "/api/admin/accounts": { users: [{ id: "designer-fixture", username: "designer", displayName: "保存", role: "designer", status: "active", creditBalance: 100, monthlyCreditLimit: 100 }], totalUsedCredits: 0 },
        "/api/admin/departments": { departments: [] },
        "/api/admin/audit-logs": { auditLogs: [] },
        "/api/admin/history": { history: [], totalRmbCost: 0, nextCursor: null },
        "/api/admin/credit-policy": { creditsEnabled: false, updatedAt: null },
        "/api/auth/methods": { password: true, wecom: false },
    };
    await context.route("**/api/**", route => {
        const path = new URL(route.request().url()).pathname;
        if (!Object.hasOwn(replies, path)) return route.fallback();
        if (route.request().method() !== "GET") writes.push(path);
        return route.fulfill({ json: replies[path] });
    });
    await page.goto("/canvas");
    await changeLanguage(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.getByRole("link", { name: "Administration", exact: true }).first().click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(page.getByTestId("language-switch")).toHaveCount(0);
    const name = page.getByPlaceholder("设计师姓名", { exact: true });
    const account = page.getByPlaceholder("例如：张三 / zhangsan / 邮箱 / 工号", { exact: true });
    await expect(name).toBeVisible();
    await name.fill("中文设计师（未提交）");
    await account.fill("test-only-not-submitted");
    await expect(name).toHaveValue("中文设计师（未提交）");
    await expect(account).toHaveValue("test-only-not-submitted");
    await expect(page.getByText("保存", { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: info.outputPath("admin-Chinese.png"), fullPage: true });
    expect(await page.evaluate(() => localStorage.getItem("inchoice.ui-locale"))).toBe("en-US");
    await page.getByRole("link", { name: "无线画布", exact: true }).first().click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByTestId("language-switch").filter({ visible: true }).first()).toBeVisible();
    await page.goto("/admin");
    await expect(name).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(page.getByTestId("language-switch")).toHaveCount(0);
    expect(writes).toEqual([]);
});

for (const tool of ["pattern-placement", "pattern-repeat"]) {
    test(`${tool} switches marked UI without remounting the editor or translating project names`, async ({ page, api }, info) => {
        await page.goto(`/creative/${tool}`);
        const host = page.locator(".local-workbench-host");
        await expect(host.locator("canvas").first()).toBeVisible();
        const canvas = await host.locator("canvas").first().elementHandle();
        page.once("dialog", dialog => dialog.accept("保存"));
        await host.locator("[data-project-rename]").click();
        const project = host.locator("select[data-ui-aria-label='本地工程']");
        await expect(project.locator("option:checked")).toHaveText("保存");
        const dimensions = () => host.locator("input[type=number], select").evaluateAll(elements => elements.map(element => (element as HTMLInputElement | HTMLSelectElement).value));
        const before = await dimensions();
        await changeLanguage(page);
        await expect(page.locator("html")).toHaveAttribute("lang", "en");
        await expect(project).toHaveAttribute("aria-label", "Local project");
        await expect(project.locator("option:checked")).toHaveText("保存");
        expect(await dimensions()).toEqual(before);
        expect(await canvas!.evaluate(element => element.isConnected)).toBe(true);
        await page.screenshot({ path: info.outputPath(`${tool}-English.png`) });
        await changeLanguage(page);
        await expect(project).toHaveAttribute("aria-label", "本地工程");
        await expect(project.locator("option:checked")).toHaveText("保存");
        expect(api.submissions).toHaveLength(0);
    });
}

test("500-node canvas language switching does not rewrite the persisted document", async ({ page, context, api }) => {
    await preparePerformanceScene(context, api, "http://127.0.0.1:5199");
    const before = structuredClone(api.document(PROJECT_ID));
    await openPerformanceScene(page);
    await changeLanguage(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.getByRole("button", { name: "Open canvas menu", exact: true }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await changeLanguage(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    expect(api.document(PROJECT_ID)!.nodes).toEqual(before.nodes);
    expect(api.document(PROJECT_ID)!.title).toBe(before.title);
    expect(api.submissions).toHaveLength(0);
});

test("OA entry can switch languages without authenticating or opening an employee workspace", async ({ page, context, api }, info) => {
    await context.route("**/api/deployment", route => route.fulfill({ json: { authenticationEnabled: true, oaLoginEnabled: true, creditsEnabled: false, rolePortalsEnabled: false } }));
    await context.route("**/api/auth/session", route => route.fulfill({ status: 401, json: { error: "UNAUTHORIZED" } }));
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "请从公司 OA 重新进入" })).toBeVisible();
    await changeLanguage(page);
    await expect(page.getByRole("heading", { name: "Open again from the company OA portal" })).toBeVisible();
    await expect(page.getByText("Inchoice TruCreate", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("oa-English.png") });
    expect(api.documents.size).toBe(0);
    expect(api.submissions).toHaveLength(0);
});
