import { i18nHarness } from "./helpers/i18n-harness";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { placeCanvasImageOutputs } from "@/lib/canvas/canvas-image-output-placement";
import { CanvasNodeType } from "@/types/canvas";
import type * as ReuseHelper from "../src/lib/canvas/canvas-design-library-reuse";
import type { DesignLibraryEntry } from "@/types/design-library";

const code = ts.transpileModule(readFileSync(new URL("../src/lib/canvas/canvas-design-library-reuse.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
}).outputText;
const entry: DesignLibraryEntry = {
    id: "entry-1", title: "蓝色织物", thought: "仅详情阅读", prompt: "do not silently import prompts", tags: [],
    author: { id: "author", name: "设计师甲", departmentId: "design", departmentName: "设计部" }, status: "published",
    createdAt: "2026-10-09", updatedAt: "2026-10-09", canWithdraw: false, canModerate: false, canViewStats: false,
    images: [{ id: "image-1", filename: "pattern.png", width: 2000, height: 1000, mimeType: "image/png", byteSize: 7, contentUrl: "/api/design-library/entry-1/images/image-1/content" }],
};
const original = new Blob([new Uint8Array([137, 80, 78, 71, 0, 255, 10])], { type: "image/png" });
function baseProject() {
    return {
        id: "existing", title: "已有画布", nodes: [{ id: "existing-node", type: "image", title: "旧图", position: { x: 200, y: 100 }, width: 640, height: 320, metadata: { prompt: "private", custom: "preserve" } }],
        groups: [{ id: "group-1", nodeIds: ["existing-node"] }], connections: [{ id: "edge-1", fromNodeId: "existing-node", toNodeId: "other" }],
        history: { past: [{ nodes: [], connections: [] }], future: [] }, chatSessions: [{ id: "private-chat", messages: ["private"] }],
        viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "grid", showImageInfo: true, activeChatId: "private-chat",
    };
}

function harness(options: { failCopy?: boolean; failRead?: boolean; failUpload?: boolean; failFlush?: boolean; failReceipt?: boolean; excludedReceipt?: boolean; onLoad?: () => void; onCopy?: () => void; onUpload?: () => void; onFlush?: () => void; onReceipt?: () => void } = {}) {
    let owner = "employee-1", id = 0;
    const projects: any[] = [baseProject()];
    const steps: string[] = [], uploaded: Blob[] = [], mappings: unknown[] = [], receipts: any[] = [], copyCalls: any[] = [], patches: any[] = [];
    const state = {
        hydrated: true, projects,
        openProject: (projectId: string) => projects.find(project => project.id === projectId) || null,
        createProject: (title: string) => { steps.push("create"); const project = { ...baseProject(), id: "new-project", title, nodes: [], groups: [], connections: [], history: undefined, chatSessions: [] }; projects.push(project); return project.id; },
        updateProject: (projectId: string, patch: unknown) => { steps.push("append"); patches.push(patch); const index = projects.findIndex(project => project.id === projectId); projects[index] = { ...projects[index], ...patch as object }; },
    };
    const dependencies: Record<string, unknown> = {
        nanoid: { nanoid: () => `node-${++id}` }, "@/lib/client-id": { createClientId: () => "request-1" },
        "@/lib/canvas/canvas-node-size": { fitNodeSize }, "@/lib/canvas/canvas-image-output-placement": { placeCanvasImageOutputs },
        "@/types/canvas": { CanvasNodeType },
        "@/services/api/design-library": {
            requireDesignLibraryOwner: (_admin = false, expected?: string) => { if (!owner || (expected && owner !== expected)) throw new Error("员工会话已变化"); return owner; },
            reuseDesignLibraryImage: async (...args: unknown[]) => {
                steps.push("copy"); copyCalls.push(args); options.onCopy?.(); if (options.failCopy) throw new Error("copy failed");
                return { assetId: "owned-asset", image: entry.images[0], source: { entryId: entry.id, imageId: entry.images[0].id, title: entry.title, authorName: entry.author.name } };
            },
            fetchDesignLibraryReusedImage: async () => { steps.push("read"); if (options.failRead) throw new Error("read failed"); return original; },
            recordDesignLibraryEvent: async (...args: unknown[]) => { steps.push("receipt"); receipts.push(args); options.onReceipt?.(); if (options.failReceipt) throw new Error("receipt failed"); return { recorded: !options.excludedReceipt }; },
        },
        "@/services/image-storage": { uploadImage: async (blob: Blob) => { steps.push("upload"); options.onUpload?.(); if (options.failUpload) throw new Error("storage failed"); uploaded.push(blob); return { storageKey: "image:local-copy", url: "blob:local-copy", width: 2000, height: 1000, bytes: blob.size, mimeType: blob.type }; } },
        "@/services/canvas-media-links": { rememberMediaSource: async (...args: unknown[]) => { steps.push("mapping"); mappings.push(args); } },
        "@/stores/canvas/use-canvas-store": {
            useCanvasStore: { getState: () => state },
            loadCanvasProject: async (projectId: string) => { steps.push("load"); options.onLoad?.(); return state.openProject(projectId); },
            flushCanvasPersistence: async () => { steps.push("flush"); options.onFlush?.(); if (options.failFlush) throw new Error("disk unavailable"); },
        },
    };
    const module = { exports: {} as typeof ReuseHelper };
    new Function("require", "module", "exports", code)((id: string) => id === "@/lib/i18n" ? i18nHarness : ((name: string) => dependencies[name])(id), module, module.exports);
    return { ...module.exports, run: (target: string | undefined = "existing") => module.exports.addDesignLibraryImageToCanvas(entry, entry.images[0], target), state, steps, uploaded, mappings, receipts, copyCalls, patches, setOwner: (next: string) => { owner = next; } };
}

test("reuse preserves original bytes and existing graph/history/private metadata, then records only after durable save", async () => {
    const h = harness(); const before = h.state.projects[0];
    expect(await h.run()).toEqual({ projectId: "existing", trackingRecorded: true });
    const project = h.state.projects[0], node = project.nodes[1];
    expect(h.uploaded[0]).toBe(original); expect(h.mappings).toEqual([["image:local-copy", "/api/assets/owned-asset/content"]]);
    for (const field of ["history", "connections", "groups", "chatSessions", "viewport"]) expect(project[field]).toBe(before[field]);
    expect(project.nodes[0]).toBe(before.nodes[0]); expect(Object.keys(h.patches[0])).toEqual(["nodes"]);
    expect(node.width / node.height).toBe(2); expect(node.position.y).toBeGreaterThan(420);
    expect(node.metadata).toMatchObject({ content: "blob:local-copy", storageKey: "image:local-copy", bytes: original.size, naturalWidth: 2000, naturalHeight: 1000 });
    expect(node.metadata.prompt).toBeUndefined();
    expect(node.metadata.designLibrarySource).toEqual({ entryId: entry.id, imageId: "image-1", title: entry.title, authorName: "设计师甲", assetId: "owned-asset" });
    expect(h.steps).toEqual(["load", "copy", "read", "upload", "mapping", "append", "flush", "receipt"]);
    expect(h.copyCalls[0]).toEqual(["entry-1", "image-1", "request-1", { expectedOwnerId: "employee-1" }]);
    expect(h.receipts[0]).toEqual(["entry-1", { action: "reuse", imageId: "image-1", requestId: "request-1", reusedAssetId: "owned-asset" }, { expectedOwnerId: "employee-1" }]);
});

test("a new canvas is created only after the original image and its independent asset mapping are saved", async () => {
    const h = harness();
    expect(await h.addDesignLibraryImageToCanvas(entry, entry.images[0])).toEqual({ projectId: "new-project", trackingRecorded: true });
    expect(h.steps).toEqual(["copy", "read", "upload", "mapping", "create", "append", "flush", "receipt"]);
    expect(h.state.projects[1].nodes).toHaveLength(1);
});

test("lazy loading is awaited and concurrent edits made while bytes are copied are retained", async () => {
    const h = harness({ onLoad: () => { h.state.projects[0].nodes.push({ id: "lazy-full-content", position: { x: 2000, y: 2000 }, width: 100, height: 100 }); }, onCopy: () => { h.state.projects[0] = { ...h.state.projects[0], nodes: [...h.state.projects[0].nodes, { id: "concurrent", position: { x: 1000, y: 1000 }, width: 100, height: 100 }], title: "并发改名" }; } });
    await h.run();
    expect(h.state.projects[0].nodes.map((node: any) => node.id)).toEqual(["existing-node", "lazy-full-content", "concurrent", "node-1"]);
    expect(h.state.projects[0].title).toBe("并发改名");
});

test("deleted target or unhydrated workspace cannot create replacement canvases or receipts", async () => {
    const absent = harness(); await expect(absent.run("missing")).rejects.toThrow("不存在"); expect(absent.steps).toEqual(["load"]);
    const deleted = harness({ onUpload: () => { deleted.state.projects.splice(0); } });
    await expect(deleted.run()).rejects.toThrow("已被删除"); expect(deleted.patches).toHaveLength(0); expect(deleted.receipts).toHaveLength(0);
    const unready = harness(); unready.state.hydrated = false;
    await expect(unready.run()).rejects.toThrow("仍在加载"); expect(unready.steps).toHaveLength(0);
});

test("failed copying, byte reads, and media writes never modify a canvas or increment usage", async () => {
    for (const option of ["failCopy", "failRead", "failUpload"] as const) {
        const h = harness({ [option]: true });
        await expect(h.run()).rejects.toThrow(); expect(h.patches).toHaveLength(0); expect(h.receipts).toHaveLength(0);
    }
});

test("failed canvas persistence retains recoverable work with an explicit project id and no usage receipt", async () => {
    const h = harness({ failFlush: true });
    const error = await h.run().catch(error => error);
    expect(error).toBeInstanceOf(h.DesignLibraryCanvasPersistenceError); expect(error.projectId).toBe("existing"); expect(error.message).toContain("勿重复添加");
    expect(h.state.projects[0].nodes).toHaveLength(2); expect(h.receipts).toHaveLength(0);
});

test("receipt failure does not turn a saved canvas into a failed action; excluded receipts are successful acknowledgements", async () => {
    const failed = harness({ failReceipt: true });
    expect(await failed.run()).toEqual({ projectId: "existing", trackingRecorded: false }); expect(failed.state.projects[0].nodes).toHaveLength(2);
    expect(await harness({ excludedReceipt: true }).run()).toEqual({ projectId: "existing", trackingRecorded: true });
});

test("owner changes at asynchronous boundaries never patch a new identity or return a stale project for navigation", async () => {
    for (const point of ["onCopy", "onUpload", "onFlush", "onReceipt"] as const) {
        const h = harness({ [point]: () => h.setOwner("employee-2") });
        await expect(h.run()).rejects.toThrow("员工会话");
        if (point === "onCopy" || point === "onUpload") expect(h.patches).toHaveLength(0);
        if (point !== "onReceipt") expect(h.receipts).toHaveLength(0);
    }
});

test("deleting the node or canvas before flush completes prevents a success receipt", async () => {
    const h = harness({ onFlush: () => { h.state.projects.splice(0); } });
    await expect(h.run()).rejects.toThrow("未记录复用成功"); expect(h.receipts).toHaveLength(0);
});
