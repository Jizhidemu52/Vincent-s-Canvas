import { displayNotice } from "@/hooks/use-display-text";
import { useUiText } from "@/lib/i18n";
import { useMemo, useRef, useState } from "react";
import { App, Button, Modal } from "antd";

import { useAssetStore } from "@/stores/use-asset-store";
import { loadCanvasProject, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { mapCanvasAsyncPool } from "@/lib/canvas/canvas-async-pool";
import { canvasLibrarySummaries } from "@/lib/canvas/canvas-project-summary";
import { useCanvasExport } from "@/hooks/use-canvas-export";

export function CanvasDeleteProjectsDialog() {
    const t = useUiText();
    const { message } = App.useApp();
    const [deleting, setDeleting] = useState(false);
    const deleteLock = useRef(false);
    const ids = useCanvasUiStore((state) => state.deleteProjectIds);
    const projects = useCanvasStore(state => state.projects);
    const unloaded = useCanvasStore(state => state.unloadedProjects);
    const names = useMemo(() => {
        const summaries = new Map(canvasLibrarySummaries(projects, unloaded).map(project => [project.id, project.title]));
        return ids.map(id => summaries.get(id) || t("未命名画布"));
    }, [projects, unloaded, ids, t]);
    const exportProjects = useCanvasExport();
    const exporting = useCanvasUiStore(state => state.exportingProjectIds.length > 0);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const removeSelectedIds = useCanvasUiStore((state) => state.removeSelectedProjectIds);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const cleanupImages = useAssetStore((state) => state.cleanupImages);
    const confirm = async () => {
        if (deleteLock.current) return;
        deleteLock.current = true;
        setDeleting(true);
        const targets = [...ids];
        try {
            // Unopened cloud summaries need their revision loaded before the
            // existing conditional-delete path can safely create tombstones.
            await mapCanvasAsyncPool(targets, 4, id => loadCanvasProject(id));
            deleteProjects(targets);
            cleanupImages();
            removeSelectedIds(targets);
            setDeleteIds([]);
        } catch (error) { void message.error(displayNotice(error instanceof Error ? error.message : t("删除失败，请重试。"))); }
        finally { deleteLock.current = false; setDeleting(false); }
    };

    return (
        <Modal
            title={t("删除画布？")}
            open={ids.length > 0}
            centered
            onCancel={() => { if (!deleting) setDeleteIds([]); }}
            closable={!deleting}
            mask={{ closable: !deleting }}
            footer={
                <>
                    <Button loading={exporting} disabled={deleting} onClick={() => void exportProjects(ids, t("删除前画布备份"))}>{t("先导出备份")}</Button>
                    <Button disabled={deleting} onClick={() => setDeleteIds([])}>{t("取消")}</Button>
                    <Button loading={deleting} danger type="primary" onClick={() => void confirm()}>
                        {t("删除")}</Button>
                </>
            }
        >
            <p className="text-sm">{t("将删除 {count} 个画布：", { count: ids.length })}</p>
            <ul className="my-3 max-h-48 list-disc overflow-y-auto pl-5 text-sm">{names.map((name, index) => <li key={ids[index]} className="break-words">{name}</li>)}</ul>
            <p className="text-sm text-muted-foreground">{t("其中的图片节点、连线和对话将一起移除；已同步的云端画布也会删除。此操作不可撤销，建议先导出备份。素材库及其他画布引用的原件不会删除。")}</p>
        </Modal>
    );
}
