import { expect, test } from "bun:test";
import { createCanvasGraphStore } from "../src/stores/canvas/canvas-graph-store";
import { handleCanvasShortcut, type CanvasShortcutActions } from "../src/pages/canvas/use-canvas-shortcuts";
import { CanvasNodeType } from "../src/types/canvas";

test("graph scopes and unchanged node references stay isolated during hover and streaming", () => {
    const a = createCanvasGraphStore(), b = createCanvasGraphStore();
    const nodes = Array.from({ length: 250 }, (_, i) => ({ id: `n${i}`, type: CanvasNodeType.Text, title: `N${i}`, position: { x: i, y: 0 }, width: 100, height: 80 }));
    a.getState().setField("nodes", nodes);
    const nodeIndex = a.getState().nodeById;
    a.getState().setField("hoveredNodeId", "n1");
    a.getState().setField("streamedTextById", new Map([["n1", "token"]]));
    expect(a.getState().nodes).toBe(nodes);
    expect(a.getState().nodeById).toBe(nodeIndex);
    expect(b.getState().nodes).toHaveLength(0);
    a.getState().setField("nodes", current => current.map(n => n.id === "n1" ? { ...n, title: "changed" } : n));
    expect(a.getState().nodeById.get("n2")).toBe(nodes[2]);
    expect(a.getState().nodeById.get("n1")).not.toBe(nodes[1]);
    let changes = 0;
    const off = a.subscribe(() => changes++);
    a.getState().setField("nodes", current => current);
    off();
    expect(changes).toBe(0);
});

test("extracted shortcuts preserve clipboard, IME, focused-input and repeat guards", () => {
    const called: string[] = [];
    const actions = Object.fromEntries(["duplicate", "group", "undo", "redo", "selectAll", "deleteSelection", "escape"].map(name => [name, () => called.push(name)])) as CanvasShortcutActions;
    const run = (key: string, overrides = {}) => {
        const event = { key, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, isComposing: false, keyCode: 0, defaultPrevented: false, repeat: false, target: null, preventDefault() { this.defaultPrevented = true; }, ...overrides };
        handleCanvasShortcut(event as unknown as KeyboardEvent, actions);
        return event.defaultPrevented;
    };
    for (const key of ["c", "v", "x"]) expect(run(key)).toBe(false);
    run("d", { repeat: true }); run("d", { isComposing: true }); run("Delete", { target: { closest: () => true } });
    expect(called).toEqual([]);
    run("d"); run("g"); run("z"); run("z", { shiftKey: true }); run("a"); run("Delete", { ctrlKey: false }); run("Escape", { ctrlKey: false });
    expect(called).toEqual(["duplicate", "group", "undo", "redo", "selectAll", "deleteSelection", "escape"]);
});
