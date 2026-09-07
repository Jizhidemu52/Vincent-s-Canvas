import { createStore } from "zustand/vanilla";

/** Small, tab-session-only drafts. Never stores media bytes or credentials. */
export function createWorkbenchSessionStore() {
    return createStore<{
        ownerId: string | null;
        values: Record<string, unknown>;
        activate: (ownerId: string | null) => void;
        update: <T>(ownerId: string | null, key: string, value: T | ((previous: T) => T), fallback: T) => void;
    }>((set) => ({
        ownerId: null,
        values: {},
        activate: (ownerId) => set((state) => state.ownerId === ownerId ? state : { ownerId, values: {} }),
        update: (ownerId, key, value, fallback) => set((state) => {
            if (state.ownerId !== ownerId) return state;
            const previous = key in state.values ? state.values[key] : fallback;
            const next = typeof value === "function" ? (value as (previous: unknown) => unknown)(previous) : value;
            return Object.is(previous, next) ? state : { values: { ...state.values, [key]: next } };
        }),
    }));
}
