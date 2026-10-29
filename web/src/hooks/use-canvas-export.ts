import { uiText, useUiLocale } from "@/lib/i18n";
import { useCallback } from "react";
import { App } from "antd";
import { loadCanvasProject, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { loadCanvasExport } from "@/lib/canvas/canvas-export-loader";
import { mapCanvasAsyncPool } from "@/lib/canvas/canvas-async-pool";

/** All archive entry points share a lock, progress feedback and failure cleanup. */
export function useCanvasExport() {
    useUiLocale();
    const { message } = App.useApp();
    return useCallback(async (ids: string[], fileName: string, snapshots: CanvasProject[] = []) => {
        const ui = useCanvasUiStore.getState();
        if (!ui.beginExport(ids)) return false;
        const key = "canvas-archive-export";
        const progress = (content: string) => { void message.open({ key, type: "loading", content, duration: 0 }); };
        progress(uiText("正在准备画布备份…"));
        try {
            const projects = await mapCanvasAsyncPool(ids, 4, async id => {
                const project = snapshots.find(item => item.id === id) || await loadCanvasProject(id);
                if (!project) throw new Error(uiText("画布已不存在，未生成不完整的备份"));
                return project;
            });
            const { exportCanvasProjects } = await loadCanvasExport();
            await exportCanvasProjects(projects, fileName, { onProgress: value => {
                if (value.phase !== "complete") progress(`${value.label}${value.total ? ` (${value.completed}/${value.total})` : ""}`);
            } });
            void message.success({ key, content: uiText("画布备份已生成"), duration: 3 });
            return true;
        } catch (error) {
            void message.error({ key, content: error instanceof Error ? error.message : uiText("画布导出失败，请重试。"), duration: 5 });
            return false;
        } finally { ui.endExport(); }
    }, [message]);
}
