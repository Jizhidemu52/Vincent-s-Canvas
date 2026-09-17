import { expect, test } from "bun:test";
import { createCanvasCloudSync, type CanvasCloudBaseline } from "@/lib/canvas/canvas-cloud-sync";
import { CanvasRevisionConflict, type CloudCanvasDocument } from "@/services/api/canvas-documents";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

const clone = <T>(value: T): T => structuredClone(value);
const encoded = (project: CanvasProject | null) => project === null ? null : JSON.stringify(project);
function project(id = "original", title = "完整画布"): CanvasProject {
    return {
        id, title, createdAt: "2026-09-17T00:00:00Z", updatedAt: "2026-09-17T00:00:00Z",
        nodes: [{ id: "image-a", type: "image", title: "原图", position: { x: -500, y: 280 }, width: 400, height: 220, metadata: { content: "/api/assets/11111111-2222-4333-8444-555555555555/content", prompt: "保留修改记录", naturalWidth: 2400, naturalHeight: 1320 } }],
        connections: [], chatSessions: [{ id: "chat", title: "历史", createdAt: "2026-09-17T00:00:00Z", updatedAt: "2026-09-17T00:00:00Z", messages: [{ id: "m1", role: "user", text: "保留完整讨论" }] }],
        activeChatId: "chat", backgroundMode: "dots", showImageInfo: true, viewport: { x: 100, y: 200, k: 0.6 },
    } as CanvasProject;
}
const envelope = (document: CanvasProject | null, revision = 1, id = document?.id || "original"): CloudCanvasDocument => ({ id, revision, deleted: document === null, document: clone(document), updatedAt: "2026-09-17T01:00:00Z" });

function harness(initial: CanvasProject[] = [], cloud: CloudCanvasDocument[] = [], baseline: CanvasCloudBaseline = {}) {
    const remote = new Map(cloud.map(item => [item.id, clone(item)]));
    const state = {
        local: clone(initial), persisted: clone(baseline), putCalls: [] as Array<{ id: string; revision: number; document: CanvasProject | null }>, copies: [] as string[], nextId: 1,
        beforePut: undefined as undefined | ((id: string, revision: number, document: CanvasProject | null) => void),
        afterCommit: undefined as undefined | ((id: string, document: CanvasProject | null) => void),
        afterCopy: undefined as undefined | ((document: CanvasProject) => void),
        persistFailure: false,
    };
    const dependencies = {
        list: async () => clone([...remote.values()]),
        put: async (id: string, revision: number, document: CanvasProject | null) => {
            state.putCalls.push({ id, revision, document: clone(document) });
            state.beforePut?.(id, revision, document);
            const current = remote.get(id);
            if (current ? current.revision !== revision || (current.deleted && document !== null) : revision !== 0) throw new CanvasRevisionConflict(clone(current || envelope(null, 0, id)));
            const saved = envelope(document, (current?.revision || 0) + 1, id);
            remote.set(id, saved);
            state.afterCommit?.(id, document);
            return clone(saved);
        },
        portable: async (input: CanvasProject) => {
            const result = clone(input);
            for (const node of result.nodes) if (node.metadata?.storageKey) { delete node.metadata.storageKey; node.metadata.content = "/api/assets/11111111-2222-4333-8444-555555555555/content"; }
            return result;
        },
        saveBaseline: async (value: CanvasCloudBaseline) => { if (state.persistFailure) throw new Error("disk unavailable"); state.persisted = clone(value); },
        newId: () => `recovery-${state.nextId++}`,
        onCopy: async (copy: CanvasProject) => {
            state.copies.push(copy.id);
            state.local = [...state.local.filter(item => item.id !== copy.id), clone(copy)];
            state.afterCopy?.(copy);
        },
    };
    const restart = () => createCanvasCloudSync(clone(state.persisted), dependencies);
    return { state, remote, dependencies, restart, engine: restart() };
}
const known = (value: CanvasProject, revision = 1): CanvasCloudBaseline => ({ [value.id]: { revision, local: encoded(value) } });

test("new device restores the full project while clean local media cache survives an unchanged cloud revision", async () => {
    const document = project();
    const fresh = harness([], [envelope(document), envelope(null, 3, "deleted")]);
    expect(await fresh.engine.hydrate([])).toEqual([document]);
    const cached = clone(document); cached.nodes[0]!.metadata!.content = "blob:local-cache"; cached.nodes[0]!.metadata!.storageKey = "image:cached";
    const same = harness([cached], [envelope(document)], known(cached));
    expect(await same.engine.hydrate(same.state.local)).toEqual([cached]);
    const updated = { ...document, title: "另一设备新名字" };
    same.remote.set(document.id, envelope(updated, 2));
    expect(await same.engine.hydrate(same.state.local)).toEqual([updated]);
});

