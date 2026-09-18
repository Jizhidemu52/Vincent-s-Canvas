import { nanoid } from "nanoid";
import { getImageBlob, setImageBlob } from "./image-storage";
import { fingerprintImage } from "./api/generation-history";
import type { ReferenceImage } from "@/types/image";

export type FrozenReference<T extends ReferenceImage = ReferenceImage> = T & { inputSha256: string };
async function originalBlob(image: ReferenceImage) {
    if (image.storageKey) {
        const blob = await getImageBlob(image.storageKey);
        if (!blob) throw new Error(`历史原文件“${image.name}”已缺失，请找回原文件；未恢复任何输入`);
        return blob;
    }
    const response = await fetch(image.dataUrl);
    if (!response.ok) throw new Error(`原文件“${image.name}”不可用`);
    return response.blob();
}

/** Separate storage keys protect scene input and masks from subsequent editing. */
export async function freezeLocalInput<T extends ReferenceImage>(image: T): Promise<FrozenReference<T>> {
    const blob = await originalBlob(image);
    const inputSha256 = await fingerprintImage(blob);
    const storageKey = `image:history:${nanoid()}`;
    const dataUrl = await setImageBlob(storageKey, blob);
    return { ...image, storageKey, dataUrl, inputSha256 };
}
export async function restoreLocalInput<T extends ReferenceImage & { inputSha256?: string }>(image: T): Promise<T> {
    if (!image.inputSha256) throw new Error("旧记录没有原始字节校验归档，无法完整恢复");
    const blob = await originalBlob(image);
    if (await fingerprintImage(blob) !== image.inputSha256) throw new Error(`历史原图“${image.name}”字节已改变，拒绝静默替换`);
    return { ...image, dataUrl: URL.createObjectURL(blob) };
}
