import { expect, test } from "bun:test";

import { loadCanvasConfigComposer, loadCanvasNodePromptPanel } from "@/lib/canvas/canvas-node-panel-loaders";

test("keeps selected-node editing panels behind explicit lazy module boundaries", async () => {
    const [composer, promptPanel] = await Promise.all([loadCanvasConfigComposer(), loadCanvasNodePromptPanel()]);

    expect(composer.default).toBeDefined();
    expect(promptPanel.default).toBeDefined();
});
