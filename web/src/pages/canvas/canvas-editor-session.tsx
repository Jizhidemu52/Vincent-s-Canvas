import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link } from "react-router-dom";
import { CanvasPersistedMediaPreview } from "@/components/canvas/canvas-persisted-media-preview";
import { canvasThemes } from "@/lib/canvas-theme";
import { fitCanvasNodes } from "@/lib/canvas/canvas-interaction-ux";
import { loadCanvasProject, reloadCanvasProject, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasEditLock } from "./use-canvas-edit-lock";

export type CanvasEditorFlushRef = RefObject<(() => Promise<void>) | null>;

/** A readonly tab never mounts an editor, save queue, assistant or task observer. */
export function CanvasEditorSession({ owner, projectId, enabled = true, children }: {
    owner: string; projectId: string; enabled?: boolean; children: (flushRef: CanvasEditorFlushRef, writable: RefObject<boolean>) => ReactNode;
}) {
    const flushRef = useRef<(() => Promise<void>) | null>(null);
    const writable = useRef(false);
    const mountedEditor = useRef(false);
    const flush = useCallback(async () => { await flushRef.current?.(); writable.current = false; }, []);
    const reload = useCallback(async () => { await reloadCanvasProject(projectId); }, [projectId]);
    const lock = useCanvasEditLock(owner, projectId, flush, enabled, reload);
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const transferring = lock.status === "checking" && Boolean(lock.holder) && mountedEditor.current;
    if (lock.isEditable) { writable.current = true; mountedEditor.current = true; }
    else if (!transferring) { writable.current = false; mountedEditor.current = false; }
    if (lock.isEditable || transferring) return <div className="relative h-full" data-canvas-edit-blocked={transferring ? "true" : undefined}>
        <div inert={transferring} className="h-full">{children(flushRef, writable)}</div>
        {transferring ? <div role="status" className="absolute inset-0 z-[100] flex items-center justify-center" style={{ background: `${theme.canvas.background}bb` }}>正在保存并移交编辑权…</div> : null}
        {lock.error ? <div role="status" className="absolute bottom-16 left-1/2 z-40 max-w-lg -translate-x-1/2 rounded-lg px-4 py-2 text-sm" style={{ background: theme.node.panel, color: theme.node.warning }}>{lock.error}</div> : null}
    </div>;
    return <main data-testid="canvas-readonly-session" className="relative h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
        <ReadonlyCanvasPreview projectId={projectId} />
        <div className="absolute inset-x-4 top-4 flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke }}>
            <span className="flex-1" role="status">{lock.status === "checking" ? "正在确认编辑权…" : lock.error || "此画布正在另一标签页编辑。当前为只读快照，不会覆盖那边的修改。"}</span>
            <Link className="underline" to="/canvas">返回画布库</Link>
            {lock.status !== "checking" ? <button type="button" className="rounded-md border px-3 py-1.5" style={{ borderColor: theme.canvas.selectionStroke }} onClick={lock.requestEditing}>在此页编辑</button> : null}
        </div>
    </main>;
}

function ReadonlyCanvasPreview({ projectId }: { projectId: string }) {
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
    return <div ref={container} className="absolute inset-0 overflow-hidden" aria-label="画布最后保存的只读预览">
        <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})` }}>
            {project?.nodes.map(node => <div key={node.id} className="absolute overflow-hidden rounded border" style={{ left: node.position.x, top: node.position.y, width: node.width, height: node.height, color: theme.node.text, background: theme.node.panel, borderColor: theme.node.stroke }}>
                {node.type === "image" ? <CanvasPersistedMediaPreview kind="image" url={node.metadata?.content} storageKey={node.metadata?.storageKey} alt={node.title} width={node.metadata?.naturalWidth} height={node.metadata?.naturalHeight} className="h-full w-full object-contain" /> : <div className="whitespace-pre-wrap p-3"><strong>{node.title}</strong>{node.type === "text" ? <p>{node.metadata?.content}</p> : null}</div>}
            </div>)}
        </div>
    </div>;
}
