import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { projectCanvasImageConversationVersion } from "@/lib/canvas/canvas-image-conversation-projection";
import type { CanvasConversationRuntime } from "@/pages/canvas/canvas-image-conversation-runtime";
import { conversationVersion } from "./fixtures/image-conversation";

const projectSource = readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8");
const projectAst = ts.createSourceFile("project.tsx", projectSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const runtimeSource = readFileSync(new URL("../src/pages/canvas/canvas-image-conversation-runtime.ts", import.meta.url), "utf8");
const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function callback(name: string, context: CanvasConversationRuntime, loadRuntime: () => Promise<unknown>) {
    let declaration: ts.VariableDeclaration | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(projectAst) === name) declaration = node;
        ts.forEachChild(node, visit);
    };
    visit(projectAst);
    if (!declaration?.initializer || !ts.isCallExpression(declaration.initializer)) throw new Error(`Missing real callback ${name}`);
    const source = declaration.initializer.arguments[0]!.getText(projectAst).replace("await loadCanvasConversationRuntime()", "await loadRuntime()");
    return new Function("conversationRuntime", "loadRuntime", `${compile(`const callback = ${source};`)}; return callback;`)(context, loadRuntime);
}

function harness() {
    let ownerId = "employee-a", observing = true, writable = true, access: Promise<boolean> | undefined, persistence: Promise<void> | undefined;
    const writes: unknown[] = [], calls: string[] = [], sessions: unknown[] = [];
    const context: CanvasConversationRuntime = {
        ownerId, projectId: "canvas-a", designProjectIdRef: { current: "canvas-a" }, savedProjectIdRef: { current: "canvas-a" }, nodesRef: { current: [] },
        setNodes: nodes => { calls.push("publish"); context.nodesRef.current = typeof nodes === "function" ? nodes(context.nodesRef.current) : nodes; },
        projectSaveQueueRef: { current: { flush: () => { calls.push("queue"); } } },
        updateProject: (id, patch) => { calls.push("save"); writes.push({ id, patch }); },
        setChatSessions: value => { sessions.push(value); }, setActiveChatId: value => { sessions.push(value); },
        runtime: { isObservationCurrent: () => observing, waitForWriteAccess: async () => { calls.push("access"); return access ? await access : writable; } },
        containerRef: { current: null }, screenToCanvas: (x, y) => ({ x, y }), size: { width: 1000, height: 600 },
    };
    const dependencies: Record<string, unknown> = {
        "@/lib/canvas/canvas-image-conversation-projection": { projectCanvasImageConversationVersion },
        "@/stores/use-user-store": { useUserStore: { getState: () => ({ user: { id: ownerId } }) } },
        "@/stores/canvas/use-canvas-store": { flushCanvasPersistence: async () => { calls.push("persist"); await persistence; } },
    };
    const module = { exports: {} as typeof import("@/pages/canvas/canvas-image-conversation-runtime") };
    new Function("require", "module", "exports", compile(runtimeSource))((name: string) => dependencies[name], module, module.exports);
    const pending = Promise.withResolvers<typeof module.exports>();
    let loads = 0;
    const load = () => { loads++; return pending.promise; };
    return {
        context, calls, writes, sessions, runtime: module.exports,
        install: callback("installConversationVersion", context, load), saveSessions: callback("handleAssistantSessionsChange", context, load),
        loads: () => loads, loaded: () => pending.resolve(module.exports), failLoad: (error: Error) => pending.reject(error),
        owner: () => { ownerId = "employee-b"; }, project: () => { context.designProjectIdRef.current = "canvas-b"; },
        savedProject: () => { context.savedProjectIdRef.current = "canvas-b"; }, unmount: () => { observing = false; }, revoke: () => { writable = false; },
        delayAccess: (value: Promise<boolean>) => { access = value; }, delayPersistence: (value: Promise<void>) => { persistence = value; },
    };
}

test("the canvas route keeps conversation projection and persistence behind the operation import", () => {
    const imports = projectAst.statements.filter(ts.isImportDeclaration).map(node => (node.moduleSpecifier as ts.StringLiteral).text);
    expect(imports).not.toContain("@/lib/canvas/canvas-image-conversation-projection");
    expect(imports).not.toContain("./canvas-image-conversation-runtime");
    const app = harness();
    expect(app.loads()).toBe(0);
});

