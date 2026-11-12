import { uiText, useUiLocale } from "@/lib/i18n";
import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ConfigProvider, Select, Tooltip } from "antd";
import { ChevronDown, CircleHelp, Ratio, Layers2, SlidersHorizontal } from "lucide-react";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { AiConfig } from "@/stores/use-config-store";
import { automaticReferenceSizeNotice, gifSizeNotice, imageModelSettingsError, imageOutputIsGif, imageReferenceSizeIsAutomatic, normalizeImageModelSettings, useImageModelProfile } from "@/lib/image-model-settings";
import { imageMarkupReference, imageOptionFields, normalizeImageOptions, readImageOptions } from "@/lib/image-advanced-settings";
import { uploadImage } from "@/services/image-storage";
import "./image-settings-panel.css";

type ImageSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "quality" | "size" | "count" | "imageOptions", value: string) => void;
    onConfigNormalize?: (key: "quality" | "size" | "count" | "imageOptions", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    maxCount?: number;
    profile?: ReturnType<typeof useImageModelProfile>;
    referenceCount?: number;
    /** Stable draft/node identity plus reference identities; invalidates pending markup reads on target changes. */
    uploadContextKey?: string;
    /** Canvas side popover: base controls live in the compact parameter row. */
    compact?: boolean;
    /** Wide canvas dialog: readable cards while preserving the legacy compact layout. */
    spacious?: boolean;
    /** Image workspace dialog: common controls grouped, advanced settings collapsed. */
    dialog?: boolean;
};

/** Read-only projection of the same adapter capabilities used by the full settings panel. */
export function imagePrimaryControls(config: AiConfig, profile: ReturnType<typeof useImageModelProfile>, referenceCount = 0) {
    const normalized = normalizeImageModelSettings(config, profile);
    const gif = imageOutputIsGif(config.imageOptions, profile);
    const sizes = gif ? ["auto", "512x512", "768x768"] : profile.sizes;
    const automatic = imageReferenceSizeIsAutomatic(profile, referenceCount);
    const independentResolution = profile.resolutions.length > 0 && !gif;
    const exactPixels = independentResolution && /^[1-9]\d*x[1-9]\d*$/.test(normalized.size);
    const options = readImageOptions(normalizeImageOptions(config.imageOptions, profile));
    return {
        size: normalized.size,
        sizes: sizes.includes(normalized.size) ? sizes : [...sizes, normalized.size],
        sizeDisabled: !profile.verified || automatic,
        automatic, exactPixels,
        detailKey: independentResolution ? "imageOptions" as const : "quality" as const,
        detailLabel: independentResolution ? "分辨率" : profile.qualityLabel,
        detailValue: independentResolution ? profile.resolutions.includes(options.resolution || "") ? options.resolution! : "1k" : normalized.quality,
        detailChoices: independentResolution ? profile.resolutions : profile.qualities,
        detailDisabled: !profile.verified || automatic || exactPixels || profile.kind === "grok-image" && referenceCount > 0 && !independentResolution,
    };
}

/** Main workspace controls; presentation never normalizes or overwrites a saved draft on mount. */
export function ImagePrimarySettings({ config, profile, referenceCount = 0, modelControl, onConfigChange }: {
    config: AiConfig; profile: ReturnType<typeof useImageModelProfile>; referenceCount?: number; modelControl: ReactNode;
    onConfigChange: ImageSettingsPanelProps["onConfigChange"];
}) {
    useUiLocale();
    const primary = imagePrimaryControls(config, profile, referenceCount);
    const noticeId = useId();
    const reason = primary.automatic ? automaticReferenceSizeNotice : primary.exactPixels
        ? uiText("当前精确像素 {size} 优先，分辨率档位暂不生效；改选上方宽高比或自适应后启用。图片质量仍独立生效。", { size: primary.size.replace("x", " × ") })
        : !profile.verified ? profile.tip : "";
    return <section className="image-primary-settings" aria-label={uiText("常用参数")}>
        <div className="image-primary-grid">
            <div className="image-primary-field image-primary-model"><span>{uiText("模型")}</span>{modelControl}</div>
            <div className="image-primary-field"><span>{uiText("比例")}</span><Select aria-label={uiText("宽高比")} data-usage-control="size" value={primary.automatic ? "__automatic" : primary.size} disabled={primary.sizeDisabled} aria-describedby={reason ? noticeId : undefined}
                options={primary.automatic ? [{ value: "__automatic", label: uiText("自动") }] : primary.sizes.map(value => ({ value, label: imageSizeLabel(value) }))}
                onChange={value => onConfigChange("size", value)} /></div>
            <div className="image-primary-field"><span>{uiText(primary.detailLabel)}</span><Select aria-label={uiText(primary.detailLabel)} data-usage-control={primary.detailKey === "imageOptions" || profile.qualityLabel.includes("分辨率") ? "resolution" : "quality"}
                value={primary.automatic ? "__automatic" : primary.detailValue} disabled={primary.detailDisabled} aria-describedby={reason ? noticeId : undefined}
                options={primary.automatic ? [{ value: "__automatic", label: uiText("自动") }] : primary.detailChoices.map(value => ({ value, label: imageQualityLabel(value) }))}
                onChange={value => onConfigChange(primary.detailKey, primary.detailKey === "imageOptions" ? JSON.stringify({ ...readImageOptions(normalizeImageOptions(config.imageOptions, profile)), resolution: value }) : value)} /></div>
        </div>
        {reason ? <p id={noticeId} role="status" className="mt-2 text-[13px] leading-5 text-muted-foreground">{uiText(reason)}</p> : null}
    </section>;
}

