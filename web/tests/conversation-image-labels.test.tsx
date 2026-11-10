import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React, { type ReactElement } from "react";
import ts from "typescript";
import { conversationImageLabel } from "@/components/conversation-image-controls";
import { canvasThemes } from "@/lib/canvas-theme";
import { canvasConversationImageForAsset, canvasConversationImages } from "@/lib/canvas/canvas-assistant-image-catalog";
import { setUiLocale, setUiPathname, uiText } from "@/lib/i18n";
import { CanvasNodeType, type CanvasAssistantMessage } from "@/types/canvas";

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
    const code = ts.transpileModule(`exports.value = (${selected.getText(ast).replace(/^export\s+/, "")});`, { compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React } }).outputText;
    const exports = {} as { value: any };
    new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exports);
    return exports.value;
}

const bindings = {
    React, uiText, useUiText: () => uiText, conversationImageLabel, canvasThemes,
    useThemeStore: (select: (state: { theme: "light" }) => unknown) => select({ theme: "light" }),
    CanvasPersistedMediaPreview: "preview", ConversationImageActions: "image-actions", X: "icon", WandSparkles: "icon",
    ConversationImagePreview: "full-image-preview", useState: (initial: unknown) => [initial, () => undefined],
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

test("chat full-image preview labels switch languages without editing the target or changing canonical labels", async () => {
    const image = { id: "saved-image-2", dataUrl: "data:image/png;base64,AQID", name: "我的图片.png" };
    const original = structuredClone(image), selected: unknown[][] = [], opened: unknown[] = [];
    const render = () => {
        let state = 0;
        const ChatImage = component("pages/chat/chat-image.tsx", "ChatImage", {
            useUserStore: () => undefined, useEffect() {},
            useState: (initial: unknown) => [state++ === 0 ? image.dataUrl : initial, (next: unknown) => opened.push(next)],
            cn: (...values: unknown[]) => values.filter(Boolean).join(" "), Button: "button",
        });
        return elements(ChatImage({ image, label: "图2", onAction: (...args: unknown[]) => selected.push(args) }));
    };
    expect(render().find(node => node.type === "button")!.props["aria-label"]).toBe("查看大图 · 图2");
    await setUiLocale("en-US");
    const english = render(), button = english.find(node => node.type === "button")!;
    expect(button.props["aria-label"]).toBe("View full image · Image 2");
    expect(english.find(node => node.type === "img")!.props.alt).toBe("Image 2");
    button.props.onClick();
    expect(opened).toEqual([true]); expect(selected).toEqual([]);
    expect(english.some(node => node.type === "image-actions")).toBe(false);
    english.find(node => node.type === "button" && node.props["aria-label"] === "Download original · Image 2")!.props.onClick();
    expect(selected).toEqual([["download", image.id]]);
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

test("canvas image preview localizes accessibility text without changing the selected target, attachment names or IDs", async () => {
    await setUiLocale("en-US");
    const opened: unknown[] = [];
    const render = component("components/canvas/canvas-agent-chat-ui.tsx", "AgentMessageAttachments", { useState: () => [null, (image: unknown) => opened.push(image)] });
    const attachment = { id: "attachment-2", name: "我的图2.png", url: "data:image/png;base64,AQID" };
    const image = { id: "catalog-image-2", label: "图2", name: attachment.name, dataUrl: attachment.url };
    const selected: unknown[][] = [];
    const tree = elements(render({ messageId: "message", attachments: [attachment], theme: canvasThemes.light,
        imageControls: new Map([["message:attachment-2", { image }]]), onImageAction: (...args: unknown[]) => selected.push(args) }));
    const button = tree.find(node => node.type === "button")!;
    expect(button.props["aria-label"]).toBe("View full image · Image 2");
    expect(tree.find(node => node.type === "preview")!.props.alt).toBe(attachment.name);
    button.props.onClick();
    expect(opened).toEqual([image]); expect(selected).toEqual([]);
    tree.find(node => node.type === "image-actions")!.props.onAction("edit", image.id);
    expect(selected).toEqual([["edit", image.id]]);
    expect(image.label).toBe("图2");
});

test("canvas reference chips localize preview labels without selecting an editing target or changing user titles", async () => {
    await setUiLocale("en-US");
    const render = component("components/canvas/canvas-assistant-panel.tsx", "AssistantReferenceChip");
    const item = { id: "saved-reference", title: "图4", dataUrl: "data:image/png;base64,AQID" };
    const opened: string[] = [], selected: string[] = [];
    for (const [label, display] of [["图4", "Image 4"], ["原图4", "Original 4"], ["Image 4", "Image 4"], [undefined, "图4"]]) {
        const tree = elements(render({ item, label, onPreview: () => opened.push(display!), onSelect: () => selected.push(display!) }));
        const button = tree.find(node => node.type === "button")!;
        expect(button.props["aria-label"]).toBe(`View full image · ${display}`);
        expect(button.props["aria-haspopup"]).toBe("dialog");
        button.props.onClick();
        if (label) expect(tree.some(node => node.type === "span" && node.props.children === display)).toBe(true);
        expect(tree.find(node => node.type === "preview")!.props.alt).toBe(item.title);
    }
    expect(opened).toEqual(["Image 4", "Original 4", "Image 4", "图4"]);
    expect(selected).toEqual([]);
    expect(item.title).toBe("图4");
});

test("historical reference preview keeps canonical identity and the stored original including a recovered node key", () => {
    for (const source of [
        { dataUrl: "data:image/png;base64,THUMBNAIL", storageKey: "image:original", expectedKey: "image:original" },
        { dataUrl: "blob:expired-reference", storageKey: undefined, expectedKey: "image:recovered-original" },
    ]) {
        const reference = { id: "source-node", type: CanvasNodeType.Image, title: "原款.png", dataUrl: source.dataUrl, storageKey: source.storageKey };
        const message: CanvasAssistantMessage = { id: "historical-message", role: "user", text: "只讨论", references: [reference] };
        const nodes = [{ id: reference.id, type: CanvasNodeType.Image, metadata: { storageKey: "image:recovered-original" } }];
        const images = canvasConversationImages([message]);
        const before = structuredClone({ message, nodes, images });
        let preview: unknown = null;
        const render = component("components/canvas/canvas-assistant-panel.tsx", "MessageReferences", {
            CanvasNodeType, canvasConversationImageForAsset, AssistantReferenceChip: "reference-chip",
            useState: () => [preview, (next: unknown) => { preview = next; }],
        });
        const props = { message, nodes, images, disabled: true };
        const chip = elements(render(props)).find(node => node.type === "reference-chip")!;
        expect(chip.props.item.storageKey).toBe(source.expectedKey);
        expect(chip.props.disabled).toBe(false);
        expect(chip.props.onSelect).toBeUndefined();
        chip.props.onPreview();
        const opened = elements(render(props)).find(node => node.type === "full-image-preview")!;
        expect(opened.props.image).toEqual({ id: images[0]!.id, label: "图1", name: reference.title,
            dataUrl: source.dataUrl, storageKey: source.expectedKey, unavailableReason: undefined });
        expect(opened.key).toBe(images[0]!.id);
        opened.props.onClose();
        expect(elements(render(props)).some(node => node.type === "full-image-preview")).toBe(false);
        expect({ message, nodes, images }).toEqual(before);
    }
});

test("historical preview remount key includes session and project changes for the same employee", () => {
    const path = "components/canvas/canvas-assistant-panel.tsx";
    const scopeFor = (project: string, session: string) => evaluate(path, ast => {
        const declaration = findNode(ast, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === "attachmentScope");
        return declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
    }, { onlineProjectId: project, attachmentOwner: "authenticated:employee-a", activeSession: { id: session } });
    const referenceKey = (attachmentScope: string) => (evaluate(path, ast => findNode(ast, node =>
        ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "MessageReferences"), {
        React, MessageReferences: "message-references", attachmentScope, message: {}, messageReferenceNodes: [], conversationImages: [],
    }) as ReactElement).key;
    const oldScope = scopeFor("project-a", "session-a");
    expect(referenceKey(oldScope)).toBe(oldScope);
    for (const nextScope of [scopeFor("project-a", "session-b"), scopeFor("project-b", "session-a")]) {
        expect(referenceKey(nextScope)).toBe(nextScope);
        expect(referenceKey(nextScope)).not.toBe(referenceKey(oldScope));
    }
    // The memo must recompute the actual keyed JSX when this scope changes.
    const source = readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declaration = findNode(ast, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === "messageItems") as ts.VariableDeclaration;
    const dependencies = (declaration.initializer as ts.CallExpression).arguments[1] as ts.ArrayLiteralExpression;
    expect(dependencies.elements.map(node => node.getText(ast))).toContain("attachmentScope");
});

test("online canvas conversation-only images retain labels preview download and region tools without base selectors", () => {
    const render = component("components/canvas/canvas-agent-chat-ui.tsx", "AgentMessageAttachments");
    const image = { id: "catalog-image-2", label: "图2", name: "结果", dataUrl: "data:image/png;base64,AQID" };
    const actions: unknown[][] = [], masks: string[] = [];
    const tree = elements(render({ messageId: "message", attachments: [{ id: "attachment", name: "结果", url: image.dataUrl }], theme: canvasThemes.light,
        imageControls: new Map([["message:attachment", { image, version: 3 }]]), activeImageId: image.id, conversationOnlyImages: true,
        onImageAction: (...args: unknown[]) => actions.push(args), onMaskImage: (id: string) => masks.push(id) }));
    expect(tree.some(node => node.type === "image-actions")).toBe(false);
    expect(tree.some(node => node.props["data-testid"] === "canvas-agent-image-current")).toBe(false);
    expect(tree.some(node => node.type === "button" && node.props["aria-label"] === "查看大图 · 图2")).toBe(true);
    tree.find(node => node.type === "button" && node.props.children === "下载")!.props.onClick();
    const copy = tree.find(node => node.type === "button" && node.props.children === "复制图片");
    expect(copy).toBeDefined();
    copy!.props.onClick();
    tree.find(node => node.type === "button" && node.props.children === "圈选修改")!.props.onClick();
    expect(actions).toEqual([["download", image.id], ["copy", image.id]]); expect(masks).toEqual([image.id]);
});

test("composer without a mention handler disables the picker without blocking ordinary Enter", () => {
    const options: { disabled: boolean }[] = [], sent: string[] = [];
    const render = component("components/canvas/canvas-agent-chat-ui.tsx", "AgentChatComposer", {
        App: { useApp: () => ({ message: { error() {} } }) },
        useRef: () => ({ current: null }), useLayoutEffect() {}, Button: "button", Tooltip: "tooltip", ArrowUp: "icon",
        useImageMentions: (current: { disabled: boolean }) => {
            options.push(current);
            return { menu: current.disabled ? null : "picker", inputProps: { "aria-autocomplete": "list" },
                handleChange() {}, handleSelect() {}, handleKeyDown: () => !current.disabled };
        },
    });
    const props = { prompt: "比较 @图1", placeholder: "对话", theme: canvasThemes.light, onPromptChange() {}, onSubmit: () => sent.push("sent") };
    const ordinary = elements(render(props)), textarea = ordinary.find(node => node.type === "textarea")!;
    expect(options.at(-1)?.disabled).toBe(true);
    expect(textarea.props["aria-autocomplete"]).toBeUndefined();
    textarea.props.onKeyDown({ key: "Enter", nativeEvent: {}, preventDefault() {} });
    expect(sent).toEqual(["sent"]);
    const withMentions = elements(render({ ...props, onMentionImage() {} }));
    expect(options.at(-1)?.disabled).toBe(false);
    expect(withMentions.find(node => node.type === "textarea")!.props["aria-autocomplete"]).toBe("list");
});
