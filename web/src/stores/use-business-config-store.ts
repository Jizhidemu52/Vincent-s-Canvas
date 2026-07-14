import { create } from "zustand";

import { estimateServerUsage, getBusinessConfig, type BusinessConfig } from "@/services/api/business-config";

type BusinessConfigStore = BusinessConfig & {
    status: "idle" | "loading" | "ready" | "error";
    error: string | null;
    refresh: () => Promise<void>;
    estimate: (input: { operationType: string; modelId?: string; toolKey?: string; quantity?: number }) => ReturnType<typeof estimateServerUsage>;
};

let refreshPromise: Promise<void> | null = null;

export const useBusinessConfigStore = create<BusinessConfigStore>((set, get) => ({
    models: [],
    prices: [],
    tools: [],
    status: "idle",
    error: null,
    refresh: async () => {
        if (refreshPromise) return refreshPromise;
        set({ status: "loading", error: null });
        refreshPromise = getBusinessConfig()
            .then((config) => set({ ...config, status: "ready", error: null }))
            .catch((error: unknown) => {
                set({ status: "error", error: error instanceof Error ? error.message : "业务配置同步失败" });
                throw error;
            })
            .finally(() => {
                refreshPromise = null;
            });
        return refreshPromise;
    },
    estimate: (input) => estimateServerUsage(get(), input),
}));
