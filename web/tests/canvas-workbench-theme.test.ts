import { expect, test } from "bun:test";

import { canvasThemes } from "../src/lib/canvas-theme";

test("light canvas uses a neutral gray field and contrasting selection", () => {
    expect(canvasThemes.light.canvas.background).toBe("#f2f2f2");
    expect(canvasThemes.light.canvas.selectionStroke).toBe("#3bbaa5");
    expect(canvasThemes.light.canvas.dot).toBe("rgba(0,0,0,.16)");
});

test("light workbench reserves orange and violet for semantic emphasis", () => {
    expect(canvasThemes.light.toolbar.primary).toBe("#ff5a1f");
    expect(canvasThemes.light.toolbar.highResolution).toBe("#805ad5");
});

test("floating surfaces support both themes and 4K tools keep a semantic color", async () => {
    const workspace = await Bun.file("src/pages/canvas/workspace.css").text();
    const hoverToolbar = await Bun.file("src/components/canvas/canvas-node-hover-toolbar.tsx").text();

    expect(workspace).toContain('.cw-workspace[data-theme="dark"]');
    expect(workspace).toContain("background: var(--cw-panel)");
    expect(hoverToolbar).toContain("theme.toolbar.highResolution");
});
