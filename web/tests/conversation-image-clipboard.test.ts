import { describe, expect, test } from "bun:test";
import { displayHooksHarness } from "./helpers/display-hooks-harness";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { pastedImageFiles } from "@/lib/clipboard-images";
import { prepareCanvasImageFormat } from "@/lib/canvas/canvas-image-encoding";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

type ClipboardModule = typeof import("@/lib/conversation-image-clipboard");
type CanvasClipboardModule = typeof import("@/lib/canvas/canvas-image-clipboard");
type ImageToolsModule = typeof import("@/hooks/use-conversation-image-tools");
const png = new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABAQMAAADO7O3JAAAAA1BMVEX/AAAZ4gk3AAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==", "base64")], { type: "image/png" });
const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 8, 9, 0xff, 0xd9])], { type: "image/jpeg" });
const prefix = "trucreate-image:v1:";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
function data(text = "", files: File[] = [], items: Array<{ kind: string; type: string; getAsFile(): File | null }> = []) {
    return { files, items, getData: (type: string) => type === "text/plain" ? text : "" } as unknown as Pick<DataTransfer, "files" | "items" | "getData">;
}
function image(id = "image-a", metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x: 1, y: 2 }, width: 300, height: 200,
        metadata: { storageKey: `stored:${id}`, content: "blob:thumbnail-must-not-be-copied", originalFileName: "original.png", ...metadata } };
}

// Execute the actual modules with only browser/storage boundaries replaced. Each test gets
// its own module state; no process-global mock.module, network, or OS clipboard is involved.
function moduleWith<T>(path: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
    const source = readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const output = { exports: {} };
    const require = (name: string) => {
        if (name === "@/hooks/use-display-text") return displayHooksHarness;
        if (!(name in modules)) throw new Error(`Unexpected dependency: ${name}`);
        return modules[name];
    };
    new Function("require", "module", "exports", ...Object.keys(globals), code)(require, output, output.exports, ...Object.values(globals));
    return output.exports as T;
}

