import { getUiLocale, uiText } from "@/lib/i18n";

/** Presentation only: reference insertion and request tokens keep the original label. */
export function canvasResourceDisplayLabel(label: string): string {
    const match = getUiLocale() === "en-US" && /^(图|图片|视频|音频|文本)([1-9]\d*)$/.exec(label);
    return match ? `${uiText(match[1]).trim()} ${match[2]}` : label;
}
