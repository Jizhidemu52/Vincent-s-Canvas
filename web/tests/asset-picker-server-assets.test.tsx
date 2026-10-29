import { afterEach, describe, expect, test } from "bun:test";
import { i18nHarness } from "./helpers/i18n-harness";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type DependencyList, type EffectCallback, type ReactElement } from "react";
import ts from "typescript";
import { isSupportedServerAsset, serverAssetToLocal } from "@/lib/server-asset-local";
import type { ServerAsset } from "@/services/api/server-assets";
import type { Asset } from "@/stores/use-asset-store";

const pickerUrl = new URL("../src/components/canvas/asset-picker-modal.tsx", import.meta.url);
const requireModule = createRequire(pickerUrl);
const transpile = (source: string) => ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const pickerCode = transpile(readFileSync(pickerUrl, "utf8"));
const apiCode = transpile(readFileSync(new URL("../src/services/api/server-assets.ts", import.meta.url), "utf8"));
const assetSource = readFileSync(new URL("../src/stores/use-asset-store.ts", import.meta.url), "utf8");
const assetAst = ts.createSourceFile("asset-store.ts", assetSource, ts.ScriptTarget.Latest, true);
const permissionNames = new Set(["assetOwnerId", "canUserAccessAsset", "serverAssetIdFromAsset"]);
const permissionsCode = transpile(assetAst.statements.filter(statement => ts.isFunctionDeclaration(statement) && permissionNames.has(statement.name?.text || "")).map(statement => statement.getText(assetAst)).join("\n"));
const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

function serverAsset(id: string, ownerUserId = "employee-a", kind: ServerAsset["kind"] = "image"): ServerAsset {
    return {
        id, ownerUserId, ownerName: ownerUserId, departmentId: null, departmentName: null, projectId: null,
        projectName: null, taskId: null, filename: `${id}.png`, mimeType: "image/png", byteSize: 512,
        kind, source: "upload", operationType: null, prompt: null, modelName: null, status: "ready",
        visibilityScope: "private", metadata: { title: id, width: 1024, height: 1024 }, createdAt: "2026-10-16T00:00:00Z",
        resultStatus: "unused", usabilityScore: 0, downloadCount: 0, firstDownloadedAt: null, eventCount: 0,
    };
}

function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement(node)) return [];
    const element = node as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