function harness(options: {
    original?: Blob;
    stored?: () => Promise<Blob | null>;
    resolve?: (key?: string, content?: string) => Promise<string>;
    fetch?: (source: string, init?: RequestInit) => Promise<Response>;
    native?: "success" | "denied";
    textCopy?: boolean;
} = {}) {
    let state = { status: "authenticated", user: { id: "owner-a", status: "active" } };
    const listeners: Array<() => void> = [];
    const store = Object.assign((select: (value: typeof state) => unknown) => select(state), {
        getState: () => state,
        subscribe: (listener: () => void) => { listeners.push(listener); return () => {}; },
    });
    const textCopies: Array<{ token: string; options: unknown }> = [];
    const nativeWrites: Array<Array<{ entries: Record<string, Blob | Promise<Blob>> }>> = [];
    const storedKeys: string[] = [];
    const resolutions: Array<[string | undefined, string | undefined]> = [];
    const fetched: Array<{ source: string; signal: AbortSignal | null | undefined }> = [];
    const formats: string[] = [];
    let nextId = 0;
    const navigator = options.native ? { clipboard: { write: async (items: typeof nativeWrites[number]) => {
        nativeWrites.push(items);
        if (options.native === "denied") throw new DOMException("Clipboard denied", "NotAllowedError");
        await Promise.all(items.flatMap(item => Object.values(item.entries)));
    } } } : {};
    const globals = {
        navigator,
        ClipboardItem: options.native ? class { constructor(readonly entries: Record<string, Blob | Promise<Blob>>) {} } : undefined,
        fetch: async (source: string, init?: RequestInit) => {
            fetched.push({ source, signal: init?.signal });
            return options.fetch ? options.fetch(source, init) : new Response(options.original || png);
        },
    };
    const canvas = moduleWith<CanvasClipboardModule>("lib/canvas/canvas-image-clipboard.ts", {
        "@/services/image-storage": {
            getImageBlob: async (key: string) => { storedKeys.push(key); return options.stored ? options.stored() : options.original || png; },
            resolveImageUrl: async (key?: string, content?: string) => { resolutions.push([key, content]); return options.resolve ? options.resolve(key, content) : content || ""; },
        },
        "./canvas-image-encoding": { prepareCanvasImageFormat: async (blob: Blob, format: "original" | "png" | "jpg", _encode: unknown, task: { signal?: AbortSignal }) => {
            formats.push(format);
            return prepareCanvasImageFormat(blob, format, async () => png, task);
        } },
    }, globals);
    const clipboard = moduleWith<ClipboardModule>("lib/conversation-image-clipboard.ts", {
        "copy-to-clipboard": (token: string, copyOptions: unknown) => { textCopies.push({ token, options: copyOptions }); return options.textCopy !== false; },
        "@/stores/use-user-store": { useUserStore: store },
        "./client-uuid": { createClientUuid: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}` },
        "./clipboard-images": { pastedImageFiles },
        "./canvas/canvas-image-clipboard": canvas,
    }, globals);
    return {
        ...clipboard, canvas, store, textCopies, nativeWrites, storedKeys, resolutions, fetched, formats,
        token: () => textCopies.at(-1)!.token,
        setIdentity: (id: string, status = "authenticated", userStatus = "active") => {
            state = { status, user: { id, status: userStatus } }; listeners.forEach(listener => listener());
        },
    };
}

describe("conversation image clipboard original and HTTP contract", () => {
    test("HTTP writes one opaque token synchronously and returns the exact original bytes/name/type", async () => {
        const pending = deferred<Blob | null>();
        const h = harness({ stored: () => pending.promise });
        const copy = h.copyConversationImage(image());
        expect(h.textCopies).toHaveLength(1);
        expect(h.token()).toMatch(/^trucreate-image:v1:[0-9a-f-]{36}$/);
        expect(h.textCopies[0].options).toEqual({ format: "text/plain", fallbackToPrompt: false });
        expect(h.storedKeys).toEqual([]); // Copy activation precedes asynchronous image reading.
        pending.resolve(png);
        expect(await copy).toBe("page");
        const files = await h.pastedConversationImageFiles(data(h.token()));
        expect(files).toHaveLength(1);
        expect(files![0].name).toBe("original.png");
        expect(files![0].type).toBe("image/png");
        expect(await files![0].arrayBuffer()).toEqual(await png.arrayBuffer());
        expect(h.formats).toEqual(["original"]);
        expect(h.fetched).toEqual([]);
    });

    test("native image copy may convert the OS payload but same-page paste retains JPEG bytes", async () => {
        const h = harness({ native: "success", original: jpeg });
        expect(await h.copyConversationImage(image("jpeg", { originalFileName: "source.jpg" }))).toBe("system");
        expect(h.nativeWrites).toHaveLength(1);
        expect(h.textCopies).toEqual([]);
        const entries = h.nativeWrites[0][0].entries;
        expect((await entries["image/png"]).type).toBe("image/png");
        const token = await (await entries["text/plain"]).text();
        const files = await h.pastedConversationImageFiles(data(token, [new File([png], "OS.png", { type: "image/png" })]));
        expect(files![0].name).toBe("source.jpg");
        expect(files![0].type).toBe("image/jpeg");
        expect(await files![0].arrayBuffer()).toEqual(await jpeg.arrayBuffer());
    });

    test("a denied native write falls back honestly to page mode, not system success", async () => {
        const h = harness({ native: "denied" });
        expect(await h.copyConversationImage(image())).toBe("page");
        expect(h.nativeWrites).toHaveLength(1);
        expect(h.textCopies).toHaveLength(1);
        expect(await h.pastedConversationImageFiles(data(h.token()))).toHaveLength(1);
    });

    test("a failed HTTP token write rejects and never leaves a reusable in-memory original", async () => {
        const h = harness({ textCopy: false });
        await expect(h.copyConversationImage(image())).rejects.toThrow("图片复制失败");
        await expect(h.pastedConversationImageFiles(data(h.token()))!).rejects.toThrow("已失效");
    });

    test("ordinary text, URL, empty clipboard, and malformed tokens never import a remembered image", async () => {
        const h = harness();
        await h.copyConversationImage(image());
        for (const text of ["", "保留选中文本和光标", "https://example.invalid/image.png", `${prefix}not-a-uuid`, `${h.token()} trailing`]) {
            expect(h.pastedConversationImageFiles(data(text))).toBeNull();
        }
    });

    test("external image files and items remain usable without an app token and are not duplicated", async () => {
        const h = harness();
        await h.copyConversationImage(image());
        const external = new File([jpeg], "external.jpg", { type: "image/jpeg" });
        const item = { kind: "file", type: external.type, getAsFile: () => external };
        expect(await h.pastedConversationImageFiles(data("other text", [external], [item]))).toEqual([external]);
        expect(await h.pastedConversationImageFiles(data("", [], [item]))).toEqual([external]);
        expect(h.pastedConversationImageFiles(data("", [new File(["text"], "note.txt", { type: "text/plain" })]))).toBeNull();
    });

    test("foreign/stale well-formed tokens reject even if an OS PNG accompanies them", async () => {
        const h = harness();
        await h.copyConversationImage(image());
        const foreign = `${prefix}00000000-0000-4000-8000-999999999999`;
        await expect(h.pastedConversationImageFiles(data(foreign, [new File([png], "old-os.png", { type: "image/png" })]))!).rejects.toThrow("已失效");
    });

    test("a stored original missing from storage cannot fall back to a stale thumbnail", async () => {
        const h = harness({ stored: async () => null });
        await expect(h.copyConversationImage(image())).rejects.toThrow("原图暂时无法读取");
        expect(h.resolutions).toEqual([["stored:image-a", ""]]);
        expect(h.fetched).toEqual([]);
        await expect(h.pastedConversationImageFiles(data(h.token()))!).rejects.toThrow("已失效");
    });

    test("URL-only originals are fetched with a cancellation signal and copied losslessly", async () => {
        const h = harness();
        await h.copyConversationImage(image("url", { storageKey: undefined, content: "https://example.invalid/original.png" }));
        expect(h.storedKeys).toEqual([]);
        expect(h.resolutions).toEqual([[undefined, "https://example.invalid/original.png"]]);
        expect(h.fetched[0].source).toBe("https://example.invalid/original.png");
        expect(h.fetched[0].signal).toBeInstanceOf(AbortSignal);
        expect(await (await h.pastedConversationImageFiles(data(h.token())))![0].arrayBuffer()).toEqual(await png.arrayBuffer());
    });

    test("HTTP failures, error documents, and oversize originals invalidate the token", async () => {
        const cases = [
            harness({ fetch: async () => new Response("denied", { status: 403 }) }),
            harness({ original: new Blob(['{"error":"not an image"}'], { type: "image/png" }) }),
            harness({ original: new Blob([png, new Uint8Array(20 * 1024 * 1024)], { type: "image/png" }) }),
        ];
        for (const [index, h] of cases.entries()) {
            await expect(h.copyConversationImage(image("bad", index === 0 ? { storageKey: undefined, content: "https://example.invalid/fail" } : {}))).rejects.toBeInstanceOf(Error);
            await expect(h.pastedConversationImageFiles(data(h.token()))!).rejects.toThrow("已失效");
        }
    });

    test("the shared clipboard accepts exactly 20 MiB and rejects one byte more without truncating", async () => {
        const limit = 20 * 1024 * 1024;
        const exact = new Blob([png, new Uint8Array(limit - png.size)], { type: "image/png" });
        const h = harness({ original: exact });
        await h.copyConversationImage(image());
        const file = (await h.pastedConversationImageFiles(data(h.token())))![0];
        expect(file.size).toBe(limit);
        expect(await file.arrayBuffer()).toEqual(await exact.arrayBuffer());
        const oversize = harness({ original: new Blob([exact, "x"], { type: "image/png" }) });
        await expect(oversize.copyConversationImage(image())).rejects.toThrow("20 MB");
        await expect(oversize.pastedConversationImageFiles(data(oversize.token()))!).rejects.toThrow("已失效");
    });
});

describe("conversation image clipboard identity and cancellation boundaries", () => {
    test("identity changes and A-B-A switches cannot revive a previously copied image", async () => {
        const h = harness();
        await h.copyConversationImage(image());
        const old = h.token();
        h.setIdentity("owner-b");
        await expect(h.pastedConversationImageFiles(data(old))!).rejects.toThrow("已失效");
        h.setIdentity("owner-a");
        await expect(h.pastedConversationImageFiles(data(old))!).rejects.toThrow("已失效");
    });

    test("session expiry and user deactivation invalidate cache even if the user id is unchanged", async () => {
        for (const [status, userStatus] of [["expired", "active"], ["authenticated", "disabled"]]) {
            const h = harness();
            await h.copyConversationImage(image());
            const old = h.token();
            h.setIdentity("owner-a", status, userStatus);
            await expect(h.pastedConversationImageFiles(data(old))!).rejects.toThrow("已失效");
            await expect(h.copyConversationImage(image())).rejects.toThrow("已失效");
            h.setIdentity("owner-a");
            await expect(h.pastedConversationImageFiles(data(old))!).rejects.toThrow("已失效");
        }
    });

    test("an identity change while storage is pending cancels both copy and pending paste", async () => {
        const original = deferred<Blob | null>();
        const h = harness({ stored: () => original.promise });
        const copy = h.copyConversationImage(image()); void copy.catch(() => {});
        const paste = h.pastedConversationImageFiles(data(h.token()))!; void paste.catch(() => {});
        await settle();
        h.setIdentity("owner-b");
        original.resolve(png);
        await expect(copy).rejects.toBeInstanceOf(Error);
        await expect(paste).rejects.toBeInstanceOf(Error);
        expect(h.formats).toEqual([]);
    });

    test("cancellation before copying does not touch clipboard; cancellation during load invalidates its token", async () => {
        const h = harness();
        const before = new AbortController(); before.abort();
        await expect(h.copyConversationImage(image(), before.signal)).rejects.toMatchObject({ name: "AbortError" });
        expect(h.textCopies).toEqual([]);
        const original = deferred<Blob | null>();
        const pending = harness({ stored: () => original.promise });
        const controller = new AbortController();
        const copy = pending.copyConversationImage(image(), controller.signal); void copy.catch(() => {});
        await settle(); controller.abort(); original.resolve(png);
        await expect(copy).rejects.toMatchObject({ name: "AbortError" });
        await expect(pending.pastedConversationImageFiles(data(pending.token()))!).rejects.toThrow("已失效");
    });

    test("a later copy supersedes an unfinished earlier copy without leaking its original", async () => {
        const first = deferred<Blob | null>();
        let reads = 0;
        const h = harness({ stored: () => ++reads === 1 ? first.promise : Promise.resolve(jpeg) });
        const a = h.copyConversationImage(image("a")); void a.catch(() => {});
        const aToken = h.token(); await settle();
        await h.copyConversationImage(image("b", { originalFileName: "b.jpg" }));
        const bToken = h.token();
        first.resolve(png);
        await expect(a).rejects.toBeInstanceOf(Error);
        await expect(h.pastedConversationImageFiles(data(aToken))!).rejects.toThrow("已失效");
        const files = await h.pastedConversationImageFiles(data(bToken));
        expect(files![0].name).toBe("b.jpg");
        expect(await files![0].arrayBuffer()).toEqual(await jpeg.arrayBuffer());
    });

    test("a token from another page/module instance cannot access a remembered image", async () => {
        const pageA = harness(), pageB = harness();
        await pageA.copyConversationImage(image());
        await expect(pageB.pastedConversationImageFiles(data(pageA.token()))!).rejects.toThrow("已失效");
        expect(pageB.storedKeys).toEqual([]);
        expect(pageB.fetched).toEqual([]);
    });

    test("identity revocation between paste dispatch and microtask resolution cannot deliver cached bytes", async () => {
        const h = harness();
        await h.copyConversationImage(image());
        const pending = h.pastedConversationImageFiles(data(h.token()))!; void pending.catch(() => {});
        h.setIdentity("owner-b");
        await expect(pending).rejects.toThrow("已失效");
    });

    test("a new failed copy invalidates both its token and the previous successful image", async () => {
        let reads = 0;
        const h = harness({ stored: async () => ++reads === 1 ? png : new Blob(['{"error":"bad"}'], { type: "image/png" }) });
        await h.copyConversationImage(image("good"));
        const good = h.token();
        await expect(h.copyConversationImage(image("bad"))).rejects.toThrow("不是图片");
        for (const token of [good, h.token()]) await expect(h.pastedConversationImageFiles(data(token))!).rejects.toThrow("已失效");
    });

    test("copy/paste does not mutate selection, region, prompt, or batch task metadata", async () => {
        const node = image("result", { prompt: "original prompt", batchId: "batch-a", sourceNodeId: "selected-region", status: "success" } as CanvasNodeData["metadata"]);
        const snapshot = structuredClone(node);
        const h = harness();
        await h.copyConversationImage(node);
        await h.pastedConversationImageFiles(data(h.token()));
        expect(node).toEqual(snapshot);
        expect(h.storedKeys).toEqual(["stored:result"]);
        expect(h.fetched).toEqual([]);
    });
});

function callbackSource(path: string, kind: "chat" | "canvas") {
    const source = readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback: ts.Node | undefined;
    function visit(node: ts.Node) {
        if (kind === "chat" && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "pasteAttachments") callback = node.initializer;
        if (kind === "canvas" && ts.isJsxAttribute(node) && node.name.getText(ast) === "onPaste" && node.initializer && ts.isJsxExpression(node.initializer)) callback = node.initializer.expression;
        ts.forEachChild(node, visit);
    }
    visit(ast);
    if (!callback) throw new Error(`Paste callback missing: ${path}`);
    return ts.transpileModule(`const paste = ${callback.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
}
const pasteSources = {
    chat: callbackSource("pages/chat/index.tsx", "chat"),
    canvas: callbackSource("components/canvas/canvas-agent-chat-ui.tsx", "canvas"),
};

function composer(h: ReturnType<typeof harness>, kind: "chat" | "canvas", blocked = false) {
    const attachments: File[][] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const env = {
        pastedConversationImageFiles: h.pastedConversationImageFiles,
        displayNotice: displayHooksHarness.displayNotice,
        message: { error: (value: string) => errors.push(value), warning: (value: string) => warnings.push(value) },
        t: (value: string) => value, uiText: (value: string) => value,
        editing: null, sendingRef: { current: blocked }, attachmentReadRef: { current: false }, readingAttachments: false,
        addFiles: (files: File[]) => { attachments.push(files); },
        onAddFiles: (files: File[]) => { attachments.push(files); }, sending: blocked, disabled: false,
    };
    const paste = new Function("env", `const { ${Object.keys(env).join(",")} } = env; ${pasteSources[kind]}; return paste;`)(env);
    return { attachments, errors, warnings, paste: (transfer: ReturnType<typeof data>) => {
        const event = { clipboardData: transfer, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        paste(event); return event;
    } };
}

describe("real Chat and Canvas composer paste glue", () => {
    for (const kind of ["chat", "canvas"] as const) {
        test(`${kind}: ordinary text preserves native selection/caret behavior after an image copy`, async () => {
            const h = harness(); await h.copyConversationImage(image());
            const input = composer(h, kind);
            expect(input.paste(data("replace only selected text")).defaultPrevented).toBe(false);
            await settle();
            expect(input.attachments).toEqual([]);
            expect(input.errors).toEqual([]);
        });
        test(`${kind}: a valid HTTP token is consumed and only the original enters attachments`, async () => {
            const h = harness(); await h.copyConversationImage(image());
            const input = composer(h, kind);
            expect(input.paste(data(h.token())).defaultPrevented).toBe(true);
            await settle();
            expect(input.attachments).toHaveLength(1);
            expect(await input.attachments[0][0].arrayBuffer()).toEqual(await png.arrayBuffer());
            expect(input.errors).toEqual([]);
        });
        test(`${kind}: a revoked token is consumed with an error instead of importing a previous image`, async () => {
            const h = harness(); await h.copyConversationImage(image());
            const old = h.token(); h.setIdentity("owner-b");
            const input = composer(h, kind);
            expect(input.paste(data(old)).defaultPrevented).toBe(true);
            await settle();
            expect(input.attachments).toEqual([]);
            expect(input.errors).toEqual(["复制的图片已失效，请重新复制"]);
        });
        test(`${kind}: sending does not import a copied image or allow opaque token text into the prompt`, async () => {
            const h = harness(); await h.copyConversationImage(image());
            const input = composer(h, kind, true);
            expect(input.paste(data(h.token())).defaultPrevented).toBe(true);
            await settle();
            expect(input.attachments).toEqual([]);
        });
    }
});

function imageTools(h: ReturnType<typeof harness>) {
    const successes: string[] = [];
    const errors: string[] = [];
    const cleanups: Array<() => void> = [];
    const hook = moduleWith<ImageToolsModule>("hooks/use-conversation-image-tools.tsx", {
        "react": {
            lazy: () => null, Suspense: null,
            useCallback: (callback: unknown) => callback,
            useEffect: (effect: () => void | (() => void)) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); },
            useRef: (current: unknown) => ({ current }),
            useState: (value: unknown) => [value, () => {}],
        },
        "react/jsx-runtime": { jsx: () => null },
        "antd": { App: { useApp: () => ({ message: { success: (text: string) => successes.push(text), error: (text: string) => errors.push(text), info: () => {} } }) } },
        "@/lib/canvas/canvas-export-loader": { loadCanvasExport: () => { throw new Error("Copy must not download or generate"); } },
        "@/lib/conversation-image-clipboard": { copyConversationImage: h.copyConversationImage },
        "@/lib/i18n": { uiText: (value: string) => value, useUiText: () => (value: string) => value },
        "@/stores/use-user-store": { useUserStore: h.store },
        "@/types/canvas": { CanvasNodeType },
    });
    // biome-ignore lint/correctness/useHookAtTopLevel: Execute the actual hook with the isolated React boundary supplied above.
    return { ...hook.useConversationImageTools(), successes, errors, unmount: () => cleanups.forEach(cleanup => cleanup()) };
}
const conversationImage = { id: "result-a", label: "图2", name: "result-original.png", dataUrl: "blob:preview", storageKey: "stored:result-a" };

describe("conversation image tools lifecycle and honest result feedback", () => {
    test("HTTP success explicitly limits pasting to this page and names the real original", async () => {
        const h = harness(); const tools = imageTools(h);
        await tools.copy(conversationImage);
        expect(tools.successes).toEqual(["图片已复制，可在本页面的对话输入框粘贴（当前地址不支持复制到其他应用）"]);
        expect(tools.errors).toEqual([]);
        expect((await h.pastedConversationImageFiles(data(h.token())))![0].name).toBe("result-original.png");
        expect(h.storedKeys).toEqual(["stored:result-a"]);
    });

    test("native clipboard success is distinct from the HTTP fallback message", async () => {
        const h = harness({ native: "success" }); const tools = imageTools(h);
        await tools.copy(conversationImage);
        expect(tools.successes).toEqual(["图片已复制，可粘贴到对话输入框"]);
        expect(tools.errors).toEqual([]);
    });

    test("repeated clicks on the same unfinished image do not duplicate storage reads or token writes", async () => {
        const original = deferred<Blob | null>();
        const h = harness({ stored: () => original.promise }); const tools = imageTools(h);
        const first = tools.copy(conversationImage);
        await tools.copy(conversationImage);
        await settle();
        expect(h.textCopies).toHaveLength(1);
        expect(h.storedKeys).toHaveLength(1);
        original.resolve(png); await first;
        expect(tools.successes).toHaveLength(1);
    });

    test("unmount during original loading cancels copy and suppresses late success/error feedback", async () => {
        const original = deferred<Blob | null>();
        const h = harness({ stored: () => original.promise }); const tools = imageTools(h);
        const copying = tools.copy(conversationImage);
        await settle(); tools.unmount(); original.resolve(png); await copying;
        expect(tools.successes).toEqual([]);
        expect(tools.errors).toEqual([]);
        await expect(h.pastedConversationImageFiles(data(h.token()))!).rejects.toThrow("已失效");
    });

    test("an owner change while copying cannot publish success or attach old bytes to the new account", async () => {
        const original = deferred<Blob | null>();
        const h = harness({ stored: () => original.promise }); const tools = imageTools(h);
        const copying = tools.copy(conversationImage);
        await settle(); h.setIdentity("owner-b"); original.resolve(png); await copying;
        expect(tools.successes).toEqual([]);
        expect(tools.errors).toEqual([]);
        await expect(h.pastedConversationImageFiles(data(h.token()))!).rejects.toThrow("已失效");
    });

    test("unavailable originals fail without writing, downloading, generating, or claiming success", async () => {
        const h = harness(); const tools = imageTools(h);
        await tools.copy({ ...conversationImage, unavailableReason: "原图已移除" });
        expect(tools.successes).toEqual([]);
        expect(tools.errors).toEqual(["原图已移除"]);
        expect(h.textCopies).toEqual([]);
        expect(h.storedKeys).toEqual([]);
        expect(h.nativeWrites).toEqual([]);
    });

    test("a failed copy clears the hook's busy key so a later user retry is allowed", async () => {
        let reads = 0;
        const h = harness({ stored: async () => ++reads === 1 ? new Blob() : png }); const tools = imageTools(h);
        await tools.copy(conversationImage);
        expect(tools.successes).toEqual([]);
        expect(tools.errors).toHaveLength(1);
        await tools.copy(conversationImage);
        expect(h.textCopies).toHaveLength(2);
        expect(tools.successes).toHaveLength(1);
    });
});
