import localforage from "localforage";
import { useStore } from "zustand";
import { createReleaseNotesStore } from "@/lib/release-notes-state";
import { deploymentFeatures } from "@/lib/deployment-features";
import { standaloneEdition } from "@/lib/standalone-edition";
import { listReleaseNotes } from "@/services/api/release-notes";
import { useUserStore } from "./use-user-store";

export function releaseNotesOwner() {
    const { user, status } = useUserStore.getState();
    return !standaloneEdition && deploymentFeatures.authenticationEnabled && status === "authenticated" && user?.status === "active" && !user.mustChangePassword ? user.id : null;
}
const storage = localforage.createInstance({ name: "canvas-release-notes", storeName: "employee_read_state" });
export const releaseNotesStore = createReleaseNotesStore({
    list: listReleaseNotes,
    readSeen: ownerId => storage.getItem(ownerId),
    writeSeen: (ownerId, seen) => storage.setItem(ownerId, seen),
    isCurrentOwner: ownerId => releaseNotesOwner() === ownerId,
    isVisible: () => document.visibilityState === "visible",
});
export const useReleaseNotesStore = <T,>(selector: (state: ReturnType<typeof releaseNotesStore.getState>) => T) => useStore(releaseNotesStore, selector);
