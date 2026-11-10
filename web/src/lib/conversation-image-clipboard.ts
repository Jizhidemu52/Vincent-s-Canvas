import copyToClipboard from "copy-to-clipboard";
import { useUserStore } from "@/stores/use-user-store";
import { createClientUuid } from "./client-uuid";
import { pastedImageFiles } from "./clipboard-images";
import { copyCanvasImageToClipboard, loadCanvasClipboardImage } from "./canvas/canvas-image-clipboard";
import type { CanvasNodeData } from "@/types/canvas";

const prefix = "trucreate-image:v1:";
const expired = () => new Error("复制的图片已失效，请重新复制");
const owner = () => {
    const state = useUserStore.getState();
    return state.status === "authenticated" && state.user?.status === "active" ? state.user.id : null;
};
type CopiedImage = { token: string; ownerId: string; file: Promise<File>; controller: AbortController };
let copied: CopiedImage | undefined;
let subscribed = false;

function watchOwner() {
    if (subscribed) return;
    subscribed = true;
    useUserStore.subscribe(() => {
        if (copied && owner() !== copied.ownerId) { copied.controller.abort(); copied = undefined; }
    });
}

/** One in-memory original. The OS clipboard must carry this exact opaque token to reuse it. */
export async function copyConversationImage(node: CanvasNodeData, signal?: AbortSignal): Promise<"system" | "page"> {
    watchOwner();
    const ownerId = owner();
    if (!ownerId) throw expired();
    signal?.throwIfAborted();
    copied?.controller.abort();
    const controller = new AbortController();
    const lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const token = prefix + createClientUuid();
    const check = () => { lifetime.throwIfAborted(); if (owner() !== ownerId || copied?.token !== token) throw expired(); };
    // Start reading before the first await, but call clipboard.write/execCommand in the click activation.
    const original = Promise.resolve().then(() => { check(); return loadCanvasClipboardImage(node, { signal: lifetime, assertCurrent: check }); });
    const file = original.then(blob => {
        check();
        if (blob.size > 20 * 1024 * 1024) throw new Error("单个附件不能超过 20 MB，请拆分文件后上传");
        return new File([blob], node.metadata?.originalFileName || node.title || "image.png", { type: blob.type });
    });
    const entry = { token, ownerId, file, controller };
    copied = entry;
    void file.catch(() => { if (copied === entry) { controller.abort(); copied = undefined; } });
    try {
        let mode: "system" | "page" = "page";
        if (typeof navigator.clipboard?.write === "function" && typeof ClipboardItem !== "undefined") {
            try {
                await copyCanvasImageToClipboard(node, { original, text: token, signal: lifetime, assertCurrent: check });
                mode = "system";
            } catch (error) {
                check();
                if (!await copyToClipboard(token, { format: "text/plain", fallbackToPrompt: false })) throw error;
            }
        } else if (!await copyToClipboard(token, { format: "text/plain", fallbackToPrompt: false })) {
            throw new Error("图片复制失败，请重试");
        }
        await file;
        check();
        return mode;
    } catch (error) {
        if (copied === entry) { controller.abort(); copied = undefined; }
        throw error;
    }
}

/** Return null for ordinary text so the browser keeps caret/selection semantics. */
export function pastedConversationImageFiles(data: Pick<DataTransfer, "files" | "items" | "getData">): Promise<File[]> | null {
    watchOwner();
    const text = data.getData("text/plain");
    if (text.startsWith(prefix) && /^[0-9a-f-]{36}$/i.test(text.slice(prefix.length))) {
        const entry = copied;
        if (!entry || entry.token !== text || owner() !== entry.ownerId || entry.controller.signal.aborted) return Promise.reject(expired());
        return entry.file.then(file => {
            if (copied !== entry || owner() !== entry.ownerId || entry.controller.signal.aborted) throw expired();
            return [file];
        });
    }
    const files = pastedImageFiles(data);
    return files.length ? Promise.resolve(files) : null;
}
