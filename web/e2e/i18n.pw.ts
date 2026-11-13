import { test, expect, newCanvas, editText, IMAGE } from "./fixtures";
import { preparePerformanceScene, openPerformanceScene, PROJECT_ID } from "./canvas-performance-fixture";
import type { Page } from "@playwright/test";
import { antSelect, chooseAntSelect } from "./antd-select-helpers";

test.beforeEach(async ({ context, api }) => {
    expect(api.unexpected).toEqual([]);
    // Static labels and original data must still work if the configured model
    // is unavailable. The dynamic test overrides this for exact source strings.
    await context.route("**/api/display-translations", route => route.fulfill({ status: 503, json: { error: "ISOLATED_DISPLAY_UNAVAILABLE" } }));
});

async function changeLanguage(page: Page) { await page.getByTestId("language-switch").filter({ visible: true }).first().click(); }
async function settleTransitions(page: Page) {
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity).length)).toBe(0);
}

test("TruCreate homepage uses the supplied names and slogans in both languages", async ({ page, context, api }, info) => {
    await context.route("**/api/prompt-templates?*", route => route.fulfill({ json: { templates: [], total: 0, page: 1, pageSize: 4 } }));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/");
    await expect(page).toHaveTitle("TruCreate · AI 创意设计平台");
    await expect(page.getByRole("heading", { name: "想法成真", exact: true })).toBeVisible();
    await expect(page.locator(".wb-eyebrow").first()).toHaveText("TruCreate / AI 创意设计平台");
    await expect(page.locator(".inchoice-brand-caption").filter({ visible: true }).first()).toHaveText("AI 创意设计平台");
    await expect(page.getByRole("link", { name: "自由画布", exact: true }).first()).toBeVisible();
    await page.screenshot({ path: info.outputPath("trucreate-home-zh.png") });
    await changeLanguage(page);
    await expect(page).toHaveTitle("TruCreate · Ideas Come True.");
    await expect(page.getByRole("heading", { name: "Ideas Come True.", exact: true })).toBeVisible();
    await expect(page.locator(".inchoice-brand-caption").filter({ visible: true }).first()).toHaveText("Ideas Come True.");
    await expect(page.getByRole("link", { name: "Free canvas", exact: true }).first()).toBeVisible();
    await page.screenshot({ path: info.outputPath("trucreate-home-en.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".inchoice-brand-name").filter({ visible: true }).first()).toHaveText("TruCreate");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("trucreate-home-mobile.png") });
    expect(api.documents.size).toBe(0);
    expect(api.submissions).toHaveLength(0);
});

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
    await expect(page).toHaveTitle("TruCreate · Ideas Come True.");
    await expect(composer).toHaveValue("尚未发送的中文草稿：白底印花 / Inchoice");
    await expect(page.getByRole("button", { name: "Open canvas menu", exact: true })).toBeVisible();
    await expect(page.getByTestId("canvas-agent-generation-actions")).not.toContainText("出图模型");
    await expect(page.locator(".cw-agent-panel").getByText("Y", { exact: true })).toBeVisible();
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
    await expect(page).toHaveTitle("TruCreate · Ideas Come True.");
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

test("English canvas content and draft previews never overwrite source documents or submit a generation", async ({ page, context, api }, info) => {
    await context.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
    const original = "我的针织原稿：保留圆领与花纹", draft = "尚未发送：调整衣身长度";
    const translations: Record<string, string> = { [original]: "My knit original: preserve the round neck and pattern", [draft]: "Unsent: adjust the body length" };
    const requests: string[][] = [];
    await context.route("**/api/display-translations", route => {
        const body = route.request().postDataJSON(); requests.push(body.texts);
        return route.fulfill({ json: { translations: body.texts.map((text: string) => translations[text] || "Fixture display translation") } });
    });
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "文本", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const nodeId = api.document(id)!.nodes[0].id;
    await editText(page, nodeId, original);
    await expect.poll(() => api.document(id)?.nodes[0].metadata.content).toBe(original);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const composer = page.locator(".cw-agent-panel textarea").last();
    await composer.fill(draft);
    const before = structuredClone(api.document(id));
    translations[before.title] = "Original canvas title";
    translations["隔离回归账号"] = "Isolated test account";
    await changeLanguage(page);
    const node = page.locator(`[data-node-id="${nodeId}"]`);
    await expect(node).toContainText(translations[original]);
    await expect(node).toContainText("Text 1");
    expect(requests.flat()).not.toContain("文本1");
    await expect(page.getByTestId("display-translation-preview")).toContainText(translations[draft]);
    await expect(composer).toHaveValue(draft);
    await expect(page.locator(".cw-project-title")).toHaveText("Original canvas title");
    await expect(page.locator(".cw-account-name")).toHaveText("Isolated test account");
    await page.locator(".cw-project-title button").click();
    await expect(page.getByRole("textbox", { name: "Canvas name", exact: true })).toHaveValue(before.title);
    await page.getByRole("textbox", { name: "Canvas name", exact: true }).press("Escape");
    expect(api.document(id)!.nodes).toEqual(before.nodes);
    expect(api.document(id)!.title).toBe(before.title);
    expect(requests.flat()).toContain(original);
    expect(api.submissions).toEqual([]);
    await page.screenshot({ path: info.outputPath("canvas-display-English.png") });
    await changeLanguage(page);
    await expect(node).toContainText(original);
    await expect(page.locator(".cw-project-title")).toHaveText(before.title);
    await expect(page.getByTestId("display-translation-preview")).toHaveCount(0);
    await expect(composer).toHaveValue(draft);
    expect(api.document(id)!.nodes).toEqual(before.nodes);
});

test("image settings keep raw model parameters and the prompt when switching languages", async ({ page, context, api }, info) => {
    await context.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
    await page.goto("/image");
    const prompt = page.locator("textarea").first();
    await expect(prompt).toBeVisible();
    await prompt.fill("我的中文设计要求：保存、透明、1024x1024");
    await page.getByRole("button", { name: "切换生成图片模型", exact: true }).click();
    const settings = page.getByRole("dialog", { name: /^(切换生成图片模型|Switch image generation model)/ });
    const size = settings.locator('[data-usage-control="size"] [role="combobox"]');
    await expect(size).toBeVisible();
    await chooseAntSelect(size, "1:1 · 1024 × 1024");
    // Observe persisted raw parameters: AntD's combobox input stores search text, not the selected value.
    const parameterState = async () => page.evaluate(async () => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        return {
            draft: await createWorkspaceStorage("generation_drafts").getItem<Record<string, unknown>>("image-generation:settings"),
            segments: [...document.querySelectorAll(".image-parameters [data-usage-value][aria-pressed=true]")].map(element => ({
                key: element.getAttribute("data-usage-control"), value: element.getAttribute("data-usage-value"),
            })),
        };
    });
    await expect.poll(parameterState).toMatchObject({ draft: { size: "1024x1024" } });
    const before = await parameterState();
    await page.getByRole("dialog", { name: /^切换生成图片模型/ }).getByRole("button", { name: "关闭模型设置", exact: true }).click();
    await changeLanguage(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.getByRole("button", { name: "Switch image generation model", exact: true }).click();
    await expect(size).toHaveAttribute("aria-label", "Aspect ratio");
    await expect(antSelect(size)).toHaveText("1:1 · 1024 × 1024");
    await expect(prompt).toHaveValue("我的中文设计要求：保存、透明、1024x1024");
    expect(await parameterState()).toEqual(before);
    await expect(page.locator('[data-usage-control="model"]').first()).toContainText("Image model");
    await page.screenshot({ path: info.outputPath("image-settings-English.png") });
    await page.getByRole("dialog", { name: /^Switch image generation model/ }).getByRole("button", { name: "Close model settings", exact: true }).click();
    await changeLanguage(page);
    await page.getByRole("button", { name: "切换生成图片模型", exact: true }).click();
    await expect(prompt).toHaveValue("我的中文设计要求：保存、透明、1024x1024");
    expect(await parameterState()).toEqual(before);
    expect(api.submissions).toHaveLength(0);
});

test("English includes administration and switching preserves unsaved original account input without writes", async ({ page, context, api }, info) => {
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
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByTestId("language-switch").filter({ visible: true }).first()).toBeVisible();
    const name = page.getByPlaceholder(/^(Designer name|设计师姓名)$/);
    const account = page.getByPlaceholder(/^(E.g. name \/ username \/ email \/ employee ID|例如：张三 \/ zhangsan \/ 邮箱 \/ 工号)$/);
    await expect(name).toBeVisible();
    await name.fill("中文设计师（未提交）");
    await account.fill("test-only-not-submitted");
    await expect(name).toHaveValue("中文设计师（未提交）");
    await expect(account).toHaveValue("test-only-not-submitted");
    await expect(name).toHaveAttribute("placeholder", "Designer name");
    await expect(page.locator("main h2")).toHaveText(["Member management", "Models and services", "Content", "Operations"]);
    await page.screenshot({ path: info.outputPath("admin-English.png"), fullPage: true });
    await changeLanguage(page);
    await expect(name).toHaveAttribute("placeholder", "设计师姓名");
    await expect(name).toHaveValue("中文设计师（未提交）");
    await expect(account).toHaveValue("test-only-not-submitted");
    await changeLanguage(page);
    expect(await page.evaluate(() => localStorage.getItem("inchoice.ui-locale"))).toBe("en-US");
    await page.getByRole("link", { name: "Free canvas", exact: true }).first().click();
    await expect(page.getByRole("dialog")).toContainText("Discard unsaved changes");
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByTestId("language-switch").filter({ visible: true }).first()).toBeVisible();
    await page.goto("/admin");
    await expect(name).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByTestId("language-switch").filter({ visible: true }).first()).toBeVisible();
    expect(writes).toEqual([]);
});

