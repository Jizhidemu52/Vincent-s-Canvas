/** Only a JPEG source may remain lossy; transparent results always use PNG. */
export function editedCanvasMimeType(canvas: HTMLCanvasElement, sourceMimeType?: string) {
    if (!/^image\/jpe?g$/i.test(sourceMimeType || "")) return "image/png";
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法读取编辑结果");
    // Bound the temporary pixel buffer instead of copying an entire 40MP image.
    for (let y = 0; y < canvas.height; y += 64) {
        const pixels = context.getImageData(0, y, canvas.width, Math.min(64, canvas.height - y)).data;
        for (let index = 3; index < pixels.length; index += 4) if (pixels[index] < 255) return "image/png";
    }
    return "image/jpeg";
}

export function checkEditedImageBlob(blob: Blob | null): asserts blob is Blob {
    if (!blob?.size) throw new Error("图片编码失败，请重试");
    if (blob.size > 20 * 1024 * 1024) throw new Error("编辑结果超过 20 MB，请减小尺寸后保存；原图和编辑参数已保留");
}

export function sourceImageMimeType(source: string, explicit?: string) {
    return explicit || /^data:(image\/[^;,]+)/i.exec(source)?.[1] || "image/png";
}
