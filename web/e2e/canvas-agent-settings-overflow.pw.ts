import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

const profiles = [
    { name: "default", modelId: "gpt-image-2", label: "GPT Image 2", profile: "standard-flex", alternative: "gpt-image-2-copy" },
    { name: "flare26", modelId: "10000000-0000-4000-8000-000000000026", label: "aplmart-gpt2.6-flare", profile: "quality-resolution-v2", alternative: "10000000-0000-4000-8000-000000000027" },
] as const;

async function inViewport(page: Page, target: Locator) {
    const box = (await target.boundingBox())!;
    expect(box).not.toBeNull();
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    return box;
}

for (const profile of profiles) for (const viewport of [{ width: 1280, height: 720 }, { width: 1280, height: 540 }, { width: 390, height: 720 }]) {
    test(`canvas image settings ${profile.name} remain reachable at ${viewport.width}x${viewport.height}`, async ({ page, context, api }, info) => {
        await page.setViewportSize(viewport);
        const posts: string[] = [];
        page.on("request", request => {
            if (request.method() === "POST" && /\/api\/(?:chat\/responses|prompt-compilations|tasks)(?:[/?]|$)/u.test(request.url())) posts.push(request.url());
        });
        const images = [profile.modelId, profile.alternative].map((modelId, index) => ({
            id: modelId, modelId, name: index ? "备用图片模型" : profile.label, publicName: index ? "备用图片模型" : profile.label,
            imageParameterProfile: profile.profile, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0, isFeatured: true,
        }));
        await context.route("**/api/models", route => route.fulfill({ json: { models: [
            { id: "fixture-chat", modelId: "gpt-fixture-chat", name: "隔离对话模型", protocol: "openai", capabilities: ["chat", "vision"], creditCost: 0, rmbCost: 0 }, ...images,
        ], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: ["gpt-chat", "canvas-chat"].includes(tool.toolKey) ? "fixture-chat" : null, configurationVersion: 1 })) } }));
        await context.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
        const id = "settings-overflow-canvas", now = "2026-10-01T00:00:00.000Z";
        api.documents.set(id, { id, revision: 1, deleted: false, updatedAt: now, document: {
            id, title: "设置弹层隔离验收", createdAt: now, updatedAt: now, nodes: [], connections: [], groups: [],
            chatSessions: [{ id: "settings-chat", title: "设置验收", createdAt: now, updatedAt: now, messages: [] }], activeChatId: "settings-chat",
            backgroundMode: "dots", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, selectedNodeIds: [], history: { past: [], future: [] },
        } });
        await page.goto(`/canvas/${id}`);
        await page.getByRole("button", { name: "跟我走一遍", exact: true }).click();
        await page.getByRole("button", { name: "跳过引导", exact: true }).click();
        await page.getByRole("tab", { name: "对话", exact: true }).first().click();
        const panel = page.locator(".cw-agent-panel");
        const composer = panel.locator("textarea").last();
        const draft = "保留这段未发送的图案需求，不调用模型。";
        await composer.fill(draft);
        const opener = panel.getByRole("button", { name: "图像设置", exact: true });
        await opener.click();
        const settings = page.getByTestId("canvas-agent-generation-model").locator("..");
        const picker = settings.getByRole("combobox", { name: "选择模型", exact: true });
        await expect(picker).toBeEnabled();
        await expect(page.locator(".ant-popover:visible")).not.toHaveClass(/ant-zoom-big-(?:appear|enter)/);
        const opening = { settings: await settings.boundingBox(), picker: await picker.boundingBox() };
        await info.attach("opening-bounds", { body: JSON.stringify({ profile: profile.name, viewport, ...opening }), contentType: "application/json" });
        await page.screenshot({ path: info.outputPath("settings-open.png"), animations: "disabled" });
        await inViewport(page, settings);
        await inViewport(page, picker);
        await picker.click();
        const menu = page.getByTestId("canvas-model-picker-menu");
        await expect(menu).toBeVisible();
        await inViewport(page, menu);
        await page.screenshot({ path: info.outputPath("nested-model-picker.png"), animations: "disabled" });
        await menu.locator(`[role="option"][data-usage-value="${profile.alternative}"]`).first().click();
        await expect(picker).toContainText("备用图片模型");
        await settings.getByRole("combobox", { name: "宽高比", exact: true }).click();
        await page.locator(`.ant-select-dropdown:visible .ant-select-item-option[title="${profile.name === "flare26" ? "16:9" : "3:2 · 1536 × 1024"}"]`).click();
        await settings.locator("summary", { hasText: "全部高级参数" }).click();
        await settings.getByRole("combobox", { name: "输出格式", exact: true }).click();
        await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="WebP"]').click();
        const local = settings.getByRole("button", { name: "本机", exact: true });
        await local.scrollIntoViewIfNeeded();
        await info.attach("expanded-bounds", { body: JSON.stringify(await settings.evaluate(element => ({ bounds: element.getBoundingClientRect().toJSON(), scrollTop: element.scrollTop, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, overflowY: getComputedStyle(element).overflowY, maxHeight: getComputedStyle(element).maxHeight, pageScrollY: scrollY }))), contentType: "application/json" });
        await inViewport(page, settings);
        await inViewport(page, local);
        await expect(settings.getByRole("button", { name: "网站", exact: true })).toBeVisible();
        await page.screenshot({ path: info.outputPath("settings-bottom.png"), animations: "disabled" });
        await opener.press("Enter");
        await expect(settings).not.toBeVisible();
        await expect(composer).toHaveValue(draft);
        await opener.click();
        await expect(picker).toContainText("备用图片模型");
        await expect(settings.getByRole("combobox", { name: "宽高比", exact: true }).locator("xpath=ancestor::div[contains(@class,'ant-select')][1]")).toContainText(profile.name === "flare26" ? "16:9" : "3:2 · 1536 × 1024");
        await expect(settings.getByRole("combobox", { name: "输出格式", exact: true }).locator("xpath=ancestor::div[contains(@class,'ant-select')][1]")).toContainText("WebP");
        expect(posts).toEqual([]);
        expect(api.submissions).toHaveLength(0);
        expect(api.batchSubmissions).toHaveLength(0);
    });
}
