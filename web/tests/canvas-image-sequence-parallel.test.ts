import { describe, expect, test } from "bun:test";
import { displayHooksHarness } from "./helpers/display-hooks-harness";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as runtime from "@/pages/canvas/canvas-image-sequence-runtime";
import type { ImageSequenceOptions } from "@/pages/canvas/canvas-image-sequence-runtime";
import { stopCanvasObservation, shouldCancelCanvasGeneration } from "@/lib/canvas/canvas-project-async-lifecycle";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const source = readFileSync(new URL("../src/pages/canvas/use-canvas-image-sequence.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
const hook = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "useCanvasImageSequence")!;
const code = ts.transpileModule(hook.getText(ast).replace(/^export /, "").replaceAll('await import("./canvas-image-sequence-runtime")', "await loadRuntime()") + "\nexports.hook = useCanvasImageSequence;", { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function until(check: () => boolean) { for (let i = 0; i < 50 && !check(); i++) await tick(); expect(check()).toBe(true); }
const image = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 64, height: 64, metadata: { content: `data:image/png;base64,${id}`, status: "success" } });

function harness() {
    const options: ImageSequenceOptions = {
        projectId: "project-a", nodes: { current: [image("source-a"), image("source-b")] }, connections: { current: [] }, groups: { current: [] }, locks: { current: new Set() },
        setNodes(update) { options.nodes.current = typeof update === "function" ? update(options.nodes.current) : update; writes.push("nodes"); },
        setConnections(update) { options.connections.current = typeof update === "function" ? update(options.connections.current) : update; writes.push("connections"); },
        setGroups(update) { options.groups.current = typeof update === "function" ? update(options.groups.current) : update; writes.push("groups"); },
        stopGeneration(id) { stops.push(id); },
        async generate(id, lockKey, signal) {
            const gate = Promise.withResolvers<void>();
            calls.push({ id, lockKey, signal, gate });
            await gate.promise;
            if (signal.aborted) return;
            const output = image(`output-${id}`);
            options.nodes.current = [...options.nodes.current, output];
            options.connections.current = [...options.connections.current, { id: output.id, fromNodeId: id, toNodeId: output.id, kind: "generation-output" }];
            return { mode: "image", outputs: [{ nodeId: output.id, status: "success", url: output.metadata!.content }] };
        },
        async waitForWriteAccess() { return writable; }, isObservationCurrent() { return observation; },
    };
    let owner = "owner-a", role = "designer", status = "active", writable = true, observation = true;
    const writes: string[] = [], errors: string[] = [], stops: string[] = [], preparing = new Set<number>();
    let noticeId = 0, loadRuntime: () => Promise<typeof runtime> = async () => runtime;
    const calls: Array<{ id: string; lockKey: string; signal: AbortSignal; gate: ReturnType<typeof Promise.withResolvers<void>> }> = [];
    const first = runtime.addCanvasImageSequence(options, "source-a", [["A1", "A1"], ["A2", "A2"]]);
    const second = runtime.addCanvasImageSequence(options, "source-b", [["B1", "B1"], ["B2", "B2"]]);
    const refs: any[] = [], states: any[] = [], memos: Array<{ deps: unknown[]; value: unknown }> = [], effects: Array<{ deps: unknown[]; cleanup?: () => void }> = [];
    let refIndex = 0, stateIndex = 0, memoIndex = 0, effectIndex = 0, sequence = 0;
    const queued: Array<() => void> = [];
    const user = () => ({ id: owner, role, status });
    const store = Object.assign((selector: (value: any) => any) => selector({ user: user() }), { getState: () => ({ user: user() }) });
    const exports = {} as { hook: (options: ImageSequenceOptions) => ReturnType<typeof import("@/pages/canvas/use-canvas-image-sequence").useCanvasImageSequence> };
    const bindings = {
        displayNotice: displayHooksHarness.displayNotice,
        uiText: (value: string) => value, App: { useApp: () => ({ message: { error: (value: string) => errors.push(value), success() {}, info: (value: string) => errors.push(value),
            loading(value: string, duration: number) { expect(value).toBe("正在准备工作流并核对已有任务…"); expect(duration).toBe(0); const id = ++noticeId; preparing.add(id); return () => preparing.delete(id); },
        } }) },
        useUserStore: store, createClientId: () => `run-${++sequence}`, stopCanvasObservation, loadRuntime: () => loadRuntime(),
        useRef(value: unknown) { const index = refIndex++; return refs[index] ||= { current: value }; },
        useMemo(factory: () => unknown, deps: unknown[]) { const index = memoIndex++, previous = memos[index]; if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return previous.value; return (memos[index] = { deps, value: factory() }).value; },
        useState(value: unknown) { const index = stateIndex++; if (!(index in states)) states[index] = value; return [states[index], (update: any) => { states[index] = typeof update === "function" ? update(states[index]) : update; }]; },
        useEffect(callback: () => void | (() => void), deps: unknown[]) { const index = effectIndex++, previous = effects[index]; if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return; effects[index] = { deps }; queued.push(() => { previous?.cleanup?.(); effects[index]!.cleanup = callback() || undefined; }); },
    };
    new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exports);
    function render() { refIndex = stateIndex = memoIndex = effectIndex = 0; const result = exports.hook(options); queued.splice(0).forEach(effect => effect()); return result; }
    return { options, first, second, calls, errors, stops, writes, render, preparing,
        setRuntimeLoader(loader: () => Promise<typeof runtime>) { loadRuntime = loader; },
        owner(value: string) { owner = value; }, role() { role = "admin"; }, status() { status = "disabled"; }, revoke() { writable = observation = false; }, cleanup() { effects.forEach(effect => effect.cleanup?.()); },
        result(id: string) { calls.find(call => call.id === id)!.gate.resolve(); },
    };
}

