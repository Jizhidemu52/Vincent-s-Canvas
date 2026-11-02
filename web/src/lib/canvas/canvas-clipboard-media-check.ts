import { getImageBlob } from "@/services/image-storage";
import { getMediaBlob } from "@/services/file-storage";
import { readMediaSource } from "@/services/canvas-media-links";
import type { CanvasNodeData } from "@/types/canvas";
import { mapCanvasAsyncPool } from "./canvas-async-pool";

/** Native clipboard node graphs contain references, not portable media bytes. */
export async function unavailableCanvasClipboardMedia(nodes: CanvasNodeData[], io = { getImageBlob, getMediaBlob, readMediaSource }) {
    const results = await mapCanvasAsyncPool(nodes, 3, async node => {
        if (!["image", "video", "audio"].includes(node.type)) return null;
        const { content = "", storageKey } = node.metadata || {};
        if (!content && !storageKey) return null;
        if (content && !content.startsWith("blob:")) return null;
        if (storageKey) {
            const blob = await (node.type === "image" ? io.getImageBlob(storageKey) : io.getMediaBlob(storageKey));
            if (blob || await io.readMediaSource(storageKey)) return null;
        }
        return node.id;
    });
    return results.filter((id): id is string => Boolean(id));
}
