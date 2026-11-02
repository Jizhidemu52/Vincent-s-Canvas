import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { recoverChatImageTask, type PendingChatImageTask } from "@/services/api/chat-image-recovery";
import { completeChatImageTask, chatImageTaskSignature, duplicateChatImageTask } from "@/pages/chat/chat-image-tasks";
import type { ChatMessage, ChatSession } from "@/pages/chat/chat-types";
import type { watchTaskReconciliation } from "@/services/api/task-result-reconciliation";

const ast = ts.createSourceFile("recovery.ts", readFileSync(new URL("../src/pages/chat/use-chat-task-recovery.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "useChatTaskRecovery")!;
const code = ts.transpileModule(declaration.getText(ast).replace(/^export /, "") + "\nexports.hook = useChatTaskRecovery;", { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function until(predicate: () => boolean) {
    for (let index = 0; index < 60 && !predicate(); index++) await tick();
    expect(predicate()).toBe(true);
}
const pending = (id: string, extra: Partial<PendingChatImageTask> = {}): PendingChatImageTask => ({ requestId: id, taskId: "task-" + id, prompt: "只改配色", modelId: "fixture", action: "edit", parentId: "original", workId: "original", workNote: { summary: "浅蓝", keep: ["版型"] }, focusRevision: 1, ...extra });
const pendingMessage = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: "message-" + id, role: "assistant", content: "等待", createdAt: "", pendingImageTask: pending(id), ...extra });
const session = (messages: ChatMessage[]): ChatSession => ({ id: "session-a", title: "A", focusImageId: "original", focusRevision: 1, messages, updatedAt: "" });
const serverTask = (id: string, status = "success", extra = {}) => ({ id: "task-" + id, requestId: id + ":0", status, resultUrls: ["/api/assets/" + id + "/content"], failureReason: null, ...extra });

function recoveryHarness(initial: ChatSession, activeIds = new Set<string>(), persistGate?: Promise<void>) {
    const sessionsRef = { current: [initial] };
    const writes: ChatSession[][] = [], watches: Array<Parameters<typeof watchTaskReconciliation>[0]> = [], media: string[] = [];
    let storageKey = "owner-a", selectedId = initial.id, alive = true;
    const refs: any[] = [], states: any[] = [], effects: Array<{ dependencies: unknown[]; cleanup?: () => void }> = [];
    let refIndex = 0, stateIndex = 0, effectIndex = 0;
    const queuedEffects: Array<() => void> = [];
    const exports = {} as { hook: (options: any) => { checking: ReadonlySet<string>; query: (message: ChatMessage) => void } };
    let output: ReturnType<typeof exports.hook>;
    const bindings = {
        useRef(value: unknown) { const index = refIndex++; return refs[index] ||= { current: value }; },
        useState(value: unknown) { const index = stateIndex++; if (!(index in states)) states[index] = value; return [states[index], (update: any) => { states[index] = typeof update === "function" ? update(states[index]) : update; }]; },
        useEffect(callback: () => void | (() => void), dependencies: unknown[]) {
            const index = effectIndex++, previous = effects[index];
            if (previous && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
            effects[index] = { dependencies };
            queuedEffects.push(() => { previous?.cleanup?.(); effects[index]!.cleanup = callback() || undefined; });
        },
        recoverChatImageTask, completeChatImageTask,
        restoreChatMaskResult: async (_pending: unknown, url: string) => url,
        chatMedia: { async persist(image: any, assertCurrent: () => void) { assertCurrent(); media.push(image.dataUrl); await persistGate; assertCurrent(); return { ...image, storageKey: "image:" + image.id }; } },
        async watchTaskReconciliation(options: Parameters<typeof watchTaskReconciliation>[0]) {
            watches.push(options);
            if (!options.signal.aborted) await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
        },
    };
    new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exports);
    function render() {
        refIndex = 0; stateIndex = 0; effectIndex = 0;
        output = exports.hook({
            storageKey, session: sessionsRef.current.find(item => item.id === selectedId), ready: alive, sessionsRef, activeRequestIds: activeIds,
            isCurrentScope: () => alive,
            updateSession(id: string, update: (session: ChatSession) => ChatSession) { sessionsRef.current = sessionsRef.current.map(item => item.id === id ? update(item) : item); },
            async persist() { writes.push(structuredClone(sessionsRef.current)); },
        });
        for (const effect of queuedEffects.splice(0)) effect();
    }
    render();
    return {
        sessionsRef, writes, watches, media,
        query(id: string) { output.query(sessionsRef.current[0]!.messages.find(item => item.id === "message-" + id)!); },
        render,
        checking: () => { render(); return output.checking; },
        async wake() { await Promise.all(watches.filter(item => !item.signal.aborted).map(item => item.reconcile())); },
        changeScope(key: string) { storageKey = key; alive = false; render(); },
        select(id: string) { selectedId = id; render(); },
        cleanup() { alive = false; for (const effect of effects) effect.cleanup?.(); },
    };
}

test("each restored pending message has an independent exact-ID observer", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async url => { calls.push(String(url)); const id = String(url).endsWith("task-a") ? "a" : "b"; return Response.json({ task: serverTask(id) }); }) as typeof fetch;
    const page = recoveryHarness(session([pendingMessage("a"), pendingMessage("b")]));
    await until(() => page.sessionsRef.current[0]!.messages.every(item => !item.pendingImageTask));
    expect(calls.sort()).toEqual(["/api/tasks/task-a", "/api/tasks/task-b"]);
    expect(page.sessionsRef.current[0]!.messages.map(item => item.generatedImages?.[0]?.id)).toEqual(["task-a:0", "task-b:0"]);
    expect(page.writes.length).toBeGreaterThanOrEqual(2);
    expect(page.sessionsRef.current[0]?.focusImageId).toBe("task-a:0");
    page.cleanup();
});

test("a new user-selected focus survives late recovery and the original answer slot is reused", async () => {
    globalThis.fetch = (async () => Response.json({ task: serverTask("a") })) as typeof fetch;
    const source = session([pendingMessage("a"), { id: "new-turn", role: "user", content: "改新图", createdAt: "" }]);
    source.focusImageId = "newer-selection"; source.focusRevision = 3; source.focusLocked = true;
    const page = recoveryHarness(source);
    await until(() => Boolean(page.sessionsRef.current[0]?.messages[0]?.generatedImages));
    expect(page.sessionsRef.current[0]).toMatchObject({ focusImageId: "newer-selection", focusLocked: true, focusRevision: 3 });
    expect(page.sessionsRef.current[0]!.messages.map(item => item.id)).toEqual(["message-a", "new-turn"]);
    expect(page.sessionsRef.current[0]!.messages[0]).toMatchObject({ generatedImages: [{ parentId: "original", workId: "original", workNote: { summary: "浅蓝" } }] });
    page.cleanup();
});

test("live submitted requests are not duplicated by recovery while unrelated pending tasks proceed", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async url => { calls.push(String(url)); return Response.json({ task: serverTask("b") }); }) as typeof fetch;
    const page = recoveryHarness(session([pendingMessage("a"), pendingMessage("b")]), new Set(["a"]));
    await until(() => Boolean(page.sessionsRef.current[0]?.messages[1]?.generatedImages));
    expect(calls).toEqual(["/api/tasks/task-b"]);
    expect(page.sessionsRef.current[0]?.messages[0]?.pendingImageTask?.requestId).toBe("a");
    page.cleanup();
});

