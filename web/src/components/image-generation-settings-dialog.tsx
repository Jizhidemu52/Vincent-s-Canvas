import { useRef, type KeyboardEvent } from "react";
import { Button, Modal } from "antd";
import { Check, Image, X } from "lucide-react";
import { ModelPicker } from "@/components/model-picker";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { canvasImageModelDetails } from "@/lib/canvas/canvas-model-picker-options";
import { canvasThemes } from "@/lib/canvas-theme";
import { adaptImageModelSettings, imageModelProfile, useImageModelProfile } from "@/lib/image-model-settings";
import { referencePolicyForModel } from "@/lib/image-reference-policy";
import { uiText, useUiLocale } from "@/lib/i18n";
import type { AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ToolKey } from "../../../shared/feature-catalog";
import "./image-generation-settings-dialog.css";

type ImageGenerationSettingsDialogProps = {
    open: boolean;
    onClose: () => void;
    config: AiConfig;
    model: string;
    toolKey: ToolKey;
    referenceCount: number;
    uploadContextKey: string;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
};

/** Presentation only: the caller owns the persisted draft and model configuration. */
export function ImageGenerationSettingsDialog({ open, onClose, config, model, toolKey, referenceCount, uploadContextKey, updateConfig, openConfigDialog }: ImageGenerationSettingsDialogProps) {
    useUiLocale();
    const contentRef = useRef<HTMLDivElement>(null);
    const colors = canvasThemes[useThemeStore(state => state.theme)];
    const profile = useImageModelProfile(model);
    const capabilities = canvasImageModelDetails(profile, referencePolicyForModel(model, profile), uiText);
    const selectModel = (value: string) => {
        const next = adaptImageModelSettings(config, imageModelProfile(value));
        updateConfig("imageModel", value);
        for (const key of ["size", "quality", "count", "imageOptions"] as const) updateConfig(key, next[key]);
    };

    return <Modal open={open} onCancel={onClose} width={820} centered destroyOnHidden keyboard transitionName="" maskTransitionName=""
        mask={{ closable: true }} focusable={{ trap: true, focusTriggerAfterClose: true }}
        wrapProps={{ onKeyDownCapture: (event: KeyboardEvent<HTMLDivElement>) => {
            if (event.key !== "Tab") return;
            const first = event.currentTarget.querySelector<HTMLButtonElement>(".igsd-close");
            const last = event.currentTarget.querySelector<HTMLButtonElement>("[data-igsd-complete]");
            const next = event.shiftKey && event.target === first ? last : !event.shiftKey && event.target === last ? first : null;
            // The installed AntD trap cannot observe focus moving to browser chrome.
            if (next) { event.preventDefault(); next.focus(); }
        } }}
        rootClassName="image-generation-settings-root" className="image-generation-settings-dialog"
        classNames={{ wrapper: "igsd-wrapper", container: "igsd-container", header: "igsd-header", body: "igsd-body", footer: "igsd-footer", close: "igsd-close" }}
        closable={{ "aria-label": uiText("关闭模型设置") }} closeIcon={<X size={18} aria-hidden />}
        title={<div className="igsd-heading"><h2>{uiText("切换生成图片模型")}</h2><p>{uiText("选择适合的模型，调整下一次生成的参数。")}</p></div>}
        afterOpenChange={visible => { if (visible) contentRef.current?.querySelector<HTMLButtonElement>('[data-usage-control="model"][role="combobox"]:not([disabled])')?.focus({ preventScroll: true }); }}
        footer={<div className="igsd-footer-content"><span><Check size={14} aria-hidden />{uiText("设置自动应用，关闭后保留")}</span><Button data-igsd-complete type="primary" onClick={onClose}>{uiText("完成")}</Button></div>}>
        <div ref={contentRef} className="igsd-content">
            <section className="igsd-model-section" aria-label={uiText("生成模型")}>
                <h3><Image size={15} aria-hidden />{uiText("生成模型")}</h3>
                <ModelPicker toolKey={toolKey} config={config} value={model} onChange={selectModel} capability="image" modelsSource="server" fullWidth variant="settings" onMissingConfig={() => openConfigDialog(false)} />
                {capabilities.length ? <div className="igsd-model-capabilities" aria-label={uiText("模型支持")}>
                    {capabilities.map(detail => <span key={detail}>{uiText(detail)}</span>)}
                </div> : null}
            </section>
            <ImageSettingsPanel config={{ ...config, model, imageModel: model }} referenceCount={referenceCount} uploadContextKey={uploadContextKey}
                onConfigChange={(key, value) => updateConfig(key, value)} profile={profile} theme={colors} showTitle={false} dialog />
        </div>
    </Modal>;
}
