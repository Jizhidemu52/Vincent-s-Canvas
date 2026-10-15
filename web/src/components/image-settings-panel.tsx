import { type CSSProperties, type ReactNode, useEffect, useId, useState } from "react";
import { ConfigProvider } from "antd";
import { ChevronDown, Ratio, Layers2 } from "lucide-react";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { AiConfig } from "@/stores/use-config-store";
import { imageModelSettingsError, normalizeImageModelSettings, useImageModelProfile } from "@/lib/image-model-settings";
import { imageOptionFields, readImageOptions } from "@/lib/image-advanced-settings";
import "./image-settings-panel.css";

type ImageSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "quality" | "size" | "count" | "imageOptions", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    maxCount?: number;
    profile?: ReturnType<typeof useImageModelProfile>;
    referenceCount?: number;
    /** Canvas side popover: base controls live in the compact parameter row. */
    compact?: boolean;
};

export function ImageSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "", maxCount: maximum, profile: suppliedProfile, referenceCount = 0, compact = false }: ImageSettingsPanelProps) {
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
            if (config[key] !== value) onConfigChange(key, value);
        }
    }, [config.size, config.quality, config.count, normalized.size, normalized.quality, count, referenceQualityDisabled, onConfigChange]);
    useEffect(() => {
        if (profile.resolutions.length && options.resolution !== resolution) onConfigChange("imageOptions", JSON.stringify({ ...options, resolution }));
    }, [config.imageOptions, profile.resolutions.length, resolution, onConfigChange]);
    const commitDimension = (index: number, input: HTMLInputElement) => {
        const candidate = Math.round(Number(input.value));
        const value = Number.isSafeInteger(candidate) && candidate > 0 ? candidate : dimensions[index] || 1024;
        const next = [...dimensions];
        next[index] = snapToStep ? Math.ceil(value / 16) * 16 : value;
        input.value = String(next[index]);
        onConfigChange("size", next.join("x"));
    };
    return (
        <div className={`image-parameters ${className}`} style={{ "--ip-text": theme.node.text, "--ip-muted": theme.node.muted, "--ip-border": theme.node.stroke, "--ip-soft": theme.node.fill, "--ip-panel": theme.toolbar.panel } as CSSProperties}
            onMouseDown={event => event.stopPropagation()}>
            {showTitle ? <div className="ip-title">图像设置</div> : null}
            {profile.kind === "midjourney-blend" ? <>
                <div className="ip-row"><span className="ip-label">比例预设</span><label className="ip-select">
                    <select aria-label="比例预设" value={options.dimensions || "SQUARE"} onChange={event => updateOption("dimensions", event.target.value)}>
                        <option value="SQUARE">方形 1:1</option><option value="PORTRAIT">竖向 2:3</option><option value="LANDSCAPE">横向 3:2</option>
                    </select><ChevronDown size={13} aria-hidden />
                </label></div>
                <p className="text-xs leading-5" style={{ color: theme.node.muted }}>选择预设会同步宽高比；实际提交的 size 优先于 dimensions，可在下方改为自由比例。</p>
            </> : null}
            {!compact && profile.verified ? <><div className="ip-row">
                <span className="ip-label"><Ratio size={15} />宽高比</span>
                <label className="ip-select">
                    <select data-usage-control="size" aria-label="宽高比" value={normalized.size} onChange={event => onConfigChange("size", event.target.value)}>
                        {profile.sizes.map(value => <option key={value} value={value}>{imageSizeLabel(value)}{value.includes("x") ? ` · ${value.replace("x", " × ")}` : ""}</option>)}
                        {custom ? <option value={normalized.size}>自定义 · {normalized.size.replace("x", " × ")}</option> : null}
                    </select>
                    <ChevronDown size={13} aria-hidden />
                </label>
            </div>
            <p className="text-xs leading-5" style={{ color: theme.node.muted }}>仅影响下次 AI 生成，不改变已有图片。{profile.tip} 高画质、大尺寸可能增加费用与耗时。</p>
            {profile.resolutions.length ? <div className="ip-row">
                <span className="ip-label">清晰度 / 分辨率</span>
                <label className="ip-select">
                    <select data-usage-control="resolution" aria-label="清晰度 / 分辨率" disabled={exactPixelsOverrideResolution} aria-describedby={exactPixelsOverrideResolution ? resolutionNoticeId : undefined} className={exactPixelsOverrideResolution ? "cursor-not-allowed opacity-60" : undefined} value={resolution} onChange={event => updateOption("resolution", event.target.value)}>
                        {profile.resolutions.map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}
                    </select>
                    <ChevronDown size={13} aria-hidden />
                </label>
            </div> : null}
            {exactPixelsOverrideResolution ? <p id={resolutionNoticeId} role="status" className="text-xs leading-5" style={{ color: theme.node.muted }}>当前精确像素 {normalized.size.replace("x", " × ")} 优先，分辨率档位暂不生效；改选上方宽高比或自适应后启用。图片质量仍独立生效。</p> : null}
            {referenceQualityDisabled ? <p role="status" className="text-xs leading-5" style={{ color: theme.node.muted }}>参考图模式不提交 quality；移除全部参考图后可设置图片质量。</p> : <div className="ip-row">
                <span className="ip-label">{profile.qualityLabel}</span>
                {profile.kind === "quality-resolution" || profile.kind === "resolution-1k" || profile.kind === "grok-image" ? <label className="ip-select">
                    <select data-usage-control={profile.kind === "resolution-1k" ? "resolution" : "quality"} aria-label={profile.qualityLabel} value={normalized.quality} onChange={event => onConfigChange("quality", event.target.value)}>
                        {profile.qualities.map(value => <option key={value} value={value}>{imageQualityLabel(value)}</option>)}
                    </select>
                    <ChevronDown size={13} aria-hidden />
                </label> : <div className="ip-segments" role="group" aria-label={profile.qualityLabel}>
                    {profile.qualities.map(value => <button key={value} data-usage-control={profile.kind === "gemini" ? "resolution" : "quality"} data-usage-value={value} type="button" aria-pressed={normalized.quality === value} onClick={() => onConfigChange("quality", value)}>{imageQualityLabel(value)}</button>)}
                </div>}
            </div>}
            </> : !profile.verified ? <p className="py-2 text-xs leading-5 opacity-60">{profile.tip}</p> : null}
            {!compact ? <div className="ip-row">
                <span className="ip-label" title="每次提交生成 1 张图片；可连续提交多个独立任务。"><Layers2 size={15} />任务数</span>
                <span className="ip-fixed-count">1 个任务</span>
            </div> : null}
            {profile.customSize ? <details className="ip-details" open={compact || undefined}>
                <summary>自定义像素<ChevronDown size={13} /></summary>
                {profile.sizeConstraintMessage ? <p className="text-xs leading-5" style={{ color: theme.node.muted }}>{profile.sizeConstraintMessage}</p> : null}
                <div className="ip-dimensions">
                    {["宽度", "高度"].map((label, index) => <label key={`${label}-${dimensions[index]}`}><span>{label}</span><input aria-label={`自定义${label}`} type="number" min={1} step={snapToStep ? 16 : 1} defaultValue={dimensions[index]} onBlur={event => commitDimension(index, event.currentTarget)} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>)}
                </div>
                <label className="ip-align"><input type="checkbox" checked={snapToStep} onChange={event => setSnapToStep(event.target.checked)} />16倍数对齐</label>
            </details> : null}
            {profile.customAspect ? <label className="ip-row"><span className="ip-label">自由比例</span><input key={normalized.size} aria-label="自定义宽高比" defaultValue={normalized.size} placeholder="例如 7:5" className="min-w-0 rounded border px-2 py-1.5" style={{ background: theme.node.fill, borderColor: theme.node.stroke }} onBlur={event => { if (/^[1-9]\d*:[1-9]\d*$/.test(event.currentTarget.value)) onConfigChange("size", event.currentTarget.value); else event.currentTarget.value = normalized.size; }} /></label> : null}
            {sizeError ? <p role="alert" className="text-xs text-destructive">{sizeError}</p> : null}
            {fields.length ? <details className="ip-details" open={compact || undefined}>
                <summary>全部高级参数<ChevronDown size={13} /></summary>
                <p className="text-xs leading-5" style={{ color: theme.node.muted }}>留空使用渠道默认；只提交当前模型支持的字段。</p>
                <div className="flex flex-col gap-3 py-2">
                    {fields.map(field => <label key={field.key} className="flex flex-col gap-1 text-xs">
                        <span>{field.label} <span style={{ color: theme.node.muted }}>({field.key})</span></span>
                        {field.options || field.type === "boolean" ? <select aria-label={field.label} value={options[field.key] || ""} className="w-full rounded border px-2 py-1.5" style={{ background: theme.node.fill, color: theme.node.text, borderColor: theme.node.stroke }} onChange={event => updateOption(field.key, event.target.value)}>
                            <option value="">渠道默认</option>
                            {(field.options || ["true", "false"]).map(value => <option key={value} value={value}>{({ true: "开启", false: "关闭", auto: "自动 (auto)", opaque: "不透明 (opaque)", transparent: "透明 (transparent)" } as Record<string, string>)[value] || value}</option>)}
                        </select> : <input aria-label={field.label} type={field.type === "number" ? "number" : "text"} min={field.min} max={field.max} step={field.step} value={options[field.key] || ""} placeholder="渠道默认" disabled={field.key === "output_compression" && !["jpeg", "webp"].includes(options.output_format || "png")} className="w-full rounded border px-2 py-1.5 disabled:opacity-40" style={{ background: theme.node.fill, color: theme.node.text, borderColor: theme.node.stroke }} onChange={event => updateOption(field.key, event.target.value)} />}
                        {field.tip ? <span className="leading-5" style={{ color: theme.node.muted }}>{field.tip}</span> : null}
                    </label>)}
                </div>
            </details> : null}
        </div>
    );
}

