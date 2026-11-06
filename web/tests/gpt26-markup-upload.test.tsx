import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import ts from "typescript";
import { i18nHarness } from "./helpers/i18n-harness";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function elements(node: unknown): React.ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement<any>(node)) return [];
    return [node, ...elements(node.props.children)];
}

function harness() {
    const path = new URL("../src/components/image-settings-panel.tsx", import.meta.url), requireModule = createRequire(path);
    let finish: (value: unknown) => void = () => {}, started = 0;
    const pending = new Promise(resolve => { finish = resolve; });
    const refs: any[] = [], states: any[] = [], effects: Array<() => void> = [];
    let ri = 0, si = 0, mounted = false;
    const dependencies: Record<string, unknown> = {
        react: { ...React, useState: (initial: unknown) => { const index = si++; if (!(index in states)) states[index] = initial; return [states[index], (next: unknown) => { states[index] = next; }]; },
            useRef: (initial: unknown) => refs[ri++] ||= { current: initial }, useEffect: (effect: () => (() => void)) => { if (!mounted) effects.push(effect()); } },
        "@/lib/i18n": i18nHarness,
        "@/services/image-storage": { uploadImage: async () => { started++; return pending; } },
        "./image-settings-panel.css": {},
    };
    const compiled = ts.transpileModule(`${readFileSync(path, "utf8")}\nexport { ImageMarkupInput };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const module = { exports: {} as any };
    new Function("require", "module", "exports", compiled)((name: string) => dependencies[name] ?? requireModule(name), module, module.exports);
    const writes: string[] = [];
    let props = { value: "", referenceCount: 1, contextKey: "draft:one|model:26|ref:A", onChange: (value: string) => writes.push(value) };
    const render = (patch = {}) => { props = { ...props, ...patch }; ri = si = 0; const view = module.exports.ImageMarkupInput(props); mounted = true; return view; };
    const unmount = () => { effects.splice(0).forEach(cleanup => cleanup()); };
    cleanups.push(unmount);
    return { render, writes, unmount, started: () => started,
        pick: () => elements(render()).find(item => item.type === "input")!.props.onChange({ target: { files: [new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "overlay.png", { type: "image/png" })], value: "" } }),
        finish: () => finish({ storageKey: "image:overlay", url: "blob:overlay", width: 1024, height: 1024, bytes: 100 }) };
}

test.each(["draft", "reference", "model", "value", "unmount"])("markup upload never writes after %s context changes", async change => {
    const app = harness();
    app.pick(); await settle();
    expect(app.started()).toBe(1);
    if (change === "unmount") app.unmount();
    else app.render(change === "value" ? { value: "replacement-layer" } : { contextKey: `${change}:changed` });
    app.finish(); await settle();
    expect(app.writes).toEqual([]);
});

test("current markup upload commits its original metadata through the newest live config callback", async () => {
    const app = harness(), current: string[] = [];
    app.pick(); await settle();
    app.render({ onChange: (value: string) => current.push(value) });
    app.finish(); await settle();
    expect(app.writes).toEqual([]);
    expect(current).toHaveLength(1);
    expect(JSON.parse(current[0]!)).toMatchObject({ name: "overlay.png", storageKey: "image:overlay", dataUrl: "blob:overlay", type: "image/png", bytes: 100 });
});
