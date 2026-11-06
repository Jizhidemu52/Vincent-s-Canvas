import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { beginChatImageWrite } from "@/services/chat-history-references";
import type { ChatSession } from "./chat-types";
import { mapAgentDocumentMedia } from "@/lib/image-agent/document-media";

type Media = { dataUrl?: string; storageKey?: string; mimeType?: string };
type MediaDependencies = { upload: typeof uploadImage; resolve: typeof resolveImageUrl };

/** The same attachment can appear in several branches; store its bytes only once. */
export function createChatMedia(dependencies: MediaDependencies = { upload: uploadImage, resolve: resolveImageUrl }) {
    const pending = new WeakMap<Media, Promise<Media>>();
    const persist = async <T extends Media>(image: T, assertCurrent: () => void = () => {}): Promise<T> => {
        assertCurrent();
        if (image.storageKey) return image;
        if (!image.dataUrl) return image;
        let saving = pending.get(image);
        if (!saving) {
            const finish = beginChatImageWrite();
            saving = dependencies.upload(image.dataUrl).then((stored) => {
                finish(stored.storageKey);
                return { ...image, dataUrl: stored.url, storageKey: stored.storageKey, mimeType: stored.mimeType, width: stored.width, height: stored.height, bytes: stored.bytes };
            }, (error) => { finish(); throw error; });
            pending.set(image, saving);
            void saving.catch(() => { if (pending.get(image) === saving) pending.delete(image); });
        }
        const saved = await saving;
        assertCurrent();
        return saved as T;
    };
    const hydrate = async <T extends Media>(image: T, assertCurrent: () => void): Promise<T> => {
        const saved = await persist(image, assertCurrent);
        if (!saved.storageKey) return saved;
        assertCurrent();
        const dataUrl = await dependencies.resolve(saved.storageKey);
        assertCurrent();
        // Do not invent a replacement or drop the saved key if its blob is missing.
        return { ...saved, dataUrl };
    };
    const mapSession = async (session: ChatSession, map: <T extends Media>(image: T) => Promise<T>) => ({
        ...session,
        messages: await Promise.all(session.messages.map(async (message) => ({
            ...message,
            ...(message.attachments ? { attachments: await Promise.all(message.attachments.map((item) => item.storageKey || (item.dataUrl && item.kind !== "text") ? map(item) : item)) } : {}),
            ...(message.generatedImages ? { generatedImages: await Promise.all(message.generatedImages.map(map)) } : {}),
        }))),
    });
    return {
        persist,
        hydrate,
        async hydrateSession(session: ChatSession, assertCurrent: () => void) {
            return { ...await mapSession(session, (image) => hydrate(image, assertCurrent)), ...(session.documents ? { documents: await Promise.all(session.documents.map(document => mapAgentDocumentMedia(document, "hydrate", assertCurrent))) } : {}) };
        },
        async serializeSession(session: ChatSession) {
            const savedSession = await mapSession(session, async (image) => {
                const saved = await persist(image);
                return saved.storageKey ? { ...saved, dataUrl: "" } : saved;
            });
            return { ...savedSession, ...(session.documents ? { documents: await Promise.all(session.documents.map(document => mapAgentDocumentMedia(document, "serialize"))) } : {}) };
        },
    };
}

export const chatMedia = createChatMedia();
