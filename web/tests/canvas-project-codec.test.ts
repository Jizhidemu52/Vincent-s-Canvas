import { describe, expect, test } from "bun:test";
import { decodeCanvasProject, encodeCanvasProject, parseCanvasProject, serializeCanvasProject } from "@/lib/canvas/canvas-project-codec";
import { mergeProjectChanges } from "@/lib/canvas/canvas-persistence-merge";
import type { CanvasHistorySnapshot, CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType } from "@/types/canvas";

function project(): CanvasProject {
    return {
        id: "fixture", title: "Original media and undo history", createdAt: "before", updatedAt: "now",
        nodes: Array.from({ length: 20 }, (_, index) => ({
            id: `n${index}`, type: CanvasNodeType.Image, title: `Image ${index}`,
            position: { x: index, y: 2 * index }, width: 300, height: 200,
            metadata: { content: `data:image/png;base64,AAAA${index}`, storageKey: `image:${index}`, bytes: 1234 },
        })),
        connections: Array.from({ length: 19 }, (_, index) => ({ id: `e${index}`, fromNodeId: `n${index}`, toNodeId: `n${index + 1}` })),
        chatSessions: [{ id: "chat", title: "Conversation", createdAt: "before", updatedAt: "now", messages: [{ id: "message", role: "user", text: "Untouched", attachments: [{ id: "attachment", name: "original.png", url: "data:image/png;base64,ORIGINAL", mediaType: "image" }] }] }],
        activeChatId: "chat", backgroundMode: "dots", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
    };
}

function snapshot(source: CanvasProject): CanvasHistorySnapshot {
    const { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo } = source;
    return { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo, ...(source.groups ? { groups: source.groups } : {}) };
}

function historyProject(steps = 50): CanvasProject {
    const source = project();
    const past: CanvasHistorySnapshot[] = [];
    let current = snapshot(source);
    for (let index = 0; index < steps; index += 1) {
        past.push(current);
        current = { ...current, nodes: current.nodes.map((node, position) => position ? node : { ...node, position: { ...node.position, x: index + 1 } }) };
    }
    return { ...source, ...current, history: { past, future: [] } };
}

function plain(value: unknown) { return JSON.parse(JSON.stringify(value)); }

