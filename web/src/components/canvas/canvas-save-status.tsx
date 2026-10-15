import { flushCanvasCloudPersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { CloudCheck, HardDrive, LoaderCircle, TriangleAlert } from "lucide-react";
import { Tooltip } from "antd";

export const canvasLinkCopiedMessage = {
    cloud: "已复制画布链接；同步完成后，可在另一设备用同一员工账号打开（非公开分享）。",
    local: "已复制当前画布链接；本地画布需在同一浏览器打开，跨设备请从菜单导出画布文件。",
};

export function CanvasSaveStatus({ compact = false }: { compact?: boolean } = {}) {
    const status = useCanvasStore(state => state.cloudStatus);
    const error = useCanvasStore(state => state.cloudError);
    const labels = { local: "保存在当前浏览器", loading: "正在恢复服务器画布…", pending: "仅本机缓存 · 等待服务器保存", syncing: "仅本机缓存 · 正在保存图片和画布…", synced: "画布与图片已保存至服务器", error: "服务器保存失败 · 点击重试", "local-error": "本机保存失败 · 点击重试，或导出备份" };
    const description = status === "local" || status === "local-error"
        ? "图片、节点位置、连线、对话和最近 50 步撤销/重做记录保存在当前浏览器；关闭后用同一浏览器、同一地址重新打开即可恢复。清理浏览器数据或更换设备前，请导出画布备份。"
        : status === "synced"
            ? "服务器已保存原图、节点位置、连线、画布对话和最近 50 步撤销/重做记录；从公司 OA 用同一员工身份进入可恢复。"
            : "当前只有本机临时恢复缓存，尚未确认服务器保存成功。请等待完成；失败时重试或导出备份。";
    const failed = status === "error" || status === "local-error";
    if (!compact) return <button type="button" data-testid="canvas-save-status" className="text-xs opacity-70 hover:opacity-100 disabled:cursor-default" disabled={!failed} title={error || description} onClick={() => void flushCanvasCloudPersistence().catch(() => undefined)}>{labels[status]}</button>;
    const Icon = failed ? TriangleAlert : status === "local" ? HardDrive : status === "synced" ? CloudCheck : LoaderCircle;
    return <Tooltip title={<><strong>{labels[status]}</strong><br />{error || description}</>} placement="bottom">
        <button type="button" data-testid="canvas-save-status" className={compact ? `cw-save-status ${failed ? "is-error" : ""}` : "text-xs opacity-70 hover:opacity-100"} aria-label={labels[status]} onClick={failed ? () => void flushCanvasCloudPersistence().catch(() => undefined) : undefined}>
            {compact ? <><Icon size={14} className={Icon === LoaderCircle ? "animate-spin" : undefined} />{failed ? <span>保存失败 · 重试</span> : null}</> : labels[status]}
        </button>
    </Tooltip>;
}