for (const tool of ["pattern-placement", "pattern-repeat"]) {
    test(`${tool} switches marked UI and project display without remounting or rewriting project identity`, async ({ page, api }, info) => {
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
        await expect(project.locator("option:checked")).toHaveText("Save");
        expect(await dimensions()).toEqual(before);
        expect(await canvas!.evaluate(element => element.isConnected)).toBe(true);
        await page.screenshot({ path: info.outputPath(`${tool}-English.png`) });
        await changeLanguage(page);
        await expect(project).toHaveAttribute("aria-label", "本地工程");
        await expect(project.locator("option:checked")).toHaveText("保存");
        expect(api.submissions).toHaveLength(0);
    });
}

test("500-node canvas language switching does not rewrite the persisted document", async ({ page, context, api }, info) => {
    await preparePerformanceScene(context, api, new URL(info.project.use.baseURL!).origin);
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
    await expect(page.locator(".inchoice-brand-name").filter({ visible: true }).first()).toHaveText("TruCreate");
    await page.screenshot({ path: info.outputPath("oa-English.png") });
    expect(api.documents.size).toBe(0);
    expect(api.submissions).toHaveLength(0);
});

test("document display stays private while collapsed and translation never changes the original requirement editor", async ({ page, context, api }, info) => {
    const sources: string[] = [];
    const translated: Record<string, string> = {
        "私有款式资料.docx": "Private style document.docx", "未展开的版面警告": "Layout warning from the opened document",
        "未展开的参考图说明": "Reference image from the opened document", "未展开的章节正文绝不外发": "NOT EXPECTED",
        "私有针织需求卡": "Private knit requirements", "保持袖口形状": "Preserve the cuff shape",
    };
    await context.route("**/api/display-translations", route => {
        const texts = route.request().postDataJSON().texts as string[]; sources.push(...texts);
        return route.fulfill({ json: { translations: texts.map(text => translated[text] || "Fixture display") } });
    });
    await page.goto("/chat");
    await expect(page.getByRole("textbox", { name: "对话内容", exact: true })).toBeVisible();
    await page.evaluate(async dataUrl => {
        const { React, createRoot } = await import("/e2e/display-i18n-mount.ts");
        const { AgentDocumentPanel } = await import("/src/pages/chat/agent-document-panel.tsx");
        const documentData = { id: "private-document-id", name: "私有款式资料.docx", kind: "docx", mimeType: "application/octet-stream", bytes: 12,
            sections: [{ id: "section-id", title: "源文件章节", text: "未展开的章节正文绝不外发", figureIds: ["figure-id"] }],
            figures: [{ id: "figure-id", sectionId: "section-id", label: "未展开的参考图说明", name: "original.png", mimeType: "image/png", dataUrl }], warnings: ["未展开的版面警告"] };
        const originalCard = { id: "card-id", status: "confirmed", title: "私有针织需求卡", documentIds: ["private-document-id"], subject: "保持袖口形状", colors: "", materials: "", must: [], avoid: [], unknowns: [], referenceFigureIds: [], sources: [], updatedAt: "2026-11-13T00:00:00Z" };
        (window as any).__i18nDocument = { documentData, card: originalCard, edits: [], reference: null };
        const host = document.createElement("div"); host.dataset.testid = "document-privacy-harness"; document.querySelector("main")?.prepend(host);
        function Harness() {
            const [card, setCard] = React.useState(originalCard);
            return React.createElement(AgentDocumentPanel, { documents: [documentData], card,
                onChange: next => { (window as any).__i18nDocument.edits.push(next); (window as any).__i18nDocument.card = next; setCard(next); },
                onReference: figure => { (window as any).__i18nDocument.reference = figure; } });
        }
        createRoot(host).render(React.createElement(Harness));
    }, `data:image/png;base64,${IMAGE.toString("base64")}`);
    const host = page.getByTestId("document-privacy-harness"), panel = host.getByTestId("agent-document-panel");
    await expect(panel).not.toHaveAttribute("open");
    const before = await page.evaluate(() => JSON.stringify((window as any).__i18nDocument));
    await changeLanguage(page);
    // A visible sibling completes a translation, so this is not a zero-time negative assertion.
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("可见草稿用于等待翻译");
    await expect(page.getByTestId("display-translation-preview").last()).toContainText("Fixture display");
    expect(sources).not.toContain("私有款式资料.docx"); expect(sources).not.toContain("保持袖口形状");
    await panel.locator(":scope > summary").click();
    await expect(host).toContainText("Private knit requirements");
    await expect(host).toContainText("Preserve the cuff shape");
    const nested = panel.locator("details");
    await expect(nested.locator("summary")).toContainText("Private style document.docx");
    expect(sources).not.toContain("未展开的参考图说明"); expect(sources).not.toContain("未展开的版面警告");
    await nested.locator("summary").click();
    await expect(nested).toContainText("Layout warning from the opened document");
    await expect(nested.getByRole("img")).toHaveAttribute("alt", "Reference image from the opened document");
    expect(sources).not.toContain("未展开的章节正文绝不外发");
    expect(await page.evaluate(() => JSON.stringify((window as any).__i18nDocument))).toBe(before);
    await host.getByRole("button", { name: "Edit requirements", exact: true }).click();
    await expect(host.locator("textarea").first()).toHaveValue("保持袖口形状");
    await page.screenshot({ path: info.outputPath("document-English-privacy.png") });
    await changeLanguage(page);
    await expect(host.locator("textarea").first()).toHaveValue("保持袖口形状");
    await expect(host).toContainText("私有针织需求卡");
    expect(await page.evaluate(() => JSON.stringify((window as any).__i18nDocument))).toBe(before);
    expect(api.submissions).toEqual([]);
});