export function ImageSettingsPanel({ config, onConfigChange, onConfigNormalize = onConfigChange, theme, showTitle = true, className = "", maxCount: maximum, profile: suppliedProfile, referenceCount = 0, uploadContextKey = "", compact = false, spacious = false, dialog = false }: ImageSettingsPanelProps) {
    useUiLocale();
    const [snapToStep, setSnapToStep] = useState(false);
    const [sizeNotice, setSizeNotice] = useState("");
    const cachedProfile = useImageModelProfile(config.model || config.imageModel);
    const profile = suppliedProfile || cachedProfile;
    const markupContext = `${uploadContextKey}|${config.model || config.imageModel}|${referenceCount}`;
    const normalized = normalizeImageModelSettings(config, profile);
    const gif = imageOutputIsGif(config.imageOptions, profile);
    const sizeChoices = gif ? ["auto", "512x512", "768x768"] : profile.sizes;
    const maxCount = Math.min(maximum || profile.maxCount, profile.maxCount);
    const count = Math.min(maxCount, Number(normalized.count));
    const custom = !sizeChoices.includes(normalized.size);
    const dimensions = /^\d+x\d+$/.test(normalized.size) ? normalized.size.split("x").map(Number) : gif ? [512, 512] : [1024, 1024];
    const automaticReferenceSize = imageReferenceSizeIsAutomatic(profile, referenceCount);
    const snapStep = profile.kind === "mai-image" ? 32 : profile.sizeConstraints?.multiple || 16;
    const sizeError = automaticReferenceSize ? "" : imageModelSettingsError(normalized.size, profile, config.imageOptions);
    const fields = imageOptionFields(profile).filter(field => field.key !== "resolution" && !(profile.kind === "midjourney-blend" && field.key === "dimensions")
        && (gif || !["frame_count", "frame_duration_ms"].includes(field.key)) && !((gif || !uploadContextKey) && field.key === "markup_reference"))
        .map(field => gif && field.key === "background" ? { ...field, options: field.options?.filter(value => value !== "transparent") }
            : gif && field.key === "output_format" ? { ...field, tip: "保留渠道原始 GIF 动画，不转码为静态图片。" } : field);
    const referenceQualityDisabled = profile.kind === "grok-image" && referenceCount > 0;
    const normalizedOptions = normalizeImageOptions(config.imageOptions, profile);
    const options = readImageOptions(normalizedOptions);
    const resolution = profile.resolutions.includes(options.resolution || "") ? options.resolution! : "1k";
    // Preserve intentional pixel sizes (including saved values inherited from another model).
    // The provider gives exact pixels precedence, so do not imply its resolution tier is active.
    const exactPixelsOverrideResolution = !gif && profile.resolutions.length > 0 && /^[1-9]\d*x[1-9]\d*$/.test(normalized.size);
    const resolutionNoticeId = useId();
    const updateOption = (key: string, value: string) => {
        const next = { ...options, [key]: value };
        if (!value) delete next[key];
        if (key === "background" && value === "transparent" && options.output_format === "jpeg") next.output_format = "png";
        if (key === "output_format" && value === "jpeg" && options.background === "transparent") next.background = "opaque";
        if (key === "output_format" && value === "gif") {
            delete next.output_compression;
            delete next.markup_reference;
            if (next.background === "transparent") next.background = "opaque";
            if (imageModelSettingsError(config.size, profile, JSON.stringify(next))) onConfigChange("size", "auto");
        }
        if (key === "dimensions" && value) onConfigChange("size", ({ SQUARE: "1:1", PORTRAIT: "2:3", LANDSCAPE: "3:2" } as Record<string, string>)[value]!);
        onConfigChange("imageOptions", JSON.stringify(next));
    };
    useEffect(() => {
        for (const key of ["size", "quality", "count"] as const) {
            // Quality is inactive with Grok references. Preserve the text-only preference
            // without fighting parent normalizers; request serialization omits it.
            if (key === "quality" && referenceQualityDisabled) continue;
            const value = key === "count" ? String(count) : normalized[key];
            if (config[key] !== value) {
                if (key === "size" && config.size) setSizeNotice(`该模型不支持 ${config.size}，已改为最接近的 ${value}`);
                onConfigNormalize(key, value);
            }
        }
    }, [config.size, config.quality, config.count, normalized.size, normalized.quality, count, referenceQualityDisabled, onConfigNormalize]);
    useEffect(() => {
        if ((config.imageOptions || "{}") !== normalizedOptions) onConfigNormalize("imageOptions", normalizedOptions);
    }, [config.imageOptions, normalizedOptions, onConfigNormalize]);
    const commitDimension = (index: number, input: HTMLInputElement) => {
        const candidate = Math.round(Number(input.value));
        const value = Number.isSafeInteger(candidate) && candidate > 0 ? candidate : dimensions[index] || 1024;
        const next = [...dimensions];
        next[index] = snapToStep ? Math.ceil(value / snapStep) * snapStep : value;
        input.value = String(next[index]);
        onConfigChange("size", next.join("x"));
    };
    const commonControls = !compact && profile.verified && !automaticReferenceSize ? <><div className="ip-row">
                <span className="ip-label"><Ratio size={15} />{uiText("宽高比")}</span>
                <Select className="ip-select" data-usage-control="size" aria-label={uiText("宽高比")} value={normalized.size} onChange={value => onConfigChange("size", value)}
                    options={[...sizeChoices.map(value => ({ value, label: `${imageSizeLabel(value)}${value.includes("x") ? ` · ${value.replace("x", " × ")}` : ""}` })), ...(custom ? [{ value: normalized.size, label: `${uiText("自定义 ·")}${normalized.size.replace("x", " × ")}` }] : [])]} />
            </div>
            <div className="ip-basic-note text-[13px] leading-5" style={{ color: theme.node.muted }}><Tooltip title={<>{uiText("仅影响下次 AI 生成，不改变已有图片。")}{gif || dialog ? null : uiText(profile.tip)} {uiText("高画质、大尺寸可能增加生成时间。")}</>}><button type="button" className="inline-flex min-h-8 items-center gap-1" aria-label={uiText("图像参数说明")}><CircleHelp size={14} />{uiText("参数说明")}</button></Tooltip></div>
            {profile.resolutions.length && !gif ? <div className="ip-row">
                <span className="ip-label">{uiText("清晰度 / 分辨率")}</span>
                <Select className="ip-select" data-usage-control="resolution" aria-label={uiText("清晰度 / 分辨率")} disabled={exactPixelsOverrideResolution} aria-describedby={exactPixelsOverrideResolution ? resolutionNoticeId : undefined} value={resolution} onChange={value => updateOption("resolution", value)} options={profile.resolutions.map(value => ({ value, label: value.toUpperCase() }))} />
            </div> : null}
            {exactPixelsOverrideResolution ? <p id={resolutionNoticeId} role="status" className="text-xs leading-5" style={{ color: theme.node.muted }}>{uiText("当前精确像素 {size} 优先，分辨率档位暂不生效；改选上方宽高比或自适应后启用。图片质量仍独立生效。", { size: normalized.size.replace("x", " × ") })}</p> : null}
            {gif ? <p role="status" className="text-xs leading-5" style={{ color: theme.node.muted }}>{uiText(gifSizeNotice)}{uiText("仅支持文生图，不能添加参考图、蒙版或标注层。")}</p> : null}
            {profile.kind === "mai-image" ? null : referenceQualityDisabled ? <p role="status" className="text-xs leading-5" style={{ color: theme.node.muted }}>{uiText("参考图模式不提交 quality；移除全部参考图后可设置图片质量。")}</p> : <div className="ip-row">
                <span className="ip-label">{uiText(profile.qualityLabel)}</span>
                {profile.kind === "quality-resolution" || profile.kind === "resolution-1k" || profile.kind === "grok-image" ? <Select className="ip-select" data-usage-control={profile.kind === "resolution-1k" ? "resolution" : "quality"} aria-label={uiText(profile.qualityLabel)} value={normalized.quality} onChange={value => onConfigChange("quality", value)} options={profile.qualities.map(value => ({ value, label: imageQualityLabel(value) }))} /> : <div className="ip-segments" role="group" aria-label={uiText(profile.qualityLabel)}>
                    {profile.qualities.map(value => <button key={value} data-usage-control={profile.kind === "gemini" ? "resolution" : "quality"} data-usage-value={value} type="button" aria-pressed={normalized.quality === value} onClick={() => onConfigChange("quality", value)}>{imageQualityLabel(value)}</button>)}
                </div>}
            </div>}
            </> : !profile.verified ? <p className="py-2 text-xs leading-5 opacity-60">{uiText(profile.tip)}</p> : null;
    return (
        <div className={`image-parameters${spacious ? " ip-spacious" : ""}${dialog ? " ip-dialog" : ""} ${className}`} style={{ "--ip-text": theme.node.text, "--ip-muted": theme.node.muted, "--ip-border": theme.node.stroke, "--ip-soft": theme.node.fill, "--ip-panel": theme.toolbar.panel } as CSSProperties}
            onMouseDown={event => event.stopPropagation()}>
            {showTitle ? <div className="ip-title">{uiText("图像设置")}</div> : null}
            {sizeNotice ? <p role="status" className="mb-2 text-xs" style={{ color: theme.node.muted }}>{sizeNotice}</p> : null}
            {automaticReferenceSize ? <p role="status" className="mb-2 text-xs leading-5" style={{ color: theme.node.muted }}>{uiText(automaticReferenceSizeNotice)}</p> : null}
            {profile.kind === "mai-image" ? <p className="text-xs leading-5" style={{ color: theme.node.muted }}>{uiText("固定输出 PNG，不支持透明背景参数与蒙版。")}</p> : null}
            {profile.kind === "midjourney-blend" ? <>
                <div className="ip-row"><span className="ip-label">{uiText("比例预设")}</span><Select className="ip-select" aria-label={uiText("比例预设")} value={options.dimensions || "SQUARE"} onChange={value => updateOption("dimensions", value)} options={[{ value: "SQUARE", label: uiText("方形 1:1") }, { value: "PORTRAIT", label: uiText("竖向 2:3") }, { value: "LANDSCAPE", label: uiText("横向 3:2") }]} /></div>
                <p className="text-xs leading-5" style={{ color: theme.node.muted }}>{uiText("选择预设会同步宽高比；实际提交的 size 优先于 dimensions，可在下方改为自由比例。")}</p>
            </> : null}
            {dialog && commonControls ? <section className="ip-basics" aria-label={uiText("常用参数")}>
                <h3 className="ip-basics-title">{uiText("常用参数")}</h3>
                <div className="ip-basics-grid">{commonControls}</div>
            </section> : commonControls}
            {!automaticReferenceSize && profile.customSize && spacious ? <section className="ip-section ip-size-section" aria-labelledby={`${resolutionNoticeId}-size-title`}>
                <div className="ip-section-heading">
                    <span className="ip-section-icon"><Ratio size={19} aria-hidden /></span>
                    <div><h3 id={`${resolutionNoticeId}-size-title`}>{uiText("自定义像素")}</h3><p>{uiText("精确设置下一次生成图片的宽度和高度。")}</p></div>
                    <span className="ip-section-badge">PX</span>
                </div>
                {profile.sizeConstraintMessage ? <p className="ip-section-notice">{uiText(gif ? gifSizeNotice : profile.sizeConstraintMessage)}</p> : null}
                <div className="ip-size-grid">
                    {["宽度", "高度"].map((label, index) => <label key={`${label}-${dimensions[index]}`} className="ip-size-field">
                        <span>{uiText(label)}</span>
                        <span className="ip-dimension-input"><input aria-label={uiText("自定义{label}", { label: uiText(label) })} type="number" min={gif ? 16 : profile.sizeConstraints?.minEdge || 1} step={snapToStep ? snapStep : 1} defaultValue={dimensions[index]} onBlur={event => commitDimension(index, event.currentTarget)} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /><span aria-hidden>px</span></span>
                    </label>)}
                </div>
                <label className="ip-snap-control"><input type="checkbox" checked={snapToStep} onChange={event => setSnapToStep(event.target.checked)} /><span><strong>{uiText(profile.kind === "mai-image" ? "32 倍数对齐" : "16 倍数对齐")}</strong><span>{uiText(profile.kind === "mai-image" ? "调整尺寸时向上对齐到最近的 32 像素倍数。" : "调整尺寸时向上对齐到最近的 16 像素倍数。")}</span></span></label>
            </section> : !automaticReferenceSize && profile.customSize ? <details className="ip-details" open={compact || undefined}>
                <summary>{uiText("自定义像素")}<ChevronDown size={13} /></summary>
                {profile.sizeConstraintMessage ? <p className="text-xs leading-5" style={{ color: theme.node.muted }}>{uiText(gif ? gifSizeNotice : profile.sizeConstraintMessage)}</p> : null}
                <div className="ip-dimensions">
                    {["宽度", "高度"].map((label, index) => <label key={`${label}-${dimensions[index]}`}><span>{uiText(label)}</span><input aria-label={uiText("自定义{label}", { label: uiText(label) })} type="number" min={gif ? 16 : profile.sizeConstraints?.minEdge || 1} step={snapToStep ? snapStep : 1} defaultValue={dimensions[index]} onBlur={event => commitDimension(index, event.currentTarget)} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>)}
                </div>
                <label className="ip-align"><input type="checkbox" checked={snapToStep} onChange={event => setSnapToStep(event.target.checked)} />{uiText(profile.kind === "mai-image" ? "32 倍数对齐" : "16倍数对齐")}</label>
            </details> : null}
            {profile.customAspect && !automaticReferenceSize ? <label className="ip-row"><span className="ip-label">{uiText("自由比例")}</span><input key={normalized.size} aria-label={uiText("自定义宽高比")} defaultValue={normalized.size} placeholder={uiText("例如 7:5")} className="min-w-0 rounded border px-2 py-1.5" style={{ background: theme.node.fill, borderColor: theme.node.stroke }} onBlur={event => { if (/^[1-9]\d*:[1-9]\d*$/.test(event.currentTarget.value)) onConfigChange("size", event.currentTarget.value); else event.currentTarget.value = normalized.size; }} /></label> : null}
            {sizeError ? <p role="alert" className="text-xs text-destructive">{sizeError}</p> : null}
            {gif && referenceCount > 0 ? <p role="alert" className="text-xs text-destructive">{uiText("GIF 仅支持文生图，请先移除全部参考图。")}</p> : null}
            {fields.length && spacious ? <section className="ip-section ip-advanced-section" aria-labelledby={`${resolutionNoticeId}-advanced-title`}>
                <div className="ip-section-heading">
                    <span className="ip-section-icon"><SlidersHorizontal size={19} aria-hidden /></span>
                    <div><h3 id={`${resolutionNoticeId}-advanced-title`}>{uiText("全部高级参数")}</h3><p>{uiText("留空使用默认设置；只提交当前模型支持的字段。")}</p></div>
                    <span className="ip-section-badge">{fields.length} {uiText("项")}</span>
                </div>
                <div className="ip-options-grid">
                    {fields.map(field => {
                        const choices = field.options || (field.type === "boolean" ? ["true", "false"] : undefined);
                        const value = options[field.key] || "";
                        const disabled = field.key === "output_compression" && !["jpeg", "webp"].includes(options.output_format || "png");
                        const isLongText = field.type === "json" || ["negative_prompt", "extra"].includes(field.key);
                        const helpId = `${resolutionNoticeId}-${field.key}-help`;
                        const range = field.type === "number" ? field.max === undefined ? uiText("最小 {min}，步长 {step}", { min: field.min ?? "", step: field.step ?? 1 }) : uiText("范围 {min}–{max}{step}", { min: field.min ?? "", max: field.max, step: field.step !== undefined && field.step !== 1 ? uiText("，步长 {step}", { step: field.step }) : "" }) : "";
                        return <fieldset key={field.key} data-image-field={field.key} className={`ip-option-card${isLongText ? " ip-option-card-wide" : ""}${disabled ? " is-inactive" : ""}`}>
                            <legend>{uiText(field.label)}</legend>
                            {field.type === "image" ? <ImageMarkupInput key={`${markupContext}|${value}`} contextKey={markupContext} value={value} referenceCount={referenceCount} onChange={value => updateOption(field.key, value)} /> : choices && choices.length <= 4 ? <div className="ip-option-choices" role="radiogroup" aria-label={uiText(field.label)} aria-describedby={field.tip ? helpId : undefined}>
                                {["", ...choices].map(choice => <label className="ip-option-choice" key={choice || "default"}>
                                    <input type="radio" name={`${resolutionNoticeId}-${field.key}`} data-image-option={field.key} value={choice} checked={value === choice} onChange={event => { if (event.target.checked) updateOption(field.key, choice); }} />
                                    <span>{imageOptionLabel(choice)}</span>
                                </label>)}
                            </div> : choices ? <Select className="w-full" aria-label={uiText(field.label)} value={value} aria-describedby={field.tip ? helpId : undefined} onChange={value => updateOption(field.key, value)} options={["", ...choices].map(value => ({ value, label: imageOptionLabel(value) }))} /> : isLongText ? <textarea className="ip-option-input ip-option-textarea" aria-label={uiText(field.label)} aria-describedby={field.tip ? helpId : undefined} value={value} placeholder={field.type === "json" ? uiText("默认，或填写 JSON 对象，例如 {\"job\":\"cloth\"}") : uiText("留空使用默认设置")} rows={field.type === "json" ? 4 : 2} spellCheck={field.type === "json" ? false : undefined} onChange={event => updateOption(field.key, event.target.value)} /> : <input className="ip-option-input" aria-label={uiText(field.label)} aria-describedby={field.tip || range ? helpId : undefined} type={field.type === "number" ? "number" : "text"} min={field.min} max={field.max} step={field.step} value={value} placeholder={uiText("默认")} disabled={disabled} onChange={event => updateOption(field.key, event.target.value)} />}
                            {field.tip || range ? <p id={helpId} className="ip-option-help">{range ? <span className="ip-option-range">{range}</span> : null}{uiText(field.tip || "")}</p> : null}
                        </fieldset>;
                    })}
                </div>
            </section> : fields.length ? <details className="ip-details" open={compact || undefined}>
                <summary>{uiText(dialog ? "高级参数" : "全部高级参数")}<ChevronDown size={13} /></summary>
                <p className="text-xs leading-5" style={{ color: theme.node.muted }}>{uiText("留空使用默认设置；只提交当前模型支持的字段。")}</p>
                <div className={dialog ? "ip-dialog-options" : "flex flex-col gap-3 py-2"}>
                    {fields.map(field => <label key={field.key} data-image-field={field.key} className="flex flex-col gap-1 text-xs">
                        <span>{uiText(field.label)}</span>
                        {field.type === "image" ? <ImageMarkupInput key={`${markupContext}|${options[field.key] || ""}`} contextKey={markupContext} value={options[field.key] || ""} referenceCount={referenceCount} onChange={value => updateOption(field.key, value)} /> : field.options || field.type === "boolean" ? <Select aria-label={uiText(field.label)} value={options[field.key] || ""} className="w-full" onChange={value => updateOption(field.key, value)} options={["", ...(field.options || ["true", "false"])].map(value => ({ value, label: imageOptionLabel(value) }))} /> : <input aria-label={uiText(field.label)} type={field.type === "number" ? "number" : "text"} min={field.min} max={field.max} step={field.step} value={options[field.key] || ""} placeholder={uiText("默认")} disabled={field.key === "output_compression" && !["jpeg", "webp"].includes(options.output_format || "png")} className="w-full rounded border px-2 py-1.5 disabled:opacity-40" style={{ background: theme.node.fill, color: theme.node.text, borderColor: theme.node.stroke }} onChange={event => updateOption(field.key, event.target.value)} />}
                        {field.tip ? <span className="leading-5" style={{ color: theme.node.muted }}>{uiText(field.tip || "")}</span> : null}
                    </label>)}
                </div>
            </details> : null}
        </div>
    );
}

