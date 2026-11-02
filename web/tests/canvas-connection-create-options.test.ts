import { expect, test } from "bun:test";
import { canvasConnectionCreateOptions, canvasConnectionMenuPosition } from "../src/lib/canvas/canvas-connection-create-options";
import { CanvasNodeType, type CanvasGenerationMode } from "../src/types/canvas";

const options = (type: CanvasNodeType, handle: "source" | "target" = "source", mode?: CanvasGenerationMode) => canvasConnectionCreateOptions({ type, metadata: mode ? { generationMode: mode } : {} }, handle);
test("audio/video source only offers video-capable next steps, never image or speech cloning", () => {
    for (const type of [CanvasNodeType.Audio, CanvasNodeType.Video]) {
        const rows = options(type);
        expect(rows.map(row => row.type)).toEqual([CanvasNodeType.Video, CanvasNodeType.Config]);
        expect(rows[1]?.configMode).toBe("video");
        expect(rows.every(row => row.relationship.includes("参考素材"))).toBe(true);
    }
});
test("text and image sources expose only generation inputs actually supported", () => {
    expect(options(CanvasNodeType.Text).map(row => row.type)).toEqual([CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Config]);
    expect(options(CanvasNodeType.Image).map(row => row.type)).toEqual([CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Config]);
    expect(options(CanvasNodeType.Image)[0]?.relationship).toContain("看图描述");
});
test("backward connections describe upstream resources and choose a matching shared config mode", () => {
    expect(options(CanvasNodeType.Audio, "target").map(row => row.type)).toEqual([CanvasNodeType.Text, CanvasNodeType.Config]);
    expect(options(CanvasNodeType.Audio, "target").at(-1)?.configMode).toBe("audio");
    expect(options(CanvasNodeType.Video, "target").at(-1)?.configMode).toBe("video");
    expect(options(CanvasNodeType.Text, "target").at(-1)?.configMode).toBe("text");
});
test("config mode gates targets and only image config can be an upstream workflow step", () => {
    expect(options(CanvasNodeType.Config, "source", "audio").map(row => row.type)).toEqual([CanvasNodeType.Text, CanvasNodeType.Audio]);
    expect(options(CanvasNodeType.Config, "source", "text").some(row => row.type === CanvasNodeType.Config)).toBe(false);
    expect(options(CanvasNodeType.Config, "source", "image").at(-1)?.configMode).toBe("image");
    expect(options(CanvasNodeType.Config, "target", "video").at(-1)?.configMode).toBe("image");
    expect(options(CanvasNodeType.Config, "target", "audio").map(row => row.type)).toEqual([CanvasNodeType.Text]);
    expect(canvasConnectionCreateOptions(undefined, "source")).toEqual([]);
});
test("menu clamps both screen edges and becomes scrollable on short/narrow viewports", () => {
    expect(canvasConnectionMenuPosition({ x: 790, y: 590 }, 408, { width: 800, height: 600 })).toEqual({ left: 492, top: 184, width: 300, maxHeight: 584 });
    expect(canvasConnectionMenuPosition({ x: -100, y: -200 }, 408, { width: 200, height: 240 })).toEqual({ left: 8, top: 8, width: 184, maxHeight: 224 });
});
