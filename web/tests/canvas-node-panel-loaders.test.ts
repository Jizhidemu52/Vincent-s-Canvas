import { expect, test } from "bun:test";

import { loadCanvasConfigNodePanel, loadCanvasConfigComposer, loadCanvasNodePromptPanel } from "@/lib/canvas/canvas-node-panel-loaders";

test("keeps selected-node editing panels behind explicit lazy module boundaries", async () => {
    const [config, composer, promptPanel] = await Promise.all([loadCanvasConfigNodePanel(), loadCanvasConfigComposer(), loadCanvasNodePromptPanel()]);

    expect(config.default).toBeDefined();
    expect(composer.default).toBeDefined();
    expect(promptPanel.default).toBeDefined();
});
