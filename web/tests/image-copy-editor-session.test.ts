import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { imageCopyEditorNode } from "@/lib/image-edit-copy";
import type { AssetInput } from "@/stores/use-asset-store";

const hookUrl = new URL("../src/hooks/use-image-copy-editor.ts", import.meta.url);
const requireModule = createRequire(hookUrl);
const code = ts.transpileModule(readFileSync(hookUrl, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const source = { node: imageCopyEditorNode({ id: "source", title: "原图", dataUrl: "blob:original", storageKey: "image:original", width: 100, height: 100 }) };
const image = { url: "blob:copy", storageKey: "image:copy", width: 728, height: 90, bytes: 10, mimeType: "image/png" };

function harness() {
    const states: unknown[] = [], refs: Array<{ current: unknown }> = [], assets: AssetInput[] = [];
    let stateIndex = 0, refIndex = 0, ownerId = "owner-a";
    let subscribe: ((current: any, previous: any) => void) | undefined;
    let cleanup: (() => void) | undefined;
    let mounted = false;
    const dependencies: Record<string, unknown> = {
        react: {
            useState(initial: unknown) { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], (value: unknown) => { states[index] = value; }]; },
            useRef(initial: unknown) { const index = refIndex++; return refs[index] ||= { current: initial }; },
            useEffect(effect: () => () => void) { if (!mounted) { mounted = true; cleanup = effect(); } },
        },
        "@/stores/use-user-store": { useUserStore: { getState: () => ({ user: { id: ownerId } }), subscribe: (listener: typeof subscribe) => { subscribe = listener; return () => { subscribe = undefined; }; } } },
        "@/stores/use-asset-store": { useAssetStore: { getState: () => ({ assets, addAsset: (asset: AssetInput) => { assets.push(asset); return `copy-${assets.length}`; } }) } },
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", code)((name: string) => dependencies[name] || requireModule(name), module, module.exports);
    const render = () => { stateIndex = refIndex = 0; return module.exports.useImageCopyEditor(); };
    return { render, assets, unmount: () => cleanup?.(), changeAccount(next: string) { const previous = ownerId; ownerId = next; subscribe?.({ user: { id: next } }, { user: { id: previous } }); } };
}

test("late editor uploads cannot save after account switch, even when the original account returns", async () => {
    const app = harness();
    app.render().open(source);
    const pendingEditor = app.render();
    app.changeAccount("owner-b");
    app.changeAccount("owner-a");
    await expect(pendingEditor.confirm(image)).rejects.toThrow("失效");
    expect(app.render().node).toBeUndefined();
    expect(app.assets).toHaveLength(0);
    app.unmount();
});

test("closing or leaving the page rejects pending saves while a fresh editor can create its own copy", async () => {
    const app = harness();
    app.render().open(source);
    const closedEditor = app.render();
    closedEditor.close();
    await expect(closedEditor.confirm(image)).rejects.toThrow("失效");
    app.render().open(source);
    await app.render().confirm(image);
    expect(app.assets).toHaveLength(1);
    expect(app.assets[0]).toMatchObject({ ownerId: "owner-a", data: { width: 728, height: 90 } });
    app.render().open(source);
    const unmountedEditor = app.render();
    app.unmount();
    await expect(unmountedEditor.confirm(image)).rejects.toThrow("失效");
    expect(app.assets).toHaveLength(1);
});
