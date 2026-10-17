import { shouldIgnoreCanvasShortcut } from "./canvas-keyboard";
import type { CanvasNodeGraph } from "./canvas-node-copy";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

const canvasNodesClipboardType = "application/x-vincent-canvas-nodes";
const popupSelector = "[role='dialog'],[role='menu'],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown";
const graphPrefix = "vincent-canvas-nodes:v1\n";

type CanvasCutSnapshot = {
    nodes: readonly CanvasNodeData[];
    connections: readonly CanvasConnection[];
    selectedIds: ReadonlySet<string>;
    requests: readonly { targetNodeId: string; originNodeId: string; runningNodeId: string }[];
    dispatchLocks: readonly string[];
};

/** Match the actual deletion scope; a cut must not discard the only owner of a paid task. */
export function canvasCutBlockReason({ nodes, connections, selectedIds, requests, dispatchLocks }: CanvasCutSnapshot): string | undefined {
    const allIds = new Set(selectedIds);
    nodes.forEach(node => {
        if (selectedIds.has(node.id)) node.metadata?.batchChildIds?.forEach(childId => allIds.add(childId));
    });
    const hasUnresolvedTask = nodes.some(node => allIds.has(node.id) && (
        node.metadata?.imageTask || node.metadata?.mediaTask || node.metadata?.generationSubmissionUncertain
        || node.metadata?.status === "loading"
        || (node.metadata?.status !== "success" && (node.metadata?.videoTaskId || node.metadata?.videoTaskCanRecover !== undefined || node.metadata?.textRequestId))
    ));
    const selectedConfigTargets = (nodeId: string) => connections.some(edge => edge.kind === "config-target" && allIds.has(edge.fromNodeId) && edge.toNodeId === nodeId);
    const hasActiveRequest = requests.some(request => allIds.has(request.targetNodeId) || allIds.has(request.originNodeId)
        || allIds.has(request.runningNodeId) || selectedConfigTargets(request.originNodeId));
    const hasActiveDispatch = dispatchLocks.some(nodeId => allIds.has(nodeId) || selectedConfigTargets(nodeId));
    return hasUnresolvedTask || hasActiveRequest || hasActiveDispatch
        ? "选区包含正在提交或尚未确认结果的任务，暂不能剪切。请先完成或查询原任务；仍可使用复制。"
        : undefined;
}

export function serializeCanvasClipboard(graph: CanvasNodeGraph): string {
    return graphPrefix + JSON.stringify(graph);
}

/** Clipboard contents are external input; reject broken graphs before changing the canvas. */
export function parseCanvasClipboard(value: string): CanvasNodeGraph | null {
    if (!value.startsWith(graphPrefix)) return null;
    try {
        const graph = JSON.parse(value.slice(graphPrefix.length));
        if (!Array.isArray(graph.nodes) || !graph.nodes.length || !Array.isArray(graph.connections)) return null;
        const ids = new Set<string>();
        for (const node of graph.nodes) {
            if (!node || typeof node.id !== "string" || ids.has(node.id) || !["image", "text", "config", "video", "audio"].includes(node.type)
                || typeof node.title !== "string" || !Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y)
                || !Number.isFinite(node.width) || node.width <= 0 || !Number.isFinite(node.height) || node.height <= 0) return null;
            ids.add(node.id);
            if (node.metadata !== undefined) {
                const metadata = node.metadata;
                if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
                for (const key of ["prompt", "composerContent", "draftPrompt", "content", "batchRootId", "primaryImageId"])
                    if (metadata[key] !== undefined && typeof metadata[key] !== "string") return null;
                for (const key of ["batchChildIds", "imageReferenceOrder", "excludedConnectedImageReferenceKeys"])
                    if (metadata[key] !== undefined && (!Array.isArray(metadata[key]) || !metadata[key].every((item: unknown) => typeof item === "string"))) return null;
                if (metadata.manualImageReferences !== undefined && (!Array.isArray(metadata.manualImageReferences)
                    || !metadata.manualImageReferences.every((item: Record<string, unknown>) => item && typeof item.id === "string" && typeof item.referenceKey === "string"))) return null;
            }
        }
        if (!graph.connections.every((edge: Record<string, unknown>) => edge && typeof edge.id === "string" && ids.has(edge.fromNodeId as string) && ids.has(edge.toNodeId as string))) return null;
        if (graph.groups !== undefined && (!Array.isArray(graph.groups) || !graph.groups.every((group: Record<string, unknown>) => group && typeof group.id === "string" && typeof group.title === "string" && Array.isArray(group.nodeIds) && group.nodeIds.every(id => ids.has(id))))) return null;
        return graph;
    } catch {
        return null;
    }
}

