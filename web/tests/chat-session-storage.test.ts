import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

import { buildChatRequestMessages, type ChatHistoryMessage } from "@/lib/chat-context";
import { createChatSessionStorage } from "@/pages/chat/chat-session-storage";
import { preferredChatImageModel, resolveChatImageQuality } from "@/pages/chat/image-quality";

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

function pageSendHarness({ ready = true, failWrite = false, failWriteAt = 0, mode = "chat", creativeChat = true, creativeModelId = "gpt-6-astra", imageModels = [{ modelId: "gpt-image-2.5-flare", capabilities: ["generate", "edit"] }], taskFailure = "", plan = Promise.resolve<any>({ kind: "discussion", content: "只讨论设计" }), taskResult = Promise.resolve([{ id: "result", sourceTaskId: "task-result", dataUrl: "data:image/png;base64,cmVzdWx0" }]) } = {}) {
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
    const plannerCalls: Array<{ config: any; history: any[]; current: any; options: any }> = [];
    const taskOptions: Array<{ requestId: string; onSubmissionStarted?: () => void; onSubmitted: (taskIds: string[]) => void | Promise<void> }> = [];
    const memory: { draft: string; attachments: any[] } = { draft: "未发送的图片问题", attachments: [{ id: "image", name: "image.png", mimeType: "image/png", size: 3, dataUrl: "data:image/png;base64,AQID" }] };
    const session = { id: "session", mode, title: "新对话", editTargetImageId: undefined as string | undefined, imageModelId: undefined as string | undefined, messages: [] as any[] };
    const sessionsRef = { current: [session] };
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
        sessionsReady: ready, draft: memory.draft, attachments: memory.attachments, isSending: false, readingAttachments: false,
        activeSession: session, selectedModel: creativeModelId, selected: creativeModelId ? { modelId: creativeModelId, capabilities: ["chat"] } : undefined, imageModels, preferredChatImageModel, resolveChatImageQuality, config: {} as Record<string, string>,
        creativeChat, creativeModelId, sendingRef: { current: false }, placingImageRef: { current: false }, activeSendRef: { current: null as { controller: AbortController; submitted: boolean } | null },
        createClientId: () => `message-${++ids}`, buildChatRequestMessages, sessionsRef,
        preparingMessageRef: { current: false }, loadedStorageKeyRef: { current: "user-a" }, storageKey: "user-a",
        persistence: { clear: () => events.push("clear-pending") },
        setIsSending: (value: boolean) => events.push(`sending:${value}`),
        setSendPhase: (_value: string) => {},
        persistSessions: async (value: unknown) => { events.push("save"); if (failWrite || ++writes === failWriteAt) throw new Error("quota exceeded"); snapshots.push(structuredClone(value)); },
        updateSession: (id: string, update: (value: typeof session) => typeof session) => { if (bindings.loadedStorageKeyRef.current !== bindings.storageKey) return; sessionsRef.current = sessionsRef.current.map((item) => item.id === id ? update(item) : item); },
        setDraft: (update: (value: string) => string) => { memory.draft = update(memory.draft); },
        setAttachments: (update: (value: typeof memory.attachments) => typeof memory.attachments) => { memory.attachments = update(memory.attachments); },
        followBottomRef: { current: false }, activeStreamRef: { current: null },
        createChatStreamBuffer: () => ({ push() {}, cancel() {}, flush() {} }),
        requestImageQuestion: async () => { events.push("model-request"); return "已读取图片"; },
        requestCreativeChatPlan: async (config: any, history: any[], current: any, options: any) => { events.push("planner-request"); plannerCalls.push(structuredClone({ config, history, current, options: { selectedImageId: options.selectedImageId } })); return plan; },
        requestGeneration: async (_config: unknown, _prompt: string, options: typeof taskOptions[number]) => imageTask("generate", options),
        requestEdit: async (_config: unknown, _prompt: string, _references: unknown, _mask: unknown, options: typeof taskOptions[number]) => imageTask("edit", options),
        imageToDataUrl: async (image: { dataUrl: string }) => image.dataUrl,
        message: { warning: (value: string) => events.push(value), error: (value: string) => events.push(value) },
    };
    const code = ts.transpileModule(`const send = ${initializer.getText(ast)}; exports.send = send;`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    const send = () => {
        // Each user send runs with the current render snapshot, including the
        // previous generated answer and the newly typed (possibly text-only) turn.
        bindings.activeSession = sessionsRef.current[0]!;
        bindings.draft = memory.draft;
        bindings.attachments = memory.attachments;
        const module = { exports: {} as { send: () => Promise<void> } };
        new Function(...Object.keys(bindings), "module", "exports", code)(...Object.values(bindings), module, module.exports);
        return module.exports.send();
    };
    return { send, events, snapshots, memory, bindings, sessionsRef, taskOptions, plannerCalls };
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
    expect(page.events).toContain("聊天记录未保存，消息尚未发送；草稿和附件已保留。");
});

