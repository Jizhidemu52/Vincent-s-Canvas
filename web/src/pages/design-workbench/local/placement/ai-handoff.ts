import { createClientUuid } from "@/lib/client-uuid";
import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { createImageReferenceItem } from "@/lib/image-reference-policy";
import { uploadImage, resolveImageUrl } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";
import { isModuleAvailable, useModuleStore } from "@/stores/use-module-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import type { ImageReferenceItem } from "@/types/image";
import { isWorkspaceRole } from "../../../../../../shared/workspace-access";
import type { AiConfig } from "@/stores/use-config-store";

type PlacementProject = {
    base: { src: string; width: number; height: number; name: string };
    layers: Array<{ src: string; name: string; x: number; y: number; width: number; aspect: number; rotation: number; opacity: number; visible: boolean }>;
};
type Handoff = { ownerId: string; prompt: string; references: ImageReferenceItem[] };
type Storage = Pick<ReturnType<typeof createWorkspaceStorage>, "getItem" | "setItem" | "removeItem">;
type Dependencies = { ownerId: string; assertCurrent: () => void; handoffs: Storage; drafts: Storage; upload: typeof uploadImage; resolve: typeof resolveImageUrl; id: () => string };

export function placementHandoffToken(params: URLSearchParams, tool: string) {
    const token = params.get("placementToken");
    return tool === "image-edit" && token && /^[\w-]{1,80}$/.test(token) ? token : null;
}

export const placementDraftScope = (token: string) => `image-edit:placement:${token}`;

export function placementAiPrompt(project: PlacementProject) {
    const layers = project.layers.filter(layer => layer.visible && layer.opacity > 0);
    const sources = [...new Set(layers.map(layer => layer.src))];
    const percent = (value: number, total: number) => `${Math.round(value / total * 10000) / 100}%`;
    return [
        "根据图1的已确认定位合成图，生成一张真实服装印花效果图。",
        "参考图分工：图1为最终构图与位置基准；图2为未修改的服装原图，只用于保留版型、面料、颜色、背景、光线与拍摄角度；图3为图案原稿编号对照，只用于核对图案，不要把编号、底色或网格印到衣服上。",
        "锁定图1的画幅、服装轮廓和每个图案的位置、大小、旋转角度、形状、颜色、元素数量及相互层次；不得重新排版、移动、放大、裁切、增删或重绘图案。",
        "只让图案顺应原有面料纹理、明暗及细微褶皱，形成自然印花融合；不要改变服装结构或新增褶皱、装饰、文字和配件。图案原稿与定位冲突时，以图1的位置和尺寸为准。",
        `底图尺寸：${project.base.width} × ${project.base.height} 像素。以下坐标以底图左上角为原点，X/Y 为图案中心；宽高均相对底图。`,
        ...layers.map((layer, index) => `图层${index + 1}（图3原稿${sources.indexOf(layer.src) + 1}，${layer.name}）：X ${percent(layer.x, project.base.width)}，Y ${percent(layer.y, project.base.height)}，宽 ${percent(layer.width, project.base.width)}，高 ${percent(layer.width / layer.aspect, project.base.height)}，旋转 ${layer.rotation}°，不透明度 ${Math.round(layer.opacity * 100)}%。`),
        "输出仅包含完整服装效果图，不要参考图拼版、尺寸线、选择框或说明文字。AI 结果需再核对定位，不能替代生产定位稿。",
    ].join("\n");
}

