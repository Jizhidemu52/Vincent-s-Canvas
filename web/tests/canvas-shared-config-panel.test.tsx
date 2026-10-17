import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasNodePromptPanel } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";

const node: CanvasNodeData = { id: "target", type: CanvasNodeType.Image, title: "原图", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { content: "data:image/png;base64,a", draftPrompt: "不应显示的独立提示词" } };
function panel(mode: CanvasGenerationMode, isRunning = false) {
    const sharedConfig: CanvasNodeData = { ...node, id: "config", type: CanvasNodeType.Config, title: "产品统一处理", metadata: { generationMode: mode, prompt: "旧提示词", composerContent: "保留主体，改善背景" } };
    return renderToStaticMarkup(<CanvasNodePromptPanel node={node} sharedConfig={sharedConfig} isRunning={isRunning} onOpenSharedConfig={() => {}} onGenerate={() => {}} onStop={() => {}} onPromptChange={() => {}} onConfigChange={() => {}} />);
}

test("shared configuration replaces independent editable controls in all four modes", () => {
    for (const mode of ["image", "text", "video", "audio"] as const) {
        const markup = panel(mode);
        expect(markup).toContain("继承配置：产品统一处理");
        expect(markup).toContain("保留主体，改善背景");
        expect(markup).toContain("编辑公共配置");
        expect(markup).toContain("仅执行此任务");
        expect(markup).toContain("原节点保留");
        expect(markup).not.toContain("不应显示的独立提示词");
        expect(markup).not.toContain("<textarea");
        expect(markup).not.toContain('role="combobox"');
    }
});

test("a running shared target exposes stop instead of a second submission", () => {
    const markup = panel("image", true);
    expect(markup).toContain("停止");
    expect(markup).not.toContain("仅执行此任务");
});