test("sensitive audit originals require explicit translation and preserve protected JSON fields", async ({ page, context, api }) => {
    const sources: string[] = [];
    const translations: Record<string, string> = { "敏感员工原始提示词": "Sensitive employee original prompt", "敏感模型参数提示词": "Sensitive model parameter prompt" };
    await context.route("**/api/display-translations", route => {
        const texts = route.request().postDataJSON().texts as string[]; sources.push(...texts);
        return route.fulfill({ json: { translations: texts.map(text => translations[text] || "Visible fixture") } });
    });
    await context.route("**/api/prompt-templates?*", route => route.fulfill({ json: { templates: [], total: 0, page: 1, pageSize: 4 } }));
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "想法成真", exact: true })).toBeVisible();
    await page.evaluate(async () => {
        const { React, createRoot } = await import("/e2e/display-i18n-mount.ts");
        const { SensitiveDisplayValue, DisplayText } = await import("/src/hooks/use-display-text.tsx");
        const source = { prompt: "敏感模型参数提示词", size: "1024x1024", modelId: "中文模型编号", credentials: { prompt: "凭据不可外发" }, sourceUrl: "/api/assets/中文标识/content" };
        (window as any).__sensitiveSource = source;
        const host = document.createElement("div"); host.dataset.testid = "sensitive-display-harness"; document.querySelector("main")?.prepend(host);
        createRoot(host).render(React.createElement("div", null,
            React.createElement("p", { "data-testid": "visible-sync" }, React.createElement(DisplayText, { text: "可见普通文本作为等待信号" })),
            React.createElement("pre", { "data-testid": "private-text" }, React.createElement(SensitiveDisplayValue, { value: "敏感员工原始提示词" })),
            React.createElement("pre", { "data-testid": "private-json" }, React.createElement(SensitiveDisplayValue, { value: source }))));
    });
    const host = page.getByTestId("sensitive-display-harness"), before = await page.evaluate(() => JSON.stringify((window as any).__sensitiveSource));
    await changeLanguage(page);
    await expect(host.getByTestId("visible-sync")).toHaveText("Visible fixture");
    expect(sources).not.toContain("敏感员工原始提示词"); expect(sources).not.toContain("敏感模型参数提示词");
    await host.getByTestId("private-text").getByRole("button").click();
    await expect(host.getByTestId("private-text")).toHaveText(translations["敏感员工原始提示词"]);
    expect(sources).not.toContain("敏感模型参数提示词");
    await host.getByTestId("private-json").getByRole("button").click();
    await expect(host.getByTestId("private-json")).toContainText(translations["敏感模型参数提示词"]);
    expect(sources).not.toContain("凭据不可外发"); expect(sources).not.toContain("中文模型编号"); expect(sources).not.toContain("/api/assets/中文标识/content");
    expect(await page.evaluate(() => JSON.stringify((window as any).__sensitiveSource))).toBe(before);
    await changeLanguage(page);
    await expect(host.getByTestId("private-text")).toHaveText("敏感员工原始提示词");
    await expect(host.getByTestId("private-json")).toHaveText(JSON.stringify(JSON.parse(before), null, 2));
    expect(api.submissions).toEqual([]);
});

