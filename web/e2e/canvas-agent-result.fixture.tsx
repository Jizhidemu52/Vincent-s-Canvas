import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider } from "antd";
import { AgentChatMessage, type CanvasAgentChatImageControl } from "../src/components/canvas/canvas-agent-chat-ui";
import { CanvasNode } from "../src/components/canvas/canvas-node";
import { canvasThemes } from "../src/lib/canvas-theme";
import { getCanvasAntThemeConfig } from "../src/lib/app-theme";
import { useThemeStore } from "../src/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import "../src/styles/globals.css";

const noop = () => {};
const attachment = { id: "attachment", name: "针织产品原始名称.png", url: "/result.png", width: 320, height: 240 };
const image = { id: "image-v3", label: "图2", name: attachment.name, dataUrl: attachment.url };
const controls = new Map<string, CanvasAgentChatImageControl>([["message:attachment", { image, version: 3 }]]);
const item = { id: "message", role: "assistant" as const, text: "已保留结构并调整配色。", attachments: [attachment] };
const node: CanvasNodeData = { id: "version-node", type: CanvasNodeType.Image, title: "图2", width: 320, height: 240, position: { x: 0, y: 0 }, metadata: { content: attachment.url, status: "success", imageAgent: { workId: "work", version: 3, note: { summary: "调整配色", keep: ["结构不变"] } } } };

function Fixture() {
    const themeName = useThemeStore(state => state.theme), theme = canvasThemes[themeName];
    const [active, setActive] = useState<string | undefined>(image.id), [action, setAction] = useState("none"), [busy, setBusy] = useState(false), [narrow, setNarrow] = useState(false);
    useEffect(() => { document.documentElement.classList.toggle("dark", themeName === "dark"); }, [themeName]);
    return <ConfigProvider theme={getCanvasAntThemeConfig(themeName)}><main style={{ padding: 24, minHeight: "100vh", color: theme.node.text, background: theme.canvas.background }}>
        <nav className="mb-6 flex flex-wrap gap-4 text-sm">
            <button onClick={() => useThemeStore.getState().setTheme(themeName === "light" ? "dark" : "light")}>theme</button>
            <button onClick={() => setActive(undefined)}>clear selection</button>
            <button onClick={() => setBusy(value => !value)}>busy</button>
            <button onClick={() => setNarrow(value => !value)}>narrow</button>
        </nav>
        <section data-testid="result-panel" style={{ width: narrow ? 240 : 380, maxWidth: "100%" }}>
            <AgentChatMessage item={item} theme={theme} user={null} imageControls={controls} activeImageId={active} imageActionsDisabled={busy} conversationOnlyImages
                onImageAction={(name, id) => { setAction(`${name}:${id}`); if (name === "edit") setActive(id); }}
                onMaskImage={id => setAction(`mask:${id}`)} onUseImageForVideo={value => setAction(`video:${value.id}`)} />
        </section>
        <output data-testid="last-action">{action}</output>
        <div className="relative mt-8" style={{ width: 320, height: 240 }}>
            <CanvasNode data={node} theme={theme} themeKey={themeName} renderQuality="full" getCanvasScale={() => 1}
                isSelected={false} isRelated={false} isFocusRelated={false} isConnectionTarget={false} isConnecting={false} isRunning={false} showPanel={false} showImageInfo={false}
                onMouseDown={noop} onHoverStart={noop} onHoverEnd={noop} onConnectStart={noop} onResize={noop} onResizeEnd={noop} onContentChange={noop} onContextMenu={noop} />
        </div>
    </main></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
