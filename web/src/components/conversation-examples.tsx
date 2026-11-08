import { useUiLocale } from "@/lib/i18n";

const examples = [
    ["采用方案", "采用 B 方案，按刚才确认的要求生成。", "Use a proposal", "Use proposal B and generate it with the requirements we just agreed on."],
    ["回上一版", "回上一版，保留配色，只把袖口改窄。", "Previous version", "Go back to the previous version, keep the colors, and make only the cuffs narrower."],
    ["回原图", "回原图，只调整背景，主体保持不变。", "Original image", "Return to the original image and change only the background, keeping the subject unchanged."],
    ["指定图号", "以图 3 为基础，把背景改成浅灰色。", "Choose an image", "Use image 3 from this conversation and change its background to light gray."],
    ["先讨论不出图", "先讨论不出图：给我 A、B 两个方向，说说各自的区别。", "Discuss first", "Do not generate yet. Suggest directions A and B and explain how they differ."],
] as const;

/** Reference copy only: opening the help never changes or submits a draft. */
export function ConversationExamples({ className = "" }: { className?: string }) {
    const english = useUiLocale() === "en-US";
    return <details className={`min-w-0 max-w-full text-xs leading-5 ${className}`} data-testid="conversation-examples">
        <summary className="w-fit max-w-full cursor-pointer rounded-sm py-1 focus-visible:outline-2 focus-visible:outline-offset-2">{english ? "Conversation examples" : "对话示例"}</summary>
        <div className="mt-1 max-h-40 overflow-y-auto overscroll-contain break-words pr-2 pb-1" data-testid="conversation-examples-content">
            <p className="mb-2 opacity-80">{english ? "Use proposal names and image numbers from the current conversation. Original and previous versions must already exist. Viewing examples does not send a message or change your draft." : "方案和图号以当前对话为准；回原图、上一版需已有对应图片。查看示例不会发送或改动草稿。"}</p>
            <dl className="space-y-2">
                {examples.map(([label, message, labelEn, messageEn]) => <div key={label}>
                    <dt className="font-medium">{english ? labelEn : label}</dt>
                    <dd className="m-0 opacity-80">{english ? messageEn : message}</dd>
                </div>)}
            </dl>
        </div>
    </details>;
}
