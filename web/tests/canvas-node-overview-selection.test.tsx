import { describe, expect, test } from "bun:test";
import React, { type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasNode } from "@/components/canvas/canvas-node";
import { canvasThemes } from "@/lib/canvas-theme";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const noop = () => {};
const image: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "Reference", position: { x: 120, y: 80 }, width: 320, height: 240, metadata: { content: "https://example.invalid/image.png", status: "success" } };
const props: ComponentProps<typeof CanvasNode> = {
    data: image, theme: canvasThemes.light, themeKey: "light", renderQuality: "overview", getCanvasScale: () => .1,
    isSelected: true, isMultiSelected: true, isRelated: false, isFocusRelated: false, isConnectionTarget: false, isConnecting: false, isRunning: false, showPanel: false, showImageInfo: true,
    onMouseDown: noop, onHoverStart: noop, onHoverEnd: noop, onConnectStart: noop, onResize: noop, onResizeEnd: noop, onContentChange: noop, onContextMenu: noop,
};
const markup = (patch: Partial<typeof props> = {}) => renderToStaticMarkup(<CanvasNode {...props} {...patch} />);

describe("bulk overview node output", () => {
    test("reuses bulk overview paint without disabling offscreen skipping for detailed nodes", () => {
        expect(markup()).toContain("content-visibility:visible");
        for (const patch of [{ isMultiSelected: false }, { isFocusRelated: true }, { isConnectionTarget: true }, { showPanel: true }, { renderQuality: "full" as const }, { renderQuality: "moving" as const }]) {
            expect(markup(patch)).toContain("content-visibility:auto");
        }
        expect(markup({ isSelected: false, isMultiSelected: false })).toContain("content-visibility:auto");
    });

    test("does not mount image, media players, editor buttons or per-node resize controls", () => {
        for (const type of [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Text]) {
            const html = markup({ data: { ...image, type } });
            expect(html).toContain('data-node-id="image"');
            expect(html).toContain('data-testid="canvas-node-overview"');
            expect(html).not.toMatch(/<(img|video|audio|textarea|button)\b/);
            expect(html).not.toContain("data-canvas-resize-handle");
            expect(html).not.toContain("data-canvas-connection-handle");
            expect(html).toContain("translate(120px, 80px)");
            expect(html).toContain("width:320px");
        }
    });

    test("does not invoke a selected config node's full content renderer", () => {
        let renders = 0;
        const html = markup({ data: { ...image, type: CanvasNodeType.Config }, renderNodeContent: () => { renders++; return <div>Heavy config editor</div>; } });
        expect(renders).toBe(0);
        expect(html).not.toContain("Heavy config editor");
    });

    test("single selection, focus and a connection target retain full image content", () => {
        for (const patch of [{ isMultiSelected: false }, { isFocusRelated: true }, { isConnectionTarget: true }]) {
            const html = markup(patch);
            expect(html).toContain("data-canvas-image-resolution");
            expect(html).toContain("data-canvas-resize-handle");
            expect(html).not.toContain('data-testid="canvas-node-overview"');
        }
    });

    test("an explicitly opened panel remains mounted and full-detail", () => {
        const html = markup({ showPanel: true, renderPanel: () => <div>Explicitly opened panel</div> });
        expect(html).toContain("Explicitly opened panel");
        expect(html).toContain("data-canvas-image-resolution");
    });

    test("an active connection retains ports without mounting every selected image", () => {
        const html = markup({ isConnecting: true });
        expect(html).toContain("data-canvas-connection-handle");
        expect(html).not.toContain("data-canvas-resize-handle");
        expect(html).not.toContain("data-canvas-image-resolution");
    });
});
