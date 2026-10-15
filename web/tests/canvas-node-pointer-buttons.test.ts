import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

import { CanvasNodeType } from "@/types/canvas";

// Exercise the component's actual input callbacks; the DOM listener boundary is supplied below.
const source = readFileSync(new URL("../src/components/canvas/canvas-node.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("canvas-node.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let bodyMouseDown: ts.Expression;
let resizeMouseDown: ts.Expression;
function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "handleResizeMouseDown") resizeMouseDown = node.initializer!;
    if (ts.isJsxOpeningElement(node) && node.attributes.properties.some(property => ts.isJsxAttribute(property) && property.name.getText(ast) === "data-canvas-image-frame")) {
        const property = node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(ast) === "onMouseDown") as ts.JsxAttribute;
        bodyMouseDown = (property.initializer as ts.JsxExpression).expression!;
    }
    ts.forEachChild(node, collect);
}
collect(ast);
const code = ts.transpileModule(`return { body: ${bodyMouseDown!.getText(ast)}, resize: ${resizeMouseDown!.getText(ast)} };`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

class Element {
    constructor(private blocked = false) {}
    closest(selector: string) { return this.blocked && selector === "[data-canvas-no-zoom]" ? this : null; }
}

function harness() {
    const forwarded: string[] = [];
    const listeners: string[] = [];
    const resizeRef = { current: { isResizing: false } as Record<string, unknown> };
    const env = {
        Element, CanvasNodeType, resizeRef,
        data: { id: "image", type: CanvasNodeType.Image, width: 240, height: 180, position: { x: 100, y: 80 }, metadata: { naturalWidth: 800, naturalHeight: 600 } },
        onMouseDown: (_event: unknown, id: string) => { forwarded.push(id); },
        window: { addEventListener: (name: string) => { listeners.push(name); } },
        handleResizeMove: () => {}, handleResizeUp: () => {},
    };
    const callbacks = new Function("env", `const { ${Object.keys(env).join(",")} } = env; ${code}`)(env);
    return { ...callbacks, forwarded, listeners, resizeRef };
}

function pointer(button: number, blocked = false) {
    return { button, clientX: 150, clientY: 120, target: new Element(blocked), stopped: false, prevented: false,
        stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } };
}

test.each([1, 2])("button %i cannot enter node dragging or resizing", button => {
    const canvas = harness();
    const bodyEvent = pointer(button);
    canvas.body(bodyEvent);
    expect(canvas.forwarded).toEqual([]);
    expect(bodyEvent.stopped).toBe(true);
    const resizeEvent = pointer(button);
    canvas.resize(resizeEvent, "bottom-right");
    expect(resizeEvent.stopped).toBe(true);
    expect(canvas.resizeRef.current).toEqual({ isResizing: false });
    expect(canvas.listeners).toEqual([]);
});

test("primary input retains node dragging and the existing image resize geometry", () => {
    const canvas = harness();
    canvas.body(pointer(0));
    expect(canvas.forwarded).toEqual(["image"]);
    const event = pointer(0);
    canvas.resize(event, "bottom-right");
    expect(event.prevented).toBe(true);
    expect(canvas.resizeRef.current).toMatchObject({ isResizing: true, corner: "bottom-right", startX: 150, startY: 120, startLeft: 100, startTop: 80, startWidth: 240, startHeight: 180, keepRatio: true, ratio: 800 / 600 });
    expect(canvas.listeners).toEqual(["mousemove", "mouseup"]);
});

test("embedded controls remain excluded from node drag dispatch", () => {
    const canvas = harness();
    canvas.body(pointer(0, true));
    expect(canvas.forwarded).toEqual([]);
});
