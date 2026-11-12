import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { i18nHarness } from "./helpers/i18n-harness";

import { buildChatRequestMessages, type ChatHistoryMessage } from "@/lib/chat-context";
import { createChatSessionStorage } from "@/pages/chat/chat-session-storage";
import { createChatIndexedHistory } from "@/pages/chat/chat-indexed-history";
import { chatImageRequestOptions, preferredChatImageModel, resolveChatImageQuality } from "@/pages/chat/image-quality";
import { resolveChatImageSize } from "@/pages/chat/image-size";
import { resolveToolModel, type BusinessConfig } from "@/services/api/business-config";
import { createChatBranch } from "@/pages/chat/chat-message-actions";
import { assertCreativeChatImageSelection, buildCreativeImageCatalog } from "@/lib/creative-chat";
import { chatFocusImage } from "@/pages/chat/chat-image-selection";
import { chatImageTaskSignature, completeChatImageTask, duplicateChatImageTask } from "@/pages/chat/chat-image-tasks";
import { agentDocumentCatalog } from "@/lib/agent-documents";
import { confirmedDesignRequirements } from "@/lib/image-agent/document-tools";

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

function pageSendHarness({ ready = true, failWrite = false, failWriteAt = 0, mode = "chat", creativeChat = true, creativeModelId = "gpt-6-astra", imageModels = [{ id: "fixture-image", name: "gpt-image-2.5-flare", modelId: "gpt-image-2.5-flare", creditCost: 0, rmbCost: 0, capabilities: ["generate", "edit"] }], taskFailure = "", plan = Promise.resolve<any>({ kind: "discussion", content: "只讨论设计" }), taskResult = Promise.resolve([{ id: "result", sourceTaskId: "task-result", dataUrl: "data:image/png;base64,cmVzdWx0" }]) } = {}) {
    const source = readFileSync(new URL("../src/pages/chat/index.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("chat.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let initializer: ts.Expression | undefined;
    let stopHandler: ts.Expression | undefined;
    let stopWaitingHandler: ts.Expression | undefined;
    let syncVisibleSend: ts.Expression | undefined;
    let newSessionHandler: ts.Expression | undefined;
    let selectSessionHandler: ts.Expression | undefined;
    const composerHandlers = new Map<string, ts.Expression>();
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "send") initializer = node.initializer;
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "stopSending") stopHandler = node.initializer;
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "stopImageWaiting") stopWaitingHandler = node.initializer;
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "syncVisibleSend") syncVisibleSend = node.initializer;
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "startSession") newSessionHandler = node.initializer;
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "selectSession") selectSessionHandler = node.initializer;
        if (ts.isVariableDeclaration(node) && ["emptyComposerDraft", "setComposerDraft", "switchComposerSession", "clearSubmittedComposer"].includes(node.name.getText(ast)) && node.initializer) composerHandlers.set(node.name.getText(ast), node.initializer);
        ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!initializer) throw new Error("The chat page send handler was not found");
    const events: string[] = [];
    const snapshots: unknown[] = [];
    const plannerCalls: Array<{ config: any; history: any[]; current: any; options: any }> = [];
    const taskOptions: Array<{ requestId: string; signal?: AbortSignal; cancelOnAbort?: () => boolean; onSubmissionStarted?: () => void; onSubmitted: (taskIds: string[]) => void | Promise<void> }> = [];
    const memory: { draft: string; attachments: any[] } = { draft: "未发送的图片问题", attachments: [{ id: "image", name: "image.png", mimeType: "image/png", size: 3, dataUrl: "data:image/png;base64,AQID" }] };
    const session = { id: "session", mode, title: "新对话", editTargetImageId: undefined as string | undefined, imageModelId: undefined as string | undefined, focusImageId: undefined as string | undefined, focusLocked: false, focusRevision: 0, messages: [] as any[] };
    const sessionsRef = { current: [session] };
    const businessConfig: BusinessConfig = {
        models: [{ id: "fixture-chat", modelId: creativeModelId || "gpt-6-astra", name: "Fixture chat", capabilities: ["chat", "vision"], creditCost: 0, rmbCost: 0 }],
        prices: [],
        tools: [{ toolKey: "gpt-chat", modelConfigId: creativeModelId ? "fixture-chat" : null, enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 }],
    };
    const selected = resolveToolModel(businessConfig, "gpt-chat");
    let ids = 0;
    let writes = 0;
    const imageTask = async (action: string, options: typeof taskOptions[number]) => {
        events.push(`${action}-task`);
        taskOptions.push(options);
        if (taskFailure === "preparation") throw new Error("reference upload failed before task POST");
        options.onSubmissionStarted?.();
        if (taskFailure === "submission") throw new Error("task POST response lost");
        await options.onSubmitted(["task-result"]);
        return taskResult;
    };
    const bindings = {
        ...i18nHarness, confirmedDesignRequirements, agentDocumentCatalog,
        sessionsReady: ready, draft: memory.draft, attachments: memory.attachments, isSending: false, readingAttachments: false, hydratingMedia: false,
        imageTarget: null as { id: string; mode: "region" | "correction"; sessionId: string } | null, referenceImageIds: [] as string[], buildCreativeImageCatalog, assertCreativeChatImageSelection, chatFocusImage,
        editing: null as { messageId: string; content: string } | null, regionImage: null, regionSelection: null, setRegionSelection() {}, chatImageTaskSignature, completeChatImageTask, duplicateChatImageTask,
        composerDraftRef: { current: null as any }, sessionDraftsRef: { current: new Map<string, any>() },
        setComposerDraftState: (value: any) => {
            memory.draft = value.draft; memory.attachments = value.attachments;
            bindings.imageTarget = value.imageTarget; bindings.referenceImageIds = value.referenceImageIds;
            bindings.editing = value.editing; bindings.regionSelection = value.regionSelection; bindings.regionImage = value.regionImage;
        },
        imageRequestsRef: { current: new Map<string, AbortController>() }, setActiveImageRequestIds() {},
        restoreChatMaskResult: async (_pending: unknown, url: string) => url,
        activeSession: session, selectedModel: selected?.modelId || "", selected, imageModels, preferredChatImageModel, resolveChatImageQuality, chatImageRequestOptions, config: {} as Record<string, string>,
        resolveChatImageSize: (...args: Parameters<typeof resolveChatImageSize>) => resolveChatImageSize(args[0], args[1], args[2], args[3], args[4], async () => ({ width: 256, height: 256 })),
        creativeChat, creativeModelId: selected?.modelId || "", sendingRef: { current: false }, placingImageRef: { current: false }, activeSendRef: { current: null as { controller: AbortController; submitted: boolean } | null },
        createClientId: () => `message-${++ids}`, createChatBranch, buildChatRequestMessages, sessionsRef,
        createSession: () => ({ id: `session-${++ids}`, title: "新对话", messages: [], updatedAt: "2026-01-01" }), window: { innerWidth: 1440 }, setSidebarOpen() {},
        preparingSendsRef: { current: new Set() }, preparationQueueRef: { current: Promise.resolve() }, sendLifetimesRef: { current: new Set<any>() }, loadedStorageKeyRef: { current: "user-a" }, storageKey: "user-a",
        isCurrentScope: () => bindings.loadedStorageKeyRef.current === bindings.storageKey,
        setSessions: (value: any[] | ((previous: any[]) => any[])) => { sessionsRef.current = typeof value === "function" ? value(sessionsRef.current) : value; }, activeSessionIdRef: { current: session.id },
        setActiveSessionId: (_value: string) => {}, setEditing: (_value: unknown) => {},
        setImageTarget: (value: typeof bindings.imageTarget) => { bindings.imageTarget = value; },
        setReferenceImageIds: (value: string[] | ((ids: string[]) => string[])) => { bindings.referenceImageIds = typeof value === "function" ? value(bindings.referenceImageIds) : value; },
        persistence: { clear: () => events.push("clear-pending") },
        setIsSending: (value: boolean) => events.push(`sending:${value}`),
        setSendPhase: (_value: string) => {},
        persistSessions: async (value: unknown) => { events.push("save"); if (failWrite || ++writes === failWriteAt) throw new Error("quota exceeded"); snapshots.push(structuredClone(value)); },
        updateSession: (id: string, update: (value: typeof session) => typeof session) => { if (bindings.loadedStorageKeyRef.current !== bindings.storageKey) return; sessionsRef.current = sessionsRef.current.map((item) => item.id === id ? update(item) : item); },
        setDraft: (update: string | ((value: string) => string)) => { memory.draft = typeof update === "function" ? update(memory.draft) : update; },
        setAttachments: (update: typeof memory.attachments | ((value: typeof memory.attachments) => typeof memory.attachments)) => { memory.attachments = typeof update === "function" ? update(memory.attachments) : update; },
        chatFollow: { scrollToBottom: () => events.push("follow-bottom") }, activeStreamRef: { current: null },
        createChatStreamBuffer: (onFlush: (value: string) => void) => ({ push: onFlush, cancel() {}, flush() {} }),
        chatMedia: { hydrateSession: async (value: any, assertCurrent: () => void) => { assertCurrent(); return value; }, persist: async (value: any, assertCurrent: () => void) => { assertCurrent(); return value; } },
        requestImageQuestion: async () => { events.push("model-request"); return "已读取图片"; },
        requestCreativeChatPlan: async (config: any, history: any[], current: any, options: any) => {
            events.push("planner-request"); plannerCalls.push({ config: structuredClone(config), history: structuredClone(history), current: structuredClone(current), options });
            const result = await plan;
            // Lifecycle fixtures use symbolic bytes; a valid edit still owns a base.
            return result.kind === "image" && result.action === "edit" && !result.references.length ? { ...result, references: [{ id: "fixture-base", name: "底图.png", type: "image/png", dataUrl: "data:image/png;base64,AQID" }] } : result;
        },
        requestGeneration: async (_config: unknown, _prompt: string, options: typeof taskOptions[number]) => imageTask("generate", options),
        requestEdit: async (_config: unknown, _prompt: string, _references: unknown, _mask: unknown, options: typeof taskOptions[number]) => imageTask("edit", options),
        imageToDataUrl: async (image: { dataUrl: string }) => image.dataUrl,
        message: { warning: (value: string) => events.push(value), error: (value: string) => events.push(value) },
    };
    const code = ts.transpileModule(`${[...composerHandlers].map(([name, handler]) => `const ${name} = ${handler.getText(ast)};`).join("\n")} const syncVisibleSend = ${syncVisibleSend!.getText(ast)}; exports.send = ${initializer.getText(ast)}; exports.stop = ${stopHandler!.getText(ast)}; exports.stopWaiting = ${stopWaitingHandler!.getText(ast)}; exports.newSession = ${newSessionHandler!.getText(ast)}; exports.selectSession = ${selectSessionHandler!.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    let stop = () => {};
    let stopWaiting = (_item: any) => {};
    let newSession = () => {};
    let selectSession = (_id: string) => {};
    const syncComposer = () => {
        const value = { draft: memory.draft, attachments: memory.attachments, editing: bindings.editing, imageTarget: bindings.imageTarget, referenceImageIds: bindings.referenceImageIds, regionSelection: bindings.regionSelection, regionImage: bindings.regionImage };
        if (!bindings.composerDraftRef.current || Object.entries(value).some(([key, item]) => bindings.composerDraftRef.current[key] !== item)) bindings.composerDraftRef.current = value;
    };
    const render = () => {
        // Each user send runs with the current render snapshot, including the
        // previous generated answer and the newly typed (possibly text-only) turn.
        bindings.activeSession = sessionsRef.current.find(item => item.id === bindings.activeSessionIdRef.current) || sessionsRef.current[0]!;
        bindings.draft = memory.draft;
        bindings.attachments = memory.attachments;
        syncComposer();
        const module = { exports: {} as { send: (resend?: { messageId: string; content?: string }) => Promise<void>; stop: () => void; stopWaiting: (item: any) => void; newSession: () => void; selectSession: (id: string) => void } };
        new Function(...Object.keys(bindings), "module", "exports", code)(...Object.values(bindings), module, module.exports);
        stop = module.exports.stop;
        stopWaiting = module.exports.stopWaiting;
        newSession = module.exports.newSession;
        selectSession = module.exports.selectSession;
        return module.exports;
    };
    render();
    return { send: (resend?: { messageId: string; content?: string }) => render().send(resend), stop: () => stop(), stopWaiting: (item: any) => stopWaiting(item), newSession: () => { syncComposer(); newSession(); }, selectSession: (id: string) => { syncComposer(); selectSession(id); }, typeDraft: (value: string) => { memory.draft = value; syncComposer(); }, events, snapshots, memory, bindings, sessionsRef, taskOptions, plannerCalls };
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
    expect(page.events).not.toContain("planner-request");
    expect(page.events).not.toContain("follow-bottom");
    expect(page.events).toContain("聊天记录未保存，消息尚未发送；草稿和附件已保留。");
});

test("ordinary session switches restore the entire unsent composer, including editing and image intent", () => {
    const page = pageSendHarness();
    page.bindings.imageTarget = { id: "image", sessionId: "session", mode: "correction" };
    page.bindings.referenceImageIds = ["reference"];
    page.bindings.editing = { messageId: "original-message", content: "历史消息的未发送编辑" };
    page.bindings.regionSelection = { imageId: "image", mask: { dataUrl: "mask" }, selection: { dataUrl: "selection" } } as any;
    page.newSession();
    const idB = page.bindings.activeSessionIdRef.current;
    const savedA = page.bindings.sessionDraftsRef.current.get("session");
    expect(page.memory).toEqual({ draft: "", attachments: [] });
    expect(page.bindings.editing).toBeNull(); expect(page.bindings.regionSelection).toBeNull();
    page.typeDraft("B 还没发出的内容");
    page.selectSession("session");
    expect(page.bindings.composerDraftRef.current).toBe(savedA);
    expect(page.memory.draft).toBe("未发送的图片问题"); expect(page.memory.attachments).toHaveLength(1);
    expect(page.bindings.imageTarget).toEqual({ id: "image", sessionId: "session", mode: "correction" });
    expect(page.bindings.referenceImageIds).toEqual(["reference"]);
    expect(page.bindings.editing?.content).toBe("历史消息的未发送编辑"); expect((page.bindings.regionSelection as any).imageId).toBe("image");
    page.selectSession(idB); expect(page.memory.draft).toBe("B 还没发出的内容");
    expect(page.plannerCalls).toEqual([]);
});

test("a failed A pre-save retains its original composer after switching away and never overwrites B", async () => {
    const gate = Promise.withResolvers<void>();
    const page = pageSendHarness(); let saveStarted = false;
    page.bindings.persistSessions = async () => { saveStarted = true; await gate.promise; throw new Error("storage unavailable"); };
    page.typeDraft("A 尚未提交"); const originalA = page.bindings.composerDraftRef.current;
    const pending = page.send();
    for (let turn = 0; turn < 50 && !saveStarted; turn++) await Promise.resolve();
    expect(saveStarted).toBe(true); page.newSession(); const idB = page.bindings.activeSessionIdRef.current;
    page.typeDraft("B 独立输入"); gate.resolve(); await pending;
    expect(page.memory.draft).toBe("B 独立输入"); expect(page.bindings.activeSessionIdRef.current).toBe(idB);
    page.selectSession("session"); expect(page.bindings.composerDraftRef.current).toBe(originalA);
    expect(page.memory.draft).toBe("A 尚未提交"); expect(page.memory.attachments).toHaveLength(1);
    page.selectSession(idB); expect(page.memory.draft).toBe("B 独立输入");
    expect(page.plannerCalls).toEqual([]); expect(page.sessionsRef.current.every(item => item.messages.length === 0)).toBe(true);
});

test("a late successful pre-save clears only its submitted draft version, not retyped A input", async () => {
    const gate = Promise.withResolvers<void>(), page = pageSendHarness();
    const originalSave = page.bindings.persistSessions; let held = false;
    page.bindings.persistSessions = async value => { if (!held) { held = true; await gate.promise; } await originalSave(value); };
    page.typeDraft("A 内容"); page.memory.attachments = [];
    const pending = page.send();
    for (let turn = 0; turn < 50 && !held; turn++) await Promise.resolve();
    page.newSession(); const idB = page.bindings.activeSessionIdRef.current; page.typeDraft("B 草稿");
    page.selectSession("session"); page.typeDraft("A 新一轮"); page.typeDraft("A 内容");
    gate.resolve(); await pending;
    expect(page.memory.draft).toBe("A 内容");
    page.selectSession(idB); expect(page.memory.draft).toBe("B 草稿");
    expect(page.plannerCalls).toHaveLength(1);
});

test("running text conversations can switch and stream independently, and stopping A never stops B", async () => {
    const gateA = Promise.withResolvers<any>(), gateB = Promise.withResolvers<any>();
    const page = pageSendHarness({ plan: gateA.promise });
    page.memory.draft = "A 要求"; page.memory.attachments = [];
    const pendingA = page.send();
    for (let turn = 0; turn < 50 && page.plannerCalls.length < 1; turn++) await Promise.resolve();
    expect(page.plannerCalls).toHaveLength(1);
    page.newSession();
    const idB = page.bindings.activeSessionIdRef.current;
    expect(idB).not.toBe("session"); expect(page.bindings.sendingRef.current).toBe(false);
    page.memory.draft = "B 要求";
    const request = page.bindings.requestCreativeChatPlan;
    page.bindings.requestCreativeChatPlan = async (...args) => { void request(...args); return gateB.promise; };
    const pendingB = page.send();
    for (let turn = 0; turn < 50 && page.plannerCalls.length < 2; turn++) await Promise.resolve();
    expect(page.plannerCalls).toHaveLength(2);
    page.plannerCalls[0]!.options.onDelta("A 部分回复"); page.plannerCalls[1]!.options.onDelta("B 部分回复");
    expect(page.sessionsRef.current.find(item => item.id === "session")!.messages.at(-1).content).toBe("A 部分回复");
    expect(page.sessionsRef.current.find(item => item.id === idB)!.messages.at(-1).content).toBe("B 部分回复");
    page.selectSession("session"); expect(page.bindings.sendingRef.current).toBe(true);
    page.stop(); expect(page.plannerCalls[0]!.options.signal.aborted).toBe(true); expect(page.plannerCalls[1]!.options.signal.aborted).toBe(false);
    gateA.resolve({ kind: "image", action: "generate", prompt: "不得提交", content: "", references: [] });
    gateB.resolve({ kind: "discussion", content: "B 最终回复" }); await Promise.all([pendingA, pendingB]);
    expect(page.taskOptions).toEqual([]);
    expect(page.sessionsRef.current.find(item => item.id === "session")!.messages.at(-1)).toMatchObject({ content: "A 部分回复", stopped: true });
    expect(page.sessionsRef.current.find(item => item.id === idB)!.messages.at(-1).content).toBe("B 最终回复");
    expect(page.bindings.sendLifetimesRef.current.size).toBe(0);
});

test("switching while A saves preserves B draft, and queued user commits retain both conversations", async () => {
    const firstSave = Promise.withResolvers<void>(), page = pageSendHarness();
    const originalSave = page.bindings.persistSessions; let held = false;
    page.bindings.persistSessions = async value => { if (!held) { held = true; await firstSave.promise; } await originalSave(value); };
    page.memory.draft = "A 要求"; page.memory.attachments = [];
    const pendingA = page.send();
    for (let turn = 0; turn < 50 && !held; turn++) await Promise.resolve();
    page.newSession(); const idB = page.bindings.activeSessionIdRef.current;
    page.memory.draft = "B 未发送草稿";
    firstSave.resolve(); await pendingA;
    expect(page.memory.draft).toBe("B 未发送草稿"); expect(page.bindings.activeSessionIdRef.current).toBe(idB);
    await page.send();
    const saved = page.snapshots.at(-1) as any[];
    expect(saved.find(item => item.id === "session").messages.map((item: any) => item.content)).toEqual(["A 要求", "只讨论设计"]);
    expect(saved.find(item => item.id === idB).messages.map((item: any) => item.content)).toEqual(["B 未发送草稿", "只讨论设计"]);
});

test.each([["pending-success", "pending", false], ["submitted-success", "submitted", false], ["pending-failure", "pending", true], ["submitted-failure", "submitted", true]])("image marker preserves B's held durable user turn: %s", async (_case, phase, failB) => {
    const planA = Promise.withResolvers<any>(), planB = Promise.withResolvers<any>();
    const resultA = Promise.withResolvers<any[]>(), beforeSubmission = Promise.withResolvers<void>(), saveB = Promise.withResolvers<void>();
    const page = pageSendHarness({ plan: planA.promise, taskResult: resultA.promise });
    const database = memoryStore(); let idB = "", heldB = false, atSubmission = false, bAtSubmission: string[] | undefined;
    const storage = createChatIndexedHistory<any>({
        getItem: database.getItem,
        async setItem<T>(key: string, value: T) {
            if (!heldB && idB && key === `user-a:session:${idB}` && (value as any).messages?.some((item: any) => item.content === "B durable turn")) {
                heldB = true; await saveB.promise;
                if (failB) throw new Error("B durable write failed");
            }
            return database.setItem(key, value);
        },
    }, async session => session);
    page.bindings.persistSessions = value => storage.save("user-a", value as any[]);
    const requestGeneration = page.bindings.requestGeneration;
    page.bindings.requestGeneration = async (...args) => {
        atSubmission = true;
        if (idB) bAtSubmission = (database.values.get(`user-a:session:${idB}`) as any)?.messages.map((item: any) => item.content);
        if (phase === "submitted") await beforeSubmission.promise;
        return requestGeneration(...args);
    };
    const imagePlan = { kind: "image", action: "generate", prompt: "A image", content: "", references: [] };
    page.typeDraft("A image turn"); page.memory.attachments = [];
    const pendingA = page.send();
    for (let turn = 0; turn < 100 && !page.plannerCalls.length; turn++) await Promise.resolve();
    expect(page.plannerCalls).toHaveLength(1);
    if (phase === "submitted") {
        planA.resolve(imagePlan);
        for (let turn = 0; turn < 100 && !atSubmission; turn++) await Promise.resolve();
        expect(atSubmission).toBe(true);
    }
    page.newSession(); idB = page.bindings.activeSessionIdRef.current;
    page.typeDraft("B durable turn"); page.bindings.requestCreativeChatPlan = async () => planB.promise;
    const pendingB = page.send();
    for (let turn = 0; turn < 100 && !heldB; turn++) await Promise.resolve();
    expect(heldB).toBe(true);
    if (phase === "pending") planA.resolve(imagePlan); else beforeSubmission.resolve();
    for (let turn = 0; turn < 100; turn++) await Promise.resolve();
    saveB.resolve();
    for (let turn = 0; turn < 200 && ![...page.bindings.sendLifetimesRef.current].some(item => item.sessionId === "session" && item.detached); turn++) await Promise.resolve();
    const saved = await storage.load("user-a", () => null);
    // Inspect while both model requests are still in flight, before a later
    // final-answer save could accidentally repair the missing durable turn.
    const persistedB = phase === "pending" ? bAtSubmission : saved.find(item => item.id === idB)?.messages.map((item: any) => item.content);
    const submittedCount = page.taskOptions.length;
    planB.resolve({ kind: "discussion", content: "B reply" });
    resultA.resolve([{ id: "result", sourceTaskId: "task-result", dataUrl: "data:image/png;base64,cmVzdWx0" }]);
    await Promise.all([pendingA, pendingB]);
    expect(submittedCount).toBe(1);
    expect(persistedB).toEqual(failB ? [] : ["B durable turn"]);
    if (failB) expect(page.memory.draft).toBe("B durable turn");
    expect(page.bindings.activeSessionIdRef.current).toBe(idB);
});

test("the actual chat send handler commits attachments before requesting and the final answer before finishing", async () => {
    const page = pageSendHarness();
    await page.send();
    expect(page.events.indexOf("save")).toBeLessThan(page.events.indexOf("planner-request"));
    expect(page.events.filter(event => event === "follow-bottom")).toHaveLength(1);
    expect(page.events.indexOf("follow-bottom")).toBeGreaterThan(page.events.indexOf("save"));
    expect(page.events.indexOf("follow-bottom")).toBeLessThan(page.events.indexOf("planner-request"));
    expect(page.snapshots).toHaveLength(2);
    expect((page.snapshots[0] as any[])[0].messages[0].attachments[0].dataUrl).toBe("data:image/png;base64,AQID");
    expect((page.snapshots[1] as any[])[0].messages.at(-1).content).toBe("只讨论设计");
    expect(page.events.at(-1)).toBe("sending:false");
    expect(page.memory).toEqual({ draft: "", attachments: [] });
});

test("the actual creative send handler discusses without submitting any image task", async () => {
    const page = pageSendHarness({ mode: "create" });
    await page.send();
    expect(page.events.filter((event) => event.endsWith("-task"))).toEqual([]);
    expect(page.sessionsRef.current[0]!.messages.at(-1).content).toBe("只讨论设计");
});

test.each(["chat", "create", "agent"])("a fresh text-only request reaches the same planner regardless of legacy session mode %s", async (mode) => {
    const page = pageSendHarness({ mode });
    page.memory.draft = "把花瓣改细一点";
    page.memory.attachments = [];
    await page.send();
    expect(page.plannerCalls).toHaveLength(1);
    expect(page.plannerCalls[0]).toMatchObject({ history: [], current: { content: "把花瓣改细一点", attachments: [] } });
    expect(page.events).not.toContain("model-request");
    expect(page.taskOptions).toEqual([]);
});

test("original images and parsed document content reach the planner together without rewriting the user's request", async () => {
    const page = pageSendHarness();
    page.memory.draft = "按文件规格修改这张图";
    page.memory.attachments.push({ id: "document", name: "brief.pdf", kind: "document", mimeType: "application/pdf", size: 30, textContent: "CORAL-7193 Width: 20cm" });
    const before = structuredClone(page.memory.attachments);
    await page.send();
    expect(page.plannerCalls[0]!.current).toMatchObject({ content: "按文件规格修改这张图", attachments: before });
    expect((page.snapshots[0] as any[])[0].messages[0].attachments).toEqual(before);
    expect(page.memory.attachments).toEqual([]);
});

test("attachments without text reach the planner as an empty user instruction, not an invented analysis request", async () => {
    const page = pageSendHarness();
    page.memory.draft = "";
    await page.send();
    expect(page.plannerCalls[0]!.current.content).toBe("");
    expect(page.plannerCalls[0]!.current.attachments).toHaveLength(1);
    expect((page.snapshots[0] as any[])[0].title).toBe("image.png");
});

test("discussion succeeds without a configured image model and never submits an image task", async () => {
    const page = pageSendHarness({ imageModels: [] });
    await page.send();
    expect(page.plannerCalls).toHaveLength(1);
    expect(page.taskOptions).toEqual([]);
    expect(page.sessionsRef.current[0]!.messages.at(-1)).toMatchObject({ role: "assistant", content: "只讨论设计" });
});

test("only an image decision requires a capable image model, and it does not fall back to another operation", async () => {
    const page = pageSendHarness({ imageModels: [{ id: "fixture-generate", name: "Generate only", modelId: "generate-only", creditCost: 0, rmbCost: 0, capabilities: ["generate"] }], plan: Promise.resolve({ kind: "image", action: "edit", prompt: "只改花瓣", content: "", references: [] }) });
    await page.send();
    expect(page.plannerCalls).toHaveLength(1);
    expect(page.taskOptions).toEqual([]);
    expect(page.sessionsRef.current[0]!.messages.at(-1)).toMatchObject({ role: "error" });
    expect(page.sessionsRef.current[0]!.messages.at(-1).content).toContain("图片编辑服务");
});

test("after an image result, a text-only follow-up carries the generated version and ancestry automatically", async () => {
    const firstPlan = { kind: "image", action: "generate", prompt: "春日花卉", content: "", references: [], workNote: { summary: "春日花卉", keep: ["保留中文"] } };
    const page = pageSendHarness({ plan: Promise.resolve(firstPlan) });
    await page.send();
    const firstAnswer = structuredClone(page.sessionsRef.current[0]!.messages.at(-1));
    page.memory.draft = "花瓣再细一点，其他不变";
    page.memory.attachments = [];
    await page.send();
    expect(page.plannerCalls).toHaveLength(2);
    expect(page.plannerCalls[1]!.history.at(-1)).toEqual(firstAnswer);
    expect(page.plannerCalls[1]).toMatchObject({
        current: { content: "花瓣再细一点，其他不变", attachments: [], parentMessageId: firstAnswer.id, editTargetImageId: "task-result:0" },
        options: { selectedImageId: "task-result:0" },
    });
    expect(page.plannerCalls[1]!.history.at(-1).generatedImages[0]).toMatchObject({ id: "task-result:0", dataUrl: "data:image/png;base64,cmVzdWx0", workNote: firstPlan.workNote });
});

test.each([true, false])("creative sending always uses the planner even with legacy creativeChat=%s", async (creativeChat) => {
    const page = pageSendHarness({ mode: "create", creativeChat });
    await page.send();
    expect(page.events.filter((event) => event === "planner-request")).toHaveLength(1);
    expect(page.events.filter((event) => event.endsWith("-task"))).toEqual([]);
    expect(page.events).not.toContain("model-request");
    expect(page.sessionsRef.current[0]!.messages.at(-1).content).toBe("只讨论设计");
});

test.each([true, false])("missing managed chat binding preserves the unsent draft and blocks all requests (legacy toggle %s)", async (creativeChat) => {
    const page = pageSendHarness({ mode: "create", creativeChat, creativeModelId: "" });
    const before = structuredClone(page.memory);
    await page.send();
    expect(page.memory).toEqual(before);
    expect(page.snapshots).toEqual([]);
    expect(page.taskOptions).toEqual([]);
    expect(page.plannerCalls).toEqual([]);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toContain("对话模型");
});

test("a selected older version and message ancestry are saved before the planner sees the new turn", async () => {
    const page = pageSendHarness({ mode: "create" });
    const history = [{ id: "previous-answer", role: "assistant", content: "上一版", generatedImages: [{ id: "old-task:0", dataUrl: "data:image/png;base64,AQID" }] }];
    page.bindings.activeSession.messages.push(...history);
    page.bindings.activeSession.editTargetImageId = "old-task:0";
    await page.send();
    const stored = (page.snapshots[0] as any[])[0].messages.at(-1);
    expect(stored).toMatchObject({ role: "user", parentMessageId: "previous-answer", editTargetImageId: "old-task:0" });
    expect(page.plannerCalls[0]).toMatchObject({ history, current: stored, options: { selectedImageId: "old-task:0" } });
    expect(page.events.indexOf("save")).toBeLessThan(page.events.indexOf("planner-request"));
    expect(page.sessionsRef.current[0]!.messages.at(-1).parentMessageId).toBe(stored.id);
    expect(page.sessionsRef.current[0]!.editTargetImageId).toBe("old-task:0");
});

test("the actual send freezes an explicit correction source even when the composer is cancelled during planning", async () => {
    const decision = Promise.withResolvers<any>();
    const page = pageSendHarness({ plan: decision.promise });
    page.bindings.activeSession.editTargetImageId = "latest";
    page.bindings.activeSession.messages.push({ id: "old", role: "assistant", content: "", generatedImages: [{ id: "older", dataUrl: "data:image/png;base64,AQID" }] });
    page.bindings.activeSession.focusImageId = "older"; page.bindings.activeSession.focusLocked = true;
    page.bindings.imageTarget = { id: "older", mode: "correction", sessionId: "session" };
    const sending = page.send();
    for (let turn = 0; turn < 20 && !page.plannerCalls.length; turn++) await Promise.resolve();
    page.bindings.imageTarget = null;
    expect(page.plannerCalls[0]).toMatchObject({ current: { editTargetImageId: "older" }, options: { selectedImageId: "older", explicitTargetImageId: "older" } });
    decision.resolve({ kind: "image", action: "edit", prompt: "只改已选版本", content: "", references: [{ id: "older", dataUrl: "data:image/png;base64,AQID" }], parentId: "older", workId: "older", workNote: { summary: "已选版本", keep: [] } });
    await sending;
    expect(page.taskOptions).toHaveLength(1);
    expect(page.sessionsRef.current[0]!.messages.at(-1).generatedImages[0].parentId).toBe("older");
});

test.each(["wrong-target", "wrong-order", "generate", "missing-reference"])("explicit correction choices block %s before any paid image submission", async (failure) => {
    const references = failure === "generate" ? [] : failure === "wrong-order" ? [{ id: "palette" }, { id: "older" }] : [{ id: failure === "wrong-target" ? "latest" : "older" }];
    const page = pageSendHarness({ plan: Promise.resolve({ kind: "image", action: failure === "generate" ? "generate" : "edit", content: "", prompt: "do not execute", references, lineage: { parentImageId: failure === "wrong-target" ? "latest" : "older", sourceImageIds: references.map((item) => item.id), preservedConstraints: [] } }) });
    page.bindings.activeSession.focusImageId = "older"; page.bindings.activeSession.focusLocked = true;
    page.bindings.imageTarget = { id: "older", mode: "correction", sessionId: "session" };
    page.bindings.activeSession.messages.push({ id: "old", role: "assistant", content: "", generatedImages: [{ id: "older", dataUrl: "data:image/png;base64,AQID" }] });
    if (failure === "missing-reference") page.bindings.referenceImageIds = ["image"];
    await page.send();
    expect(page.taskOptions).toEqual([]);
    expect(page.events.some((event) => event.endsWith("-task"))).toBe(false);
    expect(page.sessionsRef.current[0]!.messages.at(-1)).toMatchObject({ role: "error" });
    expect(page.sessionsRef.current[0]!.messages.at(-1).content).toContain("尚未提交");
    expect(page.sessionsRef.current[0]!.messages.some((item) => item.pendingImageTask)).toBe(false);
});

test("cancelling a composer target keeps only the existing soft automatic candidate", async () => {
    const page = pageSendHarness();
    page.bindings.activeSession.editTargetImageId = "latest";
    page.bindings.activeSession.messages.push({ id: "old", role: "assistant", content: "", generatedImages: [{ id: "latest", dataUrl: "data:image/png;base64,AQID" }] });
    page.bindings.imageTarget = null;
    await page.send();
    expect(page.plannerCalls[0]!.options.explicitTargetImageId).toBeUndefined();
    expect(page.plannerCalls[0]!.options.selectedImageId).toBe("latest");
    expect(page.taskOptions).toEqual([]);
});

test.each(["old-lock", "old-new-creation", "cancelled-region"])("ordinary conversation ignores stale %s and uses the latest result without an explicit target", async (state) => {
    const page = pageSendHarness();
    page.memory.attachments = [];
    page.bindings.activeSession.messages.push(
        { id: "old", role: "assistant", content: "", generatedImages: [{ id: "older", dataUrl: "data:image/png;base64,AQID" }] },
        { id: "new", role: "assistant", content: "", generatedImages: [{ id: "latest", parentId: "older", dataUrl: "data:image/png;base64,BAUG" }] },
    );
    Object.assign(page.bindings.activeSession, { focusImageId: "older", editTargetImageId: "older", focusLocked: true, newCreation: state === "old-new-creation" });
    if (state === "cancelled-region") page.bindings.imageTarget = { id: "older", sessionId: "session", mode: "region" };
    await page.send();
    expect(page.plannerCalls[0]!.options).toMatchObject({ selectedImageId: "latest", newCreation: false });
    expect(page.plannerCalls[0]!.options.explicitTargetImageId).toBeUndefined();
    expect(page.plannerCalls[0]!.current.focusLocked).toBe(false);
    expect(page.sessionsRef.current[0]!.focusLocked).toBe(false);
    expect(page.sessionsRef.current[0]!.focusImageId).toBe("latest");
    expect(page.bindings.imageTarget).toBeNull();
    expect(page.taskOptions).toEqual([]);
    page.memory.draft = "再继续讨论，不出图";
    await page.send();
    expect(page.plannerCalls[1]!.options.selectedImageId).toBe("latest");
    expect(page.plannerCalls[1]!.options.explicitTargetImageId).toBeUndefined();
});

test("an explicit target from another conversation is never sent as this conversation's target", async () => {
    const page = pageSendHarness();
    page.bindings.activeSession.editTargetImageId = "current-latest";
    page.bindings.activeSession.messages.push({ id: "old", role: "assistant", content: "", generatedImages: [{ id: "current-latest", dataUrl: "data:image/png;base64,AQID" }] });
    page.bindings.imageTarget = { id: "other-image", sessionId: "other-session", mode: "correction" };
    await page.send();
    expect(page.plannerCalls[0]!.options.explicitTargetImageId).toBeUndefined();
    expect(page.plannerCalls[0]!.current.editTargetImageId).toBe("current-latest");
});

test("six selected image inputs are rejected without writing a user turn or invoking the planner", async () => {
    const page = pageSendHarness();
    page.memory.attachments = Array.from({ length: 5 }, (_, index) => ({ id: `reference-${index}`, name: "参考.png", kind: "image", dataUrl: "data:image/png;base64,AQID" }));
    page.bindings.activeSession.focusImageId = "older"; page.bindings.activeSession.focusLocked = true;
    page.bindings.imageTarget = { id: "older", mode: "correction", sessionId: "session" };
    await page.send();
    expect(page.events).toEqual(["编辑目标与参考图片合计最多 5 张，请先移除一张图片"]);
    expect(page.snapshots).toEqual([]);
    expect(page.plannerCalls).toEqual([]);
    expect(page.memory.attachments).toHaveLength(5);
});

test.each(["generate", "edit"])("the actual creative send handler submits one %s task and persists the original result", async (action) => {
    const workNote = { summary: "只改花瓣", keep: ["保留中文", "保留版型"] };
    const page = pageSendHarness({ mode: "create", plan: Promise.resolve({ kind: "image", action, prompt: "完整要求", content: "只改花瓣，保留其余设计", parentId: "old-task:0", workId: "original", workNote, references: [{ id: "original", dataUrl: "data:image/png;base64,AQID" }] }) });
    await Promise.all([page.send(), page.send()]);
    expect(page.events.filter((event) => event === "planner-request")).toHaveLength(1);
    expect(page.events.filter((event) => event.endsWith("-task"))).toEqual([`${action}-task`]);
    const session = (page.snapshots.at(-1) as any[])[0];
    expect(session.chatModelId).toBe("gpt-6-astra");
    expect(session.imageModelId).toBe("gpt-image-2.5-flare");
    expect(session.messages.at(-1).generatedImages[0]).toMatchObject({ dataUrl: "data:image/png;base64,cmVzdWx0", modelId: "gpt-image-2.5-flare", prompt: "完整要求", parentId: "old-task:0", workId: "original", workNote, referenceImageIds: ["original"] });
    expect(session.messages.at(-1).generatedImages[0].id).toBe("task-result:0");
    expect(session.editTargetImageId).toBe("task-result:0");
    expect(session.messages.at(-1).parentMessageId).toBe(session.messages[0].id);
    expect(session.messages.at(-1).content).toBe("只改花瓣，保留其余设计");
    const prepared = (page.snapshots[1] as any[])[0].messages.at(-1).pendingImageTask;
    expect(prepared).toMatchObject({ requestId: page.taskOptions[0]!.requestId, prompt: "完整要求", modelId: "gpt-image-2.5-flare", quality: "high", action, parentMessageId: session.messages[0].id, parentId: "old-task:0", workId: "original", workNote, referenceImageIds: ["original"], focusRevision: 1, explanation: "只改花瓣，保留其余设计" });
    expect(prepared.signature).toBe(chatImageTaskSignature(prepared));
    expect((page.snapshots[2] as any[])[0].messages.at(-1).pendingImageTask).toEqual({ ...prepared, taskId: "task-result" });
    expect(page.events.slice(0, page.events.indexOf(`${action}-task`)).filter((item) => item === "save")).toHaveLength(2);
    expect(session.messages.at(-1).pendingImageTask).toBeUndefined();
});

test("failure to save the pending request marker prevents image task submission", async () => {
    const page = pageSendHarness({ mode: "create", failWriteAt: 2, plan: Promise.resolve({ kind: "image", action: "generate", prompt: "完整要求", content: "", references: [] }) });
    await page.send();
    expect(page.events.filter((event) => event.endsWith("-task"))).toEqual([]);
    expect(page.sessionsRef.current[0]!.messages.at(-1).pendingImageTask).toBeUndefined();
    expect(page.sessionsRef.current[0]!.messages.at(-1).content).toContain("图片任务尚未提交");
});

test("a known image preparation failure clears the pending marker instead of locking the conversation", async () => {
    const page = pageSendHarness({ mode: "create", taskFailure: "preparation", plan: Promise.resolve({ kind: "image", action: "edit", prompt: "完整要求", content: "", references: [] }) });
    await page.send();
    const reply = page.sessionsRef.current[0]!.messages.at(-1);
    expect(reply.pendingImageTask).toBeUndefined();
    expect(reply.role).toBe("error");
    expect(reply.content).toContain("图片任务尚未提交");
    expect((page.snapshots.at(-1) as any[])[0].messages.at(-1).pendingImageTask).toBeUndefined();
});

test.each(["submission", "accepted-marker-save"])("an uncertain %s failure retains the original pending marker without retrying", async (failure) => {
    const page = pageSendHarness({ mode: "create", taskFailure: failure === "submission" ? "submission" : "", failWriteAt: failure === "accepted-marker-save" ? 3 : 0, plan: Promise.resolve({ kind: "image", action: "generate", prompt: "原任务要求", content: "", references: [] }) });
    await page.send();
    const reply = page.sessionsRef.current[0]!.messages.at(-1);
    expect(reply.pendingImageTask.requestId).toBe(page.taskOptions[0]!.requestId);
    expect(reply.content).toContain("图片任务结果尚未确认");
    expect(page.events.filter((event) => event.endsWith("-task"))).toEqual(["generate-task"]);
});

test("a persisted pending image request does not block new discussion in the same conversation", async () => {
    const page = pageSendHarness({ mode: "create" });
    page.bindings.activeSession.messages.push({ id: "assistant", role: "assistant", pendingImageTask: { requestId: "original-request" } });
    await page.send();
    expect(page.plannerCalls).toHaveLength(1);
    expect(page.taskOptions).toHaveLength(0);
    expect(page.sessionsRef.current[0]!.messages[0].pendingImageTask.requestId).toBe("original-request");
    expect(page.sessionsRef.current[0]!.messages.at(-1).content).toBe("只讨论设计");
});

test.each(["account-change", "unmount"])("a submitted image task retains its recovery marker without writing to another session after %s", async (reason) => {
    const result = Promise.withResolvers<Array<{ id: string; sourceTaskId: string; dataUrl: string }>>();
    const page = pageSendHarness({ mode: "create", taskResult: result.promise, plan: Promise.resolve({ kind: "image", action: "generate", prompt: "原任务提示词", content: "", references: [] }) });
    const pending = page.send();
    for (let turn = 0; turn < 30 && (page.snapshots.length < 3 || page.bindings.activeSendRef.current); turn += 1) await Promise.resolve();
    expect(page.bindings.activeSendRef.current).toBeNull();
    expect(page.bindings.sendingRef.current).toBe(false);
    expect(page.bindings.imageRequestsRef.current.size).toBe(1);
    const storedBeforeLeaving = structuredClone(page.snapshots.at(-1));
    expect((storedBeforeLeaving as any[])[0].messages.at(-1).pendingImageTask).toMatchObject({ taskId: "task-result", requestId: page.taskOptions[0]!.requestId, prompt: "原任务提示词" });
    page.bindings.loadedStorageKeyRef.current = reason === "account-change" ? "user-b" : "";
    if (reason === "account-change") page.sessionsRef.current = [{ id: "other-session", mode: "chat", title: "账号 B", editTargetImageId: undefined, imageModelId: undefined, messages: [] }];
    result.resolve([{ id: "result", sourceTaskId: "task-result", dataUrl: "data:image/png;base64,cmVzdWx0" }]);
    await pending;
    expect(page.snapshots).toHaveLength(3);
    expect(page.snapshots.at(-1)).toEqual(storedBeforeLeaving);
    expect(page.sessionsRef.current[0]!.messages.some((item) => item.generatedImages)).toBe(false);
    expect(page.events.filter((event) => event === "generate-task")).toHaveLength(1);
});

test.each(["account-change", "unmount"])("an unfinished creative plan cannot submit a task after %s", async (reason) => {
    const decision = Promise.withResolvers<any>();
    const page = pageSendHarness({ mode: "create", plan: decision.promise });
    const pending = page.send();
    for (let turn = 0; turn < 20 && !page.events.includes("planner-request"); turn++) await Promise.resolve();
    expect(page.events).toContain("planner-request");
    if (reason === "account-change") page.bindings.loadedStorageKeyRef.current = "user-b";
    else page.bindings.activeSendRef.current!.controller.abort();
    decision.resolve({ kind: "image", action: "generate", prompt: "不能提交", content: "", references: [] });
    await pending;
    expect(page.events.filter((event) => event.endsWith("-task"))).toEqual([]);
});

test("a failed creative plan does not silently generate or retry", async () => {
    const decision = Promise.withResolvers<any>();
    const page = pageSendHarness({ mode: "create", plan: decision.promise });
    const pending = page.send();
    for (let turn = 0; turn < 20 && !page.events.includes("planner-request"); turn++) await Promise.resolve();
    decision.reject(new Error("upstream unavailable"));
    await pending;
    expect(page.events.filter((event) => event === "planner-request")).toHaveLength(1);
    expect(page.events.filter((event) => event.endsWith("-task"))).toEqual([]);
});

test("stopping a streamed reply preserves partial text and prevents a late image decision from submitting", async () => {
    const decision = Promise.withResolvers<any>();
    const page = pageSendHarness({ plan: decision.promise });
    const pending = page.send();
    for (let turn = 0; turn < 20 && !page.plannerCalls.length; turn++) await Promise.resolve();
    page.plannerCalls[0]!.options.onDelta("**保留已收到的文字**");
    page.stop(); page.stop();
    expect(page.plannerCalls[0]!.options.signal.aborted).toBe(true);
    decision.resolve({ kind: "image", action: "generate", prompt: "must not submit", content: "", references: [] });
    await pending;
    expect(page.sessionsRef.current[0]!.messages.at(-1)).toMatchObject({ content: "**保留已收到的文字**", stopped: true, role: "assistant" });
    expect(page.taskOptions).toEqual([]);
    expect(page.events.at(-1)).toBe("sending:false");
});

test("stopping after image submission keeps the original task marker instead of cancelling or resubmitting", async () => {
    const result = Promise.withResolvers<any[]>();
    const page = pageSendHarness({ plan: Promise.resolve({ kind: "image", action: "generate", prompt: "original", content: "", references: [] }), taskResult: result.promise });
    const pending = page.send();
    for (let turn = 0; turn < 30 && (page.snapshots.length < 3 || page.bindings.activeSendRef.current); turn++) await Promise.resolve();
    expect(page.bindings.activeSendRef.current).toBeNull();
    expect(page.taskOptions[0]?.cancelOnAbort?.()).toBe(false);
    page.stopWaiting(page.sessionsRef.current[0]!.messages.at(-1)); result.resolve([{ id: "late-result", sourceTaskId: "task-result", dataUrl: "data:image/png;base64,AQID" }]); await pending;
    const reply = page.sessionsRef.current[0]!.messages.at(-1);
    expect(reply.pendingImageTask).toMatchObject({ taskId: "task-result", requestId: page.taskOptions[0]!.requestId });
    expect(reply.content).toContain("图片任务可能仍在服务端执行");
    expect(reply.stopped).toBe(true);
    expect(reply.generatedImages).toBeUndefined(); expect(page.taskOptions).toHaveLength(1);
    await page.send(); expect(page.taskOptions).toHaveLength(1);
});

test("stopping while the user turn is being saved creates no model call and keeps the saved message visible", async () => {
    const gate = Promise.withResolvers<void>(), page = pageSendHarness();
    const save = page.bindings.persistSessions; let first = true;
    page.bindings.persistSessions = async value => { if (first) { first = false; await gate.promise; } await save(value); };
    const pending = page.send();
    for (let turn = 0; turn < 30 && first; turn++) await Promise.resolve();
    expect(first).toBe(false);
    page.stop(); gate.resolve(); await pending;
    expect(page.plannerCalls).toEqual([]);
    expect(page.sessionsRef.current[0]!.messages.map(item => item.role)).toEqual(["user", "assistant"]);
    expect(page.sessionsRef.current[0]!.messages.at(-1).stopped).toBe(true);
});

test.each([undefined, "edited original"])("explicit replay branches from the original turn and retains the original full conversation (edit=%s)", async (content) => {
    const page = pageSendHarness();
    page.sessionsRef.current[0]!.messages.push(
        { id: "old-user", role: "user", content: "original prompt", attachments: [], createdAt: "old" },
        { id: "old-answer", role: "assistant", parentMessageId: "old-user", content: "original answer", createdAt: "old" },
        { id: "future", role: "user", content: "future must not enter replay", createdAt: "old" },
    );
    const original = structuredClone(page.sessionsRef.current[0]);
    page.bindings.imageTarget = { id: "future-image", sessionId: "session", mode: "edit" };
    page.bindings.referenceImageIds = ["future-image"];
    await Promise.all([page.send({ messageId: "old-answer", content }), page.send({ messageId: "old-answer", content })]);
    expect(page.plannerCalls).toHaveLength(1);
    expect(page.plannerCalls[0]!.history).toEqual([]);
    expect(page.plannerCalls[0]!.current.content).toBe(content || "original prompt");
    expect(page.plannerCalls[0]!.options.explicitTargetImageId).toBeUndefined();
    expect(page.bindings.imageTarget).toBeNull();
    expect(page.bindings.referenceImageIds).toEqual([]);
    expect(page.memory.attachments).toEqual([]);
    expect(page.memory.draft).toBe("");
    expect(page.sessionsRef.current).toHaveLength(2);
    expect(page.sessionsRef.current[1]).toEqual(original);
    expect(page.sessionsRef.current[0]).toMatchObject({ branchOf: { sessionId: original!.id, messageId: "old-user" } });
});

test("accepted images release the composer; out-of-order completion never steals the latest task focus", async () => {
    const firstResult = Promise.withResolvers<any[]>(), secondResult = Promise.withResolvers<any[]>();
    const page = pageSendHarness({ taskResult: firstResult.promise, plan: Promise.resolve({ kind: "image", action: "generate", prompt: "第一条要求", content: "第一张", references: [], workNote: { summary: "第一张", keep: [] } }) });
    const firstSend = page.send();
    for (let turn = 0; turn < 40 && (page.snapshots.length < 3 || page.bindings.activeSendRef.current); turn++) await Promise.resolve();
    expect(page.bindings.sendingRef.current).toBe(false);
    expect(page.bindings.imageRequestsRef.current.size).toBe(1);
    page.memory.draft = "第二条不同要求";
    page.bindings.requestCreativeChatPlan = async () => ({ kind: "image", action: "generate", prompt: "第二条要求", content: "第二张", references: [], workNote: { summary: "第二张", keep: [] } });
    page.bindings.requestGeneration = async (_config, _prompt, options) => { page.taskOptions.push(options); options.onSubmissionStarted?.(); await options.onSubmitted(["second-task"]); return secondResult.promise; };
    const secondSend = page.send();
    for (let turn = 0; turn < 40 && (page.taskOptions.length < 2 || page.bindings.activeSendRef.current); turn++) await Promise.resolve();
    expect(page.bindings.imageRequestsRef.current.size).toBe(2);
    expect(page.sessionsRef.current[0]!.messages.filter(item => item.pendingImageTask)).toHaveLength(2);
    secondResult.resolve([{ id: "result-b", sourceTaskId: "second-task", dataUrl: "data:image/png;base64,AgID" }]); await secondSend;
    expect(page.sessionsRef.current[0]!.focusImageId).toBe("second-task:0");
    firstResult.resolve([{ id: "result-a", sourceTaskId: "task-result", dataUrl: "data:image/png;base64,AQID" }]); await firstSend;
    expect(page.sessionsRef.current[0]!.focusImageId).toBe("second-task:0");
    expect(page.sessionsRef.current[0]!.messages.filter(item => item.generatedImages).map(item => item.generatedImages[0].id)).toEqual(["task-result:0", "second-task:0"]);
    expect(page.sessionsRef.current[0]!.messages.filter(item => item.role === "user")).toHaveLength(2);
    expect(page.bindings.imageRequestsRef.current.size).toBe(0);
});

test("task A completion during B's durable user-turn write cannot overwrite B in memory or on disk", async () => {
    const result = Promise.withResolvers<any[]>(), writeGate = Promise.withResolvers<void>(), writeStarted = Promise.withResolvers<void>();
    const page = pageSendHarness({ taskResult: result.promise, plan: Promise.resolve({ kind: "image", action: "generate", prompt: "A要求", content: "", references: [] }) });
    const firstSend = page.send();
    for (let turn = 0; turn < 40 && (page.snapshots.length < 3 || page.bindings.activeSendRef.current); turn++) await Promise.resolve();
    const previousSnapshotCount = page.snapshots.length;
    const save = page.bindings.persistSessions; let waitFirst = true;
    page.bindings.persistSessions = async value => { if (waitFirst) { waitFirst = false; writeStarted.resolve(); await writeGate.promise; } await save(value); };
    page.bindings.requestCreativeChatPlan = async () => ({ kind: "discussion", content: "B回复" });
    page.memory.draft = "B的新消息";
    const secondSend = page.send(); await writeStarted.promise;
    result.resolve([{ id: "result-a", sourceTaskId: "task-result", dataUrl: "data:image/png;base64,AQID" }]); await firstSend;
    expect(page.snapshots).toHaveLength(previousSnapshotCount);
    expect(page.sessionsRef.current[0]!.messages.some(item => item.generatedImages)).toBe(true);
    writeGate.resolve(); await secondSend;
    for (const snapshot of page.snapshots.slice(previousSnapshotCount) as any[]) expect(snapshot[0].messages.some((item: any) => item.content === "B的新消息")).toBe(true);
    const final = (page.snapshots.at(-1) as any[])[0];
    expect(final.messages.find((item: any) => item.generatedImages)?.generatedImages[0].id).toBe("task-result:0");
    expect(final.messages.at(-1).content).toBe("B回复");
});

test("an uncertain identical image signature is never resubmitted, but a different requirement can proceed", async () => {
    const page = pageSendHarness({ taskFailure: "submission", plan: Promise.resolve({ kind: "image", action: "generate", prompt: "原任务要求", content: "", references: [] }) });
    await page.send();
    page.memory.draft = "再次发送相同要求"; await page.send();
    expect(page.taskOptions).toHaveLength(1);
    expect(page.sessionsRef.current[0]!.messages.at(-1).content).toContain("已有相同要求");
    expect(page.sessionsRef.current[0]!.messages.filter(item => item.pendingImageTask)).toHaveLength(1);
    page.bindings.requestCreativeChatPlan = async () => ({ kind: "image", action: "generate", prompt: "另一条要求", content: "", references: [] });
    page.memory.draft = "不同要求"; await page.send();
    expect(page.taskOptions).toHaveLength(2);
    expect(page.sessionsRef.current[0]!.messages.filter(item => item.pendingImageTask)).toHaveLength(2);
});
