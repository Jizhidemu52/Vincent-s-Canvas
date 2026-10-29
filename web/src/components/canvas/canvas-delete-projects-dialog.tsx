import { useUiText } from "@/lib/i18n";
import { useRef, useState } from "react";
import { App, Button, Modal } from "antd";

import { useAssetStore } from "@/stores/use-asset-store";
import { loadCanvasProject, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { mapCanvasAsyncPool } from "@/lib/canvas/canvas-async-pool";

export function CanvasDeleteProjectsDialog() {
    const t = useUiText();
    const { message } = App.useApp();
    const [deleting, setDeleting] = useState(false);
    const deleteLock = useRef(false);
    const ids = useCanvasUiStore((state) => state.deleteProjectIds);
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
        } catch (error) { void message.error(error instanceof Error ? error.message : t("删除失败，请重试。")); }
        finally { deleteLock.current = false; setDeleting(false); }
    };

    return (
        <Modal
            title={t("删除画布？")}
            open={ids.length > 0}
            centered
            onCancel={() => { if (!deleting) setDeleteIds([]); }}
            closable={!deleting}
            maskClosable={!deleting}
            footer={
                <>
                    <Button disabled={deleting} onClick={() => setDeleteIds([])}>{t("取消")}</Button>
                    <Button loading={deleting} danger type="primary" onClick={() => void confirm()}>
                        {t("删除")}</Button>
                </>
            }
        >
            <p className="text-sm text-stone-500">{t("将删除")}{ids.length} {t(" 个画布，里面的节点和连线也会一起移除。")}</p>
        </Modal>
    );
}
