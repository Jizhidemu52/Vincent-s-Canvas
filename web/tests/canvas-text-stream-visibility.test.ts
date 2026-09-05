import { expect, test } from "bun:test";

import { shouldPublishCanvasTextStream, shouldShowCanvasTextStream } from "@/lib/canvas/canvas-text-stream-visibility";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const textNode = (content?: string): CanvasNodeData => ({
    id: "text",
    type: CanvasNodeType.Text,
    title: "Text",
    position: { x: 0, y: 0 },
    width: 240,
    height: 160,
    metadata: { status: "loading", content },
});

test("publishes text chunks only while the detailed canvas is idle", () => {
    expect(shouldPublishCanvasTextStream("full", false)).toBe(true);
    expect(shouldPublishCanvasTextStream("moving", false)).toBe(false);
    expect(shouldPublishCanvasTextStream("overview", false)).toBe(false);
    expect(shouldPublishCanvasTextStream("full", true)).toBe(false);
});

test("shows useful partial text while its generation remains loading", () => {
    expect(shouldShowCanvasTextStream(textNode("正在生成的文字"))).toBe(true);
    expect(shouldShowCanvasTextStream(textNode())).toBe(false);
    expect(shouldShowCanvasTextStream({ ...textNode("图片"), type: CanvasNodeType.Image })).toBe(false);
});
