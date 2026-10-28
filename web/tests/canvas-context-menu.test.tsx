import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";
import { canvasContextMenuPosition } from "@/components/canvas/canvas-context-menu";

const componentUrl = new URL("../src/components/canvas/canvas-context-menu.tsx", import.meta.url);
const localRequire = createRequire(componentUrl);
const code = ts.transpileModule(readFileSync(componentUrl, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;

function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement(node)) return [];
    const element = node as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

type MenuHarnessOptions = { canGenerate?: boolean; type?: "canvas" | "node" | "connection"; theme?: "light" | "dark"; onUpload?: boolean; targetCount?: number; imageCount?: number };

function withMenu(run: (harness: ReturnType<typeof createMenuHarness>) => void, options: MenuHarnessOptions = {}) {
    const names = ["window", "document", "Element", "HTMLElement", "Node"] as const;
    const saved = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    try { run(createMenuHarness(options)); }
    finally { for (const [name, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
}

function createMenuHarness({ canGenerate = true, type = "canvas", theme = "light", onUpload = true, targetCount, imageCount }: MenuHarnessOptions) {
    const events: string[] = [];
    const layoutEffects: Array<() => (() => void) | undefined> = [], effects: Array<() => (() => void) | undefined> = [];
    const handlers = new Map<string, (event: any) => void>();
    const fakeDocument = { activeElement: null as FakeElement | null, body: null as FakeElement | null };
    class FakeElement {
        isConnected = true;
        popover = false;
        scrollHeight = 114;
        style = { background: "" };
        children: FakeElement[] = [];
        focus() { fakeDocument.activeElement = this; }
        contains(element: unknown) { return element === this || this.children.includes(element as FakeElement); }
        closest() { return this.popover ? this : null; }
        querySelector() { return this.children[0] || null; }
        querySelectorAll() { return this.children; }
    }
    const body = new FakeElement(), trigger = new FakeElement(), menuElement = new FakeElement(), outside = new FakeElement();
    fakeDocument.body = body; fakeDocument.activeElement = trigger;
    const fakeWindow = { innerWidth: 800, innerHeight: 600, addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler), removeEventListener: (name: string) => handlers.delete(name) };
    for (const [name, value] of Object.entries({ window: fakeWindow, document: fakeDocument, Element: FakeElement, HTMLElement: FakeElement, Node: FakeElement })) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    const dependencies: Record<string, unknown> = {
        react: { ...React, useEffect: (effect: () => (() => void) | undefined) => effects.push(effect), useLayoutEffect: (effect: () => (() => void) | undefined) => layoutEffects.push(effect), useRef: (current: unknown) => ({ current }), useState: (initial: Function) => [initial(), () => undefined] },
        "@/stores/use-theme-store": { useThemeStore: (select: Function) => select({ theme }) },
        "@/stores/use-module-store": { useModuleEnabled: () => canGenerate },
    };
    const module = { exports: {} as Record<string, (props: any) => ReactElement<any>> };
    new Function("require", "module", "exports", code)((name: string) => dependencies[name] || localRequire(name), module, module.exports);
    const root = module.exports.CanvasNodeContextMenu!({ menu: { type, x: 795, y: 595, canvasPosition: { x: 50, y: 60 }, nodeId: "node", connectionId: "connection" }, targetCount, imageCount, onDownloadImages: () => events.push("download"), onClose: () => events.push("close"), onDuplicate: () => events.push("duplicate"), onDelete: () => events.push("delete"), onGenerate: () => events.push("generate"), onGroup: () => events.push("group"), onRename: () => events.push("rename"), ...(onUpload ? { onUpload: () => events.push("upload") } : {}) });
    const menuButtons = elements(root).filter(item => typeof item.type === "function" && item.type.name === "MenuButton");
    menuElement.children = menuButtons.map(() => new FakeElement());
    root.props.ref.current = menuElement;
    const cleanups = [...layoutEffects.map(effect => effect()), ...effects.map(effect => effect())];
    const key = (keyName: string) => {
        let prevented = false, stopped = false;
        root.props.onKeyDown({ key: keyName, currentTarget: menuElement, preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
        return { prevented, stopped };
    };
    const unmount = () => {
        if (menuElement.contains(fakeDocument.activeElement)) fakeDocument.activeElement = body;
        root.props.ref.current = null;
        cleanups.forEach(cleanup => cleanup?.());
    };
    const labels = menuButtons.map(item => elements(module.exports.MenuButton!(item.props)).find(element => element.type === "span")?.props.children);
    return { root, menuButtons, labels, menuElement, trigger, outside, document: fakeDocument, handlers, events, key, unmount, exports: module.exports };
}

test("context menu fits the real viewport, including short and narrow screens", () => {
    expect(canvasContextMenuPosition(795, 595, 220, 114, { width: 800, height: 600 })).toEqual({ left: 572, top: 478, width: 220, maxHeight: 584 });
    expect(canvasContextMenuPosition(-10, -20, 220, 42, { width: 800, height: 600 })).toEqual({ left: 8, top: 8, width: 220, maxHeight: 584 });
    const small = canvasContextMenuPosition(180, 60, 220, 150, { width: 200, height: 80 });
    expect(small).toEqual({ left: 8, top: 8, width: 184, maxHeight: 64 });
    expect(small.left + small.width).toBeLessThanOrEqual(200 - 8);
});

test("upload is first and independent from canvas generation permissions", () => {
    withMenu(harness => {
        expect(harness.labels).toEqual(["上传图片", "创建款式组"]);
        harness.menuButtons[0]!.props.onClick();
        expect(harness.events).toEqual(["upload", "close"]);
        expect(harness.root.props.role).toBe("menu");
        expect(harness.root.props.style.width).toBe(300);
        expect(harness.root.props.style.background).toBe("#ffffff");
        expect(harness.root.props.className).toContain("gap-1");
        harness.unmount();
    }, { canGenerate: false });
});

test("generation and optional upload remain separate existing callbacks", () => {
    withMenu(harness => {
        expect(harness.labels).toEqual(["上传图片", "创建款式组", "生成"]);
        harness.menuButtons.at(-1)!.props.onClick();
        expect(harness.events).toEqual(["generate", "close"]);
        harness.unmount();
    });
    withMenu(harness => {
        expect(harness.labels).toEqual(["创建款式组", "生成"]);
        harness.unmount();
    }, { onUpload: false });
});

test("node and connection actions preserve behavior with Chinese labels and stable usage actions", () => {
    withMenu(harness => {
        expect(harness.labels).toEqual(["复制", "重命名", "创建款式组", "删除"]);
        expect(harness.menuButtons.map(item => item.props.action)).toEqual(["duplicate", "rename", "group", "delete"]);
        harness.menuButtons[0]!.props.onClick();
        expect(harness.events).toEqual(["duplicate", "close"]);
        harness.unmount();
    }, { type: "node" });
    withMenu(harness => {
        expect(harness.labels).toEqual(["创建款式组", "删除"]);
        expect(harness.root.props.style.background).not.toBe("#ffffff");
        harness.unmount();
    }, { type: "connection", theme: "dark" });
});

test.each([2, 7])("a %i-node selection shows its size and hides rename even when a rename callback exists", targetCount => {
    withMenu(harness => {
        expect(harness.labels).toEqual([`复制所选 ${targetCount} 项`, "创建款式组", `删除所选 ${targetCount} 项`]);
        expect(harness.menuButtons.map(item => item.props.action)).toEqual(["duplicate", "group", "delete"]);
        expect(harness.menuButtons.some(item => item.props.action === "rename")).toBe(false);
        expect(harness.events).toEqual([]);
        harness.unmount();
    }, { type: "node", targetCount });
});

test.each(["duplicate", "delete"])("multi-node %s activates its bulk callback and closes exactly once", action => {
    withMenu(harness => {
        const menuItem = harness.menuButtons.find(item => item.props.action === action)!;
        const button = harness.exports.MenuButton!(menuItem.props);
        expect(button.props["data-usage-control"]).toBe(`canvas-tool.${action}`);
        button.props.onClick({ preventDefault() {}, stopPropagation() {} });
        expect(harness.events).toEqual([action, "close"]);
        expect(harness.events).not.toContain("rename");
        harness.unmount();
    }, { type: "node", targetCount: 4 });
});

test("mixed selection downloads only its image count and closes once", () => {
    withMenu(harness => {
        expect(harness.labels).toEqual(["复制所选 3 项", "下载所选图片（2 张）", "创建款式组", "删除所选 3 项"]);
        harness.menuButtons.find(item => item.props.action === "downloadSelectedImages")!.props.onClick();
        expect(harness.events).toEqual(["download", "close"]);
        expect(harness.root.props.style.top).toBe(442);
        harness.unmount();
    }, { type: "node", targetCount: 3, imageCount: 2 });
    for (const type of ["canvas", "connection"] as const) withMenu(harness => {
        expect(harness.labels.some(label => label.includes("下载"))).toBe(false);
        harness.unmount();
    }, { type, imageCount: 2 });
});

test.each([
    [undefined, 4, 442],
    [1, 4, 442],
    [5, 3, 478],
] as const)("node keyboard navigation and initial fitting match targetCount=%s", (targetCount, expectedCount, expectedTop) => {
    withMenu(harness => {
        expect(harness.menuButtons).toHaveLength(expectedCount);
        // Initial placement must count only visible items, including the removed multi-rename item.
        expect(harness.root.props.style.top).toBe(expectedTop);
        const visited = [];
        for (let index = 0; index < expectedCount; index++) {
            visited.push(harness.document.activeElement);
            expect(harness.key("ArrowDown")).toEqual({ prevented: true, stopped: true });
        }
        expect(visited).toEqual(harness.menuElement.children);
        expect(new Set(visited).size).toBe(expectedCount);
        expect(harness.document.activeElement).toBe(harness.menuElement.children[0]);
        harness.key("ArrowUp");
        expect(harness.document.activeElement).toBe(harness.menuElement.children.at(-1));
        harness.key("Home");
        expect(harness.document.activeElement).toBe(harness.menuElement.children[0]);
        harness.key("End");
        expect(harness.document.activeElement).toBe(harness.menuElement.children.at(-1));
        expect(harness.events).toEqual([]);
        harness.unmount();
    }, { type: "node", targetCount });
});

test.each([
    ["canvas", ["上传图片", "创建款式组", "生成"]],
    ["connection", ["创建款式组", "删除"]],
] as const)("targetCount does not change %s menu labels or items", (type, labels) => {
    withMenu(harness => {
        expect(harness.labels).toEqual([...labels]);
        harness.unmount();
    }, { type, targetCount: 6 });
});

test("first item focuses, arrows wrap, Home/End navigate, and Escape restores the prior focus", () => {
    withMenu(harness => {
        expect(harness.document.activeElement).toBe(harness.menuElement.children[0]);
        expect(harness.key("ArrowUp")).toEqual({ prevented: true, stopped: true });
        expect(harness.document.activeElement).toBe(harness.menuElement.children.at(-1));
        harness.key("ArrowDown");
        expect(harness.document.activeElement).toBe(harness.menuElement.children[0]);
        harness.key("End");
        expect(harness.document.activeElement).toBe(harness.menuElement.children.at(-1));
        harness.key("Home");
        expect(harness.document.activeElement).toBe(harness.menuElement.children[0]);
        expect(harness.key("Escape")).toEqual({ prevented: true, stopped: true });
        expect(harness.events).toEqual(["close"]);
        harness.unmount();
        expect(harness.document.activeElement).toBe(harness.trigger);
        expect(harness.handlers.size).toBe(0);
    });
});

test("Enter and Space retain native activation while isolating canvas shortcuts", () => {
    withMenu(harness => {
        expect(harness.key("Enter")).toEqual({ prevented: false, stopped: true });
        expect(harness.key(" ")).toEqual({ prevented: false, stopped: true });
        const button = harness.exports.MenuButton!(harness.menuButtons[0]!.props);
        expect(button.props.type).toBe("button");
        expect(button.props.role).toBe("menuitem");
        expect(button.props.className).toContain("h-8");
        expect(button.props["data-usage-control"]).toBe("canvas-tool.upload");
        button.props.onClick({ preventDefault() {}, stopPropagation() {} });
        expect(harness.events).toEqual(["upload", "close"]);
        harness.unmount();
    });
});

test("outside pointer and dialog focus changes are not stolen on close", () => {
    withMenu(harness => {
        harness.handlers.get("pointerdown")!({ target: harness.menuElement.children[0] });
        expect(harness.events).toEqual([]);
        harness.outside.focus();
        harness.handlers.get("pointerdown")!({ target: harness.outside });
        expect(harness.events).toEqual(["close"]);
        harness.unmount();
        expect(harness.document.activeElement).toBe(harness.outside);
    });
    withMenu(harness => {
        harness.outside.focus();
        harness.unmount();
        expect(harness.document.activeElement).toBe(harness.outside);
    });
});
