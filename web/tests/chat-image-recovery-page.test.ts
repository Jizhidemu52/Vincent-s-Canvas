import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

import { createChatSessionStorage } from "@/pages/chat/chat-session-storage";
import { recoverChatImageTask, type PendingChatImageTask } from "@/services/api/chat-image-recovery";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const source = readFileSync(new URL("../src/pages/chat/index.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("chat.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect: ts.Expression | undefined;
let queryHandlerName: string | undefined;
const pageFunctions = new Map<string, ts.Expression>();
const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes("await recoverChatImageTask(")) effect = node.arguments[0];
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) pageFunctions.set(node.name.text, node.initializer);
    if (ts.isJsxElement(node) && node.children.some((child) => (ts.isJsxText(child) && child.text.trim() === "查询原任务") || (ts.isJsxExpression(child) && child.expression && ts.isCallExpression(child.expression) && child.expression.expression.getText(ast) === "uiText" && child.expression.arguments[0] && ts.isStringLiteral(child.expression.arguments[0]) && child.expression.arguments[0].text === "查询原任务"))) {
        const attribute = node.openingElement.attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText(ast) === "onClick");
        if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression && ts.isIdentifier(attribute.initializer.expression)) queryHandlerName = attribute.initializer.expression.text;
    }
    ts.forEachChild(node, visit);
};
visit(ast);
if (!effect) throw new Error("The actual chat image recovery effect was not found");
const queryHandler = queryHandlerName && pageFunctions.get(queryHandlerName);
if (!queryHandler) throw new Error("The original-task query button handler was not found");
const effectCode = ts.transpileModule(`exports.run = ${effect.getText(ast)}; exports.query = ${queryHandler.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

const pending: PendingChatImageTask = { requestId: "original-request", prompt: "保留中文，只改花瓣", modelId: "gpt-image-2.5-flare", quality: "high", action: "edit", parentMessageId: "user-turn", explanation: "只改花瓣，保留其余设计", lineage: { parentImageId: "old-task:0", sourceImageIds: ["old-task:0", "attachment-1"], preservedConstraints: ["保留中文", "保留版型"] } };
const originalImage = "data:image/png;base64,cmVzdWx0LW9yaWdpbmFs";
const task = { id: "original-task", requestId: "original-request:0", status: "success", resultUrls: ["/api/assets/original/content"], failureReason: null };

type ResumeRequest = { storageKey: string; sessionId: string; messageId: string; requestId: string; taskId?: string };
const matchingResumeRequest: ResumeRequest = { storageKey: "user-a", sessionId: "original-session", messageId: "original-assistant", requestId: pending.requestId, taskId: task.id };

async function recoveryPageHarness(options: { pending?: PendingChatImageTask; sourceGate?: Promise<void>; resumeRequest?: ResumeRequest; click?: boolean; stopped?: boolean } = {}) {
    const initial = [
        { id: "unrelated", messages: [{ id: "other", role: "user", content: "保留这段对话" }] },
        { id: "original-session", editTargetImageId: "old-task:0", messages: [
            { id: "user-turn", role: "user", content: "把刚才那版花瓣改细", attachments: [{ dataUrl: "data:image/png;base64,c291cmNl" }] },
            { id: "original-assistant", role: "assistant", content: "图片任务已提交", pendingImageTask: options.pending || pending, ...(options.stopped ? { stopped: true } : {}) },
        ] },
    ];
    const database = new Map<string, unknown>([["user-a", structuredClone(initial)], ["user-b", [{ id: "account-b", messages: [] }]]]);
    const writes: Array<{ key: string; value: unknown }> = [];
    const storage = createChatSessionStorage({
        async getItem<T>(key: string) { return structuredClone(database.get(key) ?? null) as T | null; },
        async setItem<T>(key: string, value: T) { writes.push({ key, value: structuredClone(value) }); database.set(key, structuredClone(value)); return value; },
    });
    // A new page instance obtains the marker from the persisted browser store.
    const sessionsRef = { current: await storage.load<any>("user-a", () => null) };
    const activeSession = sessionsRef.current[1]!;
    const completed = Promise.withResolvers<void>();
    const sourceStarted = Promise.withResolvers<void>();
    const recoveryPromises: Array<Promise<unknown>> = [];
    const signals: AbortSignal[] = [];
    const recovering: boolean[] = [];
    let reloadCount = 0;
    const bindings = {
        sessionsReady: true, isSending: false, activeSession,
        recoveringImageTask: false,
        pendingImageMessage: activeSession.messages[1],
        imageRecoveryRequestRef: { current: options.resumeRequest || null },
        loadedStorageKeyRef: { current: "user-a" }, storageKey: "user-a", sessionsRef,
        isCurrentScope: () => bindings.loadedStorageKeyRef.current === bindings.storageKey,
        chatMedia: { async persist(image: { dataUrl: string }, assertCurrent: () => void) { assertCurrent(); expect(image.dataUrl).toBe("/api/assets/original/content"); sourceStarted.resolve(); await options.sourceGate; assertCurrent(); return { ...image, dataUrl: originalImage }; } },
        updateSession(id: string, update: (session: any) => any) {
            if (bindings.loadedStorageKeyRef.current !== bindings.storageKey) return;
            sessionsRef.current = sessionsRef.current.map((session) => session.id === id ? update(session) : session);
        },
        persistence: { clear() {} },
        async persistSessions(value: unknown[]) { await storage.save("user-a", value); },
        setRecoveringImageTask(value: boolean) { recovering.push(value); if (!value) completed.resolve(); },
        setImageRecoveryReload(update: (value: number) => number) { reloadCount = update(reloadCount); },
        async imageToDataUrl(image: { dataUrl: string }) { expect(image.dataUrl).toBe("/api/assets/original/content"); sourceStarted.resolve(); await options.sourceGate; return originalImage; },
        recoverChatImageTask(...args: Parameters<typeof recoverChatImageTask>) {
            signals.push(args[1]!.signal!);
            const result = recoverChatImageTask(...args);
            recoveryPromises.push(result);
            return result;
        },
    };
    const exports = {} as { run: () => () => void; query: () => void };
    new Function(...Object.keys(bindings), "exports", effectCode)(...Object.values(bindings), exports);
    if (options.click) { exports.query(); exports.query(); expect(reloadCount).toBe(1); }
    const cleanup = exports.run();
    return { completed: completed.promise, sourceStarted: sourceStarted.promise, cleanup, run: exports.run, database, writes, initial, sessionsRef, bindings, recovering, recoveryPromises, signals };
}

test("a user-stopped image task stays locally paused across reloads until the original-task button is clicked", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async url => { requests.push(String(url)); return Response.json({ task }); }) as typeof fetch;
    const paused = await recoveryPageHarness({ stopped: true, pending: { ...pending, taskId: task.id } });
    await paused.completed;
    expect(requests).toEqual([]); expect(paused.writes).toEqual([]); expect(paused.cleanup).toBeUndefined();
    const resumed = await recoveryPageHarness({ stopped: true, pending: { ...pending, taskId: task.id }, click: true });
    await resumed.completed; expect(requests).toEqual(["/api/tasks/original-task"]);
    expect((resumed.database.get("user-a") as any[])[1].messages[1].generatedImages[0].id).toBe("original-task:0");
    resumed.cleanup();
});

test.each([false, true])("the restored page writes the original task result into the original assistant message (saved taskId: %s)", async (hasTaskId) => {
    const requests: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (url, init) => {
        requests.push({ url: String(url), method: init?.method || "GET" });
        if (String(url) === "/api/tasks/original-task") return Response.json({ task });
        if (String(url) === `/api/tasks/by-request/${encodeURIComponent(task.requestId)}`) return Response.json({ task });
        throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const page = await recoveryPageHarness({ pending: { ...pending, resolution: "4k", ...(hasTaskId ? { taskId: task.id } : {}) } });
    await page.completed;
    const saved = page.database.get("user-a") as any[];
    expect(requests).toEqual([{ url: hasTaskId ? "/api/tasks/original-task" : `/api/tasks/by-request/${encodeURIComponent(task.requestId)}`, method: "GET" }]);
    expect(saved[0]).toEqual(page.initial[0]);
    expect(saved[1].id).toBe("original-session");
    expect(saved[1].messages).toHaveLength(2);
    expect(saved[1].messages[0]).toEqual(page.initial[1]!.messages[0]);
    expect(saved[1].messages[1]).toMatchObject({ id: "original-assistant", parentMessageId: "user-turn", role: "assistant", generatedImages: [{ id: "original-task:0", dataUrl: originalImage, prompt: pending.prompt, modelId: pending.modelId, quality: "high", resolution: "4k", lineage: pending.lineage }] });
    expect(saved[1].editTargetImageId).toBe("original-task:0");
    expect(saved[1].messages[1].content).toContain(pending.explanation);
    expect(saved[1].messages[1].pendingImageTask).toBeUndefined();
    expect(page.writes).toHaveLength(2);
    expect((page.writes[0]!.value as any[])[1].messages[1].pendingImageTask).toEqual({ ...pending, resolution: "4k", taskId: task.id });
    expect(page.recovering).toEqual([true, false]);
    page.cleanup();
});

test("an explicit query token resumes only its verified original task and is consumed once", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (url, init) => {
        requests.push(`${init?.method || "GET"} ${url}`);
        return Response.json({ task: init?.method === "POST" ? task : { ...task, status: "paused", upstreamTaskId: "upstream-original" } });
    }) as typeof fetch;
    const page = await recoveryPageHarness({ pending: { ...pending, taskId: task.id }, click: true });
    await page.completed;
    expect(requests).toEqual(["GET /api/tasks/original-task", "POST /api/tasks/original-task/recover"]);
    expect(page.bindings.imageRecoveryRequestRef.current).toBeNull();
    expect((page.database.get("user-a") as any[])[1].messages[1].generatedImages[0].id).toBe("original-task:0");
    page.cleanup();

    const cleanup = page.run();
    await page.recoveryPromises.at(-1);
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(requests).toEqual(["GET /api/tasks/original-task", "POST /api/tasks/original-task/recover", "GET /api/tasks/original-task"]);
    cleanup();
});

test.each([
    { storageKey: "user-b" }, { sessionId: "different-session" }, { messageId: "another-assistant" },
    { requestId: "different-request" }, { taskId: "another-task" },
])("a query token cannot resume after its account, session, message, or task changes: %j", async (change) => {
    const requests: string[] = [];
    globalThis.fetch = (async (url, init) => {
        requests.push(`${init?.method || "GET"} ${url}`);
        return Response.json({ task: { ...task, status: "paused", upstreamTaskId: "upstream-original" } });
    }) as typeof fetch;
    const page = await recoveryPageHarness({ pending: { ...pending, taskId: task.id }, resumeRequest: { ...matchingResumeRequest, ...change } });
    await page.completed;
    expect(requests).toEqual(["GET /api/tasks/original-task"]);
    expect(page.bindings.imageRecoveryRequestRef.current).toBeNull();
    page.cleanup();
});

test.each(["paused", "missing", "failed"])("the restored page records %s without replaying a task", async (state) => {
    const requests: string[] = [];
    globalThis.fetch = (async (url, init) => {
        requests.push(`${init?.method || "GET"} ${url}`);
        return state === "missing" ? Response.json({}, { status: 404 }) : Response.json({ task: { ...task, status: state, failureReason: state === "paused" ? "提交状态不确定" : "原任务失败" } });
    }) as typeof fetch;
    const page = await recoveryPageHarness({ pending: { ...pending, taskId: task.id } });
    await page.completed;
    const reply = (page.database.get("user-a") as any[])[1].messages[1];
    expect(requests).toEqual(["GET /api/tasks/original-task"]);
    expect(reply.id).toBe("original-assistant");
    expect(reply.generatedImages).toBeUndefined();
    if (state === "failed") {
        expect(reply.role).toBe("error");
        expect(reply.pendingImageTask).toBeUndefined();
        expect(reply.content).toBe("原任务失败");
    } else {
        expect(reply.pendingImageTask).toMatchObject(pending);
        expect(reply.content).toContain("请勿重复生成");
    }
    page.cleanup();
});

test.each(["account-change", "unmount"])("recovery cannot save a fetched result after %s", async (reason) => {
    globalThis.fetch = (async () => Response.json({ task })) as typeof fetch;
    const gate = Promise.withResolvers<void>();
    const page = await recoveryPageHarness({ pending: { ...pending, taskId: task.id }, sourceGate: gate.promise });
    await page.sourceStarted;
    expect(page.writes).toHaveLength(1);
    if (reason === "account-change") {
        page.bindings.loadedStorageKeyRef.current = "user-b";
        page.sessionsRef.current = structuredClone(page.database.get("user-b") as any[]);
    }
    page.cleanup();
    gate.resolve();
    await Promise.allSettled(page.recoveryPromises);
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(page.signals[0]!.aborted).toBe(true);
    expect(page.writes).toHaveLength(1);
    expect((page.database.get("user-a") as any[])[1].messages[1].pendingImageTask.taskId).toBe(task.id);
    expect(page.database.get("user-b")).toEqual([{ id: "account-b", messages: [] }]);
});
