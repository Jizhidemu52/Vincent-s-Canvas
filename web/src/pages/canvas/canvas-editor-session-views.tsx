import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { DisplayText, useDisplayText } from "@/hooks/use-display-text";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CanvasPersistedMediaPreview } from "@/components/canvas/canvas-persisted-media-preview";
import { canvasThemes } from "@/lib/canvas-theme";
import { fitCanvasNodes } from "@/lib/canvas/canvas-node-size";
import { loadCanvasProject, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasEditorRecoveryRef } from "./canvas-editor-session";
import type { useCanvasEditLock } from "./use-canvas-edit-lock";

type EditLock = ReturnType<typeof useCanvasEditLock>;

export function CanvasRecoveryOverlay({ lock, transferring, recoveryRef, onBackedUp }: {
    lock: EditLock; transferring: boolean; recoveryRef: CanvasEditorRecoveryRef; onBackedUp: (requestEditing: boolean) => void;
}) {
    useUiLocale();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const backupBusy = useRef(false);
    const [backingUp, setBackingUp] = useState(false);
    const [recoveryError, setRecoveryError] = useState<string>();
    const backupDraft = async (requestEditing: boolean) => {
        if (backupBusy.current) return;
        backupBusy.current = true;
        setBackingUp(true); setRecoveryError(undefined);
        try {
            if (!recoveryRef.current) throw new Error("本页草稿尚未就绪，请稍后重试。");
            await recoveryRef.current.backup();
            onBackedUp(requestEditing);
        } catch (error) {
            setRecoveryError(error instanceof Error ? error.message : "备份失败，已保留本页内容，请重试。");
        } finally { backupBusy.current = false; setBackingUp(false); }
    };
    const recovering = lock.status === "recovering";
    return <div className="absolute inset-0 z-[100] flex items-center justify-center p-6" style={{ background: `${theme.canvas.background}bb` }}>
        <div className="max-w-lg space-y-3 rounded-lg border p-5 text-sm" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }}>
            <p role="status">{recovering ? staticUiText("正在恢复本页编辑连接，画布内容已保留…") : transferring ? staticUiText("正在保存并移交编辑权…") : lock.status === "checking" ? staticUiText("正在确认编辑权…") : <DisplayText text={recoveryError || lock.error || "此画布已在另一标签页编辑。本页未保存内容已保留，不会覆盖对方的修改。"} />}</p>
            {!recovering && lock.status !== "checking" ? <>
                <p>{staticUiText("载入最新内容前，请先备份本页内容；备份失败时不会替换当前草稿。")}</p>
                <div className="flex flex-wrap gap-3">
                    <button type="button" disabled={backingUp} className="rounded-md border px-3 py-2" onClick={() => void backupDraft(false)}>{staticUiText("导出本页备份")}</button>
                    <button type="button" disabled={backingUp} className="rounded-md border px-3 py-2" onClick={() => void backupDraft(true)}>{backingUp ? staticUiText("正在备份…") : staticUiText("备份并在此页编辑")}</button>
                </div>
            </> : null}
        </div>
    </div>;
}

export function CanvasReadonlySession({ projectId, lock }: { projectId: string; lock: EditLock }) {
    useUiLocale();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const recovering = lock.status === "recovering";
    return <main data-testid="canvas-readonly-session" className="relative h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
        <ReadonlyCanvasPreview projectId={projectId} />
        <div className="absolute inset-x-4 top-4 flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke }}>
            <span className="flex-1" role="status">{lock.status === "checking" || recovering ? staticUiText("正在确认编辑权…") : <DisplayText text={lock.error || "此画布正在另一标签页编辑。当前为只读快照，不会覆盖那边的修改。"} />}</span>
            <Link className="underline" to="/canvas">{staticUiText("返回画布库")}</Link>
            {lock.status !== "checking" && !recovering ? <button type="button" className="rounded-md border px-3 py-2" style={{ borderColor: theme.canvas.selectionStroke }} onClick={lock.requestEditing}>{staticUiText("在此页编辑")}</button> : null}
        </div>
    </main>;
}

function ReadonlyCanvasPreview({ projectId }: { projectId: string }) {
    useUiLocale();
    const translate = useDisplayText();
    const [project, setProject] = useState<CanvasProject | null>(null);
    const [size, setSize] = useState({ width: 1200, height: 700 });
    const container = useRef<HTMLDivElement>(null);
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    useEffect(() => {
        let current = true;
        void loadCanvasProject(projectId).then(value => { if (current) setProject(value); }).catch(() => undefined);
        return () => { current = false; };
    }, [projectId]);
    useEffect(() => {
        const element = container.current;
        if (!element) return;
        const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    const viewport = useMemo(() => fitCanvasNodes(project?.nodes || [], { left: 32, top: 100, width: Math.max(1, size.width - 64), height: Math.max(1, size.height - 132) }), [project, size]);
    return <div ref={container} className="absolute inset-0 overflow-hidden" aria-label={staticUiText("画布最后保存的只读预览")}>
        <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})` }}>
            {project?.nodes.map(node => <div key={node.id} className="absolute overflow-hidden rounded border" style={{ left: node.position.x, top: node.position.y, width: node.width, height: node.height, color: theme.node.text, background: theme.node.panel, borderColor: theme.node.stroke }}>
                {node.type === "image" ? <CanvasPersistedMediaPreview kind="image" url={node.metadata?.content} storageKey={node.metadata?.storageKey} alt={translate(node.title)} width={node.metadata?.naturalWidth} height={node.metadata?.naturalHeight} className="h-full w-full object-contain" /> : <div className="whitespace-pre-wrap p-3"><strong><DisplayText text={node.title} /></strong>{node.type === "text" ? <p><DisplayText text={node.metadata?.content || ""} /></p> : null}</div>}
            </div>)}
        </div>
    </div>;
}
