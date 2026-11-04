import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { recoverChatImageTask, type PendingChatImageTask } from "@/services/api/chat-image-recovery";
import { watchTaskReconciliation } from "@/services/api/task-result-reconciliation";
import { chatMedia } from "./chat-media";
import { completeChatImageTask } from "./chat-image-tasks";
import { restoreChatMaskResult } from "@/lib/image-agent/mask";
import type { ChatGeneratedImage, ChatMessage, ChatSession } from "./chat-types";

type RecoveryJob = { controller: AbortController; query: (resumePaused: boolean) => Promise<void> };

/** One observer per saved request. No generation call exists in this recovery path. */
export function useChatTaskRecovery(options: {
    storageKey: string; session?: ChatSession; ready: boolean;
    sessionsRef: MutableRefObject<ChatSession[]>;
    activeRequestIds: ReadonlySet<string>;
    isCurrentScope: () => boolean;
    updateSession: (id: string, update: (session: ChatSession) => ChatSession) => void;
    persist: () => Promise<void>;
}) {
    const latest = useRef(options); latest.current = options;
    const jobs = useRef(new Map<string, RecoveryJob>());
    const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
    const sessionId = options.session?.id;
    const signature = (options.session?.messages || []).filter(item => item.pendingImageTask).map(item => `${item.id}:${item.pendingImageTask!.requestId}:${options.activeRequestIds.has(item.pendingImageTask!.requestId)}`).join("|");
    useEffect(() => {
        setChecking(new Set());
        return () => { for (const job of jobs.current.values()) job.controller.abort(); jobs.current.clear(); };
    }, [options.storageKey, sessionId]);
    useEffect(() => {
        if (!options.ready || !sessionId) return;
        const pendingMessages = (options.session?.messages || []).filter(item => item.pendingImageTask && !options.activeRequestIds.has(item.pendingImageTask.requestId));
        const wanted = new Set(pendingMessages.map(item => item.id));
        for (const [id, job] of jobs.current) if (!wanted.has(id)) { job.controller.abort(); jobs.current.delete(id); }
        for (const message of pendingMessages) {
            if (jobs.current.has(message.id)) continue;
            const pending = message.pendingImageTask!;
            const controller = new AbortController(), signal = controller.signal;
            let savedPending = pending, querying = false, settled = false, watching = false;
            const current = () => !signal.aborted && latest.current.storageKey === options.storageKey && latest.current.session?.id === sessionId && latest.current.isCurrentScope();
            const stillPending = () => current() && latest.current.sessionsRef.current.find(session => session.id === sessionId)?.messages.some(item => item.id === message.id && item.pendingImageTask?.requestId === pending.requestId);
            const save = async (update: (session: ChatSession) => ChatSession) => {
                if (!stillPending()) return;
                latest.current.updateSession(sessionId, update);
                if (current()) await latest.current.persist();
            };
            const updateMessage = (update: (message: ChatMessage) => ChatMessage) => save(session => ({ ...session, messages: session.messages.map(item => item.id === message.id && item.pendingImageTask?.requestId === pending.requestId ? update(item) : item), updatedAt: new Date().toISOString() }));
            const query = async (resumePaused: boolean) => {
                if (!stillPending() || querying || settled) return;
                querying = true; setChecking(previous => new Set(previous).add(message.id));
                try {
                    const result = await recoverChatImageTask(savedPending, { signal, snapshotOnly: true, resumePaused,
                        onTask: async task => {
                            savedPending = { ...savedPending, taskId: task.id, taskStatus: task.status, upstreamTaskId: task.upstreamTaskId || null, taskFailureReason: task.failureReason || null };
                            await updateMessage(item => ({ ...item, stopped: undefined, pendingImageTask: savedPending }));
                        },
                    });
                    if (!stillPending()) return;
                    if (result.kind === "success") {
                        const assertCurrent = () => { if (!stillPending()) throw new DOMException("会话已切换", "AbortError"); };
                        const images: ChatGeneratedImage[] = [];
                        for (const [index, url] of result.resultUrls.entries()) {
                            const dataUrl = await restoreChatMaskResult(pending, url); assertCurrent();
                            images.push(await chatMedia.persist({ id: `${result.task.id}:${index}`, dataUrl, prompt: pending.prompt, modelId: pending.modelId, quality: pending.quality, resolution: pending.resolution, parentId: pending.parentId, workId: pending.workId, workNote: pending.workNote, lineage: pending.lineage, sourceTaskId: result.task.id, ...(url.startsWith("/api/assets/") ? { sourceResultUrl: url } : {}), ...(pending.regionComposite ? { regionComposite: pending.regionComposite } : {}) }, assertCurrent));
                        }
                        await save(session => completeChatImageTask(session, message.id, pending, images, true));
                        settled = true;
                    } else if (result.kind === "failed") {
                        await updateMessage(item => { const { pendingImageTask: _pending, stopped: _stopped, ...saved } = item; return { ...saved, role: "error", content: result.content }; });
                        settled = true;
                    } else {
                        savedPending = { ...savedPending, recovery: result.recovery };
                        await updateMessage(item => ({ ...item, pendingImageTask: savedPending, content: result.content }));
                    }
                } catch (error) {
                    if (stillPending()) {
                        if (savedPending.taskStatus === "success" && (pending.regionComposite || pending.maskAdaptation)) {
                            savedPending = { ...savedPending, recovery: "investigate" };
                            await updateMessage(item => ({ ...item, pendingImageTask: savedPending, content: `原任务已出图，但局部结果处理未完成：${error instanceof Error ? error.message : "处理失败"}。原始 AI 结果仍保留在原任务中；恢复原图和选区后查询，不会重新生成。` }));
                        } else await updateMessage(item => ({ ...item, content: `原任务状态暂未读取完成：${error instanceof Error ? error.message : "读取失败"}。可以继续聊天或发送不同的新要求；请勿重复提交这条原任务。` }));
                    }
                } finally {
                    querying = false;
                    if (current()) setChecking(previous => { const next = new Set(previous); next.delete(message.id); return next; });
                    if (settled) controller.abort();
                }
            };
            const observe = async (resumePaused: boolean) => {
                await query(resumePaused);
                if (watching || !stillPending() || settled || savedPending.recovery === "investigate" || savedPending.recovery === "resume") return;
                watching = true;
                await watchTaskReconciliation({ taskIds: savedPending.taskId ? [savedPending.taskId] : [], signal,
                    reconcile: () => savedPending.recovery === "investigate" || savedPending.recovery === "resume" ? Promise.resolve() : query(false) });
            };
            jobs.current.set(message.id, { controller, query: resumePaused => observe(resumePaused).catch(() => undefined) });
            if (!message.stopped) void observe(false).catch(() => undefined);
        }
    }, [options.ready, options.storageKey, sessionId, signature]);
    return { checking, query(message: ChatMessage) { void jobs.current.get(message.id)?.query(message.pendingImageTask?.recovery === "resume"); } };
}
