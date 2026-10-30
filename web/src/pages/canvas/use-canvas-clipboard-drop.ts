import { uiText } from "@/lib/i18n";
import { useCallback, useEffect, useLayoutEffect, useRef, type DragEvent } from "react";
import type { CanvasNodeGraph } from "@/lib/canvas/canvas-node-copy";
import type { canvasCutBlockReason } from "@/lib/canvas/canvas-system-clipboard";
import type { Position } from "@/types/canvas";
import { isExternalImageDrag, snapshotImageDrop } from "@/lib/dropped-images";
import { useUserStore } from "@/stores/use-user-store";

export const isCanvasAudioFile = (file: File) => file.type.startsWith("audio/") || /\.(mp3|wav)$/i.test(file.name);
type Options = {
    scopeKey: string;
    copyNodes: () => CanvasNodeGraph | undefined;
    getCutSnapshot: () => Parameters<typeof canvasCutBlockReason>[0];
    cutNodes: () => void;
    pasteNodes: (graph: CanvasNodeGraph) => boolean;
    pasteImages: (files: File[]) => void;
    pasteText: (text: string) => boolean;
    screenToCanvas: (x: number, y: number) => Position;
    importFiles: (files: File[], position: Position) => Promise<void>;
    warning: (message: string) => unknown;
    error: (message: string) => unknown;
    onReadingChange: (reading: boolean) => void;
};
export function useCanvasClipboardDrop(options: Options) {
    const owner = useUserStore(state => `${state.status}:${state.user?.id || ""}`);
    const latest = useRef({ ...options, owner });
    const request = useRef<AbortController | null>(null);
    useLayoutEffect(() => { latest.current = { ...options, owner }; });
    useEffect(() => {
        options.onReadingChange(false);
        return () => { request.current?.abort(); request.current = null; };
    }, [options.scopeKey, owner]);
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
        }).catch(() => { if (!disposed) latest.current.warning(uiText("剪贴板加载失败，请刷新后重试")); });
        return () => { disposed = true; unbind?.(); };
    }, []);
    return useCallback(async (event: DragEvent<HTMLElement>) => {
        if (!isExternalImageDrag(event.dataTransfer)) return;
        event.preventDefault(); event.stopPropagation();
        const io = latest.current;
        if (request.current) { io.warning(uiText("正在读取拖入图片，请稍候。")); return; }
        const controller = new AbortController(); request.current = controller;
        const current = () => request.current === controller && !controller.signal.aborted && latest.current.scopeKey === io.scopeKey && latest.current.owner === io.owner;
        const point = io.screenToCanvas(event.clientX, event.clientY);
        io.onReadingChange(true);
        try {
            const snapshot = snapshotImageDrop(event.dataTransfer);
            const { readImageDrop } = await import("@/lib/dropped-images");
            const result = await readImageDrop(snapshot, { signal: controller.signal, allowNonImages: true });
            if (!current()) return;
            const files = result.files.filter(file => file.type.startsWith("image/") || file.type.startsWith("video/") || isCanvasAudioFile(file));
            if (files.length !== result.files.length) io.warning(uiText("仅支持图片、视频和音频，其他文件已跳过"));
            if (files.length) await io.importFiles(files, point);
        } catch (error) {
            if (current()) io.error(error instanceof Error && error.name !== "TypeError" && error.name !== "TimeoutError" ? uiText(error.message) : uiText("无法读取拖入图片，请打开企业微信原图后重试，或保存到桌面再拖入。"));
        } finally {
            if (request.current === controller) { request.current = null; io.onReadingChange(false); }
        }
    }, []);
}
