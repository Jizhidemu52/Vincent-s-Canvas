import type { CanvasConnectionGeometry } from "@/lib/canvas/canvas-connection-geometry";

export type CanvasConnectionDrawItem = {
    geometry: CanvasConnectionGeometry;
    active: boolean;
};

export type CanvasConnectionPalette = {
    stroke: string;
    activeStroke: string;
};

export function drawCanvasConnections(context: CanvasRenderingContext2D, items: CanvasConnectionDrawItem[], palette: CanvasConnectionPalette): boolean {
    try {
        items.forEach(({ geometry, active }) => {
            const { start, controlOne, controlTwo, end } = geometry.points;
            context.beginPath();
            context.moveTo(start.x, start.y);
            context.bezierCurveTo(controlOne.x, controlOne.y, controlTwo.x, controlTwo.y, end.x, end.y);
            context.strokeStyle = active ? palette.activeStroke : palette.stroke;
            context.lineWidth = active ? 3 : 2;
            context.globalAlpha = active ? 1 : 0.82;
            context.shadowBlur = active ? 8 : 0;
            context.shadowColor = active ? palette.activeStroke : "transparent";
            context.stroke();
        });
        context.globalAlpha = 1;
        context.shadowBlur = 0;
        context.shadowColor = "transparent";
        return true;
    } catch {
        return false;
    }
}
