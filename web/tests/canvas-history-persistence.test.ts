import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

type Entry = { nodes: CanvasNodeData[]; connections: CanvasConnection[]; chatSessions: unknown[]; activeChatId: string | null; backgroundMode: string; showImageInfo: boolean };
type History = { past: Entry[]; future: Entry[] };

// Run page-owned history transitions without mounting the full editor or browser storage.
const source = readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("project.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(["boundedCanvasHistory", "canvasHistoryForSave"]);
const code = ts.transpileModule(ast.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.has(statement.name?.text || "")).map(statement => statement.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
}).outputText;
const functions = {} as {
    boundedCanvasHistory: (history?: History) => History;
    canvasHistoryForSave: (history: History, previous: Entry | null, current: Entry, applying: boolean) => History;
};
new Function("exports", code)(functions);
const { boundedCanvasHistory, canvasHistoryForSave } = functions;

function entry(label: string): Entry {
    return { nodes: [{ id: label, type: CanvasNodeType.Image, title: label, width: 100, height: 100, position: { x: 12, y: 34 }, metadata: { content: `blob:${label}`, storageKey: `image:${label}` } }], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false };
}

describe("canvas persisted undo/redo", () => {
    test("restores both stacks and keeps only the latest fifty steps", () => {
        const history = { past: Array.from({ length: 65 }, (_, index) => entry(`past-${index}`)), future: [entry("redo")] };
        const restored = boundedCanvasHistory(JSON.parse(JSON.stringify(history)));
        expect(restored.past).toHaveLength(50);
        expect(restored.past[0].nodes[0].id).toBe("past-15");
        expect(restored.past.at(-1)?.nodes[0].metadata.storageKey).toBe("image:past-64");
        expect(restored.future[0].nodes[0].position).toEqual({ x: 12, y: 34 });
        expect(boundedCanvasHistory()).toEqual({ past: [], future: [] });
    });

    test("page-close snapshots retain an edit before the history debounce commits", () => {
        const previous = entry("before-edit");
        const current = { ...previous, nodes: [{ ...previous.nodes[0], position: { x: 200, y: 300 } }] };
        const history = { past: [entry("older")], future: [entry("discarded-redo")] };
        const saved = canvasHistoryForSave(history, previous, current, false);
        expect(saved.past.map(item => item.nodes[0].id)).toEqual(["older", "before-edit"]);
        expect(saved.future).toEqual([]);
        expect(history.future).toHaveLength(1);
        expect(saved.past.at(-1)?.nodes[0].position).toEqual({ x: 12, y: 34 });
    });

    test("saving undo preserves redo and never records the undo as a new edit", () => {
        const before = entry("before");
        const after = entry("after");
        const saved = canvasHistoryForSave({ past: [], future: [after] }, after, before, true);
        const restored = boundedCanvasHistory(JSON.parse(JSON.stringify(saved)));
        expect(restored.past).toEqual([]);
        expect(restored.future.pop()?.nodes[0].id).toBe("after");
        expect(saved.future).toHaveLength(1);
    });

    test("already-committed history is not duplicated by the following autosave", () => {
        const current = entry("current");
        const history = { past: [entry("previous")], future: [] };
        expect(canvasHistoryForSave(history, current, current, false).past).toHaveLength(1);
    });

    test("edits to notes and connections are undoable without changing image nodes", () => {
        const previous = entry("image");
        const current = { ...previous, chatSessions: [{ id: "chat", title: "assistant history", messages: [] }] };
        expect(canvasHistoryForSave({ past: [], future: [] }, previous, current, false).past).toEqual([previous]);
        const connectionsOnly = { ...previous, connections: [{ id: "connection" }] as CanvasConnection[] };
        expect(canvasHistoryForSave({ past: [], future: [] }, previous, connectionsOnly, false).past).toEqual([previous]);
    });
});
