import type { Page } from "@playwright/test";
import { test, expect, IMAGE, fixturePng, newCanvas, uploadImage } from "./fixtures";
import {
    conversationIds as ids,
    conversationMessage,
    conversationSnapshot,
    conversationTurn,
    conversationVersion,
} from "../tests/fixtures/image-conversation";

const libraryId = "b2000000-0000-4000-8000-000000000001";
const library = {
    id: libraryId,
    kind: "image",
    filename: "素材库配色.png",
    contentUrl: `/api/assets/${libraryId}/content`,
};

async function openConversation(page: Page) {
    const writes: string[] = [];
    const snapshot = {
        ...conversationSnapshot(),
        activeVersion: conversationVersion(true),
        activeVersionId: ids.generated,
    };
    await page.route("**/api/deployment", (route) =>
        route.fulfill({
            json: {
                authenticationEnabled: true,
                creditsEnabled: false,
                rolePortalsEnabled: false,
                oaLoginEnabled: false,
                imageConversationsEnabled: true,
            },
        }),
    );
    await page.route(/\/api\/assets\?/, (route) =>
        route.fulfill({ json: { assets: [library], hasMore: false, nextCursor: null } }),
    );
    await page.route(/^https?:\/\/[^/]+\/api\/image-conversations(?:[/?]|$)/, (route) => {
        const path = new URL(route.request().url()).pathname;
        const reply = (data: unknown) => route.fulfill({ json: { code: "OK", data, msg: "" } });
        if (route.request().method() !== "GET") {
            writes.push(path);
            return route.abort();
        }
        if (path === "/api/image-conversations") {
            const {
                activeVersion: _version,
                pendingTurn: _turn,
                latestEventSeq: _seq,
                contextSummary: _context,
                contextSummaryThroughSeq: _through,
                ...summary
            } = snapshot;
            return reply({ items: [summary], nextCursor: null });
        }
        if (path.endsWith("/design-executions")) return reply({ items: [], nextCursor: null });
        if (path.endsWith("/events"))
            return route.fulfill({ contentType: "text/event-stream", body: ": connected\n\n" });
        if (path.endsWith("/messages")) return reply({ items: [conversationMessage(true)], nextCursor: null });
        if (path.endsWith("/versions"))
            return reply({ items: [conversationVersion(), conversationVersion(true)], nextCursor: null });
        if (path.endsWith("/turns")) return reply({ items: [conversationTurn("completed")], nextCursor: null });
        return reply(snapshot);
    });
    await page.goto("/chat");
    await page
        .getByRole("navigation", { name: "会话列表" })
        .getByRole("button", { name: /针织衫改款/ })
        .click();
    await expect(page.getByText("已连接服务端", { exact: true })).toBeVisible();
    return { panel: page.getByTestId("server-image-conversation"), writes };
}