test("generation confirmation translates only its display and confirms the exact original request", async ({ page, context, api }, info) => {
    const sources: string[] = [];
    const text = "这是确认后发送的原始提示词 1024x1024";
    await context.route("**/api/display-translations", route => {
        const texts = route.request().postDataJSON().texts as string[]; sources.push(...texts);
        return route.fulfill({ json: { translations: texts.map(value => value === text ? "Original prompt sent after confirmation 1024x1024" : "Display only") } });
    });
    await page.goto("/image"); await expect(page.locator("textarea").first()).toBeVisible();
    await changeLanguage(page);
    await page.evaluate(async ({ text, dataUrl }) => {
        const { confirmPromptExecution } = await import("/src/stores/use-prompt-execution-preview.ts");
        const { useUserStore } = await import("/src/stores/use-user-store.ts");
        const source = { requestId: "unchanged-request", ownerId: useUserStore.getState().user!.id, prompt: text, modelName: "确认模型", summaryZh: "原始说明", nativeNegativePrompt: "不要改变花纹", references: [{ url: dataUrl, name: "原始参考图", label: "保持款式" }] };
        (window as any).__confirmationFixture = { source, accepted: false };
        void confirmPromptExecution(source, { assertCurrent: () => undefined }).then(() => { (window as any).__confirmationFixture.accepted = true; });
    }, { text, dataUrl: `data:image/png;base64,${IMAGE.toString("base64")}` });
    const dialog = page.getByRole("dialog").filter({ hasText: "English display only. Generation uses the unchanged original text and reference order." });
    await expect(dialog.locator("pre")).toHaveText("Original prompt sent after confirmation 1024x1024");
    expect(sources).toContain(text);
    const before = await page.evaluate(() => JSON.stringify((window as any).__confirmationFixture.source));
    await page.screenshot({ path: info.outputPath("confirmation-English.png") });
    await dialog.locator(".ant-modal-footer .ant-btn-primary").click();
    await expect.poll(() => page.evaluate(() => (window as any).__confirmationFixture.accepted)).toBe(true);
    expect(await page.evaluate(() => JSON.stringify((window as any).__confirmationFixture.source))).toBe(before);
    expect(JSON.parse(before).prompt).toBe(text);
    expect(api.submissions).toEqual([]);
});

