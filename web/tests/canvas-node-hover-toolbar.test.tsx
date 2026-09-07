import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";

import { defaultImageQuickToolIds, readImageQuickToolsConfig } from "@/components/canvas/canvas-image-toolbar-tools";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const requireModule = createRequire(new URL("../src/components/canvas/canvas-node-hover-toolbar.tsx", import.meta.url));
const code = ts.transpileModule(readFileSync(new URL("../src/components/canvas/canvas-node-hover-toolbar.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;

function toolbarHarness() {
    const states: unknown[] = [];
    let index = 0;
    const calls: Array<{ name: string; node?: CanvasNodeData }> = [];
    const node: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "花瓶", position: { x: 200, y: 150 }, width: 340, height: 340, metadata: { content: "blob:image", prompt: "绿色花瓶", status: "error" } };
    const dependencies: Record<string, unknown> = {
        react: {
            ...React,
            useMemo: (factory: () => unknown) => factory(),
            useEffect: () => undefined,
            useLayoutEffect: () => undefined,
            useRef: (current: unknown) => ({ current }),
            useState: (initial: unknown) => {
                const current = index++;
                if (!(current in states)) states[current] = typeof initial === "function" ? initial() : initial;
                return [states[current], (value: unknown) => { states[current] = typeof value === "function" ? value(states[current]) : value; }];
            },
        },
        antd: { ...requireModule("antd"), App: { useApp: () => ({ message: { warning: () => undefined } }) } },
        "@/stores/use-theme-store": { useThemeStore: (selector: (state: unknown) => unknown) => selector({ theme: "light" }) },
        "@/hooks/use-copy-text": { useCopyText: () => () => calls.push({ name: "onCopyPrompt", node }) },
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", code)((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name), module, module.exports);
    const handlers = Object.fromEntries(["onKeep", "onLeave", "onInfo", "onEditText", "onDecreaseFont", "onIncreaseFont", "onToggleDialog", "onGenerateImage", "onUpload", "onDownload", "onSaveAsset", "onManualEdit", "onMaskEdit", "onCrop", "onSplit", "onUpscale", "onSuperResolve", "onAngle", "onViewImage", "onReversePrompt", "onRetry", "onToggleFreeResize", "onDelete"].map((name) => [name, (target?: CanvasNodeData) => calls.push({ name, node: target })]));
    const render = () => { index = 0; return module.exports.CanvasNodeHoverToolbar({ node, viewport: { x: 0, y: 0, k: 1 }, ...handlers }); };
    return { node, calls, render, exports: module.exports };
}

function elements(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

describe("compact image toolbar", () => {
    test("defaults to four common actions while preserving stored customization data", () => {
        expect(defaultImageQuickToolIds).toEqual(["manualEdit", "edit", "maskEdit", "download"]);
        const saved = { ids: ["info", "delete", "saveAsset", "download", "edit", "copyPrompt", "upscale"], showLabels: false };
        expect(readImageQuickToolsConfig(saved)).toEqual(saved);
    });

    test("shows only the four common image actions on the first surface", () => {
        const view = elements(toolbarHarness().render());
        expect(view.filter((element) => typeof element.props.id === "string" && typeof element.props.onClick === "function").map((element) => element.props.id)).toEqual(["manualEdit", "edit", "maskEdit", "download"]);
        const more = view.find((element) => element.props["aria-label"] === "更多图片工具");
        expect(more?.props["aria-haspopup"]).toBe("menu");
    });

    test("every secondary tool is directly executable from More without opening settings", () => {
        const harness = toolbarHarness();
        const dropdown = elements(harness.render()).find((element) => element.props.menu?.items)!;
        expect(dropdown).toBeDefined();
        dropdown.props.onOpenChange(true);
        const opened = elements(harness.render());
        expect(opened.find((element) => element.props.menu?.items)?.props.open).toBe(true);
        expect(opened.find((element) => Array.isArray(element.props.selectedIds))?.props.open).toBe(false);
        const actions: Record<string, string> = { info: "onInfo", delete: "onDelete", retry: "onRetry", saveAsset: "onSaveAsset", copyPrompt: "onCopyPrompt", reversePrompt: "onReversePrompt", replace: "onUpload", resize: "onToggleFreeResize", crop: "onCrop", split: "onSplit", upscale: "onUpscale", superResolve: "onSuperResolve", angle: "onAngle", view: "onViewImage" };
        const items = dropdown.props.menu.items.flatMap((item: any) => item.children || [item]);
        for (const [id, handler] of Object.entries(actions)) {
            expect(items.some((item: any) => item.key === id)).toBe(true);
            dropdown.props.menu.onClick({ key: id, domEvent: { stopPropagation() {} } });
            expect(harness.calls).toContainEqual({ name: handler, node: harness.node });
        }
        expect(items.at(-1).key).toBe("customize");
    });

    test("keeps the toolbar available while its More menu is open", () => {
        const harness = toolbarHarness();
        elements(harness.render()).find((element) => element.props.menu?.items)!.props.onOpenChange(true);
        const toolbar = elements(harness.render()).find((element) => element.props["data-canvas-node-toolbar"] === "true")!;
        toolbar.props.onMouseLeave();
        expect(harness.calls.filter((call) => call.name === "onLeave")).toHaveLength(0);
    });

    test("clamps the floating toolbar inside narrow and corner viewports", () => {
        const clamp = toolbarHarness().exports.clampCanvasNodeToolbarPosition;
        expect(clamp({ left: -50, top: 5, width: 360, height: 44, containerWidth: 800, containerHeight: 500 })).toEqual({ left: 192, top: 56 });
        expect(clamp({ left: 950, top: 700, width: 360, height: 44, containerWidth: 800, containerHeight: 500 })).toEqual({ left: 608, top: 488 });
        expect(clamp({ left: 250, top: 60, width: 360, height: 44, containerWidth: 320, containerHeight: 200 })).toEqual({ left: 160, top: 60 });
    });
});
