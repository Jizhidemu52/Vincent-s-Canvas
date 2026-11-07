import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React, { type ComponentProps, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { CanvasNode } from "@/components/canvas/canvas-node";
import { conversationImageLabel } from "@/components/conversation-image-controls";
import { canvasThemes } from "@/lib/canvas-theme";
import { uiText } from "@/lib/i18n";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const source = readFileSync(new URL("../src/components/canvas/canvas-agent-chat-ui.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("canvas-agent-chat-ui.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined {
    return predicate(node) ? node : ts.forEachChild(node, child => find(child, predicate));
}
const previewUpdates: unknown[] = [];
function evaluate(node: ts.Node) {
    const code = ts.transpileModule(`exports.value = (${node.getText(ast)});`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ESNext } }).outputText;
    const bindings = { React, useUiText: () => uiText, useState: (initial: unknown) => [initial, (value: unknown) => previewUpdates.push(value)], conversationImageLabel, CanvasPersistedMediaPreview: "preview", ConversationImagePreview: "full-preview", ConversationImageActions: "image-actions", WandSparkles: "icon" };
    const exports = {} as { value: any };
    new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exports);
    return exports.value;
}
const renderAttachments = evaluate(find(ast, node => ts.isFunctionDeclaration(node) && node.name?.text === "AgentMessageAttachments")!);
const messageDeclaration = find(ast, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === "AgentChatMessage") as ts.VariableDeclaration;
const compareMessages = evaluate((messageDeclaration.initializer as ts.CallExpression).arguments[1]);
function elements(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}
const attachment = { id: "result", name: "原始名称.png", url: "data:image/png;base64,AQID", width: 320, height: 240 };
const image = { id: "result-image", label: "图2", name: attachment.name, dataUrl: attachment.url };
const base = { messageId: "message", attachments: [attachment], theme: canvasThemes.light, imageControls: new Map([["message:result", { image, version: 3 }]]), onImageAction() {} };
const render = (patch: object = {}) => { previewUpdates.length = 0; return elements(renderAttachments({ ...base, ...patch })); };
const byId = (tree: ReactElement<any>[], id: string) => tree.find(element => element.props["data-testid"] === id)!;

test("result card keeps original media, explicit version and current selection while compact controls remain separate", () => {
    const tree = render({ activeImageId: image.id });
    const preview = tree.find(element => element.type === "preview")!;
    expect(preview.props).toMatchObject({ url: attachment.url, alt: attachment.name, width: 320, height: 240 });
    expect(tree.find(element => element.type === "button")!.props["aria-haspopup"]).toBe("dialog");
    expect(byId(tree, "canvas-agent-image-result").props.style.borderColor).toBe(canvasThemes.light.node.activeStroke);
    expect(tree.some(element => element.type === "span" && element.props.children?.includes?.(" · V3"))).toBe(true);
    expect(byId(tree, "canvas-agent-image-current").props.children).toBe("当前");
    const actions = tree.find(element => element.type === "image-actions")!;
    expect(actions.props).toMatchObject({ compact: true, image, disabled: undefined });
    expect(elements(tree.find(element => element.type === "button")!.props.children)).not.toContain(actions);
    const overlay = byId(tree, "canvas-agent-image-actions").props.className;
    expect(overlay).toContain("[@media(hover:hover)]:opacity-0");
    expect(overlay).toContain("group-hover/result:opacity-100");
    expect(overlay).toContain("group-focus-within/result:opacity-100");
    expect(overlay).not.toContain("hidden");
});

