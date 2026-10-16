import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

type Entry = { nodes: CanvasNodeData[]; connections: unknown[]; groups: unknown[]; chatSessions: unknown[]; activeChatId: string | null; backgroundMode: string; showImageInfo: boolean };
type History = { past: Entry[]; future: Entry[] };

// Exercise the page's real command callbacks without mounting unrelated editor services.
const source = readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("project.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const helperNames = new Set(["boundedCanvasHistory", "canvasHistoryForSave"]);
const callbackNames = new Set(["flushPendingHistory", "undoCanvas", "redoCanvas"]);
const callbacks: string[] = [];
let historyEffect = "";
function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && callbackNames.has(node.name.text)) callbacks.push(`const ${node.getText(ast)};`);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect" && node.arguments[0]?.getText(ast).includes("historyCommitTimerRef.current = setTimeout")) historyEffect = `const runHistoryEffect = ${node.arguments[0].getText(ast)};`;
    ts.forEachChild(node, collect);
}
collect(ast);
const code = ts.transpileModule([
    ...ast.statements.filter(statement => ts.isFunctionDeclaration(statement) && helperNames.has(statement.name?.text || "")).map(statement => statement.getText(ast).replace(/^export\s+/, "")),
    ...callbacks,
    historyEffect,
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText;

function entry(...ids: string[]): Entry {
    return { nodes: ids.map(id => ({ id, type: CanvasNodeType.Text, title: id, width: 100, height: 100, position: { x: 0, y: 0 }, metadata: { content: id } })), connections: [], groups: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false };
}

function harness(history: History, previous: Entry, current: Entry) {
    const historyRef = { current: history };
    const lastHistoryRef = { current: previous };
    const historyCommitTimerRef = { current: 17 as number | null };
    const applyingHistoryRef = { current: false };
    const historyPausedRef = { current: false };
    const clearedTimers: number[] = [];
    const pendingTimers = new Map<number, () => void>();
    let timerId = 17;
    let live = current;
    let availability = { canUndo: history.past.length > 0, canRedo: history.future.length > 0 };
    const actions = new Function("useCallback", "historyRef", "lastHistoryRef", "createHistoryEntry", "applyHistory", "historyCommitTimerRef", "applyingHistoryRef", "historyPausedRef", "setHistoryState", "clearTimeout", "setTimeout", "projectLoaded", `${code}\nreturn { undoCanvas, redoCanvas, runHistoryEffect };`)(
        (callback: () => void) => callback,
        historyRef,
        lastHistoryRef,
        () => live,
        (restored: Entry) => { live = restored; lastHistoryRef.current = restored; },
        historyCommitTimerRef,
        applyingHistoryRef,
        historyPausedRef,
        (next: typeof availability | ((previous: typeof availability) => typeof availability)) => { availability = typeof next === "function" ? next(availability) : next; },
        (timer: number) => { clearedTimers.push(timer); pendingTimers.delete(timer); },
        (callback: () => void) => { pendingTimers.set(++timerId, callback); return timerId; },
        true,
    ) as { undoCanvas: () => void; redoCanvas: () => void; runHistoryEffect: () => void | (() => void) };
    const commitPending = () => {
        const timer = historyCommitTimerRef.current;
        if (timer === null) return;
        const callback = pendingTimers.get(timer);
        pendingTimers.delete(timer);
        callback?.();
    };
    return { ...actions, historyRef, lastHistoryRef, historyCommitTimerRef, applyingHistoryRef, historyPausedRef, clearedTimers, commitPending, live: () => live, availability: () => availability };
}

describe("canvas commands before the history debounce commits", () => {
    test("immediate undo of a sixty-image bulk drag never returns to the older thirty-image import", () => {
        const imported = entry(...Array.from({ length: 60 }, (_, index) => `image-${index}`));
        imported.nodes = imported.nodes.map((node, index) => ({ ...node, type: CanvasNodeType.Image, position: { x: index * 120, y: 80 }, metadata: { content: `blob:${node.id}`, storageKey: `image:${node.id}` } }));
        const older = { ...imported, nodes: imported.nodes.slice(0, 30) };
        const moved = { ...imported, nodes: imported.nodes.map(node => ({ ...node, position: { x: node.position.x + 150, y: node.position.y + 90 } })) };
        const editor = harness({ past: [older], future: [] }, imported, moved);

        editor.undoCanvas();
        expect(editor.live().nodes).toHaveLength(60);
        expect(editor.live()).toBe(imported);
        expect(editor.historyRef.current.past).toEqual([older]);
        expect(editor.historyRef.current.future).toEqual([moved]);
        editor.commitPending();
        expect(editor.historyRef.current.future).toEqual([moved]);
        editor.redoCanvas();
        expect(editor.live().nodes).toHaveLength(60);
        expect(editor.live()).toBe(moved);
        expect(editor.historyRef.current.past).toEqual([older, imported]);
    });

    test("delete then immediate undo restores the deleted node and redo repeats only the deletion", () => {
        const older = entry("first");
        const beforeDelete = entry("first", "second");
        const afterDelete = { ...beforeDelete, nodes: beforeDelete.nodes.slice(0, 1) };
        const editor = harness({ past: [older], future: [] }, beforeDelete, afterDelete);
        editor.undoCanvas();
        expect(editor.live()).toBe(beforeDelete);
        expect(editor.historyRef.current.past).toEqual([older]);
        expect(editor.historyRef.current.future).toEqual([afterDelete]);
        expect(editor.historyCommitTimerRef.current).toBeNull();
        expect(editor.clearedTimers).toEqual([17]);
        editor.redoCanvas();
        expect(editor.live()).toBe(afterDelete);
        expect(editor.historyRef.current.future).toEqual([]);
    });

    test("the first edit is undoable immediately even when no previous step has committed", () => {
        const empty = entry();
        const added = { ...empty, nodes: entry("first").nodes };
        const editor = harness({ past: [], future: [] }, empty, added);
        editor.undoCanvas();
        expect(editor.live()).toBe(empty);
        expect(editor.historyRef.current.future).toEqual([added]);
    });

    test("the first pending edit enables the undo control before its debounce and commits only once", () => {
        const empty = entry();
        const added = { ...empty, nodes: entry("first").nodes };
        const editor = harness({ past: [], future: [] }, empty, added);
        editor.runHistoryEffect();
        expect(editor.availability()).toEqual({ canUndo: true, canRedo: false });
        expect(editor.historyRef.current.past).toEqual([]);
        editor.commitPending();
        expect(editor.historyRef.current.past).toEqual([empty]);
        editor.undoCanvas();
        expect(editor.live()).toBe(empty);
        expect(editor.historyRef.current.past).toEqual([]);
        expect(editor.historyRef.current.future).toEqual([added]);
    });

    test("the pending-edit effect disables stale redo immediately and undo cancels its timer", () => {
        const before = entry("first");
        const edited = { ...before, nodes: entry("first", "new-second").nodes };
        const editor = harness({ past: [], future: [entry("old-redo")] }, before, edited);
        editor.runHistoryEffect();
        expect(editor.availability()).toEqual({ canUndo: true, canRedo: false });
        editor.undoCanvas();
        editor.commitPending();
        expect(editor.live()).toBe(before);
        expect(editor.historyRef.current.past).toEqual([]);
        expect(editor.historyRef.current.future).toEqual([edited]);
    });

    test("a new pending edit discards stale redo instead of overwriting the user's edit", () => {
        const before = entry("first");
        const undone = entry("first", "old-second");
        const edited = { ...before, nodes: entry("first", "new-second").nodes };
        const editor = harness({ past: [], future: [undone] }, before, edited);
        editor.redoCanvas();
        expect(editor.live()).toBe(edited);
        expect(editor.historyRef.current.future).toEqual([]);
        expect(editor.historyRef.current.past).toEqual([before]);
        expect(editor.availability()).toEqual({ canUndo: true, canRedo: false });
    });

    test("an already committed edit is not added twice", () => {
        const before = entry("first");
        const after = entry("first", "second");
        const editor = harness({ past: [before], future: [] }, after, after);
        editor.undoCanvas();
        expect(editor.live()).toBe(before);
        expect(editor.historyRef.current.past).toEqual([]);
        expect(editor.historyRef.current.future).toEqual([after]);
        editor.redoCanvas();
        expect(editor.live()).toBe(after);
        expect(editor.historyRef.current.past).toEqual([before]);
    });

    test("paused history and an in-flight restore cannot be treated as new edits", () => {
        const before = entry("first");
        const after = entry("second");
        for (const guard of ["historyPausedRef", "applyingHistoryRef"] as const) {
            const editor = harness({ past: [entry()], future: [after] }, before, after);
            editor[guard].current = true;
            editor.undoCanvas();
            editor.redoCanvas();
            expect(editor.live()).toBe(after);
            expect(editor.historyRef.current.past).toHaveLength(1);
            expect(editor.historyRef.current.future).toEqual([after]);
            expect(editor.clearedTimers).toEqual([]);
        }
    });
});
