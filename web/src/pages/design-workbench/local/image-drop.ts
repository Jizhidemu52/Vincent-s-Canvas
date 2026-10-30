import { isExternalImageDrag, readImageDrop, snapshotImageDrop } from "@/lib/dropped-images";
import type { LocalWorkbenchServices } from "./services";

/** Native-DOM workbenches share the same image reader as React pages. */
export function bindLocalImageDrop(root: HTMLElement, services: LocalWorkbenchServices, options: {
    scopeKey: () => number;
    disabled: () => boolean;
    onFiles: (files: File[], target: Element | null) => Promise<void>;
}) {
    let depth = 0, busy = false;
    const clear = () => { depth = 0; delete root.dataset.imageDrag; };
    const eventOptions = { signal: services.signal };
    root.addEventListener("dragenter", event => {
        if (!event.dataTransfer || !isExternalImageDrag(event.dataTransfer)) return;
        event.preventDefault(); event.stopPropagation(); depth++;
        if (!busy && !options.disabled()) root.dataset.imageDrag = "true";
    }, eventOptions);
    root.addEventListener("dragleave", event => {
        if (!event.dataTransfer || !isExternalImageDrag(event.dataTransfer)) return;
        event.preventDefault(); event.stopPropagation(); depth = Math.max(0, depth - 1);
        if (!depth) clear();
    }, eventOptions);
    root.addEventListener("dragover", event => {
        if (!event.dataTransfer || !isExternalImageDrag(event.dataTransfer)) return;
        event.preventDefault(); event.stopPropagation();
        event.dataTransfer.dropEffect = busy || options.disabled() ? "none" : "copy";
    }, eventOptions);
    root.addEventListener("drop", async event => {
        if (!event.dataTransfer || !isExternalImageDrag(event.dataTransfer)) return;
        event.preventDefault(); event.stopPropagation(); clear();
        if (busy || options.disabled()) { services.notify("当前暂不能添加图片，请完成正在进行的操作后再拖入。", "error"); return; }
        const scope = options.scopeKey(), target = event.target instanceof Element ? event.target : null;
        const snapshot = snapshotImageDrop(event.dataTransfer);
        busy = true; root.setAttribute("aria-busy", "true");
        services.notify("正在读取拖入图片，请稍候。");
        try {
            services.assertCurrent();
            const result = await readImageDrop(snapshot, { signal: services.signal });
            services.assertCurrent();
            if (scope !== options.scopeKey() || options.disabled()) return;
            if (result.skipped) services.notify("非图片文件已跳过，请拖入图片原件。", "error");
            await options.onFiles(result.files, target);
        } catch (error) {
            if (!services.signal.aborted && scope === options.scopeKey()) services.notify(error instanceof Error && error.name !== "TypeError" && error.name !== "TimeoutError" ? error.message : "无法读取拖入图片，请打开企业微信原图后重试，或保存到桌面再拖入。", "error");
        } finally { busy = false; root.removeAttribute("aria-busy"); }
    }, eventOptions);
    services.signal.addEventListener("abort", clear, { once: true });
}
