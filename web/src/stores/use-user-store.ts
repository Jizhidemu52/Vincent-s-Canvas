import { create } from "zustand";

import { AuthRequestError, exchangeOaToken, getCurrentSession, loginWithPassword, logoutSession, type ApiUser, type ApiUserRole } from "@/services/api/auth";

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
let sessionEpoch = 0;

function invalidateSessionRequests() {
    hydration = null;
    return ++sessionEpoch;
}

export const useUserStore = create<UserStore>((set, get) => ({
    user: null,
    status: "idle",
    hydrateSession: async () => {
        if (rejectedOaToken) return;
        if (hydration) return hydration;
        const epoch = sessionEpoch;
        const knownUser = get().user;
        if (!knownUser) set({ status: "loading" });
        const pending = getCurrentSession()
            .then(({ user }) => {
                if (epoch !== sessionEpoch || rejectedOaToken) return;
                set({ user: { ...user, avatarUrl: "" }, status: "authenticated" });
            })
            .catch((error: unknown) => {
                if (epoch !== sessionEpoch || rejectedOaToken) return;
                // Preserve only an identity already verified in this page lifetime.
                // Server APIs still authorize every request; 401/403 fail closed.
                const transient = error instanceof AuthRequestError && (error.status === null || error.status >= 500);
                if (knownUser && transient) return;
                set({ user: null, status: "guest" });
            })
            .finally(() => { if (hydration === pending) hydration = null; });
        hydration = pending;
        return hydration;
    },
    exchangeOaToken: async (token) => {
        // An explicit OA identity takes precedence over any previous browser session.
        const epoch = invalidateSessionRequests();
        rejectedOaToken = true;
        set({ user: null, status: "loading" });
        try {
            const { user } = await exchangeOaToken(token);
            if (epoch !== sessionEpoch) return;
            rejectedOaToken = false;
            set({ user: { ...user, avatarUrl: "" }, status: "authenticated" });
        } catch {
            if (epoch !== sessionEpoch) return;
            // Do not display server errors that might contain credential material.
            set({ user: null, status: "guest" });
        }
    },
    loginWithPassword: async (identifier, password, portal) => {
        const epoch = invalidateSessionRequests();
        rejectedOaToken = true;
        set({ user: null, status: "loading" });
        try {
            const { user } = await loginWithPassword(identifier, password, portal);
            if (epoch !== sessionEpoch) throw new Error("登录请求已被新的身份操作替代");
            const localUser = { ...user, avatarUrl: "" };
            rejectedOaToken = false;
            set({ user: localUser, status: "authenticated" });
            return localUser;
        } catch (error) {
            if (epoch === sessionEpoch) set({ user: null, status: "guest" });
            throw error;
        }
    },
    clearSession: async () => {
        invalidateSessionRequests();
        rejectedOaToken = true;
        set({ user: null, status: "guest" });
        await logoutSession();
    },
    updateUser: (user) => {
        invalidateSessionRequests();
        rejectedOaToken = false;
        set({ user: { ...user, avatarUrl: "" }, status: "authenticated" });
    },
}));

export function isAdminRole(role: ApiUserRole | undefined): role is "super_admin" | "department_admin" {
    return role === "super_admin" || role === "department_admin";
}
