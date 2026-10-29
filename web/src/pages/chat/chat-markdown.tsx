import { uiText, useUiText } from "@/lib/i18n";
import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Render Markdown as React nodes; raw HTML is never executed. */
export const ChatMarkdown = memo(function ChatMarkdown({ children }: { children: string }) {
    useUiText();
    return <div className="chat-markdown min-w-0 [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-2 [&_h1]:my-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:my-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:my-2 [&_h3]:font-semibold [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li>p]:my-0 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-current [&_blockquote]:pl-3 [&_blockquote]:opacity-80 [&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.9em] [&_code]:text-foreground [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_hr]:my-4 [&_hr]:border-border">
        <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
            a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2" />,
            // Model-written image URLs are not attachments. Show a deliberate link
            // instead of silently requesting external images while rendering text.
            img: ({ src, alt }) => <a href={src} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{alt || uiText("图片链接")}</a>,
            table: ({ node: _node, ...props }) => <div className="my-3 max-w-full overflow-x-auto"><table {...props} className="w-full border-collapse text-left [&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-1.5 [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5" /></div>,
        }}>{children}</Markdown>
    </div>;
});
