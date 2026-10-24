import { createWorkspaceStorage } from "@/lib/workspace-storage";

type ReferenceStore = { iterate<T, U>(iterator: (value: T, key: string, iteration: number) => U): Promise<U> };
const store = createWorkspaceStorage("app_state");
const transientKeys = new Set<string>();
let mediaWrites = 0;
let revision = 0;

/** Drafts and not-yet-committed history also own their freshly uploaded blobs. */
export function beginChatImageWrite() {
    mediaWrites++; revision++;
    return (storageKey?: string) => {
        if (storageKey) transientKeys.add(storageKey);
        mediaWrites--; revision++;
    };
}

export function chatImageCleanupGuard() {
    const before = revision;
    return () => {
        if (mediaWrites || before !== revision) throw new Error("聊天图片正在保存，本次跳过本地图片清理");
    };
}

/** Include retained legacy snapshots and per-session records; failed reads abort cleanup. */
export async function collectChatImageReferences(source: ReferenceStore = store): Promise<Set<string>> {
    const keys = new Set(transientKeys);
    const collect = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
        Object.values(value).forEach(collect);
    };
    await source.iterate((value: unknown, key: string) => {
        if (!key.startsWith("wireless-canvas:llm-chat:")) return;
        collect(typeof value === "string" ? JSON.parse(value) : value);
    });
    return keys;
}
