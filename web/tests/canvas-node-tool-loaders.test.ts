import { expect, test } from "bun:test";

import {
    loadAssetPickerModal,
    loadCanvasNodeAngleDialog,
    loadCanvasNodeCropDialog,
    loadCanvasNodeMaskEditDialog,
    loadCanvasNodeSplitDialog,
    loadCanvasNodeUpscaleDialog,
} from "@/lib/canvas/canvas-node-tool-loaders";

test("keeps low-frequency canvas dialogs behind explicit lazy module boundaries", async () => {
    const modules = await Promise.all([
        loadCanvasNodeAngleDialog(),
        loadCanvasNodeCropDialog(),
        loadCanvasNodeMaskEditDialog(),
        loadCanvasNodeSplitDialog(),
        loadCanvasNodeUpscaleDialog(),
        loadAssetPickerModal(),
    ]);

    for (const module of modules) {
        expect(module.default).toBeDefined();
    }
});
