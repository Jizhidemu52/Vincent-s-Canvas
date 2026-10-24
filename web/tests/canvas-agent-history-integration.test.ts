import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import ts from "typescript";
import { applyCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasAgentUndoRecord } from "@/lib/canvas/canvas-agent-undo";
import * as undoAction from "@/lib/canvas/canvas-agent-undo-action";
import { parseCanvasProject, serializeCanvasProject } from "@/lib/canvas/canvas-project-codec";
import type { CanvasHistorySnapshot, CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType } from "@/types/canvas";
import { canvasGenerationRunsForNodes } from "@/lib/canvas/canvas-project-async-lifecycle";

// Run the actual editor callbacks, restore layout effect, and autosave effect.
// The harness replaces only React setters/timers and unrelated generation/UI services.
const sources = ["project.tsx", "use-canvas-history.ts", "use-canvas-persistence.ts"]
    .map(file => readFileSync(new URL(`../src/pages/canvas/${file}`, import.meta.url), "utf8"));
const ast = ts.createSourceFile("project.tsx", sources.join("\n"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbackOrder = ["createHistoryEntry", "applyHistory", "flushPendingHistory", "undoCanvas", "redoCanvas", "currentAgentSnapshot", "commitAgentSnapshot", "applyAgentOps", "undoAgentOps"];
const callbackText = new Map<string, string>();
const effects = new Map<string, string>();
function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && callbackOrder.includes(node.name.text)) callbackText.set(node.name.text, `const ${node.getText(ast)};`);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const text = node.arguments[0]?.getText(ast) || "";
        if (node.expression.text === "useLayoutEffect" && text.includes("const restored = pendingHistoryEntryRef.current")) effects.set("restore", text);
        if (node.expression.text === "useEffect" && text.includes("historyCommitTimerRef.current = setTimeout(flushPendingHistory")) effects.set("history", text);
        if (node.expression.text === "useEffect" && text.includes("projectSaveQueueRef.current?.schedule")) effects.set("save", text);
        if (node.expression.text === "useEffect" && text.includes("agentCloseTimerRef.current") && text.includes("abortPendingCanvasRequests")) effects.set("unmount", text);
    }
    ts.forEachChild(node, collect);
}
collect(ast);
const transpile = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
const helpers = ast.statements.filter(statement => ts.isFunctionDeclaration(statement) && ["boundedCanvasHistory", "canvasHistoryForSave"].includes(statement.name?.text || ""))
    .map(statement => statement.getText(ast).replace(/^export\s+/, "")).join("\n");
const commandCode = transpile(`${helpers}\n${callbackOrder.map(name => callbackText.get(name)).join("\n")}\nreturn { ${callbackOrder.join(", ")}, canvasHistoryForSave };`);
const effectCode = new Map([...effects].map(([name, source]) => [name, transpile(`return (${source})();`)]));

function project(): CanvasProject {
    return {
        id: "test", title: "Test", createdAt: "before", updatedAt: "now", viewport: { x: 0, y: 0, k: 1 },
        nodes: ["one", "two"].map(id => ({ id, type: CanvasNodeType.Text, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: id } })),
        connections: [], groups: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false,
    };
}
const frame = ({ nodes, connections, groups, chatSessions, activeChatId, backgroundMode, showImageInfo }: CanvasProject): CanvasHistorySnapshot => ({ nodes, connections, groups, chatSessions, activeChatId, backgroundMode, showImageInfo });

