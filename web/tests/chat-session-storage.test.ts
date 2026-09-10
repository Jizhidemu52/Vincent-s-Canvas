import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

import { buildChatRequestMessages, type ChatHistoryMessage } from "@/lib/chat-context";
import { createChatSessionStorage } from "@/pages/chat/chat-session-storage";

function memoryStore() {
    const values = new Map<string, unknown>();
    return {
        values,
        async getItem<T>(key: string) { return structuredClone(values.get(key) ?? null) as T | null; },
        async setItem<T>(key: string, value: T) { values.set(key, structuredClone(value)); return value; },
    };
}

test("a fresh storage reader restores complete image and document attachments for follow-up requests", async () => {
    const database = memoryStore();
    const image = "data:image/png;base64,AQID";
    const sessions = [{ id: "conversation", messages: [
        { role: "user", content: "读取附件", attachments: [{ name: "image.png", dataUrl: image }, { name: "document.pdf", textContent: "CORAL-7193 Quantity: 25" }] },
        { role: "assistant", content: "已读取" },
    ] as ChatHistoryMessage[] }];
    await createChatSessionStorage(database).save("user-a", sessions);
    const restored = await createChatSessionStorage(database).load<typeof sessions[number]>("user-a", () => { throw new Error("IndexedDB data must take priority over old localStorage"); });
    expect(restored).toEqual(sessions);
    const request = buildChatRequestMessages(restored[0]!.messages, { role: "user", content: "继续分析刚才的图片和文件" });
    expect(request[0]!.content).toContainEqual({ type: "image_url", image_url: { url: image } });
    expect(JSON.stringify(request)).toContain("CORAL-7193");
});

test("legacy localStorage snapshots are read without deleting records or inventing missing images", async () => {
    const database = memoryStore();
    const legacy = '[{"id":"old","messages":[{"role":"user","content":"旧记录","attachments":[{"name":"image.png"}]}]}]';
    const restored = await createChatSessionStorage(database).load("user-a", () => legacy);
    expect(restored).toEqual(JSON.parse(legacy));
    expect(database.values.size).toBe(0);
    expect(JSON.stringify(restored)).not.toContain("dataUrl");
});

test("a failed IndexedDB read rejects instead of replacing history with an empty snapshot", async () => {
    const writes: unknown[] = [];
    const storage = createChatSessionStorage({
        async getItem<T>(): Promise<T | null> { throw new Error("database unavailable"); },
        async setItem<T>(_key: string, value: T) { writes.push(value); return value; },
    });
    await expect(storage.load("user-a", () => "[]")).rejects.toThrow("database unavailable");
    expect(writes).toEqual([]);
});

test("per-account writes are ordered, but a different account does not wait for them", async () => {
    const database = memoryStore();
    const firstWrite = Promise.withResolvers<void>();
    const started: string[] = [];
    const storage = createChatSessionStorage({
        getItem: database.getItem,
        async setItem<T>(key: string, value: T) {
            started.push(`${key}:${JSON.stringify(value)}`);
            if (key === "user-a" && started.length === 1) await firstWrite.promise;
            return database.setItem(key, value);
        },
    });
    const older = storage.save("user-a", ["old"]);
    const newer = storage.save("user-a", ["new"]);
    await storage.save("user-b", ["other"]);
    expect(started).toEqual(['user-a:["old"]', 'user-b:["other"]']);
    firstWrite.resolve();
    await Promise.all([older, newer]);
    expect(database.values.get("user-a")).toEqual(["new"]);
    expect(database.values.get("user-b")).toEqual(["other"]);
});

test("failed writes leave the caller's in-memory attachments intact and allow a later retry", async () => {
    const database = memoryStore();
    let shouldFail = true;
    const storage = createChatSessionStorage({
        getItem: database.getItem,
        async setItem<T>(key: string, value: T) {
            if (shouldFail) throw new Error("quota exceeded");
            return database.setItem(key, value);
        },
    });
    const draft = [{ content: "未发送草稿", attachments: [{ name: "image.png", dataUrl: "data:image/png;base64,AQID" }] }];
    const saved = structuredClone(draft);
    await expect(storage.save("user-a", draft)).rejects.toThrow("quota exceeded");
    expect(draft).toEqual(saved);
    shouldFail = false;
    await storage.save("user-a", draft);
    expect(await storage.load("user-a", () => null)).toEqual(saved);
});

