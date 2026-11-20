import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import { test, expect, newCanvas, IMAGE, fixturePng } from "./fixtures";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const libraryId = "b1000000-0000-4000-8000-000000000001";
const libraryImage = { id: libraryId, kind: "image", filename: "素材库配色.png", contentUrl: `/api/assets/${libraryId}/content` };
const extra = fixturePng(70);

async function openDiscussion(page: Page) {
    await newCanvas(page);
    await page.getByRole("button", { name: "打开设计讨论", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "设计讨论面板" });
    await expect(panel.getByRole("textbox", { name: "输入设计需求" })).toBeEnabled();
    return panel;
}

async function pasteImage(page: Page, composer: Locator, bytes = extra) {
    await page.evaluate(async image => navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(image)], { type: "image/png" }) })]), [...bytes]);
    await composer.focus();
    await page.keyboard.press("Control+V");
}

test("design discussion paste preserves references and text, and image preview copies without sending", async ({ page, context, api }, info) => {
    const paid: string[] = [];
    page.on("request", request => { if (request.method() === "POST" && /\/api\/(chat\/responses|tasks|image-conversations)/.test(new URL(request.url()).pathname)) paid.push(request.url()); });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(info.project.use.baseURL!).origin });
    const panel = await openDiscussion(page);
    await panel.locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]').setInputFiles({ name: "原始针织图.png", mimeType: "image/png", buffer: IMAGE });
    await expect(panel.locator(".studio-reference")).toHaveCount(1);
    const original = await panel.locator(".studio-reference img").first().getAttribute("src");
    const composer = panel.getByRole("textbox", { name: "输入设计需求" });
    await composer.fill("只修改领口，保留已有参考和草稿");
    await pasteImage(page, composer);
    await expect(panel.locator(".studio-reference")).toHaveCount(2);
    await expect(panel.locator(".studio-reference img").first()).toHaveAttribute("src", original!);
    await expect(composer).toHaveValue("只修改领口，保留已有参考和草稿");
    const edits = panel.getByRole("button", { name: /^基于此图修改 · 图/ });
    await edits.first().click();
    await expect(panel.getByRole("combobox", { name: "图1用途", exact: true })).toHaveValue("base");
    await edits.nth(1).click();
    await expect(panel.getByRole("combobox", { name: "图1用途", exact: true })).toHaveValue("auto");
    await expect(panel.getByRole("combobox", { name: "图2用途", exact: true })).toHaveValue("base");
    await panel.getByRole("button", { name: "查看参考图1原图", exact: true }).click();
    const preview = page.getByRole("dialog");
    await expect(preview.getByRole("button", { name: "放大大图", exact: true })).toBeVisible();
    await preview.getByRole("button", { name: "放大大图", exact: true }).click();
    await preview.getByRole("button", { name: "复制图片", exact: true }).click();
    await expect(page.getByText("图片已复制，可粘贴到对话输入框", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("design-reference-preview.png"), animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await composer.focus(); await page.keyboard.press("Control+V");
    await expect(panel.locator(".studio-reference")).toHaveCount(3);
    await panel.getByRole("button", { name: "查看参考图3原图", exact: true }).click();
    const copied = await preview.locator("img").evaluate(async element => Array.from(new Uint8Array(await (await fetch((element as HTMLImageElement).src)).arrayBuffer())));
    expect(hash(new Uint8Array(copied))).toBe(hash(IMAGE));
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await edits.nth(2).click();
    await expect(panel.getByRole("combobox", { name: "图1用途", exact: true })).toHaveValue("auto");
    await expect(panel.getByRole("combobox", { name: "图2用途", exact: true })).toHaveValue("auto");
    await expect(panel.getByRole("combobox", { name: "图3用途", exact: true })).toHaveValue("base");
    await expect(composer).toHaveValue("只修改领口，保留已有参考和草稿");
    await page.screenshot({ path: info.outputPath("design-media-desktop.png"), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(composer).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await panel.getByRole("button", { name: "查看参考图3原图", exact: true }).scrollIntoViewIfNeeded();
    await expect(panel.getByRole("button", { name: "查看参考图3原图", exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath("design-media-mobile.png"), animations: "disabled" });
    expect(paid).toEqual([]);
    expect(api.submissions).toEqual([]);
});

test("design discussion selects existing library assets without reupload and refuses a fifth reference", async ({ page, context, api }, info) => {
    await context.route(/\/api\/assets\?/, route => route.fulfill({ json: { assets: [libraryImage], hasMore: false, nextCursor: null } }));
    const panel = await openDiscussion(page);
    await panel.locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]').setInputFiles({ name: "保留原图.png", mimeType: "image/png", buffer: IMAGE });
    await expect(panel.locator(".studio-reference")).toHaveCount(1);
    const previous = await panel.locator(".studio-reference img").getAttribute("src");
    const before = api.assets.size;
    await panel.getByRole("button", { name: "素材库选图", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "选择设计参考", exact: true });
    await expect(picker.getByRole("tab", { name: "我的素材", exact: true })).toHaveAttribute("aria-selected", "true");
    await picker.getByRole("button", { name: "选择图片：素材库配色.png", exact: true }).click();
    await picker.getByRole("button", { name: "使用这 1 张图片", exact: true }).click();
    await expect(panel.locator(".studio-reference")).toHaveCount(2);
    await expect(panel.locator(".studio-reference img").first()).toHaveAttribute("src", previous!);
    await expect(panel.locator(".studio-reference img").nth(1)).toHaveAttribute("data-loaded", "true");
    expect(api.assets.size).toBe(before);
    await panel.locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]').setInputFiles([{ name: "补充1.png", mimeType: "image/png", buffer: extra }, { name: "补充2.png", mimeType: "image/png", buffer: extra }]);
    await expect(panel.locator(".studio-reference")).toHaveCount(4);
    await expect(panel.locator(".studio-reference img")).toHaveCount(4);
    const four = await panel.locator(".studio-reference img").evaluateAll(elements => elements.map(element => element.getAttribute("src")));
    await panel.getByRole("textbox", { name: "输入设计需求" }).evaluate((element, bytes) => {
        const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], "不能覆盖已有参考.png", { type: "image/png" }));
        element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, [...extra]);
    await expect(panel.getByRole("alert")).toContainText("最多 4 张");
    expect(await panel.locator(".studio-reference img").evaluateAll(elements => elements.map(element => element.getAttribute("src")))).toEqual(four);
    await page.screenshot({ path: info.outputPath("design-library-four-reference-limit.png"), animations: "disabled" });
    expect(api.submissions).toEqual([]);
});

