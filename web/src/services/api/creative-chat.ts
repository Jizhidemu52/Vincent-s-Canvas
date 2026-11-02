import { buildCreativeChatRequest, buildCreativeImageCatalog, MAX_CREATIVE_CHAT_PREVIEW_BYTES, MAX_CREATIVE_CHAT_REFERENCES, parseCreativeChatInspection, parseCreativeChatPlan, resolveCreativeChatReferences, withCreativeChatImageSelection, type CreativeChatImageSelection, type CreativeChatMessage, type CreativeChatPlan } from "@/lib/creative-chat";
import { getDataUrlByteSize } from "@/lib/image-utils";
import { requestToolResponse, toolResponseToInput } from "@/services/api/image";
import { imageToDataUrl } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import { resolveImageAgentFocus, selectImageAgentWorkingSet } from "@/lib/image-agent/focus";

export function creativeChatPreviewSize(width: number, height: number) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new Error("参考图尺寸无效");
    const scale = Math.min(1, 1024 / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function assertCreativeChatReferenceSource(value: string, origin = typeof location === "undefined" ? "" : location.origin) {
    if (/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+={0,2}$/i.test(value)) return;
    if (origin && value.startsWith(`blob:${origin}/`)) return;
    const fallbackOrigin = "https://creative-chat.invalid";
    let url: URL;
    try { url = new URL(value, origin || fallbackOrigin); } catch { throw new Error("参考图地址无效"); }
    if (url.origin !== (origin || fallbackOrigin) || !/^\/api\/assets\/[^/]+\/content$/.test(url.pathname) || url.search || url.hash || url.username || url.password) throw new Error("创作参考图仅支持当前站点素材，请先上传外部图片");
}

async function createPlanningPreview(reference: ReferenceImage, signal?: AbortSignal): Promise<ReferenceImage> {
    signal?.throwIfAborted();
    assertCreativeChatReferenceSource(reference.dataUrl);
    const dataUrl = await imageToDataUrl(reference);
    signal?.throwIfAborted();
    if (!/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+={0,2}$/i.test(dataUrl)) throw new Error("参考图读取结果不是有效图片");
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        const cleanup = () => { signal?.removeEventListener("abort", aborted); element.onload = null; element.onerror = null; };
        const aborted = () => { cleanup(); reject(signal?.reason || new DOMException("Aborted", "AbortError")); };
        element.onload = () => { cleanup(); resolve(element); };
        element.onerror = () => { cleanup(); reject(new Error(`无法读取参考图 ${reference.name}`)); };
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) { aborted(); return; }
        element.src = dataUrl;
    });
    signal?.throwIfAborted();
    const size = creativeChatPreviewSize(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建规划参考图预览");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const preview = canvas.toDataURL("image/jpeg", 0.78);
    if (!preview.startsWith("data:image/") || getDataUrlByteSize(preview) > 1.5 * 1024 * 1024) throw new Error("参考图预览超过 1.5MB，请减少图像复杂度后重试");
    return { ...reference, dataUrl: preview, type: "image/jpeg", storageKey: undefined, width: size.width, height: size.height };
}

