import { useEffect, useRef } from "react";
import { App, Button } from "antd";
import { useNavigate } from "react-router-dom";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUiText } from "@/lib/i18n";

/** Copies are never silently merged over another editor's saved version. */
export function CanvasConflictNotice({ projectId }: { projectId: string }) {
    const t = useUiText();
    const { notification } = App.useApp();
    const navigate = useNavigate();
    const projects = useCanvasStore(state => state.projects);
    const seen = useRef(new Set<string>());
    useEffect(() => {
        for (const project of projects) {
            if (!project.persistenceConflict || project.persistenceConflict.projectId !== projectId || seen.current.has(project.id)) continue;
            seen.current.add(project.id);
            const key = `canvas-conflict-${project.id}`;
            notification.warning({ key, title: t("保存时发现另一版本"), description: t("已保留冲突副本，不会覆盖另一处的修改。请查看并选择要继续编辑的版本。"), duration: 0,
                actions: <Button onClick={() => { navigate(`/canvas/${project.id}`); notification.destroy(key); }}>{t("查看冲突副本")}</Button> });
        }
    }, [projects, projectId, notification, navigate, t]);
    return null;
}