test("discussion thumbnails display while original delivery is blocked until explicit preview", async ({ page, context, api }, info) => {
    let releaseOriginal!: () => void;
    const originalGate = new Promise<void>(resolve => { releaseOriginal = resolve; });
    let originals = 0, thumbnails = 0;
    await context.route(/\/api\/assets\?/, route => route.fulfill({ json: { assets: [libraryImage], hasMore: false, nextCursor: null } }));
    await context.route(`**/api/assets/${libraryId}/thumb?*`, route => { thumbnails++; return route.fulfill({ contentType: "image/png", body: IMAGE }); });
    await context.route(`**${libraryImage.contentUrl}`, async route => { originals++; await originalGate; await route.fulfill({ contentType: "image/png", body: IMAGE }); });
    try {
        const panel = await openDiscussion(page);
        const libraryOpened = Date.now();
        await panel.getByRole("button", { name: "素材库选图", exact: true }).click();
        const picker = page.getByRole("dialog", { name: "选择设计参考", exact: true });
        const choice = picker.getByRole("button", { name: "选择图片：素材库配色.png", exact: true });
        await expect(choice.locator("img")).toHaveAttribute("data-loaded", "true");
        const libraryThumbnailMs = Date.now() - libraryOpened;
        await choice.click();
        const selectionStarted = Date.now();
        await picker.getByRole("button", { name: "使用这 1 张图片", exact: true }).click();
        await expect(panel.locator(".studio-reference img")).toHaveAttribute("data-loaded", "true");
        const selectedThumbnailMs = Date.now() - selectionStarted;
        expect(originals).toBe(0);
        expect(thumbnails).toBeGreaterThan(0);
        await page.screenshot({ path: info.outputPath("thumbnail-ready-original-not-requested.png"), animations: "disabled" });
        await panel.getByRole("button", { name: "查看参考图1原图", exact: true }).click();
        await expect.poll(() => originals).toBeGreaterThan(0);
        releaseOriginal();
        const preview = page.getByRole("dialog");
        await expect(preview.locator("img")).toHaveAttribute("src", libraryImage.contentUrl);
        await expect(preview.getByRole("button", { name: "复制图片", exact: true })).toBeVisible();
        const timing = JSON.stringify({ libraryThumbnailMs, selectedThumbnailMs, thumbnails, originalsBeforeExplicitPreview: 0, originalRequestedOnlyOnExplicitPreview: true, providerCalls: api.submissions.length }, null, 2);
        await writeFile(info.outputPath("thumbnail-timing.json"), timing);
        await info.attach("thumbnail-timing", { body: timing, contentType: "application/json" });
        expect(api.submissions).toEqual([]);
        expect(api.assets.size).toBe(0);
    } finally { releaseOriginal(); }
});

