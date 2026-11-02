import type { ResponseToolCall } from "@/services/api/image";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "./canvas-agent-ops";
import type { CanvasAssistantSession } from "@/types/canvas";

function toolArguments(call: ResponseToolCall): Record<string, unknown> {
    try { const value = JSON.parse(call.function.arguments); return value && typeof value === "object" ? value : {}; }
    catch { return {}; }
}
export function canvasOpsDeleteContent(ops: CanvasAgentOp[] = []) {
    return ops.some(op => op.type === "delete_node" || op.type === "delete_connections");
}
export function canvasToolCallsRequireConfirmation(calls: ResponseToolCall[], confirmWrites: boolean) {
    return calls.some(call => {
        if (["look_at_images", "canvas_get_state", "canvas_get_selection", "canvas_export_snapshot", "edit_image", "generate_video"].includes(call.function.name)) return false;
        const input = toolArguments(call);
        return confirmWrites || call.function.name === "canvas_delete_nodes" || (Array.isArray(input.ops) && canvasOpsDeleteContent(input.ops));
    });
}
export function canvasToolCallPreview(calls: ResponseToolCall[], snapshot: CanvasAgentSnapshot) {
    return calls.map(call => {
        const input = toolArguments(call);
        const ops = Array.isArray(input.ops) ? input.ops as CanvasAgentOp[] : [];
        const ids = new Set<string>([input.nodeId, input.id, ...(Array.isArray(input.nodeIds) ? input.nodeIds : []), ...(Array.isArray(input.ids) ? input.ids : [])].filter((id): id is string => typeof id === "string"));
        for (const op of ops) {
            if ("id" in op && op.id) ids.add(op.id);
            if ("ids" in op && op.ids) for (const id of op.ids) ids.add(id);
            if (op.type === "delete_node" && op.nodeType) for (const node of snapshot.nodes) if (node.type === op.nodeType) ids.add(node.id);
        }
        if (call.function.name === "canvas_delete_nodes" && typeof input.nodeType === "string") for (const node of snapshot.nodes) if (node.type === input.nodeType) ids.add(node.id);
        const destructive = call.function.name === "canvas_delete_nodes" || canvasOpsDeleteContent(ops);
        return { action: destructive ? "删除" : "画布操作", destructive, count: ids.size || (Array.isArray(input.nodes) ? input.nodes.length : 1), nodes: snapshot.nodes.filter(node => ids.has(node.id)).map(node => ({ id: node.id, title: node.title, ...(node.type === "image" ? { url: node.metadata?.content, storageKey: node.metadata?.storageKey } : {}) })), ...(typeof input.model === "string" ? { model: input.model } : {}), ...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}), ...(call.function.name.includes("generate") ? { outputCount: 1 } : {}) };
    });
}
export function expireCanvasToolConfirmations(sessions: CanvasAssistantSession[], liveIds: ReadonlySet<string> = new Set()) {
    return sessions.map(session => ({ ...session, messages: session.messages.map(message => message.role === "tool" && !liveIds.has(message.id) && ["pending", "running"].includes(String(message.detail?.status)) ? { ...message, title: "确认已过期", text: "该操作的执行上下文已失效，尚未重新提交。请恢复原问题到输入框，核对后再发送。", detail: { ...message.detail, status: "expired" } } : message) }));
}
