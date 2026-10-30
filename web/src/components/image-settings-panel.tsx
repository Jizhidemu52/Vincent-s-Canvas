import { uiText, useUiLocale } from "@/lib/i18n";
import { type CSSProperties, type ReactNode, useEffect, useId, useState } from "react";
import { ConfigProvider } from "antd";
import { ChevronDown, Ratio, Layers2, SlidersHorizontal } from "lucide-react";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { AiConfig } from "@/stores/use-config-store";
import { imageModelSettingsError, normalizeImageModelSettings, useImageModelProfile } from "@/lib/image-model-settings";
import { imageOptionFields, readImageOptions } from "@/lib/image-advanced-settings";
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
    /** Canvas side popover: base controls live in the compact parameter row. */
    compact?: boolean;
    /** Wide canvas dialog: readable cards while preserving the legacy compact layout. */
    spacious?: boolean;
};

export function ImageSettingsPanel({ config, onConfigChange, onConfigNormalize = onConfigChange, theme, showTitle = true, className = "", maxCount: maximum, profile: suppliedProfile, referenceCount = 0, compact = false, spacious = false }: ImageSettingsPanelProps) {
    useUiLocale();
    const [snapToStep, setSnapToStep] = useState(false);
    const cachedProfile = useImageModelProfile(config.model || config.imageModel);
    const profile = suppliedProfile || cachedProfile;
    const normalized = normalizeImageModelSettings(config, profile);
    const maxCount = Math.min(maximum || profile.maxCount, profile.maxCount);
    const count = Math.min(maxCount, Number(normalized.count));
    const custom = !profile.sizes.includes(normalized.size);
    const dimensions = /^\d+x\d+$/.test(normalized.size) ? normalized.size.split("x").map(Number) : [1024, 1024];
    const sizeError = imageModelSettingsError(normalized.size, profile);
    const fields = imageOptionFields(profile).filter(field => field.key !== "resolution" && !(profile.kind === "midjourney-blend" && field.key === "dimensions"));
    const referenceQualityDisabled = profile.kind === "grok-image" && referenceCount > 0;
    const options = readImageOptions(config.imageOptions);
    const resolution = profile.resolutions.includes(options.resolution || "") ? options.resolution! : "1k";
    // Preserve intentional pixel sizes (including saved values inherited from another model).
    // The provider gives exact pixels precedence, so do not imply its resolution tier is active.
    const exactPixelsOverrideResolution = profile.resolutions.length > 0 && /^[1-9]\d*x[1-9]\d*$/.test(normalized.size);
    const resolutionNoticeId = useId();
    const updateOption = (key: string, value: string) => {
        const next = { ...options, [key]: value };
        if (!value) delete next[key];
        if (key === "background" && value === "transparent" && options.output_format === "jpeg") next.output_format = "png";
        if (key === "output_format" && value === "jpeg" && options.background === "transparent") next.background = "opaque";
        if (key === "dimensions" && value) onConfigChange("size", ({ SQUARE: "1:1", PORTRAIT: "2:3", LANDSCAPE: "3:2" } as Record<string, string>)[value]!);
        onConfigChange("imageOptions", JSON.stringify(next));
    };
    useEffect(() => {
        for (const key of ["size", "quality", "count"] as const) {
            // Quality is inactive with Grok references. Preserve the text-only preference
            // without fighting parent normalizers; request serialization omits it.
            if (key === "quality" && referenceQualityDisabled) continue;
            const value = key === "count" ? String(count) : normalized[key];
            if (config[key] !== value) onConfigNormalize(key, value);
        }
    }, [config.size, config.quality, config.count, normalized.size, normalized.quality, count, referenceQualityDisabled, onConfigNormalize]);
    useEffect(() => {
        if (profile.resolutions.length && options.resolution !== resolution) onConfigNormalize("imageOptions", JSON.stringify({ ...options, resolution }));
    }, [config.imageOptions, profile.resolutions.length, resolution, onConfigNormalize]);
    const commitDimension = (index: number, input: HTMLInputElement) => {
        const candidate = Math.round(Number(input.value));
        const value = Number.isSafeInteger(candidate) && candidate > 0 ? candidate : dimensions[index] || 1024;
        const next = [...dimensions];
        next[index] = snapToStep ? Math.ceil(value / 16) * 16 : value;
        input.value = String(next[index]);
        onConfigChange("size", next.join("x"));
    };
    return (
        <div className={`image-parameters${spacious ? " ip-spacious" : ""} ${className}`} style={{ "--ip-text": theme.node.text, "--ip-muted": theme.node.muted, "--ip-border": theme.node.stroke, "--ip-soft": theme.node.fill, "--ip-panel": theme.toolbar.panel } as CSSProperties}
            onMouseDown={event => event.stopPropagation()}>
            {showTitle ? <div className="ip-title">{uiText("图像设置")}</div> : null}
            {profile.kind === "midjourney-blend" ? <>
                <div className="ip-row"><span className="ip-label">{uiText("比例预设")}</span><label className="ip-select">
                    <select aria-label={uiText("比例预设")} value={options.dimensions || "SQUARE"} onChange={event => updateOption("dimensions", event.target.value)}>
                        <option value="SQUARE">{uiText("方形 1:1")}</option><option value="PORTRAIT">{uiText("竖向 2:3")}</option><option value="LANDSCAPE">{uiText("横向 3:2")}</option>
                    </select><ChevronDown size={13} aria-hidden />
                </label></div>
                <p className="text-xs leading-5" style={{ color: theme.node.muted }}>{uiText("选择预设会同步宽高比；实际提交的 size 优先于 dimensions，可在下方改为自由比例。")}</p>
            </> : null}
            {!compact && profile.verified ? <><div className="ip-row">
                <span className="ip-label"><Ratio size={15} />{uiText("宽高比")}</span>
                <label className="ip-select">
                    <select data-usage-control="size" aria-label={uiText("宽高比")} value={normalized.size} onChange={event => onConfigChange("size", event.target.value)}>
                        {profile.sizes.map(value => <option key={value} value={value}>{imageSizeLabel(value)}{value.includes("x") ? ` · ${value.replace("x", " × ")}` : ""}</option>)}
                        {custom ? <option value={normalized.size}>{uiText("自定义 ·")}{normalized.size.replace("x", " × ")}</option> : null}
                    </select>
                    <ChevronDown size={13} aria-hidden />
                </label>
            </div>
            <p className="text-xs leading-5" style={{ color: theme.node.muted }}>{uiText("仅影响下次 AI 生成，不改变已有图片。")}{uiText(profile.tip)} {uiText("高画质、大尺寸可能增加费用与耗时。")}</p>
            {profile.resolutions.length ? <div className="ip-row">
                <span className="ip-label">{uiText("清晰度 / 分辨率")}</span>
                <label className="ip-select">
                    <select data-usage-control="resolution" aria-label={uiText("清晰度 / 分辨率")} disabled={exactPixelsOverrideResolution} aria-describedby={exactPixelsOverrideResolution ? resolutionNoticeId : undefined} className={exactPixelsOverrideResolution ? "cursor-not-allowed opacity-60" : undefined} value={resolution} onChange={event => updateOption("resolution", event.target.value)}>
                        {profile.resolutions.map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}
                    </select>
                    <ChevronDown size={13} aria-hidden />
                </label>
            </div> : null}
            {exactPixelsOverrideResolution ? <p id={resolutionNoticeId} role="status" className="text-xs leading-5" style={{ color: theme.node.muted }}>{uiText("当前精确像素 {size} 优先，分辨率档位暂不生效；改选上方宽高比或自适应后启用。图片质量仍独立生效。", { size: normalized.size.replace("x", " × ") })}</p> : null}
            {referenceQualityDisabled ? <p role="status" className="text-xs leading-5" style={{ color: theme.node.muted }}>{uiText("参考图模式不提交 quality；移除全部参考图后可设置图片质量。")}</p> : <div className="ip-row">
                <span className="ip-label">{uiText(profile.qualityLabel)}</span>
                {profile.kind === "quality-resolution" || profile.kind === "resolution-1k" || profile.kind === "grok-image" ? <label className="ip-select">
                    <select data-usage-control={profile.kind === "resolution-1k" ? "resolution" : "quality"} aria-label={uiText(profile.qualityLabel)} value={normalized.quality} onChange={event => onConfigChange("quality", event.target.value)}>
                        {profile.qualities.map(value => <option key={value} value={value}>{imageQualityLabel(value)}</option>)}
                    </select>
                    <ChevronDown size={13} aria-hidden />
                </label> : <div className="ip-segments" role="group" aria-label={uiText(profile.qualityLabel)}>
                    {profile.qualities.map(value => <button key={value} data-usage-control={profile.kind === "gemini" ? "resolution" : "quality"} data-usage-value={value} type="button" aria-pressed={normalized.quality === value} onClick={() => onConfigChange("quality", value)}>{imageQualityLabel(value)}</button>)}
                </div>}
            </div>}
            </> : !profile.verified ? <p className="py-2 text-xs leading-5 opacity-60">{uiText(profile.tip)}</p> : null}
            {profile.customSize && spacious ? <section className="ip-section ip-size-section" aria-labelledby={`${resolutionNoticeId}-size-title`}>
                <div className="ip-section-heading">
                    <span className="ip-section-icon"><Ratio size={19} aria-hidden /></span>
                    <div><h3 id={`${resolutionNoticeId}-size-title`}>{uiText("自定义像素")}</h3><p>{uiText("精确设置下一次生成图片的宽度和高度。")}</p></div>
                    <span className="ip-section-badge">PX</span>
                </div>
                {profile.sizeConstraintMessage ? <p className="ip-section-notice">{uiText(profile.sizeConstraintMessage)}</p> : null}
                <div className="ip-size-grid">
                    {["宽度", "高度"].map((label, index) => <label key={`${label}-${dimensions[index]}`} className="ip-size-field">
                        <span>{uiText(label)}</span>
                        <span className="ip-dimension-input"><input aria-label={uiText("自定义{label}", { label: uiText(label) })} type="number" min={1} step={snapToStep ? 16 : 1} defaultValue={dimensions[index]} onBlur={event => commitDimension(index, event.currentTarget)} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /><span aria-hidden>px</span></span>
                    </label>)}
                </div>
                <label className="ip-snap-control"><input type="checkbox" checked={snapToStep} onChange={event => setSnapToStep(event.target.checked)} /><span><strong>{uiText("16 倍数对齐")}</strong><span>{uiText("调整尺寸时向上对齐到最近的 16 像素倍数。")}</span></span></label>
            </section> : profile.customSize ? <details className="ip-details" open={compact || undefined}>
                <summary>{uiText("自定义像素")}<ChevronDown size={13} /></summary>
                {profile.sizeConstraintMessage ? <p className="text-xs leading-5" style={{ color: theme.node.muted }}>{uiText(profile.sizeConstraintMessage)}</p> : null}
                <div className="ip-dimensions">
                    {["宽度", "高度"].map((label, index) => <label key={`${label}-${dimensions[index]}`}><span>{uiText(label)}</span><input aria-label={uiText("自定义{label}", { label: uiText(label) })} type="number" min={1} step={snapToStep ? 16 : 1} defaultValue={dimensions[index]} onBlur={event => commitDimension(index, event.currentTarget)} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>)}
                </div>
                <label className="ip-align"><input type="checkbox" checked={snapToStep} onChange={event => setSnapToStep(event.target.checked)} />{uiText("16倍数对齐")}</label>
            </details> : null}
            {profile.customAspect ? <label className="ip-row"><span className="ip-label">{uiText("自由比例")}</span><input key={normalized.size} aria-label={uiText("自定义宽高比")} defaultValue={normalized.size} placeholder={uiText("例如 7:5")} className="min-w-0 rounded border px-2 py-1.5" style={{ background: theme.node.fill, borderColor: theme.node.stroke }} onBlur={event => { if (/^[1-9]\d*:[1-9]\d*$/.test(event.currentTarget.value)) onConfigChange("size", event.currentTarget.value); else event.currentTarget.value = normalized.size; }} /></label> : null}
            {sizeError ? <p role="alert" className="text-xs text-destructive">{sizeError}</p> : null}
            {fields.length && spacious ? <section className="ip-section ip-advanced-section" aria-labelledby={`${resolutionNoticeId}-advanced-title`}>
                <div className="ip-section-heading">
                    <span className="ip-section-icon"><SlidersHorizontal size={19} aria-hidden /></span>
                    <div><h3 id={`${resolutionNoticeId}-advanced-title`}>{uiText("全部高级参数")}</h3><p>{uiText("留空使用渠道默认；只提交当前模型支持的字段。")}</p></div>
                    <span className="ip-section-badge">{fields.length} {uiText("项")}</span>
                </div>
                <div className="ip-options-grid">
                    {fields.map(field => {
                        const choices = field.options || (field.type === "boolean" ? ["true", "false"] : undefined);
                        const value = options[field.key] || "";
                        const disabled = field.key === "output_compression" && !["jpeg", "webp"].includes(options.output_format || "png");
                        const isLongText = field.type === "json" || ["negative_prompt", "extra"].includes(field.key);
                        const helpId = `${resolutionNoticeId}-${field.key}-help`;
                        const range = field.type === "number" ? uiText("范围 {min}–{max}{step}", { min: field.min ?? "", max: field.max ?? "", step: field.step !== undefined && field.step !== 1 ? uiText("，步长 {step}", { step: field.step }) : "" }) : "";
                        return <fieldset key={field.key} data-image-field={field.key} className={`ip-option-card${isLongText ? " ip-option-card-wide" : ""}${disabled ? " is-inactive" : ""}`}>
                            <legend>{uiText(field.label)}</legend>
                            {choices && choices.length <= 4 ? <div className="ip-option-choices" role="radiogroup" aria-label={uiText(field.label)} aria-describedby={field.tip ? helpId : undefined}>
                                {["", ...choices].map(choice => <label className="ip-option-choice" key={choice || "default"}>
                                    <input type="radio" name={`${resolutionNoticeId}-${field.key}`} data-image-option={field.key} value={choice} checked={value === choice} onChange={event => { if (event.target.checked) updateOption(field.key, choice); }} />
                                    <span>{imageOptionLabel(choice)}</span>
                                </label>)}
                            </div> : choices ? <select className="ip-option-input" aria-label={uiText(field.label)} value={value} aria-describedby={field.tip ? helpId : undefined} onChange={event => updateOption(field.key, event.target.value)}>
                                <option value="">{uiText("渠道默认")}</option>{choices.map(choice => <option key={choice} value={choice}>{imageOptionLabel(choice)}</option>)}
                            </select> : isLongText ? <textarea className="ip-option-input ip-option-textarea" aria-label={uiText(field.label)} aria-describedby={field.tip ? helpId : undefined} value={value} placeholder={field.type === "json" ? uiText("渠道默认，或填写 JSON 对象，例如 {\"job\":\"cloth\"}") : uiText("留空使用渠道默认")} rows={field.type === "json" ? 4 : 2} spellCheck={field.type === "json" ? false : undefined} onChange={event => updateOption(field.key, event.target.value)} /> : <input className="ip-option-input" aria-label={uiText(field.label)} aria-describedby={field.tip || range ? helpId : undefined} type={field.type === "number" ? "number" : "text"} min={field.min} max={field.max} step={field.step} value={value} placeholder={uiText("渠道默认")} disabled={disabled} onChange={event => updateOption(field.key, event.target.value)} />}
                            {field.tip || range ? <p id={helpId} className="ip-option-help">{range ? <span className="ip-option-range">{range}</span> : null}{uiText(field.tip || "")}</p> : null}
                        </fieldset>;
                    })}
                </div>
            </section> : fields.length ? <details className="ip-details" open={compact || undefined}>
                <summary>{uiText("全部高级参数")}<ChevronDown size={13} /></summary>
                <p className="text-xs leading-5" style={{ color: theme.node.muted }}>{uiText("留空使用渠道默认；只提交当前模型支持的字段。")}</p>
                <div className="flex flex-col gap-3 py-2">
                    {fields.map(field => <label key={field.key} className="flex flex-col gap-1 text-xs">
                        <span>{uiText(field.label)}</span>
                        {field.options || field.type === "boolean" ? <select aria-label={uiText(field.label)} value={options[field.key] || ""} className="w-full rounded border px-2 py-1.5" style={{ background: theme.node.fill, color: theme.node.text, borderColor: theme.node.stroke }} onChange={event => updateOption(field.key, event.target.value)}>
                            <option value="">{uiText("渠道默认")}</option>
                            {(field.options || ["true", "false"]).map(value => <option key={value} value={value}>{({ true: uiText("开启"), false: uiText("关闭"), auto: uiText("自动 (auto)"), opaque: uiText("不透明 (opaque)"), transparent: uiText("透明 (transparent)") } as Record<string, string>)[value] || value}</option>)}
                        </select> : <input aria-label={uiText(field.label)} type={field.type === "number" ? "number" : "text"} min={field.min} max={field.max} step={field.step} value={options[field.key] || ""} placeholder={uiText("渠道默认")} disabled={field.key === "output_compression" && !["jpeg", "webp"].includes(options.output_format || "png")} className="w-full rounded border px-2 py-1.5 disabled:opacity-40" style={{ background: theme.node.fill, color: theme.node.text, borderColor: theme.node.stroke }} onChange={event => updateOption(field.key, event.target.value)} />}
                        {field.tip ? <span className="leading-5" style={{ color: theme.node.muted }}>{uiText(field.tip || "")}</span> : null}
                    </label>)}
                </div>
            </details> : null}
        </div>
    );
}

function imageOptionLabel(value: string) {
    return ({ "": uiText("渠道默认"), true: uiText("开启"), false: uiText("关闭"), auto: uiText("自动"), opaque: uiText("不透明"), transparent: uiText("透明"), png: "PNG", jpeg: "JPEG", webp: "WebP" } as Record<string, string>)[value] || value;
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
