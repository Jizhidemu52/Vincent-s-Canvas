import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { canvasServerThumbnailUrl } from "@/lib/canvas/canvas-image-thumbnail";
import type { PreviewImage } from "@/hooks/use-image-preview";
import type { ImageThumbnailLease } from "@/lib/image-thumbnail-cache";

const code = ts.transpileModule(readFileSync(new URL("../src/hooks/use-image-preview.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
function harness(thumbnail: () => Promise<ImageThumbnailLease | null>) {
    let state: any, effect: () => void | (() => void), cleanup: void | (() => void);
    let originalCalls = 0, thumbnailCalls = 0;
    const module = { exports: {} as any };
    const dependencies: Record<string, unknown> = {
        react: { useState: (initial: unknown) => { state ??= initial; return [state, (value: unknown) => { state = value; }]; }, useEffect: (run: typeof effect) => { effect = run; } },
        "@/services/image-storage": { resolveImageUrl: async () => { originalCalls++; return "blob:original"; } },
        "@/services/image-thumbnails": { acquireImageThumbnail: () => { thumbnailCalls++; return thumbnail(); } },
        "@/lib/canvas/canvas-image-thumbnail": { canvasServerThumbnailUrl },
    };
    new Function("require", "module", "exports", code)((name: string) => dependencies[name], module, module.exports);
    return {
        async run(image: PreviewImage, enabled = true) {
            cleanup?.(); module.exports.useImagePreview(image, 256, enabled); cleanup = effect!();
            for (let i = 0; i < 10; i++) await Promise.resolve();
        },
        unmount: () => cleanup?.(), state: () => ({ url: state.url, originalCalls, thumbnailCalls }),
    };
}
const original: PreviewImage = { dataUrl: "blob:original", storageKey: "image-key", width: 4000, height: 3000 };

test("generated result previews share derivatives without altering the original", async () => {
    let released = 0;
    const h = harness(async () => ({ url: "blob:thumbnail", release: () => { released++; } }));
    const before = JSON.stringify(original); await h.run(original);
    expect(h.state()).toEqual({ url: "blob:thumbnail", originalCalls: 0, thumbnailCalls: 1 });
    expect(JSON.stringify(original)).toBe(before); h.unmount(); expect(released).toBe(1);
});
test("server images resolve directly to authorized thumbnail URLs without loading original blobs", async () => {
    const h = harness(async () => null);
    await h.run({ ...original, dataUrl: "/api/assets/10000000-0000-4000-8000-000000000001/content" });
    expect(h.state()).toEqual({ url: "/api/assets/10000000-0000-4000-8000-000000000001/thumb?w=256", originalCalls: 0, thumbnailCalls: 0 });
});
test("offscreen history remains unopened; missing thumbnail support falls back to originals", async () => {
    const h = harness(async () => null); await h.run(original, false);
    expect(h.state()).toEqual({ url: "", originalCalls: 0, thumbnailCalls: 0 });
    await h.run(original); expect(h.state()).toEqual({ url: "blob:original", originalCalls: 1, thumbnailCalls: 1 }); h.unmount();
});
test("failed derivatives keep the original visible and a late cancelled lease is released", async () => {
    const failed = harness(async () => { throw new Error("Unsupported image decoder"); });
    await failed.run(original); expect(failed.state().url).toBe("blob:original"); failed.unmount();
    let resolve!: (lease: ImageThumbnailLease) => void, released = 0;
    const h = harness(() => new Promise(done => { resolve = done; })); await h.run(original); h.unmount();
    resolve({ url: "blob:late", release: () => { released++; } });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(h.state()).toEqual({ url: "", originalCalls: 0, thumbnailCalls: 1 }); expect(released).toBe(1);
});
