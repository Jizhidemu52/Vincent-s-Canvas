import { create } from "zustand";

import { listModuleFlags, moduleKeys, type ModuleFlag, type ModuleKey } from "@/services/api/modules";

type ModuleStore = {
    flags: Record<ModuleKey, boolean>;
    status: "idle" | "loading" | "ready" | "error";
    refresh: () => Promise<void>;
    setFlag: (flag: ModuleFlag) => void;
};

const defaultFlags = Object.fromEntries(moduleKeys.map((key) => [key, false])) as Record<ModuleKey, boolean>;
let refreshPromise: Promise<void> | null = null;

export const useModuleStore = create<ModuleStore>((set) => ({
    flags: defaultFlags,
    status: "idle",
    refresh: async () => {
        if (refreshPromise) return refreshPromise;
        set({ status: "loading" });
        refreshPromise = listModuleFlags()
            .then(({ modules }) => set((state) => ({
                flags: { ...state.flags, ...Object.fromEntries(modules.map((item) => [item.moduleKey, item.enabled])) },
                status: "ready",
            })))
            .catch((error) => {
                set({ status: "error" });
                throw error;
            })
            .finally(() => { refreshPromise = null; });
        return refreshPromise;
    },
    setFlag: (flag) => set((state) => ({ flags: { ...state.flags, [flag.moduleKey]: flag.enabled } })),
}));

export function useModuleEnabled(key: ModuleKey) {
    return useModuleStore((state) => state.flags[key]);
}
