import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { workspaceOwnerHeaders } from "./workspace-owner";
import { useUserStore } from "@/stores/use-user-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export type GenerationDraftConfig = Pick<AiConfig, "model" | "imageModel" | "size" | "quality" | "count" | "systemPrompt">;
export type GenerationDraftInput = { prompt: string; config: GenerationDraftConfig; maskReferenceIndex?: number };
export type ArchivedReference = { id: string; name: string; originalFileName?: string; type: string; bytes: number; sha256: string; url: string; sourceAssetId?: string };
export type GenerationInputArchive = {
    version: 1; ownerId: string; modelConfigId: string; modelId: string;
    prompt: string; effectivePrompt: string; config: GenerationDraftConfig;
    parameters: Record<string, unknown>; references: ArchivedReference[];
    maskReferenceIndex?: number;
};
export function generationDraftInput(config: AiConfig, prompt: string): GenerationDraftInput {
    return { prompt, config: { model: config.model, imageModel: config.imageModel, size: config.size, quality: config.quality, count: config.count, systemPrompt: config.systemPrompt } };
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
        || archive.references.some((item, index) => item.url !== task.sourceUrls[index] || !/^\/api\/assets\/[a-zA-Z0-9_-]+\/content$/.test(item.url) || !/^[a-f0-9]{64}$/.test(item.sha256))) {
        throw new Error("历史输入归档不完整或顺序不一致，未套用任何参数");
    }
    const { models } = await (await get("/api/models")).json();
    if (!models?.some((model: { id: string; modelId: string }) => model.id === archive.modelConfigId && model.modelId === archive.modelId)) {
        throw new Error("原模型已停用或配置已改变，无法完整恢复；请保留原记录并手动新建草稿");
    }
    const references: ReferenceImage[] = [];
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
        references.push({ id: `history:${taskId}:${index}`, name: item.name, originalFileName: item.originalFileName, type: item.type, bytes: item.bytes, sourceAssetId: item.sourceAssetId, dataUrl });
    }
    assertOwner();
    return { prompt: archive.prompt, config: { ...archive.config, model: archive.modelConfigId, imageModel: archive.modelConfigId }, references,
        operationType: String(task.operationType), tool: typeof task.parameters.tool === "string" ? task.parameters.tool : undefined, parameters: { ...archive.parameters }, maskReferenceIndex: archive.maskReferenceIndex };
}
