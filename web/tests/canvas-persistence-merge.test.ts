import { expect, test } from "bun:test";
import { collectProjectChanges, createProjectChangeBuffer, mergeProjectChanges } from "@/lib/canvas/canvas-persistence-merge";
import type { CanvasConnection } from "@/types/canvas";

const originalPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
function project() {
    return {
        id: "shared", title: "原画布", createdAt: "2026-09-01", updatedAt: "2026-09-01",
        nodes: [
            { id: "image-a", position: { x: 0, y: 0 }, metadata: { content: originalPng, storageKey: "image:original", prompt: "保留中文", naturalWidth: 4096, naturalHeight: 2048 } },
            { id: "image-b", position: { x: 100, y: 0 }, metadata: { content: "blob:second", storageKey: "image:second", prompt: "第二张图", naturalWidth: 1024, naturalHeight: 1024 } },
        ],
        connections: [{ id: "edge-ab", fromNodeId: "image-a", toNodeId: "image-b" }],
        chatSessions: [{ id: "chat-1", title: "设计讨论", createdAt: "2026-09-01", updatedAt: "2026-09-01", messages: [{ id: "message-1", text: "保留原图" }] }],
        activeChatId: "chat-1", viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "dots", showImageInfo: false,
    };
}

test("two stale tabs keep different node moves, new nodes, connections and project metadata", () => {
    const base = project();
    const a = structuredClone(base), b = structuredClone(base);
    a.nodes[0]!.position.x = 200;
    a.nodes.push({ ...a.nodes[0]!, id: "new-a" });
    a.connections.push({ id: "edge-a", fromNodeId: "image-a", toNodeId: "new-a" });
    a.title = "A 的名称";
    b.nodes[1]!.position.y = 300;
    b.nodes.push({ ...b.nodes[1]!, id: "new-b" });
    b.connections.push({ id: "edge-b", fromNodeId: "image-b", toNodeId: "new-b" });
    b.backgroundMode = "grid";
    const first = mergeProjectChanges([base], collectProjectChanges([base], [a]));
    const result = mergeProjectChanges(first, collectProjectChanges([base], [b]));
    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("A 的名称");
    expect(result[0]!.backgroundMode).toBe("grid");
    expect(result[0]!.nodes.map(node => node.id)).toEqual(["image-a", "image-b", "new-b", "new-a"]);
    expect(result[0]!.nodes[0]!.position).toEqual({ x: 200, y: 0 });
    expect(result[0]!.nodes[1]!.position).toEqual({ x: 100, y: 300 });
    expect(new Set(result[0]!.connections.map(edge => edge.id))).toEqual(new Set(["edge-ab", "edge-a", "edge-b"]));
    expect(base).toEqual(project());
});

test("different fields on one node and independent messages in one chat merge without a conflict copy", () => {
    const base = project(), remote = structuredClone(base), local = structuredClone(base);
    remote.nodes[0]!.position.x = 200;
    remote.nodes[0]!.metadata.prompt = "远端提示词";
    remote.chatSessions[0]!.messages.push({ id: "remote-message", text: "A 的讨论" });
    local.nodes[0]!.position.y = 80;
    local.nodes[0]!.metadata.naturalWidth = 8192;
    local.chatSessions[0]!.messages.push({ id: "local-message", text: "B 的讨论" });
    local.chatSessions[0]!.title = "新的讨论名";
    const result = mergeProjectChanges([remote], collectProjectChanges([base], [local]));
    expect(result).toHaveLength(1);
    expect(result[0]!.nodes[0]!.position).toEqual({ x: 200, y: 80 });
    expect(result[0]!.nodes[0]!.metadata).toMatchObject({ prompt: "远端提示词", naturalWidth: 8192, content: originalPng, storageKey: "image:original" });
    expect(result[0]!.chatSessions[0]!.title).toBe("新的讨论名");
    expect(new Set(result[0]!.chatSessions[0]!.messages.map(message => message.text))).toEqual(new Set(["保留原图", "A 的讨论", "B 的讨论"]));
});

