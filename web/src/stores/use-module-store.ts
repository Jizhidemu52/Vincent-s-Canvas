import { create } from "zustand";

import { listModuleFlags, moduleKeys, type ModuleFlag, type ModuleKey } from "@/services/api/modules";
import { moduleDefinitions, moduleIsEnabled } from "../../../shared/feature-catalog";
import { useBusinessConfigStore } from "./use-business-config-store";

type ModuleStore = {
    flags: Record<ModuleKey, boolean>;
    status: "idle" | "loading" | "ready" | "error";
    error: string | null;
    refresh: () => Promise<void>;
    setFlag: (flag: ModuleFlag) => void;
};

const defaultFlags = Object.fromEntries(moduleKeys.map((key) => [key, false])) as Record<ModuleKey, boolean>;
let refreshPromise: Promise<void> | null = null;

export const useModuleStore = create<ModuleStore>((set) => ({
    flags: defaultFlags,
    status: "idle",
    error: null,
    refresh: async () => {
        if (refreshPromise) return refreshPromise;
        // Module flags are refreshed in the background while a designer works.
        // Only the first load may block a gated route; otherwise changing this
        // to `loading` would unmount the current tool and discard form input.
        set((state) => (state.status !== "ready" ? { status: "loading", error: null } : state));
        refreshPromise = listModuleFlags()
            .then(({ modules }) => set((state) => {
                const flags = { ...state.flags, ...Object.fromEntries(modules.map((item) => [item.moduleKey, item.enabled])) };
                return state.status === "ready" && !state.error && moduleKeys.every(key => state.flags[key] === flags[key]) ? state : { flags, status: "ready", error: null };
            }))
            .catch((error) => {
                const transient = !error?.status || error.status >= 500 || error.status === 408 || error.status === 429;
                set(state => ({ status: transient && state.status === "ready" ? "ready" : "error", error: "模块配置暂时无法加载" }));
                throw error;
            })
            .finally(() => { refreshPromise = null; });
        return refreshPromise;
    },
    setFlag: (flag) => set((state) => ({ flags: { ...state.flags, [flag.moduleKey]: flag.enabled } })),
}));

export function useModuleEnabled(key: ModuleKey) {
    const flags = useModuleStore((state) => state.flags);
    const tools = useBusinessConfigStore((state) => state.tools);
    return isModuleAvailable(flags, tools, key);
}

export function isModuleAvailable(flags: Partial<Record<ModuleKey, boolean>>, tools: Array<{ toolKey: string; enabled?: boolean }>, key: ModuleKey) {
    const parent = moduleDefinitions.find(item => item.moduleKey === key)?.parent;
    return moduleIsEnabled(flags, key) && tools.find(item => item.toolKey === key)?.enabled !== false
        && (!parent || tools.find(item => item.toolKey === parent)?.enabled !== false);
}
