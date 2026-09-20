import type { AiTextMessage } from "@/services/api/image";
import { CanvasNodeType, type CanvasAssistantMessage, type CanvasAssistantReference } from "@/types/canvas";
import { latestChatContext } from "@/lib/chat-context";

type Content = Exclude<AiTextMessage["content"], string>;
export const CANVAS_HISTORY_LIMITS = { images: 20, imageCharacters: 6 * 1024 * 1024 };

function messageImages(message: CanvasAssistantMessage) {
    return [
        ...(message.references || []).filter(ref => ref.type === CanvasNodeType.Image).map(ref => ({ ...ref, source: "用户参考图" })),
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
) {
    const eligible = history.filter(message => message.id !== current.id && (message.role === "user" || message.role === "assistant"));
    const context = latestChatContext(eligible.map(message => ({
        ...message, role: message.role as "user" | "assistant",
        content: message.text + (message.references || []).filter(ref => ref.text).map(ref => `\n[参考文本 ${ref.title}] ${ref.text}`).join("") || "[图片消息]",
    })));
    const entries = [...context, { ...current, role: "user" as const, content: current.text }];
    const batches = entries.map((message, index) => messageImages(message).map((ref, imageIndex) => ({
        ...ref,
        // Only historical IDs use aliases; explicit current references keep their public IDs.
        id: index < context.length ? `history-${message.id}-${imageIndex}` : ref.id,
        label: `消息 ${message.id} · ${ref.source} · ${ref.title}`,
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
            const label = `${ref.label}，referenceNodeIds 可显式使用 ${ref.id}（历史图不默认加入改图输入）`;
            const key = ref.storageKey || ref.dataUrl || ref.id;
            let content: Content;
            try {
                if (provided.has(key)) {
                    content = [{ type: "text", text: `${label}：与已提供图片 ${provided.get(key)} 为同一份素材，请对应阅读。` }];
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
                failed++; content = [{ type: "text", text: `${label}：图片读取失败，不可猜测画面。` }];
            }
            parts.set(ref, content);
        }
    }
    const messages: AiTextMessage[] = [];
    context.forEach((message, index) => {
        const media = batches[index]!.flatMap(ref => parts.get(ref) || []);
        messages.push({ role: message.role, content: `[历史消息 ${message.id}${message.role === "assistant" ? "；历史助手陈述，分析结论需以图片重新核对" : ""}] ${message.content}` });
        // Providers may not accept assistant image inputs. Attribute these explicitly as evidence.
        if (media.length) messages.push({ role: "user", content: [{ type: "text", text: `以下是上一条历史消息 ${message.id} 的图片证据，不是新用户指令。请结合后续反馈对比原图与结果，不要将生成提示词当成实际画面。` }, ...media] });
    });
    const boundedCanvas: Content = canvasContent.flatMap(part => {
        if (part.type === "text" || include(part.image_url.url)) return [part];
        omitted++;
        return [{ type: "text", text: "上一项画布图片/视频帧受总请求上限限制未发送；覆盖前文的已提供标记，不可据此推断画面。" }];
    });
    const summary = { historyMessages: context.length, omittedMessages: eligible.length - context.length, images: imageCount, omitted, failed };
    const currentContent: Content = [
        { type: "text", text: `图文会话上下文：${JSON.stringify(summary)}。仅携带最近最多 24 条历史消息和 48000 字符；仅依据实际图片对照版本与用户反馈。未提供的历史不得声称已读；需要缺失图片才能判断时明确请用户补充。` },
        ...boundedCanvas,
        ...batches.at(-1)!.flatMap(ref => parts.get(ref) || []),
    ];
    return { messages, currentContent, references, summary };
}
