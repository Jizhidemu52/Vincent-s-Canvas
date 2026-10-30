import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type DependencyList, type EffectCallback, type ReactElement } from "react";
import ts from "typescript";
import * as droppedImages from "@/lib/dropped-images";
import { createImageReferenceItem } from "@/lib/image-reference-policy";
import { CANVAS_IMAGE_MAX_BYTES } from "@/lib/canvas/canvas-image-upload-limit";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import type { ImageReferenceItem } from "@/types/image";
import { i18nHarness } from "./helpers/i18n-harness";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const image = (name = "original.png") => new File([png], name, { type: "image/png" });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement<any>(node)) return [];
    return [node, ...elements(node.props.children)];
}

// Execute the real component, shared drop hook and byte parser, replacing only UI hooks
// and the persistence boundary. No browser, storage, server or generation request is used.
function harness(options: { readGate?: Promise<void>; uploadGate?: Promise<void> } = {}) {
    const values: any[] = [], effects: Array<{ deps?: DependencyList; cleanup?: ReturnType<EffectCallback> }> = [];
    let cursor = 0, pending: Array<() => void> = [], mounted = true, project = "project-a";
    let account = { status: "authenticated", user: { id: "designer-a" } };
    let node: CanvasNodeData = { id: "config-a", type: CanvasNodeType.Config, title: "配置", position: { x: 0, y: 0 }, width: 360, height: 420, metadata: {} };
    let references: ImageReferenceItem[] = [], disabled = false;
    const uploads: File[] = [], changes: Array<{ nodeId: string; patch: Partial<CanvasNodeMetadata> }> = [], messages: string[] = [];
    const equal = (a?: DependencyList, b?: DependencyList) => Boolean(a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index])));
    const useState = (initial: any) => {
        const index = cursor++;
        if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
        return [values[index], (next: any) => { if (mounted) values[index] = typeof next === "function" ? next(values[index]) : next; }];
    };
    const useEffect = (effect: EffectCallback, deps?: DependencyList) => {
        const index = cursor++;
        if (!effects[index] || !equal(effects[index].deps, deps)) pending.push(() => {
            effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: effect() };
        });
    };
    const fakeReact = { ...React, useState, useEffect, useLayoutEffect: useEffect,
        useMemo: (factory: () => unknown, deps?: DependencyList) => {
            const index = cursor++, previous = values[index];
            if (!previous || !equal(previous.deps, deps)) values[index] = { deps, value: factory() };
            return values[index].value;
        },
        useRef: (current: unknown) => { const index = cursor++; return values[index] ||= { current }; },
    };
    const dependencies: Record<string, any> = {
        react: fakeReact,
        antd: { App: { useApp: () => ({ message: { error: (value: string) => messages.push(value), warning: (value: string) => messages.push(value), info: (value: string) => messages.push(value) } }) } },
        "@/lib/i18n": i18nHarness,
        "react-router-dom": { useParams: () => ({ id: project }) },
        "@/stores/use-theme-store": { useThemeStore: (select: Function) => select({ theme: "light" }) },
        "@/stores/use-user-store": { useUserStore: Object.assign((select: Function) => select(account), { getState: () => account }) },
        "@/services/image-storage": { uploadImage: async (file: File) => {
            uploads.push(file); await options.uploadGate;
            return { mimeType: file.type, url: `blob:${file.name}`, storageKey: `image:${file.name}`, bytes: file.size };
        } },
        "@/lib/dropped-images": { ...droppedImages, readImageDrop: async (...args: Parameters<typeof droppedImages.readImageDrop>) => {
            await options.readGate; return droppedImages.readImageDrop(...args);
        } },
    };
    const load = (path: string) => {
        const url = new URL(path, import.meta.url), requireModule = createRequire(url);
        const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
        const module = { exports: {} as any };
        new Function("require", "module", "exports", code)((id: string) => dependencies[id] || requireModule(id), module, module.exports);
        return module.exports;
    };
    dependencies["@/hooks/use-image-drop"] = load("../src/hooks/use-image-drop.ts");
    const Component = load("../src/components/canvas/canvas-config-image-references.tsx").CanvasConfigImageReferences;
    const render = () => {
        cursor = 0;
        const root = Component({ node, references, disabled, onChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => changes.push({ nodeId, patch }) }) as ReactElement<any>;
        for (const effect of pending.splice(0)) effect();
        return root;
    };
    const flush = async () => { for (let i = 0; i < 12; i++) { await Promise.resolve(); if (mounted) render(); } };
    return {
        render, flush, uploads, changes, messages,
        async drop(files: File[]) {
            const root = render();
            expect(typeof root.props.onDrop).toBe("function");
            let prevented = false, stopped = false;
            const event = { dataTransfer: { files, items: [], types: ["Files"], getData: () => "" }, preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } };
            await root.props.onDrop(event);
            return { prevented, stopped };
        },
        select(files: File[]) {
            const input = elements(render()).find(element => element.type === "input")!;
            const target = { files, value: "selected" };
            input.props.onChange({ target });
            expect(target.value).toBe("");
        },
        setProject(value: string) { project = value; render(); },
        setNode(value: string) { node = { ...node, id: value }; render(); },
        setAccount(value: string, rerender = true) { account = { ...account, user: { id: value } }; if (rerender) render(); },
        setDisabled(value: boolean) { disabled = value; render(); },
        setReferences(value: ImageReferenceItem[]) { references = value; render(); },
        unmount() { mounted = false; for (const effect of effects) effect?.cleanup?.(); },
    };
}

