import { Segmented } from "antd";
import { useUiText } from "@/lib/i18n";
import { availableQualityTiers, currentQualityTier, qualityTierPatch } from "@/lib/image-quality-tier";
import { imageOutputIsGif, type imageModelProfile } from "@/lib/image-model-settings";

export function ImageQualityTierPicker({ profile, size, quality, imageOptions, referenceCount, disabled, onChange }: {
    profile: ReturnType<typeof imageModelProfile>; size: string; quality: string; imageOptions?: string; referenceCount: number; disabled?: boolean;
    onChange: (patch: ReturnType<typeof qualityTierPatch>) => void;
}) {
    const t = useUiText();
    const tiers = availableQualityTiers(profile);
    if (!tiers.length) return null;
    let current;
    try { current = currentQualityTier(quality, imageOptions); } catch { return null; }
    const locked = profile.kind === "grok-image" && referenceCount > 0 ? t("参考图模式不提交图片质量；移除全部参考图后恢复设置。")
        : imageOutputIsGif(imageOptions, profile) ? t("GIF 使用单帧像素尺寸，不使用比例或分辨率档位。")
        : /^[1-9]\d*x[1-9]\d*$/i.test(size) ? t("精确像素 {size} 优先于分辨率档位；改选宽高比或自动后启用。", { size: size.replace(/x/i, " × ") }) : "";
    if (locked) return <p role="status" className="mb-2 text-xs">{locked}</p>;
    const preset = tiers.some(tier => tier.id === current);
    const options: { value: string; label: string; disabled?: boolean }[] = tiers.map(tier => ({ value: tier.id, label: t(tier.label) }));
    if (!preset) options.push({ value: "custom", label: t("自定义"), disabled: true });
    return <div role="group" aria-label={t("图片质量")} className="mb-2 flex cursor-default flex-wrap items-center gap-2 text-xs"
        onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}>
        <span>{t("图片质量")}</span><Segmented size="small" disabled={disabled} value={preset ? current : "custom"} options={options} onChange={value => {
            const tier = tiers.find(tier => tier.id === value);
            if (tier) onChange(qualityTierPatch(tier, imageOptions));
        }} />
    </div>;
}
