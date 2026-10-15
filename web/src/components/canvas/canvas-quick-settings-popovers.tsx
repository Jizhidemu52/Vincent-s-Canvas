import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Dialog, Popover } from "radix-ui";
import { ChevronDown, SlidersHorizontal, X } from "lucide-react";
import { ImageSettingsPanel, imageSizeLabel } from "@/components/image-settings-panel";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { imageOptionFields, readImageOptions } from "@/lib/image-advanced-settings";
import { normalizeImageModelSettings, type imageModelProfile } from "@/lib/image-model-settings";
import type { AiConfig } from "@/stores/use-config-store";
import "./canvas-quick-settings-popovers.css";

type Profile = ReturnType<typeof imageModelProfile>;
type SettingChange = (key: "quality" | "size" | "count" | "imageOptions", value: string) => void;
type Props = { config: AiConfig; profile: Profile; theme: CanvasTheme; referenceCount: number; disabled: boolean; onConfigChange: SettingChange };
type Parameter = "size" | "quality" | "advanced";

function qualityLabel(value: string) {
    return ({ auto: "自动", high: "高", xhigh: "超高", max: "最高", medium: "中", low: "低", relax: "休闲", fast: "快速", turbo: "极速" } as Record<string, string>)[value] || value.toUpperCase();
}

function sizeLabel(value: string) {
    return value === "auto" ? "自动" : imageSizeLabel(value);
}

function RatioOutline({ value }: { value: string }) {
    const [width, height] = value.split(/[:x]/).map(Number);
    const ratio = width! > 0 && height! > 0 ? width! / height! : 1;
    const style = { width: Math.max(3, ratio >= 1 ? 23 : 23 * ratio), height: Math.max(3, ratio >= 1 ? 23 / ratio : 23) };
    return <span className={`cw-ratio-outline${value === "auto" ? " is-auto" : ""}`} style={style} aria-hidden />;
}

export function CanvasQuickRatioOptions({ profile, value, onChange, onAdvanced }: { profile: Profile; value: string; onChange: (value: string) => void; onAdvanced?: () => void }) {
    return <>
        <div className="cw-ratio-grid" role="group" aria-label="宽高比">
            {profile.sizes.filter(size => size !== "auto").map(size => <button key={size} type="button" className="cw-ratio-choice" aria-pressed={value === size}
                data-usage-control="size" data-usage-value={size} title={size.includes("x") ? size.replace("x", " × ") : size}
                onClick={() => onChange(size)}><span className="cw-ratio-preview"><RatioOutline value={size} /></span><span>{sizeLabel(size)}</span></button>)}
        </div>
        <div className="cw-ratio-footer">
            <span title={value}>{profile.sizes.includes(value) ? sizeLabel(value) : value.replace("x", " × ")}</span>
            {profile.sizes.includes("auto") ? <button type="button" aria-pressed={value === "auto"} data-usage-control="size" data-usage-value="auto" onClick={() => onChange("auto")}>自动</button> : null}
            {onAdvanced ? <button type="button" onClick={onAdvanced}>{profile.customSize ? "自定义像素" : "自由比例"}</button> : null}
        </div>
    </>;
}

