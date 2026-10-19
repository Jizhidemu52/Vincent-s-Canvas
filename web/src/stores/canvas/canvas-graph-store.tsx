import { createContext, useCallback, useContext, useState, type ReactNode, type SetStateAction } from "react";
import { createStore, useStore } from "zustand";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export type CanvasGraphFields = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: Set<string>;
    selectedConnectionId: string | null;
    hoveredNodeId: string | null;
    toolbarNodeId: string | null;
    streamedTextById: ReadonlyMap<string, string>;
};
type CanvasGraphState = CanvasGraphFields & {
    nodeById: ReadonlyMap<string, CanvasNodeData>;
    setField: <K extends keyof CanvasGraphFields>(key: K, value: SetStateAction<CanvasGraphFields[K]>) => void;
};

/** Ephemeral editor state, never persisted; each open editor has its own scope. */
export function createCanvasGraphStore() {
    return createStore<CanvasGraphState>((set) => ({
        nodes: [], connections: [], nodeById: new Map(), selectedNodeIds: new Set(),
        selectedConnectionId: null, hoveredNodeId: null, toolbarNodeId: null, streamedTextById: new Map(),
        setField: (key, value) => set(state => {
            const next = typeof value === "function" ? (value as (previous: typeof state[typeof key]) => typeof state[typeof key])(state[key]) : value;
            if (Object.is(state[key], next)) return state;
            return { [key]: next, ...(key === "nodes" ? { nodeById: new Map((next as CanvasNodeData[]).map(node => [node.id, node])) } : {}) } as Partial<CanvasGraphState>;
        }),
    }));
}
type CanvasGraphStore = ReturnType<typeof createCanvasGraphStore>;
const CanvasGraphContext = createContext<CanvasGraphStore | null>(null);

export function CanvasGraphProvider({ children }: { children: ReactNode }) {
    const [store] = useState(createCanvasGraphStore);
    return <CanvasGraphContext.Provider value={store}>{children}</CanvasGraphContext.Provider>;
}
export function useCanvasGraphStore<T>(selector: (state: CanvasGraphState) => T) {
    const store = useContext(CanvasGraphContext);
    if (!store) throw new Error("Canvas graph scope is missing");
    return useStore(store, selector);
}
export function useCanvasGraphSetter<K extends keyof CanvasGraphFields>(key: K) {
    const setField = useCanvasGraphStore(state => state.setField);
    return useCallback((value: SetStateAction<CanvasGraphFields[K]>) => setField(key, value), [key, setField]);
}
export function useCanvasGraphField<K extends keyof CanvasGraphFields>(key: K) {
    const value = useCanvasGraphStore(state => state[key]);
    const setValue = useCanvasGraphSetter(key);
    return [value, setValue] as const;
}
