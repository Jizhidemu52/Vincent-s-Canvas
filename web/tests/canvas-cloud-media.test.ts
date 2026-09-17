import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { portableCanvasMedia } from "@/lib/canvas/canvas-portable-media";

const source = readFileSync(new URL("../src/services/canvas-cloud-media.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("cloud-media.ts", source, ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(ast.statements.filter(item => !ts.isImportDeclaration(item)).map(item => item.getText(ast)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText;
const original = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 250, 17]);
const assetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function setup(existingSource?: string) {
    const stored = new Map<string, string>();
    const calls: Array<{ bytes: Uint8Array; options: any }> = [];
    const bindings = {
        portableCanvasMedia,
        getImageBlob: async () => new Blob([original], { type: "image/png" }), getMediaBlob: async () => null,
        readMediaSource: async () => existingSource,
        readUploadedMedia: async (owner: string, key: string) => stored.get(`${owner}/${key}`),
        rememberUploadedMedia: async (owner: string, key: string, url: string) => { stored.set(`${owner}/${key}`, url); },
        serverMediaId: (url: string) => url.match(/^\/api\/assets\/([0-9a-f-]{36})\/content$/i)?.[1] || "",
        uploadServerAsset: async (file: File, _metadata: unknown, options: unknown) => { calls.push({ bytes: new Uint8Array(await file.arrayBuffer()), options }); return assetId; },
        fetch: async () => { throw new Error("must read IndexedDB bytes, not expired blob URL"); },
    };
    const exported: any = {};
    new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exported);
    return { ...exported, calls };
}
test("a generated image retaining a server source is reused, not uploaded again", async () => {
    const target = `/api/assets/${assetId}/content`;
    const io = setup(target);
    expect(await io.ensureCloudMedia("employee-a", { storageKey: "image:generated", url: "blob:expired" })).toBe(target);
    expect(io.calls).toHaveLength(0);
});
test("cloud sync reads original persisted bytes after reload, deduplicates parallel consumers and guards the owner", async () => {
    const io = setup();
    const input = { storageKey: "image:original", url: "blob:expired" };
    const [a, b] = await Promise.all([io.ensureCloudMedia("employee-a", input), io.ensureCloudMedia("employee-a", input)]);
    expect(a).toBe(b);
    expect(io.calls).toHaveLength(1);
    expect(io.calls[0].bytes).toEqual(original);
    expect(io.calls[0].options).toEqual({ expectedOwnerId: "employee-a", clientReferenceId: "canvas:image:original" });
    expect(await io.ensureCloudMedia("employee-a", input)).toBe(a);
    expect(io.calls).toHaveLength(1);
});
test("uploaded-media caches are scoped to employee identity", async () => {
    const io = setup();
    await io.ensureCloudMedia("employee-a", { storageKey: "image:original", url: "blob:expired" });
    await io.ensureCloudMedia("employee-b", { storageKey: "image:original", url: "blob:expired" });
    expect(io.calls.map((call: any) => call.options.expectedOwnerId)).toEqual(["employee-a", "employee-b"]);
});
