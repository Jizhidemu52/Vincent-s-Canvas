import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import {
    applyDesignerCreditChange,
    applyUsageCharge,
    authenticateUserAccount,
    authenticateAdminSession,
    canAccessAdmin,
    clearAdminApiProviderSecret,
    createBatchTaskFromToolMode,
    createDefaultAdminState,
    createHistoryRecordFromToolMode,
    saveAdminApiProviderSecret,
    normalizeDesignerAccount,
    setDesignerQuotaLimit,
    upsertDesignerAccount,
    upsertAdminApiProvider,
    upsertAdminWorkflow,
    deleteAdminWorkflow,
    upsertAdminModel,
    upsertPricingRule,
    type AdminApiProvider,
    type AdminToolMode,
    type AdminWorkflowConfig,
    type AdminModelConfig,
    type AdminState,
    type AdminRole,
    type DesignerAccount,
    type DesignerAccountInput,
    type PricingRule,
    type UsageChargeRequest,
} from "@/lib/admin-domain";
import { localForageStorage } from "@/lib/localforage-storage";

type AdminStore = AdminState & {
    hydrated: boolean;
    resetDemoData: () => void;
    loginAdmin: (userId: string) => { ok: boolean; reason?: string };
    loginAccount: (loginName: string, password: string, role: AdminRole) => { ok: boolean; reason?: string; account?: DesignerAccount };
    logoutAdmin: () => void;
    canAccessAdmin: () => boolean;
    setActiveDesignerId: (designerId: string) => void;
    changeDesignerCredits: (designerId: string, amount: number, reason: string) => { ok: boolean; reason?: string };
    changeDesignerQuotaLimit: (designerId: string, quotaLimit: number) => { ok: boolean; reason?: string };
    saveDesignerAccount: (account: DesignerAccountInput) => { ok: boolean; reason?: string };
    savePricingRule: (rule: PricingRule) => { ok: boolean; reason?: string };
    saveModelConfig: (model: AdminModelConfig) => { ok: boolean; reason?: string };
    saveApiProvider: (provider: AdminApiProvider) => { ok: boolean; reason?: string };
    saveWorkflow: (workflow: AdminWorkflowConfig) => { ok: boolean; reason?: string };
    deleteWorkflow: (workflowId: string) => { ok: boolean; reason?: string };
    saveApiProviderSecret: (providerId: string, secretName: "api_key" | "wallet_api_key" | "volcengine_access_key_id" | "volcengine_secret_access_key", value: string) => { ok: boolean; reason?: string };
    clearApiProviderSecret: (providerId: string, secretName: "api_key" | "wallet_api_key" | "volcengine_access_key_id" | "volcengine_secret_access_key") => { ok: boolean; reason?: string };
    chargeUsage: (request: Omit<UsageChargeRequest, "designerId" | "createdAt"> & { designerId?: string; createdAt?: string }) => { ok: boolean; reason?: string; duplicate?: boolean; credits?: number; rmb?: number };
    recordToolBatch: (request: {
        toolMode: AdminToolMode;
        requestId: string;
        designerId?: string;
        projectId: string;
        modelId: string;
        sourceUrls: string[];
        resultUrls: string[];
        failures?: Array<{ sourceUrl: string; reason: string }>;
        createdAt?: string;
    }) => void;
    recordToolHistory: (request: { toolMode: AdminToolMode; requestId: string; designerId?: string; projectId: string; modelId: string; prompt: string; sourceUrls: string[]; resultUrls: string[]; createdAt?: string; failureReason?: string }) => void;
};

const ADMIN_STORE_KEY = "wireless-canvas:admin_store";
const initialAdminState = createDefaultAdminState();

function mergeAdminDefaults<T>(persisted: T[] | undefined, defaults: T[], getKey: (item: T) => string) {
    const existing = persisted?.length ? persisted : [];
    const existingKeys = new Set(existing.map(getKey));
    return [...existing, ...defaults.filter((item) => !existingKeys.has(getKey(item)))];
}

