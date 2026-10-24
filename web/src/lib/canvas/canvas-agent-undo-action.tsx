import type { App } from "antd";
import type { CanvasNodeGroup } from "@/types/canvas";
import type { CanvasAgentSnapshot, CanvasAgentUndoReport } from "./canvas-agent-ops";
import { createCanvasAgentUndoPatch, undoCanvasAgentPatch, type CanvasAgentUndoRecord } from "./canvas-agent-undo";
import { canvasAgentUndoMessage } from "./canvas-agent-undo-report";

type RunningRequest = { targetNodeId: string; originNodeId: string; runningNodeId: string };
type UndoFeedback = Pick<ReturnType<typeof App.useApp>, "modal" | "message">;

/** Only a requested inverse needs graph dependency checks and conflict UI. */
export function undoCanvasAgentBatch(current: CanvasAgentSnapshot, record: CanvasAgentUndoRecord, groups: CanvasNodeGroup[], requests: Iterable<RunningRequest>) {
    const patch = "changes" in record ? record : createCanvasAgentUndoPatch(record.before, record.after);
    if (!patch) return { snapshot: current, report: { applied: 0, conflicts: [], retryable: false } satisfies CanvasAgentUndoReport, remaining: null };
    const protectedIds = new Map<string, string>();
    for (const group of groups) {
        const sequence = group.imageSequence;
        const ids = [...group.nodeIds, ...(sequence ? [sequence.sourceNodeId, ...sequence.steps.flatMap(step => [step.configNodeId, step.inputConfigId, step.outputNodeId, ...(step.previousOutputIds || [])])] : [])];
        for (const id of ids) if (id) protectedIds.set(id, "后续款式组或图像序列仍在使用此节点");
    }
    for (const request of requests) {
        for (const id of [request.targetNodeId, request.originNodeId, request.runningNodeId]) protectedIds.set(id, "生成任务仍在使用此节点，请等待任务结束后重试");
    }
    return undoCanvasAgentPatch(current, patch, protectedIds);
}

/** Keep the inverse transaction and its feedback off the initial canvas path. */
export function executeCanvasAgentUndo(input: {
    current: CanvasAgentSnapshot; record: CanvasAgentUndoRecord; groups: CanvasNodeGroup[]; requests: Iterable<RunningRequest>;
    commit: (snapshot: CanvasAgentSnapshot) => void; setRecord: (remaining: CanvasAgentUndoRecord | null) => void; feedback: UndoFeedback;
}) {
    const result = undoCanvasAgentBatch(input.current, input.record, input.groups, input.requests);
    input.setRecord(result.remaining);
    if (result.report.applied) input.commit(result.snapshot);
    showCanvasAgentUndoResult(result.report, input.feedback);
    return { ...result.snapshot, undoReport: result.report };
}

function showCanvasAgentUndoResult(report: CanvasAgentUndoReport, { modal, message }: UndoFeedback) {
    if (report.conflicts.length) modal.warning({
        title: report.applied ? "助手操作已部分撤销" : "助手操作暂未撤销",
        content: <div className="space-y-2"><p>{canvasAgentUndoMessage(report)}</p><ul className="max-h-64 list-disc overflow-auto pl-4 text-xs">{report.conflicts.map((conflict, index) => <li key={`${conflict.location}:${index}`}>{conflict.location}：{conflict.reason}</li>)}</ul></div>,
    });
    else message.success(canvasAgentUndoMessage(report));
}
