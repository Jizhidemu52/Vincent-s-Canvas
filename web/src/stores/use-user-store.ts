import { create } from "zustand";
import { persist } from "zustand/middleware";

export type LocalUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    role: "designer" | "admin";
};

type UserStore = {
    user: LocalUser | null;
    login: (user: LocalUser) => void;
    clearSession: () => void;
};

export const useUserStore = create<UserStore>()(
    persist(
        (set) => ({
            user: null,
            login: (user) => set({ user }),
            clearSession: () => set({ user: null }),
        }),
        { name: "wireless-canvas:user_store" },
    ),
);
