import { expect, test } from "bun:test";

import { loadCanvasExport } from "@/lib/canvas/canvas-export-loader";

test("loads canvas export support only after an export is requested", async () => {
    const exporter = await loadCanvasExport();

    expect(typeof exporter.exportCanvasProjects).toBe("function");
});
