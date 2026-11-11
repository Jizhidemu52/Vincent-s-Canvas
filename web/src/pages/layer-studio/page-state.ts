import type { LayerStudioMode, LayerStudioResultDocument } from "../../../../shared/layer-studio";
import { validateLayerStudioOptions, type LayerStudioOptions } from "../../../../shared/layer-studio-options";
import type { LayerStudioEditDocument } from "./layer-composition";
import type { QueuedTask } from "@/services/api/generation-tasks";
import type { LayerStudioSubmission } from "@/services/api/layer-studio";

export type LayerStudioForm = { mode: LayerStudioMode; prompt: string; sizeMode: "tier" | "ratio" | "exact"; tier: "auto" | "1K" | "1.5K" | "2K"; ratio: string; width: number; height: number; background: "auto" | "opaque" | "transparent"; format: "png" | "jpeg"; maxImages: number; ocr: boolean; watermark: boolean; contentCheck: boolean };
export type LayerStudioReference = { id: string; name: string; mimeType: string; bytes: number; sha256: string; width?: number; height?: number; previewable: boolean };
export type LayerStudioJob = { requestId: string; ownerId: string; workspaceId: string; createdAt: number; submission: LayerStudioSubmission; phase: "submitting" | "pending" | "uncertain" | "complete" | "failed"; taskId?: string; taskStatus?: string; upstreamAccepted?: boolean; document?: LayerStudioResultDocument; edit?: LayerStudioEditDocument; notice?: string };
export type LayerStudioWorkspace = { version: 1; ownerId: string; workspaceId: string; form: LayerStudioForm; references: LayerStudioReference[]; jobs: LayerStudioJob[]; selectedRequestId?: string };
export const initialLayerStudioForm = (): LayerStudioForm => ({ mode: "decompose", prompt: "", sizeMode: "tier", tier: "auto", ratio: "1:1", width: 1536, height: 1024, background: "auto", format: "png", maxImages: 30, ocr: false, watermark: false, contentCheck: true });
export const newLayerStudioWorkspace = (ownerId: string, workspaceId: string): LayerStudioWorkspace => ({ version: 1, ownerId, workspaceId, form: initialLayerStudioForm(), references: [], jobs: [] });

export function layerStudioParameters(form: LayerStudioForm): LayerStudioOptions {
    const common = { n: 1 as const, output_format: form.background === "transparent" && form.mode === "generate" ? "png" as const : form.format,
        watermark: form.watermark, nsfw_check: form.contentCheck, optimize_prompt_options: { mode: "standard" as const } };
    if (form.mode === "decompose") return { ...common, size: form.tier, layer_decomposition: true, layer_decomposition_options: { max_images: form.maxImages, text_recognition: form.ocr } };
    const tier = form.tier === "auto" ? "2K" : form.tier;
    return { ...common, background: form.background, size: form.sizeMode === "exact" ? `${form.width}x${form.height}` : form.sizeMode === "ratio" ? form.ratio : tier,
        ...(form.sizeMode === "ratio" ? { resolution: tier } : {}) };
}

export function layerStudioSubmission(workspace: LayerStudioWorkspace, requestId: string): LayerStudioSubmission {
    const parameters = validateLayerStudioForm(workspace.form, workspace.references.length);
    return { requestId, projectId: `layer-studio:${workspace.workspaceId}`, operationType: "image_generation", toolKey: "layer-studio",
        prompt: workspace.form.prompt.trim(), parameters, sourceUrls: workspace.references.map(item => `/api/assets/${encodeURIComponent(item.id)}/content`), priority: "normal" };
}
export function validateLayerStudioForm(form: LayerStudioForm, sourceCount: number) {
    // The provider also accepts 1x1 as a ratio alias; an exact-pixel UI must not silently reinterpret it.
    if (form.mode === "generate" && form.sizeMode === "exact" && (!Number.isSafeInteger(form.width) || !Number.isSafeInteger(form.height)
        || form.width < 1 || form.height < 1 || form.width * form.height < 921_600 || form.width * form.height > 4_624_220
        || form.width / form.height < 1 / 16 || form.width / form.height > 16)) throw new Error("精确尺寸需 921600–4624220 总像素，宽高比 1/16–16。");
    return validateLayerStudioOptions(layerStudioParameters(form), form.prompt, sourceCount);
}
export const unresolvedLayerStudioJob = (job: LayerStudioJob) => ["submitting", "pending", "uncertain"].includes(job.phase);

/** Keep only public, useful result fields. Raw errors and parameters may contain supplier names. */
export function applyLayerStudioSnapshot(job: LayerStudioJob, task: QueuedTask): LayerStudioJob {
    if (task.requestId !== job.requestId || (job.taskId && task.id !== job.taskId) || (task.userId && task.userId !== job.ownerId) || (task.ownerUserId && task.ownerUserId !== job.ownerId)) throw new Error("任务身份不匹配，未覆盖原记录。");
    const document = task.resultDocument?.taskId === task.id ? task.resultDocument : job.document;
    const phase = task.status === "success" && document?.status === "ready" ? "complete"
        : ["failed", "cancelled"].includes(task.status) ? "failed"
            : task.status === "paused" || task.stage === "submission_unknown" ? "uncertain" : "pending";
    return { ...job, taskId: task.id, taskStatus: task.status, upstreamAccepted: Boolean(task.upstreamTaskId), phase, document,
        notice: phase === "failed" ? "任务未完成；原输入与已保存结果保留。请在新任务中修改输入。"
            : phase === "uncertain" ? "原任务待核查；只恢复查询或保存，不会重新生成。" : undefined };
}

export function readLayerStudioWorkspace(value: unknown, ownerId: string, workspaceId: string) {
    if (value === null || value === undefined) return newLayerStudioWorkspace(ownerId, workspaceId);
    const record = value as LayerStudioWorkspace;
    if (record.version !== 1 || record.ownerId !== ownerId || record.workspaceId !== workspaceId || !record.form || !Array.isArray(record.references) || !Array.isArray(record.jobs)
        || record.jobs.some(job => job.ownerId !== ownerId || job.workspaceId !== workspaceId)) throw new Error("工作区记录无法安全读取，未覆盖已有数据。");
    return { ...record, jobs: record.jobs.map(job => job.phase === "submitting" ? { ...job, phase: "uncertain" as const, notice: "上次提交待核查；保留原请求编号，只查询原任务。" } : job) };
}