test("stopped observation survives reload; a manual query resumes only the original observer", async () => {
    let complete = false;
    const calls: string[] = [];
    globalThis.fetch = (async url => { calls.push(String(url)); return Response.json({ task: serverTask("a", complete ? "success" : "processing") }); }) as typeof fetch;
    const page = recoveryHarness(session([pendingMessage("a", { stopped: true })]));
    await tick(); expect(calls).toEqual([]);
    page.query("a"); page.query("a");
    await until(() => page.watches.length === 1);
    expect(calls).toEqual(["/api/tasks/task-a"]);
    complete = true; await page.wake();
    expect(page.sessionsRef.current[0]?.messages[0]?.generatedImages?.[0]?.id).toBe("task-a:0");
    expect(page.sessionsRef.current[0]?.messages[0]?.stopped).toBeUndefined();
    page.cleanup();
});

test("only an explicit resume click issues one recover POST; no generation POST exists", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url, init) => { calls.push((init?.method || "GET") + " " + url); return Response.json({ task: serverTask("a", init?.method === "POST" ? "success" : "paused", { upstreamTaskId: "upstream-a" }) }); }) as typeof fetch;
    const page = recoveryHarness(session([pendingMessage("a")]));
    await until(() => page.sessionsRef.current[0]?.messages[0]?.pendingImageTask?.recovery === "resume");
    expect(calls).toEqual(["GET /api/tasks/task-a"]);
    page.query("a"); page.query("a");
    await until(() => Boolean(page.sessionsRef.current[0]?.messages[0]?.generatedImages));
    expect(calls).toEqual(["GET /api/tasks/task-a", "GET /api/tasks/task-a", "POST /api/tasks/task-a/recover"]);
    page.cleanup();
});

