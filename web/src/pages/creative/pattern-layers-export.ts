import { strToU8, zipSync } from "fflate";
import { editorPngBlob } from "@/lib/canvas/image-editor-document";
import { canvasPixels, loadProcessingImage, pixelsCanvas } from "./image-processing-browser";
import { partitionPatternLayers, type LayerPixels, type PatternLayer } from "./pattern-layers-model";

export async function preparePatternLayers(sourceUrl: string, layers: PatternLayer[]) {
    const source = await loadProcessingImage(sourceUrl);
    const selections = await Promise.all(layers.map(async layer => {
        const original = await loadProcessingImage(layer.maskUrl);
        if (Math.abs((original.width / original.height) / (source.width / source.height) - 1) > .03) throw new Error(`“${layer.name}”的蒙版比例与原图不匹配，请改用手工涂选或重新生成`);
        const mask = document.createElement("canvas"); mask.width = source.width; mask.height = source.height;
        mask.getContext("2d")!.drawImage(original, 0, 0, mask.width, mask.height);
        return { layer, mask: canvasPixels(mask) };
    }));
    return { width: source.width, height: source.height, layers: partitionPatternLayers(canvasPixels(source), selections) };
}

export function renderPatternLayers(width: number, height: number, layers: LayerPixels[]) {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d")!;
    for (const layer of layers) if (layer.visible) { context.globalAlpha = layer.opacity; context.drawImage(pixelsCanvas(layer.image), layer.left, layer.top); }
    return canvas;
}

export async function exportPatternPsd(width: number, height: number, layers: LayerPixels[]) {
    const { writePsd } = await import("ag-psd");
    const imageData = canvasPixels(renderPatternLayers(width, height, layers));
    const buffer = writePsd({ width, height, imageData, children: layers.map(layer => ({
        name: layer.name, left: layer.left, top: layer.top, hidden: !layer.visible, opacity: layer.opacity, imageData: layer.image,
    })) });
    return new Blob([buffer], { type: "image/vnd.adobe.photoshop" });
}

export async function exportPatternZip(width: number, height: number, layers: LayerPixels[]) {
    const files: Record<string, Uint8Array> = {};
    const manifest = [];
    for (let i = 0; i < layers.length; i++) {
        const layer = layers[i]!;
        const file = `${String(i).padStart(2, "0")}-${layer.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 60) || "layer"}.png`;
        files[file] = new Uint8Array(await (await editorPngBlob(pixelsCanvas(layer.image))).arrayBuffer());
        manifest.push({ file, name: layer.name, left: layer.left, top: layer.top, width: layer.image.width, height: layer.image.height, visible: layer.visible, opacity: layer.opacity });
    }
    files["layers.json"] = strToU8(JSON.stringify({ version: 1, width, height, order: "bottom-to-top", layers: manifest }, null, 2));
    return new Blob([new Uint8Array(zipSync(files))], { type: "application/zip" });
}
