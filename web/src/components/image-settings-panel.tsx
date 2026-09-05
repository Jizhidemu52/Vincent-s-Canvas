import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { ConfigProvider } from "antd";
import { ChevronDown, Minus, Plus, Ratio, Layers2 } from "lucide-react";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { AiConfig } from "@/stores/use-config-store";
import { normalizeImageModelSettings, useImageModelProfile } from "@/lib/image-model-settings";
import "./image-settings-panel.css";

type ImageSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "quality" | "size" | "count", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    maxCount?: number;
};

export function ImageSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "", maxCount: maximum }: ImageSettingsPanelProps) {
    const [snapToStep, setSnapToStep] = useState(false);
    const profile = useImageModelProfile(config.model || config.imageModel);
    const normalized = normalizeImageModelSettings(config, profile);
    const maxCount = Math.min(maximum || profile.maxCount, profile.maxCount);
    const count = Math.min(maxCount, Number(normalized.count));
    const custom = !profile.sizes.includes(normalized.size);
    const dimensions = /^\d+x\d+$/.test(normalized.size) ? normalized.size.split("x").map(Number) : [1024, 1024];
    useEffect(() => {
        for (const key of ["size", "quality", "count"] as const) {
            const value = key === "count" ? String(count) : normalized[key];
            if (config[key] !== value) onConfigChange(key, value);
        }
    }, [config.size, config.quality, config.count, normalized.size, normalized.quality, count, onConfigChange]);
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
            {profile.verified ? <><div className="ip-row">
                <span className="ip-label"><Ratio size={15} />宽高比</span>
                <label className="ip-select">
                    <select aria-label="宽高比" value={normalized.size} onChange={event => onConfigChange("size", event.target.value)}>
                        {profile.sizes.map(value => <option key={value} value={value}>{imageSizeLabel(value)}{value.includes("x") ? ` · ${value.replace("x", " × ")}` : ""}</option>)}
                        {custom ? <option value={normalized.size}>自定义 · {normalized.size.replace("x", " × ")}</option> : null}
                    </select>
                    <ChevronDown size={13} aria-hidden />
                </label>
            </div>
            <div className="ip-row">
                <span className="ip-label">{profile.qualityLabel}</span>
                <div className="ip-segments" role="group" aria-label={profile.qualityLabel}>
                    {profile.qualities.map(value => <button key={value} type="button" aria-pressed={normalized.quality === value} onClick={() => onConfigChange("quality", value)}>{imageQualityLabel(value)}</button>)}
                </div>
            </div>
            </> : <p className="py-2 text-xs leading-5 opacity-60">{profile.tip}</p>}
            <div className="ip-row">
                <span className="ip-label" title="多张会拆分为多个独立任务；每个上游请求只生成一张，并分别计费。"><Layers2 size={15} />{maxCount > 1 ? "批量张数" : "任务数"}</span>
                {maxCount > 1 ? <div className="ip-count">
                    <input type="range" min={1} max={maxCount} step={1} value={count} aria-label="生成张数" onChange={event => onConfigChange("count", event.target.value)} />
                    <div className="ip-stepper">
                        <button type="button" aria-label="减少生成张数" disabled={count <= 1} onClick={() => onConfigChange("count", String(count - 1))}><Minus size={12} /></button>
                        <output aria-live="polite">{count}</output>
                        <button type="button" aria-label="增加生成张数" disabled={count >= maxCount} onClick={() => onConfigChange("count", String(count + 1))}><Plus size={12} /></button>
                    </div>
                </div> : <span className="ip-fixed-count">1 个任务</span>}
            </div>
            {profile.customSize ? <details className="ip-details">
                <summary>自定义像素<ChevronDown size={13} /></summary>
                <div className="ip-dimensions">
                    {["宽度", "高度"].map((label, index) => <label key={`${label}-${dimensions[index]}`}><span>{label}</span><input aria-label={`自定义${label}`} type="number" min={1} step={snapToStep ? 16 : 1} defaultValue={dimensions[index]} onBlur={event => commitDimension(index, event.currentTarget)} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>)}
                </div>
                <label className="ip-align"><input type="checkbox" checked={snapToStep} onChange={event => setSnapToStep(event.target.checked)} />16倍数对齐</label>
            </details> : null}
        </div>
    );
}

export function ImageSettingsTheme({ theme, children }: { theme: CanvasTheme; children: ReactNode }) {
    return <ConfigProvider theme={{ token: { colorBgContainer: theme.toolbar.panel, colorBgElevated: theme.toolbar.panel, colorBorder: theme.node.stroke, colorPrimary: theme.node.activeStroke, colorText: theme.node.text, colorTextLightSolid: theme.node.panel }, components: { Button: { defaultBg: theme.toolbar.panel, defaultBorderColor: theme.node.stroke, defaultColor: theme.node.text } } }}>{children}</ConfigProvider>;
}

export function imageQualityLabel(value: string) {
    return ({ auto: "自动", high: "高", medium: "中", low: "低", relax: "休闲", fast: "快速", turbo: "极速" } as Record<string, string>)[value] || value.toUpperCase();
}

export function imageSizeLabel(size: string) {
    return ({ auto: "自动", "1024x1024": "1:1", "1536x1024": "3:2", "1024x1536": "2:3" } as Record<string, string>)[size] || size;
}
