import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { buildCreativePresetHref, creativePresetGroups, creativePresets } from "@/lib/creative-presets";
import { useModuleStore } from "@/stores/use-module-store";
import { sceneSummaries } from "./scene-form-model";
import "./creative.css";

export default function CreativePage() {
    const flags = useModuleStore((state) => state.flags);
    const presets = creativePresets.filter((preset) => flags[preset.tool === "image-generation" ? "image" : "image-edit"]);

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
                                <img src={`/creative-scenes/v2/${preset.id}.png`} alt={`${sceneSummaries[preset.id]?.input} → ${sceneSummaries[preset.id]?.output}的功能示意`} loading="lazy" />
                                <div className="creative-cover-flow" aria-hidden="true"><span>{sceneSummaries[preset.id]?.input}</span><ArrowRight size={15} /><span>{sceneSummaries[preset.id]?.output}</span></div>
                            </div>
                            <div className="creative-card-copy"><h3>{preset.title}<ArrowRight size={16} strokeWidth={1.5} /></h3><p>{preset.description}</p></div>
                        </Link>)}
                    </div>
                </section> : null;
            })}
            {!presets.length ? <div className="wb-empty"><strong>暂无可用的设计场景</strong><p>图片生成或图片编辑功能启用后，相关场景会显示在这里。</p></div> : <p className="creative-note">封面为 AI 制作的功能示意，不是模型实测结果。进入后按场景填写，点击生成才会提交任务。</p>}
        </div>
    </main>;
}
