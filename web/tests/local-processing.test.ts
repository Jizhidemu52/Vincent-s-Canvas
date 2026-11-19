import { afterEach, beforeEach, expect, test } from "bun:test";
import { useUserStore, type LocalUser } from "@/stores/use-user-store";
import { deploymentFeatures } from "@/lib/deployment-features";
import { archiveLocalProcessing, compositeOperationId, listLocalProcessing, localProcessingBoard, type LocalProcessingArchive } from "@/services/api/local-processing";
import { fingerprintImage } from "@/services/api/generation-history";
import type { LocalProcessingRecord } from "../../shared/local-processing-contracts";

const owner = "00000000-0000-4000-8000-000000000099", asset = "10000000-0000-4000-8000-000000000001", source = "20000000-0000-4000-8000-000000000001";
const operation = "30000000-0000-4000-8000-000000000001";
const originalFetch = globalThis.fetch, originalState = useUserStore.getState(), features = { ...deploymentFeatures };
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 19]);
const file = new File([bytes], "最终成果.png", { type: "image/png" });
const input: LocalProcessingArchive = { board: "creative-pattern-colorway", operation: "recolor", clientOperationId: operation, prompt: "保留原尺寸与透明度，只替换指定颜色",
    parameters: { recolor: { rules: [{ from: "#112233", to: "#AABBCC" }], tolerance: 12 }, form: { description: "完整设计要求" }, config: { size: "auto" } }, sourceAssetIds: [source] };
const record = async (patch: Partial<LocalProcessingRecord> = {}): Promise<LocalProcessingRecord> => ({ ...input, version: 1, id: asset, ownerUserId: owner, outputAssetId: asset, sourceOutputAssetId: asset, sourceTaskId: null,
    createdAt: "2026-11-19T10:00:00.000Z", filename: file.name, mimeType: file.type, byteSize: file.size, contentSha256: await fingerprintImage(file),
    contentUrl: `/api/assets/${asset}/content`, thumbnailUrl: `/api/assets/${asset}/thumb?w=256`, previewUrl: `/api/assets/${asset}/thumb?w=1024`, ...patch });
beforeEach(() => { Object.assign(deploymentFeatures, { authenticationEnabled: true }); useUserStore.setState({ user: { id: owner, role: "designer", status: "active" } as LocalUser, status: "authenticated" }); });
afterEach(() => { globalThis.fetch = originalFetch; useUserStore.setState(originalState); Object.assign(deploymentFeatures, features); });

test("final archive uploads the exact bytes under a dedicated operation before committing metadata", async () => {
    const calls: string[] = [], saved = await record();
    globalThis.fetch = (async (url, init) => {
        const path = String(url); calls.push(`${init?.method || "GET"} ${path.split("?")[0]}`);
        expect(init?.headers).toMatchObject({ "X-Canvas-Owner-Id": owner });
        if (path.startsWith("/api/assets/local-processing?")) return Response.json({ records: [], nextCursor: null, hasMore: false });
        if (path === "/api/assets/upload-request") {
            const body = JSON.parse(String(init?.body));
            expect(body).toMatchObject({ localProcessingOperationId: operation, byteSize: file.size, mimeType: "image/png", metadata: { contentSha256: saved.contentSha256 } });
            expect(body).not.toHaveProperty("clientReferenceId");
            return Response.json({ assetId: asset, uploadUrl: `/api/assets/${asset}/upload` });
        }
        if (path.endsWith("/upload")) { expect(new Uint8Array(await (init?.body as Blob).arrayBuffer())).toEqual(bytes); return Response.json({}); }
        expect(JSON.parse(String(init?.body))).toEqual({ ...input, assetId: asset });
        return Response.json({ record: saved, reused: false }, { status: 201 });
    }) as typeof fetch;
    expect(await archiveLocalProcessing(file, input, owner)).toEqual(saved);
    expect(calls).toEqual(["GET /api/assets/local-processing", "POST /api/assets/upload-request", `PUT /api/assets/${asset}/upload`, "POST /api/assets/local-processing"]);
});