const adminStorage: PersistStorage<AdminStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        return value ? (JSON.parse(value) as StorageValue<AdminStore>) : null;
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useAdminStore = create<AdminStore>()(
    persist(
        (set, get) => ({
            ...initialAdminState,
            hydrated: false,
            resetDemoData: () => set({ ...createDefaultAdminState(), hydrated: true }),
            loginAdmin: (userId) => {
                const result = authenticateAdminSession(get(), userId, new Date().toISOString());
                if (!result.ok) return { ok: false, reason: result.reason };
                set({ currentOperatorId: result.session.userId, adminSession: result.session });
                return { ok: true };
            },
            loginAccount: (loginName, password, role) => {
                const result = authenticateUserAccount(get(), loginName, password, role);
                if (!result.ok) return { ok: false, reason: result.reason };
                if (role === "admin") set({ currentOperatorId: result.account.id, adminSession: { userId: result.account.id, loggedInAt: new Date().toISOString() } });
                else set({ activeDesignerId: result.account.id, adminSession: null });
                return { ok: true, account: result.account };
            },
            logoutAdmin: () => set({ adminSession: null }),
            canAccessAdmin: () => canAccessAdmin(get(), get().adminSession),
            setActiveDesignerId: (activeDesignerId) => set({ activeDesignerId }),
            changeDesignerCredits: (designerId, amount, reason) => {
                const result = applyDesignerCreditChange(get(), {
                    operatorId: get().adminSession?.userId || get().currentOperatorId,
                    designerId,
                    amount,
                    reason,
                    createdAt: new Date().toISOString(),
                });
                set(result.state);
                return result.ok ? { ok: true } : { ok: false, reason: result.reason };
            },
            changeDesignerQuotaLimit: (designerId, quotaLimit) => {
                const result = setDesignerQuotaLimit(get(), {
                    operatorId: get().adminSession?.userId || get().currentOperatorId,
                    designerId,
                    quotaLimit,
                    createdAt: new Date().toISOString(),
                });
                set(result.state);
                return result.ok ? { ok: true } : { ok: false, reason: result.reason };
            },
            saveDesignerAccount: (account) => {
                const result = upsertDesignerAccount(get(), {
                    operatorId: get().adminSession?.userId || get().currentOperatorId,
                    account,
                    createdAt: new Date().toISOString(),
                });
                set(result.state);
                return result.ok ? { ok: true } : { ok: false, reason: result.reason };
            },
            savePricingRule: (rule) => {
                const result = upsertPricingRule(get(), {
                    operatorId: get().adminSession?.userId || get().currentOperatorId,
                    rule,
                    createdAt: new Date().toISOString(),
                });
                set(result.state);
                return result.ok ? { ok: true } : { ok: false, reason: result.reason };
            },
            saveModelConfig: (model) => {
                const result = upsertAdminModel(get(), {
                    operatorId: get().adminSession?.userId || get().currentOperatorId,
                    model,
                    createdAt: new Date().toISOString(),
                });
                set(result.state);
                return result.ok ? { ok: true } : { ok: false, reason: result.reason };
            },
            saveApiProvider: (provider) => {
                const result = upsertAdminApiProvider(get(), {
                    operatorId: get().adminSession?.userId || get().currentOperatorId,
                    provider,
                    createdAt: new Date().toISOString(),
                });
                set(result.state);
                return result.ok ? { ok: true } : { ok: false, reason: result.reason };
            },
            saveWorkflow: (workflow) => {
                const result = upsertAdminWorkflow(get(), {
                    operatorId: get().adminSession?.userId || get().currentOperatorId,
                    workflow,
                    createdAt: new Date().toISOString(),
                });
                set(result.state);
                return result.ok ? { ok: true } : { ok: false, reason: result.reason };
            },
            deleteWorkflow: (workflowId) => {
                const result = deleteAdminWorkflow(get(), {
                    operatorId: get().adminSession?.userId || get().currentOperatorId,
                    workflowId,
                    createdAt: new Date().toISOString(),
                });
                set(result.state);
                return result.ok ? { ok: true } : { ok: false, reason: result.reason };
            },
            saveApiProviderSecret: (providerId, secretName, value) => {
                const result = saveAdminApiProviderSecret(get(), {
                    operatorId: get().adminSession?.userId || get().currentOperatorId,
                    providerId,
                    secretName,
                    value,
                    createdAt: new Date().toISOString(),
                });
                set(result.state);
                return result.ok ? { ok: true } : { ok: false, reason: result.reason };
            },
            clearApiProviderSecret: (providerId, secretName) => {
                const result = clearAdminApiProviderSecret(get(), {
                    operatorId: get().adminSession?.userId || get().currentOperatorId,
                    providerId,
                    secretName,
                    createdAt: new Date().toISOString(),
                });
                set(result.state);
                return result.ok ? { ok: true } : { ok: false, reason: result.reason };
            },
            chargeUsage: (request) => {
                const result = applyUsageCharge(get(), {
                    ...request,
                    designerId: request.designerId || get().activeDesignerId,
                    createdAt: request.createdAt || new Date().toISOString(),
                });
                set(result.state);
                return result.ok ? { ok: true, duplicate: result.duplicate, credits: result.credits, rmb: result.rmb } : { ok: false, reason: result.reason };
            },
            recordToolBatch: (request) => {
                const batch = createBatchTaskFromToolMode(get(), {
                    ...request,
                    designerId: request.designerId || get().activeDesignerId,
                    createdAt: request.createdAt || new Date().toISOString(),
                });
                set((state) => ({ batchTasks: [batch, ...state.batchTasks.filter((item) => item.id !== batch.id)] }));
            },
            recordToolHistory: (request) => {
                const history = createHistoryRecordFromToolMode(get(), {
                    ...request,
                    designerId: request.designerId || get().activeDesignerId,
                    createdAt: request.createdAt || new Date().toISOString(),
                });
                set((state) => ({ history: [history, ...state.history.filter((item) => item.id !== history.id)] }));
            },
        }),
        {
            name: ADMIN_STORE_KEY,
            storage: adminStorage,
            partialize: (state) =>
                ({
                    currentOperatorId: state.currentOperatorId,
                    adminSession: state.adminSession,
                    activeDesignerId: state.activeDesignerId,
                    designers: state.designers,
                    pricingRules: state.pricingRules,
                    apiProviders: state.apiProviders,
                    workflowTemplates: state.workflowTemplates,
                    workflows: state.workflows,
                    models: state.models,
                    ledger: state.ledger,
                    history: state.history,
                    materials: state.materials,
                    batchTasks: state.batchTasks,
                    auditLogs: state.auditLogs,
                }) as StorageValue<AdminStore>["state"],
            merge: (persisted, current) => {
                const state = (persisted || {}) as Partial<AdminStore>;
                return {
                    ...current,
                    ...state,
                    designers: state.designers?.length ? state.designers.map(normalizeDesignerAccount) : current.designers,
                    pricingRules: mergeAdminDefaults(state.pricingRules, current.pricingRules, (item) => item.operationType),
                    apiProviders: mergeAdminDefaults(state.apiProviders, current.apiProviders, (item) => item.id),
                    workflowTemplates: state.workflowTemplates?.length ? state.workflowTemplates : current.workflowTemplates,
                    workflows: state.workflows || [],
                    models: mergeAdminDefaults(state.models, current.models, (item) => item.id),
                    ledger: state.ledger || [],
                    history: state.history || [],
                    materials: state.materials || [],
                    batchTasks: state.batchTasks || [],
                    auditLogs: state.auditLogs || [],
                };
            },
            onRehydrateStorage: () => () => {
                useAdminStore.setState({ hydrated: true });
            },
        },
    ),
);
