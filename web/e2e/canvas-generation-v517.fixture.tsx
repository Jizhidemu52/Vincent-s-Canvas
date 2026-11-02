import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import "antd/dist/reset.css";
import "../src/styles/globals.css";
import { CanvasNodeMaskEditDialog, type CanvasImageMaskEditPayload } from "../src/components/canvas/canvas-node-mask-edit-dialog";
import { useBusinessConfigStore } from "../src/stores/use-business-config-store";
import { useModuleStore } from "../src/stores/use-module-store";
import { defaultConfig } from "../src/stores/use-config-store";
import { moduleKeys } from "../src/services/api/modules";
import { CanvasImageEditorDialog } from "../src/components/canvas/canvas-image-editor-dialog";
import { CanvasNodeCropDialog } from "../src/components/canvas/canvas-node-crop-dialog";
import { CanvasImageViewerDialog } from "../src/components/canvas/canvas-image-viewer-dialog";
import { CanvasImageCompareDialog } from "../src/components/canvas/canvas-image-compare-dialog";
import { CanvasNodeUpscaleDialog } from "../src/components/canvas/canvas-node-upscale-dialog";
import { CanvasConfigNodePanel } from "../src/components/canvas/canvas-config-node-panel";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import { ImageSettingsPanel } from "../src/components/image-settings-panel";
import { imageTaskParameters } from "../src/services/api/image";
import { canvasThemes } from "../src/lib/canvas-theme";
import { CanvasGenerationRecordDetails } from "../src/components/canvas/canvas-generation-record-details";
import { ConnectionCreateMenu } from "../src/components/canvas/canvas-connection-create-menu";
import { CanvasGraphProvider, useCanvasGraphSetter } from "../src/stores/canvas/canvas-graph-store";
import { AudioSettingsPanel } from "../src/components/audio-settings-panel";

useBusinessConfigStore.setState({ status: "ready", models: [{ id: "mask-test", modelId: "mask-test", name: "局部编辑测试模型", publicName: "局部编辑测试模型", imageParameterProfile: "quality-resolution", imageSupportsMask: true, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 }, { id: "chat-test", modelId: "private-chat-test", name: "内部文本模型", publicName: "团队文案助手", capabilities: ["chat"], creditCost: 0, rmbCost: 0 }], tools: [{ toolKey: "gpt-chat", modelConfigId: "chat-test", enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 }], prices: [] });
useModuleStore.setState({ status: "ready", flags: Object.fromEntries(moduleKeys.map(key => [key, true])) as ReturnType<typeof useModuleStore.getState>["flags"] });
const canvas = document.createElement("canvas"); canvas.width = 333; canvas.height = 517;
const context = canvas.getContext("2d")!; context.fillStyle = "#d9bd91"; context.fillRect(0, 0, 333, 517);
context.fillStyle = "#3c5270"; context.fillRect(70, 80, 190, 340);
const dataUrl = canvas.toDataURL("image/png");
const fixtureImage: CanvasNodeData = { id: "one", type: CanvasNodeType.Image, title: "预览样衣", width: 333, height: 517, position: { x: 0, y: 0 }, metadata: { content: dataUrl, naturalWidth: 333, naturalHeight: 517, mimeType: "image/png", bytes: 12345 } };

function ConnectionFixture() {
    const setNodes = useCanvasGraphSetter("nodes"), [open, setOpen] = useState(false), [selected, setSelected] = useState("");
    const params = new URLSearchParams(location.search), scale = Number(params.get("zoom") || 1);
    const sourceType = params.get("source") === "audio" ? CanvasNodeType.Audio : CanvasNodeType.Image;
    useEffect(() => { setNodes([{ ...fixtureImage, type: sourceType }]); setOpen(true); }, [sourceType, setNodes]);
    return <><button onClick={() => setOpen(true)}>重新拉线</button><output data-testid="connection-created">{selected}</output><div style={{ position: "absolute", inset: 0, pointerEvents: "none", transform: `scale(${scale})`, transformOrigin: "0 0" }}>{open ? <ConnectionCreateMenu pending={{ position: { x: (window.innerWidth - 2) / scale, y: (window.innerHeight - 2) / scale }, connection: { nodeId: "one", handleId: "output", handleType: "source" } }} onClose={() => setOpen(false)} onCreate={type => { setSelected(type); setOpen(false); }} /> : null}</div></>;
}

