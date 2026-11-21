import type { TryoutBoardCell } from "../../../../shared/tryout";
import type { CanvasNodeData } from "@/types/canvas";
import { isCanvasPdfImage } from "@/lib/canvas/canvas-image-export-selection";

function ready(node: CanvasNodeData) {
    return isCanvasPdfImage(node) && !node.metadata?.proposalBoard && node.metadata?.status !== "loading" && node.metadata?.status !== "error";
}

export function collectTryoutCells(selectedIds: readonly string[], nodes: readonly CanvasNodeData[]): TryoutBoardCell[] | null {
    const images = nodes.filter(ready).sort((a,b)=>(a.metadata?.tryout?.timing?.droppedAt ?? 0)-(b.metadata?.tryout?.timing?.droppedAt ?? 0));
    const byId = new Map(images.map(node => [node.id, node]));
    const members = new Map<string, CanvasNodeData[]>(), wears = new Map<string, string[]>();
    for (const node of images) {
        const meta = node.metadata?.tryout;
        if (!meta || meta.version !== 1 || meta.kind === "original") continue;
        if (meta.kind === "wear") {
            const source = byId.get(meta.sourceNodeId);
            if (!source || source.metadata?.tryout?.kind === "wear" || (source.metadata?.tryout?.rootNodeId ?? source.id) !== meta.rootNodeId) continue;
            if (!wears.has(source.id)) wears.set(source.id, []);
            wears.get(source.id)!.push(node.id);
        } else {
            if (!members.has(meta.rootNodeId)) members.set(meta.rootNodeId, []);
            members.get(meta.rootNodeId)!.push(node);
        }
    }
    const selected = [...new Set(selectedIds)].flatMap(id => byId.get(id) ?? []);
    if (!selected.some(n => n.metadata?.tryout || members.has(n.id) || wears.has(n.id))) return null;
    const result = new Map<string, CanvasNodeData>();
    for (const node of selected) {
        const meta = node.metadata?.tryout;
        if (meta?.kind === "wear") {
            if (wears.get(meta.sourceNodeId)?.includes(node.id)) result.set(meta.sourceNodeId, byId.get(meta.sourceNodeId)!);
        } else if ((!meta || meta.kind === "original") && selected.length === 1) {
            const styles = [node, ...(members.get(node.id) ?? [])];
            const picks = styles.filter(n => n.metadata?.tryout?.picked);
            for (const style of picks.length ? picks : styles) result.set(style.id, style);
        } else result.set(node.id, node);
    }
    return [...result.values()].map(node => {
        const meta = node.metadata?.tryout;
        return { styleNodeId: node.id, wearNodeIds: wears.get(node.id) ?? [], label: meta?.material?.name || meta?.color?.name || node.title, color: meta?.color };
    });
}
