import { useUiText } from "@/lib/i18n";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import { App, Button } from "antd";

import { ModelPicker } from "@/components/model-picker";
import { defaultConfig, modelOptionName, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { CreditSymbol } from "@/constant/credits";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { deploymentFeatures } from "@/lib/deployment-features";
import { createClientId } from "@/lib/client-id";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { buildNodeGenerationContext } from "./canvas-node-generation";
import { CanvasGenerationRecordDetails } from "./canvas-generation-record-details";
import { CanvasPersistedMediaPreview } from "./canvas-persisted-media-preview";
import { canvasNodePromptPanelInput, createCanvasNodePromptDraft } from "./canvas-node-prompt-panel-state";
import { normalizeVideoModelConfig, resolveVideoMode, videoReferenceError } from "@/lib/video-model-parameters";
import { CanvasImageReferenceDialog } from "./canvas-image-reference-dialog";
import { ReferenceImageTray } from "@/components/reference-images/reference-image-tray";
import type { InsertAssetPayload } from "./asset-picker-modal";
import { loadAssetPickerModal } from "@/lib/canvas/canvas-node-tool-loaders";
import { createImageReferenceItem, dedupeImageReferences, validateImageReferences } from "@/lib/image-reference-policy";
import { resolveCanvasNodeImageReferences, toCanvasStoredImageReference } from "@/lib/canvas/canvas-image-references";
import { canvasNodePromptDraft } from "@/lib/canvas/canvas-node-prompt-draft";
import { assertCanvasImageUploadSize } from "@/lib/canvas/canvas-image-upload-limit";
import { uploadImage } from "@/services/image-storage";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { canvasToolKey, useToolConfig, useToolEnabled } from "@/hooks/use-tool-config";
import { useImageModelProfile } from "@/lib/image-model-settings";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

const AssetPickerModal = lazy(loadAssetPickerModal);

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onStop: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    onImageSettingsOpenChange?: (open: boolean) => void;
    canvasNodes?: CanvasNodeData[];
    canvasConnections?: CanvasConnection[];
    sharedConfig?: CanvasNodeData;
    onOpenSharedConfig?: (id: string) => void;
    onRestoreGeneration?: (nodeId: string) => void;
    onRegisterDraftFlush?: (flush: (() => void) | null) => void;
};

