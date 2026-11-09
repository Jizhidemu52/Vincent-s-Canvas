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
        return Response.json({ asset: { id: String(input).split("/").at(-1), ownerUserId: useUserStore.getState().user!.id, status: "ready", kind: "image" } });
    }) as typeof fetch;
    signIn("dedupe-alice");
    expect(await Promise.all([1, 2, 3, 4].map(() => uploadImageReference(reference, file, "same-hash", "dedupe-alice")))).toEqual(["asset-1", "asset-1", "asset-1", "asset-1"]);
    expect(uploads).toBe(1);
    signIn("dedupe-bob");
    expect(await uploadImageReference(reference, file, "same-hash", "dedupe-bob")).toBe("asset-2");
    expect(uploads).toBe(2);
});

test("an employee-owned accessible source is reused directly and never uploaded", async () => {
    signIn("asset-alice");
    const calls: string[] = [];
    globalThis.fetch = (async input => { calls.push(String(input)); return Response.json({ asset: { id: "source", ownerUserId: "asset-alice", kind: "image", status: "ready" } }); }) as typeof fetch;
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
        if (path === "/api/assets/source") return Response.json({ asset: { id: "source", ownerUserId: "repair-alice", kind: "image", status: "ready" } });
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
        if (path === "/api/assets/cached") return Response.json({ asset: { id: "cached", ownerUserId: "cache-repair-alice", kind: "image", status: "ready" } });
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
        return path.endsWith("/content") ? new Response(null, { status }) : Response.json({ asset: { id: "source", ownerUserId: `uncertain-${status}`, kind: "image", status: "ready" } });
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

test("shared original bytes become one employee-owned copy, including concurrent slots", async () => {
    const owner = "shared-copy-alice";
    signIn(owner);
    let uploads = 0, sourceChecks = 0;
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
        const path = String(input); calls.push(`${init?.method || "GET"} ${path}`);
        if (path === "/api/assets/shared") return Response.json({ asset: { id: "shared", ownerUserId: "author", kind: "image", status: "ready" } });
        if (path === "/api/assets/shared/content") { expect(init?.method).toBe("HEAD"); sourceChecks++; return new Response(null, { status: 200 }); }
        if (path === "/api/assets/upload-request") {
            uploads++;
            expect(JSON.parse(String(init?.body))).toMatchObject({ filename: file.name, byteSize: file.size, mimeType: file.type, metadata: { contentSha256: "shared-hash" } });
            expect(JSON.parse(String(init?.body))).not.toHaveProperty("repairAssetId");
            expect(new Headers(init?.headers).get("X-Canvas-Owner-Id")).toBe(owner);
            return Response.json({ assetId: "own-copy", uploadUrl: "/api/assets/own-copy/upload" });
        }
        if (path === "/api/assets/own-copy/upload") {
            expect(init?.method).toBe("PUT");
            expect(init?.body).toBe(file);
            expect(await (init?.body as File).text()).toBe("same bytes");
            return new Response(null, { status: 204 });
        }
        if (path === "/api/assets/own-copy") return Response.json({ asset: { id: "own-copy", ownerUserId: owner, kind: "image", status: "ready" } });
        if (path === "/api/assets/own-copy/content") return new Response(null, { status: 200 });
        throw new Error(`Unexpected ${path}`);
    }) as typeof fetch;
    const shared = { ...reference, sourceAssetId: "shared" };
    expect(await Promise.all([1, 2, 3, 4].map(() => uploadImageReference(shared, file, "shared-hash", owner)))).toEqual(["own-copy", "own-copy", "own-copy", "own-copy"]);
    expect(uploads).toBe(1);
    expect(sourceChecks).toBe(8);
    expect(calls.filter(call => call.startsWith("PUT"))).toEqual(["PUT /api/assets/own-copy/upload"]);
    expect(calls.some(call => call.includes("thumb"))).toBe(false);
});

test.each([403, 404, 503, "missing-object"] as const)("shared source HEAD %s fails closed without copying or repairing the author's asset", async status => {
    const owner = `shared-fail-${status}`;
    signIn(owner);
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
        const path = String(input); calls.push(`${init?.method || "GET"} ${path}`);
        if (path === "/api/assets/shared") return Response.json({ asset: { id: "shared", ownerUserId: "author", kind: "image", status: "ready" } });
        if (path === "/api/assets/shared/content") return new Response(null, { status: status === "missing-object" ? 404 : status, headers: status === "missing-object" ? { "X-Canvas-Asset-Error": "ASSET_OBJECT_MISSING" } : {} });
        throw new Error(`Unexpected ${path}`);
    }) as typeof fetch;
    await expect(uploadImageReference({ ...reference, sourceAssetId: "shared" }, file, "hash", owner)).rejects.toMatchObject({ code: status === "missing-object" ? "ASSET_OBJECT_MISSING" : "ASSET_STORAGE_UNAVAILABLE" });
    expect(calls).toEqual(["GET /api/assets/shared", "HEAD /api/assets/shared/content"]);
});

