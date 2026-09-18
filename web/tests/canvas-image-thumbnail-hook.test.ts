import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { ImageThumbnailEdge } from "@/lib/canvas/canvas-image-thumbnail";
import type { ImageThumbnailLease } from "@/lib/image-thumbnail-cache";

const code = ts.transpileModule(readFileSync(new URL("../src/components/canvas/use-canvas-image-thumbnail.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
function harness(thumbnail: () => Promise<ImageThumbnailLease | null>) {
    let preview: any;
    let cleanup: (() => void) | undefined;
    let originalCalls = 0;
    let thumbnailCalls = 0;
    const effects: Array<() => void | (() => void)> = [];
    const module = { exports: {} as any };
    const dependencies: Record<string, unknown> = {
        react: {
            useState: (initial: unknown) => { preview ??= initial; return [preview, (value: unknown) => { preview = value; }]; },
            useEffect: (run: () => void | (() => void)) => { effects.push(run); },
        },
        "@/services/image-storage": { resolveImageUrl: async () => { originalCalls++; return "blob:original"; } },
        "@/services/image-thumbnails": { acquireImageThumbnail: () => { thumbnailCalls++; return thumbnail(); } },
    };
    new Function("require", "module", "exports", code)((name: string) => dependencies[name], module, module.exports);
    const node: CanvasNodeData = { id: "node", type: CanvasNodeType.Image, title: "原图", position: { x: 0, y: 0 }, width: 400, height: 300, metadata: { storageKey: "image:original", content: "blob:persisted-original", naturalWidth: 4000, naturalHeight: 3000 } };
    return {
        node,
        run: async (edge: ImageThumbnailEdge | 0) => {
            cleanup?.();
            module.exports.useCanvasImageThumbnail(node, edge);
            cleanup = effects.shift()?.() || undefined;
            for (let i = 0; i < 10; i++) await Promise.resolve();
        },
        unmount: () => cleanup?.(),
        state: () => ({ preview, originalCalls, thumbnailCalls }),
    };
}

test("mounted canvas thumbnails never alter the node source or resolve original bytes unnecessarily", async () => {
    let releases = 0;
    const h = harness(async () => ({ url: "blob:thumbnail", release: () => { releases++; } }));
    const originalMetadata = JSON.stringify(h.node.metadata);
    await h.run(512);
    expect(h.state().preview).toMatchObject({ url: "blob:thumbnail", thumbnail: true });
    expect(h.state().originalCalls).toBe(0);
    expect(JSON.stringify(h.node.metadata)).toBe(originalMetadata);
    await h.run(0);
    expect(h.state().preview).toMatchObject({ url: "blob:original", thumbnail: false });
    expect(releases).toBe(1);
    expect(h.state().originalCalls).toBe(1);
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
