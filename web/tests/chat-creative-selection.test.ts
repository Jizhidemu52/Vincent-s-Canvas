import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React, { type ReactElement } from "react";
import ts from "typescript";

const source = readFileSync(new URL("../src/pages/chat/index.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("chat.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function bubbleHarness(actionsDisabled = false) {
    let initializer: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "ChatBubble") initializer = node.initializer;
        ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!initializer) throw new Error("The actual ChatBubble component was not found");
    const calls: unknown[] = [];
    const bindings = {
        React, memo: <T,>(component: T) => component,
        cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
        Bot: () => null, FileText: () => null, Copy: () => null, Pencil: () => null, RotateCcw: () => null,
        useCopyText: () => () => undefined, ChatMarkdown: "div", ChatImage: "chat-image", Tooltip: "div",
    };
    const code = ts.transpileModule(`exports.Bubble = ${initializer.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React } }).outputText;
    const exports = {} as { Bubble: (props: any) => ReactElement<any> };
    new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exports);
    const generated = { id: "task:0", dataUrl: "data:image/png;base64,cmVzdWx0", lineage: { parentImageId: "original", sourceImageIds: ["original"], preservedConstraints: ["保留中文"] } };
    const message = { id: "assistant", role: "assistant", content: "", generatedImages: [generated], attachments: [
        { id: "original", name: "原图.png", dataUrl: "data:image/png;base64,b3JpZ2luYWw=" },
        { id: "brief", name: "规格.pdf", textContent: "20cm" },
    ] };
    const tree = exports.Bubble({ message, imageLabels: new Map([["original", "图1"], ["task:0", "图2"]]), actionsDisabled, onPlaceOnCanvas: (image: unknown) => calls.push(image) });
    const nodes: ReactElement<any>[] = [];
    function walk(value: any) {
        if (Array.isArray(value)) { value.forEach(walk); return; }
        if (!React.isValidElement(value)) return;
        const node = value as ReactElement<any>;
        nodes.push(node);
        walk(node.props.children);
    }
    walk(tree);
    const text = (value: any): string => Array.isArray(value) ? value.map(text).join("") : React.isValidElement(value) ? text((value as ReactElement<any>).props.children) : typeof value === "string" ? value : "";
    return { tree, nodes, calls, generated, text };
}

test("the page has one natural conversation entry and no LLM model, mode, or manual edit-target controls", () => {
    const labels: string[] = [];
    const calledFunctions: string[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isJsxAttribute(node) && node.name.getText(ast) === "aria-label" && node.initializer && ts.isStringLiteral(node.initializer)) labels.push(node.initializer.text);
        if (ts.isCallExpression(node)) calledFunctions.push(node.expression.getText(ast));
        ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(labels.filter((label) => label === "出图模型")).toHaveLength(1);
    for (const label of ["对话模型", "编辑起点", "创作理解模型", "图像模型"]) expect(labels).not.toContain(label);
    for (const fn of ["switchMode", "continueEditing", "setMode", "onContinueEditing"]) expect(calledFunctions).not.toContain(fn);
});

test("real chat image bubbles display originals and results without an edit-selection button", () => {
    const page = bubbleHarness();
    const images = page.nodes.filter((node) => node.type === "chat-image");
    expect(images.map((node) => node.props.image.dataUrl)).toEqual(["data:image/png;base64,cmVzdWx0", "data:image/png;base64,b3JpZ2luYWw="]);
    const buttons = page.nodes.filter((node) => node.type === "button");
    expect(buttons.map((button) => page.text(button))).toEqual([]);
    expect(page.text(page.tree)).not.toMatch(/继续编辑|编辑起点|从这版继续|当前起点/);
    expect(page.text(page.tree)).toContain("规格.pdf");
    expect(page.calls).toEqual([]);
    images[0]!.props.onPlace();
    expect(page.calls).toEqual([page.generated]);
});

test("the remaining canvas action is disabled while a task is busy", () => {
    const page = bubbleHarness(true);
    expect(page.nodes.find((node) => node.type === "chat-image" && node.props.onPlace)?.props.disabled).toBe(true);
    expect(page.calls).toEqual([]);
});
