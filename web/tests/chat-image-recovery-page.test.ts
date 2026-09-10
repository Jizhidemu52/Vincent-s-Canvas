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
const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes("await recoverChatImageTask(")) effect = node.arguments[0];
    ts.forEachChild(node, visit);
};
visit(ast);
if (!effect) throw new Error("The actual chat image recovery effect was not found");
const effectCode = ts.transpileModule(`exports.run = ${effect.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

const pending: PendingChatImageTask = { requestId: "original-request", prompt: "保留中文，只改花瓣", modelId: "gpt-image-2.5-flare", action: "edit" };
const originalImage = "data:image/png;base64,cmVzdWx0LW9yaWdpbmFs";
const task = { id: "original-task", requestId: "original-request:0", status: "success", resultUrls: ["/api/assets/original/content"], failureReason: null };

async function recoveryPageHarness(options: { pending?: PendingChatImageTask; sourceGate?: Promise<void> } = {}) {
    const initial = [
        { id: "unrelated", messages: [{ id: "other", role: "user", content: "保留这段对话" }] },
        { id: "original-session", messages: [
            { id: "user-turn", role: "user", content: "把刚才那版花瓣改细", attachments: [{ dataUrl: "data:image/png;base64,c291cmNl" }] },
            { id: "original-assistant", role: "assistant", content: "图片任务已提交", pendingImageTask: options.pending || pending },
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
    const bindings = {
        sessionsReady: true, isSending: false, activeSession,
        pendingImageMessage: activeSession.messages[1],
        loadedStorageKeyRef: { current: "user-a" }, storageKey: "user-a", sessionsRef,
        updateSession(id: string, update: (session: any) => any) {
            if (bindings.loadedStorageKeyRef.current !== bindings.storageKey) return;
            sessionsRef.current = sessionsRef.current.map((session) => session.id === id ? update(session) : session);
        },
        persistence: { clear() {} },
        async persistSessions(value: unknown[]) { await storage.save("user-a", value); },
        setRecoveringImageTask(value: boolean) { recovering.push(value); if (!value) completed.resolve(); },
        async imageToDataUrl(image: { dataUrl: string }) { expect(image.dataUrl).toBe("/api/assets/original/content"); sourceStarted.resolve(); await options.sourceGate; return originalImage; },
        recoverChatImageTask(...args: Parameters<typeof recoverChatImageTask>) {
            signals.push(args[1]!.signal!);
            const result = recoverChatImageTask(...args);
            recoveryPromises.push(result);
            return result;
        },
    };
    const exports = {} as { run: () => () => void };
    new Function(...Object.keys(bindings), "exports", effectCode)(...Object.values(bindings), exports);
    const cleanup = exports.run();
    return { completed: completed.promise, sourceStarted: sourceStarted.promise, cleanup, database, writes, initial, sessionsRef, bindings, recovering, recoveryPromises, signals };
}

test.each([false, true])("the restored page writes the original task result into the original assistant message (saved taskId: %s)", async (hasTaskId) => {
    const requests: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (url, init) => {
        requests.push({ url: String(url), method: init?.method || "GET" });
        if (String(url) === "/api/tasks/original-task") return Response.json({ task });
        if (String(url) === "/api/tasks") return Response.json({ tasks: [{ ...task, id: "wrong-task", requestId: "another-request:0" }, task] });
        throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const page = await recoveryPageHarness({ pending: { ...pending, ...(hasTaskId ? { taskId: task.id } : {}) } });
    await page.completed;
    const saved = page.database.get("user-a") as any[];
    expect(requests).toEqual([{ url: hasTaskId ? "/api/tasks/original-task" : "/api/tasks", method: "GET" }]);
    expect(saved[0]).toEqual(page.initial[0]);
    expect(saved[1].id).toBe("original-session");
    expect(saved[1].messages).toHaveLength(2);
    expect(saved[1].messages[0]).toEqual(page.initial[1]!.messages[0]);
    expect(saved[1].messages[1]).toMatchObject({ id: "original-assistant", role: "assistant", generatedImages: [{ id: "original-task:0", dataUrl: originalImage, prompt: pending.prompt, modelId: pending.modelId }] });
    expect(saved[1].messages[1].pendingImageTask).toBeUndefined();
    expect(page.writes).toHaveLength(2);
    expect((page.writes[0]!.value as any[])[1].messages[1].pendingImageTask.taskId).toBe(task.id);
    expect(page.recovering).toEqual([true, false]);
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
