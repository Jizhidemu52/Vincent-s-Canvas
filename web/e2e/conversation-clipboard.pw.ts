import { createHash } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { test, expect, fixturePng } from "./fixtures";

const originals = [fixturePng(160), fixturePng(200)];
const sha = (bytes: Uint8Array | number[]) => createHash("sha256").update(Buffer.from(bytes)).digest("hex");
const expectedHashes = originals.map(sha);
const initialPrompt = "保留我已输入的改图要求";
const extraText = "，只修改指定颜色";
const fixture = `<!doctype html><html><head><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/e2e/conversation-clipboard.fixture.tsx"></script></body></html>`;

type ClipboardSnapshot = { types: string[]; text: string };

async function nativeClipboard(page: Page, accepts: (snapshot: ClipboardSnapshot) => boolean = () => true) {
    let accepted: ClipboardSnapshot | undefined;
    await expect.poll(async () => {
        const snapshot = await page.evaluate(async () => {
            const clipboard = (window as Window & { __nativeClipboard: Clipboard }).__nativeClipboard;
            try {
                const items = await clipboard.read();
                const item = items.find(value => value.types.includes("text/plain"));
                return { types: items.flatMap(value => value.types), text: item ? await (await item.getType("text/plain")).text() : "" };
            } catch (error) {
                // Chromium invalidates a lazy ClipboardItem if the ongoing OS
                // write changes it between read() and getType(). Re-read only;
                // permission failures and all other errors must still fail.
                if (error instanceof DOMException && error.name === "InvalidStateError" && error.message.endsWith("Clipboard data has changed")) return null;
                throw error;
            }
        });
        if (!snapshot || !accepts(snapshot)) return false;
        accepted = snapshot;
        return true;
    }, { message: "a complete, current native clipboard snapshot" }).toBe(true);
    return accepted!;
}

async function pasteNative(page: Page, composer: Locator) {
    await composer.focus();
    await composer.press("End");
    await page.keyboard.press("Control+V");
}

async function writeNativeText(page: Page, value: string) {
    await page.evaluate(value => (window as Window & { __nativeClipboard: Clipboard }).__nativeClipboard.writeText(value), value);
}

async function imageHashes(images: Locator) {
    return Promise.all((await images.all()).map(async image => sha(await image.evaluate(async element => Array.from(new Uint8Array(await (await fetch((element as HTMLImageElement).src)).arrayBuffer()))))));
}

