import { afterEach, expect, test } from "bun:test";
import { readGenerationReferenceDataUrl, uploadImageReference } from "../src/services/api/generation-tasks";
import { assertServerAssetContent, uploadServerAsset } from "../src/services/api/server-assets";
import { useUserStore } from "../src/stores/use-user-store";
import type { ReferenceImage } from "../src/types/image";

const originalFetch = globalThis.fetch;
const originalUser = useUserStore.getState();
afterEach(() => { globalThis.fetch = originalFetch; useUserStore.setState(originalUser, true); });
const file = new File(["same bytes"], "reference.png", { type: "image/png" });
const reference: ReferenceImage = { id: "ref", name: file.name, dataUrl: "", type: file.type };
const signIn = (id: string) => useUserStore.setState({ user: { ...originalUser.user, id } as never, status: "authenticated" });

test("concurrent slots upload identical reference bytes once per employee", async () => {
    let uploads = 0;
    globalThis.fetch = (async (input, init) => {
        if (String(input) === "/api/assets/upload-request") {
            uploads++;
            expect(JSON.parse(String(init?.body)).metadata.contentSha256).toBe("same-hash");
            return Response.json({ assetId: `asset-${uploads}`, uploadUrl: null });
        }
        return Response.json({ asset: { id: String(input).split("/").at(-1), status: "ready", kind: "image" } });
    }) as typeof fetch;
    signIn("dedupe-alice");
    expect(await Promise.all([1, 2, 3, 4].map(() => uploadImageReference(reference, file, "same-hash", "dedupe-alice")))).toEqual(["asset-1", "asset-1", "asset-1", "asset-1"]);
    expect(uploads).toBe(1);
    signIn("dedupe-bob");
    expect(await uploadImageReference(reference, file, "same-hash", "dedupe-bob")).toBe("asset-2");
    expect(uploads).toBe(2);
});

test("an accessible source asset is reused directly and never uploaded", async () => {
    signIn("asset-alice");
    const calls: string[] = [];
    globalThis.fetch = (async input => { calls.push(String(input)); return Response.json({ asset: { id: "source", kind: "image", status: "ready" } }); }) as typeof fetch;
    expect(await uploadImageReference({ ...reference, sourceAssetId: "source" }, file, "hash", "asset-alice")).toBe("source");
    expect(calls).toEqual(["/api/assets/source", "/api/assets/source/content"]);
});

test("revoked source access is reported rather than silently re-uploading a private copy", async () => {
    signIn("revoked-alice");
    const calls: string[] = [];
    globalThis.fetch = (async input => { calls.push(String(input)); return Response.json({}, { status: 403 }); }) as typeof fetch;
    await expect(uploadImageReference({ ...reference, sourceAssetId: "revoked" }, file, "hash", "revoked-alice")).rejects.toThrow();
    expect(calls).toEqual(["/api/assets/revoked"]);
});

