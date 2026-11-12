import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React, { type ReactElement } from "react";
import ts from "typescript";
import { canvasThemes } from "@/lib/canvas-theme";
import { i18nHarness } from "./helpers/i18n-harness";

function elements(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

// Evaluate the real message renderer and shared feedback hook with isolated
// hook storage and timers; no global React, clipboard or clock mock leaks.
function harness(copySucceeds = true) {
    const values: any[] = [], effects = new Map<number, () => void>();
    const timers = new Map<number, { callback: () => void; duration: number }>();
    const copiedValues: string[] = [], options: unknown[] = [];
    let cursor = 0, nextTimer = 0;
    const react = {
        useState(initial: unknown) {
            const index = cursor++;
            if (!(index in values)) values[index] = initial;
            return [values[index], (value: unknown) => { values[index] = value; }];
        },
        useRef(initial: unknown) { const index = cursor++; return values[index] ||= { current: initial }; },
        useEffect(effect: () => () => void) { const index = cursor++; if (!effects.has(index)) effects.set(index, effect()); },
    };
    const hookSource = readFileSync(new URL("../src/hooks/use-copy-feedback.ts", import.meta.url), "utf8");
    const hookCode = ts.transpileModule(hookSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
    const hook = { exports: {} as { useCopyFeedback: () => unknown } };
    new Function("require", "module", "exports", "setTimeout", "clearTimeout", hookCode)(
        (name: string) => name === "react" ? react : { useCopyText: (option: unknown) => { options.push(option); return async (value: string) => { copiedValues.push(value); return copySucceeds; }; } },
        hook, hook.exports,
        (callback: () => void, duration: number) => { const id = ++nextTimer; timers.set(id, { callback, duration }); return id; },
        (id: number) => timers.delete(id),
    );
    const source = readFileSync(new URL("../src/components/canvas/canvas-agent-chat-ui.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("message.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let declaration: ts.VariableDeclaration | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "AgentChatMessage") declaration = node;
        ts.forEachChild(node, visit);
    };
    visit(ast);
    const renderer = (declaration!.initializer as ts.CallExpression).arguments[0]!;
    const code = ts.transpileModule(`return (${renderer.getText(ast)});`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ESNext } }).outputText;
    const bindings = { React, useUiText: i18nHarness.useUiText, useCopyFeedback: hook.exports.useCopyFeedback, ChatMarkdown: "markdown", Copy: "copy-icon", CheckCircle2: "check-icon", Pencil: "edit-icon", AgentUserAvatar: "avatar", maskImageModelText: (text: string) => text };
    const renderMessage = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
    const item = { id: "message", role: "assistant", text: "复制完整消息，保留原文。" };
    const render = () => { cursor = 0; return elements(renderMessage({ item, user: null, theme: canvasThemes.light })); };
    const button = () => render().find(element => element.type === "button" && element.props["aria-label"] === "复制消息")!;
    const label = () => elements(button()).find(element => element.props["aria-live"] === "polite")!.props.children;
    return { item, button, label, timers, copiedValues, options, dispose: () => effects.forEach(cleanup => cleanup()) };
}

test("canvas message copies exact text with a stable action name and inline 1200ms receipt", async () => {
    const h = harness();
    expect(h.label()).toBe("复制");
    const original = JSON.stringify(h.item);
    h.button().props.onClick();
    await Promise.resolve();
    expect(h.copiedValues).toEqual([h.item.text]);
    expect(h.label()).toBe("已复制");
    expect(h.button().props["aria-label"]).toBe("复制消息");
    expect(elements(h.button()).some(element => element.type === "check-icon")).toBe(true);
    expect(h.options.every(option => (option as { notifySuccess: boolean }).notifySuccess === false)).toBe(true);
    const [timer] = [...h.timers.values()];
    expect(timer!.duration).toBe(1200);
    timer!.callback();
    expect(h.label()).toBe("复制");
    expect(JSON.stringify(h.item)).toBe(original);
    h.dispose();
    expect(h.timers.size).toBe(0);
});

test("failed clipboard writes never claim success or schedule a success receipt", async () => {
    const h = harness(false);
    h.button().props.onClick();
    await Promise.resolve();
    expect(h.label()).toBe("复制");
    expect(h.button().props["aria-label"]).toBe("复制消息");
    expect(h.timers.size).toBe(0);
    h.dispose();
});
