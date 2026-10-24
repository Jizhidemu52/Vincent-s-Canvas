import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CanvasQuickGeneratePanel } from "@/components/canvas/canvas-quick-generate-panel";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { CanvasNodePromptPanel } from "@/components/canvas/canvas-node-prompt-panel";
import { defaultConfig } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useModuleStore } from "@/stores/use-module-store";
import { moduleKeys } from "@/services/api/modules";
import { canvasToolKey } from "@/hooks/use-tool-config";
import { createImageReferenceItem } from "@/lib/image-reference-policy";
import { toCanvasStoredImageReference } from "@/lib/canvas/canvas-image-references";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { imageModelProfile, normalizeImageModelSettings } from "@/lib/image-model-settings";

const noop = () => undefined;
const model = { id: "blend-uuid", modelId: "blend-uuid", name: "aplmart-mj-blend", imageParameterProfile: "midjourney-blend" as const, imageSupportsMask: false, capabilities: ["generate"], creditCost: 0, rmbCost: 0 };
const references = (count: number) => Array.from({ length: count }, (_, index) => ({ id: String(index), name: `reference-${index}.png`, type: "image/png", dataUrl: `https://example.test/${index}.png` }));
function configured<T>(run: () => T) {
    const business = useBusinessConfigStore.getInitialState(), previousBusiness = { ...business };
    const modules = useModuleStore.getInitialState(), previousModules = { ...modules };
    Object.assign(business, { models: [model], tools: [], status: "ready" });
    Object.assign(modules, { status: "ready", flags: Object.fromEntries(moduleKeys.map(key => [key, true])) });
    try { return run(); } finally { Object.assign(business, previousBusiness); Object.assign(modules, previousModules); }
}
function actionButton(html: string, label: string) {
    const result = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find(item => item.includes(label));
    if (!result) throw new Error(`Missing button ${label}`);
    return result;
}

test.each([0, 1, 2, 4, 5])("Blend quick canvas with %i references hides old prompt and obeys its exact input range", count => configured(() => {
    const html = renderToStaticMarkup(<CanvasQuickGeneratePanel embedded open promptRef={{ current: "OLD_DRAFT_MUST_NOT_SHOW" }} promptRevision={0} model={model.id} size="3:2" quality="turbo" count={9} imageOptions="" running={false} config={defaultConfig} estimateCredits={0} estimateRmb={0} references={references(count)} onClose={noop} onModelChange={noop} onSizeChange={noop} onQualityChange={noop} onCountChange={noop} onImageOptionsChange={noop} onPickReferences={noop} onRemoveReference={noop} onClearReferences={noop} onMoveReference={noop} onMissingConfig={noop} onGenerate={noop} />);
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("OLD_DRAFT_MUST_NOT_SHOW");
    expect(html).not.toContain('aria-label="生成张数"');
    const action = actionButton(html, "开始融合");
    expect(action).toContain('aria-label="每次生成 1 张"');
    expect(action).toContain("×1</span>");
    expect(normalizeImageModelSettings({ size: "3:2", quality: "turbo", count: "9" }, imageModelProfile(model.id, [model])).count).toBe("1");
    expect(action.includes('disabled=""')).toBe(count < 2 || count > 4);
}));

test.each([1, 2, 4, 5])("Blend Config node with %i references cannot assemble a prompt or fan out old counts", count => configured(() => {
    const node: CanvasNodeData = { id: "config", type: CanvasNodeType.Config, title: "配置", position: { x: 0, y: 0 }, width: 300, height: 240, metadata: { generationMode: "image", model: model.id, count: 9, composerContent: "OLD_DRAFT_MUST_NOT_SHOW" } };
    const html = renderToStaticMarkup(<CanvasConfigNodePanel node={node} isRunning={false} inputSummary={{ textCount: 1, imageCount: count, videoCount: 0, audioCount: 0 }} onConfigChange={noop} onGenerate={noop} onStop={noop} onComposerToggle={noop} />);
    expect(html).not.toContain("组装提示词");
    expect(html).not.toContain("OLD_DRAFT_MUST_NOT_SHOW");
    expect(html).toContain("1 个任务");
    expect(actionButton(html, "开始生成").includes('disabled=""')).toBe(count < 2 || count > 4);
}));

test("an ordinary image node can submit Blend with two references and no prompt editor", () => configured(() => {
    const node: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "新图", position: { x: 0, y: 0 }, width: 300, height: 300, metadata: { model: model.id, count: 10, draftPrompt: "OLD_DRAFT_MUST_NOT_SHOW", manualImageReferences: references(2).map(item => toCanvasStoredImageReference(createImageReferenceItem(item, "upload"))) } };
    const client = new QueryClient();
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><CanvasNodePromptPanel node={node} isRunning={false} onPromptChange={noop} onConfigChange={noop} onGenerate={noop} onStop={noop} canvasNodes={[node]} /></QueryClientProvider>);
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("OLD_DRAFT_MUST_NOT_SHOW");
    expect(html).toMatch(/<button[^>]*aria-label="生成"/);
    expect(html.match(/<button[^>]*aria-label="生成"[^>]*>/)?.[0]).not.toContain('disabled=""');
    expect(canvasToolKey("image", true, "midjourney-blend")).toBe("canvas-image");
    expect(canvasToolKey("image", true, "grok-image")).toBe("canvas-edit");
    client.clear();
}));
