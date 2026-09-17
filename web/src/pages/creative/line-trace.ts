import tracer from "imagetracerjs";
import { lineArtPixels, type PixelImage } from "./image-processing";

export type TraceOptions = { threshold: number; noise: number; smoothness: number };
export function traceLineArt(image: PixelImage, options: TraceOptions) {
    if (image.width > 2048 || image.height > 2048 || image.width * image.height > 4_194_304) throw new Error("矢量描摹图片最长边不能超过 2048 像素");
    if (!Number.isFinite(options.noise) || options.noise < 0 || options.noise > 64 || !Number.isFinite(options.smoothness) || options.smoothness < .1 || options.smoothness > 5) throw new Error("描摹参数无效");
    const binary = lineArtPixels(image, options.threshold);
    let dark = 0;
    for (let offset = 0; offset < binary.data.length; offset += 4) if (binary.data[offset] === 0) dark++;
    if (!dark || dark === image.width * image.height) throw new Error("未检测到黑白线条，请调整阈值或换用清晰线稿");
    const svg = tracer.imagedataToSVG(binary, { colorsampling: 0, colorquantcycles: 1, pal: [{ r: 255, g: 255, b: 255, a: 255 }, { r: 0, g: 0, b: 0, a: 255 }], pathomit: options.noise, ltres: options.smoothness, qtres: options.smoothness, strokewidth: 0, roundcoords: 2, viewbox: true, desc: false });
    if (!svg.startsWith("<svg") || !/<path\b[^>]*fill="rgb\(0,0,0\)"/.test(svg) || /<(?:image|script|foreignObject)\b/i.test(svg)) throw new Error("未提取到有效矢量路径，请调整黑白阈值或降低小路径过滤");
    return svg;
}
