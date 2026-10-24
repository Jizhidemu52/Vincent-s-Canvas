type ImageClipboard = { read?: () => Promise<readonly { types: readonly string[]; getType: (type: string) => Promise<Blob> }[]> };

export async function readClipboardImages(clipboard: ImageClipboard | undefined): Promise<Blob[]> {
    if (!clipboard?.read) throw new Error("当前浏览器不支持读取剪贴板图片，请使用上传或拖入图片");
    try {
        const items = await clipboard.read();
        const images = await Promise.all(items.flatMap(item => {
            const type = item.types.find(value => value.startsWith("image/"));
            return type ? [item.getType(type)] : [];
        }));
        if (!images.length) throw new Error("剪贴板中没有图片，请先复制图片后再试");
        return images;
    } catch (error) {
        if (error instanceof Error && ["NotAllowedError", "SecurityError"].includes(error.name)) {
            throw new Error("浏览器未允许读取剪贴板，请允许剪贴板权限后重试，或使用上传/拖入图片");
        }
        throw error;
    }
}