describe("independent canvas image workflow sessions", () => {
    test("preparation is visible immediately and clears on dispatch, early failure or departure", async () => {
        const h = harness(), ui = h.render(), gate = Promise.withResolvers<typeof runtime>();
        h.setRuntimeLoader(() => gate.promise);
        const running = ui.run(h.first.group.id);
        expect(h.preparing.size).toBe(1); expect(h.calls).toHaveLength(0);
        gate.resolve(runtime); await until(() => h.calls.length === 1);
        expect(h.preparing.size).toBe(0);
        ui.stop(h.first.group.id); h.result(h.first.nodes[0]!.id); await running;
        h.setRuntimeLoader(async () => { throw new Error("runtime unavailable"); });
        await ui.run(h.second.group.id);
        expect(h.preparing.size).toBe(0); expect(h.errors).toContain("runtime unavailable");
        const delayed = Promise.withResolvers<typeof runtime>();
        h.setRuntimeLoader(() => delayed.promise);
        const departing = ui.run(h.second.group.id);
        expect(h.preparing.size).toBe(1);
        h.cleanup(); expect(h.preparing.size).toBe(0);
        delayed.resolve(runtime); await departing;
        expect(h.calls).toHaveLength(1); expect(h.options.locks.current.size).toBe(0);
    });

    test("A unfinished permits B dispatch; B finishes first and both keep step order and progress", async () => {
        const h = harness(), ui = h.render();
        const a = ui.run(h.first.group.id); await until(() => h.calls.length === 1);
        const b = ui.run(h.second.group.id); await until(() => h.calls.length === 2);
        expect(h.calls.map(call => call.id)).toEqual([h.first.nodes[0]!.id, h.second.nodes[0]!.id]);
        expect(h.render().activeGroupIds).toEqual(new Set([h.first.group.id, h.second.group.id]));
        expect(new Set(h.calls.map(call => call.lockKey)).size).toBe(2);
        h.result(h.second.nodes[0]!.id); await until(() => h.calls.length === 3);
        expect(h.calls[2]!.id).toBe(h.second.nodes[1]!.id);
        h.result(h.second.nodes[1]!.id); await b;
        expect(h.render().activeGroupIds).toEqual(new Set([h.first.group.id]));
        h.result(h.first.nodes[0]!.id); await until(() => h.calls.length === 4);
        h.result(h.first.nodes[1]!.id); await a;
        expect(h.options.groups.current.map(group => group.imageSequence!.status)).toEqual(["success", "success"]);
        expect(h.render().activeGroupIds.size).toBe(0); expect(h.options.locks.current.size).toBe(0); expect(h.errors).toEqual([]); h.cleanup();
    });

    test("double clicks and intersecting plans cannot alter a live group's progress or dispatch twice", async () => {
        const h = harness(), ui = h.render();
        const a = ui.run(h.first.group.id), duplicate = ui.run(h.first.group.id);
        await until(() => h.calls.length === 1); await duplicate;
        const progress = structuredClone(h.options.groups.current.find(group => group.id === h.first.group.id));
        await h.render().runFromNode(h.first.nodes[1]!.id);
        expect(h.calls).toHaveLength(1);
        expect(h.options.groups.current.find(group => group.id === h.first.group.id)).toEqual(progress);
        expect(h.errors).toHaveLength(2);
        h.render().stop(h.first.group.id); h.result(h.first.nodes[0]!.id); await a;
        expect(h.calls).toHaveLength(1); h.cleanup();
    });

    test.each(["group", "node"])("stopping by %s stops only A; hiding the dialog stops neither session", async selector => {
        const h = harness(), ui = h.render();
        const a = ui.run(h.first.group.id), b = ui.run(h.second.group.id);
        await until(() => h.calls.length === 2);
        ui.setDialog(null); expect(h.calls.every(call => !call.signal.aborted)).toBe(true);
        if (selector === "group") h.render().stop(h.first.group.id); else h.render().stop(undefined, h.first.nodes[1]!.id);
        expect(h.calls.map(call => call.signal.aborted)).toEqual([true, false]);
        expect(h.stops).toEqual([h.first.nodes[0]!.id]);
        h.result(h.first.nodes[0]!.id); await a;
        expect(h.render().activeGroupIds).toEqual(new Set([h.second.group.id]));
        h.result(h.second.nodes[0]!.id); await until(() => h.calls.length === 3);
        h.result(h.second.nodes[1]!.id); await b;
        expect(h.options.groups.current.find(group => group.id === h.second.group.id)?.imageSequence?.status).toBe("success"); h.cleanup();
    });

    test("ordinary node dispatch locks are respected and all reserved workflow nodes exclude ordinary generation", async () => {
        const h = harness(), ui = h.render(), id = h.first.nodes[0]!.id;
        h.options.locks.current.add(id);
        const before = structuredClone(h.options.groups.current);
        await ui.run(h.first.group.id);
        expect(h.calls).toHaveLength(0); expect(h.options.groups.current).toEqual(before);
        expect(h.options.locks.current).toEqual(new Set([id]));
        h.options.locks.current.delete(id);
        const a = ui.run(h.first.group.id); await until(() => h.calls.length === 1);
        expect(h.first.nodes.every(node => h.options.locks.current.has(node.id))).toBe(true);
        expect(h.second.nodes.every(node => !h.options.locks.current.has(node.id))).toBe(true);
        h.cleanup(); expect(h.options.locks.current.size).toBe(0);
        // A finally must not delete another owner's later reservation of the same ID.
        h.options.locks.current.add(id);
        h.result(id); await a;
        expect(h.options.locks.current).toEqual(new Set([id]));
    });

    test("removing A's workflow during a write-access wait never submits A and leaves B runnable", async () => {
        const h = harness(), ui = h.render(), gate = Promise.withResolvers<boolean>();
        let waits = 0;
        h.options.waitForWriteAccess = async () => ++waits === 2 ? gate.promise : true;
        const a = ui.run(h.first.group.id); await until(() => waits === 2);
        h.options.groups.current = h.options.groups.current.filter(group => group.id !== h.first.group.id);
        gate.resolve(true); await a;
        expect(h.calls).toHaveLength(0);
        const b = ui.run(h.second.group.id); await until(() => h.calls.length === 1);
        ui.stop(h.second.group.id); h.result(h.second.nodes[0]!.id); await b;
        expect(h.calls).toHaveLength(1); h.cleanup();
    });

    test("unknown A attempts stay blocked while unrelated B starts, without resetting A history", async () => {
        const h = harness(), ui = h.render();
        const group = runtime.prepareCanvasImageWorkflow(h.options, h.first.nodes[0]!.id);
        group.imageSequence!.steps[0]!.status = "running";
        group.imageSequence!.status = "stopped";
        await ui.run(group.id);
        expect(h.calls).toHaveLength(0);
        expect(h.options.groups.current.find(item => item.id === group.id)!.imageSequence!.steps[0]!.status).toBe("running");
        const b = ui.run(h.second.group.id); await until(() => h.calls.length === 1);
        expect(h.calls[0]!.id).toBe(h.second.nodes[0]!.id);
        ui.stop(h.second.group.id); h.result(h.second.nodes[0]!.id); await b; h.cleanup();
    });

    test.each(["role", "status"] as const)("same owner %s change before React rerender prevents late writes and further submission", async changed => {
        const h = harness(), ui = h.render();
        const a = ui.run(h.first.group.id); await until(() => h.calls.length === 1);
        h[changed](); const writes = h.writes.length;
        ui.stop(h.first.group.id); expect(h.stops).toEqual([]);
        h.result(h.first.nodes[0]!.id); await a;
        expect(h.writes).toHaveLength(writes); expect(h.calls).toHaveLength(1);
        expect(shouldCancelCanvasGeneration(h.calls[0]!.signal)).toBe(false); h.cleanup();
    });

    test("stale A callbacks cannot add, run or stop in B or a later A instance with the same node IDs", async () => {
        const h = harness(), oldA = h.render();
        for (const projectId of ["project-b", "project-a"]) {
            h.options.projectId = projectId;
            const current = h.render();
            const nodes = h.options.nodes.current.length, writes = h.writes.length;
            await oldA.add("source-a", [["stale", "stale"]]);
            await oldA.run(h.first.group.id);
            expect(h.options.nodes.current).toHaveLength(nodes); expect(h.writes).toHaveLength(writes);
            const running = current.run(h.first.group.id);
            const expected = h.calls.length + 1; await until(() => h.calls.length === expected);
            oldA.stop(h.first.group.id, h.first.nodes[0]!.id);
            expect(h.calls.at(-1)!.signal.aborted).toBe(false);
            current.stop(h.first.group.id); h.calls.at(-1)!.gate.resolve(); await running;
        }
        expect(h.calls).toHaveLength(2); expect(h.stops).toHaveLength(2); h.cleanup();
    });

    test.each(["project", "owner", "unmount", "lease"])("%s invalidation forbids late writes and later steps without cancelling accepted work", async changed => {
        const h = harness(), ui = h.render();
        const a = ui.run(h.first.group.id), b = ui.run(h.second.group.id);
        await until(() => h.calls.length === 2);
        if (changed === "project") { h.options.projectId = "project-b"; h.render(); }
        else if (changed === "owner") { h.owner("owner-b"); h.render(); }
        else if (changed === "unmount") h.cleanup();
        else h.revoke();
        const writes = h.writes.length;
        h.result(h.first.nodes[0]!.id); h.result(h.second.nodes[0]!.id); await Promise.all([a, b]);
        expect(h.calls).toHaveLength(2); expect(h.writes).toHaveLength(writes); expect(h.stops).toEqual([]);
        expect(h.calls.every(call => call.signal.aborted && !shouldCancelCanvasGeneration(call.signal))).toBe(true);
        expect(h.options.locks.current.size).toBe(0); h.cleanup();
    });
});
