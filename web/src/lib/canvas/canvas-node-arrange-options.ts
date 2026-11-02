export type CanvasArrangeMode = "grid" | "horizontal" | "vertical" | "right" | "bottom" | "center-x" | "center-y" | "row" | "column" | "distribute-x" | "distribute-y";

/** Labels are needed by the selection toolbar; the arrangement algorithm is not. */
export const canvasArrangeOptions: { key: CanvasArrangeMode; label: string }[] = [
    { key: "grid", label: "网格整理 · 保留款式组" },
    { key: "horizontal", label: "横向对齐 · 顶部对齐" },
    { key: "vertical", label: "纵向对齐 · 左侧对齐" },
    { key: "right", label: "右侧对齐" },
    { key: "bottom", label: "底部对齐" },
    { key: "center-x", label: "水平居中" },
    { key: "center-y", label: "垂直居中" },
    { key: "row", label: "排成一行" },
    { key: "column", label: "排成一列" },
    { key: "distribute-x", label: "横向等距 · 不重叠" },
    { key: "distribute-y", label: "纵向等距 · 不重叠" },
];
