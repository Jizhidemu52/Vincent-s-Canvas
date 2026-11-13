import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";

const source = readFileSync(new URL("../src/stores/canvas/use-canvas-ui-store.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("canvas-ui-store.ts", source, ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(ast.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getText(ast)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText;
const storageKey = "wireless-canvas:canvas_view";

function harness(initial?: string) {
    const values = new Map<string, string>(initial === undefined ? [] : [[storageKey, initial]]);
    const storage: StateStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
    const load = () => {
        const loaded: { useCanvasUiStore?: typeof useCanvasUiStore } = {};
        new Function("create", "persist", "createJSONStorage", "localStorage", "exports", code)(create, persist, createJSONStorage, storage, loaded);
        return loaded.useCanvasUiStore!;
    };
    return { values, load };
}

describe("canvas view-only connection preference", () => {
    test("shows connections by default and restores an explicit hidden preference in a new store", () => {
        const h = harness();
        const first = h.load();
        expect(first.getState().showConnections).toBe(true);
        first.getState().setShowConnections(false);
        expect(first.getState().showConnections).toBe(false);
        expect(JSON.parse(h.values.get(storageKey)!)).toEqual({ state: { showConnections: false }, version: 0 });
        const reopened = h.load();
        expect(reopened.getState().showConnections).toBe(false);
        reopened.getState().setShowConnections(true);
        expect(h.load().getState().showConnections).toBe(true);
    });

    test("persists only the tiny display flag and keeps transient project UI working", () => {
        const h = harness(), store = h.load();
        store.getState().startEditingProject("private-project", "原始项目名");
        store.getState().setSelectedProjectIds(["first", "second"]);
        store.getState().setDeleteProjectIds(["first"]);
        expect(store.getState().beginExport(["second"])).toBe(true);
        store.getState().setShowConnections(false);
        expect(store.getState()).toMatchObject({ editingProjectId: "private-project", editingProjectTitle: "原始项目名", selectedProjectIds: ["first", "second"], deleteProjectIds: ["first"], exportingProjectIds: ["second"] });
        expect(JSON.parse(h.values.get(storageKey)!)).toEqual({ state: { showConnections: false }, version: 0 });
        const reopened = h.load().getState();
        expect(reopened).toMatchObject({ showConnections: false, editingProjectId: null, editingProjectTitle: "", selectedProjectIds: [], deleteProjectIds: [], exportingProjectIds: [] });
        expect(typeof reopened.setShowConnections).toBe("function");
    });

    test("ignores invalid saved types and never hydrates unrelated fields", () => {
        for (const showConnections of [null, 0, "false", {}, []]) {
            const store = harness(JSON.stringify({ state: { showConnections, selectedProjectIds: ["injected"], setShowConnections: "invalid" }, version: 0 })).load();
            expect(store.getState().showConnections).toBe(true);
            expect(store.getState().selectedProjectIds).toEqual([]);
            expect(typeof store.getState().setShowConnections).toBe("function");
        }
        expect(harness("invalid JSON").load().getState().showConnections).toBe(true);
    });
});
