import localforage from "localforage";
import { nanoid } from "nanoid";
import { listCloudCanvases, putCloudCanvas } from "./api/canvas-documents";
import { makeCloudCanvas } from "./canvas-cloud-media";
import { createCanvasCloudSync, type CanvasCloudBaseline } from "@/lib/canvas/canvas-cloud-sync";
import { collectProjectChanges } from "@/lib/canvas/canvas-persistence-merge";
import { writeCanvasProjects, readCanvasProjects } from "@/lib/canvas/canvas-project-storage";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type CloudSaveState = "local" | "loading" | "pending" | "syncing" | "synced" | "error" | "local-error";
export function createCloudCanvasPersistence(owner: string, name: string, hooks: {
    valid: () => boolean;
    status: (status: CloudSaveState, error?: string) => void;
    copy: (project: CanvasProject) => void;
}) {
    let engine: ReturnType<typeof createCanvasCloudSync> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let chain = Promise.resolve();
    let dirty = false;
    let pulled = false;
    const baselineKey = `${name}:cloud-baseline:v1`;
    const assertOwner = () => { if (!hooks.valid()) throw new Error("账号已切换，请重新打开画布"); };
    async function initialize() {
        if (engine) return engine;
        const baseline = await localforage.getItem<CanvasCloudBaseline>(baselineKey) || {};
        engine = createCanvasCloudSync(baseline, {
            list: async () => { assertOwner(); const result = await listCloudCanvases(owner); assertOwner(); return result.documents; },
            put: async (id, revision, document) => { assertOwner(); const result = await putCloudCanvas(owner, id, revision, document); assertOwner(); return result; },
            portable: async project => { assertOwner(); const result = await makeCloudCanvas(owner, project); assertOwner(); return result; },
            saveBaseline: async value => { assertOwner(); await localforage.setItem(baselineKey, value); },
            newId: nanoid,
            onCopy: async copy => {
                assertOwner();
                const before = await readCanvasProjects(name);
                await writeCanvasProjects(name, collectProjectChanges(before, [copy, ...before.filter(project => project.id !== copy.id)]));
                hooks.copy(copy);
            },
        });
        return engine;
    }
    function schedule(delay = 1200) {
        if (!hooks.valid()) return;
        dirty = true;
        hooks.status("pending");
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = undefined; void flush(); }, delay);
    }
    async function flush() {
        if (timer) clearTimeout(timer);
        timer = undefined;
        chain = chain.catch(() => undefined).then(async () => {
            if (!dirty || !hooks.valid()) return;
            dirty = false;
            hooks.status("syncing");
            try {
                const sync = await initialize();
                if (!pulled) {
                    const before = await readCanvasProjects(name);
                    const restored = await sync.hydrate(before, { live: true });
                    assertOwner();
                    await writeCanvasProjects(name, collectProjectChanges(before, restored));
                    await sync.confirmHydrated(await readCanvasProjects(name));
                    const existing = new Set(before.map(project => project.id));
                    for (const project of restored) if (!existing.has(project.id)) hooks.copy(project);
                    pulled = true;
                }
                await sync.save(await readCanvasProjects(name));
                if (hooks.valid()) hooks.status(dirty ? "pending" : "synced");
            } catch (error) {
                dirty = true;
                if (hooks.valid()) {
                    hooks.status("error", error instanceof Error ? error.message : "同步失败");
                    if (!timer) timer = setTimeout(() => { timer = undefined; void flush(); }, 15000);
                }
            }
        });
        return chain;
    }
    if (typeof window !== "undefined") {
        window.addEventListener("online", () => { if (dirty) void flush(); });
        window.addEventListener("pagehide", () => { if (dirty) void flush(); });
    }
    return {
        async hydrate(local: CanvasProject[]) {
            hooks.status("loading");
            let durable = local;
            try {
                const sync = await initialize();
                const projects = await sync.hydrate(local);
                assertOwner();
                await writeCanvasProjects(name, collectProjectChanges(local, projects));
                durable = await readCanvasProjects(name);
                await sync.confirmHydrated(durable);
                pulled = true;
                schedule();
                return durable;
            } catch (error) {
                hooks.status("error", error instanceof Error ? error.message : "云端读取失败");
                // Keep the durable local outbox. Cached revisions prevent a later retry from clobbering remote edits.
                dirty = true;
                timer = setTimeout(() => { timer = undefined; void flush(); }, 15000);
                return durable;
            }
        },
        schedule,
        flush,
    };
}
