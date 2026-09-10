import { buildCreativeChatRequestMessages, buildCreativeChatTools, MAX_CREATIVE_CHAT_PREVIEW_BYTES, parseCreativeChatPlan, resolveCreativeChatReferences, type CreativeChatMessage, type CreativeChatPlan } from "@/lib/creative-chat";
import { getDataUrlByteSize } from "@/lib/image-utils";
import { requestToolResponse } from "@/services/api/image";
import { imageToDataUrl } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

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
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error(`无法读取参考图 ${reference.name}`));
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

/** One model decision only. This service never uploads, creates, or retries tasks. */
export async function requestCreativeChatPlan(config: AiConfig, history: CreativeChatMessage[], current: CreativeChatMessage, options: { signal?: AbortSignal; onDelta?: (text: string) => void } = {}): Promise<CreativeChatPlan> {
    options.signal?.throwIfAborted();
    const references = resolveCreativeChatReferences(history, current);
    // Originals remain authoritative for editing; only these temporary copies go to the planner.
    const previews: ReferenceImage[] = [];
    for (const reference of references) previews.push(await createPlanningPreview(reference, options.signal));
    if (previews.reduce((total, reference) => total + getDataUrlByteSize(reference.dataUrl), 0) > MAX_CREATIVE_CHAT_PREVIEW_BYTES) throw new Error("参考图预览总大小超过 8MB");
    options.signal?.throwIfAborted();
    const result = await requestToolResponse(config, buildCreativeChatRequestMessages(history, current, previews), buildCreativeChatTools(), "auto", options.onDelta, { signal: options.signal });
    options.signal?.throwIfAborted();
    return parseCreativeChatPlan(result, references);
}