test("a same-field conflict keeps the local edit and a complete identifiable remote project copy", () => {
    const base = project(), remote = structuredClone(base), local = structuredClone(base);
    remote.nodes[0]!.position.x = 200;
    remote.nodes[1]!.metadata.prompt = "A 另改的字段";
    local.nodes[0]!.position.x = 500;
    const result = mergeProjectChanges([remote], collectProjectChanges([base], [local]));
    expect(result).toHaveLength(2);
    const main = result.find(item => item.id === base.id)!;
    const copy = result.find(item => item.id !== base.id)!;
    expect(main.nodes[0]!.position.x).toBe(500);
    expect(main.nodes[1]!.metadata.prompt).toBe("A 另改的字段");
    expect(copy.title).toContain("保存冲突副本");
    expect(copy.nodes).toEqual(remote.nodes);
    expect(copy.connections).toEqual(remote.connections);
    expect(copy.chatSessions).toEqual(remote.chatSessions);
    expect((copy as any).persistenceConflict).toMatchObject({ projectId: base.id, paths: ["nodes[image-a].position.x"] });
    expect(copy.nodes[0]!.metadata.content).toBe(originalPng);
});

test.each(["local", "remote"])("project deletion in the %s tab does not discard concurrent editing or resurrect the deleted ID", (deletingTab) => {
    const base = project(), edited = structuredClone(base);
    edited.nodes[0]!.metadata.prompt = "删除前另一窗口的新创意";
    const result = deletingTab === "local"
        ? mergeProjectChanges([edited], collectProjectChanges([base], []))
        : mergeProjectChanges([], collectProjectChanges([base], [edited]));
    expect(result).toHaveLength(1);
    expect(result[0]!.id).not.toBe(base.id);
    expect(result[0]!.title).toContain("保存冲突副本");
    expect(result[0]!.nodes).toEqual(edited.nodes);
    expect(result[0]!.chatSessions).toEqual(edited.chatSessions);
});

test("a node deletion survives another tab editing a different node and adding an unrelated connection", () => {
    const base = project(), remote = structuredClone(base), local = structuredClone(base);
    remote.nodes = remote.nodes.filter(node => node.id !== "image-a");
    remote.connections = [];
    local.nodes[1]!.position.y = 70;
    local.nodes.push({ ...local.nodes[1]!, id: "new-b" });
    local.connections.push({ id: "edge-new", fromNodeId: "image-b", toNodeId: "new-b" });
    const result = mergeProjectChanges([remote], collectProjectChanges([base], [local]));
    expect(result).toHaveLength(1);
    expect(result[0]!.nodes.map(node => node.id)).toEqual(["image-b", "new-b"]);
    expect(result[0]!.nodes[0]!.position.y).toBe(70);
    expect(result[0]!.connections).toEqual([{ id: "edge-new", fromNodeId: "image-b", toNodeId: "new-b" }]);
});

test.each([true, false])("a concurrent new connection to a deleted node has a complete recovery copy (deletion saved first: %s)", (deletionFirst) => {
    const base = project();
    base.connections = [];
    const deleted = structuredClone(base), linked = structuredClone(base);
    deleted.nodes = deleted.nodes.filter(node => node.id !== "image-a");
    const connection: CanvasConnection = { id: "new-edge-ab", fromNodeId: "image-a", toNodeId: "image-b" };
    linked.connections.push(connection);
    const first = deletionFirst ? deleted : linked;
    const last = deletionFirst ? linked : deleted;
    const changes = collectProjectChanges([base], [last]);
    const firstSave = mergeProjectChanges([base], collectProjectChanges([base], [first]));
    const result = mergeProjectChanges(firstSave, changes);
    const main = result.find(item => item.id === base.id)!;
    expect(main.nodes.map(node => node.id)).toEqual(["image-b"]);
    expect(main.connections).toEqual([]);
    expect(result).toHaveLength(2);
    const copy = result.find(item => item.id !== base.id)!;
    expect(copy.title).toContain("保存冲突副本");
    expect(copy.nodes).toEqual(linked.nodes);
    expect(copy.connections).toEqual([connection]);
    expect(copy.chatSessions).toEqual(linked.chatSessions);
    expect(copy.nodes[0]!.metadata.content).toBe(originalPng);
    expect((copy as any).persistenceConflict.paths).toContain("connections[new-edge-ab].$missingNode");
    // An uncertain storage acknowledgement must not duplicate this recovery copy.
    expect(mergeProjectChanges(structuredClone(result), changes)).toEqual(result);
    expect(base.connections).toEqual([]);
});

