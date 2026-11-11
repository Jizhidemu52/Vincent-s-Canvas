import { Button } from "antd";
import { useState } from "react";
import { videoMotionGroups, type VideoMotionSettings } from "../../../../shared/video-motion-options";
import { uiText, useUiText } from "@/lib/i18n";

/** This is a public option vocabulary, never the private writing recipe. */
export function VideoMotionPanel({ value, onChange, disabled = false, nativeAudio = false }: { value: VideoMotionSettings; onChange: (value: VideoMotionSettings) => void; disabled?: boolean; nativeAudio?: boolean }) {
    useUiText();
    const [open, setOpen] = useState(false);
    return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="rounded-xl border border-border p-3" data-testid="video-motion-panel">
        <summary className="cursor-pointer text-sm font-medium">{uiText("动效设置（可选）")}<span className="ml-2 text-xs font-normal text-muted-foreground">{uiText("不选也能生成")}</span></summary>
        <div className="mt-4 space-y-4">
            {videoMotionGroups.map(group => {
                const current = nativeAudio && group.id === "audio" && value.audio === "none" ? "ambient" : value[group.id];
                return <fieldset key={group.id} disabled={disabled} className="min-w-0">
                    <legend className="mb-2 text-xs font-medium text-muted-foreground">{uiText(group.label)}{group.id === "subject_action" ? ` · ${uiText("最多选 2 项")}` : ""}</legend>
                    <div className="flex flex-wrap gap-1.5">{group.options.filter(option => !nativeAudio || group.id !== "audio" || option.id !== "none").map(option => {
                        const selected = Array.isArray(current) ? current.includes(option.id) : current === option.id;
                        const full = Array.isArray(current) && Boolean(group.max && current.length >= group.max) && !selected;
                        return <Button key={option.id} size="small" type={selected ? "primary" : "default"} aria-pressed={selected} title={uiText(option.description)} disabled={disabled || full} onClick={() => {
                            const next = Array.isArray(current) ? selected ? current.filter(id => id !== option.id) : [...current, option.id] : selected && group.id !== "audio" ? "auto" : option.id;
                            onChange({ ...value, [group.id]: next });
                        }}>{uiText(option.label)}</Button>;
                    })}</div>
                    {nativeAudio && group.id === "audio" ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{uiText("模型原生输出含音频；这里是声音偏好，不是静音开关，不保证无声。")}</p> : null}
                </fieldset>;
            })}
        </div>
    </details>;
}
