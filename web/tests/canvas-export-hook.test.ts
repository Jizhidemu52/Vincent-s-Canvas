import { describe, expect, test } from "bun:test";
import { i18nHarness } from "./helpers/i18n-harness";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { create } from "zustand";

import { mapCanvasAsyncPool } from "@/lib/canvas/canvas-async-pool";
import { createCanvasProjectsArchive } from "@/lib/canvas/canvas-export";
import type { ZipOptions } from "@/lib/zip";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType } from "@/types/canvas";

const compile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
}).outputText;
const hookCode = compile("../src/hooks/use-canvas-export.ts");
const storeCode = compile("../src/stores/canvas/use-canvas-ui-store.ts");

function evaluate(code: string, dependencies: Record<string, unknown>) {
    const module = { exports: {} as Record<string, any> };
    new Function("require", "module", "exports", code)((name: string) => {
        if (name === "@/lib/i18n") return i18nHarness;
        if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency: ${name}`);
        return dependencies[name];
    }, module, module.exports);
    return module.exports;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function project(id: string, title = id): CanvasProject {
    return {
        id, title, createdAt: "2026-10-09", updatedAt: "2026-10-09", nodes: [], connections: [],
        chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: true,
        viewport: { x: 0, y: 0, k: 1 },
    };
}

type Notice = { key: string; type: "loading" | "success" | "error"; content: string; duration: number };
type ExportCall = { projects: CanvasProject[]; fileName: string; options: ZipOptions };
type ExportAction = (ids: string[], fileName: string, snapshots?: CanvasProject[]) => Promise<boolean>;

function harness(options: {
    load?: (id: string) => Promise<CanvasProject | null>;
    loadExporter?: () => Promise<void>;
    archive?: (call: ExportCall) => Promise<Blob>;
} = {}) {
    // A fresh real Zustand store runs the production lock implementation for each test.
    // Only React/message/download boundaries are replaced; no global module mocks leak.
    const { useCanvasUiStore } = evaluate(storeCode, { zustand: { create } });
    const loads: string[] = [];
    const exportCalls: ExportCall[] = [];
    const archives: Blob[] = [];
    const notices: Notice[] = [];
    const visibleNotices = new Map<string, Notice>();
    let exporterLoads = 0;
    const show = (notice: Notice) => {
        notices.push(notice);
        visibleNotices.set(notice.key, notice);
    };
    const message = {
        open: (notice: Notice) => show(notice),
        success: (notice: Omit<Notice, "type">) => show({ ...notice, type: "success" }),
        error: (notice: Omit<Notice, "type">) => show({ ...notice, type: "error" }),
    };
    const { useCanvasExport } = evaluate(hookCode, {
        react: { useCallback: (callback: ExportAction) => callback },
        antd: { App: { useApp: () => ({ message }) } },
        "@/stores/canvas/use-canvas-ui-store": { useCanvasUiStore },
        "@/stores/canvas/use-canvas-store": {
            loadCanvasProject: async (id: string) => {
                loads.push(id);
                return options.load ? options.load(id) : project(id);
            },
        },
        "@/lib/canvas/canvas-async-pool": { mapCanvasAsyncPool },
        "@/lib/canvas/canvas-export-loader": {
            loadCanvasExport: async () => {
                exporterLoads++;
                await options.loadExporter?.();
                return {
                    exportCanvasProjects: async (projects: CanvasProject[], fileName: string, zipOptions: ZipOptions) => {
                        const call = { projects, fileName, options: zipOptions };
                        exportCalls.push(call);
                        const archive = options.archive ? await options.archive(call) : await createCanvasProjectsArchive(projects, {
                            fetchBlob: async () => { throw new Error("Unexpected network access in export test"); },
                        }, zipOptions);
                        archives.push(archive);
                    },
                };
            },
        },
    });
    return {
        action: () => useCanvasExport() as ExportAction,
        state: () => useCanvasUiStore.getState() as { exportingProjectIds: string[]; beginExport: (ids: string[]) => boolean; endExport: () => void },
        loads, exportCalls, archives, notices, visibleNotices,
        exporterLoads: () => exporterLoads,
    };
}

describe("shared canvas archive export entry points", () => {
    test("simultaneous entry points share one lock and create exactly one archive", async () => {
        const loaded = deferred<CanvasProject>();
        const h = harness({ load: () => loaded.promise });
        const toolbar = h.action();
        const projectMenu = h.action();
        const batchMenu = h.action();
        const first = toolbar(["first"], "单份备份");
        expect(h.state().exportingProjectIds).toEqual(["first"]);
        expect(await projectMenu(["second"], "重复备份")).toBe(false);
        expect(await batchMenu(["first", "third"], "批量备份")).toBe(false);
        expect(h.loads).toEqual(["first"]);
        expect(h.notices).toHaveLength(1);
        expect(h.exportCalls).toHaveLength(0);

        loaded.resolve(project("first"));
        expect(await first).toBe(true);
        expect(h.exporterLoads()).toBe(1);
        expect(h.exportCalls).toHaveLength(1);
        expect(h.exportCalls[0].fileName).toBe("单份备份");
        expect(h.archives).toHaveLength(1);
        expect(h.archives[0].size).toBeGreaterThan(0);
        expect(h.state().exportingProjectIds).toEqual([]);
        expect(h.notices.filter(item => item.type === "success")).toHaveLength(1);
        expect([...h.visibleNotices.values()].some(item => item.type === "loading")).toBe(false);
    });

    test("the lock remains held while ZIP generation is pending and releases for a later export", async () => {
        const entered = deferred<void>();
        const finish = deferred<void>();
        const h = harness({ archive: async ({ projects, options }) => {
            entered.resolve();
            await finish.promise;
            return createCanvasProjectsArchive(projects, {}, options);
        } });
        const first = h.action()(["first"], "first");
        await entered.promise;
        expect(h.state().exportingProjectIds).toEqual(["first"]);
        expect(await h.action()(["second"], "second")).toBe(false);
        expect(h.exportCalls).toHaveLength(1);
        finish.resolve();
        expect(await first).toBe(true);
        expect(await h.action()(["second"], "second")).toBe(true);
        expect(h.exportCalls).toHaveLength(2);
        expect(h.archives).toHaveLength(2);
    });

    test("latest supplied snapshots bypass stored loading and retain caller order", async () => {
        const latest = project("editing", "尚未保存的最新标题");
        const other = project("other");
        const h = harness({ load: async id => {
            if (id !== "other") throw new Error("The current editor snapshot must not reload");
            return other;
        } });
        expect(await h.action()(["other", "editing"], "最新备份", [latest])).toBe(true);
        expect(h.loads).toEqual(["other"]);
        expect(h.exportCalls[0].projects).toEqual([other, latest]);
        expect(h.exportCalls[0].projects[1]).toBe(latest);
        expect(h.exportCalls[0].projects[1].title).toBe("尚未保存的最新标题");
    });

    test("a missing cloud document never creates an incomplete backup and can retry", async () => {
        const h = harness({ load: async id => id === "missing" ? null : project(id) });
        expect(await h.action()(["exists", "missing"], "invalid")).toBe(false);
        expect(h.exporterLoads()).toBe(0);
        expect(h.exportCalls).toHaveLength(0);
        expect(h.archives).toHaveLength(0);
        expect(h.notices.filter(item => item.type === "success")).toHaveLength(0);
        expect(h.notices.at(-1)?.content).toBe("画布已不存在，未生成不完整的备份");
        expect(h.state().exportingProjectIds).toEqual([]);
        expect([...h.visibleNotices.values()].some(item => item.type === "loading")).toBe(false);
        expect(await h.action()(["exists"], "retry")).toBe(true);
        expect(h.archives).toHaveLength(1);
    });

    test("a real cloud-media failure preserves its original error and releases the shared lock", async () => {
        const cloud = project("cloud");
        cloud.nodes = [{ id: "image", type: CanvasNodeType.Image, title: "original", position: { x: 0, y: 0 }, width: 400, height: 300,
            metadata: { content: "/api/assets/11111111-1111-4111-8111-111111111111/content" } }];
        let downloadFails = true;
        const h = harness({ archive: ({ projects, options }) => createCanvasProjectsArchive(projects, {
            fetchBlob: async () => {
                if (downloadFails) throw new Error("403 原始媒体访问已失效");
                return new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
            },
        }, options) });
        expect(await h.action()([cloud.id], "media", [cloud])).toBe(false);
        expect(h.archives).toHaveLength(0);
        expect(h.notices.filter(item => item.type === "success")).toHaveLength(0);
        expect(h.notices.at(-1)).toMatchObject({ type: "error", content: "403 原始媒体访问已失效", duration: 5 });
        expect(h.state().exportingProjectIds).toEqual([]);
        expect([...h.visibleNotices.values()].some(item => item.type === "loading")).toBe(false);
        downloadFails = false;
        expect(await h.action()([cloud.id], "retry", [cloud])).toBe(true);
        expect(h.archives).toHaveLength(1);
    });

    test("loader errors keep the original message and unknown errors use the safe fallback", async () => {
        for (const error of [new Error("备份模块加载失败"), "unexpected rejection"]) {
            const h = harness({ loadExporter: async () => { throw error; } });
            expect(await h.action()(["first"], "failed")).toBe(false);
            expect(h.notices.at(-1)?.content).toBe(error instanceof Error ? error.message : "画布导出失败，请重试。");
            expect(h.notices.filter(item => item.type === "success")).toHaveLength(0);
            expect(h.archives).toHaveLength(0);
            expect(h.state().exportingProjectIds).toEqual([]);
        }
    });

    test("progress reuses one message key and complete never leaves indefinite loading", async () => {
        const h = harness({ archive: async ({ options }) => {
            options.onProgress?.({ phase: "preparing", completed: 0, total: 0, label: "读取原始素材" });
            options.onProgress?.({ phase: "packing", completed: 2, total: 4, label: "压缩备份" });
            options.onProgress?.({ phase: "complete", completed: 4, total: 4, label: "内部完成事件" });
            return new Blob(["archive"]);
        } });
        expect(await h.action()(["first"], "progress")).toBe(true);
        expect(h.notices.map(item => item.content)).toEqual(["正在准备画布备份…", "读取原始素材", "压缩备份 (2/4)", "画布备份已生成"]);
        expect(new Set(h.notices.map(item => item.key)).size).toBe(1);
        expect(h.notices.at(-1)).toMatchObject({ type: "success", duration: 3 });
        expect(h.visibleNotices.size).toBe(1);
        expect([...h.visibleNotices.values()].some(item => item.type === "loading")).toBe(false);
        expect(h.state().exportingProjectIds).toEqual([]);
    });

    test("empty export requests neither acquire a lock nor show misleading feedback", async () => {
        const h = harness();
        expect(await h.action()([], "empty")).toBe(false);
        expect(h.state().exportingProjectIds).toEqual([]);
        expect(h.notices).toEqual([]);
        expect(h.loads).toEqual([]);
        expect(h.exporterLoads()).toBe(0);
        expect(h.archives).toEqual([]);
        expect(await h.action()(["valid"], "valid")).toBe(true);
    });
});