test("a cached private copy never bypasses revoked shared-source access", async () => {
    const owner = "shared-revoked-cache";
    signIn(owner);
    let revoked = false, uploads = 0;
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
        const path = String(input); calls.push(`${init?.method || "GET"} ${path}`);
        if (path === "/api/assets/shared") return revoked ? Response.json({}, { status: 403 }) : Response.json({ asset: { id: "shared", ownerUserId: "author", kind: "image", status: "ready" } });
        if (path.endsWith("/content")) return new Response(null, { status: 200 });
        if (path === "/api/assets/upload-request") { uploads++; return Response.json({ assetId: "private", uploadUrl: null }); }
        if (path === "/api/assets/private") return Response.json({ asset: { id: "private", ownerUserId: owner, kind: "image", status: "ready" } });
        throw new Error(`Unexpected ${path}`);
    }) as typeof fetch;
    const shared = { ...reference, sourceAssetId: "shared" };
    expect(await uploadImageReference(shared, file, "hash", owner)).toBe("private");
    revoked = true; calls.length = 0;
    await expect(uploadImageReference(shared, file, "hash", owner)).rejects.toMatchObject({ status: 403 });
    expect(calls).toEqual(["GET /api/assets/shared"]);
    expect(uploads).toBe(1);
});

test.each(["upload", "cached-copy"] as const)("shared permission revoked during %s is checked again before returning an asset", async stage => {
    const owner = `shared-midflight-${stage}`;
    signIn(owner);
    let revokeDuringWork = false, revoked = false, uploads = 0;
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
        const path = String(input); calls.push(`${init?.method || "GET"} ${path}`);
        if (path === "/api/assets/shared") return Response.json({ asset: { id: "shared", ownerUserId: "author", kind: "image", status: "ready" } });
        if (path === "/api/assets/shared/content") return new Response(null, { status: revoked ? 403 : 200 });
        if (path === "/api/assets/upload-request") {
            uploads++; if (revokeDuringWork && stage === "upload") revoked = true;
            return Response.json({ assetId: "private", uploadUrl: null });
        }
        if (path === "/api/assets/private") {
            if (revokeDuringWork && stage === "cached-copy") revoked = true;
            return Response.json({ asset: { id: "private", ownerUserId: owner, kind: "image", status: "ready" } });
        }
        if (path === "/api/assets/private/content") return new Response(null, { status: 200 });
        throw new Error(`Unexpected ${path}`);
    }) as typeof fetch;
    const shared = { ...reference, sourceAssetId: "shared" };
    if (stage === "cached-copy") expect(await uploadImageReference(shared, file, "hash", owner)).toBe("private");
    revokeDuringWork = true; calls.length = 0;
    await expect(uploadImageReference(shared, file, "hash", owner)).rejects.toMatchObject({ code: "ASSET_STORAGE_UNAVAILABLE" });
    expect(calls.at(-1)).toBe("HEAD /api/assets/shared/content");
    expect(uploads).toBe(1);
});

test("a missing cached private copy is repaired under its own ID, never the shared source ID", async () => {
    const owner = "shared-private-repair";
    signIn(owner);
    let ready = true, uploads = 0;
    const repairIds: unknown[] = [];
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path === "/api/assets/shared") return Response.json({ asset: { id: "shared", ownerUserId: "author", kind: "image", status: "ready" } });
        if (path === "/api/assets/shared/content") return new Response(null, { status: 200 });
        if (path === "/api/assets/upload-request") {
            uploads++;
            const body = JSON.parse(String(init?.body)); repairIds.push(body.repairAssetId);
            return Response.json({ assetId: "private", reused: true, uploadUrl: body.repairAssetId ? "/api/assets/private/upload?repair=1" : null });
        }
        if (path === "/api/assets/private") return Response.json({ asset: { id: "private", ownerUserId: owner, kind: "image", status: "ready" } });
        if (path === "/api/assets/private/content") return new Response(null, { status: ready ? 200 : 404, headers: ready ? {} : { "X-Canvas-Asset-Error": "ASSET_OBJECT_MISSING" } });
        if (path === "/api/assets/private/upload?repair=1") { ready = true; return new Response(null, { status: 204 }); }
        throw new Error(`Unexpected ${path}`);
    }) as typeof fetch;
    const shared = { ...reference, sourceAssetId: "shared" };
    expect(await uploadImageReference(shared, file, "hash", owner)).toBe("private");
    ready = false;
    expect(await uploadImageReference(shared, file, "hash", owner)).toBe("private");
    expect(uploads).toBe(2); expect(repairIds).toEqual([undefined, "private"]);
});

