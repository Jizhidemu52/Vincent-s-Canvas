export const EXAMPLES = {
    color: { prompt: "保留版型和针织纹理，把这件毛衣改成深海军蓝。", title: "海军蓝配色" },
    sketch: { prompt: "保留服装结构，把这件毛衣转换成干净的黑白款式图。", title: "黑白款式图" },
};

const profiles = new Set(["seedream55", "quality-resolution", "quality-resolution-v2", "gpt", "gemini", "pixel", "resolution", "resolution-1k", "standard", "standard-flex", "standard-flex-plus", "mai-image", "mai-image-v2", "qwen-image"]);
export const activeStatuses = new Set(["preparing", "submitting", "waiting", "processing"]);
export const ownedAsset = value => typeof value === "string" && /^\/api\/assets\/[0-9a-f-]{36}\/content$/i.test(value);

export function availableModels(catalog, referenceCount) {
    const tool = catalog?.tools?.find(item => item.toolKey === (referenceCount ? "image-edit" : "image"));
    if (!tool?.enabled) return [];
    return (catalog.models || []).filter(model => profiles.has(model.imageParameterProfile)
        && model.capabilities?.includes(referenceCount ? "edit" : "generate")
        && (!tool.modelConfigId || tool.modelConfigId === model.id));
}

export function imageParameters(model, referenceCount) {
    const profile = model.imageParameterProfile;
    if (!profiles.has(profile)) throw new Error("这个模型的图片参数尚未接入设计讨论。");
    if ((profile === "mai-image" || profile === "mai-image-v2") && referenceCount) return { count: 1 };
    if (profile === "mai-image-v2" || profile === "qwen-image") return { size: "1:1", resolution: "1k", count: 1 };
    if (profile === "seedream55") return { size: "auto", resolution: "1k", n: 1, count: 1 };
    if (profile.startsWith("quality-resolution")) return { size: "auto", quality: "auto", resolution: "1k", count: 1 };
    if (profile.startsWith("standard")) return { size: "auto", quality: "auto", count: 1 };
    return { size: "auto", resolution: "1k", count: 1 };
}

export function taskLabel(task) {
    if (task.persistenceError) return "回执保存中断 · 请查询原任务，勿重复生成";
    if (task.queryError) return "查询中断 · 保留原任务，可刷新查询";
    if (task.observing === false) return "已停止本页查询 · 后台任务未取消";
    if (task.status === "preparing") return "正在准备参考图 · 尚未提交";
    if (task.status === "uncertain" || task.status === "submitting") return "提交待确认 · 不会自动重发";
    if (task.status === "waiting") return "服务器排队中";
    if (task.status === "processing") return ({ queued: "服务器排队中", submitted: "模型处理中", polling: "查询模型进展", saving: "保存生成结果" })[task.stage] || "模型处理中";
    if (task.status === "needs_input") return task.failureReason || "需要补充设计要求，未创建图片任务";
    if (task.status === "detached") return "已停止采用本轮结果 · 原任务仍按实际进度处理";
    if (task.status === "success") return task.resultUrls?.length ? "真实结果已放入画布" : "任务已完成 · 结果链接暂不可用";
    if (task.status === "paused") return task.failureReason || "任务暂停 · 可查询原任务";
    if (task.status === "failed") return task.failureReason || "任务失败";
    if (task.status === "cancelled") return "服务器任务已取消";
    return "等待任务信息";
}

export function designResultNodeId(task, index) {
    const version = task.resultVersions?.[index];
    return version ? `design-version-${version.id}` : `design-${task.id}-${index}`;
}

export function designTaskMetadata(task) {
    const loading = !task.queryError && !task.persistenceError && task.observing !== false && (activeStatuses.has(task.status) || task.status === "success");
    const label = task.status === "success" ? "生成已完成 · 正在放入画布" : taskLabel(task);
    return { status: loading ? "loading" : "error", errorDetails: loading ? undefined : label,
        sourceTaskId: task.taskId, designTask: { requestId: task.requestId, status: task.status, label } };
}

export function mergeServerTask(local, task, ownerId) {
    const owner = task?.ownerUserId ?? task?.userId;
    if (!task?.id || owner !== ownerId || (task.ownerUserId && task.userId && task.ownerUserId !== task.userId) || task.requestId !== local.requestId || (local.projectId && task.projectId && task.projectId !== local.projectId)) throw new Error("任务身份不匹配，已停止接收结果。");
    return { ...local, taskId: task.id, status: task.status, stage: task.stage, upstreamTaskId: task.upstreamTaskId,
        failureReason: task.failureReason || "", resultUrls: (task.resultUrls || []).filter(ownedAsset), queryError: "" };
}
