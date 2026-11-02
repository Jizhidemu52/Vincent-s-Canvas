import { useMemo } from "react";
import { Button, Modal } from "antd";
import { useUiText } from "@/lib/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasPersistedMediaPreview } from "./canvas-persisted-media-preview";

export function CanvasProjectCoverDialog({ project, onClose }: { project: CanvasProject; onClose: () => void }) {
    const t = useUiText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const images = useMemo(() => project.nodes.filter(node => node.type === "image" && node.metadata?.status !== "loading" && node.metadata?.status !== "error" && (node.metadata?.storageKey || node.metadata?.content)), [project]);
    const choose = (coverNodeId?: string) => { useCanvasStore.getState().updateProject(project.id, { coverNodeId }); onClose(); };
    return <Modal open title={t("选择画布封面")} width={720} onCancel={onClose} footer={<Button onClick={() => choose()}>{t("自动选择最新生成结果")}</Button>} destroyOnHidden>
        <p className="mb-4 text-sm" style={{ color: theme.node.muted }}>{t("只改变画布库中的封面，不会修改或重新生成图片。")}</p>
        {images.length ? <div className="grid max-h-[55vh] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3">
            {images.map(node => <button key={node.id} type="button" className="overflow-hidden rounded-lg border text-left" aria-label={t("设为封面：{name}", { name: node.title })} onClick={() => choose(node.id)} style={{ borderColor: node.id === project.coverNodeId ? theme.canvas.selectionStroke : theme.node.stroke }}>
                <CanvasPersistedMediaPreview kind="image" storageKey={node.metadata?.storageKey} url={node.metadata?.content} alt={node.title} className="h-32 w-full object-cover" />
                <span className="block truncate px-2 py-2 text-xs">{node.title}</span>
            </button>)}
        </div> : <p>{t("此画布暂时没有可用图片。")}</p>}
    </Modal>;
}
