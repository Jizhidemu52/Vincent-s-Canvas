import { useUiText } from "@/lib/i18n";
import { PromptOptimizeButton } from "@/components/prompt-optimize-button";
import { memo, useEffect, useState } from "react";
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

type CanvasQuickGeneratePanelProps = Omit<CanvasQuickGeneratePanelRenderState, "embedded" | "config" | "references"> & {
    embedded?: boolean;
    config: AiConfig;
    references: ReferenceImage[];
};

export const CanvasQuickGeneratePanel = memo(function CanvasQuickGeneratePanel({
    embedded = false, open, promptRef, promptRevision, model, size, quality, count, imageOptions, references, running,
    estimateCredits, estimateRmb, remainingCredits, config, onClose,
    onModelChange, onSizeChange, onQualityChange, onCountChange, onImageOptionsChange, onPickReferences, onRemoveReference,
    onClearReferences, onMoveReference, onMissingConfig, onGenerate, onOptimizedPrompt, positioned, onClearPosition,
    referenceScopeKey = "", referencesLoading = false, onAddReferenceFiles,
}: CanvasQuickGeneratePanelProps) {
    const t = useUiText();
    const [optimizing, setOptimizing] = useState(false);
    const [prompt, setPrompt] = useState(promptRef.current);
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
    useEffect(() => {
        if (!running && modelStatus === "ready" && model !== availableModel) onModelChange(availableModel);
    }, [availableModel, model, modelStatus, onModelChange, running]);
    const profile = imageModelProfile(availableModel || model, models, role);
    const settings = normalizeImageModelSettings({ size, quality, count: String(count) }, profile);
    const activeQuality = settings.quality;
    const imageDrop = useImageDrop({ scopeKey: referenceScopeKey, disabled: !open || running || referencesLoading || !onAddReferenceFiles, onFiles: files => onAddReferenceFiles?.(files) });
    const referenceBusy = referencesLoading || imageDrop.reading;
    useEffect(() => {
        if (running || !availableModel) return;
        if (size !== settings.size) onSizeChange(settings.size);
        if (quality !== activeQuality) onQualityChange(activeQuality);
        if (count !== Number(settings.count)) onCountChange(Number(settings.count));
    }, [availableModel, running, size, quality, count, settings.size, activeQuality, settings.count, onSizeChange, onQualityChange, onCountChange]);
    if (!open) return null;
    const referenceValidation = validateImageReferences(modelOptionName(availableModel || model), references, profile);
    const disabled = !toolEnabled || optimizing || running || referenceBusy || !availableModel || model !== availableModel || (profile.requiresPrompt && !prompt.trim()) || !referenceValidation.valid || Boolean(imageModelSettingsError(settings.size, profile));
    return (
        <div {...imageDrop.dropProps} data-testid="canvas-quick-generate-panel" data-canvas-no-zoom
            className={embedded ? "cw-generator" : "cw-generator cw-generator-mobile cw-surface max-h-[calc(100dvh-144px)] overflow-y-auto"}
            style={{ color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}>
            {!embedded ? <div className="cw-tabs"><span>{t("创建")}</span><button className="cw-icon" style={{ marginLeft: "auto" }} aria-label={t("关闭画布生图")} onClick={onClose}><X size={16} /></button></div> : null}
            <div className="cw-generator-body">
                {positioned ? <div className="mb-3 flex items-center justify-between gap-2 text-xs" style={{ color: theme.node.muted }}><span>{t("下一次生成放在右键位置")}</span><button type="button" className="shrink-0 hover:underline" onClick={onClearPosition}>{t("取消定位")}</button></div> : null}
                <div className="cw-media-kind"><ImageIcon size={15} /><span>{!profile.requiresPrompt ? t("多图融合") : references.length ? t("编辑图像") : t("图像")}</span>{profile.documentationUrl ? <a className="cw-model-info" href={profile.documentationUrl} target="_blank" rel="noreferrer" title={t("{value1} 点击查看接口文档", { value1: profile.tip })} aria-label={t("查看当前模型接口文档")}><Info size={14} /></a> : <span className="cw-model-info" title={profile.tip}><Info size={14} /></span>}</div>
                <div className="cw-model-row">
                <ModelPicker toolKey={toolKey} config={boundConfig} value={availableModel} capability="image" modelsSource="server" disabled={running} fullWidth onChange={onModelChange}
                    onMissingConfig={onMissingConfig} className="cw-model-picker" />
                </div>
                {profile.requiresPrompt ? <textarea className="cw-prompt" data-canvas-image-paste aria-label={t("描述图像")} placeholder={references.length ? t("描述想如何修改，可用「图1」「图2」指定参考图…") : t("描述你想创作的图像…")}
                    value={prompt} maxLength={profile.kind === "grok-image" ? 8000 : 2000} disabled={running} title={t("Enter 生成，Shift+Enter 换行")}
                    onChange={(event) => { promptRef.current = event.target.value; setPrompt(event.target.value); }}
                    onKeyDown={(event) => {
                        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
                        event.preventDefault();
                        if (!disabled && !event.repeat) onGenerate();
                    }} /> : <p className="my-3 text-xs leading-5" role="status">{t("添加 2–4 张参考图，直接融合，不使用提示词。原有描述会保留，切换模型后可继续编辑。")}</p>}
                {profile.requiresPrompt ? <PromptOptimizeButton config={boundConfig} prompt={prompt} references={references} toolKey={toolKey} disabled={running} onBusyChange={setOptimizing} onApply={(value, _compilation, input) => { promptRef.current = value; setPrompt(value); onOptimizedPrompt?.(value, input, references); }} /> : null}
                {imageDrop.dragging || referenceBusy ? <p role="status" className="my-2 text-xs" style={{ color: theme.node.text }}>{t(referenceBusy ? "正在读取拖入图片，请稍候。" : "松开以添加参考图，不会自动生成")}</p> : null}
                <div className="cw-reference-row">
                    <button type="button" className="cw-add-reference" aria-label={t("添加参考图")} disabled={running || referenceBusy || references.length >= referenceValidation.maximum} onClick={onPickReferences}><Plus size={15} aria-hidden /><span>{t("添加参考图")}</span></button>
                    <Popover.Root>
                        <Popover.Trigger asChild><button type="button" className="cw-reference-hint-button" aria-label={t("参考图说明")} title={t("参考图说明")}><Info size={13} aria-hidden /></button></Popover.Trigger>
                        <Popover.Portal><Popover.Content className="cw-reference-hint-popover" aria-label={t("参考图说明")} side="bottom" align="end" sideOffset={6} collisionPadding={12}
                            style={{ background: theme.node.panel, color: theme.node.text, borderColor: theme.node.stroke }} data-canvas-no-zoom
                            onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
                            <p>{t("可拖入桌面或企业微信原图，也可点击或框选画布图片添加参考图。")}</p>
                            <p>{t("按上方顺序编辑参考图，原图保留。取消选中不会清空参考图；请用移除或清空按钮调整。")}</p>
                        </Popover.Content></Popover.Portal>
                    </Popover.Root>
                </div>
                <CanvasQuickReferenceTray references={references} disabled={running || referenceBusy} onMove={onMoveReference} onRemove={onRemoveReference} onClear={onClearReferences} />
                {!referenceValidation.valid ? <p className="cw-reference-error" role="alert">{referenceValidation.message}</p> : null}
            </div>
            <div className="cw-generator-footer">
                        <CanvasQuickSettingsPopovers config={{ ...config, model: availableModel || model, imageModel: availableModel || model, ...settings, quality: activeQuality, imageOptions }} profile={profile} referenceCount={references.length} theme={theme} disabled={running || !availableModel} onConfigChange={(key, value) => {
                            if (key === "size") onSizeChange(value);
                            if (key === "quality") onQualityChange(value);
                            if (key === "count") onCountChange(Number(value));
                            if (key === "imageOptions") onImageOptionsChange(value);
                        }} />
                <div className={`cw-generate-action ${disabled ? "is-disabled" : ""}`}>
                    <button type="button" className="cw-generate-button" disabled={disabled} onClick={onGenerate} title={profile.requiresPrompt ? t("Enter 生成，Shift+Enter 换行") : undefined}>
                        {running ? <><LoaderCircle size={16} className="animate-spin" />{t("提交中…")}</> : !profile.requiresPrompt ? t("开始融合") : references.length ? t("生成修改图") : t("生成")}
                        <span className="cw-generate-count" aria-label={t("每次生成 1 张")}>×1</span>
                    </button>
                    {deploymentFeatures.creditsEnabled ? <span className="cw-estimate" title={t("预计 ¥{value1}，剩余 {value2} 积分", { value1: estimateRmb.toFixed(2), value2: remainingCredits ?? "-" })}>{estimateCredits} {t(" 积分")}</span> : null}
                </div>
            </div>
        </div>
    );
}, (previous, next) => canvasQuickGeneratePanelPropsEqual({ ...previous, embedded: Boolean(previous.embedded) }, { ...next, embedded: Boolean(next.embedded) }));
