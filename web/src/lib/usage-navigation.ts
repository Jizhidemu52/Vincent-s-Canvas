import { navigationModuleKey, navigationTools } from "@/constant/navigation-tools";
import { buildCreativePresetHref, creativeCatalogPresets, getCreativePreset } from "@/lib/creative-presets";
import { retiredWorkbenchName } from "@/lib/retired-workbenches";
import { moduleDefinitions, moduleIsEnabled, type ModuleKey } from "../../../shared/feature-catalog";

export type UsageDestination = { key: string; label: string; path: string; moduleKey: ModuleKey };
export const usageDestinations: UsageDestination[] = [
    ...navigationTools.filter(tool => tool.group !== "admin" && !["my-prompts", "remove-background", "hd-upscale", "item-extract"].includes(tool.slug)).map(tool => ({ key: navigationModuleKey(tool.slug), label: tool.label, path: tool.path, moduleKey: navigationModuleKey(tool.slug) as ModuleKey })),
    ...creativeCatalogPresets.map(preset => ({ key: `creative-${preset.id}`, label: preset.title, path: buildCreativePresetHref(preset), moduleKey: `creative-${preset.id}` as ModuleKey })),
    { key: "pattern-placement", label: "图案定位", path: "/creative/pattern-placement", moduleKey: "pattern-placement" },
    { key: "pattern-repeat", label: "图案循环", path: "/creative/pattern-repeat", moduleKey: "pattern-repeat" },
    { key: "reference-import", label: "网页参考导入", path: "/reference-import", moduleKey: "reference-import" },
];
const imageBoards = new Set(["image", "image-edit", "seamless-stitch", "midjourney-blend"]);
const boards = new Set(moduleDefinitions.filter(item => !["team", "performance"].includes(item.moduleKey)).map(item => item.moduleKey as string));
export function usageBoardForLocation(pathname: string, search = ""): string | null {
    if (retiredWorkbenchName(pathname, search)) return null;
    if (pathname === "/remove-background" || pathname === "/item-extract") return "image-edit";
    if (pathname === "/hd-upscale") return "detail-enhance";
    if (pathname === "/") return "home";
    if (pathname === "/image") { const key = new URLSearchParams(search).get("tool") || "image"; return imageBoards.has(key) ? key : "image"; }
    if (/^\/canvas(?:\/[^/]+)?\/?$/.test(pathname)) return "canvas";
    if (pathname === "/my-prompts") return "prompts";
    if (pathname === "/chat") return "gpt-chat";
    const legacyPreset = pathname.startsWith("/creative/") ? getCreativePreset(pathname.slice("/creative/".length)) : undefined;
    if (legacyPreset) return `creative-${legacyPreset.id}`;
    return usageDestinations.find(item => item.path === pathname)?.key ?? null;
}
export function usageBoardAvailable(board: string | null, flags: Partial<Record<ModuleKey, boolean>>, tools: Array<{ toolKey: string; enabled?: boolean }>) {
    if (!board) return false;
    if (board === "home") return true;
    if (!boards.has(board)) return false;
    const key = board as ModuleKey;
    const parent = moduleDefinitions.find(item => item.moduleKey === key)?.parent;
    return moduleIsEnabled(flags, key) && tools.find(item => item.toolKey === key)?.enabled !== false && (!parent || tools.find(item => item.toolKey === parent)?.enabled !== false);
}
export function frequentUsageDestinations(counts: Record<string, number>, flags: Partial<Record<ModuleKey, boolean>>, tools: Array<{ toolKey: string; enabled?: boolean }>, limit = 5) {
    return usageDestinations.filter(item => (counts[item.key] || 0) > 0 && usageBoardAvailable(item.key, flags, tools))
        .map((item, index) => ({ ...item, count: counts[item.key], index }))
        .sort((a, b) => b.count - a.count || a.index - b.index).slice(0, limit);
}
