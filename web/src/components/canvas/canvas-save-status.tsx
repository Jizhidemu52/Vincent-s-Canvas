import { flushCanvasCloudPersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";

export const canvasLinkCopiedMessage = {
    cloud: "已复制画布链接；同步完成后，可在另一设备用同一员工账号打开（非公开分享）。",
    local: "已复制当前画布链接；本地画布需在同一浏览器打开，跨设备请从菜单导出画布文件。",
};

export function CanvasSaveStatus() {
    const status = useCanvasStore(state => state.cloudStatus);
    const error = useCanvasStore(state => state.cloudError);
    const labels = { local: "保存在当前浏览器", loading: "正在恢复云端画布…", pending: "已存本机 · 等待云同步", syncing: "已存本机 · 正在同步图片和画布…", synced: "整张画布已同步", error: "已存本机 · 云同步失败，点击重试", "local-error": "本机保存失败 · 点击重试，或导出备份" };
    return <button type="button" data-testid="canvas-save-status" className="text-xs opacity-70 hover:opacity-100 disabled:cursor-default" disabled={status !== "error" && status !== "local-error"} title={error || "云端包含图片、节点位置、连线、对话和最近 50 步撤销/重做记录"} onClick={() => void flushCanvasCloudPersistence().catch(() => undefined)}>{labels[status]}</button>;
}