test("the actual chat send handler commits attachments before requesting and the final answer before finishing", async () => {
    const page = pageSendHarness();
    await page.send();
    expect(page.events.indexOf("save")).toBeLessThan(page.events.indexOf("planner-request"));
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
    const page = pageSendHarness({ imageModels: [{ modelId: "generate-only", capabilities: ["generate"] }], plan: Promise.resolve({ kind: "image", action: "edit", prompt: "只改花瓣", content: "", references: [] }) });
    await page.send();
    expect(page.plannerCalls).toHaveLength(1);
    expect(page.taskOptions).toEqual([]);
    expect(page.sessionsRef.current[0]!.messages.at(-1)).toMatchObject({ role: "error" });
    expect(page.sessionsRef.current[0]!.messages.at(-1).content).toContain("图片编辑服务");
});

test("after an image result, a text-only follow-up carries the generated version and ancestry automatically", async () => {
    const firstPlan = { kind: "image", action: "generate", prompt: "春日花卉", content: "", references: [], lineage: { sourceImageIds: [], preservedConstraints: ["保留中文"] } };
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
    expect(page.plannerCalls[1]!.history.at(-1).generatedImages[0]).toMatchObject({ id: "task-result:0", dataUrl: "data:image/png;base64,cmVzdWx0", lineage: firstPlan.lineage });
});

test.each([true, false])("creative sending always uses the planner even with legacy creativeChat=%s", async (creativeChat) => {
    const page = pageSendHarness({ mode: "create", creativeChat });
    await page.send();
    expect(page.events.filter((event) => event === "planner-request")).toHaveLength(1);
    expect(page.events.filter((event) => event.endsWith("-task"))).toEqual([]);
    expect(page.events).not.toContain("model-request");
    expect(page.sessionsRef.current[0]!.messages.at(-1).content).toBe("只讨论设计");
});

test.each([true, false])("missing creative understanding model preserves the unsent draft and blocks all requests (legacy toggle %s)", async (creativeChat) => {
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

test.each(["generate", "edit"])("the actual creative send handler submits one %s task and persists the original result", async (action) => {
    const lineage = { parentImageId: "old-task:0", sourceImageIds: ["old-task:0", "attachment-1"], preservedConstraints: ["保留中文", "保留版型"] };
    const page = pageSendHarness({ mode: "create", plan: Promise.resolve({ kind: "image", action, prompt: "完整要求", content: "只改花瓣，保留其余设计", lineage, references: [{ id: "original", dataUrl: "data:image/png;base64,AQID" }] }) });
    await Promise.all([page.send(), page.send()]);
    expect(page.events.filter((event) => event === "planner-request")).toHaveLength(1);
    expect(page.events.filter((event) => event.endsWith("-task"))).toEqual([`${action}-task`]);
    const session = (page.snapshots.at(-1) as any[])[0];
    expect(session.chatModelId).toBe("gpt-6-astra");
    expect(session.imageModelId).toBe("gpt-image-2.5-flare");
    expect(session.messages.at(-1).generatedImages[0]).toMatchObject({ dataUrl: "data:image/png;base64,cmVzdWx0", modelId: "gpt-image-2.5-flare", prompt: "完整要求", lineage });
    expect(session.messages.at(-1).generatedImages[0].id).toBe("task-result:0");
    expect(session.editTargetImageId).toBe("task-result:0");
    expect(session.messages.at(-1).parentMessageId).toBe(session.messages[0].id);
    expect(session.messages.at(-1).content).toBe("");
    const prepared = (page.snapshots[1] as any[])[0].messages.at(-1).pendingImageTask;
    expect(prepared).toEqual({ requestId: page.taskOptions[0]!.requestId, prompt: "完整要求", modelId: "gpt-image-2.5-flare", quality: "auto", action, parentMessageId: session.messages[0].id, lineage, explanation: "只改花瓣，保留其余设计" });
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

test("a persisted pending image request blocks a new send in the same conversation", async () => {
    const page = pageSendHarness({ mode: "create" });
    page.bindings.activeSession.messages.push({ id: "assistant", role: "assistant", pendingImageTask: { requestId: "original-request" } });
    await page.send();
    expect(page.events).toEqual(["本会话有尚未核实的图片任务，请先查询原任务，勿重复生成"]);
    expect(page.snapshots).toEqual([]);
});

test.each(["account-change", "unmount"])("a submitted image task retains its recovery marker without writing to another session after %s", async (reason) => {
    const result = Promise.withResolvers<Array<{ id: string; sourceTaskId: string; dataUrl: string }>>();
    const page = pageSendHarness({ mode: "create", taskResult: result.promise, plan: Promise.resolve({ kind: "image", action: "generate", prompt: "原任务提示词", content: "", references: [] }) });
    const pending = page.send();
    for (let turn = 0; turn < 10 && page.snapshots.length < 3; turn += 1) await Promise.resolve();
    expect(page.bindings.activeSendRef.current!.submitted).toBe(true);
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
    await Promise.resolve();
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
    await Promise.resolve();
    decision.reject(new Error("upstream unavailable"));
    await pending;
    expect(page.events.filter((event) => event === "planner-request")).toHaveLength(1);
    expect(page.events.filter((event) => event.endsWith("-task"))).toEqual([]);
});
