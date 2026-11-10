import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { App, Button, ConfigProvider, Input, theme } from "antd";
import { PromptOptimizeButton } from "../src/components/prompt-optimize-button";
import { PromptExecutionPreviewHost } from "../src/components/prompt-execution-preview";
import { ReferenceImageTray } from "../src/components/reference-images/reference-image-tray";
import { buildDirectImagePrompt, imageReferenceRoles } from "../src/lib/image-reference-prompt";
import { defaultConfig, useConfigStore } from "../src/stores/use-config-store";
import { useUserStore } from "../src/stores/use-user-store";
import { confirmImageTaskPreview, promptPreviewReferences } from "../src/services/api/prompt-task-preview";
import type { PromptInputData } from "../../shared/prompt-contracts";
import type { ImageReferenceItem } from "../src/types/image";
import "../src/styles/globals.css";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const config = { ...defaultConfig, model: "preview-model", imageModel: "preview-model", imageOptions: "{}", systemPrompt: "" };
useUserStore.setState({ user: { id: "preview-employee", role: "designer", status: "active" } as never, status: "authenticated" });
useConfigStore.setState({ config: { ...config, promptPreview: true } });
function Fixture() {
    const [prompt, setPrompt] = useState('只改成蓝色，保留 6 颗纽扣和文字 "春日 快乐"。');
    const [dark, setDark] = useState(false);
    const [fixedStatus, setFixedStatus] = useState("尚未开始固定场景");
    const fixedSequence = useRef(0);
    const location = useLocation();
    const navigate = useNavigate();
    const switchOwner = () => useUserStore.setState({ user: { id: "preview-other-employee", role: "designer", status: "active" } as never, status: "authenticated" });
    useEffect(() => {
        const handleExternalChange = (event: KeyboardEvent) => {
            if (!event.altKey) return;
            if (event.key.toLowerCase() === "a") { event.preventDefault(); switchOwner(); }
            if (event.key.toLowerCase() === "r") { event.preventDefault(); navigate("/changed-route"); }
        };
        window.addEventListener("keydown", handleExternalChange);
        return () => window.removeEventListener("keydown", handleExternalChange);
    }, [navigate]);
    useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
    const [references, setReferences] = useState<ImageReferenceItem[]>(["原图.png", "参考色.png"].map((name, index) => ({ id: `ref-${index}`, name, type: "image/png", dataUrl: png, referenceKey: `ref-${index}`, origin: "upload", originLabel: "上传", role: index ? "只参考此图的颜色。" : "以此图作为编辑原图。" })));
    const startFixedScene = async () => {
        setFixedStatus("正在准备固定场景");
        const promptInput: PromptInputData = { scene: "local-restyle", userText: prompt, fields: {}, mode: "edit", referenceRoles: imageReferenceRoles(references) };
        const sourceUrls = references.map(reference => `/api/assets/${reference.id}/content`).concat("/api/assets/preview-markup/content");
        const task = { requestId: `fixed-preview-${++fixedSequence.current}`, modelConfigId: "preview-model", operationType: "inpaint", toolKey: "image-edit", prompt, promptInput,
            parameters: { count: 1, markup_image_index: 2, negative_prompt: "额外纽扣、改变原有文字" }, sourceUrls };
        try {
            const confirmed = await confirmImageTaskPreview(task, { modelName: "固定场景测试模型", references: promptPreviewReferences(sourceUrls, promptInput, [...references.map(reference => reference.name), "圈选区域.png"], undefined, 2) });
            // Represents the caller's submission boundary; the real confirmation helper is never mocked.
            await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(confirmed) });
            setFixedStatus("已提交图片任务");
        } catch (error) { setFixedStatus(error instanceof Error ? error.message : "固定场景未提交"); }
    };
    return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}><App><main className={dark ? "dark" : ""}><div className="min-h-screen bg-background p-6 text-foreground">
        <div className="mx-auto max-w-3xl space-y-4" data-testid="panel">
            <Button onClick={() => setDark(value => !value)}>theme</Button>
            <Input.TextArea aria-label="原始提示词" value={prompt} onChange={event => setPrompt(event.target.value)} />
            <PromptOptimizeButton config={config} prompt={prompt} references={references} operationType="inpaint" toolKey="image-edit" onApply={setPrompt} />
            <ReferenceImageTray references={references} validation={{ valid: true, minimum: 0, maximum: 16, supportsReferences: true }} onChange={setReferences} onRequestUpload={() => undefined} />
            <pre data-testid="sent" className="whitespace-pre-wrap break-words">{buildDirectImagePrompt(config, prompt, references)}</pre>
            <section className="space-y-2 border-t border-border pt-4">
                <Button onClick={() => void startFixedScene()}>固定场景生成</Button>
                <p data-testid="fixed-status">{fixedStatus}</p>
                <p data-testid="fixture-route">{location.pathname}</p>
                <p className="text-xs text-muted-foreground">Alt+A 模拟其他窗口切换账号；Alt+R 模拟切换路由。</p>
            </section>
        </div>
    </div></main><PromptExecutionPreviewHost /></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<MemoryRouter initialEntries={["/preview"]}><Fixture /></MemoryRouter>);
