import { Dropdown, Tooltip } from "antd";
import { Columns2, LayoutGrid, PanelsTopLeft, Shapes } from "lucide-react";
import { canvasArrangeOptions, type CanvasArrangeMode } from "@/lib/canvas/canvas-node-arrange";
import "./canvas-toolbar.css";

export function CanvasDesignActions({ selectedCount, selectedImages, onCompare, onTemplate, onArrange }: { selectedCount: number; selectedImages: number; onCompare: () => void; onTemplate: () => void; onArrange: (mode: CanvasArrangeMode) => void }) {
    return <Dropdown trigger={["click"]} placement="topRight" classNames={{ root: "cw-tool-menu" }} menu={{ items: [
        { key: "compare", disabled: selectedImages < 2, icon: <Columns2 className="size-4" />, label: <span data-usage-control="canvas-tool.compare">改款前后对比</span>, title: selectedImages < 2 ? "选择至少两张图片后使用" : "滑块、并排、叠加及 PNG 对比图", onClick: onCompare },
        { key: "template", disabled: selectedCount > 0, icon: <PanelsTopLeft className="size-4" />, label: <span data-usage-control="canvas-tool.template">整套服装画布模板</span>, title: selectedCount ? "取消选择后创建整套模板" : "创建参考图节点和 3 个可生成配置", onClick: onTemplate },
        { type: "divider" },
        { key: "arrange", icon: <LayoutGrid className="size-4" />, label: <span data-usage-control="canvas-tool.arrange">自动整理排版</span>, title: `${selectedCount ? "移动所选节点及所属款式组" : "整理整个画布"}，不改变组内布局`, children: canvasArrangeOptions.map(option => ({ ...option, onClick: () => onArrange(option.key) })) },
    ] }}><Tooltip title="设计工具 · 对比、模板与排版"><button className="cw-icon" type="button" data-usage-control="canvas-tool.design-tools" aria-label="设计工具" aria-haspopup="menu"><Shapes className="size-4" /></button></Tooltip></Dropdown>;
}
