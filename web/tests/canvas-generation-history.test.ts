import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { canvasHistoryForSave } from "@/pages/canvas/use-canvas-history";
import { mergeCanvasGenerationHistory } from "@/lib/canvas/canvas-generation-history";
import type { CanvasHistorySnapshot } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasGenerationRecord, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

const record: CanvasGenerationRecord = { version: 1, id: "generation-one", sourceNodeId: "source", createdAt: "2026-10-30T00:00:00Z",
    prompt: "原始提示词", inputPrompt: "原始提示词", references: [],
    parameters: { model: "original-model", size: "1:1", quality: "high", imageOptions: "{}", systemPrompt: "", count: 1, generationType: "generation" } };
const sourceNode: CanvasNodeData = { id: "source", type: CanvasNodeType.Image, title: "原图", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "original-image" } };
const placeholder: CanvasNodeData = { id: "result", type: CanvasNodeType.Image, title: "生成结果", position: { x: 300, y: 50 }, width: 320, height: 320,
    metadata: { status: "loading", prompt: record.prompt, generationRecord: record, model: "original-model", size: "1:1", quality: "high" } };
const connection = { id: "result-edge", fromNodeId: "source", toNodeId: "result", kind: "generation-output" as const };
function snapshot(nodes: CanvasNodeData[] = [sourceNode]): CanvasHistorySnapshot {
    return { nodes, connections: nodes.some(node => node.id === "result") ? [connection] : [], groups: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false };
}
function update(frame: CanvasHistorySnapshot, id: string, patch: Partial<CanvasNodeData>, metadata: Partial<CanvasNodeMetadata> = {}) {
    return { ...frame, nodes: frame.nodes.map(node => node.id === id ? { ...node, ...patch, metadata: { ...node.metadata, ...metadata } } : node) };
}
function complete(frame: CanvasHistorySnapshot, metadata: Partial<CanvasNodeMetadata> = {}) {
    const node = frame.nodes.find(node => node.id === "result")!;
    return update(frame, "result", { width: 320, height: 160, position: { x: node.position.x, y: node.position.y + (node.height - 160) / 2 } }, {
        status: "success", content: "final-image", storageKey: "asset:result", naturalWidth: 1024, naturalHeight: 512, bytes: 12345, mimeType: "image/png",
        imageTask: undefined, sourceTaskId: "paid-once", optimizingPrompt: false, errorDetails: undefined, ...metadata,
    });
}