function editor(initial = project(), previous = frame(initial), loadUndoAction: () => Promise<typeof undoAction> = async () => undoAction) {
    let live = initial;
    let canUndoAgent = false;
    const historyRef = { current: initial.history || { past: [], future: [] } };
    const lastHistoryRef = { current: previous };
    const applyingHistoryRef = { current: false };
    const pendingHistoryEntryRef = { current: null as CanvasHistorySnapshot | null };
    const historyPausedRef = { current: false };
    const historyCommitTimerRef = { current: null as number | null };
    const agentUndoRecordRef = { current: null as CanvasAgentUndoRecord | null };
    const selectedNodeIdsRef = { current: new Set<string>() };
    const generationRequestsRef = { current: new Map<string, { targetNodeId: string; originNodeId: string; runningNodeId: string }>() };
    const timers = new Map<number, () => void>();
    let timerId = 0;
    const warnings: unknown[] = [], successes: string[] = [], errors: string[] = [];
    const stopped: unknown[][] = [];
    let queuedSave: { patch: CanvasHistorySnapshot & { history: CanvasProject["history"] } } | null = null;
    const scope = {
        React, useCallback: (callback: unknown) => callback, applyCanvasAgentOps, canvasGenerationRunsForNodes,
        stopGenerationByRunningId: (...args: unknown[]) => stopped.push(args),
        require: (path: string) => {
            if (path !== "@/lib/canvas/canvas-agent-undo-action") throw new Error(`Unexpected dynamic import: ${path}`);
            return loadUndoAction();
        },
        projectId: initial.id, currentProject: initial, projectLoaded: true, usePerformanceScenario: false, batchEditRunning: false, runningNodeId: null,
        historyRef, lastHistoryRef, applyingHistoryRef, pendingHistoryEntryRef, historyPausedRef, historyCommitTimerRef, agentUndoRecordRef, selectedNodeIdsRef, generationRequestsRef,
        nodesRef: { get current() { return live.nodes; }, set current(nodes) { live = { ...live, nodes }; } },
        connectionsRef: { get current() { return live.connections; }, set current(connections) { live = { ...live, connections }; } },
        viewportRef: { get current() { return live.viewport; }, set current(viewport) { live = { ...live, viewport }; } },
        groupsRef: { get current() { return live.groups || []; } },
        historyChatRef: { get current() { return { chatSessions: live.chatSessions, activeChatId: live.activeChatId }; } },
        setNodes: (nodes: CanvasProject["nodes"]) => { live = { ...live, nodes }; },
        setConnections: (connections: CanvasProject["connections"]) => { live = { ...live, connections }; },
        setGroups: (groups: CanvasProject["groups"]) => { live = { ...live, groups }; },
        setViewport: (viewport: CanvasProject["viewport"]) => { live = { ...live, viewport }; },
        setBackgroundMode: (backgroundMode: CanvasProject["backgroundMode"]) => { live = { ...live, backgroundMode }; },
        setShowImageInfo: (showImageInfo: boolean) => { live = { ...live, showImageInfo }; },
        setChatSessions: (chatSessions: CanvasProject["chatSessions"]) => { live = { ...live, chatSessions }; },
        setActiveChatId: (activeChatId: string | null) => { live = { ...live, activeChatId }; },
        setSelectedNodeIds: (ids: Set<string>) => { selectedNodeIdsRef.current = ids; },
        setCanUndoAgentOps: (value: boolean) => { canUndoAgent = value; },
        setSelectedConnectionId() {}, setContextMenu() {}, setHistoryState() {},
        backgroundMode: live.backgroundMode, showImageInfo: live.showImageInfo,
        setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
        clearTimeout: (id: number) => { timers.delete(id); },
        queueMicrotask: (callback: () => void) => callback(), generateNodeRef: { current: () => undefined },
        hasPendingImageTask: () => false, NODE_STATUS_LOADING: "loading", NODE_STATUS_ERROR: "error", INTERRUPTED_IMAGE_TASK_ERROR: "interrupted",
        modal: { warning: (value: unknown) => warnings.push(value) }, message: { success: (value: string) => successes.push(value), error: (value: string) => errors.push(value) },
        projectSaveQueueRef: { current: { schedule: (value: typeof queuedSave) => { queuedSave = value; } } },
        agentCloseTimerRef: { current: null }, abortPendingCanvasRequests() {}, textStreamBufferRef: { current: null },
        transientTimeoutsRef: { current: { clearAll() {} } }, rafRef: { current: null }, connectionPreviewFrameRef: { current: null }, cancelAnimationFrame() {},
    };
    const actions = new Function("scope", `const { ${Object.keys(scope).join(", ")} } = scope;\n${commandCode}`)(scope) as {
        applyAgentOps: (ops: CanvasAgentOp[]) => CanvasAgentSnapshot; undoAgentOps: () => Promise<CanvasAgentSnapshot | null>;
        undoCanvas: () => void; redoCanvas: () => void; flushPendingHistory: () => void; createHistoryEntry: () => CanvasHistorySnapshot;
        canvasHistoryForSave: unknown;
    };
    const runEffect = (name: string) => {
        const current = { ...scope, ...actions, ...frame(live) };
        return new Function("scope", `const { ${Object.keys(current).join(", ")} } = scope;\n${effectCode.get(name)}`)(current);
    };
    return {
        ...actions, historyRef, applyingHistoryRef, generationRequestsRef, warnings, successes, errors, timers, stopped,
        live: () => live, canUndoAgent: () => canUndoAgent, undoRecord: () => agentUndoRecordRef.current,
        edit: (patch: Partial<CanvasProject>) => { live = { ...live, ...patch }; },
        clearAgentPatch: () => { agentUndoRecordRef.current = null; canUndoAgent = false; },
        unmount: () => runEffect("unmount")(),
        undo: () => { actions.undoCanvas(); runEffect("restore"); },
        redo: () => { actions.redoCanvas(); runEffect("restore"); },
        runHistoryEffect: () => runEffect("history"),
        save: () => { runEffect("save"); return parseCanvasProject(serializeCanvasProject({ ...live, ...queuedSave!.patch })); },
    };
}

