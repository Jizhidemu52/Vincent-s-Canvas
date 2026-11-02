import { expect, test } from "bun:test";
import { canvasToolCallPreview, canvasToolCallsRequireConfirmation, expireCanvasToolConfirmations } from "@/lib/canvas/canvas-assistant-ux";
import { canvasAssistantDisplayMessage } from "@/lib/canvas/canvas-assistant-output";
import { CanvasNodeType, type CanvasAssistantMessage, type CanvasAssistantSession } from "@/types/canvas";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { ResponseToolCall } from "@/services/api/image";

const call = (name: string, input: unknown): ResponseToolCall => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(input) } });
test("destructive calls require approval even when ordinary confirmations are disabled", () => {
    expect(canvasToolCallsRequireConfirmation([call("canvas_delete_nodes", { ids: ["one"] })], false)).toBe(true);
    expect(canvasToolCallsRequireConfirmation([call("canvas_apply_ops", { ops: [{ type: "delete_node", id: "one" }] })], false)).toBe(true);
    expect(canvasToolCallsRequireConfirmation([call("canvas_apply_ops", { ops: [{ type: "delete_connections", ids: ["edge"] }] })], false)).toBe(true);
    expect(canvasToolCallsRequireConfirmation([call("canvas_create_text_node", { text: "hello" })], false)).toBe(false);
    expect(canvasToolCallsRequireConfirmation([call("canvas_create_text_node", { text: "hello" })], true)).toBe(true);
    expect(canvasToolCallsRequireConfirmation([call("canvas_get_state", {})], true)).toBe(false);
});

test("confirmation preview lists the real affected nodes and freezes the final prompt", () => {
    const snapshot: CanvasAgentSnapshot = { nodes: [{ id: "one", title: "原款", type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { content: "blob:original", storageKey: "image:one" } }, { id: "two", title: "说明", type: CanvasNodeType.Text, position: { x: 0, y: 0 }, width: 200, height: 200 }], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } };
    const preview = canvasToolCallPreview([call("canvas_delete_nodes", { ids: ["one", "two"] })], snapshot)[0];
    expect(preview).toMatchObject({ destructive: true, count: 2, nodes: [{ id: "one", title: "原款", url: "blob:original", storageKey: "image:one" }, { id: "two", title: "说明" }] });
    expect(canvasToolCallPreview([call("canvas_generate_image", { model: "gpt-image-2", prompt: "Keep the original silhouette." })], snapshot)[0]).toMatchObject({ model: "gpt-image-2", outputCount: 1, prompt: "Keep the original silhouette." });
});

test("restored pending confirmations expire without mutating source or a still-live context", () => {
    const sessions: CanvasAssistantSession[] = [{ id: "session", title: "review", createdAt: "now", updatedAt: "now", messages: [{ id: "old", role: "tool", text: "delete", detail: { status: "pending" } }, { id: "live", role: "tool", text: "create", detail: { status: "running" } }, { id: "done", role: "tool", text: "done", detail: { status: "completed" } }] }];
    const restored = expireCanvasToolConfirmations(sessions, new Set(["live"]));
    expect(restored[0].messages[0].detail?.status).toBe("expired");
    expect(restored[0].messages[1].detail?.status).toBe("running");
    expect(restored[0].messages[2].detail?.status).toBe("completed");
    expect(sessions[0].messages[0].detail?.status).toBe("pending");
});

test("unchanged display messages keep identity while edited text receives a fresh cached view", () => {
    const original: CanvasAssistantMessage = { id: "message", role: "assistant", text: "提示词：\n第一条\n第二条" };
    const display = canvasAssistantDisplayMessage(original);
    expect(canvasAssistantDisplayMessage(original)).toBe(display);
    expect(canvasAssistantDisplayMessage({ ...original, text: original.text + "\n第三条" })).not.toBe(display);
    expect(display?.text).toBe(original.text);
});