type CanvasClipboardActions = {
    copyNodes: () => CanvasNodeGraph | undefined;
    canCutNodes?: () => boolean;
    cutNodes?: () => void;
    pasteNodes: (graph: CanvasNodeGraph) => boolean;
    pasteImages: (files: File[]) => void;
    pasteText: (text: string) => boolean;
};

/** Native events carry screenshots on HTTP too; never require async clipboard permission. */
export function bindCanvasClipboardEvents(target: Pick<EventTarget, "addEventListener" | "removeEventListener">, actions: CanvasClipboardActions) {
    const ignore = (event: ClipboardEvent) => shouldIgnoreCanvasShortcut({ defaultPrevented: event.defaultPrevented, isComposing: false, keyCode: 0 }, event.target, true);
    const copy: EventListener = value => {
        const event = value as ClipboardEvent;
        if (ignore(event) || !event.clipboardData) return;
        if (event.type === "cut" && actions.canCutNodes?.() === false) {
            event.preventDefault();
            return;
        }
        const copied = actions.copyNodes();
        if (!copied) return;
        const payload = serializeCanvasClipboard(copied);
        event.clipboardData.setData("text/plain", payload);
        // Some browsers retain only standard formats; the text payload is complete too.
        try { event.clipboardData.setData(canvasNodesClipboardType, payload); } catch { /* text/plain remains usable */ }
        event.preventDefault();
        if (event.type === "cut") actions.cutNodes?.();
    };
    const paste: EventListener = value => {
        const event = value as ClipboardEvent;
        if (event.defaultPrevented || !event.clipboardData) return;
        const element = event.target as Element | null;
        const markedPrompt = element?.closest?.("[data-canvas-image-paste]") && !element.closest(popupSelector);
        const ignored = ignore(event);
        if (ignored && !markedPrompt) return;
        // files and items usually describe the same images: use items only as a fallback.
        let images = Array.from(event.clipboardData.files || []).filter(file => file.type.startsWith("image/"));
        if (!images.length) images = Array.from(event.clipboardData.items || []).flatMap(item => {
            const file = item.kind === "file" && item.type.startsWith("image/") ? item.getAsFile() : null;
            return file ? [file] : [];
        });
        if (images.length) {
            event.preventDefault();
            actions.pasteImages(images);
            return;
        }
        if (ignored) return; // A marked prompt still owns ordinary text paste.
        const token = event.clipboardData.getData(canvasNodesClipboardType);
        if (token) {
            const graph = parseCanvasClipboard(token);
            if (graph) actions.pasteNodes(graph);
            event.preventDefault();
            return;
        }
        const text = event.clipboardData.getData("text/plain");
        if (text.startsWith("vincent-canvas-nodes:")) {
            const graph = parseCanvasClipboard(text);
            if (graph) actions.pasteNodes(graph);
            event.preventDefault();
            return;
        }
        if (text.trim() && actions.pasteText(text)) event.preventDefault();
    };
    target.addEventListener("copy", copy);
    target.addEventListener("cut", copy);
    target.addEventListener("paste", paste);
    return () => {
        target.removeEventListener("copy", copy);
        target.removeEventListener("cut", copy);
        target.removeEventListener("paste", paste);
    };
}

type ClipboardReader = {
    read?: () => Promise<readonly { types: readonly string[]; getType: (type: string) => Promise<Blob> }[]>;
    readText?: () => Promise<string>;
};

export type CanvasClipboardContent = { kind: "image"; blob: Blob; type: string } | { kind: "text"; text: string };

export async function readCanvasSystemClipboard(clipboard: ClipboardReader | undefined): Promise<CanvasClipboardContent> {
    if (!clipboard) throw new Error("当前浏览器不支持读取剪切板，请使用上传或拖入图片");
    try {
        if (clipboard.read) {
            const items = await clipboard.read();
            const imageItem = items.find(item => item.types.some(type => type.startsWith("image/")));
            const type = imageItem?.types.find(type => type.startsWith("image/"));
            if (imageItem && type) return { kind: "image", blob: await imageItem.getType(type), type };
            const textItem = items.find(item => item.types.includes("text/plain"));
            if (textItem) return { kind: "text", text: await (await textItem.getType("text/plain")).text() };
        }
        if (clipboard.readText) return { kind: "text", text: await clipboard.readText() };
        throw new Error("当前浏览器不支持读取剪切板，请使用上传或拖入图片");
    } catch (error) {
        if (error instanceof Error && ["NotAllowedError", "SecurityError"].includes(error.name)) {
            throw new Error("浏览器未允许读取剪切板，请允许剪切板权限后重试，或使用上传/拖入图片");
        }
        throw error;
    }
}
