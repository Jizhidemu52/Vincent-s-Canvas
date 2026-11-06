import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, newCanvas } from "./fixtures";
import { generalPromptTemplates } from "../../shared/general-prompt-templates";
import type { PromptScope, PromptTemplate } from "../src/services/api/prompts";

const owner = "00000000-0000-4000-8000-000000000099";
const template = (index: number, scope: PromptScope = "personal"): PromptTemplate => ({
    id: `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`, scope, ownerUserId: scope === "personal" ? owner : null,
    groupId: null, departmentId: null, currentVersionId: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`, version: 1,
    title: `${scope} 提示词 ${index}`, prompt: `保留结构和材质，第 ${index} 个可复用提示词。`, targetTool: "image-generation", modelConfigId: null,
    modelSnapshot: {}, parameters: {}, referenceAssetIds: [], category: "", tags: [], notes: "", sourceTaskId: null, sourceAssetId: null,
    favorite: false, useCount: 0, lastUsedAt: null, createdAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:00:00Z",
});

async function library(context: BrowserContext, initial: PromptTemplate[] = []) {
    const state = { items: [...initial], posts: [] as Record<string, unknown>[], reads: [] as string[], resolves: [] as string[], fail: false };
    await context.route("**/api/prompt-templates**", async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() === "POST" && url.pathname === "/api/prompt-templates") {
            const input = request.postDataJSON(); state.posts.push(input);
            const item = { ...template(1000 + state.posts.length), ...input, scope: "personal", ownerUserId: owner } as PromptTemplate;
            state.items.unshift(item);
            return route.fulfill({ status: 201, json: { template: { id: item.id, currentVersionId: item.currentVersionId } } });
        }
        if (request.method() === "GET" && url.pathname === "/api/prompt-templates") {
            state.reads.push(url.search);
            if (state.fail) return route.fulfill({ status: 503, json: { message: "隔离测试：共享库暂时不可用" } });
            const scope = url.searchParams.get("scope"), query = url.searchParams.get("query") || "", page = Number(url.searchParams.get("page") || 1), pageSize = Number(url.searchParams.get("pageSize") || 20);
            const items = state.items.filter(item => item.scope === scope && (!query || `${item.title} ${item.prompt}`.includes(query)));
            return route.fulfill({ json: { templates: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize } });
        }
        state.resolves.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({ status: 400, json: { message: "本测试不应请求完整模板或公开发布" } });
    });
    return state;
}

async function openLibrary(page: Page) {
    await page.getByRole("button", { name: /^(查看)?提示词库$/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "提示词库", exact: true });
    await expect(dialog).toBeVisible(); return dialog;
}

async function modelName(page: Page) {
    await page.getByRole("button", { name: "切换生成图片模型", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: /^切换生成图片模型/ });
    const name = await dialog.locator('[data-usage-control="model"][role="combobox"]').innerText();
    await dialog.getByRole("button", { name: "关闭模型设置", exact: true }).click(); return name;
}

test("module picker shows the independent catalog even during a shared API outage; text reuse preserves the image model", async ({ page, context, api }, info) => {
    const state = await library(context); state.fail = true;
    await page.goto("/image");
    const selected = await modelName(page);
    const dialog = await openLibrary(page);
    await expect(dialog.locator('[data-prompt-library-scope="general"]')).toHaveCount(generalPromptTemplates.length);
    await expect(dialog.getByText("个人或共享提示词暂时加载失败，通用提示词仍可使用", { exact: true })).toBeVisible();
    const item = generalPromptTemplates[0];
    const card = dialog.locator(`[data-prompt-library-id="general:${item.id}"]`);
    await expect(card.getByRole("button", { name: "套用完整模板" })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("unified-prompt-library.png"), fullPage: true, animations: "disabled" });
    await card.getByRole("button", { name: "使用此提示词", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue(item.prompt);
    expect(await modelName(page)).toBe(selected);
    expect(state.resolves).toEqual([]); expect(state.posts).toEqual([]);
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("new private prompts appear immediately, reopening refreshes newer additions, and reuse never changes the selected model", async ({ page, context, api }) => {
    const state = await library(context, [template(1, "team"), template(2, "public")]);
    await page.goto("/image");
    const selected = await modelName(page);
    let dialog = await openLibrary(page);
    await expect(dialog.locator('[data-prompt-library-scope="team"]')).toHaveCount(1);
    await expect(dialog.locator('[data-prompt-library-scope="public"]')).toHaveCount(1);
    await dialog.getByRole("button", { name: "新增个人提示词", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "新增个人提示词", exact: true });
    await editor.getByLabel("模板名称", { exact: true }).fill("我的可复用服装提示词");
    await editor.getByLabel("完整提示词", { exact: true }).fill("保留针织结构，只改指定部位为蓝色。");
    await editor.getByRole("button", { name: "保存模板", exact: true }).click();
    await expect(editor).toBeHidden();
    await expect(dialog.getByRole("heading", { name: "我的可复用服装提示词", exact: true })).toBeVisible();
    expect(state.posts).toHaveLength(1);
    for (const field of ["scope", "ownerUserId", "groupId", "departmentId"]) expect(state.posts[0]).not.toHaveProperty(field);
    const current = state.items[0];
    await dialog.locator(`[data-prompt-library-id="${current.id}"]`).getByRole("button", { name: "使用此提示词", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue(current.prompt);
    expect(await modelName(page)).toBe(selected);
    const newer = { ...template(1002), title: "另一个页面刚保存的提示词" }; state.items.unshift(newer);
    dialog = await openLibrary(page);
    await expect(dialog.getByRole("heading", { name: newer.title, exact: true })).toBeVisible();
    expect(state.resolves).toEqual([]);
    expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]);
});

test("private library paginates beyond 100 without exposing other scopes", async ({ page, context, api }) => {
    const state = await library(context, [...Array.from({ length: 121 }, (_, index) => template(index + 1)), template(900, "team")]);
    await page.goto("/image"); const dialog = await openLibrary(page);
    await dialog.getByRole("combobox", { name: "提示词来源", exact: true }).click();
    await page.getByRole("option", { name: "我的提示词", exact: true }).click();
    await expect(dialog.locator('[data-prompt-library-scope="general"]')).toHaveCount(0);
    await expect(dialog.locator('[data-prompt-library-scope="team"]')).toHaveCount(0);
    const personalCards = dialog.locator('[data-prompt-library-scope="personal"]');
    await expect(personalCards).toHaveCount(20);
    for (let index = 0; index < 6 && await personalCards.count() < 121; index++) {
        const count = await personalCards.count();
        await dialog.locator(".thin-scrollbar").evaluate(element => element.scrollTo(0, element.scrollHeight));
        await expect.poll(() => personalCards.count()).toBeGreaterThan(count);
    }
    await expect(personalCards).toHaveCount(121);
    expect(new Set(await personalCards.evaluateAll(elements => elements.map(element => element.getAttribute("data-prompt-library-id")))).size).toBe(121);
    await expect(dialog.getByRole("heading", { name: "personal 提示词 121", exact: true })).toBeVisible();
    expect(state.reads.some(value => value.includes("page=7"))).toBe(true);
    expect(api.submissions).toEqual([]);
});

test("canvas generic prompt selection uses text insertion, not complete-template resolution", async ({ page, context, api }) => {
    const state = await library(context); const id = await newCanvas(page);
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "图片节点", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const before = structuredClone(api.document(id)!.nodes[0]);
    const dialog = await openLibrary(page), item = generalPromptTemplates[0];
    await dialog.locator(`[data-prompt-library-id="general:${item.id}"]`).getByRole("button", { name: "使用此提示词", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes[0].metadata.draftPrompt).toBe(item.prompt);
    expect(api.document(id)?.nodes[0].metadata.model).toBe(before.metadata.model);
    expect(state.resolves).toEqual([]); expect(api.submissions).toEqual([]);
});

test("another employee signing in in a different tab immediately hides cached private prompts", async ({ page, context, api }) => {
    const state = await library(context, [template(1)]);
    await page.goto("/image"); const dialog = await openLibrary(page);
    await expect(dialog.locator('[data-prompt-library-scope="personal"]')).toHaveCount(1);
    await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", {
        key: "wireless-canvas:workspace-session",
        newValue: JSON.stringify({ type: "identity-changed", ownerId: "00000000-0000-4000-8000-000000000098", nonce: "prompt-library-isolation-check" }),
    })));
    await expect(page.locator('[data-prompt-library-scope="personal"]')).toHaveCount(0);
    expect(state.posts).toEqual([]); expect(state.resolves).toEqual([]); expect(api.submissions).toEqual([]);
});
