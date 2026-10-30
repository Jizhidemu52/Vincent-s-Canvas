import { describe, expect, test } from "bun:test";
import { uiText } from "@/lib/i18n";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createCanvasProjectAsyncLifecycle } from "@/lib/canvas/canvas-project-async-lifecycle";
import * as hydration from "@/pages/canvas/canvas-project-hydration";
import { boundedCanvasHistory } from "@/pages/canvas/use-canvas-history";
import { CanvasNodeType } from "@/types/canvas";

// Execute the actual controller bodies. Only React state, scheduling, and the
// network/chunk boundaries are supplied; these tests never generate media.
function evaluateCallback(file: string, name: string, scope: Record<string, unknown>, rewrite?: (code: string) => string) {
    scope = { uiText, ...scope };
    const source = readFileSync(new URL(`../src/pages/canvas/${file}`, import.meta.url), "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    let expression: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer) expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
        ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!expression) throw new Error(`Missing controller callback: ${file} / ${name}`);
    let code = expression.getText(ast);
    if (rewrite) code = rewrite(code);
    const compiled = ts.transpileModule(`return (${code});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(...Object.keys(scope), compiled)(...Object.values(scope));
}

describe("page-private generation dispatch", () => {
    function dispatchHarness(load: () => Promise<unknown>) {
        const locks = new Set<string>();
        const messages: string[] = [];
        const connectionsRef = { current: [] as Array<{ kind: string; fromNodeId: string; toNodeId: string }> };
        const execute = () => {};
        const run = evaluateCallback("use-canvas-generation.ts", "handleGenerateNode", {
            generationDispatchLocksRef: { current: locks }, nodesRef: { current: [] }, connectionsRef,
            effectiveConfig: {}, buildGenerationConfig: () => ({}), isAiConfigReady: () => true,
            executeGenerateNode: execute, recoverPending: () => null, startGenerationRequest: () => {}, finishGenerationRequest: () => {},
            setRunningNodeId: () => {}, setNodes: () => {}, message: { info: (text: string) => messages.push(text), error: (text: string) => messages.push(text) },
            loadGenerationRuntime: load,
        }, code => code.replace('import("./canvas-shared-generation-runtime")', "loadGenerationRuntime()"));
        return { run, locks, messages, connectionsRef, execute };
    }

    test("locks synchronously before chunk loading and releases once after dispatch", async () => {
        const chunk = Promise.withResolvers<{ runCanvasGeneration: (...args: unknown[]) => Promise<void> }>();
        let loads = 0;
        const calls: unknown[][] = [];
        const state = dispatchHarness(() => { loads++; return chunk.promise; });
        const first = state.run("image", "image", "latest prompt");
        await state.run("image", "image", "duplicate");
        expect([...state.locks]).toEqual(["image"]);
        expect(loads).toBe(1);
        chunk.resolve({ runCanvasGeneration: async (...args) => { calls.push(args); } });
        await first;
        expect(calls).toHaveLength(1);
        expect(calls[0]!.slice(0, 3)).toEqual(["image", "image", "latest prompt"]);
        expect((calls[0]![4] as { execute: unknown }).execute).toBe(state.execute);
        expect(state.locks.size).toBe(0);
    });

    test("sequence-owned locks remain owned and cancellation during loading never dispatches", async () => {
        const chunk = Promise.withResolvers<{ runCanvasGeneration: () => Promise<void> }>();
        let calls = 0;
        const state = dispatchHarness(() => chunk.promise);
        state.locks.add("image-sequence:workflow");
        const controller = new AbortController();
        const first = state.run("config", "image", "step", undefined, "image-sequence:workflow", controller.signal);
        controller.abort();
        chunk.resolve({ runCanvasGeneration: async () => { calls++; } });
        await first;
        expect(calls).toBe(0);
        expect([...state.locks]).toEqual(["image-sequence:workflow"]);
    });

    test("linked workflow nodes cannot bypass serial entry and load failure leaves retry possible", async () => {
        let loads = 0;
        const state = dispatchHarness(async () => { loads++; throw new Error("offline chunk"); });
        state.connectionsRef.current = [{ kind: "config-sequence", fromNodeId: "config", toNodeId: "next" }];
        await state.run("config", "image", "step");
        expect(loads).toBe(0);
        state.connectionsRef.current = [];
        const outcomes: unknown[] = [];
        await state.run("config", "image", "step", (value: unknown) => outcomes.push(value));
        expect(state.locks.size).toBe(0);
        expect(outcomes).toEqual([{ mode: "image", outputs: [{ nodeId: "config", status: "failed", error: "offline chunk" }] }]);
    });
});

describe("page-private connection completion", () => {
    function connectionHarness(target: { nodeId: string | null; isNearNode: boolean }) {
        const handle = { nodeId: "source", handleType: "source" };
        const connectingParamsRef = { current: handle as typeof handle | null };
        const pendingConnectionCreateRef = { current: null as unknown };
        const events: unknown[] = [];
        const finish = evaluateCallback("use-canvas-connections.ts", "finishConnection", {
            connectingParamsRef, pendingConnectionCreateRef,
            flushConnectionPointer: () => events.push("flush"),
            getConnectionDropTarget: () => target,
            connectNodes: (...args: unknown[]) => events.push(args),
            setConnecting: (value: null) => { connectingParamsRef.current = value; events.push("clear"); },
            screenToCanvas: (x: number, y: number) => ({ x: x / 2, y: y / 2 }),
            activeConnectionPathRef: { current: { clear: () => events.push("clear-preview") } },
            setPendingConnectionCreate: (value: unknown) => { pendingConnectionCreateRef.current = value; },
        });
        return { finish, events, connectingParamsRef, pendingConnectionCreateRef, handle };
    }

    test("target drop connects once; repeated mouseup does not recreate it", () => {
        const state = connectionHarness({ nodeId: "target", isNearNode: true });
        state.finish(20, 40);
        state.finish(20, 40);
        expect(state.events).toEqual(["flush", [state.handle, "target"], "clear", "flush"]);
    });

    test("near an incompatible node cancels, while empty space preserves the pending handle and world position", () => {
        const near = connectionHarness({ nodeId: null, isNearNode: true });
        near.finish(20, 40);
        expect(near.pendingConnectionCreateRef.current).toBeNull();
        expect(near.connectingParamsRef.current).toBeNull();
        const empty = connectionHarness({ nodeId: null, isNearNode: false });
        empty.finish(20, 40);
        const pending = empty.pendingConnectionCreateRef.current;
        empty.finish(400, 500);
        expect(pending).toEqual({ connection: empty.handle, position: { x: 10, y: 20 } });
        expect(empty.pendingConnectionCreateRef.current).toBe(pending);
        expect(empty.events).toEqual(["flush", "clear-preview", "flush"]);
    });
});

describe("on-demand media stage", () => {
    for (const stage of ["Image", "Video"]) {
        test(`${stage} chunk failure preserves the graph and exposes failure`, async () => {
            const events: unknown[] = [];
            const run = evaluateCallback("canvas-media-workflow-actions-runtime.ts", `runWorkflow${stage}Stage`, {
                stageScope: { active: true }, nodesRef: { current: [] },
                buildWorkflowVideoStageDispatch: () => ({ referenceNodeIds: ["image"] }),
                updateMediaWorkflow: (_id: string, fn: Function) => events.push(fn({})),
                completeAgentMediaWorkflowStage: (_workflow: unknown, _stage: string, result: unknown) => result,
                loadWorkflowStage: async () => { throw new Error("offline stage"); },
                applyAgentOps: () => { throw new Error("must not change graph"); },
            });
            await run("message", { intent: "image-to-video" });
            expect(events).toHaveLength(2);
            expect(events[1]).toMatchObject({ status: "failed", error: new Error("offline stage") });
        });

        test(`${stage} chunk completing after a project switch cannot dispatch`, async () => {
            const stageScope = { active: true };
            const chunk = Promise.withResolvers<unknown>();
            const run = evaluateCallback("canvas-media-workflow-actions-runtime.ts", `runWorkflow${stage}Stage`, {
                stageScope, nodesRef: { current: [] },
                buildWorkflowVideoStageDispatch: () => ({ referenceNodeIds: ["image"] }),
                updateMediaWorkflow: () => {},
                loadWorkflowStage: () => chunk.promise,
                applyAgentOps: () => { throw new Error("must not change graph"); },
            });
            const pending = run("message", { intent: "image-to-video" });
            stageScope.active = false;
            chunk.resolve({ buildAgentMediaWorkflowStageOps: () => { throw new Error("must not build a late stage"); } });
            await pending;
        });
    }
});

describe("page-private project hydration lifecycle", () => {
    const source = readFileSync(new URL("../src/pages/canvas/use-canvas-project-hydration.ts", import.meta.url), "utf8");
    const ast = ts.createSourceFile("hydration.ts", source, ts.ScriptTarget.Latest, true);
    let effect: ts.Expression;
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes("if (!hydrated) return")) effect = node.arguments[0];
        ts.forEachChild(node, visit);
    };
    visit(ast);
    const code = ts.transpileModule(`return (${effect!.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

    function hydrationHarness(load: () => Promise<unknown>, overrides: Record<string, unknown> = {}) {
        const writes: Array<{ key: string; value: unknown }> = [];
        const historyRef = { current: { past: [], future: [] } };
        const lastHistoryRef = { current: null };
        const scope: Record<string, unknown> = {
            uiText,
            ...hydration, loadHydrationRuntime: async () => ({ ...hydration, ...overrides }), boundedCanvasHistory, hydrated: true, projectId: "project", projectAsyncLifecycleRef: { current: createCanvasProjectAsyncLifecycle() },
            historyRef, lastHistoryRef, pendingHistoryEntryRef: { current: null }, applyingHistoryRef: { current: false },
            historyPausedRef: { current: false }, historyCommitTimerRef: { current: null },
            resetEditor: () => {}, textStreamBufferRef: { current: { cancel: () => {} } },
            generationRequestsRef: { current: new Map() }, abortPendingCanvasRequests: () => {},
            usePerformanceScenario: false, performanceFixtureSize: null, performanceScenarioIncludesImages: false,
            openProject: () => null, loadCanvasProject: load,
            shouldOpenCanvasCreationPanel: () => false, normalizeCanvasSelectedNodeIds: () => [],
            window: { innerWidth: 1400 }, requestAnimationFrame: () => 1, releaseStaleCanvasObjectUrls: () => {},
            message: { error: (value: unknown) => writes.push({ key: "error", value }), warning: (value: unknown) => writes.push({ key: "warning", value }) },
            navigate: (value: unknown) => writes.push({ key: "navigate", value }),
        };
        for (const key of ["setProjectLoaded", "setQuickGeneratePosition", "setStreamedTextById", "setRunningNodeId", "setQuickGenerateRunning", "setNodes", "setQuickGenerateOpen", "setConnections", "setGroups", "setChatSessions", "setActiveChatId", "setBackgroundMode", "setShowImageInfo", "setViewport", "setSelectedNodeIds", "setHistoryState"]) scope[key] = (value: unknown) => writes.push({ key, value });
        Object.assign(scope, overrides);
        const run = new Function(...Object.keys(scope), code)(...Object.values(scope));
        return { run, writes, historyRef, lastHistoryRef };
    }

    const project = () => ({ id: "project", nodes: [{ id: "original", type: CanvasNodeType.Image, title: "Original", position: { x: 1, y: 2 }, width: 100, height: 80, metadata: { content: "blob:original", storageKey: "image:original", status: "success" } }],
        connections: [], groups: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", viewport: { x: 10, y: 20, k: 0.8 }, history: { past: [], future: [] } });
    const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));

    test("leaving while the project loads rejects every late graph/history commit", async () => {
        const load = Promise.withResolvers<unknown>();
        const state = hydrationHarness(() => load.promise);
        const cleanup = state.run();
        cleanup();
        load.resolve(project());
        await nextTurn();
        expect(state.writes.some(write => write.key === "setNodes")).toBe(false);
        expect(state.writes.some(write => write.key === "setProjectLoaded" && write.value === true)).toBe(false);
        expect(state.lastHistoryRef.current).toBeNull();
    });

    test("current project restoration retains original media objects, viewport, and historical baseline", async () => {
        const original = project();
        const state = hydrationHarness(async () => original);
        state.run();
        await nextTurn();
        expect(state.writes.find(write => write.key === "setNodes")?.value).toBe(original.nodes);
        expect(state.writes.find(write => write.key === "setViewport")?.value).toBe(original.viewport);
        expect(state.lastHistoryRef.current).toMatchObject({ nodes: original.nodes, connections: original.connections });
        expect(state.writes.filter(write => write.key === "error" || write.key === "warning")).toEqual([]);
    });

    test("an unavailable hydration chunk leaves original project data untouched", async () => {
        const original = project();
        const state = hydrationHarness(async () => original, { loadHydrationRuntime: async () => { throw new Error("offline chunk"); } });
        state.run();
        await nextTurn();
        expect(state.writes.some(write => write.key === "setNodes")).toBe(false);
        expect(state.writes.find(write => write.key === "error")?.value).toBe("offline chunk");
        expect(original.nodes[0]!.metadata.storageKey).toBe("image:original");
    });

    test("a storage failure retains the original graph instead of partially replacing its source data", async () => {
        const original = project();
        const state = hydrationHarness(async () => original, { hydrateCanvasImages: async () => { throw new Error("media unavailable"); } });
        state.run();
        await nextTurn();
        expect(state.writes.find(write => write.key === "setNodes")?.value).toBe(original.nodes);
        expect(state.writes.find(write => write.key === "warning")?.value).toContain("已保留原始项目内容");
        expect(original.nodes[0]!.metadata.storageKey).toBe("image:original");
    });
});
