import { shouldIgnoreCanvasShortcut } from "./canvas-keyboard";

const canvasNodesClipboardType = "application/x-vincent-canvas-nodes";
const popupSelector = "[role='dialog'],[role='menu'],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown";

type CanvasClipboardActions = {
    copyNodes: () => { token: string; text: string } | undefined;
    pasteNodes: (token: string) => boolean;
    pasteImages: (files: File[]) => void;
    pasteText: (text: string) => boolean;
};

/** Native events carry screenshots on HTTP too; never require async clipboard permission. */
export function bindCanvasClipboardEvents(target: Pick<EventTarget, "addEventListener" | "removeEventListener">, actions: CanvasClipboardActions) {
    const ignore = (event: ClipboardEvent) => shouldIgnoreCanvasShortcut({ defaultPrevented: event.defaultPrevented, isComposing: false, keyCode: 0 }, event.target);
    const copy: EventListener = value => {
        const event = value as ClipboardEvent;
        if (ignore(event) || !event.clipboardData) return;
        const copied = actions.copyNodes();
        if (!copied) return;
        event.clipboardData.setData(canvasNodesClipboardType, copied.token);
        event.clipboardData.setData("text/plain", copied.text);
        event.preventDefault();
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
        if (token && actions.pasteNodes(token)) {
            event.preventDefault();
            return;
        }
        const text = event.clipboardData.getData("text/plain");
        if (text.trim() && actions.pasteText(text)) event.preventDefault();
    };
    target.addEventListener("copy", copy);
    target.addEventListener("paste", paste);
    return () => {
        target.removeEventListener("copy", copy);
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
