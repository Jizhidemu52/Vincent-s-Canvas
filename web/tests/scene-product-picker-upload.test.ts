import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { fingerprintImage } from "@/services/api/generation-history";
import { uploadImageReference } from "@/services/api/generation-tasks";
import { useUserStore } from "@/stores/use-user-store";
import type { SceneImage } from "@/pages/creative/use-scene-workspace";

const previousFetch = globalThis.fetch, previousUser = useUserStore.getState();
afterEach(() => { globalThis.fetch = previousFetch; useUserStore.setState(previousUser, true); });
const owner = "product-picker-owner", assetId = "a0000000-0000-4000-8000-000000000001";
const blob = new Blob([new Uint8Array([137, 80, 78, 71, 0, 255, 10, 44])], { type: "image/png" });
const source: SceneImage = { id: "source", sourceAssetId: assetId, name: "原件.png", dataUrl: `/api/assets/${assetId}/content`, storageKey: "image:source", type: "image/png", mimeType: "image/png", width: 2, height: 1, bytes: blob.size };
const ast = ts.createSourceFile("picker.tsx", readFileSync(new URL("../src/pages/creative/scene-product-picker.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let method = "";
const visit = (node: ts.Node) => { if (ts.isMethodDeclaration(node) && node.name.getText(ast) === "upload") method = node.getText(ast); ts.forEachChild(node, visit); };
visit(ast);
if (!method) throw new Error("Missing real product upload callback");
const code = ts.transpileModule(`const upload = ({ ${method} }).upload;`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

function setup(reference: SceneImage = source, image = blob, read?: () => void) {
    useUserStore.setState({ user: { ...previousUser.user, id: owner } as never, status: "authenticated" });
    const current = { current: "current-source" };
    const scope = { source: reference, ownerId: owner, key: current.current, current, MAX_SOURCE_BYTES: 10 * 1024 * 1024,
        getImageBlob: async () => { read?.(); return image; }, resolveImageUrl: async () => reference.dataUrl, uploadImageReference, fingerprintImage };
    const upload = new Function(...Object.keys(scope), `${code}\nreturn upload;`)(...Object.values(scope)) as (requestId: string, signal?: AbortSignal) => Promise<string>;
    return { upload, current };
}

for (const identity of ["asset-id", "canonical-url"] as const) test(`product recognition reuses ${identity} after ownership and original-content checks without an upload`, async () => {
    const h = setup(identity === "asset-id" ? source : { ...source, sourceAssetId: undefined });
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
        calls.push(`${init?.method || "GET"} ${input}`);
        if (String(input) === `/api/assets/${assetId}`) return Response.json({ asset: { id: assetId, ownerUserId: owner, kind: "image", status: "ready" } });
        if (String(input) === `/api/assets/${assetId}/content` && init?.method === "HEAD") return new Response(null, { status: 200 });
        throw new Error("Existing original must not be re-uploaded");
    }) as typeof fetch;
    expect(await h.upload("recognition-request:0")).toBe(assetId);
    expect(calls).toEqual([`GET /api/assets/${assetId}`, `HEAD /api/assets/${assetId}/content`]);
});

test("an unsaved original uses its byte fingerprint and remains unchanged before recognition", async () => {
    const h = setup({ ...source, sourceAssetId: undefined, dataUrl: "blob:original", storageKey: undefined });
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    let uploaded: Blob | undefined;
    globalThis.fetch = (async (input, init) => {
        const path = String(input); requests.push({ path, init });
        if (path === "blob:original") return new Response(blob);
        if (path === "/api/assets/upload-request") return Response.json({ assetId, uploadUrl: `/api/assets/${assetId}/upload` });
        if (path === `/api/assets/${assetId}/upload`) { uploaded = init?.body as Blob; return new Response(null, { status: 204 }); }
        if (path === `/api/assets/${assetId}/content`) return new Response(null, { status: 200 });
        throw new Error(`Unexpected ${path}`);
    }) as typeof fetch;
    expect(await h.upload("recognition-request:0")).toBe(assetId);
    const request = requests.find(item => item.path === "/api/assets/upload-request")!;
    expect(JSON.parse(String(request.init?.body))).toMatchObject({ byteSize: blob.size, metadata: { contentSha256: await fingerprintImage(blob) } });
    expect(new Headers(request.init?.headers).get("X-Canvas-Owner-Id")).toBe(owner);
    expect(new Uint8Array(await uploaded!.arrayBuffer())).toEqual(new Uint8Array(await blob.arrayBuffer()));
});

test("revoked source access cannot create a replacement original for recognition", async () => {
    const h = setup(), calls: string[] = [];
    globalThis.fetch = (async (input, init) => { calls.push(`${init?.method || "GET"} ${input}`); return Response.json({}, { status: 403 }); }) as typeof fetch;
    await expect(h.upload("recognition-request:0")).rejects.toThrow();
    expect(calls).toEqual([`GET /api/assets/${assetId}`]);
});

test("account changes while reading the original prevent all upload or reuse requests", async () => {
    const h = setup(source, blob, () => useUserStore.setState({ user: { ...previousUser.user, id: "different-owner" } as never }));
    const calls: string[] = [];
    globalThis.fetch = (async input => { calls.push(String(input)); throw new Error("No request expected"); }) as typeof fetch;
    await expect(h.upload("recognition-request:0")).rejects.toThrow("员工会话已变化");
    expect(calls).toEqual([]);
});

for (const boundary of ["source", "abort", "oversize"] as const) test(`${boundary} stops product source preparation before any network write`, async () => {
    const h = setup(source, boundary === "oversize" ? new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: "image/png" }) : blob);
    const controller = new AbortController(), calls: string[] = [];
    if (boundary === "source") h.current.current = "different-source";
    if (boundary === "abort") controller.abort();
    globalThis.fetch = (async input => { calls.push(String(input)); throw new Error("No request expected"); }) as typeof fetch;
    await expect(h.upload("recognition-request:0", controller.signal)).rejects.toThrow();
    expect(calls).toEqual([]);
});
