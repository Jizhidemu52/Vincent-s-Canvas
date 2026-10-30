import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { Asset } from "../src/stores/use-asset-store";

function harness(local: Blob | null = null) {
    const files: { name: string; data: BlobPart }[] = [], saves: Blob[] = [];
    const deps: Record<string, unknown> = {
        "@/lib/i18n": { uiText: (value: string) => value },
        "file-saver": { saveAs: (blob: Blob) => saves.push(blob) },
        "@/lib/zip": { createZip: async (entries: typeof files) => { files.push(...entries); return new Blob(["zip"]); } },
        "@/lib/model-display": { exportModelMetadata: (value: unknown) => value },
        "@/services/file-storage": { getMediaBlob: async () => local },
        "@/services/image-storage": { getImageBlob: async () => local },
    };
    const source = readFileSync(new URL("../src/pages/assets/asset-transfer.ts", import.meta.url), "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: any = {};
    new Function("require", "exports", code)((name: string) => deps[name], exports);
    return { exportAssets: exports.exportAssets, files, saves };
}
const asset = (id: string, storageKey?: string) => ({ id, kind: "image", title: "作品", data: { dataUrl: "/api/assets/a/content", storageKey, mimeType: "image/png" } } as Asset);

test("export packages exact remote original bytes and records an importable storage key without mutating source", async () => {
    const h = harness(), original = new Blob([new Uint8Array([0, 255, 42, 1])], { type: "image/png" }), input = asset("remote");
    await h.exportAssets([input], { checkOwner() {}, readRemote: async () => original });
    expect(h.saves).toHaveLength(1);
    expect(h.files[1].data).toBe(original);
    const manifest = JSON.parse(String(h.files[0].data));
    expect(manifest.assets[0].data.storageKey).toBe("image:export-remote");
    expect(manifest.files[0].bytes).toBe(4);
    expect(input.kind === "image" && input.data.storageKey).toBeUndefined();
});

test("local bytes are preserved and absent originals abort instead of silently producing a partial ZIP", async () => {
    const original = new Blob(["original"], { type: "image/jpeg" }), h = harness(original);
    await h.exportAssets([asset("local", "image:local")]); expect(h.files[1].data).toBe(original);
    const missing = harness();
    await expect(missing.exportAssets([asset("missing", "image:missing")])).rejects.toThrow("原文件不可用");
    expect(missing.saves).toHaveLength(0);
});

test("account switches during original-file loading cannot trigger a download", async () => {
    const h = harness(); let same = true;
    await expect(h.exportAssets([asset("remote")], { checkOwner() { if (!same) throw new Error("owner changed"); }, readRemote: async () => { same = false; return new Blob(["secret"]); } })).rejects.toThrow("owner changed");
    expect(h.files).toHaveLength(0); expect(h.saves).toHaveLength(0);
});

test("remote text content comes from the original file and retains exact bytes plus importable content", async () => {
    const h = harness(), input = { id: "text-original", kind: "text", data: { content: "" } } as Asset;
    const original = new Blob([new Uint8Array([0xef, 0xbb, 0xbf]), "原始文本\r\n保留换行"], { type: "text/plain" });
    let reads = 0;
    await h.exportAssets([input], { checkOwner() {}, readRemote: async () => { reads++; return original; } });
    expect(reads).toBe(1); expect(h.files[1].data).toBe(original); expect(h.saves).toHaveLength(1);
    const manifest = JSON.parse(String(h.files[0].data));
    expect(manifest.assets[0].data.content).toBe("原始文本\r\n保留换行");
    expect(manifest.files[0].bytes).toBe(original.size);
    expect(input.kind === "text" && input.data.content).toBe("");
});

test("unavailable text originals and identity changes abort without a partial ZIP", async () => {
    const input = { id: "text-original", kind: "text", data: { content: "metadata is not the original" } } as Asset;
    const h = harness();
    await expect(h.exportAssets([input], { checkOwner() {}, readRemote: async () => { throw new Error("original unavailable"); } })).rejects.toThrow("original unavailable");
    expect(h.saves).toHaveLength(0); expect(h.files).toHaveLength(0);
    let same = true;
    await expect(h.exportAssets([input], { checkOwner() { if (!same) throw new Error("owner changed"); }, readRemote: async () => { same = false; return new Blob(["private"]); } })).rejects.toThrow("owner changed");
    expect(h.saves).toHaveLength(0);
});
