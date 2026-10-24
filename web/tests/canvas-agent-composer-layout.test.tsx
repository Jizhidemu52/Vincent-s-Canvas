import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ComponentProps, type ReactElement } from "react";
import ts from "typescript";
import type { AgentChatComposer } from "@/components/canvas/canvas-agent-chat-ui";
import { canvasThemes } from "@/lib/canvas-theme";

type Props = ComponentProps<typeof AgentChatComposer>;

function elements(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

// Execute the real composer with local ref storage. These are component-tree
// and handler contracts, not browser measurements of responsive layout.
function composer(initial: Partial<Props> = {}) {
    const url = new URL("../src/components/canvas/canvas-agent-chat-ui.tsx", import.meta.url);
    const localRequire = createRequire(url);
    const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const refs: Array<{ current: unknown }> = [];
    let cursor = 0;
    const react = { ...React, useRef(value: unknown) { const index = cursor++; return refs[index] ||= { current: value }; } };
    const module = { exports: {} as { AgentChatComposer: (props: Props) => ReactElement<any> } };
    new Function("require", "module", "exports", code)((name: string) => name === "react" ? react : localRequire(name), module, module.exports);
    const changes: string[] = [];
    const uploads: Array<FileList | File[] | null> = [];
    const removed: string[] = [];
    let submissions = 0;
    const render = (patch: Partial<Props> = {}) => {
        cursor = 0;
        return elements(module.exports.AgentChatComposer({ prompt: "画一幅图", placeholder: "描述你的想法", theme: canvasThemes.light,
            onPromptChange: value => changes.push(value), onSubmit: () => { submissions++; },
            onAddFiles: files => { uploads.push(files); }, onRemoveAttachment: id => removed.push(id), ...initial, ...patch }));
    };
    return { render, changes, uploads, removed, submissions: () => submissions };
}

function byId(tree: ReactElement<any>[], id: string) {
    const found = tree.find(element => element.props["data-testid"] === id);
    expect(found).toBeDefined();
    return found!;
}

function control(tree: ReactElement<any>[], label: string) {
    const found = tree.find(element => element.props["aria-label"] === label);
    expect(found).toBeDefined();
    return found!;
}

const generationControls = <><div className="col-span-2 min-w-0">当前模型</div><div className="row-start-2 col-start-1 min-w-0">类型与设置</div></>;

test("generation controls share the footer grid while upload and send occupy its second row", () => {
    const tree = composer({ generationControls }).render();
    const footer = byId(tree, "canvas-agent-composer-controls");
    expect(footer.props.className.split(/\s+/)).toContain("grid");
    expect(footer.props.className).toContain("grid-cols-[minmax(0,1fr)_auto]");
    const slot = byId(tree, "canvas-agent-generation-slot");
    expect(slot.props.className).toBe("contents");
    expect(slot.props.children).toBe(generationControls);
    const actions = byId(tree, "canvas-agent-composer-actions");
    expect(actions.props.className).toContain("row-start-2");
    expect(actions.props.className).toContain("col-start-2");
    expect(elements(slot.props.children)).not.toContain(actions);
    const directChildren = [footer.props.children].flat();
    expect(directChildren).toContain(slot);
    expect(directChildren).toContain(actions);
});

test("local mode stays in one row and optional left controls are not lost beside generation controls", () => {
    const left = <button type="button">本机选项</button>;
    const panel = composer({ left });
    const localTree = panel.render();
    expect(localTree).toContain(left);
    expect(localTree.some(element => element.props["data-testid"] === "canvas-agent-generation-slot")).toBe(false);
    expect(byId(localTree, "canvas-agent-composer-actions").props.className).not.toContain("row-start-2");
    const localWrapper = localTree.find(element => element.type === "div" && element.props.children === left)!;
    expect(localWrapper.props.className).toContain("min-w-0");
    expect(localWrapper.props.className).not.toContain("col-span-2");

    const generatedTree = panel.render({ generationControls });
    const leftWrapper = generatedTree.find(element => element.type === "div" && element.props.children === left)!;
    expect(leftWrapper).toBeDefined();
    expect(leftWrapper.props.className).toContain("col-span-2");
    expect(elements(byId(generatedTree, "canvas-agent-generation-slot").props.children)).not.toContain(left);
    expect(generatedTree.filter(element => element === left)).toHaveLength(1);
});

test("both composer modes keep 44px upload and send controls outside the flexible generation slot", () => {
    const panel = composer();
    for (const generation of [undefined, generationControls]) {
        const tree = panel.render({ generationControls: generation });
        const actionTree = elements(byId(tree, "canvas-agent-composer-actions").props.children);
        for (const label of ["添加参考图", "发送"]) {
            const button = control(actionTree, label);
            for (const token of ["!h-11", "!w-11", "!min-w-11"]) expect(button.props.className.split(/\s+/)).toContain(token);
        }
    }
    const withoutUpload = panel.render({ onAddFiles: undefined });
    expect(withoutUpload.some(element => element.props["aria-label"] === "添加参考图")).toBe(false);
    expect(withoutUpload.some(element => element.type === "input" && element.props.type === "file")).toBe(false);
    expect(control(withoutUpload, "发送")).toBeDefined();
});

test("attachment removal and paste keep image-only uploads without swallowing ordinary text", () => {
    const attachment = { id: "reference", name: "reference.png", url: "blob:reference" };
    const panel = composer({ attachments: [attachment] });
    const tree = panel.render();
    expect(tree.find(element => element.type === "img")!.props).toMatchObject({ src: attachment.url, alt: attachment.name });
    control(tree, "移除图片").props.onClick();
    expect(panel.removed).toEqual(["reference"]);

    const image = new File(["image"], "reference.png", { type: "image/png" });
    const text = new File(["text"], "note.txt", { type: "text/plain" });
    const textarea = tree.find(element => element.type === "textarea")!;
    let prevented = 0;
    const paste = (files: File[]) => ({ clipboardData: { files }, preventDefault() { prevented++; } });
    textarea.props.onPaste(paste([text, image]));
    expect(panel.uploads).toEqual([[image]]);
    expect(prevented).toBe(1);
    textarea.props.onPaste(paste([text]));
    textarea.props.onPaste(paste([]));
    panel.render({ onAddFiles: undefined }).find(element => element.type === "textarea")!.props.onPaste(paste([image]));
    expect(panel.uploads).toEqual([[image]]);
    expect(prevented).toBe(1);
});

test("a unified reference tray replaces small attachment previews without duplicating images", () => {
    const tray = <section aria-label="排序参考图">large previews</section>;
    const tree = composer({ attachments: [{ id: "reference", name: "reference.png", url: "blob:reference" }], attachmentPreview: tray }).render();
    expect(tree).toContain(tray);
    expect(tree.filter(element => element.type === "img")).toHaveLength(0);
    expect(control(tree, "添加参考图")).toBeDefined();
});

test("upload invokes the hidden input and clears its value after forwarding the selected files", () => {
    const panel = composer({ generationControls });
    const tree = panel.render();
    const input = tree.find(element => element.type === "input" && element.props.type === "file")!;
    expect(input.props).toMatchObject({ hidden: true, accept: "image/*", multiple: true });
    let clicks = 0;
    input.props.ref.current = { click() { clicks++; } };
    control(tree, "添加参考图").props.onClick();
    expect(clicks).toBe(1);
    const files = [new File(["image"], "reference.png", { type: "image/png" })];
    const target = { files, value: "C:\\fakepath\\reference.png" };
    input.props.onChange({ target });
    expect(panel.uploads[0]).toBe(files);
    expect(target.value).toBe("");
    input.props.onChange({ target: { files: null, value: "" } });
    expect(panel.uploads).toEqual([files, null]);
});

test("prompt and submit callbacks remain intact with disabled and sending states on the action buttons", () => {
    const panel = composer();
    const tree = panel.render();
    const textarea = tree.find(element => element.type === "textarea")!;
    expect(textarea.props).toMatchObject({ value: "画一幅图", placeholder: "描述你的想法" });
    textarea.props.onChange({ target: { value: "新的提示词" } });
    expect(panel.changes).toEqual(["新的提示词"]);
    control(tree, "发送").props.onClick();
    let prevented = 0;
    const key = (patch: Record<string, unknown> = {}) => ({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, nativeEvent: { isComposing: false }, preventDefault() { prevented++; }, ...patch });
    textarea.props.onKeyDown(key());
    for (const patch of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { key: "a" }, { nativeEvent: { isComposing: true } }, { keyCode: 229 }]) textarea.props.onKeyDown(key(patch));
    expect(panel.submissions()).toBe(2);
    expect(prevented).toBe(1);

    const blank = { prompt: " \n\t ", attachments: [] };
    expect(control(panel.render(blank), "发送").props.disabled).toBe(true);
    expect(control(panel.render({ ...blank, attachments: [{ id: "reference", name: "reference.png", url: "blob:reference" }] }), "发送").props.disabled).toBe(false);
    expect(control(panel.render({ disabled: true }), "发送").props.disabled).toBe(true);
    const sending = panel.render({ sending: true });
    expect(control(sending, "发送").props.disabled).toBe(true);
    expect(control(sending, "发送").props.icon.props.className).toContain("animate-spin");
    expect(control(sending, "添加参考图").props.disabled).toBe(true);
    expect(control(tree, "发送").props.disabled).toBe(false);
    expect(control(tree, "添加参考图").props.disabled).not.toBe(true);
});

test("an active online request exposes a working stop control without enabling duplicate send", () => {
    let stopped = 0;
    const panel = composer();
    const tree = panel.render({ sending: true, onStop: () => stopped++ });
    control(tree, "停止本地回复和查询").props.onClick();
    expect(stopped).toBe(1);
    const textarea = tree.find(element => element.type === "textarea")!;
    textarea.props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault() {} });
    expect(panel.submissions()).toBe(0);
});
