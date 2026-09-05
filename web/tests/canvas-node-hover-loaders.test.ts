import { expect, test } from "bun:test";

import { loadCanvasNodeHoverToolbar, loadCanvasNodeInfoModal } from "@/lib/canvas/canvas-node-hover-loaders";

test("keeps hover-only node controls behind explicit lazy module boundaries", async () => {
    const [toolbar, infoModal] = await Promise.all([loadCanvasNodeHoverToolbar(), loadCanvasNodeInfoModal()]);

    expect(toolbar.default).toBeDefined();
    expect(infoModal.default).toBeDefined();
});
