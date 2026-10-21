import tracer from "imagetracerjs";
import { requirePixelImage, type PixelImage } from "./image-processing";
import { traceLineArt, type TraceOptions } from "./line-trace";

export const VECTOR_MAX_SIDE = 2048;
export const VECTOR_MAX_PIXELS = 4_194_304;
export const VECTOR_MAX_FILE_BYTES = 15 * 1024 * 1024;
export type VectorMode = "sketch" | "pattern";
export type PatternTraceOptions = { colors: number; noise: number; smoothness: number };
export type VectorOptions = PatternTraceOptions & TraceOptions;
export type VectorColor = { r: number; g: number; b: number; a: number };
export type VectorTraceTask = { mode: VectorMode; image: PixelImage; options: VectorOptions };
export type VectorTraceResult = { svg: string; width: number; height: number; pathCount: number; palette: VectorColor[]; transparentPixels: number; partialAlphaPixels: number };

const colorTracer = tracer as typeof tracer & {
    colorquantization(image: PixelImage, options: Record<string, unknown>): { palette: VectorColor[] };
};

export function defaultVectorOptions(mode: VectorMode): VectorOptions {
    return { colors: 8, threshold: 160, noise: 0, smoothness: mode === "sketch" ? .1 : .5, transparentBackground: true };
}

export function validateVectorOptions(options: VectorOptions) {
    if (!options || !Number.isInteger(options.colors) || options.colors < 2 || options.colors > 32) throw new Error("图案颜色数量应为 2–32");
    if (!Number.isInteger(options.threshold) || options.threshold < 1 || options.threshold > 254) throw new Error("黑白阈值应为 1–254");
    if (!Number.isInteger(options.noise) || options.noise < 0 || options.noise > 64 || !Number.isFinite(options.smoothness) || options.smoothness < .1 || options.smoothness > 5) throw new Error("描摹参数无效");
    if (typeof options.transparentBackground !== "boolean") throw new Error("透明背景设置无效");
}

function requireTraceImage(image: PixelImage) {
    requirePixelImage(image);
    if (image.width > VECTOR_MAX_SIDE || image.height > VECTOR_MAX_SIDE || image.width * image.height > VECTOR_MAX_PIXELS) throw new Error(`矢量描摹最长边不能超过 ${VECTOR_MAX_SIDE} 像素`);
}

function distance(a: VectorColor, b: VectorColor) {
    return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) + Math.abs(a.a - b.a);
}

function visibleColorDistance(a: VectorColor, b: VectorColor) {
    const red = (a.r - 255) * a.a / 255 - (b.r - 255) * b.a / 255;
    const green = (a.g - 255) * a.a / 255 - (b.g - 255) * b.a / 255;
    const blue = (a.b - 255) * a.a / 255 - (b.b - 255) * b.a / 255;
    // Weight chromatic differences while choosing seeds in a mixed neutral/color field.
    // Compositing limits the influence of almost invisible RGB noise on those seeds.
    return Math.abs(.2126 * red + .7152 * green + .0722 * blue) + 2 * Math.abs(red - green) + 2 * Math.abs(green - blue) + .25 * Math.abs(a.a - b.a);
}

/** Seed the library's k-means with frequent, distinct visible colors, never transparent RGB. */
function paletteSeeds(sample: PixelImage, count: number): VectorColor[] {
    const histogram = new Map<number, VectorColor & { count: number }>();
    for (let at = 0; at < sample.data.length; at += 4) {
        const r = sample.data[at]!, g = sample.data[at + 1]!, b = sample.data[at + 2]!, a = sample.data[at + 3]!;
        const key = (r >> 4) * 4096 + (g >> 4) * 256 + (b >> 4) * 16 + (a >> 4);
        const bin = histogram.get(key);
        if (bin) { bin.r += r; bin.g += g; bin.b += b; bin.a += a; bin.count++; }
        else histogram.set(key, { r, g, b, a, count: 1 });
    }
    const bins = [...histogram.values()].map(bin => ({ r: Math.round(bin.r / bin.count), g: Math.round(bin.g / bin.count), b: Math.round(bin.b / bin.count), a: Math.round(bin.a / bin.count), count: bin.count }));
    const nearest = bins.map(() => Infinity);
    const selected: VectorColor[] = [];
    let next = bins.reduce((best, bin, at) => bin.count > bins[best]!.count ? at : best, 0);
    while (selected.length < Math.min(count, bins.length)) {
        const { r, g, b, a } = bins[next]!;
        const color = { r, g, b, a }; selected.push(color);
        let score = -1;
        for (let index = 0; index < bins.length; index++) {
            nearest[index] = Math.min(nearest[index]!, visibleColorDistance(bins[index]!, color));
            const value = nearest[index]! * Math.pow(bins[index]!.count, .25);
            if (value > score) { score = value; next = index; }
        }
        if (!score) break;
    }
    return selected;
}