test("an uncertain previous acknowledgement is recovered read-only without duplicating upload or processing", async () => {
    const saved = await record(); let count = 0;
    globalThis.fetch = (async (url, init) => { count++; expect(String(url)).toContain(`clientOperationId=${operation}`); expect(init?.method).toBeUndefined(); return Response.json({ records: [saved], nextCursor: null, hasMore: false }); }) as typeof fetch;
    expect(await archiveLocalProcessing(file, input, owner)).toEqual(saved);
    expect(count).toBe(1);
});

test("the same operation cannot silently replace different bytes or parameters", async () => {
    const saved = await record(); let calls = 0;
    globalThis.fetch = (async (_url, init) => { calls++; expect(init?.method).toBeUndefined(); return Response.json({ records: [saved], nextCursor: null, hasMore: false }); }) as typeof fetch;
    await expect(archiveLocalProcessing(new File(["changed"], file.name, { type: file.type }), input, owner)).rejects.toThrow("其他内容");
    await expect(archiveLocalProcessing(file, { ...input, prompt: "不同要求" }, owner)).rejects.toThrow("其他内容");
    expect(calls).toBe(2);
});

test("history requires the current owner and rejects unsafe records and mismatched cursors", async () => {
    const saved = await record();
    for (const page of [
        { records: [{ ...saved, ownerUserId: "other" }], nextCursor: null, hasMore: false },
        { records: [{ ...saved, contentUrl: "https://outside.invalid/file" }], nextCursor: null, hasMore: false },
        { records: [saved], nextCursor: null, hasMore: true },
        { records: [{ ...saved, sourceAssetIds: ["not-an-id"] }], nextCursor: null, hasMore: false },
    ]) {
        globalThis.fetch = (async () => Response.json(page)) as typeof fetch;
        await expect(listLocalProcessing(input.board, owner)).rejects.toThrow("归属或分页信息异常");
    }
    globalThis.fetch = (async () => { throw new Error("must not fetch"); }) as typeof fetch;
    await expect(listLocalProcessing(input.board, "other")).rejects.toThrow("员工会话已变化");
});

test("account changes during the request or JSON body stop both reads and further writes", async () => {
    const saved = await record(); let writes = 0;
    globalThis.fetch = (async (_url, init) => {
        if (init?.method) writes++;
        return { ok: true, json: async () => { useUserStore.setState({ user: { ...useUserStore.getState().user!, id: "other" } }); return { records: [saved], nextCursor: null, hasMore: false }; } };
    }) as typeof fetch;
    await expect(archiveLocalProcessing(file, input, owner)).rejects.toThrow("员工会话已变化");
    expect(writes).toBe(0);
});

test("untrusted parameters fail before any final-image upload", async () => {
    let calls = 0; globalThis.fetch = (async () => { calls++; throw new Error("must not fetch"); }) as typeof fetch;
    for (const parameters of [{ config: { storageKey: "image:local" }, recolor: input.parameters.recolor }, { config: { apiKey: "private" }, recolor: input.parameters.recolor }, { config: { item: "data:image/png;base64,xxx" }, recolor: input.parameters.recolor }]) {
        await expect(archiveLocalProcessing(file, { ...input, parameters }, owner)).rejects.toThrow();
    }
    expect(calls).toBe(0);
});

test("only the two explicit boards have processing history and composite keys follow the exact task result", () => {
    expect(localProcessingBoard("creative-pattern-colorway")).toBe(input.board);
    expect(localProcessingBoard("creative-local-restyle")).toBe("creative-local-restyle");
    expect(localProcessingBoard("creative-text-to-style")).toBeNull();
    expect(compositeOperationId(source, asset)).toBe(compositeOperationId(source, asset));
    expect(compositeOperationId(source, asset)).not.toBe(compositeOperationId(asset, source));
    expect(compositeOperationId(source, asset)).toMatch(/^[\da-f-]{36}$/);
});
