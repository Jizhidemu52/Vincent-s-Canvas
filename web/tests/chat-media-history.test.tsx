import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "@/pages/chat/chat-markdown";
import { createChatMedia } from "@/pages/chat/chat-media";
import { createChatIndexedHistory } from "@/pages/chat/chat-indexed-history";
import { createChatBranch } from "@/pages/chat/chat-message-actions";
import { beginChatImageWrite, chatImageCleanupGuard, collectChatImageReferences } from "@/services/chat-history-references";
import type { ChatSession } from "@/pages/chat/chat-types";

function memoryStore() {
    const values = new Map<string, unknown>(), reads: string[] = [], writes: string[] = [];
    return { values, reads, writes,
        async getItem<T>(key: string) { reads.push(key); return structuredClone(values.get(key) ?? null) as T | null; },
        async setItem<T>(key: string, value: T) { writes.push(key); values.set(key, structuredClone(value)); return value; },
        async iterate<T, U>(visit: (value: T, key: string, index: number) => U) { let result: U; let index = 0; for (const [key, value] of values) result = visit(value as T, key, index++); return result!; },
    };
}
const key = "wireless-canvas:llm-chat:owner-a";
const session = (id: string): ChatSession => ({ id, title: id, updatedAt: "2026-01-01", messages: [{ id: `${id}-user`, role: "user", content: "保留原图", createdAt: "2026-01-01", attachments: [{ id: `${id}-image`, kind: "image", name: "原图.png", size: 3, mimeType: "image/png", dataUrl: `data:image/png;base64,${id}` }] }] });

test("legacy history stays byte-for-byte intact while only the opened conversation migrates", async () => {
    const store = memoryStore(), old = [session("a"), session("b")]; store.values.set(key, structuredClone(old));
    const serialized: string[] = [];
    const history = createChatIndexedHistory<ChatSession>(store, async (value) => { serialized.push(value.id); return { ...value, messages: value.messages.map((message) => ({ ...message, attachments: message.attachments?.map((image) => ({ ...image, dataUrl: "", storageKey: `image:${image.id}` })) })) }; });
    const loaded = await history.load(key, () => null);
    await history.save(key, loaded);
    expect(serialized).toEqual([]);
    expect(store.writes).toEqual([`${key}:index:v2`]);
    const changed = [{ ...loaded[0]!, title: "读取并迁移 A" }, loaded[1]!];
    await history.save(key, changed);
    expect(serialized).toEqual(["a"]);
    expect(store.values.get(key)).toEqual(old);
    const aRecord = store.values.get(`${key}:session:a`);
    expect(JSON.stringify(aRecord)).not.toContain("base64");
    expect(store.values.has(`${key}:session:b`)).toBe(false);
    store.reads.length = 0; store.writes.length = 0;
    await history.save(key, [{ ...changed[0]!, title: "只改标题" }, changed[1]!]);
    expect(store.reads).toEqual([]);
    expect(store.writes).toEqual([`${key}:session:a`, `${key}:index:v2`]);
    const fresh = await createChatIndexedHistory(store, async (value: ChatSession) => value).load(key, () => null);
    expect(fresh[0]!.messages[0]!.attachments![0]).toMatchObject({ dataUrl: "", storageKey: "image:a-image" });
    expect(fresh[1]).toEqual(old[1]);
});

test("history read or media write failures do not replace legacy data or publish a new index", async () => {
    const store = memoryStore(), old = [session("a")]; store.values.set(key, old);
    const history = createChatIndexedHistory<ChatSession>(store, async () => { throw new Error("quota"); });
    const loaded = await history.load(key, () => null);
    await expect(history.save(key, [{ ...loaded[0]!, title: "unsaved" }])).rejects.toThrow("quota");
    expect(store.values.get(key)).toEqual(old); expect(store.writes).toEqual([]);
    store.values.set(`${key}:index:v2`, { version: 2, sessions: [{ id: "a", recordKey: "other-owner:session:a" }] });
    await expect(history.load(key, () => null)).rejects.toThrow("索引无效");
});

test("same session identifiers under different owners cannot overwrite each other's records", async () => {
    const store = memoryStore(), history = createChatIndexedHistory(store, async (value: ChatSession) => value);
    await Promise.all([history.save(key, [session("same")]), history.save(`${key}-b`, [{ ...session("same"), title: "owner-b" }])]);
    expect((await history.load(key, () => null))[0]!.title).toBe("same");
    expect((await history.load(`${key}-b`, () => null))[0]!.title).toBe("owner-b");
});

test("concurrent history snapshots settle in order and a later retry survives a failed write", async () => {
    const store = memoryStore(), gate = Promise.withResolvers<void>(); let first = true;
    const history = createChatIndexedHistory(store, async (value: ChatSession) => { if (first) { first = false; await gate.promise; throw new Error("interrupted"); } return value; });
    const older = history.save(key, [session("a")]).catch((error: Error) => error.message);
    const newer = history.save(key, [{ ...session("a"), title: "newer" }]); gate.resolve(); expect(await older).toBe("interrupted"); await newer;
    expect((await history.load(key, () => null))[0]!.title).toBe("newer");
});