/** One planning request normally suffices; an older-image lookup is optional and read-only. */
export async function requestCreativeChatPlan(config: AiConfig, history: CreativeChatMessage[], current: CreativeChatMessage, options: CreativeChatImageSelection & { signal?: AbortSignal; onDelta?: (text: string) => void; onPhase?: (text: string) => void; selectedImageId?: string } = {}): Promise<CreativeChatPlan> {
    options.signal?.throwIfAborted();
    const catalog = buildCreativeImageCatalog(history, current);
    const newCreation = options.newCreation ?? current.newCreation;
    const focus = resolveImageAgentFocus(catalog, { focusId: options.explicitTargetImageId || options.selectedImageId || current.focusImageId || current.editTargetImageId, newCreation });
    const selectedImageId = focus?.id;
    const lockedImageId = options.explicitTargetImageId || (current.focusLocked ? focus?.id : undefined);
    const planningCurrent = withCreativeChatImageSelection(current, catalog, options);
    // This is a structural permission boundary, not keyword-based intent classification.
    // Textless uploads may be read and discussed, but their contents cannot authorize image execution.
    const allowImageCreation = Boolean(current.content.trim());
    let references = resolveCreativeChatReferences(history, current, selectedImageId, catalog, { newCreation, referenceImageIds: options.referenceImageIds });
    const previewCache = new Map<string, ReferenceImage>();
    // Originals remain authoritative for editing; temporary previews never enter lineage or storage.
    const previewsFor = async (originals: ReferenceImage[]) => {
        const previews: ReferenceImage[] = [];
        // Bound simultaneous image decodes while preserving the original working-set order.
        for (let offset = 0; offset < originals.length; offset += 2) {
            options.signal?.throwIfAborted();
            const batch = await Promise.all(originals.slice(offset, offset + 2).map(async (reference) => {
                try {
                    if (!previewCache.has(reference.id)) previewCache.set(reference.id, await createPlanningPreview(reference, options.signal));
                    return previewCache.get(reference.id)!;
                } catch (error) { options.signal?.throwIfAborted(); throw error; }
            }));
            previews.push(...batch.filter((preview): preview is ReferenceImage => Boolean(preview)));
        }
        if (previews.length > MAX_CREATIVE_CHAT_REFERENCES || previews.reduce((total, reference) => total + getDataUrlByteSize(reference.dataUrl), 0) > MAX_CREATIVE_CHAT_PREVIEW_BYTES) throw new Error("参考图预览超过 5 张或 8MB");
        return previews;
    };
    options.onPhase?.("正在理解需求与图片上下文…");
    let previews = await previewsFor(references);
    references = references.filter((item) => previews.some((preview) => preview.id === item.id));
    options.signal?.throwIfAborted();
    const context = { catalog, selectedImageId, lockedImageId, newCreation, referenceImageIds: options.referenceImageIds };
    const requestOptions = {
        tool: "gpt-chat",
        chatProfile: "creative-chat" as const,
        signal: options.signal,
        onToolCallStart: (name: string) => {
            if (name === "edit_image") options.onPhase?.("正在整理图片修改要求…");
            else if (name === "look_at_images") options.onPhase?.("正在查看较早的图片…");
        },
    };
    let prepared = await buildCreativeChatRequest(history, planningCurrent, previews, context);
    let result = await requestToolResponse(config, prepared.messages, [], "auto", options.onDelta, { ...requestOptions, profileContext: prepared.profileContext });
    options.signal?.throwIfAborted();
    const inspectionIds = parseCreativeChatInspection(result, catalog);
    if (inspectionIds) {
        const inspectedWorkingSet = selectImageAgentWorkingSet(catalog, { focusId: selectedImageId, newCreation, explicitIds: [...new Set([...inspectionIds, ...(options.referenceImageIds || [])])] });
        const nextIds = inspectedWorkingSet.map(item => item.id);
        references = inspectedWorkingSet.map(({ id, name, type, dataUrl, storageKey }) => {
            return { id, name, type, dataUrl, ...(storageKey ? { storageKey } : {}) };
        });
        options.onPhase?.("正在查看指定图片，确认修改对象…");
        previews = await previewsFor(references);
        references = references.filter((item) => previews.some((preview) => preview.id === item.id));
        options.signal?.throwIfAborted();
        const inspectedResult = result;
        const initialMessages = prepared.messages.filter(message => typeof message.content === "string");
        prepared = await buildCreativeChatRequest(history, planningCurrent, previews, { ...context, inspectionImageIds: inspectionIds });
        result = await requestToolResponse(config, [
            ...initialMessages,
            ...toolResponseToInput(inspectedResult),
            { role: "tool", tool_call_id: inspectedResult.toolCalls[0]!.id, content: JSON.stringify({ inspected_image_ids: inspectionIds, previewed_image_ids: previews.map((item) => item.id), unavailable_image_ids: nextIds.filter((id) => !previews.some((item) => item.id === id)) }) },
            ...prepared.messages.filter(message => Array.isArray(message.content)),
        ], [], "auto", options.onDelta, { ...requestOptions, profileContext: { ...prepared.profileContext, stage: "continue" } });
        options.signal?.throwIfAborted();
    }
    return parseCreativeChatPlan(result, references, { ...context, previewedImageIds: previews.map((item) => item.id), allowImageCreation });
}
