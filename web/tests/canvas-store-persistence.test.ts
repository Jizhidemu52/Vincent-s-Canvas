import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createDeferredPersistQueue } from "@/lib/deferred-persist-queue";
import { collectProjectChanges, createProjectChangeBuffer, mergeProjectChanges } from "@/lib/canvas/canvas-persistence-merge";
import { applyCanvasProjectPatch } from "@/lib/canvas/canvas-project-update";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType } from "@/types/canvas";

const source = readFileSync(new URL("../src/stores/canvas/use-canvas-store.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("store.ts", source, ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(ast.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
}).outputText;
const storageKey = "wireless-canvas:canvas_store";
function project(): CanvasProject {
    return { id: "shared", title: "原画布", createdAt: "old", updatedAt: "old", backgroundMode: "dots", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, activeChatId: null, chatSessions: [], connections: [], nodes: [
        { id: "a", type: CanvasNodeType.Image, title: "A", width: 640, height: 320, position: { x: 0, y: 0 }, metadata: { content: "data:image/png;base64,b3JpZ2luYWw=", storageKey: "image:original" } },
        { id: "b", type: CanvasNodeType.Text, title: "B", width: 300, height: 200, position: { x: 800, y: 0 }, metadata: { content: "原始说明" } },
    ] };
}

function database() {
    const values = new Map<string, string>([[storageKey, JSON.stringify({ state: { projects: [project()] }, version: 0 })]]);
    let atomicChain = Promise.resolve();
    let writeFailures = 0;
    let nextWriteGate: Promise<void> | undefined;
    const writes: string[] = [];
    const adapter = {
        async getItem(key: string) { await Promise.resolve(); return values.get(key) || null; },
        async setItem(key: string, value: string) {
            const gate = nextWriteGate;
            nextWriteGate = undefined;
            if (gate) await gate;
            if (writeFailures-- > 0) throw new Error("disk full");
            writes.push(value);
            values.set(key, value);
        },
        async removeItem(key: string) { values.delete(key); },
    };
    return {
        adapter, writes,
        failNextWrite() { writeFailures += 1; },
        pauseNextWrite(gate: Promise<void>) { nextWriteGate = gate; },
        read: () => (JSON.parse(values.get(storageKey)!) as { state: { projects: CanvasProject[] } }).state.projects,
        // Only the IndexedDB boundary is substituted. Each store still executes
        // its real collector, debounce queue, retry buffer and three-way merge.
        update(key: string, mutate: (value: string | null) => string | null) {
            const operation = atomicChain.catch(() => undefined).then(async () => {
                const next = mutate(await adapter.getItem(key));
                if (next === null) await adapter.removeItem(key);
                else await adapter.setItem(key, next);
            });
            atomicChain = operation;
            return operation;
        },
    };
}

async function openTab(io: ReturnType<typeof database>) {
    let ids = 0;
    const errors: unknown[][] = [];
    const bindings = {
        create, persist, nanoid: () => `new-${++ids}`, collectProjectChanges, createProjectChangeBuffer, mergeProjectChanges, applyCanvasProjectPatch,
        localForageStorage: io.adapter,
        updateCanvasStorage: io.update,
        withCanvasStorageLock: async (_name: string, callback: () => unknown) => callback(),
        createDeferredPersistQueue: <T>(delay: number, flush: (value: T) => void) => createDeferredPersistQueue(delay, flush, { setTimeout: () => 1, clearTimeout() {} }),
        window: { addEventListener() {} },
        console: { error: (...args: unknown[]) => errors.push(args) },
    };
    const exports = {} as { useCanvasStore: any; flushCanvasPersistence: () => Promise<void> };
    new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exports);
    const store = exports.useCanvasStore;
    if (!store.persist.hasHydrated()) await new Promise<void>(resolve => { const unsubscribe = store.persist.onFinishHydration(() => { unsubscribe(); resolve(); }); });
    return { store, flush: exports.flushCanvasPersistence, errors };
}

