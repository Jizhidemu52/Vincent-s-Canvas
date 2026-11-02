import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

function imageKeys(value: unknown, keys = new Set<string>()): Set<string> {
    if (typeof value === "string" && value.startsWith("image:")) keys.add(value);
    if (value && typeof value === "object") for (const child of Object.values(value)) imageKeys(child, keys);
    return keys;
}

export function verifiedCacheCandidates(projects: CanvasProject[], synchronized: ReadonlySet<string>, protectedData: unknown) {
    const protectedKeys = imageKeys(protectedData);
    const candidates = new Set<string>();
    for (const project of projects) {
        imageKeys(project.history, protectedKeys);
        imageKeys(synchronized.has(project.id) ? { nodes: project.nodes, chatSessions: project.chatSessions } : project, synchronized.has(project.id) ? candidates : protectedKeys);
    }
    return [...candidates].filter(key => !protectedKeys.has(key));
}

/** Exact original bytes and a durable recovery URL are prerequisites for cache eviction. */
export async function evictVerifiedCanvasImages(keys: string[], io: {
    current: () => boolean;
    local: (key: string) => Promise<Blob | null>;
    source: (key: string) => Promise<string | null>;
    remote: (url: string) => Promise<Blob>;
    remember: (key: string, url: string) => Promise<unknown>;
    evict: (key: string) => Promise<void>;
}) {
    let removed = 0, bytes = 0, skipped = 0;
    for (const key of keys) {
        if (!io.current()) break;
        try {
            const local = await io.local(key), source = await io.source(key);
            if (!local || !source || !/^\/api\/assets\/[0-9a-f-]{36}\/content$/i.test(source)) { skipped++; continue; }
            const remote = await io.remote(source);
            if (remote.size !== local.size || !remote.size) { skipped++; continue; }
            const [a, b] = await Promise.all([local.arrayBuffer(), remote.arrayBuffer()]);
            const left = new Uint8Array(a), right = new Uint8Array(b);
            if (!left.every((value, index) => value === right[index])) { skipped++; continue; }
            await io.remember(key, source);
            if (!io.current()) break;
            await io.evict(key);
            removed++; bytes += local.size;
        } catch { skipped++; }
    }
    return { removed, bytes, skipped };
}