test("invalid design reply reports a visible error after validation stops at the reported desktop size", async ({ page, context, api }, info) => {
    await page.setViewportSize({ width: 1798, height: 898 });
    let interceptedReplies = 0;
    await context.route("**/api/chat/responses", route => {
        interceptedReplies++;
        return route.fulfill({ status: 200, json: { content: JSON.stringify({ message: "这是本地固定的结构不合格回复，不代表任何真实模型结果。", questions: [], proposals: [], sources: [], trendStatus: "隔离界面诊断", unexpectedField: true }), toolCalls: [], stopReason: "stop" } });
    });
    const panel = await openDiscussion(page);
    await panel.locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]').setInputFiles({ name: "本地诊断参考图.png", mimeType: "image/png", buffer: IMAGE });
    await expect(panel.locator(".studio-reference")).toHaveCount(1);
    await panel.locator(".studio-brief > summary").click();
    await panel.getByRole("combobox", { name: "合作品牌", exact: true }).selectOption({ label: "Zara" });
    const composer = panel.getByRole("textbox", { name: "输入设计需求" });
    await composer.fill("请分析图1的设计方向，只讨论，不生成图片。");
    await panel.getByRole("button", { name: "发送讨论", exact: true }).click();
    const alert = panel.getByRole("alert");
    await expect(alert).toHaveText("设计讨论回复字段无效；没有提交图片生成，不会自动重试。");
    await expect(composer).toBeEnabled();
    await expect(panel.locator(".studio-message.assistant")).toHaveCount(0);
    await expect(panel.locator(".studio-progress")).toContainText("正在核对方案结构、参考图编号与资料来源（本轮已停止）");
    const geometry = () => panel.evaluate(element => {
        const box = (target: Element) => { const rect = target.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom, right: rect.right }; };
        const target = element.querySelector('[role="alert"]')!;
        const rect = target.getBoundingClientRect();
        const center = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        const ancestors = [];
        for (let parent = target.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            if ([style.overflow, style.overflowX, style.overflowY].some(value => /hidden|clip|auto|scroll/.test(value))) ancestors.push({ className: parent.className, box: box(parent), overflowX: style.overflowX, overflowY: style.overflowY });
        }
        const style = getComputedStyle(target);
        return { viewport: { width: innerWidth, height: innerHeight }, panel: box(element), alert: { box: box(target), text: target.textContent, fontSize: style.fontSize, color: style.color, clientHeight: target.clientHeight, scrollHeight: target.scrollHeight, fullyInsideViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth, centerHit: target === center || target.contains(center) }, composer: box(element.querySelector(".studio-composer")!), scroll: { box: box(element.querySelector(".studio-scroll")!), scrollHeight: element.querySelector(".studio-scroll")!.scrollHeight }, clippingAncestors: ancestors };
    });
    const stopped = await geometry();
    await page.screenshot({ path: info.outputPath("invalid-reply-stopped-before-opening-process.png"), animations: "disabled" });
    await panel.locator(".discussion-process > summary").click();
    await expect(panel.getByRole("list", { name: "实际处理步骤" })).toBeVisible();
    const opened = await geometry();
    await page.screenshot({ path: info.outputPath("invalid-reply-process-open-and-error.png"), animations: "disabled" });
    await writeFile(info.outputPath("invalid-reply-error-geometry.json"), JSON.stringify({ fixture: "HTTP 200, fixed unexpectedField response; no real model request", source: "current local candidate plus unreleased media changes, not deployed v106", stopped, opened, interceptedReplies, generationSubmissions: api.submissions.length, blockedExternalRequests: api.blocked }, null, 2));
    expect(stopped.alert.fullyInsideViewport).toBe(true);
    expect(stopped.alert.centerHit).toBe(true);
    expect(opened.alert.fullyInsideViewport).toBe(true);
    expect(opened.alert.centerHit).toBe(true);
    expect(interceptedReplies).toBe(1);
    expect(api.submissions).toEqual([]);
    expect(api.blocked).toEqual([]);
});