describe("compact canvas history", () => {
    test("pending image request identity and result mapping survive project and history serialization", () => {
        const source = project();
        const imageTask = { ownerId: "employee-a", projectId: source.id, requestId: "accepted-request:0", taskId: "original-task", resultIndex: 0 };
        source.nodes[0].metadata = { status: "loading", imageTask };
        source.history = { past: [snapshot(source)], future: [] };
        const restored = parseCanvasProject(serializeCanvasProject(source));
        expect(restored.nodes[0].metadata?.imageTask).toEqual(imageTask);
        expect(restored.history?.past[0].nodes[0].metadata?.imageTask).toEqual(imageTask);
        expect(restored.nodes[0].id).toBe(source.nodes[0].id);
    });
    test("fifty-step save/refresh/undo/redo preserves all states and original media", () => {
        const source = historyProject();
        const serialized = serializeCanvasProject(source);
        const restored = parseCanvasProject(serialized);
        expect(restored).toEqual(plain(source));
        expect(Buffer.byteLength(serialized)).toBeLessThan(Buffer.byteLength(JSON.stringify(source)) / 5);
        const restoredHistory = restored.history!;
        let current = snapshot(restored);
        for (let index = 49; index >= 0; index -= 1) {
            restoredHistory.future.push(current);
            current = restoredHistory.past.pop()!;
            expect(current.nodes[0].position.x).toBe(index);
            expect(current.nodes[0].metadata!.content).toBe(source.nodes[0].metadata!.content);
        }
        const afterUndo = parseCanvasProject(serializeCanvasProject({ ...restored, ...current, history: restoredHistory }));
        expect(afterUndo.history!.past).toHaveLength(0);
        expect(afterUndo.history!.future).toHaveLength(50);
        for (let index = 1; index <= 50; index += 1) {
            current = afterUndo.history!.future.pop()!;
            expect(current.nodes[0].position.x).toBe(index);
        }
        expect(current.nodes).toEqual(source.nodes);
    });

    test("restored history shares unchanged nodes, connections, chat, and groups", () => {
        const source = historyProject();
        const restored = parseCanvasProject(serializeCanvasProject(source));
        for (const frame of restored.history!.past) {
            expect(frame.nodes[1]).toBe(restored.nodes[1]);
            expect(frame.connections).toBe(restored.connections);
            expect(frame.chatSessions).toBe(restored.chatSessions);
            expect(frame.nodes[0]).not.toBe(restored.nodes[0]);
        }
        expect(source.history!.past[0].nodes[0].position.x).toBe(0);
    });

    test("independent undo and redo anchors preserve edits to every snapshot field", () => {
        const source = project();
        const base = snapshot(source);
        const earlier: CanvasHistorySnapshot = {
            ...base, nodes: [base.nodes[2], ...base.nodes.slice(3)],
            connections: [], groups: [{ id: "g", title: "Grouped", collapsed: true, nodeIds: ["n2", "n3"] }],
            chatSessions: [], activeChatId: null, backgroundMode: "blank", showImageInfo: true,
        };
        const later: CanvasHistorySnapshot = {
            ...base, nodes: [base.nodes[19], ...base.nodes.slice(0, 19)],
            chatSessions: [{ ...base.chatSessions[0], messages: [{ id: "next", role: "assistant", text: "Later", references: [{ id: "ref", type: CanvasNodeType.Image, title: "Exact bytes", dataUrl: "data:image/png;base64,EXACT" }] }] }],
        };
        const value = { ...source, history: { past: [base, earlier], future: [base, later] } };
        expect(parseCanvasProject(serializeCanvasProject(value))).toEqual(plain(value));
    });

    test("sparse replacements store complete node elements, not media fragments", () => {
        const source = project();
        const previous = { ...snapshot(source), nodes: source.nodes.map((node, index) => index === 1 || index === 18 ? { ...node, position: { x: -10, y: -20 } } : node) };
        const encoded = encodeCanvasProject({ ...source, history: { past: [previous], future: [] } });
        const patch = encoded.history!.past[0].arrays!.nodes!;
        expect(patch.kind).toBe("items");
        if (patch.kind !== "items") throw new Error("Expected sparse replacements");
        expect(patch.changes[0][1]).toEqual(previous.nodes[1]);
        expect(patch.changes[1][1]).toEqual(previous.nodes[18]);
        expect(decodeCanvasProject(plain(encoded)).history!.past[0].nodes).toEqual(previous.nodes);
    });

    test("insertion, deletion, reorder, append, clear and optional groups round trip", () => {
        const source = project();
        const base = snapshot(source);
        const frames = [
            { ...base, nodes: [] },
            { ...base, nodes: [base.nodes[0]] },
            { ...base, nodes: [...base.nodes, { ...base.nodes[0], id: "appended" }] },
            { ...base, nodes: [...base.nodes.slice(0, 4), { ...base.nodes[0], id: "inserted" }, ...base.nodes.slice(4)] },
            { ...base, nodes: [...base.nodes.slice(0, 4), ...base.nodes.slice(5)] },
            { ...base, nodes: base.nodes.toReversed(), groups: [] },
            { ...base, groups: [{ id: "g", title: "Temporary", collapsed: false, nodeIds: ["n1"] }] },
            base,
        ];
        const value = { ...source, history: { past: frames, future: frames.toReversed() } };
        expect(parseCanvasProject(serializeCanvasProject(value))).toEqual(plain(value));
    });

    test("expanded imported JSON receives the same compact encoding and sharing", () => {
        const source = historyProject();
        const imported = plain(source);
        expect(decodeCanvasProject(imported)).toBe(imported);
        expect(serializeCanvasProject(imported)).toBe(serializeCanvasProject(source));
        expect(parseCanvasProject(serializeCanvasProject(imported))).toEqual(imported);
    });

    test("key reordering and undefined object properties do not change canonical bytes", () => {
        const source = historyProject(3);
        const reversed = JSON.parse(JSON.stringify(source, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).reverse()) : value));
        reversed.groups = undefined;
        expect(serializeCanvasProject(reversed)).toBe(serializeCanvasProject(source));
        expect(serializeCanvasProject(parseCanvasProject(serializeCanvasProject(source)))).toBe(serializeCanvasProject(source));
    });

    test("no history and empty history retain their separate meanings", () => {
        const source = project();
        expect(parseCanvasProject(serializeCanvasProject(source))).toEqual(source);
        expect(parseCanvasProject(serializeCanvasProject({ ...source, history: { past: [], future: [] } })).history).toEqual({ past: [], future: [] });
    });

    test("conflict recovery copies keep all history and remain retry-idempotent", () => {
        const base = historyProject();
        const remote = parseCanvasProject(serializeCanvasProject({ ...base, title: "Remote" }));
        const local = { ...base, title: "Local", updatedAt: "next" };
        const changes = new Map([[base.id, { base, value: local, conflictId: "collision", savedAt: "next" }]]);
        const written = mergeProjectChanges([remote], changes).map(value => parseCanvasProject(serializeCanvasProject(value)));
        expect(written).toHaveLength(2);
        const copy = written.find(value => value.persistenceConflict)!;
        expect(copy.history).toEqual(plain(remote.history));
        expect(copy.nodes[0].metadata!.content).toBe(remote.nodes[0].metadata!.content);
        expect(mergeProjectChanges(written, changes)).toHaveLength(2);
    });

    test("malformed markers, fields and array patches fail instead of losing history", () => {
        const source = encodeCanvasProject(historyProject(1));
        const invalidHistory: unknown[] = [
            [], "bad", { format: "unknown", past: [], future: [] },
            { ...source.history, past: null }, { ...source.history, future: null }, { ...source.history, ignored: true },
            ...[
                null, { unknown: [] }, { set: [] }, { arrays: [] }, { remove: "nodes" },
                { set: { unknown: 1 } }, { remove: ["nodes", "nodes"] }, { remove: ["nodes"] }, { arrays: { activeChatId: {} } },
                { set: { nodes: [] }, remove: ["nodes"] }, { set: { nodes: null } },
                { set: { activeChatId: [] } }, { set: { backgroundMode: "unknown" } }, { set: { showImageInfo: null } },
                { arrays: { nodes: { kind: "unknown" } } },
                { arrays: { nodes: { kind: "splice", start: -1, deleteCount: 0, items: [] } } },
                { arrays: { nodes: { kind: "splice", start: 21, deleteCount: 0, items: [] } } },
                { arrays: { nodes: { kind: "splice", start: 0, deleteCount: 21, items: [] } } },
                { arrays: { nodes: { kind: "splice", start: 0.5, deleteCount: 0, items: [] } } },
                { arrays: { nodes: { kind: "splice", start: 0, deleteCount: 0, items: null } } },
                { arrays: { nodes: { kind: "items", length: 2 ** 32, changes: [] } } },
                { arrays: { nodes: { kind: "items", length: 20, changes: [[-1, {}]] } } },
                { arrays: { nodes: { kind: "items", length: 20, changes: [[20, {}]] } } },
                { arrays: { nodes: { kind: "items", length: 20, changes: [[1, {}], [1, {}]] } } },
                { arrays: { nodes: { kind: "items", length: 20, changes: [[2, {}], [1, {}]] } } },
                { arrays: { nodes: { kind: "items", length: 20, changes: [[1]] } } },
            ].map(frame => ({ ...source.history, past: [frame] })),
        ];
        for (const history of invalidHistory) expect(() => decodeCanvasProject({ ...source, history })).toThrow("历史数据损坏");
        const poisoned = JSON.parse('{"set":{"__proto__":{"polluted":true}}}');
        expect(() => decodeCanvasProject({ ...source, history: { ...source.history, past: [poisoned] } })).toThrow();
        expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    });
});
