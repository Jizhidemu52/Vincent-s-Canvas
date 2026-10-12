import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { mergeProjectChanges } from "@/lib/canvas/canvas-persistence-merge";
import { decodeCanvasProject, encodeCanvasProject, parseCanvasProject, serializeCanvasProject } from "@/lib/canvas/canvas-project-codec";

// Exercise the current adapter with substituted browser storage boundaries.
const source = readFileSync(new URL("../src/lib/canvas/canvas-project-storage.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("storage.ts", source, ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(ast.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
}).outputText;

function fallback(initial: string | null) {
    let value = initial;
    let failure: Error | null = null;
    const bindings = {
        localforage: { ready: async () => { if (failure) throw failure; }, driver: () => "localStorageWrapper", INDEXEDDB: "asyncStorage" },
        readyLocalForageStorage: async () => { if (failure) throw failure; },
        localForageStorage: { getItem: async () => value },
        updateCanvasStorage: async (_name: string, update: (stored: string | null) => string | null) => { value = update(value); },
        mergeProjectChanges,
        decodeCanvasProject, encodeCanvasProject, parseCanvasProject, serializeCanvasProject,
    };
    const exports = {} as { readCanvasProjects: (name: string) => Promise<unknown[]>; writeCanvasProjects: (name: string, changes: Map<string, any>) => Promise<unknown[]>; removeCanvasProjects: (name: string) => Promise<void> };
    new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exports);
    return { ...exports, value: () => value, fail: () => { failure = new Error("storage unavailable"); } };
}

test("project adapter retains existing atomic fallback contract outside IndexedDB", async () => {
    const project = { id: "p", title: "original", nodes: [], image: "original bytes" };
    const io = fallback(JSON.stringify({ state: { projects: [project] }, version: 0 }));
    expect(await io.readCanvasProjects("canvas")).toEqual([project]);
    const next = { ...project, title: "renamed" };
    expect(await io.writeCanvasProjects("canvas", new Map([["p", { base: project, value: next, conflictId: "id", savedAt: "now" }]]))).toEqual([next]);
    expect(await io.readCanvasProjects("canvas")).toEqual([next]);
    await io.removeCanvasProjects("canvas");
    expect(io.value()).toBeNull();
});

test("initialization and malformed fallback data fail without overwriting source", async () => {
    const io = fallback("malformed");
    await expect(io.readCanvasProjects("canvas")).rejects.toThrow();
    await expect(io.writeCanvasProjects("canvas", new Map())).rejects.toThrow();
    expect(io.value()).toBe("malformed");
    io.fail();
    await expect(io.removeCanvasProjects("canvas")).rejects.toThrow("storage unavailable");
    expect(io.value()).toBe("malformed");
});

test("atomic fallback stores compact history and restores complete snapshots", async () => {
    const frame = { nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false };
    const project = { id: "p", title: "History", ...frame, history: { past: [frame], future: [] } };
    const io = fallback(null);
    await io.writeCanvasProjects("canvas", new Map([["p", { base: null, value: project, conflictId: "id", savedAt: "now" }]]));
    expect(JSON.parse(io.value()!).state.projects[0].history).toEqual({ format: "canvas-history-delta-v1", past: [{}], future: [] });
    expect(await io.readCanvasProjects("canvas")).toEqual([project]);
});

test("malformed compact history aborts fallback writes without overwriting original data", async () => {
    const original = JSON.stringify({ state: { projects: [{ id: "p", nodes: [], history: { format: "canvas-history-delta-v1", past: [{ arrays: { nodes: { kind: "splice", start: 10, deleteCount: 0, items: [] } } }], future: [] } }] }, version: 0 });
    const io = fallback(original);
    await expect(io.readCanvasProjects("canvas")).rejects.toThrow("历史数据损坏");
    await expect(io.writeCanvasProjects("canvas", new Map())).rejects.toThrow("历史数据损坏");
    expect(io.value()).toBe(original);
});
