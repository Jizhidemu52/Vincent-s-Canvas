import { memo, useEffect, useId, useState } from "react";
import { ChevronDown, ImageIcon, Info, LoaderCircle, Paperclip, X } from "lucide-react";
import { ImageSettingsPanel, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { CanvasQuickReferenceTray } from "@/components/canvas/canvas-quick-reference-tray";
import { ModelPicker } from "@/components/model-picker";
import { canvasThemes } from "@/lib/canvas-theme";
import { deploymentFeatures } from "@/lib/deployment-features";
import { canvasQuickGeneratePanelPropsEqual, type CanvasQuickGeneratePanelRenderState } from "@/lib/canvas/canvas-quick-generate-render-stability";
import { validateImageReferences } from "@/lib/image-reference-policy";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { resolveCapabilityModel } from "@/lib/model-picker-options";
import { imageModelProfile, normalizeImageModelSettings } from "@/lib/image-model-settings";
import type { ReferenceImage } from "@/types/image";

type CanvasQuickGeneratePanelProps = Omit<CanvasQuickGeneratePanelRenderState, "embedded" | "config" | "references"> & {
    embedded?: boolean;
    config: AiConfig;
    references: ReferenceImage[];
};

export const CanvasQuickGeneratePanel = memo(function CanvasQuickGeneratePanel({
    embedded = false, open, prompt, model, size, quality, count, references, running,
    estimateCredits, estimateRmb, remainingCredits, config, onClose, onPromptChange,
    onModelChange, onSizeChange, onQualityChange, onCountChange, onPickReferences, onRemoveReference,
    onClearReferences, onMoveReference, onMissingConfig, onGenerate, positioned, onClearPosition,
}: CanvasQuickGeneratePanelProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [settingsExpanded, setSettingsExpanded] = useState(false);
    const settingsId = useId();
    const models = useBusinessConfigStore((state) => state.models);
    const modelStatus = useBusinessConfigStore((state) => state.status);
    const availableModel = modelStatus === "ready" ? resolveCapabilityModel(config, "image", models, model) : "";
    useEffect(() => {
        if (!running && modelStatus === "ready" && model !== availableModel) onModelChange(availableModel);
    }, [availableModel, model, modelStatus, onModelChange, running]);
    const profile = imageModelProfile(availableModel || model, models);
    const settings = normalizeImageModelSettings({ size, quality, count: String(count) }, profile);
    const sizeSummary = settings.size.includes("x") ? settings.size.replace("x", " × ") : imageSizeLabel(settings.size);
    const settingsSummary = `${profile.verified ? `${sizeSummary} · ${profile.qualityLabel}${imageQualityLabel(settings.quality)}` : "渠道默认参数"} · ${settings.count}${profile.maxCount > 1 ? " 张" : " 个任务"}`;
    useEffect(() => {
        if (running || !availableModel) return;
        if (size !== settings.size) onSizeChange(settings.size);
        if (quality !== settings.quality) onQualityChange(settings.quality);
        if (count !== Number(settings.count)) onCountChange(Number(settings.count));
    }, [availableModel, running, size, quality, count, settings.size, settings.quality, settings.count, onSizeChange, onQualityChange, onCountChange]);
    if (!open) return null;
    const referenceValidation = validateImageReferences(modelOptionName(model), references);
    const disabled = running || !availableModel || model !== availableModel || (profile.requiresPrompt && !prompt.trim()) || !referenceValidation.valid;
    return (
        <div data-testid="canvas-quick-generate-panel" data-canvas-no-zoom
            className={embedded ? "cw-generator" : "cw-generator cw-generator-mobile cw-surface max-h-[calc(100dvh-144px)] overflow-y-auto"}
            style={{ color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}>
            {!embedded ? <div className="cw-tabs"><span>创建</span><button className="cw-icon" style={{ marginLeft: "auto" }} aria-label="关闭画布生图" onClick={onClose}><X size={16} /></button></div> : null}
            <div className="cw-generator-body">
                {positioned ? <div className="mb-3 flex items-center justify-between gap-2 text-xs" style={{ color: theme.node.muted }}><span>下一次生成放在右键位置</span><button type="button" className="shrink-0 hover:underline" onClick={onClearPosition}>取消定位</button></div> : null}
                <div className="cw-media-kind"><ImageIcon size={15} /><span>{references.length ? "编辑图像" : "图像"}</span>{profile.documentationUrl ? <a className="cw-model-info" href={profile.documentationUrl} target="_blank" rel="noreferrer" title={`${profile.tip} 点击查看接口文档`} aria-label="查看当前模型接口文档"><Info size={14} /></a> : <span className="cw-model-info" title={profile.tip}><Info size={14} /></span>}</div>
                <div className="cw-model-row">
                <ModelPicker config={config} value={availableModel} capability="image" modelsSource="server" disabled={running} fullWidth onChange={onModelChange}
                    onMissingConfig={onMissingConfig} className="cw-model-picker" />
                <button type="button" className="cw-reference-button" title="添加参考图" aria-label="添加参考图" disabled={running || references.length >= referenceValidation.maximum} onClick={onPickReferences}><Paperclip size={17} /></button>
                </div>
                <textarea className="cw-prompt" aria-label="描述图像" placeholder={!profile.requiresPrompt ? "添加 2–4 张参考图，直接生成合成图，无需描述。" : references.length ? "描述想如何修改，可用「图1」「图2」指定参考图…" : "描述你想创作的图像…"}
                    value={prompt} maxLength={2000} disabled={running || !profile.requiresPrompt}
                    onChange={(event) => onPromptChange(event.target.value)}
                    onKeyDown={(event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !disabled) {
                            event.preventDefault(); onGenerate();
                        }
                    }} />
                <CanvasQuickReferenceTray references={references} disabled={running} onMove={onMoveReference} onRemove={onRemoveReference} onClear={onClearReferences} />
                <details className="cw-selection-hint">
                    <summary className="cursor-pointer py-1"><span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Info size={12} aria-hidden /><span>{references.length ? "参考图说明" : "点击或框选画布图片添加参考图"}</span></span></summary>
                    <p className="pt-1">按上方顺序编辑参考图，原图保留。取消选中不会清空参考图；请用移除或清空按钮调整。</p>
                </details>
                {!referenceValidation.valid ? <p className="cw-reference-error" role="alert">{referenceValidation.message}</p> : null}
            </div>
            <div className="cw-generator-footer">
                    <button type="button" id={`${settingsId}-toggle`} aria-expanded={settingsExpanded} aria-controls={settingsId}
                        className="flex w-full cursor-pointer items-center justify-between gap-2 rounded py-2 text-left text-xs hover:bg-[var(--cw-soft)]"
                        onClick={() => setSettingsExpanded(value => !value)}>
                        <span className="min-w-0"><span className="block">生成设置</span><span className="mt-1 block break-words text-[11px]" style={{ color: theme.node.muted }}>{settingsSummary}</span></span>
                        <ChevronDown size={14} aria-hidden className={`shrink-0 ${settingsExpanded ? "rotate-180" : ""}`} />
                    </button>
                    <fieldset id={settingsId} hidden={!settingsExpanded} aria-labelledby={`${settingsId}-toggle`} disabled={running || !availableModel} className="max-h-[min(36dvh,320px)] min-w-0 overflow-y-auto border-0 p-0">
                        <ImageSettingsPanel config={{ ...config, model, imageModel: model, ...settings }} theme={theme} showTitle={false} onConfigChange={(key, value) => {
                            if (key === "size") onSizeChange(value);
                            if (key === "quality") onQualityChange(value);
                            if (key === "count") onCountChange(Number(value));
                        }} />
                    </fieldset>
                <div className={`cw-generate-action ${disabled ? "is-disabled" : ""}`}>
                    <button type="button" className="cw-generate-button" disabled={disabled} onClick={onGenerate}>
                        {running ? <><LoaderCircle size={16} className="animate-spin" />提交中…</> : references.length ? "生成修改图" : "生成"}
                    </button>
                    {deploymentFeatures.creditsEnabled ? <span className="cw-estimate" title={`预计 ¥${estimateRmb.toFixed(2)}，剩余 ${remainingCredits ?? "-"} 积分`}>{estimateCredits} 积分</span> : <span className="cw-shortcut" aria-hidden>Ctrl ↵</span>}
                </div>
            </div>
        </div>
    );
}, (previous, next) => canvasQuickGeneratePanelPropsEqual({ ...previous, embedded: Boolean(previous.embedded) }, { ...next, embedded: Boolean(next.embedded) }));
