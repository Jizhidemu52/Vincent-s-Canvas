import { expect, test } from "bun:test";

import { loadCanvasAssistantPanel, loadCanvasLocalAgentPanel } from "@/lib/canvas/canvas-agent-panel-loaders";

test("keeps Agent panels behind explicit lazy module boundaries", async () => {
    const [assistant, local] = await Promise.all([loadCanvasAssistantPanel(), loadCanvasLocalAgentPanel()]);

    expect(assistant.default).toBeDefined();
    expect(local.default).toBeDefined();
});
