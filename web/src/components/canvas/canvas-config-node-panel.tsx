import { PromptOptimizeButton } from "@/components/prompt-optimize-button";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Image as ImageIcon, LoaderCircle, MessageSquare, Music2, Play, Square, Video } from "lucide-react";
import { Button, Input, Segmented } from "antd";

import { ModelPicker } from "@/components/model-picker";
import { defaultConfig, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { CreditSymbol, requestCreditCost } from "@/constant/credits";
import { canvasThemes } from "@/lib/canvas-theme";
import { deploymentFeatures } from "@/lib/deployment-features";
import { useThemeStore } from "@/stores/use-theme-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { resolveCapabilityModel } from "@/lib/model-picker-options";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import type { CanvasGenerationMode, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { canvasToolKey, useToolConfig, useToolEnabled } from "@/hooks/use-tool-config";
import { imageModelProfile, useImageModelProfile } from "@/lib/image-model-settings";
import { configUsesSeparateImageInputs } from "@/lib/canvas/canvas-shared-connections";
import { CanvasConfigComposer, CONFIG_REFERENCE_PATTERN, type CanvasConfigComposerHandle } from "./canvas-config-composer";
import { CanvasConfigImageReferences } from "./canvas-config-image-references";
import type { NodeGenerationInput } from "./canvas-node-generation";
import type { ImageReferenceItem } from "@/types/image";
import { resolveCanvasImageConfig } from "@/lib/canvas/canvas-generation-model";

type CanvasConfigNodePanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    linkedTaskCount?: number;
    linkedTaskHasImages?: boolean;
    inputImageTaskCount?: number;
    inputs?: NodeGenerationInput[];
    imageReferences?: ImageReferenceItem[];
    inputSummary: { textCount: number; imageCount: number; videoCount: number; audioCount: number };
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onGenerate: (nodeId: string) => void;
    onStop: (nodeId: string) => void;
    onComposerToggle?: () => void;
    workflow?: { status?: string; stepStatus?: string; onRun: () => void; onStop: () => void };
};

