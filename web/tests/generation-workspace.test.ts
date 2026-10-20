import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { useGenerationWorkspace } from "@/hooks/use-generation-workspace";

type Log = { id: string; media: string };
type Workspace = ReturnType<typeof useGenerationWorkspace<{ id: string }, Log>>;
const code = ts.transpileModule(readFileSync(new URL("../src/hooks/use-generation-workspace.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
}).outputText;

// Run the real hook with instance-local React state; no browser storage or APIs.
function workspace() {
    const values: unknown[] = [];
    let cursor = 0;
    let cleanup: (() => void) | undefined;
    let effectRan = false;
    const react = {
        useState(initial: unknown) {
            const index = cursor++;
            if (!(index in values)) values[index] = initial;
            return [values[index], (value: unknown) => {
                values[index] = typeof value === "function" ? value(values[index]) : value;
            }];
        },
        useRef(initial: unknown) {
            const index = cursor++;
            return values[index] ||= { current: initial };
        },
        useEffect(effect: () => () => void) {
            if (!effectRan) { effectRan = true; cleanup = effect(); }
        },
    };
    const module = { exports: {} as { useGenerationWorkspace: () => Workspace } };
    new Function("require", "module", "exports", code)((name: string) => {
        if (name !== "react") throw new Error(`Unexpected dependency: ${name}`);
        return react;
    }, module, module.exports);
    const render = () => { cursor = 0; return module.exports.useGenerationWorkspace(); };
    return { render, unmount: () => cleanup?.() };
}

function deferred() {
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

const first = { id: "first", media: "original-a" };
const second = { id: "second", media: "original-b" };
function selectHistory(h: ReturnType<typeof workspace>) {
    const state = h.render();
    state.setLogs([first, second]);
    state.setSelectedLogIds(["first"]);
    state.setPreviewLog(first);
    state.setDeleteConfirmOpen(true);
    return h.render();
}

test("pending deletion preserves confirmation and media preview, suppressing duplicate clicks", async () => {
    const h = workspace();
    const selected = selectHistory(h);
    const disk = deferred();
    const removed: Log[][] = [];
    const remove = async (logs: Log[]) => { removed.push(logs); await disk.promise; };
    const deletion = selected.deleteSelectedHistory(remove);
    expect(await selected.deleteSelectedHistory(remove)).toBeNull();
    expect(removed).toEqual([[first]]);
    expect(h.render().deletingLogs).toBe(true);
    expect(h.render().previewLog).toEqual(first);
    expect(h.render().deleteConfirmOpen).toBe(true);
    // A new completion arriving during deletion must not be lost.
    h.render().setLogs(current => [...current, { id: "new", media: "original-c" }]);
    disk.resolve();
    expect(await deletion).toEqual({ previewRemoved: true });
    expect(h.render().logs.map(log => log.id)).toEqual(["second", "new"]);
    expect(h.render().selectedLogIds).toEqual([]);
    expect(h.render().previewLog).toBeNull();
    expect(h.render().deleteConfirmOpen).toBe(false);
    expect(h.render().deletingLogs).toBe(false);
    h.unmount();
});

test("failed persistence keeps history and selection so the user can retry", async () => {
    const h = workspace();
    const state = selectHistory(h);
    await expect(state.deleteSelectedHistory(async () => { throw new Error("disk unavailable"); })).rejects.toThrow("disk unavailable");
    expect(h.render().logs).toEqual([first, second]);
    expect(h.render().selectedLogIds).toEqual(["first"]);
    expect(h.render().previewLog).toEqual(first);
    expect(h.render().deleteConfirmOpen).toBe(true);
    expect(h.render().deletingLogs).toBe(false);
    await h.render().deleteSelectedHistory(async () => undefined);
    expect(h.render().logs).toEqual([second]);
    h.unmount();
});

test("a late deletion does not update a closed workspace or another employee instance", async () => {
    const previous = workspace();
    const current = workspace();
    const state = selectHistory(previous);
    const disk = deferred();
    const deletion = state.deleteSelectedHistory(() => disk.promise);
    previous.unmount();
    current.render().setReferences([{ id: "employee-b-reference" }]);
    disk.resolve();
    expect(await deletion).toBeNull();
    expect(previous.render().logs).toEqual([first, second]);
    expect(current.render().logs).toEqual([]);
    expect(current.render().references).toEqual([{ id: "employee-b-reference" }]);
    expect(await previous.render().deleteSelectedHistory(async () => { throw new Error("must not write"); })).toBeNull();
    current.unmount();
});

test("stale history selection never deletes an absent record or clears a newer preview", async () => {
    const h = workspace();
    selectHistory(h);
    h.render().setSelectedLogIds(["first", "absent"]);
    const disk = deferred();
    let removed: Log[] = [];
    const deletion = h.render().deleteSelectedHistory(async logs => { removed = logs; await disk.promise; });
    h.render().setPreviewLog(second);
    h.render().setSelectedLogIds(["first", "second"]);
    h.render();
    disk.resolve();
    expect(await deletion).toEqual({ previewRemoved: false });
    expect(removed).toEqual([first]);
    expect(h.render().previewLog).toEqual(second);
    expect(h.render().selectedLogIds).toEqual(["second"]);
    h.unmount();
});