test("preview keeps catalog identity without changing the target, while explicit edit and mask keep their callbacks", () => {
    const calls: unknown[][] = [];
    const action = (...args: unknown[]) => calls.push(args);
    const mask = (id: string) => calls.push(["mask", id]);
    const tree = render({ onImageAction: action, onMaskImage: mask });
    tree.find(element => element.type === "button")!.props.onClick();
    expect(previewUpdates).toEqual([image]);
    expect(calls).toEqual([]);
    tree.find(element => element.type === "image-actions")!.props.onAction("edit", image.id);
    tree.find(element => element.type === "image-actions")!.props.onMask();
    expect(calls).toEqual([["edit", image.id], ["mask", image.id]]);
    const override = render({ onMaskImage: mask, imageControls: new Map([["message:result", { image, onMask: () => calls.push(["specific"]) }]]) });
    override.find(element => element.type === "image-actions")!.props.onMask();
    expect(calls.at(-1)).toEqual(["specific"]);
    expect(render().find(element => element.type === "image-actions")!.props.onMask).toBeUndefined();
});

test("busy, unavailable and unselected cards retain accurate state without inventing a current target or version", () => {
    // Accepted work disables mutating actions, not a read-only original preview.
    expect(render({ disabled: true }).find(element => element.type === "button")!.props.disabled).toBe(false);
    expect(render({ disabled: true }).find(element => element.type === "image-actions")!.props.disabled).toBe(true);
    const unavailable = render({ imageControls: new Map([["message:result", { image: { ...image, unavailableReason: "原图无法读取" }, version: 0 }]]) });
    expect(unavailable.find(element => element.type === "button")!.props.disabled).toBe(true);
    expect(byId(unavailable, "canvas-agent-image-current")).toBeUndefined();
    expect(unavailable.some(element => element.type === "span" && element.props.children?.includes?.(" · V0"))).toBe(false);
    const plain = render({ imageControls: undefined });
    expect(byId(plain, "canvas-agent-image-result").props.style.borderColor).toBe(canvasThemes.light.node.stroke);
    expect(byId(plain, "canvas-agent-image-actions")).toBeUndefined();
});

test("message memoization observes changed mask callbacks only when the message contains attachments", () => {
    const previous = { item: { id: "message", attachments: [attachment] }, onMaskImage() {} };
    expect(compareMessages(previous, { ...previous })).toBe(true);
    expect(compareMessages(previous, { ...previous, onMaskImage() {} })).toBe(false);
    const text = { item: { id: "text", text: "hello" }, onMaskImage() {} };
    expect(compareMessages(text, { ...text, onMaskImage() {} })).toBe(true);
});

const noop = () => {};
const node: CanvasNodeData = { id: "node", type: CanvasNodeType.Image, title: "Version", position: { x: 0, y: 0 }, width: 320, height: 240,
    metadata: { storageKey: "image:version", status: "success", imageAgent: { workId: "work", version: 3, note: { summary: "blue", keep: [] } } } };
const nodeProps: ComponentProps<typeof CanvasNode> = { data: node, theme: canvasThemes.light, themeKey: "light", renderQuality: "full", getCanvasScale: () => 1,
    isSelected: false, isRelated: false, isFocusRelated: false, isConnectionTarget: false, isConnecting: false, isRunning: false, showPanel: false, showImageInfo: false,
    onMouseDown: noop, onHoverStart: noop, onHoverEnd: noop, onConnectStart: noop, onResize: noop, onResizeEnd: noop, onContentChange: noop, onContextMenu: noop };

test("persisted image nodes retain metadata version badges without selection or the image info toggle", () => {
    for (const theme of ["light", "dark"] as const) {
        const html = renderToStaticMarkup(<CanvasNode {...nodeProps} theme={canvasThemes[theme]} themeKey={theme} />);
        expect(html).toContain('data-testid="canvas-node-agent-version"');
        expect(html).toContain(">V3</span>");
        expect(html).toContain(canvasThemes[theme].node.panel);
    }
    for (const version of [0, -1, 1.5, NaN]) {
        const invalid = { ...node, metadata: { ...node.metadata, imageAgent: { ...node.metadata!.imageAgent!, version } } };
        expect(renderToStaticMarkup(<CanvasNode {...nodeProps} data={invalid} />)).not.toContain('data-testid="canvas-node-agent-version"');
    }
    expect(renderToStaticMarkup(<CanvasNode {...nodeProps} data={{ ...node, metadata: { content: attachment.url } }} />)).not.toContain('data-testid="canvas-node-agent-version"');
});
