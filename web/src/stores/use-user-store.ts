import { create } from "zustand";

import { AuthRequestError, exchangeOaToken, getCurrentSession, loginWithPassword, logoutSession, type ApiUser, type ApiUserRole } from "@/services/api/auth";
import { broadcastWorkspaceIdentity } from "@/lib/workspace-session-events";
import { isWorkspaceRole } from "../../../shared/workspace-access";

export type LocalUser = ApiUser & { avatarUrl: string };
export type AuthStatus = "idle" | "loading" | "authenticated" | "expired" | "guest";

type UserStore = {
    user: LocalUser | null;
    status: AuthStatus;
    hydrateSession: () => Promise<void>;
    exchangeOaToken: (token: string) => Promise<void>;
    loginWithPassword: (identifier: string, password: string, portal: "designer" | "admin") => Promise<LocalUser>;
    clearSession: () => Promise<void>;
    invalidateSession: () => void;
    expireSession: () => void;
    reauthenticate: (password: string) => Promise<void>;
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
                // Expired sessions retain only their old local drafts, not API authority.
                const transient = error instanceof AuthRequestError && (error.status === null || error.status >= 500);
                if (knownUser && transient) return;
                if (knownUser && error instanceof AuthRequestError && error.status === 401) {
                    set({ user: knownUser, status: "expired" });
                    return;
                }
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
            broadcastWorkspaceIdentity(isWorkspaceRole(user.role) ? user.id : null);
        } catch {
            if (epoch !== sessionEpoch) return;
            // Do not display server errors that might contain credential material.
            set({ user: null, status: "guest" });
            broadcastWorkspaceIdentity(null);
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
            broadcastWorkspaceIdentity(isWorkspaceRole(user.role) ? user.id : null);
            return localUser;
        } catch (error) {
            if (epoch === sessionEpoch) set({ user: null, status: "guest" });
            throw error;
        }
    },
    clearSession: async () => {
        const epoch = invalidateSessionRequests();
        const previouslyRejected = rejectedOaToken;
        rejectedOaToken = true;
        // Clearing identity synchronously restarts the app and can cancel the
        // logout request before the server invalidates its cookie. Keep only
        // this already-verified identity until the server confirms logout.
        try { await logoutSession(); }
        catch (error) {
            // A revoked/expired session is already logged out server-side. Only
            // outages or other failures should preserve the current identity.
            if (!(error instanceof AuthRequestError && error.status === 401)) {
                if (epoch === sessionEpoch) rejectedOaToken = previouslyRejected;
                throw error;
            }
        }
        if (epoch !== sessionEpoch) return;
        broadcastWorkspaceIdentity(null);
        set({ user: null, status: "guest" });
    },
    invalidateSession: () => {
        invalidateSessionRequests();
        rejectedOaToken = true;
        set({ user: null, status: "guest" });
    },
    expireSession: () => {
        if (get().status !== "authenticated" || !get().user) return;
        invalidateSessionRequests();
        set({ status: "expired" });
    },
    reauthenticate: async (password) => {
        const previous = get().user;
        if (!previous || get().status !== "expired") throw new Error("请重新打开登录页面");
        const epoch = invalidateSessionRequests();
        rejectedOaToken = true;
        let user: ApiUser;
        try { ({ user } = await loginWithPassword(previous.username, password, isAdminRole(previous.role) ? "admin" : "designer")); }
        finally { if (epoch === sessionEpoch) rejectedOaToken = false; }
        if (epoch !== sessionEpoch) throw new Error("登录请求已被新的身份操作替代");
        // A different identity may never resume the old employee's mounted tools.
        if (user.id !== previous.id || user.role !== previous.role || user.status !== "active") {
            set({ user: null, status: "guest" });
            broadcastWorkspaceIdentity(null);
            throw new Error("登录账号已变化，请重新进入工作区");
        }
        rejectedOaToken = false;
        set({ user: { ...user, avatarUrl: "" }, status: "authenticated" });
        broadcastWorkspaceIdentity(isWorkspaceRole(user.role) ? user.id : null);
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
