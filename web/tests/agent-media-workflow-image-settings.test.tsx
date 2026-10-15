import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasAgentMediaWorkflowCard } from "@/components/canvas/canvas-agent-media-workflow-card";
import { resolveOnlineToolExecution } from "@/components/canvas/canvas-assistant-panel";
import { createAgentMediaWorkflow, restoreAgentMediaWorkflow } from "@/lib/canvas/agent-media-workflow";
import { buildAgentMediaWorkflowStageOps } from "@/lib/canvas/agent-media-workflow-stage";
import { canvasThemes } from "@/lib/canvas-theme";
import { defaultConfig } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";

const original = useBusinessConfigStore.getState();
const initial = useBusinessConfigStore.getInitialState();
const initialModels = initial.models;
afterEach(() => { useBusinessConfigStore.setState(original); initial.models = initialModels; });
const models = [{ id: "mark-flare-id", modelId: "mark-flare-id", name: "aplmart-gpt2.5-flare", imageParameterProfile: "quality-resolution" as const, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 }];
const imageOptions = '{"resolution":"4k","output_format":"webp"}';
const workflow = () => createAgentMediaWorkflow({ intent: "image_to_video", prompt: "editorial fashion still", imageModel: "mark-flare-id", videoModel: "happyhorse-1.0", imageCount: 2, aspectRatio: "21:9", imageQuality: "max", imageOptions });

test("workflow persists independent image settings through restoration and image-node creation, without leaking into video", () => {
    const restored = restoreAgentMediaWorkflow(workflow(), []);
    expect(restored).toMatchObject({ imageQuality: "max", imageOptions });
    const image = buildAgentMediaWorkflowStageOps(restored, "image", []).ops.find(op => op.type === "add_node" && op.nodeType === "config");
    expect(image).toMatchObject({ metadata: { model: "mark-flare-id", quality: "max", imageOptions, count: 1, size: "21:9" } });
    const video = buildAgentMediaWorkflowStageOps(restored, "video", []).ops.find(op => op.type === "add_node" && op.nodeType === "config");
    expect(video && "metadata" in video ? video.metadata : {}).not.toHaveProperty("imageOptions");
    expect(video && "metadata" in video ? video.metadata : {}).not.toHaveProperty("quality");
});

test("online image-to-video dispatch snapshots the selected image quality and resolution", () => {
    const config = { ...defaultConfig, quality: "max", imageOptions };
    const execution = resolveOnlineToolExecution("canvas_generate_image", { prompt: "fashion still" }, "先生成图片，再选一张生成走秀视频", { projectId: "test", title: "test", nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } }, config);
    expect(execution).toMatchObject({ kind: "workflow", workflow: { imageQuality: "max", imageOptions } });
});

test("workflow card exposes independent quality and resolution using the shared settings panel", () => {
    useBusinessConfigStore.setState({ models });
    initial.models = models;
    const html = renderToStaticMarkup(<CanvasAgentMediaWorkflowCard workflow={workflow()} imageModels={["mark-flare-id"]} videoModels={[]} theme={canvasThemes.light} onImageSettingsChange={() => undefined} />);
    expect(html).toContain('aria-label="图片质量"');
    expect(html).toContain('aria-label="清晰度 / 分辨率"');
    expect(html).toContain('value="max" selected=""');
    expect(html).toContain('value="4k" selected=""');
});

test("workflow card resolves an opaque video selection to its public model name", () => {
    const video = { id: "d5000000-0000-4000-8000-000000000005", modelId: "d5000000-0000-4000-8000-000000000005", name: "aplmart-happyhorse1.1", capabilities: ["video"], creditCost: 0, rmbCost: 0 };
    const available = [...models, video];
    useBusinessConfigStore.setState({ models: available });
    initial.models = available;
    const html = renderToStaticMarkup(<CanvasAgentMediaWorkflowCard workflow={{ ...workflow(), videoModel: video.modelId }} imageModels={["mark-flare-id"]} videoModels={[video.modelId]} />);
    expect(html).toContain("aplmart-happyhorse1.1");
    expect(html).not.toContain(`>${video.modelId}<`);
});