test("inline reference chips translate without changing the focused prompt, caret or reference identities", async ({ page, context, api }, info) => {
    const value = "前后原稿 @[node:reference-node] 结尾原稿 @[node:missing-node]";
    const sources: string[] = [];
    await context.route("**/api/display-translations", route => {
        const texts = route.request().postDataJSON().texts as string[]; sources.push(...texts);
        return route.fulfill({ json: { translations: texts.map(text => text === "原始中文引用片段" ? "Original referenced excerpt" : "Reference title") } });
    });
    await page.goto("/canvas"); await expect(page.getByRole("button", { name: "新建画布", exact: true }).first()).toBeVisible();
    // The sidebar button appears before the lazy canvas list finishes mounting.
    await expect(page.locator("main")).toBeVisible();
    await page.evaluate(async value => {
        const { React, createRoot } = await import("/e2e/display-i18n-mount.ts");
        const { CanvasConfigComposer } = await import("/src/components/canvas/canvas-config-composer.tsx");
        const reference = { nodeId: "reference-node", type: "text", title: "原始中文节点标题", text: "原始中文引用片段" };
        const handle = React.createRef();
        (window as any).__referenceFixture = { value, reference, handle, changes: [] };
        const host = document.createElement("div"); host.dataset.testid = "reference-display-harness"; document.querySelector("main")!.prepend(host);
        createRoot(host).render(React.createElement(CanvasConfigComposer, { ref: handle, value, inputs: [reference], onChange: next => { (window as any).__referenceFixture.changes.push(next); } }));
    }, value);
    const host = page.getByTestId("reference-display-harness"), editor = host.getByRole("textbox");
    await expect(editor).toContainText("原始中文引用片段");
    await editor.evaluate(element => {
        (element as HTMLElement).focus(); const range = document.createRange(); range.setStart(element.firstChild!, 2); range.collapse(true);
        getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    });
    await page.evaluate(async () => { const { setUiLocale } = await import("/src/lib/i18n.ts"); await setUiLocale("en-US"); });
    await expect(editor.locator('[data-reference-node-id="reference-node"]')).toContainText("Original referenced excerpt");
    await expect(editor.locator('[data-reference-node-id="missing-node"]')).not.toContainText("已失效引用");
    await expect(editor).toBeFocused();
    expect(await page.evaluate(() => getSelection()!.anchorOffset)).toBe(2);
    expect(await page.evaluate(() => (window as any).__referenceFixture.handle.current.read())).toBe(value);
    expect(await page.evaluate(() => (window as any).__referenceFixture.changes)).toEqual([]);
    expect(sources).not.toContain(value); expect(sources).not.toContain("reference-node");
    await page.screenshot({ path: info.outputPath("reference-chips-English.png") });
    await page.evaluate(async () => { const { setUiLocale } = await import("/src/lib/i18n.ts"); await setUiLocale("zh-CN"); });
    await expect(editor).toContainText("原始中文引用片段");
    await expect(editor).toContainText("已失效引用 ×");
    expect(await page.evaluate(() => (window as any).__referenceFixture.handle.current.read())).toBe(value);
    expect(await page.evaluate(() => (window as any).__referenceFixture.changes)).toEqual([]);
    expect(api.submissions).toEqual([]);
});

