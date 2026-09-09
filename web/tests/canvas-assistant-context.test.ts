import { expect, test } from "bun:test";
import { buildCanvasAssistantContext, selectCanvasContext } from "@/lib/canvas/canvas-assistant-context";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function node(id: string, type = CanvasNodeType.Image, x = 100, y = 100): CanvasNodeData {
    return { id, type, title: id, position: { x, y }, width: 100, height: 100, metadata: { content: `content-${id}`, status: "success" } };
}
function snapshot(nodes: CanvasNodeData[], extra: Partial<CanvasAgentSnapshot> = {}): CanvasAgentSnapshot {
    return { projectId: "p", title: "项目", nodes, connections: [], selectedNodeIds: [], viewport: { x: -200, y: -100, k: 2 }, viewportSize: { width: 800, height: 600 }, ...extra };
}
const readers = { image: async (item: CanvasNodeData) => `data:image/png;base64,${item.id}`, video: async () => [{ seconds: 0, dataUrl: "data:image/jpeg;base64,start" }, { seconds: 3, dataUrl: "data:image/jpeg;base64,end" }] };

test("only viewport intersections are automatic; preview and selection have priority even offscreen", () => {
    const result = selectCanvasContext(snapshot([node("visible"), node("partial", CanvasNodeType.Text, 490), node("edge", CanvasNodeType.Text, 500), node("off", CanvasNodeType.Image, 900), node("selected", CanvasNodeType.Image, -1000), node("preview", CanvasNodeType.Image, 3000)], { selectedNodeIds: ["selected"], previewNodeId: "preview" }));
    expect(result.nodes.map((item) => item.node.id)).toEqual(["preview", "selected", "visible", "partial"]);
    expect(result.nodes[0]).toMatchObject({ previewing: true, visible: false });
    expect(result.nodes[1]).toMatchObject({ selected: true, visible: false });
});

test("viewport movement refreshes automatic context, without retaining previous images", () => {
    const first = snapshot([node("left"), node("right", CanvasNodeType.Image, 900)]);
    expect(selectCanvasContext(first).nodes.map(({ node }) => node.id)).toEqual(["left"]);
    expect(selectCanvasContext({ ...first, viewport: { x: -900, y: 0, k: 1 } }).nodes.map(({ node }) => node.id)).toEqual(["right"]);
});
test("fully panel-covered nodes are not visible; partially exposed and explicitly selected nodes still count", () => {
    const value = snapshot([node("covered"), node("partial", CanvasNodeType.Image, 160), node("selected")], { selectedNodeIds: ["selected"], viewportOcclusions: [{ x: 0, y: 0, width: 100, height: 600 }, { x: 100, y: 0, width: 100, height: 600 }] });
    expect(selectCanvasContext(value).nodes.map(({ node }) => node.id)).toEqual(["selected", "partial"]);
    expect(selectCanvasContext(value).nodes[0].visible).toBe(false);
});

test("collapsed batch children and missing viewport dimensions do not count as visible", () => {
    const root = node("root"); root.metadata!.isBatchRoot = true;
    const child = node("child"); child.metadata!.batchRootId = "root";
    expect(selectCanvasContext(snapshot([root, child])).nodes.map(({ node }) => node.id)).toEqual(["root"]);
    expect(selectCanvasContext(snapshot([node("image")], { viewportSize: undefined })).nodes).toEqual([]);
});

test("unselected logo pixels, timestamped video frames and text actually reach model content", async () => {
    const result = await buildCanvasAssistantContext(snapshot([node("logo"), node("clip", CanvasNodeType.Video), node("copy", CanvasNodeType.Text), node("audio", CanvasNodeType.Audio)]), new Set(), readers);
    expect(result.content.filter((part) => part.type === "image_url").map((part: any) => part.image_url.url)).toEqual(["data:image/png;base64,logo", "data:image/jpeg;base64,start", "data:image/jpeg;base64,end"]);
    expect(JSON.stringify(result.content)).toContain("3.00 秒");
    expect(result.summary.items.find((item) => item.id === "copy")?.text).toBe("content-copy");
    expect(result.summary.items.find((item) => item.id === "audio")?.reading).toContain("未收听");
    expect(JSON.stringify(result.summary)).not.toContain("base64");
});

test("explicit images are not duplicated and an unreadable asset does not block usable context", async () => {
    const result = await buildCanvasAssistantContext(snapshot([node("explicit"), node("broken"), node("good"), node("copy", CanvasNodeType.Text)]), new Set(["explicit"]), { ...readers, image: async (node) => { if (node.id === "broken") throw new Error("unreadable"); return readers.image(node); } });
    expect(result.content.filter((part) => part.type === "image_url")).toHaveLength(1);
    expect(result.summary.items.find((item) => item.id === "broken")?.reading).toContain("读取失败");
    expect(result.summary.items.find((item) => item.id === "copy")?.text).toBe("content-copy");
});

test("large canvases bound node, image and text work and disclose omitted items", async () => {
    const images = Array.from({ length: 40 }, (_, index) => node(`image-${index}`));
    const result = await buildCanvasAssistantContext(snapshot(images, { selectedNodeIds: ["image-39"] }), new Set(), readers);
    expect(result.summary).toMatchObject({ total: 40, included: 24, omitted: 16 });
    expect(result.summary.items[0].id).toBe("image-39");
    expect(result.content.filter((part) => part.type === "image_url")).toHaveLength(6);
    const texts = Array.from({ length: 20 }, (_, index) => ({ ...node(`text-${index}`, CanvasNodeType.Text), metadata: { content: "x".repeat(10000) } }));
    const textResult = await buildCanvasAssistantContext(snapshot(texts), new Set(), readers);
    expect(textResult.summary.items.reduce((total, item) => total + item.text.length, 0)).toBe(12000);
    expect(textResult.summary.items[0].reading).toContain("截断");
});
