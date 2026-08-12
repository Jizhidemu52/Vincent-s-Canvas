import { expect, test } from "bun:test";

test("workbench keeps reference rails and floating viewport controls", async () => {
    const project = await Bun.file("src/pages/canvas/project.tsx").text();
    const toolbar = await Bun.file("src/components/canvas/canvas-toolbar.tsx").text();
    const zoom = await Bun.file("src/components/canvas/canvas-zoom-controls.tsx").text();

    expect(project).toContain('data-testid="canvas-left-generator-rail"');
    expect(project).toContain('testId="canvas-right-asset-rail"');
    expect(project).toContain('useState<CanvasBackgroundMode>("dots")');
    expect(toolbar).toContain('data-testid="canvas-top-tool-rail"');
    expect(zoom).toContain("bottom-5 right-5");
});
