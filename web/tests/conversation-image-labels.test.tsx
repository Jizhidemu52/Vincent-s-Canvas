import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React, { type ReactElement } from "react";
import ts from "typescript";
import { conversationImageLabel } from "@/components/conversation-image-controls";
import { canvasThemes } from "@/lib/canvas-theme";
import { setUiLocale, setUiPathname, uiText } from "@/lib/i18n";

afterEach(async () => { setUiPathname("/"); await setUiLocale("zh-CN"); });

function findNode(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined {
    return predicate(node) ? node : ts.forEachChild(node, child => findNode(child, predicate));
}

// Execute the actual presentation functions/expressions without mounting the
// surrounding chat transport, stores or persistence. No global module mocks.
function evaluate(path: string, select: (ast: ts.SourceFile) => ts.Node | undefined, bindings: Record<string, unknown>) {
    const source = readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const selected = select(ast);
    if (!selected) throw new Error(`Presentation source not found: ${path}`);
    const code = ts.transpileModule(`exports.value = (${selected.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React } }).outputText;
    const exports = {} as { value: any };
    new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exports);
    return exports.value;
}

const bindings = {
    React, uiText, useUiText: () => uiText, conversationImageLabel, canvasThemes,
    useThemeStore: (select: (state: { theme: "light" }) => unknown) => select({ theme: "light" }),
    CanvasPersistedMediaPreview: "preview", ConversationImageActions: "image-actions", X: "icon", WandSparkles: "icon",
};

function component(path: string, name: string, extra: Record<string, unknown> = {}) {
    return evaluate(path, ast => {
        const declaration = findNode(ast, node => ts.isFunctionDeclaration(node) && node.name?.text === name || ts.isVariableDeclaration(node) && node.name.getText(ast) === name);
        return declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isCallExpression(declaration.initializer)
            ? declaration.initializer.arguments[0] : declaration;
    }, { ...bindings, ...extra });
}

function elements(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

test("chat image accessible labels switch languages without changing canonical labels or action IDs", async () => {
    const image = { id: "saved-image-2", dataUrl: "data:image/png;base64,AQID", name: "我的图片.png" };
    const original = structuredClone(image), selected: unknown[][] = [];
    const render = () => {
        let state = 0;
        const ChatImage = component("pages/chat/chat-image.tsx", "ChatImage", {
            useUserStore: () => undefined, useEffect() {},
            useState: (initial: unknown) => [state++ === 0 ? image.dataUrl : initial, () => undefined],
            cn: (...values: unknown[]) => values.filter(Boolean).join(" "), Button: "button",
        });
        return elements(ChatImage({ image, label: "图2", onAction: (...args: unknown[]) => selected.push(args) }));
    };
    expect(render().find(node => node.type === "button")!.props["aria-label"]).toBe("以 图2 为编辑目标");
    await setUiLocale("en-US");
    const english = render(), button = english.find(node => node.type === "button")!;
    expect(button.props["aria-label"]).toBe("Use Image 2 as the editing target");
    expect(english.find(node => node.type === "img")!.props.alt).toBe("Image 2");
    button.props.onClick();
    expect(selected).toEqual([["edit", image.id]]);
    expect(english.find(node => node.type === "image-actions")!.props.image.label).toBe("图2");
    expect(image).toEqual(original);
    await setUiLocale("zh-CN");
    expect(render().find(node => node.type === "img")!.props.alt).toBe("图2");
});

test("chat reference chips localize catalog labels but leave fallback filenames untouched", async () => {
    const imageLabels = new Map([["saved-image-4", "图4"]]);
    const chip = (id: string, name: string) => evaluate("pages/chat/index.tsx", ast => findNode(ast, node => ts.isCallExpression(node) && node.expression.getText(ast) === "uiText" && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "参考 · {value1}"), { uiText, conversationImageLabel, imageLabels, item: { id, name } });
    expect(chip("saved-image-4", "用户的原名.png")).toBe("参考 · 图4");
    await setUiLocale("en-US");
    expect(chip("saved-image-4", "用户的原名.png")).toBe("Reference · Image 4");
    expect(chip("uncataloged", "图4")).toBe("Reference · 图4");
    expect(imageLabels.get("saved-image-4")).toBe("图4");
});

test("canvas image targets localize accessibility text without changing attachment names or IDs", async () => {
    await setUiLocale("en-US");
    const render = component("components/canvas/canvas-agent-chat-ui.tsx", "AgentMessageAttachments");
    const attachment = { id: "attachment-2", name: "我的图2.png", url: "data:image/png;base64,AQID" };
    const image = { id: "catalog-image-2", label: "图2", name: attachment.name, dataUrl: attachment.url };
    const selected: unknown[][] = [];
    const tree = elements(render({ messageId: "message", attachments: [attachment], theme: canvasThemes.light,
        imageControls: new Map([["message:attachment-2", { image }]]), onImageAction: (...args: unknown[]) => selected.push(args) }));
    const button = tree.find(node => node.type === "button")!;
    expect(button.props["aria-label"]).toBe("Select Image 2 as the editing target");
    expect(tree.find(node => node.type === "preview")!.props.alt).toBe(attachment.name);
    button.props.onClick();
    expect(selected).toEqual([["edit", image.id]]);
    expect(image.label).toBe("图2");
});

test("canvas reference chips localize canonical and original labels but not user titles", async () => {
    await setUiLocale("en-US");
    const render = component("components/canvas/canvas-assistant-panel.tsx", "AssistantReferenceChip");
    const item = { id: "saved-reference", title: "图4", dataUrl: "data:image/png;base64,AQID" };
    for (const [label, display] of [["图4", "Image 4"], ["原图4", "Original 4"], ["Image 4", "Image 4"], [undefined, "图4"]]) {
        const tree = elements(render({ item, label, onSelect() {} }));
        expect(tree.find(node => node.type === "button")!.props["aria-label"]).toBe(`Select ${display} as the editing target`);
        if (label) expect(tree.some(node => node.type === "span" && node.props.children === display)).toBe(true);
        expect(tree.find(node => node.type === "preview")!.props.alt).toBe(item.title);
    }
    expect(item.title).toBe("图4");
});