/** Handoff data and its isolated destination draft are employee-partitioned IndexedDB records. */
export function createPlacementHandoff(deps: Dependencies) {
    const { ownerId, assertCurrent, handoffs, drafts } = deps;
    return {
        async prepare(project: PlacementProject, composite: Blob, artwork: Blob) {
            assertCurrent();
            if (!project.layers.some(layer => layer.visible && layer.opacity > 0)) throw new Error("请先添加并显示至少一个图案，再生成 AI 效果图。");
            const token = deps.id();
            const inputs = [
                { source: composite, name: "图1-定位合成图.png" },
                { source: project.base.src, name: "图2-服装原图" },
                { source: artwork, name: "图3-图案原稿对照.png" },
            ];
            const references: ImageReferenceItem[] = [];
            for (const input of inputs) {
                assertCurrent();
                const image = await deps.upload(input.source);
                assertCurrent();
                references.push(createImageReferenceItem({ id: deps.id(), name: input.name, type: image.mimeType, dataUrl: "", storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes }, "upload"));
            }
            await handoffs.setItem<Handoff>(token, { ownerId, prompt: placementAiPrompt(project), references });
            assertCurrent();
            return `/image?${new URLSearchParams({ tool: "image-edit", placementToken: token })}`;
        },
        async consume(token: string) {
            assertCurrent();
            if (!/^[\w-]{1,80}$/.test(token)) throw new Error("定位结果链接无效，请返回定位工作台重新带入。");
            const scope = placementDraftScope(token);
            const payload = await handoffs.getItem<Handoff>(token);
            assertCurrent();
            if (payload && payload.ownerId !== ownerId) throw new Error("定位结果不属于当前员工账号。");
            // The marker permits reloads of a consumed token without replaying the original payload over newer edits.
            const restored = payload || (await drafts.getItem<boolean>(`${scope}:ready`) ? {
                ownerId, prompt: await drafts.getItem<string>(`${scope}:prompt`) ?? "",
                references: await drafts.getItem<ImageReferenceItem[]>(`${scope}:references`) ?? [],
            } : null);
            if (!restored) throw new Error("定位结果未找到，请返回定位工作台重新带入；原工程不会丢失。");
            const settings = await drafts.getItem<Partial<AiConfig>>(payload ? "image-edit:settings" : `${scope}:settings`) || {};
            const references = await Promise.all(restored.references.map(async reference => {
                assertCurrent();
                const dataUrl = await deps.resolve(reference.storageKey);
                assertCurrent();
                if (!dataUrl) throw new Error("定位参考图暂时无法读取，请重试；原交接记录仍保留。");
                return { ...reference, dataUrl };
            }));
            if (payload) {
                // Persist the whole destination before consuming the source; failed hydration/writes stay retryable.
                await drafts.setItem(`${scope}:prompt`, restored.prompt);
                assertCurrent();
                await drafts.setItem(`${scope}:references`, references.map(reference => ({ ...reference, dataUrl: "" })));
                assertCurrent();
                await drafts.setItem(`${scope}:settings`, settings);
                assertCurrent();
                await drafts.setItem(`${scope}:ready`, true);
                assertCurrent();
                await handoffs.removeItem(token);
            }
            assertCurrent();
            return { prompt: restored.prompt, references, settings };
        },
    };
}

export function placementAiAccess(signal?: AbortSignal) {
    const ownerId = useUserStore.getState().user?.id;
    const assertCurrent = () => {
        signal?.throwIfAborted();
        const state = useUserStore.getState();
        if (!ownerId || state.user?.id !== ownerId || state.user.status !== "active" || state.status !== "authenticated" || !isWorkspaceRole(state.user.role)) throw new Error("当前设计师会话不可用，请重新进入工作台。");
        for (const moduleKey of ["pattern-placement", "image-edit"] as const) {
            if (!isModuleAvailable(useModuleStore.getState().flags, useBusinessConfigStore.getState().tools, moduleKey)) throw new Error("图案定位或图片编辑已由管理员关闭，无法带入生成。");
        }
    };
    assertCurrent();
    return createPlacementHandoff({ ownerId: ownerId!, assertCurrent, handoffs: createWorkspaceStorage("placement_ai_handoffs"), drafts: createWorkspaceStorage("generation_drafts"), upload: uploadImage, resolve: resolveImageUrl, id: createClientUuid });
}

const pending = new Map<string, ReturnType<ReturnType<typeof placementAiAccess>["consume"]>>();
export function consumePlacementAiHandoff(token: string) {
    const key = `${useUserStore.getState().user?.id}:${token}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const task = Promise.resolve().then(() => placementAiAccess().consume(token));
    pending.set(key, task);
    void task.finally(() => { if (pending.get(key) === task) pending.delete(key); }).catch(() => undefined);
    return task;
}
