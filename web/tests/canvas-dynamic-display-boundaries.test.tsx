import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as React from "react";
import ts from "typescript";
import { canvasThemes } from "@/lib/canvas-theme";
import { i18nHarness } from "./helpers/i18n-harness";

function elements(value: unknown): React.ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!React.isValidElement(value)) return [];
    const element = value as React.ReactElement<any>;
    return [element, ...elements(element.props.children), ...elements(element.props.footer)];
}
function componentHarness(path: string) {
    const source = new URL(path, import.meta.url), nativeRequire = createRequire(source);
    const state: unknown[] = [], copies: string[] = [], translations: string[] = [];
    let cursor = 0;
    const react = { ...React,
        useState(initial: unknown) { const index = cursor++; if (!(index in state)) state[index] = typeof initial === "function" ? (initial as Function)() : initial; return [state[index], (value: unknown) => { state[index] = typeof value === "function" ? (value as Function)(state[index]) : value; }]; },
        useRef: (value: unknown) => ({ current: value }), useEffect() {}, useMemo: (fn: Function) => fn(),
    };
    const dependencies: Record<string, unknown> = {
        react,
        "@/lib/i18n": i18nHarness,
        "@/hooks/use-copy-text": { useCopyText: () => (text: string) => copies.push(text) },
        "@/hooks/use-display-text": { DisplayText: "display-text", DisplayTranslationScope: "display-scope", useDisplayText: () => (text: string) => { translations.push(text); return `English:${text}`; } },
        antd: { Button: "button", Tooltip: "tooltip", Modal: "modal" },
        "lucide-react": { Copy: "copy-icon", GitBranch: "branch-icon", RotateCcw: "rotate-icon" },
        "react-router-dom": { useNavigate: () => () => {}, Link: "link" },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: Function) => select({ models: [] }) },
        "@/stores/use-user-store": { useUserStore: (select: Function) => select({ user: { role: "designer" } }) },
        "@/stores/use-theme-store": { useThemeStore: (select: Function) => select({ theme: "light" }) },
        "@/stores/canvas/use-canvas-ui-store": { useCanvasUiStore: { getState: () => ({ setDeleteProjectIds() {} }) } },
        "@/stores/canvas/use-canvas-store": { loadCanvasProject: async () => null },
        "./canvas-persisted-media-preview": { CanvasPersistedMediaPreview: "media-preview" },
        "@/components/canvas/canvas-persisted-media-preview": { CanvasPersistedMediaPreview: "media-preview" },
    };
    const compiled = ts.transpileModule(readFileSync(source, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const module = { exports: {} as Record<string, Function> };
    new Function("require", "module", "exports", compiled)((name: string) => dependencies[name] ?? nativeRequire(name), module, module.exports);
    return { copies, translations, state, render(name: string, props: unknown) { cursor = 0; translations.length = 0; return elements(module.exports[name](props)); } };
}

test("generation display gates hidden archives and derivatives while copy and locate retain original values", () => {
    const harness = componentHarness("../src/components/canvas/canvas-generation-record-details.tsx");
    const record = { version: 1, prompt: "原始要求", inputPrompt: "原始输入", submittedPrompt: "隐藏实际发送原文", parameters: { model: "gpt-image-2" }, references: [] };
    const node = { id: "original", metadata: { generationRecord: record } };
    const derivative = { id: "child-id", title: "衍生原始名称", metadata: { prompt: "隐藏衍生要求" } };
    const original = JSON.stringify({ node, derivative }), located: string[] = [];
    const props = { node, draftPrompt: "原始输入", derivatives: [derivative], onLocate: (id: string) => located.push(id) };
    let tree = harness.render("CanvasGenerationRecordDetails", props);
    expect(tree.filter(item => item.type === "display-scope").map(item => item.props.visible)).toEqual([false, false]);
    expect(harness.translations).not.toContain(derivative.title);
    tree.find(item => item.props["aria-label"] === "复制生成时提示词")!.props.onClick();
    tree.find(item => item.props["aria-label"] === "复制实际发送提示词")!.props.onClick();
    expect(harness.copies).toEqual([record.prompt, record.submittedPrompt]);
    for (const detail of tree.filter(item => item.type === "details")) detail.props.onToggle({ currentTarget: { open: true } });
    tree = harness.render("CanvasGenerationRecordDetails", props);
    expect(tree.filter(item => item.type === "display-scope").every(item => item.props.visible)).toBe(true);
    const locate = tree.find(item => item.props["aria-label"] === "定位衍生图：English:衍生原始名称")!;
    locate.props.onClick(); expect(located).toEqual([derivative.id]);
    expect(JSON.stringify({ node, derivative })).toBe(original);
});

test("conflict display translation leaves both versions and original media unchanged", async () => {
    const harness = componentHarness("../src/components/canvas/canvas-conflict-compare-dialog.tsx");
    const image = { id: "original-image", type: "image", title: "原图标题", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "/api/assets/private-id/content" } };
    const text = { id: "original-text", type: "text", title: "原始节点标题", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "原始内容" } };
    const original = { id: "original-project", title: "原始画布", nodes: [image, text], connections: [], chatSessions: [], updatedAt: "2026-11-13T00:00:00Z" };
    const copy = { ...original, id: "conflict-copy", title: "冲突画布", nodes: [image, { ...text, metadata: { content: "副本内容" } }] };
    const before = JSON.stringify({ original, copy }); let kept = 0, closed = 0;
    const tree = harness.render("CanvasConflictCompareDialog", { original, copy, onKeep: async () => { kept++; }, onClose: () => { closed++; } });
    const displaySources = tree.filter(item => item.type === "display-text").map(item => item.props.text);
    for (const text of [original.title, copy.title, "原始节点标题", "原始内容", "副本内容"]) expect(displaySources).toContain(text);
    expect(tree.filter(item => item.type === "media-preview").map(item => item.props.url)).toEqual([image.metadata.content, image.metadata.content]);
    expect(kept).toBe(0); expect(closed).toBe(0);
    tree.find(item => item.type === "button" && item.props.type === "primary")!.props.onClick();
    await Promise.resolve(); expect(kept).toBe(1); expect(closed).toBe(1);
    expect(JSON.stringify({ original, copy })).toBe(before);
});

