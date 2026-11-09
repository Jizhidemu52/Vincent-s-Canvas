import { uiText } from "@/lib/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { App } from "antd";
import type { ImageSequenceOptions, ImageSequenceSession } from "./canvas-image-sequence-runtime";
import { createClientId } from "@/lib/client-id";
import { stopCanvasObservation } from "@/lib/canvas/canvas-project-async-lifecycle";
import { useUserStore } from "@/stores/use-user-store";

export function useCanvasImageSequence(options: ImageSequenceOptions) {
    const { message } = App.useApp();
    const ownerKey = useUserStore(state => JSON.stringify([state.user?.id, state.user?.status, state.user?.role]));
    const currentOwnerKey = () => { const user = useUserStore.getState().user; return JSON.stringify([user?.id, user?.status, user?.role]); };
    const renderedProjectId = options.projectId;
    const renderedScope = useMemo(() => ({ active: false }), [renderedProjectId, ownerKey]);
    const latest = useRef(options); latest.current = options;
    const [dialog, setDialog] = useState<{ sourceId: string } | { groupId: string } | null>(null);
    const [activeGroupIds, setActiveGroupIds] = useState<ReadonlySet<string>>(new Set());
    const active = useRef(new Set<ImageSequenceSession>());
    const scope = useRef<object | null>(null);
    const adding = useRef(false);
    const isRenderCurrent = () => renderedScope.active && scope.current === renderedScope && latest.current.projectId === renderedProjectId && currentOwnerKey() === ownerKey && (latest.current.isObservationCurrent?.() ?? true);
    useEffect(() => {
        const token = renderedScope; token.active = true; scope.current = token;
        setDialog(null); setActiveGroupIds(new Set());
        return () => {
            token.active = false;
            if (scope.current === token) scope.current = null;
            for (const session of active.current) {
                stopCanvasObservation(session.controller);
                session.releaseLocks?.();
                if (session.lockKey) options.locks.current.delete(session.lockKey);
            }
            active.current.clear();
        };
    }, [renderedScope]);

    const add = async (sourceId: string, steps: import("@/lib/canvas/canvas-image-sequence").ImageSequenceStep[], model?: string) => {
        if (!isRenderCurrent() || adding.current) return;
        adding.current = true;
        const projectId = renderedProjectId;
        const token = renderedScope;
        const isCurrent = () => token !== null && scope.current === token && latest.current.projectId === projectId && currentOwnerKey() === ownerKey && (latest.current.isObservationCurrent?.() ?? true);
        try {
            const { addCanvasImageSequence } = await import("./canvas-image-sequence-runtime");
            if (!isCurrent() || (latest.current.waitForWriteAccess && !await latest.current.waitForWriteAccess()) || !isCurrent()) return;
            const created = addCanvasImageSequence(latest.current, sourceId, steps, model);
            setDialog(null);
            message.success(uiText("已创建并连接工作流，可直接编辑节点，点击“运行工作流”开始"));
            return created.nodes[0];
        } catch (error) { if (isCurrent()) message.error(error instanceof Error ? error.message : uiText("添加失败")); }
        finally { adding.current = false; }
    };
    const run = async (groupId?: string, nodeId?: string, onlyStep?: boolean, rerun = false) => {
        if (!isRenderCurrent()) return;
        const current = latest.current;
        const projectId = renderedProjectId;
        const token = renderedScope;
        const lockKey = `image-sequence:${createClientId()}`;
        const session: ImageSequenceSession = { groupId: groupId || "", nodeId, controller: new AbortController(), lockKey, rerunStepId: rerun ? nodeId : undefined, onlyStep };
        active.current.add(session); current.locks.current.add(lockKey);
        const sameScope = () => token !== null && scope.current === token && latest.current.projectId === projectId && currentOwnerKey() === ownerKey;
        const isCurrent = () => sameScope() && active.current.has(session) && (latest.current.isObservationCurrent?.() ?? true);
        const refreshActive = () => setActiveGroupIds(new Set([...active.current].filter(item => item.configNodeIds).map(item => item.groupId)));
        try {
            const { runCanvasImageSequence } = await import("./canvas-image-sequence-runtime");
            if (!isCurrent() || session.controller.signal.aborted) return;
            await runCanvasImageSequence(() => latest.current, session, lockKey, isCurrent, refreshActive, active.current);
        } catch (error) {
            if (isCurrent()) message.error(error instanceof Error ? error.message : uiText("连续改图加载失败，请重试"));
        } finally {
            current.locks.current.delete(lockKey);
            session.releaseLocks?.();
            const visible = sameScope();
            active.current.delete(session);
            if (visible) refreshActive();
        }
    };
    const stop = (groupId?: string, nodeId?: string) => {
        if ((!groupId && !nodeId) || !isRenderCurrent()) return;
        for (const session of active.current) {
            if ((groupId && session.groupId !== groupId) || (nodeId && session.nodeId !== nodeId && !session.configNodeIds?.has(nodeId))) continue;
            session.controller.abort();
            if (session.configId) latest.current.stopGeneration(session.configId);
        }
    };
    return { dialog, setDialog, activeGroupIds, add, run, runFromNode: (nodeId: string) => run(undefined, nodeId), rerunStep: (nodeId: string, onlyStep = false) => run(undefined, nodeId, onlyStep, true), stop };
}