// Execute the real component, API and access rules with per-instance hooks/fetch.
// No process-global module or fetch mocks can leak into unrelated regression tests.
function harness(localAssets: Asset[] = [], initialMode: "single" | "multiple-images" = "single", initiallyOpen = true, authenticationEnabled = true) {
    type Frame = { values: any[]; effects: Array<{ dependencies?: DependencyList; cleanup?: ReturnType<EffectCallback> }>; pending: Array<() => void>; cursor: number; mounted: boolean };
    const frame = (): Frame => ({ values: [], effects: [], pending: [], cursor: 0, mounted: true });
    let active = frame();
    let mountedKey: string | null | undefined;
    let mounted = false;
    let ownerId: string | null = "employee-a";
    let open = initiallyOpen;
    let selectionMode = initialMode;
    const inserted: any[] = [];
    const batches: any[][] = [];
    const requests: Array<{ path: string; init: RequestInit; succeed: (assets: ServerAsset[], nextCursor?: string | null) => void; fail: (message: string) => void }> = [];
    const userState = () => ({ user: ownerId ? { id: ownerId, role: "designer", departmentId: null } : null });
    const userStore = Object.assign((select: Function) => select(userState()), { getState: userState });
    const permissions: Record<string, any> = {};
    new Function("deploymentFeatures", "exports", permissionsCode)({ authenticationEnabled }, permissions);
    const apiModule = { exports: {} as Record<string, any> };
    new Function("require", "module", "exports", "fetch", apiCode)(
        () => ({ createClientId: () => "not-used" }), apiModule, apiModule.exports,
        (path: string, init: RequestInit) => new Promise<Response>((resolve) => {
            requests.push({ path, init,
                succeed: (assets, nextCursor) => resolve(Response.json({ assets, nextCursor })),
                fail: (message) => resolve(Response.json({ msg: message }, { status: 503 })),
            });
        }),
    );
    const equal = (a?: DependencyList, b?: DependencyList) => Boolean(a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index])));
    const cleanup = (owner: Frame) => { owner.mounted = false; owner.effects.forEach(effect => effect.cleanup?.()); };
    const useState = (initialValue: any) => {
        const owner = active;
        const index = owner.cursor++;
        if (!(index in owner.values)) owner.values[index] = typeof initialValue === "function" ? initialValue() : initialValue;
        return [owner.values[index], (next: any) => {
            if (owner.mounted) owner.values[index] = typeof next === "function" ? next(owner.values[index]) : next;
        }];
    };
    const useMemo = (factory: () => unknown, dependencies?: DependencyList) => {
        const index = active.cursor++;
        const previous = active.values[index];
        if (!previous || !equal(previous.dependencies, dependencies)) active.values[index] = { dependencies, value: factory() };
        return active.values[index].value;
    };
    const dependencies: Record<string, any> = {
        react: { ...React, useState, useMemo, useRef: (value: unknown) => useMemo(() => ({ current: value }), []), useDeferredValue: (value: unknown) => value,
            useEffect: (effect: EffectCallback, dependencies?: DependencyList) => {
                const owner = active;
                const index = owner.cursor++;
                if (!owner.effects[index] || !equal(owner.effects[index].dependencies, dependencies)) owner.pending.push(() => {
                    owner.effects[index]?.cleanup?.();
                    owner.effects[index] = { dependencies, cleanup: effect() };
                });
            },
        },
        antd: { Alert: "Alert", Button: "Button", Empty: "Empty", Input: "Input", Modal: "Modal", Pagination: "Pagination", Spin: "Spin", Tag: { CheckableTag: "CheckableTag" } },
        "lucide-react": { Search: "Search" },
        "@/lib/utils": { cn: (...values: unknown[]) => values.filter(Boolean).join(" ") },
        "@/lib/server-asset-local": { isSupportedServerAsset, serverAssetToLocal },
        "@/lib/canvas/canvas-asset-preview": {},
        "@/services/image-storage": {}, "@/services/file-storage": {},
        "@/services/api/server-assets": apiModule.exports,
        "@/stores/use-asset-store": { ...permissions, useAssetStore: (select: Function) => select({ assets: localAssets }) },
        "@/stores/use-user-store": { useUserStore: userStore },
    };
    const pickerModule = { exports: {} as { AssetPickerModal: (props: object) => ReactElement<any> } };
    new Function("require", "module", "exports", pickerCode)(
        (name: string) => name === "@/lib/i18n" ? i18nHarness : Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name), pickerModule, pickerModule.exports,
    );
    const render = () => {
        const modal = pickerModule.exports.AssetPickerModal({ open, selectionMode, onClose() {}, onInsert: (payload: unknown) => inserted.push(payload), onInsertMany: (payloads: any[]) => batches.push(payloads) });
        const child = modal.props.children as ReactElement<any>;
        if (mounted && child.key !== mountedKey) { cleanup(active); active = frame(); }
        mounted = true;
        mountedKey = child.key;
        active.cursor = 0;
        const result = (child.type as Function)(child.props);
        for (const effect of active.pending.splice(0)) effect();
        return result;
    };
    const nodes = () => elements(render());
    const cards = () => nodes().filter(node => typeof node.type === "function" && node.type.name === "PickerCard");
    const buttons = () => nodes().filter(node => node.type === "Button");
    disposers.push(() => cleanup(active));
    return {
        render, cards, nodes, inserted, batches, requests,
        assets: () => cards().map(card => card.props.asset as Asset),
        refresh: () => buttons().find(node => node.props.children === "刷新")!.props.onClick(),
        loadMore: () => buttons().find(node => node.props.children === "加载更多素材")!.props.onClick(),
        confirm: () => buttons().find(node => node.props.type === "primary")!.props,
        search: (keyword: string) => nodes().find(node => node.type === "Input")!.props.onChange({ target: { value: keyword } }),
        setOwner: (value: string | null) => { ownerId = value; },
        setOpen: (value: boolean) => { open = value; },
        setMode: (value: typeof selectionMode) => { selectionMode = value; },
        async settle() { for (let turn = 0; turn < 15; turn++) { render(); await Promise.resolve(); } return render(); },
    };
}

