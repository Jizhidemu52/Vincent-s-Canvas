import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type DependencyList, type ReactElement } from "react";
import ts from "typescript";

function elements(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

function dialogHarness(kind: string, name: string, extraProps: Record<string, unknown> = {}) {
    const file = kind === "reference" ? "canvas-image-reference-dialog" : `canvas-node-${kind}-dialog`;
    const source = new URL(`../src/components/canvas/${file}.tsx`, import.meta.url);
    const requireModule = createRequire(source);
    const code = ts.transpileModule(readFileSync(source, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const values: any[] = [];
    const effects: Array<{ deps?: DependencyList; cleanup?: () => void }> = [];
    const pending: Array<() => void> = [];
    const reads: Array<ReturnType<typeof Promise.withResolvers<{ width: number; height: number }>>> = [];
    let cursor = 0;
    const dependencies: Record<string, unknown> = {
        react: {
            ...React,
            useRef: (value: unknown) => { const index = cursor++; return values[index] ||= { current: value }; },
            useState: (value: any) => {
                const index = cursor++;
                if (!(index in values)) values[index] = value;
                return [values[index], (next: any) => { values[index] = typeof next === "function" ? next(values[index]) : next; }];
            },
            useMemo: (factory: () => unknown) => factory(),
            useEffect: (effect: () => (() => void) | undefined, deps?: DependencyList) => {
                const index = cursor++;
                const previous = effects[index];
                if (!previous || !deps || !previous.deps || deps.some((value, i) => !Object.is(value, previous.deps![i]))) {
                    pending.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; });
                }
            },
        },
        antd: { Button: "Button", Modal: "Modal", InputNumber: "InputNumber", Segmented: "Segmented", Select: "Select", Checkbox: "Checkbox", Empty: "Empty", theme: { useToken: () => ({ token: {} }) } },
        "lucide-react": new Proxy({}, { get: (_target, key) => String(key) }),
        "@/lib/image-utils": { readImageMeta() { const reading = Promise.withResolvers<{ width: number; height: number }>(); reads.push(reading); return reading.promise; } },
    };
    const module = { exports: {} as Record<string, Function> };
    new Function("require", "module", "exports", code)((key: string) => dependencies[key] || requireModule(key), module, module.exports);
    const render = (dataUrl = "blob:first", open = true, props: Record<string, unknown> = {}) => {
        cursor = 0;
        const result = elements(module.exports[name]!({ dataUrl, open, onClose() {}, onConfirm() {}, ...extraProps, ...props }));
        for (const effect of pending.splice(0)) effect();
        return result;
    };
    return { render, reads };
}

const referenceNodes = ["first", "second"].map(id => ({ id, title: id, type: "image", metadata: { content: `data:image/png;base64,${id}` } }));
const reference = (tree: ReactElement<any>[], id: string) => tree.find(element => element.type === "button" && element.props["aria-label"] === `选择参考图 ${id}`)!;
const referenceConfirm = (tree: ReactElement<any>[]) => {
    const modal = tree.find(element => element.type === "Modal")!;
    return elements(modal.props.footer).find(element => element.type === "Button" && element.props.type === "primary")!;
};

test("reference picker discards canceled choices and confirms only newly selected nodes", () => {
    const confirmed: string[][] = [];
    const h = dialogHarness("reference", "CanvasImageReferenceDialog", { nodes: referenceNodes, selectedReferenceKeys: [], onConfirm: (ids: string[]) => confirmed.push(ids) });
    h.render();
    reference(h.render(), "first").props.onClick();
    expect(referenceConfirm(h.render()).props.disabled).toBe(false);
    h.render().find(element => element.type === "Modal")!.props.onCancel();
    h.render(undefined, false); h.render(undefined, true);
    expect(referenceConfirm(h.render()).props.disabled).toBe(true);
    expect(reference(h.render(), "first").props["aria-pressed"]).toBe(false);
    reference(h.render(), "second").props.onClick();
    referenceConfirm(h.render()).props.onClick();
    expect(confirmed).toEqual([["second"]]);
    expect(referenceConfirm(h.render()).props.disabled).toBe(true);
});

test("reference picker recognizes canvas and connection keys and drops nodes removed while open", () => {
    const h = dialogHarness("reference", "CanvasImageReferenceDialog", { nodes: referenceNodes, selectedReferenceKeys: ["canvas:first"] });
    h.render();
    const added = h.render().find(element => element.type === "button" && element.props["aria-label"] === "已添加 first")!;
    expect(added.props.disabled).toBe(true);
    expect(added.props["aria-pressed"]).toBe(true);
    reference(h.render(), "second").props.onClick();
    h.render(undefined, true, { nodes: [referenceNodes[0]] });
    expect(referenceConfirm(h.render(undefined, true, { nodes: [referenceNodes[0]] })).props.disabled).toBe(true);
    h.render(undefined, true, { selectedReferenceKeys: ["connection:second"] });
    expect(h.render(undefined, true, { selectedReferenceKeys: ["connection:second"] }).some(element => element.type === "button" && element.props["aria-label"] === "已添加 second" && element.props.disabled)).toBe(true);
});

const confirmation = (tree: ReactElement<any>[]) => tree.find(element => element.type === "Button" && element.props.type === "primary")!;
const alerts = (tree: ReactElement<any>[]) => tree.filter(element => element.props.role === "alert");

for (const [kind, name] of [["crop", "CanvasNodeCropDialog"], ["split", "CanvasNodeSplitDialog"], ["upscale", "CanvasNodeUpscaleDialog"]]) {
    test(`${kind} shows decode failures and cannot confirm an unreadable image`, async () => {
        const h = dialogHarness(kind!, name!);
        expect(confirmation(h.render()).props.disabled).toBe(true);
        h.reads[0]!.reject(new Error("图片已损坏"));
        await Promise.resolve();
        const failed = h.render();
        expect(alerts(failed).map(alert => alert.props.children)).toEqual(["图片已损坏"]);
        expect(confirmation(failed).props.disabled).toBe(true);
        h.render("blob:valid");
        expect(alerts(h.render("blob:valid"))).toEqual([]);
        h.reads[1]!.resolve({ width: 640, height: 480 });
        await Promise.resolve();
        expect(confirmation(h.render("blob:valid")).props.disabled).toBe(false);
    });

    test(`${kind} ignores metadata or errors belonging to a previous image or closed dialog`, async () => {
        const h = dialogHarness(kind!, name!);
        h.render("blob:old");
        h.render("blob:new");
        h.reads[0]!.resolve({ width: 640, height: 480 });
        await Promise.resolve();
        expect(confirmation(h.render("blob:new")).props.disabled).toBe(true);
        h.render("blob:new", false);
        h.reads[1]!.reject(new Error("旧请求失败"));
        await Promise.resolve();
        expect(alerts(h.render("blob:new", false))).toEqual([]);
    });
}
