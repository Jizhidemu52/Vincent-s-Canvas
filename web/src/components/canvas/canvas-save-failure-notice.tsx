import { useUiText, uiText } from "@/lib/i18n";
import { useEffect, useRef } from "react";
import { App, Button } from "antd";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

/** Page-only warning, never a browser/system notification. */
export function CanvasSaveFailureNotice({ onExport }: { onExport: () => Promise<unknown> }) {
    const t = useUiText();
    const { notification } = App.useApp();
    const incident = useCanvasStore(state => state.localSaveFailureId);
    const notified = useRef(0);
    const exportAction = useRef(onExport);
    exportAction.current = onExport;
    useEffect(() => {
        const key = "canvas-save-failure";
        if (!incident) { notification.destroy(key); return; }
        if (notified.current === incident) return;
        notified.current = incident;
        notification.error({ key, title: uiText("画布连续保存失败，请立即备份"), description: uiText("修改仍在当前页面内存中，但尚未安全写入本机。请先导出备份，暂时不要关闭或刷新页面。"), duration: 0,
            actions: <Button type="primary" onClick={() => void exportAction.current()}>{uiText("立即导出备份")}</Button> });
    }, [incident, notification]);
    useEffect(() => () => notification.destroy("canvas-save-failure"), [notification]);
    return null;
}
