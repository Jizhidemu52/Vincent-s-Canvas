import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { AgentChatComposer, AgentChatMessage } from "../src/components/canvas/canvas-agent-chat-ui";
import { useChatBottomFollow } from "../src/hooks/use-chat-bottom-follow";
import { canvasThemes } from "../src/lib/canvas-theme";
import "../src/styles/globals.css";

function Fixture() {
    const [messages, setMessages] = useState(Array.from({ length: 16 }, (_, index) => ({ id: String(index), role: "assistant" as const, text: `历史消息 ${index}\n\n保留衣服版型、材质与原有光影，只调整明确指定的部位。` })));
    const [prompt, setPrompt] = useState("");
    const [height, setHeight] = useState(60);
    const follow = useChatBottomFollow(messages, "fixture");
    return <ConfigProvider><App><main className="mx-auto flex h-dvh w-full max-w-md flex-col bg-background text-foreground">
        <nav className="flex shrink-0 gap-2 p-2 text-xs">
            <button onClick={() => setMessages(items => [...items, { id: String(items.length), role: "assistant", text: "新增内容\n\n".repeat(15) }])}>stream chunk</button>
            <button onClick={() => setHeight(value => value + 300)}>grow media</button>
        </nav>
        <div ref={follow.listRef} onScroll={follow.onScroll} data-testid="fixture-list" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 [overflow-anchor:none]">
            <div ref={follow.contentRef} className="space-y-6">
                {messages.map(item => <AgentChatMessage key={item.id} item={item} user={null} theme={canvasThemes.light} />)}
                <div data-testid="late-media" style={{ height, background: canvasThemes.light.node.fill }}>Late image layout</div>
            </div>
        </div>
        {follow.hasNewMessages ? <button onClick={follow.scrollToBottom}>新消息</button> : null}
        <AgentChatComposer prompt={prompt} onPromptChange={setPrompt} onSubmit={() => undefined} placeholder="对话输入" theme={canvasThemes.light} />
    </main></App></ConfigProvider>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