export function ImageSettingsTheme({ theme, children }: { theme: CanvasTheme; children: ReactNode }) {
    return <ConfigProvider theme={{ token: { colorBgContainer: theme.toolbar.panel, colorBgElevated: theme.toolbar.panel, colorBorder: theme.node.stroke, colorPrimary: theme.node.activeStroke, colorText: theme.node.text, colorTextLightSolid: theme.node.panel }, components: { Button: { defaultBg: theme.toolbar.panel, defaultBorderColor: theme.node.stroke, defaultColor: theme.node.text } } }}>{children}</ConfigProvider>;
}

export function imageQualityLabel(value: string) {
    return ({ auto: "自动 auto", high: "高 high", xhigh: "超高 xhigh", max: "最高 max", medium: "中 medium", low: "低 low", relax: "休闲", fast: "快速", turbo: "极速" } as Record<string, string>)[value] || value.toUpperCase();
}

export function imageSizeLabel(size: string) {
    return ({ auto: "自适应", "1024x1024": "1:1", "1536x1024": "3:2", "1024x1536": "2:3", "2048x2048": "2K 方形", "2048x1152": "2K 横向", "1152x2048": "2K 纵向", "3840x2160": "4K 横向", "2160x3840": "4K 纵向", "2880x2880": "4K 档方形" } as Record<string, string>)[size] || size;
}
