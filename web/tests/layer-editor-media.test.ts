import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { LayerStudioItem } from "../../shared/layer-studio";
import { createLayerStudioMedia, layerStudioAssetPath, layerStudioFileName } from "../src/pages/layer-studio/layer-editor-media";

const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const digest = createHash("sha256").update(bytes).digest("hex");
const item = (): LayerStudioItem => ({ index: 0, groupIndex: 0, urlIndex: 0, role: "base", state: "saved", assetId: "asset-a", contentUrl: "/api/assets/asset-a/content", mimeType: "image/png", sha256: digest });
test("only exact internal saved asset addresses can be read", () => {
    assert.equal(layerStudioAssetPath(item()), "/api/assets/asset-a/content");
    for (const patch of [{ state: "pending" as const }, { contentUrl: "https://example.com/private.png" }, { contentUrl: "/api/assets/asset-a/content?unsafe=1" }, { assetId: "../secret" }]) assert.throws(() => layerStudioAssetPath({ ...item(), ...patch }));
    assert.equal(layerStudioFileName({ ...item(), name: "../a:b" }, "image/jpeg"), "01-.._a_b.jpg");
});
test("authenticated bytes are hash verified and original download cache does not re-encode", async () => {
    const calls: RequestInit[] = [];
    const media = createLayerStudioMedia({ assertCurrent() {}, headers: () => ({ "X-Canvas-Owner-Id": "employee-a" }), fetcher: (async (_input, init) => {
        calls.push(init!); return new Response(bytes, { headers: { "Content-Type": "image/png" } });
    }) as typeof fetch });
    const [first, second] = await Promise.all([media.readOriginal(item()), media.readOriginal(item())]);
    assert.equal(first, second); assert.equal(calls.length, 1);
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), bytes);
    assert.deepEqual(calls[0].headers, { "X-Canvas-Owner-Id": "employee-a" }); assert.equal(calls[0].credentials, "include"); assert.equal(calls[0].cache, "no-store");
    media.dispose(); await assert.rejects(media.readOriginal(item()));
});
test("bad hashes and unsupported media are never silently exported", async () => {
    const media = createLayerStudioMedia({ assertCurrent() {}, headers: () => ({}), fetcher: (async () => new Response(bytes, { headers: { "Content-Type": "image/png" } })) as typeof fetch });
    await assert.rejects(media.readOriginal({ ...item(), sha256: "0".repeat(64) }), /校验不一致/); media.dispose();
    const invalid = createLayerStudioMedia({ assertCurrent() {}, headers: () => ({}), fetcher: (async () => new Response("<svg />", { headers: { "Content-Type": "image/svg+xml" } })) as typeof fetch });
    await assert.rejects(invalid.readOriginal(item()), /PNG \/ JPEG/); invalid.dispose();
});
test("employee changes reject in-flight responses and cache is bounded", async () => {
    let owner = "a", calls = 0;
    let finish: (() => void) | undefined;
    const media = createLayerStudioMedia({ assertCurrent() { if (owner !== "a") throw new Error("owner changed"); }, headers: () => ({}), cacheBytes: 7, fetcher: (async () => {
        calls++; if (calls === 1) await new Promise<void>(resolve => { finish = resolve; }); return new Response(bytes, { headers: { "Content-Type": "image/png" } });
    }) as typeof fetch });
    const pending = media.readOriginal(item()); owner = "b"; finish!(); await assert.rejects(pending, /owner changed/); media.dispose();
    let boundedCalls = 0;
    const bounded = createLayerStudioMedia({ assertCurrent() {}, headers: () => ({}), cacheBytes: 7, fetcher: (async () => { boundedCalls++; return new Response(bytes, { headers: { "Content-Type": "image/png" } }); }) as typeof fetch });
    await bounded.readOriginal(item()); await bounded.readOriginal({ ...item(), assetId: "asset-b", contentUrl: "/api/assets/asset-b/content" }); await bounded.readOriginal(item());
    assert.equal(boundedCalls, 3); bounded.dispose();
});
