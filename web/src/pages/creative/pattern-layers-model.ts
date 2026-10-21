import type { PixelImage } from "./image-processing";

export type PatternLayer = {
    id: string; name: string; maskUrl: string; maskMode: "alpha" | "luminance";
    threshold: number; visible: boolean; opacity: number; x: number; y: number;
    sourceTaskId?: string;
};
export type LayerPixels = { name: string; left: number; top: number; image: PixelImage; visible: boolean; opacity: number };
export const MAX_PATTERN_LAYERS = 8;
export const MAX_LAYER_PIXELS = 8_000_000;

function validPixels(image: PixelImage) {
    if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.width * image.height > MAX_LAYER_PIXELS || image.data.length !== image.width * image.height * 4) throw new Error("图层图片尺寸无效或超过 800 万像素，请先缩小图片");
}

/** Masks only choose source pixels. They never supply the artwork's color. */
export function layerMaskCoverage(mask: PixelImage, mode: PatternLayer["maskMode"], threshold: number): Uint8Array {
    validPixels(mask);
    if (!Number.isFinite(threshold) || threshold < 1 || threshold > 254) throw new Error("蒙版阈值应在 1–254 之间");
    const coverage = new Uint8Array(mask.width * mask.height);
    for (let i = 0; i < coverage.length; i++) {
        const p = i * 4;
        const value = mode === "alpha" ? mask.data[p + 3]! : (mask.data[p]! * .2126 + mask.data[p + 1]! * .7152 + mask.data[p + 2]! * .0722) * mask.data[p + 3]! / 255;
        coverage[i] = value >= threshold ? 1 : 0;
    }
    return coverage;
}

function cropPixels(image: PixelImage, name: string, x = 0, y = 0, visible = true, opacity = 1): LayerPixels {
    let left = image.width, top = image.height, right = -1, bottom = -1;
    for (let row = 0; row < image.height; row++) for (let col = 0; col < image.width; col++) {
        if (!image.data[(row * image.width + col) * 4 + 3]) continue;
        left = Math.min(left, col); right = Math.max(right, col); top = Math.min(top, row); bottom = Math.max(bottom, row);
    }
    if (right < left) return { name, left: 0, top: 0, image: { width: 1, height: 1, data: new Uint8ClampedArray(4) }, visible, opacity };
    const width = right - left + 1, height = bottom - top + 1;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) data.set(image.data.subarray(((top + row) * image.width + left) * 4, ((top + row) * image.width + left + width) * 4), row * width * 4);
    return { name, left: left + Math.round(x), top: top + Math.round(y), image: { width, height, data }, visible, opacity };
}

/** Input order is bottom to top; overlaps belong to the uppermost layer exactly once. */
export function partitionPatternLayers(source: PixelImage, selections: Array<{ layer: PatternLayer; mask: PixelImage }>): LayerPixels[] {
    validPixels(source);
    if (selections.length > MAX_PATTERN_LAYERS) throw new Error("最多支持 8 个图案图层");
    const masks = selections.map(({ layer, mask }) => {
        if (mask.width !== source.width || mask.height !== source.height) throw new Error("蒙版和原图尺寸不一致");
        if (![layer.x, layer.y, layer.opacity].every(Number.isFinite) || layer.opacity < 0 || layer.opacity > 1) throw new Error("图层位置或透明度无效");
        return layerMaskCoverage(mask, layer.maskMode, layer.threshold);
    });
    const pixels = Array.from({ length: selections.length + 1 }, () => new Uint8ClampedArray(source.data.length));
    for (let i = 0; i < source.width * source.height; i++) {
        let owner = 0;
        for (let index = masks.length - 1; index >= 0; index--) if (masks[index]![i]) { owner = index + 1; break; }
        pixels[owner]!.set(source.data.subarray(i * 4, i * 4 + 4), i * 4);
    }
    return pixels.map((data, index) => {
        const layer = selections[index - 1]?.layer;
        return cropPixels({ width: source.width, height: source.height, data }, layer?.name || "原图剩余背景", layer?.x, layer?.y, layer?.visible, layer?.opacity);
    });
}

export function buildLayerMaskPrompt(label: string) {
    const target = label.trim();
    if (!target || target.length > 300) throw new Error("请用 1–300 个字描述需要分离的元素");
    return `这是图案分层的选择蒙版任务。参考图为原始图案，需分离的元素：${target}。输出与原图完全对齐、完整同画幅同宽高比的纯黑白蒙版。只有目标元素的实际可见轮廓内部为纯白(#FFFFFF)，其余全部纯黑(#000000)。目标的孔洞、元素间空隙和背景保持黑色。不得重绘、移动、放大或缩小元素，不要文字、边框、阴影、灰色背景或拼图。不要输出原图颜色，不推测被遮挡部分。`;
}
