import { useEffect, useRef, useState } from "react";
import { App } from "antd";
import type { ImageSequenceOptions, ImageSequenceSession } from "./canvas-image-sequence-runtime";

export function useCanvasImageSequence(options: ImageSequenceOptions) {
    const { message } = App.useApp();
    const latest = useRef(options); latest.current = options;
    const [dialog, setDialog] = useState<{ sourceId: string } | { groupId: string } | null>(null);
    const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
    const active = useRef<ImageSequenceSession | null>(null);
    const adding = useRef(false);
    useEffect(() => {
        setDialog(null); setActiveGroupId(null);
        return () => { active.current?.controller.abort(); active.current = null; };
    }, [options.projectId]);

    const add = async (sourceId: string, steps: import("@/lib/canvas/canvas-image-sequence").ImageSequenceStep[], model?: string) => {
        if (adding.current) return;
        adding.current = true;
        const projectId = latest.current.projectId;
        try {
            const { addCanvasImageSequence } = await import("./canvas-image-sequence-runtime");
            if (latest.current.projectId !== projectId) return;
            const created = addCanvasImageSequence(latest.current, sourceId, steps, model);
            setDialog(null);
            message.success("已创建并连接工作流，可直接编辑节点，点击“运行工作流”开始");
            return created.nodes[0];
        } catch (error) { message.error(error instanceof Error ? error.message : "添加失败"); }
        finally { adding.current = false; }
    };
    const run = async (groupId?: string, nodeId?: string) => {
        const current = latest.current;
        if (active.current || current.locks.current.size) { message.info("请先完成或停止当前任务"); return; }
        const projectId = current.projectId;
        const lockKey = `image-sequence:${nodeId || groupId}`;
        const session: ImageSequenceSession = { groupId: groupId || "", nodeId, controller: new AbortController() };
        active.current = session; current.locks.current.add(lockKey);
        const isCurrent = () => latest.current.projectId === projectId && active.current === session;
        try {
            const { runCanvasImageSequence } = await import("./canvas-image-sequence-runtime");
            if (!isCurrent() || session.controller.signal.aborted) return;
            await runCanvasImageSequence(() => latest.current, session, lockKey, isCurrent, setActiveGroupId);
        } catch (error) {
            if (isCurrent()) message.error(error instanceof Error ? error.message : "连续改图加载失败，请重试");
        } finally {
            current.locks.current.delete(lockKey);
            if (active.current === session) { active.current = null; if (latest.current.projectId === projectId) setActiveGroupId(null); }
        }
    };
    const stop = () => {
        const session = active.current;
        if (!session) return;
        session.controller.abort();
        if (session.configId) latest.current.stopGeneration(session.configId);
    };
    return { dialog, setDialog, activeGroupId, add, run, runFromNode: (nodeId: string) => run(undefined, nodeId), stop };
}
