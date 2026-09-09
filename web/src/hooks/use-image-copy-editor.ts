import { useEffect, useRef, useState } from "react";
import { createImageEditCopySession, type ImageCopySource, type SavedImageCopy } from "@/lib/image-edit-copy";
import type { UploadedImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";

type EditSession = ReturnType<typeof createImageEditCopySession>;

/** Both history and asset pages share the same account-bound, copy-only save flow. */
export function useImageCopyEditor(onSaved?: (copy: SavedImageCopy, image: UploadedImage) => void) {
    const [session, setSession] = useState<EditSession | null>(null);
    const sessionRef = useRef<EditSession | null>(null);
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;
    const close = () => { sessionRef.current?.invalidate(); sessionRef.current = null; setSession(null); };
    useEffect(() => {
        const unsubscribe = useUserStore.subscribe((current, previous) => {
            if (current.user?.id !== previous.user?.id) close();
        });
        return () => { unsubscribe(); sessionRef.current?.invalidate(); sessionRef.current = null; };
    }, []);
    return {
        node: session?.node,
        open(source: ImageCopySource) {
            sessionRef.current?.invalidate();
            const next = createImageEditCopySession(source, useUserStore.getState().user?.id || "unassigned");
            sessionRef.current = next;
            setSession(next);
        },
        close,
        async confirm(image: UploadedImage) {
            if (!session || session !== sessionRef.current) throw new Error("编辑会话已失效，请重新打开原图");
            const store = useAssetStore.getState();
            const copy = session.save(image, useUserStore.getState().user?.id || "unassigned", store.assets, store.addAsset);
            onSavedRef.current?.(copy, image);
        },
    };
}
