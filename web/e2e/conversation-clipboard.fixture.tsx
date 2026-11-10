import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { AgentChatComposer, AgentChatMessage, type CanvasAgentChatAttachment, type CanvasAgentChatImageControl } from "../src/components/canvas/canvas-agent-chat-ui";
import { useConversationImageTools } from "../src/hooks/use-conversation-image-tools";
import { canvasThemes } from "../src/lib/canvas-theme";
import { useUserStore } from "../src/stores/use-user-store";
import "../src/styles/globals.css";

const images = ["A", "B"].map(id => ({ id, label: `图${id === "A" ? 1 : 2}`, name: `synthetic-original-${id}.png`, dataUrl: `/clipboard-${id}.png` }));
const controls = new Map<string, CanvasAgentChatImageControl>(images.map(image => [`result:${image.id}`, { image }]));
const result = { id: "result", role: "assistant" as const, text: "隔离浏览器验收：两张合成原图", attachments: images.map(image => ({ id: image.id, name: image.name, url: image.dataUrl })) };

/** Real Canvas result/action/composer components; accepted files are observed here,
 * not persisted through the full Canvas shell. No clipboard APIs are replaced. */
function Fixture() {
    const imageTools = useConversationImageTools();
    const status = useUserStore(state => state.status);
    const [prompt, setPrompt] = useState("");
    const [attachments, setAttachments] = useState<CanvasAgentChatAttachment[]>([]);
    const [submits, setSubmits] = useState(0);
    useEffect(() => { void useUserStore.getState().hydrateSession(); }, []);
    if (status !== "authenticated") return <p>正在载入隔离账号</p>;
    return <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 bg-background p-6 text-foreground">
        <AgentChatMessage item={result} theme={canvasThemes.light} user={null} imageControls={controls} conversationOnlyImages
            onImageAction={(action, id) => { const image = images.find(item => item.id === id); if (action === "copy" && image) void imageTools.copy(image); }} />
        <section data-testid="accepted-composer">
            <AgentChatComposer prompt={prompt} onPromptChange={setPrompt} onSubmit={() => setSubmits(count => count + 1)} placeholder="画布对话输入" theme={canvasThemes.light}
                attachments={attachments} onAddFiles={files => setAttachments(current => [...current, ...Array.from(files || []).map((file, index) => ({ id: `accepted-${current.length + index}`, name: file.name, url: URL.createObjectURL(file) }))])} />
        </section>
        <output data-testid="accepted-count">{attachments.length}</output><output data-testid="submit-count">{submits}</output>
    </main>;
}

createRoot(document.getElementById("root")!).render(<ConfigProvider><App><Fixture /></App></ConfigProvider>);
