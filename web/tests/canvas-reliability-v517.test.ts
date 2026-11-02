import { expect, test } from "bun:test";
import { createCanvasProjectSaveQueue } from "@/lib/canvas/canvas-project-save-queue";
import { verifiedCacheCandidates, evictVerifiedCanvasImages } from "@/lib/canvas/canvas-verified-cache";
import { clearImportedCanvasTasks } from "@/lib/canvas/canvas-import-task-state";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { parseCanvasProject, serializeCanvasProject } from "@/lib/canvas/canvas-project-codec";

test("history codec round-trips selected IDs deltas and earlier frames without selection", () => {
    const base = { nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots" as const, showImageInfo: false };
    const project = { id: "selection-history", title: "选择历史", ...base, selectedNodeIds: ["b"], history: { past: [base, { ...base, selectedNodeIds: [] }, { ...base, selectedNodeIds: ["a", "b"] }], future: [{ ...base, selectedNodeIds: ["c"] }] } } as CanvasProject;
    expect(parseCanvasProject(serializeCanvasProject(project))).toEqual(project);
});

test("continuous edits flush the latest snapshot at the three-second maximum wait", () => {
    let now = 0, id = 0;
    const timers = new Map<number, { due: number; callback: () => void }>();
    const saved: number[] = [];
    const queue = createCanvasProjectSaveQueue(900, (value: number) => saved.push(value), {
        set(callback, delay) { timers.set(++id, { due: now + delay, callback }); return id; },
        clear(handle) { timers.delete(handle as number); },
    });
    const advance = (next: number) => { now = next; for (const [key, timer] of [...timers]) if (timer.due <= now && timers.has(key)) { timers.delete(key); timer.callback(); } };
    for (let time = 0; time < 3000; time += 500) { advance(time); queue.schedule(time); }
    expect(saved).toEqual([]);
    advance(3000);
    expect(saved).toEqual([2500]);
    expect(queue.hasPending()).toBe(false);
});

test("import detaches pending image/audio/video task identity without modifying source or completed outputs", () => {
    const nodes = [{ id: "pending", type: CanvasNodeType.Image, title: "draft", width: 1, height: 1, position: { x: 0, y: 0 }, metadata: { status: "loading" as const, imageTask: { ownerId: "old", projectId: "old", requestId: "paid", resultIndex: 0 }, sourceTaskId: "old" } },
        { id: "done", type: CanvasNodeType.Image, title: "done", width: 1, height: 1, position: { x: 0, y: 0 }, metadata: { status: "success" as const, sourceTaskId: "provenance", content: "blob:original", storageKey: "image:original" } }];
    const clean = clearImportedCanvasTasks(nodes);
    expect(clean[0].metadata?.imageTask).toBeUndefined();
    expect(clean[0].metadata?.status).toBe("idle");
    expect(clean[1]).toBe(nodes[1]);
    expect(nodes[0].metadata.imageTask?.requestId).toBe("paid");
});

test("cache candidates exclude unsynchronized canvases, histories and local asset-library references", () => {
    const clean = { id: "clean", nodes: [{ metadata: { storageKey: "image:safe" } }, { metadata: { storageKey: "image:historic" } }, { metadata: { storageKey: "image:asset" } }], chatSessions: [], history: { past: [{ nodes: [{ metadata: { storageKey: "image:historic" } }] }], future: [] } } as unknown as CanvasProject;
    const dirty = { id: "dirty", nodes: [{ metadata: { storageKey: "image:unsynced" } }], chatSessions: [] } as unknown as CanvasProject;
    expect(verifiedCacheCandidates([clean, dirty], new Set(["clean"]), [{ storageKey: "image:asset" }])).toEqual(["image:safe"]);
});

test("cache eviction requires exact cloud bytes and a persisted recovery link; a changed owner stops immediately", async () => {
    const steps: string[] = [];
    let current = true;
    const local = new Blob([new Uint8Array([1, 2, 3])]);
    const result = await evictVerifiedCanvasImages(["image:mismatch", "image:good", "image:changed"], {
        current: () => current, local: async () => local,
        source: async () => "/api/assets/11111111-1111-4111-8111-111111111111/content",
        remote: async () => steps.length ? local : (steps.push("mismatch"), new Blob([new Uint8Array([1, 2, 4])])),
        remember: async key => { steps.push(`remember:${key}`); },
        evict: async key => { steps.push(`evict:${key}`); current = false; },
    });
    expect(result).toEqual({ removed: 1, bytes: 3, skipped: 1 });
    expect(steps).toEqual(["mismatch", "remember:image:good", "evict:image:good"]);
});
