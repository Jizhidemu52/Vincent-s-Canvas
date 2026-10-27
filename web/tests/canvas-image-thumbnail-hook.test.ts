import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { canvasServerThumbnailUrl, type ImageThumbnailEdge } from "@/lib/canvas/canvas-image-thumbnail";
import type { ImageThumbnailLease } from "@/lib/image-thumbnail-cache";

const code = ts.transpileModule(readFileSync(new URL("../src/components/canvas/use-canvas-image-thumbnail.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
function harness(thumbnail: () => Promise<ImageThumbnailLease | null>, original = async () => "blob:original") {
    const values: any[] = [];
    let cursor = 0;
    const dependenciesBefore = new Map<number, unknown[]>();
    const cleanups = new Map<number, () => void>();
    let result: any;
    let edge: ImageThumbnailEdge | 0 = 0;
    let originalCalls = 0;
    let thumbnailCalls = 0;
    const effects: Array<{ index: number; run: () => void | (() => void) }> = [];
    const module = { exports: {} as any };
    const dependencies: Record<string, unknown> = {
        react: {
            useState: (initial: unknown) => {
                const index = cursor++;
                if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
                return [values[index], (value: any) => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
            },
            useRef: (initial: unknown) => {
                const index = cursor++;
                if (!(index in values)) values[index] = { current: initial };
                return values[index];
            },
            useEffect: (run: () => void | (() => void), deps: unknown[]) => {
                const index = cursor++;
                const before = dependenciesBefore.get(index);
                if (!before || deps.some((value, i) => !Object.is(value, before[i]))) {
                    dependenciesBefore.set(index, deps);
                    effects.push({ index, run });
                }
            },
        },
        "@/services/image-storage": { resolveImageUrl: async () => { originalCalls++; return original(); } },
        "@/services/image-thumbnails": { acquireImageThumbnail: () => { thumbnailCalls++; return thumbnail(); } },
        "@/lib/canvas/canvas-image-thumbnail": { canvasServerThumbnailUrl },
    };
    new Function("require", "module", "exports", code)((name: string) => dependencies[name], module, module.exports);
    const node: CanvasNodeData = { id: "node", type: CanvasNodeType.Image, title: "原图", position: { x: 0, y: 0 }, width: 400, height: 300, metadata: { storageKey: "image:original", content: "blob:persisted-original", naturalWidth: 4000, naturalHeight: 3000 } };
    const render = () => {
        cursor = 0;
        result = module.exports.useCanvasImageThumbnail(node, edge);
        for (const effect of effects.splice(0)) {
            cleanups.get(effect.index)?.();
            const cleanup = effect.run();
            if (cleanup) cleanups.set(effect.index, cleanup);
            else cleanups.delete(effect.index);
        }
        return result;
    };
    return {
        node,
        run: async (nextEdge: ImageThumbnailEdge | 0 = edge, load = true) => {
            edge = nextEdge;
            render();
            for (let i = 0; i < 20; i++) {
                await Promise.resolve();
                const preview = render();
                if (load && preview.url && !preview.loaded && !preview.failed) preview.onLoad?.();
            }
            render();
        },
        unmount: () => cleanups.forEach(cleanup => cleanup()),
        state: () => ({ preview: render(), originalCalls, thumbnailCalls }),
    };
}

test("mounted canvas thumbnails never alter the node source or resolve original bytes unnecessarily", async () => {
    let releases = 0;
    const h = harness(async () => ({ url: "blob:thumbnail", release: () => { releases++; } }));
    const originalMetadata = JSON.stringify(h.node.metadata);
    await h.run(256);
    expect(h.state().preview).toMatchObject({ url: "blob:thumbnail", thumbnail: true });
    expect(h.state().originalCalls).toBe(0);
    expect(JSON.stringify(h.node.metadata)).toBe(originalMetadata);
    await h.run(0);
    expect(h.state().preview).toMatchObject({ url: "blob:original", thumbnail: false });
    expect(releases).toBe(1);
    expect(h.state().originalCalls).toBe(1);
});

test("failed thumbnails fall back once, original failure is visible and retry is explicit", async () => {
    let releases = 0;
    const h = harness(async () => ({ url: "blob:thumbnail", release: () => { releases++; } }));
    await h.run(256);
    h.state().preview.onError();
    await h.run();
    expect(h.state().preview).toMatchObject({ url: "blob:original", thumbnail: false, failed: false });
    expect(releases).toBe(1);
    h.state().preview.onError();
    await h.run();
    expect(h.state().preview.failed).toBe(true);
    expect(h.state().originalCalls).toBe(1);
    const previousKey = h.state().preview.key;
    h.state().preview.retry();
    await h.run();
    expect(h.state().preview.key).not.toBe(previousKey);
    expect(h.state().thumbnailCalls).toBe(2);
    expect(h.state().preview.failed).toBe(false);
    expect(typeof h.state().preview.onLoad).toBe("function");
    h.unmount();
});

test("a zoom upgrade retains the decoded preview lease until the original image loads", async () => {
    const original = Promise.withResolvers<string>();
    let releases = 0;
    const h = harness(async () => ({ url: "blob:small", release: () => { releases++; } }), () => original.promise);
    await h.run(256);
    await h.run(0, false);
    expect(h.state().preview.url).toBe("blob:small");
    expect(releases).toBe(0);
    original.resolve("blob:original");
    await h.run(0, false);
    expect(h.state().preview).toMatchObject({ url: "blob:original", placeholderUrl: "blob:small", loaded: false });
    expect(releases).toBe(0);
    h.state().preview.onLoad();
    await h.run(0, false);
    expect(h.state().preview).toMatchObject({ url: "blob:original", placeholderUrl: "", loaded: true });
    expect(releases).toBe(1);
    h.unmount();
});

test("a cold high-detail view shows a small preview before resolving original bytes", async () => {
    const h = harness(async () => ({ url: "blob:small", release() {} }));
    await h.run(0, false);
    expect(h.state().preview).toMatchObject({ url: "blob:small", thumbnail: true, loaded: false });
    expect(h.state().originalCalls).toBe(0);
    h.state().preview.onLoad();
    await h.run(0, false);
    expect(h.state().preview).toMatchObject({ url: "blob:original", placeholderUrl: "blob:small" });
    expect(h.state().originalCalls).toBe(1);
    h.unmount();
});

test("a small original is not decoded into an equally large bootstrap thumbnail", async () => {
    const h = harness(async () => ({ url: "blob:unnecessary", release() {} }));
    h.node.metadata!.naturalWidth = 200;
    h.node.metadata!.naturalHeight = 150;
    await h.run(0);
    expect(h.state().thumbnailCalls).toBe(0);
    expect(h.state().preview.url).toBe("blob:original");
});

test("changing source clears the previous image instead of leaking it as a placeholder", async () => {
    let releases = 0;
    const h = harness(async () => ({ url: `blob:${h.node.id}`, release: () => { releases++; } }));
    await h.run(256);
    h.node.metadata!.storageKey = "image:new";
    h.node.metadata!.content = "";
    h.node.id = "new";
    await h.run(256, false);
    expect(h.state().preview.url).toBe("blob:new");
    expect(h.state().preview.placeholderUrl).toBe("");
    expect(releases).toBe(1);
    h.unmount();
});

test("missing and rejected original reads show error and a later manual retry can recover", async () => {
    let attempts = 0;
    const h = harness(async () => null, async () => {
        if (++attempts === 1) throw new Error("offline");
        return attempts === 2 ? "" : "blob:recovered";
    });
    await h.run(0);
    expect(h.state().preview.failed).toBe(true);
    h.state().preview.retry(); await h.run();
    expect(h.state().preview.failed).toBe(true);
    h.state().preview.retry(); await h.run();
    expect(h.state().preview.url).toBe("blob:recovered");
    expect(h.state().originalCalls).toBe(3);
});

test("server derivative failure uses the original and source changes clear the error", async () => {
    const h = harness(async () => null);
    h.node.metadata = { content: "/api/assets/12345678-1234-1234-1234-123456789012/content", naturalWidth: 2000, naturalHeight: 1000 };
    await h.run(256);
    expect(h.state().preview.url).toContain("/thumb?w=256");
    expect(h.state().originalCalls).toBe(0);
    h.state().preview.onError(); await h.run();
    expect(h.state().preview.thumbnail).toBe(false);
    h.state().preview.onError(); await h.run();
    expect(h.state().preview.failed).toBe(true);
    h.node.metadata.content = "data:image/png;base64,new";
    await h.run();
    expect(h.state().preview.failed).toBe(false);
});

test("unsupported thumbnail creation falls back to the original resolver", async () => {
    const h = harness(async () => null);
    await h.run(256);
    expect(h.state().preview).toMatchObject({ url: "blob:original", thumbnail: false });
    expect(h.state().originalCalls).toBe(1);
});

test("late thumbnail completion after unmount is released, never installed", async () => {
    let finish!: (lease: ImageThumbnailLease) => void;
    let releases = 0;
    const h = harness(() => new Promise((resolve) => { finish = resolve; }));
    await h.run(256);
    h.unmount();
    finish({ url: "blob:thumbnail", release: () => { releases++; } });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(h.state().preview.url).toBe("");
    expect(h.state().originalCalls).toBe(0);
    expect(releases).toBe(1);
});
