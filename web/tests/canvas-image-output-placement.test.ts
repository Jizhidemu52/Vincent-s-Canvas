import { expect, test } from "bun:test";
import { placeCanvasImageOutputs } from "@/lib/canvas/canvas-image-output-placement";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Image, title: "source", position: { x: 0, y: 0 }, width: 240, height: 240 };
test("places a result beside its source when there is free space", () => {
    expect(placeCanvasImageOutputs([source], [source], { width: 240, height: 240 }, { x: 0, y: 0 })).toEqual({ x: 276, y: 0 });
});
test("avoids existing media and subsequent lower rows without moving any source", () => {
    const video = { ...source, id: "video", type: CanvasNodeType.Video, position: { x: 280, y: 0 } };
    const lower = { ...source, id: "lower", position: { x: 280, y: 276 } };
    expect(placeCanvasImageOutputs([source, video, lower], [source], { width: 516, height: 240 }, { x: 0, y: 0 })).toEqual({ x: 276, y: 552 });
    expect(source.position).toEqual({ x: 0, y: 0 });
});
test("empty-canvas generation stays centered", () => {
    expect(placeCanvasImageOutputs([], [], { width: 240, height: 240 }, { x: 500, y: 400 })).toEqual({ x: 380, y: 280 });
});
test("an explicit cursor position anchors the batch even if it overlaps other nodes", () => {
    const position = { x: 12.5, y: -43.25 };
    expect(placeCanvasImageOutputs([source], [source], { width: 516, height: 516 }, { x: 500, y: 400 }, 36, position)).toEqual(position);
    expect(placeCanvasImageOutputs([source], [source], { width: 516, height: 516 }, { x: 500, y: 400 }, 36, null)).toEqual({ x: 276, y: 0 });
});