export function tracePattern(image: PixelImage, options: PatternTraceOptions): VectorTraceResult {
    requireTraceImage(image);
    validateVectorOptions({ ...defaultVectorOptions("pattern"), ...options });
    let visible = 0, transparentPixels = 0, partialAlphaPixels = 0;
    for (let at = 3; at < image.data.length; at += 4) {
        if (image.data[at]) { visible++; if (image.data[at]! < 255) partialAlphaPixels++; }
        else transparentPixels++;
    }
    if (!visible) throw new Error("图片完全透明，没有可描摹的图案");
    const stride = Math.max(1, Math.ceil(visible / 65_536));
    const sampleData = new Uint8ClampedArray(Math.ceil(visible / stride) * 4);
    let seen = 0, sampled = 0;
    for (let at = 0; at < image.data.length; at += 4) {
        if (!image.data[at + 3]) continue;
        if (seen++ % stride === 0) { sampleData.set(image.data.subarray(at, at + 4), sampled * 4); sampled++; }
    }
    const sample = { width: sampled, height: 1, data: sampleData };
    // ImageTracer performs color clustering and all contour fitting / SVG construction.
    const clustered = colorTracer.colorquantization(sample, { pal: paletteSeeds(sample, options.colors), colorquantcycles: 4, mincolorratio: 0, blurradius: 0 });
    const palette = [...new Map(clustered.palette.map(color => [JSON.stringify(color), color])).values()];
    const quantized = new Uint8ClampedArray(image.data.length);
    const lookup = new Map<number, VectorColor>();
    for (let at = 0; at < image.data.length; at += 4) {
        const r = image.data[at]!, g = image.data[at + 1]!, b = image.data[at + 2]!, a = image.data[at + 3]!;
        if (!a) continue;
        const key = r * 16_777_216 + g * 65_536 + b * 256 + a;
        let color = lookup.get(key);
        if (!color) {
            const pixel = { r, g, b, a };
            color = palette.reduce((nearest, candidate) => distance(candidate, pixel) < distance(nearest, pixel) ? candidate : nearest, palette[0]!);
            // Bound the cache even for noisy photographic inputs.
            if (lookup.size < 65_536) lookup.set(key, color);
        }
        quantized.set([color.r, color.g, color.b, color.a], at);
    }
    // Map visible pixels only to visible colors before introducing transparency. This prevents
    // fully transparent background colors from stealing dark/low-opacity foreground pixels.
    const svgPalette = transparentPixels ? [...palette, { r: 0, g: 0, b: 0, a: 0 }] : palette;
    // A half-pixel stroke in each region's own color closes antialias gaps between
    // adjacent colored paths. Outer contours can move by a fraction of one pixel.
    // Browser ImageData dimensions are prototype getters and are lost by object spread.
    const svg = tracer.imagedataToSVG({ width: image.width, height: image.height, data: quantized }, { pal: svgPalette, colorquantcycles: 1, colorsampling: 0, pathomit: options.noise, ltres: options.smoothness, qtres: options.smoothness, strokewidth: .5, roundcoords: 2, viewbox: true, desc: false });
    return vectorResult(svg, image, palette, transparentPixels, partialAlphaPixels);
}

function vectorResult(svg: string, image: PixelImage, palette: VectorColor[], transparentPixels: number, partialAlphaPixels: number): VectorTraceResult {
    const paths = svg.match(/<path\b[^>]*>/g) || [];
    const pathCount = paths.filter(path => !/\bopacity="0"(?:\s|\/|>)/.test(path)).length;
    if (!svg.startsWith("<svg") || !pathCount || /<(?:image|script|foreignObject)\b|\bhref\s*=/i.test(svg)) throw new Error("未提取到有效矢量路径，请降低小路径过滤或更换图片");
    if (svg.length > 20_000_000) throw new Error("矢量路径过多，请减少颜色、增加小路径过滤或缩小图片");
    return { svg, width: image.width, height: image.height, pathCount, palette, transparentPixels, partialAlphaPixels };
}

export function executeVectorTrace(task: VectorTraceTask): VectorTraceResult {
    requireTraceImage(task.image);
    validateVectorOptions(task.options);
    if (task.mode === "pattern") return tracePattern(task.image, task.options);
    if (task.mode !== "sketch") throw new Error("不支持的矢量化方式");
    const svg = traceLineArt(task.image, task.options);
    return vectorResult(svg, task.image, [{ r: 0, g: 0, b: 0, a: 255 }], 0, 0);
}