test("recovery and readonly errors are display-only and backup keeps the existing recovery action", async () => {
    const harness = componentHarness("../src/pages/canvas/canvas-editor-session-views.tsx");
    const calls: boolean[] = []; let backups = 0;
    const lock = { status: "readonly", error: "原始编辑权错误", requestEditing() {} };
    const readonly = harness.render("CanvasReadonlySession", { projectId: "original-id", lock });
    expect(readonly.some(item => item.type === "display-text" && item.props.text === lock.error)).toBe(true);
    const props = { lock, transferring: false, recoveryRef: { current: { backup: async () => { backups++; } } }, onBackedUp: (request: boolean) => calls.push(request) };
    const overlay = harness.render("CanvasRecoveryOverlay", props);
    expect(overlay.some(item => item.type === "display-text" && item.props.text === lock.error)).toBe(true);
    overlay.filter(item => item.type === "button")[1].props.onClick();
    await Promise.resolve(); expect(backups).toBe(1); expect(calls).toEqual([true]);
    expect(lock.error).toBe("原始编辑权错误");
});

test("assistant history translates labels but double-click rename keeps the original title", () => {
    const source = readFileSync(new URL("../src/components/canvas/canvas-assistant-panel.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("assistant.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declaration = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === "AssistantHistory")!;
    const state: any[] = []; let cursor = 0; const renames: unknown[] = [];
    const bindings = { React, ...i18nHarness, canvasThemes, useThemeStore: (select: Function) => select({ theme: "light" }),
        useState(initial: unknown) { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], (next: unknown) => { state[index] = next; }]; },
        DisplayText: "display-text", Input: "input", Tooltip: "tooltip", Button: "button", Trash2: "trash-icon",
        sessionPreview: (session: any) => session.messages[0].text, formatSessionTime: () => "fixed-time",
    };
    const compiled = ts.transpileModule(`${declaration.getText(ast)}\nexports.History = AssistantHistory;`, { compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React } }).outputText;
    const exports = {} as { History: (props: any) => unknown };
    new Function(...Object.keys(bindings), "exports", compiled)(...Object.values(bindings), exports);
    const session = { id: "original-session", title: "原始会话名", messages: [{ text: "原始会话预览" }] }, original = JSON.stringify(session);
    const props = { sessions: [session], activeSession: session, onRename: (...args: unknown[]) => renames.push(args) };
    const render = () => { cursor = 0; return elements(exports.History(props)); };
    let tree = render();
    expect(tree.filter(item => item.type === "display-text").map(item => item.props.text)).toEqual([session.title, session.messages[0].text]);
    tree.find(item => item.props.onDoubleClick)!.props.onDoubleClick(); tree = render();
    const input = tree.find(item => item.type === "input" && item.props.autoFocus)!;
    expect(input.props.value).toBe(session.title); input.props.onBlur();
    expect(renames).toEqual([[session.id, session.title]]); expect(JSON.stringify(session)).toBe(original);
});
