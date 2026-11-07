import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { toolDefinitions } from "../../shared/feature-catalog";
import { test, expect, IMAGE, type MockCanvasApi } from "./fixtures";
import type { BrowserContext, Locator, Page, Route } from "@playwright/test";

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
async function imageMenu(page: Page, controls: Locator, action: string) {
    await controls.locator("..").locator("..").hover();
    await controls.getByRole("button", { name: "更多图片操作", exact: true }).click();
    await page.getByRole("menuitem", { name: action, exact: true }).click();
}
async function savedChat(page: Page) {
    return page.evaluate(async () => {
        const { chatSessionStorage } = await import("/src/pages/chat/chat-session-storage.ts");
        const { useUserStore } = await import("/src/stores/use-user-store.ts");
        return (await chatSessionStorage.load(`wireless-canvas:llm-chat:${useUserStore.getState().user!.id}`, () => null))[0];
    });
}

async function inspectOriginal(page: Page, card: Locator, expected: Buffer, screenshotPath?: string) {
    await card.getByRole("button", { name: /^查看大图 · / }).click();
    const preview = page.getByRole("dialog");
    await expect(preview.getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
    const picture = preview.locator("img").first();
    await expect(picture).toBeVisible();
    // The 256px fixture must finish the preview entrance animation first.
    await expect.poll(async () => Math.round((await picture.boundingBox())!.width)).toBe(256);
    const initialBox = (await picture.boundingBox())!;
    await preview.getByRole("button", { name: "放大大图", exact: true }).click();
    await expect.poll(async () => (await picture.boundingBox())!.width).toBeGreaterThan(initialBox.width);
    await preview.getByRole("button", { name: "缩小大图", exact: true }).click();
    await expect.poll(async () => Math.abs((await picture.boundingBox())!.width - initialBox.width)).toBeLessThan(1);
    for (let index = 0; index < 5; index++) await preview.getByRole("button", { name: "放大大图", exact: true }).click();
    await expect.poll(async () => (await picture.boundingBox())!.width).toBeGreaterThan(1800);
    const beforeDrag = (await picture.boundingBox())!;
    await page.mouse.move(900, 500); await page.mouse.down(); await page.mouse.move(1030, 560, { steps: 8 });
    await expect.poll(async () => (await picture.boundingBox())!.x).not.toBe(beforeDrag.x);
    await page.mouse.up();
    await preview.getByRole("button", { name: "适应画面", exact: true }).click();
    await expect.poll(async () => Math.abs((await picture.boundingBox())!.width - initialBox.width)).toBeLessThan(1);
    const downloadEvent = page.waitForEvent("download");
    await preview.getByRole("button", { name: "下载原图", exact: true }).click();
    const download = await downloadEvent;
    const bytes = await readFile((await download.path())!);
    expect(bytes).toEqual(expected);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(sha256).toBe(createHash("sha256").update(expected).digest("hex"));
    if (screenshotPath) await page.screenshot({ path: screenshotPath, animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    return { bytes: bytes.length, sha256, expectedSha256: createHash("sha256").update(expected).digest("hex"), byteExact: true };
}

test("chat image actions preserve original bytes and keep the selected old version despite a different model target", async ({ page, context, api }, info) => {
    await models(context);
    let targetLabel = "图1", wrongTarget = false;
    const plannerRequests: any[] = [];
    await context.route("**/api/chat/responses", route => {
        const request = route.request().postDataJSON(); plannerRequests.push(request);
        const profile = request.profileContext;
        const target = profile.imageCatalog.find((image: any) => image.label === targetLabel);
        const actual = wrongTarget ? profile.imageCatalog.find((image: any) => image.label === "图3") : target;
        if (profile.stage !== "continue" && !profile.previewImageIds.includes(actual.id)) return route.fulfill({ json: tool("look_at_images", { image_ids: [...new Set([target.id, actual.id])] }) });
        return route.fulfill({ json: tool("edit_image", { base: actual.id, references: [], prompt: "Make the selected garment brighter while retaining its structure.", keep: ["Keep the garment structure."] }) });
    });
    await page.goto("/chat");
    const composer = page.getByRole("textbox", { name: "对话内容", exact: true });
    const focus = page.locator("[data-image-agent-focus]");
    // Chat displays work/version titles, while planner labels remain canonical.
    // Select the chronological card and verify its persisted identity below.
    const actions = (number: number) => page.locator(".group\\/image").nth(number - 1).getByRole("group");
    await expect(composer).toBeEnabled();
    await page.locator('input[type="file"]').setInputFiles({ name: "original.png", mimeType: "image/png", buffer: IMAGE });
    await expect(page.getByRole("button", { name: "移除 original.png", exact: true })).toBeVisible();
    await composer.fill("把原图稍微提亮，生成图片");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(actions(2)).toBeVisible();
    expect(api.submissions).toHaveLength(1);
    targetLabel = "图2";
    await composer.fill("再提亮一点，生成图片");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(actions(3)).toBeVisible();
    expect(api.submissions).toHaveLength(2);

    const calls = plannerRequests.length;
    const focusBeforePreview = await focus.getAttribute("data-focus-id");
    await inspectOriginal(page, page.locator(".group\\/image").nth(1), api.assetBytes.get([...api.tasks.keys()][0])!);
    await expect(focus).toHaveAttribute("data-focus-id", focusBeforePreview!);
    expect(plannerRequests).toHaveLength(calls); expect(api.submissions).toHaveLength(2);
    const originalId = plannerRequests.at(-1).profileContext.imageCatalog.find((image: any) => image.label === "图1").id;
    const oldId = plannerRequests.at(-1).profileContext.imageCatalog.find((image: any) => image.label === "图2").id;
    await actions(2).getByRole("button", { name: "在此基础上改", exact: true }).click();
    await expect(focus).toHaveAttribute("data-focus-id", oldId);
    await expect(focus).toContainText("底图已锁定");
    expect(plannerRequests).toHaveLength(calls);
    await composer.fill("从选中的旧图提亮，生成图片");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(actions(4)).toBeVisible();
    expect(api.submissions).toHaveLength(3);
    expect(api.submissions[2].parameters.inputArchive.references.map((image: any) => image.id)).toEqual([oldId]);
    await expect.poll(async () => (await savedChat(page)).messages.at(-1)?.generatedImages?.[0]?.parentId).toBe(oldId);

    await imageMenu(page, actions(3), "回原图重做");
    await expect(focus).toHaveAttribute("data-focus-id", originalId);
    await focus.getByRole("button", { name: "新创作", exact: true }).click();
    await expect(focus).toContainText("不沿用当前图片");
    await composer.fill("保留说明 @图2");
    await expect(page.getByRole("listbox", { name: "选择图片引用" })).toBeVisible();
    await composer.press("Enter");
    await expect(composer).toHaveValue("保留说明 @图2 ");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(focus).toHaveAttribute("data-focus-id", oldId);
    expect(api.submissions).toHaveLength(3);
    await actions(3).getByRole("button", { name: "作为参考", exact: true }).click();
    const removeReference = page.getByRole("button", { name: /^移除 / });
    await expect(removeReference).toHaveCount(1); await removeReference.click();

    await imageMenu(page, actions(2), "和原图对比");
    await expect(page.getByRole("dialog")).toContainText("与该图片已记录的原图比较");
    await expect(page.getByRole("button", { name: "导出预览 PNG", exact: true })).toBeEnabled();
    await page.screenshot({ path: info.outputPath("chat-original-comparison.png"), animations: "disabled" });
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    const downloadEvent = page.waitForEvent("download");
    await imageMenu(page, actions(1), "下载");
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toMatch(/\.png$/);
    expect(await readFile((await download.path())!)).toEqual(IMAGE);

    await actions(2).getByRole("button", { name: "在此基础上改", exact: true }).click();
    wrongTarget = true;
    await composer.fill("仍然修改图2，不要修改图3");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(actions(5)).toBeVisible();
    expect(api.submissions).toHaveLength(4);
    expect(plannerRequests.at(-1).profileContext.lockedImageId).toBe(oldId);
    expect(api.submissions[3].parameters.inputArchive.references.map((image: any) => image.id)).toEqual([oldId]);
    expect(api.submissions[3].sourceUrls).toHaveLength(1);
    await expect.poll(async () => (await savedChat(page)).messages.at(-1)?.generatedImages?.[0]?.parentId).toBe(oldId);
    const latestId = (await savedChat(page)).messages.at(-1).generatedImages[0].id;
    await page.setViewportSize({ width: 390, height: 844 });
    const sidebar = page.locator("aside").getByRole("button", { name: "收起会话", exact: true });
    if (await sidebar.isVisible()) await sidebar.click();
    await actions(5).scrollIntoViewIfNeeded();
    await expect(actions(5).getByRole("button", { name: "在此基础上改", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("chat-mobile-image-actions.png"), animations: "disabled" });
    await page.reload();
    await expect(actions(5)).toBeVisible();
    await expect(focus).toHaveAttribute("data-focus-id", latestId);
    expect((await savedChat(page)).messages.at(-1).generatedImages[0].parentId).toBe(oldId);
    expect(api.submissions).toHaveLength(4);
});

for (const surface of ["chat", "canvas"] as const) test(`${surface} keeps original preview usable during generation and planning, then removes it on employee change`, async ({ page, context, api }, info) => {
    await models(context);
    const plans: any[] = [];
    let heldPlanner: Route | undefined;
    await context.route("**/api/chat/responses", route => {
        const body = route.request().postDataJSON(); plans.push(body);
        if (body.profileContext.currentUserText === "先继续讨论") { heldPlanner = route; return; }
        return route.fulfill({ json: tool("edit_image", { base: "none", prompt: body.profileContext.currentUserText }) });
    });
    if (surface === "canvas") {
        await page.goto(`/canvas/${canvasHistory(api)}`);
        await page.getByRole("button", { name: "跟我走一遍", exact: true }).click();
        await page.getByRole("button", { name: "跳过引导", exact: true }).click();
        await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    } else await page.goto("/chat");
    const composer = surface === "chat" ? page.getByRole("textbox", { name: "对话内容", exact: true }) : page.locator(".cw-agent-panel textarea").last();
    const send = async (text: string) => {
        await composer.fill(text);
        await (surface === "chat" ? page : page.locator(".cw-agent-panel")).getByRole("button", { name: "发送", exact: true }).click();
    };
    const oldCard = surface === "chat" ? page.locator('[data-message-role="assistant"] .group\\/image').first() : page.getByTestId("canvas-agent-image-result").filter({ has: group(page, "图2") });
    if (surface === "chat") { await send("画一件毛衣"); await expect(oldCard).toBeVisible(); }
    const original = surface === "chat" ? api.assetBytes.get([...api.tasks.keys()][0])! : IMAGE;
    api.taskStatus = "processing";
    await send("再生成另一款毛衣");
    const expectedTasks = surface === "chat" ? 2 : 1;
    await expect.poll(() => api.submissions.length).toBe(expectedTasks);
    const pendingId = [...api.tasks.keys()].at(-1)!;
    await expect((surface === "chat" ? page : page.locator(".cw-agent-panel")).getByRole("button", { name: "发送", exact: true })).toBeVisible();
    await send("先继续讨论");
    await expect.poll(() => Boolean(heldPlanner)).toBe(true);
    await oldCard.hover();
    await expect(oldCard.getByRole("button", { name: "在此基础上改", exact: true })).toBeDisabled();
    const requestsBeforePreview = plans.length;
    const originalIntegrity = await inspectOriginal(page, oldCard, original, info.outputPath(`${surface}-full-original-preview.png`));
    await info.attach(`${surface}-original-download-integrity`, { body: JSON.stringify(originalIntegrity), contentType: "application/json" });
    expect(api.submissions).toHaveLength(expectedTasks); expect(plans).toHaveLength(requestsBeforePreview);
    expect(api.tasks.get(pendingId)!.status).toBe("processing");
    await heldPlanner!.fulfill({ json: { content: "可以先讨论，不产生新的图片任务。", toolCalls: [] } });
    await expect(page.getByText("可以先讨论，不产生新的图片任务。", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    if (surface === "chat") {
        const collapse = page.locator("aside").getByRole("button", { name: "收起会话", exact: true });
        if (await collapse.isVisible()) await collapse.click();
    }
    await oldCard.getByRole("button", { name: /^查看大图 · / }).click();
    await expect(page.getByRole("dialog").getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${surface}-full-original-mobile.png`), animations: "disabled" });
    let ownerReads = 0;
    await context.route("**/api/auth/session", route => { ownerReads++; return route.fulfill({ json: { user: { id: "00000000-0000-4000-8000-000000000088", username: "second", displayName: "第二员工", role: "designer", status: "active", creditBalance: 999 } } }); });
    // Exercise the real focus-time session revalidation, not an injected app store.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => ownerReads).toBeGreaterThan(0);
    await expect(page.getByRole("heading", { name: "登录状态已变化，工作区已暂停", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "下载原图", exact: true })).toHaveCount(0);
    expect(api.submissions).toHaveLength(expectedTasks); expect(plans).toHaveLength(requestsBeforePreview);
    expect(api.tasks.get(pendingId)!.status).toBe("processing");
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
        return route.fulfill({ json: tool("edit_image", { base: "none", prompt: profile.currentUserText }) });
    });
    await page.goto(`/canvas/${project}`);
    await expect(page.getByTestId("canvas-onboarding-tour")).toBeHidden();
    await page.getByRole("button", { name: "跟我走一遍", exact: true }).click();
    const skip = page.getByRole("button", { name: "跳过引导", exact: true });
    await expect(skip).toBeVisible();
    await skip.click();
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    await expect(group(page, "图2")).toBeVisible();
    const focus = page.locator(".cw-agent-panel [data-image-agent-focus]");
    const focusBeforePreview = await focus.getAttribute("data-focus-id");
    await inspectOriginal(page, page.getByTestId("canvas-agent-image-result").filter({ has: group(page, "图2") }), IMAGE);
    expect(await focus.getAttribute("data-focus-id")).toBe(focusBeforePreview);
    expect(plans).toHaveLength(0); expect(api.submissions).toHaveLength(0);
    const oldId = "chat-image:result-message-0:result:old-result";
    const originalId = "chat-image:upload-message:reference:0:original";
    await page.getByTestId("canvas-agent-image-result").filter({ has: group(page, "图2") }).hover();
    await group(page, "图2").getByRole("button", { name: "在此基础上改", exact: true }).click();
    await expect(focus).toHaveAttribute("data-focus-id", oldId);
    await expect(focus).toContainText("底图已锁定");
    expect(plans).toHaveLength(0); expect(api.submissions).toHaveLength(0);
    const composer = page.locator(".cw-agent-panel textarea").last();
    await composer.fill("Make the square brighter.");
    await page.locator(".cw-agent-panel").getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0].operationType).toBe("inpaint");
    expect(api.submissions[0].parameters.inputArchive.references.map((image: any) => image.id)).toEqual([oldId]);
    expect(plans[0].profileContext.lockedImageId).toBe(oldId);
    await expect.poll(() => api.document(project)?.chatSessions[0].messages.findLast((message: any) => message.detail?.imageAgent)?.detail.imageAgent.baseImageId).toBe(oldId);
    await expect(group(page, "图4")).toBeVisible();
    await imageMenu(page, group(page, "图3"), "回原图重做");
    await expect(focus).toHaveAttribute("data-focus-id", originalId);
    await composer.fill("Rework the original square.");
    await page.locator(".cw-agent-panel").getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(2);
    expect(api.submissions[1].parameters.inputArchive.references.map((image: any) => image.id)).toEqual([originalId]);
    expect(api.submissions[1].operationType).toBe("inpaint");
    await expect.poll(() => api.document(project)?.chatSessions[0].messages.findLast((message: any) => message.detail?.imageAgent)?.detail.imageAgent.baseImageId).toBe(originalId);
    await expect(group(page, "图5")).toBeVisible();
    await focus.getByRole("button", { name: "新创作", exact: true }).click();
    await composer.fill("Compare @版本1");
    await expect(page.getByRole("listbox", { name: "选择图片引用" })).toBeVisible();
    await composer.press("Enter");
    await expect(composer).toHaveValue("Compare @图2 ");
    await expect(focus).toHaveAttribute("data-focus-id", oldId);
    expect(api.submissions).toHaveLength(2);
    await page.screenshot({ path: info.outputPath("canvas-image-actions-light.png"), animations: "disabled" });
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    await page.getByTestId("language-switch").filter({ visible: true }).first().click();
    await expect(page.getByRole("group", { name: "Image 2 image actions", exact: true }).getByRole("button", { name: "Edit from here", exact: true })).toBeVisible();
    await expect(focus).toContainText("Image 2");
    await expect(focus).toContainText("Base image locked");
    await page.screenshot({ path: info.outputPath("canvas-image-actions-dark-English.png"), animations: "disabled" });
    expect(api.submissions).toHaveLength(2);
});