test("media stores original sources once across branches, strips only transient URLs, and hydrates on demand", async () => {
    const uploads: Array<string | Blob> = [], resolutions: string[] = [];
    const media = createChatMedia({ upload: async (input) => { uploads.push(input); return { storageKey: "image:fixture", url: "blob:fixture", width: 2, height: 3, bytes: 3, mimeType: "image/png" }; }, resolve: async (key) => { resolutions.push(key!); return "blob:fresh"; } });
    const original = session("a"), before = structuredClone(original);
    const [one, two] = await Promise.all([media.serializeSession(original), media.serializeSession({ ...original, id: "branch" })]);
    expect(uploads).toEqual([original.messages[0]!.attachments![0]!.dataUrl!]);
    expect(original).toEqual(before);
    expect(one.messages[0]!.attachments![0]).toMatchObject({ dataUrl: "", storageKey: "image:fixture", size: 3, name: "原图.png", mimeType: "image/png" });
    expect(two.messages[0]!.attachments![0]!.storageKey).toBe("image:fixture");
    await media.serializeSession(one); expect(uploads).toHaveLength(1); expect(resolutions).toEqual([]);
    const hydrated = await media.hydrateSession(one, () => {});
    expect(hydrated.messages[0]!.attachments![0]!.dataUrl).toBe("blob:fresh");
    expect(resolutions).toEqual(["image:fixture"]);
});

test("a late image save after an owner switch cannot return usable data to the new session", async () => {
    const gate = Promise.withResolvers<void>(); let current = true;
    const media = createChatMedia({ upload: async () => { await gate.promise; return { storageKey: "image:owner-a", url: "blob:a", width: 1, height: 1, bytes: 3, mimeType: "image/png" }; }, resolve: async () => "blob:a" });
    const writing = media.persist({ dataUrl: "data:image/png;base64,AQID" }, () => { if (!current) throw new Error("owner changed"); });
    current = false; gate.resolve(); await expect(writing).rejects.toThrow("owner changed");
});

test("image GC protects legacy, migrated, and unsent draft references and aborts on unreadable history", async () => {
    const store = memoryStore();
    store.values.set(key, [{ storageKey: "image:legacy" }]); store.values.set(`${key}:session:a`, { messages: [{ attachments: [{ storageKey: "image:record" }] }] });
    store.values.set("unrelated", { storageKey: "image:unrelated" });
    const finish = beginChatImageWrite(); finish("image:unsent");
    const keys = await collectChatImageReferences(store);
    for (const value of ["image:legacy", "image:record", "image:unsent"]) expect(keys.has(value)).toBe(true);
    expect(keys.has("image:unrelated")).toBe(false);
    await expect(collectChatImageReferences({ async iterate() { throw new Error("history read failed"); } })).rejects.toThrow("history read failed");
    const guard = chatImageCleanupGuard(); const done = beginChatImageWrite(); expect(guard).toThrow("跳过"); done(); expect(guard).toThrow("跳过");
    expect(chatImageCleanupGuard()).not.toThrow();
});

test("regeneration and edits branch from the exact original user turn without future messages or canvas linkage", () => {
    const original = session("a"); original.canvasProjectId = "original-canvas";
    original.messages.push({ id: "answer", parentMessageId: "a-user", role: "assistant", content: "answer", createdAt: "now" }, { id: "future", role: "user", content: "future must not enter retry", createdAt: "now" });
    const before = structuredClone(original), branch = createChatBranch(original, "answer", "new", "later");
    expect(original).toEqual(before); expect(branch.source.id).toBe("a-user");
    expect(branch.session.messages).toEqual([]); expect(branch.session.canvasProjectId).toBeUndefined();
    expect(branch.session.branchOf).toEqual({ sessionId: "a", messageId: "a-user" });
    original.messages[1]!.pendingImageTask = { requestId: "uncertain", prompt: "p", modelId: "m", action: "generate" };
    expect(() => createChatBranch(original, "answer", "another", "later")).toThrow("尚未核实");
});

test("Markdown renders headings, emphasis, lists, code, and tables without raw HTML or automatic external images", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{"## 标题\n\n**重点**\n\n- 第一项\n\n```js\nconst a = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n[坏链接](javascript:alert(1))\n\n![图片](https://example.com/remote.png)"}</ChatMarkdown>);
    for (const element of ["<h2>", "<strong>", "<ul>", "<pre>", "<table"]) expect(html).toContain(element);
    expect(html).not.toContain("<script"); expect(html).not.toContain("href=\"javascript:"); expect(html).not.toContain("<img");
    expect(html).toContain("https://example.com/remote.png");
});
