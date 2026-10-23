import { create } from "zustand";

import { estimateServerUsage, getBusinessConfig, type BusinessConfig } from "@/services/api/business-config";

type BusinessConfigStore = BusinessConfig & {
    status: "idle" | "loading" | "ready" | "error";
    error: string | null;
    refresh: (options?: { background?: boolean }) => Promise<void>;
    estimate: (input: { operationType: string; modelId?: string; toolKey?: string; quantity?: number }) => ReturnType<typeof estimateServerUsage>;
};

let refreshPromise: Promise<void> | null = null;

export const useBusinessConfigStore = create<BusinessConfigStore>((set, get) => ({
    models: [],
    prices: [],
    tools: [],
    status: "idle",
    error: null,
    refresh: async ({ background = false } = {}) => {
        if (refreshPromise) return refreshPromise;
        // Same-session polling must not disable live model controls or dismiss settings.
        // A transport error is not an empty configuration. Keep the last verified
        // snapshot usable; the server still authorizes every paid request.
        if (!background || get().status !== "ready") set({ status: "loading", error: null });
        refreshPromise = getBusinessConfig()
            .then((config) => set(state => state.status === "ready" && !state.error && JSON.stringify({ models: state.models, prices: state.prices, tools: state.tools }) === JSON.stringify(config)
                ? state : { ...config, status: "ready", error: null }))
            .catch((error: unknown) => {
                const status = (error as { status?: number })?.status;
                const transient = !status || status >= 500 || status === 408 || status === 429;
                set(state => ({ status: transient && state.status === "ready" ? "ready" : "error", error: error instanceof Error ? error.message : "业务配置同步失败" }));
                throw error;
            })
            .finally(() => {
                refreshPromise = null;
            });
        return refreshPromise;
    },
    estimate: (input) => estimateServerUsage(get(), input),
}));
