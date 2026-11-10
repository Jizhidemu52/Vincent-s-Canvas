import { getImageBlob, resolveImageUrl } from "@/services/image-storage";
import { prepareCanvasImageFormat } from "./canvas-image-encoding";
import type { CanvasNodeData } from "@/types/canvas";

type ImageClipboardOptions = { signal?: AbortSignal; assertCurrent?: () => void; original?: Promise<Blob>; text?: string };

/** Resolve the stored original, never a thumbnail fallback belonging to a missing file. */
export async function loadCanvasClipboardImage(node: CanvasNodeData, options: ImageClipboardOptions = {}) {
    const check = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
    check();
    let blob = node.metadata?.storageKey ? await getImageBlob(node.metadata.storageKey) : null;
    check();
    if (!blob) {
        const source = await resolveImageUrl(node.metadata?.storageKey, node.metadata?.storageKey ? "" : node.metadata?.content || "");
        check();
        if (!source) throw new Error("原图暂时无法读取");
        const response = await fetch(source, { signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(30000)]) });
        if (!response.ok) throw new Error("读取图片失败，请先恢复网络或下载原图");
        blob = await response.blob();
    }
    check();
    await prepareCanvasImageFormat(blob, "original", undefined, { signal: options.signal });
    check();
    return blob;
}

/** Explicit image copy is separate from the lossless canvas graph clipboard. */
export async function copyCanvasImageToClipboard(node: CanvasNodeData, options: ImageClipboardOptions = {}) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("此浏览器地址不支持复制图片，请下载原图后拖入微信或 Photoshop；画布节点仍可用 Ctrl+C 复制。");
    const png = (async () => {
        const blob = await (options.original || loadCanvasClipboardImage(node, options));
        options.signal?.throwIfAborted(); options.assertCurrent?.();
        const result = await prepareCanvasImageFormat(blob, "png", undefined, { signal: options.signal });
        options.signal?.throwIfAborted(); options.assertCurrent?.();
        return result.blob;
    })();
    void png.catch(() => undefined); // A denied write may not consume the lazy ClipboardItem data.
    // Keep the write call in the user's activation while image decoding is pending.
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png, ...(options.text ? { "text/plain": new Blob([options.text], { type: "text/plain" }) } : {}) })]);
    options.signal?.throwIfAborted(); options.assertCurrent?.();
}
