import { uiText } from "@/lib/i18n";
import { useModelIntentAdapter } from "@/lib/canvas/model-intent-adapter";
import { Button, Slider } from "antd";
import { Palette, Layers, GitBranch } from "lucide-react";
import { useState } from "react";

export function MinimalActionPanel({ sceneId, onAction, modelId }: {
    sceneId: string;
    onAction: (intent: string, params: any) => void;
    modelId: string;
}) {
    const [strength, setStrength] = useState(0.5);
    const adapter = useModelIntentAdapter(modelId);

    const handleIntent = (intent: string, pipeline: "fast" | "refined" | "refined_ultra" = "fast") => {
        const params = adapter.mapIntentToParams(intent as any, { pipeline });
        onAction(intent, params);
    };

    return (
        <div className="minimal-panel flex flex-col gap-4 p-4">
            {/* 极简语义指令区：支持单击(快速)与右键(高质量) */}
            <div className="minimal-actions grid grid-cols-3 gap-2">
                <Button icon={<Palette size={16} />}
                        onClick={() => handleIntent("recolor", "fast")}
                        onContextMenu={(e) => { e.preventDefault(); handleIntent("recolor", "refined_ultra"); }}>
                    配色
                </Button>
                <Button icon={<Layers size={16} />}
                        onClick={() => handleIntent("restyle", "fast")}
                        onContextMenu={(e) => { e.preventDefault(); handleIntent("restyle", "refined_ultra"); }}>
                    重绘
                </Button>
                <Button icon={<GitBranch size={16} />}
                        onClick={() => handleIntent("modify-structure", "fast")}
                        onContextMenu={(e) => { e.preventDefault(); handleIntent("modify-structure", "refined_ultra"); }}>
                    结构
                </Button>
            </div>

            <div className="text-[11px] opacity-60 italic leading-tight">
                * 左键点击快速预览，右键点击生成极致画质。
            </div>
        </div>
    );
}