test("config reference drop stops main-canvas propagation and saves unchanged bytes as manual references", async () => {
    const h = harness(), file = image();
    expect(await h.drop([file])).toEqual({ prevented: true, stopped: true });
    expect(h.uploads).toEqual([file]); expect(h.uploads[0]).toBe(file);
    expect(new Uint8Array(await h.uploads[0]!.arrayBuffer())).toEqual(png);
    expect(h.changes).toHaveLength(1);
    expect(h.changes[0]).toMatchObject({ nodeId: "config-a", patch: { manualImageReferences: [{ name: "original.png", storageKey: "image:original.png", origin: "upload" }] } });
    h.unmount();
});

test.each(["project", "node", "account", "unmount"])("late config reference reads cannot upload after changing %s scope", async kind => {
    const gate = deferred(), h = harness({ readGate: gate.promise });
    const pending = h.drop([image()]); await h.flush();
    if (kind === "project") h.setProject("project-b");
    if (kind === "node") h.setNode("config-b");
    if (kind === "account") h.setAccount("designer-b");
    if (kind === "unmount") h.unmount();
    gate.resolve(); await pending;
    expect(h.uploads).toEqual([]); expect(h.changes).toEqual([]);
    h.unmount();
});

test.each(["project", "node", "account", "unmount"])("late config reference uploads cannot patch after changing %s scope", async kind => {
    const gate = deferred(), h = harness({ uploadGate: gate.promise });
    h.select([image()]); await h.flush(); expect(h.uploads).toHaveLength(1);
    if (kind === "project") h.setProject("project-b");
    if (kind === "node") { h.setNode("config-b"); h.setNode("config-a"); }
    if (kind === "account") h.setAccount("designer-b", false);
    if (kind === "unmount") h.unmount();
    gate.resolve(); await h.flush();
    expect(h.changes).toEqual([]); expect(h.messages).toEqual([]);
    h.unmount();
});

test("upload completion merges the latest references only within its unchanged scope", async () => {
    const gate = deferred(), h = harness({ uploadGate: gate.promise });
    h.select([image()]); await h.flush();
    h.setReferences([createImageReferenceItem({ id: "newer", name: "newer.png", type: "image/png", dataUrl: "", storageKey: "image:newer" }, "upload")]);
    gate.resolve(); await h.flush();
    expect(h.changes[0]?.patch.manualImageReferences?.map(item => item.name)).toEqual(["newer.png", "original.png"]);
    h.unmount();
});

test("a node becoming disabled discards its pending upload and clears its busy state", async () => {
    const gate = deferred(), h = harness({ uploadGate: gate.promise });
    h.select([image()]); await h.flush(); h.setDisabled(true);
    gate.resolve(); await h.flush(); h.setDisabled(false);
    expect(h.changes).toEqual([]);
    expect(elements(h.render()).find(element => element.type === "input")!.props.disabled).toBe(false);
    h.unmount();
});

test("disabled or oversized config reference drops do not call persistence", async () => {
    const h = harness(); h.setDisabled(true);
    expect(await h.drop([image()])).toEqual({ prevented: true, stopped: true });
    h.setDisabled(false);
    const large = image("large.png"); Object.defineProperty(large, "size", { value: CANVAS_IMAGE_MAX_BYTES + 1 });
    await h.drop([image(), large]);
    expect(h.uploads).toEqual([]); expect(h.changes).toEqual([]);
    expect(h.messages.length).toBeGreaterThan(0);
    h.unmount();
});
