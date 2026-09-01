import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export type CanvasConnectionRenderState = {
    connection: CanvasConnection;
    from: CanvasNodeData;
    to: CanvasNodeData;
    active: boolean;
};

export function canvasConnectionRenderStateEqual(previous: CanvasConnectionRenderState, next: CanvasConnectionRenderState) {
    return previous.connection === next.connection && previous.from === next.from && previous.to === next.to && previous.active === next.active;
}