test("version preview stays on page, zooms and pans without changing the draft or submitting", async ({
    page,
    context,
    api,
}, info) => {
    const originals: string[] = [],
        thumbnails: string[] = [];
    page.on("request", (request) => {
        const url = new URL(request.url());
        if (/\/api\/assets\/[^/]+\/content$/.test(url.pathname)) originals.push(url.pathname);
        if (/\/api\/assets\/[^/]+\/thumb$/.test(url.pathname)) thumbnails.push(url.pathname + url.search);
    });
    const { panel, writes } = await openConversation(page);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
    await expect(panel.getByRole("img", { name: "图2 · 蓝色版本", exact: true })).toBeVisible();
    expect(originals).toEqual([]);
    expect(
        thumbnails.some(
            (url) =>
                url.startsWith(`/api/assets/${ids.resultAsset}/thumb?`) &&
                new URL(url, page.url()).searchParams.get("w") === "1024",
        ),
    ).toBe(true);
    await info.attach("history-image-requests.json", {
        contentType: "application/json",
        body: JSON.stringify({ historyOriginalRequests: originals, historyThumbnailRequests: thumbnails }),
    });
    const composer = panel.getByRole("textbox", { name: "对话内容", exact: true });
    await composer.fill("保留未发送的改图要求");
    await panel.getByRole("button", { name: "查看图2原图", exact: true }).click({ timeout: 5_000 });
    const preview = page.getByRole("dialog");
    await expect(preview.getByRole("button", { name: "放大大图", exact: true })).toBeVisible();
    await expect.poll(() => originals.some((url) => url.includes(ids.resultAsset))).toBe(true);
    const image = preview.getByRole("img", { name: "图2", exact: true });
    const original = await image.evaluate((element) => getComputedStyle(element).transform);
    await preview.getByRole("button", { name: "放大大图", exact: true }).click();
    await expect.poll(() => image.evaluate((element) => getComputedStyle(element).transform)).not.toBe(original);
    const beforeMove = await image.boundingBox();
    await image.hover();
    await page.mouse.down();
    await page.mouse.move(beforeMove!.x + beforeMove!.width / 2 + 90, beforeMove!.y + beforeMove!.height / 2 + 60, {
        steps: 5,
    });
    await page.mouse.up();
    await expect.poll(async () => (await image.boundingBox())!.x).not.toBe(beforeMove!.x);
    await expect(preview.getByRole("button", { name: "复制图片", exact: true })).toBeVisible();
    await preview.getByRole("button", { name: "复制图片", exact: true }).click();
    await expect(page.getByText("图片已复制，可粘贴到对话输入框", { exact: true })).toBeVisible();
    expect(await page.evaluate(async () => (await navigator.clipboard.read())[0].types)).toContain("image/png");
    const download = page.waitForEvent("download");
    await preview.getByRole("button", { name: "下载原图", exact: true }).click();
    expect((await download).suggestedFilename()).toBeTruthy();
    await page.screenshot({ path: info.outputPath("version-preview-zoom-pan.png"), animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await expect(composer).toHaveValue("保留未发送的改图要求");
    await expect(panel.getByRole("button", { name: /^移除 / })).toHaveCount(0);
    expect(context.pages()).toHaveLength(1);
    expect(writes).toEqual([]);
    expect(api.submissions).toEqual([]);
});

test("HTTP clipboard fallback pastes the original and rejects stale copy tokens without swallowing text", async ({
    page,
    context,
    api,
}, info) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(info.project.use.baseURL!).origin,
    });
    await page.addInitScript(() => {
        Object.defineProperty(window, "__nativeClipboard", { value: navigator.clipboard });
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    });
    const { panel, writes } = await openConversation(page);
    const composer = panel.getByRole("textbox", { name: "对话内容", exact: true });
    await composer.fill("保留原文");
    const tokens: string[] = [];
    for (const number of [1, 2]) {
        await panel.getByRole("button", { name: `查看图${number}原图`, exact: true }).click();
        const previous = await page.evaluate(() =>
            (window as Window & { __nativeClipboard: Clipboard }).__nativeClipboard.readText(),
        );
        await page.getByRole("dialog").getByRole("button", { name: "复制图片", exact: true }).click();
        await expect
            .poll(() =>
                page.evaluate(() => (window as Window & { __nativeClipboard: Clipboard }).__nativeClipboard.readText()),
            )
            .not.toBe(previous);
        tokens.push(
            await page.evaluate(() =>
                (window as Window & { __nativeClipboard: Clipboard }).__nativeClipboard.readText(),
            ),
        );
        expect(tokens.at(-1)).toMatch(/^trucreate-image:v1:/);
        await page.keyboard.press("Escape");
        await composer.focus();
        await page.keyboard.press("Control+V");
        await expect(panel.locator("[data-draft-asset-id]")).toHaveCount(number, { timeout: 5_000 });
        await expect(composer).toHaveValue("保留原文");
        expect([...api.assetBytes.values()].at(-1)).toEqual(IMAGE);
    }
    await page.evaluate(
        (token) => (window as Window & { __nativeClipboard: Clipboard }).__nativeClipboard.writeText(token),
        tokens[0],
    );
    await composer.focus();
    await page.keyboard.press("Control+V");
    await expect(panel.getByRole("alert")).toContainText("复制的图片已失效");
    await expect(panel.locator("[data-draft-asset-id]")).toHaveCount(2);
    await expect(composer).toHaveValue("保留原文");
    await page.evaluate(() =>
        (window as Window & { __nativeClipboard: Clipboard }).__nativeClipboard.writeText("，只改颜色"),
    );
    await composer.press("End");
    await page.keyboard.press("Control+V");
    await expect(composer).toHaveValue("保留原文，只改颜色");
    expect(writes).toEqual([]);
    expect(api.submissions).toEqual([]);
    await page.screenshot({ path: info.outputPath("conversation-http-copy-paste.png"), animations: "disabled" });
});

