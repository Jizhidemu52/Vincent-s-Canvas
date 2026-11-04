import { useUiText } from "@/lib/i18n";
import { PromptOptimizeButton } from "@/components/prompt-optimize-button";
import { memo, useEffect, useMemo, useState } from "react";
import { ImageIcon, Info, LoaderCircle, Plus, X } from "lucide-react";
import { Popover } from "radix-ui";
import { CanvasQuickReferenceTray } from "@/components/canvas/canvas-quick-reference-tray";
import { CanvasQuickSettingsPopovers } from "@/components/canvas/canvas-quick-settings-popovers";
import { ModelPicker } from "@/components/model-picker";
import { canvasThemes } from "@/lib/canvas-theme";
import { deploymentFeatures } from "@/lib/deployment-features";
import { canvasQuickGeneratePanelPropsEqual, type CanvasQuickGeneratePanelRenderState } from "@/lib/canvas/canvas-quick-generate-render-stability";
import { validateImageReferences } from "@/lib/image-reference-policy";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { resolveCapabilityModel } from "@/lib/model-picker-options";
import { imageModelProfile, imageModelSettingsError, normalizeImageModelSettings } from "@/lib/image-model-settings";
import type { ReferenceImage } from "@/types/image";
import { canvasToolKey, useToolConfig, useToolEnabled } from "@/hooks/use-tool-config";
import { useImageDrop } from "@/hooks/use-image-drop";
import { CanvasGenerationRecordDetails } from "./canvas-generation-record-details";
import { useImageMentions } from "@/hooks/use-image-mentions";
import { quickMentionImages, quickMentionReferenceIndex } from "@/lib/canvas/canvas-quick-reference-mentions";

type CanvasQuickGeneratePanelProps = Omit<CanvasQuickGeneratePanelRenderState, "embedded" | "config" | "references"> & {
    embedded?: boolean;
    config: AiConfig;
    references: ReferenceImage[];
};

