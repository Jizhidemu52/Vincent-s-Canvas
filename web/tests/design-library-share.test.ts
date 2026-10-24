import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type * as Prepare from "@/pages/design-library/prepare-share";
import { readDesignLibraryShareDraft, type DesignLibraryShareSource } from "@/pages/design-library/share-draft";
import type { ServerAsset } from "@/services/api/server-assets";

const source: DesignLibraryShareSource = { ownerId: "owner-a", title: "原始设计", prompt: "完整提示词", thought: "设计判断", tags: ["花型"], model: "来源模型", dataUrl: "blob:original", filename: "original.png" };
const original = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
const ownedAsset = { id: "asset-a", ownerUserId: "owner-a", kind: "image", status: "ready", mimeType: "image/png", byteSize: original.length, filename: "original.png", visibilityScope: "private" } as ServerAsset;
const code = ts.transpileModule(readFileSync(new URL("../src/pages/design-library/prepare-share.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
}).outputText;
function harness(options: { asset?: Partial<ServerAsset>; read?: () => Promise<void>; blob?: Blob; responseStatus?: number; savedSource?: string; uploadedSource?: string; upload?: () => Promise<void> } = {}) {
    let owner = "owner-a", reads = 0, resolves = 0, fetches = 0;
    let uploadedSource = options.uploadedSource;
    const uploads: Array<{ file: File; metadata: Record<string, unknown>; options: Record<string, unknown> }> = [];
    const dependencies: Record<string, unknown> = {
        "@/lib/client-id": { createClientId: () => "stable-upload" },
        "@/services/api/design-library": { requireDesignLibraryOwner: (_admin: boolean, expected: string) => { if (owner !== expected) throw new Error("identity changed"); return owner; } },
        "@/services/api/server-assets": {
            fetchServerAsset: async (id: string) => { reads++; await options.read?.(); return { asset: { ...ownedAsset, id, ...options.asset } }; },
            uploadServerAsset: async (file: File, metadata: Record<string, unknown>, request: Record<string, unknown>) => { uploads.push({ file, metadata, options: request }); await options.upload?.(); return "new-private-asset"; },
        },
        "@/services/canvas-media-links": { readMediaSource: async () => options.savedSource, readUploadedMedia: async () => uploadedSource,
            rememberUploadedMedia: async (_owner: string, _key: string, url: string) => { uploadedSource = url; },
            serverMediaId: (url: string) => url.match(/^\/api\/assets\/([^/]+)\/content$/)?.[1] || "" },
        "@/services/image-storage": { resolveImageUrl: async () => { resolves++; return "blob:original"; } },
    };
    const module = { exports: {} as typeof Prepare };
    new Function("require", "module", "exports", "fetch", code)((name: string) => {
        if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency: ${name}`);
        return dependencies[name];
    }, module, module.exports, async () => { fetches++; return new Response(options.blob || new Blob([original], { type: "image/png" }), { status: options.responseStatus || 200 }); });
    return { prepare: (patch: Partial<DesignLibraryShareSource> = {}, signal = new AbortController().signal) => module.exports.prepareDesignLibraryShareDraft({ ...source, ...patch }, signal),
        uploads, reads: () => reads, resolves: () => resolves, fetches: () => fetches, changeOwner: () => { owner = "owner-b"; } };
}

test.each([{ assetId: "explicit" }, { dataUrl: "/api/assets/from-url/content" }, { storageKey: "local-key" }])("known owned originals are reused without byte reads or upload (%j)", async patch => {
    const h = harness({ savedSource: "/api/assets/from-storage/content" });
    const result = await h.prepare(patch);
    expect(result.savedPrivateCopy).toBe(false); expect(result.draft).toMatchObject({ ownerId: "owner-a", title: source.title, prompt: source.prompt, tags: source.tags, model: source.model });
    expect(h.reads()).toBe(1); expect(h.resolves()).toBe(0); expect(h.fetches()).toBe(0); expect(h.uploads).toEqual([]);
});

test("local images preserve original bytes and are saved as owner-bound private assets before creating a draft", async () => {
    const h = harness(); const result = await h.prepare();
    expect(result.savedPrivateCopy).toBe(true); expect(result.draft.asset.id).toBe("new-private-asset");
    expect(h.uploads).toHaveLength(1); const upload = h.uploads[0];
    expect(new Uint8Array(await upload.file.arrayBuffer())).toEqual(original); expect(upload.file.name).toBe("original.png"); expect(upload.file.type).toBe("image/png");
    expect(upload.options.expectedOwnerId).toBe("owner-a"); expect(upload.options.signal).toBeInstanceOf(AbortSignal);
    expect(upload.metadata).toMatchObject({ source: "design-library-draft", prompt: source.prompt, model: source.model });
    expect(upload.metadata).not.toHaveProperty("visibility"); expect(upload.metadata).not.toHaveProperty("visibilityScope");
});

test("previous canvas/private-asset uploads are reused and a newly saved immutable local key is remembered", async () => {
    const cached = harness({ uploadedSource: "/api/assets/already-private/content" });
    expect((await cached.prepare({ storageKey: "image:cached" })).draft.asset.id).toBe("already-private");
    expect(cached.uploads).toEqual([]); expect(cached.fetches()).toBe(0);
    const h = harness(); const first = await h.prepare({ storageKey: "image:immutable" });
    const repeated = await h.prepare({ storageKey: "image:immutable" });
    expect(repeated.draft.asset.id).toBe(first.draft.asset.id); expect(repeated.savedPrivateCopy).toBe(false);
    expect(h.uploads).toHaveLength(1); expect(h.uploads[0].options.clientReferenceId).toBe("canvas:image:immutable");
});

test.each([{ ownerUserId: "another-owner" }, { status: "deleted" }, { deletedAt: "2026-10-24" }, { kind: "video" }, { mimeType: "image/svg+xml" }, { byteSize: 0 }, { byteSize: 21 * 1024 * 1024 }])("unshareable server assets fail closed without cloning (%j)", async asset => {
    const h = harness({ asset: asset as Partial<ServerAsset> });
    await expect(h.prepare({ assetId: "existing" })).rejects.toThrow(); expect(h.uploads).toEqual([]); expect(h.fetches()).toBe(0);
});

test.each([new Blob([], { type: "image/png" }), new Blob(["svg"], { type: "image/svg+xml" }), new Blob([new Uint8Array(21 * 1024 * 1024)], { type: "image/png" })])("invalid local bytes cannot be uploaded", async blob => {
    const h = harness({ blob }); await expect(h.prepare()).rejects.toThrow("20 MB"); expect(h.uploads).toEqual([]);
});

test("failed original reads never upload an error body", async () => {
    const h = harness({ responseStatus: 404 }); await expect(h.prepare()).rejects.toThrow("404"); expect(h.uploads).toEqual([]);
});

test("identity changes while saving stop before fetching or opening the new draft", async () => {
    const pending = Promise.withResolvers<void>(); const h = harness({ upload: () => pending.promise });
    const result = h.prepare(); while (!h.uploads.length) await Promise.resolve(); h.changeOwner(); pending.resolve();
    await expect(result).rejects.toThrow("identity changed"); expect(h.reads()).toBe(0);
});

test("cancellation after an existing-asset read never returns a draft", async () => {
    const pending = Promise.withResolvers<void>(), controller = new AbortController(); const h = harness({ read: () => pending.promise });
    const result = h.prepare({ assetId: "existing" }, controller.signal); controller.abort(); pending.resolve();
    await expect(result).rejects.toThrow(); expect(h.uploads).toEqual([]);
});

test("route drafts are accepted only for their original owner and valid fields", async () => {
    const { draft } = await harness().prepare({ assetId: "existing" });
    expect(readDesignLibraryShareDraft({ designLibraryDraft: draft }, "owner-a")).toEqual(draft);
    expect(readDesignLibraryShareDraft({ designLibraryDraft: draft }, "owner-b")).toBeUndefined();
    for (const state of [null, {}, { designLibraryDraft: { ...draft, asset: null } }, { designLibraryDraft: { ...draft, model: {} } }, { designLibraryDraft: { ...draft, tags: [3] } }]) {
        expect(readDesignLibraryShareDraft(state, "owner-a")).toBeUndefined();
    }
});
