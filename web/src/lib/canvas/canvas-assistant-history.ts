import type { AiTextMessage } from "@/services/api/image";
import { CanvasNodeType, type CanvasAssistantMessage, type CanvasAssistantReference } from "@/types/canvas";
import { latestChatContext } from "@/lib/chat-context";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";

type Content = Exclude<AiTextMessage["content"], string>;
export const CANVAS_HISTORY_LIMITS = { images: 20, imageCharacters: 6 * 1024 * 1024 };

function messageImages(message: CanvasAssistantMessage, isCurrent: boolean) {
    return [
        ...(message.references || []).filter(ref => ref.type === CanvasNodeType.Image).map((ref, index) => ({ ...ref, source: `${isCurrent ? "本轮" : ""}${imageReferenceLabel(index)} · 用户参考图` })),
        ...(message.contextReferences || []).map(ref => ({ ...ref, source: "当轮画布图片快照" })),
        ...(message.attachments || []).filter(item => item.mediaType === "image").map(item => ({ id: item.id, type: CanvasNodeType.Image, title: item.name, dataUrl: item.url, storageKey: item.storageKey, source: "助手生成结果" })),
    ];
}

/** Images are frozen message assets, never looked up through a mutable canvas node ID. */
export async function buildCanvasConversationHistory(
    history: CanvasAssistantMessage[],
    current: CanvasAssistantMessage,
    readImage: (ref: CanvasAssistantReference) => Promise<string>,
    canvasContent: Content = [],
    referenceLabels?: ReadonlyMap<string, string>,
) {
    const eligible = history.filter(message => message.id !== current.id && (message.role === "user" || message.role === "assistant"));
    const context = latestChatContext(eligible.map(message => ({
        ...message, role: message.role as "user" | "assistant",
        content: message.text + (message.references || []).filter(ref => ref.text).map(ref => `\n[参考文本 ${ref.title}] ${ref.text}`).join("") || "[图片消息]",
    })));
    const entries = [...context, { ...current, role: "user" as const, content: current.text }];
    const batches = entries.map((message, index) => messageImages(message, index === context.length).map((ref, imageIndex) => ({
        ...ref,
        // Only historical IDs use aliases; explicit current references keep their public IDs.
        id: index < context.length ? `history-${message.id}-${imageIndex}` : ref.id,
        label: `消息 ${message.id} · ${referenceLabels?.get(`${message.id}:${ref.id}`) || ref.source} · ${ref.title}`,
    })));
    const parts = new Map<object, Content>();
    const provided = new Map<string, string>();
    const references: CanvasAssistantReference[] = [];
    let imageCount = 0, characters = 0, omitted = 0, failed = 0;
    const include = (url: string) => {
        if (imageCount >= CANVAS_HISTORY_LIMITS.images || characters + url.length > CANVAS_HISTORY_LIMITS.imageCharacters) return false;
        imageCount++; characters += url.length; return true;
    };
    // Current explicit images first, then newest history (results and their original inputs).
    for (let index = batches.length - 1; index >= 0; index--) {
        for (const ref of batches[index]!) {
            const label = `${ref.label}，referenceNodeIds 可显式使用 ${ref.id}`;
            const key = ref.storageKey || ref.dataUrl || ref.id;
            let content: Content;
            try {
                if (provided.has(key)) {
                    content = [{ type: "text", text: `${label}：与已提供图片 ${provided.get(key)} 为同一份素材。` }];
                    if (index < context.length) references.push({ id: ref.id, type: ref.type, title: ref.title, dataUrl: ref.dataUrl, storageKey: ref.storageKey });
                } else if (imageCount >= CANVAS_HISTORY_LIMITS.images) {
                    omitted++; content = [{ type: "text", text: `${label}：受请求上限限制，未提供图片。` }];
                } else {
                    const url = await readImage(ref);
                    if (!url.startsWith("data:image/")) throw new Error("图片读取失败");
                    if (include(url)) {
                        provided.set(key, ref.id);
                        content = [{ type: "text", text: label }, { type: "image_url", image_url: { url } }];
                        if (index < context.length) references.push({ id: ref.id, type: ref.type, title: ref.title, dataUrl: ref.dataUrl, storageKey: ref.storageKey });
                    } else {
                        omitted++; content = [{ type: "text", text: `${label}：受请求大小限制，未提供图片。` }];
                    }
                }
            } catch {
                failed++; content = [{ type: "text", text: `${label}：图片读取失败。` }];
            }
            parts.set(ref, content);
        }
    }
    const messages: AiTextMessage[] = [];
    context.forEach((message, index) => {
        const media = batches[index]!.flatMap(ref => parts.get(ref) || []);
        messages.push({ role: message.role, content: `[历史消息 ${message.id}；role=${message.role}] ${message.content}` });
        // Providers may not accept assistant image inputs. Attribute these explicitly as evidence.
        if (media.length) messages.push({ role: "user", content: [{ type: "text", text: `历史消息 ${message.id} 的图片证据：` }, ...media] });
    });
    const boundedCanvas: Content = canvasContent.flatMap(part => {
        if (part.type === "text" || include(part.image_url.url)) return [part];
        omitted++;
        return [{ type: "text", text: "上一项画布图片/视频帧受总请求上限限制未发送（最终发送状态）。" }];
    });
    const summary = { historyMessages: context.length, omittedMessages: eligible.length - context.length, images: imageCount, omitted, failed };
    const currentContent: Content = [
        { type: "text", text: `图文会话上下文：${JSON.stringify(summary)}` },
        ...boundedCanvas,
        ...batches.at(-1)!.flatMap(ref => parts.get(ref) || []),
    ];
    return { messages, currentContent, references, summary };
}
