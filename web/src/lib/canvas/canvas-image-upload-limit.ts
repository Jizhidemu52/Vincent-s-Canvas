/** Match the image provider's per-file limit without changing archived/generated images. */
export const CANVAS_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export function assertCanvasImageUploadSize(file: { size: number; name?: string }): void {
    if (file.size > CANVAS_IMAGE_MAX_BYTES) {
        throw new Error(`${file.name ? `图片「${file.name}」` : "图片"}超过 20 MB，无法添加到画布；请选择不超过 20 MB 的图片。`);
    }
}
