import type { AgentDocument, AgentDocumentMedia } from "../../../../shared/image-agent-documents";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { beginChatImageWrite } from "@/services/chat-history-references";

/** Original files and extracted figures own separate immutable blobs. */
export async function mapAgentDocumentMedia(document: AgentDocument, mode: "persist" | "hydrate" | "serialize", assertCurrent: () => void = () => {}): Promise<AgentDocument> {
    const map = async <T extends AgentDocumentMedia>(media: T, image: boolean): Promise<T> => {
        assertCurrent();
        let stored = media;
        if (!media.storageKey && media.dataUrl && !media.dataUrl.startsWith("/api/assets/")) {
            const finish = beginChatImageWrite();
            try {
                const saved = image ? await uploadImage(media.dataUrl) : await uploadMediaFile(media.dataUrl, "document");
                finish(saved.storageKey);
                stored = { ...media, dataUrl: saved.url, storageKey: saved.storageKey, mimeType: saved.mimeType };
            } catch (error) { finish(); throw error; }
            assertCurrent();
        }
        if (stored.storageKey && mode === "hydrate") {
            const dataUrl = image ? await resolveImageUrl(stored.storageKey) : await resolveMediaUrl(stored.storageKey);
            assertCurrent();
            return { ...stored, dataUrl };
        }
        return stored.storageKey && mode === "serialize" ? { ...stored, dataUrl: "" } : stored;
    };
    return { ...document, ...(document.source ? { source: await map(document.source, false) } : {}), figures: await Promise.all(document.figures.map(figure => map(figure, true))) };
}
