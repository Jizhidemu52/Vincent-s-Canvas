import { readFile } from "node:fs/promises";
import { toolDefinitions } from "../../shared/feature-catalog";
import { test, expect, IMAGE, type MockCanvasApi } from "./fixtures";
import type { BrowserContext, Page } from "@playwright/test";

function tool(name: string, args: Record<string, unknown>) {
    return { content: "已整理修改要求。", toolCalls: [{ id: `fixture-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}
async function models(context: BrowserContext) {
    await context.route("**/api/models", route => route.fulfill({ json: {
        models: [
            { id: "fixture-chat", modelId: "gpt-fixture-chat", name: "隔离对话模型", protocol: "openai", capabilities: ["chat"], creditCost: 0, rmbCost: 0 },
            { id: "fixture-image", modelId: "gpt-image-2", name: "隔离图片模型", protocol: "openai", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
        ], prices: [], tools: toolDefinitions.map(item => ({ ...item, enabled: true, modelConfigId: ["gpt-chat", "canvas-chat"].includes(item.toolKey) ? "fixture-chat" : "fixture-image", configurationVersion: 1 })),
    } }));
    await context.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
}
const group = (page: Page, label: string) => page.getByRole("group", { name: `${label} 图片操作`, exact: true });

test("chat image actions select an old version, preserve the original bytes, and reject a wrong model target", async ({ page, context, api }, info) => {
    await models(context);
    let targetLabel = "图1", wrongTarget = false;
    const plannerRequests: any[] = [];
    await context.route("**/api/chat/responses", route => {
        const request = route.request().postDataJSON(); plannerRequests.push(request);
        const profile = request.profileContext;
        const target = profile.imageCatalog.find((image: any) => image.label === targetLabel);
        const actual = wrongTarget ? profile.imageCatalog.find((image: any) => image.label === "图3") : target;
        if (profile.phase !== "after-inspection" && !profile.previewImageIds.includes(actual.image_id)) return route.fulfill({ json: tool("inspect_images", { image_ids: [...new Set([target.image_id, actual.image_id])] }) });
        return route.fulfill({ json: tool("create_image", { action: "edit", target_image_id: actual.image_id, reference_image_ids: [], prompt: "Make the selected garment brighter while retaining its structure.", preserve: ["Keep the garment structure."] }) });
    });
    await page.goto("/chat");
    const composer = page.getByRole("textbox", { name: "对话内容", exact: true });
    await expect(composer).toBeEnabled();
    await page.locator('input[type="file"]').setInputFiles({ name: "original.png", mimeType: "image/png", buffer: IMAGE });
    await expect(page.getByRole("button", { name: "移除 original.png", exact: true })).toBeVisible();
    await composer.fill("把原图稍微提亮，生成图片");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(group(page, "图2")).toBeVisible();
    expect(api.submissions).toHaveLength(1);
    targetLabel = "图2";
    await composer.fill("再提亮一点，生成图片");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(group(page, "图3")).toBeVisible();
    expect(api.submissions).toHaveLength(2);

    const calls = plannerRequests.length;
    await group(page, "图2").getByRole("button", { name: "继续修改", exact: true }).click();
    await expect(page.getByTestId("conversation-image-target")).toContainText("基于：图2");
    expect(plannerRequests).toHaveLength(calls);
    const oldId = plannerRequests.at(-1).profileContext.imageCatalog.find((image: any) => image.label === "图2").image_id;
    await composer.fill("从选中的旧图提亮，生成图片");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(group(page, "图4")).toBeVisible();
    expect(api.submissions).toHaveLength(3);
    expect(api.submissions[2].parameters.inputArchive.references[0].id).toBe(oldId);

    await group(page, "图3").getByRole("button", { name: "回原图重做", exact: true }).click();
    await expect(page.getByTestId("conversation-image-target")).toContainText("图1");
    await page.getByRole("button", { name: "取消编辑目标", exact: true }).click();
    await expect(page.getByTestId("conversation-image-target")).toHaveText("编辑目标：自动判断");
    await composer.fill("保留说明 @图2");
    await expect(page.getByRole("listbox", { name: "选择对话图片" })).toBeVisible();
    await composer.press("Enter");
    await expect(composer).toHaveValue("保留说明 @图2 ");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(page.getByTestId("conversation-image-target")).toContainText("基于：图2");
    expect(api.submissions).toHaveLength(3);
    await group(page, "图3").getByRole("button", { name: "设为参考", exact: true }).click();
    const removeReference = page.getByRole("button", { name: /^移除 / });
    await expect(removeReference).toHaveCount(1); await removeReference.click();

    await group(page, "图2").getByRole("button", { name: "和原图对比", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("与该图片已记录的原图比较");
    await expect(page.getByRole("button", { name: "导出当前对比 PNG", exact: true })).toBeEnabled();
    await page.screenshot({ path: info.outputPath("chat-original-comparison.png"), animations: "disabled" });
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    const downloadEvent = page.waitForEvent("download");
    await group(page, "图1").getByRole("button", { name: "下载", exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toMatch(/\.png$/);
    expect(await readFile((await download.path())!)).toEqual(IMAGE);

    await group(page, "图2").getByRole("button", { name: "继续修改", exact: true }).click();
    wrongTarget = true;
    await composer.fill("仍然修改图2，不要修改图3");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText(/模型未使用你选中的编辑目标/).first()).toBeVisible();
    expect(api.submissions).toHaveLength(3);
    await page.setViewportSize({ width: 390, height: 844 });
    const sidebar = page.locator("aside").getByRole("button", { name: "收起会话", exact: true });
    if (await sidebar.isVisible()) await sidebar.click();
    await group(page, "图4").scrollIntoViewIfNeeded();
    await expect(group(page, "图4").getByRole("button", { name: "继续修改", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("chat-mobile-image-actions.png"), animations: "disabled" });
    await page.reload();
    await expect(group(page, "图4")).toBeVisible();
    await expect(page.getByTestId("conversation-image-target")).toHaveText("编辑目标：自动判断");
    expect(api.submissions).toHaveLength(3);
});

function canvasHistory(api: MockCanvasApi) {
    const now = "2026-10-01T00:00:00.000Z", id = "conversation-actions-canvas";
    const original = { id: "original", type: "image", title: "原款.png", dataUrl: "/api/assets/original/content" };
    const contract = { changes: [{ id: "shape", text: "Draw a square.", source: "Draw a square." }], preserve: [], forbid: [] };
    const results = ["old-result", "latest-result"].map((imageId, index) => ({
        id: `result-message-${index}`, role: "assistant", text: "已生成图片。",
        attachments: [{ id: imageId, name: `版本${index + 1}.png`, url: `/api/assets/${imageId}/content`, mediaType: "image" }],
        detail: { status: "completed", kind: "agent_generation", imageEdit: { intent: index ? "refine_latest" : "new", originalReferences: [original], originalPrompt: "Draw a square.", editPrompt: "Draw a square.", baseReferences: [original], contract } },
    }));
    const document = { id, title: "对话图片交互隔离验收", createdAt: now, updatedAt: now, nodes: [], connections: [], groups: [],
        chatSessions: [{ id: "conversation-history", title: "历史版本", createdAt: now, updatedAt: now, messages: [{ id: "upload-message", role: "user", text: "Draw a square.", references: [original] }, ...results] }],
        activeChatId: "conversation-history", backgroundMode: "dots", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, selectedNodeIds: [], history: { past: [], future: [] } };
    // This saved cloud document is a fixture; no production canvas is touched.
    api.assetBytes.set("original", IMAGE);
    api.documents.set(id, { id, revision: 1, document, deleted: false, updatedAt: now });
    return id;
}

test("canvas image controls lock an older result despite a model requesting a new image", async ({ page, context, api }, info) => {
    await models(context);
    const project = canvasHistory(api);
    const plans: any[] = [];
    await context.route("**/api/chat/responses", route => {
        const request = route.request().postDataJSON(); plans.push(request);
        const profile = request.profileContext;
        if (profile.stage === "continue") return route.fulfill({ json: { content: "已完成。", toolCalls: [] } });
        return route.fulfill({ json: tool("canvas_generate_image", {
            editIntent: "new", prompt: profile.userText,
            editContract: { mode: "update", changes: [{ id: "bright", text: profile.userText, source: profile.userText }], preserve: [], forbid: [], supersedes: [], referenceRoles: profile.references.map(({ id }: { id: string }) => ({ id, role: profile.editContext.selectedTarget.baseImageIds.includes(id) ? "base" : "reference" })) },
        }) });
    });
    await page.goto(`/canvas/${project}`);
    const skip = page.getByRole("button", { name: "跳过引导", exact: true });
    await expect(skip).toBeVisible();
    await skip.click();
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    await expect(group(page, "图2")).toBeVisible();
    await group(page, "图2").getByRole("button", { name: "继续修改", exact: true }).click();
    await expect(page.getByTestId("conversation-image-target")).toContainText("基于：图2");
    expect(plans).toHaveLength(0); expect(api.submissions).toHaveLength(0);
    const composer = page.locator(".cw-agent-panel textarea").last();
    await composer.fill("Make the square brighter.");
    await page.locator(".cw-agent-panel").getByRole("button", { name: "发送", exact: true }).click();
    await page.getByRole("button", { name: "批准执行", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0].operationType).toBe("inpaint");
    expect(api.submissions[0].parameters.inputArchive.references[0].id).toBe("old-result");
    await expect(group(page, "图4")).toBeVisible();
    await group(page, "图3").getByRole("button", { name: "回原图重做", exact: true }).click();
    await expect(page.getByTestId("conversation-image-target")).toContainText("原图");
    await composer.fill("Rework the original square.");
    await page.locator(".cw-agent-panel").getByRole("button", { name: "发送", exact: true }).click();
    await page.getByRole("button", { name: "批准执行", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(2);
    expect(api.submissions[1].parameters.inputArchive.references[0].id).toBe("edit-original-0");
    expect(api.submissions[1].operationType).toBe("inpaint");
    await expect(group(page, "图5")).toBeVisible();
    await page.getByRole("button", { name: "取消编辑目标", exact: true }).click();
    await composer.fill("Compare @图2");
    await expect(page.getByRole("listbox", { name: "选择对话图片" })).toBeVisible();
    await composer.press("Enter");
    await expect(composer).toHaveValue("Compare @图2 ");
    expect(api.submissions).toHaveLength(2);
    await page.screenshot({ path: info.outputPath("canvas-image-actions-light.png"), animations: "disabled" });
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    await page.getByTestId("language-switch").filter({ visible: true }).first().click();
    await expect(page.getByRole("group", { name: "Image 2 image actions", exact: true }).getByRole("button", { name: "Continue editing", exact: true })).toBeVisible();
    await expect(page.getByTestId("conversation-image-target")).toContainText("Based on: Image 2");
    await page.screenshot({ path: info.outputPath("canvas-image-actions-dark-English.png"), animations: "disabled" });
    expect(api.submissions).toHaveLength(2);
});