describe("shared asset picker server-backed materials", () => {
    test("empty browser cache loads formal assets and inserts the original durable image reference", async () => {
        const picker = harness();
        expect(elements(picker.render()).some(node => node.props.role === "status")).toBe(true);
        expect(picker.nodes().some(node => node.type === "Empty")).toBe(false);
        expect(picker.requests).toHaveLength(1);
        expect(picker.requests[0]).toMatchObject({ path: "/api/assets", init: { credentials: "include" } });
        const material = serverAsset("formal-image");
        material.metadata = { ...material.metadata, title: "前台复测素材", storageKey: "obsolete-browser-key", imageName: "原图", imageVersion: 2 };
        picker.requests[0]!.succeed([material]);
        await picker.settle();
        expect(picker.assets()).toMatchObject([{ id: "formal-image", title: "前台复测素材", data: { width: 1024, height: 1024, dataUrl: "/api/assets/formal-image/content" } }]);
        picker.cards()[0]!.props.onClick();
        expect(picker.inserted).toEqual([{ kind: "image", dataUrl: "/api/assets/formal-image/content", storageKey: undefined, title: "前台复测素材", mimeType: "image/png", imageName: "原图", imageVersion: 2 }]);
    });

    test("server assets supersede synced browser copies while owner-only local assets remain usable", async () => {
        const ownLocal = { ...serverAssetToLocal(serverAsset("own-local")), metadata: {} };
        const cached = { ...serverAssetToLocal(serverAsset("formal")), id: "browser-copy", title: "stale title" };
        const foreign = serverAssetToLocal(serverAsset("foreign-local", "employee-b"));
        const picker = harness([ownLocal, cached, foreign]);
        picker.render();
        picker.requests[0]!.succeed([serverAsset("formal"), serverAsset("foreign-server", "employee-b"), serverAsset("unsupported", "employee-a", "other")]);
        await picker.settle();
        expect(picker.assets().map(asset => asset.id)).toEqual(["formal", "own-local"]);
        expect(picker.assets().map(asset => asset.title)).not.toContain("stale title");
    });

    test("refresh and reopening fetch updated server state instead of freezing the first response", async () => {
        const picker = harness();
        picker.render(); picker.requests[0]!.succeed([serverAsset("first")]); await picker.settle();
        picker.refresh(); picker.render();
        expect(picker.requests).toHaveLength(2);
        expect(picker.requests[0]!.init.signal?.aborted).toBe(true);
        picker.requests[1]!.succeed([serverAsset("refreshed")]); await picker.settle();
        expect(picker.assets().map(asset => asset.id)).toEqual(["refreshed"]);
        picker.setOpen(false); picker.render();
        expect(picker.requests[1]!.init.signal?.aborted).toBe(true);
        picker.setOpen(true); picker.render();
        expect(picker.requests).toHaveLength(3);
        picker.requests[2]!.succeed([serverAsset("reopened")]); await picker.settle();
        expect(picker.assets().map(asset => asset.id)).toEqual(["reopened"]);
    });

    test("failed requests show their error and retry action, not an empty-library claim", async () => {
        const picker = harness();
        picker.render(); picker.requests[0]!.fail("素材服务暂不可用"); await picker.settle();
        const alert = picker.nodes().find(node => node.type === "Alert");
        expect(alert?.props.description).toBe("素材服务暂不可用");
        expect(picker.nodes().some(node => node.type === "Empty")).toBe(false);
        alert!.props.action.props.onClick(); picker.render();
        picker.requests[1]!.succeed([]); await picker.settle();
        expect(picker.nodes().some(node => node.type === "Alert")).toBe(false);
        expect(picker.nodes().some(node => node.type === "Empty")).toBe(true);
    });

    test("local-only trial assets remain visible and insertable when the server is unavailable", async () => {
        const ownLocal: Asset = {
            ...serverAssetToLocal(serverAsset("local-only")), metadata: {}, coverUrl: "data:image/png;base64,bG9jYWw=",
            kind: "image", data: { dataUrl: "data:image/png;base64,bG9jYWw=", storageKey: "local-image-key", width: 512, height: 512, bytes: 64, mimeType: "image/png" },
        };
        const picker = harness([ownLocal], "single", true, false);
        picker.render(); picker.requests[0]!.fail("本机服务未启动"); await picker.settle();
        expect(picker.nodes().find(node => node.type === "Alert")?.props.description).toBe("本机服务未启动");
        expect(picker.assets().map(asset => asset.id)).toEqual(["local-only"]);
        picker.cards()[0]!.props.onClick();
        expect(picker.inserted).toMatchObject([{ kind: "image", dataUrl: "data:image/png;base64,bG9jYWw=", storageKey: "local-image-key" }]);
        picker.setOwner(null); await picker.settle();
        expect(picker.assets()).toEqual([]);
        expect(picker.requests).toHaveLength(1);
    });

    test("switching accounts aborts old requests and ignores responses even when transport finishes late", async () => {
        const picker = harness();
        picker.render();
        picker.setOwner("employee-b"); picker.render();
        expect(picker.requests[0]!.init.signal?.aborted).toBe(true);
        picker.requests[1]!.succeed([serverAsset("b-private", "employee-b"), serverAsset("a-private")]);
        await picker.settle();
        expect(picker.assets().map(asset => asset.id)).toEqual(["b-private"]);
        picker.requests[0]!.succeed([serverAsset("late-a-private")]); await picker.settle();
        expect(picker.assets().map(asset => asset.id)).toEqual(["b-private"]);
        picker.setOwner(null); picker.render();
        expect(picker.assets()).toEqual([]);
        expect(picker.requests).toHaveLength(2);
    });

    test("returning to the first account does not revive its obsolete aborted request", async () => {
        const picker = harness(); picker.render();
        picker.setOwner("employee-b"); picker.render();
        picker.setOwner("employee-a"); picker.render();
        picker.requests[2]!.succeed([serverAsset("current-a")]); await picker.settle();
        picker.requests[0]!.succeed([serverAsset("obsolete-a")]);
        picker.requests[1]!.succeed([serverAsset("late-b", "employee-b")]); await picker.settle();
        expect(picker.assets().map(asset => asset.id)).toEqual(["current-a"]);
    });

    test("old single and multiple insertion callbacks cannot insert after identity changes", async () => {
        for (const mode of ["single", "multiple-images"] as const) {
            const picker = harness([], mode); picker.render();
            picker.requests[0]!.succeed([serverAsset("private-a")]); await picker.settle();
            const oldClick = picker.cards()[0]!.props.onClick;
            if (mode === "multiple-images") oldClick();
            const oldConfirm = mode === "multiple-images" ? picker.confirm().onClick : undefined;
            picker.setOwner("employee-b"); // Store changes before React commits its next render.
            oldClick(); oldConfirm?.();
            expect(picker.inserted).toEqual([]); expect(picker.batches).toEqual([]);
            await picker.settle();
            expect(picker.assets()).toEqual([]);
            if (mode === "multiple-images") expect(picker.confirm().disabled).toBe(true);
        }
    });

    test("multiple-image mode and search keep the confirmation count aligned with actual payloads", async () => {
        const picker = harness(); picker.render();
        picker.requests[0]!.succeed([serverAsset("picture"), serverAsset("clip", "employee-a", "video")]); await picker.settle();
        expect(picker.assets()).toHaveLength(2);
        picker.setMode("multiple-images"); await picker.settle();
        expect(picker.assets().map(asset => asset.id)).toEqual(["picture"]);
        picker.cards()[0]!.props.onClick();
        expect(picker.confirm().disabled).toBe(false);
        picker.search("does-not-match"); await picker.settle();
        expect(picker.confirm().disabled).toBe(true);
        picker.search(""); await picker.settle(); picker.confirm().onClick();
        expect(picker.batches).toMatchObject([[{ kind: "image", dataUrl: "/api/assets/picture/content" }]]);
    });

    test("a closed picker does not issue hidden requests", async () => {
        const picker = harness([], "single", false); await picker.settle();
        expect(picker.requests).toEqual([]);
        picker.setOpen(true); picker.render();
        expect(picker.requests).toHaveLength(1);
    });

    test("an obsolete next page cannot mix into a changed filter or replace its cursor", async () => {
        const picker = harness(); picker.render();
        picker.requests[0]!.succeed([serverAsset("first")], "old-next"); await picker.settle();
        picker.loadMore(); picker.render();
        expect(picker.requests[1]!.path).toContain("cursor=old-next");
        picker.search("fresh"); picker.render();
        expect(picker.requests[1]!.init.signal?.aborted).toBe(true);
        picker.requests[2]!.succeed([serverAsset("fresh-current")], "fresh-next"); await picker.settle();
        picker.requests[1]!.succeed([serverAsset("fresh-stale")], "stale-cursor"); await picker.settle();
        expect(picker.assets().map(asset => asset.id)).toEqual(["fresh-current"]);
        picker.loadMore(); picker.render();
        expect(picker.requests[3]!.path).toContain("cursor=fresh-next");
        expect(picker.requests[3]!.path).toContain("q=fresh");
        picker.requests[3]!.succeed([]); await picker.settle();
    });
});
