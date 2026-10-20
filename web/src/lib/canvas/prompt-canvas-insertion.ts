import { nanoid } from "nanoid";
import { placeCanvasImageOutputs } from "@/lib/canvas/canvas-image-output-placement";
import { deploymentFeatures } from "@/lib/deployment-features";
import { resolveCompletePrompt } from "@/lib/prompt-template-reuse";
import { canvasHistoryForSave } from "@/pages/canvas/use-canvas-history";
import { flushCanvasPersistence, loadCanvasProject, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export class PromptCanvasPersistenceError extends Error {
    constructor(public readonly projectId: string, cause: unknown) {
        super("提示词已加入画布，但尚未保存成功。请在画布中重试保存，不要重复插入。", { cause });
        this.name = "PromptCanvasPersistenceError";
    }
}

/** Uses the same private project, history and durable-save path as the editor. Never generates. */
export async function insertPromptIntoCanvas(templateId: string, targetProjectId: string | undefined, assertCurrent: () => void) {
    const assertWorkspace = () => {
        assertCurrent();
        if (deploymentFeatures.authenticationEnabled && useUserStore.getState().user?.role !== "designer") throw new Error("请使用设计师身份进入个人画布");
        if (!useCanvasStore.getState().hydrated) throw new Error("个人画布仍在加载，请稍后重试");
    };
    assertWorkspace();
    if (targetProjectId) {
        const loaded = await loadCanvasProject(targetProjectId);
        assertWorkspace();
        if (!loaded) throw new Error("目标画布已不存在，请重新选择");
    }
    const payload = await resolveCompletePrompt(templateId, "fill", assertWorkspace);
    assertWorkspace();
    const template = payload.template;
    if (!template.prompt.trim()) throw new Error("模板提示词为空，未插入画布");
    const state = useCanvasStore.getState();
    const projectId = targetProjectId || state.createProject(`${template.title} · 提示词草稿`);
    // Re-read after asynchronous authorization/loading so concurrent edits are preserved.
    const project = useCanvasStore.getState().openProject(projectId);
    if (!project) throw new Error("目标画布已被删除，提示词未插入");
    const width = typeof window === "undefined" ? 1200 : window.innerWidth;
    const height = typeof window === "undefined" ? 800 : window.innerHeight;
    const scale = Number.isFinite(project.viewport.k) && project.viewport.k > 0 ? project.viewport.k : 1;
    const size = { width: 420, height: 300 };
    const center = { x: (width / 2 - project.viewport.x) / scale, y: (height / 2 - project.viewport.y) / scale };
    const node: CanvasNodeData = {
        id: nanoid(), type: CanvasNodeType.Text, title: template.title, ...size,
        position: placeCanvasImageOutputs(project.nodes, [], size, center),
        metadata: {
            content: template.prompt, status: "idle",
            promptTemplateSource: {
                templateId: template.id, versionId: template.currentVersionId, version: template.version,
                title: template.title, targetTool: template.targetTool, modelConfigId: template.modelConfigId,
                modelSnapshot: template.modelSnapshot, parameters: template.parameters,
                referenceAssetIds: template.referenceAssetIds, sourceTaskId: template.sourceTaskId, sourceAssetId: template.sourceAssetId,
                resolvedModel: payload.pricing.selectedModel, warnings: payload.warnings,
            },
        },
    };
    const nodes = [...project.nodes, node];
    const previous = {
        nodes: project.nodes, connections: project.connections, groups: project.groups,
        chatSessions: project.chatSessions, activeChatId: project.activeChatId,
        backgroundMode: project.backgroundMode, showImageInfo: project.showImageInfo,
    };
    const history = canvasHistoryForSave(project.history || { past: [], future: [] }, previous, { ...previous, nodes }, false);
    // No await between the latest project read and this append.
    useCanvasStore.getState().updateProject(projectId, {
        nodes, history,
        viewport: { k: scale, x: width / 2 - (node.position.x + node.width / 2) * scale, y: height / 2 - (node.position.y + node.height / 2) * scale },
    });
    try { await flushCanvasPersistence(); }
    catch (error) {
        assertCurrent();
        throw new PromptCanvasPersistenceError(projectId, error);
    }
    assertWorkspace();
    if (!useCanvasStore.getState().openProject(projectId)?.nodes.some(item => item.id === node.id)) throw new Error("目标画布或提示词节点已被删除，未完成插入");
    return { projectId, nodeId: node.id, warnings: payload.warnings };
}
