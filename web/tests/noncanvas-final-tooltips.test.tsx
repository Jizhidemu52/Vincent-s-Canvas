import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import ts from "typescript";

test("local tooltip follows disabled reason and restores the original shortcut without changing the button", () => {
    const source = readFileSync(new URL("../src/pages/design-workbench/local/tooltip-controls.tsx", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    let value = "", mounted = false, refresh = () => {}, disconnects = 0;
    const effects: Array<() => void | (() => void)> = [];
    const inserted: unknown[] = [];
    const native = { disabled: true, dataset: { workbenchTooltip: "Ctrl / ⌘ + Z", workbenchDisabledReason: "还没有可撤销的操作" }, payload: { artwork: "unchanged" } };
    const originalPayload = native.payload;
    const dependencies: Record<string, unknown> = {
        react: { ...React, useRef: () => ({ current: { append: (node: unknown) => inserted.push(node) } }),
            useState: (initial: () => string) => { if (!mounted) value = initial(); return [value, (next: string) => { value = next; }]; },
            useLayoutEffect: (effect: () => void) => { if (!mounted) effects.push(effect); } },
        "react/jsx-runtime": { jsx: React.createElement },
        "react-dom": {}, antd: { Tooltip: "tooltip" }, "@/lib/i18n": { uiText: (text: string) => text }, "./tooltip-controls.css": {},
    };
    class Observer {
        constructor(callback: () => void) { refresh = callback; }
        observe(target: unknown, options: MutationObserverInit) { expect(target).toBe(native); expect(options.attributeFilter).toContain("disabled"); }
        disconnect() { disconnects++; }
    }
    const module = { exports: {} as { inspect: (props: { native: unknown }) => React.ReactElement<{ title: string }> } };
    new Function("require", "module", "exports", "MutationObserver", `${compiled}\nexports.inspect = NativeButtonTooltip;`)((name: string) => dependencies[name], module, module.exports, Observer);
    expect(module.exports.inspect({ native }).props.title).toBe("还没有可撤销的操作");
    const cleanups = effects.map(effect => effect()); mounted = true;
    native.disabled = false; refresh();
    expect(module.exports.inspect({ native }).props.title).toBe("Ctrl / ⌘ + Z");
    native.disabled = true; native.dataset.workbenchDisabledReason = "请先选择图案图层"; refresh();
    expect(module.exports.inspect({ native }).props.title).toBe("请先选择图案图层");
    expect(inserted).toEqual([native]); expect(native.payload).toBe(originalPayload);
    cleanups.forEach(cleanup => { if (typeof cleanup === "function") cleanup(); });
    expect(disconnects).toBe(1);
});