export function CanvasConfigNodePanel({ node, isRunning, linkedTaskCount = 0, linkedTaskHasImages = false, inputSummary, inputImageTaskCount = inputSummary.imageCount, inputs = [], imageReferences, onConfigChange, onGenerate, onStop, workflow }: CanvasConfigNodePanelProps) {
    const [optimizing, setOptimizing] = useState(false);
    const composerRef = useRef<CanvasConfigComposerHandle>(null);
    const [inputModeFeedback, setInputModeFeedback] = useState<{ error: boolean; text: string } | null>(null);
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const businessModels = useBusinessConfigStore((state) => state.models);
    const businessTools = useBusinessConfigStore((state) => state.tools);
    const businessConfigStatus = useBusinessConfigStore((state) => state.status);
    const mode = node.metadata?.generationMode || "image";
    const selectedModel = businessConfigStatus === "ready" ? mode === "text" ? globalConfig.textModel : resolveCapabilityModel(globalConfig, mode, businessModels, node.metadata?.model) : "";
    const references = imageReferences || [];
    const imageCount = imageReferences?.length ?? inputSummary.imageCount;
    const hasImages = imageCount > 0 || linkedTaskHasImages || Boolean(workflow);
    let toolKey = canvasToolKey(mode, hasImages, imageModelProfile(selectedModel, businessModels).kind);
    const initialToolKey = toolKey;
    let imageModelIsBound = false;
    let config = useToolConfig(buildNodeConfig(globalConfig, node, mode, selectedModel), toolKey);
    let routingError = "";
    if (mode === "image" && businessConfigStatus === "ready") {
        try {
            const resolved = resolveCanvasImageConfig(buildNodeConfig(globalConfig, node, mode, selectedModel), { models: businessModels, tools: businessTools, prices: [] }, hasImages);
            config = resolved.config;
            toolKey = resolved.toolKey;
            imageModelIsBound = resolved.isBound;
        } catch (error) {
            routingError = error instanceof Error ? error.message : "当前生图模型配置不可用";
            config = { ...config, model: "", imageModel: "" };
        }
    }
    const boundModelId = businessTools.find(item => item.toolKey === toolKey)?.modelConfigId;
    const modelIsBound = Boolean(boundModelId) || imageModelIsBound;
    const pickerToolKey = imageModelIsBound && !boundModelId ? initialToolKey : toolKey;
    const model = config.model;
    const profile = useImageModelProfile(model);
    const blend = mode === "image" && !profile.requiresPrompt;
    const separateImages = configUsesSeparateImageInputs(node, inputImageTaskCount, linkedTaskCount, profile.requiresPrompt);
    const taskCount = linkedTaskCount || (separateImages ? inputImageTaskCount : 0);
    const showInputMode = mode === "image" && !blend && !linkedTaskCount && inputImageTaskCount > 1;
    const toolEnabled = useToolEnabled(toolKey);
    const hasAvailableModel = Boolean(model);
    const count = 1;
    const credits = requestCreditCost({ channelMode: config.channelMode, model: config.model, count: mode === "image" ? count : 1 }) * Math.max(1, taskCount);
    const chipStyle = { background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text };
    const hasAnyInput = Boolean(linkedTaskCount || inputSummary.textCount || (mode !== "audio" && imageCount) || (mode === "video" && (inputSummary.videoCount || inputSummary.audioCount)));
    const hasComposerContent = Boolean((node.metadata?.composerContent ?? node.metadata?.prompt ?? "").trim());
    const hasPromptInput = hasComposerContent || (inputs.length ? inputs.some(input => Boolean(input.text?.trim())) : inputSummary.textCount > 0);
    const modelIsSynced = mode === "text" || modelIsBound || node.metadata?.model === model;
    const inputModeCheck = separateImages ? configImageInputModeChange(node, references, inputs, "per-image", node.metadata?.composerContent ?? node.metadata?.prompt ?? "") : undefined;
    const fixedTaskReference = inputModeCheck && (!inputModeCheck.patch || inputModeCheck.patch.composerContent !== undefined);
    const canGenerate = !optimizing && toolEnabled && hasAvailableModel && modelIsSynced && !fixedTaskReference && (linkedTaskCount > 0 || (blend ? imageCount >= 2 && imageCount <= 4 : mode === "video" ? hasPromptInput || hasAnyInput : hasPromptInput));
    const referencePresentation = configReferencePresentation(references, inputs, mode, separateImages);
    const changeInputMode = (value: "per-image" | "combined") => {
        const prompt = composerRef.current?.read() ?? node.metadata?.composerContent ?? node.metadata?.prompt ?? "";
        const result = configImageInputModeChange(node, references, inputs, value, prompt);
        setInputModeFeedback(result.feedback || null);
        if (!result.patch) return;
        composerRef.current?.replace(result.patch.composerContent ?? prompt);
        onConfigChange(node.id, result.patch);
    };

    useEffect(() => {
        if (mode !== "text" && !routingError && !modelIsBound && !isRunning && businessConfigStatus === "ready" && (node.metadata?.model || "") !== model) onConfigChange(node.id, { model });
    }, [mode, routingError, modelIsBound, businessConfigStatus, isRunning, model, node.id, node.metadata?.model, onConfigChange]);

    return (
        <div className="thin-scrollbar flex h-full w-full cursor-move flex-col overflow-y-auto px-3 pb-3 pt-7 text-sm" style={{ color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between gap-3">
                <div className="min-w-0 truncate text-sm font-semibold" title={node.title}>{node.title || "生成配置"}</div>
                <div className="cursor-default" onMouseDown={(event) => event.stopPropagation()}>
                    <Segmented
                        size="small"
                        className="canvas-config-mode !rounded-md !p-0.5"
                        value={mode}
                        disabled={isRunning || Boolean(workflow)}
                        onChange={(value) => {
                            const nextMode = value as CanvasGenerationMode;
                            const nextModel = businessConfigStatus === "ready" ? nextMode === "text" ? globalConfig.textModel : resolveCapabilityModel(globalConfig, nextMode, businessModels, node.metadata?.model) : "";
                            onConfigChange(node.id, { generationMode: nextMode, model: nextModel });
                        }}
                        options={[
                            {
                                value: "image",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <ImageIcon className="size-3.5" />
                                        生图
                                    </span>
                                ),
                            },
                            {
                                value: "text",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <MessageSquare className="size-3.5" />
                                        文本
                                    </span>
                                ),
                            },
                            {
                                value: "video",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <Video className="size-3.5" />
                                        视频
                                    </span>
                                ),
                            },
                            {
                                value: "audio",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <Music2 className="size-3.5" />
                                        音频
                                    </span>
                                ),
                            },
                        ]}
                    />
                </div>
            </div>

            <div className="mb-2 text-[11px] leading-4" style={{ color: theme.node.muted }}>
                {showInputMode ? <div className="mb-1 cursor-default" onMouseDown={event => event.stopPropagation()}>
                    <Segmented block size="small" aria-label="图片执行方式" disabled={isRunning}
                        value={separateImages ? "per-image" : "combined"}
                        onChange={value => changeInputMode(value as "per-image" | "combined")}
                        options={[{ value: "per-image", label: `逐图执行 · ${inputImageTaskCount} 个任务` }, { value: "combined", label: "合并参考 · 1 个任务" }]} />
                </div> : <div>{workflow ? "工作流：左侧接原图或上一步，右侧接下一步配置" : "左侧接素材；右侧接下一步生图配置可创建工作流"}</div>}
                {workflow ? <div role="status">{workflow.stepStatus === "success" ? "本步已完成" : workflow.stepStatus === "running" ? isRunning ? "本步正在执行" : "本步待核查" : workflow.stepStatus === "failed" ? "本步失败，下游未提交" : "上游出图后自动执行本步"} · 每步单独调用，请保持本页打开</div> : null}
                {taskCount > 0 ? <div role="status"><span style={{ color: theme.node.text }}>待执行 {taskCount} 个任务</span> · {separateImages ? "每个任务主图均为图片1，公共参考从图片2起" : "每个任务使用自身输入与公共素材"}</div> : showInputMode ? <div role="status">多张参考图共同生成 1 张结果</div> : null}
                {inputModeFeedback ? <div role={inputModeFeedback.error ? "alert" : "status"} className="mt-1">{inputModeFeedback.text}</div> : null}
                {fixedTaskReference ? <div role="alert" className="mt-1">逐图提示词仍固定引用某张任务图片。请改为“图片1”（每个任务的主图）；需要固定共享的图片请添加为公共参考，或切回合并参考。</div> : null}
            </div>

            <div className="mb-2 shrink-0 space-y-2">
                {workflow ? <div className="cursor-text" onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
                    <div className="mb-2 text-xs font-semibold">提示词</div>
                    <Input.TextArea aria-label="提示词" autoSize={{ minRows: 3, maxRows: 6 }} disabled={isRunning}
                        value={(node.metadata?.composerContent ?? node.metadata?.prompt ?? "").replace(/@\[node:[^\]]+\]\n?/g, "")}
                        onChange={event => onConfigChange(node.id, { composerContent: event.target.value, prompt: event.target.value })} />
                    <div className="mt-2 text-[11px] opacity-60">输入图片由连线自动传入，无需在提示词中插入引用。</div>
                </div> : !blend ? <CanvasConfigComposer ref={composerRef} compact value={node.metadata?.composerContent ?? node.metadata?.prompt ?? ""} inputs={referencePresentation.inputs} referenceLabels={referencePresentation.mentionLabels} disabled={isRunning} label={mode === "audio" ? "朗读文本" : "提示词"} onChange={composerContent => { setInputModeFeedback(null); onConfigChange(node.id, { composerContent, ...(node.metadata?.promptInput?.scene === "free-optimize" ? { promptInput: undefined, compiledPrompt: undefined } : {}) }); }} /> : <span role="status" className="text-xs">融合 2–4 张参考图，不使用提示词。</span>}
                {mode === "image" && !blend && (!node.metadata?.promptInput || node.metadata.promptInput.scene === "free-optimize") ? <PromptOptimizeButton config={config} prompt={node.metadata?.composerContent ?? node.metadata?.prompt ?? ""} references={references} toolKey={toolKey} disabled={isRunning} onBusyChange={setOptimizing} onApply={(value, _compilation, input) => { composerRef.current?.replace(value); onConfigChange(node.id, { prompt: value, composerContent: value, promptInput: input, compiledPrompt: value }); }} /> : null}
                {node.metadata?.optimizingPrompt ? <span role="status" className="text-xs">正在优化提示词…</span> : null}
                {mode !== "audio" && !workflow ? <CanvasConfigImageReferences node={node} references={references} labels={referencePresentation.trayLabels} disabled={isRunning} onChange={onConfigChange} /> : null}
                {mode === "video" && (inputSummary.videoCount > 0 || inputSummary.audioCount > 0) ? <div className="flex flex-wrap gap-1.5">
                    {inputSummary.videoCount > 0 ? <InputChip label="已连视频" value={`${inputSummary.videoCount} 个`} style={chipStyle} /> : null}
                    {inputSummary.audioCount > 0 ? <InputChip label="已连音频" value={`${inputSummary.audioCount} 个`} style={chipStyle} /> : null}
                </div> : null}
            </div>

            {mode !== "text" ? <div className={`mb-2 grid min-w-0 cursor-default items-center gap-2 ${hasAvailableModel ? "grid-cols-[minmax(0,1fr)_148px]" : "grid-cols-1"}`} onMouseDown={(event) => event.stopPropagation()}>
                <ModelPicker toolKey={pickerToolKey} className="canvas-compact-control h-10" config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability={mode} modelsSource="server" disabled={isRunning} onMissingConfig={() => openConfigDialog(true)} fullWidth />
                {hasAvailableModel && mode === "video" ? (
                    <CanvasVideoSettingsPopover config={config} placement="topRight" buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))} />
                ) : hasAvailableModel && mode === "image" ? (
                    <CanvasImageSettingsPopover config={config} taskCount={Math.max(1, taskCount)} referenceCount={separateImages ? 1 + (node.metadata?.manualImageReferences?.length || 0) : imageCount} placement="topRight" autoAdjustOverflow={false} buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })} />
                ) : hasAvailableModel && mode === "audio" ? (
                    <CanvasAudioSettingsPopover config={config} placement="topRight" buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                ) : null}
            </div> : null}

            {routingError ? <div role="alert" className="mb-2 text-xs" style={{ color: theme.node.muted }}>{routingError}</div> : null}
            <Button
                type="primary"
                className="mt-auto shrink-0 !h-9 !w-full !cursor-pointer !rounded-lg"
                danger={isRunning}
                disabled={!workflow && !isRunning && !canGenerate}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => { if (workflow) { if (isRunning) workflow.onStop(); else workflow.onRun(); } else if (isRunning) onStop(node.id); else if (canGenerate) onGenerate(node.id); }}
            >
                <span className="inline-flex items-center gap-1.5">
                    {workflow ? <>{isRunning ? <Square className="size-4" /> : <Play className="size-4" />}<span>{isRunning ? "停止工作流" : workflow.status === "success" ? "重新运行工作流" : workflow.status === "failed" || workflow.status === "stopped" ? "继续工作流" : "运行工作流"}</span></> : isRunning ? (
                        <>
                            <LoaderCircle className="size-4 animate-spin" />
                            <Square className="size-3.5 fill-current" />
                            <span>停止</span>
                        </>
                    ) : (
                        <>
                            {deploymentFeatures.creditsEnabled ? <span className="inline-flex items-center gap-1">
                                <CreditSymbol />
                                {credits.toLocaleString()}
                            </span> : null}
                            <Play className="size-4" />
                            <span>{taskCount > 0 ? `执行 ${taskCount} 个任务` : showInputMode ? "合并参考生成 1 张" : "开始生成"}</span>
                        </>
                    )}
                </span>
            </Button>
        </div>
    );
}