test("live hydration only adds unseen remote documents and never changes an already open local editor", async () => {
    const original = project();
    const other = project("another", "另一个画布");
    const h = harness([original], [envelope({ ...original, title: "远端编辑" }, 2), envelope(other)], known(original));
    const projects = await h.engine.hydrate(h.state.local, { live: true });
    expect(projects.find(item => item.id === original.id)).toEqual(original);
    expect(projects.find(item => item.id === other.id)).toEqual(other);
});

test("offline dirty edits survive hydration and a failed request until a successful retry", async () => {
    const original = project(); const edited = { ...original, title: "离线修改" };
    const h = harness([edited], [envelope(original)], known(original));
    expect(await h.engine.hydrate(h.state.local)).toEqual([edited]);
    h.state.beforePut = () => { throw new Error("offline"); };
    await expect(h.engine.save(h.state.local)).rejects.toThrow("offline");
    expect(h.state.persisted.original).toEqual(known(original).original);
    h.state.beforePut = undefined;
    await h.engine.save(h.state.local);
    expect(h.remote.get(original.id)?.document).toEqual(edited);
    expect(h.state.persisted.original.local).toBe(encoded(edited));
});

test("lost primary PUT response remains idempotent after process restart", async () => {
    const original = project(); const edited = { ...original, title: "新版本" };
    const h = harness([edited], [envelope(original)], known(original));
    h.state.afterCommit = () => { throw new Error("response lost"); };
    await expect(h.engine.save(h.state.local)).rejects.toThrow("response lost");
    h.state.afterCommit = undefined;
    const restarted = h.restart();
    h.state.local = await restarted.hydrate(h.state.local);
    await restarted.save(h.state.local);
    expect(h.remote.size).toBe(1);
    expect(h.remote.get("original")?.revision).toBe(2);
    expect(h.remote.get("original")?.document).toEqual(edited);
});

test("lost backup response reuses one durable copy across restart before overwriting a competing remote version", async () => {
    const original = project(); const local = { ...original, title: "本地编辑" }; const competing = { ...original, title: "远端编辑" };
    const h = harness([local], [envelope(competing, 2)], known(original));
    h.state.afterCommit = id => { if (id !== "original") throw new Error("backup response lost"); };
    await expect(h.engine.save(h.state.local)).rejects.toThrow("backup response lost");
    expect(h.remote.get("original")?.document).toEqual(competing);
    h.state.afterCommit = undefined;
    await h.restart().save(h.state.local);
    const copies = [...h.remote.values()].filter(item => item.id !== "original");
    expect(copies).toHaveLength(1);
    expect(copies[0]!.document?.nodes).toEqual(competing.nodes);
    expect(copies[0]!.document?.title).toContain(competing.title);
    expect(h.remote.get("original")?.document).toEqual(local);
});

test("failed main write after a completed backup does not create repeated backup copies", async () => {
    const original = project(); const local = { ...original, title: "本地编辑" }; const competing = { ...original, title: "远端编辑" };
    const h = harness([local], [envelope(competing, 2)], known(original));
    h.state.beforePut = (id, revision) => { if (id === "original" && revision === 2) throw new Error("main unavailable"); };
    await expect(h.engine.save(h.state.local)).rejects.toThrow("main unavailable");
    h.state.beforePut = undefined;
    await h.restart().save(h.state.local);
    expect([...h.remote.values()].filter(item => item.id !== "original")).toHaveLength(1);
    expect(h.remote.get("original")?.document).toEqual(local);
});

test("redirected edits are not reverted by the clean stale copy also present in the same save batch", async () => {
    const original = project(); const local = { ...original, title: "删除后仍打开的编辑器" };
    const h = harness([local], [envelope(null, 2)], known(original));
    await h.engine.save(h.state.local);
    const copy = h.state.local.find(item => item.id !== "original")!;
    const latest = { ...local, title: "继续编辑的新版本" };
    h.state.local = [latest, copy];
    await h.engine.save(h.state.local);
    expect(h.remote.get(copy.id)?.document?.title).toContain(latest.title);
    expect(h.remote.get(copy.id)?.revision).toBe(2);
    expect(h.remote.get("original")?.deleted).toBe(true);
});

