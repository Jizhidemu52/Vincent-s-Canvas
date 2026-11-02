export type CanvasImageCropRect = { x: number; y: number; width: number; height: number };
export type CanvasCropHandle = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";

type ImageSize = { width: number; height: number };
const defaultSize: ImageSize = { width: 8192, height: 8192 };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function moveCrop(crop: CanvasImageCropRect, dx: number, dy: number): CanvasImageCropRect {
    return { ...crop, x: clamp(crop.x + dx, 0, 1 - crop.width), y: clamp(crop.y + dy, 0, 1 - crop.height) };
}

/** Ratios here use normalized image coordinates, not CSS or source pixels. */
export function fitCropRatio(crop: CanvasImageCropRect, ratio: number, image: ImageSize = defaultSize): CanvasImageCropRect {
    const centerX = crop.x + crop.width / 2;
    const centerY = crop.y + crop.height / 2;
    const maxWidth = Math.min(2 * Math.min(centerX, 1 - centerX), 2 * Math.min(centerY, 1 - centerY) * ratio);
    const width = clamp(Math.sqrt(crop.width * crop.height * ratio), Math.min(maxWidth, Math.max(1 / image.width, ratio / image.height)), maxWidth);
    const height = width / ratio;
    return { x: centerX - width / 2, y: centerY - height / 2, width, height };
}

export function resizeCrop(crop: CanvasImageCropRect, dx: number, dy: number, handle: CanvasCropHandle, ratio: number | null, image: ImageSize = defaultSize): CanvasImageCropRect {
    const west = handle.includes("w"), east = handle.includes("e");
    const north = handle.includes("n"), south = handle.includes("s");
    if (ratio === null) {
        const minWidth = Math.min(1 / image.width, crop.width), minHeight = Math.min(1 / image.height, crop.height);
        const left = west ? clamp(crop.x + dx, 0, crop.x + crop.width - minWidth) : crop.x;
        const top = north ? clamp(crop.y + dy, 0, crop.y + crop.height - minHeight) : crop.y;
        const right = east ? clamp(crop.x + crop.width + dx, left + minWidth, 1) : crop.x + crop.width;
        const bottom = south ? clamp(crop.y + crop.height + dy, top + minHeight, 1) : crop.y + crop.height;
        return { x: left, y: top, width: right - left, height: bottom - top };
    }

    const horizontal = west || east, vertical = north || south;
    const anchorX = west ? crop.x + crop.width : crop.x;
    const anchorY = north ? crop.y + crop.height : crop.y;
    const centerX = crop.x + crop.width / 2;
    const centerY = crop.y + crop.height / 2;
    const availableWidth = horizontal ? west ? anchorX : 1 - anchorX : 2 * Math.min(centerX, 1 - centerX);
    const availableHeight = vertical ? north ? anchorY : 1 - anchorY : 2 * Math.min(centerY, 1 - centerY);
    const widthDelta = west ? -dx : dx;
    const heightDelta = north ? -dy : dy;
    const requestedWidth = !horizontal || (vertical && Math.abs(heightDelta * ratio) > Math.abs(widthDelta))
        ? (crop.height + heightDelta) * ratio : crop.width + widthDelta;
    const maxWidth = Math.min(availableWidth, availableHeight * ratio);
    const width = clamp(requestedWidth, Math.min(maxWidth, Math.max(1 / image.width, ratio / image.height)), maxWidth);
    const height = width / ratio;
    return {
        x: horizontal ? west ? anchorX - width : anchorX : centerX - width / 2,
        y: vertical ? north ? anchorY - height : anchorY : centerY - height / 2,
        width, height,
    };
}

export function cropPixels(crop: CanvasImageCropRect, image: ImageSize) {
    const x = clamp(Math.round(crop.x * image.width), 0, image.width - 1);
    const y = clamp(Math.round(crop.y * image.height), 0, image.height - 1);
    return { x, y, width: clamp(Math.round(crop.width * image.width), 1, image.width - x), height: clamp(Math.round(crop.height * image.height), 1, image.height - y) };
}

export function cropFromPixels(crop: CanvasImageCropRect, image: ImageSize): CanvasImageCropRect {
    const x = clamp(Math.round(crop.x), 0, image.width - 1), y = clamp(Math.round(crop.y), 0, image.height - 1);
    return { x: x / image.width, y: y / image.height, width: clamp(Math.round(crop.width), 1, image.width - x) / image.width, height: clamp(Math.round(crop.height), 1, image.height - y) / image.height };
}

export function newCrop(start: { x: number; y: number }, end: { x: number; y: number }, image: ImageSize, ratio: number | null): CanvasImageCropRect {
    const sx = clamp(start.x, 0, 1 - 1 / image.width), sy = clamp(start.y, 0, 1 - 1 / image.height);
    const ex = clamp(end.x, 0, 1), ey = clamp(end.y, 0, 1);
    let width = Math.max(1 / image.width, Math.abs(ex - sx)), height = Math.max(1 / image.height, Math.abs(ey - sy));
    if (ratio) { width = Math.min(width, height * ratio); height = width / ratio; }
    return cropFromPixels({ x: (ex < sx ? sx - width : sx) * image.width, y: (ey < sy ? sy - height : sy) * image.height, width: width * image.width, height: height * image.height }, image);
}