test.each(["missing", "paused", "failed"])("%s request affects only its own pending slot", async status => {
    const calls: string[] = [];
    globalThis.fetch = (async url => {
        calls.push(String(url));
        if (String(url).endsWith("task-b")) return Response.json({ task: serverTask("b") });
        return status === "missing" ? Response.json({}, { status: 404 }) : Response.json({ task: serverTask("a", status, { upstreamTaskId: null, failureReason: "失败" }) });
    }) as typeof fetch;
    const page = recoveryHarness(session([pendingMessage("a"), pendingMessage("b")]));
    await until(() => Boolean(page.sessionsRef.current[0]?.messages[1]?.generatedImages));
    const original = page.sessionsRef.current[0]!.messages[0]!;
    if (status === "failed") { expect(original.role).toBe("error"); expect(original.pendingImageTask).toBeUndefined(); }
    else expect(original.pendingImageTask?.recovery).toBe("investigate");
    expect(calls).toHaveLength(2);
    expect(page.watches).toHaveLength(0);
    page.cleanup();
});

test.each(["owner", "session", "unmount"])("late fetched media cannot be written after %s changes", async changed => {
    globalThis.fetch = (async () => Response.json({ task: serverTask("a") })) as typeof fetch;
    const gate = Promise.withResolvers<void>();
    const page = recoveryHarness(session([pendingMessage("a")]), new Set(), gate.promise);
    await until(() => page.media.length === 1);
    const writes = page.writes.length;
    if (changed === "owner") page.changeScope("owner-b"); else if (changed === "session") page.select("another"); else page.cleanup();
    gate.resolve(); await tick(); await tick();
    expect(page.sessionsRef.current[0]?.messages[0]?.generatedImages).toBeUndefined();
    expect(page.writes).toHaveLength(writes);
    page.cleanup();
});

test("equal unresolved signatures are blocked, different prompt/base/model/mask remain independent", () => {
    const first = pending("a");
    first.signature = chatImageTaskSignature(first);
    const current = session([pendingMessage("a", { pendingImageTask: first })]);
    expect(duplicateChatImageTask(current, pending("new-request"))?.id).toBe("message-a");
    for (const extra of [{ prompt: "另一条要求" }, { modelId: "other-model" }, { parentId: "other-base" }, { referenceImageIds: ["reference"] }, { maskAdaptation: { maskStorageKey: "another-mask" } }]) expect(duplicateChatImageTask(current, pending("new", extra as Partial<PendingChatImageTask>))).toBeUndefined();
    expect(completeChatImageTask(current, "wrong-message", first, [{ id: "result", dataUrl: "data:image/png;base64,AQID" }])).toBe(current);
});