export function CanvasQuickQualityOptions({ config, profile, referenceCount, onConfigChange }: Pick<Props, "config" | "profile" | "referenceCount" | "onConfigChange">) {
    const settings = normalizeImageModelSettings(config, profile);
    const options = readImageOptions(config.imageOptions);
    const resolution = profile.resolutions.includes(options.resolution || "") ? options.resolution! : "1k";
    const exactPixels = profile.resolutions.length > 0 && /^[1-9]\d*x[1-9]\d*$/.test(settings.size);
    const referenceQualityDisabled = profile.kind === "grok-image" && referenceCount > 0;
    return <div className="cw-quality-options">
        {profile.resolutions.length > 0 ? <section>
            <h4>清晰度 / 分辨率</h4>
            <div className="cw-parameter-choices" role="group" aria-label="清晰度 / 分辨率">
                {profile.resolutions.map(value => <button key={value} type="button" aria-pressed={resolution === value} disabled={exactPixels}
                    data-usage-control="resolution" data-usage-value={value}
                    onClick={() => onConfigChange("imageOptions", JSON.stringify({ ...options, resolution: value }))}>{value.toUpperCase()}</button>)}
            </div>
            {exactPixels ? <p role="status">精确像素 {settings.size.replace("x", " × ")} 优先于分辨率档位；改选宽高比或自动后启用。</p> : null}
        </section> : null}
        {referenceQualityDisabled ? <p role="status">参考图模式不提交图片质量；移除全部参考图后恢复设置。</p> : <section>
            <h4>{profile.qualityLabel}</h4>
            <div className="cw-parameter-choices" role="group" aria-label={profile.qualityLabel}>
                {profile.qualities.map(value => <button key={value} type="button" aria-pressed={settings.quality === value}
                    data-usage-control={profile.kind === "gemini" || profile.kind === "resolution-1k" || profile.kind === "gpt" ? "resolution" : "quality"} data-usage-value={value}
                    onClick={() => onConfigChange("quality", value)}>{qualityLabel(value)}</button>)}
            </div>
        </section>}
        <p>仅用于下次生成。更高画质或分辨率可能增加费用与耗时。</p>
    </div>;
}

function ParameterPopover({ id, label, summary, icon, disabled, active, onActiveChange, style, anchor, children }: {
    id: Parameter; label: string; summary: string; icon?: ReactNode; disabled: boolean; active: Parameter | null;
    onActiveChange: (value: Parameter | null) => void; style: CSSProperties; anchor: RefObject<HTMLDivElement>; children: ReactNode;
}) {
    return <Popover.Root open={!disabled && active === id} onOpenChange={open => onActiveChange(open ? id : null)}>
        <Popover.Trigger asChild><button type="button" className={`cw-parameter-trigger cw-parameter-trigger-${id}`} disabled={disabled} aria-label={label} title={`${label}：${summary}`}>
            {icon}<span>{summary}</span>{id !== "advanced" ? <ChevronDown size={11} aria-hidden /> : null}
        </button></Popover.Trigger>
        <Popover.Anchor virtualRef={anchor} />
        <Popover.Portal><Popover.Content className={`cw-parameter-popover cw-parameter-popover-${id}`} data-canvas-no-zoom
            aria-label={label} side="bottom" align="center" sideOffset={10} collisionPadding={12} avoidCollisions={false} style={style}
            onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
            onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
            <header className="cw-parameter-header">
                <Popover.Close asChild><button type="button" className="cw-parameter-back" aria-label="返回创建面板">← 返回</button></Popover.Close>
                <h3 className="cw-parameter-title">{label}</h3>
            </header>
            <div className="cw-parameter-body">{children}</div>
        </Popover.Content></Popover.Portal>
    </Popover.Root>;
}

function AdvancedSettingsDialog({ active, onActiveChange, disabled, style, config, profile, theme, referenceCount, onConfigChange }: Props & {
    id: "advanced"; active: Parameter | null; onActiveChange: (value: Parameter | null) => void; style: CSSProperties;
}) {
    return <Dialog.Root open={!disabled && active === "advanced"} onOpenChange={open => onActiveChange(open ? "advanced" : null)}>
        <Dialog.Trigger asChild><button type="button" className="cw-parameter-trigger cw-parameter-trigger-advanced" aria-label="更多设置" disabled={disabled}><SlidersHorizontal size={18} /><span>更多设置</span></button></Dialog.Trigger>
        <Dialog.Portal>
            <Dialog.Overlay className="cw-settings-overlay" />
            <Dialog.Content className="cw-settings-dialog" style={style} data-canvas-no-zoom
                onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
                <header className="cw-settings-dialog-header">
                    <div><Dialog.Title>图像高级设置</Dialog.Title><Dialog.Description>选择输出尺寸、格式和模型支持的额外参数。</Dialog.Description></div>
                    <Dialog.Close asChild><button type="button" className="cw-settings-close" aria-label="返回创建面板"><X size={22} /></button></Dialog.Close>
                </header>
                <div className="cw-settings-dialog-body">
                    <div className="cw-settings-overview"><span>当前输出</span><strong>{sizeLabel(config.size)}</strong><span>{qualityLabel(config.quality)}</span><span>每次 1 张</span></div>
                    <fieldset disabled={disabled} className="cw-advanced-fields"><ImageSettingsPanel spacious compact showTitle={false} config={config} profile={profile} referenceCount={referenceCount}
                        theme={theme} onConfigChange={onConfigChange} /></fieldset>
                </div>
                <footer className="cw-settings-dialog-footer"><span>设置自动应用于下一次生成，不改变已有图片。</span><Dialog.Close asChild><button type="button" className="cw-settings-done">完成设置</button></Dialog.Close></footer>
            </Dialog.Content>
        </Dialog.Portal>
    </Dialog.Root>;
}

