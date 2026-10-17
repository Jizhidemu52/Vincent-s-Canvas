import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasConnectionLayer } from "@/components/canvas/canvas-connection-layer";

test("static and dynamic surfaces use CSS host dimensions independently of device-pixel buffers", () => {
    const markup = renderToStaticMarkup(<CanvasConnectionLayer connections={[]} resolveNode={() => undefined} viewport={{ x: 0, y: 0, k: 1 }} activeConnectionIds={new Set()} affectedConnectionIds={new Set()} isDraggingNodes={false} onDrawFailure={() => {}} />);
    const surfaces = markup.match(/<canvas[^>]+>/g) || [];
    expect(surfaces).toHaveLength(2);
    for (const surface of surfaces) {
        expect(surface).toContain("h-full w-full");
        expect(surface).toContain("pointer-events-none");
    }
});
