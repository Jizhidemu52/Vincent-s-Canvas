import { ownedAsset } from "./task-model.mjs";

export function messageTasks(session, message, index, tasks) {
    if (message.role !== "assistant") return [];
    const batchId = message.proposalBatchId || (index === session.history.findLastIndex(item => item.role === "assistant") ? session.proposalBatch?.id : null);
    return tasks.filter(task => (!task.discussionSessionId || task.discussionSessionId === session.id)
        && ((message.id && task.discussionMessageId === message.id) || (batchId && task.proposal?.batchId === batchId)));
}

export function resultDiscussionReference(task, index) {
    const image = task.resultUrls?.[index];
    if (task.status !== "success" || task.mediaKind === "video" || !ownedAsset(image)) throw new Error("这项任务尚无可供讨论的图片结果。");
    return { id: `design-${task.id}-${index}`, title: task.proposal?.title || "生成结果", image, role: "base", kind: "result", taskId: task.taskId, parentId: task.references?.[0]?.id };
}