for (const surface of ["chat", "canvas-components"] as const) {
    for (const mode of ["native", "http-fallback"] as const) {
        test(`${surface}: click Copy then native Ctrl+V preserves original bytes (${mode})`, async ({ page, context, api }, info) => {
            const modelRequests: string[] = [];
            page.on("request", request => {
                if (request.method() === "POST" && /\/api\/(?:tasks(?:\/|$)|chat\/responses|image-agent\/)/.test(new URL(request.url()).pathname)) modelRequests.push(request.url());
            });
            await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(info.project.use.baseURL!).origin });
            await page.addInitScript(fallback => {
                // Preserve the actual browser API only for inspection and negative-case text.
                // The app's fallback has no navigator.clipboard, but execCommand is untouched.
                Object.defineProperty(window, "__nativeClipboard", { value: navigator.clipboard });
                if (fallback) Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
            }, mode === "http-fallback");

            let composer: Locator, copies: Locator, attachments: Locator;
            if (surface === "chat") {
                await page.route("**/api/models", route => route.fulfill({ json: {
                    models: [{ id: "clipboard-chat", modelId: "gpt-6-astra", name: "隔离对话模型", capabilities: ["chat", "vision"] }, { id: "clipboard-image", modelId: "gpt-image-2", name: "隔离出图模型", capabilities: ["generate", "edit"] }],
                    prices: [], tools: [{ toolKey: "gpt-chat", modelConfigId: "clipboard-chat", enabled: true }, { toolKey: "gpt-chat-image", modelConfigId: "clipboard-image", enabled: true }],
                } }));
                await page.goto("/chat");
                composer = page.getByRole("textbox", { name: "对话内容", exact: true });
                await expect(composer).toBeEnabled();
                await page.evaluate(async dataUrls => {
                    const { chatSessionStorage } = await import("/src/pages/chat/chat-session-storage.ts");
                    const { useUserStore } = await import("/src/stores/use-user-store.ts");
                    await chatSessionStorage.save(`wireless-canvas:llm-chat:${useUserStore.getState().user!.id}`, [{ id: "clipboard-session", title: "合成原图复制验收", updatedAt: "2026-01-01", messages: [
                        { id: "clipboard-result", role: "assistant", content: "两张合成测试图", generatedImages: dataUrls.map((dataUrl, index) => ({ id: `original-${index}`, dataUrl })), createdAt: "2026-01-01" },
                    ] }]);
                }, originals.map(bytes => `data:image/png;base64,${bytes.toString("base64")}`));
                await page.reload();
                copies = page.locator('[data-message-id="clipboard-result"]').getByRole("button", { name: /^复制图片 · 图\d+$/ });
                attachments = page.getByRole("button", { name: /^移除 / }).locator("..").locator("img");
            } else {
                await page.route("**/__clipboard-canvas", route => route.fulfill({ contentType: "text/html", body: fixture }));
                for (const [index, id] of ["A", "B"].entries()) await page.route(`**/clipboard-${id}.png`, route => route.fulfill({ contentType: "image/png", body: originals[index] }));
                await page.goto("/__clipboard-canvas");
                composer = page.getByRole("textbox", { name: "画布对话输入", exact: true });
                copies = page.getByRole("button", { name: "复制图片", exact: true });
                attachments = page.getByTestId("accepted-composer").locator("img");
            }

            await expect(composer).toBeEnabled();
            await expect(copies).toHaveCount(2);
            await composer.fill(initialPrompt);
            const copiedTokens: string[] = [];
            const clipboardTypes: string[][] = [];
            for (const index of [0, 1]) {
                const previousClipboardText = (await nativeClipboard(page)).text;
                if (surface === "canvas-components") await page.getByTestId("canvas-agent-image-result").nth(index).hover();
                await copies.nth(index).click();
                const successText = mode === "native" ? "图片已复制，可粘贴到对话输入框" : "图片已复制，可在本页面的对话输入框粘贴（当前地址不支持复制到其他应用）";
                await expect(page.getByText(successText, { exact: true }).last()).toBeVisible();
                // A previous toast can still be visible. Observe completion of this
                // real OS write, not the earlier copy, before issuing native paste.
                const clipboard = await nativeClipboard(page, ({ text }) => /^trucreate-image:v1:[0-9a-f-]{36}$/i.test(text) && text !== previousClipboardText);
                expect(clipboard.text).toMatch(/^trucreate-image:v1:[0-9a-f-]{36}$/i);
                expect(clipboard.types).toContain("text/plain");
                if (mode === "native") expect(clipboard.types).toContain("image/png");
                else expect(clipboard.types).not.toContain("image/png");
                copiedTokens.push(clipboard.text); clipboardTypes.push(clipboard.types);
                await pasteNative(page, composer);
                await expect(attachments).toHaveCount(index + 1);
                expect(await imageHashes(attachments)).toEqual(expectedHashes.slice(0, index + 1));
                await expect(composer).toHaveValue(initialPrompt + (index ? extraText : ""));
                if (!index) {
                    await writeNativeText(page, extraText);
                    await pasteNative(page, composer);
                    await expect(composer).toHaveValue(initialPrompt + extraText);
                    await expect(attachments).toHaveCount(1);
                }
            }

            expect(copiedTokens[0]).not.toBe(copiedTokens[1]);
            await writeNativeText(page, copiedTokens[0]);
            await pasteNative(page, composer);
            await expect(page.getByText("复制的图片已失效，请重新复制", { exact: true })).toBeVisible();
            await expect(attachments).toHaveCount(2);
            expect(await imageHashes(attachments)).toEqual(expectedHashes);
            await expect(composer).toHaveValue(initialPrompt + extraText);
            expect(await composer.inputValue()).not.toContain("trucreate-image:");
            expect(api.submissions).toHaveLength(0);
            expect(modelRequests).toEqual([]);
            if (surface === "canvas-components") await expect(page.getByTestId("submit-count")).toHaveText("0");
            await page.screenshot({ path: info.outputPath(`${surface}-${mode}.png`) });
            await info.attach("clipboard-proof.json", { contentType: "application/json", body: Buffer.from(JSON.stringify({ surface, mode, originalSha256: expectedHashes, pastedSha256: await imageHashes(attachments), clipboardTypes, originalTextPreserved: true, ordinaryTextPaste: true, staleTokenRejected: true, modelPostCount: modelRequests.length, limitation: surface === "canvas-components" ? "Real Canvas UI components and handler; full Canvas persistence is outside this fixture" : "Full standalone Chat page; fixture seed and no model generation" }, null, 2)) });
        });
    }
}

test("native clipboard observation tolerates one invalidated item without another write", async ({ page, context }, info) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(info.project.use.baseURL!).origin });
    await page.route("**/__clipboard-observer", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Clipboard observation fixture</title>" }));
    await page.goto("/__clipboard-observer");
    const text = "隔离剪贴板读取：不重复复制";
    await page.evaluate(async value => {
        await navigator.clipboard.writeText(value);
        let reads = 0;
        // Fault only the test's observer. The app/browser clipboard API is intact.
        Object.defineProperty(window, "__nativeClipboard", { configurable: true, value: {
            async read() {
                reads++;
                const items = await navigator.clipboard.read();
                if (reads === 1) return [{ types: ["text/plain"], getType: async () => { throw new DOMException("Failed to execute 'getType' on 'ClipboardItem': Clipboard data has changed", "InvalidStateError"); } }];
                return items;
            },
        } });
        Object.defineProperty(window, "__clipboardObserverReads", { get: () => reads });
    }, text);
    expect((await nativeClipboard(page)).text).toBe(text);
    expect(await page.evaluate(() => (window as Window & { __clipboardObserverReads: number }).__clipboardObserverReads)).toBe(2);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);

    await page.evaluate(() => Object.defineProperty(window, "__nativeClipboard", { value: {
        async read() { throw new DOMException("Clipboard read denied", "NotAllowedError"); },
    } }));
    await expect(nativeClipboard(page)).rejects.toThrow("NotAllowedError: Clipboard read denied");
});