test("reference menus and workflow cards show English while selection keeps the original reference and workflow", async ({ page, context, api }, info) => {
    const translations: Record<string, string> = { "原始引用正文": "Original reference content", "原始工作流参考": "Original workflow reference", "中文展示模型": "Displayed model", "原始工作流错误": "Original workflow error" };
    const sources: string[] = [];
    await context.route("**/api/display-translations", route => {
        const texts = route.request().postDataJSON().texts as string[]; sources.push(...texts);
        return route.fulfill({ json: { translations: texts.map(text => translations[text] || "Display fixture") } });
    });
    await page.goto("/canvas"); await expect(page.locator("main")).toBeVisible();
    await page.evaluate(async dataUrl => {
        const { React, createRoot } = await import("/e2e/display-i18n-mount.ts");
        const { default: MentionMenu } = await import("/src/components/canvas/canvas-resource-mention-menu.tsx");
        const { CanvasAgentMediaWorkflowCard } = await import("/src/components/canvas/canvas-agent-media-workflow-card.tsx");
        const { createAgentMediaWorkflow } = await import("/src/lib/canvas/agent-media-workflow.ts");
        const { canvasThemes } = await import("/src/lib/canvas-theme.ts");
        const { useBusinessConfigStore } = await import("/src/stores/use-business-config-store.ts");
        useBusinessConfigStore.setState({ models: [{ id: "opaque-image-model", modelId: "opaque-image-model", name: "中文展示模型", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 }] });
        const reference = { id: "original-reference-id", nodeId: "original-node-id", kind: "text", label: "文本42", title: "原始引用标题", text: "原始引用正文", active: true };
        const workflow = { ...createAgentMediaWorkflow({ intent: "image", prompt: "禁止发送的原始工作流提示词", imageModel: "opaque-image-model", videoModel: "", referenceNodeIds: ["workflow-node"] }), imageStatus: "failed", error: "原始工作流错误" };
        const referenceNodes = [{ id: "workflow-node", type: "image", title: "原始工作流参考", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: dataUrl } }];
        (window as any).__referenceMenuFixture = { reference, workflow, referenceNodes, selected: null };
        const host = document.createElement("div"); host.dataset.testid = "final-reference-harness"; host.style.cssText = "position:fixed;left:230px;top:100px;width:650px;z-index:100;background:var(--background);padding:16px";
        const textarea = document.createElement("textarea"); textarea.value = "原始输入不变"; host.append(textarea);
        const content = document.createElement("div"); host.append(content); document.body.append(host);
        createRoot(content).render(React.createElement(React.Fragment, null,
            React.createElement(MentionMenu, { textarea, references: [reference], activeIndex: 0, theme: canvasThemes.light, onSelect: selected => { (window as any).__referenceMenuFixture.selected = selected; } }),
            React.createElement(CanvasAgentMediaWorkflowCard, { workflow, imageModels: ["opaque-image-model"], videoModels: [], referenceNodes })));
    }, `data:image/png;base64,${IMAGE.toString("base64")}`);
    const host = page.getByTestId("final-reference-harness"), menu = page.locator("[data-canvas-resource-mention-menu]");
    const before = await page.evaluate(() => JSON.stringify((window as any).__referenceMenuFixture));
    await changeLanguage(page);
    await expect(menu).toContainText("Text 42");
    await expect(menu).toContainText("Original reference content");
    await expect(host).toContainText("Original workflow reference");
    await expect(host).toContainText("Displayed model");
    await expect(host.getByRole("alert")).toContainText("Original workflow error");
    expect(sources).not.toContain("文本42"); expect(sources).not.toContain("禁止发送的原始工作流提示词");
    expect(await page.evaluate(() => JSON.stringify((window as any).__referenceMenuFixture))).toBe(before);
    await menu.getByRole("button").click();
    expect(await page.evaluate(() => (window as any).__referenceMenuFixture.selected)).toEqual(JSON.parse(before).reference);
    await page.screenshot({ path: info.outputPath("reference-menu-workflow-English.png") });
    await changeLanguage(page);
    await expect(menu).toContainText("文本42"); await expect(menu).toContainText("原始引用正文");
    await expect(host.getByRole("alert")).toContainText("原始工作流错误");
    expect(await page.evaluate(() => JSON.stringify({ ...(window as any).__referenceMenuFixture, selected: null }))).toBe(before);
    expect(api.submissions).toEqual([]);
});
