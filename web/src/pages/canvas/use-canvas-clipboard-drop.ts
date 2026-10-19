import { useCallback, useEffect, useLayoutEffect, useRef, type DragEvent } from "react";
import type { CanvasNodeGraph } from "@/lib/canvas/canvas-node-copy";
import type { canvasCutBlockReason } from "@/lib/canvas/canvas-system-clipboard";
import type { Position } from "@/types/canvas";

export const isCanvasAudioFile = (file: File) => file.type.startsWith("audio/") || /\.(mp3|wav)$/i.test(file.name);
type Options = {
    copyNodes: () => CanvasNodeGraph | undefined;
    getCutSnapshot: () => Parameters<typeof canvasCutBlockReason>[0];
    cutNodes: () => void;
    pasteNodes: (graph: CanvasNodeGraph) => boolean;
    pasteImages: (files: File[]) => void;
    pasteText: (text: string) => boolean;
    screenToCanvas: (x: number, y: number) => Position;
    createImage: (file: File, position: Position) => Promise<unknown>;
    createVideo: (file: File, position: Position) => Promise<unknown>;
    createAudio: (file: File, position: Position) => Promise<unknown>;
    warning: (message: string) => unknown;
    error: (message: string) => unknown;
};
export function useCanvasClipboardDrop(options: Options) {
    const latest = useRef(options);
    useLayoutEffect(() => { latest.current = options; });
    useEffect(() => {
        let disposed = false;
        let unbind: (() => void) | undefined;
        void import("@/lib/canvas/canvas-system-clipboard").then(({ bindCanvasClipboardEvents, canvasCutBlockReason }) => {
            if (disposed) return;
            unbind = bindCanvasClipboardEvents(window, {
                copyNodes: () => latest.current.copyNodes(),
                canCutNodes: () => {
                    const reason = canvasCutBlockReason(latest.current.getCutSnapshot());
                    if (reason) latest.current.warning(reason);
                    return !reason;
                },
                cutNodes: () => latest.current.cutNodes(),
                pasteNodes: graph => latest.current.pasteNodes(graph),
                pasteImages: files => latest.current.pasteImages(files),
                pasteText: text => latest.current.pasteText(text),
            });
        }).catch(() => { if (!disposed) latest.current.warning("剪贴板加载失败，请刷新后重试"); });
        return () => { disposed = true; unbind?.(); };
    }, []);
    return useCallback(async (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        const dropped = Array.from(event.dataTransfer.files);
        const files = dropped.filter(file => file.type.startsWith("image/") || file.type.startsWith("video/") || isCanvasAudioFile(file));
        const io = latest.current;
        if (files.length !== dropped.length) io.warning("仅支持图片、视频和音频，其他文件已跳过");
        const point = io.screenToCanvas(event.clientX, event.clientY);
        for (const [index, file] of files.entries()) {
            const position = { x: point.x + index * 36, y: point.y + index * 36 };
            try {
                await (isCanvasAudioFile(file) ? io.createAudio(file, position) : file.type.startsWith("video/") ? io.createVideo(file, position) : io.createImage(file, position));
            } catch (error) {
                io.error(`${file.name}：${error instanceof Error ? error.message : "素材导入失败"}`);
            }
        }
    }, []);
}
