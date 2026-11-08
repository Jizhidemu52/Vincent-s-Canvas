import { uiText, useUiText } from "@/lib/i18n";
import { ArrowRight, Pin, PinOff } from "lucide-react";
import { Link } from "react-router-dom";
import { buildCreativePresetHref, creativePresetGroups, creativePresets } from "@/lib/creative-presets";
import { isModuleAvailable, useModuleStore } from "@/stores/use-module-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import type { ModuleKey } from "@/services/api/modules";
import { sceneSummaries } from "./scene-form-model";
import { useNavigationPreferences } from "@/hooks/use-navigation-preferences";
import "./creative.css";

const workbenches = [
    { key: "pattern-placement", title: "图案定位", description: "把图案放到产品指定位置，调整大小和角度，再生成 AI 效果图。", mode: "图案定位 · AI 效果图" },
    { key: "pattern-repeat", title: "花型循环", description: "直排、半落与镜像循环，按物理尺寸设置画布，导出花型与完整工程。", mode: "本地编辑 · 无需 API" },
    { key: "series-recipe", title: "系列配方", description: "组合参考、配色和设计约束，冻结配方后生成系列候选，分支重试与保存。", mode: "AI 生成 · 独立模型配置" },
] as const;

const inputCovers: Record<string, { src: string; label: string }> = {
    "virtual-try-on": { src: "/design-examples/knit-source.webp", label: "输入示意 · 毛衫产品图" },
    "sketch-to-photo": { src: "/design-examples/knit-sketch.webp", label: "输入示意 · 毛衫结构线稿" },
};

export default function CreativePage() {
    useUiText();
    const flags = useModuleStore((state) => state.flags);
    const tools = useBusinessConfigStore(state => state.tools);
    const { pinned, togglePin } = useNavigationPreferences();
    const presets = creativePresets.filter((preset) => isModuleAvailable(flags, tools, `creative-${preset.id}` as ModuleKey));
    const availableWorkbenches = workbenches.filter(item => isModuleAvailable(flags, tools, item.key));
    const pinButton = (key: string, title: string) => {
        const isPinned = pinned.includes(key);
        const Icon = isPinned ? PinOff : Pin;
        return <button type="button" className="m-3 mt-0 inline-flex min-h-8 items-center justify-center gap-1.5 self-end rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2" aria-label={uiText(isPinned ? "取消固定{label}" : "固定{label}", { label: uiText(title) })} aria-pressed={isPinned} onClick={() => togglePin(key)}><Icon size={14} />{uiText(isPinned ? "取消固定" : "固定到导航顶部")}</button>;
    };

    return <main className="wb-page creative-page h-full overflow-y-auto">
        <div className="creative-content">
            <header className="wb-header">
                <div><h1 className="wb-title">{uiText("创意设计")}</h1><p className="wb-description">{uiText("从一个想法、一张款式图开始。每种设计，都有自己的工作台。")}</p></div>
            </header>
            {creativePresetGroups.map((group) => {
                const items = presets.filter((preset) => preset.group === group.id);
                return items.length ? <section className="creative-section" key={group.id} aria-labelledby={`creative-${group.id}`}>
                    <h2 id={`creative-${group.id}`}>{uiText(group.title || "")}<span>{String(items.length).padStart(2, "0")}</span></h2>
                    <div className="creative-grid">
                        {items.map((preset) => <article key={preset.id} className="creative-card flex flex-col">
                            <Link to={buildCreativePresetHref(preset)} className="block flex-1 text-inherit no-underline">
                            <div className={`creative-cover${inputCovers[preset.id] ? " creative-input-cover" : ""}`}>
                                <img src={inputCovers[preset.id]?.src ?? `/creative-scenes/v2/${preset.id}.preview.webp`} alt={inputCovers[preset.id] ? uiText(inputCovers[preset.id].label) : uiText("{input} → {output}的功能示意", { input: uiText(sceneSummaries[preset.id]?.input || ""), output: uiText(sceneSummaries[preset.id]?.output || "") })} loading="lazy" decoding="async" />
                                <div className="creative-cover-flow" aria-hidden="true">{inputCovers[preset.id] ? <span>{uiText(inputCovers[preset.id].label)}</span> : <><span>{uiText(sceneSummaries[preset.id]?.input || "")}</span><ArrowRight size={15} /><span>{uiText(sceneSummaries[preset.id]?.output || "")}</span></>}</div>
                            </div>
                            <div className="creative-card-copy"><h3>{uiText(preset.title || "")}<ArrowRight size={16} strokeWidth={1.5} /></h3><p>{uiText(preset.description || "")}</p></div>
                            </Link>
                            {pinButton(`creative-${preset.id}`, preset.title)}
                        </article>)}
                    </div>
                </section> : null;
            })}
            {availableWorkbenches.length ? <section className="creative-section" aria-labelledby="creative-workbenches">
                <h2 id="creative-workbenches">{uiText("设计工作台")}<span>{String(availableWorkbenches.length).padStart(2, "0")}</span></h2>
                <div className="creative-grid">{availableWorkbenches.map(item => <article key={item.key} className="creative-card flex flex-col"><Link to={`/creative/${item.key}`} className="block flex-1 text-inherit no-underline">
                    <div className="creative-card-copy"><p>{uiText(item.mode || "")}</p><h3>{uiText(item.title || "")}<ArrowRight size={16} strokeWidth={1.5} /></h3><p>{uiText(item.description || "")}</p></div>
                </Link>{pinButton(item.key, item.title)}</article>)}</div>
            </section> : null}
            {!presets.length && !availableWorkbenches.length ? <div className="wb-empty"><strong>{uiText("暂无可用的设计场景")}</strong><p>{uiText("管理员启用对应创意板块后，场景会显示在这里。")}</p></div> : null}
        </div>
    </main>;
}
