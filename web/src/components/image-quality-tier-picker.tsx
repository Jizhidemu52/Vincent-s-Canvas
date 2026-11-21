import { Segmented } from "antd";
import { useUiText } from "@/lib/i18n";
import { availableQualityTiers, currentQualityTier, qualityTierPatch } from "@/lib/image-quality-tier";

export function ImageQualityTierPicker({ profile, quality, imageOptions, disabled, onChange }: {
    profile: Parameters<typeof availableQualityTiers>[0]; quality: string; imageOptions?: string; disabled?: boolean;
    onChange: (patch: ReturnType<typeof qualityTierPatch>) => void;
}) {
    const t = useUiText();
    const tiers = availableQualityTiers(profile);
    if (!tiers.length) return null;
    let current;
    try { current = currentQualityTier(quality, imageOptions); } catch { return null; }
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
