import { useEffect, type ReactNode } from "react";
import { Switch } from "antd";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { getVideoModelParameterSpec, normalizeVideoModelConfig, videoAspectRatioFollowsImage, videoModeLabels, videoModeLocksRatio, type VideoModelParameterKey } from "@/lib/video-model-parameters";
import { type AiConfig } from "@/stores/use-config-store";

const ratioLabels: Record<string, string> = { "16:9": "横屏", "9:16": "竖屏", "1:1": "方形", "4:3": "标准横屏", "3:4": "标准竖屏", "21:9": "宽银幕", adaptive: "自适应" };

type VideoSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: VideoModelParameterKey, value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    referenceCount?: number;
    imageMode?: string;
};

export function VideoSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", referenceCount, imageMode }: VideoSettingsPanelProps) {
    const spec = getVideoModelParameterSpec(config);
    const normalized = normalizeVideoModelConfig(config);
    const ratioFollowsImage = videoAspectRatioFollowsImage(config, referenceCount, normalized.videoMode === "auto" ? imageMode : normalized.videoMode);
    const lockRatio = videoModeLocksRatio({ ...config, videoMode: normalized.videoMode });
    const editing = normalized.videoMode === "edit";

    useEffect(() => {
        for (const [key, value] of Object.entries(normalizeVideoModelConfig(config))) {
            if (config[key as VideoModelParameterKey] !== value) onConfigChange(key as VideoModelParameterKey, value);
        }
    }, [config, onConfigChange]);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">视频设置</div> : null}
                {!spec ? <p className="text-sm leading-6" style={{ color: theme.node.muted }}>当前模型尚未提供参数规格，请先选择已配置的视频模型。</p> : <>
                    <SettingGroup title="生成方式" color={theme.node.muted}>
                        <select aria-label="视频生成方式" className="h-9 w-full cursor-pointer rounded-xl border px-3 text-sm outline-none" style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }} value={normalized.videoMode} onChange={(event) => onConfigChange("videoMode", event.target.value)}>
                            {spec.modes.map((mode) => <option key={mode} value={mode}>{videoModeLabels[mode]}</option>)}
                        </select>
                        {normalized.videoMode === "first-last-frame" ? <p className="text-[11px] leading-4" style={{ color: theme.node.muted }}>图片 1 为首帧，图片 2 为尾帧；可在参考素材中调整顺序。</p> : null}
                        {normalized.videoMode === "extend" ? <p className="text-[11px] leading-4" style={{ color: theme.node.muted }}>请添加源视频，并在提示词中明确描述延长或续写内容。Wan 可加 1 张图片作为尾帧。</p> : null}
                        {editing ? <p className="text-[11px] leading-4" style={{ color: theme.node.muted }}>请添加至少 1 段 4–30 秒源视频，并明确描述编辑、删除或替换内容。</p> : null}
                    </SettingGroup>
                    <SettingGroup title="分辨率" color={theme.node.muted}>
                        <div className="grid grid-cols-2 gap-2.5">
                            {spec.resolutions.map((value) => <OptionPill key={value} selected={normalized.vquality === value} theme={theme} onClick={() => onConfigChange("vquality", value)}>{value}</OptionPill>)}
                        </div>
                    </SettingGroup>
                    <SettingGroup title="画面比例" color={theme.node.muted}>
                        {lockRatio ? <div className="rounded-xl border px-3 py-2.5 text-sm" style={{ borderColor: theme.node.stroke }}>此模式固定使用自适应比例（adaptive）</div> : ratioFollowsImage ? <div className="rounded-xl border px-3 py-2.5 text-sm" style={{ borderColor: theme.node.stroke }}>跟随输入图片，无需设置比例</div> : <div className="grid grid-cols-3 gap-2.5">
                            {spec.sizes.map((value) => (
                                <button key={value} type="button" aria-pressed={normalized.size === value} className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border bg-transparent px-1 text-sm transition hover:opacity-80" style={{ borderColor: normalized.size === value ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={() => onConfigChange("size", value)}>
                                    <SizePreview ratio={value} color={theme.node.text} />
                                    <span>{value === "adaptive" ? "自适应" : value}</span>
                                    {value !== "adaptive" ? <span className="text-[10px] leading-none opacity-55">{ratioLabels[value]}</span> : null}
                                </button>
                            ))}
                        </div>}
                        {spec.ratioHint ? <p className="text-[11px] leading-4" style={{ color: theme.node.muted }}>{spec.ratioHint}</p> : null}
                    </SettingGroup>
                    <SettingGroup title="时长" color={theme.node.muted}>
                        <select aria-label="视频时长" disabled={editing} className="h-9 w-full cursor-pointer rounded-xl border px-3 text-sm outline-none disabled:cursor-not-allowed" style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }} value={normalized.videoSeconds} onChange={(event) => onConfigChange("videoSeconds", event.target.value)}>
                            {spec.supportsAutoDuration ? <option value="-1">智能时长</option> : null}
                            {Array.from({ length: spec.seconds[1] - spec.seconds[0] + 1 }, (_, index) => spec.seconds[0] + index).map((seconds) => <option key={seconds} value={String(seconds)}>{seconds} 秒</option>)}
                        </select>
                        <div className="text-[11px] leading-4" style={{ color: theme.node.muted }}>支持 {spec.seconds[0]}–{spec.seconds[1]} 秒{spec.supportsAutoDuration ? "，或由模型智能决定时长" : ""}。</div>
                        {normalized.videoSeconds === "-1" ? <p role="note" className="text-xs leading-5" style={{ color: theme.node.text }}>{editing ? "编辑结果时长跟随源视频。" : "实际输出时长由模型决定。"}渠道账户按最多 30 秒输出预扣，参考视频输入时长也计费，完成后由渠道按实际用量结算。本应用积分仍按管理员配置的每任务价格计算。</p> : null}
                    </SettingGroup>
                    {spec.supportsAudio || spec.supportsWatermark ? <SettingGroup title="输出" color={theme.node.muted}>
                        <div className="grid gap-2 rounded-xl border p-2.5" style={{ borderColor: theme.node.stroke }}>
                            {spec.supportsAudio ? <SwitchRow label="生成声音" checked={normalized.videoGenerateAudio === "true"} theme={theme} onChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} /> : null}
                            {spec.supportsWatermark ? <SwitchRow label="添加水印" checked={normalized.videoWatermark === "true"} theme={theme} onChange={(checked) => onConfigChange("videoWatermark", String(checked))} /> : null}
                        </div>
                    </SettingGroup> : null}
                    <div className="space-y-1 text-[11px] leading-4" style={{ color: theme.node.muted }}><p>{spec.imageInputHint}</p>{spec.mediaHint ? <p>{spec.mediaHint}</p> : null}{spec.audioHint ? <p>{spec.audioHint}</p> : null}</div>
                </>}
            </div>
        </ImageSettingsTheme>
    );
}