/** A fixed task image can become the current primary; distinct image roles cannot be merged safely. */
export function configImageInputModeChange(node: CanvasNodeData, references: ImageReferenceItem[], inputs: NodeGenerationInput[], mode: "per-image" | "combined", prompt: string): {
    patch?: Partial<CanvasNodeMetadata>; feedback?: { error: boolean; text: string };
} {
    const patch: Partial<CanvasNodeMetadata> = { configImageInputMode: mode };
    if (prompt !== (node.metadata?.composerContent ?? node.metadata?.prompt ?? "")) patch.composerContent = prompt;
    if (mode !== "per-image") return { patch };
    const commonAliases = new Set([
        ...references.filter(image => image.origin !== "connection").flatMap(image => [image.id, image.referenceKey]),
        ...(node.metadata?.manualImageReferences || []).flatMap(image => [image.id, image.referenceKey, image.sourceNodeId].filter((id): id is string => Boolean(id))),
    ]);
    const inputAliases = new Map(inputs.filter(input => input.type === "image").flatMap(input => [[input.nodeId, input.nodeId], [`node:${input.nodeId}`, input.nodeId]]));
    const activeIds = new Set(references.filter(image => image.origin === "connection").map(image => image.id));
    const taskTokens = [...prompt.matchAll(CONFIG_REFERENCE_PATTERN)].filter(match => !commonAliases.has(match[1]!) && inputAliases.has(match[1]!));
    if (taskTokens.some(match => !activeIds.has(inputAliases.get(match[1]!)!))) return { feedback: { error: true, text: "提示词仍引用已移除的任务图片，请先删除该引用或恢复图片；当前仍为合并参考模式。" } };
    if (new Set(taskTokens.map(match => inputAliases.get(match[1]!))).size > 1) return { feedback: { error: true, text: "提示词指定了多张不同的任务图片，已保留合并参考。请将每个任务的主图改写为“图片1”；需要固定共享的图片请添加为公共参考。" } };
    if (!taskTokens.length) return { patch };
    const aliases = new Set(taskTokens.map(match => match[1]!));
    patch.composerContent = prompt.replace(CONFIG_REFERENCE_PATTERN, (token, id: string) => aliases.has(id) ? "图片1" : token);
    return { patch, feedback: { error: false, text: "已将任务图片引用改为“图片1”（每个任务的当前主图），公共参考引用保持不变。" } };
}