test("a proven missing source is restored with exact local bytes under the same asset ID", async () => {
    signIn("repair-alice");
    const calls: string[] = [];
    let ready = false;
    globalThis.fetch = (async (input, init) => {
        const path = String(input); calls.push(`${init?.method || "GET"} ${path}`);
        if (path === "/api/assets/source") return Response.json({ asset: { id: "source", kind: "image", status: "ready" } });
        if (path === "/api/assets/source/content") return ready ? new Response(null, { status: 200 }) : new Response(null, { status: 404, headers: { "X-Canvas-Asset-Error": "ASSET_OBJECT_MISSING" } });
        if (path === "/api/assets/upload-request") {
            expect(JSON.parse(String(init?.body))).toMatchObject({ repairAssetId: "source", byteSize: file.size, mimeType: file.type, metadata: { contentSha256: "original-hash" } });
            return Response.json({ assetId: "source", reused: true, uploadUrl: "/api/assets/source/upload?repair=1" });
        }
        if (path === "/api/assets/source/upload?repair=1") {
            expect(init?.method).toBe("PUT");
            expect(await (init?.body as File).text()).toBe("same bytes");
            ready = true;
            return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected ${path}`);
    }) as typeof fetch;
    expect(await uploadImageReference({ ...reference, sourceAssetId: "source" }, file, "original-hash", "repair-alice")).toBe("source");
    expect(calls).toEqual(["GET /api/assets/source", "HEAD /api/assets/source/content", "POST /api/assets/upload-request", "PUT /api/assets/source/upload?repair=1", "HEAD /api/assets/source/content"]);
});

test("a cached ready upload is checked again and repaired rather than blindly reused", async () => {
    signIn("cache-repair-alice");
    let ready = true, uploads = 0, repairs = 0;
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path === "/api/assets/upload-request") {
            uploads++;
            const body = JSON.parse(String(init?.body));
            return Response.json({ assetId: "cached", reused: true, uploadUrl: body.repairAssetId ? "/api/assets/cached/upload?repair=1" : null });
        }
        if (path === "/api/assets/cached") return Response.json({ asset: { id: "cached", kind: "image", status: "ready" } });
        if (path === "/api/assets/cached/content") return new Response(null, { status: ready ? 200 : 404, headers: ready ? {} : { "X-Canvas-Asset-Error": "ASSET_OBJECT_MISSING" } });
        if (path === "/api/assets/cached/upload?repair=1") { repairs++; ready = true; return new Response(null, { status: 204 }); }
        throw new Error(`Unexpected ${path}`);
    }) as typeof fetch;
    expect(await uploadImageReference(reference, file, "cached-hash", "cache-repair-alice")).toBe("cached");
    ready = false;
    expect(await uploadImageReference(reference, file, "cached-hash", "cache-repair-alice")).toBe("cached");
    ready = false;
    expect(await uploadImageReference(reference, file, "cached-hash", "cache-repair-alice")).toBe("cached");
    expect(uploads).toBe(3); expect(repairs).toBe(2);
});

test.each([403, 404, 503])("HTTP %s without the exact missing-object signal never authorizes an upload", async status => {
    signIn(`uncertain-${status}`);
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
        const path = String(input); calls.push(`${init?.method || "GET"} ${path}`);
        return path.endsWith("/content") ? new Response(null, { status }) : Response.json({ asset: { id: "source", kind: "image", status: "ready" } });
    }) as typeof fetch;
    await expect(uploadImageReference({ ...reference, sourceAssetId: "source" }, file, "hash", `uncertain-${status}`)).rejects.toMatchObject({ code: "ASSET_STORAGE_UNAVAILABLE" });
    expect(calls).toEqual(["GET /api/assets/source", "HEAD /api/assets/source/content"]);
});

test("a storage timeout is not a missing object", async () => {
    globalThis.fetch = (async () => { throw new TypeError("timeout"); }) as typeof fetch;
    await expect(assertServerAssetContent("source")).rejects.toMatchObject({ code: "ASSET_STORAGE_UNAVAILABLE" });
});

test("missing local bytes and a proven missing object stop without any upload", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => { calls.push(`${init?.method || "GET"} ${input}`); return new Response(null, { status: 404, headers: { "X-Canvas-Asset-Error": "ASSET_OBJECT_MISSING" } }); }) as typeof fetch;
    await expect(readGenerationReferenceDataUrl({ ...reference, sourceAssetId: "source" })).rejects.toMatchObject({ code: "ASSET_OBJECT_MISSING" });
    expect(calls).toEqual(["HEAD /api/assets/source/content"]);
});

test("repair responses cannot redirect local original bytes to a different asset", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => { calls.push(`${init?.method || "GET"} ${input}`); return Response.json({ assetId: "different", uploadUrl: "/api/assets/different/upload" }); }) as typeof fetch;
    await expect(uploadServerAsset(file, {}, { repairAssetId: "source" })).rejects.toMatchObject({ code: "ASSET_OBJECT_MISSING" });
    expect(calls).toEqual(["POST /api/assets/upload-request"]);
});

test("server-selected hash repair verifies content after PUT even without an explicit repairAssetId", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
        const path = String(input); calls.push(`${init?.method || "GET"} ${path}`);
        if (path === "/api/assets/upload-request") return Response.json({ assetId: "reused", reused: true, uploadUrl: "/api/assets/reused/upload?repair=1" });
        if (path === "/api/assets/reused/upload?repair=1") return new Response(null, { status: 204 });
        return new Response(null, { status: 404, headers: { "X-Canvas-Asset-Error": "ASSET_OBJECT_MISSING" } });
    }) as typeof fetch;
    await expect(uploadServerAsset(file, { contentSha256: "hash" })).rejects.toMatchObject({ code: "ASSET_OBJECT_MISSING" });
    expect(calls).toEqual(["POST /api/assets/upload-request", "PUT /api/assets/reused/upload?repair=1", "HEAD /api/assets/reused/content"]);
});
