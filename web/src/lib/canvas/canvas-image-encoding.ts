export type CanvasImageDownloadFormat = "original" | "png" | "jpg";

/** Check the bytes as well as the header so a renamed file is never mistaken for a conversion. */
export async function validateImageBlob(blob: Blob) {
    if (!blob.size) throw new Error("图片内容为空，无法下载");
    const type = blob.type.split(";")[0].toLowerCase();
    const bytes = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
    const text = new TextDecoder().decode(bytes).trimStart();
    if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b|[\[{])/i.test(text)) throw new Error("原图地址返回了网页或错误数据，不是图片");
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    const signatures: [boolean, string][] = [
        [bytes[0] === 0xff && bytes[1] === 0xd8, "image/jpeg"],
        [bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47, "image/png"],
        [/^GIF8[79]a/.test(text), "image/gif"],
        [/^RIFF[\s\S]{4}WEBP/.test(text), "image/webp"],
        [text.startsWith("BM"), "image/bmp"],
        [text.startsWith("II*\0") || text.startsWith("MM\0*"), "image/tiff"],
        [/^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(text), "image/svg+xml"],
        [String.fromCharCode(...bytes.slice(4, 8)) === "ftyp" && /^(?:avif|avis|heic|heix|heif|mif1|msf1)$/.test(brand), brand.startsWith("avi") ? "image/avif" : "image/heif"],
    ];
    const detectedType = signatures.find(([matches]) => matches)?.[1];
    if (type.startsWith("image/")) return detectedType || type;
    if ((type && type !== "application/octet-stream") || !detectedType) throw new Error("原图内容或文件类型无效");
    return detectedType;
}

export async function prepareCanvasImageFormat(blob: Blob, format: CanvasImageDownloadFormat, encode = encodeImageBlob) {
    const sourceType = await validateImageBlob(blob);
    if (format === "original") return { blob, mimeType: sourceType };
    if (format !== "png" && format !== "jpg") throw new Error("请选择 PNG、JPG 或原文件格式");
    const mimeType = format === "png" ? "image/png" : "image/jpeg";
    const result = sourceType === mimeType ? (blob.type === mimeType ? blob : new Blob([blob], { type: mimeType })) : await encode(blob, mimeType);
    if (await validateImageBlob(result) !== mimeType) throw new Error("浏览器未生成所选图片格式，未下载文件");
    return { blob: result, mimeType };
}

export async function encodeImageBlob(blob: Blob, mimeType: string) {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    const canvas = document.createElement("canvas");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error("浏览器无法读取此图片格式"));
            timer = setTimeout(() => reject(new Error("读取原图超时，请重试")), 30_000);
            image.src = url;
        });
        if (!image.naturalWidth || !image.naturalHeight) throw new Error("无法读取原图尺寸");
        if (image.naturalWidth * image.naturalHeight > 20_000_000) throw new Error("单张图片超过 2000 万像素，请先缩小图片");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法转换图片格式");
        if (mimeType === "image/jpeg") { context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); }
        context.drawImage(image, 0, 0);
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("图片格式转换失败")), mimeType, 0.95));
    } finally {
        clearTimeout(timer);
        image.onload = null;
        image.onerror = null;
        image.src = "";
        canvas.width = 0;
        canvas.height = 0;
        URL.revokeObjectURL(url);
    }
}
