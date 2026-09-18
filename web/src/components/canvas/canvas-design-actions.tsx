import { Dropdown, Tooltip } from "antd";
import { Columns2, LayoutGrid, PanelsTopLeft } from "lucide-react";
import { canvasArrangeOptions, type CanvasArrangeMode } from "@/lib/canvas/canvas-node-arrange";

export function CanvasDesignActions({ selectedCount, selectedImages, onCompare, onTemplate, onArrange }: { selectedCount: number; selectedImages: number; onCompare: () => void; onTemplate: () => void; onArrange: (mode: CanvasArrangeMode) => void }) {
    return <>
        {selectedImages >= 2 ? <Tooltip title="改款前后对比 · 得到滑块、并排、叠加及 PNG 对比图"><button className="cw-icon" type="button" aria-label="改款前后对比" onClick={onCompare}><Columns2 className="size-4" /></button></Tooltip> : null}
        {!selectedCount ? <Tooltip title="服装模板 · 得到参考图节点和 3 个可生成配置"><button className="cw-icon" type="button" aria-label="整套服装画布模板" onClick={onTemplate}><PanelsTopLeft className="size-4" /></button></Tooltip> : null}
        <Dropdown trigger={["click"]} menu={{ items: canvasArrangeOptions.map(option => ({ ...option, onClick: () => onArrange(option.key) })) }}><Tooltip title={`自动整理 · ${selectedCount ? "移动所选节点及所属款式组" : "整理整个画布"}，不改变组内布局`}><button className="cw-icon" type="button" aria-label="自动整理排版"><LayoutGrid className="size-4" /></button></Tooltip></Dropdown>
    </>;
}
