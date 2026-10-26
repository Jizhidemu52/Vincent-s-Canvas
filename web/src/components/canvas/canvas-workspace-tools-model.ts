import { navigationModuleKey, navigationTools } from "@/constant/navigation-tools";
import { usageDestinations } from "@/lib/usage-navigation";
import { moduleDefinitions, type ModuleKey } from "@/services/api/modules";
import { isModuleAvailable } from "@/stores/use-module-store";

export type WorkspaceToolEntry = {
    id: string;
    label: string;
    path: string;
    group: string;
    moduleKey?: ModuleKey;
    capabilities: Array<{ moduleKey: ModuleKey; label: string }>;
};

type WorkspaceToolAccess = {
    flags: Partial<Record<ModuleKey, boolean>>;
    bindings: Array<{ toolKey: string; enabled?: boolean }>;
    rolePortalsEnabled: boolean;
    adminVisible: boolean;
    teamVisible: boolean;
};

// These are existing in-page tools, not independent routes. Keep their names
// searchable on the workspace that actually hosts them; do not invent deep links.
const embeddedModules: Partial<Record<ModuleKey, readonly ModuleKey[]>> = {
    "creative-garment-colorway": ["standard-colors", "photo-color-picker"],
    "creative-pattern-colorway": ["pattern-recolor"],
    "creative-style-to-sketch": ["svg-trace"],
    "creative-local-restyle": ["creative-selection"],
    "gpt-chat": ["gpt-chat-image"],
    canvas: moduleDefinitions.filter(item => item.parent === "canvas").map(item => item.moduleKey),
    team: ["performance"],
};

function moduleCapabilities(moduleKey: ModuleKey | undefined, access: WorkspaceToolAccess) {
    return (moduleKey ? embeddedModules[moduleKey] ?? [] : [])
        .filter(key => isModuleAvailable(access.flags, access.bindings, key))
        // Photo sampling lives inside the standard-color dialog.
        .filter(key => key !== "photo-color-picker" || isModuleAvailable(access.flags, access.bindings, "standard-colors"))
        .map(key => ({ moduleKey: key, label: moduleDefinitions.find(item => item.moduleKey === key)!.label }));
}

export function canvasWorkspaceTools(access: WorkspaceToolAccess): WorkspaceToolEntry[] {
    const entries = new Map<string, WorkspaceToolEntry>();
    const add = (id: string, label: string, path: string, moduleKey?: ModuleKey, group?: string) => {
        if (moduleKey && !isModuleAvailable(access.flags, access.bindings, moduleKey)) return;
        if (entries.has(path)) return;
        entries.set(path, {
            id, label, path, moduleKey,
            group: group ?? moduleDefinitions.find(item => item.moduleKey === moduleKey)?.group ?? "工作台",
            capabilities: moduleCapabilities(moduleKey, access),
        });
    };

    add("home", "工作台首页", "/", undefined, "工作台");
    for (const tool of navigationTools) {
        if (tool.group === "admin") {
            if (tool.slug === "admin") {
                if (access.adminVisible) add(tool.slug, tool.label, tool.path, undefined, "管理中心");
            } else if (access.rolePortalsEnabled && access.teamVisible) add(tool.slug, tool.label, tool.path, "team", "管理中心");
        } else add(tool.slug, tool.label, tool.path, navigationModuleKey(tool.slug) as ModuleKey);
    }
    // This is the shared destination registry used by the existing navigation.
    // It adds all creative scenes, promoted workbenches and reference collection.
    for (const tool of usageDestinations) add(tool.key, tool.label, tool.path, tool.moduleKey);
    if (access.rolePortalsEnabled && access.adminVisible) {
        add("performance", "设计效能", "/admin?tab=performance", "performance", "管理中心");
    }
    return [...entries.values()];
}

export function filterCanvasWorkspaceTools(entries: WorkspaceToolEntry[], query: string, group = "全部") {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return entries.filter(item => {
        if (group !== "全部" && item.group !== group) return false;
        const moduleLabel = moduleDefinitions.find(module => module.moduleKey === item.moduleKey)?.label;
        const searchable = [item.label, moduleLabel, item.group, item.moduleKey, ...item.capabilities.map(capability => capability.label)].join(" ").toLocaleLowerCase();
        return words.every(word => searchable.includes(word));
    });
}