function pageSendHarness({ ready = true, failWrite = false } = {}) {
    const source = readFileSync(new URL("../src/pages/chat/index.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("chat.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let initializer: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "send") initializer = node.initializer;
        ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!initializer) throw new Error("The chat page send handler was not found");
    const events: string[] = [];
    const snapshots: unknown[] = [];
    const memory = { draft: "未发送的图片问题", attachments: [{ id: "image", name: "image.png", mimeType: "image/png", size: 3, dataUrl: "data:image/png;base64,AQID" }] };
    const session = { id: "session", mode: "chat", title: "新对话", messages: [] as any[] };
    const sessionsRef = { current: [session] };
    let ids = 0;
    const bindings = {
        sessionsReady: ready, draft: memory.draft, attachments: memory.attachments, isSending: false, readingAttachments: false,
        activeSession: session, selectedModel: "gpt-6-astra", selected: {}, mode: "chat", config: {}, agent: { prompt: "" },
        createClientId: () => `message-${++ids}`, buildChatRequestMessages, sessionsRef,
        preparingMessageRef: { current: false }, loadedStorageKeyRef: { current: "user-a" }, storageKey: "user-a",
        persistence: { clear: () => events.push("clear-pending") },
        setIsSending: (value: boolean) => events.push(`sending:${value}`),
        persistSessions: async (value: unknown) => { events.push("save"); if (failWrite) throw new Error("quota exceeded"); snapshots.push(structuredClone(value)); },
        updateSession: (id: string, update: (value: typeof session) => typeof session) => { sessionsRef.current = sessionsRef.current.map((item) => item.id === id ? update(item) : item); },
        setDraft: (update: (value: string) => string) => { memory.draft = update(memory.draft); },
        setAttachments: (update: (value: typeof memory.attachments) => typeof memory.attachments) => { memory.attachments = update(memory.attachments); },
        followBottomRef: { current: false }, activeStreamRef: { current: null },
        createChatStreamBuffer: () => ({ push() {}, cancel() {}, flush() {} }),
        requestImageQuestion: async () => { events.push("model-request"); return "已读取图片"; },
        message: { warning: (value: string) => events.push(value), error: (value: string) => events.push(value) },
    };
    const module = { exports: {} as { send: () => Promise<void> } };
    const code = ts.transpileModule(`const send = ${initializer.getText(ast)}; exports.send = send;`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    new Function(...Object.keys(bindings), "module", "exports", code)(...Object.values(bindings), module, module.exports);
    return { send: module.exports.send, events, snapshots, memory };
}

test("the actual chat send handler cannot write or submit before hydration finishes", async () => {
    const page = pageSendHarness({ ready: false });
    await page.send();
    expect(page.events).toEqual([]);
    expect(page.memory.attachments).toHaveLength(1);
});

test("the actual chat send handler keeps drafts and attachments after a save failure", async () => {
    const page = pageSendHarness({ failWrite: true });
    const draft = structuredClone(page.memory);
    await page.send();
    expect(page.memory).toEqual(draft);
    expect(page.events).not.toContain("model-request");
    expect(page.events).toContain("聊天记录未保存，消息尚未发送；草稿和附件已保留。");
});

test("the actual chat send handler commits attachments before requesting and the final answer before finishing", async () => {
    const page = pageSendHarness();
    await page.send();
    expect(page.events.indexOf("save")).toBeLessThan(page.events.indexOf("model-request"));
    expect(page.snapshots).toHaveLength(2);
    expect((page.snapshots[0] as any[])[0].messages[0].attachments[0].dataUrl).toBe("data:image/png;base64,AQID");
    expect((page.snapshots[1] as any[])[0].messages.at(-1).content).toBe("已读取图片");
    expect(page.events.at(-1)).toBe("sending:false");
    expect(page.memory).toEqual({ draft: "", attachments: [] });
});