test("recovery redirection survives restart and handles a new conflict at the recovery target", async () => {
    const original = project(); const local = { ...original, title: "恢复内容" };
    const h = harness([local], [envelope(null, 2)], known(original));
    await h.engine.save(h.state.local);
    const copy = h.state.local.find(item => item.id !== "original")!;
    const competing = { ...copy, title: "恢复副本的远端修改" };
    h.remote.set(copy.id, envelope(competing, 2));
    const latest = { ...local, title: "原编辑器离线新修改" };
    h.state.local = [latest, copy];
    await h.restart().save(h.state.local);
    expect(h.remote.get(copy.id)?.document?.title).toContain(latest.title);
    expect([...h.remote.values()].filter(item => item.document?.title.includes(competing.title))).toHaveLength(1);
    expect(h.remote.get("original")?.deleted).toBe(true);
});

test("a local delete first preserves a competing remote edit and then writes a tombstone", async () => {
    const original = project(); const competing = { ...original, title: "远端删除前修改" };
    const h = harness([], [envelope(competing, 2)], known(original));
    await h.engine.save([]);
    expect(h.remote.get("original")?.deleted).toBe(true);
    expect([...h.remote.values()].find(item => item.id !== "original")?.document?.title).toContain(competing.title);
});

test("onCopy mutations cannot corrupt the durable backup or expand the in-flight input traversal", async () => {
    const original = project(); const local = { ...original, title: "本地编辑" }; const competing = { ...original, title: "远端编辑" };
    const h = harness([local], [envelope(competing, 2)], known(original));
    const input = h.state.local;
    h.state.afterCopy = copy => { copy.nodes[0]!.metadata!.prompt = "callback mutated"; input.push(project("injected")); };
    await h.engine.save(input);
    const cloudCopy = [...h.remote.values()].find(item => item.id !== "original")!;
    expect(h.state.persisted[cloudCopy.id].local).toBe(encoded(cloudCopy.document));
    expect(h.remote.has("injected")).toBe(false);
});

test("reloading after recovery removes the deleted original and retains only its recovery copy", async () => {
    const original = project(); const local = { ...original, title: "恢复内容" };
    const h = harness([local], [envelope(null, 2)], known(original));
    await h.engine.save(h.state.local);
    const restored = await h.restart().hydrate(h.state.local);
    expect(restored.map(item => item.id)).toEqual(["recovery-1"]);
    expect(restored[0]?.title).toContain(local.title);
});

test("independent edits to both an original editor and its recovery copy survive the whole save batch and its next retry", async () => {
    const original = project(); const local = { ...original, title: "恢复内容" };
    const h = harness([local], [envelope(null, 2)], known(original));
    await h.engine.save(h.state.local);
    const copy = h.state.local.find(item => item.id !== "original")!;
    const sourceEdit = { ...local, title: "原编辑器本轮修改" };
    const copyEdit = { ...copy, title: "副本本轮独立修改" };
    h.state.local = [sourceEdit, copyEdit];
    await h.engine.save(h.state.local);
    expect(h.state.local.find(item => item.id === copy.id)).toEqual(copyEdit);
    expect(h.remote.get(copy.id)?.document).toEqual(copyEdit);
    await h.engine.save(h.state.local);
    expect(h.remote.get(copy.id)?.document).toEqual(copyEdit);
    expect([...h.remote.values()].some(item => item.document?.title.includes(sourceEdit.title))).toBe(true);
});

test("deleting a recovery copy during an original edit does not recreate the deleted copy locally", async () => {
    const original = project(); const h = harness([{ ...original, title: "恢复内容" }], [envelope(null, 2)], known(original));
    await h.engine.save(h.state.local);
    const copy = h.state.local.find(item => item.id !== "original")!;
    h.state.local = [{ ...h.state.local[0]!, title: "原编辑器再次修改" }];
    await h.engine.save(h.state.local);
    expect(h.remote.get(copy.id)?.deleted).toBe(true);
    expect(h.state.local.some(item => item.id === copy.id)).toBe(false);
    const cloudCount = h.remote.size;
    await h.engine.save(h.state.local);
    expect(h.remote.size).toBe(cloudCount);
});

test("a recovery target deleted elsewhere redirects again without mismatched local and cloud snapshots", async () => {
    const original = project(); const h = harness([{ ...original, title: "恢复内容" }], [envelope(null, 2)], known(original));
    await h.engine.save(h.state.local);
    const firstCopy = h.state.local.find(item => item.id !== "original")!;
    h.remote.set(firstCopy.id, envelope(null, 2, firstCopy.id));
    h.state.local[0] = { ...h.state.local[0]!, title: "恢复目标删除后继续修改" };
    await h.engine.save(h.state.local);
    const newCopy = h.state.local.find(item => item.id !== "original" && item.id !== firstCopy.id)!;
    expect(h.remote.get(newCopy.id)?.document).toEqual(newCopy);
    const revision = h.remote.get(newCopy.id)!.revision;
    await h.engine.save(h.state.local);
    expect(h.remote.get(newCopy.id)!.revision).toBe(revision);
});