export function CanvasQuickSettingsPopovers({ config, profile, theme, referenceCount, disabled, onConfigChange }: Props) {
    const [active, setActive] = useState<Parameter | null>(null);
    const parameterRow = useRef<HTMLDivElement>(null!);
    const settings = normalizeImageModelSettings(config, profile);
    const options = readImageOptions(config.imageOptions);
    const resolution = profile.resolutions.includes(options.resolution || "") ? options.resolution! : "1k";
    const referenceQualityDisabled = profile.kind === "grok-image" && referenceCount > 0;
    const exactPixels = profile.resolutions.length > 0 && /^[1-9]\d*x[1-9]\d*$/.test(settings.size);
    const qualitySummary = !profile.verified ? "渠道默认" : profile.resolutions.length
        ? `${exactPixels ? "像素" : resolution.toUpperCase()}${referenceQualityDisabled ? "" : ` · ${qualityLabel(settings.quality)}`}` : qualityLabel(settings.quality);
    const hasAdvanced = profile.customSize || profile.customAspect || imageOptionFields(profile).some(field => field.key !== "resolution");
    const style = { "--cw-parameter-text": theme.node.text, "--cw-parameter-muted": theme.node.muted, "--cw-parameter-border": theme.node.stroke,
        "--cw-parameter-soft": theme.toolbar.itemHover, "--cw-parameter-panel": theme.node.panel } as CSSProperties;
    useEffect(() => { setActive(null); }, [config.model, disabled]);
    useEffect(() => {
        if (!disabled && profile.resolutions.length && options.resolution !== resolution) onConfigChange("imageOptions", JSON.stringify({ ...options, resolution }));
    }, [config.imageOptions, disabled, profile.resolutions.length, resolution, onConfigChange]);
    const common = { active, onActiveChange: setActive, style };
    return <div ref={parameterRow} className="cw-parameter-row" data-open={active || undefined} aria-label="生成参数" style={style}>
        <ParameterPopover {...common} anchor={parameterRow} id="size" label="宽高比" summary={sizeLabel(settings.size)} icon={<RatioOutline value={settings.size} />} disabled={disabled || !profile.verified}>
            <CanvasQuickRatioOptions profile={profile} value={settings.size} onChange={value => { onConfigChange("size", value); setActive(null); }}
                onAdvanced={profile.customSize || profile.customAspect ? () => setActive("advanced") : undefined} />
        </ParameterPopover>
        <ParameterPopover {...common} anchor={parameterRow} id="quality" label={profile.resolutions.length ? "分辨率与质量" : profile.qualityLabel} summary={qualitySummary} disabled={disabled || !profile.verified}>
            <CanvasQuickQualityOptions config={config} profile={profile} referenceCount={referenceCount} onConfigChange={onConfigChange} />
        </ParameterPopover>
        <AdvancedSettingsDialog {...common} id="advanced" config={config} profile={profile} theme={theme} referenceCount={referenceCount} onConfigChange={onConfigChange} disabled={disabled || !hasAdvanced} />
    </div>;
}
