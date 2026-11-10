import type { PromptInputData } from "../../../../shared/prompt-contracts";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { workspaceOwnerHeaders } from "./workspace-owner";
import { useUserStore } from "@/stores/use-user-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import { readImageOptions } from "@/lib/image-advanced-settings";

export type GenerationDraftConfig = Pick<AiConfig, "model" | "imageModel" | "size" | "quality" | "count" | "systemPrompt" | "imageOptions">;
export type GenerationDraftInput = { prompt: string; config: GenerationDraftConfig; maskReferenceIndex?: number; markupReferenceIndex?: number };
export type ArchivedReference = { id: string; name: string; role?: string; originalFileName?: string; type: string; bytes: number; sha256: string; url: string; sourceAssetId?: string };
export type GenerationInputArchive = {
    version: 1; ownerId: string; modelConfigId: string; modelId: string;
    prompt: string; userInput?: PromptInputData; optimized?: boolean; effectivePrompt: string; submittedPrompt?: string; config: GenerationDraftConfig;
    parameters: Record<string, unknown>; references: ArchivedReference[];
    maskReferenceIndex?: number;
    markupReferenceIndex?: number;
};
export function generationDraftInput(config: AiConfig, prompt: string): GenerationDraftInput {
    return { prompt, config: { model: config.model, imageModel: config.imageModel, size: config.size, quality: config.quality, count: config.count, systemPrompt: "", imageOptions: config.imageOptions || "" } };
}
export async function fingerprintImage(blob: Blob) {
    return bytesToHex(sha256(new Uint8Array(await blob.arrayBuffer())));
}

/** Read-only and all-or-nothing: callers must apply the returned draft only after this resolves. */
export async function restoreGenerationDraft(taskId: string) {
    const ownerId = useUserStore.getState().user?.id;
    if (!ownerId) throw new Error("当前账号不可用，请重新登录");
    const assertOwner = () => {
        if (useUserStore.getState().user?.id !== ownerId) throw new Error("员工会话已变化，已取消历史恢复");
    };
    const get = async (path: string) => {
        assertOwner();
        const response = await fetch(path, { credentials: "include", headers: workspaceOwnerHeaders() });
        assertOwner();
        if (response.status === 401 || response.status === 403) throw new Error("会话已失效或无权访问，已取消历史恢复");
        if (!response.ok) throw new Error(`历史原文件不可用（${response.status}），请找回原文件后再试；当前草稿未改变`);
        return response;
    };
    const { task } = await (await get(`/api/tasks/${encodeURIComponent(taskId)}`)).json();
    assertOwner();
    const archive = task?.parameters?.inputArchive as GenerationInputArchive | undefined;
    if (!archive || archive.version !== 1) throw new Error("这条旧记录没有完整输入归档，无法完整恢复；可查看结果或复制提示词");
    if (archive.ownerId !== ownerId || (task.userId && task.userId !== ownerId)) throw new Error("无权恢复其他员工的生成记录");
    if (!archive.modelConfigId || !archive.config || (task.modelConfigId && task.modelConfigId !== archive.modelConfigId)
        || typeof archive.prompt !== "string" || typeof archive.effectivePrompt !== "string" || archive.effectivePrompt !== task.prompt
        || !["model", "imageModel", "size", "quality", "count", "systemPrompt"].every(key => typeof archive.config[key as keyof GenerationDraftConfig] === "string")
        || !Array.isArray(archive.references) || !Array.isArray(task.sourceUrls)
        || archive.references.length !== task.sourceUrls.length
        || archive.references.some((item, index) => (item.role !== undefined && typeof item.role !== "string") || item.url !== task.sourceUrls[index] || !/^\/api\/assets\/[a-zA-Z0-9_-]+\/content$/.test(item.url) || !/^[a-f0-9]{64}$/.test(item.sha256))) {
        throw new Error("历史输入归档不完整或顺序不一致，未套用任何参数");
    }
    const { models } = await (await get("/api/models")).json();
    if (!models?.some((model: { id: string; modelId: string }) => model.id === archive.modelConfigId && model.modelId === archive.modelId)) {
        throw new Error("原模型已停用或配置已改变，无法完整恢复；请保留原记录并手动新建草稿");
    }
    const references: ReferenceImage[] = [];
    if (archive.markupReferenceIndex !== undefined && (!Number.isInteger(archive.markupReferenceIndex) || archive.markupReferenceIndex < 1
        || archive.markupReferenceIndex >= archive.references.length || archive.maskReferenceIndex !== undefined)) throw new Error("历史标注层归档索引无效，未套用任何参数");
    for (const [index, item] of archive.references.entries()) {
        const blob = await (await get(item.url)).blob();
        if (blob.size !== item.bytes || await fingerprintImage(blob) !== item.sha256) {
            throw new Error(`第 ${index + 1} 张参考图“${item.name}”不是历史原始字节，已拒绝替换；当前草稿未改变`);
        }
        assertOwner();
        // A data URL retains exactly the validated bytes and cannot change beneath an editor.
        const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("原图读取失败")); reader.readAsDataURL(new Blob([blob], { type: item.type }));
        });
        references.push({ id: `history:${taskId}:${index}`, name: item.name, role: item.role, originalFileName: item.originalFileName, type: item.type, bytes: item.bytes, sourceAssetId: item.sourceAssetId, dataUrl });
    }
    assertOwner();
    const restoredConfig = { ...archive.config, model: archive.modelConfigId, imageModel: archive.modelConfigId };
    if (archive.markupReferenceIndex !== undefined) {
        const markup = references.splice(archive.markupReferenceIndex, 1)[0]!;
        if (markup.type !== "image/png") throw new Error("历史标注层不是 PNG，未套用任何参数");
        restoredConfig.imageOptions = JSON.stringify({ ...readImageOptions(restoredConfig.imageOptions), markup_reference: JSON.stringify(markup) });
    }
    return { prompt: archive.prompt, userInput: archive.userInput || task.userInput, optimized: task.optimized === true, finalPrompt: task.prompt as string, config: restoredConfig, references,
        operationType: String(task.operationType), tool: typeof task.parameters.tool === "string" ? task.parameters.tool : undefined, parameters: { ...archive.parameters }, maskReferenceIndex: archive.maskReferenceIndex };
}
