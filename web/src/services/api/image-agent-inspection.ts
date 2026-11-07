import { getDataUrlByteSize } from "@/lib/image-utils";
import { parseStrictJson } from "@/lib/strict-json";
import { assertCreativeChatReferenceSource } from "@/services/api/creative-chat";
import { requestToolResponse, type AiTextMessage } from "@/services/api/image";
import { resolveImageUrl } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import { parseImageAgentEditSpec, parseImageAgentReview, type ImageAgentEditSpec, type ImageAgentReview } from "../../../../shared/image-agent-iteration";

type InspectionOptions = { signal?: AbortSignal; assertCurrent?: () => void };
const checkCurrent = (options: InspectionOptions) => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };

/** Temporary inspection pixels only: never replace a stored original or generation input. */
async function inspectionPreview(reference: ReferenceImage, options: InspectionOptions) {
    checkCurrent(options);
    const source = await resolveImageUrl(reference.storageKey, reference.dataUrl || reference.url || "");
    checkCurrent(options);
    if (!source) throw new Error("检查所需图片已不可用；原结果保留，没有重新出图。");
    assertCreativeChatReferenceSource(source);
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        const cleanup = () => { options.signal?.removeEventListener("abort", aborted); element.onload = null; element.onerror = null; };
        const aborted = () => { cleanup(); element.src = ""; reject(options.signal?.reason || new DOMException("Aborted", "AbortError")); };
        element.onload = () => { cleanup(); resolve(element); };
        element.onerror = () => { cleanup(); reject(new Error("检查所需图片读取失败；原结果保留，没有重新出图。")); };
        options.signal?.addEventListener("abort", aborted, { once: true });
        if (options.signal?.aborted) { aborted(); return; }
        element.src = source;
    });
    checkCurrent(options);
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new Error("检查图片尺寸无效");
    const scale = Math.min(1, 1600 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建检查预览");
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const preview = canvas.toDataURL("image/jpeg", 0.9);
    if (!preview.startsWith("data:image/jpeg;base64,") || getDataUrlByteSize(preview) > 3 * 1024 * 1024) throw new Error("检查预览超过3MB，请缩小图片后再检查；原结果保留。");
    return preview;
}

/** Explicit, read-only review. No generation, retries, corrections or storage writes. */
export async function requestImageAgentReview(config: AiConfig, options: InspectionOptions & {
    profile: "creative-chat" | "canvas-assistant";
    base?: ReferenceImage;
    result: ReferenceImage;
    prompt: string;
    spec?: ImageAgentEditSpec;
}): Promise<ImageAgentReview> {
    checkCurrent(options);
    const references = [...(options.base ? [options.base] : []), options.result];
    if (references.some(image => !image.id.trim() || image.id.length > 300) || new Set(references.map(image => image.id)).size !== references.length) throw new Error("检查底图与结果身份无效，请重新选择实际版本。");
    const prompt = options.prompt.trim() || "缺少原始生成要求：仅描述结果中可见内容；无法核实是否达标或保留项是否满足，不得将其判为已通过。";
    if (prompt.length > 20_000) throw new Error("检查要求超过20000字符；没有提交检查或生成。");
    const spec = options.spec === undefined ? undefined : parseImageAgentEditSpec(options.spec);
    const content: Exclude<AiTextMessage["content"], string> = [];
    for (const reference of references) {
        const preview = await inspectionPreview(reference, options);
        content.push({ type: "text", text: `${reference.id === options.result.id ? "本轮实际结果" : "本轮实际修改底图"}（image_id=${reference.id}）` }, { type: "image_url", image_url: { url: preview } });
    }
    const currentUserText = "只读检查本轮结果，对照实际底图、原要求和规格逐项报告可见证据。没有提供的参考、无法看清的细节标为无法确认；这是视觉辅助检查，不是像素或生产验收认证。不生成、不修改，不自动纠错。";
    const profileContext = {
        stage: "review", currentUserText, focusImageId: options.result.id, newCreation: !options.base, workNote: "",
        imageCatalog: references.map((image, index) => ({ id: image.id, label: `图${index + 1}`, name: image.name.slice(0, 120), kind: image.id === options.result.id ? "result" : "upload", previewed: true })),
        previewImageIds: references.map(image => image.id),
        reviewContext: { ...(options.base ? { baseImageId: options.base.id } : {}), resultImageId: options.result.id, prompt, ...(spec ? { spec } : {}) },
    };
    checkCurrent(options);
    const result = await requestToolResponse(config, [{ role: "user", content }, { role: "user", content: currentUserText }], [], "auto", undefined, {
        tool: options.profile === "canvas-assistant" ? "canvas-chat" : "gpt-chat",
        chatProfile: options.profile, profileContext, signal: options.signal,
        onChatSubmissionStarted: () => checkCurrent(options),
    });
    checkCurrent(options);
    if (["max_tokens", "length", "incomplete", "error", "content_filter"].includes(result.stopReason || "")) throw new Error("检查报告未完整返回；原生成结果已保留，没有重新出图。");
    if (result.toolCalls.length !== 1 || result.toolCalls[0]?.function.name !== "report_image_review") throw new Error("检查未返回单一有效报告；原生成结果已保留，没有重新出图。");
    let value: unknown;
    try { value = parseStrictJson(result.toolCalls[0].function.arguments); } catch { throw new Error("检查报告格式无效；原生成结果已保留，没有重新出图。"); }
    return parseImageAgentReview(value);
}
