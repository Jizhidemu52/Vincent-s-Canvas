import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { restoreCanvasExportMedia } from "@/lib/canvas/canvas-export-media";
import { mapCanvasAsyncPool } from "@/lib/canvas/canvas-async-pool";
import { decodeCanvasProject } from "@/lib/canvas/canvas-project-codec";

const code = ts.transpileModule(readFileSync(new URL("../src/pages/canvas/import-canvas.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
}).outputText;
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 0, 255]);
function harness(options: { corrupt?: boolean; missing?: boolean; rejectMedia?: Error; slowSecond?: Promise<void>; failFlush?: boolean; fileCount?: number; writeGate?: Promise<void>; onWrite?: () => void } = {}) {
    const files = Array.from({ length: options.fileCount || 2 }, (_, i) => ["image:first", "image:second"][i] || `image:extra-${i}`).map(storageKey => ({ storageKey, path: `${storageKey}.png`, mimeType: "image/png", bytes: bytes.length }));
    const manifest = { app: "wireless-canvas", version: 3, projects: [{ project: { nodes: [{ type: "image", metadata: { storageKey: "image:first", content: "canvas-archive:image:first" } }], connections: [] }, files }] };
    const zip = new Map<string, Blob>([["projects.json", new Blob([options.corrupt ? "not json" : JSON.stringify(manifest)])], ...files.map(file => [file.path, new Blob([bytes])] as [string, Blob])]);
    if (options.missing) zip.delete(files[1].path);
    const writes: { key: string; blob: Blob }[] = [], projects: any[] = [];
    let flushed = false, active = 0, peak = 0;
    const dependencies: Record<string, unknown> = {
        "@/lib/zip": { readZip: async () => zip },
        "@/lib/canvas/canvas-export-media": { restoreCanvasExportMedia },
        "@/lib/canvas/canvas-async-pool": { mapCanvasAsyncPool },
        "@/lib/canvas/canvas-project-codec": { decodeCanvasProject },
        "@/services/image-storage": { setImageBlob: async (key: string, blob: Blob) => {
            active++; peak = Math.max(peak, active); options.onWrite?.();
            try {
                await options.writeGate;
                if (key === "image:second") await options.slowSecond;
                if (key === "image:first" && options.rejectMedia) throw options.rejectMedia;
                writes.push({ key, blob }); return `blob:${key}`;
            } finally { active--; }
        } },
        "@/services/file-storage": { setMediaBlob: async () => { throw new Error("unexpected non-image"); } },
        "@/stores/canvas/use-canvas-store": {
            useCanvasStore: { getState: () => ({ importProject: (project: unknown) => { projects.push(project); } }) },
            flushCanvasPersistence: async () => { if (options.failFlush) throw new Error("disk unavailable"); flushed = true; },
        },
    };
    const module = { exports: {} as { importCanvasArchive: (file: Blob) => Promise<number> } };
    new Function("require", "module", "exports", code)((name: string) => dependencies[name], module, module.exports);
    return { run: () => module.exports.importCanvasArchive(new Blob()), writes, projects, flushed: () => flushed, peak: () => peak };
}

test("import restores references and original bytes, then waits for durable project persistence", async () => {
    const h = harness(); expect(await h.run()).toBe(1);
    expect(h.flushed()).toBe(true); expect(h.writes).toHaveLength(2);
    for (const write of h.writes) { expect(write.blob.type).toBe("image/png"); expect(new Uint8Array(await write.blob.arrayBuffer())).toEqual(bytes); }
    expect(h.projects[0].nodes[0].metadata.content).toBe("blob:image:first");
});

test("invalid manifests and missing files fail before any media write", async () => {
    for (const options of [{ corrupt: true }, { missing: true }]) {
        const h = harness(options);
        await expect(h.run()).rejects.toThrow("无法读取画布备份");
        expect(h.writes).toHaveLength(0); expect(h.projects).toHaveLength(0);
    }
});

test("storage failure is not reported as a malformed archive, and all other writes settle before retry", async () => {
    const gate = Promise.withResolvers<void>();
    const h = harness({ rejectMedia: new Error("database connection is closing"), slowSecond: gate.promise });
    let settled = false;
    const result = h.run().catch(error => error).finally(() => { settled = true; });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(settled).toBe(false); gate.resolve();
    const error = await result as Error;
    expect(error.message).toContain("媒体写入本机失败");
    expect(error.cause).toBeInstanceOf(Error); expect(h.projects).toHaveLength(0);
});

test("quota errors give storage-specific guidance", async () => {
    const error = new Error("quota"); error.name = "QuotaExceededError";
    await expect(harness({ rejectMedia: error }).run()).rejects.toThrow("存储空间不足");
});

test("large archives keep media writes bounded while still importing every file", async () => {
    const release = Promise.withResolvers<void>(), firstBatch = Promise.withResolvers<void>();
    let started = 0;
    const h = harness({ fileCount: 71, writeGate: release.promise, onWrite: () => { if (++started === 4) firstBatch.resolve(); } });
    const importing = h.run();
    await firstBatch.promise;
    expect(started).toBe(4); expect(h.peak()).toBe(4);
    release.resolve();
    expect(await importing).toBe(1); expect(h.writes).toHaveLength(71); expect(h.peak()).toBeLessThanOrEqual(4);
});

test("a failed final flush never reports successful import and retains the loaded project", async () => {
    const h = harness({ failFlush: true });
    await expect(h.run()).rejects.toThrow("请保留当前页面");
    expect(h.projects).toHaveLength(1); expect(h.flushed()).toBe(false);
});
