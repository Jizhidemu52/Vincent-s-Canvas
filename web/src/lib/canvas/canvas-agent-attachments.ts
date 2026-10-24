export const CANVAS_AGENT_ATTACHMENT_LIMIT = 28 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Reject oversized files before decoding; one broken file must not discard its siblings. */
export async function readCanvasAgentAttachments(files: File[], availableBytes: number, read: (file: File) => Promise<string>, isCurrent = () => true) {
    const images: { name: string; dataUrl: string }[] = [], errors: string[] = [];
    for (const file of files) {
        if (!isCurrent()) break;
        const name = file.name || "未命名图片";
        if (!file.type.startsWith("image/")) { errors.push(`${name}：仅支持图片`); continue; }
        if (file.size > MAX_FILE_BYTES) { errors.push(`${name}：单张图片不能超过 20 MB`); continue; }
        if (Math.ceil(file.size * 4 / 3) > availableBytes) { errors.push(`${name}：附件总量不能超过 28 MB，请先移除部分图片`); continue; }
        try {
            const dataUrl = await read(file);
            if (!isCurrent()) break;
            if (!dataUrl.startsWith("data:image/")) throw new Error("图片读取结果无效");
            if (dataUrl.length > availableBytes) { errors.push(`${name}：附件总量不能超过 28 MB，请先移除部分图片`); continue; }
            availableBytes -= dataUrl.length;
            images.push({ name, dataUrl });
        } catch (error) {
            if (isCurrent()) errors.push(`${name}：${error instanceof Error ? error.message : "读取失败"}`);
        }
    }
    return { images, errors };
}