export function configReferencePresentation(references: ImageReferenceItem[], inputs: NodeGenerationInput[], mode: CanvasGenerationMode, separateImages: boolean) {
    const common = separateImages ? references.filter(image => image.origin !== "connection") : references;
    const taskIds = inputs.filter(input => input.type === "image" && references.some(image => image.origin === "connection" && image.id === input.nodeId)).map(input => input.nodeId);
    const trayLabels = separateImages ? Object.fromEntries(references.map(image => [image.referenceKey, image.origin === "connection" ? `任务输入${taskIds.indexOf(image.id) + 1}` : `图片${common.indexOf(image) + 2}`])) : undefined;
    const mentionLabels = separateImages ? Object.fromEntries(common.map((image, index) => [image.id, `图片${index + 2}`])) : undefined;
    return {
        trayLabels, mentionLabels,
        inputs: [
            ...inputs.filter(input => input.type !== "image" && (mode === "video" || input.type === "text")),
            ...(mode === "audio" ? [] : common.map(image => ({ nodeId: image.id, type: "image" as const, title: image.name, image }))),
        ],
    };
}

function InputChip({ label, value, style }: { label: string; value: string; style: CSSProperties }) {
    return (
        <div className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px]" style={style}>
            <span>{label}</span>
            <span className="font-medium">{value}</span>
        </div>
    );
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasGenerationMode, model: string): AiConfig {
    return {
        ...globalConfig,
        model,
        quality: node.metadata?.quality ?? globalConfig.quality ?? defaultConfig.quality,
        imageOptions: node.metadata?.imageOptions ?? globalConfig.imageOptions,
        size: node.metadata?.size || globalConfig.size || defaultConfig.size,
        videoSeconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        videoMode: node.metadata?.videoMode || globalConfig.videoMode || defaultConfig.videoMode,
        vquality: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node.metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        audioVoice: node.metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        count: String(node.metadata?.count || (mode === "image" ? globalConfig.canvasImageCount || globalConfig.count : globalConfig.count) || defaultConfig.count),
    };
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    return { audioInstructions: value };
}
