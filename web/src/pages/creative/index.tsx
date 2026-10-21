import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { buildCreativePresetHref, creativePresetGroups, creativePresets } from "@/lib/creative-presets";
import { isModuleAvailable, useModuleStore } from "@/stores/use-module-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import type { ModuleKey } from "@/services/api/modules";
import { sceneSummaries } from "./scene-form-model";
import { SceneIllustration } from "./scene-illustration";
import "./creative.css";

const workbenches = [
    { key: "pattern-placement", title: "图案定位", description: "把图案放到指定产品位置，调整比例、图层和构图，保存工程或导出合成图。", mode: "本地编辑 · 无需 API" },
    { key: "pattern-repeat", title: "花型循环", description: "直排、半落与镜像循环，按物理尺寸设置画布，导出花型与完整工程。", mode: "本地编辑 · 无需 API" },
    { key: "series-recipe", title: "系列配方", description: "组合参考、配色和设计约束，冻结配方后生成系列候选，分支重试与保存。", mode: "AI 生成 · 独立模型配置" },
] as const;

export default function CreativePage() {
    const flags = useModuleStore((state) => state.flags);
    const tools = useBusinessConfigStore(state => state.tools);
    const presets = creativePresets.filter((preset) => isModuleAvailable(flags, tools, `creative-${preset.id}` as ModuleKey));
    const availableWorkbenches = workbenches.filter(item => isModuleAvailable(flags, tools, item.key));

    return <main className="wb-page creative-page h-full overflow-y-auto">
        <div className="creative-content">
            <header className="wb-header">
                <div><h1 className="wb-title">创意设计</h1><p className="wb-description">从一个想法、一张款式图开始。每种设计，都有自己的工作台。</p></div>
            </header>
            {creativePresetGroups.map((group) => {
                const items = presets.filter((preset) => preset.group === group.id);
                return items.length ? <section className="creative-section" key={group.id} aria-labelledby={`creative-${group.id}`}>
                    <h2 id={`creative-${group.id}`}>{group.title}<span>{String(items.length).padStart(2, "0")}</span></h2>
                    <div className="creative-grid">
                        {items.map((preset) => <Link key={preset.id} to={buildCreativePresetHref(preset)} className="creative-card">
                            <div className="creative-cover">
                                <SceneIllustration id={preset.id} title={preset.title} />
                                <div className="creative-cover-flow" aria-hidden="true"><span>{sceneSummaries[preset.id]?.input}</span><ArrowRight size={15} /><span>{sceneSummaries[preset.id]?.output}</span></div>
                            </div>
                            <div className="creative-card-copy"><h3>{preset.title}<ArrowRight size={16} strokeWidth={1.5} /></h3><p>{preset.description}</p></div>
                        </Link>)}
                    </div>
                </section> : null;
            })}
            {availableWorkbenches.length ? <section className="creative-section" aria-labelledby="creative-workbenches">
                <h2 id="creative-workbenches">设计工作台<span>{String(availableWorkbenches.length).padStart(2, "0")}</span></h2>
                <div className="creative-grid">{availableWorkbenches.map(item => <Link key={item.key} to={`/creative/${item.key}`} className="creative-card">
                    <div className="creative-card-copy"><p>{item.mode}</p><h3>{item.title}<ArrowRight size={16} strokeWidth={1.5} /></h3><p>{item.description}</p></div>
                </Link>)}</div>
            </section> : null}
            {!presets.length && !availableWorkbenches.length ? <div className="wb-empty"><strong>暂无可用的设计场景</strong><p>管理员启用对应创意板块后，场景会显示在这里。</p></div> : <p className="creative-note">场景封面为功能示意，不代表模型实测结果。AI 工作台点击生成才会提交任务，本地工作台不调用模型。</p>}
        </div>
    </main>;
}