function Fixture() {
    const [open, setOpen] = useState(true);
    const [submission, setSubmission] = useState<CanvasImageMaskEditPayload | null>(null);
    const [crop, setCrop] = useState("");
    const [selected, setSelected] = useState("one");
    const [configuration, setConfiguration] = useState<CanvasNodeData>({ id: "config", type: CanvasNodeType.Config, title: "可复用生成配置", width: 380, height: 300, position: { x: 0, y: 0 }, metadata: { model: "mask-test", generationMode: "image", prompt: "保留样衣结构与面料纹理，制作商务蓝色款。", count: 4, configImageInputMode: "combined" } });
    const [generationClicks, setGenerationClicks] = useState(0);
    const [advancedConfig, setAdvancedConfig] = useState({ ...defaultConfig, model: "mask-test", imageModel: "mask-test" });
    const [advancedSubmitted, setAdvancedSubmitted] = useState("");
    const tool = new URLSearchParams(location.search).get("tool");
    if (tool === "connection") return <CanvasGraphProvider><ConnectionFixture /></CanvasGraphProvider>;
    if (tool === "audio") return <div style={{ width: 350, padding: 16 }}><AudioSettingsPanel config={advancedConfig} onConfigChange={(key, value) => setAdvancedConfig(config => ({ ...config, [key]: value }))} theme={canvasThemes.light} className="space-y-4" /></div>;
    if (tool === "advanced") return <div style={{ maxWidth: 640, margin: "30px auto" }}><ImageSettingsPanel config={advancedConfig} theme={canvasThemes.light} spacious onConfigChange={(key, value) => setAdvancedConfig(config => ({ ...config, [key]: value }))} /><button onClick={() => setAdvancedSubmitted(JSON.stringify(imageTaskParameters(advancedConfig)))}>检查发送参数</button><output data-testid="advanced-submitted">{advancedSubmitted}</output><CanvasGenerationRecordDetails node={{ ...fixtureImage, metadata: { generationRecord: { version: 1, id: "archive", sourceNodeId: "source", createdAt: "now", prompt: "蓝色衬衫", inputPrompt: "蓝色衬衫", submittedPrompt: "蓝色衬衫\n\n排除要求：水印", references: [], parameters: { model: "mask-test", size: "1:1", quality: "high", imageOptions: "{}", systemPrompt: "", count: 1, generationType: "generation" } } } }} draftPrompt="蓝色衬衫" /></div>;
    if (tool === "config") return <><output data-testid="config-generated">{generationClicks}</output><div data-testid="configuration-node" style={{ width: 380, height: 300, background: "#f5f2ee" }}><CanvasConfigNodePanel node={configuration} isRunning={false} imageReferences={Array.from({ length: 8 }, (_, index) => ({ id: `image-${index}`, referenceKey: `image:${index}`, name: `样衣${index + 1}`, type: "image/png", dataUrl, origin: "upload" as const, originLabel: "上传" }))} inputSummary={{ textCount: 0, imageCount: 8, videoCount: 0, audioCount: 0 }} onConfigChange={(_id, patch) => setConfiguration(node => ({ ...node, metadata: { ...node.metadata, ...patch } }))} onGenerate={() => setGenerationClicks(value => value + 1)} onStop={() => {}} /></div></>;
    if (tool === "crop") return <><output data-testid="crop-result">{crop}</output><CanvasNodeCropDialog dataUrl={dataUrl} open onClose={() => {}} onConfirm={async value => { setCrop(JSON.stringify(value)); await new Promise(resolve => setTimeout(resolve, 300)); }} /></>;
    if (tool === "editor") return <CanvasImageEditorDialog node={fixtureImage} onClose={() => {}} onConfirm={async () => {}} />;
    if (tool === "viewer") { const nodes = [fixtureImage, { ...fixtureImage, id: "two", title: "第二张样衣" }]; return <CanvasImageViewerDialog node={nodes.find(node => node.id === selected)!} nodes={nodes} onSelect={setSelected} onClose={() => {}} />; }
    if (tool === "compare") return <CanvasImageCompareDialog nodes={[fixtureImage, { ...fixtureImage, id: "two", metadata: { ...fixtureImage.metadata, content: canvas.toDataURL("image/jpeg"), imageName: "改款后" } }]} initialIds={["one", "two"]} onClose={() => {}} />;
    if (tool === "upscale") return <CanvasNodeUpscaleDialog dataUrl={dataUrl} open onClose={() => {}} onConfirm={() => {}} />;
    return <>
        <button onClick={() => setOpen(true)}>重新打开</button>
        <output data-testid="submitted" data-prompt={submission?.prompt} data-mask={submission?.maskDataUrl}>{submission ? "已提交到测试接收器" : "未提交"}</output>
        <CanvasNodeMaskEditDialog dataUrl={dataUrl} open={open} config={{ ...defaultConfig, model: "mask-test", imageModel: "mask-test" }} model="mask-test" onModelChange={() => {}} onClose={() => setOpen(false)} onConfirm={setSubmission} />
    </>;
}
createRoot(document.getElementById("root")!).render(<App><Fixture /></App>);
