import { expect, test } from "bun:test";
import { describeCanvasHistoryChange } from "@/lib/canvas/canvas-history-description";
import type { CanvasHistorySnapshot } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType } from "@/types/canvas";

function snapshot(): CanvasHistorySnapshot {
    return {
        nodes: ["one", "two"].map(id => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 80,
            metadata: { content: "data:image/png;base64," + "A".repeat(1024), storageKey: `image:${id}` } })),
        connections: [], groups: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false,
    };
}

test("snapshot descriptions distinguish add, delete, resize, configuration and independent view changes", () => {
    const before = snapshot();
    expect(describeCanvasHistoryChange({ ...before, nodes: [] }, before)).toBe("新增 2 个节点");
    expect(describeCanvasHistoryChange(before, { ...before, nodes: [] })).toBe("删除 2 个节点");
    expect(describeCanvasHistoryChange(before, { ...before, nodes: before.nodes.map(node => ({ ...node, width: 200 })) })).toBe("调整 2 个节点大小");
    const config = { ...before, nodes: [{ ...before.nodes[0], type: CanvasNodeType.Config }] };
    expect(describeCanvasHistoryChange(config, { ...config, nodes: [{ ...config.nodes[0], metadata: { prompt: "new" } }] })).toBe("调整 1 个配置节点");
    expect(describeCanvasHistoryChange(before, { ...before, backgroundMode: "blank" })).toBe("切换画布背景");
    expect(describeCanvasHistoryChange(before, { ...before, connections: [{ id: "edge", fromNodeId: "one", toNodeId: "two" }] })).toBe("调整连线");
    expect(describeCanvasHistoryChange(before, { ...before, groups: [{ id: "group", title: "组", nodeIds: ["one", "two"], collapsed: true }] })).toBe("调整分组");
});

test("expanded snapshots still identify pure moves without serializing or mutating image data", () => {
    const before = snapshot(), after = structuredClone(before);
    after.nodes[0].position = { x: 200, y: 300 };
    expect(describeCanvasHistoryChange(before, after)).toBe("移动 1 个节点");
    expect(before.nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(after.nodes[0].metadata).toEqual(before.nodes[0].metadata);
    after.nodes[0].title = "新的名称";
    expect(describeCanvasHistoryChange(before, after)).toBe("修改 1 个节点");
});
