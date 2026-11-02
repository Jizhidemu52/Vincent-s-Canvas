import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasVideoNodeContent } from "@/components/canvas/canvas-video-node-content";
import { canvasVideoAssetId, canvasVideoDurationLabel, createLocalVideoPoster } from "@/lib/canvas/canvas-video-poster";
import { canvasThemes } from "@/lib/canvas-theme";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const id = '11111111-1111-4111-8111-111111111111';
const node: CanvasNodeData = { id: 'video', title: 'Video', type: CanvasNodeType.Video, position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: `/api/assets/${id}/content`, durationMs: 65_000 } };

test('video posters derive only authenticated relative asset IDs, including locally stored generated results', () => {
    expect(canvasVideoAssetId(node)).toBe(id);
    expect(canvasVideoAssetId({ ...node, metadata: { content: 'blob:local', serverAssetId: id } })).toBe(id);
    expect(canvasVideoAssetId({ ...node, metadata: { content: `https://other.example/api/assets/${id}/content` } })).toBeNull();
    expect(canvasVideoAssetId({ ...node, metadata: { serverAssetId: '../other-user' } })).toBeNull();
});

test('video duration uses readable minute/hour labels and never renders invalid metadata', () => {
    expect(canvasVideoDurationLabel(900)).toBe('0:01'); expect(canvasVideoDurationLabel(65_000)).toBe('1:05');
    expect(canvasVideoDurationLabel(3_665_000)).toBe('1:01:05');
    for (const value of [undefined, 0, -1, NaN, Infinity]) expect(canvasVideoDurationLabel(value)).toBe('');
});

test('full videos keep manual controls but never preload original bytes; low quality mounts no video decoder', () => {
    const full = renderToStaticMarkup(<CanvasVideoNodeContent node={node} theme={canvasThemes.light} renderQuality="full" />);
    expect(full).toContain('preload="none"'); expect(full).toContain('controls=""'); expect(full).toContain('muted=""'); expect(full).toContain('1:05');
    for (const renderQuality of ['moving', 'overview'] as const) {
        const lightweight = renderToStaticMarkup(<CanvasVideoNodeContent node={node} theme={canvasThemes.dark} renderQuality={renderQuality} />);
        expect(lightweight).not.toContain('<video'); expect(lightweight).toContain('1:05');
    }
});

test('local poster extraction refuses remote URLs before touching browser media', async () => {
    await expect(createLocalVideoPoster('https://outside.example/video.mp4', new AbortController().signal)).rejects.toThrow('没有本地封面源');
});
