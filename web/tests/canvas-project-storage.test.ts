import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { mergeProjectChanges } from "@/lib/canvas/canvas-persistence-merge";

// Real adapter code with only browser boundaries substituted. Native IndexedDB
// atomicity and corruption checks live in architecture-lab-browser.cjs.
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
        localForageStorage: { getItem: async () => value },
        updateCanvasStorage: async (_name: string, update: (stored: string | null) => string | null) => { value = update(value); },
        mergeProjectChanges,
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
