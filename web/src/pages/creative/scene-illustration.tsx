import { ArrowRight, Layers, PenTool, Shirt, Sparkles } from "lucide-react";
import { sceneSummaries } from "./scene-form-model";

const covers = new Set(["text-to-style", "style-to-sketch", "local-restyle", "garment-colorway", "back-design", "pattern-extract", "pattern-colorway", "accessory-design", "pattern-craft"]);

/** Original diagrams keep new features legible without implying generated examples. */
export function SceneIllustration({ id, title }: { id: string; title: string }) {
    const summary = sceneSummaries[id];
    if (covers.has(id)) return <img src={`/creative-scenes/v2/${id}.webp`} alt={`${title}的概念示意`} loading="lazy" decoding="async" />;
    const Icon = id.includes("vector") ? PenTool : id.includes("pattern") || id.includes("fabric") ? Layers : Shirt;
    return <div className="cs-diagram" aria-label={`${summary?.input || "素材"}转为${summary?.output || title}`}>
        <div className="cs-diagram-source"><Icon size={42} strokeWidth={1} /></div>
        <ArrowRight className="cs-diagram-arrow" size={24} strokeWidth={1} />
        <div className="cs-diagram-result"><Sparkles size={16} strokeWidth={1.3} /><Icon size={48} strokeWidth={1.3} /></div>
    </div>;
}