test.each(["permission-revoked", "employee-switched"] as const)("concurrent callers waiting for a shared copy fail closed when %s", async change => {
    const owner = `shared-pending-${change}`;
    signIn(owner);
    let uploads = 0, sourceChecks = 0, revoked = false;
    let startUpload!: () => void, finishUpload!: () => void, secondSourceChecked!: () => void;
    const uploading = new Promise<void>(resolve => { startUpload = resolve; });
    const uploaded = new Promise<void>(resolve => { finishUpload = resolve; });
    const bothChecked = new Promise<void>(resolve => { secondSourceChecked = resolve; });
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path === "/api/assets/shared") return Response.json({ asset: { id: "shared", ownerUserId: "author", kind: "image", status: "ready" } });
        if (path === "/api/assets/shared/content") {
            if (++sourceChecks === 2) secondSourceChecked();
            return new Response(null, { status: revoked ? 403 : 200 });
        }
        if (path === "/api/assets/upload-request") { uploads++; return Response.json({ assetId: "private", uploadUrl: "/api/assets/private/upload" }); }
        if (path === "/api/assets/private/upload") { expect(init?.body).toBe(file); startUpload(); await uploaded; return new Response(null, { status: 204 }); }
        if (path === "/api/assets/private") return Response.json({ asset: { id: "private", ownerUserId: owner, kind: "image", status: "ready" } });
        if (path === "/api/assets/private/content") return new Response(null, { status: 200 });
        throw new Error(`Unexpected ${path}`);
    }) as typeof fetch;
    const shared = { ...reference, sourceAssetId: "shared" };
    const first = uploadImageReference(shared, file, "hash", owner);
    await uploading;
    const second = uploadImageReference(shared, file, "hash", owner);
    const outcomes = Promise.allSettled([first, second]);
    await bothChecked;
    if (change === "employee-switched") signIn("other-employee");
    else revoked = true;
    finishUpload();
    for (const outcome of await outcomes) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") {
            if (change === "permission-revoked") expect(outcome.reason).toMatchObject({ code: "ASSET_STORAGE_UNAVAILABLE" });
            else expect(outcome.reason.message).toBe("员工会话已变化");
        }
    }
    expect(uploads).toBe(1);
});

test("cached destinations with another owner fail instead of being reused or repaired", async () => {
    const owner = "foreign-cache-destination";
    signIn(owner);
    let uploads = 0;
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
        const path = String(input); calls.push(`${init?.method || "GET"} ${path}`);
        if (path === "/api/assets/upload-request") { uploads++; return Response.json({ assetId: "private", uploadUrl: null }); }
        if (path === "/api/assets/private/content") return new Response(null, { status: 200 });
        if (path === "/api/assets/private") return Response.json({ asset: { id: "private", ownerUserId: "someone-else", kind: "image", status: "ready" } });
        throw new Error(`Unexpected ${path}`);
    }) as typeof fetch;
    expect(await uploadImageReference(reference, file, "hash", owner)).toBe("private");
    calls.length = 0;
    await expect(uploadImageReference(reference, file, "hash", owner)).rejects.toThrow("原参考图不可用");
    expect(calls).toEqual(["GET /api/assets/private"]); expect(uploads).toBe(1);
});

test.each(["source-read", "source-head", "upload", "final-check"] as const)("account switching during shared %s cannot return a usable task source", async stage => {
    const owner = `shared-owner-switch-${stage}`;
    signIn(owner);
    let sourceChecks = 0, uploads = 0;
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path === "/api/assets/shared") {
            if (stage === "source-read") signIn("other-employee");
            return Response.json({ asset: { id: "shared", ownerUserId: "author", kind: "image", status: "ready" } });
        }
        if (path === "/api/assets/shared/content") {
            sourceChecks++;
            if (stage === "source-head" || stage === "final-check" && sourceChecks === 2) signIn("other-employee");
            return new Response(null, { status: 200 });
        }
        if (path === "/api/assets/upload-request") {
            uploads++; expect(new Headers(init?.headers).get("X-Canvas-Owner-Id")).toBe(owner);
            if (stage === "upload") signIn("other-employee");
            return Response.json({ assetId: "private", uploadUrl: null });
        }
        if (path === "/api/assets/private/content") return new Response(null, { status: 200 });
        throw new Error(`Unexpected ${path}`);
    }) as typeof fetch;
    await expect(uploadImageReference({ ...reference, sourceAssetId: "shared" }, file, "hash", owner)).rejects.toThrow("员工会话已变化");
    expect(uploads).toBe(stage === "source-read" || stage === "source-head" ? 0 : 1);
});

test("missing owner metadata never authorizes source reuse or repair", async () => {
    signIn("missing-owner-metadata");
    const calls: string[] = [];
    globalThis.fetch = (async input => { calls.push(String(input)); return Response.json({ asset: { id: "source", kind: "image", status: "ready" } }); }) as typeof fetch;
    await expect(uploadImageReference({ ...reference, sourceAssetId: "source" }, file, "hash", "missing-owner-metadata")).rejects.toThrow("原参考图不可用");
    expect(calls).toEqual(["/api/assets/source"]);
});