// Real hook command callbacks; only React and the live graph boundary are stubbed.
const hookSource = readFileSync(new URL("../src/pages/canvas/use-canvas-history.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("history.ts", hookSource, ts.ScriptTarget.Latest, true);
const names = new Set(["flushPendingHistory", "undoCanvas", "redoCanvas"]), declarations: string[] = [];
function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.has(node.name.text)) declarations.push(`const ${node.getText(ast)};`);
    ts.forEachChild(node, collect);
}
collect(ast);
const commands = ts.transpileModule(declarations.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
function editor(initial = snapshot()) {
    let live = initial;
    const historyRef = { current: { past: [] as CanvasHistorySnapshot[], future: [] as CanvasHistorySnapshot[] } };
    const lastHistoryRef = { current: initial };
    const scope = { historyRef, lastHistoryRef, historyCommitTimerRef: { current: null }, applyingHistoryRef: { current: false }, historyPausedRef: { current: false },
        projectLoaded: true, canvasHistoryForSave, clearTimeout() {}, setHistoryState() {}, useCallback: (callback: unknown) => callback, onHistoryAction: undefined, beforeHistoryAction: undefined,
        createHistoryEntry: () => live, applyHistory: (entry: CanvasHistorySnapshot) => { live = entry; lastHistoryRef.current = entry; } };
    const actions = new Function("scope", `const { ${Object.keys(scope).join(",")} } = scope; ${commands}; return { flushPendingHistory, undoCanvas, redoCanvas };`)(scope) as {
        flushPendingHistory(): void; undoCanvas(): void; redoCanvas(): void;
    };
    return { ...actions, historyRef, lastHistoryRef, current: () => live, set: (entry: CanvasHistorySnapshot) => { live = entry; },
        save: () => canvasHistoryForSave(historyRef.current, lastHistoryRef.current, live, false) };
}

describe("generation delivery belongs to its original canvas command", () => {
    test("placeholder, compilation, binding, success and fitted size undo once with the edge; redo restores the final record", () => {
        const e = editor(), before = e.current();
        e.set(snapshot([sourceNode, placeholder])); e.flushPendingHistory();
        e.set(update(e.current(), "result", {}, { optimizingPrompt: true })); e.flushPendingHistory();
        e.set(update(e.current(), "result", {}, { optimizingPrompt: false, optimized: true, prompt: "最终编译提示词", generationRecord: { ...record, prompt: "最终编译提示词" } })); e.flushPendingHistory();
        e.set(update(e.current(), "result", {}, { imageTask: { requestId: "request:0", taskId: "paid-once", projectId: "project", ownerId: "owner", resultIndex: 0 }, sourceTaskId: "paid-once" })); e.flushPendingHistory();
        e.set(complete(e.current())); e.flushPendingHistory();
        const final = e.current();
        expect(e.historyRef.current.past).toEqual([before]);
        expect(final.nodes[1]!.metadata!.generationRecord!.prompt).toBe("最终编译提示词");
        expect(final.nodes[1]!.position).toEqual({ x: 300, y: 130 });
        e.undoCanvas(); expect(e.current()).toBe(before); expect(e.current().connections).toEqual([]);
        e.redoCanvas(); expect(e.current()).toBe(final); expect(e.current().connections).toEqual([connection]);
        expect(e.current().nodes[1]!.metadata).toMatchObject({ content: "final-image", status: "success", sourceTaskId: "paid-once" });
        expect(placeholder.metadata!.status).toBe("loading"); expect(record.prompt).toBe("原始提示词");
    });

    test.each(["source", "result"])("a move of %s while generating remains the next undo, with complete result metadata on both sides", id => {
        const e = editor(), before = e.current();
        e.set(snapshot([sourceNode, placeholder])); e.flushPendingHistory();
        const target = e.current().nodes.find(node => node.id === id)!;
        e.set(update(e.current(), id, { position: { x: target.position.x + 70, y: target.position.y + 25 } })); e.flushPendingHistory();
        e.set(complete(e.current())); e.flushPendingHistory();
        expect(e.historyRef.current.past).toHaveLength(2);
        const final = e.current(); e.undoCanvas();
        expect(e.current().nodes[1]!.metadata).toMatchObject({ status: "success", content: "final-image" });
        expect(e.current().nodes[1]!.position).toEqual({ x: 300, y: 130 });
        expect(e.current().nodes[0]!.position).toEqual({ x: 0, y: 0 });
        e.redoCanvas(); expect(e.current()).toBe(final);
        e.undoCanvas(); e.undoCanvas(); expect(e.current()).toBe(before);
    });

    test("draft/settings edits retain their own history even when result delivery occurs in the same React batch", () => {
        const e = editor(), before = e.current();
        e.set(snapshot([sourceNode, placeholder])); e.flushPendingHistory();
        const newReferences = [{ id: "new", origin: "upload" as const, name: "新草稿引用", type: "image/png", referenceKey: "upload:new", content: "new-image" }];
        e.set(complete(update(e.current(), "result", { title: "用户改名" }, { draftPrompt: "用户草稿", draftImageReferences: newReferences,
            model: "user-model", size: "3:2", quality: "low", imageOptions: '{"background":"transparent"}', count: 2 })));
        e.flushPendingHistory();
        expect(e.historyRef.current.past).toHaveLength(2);
        expect(e.current().nodes[1]!.metadata).toMatchObject({ draftPrompt: "用户草稿", draftImageReferences: newReferences, model: "user-model", size: "3:2", quality: "low", count: 2 });
        e.undoCanvas();
        expect(e.current().nodes[1]!.title).toBe("生成结果");
        expect(e.current().nodes[1]!.metadata).toMatchObject({ content: "final-image", status: "success", model: "original-model", size: "1:1", quality: "high" });
        expect(e.current().nodes[1]!.metadata!.draftPrompt).toBeUndefined();
        e.undoCanvas(); expect(e.current()).toBe(before);
    });

    test("a combined user move and center-preserving result fit absorbs only the center adjustment", () => {
        const e = editor(); e.set(snapshot([sourceNode, placeholder])); e.flushPendingHistory();
        e.set(complete(update(e.current(), "result", { position: { x: 370, y: 75 } })));
        e.flushPendingHistory();
        expect(e.historyRef.current.past).toHaveLength(2);
        expect(e.current().nodes[1]!.position).toEqual({ x: 370, y: 155 });
        e.undoCanvas();
        expect(e.current().nodes[1]!.position).toEqual({ x: 300, y: 130 });
        expect(e.current().nodes[1]!.height).toBe(160);
        expect(e.current().nodes[1]!.metadata!.status).toBe("success");
    });

    test("failure and removal of the execution binding do not create extra commands", () => {
        const e = editor(), before = e.current(); e.set(snapshot([sourceNode, placeholder])); e.flushPendingHistory();
        e.set(update(e.current(), "result", {}, { imageTask: { requestId: "request:0", projectId: "project", ownerId: "owner", resultIndex: 0 } })); e.flushPendingHistory();
        e.set(update(e.current(), "result", {}, { status: "error", errorDetails: "provider failed", imageTask: undefined })); e.flushPendingHistory();
        expect(e.historyRef.current.past).toHaveLength(1);
        e.undoCanvas(); expect(e.current()).toBe(before);
        e.redoCanvas(); expect(e.current().nodes[1]!.metadata).toMatchObject({ status: "error", errorDetails: "provider failed" });
    });

    test("runtime completion refreshes redo versions without consuming a user's undone move", () => {
        const e = editor(); e.set(snapshot([sourceNode, placeholder])); e.flushPendingHistory();
        e.set(update(e.current(), "result", { position: { x: 400, y: 60 } })); e.flushPendingHistory();
        e.undoCanvas(); expect(e.historyRef.current.future).toHaveLength(1);
        e.set(complete(e.current())); e.flushPendingHistory();
        expect(e.historyRef.current.future).toHaveLength(1);
        e.redoCanvas();
        expect(e.current().nodes[1]!.position).toEqual({ x: 400, y: 140 });
        expect(e.current().nodes[1]!.metadata!.content).toBe("final-image");
    });

    test("an undone placeholder stays absent; delivery patches never insert it into an older snapshot", () => {
        const before = snapshot(), pending = snapshot([sourceNode, placeholder]), final = complete(pending);
        const merged = mergeCanvasGenerationHistory({ past: [before], future: [pending] }, pending, final);
        expect(merged.history.past[0]).toBe(before);
        expect(merged.history.past[0]!.nodes).not.toContainEqual(expect.objectContaining({ id: "result" }));
        const e = editor(before); e.set(pending); e.flushPendingHistory(); e.undoCanvas();
        // The runtime's guarded map cannot update a node removed by undo.
        const lateNodes = e.current().nodes.map(node => node.id === "result" ? final.nodes[1]! : node);
        expect(lateNodes).toEqual(before.nodes);
        expect(e.current()).toBe(before);
        expect(e.historyRef.current.future[0]!.nodes[1]!.metadata!.status).toBe("loading");
    });

    test("a new record identity, manual resize and a settled image edit are ordinary edits", () => {
        const pending = snapshot([sourceNode, placeholder]);
        const resized = update(pending, "result", { width: 210, height: 180 });
        expect(canvasHistoryForSave({ past: [], future: [] }, pending, resized, false).past).toEqual([pending]);
        const nextRun = update(pending, "result", {}, { generationRecord: { ...record, id: "new-generation" }, content: "new-image", status: "success" });
        expect(canvasHistoryForSave({ past: [], future: [] }, pending, nextRun, false).past).toEqual([pending]);
        const settled = complete(pending), edited = update(settled, "result", {}, { content: "user-replaced-image" });
        expect(canvasHistoryForSave({ past: [], future: [] }, settled, edited, false).past).toEqual([settled]);
    });

    test("save before the debounce applies the same merge, preserves redo, and stays bounded after reload", () => {
        const pending = snapshot([sourceNode, placeholder]), final = complete(pending);
        const history = { past: Array.from({ length: 215 }, (_, index) => ({ ...pending, showImageInfo: index % 2 === 0 })), future: [pending] };
        const saved = canvasHistoryForSave(history, pending, final, false);
        expect(saved.past).toHaveLength(200); expect(saved.future).toHaveLength(1);
        expect(saved.past.every(entry => entry.nodes[1]!.metadata!.status === "success")).toBe(true);
        expect(saved.past[0]!.nodes).toBe(saved.past.at(-1)!.nodes);
        expect(saved.past[0]!.nodes[0]).toBe(sourceNode);
        expect(history.past[0]!.nodes[1]).toBe(placeholder);
        const restored = JSON.parse(JSON.stringify({ current: final, history: saved }));
        const afterReload = canvasHistoryForSave(restored.history, restored.current, restored.current, false);
        expect(afterReload.past).toHaveLength(200); expect(afterReload.future).toHaveLength(1);
        expect(afterReload.future[0]!.nodes[1]!.metadata!.content).toBe("final-image");
    });
});
