import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CanvasNodePromptPanel } from "@/components/canvas/canvas-node-prompt-panel";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useModuleStore } from "@/stores/use-module-store";
import { moduleKeys } from "@/services/api/modules";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const result: CanvasNodeData = {
    id: "result", type: CanvasNodeType.Image, title: "result", position: { x: 0, y: 0 }, width: 100, height: 100,
    metadata: { generationRecord: {
        version: 1, id: "run", sourceNodeId: "removed", createdAt: "2026-10-30T00:00:00Z", prompt: "compiled prompt", inputPrompt: "editable input",
        parameters: { model: "gpt-image-2", size: "1:1", quality: "1k", imageOptions: "", systemPrompt: "", count: 1, generationType: "edit" },
        references: [
            { id: "removed", sourceNodeId: "removed", referenceKey: "node:removed", name: "deleted input", type: "image/png", content: "https://local/removed.png", origin: "canvas", order: 0 },
            { id: "upload", referenceKey: "upload:ref", name: "retained upload", type: "image/png", content: "https://local/upload.png", origin: "upload", order: 1 },
        ],
    } },
};

function render(node: CanvasNodeData, sharedConfig?: CanvasNodeData) {
    const business = useBusinessConfigStore.getInitialState();
    const savedBusiness = { ...business };
    const config = useConfigStore.getInitialState();
    const savedConfig = { ...config };
    const modules = useModuleStore.getInitialState();
    const savedModules = { ...modules };
    Object.assign(business, { status: "ready", models: [{ id: "image", modelId: "gpt-image-2", name: "Image", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 }], tools: [] });
    Object.assign(config, { config: { ...defaultConfig, model: "gpt-image-2", imageModel: "gpt-image-2" } });
    Object.assign(modules, { status: "ready", flags: Object.fromEntries(moduleKeys.map(key => [key, true])) });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
        return renderToStaticMarkup(<QueryClientProvider client={client}><CanvasNodePromptPanel node={node} sharedConfig={sharedConfig} canvasNodes={[node]} isRunning={false} onPromptChange={() => undefined} onConfigChange={() => undefined} onGenerate={() => undefined} onStop={() => undefined} onRestoreGeneration={() => undefined} /></QueryClientProvider>);
    } finally { Object.assign(business, savedBusiness); Object.assign(config, savedConfig); Object.assign(modules, savedModules); }
}

test("empty result panel renders a read-only archive separately from editable input and retains visible reference numbers", () => {
    const markup = render(result);
    expect(markup).toContain('aria-label="图片生成档案"');
    expect(markup).toContain('aria-label="复制生成时提示词"');
    expect(markup).toContain("compiled prompt");
    expect(markup).toMatch(/<textarea\b[^>]*>editable input<\/textarea>/);
    expect(markup).toContain('alt="retained upload"');
    expect(markup).toContain("图片2");
    expect(markup).not.toContain('alt="deleted input"');
    expect(markup).not.toContain('aria-label="移除参考图"');
});

test("incomplete old records warn and expose recovery instead of allowing a different request", () => {
    const legacy = { ...result, metadata: { prompt: "legacy input", generationType: "edit" as const, sourceTaskId: "task" } };
    const markup = render(legacy);
    expect(markup).toContain("旧版记录参考信息不完整，可恢复历史输入");
    expect(markup).toContain(">恢复历史输入</button>");
    const generate = markup.match(/<button\b[^>]*aria-label="生成"[^>]*>/)?.[0] || "";
    expect(generate).toContain('disabled=""');
});

test("shared targets keep inherited input and execution while showing their own archive", () => {
    const shared = { ...result, id: "config", type: CanvasNodeType.Config, title: "shared settings", metadata: { generationMode: "image" as const, composerContent: "inherited prompt", model: "gpt-image-2" } };
    const markup = render(result, shared);
    expect(markup).toContain('aria-label="图片生成档案"');
    expect(markup).toContain("compiled prompt");
    expect(markup).toContain('aria-label="公共提示词预览"');
    expect(markup).toContain("inherited prompt");
    expect(markup).toContain('aria-label="仅执行此任务"');
    expect(markup).not.toContain("<textarea");
});
