export const compactHistoryAssetId = "66666666-7777-4888-8999-000000000000";

/** Synthetic large graph, with complete media elements inside each delta shape. */
export function largeCanvasDocument(id: string, assetId: string, nodeCount = 5000) {
    const date = "2026-10-09T00:00:00.000Z";
    const content = `PRIVATE-GRAPH-${id}: ${"original design instructions; ".repeat(5)}`;
    const nodes = Array.from({ length: nodeCount }, (_, index) => ({
        id: `node-${index}`, type: index === 0 ? "image" : "text", title: `设计节点 ${index}`,
        position: { x: (index % 100) * 420, y: Math.floor(index / 100) * 310 }, width: 360, height: 240,
        metadata: { content: index === 0 ? `/api/assets/${assetId}/content` : content, prompt: `PRIVATE-PROMPT-${id}-${index}`, extension: { preserve: true } },
    }));
    const historicalImage = (index: number) => ({ ...nodes[index]!, type: "image", metadata: { content: `/api/assets/${compactHistoryAssetId}/content`, prompt: "PRIVATE-HISTORY-IMAGE", extension: { preserve: true } } });
    const historyChat = {
        id: "history-chat", title: "历史讨论", createdAt: date, updatedAt: date,
        messages: [{ id: "history-message", role: "assistant", text: "PRIVATE-HISTORY-CHAT", attachments: [{ id: "history-output", mediaType: "image", url: `/api/assets/${compactHistoryAssetId}/content` }] }],
    };
    return {
        id, title: `大项目 ${id}`, createdAt: date, updatedAt: date, nodes,
        connections: nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, fromNodeId: nodes[index]!.id, toNodeId: node.id })),
        groups: [{ id: "style", title: "PRIVATE-STYLE", nodeIds: nodes.slice(0, 10).map(node => node.id), collapsed: true }],
        chatSessions: [{ ...historyChat, id: "current-chat", messages: [{ id: "current-message", role: "user", text: "PRIVATE-CURRENT-CHAT", attachments: [] }] }],
        activeChatId: "current-chat", backgroundMode: "dots", showImageInfo: true, viewport: { x: -180.25, y: 37.5, k: 0.625 },
        history: {
            format: "canvas-history-delta-v1",
            past: [
                { arrays: { nodes: { kind: "items", length: nodes.length, changes: [[3, historicalImage(3)], [nodeCount - 2, historicalImage(nodeCount - 2)]] } } },
                { set: { chatSessions: [historyChat] } },
            ],
            future: [{ arrays: { nodes: { kind: "splice", start: 4, deleteCount: 1, items: [historicalImage(4)] } } }],
        },
    };
}

export function expectedCanvasSummary(document: ReturnType<typeof largeCanvasDocument>) {
    return {
        id: document.id, title: document.title, createdAt: document.createdAt, updatedAt: document.updatedAt,
        nodeCount: document.nodes.length, connectionCount: document.connections.length,
        cover: { content: document.nodes[0]!.metadata.content },
    };
}
