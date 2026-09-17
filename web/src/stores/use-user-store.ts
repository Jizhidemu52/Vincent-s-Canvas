import { create } from "zustand";

import { exchangeOaToken, getCurrentSession, loginWithPassword, logoutSession, type ApiUser, type ApiUserRole } from "@/services/api/auth";

export type LocalUser = ApiUser & { avatarUrl: string };
export type AuthStatus = "idle" | "loading" | "authenticated" | "guest";

type UserStore = {
    user: LocalUser | null;
    status: AuthStatus;
    hydrateSession: () => Promise<void>;
    exchangeOaToken: (token: string) => Promise<void>;
    loginWithPassword: (identifier: string, password: string, portal: "designer" | "admin") => Promise<LocalUser>;
    clearSession: () => Promise<void>;
    updateUser: (user: ApiUser) => void;
};

let hydration: Promise<void> | null = null;
let rejectedOaToken = false;

export const useUserStore = create<UserStore>((set, get) => ({
    user: null,
    status: "idle",
    hydrateSession: async () => {
        if (rejectedOaToken) return;
        if (hydration) return hydration;
        if (!get().user) set({ status: "loading" });
        hydration = getCurrentSession()
            .then(({ user }) => set({ user: { ...user, avatarUrl: "" }, status: "authenticated" }))
            .catch(() => set({ user: null, status: "guest" }))
            .finally(() => { hydration = null; });
        return hydration;
    },
    exchangeOaToken: async (token) => {
        // An explicit OA identity takes precedence over any previous browser session.
        rejectedOaToken = true;
        set({ user: null, status: "loading" });
        try {
            const { user } = await exchangeOaToken(token);
            rejectedOaToken = false;
            set({ user: { ...user, avatarUrl: "" }, status: "authenticated" });
        } catch {
            // Do not display server errors that might contain credential material.
            set({ user: null, status: "guest" });
        }
    },
    loginWithPassword: async (identifier, password, portal) => {
        const { user } = await loginWithPassword(identifier, password, portal);
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
