import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import type { CanvasProjectSummary } from "@/lib/canvas/canvas-project-summary";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { canvasProjectGridWindow, createCanvasProjectGridLayout } from "./canvas-project-grid-layout";

type RowSize = { index: number; height: number; columns: number; gap: number };

function measureRow(row: HTMLElement): RowSize {
    const style = getComputedStyle(row);
    return {
        index: Number(row.dataset.canvasProjectRow), height: row.getBoundingClientRect().height,
        columns: style.gridTemplateColumns.split(" ").filter(Boolean).length,
        gap: Number.parseFloat(style.rowGap) || 0,
    };
}

const CanvasProjectGridRow = memo(function CanvasProjectGridRow({ projects, columns, index, top, onMeasure }: { projects: CanvasProjectSummary[]; columns: number; index: number; top: number; onMeasure: (size: RowSize) => void }) {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const row = ref.current;
        if (!row) return;
        const measure = () => onMeasure(measureRow(row));
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(row);
        return () => observer.disconnect();
    }, [index, onMeasure]);
    return (
        <div ref={ref} data-canvas-project-row={index} className="absolute inset-x-0 grid gap-5 sm:grid-cols-2 xl:grid-cols-3" style={{ top }}>
            {projects.slice(index * columns, (index + 1) * columns).map(project => <CanvasProjectCard key={project.id} project={project} />)}
        </div>
    );
});

/** Only viewport rows (plus the active rename row) own card/preview components. */
export function CanvasProjectGrid({ projects, scrollElement }: { projects: CanvasProjectSummary[]; scrollElement: RefObject<HTMLElement | null> }) {
    const ref = useRef<HTMLDivElement>(null);
    const editingId = useCanvasUiStore(state => state.editingProjectId);
    const [metrics, setMetrics] = useState(() => ({
        columns: typeof window === "undefined" ? 1 : window.innerWidth >= 1280 ? 3 : window.innerWidth >= 640 ? 2 : 1,
        height: 300, gap: 20, measured: new Map<number, number>(),
    }));
    const [viewport, setViewport] = useState({ top: 0, height: 1 });
    const editingIndex = editingId ? projects.findIndex(project => project.id === editingId) : -1;
    const editingRow = editingIndex < 0 ? -1 : Math.floor(editingIndex / metrics.columns);
    const layout = useMemo(() => createCanvasProjectGridLayout(projects.length, metrics.columns, metrics.height, metrics.gap, metrics.measured), [projects.length, metrics]);
    const windowRows = canvasProjectGridWindow(layout, viewport.top, viewport.height, 2, editingRow);
    const measurementRef = useRef({ first: windowRows.firstVisibleRow, editing: editingRow });
    measurementRef.current = { first: windowRows.firstVisibleRow, editing: editingRow };

    const onMeasure = useCallback((size: RowSize) => {
        if (size.height <= 0 || size.columns <= 0) return;
        setMetrics(previous => {
            if (previous.columns !== size.columns) {
                // Width breakpoints re-group cards, so previous row measurements
                // no longer refer to the same rows. Actual card sizes stay free.
                return { columns: size.columns, height: size.height, gap: size.gap, measured: new Map() };
            }
            const representative = size.index === measurementRef.current.first && size.index !== measurementRef.current.editing;
            const height = representative ? size.height : previous.height;
            if (previous.measured.get(size.index) === size.height && previous.height === height && previous.gap === size.gap) return previous;
            const measured = new Map(previous.measured);
            measured.set(size.index, size.height);
            return { ...previous, height, gap: size.gap, measured };
        });
    }, []);

    // The scroll ref belongs to an ancestor whose DOM ref is attached after
    // descendant layout effects on a cold mount. Subscribe after that commit.
    useEffect(() => {
        const grid = ref.current;
        const scroll = scrollElement.current;
        if (!grid || !scroll) return;
        let pendingFrame = 0;
        const measure = () => {
            pendingFrame = 0;
            const top = scroll.getBoundingClientRect().top + scroll.clientTop - grid.getBoundingClientRect().top;
            const height = scroll.clientHeight;
            setViewport(previous => previous.top === top && previous.height === height ? previous : { top, height });
            // A media-query column change can keep the row's border-box size
            // unchanged, so also read computed columns on container/window resize.
            const row = grid.querySelector<HTMLElement>(`[data-canvas-project-row="${measurementRef.current.first}"]`) || grid.firstElementChild as HTMLElement | null;
            if (row) onMeasure(measureRow(row));
        };
        const schedule = () => { if (!pendingFrame) pendingFrame = requestAnimationFrame(measure); };
        measure();
        scroll.addEventListener("scroll", schedule, { passive: true });
        window.addEventListener("resize", schedule);
        const observer = new ResizeObserver(schedule);
        observer.observe(scroll);
        observer.observe(grid);
        if (grid.parentElement) observer.observe(grid.parentElement);
        return () => {
            if (pendingFrame) cancelAnimationFrame(pendingFrame);
            scroll.removeEventListener("scroll", schedule);
            window.removeEventListener("resize", schedule);
            observer.disconnect();
        };
    }, [onMeasure, scrollElement]);

    return (
        <div ref={ref} className="relative w-full" data-canvas-project-grid style={{ height: layout.totalHeight, overflowAnchor: "none" }}>
            {windowRows.rows.map(row => (
                <CanvasProjectGridRow key={row} index={row} top={layout.offsets[row]} onMeasure={onMeasure} projects={projects} columns={metrics.columns} />
            ))}
        </div>
    );
}
