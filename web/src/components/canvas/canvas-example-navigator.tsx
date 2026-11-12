import { useMemo, useRef, useState } from "react";
import { BookOpen, ChevronDown, X } from "lucide-react";
import { useUiText } from "@/lib/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { CANVAS_EXAMPLE_OVERVIEW_PREFIX, canvasExampleExtraPractices, canvasExampleLessons, canvasExampleNodePrefix } from "@/lib/canvas/canvas-example-lessons";
import { canvasExampleControlGuides, canvasExampleControlSteps } from "@/lib/canvas/canvas-example-controls";
import { canvasExampleControlProof } from "@/lib/canvas/canvas-example-practices";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData } from "@/types/canvas";

/** Navigation changes the viewport only; it never edits, selects, or executes lesson nodes. */
export function CanvasExampleNavigator({ nodes, onNavigate }: { nodes: CanvasNodeData[]; onNavigate: (ids: string[]) => void }) {
    const t = useUiText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<"lessons" | "controls">("lessons");
    const [query, setQuery] = useState("");
    const trigger = useRef<HTMLButtonElement>(null);
    const lessons = useMemo(() => canvasExampleLessons.map(lesson => ({
        ...lesson,
        cases: nodes.filter(node => node.id.startsWith(canvasExampleNodePrefix(lesson.id, "case"))).map(node => node.id),
        practice: nodes.filter(node => node.id.startsWith(canvasExampleNodePrefix(lesson.id, "practice"))).map(node => node.id),
        extras: canvasExampleExtraPractices.filter(extra => extra.lessonId === lesson.id).map(extra => ({ ...extra, ids: nodes.filter(node => node.id.startsWith(canvasExampleNodePrefix(lesson.id, extra.area))).map(node => node.id) })),
    })), [nodes]);
    const controlIds = useMemo(() => {
        const index = new Map<string, string[]>();
        for (const node of nodes) {
            const match = /^canvas-example-control-(.+--\d+)--/.exec(node.id);
            if (match) index.set(match[1]!, [...(index.get(match[1]!) || []), node.id]);
        }
        return index;
    }, [nodes]);
    const filteredGuides = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return canvasExampleControlGuides.map(guide => ({ ...guide, matchingSteps: guide.steps.map((step, index) => ({
            ...step, key: `${guide.id}--${index}`,
        })).filter(step => !needle || `${guide.title} ${guide.scenario} ${step.control} ${step.action} ${step.result}`.toLowerCase().includes(needle)) })).filter(guide => guide.matchingSteps.length);
    }, [query]);
    const navigate = (ids: string[]) => {
        onNavigate(ids);
        setOpen(false);
        trigger.current?.focus({ preventScroll: true });
    };
    return <aside className="absolute right-4 top-20 z-30 max-w-[calc(100%-32px)]" aria-label={t("教学画布导航")} data-testid="canvas-example-navigator"
        onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
        onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape") { setOpen(false); trigger.current?.focus({ preventScroll: true }); } }}>
        <button ref={trigger} type="button" aria-expanded={open} aria-controls="canvas-example-directory" onClick={() => setOpen(value => !value)}
            className="ml-auto flex min-h-10 items-center gap-2 rounded px-3 text-sm hover:opacity-75" style={{ color: theme.node.text, background: theme.toolbar.panel }}>
            <BookOpen className="size-4" aria-hidden />{t("教学目录")}<ChevronDown className={`size-4 ${open ? "rotate-180" : ""}`} aria-hidden />
        </button>
        {open ? <div id="canvas-example-directory" className="mt-2 w-[340px] max-w-full overflow-y-auto rounded-xl border p-3" style={{ maxHeight: "calc(100dvh - 200px)", background: theme.node.panel, color: theme.node.text, borderColor: theme.node.stroke }}>
            <div className="mb-2 flex items-center justify-between gap-3">
                <button type="button" className="min-h-9 text-sm font-medium hover:underline" onClick={() => navigate(nodes.filter(node => node.id.startsWith(CANVAS_EXAMPLE_OVERVIEW_PREFIX) || node.id.startsWith("canvas-example-intro-")).map(node => node.id))}>{t("回到使用说明")}</button>
                <button type="button" className="cw-icon" aria-label={t("关闭教学目录")} onClick={() => { setOpen(false); trigger.current?.focus(); }}><X className="size-4" /></button>
            </div>
            <p className="mb-3 text-xs leading-5" style={{ color: theme.node.muted }}>{t("看实际操作画面，到练习区动手。标注“实操截图”的按钮已有对应画面；其余为用法说明，未逐项实测。")}</p>
            <div className="mb-3 grid grid-cols-2 gap-1" aria-label={t("教学目录类型")}>
                <button type="button" aria-pressed={mode === "lessons"} onClick={() => setMode("lessons")} className="min-h-9 rounded px-2 text-xs" style={{ background: mode === "lessons" ? theme.toolbar.itemHover : undefined }}>{t("设计案例")}</button>
                <button type="button" aria-pressed={mode === "controls"} onClick={() => setMode("controls")} className="min-h-9 rounded px-2 text-xs" style={{ background: mode === "controls" ? theme.toolbar.itemHover : undefined }}>{t("按钮详解")}（{canvasExampleControlSteps.length}）</button>
            </div>
            {mode === "lessons" ? <ol className="space-y-1">
                {lessons.map(lesson => <li key={lesson.id} className="rounded px-1 py-2"><div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 text-xs leading-5">{lesson.number} · {t(lesson.title)}</span>
                    <div className="flex shrink-0 gap-1">
                        <button type="button" disabled={!lesson.cases.length} aria-label={t("{number} {title}：看案例", { number: lesson.number, title: t(lesson.title) })} className="min-h-9 rounded px-2 text-xs hover:underline disabled:opacity-40" style={{ color: theme.node.text }} onClick={() => navigate(lesson.cases)}>{t("看案例")}</button>
                        <button type="button" disabled={!lesson.practice.length} aria-label={t("{number} {title}：到练习", { number: lesson.number, title: t(lesson.title) })} className="min-h-9 rounded px-2 text-xs hover:underline disabled:opacity-40" style={{ color: theme.node.text, background: theme.toolbar.itemHover }} onClick={() => navigate(lesson.practice)}>{t("到练习")}</button>
                    </div></div>
                    {lesson.extras.map(extra => <button key={extra.area} type="button" disabled={!extra.ids.length} className="ml-auto mt-1 block min-h-9 rounded px-2 text-xs hover:underline disabled:opacity-40" style={{ color: theme.node.text, background: theme.toolbar.itemHover }} onClick={() => navigate(extra.ids)}>{t(extra.title)}</button>)}
                </li>)}
            </ol> : <section aria-label={t("逐项按钮操作案例")}>
                <input aria-label={t("搜索画布按钮或功能")} placeholder={t("搜索：配置、对比、切换、裁剪…")} value={query} onChange={event => setQuery(event.target.value)} className="mb-3 h-10 w-full rounded border px-3 text-xs outline-none focus:ring-1" style={{ background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }} />
                <p className="mb-2 text-xs" style={{ color: theme.node.muted }}>{filteredGuides.reduce((sum, guide) => sum + guide.matchingSteps.length, 0)} {t("项可查阅；条件功能在卡片中注明何时出现。")}</p>
                {!filteredGuides.length ? <p className="py-4 text-sm">{t("未找到对应按钮，请试试简短关键词。")}</p> : filteredGuides.map(guide => <details key={`${guide.id}:${Boolean(query.trim())}`} data-guide-id={guide.id} open={query.trim() ? true : undefined} className="mb-1 rounded border px-2 py-1" style={{ borderColor: theme.node.stroke }}>
                    <summary className="cursor-pointer py-2 text-xs font-medium leading-5">{t(guide.title)}（{guide.matchingSteps.length}）</summary>
                    <div className="space-y-1 pb-2">
                        {guide.matchingSteps.map(step => <button key={step.key} data-control-key={step.key} type="button" aria-label={t("查看按钮详解：{control}", { control: step.control })} disabled={!controlIds.get(step.key)?.length} onClick={() => navigate(controlIds.get(step.key) || [])} className="block min-h-9 w-full rounded px-2 py-2 text-left text-xs leading-5 hover:underline disabled:opacity-40" style={{ background: theme.toolbar.itemHover }}>{t(step.control)}<span className="ml-2 opacity-55">{t(canvasExampleControlProof[step.key] ? "实操截图" : "用法说明")}</span></button>)}
                        <button type="button" className="min-h-9 w-full px-2 text-left text-xs hover:underline" style={{ color: theme.node.muted }} onClick={() => navigate(nodes.filter(node => node.id.startsWith(canvasExampleNodePrefix(guide.lessonId, guide.practiceArea || "practice"))).map(node => node.id))}>{t("到对应练习区")}</button>
                    </div>
                </details>)}
            </section>}
        </div> : null}
    </aside>;
}
