import { App } from "antd";
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import { isExternalImageDrag, snapshotImageDrop } from "@/lib/dropped-images";
import { uiText } from "@/lib/i18n";
import { useUserStore } from "@/stores/use-user-store";

type Options = { onFiles: (files: File[]) => void | Promise<void>; disabled?: boolean; disabledMessage?: string; scopeKey: string; allowNonImages?: boolean };

/** Shared external drag handling; importing files never submits a generation request. */
export function useImageDrop(options: Options) {
    const { message } = App.useApp();
    const owner = useUserStore(state => `${state.status}:${state.user?.id || ""}`);
    const latest = useRef({ options, owner });
    const request = useRef<AbortController | null>(null);
    const depth = useRef(0);
    const [dragging, setDragging] = useState(false);
    const [reading, setReading] = useState(false);
    useLayoutEffect(() => { latest.current = { options, owner }; });
    useEffect(() => {
        depth.current = 0; setDragging(false); setReading(false);
        return () => { request.current?.abort(); request.current = null; };
    }, [options.scopeKey, owner]);
    const dropProps = {
        onDragEnter(event: DragEvent<HTMLElement>) {
            if (!isExternalImageDrag(event.dataTransfer)) return;
            event.preventDefault(); event.stopPropagation(); depth.current += 1;
            if (!options.disabled && !request.current) setDragging(true);
        },
        onDragLeave(event: DragEvent<HTMLElement>) {
            if (!isExternalImageDrag(event.dataTransfer)) return;
            event.preventDefault(); event.stopPropagation();
            depth.current = Math.max(0, depth.current - 1);
            if (!depth.current) setDragging(false);
        },
        onDragOver(event: DragEvent<HTMLElement>) {
            if (!isExternalImageDrag(event.dataTransfer)) return;
            event.preventDefault(); event.stopPropagation();
            event.dataTransfer.dropEffect = options.disabled || request.current ? "none" : "copy";
        },
        async onDrop(event: DragEvent<HTMLElement>) {
            if (!isExternalImageDrag(event.dataTransfer)) return;
            event.preventDefault(); event.stopPropagation(); depth.current = 0; setDragging(false);
            if (options.disabled) { message.warning(uiText(options.disabledMessage || "当前暂不能添加图片，请完成正在进行的操作后再拖入。")); return; }
            if (request.current) { message.info(uiText("正在读取拖入图片，请稍候。")); return; }
            const scope = options.scopeKey, capturedOwner = owner, onFiles = options.onFiles;
            const controller = new AbortController(); request.current = controller; setReading(true);
            const current = () => request.current === controller && !controller.signal.aborted && latest.current.owner === capturedOwner && latest.current.options.scopeKey === scope;
            try {
                const snapshot = snapshotImageDrop(event.dataTransfer);
                const { readImageDrop } = await import("@/lib/dropped-images");
                const result = await readImageDrop(snapshot, { signal: controller.signal, allowNonImages: options.allowNonImages });
                if (!current()) return;
                if (latest.current.options.disabled) { message.warning(uiText("当前暂不能添加图片，请完成正在进行的操作后再拖入。")); return; }
                if (result.skipped) message.warning(uiText("非图片文件已跳过，请拖入图片原件。"));
                await onFiles(result.files);
            } catch (error) {
                if (current()) message.error(error instanceof Error && error.name !== "TypeError" && error.name !== "TimeoutError" ? uiText(error.message) : uiText("无法读取拖入图片，请打开企业微信原图后重试，或保存到桌面再拖入。"));
            } finally {
                if (request.current === controller) { request.current = null; setReading(false); }
            }
        },
    };
    return { dropProps, dragging, reading };
}
