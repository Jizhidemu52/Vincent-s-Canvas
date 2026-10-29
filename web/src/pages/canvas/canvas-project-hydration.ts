import { restoreAgentMediaWorkflow } from "@/lib/canvas/agent-media-workflow";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { CanvasNodeType, type CanvasAssistantSession, type CanvasNodeData } from "@/types/canvas";
import { hasPendingImageTask, imageMetadata, INTERRUPTED_IMAGE_TASK_ERROR } from "./canvas-project-utils";
import { boundedCanvasHistory, type CanvasHistoryEntry } from "./use-canvas-history";

export function createCanvasHydrationContext() {
    return {
        restored: new WeakMap<object, Promise<object>>(),
        interrupted: new WeakMap<object, object>(),
        uploads: new Map<string, Promise<UploadedImage>>(),
        workflowSessions: new WeakMap<CanvasNodeData[], WeakMap<CanvasAssistantSession[], Promise<CanvasAssistantSession[]>>>(),
    };
}

type CanvasHydrationContext = ReturnType<typeof createCanvasHydrationContext>;

function memoCanvasHydration<T extends object>(context: CanvasHydrationContext, source: T, restore: () => Promise<T>): Promise<T> {
    const previous = context.restored.get(source);
    if (previous) return previous as Promise<T>;
    const pending = restore();
    context.restored.set(source, pending);
    return pending;
}

async function mapCanvasHydration<T>(items: T[], restore: (item: T) => T | Promise<T>): Promise<T[]> {
    let result: Array<T | Promise<T>> | undefined;
    for (let index = 0; index < items.length; index += 1) {
        const restored = restore(items[index]);
        if (restored !== items[index]) {
            result ||= items.slice();
            result[index] = restored;
        }
    }
    if (!result) return items;
    const resolved = await Promise.all(result);
    return resolved.every((item, index) => item === items[index]) ? items : resolved;
}

function uploadCanvasHydrationImage(content: string, context: CanvasHydrationContext) {
    let pending = context.uploads.get(content);
    if (!pending) {
        pending = uploadImage(content);
        context.uploads.set(content, pending);
    }
    return pending;
}

function sameCanvasHydrationValue(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => sameCanvasHydrationValue(value, right[index]));
    if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) || Array.isArray(right)) return false;
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameCanvasHydrationValue(a[key], b[key]));
}

export async function hydrateCanvasHistory(history?: { past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] }, context = createCanvasHydrationContext()) {
    const bounded = boundedCanvasHistory(history);
    const hydrate = async (entry: CanvasHistoryEntry): Promise<CanvasHistoryEntry> => {
        const nodes = await hydrateCanvasImages(resetInterruptedGeneration(entry.nodes, context), context);
        const chatSessions = await hydrateAssistantImages(entry.chatSessions || [], nodes, context);
        return nodes === entry.nodes && chatSessions === entry.chatSessions ? entry : { ...entry, nodes, chatSessions };
    };
    return { past: await Promise.all(bounded.past.map(hydrate)), future: await Promise.all(bounded.future.map(hydrate)) };
}

export async function hydrateCanvasImages(nodes: CanvasNodeData[], context = createCanvasHydrationContext()) {
    return memoCanvasHydration(context, nodes, () => mapCanvasHydration(nodes, (node) => {
            const content = node.metadata?.content;
            // Keep persisted media lazy. CanvasNode resolves its Blob URL only after
            // virtualization mounts the node, instead of opening every file on load.
            if ((node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && node.metadata?.storageKey) return node;
            if (node.type !== CanvasNodeType.Image || !content) return node;
            if (node.metadata?.storageKey) return node;
            if (!content.startsWith("data:image/")) return node;
            return memoCanvasHydration(context, node, async () => ({ ...node, metadata: { ...node.metadata, ...imageMetadata(await uploadCanvasHydrationImage(content, context)) } }));
        }));
}

export async function hydrateAssistantImages(sessions: CanvasAssistantSession[], nodes: CanvasNodeData[], context = createCanvasHydrationContext()) {
    const hydrateItem = <T extends { dataUrl?: string; storageKey?: string }>(item: T): T | Promise<T> => {
        // Agent chat previews resolve storage-backed media only when their
        // message card mounts. Do not open every historical Blob on project load.
        if (item.storageKey) return item;
        if (item.dataUrl?.startsWith("data:image/")) {
            return memoCanvasHydration(context, item, async () => {
                const image = await uploadCanvasHydrationImage(item.dataUrl!, context);
                return { ...item, dataUrl: image.url, storageKey: image.storageKey };
            });
        }
        return item;
    };
    // Reference imports are independent of a historical graph, and shared
    // messages must not be cloned/uploaded once per undo frame.
    const restored = await memoCanvasHydration(context, sessions, () => mapCanvasHydration(sessions, session => memoCanvasHydration(context, session, async () => {
        const messages = await mapCanvasHydration(session.messages, message => {
            if (!message.references?.length) return message;
            return memoCanvasHydration(context, message, async () => {
                const references = await mapCanvasHydration(message.references!, hydrateItem);
                return references === message.references ? message : { ...message, references };
            });
        });
        return messages === session.messages ? session : { ...session, messages };
    })));
    if (!restored.some(session => session.messages.some(message => message.detail?.mediaWorkflow))) return restored;
    // Workflow URLs/status do depend on each frame's nodes; do not reuse the
    // current graph's workflow result when hydrating an earlier undo state.
    let cache = context.workflowSessions.get(nodes);
    if (!cache) { cache = new WeakMap(); context.workflowSessions.set(nodes, cache); }
    let pending = cache.get(restored);
    if (!pending) {
        pending = mapCanvasHydration(restored, async session => {
            const messages = await mapCanvasHydration(session.messages, message => {
                const workflow = message.detail?.mediaWorkflow;
                if (!workflow) return message;
                const next = restoreAgentMediaWorkflow(workflow, nodes);
                return sameCanvasHydrationValue(workflow, next) ? message : { ...message, detail: { ...message.detail, mediaWorkflow: next } };
            });
            return messages === session.messages ? session : { ...session, messages };
        });
        cache.set(restored, pending);
    }
    return pending;
}

export function resetInterruptedGeneration(nodes: CanvasNodeData[], context = createCanvasHydrationContext()) {
    const cached = context.interrupted.get(nodes);
    if (cached) return cached as CanvasNodeData[];
    let result: CanvasNodeData[] | undefined;
    for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (node.metadata?.status !== "loading") continue;
        let restored = context.interrupted.get(node) as CanvasNodeData | undefined;
        if (!restored) {
            restored = { ...node, metadata: { ...node.metadata, status: "error", errorDetails: node.type === CanvasNodeType.Video && node.metadata.videoTaskId ? "页面刷新中断了本地查询，可恢复原视频任务，不会重新生成。" : hasPendingImageTask(node, nodes) ? INTERRUPTED_IMAGE_TASK_ERROR : "页面刷新后生成已中断，请重新生成。" } };
            context.interrupted.set(node, restored);
        }
        result ||= nodes.slice();
        result[index] = restored;
    }
    context.interrupted.set(nodes, result || nodes);
    return result || nodes;
}
