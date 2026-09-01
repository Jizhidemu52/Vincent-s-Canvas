import { describe, expect, test } from "bun:test";

import { canvasNodeRenderStateEqual, type CanvasNodeRenderState } from "@/lib/canvas/canvas-render-stability";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node: CanvasNodeData = {
    id: "image-1",
    type: CanvasNodeType.Image,
    title: "参考图",
    position: { x: 120, y: 80 },
    width: 320,
    height: 320,
    metadata: { content: "asset://image-1" },
};

function state(overrides: Partial<CanvasNodeRenderState> = {}): CanvasNodeRenderState {
    return {
        data: node,
        renderQuality: "full",
        scale: 1,
        isSelected: false,
        isRelated: false,
        isFocusRelated: false,
        isConnectionTarget: false,
        isConnecting: false,
        editRequestNonce: 0,
        showPanel: false,
        showImageInfo: false,
        resourceLabel: { id: "image-1", nodeId: "image-1", kind: "image", label: "图片 1", title: "参考图", previewUrl: "asset://image-1", active: false },
        mentionReferences: [{ id: "image-1", nodeId: "image-1", kind: "image", label: "图片 1", title: "参考图", previewUrl: "asset://image-1", active: true }],
        batchCount: 0,
        batchExpanded: false,
        batchClosing: false,
        batchOpening: false,
        batchRecovering: false,
        batchMotion: undefined,
        ...overrides,
    };
}

describe("canvas node render stability", () => {
    test("keeps a node stable when equivalent derived references are recreated", () => {
        expect(canvasNodeRenderStateEqual(state(), state())).toBe(true);
    });

    test("refreshes a node when its interactive state or data changes", () => {
        expect(canvasNodeRenderStateEqual(state(), state({ isSelected: true }))).toBe(false);
        expect(canvasNodeRenderStateEqual(state(), state({ scale: 0.8 }))).toBe(false);
        expect(canvasNodeRenderStateEqual(state(), state({ renderQuality: "moving" } as Partial<CanvasNodeRenderState>))).toBe(false);
        expect(canvasNodeRenderStateEqual(state(), state({ data: { ...node, position: { x: 180, y: 80 } } }))).toBe(false);
    });
});