export function CanvasNodePromptPanel({ node, isRunning, onPromptChange, onConfigChange, onGenerate, onStop, mentionReferences = [], onImageSettingsOpenChange, canvasNodes = [], canvasConnections = [], sharedConfig, onOpenSharedConfig, onRestoreGeneration, onRegisterDraftFlush }: CanvasNodePromptPanelProps) {
    const t = useUiText();
    const { message } = App.useApp();
    const globalConfig = useEffectiveConfig();
    const estimate = useBusinessConfigStore((state) => state.estimate);
    const models = useBusinessConfigStore((state) => state.models);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = sharedConfig ? sharedConfig.metadata?.generationMode || "image" : defaultMode(node.type);
    const nodeConfig = buildNodeConfig(globalConfig, sharedConfig || node, mode);
    const imageInput = mode === "image" ? canvasNodePromptPanelInput(node, canvasNodes, canvasConnections, nodeConfig) : undefined;
    const baseConfig = sharedConfig ? nodeConfig : imageInput?.config || nodeConfig;
    const baseProfile = useImageModelProfile(baseConfig.model);
    const hasTaskImageInput = (sharedConfig ? resolveCanvasNodeImageReferences(node, canvasNodes, canvasConnections) : imageInput?.references || []).length > 0 || Boolean(sharedConfig && resolveCanvasNodeImageReferences(sharedConfig, canvasNodes, canvasConnections).length > 0);
    const toolKey = canvasToolKey(mode, mode === "image" && hasTaskImageInput, baseProfile.kind);
    const config = useToolConfig(baseConfig, toolKey);
    const profile = useImageModelProfile(config.model);
    const requiresPrompt = mode !== "image" || profile.requiresPrompt;
    const toolEnabled = useToolEnabled(toolKey);
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    const sourcePrompt = imageInput?.prompt ?? canvasNodePromptDraft(node);
    const [promptState, setPromptState] = useState({ nodeId: node.id, value: sourcePrompt });
    const prompt = promptState.nodeId === node.id ? promptState.value : sourcePrompt;
    const promptCommitRef = useRef(onPromptChange);
    promptCommitRef.current = onPromptChange;
    const promptDraft = useMemo(() => createCanvasNodePromptDraft(node.id, sourcePrompt, (nodeId, value) => promptCommitRef.current(nodeId, value)), [node.id]);
    const [canvasPickerOpen, setCanvasPickerOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const uploadInputRef = useRef<HTMLInputElement>(null);
    const imageReferences = imageInput?.references || [];
    const fixedReferenceKey = hasImageContent && !imageInput?.usesSnapshot ? imageReferences[0]?.referenceKey : undefined;
    const promptReferences: CanvasResourceReference[] = mode === "image" ? [
        ...(imageInput?.mentions || []),
        ...mentionReferences.filter(reference => reference.kind !== "image"),
    ] : mentionReferences;
    const referenceValidation = mode === "image" ? validateImageReferences(modelOptionName(config.model), imageReferences, profile) : { valid: true, minimum: 0, maximum: 16, supportsReferences: true };
    const videoContext = mode === "video" ? buildNodeGenerationContext(node.id, canvasNodes, canvasConnections, prompt) : null;
    const videoConfig = mode === "video" ? { ...config, ...normalizeVideoModelConfig(config) } : config;
    const videoValidation = videoContext ? videoReferenceError(videoConfig, videoContext.referenceImages, videoContext.referenceVideos, videoContext.referenceAudios) : "";
    const usage = estimate({ operationType: operationTypeForMode(mode, toolKey === "canvas-edit"), toolKey, modelId: modelOptionName(config.model), quantity: 1 });
    const credits = usage.configured ? usage.credits : 0;

    useEffect(() => {
        setPromptState(current => current.nodeId === node.id && current.value === sourcePrompt ? current : { nodeId: node.id, value: sourcePrompt });
        promptDraft.reset(sourcePrompt);
    }, [node.id, sourcePrompt, promptDraft]);

    useEffect(() => () => promptDraft.flush(), [promptDraft]);
    useEffect(() => {
        onRegisterDraftFlush?.(promptDraft.flush);
        return () => onRegisterDraftFlush?.(null);
    }, [onRegisterDraftFlush, promptDraft]);

    const updatePrompt = (value: string) => {
        setPromptState({ nodeId: node.id, value });
        promptDraft.change(value);
    };

    const submit = () => {
        const text = prompt.trim();
        if (!toolEnabled || (requiresPrompt && !text) || isRunning || !referenceValidation.valid || videoValidation || imageInput?.incompleteReferences) return;
        promptDraft.flush();
        onGenerate(node.id, mode, requiresPrompt ? text : "");
        // Retain the draft for refinement and failed-task recovery.
    };

    const saveReferences = (next: typeof imageReferences) => {
        const additional = next.filter(reference => reference.referenceKey !== fixedReferenceKey);
        const connectedKeys = new Set([...(node.metadata?.excludedConnectedImageReferenceKeys || []), ...imageReferences.filter((reference) => reference.origin === "connection").map((reference) => reference.referenceKey)]);
        const nextKeys = new Set(additional.map((reference) => reference.referenceKey));
        onConfigChange(node.id, {
            manualImageReferences: additional.filter((reference) => reference.origin !== "connection").map(toCanvasStoredImageReference),
            excludedConnectedImageReferenceKeys: [...connectedKeys].filter((key) => !nextKeys.has(key)),
            imageReferenceOrder: additional.map((reference) => reference.referenceKey),
        });
    };

    const addCanvasNodes = (nodeIds: string[]) => {
        const selected = canvasNodes.filter((candidate) => candidate.id !== node.id && nodeIds.includes(candidate.id) && candidate.type === CanvasNodeType.Image && candidate.metadata?.content)
            .map((candidate) => createImageReferenceItem({ id: candidate.id, name: `${candidate.title || candidate.id}.png`, type: candidate.metadata?.mimeType || "image/png", dataUrl: candidate.metadata!.content!, storageKey: candidate.metadata?.storageKey }, "canvas"));
        saveReferences(dedupeImageReferences([...imageReferences, ...selected]));
        setCanvasPickerOpen(false);
    };

    const addAssets = (payloads: InsertAssetPayload[]) => {
        void Promise.all(payloads.filter((payload): payload is Extract<InsertAssetPayload, { kind: "image" }> => payload.kind === "image").map(async (payload) => {
            const stored = await uploadImage(payload.dataUrl);
            return createImageReferenceItem({ id: createClientId(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey, imageName: payload.imageName, imageVersion: payload.imageVersion }, "asset");
        })).then((items) => saveReferences(dedupeImageReferences([...imageReferences, ...items])));
        setAssetPickerOpen(false);
    };

    const addUploads = async (files: FileList | null) => {
        if (!files) return;
        const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
        if (uploadInputRef.current) uploadInputRef.current.value = "";
        try {
            images.forEach(assertCanvasImageUploadSize);
            const items = await Promise.all(images.map(async (file) => {
                const stored = await uploadImage(file);
                return createImageReferenceItem({ id: createClientId(), name: file.name, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }, "upload");
            }));
            saveReferences(dedupeImageReferences([...imageReferences, ...items]));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("参考图上传失败"));
        }
    };

    if (sharedConfig) {
        const sharedPrompt = sharedConfig.metadata?.composerContent || sharedConfig.metadata?.prompt || "";
        const model = models.find(item => item.modelId === config.model || item.id === config.model);
        const modeLabel = { image: "图片", text: "文本", video: "视频", audio: "音频" }[mode];
        return <div className="rounded-xl border p-3 text-sm backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }} onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
            {mode === "image" && imageInput?.usesSnapshot ? <CanvasGenerationRecordDetails key={node.id} node={node} draftPrompt={sourcePrompt} disabled={isRunning} onRestoreGeneration={onRestoreGeneration ? () => onRestoreGeneration(node.id) : undefined} /> : null}
            <div className="font-medium">{t("继承配置：")}{sharedConfig.title || t("公共配置")}</div>
            <div className="mt-1 text-xs" style={{ color: theme.node.muted }}>{modeLabel} · {mode === "text" ? t("统一文本模型") : model?.publicName || model?.name || t("使用公共配置模型")}</div>
            <div className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-xs leading-5" style={{ background: theme.node.fill, borderColor: theme.node.stroke }} aria-label={t("公共提示词预览")}>{sharedPrompt || t("未填写公共提示词，将使用任务输入")}</div>
            <p className="my-2 text-xs leading-5" style={{ color: theme.node.muted }}>{t("每个目标使用自身输入与公共素材独立执行，原节点保留。参数由公共配置统一管理。")}</p>
            <div className="flex items-center justify-between gap-2">
                <Button size="small" disabled={!onOpenSharedConfig} onClick={() => onOpenSharedConfig?.(sharedConfig.id)}>{t("编辑公共配置")}</Button>
                <Button type="primary" danger={isRunning} aria-label={isRunning ? t("停止") : t("仅执行此任务")} onClick={() => isRunning ? onStop(node.id) : onGenerate(node.id, mode, sharedPrompt)}>{isRunning ? t("停止") : t("仅执行此任务")}</Button>
            </div>
        </div>;
    }

    return (
        <div
            className="rounded-xl border p-3 shadow-[0_16px_38px_rgba(15,23,42,.10)] backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            {mode === "image" && imageInput?.usesSnapshot ? <CanvasGenerationRecordDetails key={node.id} node={node} draftPrompt={prompt} disabled={isRunning} onRestorePrompt={() => updatePrompt(node.metadata?.generationRecord?.inputPrompt ?? node.metadata?.prompt ?? "")} onRestoreGeneration={onRestoreGeneration ? () => onRestoreGeneration(node.id) : undefined} /> : null}
            {requiresPrompt ? <CanvasResourceMentionTextarea
                value={prompt}
                references={promptReferences}
                onChange={updatePrompt}
                onSubmit={submit}
                className="thin-scrollbar h-24 w-full resize-none rounded-lg border px-3 py-2 text-sm leading-5 outline-none"
                style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }}
                placeholder={t(promptPlaceholder(mode, hasImageContent, hasTextContent))}
            /> : <p role="status" className="text-xs leading-5">{t("多图融合需要 2–4 张参考图，不使用提示词。原有描述会保留。")}</p>}

            {mode === "image" ? <div className="mt-2">{imageInput?.usesSnapshot ? <section aria-label={t("已选参考图")} className="min-w-0 space-y-2 text-xs">
                {imageInput.visibleReferences.length ? <span className="font-medium">{t("参考图")}</span> : null}
                <div className="flex gap-2 overflow-x-auto">{imageInput.visibleReferences.map(({ reference, index }) => <div key={reference.referenceKey} className="w-20 shrink-0 space-y-1" title={reference.name}>
                    <CanvasPersistedMediaPreview kind="image" url={reference.dataUrl} storageKey={reference.storageKey} alt={reference.name} className="size-20 rounded border object-cover" />
                    <span className="block truncate">{t("图片{count}", { count: index + 1 })}</span>
                </div>)}</div>
                {!referenceValidation.valid && referenceValidation.message ? <p role="alert" className="text-destructive">{referenceValidation.message}</p> : null}
            </section> : <ReferenceImageTray references={imageReferences} fixedReferenceKey={fixedReferenceKey} validation={referenceValidation} onChange={saveReferences} onRequestUpload={() => uploadInputRef.current?.click()} onRequestAssets={() => setAssetPickerOpen(true)} onRequestCanvas={() => setCanvasPickerOpen(true)} />}</div> : null}
            {videoValidation ? <p role="alert" className="mt-2 text-xs text-destructive">{videoValidation}{t("。已连接素材会保留。")}</p> : null}

            <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    {requiresPrompt ? <CanvasPromptLibrary onSelect={updatePrompt} /> : null}
                    {mode === "image" ? (
                        <>
                            <ModelPicker toolKey={toolKey} config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="image" onMissingConfig={() => openConfigDialog(true)} />
                            <CanvasImageSettingsPopover
                                config={config}
                                referenceCount={imageReferences.length}
                                placement="topLeft"
                                buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                                onMissingConfig={() => openConfigDialog(true)}
                                onOpenChange={onImageSettingsOpenChange}
                            />
                        </>
                    ) : mode === "video" ? (
                        <>
                            <ModelPicker toolKey={toolKey} config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="video" onMissingConfig={() => openConfigDialog(true)} />
                            <CanvasVideoSettingsPopover config={config} referenceCount={videoContext?.imageCount} imageMode={videoContext ? resolveVideoMode(videoConfig, videoContext.imageCount, videoContext.videoCount, videoContext.audioCount) : undefined} buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))} />
                        </>
                    ) : mode === "audio" ? (
                        <>
                            <ModelPicker toolKey={toolKey} config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="audio" onMissingConfig={() => openConfigDialog(true)} />
                            <CanvasAudioSettingsPopover config={config} buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                        </>
                    ) : null}
                </div>
                <Button
                    type="primary"
                    className="!h-10 !min-w-16 shrink-0 !rounded-full !px-3"
                    danger={isRunning}
                    style={isRunning ? undefined : { background: theme.toolbar.primary, borderColor: theme.toolbar.primary }}
                    disabled={!isRunning && (!toolEnabled || (mode === "text" && !config.textModel) || (requiresPrompt && !prompt.trim()) || !referenceValidation.valid || Boolean(videoValidation) || imageInput?.incompleteReferences)}
                    onClick={() => (isRunning ? onStop(node.id) : submit())}
                    aria-label={isRunning ? t("停止生成") : t("生成")}
                >
                    <span className="flex items-center gap-1.5">
                        {isRunning ? (
                            <>
                                <LoaderCircle className="size-4 animate-spin" />
                                <Square className="size-3.5 fill-current" />
                                <span className="text-xs font-medium">{t("停止")}</span>
                            </>
                        ) : (
                            <>
                                {deploymentFeatures.creditsEnabled ? <span className="inline-flex items-center gap-1 text-xs font-medium tabular-nums">
                                    <CreditSymbol />
                                    {credits.toLocaleString()}
                                </span> : null}
                                <ArrowUp className="size-4" />
                            </>
                        )}
                    </span>
                </Button>
            </div>
            <CanvasImageReferenceDialog open={canvasPickerOpen} nodes={canvasNodes.filter((candidate) => candidate.id !== node.id)} selectedReferenceKeys={imageReferences.map((reference) => reference.referenceKey)} onConfirm={addCanvasNodes} onClose={() => setCanvasPickerOpen(false)} />
            {assetPickerOpen ? (
                <Suspense fallback={null}>
                    <AssetPickerModal open selectionMode="multiple-images" onInsertMany={addAssets} onClose={() => setAssetPickerOpen(false)} />
                </Suspense>
            ) : null}
            <input ref={uploadInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => void addUploads(event.target.files)} />
        </div>
    );
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function operationTypeForMode(mode: CanvasNodeGenerationMode, editingImage: boolean) {
    if (mode === "video") return "video_generation";
    if (mode === "audio") return "audio_generation";
    if (mode === "image") return editingImage ? "inpaint" : "image_generation";
    return "chat";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
    const defaultModel = mode === "image" ? globalConfig.imageModel : mode === "video" ? globalConfig.videoModel : mode === "audio" ? globalConfig.audioModel : globalConfig.textModel;
    return {
        ...globalConfig,
        model: mode === "text" ? globalConfig.textModel : node.metadata?.model || defaultModel || (mode === "audio" ? defaultConfig.audioModel : globalConfig.model || defaultConfig.model),
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

function promptPlaceholder(mode: CanvasNodeGenerationMode, hasImageContent: boolean, hasTextContent: boolean) {
    if (mode === "video") return "描述要生成的视频内容";
    if (mode === "audio") return "描述要生成的音频内容";
    if (mode === "image") return hasImageContent ? "请输入你想要把这张图修改成什么" : "描述要生成的图片内容";
    return hasTextContent ? "请输入你想要将本段文本修改成什么" : "请输入你想要生成的文本内容";
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