test("delayed concurrent callbacks use the latest graph and install the original asset only once", async () => {
    const app = harness(), version = conversationVersion(true);
    const first = app.install(version), duplicate = app.install(version);
    expect(app.calls).toEqual([]);
    const original = { ...projectCanvasImageConversationVersion([], { ...version, id: "existing-original" }, { x: 0, y: 0 })[0]!, id: "original-node" };
    app.context.nodesRef.current = [original];
    app.loaded(); await Promise.all([first, duplicate]);
    expect(app.context.nodesRef.current).toHaveLength(2);
    expect(app.context.nodesRef.current[0]).toBe(original);
    expect(app.context.nodesRef.current[1]!.metadata).toMatchObject({ serverAssetId: version.assetId, content: `/api/assets/${version.assetId}/content`, imageConversation: { versionId: version.id } });
    expect(app.calls.filter(call => call === "publish")).toHaveLength(1);
    expect(app.calls.slice(2, 6)).toEqual(["publish", "queue", "save", "persist"]);
});

for (const change of ["owner", "project", "savedProject", "unmount", "revoke"] as const) test(`a ${change} change while loading cannot install or persist a late image`, async () => {
    const app = harness(), operation = app.install(conversationVersion(true));
    app[change](); app.loaded();
    await expect(operation).rejects.toThrow("未安装图片结果");
    expect(app.context.nodesRef.current).toEqual([]);
    expect(app.writes).toEqual([]);
});

test("identity is checked again after awaiting write ownership and after durable save", async () => {
    const app = harness(), access = Promise.withResolvers<boolean>();
    app.delayAccess(access.promise); app.loaded();
    const operation = app.install(conversationVersion(true));
    await Promise.resolve(); app.owner(); access.resolve(true);
    await expect(operation).rejects.toThrow("未安装图片结果");
    expect(app.writes).toEqual([]);
    const saved = harness(), persistence = Promise.withResolvers<void>();
    saved.delayPersistence(persistence.promise); saved.loaded();
    const installing = saved.install(conversationVersion(true));
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(saved.writes).toHaveLength(1);
    saved.owner(); persistence.resolve();
    await expect(installing).rejects.toThrow("已停止继续安装图片");
    expect(saved.writes).toHaveLength(1);
});

test("a queued snapshot cannot write into a different owner after it flushes", async () => {
    const app = harness(); app.loaded();
    app.context.projectSaveQueueRef.current = { flush: app.owner };
    await expect(app.install(conversationVersion(true))).rejects.toThrow("画布写入权限已变化");
    expect(app.writes).toEqual([]);
});

test("server session pointers preserve queue-before-save ordering and reject late identities", async () => {
    const sessions = [{ id: "chat-a", serverConversationId: conversationVersion(true).conversationId }];
    const app = harness(), saving = app.saveSessions(sessions, "chat-a", { flush: true });
    expect(app.sessions).toEqual([]); app.loaded(); await saving;
    expect(app.calls).toEqual(["access", "queue", "save", "persist"]);
    expect(app.sessions).toEqual([sessions, "chat-a"]);
    const stale = harness(), late = stale.saveSessions(sessions, "chat-a", { flush: true });
    stale.owner(); stale.loaded();
    await expect(late).rejects.toThrow("会话编号尚未保存");
    expect(stale.sessions).toEqual([]); expect(stale.writes).toEqual([]);
});

test("legacy local sessions remain local and stale module loads cannot replace current drafts", async () => {
    const app = harness(), sessions = [{ id: "local-chat", messages: [] }];
    const saving = app.saveSessions(sessions, "local-chat"); app.loaded(); await saving;
    expect(app.sessions).toEqual([sessions, "local-chat"]); expect(app.calls).toEqual([]);
    const stale = harness(), late = stale.saveSessions(sessions, "local-chat");
    stale.project(); stale.loaded(); await late;
    expect(stale.sessions).toEqual([]); expect(stale.calls).toEqual([]);
});

test("a failed lazy module leaves the graph untouched and rejects the original action", async () => {
    const app = harness(), operation = app.install(conversationVersion(true));
    app.failLoad(new Error("offline"));
    await expect(operation).rejects.toThrow("offline");
    expect(app.calls).toEqual([]); expect(app.context.nodesRef.current).toEqual([]);
});
