import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import ts from "typescript";

function handle(kind: "create" | "chat") {
    const url = new URL("../src/components/canvas/canvas-panel-resize-handle.tsx", import.meta.url);
    const localRequire = createRequire(url);
    const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const commits: unknown[][] = [], styles: unknown[][] = [], cleanups: Array<() => void> = [];
    const state = { createWidth: 480, chatWidth: 480, setWidth: (...args: unknown[]) => commits.push(args) };
    const deps: Record<string, unknown> = {
        react: { ...React, useRef: (current: unknown) => ({ current }), useState: () => [null, () => undefined], useEffect: (fn: () => () => void) => cleanups.push(fn()) },
        "@/stores/canvas/use-canvas-panel-store": { useCanvasPanelStore: (select: Function) => select(state) },
    };
    const module = { exports: {} as { CanvasPanelResizeHandle: Function } };
    new Function("require", "module", "exports", code)((name: string) => deps[name] || localRequire(name), module, module.exports);
    const props = module.exports.CanvasPanelResizeHandle({ kind }).props;
    let captured = false;
    const root = { style: { setProperty: (...args: unknown[]) => styles.push(args) } };
    const target = { closest: () => root, focus() {}, setPointerCapture() { captured = true; }, hasPointerCapture: () => captured, releasePointerCapture() { captured = false; } };
    const event = (clientX: number, button = 0) => ({ clientX, button, pointerId: 1, currentTarget: target, preventDefault() {}, stopPropagation() {} });
    return { props, commits, styles, cleanups, event };
}

test("drag previews without persisting every move, then commits only the final width", () => {
    const h = handle("create");
    h.props.onPointerDown(h.event(300));
    h.props.onPointerMove(h.event(370));
    expect(h.styles.at(-1)).toEqual(["--cw-create-width", "550px"]);
    expect(h.commits).toHaveLength(0);
    h.props.onPointerUp(h.event(370));
    h.props.onLostPointerCapture(h.event(370));
    expect(h.commits).toEqual([["create", 550]]);
});

test("secondary pointer never resizes and cancelled drags restore their starting width", () => {
    const h = handle("chat");
    h.props.onPointerDown(h.event(300, 2));
    h.props.onPointerMove(h.event(400));
    expect(h.styles).toHaveLength(0);
    h.props.onPointerDown(h.event(300));
    h.props.onPointerMove(h.event(1000));
    expect(h.styles.at(-1)).toEqual(["--cw-chat-width", "680px"]);
    h.props.onPointerCancel(h.event(1000));
    expect(h.styles.at(-1)).toEqual(["--cw-chat-width", "480px"]);
    expect(h.commits).toHaveLength(0);
});

test("unmount restores an unfinished preview and reset uses each panel's default", () => {
    const h = handle("chat");
    h.props.onPointerDown(h.event(300));
    h.props.onPointerMove(h.event(360));
    h.cleanups.forEach(cleanup => cleanup());
    expect(h.styles.at(-1)).toEqual(["--cw-chat-width", "480px"]);
    expect(h.commits).toHaveLength(0);
    h.props.onDoubleClick(h.event(300));
    expect(h.commits).toEqual([["chat", 480]]);
    expect(h.props.role).toBe("separator");
    expect(h.props["aria-valuenow"]).toBe(480);
});