test("a graph dependency conflict and a field conflict preserve both complete source versions", () => {
    const base = project();
    base.connections = [];
    const remote = structuredClone(base), local = structuredClone(base);
    remote.nodes = remote.nodes.filter(node => node.id !== "image-a");
    remote.title = "删除节点窗口的名称";
    local.title = "创建连线窗口的名称";
    local.connections.push({ id: "new-edge-ab", fromNodeId: "image-a", toNodeId: "image-b" });
    const changes = collectProjectChanges([base], [local]);
    const result = mergeProjectChanges([remote], changes);
    expect(result).toHaveLength(3);
    expect(new Set(result.map(item => item.id)).size).toBe(3);
    const main = result.find(item => item.id === base.id)!;
    expect(main.title).toBe(local.title);
    expect(main.nodes).toEqual(remote.nodes);
    expect(main.connections).toEqual([]);
    const copies = result.filter(item => item.id !== base.id);
    expect(copies.find(item => item.title.startsWith(remote.title))!.nodes).toEqual(remote.nodes);
    const linkedCopy = copies.find(item => item.title.startsWith(local.title))!;
    expect(linkedCopy.nodes).toEqual(local.nodes);
    expect(linkedCopy.connections).toEqual(local.connections);
    expect(mergeProjectChanges(structuredClone(result), changes)).toEqual(result);
});

test("concurrency merging does not silently clean up an already invalid source graph", () => {
    const base = project();
    base.nodes = base.nodes.filter(node => node.id !== "image-a");
    const local = { ...base, title: "仅重命名" };
    expect(mergeProjectChanges([base], collectProjectChanges([base], [local]))).toEqual([local]);
});

test("coalescing several local edits keeps the earliest baseline for the final three-way merge", () => {
    const base = project(), first = structuredClone(base), last = structuredClone(base), remote = structuredClone(base);
    first.nodes[0]!.position.x = 20;
    last.nodes[0]!.position.x = 40;
    last.title = "最后一次本地名称";
    remote.nodes[1]!.position.y = 75;
    const pending = collectProjectChanges([base], [first]);
    collectProjectChanges([first], [last], pending);
    const result = mergeProjectChanges([remote], pending);
    expect(result).toHaveLength(1);
    expect(result[0]!.nodes[0]!.position.x).toBe(40);
    expect(result[0]!.nodes[1]!.position.y).toBe(75);
    expect(result[0]!.title).toBe("最后一次本地名称");
});

test("the same edits with different automatic timestamps do not create spurious conflict copies", () => {
    const base = project(), remote = structuredClone(base), local = structuredClone(base);
    remote.nodes[0]!.position.x = local.nodes[0]!.position.x = 123;
    remote.updatedAt = "2026-09-10";
    local.updatedAt = "2026-09-11";
    expect(mergeProjectChanges([remote], collectProjectChanges([base], [local]))).toHaveLength(1);
});

test("an old tab saving A does not remove B created by another tab", () => {
    const a = { id: "a", title: "original" };
    const b = { id: "b", title: "new canvas" };
    const edited = { ...a, title: "edited" };
    const changes = collectProjectChanges([a], [edited]);
    expect(mergeProjectChanges([b, a], changes)).toEqual([b, edited]);
});

test("stale unchanged projects do not resurrect another tab's deletion", () => {
    const a = { id: "a", title: "A" }, b = { id: "b", title: "B" };
    const edited = { ...b, title: "edited" };
    expect(mergeProjectChanges([b], collectProjectChanges([a, b], [a, edited]))).toEqual([edited]);
});

test("coalesced edits retain creation and intentional deletion", () => {
    const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
    const pending = collectProjectChanges([a], [b, a]);
    collectProjectChanges([b, a], [b], pending);
    expect(mergeProjectChanges([c, a], pending)).toEqual([b, c]);
});

test("failed writes retain edits and deletions until a later write succeeds", async () => {
    const buffer = createProjectChangeBuffer<{ id: string; title: string }>();
    const base = { id: "a", title: "original" }, deleted = { id: "deleted", title: "delete this" };
    const oldA = { id: "a", title: "first edit" };
    await expect(buffer.write(collectProjectChanges([base, deleted], [oldA]), async () => {
        throw new Error("temporary storage failure");
    })).rejects.toThrow("temporary storage failure");
    const newA = { id: "a", title: "latest edit" }, b = { id: "b", title: "B" };
    let saved = [base, deleted];
    await buffer.write(collectProjectChanges([oldA], [newA, b]), async changes => { saved = mergeProjectChanges(saved, changes); });
    expect(saved).toEqual([b, newA]);
    await buffer.write(collectProjectChanges([b], [{ ...b, title: "renamed B" }]), async changes => {
        expect([...changes.keys()]).toEqual(["b"]);
    });
});

