import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

type CanvasUiStore = {
    showConnections: boolean;
    setShowConnections: (show: boolean) => void;
    editingProjectId: string | null;
    editingProjectTitle: string;
    selectedProjectIds: string[];
    deleteProjectIds: string[];
    exportingProjectIds: string[];
    beginExport: (ids: string[]) => boolean;
    endExport: () => void;
    startEditingProject: (id: string, title: string) => void;
    setEditingProjectTitle: (title: string) => void;
    stopEditingProject: () => void;
    toggleSelectedProjectId: (id: string, selected: boolean) => void;
    setSelectedProjectIds: (ids: string[]) => void;
    setDeleteProjectIds: (ids: string[]) => void;
    removeSelectedProjectIds: (ids: string[]) => void;
};

export const useCanvasUiStore = create<CanvasUiStore>()(persist((set, get) => ({
    showConnections: true,
    setShowConnections: (showConnections) => set({ showConnections }),
    editingProjectId: null,
    editingProjectTitle: "",
    selectedProjectIds: [],
    deleteProjectIds: [],
    exportingProjectIds: [],
    beginExport: (ids) => {
        if (get().exportingProjectIds.length || !ids.length) return false;
        set({ exportingProjectIds: ids });
        return true;
    },
    endExport: () => set({ exportingProjectIds: [] }),
    startEditingProject: (editingProjectId, editingProjectTitle) => set({ editingProjectId, editingProjectTitle }),
    setEditingProjectTitle: (editingProjectTitle) => set({ editingProjectTitle }),
    stopEditingProject: () => set({ editingProjectId: null }),
    toggleSelectedProjectId: (id, selected) => set((state) => ({ selectedProjectIds: selected ? [...new Set([...state.selectedProjectIds, id])] : state.selectedProjectIds.filter((item) => item !== id) })),
    setSelectedProjectIds: (ids) => set({ selectedProjectIds: [...new Set(ids)] }),
    setDeleteProjectIds: (deleteProjectIds) => set({ deleteProjectIds }),
    removeSelectedProjectIds: (ids) => set((state) => ({ selectedProjectIds: state.selectedProjectIds.filter((id) => !ids.includes(id)) })),
}), {
    name: "wireless-canvas:canvas_view",
    storage: createJSONStorage(() => localStorage),
    // A browser view preference is not part of any saved canvas document.
    partialize: (state) => ({ showConnections: state.showConnections }),
    merge: (saved, current) => ({
        ...current,
        showConnections: saved && typeof saved === "object" && "showConnections" in saved && typeof saved.showConnections === "boolean" ? saved.showConnections : current.showConnections,
    }),
}));