function chat(text: string): CanvasProject["chatSessions"] {
    return [{ id: "chat", title: "Chat", createdAt: "before", updatedAt: "now", messages: [{ id: text, role: "assistant", text }] }];
}

describe("agent inverse and ordinary history integration", () => {
    test("agent deletion stops dependent observations and its inverse can restore the graph", async () => {
        const app = editor();
        app.generationRequestsRef.current.set("run", { targetNodeId: "one", originNodeId: "one", runningNodeId: "run" });
        app.applyAgentOps([{ type: "delete_node", id: "one" }]);
        expect(app.stopped).toEqual([["run", true]]);
        expect(app.live().nodes.map(node => node.id)).toEqual(["two"]);
        app.generationRequestsRef.current.clear();
        await app.undoAgentOps();
        expect(app.live().nodes.map(node => node.id)).toContain("one");
    });
    test("pending manual edit, agent batch, later edit, inverse, Ctrl+Z and redo stay separate", async () => {
        const base = project();
        const manual = { ...base, nodes: [{ ...base.nodes[0], width: 150 }, base.nodes[1]] };
        const app = editor(manual, frame(base));
        app.applyAgentOps([{ type: "update_node", id: "one", patch: { title: "Agent" } }]);
        app.edit({ nodes: [app.live().nodes[0], { ...app.live().nodes[1], title: "Later user" }], chatSessions: chat("New answer"), activeChatId: "chat" });
        const result = await app.undoAgentOps();
        expect(result?.undoReport).toEqual({ applied: 1, conflicts: [], retryable: false });
        expect(app.live().nodes.map(node => node.title)).toEqual(["one", "Later user"]);
        expect(app.live().nodes[0].width).toBe(150);
        expect(app.historyRef.current.past).toHaveLength(4);
        app.undo();
        expect(app.live().nodes.map(node => node.title)).toEqual(["Agent", "Later user"]);
        expect(app.live().chatSessions).toEqual(chat("New answer"));
        expect(app.applyingHistoryRef.current).toBe(false);
        app.redo();
        expect(app.live().nodes.map(node => node.title)).toEqual(["one", "Later user"]);
        expect(app.live().chatSessions).toEqual(chat("New answer"));
    });

    test("pure chat creates no undo timer or step and preserves an existing redo", () => {
        const base = project();
        const next = { ...frame(base), nodes: [{ ...base.nodes[0], title: "Redo" }, base.nodes[1]], chatSessions: chat("Old answer") };
        const app = editor({ ...base, history: { past: [], future: [next] } });
        app.edit({ chatSessions: chat("Streaming latest"), activeChatId: "chat" });
        app.runHistoryEffect();
        expect(app.timers.size).toBe(0);
        expect(app.historyRef.current).toEqual({ past: [], future: [next] });
        const restored = app.save();
        expect(restored.chatSessions).toEqual(chat("Streaming latest"));
        expect(restored.activeChatId).toBe("chat");
        expect(restored.history?.past).toEqual([]);
        expect(restored.history?.future).toHaveLength(1);
        const refreshed = editor(restored);
        refreshed.redo();
        expect(refreshed.live().nodes[0].title).toBe("Redo");
        expect(refreshed.live().chatSessions).toEqual(chat("Streaming latest"));
        refreshed.undo();
        expect(refreshed.live().nodes[0].title).toBe("one");
        expect(refreshed.save().chatSessions).toEqual(chat("Streaming latest"));
    });

    test("a field conflict reports partial progress and does not replay already-completed fields", async () => {
        const app = editor();
        app.applyAgentOps([{ type: "update_node", id: "one", patch: { title: "Agent", width: 200 } }]);
        app.edit({ nodes: [{ ...app.live().nodes[0], title: "User" }, app.live().nodes[1]] });
        const partial = await app.undoAgentOps();
        expect(partial?.undoReport?.applied).toBe(1);
        expect(partial?.undoReport?.conflicts).toHaveLength(1);
        expect(app.undoRecord()).toHaveProperty("changes");
        expect(app.undoRecord()).not.toHaveProperty("before");
        expect(app.warnings).toHaveLength(1);
        expect(app.canUndoAgent()).toBe(true);
        app.edit({ nodes: [{ ...app.live().nodes[0], title: "Agent", width: 250 }, app.live().nodes[1]] });
        await app.undoAgentOps();
        expect(app.live().nodes[0]).toMatchObject({ title: "one", width: 250 });
        expect(app.canUndoAgent()).toBe(false);
        expect(app.successes).toHaveLength(1);
    });

    test("page integration supplies group and active-generation protections", async () => {
        for (const dependency of ["group", "generation"]) {
            const app = editor();
            app.applyAgentOps([{ type: "add_node", id: "new" }]);
            if (dependency === "group") app.edit({ groups: [{ id: "group", title: "Style", nodeIds: ["new"] }] });
            else app.generationRequestsRef.current.set("request", { targetNodeId: "new", originNodeId: "one", runningNodeId: "new" });
            const result = await app.undoAgentOps();
            expect(app.live().nodes.some(node => node.id === "new")).toBe(true);
            expect(result?.undoReport?.conflicts[0].reason).toContain(dependency === "group" ? "款式组" : "生成任务");
            expect(app.warnings).toHaveLength(1);
        }
    });

    test("writes remain synchronous and the inverse module loads only on an actual undo", async () => {
        let loads = 0;
        const base = project();
        const app = editor(base, frame(base), async () => { loads++; return undoAction; });
        expect(await app.undoAgentOps()).toBeNull();
        const written = app.applyAgentOps([{ type: "update_node", id: "one", patch: { title: "Agent" } }]);
        expect(written).not.toBeInstanceOf(Promise);
        expect(written.nodes[0].title).toBe("Agent");
        const record = app.undoRecord();
        if (!record || "changes" in record) throw new Error("Expected deferred reference capture");
        expect(record.before.nodes).toBe(base.nodes);
        expect(record.after.nodes).toBe(written.nodes);
        expect(loads).toBe(0);
        await app.undoAgentOps();
        expect(loads).toBe(1);
        expect(app.live().nodes[0].title).toBe("one");
    });

    test("empty and generation-only commands need no undo record or module load", async () => {
        let loads = 0;
        const base = project();
        const app = editor(base, frame(base), async () => { loads++; return undoAction; });
        for (const ops of [[], [{ type: "run_generation", nodeId: "one" }]] as CanvasAgentOp[][]) {
            app.applyAgentOps(ops);
            expect(app.canUndoAgent()).toBe(false);
            expect(app.undoRecord()).toBeNull();
            expect(await app.undoAgentOps()).toBeNull();
        }
        expect(loads).toBe(0);
    });

    test.each([
        { type: "update_node", id: "one", patch: { title: "one" } },
        { type: "update_node", id: "missing", patch: { title: "unused" } },
        { type: "delete_node", id: "missing" },
        { type: "delete_connections", all: true },
        { type: "select_nodes", ids: [] },
        { type: "set_viewport", viewport: { x: 0, y: 0, k: 1 } },
    ] satisfies CanvasAgentOp[])("unchanged edit %j resolves to an explicit no-op without changing the live graph", async (op) => {
        const app = editor();
        app.applyAgentOps([op]);
        const before = app.live();
        const result = await app.undoAgentOps();
        expect(result?.undoReport).toEqual({ applied: 0, conflicts: [], retryable: false });
        expect(app.live()).toBe(before);
        expect(app.canUndoAgent()).toBe(false);
        expect(app.successes).toEqual(["本批修改已撤销，无需重复操作。"]);
    });

    test("a later edit made while the inverse loads still wins", async () => {
        const loading = Promise.withResolvers<typeof undoAction>();
        const base = project();
        const app = editor(base, frame(base), () => loading.promise);
        app.applyAgentOps([{ type: "update_node", id: "one", patch: { title: "Agent", width: 200 } }]);
        const pending = app.undoAgentOps();
        app.edit({ nodes: [{ ...app.live().nodes[0], title: "User during load" }, app.live().nodes[1]] });
        loading.resolve(undoAction);
        const result = await pending;
        expect(result?.undoReport?.applied).toBe(1);
        expect(result?.undoReport?.conflicts).toHaveLength(1);
        expect(app.live().nodes[0]).toMatchObject({ title: "User during load", width: 100 });
    });

    test("a newer batch or project reset invalidates an in-flight undo click", async () => {
        for (const change of ["batch", "project"]) {
            const loading = Promise.withResolvers<typeof undoAction>();
            const base = project();
            const app = editor(base, frame(base), () => loading.promise);
            app.applyAgentOps([{ type: "update_node", id: "one", patch: { title: "First batch" } }]);
            const pending = app.undoAgentOps();
            if (change === "batch") app.applyAgentOps([{ type: "update_node", id: "one", patch: { width: 200 } }]);
            else app.clearAgentPatch();
            const beforeResolution = app.live();
            const beforeHistory = app.historyRef.current;
            loading.resolve(undoAction);
            expect(await pending).toBeNull();
            expect(app.live()).toBe(beforeResolution);
            expect(app.historyRef.current).toBe(beforeHistory);
            expect(app.successes).toHaveLength(0);
            if (change === "batch") {
                await app.undoAgentOps();
                expect(app.live().nodes[0]).toMatchObject({ title: "First batch", width: 100 });
            }
        }
    });

    test("overlapping undo calls apply the inverse at most once", async () => {
        const loading = Promise.withResolvers<typeof undoAction>();
        const base = project();
        const app = editor(base, frame(base), () => loading.promise);
        app.applyAgentOps([{ type: "update_node", id: "one", patch: { title: "Agent" } }]);
        const first = app.undoAgentOps(), second = app.undoAgentOps();
        loading.resolve(undoAction);
        const results = await Promise.all([first, second]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(app.successes).toHaveLength(1);
        expect(app.historyRef.current.past).toHaveLength(2);
        expect(app.live().nodes[0].title).toBe("one");
    });

    test("failed loading leaves the graph, history and patch intact for a later retry", async () => {
        let attempts = 0;
        const base = project();
        const app = editor(base, frame(base), async () => { if (!attempts++) throw new Error("offline"); return undoAction; });
        app.applyAgentOps([{ type: "update_node", id: "one", patch: { title: "Agent" } }]);
        const before = app.live(), history = app.historyRef.current;
        expect(await app.undoAgentOps()).toBeNull();
        expect(app.live()).toBe(before);
        expect(app.historyRef.current).toBe(history);
        expect(app.canUndoAgent()).toBe(true);
        expect(app.errors).toEqual(["加载失败，请重试"]);
        await app.undoAgentOps();
        expect(app.live().nodes[0].title).toBe("one");
        expect(app.canUndoAgent()).toBe(false);
    });

    test("page unmount cancels pending inverse work and suppresses late load failures", async () => {
        for (const outcome of ["resolve", "reject"]) {
            const loading = Promise.withResolvers<typeof undoAction>();
            const base = project();
            const app = editor(base, frame(base), () => loading.promise);
            app.applyAgentOps([{ type: "update_node", id: "one", patch: { title: "Agent" } }]);
            const pending = app.undoAgentOps();
            const before = app.live(), history = app.historyRef.current;
            app.unmount();
            if (outcome === "resolve") loading.resolve(undoAction);
            else loading.reject(new Error("offline after leaving"));
            expect(await pending).toBeNull();
            expect(app.live()).toBe(before);
            expect(app.historyRef.current).toBe(history);
            expect(app.successes).toEqual([]);
            expect(app.warnings).toEqual([]);
            expect(app.errors).toEqual([]);
        }
    });
});
