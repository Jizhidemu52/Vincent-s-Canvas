import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { generalPromptTemplates, type GeneralPromptTemplate } from "../../shared/general-prompt-templates";
import english from "../src/lib/i18n/en-general-prompts";
import type { PromptSubmission, PromptTemplate } from "../src/services/api/prompts";

const englishItem = (item: GeneralPromptTemplate) => ({
    ...item, title: english[item.title], prompt: english[item.prompt], notes: english[item.notes],
    category: english[item.category], tags: item.tags.map(tag => english[tag]),
    sources: item.sources.map(source => ({ ...source, title: english[source.title] })),
});
async function switchLanguage(page: Page, language: "en" | "zh-CN") {
    await page.getByTestId("language-switch").filter({ visible: true }).first().click();
    await expect(page.locator("html")).toHaveAttribute("lang", language);
}

test.beforeEach(async ({ context, api }) => {
    expect(api.unexpected).toEqual([]);
    // Built-in prompt variants must work even when display translation of
    // unrelated examples/user data is unavailable. The dynamic test overrides
    // this with exact translations for its own known source records.
    await context.route("**/api/display-translations", route => route.fulfill({
        status: 503, json: { message: "Display translation is unavailable in this static-only fixture" },
    }));
});

test("all English built-ins show complete details, copy/save the displayed variant, and preserve exact Chinese on return", async ({ page, context, api }, info) => {
    const saved: Record<string, unknown>[] = [];
    await context.route("**/api/prompt-templates**", async route => {
        if (route.request().method() === "POST") {
            saved.push(route.request().postDataJSON());
            return route.fulfill({ json: { template: { id: "isolated-English-copy", currentVersionId: "isolated-version" } } });
        }
        return route.fulfill({ status: 503, json: { message: "Isolated shared-library outage" } });
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/prompts");
    await expect(page.locator("[data-general-prompt-id]")).toHaveCount(24);
    await switchLanguage(page, "en");
    const catalog = page.getByRole("region", { name: "General prompts", exact: true });
    await expect(catalog).toBeVisible();
    expect(await catalog.innerText()).not.toMatch(/\p{Script=Han}/u);
    for (const source of generalPromptTemplates) {
        const item = englishItem(source);
        const card = page.locator(`[data-general-prompt-id="${item.id}"]`);
        await expect(card).toContainText(item.title);
        await card.getByRole("button", { name: `View the full prompt: ${item.title}`, exact: true }).click();
        const drawer = page.getByRole("dialog", { name: item.title, exact: true });
        await expect(drawer.getByText(item.prompt, { exact: true })).toBeVisible();
        await expect(drawer.getByText(item.notes, { exact: true })).toBeVisible();
        expect(await drawer.innerText()).not.toMatch(/\p{Script=Han}/u);
        for (const reference of item.sources) await expect(drawer.getByRole("link", { name: reference.title, exact: true })).toHaveAttribute("href", reference.url);
        if (source === generalPromptTemplates[0]) {
            await drawer.getByRole("button", { name: "Copy prompt", exact: true }).click();
            await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n"))).toBe(item.prompt);
            await drawer.getByRole("button", { name: "Save to my prompts", exact: true }).click();
            await expect(drawer.getByRole("button", { name: "Saved to my prompts", exact: true })).toBeDisabled();
            expect(saved).toEqual([{
                title: item.title, prompt: item.prompt, targetTool: item.targetTool, category: item.category, tags: item.tags,
                parameters: {}, referenceAssetIds: [], notes: `${item.notes}\n\nSources:\n${item.sources.map(reference => `${reference.title}: ${reference.url}`).join("\n")}`,
            }]);
            await page.setViewportSize({ width: 390, height: 844 });
            expect(await drawer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
            await page.screenshot({ path: info.outputPath("general-English-mobile-detail.png"), animations: "disabled" });
            await page.setViewportSize({ width: 1366, height: 900 });
        }
        await drawer.getByRole("button", { name: "Close", exact: true }).click();
    }
    await page.getByPlaceholder("Search title, full prompt or category").fill("knitted jacquard");
    await expect(page.locator("[data-general-prompt-id]")).toHaveCount(1);
    await expect(page.locator("[data-general-prompt-id]")).toHaveAttribute("data-general-prompt-id", "jacquard-effect");
    await page.getByPlaceholder("Search title, full prompt or category").fill("");
    await switchLanguage(page, "zh-CN");
    for (const source of generalPromptTemplates) await expect(page.locator(`[data-general-prompt-id="${source.id}"]`)).toContainText(source.title);
    const first = generalPromptTemplates[0];
    await page.getByRole("button", { name: `查看完整提示词：${first.title}`, exact: true }).click();
    const drawer = page.getByRole("dialog", { name: first.title, exact: true });
    await expect(drawer.getByText(first.prompt, { exact: true })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "存到我的提示词", exact: true })).toBeEnabled();
    expect(saved).toHaveLength(1);
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("each English built-in target fills the same English prompt without generating", async ({ page, context, api }) => {
    await context.route("**/api/prompt-templates?*", route => route.fulfill({ json: { templates: [], total: 0, page: 1, pageSize: 24 } }));
    await page.goto("/prompts");
    await switchLanguage(page, "en");
    for (const target of ["image-generation", "image-edit", "video"] as const) {
        const item = englishItem(generalPromptTemplates.find(value => value.targetTool === target)!);
        await page.goto("/prompts");
        await page.locator(`[data-general-prompt-id="${item.id}"]`).getByRole("button", { name: /^Use in / }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe(target === "video" ? "/video" : "/image");
        const prompt = page.locator("textarea").filter({ visible: true }).first();
        await expect(prompt).toHaveValue(item.prompt);
        expect(new URL(page.url()).searchParams.get("tool")).toBe(target === "image-edit" ? "image-edit" : null);
        await expect.poll(() => new URL(page.url()).searchParams.has("prompt")).toBe(false);
    }
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("picker updates when language changes and never overwrites the current draft until a template is chosen", async ({ page, context, api }, info) => {
    const writes: string[] = [];
    await context.route("**/api/prompt-templates**", route => {
        if (route.request().method() !== "GET") writes.push(route.request().method());
        return route.fulfill({ json: { templates: [], total: 0, page: 1, pageSize: 20 } });
    });
    await page.goto("/image");
    const draft = page.locator("textarea").filter({ visible: true }).first();
    const original = "我的中文原文与未发送草稿：[颜色] #1";
    await draft.fill(original);
    await switchLanguage(page, "en");
    await expect(draft).toHaveValue(original);
    await page.getByRole("button", { name: /^(Open )?[Pp]rompt library$/, exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Prompt library", exact: true });
    await expect(dialog.locator('[data-prompt-library-scope="general"]')).toHaveCount(24);
    const first = generalPromptTemplates[0], translated = englishItem(first);
    const card = dialog.locator(`[data-prompt-library-id="general:${first.id}"]`);
    await expect(card).toContainText(translated.title);
    expect(await dialog.innerText()).not.toMatch(/\p{Script=Han}/u);
    // Use the same language control through the DOM while the modal is open:
    // its backdrop prevents pointer access, but its real click handler is retained.
    await page.getByTestId("language-switch").filter({ visible: true }).first().dispatchEvent("click");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(page.locator(`[data-prompt-library-id="general:${first.id}"]`)).toContainText(first.title);
    await expect(draft).toHaveValue(original);
    await page.getByTestId("language-switch").filter({ visible: true }).first().dispatchEvent("click");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(card).toContainText(translated.title);
    await page.screenshot({ path: info.outputPath("general-English-picker.png"), animations: "disabled" });
    await card.getByRole("button", { name: "Use this prompt", exact: true }).click();
    // Existing draft protection still applies after choosing a translated template.
    await expect(page.getByRole("button", { name: "Replace draft", exact: true })).toBeVisible();
    await expect(draft).toHaveValue(original);
    await page.getByRole("button", { name: "Replace draft", exact: true }).click();
    await expect(draft).toHaveValue(translated.prompt);
    await switchLanguage(page, "zh-CN");
    await expect(draft).toHaveValue(translated.prompt);
    expect(writes).toEqual([]);
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("dynamic prompt filters and review text translate only their display while all action values stay original", async ({ page, context, api }) => {
    api.role = "super_admin";
    const template: PromptTemplate = {
        id: "30000000-0000-4000-8000-000000001001", scope: "personal", ownerUserId: "00000000-0000-4000-8000-000000000099",
        groupId: null, departmentId: null, currentVersionId: "40000000-0000-4000-8000-000000001001", version: 1,
        title: "用户中文模板", prompt: "原文要求：保留提花纹理，不新增纽扣。", targetTool: "image-generation", modelConfigId: null,
        modelSnapshot: {}, parameters: {}, referenceAssetIds: [], category: "用户自定分类", tags: ["用户自定标签"], notes: "原版中文说明",
        sourceTaskId: null, sourceAssetId: null, favorite: false, useCount: 0, lastUsedAt: null,
        createdAt: "2026-11-13T00:00:00Z", updatedAt: "2026-11-13T00:00:00Z",
    };
    const submission: PromptSubmission = {
        id: "review-display-original", status: "pending", reviewNote: "", createdAt: "2026-11-13T00:00:00Z", reviewedAt: null,
        sourceTemplateId: template.id, sourceVersionId: template.currentVersionId, targetGroupId: "group-display",
        submitterName: "张设计师", title: "待审核中文模板", prompt: "保留原稿，只改袖口。",
    };
    const translations: Record<string, string> = {
        [template.title]: "User template", [template.prompt]: "Original request: preserve the jacquard texture without adding buttons.",
        [template.category]: "User category", [template.tags[0]]: "User tag", [template.notes]: "Original usage notes",
        [submission.title]: "Template awaiting review", [submission.submitterName]: "Designer Zhang", [submission.prompt]: "Preserve the original and change only the cuff.",
    };
    const sourceBefore = JSON.stringify({ template, submission });
    const translatedSources: string[] = [], reads: string[] = [], writes: Array<{ path: string; body: unknown }> = [];
    let reviewed = false;
    await context.route("**/api/display-translations", route => {
        const request = route.request().postDataJSON() as { target: string; texts: string[] };
        expect(request.target).toBe("en-US");
        translatedSources.push(...request.texts);
        return route.fulfill({ json: { translations: request.texts.map(text => translations[text] ?? "English display") } });
    });
    await context.route("**/api/prompt-templates**", route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== "GET") {
            writes.push({ path: url.pathname, body: request.postDataJSON() }); reviewed = true;
            return route.fulfill({ json: { submission: { ...submission, status: "rejected" } } });
        }
        if (url.pathname === "/api/prompt-templates/review/submissions") return route.fulfill({ json: { submissions: reviewed ? [] : [submission] } });
        reads.push(url.search);
        const items = url.searchParams.get("scope") === "personal" ? [template] : [];
        return route.fulfill({ json: { templates: items, total: items.length, page: 1, pageSize: 24 } });
    });
    await page.goto("/image");
    await switchLanguage(page, "en");
    await page.getByRole("button", { name: /^(Open )?[Pp]rompt library$/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "Prompt library", exact: true });
    await expect(dialog.getByText("User category", { exact: true })).toBeVisible();
    await dialog.getByText("User category", { exact: true }).click();
    await expect.poll(() => reads.some(search => new URLSearchParams(search).get("category") === template.category)).toBe(true);
    await dialog.locator(".prompt-filter-tag").filter({ hasText: /^User tag$/ }).click();
    await expect.poll(() => reads.some(search => new URLSearchParams(search).get("tag") === template.tags[0])).toBe(true);
    await dialog.locator(`[data-prompt-library-id="${template.id}"]`).getByRole("button", { name: "Use this prompt", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Image prompt", exact: true })).toHaveValue(template.prompt);
    expect(writes).toEqual([]);

    // A separate page preserves the unsent image draft while reviewing the list.
    const reviewPage = await context.newPage();
    await reviewPage.goto("/prompts");
    await reviewPage.getByText("Team prompts", { exact: true }).click();
    await expect(reviewPage.getByRole("heading", { name: "Template awaiting review", exact: true })).toBeVisible();
    await expect(reviewPage.getByText("Submitted by:Designer Zhang", { exact: true })).toBeVisible();
    await expect(reviewPage.getByText(translations[submission.prompt], { exact: true })).toBeVisible();
    await switchLanguage(reviewPage, "zh-CN");
    await expect(reviewPage.getByRole("heading", { name: submission.title, exact: true })).toBeVisible();
    await expect(reviewPage.getByText(submission.prompt, { exact: true })).toBeVisible();
    await expect(reviewPage.getByText(`提交人：${submission.submitterName}`, { exact: true })).toBeVisible();
    await switchLanguage(reviewPage, "en");
    await reviewPage.getByRole("button", { name: "Reject", exact: true }).click();
    const originalNote = "我的原始审核意见：袖口保持原版。";
    await reviewPage.getByPlaceholder("Enter revision suggestions", { exact: true }).fill(originalNote);
    await expect(reviewPage.getByPlaceholder("Enter revision suggestions", { exact: true })).toHaveValue(originalNote);
    await reviewPage.getByRole("button", { name: "Confirm rejection", exact: true }).click();
    await expect.poll(() => writes).toEqual([{ path: `/api/prompt-templates/review/submissions/${submission.id}`, body: { decision: "reject", note: originalNote } }]);
    expect(JSON.stringify({ template, submission })).toBe(sourceBefore);
    for (const source of [template.category, template.tags[0], submission.title, submission.submitterName, submission.prompt]) expect(translatedSources).toContain(source);
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});