test("image paste, drop and library append originals while explicit edit target remains a draft-only choice", async ({
    page,
    context,
    api,
}, info) => {
    const { panel, writes } = await openConversation(page);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
    const composer = panel.getByRole("textbox", { name: "对话内容", exact: true });
    await composer.fill("只改领口");
    const pasteBytes = await page.evaluate(
        async (bytes) => {
            await navigator.clipboard.write([
                new ClipboardItem({ "image/png": new Blob([new Uint8Array(bytes)], { type: "image/png" }) }),
            ]);
            const [item] = await navigator.clipboard.read();
            return Array.from(new Uint8Array(await (await item.getType("image/png")).arrayBuffer()));
        },
        [...IMAGE],
    );
    await composer.focus();
    await page.keyboard.press("Control+V");
    const attachments = panel.locator("[data-draft-asset-id]");
    await expect(attachments).toHaveCount(1, { timeout: 5_000 });
    await expect(composer).toHaveValue("只改领口");
    const saved = await attachments
        .first()
        .locator("img")
        .evaluate(async (image) =>
            Array.from(new Uint8Array(await (await fetch((image as HTMLImageElement).src)).arrayBuffer())),
        );
    expect(saved).toEqual(pasteBytes);
    await page.evaluate(() => navigator.clipboard.writeText("，保留针织纹理"));
    await composer.focus();
    await composer.press("End");
    await page.keyboard.press("Control+V");
    await expect(composer).toHaveValue("只改领口，保留针织纹理");
    await composer.evaluate(
        (element, bytes) => {
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(new File([new Uint8Array(bytes)], "拖入参考.png", { type: "image/png" }));
            element.dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }));
        },
        [...fixturePng(70)],
    );
    await expect(attachments).toHaveCount(2);
    const beforeLibrary = api.assets.size;
    await panel.getByRole("button", { name: "素材库选图", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "选择设计参考", exact: true });
    await expect(picker.getByRole("tab", { name: "我的素材", exact: true })).toHaveAttribute("aria-selected", "true");
    await picker.getByRole("button", { name: "选择图片：素材库配色.png", exact: true }).click();
    await picker.getByRole("button", { name: "使用这 1 张图片", exact: true }).click();
    await expect(attachments).toHaveCount(3);
    expect(api.assets.size).toBe(beforeLibrary);
    await attachments.first().getByRole("combobox").selectOption("new_base");
    await expect(attachments.first().getByRole("combobox")).toHaveValue("new_base");
    await attachments.nth(2).getByRole("combobox").selectOption("new_base");
    await expect(attachments.first().getByRole("combobox")).toHaveValue("reference");
    await panel
        .locator(`[data-version-id='${ids.generated}']`)
        .getByRole("button", { name: "基于此图修改", exact: true })
        .click();
    await expect(attachments).toHaveCount(4);
    await expect(panel.locator(`[data-draft-asset-id='${ids.resultAsset}']`).getByRole("combobox")).toHaveValue(
        "new_base",
    );
    await expect(attachments.nth(2).getByRole("combobox")).toHaveValue("reference");
    await expect(composer).toHaveValue("只改领口，保留针织纹理");
    await page.screenshot({ path: info.outputPath("conversation-media-desktop.png"), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.getByRole("button", { name: "收起会话", exact: true }).click();
    await expect(composer).toBeVisible();
    await expect(panel.getByRole("button", { name: "素材库选图", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("conversation-media-mobile.png"), animations: "disabled" });
    expect(writes).toEqual([]);
    expect(api.submissions).toEqual([]);
});

test("selected canvas originals can be added to the conversation draft without reupload or automatic submission", async ({
    page,
    api,
}, info) => {
    const { writes } = await openConversation(page);
    const canvasId = await newCanvas(page);
    await uploadImage(page, "画布选中原图.png");
    await expect.poll(() => api.document(canvasId)?.nodes.length).toBe(1);
    const before = api.assets.size;
    const assetId = [...api.assets.keys()][0];
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.getByTestId("server-image-conversation");
    const composer = panel.getByRole("textbox", { name: "对话内容", exact: true });
    await composer.fill("先保留草稿，不发送");
    await panel.getByRole("button", { name: "添加选中图片", exact: true }).click({ timeout: 5_000 });
    await expect(panel.locator(`[data-draft-asset-id='${assetId}']`)).toBeVisible();
    await expect(composer).toHaveValue("先保留草稿，不发送");
    await panel.getByRole("button", { name: "添加选中图片", exact: true }).click();
    await expect(panel.locator("[data-draft-asset-id]")).toHaveCount(1);
    expect(api.assets.size).toBe(before);
    expect(writes).toEqual([]);
    expect(api.submissions).toEqual([]);
    await page.screenshot({ path: info.outputPath("canvas-selected-original-draft.png"), animations: "disabled" });
});

test("selected duplicate canvas nodes sharing an original add one draft attachment without reupload or submission", async ({
    page,
    api,
}, info) => {
    const { writes } = await openConversation(page);
    const canvasId = "b3000000-0000-4000-8000-000000000001";
    const document = {
        id: canvasId,
        title: "共享原件画布",
        createdAt: "2026-11-20T00:00:00.000Z",
        updatedAt: "2026-11-20T00:00:00.000Z",
        nodes: [
            {
                id: "shared-original",
                type: "image",
                title: "共享原件.png",
                width: 256,
                height: 256,
                position: { x: 0, y: 0 },
                metadata: {
                    content: `/api/assets/${libraryId}/content`,
                    serverAssetId: libraryId,
                    status: "success",
                    naturalWidth: 256,
                    naturalHeight: 256,
                },
            },
        ],
        connections: [],
        groups: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "dots",
        showImageInfo: false,
        viewport: { x: 520, y: 140, k: 1 },
        selectedNodeIds: [],
        history: { past: [], future: [] },
    };
    api.documents.set(canvasId, { id: canvasId, revision: 1, document, deleted: false, updatedAt: document.updatedAt });
    api.assetBytes.set(libraryId, IMAGE);
    await page.goto(`/canvas/${canvasId}`);
    await page.locator('[data-node-id="shared-original"]').click({ position: { x: 20, y: 15 } });
    await page.keyboard.press("Control+d");
    await expect.poll(() => api.document(canvasId)?.nodes.length).toBe(2);
    await page.keyboard.press("Control+a");
    await expect(page.locator('[data-node-id][aria-label*="已选择"]')).toHaveCount(2);
    const nodes = api.document(canvasId)!.nodes;
    expect(new Set(nodes.map((node: { metadata: { content: string } }) => node.metadata.content)).size).toBe(1);
    const before = api.assets.size;
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.getByTestId("server-image-conversation");
    await panel.getByRole("button", { name: "添加选中图片", exact: true }).click();
    await expect(panel.locator("[data-draft-asset-id]")).toHaveCount(1, { timeout: 5_000 });
    expect(api.assets.size).toBe(before);
    expect(writes).toEqual([]);
    expect(api.submissions).toEqual([]);
    await page.screenshot({ path: info.outputPath("canvas-duplicate-original-draft.png"), animations: "disabled" });
});

test("a full sixteen-image draft can reselect its cached local canvas original without upload or submission", async ({
    page,
    api,
}, info) => {
    await page.setViewportSize({ width: 1800, height: 1800 });
    const { writes } = await openConversation(page);
    const assets = Array.from({ length: 15 }, (_, index) => {
        const id = `b4000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
        return { id, kind: "image", filename: `边界参考${index + 1}.png`, contentUrl: `/api/assets/${id}/content` };
    });
    await page.route(/\/api\/assets\?/, (route) =>
        route.fulfill({ json: { assets, hasMore: false, nextCursor: null } }),
    );
    const canvasId = await newCanvas(page);
    await uploadImage(page, "本机缓存原件.png");
    await expect.poll(() => api.document(canvasId)?.nodes.length).toBe(1);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.getByTestId("server-image-conversation");
    const addSelected = panel.getByRole("button", { name: "添加选中图片", exact: true });
    await addSelected.click();
    await expect(panel.locator("[data-draft-asset-id]")).toHaveCount(1);
    await panel.getByRole("button", { name: "素材库选图", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "选择设计参考", exact: true });
    for (const asset of assets)
        await picker.getByRole("button", { name: `选择图片：${asset.filename}`, exact: true }).click();
    await picker.getByRole("button", { name: "使用这 15 张图片", exact: true }).click();
    await expect(panel.locator("[data-draft-asset-id]")).toHaveCount(16);
    const before = api.assets.size;
    await addSelected.click();
    await expect(addSelected).toBeEnabled();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(panel.locator("[data-draft-asset-id]")).toHaveCount(16);
    expect(api.assets.size).toBe(before);
    expect(writes).toEqual([]);
    expect(api.submissions).toEqual([]);
    await page.screenshot({ path: info.outputPath("canvas-sixteen-cached-original.png"), animations: "disabled" });
});

test("unavailable thumbnails expose manual original preview without automatic full-image fallback or retry loops", async ({
    page,
    api,
}, info) => {
    let reads = 0;
    const originals: string[] = [];
    page.on("request", (request) => {
        if (/\/api\/assets\/[^/]+\/content$/.test(new URL(request.url()).pathname)) originals.push(request.url());
    });
    await page.route(`**/api/assets/${ids.resultAsset}/thumb?*`, (route) => {
        reads++;
        return route.fulfill({ status: 404, json: { error: "ASSET_PREVIEW_NOT_FOUND" } });
    });
    const { panel, writes } = await openConversation(page);
    const result = panel.locator(`[data-version-id='${ids.generated}']`);
    await expect(result.getByLabel("缩略预览暂不可用，可点击查看原图")).toBeVisible();
    await expect.poll(() => reads).toBeGreaterThan(0);
    const initialReads = reads;
    expect(initialReads).toBeLessThanOrEqual(2);
    await panel.getByRole("button", { name: "刷新服务端记录", exact: true }).click();
    await expect(panel.getByText("已连接服务端", { exact: true })).toBeVisible();
    expect(reads).toBe(initialReads);
    expect(originals).toEqual([]);
    await result.getByRole("button", { name: "查看图2原图", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("img", { name: "图2", exact: true })).toBeVisible();
    await expect.poll(() => originals.length).toBe(1);
    expect(reads).toBe(initialReads);
    expect(writes).toEqual([]);
    expect(api.submissions).toEqual([]);
    await info.attach("unavailable-thumbnail-requests.json", {
        contentType: "application/json",
        body: JSON.stringify({ thumbnailAttempts: reads, manualOriginalRequests: originals }),
    });
});
