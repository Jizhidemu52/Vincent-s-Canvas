/** Match the image provider's per-file limit without changing archived/generated images. */
export const CANVAS_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** Display guidance only; original bytes are retained for generation and downloads. */
export function isLargeCanvasImage(image: { bytes?: number; width?: number; height?: number }): boolean {
    return (image.bytes || 0) > 10 * 1024 * 1024 || (image.width || 0) * (image.height || 0) > 16_000_000;
}

export const CANVAS_LARGE_IMAGE_NOTICE = "大图优先使用轻量预览；原图保留，下载原图不降质";

export function assertCanvasImageUploadSize(file: { size: number; name?: string }): void {
    if (file.size > CANVAS_IMAGE_MAX_BYTES) {
        throw new Error(`${file.name ? `图片「${file.name}」` : "图片"}超过 20 MB，无法添加到画布；请选择不超过 20 MB 的图片。`);
    }
}
