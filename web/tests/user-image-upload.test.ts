import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type { UserUploadedImage } from "@/services/user-image-upload";

const source = readFileSync(new URL("../src/services/user-image-upload.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("upload.ts", source, ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(ast.statements.filter(item => !ts.isImportDeclaration(item)).map(item => item.getText(ast)).join("\n"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
const assetId = "d0000000-0000-4000-8000-000000000001";
const serverUrl = `/api/assets/${assetId}/content`;
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 3, 4]);
const file = new File([bytes], "原始图片.png", { type: "image/png" });

function setup(options: { trial?: boolean; cacheFails?: boolean; mappingFails?: boolean; uploadFails?: boolean; afterUpload?: () => void } = {}) {
    let owner = "employee-a";
    const calls: string[] = [], requests: Array<{ file: File; metadata: Record<string, unknown>; options: Record<string, unknown> }> = [];
    const mappings: string[][] = [];
    const bindings = {
        sha256, bytesToHex,
        deploymentFeatures: { authenticationEnabled: !options.trial },
        useUserStore: { getState: () => ({ status: "authenticated", user: { id: owner, status: "active" } }) },
        URL: { createObjectURL: () => "blob:validate", revokeObjectURL: () => calls.push("revoke") },
        readImageMeta: async () => { calls.push("validate"); return { width: 16, height: 8, mimeType: "image/png" }; },
        uploadServerAsset: async (input: File, metadata: Record<string, unknown>, uploadOptions: Record<string, unknown>) => {
            calls.push("server"); requests.push({ file: input, metadata, options: uploadOptions });
            if (options.uploadFails) throw new Error("云端上传失败");
            options.afterUpload?.();
            return assetId;
        },
        uploadImage: async () => { calls.push("cache"); if (options.cacheFails) throw new Error("QuotaExceededError"); return { url: "blob:cache", storageKey: "image:local", width: 16, height: 8, mimeType: "image/png", bytes: bytes.length }; },
        rememberMediaSource: async (key: string, url: string) => { calls.push("source"); if (options.mappingFails) throw new Error("QuotaExceededError"); mappings.push([key, url]); },
        rememberUploadedMedia: async (user: string, key: string, url: string) => { calls.push("mapping"); mappings.push([user, key, url]); },
        serverMediaId: (url: string) => url === serverUrl ? assetId : "",
    };
    const exported: { uploadUserImage?: (input: Blob, options: Record<string, unknown>) => Promise<UserUploadedImage> } = {};
    new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exported);
    return { upload: exported.uploadUserImage!, calls, requests, mappings, setOwner: (id: string) => { owner = id; } };
}

test("explicit image import saves exact original bytes before caching and binds both cloud mappings", async () => {
    const io = setup();
    const result = await io.upload(file, { source: "test-upload", ownerId: "employee-a" });
    expect(io.calls).toEqual(["validate", "revoke", "server", "cache", "source", "mapping"]);
    expect(new Uint8Array(await io.requests[0]!.file.arrayBuffer())).toEqual(bytes);
    const hash = bytesToHex(sha256(bytes));
    expect(io.requests[0]!.metadata).toMatchObject({ contentSha256: hash, title: file.name, naturalWidth: 16, naturalHeight: 8 });
    expect(io.requests[0]!.options).toMatchObject({ expectedOwnerId: "employee-a", clientReferenceId: `user-image:${hash}` });
    expect(result).toMatchObject({ url: serverUrl, sourceAssetId: assetId, storageKey: "image:local", bytes: bytes.length });
    expect(io.mappings).toEqual([["image:local", serverUrl], ["employee-a", "image:local", serverUrl]]);
});

test.each(["cacheFails", "mappingFails"] as const)("%s keeps the successful server original usable without an unsafe local key", async failure => {
    const io = setup({ [failure]: true });
    const result = await io.upload(file, { source: "test-upload" });
    expect(result).toMatchObject({ url: serverUrl, sourceAssetId: assetId, storageKey: "", bytes: file.size, width: 16, height: 8 });
    expect(io.requests).toHaveLength(1);
});

test("a failed server write never reports local-only import success", async () => {
    const io = setup({ uploadFails: true });
    await expect(io.upload(file, { source: "test-upload" })).rejects.toThrow("云端上传失败");
    expect(io.calls).not.toContain("cache");
    expect(io.mappings).toEqual([]);
});

test("changing employee after upload cannot return or cache another employee's original", async () => {
    const io = setup({ afterUpload: () => io.setOwner("employee-b") });
    await expect(io.upload(file, { source: "test-upload", ownerId: "employee-a" })).rejects.toThrow("员工会话已变化");
    expect(io.requests[0]!.options.expectedOwnerId).toBe("employee-a");
    expect(io.calls).not.toContain("cache");
    expect(io.mappings).toEqual([]);
});

test("an obsolete upload owner is rejected before any file or network work", async () => {
    const io = setup();
    await expect(io.upload(file, { source: "test-upload", ownerId: "employee-b" })).rejects.toThrow("员工会话已变化");
    expect(io.calls).toEqual([]);
});

test("input-specific pixel validation runs before upload", async () => {
    const io = setup();
    await expect(io.upload(file, { source: "markup", validate: () => { throw new Error("尺寸超限"); } })).rejects.toThrow("尺寸超限");
    expect(io.requests).toEqual([]);
});

test("local trial import remains local and does not create server assets", async () => {
    const io = setup({ trial: true });
    expect(await io.upload(file, { source: "trial" })).toMatchObject({ url: "blob:cache", storageKey: "image:local" });
    expect(io.requests).toEqual([]);
});

test("abort after cloud upload keeps the original but never inserts it into the current view", async () => {
    const controller = new AbortController();
    const io = setup({ afterUpload: () => controller.abort() });
    await expect(io.upload(file, { source: "test-upload", signal: controller.signal })).rejects.toHaveProperty("name", "AbortError");
    expect(io.requests).toHaveLength(1);
    expect(io.calls).not.toContain("cache");
});
