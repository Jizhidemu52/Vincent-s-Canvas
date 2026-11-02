import { getImageBlob, resolveImageUrl } from "@/services/image-storage";
import { prepareCanvasImageFormat } from "./canvas-image-encoding";
import type { CanvasNodeData } from "@/types/canvas";

/** Explicit image copy is separate from the lossless canvas graph clipboard. */
export async function copyCanvasImageToClipboard(node: CanvasNodeData) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("此浏览器地址不支持复制图片，请下载原图后拖入微信或 Photoshop；画布节点仍可用 Ctrl+C 复制。");
    const png = (async () => {
        let blob = node.metadata?.storageKey ? await getImageBlob(node.metadata.storageKey) : null;
        if (!blob) {
            const source = await resolveImageUrl(node.metadata?.storageKey, node.metadata?.content || "");
            const response = await fetch(source, { signal: AbortSignal.timeout(30000) });
            if (!response.ok) throw new Error("读取图片失败，请先恢复网络或下载原图");
            blob = await response.blob();
        }
        return (await prepareCanvasImageFormat(blob, "png")).blob;
    })();
    // Keep the write call in the user's activation while image decoding is pending.
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
