export const CANVAS_DIFFERENCE_MAX_PIXELS = 4_000_000;
export const CANVAS_DIFFERENCE_MAX_EDGE = 4096;
type CompareImageSize = { naturalWidth: number; naturalHeight: number };

export function canvasDifferenceLayout(before: CompareImageSize, after: CompareImageSize) {
    if ([before.naturalWidth, before.naturalHeight, after.naturalWidth, after.naturalHeight].some(size => !Number.isSafeInteger(size) || size <= 0)) throw new Error("图片尺寸无效，请重新选择图片");
    const sourceWidth = Math.max(before.naturalWidth, after.naturalWidth), sourceHeight = Math.max(before.naturalHeight, after.naturalHeight);
    const scale = Math.min(1, CANVAS_DIFFERENCE_MAX_EDGE / sourceWidth, CANVAS_DIFFERENCE_MAX_EDGE / sourceHeight, Math.sqrt(CANVAS_DIFFERENCE_MAX_PIXELS / (sourceWidth * sourceHeight)));
    const sameSize = before.naturalWidth === after.naturalWidth && before.naturalHeight === after.naturalHeight;
    return { width: Math.max(1, Math.floor(sourceWidth * scale)), height: Math.max(1, Math.floor(sourceHeight * scale)), sameSize, downsampled: scale < 1, pixelExact: sameSize && scale === 1 };
}

export function compareContainRect(width: number, height: number, boxWidth: number, boxHeight: number) {
    const scale = Math.min(boxWidth / Math.max(1, width), boxHeight / Math.max(1, height));
    return { x: (boxWidth - width * scale) / 2, y: (boxHeight - height * scale) / 2, width: width * scale, height: height * scale };
}

/** Visible difference is the maximum premultiplied RGB/alpha distance; ignore hidden RGB. */
export function canvasDifferencePixels(before: Uint8ClampedArray, after: Uint8ClampedArray) {
    if (before.length !== after.length || before.length % 4 !== 0) throw new Error("差异图像素数据尺寸不一致");
    if (before.length / 4 > CANVAS_DIFFERENCE_MAX_PIXELS) throw new Error("差异图超过本地处理上限");
    const result = new Uint8ClampedArray(before.length);
    for (let index = 0; index < before.length; index += 4) {
        const beforeAlpha = before[index + 3] / 255, afterAlpha = after[index + 3] / 255;
        const difference = Math.round(Math.max(
            Math.abs(before[index] * beforeAlpha - after[index] * afterAlpha),
            Math.abs(before[index + 1] * beforeAlpha - after[index + 1] * afterAlpha),
            Math.abs(before[index + 2] * beforeAlpha - after[index + 2] * afterAlpha),
            Math.abs(before[index + 3] - after[index + 3]),
        ));
        result[index] = result[index + 1] = result[index + 2] = difference;
        result[index + 3] = 255;
    }
    return result;
}
