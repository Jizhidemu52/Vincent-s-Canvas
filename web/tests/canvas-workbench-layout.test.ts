import { expect, test } from "bun:test";

test("workbench has floating create/chat panels and a bottom dock", async () => {
    const project = await Bun.file("src/pages/canvas/project.tsx").text();
    const toolbar = await Bun.file("src/components/canvas/canvas-toolbar.tsx").text();
    const workspace = await Bun.file("src/pages/canvas/workspace.css").text();

    expect(project).toContain('data-testid="canvas-left-generator-rail"');
    expect(project).toContain("cw-agent-panel cw-surface");
    expect(project).not.toContain('testId="canvas-right-asset-rail"');
    expect(project).toContain('useState<CanvasBackgroundMode>("dots")');
    expect(toolbar).toContain('data-testid="canvas-top-tool-rail"');
    expect(toolbar).toContain('className="cw-dock"');
    expect(workspace).toContain(".cw-agent-panel.is-wide");
    expect(workspace).toContain("bottom: 8px");
});
