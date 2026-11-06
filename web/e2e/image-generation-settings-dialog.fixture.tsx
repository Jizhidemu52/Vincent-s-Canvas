import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, Button, ConfigProvider } from "antd";
import "antd/dist/reset.css";
import "../src/styles/globals.css";
import { ImageGenerationSettingsDialog } from "../src/components/image-generation-settings-dialog";
import { getAntThemeConfig } from "../src/lib/app-theme";
import { defaultConfig } from "../src/stores/use-config-store";
import { useBusinessConfigStore } from "../src/stores/use-business-config-store";
import { useThemeStore } from "../src/stores/use-theme-store";
import type { PublicModel } from "../src/services/api/business-config";

const models: PublicModel[] = [
    { id: "7bf4a4e1-7202-49dd-bf16-363d01971346", modelId: "7bf4a4e1-7202-49dd-bf16-363d01971346", name: "aplmart-gpt2.6-flare", publicName: "aplmart-gpt2.6-flare", publicDescription: "速度优先，适合快速迭代", imageParameterProfile: "quality-resolution-v2", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    { id: "7bf4a4e1-7202-49dd-bf16-363d01971347", modelId: "7bf4a4e1-7202-49dd-bf16-363d01971347", name: "aplmart-gpt2.6-sunburst", publicName: "aplmart-gpt2.6-sunburst", publicDescription: "细节优先，适合复杂版式与产品呈现", imageParameterProfile: "quality-resolution-v2", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    { id: "7bf4a4e1-7202-49dd-bf16-363d01971348", modelId: "7bf4a4e1-7202-49dd-bf16-363d01971348", name: "aplmart-nano2.1", publicName: "aplmart-nano2.1", publicDescription: "参考图改款，适合多轮调整", imageParameterProfile: "resolution", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    { id: "7bf4a4e1-7202-49dd-bf16-363d01971349", modelId: "7bf4a4e1-7202-49dd-bf16-363d01971349", name: "团队专用模型", publicName: "团队专用 · 服装与软配饰长名称示例模型", publicDescription: "根据既有产品结构和细节进行调整，保留参考图中的面料、工艺与版型关系。", imageParameterProfile: "quality-resolution-v2", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
];
const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
useThemeStore.setState({ theme: dark ? "dark" : "light" });
useBusinessConfigStore.setState({ status: "ready", models, prices: [], tools: [{ toolKey: "image-generation", modelConfigId: params.has("bound") ? models[0]!.id : null, enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 }] });

function Fixture() {
    const [open, setOpen] = useState(false);
    const [config, setConfig] = useState({ ...defaultConfig, model: models[0]!.id, imageModel: models[0]!.id, size: "1:1", quality: "auto", count: "1", imageOptions: "{}" });
    return <main style={{ minHeight: "100vh", padding: "clamp(24px, 5vw, 64px)", background: "var(--background)", color: "var(--foreground)" }}>
        <div style={{ maxWidth: 1120, margin: "0 auto" }}>
            <p style={{ color: "var(--muted-foreground)", fontSize: 12, marginBottom: 12 }}>TruCreate / 图像</p>
            <h1 style={{ fontSize: 26, fontWeight: 600, marginBottom: 12 }}>图像创作</h1>
            <p style={{ color: "var(--muted-foreground)", marginBottom: 28 }}>模型和参数仅影响下次生成，已有图片保持不变。</p>
            <Button onClick={() => setOpen(true)}>切换生成图片模型</Button>
            <output data-testid="settings-state" hidden>{JSON.stringify(config)}</output>
            <ImageGenerationSettingsDialog open={open} onClose={() => setOpen(false)} config={config} model={config.imageModel} toolKey="image-generation" referenceCount={0} uploadContextKey="dialog-fixture"
                updateConfig={(key, value) => setConfig(current => current[key] === value ? current : { ...current, [key]: value })} openConfigDialog={() => {}} />
        </div>
    </main>;
}
createRoot(document.getElementById("root")!).render(<ConfigProvider theme={getAntThemeConfig(dark)}><App><Fixture /></App></ConfigProvider>);
