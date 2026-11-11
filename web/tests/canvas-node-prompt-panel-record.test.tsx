import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CanvasNodePromptPanel } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasGenerationRecordDetails } from "@/components/canvas/canvas-generation-record-details";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useModuleStore } from "@/stores/use-module-store";
import { moduleKeys } from "@/services/api/modules";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "@/types/canvas";
import { createCanvasDesignTemplate } from "@/lib/canvas/canvas-design-templates";

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

function render(node: CanvasNodeData, sharedConfig?: CanvasNodeData, canvasNodes = [node], canvasConnections: CanvasConnection[] = []) {
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
        return renderToStaticMarkup(<QueryClientProvider client={client}><CanvasNodePromptPanel node={node} sharedConfig={sharedConfig} canvasNodes={canvasNodes} canvasConnections={canvasConnections} isRunning={false} onPromptChange={() => undefined} onConfigChange={() => undefined} onGenerate={() => undefined} onStop={() => undefined} onRestoreGeneration={() => undefined} onUploadOriginal={() => undefined} onUseReferenceAsOriginal={async () => undefined} /></QueryClientProvider>);
    } finally { Object.assign(business, savedBusiness); Object.assign(config, savedConfig); Object.assign(modules, savedModules); }
}

test("template source setup makes original upload explicit and offers single-attachment promotion only", () => {
    const graph = createCanvasDesignTemplate("development", undefined, { x: 0, y: 0 });
    const source = graph.nodes[0];
    const empty = render(source, undefined, graph.nodes, graph.connections);
    expect(empty).toContain('aria-label="参考款原图设置"');
    expect(empty).toContain("上传参考款原图");
    expect(empty).not.toContain('aria-label="生成"');
    expect(empty).not.toContain("<textarea");
    source.metadata!.manualImageReferences = [{ id: "attached", referenceKey: "upload:attached", origin: "upload", name: "coat.png", type: "image/png", content: "data:image/png;base64,coat", storageKey: "image:coat" }];
    expect(render(source, undefined, graph.nodes, graph.connections)).toContain("将这张参考图设为原图");
    source.metadata!.manualImageReferences.push({ ...source.metadata!.manualImageReferences[0], id: "second", referenceKey: "upload:second" });
    expect(render(source, undefined, graph.nodes, graph.connections)).not.toContain("将这张参考图设为原图");
    expect(render(source)).not.toContain('aria-label="参考款原图设置"');
});

test("empty result panel renders a read-only archive separately from editable input and shows every submitted reference", () => {
    const markup = render(result);
    expect(markup).toContain('aria-label="图片生成档案"');
    expect(markup).toContain('aria-label="复制生成时提示词"');
    expect(markup).toContain("compiled prompt");
    expect(markup).toMatch(/<textarea\b[^>]*>editable input<\/textarea>/);
    expect(markup).toMatch(/alt="deleted input"[\s\S]*>图片1<[\s\S]*alt="retained upload"[\s\S]*>图片2</);
    expect(markup.match(/<img\b/g)).toHaveLength(2);
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

test("quick records hide managed prompt and model without blocking an explicit ordinary draft", () => {
    const node: CanvasNodeData = { ...result, metadata: { ...result.metadata, quickImageAction: "hd-upscale", model: "private-admin-model", prompt: "private admin recipe",
        generationRecord: { ...result.metadata!.generationRecord!, prompt: "private admin recipe", inputPrompt: "private admin input", parameters: { ...result.metadata!.generationRecord!.parameters, model: "private-admin-model" } } } };
    const before = structuredClone(node);
    const markup = render(node);
    expect(markup).not.toContain('aria-label="图片生成档案"');
    expect(markup).not.toContain("private admin");
    expect(markup).not.toContain("private-admin-model");
    expect(markup).toMatch(/<textarea\b[^>]*><\/textarea>/);
    expect(render({ ...node, metadata: { ...node.metadata, draftPrompt: "my ordinary edit" } })).toContain("my ordinary edit");
    expect(node).toEqual(before);
});

test("an ordinary parent's derivative list describes quick actions without revealing their recipe", () => {
    const child: CanvasNodeData = { ...result, id: "quick", title: "quick image", metadata: { ...result.metadata, quickImageAction: "remove-background", prompt: "private recipe",
        generationRecord: { ...result.metadata!.generationRecord!, prompt: "private recipe" } } };
    const markup = renderToStaticMarkup(<CanvasGenerationRecordDetails node={result} draftPrompt="editable input" derivatives={[child]} onLocate={() => undefined} />);
    expect(markup).toContain("compiled prompt");
    expect(markup).toContain("一键去背景");
    expect(markup).not.toContain("private recipe");
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