function imageOptionLabel(value: string) {
    return ({ "": uiText("默认"), true: uiText("开启"), false: uiText("关闭"), auto: uiText("自动"), opaque: uiText("不透明"), transparent: uiText("透明"), png: "PNG", jpeg: "JPEG", webp: "WebP", gif: "GIF", low: uiText("低"), medium: uiText("中"), high: uiText("高") } as Record<string, string>)[value] || value;
}

function ImageMarkupInput({ value, referenceCount, contextKey, onChange }: { value: string; referenceCount: number; contextKey: string; onChange: (value: string) => void }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const mounted = useRef(true);
    const change = useRef(onChange);
    const context = useRef({ key: contextKey, value });
    change.current = onChange;
    context.current = { key: contextKey, value };
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    let name = "";
    try { name = imageMarkupReference(JSON.stringify({ markup_reference: value }))?.name || ""; } catch { name = uiText("标注层记录无效，请重新上传"); }
    const pick = async (file?: File) => {
        if (!file || busy) return;
        const start = context.current;
        const stillCurrent = () => mounted.current && context.current.key === start.key && context.current.value === start.value;
        setBusy(true); setError("");
        try {
            if (file.size > 50 * 1024 * 1024) throw new Error("标注层不能超过 50 MB");
            const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
            if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => signature[index] === byte)) throw new Error("请上传独立透明 PNG 标注层");
            const stored = await uploadImage(file);
            if (stored.width * stored.height > 16_777_216) throw new Error("标注层总像素不能超过 16,777,216");
            if (!stillCurrent()) return;
            change.current(JSON.stringify({ id: `markup:${stored.storageKey}`, name: file.name, originalFileName: file.name, type: "image/png", dataUrl: stored.url, storageKey: stored.storageKey, bytes: stored.bytes, width: stored.width, height: stored.height }));
        } catch (error) { if (stillCurrent()) setError(error instanceof Error ? error.message : "标注层读取失败"); }
        finally { if (stillCurrent()) setBusy(false); }
    };
    return <div className="flex flex-col gap-2">
        <input aria-label={uiText("上传独立透明 PNG 标注层")} type="file" accept="image/png,.png" disabled={busy || referenceCount === 0} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void pick(file); }} />
        {busy ? <span role="status">{uiText("正在读取标注层")}</span> : null}
        {name ? <div>{name} <button type="button" onClick={() => onChange("")}>{uiText("移除标注层")}</button></div> : null}
        {referenceCount === 0 ? <span>{uiText("先添加至少一张参考图；标注层须与第一张参考图同尺寸。")}</span> : null}
        {error ? <span role="alert" className="text-destructive">{error}</span> : null}
    </div>;
}