test("reordered PostgreSQL JSON keys do not turn a lost success response into a duplicate backup", async () => {
    const original = project(); const edited = { ...original, title: "新版本" };
    const h = harness([edited], [envelope(original)], known(original));
    h.state.afterCommit = id => {
        const saved = h.remote.get(id)!;
        saved.document = JSON.parse(JSON.stringify(saved.document, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value));
        throw new Error("response lost");
    };
    await expect(h.engine.save(h.state.local)).rejects.toThrow("response lost");
    h.state.afterCommit = undefined;
    await h.restart().save(h.state.local);
    expect(h.remote.size).toBe(1);
    expect(h.remote.get("original")?.revision).toBe(2);
});

test("failed baseline persistence never causes a committed write to be duplicated after restart", async () => {
    const original = project(); const edited = { ...original, title: "新版本" };
    const h = harness([edited], [envelope(original)], known(original));
    h.state.persistFailure = true;
    await expect(h.engine.save(h.state.local)).rejects.toThrow("disk unavailable");
    h.state.persistFailure = false;
    await h.restart().save(h.state.local);
    expect(h.remote.size).toBe(1);
    expect(h.remote.get("original")?.revision).toBe(2);
    expect(h.state.persisted.original.local).toBe(encoded(edited));
});

test("conflict backup works on an insecure LAN origin without WebCrypto", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
        const original = project(); const local = { ...original, title: "本地修改" }; const competing = { ...original, title: "远端修改" };
        const h = harness([local], [envelope(competing, 2)], known(original));
        await h.engine.save(h.state.local);
        expect(h.remote.get("original")?.document).toEqual(local);
        expect(h.remote.size).toBe(2);
    } finally {
        if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
        else Reflect.deleteProperty(globalThis, "crypto");
    }
});

test("a failed local commit after hydration cannot silently overwrite the newer cloud version", async () => {
    const original = project(); const remote = { ...original, title: "不可丢失的云端新版本" };
    const h = harness([original], [envelope(remote, 2)], known(original));
    const restored = await h.engine.hydrate(h.state.local);
    expect(restored).toEqual([remote]);
    // Caller could not commit restored to IndexedDB; its next read still returns old local data.
    await h.engine.save(h.state.local);
    expect(h.remote.get("original")?.document).toEqual(remote);
    expect(h.remote.get("original")?.revision).toBe(2);
});

test("failed persistence of a newly fetched project is not mistaken for an intentional cloud deletion", async () => {
    const remote = project();
    const h = harness([], [envelope(remote, 2)]);
    expect(await h.engine.hydrate([])).toEqual([remote]);
    await h.engine.save([]);
    expect(h.remote.get("original")?.document).toEqual(remote);
    expect(h.remote.get("original")?.deleted).toBe(false);
    await h.engine.save([remote]);
    expect(h.state.persisted.original).toEqual({ revision: 2, local: encoded(remote) });
    expect(h.state.putCalls).toHaveLength(0);
});

test("confirming durable hydration before immediate editing avoids a false initial revision conflict", async () => {
    const remote = project();
    const h = harness([], [envelope(remote, 7)]);
    h.state.local = await h.engine.hydrate([]);
    await h.engine.confirmHydrated(h.state.local);
    expect(h.state.putCalls).toHaveLength(0);
    expect(h.state.persisted.original).toEqual({ revision: 7, local: encoded(remote) });
    const edited = { ...remote, updatedAt: "2026-09-17T02:00:00Z", title: "打开后立即编辑" };
    h.state.local = [edited];
    await h.engine.save(h.state.local);
    expect(h.state.putCalls).toEqual([{ id: "original", revision: 7, document: edited }]);
    expect(h.remote.size).toBe(1);
    expect(h.remote.get("original")?.revision).toBe(8);
    expect(h.remote.get("original")?.document).toEqual(edited);
});

test("hydration confirmation neither advances unmatched local data nor uploads existing dirty edits", async () => {
    const original = project(); const remote = { ...original, title: "云端新版本" };
    const dirty = project("dirty", "离线未上传");
    const h = harness([original, dirty], [envelope(remote, 2)], known(original));
    await h.engine.hydrate(h.state.local);
    await h.engine.confirmHydrated(h.state.local);
    expect(h.state.persisted.original).toEqual(known(original).original);
    expect(h.state.persisted.dirty).toBeUndefined();
    expect(h.state.putCalls).toHaveLength(0);
});
