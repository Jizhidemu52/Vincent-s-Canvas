import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { serverAssetToLocal } from "@/lib/server-asset-local";
import type { ServerAsset } from "@/services/api/server-assets";

const source = readFileSync(new URL("../src/components/canvas/canvas-assets-sidebar.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("sidebar.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect: ts.CallExpression | undefined;
function scan(node: ts.Node) {
    if (!effect && ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect") effect = node;
    ts.forEachChild(node, scan);
}
scan(ast);
const code = ts.transpileModule(effect!.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

function mount() {
    let currentUser = { id: "employee-a" };
    const responses: any[] = [];
    const pending = Promise.withResolvers<{ assets: any[] }>();
    let signal: AbortSignal | undefined;
    let cleanup: (() => void) | undefined;
    const bindings = {
        user: currentUser, reload: 0,
        useEffect: (callback: () => (() => void) | undefined) => { cleanup = callback(); },
        setServerResponse: (response: unknown) => responses.push(response),
        listServerAssets: (received: AbortSignal) => { signal = received; return pending.promise; },
        useUserStore: { getState: () => ({ user: currentUser }) },
    };
    new Function(...Object.keys(bindings), code)(...Object.values(bindings));
    return { pending, responses, signal: () => signal, cleanup: () => cleanup?.(), switchUser: () => { currentUser = { id: "employee-b" }; } };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test("sidebar fetch stores only image/video in component-local employee-scoped response", async () => {
    const view = mount();
    expect(view.responses[0]).toEqual({ userId: "employee-a", assets: [], status: "loading" });
    view.pending.resolve({ assets: [{ id: "image", kind: "image" }, { id: "video", kind: "video" }, { id: "audio", kind: "other" }, { id: "text", kind: "text" }] });
    await settle();
    expect(view.responses[1]).toEqual({ userId: "employee-a", assets: [{ id: "image", kind: "image" }, { id: "video", kind: "video" }], status: "ready" });
    expect(source).not.toContain("useAssetStore.setState");
});
test("late response after account switch never becomes authorized data", async () => {
    const view = mount(); view.switchUser();
    view.pending.resolve({ assets: [{ id: "private-a", kind: "image" }] });
    await settle();
    expect(view.responses).toHaveLength(1);
});
test("unmount aborts request and ignores both delayed success and failure", async () => {
    for (const failed of [false, true]) {
        const view = mount(); view.cleanup();
        expect(view.signal()?.aborted).toBe(true);
        if (failed) view.pending.reject(new Error("aborted")); else view.pending.resolve({ assets: [] });
        await settle();
        expect(view.responses).toHaveLength(1);
    }
});
test("server failures produce explicit error state instead of an empty successful library", async () => {
    const view = mount(); view.pending.reject(new Error("网络暂不可用")); await settle();
    expect(view.responses[1]).toEqual({ userId: "employee-a", assets: [], status: "error", error: "网络暂不可用" });
    expect(source).toContain("云端素材加载失败");
});

test("sidebar merges cloud assets once and never grants a different OA employee access", () => {
    const declarations: string[] = [];
    function collect(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && ["currentResponse", "visibleAssets"].includes(node.name.getText(ast))) declarations.push(`const ${node.getText(ast)};`);
        ts.forEachChild(node, collect);
    }
    collect(ast);
    const visibleCode = ts.transpileModule(declarations.join("\n") + "\nreturn visibleAssets;", { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    const storeSource = readFileSync(new URL("../src/stores/use-asset-store.ts", import.meta.url), "utf8");
    const storeAst = ts.createSourceFile("store.ts", storeSource, ts.ScriptTarget.Latest, true);
    const names = new Set(["assetOwnerId", "canUserAccessAsset", "serverAssetIdFromAsset"]);
    const permissionCode = ts.transpileModule(storeAst.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text || "")).map(node => node.getText(storeAst)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText;
    const permissions: Record<string, unknown> = {};
    new Function("exports", "deploymentFeatures", permissionCode)(permissions, { oaLoginEnabled: true });
    const cloud = (id: string, ownerUserId: string) => ({ id, ownerUserId, filename: id, kind: "image", mimeType: "image/png", byteSize: 10, metadata: {}, createdAt: "" }) as ServerAsset;
    const serverA = cloud("cloud-a", "employee-a");
    const localA = { ...serverAssetToLocal(serverA), id: "local-a" };
    const privateB = serverAssetToLocal(cloud("private-b", "employee-b"));
    const bindings = {
        ...permissions, serverAssetToLocal, useMemo: (callback: () => unknown) => callback(),
        user: { id: "employee-a", role: "super_admin" }, deferredKeyword: "", tab: "history",
        assets: [localA, privateB], serverResponse: { userId: "employee-a", assets: [serverA, cloud("other-b", "employee-b")] },
    };
    const evaluate = () => new Function(...Object.keys(bindings), visibleCode)(...Object.values(bindings));
    expect(evaluate().map((asset: { id: string }) => asset.id)).toEqual(["cloud-a"]);
    bindings.user.id = "employee-b";
    expect(evaluate().map((asset: { id: string }) => asset.id)).toEqual(["private-b"]);
});