export function ImageSettingsTheme({ theme, children }: { theme: CanvasTheme; children: ReactNode }) {
    useUiLocale();
    return <ConfigProvider theme={{ token: { colorBgContainer: theme.toolbar.panel, colorBgElevated: theme.toolbar.panel, colorBorder: theme.node.stroke, colorPrimary: theme.node.activeStroke, colorText: theme.node.text, colorTextLightSolid: theme.node.panel }, components: { Button: { defaultBg: theme.toolbar.panel, defaultBorderColor: theme.node.stroke, defaultColor: theme.node.text } } }}>{children}</ConfigProvider>;
}

export function imageQualityLabel(value: string) {
    return ({ auto: uiText("自动"), high: uiText("高"), xhigh: uiText("超高"), max: uiText("最高"), medium: uiText("中"), low: uiText("低"), relax: uiText("休闲"), fast: uiText("快速"), turbo: uiText("极速") } as Record<string, string>)[value] || value.toUpperCase();
}

export function imageSizeLabel(size: string) {
    return ({ auto: uiText("自适应"), "1024x1024": "1:1", "1536x1024": "3:2", "1024x1536": "2:3", "2048x2048": uiText("2K 方形"), "2048x1152": uiText("2K 横向"), "1152x2048": uiText("2K 纵向"), "3840x2160": uiText("4K 横向"), "2160x3840": uiText("4K 纵向"), "2880x2880": uiText("4K 档方形") } as Record<string, string>)[size] || size;
}
