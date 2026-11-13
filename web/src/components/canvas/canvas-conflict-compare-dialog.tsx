import { useMemo } from "react";
import { Button, Modal } from "antd";
import { useNavigate } from "react-router-dom";
import { useUiLocale, useUiText } from "@/lib/i18n";
import { DisplayText, useDisplayText } from "@/hooks/use-display-text";
import { compareCanvasProjectVersions, formatCanvasProjectTime } from "@/lib/canvas/canvas-library-ux";
import { canvasProjectSummary } from "@/lib/canvas/canvas-project-summary";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasPersistedMediaPreview } from "./canvas-persisted-media-preview";

export function CanvasConflictCompareDialog({ original, copy, onClose, onKeep }: { original: CanvasProject | null; copy: CanvasProject; onClose: () => void; onKeep: () => Promise<void> }) {
    const t = useUiText();
    const translate = useDisplayText();
    const locale = useUiLocale();
    const navigate = useNavigate();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const changes = useMemo(() => original ? compareCanvasProjectVersions(original, copy) : null, [original, copy]);
    return <Modal open title={t("对比冲突版本")} width={960} onCancel={onClose} destroyOnHidden footer={<>
        <Button onClick={onClose}>{t("关闭")}</Button>
        <Button danger onClick={() => { onClose(); useCanvasUiStore.getState().setDeleteProjectIds([copy.id]); }}>{t("删除此副本…")}</Button>
        <Button type="primary" onClick={() => void onKeep().then(onClose).catch(() => undefined)}>{t("保留为独立画布")}</Button>
    </>}>
        <p className="mb-4 text-sm" style={{ color: theme.node.muted }}>{t("两个版本都完整保留。这里仅比较，不会自动覆盖或合并。")}</p>
        <div className="grid gap-4 md:grid-cols-2">
            {[original, copy].map((project, index) => {
                const summary = project ? canvasProjectSummary(project) : null;
                return <section key={index} className="min-w-0 rounded-lg border p-3" style={{ borderColor: theme.node.stroke }}>
                    <h3 className="font-medium">{index ? t("冲突副本") : t("原画布")}</h3>
                    {!project ? <p className="mt-4 text-sm">{t("原画布已不存在或无法读取；此副本仍完整保留。")}</p> : <>
                        <p className="mt-1 truncate"><DisplayText text={project.title} /></p>
                        <p className="mb-2 mt-1 text-xs" style={{ color: theme.node.muted }}>{t("{nodes} 个节点 · {connections} 条连线 · {chats} 个对话", { nodes: project.nodes.length, connections: project.connections.length, chats: project.chatSessions.length })}</p>
                        {summary?.cover ? <CanvasPersistedMediaPreview kind="image" storageKey={summary.cover.storageKey} url={summary.cover.content} alt={translate(project.title)} className="h-40 w-full rounded object-contain" /> : null}
                        <p className="mt-2 text-xs">{t("更新于 {time}", { time: formatCanvasProjectTime(project.updatedAt, locale) })}</p>
                        <ul className="mt-3 max-h-36 overflow-y-auto text-xs">{project.nodes.filter(node => node.type === "text").slice(0, 3).map(node => <li key={node.id} className="mb-2 whitespace-pre-wrap break-words"><DisplayText text={node.title} />: <DisplayText text={(node.metadata?.content || "").slice(0, 400)} /></li>)}</ul>
                        <Button size="small" className="mt-2" onClick={() => { onClose(); navigate(`/canvas/${project.id}`); }}>{t("打开此版本")}</Button>
                    </>}
                </section>;
            })}
        </div>
        {changes ? <div className="mt-4 text-sm">
            <p>{t("副本相对原画布：新增 {added} 个、缺少 {removed} 个、内容或位置不同 {changed} 个节点。", { added: changes.added.length, removed: changes.removed.length, changed: changes.changed.length })}</p>
            <p className="mt-1" style={{ color: theme.node.muted }}>{t("连线：{connections}；对话：{chats}。", { connections: changes.connectionsChanged ? t("不同") : t("相同"), chats: changes.chatChanged ? t("不同") : t("相同") })}</p>
            {changes.changed.length ? <p className="mt-2">{t("不同节点：{names}", { names: changes.changed.slice(0, 12).map(node => translate(node.title)).join(locale === "en-US" ? ", " : "、") + (changes.changed.length > 12 ? "…" : "") })}</p> : null}
        </div> : null}
    </Modal>;
}
