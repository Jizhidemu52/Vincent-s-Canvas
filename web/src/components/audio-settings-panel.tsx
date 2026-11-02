import { uiText, useUiLocale } from "@/lib/i18n";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { audioFormatOptions, audioSpeedLabel, audioVoiceLabel, audioVoiceOptions, audioVoiceSampleUrl, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { type CanvasTheme } from "@/lib/canvas-theme";
import type { AiConfig } from "@/stores/use-config-store";

const speedOptions = ["0.75", "1", "1.25", "1.5"];

type AudioSettingKey = "audioVoice" | "audioFormat" | "audioSpeed" | "audioInstructions";

type AudioSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: AudioSettingKey, value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function AudioSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: AudioSettingsPanelProps) {
    useUiLocale();
    const voice = normalizeAudioVoiceValue(config.audioVoice);
    const format = normalizeAudioFormatValue(config.audioFormat);
    const speed = normalizeAudioSpeedValue(config.audioSpeed);
    const audio = useRef<HTMLAudioElement>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [preview, setPreview] = useState<"idle" | "loading" | "playing" | "error">("idle");
    const sample = audioVoiceSampleUrl(voice);
    const stopPreview = useCallback(() => {
        clearTimeout(timer.current); timer.current = undefined;
        if (audio.current) { audio.current.pause(); audio.current.removeAttribute("src"); audio.current.load(); }
    }, []);
    useEffect(() => { stopPreview(); setPreview("idle"); return stopPreview; }, [voice, stopPreview]);
    const playPreview = () => {
        if (!sample || !audio.current) return;
        if (preview === "playing" || preview === "loading") { stopPreview(); setPreview("idle"); return; }
        const player = audio.current;
        player.src = sample; player.currentTime = 0; setPreview("loading");
        void player.play().catch(() => { if (player.getAttribute("src") === sample) { stopPreview(); setPreview("error"); } });
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{uiText("音频设置")}</div> : null}
                <SettingGroup title={uiText("声音")} color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {audioVoiceOptions.map((item) => (
                            <OptionPill key={item.value} selected={voice === item.value} theme={theme} onClick={() => onConfigChange("audioVoice", item.value)}>
                                <span className="block text-xs leading-4">{item.chineseLabel}<span className="ml-1 opacity-70">{item.label}</span></span>
                            </OptionPill>
                        ))}
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                        <button type="button" disabled={!sample} onClick={playPreview} className="rounded-lg border px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50" style={{ borderColor: theme.node.stroke }} aria-label={`${preview === "playing" || preview === "loading" ? "停止试听" : "试听 3 秒"} ${audioVoiceLabel(voice)}`}>
                            {preview === "playing" ? "停止试听" : preview === "loading" ? "正在加载 · 停止" : "试听 3 秒"}
                        </button>
                        <span role="status" style={{ color: theme.node.muted }}>{!sample ? "此音色暂无内置样例" : preview === "error" ? "样例加载失败，可重试或打开官方演示" : preview === "playing" ? "3 秒后自动停止" : "官方样例 · 不生成任务"}</span>
                    </div>
                    <audio ref={audio} preload="none" className="hidden" aria-label="音色官方样例" onPlaying={() => { clearTimeout(timer.current); setPreview("playing"); timer.current = setTimeout(() => { stopPreview(); setPreview("idle"); }, 3000); }} onTimeUpdate={() => { if ((audio.current?.currentTime || 0) >= 3) { stopPreview(); setPreview("idle"); } }} onEnded={() => { stopPreview(); setPreview("idle"); }} onError={() => { if (audio.current?.getAttribute("src")) { stopPreview(); setPreview("error"); } }} />
                    <p className="text-xs leading-5" style={{ color: theme.node.muted }}>试听为 AI 生成的官方英语样例，不代表当前通道或中文效果；只在点击时加载，不提交本项目任务。中文为音色识别名。<a href="https://www.openai.fm/" target="_blank" rel="noopener noreferrer" className="underline">打开官方音色演示</a></p>
                </SettingGroup>
                <SettingGroup title={uiText("格式")} color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {audioFormatOptions.map((item) => (
                            <OptionPill key={item.value} selected={format === item.value} theme={theme} onClick={() => onConfigChange("audioFormat", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title={uiText("语速")} color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {speedOptions.map((value) => (
                            <OptionPill key={value} selected={speed === value} theme={theme} onClick={() => onConfigChange("audioSpeed", value)}>
                                {audioSpeedLabel(value)}
                            </OptionPill>
                        ))}
                    </div>
                    <input
                        type="number"
                        min={0.25}
                        max={4}
                        step={0.05}
                        className="h-9 w-full rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                        value={config.audioSpeed || "1"}
                        onChange={(event) => onConfigChange("audioSpeed", event.target.value)}
                        onBlur={(event) => onConfigChange("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                        onMouseDown={(event) => event.stopPropagation()}
                    />
                </SettingGroup>
                <SettingGroup title={uiText("声音指令")} color={theme.node.muted}>
                    <textarea
                        value={config.audioInstructions || ""}
                        placeholder={uiText("例如：自然、温暖、适合旁白。")}
                        className="thin-scrollbar h-20 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                        onChange={(event) => onConfigChange("audioInstructions", event.target.value)}
                        onMouseDown={(event) => event.stopPropagation()}
                    />
                </SettingGroup>
            </div>
        </ImageSettingsTheme>
    );
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    useUiLocale();
    return (
        <button type="button" className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    useUiLocale();
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}
