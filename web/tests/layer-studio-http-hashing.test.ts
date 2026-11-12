import { test } from "node:test";
import assert from "node:assert/strict";
import type { LayerStudioItem } from "../../shared/layer-studio";
import { saveLayerStudioReference } from "../src/pages/layer-studio/page-reference";
import { createLayerStudioMedia } from "../src/pages/layer-studio/layer-editor-media";

const originalBytes = new TextEncoder().encode("abc");
const originalSha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

async function withoutSecureContext(run: () => Promise<void>) {
    const replacements = {
        crypto: { subtle: undefined },
        isSecureContext: false,
        createImageBitmap: async () => ({ width: 1536, height: 1024, close() {} }),
    };
    const descriptors = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const originalFetch = globalThis.fetch;
    try {
        for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, value });
        await run();
    } finally {
        globalThis.fetch = originalFetch;
        for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
}

test("HTTP reference upload hashes original bytes without crypto.subtle and keeps the owner fence", async () => {
    await withoutSecureContext(async () => {
        const file = new File([originalBytes], "menswear-source.webp", { type: "image/webp" });
        const calls: Array<{ path: string; init: RequestInit }> = [];
        globalThis.fetch = (async (input, init) => {
            const path = String(input);
            calls.push({ path, init: init! });
            if (path === "/api/assets/upload-request") return Response.json({ assetId: "reference-a", uploadUrl: "/api/assets/reference-a/upload" }, { status: 201 });
            if (path === "/api/assets/reference-a/upload") return new Response(null, { status: 204 });
            throw new Error(`Unexpected request: ${path}`);
        }) as typeof fetch;

        const reference = await saveLayerStudioReference(file, "employee-a", () => {});
        assert.deepEqual(reference, { id: "reference-a", name: file.name, mimeType: "image/webp", bytes: 3, sha256: originalSha256, width: 1536, height: 1024, previewable: true });
        assert.equal(calls.length, 2);
        assert.equal(calls[0].init.method, "POST");
        assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
            filename: file.name, mimeType: "image/webp", byteSize: 3, kind: "image",
            metadata: { source: "layer-studio-reference", sha256: originalSha256, width: 1536, height: 1024 },
            clientReferenceId: `layer-studio:${originalSha256}`,
        });
        for (const { init } of calls) {
            assert.equal(init.credentials, "include");
            assert.equal(new Headers(init.headers).get("X-Canvas-Owner-Id"), "employee-a");
        }
        assert.equal(calls[1].init.method, "PUT");
        assert.equal(calls[1].init.body, file);
        assert.deepEqual(new Uint8Array(await (calls[1].init.body as File).arrayBuffer()), originalBytes);
    });
});

test("HTTP reference hashing refuses an employee change before any upload request", async () => {
    await withoutSecureContext(async () => {
        let sameOwner = true, calls = 0;
        const file = new File([originalBytes], "menswear-source.webp", { type: "image/webp" });
        const readOriginal = file.arrayBuffer.bind(file);
        Object.defineProperty(file, "arrayBuffer", { value: async () => { sameOwner = false; return readOriginal(); } });
        globalThis.fetch = (async () => { calls++; throw new Error("No upload expected"); }) as typeof fetch;
        await assert.rejects(saveLayerStudioReference(file, "employee-a", () => { if (!sameOwner) throw new Error("owner changed"); }), /owner changed/);
        assert.equal(calls, 0);
    });
});

test("HTTP result reads verify SHA-256 without crypto.subtle and reject altered originals", async () => {
    await withoutSecureContext(async () => {
        const item: LayerStudioItem = { index: 0, groupIndex: 0, urlIndex: 0, role: "layer", state: "saved", assetId: "result-a", contentUrl: "/api/assets/result-a/content", mimeType: "image/png", sha256: originalSha256.toUpperCase() };
        const calls: RequestInit[] = [];
        const media = createLayerStudioMedia({ assertCurrent() {}, headers: () => ({ "X-Canvas-Owner-Id": "employee-a" }), fetcher: (async (_input, init) => {
            calls.push(init!); return new Response(originalBytes, { headers: { "Content-Type": "image/png" } });
        }) as typeof fetch });
        const altered = createLayerStudioMedia({ assertCurrent() {}, headers: () => ({}), fetcher: (async () => new Response("abd", { headers: { "Content-Type": "image/png" } })) as typeof fetch });
        try {
            const original = await media.readOriginal(item);
            assert.deepEqual(new Uint8Array(await original.arrayBuffer()), originalBytes);
            assert.equal(await media.readOriginal(item), original);
            assert.equal(calls.length, 1);
            assert.equal(calls[0].credentials, "include");
            assert.equal(calls[0].cache, "no-store");
            assert.deepEqual(calls[0].headers, { "X-Canvas-Owner-Id": "employee-a" });
            await assert.rejects(altered.readOriginal(item), /校验不一致/);
        } finally { media.dispose(); altered.dispose(); }
    });
});

test("HTTP result hashing refuses an employee change during byte reading and does not cache it", async () => {
    await withoutSecureContext(async () => {
        let sameOwner = true, calls = 0;
        const item: LayerStudioItem = { index: 0, groupIndex: 0, urlIndex: 0, role: "layer", state: "saved", assetId: "result-a", contentUrl: "/api/assets/result-a/content", sha256: originalSha256 };
        const media = createLayerStudioMedia({ assertCurrent() { if (!sameOwner) throw new Error("owner changed"); }, headers: () => ({}), fetcher: (async () => {
            const response = new Response(originalBytes, { headers: { "Content-Type": "image/png" } });
            if (++calls === 1) {
                const blob = new Blob([originalBytes], { type: "image/png" });
                const readOriginal = blob.arrayBuffer.bind(blob);
                Object.defineProperty(blob, "arrayBuffer", { value: async () => { sameOwner = false; return readOriginal(); } });
                response.blob = async () => blob;
            }
            return response;
        }) as typeof fetch });
        try {
            await assert.rejects(media.readOriginal(item), /owner changed/);
            sameOwner = true;
            const original = await media.readOriginal(item);
            assert.equal(calls, 2);
            assert.deepEqual(new Uint8Array(await original.arrayBuffer()), originalBytes);
        } finally { media.dispose(); }
    });
});
