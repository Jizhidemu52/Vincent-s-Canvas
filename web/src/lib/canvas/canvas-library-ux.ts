import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasProjectSummary } from "./canvas-project-summary";

export type CanvasLibrarySort = "updated" | "created" | "name";
export function sortCanvasLibraryProjects(projects: readonly CanvasProjectSummary[], sort: CanvasLibrarySort, locale = "zh-CN") {
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
    return [...projects].sort((a, b) => sort === "name" ? collator.compare(a.title, b.title) || a.id.localeCompare(b.id)
        : (sort === "created" ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt)) || a.id.localeCompare(b.id));
}

export function canvasDuplicateTitle(title: string, projects: readonly { title: string }[]) {
    const existing = new Set(projects.map(project => project.title));
    const base = `${title}（副本）`;
    if (!existing.has(base)) return base;
    let number = 2;
    while (existing.has(`${title}（副本 ${number}）`)) number++;
    return `${title}（副本 ${number}）`;
}

export function formatCanvasProjectTime(value: string, locale: string, now = Date.now()) {
    const date = new Date(value), current = new Date(now);
    if (!Number.isFinite(date.getTime())) return "";
    const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000));
    if (date.getFullYear() === current.getFullYear() && seconds < 7 * 86_400) {
        const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
        if (seconds < 60) return relative.format(0, "minute");
        if (seconds < 3600) return relative.format(-Math.floor(seconds / 60), "minute");
        if (seconds < 86_400) return relative.format(-Math.floor(seconds / 3600), "hour");
        return relative.format(-Math.floor(seconds / 86_400), "day");
    }
    return new Intl.DateTimeFormat(locale, { ...(date.getFullYear() !== current.getFullYear() ? { year: "numeric" as const } : {}), month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function compareCanvasProjectVersions(original: CanvasProject, copy: CanvasProject) {
    const before = new Map(original.nodes.map(node => [node.id, node]));
    const after = new Map(copy.nodes.map(node => [node.id, node]));
    const canonical = (value: unknown) => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
        ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
    return {
        added: copy.nodes.filter(node => !before.has(node.id)),
        removed: original.nodes.filter(node => !after.has(node.id)),
        changed: copy.nodes.filter(node => before.has(node.id) && canonical(before.get(node.id)) !== canonical(node)),
        connectionsChanged: canonical(original.connections) !== canonical(copy.connections),
        chatChanged: canonical(original.chatSessions) !== canonical(copy.chatSessions),
    };
}
