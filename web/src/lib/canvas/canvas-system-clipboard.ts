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
