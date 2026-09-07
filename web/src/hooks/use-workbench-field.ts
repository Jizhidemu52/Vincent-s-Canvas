import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { useStore } from "zustand";
import { createWorkbenchSessionStore } from "@/stores/workbench-session-store";
import { useUserStore } from "@/stores/use-user-store";

const session = createWorkbenchSessionStore();
session.getState().activate(useUserStore.getState().user?.id || null);
useUserStore.subscribe((state) => session.getState().activate(state.user?.id || null));

/** Retains form/filter input across routes; signing out clears the session. */
export function useWorkbenchField<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
    const ownerId = useUserStore((state) => state.user?.id || null);
    const fallback = useRef(initial).current;
    const value = useStore(session, (state) => state.ownerId === ownerId && key in state.values ? state.values[key] as T : fallback);
    const update = useCallback<Dispatch<SetStateAction<T>>>((next) => {
        session.getState().update(ownerId, key, next, fallback);
    }, [ownerId, key, fallback]);
    return [value, update];
}
