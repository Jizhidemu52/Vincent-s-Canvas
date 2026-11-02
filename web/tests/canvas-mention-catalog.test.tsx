import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import ts from "typescript";
import type { ConversationImageItem } from "@/components/conversation-image-controls";

function harness() {
    const refs: any[] = [];
    let cursor = 0, cleanup: (() => void) | undefined;
    let account = { status: "authenticated", user: { id: "owner-a" } };
    const path = new URL("../src/components/canvas/canvas-mention-images.tsx", import.meta.url);
    const requireModule = createRequire(path), module = { exports: {} as any };
    const react = { ...React, useRef: (value: unknown) => refs[cursor++] ||= { current: value }, useLayoutEffect: (effect: () => () => void) => { if (!cleanup) cleanup = effect(); } };
    const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    new Function("require", "module", "exports", code)((id: string) => id === "react" ? react : id === "@/stores/use-user-store" ? {
        useUserStore: Object.assign((select: Function) => select(account), { getState: () => account }),
    } : requireModule(id), module, module.exports);
    return {
        render(images: ConversationImageItem[], scopeKey: string) {
            cursor = 0;
            return module.exports.CanvasMentionImagesProvider({ images, scopeKey, children: null }).props.value as { images: ConversationImageItem[]; isCurrent: (image: ConversationImageItem) => boolean };
        },
        account(id: string) { account = { ...account, user: { id } }; },
        unmount() { cleanup?.(); },
    };
}

const picture: ConversationImageItem = { id: "conversation:picture", label: "图5", name: "会话A图片", storageKey: "image:owner-a", source: "conversation" };

test("catalog remains stable for graph movement but rejects old session and project selections", () => {
    const h = harness();
    const first = h.render([picture], "project-a:session-a");
    expect(first.isCurrent(picture)).toBe(true);
    expect(h.render([{ ...picture }], "project-a:session-a")).toBe(first);
    const second = h.render([{ ...picture, name: "会话B图片", storageKey: "image:session-b" }], "project-a:session-b");
    expect(first.isCurrent(picture)).toBe(false);
    expect(second.isCurrent(picture)).toBe(false);
    expect(second.isCurrent(second.images[0]!)).toBe(true);
    h.render([], "project-b:session-b");
    expect(second.isCurrent(second.images[0]!)).toBe(false);
});

test("account changes invalidate stale callbacks even before React rerenders", () => {
    const h = harness(), catalog = h.render([picture], "project-a:session-a");
    h.account("owner-b");
    expect(catalog.isCurrent(picture)).toBe(false);
    const next = h.render([], "project-b:session-b");
    expect(next.images).toHaveLength(0);
    expect(next.isCurrent(picture)).toBe(false);
});

test("removed, unavailable and unmounted catalog images cannot be imported", () => {
    const h = harness(), first = h.render([picture], "project-a:session-a");
    const unavailable = h.render([{ ...picture, unavailableReason: "已删除" }], "project-a:session-a");
    expect(first.isCurrent(picture)).toBe(false);
    expect(unavailable.isCurrent(picture)).toBe(false);
    const restored = h.render([picture], "project-a:session-a");
    h.unmount();
    expect(restored.isCurrent(picture)).toBe(false);
});
