import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import type { ConversationImageItem } from "@/components/conversation-image-controls";
import { useUserStore } from "@/stores/use-user-store";

const noImages: readonly ConversationImageItem[] = [];
type Catalog = { images: readonly ConversationImageItem[]; scopeKey: string; isCurrent: (image: ConversationImageItem) => boolean };
const CanvasMentionImagesContext = createContext<Catalog>({ images: noImages, scopeKey: "", isCurrent: () => false });

/** Current-canvas/current-conversation catalog only; movement never invalidates it. */
export function CanvasMentionImagesProvider({ images, scopeKey, children }: { images: readonly ConversationImageItem[]; scopeKey: string; children: ReactNode }) {
    const owner = useUserStore(state => `${state.status}:${state.user?.id || ""}`);
    const mounted = useRef(true);
    useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const stable = useRef<Catalog | null>(null);
    if (!stable.current || stable.current.scopeKey !== `${owner}:${scopeKey}` || stable.current.images.length !== images.length || images.some((image, index) => {
        const previous = stable.current!.images[index];
        return !previous || previous.id !== image.id || previous.name !== image.name || previous.label !== image.label
            || previous.source !== image.source || previous.dataUrl !== image.dataUrl || previous.storageKey !== image.storageKey || previous.unavailableReason !== image.unavailableReason;
    })) {
        const catalog: Catalog = { images, scopeKey: `${owner}:${scopeKey}`, isCurrent: image => {
            const account = useUserStore.getState();
            return mounted.current && stable.current === catalog && `${account.status}:${account.user?.id || ""}` === owner
                && catalog.images.some(current => current.id === image.id && current.source === image.source && current.storageKey === image.storageKey && current.dataUrl === image.dataUrl && !current.unavailableReason);
        } };
        stable.current = catalog;
    }
    return <CanvasMentionImagesContext.Provider value={stable.current}>{children}</CanvasMentionImagesContext.Provider>;
}

export function useCanvasMentionImages() { return useContext(CanvasMentionImagesContext); }