export const CanvasQuickGeneratePanel = memo(function CanvasQuickGeneratePanel({
    embedded = false, open, promptRef, promptRevision, model, size, quality, count, imageOptions, references, running,
    estimateCredits, estimateRmb, remainingCredits, config, onClose,
    onModelChange, onSizeChange, onQualityChange, onCountChange, onImageOptionsChange, onSettingsNormalize, onPickReferences, onRemoveReference,
    onClearReferences, onMoveReference, onMissingConfig, onGenerate, onOptimizedPrompt, positioned, onClearPosition,
    referenceScopeKey = "", referencesLoading = false, onAddReferenceFiles,
    sourceNode, derivatives, mentionImages, onAddMentionReference, onPromptChange, onRestorePrompt, onContinue, onRegenerate, onRestoreGeneration, onLocateDerivative,
}: CanvasQuickGeneratePanelProps) {
    const t = useUiText();
    const [optimizing, setOptimizing] = useState(false);
    const [prompt, setPrompt] = useState(promptRef.current);
    const [mentionError, setMentionError] = useState("");
    useEffect(() => setPrompt(promptRef.current), [promptRef, promptRevision]);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const models = useBusinessConfigStore((state) => state.models);
    const modelStatus = useBusinessConfigStore((state) => state.status);
    const role = useUserStore((state) => state.user?.role);
    const selectedModel = modelStatus === "ready" ? resolveCapabilityModel(config, "image", models, model) : "";
    const toolKey = canvasToolKey("image", references.length > 0, imageModelProfile(selectedModel || model, models, role).kind);
    const boundConfig = useToolConfig({ ...config, model: selectedModel }, toolKey);
    const availableModel = boundConfig.model;
    const toolEnabled = useToolEnabled(toolKey);
    const hasDraftInput = Boolean(prompt.trim() || references.length || sourceNode);
    useEffect(() => {
        if (!running && !hasDraftInput && modelStatus === "ready" && availableModel && model !== availableModel) onSettingsNormalize?.({ model: availableModel });
    }, [availableModel, hasDraftInput, model, modelStatus, onSettingsNormalize, running]);
    const profile = imageModelProfile(model || availableModel, models, role);
    const settings = normalizeImageModelSettings({ size, quality, count: String(count) }, profile);
    const activeQuality = settings.quality;
    const imageDrop = useImageDrop({ scopeKey: referenceScopeKey, disabled: !open || running || referencesLoading || !onAddReferenceFiles, onFiles: files => onAddReferenceFiles?.(files) });
    const referenceBusy = referencesLoading || imageDrop.reading;
    const referenceValidation = validateImageReferences(modelOptionName(availableModel || model), references, profile);
    const updatePrompt = (value: string) => { promptRef.current = value; setPrompt(value); onPromptChange?.(value); };
    const candidates = useMemo(() => quickMentionImages(references, mentionImages), [references, mentionImages]);
    useEffect(() => setMentionError(""), [referenceScopeKey, references, model]);
    const mentions = useImageMentions({ value: prompt, onChange: updatePrompt, images: candidates, disabled: !open || running || referenceBusy, onSelect: async image => {
        const existing = quickMentionReferenceIndex(references, image);
        if (existing >= 0) return `图${existing + 1}`;
        if (!referenceValidation.supportsReferences || references.length >= referenceValidation.maximum) {
            setMentionError(referenceValidation.supportsReferences ? t("已达到当前模型的 {count} 张参考图上限，请先移除一张。", { count: referenceValidation.maximum }) : t("当前模型不支持参考图，请先选择支持参考图的模型。"));
            return false;
        }
        if (!onAddMentionReference || !await onAddMentionReference(image)) { setMentionError(t("未添加这张图片，请检查图片是否仍可用。")); return false; }
        setMentionError("");
        return `图${references.length + 1}`;
    } });
    useEffect(() => {
        if (running || !availableModel || model !== availableModel) return;
        const normalized: Partial<Pick<CanvasQuickGeneratePanelProps, "size" | "quality" | "count">> = {};
        if (size !== settings.size) normalized.size = settings.size;
        if (quality !== activeQuality) normalized.quality = activeQuality;
        if (count !== Number(settings.count)) normalized.count = Number(settings.count);
        if (Object.keys(normalized).length) onSettingsNormalize?.(normalized);
    }, [availableModel, model, running, size, quality, count, settings.size, activeQuality, settings.count, onSettingsNormalize]);
    if (!open) return null;
    const disabled = !toolEnabled || optimizing || running || referenceBusy || !availableModel || model !== availableModel || (profile.requiresPrompt && !prompt.trim()) || !referenceValidation.valid || Boolean(imageModelSettingsError(settings.size, profile));
    const disabledReason = !toolEnabled ? t("当前图片功能已停用，请联系管理员。") : optimizing ? t("正在优化提示词，请稍候。") : running ? t("本次任务正在提交，请稍候。") : referenceBusy ? t("正在读取参考图，完成后即可生成。") : !availableModel ? t("暂未配置可用模型，请联系管理员。") : model !== availableModel ? t("原模型与当前功能绑定不匹配，已保留草稿和参数；请明确选择使用可用模型。") : profile.requiresPrompt && !prompt.trim() ? t("先填写提示词；输入 @ 可添加参考图。") : !referenceValidation.valid ? referenceValidation.message : imageModelSettingsError(settings.size, profile);
    return (
        <div {...imageDrop.dropProps} data-testid="canvas-quick-generate-panel" data-canvas-no-zoom
            className={embedded ? "cw-generator" : "cw-generator cw-generator-mobile cw-surface max-h-[calc(100dvh-144px)] overflow-y-auto"}
            style={{ color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}>
            {!embedded ? <div className="cw-tabs"><span>{t("创建")}</span><button className="cw-icon" style={{ marginLeft: "auto" }} aria-label={t("关闭画布生图")} onClick={onClose}><X size={16} /></button></div> : null}
            <div className="cw-generator-body">
                {sourceNode ? <CanvasGenerationRecordDetails key={sourceNode.id} node={sourceNode} draftPrompt={prompt} derivatives={derivatives} disabled={running || referenceBusy} onRestorePrompt={onRestorePrompt} onContinue={onContinue} onRegenerate={onRegenerate} onRestoreGeneration={onRestoreGeneration} onLocate={onLocateDerivative} /> : null}
                {positioned ? <div className="mb-3 flex items-center justify-between gap-2 text-xs" style={{ color: theme.node.muted }}><span>{t("下一次生成放在右键位置")}</span><button type="button" className="shrink-0 hover:underline" onClick={onClearPosition}>{t("取消定位")}</button></div> : null}
                <div className="cw-media-kind"><ImageIcon size={15} /><span>{!profile.requiresPrompt ? t("多图融合") : references.length ? t("编辑图像") : t("图像")}</span>{profile.documentationUrl ? <a className="cw-model-info" href={profile.documentationUrl} target="_blank" rel="noreferrer" title={t("{value1} 点击查看接口文档", { value1: profile.tip })} aria-label={t("查看当前模型接口文档")}><Info size={14} /></a> : <span className="cw-model-info" title={profile.tip}><Info size={14} /></span>}</div>
                <div className="cw-model-row">
                <ModelPicker toolKey={toolKey} config={boundConfig} value={availableModel} capability="image" modelsSource="server" disabled={running} fullWidth onChange={onModelChange}
                    onMissingConfig={onMissingConfig} className="cw-model-picker" />
                </div>
                {profile.requiresPrompt ? <div className="relative">{mentions.menu}<textarea {...mentions.inputProps} className="cw-prompt" data-canvas-image-paste aria-label={t("描述图像")} placeholder={references.length ? t("描述想如何修改，输入 @ 引用图片…") : t("描述你想创作的图像，输入 @ 引用图片…")}
                    value={prompt} maxLength={profile.kind === "grok-image" ? 8000 : 2000} disabled={running} title={t("Enter 生成，Shift+Enter 换行")}
                    onChange={mentions.handleChange} onSelect={mentions.handleSelect}
                    onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                        if (mentions.handleKeyDown(event)) return;
                        if (event.key !== "Enter" || event.shiftKey) return;
                        event.preventDefault();
                        if (!disabled && !event.repeat) onGenerate();
                    }} /></div> : <p className="my-3 text-xs leading-5" role="status">{t("添加 2–4 张参考图，直接融合，不使用提示词。原有描述会保留，切换模型后可继续编辑。")}</p>}
                {mentionError ? <p role="alert" className="my-2 text-xs" style={{ color: theme.node.danger }}>{mentionError}</p> : null}
                {profile.requiresPrompt ? <PromptOptimizeButton scopeKey={referenceScopeKey} config={boundConfig} prompt={prompt} references={references} operationType={toolKey === "canvas-image" ? "image_generation" : "inpaint"} toolKey={toolKey} disabled={running} onBusyChange={setOptimizing} onApply={(value, _compilation, input) => { promptRef.current = value; setPrompt(value); onPromptChange?.(value); onOptimizedPrompt?.(value, input, references); }} /> : null}
                {imageDrop.dragging || referenceBusy ? <p role="status" className="my-2 text-xs" style={{ color: theme.node.text }}>{t(referenceBusy ? "正在读取拖入图片，请稍候。" : "松开以添加参考图，不会自动生成")}</p> : null}
                <div className="cw-reference-row">
                    <button type="button" className="cw-add-reference" aria-label={t("添加参考图")} disabled={running || referenceBusy || references.length >= referenceValidation.maximum} onClick={onPickReferences}><Plus size={15} aria-hidden /><span>{t("添加参考图")}</span></button>
                    <Popover.Root>
                        <Popover.Trigger asChild><button type="button" className="cw-reference-hint-button" aria-label={t("参考图说明")} title={t("参考图说明")}><Info size={13} aria-hidden /></button></Popover.Trigger>
                        <Popover.Portal><Popover.Content className="cw-reference-hint-popover" aria-label={t("参考图说明")} side="bottom" align="end" sideOffset={6} collisionPadding={12}
                            style={{ background: theme.node.panel, color: theme.node.text, borderColor: theme.node.stroke }} data-canvas-no-zoom
                            onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
                            <p>{t("可拖入桌面或企业微信原图；框选可添加多张画布参考图。")}</p>
                            <p>{t("选中单图可查看其生成档案；要继续修改该图，请点击“基于此图继续”。")}</p>
                        </Popover.Content></Popover.Portal>
                    </Popover.Root>
                </div>
                <CanvasQuickReferenceTray references={references} disabled={running || referenceBusy} onMove={onMoveReference} onRemove={onRemoveReference} onClear={onClearReferences} />
                {!referenceValidation.valid ? <p className="cw-reference-error" role="alert">{referenceValidation.message}</p> : null}
            </div>
            <div className="cw-generator-footer">
                        <CanvasQuickSettingsPopovers config={{ ...config, model: model || availableModel, imageModel: model || availableModel, ...settings, quality: activeQuality, imageOptions }} profile={profile} referenceCount={references.length} theme={theme} disabled={running || !availableModel || model !== availableModel} onConfigChange={(key, value) => {
                            if (key === "size") onSizeChange(value);
                            if (key === "quality") onQualityChange(value);
                            if (key === "count") onCountChange(Number(value));
                            if (key === "imageOptions") onImageOptionsChange(value);
                        }} onConfigNormalize={(key, value) => { if (model === availableModel && !running) onSettingsNormalize?.(key === "count" ? { count: Number(value) } : { [key]: value }); }} />
                <div className={`cw-generate-action ${disabled ? "is-disabled" : ""}`}>
                    <button type="button" className="cw-generate-button" disabled={disabled} onClick={onGenerate} title={profile.requiresPrompt ? t("Enter 生成，Shift+Enter 换行") : undefined}>
                        {running ? <><LoaderCircle size={16} className="animate-spin" />{t("提交中…")}</> : !profile.requiresPrompt ? t("开始融合") : references.length ? t("生成修改图") : t("生成")}
                        <span className="cw-generate-count" aria-label={t("每次生成 1 张")}>×1</span>
                    </button>
                    {deploymentFeatures.creditsEnabled ? <span className="cw-estimate" title={t("预计 ¥{value1}，剩余 {value2} 积分", { value1: estimateRmb.toFixed(2), value2: remainingCredits ?? "-" })}>{estimateCredits} {t(" 积分")}</span> : null}
                </div>
                {disabledReason ? <p role="status" className="mt-2 text-xs" style={{ color: theme.node.muted }}>{disabledReason}</p> : null}
                {availableModel && model !== availableModel && hasDraftInput ? <button type="button" className="mt-1 text-xs underline" disabled={running || referenceBusy} onClick={() => onModelChange(availableModel)}>{t("使用当前可用模型")}</button> : null}
            </div>
        </div>
    );
}, (previous, next) => canvasQuickGeneratePanelPropsEqual({ ...previous, embedded: Boolean(previous.embedded) }, { ...next, embedded: Boolean(next.embedded) }));