export function videoResolutionLabel(value: string) {
    const normalized = normalizeVideoResolutionValue(value);
    return /k$/i.test(normalized) ? normalized.toUpperCase() : normalized + "p";
}

export function videoSizeLabel(value: string) {
    if (value === "adaptive" || value === "auto") return "自适应";
    return ratioLabels[value] || value;
}

export function videoSecondsLabel(value: string) {
    return String(value).trim() === "-1" ? "智能" : (value || "5") + "s";
}

export function normalizeVideoSizeValue(value: string) {
    if (value === "auto" || value === "adaptive" || /^\d+x\d+$/.test(value || "") || value in ratioLabels) return value;
    return "16:9";
}

export function normalizeVideoResolutionValue(value: string) {
    if (value === "low") return "480";
    if (value === "auto" || value === "high" || value === "medium") return "720";
    return value.replace(/p$/i, "") || "720";
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return <button type="button" aria-pressed={selected} className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>{children}</button>;
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return <div className="space-y-2.5"><div className="text-xs font-medium" style={{ color }}>{title}</div>{children}</div>;
}

function SizePreview({ ratio, color }: { ratio: string; color: string }) {
    const [width, height] = ratio.split(":").map(Number);
    if (!width || !height) return <span className="text-lg leading-6">↔</span>;
    const longSide = Math.max(width, height);
    return <span className="rounded-[3px] border-2" style={{ width: Math.max(10, Math.round((width / longSide) * 24)), height: Math.max(10, Math.round((height / longSide) * 24)), borderColor: color }} />;
}

function SwitchRow({ label, checked, theme, onChange }: { label: string; checked: boolean; theme: CanvasTheme; onChange: (checked: boolean) => void }) {
    return <div className="flex h-8 items-center justify-between gap-3"><span className="text-sm" style={{ color: theme.node.text }}>{label}</span><span onMouseDown={(event) => event.stopPropagation()}><Switch size="small" checked={checked} onChange={onChange} /></span></div>;
}
