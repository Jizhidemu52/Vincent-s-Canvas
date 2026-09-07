import { imageToDataUrl } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";

/** Inspect alpha only. Never replace, flatten or re-encode the source file. */
export async function imageHasTransparency(reference: ReferenceImage) {
    const response = await fetch(await imageToDataUrl(reference));
    if (!response.ok) throw new Error(`参考图读取失败（${response.status}）`);
    const image = await createImageBitmap(await response.blob());
    try {
        const canvas = document.createElement("canvas");
        // Inspect full-resolution strips so even a one-pixel transparent edge is detected,
        // without allocating another full-size RGBA copy of a large image.
        canvas.width = image.width; canvas.height = Math.min(64, image.height);
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("浏览器无法读取图片透明度");
        for (let y = 0; y < image.height; y += canvas.height) {
            const height = Math.min(canvas.height, image.height - y);
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, y, image.width, height, 0, 0, image.width, height);
            const data = context.getImageData(0, 0, image.width, height).data;
            for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
        }
        return false;
    } finally { image.close(); }
}
