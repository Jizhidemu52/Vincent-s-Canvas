const confirmedStatuses = new Set(["waiting", "processing", "success"]);

export function proposalSubmission(value) {
    const id = typeof value === "string" ? value : typeof value?.id === "string" ? value.id : "";
    return {
        id,
        requestId: typeof value?.requestId === "string" ? value.requestId : "",
        status: id && typeof value?.status === "string" ? value.status : "unknown",
        failureReason: typeof value?.failureReason === "string" ? value.failureReason : "",
    };
}

export function proposalSubmissionMessage(value) {
    const receipt = proposalSubmission(value);
    const label = ({ waiting: "服务器排队中", processing: "模型处理中", success: "任务已完成", failed: "提交失败", uncertain: "提交待确认", submitting: "提交待确认", paused: "任务已暂停", cancelled: "任务已取消" })[receipt.status] || "请求已记录，状态待核实";
    return label + (receipt.failureReason ? `：${receipt.failureReason}` : "");
}

export function assertProposalSubmission(value) {
    const receipt = proposalSubmission(value);
    if (!confirmedStatuses.has(receipt.status)) throw new Error(`${proposalSubmissionMessage(receipt)}；已保留原请求，请在任务岛查询。剩余方案暂停，不会重复生成。`);
}
