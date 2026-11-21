import { useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { canvasToolKey, useToolConfig, useToolEnabled } from "@/hooks/use-tool-config";
import { useUiText } from "@/lib/i18n";
import { imageModelProfile } from "@/lib/image-model-settings";
import { imageOptionFields } from "@/lib/image-advanced-settings";
import { availableQualityTiers, qualityTierPatch } from "@/lib/image-quality-tier";
import { hasCanvasImageSource } from "@/lib/canvas/canvas-image-source";
import { syncCanvasSelectionReferences } from "@/lib/canvas/canvas-selection-references";
import { useCanvasGraphStore } from "@/stores/canvas/canvas-graph-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasDockInput } from "@/pages/canvas/use-canvas-quick-generation";
import "./tryout-prompt-dock.css";

export default function TryoutPromptDock({ owner, onRun, onFocus, busy, hidden }: { owner: string; onRun: (i: CanvasDockInput) => Promise<void>; onFocus?: () => void; busy: boolean; hidden: boolean }) {
    const t = useUiText(),
        base = useEffectiveConfig("canvas"),
        key = "canvas:prompt-dock:v1:" + owner;
    const models = useBusinessConfigStore((s) => s.models);
    const selected = useCanvasGraphStore((s) => s.selectedNodeIds),
        target = useCanvasGraphStore((s) => (s.selectedNodeIds.size === 1 ? s.nodes.find((n) => s.selectedNodeIds.has(n.id)) : undefined));
    const source = target?.type === CanvasNodeType.Image && hasCanvasImageSource(target.metadata) && !target.metadata.locked && !["loading", "error"].includes(target.metadata.status ?? "") ? target : undefined;
    const tool = canvasToolKey("image", !!source),
        enabled = useToolEnabled(tool);
    const [prefs, setPrefs] = useState<{ size: string; tier: string }>(() => {
        try {
            const v = JSON.parse(localStorage.getItem(key) ?? "null");
            if (v && typeof v.size === "string" && typeof v.tier === "string") return { size: v.size, tier: v.tier };
        } catch {}
        return { size: "auto", tier: "standard" };
    });
    const [prompt, setPrompt] = useState(""),
        [pending, setPending] = useState(false),
        lock = useRef(false);
    const [more, setMore] = useState(false),
        [advanced, setAdvanced] = useState<{ scope: string; values: Record<string, string> }>({ scope: "", values: {} });
    const configured = useToolConfig({ ...base, model: base.imageModel || base.model }, tool),
        model = configured.model,
        profile = imageModelProfile(model, models),
        tiers = availableQualityTiers(profile);
    const scope = tool + ":" + model,
        values = advanced.scope === scope ? advanced.values : {};
    const fields = imageOptionFields(profile).filter((f) => ["background", "output_format"].includes(f.key) && f.options?.length);
    const tier = tiers.find((v) => v.id === prefs.tier) ?? tiers.find((v) => v.id === "standard") ?? tiers[0];
    const quality = profile.qualities.includes(prefs.tier) ? prefs.tier : profile.qualities.includes("medium") ? "medium" : profile.qualities[0]!;
    const qualityNames: Record<string, string> = { auto: "自动", low: "草稿", medium: "标准", high: "高清" };
    const size = profile.sizes.includes(prefs.size) ? prefs.size : profile.sizes.includes("auto") ? "auto" : profile.sizes[0]!;
    const sizes = more ? profile.sizes : profile.sizes.filter((s) => ["auto", "1:1", "3:4", "1024x1024", size].includes(s));
    const remember = (next: typeof prefs) => {
        setPrefs(next);
        try {
            localStorage.setItem(key, JSON.stringify(next));
        } catch {}
    };
    const reason = !enabled
        ? "当前账号未开放这项生成"
        : !model
          ? "当前工具没有可用模型"
          : selected.size > 1
            ? "请选择一张图片，或取消选择后生成新款"
            : selected.size && !source
              ? "当前所选节点没有可编辑原图"
              : !profile.requiresPrompt
                ? "当前模型不支持文字输入"
                : !prompt.trim()
                  ? "先写一句设计要求"
                  : pending || busy
                    ? "当前暂不可提交"
                    : "";
    const submit = async () => {
        if (reason || lock.current) return;
        lock.current = true;
        setPending(true);
        try {
            const references = source ? syncCanvasSelectionReferences([], new Set([source.id]), new Map([[source.id, source]])) : [];
            if (source && references.length !== 1) return;
            const imageOptions = JSON.stringify(Object.fromEntries(fields.flatMap((f) => (f.options?.includes(values[f.key]) ? [[f.key, values[f.key]]] : []))));
            const options = tier ? qualityTierPatch(tier, imageOptions) : { quality, imageOptions };
            await onRun({ source, references, prompt: prompt.trim(), size, ...options, model });
        } finally {
            lock.current = false;
            setPending(false);
        }
    };
    if (hidden) return null;
    return (
        <section className="tryout-prompt-dock" aria-label={t("试款输入条")} onFocusCapture={onFocus}>
            <div className="tpd-main">
                <span className="tpd-target" title={target?.title}>
                    {source ? t("改这件") + "：" + source.title : t(selected.size > 1 ? "已选多项" : selected.size ? "当前节点不可编辑" : "生成新产品")}
                </span>
                <input
                    aria-label={t("设计要求")}
                    placeholder={t(source ? "想怎么改这件产品？" : "描述你想生成的产品")}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
                        e.preventDefault();
                        e.stopPropagation();
                        void submit();
                    }}
                />
                <button className="tpd-go" type="button" disabled={Boolean(reason)} onClick={() => void submit()}>
                    <ArrowUp size={16} />
                    {t("生成 1 张")}
                </button>
            </div>
            <div className="tpd-settings">
                <label>
                    {t("大小")}
                    <select value={size} onChange={(e) => remember({ ...prefs, size: e.target.value })}>
                        {(sizes.length ? sizes : [size]).map((s) => (
                            <option key={s} value={s}>
                                {s === "auto" ? t(source ? "跟随原图" : "自动") : s}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    {t("质量")}
                    <select value={tier?.id ?? quality} onChange={(e) => remember({ ...prefs, tier: e.target.value })}>
                        {tier
                            ? tiers.map((v) => (
                                  <option key={v.id} value={v.id}>
                                      {t(v.label)}
                                  </option>
                              ))
                            : profile.qualities.map((v) => (
                                  <option key={v} value={v}>
                                      {t(qualityNames[v] ?? v)}
                                  </option>
                              ))}
                    </select>
                </label>
                <button type="button" className="tpd-more" aria-expanded={more} onClick={() => setMore(!more)}>
                    {t("更多设置")}
                </button>
                <span className="tpd-note">{t(reason || "回车生成")}</span>
            </div>
            {more && (
                <div className="tpd-settings">
                    <span>{t("每次生成 1 张")}</span>
                    {fields.map((f) => (
                        <label key={f.key}>
                            {t(f.label)}
                            <select value={values[f.key] ?? ""} onChange={(e) => setAdvanced({ scope, values: { ...values, [f.key]: e.target.value } })}>
                                <option value="">{t("默认")}</option>
                                {f.options!.map((v) => (
                                    <option key={v} value={v}>
                                        {v}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ))}
                </div>
            )}
        </section>
    );
}
