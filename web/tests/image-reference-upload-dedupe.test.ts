import { afterEach, expect, test } from "bun:test";
import { uploadImageReference } from "../src/services/api/generation-tasks";
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
    expect(calls).toEqual(["/api/assets/source"]);
});

test("revoked source access is reported rather than silently re-uploading a private copy", async () => {
    signIn("revoked-alice");
    const calls: string[] = [];
    globalThis.fetch = (async input => { calls.push(String(input)); return Response.json({}, { status: 403 }); }) as typeof fetch;
    await expect(uploadImageReference({ ...reference, sourceAssetId: "revoked" }, file, "hash", "revoked-alice")).rejects.toThrow();
    expect(calls).toEqual(["/api/assets/revoked"]);
});
