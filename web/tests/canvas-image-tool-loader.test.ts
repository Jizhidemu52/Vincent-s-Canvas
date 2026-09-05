import { expect, test } from "bun:test";

import { loadCanvasImageTools } from "@/lib/canvas/canvas-image-tool-loader";

test("loads browser image tools only when an image operation starts", async () => {
    const tools = await loadCanvasImageTools();

    expect(typeof tools.cropDataUrl).toBe("function");
    expect(typeof tools.splitDataUrl).toBe("function");
    expect(typeof tools.upscaleDataUrl).toBe("function");
});
