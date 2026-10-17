import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasConfigNodePanel, configReferencePresentation } from "@/components/canvas/canvas-config-node-panel";
import { CanvasConfigImageReferences, configImageReferencePatch } from "@/components/canvas/canvas-config-image-references";
import { createImageReferenceItem, moveImageReference } from "@/lib/image-reference-policy";
import { resolveCanvasImageReferences, toCanvasStoredImageReference } from "@/lib/canvas/canvas-image-references";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";

const noop = () => {};
const node: CanvasNodeData = { id: "config", type: CanvasNodeType.Config, title: "配置", position: { x: 0, y: 0 }, width: 360, height: 420, metadata: { composerContent: "保持主体不变" } };
const image = (id: string, origin: "upload" | "connection" = "upload") => createImageReferenceItem({ id, name: `${id}.png`, type: "image/png", dataUrl: `blob:${id}`, storageKey: `image:${id}` }, origin);

test("per-image display separates task inputs from common image numbering and mentions", () => {
    const references = [image("a", "connection"), image("b", "connection"), image("common")];
    const inputs = [
        ...references.slice(0, 2).map(image => ({ nodeId: image.id, type: "image" as const, title: image.name, image })),
        { nodeId: "text", type: "text" as const, title: "说明", text: "保留轮廓" },
    ];
    const separate = configReferencePresentation(references, inputs, "image", true);
    expect(separate.trayLabels).toEqual({ "connection:a": "任务输入1", "connection:b": "任务输入2", "upload:common": "图片2" });
    expect(separate.mentionLabels).toEqual({ common: "图片2" });
    expect(separate.inputs.map(input => input.nodeId)).toEqual(["text", "common"]);
    const html = renderToStaticMarkup(<CanvasConfigImageReferences node={node} references={references} labels={separate.trayLabels} disabled={false} onChange={noop} />);
    expect(html).toContain("任务输入1");
    expect(html).toContain("任务输入2");
    expect(html).toContain('aria-label="移除图片2"');
    expect(html).not.toContain("参考图3");
    // Combined references and explicit-target mode use the established full input list.
    const combined = configReferencePresentation(references, inputs, "image", false);
    expect(combined.trayLabels).toBeUndefined();
    expect(combined.mentionLabels).toBeUndefined();
    expect(combined.inputs.map(input => input.nodeId)).toEqual(["text", "a", "b", "common"]);
});

function panel(mode: CanvasGenerationMode) {
    return renderToStaticMarkup(<CanvasConfigNodePanel node={{ ...node, metadata: { ...node.metadata, generationMode: mode } }} isRunning={false} inputSummary={{ textCount: 0, imageCount: 0, videoCount: 2, audioCount: 1 }} onConfigChange={noop} onGenerate={noop} onStop={noop} />);
}

test("image config edits prompts inline with one upload entry and no irrelevant or zero-count input chips", () => {
    const html = panel("image");
    expect(html).toContain('role="textbox"');
    expect(html).toContain('aria-label="提示词"');
    expect(html).toContain('contentEditable="true"');
    expect(html).toContain("添加参考图");
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/*"');
    for (const text of ["组装提示词", "参考视频", "参考音频", "已连视频", "已连音频", "0 张", "0 个"]) expect(html).not.toContain(text);
});

test("only video mode displays connected media, and audio mode has TTS text without image controls", () => {
    const video = panel("video");
    expect(video).toContain("已连视频");
    expect(video).toContain("已连音频");
    expect(video).toContain("添加参考图");
    const audio = panel("audio");
    expect(audio).toContain('aria-label="朗读文本"');
    for (const text of ["添加参考图", "已连视频", "已连音频", 'type="file"']) expect(audio).not.toContain(text);
    const text = panel("text");
    expect(text).not.toContain("已连视频");
    expect(text).not.toContain("已连音频");
});

test("reference thumbnails have explicit remove and order controls only when populated", () => {
    const empty = renderToStaticMarkup(<CanvasConfigImageReferences node={node} references={[]} disabled={false} onChange={noop} />);
    expect(empty).not.toContain("0 张");
    expect(empty).not.toContain("<img");
    const populated = renderToStaticMarkup(<CanvasConfigImageReferences node={node} references={[image("a"), image("b")]} disabled={false} onChange={noop} />);
    expect(populated).toContain('aria-label="移除参考图1"');
    expect(populated).toContain('aria-label="参考图2前移"');
    expect(populated).toContain('aria-label="参考图1后移"');
    // Reloaded graph URLs belong to an old document; wait for storage-backed resolution.
    expect(populated).not.toContain('src="blob:a"');
    expect(populated).toContain("正在恢复媒体预览");
});

test("reference edits persist uploads, exclude connected images without deleting graph edges, and preserve order", () => {
    const connected = { ...image("connected", "connection"), referenceKey: "node:connected" };
    const uploaded = image("uploaded");
    const config = { ...node, metadata: { ...node.metadata, manualImageReferences: [toCanvasStoredImageReference(uploaded)] } };
    const source: CanvasNodeData = { ...node, id: "connected", type: CanvasNodeType.Image, metadata: { content: connected.dataUrl, storageKey: connected.storageKey } };
    const connections = [{ id: "edge", fromNodeId: source.id, toNodeId: config.id }];
    const current = [uploaded, connected];
    const reordered = moveImageReference(current, 1, 0);
    const orderPatch = configImageReferencePatch(config, current, reordered);
    expect(orderPatch.imageReferenceOrder).toEqual(["node:connected", uploaded.referenceKey]);
    expect(orderPatch.manualImageReferences?.[0]).toMatchObject({ content: "blob:uploaded", storageKey: "image:uploaded" });
    const removePatch = configImageReferencePatch(config, current, [uploaded]);
    expect(removePatch.excludedConnectedImageReferenceKeys).toEqual(["node:connected"]);
    expect(resolveCanvasImageReferences({ ...config, metadata: { ...config.metadata, ...removePatch } }, [config, source], connections).map(item => item.id)).toEqual(["uploaded"]);
    expect(connections).toHaveLength(1);
    expect(config.metadata.manualImageReferences).toHaveLength(1);
});
