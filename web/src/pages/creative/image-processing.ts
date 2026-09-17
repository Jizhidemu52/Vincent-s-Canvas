export type PixelImage = { width: number; height: number; data: Uint8ClampedArray };
export type RecolorRule = { from: string; to: string };

export function requirePixelImage(image: PixelImage) {
    if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.data.length !== image.width * image.height * 4) throw new Error("图片像素数据无效");
}

export function hexRgb(hex: string): [number, number, number] {
    if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error("请使用 #RRGGBB 格式的色值");
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
export function rgbHex(rgb: readonly number[]) { return `#${rgb.slice(0, 3).map(value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")).join("")}`.toUpperCase(); }

/** Selection alpha is coverage. Pixels outside the selection are copied verbatim. */
export function compositeSelectedPixels(original: PixelImage, generated: PixelImage, selection: PixelImage): PixelImage {
    [original, generated, selection].forEach(requirePixelImage);
    if ([generated, selection].some(image => image.width !== original.width || image.height !== original.height)) throw new Error("选区、原图和合成图的尺寸必须一致");
    const data = new Uint8ClampedArray(original.data);
    for (let offset = 0; offset < data.length; offset += 4) {
        const coverage = selection.data[offset + 3]! / 255;
        if (!coverage) continue;
        const sourceAlpha = generated.data[offset + 3]! / 255 * coverage;
        const originalAlpha = original.data[offset + 3]! / 255;
        const alpha = sourceAlpha + originalAlpha * (1 - sourceAlpha);
        if (!alpha) continue;
        for (let channel = 0; channel < 3; channel++) data[offset + channel] = (generated.data[offset + channel]! * sourceAlpha + original.data[offset + channel]! * originalAlpha * (1 - sourceAlpha)) / alpha;
        data[offset + 3] = alpha * 255;
    }
    return { width: original.width, height: original.height, data };
}

/** All mappings read the original pixels: replacing A→B never cascades into B→C. */
export function recolorPixels(original: PixelImage, rules: readonly RecolorRule[], tolerance: number): PixelImage & { changedPixels: number; matchedPixels: number } {
    requirePixelImage(original);
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100) throw new Error("颜色容差应为 0–100");
    if (!rules.length || rules.length > 6) throw new Error("请设置 1–6 组颜色映射");
    const mappings = rules.map(rule => ({ from: hexRgb(rule.from), to: hexRgb(rule.to) }));
    const distanceLimit = 3 * (255 * tolerance / 100) ** 2;
    const data = new Uint8ClampedArray(original.data);
    let changedPixels = 0, matchedPixels = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
        if (!data[offset + 3]) continue;
        let nearest = -1, nearestDistance = Infinity;
        mappings.forEach((mapping, index) => {
            const distance = mapping.from.reduce((sum, channel, at) => sum + (channel - original.data[offset + at]!) ** 2, 0);
            if (distance <= distanceLimit && distance < nearestDistance) { nearest = index; nearestDistance = distance; }
        });
        if (nearest < 0) continue;
        matchedPixels++;
        const mapping = mappings[nearest]!;
        if (mapping.from.every((value, at) => value === mapping.to[at])) continue;
        const target = mapping.to;
        if (target.some((value, at) => value !== original.data[offset + at])) changedPixels++;
        data.set(target, offset);
    }
    return { width: original.width, height: original.height, data, changedPixels, matchedPixels };
}

/** Approximate swatches only; users can sample an exact source pixel instead. */
export function suggestPalette(image: PixelImage, limit = 6): string[] {
    requirePixelImage(image);
    const bins = new Map<string, { count: number; rgb: number[] }>();
    const step = Math.max(1, Math.floor(image.width * image.height / 100_000));
    for (let pixel = 0; pixel < image.width * image.height; pixel += step) {
        const offset = pixel * 4;
        if (image.data[offset + 3]! < 128) continue;
        const rgb = Array.from(image.data.slice(offset, offset + 3));
        const key = rgb.map(value => value >> 4).join(",");
        const bin = bins.get(key);
        if (bin) bin.count++; else bins.set(key, { count: 1, rgb });
    }
    return [...bins.values()].sort((a, b) => b.count - a.count).slice(0, limit).map(bin => rgbHex(bin.rgb));
}

export function lineArtPixels(image: PixelImage, threshold: number): PixelImage {
    requirePixelImage(image);
    if (!Number.isFinite(threshold) || threshold < 1 || threshold > 254) throw new Error("黑白阈值应为 1–254");
    const data = new Uint8ClampedArray(image.data.length);
    for (let offset = 0; offset < data.length; offset += 4) {
        const alpha = image.data[offset + 3]! / 255;
        const luminance = (.2126 * image.data[offset]! + .7152 * image.data[offset + 1]! + .0722 * image.data[offset + 2]!) * alpha + 255 * (1 - alpha);
        const value = luminance < threshold ? 0 : 255;
        data.set([value, value, value, 255], offset);
    }
    return { width: image.width, height: image.height, data };
}

export function selectionHasPixels(selection: PixelImage) {
    requirePixelImage(selection);
    for (let offset = 3; offset < selection.data.length; offset += 4) if (selection.data[offset]) return true;
    return false;
}

export function requireMatchingAspect(original: { width: number; height: number }, generated: { width: number; height: number }) {
    const relativeDifference = Math.abs(generated.width / generated.height / (original.width / original.height) - 1);
    if (!Number.isFinite(relativeDifference) || relativeDifference > .01) throw new Error("模型返回图的比例与原图不一致，未进行选区合成；请下载未合成图检查，不会自动重发任务");
}

export function selectionSizeMatches(size: string, original: { width: number; height: number }) {
    if (size === "auto") return true;
    const match = /^(\d+)[x:](\d+)$/.exec(size);
    if (!match) return false;
    const ratio = Number(match[1]) / Number(match[2]);
    return Number.isFinite(ratio) && Math.abs(ratio / (original.width / original.height) - 1) <= .01;
}

export function preferredSelectionSize(original: { width: number; height: number }, sizes: readonly string[]) {
    return sizes.find(size => size !== "auto" && selectionSizeMatches(size, original)) || "auto";
}

export const selectionPrompt = "图片1是未经标记的服装原图。图片2是同一原图上的选区示意：蓝色覆盖部分才是允许修改的区域，蓝色不是设计颜色，不得带入最终结果。请依据设计要求修改该区域，保持原图完整画幅、宽高比、视角与主体位置，不裁切、不缩放或移动服装；不要生成选区蒙版、蓝色标记或对比拼图。修改处与原图的面料、光影和边缘自然衔接。程序随后只合入涂选区域，区域外使用原图。";