test("explicit storage removal clears failed changes", async () => {
    const buffer = createProjectChangeBuffer<{ id: string }>();
    await expect(buffer.write(collectProjectChanges([], [{ id: "a" }]), async () => { throw new Error("failed"); })).rejects.toThrow();
    buffer.clear();
    await buffer.write(new Map(), async changes => { expect(changes.size).toBe(0); });
});

test("a write that committed before reporting failure does not duplicate conflict copies on retry", async () => {
    const base = project(), remote = structuredClone(base), local = structuredClone(base);
    remote.nodes[0]!.position.x = 100;
    remote.nodes[1]!.metadata.prompt = "独立远端改动";
    local.nodes[0]!.position.x = 200;
    const buffer = createProjectChangeBuffer<ReturnType<typeof project>>();
    let database = [remote];
    await expect(buffer.write(collectProjectChanges([base], [local]), async changes => {
        database = structuredClone(mergeProjectChanges(database, changes));
        throw new Error("commit acknowledgement lost");
    })).rejects.toThrow("commit acknowledgement lost");
    const copy = structuredClone(database.find(item => item.id !== "shared"));
    expect(database).toHaveLength(2);
    await buffer.write(new Map(), async changes => { database = mergeProjectChanges(database, changes); });
    expect(database).toHaveLength(2);
    expect(database.find(item => item.id !== "shared")).toEqual(copy);
    expect(database.find(item => item.id === "shared")!.nodes[0]!.position.x).toBe(200);
    expect(database.find(item => item.id === "shared")!.nodes[1]!.metadata.prompt).toBe("独立远端改动");
});

test("deleting a node concurrently edited elsewhere preserves the edited node in the conflict copy", () => {
    const base = project(), remote = structuredClone(base), local = structuredClone(base);
    remote.nodes[0]!.metadata.prompt = "另一窗口尚未看到的新细节";
    local.nodes = local.nodes.filter(node => node.id !== "image-a");
    local.connections = [];
    const result = mergeProjectChanges([remote], collectProjectChanges([base], [local]));
    const main = result.find(item => item.id === "shared")!;
    const copy = result.find(item => item.id !== "shared")!;
    expect(main.nodes.map(node => node.id)).toEqual(["image-b"]);
    expect(main.connections).toEqual([]);
    expect(copy.nodes[0]!.metadata.prompt).toBe("另一窗口尚未看到的新细节");
    expect(copy.nodes[0]!.metadata.content).toBe(originalPng);
    expect(copy.connections).toEqual(base.connections);
});

test("conflicting ordering keeps the local order and a recoverable remote order", () => {
    const base = { id: "ordered", title: "图层", nodes: [{ id: "a" }, { id: "b" }, { id: "c" }] };
    const local = { ...base, nodes: [{ id: "b" }, { id: "a" }, { id: "c" }] };
    const remote = { ...base, nodes: [{ id: "a" }, { id: "c" }, { id: "b" }] };
    const result = mergeProjectChanges([remote], collectProjectChanges([base], [local]));
    expect(result.find(item => item.id === "ordered")!.nodes.map(node => node.id)).toEqual(["b", "a", "c"]);
    expect(result.find(item => item.id !== "ordered")!.nodes.map(node => node.id)).toEqual(["a", "c", "b"]);
});

test("conflicting non-entity arrays are preserved whole rather than paired by numeric index", () => {
    const base = { id: "references", title: "参考图", references: ["original-a", "original-b"] };
    const remote = { ...base, references: ["remote-a", "original-b"] };
    const local = { ...base, references: ["original-a", "local-b"] };
    const result = mergeProjectChanges([remote], collectProjectChanges([base], [local]));
    expect(result.find(item => item.id === "references")!.references).toEqual(["original-a", "local-b"]);
    expect(result.find(item => item.id !== "references")!.references).toEqual(["remote-a", "original-b"]);
});
