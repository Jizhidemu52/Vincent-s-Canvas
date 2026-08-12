import { expect, test } from "bun:test";

import { canvasThemes } from "../src/lib/canvas-theme";

test("light canvas uses the reference white field and mint selection", () => {
    expect(canvasThemes.light.canvas.background).toBe("#fbfbfa");
    expect(canvasThemes.light.canvas.selectionStroke).toBe("#50d5be");
    expect(canvasThemes.light.canvas.dot).toBe("rgba(71,85,105,.12)");
});

test("light workbench reserves orange and violet for semantic emphasis", () => {
    expect(canvasThemes.light.toolbar.primary).toBe("#f36a2d");
    expect(canvasThemes.light.toolbar.highResolution).toBe("#805ad5");
});

test("top bar and 4K tools use semantic workbench colors", async () => {
    const project = await Bun.file("src/pages/canvas/project.tsx").text();
    const hoverToolbar = await Bun.file("src/components/canvas/canvas-node-hover-toolbar.tsx").text();

    expect(project).toContain("theme.toolbar.primary");
    expect(hoverToolbar).toContain("theme.toolbar.highResolution");
});