test("two actual store instances saving concurrently cannot overwrite separate moves or additions", async () => {
    const io = database(), a = await openTab(io), b = await openTab(io);
    const aNodes = a.store.getState().projects[0].nodes.map((node: any) => node.id === "a" ? { ...node, position: { x: 100, y: 0 } } : node);
    const bNodes = b.store.getState().projects[0].nodes.map((node: any) => node.id === "b" ? { ...node, position: { x: 800, y: 200 } } : node);
    a.store.getState().updateProject("shared", { nodes: aNodes });
    b.store.getState().updateProject("shared", { nodes: [...bNodes, { ...bNodes[1], id: "new-b" }] });
    await Promise.all([a.flush(), b.flush()]);
    expect(io.read()).toHaveLength(1);
    expect(io.read()[0]!.nodes.map(node => [node.id, node.position])).toEqual([["a", { x: 100, y: 0 }], ["b", { x: 800, y: 200 }], ["new-b", { x: 800, y: 200 }]]);
    // The page still has its own editable snapshot. Another local save must not
    // mistake a remotely added/moved node for an intentional local removal.
    b.store.getState().renameProject("shared", "继续编辑");
    await b.flush();
    expect(io.read()[0]!.nodes[0]!.position.x).toBe(100);
    expect(io.read()[0]!.title).toBe("继续编辑");
});

test("a conflict copy is saved and immediately discoverable in the writing tab's project list", async () => {
    const io = database(), a = await openTab(io), b = await openTab(io);
    a.store.getState().renameProject("shared", "窗口 A 名称");
    await a.flush();
    b.store.getState().renameProject("shared", "窗口 B 名称");
    await b.flush();
    expect(io.read()).toHaveLength(2);
    const copy = io.read().find(item => item.id !== "shared")!;
    expect(copy.title).toContain("窗口 A 名称");
    expect(copy.title).toContain("保存冲突副本");
    expect(copy.nodes).toEqual(project().nodes);
    expect(b.store.getState().projects.find((item: CanvasProject) => item.id === copy.id)).toEqual(copy);
    expect(io.read().find(item => item.id === "shared")!.title).toBe("窗口 B 名称");
});

test("failed writes followed by newer edits retain the original baseline and the newest local content", async () => {
    const io = database(), a = await openTab(io), b = await openTab(io);
    io.failNextWrite();
    a.store.getState().renameProject("shared", "第一版");
    await expect(a.flush()).rejects.toThrow();
    b.store.getState().updateProject("shared", { backgroundMode: "grid" });
    await b.flush();
    a.store.getState().renameProject("shared", "最后一版");
    await a.flush();
    expect(io.read()).toHaveLength(1);
    expect(io.read()[0]).toMatchObject({ title: "最后一版", backgroundMode: "grid", nodes: project().nodes });
});

test("a slow earlier write cannot roll back a newer pending local edit", async () => {
    const io = database(), tab = await openTab(io);
    const gate = Promise.withResolvers<void>();
    io.pauseNextWrite(gate.promise);
    tab.store.getState().renameProject("shared", "较早快照");
    const first = tab.flush();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    tab.store.getState().renameProject("shared", "最新快照");
    const second = tab.flush();
    gate.resolve();
    await Promise.all([first, second]);
    expect(io.read()[0]!.title).toBe("最新快照");
    expect(tab.store.getState().projects[0].title).toBe("最新快照");
});

test("normal project import and intentional deletion preserve full image, graph and chat contents", async () => {
    const io = database(), tab = await openTab(io);
    const imported = { ...project(), chatSessions: [{ id: "chat", title: "讨论", createdAt: "old", updatedAt: "old", messages: [{ id: "message", role: "user" as const, text: "导入内容" }] }], connections: [{ id: "ab", fromNodeId: "a", toNodeId: "b" }] };
    const id = tab.store.getState().importProject(imported);
    tab.store.getState().deleteProjects(["shared"]);
    await tab.flush();
    expect(io.read()).toHaveLength(1);
    expect(io.read()[0]).toMatchObject({ id, nodes: imported.nodes, connections: imported.connections, chatSessions: imported.chatSessions });
    expect(io.read()[0]!.title).not.toContain("保存冲突副本");
});
