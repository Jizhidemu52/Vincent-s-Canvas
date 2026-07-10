import { create } from "zustand";

import { getCurrentSession, loginWithPassword, logoutSession, type ApiUser, type ApiUserRole } from "@/services/api/auth";

export type LocalUser = ApiUser & { avatarUrl: string };
export type AuthStatus = "idle" | "loading" | "authenticated" | "guest";

type UserStore = {
    user: LocalUser | null;
    status: AuthStatus;
    hydrateSession: () => Promise<void>;
    loginWithPassword: (identifier: string, password: string, portal: "designer" | "admin", mfaCode?: string) => Promise<LocalUser>;
    clearSession: () => Promise<void>;
    updateUser: (user: ApiUser) => void;
};

let hydration: Promise<void> | null = null;

export const useUserStore = create<UserStore>((set) => ({
    user: null,
    status: "idle",
    hydrateSession: async () => {
        if (hydration) return hydration;
        set({ status: "loading" });
        hydration = getCurrentSession()
            .then(({ user }) => set({ user: { ...user, avatarUrl: "" }, status: "authenticated" }))
            .catch(() => set({ user: null, status: "guest" }))
            .finally(() => { hydration = null; });
        return hydration;
    },
    loginWithPassword: async (identifier, password, portal, mfaCode) => {
        const { user } = await loginWithPassword(identifier, password, portal, mfaCode);
        const localUser = { ...user, avatarUrl: "" };
        set({ user: localUser, status: "authenticated" });
        return localUser;
    },
    clearSession: async () => {
        try { await logoutSession(); } finally { set({ user: null, status: "guest" }); }
    },
    updateUser: (user) => set({ user: { ...user, avatarUrl: "" }, status: "authenticated" }),
}));

export function isAdminRole(role: ApiUserRole | undefined): role is "super_admin" | "department_admin" {
    return role === "super_admin" || role === "department_admin";
}
